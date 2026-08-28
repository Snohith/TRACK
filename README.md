# StatsArena Match Explorer & Automated Hourly Scraper

A responsive, mobile-friendly sports prediction dashboard and automated background scraper for **Tennis** and **Football** matches from [StatsArena](https://www.statsarena.site/sitemap-matches.xml).

---

## Key Features

1. **Dual Sport Match Explorer**:
   - **Tennis Section**: All ATP, WTA, Challenger, and ITF matches sorted chronologically by starting time.
   - **Football Section**: Premier League, La Liga, Serie A, Bundesliga, etc. sorted chronologically.
2. **12-Hour IST Timestamps**:
   - All match start times are formatted in **12-Hour Indian Standard Time (IST)** with AM/PM (e.g. `06:00 PM · Aug 28 IST`).
3. **Smart Timing Sorting**:
   - Handles live in-progress matches, upcoming matches (soonest first), and rescheduled / delayed matches.
4. **Transparent Scraper Status**:
   - Real-time status banner shows exact state: `In Process` (with live progress bar), `Finished` (matches updated, new additions, duration), and next scheduled auto-sync.
5. **Exact Reference UI Design**:
   - Tournament pill badge with trophy icon (`🏆 ATP Challenger`).
   - Contender circular avatars with initials (`CC`, `SK`) and player/team names.
   - Match venue / location badge (`📍 Augsburg`).
   - Mint & Coral win chance bar (`40%` / `60%`).
   - Side-by-side **Market Odds** and **Fair Odds** cards with `+EV Value` bet indicator.
6. **Dual Hosting Readiness (Local Server & GitHub Pages)**:
   - **Local / Server Mode**: Runs with FastAPI + APScheduler hourly background auto-scraper.
   - **GitHub Pages Mode**: Fully static compatible using `static/data.json` with automated 1-hour GitHub Actions workflow (`.github/workflows/scrape.yml`).

---

## 🚀 How to Host on GitHub

### Option A: GitHub Pages (Static Free Hosting)

1. Create a new repository on GitHub: `https://github.com/new`
2. Push this project to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: StatsArena Match Explorer"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/<REPO_NAME>.git
   git push -u origin main
   ```
3. Enable GitHub Pages:
   - Go to your repository **Settings** → **Pages**.
   - Under **Build and deployment** → **Source**, select **Deploy from a branch**.
   - Select branch `main` and folder `/static` (or root), then click **Save**.
4. The automated GitHub Action in `.github/workflows/scrape.yml` will run every 1 hour to scrape new matches and keep your GitHub repository data updated automatically!

---

### Option B: Run Locally or on Server (FastAPI + Background Scraper)

```bash
# 1. Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start server with 1-hour auto-scraper
python server.py
```

Access the dashboard at:
👉 **http://localhost:8080**
