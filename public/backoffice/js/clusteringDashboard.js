/**
 * clusteringDashboard.js
 *
 * Self-contained backoffice dashboard for the student clustering API.
 * Works for both "admin" (all classes) and "enseignant"/"teacher"
 * (assigned classes only) roles, read from
 * `localStorage.nextlearnCurrentTeacher` — the same key and `{ id,
 * fullName|name, role }` shape already used by backoffice.js. Every request
 * carries an `X-Teacher-Id` header (same convention as
 * `/api/backoffice/organization`); class scoping for non-admins happens
 * server-side (`GET /api/backoffice/classes` only returns classes owned by
 * that teacher), so the client never has to be trusted with a class list.
 *
 * Usage (browser, classic script tag):
 *   <script src="/backoffice/js/clusteringDashboard.js"></script>
 *   <script>initClusteringDashboard("clustering-root");</script>
 *
 * Usage (CommonJS):
 *   const initClusteringDashboard = require("./clusteringDashboard.js");
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.initClusteringDashboard = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var STYLE_ID = "cdb-styles";
  var STORAGE_KEY = "nextlearnCurrentTeacher";
  var CLUSTER_COLORS = { A: "#1d9e75", B: "#f59e0b", C: "#c41d38" };
  var CLUSTER_PRIORITY = { A: 0, B: 1, C: 2 };

  // ---------------------------------------------------------------------
  // Auth / current user
  // ---------------------------------------------------------------------

  /** Reads and normalizes the current backoffice user from localStorage. */
  function getCurrentUser() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var id = String(parsed.id || "").trim();
      if (!id) return null;
      return {
        id: id,
        fullName: String(parsed.fullName || parsed.name || "Utilisateur"),
        role: String(parsed.role || "").toLowerCase() === "admin" ? "admin" : "teacher"
      };
    } catch (_error) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // API layer
  // ---------------------------------------------------------------------

  /**
   * fetch() wrapper that attaches the `X-Teacher-Id` header (same
   * convention as the rest of the backoffice) and normalizes errors.
   */
  function apiFetch(url, options) {
    var user = getCurrentUser();
    var opts = options || {};
    var headers = {};
    Object.keys(opts.headers || {}).forEach(function (key) { headers[key] = opts.headers[key]; });
    headers["X-Teacher-Id"] = user ? user.id : "";

    var finalOpts = {};
    Object.keys(opts).forEach(function (key) { finalOpts[key] = opts[key]; });
    finalOpts.headers = headers;

    return fetch(url, finalOpts).then(function (response) {
      return response
        .json()
        .catch(function () { return null; })
        .then(function (payload) {
          if (!response.ok) {
            var message = (payload && payload.message) || ("Erreur " + response.status);
            throw new Error(message);
          }
          return payload;
        });
    });
  }

  function fetchClasses() {
    return apiFetch("/api/backoffice/classes", { method: "GET" }).then(function (data) {
      return data && Array.isArray(data.classes) ? data.classes : [];
    });
  }

  function fetchClustering(classId) {
    return apiFetch("/api/backoffice/clustering/" + encodeURIComponent(classId), { method: "GET" });
  }

  function postRefresh(classId) {
    return apiFetch("/api/backoffice/clustering/" + encodeURIComponent(classId) + "/refresh", { method: "POST" });
  }

  /** Cache-aware clustering fetch; bypasses the in-memory cache when `force` is true. */
  function getClusteringCached(state, classId, force) {
    if (!force && state.cache.has(classId)) return Promise.resolve(state.cache.get(classId));
    return fetchClustering(classId).then(function (data) {
      state.cache.set(classId, data);
      return data;
    });
  }

  // ---------------------------------------------------------------------
  // Small formatting / math helpers
  // ---------------------------------------------------------------------

  function clampNumber(value, min, max, fallback) {
    var num = Number(value);
    if (!isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  }

  function averageOf(list, getter) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    var sum = list.reduce(function (acc, item) {
      var value = getter(item);
      return acc + (isFinite(value) ? value : 0);
    }, 0);
    return sum / list.length;
  }

  function formatPercent(fraction) {
    var value = isFinite(fraction) ? fraction : 0;
    return Math.round(value * 100) + "%";
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function hexToRgba(hex, alpha) {
    var normalized = String(hex || "").replace("#", "");
    if (normalized.length === 3) {
      normalized = normalized.split("").map(function (c) { return c + c; }).join("");
    }
    normalized = (normalized + "000000").slice(0, 6);
    var r = parseInt(normalized.slice(0, 2), 16) || 0;
    var g = parseInt(normalized.slice(2, 4), 16) || 0;
    var b = parseInt(normalized.slice(4, 6), 16) || 0;
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function initialsFromName(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function scoreColorClass(score) {
    if (score > 75) return "cdb-score-good";
    if (score >= 50) return "cdb-score-mid";
    return "cdb-score-bad";
  }

  /**
   * Risk badge for one student.
   *
   * This used to read weakSkillRatio alone. That ratio is 0 for a student who
   * has never taken a quiz — 0 because there is no data, not because they are
   * doing well — so a student who never logged in and never opened a course was
   * labelled "Faible" (low risk). Absence of evidence is not evidence of safety:
   * disengagement is precisely the risk this platform exists to catch.
   *
   * `score` is what the Risque column sorts on, so the students who most need
   * attention sort to the top.
   */
  function riskBadge(features) {
    var f = features || {};
    var weak = clampNumber(f.weakSkillRatio, 0, 1, 0);
    var completion = clampNumber(f.completionRate, 0, 1, 0);
    var logins = clampNumber(f.weeklyLoginFrequency, 0, 7, 0);
    var hasQuiz = clampNumber(f.quizAttemptRate, 0, 10, 0) > 0;

    // No evidence at all: no quiz taken and nothing completed.
    if (!hasQuiz && completion === 0) {
      if (logins < 0.5) {
        // Never (or barely) shows up either — the clearest at-risk signal there is.
        return { label: "Inactif", cls: "cdb-badge-danger", score: 1.5 };
      }
      // Logs in but has produced no work yet: we genuinely cannot judge them.
      return { label: "Sans évaluation", cls: "cdb-badge-neutral", score: 0.45 };
    }

    // Quiz weakness, weighted up when the student is barely progressing or has
    // stopped logging in — good scores mean little once someone stops showing up.
    var score = weak;
    if (completion < 0.2) score += 0.2;
    if (logins < 1) score += 0.2;

    if (score > 0.5) return { label: "Élevé", cls: "cdb-badge-danger", score: score };
    if (score >= 0.25) return { label: "Modéré", cls: "cdb-badge-warn", score: score };
    return { label: "Faible", cls: "cdb-badge-ok", score: score };
  }

  function isCompactView() {
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches;
  }

  function formatTodayLong() {
    try {
      return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
    } catch (_error) {
      return new Date().toLocaleDateString();
    }
  }

  function formatComputedTime(isoString) {
    if (!isoString) return "—";
    var date = new Date(isoString);
    if (isNaN(date.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
    } catch (_error) {
      return date.toLocaleTimeString();
    }
  }

  function niceCeil(value) {
    if (!isFinite(value) || value <= 5) return 5;
    var magnitude = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var residual = value / magnitude;
    var niceResidual;
    if (residual <= 1) niceResidual = 1;
    else if (residual <= 2) niceResidual = 2;
    else if (residual <= 5) niceResidual = 5;
    else niceResidual = 10;
    return niceResidual * magnitude;
  }

  function truncateCanvasText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var truncated = text;
    while (truncated.length > 1 && ctx.measureText(truncated + "…").width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + "…";
  }

  function observeResize(el, callback) {
    if (typeof ResizeObserver === "undefined") {
      var handler = function () { callback(); };
      window.addEventListener("resize", handler);
      return { disconnect: function () { window.removeEventListener("resize", handler); } };
    }
    var ro = new ResizeObserver(function () { callback(); });
    ro.observe(el);
    return ro;
  }

  function sortClustersForDisplay(clusters) {
    return (clusters || []).slice().sort(function (a, b) {
      var pa = CLUSTER_PRIORITY.hasOwnProperty(a.id) ? CLUSTER_PRIORITY[a.id] : 99;
      var pb = CLUSTER_PRIORITY.hasOwnProperty(b.id) ? CLUSTER_PRIORITY[b.id] : 99;
      return pa - pb;
    });
  }

  /** Aggregates a class's clustering response into the numbers the KPI row / admin table need. */
  function computeClassSummary(data) {
    var total = Number(data && data.totalStudents) || 0;
    var byId = { A: null, B: null, C: null };
    (data && data.clusters ? data.clusters : []).forEach(function (c) {
      if (byId.hasOwnProperty(c.id)) byId[c.id] = c;
    });
    var allStudents = (data && data.clusters ? data.clusters : []).reduce(function (acc, c) {
      return acc.concat(c.students || []);
    }, []);
    var avgQuiz = averageOf(allStudents, function (s) { return s.features && s.features.avgQuizScore; });
    return {
      total: total,
      a: byId.A, b: byId.B, c: byId.C,
      pctA: total > 0 && byId.A ? byId.A.studentCount / total : 0,
      pctB: total > 0 && byId.B ? byId.B.studentCount / total : 0,
      pctC: total > 0 && byId.C ? byId.C.studentCount / total : 0,
      avgQuiz: avgQuiz
    };
  }

  function sortStudents(students, key, dir) {
    var list = Array.isArray(students) ? students.slice() : [];
    var factor = dir === "desc" ? -1 : 1;
    list.sort(function (a, b) {
      var valueA = getSortValue(a, key);
      var valueB = getSortValue(b, key);
      if (typeof valueA === "string" || typeof valueB === "string") {
        return String(valueA).localeCompare(String(valueB), "fr", { sensitivity: "base" }) * factor;
      }
      return (valueA - valueB) * factor;
    });
    return list;
  }

  function getSortValue(student, key) {
    if (key === "fullName") return student.fullName || student.identifier || "";
    // Risk is a composite, not a raw feature — sort it by the badge's own score
    // so inactive students rank above merely weak ones.
    if (key === "riskScore") return riskBadge(student.features || {}).score;
    var value = (student.features || {})[key];
    return isFinite(value) ? value : 0;
  }

  // ---------------------------------------------------------------------
  // Styles (injected once) + skeleton / error building blocks
  // ---------------------------------------------------------------------

  /** Loads Space Grotesk + Source Sans 3 from Google Fonts if not already present. */
  function ensureGoogleFonts() {
    if (document.getElementById("cdb-google-fonts")) return;
    var alreadyLoaded = Array.prototype.some.call(
      document.querySelectorAll('link[href*="fonts.googleapis.com"]'),
      function (link) { return /Space\+Grotesk/.test(link.href) && /Source\+Sans\+3/.test(link.href); }
    );
    if (alreadyLoaded) return;

    var pre1 = document.createElement("link");
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    document.head.appendChild(pre1);

    var pre2 = document.createElement("link");
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    document.head.appendChild(pre2);

    var link = document.createElement("link");
    link.id = "cdb-google-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Source+Sans+3:wght@400;600;700&display=swap";
    document.head.appendChild(link);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".cdb-wrap{font-family:'Source Sans 3','Segoe UI',sans-serif;color:#0d1117;background:#f5f5f3;}",
      ".cdb-card{background:#ffffff;border:1px solid #e8e8e6;border-radius:14px;padding:1.35rem 1.5rem;margin-bottom:1rem;transition:box-shadow 200ms ease,transform 200ms ease;}",
      ".cdb-card:hover{box-shadow:0 6px 28px rgba(0,0,0,0.07);transform:translateY(-2px);}",
      ".cdb-card-title{font-family:'Space Grotesk',sans-serif;font-size:1rem;font-weight:700;margin:0 0 .25rem;}",
      ".cdb-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;}",
      ".cdb-title{font-family:'Space Grotesk',sans-serif;font-size:1.4rem;font-weight:700;margin:0 0 .3rem;}",
      ".cdb-subtitle{margin:0;font-size:.85rem;color:#6b7280;}",
      ".cdb-header-actions{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;}",
      ".cdb-badge{border-radius:999px;padding:.2rem .65rem;font-size:.75rem;font-weight:600;display:inline-flex;align-items:center;gap:.3rem;}",
      ".cdb-badge-neutral{background:#f0f0ee;color:#374151;}",
      ".cdb-badge-ok{background:#eafaf3;color:#0f7a55;}",
      ".cdb-badge-warn{background:#fef6e6;color:#9a6400;}",
      ".cdb-badge-danger{background:#fdeceb;color:#a3172b;}",
      ".cdb-refresh-status{font-size:.78rem;color:#6b7280;}",
      ".cdb-btn{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:.85rem;border-radius:999px;padding:.55rem 1.1rem;cursor:pointer;border:1px solid transparent;transition:all 200ms ease;}",
      ".cdb-btn-primary{background:#c41d38;color:#ffffff;}",
      ".cdb-btn-primary:hover{background:#a3172e;}",
      ".cdb-btn-primary:disabled{opacity:.6;cursor:default;}",
      ".cdb-btn-ghost{background:#ffffff;color:#c41d38;border-color:#e8e8e6;text-decoration:none;display:inline-block;}",
      ".cdb-btn-ghost:hover{border-color:#c41d38;background:#fdf2f3;}",
      ".cdb-btn-sm{padding:.35rem .75rem;font-size:.76rem;}",
      ".cdb-pills-scroller{overflow-x:auto;margin-bottom:1rem;}",
      ".cdb-pills{display:inline-flex;gap:.55rem;padding-bottom:.2rem;}",
      ".cdb-pill{white-space:nowrap;border-radius:999px;border:1px solid #e8e8e6;background:#ffffff;padding:.5rem 1rem;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:.82rem;cursor:pointer;transition:all 200ms ease;color:#374151;}",
      ".cdb-pill:hover{border-color:#c41d38;}",
      ".cdb-pill.is-active{background:#c41d38;border-color:#c41d38;color:#ffffff;}",
      ".cdb-pill-count{opacity:.75;margin-left:.3rem;}",
      ".cdb-skel{background:linear-gradient(90deg,#ececeb 25%,#f5f5f4 37%,#ececeb 63%);background-size:400px 100%;animation:cdb-shimmer 1.4s ease-in-out infinite;border-radius:12px;margin-bottom:1rem;}",
      "@keyframes cdb-shimmer{0%{background-position:-400px 0;}100%{background-position:400px 0;}}",
      ".cdb-skel-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;}",
      ".cdb-skel-grid-4 .cdb-skel{margin-bottom:0;}",
      ".cdb-kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1rem;}",
      ".cdb-kpi-card{margin-bottom:0;position:relative;}",
      ".cdb-kpi-label{font-size:.78rem;font-weight:600;color:#6b7280;display:flex;align-items:center;gap:.4rem;margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.04em;}",
      ".cdb-kpi-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}",
      ".cdb-kpi-value{font-family:'Space Grotesk',sans-serif;font-size:1.9rem;font-weight:700;}",
      ".cdb-kpi-sub{font-size:.8rem;color:#6b7280;margin-top:.2rem;}",
      ".cdb-chart-caption{font-size:.82rem;color:#6b7280;margin:0 0 .8rem;}",
      ".cdb-chart-wrapper{position:relative;width:100%;}",
      ".cdb-chart-wrapper canvas{display:block;width:100%;cursor:crosshair;}",
      ".cdb-tooltip{position:fixed;background:#0d1117;color:#ffffff;font-size:.78rem;line-height:1.55;padding:.6rem .75rem;border-radius:10px;pointer-events:none;width:220px;box-shadow:0 10px 26px rgba(0,0,0,.25);z-index:1000;}",
      ".cdb-tooltip strong{display:block;font-family:'Space Grotesk',sans-serif;font-size:.85rem;margin-bottom:.15rem;}",
      ".cdb-tooltip-cluster{display:block;opacity:.75;font-size:.72rem;margin-bottom:.3rem;}",
      ".cdb-tooltip-row{display:block;}",
      ".cdb-legend{display:flex;gap:1.1rem;flex-wrap:wrap;margin-top:1rem;}",
      ".cdb-legend-chip{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;font-weight:600;color:#374151;}",
      ".cdb-legend-dot{width:9px;height:9px;border-radius:50%;display:inline-block;}",
      ".cdb-cluster-section{padding:0;overflow:hidden;}",
      ".cdb-cluster-header{width:100%;display:flex;justify-content:space-between;align-items:center;gap:.6rem;background:none;border:0;border-left:4px solid transparent;padding:1.1rem 1.5rem;cursor:pointer;font-family:inherit;text-align:left;transition:background 200ms ease;}",
      ".cdb-cluster-header:hover{background:#fafaf8;}",
      ".cdb-cluster-title{display:flex;align-items:center;gap:.6rem;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:.95rem;}",
      ".cdb-cluster-dot{width:10px;height:10px;border-radius:50%;display:inline-block;}",
      ".cdb-cluster-count{font-family:'Source Sans 3',sans-serif;font-weight:600;color:#6b7280;font-size:.8rem;}",
      ".cdb-chevron{display:inline-block;transition:transform 200ms ease;color:#6b7280;}",
      ".cdb-chevron.is-open{transform:rotate(180deg);}",
      ".cdb-cluster-body{max-height:0;overflow:hidden;transition:max-height 260ms ease;}",
      ".cdb-cluster-body-inner{padding:0 1.5rem 1.25rem;}",
      ".cdb-table-scroll{overflow-x:auto;}",
      ".cdb-table{width:100%;border-collapse:collapse;font-size:.85rem;}",
      ".cdb-table thead th{text-align:left;background:#f8f8f6;font-family:'Space Grotesk',sans-serif;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;padding:.6rem .7rem;cursor:pointer;user-select:none;white-space:nowrap;transition:color 200ms ease;}",
      ".cdb-table thead th:hover{color:#c41d38;}",
      ".cdb-th-action{cursor:default !important;}",
      ".cdb-table thead th.is-sorted-asc .cdb-sort-arrow::after{content:'\\25B2';}",
      ".cdb-table thead th.is-sorted-desc .cdb-sort-arrow::after{content:'\\25BC';}",
      ".cdb-sort-arrow{display:inline-block;font-size:.6rem;color:#c41d38;margin-left:.3rem;}",
      ".cdb-table tbody td{padding:.65rem .7rem;border-bottom:1px solid #e8e8e6;vertical-align:middle;transition:background 200ms ease;}",
      ".cdb-table tbody tr:hover td{background:#fafaf8;}",
      ".cdb-table tbody tr:last-child td{border-bottom:none;}",
      ".cdb-avatar{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:.68rem;font-weight:700;font-family:'Space Grotesk',sans-serif;margin-right:.55rem;vertical-align:middle;}",
      ".cdb-student-name{font-weight:600;vertical-align:middle;}",
      ".cdb-bar-track{display:inline-block;width:84px;height:6px;background:#e8e8e6;border-radius:999px;overflow:hidden;vertical-align:middle;margin-right:.5rem;}",
      ".cdb-bar-fill{display:block;height:100%;border-radius:999px;}",
      ".cdb-bar-label{font-size:.76rem;color:#6b7280;}",
      ".cdb-score-good{color:#1d9e75;font-weight:700;}",
      ".cdb-score-mid{color:#f59e0b;font-weight:700;}",
      ".cdb-score-bad{color:#c41d38;font-weight:700;}",
      ".cdb-empty-row{text-align:center;color:#9ca3af;padding:1.2rem !important;}",
      ".cdb-empty-state{text-align:center;color:#6b7280;padding:2.5rem 1.5rem;}",
      ".cdb-error-card{text-align:center;padding:2rem 1.5rem;}",
      ".cdb-error-icon{font-size:1.8rem;margin-bottom:.5rem;}",
      ".cdb-error-msg{color:#374151;margin:0 0 1rem;}",
      ".cdb-admin-warning{color:#9a6400;font-size:.82rem;margin:0 0 .8rem;}",
      ".cdb-row-danger td{background:#fff5f5;}",
      "@media (max-width:768px){",
      "  .cdb-kpi-row{grid-template-columns:1fr;}",
      "  .cdb-skel-grid-4{grid-template-columns:1fr;}",
      "  .cdb-card{padding:1rem;}",
      "  .cdb-table-scroll{overflow-x:auto;}",
      "  .cdb-table{min-width:640px;}",
      "}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function skeletonBlock(height) {
    return '<div class="cdb-skel" style="height:' + height + '"></div>';
  }

  function renderFullSkeleton(container) {
    container.innerHTML =
      '<div class="cdb-wrap">' +
      skeletonBlock("64px") +
      skeletonBlock("44px") +
      '<div class="cdb-skel-grid-4">' + [0, 1, 2, 3].map(function () { return skeletonBlock("92px"); }).join("") + "</div>" +
      skeletonBlock("360px") +
      skeletonBlock("200px") +
      skeletonBlock("200px") +
      skeletonBlock("200px") +
      "</div>";
  }

  function renderClassViewSkeleton(state) {
    state.classViewEl.innerHTML =
      '<div class="cdb-skel-grid-4">' + [0, 1, 2, 3].map(function () { return skeletonBlock("92px"); }).join("") + "</div>" +
      skeletonBlock("360px") +
      skeletonBlock("200px") +
      skeletonBlock("200px") +
      skeletonBlock("200px");
  }

  function renderAdminSkeleton(container) {
    container.innerHTML =
      '<div class="cdb-card"><h3 class="cdb-card-title">Vue globale — Toutes les classes</h3>' +
      skeletonBlock("300px") + skeletonBlock("220px") + "</div>";
  }

  /** Renders a retry-able error card into `targetEl`, replacing its content. */
  function renderErrorCard(targetEl, message, onRetry) {
    targetEl.innerHTML =
      '<div class="cdb-card cdb-error-card">' +
      '<div class="cdb-error-icon">⚠️</div>' +
      '<p class="cdb-error-msg">' + escapeHtml(message || "Une erreur est survenue.") + "</p>" +
      '<button type="button" class="cdb-btn cdb-btn-primary cdb-retry-btn">Réessayer</button>' +
      "</div>";
    var btn = targetEl.querySelector(".cdb-retry-btn");
    if (btn) btn.addEventListener("click", onRetry);
  }

  return initAndBuild();

  // -----------------------------------------------------------------------
  // Everything below is defined inside this helper so `initClusteringDashboard`
  // (returned at the end) closes over all the render/interaction functions.
  // -----------------------------------------------------------------------
  function initAndBuild() {
    return initClusteringDashboard;

    /**
     * Renders the full clustering dashboard (header, class selector, KPIs,
     * scatter plot, sortable tables, and — for admins — the cross-class
     * overview) inside the element identified by `containerId`.
     *
     * @param {string} containerId - id of an existing container element.
     * @returns {Promise<void>} resolves once the initial render has settled.
     */
    async function initClusteringDashboard(containerId) {
      var container = document.getElementById(containerId);
      if (!container) {
        console.error('initClusteringDashboard: no element found with id "' + containerId + '"');
        return;
      }

      injectStyles();
      ensureGoogleFonts();

      var user = getCurrentUser();
      if (!user) {
        renderErrorCard(container, "Session introuvable. Merci de vous reconnecter.", function () {
          initClusteringDashboard(containerId);
        });
        return;
      }

      var state = {
        uid: containerId,
        container: container,
        user: user,
        classes: [],
        activeClassId: null,
        currentData: null,
        cache: new Map(),
        scatterResizeObserver: null,
        adminResizeObserver: null,
        tooltipEl: null,
        classViewEl: null,
        pillsEl: null,
        adminEl: null
      };

      renderFullSkeleton(container);

      // The server already scopes this list to the caller's classes (via the
      // X-Teacher-Id header), so no client-side filtering is needed here.
      try {
        state.classes = await fetchClasses();
      } catch (error) {
        console.error("Failed to load classes:", error);
        renderErrorCard(container, error && error.message ? error.message : "Impossible de charger les classes.", function () {
          initClusteringDashboard(containerId);
        });
        return;
      }

      if (state.classes.length === 0) {
        container.innerHTML =
          '<div class="cdb-wrap">' + renderHeaderHTML(state) +
          '<div class="cdb-card cdb-empty-state">' +
          (user.role === "admin" ? "Aucune classe n'a encore été créée." : "Aucune classe ne vous est assignée pour le moment.") +
          "</div></div>";
        return;
      }

      buildShell(state);
      renderPills(state);

      var firstClassId = state.classes[0].id;
      await selectClass(state, firstClassId);

      if (user.role === "admin") {
        loadAdminOverview(state, false);
      }
    }

    // ---------------------------------------------------------------------
    // Shell / header / pills
    // ---------------------------------------------------------------------

    function renderHeaderHTML(state) {
      var user = state.user;
      var count = state.classes.length;
      var badgeText = user.role === "admin"
        ? "Tous les étudiants — " + count + " classe" + (count > 1 ? "s" : "")
        : "Vos classes — " + count + " classe" + (count > 1 ? "s" : "") + " assignée" + (count > 1 ? "s" : "");

      return (
        '<div class="cdb-header">' +
        "<div>" +
        '<h2 class="cdb-title">Analyse des profils d’apprentissage</h2>' +
        '<p class="cdb-subtitle" id="' + state.uid + '-cdb-subtitle">' + formatTodayLong() + " · Dernier calcul : —</p>" +
        "</div>" +
        '<div class="cdb-header-actions">' +
        '<span class="cdb-badge cdb-badge-neutral">' + escapeHtml(badgeText) + "</span>" +
        '<button type="button" class="cdb-btn cdb-btn-primary" id="' + state.uid + '-cdb-refresh-btn">Rafraîchir</button>' +
        '<span class="cdb-refresh-status" id="' + state.uid + '-cdb-refresh-status"></span>' +
        "</div></div>"
      );
    }

    function buildShell(state) {
      state.container.innerHTML =
        '<div class="cdb-wrap">' +
        renderHeaderHTML(state) +
        '<div class="cdb-pills-scroller"><div class="cdb-pills" id="' + state.uid + '-cdb-pills"></div></div>' +
        '<div id="' + state.uid + '-cdb-class-view" class="cdb-class-view"></div>' +
        '<div id="' + state.uid + '-cdb-admin" class="cdb-admin-section" hidden></div>' +
        "</div>";

      state.classViewEl = document.getElementById(state.uid + "-cdb-class-view");
      state.pillsEl = document.getElementById(state.uid + "-cdb-pills");
      state.adminEl = document.getElementById(state.uid + "-cdb-admin");

      var existingTooltip = document.getElementById(state.uid + "-cdb-tooltip");
      if (existingTooltip) existingTooltip.remove();
      state.tooltipEl = document.createElement("div");
      state.tooltipEl.id = state.uid + "-cdb-tooltip";
      state.tooltipEl.className = "cdb-tooltip";
      state.tooltipEl.hidden = true;
      document.body.appendChild(state.tooltipEl);

      var refreshBtn = document.getElementById(state.uid + "-cdb-refresh-btn");
      if (refreshBtn) refreshBtn.addEventListener("click", function () { handleRefreshClick(state); });
    }

    function renderPills(state) {
      state.pillsEl.innerHTML = state.classes.map(function (cls) {
        return (
          '<button type="button" class="cdb-pill" data-class-id="' + escapeAttr(cls.id) + '">' +
          escapeHtml(cls.name) + ' <span class="cdb-pill-count">' + (Number(cls.studentCount) || 0) + "</span>" +
          "</button>"
        );
      }).join("");

      Array.prototype.forEach.call(state.pillsEl.querySelectorAll(".cdb-pill"), function (pill) {
        pill.addEventListener("click", function () { selectClass(state, pill.dataset.classId); });
      });
    }

    function highlightActivePill(state, classId) {
      Array.prototype.forEach.call(state.pillsEl.querySelectorAll(".cdb-pill"), function (pill) {
        pill.classList.toggle("is-active", pill.dataset.classId === String(classId));
      });
    }

    function updateHeaderMeta(state, data) {
      var subtitleEl = document.getElementById(state.uid + "-cdb-subtitle");
      if (subtitleEl) {
        subtitleEl.textContent = formatTodayLong() + " · Dernier calcul : " + formatComputedTime(data && data.metadata && data.metadata.computedAt);
      }
    }

    // ---------------------------------------------------------------------
    // Class selection (sections 3 + 4 + 5)
    // ---------------------------------------------------------------------

    /** Loads (or reuses cached) clustering data for a class and renders sections 3-5. */
    async function selectClass(state, classId) {
      state.activeClassId = classId;
      highlightActivePill(state, classId);
      renderClassViewSkeleton(state);
      try {
        var data = await getClusteringCached(state, classId, false);
        state.currentData = data;
        renderClassView(state, data);
        updateHeaderMeta(state, data);
      } catch (error) {
        console.error("Failed to load clustering for class", classId, error);
        renderErrorCard(
          state.classViewEl,
          error && error.message ? error.message : "Impossible de charger les données de cette classe.",
          function () { selectClass(state, classId); }
        );
      }
    }

    function renderClassView(state, data) {
      var summary = computeClassSummary(data);
      state.classViewEl.innerHTML =
        renderKPIRowHTML(summary) +
        renderChartSectionHTML(state.uid) +
        renderTablesSectionHTML(state.uid, data);

      var canvas = document.getElementById(state.uid + "-cdb-canvas");
      var chartWrapper = document.getElementById(state.uid + "-cdb-chart-wrapper");

      if (canvas) {
        drawScatter(canvas, data);
        setupScatterInteractivity(canvas, state.tooltipEl);
      }

      if (state.scatterResizeObserver) state.scatterResizeObserver.disconnect();
      if (chartWrapper && canvas) {
        state.scatterResizeObserver = observeResize(chartWrapper, function () { drawScatter(canvas, data); });
      }

      setupClusterSections(state.uid, data);
    }

    function renderKPIRowHTML(summary) {
      var cards = [
        { label: "Total étudiants", value: summary.total, sub: "dans cette classe", tint: false, color: null },
        { label: "Avancés", value: summary.a ? summary.a.studentCount : 0, sub: formatPercent(summary.pctA), tint: false, color: CLUSTER_COLORS.A },
        { label: "En progression", value: summary.b ? summary.b.studentCount : 0, sub: formatPercent(summary.pctB), tint: false, color: CLUSTER_COLORS.B },
        { label: "En difficulté", value: summary.c ? summary.c.studentCount : 0, sub: formatPercent(summary.pctC), tint: !!(summary.c && summary.c.studentCount > 0), color: CLUSTER_COLORS.C }
      ];
      return (
        '<div class="cdb-kpi-row">' +
        cards.map(function (card) {
          return (
            '<div class="cdb-card cdb-kpi-card"' + (card.tint ? ' style="background:#fff5f5;"' : "") + ">" +
            '<div class="cdb-kpi-label">' + escapeHtml(card.label) +
            (card.color ? '<span class="cdb-kpi-dot" style="background:' + card.color + '"></span>' : "") +
            "</div>" +
            '<div class="cdb-kpi-value">' + card.value + "</div>" +
            '<div class="cdb-kpi-sub">' + escapeHtml(String(card.sub)) + "</div>" +
            "</div>"
          );
        }).join("") +
        "</div>"
      );
    }

    function renderChartSectionHTML(uid) {
      return (
        '<div class="cdb-card cdb-chart-card">' +
        '<h3 class="cdb-card-title">Répartition des étudiants</h3>' +
        '<p class="cdb-chart-caption">Axe horizontal : score moyen aux quiz — axe vertical : taux de complétion</p>' +
        '<div class="cdb-chart-wrapper" id="' + uid + '-cdb-chart-wrapper"><canvas id="' + uid + '-cdb-canvas"></canvas></div>' +
        '<div class="cdb-legend">' +
        legendChip("Avancés", CLUSTER_COLORS.A) + legendChip("En progression", CLUSTER_COLORS.B) + legendChip("En difficulté", CLUSTER_COLORS.C) +
        "</div></div>"
      );
    }

    function legendChip(label, color) {
      return '<span class="cdb-legend-chip"><span class="cdb-legend-dot" style="background:' + color + '"></span>' + escapeHtml(label) + "</span>";
    }

    function renderTablesSectionHTML(uid, data) {
      var clusters = sortClustersForDisplay(data.clusters);
      var defaultExpandedId = clusters.some(function (c) { return c.id === "C"; }) ? "C" : (clusters[0] && clusters[0].id);
      return clusters.map(function (cluster) {
        return renderClusterSectionHTML(uid, cluster, cluster.id === defaultExpandedId);
      }).join("");
    }

    function renderClusterSectionHTML(uid, cluster, expanded) {
      var sectionId = uid + "-cdb-cluster-" + cluster.id;
      var count = Number(cluster.studentCount) || 0;
      return (
        '<div class="cdb-card cdb-cluster-section">' +
        '<button type="button" class="cdb-cluster-header" id="' + sectionId + '-header" style="border-left-color:' + escapeAttr(cluster.color) + '">' +
        '<span class="cdb-cluster-title"><span class="cdb-cluster-dot" style="background:' + escapeAttr(cluster.color) + '"></span>' +
        escapeHtml(cluster.label) + '<span class="cdb-cluster-count">' + count + " étudiant" + (count > 1 ? "s" : "") + "</span></span>" +
        '<span class="cdb-chevron' + (expanded ? " is-open" : "") + '" id="' + sectionId + '-chevron">▾</span>' +
        "</button>" +
        '<div class="cdb-cluster-body' + (expanded ? " is-open" : "") + '" id="' + sectionId + '-body" data-expanded="' + (expanded ? "1" : "0") + '">' +
        '<div class="cdb-cluster-body-inner"><div class="cdb-table-scroll">' +
        '<table class="cdb-table" id="' + sectionId + '-table" data-sort-key="fullName" data-sort-dir="asc"><thead><tr>' +
        '<th data-key="fullName">Étudiant<span class="cdb-sort-arrow"></span></th>' +
        '<th data-key="completionRate">Complétion<span class="cdb-sort-arrow"></span></th>' +
        '<th data-key="avgQuizScore">Score quiz moyen<span class="cdb-sort-arrow"></span></th>' +
        '<th data-key="weeklyLoginFrequency">Connexions/semaine<span class="cdb-sort-arrow"></span></th>' +
        '<th data-key="weakSkillRatio">Compétences faibles<span class="cdb-sort-arrow"></span></th>' +
        '<th data-key="riskScore">Risque<span class="cdb-sort-arrow"></span></th>' +
        '<th class="cdb-th-action">Action</th>' +
        "</tr></thead><tbody>" + renderStudentRows(cluster, "fullName", "asc") + "</tbody></table>" +
        "</div></div></div></div>"
      );
    }

    function renderStudentRows(cluster, sortKey, sortDir) {
      var sorted = sortStudents(cluster.students, sortKey, sortDir);
      if (sorted.length === 0) {
        return '<tr><td colspan="7" class="cdb-empty-row">Aucun étudiant dans ce groupe</td></tr>';
      }
      return sorted.map(function (student) {
        var f = student.features || {};
        var completion = clampNumber(f.completionRate, 0, 1, 0);
        var quiz = clampNumber(f.avgQuizScore, 0, 100, 0);
        var logins = clampNumber(f.weeklyLoginFrequency, 0, 7, 0);
        var weak = clampNumber(f.weakSkillRatio, 0, 1, 0);
        var risk = riskBadge(f);
        var initials = initialsFromName(student.fullName || student.identifier);
        var name = student.fullName || student.identifier || "—";
        return (
          "<tr>" +
          '<td><span class="cdb-avatar" style="background:' + hexToRgba(cluster.color, 0.14) + ";color:" + escapeAttr(cluster.color) + '">' + escapeHtml(initials) + "</span>" +
          '<span class="cdb-student-name">' + escapeHtml(name) + "</span></td>" +
          '<td><span class="cdb-bar-track"><span class="cdb-bar-fill" style="width:' + Math.round(completion * 100) + "%;background:" + escapeAttr(cluster.color) + '"></span></span>' +
          '<span class="cdb-bar-label">' + Math.round(completion * 100) + "%</span></td>" +
          '<td class="' + scoreColorClass(quiz) + '">' + Math.round(quiz) + "%</td>" +
          "<td>" + logins.toFixed(1) + "</td>" +
          "<td>" + Math.round(weak * 100) + "%</td>" +
          '<td><span class="cdb-badge ' + risk.cls + '">' + escapeHtml(risk.label) + "</span></td>" +
          '<td><a class="cdb-btn cdb-btn-ghost cdb-btn-sm" href="/backoffice/student-profile.html?id=' + encodeURIComponent(student.identifier) + '">Voir le profil</a></td>' +
          "</tr>"
        );
      }).join("");
    }

    function setupClusterSections(uid, data) {
      var clusters = sortClustersForDisplay(data.clusters);
      clusters.forEach(function (cluster) {
        var sectionId = uid + "-cdb-cluster-" + cluster.id;
        var headerBtn = document.getElementById(sectionId + "-header");
        var bodyEl = document.getElementById(sectionId + "-body");
        var chevron = document.getElementById(sectionId + "-chevron");
        var tableEl = document.getElementById(sectionId + "-table");

        if (bodyEl) {
          bodyEl.style.maxHeight = bodyEl.dataset.expanded === "1" ? bodyEl.scrollHeight + "px" : "0px";
        }

        if (headerBtn && bodyEl && chevron) {
          headerBtn.addEventListener("click", function () {
            var isOpen = bodyEl.classList.contains("is-open");
            if (isOpen) {
              bodyEl.style.maxHeight = "0px";
              bodyEl.classList.remove("is-open");
              chevron.classList.remove("is-open");
            } else {
              bodyEl.classList.add("is-open");
              chevron.classList.add("is-open");
              bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
            }
          });
        }

        if (tableEl) attachSortHandlers(tableEl, cluster, bodyEl);
      });
    }

    function attachSortHandlers(tableEl, cluster, bodyEl) {
      var headers = Array.prototype.slice.call(tableEl.querySelectorAll("thead th[data-key]"));
      var tbody = tableEl.querySelector("tbody");
      headers.forEach(function (th) {
        th.addEventListener("click", function () {
          var key = th.dataset.key;
          var currentKey = tableEl.dataset.sortKey;
          var currentDir = tableEl.dataset.sortDir;
          var nextDir = currentKey === key && currentDir === "asc" ? "desc" : "asc";
          tableEl.dataset.sortKey = key;
          tableEl.dataset.sortDir = nextDir;
          headers.forEach(function (h) { h.classList.remove("is-sorted-asc", "is-sorted-desc"); });
          th.classList.add(nextDir === "asc" ? "is-sorted-asc" : "is-sorted-desc");
          tbody.innerHTML = renderStudentRows(cluster, key, nextDir);
          if (bodyEl && bodyEl.classList.contains("is-open")) {
            bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
          }
        });
      });
    }

    // ---------------------------------------------------------------------
    // Scatter plot (pure canvas)
    // ---------------------------------------------------------------------

    function drawScatter(canvas, data) {
      var dpr = window.devicePixelRatio || 1;
      var cssWidth = (canvas.parentElement && canvas.parentElement.clientWidth) || canvas.clientWidth || 600;
      var cssHeight = 320;
      canvas.style.width = "100%";
      canvas.style.height = cssHeight + "px";
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));

      var ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      var compact = isCompactView();
      var padL = compact ? 20 : 46;
      var padR = 16;
      var padT = 16;
      var padB = compact ? 20 : 42;
      var plotW = Math.max(1, cssWidth - padL - padR);
      var plotH = Math.max(1, cssHeight - padT - padB);

      var points = [];
      (data.clusters || []).forEach(function (cluster) {
        (cluster.students || []).forEach(function (student) {
          var f = student.features || {};
          points.push({
            x: clampNumber(f.avgQuizScore, 0, 100, 0),
            y: clampNumber(f.completionRate, 0, 1, 0),
            color: cluster.color,
            clusterLabel: cluster.label,
            student: student
          });
        });
      });

      function toPixels(point) {
        return { px: padL + (point.x / 100) * plotW, py: padT + plotH - point.y * plotH };
      }

      ctx.lineWidth = 1;
      for (var i = 0; i <= 4; i++) {
        var frac = i / 4;
        var y = padT + plotH - frac * plotH;
        ctx.strokeStyle = "#e8e8e6";
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        if (!compact) {
          ctx.fillStyle = "#6b7280";
          ctx.font = "600 10.5px 'Source Sans 3', sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(Math.round(frac * 100) + "%", padL - 8, y);
        }
      }
      for (var j = 0; j <= 4; j++) {
        var xFrac = j / 4;
        var x = padL + xFrac * plotW;
        ctx.strokeStyle = "#f0f0ee";
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        if (!compact) {
          ctx.fillStyle = "#6b7280";
          ctx.font = "600 10.5px 'Source Sans 3', sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(String(Math.round(xFrac * 100)), x, padT + plotH + 8);
        }
      }

      if (!compact) {
        ctx.fillStyle = "#0d1117";
        ctx.font = "700 11px 'Space Grotesk', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("Score moyen aux quiz (%)", padL + plotW / 2, cssHeight - 2);

        ctx.save();
        ctx.translate(12, padT + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText("Taux de complétion (%)", 0, 0);
        ctx.restore();
      }

      points.forEach(function (point) {
        var pos = toPixels(point);
        ctx.beginPath();
        ctx.arc(pos.px, pos.py, 7, 0, Math.PI * 2);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = point.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      });

      canvas.__cdbPoints = points;
      canvas.__cdbToPixels = toPixels;
    }

    function setupScatterInteractivity(canvas, tooltipEl) {
      var TOOLTIP_WIDTH = 220;

      canvas.addEventListener("mousemove", function (event) {
        var points = canvas.__cdbPoints || [];
        var toPixels = canvas.__cdbToPixels;
        if (!toPixels) return;

        var rect = canvas.getBoundingClientRect();
        var mouseX = event.clientX - rect.left;
        var mouseY = event.clientY - rect.top;

        var nearest = null;
        var nearestDistance = Infinity;
        points.forEach(function (point) {
          var pos = toPixels(point);
          var distance = Math.hypot(pos.px - mouseX, pos.py - mouseY);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = point;
          }
        });

        if (!nearest || nearestDistance > 14) {
          tooltipEl.hidden = true;
          return;
        }

        var s = nearest.student;
        var f = s.features || {};
        var risk = riskBadge(f);

        tooltipEl.hidden = false;
        tooltipEl.innerHTML =
          "<strong>" + escapeHtml(s.fullName || s.identifier || "Étudiant") + "</strong>" +
          '<span class="cdb-tooltip-cluster">' + escapeHtml(nearest.clusterLabel) + "</span>" +
          '<span class="cdb-tooltip-row">Score quiz : ' + Math.round(clampNumber(f.avgQuizScore, 0, 100, 0)) + "%</span>" +
          '<span class="cdb-tooltip-row">Complétion : ' + Math.round(clampNumber(f.completionRate, 0, 1, 0) * 100) + "%</span>" +
          '<span class="cdb-tooltip-row">Connexions/sem. : ' + clampNumber(f.weeklyLoginFrequency, 0, 7, 0).toFixed(1) + "</span>" +
          '<span class="cdb-tooltip-row">Risque : ' + escapeHtml(risk.label) + "</span>";

        var flipLeft = event.clientX > rect.right - TOOLTIP_WIDTH - 20;
        tooltipEl.style.left = (flipLeft ? event.clientX - TOOLTIP_WIDTH - 14 : event.clientX + 14) + "px";
        tooltipEl.style.top = event.clientY + 14 + "px";
      });

      canvas.addEventListener("mouseleave", function () { tooltipEl.hidden = true; });
    }

    // ---------------------------------------------------------------------
    // Refresh button
    // ---------------------------------------------------------------------

    /** Refreshes every visible class in parallel via POST .../refresh, then re-renders from the fresh data. */
    async function handleRefreshClick(state) {
      var btn = document.getElementById(state.uid + "-cdb-refresh-btn");
      var statusEl = document.getElementById(state.uid + "-cdb-refresh-status");
      if (btn) { btn.disabled = true; btn.textContent = "Rafraîchissement…"; }
      if (statusEl) statusEl.textContent = "";

      var results = await Promise.all(state.classes.map(function (cls) {
        return postRefresh(cls.id)
          .then(function (data) { return { classId: cls.id, ok: true, data: data }; })
          .catch(function (error) { return { classId: cls.id, ok: false, error: error }; });
      }));

      var failCount = 0;
      results.forEach(function (result) {
        if (result.ok) state.cache.set(result.classId, result.data);
        else failCount++;
      });

      if (btn) { btn.disabled = false; btn.textContent = "Rafraîchir"; }
      if (statusEl) {
        statusEl.textContent = failCount > 0 ? failCount + " classe(s) non rafraîchie(s)" : "Données à jour";
        setTimeout(function () { if (statusEl) statusEl.textContent = ""; }, 4000);
      }

      if (state.activeClassId && state.cache.has(state.activeClassId)) {
        var data = state.cache.get(state.activeClassId);
        state.currentData = data;
        renderClassView(state, data);
        updateHeaderMeta(state, data);
      }

      if (state.user.role === "admin") {
        await loadAdminOverview(state, true);
      }
    }

    // ---------------------------------------------------------------------
    // Section 6 — admin cross-class overview
    // ---------------------------------------------------------------------

    /** Fetches (or reuses cached) clustering for every visible class and renders the cross-class overview. */
    async function loadAdminOverview(state, useCacheOnly) {
      if (!state.adminEl) return;
      state.adminEl.hidden = false;
      if (!useCacheOnly) renderAdminSkeleton(state.adminEl);

      try {
        var results = await Promise.all(state.classes.map(function (cls) {
          if (useCacheOnly && state.cache.has(cls.id)) {
            return Promise.resolve({ classId: cls.id, className: cls.name, ok: true, data: state.cache.get(cls.id) });
          }
          return getClusteringCached(state, cls.id, false)
            .then(function (data) { return { classId: cls.id, className: cls.name, ok: true, data: data }; })
            .catch(function (error) { return { classId: cls.id, className: cls.name, ok: false, error: error }; });
        }));

        renderAdminOverview(state, results);
      } catch (error) {
        console.error("Failed to load admin overview:", error);
        renderErrorCard(state.adminEl, "Impossible de charger la vue globale.", function () { loadAdminOverview(state, false); });
      }
    }

    function renderAdminOverview(state, results) {
      var successful = results.filter(function (r) { return r.ok; });
      var failed = results.filter(function (r) { return !r.ok; });

      state.adminEl.innerHTML =
        '<div class="cdb-card">' +
        '<h3 class="cdb-card-title">Vue globale — Toutes les classes</h3>' +
        (failed.length > 0 ? '<p class="cdb-admin-warning">⚠️ ' + failed.length + " classe(s) n'ont pas pu être chargées.</p>" : "") +
        '<div class="cdb-chart-wrapper" id="' + state.uid + '-cdb-admin-chart-wrapper"><canvas id="' + state.uid + '-cdb-admin-canvas"></canvas></div>' +
        '<div class="cdb-legend">' +
        legendChip("Avancés", CLUSTER_COLORS.A) + legendChip("En progression", CLUSTER_COLORS.B) + legendChip("En difficulté", CLUSTER_COLORS.C) +
        "</div>" +
        '<div class="cdb-table-scroll"><table class="cdb-table"><thead><tr>' +
        "<th>Classe</th><th>Total</th><th>% Avancés</th><th>% En progression</th><th>% En difficulté</th><th>Score quiz moy.</th><th>Action</th>" +
        "</tr></thead><tbody>" +
        successful.map(function (r) { return renderAdminSummaryRow(r); }).join("") +
        "</tbody></table></div></div>";

      var canvas = document.getElementById(state.uid + "-cdb-admin-canvas");
      var wrapper = document.getElementById(state.uid + "-cdb-admin-chart-wrapper");
      if (canvas) drawGroupedBarChart(canvas, successful);

      if (state.adminResizeObserver) state.adminResizeObserver.disconnect();
      if (canvas && wrapper) {
        state.adminResizeObserver = observeResize(wrapper, function () { drawGroupedBarChart(canvas, successful); });
      }

      Array.prototype.forEach.call(state.adminEl.querySelectorAll(".cdb-view-details-btn"), function (btn) {
        btn.addEventListener("click", function () {
          selectClass(state, btn.dataset.classId);
          if (state.pillsEl) state.pillsEl.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      });
    }

    function renderAdminSummaryRow(result) {
      var summary = computeClassSummary(result.data);
      var dangerRow = summary.pctC > 0.4;
      return (
        '<tr class="' + (dangerRow ? "cdb-row-danger" : "") + '">' +
        "<td>" + escapeHtml(result.className) + "</td>" +
        "<td>" + summary.total + "</td>" +
        "<td>" + formatPercent(summary.pctA) + "</td>" +
        "<td>" + formatPercent(summary.pctB) + "</td>" +
        "<td>" + (dangerRow ? "⚠️ " : "") + formatPercent(summary.pctC) + "</td>" +
        '<td class="' + scoreColorClass(summary.avgQuiz) + '">' + Math.round(summary.avgQuiz) + "%</td>" +
        '<td><button type="button" class="cdb-btn cdb-btn-ghost cdb-btn-sm cdb-view-details-btn" data-class-id="' + escapeAttr(result.classId) + '">Voir détails</button></td>' +
        "</tr>"
      );
    }

    function drawGroupedBarChart(canvas, results) {
      var dpr = window.devicePixelRatio || 1;
      var cssWidth = (canvas.parentElement && canvas.parentElement.clientWidth) || canvas.clientWidth || 600;
      var cssHeight = 320;
      canvas.style.width = "100%";
      canvas.style.height = cssHeight + "px";
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));

      var ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (results.length === 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "600 13px 'Source Sans 3', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Aucune donnée disponible", cssWidth / 2, cssHeight / 2);
        return;
      }

      var compact = isCompactView();
      var padL = compact ? 24 : 46;
      var padR = 16;
      var padT = 16;
      var padB = compact ? 24 : 44;
      var plotW = Math.max(1, cssWidth - padL - padR);
      var plotH = Math.max(1, cssHeight - padT - padB);

      var groups = results.map(function (r) {
        var byId = { A: 0, B: 0, C: 0 };
        (r.data.clusters || []).forEach(function (c) { if (byId.hasOwnProperty(c.id)) byId[c.id] = c.studentCount; });
        return { className: r.className, counts: byId };
      });

      var allCounts = [];
      groups.forEach(function (g) { allCounts.push(g.counts.A, g.counts.B, g.counts.C); });
      var maxCount = niceCeil(Math.max.apply(null, [1].concat(allCounts)));

      ctx.lineWidth = 1;
      var steps = 4;
      for (var i = 0; i <= steps; i++) {
        var frac = i / steps;
        var y = padT + plotH - frac * plotH;
        ctx.strokeStyle = "#e8e8e6";
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        if (!compact) {
          ctx.fillStyle = "#6b7280";
          ctx.font = "600 10.5px 'Source Sans 3', sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(String(Math.round(frac * maxCount)), padL - 8, y);
        }
      }

      var groupWidth = plotW / groups.length;
      var barGap = 4;
      var groupPadding = groupWidth * 0.18;
      var barWidth = Math.max(2, (groupWidth - groupPadding * 2 - barGap * 2) / 3);
      var order = ["A", "B", "C"];

      groups.forEach(function (group, index) {
        var groupX = padL + index * groupWidth + groupPadding;
        order.forEach(function (id, barIndex) {
          var count = group.counts[id];
          var barHeight = (count / maxCount) * plotH;
          var x = groupX + barIndex * (barWidth + barGap);
          var y = padT + plotH - barHeight;
          ctx.fillStyle = CLUSTER_COLORS[id];
          ctx.fillRect(x, y, barWidth, Math.max(0, barHeight));
        });

        if (!compact) {
          var labelX = padL + index * groupWidth + groupWidth / 2;
          ctx.fillStyle = "#374151";
          ctx.font = "600 10.5px 'Source Sans 3', sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          var label = truncateCanvasText(ctx, group.className, groupWidth - 4);
          ctx.fillText(label, labelX, padT + plotH + 8);
        }
      });
    }
  }
});
