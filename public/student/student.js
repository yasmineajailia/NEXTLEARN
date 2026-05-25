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

function buildDom() {
  return {
    shell: document.querySelector(".dashboard-shell"),
    sidebarToggleBtn: document.getElementById("sidebar-toggle-btn"),
    name: document.getElementById("student-name"),
    identifier: document.getElementById("student-identifier"),
    contentHeader: document.getElementById("content-header"),
    coursOverview: document.getElementById("cours-overview"),
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
    openCCourseBtn: document.getElementById("open-c-course-btn"),
    closeCCourseBtn: document.getElementById("close-c-course-btn"),
    courseEmbedCard: document.getElementById("course-embed-card"),
    courseEmbedContent: document.getElementById("course-embed-content"),
    calendarList: document.getElementById("calendar-list"),
    messagesList: document.getElementById("messages-list"),
    lessonsCompleted: document.getElementById("stat-lessons-completed"),
    quizzesPassed: document.getElementById("stat-quizzes-passed"),
    quizAverage: document.getElementById("stat-quiz-average"),
    dashboardSummaryLine: document.getElementById("dashboard-summary-line"),
    dashKpiLessons: document.getElementById("dash-kpi-lessons"),
    dashKpiModules: document.getElementById("dash-kpi-modules"),
    dashKpiQuizzes: document.getElementById("dash-kpi-quizzes"),
    dashKpiVideos: document.getElementById("dash-kpi-videos"),
    chartOverall: document.getElementById("chart-overall-progress"),
    chartWeekly: document.getElementById("chart-weekly-activity"),
    chartModuleProgress: document.getElementById("chart-module-progress"),
    chartSkillRadar: document.getElementById("chart-skill-radar"),
    chartQuizzes: document.getElementById("chart-quiz-progress"),
    nextStepModule: document.getElementById("next-step-module"),
    nextStepMeta: document.getElementById("next-step-meta"),
    nextStepCta: document.getElementById("next-step-cta"),
    upcomingList: document.getElementById("upcoming-list"),
    recommendationsList: document.getElementById("recommendations-list"),
    recommendationsNote: document.getElementById("recommendations-note"),
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
let courseModulesLoaded = false;
let courseModulesLoading = false;

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
      switchView(button.dataset.view || "cours");
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

  dom.openCCourseBtn?.addEventListener("click", () => {
    // Corrected navigation to the standalone page
    window.location.href = "/student/programmation-c.html";
  });

  dom.closeCCourseBtn?.addEventListener("click", () => {
    dom.courseEmbedCard?.setAttribute("hidden", "true");
    syncCoursLayout();
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

function syncCoursLayout() {
  const embedVisible = Boolean(dom.courseEmbedCard && !dom.courseEmbedCard.hasAttribute("hidden"));

  dom.shell?.classList.toggle("course-focus", embedVisible);

  if (embedVisible) {
    dom.contentHeader?.setAttribute("hidden", "true");
    dom.coursOverview?.setAttribute("hidden", "true");
    return;
  }

  dom.contentHeader?.removeAttribute("hidden");
  dom.coursOverview?.removeAttribute("hidden");
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

  if (viewKey !== "cours") {
    dom.contentHeader?.removeAttribute("hidden");
    return;
  }

  syncCoursLayout();
}

function applyPreferredView() {
  const params = new URLSearchParams(window.location.search);
  const urlView = params.get("view");
  let preferredView = urlView;

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

async function fetchModules() {
  try {
    const identifier = encodeURIComponent(String(currentUser?.identifier || ""));
    const response = await fetch(`/api/programmation-c/modules?identifier=${identifier}`);
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

async function renderCourseModules() {
  if (!dom.courseEmbedContent) {
    return false;
  }

  dom.courseEmbedContent.innerHTML = '<p class="course-embed-loading">Chargement des modules...</p>';

  const [modules, stats] = await Promise.all([fetchModules(), fetchProgressStats()]);
  if (!modules.length) {
    dom.courseEmbedContent.innerHTML = '<p class="course-embed-loading">Aucun module disponible.</p>';
    return false;
  }

  const completedLessonKeys = Array.isArray(stats?.completedLessonKeys)
    ? stats.completedLessonKeys.filter((entry) => typeof entry === "string")
    : [];
  const quizResults = Array.isArray(stats?.quizResults) ? stats.quizResults : [];
  const completedSet = new Set(completedLessonKeys);
  const scoreMap = buildLatestScoreMap(quizResults);
  const scores = quizResults
    .map((entry) => Number(entry?.score))
    .filter((score) => Number.isFinite(score));
  const averageScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;

  const grid = document.createElement("div");
  grid.className = "course-modules-grid";

  modules.forEach((moduleData) => {
    const subAcquisItems = Array.isArray(moduleData?.subAcquisDetails)
      ? moduleData.subAcquisDetails
      : Array.isArray(moduleData?.subAcquis)
        ? moduleData.subAcquis.map((subId) => ({ id: subId, name: `Sous-acquis ${subId}` }))
        : [];

    const totalCount = subAcquisItems.length;
    const completedCount = subAcquisItems.filter((subItem) =>
      completedSet.has(buildLessonKey(moduleData.id, subItem.id))
    ).length;
    const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    const moduleSection = document.createElement("section");
    moduleSection.className = "course-module";

    const moduleName = moduleData?.name || `Module ${moduleData?.id || ""}`;
    const header = document.createElement("div");
    header.className = "course-module-head";
    header.innerHTML = `
      <span class="course-module-thumb">${htmlEscape(moduleData?.id || "-")}</span>
      <span class="course-module-meta">
        <h2 class="course-module-title">${htmlEscape(moduleName)}</h2>
        <p class="course-module-subtitle">${completedCount} / ${totalCount} termines</p>
      </span>
      <span class="course-progress-bar"><span class="course-progress-fill" style="width:${progressPercent}%"></span></span>
    `;

    const list = document.createElement("ul");
    list.className = "course-sub-list";

    subAcquisItems.forEach((subItem) => {
      const key = buildLessonKey(moduleData.id, subItem.id);
      const scoreEntry = scoreMap.get(key);
      const score = scoreEntry ? scoreEntry.score : NaN;
      const status = getQuizBubbleStatus(score, averageScore);
      const lessonHref = buildSubAcquisUrl(moduleData.id, subItem.id);
      const quizHref = `/student/questionnaire.html?moduleId=${encodeURIComponent(String(moduleData.id || ""))}&subAcquisId=${encodeURIComponent(String(subItem.id || ""))}`;

      const li = document.createElement("li");
      li.className = "course-sub-entry";
      li.innerHTML = `
        <a class="course-sub-link" href="${lessonHref}">${htmlEscape(subItem.name || "Sous-acquis")}</a>
        <a class="quiz-bubble ${status.className}" href="${quizHref}" title="${htmlEscape(status.title)}">${status.label}</a>
      `;
      list.appendChild(li);
    });

    moduleSection.appendChild(header);
    moduleSection.appendChild(list);
    grid.appendChild(moduleSection);
  });

  dom.courseEmbedContent.innerHTML = "";
  dom.courseEmbedContent.appendChild(grid);
  return true;
}

async function ensureCourseModulesLoaded() {
  if (courseModulesLoaded || courseModulesLoading) {
    return;
  }

  courseModulesLoading = true;
  courseModulesLoaded = await renderCourseModules();
  courseModulesLoading = false;
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
  dom.nextStepCta.onclick = () => { window.location.href = '/student/programmation-c.html'; };
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

  // Render additional UI blocks
  renderNextStep(modules, stats);
  renderUpcoming(calendarPayload.calendar || []);
  renderRecommendations(metrics, normalizedOverview.length ? normalizedOverview : modules);

  renderStudentDashboard(metrics);
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
