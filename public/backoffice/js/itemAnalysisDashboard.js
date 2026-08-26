/**
 * itemAnalysisDashboard.js
 *
 * Self-contained backoffice card for classical quiz item analysis
 * (GET /api/backoffice/item-analysis/:moduleId/:subAcquisId). For each question
 * it shows difficulty (p-value) and discrimination (rest-corrected point-biserial),
 * and flags broken / too-easy / too-hard questions — computed by the Python ML
 * service from real student responses. Helps teachers QA the AI-generated quizzes.
 *
 * Usage:
 *   <script src="/backoffice/js/itemAnalysisDashboard.js"></script>
 *   <script>renderItemAnalysis("root", moduleId, subAcquisId);</script>
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.renderItemAnalysis = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var STYLE_ID = "ia-styles";

  var FLAGS = {
    ok: { label: "OK", color: "#1d9e75" },
    too_easy: { label: "Trop facile", color: "#f59e0b" },
    too_hard: { label: "Trop difficile", color: "#3266ad" },
    weak: { label: "Peu discriminante", color: "#f59e0b" },
    misleading: { label: "Suspecte : à revoir", color: "#c41d38" },
    insufficient_data: { label: "Données insuffisantes", color: "#9ca3af" }
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      ".ia{font-family:'Source Sans 3','Segoe UI',sans-serif;color:#0d1117;}" +
      ".ia-card{background:#fff;border:1px solid #e8e8e6;border-radius:14px;padding:1rem 1.1rem;margin-bottom:1rem;}" +
      ".ia-card h4{font-family:'Space Grotesk',sans-serif;margin:0 0 .2rem;font-size:.95rem;}" +
      ".ia-sub{margin:0;font-size:.8rem;color:#6b7280;}" +
      ".ia-kpis{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;margin-top:.8rem;}" +
      ".ia-kpi strong{font-family:'Space Grotesk',sans-serif;font-size:1.15rem;}" +
      ".ia-kpi span{display:block;font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}" +
      ".ia-table-wrap{overflow-x:auto;}" +
      ".ia table{width:100%;border-collapse:collapse;font-size:.84rem;}" +
      ".ia th{font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;text-align:left;padding:.5rem .55rem;border-bottom:1px solid #e8e8e6;white-space:nowrap;}" +
      ".ia td{padding:.55rem .55rem;border-bottom:1px solid #f0f0ee;vertical-align:middle;}" +
      ".ia tr:last-child td{border-bottom:0;}" +
      ".ia-qnum{font-weight:700;color:#6b7280;}" +
      ".ia-prompt{max-width:340px;color:#182235;}" +
      ".ia-diff{display:flex;align-items:center;gap:.5rem;min-width:120px;}" +
      ".ia-track{flex:1;height:9px;border-radius:999px;background:#f0f1f4;overflow:hidden;min-width:60px;}" +
      ".ia-track-fill{height:100%;border-radius:999px;}" +
      ".ia-val{font-variant-numeric:tabular-nums;font-weight:600;color:#374151;min-width:38px;text-align:right;}" +
      ".ia-disc{position:relative;height:9px;border-radius:999px;background:#f0f1f4;min-width:90px;}" +
      ".ia-disc-mid{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:#cbd0d8;}" +
      ".ia-disc-fill{position:absolute;top:0;height:100%;border-radius:999px;}" +
      ".ia-badge{display:inline-block;padding:.16rem .55rem;border-radius:999px;font-size:.72rem;font-weight:700;color:#fff;white-space:nowrap;}" +
      ".ia-empty{color:#6b7280;font-size:.88rem;padding:.5rem 0;}" +
      ".ia-legend{margin:.7rem 0 0;font-size:.75rem;color:#6b7280;line-height:1.5;}";
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function diffColor(p) {
    if (p >= 0.95 || p <= 0.2) return "#c41d38"; // too easy / too hard
    if (p >= 0.85) return "#f59e0b";
    return "#1d9e75";
  }

  function discBar(disc) {
    if (disc == null) return '<span class="ia-val">—</span>';
    var v = Math.max(-1, Math.min(1, disc));
    var color = v < 0 ? "#c41d38" : v < 0.15 ? "#f59e0b" : "#1d9e75";
    var left = v >= 0 ? 50 : 50 + v * 50;
    var width = Math.abs(v) * 50;
    return (
      '<span class="ia-diff"><span class="ia-disc"><span class="ia-disc-mid"></span>' +
      '<span class="ia-disc-fill" style="left:' + left + "%;width:" + width + "%;background:" + color + '"></span></span>' +
      '<span class="ia-val" style="color:' + color + '">' + v.toFixed(2) + "</span></span>"
    );
  }

  function fmtPct(x) {
    return x == null ? "—" : Math.round(x * 100) + "%";
  }

  function renderItemAnalysis(containerId, moduleId, subAcquisId) {
    injectStyles();
    var container = document.getElementById(containerId);
    if (!container) return Promise.resolve();
    container.className = "ia";
    container.innerHTML = '<div class="ia-card"><p class="ia-empty">Analyse des questions en cours…</p></div>';

    var url = "/api/backoffice/item-analysis/" + encodeURIComponent(moduleId) + "/" + encodeURIComponent(subAcquisId);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var items = Array.isArray(data.items) ? data.items : [];
        var s = data.summary || {};

        var head =
          '<div class="ia-card"><h4>Analyse des questions</h4>' +
          '<p class="ia-sub">Difficulté et pouvoir discriminant calculés à partir des réponses réelles des étudiants (première tentative).</p>';

        if (!s.nAttempts) {
          container.innerHTML =
            head + '<p class="ia-empty">Aucune réponse enregistrée pour ce quiz : l\'analyse apparaîtra dès que des étudiants l\'auront passé.</p></div>';
          return;
        }

        var kpis =
          '<div class="ia-kpis">' +
          '<div class="ia-kpi"><strong>' + (s.nAttempts || 0) + "</strong><span>Tentatives</span></div>" +
          '<div class="ia-kpi"><strong>' + (s.nQuestions || 0) + "</strong><span>Questions</span></div>" +
          '<div class="ia-kpi"><strong>' + fmtPct(s.meanDifficulty) + "</strong><span>Difficulté moy.</span></div>" +
          '<div class="ia-kpi"><strong>' + (s.reliabilityAlpha == null ? "—" : s.reliabilityAlpha.toFixed(2)) +
          "</strong><span>Fiabilité (KR-20)</span></div>" +
          '<div class="ia-kpi"><strong style="color:' + (s.flaggedCount > 0 ? "#c41d38" : "#1d9e75") + '">' +
          (s.flaggedCount || 0) + "</strong><span>À revoir</span></div>" +
          "</div></div>";

        var rows = items
          .map(function (it) {
            var flag = FLAGS[it.flag] || FLAGS.ok;
            var p = Number(it.difficulty);
            var diff =
              '<span class="ia-diff"><span class="ia-track"><span class="ia-track-fill" style="width:' +
              Math.round(p * 100) + "%;background:" + diffColor(p) + '"></span></span>' +
              '<span class="ia-val">' + Math.round(p * 100) + "%</span></span>";
            var prompt = it.prompt ? esc(String(it.prompt).slice(0, 120)) : '<em style="color:#9ca3af">Question ' + (it.questionIndex + 1) + "</em>";
            return (
              "<tr>" +
              '<td class="ia-qnum">Q' + (it.questionIndex + 1) + "</td>" +
              '<td class="ia-prompt">' + prompt + "</td>" +
              "<td>" + diff + "</td>" +
              "<td>" + discBar(it.discrimination) + "</td>" +
              '<td><span class="ia-badge" style="background:' + flag.color + '">' + esc(flag.label) + "</span></td>" +
              "</tr>"
            );
          })
          .join("");

        var table =
          '<div class="ia-card"><div class="ia-table-wrap"><table><thead><tr>' +
          "<th>#</th><th>Question</th><th>Difficulté</th><th>Discrimination</th><th>Verdict</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
          '<p class="ia-legend"><strong>Difficulté</strong> = % de bonnes réponses (idéal ~30–85 %). ' +
          "<strong>Discrimination</strong> = corrélation entre réussir cette question et réussir les autres&nbsp;: " +
          "une valeur <strong>négative</strong> signale une question probablement cassée ou mal corrigée.</p></div>";

        container.innerHTML = head + kpis + table;
      })
      .catch(function (err) {
        console.error("[itemAnalysis] échec:", err);
        container.innerHTML = '<div class="ia-card"><p class="ia-empty">Impossible de calculer l\'analyse des questions.</p></div>';
      });
  }

  return renderItemAnalysis;
});
