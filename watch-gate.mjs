const EDGE = 0.10;
const MAX_SAMPLE_SECONDS = 0.8;

export function createWatchGate() {
  let started = false, claimed = false, duration = NaN, ranges = [], previous;

  function add(start, end) {
    if (end <= start) return;
    const next = [];
    for (const [a, b] of ranges) {
      if (b < start - 0.01) next.push([a, b]);
      else if (a > end + 0.01) { next.push([start, end]); start = a; end = b; }
      else { start = Math.min(a, start); end = Math.max(b, end); }
    }
    next.push([start, end]);
    ranges = next;
  }

  function sample({ media, clock, eligible, rate = 1 }) {
    if (!started || !eligible || !Number.isFinite(media) || !Number.isFinite(clock) || !Number.isFinite(duration) || rate <= 0) {
      previous = undefined;
      return;
    }
    const p = previous;
    previous = { media, clock, rate };
    if (!p || p.rate !== rate) return;
    const dt = (clock - p.clock) / 1000, dm = media - p.media;
    if (dt > 0 && dt <= MAX_SAMPLE_SECONDS && dm > 0 && dm <= dt * rate + EDGE) {
      add(Math.max(0, Math.min(duration, p.media)), Math.max(0, Math.min(duration, media)));
    }
  }

  function isComplete() {
    return started && Number.isFinite(duration) && ranges.length === 1 &&
      ranges[0][0] <= Math.min(EDGE, duration * .04) &&
      ranges[0][1] >= duration - Math.min(0.03, duration * .01);
  }

  return {
    setDuration(value) { if (Number.isFinite(value) && value > 0) duration = value; },
    start() { started = true; previous = undefined; },
    breakInterval() { previous = undefined; },
    sample,
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
