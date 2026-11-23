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
