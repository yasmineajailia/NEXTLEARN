/**
 * NextLearn i18n controller (FR default, EN opt-in).
 *
 * French is the source language and stays inline in the markup. When the
 * saved language is "en", elements carrying data-i18n attributes are swapped
 * to the English dictionary below, and JS code can resolve strings through
 * window.I18N.t(key, vars).
 *
 * - Persisted in localStorage ("nextlearnLang"), URL override ?lang=en|fr.
 * - [data-lang-toggle] buttons switch language and reload the page so that
 *   JS-rendered content re-renders in the right language.
 * - A MutationObserver translates markup injected after load (sidebar,
 *   JS templates), so data-i18n works in dynamic HTML too.
 * - Attribute variants: data-i18n (textContent), data-i18n-placeholder,
 *   data-i18n-title, data-i18n-aria (aria-label), data-i18n-value.
 *
 * Load SYNCHRONOUSLY in <head> (after theme.js) so document.lang is right
 * before first paint.
 */
(function () {
  var STORAGE_KEY = "nextlearnLang";

  function urlParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }
  (function seedFromUrl() {
    var l = urlParam("lang");
    if (l === "en" || l === "fr") { try { localStorage.setItem(STORAGE_KEY, l); } catch (e) {} }
  })();

  function readLang() {
    try { return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "fr"; } catch (e) { return "fr"; }
  }

  var lang = readLang();
  document.documentElement.lang = lang;

  /* ------------------------------------------------------------------ */
  /* English dictionary. French never needs entries: it lives inline.    */
  /* Pages/scripts can add their own keys via I18N.extend({...}).        */
  /* ------------------------------------------------------------------ */
  var EN = {
    /* Shared sidebar */
    "sidebar.student": "Student",
    "sidebar.studentName": "Student name",
    "sidebar.identifier": "ID",
    "sidebar.level": "Level",
    "sidebar.nav": "Student navigation",
    "sidebar.dashboard": "Dashboard",
    "sidebar.courses": "Courses",
    "sidebar.selfEval": "Self-assessment",
    "sidebar.learnerMission": "Learner Mission",
    "sidebar.calendar": "Calendar",
    "sidebar.notifications": "Notifications",
    "sidebar.logout": "Log out",
    "sidebar.displayOptions": "Display options",
    "sidebar.themeToggle": "Toggle light / dark",
    "sidebar.cvdToggle": "Colour-blind friendly palette",
    "sidebar.langToggle": "Passer en français / Switch to English",
    "sidebar.collapse": "Collapse the sidebar",

    /* Common */
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.save": "Save",
    "common.close": "Close",
    "common.back": "Back",
    "common.next": "Next",
    "common.previous": "Previous",
    "common.loading": "Loading…",
    "common.error": "Something went wrong. Please try again.",
    "common.search": "Search",
    "common.seeMore": "See more",
    "common.send": "Send",
    "common.module": "Module",
    "common.quiz": "Quiz",
    "common.lesson": "Lesson",
    "common.score": "Score",
    "common.average": "Average",
    "common.progress": "Progress",
    "common.email": "Email address",
    "common.password": "Password",
    "common.signIn": "Sign in",
    "common.signUp": "Sign up",

    /* Auth pages */
    "title.signIn": "Sign in - NextLearn",
    "title.signUp": "Sign up - NextLearn",
    "title.forgot": "Forgot password - NextLearn",
    "title.reset": "Reset password - NextLearn",
    "auth.signInTitle": "Sign in",
    "auth.studentSubtitle": "Access your modules, your progress and your assessments.",
    "auth.teacherSubtitle": "Access the teacher area to manage classes and content.",
    "auth.studentEmail": "Student email",
    "auth.teacherEmail": "Teacher email",
    "auth.password": "Password",
    "auth.studentPwPh": "Your student password",
    "auth.teacherPwPh": "Your teacher password",
    "auth.roleStudent": "Student",
    "auth.roleTeacher": "Teacher",
    "auth.forgotQ": "Forgot your password?",
    "auth.resetMyPw": "Reset my password",
    "auth.signinAsideTitle": "Learn with a path adapted to your level.",
    "auth.signinAsideText": "Sign in to find your courses, your personalized exercises and your progress indicators.",
    "auth.backHome": "Back to home",
    "auth.errSignIn": "Sign-in failed",
    "auth.errNetwork": "Network error",
    "auth.signUpTitle": "Create an account",
    "auth.signUpSubtitle": "Create your account with an identifier and a password.",
    "auth.fullName": "Full name",
    "auth.fullNamePh": "Your full name",
    "auth.identifier": "Identifier",
    "auth.identifierPh": "Choose an identifier",
    "auth.pwChoosePh": "Choose a password",
    "auth.createBtn": "Create my account",
    "auth.alreadyAccount": "Already have an account?",
    "auth.signInLink": "Sign in",
    "auth.signInLink2": "Sign in",
    "auth.signupAsideTitle": "Turn your goals into measurable progress.",
    "auth.signupAsideText": "Register to get content recommendations, track your growth and learn at your own pace.",
    "auth.errSignUp": "Account creation failed",
    "auth.forgotTitle": "Forgot password",
    "auth.forgotSubtitle": "Enter your email and receive a reset link.",
    "auth.email": "Email",
    "auth.emailPh": "your@email.com",
    "auth.sendLink": "Send the link",
    "auth.rememberQ": "Remember your password?",
    "auth.backToSignIn": "Back to sign in",
    "auth.forgotAsideTitle": "Recover your access in seconds.",
    "auth.forgotAsideText": "The reset link is sent by email and expires automatically to protect your account.",
    "auth.emailSent": "Email sent",
    "auth.errRequest": "Request failed",
    "auth.resetTitle": "Reset password",
    "auth.resetSubtitle": "Choose a new password for your account.",
    "auth.newPassword": "New password",
    "auth.newPwPh": "Min 8 characters, uppercase, lowercase, digit, symbol",
    "auth.confirmPassword": "Confirm password",
    "auth.confirmPwPh": "Confirm your password",
    "auth.resetBtn": "Reset",
    "auth.backWord": "Back",
    "auth.resetAsideTitle": "Your security comes first.",
    "auth.resetAsideText": "This form works with a temporary link received by email. Use a strong, unique password.",

    /* Student dashboard */
    "app.studentTitle": "Student Area — NextLearn",
    "dash.eyebrowCourses": "Courses",
    "dash.myCoursesTitle": "My available courses",
    "dash.hero": "Dashboard",
    "dash.hello": "Hello!",
    "dash.streak": "Streak",
    "dash.progressLabel": "Progress",
    "dash.heroQuote": "Keep it up — every small step counts.",
    "dash.aiPrediction": "AI prediction",
    "dash.ofSuccess": "success rate",
    "dash.analyzing": "Analyzing…",
    "dash.nextStep": "Next step",
    "dash.continue": "Continue",
    "dash.overallProgress": "Overall progress",
    "dash.weakModules": "Modules to strengthen",
    "dash.moduleProgress": "Progress by module",
    "dash.missionDesc": "Eight mini-games to discover your learning profile — and the best way to progress on NextLearn.",
    "dash.missionCta": "Take on the challenges →",
    "dash.predModuleAria": "Module targeted by the prediction",
    "stats.lessonsCompleted": "Lessons completed",
    "stats.quizzesPassed": "Quizzes taken",
    "stats.quizAverage": "Quiz average",
    "modules.loading": "Loading modules…",
    "modules.back": "← Back to modules",
    "calendar.title": "Activity calendar",
    "dash.notifications": "Notifications",

    /* Lesson page */
    "title.lesson": "Sub-skill — Student Area",
    "lesson.focusMode": "Focus mode",
    "lesson.subAcquis": "Sub-skill",
    "lesson.prevPage": "Previous page",
    "lesson.nextPage": "Next page",
    "lesson.fullscreen": "PDF fullscreen",
    "lesson.pdfPreview": "Course material preview",
    "lesson.videoPreview": "Video preview",
    "lesson.objectives": "Session objectives",
    "lesson.objectivesText": "Go through the course material and the video above to absorb this notion, then validate it by taking the quiz. Feel free to ask the assistant if anything is unclear.",
    "lesson.takeQuiz": "Take the quiz",
    "lesson.testKnowledge": "Test your knowledge of this sub-skill",
    "lesson.nextSub": "Next sub-skill",
    "chat.open": "Open assistant",
    "chat.title": "NextLearn Assistant",
    "chat.newConv": "New conversation",
    "chat.closeAssistant": "Close the assistant",
    "chat.sugExplain": "Explain this lesson simply",
    "chat.sugExample": "Give a code example",
    "chat.sugKeyPoints": "What are the key points?",
    "chat.inputPh": "Type your question here...",
    "chat.now": "Just now",
    "chat.disclaimer": "AI can make mistakes. Double-check important information.",

    /* Backoffice */
    "title.bo": "Backoffice - NextLearn",
    "bo.connectedAs": "Signed in as",
    "bo.teacher": "Teacher",
    "bo.overview": "Overview",
    "bo.overviewTitle": "Progress dashboard",
    "bo.moduleMgmt": "Module management",
    "bo.teacherMgmt": "Teacher management",
    "bo.classMgmt": "Class management",
    "bo.accessMgmt": "Manage module access",
    "bo.studentMgmt": "Student management",
    "bo.clustering": "Learning profiles",
    "bo.attention": "Attention tracking",
    "bo.attentionTitle": "Student concentration",
    "bo.atRisk": "Students at risk",
    "bo.inactive": "Inactive students",
    "bo.progressByClass": "Progress by class",
    "bo.difficultiesByModule": "Difficulties by module",
    "bo.modulesView": "Modules view",
    "bo.classLabel": "Class",

    /* Attention dashboard */
    "att.classAverage": "Class average focus",
    "att.topDistraction": "Top distraction",
    "att.above70": "Students above 70%",
    "att.sessionsWeek": "Sessions this week",
    "att.details": "View details",
    "att.noData": "No attention data yet for this class."
  };

  /* ------------------------------------------------------------------ */

  function t(key, vars) {
    var s = lang === "en" && Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : null;
    if (s == null) return null; // caller keeps its French fallback
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp("\\{" + k + "\\}", "g"), String(vars[k]));
      });
    }
    return s;
  }

  /** t() with an explicit French fallback — the main API for JS strings. */
  function tr(key, fallbackFr, vars) {
    var s = t(key, vars);
    if (s != null) return s;
    if (vars && fallbackFr) {
      Object.keys(vars).forEach(function (k) {
        fallbackFr = fallbackFr.replace(new RegExp("\\{" + k + "\\}", "g"), String(vars[k]));
      });
    }
    return fallbackFr;
  }

  var ATTR_MAP = [
    ["data-i18n-placeholder", "placeholder"],
    ["data-i18n-title", "title"],
    ["data-i18n-aria", "aria-label"],
    ["data-i18n-value", "value"]
  ];

  function applyTo(rootEl) {
    if (lang !== "en" || !rootEl || !rootEl.querySelectorAll) return;
    var nodes = rootEl.querySelectorAll("[data-i18n]");
    Array.prototype.forEach.call(nodes, function (el) {
      var s = t(el.getAttribute("data-i18n"));
      if (s != null) {
        el.textContent = s;
        // Chat quick-suggestions send their label as the prompt.
        if (el.hasAttribute("data-prompt")) el.setAttribute("data-prompt", s);
      }
    });
    if (rootEl.getAttribute && rootEl.getAttribute("data-i18n")) {
      var self = t(rootEl.getAttribute("data-i18n"));
      if (self != null) rootEl.textContent = self;
    }
    ATTR_MAP.forEach(function (pair) {
      var sel = "[" + pair[0] + "]";
      var els = rootEl.querySelectorAll(sel);
      Array.prototype.forEach.call(els, function (el) {
        var s = t(el.getAttribute(pair[0]));
        if (s != null) el.setAttribute(pair[1], s);
      });
    });
  }

  function setLang(next) {
    next = next === "en" ? "en" : "fr";
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    // Reload so every JS-rendered string re-renders in the new language.
    window.location.reload();
  }

  function toggle() { setLang(lang === "en" ? "fr" : "en"); }

  function reflect() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lang-toggle]"), function (btn) {
      // The button shows the language you would switch TO.
      var label = btn.querySelector("[data-lang-label]") || btn;
      label.textContent = lang === "en" ? "FR" : "EN";
      btn.setAttribute("aria-pressed", String(lang === "en"));
    });
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lang-toggle]"), function (btn) {
      if (btn.dataset.langBound) return;
      btn.dataset.langBound = "1";
      btn.addEventListener("click", toggle);
    });
    reflect();
    applyTo(document.documentElement); // includes <title data-i18n> in <head>
  }

  window.I18N = {
    lang: lang,
    isEn: lang === "en",
    t: tr,
    setLang: setLang,
    toggle: toggle,
    apply: applyTo,
    extend: function (entries) {
      Object.keys(entries || {}).forEach(function (k) { EN[k] = entries[k]; });
      applyTo(document.body);
    }
  };

  function start() {
    bind();
    // Translate markup injected later (sidebar, JS templates with data-i18n).
    if (lang === "en" && window.MutationObserver && document.body) {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          Array.prototype.forEach.call(m.addedNodes, function (n) {
            if (n.nodeType === 1) applyTo(n);
          });
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  document.addEventListener("sidebar:ready", bind);
})();
