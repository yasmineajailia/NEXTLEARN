/**
 * attentionDashboard.js
 *
 * Self-contained backoffice visualization for the attention-tracking API
 * (GET /api/backoffice/attention/:classId). Renders a KPI row, a sortable
 * student table with canvas mini progress rings, a slide-in detail panel
 * (focus timeline line chart + distraction pie chart + session history) and
 * a class heatmap of the last 10 sessions per student.
 *
 * Usage (browser):
 *   <script src="/backoffice/js/attentionDashboard.js"></script>
 *   <script>renderAttentionDashboard("attention-root", classId);</script>
 *
 * Usage (CommonJS):
 *   const renderAttentionDashboard = require("./attentionDashboard.js");
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.renderAttentionDashboard = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var STYLE_ID = "adb-styles";
  var STORAGE_KEY = "nextlearnCurrentTeacher";

  var COLORS = {
    good: "#1d9e75",
    mid: "#f59e0b",
    bad: "#c41d38",
    ink: "#0d1117",
    muted: "#6b7280",
    line: "#e8e8e6",
    lesson: "#3266ad",
    quiz: "#c41d38"
  };

  var REASON_LABELS = {
    eyes_closed: "Yeux fermés",
    head_turned: "Tête tournée",
    gaze_away: "Regard ailleurs",
    no_face: "Absent de l'écran"
  };
  var REASON_COLORS = {
    eyes_closed: "#7f77dd",
    head_turned: "#f59e0b",
    gaze_away: "#3266ad",
    no_face: "#c41d38"
  };

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function getTeacherId() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return raw ? String(raw.id || raw._id || "") : "";
    } catch (_e) {
      return "";
    }
  }

  function scoreColor(score) {
    if (score == null) return "#c7ccd4";
    if (score > 70) return COLORS.good;
    if (score >= 40) return COLORS.mid;
    return COLORS.bad;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) +
      " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  function reasonLabel(reason) {
    return REASON_LABELS[reason] || (reason ? String(reason) : "—");
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = "" +
      ".adb{font-family:'Source Sans 3','Segoe UI',sans-serif;color:#0d1117;background:#f5f5f3;border-radius:14px;padding:1.1rem;}" +
      ".adb h3,.adb h4{font-family:'Space Grotesk',sans-serif;margin:0;}" +
      ".adb-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem;margin-bottom:1rem;}" +
      ".adb-kpi{background:#fff;border:1px solid #e8e8e6;border-radius:14px;padding:.85rem 1rem;}" +
      ".adb-kpi p{margin:0;font-size:.68rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7280;}" +
      ".adb-kpi strong{display:block;margin-top:.3rem;font-family:'Space Grotesk',sans-serif;font-size:1.35rem;color:#0d1117;}" +
      ".adb-card{background:#fff;border:1px solid #e8e8e6;border-radius:14px;padding:1rem 1.1rem;margin-bottom:1rem;}" +
      ".adb-card-title{font-size:.95rem;margin-bottom:.7rem;}" +
      ".adb-table-wrap{overflow-x:auto;}" +
      ".adb table{width:100%;border-collapse:collapse;font-size:.86rem;}" +
      ".adb th{font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;text-align:left;padding:.5rem .6rem;border-bottom:1px solid #e8e8e6;cursor:pointer;user-select:none;white-space:nowrap;}" +
      ".adb th .adb-sort{opacity:.55;font-size:.6rem;margin-left:.2rem;}" +
      ".adb td{padding:.5rem .6rem;border-bottom:1px solid #f0f0ee;vertical-align:middle;}" +
      ".adb tr:last-child td{border-bottom:0;}" +
      ".adb-name{font-weight:700;}" +
      ".adb-trend-up{color:#1d9e75;font-weight:700;}" +
      ".adb-trend-down{color:#c41d38;font-weight:700;}" +
      ".adb-trend-stable{color:#9ca3af;font-weight:700;}" +
      ".adb-details-btn{border:1px solid #e0d2d5;border-radius:999px;background:#fff;color:#c41d38;font:inherit;font-size:.78rem;font-weight:700;padding:.32rem .8rem;cursor:pointer;}" +
      ".adb-details-btn:hover{background:#fdf2f4;}" +
      ".adb-empty{color:#6b7280;font-size:.88rem;padding:.6rem 0;}" +
      ".adb-heat-wrap{overflow-x:auto;}" +
      ".adb-heat{border-collapse:separate;border-spacing:3px;}" +
      ".adb-heat td.adb-heat-name{font-size:.8rem;font-weight:600;padding-right:.6rem;white-space:nowrap;}" +
      ".adb-heat-cell{width:26px;height:20px;border-radius:5px;cursor:default;}" +
      ".adb-tooltip{position:fixed;z-index:12000;background:#182235;color:#fff;border-radius:8px;padding:.45rem .65rem;font-size:.75rem;line-height:1.45;pointer-events:none;box-shadow:0 8px 22px rgba(0,0,0,.3);max-width:240px;}" +
      ".adb-panel-backdrop{position:fixed;inset:0;background:rgba(13,17,23,.35);z-index:11000;}" +
      ".adb-panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,94vw);background:#fff;z-index:11001;box-shadow:-14px 0 40px rgba(0,0,0,.18);padding:1.2rem 1.3rem;overflow-y:auto;transform:translateX(100%);transition:transform .25s ease;}" +
      ".adb-panel.adb-open{transform:translateX(0);}" +
      ".adb-panel-head{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin-bottom:1rem;}" +
      ".adb-panel-close{border:0;background:#f0f1f4;border-radius:50%;width:30px;height:30px;font-size:.85rem;cursor:pointer;color:#374151;}" +
      ".adb-legend{display:flex;flex-wrap:wrap;gap:.7rem;margin:.5rem 0 .2rem;font-size:.74rem;color:#4b5563;}" +
      ".adb-legend span{display:inline-flex;align-items:center;gap:.3rem;}" +
      ".adb-dot{width:9px;height:9px;border-radius:50%;display:inline-block;}" +
      ".adb-sess{border:1px solid #e8e8e6;border-radius:10px;padding:.55rem .7rem;margin-bottom:.5rem;font-size:.8rem;display:flex;justify-content:space-between;gap:.5rem;align-items:center;}" +
      ".adb-sess-ctx{font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:.12rem .5rem;border-radius:999px;color:#fff;}";
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---------------------------------------------------------------------
  // Canvas drawing
  // ---------------------------------------------------------------------

  /** Draws a small progress ring with the score centered, on a canvas. */
  function drawMiniRing(canvas, score) {
    var dpr = window.devicePixelRatio || 1;
    var size = 34;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    var c = size / 2, r = c - 3.5;

    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#eceff2";
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();

    if (score != null) {
      ctx.strokeStyle = scoreColor(score);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * score) / 100);
      ctx.stroke();
    }

    ctx.fillStyle = score != null ? scoreColor(score) : "#9ca3af";
    ctx.font = "700 10px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(score != null ? String(score) : "—", c, c + 0.5);
  }

  /** Line chart: one focus-timeline line per session, colored by context. */
  function drawTimelineChart(canvas, sessions) {
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 400, H = 190;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = H + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    var padL = 30, padR = 8, padT = 10, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var maxT = 60;
    sessions.forEach(function (s) {
      (s.focusTimeline || []).forEach(function (p) { if (p.t > maxT) maxT = p.t; });
    });

    // Axes + gridlines at 0/50/100
    ctx.strokeStyle = COLORS.line;
    ctx.fillStyle = COLORS.muted;
    ctx.font = "600 9.5px 'Source Sans 3', sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, 50, 100].forEach(function (v) {
      var y = padT + plotH - (v / 100) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(String(v), padL - 5, y);
    });
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("temps (s)", padL + plotW / 2, H - 13);

    sessions.forEach(function (s) {
      var pts = s.focusTimeline || [];
      if (pts.length < 2) return;
      ctx.strokeStyle = s.context === "quiz" ? COLORS.quiz : COLORS.lesson;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var x = padL + (p.t / maxT) * plotW;
        var y = padT + plotH - (Math.max(0, Math.min(100, p.score)) / 100) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  /** Pie chart of distraction reasons (event counts). */
  function drawDistractionPie(canvas, sessions) {
    var counts = {};
    var total = 0;
    sessions.forEach(function (s) {
      (s.distractionEvents || []).forEach(function (e) {
        counts[e.reason] = (counts[e.reason] || 0) + 1;
        total++;
      });
    });

    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 400, H = 140;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = H + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    if (!total) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "600 12px 'Source Sans 3', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Aucune distraction enregistrée", W / 2, H / 2);
      return;
    }

    var cx = 62, cy = H / 2, r = Math.min(52, H / 2 - 8);
    var angle = -Math.PI / 2;
    var entries = Object.keys(counts).map(function (k) { return { reason: k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count; });

    entries.forEach(function (e) {
      var slice = (e.count / total) * Math.PI * 2;
      ctx.fillStyle = REASON_COLORS[e.reason] || "#9ca3af";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fill();
      angle += slice;
    });

    // Legend
    ctx.font = "600 11px 'Source Sans 3', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var ly = cy - (entries.length - 1) * 10;
    entries.forEach(function (e) {
      ctx.fillStyle = REASON_COLORS[e.reason] || "#9ca3af";
      ctx.fillRect(cx + r + 18, ly - 4, 9, 9);
      ctx.fillStyle = "#374151";
      var pct = Math.round((e.count / total) * 100);
      ctx.fillText(reasonLabel(e.reason) + " — " + pct + "%", cx + r + 32, ly);
      ly += 20;
    });
  }

  // ---------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------

  var tooltipEl = null;
  function showTooltip(html, x, y) {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "adb-tooltip";
      document.body.appendChild(tooltipEl);
    }
    tooltipEl.innerHTML = html;
    tooltipEl.style.left = Math.min(x + 12, window.innerWidth - 250) + "px";
    tooltipEl.style.top = (y + 14) + "px";
    tooltipEl.style.display = "block";
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderKpis(container, students) {
    var withScore = students.filter(function (s) { return s.avgFocusScore != null && s.totalSessions > 0; });
    var classAvg = withScore.length
      ? Math.round(withScore.reduce(function (sum, s) { return sum + s.avgFocusScore; }, 0) / withScore.length)
      : null;

    var reasonCounts = {};
    students.forEach(function (s) {
      (s.recentSessions || []).forEach(function (sess) {
        (sess.distractionEvents || []).forEach(function (e) {
          reasonCounts[e.reason] = (reasonCounts[e.reason] || 0) + 1;
        });
      });
    });
    var topReason = Object.keys(reasonCounts).sort(function (a, b) { return reasonCounts[b] - reasonCounts[a]; })[0] || null;

    var pctAbove70 = withScore.length
      ? Math.round((withScore.filter(function (s) { return s.avgFocusScore > 70; }).length / withScore.length) * 100)
      : 0;

    var weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    var weekSessions = 0;
    students.forEach(function (s) {
      (s.recentSessions || []).forEach(function (sess) {
        if (sess.completedAt && new Date(sess.completedAt).getTime() >= weekAgo) weekSessions++;
      });
    });

    var row = document.createElement("div");
    row.className = "adb-kpis";
    row.innerHTML =
      '<div class="adb-kpi"><p>Focus moyen classe</p><strong style="color:' + scoreColor(classAvg) + '">' + (classAvg == null ? "—" : classAvg + "%") + "</strong></div>" +
      '<div class="adb-kpi"><p>Distraction principale</p><strong>' + esc(topReason ? reasonLabel(topReason) : "—") + "</strong></div>" +
      '<div class="adb-kpi"><p>Étudiants focus &gt; 70%</p><strong>' + pctAbove70 + "%</strong></div>" +
      '<div class="adb-kpi"><p>Sessions cette semaine</p><strong>' + weekSessions + "</strong></div>";
    container.appendChild(row);
  }

  function renderTable(container, students, onDetails) {
    var card = document.createElement("div");
    card.className = "adb-card";
    card.innerHTML = '<h4 class="adb-card-title">Attention par étudiant</h4>';

    if (!students.length) {
      card.insertAdjacentHTML("beforeend", '<p class="adb-empty">Aucun étudiant dans cette classe.</p>');
      container.appendChild(card);
      return;
    }

    var sortState = { key: "avgFocusScore", dir: 1 };
    var wrap = document.createElement("div");
    wrap.className = "adb-table-wrap";
    card.appendChild(wrap);
    container.appendChild(card);

    var COLS = [
      { key: "fullName", label: "Étudiant" },
      { key: "avgFocusScore", label: "Focus moyen" },
      { key: "totalSessions", label: "Sessions" },
      { key: "trend", label: "Tendance" },
      { key: "topDistraction", label: "Distraction principale" },
      { key: "lastContext", label: "Dernière session" },
      { key: "_actions", label: "" }
    ];

    function sortValue(student, key) {
      if (key === "lastContext") return student.lastSession ? student.lastSession.context : "";
      if (key === "trend") return { improving: 2, stable: 1, declining: 0 }[student.trend] || 0;
      var v = student[key];
      // Untracked students (null score) always sort last so struggling
      // tracked students lead the default ascending focus sort.
      if (key === "avgFocusScore" && v == null) return 101 * sortState.dir;
      return v == null ? -1 : v;
    }

    function draw() {
      var sorted = students.slice().sort(function (a, b) {
        var va = sortValue(a, sortState.key), vb = sortValue(b, sortState.key);
        if (typeof va === "string") return sortState.dir * String(va).localeCompare(String(vb), "fr");
        return sortState.dir * (va - vb);
      });

      var thead = "<tr>" + COLS.map(function (c) {
        var arrow = c.key === sortState.key ? (sortState.dir === 1 ? "▲" : "▼") : "↕";
        return "<th data-key=\"" + c.key + "\">" + esc(c.label) + (c.key === "_actions" ? "" : ' <span class="adb-sort">' + arrow + "</span>") + "</th>";
      }).join("") + "</tr>";

      var rows = sorted.map(function (s, i) {
        var trendHtml = s.trend === "improving"
          ? '<span class="adb-trend-up">↑</span>'
          : s.trend === "declining"
            ? '<span class="adb-trend-down">↓</span>'
            : '<span class="adb-trend-stable">→</span>';
        var last = s.lastSession
          ? esc(s.lastSession.context === "quiz" ? "Quiz" : "Leçon") + ' · <span style="color:#6b7280">' + fmtDate(s.lastSession.completedAt) + "</span>"
          : "—";
        return "<tr>" +
          '<td class="adb-name">' + esc(s.fullName) + "</td>" +
          '<td><canvas data-ring="' + i + '"></canvas></td>' +
          "<td>" + s.totalSessions + "</td>" +
          "<td>" + trendHtml + "</td>" +
          "<td>" + esc(s.topDistraction ? reasonLabel(s.topDistraction) : "—") + "</td>" +
          "<td>" + last + "</td>" +
          '<td><button type="button" class="adb-details-btn" data-detail="' + esc(s.identifier) + '">Voir détails</button></td>' +
          "</tr>";
      }).join("");

      wrap.innerHTML = "<table><thead>" + thead + "</thead><tbody>" + rows + "</tbody></table>";

      wrap.querySelectorAll("canvas[data-ring]").forEach(function (canvas) {
        drawMiniRing(canvas, sorted[Number(canvas.dataset.ring)].avgFocusScore);
      });
      wrap.querySelectorAll("th[data-key]").forEach(function (th) {
        th.addEventListener("click", function () {
          var key = th.dataset.key;
          if (key === "_actions") return;
          if (sortState.key === key) sortState.dir *= -1;
          else { sortState.key = key; sortState.dir = 1; }
          draw();
        });
      });
      wrap.querySelectorAll("[data-detail]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var student = students.find(function (s) { return s.identifier === btn.dataset.detail; });
          if (student) onDetails(student);
        });
      });
    }

    draw();
  }

  function renderHeatmap(container, students) {
    var card = document.createElement("div");
    card.className = "adb-card";
    card.innerHTML = '<h4 class="adb-card-title">Heatmap — 10 dernières sessions</h4>';

    var tracked = students.filter(function (s) { return (s.recentSessions || []).length > 0; });
    if (!tracked.length) {
      card.insertAdjacentHTML("beforeend", '<p class="adb-empty">Aucune session d\'attention enregistrée pour cette classe.</p>');
      container.appendChild(card);
      return;
    }

    var wrap = document.createElement("div");
    wrap.className = "adb-heat-wrap";
    var table = document.createElement("table");
    table.className = "adb-heat";

    tracked.forEach(function (s) {
      var tr = document.createElement("tr");
      var name = document.createElement("td");
      name.className = "adb-heat-name";
      name.textContent = s.fullName;
      tr.appendChild(name);

      for (var i = 0; i < 10; i++) {
        var td = document.createElement("td");
        var cell = document.createElement("div");
        cell.className = "adb-heat-cell";
        var sess = (s.recentSessions || [])[i];
        if (sess) {
          cell.style.background = scoreColor(sess.avgFocusScore);
          cell.style.opacity = "0.9";
          (function (sessRef, studentRef) {
            cell.addEventListener("mousemove", function (e) {
              showTooltip(
                "<strong>" + esc(studentRef.fullName) + "</strong><br>" +
                (sessRef.context === "quiz" ? "Quiz" : "Leçon") + " · " + fmtDate(sessRef.completedAt) + "<br>" +
                "Focus: " + sessRef.avgFocusScore + "% (min " + sessRef.minFocusScore + "%)<br>" +
                "Durée: " + Math.round(sessRef.duration / 60) + " min · " +
                (sessRef.distractionEvents || []).length + " distraction(s)",
                e.clientX, e.clientY
              );
            });
            cell.addEventListener("mouseleave", hideTooltip);
          })(sess, s);
        } else {
          cell.style.background = "#eceff2";
        }
        td.appendChild(cell);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });

    wrap.appendChild(table);
    card.appendChild(wrap);
    container.appendChild(card);
  }

  function openDetailPanel(student) {
    var backdrop = document.createElement("div");
    backdrop.className = "adb-panel-backdrop";
    var panel = document.createElement("div");
    panel.className = "adb-panel adb";

    var sessions = student.recentSessions || [];
    panel.innerHTML =
      '<div class="adb-panel-head">' +
      "<h3>" + esc(student.fullName) + "</h3>" +
      '<button type="button" class="adb-panel-close" aria-label="Fermer">✕</button>' +
      "</div>" +
      '<h4 class="adb-card-title">Timeline de focus (' + sessions.length + " sessions)</h4>" +
      '<div class="adb-legend">' +
      '<span><span class="adb-dot" style="background:' + COLORS.lesson + '"></span>Leçon</span>' +
      '<span><span class="adb-dot" style="background:' + COLORS.quiz + '"></span>Quiz</span>' +
      "</div>" +
      '<canvas class="adb-timeline" style="width:100%"></canvas>' +
      '<h4 class="adb-card-title" style="margin-top:1rem">Répartition des distractions</h4>' +
      '<canvas class="adb-pie" style="width:100%"></canvas>' +
      '<h4 class="adb-card-title" style="margin-top:1rem">Historique des sessions</h4>' +
      '<div class="adb-sess-list"></div>';

    var list = panel.querySelector(".adb-sess-list");
    if (!sessions.length) {
      list.innerHTML = '<p class="adb-empty">Aucune session enregistrée.</p>';
    } else {
      sessions.slice().reverse().forEach(function (s) {
        var el = document.createElement("div");
        el.className = "adb-sess";
        el.innerHTML =
          "<div><strong style=\"color:" + scoreColor(s.avgFocusScore) + "\">" + s.avgFocusScore + "%</strong>" +
          ' <span style="color:#6b7280">· min ' + s.minFocusScore + "% · " + Math.round(s.duration / 60) + " min · " +
          (s.distractionEvents || []).length + " distraction(s)</span><br>" +
          '<span style="color:#6b7280;font-size:.74rem">' + fmtDate(s.completedAt) +
          (s.subAcquisId ? " · " + esc(s.subAcquisId) : "") + "</span></div>" +
          '<span class="adb-sess-ctx" style="background:' + (s.context === "quiz" ? COLORS.quiz : COLORS.lesson) + '">' +
          (s.context === "quiz" ? "Quiz" : "Leçon") + "</span>";
        list.appendChild(el);
      });
    }

    function close() {
      panel.classList.remove("adb-open");
      setTimeout(function () { panel.remove(); backdrop.remove(); }, 250);
    }
    panel.querySelector(".adb-panel-close").addEventListener("click", close);
    backdrop.addEventListener("click", close);

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    requestAnimationFrame(function () {
      panel.classList.add("adb-open");
      drawTimelineChart(panel.querySelector(".adb-timeline"), sessions);
      drawDistractionPie(panel.querySelector(".adb-pie"), sessions);
    });
  }

  // ---------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------

  /**
   * Fetches the class attention data and renders the full dashboard (KPIs,
   * sortable table, heatmap, detail panel on demand) inside the container.
   *
   * @param {string} containerId - id of the DOM element to render into.
   * @param {string} classId - the ClassRoom _id whose students to show.
   * @returns {Promise<void>} resolves when rendering is complete.
   */
  function renderAttentionDashboard(containerId, classId) {
    injectStyles();
    var container = document.getElementById(containerId);
    if (!container) {
      console.warn("[attentionDashboard] container introuvable:", containerId);
      return Promise.resolve();
    }
    container.classList.add("adb");
    container.innerHTML = '<p class="adb-empty">Chargement des données d\'attention…</p>';

    return fetch("/api/backoffice/attention/" + encodeURIComponent(classId), {
      headers: { "X-Teacher-Id": getTeacherId() }
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var students = Array.isArray(data.students) ? data.students : [];
        container.innerHTML = "";
        renderKpis(container, students);
        renderTable(container, students, openDetailPanel);
        renderHeatmap(container, students);
      })
      .catch(function (err) {
        console.error("[attentionDashboard] échec:", err);
        container.innerHTML = '<p class="adb-empty">Impossible de charger les données d\'attention.</p>';
      });
  }

  return renderAttentionDashboard;
});
