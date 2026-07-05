const currentUserRaw = localStorage.getItem("nextlearnCurrentUser");
const SIDEBAR_COLLAPSED_STORAGE_KEY = "nextlearnSidebarCollapsed";
const PREFERRED_VIEW_KEY = "nextlearnPreferredView";

if (!currentUserRaw) {
  window.location.href = "/sign-in";
}

let currentUser = null;
try {
  currentUser = currentUserRaw ? JSON.parse(currentUserRaw) : null;
} catch (_error) {
  currentUser = null;
}

if (!currentUser || !currentUser.identifier) {
  localStorage.removeItem("nextlearnCurrentUser");
  window.location.href = "/sign-in";
}

let dom = null;
let dashCharts = { overall: null, modules: null, quizzes: null };
let dashData = null;

function buildDom() {
  return {
    shell: document.querySelector(".dashboard-shell"),
    sidebarToggleBtn: document.getElementById("sidebar-toggle-btn"),
    name: document.getElementById("student-name"),
    identifier: document.getElementById("student-identifier"),
    contentHeader: document.getElementById("content-header"),
    navItems: Array.from(document.querySelectorAll(".nav-item[data-view]")),
    views: {
      dashboard: document.getElementById("view-dashboard"),
      cours: document.getElementById("view-cours"),
      calendrier: document.getElementById("view-calendrier"),
      messages: document.getElementById("view-messages")
    },
    pageEyebrow: document.getElementById("page-eyebrow"),
    pageTitle: document.getElementById("page-title"),
    logoutBtn: document.getElementById("logout-btn"),
    modulesListSection: document.getElementById("modules-list-section"),
    modulesListGrid: document.getElementById("modules-list-grid"),
    coursStatsBar: document.querySelector(".cours-stats-bar"),
    moduleDetailSection: document.getElementById("module-detail-section"),
    moduleDetailTitle: document.getElementById("module-detail-title"),
    moduleDetailBack: document.getElementById("module-detail-back"),
    courseEmbedContent: document.getElementById("course-embed-content"),
    calendarList: document.getElementById("calendar-list"),
    messagesList: document.getElementById("messages-list"),
    lessonsCompleted: document.getElementById("stat-lessons-completed"),
    quizzesPassed: document.getElementById("stat-quizzes-passed"),
    quizAverage: document.getElementById("stat-quiz-average"),

    // New dashboard refs
    dashHeroName: document.getElementById("dash-hero-name"),
    dashHeroEyebrow: document.getElementById("dash-hero-eyebrow"),
    dashHeroXp: document.querySelector("#dash-hero-xp .hero-badge-value"),
    dashHeroStreak: document.querySelector("#dash-hero-streak .hero-badge-value"),
    dashHeroProgress: document.getElementById("dash-hero-progress"),
    dashHeroQuote: document.querySelector("#dash-hero-quote p"),
    dashPredPct: document.getElementById("dash-pred-pct"),
    dashPredRing: document.getElementById("dash-pred-ring"),
    dashPredMessage: document.getElementById("dash-pred-message"),
    dashPredFeatures: document.getElementById("dash-pred-features"),
    dashActionModule: document.getElementById("dash-action-module"),
    dashActionSub: document.getElementById("dash-action-sub"),
    dashActionCta: document.getElementById("dash-action-cta"),
    dashRadialContainer: document.getElementById("dash-radial-container"),
    dashTimelineContainer: document.getElementById("dash-timeline-container"),
    dashRadarContainer: document.getElementById("dash-radar-container"),
    dashHeatmapBody: document.getElementById("dash-heatmap-body"),
    dashHealthBody: document.getElementById("dash-health-body"),
    dashAchBody: document.getElementById("dash-achievements-body"),
    dashDeadlinesList: document.getElementById("dash-deadlines-list"),
    dashInsightsBody: document.getElementById("dash-insights-body"),
    dashWeakestBody: document.getElementById("dash-weakest-body"),
  dashModuleProgressBody: document.getElementById("dash-module-progress-body"),

    chatbotLauncher: document.getElementById("chatbot-launcher"),
    chatbotSidebarBtn: document.getElementById("chatbot-sidebar-btn"),
    chatbotPanel: document.getElementById("chatbot-panel"),
    chatbotCloseBtn: document.getElementById("chatbot-close-btn"),
    chatbotExpandBtn: document.getElementById("chatbot-expand-btn"),
    chatbotThread: document.getElementById("chatbot-thread"),
    chatbotForm: document.getElementById("chatbot-form"),
    chatbotInput: document.getElementById("chatbot-input"),
    chatbotSendBtn: document.getElementById("chatbot-send-btn"),
    chatbotFilterBtn: document.getElementById("chatbot-filter-btn")
  };
}

const dashboardCharts = {
  overall: null,
  modules: null,
  radar: null,
  quizzes: null
};

let dashboardRefreshTimer = null;
let chatbotBootstrapped = false;
let chatbotExpanded = false;
let chatbotFullscreen = false;
let chatbotFilteredMode = false;
let chatbotFilterModuleId = null;
let chatbotFilterSubAcquisId = null;

function syncChatbotFilterButton() {
  if (!dom.chatbotFilterBtn) {
    return;
  }

  dom.chatbotFilterBtn.setAttribute("aria-pressed", String(chatbotFilteredMode));
  dom.chatbotFilterBtn.textContent = chatbotFilteredMode ? "Tous les modules" : "Sous-acquis";
  dom.chatbotFilterBtn.title = chatbotFilteredMode
    ? "Passer aux modules disponibles"
    : `Revenir au sous-acquis ${chatbotFilterSubAcquisId || "actuel"}`;
}

function detectChatbotContext() {
  const params = new URLSearchParams(window.location.search);
  const moduleId = params.get("moduleId");
  const subAcquisId = params.get("subAcquisId");
  
  if (moduleId && subAcquisId) {
    chatbotFilteredMode = true;
    chatbotFilterModuleId = moduleId;
    chatbotFilterSubAcquisId = subAcquisId;
    
    // Show filter button if it exists
    if (dom.chatbotFilterBtn) {
      dom.chatbotFilterBtn.removeAttribute("hidden");
    }

    syncChatbotFilterButton();
  }
}

function initStudentApp() {
  dom = buildDom();
  renderProfile();
  detectChatbotContext();
  restoreSidebarPreference();
  loadDashboardData();
  void renderModuleList();
  initModuleListClicks();
  bindEvents();
  applyPreferredView();
}

function renderProfile() {
  dom.name.textContent = currentUser.fullName || currentUser.identifier;
  dom.identifier.textContent = `Identifiant: ${currentUser.identifier}`;
}

function bindEvents() {
  dom.navItems.forEach((button) => {
    button.addEventListener("click", () => {
      const viewKey = button.dataset.view || "cours";
      if (viewKey === "self-eval") {
        window.location.href = "/student/self-evaluation.html";
        return;
      }
      if (viewKey === "mission-apprenant") {
        window.location.href = "/student/mission-apprenant";
        return;
      }
      switchView(viewKey);
    });
  });

  dom.logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("nextlearnCurrentUser");
    window.location.href = "/auth/sign-in.html";
  });

  dom.chatbotLauncher?.addEventListener("click", () => {
    if (dom.chatbotPanel?.hasAttribute("hidden")) {
      openChatbotPanel({ fullscreen: false });
      return;
    }

    closeChatbotPanel();
  });

  dom.chatbotSidebarBtn?.addEventListener("click", () => {
    openChatbotPanel({ fullscreen: true });
  });

  dom.chatbotCloseBtn?.addEventListener("click", () => {
    closeChatbotPanel();
  });

  dom.chatbotExpandBtn?.addEventListener("click", () => {
    setChatbotFullscreen(!chatbotFullscreen);
  });

  dom.chatbotFilterBtn?.addEventListener("click", () => {
    toggleChatbotFilterMode();
  });

  dom.moduleDetailBack?.addEventListener("click", () => {
    closeModuleDetail();
  });

  dom.calendarList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const openButton = target.closest("[data-open-subacquis='1']");
    if (!(openButton instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    const moduleId = String(openButton.dataset.moduleId || "");
    const subAcquisId = String(openButton.dataset.subAcquisId || "");
    if (!moduleId || !subAcquisId) {
      return;
    }

    window.location.href = buildSubAcquisUrl(moduleId, subAcquisId);
  });

  window.addEventListener("focus", () => {
    if (getActiveViewKey() === "dashboard") {
      void loadDashboardData();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && getActiveViewKey() === "dashboard") {
      void loadDashboardData();
    }
  });

  dom.chatbotForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitChatbotQuestion();
  });
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);

  if (dom.sidebarToggleBtn) {
    dom.sidebarToggleBtn.setAttribute("aria-pressed", String(collapsed));
    dom.sidebarToggleBtn.setAttribute(
      "aria-label",
      collapsed ? "Agrandir la barre latérale" : "Réduire la barre latérale"
    );
  }
}

function toggleSidebarCollapsed() {
  const nextCollapsed = !document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(nextCollapsed);

  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, nextCollapsed ? "1" : "0");
  } catch (_error) {
    // Ignore storage failures and keep in-memory UI state.
  }
}

function restoreSidebarPreference() {
  let collapsed = false;

  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch (_error) {
    collapsed = false;
  }

  setSidebarCollapsed(collapsed);
}

function getActiveViewKey() {
  const activeButton = dom.navItems.find((button) => button.classList.contains("active"));
  return activeButton?.dataset.view || "cours";
}

function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh();
  dashboardRefreshTimer = window.setInterval(() => {
    if (getActiveViewKey() === "dashboard") {
      void loadDashboardData();
    }
  }, 25000);
}

function stopDashboardAutoRefresh() {
  if (dashboardRefreshTimer !== null) {
    window.clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
}

function openModuleDetail(moduleId, moduleName) {
  if (!dom.modulesListSection || !dom.moduleDetailSection) return;
  dom.modulesListSection.hidden = true;
  dom.moduleDetailSection.hidden = false;
  // The stats bar reflects progress within the open module, so show it only here.
  if (dom.coursStatsBar) dom.coursStatsBar.hidden = false;
  if (dom.moduleDetailTitle) dom.moduleDetailTitle.textContent = moduleName;
  dom.contentHeader?.setAttribute("hidden", "true");
  dom.shell?.classList.add("course-focus");
  if (dom.courseEmbedContent) {
    dom.courseEmbedContent.innerHTML = '<p class="course-embed-loading">Chargement…</p>';
  }
  void renderCourseModules(moduleId);
}

function closeModuleDetail() {
  if (!dom.modulesListSection || !dom.moduleDetailSection) return;
  dom.moduleDetailSection.hidden = true;
  dom.modulesListSection.hidden = false;
  if (dom.coursStatsBar) dom.coursStatsBar.hidden = true;
  dom.contentHeader?.removeAttribute("hidden");
  dom.shell?.classList.remove("course-focus");
}

function switchView(viewKey) {
  const labels = {
    dashboard: {
      eyebrow: "Dashboard",
      title: "Ma progression interactive"
    },
    cours: {
      eyebrow: "Cours",
      title: "Mes cours disponibles"
    },
    calendrier: {
      eyebrow: "Calendrier",
      title: "Plan"
    },
    messages: {
      eyebrow: "Messages",
      title: "Mes messages enseignants"
    }
  };

  dom.navItems.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewKey);
  });

  Object.entries(dom.views).forEach(([key, node]) => {
    node.classList.toggle("active", key === viewKey);
  });

  const pack = labels[viewKey] || labels.cours;
  dom.pageEyebrow.textContent = pack.eyebrow;
  dom.pageTitle.textContent = pack.title;

  if (viewKey === "dashboard") {
    startDashboardAutoRefresh();
    void loadDashboardData();
  } else {
    stopDashboardAutoRefresh();
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set("view", viewKey);
    window.history.replaceState({}, "", url.toString());
  } catch (_error) {
    // Ignore URL update failures.
  }

  dom.contentHeader?.removeAttribute("hidden");
}

function applyPreferredView() {
  const params = new URLSearchParams(window.location.search);
  const urlView = params.get("view");
  const urlModule = params.get("module");
  let preferredView = urlView;

  if (preferredView === "self-eval") {
    window.location.href = "/student/self-evaluation.html";
    return;
  }

  if (preferredView === "mission-apprenant") {
    window.location.href = "/student/mission-apprenant";
    return;
  }

  if (!preferredView) {
    try {
      // Fallback to sessionStorage only if no URL param is present.
      preferredView = sessionStorage.getItem(PREFERRED_VIEW_KEY);
    } catch (_error) {
      preferredView = null;
    }
  }

  // The default view is 'dashboard' if nothing else is specified.
  const targetView = preferredView && dom?.views?.[preferredView] ? preferredView : 'dashboard';
  switchView(targetView);

  if (targetView === "cours" && urlModule) {
    void fetchModuleDetail(urlModule).then((detail) => {
      if (detail) openModuleDetail(urlModule, detail.name || urlModule);
    });
  }

  // Clean up the session storage key after using it.
  try {
    if (sessionStorage.getItem(PREFERRED_VIEW_KEY)) {
      sessionStorage.removeItem(PREFERRED_VIEW_KEY);
    }
  } catch (_error) {
    // Ignore storage errors.
  }
}

function appendChatMessage(role, text) {
  if (!dom.chatbotThread) {
    return;
  }

  const bubble = document.createElement("article");
  bubble.className = `chatbot-bubble ${role === "user" ? "user" : "bot"}`;
  bubble.textContent = String(text || "").trim();
  dom.chatbotThread.appendChild(bubble);
  dom.chatbotThread.scrollTop = dom.chatbotThread.scrollHeight;
}

function openChatbotPanel(options = {}) {
  if (!dom.chatbotPanel) {
    return;
  }

  const fullscreen = Boolean(options.fullscreen);

  dom.chatbotPanel.removeAttribute("hidden");
  dom.chatbotLauncher?.setAttribute("aria-expanded", "true");
  setChatbotFullscreen(fullscreen);
  ensureChatbotWelcome();
  document.body.classList.add("chatbot-open");

  window.requestAnimationFrame(() => {
    dom.chatbotInput?.focus();
  });
}

function closeChatbotPanel() {
  if (!dom.chatbotPanel) {
    return;
  }

  dom.chatbotPanel.setAttribute("hidden", "true");
  dom.chatbotLauncher?.setAttribute("aria-expanded", "false");
  setChatbotFullscreen(false);
  document.body.classList.remove("chatbot-open");
}

function setChatbotFullscreen(expanded) {
  chatbotFullscreen = Boolean(expanded);
  chatbotExpanded = chatbotFullscreen;

  dom.chatbotPanel?.classList.toggle("is-expanded", chatbotExpanded);
  dom.chatbotPanel?.classList.toggle("is-fullscreen", chatbotFullscreen);

  if (dom.chatbotExpandBtn) {
    dom.chatbotExpandBtn.textContent = chatbotExpanded ? "⤡" : "⤢";
    dom.chatbotExpandBtn.setAttribute(
      "aria-label",
      chatbotExpanded ? "Réduire l'assistant" : "Agrandir l'assistant"
    );
  }
}

function toggleChatbotFilterMode() {
  chatbotFilteredMode = !chatbotFilteredMode;

  syncChatbotFilterButton();
}

function ensureChatbotWelcome() {
  if (chatbotBootstrapped || !dom.chatbotThread) {
    return;
  }

  appendChatMessage("bot", "Bonjour et bienvenue sur NextLearn 👋 Je suis votre assistant intelligent, conçu pour vous accompagner dans votre apprentissage personnalisé. Posez-moi votre question, que ce soit pour comprendre un concept, trouver des ressources adaptées ou construire votre parcours d’apprentissage et je vous répondrai immédiatement avec des recommandations sur mesure.");

  chatbotBootstrapped = true;
}

async function submitChatbotQuestion() {
  const question = String(dom.chatbotInput?.value || "").trim();
  if (!question) {
    return;
  }

  ensureChatbotWelcome();
  appendChatMessage("user", question);

  if (dom.chatbotInput) {
    dom.chatbotInput.value = "";
  }

  if (dom.chatbotSendBtn instanceof HTMLButtonElement) {
    dom.chatbotSendBtn.disabled = true;
  }

  try {
    const body = {
      identifier: currentUser?.identifier || "",
      message: question
    };
    
    if (chatbotFilteredMode && chatbotFilterModuleId && chatbotFilterSubAcquisId) {
      body.filterToModuleId = chatbotFilterModuleId;
      body.filterToSubAcquisId = chatbotFilterSubAcquisId;
    }

    const response = await fetch("/api/student/chatbot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      appendChatMessage("bot", String(payload?.message || "Je n'ai pas pu traiter votre question."));
      return;
    }

    appendChatMessage("bot", String(payload?.answer || "Je n'ai pas trouvé de réponse pertinente."));

    // Keep the conversation focused on the answer; sources remain available in API payload if needed.
  } catch (_error) {
    appendChatMessage("bot", "Une erreur réseau est survenue. Réessayez dans un instant.");
  } finally {
    if (dom.chatbotSendBtn instanceof HTMLButtonElement) {
      dom.chatbotSendBtn.disabled = false;
    }
  }
}

function renderCalendar(calendarEntries = [], scheduleStartDate = null) {
  if (!Array.isArray(calendarEntries) || calendarEntries.length === 0) {
    dom.calendarList.innerHTML = '<p class="calendar-empty">Aucune activité planifiée pour le moment.</p>';
    return;
  }

  const labelFormatter = new Intl.DateTimeFormat("fr-TN", {
    month: "long",
    year: "numeric"
  });
  const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const shortDateFormatter = new Intl.DateTimeFormat("fr-TN", {
    month: "2-digit",
    day: "2-digit"
  });

  function getWeekStart(date) {
    const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = normalized.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    normalized.setDate(normalized.getDate() + mondayOffset);
    return normalized;
  }

  const usableEntries = calendarEntries
    .map((entry) => {
      const unlockDate = entry?.unlockAt ? new Date(String(entry.unlockAt)) : null;
      if (!unlockDate || Number.isNaN(unlockDate.getTime())) {
        return null;
      }

      return {
        ...entry,
        unlockDate
      };
    })
    .filter((entry) => Boolean(entry));

  if (!usableEntries.length) {
    dom.calendarList.innerHTML = '<p class="calendar-empty">Aucune date de déblocage disponible.</p>';
    return;
  }

  const earliestDate = usableEntries.reduce((earliest, entry) => {
    return entry.unlockDate.getTime() < earliest.getTime() ? entry.unlockDate : earliest;
  }, usableEntries[0].unlockDate);

  const baseYear = earliestDate.getMonth() >= 8 ? earliestDate.getFullYear() : earliestDate.getFullYear() - 1;

  const allMonths = usableEntries
    .map((entry) => ({
      year: entry.unlockDate.getFullYear(),
      month: entry.unlockDate.getMonth()
    }))
    .map(({ year, month }) => `${year}-${String(month).padStart(2, "0")}`);

  const preferredMonthSet = new Set(
    usableEntries
      .map((entry) => ({
        year: entry.unlockDate.getFullYear(),
        month: entry.unlockDate.getMonth()
      }))
      .filter(({ year, month }) =>
        (year === baseYear && month >= 8 && month <= 11) ||
        (year === baseYear + 1 && month === 0)
      )
      .map(({ year, month }) => `${year}-${String(month).padStart(2, "0")}`)
  );

  const monthSet = preferredMonthSet.size ? preferredMonthSet : new Set(allMonths);

  const monthPlan = Array.from(monthSet)
    .map((key) => {
      const [yearRaw, monthRaw] = key.split("-");
      return {
        year: Number(yearRaw),
        month: Number(monthRaw)
      };
    })
    .sort((a, b) => new Date(a.year, a.month, 1).getTime() - new Date(b.year, b.month, 1).getTime());

  if (!monthPlan.length) {
    dom.calendarList.innerHTML = '<p class="calendar-empty">Aucune activité planifiée pour le moment.</p>';
    return;
  }

  const entriesByDate = usableEntries.reduce((acc, entry) => {
    const dayKey = dateKeyFormatter.format(entry.unlockDate);
    if (!acc.has(dayKey)) {
      acc.set(dayKey, []);
    }

    acc.get(dayKey).push(entry);
    return acc;
  }, new Map());

  const startDate = scheduleStartDate ? new Date(String(scheduleStartDate)) : null;
  const hasValidStartDate = Boolean(startDate && !Number.isNaN(startDate.getTime()));
  const normalizedStartDate = hasValidStartDate
    ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
    : null;
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  const calendarMarkup = monthPlan
    .map(({ year, month }, monthIndex) => {
      const firstOfMonth = new Date(year, month, 1);
      const lastOfMonth = new Date(year, month + 1, 0);
      const monthLabel = labelFormatter.format(firstOfMonth);

      const weekBlocks = [];
      let weekIndex = 0;
      let cursor = getWeekStart(firstOfMonth);

      while (cursor.getTime() <= lastOfMonth.getTime()) {
        const weekStart = new Date(cursor);
        const weekEnd = new Date(cursor);
        weekEnd.setDate(weekEnd.getDate() + 6);

        const rangeStart = weekStart.getTime() < firstOfMonth.getTime() ? firstOfMonth : weekStart;
        const rangeEnd = weekEnd.getTime() > lastOfMonth.getTime() ? lastOfMonth : weekEnd;

        const entriesForWeek = [];
        for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
          const currentDay = new Date(weekStart);
          currentDay.setDate(currentDay.getDate() + dayOffset);
          if (currentDay.getMonth() !== month || currentDay.getFullYear() !== year) {
            continue;
          }

          const dayKey = dateKeyFormatter.format(currentDay);
          const entries = entriesByDate.get(dayKey) || [];
          entriesForWeek.push(...entries);
        }

        const chips = entriesForWeek
          .map((entry) => {
            const subId = String(entry.subAcquisId || "");
            const subName = String(entry.subAcquisName || subId || "Sous-acquis");
            const moduleId = String(entry.moduleId || "");
            const isUnlocked = Boolean(entry?.unlocked);
            const statusText = isUnlocked ? "Disponible" : "Indisponible";
            const statusClass = isUnlocked ? "is-available" : "is-unavailable";
            const chipClass = isUnlocked ? "is-unlocked" : "is-locked";
            const accessAction = isUnlocked
              ? `<button type="button" class="calendar-popover-action" data-open-subacquis="1" data-module-id="${htmlEscape(moduleId)}" data-sub-acquis-id="${htmlEscape(subId)}">Accéder au sous-acquis</button>`
              : '<span class="calendar-popover-action disabled">Toujours indisponible</span>';

            return `
              <span class="calendar-chip-shell">
                <button type="button" class="calendar-sub-id ${chipClass}" aria-label="${htmlEscape(subName)}">${htmlEscape(subId)}</button>
                <aside class="calendar-popover" role="tooltip">
                  <p class="calendar-popover-title">${htmlEscape(subName)}</p>
                  <p class="calendar-popover-status ${statusClass}">${statusText}</p>
                  ${accessAction}
                </aside>
              </span>
            `;
          })
          .join("");

        if (!chips) {
          cursor.setDate(cursor.getDate() + 7);
          continue;
        }

        const weekLabel = (() => {
          if (!normalizedStartDate) {
            return "Semaine";
          }

          if (weekEnd.getTime() < normalizedStartDate.getTime()) {
            return "Avant démarrage";
          }

          const elapsed = weekEnd.getTime() - normalizedStartDate.getTime();
          const weekNumber = Math.floor(elapsed / weekMs) + 1;
          return `Semaine ${Math.max(1, weekNumber)}`;
        })();

        weekBlocks.push(`
          <section class="calendar-week" style="--week-delay:${weekIndex * 55}ms">
            <header class="calendar-week-head">
              <span class="calendar-week-label">${weekLabel}</span>
              <span class="calendar-week-range">${shortDateFormatter.format(rangeStart)} - ${shortDateFormatter.format(rangeEnd)}</span>
            </header>
            <div class="calendar-week-items">
              ${chips}
            </div>
          </section>
        `);
        weekIndex += 1;

        cursor.setDate(cursor.getDate() + 7);
      }

      return `
        <article class="calendar-month" style="--month-delay:${monthIndex * 95}ms">
          <h4>${monthLabel}</h4>
          <div class="calendar-weeks">${weekBlocks.join("")}</div>
        </article>
      `;
    })
    .join("");

  dom.calendarList.innerHTML = calendarMarkup;
}

function buildSubAcquisUrl(moduleId, subAcquisId) {
  return `/student/sous-acquis.html?moduleId=${encodeURIComponent(String(moduleId || ""))}&subAcquisId=${encodeURIComponent(String(subAcquisId || ""))}`;
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMessages(stats, modules = []) {
  const totalLessons = Array.isArray(modules)
    ? modules.reduce((sum, moduleData) => sum + Number(moduleData.subAcquisCount || 0), 0)
    : 0;

  const lessonsCompleted = Number(stats?.lessonsCompleted) || 0;
  const quizzesPassed = Number(stats?.quizzesPassed) || 0;
  const average = Number(stats?.averageQuizScoreOn20);

  const progressPercent = totalLessons > 0 ? Math.round((lessonsCompleted / totalLessons) * 100) : 0;
  const avgLabel = Number.isFinite(average) ? `${average.toFixed(1)}/20` : "0.0/20";

  const systemMessages = [
    {
      subject: "Progression du cours",
      body:
        totalLessons > 0
          ? `Vous avez complété ${lessonsCompleted} leçon(s) sur ${totalLessons} (${progressPercent}%).`
          : `Votre progression actuelle est de ${lessonsCompleted} leçon(s) complétée(s).`,
      date: "Mise à jour automatique"
    },
    {
      subject: "Resultats des quiz",
      body: `Vous avez valide ${quizzesPassed} quiz, avec une moyenne de ${avgLabel}.`,
      date: "Mise à jour automatique"
    }
  ];

  dom.messagesList.innerHTML = systemMessages
    .map(
      (message) => `
        <article class="message-item">
          <h4>${message.subject}</h4>
          <p>${message.body}</p>
          <p class="message-meta">NextLearn - ${message.date}</p>
        </article>
      `
    )
    .join("");
}

async function fetchProgressStats() {
  if (!currentUser?.identifier) return null;

  try {
    const response = await fetch(
      `/api/student/progress/${encodeURIComponent(currentUser.identifier)}`
    );

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function fetchAndRenderPrediction() {
  if (!currentUser?.identifier) return;

  try {
    const response = await fetch(
      `/api/student/prediction/${encodeURIComponent(currentUser.identifier)}`
    );
    if (!response.ok) return;

    const data = await response.json();
    const prob = Number(data.catchupProbability);
    if (!Number.isFinite(prob)) return;

    const pct = Math.round(prob * 100);
    const badgeRow = document.getElementById("prediction-badge-row");
    const badge = document.getElementById("prediction-badge");
    const valueEl = document.getElementById("prediction-badge-value");
    const pctEl = document.getElementById("prediction-badge-pct");

    if (!badgeRow || !badge || !valueEl || !pctEl) return;

    let label, colorClass;
    if (pct >= 70) {
      label = "Vous êtes sur la bonne voie — forte probabilité de rattrapage !";
      colorClass = "is-high";
    } else if (pct >= 40) {
      label = "Des efforts supplémentaires sont recommandés pour rattraper votre niveau.";
      colorClass = "is-mid";
    } else {
      label = "Risque de décrochage détecté — consultez votre enseignant.";
      colorClass = "is-low";
    }

    badge.className = `prediction-badge ${colorClass}`;
    valueEl.textContent = label;
    pctEl.textContent = `${pct}%`;
    badgeRow.style.display = "block";
  } catch (_e) {
    // Silently ignore prediction fetch errors
  }
}

async function fetchModules() {
  try {
    const identifier = encodeURIComponent(String(currentUser?.identifier || ""));
    const response = await fetch(`/api/student/modules?identifier=${identifier}`);
    if (!response.ok) return [];

    const data = await response.json();
    const modules = Array.isArray(data.modules) ? data.modules : [];
    return modules
      .map((moduleData, index) => ({ ...moduleData, __index: index }))
      .sort((a, b) => {
        const aOrder = Number(a?.sortOrder);
        const bOrder = Number(b?.sortOrder);
        const aHas = Number.isFinite(aOrder);
        const bHas = Number.isFinite(bOrder);
        if (aHas && bHas) return aOrder - bOrder;
        if (aHas) return -1;
        if (bHas) return 1;
        return Number(a.__index) - Number(b.__index);
      })
      .map(({ __index, ...moduleData }) => moduleData);
  } catch (_error) {
    return [];
  }
}

function buildLessonKey(moduleId, subAcquisId) {
  return `${moduleId}::${subAcquisId}`;
}

function buildLatestScoreMap(quizResults) {
  const map = new Map();
  if (!Array.isArray(quizResults)) return map;

  quizResults.forEach((entry) => {
    const moduleId = String(entry?.moduleId || "");
    const subAcquisId = String(entry?.subAcquisId || "");
    const score = Number(entry?.score);
    const submittedAt = entry?.submittedAt ? new Date(String(entry.submittedAt)).getTime() : 0;
    if (!moduleId || !subAcquisId || !Number.isFinite(score)) {
      return;
    }

    const key = buildLessonKey(moduleId, subAcquisId);
    const existing = map.get(key);
    if (!existing || submittedAt >= existing.submittedAt) {
      map.set(key, { score, submittedAt });
    }
  });

  return map;
}

function getQuizBubbleStatus(score, average) {
  if (!Number.isFinite(score)) {
    return { className: "is-gray", label: "Quiz", title: "Quiz non passe" };
  }
  if (!Number.isFinite(average)) {
    return { className: "is-orange", label: "Quiz", title: `Score ${Math.round(score)}%` };
  }

  const delta = score - average;
  if (delta > 2) {
    return {
      className: "is-green",
      label: "Quiz",
      title: `Score ${Math.round(score)}% - Moy ${Math.round(average)}%`
    };
  }
  if (delta < -2) {
    return {
      className: "is-red",
      label: "Quiz",
      title: `Score ${Math.round(score)}% - Moy ${Math.round(average)}%`
    };
  }

  return {
    className: "is-orange",
    label: "Quiz",
    title: `Score ${Math.round(score)}% - Moy ${Math.round(average)}%`
  };
}

async function fetchModuleDetail(moduleId) {
  try {
    const response = await fetch(`/api/student/module/${encodeURIComponent(String(moduleId || ""))}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.module || null;
  } catch (_error) {
    return null;
  }
}

async function renderCourseModules(filterModuleId = null) {
  if (!dom.courseEmbedContent) return false;

  dom.courseEmbedContent.innerHTML = '<p class="course-embed-loading">Chargement…</p>';

  const [moduleData, stats] = await Promise.all([
    filterModuleId ? fetchModuleDetail(filterModuleId) : null,
    fetchProgressStats()
  ]);

  if (!moduleData) {
    dom.courseEmbedContent.innerHTML = '<p class="course-embed-loading">Aucun contenu disponible.</p>';
    return false;
  }

  const completedSet = new Set(
    (Array.isArray(stats?.completedLessonKeys) ? stats.completedLessonKeys : [])
      .filter((k) => typeof k === "string")
  );
  const quizResults = Array.isArray(stats?.quizResults) ? stats.quizResults : [];
  const scoreMap = buildLatestScoreMap(quizResults);
  const scores = quizResults.map((e) => Number(e?.score)).filter((s) => Number.isFinite(s));
  const averageScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const acquis = Array.isArray(moduleData.acquis) ? moduleData.acquis : [];

  if (!acquis.length) {
    dom.courseEmbedContent.innerHTML = '<p class="course-embed-empty">Ce module ne contient pas encore de contenu.</p>';
    return false;
  }

  const allSubs = acquis.flatMap((a) => Array.isArray(a.sousAcquis) ? a.sousAcquis : []);
  const totalSubs = allSubs.length;
  const doneSubs = allSubs.filter((s) => completedSet.has(buildLessonKey(filterModuleId, s.id))).length;
  const totalPct = totalSubs > 0 ? Math.round((doneSubs / totalSubs) * 100) : 0;

  let html = `
    <div class="module-detail-progress">
      <div class="module-detail-progress-info">
        <span>${doneSubs} / ${totalSubs} sous-acquis complétés</span>
        <strong>${totalPct}%</strong>
      </div>
      <div class="module-detail-track">
        <div class="module-detail-fill" style="width:${totalPct}%"></div>
      </div>
    </div>
    <div class="acquis-list">
  `;

  acquis.forEach((acq, acqIdx) => {
    const subs = Array.isArray(acq.sousAcquis) ? acq.sousAcquis : [];
    const acqDone = subs.filter((s) => completedSet.has(buildLessonKey(filterModuleId, s.id))).length;
    const acqPct = subs.length > 0 ? Math.round((acqDone / subs.length) * 100) : 0;
    const acqStatusClass = acqPct === 100 ? "acq-status-done" : acqDone > 0 ? "acq-status-partial" : "acq-status-idle";
    const acqIcon = acqPct === 100 ? "✓" : acqDone > 0 ? "◎" : "○";

    html += `
      <section class="acquis-section">
        <button class="acquis-header" type="button" data-acq-idx="${acqIdx}" aria-expanded="true">
          <span class="acquis-icon ${acqStatusClass}">${acqIcon}</span>
          <span class="acquis-title">${htmlEscape(acq.name || `Acquis ${acqIdx + 1}`)}</span>
          <span class="acquis-meta">${acqDone}/${subs.length} · ${acqPct}%</span>
          <span class="acquis-chevron">▾</span>
        </button>
        <ul class="acquis-sub-list">
    `;

    subs.forEach((sub) => {
      const key = buildLessonKey(filterModuleId, sub.id);
      const done = completedSet.has(key);
      const scoreEntry = scoreMap.get(key);
      const score = scoreEntry ? scoreEntry.score : NaN;
      const quizStatus = getQuizBubbleStatus(score, averageScore);
      const lessonHref = buildSubAcquisUrl(filterModuleId, sub.id);
      const quizHref = `/student/questionnaire.html?moduleId=${encodeURIComponent(String(filterModuleId || ""))}&subAcquisId=${encodeURIComponent(String(sub.id || ""))}`;

      const checkHtml = done
        ? `<span class="sub-check">✓</span>`
        : `<span class="sub-check sub-check-empty">○</span>`;

      const bloomHtml = sub.bloomLevel
        ? `<span class="sub-bloom">${htmlEscape(sub.bloomLevel)}</span>`
        : "";

      const badges = [];
      if (sub.hasVideo) badges.push(`<span class="sub-badge sub-badge-video">Vidéo</span>`);
      if (sub.hasQuiz) {
        badges.push(`<a class="sub-badge sub-badge-quiz quiz-bubble ${quizStatus.className}" href="${quizHref}" title="${htmlEscape(quizStatus.title)}">Quiz</a>`);
      }

      html += `
        <li class="acquis-sub-entry${done ? " sub-done" : ""}">
          ${checkHtml}
          <div class="sub-content">
            <a class="sub-lesson-link" href="${lessonHref}">${htmlEscape(sub.name || sub.id)}</a>
            ${bloomHtml}
          </div>
          <div class="sub-actions">${badges.join("")}</div>
        </li>
      `;
    });

    html += `</ul></section>`;
  });

  html += `</div>`;

  dom.courseEmbedContent.innerHTML = html;

  dom.courseEmbedContent.querySelectorAll(".acquis-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      const list = btn.nextElementSibling;
      if (list) list.hidden = expanded;
    });
  });

  return true;
}

async function renderModuleList() {
  if (!dom.modulesListGrid) return;

  const [modules, stats] = await Promise.all([fetchModules(), fetchProgressStats()]);

  if (!modules.length) {
    dom.modulesListGrid.innerHTML = '<p class="modules-loading">Aucun module disponible.</p>';
    return;
  }

  const completedSet = new Set(
    (Array.isArray(stats?.completedLessonKeys) ? stats.completedLessonKeys : [])
      .filter((k) => typeof k === "string")
  );
  const quizResults = Array.isArray(stats?.quizResults) ? stats.quizResults : [];
  const scoreMap = buildLatestScoreMap(quizResults);

  dom.modulesListGrid.innerHTML = modules.map((mod) => {
    const subItems = Array.isArray(mod.subAcquisDetails)
      ? mod.subAcquisDetails
      : (Array.isArray(mod.subAcquis) ? mod.subAcquis.map((id) => ({ id })) : []);

    const total = subItems.length;
    const done = subItems.filter((s) => completedSet.has(buildLessonKey(mod.id, s.id))).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const quizScores = subItems
      .map((s) => scoreMap.get(buildLessonKey(mod.id, s.id))?.score)
      .filter((v) => Number.isFinite(v));
    const avgScore = quizScores.length
      ? quizScores.reduce((a, b) => a + b, 0) / quizScores.length
      : null;
    const avgLabel = avgScore !== null ? `${Math.round(avgScore)}%` : "—";

    const statusClass = pct === 100 ? "mcard-done" : done > 0 ? "mcard-progress" : "mcard-idle";
    const statusLabel = pct === 100 ? "Terminé" : done > 0 ? "En cours" : "Non commencé";

    const modId = String(mod.id || "");
    const modName = htmlEscape(mod.name || `Module ${modId}`);

    return `<article class="module-card" data-module-id="${htmlEscape(modId)}" data-module-name="${modName}">
      <div class="mcard-header">
        <h3 class="mcard-name">${modName}</h3>
        <span class="mcard-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="mcard-meta">${total} sous-acquis · Quiz moy. ${avgLabel}</div>
      <div class="mcard-track">
        <div class="mcard-fill" style="width:${pct}%"></div>
      </div>
      <div class="mcard-footer">
        <span class="mcard-pct">${done}/${total} leçons · ${pct}%</span>
        <button class="mcard-btn" type="button" data-module-id="${htmlEscape(modId)}" data-module-name="${modName}">Accéder →</button>
      </div>
    </article>`;
  }).join("");

}

function initModuleListClicks() {
  dom.modulesListSection?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-module-id]");
    if (!btn) return;
    const id = btn.dataset.moduleId;
    const name = btn.dataset.moduleName || id;
    if (id) openModuleDetail(id, name);
  });
}


async function fetchOverview() {
  try {
    const identifier = encodeURIComponent(String(currentUser?.identifier || ""));
    const response = await fetch(`/api/programmation-c/overview?identifier=${identifier}`);
    if (!response.ok) return [];

    const data = await response.json();
    const modules = Array.isArray(data.modules) ? data.modules : [];
    return modules
      .map((moduleData, index) => ({ ...moduleData, __index: index }))
      .sort((a, b) => {
        const aOrder = Number(a?.sortOrder);
        const bOrder = Number(b?.sortOrder);
        const aHas = Number.isFinite(aOrder);
        const bHas = Number.isFinite(bOrder);
        if (aHas && bHas) return aOrder - bOrder;
        if (aHas) return -1;
        if (bHas) return 1;
        return Number(a.__index) - Number(b.__index);
      })
      .map(({ __index, ...moduleData }) => moduleData);
  } catch (_error) {
    return [];
  }
}

async function fetchStudentCalendar() {
  try {
    const identifier = encodeURIComponent(String(currentUser?.identifier || ""));
    const response = await fetch(`/api/student/calendar?identifier=${identifier}`);
    if (!response.ok) return { calendar: [], startDate: null };

    const data = await response.json();
    return {
      calendar: Array.isArray(data?.calendar) ? data.calendar : [],
      startDate: typeof data?.startDate === "string" ? data.startDate : null
    };
  } catch (_error) {
    return { calendar: [], startDate: null };
  }
}

function toPercent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function buildDashboardMetrics(overview = [], stats = null) {
  const completedLessonKeys = Array.isArray(stats?.completedLessonKeys) ? stats.completedLessonKeys : [];
  const quizResults = Array.isArray(stats?.quizResults) ? stats.quizResults : [];

  const completedSet = new Set(completedLessonKeys.filter((entry) => typeof entry === "string"));
  const quizPassedSet = new Set(
    quizResults
      .map((entry) => (typeof entry?.lessonKey === "string" ? entry.lessonKey : ""))
      .filter(Boolean)
  );

  const moduleRows = Array.isArray(overview)
    ? overview.map((moduleData) => {
        const subAcquis = Array.isArray(moduleData?.subAcquis) ? moduleData.subAcquis : [];
        const moduleId = String(moduleData?.id || "-");

        let lessonsCompleted = 0;
        let quizCount = 0;
        let quizzesPassed = 0;
        let videoCount = 0;
        let videosViewed = 0;

        for (const sub of subAcquis) {
          const subId = String(sub?.id || "");
          const key = `${moduleId}::${subId}`;
          const hasQuiz = Boolean(sub?.hasQuiz);
          const hasVideo = Boolean(sub?.hasVideo);
          const lessonDone = completedSet.has(key);

          if (lessonDone) lessonsCompleted += 1;
          if (hasQuiz) {
            quizCount += 1;
            if (quizPassedSet.has(key)) {
              quizzesPassed += 1;
            }
          }
          if (hasVideo) {
            videoCount += 1;
            if (lessonDone) {
              videosViewed += 1;
            }
          }
        }

        return {
          id: moduleId,
          lessonCount: subAcquis.length,
          lessonsCompleted,
          lessonPercent: toPercent(lessonsCompleted, subAcquis.length),
          quizCount,
          quizzesPassed,
          quizPercent: toPercent(quizzesPassed, quizCount),
          videoCount,
          videosViewed,
          videoPercent: toPercent(videosViewed, videoCount)
        };
      })
    : [];

  const totals = moduleRows.reduce(
    (acc, moduleRow) => {
      acc.modules += 1;
      acc.lessons += moduleRow.lessonCount;
      acc.lessonsCompleted += moduleRow.lessonsCompleted;
      acc.quizzes += moduleRow.quizCount;
      acc.quizzesPassed += moduleRow.quizzesPassed;
      acc.videos += moduleRow.videoCount;
      acc.videosViewed += moduleRow.videosViewed;
      acc.modulesInProgress += moduleRow.lessonsCompleted > 0 ? 1 : 0;
      return acc;
    },
    {
      modules: 0,
      modulesInProgress: 0,
      lessons: 0,
      lessonsCompleted: 0,
      quizzes: 0,
      quizzesPassed: 0,
      videos: 0,
      videosViewed: 0
    }
  );

  return {
    moduleRows,
    totals,
    percentages: {
      lessons: toPercent(totals.lessonsCompleted, totals.lessons),
      quizzes: toPercent(totals.quizzesPassed, totals.quizzes),
      videos: toPercent(totals.videosViewed, totals.videos)
    }
  };
}

async function buildOverviewFallback(modules = []) {
  if (!Array.isArray(modules)) return [];

  const identifier = encodeURIComponent(String(currentUser?.identifier || ""));

  const moduleRows = await Promise.all(
    modules.map(async (moduleData) => {
      const moduleId = String(moduleData?.id || "-");
      const subList = Array.isArray(moduleData?.subAcquis) ? moduleData.subAcquis : [];

      const subAcquis = await Promise.all(
        subList.map(async (subIdRaw) => {
          const subId = String(subIdRaw || "");

          try {
            const response = await fetch(
              `/api/programmation-c/sub-acquis/${encodeURIComponent(moduleId)}/${encodeURIComponent(subId)}?identifier=${identifier}`
            );

            if (!response.ok) {
              return { id: subId, hasQuiz: false, hasVideo: false };
            }

            const payload = await response.json();
            const hasVideo = Array.isArray(payload?.videoFiles) && payload.videoFiles.length > 0;
            const hasQuiz = Number(payload?.quizQuestionCount) > 0;

            return {
              id: subId,
              hasQuiz,
              hasVideo
            };
          } catch (_error) {
            return { id: subId, hasQuiz: false, hasVideo: false };
          }
        })
      );

      return {
        id: moduleId,
        subAcquisCount: subAcquis.length,
        subAcquis
      };
    })
  );

  return moduleRows;
}

function destroyDashboardCharts() {
  Object.keys(dashboardCharts).forEach((key) => {
    const chart = dashboardCharts[key];
    if (chart && typeof chart.destroy === "function") {
      chart.destroy();
      dashboardCharts[key] = null;
    }
  });
}

function chartTickColor() {
  return "#4a5263";
}

function renderDashboardCharts(metrics) {
  const chartFactory = window.Chart;
  if (!chartFactory) {
    return;
  }

  destroyDashboardCharts();

  const moduleLabels = metrics.moduleRows.map((row) => `M${row.id}`);

  if (dom.chartOverall) {
    dashboardCharts.overall = new chartFactory(dom.chartOverall, {
      type: "doughnut",
      data: {
        labels: ["Leçons", "Quiz", "Vidéos"],
        datasets: [
          {
            data: [
              metrics.percentages.lessons,
              metrics.percentages.quizzes,
              metrics.percentages.videos
            ],
            backgroundColor: ["#c9152a", "#f59e0b", "#0ea5e9"],
            borderWidth: 0,
            hoverOffset: 10
          }
        ]
      },
      options: {
        aspectRatio: 1,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: chartTickColor() }
          }
        }
      }
    });
  }

  if (dom.chartModuleProgress) {
    // Module progress bar chart
    dashboardCharts.modules = new chartFactory(dom.chartModuleProgress, {
      type: "bar",
      data: {
        labels: moduleLabels,
        datasets: [
          {
            label: "Leçons complétées (%)",
            data: metrics.moduleRows.map((row) => row.lessonPercent),
            backgroundColor: "rgba(201, 21, 42, 0.85)",
            borderRadius: 8
          }
        ]
      },
      options: {
        aspectRatio: 1.8,
        maintainAspectRatio: true,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { color: chartTickColor() }
          },
          x: {
            ticks: { color: chartTickColor() }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }

  if (dom.chartSkillRadar) {
    // Skill radar showing per-module lesson completion percentages
    dashboardCharts.radar = new chartFactory(dom.chartSkillRadar, {
      type: "radar",
      data: {
        labels: moduleLabels,
        datasets: [
          {
            label: "Leçons complétées (%)",
            data: metrics.moduleRows.map((row) => row.lessonPercent),
            backgroundColor: "rgba(201, 21, 42, 0.18)",
            borderColor: "rgba(201, 21, 42, 0.95)",
            pointBackgroundColor: "#c9152a",
            pointRadius: 4,
            fill: true
          }
        ]
      },
      options: {
        aspectRatio: 1,
        maintainAspectRatio: true,
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            grid: { color: 'rgba(74,82,99,0.06)' },
            angleLines: { color: 'rgba(74,82,99,0.06)' },
            ticks: { color: chartTickColor(), backdropColor: 'transparent' }
          }
        },
        plugins: {
          legend: { position: 'top', labels: { color: chartTickColor() } }
        }
      }
    });
  }

  if (dom.chartQuizzes) {
    dashboardCharts.quizzes = new chartFactory(dom.chartQuizzes, {
      type: "line",
      data: {
        labels: moduleLabels,
        datasets: [
          {
            label: "Quiz valides (%)",
            data: metrics.moduleRows.map((row) => row.quizPercent),
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245, 158, 11, 0.25)",
            tension: 0.3,
            fill: true,
            pointRadius: 4
          }
        ]
      },
      options: {
        aspectRatio: 1.8,
        maintainAspectRatio: true,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { color: chartTickColor() }
          },
          x: {
            ticks: { color: chartTickColor() }
          }
        }
      }
    });
  }
}

function renderStudentDashboard(metrics) {
  if (!dom.dashKpiLessons) return;

  dom.dashKpiLessons.textContent = `${metrics.totals.lessonsCompleted}/${metrics.totals.lessons}`;
  dom.dashKpiModules.textContent = `${metrics.totals.modulesInProgress}/${metrics.totals.modules}`;
  dom.dashKpiQuizzes.textContent = `${metrics.totals.quizzesPassed}/${metrics.totals.quizzes}`;
  dom.dashKpiVideos.textContent = `${metrics.totals.videosViewed}/${metrics.totals.videos}`;

  if (dom.dashboardSummaryLine) {
    dom.dashboardSummaryLine.textContent =
      `Progression globale: ${metrics.percentages.lessons}% leçons, ` +
      `${metrics.percentages.quizzes}% quiz et ${metrics.percentages.videos}% videos.`;
  }

  renderDashboardCharts(metrics);
}

function renderNextStep(modules = [], stats = null) {
  if (!dom.nextStepModule || !dom.nextStepMeta || !dom.nextStepCta) return;

  const completedKeys = Array.isArray(stats?.completedLessonKeys) ? stats.completedLessonKeys : [];
  const completedSet = new Set(completedKeys.filter(k => typeof k === 'string'));

  for (const moduleData of modules) {
    const moduleId = String(moduleData?.id || "");
    const subItems = Array.isArray(moduleData?.subAcquisDetails)
      ? moduleData.subAcquisDetails
      : Array.isArray(moduleData?.subAcquis)
        ? moduleData.subAcquis.map(id => ({ id, name: `Sous-acquis ${id}` }))
        : [];

    for (const sub of subItems) {
      const key = `${moduleId}::${sub.id}`;
      if (!completedSet.has(key)) {
        dom.nextStepModule.textContent = `${moduleData.name || `Module ${moduleId}`} — ${sub.name || sub.id}`;
        const mins = sub.durationMinutes || sub.duration || null;
        dom.nextStepMeta.textContent = mins ? `Temps restant: ${mins} min` : "Temps estimé: —";
        dom.nextStepCta.onclick = () => {
          window.location.href = `/student/sous-acquis.html?moduleId=${encodeURIComponent(moduleId)}&subAcquisId=${encodeURIComponent(String(sub.id || ""))}`;
        };
        return;
      }
    }
  }

  dom.nextStepModule.textContent = "Aucun cours en attente — félicitations !";
  dom.nextStepMeta.textContent = "Vous avez complété tous les sous-acquis disponibles.";
  dom.nextStepCta.onclick = () => { switchView("cours"); };
}

function renderUpcoming(calendar = []) {
  if (!dom.upcomingList) return;
  const items = Array.isArray(calendar) ? calendar.slice().sort((a,b)=> new Date(String(a.unlockAt)).getTime() - new Date(String(b.unlockAt)).getTime()) : [];
  const next = items.slice(0,4);
  if (!next.length) {
    dom.upcomingList.innerHTML = '<li class="calendar-empty">Aucune échéance à venir.</li>';
    return;
  }

  dom.upcomingList.innerHTML = next.map(entry=>{
    const date = entry?.unlockAt ? new Date(String(entry.unlockAt)) : null;
    const day = date ? String(date.getDate()).padStart(2,'0') : '--';
    const month = date ? date.toLocaleString('fr-FR',{month:'short'}) : '';
    const title = entry?.subAcquisName || `Sous-acquis ${entry?.subAcquisId || ''}`;
    const moduleName = entry?.moduleName || `Module ${entry?.moduleId || ''}`;
    return `
      <li class="upcoming-item">
        <div class="upcoming-date"><div>${day}</div><div style="font-size:0.7rem;margin-top:3px">${month}</div></div>
        <div style="flex:1">
          <div style="font-weight:700">${htmlEscape(title)}</div>
          <div style="font-size:0.86rem;color:var(--muted);margin-top:4px">${htmlEscape(moduleName)}</div>
        </div>
      </li>
    `;
  }).join('');
}

function renderRecommendations(metrics, modules = []) {
  if (!dom.recommendationsList || !dom.recommendationsNote) return;

  const rows = Array.isArray(metrics?.moduleRows) ? metrics.moduleRows : [];
  if (!rows.length) {
    dom.recommendationsList.innerHTML = '';
    dom.recommendationsNote.textContent = '';
    return;
  }

  // pick two modules with lowest lessonPercent (need review)
  const sorted = rows.slice().sort((a,b)=> (a.lessonPercent || 0) - (b.lessonPercent || 0));
  const picks = sorted.slice(0,2);

  // map id -> name from modules list
  const nameById = new Map();
  (Array.isArray(modules)?modules:[]).forEach(m=> nameById.set(String(m.id), m.name || `Module ${m.id}`));

  dom.recommendationsList.innerHTML = picks.map(r => {
    const name = nameById.get(String(r.id)) || `Module ${r.id}`;
    return `<div class="recommendation-tag">${htmlEscape(name)}<div style="font-size:0.72rem;color:var(--muted);margin-top:4px">Module ${htmlEscape(String(r.id))}</div></div>`;
  }).join('');

  if (picks.length) {
    dom.recommendationsNote.textContent = `Astuce : un focus de 20 min sur ${nameById.get(String(picks[0].id)) || 'ce module'} peut améliorer votre score.`;
  } else {
    dom.recommendationsNote.textContent = '';
  }
}

function renderStats(stats) {
  dom.lessonsCompleted.textContent = String(Number(stats?.lessonsCompleted) || 0);
  dom.quizzesPassed.textContent = String(Number(stats?.quizzesPassed) || 0);

  const avg = Number(stats?.averageQuizScoreOn20);
  dom.quizAverage.textContent = Number.isFinite(avg) ? `${avg.toFixed(1)}/20` : "0.0/20";
}

/* ════════════════════════════════════════════════════════
   NEW DASHBOARD RENDERING
   ════════════════════════════════════════════════════════ */

function destroyDashCharts() {
  Object.keys(dashCharts).forEach((key) => {
    if (dashCharts[key] && typeof dashCharts[key].destroy === "function") {
      dashCharts[key].destroy();
      dashCharts[key] = null;
    }
  });
}

function renderNewDashboard(data) {
  if (!data) return;
  dashData = data;
  const { profile, progress, overview, prediction, nextStep, weakestModules, quizTrend, weeklyActivity, achievements, insights, calendarEntries } = data;

  // ── Hero ──
  if (dom.dashHeroName) {
    dom.dashHeroName.textContent = profile?.fullName ? `Bonjour, ${profile.fullName} !` : "Bonjour !";
  }
  if (dom.dashHeroEyebrow) {
    dom.dashHeroEyebrow.textContent = `Tableau de bord • ${progress?.lessonsCompleted || 0} leçons`;
  }
  if (dom.dashHeroXp) dom.dashHeroXp.textContent = `${insights?.xp || 0}`;
  if (dom.dashHeroStreak) dom.dashHeroStreak.textContent = `${insights?.streak || 0}j`;
  if (dom.dashHeroProgress) {
    const totalLessons = overview?.reduce((s, m) => s + m.subAcquisCount, 0) || 1;
    const completedLessons = overview?.reduce((s, m) => s + m.completedCount, 0) || 0;
    dom.dashHeroProgress.textContent = `${Math.round((completedLessons / totalLessons) * 100)}%`;
  }
  if (dom.dashHeroQuote) {
    const pct = prediction?.probabilityPct || 0;
    if (pct >= 70) dom.dashHeroQuote.textContent = "Excellent travail ! Vous etes sur la bonne voie pour reussir.";
    else if (pct >= 40) dom.dashHeroQuote.textContent = "Continuez vos efforts -- chaque lecon compte pour rattraper.";
    else dom.dashHeroQuote.textContent = "N'abandonnez pas ! Parlez a votre enseignant pour obtenir de l'aide.";
  }

  // ── Prediction gauge ──
  if (dom.dashPredRing && dom.dashPredPct) {
    const pct = prediction?.probabilityPct || 0;
    const circumference = 326.7;
    const offset = circumference - (pct / 100) * circumference;
    dom.dashPredRing.style.strokeDashoffset = String(offset);
    dom.dashPredRing.style.animation = `gaugeFill 1s ease forwards`;
    const color = pct >= 70 ? "#c41d38" : pct >= 40 ? "#d93a4f" : "#8f1220";
    dom.dashPredRing.style.stroke = color;
    dom.dashPredPct.textContent = `${pct}%`;
    dom.dashPredPct.style.color = color;
  }
  if (dom.dashPredMessage) {
    const pct = prediction?.probabilityPct || 0;
    if (pct >= 70) dom.dashPredMessage.textContent = "Forte probabilité de rattrapage. Continuez !";
    else if (pct >= 40) dom.dashPredMessage.textContent = "Des efforts supplémentaires sont recommandés.";
    else dom.dashPredMessage.textContent = "Risque de décrochage détecté. Consultez votre enseignant.";
  }
  if (dom.dashPredFeatures) {
    const factors = Array.isArray(prediction?.riskFactors) ? prediction.riskFactors : [];
    if (factors.length) {
      // Explain *why* the score is what it is — the top risk (or protective) factors.
      dom.dashPredFeatures.innerHTML = factors.map((factor) => {
        const level = factor.level === "high" ? "pred-factor-high"
          : factor.level === "good" ? "pred-factor-good" : "pred-factor-medium";
        const icon = factor.level === "high" ? "🔴" : factor.level === "good" ? "🟢" : "🟡";
        return `<div class="pred-factor ${level}"><span>${icon}</span>${htmlEscape(factor.label)}</div>`;
      }).join("");
    } else if (prediction?.features) {
      const f = prediction.features;
      dom.dashPredFeatures.innerHTML = `
        <div class="pred-feat">Rythme<strong>${f.completionPace?.toFixed(1) || "0"}/sem</strong></div>
        <div class="pred-feat">Moyenne<strong>${Math.round(f.averageScore || 0)}%</strong></div>
        <div class="pred-feat">Connexions<strong>${f.loginFrequency?.toFixed(1) || "0"}/sem</strong></div>
        <div class="pred-feat">Retard<strong>${Math.round(f.delayWeeks || 0)} sem</strong></div>
      `;
    }
  }

  // ── Next Action ──
  if (dom.dashActionModule) {
    if (nextStep) {
      dom.dashActionModule.textContent = `${nextStep.moduleName} — ${nextStep.subAcquisName}`;
      if (dom.dashActionSub) dom.dashActionSub.textContent = "Sous-acquis non complété";
      if (dom.dashActionCta) {
        dom.dashActionCta.onclick = () => {
          window.location.href = `/student/sous-acquis.html?moduleId=${encodeURIComponent(nextStep.moduleId)}&subAcquisId=${encodeURIComponent(nextStep.subAcquisId)}`;
        };
      }
    } else {
      dom.dashActionModule.textContent = "Tout est complete !";
      if (dom.dashActionSub) dom.dashActionSub.textContent = "Vous avez terminé tous les sous-acquis.";
      if (dom.dashActionCta) {
        dom.dashActionCta.onclick = () => { switchView("cours"); };
      }
    }
  }

  // ── Charts ──
  renderDashCharts(data);

  // ── Heatmap ──
  renderDashHeatmap(weeklyActivity);

  // ── Health ──
  renderDashHealth(overview, quizTrend);

  // ── Achievements ──
  renderDashAchievements(achievements);

  // ── Deadlines ──
  renderDashDeadlines(calendarEntries);

  // ── Insights ──
  renderDashInsights(insights);

  // ── Weakest Modules ──
  renderDashWeakest(weakestModules);

  // ── Module Progress ──
  renderDashModuleProgress(overview, quizTrend);
}

function renderDashCharts(data) {
  const { overview, quizTrend } = data;
  if (!overview) return;

  const labels = overview.map((m) => m.name ? m.name.substring(0, 12) : `M${m.id}`);
  const completed = overview.map((m) => m.completedCount);
  const totals = overview.map((m) => m.subAcquisCount);
  
  // 1. Radial Progress
  if (dom.dashRadialContainer) {
    const totalDone = overview.reduce((s, m) => s + m.completedCount, 0);
    const totalAll = overview.reduce((s, m) => s + m.subAcquisCount, 0);
    const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;
    const circ = 2 * Math.PI * 54; // r=54
    const offset = circ - (pct / 100) * circ;
    
    dom.dashRadialContainer.innerHTML = `
      <div class="custom-radial-wrap">
        <svg viewBox="0 0 120 120" class="custom-radial-svg">
          <circle cx="60" cy="60" r="54" fill="none" stroke="var(--dash-line)" stroke-width="8"></circle>
          <circle cx="60" cy="60" r="54" fill="none" stroke="url(#radialGrad)" stroke-width="8" stroke-linecap="round" 
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            style="animation: gaugeFill 1.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;"></circle>
          <defs>
            <linearGradient id="radialGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="var(--dash-accent)" />
              <stop offset="100%" stop-color="var(--dash-accent-dark)" />
            </linearGradient>
          </defs>
        </svg>
        <div class="custom-radial-center">
          <span class="radial-pct">${pct}%</span>
          <span class="radial-label">Complété</span>
        </div>
      </div>
    `;
  }

  // 2. Timeline / Gamified Path
  if (dom.dashTimelineContainer) {
    let timelineHTML = '<div class="learning-path">';
    overview.forEach((m, i) => {
      const isDone = m.completedCount === m.subAcquisCount && m.subAcquisCount > 0;
      const isCurrent = m.completedCount > 0 && !isDone;
      const statusClass = isDone ? 'done' : isCurrent ? 'current' : 'locked';
      const mName = m.name ? m.name : `Module ${m.id}`;
      
      timelineHTML += `
        <div class="path-node ${statusClass}">
          <div class="path-icon">${isDone ? '✓' : isCurrent ? '★' : '🔒'}</div>
          <div class="path-info">
            <span class="path-title">${mName}</span>
            <span class="path-prog">${m.completedCount} / ${m.subAcquisCount}</span>
          </div>
        </div>
      `;
    });
    timelineHTML += '</div>';
    dom.dashTimelineContainer.innerHTML = timelineHTML;
  }

  // 3. Knowledge Radar / Skill Map
  if (dom.dashRadarContainer) {
    if (overview && overview.length > 0) {
      let barsHTML = '<div class="skill-bars">';
      overview.forEach(m => {
        const pct = m.subAcquisCount > 0 ? Math.round((m.completedCount / m.subAcquisCount) * 100) : 0;
        barsHTML += `
          <div class="skill-bar-row">
            <span class="skill-bar-label">${m.name ? m.name.substring(0,14) : `M${m.id}`}</span>
            <div class="skill-bar-track">
              <div class="skill-bar-fill" style="width: ${pct}%"></div>
            </div>
            <span class="skill-bar-pct">${pct}%</span>
          </div>
        `;
      });
      barsHTML += '</div>';
      dom.dashRadarContainer.innerHTML = barsHTML;
    } else {
      dom.dashRadarContainer.innerHTML = '<p class="empty-state">Pas encore de données</p>';
    }
  }
}

function renderDashHeatmap(weeklyActivity) {
  if (!dom.dashHeatmapBody) return;
  if (!weeklyActivity?.length) {
    dom.dashHeatmapBody.innerHTML = '<p style="color:var(--dash-muted);font-size:0.78rem">Aucune activité cette semaine</p>';
    return;
  }

  const last7 = weeklyActivity.slice(-7);
  const maxVal = Math.max(...last7.map((w) => w.quizzes), 1);
  let html = '<div class="heatmap-month-labels">';
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  days.forEach((d) => { html += `<span class="heatmap-month-label">${d}</span>`; });
  html += '</div><div class="heatmap-grid">';
  last7.forEach((w) => {
    const level = Math.min(5, Math.ceil((w.quizzes / maxVal) * 5) || 0);
    html += `<div class="heatmap-cell l${level}" title="Semaine ${w.week}: ${w.quizzes} quiz, ${w.lessons} leçons"></div>`;
  });
  html += '</div>';
  dom.dashHeatmapBody.innerHTML = html;
}

function renderDashHealth(overview, quizTrend) {
  if (!dom.dashHealthBody || !overview) return;
  const quizScores = quizTrend?.length > 0 ? quizTrend : [];
  const avgScores = new Map();
  quizScores.forEach((q) => {
    const key = q.moduleId;
    const existing = avgScores.get(key) || { sum: 0, count: 0 };
    existing.sum += q.score;
    existing.count += 1;
    avgScores.set(key, existing);
  });

  const items = overview.slice(0, 8).map((m) => {
    const avg = avgScores.get(m.id);
    const score = avg ? Math.round(avg.sum / avg.count) : null;
    const pct = m.subAcquisCount > 0 ? Math.round((m.completedCount / m.subAcquisCount) * 100) : 0;
    return { id: m.id, name: m.name, progressPct: pct, quizAvg: score };
  });

  if (!items.length) {
    dom.dashHealthBody.innerHTML = '<p style="color:var(--dash-muted);font-size:0.78rem">Aucune donnée disponible</p>';
    return;
  }

  dom.dashHealthBody.innerHTML = items.map((item) => {
    const barColor = item.progressPct >= 70 ? "#c41d38" : item.progressPct >= 40 ? "#d93a4f" : "#8f1220";
    return `<div class="health-item">
      <span class="health-item-name">${htmlEscape(item.name)}</span>
      <span class="health-bar"><span class="health-bar-fill" style="width:${item.progressPct}%;background:${barColor}"></span></span>
    </div>`;
  }).join("");
}

function renderDashAchievements(achievements) {
  if (!dom.dashAchBody || !achievements?.length) return;
  dom.dashAchBody.innerHTML = achievements.map((a) => `
    <div class="ach-item ${a.earned ? "earned" : ""}">
      <span class="ach-icon">${a.icon}</span>
      <div class="ach-info">
        <p class="ach-title">${htmlEscape(a.title)}</p>
        <p class="ach-desc">${htmlEscape(a.description)}</p>
      </div>
      <div class="ach-progress">
        <div class="ach-progress-fill" style="width:${Math.min(100, (a.progress / Math.max(1, a.max)) * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function renderDashDeadlines(calendarEntries) {
  if (!dom.dashDeadlinesList) return;
  if (!calendarEntries?.length) {
    dom.dashDeadlinesList.innerHTML = '<li class="deadline-empty">Aucune échéance à venir</li>';
    return;
  }

  const sorted = [...calendarEntries]
    .filter((e) => e.unlockAt)
    .sort((a, b) => new Date(a.unlockAt).getTime() - new Date(b.unlockAt).getTime())
    .slice(0, 4);

  dom.dashDeadlinesList.innerHTML = sorted.map((entry) => {
    const date = entry.unlockAt ? new Date(entry.unlockAt) : null;
    const day = date ? String(date.getDate()).padStart(2, "0") : "--";
    const month = date ? date.toLocaleString("fr-FR", { month: "short" }) : "";
    const title = entry.subAcquisName || `Sous-acquis ${entry.subAcquisId || ""}`;
    const moduleName = entry.moduleName || `Module ${entry.moduleId || ""}`;
    return `<li class="deadline-item">
      <div class="deadline-date">
        <span class="deadline-day">${day}</span>
        <span class="deadline-month">${month}</span>
      </div>
      <div class="deadline-info">
        <p class="deadline-title">${htmlEscape(title)}</p>
        <p class="deadline-module">${htmlEscape(moduleName)}</p>
      </div>
    </li>`;
  }).join("");
}

function renderDashInsights(insights) {
  if (!dom.dashInsightsBody || !insights) return;

  const items = [
    { label: "Quiz tentés", value: insights.totalQuizAttempts || 0, cls: "" },
    { label: "Score moyen", value: `${Math.round(insights.averageQuizScore || 0)}%`, cls: "" },
    { label: "Rythme", value: `${insights.completionPace?.toFixed(1) || "0"}/sem`, cls: "" },
    { label: "Connexions", value: `${insights.loginFrequency?.toFixed(1) || "0"}/sem`, cls: insights.loginFrequency >= 3 ? "highlight" : "" }
  ];

  dom.dashInsightsBody.innerHTML = items.map((item) => `
    <div class="insight-item ${item.cls}">
      <span class="insight-value">${item.value}</span>
      <span class="insight-label">${item.label}</span>
    </div>
  `).join("");
}

function renderDashWeakest(weakestModules) {
  if (!dom.dashWeakestBody) return;
  if (!weakestModules?.length) {
    dom.dashWeakestBody.innerHTML = '<p style="color:var(--dash-muted);font-size:0.78rem">Tous les modules sont à jour !</p>';
    return;
  }

  dom.dashWeakestBody.innerHTML = weakestModules.map((m) => {
    const barColor = m.progressPct >= 50 ? "#d93a4f" : "#8f1220";
    return `<div class="weak-item">
      <p class="weak-name">${htmlEscape(m.name)}</p>
      <div class="weak-bar"><div class="weak-bar-fill" style="width:${m.progressPct}%;background:${barColor}"></div></div>
      <span class="weak-pct">${m.progressPct}% complété</span>
    </div>`;
  }).join("");
}

function renderDashModuleProgress(overview, quizTrend) {
  if (!dom.dashModuleProgressBody || !Array.isArray(overview) || !overview.length) {
    if (dom.dashModuleProgressBody) {
      dom.dashModuleProgressBody.innerHTML = '<p class="mod-prog-empty">Aucune donnée disponible.</p>';
    }
    return;
  }

  // build moduleId → average quiz score map from quizTrend
  const avgByModule = new Map();
  if (Array.isArray(quizTrend)) {
    const acc = new Map();
    for (const q of quizTrend) {
      const key = String(q.moduleId);
      const cur = acc.get(key) || { sum: 0, count: 0 };
      cur.sum += Number(q.score) || 0;
      cur.count += 1;
      acc.set(key, cur);
    }
    for (const [key, { sum, count }] of acc) {
      avgByModule.set(key, sum / count);
    }
  }

  dom.dashModuleProgressBody.innerHTML = overview.map((m) => {
    const total = m.subAcquisCount || 0;
    const done = m.completedCount || 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const rawScore = avgByModule.get(String(m.id));
    // quizTrend scores are 0-100; convert to /20
    const scoreOn20 = rawScore !== undefined ? (rawScore / 5) : null;
    const scoreLabel = scoreOn20 !== null ? `${scoreOn20.toFixed(1)}/20` : "—";
    const scoreClass = scoreOn20 === null ? "" : scoreOn20 >= 14 ? "mod-prog-score-ok" : scoreOn20 >= 10 ? "mod-prog-score-warn" : "mod-prog-score-low";

    const barColor = pct >= 70 ? "#c41d38" : pct >= 40 ? "#d93a4f" : "#8f1220";
    const statusClass = pct === 100 ? "mod-prog-done" : done > 0 ? "mod-prog-partial" : "mod-prog-idle";
    const statusLabel = pct === 100 ? "Terminé" : done > 0 ? "En cours" : "Non commencé";

    return `<div class="mod-prog-row">
      <div class="mod-prog-left">
        <span class="mod-prog-name">${htmlEscape(m.name || `Module ${m.id}`)}</span>
        <span class="mod-prog-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="mod-prog-center">
        <div class="mod-prog-track">
          <div class="mod-prog-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <span class="mod-prog-pct">${done}/${total} leçons · ${pct}%</span>
      </div>
      <div class="mod-prog-right">
        <span class="mod-prog-score ${scoreClass}">${scoreLabel}</span>
        <span class="mod-prog-score-label">quiz</span>
      </div>
    </div>`;
  }).join("");
}

async function loadDashboardData() {
  const [modules, stats, overview, calendarPayload] = await Promise.all([
    fetchModules(),
    fetchProgressStats(),
    fetchOverview(),
    fetchStudentCalendar()
  ]);

  renderCalendar(calendarPayload.calendar, calendarPayload.startDate);
  renderMessages(stats, modules);
  renderStats(stats);

  const normalizedOverview = Array.isArray(overview) && overview.length > 0
    ? overview
    : await buildOverviewFallback(modules);

  const metrics = buildDashboardMetrics(normalizedOverview, stats);

  if (stats && Number.isFinite(Number(stats.lessonsCompleted)) && metrics.totals.lessonsCompleted === 0) {
    metrics.totals.lessonsCompleted = Number(stats.lessonsCompleted) || 0;
    metrics.percentages.lessons = toPercent(metrics.totals.lessonsCompleted, metrics.totals.lessons);
  }

  if (stats && Number.isFinite(Number(stats.quizzesPassed)) && metrics.totals.quizzesPassed === 0) {
    metrics.totals.quizzesPassed = Number(stats.quizzesPassed) || 0;
    metrics.percentages.quizzes = toPercent(metrics.totals.quizzesPassed, metrics.totals.quizzes);
  }

  // New dashboard data
  try {
    const dashResp = await fetch(`/api/student/dashboard/${encodeURIComponent(String(currentUser?.identifier || ""))}`);
    if (dashResp.ok) {
      const dashPayload = await dashResp.json();
      dashData = dashPayload;
      renderNewDashboard(dashPayload);
    }
  } catch (_e) {
    // silently fail
  }
}

function initWhenSidebarReady() {
  if (document.getElementById("sidebar-toggle-btn")) {
    initStudentApp();
    return;
  }

  document.addEventListener("sidebar:ready", () => {
    initStudentApp();
  }, { once: true });
}

initWhenSidebarReady();
