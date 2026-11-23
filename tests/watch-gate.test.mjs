import test from "node:test";
import assert from "node:assert/strict";
import { createWatchGate } from "../watch-gate.mjs";

const make = () => {
  const g = createWatchGate();
  g.setDuration(10);
  let wall = 0;
  const play = (from, to, eligible = true, rate = 1) => {
    for (let step = 0; step <= Math.round((to - from) * 10); step++) {
      g.sample({ media: from + step / 10, clock: wall, eligible, rate });
      wall += 100 / rate;
    }
  };
  return { g, play };
};

test("teaser, an early claim, and seek to end do not unlock", () => {
  const { g, play } = make();
  play(0, 10);
  assert.equal(g.percent(), 0);
  assert.equal(g.claim(), false);
  g.start();
  play(0, 1);
  g.breakInterval();
  play(9, 10);
  assert.equal(g.percent(), 20);
  assert.equal(g.claim(), false);
});

test("normal ending unlocks once, and replay never unlocks a second claim", () => {
  const { g, play } = make();
  g.start();
  play(0, 10);
  assert.equal(g.percent(), 100);
  assert.ok(g.ready());
  assert.ok(g.claim());
  g.breakInterval();
  play(0, 10);
  assert.equal(g.ready(), false);
  assert.equal(g.claim(), false);
});

test("pausing and buffering don't reset prior playback or leave a gap", () => {
  const { g, play } = make();
  g.start();
  play(0, 3);
  g.breakInterval();
  play(3, 3, false);
  play(3, 7);
  g.breakInterval();
  play(7, 7, false);
  play(7, 10);
  assert.ok(g.ready());
});

test("hidden playback isn't counted; a missing range can be replayed", () => {
  const { g, play } = make();
  g.start();
  play(0, 3);
  play(3, 6, false);
  play(6, 10);
  assert.equal(g.ready(), false);
  g.breakInterval();
  play(2, 7);
  assert.equal(g.percent(), 100);
  assert.ok(g.ready());
});

test("playback that resumes from the last foreground point can finish", () => {
  const { g, play } = make();
  g.start();
  play(0, 3);
  play(3, 6, false);
  play(3, 10);
  assert.ok(g.ready());
});

test("unannounced timeline jumps don't count and skipped ranges can be recovered", () => {
  const { g, play } = make();
  g.start();
  play(0, 4);
  play(7, 10);
  assert.equal(g.ready(), false);
  g.breakInterval();
  play(3, 8);
  assert.ok(g.ready());
});

test("384.600-second clean watch survives quantization, buffering, stalls, and a short final clock edge", () => {
  const g = createWatchGate();
  let actual = 0, wall = 0;
  g.setDuration(384.600);
  g.start();
  const report = (media = Math.floor(actual * 10) / 10, played) => {
    g.sample({ media, clock: wall, eligible: true, played });
  };
  report();
  while (actual < 384.50) {
    const renderStall = actual > 190 && actual < 190.15;
    const delta = renderStall ? 4.75 : .025;
    actual = Math.min(actual + delta, 384.50);
    wall += delta * 1000;
    if (actual > 139.80 && actual < 139.84) {
      // Typical waiting/playing event round-off is much smaller than a seek.
      g.breakInterval();
      wall += 6500;
      actual += .15;
    }
    report(undefined, { length: 1, start: () => 0, end: () => actual });
  }
  assert.equal(g.percent(), 100);
  assert.equal(g.firstMissing(), null);
  assert.ok(g.ready());
});

test("a known short seek is never mistaken for rounding, including after refresh", () => {
  const g = createWatchGate(), duration = 384.6;
  g.setDuration(duration);
  g.start();
  let clock = 0;
  const feed = (start, end) => {
    const points = Math.ceil((end - start) * 10);
    for (let i = 0; i <= points; i++) {
      g.sample({ media: start + (end - start) * i / points, clock, eligible: true });
      clock += 100;
    }
  };
  feed(0, 120);
  g.markSkip(120, 120.20);
  feed(120.20, duration);
  assert.deepEqual(g.firstMissing(), { start: 120, end: 120.20 });
  assert.equal(g.ready(), false);
  const restored = createWatchGate();
  restored.setDuration(duration);
  const now = Date.now();
  assert.ok(restored.restore({ ...g.snapshot(), position: duration, savedAt: now }, now));
  assert.deepEqual(restored.firstMissing(), { start: 120, end: 120.20 });
  restored.breakInterval();
  for (const [i, media] of [119.8, 119.9, 120, 120.1, 120.2, 120.3].entries()) {
    restored.sample({ media, clock: i * 100, eligible: true });
  }
  assert.ok(restored.ready());
});

test("small gaps in existing saved progress recover without erasing substantive missing intervals", () => {
  const now = Date.now(), duration = 384.6;
  const g = createWatchGate();
  g.setDuration(duration);
  assert.ok(g.restore({ savedAt: now, duration, position: duration,
    ranges: [[.06, 113], [113.14, 221], [221.11, 325], [325.18, 384.55]] }, now));
  assert.ok(g.ready());
  const missing = createWatchGate();
  missing.setDuration(duration);
  assert.ok(missing.restore({ savedAt: now, duration, position: duration,
    ranges: [[.06, 113], [113.14, 221], [228, 325], [325.18, 384.55]] }, now));
  assert.deepEqual(missing.firstMissing(), { start: 221, end: 228 });
  assert.equal(missing.ready(), false);
});
