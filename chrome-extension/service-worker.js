// service-worker.js
import { recordWatch, getVideoHistory, clearVideoHistory, deleteWatch, getHistory, batchImportHistory, clearAllHistory, migrate, getLabels } from './utils/storage.js';
import { runDailySync, getSettings, saveSettings, schedule, catchUpIfMissed, labelBacklog, ALARM, CATCH_UP } from './utils/daily.js';
import { askJson } from './utils/ai.js';
import { pushDigestToJournal } from './utils/journal.js';
import { checkVideo, checking, deleteCheck, getChecks, setConviction } from './utils/firewall.js';

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

/** Answers a message with the promise's result ({success, ...}) or its error. */
function reply(promise, sendResponse) {
  Promise.resolve(promise)
    .then((result) => sendResponse({ success: true, ...(result || {}) }))
    .catch((error) => sendResponse({ success: false, error: error && error.message ? error.message : String(error) }));
  return true; // Keep the message channel open for the async answer.
}

// Handle runtime messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages and its content script talk to it.
  if (sender.id !== chrome.runtime.id) return false;

  switch (message.action) {
    case 'recordWatch': {
      const { videoId, title, channel, duration, isShort } = message;
      return reply(
        recordWatch(videoId, title, channel, duration, !!isShort).then((result) => {
          if (result.added) tryPushWatchToObsidian(videoId, title, channel, duration, result.timestamp);
          return result;
        }),
        sendResponse,
      );
    }
    case 'getVideoHistory':
      return reply(getVideoHistory(message.videoId), sendResponse);
    case 'getHistory':
      return reply(Promise.all([getHistory(), getLabels()]).then(([h, labels]) => ({ ...h, labels })), sendResponse);
    case 'clearVideoHistory':
      return reply(clearVideoHistory(message.videoId), sendResponse);
    case 'deleteWatch':
      return reply(deleteWatch(message.videoId, message.timestamp), sendResponse);
    case 'batchImportHistory':
      return reply(batchImportHistory(message.events), sendResponse);
    case 'clearAllHistory':
      return reply(clearAllHistory(), sendResponse);

    // ───── Daily sync + AI ─────
    case 'runDailySync':
      return reply(runDailySync({ reason: 'manual', days: message.days }).then(async (entry) => {
        await pushDigestToJournal().catch(() => {});
        return { entry };
      }), sendResponse);
    case 'getDailyState':
      return reply(
        chrome.storage.local
          .get(['syncLog', 'digests', 'lastRunDay', 'lastCompleteDay', 'lastRepair', 'journalPush'])
          .then(async (s) => ({ ...s, settings: { ...(await getSettings()), geminiKey: undefined, hasGeminiKey: !!(await getSettings()).geminiKey }, nextRun: (await chrome.alarms.get(ALARM))?.scheduledTime ?? null })),
        sendResponse,
      );
    case 'saveDailySettings': {
      const patch = { ...message.patch };
      // An empty key field means "keep the saved key"; null removes it.
      if (patch.geminiKey === '' || patch.geminiKey === undefined) delete patch.geminiKey;
      if (patch.geminiKey === null) patch.geminiKey = '';
      return reply(saveSettings(patch).then(async () => ({ nextRun: await schedule() })), sendResponse);
    }
    case 'labelBacklog':
      return reply(getSettings().then((s) => labelBacklog(s, message.cap || 200)).then((labelled) => ({ labelled })), sendResponse);
    case 'testAi':
      return reply(
        getSettings().then((s) =>
          askJson(s, {
            system: 'Reply with JSON {"ok": true}.',
            prompt: 'Test',
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          }),
        ).then((r) => ({ model: r.model })),
        sendResponse,
      );

    // ───── 🧯 Rhetoric firewall ─────
    case 'firewallCheck':
      return reply(checkVideo(message).then((check) => ({ check })), sendResponse);
    case 'firewallGet':
      return reply(getChecks().then((all) => ({ check: all[message.videoId] || null, checking: checking(message.videoId) })), sendResponse);
    case 'firewallList':
      return reply(getChecks().then((checks) => ({ checks })), sendResponse);
    case 'firewallConviction':
      return reply(setConviction(message.videoId, message.patch || {}).then((check) => ({ check })), sendResponse);
    case 'firewallDelete':
      return reply(deleteCheck(message.videoId), sendResponse);

    case 'closeActiveTab':
      chrome.action.setBadgeText({ text: '' });
      if (sender.tab) chrome.tabs.remove(sender.tab.id);
      return false;
    case 'updateSyncProgress':
      chrome.action.setBadgeText({ text: String(message.count) });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
      // Track active sync tab in session storage in case tab is removed
      if (sender.tab) chrome.storage.session.set({ activeSyncTabId: sender.tab.id });
      return false;
    case 'clearSyncBadge':
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.session.remove('activeSyncTabId');
      return false;
    default:
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

// ───── The daily run ─────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM && alarm.name !== CATCH_UP) return;
  runDailySync({ reason: alarm.name === ALARM ? 'daily' : 'catch-up' })
    .then(() => pushDigestToJournal())
    .catch((e) => console.warn('[WatchTree] Daily sync failed:', e));
});

async function startUp() {
  await migrate().catch((e) => console.warn('[WatchTree] Repair failed:', e));
  // The alarm survives restarts; set it again only when it's missing.
  if (!(await chrome.alarms.get(ALARM))) await schedule();
  await catchUpIfMissed();
}

chrome.runtime.onInstalled.addListener(() => {
  setupRules();
  void schedule().then(startUp);
});
chrome.runtime.onStartup.addListener(() => {
  setupRules();
  void startUp();
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

  // The daily sync's history requests come from this worker (no tab): YouTube's API expects them
  // to come from its own site, like the page's own requests. Matching "no tab" needs a session rule.
  const sessionRules = [
    {
      id: 3,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/feed/history' }
        ]
      },
      condition: {
        urlFilter: '||www.youtube.com/youtubei/v1/browse',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [-1],
        initiatorDomains: [chrome.runtime.id]
      }
    },
    {
      // This Mac's Ollama and Dynamic Journal only take requests without a web page's Origin
      // (that's how they keep websites out). Only this extension's own background requests.
      id: 4,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
      condition: {
        regexFilter: '^http://127\\.0\\.0\\.1:(11434|39477)/',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [-1],
        initiatorDomains: [chrome.runtime.id]
      }
    }
  ];

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRules.map(r => r.id),
      addRules: rules
    });
    const existingSession = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingSession.map(r => r.id),
      addRules: sessionRules
    });
  } catch (error) {
    console.error('Failed to configure declarativeNetRequest rules:', error);
  }
}

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
