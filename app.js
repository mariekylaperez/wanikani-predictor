// ── state ──────────────────────────────────────────────────────────────────
let _stats = null;
let _currentLevel = 0;
let _activePace = 'median';

// ── review windows ─────────────────────────────────────────────────────────
const REVIEW_WINDOWS = [9, 18]; // 9am and 6pm (24h)

// ── helpers ────────────────────────────────────────────────────────────────
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const fmtDate = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = d => new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const fmtDateTime = d => d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });

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

// ── SRS intervals ──────────────────────────────────────────────────────────
// Hours to next review per stage (0-indexed: stage 0 = Apprentice 1)
const SRS_INTERVALS_H = [4, 8, 23, 47, 167, 335, 719, 2879];

// Given a date/time when an item becomes available, find the next
// review window (9am or 6pm) on or after that time.
function nextWindow(availableAt) {
  const d = new Date(availableAt);
  const hours = REVIEW_WINDOWS;

  // Try same day windows first, then next days
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const candidate = new Date(d);
    candidate.setDate(candidate.getDate() + dayOffset);
    for (const h of hours) {
      candidate.setHours(h, 0, 0, 0);
      if (candidate > d) return new Date(candidate);
    }
  }
  return d; // fallback
}

// Simulate an item through the SRS from its current stage until Guru (stage 4)
// Returns the date it reaches Guru given window-based reviews
function simulateToGuru(startDate, currentStage) {
  let reviewDate = new Date(startDate);
  let stage = currentStage;

  while (stage < 4) {
    // Item becomes available after interval
    const availableAt = new Date(reviewDate.getTime() + SRS_INTERVALS_H[stage] * 3600000);
    // Next window on or after available time
    reviewDate = nextWindow(availableAt);
    stage++;
  }
  return reviewDate; // date when item reaches Guru
}

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

// ── window-based level time ────────────────────────────────────────────────
// Calculate how many days a level takes if you do reviews at 9am and 6pm only.
// Simulates the critical path: radicals → Guru, then kanji → Guru (90% needed).
function calcWindowLevelDays(lessonTime) {
  // Simulate a radical going from lesson → Guru at window-based reviews
  // Stage 0 = just learned (Apprentice 1)
  const radicalGuruDate = simulateToGuru(lessonTime, 0);

  // Kanji unlocked after radicals Guru. Simulate kanji from that point.
  const kanjiGuruDate = simulateToGuru(radicalGuruDate, 0);

  // Level-up happens when 90% of kanji reach Guru.
  // The last kanji to Guru determines level-up time.
  // Simplification: use the single-path simulation as the critical path.
  const levelUpDate = kanjiGuruDate;
  const days = (levelUpDate - lessonTime) / 864e5;
  return { days, levelUpDate };
}

// ── next level prediction ──────────────────────────────────────────────────
function computeNextLevel(assignments) {
  const now = new Date();

  // Filter to current level radicals and kanji in Apprentice stages (0-3)
  const blocking = assignments.filter(a => {
    const d = a.data;
    return (d.subject_type === 'radical' || d.subject_type === 'kanji') &&
           d.srs_stage < 4 && // not yet Guru
           !d.burned_at &&
           d.started_at; // has been started (not just available)
  });

  if (blocking.length === 0) {
    // All radicals/kanji are Guru+ — level up is imminent (just needs review session)
    return {
      levelUpDate: nextWindow(now),
      blockingCount: 0,
      criticalItem: null,
    };
  }

  // For each blocking item, simulate when it reaches Guru
  const guruDates = blocking.map(a => {
    const d = a.data;
    const stage = d.srs_stage; // 0=App1, 1=App2, 2=App3, 3=App4
    // Available at = when the next review is due
    const availableAt = d.available_at ? new Date(d.available_at) : now;
    // If already available, use now
    const startFrom = availableAt <= now ? now : availableAt;
    // Simulate from current stage (already at this stage, just needs review)
    const guruDate = simulateToGuru(startFrom, stage);
    return { guruDate, stage, type: d.subject_type, availableAt };
  });

  // Sort by guru date descending — the last item to Guru determines level-up
  guruDates.sort((a, b) => b.guruDate - a.guruDate);

  // Level-up needs 90% of kanji at Guru. Find the date when 90% are done.
  const kanjiItems = guruDates.filter(g => g.type === 'kanji');
  const radicalItems = guruDates.filter(g => g.type === 'radical');

  let levelUpDate;
  if (kanjiItems.length > 0) {
    // 90th percentile of kanji guru dates
    const idx = Math.floor(kanjiItems.length * 0.1); // 10% from end = 90th percentile
    const sortedKanji = [...kanjiItems].sort((a, b) => a.guruDate - b.guruDate);
    levelUpDate = sortedKanji[Math.max(0, sortedKanji.length - 1 - idx)].guruDate;
  } else {
    // Only radicals blocking — use last radical
    levelUpDate = guruDates[0].guruDate;
  }

  const criticalItem = guruDates[0]; // slowest item

  return {
    levelUpDate,
    blockingCount: blocking.length,
    criticalItem,
    stageBreakdown: [0,1,2,3].map(s => ({
      stage: s,
      count: blocking.filter(a => a.data.srs_stage === s).length,
      label: ['App 1','App 2','App 3','App 4'][s]
    })).filter(s => s.count > 0)
  };
}

// ── window-based road to 60 ────────────────────────────────────────────────
function calcWindowRoadTo60() {
  const left = 60 - _currentLevel;
  // Use next 9am as the start of each level (lesson time)
  const firstLesson = nextWindow(new Date());
  const { days: windowDaysPerLevel } = calcWindowLevelDays(firstLesson);
  const windowDate = addDays(new Date(), left * windowDaysPerLevel);
  return { windowDaysPerLevel, windowDate };
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

  const avgIntervalHours   = 20.5;
  const estReviewsPerLevel = 100;
  const incorrectRate      = total > 0 ? incorrect / total : 0;
  const extraHoursPerLevel = incorrectRate * estReviewsPerLevel * avgIntervalHours;
  const extraDaysPerLevel  = extraHoursPerLevel / 24;

  const windowLostPerLevel = Math.max(0, _stats.median - calcWindowRoadTo60().windowDaysPerLevel);

  return {
    accuracy, total, incorrect, extraDaysPerLevel, windowLostPerLevel,
  };
}

// ── render next level ──────────────────────────────────────────────────────
function renderNextLevel(nextLevel) {
  const { levelUpDate, blockingCount, criticalItem, stageBreakdown } = nextLevel;
  const now = new Date();
  const daysUntil = (levelUpDate - now) / 864e5;

  const stageHtml = stageBreakdown ? stageBreakdown.map(s => `
    <div class="stage-pip">
      <div class="stage-pip-count">${s.count}</div>
      <div class="stage-pip-label">${s.label}</div>
    </div>
  `).join('') : '';

  document.getElementById('next-level-content').innerHTML = `
    <div class="next-level-grid">
      <div class="next-level-date">
        <div class="proj-label">Level ${_currentLevel + 1} unlocks</div>
        <div class="next-date-big">${fmtDateTime(levelUpDate)}</div>
        <div class="proj-rel">${fmtDays(Math.max(0, daysUntil))} from now</div>
      </div>
      <div class="next-level-meta">
        <div class="insight-row">
          <span class="insight-row-label">Items still blocking level-up</span>
          <span class="insight-row-val ${blockingCount > 20 ? 'bad' : blockingCount > 5 ? 'warn' : 'good'}">${blockingCount}</span>
        </div>
        ${stageBreakdown && stageBreakdown.length ? `
        <div class="insight-row" style="align-items:center">
          <span class="insight-row-label">Breakdown by SRS stage</span>
          <div class="stage-pips">${stageHtml}</div>
        </div>` : ''}
        ${criticalItem ? `
        <div class="insight-row">
          <span class="insight-row-label">Slowest item reaches Guru</span>
          <span class="insight-row-val warn">${fmtDateTime(criticalItem.guruDate)}</span>
        </div>` : ''}
        <div class="insight-row">
          <span class="insight-row-label">Based on review windows</span>
          <span class="insight-row-val" style="font-size:12px;font-family:'DM Mono',monospace">${REVIEW_WINDOWS.map(h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`).join(' & ')}</span>
        </div>
      </div>
    </div>
    <div class="lever-tip">
      💡 This assumes you do your reviews at every ${REVIEW_WINDOWS.map(h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`).join(' and ')} window without missing any.
      Missing even one window pushes this date back by hours.
    </div>
  `;

  document.getElementById('next-level-section').style.display = 'block';
}

// ── render speedup ─────────────────────────────────────────────────────────
function renderSpeedup(speedup) {
  const left = 60 - _currentLevel;
  const currentDate  = addDays(new Date(), left * _stats.median);
  const { windowDaysPerLevel, windowDate } = calcWindowRoadTo60();
  const noMistakeDate = addDays(new Date(), left * Math.max(windowDaysPerLevel, _stats.median - speedup.extraDaysPerLevel));

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
      <p class="speedup-sub">9am & 6pm review windows · two levers</p>
    </div>

    <div class="proj-grid">
      <div class="proj-box current">
        <div class="proj-label">At your current pace</div>
        <div class="proj-date">${fmtDate(currentDate)}</div>
        <div class="proj-rel">${relDays(currentDate)}</div>
        <div class="proj-detail">${fmtDays(_stats.median)} / level</div>
      </div>
      <div class="proj-box realistic">
        <div class="proj-label">9am & 6pm windows only</div>
        <div class="proj-date">${fmtDate(windowDate)}</div>
        <div class="proj-rel">${relDays(windowDate)}</div>
        <div class="proj-detail">${fmtDays(windowDaysPerLevel)} / level (simulated)</div>
      </div>
      <div class="proj-box best">
        <div class="proj-label">Windows + perfect accuracy</div>
        <div class="proj-date">${fmtDate(noMistakeDate)}</div>
        <div class="proj-rel">${relDays(noMistakeDate)}</div>
        <div class="proj-detail">${fmtDays(windowDaysPerLevel)} / level + no mistakes</div>
      </div>
    </div>

    <div class="card gold">
      <div class="eyebrow">Lever 1 — Hit every review window</div>
      <p class="lever-intro">
        Your two daily windows are 9am and 6pm. The SRS intervals are fixed — miss a window
        and the item waits until your next slot. The 4h Apprentice 1 window is the most critical:
        do your lessons at 9am, catch the 4h review by 1pm, then it flows into the 6pm window naturally.
      </p>
      <div class="srs-ladder">
        <div class="srs-step highlight">
          <div class="srs-step-stage">App 1→2</div>
          <div class="srs-step-time">4h</div>
          <div class="srs-step-note">most critical</div>
        </div>
        <div class="srs-arrow">→</div>
        <div class="srs-step">
          <div class="srs-step-stage">App 2→3</div>
          <div class="srs-step-time">8h</div>
        </div>
        <div class="srs-arrow">→</div>
        <div class="srs-step">
          <div class="srs-step-stage">App 3→4</div>
          <div class="srs-step-time">23h</div>
        </div>
        <div class="srs-arrow">→</div>
        <div class="srs-step">
          <div class="srs-step-stage">App 4→Guru</div>
          <div class="srs-step-time">47h</div>
        </div>
        <div class="srs-arrow">→</div>
        <div class="srs-step" style="border-color:var(--gold)">
          <div class="srs-step-stage">Guru ✓</div>
          <div class="srs-step-time" style="color:var(--gold)">~5d</div>
        </div>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Your median vs 9am/6pm window pace</span>
        <span class="insight-row-val">${fmtDays(_stats.median)} vs ${fmtDays(windowDaysPerLevel)}</span>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Days saved per level on window schedule</span>
        <span class="insight-row-val ${speedup.windowLostPerLevel > 7 ? 'bad' : speedup.windowLostPerLevel > 3 ? 'warn' : 'good'}">${fmtDays(speedup.windowLostPerLevel)}</span>
      </div>
      <div class="insight-row">
        <span class="insight-row-label">Total time saved across ${left} remaining levels</span>
        <span class="insight-row-val good">${fmtDays(speedup.windowLostPerLevel * left)}</span>
      </div>
      <div class="lever-tip">
        💡 Do lessons at 9am. The 4h Apprentice 1 review will be due by 1pm — do it then.
        It'll be due again around midnight, but catching it at the 6pm window the next day
        still keeps you on the fast track. Consistency beats perfection.
      </div>
    </div>

    <div class="card gold">
      <div class="eyebrow">Lever 2 — Get reviews right</div>
      <p class="lever-intro">
        Every wrong answer bumps an item back one SRS stage, adding ~20h before it's reviewed again
        and potentially pushing it past your next window slot. For radicals and kanji that gate
        your level-up, each mistake is a direct delay.
      </p>
      <div class="acc-display">
        <div class="acc-circle" style="--acc-color:${accColor}">
          <div class="acc-number" style="color:${accColor}">${speedup.accuracy.toFixed(1)}%</div>
          <div class="acc-label">accuracy</div>
        </div>
        <div class="acc-detail">
          <p class="acc-tip">${accTip}</p>
          <div class="insight-row">
            <span class="insight-row-label">Total reviews (current levels)</span>
            <span class="insight-row-val">${speedup.total.toLocaleString()}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Incorrect answers</span>
            <span class="insight-row-val ${speedup.accuracy < 75 ? 'bad' : 'warn'}">${speedup.incorrect.toLocaleString()}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Extra days per level from mistakes</span>
            <span class="insight-row-val ${speedup.extraDaysPerLevel > 3 ? 'bad' : speedup.extraDaysPerLevel > 1 ? 'warn' : 'good'}">${fmtDays(speedup.extraDaysPerLevel)}</span>
          </div>
          <div class="insight-row">
            <span class="insight-row-label">Level 60 on windows + perfect accuracy</span>
            <span class="insight-row-val good">${fmtDate(noMistakeDate)}</span>
          </div>
        </div>
      </div>
      <div class="lever-tip">
        💡 Before each review session, take a breath and recall the item before answering.
        Leeches (items you keep getting wrong) are worth drilling separately —
        the WaniKani self-study quiz helps a lot with this.
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

  // Review stats filtered to current run levels only — single fast request
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
    let next = rsJson.pages?.next_url || null;
    while (next) {
      const r = await fetch(next, { headers });
      const j = await r.json();
      reviewStats = reviewStats.concat(j.data);
      next = j.pages?.next_url || null;
    }
  }

  // Assignments for current level — to predict next level-up
  setLoadingMsg('Fetching current assignments...');
  const aRes = await fetch(
    `https://api.wanikani.com/v2/assignments?levels=${currentLevel}&started=true`,
    { headers }
  );
  let assignments = [];
  if (aRes.ok) {
    const aJson = await aRes.json();
    assignments = aJson.data || [];
    let next = aJson.pages?.next_url || null;
    while (next) {
      const r = await fetch(next, { headers });
      const j = await r.json();
      assignments = assignments.concat(j.data);
      next = j.pages?.next_url || null;
    }
  }

  return { user, progressions, reviewStats, assignments };
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
  // Fake assignments — mix of stages blocking level-up
  const assignments = [];
  const types = ['radical','radical','kanji','kanji','kanji','kanji','kanji'];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const stage = Math.floor(Math.random() * 4);
    const hoursAgo = Math.random() * 20;
    const availableAt = new Date(now.getTime() + (Math.random() * 30 - 10) * 3600000);
    assignments.push({
      data: {
        subject_type: types[i % types.length],
        srs_stage: stage,
        started_at: new Date(now.getTime() - hoursAgo * 3600000).toISOString(),
        available_at: availableAt.toISOString(),
        burned_at: null,
      }
    });
  }
  return {
    user: { data: { current_level: 32, username: 'demo_user' } },
    progressions: p,
    reviewStats,
    assignments
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

  // Next level prediction
  if (data.assignments && data.assignments.length > 0) {
    const nextLevel = computeNextLevel(data.assignments);
    renderNextLevel(nextLevel);
  }

  // Speedup analysis
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
  document.getElementById('next-level-section').style.display = 'none';
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
