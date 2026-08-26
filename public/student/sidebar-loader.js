(function () {
  const SIDEBAR_COLLAPSED_STORAGE_KEY = "nextlearnSidebarCollapsed";
  const PREFERRED_VIEW_KEY = "nextlearnPreferredView";

  function getCurrentUser() {
    try {
      const raw = localStorage.getItem("nextlearnCurrentUser");
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function applySidebarCollapsedState() {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
    } catch (_error) {
      collapsed = false;
    }
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    
    // Sync the accessibility state and label on initial load
    updateToggleAccessibility(collapsed);
  }

  function toggleSidebarCollapsed() {
    const nextCollapsed = !document.body.classList.contains("sidebar-collapsed");
    document.body.classList.toggle("sidebar-collapsed", nextCollapsed);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, nextCollapsed ? "1" : "0");
    } catch (_error) {
      // Ignore storage errors.
    }
    
    // Sync accessibility state on user click
    updateToggleAccessibility(nextCollapsed);
  }

  /**
   * ACCESSIBILITY FIX: Keeps screen readers informed of the sidebar's visual state.
   */
  function updateToggleAccessibility(isCollapsed) {
    const toggleBtn = document.getElementById("sidebar-toggle-btn");
    if (!toggleBtn) return;
    
    toggleBtn.setAttribute("aria-pressed", String(isCollapsed));
    toggleBtn.setAttribute(
      "aria-label", 
      isCollapsed ? "Agrandir la barre latérale" : "Réduire la barre latérale"
    );
  }

  function setActiveNav(viewKey) {
    const navItems = Array.from(document.querySelectorAll(".nav-item[data-view]"));
    navItems.forEach((item) => {
      item.classList.toggle("active", item.dataset.view === viewKey);
    });
  }

  function bindStandaloneNav() {
    const navItems = Array.from(document.querySelectorAll(".nav-item[data-view]"));
    navItems.forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault(); // Prevent default link behavior
        const viewKey = item.dataset.view || "cours";
        
        try {
          sessionStorage.setItem(PREFERRED_VIEW_KEY, viewKey);
        } catch (_error) {
          // Ignore storage errors.
        }

        // All navigation clicks, regardless of the current page, will now
        // be handled by redirecting to the correct URL. The dashboard page's
        // own script will handle showing the correct view based on the URL.
        if (viewKey === "cours") {
          window.location.href = "/student/?view=cours";
        } else {
          // For all other views, navigate to the root student page
          // with the appropriate view in the query string.
          window.location.href = `/student/?view=${viewKey}`;
        }
      });
    });

    const logoutBtn = document.getElementById("logout-btn");
    logoutBtn?.addEventListener("click", () => {
      localStorage.removeItem("nextlearnCurrentUser");
      // Per-student caches are keyed globally; clear them so the next
      // student on this browser does not inherit this one's profile.
      localStorage.removeItem("nextlearn_vark_result");
      localStorage.removeItem("nextlearn_vark_reco_dismissed");
      // Chat histories are keyed per student AND module; sweep the prefix so
      // nothing from this session is readable by the next student here.
      Object.keys(localStorage)
        .filter(function (k) {
          if (k.indexOf("nextlearn_chatlog_") === 0) return true;
          if (k.indexOf("nextlearn_chat_") !== 0) return false;
          // Legacy unscoped conversations, but keep the panel-geometry prefs.
          return !/^nextlearn_chat_(w|floating|fx|fy|fw|fh)$/.test(k);
        })
        .forEach(function (k) { localStorage.removeItem(k); });
      window.location.href = "/auth/sign-in.html";
    });
  }

  async function hydrateSidebarData() {
    const currentUser = getCurrentUser();
    if (!currentUser || !currentUser.identifier) {
      localStorage.removeItem("nextlearnCurrentUser");
      // Per-student caches are keyed globally; clear them so the next
      // student on this browser does not inherit this one's profile.
      localStorage.removeItem("nextlearn_vark_result");
      localStorage.removeItem("nextlearn_vark_reco_dismissed");
      // Chat histories are keyed per student AND module; sweep the prefix so
      // nothing from this session is readable by the next student here.
      Object.keys(localStorage)
        .filter(function (k) {
          if (k.indexOf("nextlearn_chatlog_") === 0) return true;
          if (k.indexOf("nextlearn_chat_") !== 0) return false;
          // Legacy unscoped conversations, but keep the panel-geometry prefs.
          return !/^nextlearn_chat_(w|floating|fx|fy|fw|fh)$/.test(k);
        })
        .forEach(function (k) { localStorage.removeItem(k); });
      window.location.href = "/sign-in";
      return;
    }

    const name = document.getElementById("student-name");
    const identifier = document.getElementById("student-identifier");
    if (name) {
      // Dynamic value slot: drop the i18n key before writing the real name, so
      // that later translation passes (the sidebar:ready re-bind, the
      // MutationObserver) cannot overwrite it with the placeholder string.
      name.removeAttribute("data-i18n");
      name.textContent = currentUser.fullName || currentUser.identifier;
    }
    if (identifier) {
      identifier.textContent = `Id: ${currentUser.identifier}`;
    }

    try {
      const response = await fetch(`/api/student/progress/${encodeURIComponent(currentUser.identifier)}`);
      if (response.ok) {
        const data = await response.json();
        const xp = Number(data.xp) || 0;
        
        const xpElement = document.getElementById("student-xp");
        const xpFillElement = document.getElementById("student-xp-fill");
        const levelElement = document.getElementById("student-level");
        
        if (xpElement && xpFillElement && levelElement) {
          const level = Math.floor(xp / 1000) + 1;
          const xpInCurrentLevel = xp % 1000;
          const progressPercent = (xpInCurrentLevel / 1000) * 100;
          
          xpElement.textContent = `${xp} XP`;
          levelElement.textContent = level;
          xpFillElement.style.width = `${progressPercent}%`;
        }
      }
    } catch (_e) {}
  }

  function attachToggleHandler() {
    const toggleBtn = document.getElementById("sidebar-toggle-btn");
    toggleBtn?.addEventListener("click", () => {
      toggleSidebarCollapsed();
    });
  }

  async function loadSidebar() {
    if (document.querySelector(".sidebar")) {
      return;
    }

    const slot = document.getElementById("sidebar-slot");
    const response = await fetch("/student/sidebar.html");
    if (!response.ok) {
      return;
    }

    const markup = await response.text();
    if (slot) {
      slot.innerHTML = markup;
    } else {
      document.body.insertAdjacentHTML("afterbegin", markup);
    }

    if (!document.querySelector(".dashboard-shell")) {
      document.body.classList.add("sidebar-standalone");
    }

    // Moved toggle handler attachment right above applying state to prevent any minor state race-conditions
    attachToggleHandler();
    applySidebarCollapsedState();
    hydrateSidebarData();

    if (!document.querySelector(".dashboard-shell")) {
      let savedView = "cours";
      try {
        savedView = sessionStorage.getItem(PREFERRED_VIEW_KEY) || "cours";
      } catch (_e) {}

      const path = window.location.pathname || "";
      if (
        path.startsWith("/student/sous-acquis") ||
        path.startsWith("/student/questionnaire")
      ) {
        savedView = "cours";
      }

      setActiveNav(savedView);
      bindStandaloneNav();
    }

    document.dispatchEvent(new Event("sidebar:ready"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadSidebar);
  } else {
    void loadSidebar();
  }
})();