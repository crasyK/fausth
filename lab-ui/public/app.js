const worldList = document.getElementById('world-list');
const logEl = document.getElementById('log');
const runMeta = document.getElementById('run-meta');
const btnConformance = document.getElementById('btn-conformance');

let activeRunId = null;
let logOffset = 0;
let pollTimer = null;

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res;
}

async function loadWorlds() {
  const res = await api('/api/worlds');
  const data = await res.json();
  worldList.innerHTML = '';
  for (const w of data.worlds || []) {
    const el = document.createElement('article');
    el.className = 'world';
    el.innerHTML = `
      <div class="world-title">${escapeHtml(w.title)}</div>
      <div class="world-meta"><span class="status">${escapeHtml(w.status)}</span> · ${escapeHtml(w.summary || w.path)}</div>
      <div class="world-actions"></div>
    `;
    const actions = el.querySelector('.world-actions');
    if (w.track_a) {
      actions.appendChild(actionBtn('Track A test', () => startRun('track_a', w.id)));
    }
    if (w.case_study_manifest) {
      actions.appendChild(actionBtn('Recorded case-study', () => startRun('case_study_recorded', w.id)));
    }
    if (!actions.children.length) {
      const stub = document.createElement('span');
      stub.className = 'world-meta';
      stub.textContent = 'Stub — no run actions yet';
      actions.appendChild(stub);
    }
    worldList.appendChild(el);
  }
}

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function startRun(action, worldId) {
  logEl.textContent = '';
  logOffset = 0;
  runMeta.textContent = `Starting ${action}${worldId ? ` · ${worldId}` : ''}…`;
  const res = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ action, worldId }),
  });
  const data = await res.json();
  activeRunId = data.run.id;
  runMeta.textContent = `${data.run.kind} · ${data.run.worldId} · ${data.run.status}`;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollLog, 800);
  pollLog();
}

async function pollLog() {
  if (!activeRunId) return;
  const res = await fetch(`/api/runs/${activeRunId}/log?offset=${logOffset}`);
  if (!res.ok) return;
  const chunk = await res.text();
  const len = Number(res.headers.get('X-Log-Length') || 0);
  const status = res.headers.get('X-Run-Status') || '';
  if (chunk) {
    logEl.textContent += chunk;
    logEl.scrollTop = logEl.scrollHeight;
  }
  logOffset = len;
  runMeta.textContent = `${activeRunId} · ${status}`;
  if (status !== 'running' && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

btnConformance.addEventListener('click', () => startRun('conformance', 'repo'));

loadWorlds().catch((e) => {
  worldList.textContent = `Failed to load worlds: ${e.message}`;
});
