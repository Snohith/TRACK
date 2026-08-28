/**
 * StatsArena Match Explorer - Client Application
 * Features:
 * - 12-Hour IST (Indian Standard Time) Timestamps
 * - Smart Chronological Sorting for Live, Upcoming & Postponed Matches
 * - Real-Time Scraper Status Banner (In Process / Finished / Sync Stats)
 * - Dual Mode: Dynamic FastAPI Backend + Static GitHub Pages Fallback
 */

const state = {
  sport: 'tennis',
  search: '',
  valueOnly: false,
  matches: [],
  allMatchesCache: { tennis: [], football: [] },
  isLoading: false,
  isScrapingActive: false,
  isStaticMode: false,
  searchDebounceTimer: null
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  // Poll scraper status every 15s
  setInterval(pollScraperStatus, 15000);
});

async function initApp() {
  await Promise.all([
    pollScraperStatus(),
    fetchMatches()
  ]);
}

// Sport Switcher
function switchSport(sport) {
  if (state.sport === sport) return;
  
  state.sport = sport;
  
  document.getElementById('tabTennis').classList.toggle('active', sport === 'tennis');
  document.getElementById('tabFootball').classList.toggle('active', sport === 'football');
  
  fetchMatches();
}

// Scraper Status Polling
async function pollScraperStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Status API not reachable');
    
    const data = await res.json();
    updateScraperBanner(data);

    if (data.is_running && !state.isScrapingActive) {
      state.isScrapingActive = true;
      // Faster polling when scraper is running
      setTimeout(pollScraperStatus, 3000);
    } else if (!data.is_running && state.isScrapingActive) {
      state.isScrapingActive = false;
      // Refresh matches once finished
      fetchMatches();
    }
  } catch (err) {
    // If backend API not reachable, try reading static data.json (GitHub Pages Mode)
    state.isStaticMode = true;
    checkStaticDataFallback();
  }
}

// Update Top Scraper Status Banner
function updateScraperBanner(data) {
  const banner = document.getElementById('scraperBanner');
  const badge = document.getElementById('scraperStateBadge');
  const statusText = document.getElementById('scraperStatusText');
  const lastScrapeMeta = document.getElementById('lastScrapeMeta');
  const nextScrapeMeta = document.getElementById('nextScrapeMeta');
  const progressBar = document.getElementById('bannerProgressBar');
  const progressContainer = document.getElementById('bannerProgress');
  const pulseDot = document.getElementById('pulseDot');

  const stats = data.stats || {};
  const tennisCount = stats.tennis_count || 0;
  const footballCount = stats.football_count || 0;
  
  document.getElementById('tennisCountBadge').textContent = tennisCount;
  document.getElementById('footballCountBadge').textContent = footballCount;

  const live = data.live_state || {};
  const isRunning = data.is_running || live.is_running;

  if (isRunning) {
    banner.className = 'scraper-banner running';
    pulseDot.className = 'pulse-dot running';
    badge.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> In Process';
    statusText.textContent = live.status_text || 'Scraper running: Scraping matches from XML...';
    progressContainer.style.display = 'block';

    const total = live.total_urls || 239;
    const current = live.processed_count || 0;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 20;
    progressBar.style.width = `${pct}%`;

    document.getElementById('autoScraperStatus').textContent = `Scraper Running (${pct}%)`;
  } else {
    banner.className = 'scraper-banner';
    pulseDot.className = 'pulse-dot';
    progressContainer.style.display = 'none';
    progressBar.style.width = '0%';
    document.getElementById('autoScraperStatus').textContent = 'Auto-Scraper Active (Every 1h)';

    const lastRun = stats.last_run;
    if (lastRun && lastRun.timestamp) {
      const lastTimeIST = formatIST12Hour(lastRun.timestamp, false);
      const newMatches = lastRun.new_matches || 0;
      const updatedMatches = lastRun.updated_matches || 0;
      const duration = lastRun.duration_seconds || 0;

      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Finished';
      statusText.textContent = `Scraper completed. ${stats.total_count || 239} matches updated (${newMatches} new, ${updatedMatches} refreshed) in ${duration}s.`;
      lastScrapeMeta.innerHTML = `<i class="fa-regular fa-clock"></i> Last scraped: ${lastTimeIST}`;
    } else {
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Idle';
      statusText.textContent = `All ${stats.total_count || 239} matches up-to-date.`;
    }

    if (data.next_run) {
      const nextDate = new Date(data.next_run);
      const diffMin = Math.max(1, Math.round((nextDate - new Date()) / 60000));
      nextScrapeMeta.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> Next in ${diffMin}m`;
    }
  }
}

// GitHub Pages / Static JSON Fallback
async function checkStaticDataFallback() {
  try {
    let res;
    try {
      res = await fetch('./data.json');
      if (!res.ok) throw new Error('data.json not found at root');
    } catch {
      res = await fetch('./static/data.json');
    }
    if (res && res.ok) {
      const staticData = await res.json();
      state.allMatchesCache = staticData.matches || { tennis: [], football: [] };
      
      const tennisCount = (staticData.matches?.tennis || []).length;
      const footballCount = (staticData.matches?.football || []).length;
      document.getElementById('tennisCountBadge').textContent = tennisCount;
      document.getElementById('footballCountBadge').textContent = footballCount;
      
      const badge = document.getElementById('scraperStateBadge');
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Static Archive';
      document.getElementById('scraperStatusText').textContent = `Loaded ${tennisCount + footballCount} matches from static cache.`;
      
      if (staticData.exported_at) {
        document.getElementById('lastScrapeMeta').innerHTML = `<i class="fa-regular fa-clock"></i> Exported: ${formatIST12Hour(staticData.exported_at, false)}`;
      }
      
      processAndRenderMatches(state.allMatchesCache[state.sport] || []);
    }
  } catch (e) {
    console.error('Static data load failed:', e);
  }
}

// Fetch Matches from API or Cache
async function fetchMatches() {
  state.isLoading = true;
  updateLoadingState();

  if (state.isStaticMode && state.allMatchesCache[state.sport]?.length > 0) {
    processAndRenderMatches(state.allMatchesCache[state.sport]);
    state.isLoading = false;
    updateLoadingState();
    return;
  }

  try {
    const params = new URLSearchParams({
      sport: state.sport,
      sort_order: 'asc', // fetch all sorted by start time
      limit: '1000'
    });

    const res = await fetch(`/api/matches?${params.toString()}`);
    if (!res.ok) throw new Error('Matches API error');
    const data = await res.json();

    const rawMatches = data.matches || [];
    processAndRenderMatches(rawMatches);
  } catch (err) {
    console.warn('API error, falling back to static data:', err);
    state.isStaticMode = true;
    await checkStaticDataFallback();
  } finally {
    state.isLoading = false;
    updateLoadingState();
  }
}

// Filter and Strict Start Time Chronological Sort
function processAndRenderMatches(rawList) {
  let list = [...rawList];

  // 1. Text Search Filter
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter(m => 
      (m.home_name && m.home_name.toLowerCase().includes(q)) ||
      (m.away_name && m.away_name.toLowerCase().includes(q)) ||
      (m.league && m.league.toLowerCase().includes(q)) ||
      (m.location && m.location.toLowerCase().includes(q))
    );
  }

  // 2. Value Bets (+EV) Filter
  if (state.valueOnly) {
    list = list.filter(m => m.has_value === 1);
  }

  // 3. Strict Sort by Start Time (Ascending: Earliest to Latest)
  // Ensures every match in XML is sorted in exact start time order regardless of finished/live status
  list.sort((a, b) => (a.start_timestamp || 0) - (b.start_timestamp || 0));

  // 4. Enrich status for live indicator
  const nowMs = Date.now();
  const TWO_AND_HALF_HOURS = 2.5 * 60 * 60 * 1000;
  list = list.map(m => {
    const matchTimeMs = (m.start_timestamp || 0) * 1000;
    const diff = matchTimeMs - nowMs;
    let status = 'upcoming';
    if (diff <= 0 && Math.abs(diff) < TWO_AND_HALF_HOURS) {
      status = 'live';
    } else if (diff < -TWO_AND_HALF_HOURS) {
      status = 'past';
    }
    return {
      ...m,
      _status: status,
      _isDelayed: status === 'live' && Math.abs(diff) > 45 * 60 * 1000
    };
  });

  state.matches = list;
  renderMatches();
  updateSummary();
}

// Render Match Cards to Grid
function renderMatches() {
  const grid = document.getElementById('matchesGrid');
  const empty = document.getElementById('emptyContainer');

  if (!state.matches || state.matches.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = state.matches.map(m => createMatchCardHTML(m)).join('');
}

// Extract surname or short label for win chance
function getShortSurname(name) {
  if (!name) return 'Team';
  const clean = name.trim();
  const parts = clean.split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Format timestamp in 12-Hour IST Time (Indian Standard Time, UTC+5:30)
 * Example: '05:55 PM · Aug 28'
 */
function formatIST12Hour(isoOrTimestamp, includeTzLabel = true) {
  if (!isoOrTimestamp) return 'Time TBA';
  const date = typeof isoOrTimestamp === 'number' ? new Date(isoOrTimestamp * 1000) : new Date(isoOrTimestamp);
  if (isNaN(date.getTime())) return 'Time TBA';

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      month: 'short',
      day: 'numeric'
    });

    const parts = formatter.formatToParts(date);
    let hour = '', minute = '', dayPeriod = '', month = '', day = '';
    parts.forEach(p => {
      if (p.type === 'hour') hour = p.value;
      if (p.type === 'minute') minute = p.value;
      if (p.type === 'dayPeriod') dayPeriod = p.value.toUpperCase();
      if (p.type === 'month') month = p.value;
      if (p.type === 'day') day = p.value;
    });

    return `${hour}:${minute} ${dayPeriod} · ${month} ${day}`;
  } catch (e) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }
}

// Generate Match Card HTML matching Reference Screenshot
function createMatchCardHTML(m) {
  const isTennis = m.sport === 'tennis';
  const timeFormattedIST = formatIST12Hour(m.start_timestamp || m.start_time);
  
  // Win probabilities
  const homeProb = m.home_prob !== null && m.home_prob !== undefined ? Math.round(m.home_prob) : null;
  const awayProb = m.away_prob !== null && m.away_prob !== undefined ? Math.round(m.away_prob) : null;
  const drawProb = m.draw_prob !== null && m.draw_prob !== undefined ? Math.round(m.draw_prob) : null;

  const homeSurname = getShortSurname(m.home_name);
  const awaySurname = getShortSurname(m.away_name);

  // Odds
  const mHome = m.market_home ? m.market_home.toFixed(2) : '-';
  const mAway = m.market_away ? m.market_away.toFixed(2) : '-';
  const mDraw = m.market_draw ? m.market_draw.toFixed(2) : '-';

  const fHome = m.fair_home ? m.fair_home.toFixed(2) : '-';
  const fAway = m.fair_away ? m.fair_away.toFixed(2) : '-';
  const fDraw = m.fair_draw ? m.fair_draw.toFixed(2) : '-';

  const hasValue = m.has_value === 1;
  const valueSide = m.value_side;

  // Avatars — use data-fallback for safe onerror handling (no inline innerHTML injection)
  const homeAvatarHTML = m.home_avatar
    ? `<img src="${escapeHtml(m.home_avatar)}" alt="${escapeHtml(m.home_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.home_initials || '??');

  const awayAvatarHTML = m.away_avatar
    ? `<img src="${escapeHtml(m.away_avatar)}" alt="${escapeHtml(m.away_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.away_initials || '??');

  // Match Status Tag (Live / Delayed / Regular)
  let statusTag = '';
  if (m._status === 'live') {
    statusTag = '<span class="live-tag">LIVE</span>';
  } else if (m._isDelayed) {
    statusTag = '<span class="delayed-tag">DELAYED</span>';
  }

  // Probability Bar HTML
  let probBarHTML = '';
  let probLabelsHTML = '';

  if (homeProb !== null && awayProb !== null) {
    if (isTennis || !drawProb) {
      // 2-Way Tennis Dual Bar
      probBarHTML = `
        <div class="probability-bar">
          <div class="prob-segment home" style="width: ${homeProb}%;">${homeProb}%</div>
          <div class="prob-segment away" style="width: ${awayProb}%;">${awayProb}%</div>
        </div>
      `;
      probLabelsHTML = `
        <div class="prob-labels">
          <span class="home-label">${escapeHtml(homeSurname)} win chance</span>
          <span class="away-label">${escapeHtml(awaySurname)} win chance</span>
        </div>
      `;
    } else {
      // 3-Way Football Bar
      probBarHTML = `
        <div class="probability-bar">
          <div class="prob-segment home" style="width: ${homeProb}%;" title="Home: ${homeProb}%">${homeProb}%</div>
          <div class="prob-segment draw" style="width: ${drawProb}%;" title="Draw: ${drawProb}%">${drawProb}%</div>
          <div class="prob-segment away" style="width: ${awayProb}%;" title="Away: ${awayProb}%">${awayProb}%</div>
        </div>
      `;
      probLabelsHTML = `
        <div class="prob-labels">
          <span class="home-label">${escapeHtml(homeSurname)}</span>
          <span class="draw-label">Draw (${drawProb}%)</span>
          <span class="away-label">${escapeHtml(awaySurname)}</span>
        </div>
      `;
    }
  } else {
    probBarHTML = `<div class="probability-bar" style="background:#E2E8F0; justify-content:center; align-items:center; font-size:12px; color:#64748B;">Odds Pending</div>`;
  }

  // Odds blocks
  let marketOddsValues = '';
  let fairOddsValues = '';

  if (isTennis || !m.market_draw) {
    marketOddsValues = `
      <div class="odds-val-item"><span>${mHome}</span></div>
      <div class="odds-val-item" style="text-align:right;"><span>${mAway}</span></div>
    `;
    fairOddsValues = `
      <div class="odds-val-item">
        <span>${fHome}</span>
        ${valueSide === 'home' ? '<span class="val-edge-tag">VALUE</span>' : ''}
      </div>
      <div class="odds-val-item" style="text-align:right;">
        <span>${fAway}</span>
        ${valueSide === 'away' ? '<span class="val-edge-tag">VALUE</span>' : ''}
      </div>
    `;
  } else {
    marketOddsValues = `
      <div class="odds-val-item"><span style="font-size:15px;">${mHome}</span></div>
      <div class="odds-val-item" style="text-align:center;"><span style="font-size:15px; color:#64748B;">${mDraw}</span></div>
      <div class="odds-val-item" style="text-align:right;"><span style="font-size:15px;">${mAway}</span></div>
    `;
    fairOddsValues = `
      <div class="odds-val-item">
        <span style="font-size:15px;">${fHome}</span>
        ${valueSide === 'home' ? '<span class="val-edge-tag">VAL</span>' : ''}
      </div>
      <div class="odds-val-item" style="text-align:center;">
        <span style="font-size:15px; color:#64748B;">${fDraw}</span>
        ${valueSide === 'draw' ? '<span class="val-edge-tag">VAL</span>' : ''}
      </div>
      <div class="odds-val-item" style="text-align:right;">
        <span style="font-size:15px;">${fAway}</span>
        ${valueSide === 'away' ? '<span class="val-edge-tag">VAL</span>' : ''}
      </div>
    `;
  }

  const locationHTML = m.location
    ? `<div class="match-location"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(m.location)}</div>`
    : `<div class="match-location" style="visibility:hidden;"><i class="fa-solid fa-location-dot"></i> Venue</div>`;

  return `
    <div class="match-card ${hasValue ? 'has-value-edge' : ''}">
      <!-- Header -->
      <div class="card-header">
        <div class="league-badge" title="${escapeHtml(m.league)}">
          <i class="fa-solid fa-trophy"></i>
          <span>${escapeHtml(m.league || (isTennis ? 'ATP Challenger' : 'Football League'))}</span>
        </div>
        <div class="card-time-wrapper">
          ${statusTag}
          <span>${timeFormattedIST}</span>
        </div>
      </div>

      <!-- Contenders -->
      <div class="contenders-row">
        <div class="contender home">
          <div class="avatar-circle" data-fallback="${escapeHtml(m.home_initials || '??')}">${homeAvatarHTML}</div>
          <div class="contender-name" title="${escapeHtml(m.home_name)}">${escapeHtml(m.home_name)}</div>
        </div>

        <div class="vs-badge-wrapper">
          <div class="vs-badge">vs</div>
        </div>

        <div class="contender away">
          <div class="avatar-circle" data-fallback="${escapeHtml(m.away_initials || '??')}">${awayAvatarHTML}</div>
          <div class="contender-name" title="${escapeHtml(m.away_name)}">${escapeHtml(m.away_name)}</div>
        </div>
      </div>

      <!-- Location -->
      ${locationHTML}

      <!-- Win Probability Bar -->
      <div class="win-chance-section">
        ${probBarHTML}
        ${probLabelsHTML}
      </div>

      <!-- Odds Comparison Blocks -->
      <div class="odds-section">
        <!-- Market Odds -->
        <div class="odds-card market">
          <div class="odds-header">
            <i class="fa-solid fa-building-columns"></i>
            <span>Market odds</span>
          </div>
          <div class="odds-values">
            ${marketOddsValues}
          </div>
        </div>

        <!-- Fair Odds -->
        <div class="odds-card fair">
          <div class="odds-header">
            <i class="fa-solid fa-scale-balanced"></i>
            <span>Fair odds</span>
          </div>
          <div class="odds-values">
            ${fairOddsValues}
          </div>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Filter Actions
function handleSearchInput() {
  const val = document.getElementById('searchInput').value;
  document.getElementById('clearSearchBtn').style.display = val ? 'block' : 'none';

  clearTimeout(state.searchDebounceTimer);
  state.searchDebounceTimer = setTimeout(() => {
    state.search = val;
    fetchMatches();
  }, 250);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  state.search = '';
  fetchMatches();
}

function applyFilters() {
  state.league = document.getElementById('leagueSelect').value;
  state.dateFilter = document.getElementById('dateSelect').value;
  state.sortOrder = document.getElementById('sortSelect').value;
  state.valueOnly = document.getElementById('valueOnlyToggle').checked;
  fetchMatches();
}

function resetFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  document.getElementById('leagueSelect').value = 'all';
  document.getElementById('dateSelect').value = 'all';
  document.getElementById('sortSelect').value = 'soonest';
  document.getElementById('valueOnlyToggle').checked = false;

  state.search = '';
  state.league = 'all';
  state.dateFilter = 'all';
  state.sortOrder = 'soonest';
  state.valueOnly = false;

  fetchMatches();
}

function updateSummary() {
  const sportName = state.sport === 'tennis' ? 'Tennis' : 'Football';
  const count = state.matches.length;
  document.getElementById('matchesSummary').textContent = `Showing ${count} ${sportName} matches sorted by start time`;
}

function updateLoadingState() {
  const loader = document.getElementById('loadingContainer');
  const grid = document.getElementById('matchesGrid');
  if (state.isLoading && (!state.matches || state.matches.length === 0)) {
    loader.style.display = 'block';
    grid.style.display = 'none';
  } else {
    loader.style.display = 'none';
    grid.style.display = 'grid';
  }
}

// Manual Sync Trigger
async function triggerManualSync() {
  const btn = document.getElementById('syncNowBtn');
  btn.classList.add('spinning');
  btn.disabled = true;
  showToast('Starting match sync...', 'info');

  try {
    const res = await fetch('/api/scrape/trigger', { method: 'POST' });
    const data = await res.json();
    
    if (data.status === 'started') {
      showToast('Scraper started! Fetching latest odds and new matches...', 'success');
      pollScraperStatus();
    } else {
      showToast(data.message || 'Scraper already running', 'info');
    }
  } catch (err) {
    showToast('Failed to connect to scraper API', 'error');
  } finally {
    setTimeout(() => {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }, 2000);
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast-notification show ${type}`;
  setTimeout(() => {
    toast.className = 'toast-notification';
  }, 3500);
}
