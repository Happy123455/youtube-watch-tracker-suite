// popup/popup.js
import { initInsights, labelBadge } from './insights.js';

const esc = globalThis.YTCore.esc;

let watchHistory = { watches: {}, metadata: {} };
let videoLabels = {}; // AI labels: {videoId: {category, topics, why}}
let approxTimes = new Set(); // watch times that are only guesses (YouTube's history page has no times)
let allLogEvents = [];
let ignoredVideoIds = [];
let statsRankingMode = 'count'; // 'count' or 'ratio'
let statsMinWatches = 2;
let statsMinSpan = 0;
let showThumbnails = false;
let embedPlayer = false;
let statsEmbedPlayer = false;
let currentSelectedYear = new Date().getFullYear();
let showAdsView = false;
let statsMinimized = false;
let historyZoom = 1.0;
let calendarType = 'all'; // 'all', 'videos', or 'shorts'
let focusTopVideos = false;
let recentHistoryQueries = [];
let recentStatsQueries = [];
let statsLateNightEnabled = false;
let statsLateNightStart = "00:00";
let statsLateNightEnd = "04:00";
let statsLateNightGroupChannel = false;
let statsPaginateAlways = true;
let statsPaginatedLimit = 50;

let phaseMinDays = 30;
let phaseMaxDays = 60;
let phaseMinWatches = 10;
let activePhaseHighlight = null; // { channel, startTimestamp, endTimestamp }

document.addEventListener('DOMContentLoaded', () => {
  const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
  if (isFullscreen) {
    document.body.classList.add('mode-fullscreen');
  }
  loadHistory();
  setupEventListeners();
  initInsights({ onChanged: loadHistory });
});

// Load history from background service worker
function loadHistory() {
  chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
    if (response && response.success) {
      videoLabels = response.labels || {};
      watchHistory = { watches: response.watches || {}, metadata: response.metadata || {} };
      processLogEvents();
      
      // Load ignored videos, limit, timeframe, rankingMode, custom dates, criteria, thumbnails, embedPlayer, statsEmbedPlayer, minimized, zoom, calendarType, focusTopVideos, recent search history, Late-Night Index, and Phase Detector settings from storage
      chrome.storage.local.get(['ignoredVideoIds', 'statsLimit', 'statsTimeframe', 'statsRankingMode', 'statsStartDate', 'statsEndDate', 'statsMinWatches', 'statsMinSpan', 'showThumbnails', 'embedPlayer', 'statsEmbedPlayer', 'statsMinimized', 'historyZoom', 'calendarType', 'focusTopVideos', 'recentHistoryQueries', 'recentStatsQueries', 'statsLateNightEnabled', 'statsLateNightStart', 'statsLateNightEnd', 'statsLateNightGroupChannel', 'phaseMinDays', 'phaseMaxDays', 'phaseMinWatches'], (result) => {
        ignoredVideoIds = result.ignoredVideoIds || [];
        statsRankingMode = result.statsRankingMode || 'count';
        statsMinWatches = result.statsMinWatches !== undefined ? result.statsMinWatches : 2;
        statsMinSpan = result.statsMinSpan !== undefined ? result.statsMinSpan : 0;
        showThumbnails = result.showThumbnails || false;
        embedPlayer = result.embedPlayer || false;
        statsEmbedPlayer = result.statsEmbedPlayer || false;
        statsMinimized = result.statsMinimized || false;
        historyZoom = result.historyZoom !== undefined ? result.historyZoom : 1.0;
        calendarType = result.calendarType || 'all';
        focusTopVideos = result.focusTopVideos || false;
        recentHistoryQueries = result.recentHistoryQueries || [];
        recentStatsQueries = result.recentStatsQueries || [];
        statsLateNightEnabled = result.statsLateNightEnabled || false;
        statsLateNightStart = result.statsLateNightStart || "00:00";
        statsLateNightEnd = result.statsLateNightEnd || "04:00";
        statsLateNightGroupChannel = result.statsLateNightGroupChannel || false;
        
        phaseMinDays = result.phaseMinDays !== undefined ? result.phaseMinDays : 30;
        phaseMaxDays = result.phaseMaxDays !== undefined ? result.phaseMaxDays : 60;
        phaseMinWatches = result.phaseMinWatches !== undefined ? result.phaseMinWatches : 10;

        const phaseMinDaysInput = document.getElementById('phase-min-days');
        const phaseMaxDaysInput = document.getElementById('phase-max-days');
        const phaseMinWatchesInput = document.getElementById('phase-min-watches');
        if (phaseMinDaysInput) phaseMinDaysInput.value = phaseMinDays;
        if (phaseMaxDaysInput) phaseMaxDaysInput.value = phaseMaxDays;
        if (phaseMinWatchesInput) phaseMinWatchesInput.value = phaseMinWatches;
        
        // Update Focus Top button visual state
        const focusBtn = document.getElementById('btn-focus-top');
        if (focusBtn) {
          if (focusTopVideos) {
            focusBtn.classList.add('active-toggle');
          } else {
            focusBtn.classList.remove('active-toggle');
          }
        }
        
        const minWatchesInput = document.getElementById('stats-min-watches');
        if (minWatchesInput) {
          minWatchesInput.value = statsMinWatches;
        }
        
        const minSpanInput = document.getElementById('stats-min-span');
        if (minSpanInput) {
          minSpanInput.value = statsMinSpan;
        }

        const chkThumbnails = document.getElementById('chk-show-thumbnails');
        if (chkThumbnails) {
          chkThumbnails.checked = showThumbnails;
        }
        const chkStatsThumbnails = document.getElementById('chk-stats-show-thumbnails');
        if (chkStatsThumbnails) {
          chkStatsThumbnails.checked = showThumbnails;
        }

        const chkEmbedPlayer = document.getElementById('chk-embed-player');
        if (chkEmbedPlayer) {
          chkEmbedPlayer.checked = embedPlayer;
        }
        const chkStatsEmbedPlayer = document.getElementById('chk-stats-embed-player');
        if (chkStatsEmbedPlayer) {
          chkStatsEmbedPlayer.checked = statsEmbedPlayer;
        }

        const chkLateNight = document.getElementById('chk-late-night');
        if (chkLateNight) {
          chkLateNight.checked = statsLateNightEnabled;
        }
        const lateNightStartInput = document.getElementById('late-night-start');
        if (lateNightStartInput) {
          lateNightStartInput.value = statsLateNightStart;
        }
        const lateNightEndInput = document.getElementById('late-night-end');
        if (lateNightEndInput) {
          lateNightEndInput.value = statsLateNightEnd;
        }
        const chkGroupChannel = document.getElementById('chk-group-channel');
        if (chkGroupChannel) {
          chkGroupChannel.checked = statsLateNightGroupChannel;
        }
        const lateNightSettings = document.getElementById('late-night-settings');
        if (lateNightSettings) {
          if (statsLateNightEnabled) {
            lateNightSettings.classList.remove('hidden');
          } else {
            lateNightSettings.classList.add('hidden');
          }
        }

        // Toggle "Playable Video" option visibility (only in full screen mode when thumbnails are checked)
        const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
        const lblEmbedPlayer = document.getElementById('lbl-embed-player');
        if (lblEmbedPlayer) {
          if (showThumbnails && isFullscreen) {
            lblEmbedPlayer.style.display = 'flex';
          } else {
            lblEmbedPlayer.style.display = 'none';
          }
        }
        const lblStatsEmbedPlayer = document.getElementById('lbl-stats-embed-player');
        if (lblStatsEmbedPlayer) {
          if (showThumbnails && isFullscreen) {
            lblStatsEmbedPlayer.style.display = 'flex';
          } else {
            lblStatsEmbedPlayer.style.display = 'none';
          }
        }

        // Configure Full Screen Button visibility (hide if already in fullscreen tab)
        const btnFullscreen = document.getElementById('btn-fullscreen');
        if (btnFullscreen) {
          if (isFullscreen) {
            btnFullscreen.style.display = 'none';
          } else {
            btnFullscreen.style.display = 'inline-flex';
          }
        }

        // Initialize Watch History and Stats zoom slider controls
        const zoomSlider = document.getElementById('history-zoom-slider');
        const zoomValText = document.getElementById('history-zoom-val');
        if (zoomSlider) {
          zoomSlider.value = historyZoom;
        }
        if (zoomValText) {
          zoomValText.textContent = `${historyZoom.toFixed(1)}x`;
        }

        const statsZoomSlider = document.getElementById('stats-zoom-slider');
        const statsZoomValText = document.getElementById('stats-zoom-val');
        if (statsZoomSlider) {
          statsZoomSlider.value = historyZoom;
        }
        if (statsZoomValText) {
          statsZoomValText.textContent = `${historyZoom.toFixed(1)}x`;
        }
        updateHistoryZoomVisibility();

        // Sync stats minimized state
        const btnMinimizeStats = document.getElementById('btn-minimize-stats');
        const statsMinimizeIcon = document.getElementById('stats-minimize-icon');
        const statsContainer = document.querySelector('.stats-section .stats-container');
        const statsCriteriaRow = document.getElementById('stats-criteria-row');
        const statsCustomDateRow = document.getElementById('stats-custom-date-row');
        const statsSettingsRow = document.getElementById('stats-settings-row');
        const statsHeaderRight = document.querySelector('.stats-header-row div:last-child');
        
        if (statsMinimized) {
          if (statsContainer) statsContainer.classList.add('hidden');
          if (statsCriteriaRow) statsCriteriaRow.classList.add('hidden');
          if (statsCustomDateRow) statsCustomDateRow.classList.add('hidden');
          if (statsSettingsRow) statsSettingsRow.classList.add('hidden');
          const statsLateNightRow = document.getElementById('stats-latenight-row');
          if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
          if (statsHeaderRight) statsHeaderRight.classList.add('hidden');
          
          if (statsMinimizeIcon) {
            statsMinimizeIcon.innerHTML = '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>';
          }
          if (btnMinimizeStats) btnMinimizeStats.title = "Expand Section";
        }

        const limitInput = document.getElementById('stats-limit-input');
        if (limitInput) {
          limitInput.value = result.statsLimit || 10;
        }
        const timeframeSelect = document.getElementById('stats-timeframe-select');
        if (timeframeSelect) {
          timeframeSelect.value = result.statsTimeframe || 'all';
          
          // Toggle custom date picker visibility
          const dateRow = document.getElementById('stats-custom-date-row');
          if (dateRow) {
            if (timeframeSelect.value === 'custom') {
              dateRow.classList.remove('hidden');
            } else {
              dateRow.classList.add('hidden');
            }
          }
        }

        const modeBtn = document.getElementById('btn-toggle-stats-mode');
        const sectionTitle = document.getElementById('stats-section-title');
        if (modeBtn && sectionTitle) {
          if (statsRankingMode === 'ratio') {
            modeBtn.textContent = 'Show Count';
            sectionTitle.textContent = 'Top Rewatched to duration ratio Videos';
          } else {
            modeBtn.textContent = 'Show Ratio';
            sectionTitle.textContent = 'Top Rewatched Videos';
          }
        }

        const startInput = document.getElementById('stats-start-date');
        const endInput = document.getElementById('stats-end-date');
        if (startInput) startInput.value = result.statsStartDate || '';
        if (endInput) endInput.value = result.statsEndDate || '';

        // Populate Year Selector Dropdown
        const yearSelect = document.getElementById('yt-calendar-year-select');
        if (yearSelect) {
          yearSelect.innerHTML = '';
          const uniqueYears = new Set();
          const thisYear = new Date().getFullYear();
          uniqueYears.add(thisYear);
          
          allLogEvents.forEach(evt => {
            uniqueYears.add(new Date(evt.timestamp).getFullYear());
          });
          
          const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);
          sortedYears.forEach(yr => {
            const opt = document.createElement('option');
            opt.value = yr;
            opt.textContent = yr;
            yearSelect.appendChild(opt);
          });
          
          // Default to the last watch year or current year
          let defaultYear = thisYear;
          if (allLogEvents.length > 0) {
            defaultYear = new Date(allLogEvents[0].timestamp).getFullYear();
          }
          
          yearSelect.value = defaultYear;
          currentSelectedYear = defaultYear;
          
          // Change listener
          yearSelect.onchange = (e) => {
            currentSelectedYear = parseInt(e.target.value);
            renderHeatmap(currentSelectedYear);
          };
        }

        const calendarTypeSelect = document.getElementById('yt-calendar-type-select');
        if (calendarTypeSelect) {
          calendarTypeSelect.value = calendarType;
        }
        
        renderHeatmap(currentSelectedYear);
        renderHistoryList(allLogEvents);
        renderTopVideos();
        renderTopAds();
        renderShiftAnalysis();
        renderPhaseDetector();
        renderFormatShiftAnalysis();

        if (showAdsView) {
          const topVideosList = document.getElementById('top-videos-list');
          const topAdsList = document.getElementById('top-ads-list');
          const statsTitle = document.getElementById('stats-section-title');
          const toggleStatsModeBtn = document.getElementById('btn-toggle-stats-mode');
          const criteriaRow = document.getElementById('stats-criteria-row');
          const customDateRow = document.getElementById('stats-custom-date-row');
          const toggleAdsViewBtn = document.getElementById('btn-toggle-ads-view');
          
          if (topVideosList) topVideosList.classList.add('hidden');
          if (topAdsList) topAdsList.classList.remove('hidden');
          if (statsTitle) statsTitle.textContent = 'Top Serviced Advertisements';
          if (toggleStatsModeBtn) toggleStatsModeBtn.classList.add('hidden');
          if (criteriaRow) criteriaRow.classList.add('hidden');
          if (customDateRow) customDateRow.classList.add('hidden');
          if (toggleAdsViewBtn) {
            toggleAdsViewBtn.style.background = 'rgba(99, 102, 241, 0.2)';
            toggleAdsViewBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
            toggleAdsViewBtn.style.color = '#a5b4fc';
          }
        }
      });
    } else {
      console.error('Failed to load history');
    }
  });
}

// Convert indexed storage into a list of watch events sorted by timestamp descending
function processLogEvents() {
  const events = [];
  const { watches, metadata } = watchHistory;
  approxTimes = new Set();
  Object.values(metadata).forEach((m) => (m && m.approx || []).forEach((t) => approxTimes.add(t)));

  Object.keys(watches).forEach((videoId) => {
    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel', duration: '' };
    const timestamps = watches[videoId] || [];
    
    timestamps.forEach((timestamp) => {
      const dt = new Date(timestamp);
      events.push({
        videoId,
        timestamp,
        title: meta.title,
        channel: meta.channel,
        duration: meta.duration || '',
        isShort: globalThis.YTCore.isShortMeta(meta),
        approx: approxTimes.has(timestamp),
        year: dt.getFullYear(),
        dateStr: getLocalDateString(dt)
      });
    });
  });

  // Sort: most recent watches first
  events.sort((a, b) => b.timestamp - a.timestamp);
  allLogEvents = events;
}

// Compares weekend vs weekday avg video durations and creator channels
function renderShiftAnalysis() {
  const container = document.getElementById('shift-analysis-container');
  if (!container) return;

  // Separate events into weekdays and weekends
  let weekdayWatches = 0;
  let weekendWatches = 0;

  const weekdayActiveDates = new Set();
  const weekendActiveDates = new Set();

  let weekdayDurations = [];
  let weekendDurations = [];

  const weekdayChannels = {};
  const weekendChannels = {};

  const weekdayBuckets = { shorts: 0, short: 0, medium: 0, long: 0, doc: 0 };
  const weekendBuckets = { shorts: 0, short: 0, medium: 0, long: 0, doc: 0 };

  allLogEvents.forEach(evt => {
    if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
    if (ignoredVideoIds.includes(evt.videoId)) return;
    
    const dt = new Date(evt.timestamp);
    const day = dt.getDay(); // 0 is Sunday, 6 is Saturday
    const isWeekend = (day === 0 || day === 6);
    
    const dateStr = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');

    if (isWeekend) {
      weekendWatches++;
      weekendActiveDates.add(dateStr);
    } else {
      weekdayWatches++;
      weekdayActiveDates.add(dateStr);
    }

    // Parse duration
    const durationSec = parseDurationToSeconds(evt.duration);
    if (durationSec > 0) {
      if (isWeekend) {
        weekendDurations.push(durationSec);
      } else {
        weekdayDurations.push(durationSec);
      }

      // Put into buckets
      const bucket = getDurationBucket(durationSec);
      if (isWeekend) {
        weekendBuckets[bucket]++;
      } else {
        weekdayBuckets[bucket]++;
      }
    }

    // Channels
    const channel = evt.channel || 'Unknown Channel';
    if (isWeekend) {
      weekendChannels[channel] = (weekendChannels[channel] || 0) + 1;
    } else {
      weekdayChannels[channel] = (weekdayChannels[channel] || 0) + 1;
    }
  });

  // Helper functions
  function parseDurationToSeconds(str) {
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return 0;
  }

  function getDurationBucket(sec) {
    if (sec < 60) return 'shorts'; // <1 min
    if (sec < 300) return 'short'; // 1-5 mins
    if (sec < 1200) return 'medium'; // 5-20 mins
    if (sec < 3600) return 'long'; // 20-60 mins
    return 'doc'; // 60+ mins
  }

  function formatDuration(sec) {
    if (sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Fallback detection
  const hasTotalVideoWatches = (weekdayWatches + weekendWatches) > 0;
  const hasAnyDuration = (weekdayDurations.length + weekendDurations.length) > 0;
  const isDurationDataMissing = hasTotalVideoWatches && !hasAnyDuration;

  // Averages & Metric display
  let metricLabel = 'Avg Video Length';
  let weekdayAvgStr = '';
  let weekendAvgStr = '';
  let diffPercentMarkup = '';

  if (isDurationDataMissing) {
    metricLabel = 'Avg Watches per Active Day';
    const activeWeekdaysCount = Math.max(1, weekdayActiveDates.size);
    const activeWeekendsCount = Math.max(1, weekendActiveDates.size);
    const avgWeekdayWatches = weekdayWatches / activeWeekdaysCount;
    const avgWeekendWatches = weekendWatches / activeWeekendsCount;

    weekdayAvgStr = `${avgWeekdayWatches.toFixed(1)}/day`;
    weekendAvgStr = `${avgWeekendWatches.toFixed(1)}/day`;

    if (avgWeekdayWatches > 0 && avgWeekendWatches > 0) {
      const ratio = avgWeekendWatches / avgWeekdayWatches;
      const diffPercent = Math.round((ratio - 1) * 100);
      if (diffPercent > 0) {
        diffPercentMarkup = `<span class="badge" style="background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">+${diffPercent}% more active on weekends</span>`;
      } else if (diffPercent < 0) {
        diffPercentMarkup = `<span class="badge" style="background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">${Math.abs(diffPercent)}% less active on weekends</span>`;
      } else {
        diffPercentMarkup = `<span class="badge" style="background: rgba(255, 255, 255, 0.05); color: #9ca3af; border: 1px solid rgba(255, 255, 255, 0.1); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">Same activity level</span>`;
      }
    }
  } else {
    const avgWeekdaySec = weekdayDurations.length > 0 ? (weekdayDurations.reduce((a, b) => a + b, 0) / weekdayDurations.length) : 0;
    const avgWeekendSec = weekendDurations.length > 0 ? (weekendDurations.reduce((a, b) => a + b, 0) / weekendDurations.length) : 0;

    weekdayAvgStr = formatDuration(avgWeekdaySec);
    weekendAvgStr = formatDuration(avgWeekendSec);

    if (avgWeekdaySec > 0 && avgWeekendSec > 0) {
      const ratio = avgWeekendSec / avgWeekdaySec;
      const diffPercent = Math.round((ratio - 1) * 100);
      if (diffPercent > 0) {
        diffPercentMarkup = `<span class="badge" style="background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">+${diffPercent}% longer on weekends</span>`;
      } else if (diffPercent < 0) {
        diffPercentMarkup = `<span class="badge" style="background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">${Math.abs(diffPercent)}% shorter on weekends</span>`;
      } else {
        diffPercentMarkup = `<span class="badge" style="background: rgba(255, 255, 255, 0.05); color: #9ca3af; border: 1px solid rgba(255, 255, 255, 0.1); font-size: 9px; padding: 2px 6px; margin-left: 8px; border-radius: 4px;">Same duration</span>`;
      }
    }
  }

  // Top 3 channels
  const sortedWeekdayChannels = Object.entries(weekdayChannels).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const sortedWeekendChannels = Object.entries(weekendChannels).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Sum of valid bucket counts
  const weekdayBucketTotal = Object.values(weekdayBuckets).reduce((a, b) => a + b, 0) || 1;
  const weekendBucketTotal = Object.values(weekendBuckets).reduce((a, b) => a + b, 0) || 1;

  const distributionTitle = isDurationDataMissing ? 'Activity Breakdown' : 'Duration Distribution';
  
  let weekdayDistributionHTML = '';
  let weekendDistributionHTML = '';

  if (isDurationDataMissing) {
    const disclaimerHTML = (watchesCount, activeDaysCount, typeStr) => `
      <div style="background: rgba(255, 255, 255, 0.015); border: 1px dashed rgba(255, 255, 255, 0.06); border-radius: 6px; padding: 8px; font-size: 9.5px; color: var(--color-text-muted); line-height: 1.4;">
        <div style="font-weight: 700; color: #fbbf24; margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
          <span style="font-size: 10px;">⚠️</span> Takeout Import Note
        </div>
        Google Takeout's watch-history.json does not contain video duration metadata. Showing watches/day activity volumes instead of duration lengths.
        <div style="margin-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.04); padding-top: 6px; display: flex; justify-content: space-between; font-size: 9px;">
          <span>Total Watches:</span>
          <span style="color: #fff; font-weight: 700;">${watchesCount} (${typeStr})</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 9px; margin-top: 2px;">
          <span>Active Days:</span>
          <span style="color: #fff; font-weight: 700;">${activeDaysCount} days</span>
        </div>
      </div>
    `;
    weekdayDistributionHTML = disclaimerHTML(weekdayWatches, weekdayActiveDates.size, 'Mon-Fri');
    weekendDistributionHTML = disclaimerHTML(weekendWatches, weekendActiveDates.size, 'Sat-Sun');
  } else {
    weekdayDistributionHTML = `
      <div style="display: flex; flex-direction: column; gap: 5px;">
        ${renderBucketProgressBar('Shorts (<1m)', weekdayBuckets.shorts, weekdayBucketTotal, '#818cf8')}
        ${renderBucketProgressBar('Short (1-5m)', weekdayBuckets.short, weekdayBucketTotal, '#6366f1')}
        ${renderBucketProgressBar('Medium (5-20m)', weekdayBuckets.medium, weekdayBucketTotal, '#a855f7')}
        ${renderBucketProgressBar('Long (20-60m)', weekdayBuckets.long, weekdayBucketTotal, '#c084fc')}
        ${renderBucketProgressBar('Documentary (60m+)', weekdayBuckets.doc, weekdayBucketTotal, '#e0a7ff')}
      </div>
    `;
    weekendDistributionHTML = `
      <div style="display: flex; flex-direction: column; gap: 5px;">
        ${renderBucketProgressBar('Shorts (<1m)', weekendBuckets.shorts, weekendBucketTotal, '#818cf8')}
        ${renderBucketProgressBar('Short (1-5m)', weekendBuckets.short, weekendBucketTotal, '#6366f1')}
        ${renderBucketProgressBar('Medium (5-20m)', weekendBuckets.medium, weekendBucketTotal, '#a855f7')}
        ${renderBucketProgressBar('Long (20-60m)', weekendBuckets.long, weekendBucketTotal, '#c084fc')}
        ${renderBucketProgressBar('Documentary (60m+)', weekendBuckets.doc, weekendBucketTotal, '#e0a7ff')}
      </div>
    `;
  }

  // Render HTML inside container
  container.innerHTML = `
    <div class="yt-tracker-shift-summary" style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 12px; padding: 12px 16px; margin-bottom: 16px;">
      <div style="text-align: left;">
        <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted); font-weight: 600;">${metricLabel}</div>
        <div style="display: flex; align-items: baseline; margin-top: 4px;">
          <span style="font-size: 16px; font-weight: 800; color: #a5b4fc;">${weekdayAvgStr}</span>
          <span style="font-size: 11px; color: var(--color-text-muted); margin: 0 8px;">vs</span>
          <span style="font-size: 16px; font-weight: 800; color: #c084fc;">${weekendAvgStr}</span>
          ${diffPercentMarkup}
        </div>
      </div>
    </div>
    
    <div class="yt-tracker-modal-layout" style="display: flex; flex-direction: row; gap: 16px;">
      <!-- Weekdays Panel -->
      <div style="flex: 1; min-width: 0; background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 10px; padding: 12px; text-align: left;">
        <h4 style="margin: 0 0 10px 0; font-size: 11px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #6366f1;"></span>
          Weekdays (Mon-Fri)
        </h4>
        
        <div style="margin-bottom: 12px;">
          <div style="font-size: 9px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em;">${distributionTitle}</div>
          ${weekdayDistributionHTML}
        </div>
        
        <div>
          <div style="font-size: 9px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">Primary Creators</div>
          <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px;">
            ${sortedWeekdayChannels.map(([ch, count], i) => `
              <li style="display: flex; justify-content: space-between; font-size: 10px; padding: 3px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03);">
                <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;">${i+1}. ${ch}</span>
                <span style="color: #a5b4fc; font-weight: 700;">${count}x</span>
              </li>
            `).join('') || '<li style="font-size: 9.5px; color: var(--color-text-muted);">No watches</li>'}
          </ul>
        </div>
      </div>

      <!-- Weekends Panel -->
      <div style="flex: 1; min-width: 0; background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 10px; padding: 12px; text-align: left;">
        <h4 style="margin: 0 0 10px 0; font-size: 11px; font-weight: 700; color: #c084fc; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #a855f7;"></span>
          Weekends (Sat-Sun)
        </h4>
        
        <div style="margin-bottom: 12px;">
          <div style="font-size: 9px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em;">${distributionTitle}</div>
          ${weekendDistributionHTML}
        </div>
        
        <div>
          <div style="font-size: 9px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">Primary Creators</div>
          <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px;">
            ${sortedWeekendChannels.map(([ch, count], i) => `
              <li style="display: flex; justify-content: space-between; font-size: 10px; padding: 3px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03);">
                <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;">${i+1}. ${ch}</span>
                <span style="color: #c084fc; font-weight: 700;">${count}x</span>
              </li>
            `).join('') || '<li style="font-size: 9.5px; color: var(--color-text-muted);">No watches</li>'}
          </ul>
        </div>
      </div>
    </div>
  `;

  function renderBucketProgressBar(label, count, total, color) {
    const pct = Math.round((count / total) * 100) || 0;
    return `
      <div style="display: flex; flex-direction: column; gap: 2px;">
        <div style="display: flex; justify-content: space-between; font-size: 8px; color: var(--color-text-secondary); font-weight: 500;">
          <span>${label}</span>
          <span style="font-weight: 700; color: #fff;">${pct}% (${count})</span>
        </div>
        <div style="width: 100%; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.04); overflow: hidden; position: relative;">
          <div style="width: ${pct}%; height: 100%; border-radius: 3px; background: ${color}; transition: width 0.3s ease;"></div>
        </div>
      </div>
    `;
  }
}


function renderPhaseDetector() {
  const container = document.getElementById('phase-detector-container');
  if (!container) return;

  // Group all watches by channel
  const channelWatches = {};
  allLogEvents.forEach(evt => {
    if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
    if (ignoredVideoIds.includes(evt.videoId)) return;

    const channel = evt.channel || 'Unknown Channel';
    if (!channelWatches[channel]) {
      channelWatches[channel] = [];
    }
    channelWatches[channel].push(evt);
  });

  const detectedPhases = [];
  Object.entries(channelWatches).forEach(([channel, events]) => {
    // Sort events by timestamp ascending
    events.sort((a, b) => a.timestamp - b.timestamp);

    const firstTimestamp = events[0].timestamp;
    const lastTimestamp = events[events.length - 1].timestamp;

    // Time span in days
    const spanDays = (lastTimestamp - firstTimestamp) / (1000 * 60 * 60 * 24);

    // Requirement: active span matches our days window
    if (spanDays >= phaseMinDays && spanDays <= phaseMaxDays) {
      if (events.length >= phaseMinWatches) {
        // Was it in the top 5 most-watched channels during this window?
        const windowWatches = {};
        allLogEvents.forEach(evt => {
          if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
          if (ignoredVideoIds.includes(evt.videoId)) return;

          if (evt.timestamp >= firstTimestamp && evt.timestamp <= lastTimestamp) {
            const ch = evt.channel || 'Unknown Channel';
            windowWatches[ch] = (windowWatches[ch] || 0) + 1;
          }
        });

        const sortedWindowChannels = Object.entries(windowWatches)
          .sort((a, b) => b[1] - a[1]);

        const rank = sortedWindowChannels.findIndex(([ch]) => ch === channel) + 1;

        if (rank > 0 && rank <= 5) {
          detectedPhases.push({
            channel,
            startTimestamp: firstTimestamp,
            endTimestamp: lastTimestamp,
            watchCount: events.length,
            spanDays: Math.round(spanDays)
          });
        }
      }
    }
  });

  // Sort phases: show most intensive (highest watch count) first
  detectedPhases.sort((a, b) => b.watchCount - a.watchCount);

  if (detectedPhases.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--color-text-muted); font-size: 10px; padding: 12px 0;">No intense, short-lived obsessions found matching criteria.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${detectedPhases.map(phase => {
        const startDateStr = new Date(phase.startTimestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const endDateStr = new Date(phase.endTimestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const isCurrentlyHighlighted = activePhaseHighlight && activePhaseHighlight.channel === phase.channel && activePhaseHighlight.startTimestamp === phase.startTimestamp;
        const btnClass = isCurrentlyHighlighted ? 'btn-phase-toggle active' : 'btn-phase-toggle';
        const btnStyle = isCurrentlyHighlighted 
          ? 'font-size: 9px; padding: 3px 8px; background: #fbbf24; border: 1px solid #fbbf24; color: #000; font-weight: 700; border-radius: 4px; cursor: pointer; transition: all 0.2s;' 
          : 'font-size: 9px; padding: 3px 8px; background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.2); color: #fbbf24; border-radius: 4px; cursor: pointer; transition: all 0.2s;';
        const btnText = isCurrentlyHighlighted ? 'Unhighlight' : 'Highlight';
        
        return `
          <div class="phase-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 8px; padding: 8px 12px; font-size: 11px;">
            <div style="text-align: left; min-width: 0; flex: 1; padding-right: 8px;">
              <div style="font-weight: 700; color: #fbbf24; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;" title="${esc(phase.channel)}">${esc(phase.channel)}</span>
                <span style="font-size: 9px; color: var(--color-text-muted); font-weight: normal;">(${phase.watchCount} watches)</span>
              </div>
              <div style="font-size: 9px; color: var(--color-text-muted); margin-top: 2px;">
                Active: ${startDateStr} - ${endDateStr} (${phase.spanDays} days)
              </div>
            </div>
            <button class="${btnClass}" style="${btnStyle}" data-channel="${encodeURIComponent(phase.channel)}" data-start="${phase.startTimestamp}" data-end="${phase.endTimestamp}">${btnText}</button>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Attach event listeners to buttons
  const buttons = container.querySelectorAll('.btn-phase-toggle');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const channel = decodeURIComponent(e.target.getAttribute('data-channel'));
      const startTimestamp = parseInt(e.target.getAttribute('data-start'));
      const endTimestamp = parseInt(e.target.getAttribute('data-end'));

      const isCurrentlyHighlighted = activePhaseHighlight && activePhaseHighlight.channel === channel && activePhaseHighlight.startTimestamp === startTimestamp;

      if (isCurrentlyHighlighted) {
        activePhaseHighlight = null;
      } else {
        activePhaseHighlight = { channel, startTimestamp, endTimestamp };
        // Jump the calendar to the year of this phase
        const phaseYear = new Date(startTimestamp).getFullYear();
        currentSelectedYear = phaseYear;
        const yearSelect = document.getElementById('yt-calendar-year-select');
        if (yearSelect) {
          yearSelect.value = phaseYear;
        }
      }

      // Re-render Phase Detector to update button classes/styles
      renderPhaseDetector();
      // Re-render Heatmap to apply highlights
      renderHeatmap(currentSelectedYear);
      // Re-render Year selectors to update active year styles
      renderYearSelectorRow();
    });
  });
}

function renderFormatShiftAnalysis() {
  const container = document.getElementById('format-shift-container');
  if (!container) return;

  function parseDurationToSeconds(str) {
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return 0;
  }

  function formatDurationShort(sec) {
    if (sec <= 0) return '0s';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatCountShort(num) {
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  // Fallback detection
  const totalVideoWatches = allLogEvents.filter(evt => {
    if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return false;
    if (ignoredVideoIds.includes(evt.videoId)) return false;
    return true;
  });
  
  const totalWatchesWithDuration = totalVideoWatches.filter(evt => {
    const sec = parseDurationToSeconds(evt.duration);
    return sec > 0;
  }).length;
  
  const isDurationDataMissing = (totalVideoWatches.length > 0 && totalWatchesWithDuration === 0);

  // Aggregate watches by year
  const yearDurations = {};
  const yearCounts = {};

  allLogEvents.forEach(evt => {
    if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
    if (ignoredVideoIds.includes(evt.videoId)) return;

    const yr = evt.year || new Date(evt.timestamp).getFullYear();
    if (isDurationDataMissing) {
      yearCounts[yr] = (yearCounts[yr] || 0) + 1;
    } else {
      const sec = parseDurationToSeconds(evt.duration);
      if (sec > 0) {
        if (!yearDurations[yr]) {
          yearDurations[yr] = [];
        }
        yearDurations[yr].push(sec);
      }
    }
  });

  const years = (isDurationDataMissing ? Object.keys(yearCounts) : Object.keys(yearDurations)).map(Number).sort((a, b) => a - b);

  if (years.length < 2) {
    const reason = isDurationDataMissing ? 'watch volume' : 'format shift';
    container.innerHTML = `
      <div style="text-align: center; color: var(--color-text-muted); font-size: 10px; padding: 16px 8px; border: 1px dashed rgba(255,255,255,0.06); border-radius: 8px;">
        Multi-year history is required to trace ${reason} trends. 
        Currently tracking data for: ${years.length > 0 ? years.join(', ') : 'None'}.
      </div>
    `;
    return;
  }

  const data = years.map(yr => {
    if (isDurationDataMissing) {
      const cnt = yearCounts[yr];
      return {
        year: yr,
        value: cnt,
        label: `${formatCountShort(cnt)}x`
      };
    } else {
      const arr = yearDurations[yr];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return {
        year: yr,
        value: avg / 60, // in minutes for Y plotting
        label: formatDurationShort(avg),
        avgSeconds: avg
      };
    }
  });

  // Plot variables
  const svgWidth = 320;
  const svgHeight = 110;
  const leftMargin = 30;
  const rightMargin = 30;
  const topMargin = 20;
  const bottomMargin = 20;
  
  const plotWidth = svgWidth - leftMargin - rightMargin;
  const plotHeight = svgHeight - topMargin - bottomMargin;

  const minVal = Math.min(...data.map(d => d.value));
  const maxVal = Math.max(...data.map(d => d.value));
  const range = maxVal - minVal;

  const points = data.map((d, i) => {
    const x = leftMargin + (i * (plotWidth / (data.length - 1)));
    const yVal = range > 0 ? (d.value - minVal) / range : 0.5;
    const y = topMargin + plotHeight - (yVal * plotHeight);
    return { x, y, data: d };
  });

  // Build SVG Path
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${topMargin + plotHeight} L ${points[0].x} ${topMargin + plotHeight} Z`;

  // Trend statement calculation
  const first = data[0];
  const last = data[data.length - 1];
  
  let changePercent = 0;
  if (isDurationDataMissing) {
    changePercent = Math.round(((last.value - first.value) / first.value) * 100);
  } else {
    changePercent = Math.round(((last.avgSeconds - first.avgSeconds) / first.avgSeconds) * 100);
  }

  let trendClass = 'badge-gray';
  let trendText = '';
  let trendExplanation = '';
  const metricName = isDurationDataMissing ? 'annual watch volume' : 'average video watch duration';
  const unitSuffix = isDurationDataMissing ? '' : '';

  if (changePercent > 0) {
    trendClass = 'badge-success';
    trendText = `Growing (+${changePercent}%)`;
    trendExplanation = `Your ${metricName} increased by <strong>${changePercent}%</strong> between ${first.year} and ${last.year} (shifting from ${first.label}${unitSuffix} to ${last.label}${unitSuffix}). This suggests your ${isDurationDataMissing ? 'YouTube usage' : 'preference'} is shifting toward <strong>${isDurationDataMissing ? 'higher volume' : 'longer format contents'}</strong>.`;
  } else if (changePercent < 0) {
    trendClass = 'badge-danger';
    trendText = `Shrinking (${changePercent}%)`;
    trendExplanation = `Your ${metricName} decreased by <strong>${Math.abs(changePercent)}%</strong> between ${first.year} and ${last.year} (shifting from ${first.label}${unitSuffix} to ${last.label}${unitSuffix}). This indicates your ${isDurationDataMissing ? 'YouTube usage' : 'attention span or preference'} is shifting toward <strong>${isDurationDataMissing ? 'lower volume' : 'shorter format videos'}</strong>.`;
  } else {
    trendText = 'Stable (0%)';
    trendExplanation = `Your ${metricName} remained unchanged at ${first.label}${unitSuffix} between ${first.year} and ${last.year}.`;
  }

  const footnoteHTML = isDurationDataMissing ? `
    <div style="font-size: 8px; color: var(--color-text-muted); margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; font-style: italic;">
      * Takeout history does not contain video duration metadata. Showing annual watch count instead of average duration.
    </div>
  ` : '';

  container.innerHTML = `
    <div style="background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 10px; padding: 12px; text-align: left;">
      
      <!-- Trend Overview Row -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); font-weight: 600;">
          ${isDurationDataMissing ? 'Watch Volume Trend' : 'Attention Span Trend'}
        </div>
        <span class="badge ${trendClass}" style="font-size: 9px; padding: 2px 6px; border-radius: 4px;">${trendText}</span>
      </div>

      <!-- Graph Container -->
      <div style="position: relative; margin-bottom: 12px; background: rgba(0, 0, 0, 0.15); border-radius: 8px; border: 1px solid rgba(255,255,255,0.02); overflow: hidden; padding: 4px;">
        <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="100%" style="display: block; overflow: visible;">
          <defs>
            <linearGradient id="trend-line-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#6366f1" />
              <stop offset="100%" stop-color="#a855f7" />
            </linearGradient>
            <linearGradient id="trend-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#6366f1" stop-opacity="0.15" />
              <stop offset="100%" stop-color="#a855f7" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          
          <!-- Area Under Path -->
          <path d="${areaPath}" fill="url(#trend-area-grad)" />
          
          <!-- Line Path -->
          <path d="${linePath}" fill="none" stroke="url(#trend-line-grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          
          <!-- Nodes and Labels -->
          ${points.map(p => `
            <!-- Circle Node -->
            <circle cx="${p.x}" cy="${p.y}" r="4" fill="#fbbf24" stroke="rgba(251, 191, 36, 0.25)" stroke-width="3" style="transition: r 0.2s;" />
            
            <!-- Value Label (Above) -->
            <text x="${p.x}" y="${p.y - 8}" fill="#fff" font-size="8" font-weight="700" text-anchor="middle">${p.data.label}</text>
            
            <!-- Year Label (Below) -->
            <text x="${p.x}" y="${svgHeight - 4}" fill="var(--color-text-muted)" font-size="8" font-weight="500" text-anchor="middle">${p.data.year}</text>
          `).join('')}
        </svg>
      </div>

      <!-- Descriptive Trend Summary -->
      <div style="font-size: 10px; color: var(--color-text-secondary); line-height: 1.45; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 8px;">
        ${trendExplanation}
      </div>
      ${footnoteHTML}
    </div>
  `;
}

// Advanced search logic supporting: regex (/pattern/), exact phrase ("phrase"), OR (termA OR termB), AND (termA termB), and negation (-term)
function matchSearchQuery(title, channel, queryStr) {
  if (!queryStr) return true;
  
  title = title.toLowerCase();
  channel = channel.toLowerCase();
  
  // 1. Regular expression support: /pattern/
  if (queryStr.startsWith('/') && queryStr.endsWith('/') && queryStr.length > 2) {
    try {
      const pattern = queryStr.slice(1, -1);
      const regex = new RegExp(pattern, 'i');
      return regex.test(title) || regex.test(channel);
    } catch (e) {
      // Invalid regex, fallback
    }
  }
  
  // 2. Exact phrase query: "exact phrase"
  if (queryStr.startsWith('"') && queryStr.endsWith('"') && queryStr.length > 2) {
    const phrase = queryStr.slice(1, -1).toLowerCase();
    return title.includes(phrase) || channel.includes(phrase);
  }
  
  // 3. AND / OR / NOT boolean parsing
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

// Render search history dropdown overlay
function renderSearchHistoryDropdown(inputId, dropdownId, historyList, onSelect, onDelete) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;

  dropdown.innerHTML = '';
  
  if (historyList.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  historyList.forEach((query) => {
    const li = document.createElement('li');
    
    const textSpan = document.createElement('span');
    textSpan.textContent = query;
    textSpan.style.flex = '1';
    textSpan.style.overflow = 'hidden';
    textSpan.style.textOverflow = 'ellipsis';
    textSpan.style.whiteSpace = 'nowrap';
    
    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'delete-history-item';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Remove from history';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(query);
    });

    li.appendChild(textSpan);
    li.appendChild(deleteBtn);

    li.addEventListener('click', () => {
      input.value = query;
      dropdown.style.display = 'none';
      onSelect(query);
    });

    dropdown.appendChild(li);
  });

  dropdown.style.display = 'block';
}

function showHistoryDropdown(type) {
  if (type === 'history') {
    renderSearchHistoryDropdown(
      'search-input',
      'history-search-history-dropdown',
      recentHistoryQueries,
      (q) => executeHistorySearch(q),
      (q) => {
        recentHistoryQueries = recentHistoryQueries.filter(x => x !== q);
        chrome.storage.local.set({ recentHistoryQueries });
        showHistoryDropdown('history');
      }
    );
  } else {
    renderSearchHistoryDropdown(
      'stats-search-input',
      'stats-search-history-dropdown',
      recentStatsQueries,
      (q) => executeStatsSearch(q),
      (q) => {
        recentStatsQueries = recentStatsQueries.filter(x => x !== q);
        chrome.storage.local.set({ recentStatsQueries });
        showHistoryDropdown('stats');
      }
    );
  }
}

function executeHistorySearch(query) {
  query = query.trim();
  if (query) {
    recentHistoryQueries = [query, ...recentHistoryQueries.filter(q => q !== query)].slice(0, 8);
    chrome.storage.local.set({ recentHistoryQueries });
  }
  const dropdown = document.getElementById('history-search-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  if (!query) {
    renderHistoryList(allLogEvents);
  } else {
    const filtered = allLogEvents.filter(
      (event) => matchSearchQuery(event.title, event.channel, query)
    );
    renderHistoryList(filtered);
  }
}

function executeStatsSearch(query) {
  query = query.trim();
  if (query) {
    recentStatsQueries = [query, ...recentStatsQueries.filter(q => q !== query)].slice(0, 8);
    chrome.storage.local.set({ recentStatsQueries });
  }
  const dropdown = document.getElementById('stats-search-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  renderTopVideos();
  renderTopAds();
}

// Check if a timestamp falls within a specific local time window (e.g. "00:00" to "04:00")
function isTimestampInTimeRange(ts, startTimeStr, endTimeStr) {
  // A guessed time (a phone watch from YouTube's history page) says nothing about the hour.
  if (approxTimes.has(ts)) return false;
  const date = new Date(ts);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const timeVal = hours + minutes / 60;

  const startParts = startTimeStr.split(':');
  const endParts = endTimeStr.split(':');
  const startHour = parseInt(startParts[0]) + (parseInt(startParts[1]) || 0) / 60;
  const endHour = parseInt(endParts[0]) + (parseInt(endParts[1]) || 0) / 60;

  if (startHour <= endHour) {
    return timeVal >= startHour && timeVal <= endHour;
  } else {
    // Crosses midnight (e.g. 10:00 PM to 4:00 AM)
    return timeVal >= startHour || timeVal <= endHour;
  }
}



// Setup popup event listeners
function setupEventListeners() {
  const searchInput = document.getElementById('search-input');
  const historySearchIcon = document.getElementById('history-search-icon');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeHistorySearch(e.target.value);
      }
    });
    searchInput.addEventListener('focus', () => showHistoryDropdown('history'));
    searchInput.addEventListener('click', () => showHistoryDropdown('history'));
  }
  if (historySearchIcon && searchInput) {
    historySearchIcon.addEventListener('click', () => {
      executeHistorySearch(searchInput.value);
    });
  }

  // Stats Search
  const statsSearchInput = document.getElementById('stats-search-input');
  const statsSearchIcon = document.getElementById('stats-search-icon');
  if (statsSearchInput) {
    statsSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeStatsSearch(e.target.value);
      }
    });
    statsSearchInput.addEventListener('focus', () => showHistoryDropdown('stats'));
    statsSearchInput.addEventListener('click', () => showHistoryDropdown('stats'));
  }
  if (statsSearchIcon && statsSearchInput) {
    statsSearchIcon.addEventListener('click', () => {
      executeStatsSearch(statsSearchInput.value);
    });
  }

  // Close search history dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    const histDropdown = document.getElementById('history-search-history-dropdown');
    const histInput = document.getElementById('search-input');
    const statsDropdown = document.getElementById('stats-search-history-dropdown');
    const statsInput = document.getElementById('stats-search-input');

    if (histDropdown && histInput && e.target !== histInput && !histInput.contains(e.target) && e.target !== histDropdown && !histDropdown.contains(e.target)) {
      histDropdown.style.display = 'none';
    }
    if (statsDropdown && statsInput && e.target !== statsInput && !statsInput.contains(e.target) && e.target !== statsDropdown && !statsDropdown.contains(e.target)) {
      statsDropdown.style.display = 'none';
    }
  });

  // Copy Today
  document.getElementById('btn-copy-today').addEventListener('click', () => {
    copyWatchesForDate(new Date(), 'Today');
  });

  // Copy Yesterday
  document.getElementById('btn-copy-yesterday').addEventListener('click', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    copyWatchesForDate(yesterday, 'Yesterday');
  });

  // Export to Markdown file
  document.getElementById('btn-export-markdown').addEventListener('click', exportFullHistory);

  // Toggle Calendar visibility
  const toggleCalendarBtn = document.getElementById('btn-toggle-calendar');
  const calendarContainer = document.querySelector('.yt-tracker-calendar-container');
  const calendarLegend = document.querySelector('.yt-tracker-calendar-legend');
  
  if (toggleCalendarBtn && calendarContainer && calendarLegend) {
    // Load initial state
    chrome.storage.local.get(['calendarHidden'], (result) => {
      const isHidden = result.calendarHidden || false;
      if (isHidden) {
        calendarContainer.classList.add('hidden');
        calendarLegend.classList.add('hidden');
        toggleCalendarBtn.textContent = 'Show Calendar';
      } else {
        calendarContainer.classList.remove('hidden');
        calendarLegend.classList.remove('hidden');
        toggleCalendarBtn.textContent = 'Hide Calendar';
      }
    });

    toggleCalendarBtn.addEventListener('click', () => {
      const isHidden = calendarContainer.classList.contains('hidden');
      if (isHidden) {
        calendarContainer.classList.remove('hidden');
        calendarLegend.classList.remove('hidden');
        toggleCalendarBtn.textContent = 'Hide Calendar';
        chrome.storage.local.set({ calendarHidden: false });
      } else {
        calendarContainer.classList.add('hidden');
        calendarLegend.classList.add('hidden');
        toggleCalendarBtn.textContent = 'Show Calendar';
        chrome.storage.local.set({ calendarHidden: true });
      }
    });
  }

  // Focus Top Videos on Calendar
  const focusTopBtn = document.getElementById('btn-focus-top');
  if (focusTopBtn) {
    focusTopBtn.addEventListener('click', () => {
      focusTopVideos = !focusTopVideos;
      chrome.storage.local.set({ focusTopVideos }, () => {
        if (focusTopVideos) {
          focusTopBtn.classList.add('active-toggle');
        } else {
          focusTopBtn.classList.remove('active-toggle');
        }
        renderHeatmap(currentSelectedYear);
      });
    });
  }

  // Handle Calendar Type Filter changes
  const calendarTypeSelect = document.getElementById('yt-calendar-type-select');
  if (calendarTypeSelect) {
    calendarTypeSelect.addEventListener('change', (e) => {
      calendarType = e.target.value;
      chrome.storage.local.set({ calendarType }, () => {
        renderHeatmap(currentSelectedYear);
      });
    });
  }

  // Handle stats limit input change
  const statsLimitInput = document.getElementById('stats-limit-input');
  if (statsLimitInput) {
    statsLimitInput.addEventListener('change', (e) => {
      let inputVal = e.target.value.trim();
      let val;
      if (inputVal === '∞' || inputVal.toLowerCase() === 'infinity') {
        val = '∞';
      } else {
        val = parseInt(inputVal) || 10;
        if (val < 1) val = 1;
      }
      e.target.value = val;

      if (val === '∞' || val > 250) {
        const confirmPaginate = confirm(
          "Warning: Loading a very large number of results (or infinity) may cause the plugin to lag or crash.\n\n" +
          "Would you like to enable paginated loading (50 items at a time) to prevent hanging?\n\n" +
          "Click OK to enable pagination (Recommended).\n" +
          "Click Cancel to load all results at once."
        );
        statsPaginateAlways = confirmPaginate;
      } else {
        statsPaginateAlways = true;
      }
      
      chrome.storage.local.set({ statsLimit: val }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle stats limit infinity button click
  const btnStatsLimitInfinity = document.getElementById('btn-stats-limit-infinity');
  if (btnStatsLimitInfinity && statsLimitInput) {
    btnStatsLimitInfinity.addEventListener('click', () => {
      statsLimitInput.value = '∞';
      statsLimitInput.dispatchEvent(new Event('change'));
    });
  }

  // Handle stats timeframe dropdown change
  const statsTimeframeSelect = document.getElementById('stats-timeframe-select');
  if (statsTimeframeSelect) {
    statsTimeframeSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      
      // Toggle custom date picker visibility
      const dateRow = document.getElementById('stats-custom-date-row');
      if (dateRow) {
        if (val === 'custom') {
          dateRow.classList.remove('hidden');
        } else {
          dateRow.classList.add('hidden');
        }
      }

      chrome.storage.local.set({ statsTimeframe: val }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle stats custom dates changes
  const startDateInput = document.getElementById('stats-start-date');
  const endDateInput = document.getElementById('stats-end-date');
  if (startDateInput) {
    startDateInput.addEventListener('change', (e) => {
      chrome.storage.local.set({ statsStartDate: e.target.value }, () => {
        renderTopVideos();
      });
    });
  }
  if (endDateInput) {
    endDateInput.addEventListener('change', (e) => {
      chrome.storage.local.set({ statsEndDate: e.target.value }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle stats minimum watches criteria input changes
  const minWatchesInput = document.getElementById('stats-min-watches');
  if (minWatchesInput) {
    minWatchesInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value);
      if (isNaN(val) || val < 1) val = 1;
      e.target.value = val;
      statsMinWatches = val;
      chrome.storage.local.set({ statsMinWatches: val }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle stats minimum span criteria input changes
  const minSpanInput = document.getElementById('stats-min-span');
  if (minSpanInput) {
    minSpanInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value);
      if (isNaN(val) || val < 0) val = 0;
      e.target.value = val;
      statsMinSpan = val;
      chrome.storage.local.set({ statsMinSpan: val }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle show thumbnails checkbox toggle
  const chkThumbnails = document.getElementById('chk-show-thumbnails');
  if (chkThumbnails) {
    chkThumbnails.addEventListener('change', (e) => {
      handleThumbnailsChange(e.target.checked);
    });
  }
  const chkStatsThumbnails = document.getElementById('chk-stats-show-thumbnails');
  if (chkStatsThumbnails) {
    chkStatsThumbnails.addEventListener('change', (e) => {
      handleThumbnailsChange(e.target.checked);
    });
  }

  // Handle embed player checkbox toggle
  const chkEmbedPlayer = document.getElementById('chk-embed-player');
  if (chkEmbedPlayer) {
    chkEmbedPlayer.addEventListener('change', (e) => {
      handleEmbedPlayerChange(e.target.checked);
    });
  }
  const chkStatsEmbedPlayer = document.getElementById('chk-stats-embed-player');
  if (chkStatsEmbedPlayer) {
    chkStatsEmbedPlayer.addEventListener('change', (e) => {
      handleStatsEmbedPlayerChange(e.target.checked);
    });
  }

  // Handle full screen button click (open popup.html in a full browser tab)
  const btnFullscreen = document.getElementById('btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?mode=fullscreen') });
    });
  }

  // Handle stats mode toggle button
  const toggleStatsModeBtn = document.getElementById('btn-toggle-stats-mode');
  const statsTitle = document.getElementById('stats-section-title');
  if (toggleStatsModeBtn && statsTitle) {
    toggleStatsModeBtn.addEventListener('click', () => {
      if (statsRankingMode === 'count') {
        statsRankingMode = 'ratio';
        toggleStatsModeBtn.textContent = 'Show Count';
        statsTitle.textContent = 'Top Rewatched to duration ratio Videos';
      } else {
        statsRankingMode = 'count';
        toggleStatsModeBtn.textContent = 'Show Ratio';
        statsTitle.textContent = 'Top Rewatched Videos';
      }
      chrome.storage.local.set({ statsRankingMode }, () => {
        renderTopVideos();
      });
    });
  }

  // Handle stats section minimization
  const btnMinimizeStats = document.getElementById('btn-minimize-stats');
  const statsMinimizeIcon = document.getElementById('stats-minimize-icon');
  const statsContainer = document.querySelector('.stats-section .stats-container');
  const statsCriteriaRow = document.getElementById('stats-criteria-row');
  const statsCustomDateRow = document.getElementById('stats-custom-date-row');
  const statsSettingsRow = document.getElementById('stats-settings-row');
  const statsHeaderRight = document.querySelector('.stats-header-row div:last-child');

  if (btnMinimizeStats) {
    btnMinimizeStats.addEventListener('click', () => {
      statsMinimized = !statsMinimized;
      if (statsMinimized) {
        if (statsContainer) statsContainer.classList.add('hidden');
        if (statsCriteriaRow) statsCriteriaRow.classList.add('hidden');
        if (statsCustomDateRow) statsCustomDateRow.classList.add('hidden');
        if (statsSettingsRow) statsSettingsRow.classList.add('hidden');
        const statsLateNightRow = document.getElementById('stats-latenight-row');
        if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
        if (statsHeaderRight) statsHeaderRight.classList.add('hidden');
        
        if (statsMinimizeIcon) {
          statsMinimizeIcon.innerHTML = '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>';
        }
        btnMinimizeStats.title = "Expand Section";
      } else {
        if (statsContainer) statsContainer.classList.remove('hidden');
        if (statsSettingsRow) statsSettingsRow.classList.remove('hidden');
        if (!showAdsView) {
          if (statsCriteriaRow) statsCriteriaRow.classList.remove('hidden');
          const statsLateNightRow = document.getElementById('stats-latenight-row');
          if (statsLateNightRow) statsLateNightRow.classList.remove('hidden');
          const timeframeSelect = document.getElementById('stats-timeframe-select');
          if (timeframeSelect && timeframeSelect.value === 'custom') {
            if (statsCustomDateRow) statsCustomDateRow.classList.remove('hidden');
          }
        }
        if (statsHeaderRight) statsHeaderRight.classList.remove('hidden');
        
        if (statsMinimizeIcon) {
          statsMinimizeIcon.innerHTML = '<path d="M19 13H5v-2h14v2z"/>';
        }
        btnMinimizeStats.title = "Minimize Section";
      }
      chrome.storage.local.set({ statsMinimized });
    });
  }

  // Handle zoom sliders
  const zoomSlider = document.getElementById('history-zoom-slider');
  if (zoomSlider) {
    zoomSlider.addEventListener('input', (e) => {
      handleZoomSliderInput(parseFloat(e.target.value));
    });
    zoomSlider.addEventListener('change', () => {
      handleZoomSliderChange();
    });
  }

  const statsZoomSlider = document.getElementById('stats-zoom-slider');
  if (statsZoomSlider) {
    statsZoomSlider.addEventListener('input', (e) => {
      handleZoomSliderInput(parseFloat(e.target.value));
    });
    statsZoomSlider.addEventListener('change', () => {
      handleZoomSliderChange();
    });
  }

  // Handle Late-Night Index checkbox toggle
  const chkLateNight = document.getElementById('chk-late-night');
  if (chkLateNight) {
    chkLateNight.addEventListener('change', (e) => {
      statsLateNightEnabled = e.target.checked;
      
      const lateNightSettings = document.getElementById('late-night-settings');
      if (lateNightSettings) {
        if (statsLateNightEnabled) {
          lateNightSettings.classList.remove('hidden');
        } else {
          lateNightSettings.classList.add('hidden');
        }
      }
      
      chrome.storage.local.set({ statsLateNightEnabled }, () => {
        renderTopVideos();
        if (focusTopVideos) {
          renderHeatmap();
        }
      });
    });
  }

  // Handle Late-Night Start Time input change
  const lateNightStart = document.getElementById('late-night-start');
  if (lateNightStart) {
    lateNightStart.addEventListener('change', (e) => {
      statsLateNightStart = e.target.value;
      chrome.storage.local.set({ statsLateNightStart }, () => {
        renderTopVideos();
        if (focusTopVideos) renderHeatmap();
      });
    });
  }

  // Handle Late-Night End Time input change
  const lateNightEnd = document.getElementById('late-night-end');
  if (lateNightEnd) {
    lateNightEnd.addEventListener('change', (e) => {
      statsLateNightEnd = e.target.value;
      chrome.storage.local.set({ statsLateNightEnd }, () => {
        renderTopVideos();
        if (focusTopVideos) renderHeatmap();
      });
    });
  }

  // Handle Late-Night Group by Channel checkbox toggle
  const chkGroupChannel = document.getElementById('chk-group-channel');
  if (chkGroupChannel) {
    chkGroupChannel.addEventListener('change', (e) => {
      statsLateNightGroupChannel = e.target.checked;
      chrome.storage.local.set({ statsLateNightGroupChannel }, () => {
        renderTopVideos();
      });
    });
  }


  // Handle ads view toggle button
  const toggleAdsViewBtn = document.getElementById('btn-toggle-ads-view');
  const topVideosList = document.getElementById('top-videos-list');
  const topAdsList = document.getElementById('top-ads-list');
  const criteriaRow = document.getElementById('stats-criteria-row');
  const customDateRow = document.getElementById('stats-custom-date-row');
  const timeframeSelect = document.getElementById('stats-timeframe-select');
  if (toggleAdsViewBtn) {
    toggleAdsViewBtn.addEventListener('click', () => {
      showAdsView = !showAdsView;
      if (showAdsView) {
        if (topVideosList) topVideosList.classList.add('hidden');
        if (topAdsList) topAdsList.classList.remove('hidden');
        if (statsTitle) statsTitle.textContent = 'Top Serviced Advertisements';
        if (toggleStatsModeBtn) toggleStatsModeBtn.classList.add('hidden');
        if (criteriaRow) criteriaRow.classList.add('hidden');
        const statsLateNightRow = document.getElementById('stats-latenight-row');
        if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
        if (customDateRow) customDateRow.classList.add('hidden');
        
        toggleAdsViewBtn.style.background = 'rgba(99, 102, 241, 0.2)';
        toggleAdsViewBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
        toggleAdsViewBtn.style.color = '#a5b4fc';
        
        renderTopAds();
      } else {
        if (topVideosList) topVideosList.classList.remove('hidden');
        if (topAdsList) topAdsList.classList.add('hidden');
        if (statsTitle) {
          if (statsRankingMode === 'ratio') {
            statsTitle.textContent = 'Top Rewatched to duration ratio Videos';
          } else {
            statsTitle.textContent = 'Top Rewatched Videos';
          }
        }
        if (toggleStatsModeBtn) toggleStatsModeBtn.classList.remove('hidden');
        if (criteriaRow) criteriaRow.classList.remove('hidden');
        const statsLateNightRow = document.getElementById('stats-latenight-row');
        if (statsLateNightRow) statsLateNightRow.classList.remove('hidden');
        if (timeframeSelect && timeframeSelect.value === 'custom') {
          if (customDateRow) customDateRow.classList.remove('hidden');
        }
        
        toggleAdsViewBtn.style.background = '';
        toggleAdsViewBtn.style.borderColor = '';
        toggleAdsViewBtn.style.color = '';
        
        renderTopVideos();
      }
    });
  }

  // Handle reset ignored videos list button
  const resetIgnoredBtn = document.getElementById('btn-reset-ignored');
  if (resetIgnoredBtn) {
    resetIgnoredBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to restore all discarded videos to the repeat stats?')) {
        ignoredVideoIds = [];
        chrome.storage.local.set({ ignoredVideoIds }, () => {
          renderTopVideos();
          renderShiftAnalysis();
          renderPhaseDetector();
          renderFormatShiftAnalysis();
          showToast('Discarded videos restored!');
        });
      }
    });
  }

  // Google Takeout Import
  const triggerBtn = document.getElementById('btn-trigger-import');
  const fileInput = document.getElementById('takeout-file');
  if (triggerBtn && fileInput) {
    triggerBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileImport);
  }

  // Reset Data click listener
  const resetBtn = document.getElementById('btn-reset-history');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to delete ALL watch history entries? This cannot be undone.')) {
        chrome.runtime.sendMessage({ action: 'clearAllHistory' }, (response) => {
          if (response && response.success) {
            showToast('All history cleared!');
            loadHistory(); // Reload and redraw popup
          }
        });
      }
    });
  }

  // Direct YouTube Sync
  const syncBtn = document.getElementById('btn-trigger-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: 'https://www.youtube.com/feed/history?sync=true',
        active: true
      });
      showToast('Sync tab opened!');
    });
  }

  // Obsidian Local Sync
  const obsidianSyncBtn = document.getElementById('btn-obsidian-sync');
  if (obsidianSyncBtn) {
    obsidianSyncBtn.addEventListener('click', async () => {
      obsidianSyncBtn.disabled = true;
      const originalHtml = obsidianSyncBtn.innerHTML;
      obsidianSyncBtn.textContent = 'Pushing...';
      
      try {
        const result = await chrome.storage.local.get(['watches', 'metadata', 'obsidianSyncPort']);
        const port = result.obsidianSyncPort || 12314;
        const watches = result.watches || {};
        const metadata = result.metadata || {};
        
        const response = await fetch(`http://127.0.0.1:${port}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ watches, metadata })
        });
        
        if (response.ok) {
          showToast('Successfully synced with Obsidian!');
        } else {
          showToast('Sync failed: Server returned error');
        }
      } catch (err) {
        console.error('Obsidian sync error:', err);
        showToast('Sync failed: Make sure Obsidian is running');
      } finally {
        obsidianSyncBtn.disabled = false;
        obsidianSyncBtn.innerHTML = originalHtml;
      }
    });
  }

  // Phase Detector scan button listener
  const btnRecalcPhases = document.getElementById('btn-recalculate-phases');
  if (btnRecalcPhases) {
    btnRecalcPhases.addEventListener('click', () => {
      const minDaysInput = document.getElementById('phase-min-days');
      const maxDaysInput = document.getElementById('phase-max-days');
      const minWatchesInput = document.getElementById('phase-min-watches');
      
      let minD = minDaysInput ? parseInt(minDaysInput.value) : 30;
      let maxD = maxDaysInput ? parseInt(maxDaysInput.value) : 60;
      let minW = minWatchesInput ? parseInt(minWatchesInput.value) : 10;
      
      if (isNaN(minD) || minD < 1) minD = 30;
      if (isNaN(maxD) || maxD < minD) maxD = 60;
      if (isNaN(minW) || minW < 1) minW = 10;
      
      if (minDaysInput) minDaysInput.value = minD;
      if (maxDaysInput) maxDaysInput.value = maxD;
      if (minWatchesInput) minWatchesInput.value = minW;
      
      phaseMinDays = minD;
      phaseMaxDays = maxD;
      phaseMinWatches = minW;
      
      chrome.storage.local.set({ phaseMinDays, phaseMaxDays, phaseMinWatches }, () => {
        renderPhaseDetector();
      });
    });
  }
}

// Helper to format local date as YYYY-MM-DD
function getLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Helper to get video IDs currently shown in the Top Rewatched Videos list
function getFilteredTopVideoIds() {
  const timeframeSelect = document.getElementById('stats-timeframe-select');
  const timeframeVal = timeframeSelect ? timeframeSelect.value : 'all';
  
  let startTime = 0;
  let endTime = Infinity;
  
  if (timeframeVal === 'custom') {
    const startDateInput = document.getElementById('stats-start-date');
    const endDateInput = document.getElementById('stats-end-date');
    const startVal = startDateInput ? startDateInput.value : '';
    const endVal = endDateInput ? endDateInput.value : '';
    
    if (startVal) {
      const parts = startVal.split('-');
      if (parts.length === 3) {
        startTime = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0).getTime();
      }
    }
    if (endVal) {
      const parts = endVal.split('-');
      if (parts.length === 3) {
        endTime = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 23, 59, 59, 999).getTime();
      }
    }
  } else if (timeframeVal !== 'all') {
    const days = parseInt(timeframeVal) || 30;
    startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  }

  const limitInput = document.getElementById('stats-limit-input');
  const limitVal = limitInput ? limitInput.value.trim() : '10';
  const limit = limitVal === '∞' || limitVal.toLowerCase() === 'infinity' ? Infinity : (parseInt(limitVal) || 10);

  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const { watches, metadata } = watchHistory;
  const videoStats = [];

  Object.keys(watches).forEach((videoId) => {
    if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
    if (ignoredVideoIds.includes(videoId)) return;

    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
    const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
    if (isAd) return;

    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) {
      return;
    }

    const rawTimestamps = watches[videoId] || [];
    let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
    if (statsLateNightEnabled) {
      timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, statsLateNightStart, statsLateNightEnd));
    }
    if (timestamps.length === 0) return;

    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    const firstSeen = sortedTimestamps[0];
    const lastSeen = sortedTimestamps[sortedTimestamps.length - 1];

    const diffMs = lastSeen - firstSeen;
    const displayDiffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    const ratioDivisor = Math.max(1, displayDiffDays);
    const ratio = timestamps.length / ratioDivisor;

    if (timestamps.length < statsMinWatches) return;
    if (displayDiffDays < statsMinSpan) return;

    videoStats.push({
      videoId,
      count: timestamps.length,
      lastSeen,
      ratio
    });
  });

  videoStats.sort((a, b) => {
    if (statsRankingMode === 'ratio') {
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen - a.lastSeen;
    } else {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen - a.lastSeen;
    }
  });

  return videoStats.slice(0, limit).map(v => v.videoId);
}

// Render the scrollable vertical monthly calendar
function renderHeatmap(selectedYear = currentSelectedYear) {
  const containerEl = document.getElementById('yt-calendar-vertical-list');
  if (!containerEl) return;
  containerEl.innerHTML = '';
  
  const topVideoIds = focusTopVideos ? getFilteredTopVideoIds() : null;
  
  // Group all watches by date string for the selected year
  const watchedDates = {}; // Format: { "YYYY-MM-DD": [event1, event2, ...] }
  allLogEvents.forEach((event) => {
    if (event.year !== selectedYear) return;

    const isShort = event.isShort;
    if (calendarType === 'videos' && isShort) return;
    if (calendarType === 'shorts' && !isShort) return;

    // Filter watches to only those belonging to top rewatched videos if focus mode is active
    if (focusTopVideos && topVideoIds && !topVideoIds.includes(event.videoId)) return;

    const dateStr = event.dateStr;
    if (!watchedDates[dateStr]) watchedDates[dateStr] = [];
    watchedDates[dateStr].push(event);
  });

  // Calculate max watch count in a single day for the selected year
  let maxCount = 1;
  Object.keys(watchedDates).forEach((dateStr) => {
    maxCount = Math.max(maxCount, watchedDates[dateStr].length);
  });

  // Loop through 12 months of the selected year (January = 0 to December = 11)
  for (let month = 0; month <= 11; month++) {
    const targetDate = new Date(selectedYear, month, 1);
    const year = selectedYear;
    
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
    const firstDay = new Date(year, month, 1).getDay(); // 0 = Sunday, 1 = Monday...
    for (let offset = 0; offset < firstDay; offset++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'yt-calendar-day-cell offset';
      daysGrid.appendChild(emptyCell);
    }
    
    // Total days in month
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
        
        // Calculate ratio relative to max count of the year
        const ratio = maxCount > 1 ? (count - 1) / (maxCount - 1) : 0;
        
        // HSL Hue transitions from Indigo/Blue (239) to Purple (280)
        const hue = Math.floor(239 + ratio * 41);
        const alpha = 0.15 + ratio * 0.70;
        const lightness = Math.floor(67 - ratio * 12);
        
        const bgColor = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;
        const borderColor = `hsla(${hue}, 84%, ${lightness - 10}%, ${alpha + 0.2})`;
        const textColor = ratio > 0.5 ? '#ffffff' : '#a5b4fc';

        // Check Phase Highlights
        let isPhaseTarget = false;
        let isPhaseRange = false;
        if (activePhaseHighlight) {
          const cellTimeStart = cellDate.getTime();
          const cellTimeEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();
          if (cellTimeEnd >= activePhaseHighlight.startTimestamp && cellTimeStart <= activePhaseHighlight.endTimestamp) {
            isPhaseRange = true;
            isPhaseTarget = watchesOnDay.some(evt => evt.channel === activePhaseHighlight.channel);
          }
        }

        let finalBg = bgColor;
        let finalBorder = borderColor;
        let finalColor = textColor;
        let finalShadow = '';

        let hoverBg = `hsla(${hue}, 84%, ${lightness - 5}%, ${Math.min(1, alpha + 0.15)})`;
        let hoverBorder = `hsla(${hue}, 84%, ${lightness - 15}%, ${Math.min(1, alpha + 0.3)})`;
        let hoverShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, ${Math.min(0.6, alpha + 0.2)})`;

        if (isPhaseTarget) {
          cell.classList.add('cell-phase-target');
          finalBg = 'rgba(251, 191, 36, 0.25)';
          finalBorder = '#fbbf24';
          finalColor = '#fff';
          finalShadow = '0 0 10px rgba(251, 191, 36, 0.4)';
          
          hoverBg = 'rgba(251, 191, 36, 0.35)';
          hoverBorder = '#fbbf24';
          hoverShadow = '0 0 15px rgba(251, 191, 36, 0.6)';
        } else if (isPhaseRange) {
          cell.classList.add('cell-phase-range');
          finalBorder = 'rgba(251, 191, 36, 0.6)';
          hoverBorder = 'rgba(251, 191, 36, 0.8)';
        }
        
        cell.style.background = finalBg;
        cell.style.borderColor = finalBorder;
        cell.style.color = finalColor;
        if (finalShadow) cell.style.boxShadow = finalShadow;
        
        cell.addEventListener('mouseenter', () => {
          cell.style.background = hoverBg;
          cell.style.borderColor = hoverBorder;
          cell.style.boxShadow = hoverShadow;
          
          if (!cell.title) {
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
          }
        });
        cell.addEventListener('mouseleave', () => {
          cell.style.background = finalBg;
          cell.style.borderColor = finalBorder;
          cell.style.boxShadow = finalShadow;
        });
        
        // Make it clickable to filter list by that date!
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => {
          const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          const searchInput = document.getElementById('search-input');
          if (searchInput) searchInput.value = '';
          renderHistoryList(watchesOnDay);
          showToast(`Showing ${count} watch(es) for ${dateFormatted}`);
        });
      } else {
        cell.classList.add('cell-empty');
        
        // Check Phase Highlights for empty days in range
        let isPhaseRange = false;
        if (activePhaseHighlight) {
          const cellTimeStart = cellDate.getTime();
          const cellTimeEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();
          if (cellTimeEnd >= activePhaseHighlight.startTimestamp && cellTimeStart <= activePhaseHighlight.endTimestamp) {
            isPhaseRange = true;
          }
        }
        
        if (isPhaseRange) {
          cell.classList.add('cell-phase-range');
          cell.style.background = 'rgba(251, 191, 36, 0.02)';
          cell.style.borderColor = 'rgba(251, 191, 36, 0.2)';
        }

        cell.addEventListener('mouseenter', () => {
          if (!cell.title) {
            const weekdayName = cellDate.toLocaleDateString(undefined, { weekday: 'long' });
            const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            cell.title = `${weekdayName}, ${dateFormatted}\nNo watches`;
          }
        });
      }
      
      daysGrid.appendChild(cell);
    }
    
    monthBlock.appendChild(daysGrid);
    containerEl.appendChild(monthBlock);
  }
  
  // Render visual years row
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
    const isShort = evt.isShort;
    if (calendarType === 'videos' && isShort) return;
    if (calendarType === 'shorts' && !isShort) return;

    // Filter watches to only those belonging to top rewatched videos if focus mode is active
    if (focusTopVideos && topVideoIds && !topVideoIds.includes(evt.videoId)) return;

    const yr = evt.year;
    uniqueYears.add(yr);
    yearCounts[yr] = (yearCounts[yr] || 0) + 1;
  });

  const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);
  const maxYearCount = Math.max(...Object.values(yearCounts), 1);

  sortedYears.forEach((yr) => {
    const count = yearCounts[yr] || 0;
    const ratio = count / maxYearCount;

    // Heat color grading scheme matching the calendar cell colors
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

    // Styling if selected or not
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
      renderHeatmap(yr);
    });

    rowContainer.appendChild(pill);
  });
}

// Render watch history logs list with pagination support
function renderHistoryList(events, limit = 50) {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';

  if (events.length === 0) {
    listEl.innerHTML = '<li class="empty-history">No matching watch history found.</li>';
    return;
  }

  // Slice list to limit count
  const itemsToRender = events.slice(0, limit);

  itemsToRender.forEach((event) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const d = new Date(event.timestamp);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    
    const url = getEventUrl(event);
    const actionLabel = getEventActionLabel(event);
    const icon = getEventIcon(event);

    const isNormalVideo = !event.videoId.startsWith('search:') && !event.videoId.startsWith('visit:');
    let mediaHtml = '';
    if (showThumbnails && isNormalVideo) {
      const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
      if (embedPlayer && isFullscreen) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: #000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${event.videoId}?rel=0&modestbranding=1&enablejsapi=1&origin=https%3A%2F%2Fwww.youtube-nocookie.com" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border: none; width: 100%; height: 100%;"></iframe>
          </div>
        `;
      } else {
        const thumbnailUrl = `https://i.ytimg.com/vi/${event.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 4px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.2);">
            <img src="${thumbnailUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="thumbnail" loading="lazy">
          </div>
        `;
      }
    }

    li.innerHTML = `
      <div class="history-info" style="display: flex; align-items: center; width: 100%; min-width: 0;">
        ${mediaHtml}
        <div style="flex-grow: 1; min-width: 0;">
          <h4 class="history-title">
            <a href="${esc(url)}" target="_blank" title="${esc(event.title)}">${esc(event.title)}</a>${labelBadge(videoLabels[event.videoId])}${event.isShort ? ' <span class="short-badge" title="Short">S</span>' : ''}
          </h4>
          <div class="history-meta">
            <span class="history-channel">${esc(event.channel)}</span>
            <span class="history-time">${dateStr} at ${timeStr} (${actionLabel})</span>
          </div>
        </div>
      </div>
      <div class="history-actions">
        <button class="icon-btn calendar-btn" title="Open Watch History Calendar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm-5-7h-5v5h5v-5z"/>
          </svg>
        </button>
        <a class="icon-btn play-btn" href="${esc(url)}" target="_blank" title="Open Link">
          ${icon}
        </a>
        <button class="icon-btn copy-btn" title="Copy Obsidian Link">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
        </button>
        <button class="icon-btn delete-btn" title="Delete History Entry">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </button>
      </div>
    `;

    // Attach list action listeners
    const calendarBtn = li.querySelector('.calendar-btn');
    if (calendarBtn) {
      calendarBtn.addEventListener('click', () => {
        openVideoCalendarModal(event.videoId, event.title, event.channel);
      });
    }

    const copyBtn = li.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
      copySingleObsidianMarkdown(event, copyBtn);
    });

    const deleteBtn = li.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete watch entry for "${event.title}"?`)) {
        deleteWatchEntry(event.videoId, event.timestamp);
      }
    });

    listEl.appendChild(li);
  });

  // Append a Load More button if there are more items to display
  if (events.length > limit) {
    const loadMoreLi = document.createElement('li');
    loadMoreLi.className = 'load-more-item';
    loadMoreLi.style.listStyle = 'none';
    loadMoreLi.style.padding = '12px 20px';
    loadMoreLi.style.textAlign = 'center';

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn secondary';
    loadMoreBtn.style.width = '100%';
    loadMoreBtn.style.justifyContent = 'center';
    loadMoreBtn.style.padding = '10px 16px';
    loadMoreBtn.style.borderRadius = '10px';
    loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
    loadMoreBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    loadMoreBtn.style.color = '#e5e7eb';
    loadMoreBtn.style.fontSize = '12px';
    loadMoreBtn.style.fontWeight = '600';
    loadMoreBtn.style.cursor = 'pointer';
    loadMoreBtn.style.transition = 'all 0.15s ease';
    loadMoreBtn.textContent = `Load More (+${Math.min(events.length - limit, 50)})`;

    loadMoreBtn.addEventListener('mouseenter', () => {
      loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.08)';
      loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    });

    loadMoreBtn.addEventListener('mouseleave', () => {
      loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
      loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    });

    loadMoreBtn.addEventListener('click', () => {
      renderHistoryList(events, limit + 50);
    });

    loadMoreLi.appendChild(loadMoreBtn);
    listEl.appendChild(loadMoreLi);
  }
}

// Copy a single watch event to clipboard in Obsidian format
function copySingleObsidianMarkdown(event, buttonEl) {
  const url = getEventUrl(event);
  const action = getEventActionLabel(event);
  const dateStr = getLocalDateString(new Date(event.timestamp));
  const timeStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  
  const markdown = `- [ ] [${event.title}](${url}) - ${event.channel} (${action} at ${timeStr} on [[${dateStr}]])`;

  navigator.clipboard.writeText(markdown).then(() => {
    buttonEl.classList.add('success-copy');
    buttonEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    `;
    showToast('Link copied!');
    
    setTimeout(() => {
      buttonEl.classList.remove('success-copy');
      buttonEl.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
      `;
    }, 1500);
  });
}

// Copy all watches for a specific date (e.g. today or yesterday)
function copyWatchesForDate(targetDate, label) {
  const dateStr = getLocalDateString(targetDate);
  
  const filteredEvents = allLogEvents.filter(
    (event) => getLocalDateString(new Date(event.timestamp)) === dateStr
  );

  if (filteredEvents.length === 0) {
    showToast(`No watches recorded for ${label}.`);
    return;
  }

  // Sort chronological for morning -> night log ordering
  const markdown = filteredEvents
    .reverse()
    .map((event) => {
      const timeStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      const url = getEventUrl(event);
      const action = getEventActionLabel(event);
      return `- [ ] [${event.title}](${url}) - ${event.channel} (${action} at ${timeStr})`;
    })
    .join('\n');

  navigator.clipboard.writeText(markdown).then(() => {
    showToast(`Copied ${filteredEvents.length} videos from ${label}!`);
    const btn = document.getElementById(label === 'Today' ? 'btn-copy-today' : 'btn-copy-yesterday');
    const oldText = btn.innerHTML;
    
    btn.classList.add('success');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
      Copied!
    `;
    setTimeout(() => {
      btn.classList.remove('success');
      btn.innerHTML = oldText;
    }, 1500);
  });
}

// Show a temporary action toast inside popup
function showToast(message) {
  const toast = document.getElementById('copy-status');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2000);
}

// Delete a single watch log timestamp (through the service worker, so it can't race a sync)
function deleteWatchEntry(videoId, timestamp) {
  chrome.runtime.sendMessage({ action: 'deleteWatch', videoId, timestamp }, (response) => {
    if (!response || !response.success) showToast(`Couldn't delete: ${response ? response.error : 'no answer'}`);
    loadHistory();
  });
}

// Export the entire history as a markdown file structured chronologically
function exportFullHistory() {
  if (allLogEvents.length === 0) {
    showToast('No history to export!');
    return;
  }

  // Group history by date
  const grouped = {};
  allLogEvents.forEach((event) => {
    const d = new Date(event.timestamp);
    const dateFormatted = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (!grouped[dateFormatted]) grouped[dateFormatted] = [];
    grouped[dateFormatted].push(event);
  });

  let fileContent = '# YouTube Watch History\n\nExported from WatchTree.\n\n';
  
  Object.keys(grouped).forEach((dateHeader) => {
    fileContent += `## ${dateHeader}\n\n`;
    grouped[dateHeader].forEach((event) => {
      const timeStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      const url = getEventUrl(event);
      const action = getEventActionLabel(event);
      fileContent += `- [ ] [${event.title}](${url}) - ${event.channel} (${action} at ${timeStr})\n`;
    });
    fileContent += '\n';
  });

  const blob = new Blob([fileContent], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  
  // Use extension download action
  const a = document.createElement('a');
  a.href = url;
  a.download = 'youtube-watch-history.md';
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 0);
  
  showToast('Markdown exported!');
}

// Google Takeout JSON (or this extension's own export) import
function handleFileImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // The same file can be picked again later.

  const statusEl = document.getElementById('import-status');
  const say = (text, kind) => {
    statusEl.textContent = text;
    statusEl.className = `import-status-text${kind ? ` ${kind}-import` : ''}`;
    statusEl.classList.remove('hidden');
  };
  say('Reading file...');

  const reader = new FileReader();
  reader.onload = function(evt) {
    let events;
    try {
      say('Parsing JSON history...');
      const raw = JSON.parse(evt.target.result);
      if (raw && !Array.isArray(raw) && raw.watches && raw.metadata) {
        // This extension's / the dashboard's own export: { watches, metadata }.
        events = [];
        Object.keys(raw.watches).forEach((videoId) => {
          const m = raw.metadata[videoId] || {};
          const approx = new Set(m.approx || []);
          (raw.watches[videoId] || []).forEach((timestamp) => events.push({ videoId, timestamp, title: m.title, channel: m.channel, duration: m.duration, isAd: m.isAd, isShort: m.isShort, approx: approx.has(timestamp) }));
        });
      } else {
        events = globalThis.YTCore.eventsFromTakeout(raw);
      }
      if (events.length === 0) throw new Error('No valid YouTube watch logs found in this file.');
    } catch (err) {
      say(`Error: ${err.message}`, 'error');
      console.error('[WatchTree] Import error:', err);
      return;
    }

    say(`Merging ${events.length.toLocaleString()} history records...`);
    chrome.runtime.sendMessage({ action: 'batchImportHistory', events }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        const why = chrome.runtime.lastError ? chrome.runtime.lastError.message : response ? response.error : 'Storage save failed.';
        say(`Error: ${why}`, 'error');
        return;
      }
      const skipped = events.length - response.addedCount - (response.replacedCount || 0);
      say(`Added ${response.addedCount.toLocaleString()} new watch events${skipped > 0 ? ` (${skipped.toLocaleString()} were already logged)` : ''}.`, 'success');
      loadHistory(); // Reload and redraw popup
    });
  };

  reader.onerror = function() {
    say('Failed to read history file.', 'error');
  };

  reader.readAsText(file);
}

// Helpers for Search & Visit event parsing in popup
function getEventUrl(event) {
  if (event.videoId.startsWith('search:')) {
    const query = decodeURIComponent(event.videoId.substring(7));
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }
  if (event.videoId.startsWith('visit:')) {
    const link = event.title.startsWith('Visited ') ? event.title.substring(8).trim() : '';
    // Only web links (a file could carry a javascript: link).
    return /^https?:\/\//i.test(link) ? link : `https://www.google.com`;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(event.videoId)}`;
}

function getEventActionLabel(event) {
  if (event.videoId.startsWith('search:')) return 'searched';
  if (event.videoId.startsWith('visit:')) return 'visited';
  return 'watched';
}

function getEventIcon(event) {
  if (event.videoId.startsWith('search:')) {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
    </svg>`;
  }
  if (event.videoId.startsWith('visit:')) {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
    <path d="M8 5v14l11-7z"/>
  </svg>`;
}

function renderTopVideos(resetPagination = true) {
  if (resetPagination) {
    statsPaginatedLimit = 50;
  }
  const listEl = document.getElementById('top-videos-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  // Toggle "Reset Hidden" button visibility based on whether we have ignored items
  const resetIgnoredBtn = document.getElementById('btn-reset-ignored');
  if (resetIgnoredBtn) {
    if (ignoredVideoIds.length > 0) {
      resetIgnoredBtn.classList.remove('hidden');
    } else {
      resetIgnoredBtn.classList.add('hidden');
    }
  }

  // Get timeframe filter selection (cutoff calculation / custom dates)
  const timeframeSelect = document.getElementById('stats-timeframe-select');
  const timeframeVal = timeframeSelect ? timeframeSelect.value : 'all';
  
  let startTime = 0;
  let endTime = Infinity;
  
  if (timeframeVal === 'custom') {
    const startDateInput = document.getElementById('stats-start-date');
    const endDateInput = document.getElementById('stats-end-date');
    const startVal = startDateInput ? startDateInput.value : '';
    const endVal = endDateInput ? endDateInput.value : '';
    
    if (startVal) {
      const parts = startVal.split('-');
      if (parts.length === 3) {
        startTime = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0).getTime();
      }
    }
    if (endVal) {
      const parts = endVal.split('-');
      if (parts.length === 3) {
        endTime = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 23, 59, 59, 999).getTime();
      }
    }
  } else if (timeframeVal !== 'all') {
    const days = parseInt(timeframeVal) || 30;
    startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  }

  // Get dynamic display limit (X variable)
  const limitInput = document.getElementById('stats-limit-input');
  const limitVal = limitInput ? limitInput.value.trim() : '10';
  const limit = limitVal === '∞' || limitVal.toLowerCase() === 'infinity' ? Infinity : (parseInt(limitVal) || 10);

  const { watches, metadata } = watchHistory;
  
  // Group by Channel if Late-Night Index is enabled and Group by Channel is checked
  if (statsLateNightEnabled && statsLateNightGroupChannel) {
    const channelStatsMap = {};
    Object.keys(watches).forEach((videoId) => {
      if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
      if (ignoredVideoIds.includes(videoId)) return;

      const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };

      // Search query filter
      if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) {
        return;
      }

      // Ignore Google Ads items
      const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
      if (isAd) return;

      const rawTimestamps = watches[videoId] || [];
      let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
      timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, statsLateNightStart, statsLateNightEnd));
      
      if (timestamps.length === 0) return;

      const channelName = meta.channel || 'Unknown Channel';
      if (!channelStatsMap[channelName]) {
        channelStatsMap[channelName] = {
          channel: channelName,
          count: 0,
          videos: {}
        };
      }
      
      channelStatsMap[channelName].count += timestamps.length;
      if (!channelStatsMap[channelName].videos[videoId]) {
        channelStatsMap[channelName].videos[videoId] = {
          videoId: videoId,
          title: meta.title,
          count: 0
        };
      }
      channelStatsMap[channelName].videos[videoId].count += timestamps.length;
    });

    const channelStats = Object.values(channelStatsMap);
    let filteredChannelStats = channelStats.filter(c => c.count >= statsMinWatches);
    filteredChannelStats.sort((a, b) => b.count - a.count);
    const topXChannels = filteredChannelStats.slice(0, limit);

    if (topXChannels.length === 0) {
      listEl.innerHTML = '<li class="empty-stats">No channel watch data matches this timeframe/Late-Night filter.</li>';
      return;
    }

    const renderLimit = statsPaginateAlways ? Math.min(limit, statsPaginatedLimit) : limit;
    const channelsToRender = topXChannels.slice(0, renderLimit);

    channelsToRender.forEach((channelData, index) => {
      const li = document.createElement('li');
      li.className = 'stats-item channel-group-item';
      li.style.flexDirection = 'column';
      li.style.alignItems = 'stretch';
      li.style.gap = '6px';
      li.style.padding = '10px';

      const headerDiv = document.createElement('div');
      headerDiv.style.display = 'flex';
      headerDiv.style.justifyContent = 'space-between';
      headerDiv.style.alignItems = 'center';
      
      const channelTitleSpan = document.createElement('span');
      channelTitleSpan.style.fontWeight = 'bold';
      channelTitleSpan.style.color = '#c084fc';
      channelTitleSpan.style.fontSize = '12px';
      channelTitleSpan.textContent = `${index + 1}. ${channelData.channel}`;

      const countSpan = document.createElement('span');
      countSpan.className = 'stats-count';
      countSpan.style.background = 'rgba(168, 85, 247, 0.15)';
      countSpan.style.color = '#c084fc';
      countSpan.style.border = '1px solid rgba(168, 85, 247, 0.3)';
      countSpan.style.borderRadius = '6px';
      countSpan.style.padding = '2px 6px';
      countSpan.style.fontSize = '10px';
      countSpan.textContent = `${channelData.count} watches`;

      headerDiv.appendChild(channelTitleSpan);
      headerDiv.appendChild(countSpan);
      li.appendChild(headerDiv);

      const videoSubList = document.createElement('div');
      videoSubList.style.marginTop = '4px';
      videoSubList.style.paddingLeft = '12px';
      videoSubList.style.borderLeft = '1px dashed rgba(255, 255, 255, 0.15)';
      videoSubList.style.display = 'flex';
      videoSubList.style.flexDirection = 'column';
      videoSubList.style.gap = '4px';

      const sortedVideos = Object.values(channelData.videos).sort((a, b) => b.count - a.count);
      sortedVideos.forEach(v => {
        const vDiv = document.createElement('div');
        vDiv.style.display = 'flex';
        vDiv.style.justifyContent = 'space-between';
        vDiv.style.fontSize = '10px';
        vDiv.style.color = 'var(--color-text-secondary)';

        const titleText = document.createElement('span');
        titleText.style.overflow = 'hidden';
        titleText.style.textOverflow = 'ellipsis';
        titleText.style.whiteSpace = 'nowrap';
        titleText.style.maxWidth = '250px';

        const url = getEventUrl({ videoId: v.videoId });
        titleText.innerHTML = `<a href="${esc(url)}" target="_blank" style="color: inherit; text-decoration: none; transition: color 0.15s ease;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='inherit'">${esc(v.title)}</a>`;

        const vCount = document.createElement('span');
        vCount.style.color = 'var(--color-text-muted)';
        vCount.textContent = `x${v.count}`;

        vDiv.appendChild(titleText);
        vDiv.appendChild(vCount);
        videoSubList.appendChild(vDiv);
      });

      li.appendChild(videoSubList);
      listEl.appendChild(li);
    });

    // Append a Load More button if there are more items to display
    if (topXChannels.length > renderLimit) {
      const loadMoreLi = document.createElement('li');
      loadMoreLi.className = 'load-more-item';
      loadMoreLi.style.listStyle = 'none';
      loadMoreLi.style.padding = '12px 20px';
      loadMoreLi.style.textAlign = 'center';

      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'btn secondary';
      loadMoreBtn.style.width = '100%';
      loadMoreBtn.style.justifyContent = 'center';
      loadMoreBtn.style.padding = '10px 16px';
      loadMoreBtn.style.borderRadius = '10px';
      loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
      loadMoreBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
      loadMoreBtn.style.color = '#e5e7eb';
      loadMoreBtn.style.fontSize = '12px';
      loadMoreBtn.style.fontWeight = '600';
      loadMoreBtn.style.cursor = 'pointer';
      loadMoreBtn.style.transition = 'all 0.15s ease';
      loadMoreBtn.textContent = `Load More (+${Math.min(topXChannels.length - renderLimit, 50)})`;

      loadMoreBtn.addEventListener('mouseenter', () => {
        loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.08)';
        loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
      });

      loadMoreBtn.addEventListener('mouseleave', () => {
        loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
        loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      });

      loadMoreBtn.addEventListener('click', () => {
        statsPaginatedLimit += 50;
        renderTopVideos(false);
      });

      loadMoreLi.appendChild(loadMoreBtn);
      listEl.appendChild(loadMoreLi);
    }

    return;
  }

  // Create a list of video watch counts
  const videoStats = [];
  Object.keys(watches).forEach((videoId) => {
    // Ignore search, ad clicks, and user-ignored items
    if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
    if (ignoredVideoIds.includes(videoId)) return;

    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
    
    // Search query filter
    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) {
      return;
    }
    
    // Ignore Google Ads items
    const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
    if (isAd) return;
    
    // Filter timestamps based on the selected timeframe/custom date range
    const rawTimestamps = watches[videoId] || [];
    let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
    if (statsLateNightEnabled) {
      timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, statsLateNightStart, statsLateNightEnd));
    }
    if (timestamps.length === 0) return;
    
    // Calculate first and last watch dates in this timeframe window
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    const firstSeen = sortedTimestamps[0];
    const lastSeen = sortedTimestamps[sortedTimestamps.length - 1];
    
    // Calculate day span
    const diffMs = lastSeen - firstSeen;
    const displayDiffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    
    // Calculate ratio (rewatches count / span of days)
    const ratioDivisor = Math.max(1, displayDiffDays);
    const ratio = timestamps.length / ratioDivisor;
    
    // Apply criteria settings (minimum watches and minimum span in days)
    if (timestamps.length < statsMinWatches) return;
    if (displayDiffDays < statsMinSpan) return;

    videoStats.push({
      videoId,
      title: meta.title,
      channel: meta.channel,
      count: timestamps.length,
      firstSeen,
      lastSeen,
      displayDiffDays,
      ratio
    });
  });

  // Sort based on statsRankingMode (count or ratio)
  videoStats.sort((a, b) => {
    if (statsRankingMode === 'ratio') {
      if (b.ratio !== a.ratio) {
        return b.ratio - a.ratio;
      }
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.lastSeen - a.lastSeen;
    } else {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.lastSeen - a.lastSeen;
    }
  });

  // Take top X
  const topX = videoStats.slice(0, limit);

  if (topX.length === 0) {
    listEl.innerHTML = '<li class="empty-stats">No watch data matches this timeframe filter.</li>';
    return;
  }

  const renderLimit = statsPaginateAlways ? Math.min(limit, statsPaginatedLimit) : limit;
  const videosToRender = topX.slice(0, renderLimit);

  videosToRender.forEach((video, index) => {
    const li = document.createElement('li');
    li.className = 'stats-item';

    const firstDate = new Date(video.firstSeen);
    const lastDate = new Date(video.lastSeen);
    
    const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    
    // Format duration description
    let spanStr = '';
    if (video.displayDiffDays === 0) {
      spanStr = 'Watched on a single day';
    } else {
      spanStr = `Span of ${video.displayDiffDays} day${video.displayDiffDays > 1 ? 's' : ''}`;
    }

    // Calculate months from last seen date to the current day
    const msAgo = Date.now() - video.lastSeen;
    const daysAgo = msAgo / (1000 * 60 * 60 * 24);
    const monthsAgo = (daysAgo / 30.44).toFixed(1);
    const lastSeenMonthsAgoStr = `Last seen ${monthsAgo} month${monthsAgo === '1.0' ? '' : 's'} ago`;

    const url = getEventUrl(video);

    // Format badge based on current stats mode
    const countBadge = statsRankingMode === 'ratio'
      ? `<span class="stats-watches-count" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border-color: rgba(168, 85, 247, 0.3); font-size: 9px;">Ratio: ${video.ratio.toFixed(2)}/day (${video.count} watches)</span>`
      : `<span class="stats-watches-count">${video.count} watches</span>`;

    let mediaHtml = '';
    const isNormalVideo = !video.videoId.startsWith('search:') && !video.videoId.startsWith('visit:');
    if (showThumbnails && isNormalVideo) {
      const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
      if (statsEmbedPlayer && isFullscreen) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: #000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${video.videoId}?rel=0&modestbranding=1&enablejsapi=1&origin=https%3A%2F%2Fwww.youtube-nocookie.com" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border: none; width: 100%; height: 100%;"></iframe>
          </div>
        `;
      } else {
        const thumbnailUrl = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 4px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.2);">
            <img src="${thumbnailUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="thumbnail" loading="lazy">
          </div>
        `;
      }
    }

    li.innerHTML = `
      <div class="stats-rank-badge rank-${index + 1}">#${index + 1}</div>
      ${mediaHtml}
      <div class="stats-info">
        <h4 class="stats-title">
          <a href="${esc(url)}" target="_blank" title="${esc(video.title)}">${esc(video.title)}</a>${labelBadge(videoLabels[video.videoId])}
        </h4>
        <div class="stats-meta">
          <span class="stats-channel">${esc(video.channel)}</span>
          ${countBadge}
        </div>
        <div class="stats-timeline">
          <span class="timeline-date">${firstStr}</span>
          <span class="timeline-arrow">→</span>
          <span class="timeline-date">${lastStr}</span>
          <span class="timeline-duration">(${spanStr})</span>
        </div>
        <div class="stats-last-seen" style="font-size: 8.5px; color: var(--color-text-muted); font-weight: 500; margin-top: 1px;">
          • ${lastSeenMonthsAgoStr}
        </div>
      </div>
      <div class="stats-actions" style="margin-left: 8px; flex-shrink: 0; display: flex; gap: 4px; align-items: center;">
        <button class="icon-btn calendar-btn" title="Open Watch History Calendar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm-5-7h-5v5h5v-5z"/>
          </svg>
        </button>
        <button class="icon-btn discard-ad-btn" title="Mark as Ad / Discard">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/>
          </svg>
        </button>
      </div>
    `;

    // Attach calendar click listener
    const calendarBtn = li.querySelector('.calendar-btn');
    if (calendarBtn) {
      calendarBtn.addEventListener('click', () => {
        openVideoCalendarModal(video.videoId, video.title, video.channel);
      });
    }

    // Attach Discard / Mark as Ad listener
    const discardBtn = li.querySelector('.discard-ad-btn');
    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        const titleStr = video.title.length > 30 ? video.title.substring(0, 27) + '...' : video.title;
        if (confirm(`Discard "${titleStr}" from top repeat stats? (It will be hidden from stats, but remain in history)`)) {
          ignoredVideoIds.push(video.videoId);
          chrome.storage.local.set({ ignoredVideoIds }, () => {
            renderTopVideos();
            renderShiftAnalysis();
            renderPhaseDetector();
            renderFormatShiftAnalysis();
            showToast('Video hidden from stats!');
          });
        }
      });
    }

    listEl.appendChild(li);
  });

  // Append a Load More button if there are more items to display
  if (topX.length > renderLimit) {
    const loadMoreLi = document.createElement('li');
    loadMoreLi.className = 'load-more-item';
    loadMoreLi.style.listStyle = 'none';
    loadMoreLi.style.padding = '12px 20px';
    loadMoreLi.style.textAlign = 'center';

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn secondary';
    loadMoreBtn.style.width = '100%';
    loadMoreBtn.style.justifyContent = 'center';
    loadMoreBtn.style.padding = '10px 16px';
    loadMoreBtn.style.borderRadius = '10px';
    loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
    loadMoreBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    loadMoreBtn.style.color = '#e5e7eb';
    loadMoreBtn.style.fontSize = '12px';
    loadMoreBtn.style.fontWeight = '600';
    loadMoreBtn.style.cursor = 'pointer';
    loadMoreBtn.style.transition = 'all 0.15s ease';
    loadMoreBtn.textContent = `Load More (+${Math.min(topX.length - renderLimit, 50)})`;

    loadMoreBtn.addEventListener('mouseenter', () => {
      loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.08)';
      loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    });

    loadMoreBtn.addEventListener('mouseleave', () => {
      loadMoreBtn.style.background = 'rgba(255, 255, 255, 0.04)';
      loadMoreBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    });

    loadMoreBtn.addEventListener('click', () => {
      statsPaginatedLimit += 50;
      renderTopVideos(false);
    });

    loadMoreLi.appendChild(loadMoreBtn);
    listEl.appendChild(loadMoreLi);
  }

  if (focusTopVideos) {
    renderHeatmap(currentSelectedYear);
  }
}

function renderTopAds() {
  const listEl = document.getElementById('top-ads-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const searchInput = document.getElementById('stats-search-input');
  const searchQuery = searchInput ? searchInput.value.trim() : '';

  const { watches, metadata } = watchHistory;
  
  // Create a list of ad watch counts
  const adStats = [];
  Object.keys(watches).forEach((videoId) => {
    // If it is search, skip
    if (videoId.startsWith('search:')) return;
    
    const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };

    // Search query filter
    if (searchQuery && !matchSearchQuery(meta.title, meta.channel, searchQuery)) {
      return;
    }
    
    // Check if it is an ad
    const isAd = videoId.startsWith('visit:') || meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
    if (!isAd) return; // Skip normal videos!

    const timestamps = watches[videoId] || [];
    if (timestamps.length === 0) return;
    
    // Calculate first and last watch dates
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    const firstSeen = sortedTimestamps[0];
    const lastSeen = sortedTimestamps[sortedTimestamps.length - 1];
    
    adStats.push({
      videoId,
      title: meta.title,
      channel: meta.channel,
      count: timestamps.length,
      firstSeen,
      lastSeen
    });
  });

  // Sort by count descending
  adStats.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return b.lastSeen - a.lastSeen;
  });

  // Take top 5 ads
  const top5Ads = adStats.slice(0, 5);

  if (top5Ads.length === 0) {
    listEl.innerHTML = '<li class="empty-stats">No advertisement data recorded.</li>';
    return;
  }

  top5Ads.forEach((ad, index) => {
    const li = document.createElement('li');
    li.className = 'stats-item';

    const firstDate = new Date(ad.firstSeen);
    const lastDate = new Date(ad.lastSeen);
    
    const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    
    // Calculate day span
    const diffMs = ad.lastSeen - ad.firstSeen;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    
    let spanStr = '';
    if (diffDays === 0) {
      spanStr = 'Served on a single day';
    } else {
      spanStr = `Active for ${diffDays} day${diffDays > 1 ? 's' : ''}`;
    }

    // Calculate months from last seen date to the current day
    const msAgo = Date.now() - ad.lastSeen;
    const daysAgo = msAgo / (1000 * 60 * 60 * 24);
    const monthsAgo = (daysAgo / 30.44).toFixed(1);
    const lastSeenMonthsAgoStr = `Last seen ${monthsAgo} month${monthsAgo === '1.0' ? '' : 's'} ago`;

    const url = getEventUrl(ad);

    let mediaHtml = '';
    const isNormalVideo = !ad.videoId.startsWith('search:') && !ad.videoId.startsWith('visit:');
    if (showThumbnails && isNormalVideo) {
      const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
      if (statsEmbedPlayer && isFullscreen) {
        mediaHtml = `
          <div class="history-embed-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: #000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
            <iframe width="100%" height="100%" src="https://www.youtube-nocookie.com/embed/${ad.videoId}?rel=0&modestbranding=1&enablejsapi=1&origin=https%3A%2F%2Fwww.youtube-nocookie.com" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border: none; width: 100%; height: 100%;"></iframe>
          </div>
        `;
      } else {
        const thumbnailUrl = `https://i.ytimg.com/vi/${ad.videoId}/mqdefault.jpg`;
        mediaHtml = `
          <div class="history-thumbnail-container" style="flex-shrink: 0; margin-right: 8px; border-radius: 4px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.2);">
            <img src="${thumbnailUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="thumbnail" loading="lazy">
          </div>
        `;
      }
    }

    li.innerHTML = `
      <div class="stats-rank-badge rank-${index + 1}">#${index + 1}</div>
      ${mediaHtml}
      <div class="stats-info">
        <h4 class="stats-title">
          <a href="${esc(url)}" target="_blank" title="${esc(ad.title)}">${esc(ad.title)}</a>
        </h4>
        <div class="stats-meta">
          <span class="stats-channel">${esc(ad.channel)}</span>
          <span class="stats-watches-count" style="color: #ef4444; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2);">${ad.count} impressions</span>
        </div>
        <div class="stats-timeline">
          <span class="timeline-date">${firstStr}</span>
          <span class="timeline-arrow">→</span>
          <span class="timeline-date">${lastStr}</span>
          <span class="timeline-duration">(${spanStr})</span>
        </div>
        <div class="stats-last-seen" style="font-size: 8.5px; color: var(--color-text-muted); font-weight: 500; margin-top: 1px;">
          • ${lastSeenMonthsAgoStr}
        </div>
      </div>
      <div class="stats-actions" style="margin-left: 8px; flex-shrink: 0;">
        <button class="icon-btn delete-btn delete-ad-btn" title="Delete Ad Event">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </button>
      </div>
    `;

    // Attach Delete Ad listener
    const deleteBtn = li.querySelector('.delete-ad-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const titleStr = ad.title.length > 30 ? ad.title.substring(0, 27) + '...' : ad.title;
        if (confirm(`Delete ad "${titleStr}" from database?`)) {
          chrome.runtime.sendMessage({ action: 'clearVideoHistory', videoId: ad.videoId }, () => {
            loadHistory();
            showToast('Ad video removed!');
          });
        }
      });
    }

    listEl.appendChild(li);
  });
}

function updateHistoryZoomVisibility() {
  const isFullscreen = new URLSearchParams(window.location.search).get('mode') === 'fullscreen' || window.innerWidth > 600;
  
  const chkEmbed = document.getElementById('chk-embed-player');
  const chkStatsEmbed = document.getElementById('chk-stats-embed-player');
  
  // Sync checkbox states
  if (chkEmbed) chkEmbed.checked = embedPlayer;
  if (chkStatsEmbed) chkStatsEmbed.checked = statsEmbedPlayer;

  const zoomControl = document.getElementById('history-zoom-control');
  const statsZoomControl = document.getElementById('stats-zoom-control');
  
  const showZoom = embedPlayer && isFullscreen && showThumbnails;
  const showStatsZoom = statsEmbedPlayer && isFullscreen && showThumbnails;

  if (zoomControl) {
    if (showZoom) {
      zoomControl.classList.remove('hidden');
    } else {
      zoomControl.classList.add('hidden');
    }
  }
  
  if (statsZoomControl) {
    if (showStatsZoom) {
      statsZoomControl.classList.remove('hidden');
    } else {
      statsZoomControl.classList.add('hidden');
    }
  }

  // Also sync label displays for playable video checkboxes
  const lblEmbedPlayer = document.getElementById('lbl-embed-player');
  const lblStatsEmbedPlayer = document.getElementById('lbl-stats-embed-player');
  const showEmbedLabel = showThumbnails && isFullscreen;
  if (lblEmbedPlayer) {
    lblEmbedPlayer.style.display = showEmbedLabel ? 'flex' : 'none';
  }
  if (lblStatsEmbedPlayer) {
    lblStatsEmbedPlayer.style.display = showEmbedLabel ? 'flex' : 'none';
  }

  if (showZoom) {
    document.body.style.setProperty('--zoom-scale', historyZoom);
  } else {
    document.body.style.removeProperty('--zoom-scale');
  }
}

function handleThumbnailsChange(checked) {
  showThumbnails = checked;
  
  // Sync checkboxes
  const chkThumbnails = document.getElementById('chk-show-thumbnails');
  const chkStatsThumbnails = document.getElementById('chk-stats-show-thumbnails');
  if (chkThumbnails) chkThumbnails.checked = checked;
  if (chkStatsThumbnails) chkStatsThumbnails.checked = checked;

  chrome.storage.local.set({ showThumbnails }, () => {
    updateHistoryZoomVisibility();
    
    // Re-render history list
    const searchInput = document.getElementById('search-input');
    const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const filtered = query
      ? allLogEvents.filter(
          (event) =>
            event.title.toLowerCase().includes(query) ||
            event.channel.toLowerCase().includes(query)
        )
      : allLogEvents;
    renderHistoryList(filtered);
    
    // Re-render stats lists
    renderTopVideos();
    renderTopAds();
  });
}

function handleEmbedPlayerChange(checked) {
  embedPlayer = checked;
  
  const chkEmbedPlayer = document.getElementById('chk-embed-player');
  if (chkEmbedPlayer) chkEmbedPlayer.checked = checked;

  chrome.storage.local.set({ embedPlayer }, () => {
    updateHistoryZoomVisibility();
    
    // Re-render history list
    const searchInput = document.getElementById('search-input');
    const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const filtered = query
      ? allLogEvents.filter(
          (event) =>
            event.title.toLowerCase().includes(query) ||
            event.channel.toLowerCase().includes(query)
        )
      : allLogEvents;
    renderHistoryList(filtered);
  });
}

function handleStatsEmbedPlayerChange(checked) {
  statsEmbedPlayer = checked;
  
  const chkStatsEmbedPlayer = document.getElementById('chk-stats-embed-player');
  if (chkStatsEmbedPlayer) chkStatsEmbedPlayer.checked = checked;

  chrome.storage.local.set({ statsEmbedPlayer }, () => {
    updateHistoryZoomVisibility();
    
    // Re-render stats lists
    renderTopVideos();
    renderTopAds();
  });
}

function handleZoomSliderInput(val) {
  historyZoom = val;
  
  // Sync slider elements
  const zoomSlider = document.getElementById('history-zoom-slider');
  const statsZoomSlider = document.getElementById('stats-zoom-slider');
  if (zoomSlider) zoomSlider.value = val;
  if (statsZoomSlider) statsZoomSlider.value = val;
  
  // Sync text indicators
  const zoomValText = document.getElementById('history-zoom-val');
  const statsZoomValText = document.getElementById('stats-zoom-val');
  if (zoomValText) zoomValText.textContent = `${val.toFixed(1)}x`;
  if (statsZoomValText) statsZoomValText.textContent = `${val.toFixed(1)}x`;
  
  document.body.style.setProperty('--zoom-scale', val);
}

function handleZoomSliderChange() {
  chrome.storage.local.set({ historyZoom });
}

function openVideoCalendarModal(videoId, title, channel) {
  // Remove existing modal if any
  const existingOverlay = document.getElementById('yt-tracker-modal-overlay');
  if (existingOverlay) existingOverlay.remove();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'yt-tracker-modal-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.background = 'rgba(8, 10, 15, 0.85)';
  overlay.style.backdropFilter = 'blur(12px)';
  overlay.style.webkitBackdropFilter = 'blur(12px)';
  overlay.style.zIndex = '10000';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';

  // Get watches for this video ID
  const allWatches = watchHistory.watches[videoId] || [];
  const currentVideoHistory = [...allWatches].sort((a, b) => b - a);

  // Stats
  const count = currentVideoHistory.length;
  const lastWatchedStr = count > 0 
    ? new Date(currentVideoHistory[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Never';

  const modal = document.createElement('div');
  modal.id = 'yt-tracker-modal';
  modal.style.background = 'rgba(20, 24, 38, 0.98)';
  modal.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  modal.style.borderRadius = '18px';
  modal.style.width = '90%';
  modal.style.maxWidth = '820px';
  modal.style.maxHeight = '90vh';
  modal.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  modal.style.overflow = 'hidden';
  modal.style.color = '#f3f4f6';
  modal.style.fontFamily = 'var(--font-primary, sans-serif)';

  // Build inside HTML
  modal.innerHTML = `
    <div class="yt-tracker-modal-header" style="padding: 16px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); display: flex; justify-content: space-between; align-items: flex-start; background: rgba(255, 255, 255, 0.01);">
      <div class="yt-tracker-modal-title-group" style="display: flex; flex-direction: column; max-width: 320px; text-align: left;">
        <h3 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 700; color: #ffffff;">Watch History Calendar</h3>
        <p class="yt-tracker-video-title" style="margin: 0 0 2px 0; font-size: 12px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${esc(title)}">${esc(title)}</p>
        <p class="yt-tracker-video-channel" style="margin: 0; font-size: 10px; color: #6366f1; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${esc(channel)}</p>
      </div>
      <button class="yt-tracker-close-btn" style="background: transparent; border: none; color: #9ca3af; font-size: 24px; cursor: pointer; line-height: 1; padding: 0; margin: 0; transition: color 0.15s;">&times;</button>
    </div>
    
    <div class="yt-tracker-modal-body" style="padding: 16px 20px; overflow-y: auto; max-height: calc(90vh - 80px);">
      <div class="yt-tracker-modal-layout">
        
        <!-- Left Side: Calendar Heatmap -->
        <div class="yt-tracker-modal-left">
          <div class="yt-tracker-calendar-container" style="background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.04); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; text-align: left;">
            <div class="yt-tracker-calendar-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <h4 style="margin: 0; font-size: 12px; font-weight: 600; color: #fff;">Watch Calendar</h4>
            </div>
            <div id="modal-calendar-years-row" style="display: flex; gap: 6px; margin: 4px 0 8px 0; align-items: center; justify-content: flex-start; flex-wrap: wrap;"></div>
            <div class="scrollable-calendar" style="max-height: none; overflow-y: visible; padding-right: 0;">
              <div id="modal-calendar-vertical-list" class="yt-calendar-vertical-list" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;"></div>
            </div>
            <!-- Legend -->
            <div class="yt-tracker-calendar-legend" style="display: flex; align-items: center; justify-content: space-between; margin-top: 8px; font-size: 8px; color: rgba(255, 255, 255, 0.45); font-weight: 500;">
              <span style="flex-shrink: 0;">0h (Midnight)</span>
              <div style="flex-grow: 1; height: 4px; margin: 0 4px; border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(to right, hsla(240, 85%, 60%, 0.55) 0%, hsla(150, 85%, 60%, 0.55) 50%, hsla(60, 85%, 60%, 0.55) 100%);"></div>
              <span style="flex-shrink: 0;">12h</span>
              <div style="flex-grow: 1; height: 4px; margin: 0 4px; border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(to right, hsla(60, 85%, 60%, 0.55) 0%, hsla(330, 85%, 60%, 0.55) 50%, hsla(240, 85%, 60%, 0.55) 100%);"></div>
              <span style="flex-shrink: 0;">24h</span>
            </div>
          </div>
        </div>
        
        <!-- Right Side: Stats Summary & Scrollable History -->
        <div class="yt-tracker-modal-right">
          <div class="yt-tracker-summary-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div class="yt-tracker-stat-box" style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <span class="yt-tracker-stat-value" style="font-size: 18px; font-weight: 800; color: #a5b4fc; background: linear-gradient(135deg, #a5b4fc, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">${count}</span>
              <span class="yt-tracker-stat-label" style="font-size: 8px; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-top: 2px; letter-spacing: 0.08em;">Total Watches</span>
            </div>
            <div class="yt-tracker-stat-box" style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <span class="yt-tracker-stat-value" style="font-size: 18px; font-weight: 800; color: #c084fc; background: linear-gradient(135deg, #a5b4fc, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px;" title="${lastWatchedStr}">${lastWatchedStr}</span>
              <span class="yt-tracker-stat-label" style="font-size: 8px; font-weight: 600; text-transform: uppercase; color: #6b7280; margin-top: 2px; letter-spacing: 0.08em;">Last Watched</span>
            </div>
          </div>
          
          <div class="yt-tracker-history-list-section" style="display: flex; flex-direction: column; text-align: left;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: #fff;">Detailed History</h4>
            <ul class="yt-tracker-history-list" style="list-style: none; padding: 0; margin: 0; max-height: 250px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; background: rgba(255, 255, 255, 0.01);">
              ${currentVideoHistory.map(ts => {
                const date = new Date(ts);
                const dateS = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                const timeS = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                return `<li style="padding: 6px 12px; font-size: 11px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); display: flex; justify-content: space-between;"><strong>${dateS}</strong> <span style="color: #9ca3af;">at ${timeS}</span></li>`;
              }).join('')}
            </ul>
          </div>
        </div>
        
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close event listeners
  const closeModal = () => overlay.remove();
  overlay.querySelector('.yt-tracker-close-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Now, render the years row and the calendar grid!
  const uniqueYears = new Set();
  const yearCounts = {};
  const watchedDates = {}; // Formatted: { "YYYY-MM-DD": [ts1, ts2, ...] }
  allWatches.forEach(ts => {
    const dt = new Date(ts);
    const yr = dt.getFullYear();
    uniqueYears.add(yr);
    yearCounts[yr] = (yearCounts[yr] || 0) + 1;

    // Local Date Str
    const dateStr = getLocalDateString(dt);
    if (!watchedDates[dateStr]) watchedDates[dateStr] = [];
    watchedDates[dateStr].push(ts);
  });

  const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);
  if (sortedYears.length === 0) {
    sortedYears.push(new Date().getFullYear());
  }

  let selectedYear = sortedYears[sortedYears.length - 1];

  const buildModalCalendarGrid = (year) => {
    const listContainer = modal.querySelector('#modal-calendar-vertical-list');
    listContainer.innerHTML = '';

    // Loop through 12 months (0 to 11)
    for (let month = 0; month <= 11; month++) {
      const targetDate = new Date(year, month, 1);
      
      const monthBlock = document.createElement('div');
      monthBlock.className = 'yt-calendar-month-block';
      monthBlock.style.background = 'rgba(255, 255, 255, 0.01)';
      monthBlock.style.border = '1px solid rgba(255, 255, 255, 0.04)';
      monthBlock.style.borderRadius = '6px';
      monthBlock.style.padding = '4px 6px';

      const monthHeader = document.createElement('div');
      monthHeader.className = 'yt-calendar-month-name';
      monthHeader.style.fontSize = '9px';
      monthHeader.style.fontWeight = '700';
      monthHeader.style.color = '#ffffff';
      monthHeader.style.marginBottom = '3px';
      monthHeader.textContent = targetDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      monthBlock.appendChild(monthHeader);

      const weekdaysRow = document.createElement('div');
      weekdaysRow.className = 'yt-calendar-weekdays-row';
      weekdaysRow.style.display = 'grid';
      weekdaysRow.style.gridTemplateColumns = 'repeat(7, 1fr)';
      weekdaysRow.style.fontSize = '7px';
      weekdaysRow.style.color = '#6b7280';
      weekdaysRow.style.textAlign = 'center';
      weekdaysRow.style.marginBottom = '2px';
      ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(day => {
        const span = document.createElement('span');
        span.textContent = day;
        weekdaysRow.appendChild(span);
      });
      monthBlock.appendChild(weekdaysRow);

      const daysGrid = document.createElement('div');
      daysGrid.className = 'yt-calendar-days-grid';
      daysGrid.style.display = 'grid';
      daysGrid.style.gridTemplateColumns = 'repeat(7, 1fr)';
      daysGrid.style.gap = '1.5px';

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
        cell.style.aspectRatio = '1 / 1';
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        cell.style.fontSize = '7px';
        cell.style.borderRadius = '2px';
        cell.style.userSelect = 'none';
        cell.textContent = day;

        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const watchesOnDay = watchedDates[dateStr] || [];

        if (watchesOnDay.length > 0) {
          cell.classList.add('cell-watched');
          cell.style.fontWeight = '700';
          cell.style.cursor = 'pointer';

          // Color calculation based on the average watch hour to match content.js
          const hours = watchesOnDay.map(ts => new Date(ts).getHours());
          const avgHour = hours.reduce((sum, h) => sum + h, 0) / hours.length;
          
          let hue = 240;
          if (avgHour < 12) {
            hue = Math.floor(240 - (avgHour / 12) * 180);
          } else {
            hue = Math.floor(60 + ((avgHour - 12) / 12) * 180);
          }

          cell.style.background = `hsla(${hue}, 85%, 60%, 0.45)`;
          cell.style.border = '1px solid rgba(255, 255, 255, 0.1)';
          cell.style.color = '#ffffff';

          cell.addEventListener('mouseenter', () => {
            cell.style.transform = 'scale(1.15)';
            cell.style.zIndex = '2';
            cell.style.boxShadow = `0 0 8px hsla(${hue}, 85%, 60%, 0.6)`;

            if (!cell.title) {
              const cellDate = new Date(year, month, day);
              const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              let tooltipText = `${dateFormatted}\nWatched ${watchesOnDay.length} time(s):\n`;
              watchesOnDay.forEach(ts => {
                tooltipText += `• ${new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}\n`;
              });
              cell.title = tooltipText.trim();
            }
          });

          cell.addEventListener('mouseleave', () => {
            cell.style.transform = '';
            cell.style.zIndex = '';
            cell.style.boxShadow = '';
          });
        } else {
          cell.classList.add('cell-empty');
          cell.style.background = 'rgba(255, 255, 255, 0.02)';
          cell.style.color = '#4b5563';

          cell.addEventListener('mouseenter', () => {
            cell.style.background = 'rgba(255, 255, 255, 0.06)';
            cell.style.color = '#e5e7eb';
            cell.style.transform = 'scale(1.12)';
            cell.style.zIndex = '2';

            if (!cell.title) {
              const cellDate = new Date(year, month, day);
              cell.title = `${cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}\nNo activity`;
            }
          });

          cell.addEventListener('mouseleave', () => {
            cell.style.background = 'rgba(255, 255, 255, 0.02)';
            cell.style.color = '#4b5563';
            cell.style.transform = '';
            cell.style.zIndex = '';
          });
        }

        daysGrid.appendChild(cell);
      }

      monthBlock.appendChild(daysGrid);
      listContainer.appendChild(monthBlock);
    }
  };

  const renderYearsSelector = () => {
    const yearsRow = modal.querySelector('#modal-calendar-years-row');
    yearsRow.innerHTML = '';

    const maxCount = Math.max(...Object.values(yearCounts), 1);

    sortedYears.forEach(yr => {
      const count = yearCounts[yr] || 0;
      const ratio = count / maxCount;
      const hue = Math.floor(239 + ratio * 41);
      const alpha = 0.15 + ratio * 0.70;
      const lightness = Math.floor(67 - ratio * 12);

      const pill = document.createElement('button');
      pill.style.padding = '3px 8px';
      pill.style.fontSize = '9px';
      pill.style.borderRadius = '12px';
      pill.style.border = yr === selectedYear ? '2.5px solid #fff' : '1px solid rgba(255, 255, 255, 0.08)';
      pill.style.background = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;
      pill.style.color = yr === selectedYear ? '#fff' : '#a5b4fc';
      pill.style.fontWeight = 'bold';
      pill.style.cursor = 'pointer';
      pill.style.outline = 'none';

      pill.textContent = `${yr} (${count})`;

      pill.addEventListener('click', () => {
        selectedYear = yr;
        renderYearsSelector();
        buildModalCalendarGrid(yr);
      });

      yearsRow.appendChild(pill);
    });
  };

  renderYearsSelector();
  buildModalCalendarGrid(selectedYear);
}
