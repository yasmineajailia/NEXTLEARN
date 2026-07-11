/**
 * NextLearn theme controller.
 *
 * Applies the saved theme (light/dark) and colour-blind (CVD) preference to
 * <html data-theme data-cvd> as early as possible to avoid a flash, and wires up
 * any [data-theme-toggle] / [data-cvd-toggle] controls (including the ones inside
 * the dynamically injected sidebar, via the "sidebar:ready" event).
 *
 * Load this SYNCHRONOUSLY in <head>, before the stylesheets, so the attributes
 * are set before first paint.
 */
(function () {
  var root = document.documentElement;

  // Optional URL overrides (?theme=dark&cvd=on) — handy for links/testing; they persist.
  function urlParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }
  (function seedFromUrl() {
    var t = urlParam("theme");
    if (t === "dark" || t === "light") { try { localStorage.setItem("nextlearnTheme", t); } catch (e) {} }
    var c = urlParam("cvd");
    if (c === "on" || c === "off") { try { localStorage.setItem("nextlearnCvd", c); } catch (e) {} }
  })();

  function readTheme() {
    try { return localStorage.getItem("nextlearnTheme") === "dark" ? "dark" : "light"; } catch (e) { return "light"; }
  }
  function readCvd() {
    try { return localStorage.getItem("nextlearnCvd") === "on" ? "on" : "off"; } catch (e) { return "off"; }
  }
  function apply() {
    root.setAttribute("data-theme", readTheme());
    root.setAttribute("data-cvd", readCvd());
  }

  // Run immediately (script sits in <head> before the body renders).
  apply();

  function setTheme(mode) {
    try { localStorage.setItem("nextlearnTheme", mode === "dark" ? "dark" : "light"); } catch (e) {}
    apply();
    reflect();
  }
  function setCvd(state) {
    try { localStorage.setItem("nextlearnCvd", state === "on" ? "on" : "off"); } catch (e) {}
    apply();
    reflect();
  }
  function toggleTheme() { setTheme(readTheme() === "dark" ? "light" : "dark"); }
  function toggleCvd() { setCvd(readCvd() === "on" ? "off" : "on"); }

  function reflect() {
    var dark = readTheme() === "dark";
    var cvd = readCvd() === "on";
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), function (btn) {
      btn.setAttribute("aria-pressed", String(dark));
      var label = btn.querySelector("[data-theme-label]");
      if (label) label.textContent = dark ? "Mode clair" : "Mode sombre";
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-cvd-toggle]"), function (btn) {
      btn.setAttribute("aria-pressed", String(cvd));
    });
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), function (btn) {
      if (btn.dataset.themeBound) return;
      btn.dataset.themeBound = "1";
      btn.addEventListener("click", toggleTheme);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-cvd-toggle]"), function (btn) {
      if (btn.dataset.cvdBound) return;
      btn.dataset.cvdBound = "1";
      btn.addEventListener("click", toggleCvd);
    });
    reflect();
  }

  window.NextLearnTheme = {
    setTheme: setTheme,
    setCvd: setCvd,
    toggleTheme: toggleTheme,
    toggleCvd: toggleCvd,
    getTheme: readTheme,
    getCvd: readCvd
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
  // The sidebar (which holds the toggles) is injected asynchronously.
  document.addEventListener("sidebar:ready", bind);
})();
