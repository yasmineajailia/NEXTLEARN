/**
 * attentionTracker.js
 *
 * Client-side attention tracking for NextLearn lessons and quizzes, built on
 * MediaPipe FaceMesh (CDN). ALL video processing happens locally in the
 * browser — no frame, image, or video stream ever leaves the device. Only
 * derived numeric metrics (focus scores, distraction events) are POSTed to
 * /api/student/attention-session when a session ends.
 *
 * Usage (classic script tag):
 *   <script src="/student/js/attentionTracker.js"></script>
 *   <script>
 *     AttentionTracker.init();
 *     AttentionTracker.start("sess-1", "lesson", "programmation-c", "1.2");
 *     // ... later
 *     AttentionTracker.stop();
 *   </script>
 *
 * Public API: init(), start(sessionId, context, moduleId, subAcquisId),
 * stop(), getScore(), destroy(). Also emits "nextlearn:focusUpdate" DOM
 * events every 5 seconds while tracking.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.AttentionTracker = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var CONSENT_KEY = "nextlearn_attention_consent";
  var STYLE_ID = "attention-tracker-styles";

  var FACEMESH_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
  var CAMERA_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
  var FACEMESH_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/";

  var FRAME_INTERVAL_MS = 125;          // 8 fps
  var EAR_THRESHOLD = 0.2;
  var EYES_CLOSED_MS = 2000;            // EAR low for >2s => eyes closed
  var YAW_HIGH = 1.35;                  // >35% deviation from 1.0
  var YAW_LOW = 0.65;
  var GAZE_SHIFT_LIMIT = 0.4;           // iris >40% toward a corner
  var WINDOW_MS = 30000;                // rolling focus window
  var SCORE_INTERVAL_MS = 5000;         // score sample cadence
  var DISTRACT_TOAST_AFTER_MS = 5000;   // pulse + toast after 5s distracted
  var TOAST_COOLDOWN_MS = 30000;        // max one distraction toast / 30s
  var BRIGHTNESS_MIN = 40;              // of 255
  var LIGHTING_CHECK_EVERY = 10;        // every 10th processed frame

  // ---------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------

  var state = {
    initialized: false,
    mobile: false,
    faceMesh: null,
    camera: null,
    video: null,
    lightCanvas: null,
    session: null,          // active session data, null when idle
    paused: false,          // user toggle or hidden tab
    hiddenPaused: false,    // paused specifically by visibilitychange
    lastFrameTs: 0,
    frameCount: 0,
    earLowSince: null,
    currentDistraction: null, // { reason, startedAt } in active-ms space
    distractedSince: null,    // wall-clock ms for toast/pulse
    lastDistractToastTs: 0,
    lightingWarned: false,
    scoreTimer: null,
    window: [],             // [{ at: activeMs, focused: bool }]
    lastChecks: { eyesOpen: true, headForward: true, gazeOnScreen: true },
    currentScore: null,
    widget: null,
    toggleBtn: null,
    toastEl: null,
    consentPromise: null,
    loadPromise: null,
    onVisibility: null
  };

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------

  function isMobileDevice() {
    var ua = navigator.userAgent || "";
    var uaMobile = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(ua);
    var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    return uaMobile || (coarse && !window.matchMedia("(pointer: fine)").matches);
  }

  function getIdentifier() {
    try {
      var raw = JSON.parse(localStorage.getItem("nextlearnCurrentUser") || "null");
      return raw && typeof raw.identifier === "string" ? raw.identifier : "";
    } catch (_e) {
      return "";
    }
  }

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (_e) { return null; }
  }
  function setConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (_e) { /* ignore */ }
  }

  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Milliseconds of ACTIVE (non-paused) session time elapsed. */
  function activeMs() {
    if (!state.session) return 0;
    var extra = state.session.runningSince != null ? Date.now() - state.session.runningSince : 0;
    return state.session.accumulatedMs + extra;
  }

  // ---------------------------------------------------------------------
  // Styles + toasts
  // ---------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = "" +
      ".att-consent-backdrop{position:fixed;inset:0;background:rgba(13,17,23,.55);z-index:11000;display:flex;align-items:center;justify-content:center;padding:1rem;}" +
      ".att-consent-modal{background:#fff;border-radius:16px;max-width:430px;width:100%;padding:1.6rem 1.7rem;box-shadow:0 24px 60px rgba(0,0,0,.3);font-family:'Source Sans 3','Segoe UI',sans-serif;color:#182235;}" +
      ".att-consent-modal h2{margin:0 0 .7rem;font-family:'Space Grotesk',sans-serif;font-size:1.15rem;color:#111827;}" +
      ".att-consent-modal p{margin:0 0 .9rem;font-size:.92rem;line-height:1.55;color:#4b5563;}" +
      ".att-consent-modal ul{margin:0 0 1.2rem;padding:0;list-style:none;display:grid;gap:.4rem;}" +
      ".att-consent-modal li{font-size:.87rem;color:#1f2937;font-weight:600;}" +
      ".att-consent-actions{display:flex;gap:.6rem;justify-content:flex-end;}" +
      ".att-btn{border:0;border-radius:999px;padding:.6rem 1.25rem;font:inherit;font-weight:700;font-size:.88rem;cursor:pointer;}" +
      ".att-btn-primary{background:#c41d38;color:#fff;}" +
      ".att-btn-primary:hover{background:#a3172b;}" +
      ".att-btn-secondary{background:#eef1f5;color:#374151;}" +
      ".att-btn-secondary:hover{background:#e2e6ec;}" +
      ".att-widget{position:fixed;right:1.1rem;bottom:6.2rem;z-index:10500;width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;}" +
      ".att-widget svg{position:absolute;inset:0;transform:rotate(-90deg);}" +
      ".att-widget-score{font-size:.95rem;font-weight:700;color:#182235;line-height:1;}" +
      ".att-widget-label{position:absolute;bottom:-1.1rem;left:0;right:0;text-align:center;font-size:.6rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;}" +
      ".att-widget-close{position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;border:0;background:#182235;color:#fff;font-size:.62rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}" +
      "@keyframes attPulse{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,.18);}50%{box-shadow:0 0 0 7px rgba(196,29,56,.30);}}" +
      ".att-widget.att-pulse{animation:attPulse 1.1s ease-in-out infinite;}" +
      ".att-toggle{position:fixed;left:1.1rem;bottom:1.1rem;z-index:10500;width:42px;height:42px;border-radius:50%;border:1px solid #e4e6eb;background:rgba(255,255,255,.94);box-shadow:0 4px 14px rgba(0,0,0,.14);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#374151;padding:0;}" +
      ".att-toggle:hover{background:#f4f6fa;}" +
      ".att-toggle-dot{position:absolute;top:3px;right:3px;width:10px;height:10px;border-radius:50%;background:#9ca3af;border:2px solid #fff;}" +
      ".att-toggle.att-on .att-toggle-dot{background:#1d9e75;}" +
      ".att-toast{position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:11500;background:#182235;color:#fff;border-radius:999px;padding:.6rem 1.2rem;font-family:'Source Sans 3',sans-serif;font-size:.86rem;font-weight:600;box-shadow:0 10px 26px rgba(0,0,0,.28);max-width:92vw;text-align:center;}";
    var styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  function showToast(message, ms) {
    if (state.toastEl) state.toastEl.remove();
    var el = document.createElement("div");
    el.className = "att-toast";
    el.textContent = message;
    document.body.appendChild(el);
    state.toastEl = el;
    setTimeout(function () {
      if (state.toastEl === el) state.toastEl = null;
      el.remove();
    }, ms || 3000);
  }

  // ---------------------------------------------------------------------
  // Consent modal
  // ---------------------------------------------------------------------

  /** Resolves "granted" | "denied", showing the modal only when undecided. */
  function ensureConsent() {
    var existing = getConsent();
    if (existing === "granted" || existing === "denied") {
      return Promise.resolve(existing);
    }
    if (state.consentPromise) return state.consentPromise;

    state.consentPromise = new Promise(function (resolve) {
      injectStyles();
      var backdrop = document.createElement("div");
      backdrop.className = "att-consent-backdrop";
      backdrop.innerHTML =
        '<div class="att-consent-modal" role="dialog" aria-modal="true" aria-label="Suivi d\'attention">' +
        "<h2>Suivi d'attention — votre accord est nécessaire</h2>" +
        "<p>Pour vous aider à mieux apprendre, NextLearn peut analyser votre niveau de concentration via votre caméra. " +
        "Aucune vidéo n'est enregistrée ou envoyée — seul un score de focus calculé localement est conservé.</p>" +
        "<ul>" +
        "<li>✓ Traitement 100% local sur votre appareil</li>" +
        "<li>✓ Aucune vidéo stockée ou transmise</li>" +
        "<li>✓ Vous pouvez désactiver à tout moment</li>" +
        "</ul>" +
        '<div class="att-consent-actions">' +
        '<button type="button" class="att-btn att-btn-secondary" data-choice="denied">Non merci</button>' +
        '<button type="button" class="att-btn att-btn-primary" data-choice="granted">Activer le suivi</button>' +
        "</div></div>";
      backdrop.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-choice]");
        if (!btn) return;
        var choice = btn.dataset.choice;
        setConsent(choice);
        backdrop.remove();
        state.consentPromise = null;
        resolve(choice);
      });
      document.body.appendChild(backdrop);
    });
    return state.consentPromise;
  }

  // ---------------------------------------------------------------------
  // MediaPipe loading
  // ---------------------------------------------------------------------

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.crossOrigin = "anonymous";
      el.onload = resolve;
      el.onerror = function () { reject(new Error("Échec de chargement: " + src)); };
      document.head.appendChild(el);
    });
  }

  /** Loads MediaPipe FaceMesh + Camera utils from CDN (once). */
  function loadMediaPipe() {
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.resolve()
      .then(function () {
        if (typeof window.FaceMesh === "undefined") return loadScript(FACEMESH_CDN);
      })
      .then(function () {
        if (typeof window.Camera === "undefined") return loadScript(CAMERA_CDN);
      })
      .then(function () {
        if (typeof window.FaceMesh === "undefined" || typeof window.Camera === "undefined") {
          throw new Error("MediaPipe indisponible après chargement");
        }
      });
    return state.loadPromise;
  }

  // ---------------------------------------------------------------------
  // Metric computations (all coordinates are FaceMesh normalized landmarks)
  // ---------------------------------------------------------------------

  function computeEar(lm) {
    var left = dist(lm[159], lm[145]) / (dist(lm[33], lm[133]) || 1e-6);
    var right = dist(lm[386], lm[374]) / (dist(lm[362], lm[263]) || 1e-6);
    return (left + right) / 2;
  }

  function computeYawRatio(lm) {
    var nose = lm[1];
    var dLeft = Math.abs(nose.x - lm[234].x);
    var dRight = Math.abs(nose.x - lm[454].x);
    return dLeft / (dRight || 1e-6);
  }

  /**
   * Returns the horizontal gaze shift in [0, 1]: 0 = iris centered,
   * 1 = fully at a corner. Averages both eyes. Requires refineLandmarks
   * (irises at 468-472 / 473-477); returns null when they're absent.
   */
  function computeGazeShift(lm) {
    if (!lm[472] || !lm[477]) return null;
    function eyeShift(irisStart, cornerA, cornerB) {
      var cx = 0;
      for (var i = irisStart; i < irisStart + 5; i++) cx += lm[i].x;
      cx /= 5;
      var minX = Math.min(lm[cornerA].x, lm[cornerB].x);
      var maxX = Math.max(lm[cornerA].x, lm[cornerB].x);
      var span = maxX - minX;
      if (span < 1e-6) return 0;
      var ratio = (cx - minX) / span;         // 0..1 across the eye
      return Math.abs(ratio - 0.5) * 2;       // 0 centered, 1 at corner
    }
    return (eyeShift(468, 33, 133) + eyeShift(473, 362, 263)) / 2;
  }

  /** Average brightness (0-255) of the current frame via a 16×16 canvas. */
  function computeBrightness(image) {
    if (!state.lightCanvas) {
      state.lightCanvas = document.createElement("canvas");
      state.lightCanvas.width = 16;
      state.lightCanvas.height = 16;
    }
    var ctx = state.lightCanvas.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(image, 0, 0, 16, 16);
      var data = ctx.getImageData(0, 0, 16, 16).data;
      var sum = 0;
      for (var i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return sum / (data.length / 4);
    } catch (_e) {
      return 255; // unreadable frame — do not flag lighting
    }
  }

  // ---------------------------------------------------------------------
  // Frame pipeline
  // ---------------------------------------------------------------------

  function onResults(results) {
    if (!state.session || state.paused) return;

    state.frameCount++;
    var now = Date.now();
    var tActive = activeMs();

    // Lighting check on every 10th frame: bad light => metrics null (frame skipped).
    if (state.frameCount % LIGHTING_CHECK_EVERY === 0 && results.image) {
      var brightness = computeBrightness(results.image);
      if (brightness < BRIGHTNESS_MIN) {
        if (!state.lightingWarned) {
          state.lightingWarned = true;
          showToast("Éclairage insuffisant — le suivi d'attention peut être imprécis", 3500);
        }
        return; // metrics null for this frame — not counted as distracted
      }
    }

    var landmarks = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
    var reason = null;
    var checks = { eyesOpen: true, headForward: true, gazeOnScreen: true };

    if (!landmarks) {
      reason = "no_face";
      checks = { eyesOpen: false, headForward: false, gazeOnScreen: false };
      state.earLowSince = null;
    } else {
      // Eyes (EAR with 2s debounce)
      var ear = computeEar(landmarks);
      if (ear < EAR_THRESHOLD) {
        if (state.earLowSince == null) state.earLowSince = now;
        if (now - state.earLowSince > EYES_CLOSED_MS) {
          checks.eyesOpen = false;
          reason = reason || "eyes_closed";
        }
      } else {
        state.earLowSince = null;
      }

      // Head pose (yaw)
      var yaw = computeYawRatio(landmarks);
      if (yaw > YAW_HIGH || yaw < YAW_LOW) {
        checks.headForward = false;
        reason = reason || "head_turned";
      }

      // Gaze (iris)
      var shift = computeGazeShift(landmarks);
      if (shift != null && shift > GAZE_SHIFT_LIMIT) {
        checks.gazeOnScreen = false;
        reason = reason || "gaze_away";
      }
    }

    state.lastChecks = checks;
    var focused = reason == null;

    // Rolling 30s window
    state.window.push({ at: tActive, focused: focused });
    while (state.window.length && state.window[0].at < tActive - WINDOW_MS) {
      state.window.shift();
    }

    // Distraction event bookkeeping (in active-session seconds)
    if (!focused) {
      if (!state.currentDistraction) {
        state.currentDistraction = { reason: reason, startedAt: tActive };
      } else if (state.currentDistraction.reason !== reason) {
        closeDistraction(tActive);
        state.currentDistraction = { reason: reason, startedAt: tActive };
      }
      if (state.distractedSince == null) state.distractedSince = now;
    } else {
      closeDistraction(tActive);
      state.distractedSince = null;
      if (state.widget) state.widget.classList.remove("att-pulse");
    }

    // Gentle nudge after 5s of continuous distraction (max 1 toast / 30s)
    if (state.distractedSince != null && now - state.distractedSince > DISTRACT_TOAST_AFTER_MS) {
      if (state.widget && !state.widget.hidden) state.widget.classList.add("att-pulse");
      if (now - state.lastDistractToastTs > TOAST_COOLDOWN_MS) {
        state.lastDistractToastTs = now;
        showToast("Vous semblez distrait — revenez au cours 👀", 3000);
      }
    }
  }

  function closeDistraction(tActive) {
    if (!state.currentDistraction || !state.session) return;
    var durationSec = Math.round((tActive - state.currentDistraction.startedAt) / 1000);
    state.session.distractionEvents.push({
      t: Math.round(state.currentDistraction.startedAt / 1000),
      reason: state.currentDistraction.reason,
      duration: Math.max(0, durationSec)
    });
    state.currentDistraction = null;
  }

  // ---------------------------------------------------------------------
  // Score sampling (every 5 seconds)
  // ---------------------------------------------------------------------

  function sampleScore() {
    if (!state.session || state.paused) return;
    if (!state.window.length) return;

    var focusedCount = 0;
    for (var i = 0; i < state.window.length; i++) {
      if (state.window[i].focused) focusedCount++;
    }
    var score = Math.round((focusedCount / state.window.length) * 100);
    state.currentScore = score;
    state.session.samples.push({ t: Math.round(activeMs() / 1000), score: score });

    updateWidget(score);

    try {
      document.dispatchEvent(new CustomEvent("nextlearn:focusUpdate", {
        detail: {
          score: score,
          eyesOpen: state.lastChecks.eyesOpen,
          headForward: state.lastChecks.headForward,
          gazeOnScreen: state.lastChecks.gazeOnScreen,
          timestamp: new Date().toISOString()
        }
      }));
    } catch (_e) { /* CustomEvent unsupported — ignore */ }
  }

  // ---------------------------------------------------------------------
  // UI: focus widget + toggle button
  // ---------------------------------------------------------------------

  var RING_CIRC = 2 * Math.PI * 24; // r=24 inside 56px box

  function createWidget() {
    if (state.widget) return;
    var el = document.createElement("div");
    el.className = "att-widget";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Score de concentration");
    el.innerHTML =
      '<svg width="56" height="56" viewBox="0 0 56 56">' +
      '<circle cx="28" cy="28" r="24" fill="none" stroke="#e8e8e6" stroke-width="4"/>' +
      '<circle class="att-ring" cx="28" cy="28" r="24" fill="none" stroke="#1d9e75" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + RING_CIRC + '" stroke-dashoffset="' + RING_CIRC + '"/>' +
      "</svg>" +
      '<span class="att-widget-score">--</span>' +
      '<span class="att-widget-label">Focus</span>' +
      '<button type="button" class="att-widget-close" aria-label="Masquer le widget">✕</button>';
    el.querySelector(".att-widget-close").addEventListener("click", function () {
      el.hidden = true; // hide only — tracking continues
    });
    document.body.appendChild(el);
    state.widget = el;
  }

  function updateWidget(score) {
    if (!state.widget) return;
    var color = score > 70 ? "#1d9e75" : score >= 40 ? "#f59e0b" : "#c41d38";
    var ring = state.widget.querySelector(".att-ring");
    ring.setAttribute("stroke", color);
    ring.setAttribute("stroke-dashoffset", String(RING_CIRC * (1 - score / 100)));
    var scoreEl = state.widget.querySelector(".att-widget-score");
    scoreEl.textContent = String(score);
    scoreEl.style.color = color;
  }

  function createToggle() {
    if (state.toggleBtn) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "att-toggle att-on";
    btn.title = "Suivi d'attention : actif (cliquer pour mettre en pause)";
    btn.setAttribute("aria-pressed", "true");
    btn.innerHTML =
      '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>' +
      '<span class="att-toggle-dot"></span>';
    btn.addEventListener("click", function () {
      setPaused(!state.paused, false);
    });
    document.body.appendChild(btn);
    state.toggleBtn = btn;
  }

  function refreshToggle() {
    if (!state.toggleBtn) return;
    var active = !state.paused;
    state.toggleBtn.classList.toggle("att-on", active);
    state.toggleBtn.setAttribute("aria-pressed", String(active));
    state.toggleBtn.title = active
      ? "Suivi d'attention : actif (cliquer pour mettre en pause)"
      : "Suivi d'attention : en pause (cliquer pour reprendre)";
  }

  // ---------------------------------------------------------------------
  // Pause / resume (user toggle + Page Visibility)
  // ---------------------------------------------------------------------

  function setPaused(paused, fromVisibility) {
    if (!state.session || state.paused === paused) {
      if (fromVisibility && !paused && state.hiddenPaused) state.hiddenPaused = false;
      return;
    }
    // A user pause must not be undone by a tab becoming visible again.
    if (fromVisibility && !paused && !state.hiddenPaused) return;

    state.paused = paused;
    state.hiddenPaused = paused && !!fromVisibility;

    if (paused) {
      // Freeze the active-time clock and close any open distraction cleanly.
      var t = activeMs();
      closeDistraction(t);
      state.session.accumulatedMs = t;
      state.session.runningSince = null;
      state.distractedSince = null;
      state.earLowSince = null;
      if (state.widget) state.widget.classList.remove("att-pulse");
      if (state.camera && typeof state.camera.stop === "function") {
        try { state.camera.stop(); } catch (_e) { /* ignore */ }
      }
    } else {
      state.session.runningSince = Date.now();
      if (state.camera && typeof state.camera.start === "function") {
        try { state.camera.start(); } catch (_e) { /* ignore */ }
      }
    }
    refreshToggle();
  }

  function bindVisibility() {
    if (state.onVisibility) return;
    state.onVisibility = function () {
      if (document.hidden) setPaused(true, true);
      else setPaused(false, true);
    };
    document.addEventListener("visibilitychange", state.onVisibility);
  }

  // ---------------------------------------------------------------------
  // Camera + FaceMesh setup
  // ---------------------------------------------------------------------

  function setupPipeline() {
    if (state.faceMesh) return Promise.resolve();
    return loadMediaPipe().then(function () {
      var faceMesh = new window.FaceMesh({
        locateFile: function (file) { return FACEMESH_ASSET_BASE + file; }
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      faceMesh.onResults(onResults);
      state.faceMesh = faceMesh;

      var video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px;";
      document.body.appendChild(video);
      state.video = video;

      state.camera = new window.Camera(video, {
        onFrame: function () {
          var now = Date.now();
          if (now - state.lastFrameTs < FRAME_INTERVAL_MS) return Promise.resolve();
          state.lastFrameTs = now;
          if (!state.session || state.paused) return Promise.resolve();
          return state.faceMesh.send({ image: video });
        },
        width: 640,
        height: 480
      });
    });
  }

  // ---------------------------------------------------------------------
  // Session summary + upload
  // ---------------------------------------------------------------------

  function buildSummary() {
    var s = state.session;
    var samples = s.samples;
    var avg = samples.length
      ? Math.round(samples.reduce(function (sum, x) { return sum + x.score; }, 0) / samples.length)
      : 0;
    // Each sample is already a 30s-window score, so the worst 30s stretch is the minimum sample.
    var min = samples.length
      ? samples.reduce(function (m, x) { return Math.min(m, x.score); }, 100)
      : 0;
    return {
      identifier: getIdentifier(),
      sessionId: s.sessionId,
      context: s.context,
      moduleId: s.moduleId || "",
      subAcquisId: s.subAcquisId || "",
      duration: Math.round(activeMs() / 1000),
      avgFocusScore: avg,
      minFocusScore: min,
      distractionEvents: s.distractionEvents,
      focusTimeline: samples,
      completedAt: new Date().toISOString()
    };
  }

  function uploadSummary(summary) {
    if (!summary.identifier || summary.duration <= 0) return Promise.resolve(null);
    return fetch("/api/student/attention-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(summary)
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).catch(function () {
      return null; // metrics loss is acceptable; never block the student
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Initializes the tracker: injects styles and binds the Page Visibility
   * listener. Safe to call multiple times. Does NOT touch the camera and
   * shows nothing — permission and consent are only requested by start().
   *
   * @returns {boolean} false when the feature is unavailable (mobile device).
   */
  function init() {
    if (state.initialized) return !state.mobile;
    state.initialized = true;
    state.mobile = isMobileDevice();
    if (state.mobile) return false;
    injectStyles();
    bindVisibility();
    return true;
  }

  /**
   * Starts an attention-tracking session. Runs the consent flow when the
   * student hasn't decided yet; silently does nothing when consent was
   * denied. Loads MediaPipe from CDN and opens the webcam on first use.
   *
   * @param {string} sessionId - caller-chosen unique id for this session.
   * @param {"lesson"|"quiz"} context - what the student is doing.
   * @param {string} [moduleId] - current module id.
   * @param {string} [subAcquisId] - current sous-acquis id.
   * @returns {Promise<boolean>} true when tracking actually started.
   */
  function start(sessionId, context, moduleId, subAcquisId) {
    init();
    if (state.mobile) {
      injectStyles();
      showToast("Fonctionnalité disponible sur ordinateur uniquement", 3500);
      return Promise.resolve(false);
    }
    if (state.session) return Promise.resolve(true); // already tracking

    return ensureConsent().then(function (choice) {
      if (choice !== "granted") return false;

      return setupPipeline()
        .catch(function () {
          showToast("Le module de suivi d'attention n'a pas pu se charger — fonctionnalité désactivée pour cette session", 4500);
          return Promise.reject(new Error("mediapipe-load-failed"));
        })
        .then(function () {
          state.session = {
            sessionId: String(sessionId || "att-" + Date.now()),
            context: context === "quiz" ? "quiz" : "lesson",
            moduleId: moduleId || "",
            subAcquisId: subAcquisId || "",
            samples: [],
            distractionEvents: [],
            accumulatedMs: 0,
            runningSince: Date.now()
          };
          state.window = [];
          state.frameCount = 0;
          state.currentScore = null;
          state.paused = false;
          state.hiddenPaused = false;
          state.lightingWarned = false;
          state.earLowSince = null;
          state.currentDistraction = null;
          state.distractedSince = null;

          return state.camera.start().then(function () {
            createWidget();
            state.widget.hidden = false;
            createToggle();
            refreshToggle();
            state.scoreTimer = setInterval(sampleScore, SCORE_INTERVAL_MS);
            return true;
          }).catch(function (err) {
            state.session = null;
            var denied = err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError" ||
              /permission|denied|dismissed/i.test(String(err && err.message)));
            showToast(denied
              ? "Caméra refusée — autorisez la caméra dans les paramètres du navigateur (icône 🔒 dans la barre d'adresse) pour activer le suivi"
              : "Impossible d'accéder à la caméra — suivi d'attention désactivé", 5000);
            return false;
          });
        })
        .catch(function () { return false; });
    });
  }

  /**
   * Stops the current session, POSTs the summary to the backend, and removes
   * the on-screen widgets. Resolves with the summary that was sent (or null
   * when no session was running).
   *
   * @returns {Promise<object|null>} the session summary.
   */
  function stop() {
    if (!state.session) return Promise.resolve(null);

    // Close any distraction still open at the exact end of the session.
    closeDistraction(activeMs());
    var summary = buildSummary();

    if (state.scoreTimer) { clearInterval(state.scoreTimer); state.scoreTimer = null; }
    if (state.camera && typeof state.camera.stop === "function") {
      try { state.camera.stop(); } catch (_e) { /* ignore */ }
    }
    state.session = null;
    state.window = [];
    state.currentScore = null;
    if (state.widget) { state.widget.remove(); state.widget = null; }
    if (state.toggleBtn) { state.toggleBtn.remove(); state.toggleBtn = null; }

    return uploadSummary(summary).then(function () { return summary; });
  }

  /**
   * @returns {number|null} the current focus score (0-100), or null when not
   * tracking / no sample has been computed yet.
   */
  function getScore() {
    return state.currentScore;
  }

  /**
   * Fully tears the tracker down: stops any active session (posting its
   * summary), releases the camera, removes all DOM nodes and listeners.
   *
   * @returns {Promise<void>}
   */
  function destroy() {
    var done = state.session ? stop() : Promise.resolve(null);
    return done.then(function () {
      if (state.onVisibility) {
        document.removeEventListener("visibilitychange", state.onVisibility);
        state.onVisibility = null;
      }
      if (state.video) { state.video.remove(); state.video = null; }
      if (state.toastEl) { state.toastEl.remove(); state.toastEl = null; }
      if (state.faceMesh && typeof state.faceMesh.close === "function") {
        try { state.faceMesh.close(); } catch (_e) { /* ignore */ }
      }
      state.faceMesh = null;
      state.camera = null;
      state.loadPromise = null;
      state.initialized = false;
    });
  }

  return {
    init: init,
    start: start,
    stop: stop,
    getScore: getScore,
    destroy: destroy
  };
});
