// index.js

// App State
let watchHistory = { watches: {}, metadata: {} };
let allLogEvents = [];
let ignoredVideoIds = [];
let statsLimit = 10;
let statsTimeframe = 'all';
let statsRankingMode = 'count';
let statsStartDate = '';
let statsEndDate = '';
let statsMinWatches = 2;
let statsMinSpan = 0;
let showThumbnails = false;
let embedPlayer = false;
let statsMinimized = false;
let historyZoom = 1.0;
let calendarType = 'all';
let focusTopVideos = false;
let currentSelectedYear = new Date().getFullYear();

// Pagination State
let currentVisibleCount = 50;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  loadSavedState();
  setupDragAndDrop();
  setupEventListeners();
  
  if (hasData()) {
    showDashboard();
    processLogEvents();
    renderAll();
  } else {
    showImportScreen();
  }
});

// Check if we have data loaded
function hasData() {
  return watchHistory && Object.keys(watchHistory.watches || {}).length > 0;
}

// Load state from localStorage
function loadSavedState() {
  try {
    const savedDb = localStorage.getItem('yt_tracker_db');
    if (savedDb) {
      watchHistory = JSON.parse(savedDb);
    }
    
    ignoredVideoIds = JSON.parse(localStorage.getItem('yt_tracker_ignored')) || [];
    statsLimit = parseInt(localStorage.getItem('yt_tracker_limit')) || 10;
    statsTimeframe = localStorage.getItem('yt_tracker_timeframe') || 'all';
    statsRankingMode = localStorage.getItem('yt_tracker_ranking_mode') || 'count';
    statsStartDate = localStorage.getItem('yt_tracker_start_date') || '';
    statsEndDate = localStorage.getItem('yt_tracker_end_date') || '';
    statsMinWatches = parseInt(localStorage.getItem('yt_tracker_min_watches')) || 2;
    statsMinSpan = parseInt(localStorage.getItem('yt_tracker_min_span')) || 0;
    showThumbnails = localStorage.getItem('yt_tracker_thumbnails') === 'true';
    embedPlayer = localStorage.getItem('yt_tracker_embeds') === 'true';
    statsMinimized = localStorage.getItem('yt_tracker_stats_minimized') === 'true';
    historyZoom = parseFloat(localStorage.getItem('yt_tracker_zoom')) || 1.0;
    calendarType = localStorage.getItem('yt_tracker_calendar_type') || 'all';
    focusTopVideos = localStorage.getItem('yt_tracker_focus_top') === 'true';
    currentSelectedYear = parseInt(localStorage.getItem('yt_tracker_selected_year')) || new Date().getFullYear();
  } catch (e) {
    console.error('Failed to load local storage state:', e);
  }
}

// Save variables to localStorage
function saveState() {
  localStorage.setItem('yt_tracker_limit', statsLimit);
  localStorage.setItem('yt_tracker_timeframe', statsTimeframe);
  localStorage.setItem('yt_tracker_ranking_mode', statsRankingMode);
  localStorage.setItem('yt_tracker_start_date', statsStartDate);
  localStorage.setItem('yt_tracker_end_date', statsEndDate);
  localStorage.setItem('yt_tracker_min_watches', statsMinWatches);
  localStorage.setItem('yt_tracker_min_span', statsMinSpan);
  localStorage.setItem('yt_tracker_thumbnails', showThumbnails);
  localStorage.setItem('yt_tracker_embeds', embedPlayer);
  localStorage.setItem('yt_tracker_stats_minimized', statsMinimized);
  localStorage.setItem('yt_tracker_zoom', historyZoom);
  localStorage.setItem('yt_tracker_calendar_type', calendarType);
  localStorage.setItem('yt_tracker_focus_top', focusTopVideos);
  localStorage.setItem('yt_tracker_selected_year', currentSelectedYear);
  localStorage.setItem('yt_tracker_ignored', JSON.stringify(ignoredVideoIds));
}

// Show/Hide Dashboard Screens
function showDashboard() {
  document.getElementById('import-section').classList.add('hidden');
  document.getElementById('main-dashboard').classList.remove('hidden');
  document.getElementById('btn-clear-data').classList.remove('hidden');
}

function showImportScreen() {
  document.getElementById('import-section').classList.remove('hidden');
  document.getElementById('main-dashboard').classList.add('hidden');
  document.getElementById('btn-clear-data').classList.add('hidden');
}

// Convert indexed storage into a list of watch events sorted by timestamp descending
function processLogEvents() {
  const events = [];
  const { watches, metadata } = watchHistory;

  Object.keys(watches || {}).forEach((videoId) => {
    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel', duration: '' };
    const timestamps = watches[videoId] || [];
    
    timestamps.forEach((timestamp) => {
      events.push({
        videoId,
        timestamp,
        title: meta.title,
        channel: meta.channel,
        duration: meta.duration || '',
        isAd: meta.isAd || false
      });
    });
  });

  // Sort by timestamp descending
  events.sort((a, b) => b.timestamp - a.timestamp);
  allLogEvents = events;
  
  // Set default selected year if current year has no data
  if (allLogEvents.length > 0) {
    const lastEventYear = new Date(allLogEvents[0].timestamp).getFullYear();
    if (!localStorage.getItem('yt_tracker_selected_year')) {
      currentSelectedYear = lastEventYear;
    }
  }
}

// Drag & Drop Setup
function setupDragAndDrop() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      importFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importFile(e.target.files[0]);
    }
  });
}

// File Importer
function importFile(file) {
  const reader = new FileReader();
  
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      
      // Check if it is standard Chrome extension export or Google Takeout array
      if (Array.isArray(parsed)) {
        // Parse Google Takeout JSON format
        showToast('Converting Google Takeout JSON...');
        const converted = convertTakeoutToNative(parsed);
        watchHistory = converted;
      } else if (parsed && parsed.watches && parsed.metadata) {
        // Parse Chrome extension backup format
        watchHistory = parsed;
      } else {
        throw new Error('Unrecognized JSON format. File must be a Google Takeout history array or extension backup.');
      }
      
      localStorage.setItem('yt_tracker_db', JSON.stringify(watchHistory));
      showToast('Successfully imported watch history!');
      showDashboard();
      processLogEvents();
      renderAll();
    } catch (err) {
      alert('Failed to parse file: ' + err.message);
      console.error(err);
    }
  };

  reader.onerror = () => {
    alert('Failed to read file.');
  };

  reader.readAsText(file);
}

// Google Takeout JSON Conversion
function convertTakeoutToNative(rawHistory) {
  const watches = {};
  const metadata = {};

  rawHistory.forEach(item => {
    if (item.titleUrl && item.titleUrl.includes('youtube.com/watch')) {
      const urlParts = item.titleUrl.split('?');
      if (urlParts.length < 2) return;
      const urlParams = new URLSearchParams(urlParts[1]);
      const videoId = urlParams.get('v');
      if (!videoId) return;

      let title = item.title || 'Unknown Video';
      if (title.startsWith('Watched ')) {
        title = title.substring(8);
      }

      let channel = 'Unknown Channel';
      if (item.subtitles && item.subtitles.length > 0 && item.subtitles[0].name) {
        channel = item.subtitles[0].name;
      } else if (item.details && item.details.length > 0 && item.details[0].name) {
        channel = item.details[0].name;
      }

      const isAd = (item.details && item.details.length > 0 && item.details[0].name === 'From Google Ads') || (channel === 'From Google Ads');
      const timestamp = item.time ? new Date(item.time).getTime() : Date.now();
      if (isNaN(timestamp)) return;

      if (!watches[videoId]) watches[videoId] = [];
      watches[videoId].push(timestamp);

      if (!metadata[videoId]) {
        metadata[videoId] = {
          title,
          channel,
          duration: '',
          isAd
        };
      }
    }
  });

  // Sort timestamps
  Object.keys(watches).forEach(videoId => {
    watches[videoId].sort((a, b) => a - b);
  });

  return { watches, metadata };
}

// UI Event Listeners binding
function setupEventListeners() {
  // Load Demo Data
  document.getElementById('btn-load-demo').addEventListener('click', () => {
    watchHistory = demoWatchHistory;
    localStorage.setItem('yt_tracker_db', JSON.stringify(watchHistory));
    showToast('Loaded demo watch history data.');
    showDashboard();
    processLogEvents();
    renderAll();
  });

  // Clear Data
  document.getElementById('btn-clear-data').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear your loaded watch history? This will reset the app.')) {
      localStorage.clear();
      watchHistory = { watches: {}, metadata: {} };
      allLogEvents = [];
      ignoredVideoIds = [];
      showImportScreen();
      showToast('Database cleared.');
    }
  });

  // Highlight Top focus toggle
  const focusBtn = document.getElementById('btn-focus-top');
  focusBtn.addEventListener('click', () => {
    focusTopVideos = !focusTopVideos;
    if (focusTopVideos) {
      focusBtn.classList.add('active-toggle');
    } else {
      focusBtn.classList.remove('active-toggle');
    }
    saveState();
    renderHeatmap();
  });

  // Calendar type toggle
  document.getElementById('yt-calendar-type-select').addEventListener('change', (e) => {
    calendarType = e.target.value;
    saveState();
    renderHeatmap();
  });

  // Stats collapsible minimise button
  const minimizeBtn = document.getElementById('btn-minimize-stats');
  minimizeBtn.addEventListener('click', () => {
    statsMinimized = !statsMinimized;
    const content = document.getElementById('stats-collapsible-content');
    if (statsMinimized) {
      content.classList.add('hidden');
      minimizeBtn.textContent = '+';
    } else {
      content.classList.remove('hidden');
      minimizeBtn.textContent = '−';
    }
    saveState();
  });

  // Toggle Ads rankings view
  document.getElementById('btn-toggle-ads-view').addEventListener('click', () => {
    showAdsView = !showAdsView;
    const titleEl = document.getElementById('stats-section-title');
    const videosList = document.getElementById('top-videos-list');
    const adsList = document.getElementById('top-ads-list');

    if (showAdsView) {
      titleEl.textContent = 'Top Serviced Advertisements';
      videosList.classList.add('hidden');
      adsList.classList.remove('hidden');
      document.getElementById('btn-toggle-stats-mode').classList.add('hidden');
    } else {
      titleEl.textContent = 'Top Rewatched Videos';
      videosList.classList.remove('hidden');
      adsList.classList.add('hidden');
      document.getElementById('btn-toggle-stats-mode').classList.remove('hidden');
    }
    renderTopVideos();
    renderTopAds();
  });

  // Toggle stats mode (count / ratio)
  const modeBtn = document.getElementById('btn-toggle-stats-mode');
  modeBtn.addEventListener('click', () => {
    statsRankingMode = statsRankingMode === 'count' ? 'ratio' : 'count';
    const titleEl = document.getElementById('stats-section-title');
    if (statsRankingMode === 'ratio') {
      modeBtn.textContent = 'Show Count';
      titleEl.textContent = 'Top Rewatched to duration ratio Videos';
    } else {
      modeBtn.textContent = 'Show Ratio';
      titleEl.textContent = 'Top Rewatched Videos';
    }
    saveState();
    renderTopVideos();
  });

  // Stats Criteria inputs
  document.getElementById('stats-limit-input').addEventListener('change', (e) => {
    let val = parseInt(e.target.value) || 10;
    if (val < 1) val = 1;
    if (val > 200) val = 200;
    e.target.value = val;
    statsLimit = val;
    saveState();
    renderTopVideos();
    renderTopAds();
  });

  document.getElementById('stats-min-watches').addEventListener('change', (e) => {
    statsMinWatches = Math.max(1, parseInt(e.target.value) || 2);
    saveState();
    renderTopVideos();
  });

  document.getElementById('stats-min-span').addEventListener('change', (e) => {
    statsMinSpan = Math.max(0, parseInt(e.target.value) || 0);
    saveState();
    renderTopVideos();
  });

  // Timeframe selector
  document.getElementById('stats-timeframe-select').addEventListener('change', (e) => {
    statsTimeframe = e.target.value;
    const customRow = document.getElementById('stats-custom-date-row');
    if (statsTimeframe === 'custom') {
      customRow.classList.remove('hidden');
    } else {
      customRow.classList.add('hidden');
    }
    saveState();
    renderTopVideos();
    renderTopAds();
  });

  document.getElementById('stats-start-date').addEventListener('change', (e) => {
    statsStartDate = e.target.value;
    saveState();
    renderTopVideos();
    renderTopAds();
  });

  document.getElementById('stats-end-date').addEventListener('change', (e) => {
    statsEndDate = e.target.value;
    saveState();
    renderTopVideos();
    renderTopAds();
  });

  // Thumbnails & embeds checks
  document.getElementById('chk-thumbnails').addEventListener('change', (e) => {
    showThumbnails = e.target.checked;
    saveState();
    renderTopVideos();
    renderTopAds();
    renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
  });

  document.getElementById('chk-embeds').addEventListener('change', (e) => {
    embedPlayer = e.target.checked;
    const zoomCtrl = document.getElementById('history-zoom-control');
    if (embedPlayer) {
      zoomCtrl.classList.remove('hidden');
    } else {
      zoomCtrl.classList.add('hidden');
    }
    saveState();
    renderTopVideos();
    renderTopAds();
    renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
  });

  // Zoom control
  const zoomSlider = document.getElementById('history-zoom-slider');
  zoomSlider.addEventListener('input', (e) => {
    historyZoom = parseFloat(e.target.value);
    document.body.style.setProperty('--zoom-scale', historyZoom);
    saveState();
  });

  // Stats search filter
  document.getElementById('stats-search-input').addEventListener('input', () => {
    renderTopVideos();
    renderTopAds();
    renderHeatmap();
  });

  // Main watch logs search
  document.getElementById('search-input').addEventListener('input', () => {
    currentVisibleCount = 50;
    renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
  });

  // Duration select filter
  document.getElementById('duration-filter-select').addEventListener('change', () => {
    currentVisibleCount = 50;
    renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
  });

  // Pagination Load More
  document.getElementById('btn-load-more').addEventListener('click', () => {
    currentVisibleCount += 50;
    renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
  });
}

// Restore saved settings values into controls
function renderAll() {
  // Update state toggles
  if (focusTopVideos) {
    document.getElementById('btn-focus-top').classList.add('active-toggle');
  }
  document.getElementById('yt-calendar-type-select').value = calendarType;
  
  if (statsMinimized) {
    document.getElementById('stats-collapsible-content').classList.add('hidden');
    document.getElementById('btn-minimize-stats').textContent = '+';
  }
  
  document.getElementById('stats-limit-input').value = statsLimit;
  document.getElementById('stats-min-watches').value = statsMinWatches;
  document.getElementById('stats-min-span').value = statsMinSpan;
  document.getElementById('stats-timeframe-select').value = statsTimeframe;
  
  if (statsTimeframe === 'custom') {
    document.getElementById('stats-custom-date-row').classList.remove('hidden');
  }
  document.getElementById('stats-start-date').value = statsStartDate;
  document.getElementById('stats-end-date').value = statsEndDate;
  
  document.getElementById('chk-thumbnails').checked = showThumbnails;
  document.getElementById('chk-embeds').checked = embedPlayer;
  
  if (embedPlayer) {
    document.getElementById('history-zoom-control').classList.remove('hidden');
  }
  
  const zoomSlider = document.getElementById('history-zoom-slider');
  zoomSlider.value = historyZoom;
  document.body.style.setProperty('--zoom-scale', historyZoom);

  // Render content
  renderHeatmap();
  renderTopVideos();
  renderTopAds();
  
  currentVisibleCount = 50;
  renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
}

// Advanced search query logic (Boolean logic, regex, negation, phrases)
function matchSearchQuery(title, channel, queryStr) {
  if (!queryStr) return true;
  
  title = title.toLowerCase();
  channel = channel.toLowerCase();
  
  // 1. RegExp: /pattern/
  if (queryStr.startsWith('/') && queryStr.endsWith('/') && queryStr.length > 2) {
    try {
      const pattern = queryStr.slice(1, -1);
      const regex = new RegExp(pattern, 'i');
      return regex.test(title) || regex.test(channel);
    } catch (e) {}
  }
  
  // 2. Exact quotes phrase: "phrase"
  if (queryStr.startsWith('"') && queryStr.endsWith('"') && queryStr.length > 2) {
    const phrase = queryStr.slice(1, -1).toLowerCase();
    return title.includes(phrase) || channel.includes(phrase);
  }
  
  // 3. AND / OR / NOT parsing
  const orBlocks = queryStr.split(/\s+OR\s+/i);
  return orBlocks.some(block => {
    const terms = block.split(/\s+/);
    return terms.every(term => {
      if (term.startsWith('-')) {
        const negTerm = term.slice(1).toLowerCase();
        if (!negTerm) return true;
        return !title.includes(negTerm) && !channel.includes(negTerm);
      } else {
        const posTerm = term.toLowerCase();
        return title.includes(posTerm) || channel.includes(posTerm);
      }
    });
  });
}

// Helper to check if a watch timestamp satisfies the selected stats date/timeframe constraints
function isTimestampInTimeframe(ts) {
  if (statsTimeframe === 'all') return true;

  const date = new Date(ts);
  const now = new Date();

  if (statsTimeframe === 'custom') {
    if (statsStartDate) {
      const start = new Date(statsStartDate + 'T00:00:00');
      if (date < start) return false;
    }
    if (statsEndDate) {
      const end = new Date(statsEndDate + 'T23:59:59');
      if (date > end) return false;
    }
    return true;
  }

  const days = parseInt(statsTimeframe);
  const limitDate = new Date();
  limitDate.setDate(now.getDate() - days);
  return date >= limitDate;
}

// Helper to filter videos currently visible in repeat rankings list (inherits timeframe and search)
function getFilteredTopVideoIds() {
  const { watches, metadata } = watchHistory;
  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const videoStats = [];
  Object.keys(watches || {}).forEach((videoId) => {
    if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
    if (meta.isAd) return;

    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) return;

    const timestamps = (watches[videoId] || []).filter(isTimestampInTimeframe);
    if (timestamps.length === 0) return;

    // Filter count thresholds
    if (timestamps.length < statsMinWatches) return;

    // Filter min span threshold
    if (statsMinSpan > 0 && timestamps.length > 1) {
      const sortedTs = [...timestamps].sort((a, b) => a - b);
      const spanDays = (sortedTs[sortedTs.length - 1] - sortedTs[0]) / (1000 * 60 * 60 * 24);
      if (spanDays < statsMinSpan) return;
    }

    videoStats.push({ videoId, count: timestamps.length });
  });

  videoStats.sort((a, b) => b.count - a.count);
  return videoStats.slice(0, statsLimit).map(v => v.videoId);
}

// Render the scrollable vertical monthly calendar
function renderHeatmap(selectedYear = currentSelectedYear) {
  const containerEl = document.getElementById('yt-calendar-vertical-list');
  if (!containerEl) return;
  containerEl.innerHTML = '';
  
  const topVideoIds = focusTopVideos ? getFilteredTopVideoIds() : null;
  
  // Group watches
  const watchedDates = {};
  allLogEvents.forEach((event) => {
    const isShort = event.channel === 'YouTube Shorts' || event.channel === 'Shorts';
    if (calendarType === 'videos' && isShort) return;
    if (calendarType === 'shorts' && !isShort) return;

    if (focusTopVideos && topVideoIds && !topVideoIds.includes(event.videoId)) return;

    const dateStr = getLocalDateString(new Date(event.timestamp));
    if (!watchedDates[dateStr]) watchedDates[dateStr] = [];
    watchedDates[dateStr].push(event);
  });

  // Calculate max watch count in a single day
  let maxCount = 1;
  Object.keys(watchedDates).forEach((dateStr) => {
    if (dateStr.startsWith(`${selectedYear}-`)) {
      maxCount = Math.max(maxCount, watchedDates[dateStr].length);
    }
  });

  // Loop 12 months in selectedYear
  for (let month = 0; month <= 11; month++) {
    const targetDate = new Date(selectedYear, month, 1);
    const year = selectedYear;
    
    const monthBlock = document.createElement('div');
    monthBlock.className = 'yt-calendar-month-block';
    
    const monthHeader = document.createElement('div');
    monthHeader.className = 'yt-calendar-month-name';
    monthHeader.textContent = targetDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    monthBlock.appendChild(monthHeader);
    
    const weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'yt-calendar-weekdays-row';
    const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    weekdays.forEach(day => {
      const daySpan = document.createElement('span');
      daySpan.textContent = day;
      weekdaysRow.appendChild(daySpan);
    });
    monthBlock.appendChild(weekdaysRow);
    
    const daysGrid = document.createElement('div');
    daysGrid.className = 'yt-calendar-days-grid';
    
    const firstDay = new Date(year, month, 1).getDay();
    for (let offset = 0; offset < firstDay; offset++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'yt-calendar-day-cell offset';
      daysGrid.appendChild(emptyCell);
    }
    
    const totalDays = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= totalDays; day++) {
      const cell = document.createElement('div');
      cell.className = 'yt-calendar-day-cell';
      cell.textContent = day;
      
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const cellDate = new Date(year, month, day);
      const watchesOnDay = watchedDates[dateStr] || [];
      
      if (watchesOnDay.length > 0) {
        cell.classList.add('cell-watched');
        const count = watchesOnDay.length;
        
        const ratio = maxCount > 1 ? (count - 1) / (maxCount - 1) : 0;
        
        // HSL Scheme
        const hue = Math.floor(239 + ratio * 41);
        const alpha = 0.15 + ratio * 0.70;
        const lightness = Math.floor(67 - ratio * 12);
        
        const bgColor = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;
        const borderColor = `hsla(${hue}, 84%, ${lightness - 10}%, ${alpha + 0.2})`;
        const textColor = ratio > 0.5 ? '#ffffff' : '#a5b4fc';
        
        cell.style.background = bgColor;
        cell.style.borderColor = borderColor;
        cell.style.color = textColor;
        
        cell.addEventListener('mouseenter', () => {
          cell.style.background = `hsla(${hue}, 84%, ${lightness - 5}%, ${Math.min(1, alpha + 0.15)})`;
          cell.style.borderColor = `hsla(${hue}, 84%, ${lightness - 15}%, ${Math.min(1, alpha + 0.3)})`;
          cell.style.boxShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, ${Math.min(0.6, alpha + 0.2)})`;
        });
        cell.addEventListener('mouseleave', () => {
          cell.style.background = bgColor;
          cell.style.borderColor = borderColor;
          cell.style.boxShadow = '';
        });
        
        // Tooltip detail popup
        const weekdayName = cellDate.toLocaleDateString(undefined, { weekday: 'long' });
        const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const maxDetails = 5;
        const detailsList = [...watchesOnDay].reverse().map(event => {
          const tStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          const truncatedTitle = event.title.length > 35 ? event.title.substring(0, 32) + '...' : event.title;
          return `• ${tStr} - ${truncatedTitle} (${event.channel})`;
        });
        
        let tooltipText = `${weekdayName}, ${dateFormatted}\nWatched ${count} video(s):\n`;
        if (detailsList.length <= maxDetails) {
          tooltipText += detailsList.join('\n');
        } else {
          tooltipText += detailsList.slice(0, maxDetails).join('\n') + `\n... and ${count - maxDetails} more`;
        }
        
        cell.title = tooltipText;
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => {
          document.getElementById('search-input').value = '';
          renderHistoryList(watchesOnDay, watchesOnDay.length);
          showToast(`Showing ${count} watch(es) for ${dateFormatted}`);
        });
      } else {
        cell.classList.add('cell-empty');
        const weekdayName = cellDate.toLocaleDateString(undefined, { weekday: 'long' });
        const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        cell.title = `${weekdayName}, ${dateFormatted}\nNo watches`;
      }
      
      daysGrid.appendChild(cell);
    }
    
    monthBlock.appendChild(daysGrid);
    containerEl.appendChild(monthBlock);
  }
  
  renderYearSelectorRow();
}

// Render horizontal row of clickable, graded year selector pills
function renderYearSelectorRow() {
  const rowContainer = document.getElementById('yt-calendar-years-row');
  if (!rowContainer) return;
  rowContainer.innerHTML = '';

  const topVideoIds = focusTopVideos ? getFilteredTopVideoIds() : null;

  // Get unique years and their watch counts
  const yearCounts = {};
  const uniqueYears = new Set();
  const thisYear = new Date().getFullYear();
  uniqueYears.add(thisYear);
  yearCounts[thisYear] = 0;

  allLogEvents.forEach((evt) => {
    const isShort = evt.channel === 'YouTube Shorts' || evt.channel === 'Shorts';
    if (calendarType === 'videos' && isShort) return;
    if (calendarType === 'shorts' && !isShort) return;

    if (focusTopVideos && topVideoIds && !topVideoIds.includes(evt.videoId)) return;

    const yr = new Date(evt.timestamp).getFullYear();
    uniqueYears.add(yr);
    yearCounts[yr] = (yearCounts[yr] || 0) + 1;
  });

  // Sort years in ascending sequence (e.g. 2024, 2025, 2026)
  const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);
  const maxYearCount = Math.max(...Object.values(yearCounts), 1);

  sortedYears.forEach((yr) => {
    const count = yearCounts[yr] || 0;
    const ratio = count / maxYearCount;

    const hue = Math.floor(239 + ratio * 41);
    const alpha = 0.15 + ratio * 0.70;
    const lightness = Math.floor(67 - ratio * 12);

    const pill = document.createElement('button');
    pill.className = 'btn';
    pill.style.display = 'flex';
    pill.style.alignItems = 'center';
    pill.style.gap = '4px';
    pill.style.padding = '4px 10px';
    pill.style.fontSize = '10px';
    pill.style.borderRadius = '20px';
    pill.style.margin = '0';
    pill.style.cursor = 'pointer';
    pill.style.transition = 'all 0.2s ease';
    pill.style.background = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;

    if (yr === currentSelectedYear) {
      pill.style.border = '2px solid #fff';
      pill.style.color = '#fff';
      pill.style.fontWeight = 'bold';
      pill.style.boxShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, 0.6)`;
    } else {
      pill.style.border = '1px solid rgba(255, 255, 255, 0.08)';
      pill.style.color = '#a5b4fc';
      pill.style.opacity = '0.75';
      
      pill.addEventListener('mouseenter', () => {
        pill.style.opacity = '1';
        pill.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        pill.style.boxShadow = `0 0 6px hsla(${hue}, 84%, ${lightness}%, 0.3)`;
      });
      pill.addEventListener('mouseleave', () => {
        pill.style.opacity = '0.75';
        pill.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        pill.style.boxShadow = '';
      });
    }

    const yearLabel = document.createElement('span');
    yearLabel.style.fontWeight = '600';
    yearLabel.textContent = yr;
    pill.appendChild(yearLabel);

    const countLabel = document.createElement('span');
    countLabel.style.fontSize = '8px';
    countLabel.style.opacity = '0.75';
    countLabel.textContent = `(${count.toLocaleString()})`;
    pill.appendChild(countLabel);

    pill.addEventListener('click', () => {
      currentSelectedYear = yr;
      const yearSelect = document.getElementById('yt-calendar-year-select');
      if (yearSelect) {
        yearSelect.value = yr;
      }
      saveState();
      renderHeatmap(yr);
    });

    rowContainer.appendChild(pill);
  });
}

// Parse string duration (e.g. 3:32 or 48:16) into total seconds
function parseDurationToSeconds(durationStr) {
  if (!durationStr) return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) {
    // mm:ss
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // hh:mm:ss
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

// Render Top Rewatched Videos list
function renderTopVideos() {
  const listEl = document.getElementById('top-videos-list');
  if (!listEl || showAdsView) return;
  listEl.innerHTML = '';

  const { watches, metadata } = watchHistory;
  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const videoStats = [];
  Object.keys(watches || {}).forEach((videoId) => {
    if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel', duration: '' };
    if (meta.isAd) return;

    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) return;

    const timestamps = (watches[videoId] || []).filter(isTimestampInTimeframe);
    if (timestamps.length === 0) return;

    if (timestamps.length < statsMinWatches) return;

    if (statsMinSpan > 0 && timestamps.length > 1) {
      const sortedTs = [...timestamps].sort((a, b) => a - b);
      const spanDays = (sortedTs[sortedTs.length - 1] - sortedTs[0]) / (1000 * 60 * 60 * 24);
      if (spanDays < statsMinSpan) return;
    }

    // Determine ranking criteria
    let rankingVal = timestamps.length;
    if (statsRankingMode === 'ratio' && meta.duration) {
      const sec = parseDurationToSeconds(meta.duration);
      if (sec > 0) {
        rankingVal = timestamps.length / (sec / 60); // watches per minute
      }
    }

    videoStats.push({
      videoId,
      title: meta.title,
      channel: meta.channel,
      duration: meta.duration || '',
      timestamps,
      rankingVal
    });
  });

  videoStats.sort((a, b) => b.rankingVal - a.rankingVal);
  const itemsToRender = videoStats.slice(0, statsLimit);

  if (itemsToRender.length === 0) {
    listEl.innerHTML = '<li style="font-size:11px; color:var(--text-muted); text-align:center; padding:20px;">No video stats available matching criteria.</li>';
    return;
  }

  itemsToRender.forEach((item, index) => {
    const li = document.createElement('li');
    
    let mediaHtml = '';
    if (showThumbnails) {
      if (embedPlayer) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${item.videoId}?rel=0&modestbranding=1" frameborder="0" allow="encrypted-media" allowfullscreen style="border:none;"></iframe>
          </div>
        `;
      } else {
        const thumb = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <img src="${thumb}" style="width:100%; height:100%; object-fit:cover;" alt="thumb">
          </div>
        `;
      }
    }

    const firstDate = new Date(item.timestamps[0]);
    const lastDate = new Date(item.timestamps[item.timestamps.length - 1]);
    const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    let metricText = `${item.timestamps.length} watch(es)`;
    if (statsRankingMode === 'ratio') {
      metricText = `${item.rankingVal.toFixed(3)} ratio`;
    }

    li.innerHTML = `
      <span class="stats-rank">#${index + 1}</span>
      ${mediaHtml}
      <div class="stats-video-info">
        <div class="stats-video-title" title="${item.title}">${item.title}</div>
        <div class="stats-video-channel">${item.channel} ${item.duration ? `• ${item.duration}` : ''}</div>
        <div class="stats-last-seen">Span: ${firstStr} - ${lastStr}</div>
      </div>
      <span class="stats-count">${metricText}</span>
    `;

    // Make row clickable to filter history list by this video
    li.style.cursor = 'pointer';
    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'IFRAME') return;
      document.getElementById('search-input').value = `"${item.title.replace(/"/g, '')}"`;
      currentVisibleCount = 50;
      renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
      showToast(`Filtering for: "${item.title.substring(0, 20)}..."`);
    });

    listEl.appendChild(li);
  });
}

// Render Top Ads list
function renderTopAds() {
  const listEl = document.getElementById('top-ads-list');
  if (!listEl || !showAdsView) return;
  listEl.innerHTML = '';

  const { watches, metadata } = watchHistory;
  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const adStats = [];
  Object.keys(watches || {}).forEach((videoId) => {
    if (videoId.startsWith('search:')) return;
    const meta = metadata[videoId] || { title: 'Unknown Item', channel: 'Google Ads' };
    if (!meta.isAd && !videoId.startsWith('visit:')) return;

    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) return;

    const timestamps = (watches[videoId] || []).filter(isTimestampInTimeframe);
    if (timestamps.length === 0) return;

    adStats.push({
      videoId,
      title: meta.title,
      channel: meta.channel,
      timestamps,
      count: timestamps.length
    });
  });

  adStats.sort((a, b) => b.count - a.count);
  const itemsToRender = adStats.slice(0, statsLimit);

  if (itemsToRender.length === 0) {
    listEl.innerHTML = '<li style="font-size:11px; color:var(--text-muted); text-align:center; padding:20px;">No advertisement logs found.</li>';
    return;
  }

  itemsToRender.forEach((item, index) => {
    const li = document.createElement('li');
    
    let mediaHtml = '';
    const isNormalVideo = !item.videoId.startsWith('visit:');
    if (showThumbnails && isNormalVideo) {
      if (embedPlayer) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${item.videoId}?rel=0&modestbranding=1" frameborder="0" allow="encrypted-media" style="border:none;"></iframe>
          </div>
        `;
      } else {
        const thumb = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <img src="${thumb}" style="width:100%; height:100%; object-fit:cover;" alt="thumb">
          </div>
        `;
      }
    }

    const firstDate = new Date(item.timestamps[0]);
    const lastDate = new Date(item.timestamps[item.timestamps.length - 1]);
    const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    li.innerHTML = `
      <span class="stats-rank">#${index + 1}</span>
      ${mediaHtml}
      <div class="stats-video-info">
        <div class="stats-video-title" title="${item.title}">${item.title}</div>
        <div class="stats-video-channel">${item.channel}</div>
        <div class="stats-last-seen">Span: ${firstStr} - ${lastStr}</div>
      </div>
      <span class="stats-count">${item.count} views</span>
    `;

    li.style.cursor = 'pointer';
    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'IFRAME') return;
      document.getElementById('search-input').value = `"${item.title.replace(/"/g, '')}"`;
      currentVisibleCount = 50;
      renderHistoryList(getCurrentFilteredEvents(), currentVisibleCount);
    });

    listEl.appendChild(li);
  });
}

// Get current filtered list of watch events
function getCurrentFilteredEvents() {
  const searchInput = document.getElementById('search-input');
  const query = (searchInput ? searchInput.value : '').trim();
  const durFilter = document.getElementById('duration-filter-select').value;

  return allLogEvents.filter(event => {
    // 1. Search Query
    if (query && !matchSearchQuery(event.title, event.channel, query)) return false;

    // 2. Duration Filter
    if (durFilter !== 'all') {
      const sec = parseDurationToSeconds(event.duration);
      if (durFilter === 'short') {
        if (sec === 0 || sec >= 240) return false;
      } else if (durFilter === 'medium') {
        if (sec < 240 || sec > 1200) return false;
      } else if (durFilter === 'long') {
        if (sec < 1200) return false;
      }
    }

    return true;
  });
}

// Render watch history logs list with pagination
function renderHistoryList(events, limit = 50) {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const itemsToRender = events.slice(0, limit);

  if (itemsToRender.length === 0) {
    listEl.innerHTML = '<li style="font-size:12px; color:var(--text-muted); text-align:center; padding:30px;">No watch history events found.</li>';
    document.getElementById('btn-load-more').classList.add('hidden');
    return;
  }

  itemsToRender.forEach(event => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const date = new Date(event.timestamp);
    const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    let mediaHtml = '';
    const isNormalVideo = !event.videoId.startsWith('search:') && !event.videoId.startsWith('visit:');
    if (showThumbnails && isNormalVideo) {
      if (embedPlayer) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${event.videoId}?rel=0&modestbranding=1" frameborder="0" allow="encrypted-media" style="border:none;"></iframe>
          </div>
        `;
      } else {
        const thumb = `https://i.ytimg.com/vi/${event.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink:0; margin-right:8px; border-radius:4px; overflow:hidden;">
            <img src="${thumb}" style="width:100%; height:100%; object-fit:cover;" alt="thumb">
          </div>
        `;
      }
    }

    const typeStr = getEventTypeClass(event);
    const isSearch = event.videoId.startsWith('search:');
    let titleHtml = event.title;
    if (isNormalVideo) {
      titleHtml = `<a href="https://www.youtube.com/watch?v=${event.videoId}" target="_blank" style="color:var(--text-primary); text-decoration:none; font-weight:500;">${event.title}</a>`;
    } else if (isSearch) {
      const query = decodeURIComponent(event.videoId.substring(7));
      titleHtml = `Searched: <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(query)}" target="_blank" style="color:var(--text-primary); text-decoration:none; font-weight:500;">${query}</a>`;
    }

    li.innerHTML = `
      ${mediaHtml}
      <div class="history-info">
        <div class="history-title">${titleHtml}</div>
        <div class="history-meta">
          <span class="history-tag ${typeStr}">${event.channel}</span>
          ${event.duration ? `<span>Duration: ${event.duration}</span>` : ''}
        </div>
      </div>
      <div class="history-time">
        <div>${timeStr}</div>
        <div style="font-size:8px; color:var(--text-muted);">${dateStr}</div>
      </div>
    `;

    listEl.appendChild(li);
  });

  const loadMoreBtn = document.getElementById('btn-load-more');
  if (events.length > limit) {
    loadMoreBtn.classList.remove('hidden');
    loadMoreBtn.textContent = `Load More (+${Math.min(events.length - limit, 50)})`;
  } else {
    loadMoreBtn.classList.add('hidden');
  }
}

// Helpers for list styling and type mapping
function getEventTypeClass(event) {
  if (event.videoId.startsWith('search:')) return 'type-search';
  if (event.videoId.startsWith('visit:')) return 'type-ad';
  if (event.isAd) return 'type-ad';
  return 'type-video';
}

function getLocalDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Toast helper
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.style.opacity = '1';
  
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2500);
}
