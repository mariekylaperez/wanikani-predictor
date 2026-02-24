// ── state ──────────────────────────────────────────────────────────────────
let _stats = null;
let _currentLevel = 0;
let _activePace = 'median';

// ── helpers ────────────────────────────────────────────────────────────────
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const fmtDate = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = d => new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

function relDays(d) {
  const diff = Math.round((d - Date.now()) / 864e5);
  if (diff <= 0) return 'in the past';
  if (diff < 30) return `${diff}d from now`;
  if (diff < 365) return `~${Math.round(diff / 30)}mo from now`;
  return `~${(diff / 365).toFixed(1)}yr from now`;
}

// ── stats computation ──────────────────────────────────────────────────────

// If the user has ever reset, there will be duplicate level numbers in their
// progressions (e.g. two level 1s, two level 2s, etc.). We keep only the most
// recently started progression for each level so we analyse the current run only.
function getLatestRun(progressions) {
  const byLevel = {};
  for (const p of progressions) {
    const lvl = p.data.level;
    if (!byLevel[lvl] || new Date(p.data.started_at) > new Date(byLevel[lvl].data.started_at)) {
      byLevel[lvl] = p;
    }
  }
  return Object.values(byLevel).sort((a, b) => a.data.level - b.data.level);
}

function computeStats(progressions, currentLevel) {
  const latest = getLatestRun(progressions);
  const done = latest.filter(p =>
    p.data.passed_at && !p.data.abandoned_at && p.data.level < currentLevel
  );
  if (done.length < 2) return null;

  const durs = done.map(p =>
    (new Date(p.data.passed_at) - new Date(p.data.started_at)) / 864e5
  );
  const sorted = [...durs].sort((a, b) => a - b);
  const avg    = durs.reduce((s, d) => s + d, 0) / durs.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const fast   = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
  const slow   = sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1];
  const rec    = durs.slice(-5);
  const recent = rec.reduce((s, d) => s + d, 0) / rec.length;

  return { avg, median, fast, slow, recent, durs, sorted, done };
}

// ── WaniKani API fetch ─────────────────────────────────────────────────────
async function fetchWK(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Wanikani-Revision': '20170710'
  };

  const uRes = await fetch('https://api.wanikani.com/v2/user', { headers });
  if (uRes.status === 401) throw new Error('Invalid API key — check wanikani.com/settings/personal_access_tokens');
  if (!uRes.ok) throw new Error(`API error ${uRes.status}`);
  const user = await uRes.json();

  let url = 'https://api.wanikani.com/v2/level_progressions';
  let progressions = [];
  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const j = await r.json();
    progressions = progressions.concat(j.data);
    url = j.pages?.next_url || null;
  }

  return { user, progressions };
}

// ── demo data ──────────────────────────────────────────────────────────────
function getDemoData() {
  const p = [];
  let d = new Date('2023-01-15');
  for (let l = 1; l <= 32; l++) {
    const start = new Date(d);
    const days = l <= 10
      ? 7 + Math.random() * 4
      : l <= 20
        ? 9 + Math.random() * 6
        : 12 + Math.random() * 10;
    d = new Date(d.getTime() + days * 864e5);
    p.push({
      data: {
        level: l,
        started_at: start.toISOString(),
        passed_at: l < 32 ? d.toISOString() : null,
        abandoned_at: null
      }
    });
  }
  return {
    user: { data: { current_level: 32, username: 'demo_user' } },
    progressions: p
  };
}

// ── render ─────────────────────────────────────────────────────────────────
function render(data, isDemo) {
  const lvl = data.user.data.current_level ?? data.user.data.level;
  _currentLevel = lvl;
  const stats = computeStats(data.progressions, lvl);
  _stats = stats;

  if (!stats) {
    showError('Need at least 2 completed level progressions to predict. Keep going! 頑張って！');
    setLoading(false);
    return;
  }

  // stats grid
  document.getElementById('stats-grid').innerHTML = [
    [lvl, 'Current Level'],
    [stats.done.length, 'Levels Passed'],
    [Math.round(stats.median) + 'd', 'Median / Level'],
    [Math.round(stats.recent) + 'd', 'Recent (5 lvls)'],
  ].map(([v, l], i) => `
    <div class="stat" style="animation-delay:${0.05 + i * 0.07}s">
      <div class="stat-val">${v}</div>
      <div class="stat-lbl">${l}</div>
    </div>`).join('');

  // pace pills
  renderPills();

  // prediction
  updatePrediction();

  // level chart
  const shown = stats.done.slice(-30);
  const maxD = Math.max(...stats.durs);

  document.getElementById('chart-label').textContent =
    `Days per level — last ${shown.length} levels (current run)`;

  document.getElementById('chart').innerHTML =
    shown.map(p => {
      const days   = (new Date(p.data.passed_at) - new Date(p.data.started_at)) / 864e5;
      const pct    = Math.min(100, (days / maxD) * 100);
      const col    = days > stats.median * 1.5 ? '#c0392b'
                   : days < stats.median * 0.7  ? '#c9943a'
                   : '#4a7c59';
      const passed = fmtShort(p.data.passed_at);
      return `<div class="bar-row">
        <div class="bar-lv">Lv ${p.data.level}</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${col}"></div></div>
        <div class="bar-meta"><strong>${Math.round(days)}d</strong> · ${passed}</div>
      </div>`;
    }).join('')
    + `<div class="bar-row" style="margin-top:8px">
        <div class="bar-lv" style="color:var(--red)">Lv ${lvl}</div>
        <div class="bar-bg"><div class="bar-fill" style="width:35%;background:repeating-linear-gradient(45deg,var(--border),var(--border) 2px,transparent 2px,transparent 6px)"></div></div>
        <div class="bar-meta" style="font-style:italic;color:var(--muted)">in progress</div>
      </div>`;

  // show results
  document.getElementById('input-card').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  document.getElementById('results').style.display = 'block';
  document.getElementById('reset-btn').style.display = 'block';

  if (isDemo) {
    const note = document.createElement('p');
    note.className = 'demo-note';
    note.textContent = 'Showing demo data — enter your real API key for actual predictions';
    document.getElementById('results').prepend(note);
  }
}

// ── prediction update ──────────────────────────────────────────────────────
function updatePrediction() {
  if (!_stats) return;
  const stats = _stats;
  const left  = 60 - _currentLevel;
  const paceMap = {
    fast: stats.fast, median: stats.median,
    avg: stats.avg,   slow: stats.slow,
    recent: stats.recent
  };
  const dpL  = paceMap[_activePace] || stats.median;
  const pred = addDays(new Date(), left * dpL);
  const fast = addDays(new Date(), left * stats.fast);
  const mid  = addDays(new Date(), left * stats.median);
  const slow = addDays(new Date(), left * stats.slow);

  document.getElementById('pred-date').textContent = fmtDate(pred);
  document.getElementById('pred-sub').textContent =
    `${relDays(pred)} · ${Math.round(dpL)}d/level · ${left} levels remaining`;

  document.getElementById('scenarios').innerHTML = [
    ['Optimistic',   fast],
    ['Median',       mid],
    ['Conservative', slow],
  ].map(([label, d]) => `
    <div class="scenario">
      <div class="sc-label">${label}</div>
      <div class="sc-year">${d.getFullYear()}</div>
      <div class="sc-rel">${relDays(d)}</div>
    </div>`).join('');

  renderPills();
}

function renderPills() {
  const paces = [
    ['fast',   'Fast 25%'],
    ['median', 'Median'],
    ['avg',    'Average'],
    ['recent', 'Recent 5'],
    ['slow',   'Slow 75%'],
  ];
  document.getElementById('pace-row').innerHTML = paces
    .map(([k, label]) =>
      `<button class="pace-pill${k === _activePace ? ' active' : ''}" onclick="setPace('${k}')">${label}</button>`
    ).join('');
}

function setPace(p) {
  _activePace = p;
  updatePrediction();
}

// ── main actions ──────────────────────────────────────────────────────────
async function run() {
  const token = document.getElementById('token-input').value.trim();
  if (!token) { showError('Please enter your API key.'); return; }
  clearError();
  setLoading(true);
  try {
    const data = await fetchWK(token);
    render(data, false);
  } catch (e) {
    setLoading(false);
    showError(e.message);
  }
}

function runDemo() {
  clearError();
  setLoading(true);
  setTimeout(() => render(getDemoData(), true), 300);
}

function reset() {
  document.getElementById('input-card').style.display = 'block';
  document.getElementById('results').style.display = 'none';
  document.getElementById('reset-btn').style.display = 'none';
  const note = document.querySelector('#results .demo-note');
  if (note) note.remove();
  _stats = null;
  _activePace = 'median';
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('loading').style.display = on ? 'block' : 'none';
  document.getElementById('input-card').style.display = on ? 'none' : 'block';
  document.getElementById('fetch-btn').disabled = on;
}

function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = msg;
  el.style.display = 'block';
}

function clearError() {
  document.getElementById('error-box').style.display = 'none';
}

// ── event listeners ────────────────────────────────────────────────────────
document.getElementById('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') run();
});
