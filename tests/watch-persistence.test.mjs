import test from "node:test";
import assert from "node:assert/strict";
import { activeSession, createProgressStorage, restorePosition } from "../watch-persistence.mjs";
import { createWatchGate } from "../watch-gate.mjs";

const now = 1763912345000;
const token = (issuedAt = now) => issuedAt + ".10000." + "a".repeat(24) + "." + "B".repeat(43);
const state = (overrides = {}) => ({
  duration: 10, position: 5, ranges: [[0, 5]], savedAt: now, session: token(), ...overrides
});

function fixture() {
  const db = new Map();
  const memory = {
    getItem: (k) => db.get(k) ?? null,
    setItem: (k, v) => db.set(k, v)
  };
  return { db, memory, store: createProgressStorage("video-v1.mp4", () => memory, () => now) };
}
function play(g, from, to) {
  for (let i = 0; i <= Math.round((to - from) * 100); i++) {
    g.sample({ media: from + i / 100, clock: 20000 + i * 10, eligible: true });
  }
}

test("refresh midway restores only watched ranges and resumes with overlap", () => {
  const { store } = fixture();
  assert.ok(store.write(state()));
  const restored = store.read();
  assert.equal(restored.session, token());
  const gate = createWatchGate();
  gate.setDuration(10);
  assert.ok(gate.restore(restored, now));
  assert.equal(gate.percent(), 50);
  assert.equal(gate.ready(), false);
  const position = restorePosition(restored);
  assert.equal(position, 4.55);
  play(gate, position, 10);
  assert.equal(gate.ready(), true);
});
test("completion survives refresh, but coupon text is never stored", () => {
  const { store, db } = fixture();
  const g = createWatchGate();
  g.setDuration(10);
  store.write(state({ position: 10, ranges: [[0,10]], celebrated: true, code: "must-not-persist" }));
  assert.ok(g.restore(store.read(), now));
  assert.ok(g.ready());
  assert.ok(store.read().celebrated);
  assert.equal([...db.values()][0].includes("must-not-persist"), false);
});
test("a seek to the end leaves skipped ranges locked after refresh", () => {
  const { store } = fixture();
  store.write(state({ position: 10, ranges: [[0,3], [7,10]] }));
  const g = createWatchGate();
  g.setDuration(10);
  const saved = store.read();
  assert.ok(g.restore(saved, now));
  assert.equal(g.ready(), false);
  assert.equal(restorePosition(saved), 2.55);
  play(g, restorePosition(saved), 7.5);
  assert.ok(g.ready());
});
test("range shape, source, observed duration and stale snapshots are checked", () => {
  const { store, memory } = fixture();
  assert.ok(store.write(state()));
  assert.equal(createProgressStorage("video-v2.mp4", () => memory, () => now).read(), null);
  assert.equal(createProgressStorage("video-v1.mp4", () => memory, () => now + 15 * 86400000).read(), null);
  for (const ranges of [[[0,11]], [[4,1]], [[0,4],[3,9]], [[0,5],[0,5]], [[0,NaN]]]) {
    assert.equal(store.write(state({ ranges })), false);
  }
  const g = createWatchGate();
  g.setDuration(11);
  assert.equal(g.restore(store.read(), now), false);
  assert.equal(g.percent(), 0);
});
test("expired or malformed token does not discard legitimate progress", () => {
  assert.equal(activeSession(token(now - 86400000), now), null);
  assert.equal(activeSession("arbitrary", now), null);
  const { store } = fixture();
  assert.ok(store.write(state({ session: token(now - 90000000) })));
  assert.equal(store.read().session, null);
  assert.deepEqual(store.read().ranges, [[0,5]]);
});
test("disabled storage and stale tabs won't wipe good data", () => {
  const disabled = createProgressStorage("video-v1.mp4", () => { throw new Error("not allowed"); }, () => now);
  assert.equal(disabled.read(), null);
  assert.equal(disabled.write(state()), false);
  const { store } = fixture();
  assert.ok(store.write(state({ position: 10, ranges: [[0,10]], celebrated: true })));
  assert.equal(store.write(state({ position: 2, ranges: [[0,2]] })), false);
  assert.ok(store.read().celebrated);
});
