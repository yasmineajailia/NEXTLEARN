/**
 * dom-utils.js
 *
 * Shared, dependency-free HTML-escaping helper. Previously reimplemented
 * independently in backoffice.js, student.js, sous-acquis.html,
 * clusteringDashboard.js and questionnaire.html — six near-identical copies
 * with small, accidental differences (some escaped apostrophes, some didn't;
 * different null/undefined handling). One canonical implementation here;
 * each of those files now delegates its own locally-named helper to this.
 *
 * Global API (classic script tag):
 *   escapeHtml(value) -> escaped string, safe to inject as HTML text/attribute content
 */
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.escapeHtml = escapeHtml;
})();
