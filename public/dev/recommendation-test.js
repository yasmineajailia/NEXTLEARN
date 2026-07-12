let graphData = null;

const dom = {
  graphStatus: document.getElementById("graphStatus"),
  skillList: document.getElementById("skillList"),
  searchSkills: document.getElementById("searchSkills"),
  btnLoadGraph: document.getElementById("btnLoadGraph"),
  btnSelectVisible: document.getElementById("btnSelectVisible"),
  btnClearSelection: document.getElementById("btnClearSelection"),
  completedIds: document.getElementById("completedIds"),
  skillScores: document.getElementById("skillScores"),
  mode: document.getElementById("mode"),
  limit: document.getElementById("limit"),
  sortBy: document.getElementById("sortBy"),
  includePartial: document.getElementById("includePartial"),
  skillId: document.getElementById("skillId"),
  btnRun: document.getElementById("btnRun"),
  status: document.getElementById("status"),
  output: document.getElementById("output")
};

function setStatus(message) {
  dom.status.textContent = message || "";
}

function setGraphStatus(message) {
  if (dom.graphStatus) {
    dom.graphStatus.textContent = message || "";
  }
}

function setOutput(value) {
  dom.output.textContent = value || "";
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== "object") {
    return null;
  }

  if (graph.sub_skills && typeof graph.sub_skills === "object") {
    return graph;
  }

  return null;
}

function getSkillEntries() {
  if (!graphData?.sub_skills) {
    return [];
  }

  return Object.values(graphData.sub_skills)
    .filter((item) => item && item.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function renderSkillList(filterText = "") {
  if (!dom.skillList) {
    return;
  }

  const filter = String(filterText || "").trim().toLowerCase();
  const entries = getSkillEntries().filter((item) => {
    if (!filter) return true;
    return String(item.id).toLowerCase().includes(filter) || String(item.title || "").toLowerCase().includes(filter);
  });

  const header = `
    <div class="skill-list-header">
      <span></span>
      <span>Sub-skill</span>
      <span>Title</span>
      <span>Score</span>
    </div>
  `;

  if (!entries.length) {
    dom.skillList.innerHTML = `${header}<div class="skill-row muted">No matching skills found.</div>`;
    return;
  }

  const rows = entries.map((skill) => {
    const title = String(skill.title || "(sans titre)").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `
      <label class="skill-row" data-id="${skill.id}">
        <input type="checkbox" class="js-skill-select" data-id="${skill.id}" />
        <span class="skill-id">${skill.id}</span>
        <span class="skill-title">${title}</span>
        <input type="number" min="0" max="100" class="skill-score js-skill-score" data-id="${skill.id}" placeholder="score" />
      </label>
    `;
  }).join("");

  dom.skillList.innerHTML = `${header}${rows}`;
}

function collectSubSkillScores() {
  return [...document.querySelectorAll(".js-skill-score")]
    .map((input) => ({ id: input.dataset.id, value: String(input.value || "").trim() }))
    .filter((entry) => entry.id && entry.value !== "")
    .map((entry) => ({ subSkillId: entry.id, score: Number(entry.value) }))
    .filter((entry) => Number.isFinite(entry.score));
}

function collectCompletedIds() {
  const manual = String(dom.completedIds?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const checked = [...document.querySelectorAll(".js-skill-select")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.id)
    .filter(Boolean);

  return [...new Set([...manual, ...checked])];
}

async function runRecommendation() {
  if (!graphData) {
    setStatus("Load graph.json first.");
    setOutput("");
    return;
  }

  const body = {
    mode: dom.mode.value,
    completedIds: collectCompletedIds(),
    subSkillScores: collectSubSkillScores(),
    skillScores: [],
    limit: dom.limit.value ? Number(dom.limit.value) : undefined,
    sortBy: dom.sortBy.value,
    includePartial: dom.includePartial.checked,
    skillId: String(dom.skillId.value || "").trim() || undefined
  };

  const skillScoresText = String(dom.skillScores.value || "").trim();
  if (skillScoresText) {
    try {
      body.skillScores = JSON.parse(skillScoresText);
    } catch (error) {
      setStatus(`Invalid JSON in chapter / skill scores: ${error.message}`);
      return;
    }
  }

  setStatus("Calling /api/recommendations...");
  setOutput("");

  try {
    const response = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    setStatus(response.ok ? "Request completed." : "Request failed.");
    setOutput(JSON.stringify(data, null, 2));
  } catch (error) {
    setStatus(`Request failed: ${error.message}`);
  }
}

async function loadGraphFromServer() {
  try {
    setGraphStatus("Loading graph...");
    const resp = await fetch("/graph.json");
    if (!resp.ok) {
      throw new Error("Could not fetch graph.json");
    }

    const data = normalizeGraph(await resp.json());
    if (!data) {
      throw new Error("Invalid graph.json format");
    }

    graphData = data;
    renderSkillList(dom.searchSkills.value);
    setGraphStatus(`Graph loaded: ${getSkillEntries().length} sub-skills`);
    setStatus("Graph ready.");
  } catch (error) {
    graphData = null;
    setGraphStatus("Graph not loaded");
    setStatus(error.message || "Could not load /graph.json.");
    renderSkillList("");
  }
}

if (dom.btnRun) {
  dom.btnRun.addEventListener("click", runRecommendation);
}

if (dom.btnLoadGraph) {
  dom.btnLoadGraph.addEventListener("click", loadGraphFromServer);
}

if (dom.searchSkills) {
  dom.searchSkills.addEventListener("input", () => renderSkillList(dom.searchSkills.value));
}

if (dom.btnSelectVisible) {
  dom.btnSelectVisible.addEventListener("click", () => {
    [...document.querySelectorAll(".js-skill-select")].forEach((input) => {
      const row = input.closest(".skill-row");
      if (row && row.style.display !== "none") {
        input.checked = true;
      }
    });
  });
}

if (dom.btnClearSelection) {
  dom.btnClearSelection.addEventListener("click", () => {
    [...document.querySelectorAll(".js-skill-select")].forEach((input) => {
      input.checked = false;
    });
    [...document.querySelectorAll(".js-skill-score")].forEach((input) => {
      input.value = "";
    });
    if (dom.completedIds) dom.completedIds.value = "";
  });
}

setGraphStatus("Loading graph...");
loadGraphFromServer();
