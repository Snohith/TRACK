/**
 * StatsArena Match Explorer - Client Application
 * Features:
 * - 12-Hour IST (Indian Standard Time, UTC+5:30) Timestamps
 * - 3 Dedicated Views: Live & Upcoming, Value Bets (+EV), Finished Matches Archive
 * - Multi-criteria Filters: Text Search, Tournaments, IST Dates, >=51% Favs Toggle, Value Toggle
 * - Smart Chronological & Status Sorting (Live -> Soonest Upcoming -> Past/Finished)
 * - Seamless Dual-Mode: Live Dynamic Backend API + GitHub Pages Fallback
 * - Auto-Refresh in Background (Every 30s)
 * - Finished Matches Analytics & Realized ROI Calculator
 * - Scraper Run History & Logs Modal
 */

const isStaticHost = typeof window !== 'undefined' && (
  window.location.hostname.includes('github.io') ||
  window.location.protocol === 'file:'
);

const state = {
  sport: 'tennis',
  currentView: 'active', // 'active' | 'value' | 'finished'
  finishedCategory: 'fav51', // 'fav51' (>=51% Favs), 'under51' (<51% Leftovers), 'all' (All Matches)
  finishedDateRange: {
    start: null, // 'YYYY-MM-DD'
    end: null,   // 'YYYY-MM-DD'
    isPickingEnd: false
  },
  calViewYear: 2026,
  calViewMonth: 7, // 0-indexed (7 = August)
  search: '',
  league: 'all',
  dateFilter: 'all',
  sortOrder: 'soonest', // 'soonest', 'asc', 'desc', 'value', 'prob'
  valueSortOrder: 'desc', // 'desc' (highest value), 'asc' (lowest value), 'soonest'
  valueOnly: false,
  fav51Only: false,
  matches: [],
  allMatchesCache: { tennis: [], football: [] },
  finishedMatchesCache: { tennis: [], football: [] },
  valueMatchesCache: { tennis: [], football: [] },
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

  // Background Auto-Refresh every 30 seconds
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
      let res;
      try {
        res = await fetch('./data.json?_t=' + Date.now());
        if (!res.ok) throw new Error();
      } catch {
        res = await fetch('./static/data.json?_t=' + Date.now());
      }

      if (res && res.ok) {
        const staticData = await res.json();
        state.allMatchesCache = staticData.matches || { tennis: [], football: [] };
        state.finishedMatchesCache = staticData.finished_matches || { tennis: [], football: [] };
        state.valueMatchesCache = staticData.value_matches || { tennis: [], football: [] };
        state.leaguesCache = staticData.leagues || { tennis: [], football: [] };
        state.statsCache = staticData.stats || null;

        updateViewPillCounts();

        if (staticData.exported_at) {
          const lastMeta = document.getElementById('lastScrapeMeta');
          if (lastMeta) lastMeta.innerHTML = '<i class="fa-regular fa-clock"></i> Last scraped: ' + formatIST12Hour(staticData.exported_at);
        }

        refreshCurrentView();
      }
    } catch (e) {
      // silent background failure
    }
  } else {
    try {
      const isFin = state.currentView === 'finished' ? 1 : 0;
      const params = new URLSearchParams({
        sport: state.sport,
        is_finished: isFin.toString(),
        sort_order: 'asc',
        limit: '1000'
      });
      const res = await fetch('/api/matches?' + params.toString());
      if (res.ok) {
        const data = await res.json();
        if (state.currentView === 'finished') {
          state.finishedMatchesCache[state.sport] = data.matches || [];
        } else {
          state.allMatchesCache[state.sport] = data.matches || [];
        }
        processAndRenderMatches(data.matches || []);
      }
    } catch (e) {
      // silent
    }
  }
}

// Update counts on top view pills and sport badges
function updateViewPillCounts() {
  const activeT = (state.allMatchesCache.tennis || []).length;
  const activeF = (state.allMatchesCache.football || []).length;
  const totalActive = activeT + activeF;

  const valT = (state.allMatchesCache.tennis || []).filter(m => m.has_value === 1).length;
  const valF = (state.allMatchesCache.football || []).filter(m => m.has_value === 1).length;
  const totalVal = valT + valF;

  const finT = (state.finishedMatchesCache.tennis || []).length;
  const finF = (state.finishedMatchesCache.football || []).length;
  const totalFin = finT + finF;

  const activePill = document.getElementById('activeCountPill');
  const valPill = document.getElementById('valueCountPill');
  const finPill = document.getElementById('finishedCountPill');
  const badgeT = document.getElementById('tennisCountBadge');
  const badgeF = document.getElementById('footballCountBadge');

  if (activePill) activePill.textContent = totalActive;
  if (valPill) valPill.textContent = totalVal;
  if (finPill) finPill.textContent = totalFin;

  if (state.currentView === 'active') {
    if (badgeT) badgeT.textContent = activeT;
    if (badgeF) badgeF.textContent = activeF;
  } else if (state.currentView === 'value') {
    if (badgeT) badgeT.textContent = valT;
    if (badgeF) badgeF.textContent = valF;
  } else if (state.currentView === 'finished') {
    if (badgeT) badgeT.textContent = finT;
    if (badgeF) badgeF.textContent = finF;
  }
}

// Top View Switcher (Live & Upcoming / Value Bets / Finished Matches)
function switchView(view) {
  state.currentView = view;

  const btnActive = document.getElementById('viewBtnActive');
  const btnValue = document.getElementById('viewBtnValue');
  const btnFinished = document.getElementById('viewBtnFinished');

  if (btnActive) btnActive.classList.toggle('active', view === 'active');
  if (btnValue) btnValue.classList.toggle('active', view === 'value');
  if (btnFinished) btnFinished.classList.toggle('active', view === 'finished');

  const analyticsCard = document.getElementById('finishedAnalyticsCard');
  const finishedFilterWrapper = document.getElementById('finishedFilterWrapper');
  const valueSortWrapper = document.getElementById('valueSortWrapper');
  const valToggleWrap = document.getElementById('valueToggleWrapper');
  const dateFilterWrap = document.getElementById('dateFilterWrapper');

  if (analyticsCard) analyticsCard.style.display = view === 'finished' ? 'block' : 'none';
  if (finishedFilterWrapper) finishedFilterWrapper.style.display = view === 'finished' ? 'block' : 'none';
  if (valueSortWrapper) valueSortWrapper.style.display = view === 'value' ? 'block' : 'none';
  if (valToggleWrap) valToggleWrap.style.display = view === 'value' ? 'none' : 'flex';
  if (dateFilterWrap) dateFilterWrap.style.display = view === 'finished' ? 'none' : 'block';

  if (view === 'finished') {
    renderCalendarGrid();
    updateDateRangeButtonUI();
    renderFinishedAnalytics();
  }

  updateViewPillCounts();
  refreshCurrentView();
}

// Finished Matches Category Switcher (Favorites ≥51% / Non-Favorites <51% / All Matches)
function setFinishedCategory(cat) {
  state.finishedCategory = cat;

  const btnFav51 = document.getElementById('finFilterFav51');
  const btnUnder51 = document.getElementById('finFilterUnder51');
  const btnAll = document.getElementById('finFilterAll');

  if (btnFav51) btnFav51.classList.toggle('active', cat === 'fav51');
  if (btnUnder51) btnUnder51.classList.toggle('active', cat === 'under51');
  if (btnAll) btnAll.classList.toggle('active', cat === 'all');

  renderFinishedAnalytics();
  refreshCurrentView();
}

// Extract IST Date string formatted as 'YYYY-MM-DD' (e.g. '2026-08-29')
function getMatchISTDateKey(isoOrTimestamp) {
  if (!isoOrTimestamp) return null;
  const date = typeof isoOrTimestamp === 'number' 
    ? (isoOrTimestamp > 1e11 ? new Date(isoOrTimestamp) : new Date(isoOrTimestamp * 1000)) 
    : new Date(isoOrTimestamp);
  if (isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    
    let y = '', m = '', d = '';
    parts.forEach(p => {
      if (p.type === 'year') y = p.value;
      if (p.type === 'month') m = p.value;
      if (p.type === 'day') d = p.value;
    });
    return `${y}-${m}-${d}`;
  } catch (e) {
    return null;
  }
}

// Format YYYY-MM-DD into human-readable short date (e.g. 'Aug 29')
function formatDateKeyToShort(dateKey) {
  if (!dateKey) return '';
  const parts = dateKey.split('-');
  if (parts.length !== 3) return dateKey;
  const dateObj = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateObj);
}

// Check if a match falls inside the selected Finished Date Range
function isMatchInFinishedRange(match) {
  if (!state.finishedDateRange) return true;
  const { start, end } = state.finishedDateRange;
  if (!start && !end) return true;
  const matchKey = getMatchISTDateKey(match.start_timestamp);
  if (!matchKey) return true;
  if (start && !end) return matchKey === start;
  if (!start && end) return matchKey === end;
  return matchKey >= start && matchKey <= end;
}

// Toggle Calendar Popover Dropdown
function toggleCalendarDropdown(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const dropdown = document.getElementById('calendarDropdown');
  const btn = document.getElementById('finDateRangeBtn');
  if (!dropdown) return;

  if (!state.finishedDateRange) {
    state.finishedDateRange = { start: null, end: null, isPickingEnd: false };
  }

  const isHidden = dropdown.style.display === 'none' || !dropdown.style.display;
  if (isHidden) {
    if (state.finishedDateRange.start) {
      const parts = state.finishedDateRange.start.split('-');
      state.calViewYear = parseInt(parts[0]);
      state.calViewMonth = parseInt(parts[1]) - 1;
    } else {
      state.calViewYear = 2026;
      state.calViewMonth = 7;
    }
    renderCalendarGrid();
    dropdown.style.display = 'block';
    if (btn) btn.classList.add('open');
  } else {
    dropdown.style.display = 'none';
    if (btn) btn.classList.remove('open');
  }
}

// Close Calendar Popover
function closeCalendarDropdown(e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const dropdown = document.getElementById('calendarDropdown');
  const btn = document.getElementById('finDateRangeBtn');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) btn.classList.remove('open');
}

// Previous Month Navigation
function prevCalMonth(e) {
  if (e) e.stopPropagation();
  state.calViewMonth = (state.calViewMonth || 7) - 1;
  if (state.calViewMonth < 0) {
    state.calViewMonth = 11;
    state.calViewYear = (state.calViewYear || 2026) - 1;
  }
  renderCalendarGrid();
}

// Next Month Navigation
function nextCalMonth(e) {
  if (e) e.stopPropagation();
  state.calViewMonth = (state.calViewMonth || 7) + 1;
  if (state.calViewMonth > 11) {
    state.calViewMonth = 0;
    state.calViewYear = (state.calViewYear || 2026) + 1;
  }
  renderCalendarGrid();
}

// Render Calendar Days Grid & Match Indicators
function renderCalendarGrid() {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  if (typeof state.calViewYear !== 'number') state.calViewYear = 2026;
  if (typeof state.calViewMonth !== 'number') state.calViewMonth = 7;
  if (!state.finishedDateRange) {
    state.finishedDateRange = { start: null, end: null, isPickingEnd: false };
  }
  
  const titleEl = document.getElementById('calMonthTitle');
  const gridEl = document.getElementById('calDaysGrid');
  const hintEl = document.getElementById('calHintText');
  if (titleEl) titleEl.textContent = `${monthNames[state.calViewMonth]} ${state.calViewYear}`;

  if (hintEl) {
    if (state.finishedDateRange.isPickingEnd) {
      hintEl.textContent = `Start: ${formatDateKeyToShort(state.finishedDateRange.start)} · Click END date`;
      hintEl.style.color = '#6366F1';
      hintEl.style.fontWeight = '700';
    } else if (state.finishedDateRange.start) {
      const label = state.finishedDateRange.start === state.finishedDateRange.end 
        ? formatDateKeyToShort(state.finishedDateRange.start)
        : `${formatDateKeyToShort(state.finishedDateRange.start)} – ${formatDateKeyToShort(state.finishedDateRange.end)}`;
      hintEl.textContent = `Range: ${label}`;
      hintEl.style.color = '#10B981';
      hintEl.style.fontWeight = '700';
    } else {
      hintEl.textContent = 'Click 1st date for start, 2nd for end';
      hintEl.style.color = '#64748B';
      hintEl.style.fontWeight = '500';
    }
  }

  if (!gridEl) return;

  // Collect all dates with finished matches in this sport
  const finList = state.finishedMatchesCache[state.sport] || [];
  const matchDatesSet = new Set();
  finList.forEach(m => {
    const k = getMatchISTDateKey(m.start_timestamp);
    if (k) matchDatesSet.add(k);
  });

  const firstDayIndex = new Date(state.calViewYear, state.calViewMonth, 1).getDay();
  const totalDays = new Date(state.calViewYear, state.calViewMonth + 1, 0).getDate();

  let html = '';
  // Empty leading cells
  for (let i = 0; i < firstDayIndex; i++) {
    html += '<div class="cal-cell empty"></div>';
  }

  const { start, end } = state.finishedDateRange;

  for (let day = 1; day <= totalDays; day++) {
    const mStr = String(state.calViewMonth + 1).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const dateKey = `${state.calViewYear}-${mStr}-${dStr}`;

    const hasData = matchDatesSet.has(dateKey);
    let classes = ['cal-cell'];
    if (hasData) classes.push('has-data');

    if (start && dateKey === start) classes.push('range-start');
    if (end && dateKey === end) classes.push('range-end');
    if (start && end && dateKey > start && dateKey < end) classes.push('in-range');

    html += `<div class="${classes.join(' ')}" onclick="handleCalendarDayClick('${dateKey}', event)">${day}</div>`;
  }

  gridEl.innerHTML = html;
}

// Handle Day Click for 2-Click Range Selection
function handleCalendarDayClick(dateKey, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  if (!state.finishedDateRange) {
    state.finishedDateRange = { start: null, end: null, isPickingEnd: false };
  }

  if (!state.finishedDateRange.isPickingEnd) {
    // 1st Click: Select Start Date
    state.finishedDateRange.start = dateKey;
    state.finishedDateRange.end = dateKey;
    state.finishedDateRange.isPickingEnd = true;
    updateDateRangeButtonUI();
    renderCalendarGrid();
    renderFinishedAnalytics();
    refreshCurrentView();
  } else {
    // 2nd Click: Select End Date
    let start = state.finishedDateRange.start;
    let end = dateKey;
    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    state.finishedDateRange.start = start;
    state.finishedDateRange.end = end;
    state.finishedDateRange.isPickingEnd = false;

    updateDateRangeButtonUI();
    renderCalendarGrid();
    renderFinishedAnalytics();
    refreshCurrentView();
  }
}

// Reset Date Range Filter (All Dates)
function resetDateRange(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  state.finishedDateRange = { start: null, end: null, isPickingEnd: false };

  updateDateRangeButtonUI();
  renderCalendarGrid();
  renderFinishedAnalytics();
  refreshCurrentView();
  closeCalendarDropdown();
}

// Update the Top Date Range Button Label & Highlight State
function updateDateRangeButtonUI() {
  const btn = document.getElementById('finDateRangeBtn');
  const textEl = document.getElementById('dateRangeBtnText');
  if (!state.finishedDateRange) {
    state.finishedDateRange = { start: null, end: null, isPickingEnd: false };
  }
  const { start, end } = state.finishedDateRange;

  if (!start && !end) {
    if (textEl) textEl.textContent = 'All Dates';
    if (btn) btn.classList.remove('active');
  } else if (start === end) {
    if (textEl) textEl.textContent = formatDateKeyToShort(start);
    if (btn) btn.classList.add('active');
  } else {
    if (textEl) textEl.textContent = `${formatDateKeyToShort(start)} – ${formatDateKeyToShort(end)}`;
    if (btn) btn.classList.add('active');
  }
}

// Value Bet Sort Controller (High/Low Value or Soonest)
function setValueSort(mode) {
  state.valueSortOrder = mode;

  const btnDesc = document.getElementById('valSortDesc');
  const btnAsc = document.getElementById('valSortAsc');
  const btnSoonest = document.getElementById('valSortSoonest');

  if (btnDesc) btnDesc.classList.toggle('active', mode === 'desc');
  if (btnAsc) btnAsc.classList.toggle('active', mode === 'asc');
  if (btnSoonest) btnSoonest.classList.toggle('active', mode === 'soonest');

  refreshCurrentView();
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
  if (state.currentView === 'finished') {
    renderCalendarGrid();
    updateDateRangeButtonUI();
    renderFinishedAnalytics();
  }
  refreshCurrentView();
}

// Fallback Loader for Static Hosting (GitHub Pages)
async function checkStaticDataFallback() {
  state.isStaticMode = true;
  state.isLoading = true;
  updateLoadingState();

  try {
    let res;
    try {
      res = await fetch('./data.json?_t=' + Date.now());
      if (!res.ok) throw new Error('data.json not at root');
    } catch {
      res = await fetch('./static/data.json?_t=' + Date.now());
    }

    if (res && res.ok) {
      const staticData = await res.json();
      state.allMatchesCache = staticData.matches || { tennis: [], football: [] };
      state.finishedMatchesCache = staticData.finished_matches || { tennis: [], football: [] };
      state.valueMatchesCache = staticData.value_matches || { tennis: [], football: [] };
      state.leaguesCache = staticData.leagues || { tennis: [], football: [] };
      state.statsCache = staticData.stats || null;

      const tennisCount = (state.allMatchesCache.tennis || []).length;
      const footballCount = (state.allMatchesCache.football || []).length;
      const totalActive = tennisCount + footballCount;

      updateViewPillCounts();

      const badge = document.getElementById('scraperStateBadge');
      if (badge) badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Auto-Synced Archive';
      const statusText = document.getElementById('scraperStatusText');
      if (statusText) statusText.textContent = 'Loaded ' + totalActive + ' active matches. Scraper updates every 10m via GitHub Actions.';

      if (staticData.exported_at) {
        const lastMeta = document.getElementById('lastScrapeMeta');
        if (lastMeta) lastMeta.innerHTML = '<i class="fa-regular fa-clock"></i> Last scraped: ' + formatIST12Hour(staticData.exported_at);
      }
      const nextMeta = document.getElementById('nextScrapeMeta');
      if (nextMeta) nextMeta.innerHTML = '<i class="fa-solid fa-bolt text-amber"></i> Every 10m Auto-Sync';

      updateLeagueDropdown();
      refreshCurrentView();
    }
  } catch (e) {
    console.error('Static data load failed:', e);
  } finally {
    state.isLoading = false;
    updateLoadingState();
  }
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
    renderCalendarGrid();
    updateDateRangeButtonUI();
    renderFinishedAnalytics();
  }
  updateLeagueDropdown();
  processAndRenderMatches(sourceList);
  updateViewPillCounts();
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

    const res = await fetch('/api/matches?' + params.toString());
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
    updateViewPillCounts();
  } catch (err) {
    state.isStaticMode = true;
    await checkStaticDataFallback();
  } finally {
    state.isLoading = false;
    updateLoadingState();
  }
}

// Compute and Render Finished Matches Analytics & Realized ROI (with Date Range Support)
function renderFinishedAnalytics() {
  const finTennis = state.finishedMatchesCache.tennis || [];
  const finFootball = state.finishedMatchesCache.football || [];
  const rawSportFin = state.sport === 'tennis' ? finTennis : (state.sport === 'football' ? finFootball : [...finTennis, ...finFootball]);

  // Filter by active date range
  const allFin = rawSportFin.filter(m => isMatchInFinishedRange(m));

  const favMatches = allFin.filter(m => {
    const topProb = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
    return topProb >= 51.0;
  });

  const nonFavMatches = allFin.filter(m => {
    const topProb = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
    return topProb < 51.0;
  });

  let activeCategoryMatches = [];
  let categoryBadgeText = '';
  let subLabelText = '';

  const { start, end } = state.finishedDateRange;
  let dateSuffix = '';
  if (start && end) {
    dateSuffix = start === end ? ` · ${formatDateKeyToShort(start)}` : ` · ${formatDateKeyToShort(start)}–${formatDateKeyToShort(end)}`;
  }

  if (state.finishedCategory === 'fav51') {
    activeCategoryMatches = favMatches;
    categoryBadgeText = `Strategy: Favorites (≥51%)${dateSuffix}`;
    subLabelText = 'Favorites (≥51%)';
  } else if (state.finishedCategory === 'under51') {
    activeCategoryMatches = nonFavMatches;
    categoryBadgeText = `Strategy: Non-Favorites (<51% Leftovers)${dateSuffix}`;
    subLabelText = 'Non-Favorites (<51%)';
  } else {
    activeCategoryMatches = allFin;
    categoryBadgeText = `Strategy: All Matches (No Filter)${dateSuffix}`;
    subLabelText = 'All Tracked Matches';
  }

  let totalStaked = activeCategoryMatches.length * 1.0;
  let totalReturned = 0.0;
  let wins = 0;
  let settledCount = 0;

  activeCategoryMatches.forEach(m => {
    const favOdds = m.fav_odds || (m.home_prob >= m.away_prob ? m.market_home : m.market_away) || 1.5;
    if (m.fav_won === 1) {
      totalReturned += favOdds;
      wins += 1;
      settledCount += 1;
    } else if (m.fav_won === 0) {
      // Pick lost: 0 return
      settledCount += 1;
    } else {
      // Unsettled / Pending
      totalReturned += 1.0;
    }
  });

  const netProfit = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? (netProfit / totalStaked) * 100 : 0;
  const winRate = settledCount > 0 ? (wins / settledCount) * 100 : 0;

  const elBadge = document.getElementById('analyticsStrategyBadge');
  const elSubLabel = document.getElementById('roiSubLabel');
  const elTotalFin = document.getElementById('roiTotalFinished');
  const elTotalFavs = document.getElementById('roiTotalFavs');
  const elWinRate = document.getElementById('roiWinRate');
  const elStaked = document.getElementById('roiTotalStaked');
  const elProfit = document.getElementById('roiNetProfit');
  const elRoi = document.getElementById('roiPercentage');

  if (elBadge) elBadge.textContent = categoryBadgeText;
  if (elSubLabel) elSubLabel.textContent = subLabelText;
  if (elTotalFin) elTotalFin.textContent = allFin.length;
  if (elTotalFavs) elTotalFavs.textContent = activeCategoryMatches.length;
  if (elWinRate) {
    elWinRate.textContent = winRate.toFixed(1) + '%';
    elWinRate.className = 'stat-value ' + (winRate >= 50 ? 'text-emerald' : 'text-amber');
  }
  if (elStaked) elStaked.textContent = totalStaked.toFixed(2) + 'u';
  if (elProfit) {
    const sign = netProfit >= 0 ? '+' : '';
    elProfit.textContent = sign + netProfit.toFixed(2) + 'u';
    elProfit.className = 'stat-value ' + (netProfit >= 0 ? 'text-emerald' : 'text-danger');
  }
  if (elRoi) {
    const sign = roi >= 0 ? '+' : '';
    elRoi.textContent = sign + roi.toFixed(1) + '%';
    elRoi.className = 'stat-value ' + (roi >= 0 ? 'text-emerald' : 'text-danger');
  }
}

// Filter, Sort, and Render Pipeline
function processAndRenderMatches(rawList) {
  let list = [...rawList];

  // View & Category Filter
  if (state.currentView === 'value') {
    list = list.filter(m => m.has_value === 1);
  } else if (state.currentView === 'finished') {
    // 1. Date Range Filter for Finished Matches
    list = list.filter(m => isMatchInFinishedRange(m));

    // 2. Category Filter (Favorites >=51% vs Non-Favorites <51% vs All)
    if (state.finishedCategory === 'fav51') {
      list = list.filter(m => {
        const topProb = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
        return topProb >= 51.0;
      });
    } else if (state.finishedCategory === 'under51') {
      list = list.filter(m => {
        const topProb = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
        return topProb < 51.0;
      });
    }
  }

  // Favorites >=51% Only Filter
  if (state.fav51Only) {
    list = list.filter(m => {
      const maxP = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);
      return maxP >= 51.0;
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

  // 5. Sorting
  if (state.currentView === 'value') {
    if (state.valueSortOrder === 'desc') {
      list = list.sort((a, b) => (b.value_edge || 0) - (a.value_edge || 0) || (a.start_timestamp || 0) - (b.start_timestamp || 0));
    } else if (state.valueSortOrder === 'asc') {
      list = list.sort((a, b) => (a.value_edge || 0) - (b.value_edge || 0) || (a.start_timestamp || 0) - (b.start_timestamp || 0));
    } else {
      list = sortMatchesSmart(list, 'soonest');
    }
  } else {
    list = sortMatchesSmart(list, state.sortOrder);
  }

  state.matches = list;
  renderMatches();
  updateSummary();
}

/**
 * Smart Sorting:
 * - 'soonest': Live in-progress matches first -> Upcoming matches (sorted soonest to latest) -> Past/Finished matches
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
    const maxProb = Math.max(m.fav_prob || 0, m.home_prob || 0, m.away_prob || 0, m.draw_prob || 0);

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
}

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
  const date = typeof isoOrTimestamp === 'number' 
    ? (isoOrTimestamp > 1e11 ? new Date(isoOrTimestamp) : new Date(isoOrTimestamp * 1000)) 
    : new Date(isoOrTimestamp);
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

    return hour + ':' + minute + ' ' + dayPeriod + ' · ' + month + ' ' + day;
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

  // Avatars
  const homeAvatarHTML = m.home_avatar
    ? `<img src="${escapeHtml(m.home_avatar)}" alt="${escapeHtml(m.home_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.home_initials || '??');

  const awayAvatarHTML = m.away_avatar
    ? `<img src="${escapeHtml(m.away_avatar)}" alt="${escapeHtml(m.away_name)}" onerror="this.style.display='none';this.parentElement.textContent=this.parentElement.dataset.fallback||'??'"/>`
    : escapeHtml(m.away_initials || '??');

  // Match Status Tag (Live / Delayed / Finished / Regular)
  let statusTag = '';
  if (m.is_finished === 1 || m._status === 'finished') {
    let outcomeHTML = '';
    if (m.fav_won === 1) {
      outcomeHTML = ' <span class="outcome-badge win"><i class="fa-solid fa-check"></i> FAV WON</span>';
    } else if (m.fav_won === 0) {
      outcomeHTML = ' <span class="outcome-badge loss"><i class="fa-solid fa-xmark"></i> FAV LOST</span>';
    }
    const scoreHTML = m.final_score ? ` <span class="final-score-pill">${escapeHtml(m.final_score)}</span>` : '';
    statusTag = '<span class="finished-tag">FINISHED</span>' + scoreHTML + outcomeHTML;
  } else if (m._status === 'live') {
    statusTag = '<span class="live-tag">LIVE</span>';
  } else if (m._isDelayed) {
    statusTag = '<span class="delayed-tag">DELAYED</span>';
  }

  // Favorite >=51% Badges
  const isHomeFav = (m.fav_side === 'home' && (m.fav_prob >= 51.0 || (homeProb && homeProb >= 51))) || (homeProb && homeProb >= 51);
  const isAwayFav = (m.fav_side === 'away' && (m.fav_prob >= 51.0 || (awayProb && awayProb >= 51))) || (awayProb && awayProb >= 51);
  const homeFavBadge = isHomeFav ? '<span class="fav-badge-highlight" title="Favorite Win Chance: ' + homeProb + '%"><i class="fa-solid fa-star"></i> 51%+</span>' : '';
  const awayFavBadge = isAwayFav ? '<span class="fav-badge-highlight" title="Favorite Win Chance: ' + awayProb + '%"><i class="fa-solid fa-star"></i> 51%+</span>' : '';

  // Probability Bar HTML
  let probBarHTML = '';
  let probLabelsHTML = '';

  if (homeProb !== null && awayProb !== null) {
    if (isTennis || !drawProb) {
      // 2-Way Tennis Dual Bar
      probBarHTML = '<div class="probability-bar">' +
        '<div class="prob-segment home" style="width: ' + homeProb + '%;">' + homeProb + '%</div>' +
        '<div class="prob-segment away" style="width: ' + awayProb + '%;">' + awayProb + '%</div>' +
      '</div>';
      probLabelsHTML = '<div class="prob-labels">' +
        '<span class="home-label">' + escapeHtml(homeSurname) + ' win chance</span>' +
        '<span class="away-label">' + escapeHtml(awaySurname) + ' win chance</span>' +
      '</div>';
    } else {
      // 3-Way Football Bar
      probBarHTML = '<div class="probability-bar">' +
        '<div class="prob-segment home" style="width: ' + homeProb + '%;" title="Home: ' + homeProb + '%">' + homeProb + '%</div>' +
        '<div class="prob-segment draw" style="width: ' + drawProb + '%;" title="Draw: ' + drawProb + '%">' + drawProb + '%</div>' +
        '<div class="prob-segment away" style="width: ' + awayProb + '%;" title="Away: ' + awayProb + '%">' + awayProb + '%</div>' +
      '</div>';
      probLabelsHTML = '<div class="prob-labels">' +
        '<span class="home-label">' + escapeHtml(homeSurname) + '</span>' +
        '<span class="draw-label">Draw (' + drawProb + '%)</span>' +
        '<span class="away-label">' + escapeHtml(awaySurname) + '</span>' +
      '</div>';
    }
  } else {
    probBarHTML = '<div class="probability-bar" style="background:#E2E8F0; justify-content:center; align-items:center; font-size:12px; color:#64748B;">Odds Pending</div>';
  }

  // Odds blocks
  let marketOddsValues = '';
  let fairOddsValues = '';

  const edgeLabel = m.value_edge ? ' +' + m.value_edge + '%' : '';

  if (isTennis || !m.market_draw) {
    marketOddsValues = '<div class="odds-val-item"><span>' + mHome + '</span></div>' +
      '<div class="odds-val-item" style="text-align:right;"><span>' + mAway + '</span></div>';
    fairOddsValues = '<div class="odds-val-item">' +
        '<span>' + fHome + '</span>' +
        (valueSide === 'home' ? '<span class="val-edge-tag" title="Expected Value: +' + (m.value_edge || 0) + '%">VALUE' + edgeLabel + '</span>' : '') +
      '</div>' +
      '<div class="odds-val-item" style="text-align:right;">' +
        '<span>' + fAway + '</span>' +
        (valueSide === 'away' ? '<span class="val-edge-tag" title="Expected Value: +' + (m.value_edge || 0) + '%">VALUE' + edgeLabel + '</span>' : '') +
      '</div>';
  } else {
    marketOddsValues = '<div class="odds-val-item"><span style="font-size:15px;">' + mHome + '</span></div>' +
      '<div class="odds-val-item" style="text-align:center;"><span style="font-size:15px; color:#64748B;">' + mDraw + '</span></div>' +
      '<div class="odds-val-item" style="text-align:right;"><span style="font-size:15px;">' + mAway + '</span></div>';
    fairOddsValues = '<div class="odds-val-item">' +
        '<span style="font-size:15px;">' + fHome + '</span>' +
        (valueSide === 'home' ? '<span class="val-edge-tag" title="Expected Value: +' + (m.value_edge || 0) + '%">VAL' + edgeLabel + '</span>' : '') +
      '</div>' +
      '<div class="odds-val-item" style="text-align:center;">' +
        '<span style="font-size:15px; color:#64748B;">' + fDraw + '</span>' +
        (valueSide === 'draw' ? '<span class="val-edge-tag" title="Expected Value: +' + (m.value_edge || 0) + '%">VAL' + edgeLabel + '</span>' : '') +
      '</div>' +
      '<div class="odds-val-item" style="text-align:right;">' +
        '<span style="font-size:15px;">' + fAway + '</span>' +
        (valueSide === 'away' ? '<span class="val-edge-tag" title="Expected Value: +' + (m.value_edge || 0) + '%">VAL' + edgeLabel + '</span>' : '') +
      '</div>';
  }

  const locationHTML = m.location
    ? '<div class="match-location"><i class="fa-solid fa-location-dot"></i> ' + escapeHtml(m.location) + '</div>'
    : '<div class="match-location" style="visibility:hidden;"><i class="fa-solid fa-location-dot"></i> Venue</div>';

  return '<div class="match-card ' + (hasValue ? 'has-value-edge' : '') + ' ' + (m.is_finished ? 'is-finished-card' : '') + '">' +
      '<div class="card-header">' +
        '<div class="league-badge" title="' + escapeHtml(m.league) + '">' +
          '<i class="fa-solid fa-trophy"></i>' +
          '<span>' + escapeHtml(m.league || (isTennis ? 'ATP Challenger' : 'Football League')) + '</span>' +
        '</div>' +
        '<div class="card-time-wrapper">' +
          statusTag +
          '<span>' + timeFormattedIST + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="contenders-row">' +
        '<div class="contender home">' +
          '<div class="avatar-circle" data-fallback="' + escapeHtml(m.home_initials || '??') + '">' + homeAvatarHTML + '</div>' +
          '<div class="contender-name" title="' + escapeHtml(m.home_name) + '">' +
            escapeHtml(m.home_name) +
            homeFavBadge +
          '</div>' +
        '</div>' +
        '<div class="vs-badge-wrapper">' +
          '<div class="vs-badge">vs</div>' +
        '</div>' +
        '<div class="contender away">' +
          '<div class="avatar-circle" data-fallback="' + escapeHtml(m.away_initials || '??') + '">' + awayAvatarHTML + '</div>' +
          '<div class="contender-name" title="' + escapeHtml(m.away_name) + '">' +
            escapeHtml(m.away_name) +
            awayFavBadge +
          '</div>' +
        '</div>' +
      '</div>' +
      locationHTML +
      probBarHTML +
      probLabelsHTML +
      '<div class="odds-container">' +
        '<div class="odds-card market">' +
          '<div class="odds-header">' +
            '<i class="fa-solid fa-building-columns"></i>' +
            '<span>Market odds</span>' +
          '</div>' +
          '<div class="odds-values">' +
            marketOddsValues +
          '</div>' +
        '</div>' +
        '<div class="odds-card fair">' +
          '<div class="odds-header">' +
            '<i class="fa-solid fa-scale-balanced"></i>' +
            '<span>Fair odds</span>' +
          '</div>' +
          '<div class="odds-values">' +
            fairOddsValues +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
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

// Filter Event Handlers
function handleSearchInput() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  const val = input ? input.value : '';
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';

  clearTimeout(state.searchDebounceTimer);
  state.searchDebounceTimer = setTimeout(() => {
    state.search = val;
    applyFilters();
  }, 250);
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  if (input) input.value = '';
  if (clearBtn) clearBtn.style.display = 'none';
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
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  if (input) input.value = '';
  if (clearBtn) clearBtn.style.display = 'none';

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
  const count = state.matches.length;
  const summaryEl = document.getElementById('matchesSummary');
  if (!summaryEl) return;

  if (state.currentView === 'value') {
    const sortDesc = state.valueSortOrder === 'desc' ? 'Highest Value' : (state.valueSortOrder === 'asc' ? 'Lowest Value' : 'Start Time');
    summaryEl.textContent = `Showing ${count} Value Bet ${sportName} matches (Sorted by ${sortDesc})`;
  } else if (state.currentView === 'finished') {
    const catDesc = state.finishedCategory === 'fav51' ? 'Favorites ≥51%' : (state.finishedCategory === 'under51' ? 'Non-Favorites <51%' : 'All Matches');
    const { start, end } = state.finishedDateRange;
    let dateDesc = '';
    if (start && end) {
      dateDesc = start === end ? ` · ${formatDateKeyToShort(start)}` : ` · ${formatDateKeyToShort(start)}–${formatDateKeyToShort(end)}`;
    }
    summaryEl.textContent = `Showing ${count} Finished ${sportName} matches (${catDesc}${dateDesc})`;
  } else {
    summaryEl.textContent = `Showing ${count} Live & Upcoming ${sportName} matches`;
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

    const total = live.total_urls || 240;
    const current = live.processed_count || 0;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 20;
    progressBar.style.width = pct + '%';

    document.getElementById('autoScraperStatus').textContent = 'Scraper Running (' + pct + '%)';
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
      statusText.textContent = 'Scraper completed. ' + (stats.total_count || (tennisCount + footballCount)) + ' matches updated (' + newMatches + ' new, ' + updatedMatches + ' refreshed) in ' + duration + 's.';
      lastScrapeMeta.innerHTML = '<i class="fa-regular fa-clock"></i> Last scraped: ' + lastTimeIST;
    } else {
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Idle';
      statusText.textContent = 'All ' + (stats.total_count || (tennisCount + footballCount)) + ' matches up-to-date.';
    }

    if (data.next_run) {
      const nextDate = new Date(data.next_run);
      const diffMin = Math.max(1, Math.round((nextDate - new Date()) / 60000));
      nextScrapeMeta.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> Next in ' + diffMin + 'm';
    } else {
      nextScrapeMeta.innerHTML = '<i class="fa-solid fa-clock"></i> Hourly Auto-Scrape';
    }
  }
}

// Trigger Manual Sync
async function triggerManualSync() {
  const btn = document.getElementById('syncNowBtn');
  const icon = document.getElementById('syncIcon');

  if (state.isStaticMode) {
    icon.classList.add('fa-spin');
    btn.disabled = true;
    showToast('Refreshing latest match feed...', 'info');
    await checkStaticDataFallback();
    setTimeout(() => {
      icon.classList.remove('fa-spin');
      btn.disabled = false;
      showToast('Match feed refreshed!', 'success');
    }, 800);
    return;
  }

  try {
    icon.classList.add('fa-spin');
    btn.disabled = true;
    showToast('Triggering background scraper sync...', 'info');

    const res = await fetch('/api/scrape/trigger', { method: 'POST' });
    const data = await res.json();

    if (data.status === 'started') {
      showToast('Scraper started! Fetching latest odds...', 'success');
      state.isScrapingActive = true;
      setTimeout(pollScraperStatus, 1500);
    } else if (data.status === 'already_running') {
      showToast('Scraper is already active in background.', 'info');
    }
  } catch (err) {
    showToast('Manual sync error. Falling back to cached data.', 'error');
  } finally {
    setTimeout(() => {
      icon.classList.remove('fa-spin');
      btn.disabled = false;
    }, 2000);
  }
}

// Scraper Run Logs Modal
function openLogsModal() {
  const modal = document.getElementById('logsModal');
  modal.style.display = 'flex';
  populateLogsModal();
}

function closeLogsModal(e) {
  if (e && e.target !== e.currentTarget && !e.target.classList.contains('btn-modal-close') && !e.target.classList.contains('btn-modal-close-action')) {
    return;
  }
  document.getElementById('logsModal').style.display = 'none';
}

function populateLogsModal() {
  const stats = state.statsCache || {};
  const history = stats.history || [];

  const modalScraperState = document.getElementById('modalScraperState');
  const modalLastRun = document.getElementById('modalLastRun');
  const modalNextRun = document.getElementById('modalNextRun');
  const modalTotalMatches = document.getElementById('modalTotalMatches');

  if (modalScraperState) modalScraperState.textContent = state.isScrapingActive ? 'Running' : 'Idle';
  if (modalLastRun) modalLastRun.textContent = stats.last_run ? formatIST12Hour(stats.last_run.timestamp) : 'N/A';
  if (modalNextRun) modalNextRun.textContent = 'Hourly via GitHub Actions';
  if (modalTotalMatches) modalTotalMatches.textContent = (stats.total_count || 0) + ' matches';

  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  if (history.length === 0) {
    tbody.innerHTML = '<tr><td>Just now</td><td>240</td><td>240 matches</td><td>0</td><td>0.0s</td><td><span class="logs-status-tag ok">SUCCESS</span></td></tr>';
    return;
  }

  tbody.innerHTML = history.map(h => {
    const isOk = (h.errors || 0) === 0 && h.status && !h.status.includes('Error');
    const statusTag = isOk
      ? '<span class="logs-status-tag ok">SUCCESS</span>'
      : '<span class="logs-status-tag err">ERROR</span>';

    return '<tr>' +
        '<td>' + formatIST12Hour(h.timestamp) + '</td>' +
        '<td>' + (h.total_urls || 0) + '</td>' +
        '<td>' + (h.scraped_matches || 0) + ' (' + (h.new_matches || 0) + ' new, ' + (h.updated_matches || 0) + ' refreshed)</td>' +
        '<td>' + (h.errors || 0) + '</td>' +
        '<td>' + (h.duration_seconds || 0).toFixed(1) + 's</td>' +
        '<td>' + statusTag + '</td>' +
      '</tr>';
  }).join('');
}

// Toast Notifications
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = 'toast-notification ' + type + ' show';

  setTimeout(() => {
    toast.className = 'toast-notification';
  }, 3500);
}
