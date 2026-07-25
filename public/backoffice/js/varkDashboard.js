/**
 * varkDashboard.js
 *
 * Self-contained backoffice card for the VARK learning-style distribution of a
 * class (GET /api/backoffice/vark/:classId). Renders a compact summary (total /
 * tested / not-taken) plus one bar per style. Colors match the student-side
 * VARK styling on the lesson pages so the identity is consistent.
 *
 * Usage (browser):
 *   <script src="/backoffice/js/varkDashboard.js"></script>
 *   <script>renderVarkDashboard("vark-root", classId);</script>
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.renderVarkDashboard = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var STYLE_ID = "vdb-styles";

  // Order + labels + colors mirror VARK_STYLES on the student lesson page.
  var DIMS = [
    { key: "visual", label: "Visuel", color: "#3266ad" },
    { key: "auditory", label: "Auditif", color: "#7f77dd" },
    { key: "readwrite", label: "Lecture / écriture", color: "#1d9e75" },
    { key: "kinesthetic", label: "Kinesthésique", color: "#d85a30" }
  ];

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      ".vdb{font-family:'Source Sans 3','Segoe UI',sans-serif;color:#0d1117;background:#fff;border:1px solid #e8e8e6;border-radius:14px;padding:1rem 1.1rem;margin-bottom:1rem;}" +
      ".vdb h4{font-family:'Space Grotesk',sans-serif;margin:0 0 .2rem;font-size:.95rem;}" +
      ".vdb-sub{margin:0 0 .9rem;font-size:.8rem;color:#6b7280;}" +
      ".vdb-kpis{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;margin-bottom:1rem;}" +
      ".vdb-kpi strong{font-family:'Space Grotesk',sans-serif;font-size:1.15rem;}" +
      ".vdb-kpi span{display:block;font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}" +
      ".vdb-rows{display:grid;gap:.55rem;}" +
      ".vdb-row{display:grid;grid-template-columns:130px 1fr 54px;align-items:center;gap:.6rem;font-size:.83rem;}" +
      ".vdb-name{font-weight:600;display:flex;align-items:center;gap:.4rem;}" +
      ".vdb-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;}" +
      ".vdb-track{height:12px;border-radius:999px;background:#f0f1f4;overflow:hidden;}" +
      ".vdb-fill{height:100%;border-radius:999px;min-width:2px;transition:width .3s ease;}" +
      ".vdb-val{text-align:right;font-variant-numeric:tabular-nums;color:#374151;font-weight:600;}" +
      ".vdb-empty{color:#6b7280;font-size:.86rem;padding:.4rem 0;}";
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderVarkDashboard(containerId, classId) {
    injectStyles();
    var container = document.getElementById(containerId);
    if (!container) return Promise.resolve();
    container.className = "vdb";
    container.innerHTML = '<p class="vdb-empty">Chargement des profils d\'apprentissage…</p>';

    return fetch("/api/backoffice/vark/" + encodeURIComponent(classId))
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var dist = data.distribution || {};
        var taken = Number(data.taken || 0);
        var total = Number(data.total || 0);
        var notTaken = Number(data.notTaken || 0);

        var head =
          '<h4>Styles d\'apprentissage (VARK)</h4>' +
          '<p class="vdb-sub">Répartition des styles dominants dans la classe, d\'après le jeu « Mission Apprenant ».</p>';

        if (!total) {
          container.innerHTML = head + '<p class="vdb-empty">Aucun étudiant dans cette classe.</p>';
          return;
        }
        if (!taken) {
          container.innerHTML =
            head + '<p class="vdb-empty">Aucun étudiant n\'a encore passé le test de style d\'apprentissage.</p>';
          return;
        }

        var kpis =
          '<div class="vdb-kpis">' +
          '<div class="vdb-kpi"><strong>' + total + "</strong><span>Étudiants</span></div>" +
          '<div class="vdb-kpi"><strong>' + taken + "</strong><span>Testés</span></div>" +
          '<div class="vdb-kpi"><strong>' + notTaken + "</strong><span>Non testés</span></div>" +
          "</div>";

        var rows = DIMS.map(function (d) {
          var count = Number(dist[d.key] || 0);
          var pct = taken ? Math.round((count / taken) * 100) : 0;
          return (
            '<div class="vdb-row">' +
            '<span class="vdb-name"><span class="vdb-dot" style="background:' + d.color + '"></span>' + esc(d.label) + "</span>" +
            '<span class="vdb-track"><span class="vdb-fill" style="width:' + pct + "%;background:" + d.color + '"></span></span>' +
            '<span class="vdb-val">' + count + " · " + pct + "%</span>" +
            "</div>"
          );
        }).join("");

        container.innerHTML = head + kpis + '<div class="vdb-rows">' + rows + "</div>";
      })
      .catch(function (err) {
        console.error("[varkDashboard] échec:", err);
        container.innerHTML = '<p class="vdb-empty">Impossible de charger les profils d\'apprentissage.</p>';
      });
  }

  return renderVarkDashboard;
});
