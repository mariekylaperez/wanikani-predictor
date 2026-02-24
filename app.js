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
// Minimum time per level assuming perfect windows + 0 mistakes
// Radicals: 4h+8h+23h+47h = 82h to Guru
// Kanji unlocked after radicals Guru, same ladder = 82h more
// But ~50% of kanji are available from lesson start, so kanji ladder
// runs in parallel. WK's stated minimum for fast levels = ~3d 10h
const MINIMUM_DAYS_PER_LEVEL = 3.42;

// SRS intervals in hours per stage
const SRS_INTERVALS = [4, 8, 23, 47]; // App1→2, App2→3, App3→4, App4→Guru

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
function computeSpeedup(reviewStats) {
  let correct = 0, incorrect = 0;
  for (const rs of reviewStats) {
    correct   += rs.data.meaning_correct + rs.data.reading_correct;
    incorrect += rs.data.meaning_incorrect + rs.data.reading_incorrect;
  }
  const total    = correct + incorrect;
  const accuracy = total > 0 ? (correct / total) * 100 : 100;

  // Each wrong answer costs one extra SRS interval on average
  // Average interval across all 4 stages = (4+8+23+47)/4 = 20.5h
  const avgIntervalHours = 20.5;

  // Extra hours per level due to mistakes:
  // incorrectRate * totalReviewsPerLevel * avgIntervalHours
  // A typical level has ~100 reviews (radicals + kanji + vocab)
  const estReviewsPerLevel  = 100;
  const incorrectRate       = total > 0 ? incorrect / total : 0;
  const extraHoursPerLevel  = incorrectRate * estReviewsPerLevel * avgIntervalHours;
  const extraDaysPerLevel   = extraHoursPerLevel / 24;

  // Window loss = actual median minus theoretical minimum
  const windowLostPerLevel  = Math.max(0, _stats.median - MINIMUM_DAYS_PER_LEVEL);

  // Perfect scenario = minimum days (window perfect + no mistakes)
  // Realistic best = minimum + small buffer for sleep (can't always hit 4h window)
  const sleepBufferDays     = 0.5; // ~12h buffer for sleep schedule
  const realisticBestDays   = MINIMUM_DAYS_PER_LEVEL + sleepBufferDays;

  return {
    accuracy,
    total,
    incorrect,
    extraDaysPerLevel,
    windowLostPerLevel,
    realisticBestDays,
  };
}

// ── render speedup ─────────────────────────────────────────────────────────
function renderSpeedup(speedup) {
  const left         = 60 - _currentLevel;
  const currentDate  = addDays(new Date(), left * _stats.median);
  const perfectDate  = addDays(new Date(), left * MINIMUM_DAYS_PER_LEVEL);
  const realistDate  = addDays(new Date(), left * speedup.realisticBestDays);
  const noMistakeDate = addDays(new Date(), left * Math.max(MINIMUM_DAYS_PER_LEVEL, _stats.median - speedup.extraDaysPerLevel));

  const accColor = speedup.accuracy >= 90 ? '#4a7c59' : speedup.accuracy >= 75 ? 'var(--gold)' : 'var(--red)';
  const accTip   = speedup.accuracy >= 90
    ? 'Great accuracy — review windows are your main lever.'
    : speedup.accuracy >= 75
    ? 'Improving accuracy will meaningfully speed up your levels.'
    : 'Accuracy is your biggest bottleneck — each wrong answer adds ~20h per item.';

  document.getElementById('speedup-section').innerHTML = `
    <div class="speedup-header">
      <div class="eyebrow" style="color:var(--gold);margin-bottom:4px">How to go faster</div>
      <h2 class="speedup-title">Your road to Level 60</h2>
      <p class="speedup-sub">Two levers: review timing and accuracy</p>
    </div>

    <!-- Current vs best projections -->
    <div class="proj-grid">
      <div class="proj-box current">
        <div class="proj-label">At your current pace</div>
        <div class="proj-date">${fmtDate(currentDate)}</div>
        <div class="proj-rel">${relDays(currentDate)}</div>
        <div class="proj-detail">${fmtDays(_stats.median)} / level</div>
      </div>
      <div class="proj-box best">
        <div class="proj-label">Perfect windows + accuracy</div>
        <div class="proj-date">${fmtDate(perfectDate)}</div>
        <div class="proj-rel">${relDays(perfectDate)}</div>
        <div class="proj-detail">${fmtDays(MINIMUM_DAYS_PER_LEVEL)} / level (theoretical min)</div>
      </div>
      <div class="proj-box realistic">
        <div class="proj-label">Realistic best case</div>
        <div class="proj-date">${fmtDate(realistDate)}</div>
        <div class="proj-rel">${relDays(realistDate)}</div>
        <div class="proj-detail">${fmtDays(speedup.realisticBestDays)} / level (min + sleep buffer)</div>
      </div>
    </div>

    <!-- Lever 1: Windows -->
    <div class="card gold">
      <div class="eyebrow">Lever 1 — Hit every review window</div>
      <p class="lever-intro">
        WaniKani unlocks reviews at fixed intervals. The moment a window opens,
        the clock stops — but if you miss it, your item just waits until next time you log in.
        The early windows matter most.
      </p>
      <div class="srs-ladder">
        ${SRS_INTERVALS.map((h, i) => `
          <div class="srs-step${i === 0 ? ' highlight' : ''}">
            <div class="srs-step-stage">App ${i + 1}→${i + 2 <= 4 ? i + 2 : 'Guru'}</div>
            <div class="srs-step-time">${h}h</div>
            ${i === 0 ? '<div class="srs-step-note">most critical</div>' : ''}
          </div>
          ${i < SRS_INTERVALS.length - 1 ? '<div class="srs-arrow">→</div>' : ''}
        `).join('')}
        <div class="srs-arrow">→</div>
        <div class="srs-step" style="border-color:var(--gold)">
          <div class="srs-step-stage">Guru ✓</div>
          <div class="srs-step-time" style="color:var(--gold)">82h</div>
        </div>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Your median vs theoretical minimum</span>
        <span class="insight-row-val">${fmtDays(_stats.median)} vs ${fmtDays(MINIMUM_DAYS_PER_LEVEL)}</span>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Days lost per level to missed windows</span>
        <span class="insight-row-val ${speedup.windowLostPerLevel > 7 ? 'bad' : speedup.windowLostPerLevel > 3 ? 'warn' : 'good'}">${fmtDays(speedup.windowLostPerLevel)}</span>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Time saved across ${left} remaining levels</span>
        <span class="insight-row-val good">${fmtDays(speedup.windowLostPerLevel * left)}</span>
      </div>
      <div class="lever-tip">
        💡 Set a reminder for ~4 hours after your daily lessons to catch that first Apprentice window.
        Missing it by even a few hours cascades into losing a full day.
      </div>
    </div>

    <!-- Lever 2: Accuracy -->
    <div class="card gold">
      <div class="eyebrow">Lever 2 — Get reviews right</div>
      <p class="lever-intro">
        Every wrong answer bumps an item back one SRS stage, adding ~20h before it's due again.
        For radicals and kanji — which directly gate your level-up — each mistake is a direct delay.
      </p>
      <div class="acc-display">
        <div class="acc-circle" style="--acc-color:${accColor}">
          <div class="acc-number" style="color:${accColor}">${speedup.accuracy.toFixed(1)}%</div>
          <div class="acc-label">accuracy</div>
        </div>
        <div class="acc-detail">
          <p class="acc-tip">${accTip}</p>
          <div class="insight-row">
            <span class="insight-row-label">Total reviews on your current levels</span>
            <span class="insight-row-val">${speedup.total.toLocaleString()}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Incorrect answers</span>
            <span class="insight-row-val ${speedup.accuracy < 75 ? 'bad' : 'warn'}">${speedup.incorrect.toLocaleString()}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Extra days added per level by mistakes</span>
            <span class="insight-row-val ${speedup.extraDaysPerLevel > 3 ? 'bad' : speedup.extraDaysPerLevel > 1 ? 'warn' : 'good'}">${fmtDays(speedup.extraDaysPerLevel)}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Level 60 if you got everything right</span>
            <span class="insight-row-val good">${fmtDate(noMistakeDate)}</span>
          </div>
        </div>
      </div>
      <div class="lever-tip">
        💡 Before reviews, spend 10 seconds recalling the item meaning and reading.
        Leeches (items you keep getting wrong) are worth drilling separately — the WaniKani
        self-study quiz is good for this.
      </div>
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

  // Fetch review stats only for current run levels — fast, single request
  const currentLevel = user.data.current_level;
  const levelNums = Array.from({ length: currentLevel }, (_, i) => i + 1).join(',');
  setLoadingMsg('Fetching review statistics...');
  const rsRes = await fetch(
    `https://api.wanikani.com/v2/review_statistics?levels=${levelNums}`,
    { headers }
  );
  let reviewStats = [];
  if (rsRes.ok) {
    const rsJson = await rsRes.json();
    reviewStats = rsJson.data || [];
    // Handle pagination just in case (unlikely at level 6 but safe)
    let next = rsJson.pages?.next_url || null;
    while (next) {
      const r = await fetch(next, { headers });
      const j = await r.json();
      reviewStats = reviewStats.concat(j.data);
      next = j.pages?.next_url || null;
    }
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
  for (let i = 0; i < 120; i++) {
    const wrong = Math.floor(Math.random() * 6);
    reviewStats.push({
      data: {
        meaning_correct: 5 + Math.floor(Math.random() * 15),
        meaning_incorrect: Math.floor(wrong / 2),
        reading_correct: 5 + Math.floor(Math.random() * 15),
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
    const speedup = computeSpeedup(data.reviewStats);
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
