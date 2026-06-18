// content/content.js

var currentVideoId = null;
var watchTimer = null;
var adCheckInterval = null;
var currentVideoHistory = [];
const WATCH_CONFIRMATION_TIME = 10000; // 10 seconds in ms

// Direct history sync globals
var isSyncing = false;
var isBackgroundSync = false;
var syncOverlay = null;
var syncedVideosCount = 0;
var lastScrollHeight = 0;
var scrollFails = 0;
var initialWaitTicks = 0;
const MAX_SCROLL_FAILS = 12; // Stop after ~18s of no new elements loading
const SCROLL_INTERVAL_MS = 1500;
var parsedHistoryData = [];
var sessionHistorySequence = {};

// Initialize script
function init() {
  // Listen for navigation finish event fired by YouTube SPA
  window.addEventListener('yt-navigate-finish', handleNavigation);
  
  // Listen for messages from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'urlChanged') {
      handleNavigation();
    }
  });

  // Initial call in case script is loaded directly
  handleNavigation();
}

// Handler for page transitions
function handleNavigation() {
  const isHistoryPage = window.location.pathname === '/feed/history';
  
  if (isHistoryPage) {
    removeInjectedButton();
    clearWatchTimer();
    currentVideoId = null;
    
    // Inject the floating sync button
    injectFloatingSyncButton();
    
    // If URL contains sync=true, trigger sync automatically
    if (window.location.search.includes('sync=true')) {
      // Remove the sync=true query param so it doesn't auto-sync again if they refresh
      const url = new URL(window.location.href);
      url.searchParams.delete('sync');
      url.searchParams.delete('background');
      window.history.replaceState({}, '', url.toString());
      
      startDirectSync(false);
    }
    return;
  }

  // Remove floating button if not on history page
  removeFloatingSyncButton();

  const videoId = getYouTubeVideoId();
  
  if (!videoId) {
    // Not on a video watch page, clean up
    clearWatchTimer();
    currentVideoId = null;
    removeInjectedButton();
    return;
  }

  if (videoId === currentVideoId) {
    // Same video, don't restart tracking unless initialized first time
    if (!document.getElementById('yt-watch-tracker-btn')) {
      fetchHistoryAndInjectButton(videoId);
    }
    return;
  }

  // New video detected!
  clearWatchTimer();
  currentVideoId = videoId;
  removeInjectedButton();
  
  // Start countdown to record watch
  startWatchTimer(videoId);
  
  // Fetch existing history to show counts immediately on the button
  fetchHistoryAndInjectButton(videoId);
}

// Extract Video ID from URL (including Shorts path)
function getYouTubeVideoId() {
  if (window.location.pathname.startsWith('/shorts/')) {
    const parts = window.location.pathname.split('/shorts/');
    if (parts.length > 1) {
      return parts[1].split('/')[0];
    }
  }
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v');
}

// Check if an ad is currently playing on the page
function isAdPlaying() {
  const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
    return true;
  }
  // Fallback checks for various ad indicator elements
  const adOverlay = document.querySelector('.ytp-ad-player-overlay') || 
                    document.querySelector('.video-ads') || 
                    document.querySelector('.ytp-ad-image-overlay') ||
                    document.querySelector('.ytp-ad-text-overlay') ||
                    document.querySelector('.ytp-ad-skip-button-slot');
  if (adOverlay && adOverlay.childNodes.length > 0) {
    return true;
  }
  return false;
}

// Start timer for watch confirmation
function startWatchTimer(videoId) {
  clearWatchTimer();

  // If an ad is currently playing, poll every 1 second until it finishes
  if (isAdPlaying()) {
    console.log(`[Watch Tracker] Ad detected. Waiting for ad to finish before starting watch timer for: ${videoId}`);
    adCheckInterval = setInterval(() => {
      if (!isAdPlaying()) {
        clearInterval(adCheckInterval);
        adCheckInterval = null;
        console.log(`[Watch Tracker] Ad finished. Commencing watch timer for: ${videoId}`);
        triggerActualWatchTimer(videoId);
      }
    }, 1000);
  } else {
    triggerActualWatchTimer(videoId);
  }
}

// Trigger the actual 10-second confirmation timer
function triggerActualWatchTimer(videoId) {
  watchTimer = setTimeout(async () => {
    // If an ad has started playing in the meantime (e.g. mid-roll), restart wait
    if (isAdPlaying()) {
      console.log(`[Watch Tracker] Ad detected during confirmation period. Restarting wait.`);
      startWatchTimer(videoId);
      return;
    }

    const videoDetails = scrapeVideoDetails();
    if (videoDetails.title && videoDetails.title !== 'Unknown Video') {
      chrome.runtime.sendMessage(
        {
          action: 'recordWatch',
          videoId: videoId,
          title: videoDetails.title,
          channel: videoDetails.channel,
          duration: videoDetails.duration
        },
        (response) => {
          if (response && response.success) {
            console.log(`[Watch Tracker] Logged watch for: ${videoDetails.title}. Total: ${response.watchesCount}`);
            // Refresh history and update the button count
            fetchHistoryAndInjectButton(videoId);
          }
        }
      );
    }
  }, WATCH_CONFIRMATION_TIME);
}

// Clear watch timers and intervals
function clearWatchTimer() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (adCheckInterval) {
    clearInterval(adCheckInterval);
    adCheckInterval = null;
  }
}

// Scrape title, channel, and duration from DOM
function scrapeVideoDetails() {
  let title = '';

  // 1. Try visible DOM elements first (dynamically updated by YouTube SPA)
  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || 
                  document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer') ||
                  document.querySelector('#title h1') ||
                  document.querySelector('h1 a.yt-simple-endpoint');
  if (titleEl) {
    title = (titleEl.getAttribute('title') || titleEl.textContent).trim();
  }

  // 2. Try document.title (frequently updated by YouTube router)
  if (!title || title === 'Unknown Video') {
    if (document.title) {
      title = document.title.replace(' - YouTube', '').trim();
    }
  }

  // 3. Fallback to metadata (static SEO tags) only if DOM elements are missing
  if (!title || title === 'Unknown Video') {
    const metaTitleEl = document.querySelector('meta[name="title"]') || document.querySelector('meta[property="og:title"]');
    if (metaTitleEl) {
      title = metaTitleEl.getAttribute('content');
    }
  }

  // Ensure fallback default if still empty
  if (!title) {
    title = 'Unknown Video';
  }

  let channel = '';

  // 1. Try visible DOM channel elements first (dynamically updated by YouTube SPA)
  const channelEl = document.querySelector('ytd-video-owner-renderer ytd-channel-name a') ||
                    document.querySelector('yt-formatted-string.ytd-channel-name a') ||
                    document.querySelector('#owner #channel-name a') ||
                    document.querySelector('#meta #channel-name a') ||
                    document.querySelector('ytd-video-owner-renderer ytd-channel-name') ||
                    document.querySelector('ytd-video-owner-renderer') ||
                    document.querySelector('#owner #channel-name');
  if (channelEl) {
    const titleAttr = channelEl.getAttribute('title');
    if (titleAttr) {
      channel = titleAttr.trim();
    } else {
      // Split by newline to strip badges / verification info
      channel = channelEl.textContent.trim().split('\n')[0].trim();
    }
  }

  // 2. Special handling for Shorts path
  if ((!channel || channel === 'Unknown Channel') && window.location.pathname.startsWith('/shorts/')) {
    channel = 'YouTube Shorts';
  }

  // 3. Fallback to metadata author link
  if (!channel || channel === 'Unknown Channel') {
    const metaChannelEl = document.querySelector('span[itemprop="author"] link[itemprop="name"]') || 
                          document.querySelector('[itemprop="author"] [itemprop="name"]');
    if (metaChannelEl) {
      channel = metaChannelEl.getAttribute('content');
    }
  }

  // Ensure fallback default if still empty
  if (!channel) {
    channel = 'Unknown Channel';
  }

  const durationEl = document.querySelector('.ytp-time-duration');
  const duration = durationEl ? durationEl.textContent.trim() : '';

  return { title, channel, duration };
}

// Fetch history and inject tracker button
function fetchHistoryAndInjectButton(videoId) {
  chrome.runtime.sendMessage({ action: 'getVideoHistory', videoId }, (response) => {
    if (response && response.success) {
      currentVideoHistory = response.timestamps || [];
      injectTrackerButton(currentVideoHistory.length);
    }
  });
}

// Inject button into the YouTube watch actions area
function injectTrackerButton(count) {
  // Avoid duplicate injection
  let btn = document.getElementById('yt-watch-tracker-btn');
  if (btn) {
    btn.querySelector('.yt-tracker-count').textContent = count;
    return;
  }

  // Find standard action button container
  // YouTube watch metadata container: top-row / actions
  const container = document.querySelector('#owner') || 
                    document.querySelector('#actions-inner') ||
                    document.querySelector('#top-row.ytd-watch-metadata') ||
                    document.querySelector('#top-level-buttons-computed');
                    
  if (!container) {
    // Retry in 1 second if the element isn't rendered yet
    setTimeout(() => {
      if (currentVideoId === getYouTubeVideoId()) {
        injectTrackerButton(count);
      }
    }, 1000);
    return;
  }

  btn = document.createElement('button');
  btn.id = 'yt-watch-tracker-btn';
  btn.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m';
  btn.style.marginLeft = '8px';
  btn.style.display = 'inline-flex';
  btn.style.alignItems = 'center';
  btn.style.gap = '6px';
  
  // Icon: simple history clock svg
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:block;">
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm1-13h-2v6l5.2 3.2.8-1.3-4-2.4V7z"/>
    </svg>
    <span style="font-weight: 500; font-size: 14px;">History (<span class="yt-tracker-count">${count}</span>)</span>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHistoryModal();
  });

  // Insert next to the owner/subscribe elements
  const ownerEl = container.querySelector('#owner') || container;
  if (ownerEl.nextSibling) {
    ownerEl.parentNode.insertBefore(btn, ownerEl.nextSibling);
  } else {
    ownerEl.parentNode.appendChild(btn);
  }
}

// Remove injected button
function removeInjectedButton() {
  const btn = document.getElementById('yt-watch-tracker-btn');
  if (btn) {
    btn.remove();
  }
}

// Open the history calendar modal
function openHistoryModal() {
  // Remove existing modal if any
  closeHistoryModal();

  const details = scrapeVideoDetails();
  const videoId = getYouTubeVideoId();

  const overlay = document.createElement('div');
  overlay.id = 'yt-tracker-modal-overlay';
  
  const modal = document.createElement('div');
  modal.id = 'yt-tracker-modal';
  
  modal.innerHTML = `
    <div class="yt-tracker-modal-header">
      <div class="yt-tracker-modal-title-group">
        <h3>Watch History Calendar</h3>
        <p class="yt-tracker-video-title">${details.title}</p>
        <p class="yt-tracker-video-channel">${details.channel}</p>
      </div>
      <button class="yt-tracker-close-btn">&times;</button>
    </div>
    
    <div class="yt-tracker-modal-body">
      <div class="yt-tracker-summary-row">
        <div class="yt-tracker-stat-box">
          <span class="yt-tracker-stat-value">${currentVideoHistory.length}</span>
          <span class="yt-tracker-stat-label">Total Watches</span>
        </div>
        <div class="yt-tracker-stat-box">
          <span class="yt-tracker-stat-value">${getFormattedLastWatched()}</span>
          <span class="yt-tracker-stat-label">Last Watched</span>
        </div>
      </div>
      
      <div class="yt-tracker-calendar-container">
        <div class="yt-tracker-calendar-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 14px; font-weight: 600; color: #fff;">Watch Calendar</h4>
          <select id="yt-calendar-year-select" style="display: none;"></select>
        </div>
        <div id="yt-calendar-years-row" style="display: flex; gap: 8px; margin: 8px 0 12px 0; align-items: center; justify-content: flex-start; flex-wrap: wrap;"></div>
        <div class="scrollable-calendar">
          <div id="yt-calendar-vertical-list" class="yt-calendar-vertical-list"></div>
        </div>
        <!-- Hour Gradient Legend -->
        <div class="yt-tracker-calendar-legend" style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 8.5px; color: rgba(255, 255, 255, 0.45); font-weight: 500;">
          <span style="flex-shrink: 0;">0h (Midnight)</span>
          <div style="flex-grow: 1; height: 6px; margin: 0 6px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(to right, hsla(240, 85%, 60%, 0.55) 0%, hsla(150, 85%, 60%, 0.55) 50%, hsla(60, 85%, 60%, 0.55) 100%);"></div>
          <span style="flex-shrink: 0;">12h (Noon)</span>
          <div style="flex-grow: 1; height: 6px; margin: 0 6px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(to right, hsla(60, 85%, 60%, 0.55) 0%, hsla(330, 85%, 60%, 0.55) 50%, hsla(240, 85%, 60%, 0.55) 100%);"></div>
          <span style="flex-shrink: 0;">24h</span>
        </div>
      </div>

      <div class="yt-tracker-action-row">
        <button id="yt-tracker-copy-obsidian" class="yt-tracker-action-btn primary">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
          </svg>
          Copy for Obsidian
        </button>
        <button id="yt-tracker-delete-history" class="yt-tracker-action-btn danger">
          Delete History
        </button>
      </div>
      
      <div class="yt-tracker-history-list-section">
        <h4>Detailed History</h4>
        <ul class="yt-tracker-history-list">
          ${renderHistoryList()}
        </ul>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Prevent scroll propagation
  overlay.addEventListener('wheel', (e) => e.stopPropagation());

  // Attach event listeners
  overlay.querySelector('.yt-tracker-close-btn').addEventListener('click', closeHistoryModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHistoryModal();
  });

  // Build Year Select Dropdown options
  const yearSelect = overlay.querySelector('#yt-calendar-year-select');
  const uniqueYears = new Set();
  const currentYear = new Date().getFullYear();
  uniqueYears.add(currentYear);
  currentVideoHistory.forEach(ts => {
    uniqueYears.add(new Date(ts).getFullYear());
  });
  const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);

  sortedYears.forEach(yr => {
    const opt = document.createElement('option');
    opt.value = yr;
    opt.textContent = yr;
    yearSelect.appendChild(opt);
  });

  const renderModalYearSelectorRow = (activeYear) => {
    const rowContainer = overlay.querySelector('#yt-calendar-years-row');
    if (!rowContainer) return;
    rowContainer.innerHTML = '';

    // Calculate watch counts per year for this video
    const yearCounts = {};
    uniqueYears.forEach(yr => { yearCounts[yr] = 0; });
    currentVideoHistory.forEach(ts => {
      const yr = new Date(ts).getFullYear();
      yearCounts[yr] = (yearCounts[yr] || 0) + 1;
    });

    const maxYearCount = Math.max(...Object.values(yearCounts), 1);

    sortedYears.forEach(yr => {
      const count = yearCounts[yr] || 0;
      const ratio = count / maxYearCount;

      // Heat color grading scheme matching the calendar cell colors (using Indigo/Blue to Purple gradient)
      const hue = Math.floor(239 + ratio * 41);
      const alpha = 0.15 + ratio * 0.70;
      const lightness = Math.floor(67 - ratio * 12);

      const pill = document.createElement('button');
      pill.style.background = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;
      pill.style.display = 'flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '4px';
      pill.style.padding = '4px 10px';
      pill.style.fontSize = '10px';
      pill.style.borderRadius = '20px';
      pill.style.margin = '0';
      pill.style.cursor = 'pointer';
      pill.style.transition = 'all 0.2s ease';
      pill.style.color = '#a5b4fc';
      pill.style.outline = 'none';

      if (yr === activeYear) {
        pill.style.border = '2px solid #fff';
        pill.style.color = '#fff';
        pill.style.fontWeight = 'bold';
        pill.style.boxShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, 0.6)`;
      } else {
        pill.style.border = '1px solid rgba(255, 255, 255, 0.08)';
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
        const yearSelect = overlay.querySelector('#yt-calendar-year-select');
        if (yearSelect) {
          yearSelect.value = yr;
        }
        buildCalendarGridForYear(overlay.querySelector('#yt-calendar-vertical-list'), yr);
        renderModalYearSelectorRow(yr);
      });

      rowContainer.appendChild(pill);
    });
  };

  // Default to last watch year or current year
  let defaultYear = currentYear;
  if (currentVideoHistory.length > 0) {
    defaultYear = new Date(currentVideoHistory[currentVideoHistory.length - 1]).getFullYear();
  }
  yearSelect.value = defaultYear;

  // Change listener
  yearSelect.addEventListener('change', (e) => {
    const yr = parseInt(e.target.value);
    buildCalendarGridForYear(overlay.querySelector('#yt-calendar-vertical-list'), yr);
    renderModalYearSelectorRow(yr);
  });

  // Render visual years row
  renderModalYearSelectorRow(defaultYear);

  // Build Calendar Heatmap for default year
  buildCalendarGridForYear(overlay.querySelector('#yt-calendar-vertical-list'), defaultYear);

  // Copy Obsidian Markdown
  overlay.querySelector('#yt-tracker-copy-obsidian').addEventListener('click', () => {
    copyObsidianMarkdown(details);
  });

  // Delete Video History
  overlay.querySelector('#yt-tracker-delete-history').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the watch history for this video? This cannot be undone.')) {
      chrome.runtime.sendMessage({ action: 'clearVideoHistory', videoId }, (response) => {
        if (response && response.success) {
          currentVideoHistory = [];
          closeHistoryModal();
          handleNavigation(); // Redraw UI
        }
      });
    }
  });
}

// Close the history calendar modal
function closeHistoryModal() {
  const overlay = document.getElementById('yt-tracker-modal-overlay');
  if (overlay) {
    overlay.remove();
  }
}

// Helper to format last watch timestamp
function getFormattedLastWatched() {
  if (currentVideoHistory.length === 0) return 'Never';
  const lastTime = currentVideoHistory[currentVideoHistory.length - 1];
  return new Date(lastTime).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// Render watch history log list items
function renderHistoryList() {
  if (currentVideoHistory.length === 0) {
    return `<li class="yt-tracker-empty-list">No watches recorded yet</li>`;
  }
  return [...currentVideoHistory]
    .reverse()
    .map((timestamp) => {
      const d = new Date(timestamp);
      const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return `<li><strong>${dateStr}</strong> at ${timeStr}</li>`;
    })
    .join('');
}

// Render the scrollable vertical monthly calendar for a specific year
function buildCalendarGridForYear(containerEl, selectedYear) {
  containerEl.innerHTML = '';
  
  // Parse all watch dates to local date strings YYYY-MM-DD
  const watchedDates = {};
  currentVideoHistory.forEach((ts) => {
    const d = new Date(ts);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!watchedDates[dateStr]) watchedDates[dateStr] = [];
    watchedDates[dateStr].push(ts);
  });

  // Loop through 12 months of the selected year (January = 0 to December = 11)
  for (let month = 0; month <= 11; month++) {
    const targetDate = new Date(selectedYear, month, 1);
    
    // Month block container
    const monthBlock = document.createElement('div');
    monthBlock.className = 'yt-calendar-month-block';
    
    // Header (e.g. December 2025)
    const monthHeader = document.createElement('div');
    monthHeader.className = 'yt-calendar-month-name';
    monthHeader.textContent = targetDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    monthBlock.appendChild(monthHeader);
    
    // Weekday headers Su Mo Tu We Th Fr Sa
    const weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'yt-calendar-weekdays-row';
    const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    weekdays.forEach(day => {
      const daySpan = document.createElement('span');
      daySpan.textContent = day;
      weekdaysRow.appendChild(daySpan);
    });
    monthBlock.appendChild(weekdaysRow);
    
    // Grid of days
    const daysGrid = document.createElement('div');
    daysGrid.className = 'yt-calendar-days-grid';
    
    // Day offsets for the first day of the month
    const firstDay = new Date(selectedYear, month, 1).getDay(); // 0 = Sunday, 1 = Monday...
    for (let offset = 0; offset < firstDay; offset++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'yt-calendar-day-cell offset';
      daysGrid.appendChild(emptyCell);
    }
    
    // Total days in month
    const totalDays = new Date(selectedYear, month + 1, 0).getDate();
    for (let day = 1; day <= totalDays; day++) {
      const cell = document.createElement('div');
      cell.className = 'yt-calendar-day-cell';
      cell.textContent = day;
      
      const dateStr = `${selectedYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const cellDate = new Date(selectedYear, month, day);
      const watchesOnDay = watchedDates[dateStr] || [];
      
      if (watchesOnDay.length > 0) {
        cell.classList.add('cell-watched');
        const count = watchesOnDay.length;
        
        // Extract hour of day for each watch (0 to 23.99)
        const hours = watchesOnDay.map(ts => {
          const d = new Date(ts);
          return d.getHours() + d.getMinutes() / 60;
        }).sort((a, b) => a - b);
        
        // Helper function for HSL color based on hour (cyclical: midnight=240, noon=60, twilight=330)
        const getColorForHour = (hour, a = 0.55, l = 60) => {
          const h = Math.floor(((240 - (hour / 24) * 360) + 360) % 360);
          return `hsla(${h}, 85%, ${l}%, ${a})`;
        };

        let bgColor = '';
        let borderColor = '';
        let hoverBgColor = '';
        let hoverBorderColor = '';
        let shadowColor = '';

        if (hours.length === 1) {
          bgColor = getColorForHour(hours[0], 0.55, 60);
          borderColor = getColorForHour(hours[0], 0.75, 70);
          hoverBgColor = getColorForHour(hours[0], 0.75, 55);
          hoverBorderColor = getColorForHour(hours[0], 0.95, 80);
          shadowColor = getColorForHour(hours[0], 0.6, 65);
        } else {
          const colorsBg = hours.map(h => getColorForHour(h, 0.55, 60));
          const colorsHover = hours.map(h => getColorForHour(h, 0.75, 55));
          bgColor = `linear-gradient(135deg, ${colorsBg.join(', ')})`;
          hoverBgColor = `linear-gradient(135deg, ${colorsHover.join(', ')})`;
          
          const avgHour = hours.reduce((sum, h) => sum + h, 0) / hours.length;
          borderColor = getColorForHour(avgHour, 0.75, 70);
          hoverBorderColor = getColorForHour(avgHour, 0.95, 80);
          shadowColor = getColorForHour(avgHour, 0.6, 65);
        }

        cell.style.background = bgColor;
        cell.style.borderColor = borderColor;
        cell.style.color = '#ffffff';
        
        cell.addEventListener('mouseenter', () => {
          cell.style.background = hoverBgColor;
          cell.style.borderColor = hoverBorderColor;
          cell.style.boxShadow = `0 0 10px ${shadowColor}`;
        });
        cell.addEventListener('mouseleave', () => {
          cell.style.background = bgColor;
          cell.style.borderColor = borderColor;
          cell.style.boxShadow = '';
        });
        
        // Detailed tooltip with watch times and weekday
        const weekdayName = cellDate.toLocaleDateString(undefined, { weekday: 'long' });
        const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const timesList = watchesOnDay.map(ts => {
          return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }).join(', ');
        
        cell.title = `${weekdayName}, ${dateFormatted}\nWatched ${count} time(s) at: ${timesList}`;
      } else {
        cell.classList.add('cell-empty');
        const weekdayName = cellDate.toLocaleDateString(undefined, { weekday: 'long' });
        const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        cell.title = `${weekdayName}, ${dateFormatted}`;
      }
      
      daysGrid.appendChild(cell);
    }
    
    monthBlock.appendChild(daysGrid);
    containerEl.appendChild(monthBlock);
  }
}

// Copy Obsidian Markdown to clipboard
function copyObsidianMarkdown(details) {
  const videoUrl = `https://www.youtube.com/watch?v=${getYouTubeVideoId()}`;
  const now = new Date();
  const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  
  // Format matching common Obsidian daily log structures
  const markdown = `- [ ] [${details.title}](${videoUrl}) - ${details.channel} (watched at ${timeStr} on [[${dateStr}]])`;
  
  navigator.clipboard.writeText(markdown).then(() => {
    const copyBtn = document.getElementById('yt-tracker-copy-obsidian');
    const originalText = copyBtn.innerHTML;
    copyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
      Copied!
    `;
    copyBtn.classList.add('success');
    
    setTimeout(() => {
      copyBtn.innerHTML = originalText;
      copyBtn.classList.remove('success');
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy markdown: ', err);
  });
}

// Run initial execution
init();

// ==========================================
// DIRECT HISTORY SYNC SCRAPER ENGINE
// ==========================================

// Helper mapping YouTube date texts to standard Date objects
function parseYouTubeHistoryDate(text) {
  const cleaned = text.trim().toLowerCase();
  if (cleaned === 'today') {
    return new Date();
  }
  if (cleaned === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }
  
  // Check relative text like "3 days ago", "2 weeks ago"
  const relativeMatch = cleaned.match(/(\d+)\s+(day|week|month|year)s?\s+ago/);
  if (relativeMatch) {
    const val = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    const d = new Date();
    if (unit === 'day') d.setDate(d.getDate() - val);
    else if (unit === 'week') d.setDate(d.getDate() - val * 7);
    else if (unit === 'month') d.setMonth(d.getMonth() - val);
    else if (unit === 'year') d.setFullYear(d.getFullYear() - val);
    return d;
  }

  // Standard dates: e.g. "May 30, 2026"
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  return null;
}

// Helper to align visible DOM sequence with our running sequence for virtualization resilience
function alignSequence(visibleIds, runningSequence) {
  let bestOffset = 0;
  let maxMatch = -1;
  
  for (let k = 0; k <= runningSequence.length; k++) {
    let matchCount = 0;
    let mismatch = false;
    for (let i = 0; i < visibleIds.length; i++) {
      if (k + i < runningSequence.length) {
        if (visibleIds[i] === runningSequence[k + i]) {
          matchCount++;
        } else {
          mismatch = true;
          break;
        }
      }
    }
    if (!mismatch && matchCount > maxMatch) {
      maxMatch = matchCount;
      bestOffset = k;
    }
  }
  return bestOffset;
}

// Scrapes loaded items on youtube.com/feed/history
function scrapeHistoryPageElements() {
  const parsedRecords = [];
  
  // Look only inside the primary content area to avoid suggested sidebar video elements
  const mainArea = document.querySelector('#primary') || 
                   document.querySelector('#contents') || 
                   document.querySelector('ytd-browse[page-subtype="history"]') || 
                   document.body;

  // Query all link elements pointing to video items
  const videoLinks = mainArea.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
  
  let lastSectionElement = null;
  let lastParsedDate = new Date();
  let sectionsProcessedCount = 0;
  
  const processedContainers = new Set();
  const visibleItems = []; // Array of { videoId, title, channel, dateStr }
  
  videoLinks.forEach((link) => {
    const href = link.getAttribute('href');
    if (!href) return;
    
    // Parse videoId from href
    let videoId = null;
    if (href.includes('/shorts/')) {
      const parts = href.split('/shorts/');
      if (parts.length > 1) {
        videoId = parts[1].split('?')[0].split('/')[0];
      }
    } else if (href.includes('?v=')) {
      const urlParams = new URLSearchParams(href.split('?')[1]);
      videoId = urlParams.get('v');
    }
    
    if (!videoId) return;
    
    // Find the item container. This handles different list card tags.
    const container = link.closest('ytd-video-renderer, ytd-reel-item-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer') || link;
    
    // Skip if we already processed this card container
    if (processedContainers.has(container)) return;
    processedContainers.add(container);
    
    // 1. Extract title text from the container (exclude thumbnail links to avoid getting duration/overlay text)
    const titleEl = container.querySelector('a[href*="/watch?v="]:not(#thumbnail), a[href*="/shorts/"]:not(#thumbnail)') ||
                    container.querySelector('#video-title') || 
                    container.querySelector('#video-title-text') ||
                    container.querySelector('h3') ||
                    container.querySelector('.title') ||
                    (container.tagName.toLowerCase() === 'a' ? container : null);
                    
    let title = 'Unknown Video';
    if (titleEl) {
      title = titleEl.getAttribute('title') || titleEl.textContent.trim();
    }
    
    // If the title is still a timestamp, "SHORTS", or empty, try alternative elements
    if (!title || title === 'Unknown Video' || /^\d+:\d+$/.test(title) || /^\d+:\d+:\d+$/.test(title) || title.toUpperCase() === 'SHORTS') {
      const alternativeEl = container.querySelector('#video-title') || container.querySelector('h3');
      if (alternativeEl) {
        title = alternativeEl.getAttribute('title') || alternativeEl.textContent.trim();
      }
    }
    
    // Final check to filter out duration/shorts text
    if (!title || title === 'Unknown Video' || /^\d+:\d+$/.test(title) || /^\d+:\d+:\d+$/.test(title) || title.toUpperCase() === 'SHORTS') {
      return;
    }
    
    // 2. Extract channel name from the container (prioritize links pointing to profiles to get clean text)
    const channelLink = container.querySelector('a[href*="/@"]') || 
                        container.querySelector('a[href*="/channel/"]') ||
                        container.querySelector('a[href*="/user/"]') ||
                        container.querySelector('ytd-channel-name a') || 
                        container.querySelector('#byline-container a') ||
                        container.querySelector('#channel-name a') ||
                        container.querySelector('ytd-channel-name') ||
                        container.querySelector('#byline-container') ||
                        container.querySelector('#channel-name') ||
                        container.querySelector('.ytd-channel-name') ||
                        container.querySelector('yt-formatted-string.ytd-channel-name');
    
    let channel = 'Unknown Channel';
    if (channelLink) {
      const titleAttr = channelLink.getAttribute('title');
      if (titleAttr) {
        channel = titleAttr.trim();
      } else {
        channel = channelLink.textContent.trim().split('\n')[0].trim();
      }
    } else if (container.tagName.toLowerCase() === 'ytd-reel-item-renderer') {
      channel = 'YouTube Shorts';
    }
    
    // Clean verification badges and dots
    channel = channel.replace(/✓|verified|•/gi, '').trim();
    if (channel.includes(' views')) {
      channel = channel.split('•')[0].split('\n')[0].trim();
    }
    
    // 3. Find Section Date Header
    const section = container.closest('ytd-item-section-renderer');
    if (section) {
      if (section !== lastSectionElement) {
        lastSectionElement = section;
        sectionsProcessedCount++;
        
        const titleEl = section.querySelector('yt-formatted-string#title') || 
                        section.querySelector('#title') ||
                        section.querySelector('.ytd-item-section-header-renderer');
        let parsedDate = null;
        let dateText = '';
        if (titleEl) {
          dateText = titleEl.textContent.trim();
          parsedDate = parseYouTubeHistoryDate(dateText);
        }
        
        if (parsedDate) {
          lastParsedDate = parsedDate;
        } else {
          // If dateText is a sub-category or empty, DO NOT decrement the date
          const lowerText = dateText.toLowerCase().trim();
          const isCategory = lowerText === 'shorts' || 
                             lowerText === 'music' || 
                             lowerText === 'videos' || 
                             lowerText === 'posts' || 
                             lowerText === 'community' || 
                             lowerText === 'comments' || 
                             lowerText === 'live chat' || 
                             lowerText === '';
          
          if (!isCategory && sectionsProcessedCount > 1) {
            // Decrement previous date by 1 day sequentially only for genuine unparsed date sections
            const prevDate = new Date(lastParsedDate);
            prevDate.setDate(prevDate.getDate() - 1);
            lastParsedDate = prevDate;
          }
        }
      }
    }
    
    const yyyy = lastParsedDate.getFullYear();
    const mm = String(lastParsedDate.getMonth() + 1).padStart(2, '0');
    const dd = String(lastParsedDate.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    
    visibleItems.push({ videoId, title, channel, dateStr });
  });
  
  // Group visible items by date string and apply sequence alignment
  const itemsByDate = {};
  visibleItems.forEach(item => {
    if (!itemsByDate[item.dateStr]) itemsByDate[item.dateStr] = [];
    itemsByDate[item.dateStr].push(item);
  });
  
  Object.keys(itemsByDate).forEach((dateStr) => {
    const items = itemsByDate[dateStr];
    const visibleIds = items.map(item => item.videoId);
    
    if (!sessionHistorySequence[dateStr]) {
      sessionHistorySequence[dateStr] = [];
    }
    const runningSequence = sessionHistorySequence[dateStr];
    
    // Align sequence to get stable indices
    const offset = alignSequence(visibleIds, runningSequence);
    
    items.forEach((item, i) => {
      const seqIndex = offset + i;
      if (seqIndex >= runningSequence.length) {
        runningSequence.push(item.videoId);
      }
      
      // Calculate a stable timestamp based on seqIndex (noon minus seqIndex minutes)
      const baseTime = new Date(dateStr);
      baseTime.setHours(12, 0, 0, 0);
      const timestamp = baseTime.getTime() - (seqIndex * 60000); 
      
      parsedRecords.push({
        videoId: item.videoId,
        title: item.title,
        channel: item.channel,
        timestamp: timestamp
      });
    });
  });
  
  return parsedRecords;
}

function injectFloatingSyncButton() {
  if (document.getElementById('yt-watchtree-floating-sync')) return;

  const btn = document.createElement('button');
  btn.id = 'yt-watchtree-floating-sync';
  btn.style.position = 'fixed';
  btn.style.bottom = '24px';
  btn.style.right = '24px';
  btn.style.zIndex = '999999';
  btn.style.background = 'linear-gradient(135deg, #6366f1, #a855f7)';
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.borderRadius = '30px';
  btn.style.padding = '14px 24px';
  btn.style.fontSize = '14px';
  btn.style.fontWeight = '600';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 10px 25px rgba(99, 102, 241, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)';
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.gap = '8px';
  btn.style.transition = 'all 0.2s ease-out';
  btn.style.fontFamily = '"Roboto", "Inter", sans-serif';

  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm1-13h-2v6l5.2 3.2.8-1.3-4-2.4V7z"/>
    </svg>
    Sync to WatchTree
  `;

  btn.addEventListener('mouseenter', () => {
    btn.style.transform = 'scale(1.05) translateY(-2px)';
    btn.style.boxShadow = '0 12px 30px rgba(99, 102, 241, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'none';
    btn.style.boxShadow = '0 10px 25px rgba(99, 102, 241, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)';
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    startDirectSync(false);
  });

  document.body.appendChild(btn);
}

function removeFloatingSyncButton() {
  const btn = document.getElementById('yt-watchtree-floating-sync');
  if (btn) {
    btn.remove();
  }
}

function startDirectSync(isBackground = false) {
  if (isSyncing) return;
  isSyncing = true;
  isBackgroundSync = isBackground;
  syncedVideosCount = 0;
  lastScrollHeight = 0;
  scrollFails = 0;
  initialWaitTicks = 0;
  parsedHistoryData = [];
  sessionHistorySequence = {};

  if (isBackgroundSync) {
    document.body.classList.add('yt-sync-body-active');
  }

  injectSyncOverlay();
  runSyncLoop();
}

// Helper to calculate maximum scroll height among all potential scroll containers
function getScrollHeight() {
  const elements = [
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    document.querySelector('ytd-app') ? document.querySelector('ytd-app').scrollHeight : 0,
    document.querySelector('#content') ? document.querySelector('#content').scrollHeight : 0
  ];
  return Math.max(...elements);
}

function runSyncLoop() {
  if (!isSyncing) return;

  const currentScraped = scrapeHistoryPageElements();
  
  // Merge unique entries
  const seenKeys = new Set(parsedHistoryData.map(v => `${v.videoId}-${v.timestamp}`));
  currentScraped.forEach(item => {
    const key = `${item.videoId}-${item.timestamp}`;
    if (!seenKeys.has(key)) {
      parsedHistoryData.push(item);
      seenKeys.add(key);
    }
  });

  syncedVideosCount = parsedHistoryData.length;
  updateSyncOverlayStats();

  // Send progress message to background service worker to update toolbar badge
  chrome.runtime.sendMessage({
    action: 'updateSyncProgress',
    count: syncedVideosCount
  });

  // Scroll to bottom on all potential scroll containers
  window.scrollTo(0, document.documentElement.scrollHeight);
  document.documentElement.scrollTop = document.documentElement.scrollHeight;
  document.body.scrollTop = document.body.scrollHeight;
  
  const ytdApp = document.querySelector('ytd-app');
  if (ytdApp) {
    ytdApp.scrollTop = ytdApp.scrollHeight;
  }
  const contentEl = document.querySelector('#content');
  if (contentEl) {
    contentEl.scrollTop = contentEl.scrollHeight;
  }
  
  setTimeout(() => {
    const currentHeight = getScrollHeight();
    console.log(`[Watch Tracker] Sync status check: parsed=${syncedVideosCount}, height=${currentHeight}, lastHeight=${lastScrollHeight}, fails=${scrollFails}, initialWaitTicks=${initialWaitTicks}`);
    
    if (parsedHistoryData.length === 0) {
      initialWaitTicks++;
      if (initialWaitTicks >= 30) { // 45 seconds (30 * 1.5s)
        console.warn(`[Watch Tracker] Timed out waiting for history elements to load.`);
        finishDirectSync(true);
        return;
      }
    } else {
      if (currentHeight === lastScrollHeight) {
        scrollFails++;
        if (scrollFails >= MAX_SCROLL_FAILS) {
          console.log(`[Watch Tracker] Scroll height did not change after ${MAX_SCROLL_FAILS} attempts. Ending sync.`);
          finishDirectSync(true);
          return;
        }
      } else {
        scrollFails = 0;
        lastScrollHeight = currentHeight;
      }
    }

    runSyncLoop();
  }, SCROLL_INTERVAL_MS);
}

function finishDirectSync(isComplete = false) {
  isSyncing = false;
  
  // Clear the badge immediately when starting to save to storage
  chrome.runtime.sendMessage({ action: 'clearSyncBadge' });

  const statusTitle = syncOverlay.querySelector('.yt-sync-status-title');
  const statusDesc = syncOverlay.querySelector('.yt-sync-status-desc');
  const progressFiller = syncOverlay.querySelector('.yt-sync-progress-filler');
  
  statusTitle.textContent = isComplete ? "Sync Complete!" : "Sync Paused & Saved!";
  statusDesc.textContent = `Saving ${parsedHistoryData.length.toLocaleString()} videos to database...`;
  
  if (progressFiller) {
    progressFiller.style.width = '100%';
    progressFiller.classList.add('completed');
  }

  chrome.runtime.sendMessage({
    action: 'batchImportHistory',
    events: parsedHistoryData
  }, (response) => {
    if (response && response.success) {
      statusDesc.innerHTML = `Successfully loaded <strong>${response.addedCount.toLocaleString()}</strong> new watch events into WatchTree!`;
      
      const controls = syncOverlay.querySelector('.yt-sync-controls');
      controls.innerHTML = `
        <button class="yt-sync-btn primary" id="yt-sync-btn-close">Close Dashboard</button>
      `;

      controls.querySelector('#yt-sync-btn-close').addEventListener('click', () => {
        document.body.classList.remove('yt-sync-body-active');
        if (syncOverlay) {
          syncOverlay.remove();
          syncOverlay = null;
        }
      });
    } else {
      statusDesc.textContent = `Error saving: ${response ? response.error : 'Storage error'}`;
    }
  });
}

function injectSyncOverlay() {
  if (document.getElementById('yt-sync-overlay')) return;

  syncOverlay = document.createElement('div');
  syncOverlay.id = 'yt-sync-overlay';
  syncOverlay.innerHTML = `
    <div class="yt-sync-card">
      <div class="yt-sync-logo-row">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="#6366f1">
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm1-13h-2v6l5.2 3.2.8-1.3-4-2.4V7z"/>
        </svg>
        <h3>WatchTree Sync</h3>
      </div>
      <p class="yt-sync-status-title">Syncing Watch History...</p>
      <p class="yt-sync-status-desc">We are scrolling through your YouTube history page to import past watches directly into your WatchTree extension database.</p>
      
      <div class="yt-sync-progress-bar">
        <div class="yt-sync-progress-filler"></div>
      </div>

      <div class="yt-sync-stats-grid">
        <div class="yt-sync-stat-col">
          <span class="yt-sync-stat-number" id="yt-sync-stat-scanned">0</span>
          <span class="yt-sync-stat-label">Videos Scanned</span>
        </div>
        <div class="yt-sync-stat-col">
          <span class="yt-sync-stat-number" id="yt-sync-stat-date">Today</span>
          <span class="yt-sync-stat-label">Oldest Date Reached</span>
        </div>
      </div>

      <div class="yt-sync-controls">
        <button class="yt-sync-btn danger" id="yt-sync-btn-stop">Stop & Save Progress</button>
      </div>
    </div>
  `;

  document.body.appendChild(syncOverlay);
  syncOverlay.querySelector('#yt-sync-btn-stop').addEventListener('click', () => {
    finishDirectSync(false);
  });
}

function updateSyncOverlayStats() {
  if (!syncOverlay) return;
  
  const scannedEl = syncOverlay.querySelector('#yt-sync-stat-scanned');
  const dateEl = syncOverlay.querySelector('#yt-sync-stat-date');
  
  if (scannedEl) scannedEl.textContent = syncedVideosCount.toLocaleString();
  
  if (dateEl && parsedHistoryData.length > 0) {
    const oldestItem = parsedHistoryData[parsedHistoryData.length - 1];
    const d = new Date(oldestItem.timestamp);
    dateEl.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
