// Simulate media/browser events to test the app's real refresh wiring without
// an external network, an installed browser, or access to any live code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWatchGate } from "../watch-gate.mjs";
import { activeSession, createProgressStorage, restorePosition } from "../watch-persistence.mjs";
import { MAX_PLAYBACK_RATE } from "../playback-policy.mjs";
import { createHandler } from "../api/reward.mjs";

const source = readFileSync(new URL("../app.mjs", import.meta.url), "utf8").replace(/^import .*\n/gm, "");
const createApp = new Function("videoUrl", "createWatchGate", "activeSession", "createProgressStorage", "restorePosition",
  "document", "globalThis", "performance", "requestAnimationFrame", "cancelAnimationFrame", "fetch", "matchMedia",
  "Date", "setTimeout", "clearTimeout", "MAX_PLAYBACK_RATE", source);

class Element {
  listeners = new Map();
  style = {};
  hidden = false;
  disabled = false;
  textContent = "";
  attributes = {};
  classList = { add() {}, remove() {} };
  addEventListener(key, fn) {
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(fn);
  }
  async fire(key) { for (const fn of this.listeners.get(key) ?? []) await fn(); }
  setAttribute(key, value) { this.attributes[key] = key === "aria-valuenow" ? Number(value) : String(value); }
  focus() {}
}
function browser() {
  const initial = Date.now();
  let wallClock = initial, timeouts = [], testSequence = 0;
  const values = new Map(), requests = [];
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v)
  };
  const env = {
    WATCH_REWARD_CODE: "dummy-test-code",
    WATCH_SESSION_SECRET: "signed-dummy-secret-used-by-test-only",
    WATCH_DURATION_SECONDS: "5"
  };
  const handler = createHandler({ env, now: () => wallClock });
  async function fetch(_path, req) {
    const body = JSON.parse(req.body);
    requests.push(body);
    let code, json;
    handler({ method: req.method, body }, {
      setHeader() {},
      status(n) { code = n; return this; },
      json(v) { json = v; }
    });
    return { status: code, ok: code >= 200 && code < 300, json: async () => json };
  }
  function page({ loadMetadata = true, navigator } = {}) {
    timeouts = [];
    const elements = new Map(), raf = new Map();
    const el = (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    };
    el("code-panel").hidden = true;
    const doc = new Element(), win = new Element(), player = el("video");
    win.navigator = navigator;
    let time = 0, seq = 0;
    doc.getElementById = el;
    Object.assign(player, {
      duration: NaN, videoWidth: 640, videoHeight: 360, currentTime: 0, paused: true, ended: false,
      seeking: false, playbackRate: 1, parentElement: new Element(),
      play() { this.paused = false; void this.fire("playing"); return Promise.resolve(); },
      pause() { if (!this.paused) { this.paused = true; void this.fire("pause"); } }
    });
    const metadata = async () => { player.duration = 5; await player.fire("loadedmetadata"); };
    createApp("fake.mp4", createWatchGate, activeSession,
      source => createProgressStorage(source, () => storage, () => wallClock), restorePosition,
      doc, win, { now: () => time }, fn => { raf.set(++seq, fn); return seq; }, id => raf.delete(id),
      fetch, () => ({ matches: true }), { now: () => wallClock },
      (fn, ms) => { const id = ++testSequence; timeouts.push({ fn, due: wallClock + ms, id }); return id; },
      id => { timeouts = timeouts.filter(t => t.id !== id); }, MAX_PLAYBACK_RATE);
    const playTo = async (to) => {
      while (player.currentTime < to - .0001) {
        player.currentTime = Math.min(to, player.currentTime + .025);
        time += 25;
        wallClock += 25;
        for (const [id, fn] of [...raf]) { raf.delete(id); fn(time); }
      }
    };
    const end = async () => { player.ended = true; player.pause(); await player.fire("ended"); };
    return { el, player, playTo, end, win, metadata, ready: loadMetadata ? metadata() : Promise.resolve() };
  }
  const advance = (ms) => {
    wallClock += ms;
    for (const t of timeouts.filter(t => t.due <= wallClock)) t.fn();
    timeouts = timeouts.filter(t => t.due > wallClock);
  };
  return { page, advance, values, requests, env };
}

test("mid-video refresh resumes with sound, preserving saved progress and original session", async () => {
  const b = browser(), first = b.page();
  await first.ready;
  await first.el("start").fire("click");
  await first.playTo(2.5);
  await first.win.fire("pagehide");
  const second = b.page();
  await second.ready;
  assert.equal(second.el("start-text").textContent, "Resume video");
  assert.ok(second.el("watch-progress").attributes["aria-valuenow"] >= 49);
  assert.equal(second.el("claim").disabled, true);
  await second.el("start").fire("click");
  assert.equal(second.player.muted, false);
  assert.ok(Math.abs(second.player.currentTime - 2.05) < .001);
  await second.playTo(5);
  await second.end();
  assert.equal(second.el("claim").disabled, false);
  await second.el("claim").fire("click");
  assert.equal(second.el("reward-code").textContent, "dummy-test-code");
  assert.deepEqual(b.requests.map(r => r.action), ["start", "claim"]);
  await second.win.fire("pagehide");
  const third = b.page();
  await third.ready;
  assert.equal(third.el("start-text").textContent, "Play again");
  assert.equal(third.el("claim").disabled, false);
  assert.equal(third.el("code-panel").hidden, true);
  await third.el("claim").fire("click");
  assert.equal(third.el("reward-code").textContent, "dummy-test-code");
  assert.deepEqual(b.requests.map(r => r.action), ["start", "claim", "claim"]);
  assert.equal([...b.values.values()][0].includes("dummy-test-code"), false);
});

test("rejected cached session gets a new server timer without asking the visitor to replay", async () => {
  const b = browser(), first = b.page();
  await first.ready;
  await first.el("start").fire("click");
  await first.playTo(5);
  await first.end();
  await first.win.fire("pagehide");
  // Simulate legitimate Vercel key rotation. A previous timed token cannot be reused.
  b.env.WATCH_SESSION_SECRET += "-rotated";
  const fresh = b.page();
  await fresh.ready;
  await fresh.el("claim").fire("click");
  assert.equal(fresh.el("claim").disabled, true);
  assert.equal(fresh.el("code-panel").hidden, true);
  assert.match(fresh.el("watch-status").textContent, /ready in about 3 seconds/);
  b.advance(3100);
  assert.equal(fresh.el("claim").disabled, false);
  await fresh.el("claim").fire("click");
  assert.equal(fresh.el("reward-code").textContent, "dummy-test-code");
  assert.deepEqual(b.requests.map(r => r.action), ["start", "claim", "start", "claim", "claim"]);
});

test("slow and failed metadata cannot wipe progress or trap the resume button", async () => {
  const b = browser(), first = b.page();
  await first.ready;
  await first.el("start").fire("click");
  await first.playTo(2.5);
  await first.win.fire("pagehide");
  const saved = [...b.values.values()][0];
  const slow = b.page({ loadMetadata: false });
  await slow.ready;
  assert.equal(slow.el("start").disabled, true);
  b.advance(5100);
  assert.equal(slow.el("start").disabled, false);
  await slow.el("start").fire("click");
  assert.equal(slow.el("start").disabled, false);
  await slow.player.fire("error");
  assert.equal([...b.values.values()][0], saved);
  const recovered = b.page();
  await recovered.ready;
  assert.equal(recovered.el("start-text").textContent, "Resume video");
});

test("missing section button locates the first real gap, then points to the next and unlocks after recovery", async () => {
  const b = browser(), p = b.page();
  await p.ready;
  await p.el("start").fire("click");
  await p.playTo(1.1);
  p.player.currentTime = 2.1;
  await p.player.fire("seeking");
  await p.player.fire("seeked");
  await p.playTo(2.9);
  p.player.currentTime = 4.1;
  await p.player.fire("seeking");
  await p.player.fire("seeked");
  await p.playTo(5);
  await p.end();
  assert.equal(p.el("claim").disabled, true);
  assert.equal(p.el("missing-action").hidden, false);
  assert.match(p.el("missing-note").textContent, /0:01/);
  p.player.ended = false;
  await p.el("missing-button").fire("click");
  assert.ok(Math.abs(p.player.currentTime - .5) < .03);
  await p.playTo(2.3);
  assert.match(p.el("missing-note").textContent, /0:02/);
  await p.el("missing-button").fire("click");
  assert.ok(Math.abs(p.player.currentTime - 2.3) < .03);
  await p.playTo(4.3);
  assert.equal(p.el("missing-action").hidden, true);
  assert.equal(p.el("claim").disabled, false);
});


test("prefilled SMS is absent until claim, then uses the encoded earned code on Apple and Android", async () => {
  for (const [navigator, delimiter] of [
    [{ userAgent: "iPhone" }, "&"],
    [{ platform: "MacIntel", maxTouchPoints: 5 }, "&"],
    [{ userAgent: "Android" }, "?"],
  ]) {
    const b = browser();
    b.env.WATCH_REWARD_CODE = "CODE 25 + #";
    const p = b.page({ navigator });
    await p.ready;
    assert.equal(p.el("text-code").attributes.href, undefined);
    await p.el("claim").fire("click");
    assert.equal(p.el("text-code").attributes.href, undefined);
    await p.el("start").fire("click");
    await p.playTo(5);
    await p.end();
    await p.el("claim").fire("click");
    assert.equal(p.el("code-panel").hidden, false);
    assert.equal(p.el("text-code").attributes.href, "sms:+12019739748" + delimiter + "body=CODE%2025%20%2B%20%23");
  }
});
