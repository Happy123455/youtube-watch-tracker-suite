// service-worker.js
import { recordWatch, getVideoHistory, clearVideoHistory, getHistory, batchImportHistory, clearAllHistory } from './utils/storage.js';

// Listen for SPA navigation events on YouTube
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && (details.url.includes('youtube.com/watch') || details.url.includes('youtube.com/shorts'))) {
    // Send a message to the content script that navigation occurred
    chrome.tabs.sendMessage(details.tabId, {
      action: 'urlChanged',
      url: details.url
    }).catch((err) => {
      // Ignore errors if the content script hasn't loaded yet or if the tab is inactive
      console.debug('Failed to send urlChanged message:', err.message);
    });
  }
});

// Handle runtime messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'recordWatch') {
    const { videoId, title, channel, duration } = message;
    recordWatch(videoId, title, channel, duration)
      .then((result) => {
        tryPushWatchToObsidian(videoId, title, channel, duration, result.timestamp);
        sendResponse({ success: true, ...result });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (message.action === 'getVideoHistory') {
    const { videoId } = message;
    getVideoHistory(videoId)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'getHistory') {
    getHistory()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'clearVideoHistory') {
    const { videoId } = message;
    clearVideoHistory(videoId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'batchImportHistory') {
    const { events } = message;
    batchImportHistory(events)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'clearAllHistory') {
    clearAllHistory()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'closeActiveTab') {
    chrome.action.setBadgeText({ text: '' });
    chrome.tabs.remove(sender.tab.id);
    return false;
  }

  if (message.action === 'updateSyncProgress') {
    const { count } = message;
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    
    // Track active sync tab in session storage in case tab is removed
    chrome.storage.session.set({ activeSyncTabId: sender.tab.id });
    return false;
  }

  if (message.action === 'clearSyncBadge') {
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.session.remove('activeSyncTabId');
    return false;
  }
});

// Clear badge if the sync tab is closed manually by the user
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const result = await chrome.storage.session.get('activeSyncTabId');
  if (result.activeSyncTabId === tabId) {
    chrome.action.setBadgeText({ text: '' });
    await chrome.storage.session.remove('activeSyncTabId');
  }
});

// Setup Declarative Net Request rules to modify Referer and Origin headers for YouTube embeds
async function setupRules() {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
        ]
      },
      condition: {
        urlFilter: 'youtube.com/embed/',
        resourceTypes: ['sub_frame']
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.youtube-nocookie.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.youtube-nocookie.com' }
        ]
      },
      condition: {
        urlFilter: 'youtube-nocookie.com/embed/',
        resourceTypes: ['sub_frame']
      }
    }
  ];

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map(r => r.id);
    
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
      addRules: rules
    });
    console.log('Successfully configured declarativeNetRequest rules for YouTube embeds.');
  } catch (error) {
    console.error('Failed to configure declarativeNetRequest rules:', error);
  }
}

// Call setupRules on service worker install and startup
chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);

// Call immediately on load to ensure rules are active
setupRules();

// Helper to push a logged watch event directly to the Obsidian sync server
async function tryPushWatchToObsidian(videoId, title, channel, duration, timestamp) {
  try {
    const settings = await chrome.storage.local.get(['obsidianSyncEnabled', 'obsidianSyncPort']);
    const syncEnabled = settings.obsidianSyncEnabled !== false;
    const port = settings.obsidianSyncPort || 12314;

    if (!syncEnabled) return;

    await fetch(`http://127.0.0.1:${port}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, title, channel, duration, timestamp })
    });
  } catch (err) {
    console.debug('Failed to auto-sync watch to Obsidian:', err.message);
  }
}
