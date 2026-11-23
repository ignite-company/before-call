import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
function sign(body, key) {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function createHandler({ env = process.env, now = Date.now } = {}) {
  return function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const code = env.WATCH_REWARD_CODE?.trim();
    const key = env.WATCH_SESSION_SECRET?.trim();
    const durationMs = Math.ceil(Number(env.WATCH_DURATION_SECONDS) * 1000);
    if (!code || !key || key.length < 32 || !Number.isFinite(durationMs) || durationMs < 1000 || durationMs >= MAX_SESSION_MS) {
      return res.status(503).json({ error: "Reward unavailable" });
    }
    let input = req.body;
    if (typeof input === "string" && input.length <= 1000) {
      try { input = JSON.parse(input); } catch { input = null; }
    }
    const at = now();
    if (input?.action === "start") {
      const body = [at, durationMs, randomBytes(12).toString("hex")].join(".");
      return res.status(200).json({ session: body + "." + sign(body, key) });
    }
    if (input?.action !== "claim" || typeof input.session !== "string" || input.session.length > 150) {
      return res.status(400).json({ error: "Invalid watch session" });
    }
    const token = /^(\d{13})\.(\d{4,8})\.([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/.exec(input.session);
    if (!token) return res.status(400).json({ error: "Invalid watch session" });
    const [, timestamp, oldDuration, nonce, signature] = token;
    const signatureExpected = sign([timestamp, oldDuration, nonce].join("."), key);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(signatureExpected))) {
      return res.status(400).json({ error: "Invalid watch session" });
    }
    const elapsed = at - Number(timestamp);
    if (elapsed < 0 || elapsed > MAX_SESSION_MS || Number(oldDuration) !== durationMs) {
      return res.status(400).json({ error: "Expired watch session" });
    }
    if (elapsed < durationMs) {
      return res.status(425).json({ retryAfter: Math.ceil((durationMs - elapsed) / 1000) });
    }
    return res.status(200).json({ code });
  };
}

export default createHandler();
