import { videoUrl } from "./config.mjs";
import { createWatchGate } from "./watch-gate.mjs";
import { MAX_PLAYBACK_RATE } from "./playback-policy.mjs";
import { activeSession, createProgressStorage, restorePosition } from "./watch-persistence.mjs";

const el = (id) => document.getElementById(id);
const video = el("video"), intro = el("video-interstitial"), start = el("start");
const claim = el("claim"), fill = el("progress-fill"), progress = el("watch-progress");
const status = el("watch-status"), panel = el("code-panel"), rewardCode = el("reward-code");
const gate = createWatchGate();
const suppliedPrep = new URLSearchParams((globalThis.location?.hash ?? "").slice(1)).get("prep");
const prep = typeof suppliedPrep === "string" && /^[a-f0-9-]{36}\.\d{10}\.[A-Za-z0-9_-]{43}$/.test(suppliedPrep) ? suppliedPrep : null;
const storage = createProgressStorage(prep ? videoUrl + "#" + prep.split(".")[0] : videoUrl);
let startEventInFlight = false, startEventSent = false;
function prepEvent(kind, proof) {
  if (!prep) return;
  if (kind === "started" && (startEventInFlight || startEventSent)) return;
  if (kind === "started") startEventInFlight = true;
  // A delayed/unreachable alert store must not hold up playback or claim.
  void fetch("./api/prep-event", {
    method:"POST", cache:"no-store", keepalive:true,
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(proof ? {prep,kind,proof} : {prep,kind})
  }).then(response => {
    if (kind === "started" && response.ok) startEventSent = true;
  }).catch(() => {}).finally(() => {
    if (kind === "started") startEventInFlight = false;
  });
}

const saved = videoUrl.trim() ? storage.read() : null;
const resume = el("resume-note"), missingAction = el("missing-action");
const missingNote = el("missing-note"), missingButton = el("missing-button");
let recoveryOffered = false, plannedSeek = null;
let started = false, playing = false, claiming = false, revealed = false, broken = false;
let lastPct = 0, lastForeground = 0, animationId, watchSession, rewardRetryTimer;
let rewardRetryAt = 0, lastSavedAt = 0, restoredPosition = null, hasCelebrated = false;
let sessionToken = null, lastSessionAttempt = -Infinity;
const rewardDialog = el("reward-dialog");
let popupFocusReturn = null;

function persist(force = false) {
  if ((!started && restoredPosition === null) || broken) return;
  const now = Date.now();
  if (!force && now - lastSavedAt < 1200) return;
  lastSavedAt = now;
  const snapshot = gate.snapshot();
  if (!snapshot.ranges.length) return;
  storage.write({
    ...snapshot,
    position: Math.max(0, Math.min(snapshot.duration, lastForeground)),
    session: sessionToken,
    celebrated: hasCelebrated
  });
}

function formatPosition(value) {
  const seconds = Math.floor(Math.max(0, value));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function seekTo(position) {
  stopFrames();
  plannedSeek = position;
  video.currentTime = position;
}

function maybeRestore() {
  if (started || !saved || restoredPosition !== null || !gate.restore(saved)) return;
  const gap = gate.firstMissing();
  restoredPosition = saved.position >= saved.duration - 1 && gap
    ? Math.max(0, gap.start - .60) : restorePosition(saved);
  lastForeground = saved.position;
  hasCelebrated = saved.celebrated;
  sessionToken = saved.session;
  el("start-text").textContent = gate.ready() ? "Play again" : "Resume video";
  resume.textContent = gate.ready() ? "Video complete on this browser." : "Progress saved · Resume at " + formatPosition(restoredPosition);
  recoveryOffered = !gate.ready() && saved.position >= saved.duration - 1;
  resume.hidden = false;
  status.textContent = gate.ready() ? "Video complete. Your code is ready." :
    "Progress saved. Finish watching to unlock the code.";
  if (!sessionToken) startRewardSession();
  render();
}

function render() {
  const pct = gate.percent();
  claim.disabled = !gate.ready() || claiming || revealed || broken || Date.now() < rewardRetryAt;
  const gap = recoveryOffered && !broken && !revealed && !gate.ready() && gate.firstMissing();
  missingAction.hidden = !gap;
  if (gap) {
    const message = "First section to finish starts at " + formatPosition(gap.start) + ".";
    if (missingNote.textContent !== message) missingNote.textContent = message;
  }
  if (pct !== lastPct) {
    if (pct === 100 && recoveryOffered && !claiming && !revealed && !broken) {
      status.textContent = "Video complete. Your code is ready.";
    }
    lastPct = pct;
    fill.style.width = pct + "%";
    progress.setAttribute("aria-valuenow", pct);
  }
}
function sample(eligible) {
  if (!eligible) return gate.breakInterval();
  gate.sample({ media: video.currentTime, clock: performance.now(), eligible, rate: video.playbackRate, played: video.played });
  lastForeground = video.currentTime;
}
function frame() {
  if (!playing || !started || document.hidden) return;
  sample(!video.seeking && !video.paused && !video.ended);
  render();
  persist();
  if (!sessionToken && Date.now() - lastSessionAttempt > 12000) startRewardSession();
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
  resume.hidden = true;
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
  if (saved) {
    // Do not start the teaser for returning viewers. Set up resume once
    // metadata is available, or offer an ordinary start if it has changed.
    start.disabled = true;
    el("start-text").textContent = "Loading saved progress…";
  }
  video.addEventListener("loadedmetadata", () => {
    gate.setDuration(video.duration);
    if (saved && Number.isFinite(video.duration) && video.duration > 0) {
      maybeRestore();
      if (restoredPosition === null) el("start-text").textContent = "Press to play";
      start.disabled = false;
    }
    if (video.videoWidth && video.videoHeight) {
      video.parentElement.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    }
  });
  video.addEventListener("durationchange", () => gate.setDuration(video.duration));
  video.addEventListener("error", unavailable);
  video.addEventListener("playing", () => {
    if (!started) {
      if (!saved) el("start-text").textContent = "Your video is playing. Press to unmute";
      return;
    }
    if (playing) return;
    if (document.hidden) { video.pause(); return; }
    playing = true;
    prepEvent("started");
    cancelAnimationFrame(animationId);
    // Capture the exact point where playback begins or resumes.
    sample(!video.seeking);
    animationId = requestAnimationFrame(frame);
  });
  video.addEventListener("pause", () => {
    if (!started) {
      if (!saved) el("start-text").textContent = "Press to play";
      return;
    }
    // At the natural ending, the pause event can precede the ended event.
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
    render();
    persist(true);
    if (gate.ready()) status.textContent = "Video complete. Your code is ready.";
  });
  video.addEventListener("waiting", () => {
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
    persist(true);
  });
  video.addEventListener("seeking", () => {
    const intended = plannedSeek !== null && Math.abs(video.currentTime - plannedSeek) <= .20;
    if (started && !intended) gate.markSkip(lastForeground, video.currentTime);
    else gate.breakInterval();
    // Seeking may resume without firing a separate playing event on some players.
  });
  video.addEventListener("seeked", () => {
    plannedSeek = null;
    gate.breakInterval();
    if (started && !video.paused && !document.hidden && !playing) {
      playing = true;
      animationId = requestAnimationFrame(frame);
    }
    if (started && playing && !video.paused && !document.hidden) sample(true);
    const gap = gate.firstMissing();
    if (gap && gap.end < video.currentTime - .15) recoveryOffered = true;
    render();
  });
  video.addEventListener("ratechange", () => {
    if (video.playbackRate > MAX_PLAYBACK_RATE) {
      video.playbackRate = MAX_PLAYBACK_RATE;
      return;
    }
    if (playing && !document.hidden && !video.seeking) sample(true);
    else gate.breakInterval();
  });
  video.addEventListener("ended", () => {
    if (playing && !document.hidden && !video.seeking) sample(true);
    stopFrames();
    recoveryOffered = !gate.ready() && !revealed;
    render();
    persist(true);
    if (!revealed) status.textContent = gate.ready()
      ? "Video complete. Your code is ready."
      : "Some playback hasn’t been confirmed yet.";
    if (started && !document.hidden && gate.ready() && !hasCelebrated) {
      return claimReward({ automatic: true, allowRetry: true });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && started) {
      stopFrames();
      persist(true);
      if (!video.paused) {
        if (!video.seeking && !video.ended) {
          gate.markSkip(lastForeground, video.currentTime);
          video.pause();
          seekTo(lastForeground);
        } else video.pause();
        status.textContent = "Playback paused while this tab was hidden. Press play to continue.";
      }
    }
  });
  globalThis.addEventListener("pagehide", () => persist(true));
  start.addEventListener("click", () => {
    if (started || broken || start.disabled) return;
    if (saved && !Number.isFinite(video.duration)) {
      // Keep the real click for mobile media gesture policies and wait for
      // metadata before pressing Resume again. No teaser progress is counted.
      video.muted = true;
      video.play().catch(() => {});
      resume.textContent = "Still loading your video. Try again in a moment.";
      return;
    }
    beginPlayback(gate.ready() ? 0 : (restoredPosition ?? 0));
  });
  missingButton.addEventListener("click", () => {
    const gap = gate.firstMissing();
    if (!gap || !recoveryOffered || broken || revealed) return;
    status.textContent = "Playing the section around " + formatPosition(gap.start) + ".";
    beginPlayback(Math.max(0, gap.start - .60), true);
  });
  video.src = videoUrl;
  if (!saved) {
    // Start the signed clock while the media loads, not after someone finishes.
    startRewardSession();
    video.play().catch(() => { if (!started && !broken) el("start-text").textContent = "Press to play"; });
  }
  // Metadata errors must not erase progress. A slow metadata load should not
  // prevent the visitor from using a gesture to start the media download.
  if (saved) setTimeout(() => {
    if (!started && !broken && start.disabled) {
      start.disabled = false;
      el("start-text").textContent = "Resume video";
      resume.hidden = false;
      resume.textContent = "Loading saved progress. Press play to continue.";
    }
  }, 5000);
}

function beginPlayback(position, moveToVideo = false) {
  if (!started) {
    started = true;
    gate.start();
    video.pause();
    video.muted = false;
    if (!sessionToken) startRewardSession();
    video.controls = true;
    intro.hidden = true;
  }
  if (Math.abs(video.currentTime - position) > .001) seekTo(position);
  video.play().catch(() => {
    if (!broken) status.textContent = "Press play on the video to continue.";
  });
  if (moveToVideo) {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    video.scrollIntoView?.({ block: "center", behavior });
  }
  video.focus({ preventScroll: moveToVideo });
}

function rewardRequest(data) {
  return fetch("./api/reward", {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(prep ? { ...data, prep } : data),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
  });
}

function startRewardSession() {
  if (watchSession) return watchSession;
  lastSessionAttempt = Date.now();
  watchSession = beginRewardSession().finally(() => { watchSession = null; });
  return watchSession;
}

async function beginRewardSession() {
  try {
    const response = await rewardRequest({ action: "start" });
    if (!response.ok) return null;
    const { session } = await response.json();
    sessionToken = activeSession(session);
    persist(true);
    return sessionToken;
  } catch { return null; }
}

claim.addEventListener("click", () => claimReward());

async function claimReward({ automatic = false, allowRetry = false } = {}) {
  if (!gate.ready() || claiming || revealed || broken || Date.now() < rewardRetryAt) return;
  claiming = true;
  render();
  status.textContent = "Revealing your code…";
  try {
    let session = activeSession(sessionToken) || await watchSession;
    if (!session) {
      session = await startRewardSession();
    }
    if (!session) throw new Error("Unavailable");
    let result = await rewardRequest({ action: "claim", session });
    if (result.status === 400) {
      // Secret rotation or server expiry can invalidate a cached session.
      // Keep watched ranges, but obtain a new authenticated timer.
      sessionToken = null;
      session = await startRewardSession();
      if (!session) throw new Error("Unavailable");
      result = await rewardRequest({ action: "claim", session });
    }
    if (result.status === 425) {
      const { retryAfter } = await result.json();
      if (!(retryAfter > 0)) throw new Error("Unavailable");
      rewardRetryAt = Date.now() + retryAfter * 1000;
      status.textContent = "Your video is complete. The code will be ready in about " + retryAfter + " seconds.";
      clearTimeout(rewardRetryTimer);
      rewardRetryTimer = setTimeout(() => {
        status.textContent = "Video complete. Your code is ready.";
        render();
        if (automatic && allowRetry && !document.hidden && !hasCelebrated) {
          void claimReward({ automatic: true });
        }
      }, retryAfter * 1000 + 25);
      return;
    }
    if (!result.ok) throw new Error("Unavailable");
    const { code, proof } = await result.json();
    if (typeof code !== "string" || !code.trim() || !gate.claim()) throw new Error("Unavailable");
    revealed = true;
    rewardCode.textContent = code;
    const { userAgent = "", platform = "", maxTouchPoints = 0 } = globalThis.navigator ?? {};
    const appleMobile = /iPhone|iPad|iPod/i.test(userAgent) || (/^Mac/i.test(platform) && maxTouchPoints > 1);
    const separator = appleMobile ? "&" : "?";
    const textLink = "sms:+12019739748" + separator + "body=" + encodeURIComponent(code);
    el("text-code").setAttribute("href", textLink);
    el("dialog-text-code").setAttribute("href", textLink);
    el("dialog-code").textContent = code;
    panel.hidden = false;
    if (typeof proof === "string") prepEvent("unlocked", proof);
    status.textContent = "Your code is unlocked.";
    const firstCelebration = !hasCelebrated;
    hasCelebrated = true;
    persist(true);
    const popupOpened = firstCelebration && openRewardDialog();
    if (!popupOpened) panel.focus();
    if (firstCelebration) celebrate();
  } catch {
    status.textContent = "Couldn’t reveal your code. Please try again.";
  } finally {
    claiming = false;
    render();
  }
}

function openRewardDialog() {
  if (typeof rewardDialog?.showModal !== "function") return false;
  try {
    popupFocusReturn = document.activeElement;
    rewardDialog.showModal();
    rewardDialog.append(el("confetti"));
    el("reward-title").focus({ preventScroll: true });
    return true;
  } catch { return false; }
}
el("close-reward").addEventListener("click", () => rewardDialog.close());
rewardDialog.addEventListener("close", () => {
  const canvas = el("confetti");
  canvas.hidden = true;
  document.body.append(canvas);
  const preferred = popupFocusReturn === claim ? el("text-code") : popupFocusReturn;
  if (preferred && preferred !== document.body && !preferred.disabled) preferred.focus({ preventScroll: true });
  else video.focus({ preventScroll: true });
  popupFocusReturn = null;
});

function setCopyAction(button, code, liveStatus) {
  button.addEventListener("click", async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied!";
      liveStatus.textContent = "Code copied to clipboard.";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection?.removeAllRanges();
      selection?.addRange(range);
      liveStatus.textContent = "Select and copy the displayed code.";
    }
  });
}
setCopyAction(el("copy"), rewardCode, el("copy-status"));
setCopyAction(el("dialog-copy"), el("dialog-code"), el("dialog-copy-status"));

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
