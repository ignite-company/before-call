import { videoUrl } from "./config.mjs";
import { createWatchGate } from "./watch-gate.mjs";

const el = (id) => document.getElementById(id);
const video = el("video"), intro = el("video-interstitial"), start = el("start");
const claim = el("claim"), fill = el("progress-fill"), progress = el("watch-progress");
const status = el("watch-status"), panel = el("code-panel"), rewardCode = el("reward-code");
const gate = createWatchGate();
let started = false, playing = false, claiming = false, revealed = false, broken = false;
let lastPct = 0, lastForeground = 0, animationId, watchSession, rewardRetryTimer;
let rewardRetryAt = 0;

function render() {
  const pct = gate.percent();
  claim.disabled = !gate.ready() || claiming || revealed || broken || Date.now() < rewardRetryAt;
  if (pct !== lastPct) {
    lastPct = pct;
    fill.style.width = pct + "%";
    progress.setAttribute("aria-valuenow", pct);
  }
}
function sample(eligible) {
  if (!eligible) return gate.breakInterval();
  gate.sample({ media: video.currentTime, clock: performance.now(), eligible, rate: video.playbackRate });
  lastForeground = video.currentTime;
}
function frame() {
  if (!playing || !started || document.hidden) return;
  sample(!video.seeking && !video.paused && !video.ended);
  render();
  animationId = requestAnimationFrame(frame);
}
function stopFrames() {
  cancelAnimationFrame(animationId);
  playing = false;
  gate.breakInterval();
}
function unavailable() {
  broken = true;
  stopFrames();
  video.hidden = true;
  intro.hidden = false;
  intro.classList.remove("teaser");
  start.hidden = true;
  el("unavailable").hidden = false;
  status.textContent = "The video is needed to unlock your code.";
  render();
}

if (videoUrl.trim()) {
  video.hidden = false;
  video.muted = true;
  video.playsInline = true;
  intro.classList.add("teaser");
  el("unavailable").hidden = true;
  start.hidden = false;
  status.textContent = "Watch from start to finish to unlock the code.";
  video.addEventListener("loadedmetadata", () => {
    gate.setDuration(video.duration);
    if (video.videoWidth && video.videoHeight) {
      video.parentElement.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    }
  });
  video.addEventListener("durationchange", () => gate.setDuration(video.duration));
  video.addEventListener("error", unavailable);
  video.addEventListener("playing", () => {
    if (!started) {
      el("start-text").textContent = "Your video is playing. Press to unmute";
      return;
    }
    if (playing) return;
    if (document.hidden) { video.pause(); return; }
    playing = true;
    cancelAnimationFrame(animationId);
    // Capture the exact point where playback begins or resumes.
    sample(!video.seeking);
    animationId = requestAnimationFrame(frame);
  });
  video.addEventListener("pause", () => {
    if (!started) {
      el("start-text").textContent = "Press to play";
      return;
    }
    // At the natural ending, the pause event can precede the ended event.
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
    render();
    if (gate.ready()) status.textContent = "Video complete. Your code is ready.";
  });
  video.addEventListener("waiting", () => {
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
  });
  video.addEventListener("seeking", () => {
    gate.breakInterval();
    // Seeking may resume without firing a separate playing event on some players.
  });
  video.addEventListener("seeked", () => {
    gate.breakInterval();
    if (started && playing && !video.paused && !document.hidden) sample(true);
  });
  video.addEventListener("ratechange", () => gate.breakInterval());
  video.addEventListener("ended", () => {
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
    render();
    if (!revealed) status.textContent = gate.ready()
      ? "Video complete. Your code is ready."
      : "Replay any parts you skipped to unlock the code.";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && started) {
      stopFrames();
      if (!video.paused) {
        video.pause();
        if (!video.seeking && !video.ended) video.currentTime = lastForeground;
        status.textContent = "Playback paused while this tab was hidden. Press play to continue.";
      }
    }
  });
  start.addEventListener("click", () => {
    if (started || broken) return;
    started = true;
    gate.start();
    video.pause();
    video.muted = false;
    video.currentTime = 0;
    watchSession = beginRewardSession();
    video.controls = true;
    intro.hidden = true;
    video.play().catch(() => {
      if (!broken) status.textContent = "Press play on the video to start.";
    });
    video.focus();
  });
  video.src = videoUrl;
  video.play().catch(() => { if (!started && !broken) el("start-text").textContent = "Press to play"; });
}

function rewardRequest(data) {
  return fetch("./api/reward", {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
}

async function beginRewardSession() {
  try {
    const response = await rewardRequest({ action: "start" });
    if (!response.ok) return null;
    const { session } = await response.json();
    return typeof session === "string" ? session : null;
  } catch { return null; }
}

claim.addEventListener("click", async () => {
  if (!gate.ready() || claiming || revealed || broken || Date.now() < rewardRetryAt) return;
  claiming = true;
  render();
  status.textContent = "Revealing your code…";
  try {
    let session = await watchSession;
    if (!session) {
      watchSession = beginRewardSession();
      session = await watchSession;
    }
    if (!session) throw new Error("Unavailable");
    const result = await rewardRequest({ action: "claim", session });
    if (result.status === 425) {
      const { retryAfter } = await result.json();
      if (!(retryAfter > 0)) throw new Error("Unavailable");
      rewardRetryAt = Date.now() + retryAfter * 1000;
      status.textContent = "Your video is complete. The code will be ready in about " + retryAfter + " seconds.";
      clearTimeout(rewardRetryTimer);
      rewardRetryTimer = setTimeout(() => {
        status.textContent = "Video complete. Your code is ready.";
        render();
      }, retryAfter * 1000 + 25);
      return;
    }
    if (!result.ok) throw new Error("Unavailable");
    const { code } = await result.json();
    if (typeof code !== "string" || !code.trim() || !gate.claim()) throw new Error("Unavailable");
    revealed = true;
    rewardCode.textContent = code;
    panel.hidden = false;
    status.textContent = "Your code is unlocked.";
    panel.focus();
    celebrate();
  } catch {
    status.textContent = "Couldn’t reveal your code. Please try again.";
  } finally {
    claiming = false;
    render();
  }
});

el("copy").addEventListener("click", async () => {
  if (!revealed) return;
  try {
    await navigator.clipboard.writeText(rewardCode.textContent);
    el("copy").textContent = "Copied!";
    el("copy-status").textContent = "Code copied to clipboard.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(rewardCode);
    selection.removeAllRanges();
    selection.addRange(range);
    el("copy-status").textContent = "Select and copy the displayed code.";
  }
});

function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = el("confetti"), ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = innerWidth, height = innerHeight, scale = Math.min(devicePixelRatio, 2);
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.hidden = false;
  ctx.scale(scale, scale);
  const colors = ["#f32632", "#ff747a", "#fff7ef", "#ffca92"];
  const particles = Array.from({ length: 116 }, (_, i) => ({
    x: Math.random() * width, y: -8 - Math.random() * 330,
    vx: Math.random() * 115 - 57, vy: 175 + Math.random() * 200,
    r: 3 + Math.random() * 4, angle: Math.random() * Math.PI,
    spin: Math.random() * 9 - 4.5, color: colors[i % colors.length]
  }));
  const startTime = performance.now();
  const tick = (now) => {
    const t = (now - startTime) / 1000;
    ctx.clearRect(0, 0, width, height);
    if (t > 3.6) { canvas.hidden = true; return; }
    ctx.globalAlpha = Math.min(1, Math.max(0, (3.6 - t) / .55));
    for (const p of particles) {
      ctx.save();
      ctx.translate(p.x + t * p.vx, p.y + t * p.vy + t * t * 75);
      ctx.rotate(p.angle + t * p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.65);
      ctx.restore();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
