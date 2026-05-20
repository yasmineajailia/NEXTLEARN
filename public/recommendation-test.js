let graphData = null;

const dom = {
  skillId: document.getElementById("skillId"),
  score: document.getElementById("score"),
  avg: document.getElementById("avg"),
  depth: document.getElementById("depth"),
  btnRun: document.getElementById("btnRun"),
  status: document.getElementById("status"),
  output: document.getElementById("output")
};

function setStatus(message) {
  dom.status.textContent = message || "";
}

function setOutput(value) {
  dom.output.textContent = value || "";
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== "object" || !graph.sub_skills) {
    return null;
  }
  return graph;
}

function populateSkills(graph) {
  dom.skillId.innerHTML = "";
  const entries = Object.values(graph.sub_skills)
    .filter((item) => item && item.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  entries.forEach((skill) => {
    const option = document.createElement("option");
    option.value = skill.id;
    option.textContent = `${skill.id} - ${skill.title || "(sans titre)"}`;
    dom.skillId.appendChild(option);
  });

  if (!entries.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No skills loaded";
    dom.skillId.appendChild(option);
  }
}

function bfsPrereqs(startIds, graph, maxDepth) {
  const visited = new Set(startIds);
  const queue = startIds.map((id) => ({ id, depth: 0 }));
  const out = [];

  while (queue.length) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const deps = graph.sub_skills?.[id]?.depends_on || [];

    deps.forEach((dep) => {
      if (visited.has(dep)) return;
      visited.add(dep);
      out.push({ id: dep, depth: depth + 1, reason: "prerequisite" });
      queue.push({ id: dep, depth: depth + 1 });
    });
  }

  return out;
}

function listUnlocks(startIds, graph) {
  const out = [];
  const seen = new Set();
  startIds.forEach((id) => {
    const unlocks = graph.sub_skills?.[id]?.unlocks || [];
    unlocks.forEach((nextId) => {
      if (seen.has(nextId)) return;
      seen.add(nextId);
      out.push({ id: nextId, depth: 1, reason: "unlocks" });
    });
  });
  return out;
}

function enrich(items, graph) {
  return items.map((item) => ({
    ...item,
    title: graph.sub_skills?.[item.id]?.title || "(titre manquant)"
  }));
}

function runRecommendation() {
  if (!graphData) {
    setStatus("Load graph.json first.");
    setOutput("");
    return;
  }

  const skillId = String(dom.skillId.value || "").trim();
  const score = Number(dom.score.value);
  const avg = Number(dom.avg.value);
  const depth = Math.max(1, Number(dom.depth.value || 2));

  if (!skillId) {
    setStatus("Select a sub-skill.");
    return;
  }

  if (!Number.isFinite(score) || !Number.isFinite(avg)) {
    setStatus("Enter valid score and average.");
    return;
  }

  setStatus("");

  const failedSkillIds = [skillId];
  let recommendations = [];
  let decision = "";

  if (score < avg) {
    decision = "below-average";
    recommendations = bfsPrereqs(failedSkillIds, graphData, depth);
  } else {
    decision = "above-average";
    recommendations = listUnlocks(failedSkillIds, graphData);
  }

  const output = {
    decision,
    input: { skillId, score, avg, maxDepth: depth },
    recommendations: enrich(recommendations, graphData)
  };

  setOutput(JSON.stringify(output, null, 2));
}

async function loadGraphFromServer() {
  try {
    const resp = await fetch("/graph.json");
    if (!resp.ok) {
      throw new Error("not-found");
    }
    const data = normalizeGraph(await resp.json());
    if (!data) {
      throw new Error("invalid-json");
    }
    graphData = data;
    populateSkills(data);
    setStatus("Graph loaded from /graph.json.");
  } catch (_error) {
    setStatus("Could not load /graph.json. Make sure the server is running.");
  }
}

if (dom.btnRun) {
  dom.btnRun.addEventListener("click", runRecommendation);
}

setStatus("Loading graph.json...");
loadGraphFromServer();
