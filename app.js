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

function fmtDays(d) {
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 2) return `${d.toFixed(1)}d`;
  return `${Math.round(d)}d`;
}

// ── SRS constants ──────────────────────────────────────────────────────────
const MINIMUM_DAYS_PER_LEVEL = 3.42;
const AVG_EXTRA_HOURS_PER_MISTAKE = 20.5;

// ── stats computation ──────────────────────────────────────────────────────
function getCurrentRunStart(progressions) {
  if (!progressions.length) return null;
  const sorted = [...progressions].sort(
    (a, b) => new Date(a.data.started_at) - new Date(b.data.started_at)
  );
  let runStartDate = new Date(sorted[0].data.started_at);
  let prevLevel = 0;
  for (const p of sorted) {
    if (p.data.level <= prevLevel && p.data.level <= 5) {
      runStartDate = new Date(p.data.started_at);
    }
    prevLevel = p.data.level;
  }
  return runStartDate;
}

function computeStats(progressions, currentLevel) {
  const runStart = getCurrentRunStart(progressions);
  const currentRun = progressions.filter(p =>
    new Date(p.data.started_at) >= runStart
  );
  const done = currentRun.filter(p =>
    p.data.passed_at && !p.data.abandoned_at && p.data.level < currentLevel
  );
  if (done.length < 2) return null;

  done.sort((a, b) => a.data.level - b.data.level);

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

// ── speedup analysis ───────────────────────────────────────────────────────
function computeSpeedup(reviewStats, stats) {
  const median = stats.median;
  const left   = 60 - _currentLevel;

  const windowLostPerLevel = Math.max(0, median - MINIMUM_DAYS_PER_LEVEL);
  const windowSavingTotal  = windowLostPerLevel * left;

  let totalMeaningIncorrect = 0;
  let totalReadingIncorrect = 0;
  let totalMeaningCorrect   = 0;
  let totalReadingCorrect   = 0;
  let totalExtraHours       = 0;
  let leechCount            = 0;

  for (const rs of reviewStats) {
    const d = rs.data;
    totalMeaningIncorrect += d.meaning_incorrect;
    totalReadingIncorrect += d.reading_incorrect;
    totalMeaningCorrect   += d.meaning_correct;
    totalReadingCorrect   += d.reading_correct;
    const totalWrong = d.meaning_incorrect + d.reading_incorrect;
    totalExtraHours += totalWrong * AVG_EXTRA_HOURS_PER_MISTAKE;
    if (totalWrong >= 4) leechCount++;
  }

  const totalAnswers  = totalMeaningCorrect + totalReadingCorrect +
                        totalMeaningIncorrect + totalReadingIncorrect;
  const totalWrong    = totalMeaningIncorrect + totalReadingIncorrect;
  const overallAcc    = totalAnswers > 0
    ? ((totalAnswers - totalWrong) / totalAnswers * 100)
    : 100;

  const mistakeDaysLost         = totalExtraHours / 24;
  const mistakeDaysLostPerLevel = stats.done.length > 0
    ? mistakeDaysLost / stats.done.length
    : 0;
  const mistakeSavingTotal      = mistakeDaysLostPerLevel * left;
  const combinedSaving = Math.max(windowSavingTotal, mistakeSavingTotal) +
                         Math.min(windowSavingTotal, mistakeSavingTotal) * 0.4;

  return {
    windowLostPerLevel, windowSavingTotal,
    mistakeDaysLostPerLevel, mistakeSavingTotal,
    combinedSaving, overallAcc, totalWrong, totalAnswers, leechCount
  };
}

// ── render speedup ─────────────────────────────────────────────────────────
function renderSpeedup(speedup) {
  const left = 60 - _currentLevel;

  document.getElementById('insight-grid').innerHTML = `
    <div class="insight-box">
      <div class="insight-saving">${fmtDays(speedup.windowLostPerLevel)}</div>
      <div class="insight-saving-label">lost per level</div>
      <div class="insight-desc">to missed review windows vs hitting every session on time</div>
    </div>
    <div class="insight-box">
      <div class="insight-saving">${fmtDays(speedup.mistakeDaysLostPerLevel)}</div>
      <div class="insight-saving-label">lost per level</div>
      <div class="insight-desc">to incorrect answers pushing items back in the SRS queue</div>
    </div>
    <div class="insight-box">
      <div class="insight-saving">${fmtDays(speedup.combinedSaving)}</div>
      <div class="insight-saving-label">total potential saving</div>
      <div class="insight-desc">across your remaining ${left} levels if you optimise both</div>
    </div>
  `;

  const idealDate  = addDays(new Date(), left * MINIMUM_DAYS_PER_LEVEL);
  const actualDate = addDays(new Date(), left * _stats.median);

  document.getElementById('windows-content').innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">
      WaniKani's SRS has fixed intervals. Every time you miss a review window, that item
      sits idle until the next time you log in — adding hours or days to its progression.
      Your actual median is <strong style="color:var(--ink)">${fmtDays(_stats.median)}/level</strong>.
      The theoretical minimum with perfect timing is <strong style="color:#4a7c59">${fmtDays(MINIMUM_DAYS_PER_LEVEL)}/level</strong>.
    </p>
    <div class="eyebrow" style="margin-bottom:8px">SRS ladder (radical / kanji path to Guru)</div>
    <div class="srs-ladder">
      <div class="srs-step"><div class="srs-step-stage">Lesson</div><div class="srs-step-time">0h</div></div>
      <div class="srs-arrow">→</div>
      <div class="srs-step"><div class="srs-step-stage">App 1</div><div class="srs-step-time">+4h</div></div>
      <div class="srs-arrow">→</div>
      <div class="srs-step"><div class="srs-step-stage">App 2</div><div class="srs-step-time">+8h</div></div>
      <div class="srs-arrow">→</div>
      <div class="srs-step"><div class="srs-step-stage">App 3</div><div class="srs-step-time">+23h</div></div>
      <div class="srs-arrow">→</div>
      <div class="srs-step"><div class="srs-step-stage">App 4</div><div class="srs-step-time">+47h</div></div>
      <div class="srs-arrow">→</div>
      <div class="srs-step" style="border-color:var(--gold)"><div class="srs-step-stage">Guru ✓</div><div class="srs-step-time" style="color:var(--gold)">82h</div></div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-bottom:16px;line-height:1.6">
      Missing the 4h window by just 4 hours costs you a full day. Missing the 8h window costs another.
      A consistent review routine — especially catching the short early windows — has the biggest impact.
    </p>
    <div class="ideal-vs-actual">
      <div class="ideal-box actual">
        <div class="ideal-box-label">Your actual median</div>
        <div class="ideal-box-val">${fmtDays(_stats.median)}</div>
        <div class="ideal-box-sub">per level</div>
      </div>
      <div class="ideal-box perfect">
        <div class="ideal-box-label">Perfect timing</div>
        <div class="ideal-box-val">${fmtDays(MINIMUM_DAYS_PER_LEVEL)}</div>
        <div class="ideal-box-sub">per level (theoretical)</div>
      </div>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Time lost per level to missed windows</span>
      <span class="insight-row-val ${speedup.windowLostPerLevel > 7 ? 'bad' : speedup.windowLostPerLevel > 3 ? 'warn' : 'good'}">${fmtDays(speedup.windowLostPerLevel)}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Total days saved across ${left} remaining levels</span>
      <span class="insight-row-val good">${fmtDays(speedup.windowSavingTotal)}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Level 60 with perfect windows</span>
      <span class="insight-row-val good">${fmtDate(idealDate)}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Level 60 at current pace</span>
      <span class="insight-row-val bad">${fmtDate(actualDate)}</span>
    </div>
  `;

  const accClass = speedup.overallAcc >= 90 ? 'good' : speedup.overallAcc >= 75 ? 'warn' : 'bad';

  document.getElementById('mistakes-content').innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">
      Every incorrect answer bumps an item back one SRS stage, adding an average of
      <strong style="color:var(--ink)">~${AVG_EXTRA_HOURS_PER_MISTAKE}h</strong> to that item's journey to Guru.
      For radicals and kanji — which gate your level-up — this directly delays progression.
    </p>
    <div class="insight-row">
      <span class="insight-row-label">Overall accuracy (all time)</span>
      <span class="insight-row-val ${accClass}">${speedup.overallAcc.toFixed(1)}%</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Total incorrect answers</span>
      <span class="insight-row-val ${speedup.totalWrong > 500 ? 'bad' : speedup.totalWrong > 200 ? 'warn' : 'good'}">${speedup.totalWrong.toLocaleString()}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Extra days added by mistakes (all levels)</span>
      <span class="insight-row-val warn">${fmtDays(speedup.mistakeDaysLostPerLevel * _stats.done.length)}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Extra delay per level from mistakes</span>
      <span class="insight-row-val ${speedup.mistakeDaysLostPerLevel > 3 ? 'bad' : speedup.mistakeDaysLostPerLevel > 1 ? 'warn' : 'good'}">${fmtDays(speedup.mistakeDaysLostPerLevel)}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Items answered wrong 4+ times (leeches)</span>
      <span class="insight-row-val ${speedup.leechCount > 50 ? 'bad' : speedup.leechCount > 20 ? 'warn' : 'good'}">${speedup.leechCount}</span>
    </div>
    <div class="insight-row">
      <span class="insight-row-label">Days saved across ${left} levels with 100% accuracy</span>
      <span class="insight-row-val good">${fmtDays(speedup.mistakeSavingTotal)}</span>
    </div>
  `;

  document.getElementById('speedup-section').style.display = 'block';
}

// ── WaniKani API fetch ─────────────────────────────────────────────────────
async function fetchWK(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Wanikani-Revision': '20170710'
  };

  setLoadingMsg('Fetching user data...');
  const uRes = await fetch('https://api.wanikani.com/v2/user', { headers });
  if (uRes.status === 401) throw new Error('Invalid API key — check wanikani.com/settings/personal_access_tokens');
  if (!uRes.ok) throw new Error(`API error ${uRes.status}`);
  const user = await uRes.json();

  setLoadingMsg('Fetching level progressions...');
  let url = 'https://api.wanikani.com/v2/level_progressions';
  let progressions = [];
  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const j = await r.json();
    progressions = progressions.concat(j.data);
    url = j.pages?.next_url || null;
  }

  setLoadingMsg('Fetching review statistics...');
  url = 'https://api.wanikani.com/v2/review_statistics';
  let reviewStats = [];
  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const j = await r.json();
    reviewStats = reviewStats.concat(j.data);
    url = j.pages?.next_url || null;
  }

  return { user, progressions, reviewStats };
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
  const reviewStats = [];
  for (let i = 0; i < 400; i++) {
    const wrong = Math.floor(Math.random() * 8);
    reviewStats.push({
      data: {
        meaning_correct: 5 + Math.floor(Math.random() * 20),
        meaning_incorrect: Math.floor(wrong / 2),
        reading_correct: 5 + Math.floor(Math.random() * 20),
        reading_incorrect: wrong - Math.floor(wrong / 2),
      }
    });
  }
  return {
    user: { data: { current_level: 32, username: 'demo_user' } },
    progressions: p,
    reviewStats
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

  renderPills();
  updatePrediction();

  const shown = stats.done.slice(-30);
  const maxD  = Math.max(...stats.durs);

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

  if (data.reviewStats && data.reviewStats.length > 0) {
    const speedup = computeSpeedup(data.reviewStats, stats);
    renderSpeedup(speedup);
  }

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

// ── main actions ───────────────────────────────────────────────────────────
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
  document.getElementById('speedup-section').style.display = 'none';
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

function setLoadingMsg(msg) {
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = msg;
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
