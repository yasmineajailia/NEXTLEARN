/**
 * vark.js
 *
 * Single source of truth for the VARK localStorage key, shared by
 * mission-apprenant.html, sous-acquis.html and student.js.
 *
 * Deliberately NOT a shared VARK config object or reader function: each
 * consumer's local config (mission-apprenant.html's rich game narrative,
 * student.js's dashboard-badge labels with lazy i18n, sous-acquis.html's
 * resource-preference ordering) has genuinely different shape and validation
 * needs tied to its own purpose, not accidental copy-paste drift. Only the
 * storage key itself — a plain string every consumer must agree on exactly —
 * is safe to extract without redesigning each caller.
 *
 * Global API (classic script tag):
 *   VARK_STORAGE_KEY -> "nextlearn_vark_result"
 */
window.VARK_STORAGE_KEY = "nextlearn_vark_result";
