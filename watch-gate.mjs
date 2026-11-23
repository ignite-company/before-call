import { sanitizeProgress } from "./watch-persistence.mjs";

const EDGE = 0.30;
const MAX_SAMPLE_SECONDS = 3;
const JOIN = .002;
const TRACKING_GAP = .30;
const END_TOLERANCE = .14;

export function createWatchGate() {
  let started = false, claimed = false, duration = NaN, ranges = [], previous;
  let skips = [];

  function add(start, end) {
    if (end <= start) return;
    const next = [];
    for (const [a, b] of ranges) {
      if (b < start - JOIN) next.push([a, b]);
      else if (a > end + JOIN) { next.push([start, end]); start = a; end = b; }
      else { start = Math.min(a, start); end = Math.max(b, end); }
    }
    next.push([start, end]);
    ranges = next;
  }

  function sample({ media, clock, eligible, rate = 1, played }) {
    if (!started || !eligible || !Number.isFinite(media) || !Number.isFinite(clock) ||
        !Number.isFinite(duration) || !Number.isFinite(rate) || rate <= 0) {
      previous = undefined;
      return;
    }
    const p = previous;
    previous = { media, clock, rate };
    if (!p) return;
    const dt = (clock - p.clock) / 1000, dm = media - p.media;
    if (dt <= 0 || dm <= 0 || dm > dt * Math.max(p.rate, rate) + EDGE) return;
    const lo = Math.max(0, Math.min(duration, p.media)), hi = Math.max(0, Math.min(duration, media));
    if (dt <= MAX_SAMPLE_SECONDS) { add(lo, hi); return; }
    // During a foreground render stall the native media clock may still run.
    // Only corroborate inside this just-observed foreground interval; never use
    // native ranges from the teaser, a hidden tab, or before a seek/reset.
    if (dt <= 20 && played) {
      try {
        for (let i = 0; i < played.length; i++) {
          add(Math.max(lo, played.start(i)), Math.min(hi, played.end(i)));
        }
      } catch { /* media ranges can change during navigation */ }
    }
  }

  function firstMissing() {
    if (!started || !Number.isFinite(duration)) return null;
    // A small, total tolerance covers older captures and sub-frame boundary
    // rounding. It does not apply to a known forward seek, or aggregate into
    // substantial unwatched time across repeated pause/buffer samples.
    const edge = Math.min(END_TOLERANCE, duration * .04);
    let budget = Math.min(1.5, duration * .025), end = 0;
    const missing = (start, stop, tolerance) => {
      const gap = stop - start;
      if (gap <= JOIN) return null;
      const knownSkip = skips.some(([a, b]) => Math.min(stop, b) - Math.max(start, a) > JOIN);
      if (knownSkip || gap > tolerance || gap > budget) return { start, end: stop };
      budget -= gap;
      return null;
    };
    for (const [a, b] of ranges) {
      const gap = missing(end, a, end === 0 ? edge : TRACKING_GAP);
      if (gap) return gap;
      end = b;
    }
    return missing(end, duration, edge);
  }

  function isComplete() {
    return started && ranges.length > 0 && firstMissing() === null;
  }

  return {
    setDuration(value) { if (Number.isFinite(value) && value > 0) duration = value; },
    start() { started = true; previous = undefined; },
    breakInterval() { previous = undefined; },
    markSkip(start, end) {
      previous = undefined;
      if (!started || !Number.isFinite(start) || !Number.isFinite(end) ||
          end <= start + JOIN || !Number.isFinite(duration)) return;
      const lo = Math.max(0, Math.min(duration, start)), hi = Math.max(0, Math.min(duration, end));
      if (hi <= lo + JOIN) return;
      skips.push([lo, hi]);
      skips.sort((a, b) => a[0] - b[0]);
      const compact = [];
      for (const range of skips) {
        const prev = compact.at(-1);
        if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
        else compact.push([...range]);
      }
      skips = compact;
    },
    snapshot() {
      return { duration, ranges: ranges.map(range => [...range]), skips: skips.map(range => [...range]) };
    },
    restore(snapshot, now = Date.now()) {
      const saved = sanitizeProgress(snapshot, now);
      if (started || !saved || !Number.isFinite(duration) || Math.abs(saved.duration - duration) > .10) return false;
      const clip = (list) => list.map(([a, b]) => [a, Math.min(b, duration)]).filter(([a, b]) => b > a);
      const clipped = clip(saved.ranges);
      if (!clipped.length) return false;
      started = true;
      previous = undefined;
      ranges = clipped;
      skips = clip(saved.skips);
      return true;
    },
    sample,
    firstMissing,
    percent() {
      if (!Number.isFinite(duration)) return 0;
      if (isComplete()) return 100;
      return Math.min(99, Math.floor(100 * ranges.reduce((sum, [a, b]) => sum + b - a, 0) / duration));
    },
    ready() { return isComplete() && !claimed; },
    claim() {
      if (!isComplete() || claimed) return false;
      claimed = true;
      return true;
    }
  };
}
