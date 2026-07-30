/**
 * auth-guard.js
 *
 * Global handler for expired / missing sessions. Wraps window.fetch: when any
 * same-origin /api/ call returns 401, the session is gone, so bounce the user to
 * the sign-in page instead of leaving them on a silently broken screen.
 *
 * Loaded on authenticated pages (student + backoffice). It deliberately does
 * nothing on the auth pages themselves — a 401 there (e.g. a wrong password on
 * the sign-in form) is a message to display, not a reason to redirect.
 */
(function () {
  "use strict";

  if (/^\/(sign-in|sign-up|forgot-password|reset-password)/.test(location.pathname)) {
    return;
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch !== "function") return;

  var redirecting = false;

  window.fetch = function () {
    var args = arguments;
    var input = args[0];
    return originalFetch.apply(this, args).then(function (response) {
      try {
        if (response && response.status === 401 && !redirecting) {
          var url = typeof input === "string" ? input : (input && input.url) || "";
          if (url.indexOf("/api/") !== -1) {
            redirecting = true;
            var next = encodeURIComponent(location.pathname + location.search);
            location.replace("/sign-in?next=" + next);
          }
        }
      } catch (_e) {
        /* never let the guard break a real response */
      }
      return response;
    });
  };

  // First-login gate: every student page except the game itself checks the
  // one-shot VARK profile and bounces to it until completed. Backoffice pages
  // never hit this (VARK is a student-only concept), and a 401 here is already
  // handled by the fetch wrapper above (redirect to sign-in).
  var VARK_PATH = "/student/mission-apprenant";
  if (location.pathname.indexOf("/student") === 0 && location.pathname.indexOf(VARK_PATH) !== 0) {
    window
      .fetch("/api/student/vark")
      .then(function (response) {
        return response && response.ok ? response.json() : null;
      })
      .then(function (data) {
        if (data && !data.varkProfile && !redirecting) {
          redirecting = true;
          location.replace(VARK_PATH);
        }
      })
      .catch(function () {
        /* network hiccup: fail open rather than lock a student out of the app */
      });
  }
})();
