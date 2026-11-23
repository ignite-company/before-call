import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../api/reward.mjs";

const env = {
  WATCH_REWARD_CODE: "dummy-qa-only",
  WATCH_SESSION_SECRET: "a-dummy-secret-used-by-local-automated-tests",
  WATCH_DURATION_SECONDS: "10"
};
function fixture(conf = env) {
  let time = 1700000000000;
  const handler = createHandler({ env: conf, now: () => time });
  return {
    advance(ms) { time += ms; },
    request(body, method = "POST") {
      const headers = {};
      const result = { headers };
      const res = {
        setHeader(key, value) { headers[key] = value; },
        status(code) { result.status = code; return this; },
        json(body) { result.body = body; return this; }
      };
      handler({ method, body }, res);
      return result;
    }
  };
}

test("fails closed if duration, code, or session secret are not configured", () => {
  for (const name of Object.keys(env)) {
    const f = fixture({ ...env, [name]: "" });
    assert.equal(f.request({ action: "start" }).status, 503);
  }
  assert.equal(fixture().request(null, "GET").status, 405);
});

test("session only permits a claim after the configured duration at the maximum allowed rate", () => {
  const f = fixture();
  assert.equal(f.request({ action: "claim" }).status, 400);
  const start = f.request({ action: "start", durationSeconds: 1 });
  const { session } = start.body;
  assert.equal(start.body.code, undefined);
  assert.equal(f.request({ action: "claim", session }).status, 425);
  f.advance(4999);
  assert.equal(f.request({ action: "claim", session }).body.retryAfter, 1);
  f.advance(1);
  const result = f.request({ action: "claim", session });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, env.WATCH_REWARD_CODE);
  assert.match(result.headers["Cache-Control"], /no-store/);
});

test("rejects a tampered timestamp, signature, or expired token", () => {
  const f = fixture();
  const { session } = f.request({ action: "start" }).body;
  assert.equal(f.request({ action: "claim", session: session.replace(/^\d/, "9") }).status, 400);
  assert.equal(f.request({ action: "claim", session: session.slice(0,-1) + (session.endsWith("A") ? "B" : "A") }).status, 400);
  f.advance(15 * 24 * 60 * 60 * 1000);
  assert.equal(f.request({ action: "claim", session }).status, 400);
});

test("actual 384.600-second clip rejects early claim but unlocks after 192.3 seconds at 2×", () => {
  const f = fixture({ ...env, WATCH_DURATION_SECONDS: "384.600" });
  const { session } = f.request({ action: "start" }).body;
  f.advance(192299);
  assert.equal(f.request({ action: "claim", session }).status, 425);
  f.advance(1);
  assert.equal(f.request({ action: "claim", session }).status, 200);
});
