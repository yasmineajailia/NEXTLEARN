// chatbot module
window.chatbotBootstrapped = false;
window.chatbotExpanded = false;
window.chatbotFullscreen = false;
window.chatbotFilteredMode = false;
window.chatbotFilterModuleId = null;
window.chatbotFilterSubAcquisId = null;

window.syncChatbotFilterButton = function() {
  if (!dom.chatbotFilterBtn) return;
  dom.chatbotFilterBtn.setAttribute("aria-pressed", String(window.chatbotFilteredMode));
  dom.chatbotFilterBtn.textContent = window.chatbotFilteredMode ? tr("chat.allModules", "Tous les modules") : tr("chat.subAcquis", "Sous-acquis");
  dom.chatbotFilterBtn.title = window.chatbotFilteredMode
    ? tr("chat.switchToModules", "Passer aux modules disponibles")
    : tr("chat.backToSub", `Revenir au sous-acquis ${window.chatbotFilterSubAcquisId || "actuel"}`, { id: window.chatbotFilterSubAcquisId || "" });
};

window.detectChatbotContext = function() {
  const params = new URLSearchParams(window.location.search);
  const moduleId = params.get("moduleId");
  const subAcquisId = params.get("subAcquisId");
  
  if (moduleId && subAcquisId) {
    window.chatbotFilteredMode = true;
    window.chatbotFilterModuleId = moduleId;
    window.chatbotFilterSubAcquisId = subAcquisId;
    
    if (dom.chatbotFilterBtn) dom.chatbotFilterBtn.removeAttribute("hidden");
    window.syncChatbotFilterButton();
  }
};

window.appendChatMessage = function(role, text) {
  if (!dom.chatbotThread) return;
  const bubble = document.createElement("article");
  bubble.className = `chatbot-bubble ${role === "user" ? "user" : "bot"}`;
  bubble.textContent = String(text || "").trim();
  dom.chatbotThread.appendChild(bubble);
  dom.chatbotThread.scrollTop = dom.chatbotThread.scrollHeight;
};

window.openChatbotPanel = function(options = {}) {
  if (!dom.chatbotPanel) return;
  const fullscreen = Boolean(options.fullscreen);
  dom.chatbotPanel.removeAttribute("hidden");
  dom.chatbotLauncher?.setAttribute("aria-expanded", "true");
  window.setChatbotFullscreen(fullscreen);
  window.ensureChatbotWelcome();
  document.body.classList.add("chatbot-open");
  window.requestAnimationFrame(() => dom.chatbotInput?.focus());
};

window.closeChatbotPanel = function() {
  if (!dom.chatbotPanel) return;
  dom.chatbotPanel.setAttribute("hidden", "true");
  dom.chatbotLauncher?.setAttribute("aria-expanded", "false");
  window.setChatbotFullscreen(false);
  document.body.classList.remove("chatbot-open");
};

window.setChatbotFullscreen = function(expanded) {
  window.chatbotFullscreen = Boolean(expanded);
  window.chatbotExpanded = window.chatbotFullscreen;
  dom.chatbotPanel?.classList.toggle("is-expanded", window.chatbotExpanded);
  dom.chatbotPanel?.classList.toggle("is-fullscreen", window.chatbotFullscreen);
  if (dom.chatbotExpandBtn) {
    dom.chatbotExpandBtn.textContent = window.chatbotExpanded ? "⤡" : "⤢";
    dom.chatbotExpandBtn.setAttribute("aria-label", window.chatbotExpanded ? tr("chat.shrink", "Réduire l'assistant") : tr("chat.expand", "Agrandir l'assistant"));
  }
};

window.toggleChatbotFilterMode = function() {
  window.chatbotFilteredMode = !window.chatbotFilteredMode;
  window.syncChatbotFilterButton();
};

window.ensureChatbotWelcome = function() {
  if (window.chatbotBootstrapped || !dom.chatbotThread) return;
  window.appendChatMessage("bot", tr("chat.greeting", "Bonjour, je suis l'assistant NextLearn. Posez-moi une question sur un concept du cours, une ressource ou votre parcours : je vous réponds à partir du contenu de vos modules."));
  window.chatbotBootstrapped = true;
};

window.submitChatbotQuestion = async function() {
  const question = String(dom.chatbotInput?.value || "").trim();
  if (!question) return;
  window.ensureChatbotWelcome();
  window.appendChatMessage("user", question);
  if (dom.chatbotInput) dom.chatbotInput.value = "";
  if (dom.chatbotSendBtn instanceof HTMLButtonElement) dom.chatbotSendBtn.disabled = true;

  try {
    const body = {
      identifier: currentUser?.identifier || "",
      message: question,
      lang: window.I18N ? window.I18N.lang : "fr"
    };
    
    if (window.chatbotFilteredMode && window.chatbotFilterModuleId && window.chatbotFilterSubAcquisId) {
      body.filterToModuleId = window.chatbotFilterModuleId;
      body.filterToSubAcquisId = window.chatbotFilterSubAcquisId;
    }

    const response = await fetch("/api/student/chatbot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      window.appendChatMessage("bot", String(payload?.message || tr("chat.cannotProcess", "Je n'ai pas pu traiter votre question.")));
      return;
    }
    window.appendChatMessage("bot", String(payload?.answer || tr("chat.noAnswer", "Je n'ai pas trouvé de réponse pertinente.")));
  } catch (_error) {
    window.appendChatMessage("bot", tr("chat.networkError", "Une erreur réseau est survenue. Réessayez dans un instant."));
  } finally {
    if (dom.chatbotSendBtn instanceof HTMLButtonElement) dom.chatbotSendBtn.disabled = false;
  }
};
