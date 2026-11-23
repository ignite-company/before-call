import { WATCH_SESSION_TTL_MS } from "./playback-policy.mjs";

// Local UX progress only. The server validates every reward session and claim.
const PREFIX = "ignite-before-call.watch.v1:";
const PROGRESS_TTL = 14 * 24 * 60 * 60 * 1000;
const MAX_RANGES = 512;
const MAX_DURATION = 24 * 60 * 60;
const MAX_JSON_LENGTH = 50000;

export function activeSession(token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const match = /^(\d{13})\.\d{4,8}\.[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match || Number(match[1]) > now + 120000 || now - Number(match[1]) >= WATCH_SESSION_TTL_MS) return null;
  return token;
}

export function sanitizeProgress(value, now = Date.now()) {
  if (!value || typeof value !== "object" ||
      !Number.isFinite(value.savedAt) || value.savedAt > now + 120000 || now - value.savedAt >= PROGRESS_TTL ||
      !Number.isFinite(value.duration) || value.duration <= 0 || value.duration >= MAX_DURATION ||
      !Number.isFinite(value.position) || value.position < 0 || value.position > value.duration ||
      !Array.isArray(value.ranges) || value.ranges.length === 0 || value.ranges.length > MAX_RANGES) return null;
  function readRanges(list) {
    if (!Array.isArray(list) || list.length > MAX_RANGES) return null;
    let previousEnd = -1;
    const ranges = [];
    for (const range of list) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [start, end] = range;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
        end <= start || end > value.duration || start <= previousEnd) return null;
      ranges.push([start, end]);
      previousEnd = end;
    }
    return ranges;
  }
  const ranges = readRanges(value.ranges), skips = readRanges(value.skips ?? []);
  if (!ranges || !skips) return null;
  return {
    savedAt: value.savedAt, duration: value.duration, position: value.position, ranges, skips,
    session: activeSession(value.session, now), celebrated: value.celebrated === true
  };
}

export function restorePosition(snapshot) {
  const { position, duration, ranges } = snapshot;
  const rewind = .45;
  // If the previous visit ended after skipping content, resume at the first
  // missing piece rather than opening the player at the final frame again.
  if (position >= duration - 1) {
    let coveredThrough = 0;
    for (const [start, end] of ranges) {
      if (start > coveredThrough + (coveredThrough === 0 ? Math.min(.1, duration * .04) : .01)) break;
      coveredThrough = end;
    }
    if (coveredThrough < duration - .03) return Math.max(0, coveredThrough - rewind);
  }
  return Math.max(0, Math.min(position, duration - .05) - rewind);
}

export function createProgressStorage(source, getStorage = () => globalThis.localStorage, now = Date.now) {
  const key = PREFIX + source;
  function read() {
    try {
      const raw = getStorage()?.getItem(key);
      if (!raw || raw.length > MAX_JSON_LENGTH) return null;
      return sanitizeProgress(JSON.parse(raw), now());
    } catch { return null; }
  }
  function write(snapshot) {
    try {
      const saved = sanitizeProgress({ ...snapshot, savedAt: now() }, now());
      if (!saved) return false;
      const old = read();
      const coverage = (s) => s.ranges.reduce((total, [a, b]) => total + b - a, 0);
      // A stale tab should not overwrite more complete data or a known celebration.
      if (old && Math.abs(old.duration - saved.duration) <= .10) {
        if (coverage(old) > coverage(saved) + .02) return false;
        if (old.celebrated) saved.celebrated = true;
      }
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(key, JSON.stringify(saved));
      return true;
    } catch { return false; }
  }
  return { read, write };
}
