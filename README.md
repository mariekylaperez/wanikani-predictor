# WaniKani Level 60 Predictor

A clean, lightweight tool that uses your WaniKani study history to forecast when you'll reach Level 60. Built with vanilla HTML, CSS, and JavaScript — no frameworks, no build step, no backend.

![WaniKani Level 60 Predictor](https://img.shields.io/badge/WaniKani-Level%2060%20Predictor-c0392b?style=flat-square)

---

## What it does

The predictor pulls your level progression history from the WaniKani API and calculates how long you've historically taken per level. It then extrapolates that pace across your remaining levels to give you a target date for Level 60.

You get:

- **Predicted completion date** based on your chosen pace scenario
- **Five pace scenarios** — Fast (25th percentile), Median, Average, Recent (last 5 levels), and Slow (75th percentile) — so you can see an optimistic vs conservative range
- **Three-scenario summary** showing your optimistic, median, and conservative finish years at a glance
- **Level-by-level bar chart** of your last 30 levels, color-coded by whether each level was faster or slower than your median
- **Key stats** — current level, levels passed, median days per level, and recent pace

---

## How to use

### 1. Get your WaniKani API key

1. Log in to [wanikani.com](https://www.wanikani.com)
2. Go to **Settings → API Tokens** (or visit [wanikani.com/settings/personal_access_tokens](https://www.wanikani.com/settings/personal_access_tokens) directly)
3. Click **Generate a new token** — read-only permissions are enough
4. Copy the token

### 2. Open the predictor

Visit your hosted URL (e.g. `https://yourusername.github.io/wanikani-predictor`) or open `index.html` locally in a browser.

### 3. Enter your token and predict

Paste your API token into the input field and press **Predict** (or hit Enter). The tool fetches your data directly from WaniKani and displays your results.

> **No account needed.** Your API key is only used client-side to call the WaniKani API directly. It is never sent to any third-party server.

---

## Project structure

```
wanikani-predictor/
├── index.html    # Page structure and markup
├── style.css     # All styles and layout
├── app.js        # API fetching, stats computation, rendering
└── README.md     # This file
```

---

## How the prediction works

1. Your completed level progressions are fetched from `/v2/level_progressions`
2. For each completed level, the duration is calculated as `passed_at - started_at` in days
3. The durations are sorted to compute percentile-based pace scenarios
4. Your remaining levels (`60 - current_level`) are multiplied by the selected pace to produce a target date

The **Recent** pace uses your last 5 completed levels, which often gives the most relevant prediction if your study habits have changed over time.

Bar colors in the chart:
- 🟢 **Green** — within normal range (under 1.5× your median)
- 🔴 **Red** — significantly above your median (slow level)
- 🟡 **Gold** — significantly below your median (fast level)

---

## Built with

- [WaniKani API v2](https://docs.api.wanikani.com) — level progression and user data
- [Shippori Mincho](https://fonts.google.com/specimen/Shippori+Mincho) — display typeface
- [DM Mono](https://fonts.google.com/specimen/DM+Mono) — monospace body font
- Vanilla JS, HTML, CSS — no dependencies

---

頑張って！ *Ganbatte!* — Good luck on your journey to Level 60.
