document.addEventListener('DOMContentLoaded', () => {
  const completedIdsEl = document.getElementById('completedIds');
  const skillScoresEl = document.getElementById('skillScores');
  const searchSkillsEl = document.getElementById('searchSkills');
  const selectAllVisibleBtn = document.getElementById('selectAllVisible');
  const clearSelectionBtn = document.getElementById('clearSelection');
  const skillListEl = document.getElementById('skillList');
  const modeEl = document.getElementById('mode');
  const limitEl = document.getElementById('limit');
  const sortByEl = document.getElementById('sortBy');
  const includePartialEl = document.getElementById('includePartial');
  const skillIdEl = document.getElementById('skillId');
  const runBtn = document.getElementById('run');
  const loadGraphBtn = document.getElementById('loadGraph');
  const outputEl = document.getElementById('output');
  const graphPreview = document.getElementById('graphPreview');

  function pretty(obj) {
    try { return JSON.stringify(obj,null,2); } catch(e){ return String(obj); }
  }

  let currentGraph = null;
  function renderSkillList(graph, filter = '') {
    const entries = Object.entries(graph || {}).filter(([id, node]) => {
      if (!filter) return true;
      const q = filter.toLowerCase();
      return id.toLowerCase().includes(q) || String(node.title || '').toLowerCase().includes(q);
    }).slice(0, 1000);

    if (!entries.length) {
      skillListEl.innerHTML = '<div style="padding:8px;color:#64748b">No matching skills</div>';
      return;
    }

    const rows = entries.map(([id, node]) => {
      const title = (node.title || id).replace(/</g, '&lt;');
      return `
        <label class="skill-row" data-id="${id}">
          <input type="checkbox" class="skill-checkbox" data-id="${id}" />
          <span class="skill-id">${id}</span>
          <span class="skill-title">${title}</span>
          <input type="number" class="skill-score" min="0" max="100" placeholder="score" data-id="${id}" />
        </label>
      `;
    }).join('');

    skillListEl.innerHTML = rows;
  }

  loadGraphBtn.addEventListener('click', async () => {
    graphPreview.textContent = 'Loading...';
    try {
      const res = await fetch('/graph.json');
      if (!res.ok) throw new Error('Failed to fetch graph.json');
      const graph = await res.json();
      currentGraph = graph;
      renderSkillList(graph);
      graphPreview.innerHTML = `<strong>Loaded ${Object.keys(graph).length} sub-skills.</strong>`;
    } catch (err) {
      currentGraph = null;
      graphPreview.textContent = 'Error loading graph.json: ' + err.message;
    }
  });

  searchSkillsEl.addEventListener('input', (e) => {
    const q = e.target.value || '';
    renderSkillList(currentGraph || {}, q);
  });

  selectAllVisibleBtn.addEventListener('click', () => {
    skillListEl.querySelectorAll('.skill-checkbox').forEach(cb => cb.checked = true);
  });

  clearSelectionBtn.addEventListener('click', () => {
    skillListEl.querySelectorAll('.skill-checkbox').forEach(cb => cb.checked = false);
    skillListEl.querySelectorAll('.skill-score').forEach(inp => inp.value = '');
  });

  runBtn.addEventListener('click', async () => {
    outputEl.textContent = 'Calling API...';
    const completedRaw = completedIdsEl.value || '';
    const manualCompleted = completedRaw.split(',').map(s => s.trim()).filter(Boolean);

    // gather from rendered list
    const completedFromList = [...skillListEl.querySelectorAll('.skill-checkbox')]
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.id);

    const completedIds = Array.from(new Set([...manualCompleted, ...completedFromList]));

    const subSkillScores = [...skillListEl.querySelectorAll('.skill-score')]
      .map(inp => ({ id: inp.dataset.id, value: inp.value?.trim() }))
      .filter(x => x && x.value !== '')
      .map(x => ({ subSkillId: x.id, score: Number(x.value) }));

    let skillScores = [];
    try {
      const txt = skillScoresEl.value.trim();
      if (txt) skillScores = JSON.parse(txt);
    } catch (e) {
      outputEl.textContent = 'Invalid JSON in skill scores: ' + e.message; return;
    }

    const body = {
      mode: modeEl.value,
      completedIds,
      subSkillScores,
      skillScores,
      limit: limitEl.value ? Number(limitEl.value) : undefined,
      sortBy: sortByEl.value,
      includePartial: includePartialEl.checked,
      skillId: skillIdEl.value ? skillIdEl.value.trim() : undefined
    };

    try {
      const res = await fetch('/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      outputEl.textContent = pretty(json);
    } catch (err) {
      outputEl.textContent = 'Request failed: ' + err.message;
    }
  });
});
