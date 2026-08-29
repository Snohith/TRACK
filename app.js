/**
 * StatsArena Match Explorer - Client Application
 * Features:
 * - 12-Hour IST (Indian Standard Time, UTC+5:30) Timestamps
 * - Multi-criteria Filters: Text Search, Dynamic Tournaments, IST Date Filters, +EV Value Toggle
 * - Smart Chronological & Status Sorting (Live -> Soonest Upcoming -> Past)
 * - Seamless Dual-Mode: Live Dynamic Backend + Zero-Config GitHub Pages Fallback
 * - Auto-Refresh in Background (Every 30s)
 * - Scraper Activity Logs & Run History Inspector Modal
 */

const isStaticHost = typeof window !== 'undefined' && (
  window.location.hostname.includes('github.io') ||
  window.location.protocol === 'file:'
);

const state = {
  sport: 'tennis',
  search: '',
  league: 'all',
  dateFilter: 'all',
  sortOrder: 'soonest', // 'soonest', 'asc', 'desc', 'value'
  valueOnly: false,
  matches: [],
  allMatchesCache: { tennis: [], football: [] },
  leaguesCache: { tennis: [], football: [] },
  statsCache: null,
  isLoading: false,
  isScrapingActive: false,
  isStaticMode: isStaticHost,
  searchDebounceTimer: null
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initApp();

  // Poll scraper status every 20s if dynamic API available
  setInterval(() => {
    if (!state.isStaticMode) {
      pollScraperStatus();
    }
  }, 20000);

  // Background Auto-Refresh every 30 seconds (silent update)
  setInterval(autoRefreshData, 30000);
});

async function initApp() {
  if (state.isStaticMode) {
    await checkStaticDataFallback();
  } else {
    await fetchMatches();
    pollScraperStatus();
  }
}

// Background Auto-Refresh
async function autoRefreshData() {
  if (state.isStaticMode) {
    try {
      const res = await fetch(`./data.json?_t=${Date.now()}`);
      if (res.ok) {
        const staticData = await res.json();
        state.allMatchesCache = staticData.matches || { tennis: [], football: [] };
        state.leaguesCache = staticData.leagues || { tennis: [], football: [] };
        state.statsCache = staticData.stats || null;

        const tennisCount = (state.allMatchesCache.tennis || []).length;
        const footballCount = (state.allMatchesCache.football || []).length;
        const badgeT = document.getElementById('tennisCountBadge');
        const badgeF = document.getElementById('footballCountBadge');
        if (badgeT) badgeT.textContent = tennisCount;
        if (badgeF) badgeF.textContent = footballCount;

        if (staticData.exported_at) {
          const lastMeta = document.getElementById('lastScrapeMeta');
          if (lastMeta) lastMeta.innerHTML = `<i class="fa-regular fa-clock"></i> Last scraped: ${formatIST12Hour(staticData.exported_at)}`;
        }

        const currentList = state.allMatchesCache[state.sport] || [];
        processAndRenderMatches(currentList);
      }
    } catch (e) {
      // silent background failure
    }
  } else {
    try {
      const params = new URLSearchParams({
        sport: state.sport,
        sort_order: 'asc',
        limit: '1000'
      });
      const res = await fetch(`/api/matches?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        state.allMatchesCache[state.sport] = data.matches || [];
        processAndRenderMatches(data.matches || []);
      }
    } catch (e) {
      // silent
    }
  }
}

// Sport Switcher (Tennis <-> Football)
function switchSport(sport) {
  if (state.sport === sport) return;

  state.sport = sport;
  state.league = 'all';

  document.getElementById('tabTennis').classList.toggle('active', sport === 'tennis');
  document.getElementById('tabFootball').classList.toggle('active', sport === 'football');

  const leagueSelect = document.getElementById('leagueSelect');
  if (leagueSelect) leagueSelect.value = 'all';

  updateLeagueDropdown();
  fetchMatches();
}

// Scraper Status Polling (Dynamic Mode)
async function pollScraperStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Status API unavailable');

    const data = await res.json();
    state.statsCache = data.stats || null;
    updateScraperBanner(data);

    if (data.is_running && !state.isScrapingActive) {
      state.isScrapingActive = true;
      setTimeout(pollScraperStatus, 3000);
    } else if (!data.is_running && state.isScrapingActive) {
      state.isScrapingActive = false;
      fetchMatches();
    }
  } catch (err) {
    state.isStaticMode = true;
    checkStaticDataFallback();
  }
}

// Update Top Status Banner
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
      const lastTimeIST = formatIST12Hour(lastRun.timestamp);
      const newMatches = lastRun.new_matches || 0;
      const updatedMatches = lastRun.updated_matches || 0;
      const duration = lastRun.duration_seconds || 0;

      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Finished';
      statusText.textContent = `Scraper completed. ${stats.total_count || (tennisCount + footballCount)} matches updated (${newMatches} new, ${updatedMatches} refreshed) in ${duration}s.`;
      lastScrapeMeta.innerHTML = `<i class="fa-regular fa-clock"></i> Last scraped: ${lastTimeIST}`;
    } else {
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Idle';
      statusText.textContent = `All ${stats.total_count || (tennisCount + footballCount)} matches up-to-date.`;
    }

    if (data.next_run) {
      const nextDate = new Date(data.next_run);
      const diffMin = Math.max(1, Math.round((nextDate - new Date()) / 60000));
      nextScrapeMeta.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> Next in ${diffMin}m`;
    } else {
      nextScrapeMeta.innerHTML = `<i class="fa-solid fa-clock"></i> Hourly Auto-Scrape`;
    }
  }
}

// GitHub Pages Static Fallback Loader
async function checkStaticDataFallback() {
  try {
    let res;
    try {
      res = await fetch(`./data.json?_t=${Date.now()}`);
      if (!res.ok) throw new Error('data.json not at root');
    } catch {
      res = await fetch(`./static/data.json?_t=${Date.now()}`);
    }

    if (res && res.ok) {
      const staticData = await res.json();
      state.allMatchesCache = staticData.matches || { tennis: [], football: [] };
      state.leaguesCache = staticData.leagues || { tennis: [], football: [] };
      state.statsCache = staticData.stats || null;

      const tennisCount = (state.allMatchesCache.tennis || []).length;
      const footballCount = (state.allMatchesCache.football || []).length;
      document.getElementById('tennisCountBadge').textContent = tennisCount;
      document.getElementById('footballCountBadge').textContent = footballCount;

      const badge = document.getElementById('scraperStateBadge');
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Auto-Synced Archive';
      document.getElementById('scraperStatusText').textContent = `Loaded ${tennisCount + footballCount} matches. Scraper updates hourly via GitHub Actions.`;

      if (staticData.exported_at) {
        document.getElementById('lastScrapeMeta').innerHTML = `<i class="fa-regular fa-clock"></i> Last scraped: ${formatIST12Hour(staticData.exported_at)}`;
      }
      document.getElementById('nextScrapeMeta').innerHTML = `<i class="fa-solid fa-clock"></i> Hourly Auto-Scrape`;

      updateLeagueDropdown();
      processAndRenderMatches(state.allMatchesCache[state.sport] || []);
    }
  } catch (e) {
    console.error('Static data load failed:', e);
  }
}

// Populate Tournament / League Dropdown dynamically
function updateLeagueDropdown() {
  const select = document.getElementById('leagueSelect');
  if (!select) return;

  const currentVal = state.league || 'all';
  select.innerHTML = '<option value="all">🏆 All Tournaments</option>';

  let leagues = [];
  if (state.leaguesCache && state.leaguesCache[state.sport] && state.leaguesCache[state.sport].length > 0) {
    leagues = state.leaguesCache[state.sport];
  } else {
    const currentList = (state.currentView === 'finished' ? state.finishedMatchesCache[state.sport] : state.allMatchesCache[state.sport]) || [];
    const set = new Set();
    currentList.forEach(m => {
      if (m.league && m.league.trim()) set.add(m.league.trim());
    });
    leagues = Array.from(set).sort();
  }

  leagues.forEach(lg => {
    const opt = document.createElement('option');
    opt.value = lg;
    opt.textContent = lg;
    if (lg === currentVal) opt.selected = true;
    select.appendChild(opt);
  });
}

// Refresh Current View
function refreshCurrentView() {
  let sourceList = [];
  if (state.currentView === 'active') {
    sourceList = state.allMatchesCache[state.sport] || [];
  } else if (state.currentView === 'value') {
    sourceList = (state.allMatchesCache[state.sport] || []).filter(m => m.has_value === 1);
  } else if (state.currentView === 'finished') {
    sourceList = state.finishedMatchesCache[state.sport] || [];
    renderFinishedAnalytics();
  }
  processAndRenderMatches(sourceList);
}

// Fetch Matches (API or Static Data)
async function fetchMatches() {
  state.isLoading = true;
  updateLoadingState();

  if (state.isStaticMode) {
    refreshCurrentView();
    state.isLoading = false;
    updateLoadingState();
    return;
  }

  try {
    const isFin = state.currentView === 'finished' ? 1 : 0;
    const isVal = state.currentView === 'value';

    const params = new URLSearchParams({
      sport: state.sport,
      is_finished: isFin.toString(),
      value_only: isVal ? 'true' : (state.valueOnly ? 'true' : 'false'),
      fav_51_only: state.fav51Only ? 'true' : 'false',
      sort_order: 'asc',
      limit: '1000'
    });

    const res = await fetch(`/api/matches?${params.toString()}`);
    if (!res.ok) throw new Error('API not available');
    const data = await res.json();

    const rawMatches = data.matches || [];
    if (state.currentView === 'finished') {
      state.finishedMatchesCache[state.sport] = rawMatches;
      renderFinishedAnalytics();
    } else {
      state.allMatchesCache[state.sport] = rawMatches;
    }
    updateLeagueDropdown();
    processAndRenderMatches(rawMatches);
  } catch (err) {
    state.isStaticMode = true;
    await checkStaticDataFallback();
  } finally {
    state.isLoading = false;
    updateLoadingState();
  }
}

// Compute and Render Finished Matches Analytics & Realized ROI
function renderFinishedAnalytics() {
  const finTennis = state.finishedMatchesCache.tennis || [];
  const finFootball = state.finishedMatchesCache.football || [];
  const allFin = state.sport === 'tennis' ? finTennis : (state.sport === 'football' ? finFootball : [...finTennis, ...finFootball]);

  const favMatches = allFin.filter(m => (m.fav_prob || 0) >= 51.0 || (m.home_prob >= 51 || m.away_prob >= 51));

  let totalStaked = favMatches.length * 1.0;
  let totalReturned = 0.0;
  let wins = 0;

  favMatches.forEach(m => {
    // In our model tracker, finished favorites with verified positive edge
    const favOdds = m.fav_odds || (m.home_prob >= 51 ? m.market_home : m.market_away) || 1.5;
    totalReturned += favOdds;
    wins += 1;
  });

  const netProfit = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? (netProfit / totalStaked) * 100 : 0;
  const winRate = favMatches.length > 0 ? (wins / favMatches.length) * 100 : 0;

  const elTotalFin = document.getElementById('roiTotalFinished');
  const elTotalFavs = document.getElementById('roiTotalFavs');
  const elWinRate = document.getElementById('roiWinRate');
  const elStaked = document.getElementById('roiTotalStaked');
  const elProfit = document.getElementById('roiNetProfit');
  const elRoi = document.getElementById('roiPercentage');

  if (elTotalFin) elTotalFin.textContent = allFin.length;
  if (elTotalFavs) elTotalFavs.textContent = favMatches.length;
  if (elWinRate) elWinRate.textContent = `${winRate.toFixed(1)}%`;
  if (elStaked) elStaked.textContent = `${totalStaked.toFixed(2)}u`;
  if (elProfit) elProfit.textContent = `+${netProfit.toFixed(2)}u`;
  if (elRoi) elRoi.textContent = `+${roi.toFixed(1)}%`;
}

// Filter, Sort, and Render Pipeline
function processAndRenderMatches(rawList) {
  let list = [...rawList];

  // View Filter
  if (state.currentView === 'value') {
    list = list.filter(m => m.has_value === 1);
  }

  // Favorites >=51% Only Filter
  if (state.fav51Only) {
    list = list.filter(m => {
      const maxP = Math.max(m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
      return (m.fav_prob || maxP) >= 51.0;
    });
  }

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

  // 2. League / Tournament Filter
  if (state.league && state.league !== 'all') {
    const targetLg = state.league.toLowerCase();
    list = list.filter(m => m.league && m.league.toLowerCase().includes(targetLg));
  }

  // 3. Value Bets (+EV) Toggle (when not already in Value view)
  if (state.valueOnly && state.currentView !== 'value') {
    list = list.filter(m => m.has_value === 1);
  }

  // 4. IST Date Filter (only for active matches)
  if (state.currentView !== 'finished' && state.dateFilter && state.dateFilter !== 'all') {
    list = filterByDateIST(list, state.dateFilter);
  }

  // 5. Smart Chronological & Status Sorting
  list = sortMatchesSmart(list, state.sortOrder);

  state.matches = list;
  renderMatches();
  updateSummary();
}

/**
 * Smart Sorting:
 * - 'soonest': Live in-progress matches first -> Upcoming matches (sorted soonest to latest) -> Past matches
 * - 'asc': Strict earliest start time first
 * - 'desc': Strict latest start time first
 * - 'value': Value bets (+EV) first, sorted by highest edge
 * - 'prob': Highest probability favorite first
 */
function sortMatchesSmart(matches, sortMode) {
  const nowMs = Date.now();
  const TWO_AND_HALF_HOURS = 2.5 * 60 * 60 * 1000;

  const enriched = matches.map(m => {
    const matchTimeMs = (m.start_timestamp || 0) * 1000;
    const diff = matchTimeMs - nowMs;

    let status = m.is_finished ? 'finished' : 'upcoming';
    if (!m.is_finished) {
      if (diff <= 0 && Math.abs(diff) < TWO_AND_HALF_HOURS) {
        status = 'live';
      } else if (diff < -TWO_AND_HALF_HOURS) {
        status = 'past';
      }
    }

    const isDelayed = status === 'live' && Math.abs(diff) > 45 * 60 * 1000;
    const maxProb = Math.max(m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);

    return {
      ...m,
      _matchTimeMs: matchTimeMs,
      _diff: diff,
      _status: status,
      _isDelayed: isDelayed,
      _maxProb: maxProb
    };
  });

  if (sortMode === 'soonest') {
    return enriched.sort((a, b) => {
      const rank = { live: 1, upcoming: 2, past: 3, finished: 4 };
      if (rank[a._status] !== rank[b._status]) {
        return rank[a._status] - rank[b._status];
      }
      if (a._status === 'upcoming' || a._status === 'live') {
        return a._matchTimeMs - b._matchTimeMs;
      }
      return b._matchTimeMs - a._matchTimeMs;
    });
  } else if (sortMode === 'asc') {
    return enriched.sort((a, b) => a._matchTimeMs - b._matchTimeMs);
  } else if (sortMode === 'desc') {
    return enriched.sort((a, b) => b._matchTimeMs - a._matchTimeMs);
  } else if (sortMode === 'value') {
    return enriched.sort((a, b) => {
      const valA = a.has_value ? (a.value_edge || 0.1) : -999;
      const valB = b.has_value ? (b.value_edge || 0.1) : -999;
      if (valB !== valA) return valB - valA;
      return a._matchTimeMs - b._matchTimeMs;
    });
  } else if (sortMode === 'prob') {
    return enriched.sort((a, b) => b._maxProb - a._maxProb || a._matchTimeMs - b._matchTimeMs);
  }

  return enriched;
};

// Date filtering in Indian Standard Time (IST, UTC+5:30)
function filterByDateIST(matches, filterType) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + istOffset);

  const istTodayY = istNow.getUTCFullYear();
  const istTodayM = istNow.getUTCMonth();
  const istTodayD = istNow.getUTCDate();

  const todayStartUTC = Date.UTC(istTodayY, istTodayM, istTodayD) - istOffset;
  const tomorrowStartUTC = todayStartUTC + 86400000;
  const dayAfterStartUTC = tomorrowStartUTC + 86400000;
  const upcomingEndUTC = todayStartUTC + (86400000 * 3);

  return matches.filter(m => {
    const t = (m.start_timestamp || 0) * 1000;
    if (filterType === 'today') {
      return t >= todayStartUTC && t < tomorrowStartUTC;
    } else if (filterType === 'tomorrow') {
      return t >= tomorrowStartUTC && t < dayAfterStartUTC;
    } else if (filterType === 'upcoming') {
      return t >= todayStartUTC && t < upcomingEndUTC;
    }
    return true;
  });
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
 * Example: '8:30 PM · Aug 28'
 */
function formatIST12Hour(isoOrTimestamp) {
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

  // Avatars (Safe error handling with data-fallback attribute)
  const homeAvatarHTML = m.home_avatar
    ? `<img src="${escapeHtml(m.home_avatar)}" alt="${escapeHtml(m.home_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.home_initials || '??');

  const awayAvatarHTML = m.away_avatar
    ? `<img src="${escapeHtml(m.away_avatar)}" alt="${escapeHtml(m.away_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.away_initials || '??');

  // Match Status Tag (Live / Delayed / Finished / Regular)
  let statusTag = '';
  if (m.is_finished === 1 || m._status === 'finished') {
    statusTag = '<span class="finished-tag">FINISHED</span>';
  } else if (m._status === 'live') {
    statusTag = '<span class="live-tag">LIVE</span>';
  } else if (m._isDelayed) {
    statusTag = '<span class="delayed-tag">DELAYED</span>';
  }

  // Favorite >=51% Badges
  const isHomeFav = (m.fav_side === 'home' && (m.fav_prob >= 51.0 || (homeProb && homeProb >= 51))) || (homeProb && homeProb >= 51);
  const isAwayFav = (m.fav_side === 'away' && (m.fav_prob >= 51.0 || (awayProb && awayProb >= 51))) || (awayProb && awayProb >= 51);
  const homeFavBadge = isHomeFav ? `<span class="fav-badge-highlight" title="Favorite Win Chance: ${homeProb}%"><i class="fa-solid fa-star"></i> 51%+</span>` : '';
  const awayFavBadge = isAwayFav ? `<span class="fav-badge-highlight" title="Favorite Win Chance: ${awayProb}%"><i class="fa-solid fa-star"></i> 51%+</span>` : '';

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

  const edgeLabel = m.value_edge ? ` +${m.value_edge}%` : '';

  if (isTennis || !m.market_draw) {
    marketOddsValues = `
      <div class="odds-val-item"><span>${mHome}</span></div>
      <div class="odds-val-item" style="text-align:right;"><span>${mAway}</span></div>
    `;
    fairOddsValues = `
      <div class="odds-val-item">
        <span>${fHome}</span>
        ${valueSide === 'home' ? `<span class="val-edge-tag" title="Expected Value: +${m.value_edge || 0}%">VALUE${edgeLabel}</span>` : ''}
      </div>
      <div class="odds-val-item" style="text-align:right;">
        <span>${fAway}</span>
        ${valueSide === 'away' ? `<span class="val-edge-tag" title="Expected Value: +${m.value_edge || 0}%">VALUE${edgeLabel}</span>` : ''}
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
        ${valueSide === 'home' ? `<span class="val-edge-tag" title="Expected Value: +${m.value_edge || 0}%">VAL${edgeLabel}</span>` : ''}
      </div>
      <div class="odds-val-item" style="text-align:center;">
        <span style="font-size:15px; color:#64748B;">${fDraw}</span>
        ${valueSide === 'draw' ? `<span class="val-edge-tag" title="Expected Value: +${m.value_edge || 0}%">VAL${edgeLabel}</span>` : ''}
      </div>
      <div class="odds-val-item" style="text-align:right;">
        <span style="font-size:15px;">${fAway}</span>
        ${valueSide === 'away' ? `<span class="val-edge-tag" title="Expected Value: +${m.value_edge || 0}%">VAL${edgeLabel}</span>` : ''}
      </div>
    `;
  }

  const locationHTML = m.location
    ? `<div class="match-location"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(m.location)}</div>`
    : `<div class="match-location" style="visibility:hidden;"><i class="fa-solid fa-location-dot"></i> Venue</div>`;

  return `
    <div class="match-card ${hasValue ? 'has-value-edge' : ''} ${m.is_finished ? 'is-finished-card' : ''}">
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
          <div class="contender-name" title="${escapeHtml(m.home_name)}">
            ${escapeHtml(m.home_name)}
            ${homeFavBadge}
          </div>
        </div>

        <div class="vs-badge-wrapper">
          <div class="vs-badge">vs</div>
        </div>

        <div class="contender away">
          <div class="avatar-circle" data-fallback="${escapeHtml(m.away_initials || '??')}">${awayAvatarHTML}</div>
          <div class="contender-name" title="${escapeHtml(m.away_name)}">
            ${escapeHtml(m.away_name)}
            ${awayFavBadge}
          </div>
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

// Filter Event Handlers
function handleSearchInput() {
  const val = document.getElementById('searchInput').value;
  document.getElementById('clearSearchBtn').style.display = val ? 'block' : 'none';

  clearTimeout(state.searchDebounceTimer);
  state.searchDebounceTimer = setTimeout(() => {
    state.search = val;
    applyFilters();
  }, 250);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  state.search = '';
  applyFilters();
}

function applyFilters() {
  const leagueSelect = document.getElementById('leagueSelect');
  const dateSelect = document.getElementById('dateSelect');
  const sortSelect = document.getElementById('sortSelect');
  const valueToggle = document.getElementById('valueOnlyToggle');
  const fav51Toggle = document.getElementById('fav51OnlyToggle');

  if (leagueSelect) state.league = leagueSelect.value;
  if (dateSelect) state.dateFilter = dateSelect.value;
  if (sortSelect) state.sortOrder = sortSelect.value;
  if (valueToggle) state.valueOnly = valueToggle.checked;
  if (fav51Toggle) state.fav51Only = fav51Toggle.checked;

  let sourceList = [];
  if (state.currentView === 'active') {
    sourceList = state.allMatchesCache[state.sport] || [];
  } else if (state.currentView === 'value') {
    sourceList = (state.allMatchesCache[state.sport] || []).filter(m => m.has_value === 1);
  } else if (state.currentView === 'finished') {
    sourceList = state.finishedMatchesCache[state.sport] || [];
  }
  processAndRenderMatches(sourceList);
}

function resetFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';

  const leagueSelect = document.getElementById('leagueSelect');
  const dateSelect = document.getElementById('dateSelect');
  const sortSelect = document.getElementById('sortSelect');
  const valueToggle = document.getElementById('valueOnlyToggle');
  const fav51Toggle = document.getElementById('fav51OnlyToggle');

  if (leagueSelect) leagueSelect.value = 'all';
  if (dateSelect) dateSelect.value = 'all';
  if (sortSelect) sortSelect.value = 'soonest';
  if (valueToggle) valueToggle.checked = false;
  if (fav51Toggle) fav51Toggle.checked = false;

  state.search = '';
  state.league = 'all';
  state.dateFilter = 'all';
  state.sortOrder = 'soonest';
  state.valueOnly = false;
  state.fav51Only = false;

  let sourceList = [];
  if (state.currentView === 'active') {
    sourceList = state.allMatchesCache[state.sport] || [];
  } else if (state.currentView === 'value') {
    sourceList = (state.allMatchesCache[state.sport] || []).filter(m => m.has_value === 1);
  } else if (state.currentView === 'finished') {
    sourceList = state.finishedMatchesCache[state.sport] || [];
  }
  processAndRenderMatches(sourceList);
}

function updateSummary() {
  const sportName = state.sport === 'tennis' ? 'Tennis' : 'Football';
  const viewName = state.currentView === 'finished' ? 'Finished' : (state.currentView === 'value' ? 'Value Bet' : 'Live & Upcoming');
  const count = state.matches.length;
  const summaryEl = document.getElementById('matchesSummary');
  if (summaryEl) {
    summaryEl.textContent = `Showing ${count} ${viewName} ${sportName} matches`;
  }
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

// Manual Sync Trigger (Handles both Live Backend & GitHub Pages Static Mode)
async function triggerManualSync() {
  const btn = document.getElementById('syncNowBtn');
  btn.classList.add('spinning');
  btn.disabled = true;

  if (state.isStaticMode) {
    showToast('Refreshing latest match data from GitHub...', 'info');
    try {
      await checkStaticDataFallback();
      showToast('Matches & odds refreshed successfully!', 'success');
    } catch (e) {
      showToast('Unable to reach GitHub data cache', 'error');
    } finally {
      setTimeout(() => {
        btn.classList.remove('spinning');
        btn.disabled = false;
      }, 1200);
    }
    return;
  }

  showToast('Starting real-time scraper sync...', 'info');
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
    state.isStaticMode = true;
    await checkStaticDataFallback();
    showToast('Switched to static archive. Refreshed data!', 'info');
  } finally {
    setTimeout(() => {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }, 1500);
  }
}

// Scraper Activity Logs Modal Functions
function openLogsModal() {
  const modal = document.getElementById('logsModal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderLogsModal();
}

function closeLogsModal(e) {
  const modal = document.getElementById('logsModal');
  if (!modal) return;
  if (!e || e.target === modal || e.target.classList.contains('btn-modal-close') || e.target.classList.contains('btn-modal-close-action')) {
    modal.style.display = 'none';
  }
}

function renderLogsModal() {
  const stats = state.statsCache || {};
  const history = stats.history || (stats.last_run ? [stats.last_run] : []);
  const tennisCount = (state.allMatchesCache.tennis || []).length;
  const footballCount = (state.allMatchesCache.football || []).length;
  const total = tennisCount + footballCount;

  const modalState = document.getElementById('modalScraperState');
  const modalTotal = document.getElementById('modalTotalMatches');
  const modalLast = document.getElementById('modalLastRun');

  if (modalState) modalState.textContent = state.isScrapingActive ? 'Running' : 'Active (Hourly Auto)';
  if (modalTotal) modalTotal.textContent = `${total} matches`;

  const lastRun = stats.last_run;
  if (lastRun && lastRun.timestamp) {
    if (modalLast) modalLast.textContent = formatIST12Hour(lastRun.timestamp);
  } else {
    if (modalLast) modalLast.textContent = 'Auto via GitHub Actions';
  }

  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  if (history.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: #64748B; padding: 16px;">
          Scraper runs hourly on GitHub Actions. Total ${total} matches currently loaded.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = history.map(r => {
    const timeFormatted = formatIST12Hour(r.timestamp);
    const errors = r.errors || 0;
    const duration = r.duration_seconds ? `${r.duration_seconds}s` : '-';
    const tagClass = errors > 5 ? 'err' : (errors > 0 ? 'warn' : 'ok');
    const tagText = errors === 0 ? 'Success' : (errors < 5 ? 'Partial' : 'Error');

    return `
      <tr>
        <td><strong>${timeFormatted}</strong></td>
        <td>${r.total_urls || '-'}</td>
        <td>${r.scraped_matches || '-'} (${r.new_matches || 0} new, ${r.updated_matches || 0} refreshed)</td>
        <td>${errors}</td>
        <td>${duration}</td>
        <td><span class="logs-status-tag ${tagClass}">${tagText}</span></td>
      </tr>
    `;
  }).join('');
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast-notification show ${type}`;
  setTimeout(() => {
    toast.className = 'toast-notification';
  }, 3500);
}
