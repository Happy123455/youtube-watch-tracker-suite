// utils/storage.js
// The watch history in chrome.storage.local: { watches: {videoId: [ms…]}, metadata: {videoId: {…}} }.
// Every change goes through the service worker and one lock, so two tabs logging at once, a sync
// and an import can't overwrite each other's writes (each reads, changes and writes the whole map).
import './yt-core.js';

const C = globalThis.YTCore;

let chain = Promise.resolve();
/** Runs `fn` after every change queued before it (one at a time), and returns what it returns. */
export function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The full watch history and metadata. */
export async function getHistory() {
  const result = await chrome.storage.local.get(['watches', 'metadata']);
  return { watches: result.watches || {}, metadata: result.metadata || {} };
}

async function save(data) {
  await chrome.storage.local.set({ watches: data.watches, metadata: data.metadata });
}

/** Logs a watch happening now (live tracking). Within 5 minutes of the last log it's the same watch. */
export function recordWatch(videoId, title, channel, duration = '', isShort = false) {
  return withLock(async () => {
    const data = await getHistory();
    const timestamp = Date.now();
    const { added, replaced } = C.mergeEvents(data, [{ videoId, title, channel, duration, timestamp, isShort, source: 'live' }]);
    // Keep the newest duration (live tracking reads it from the player).
    if (duration && data.metadata[videoId]) data.metadata[videoId].duration = duration;
    await save(data);
    return { timestamp, watchesCount: (data.watches[videoId] || []).length, added: added + replaced > 0 };
  });
}

/** Watch times and metadata of one video. */
export async function getVideoHistory(videoId) {
  const data = await getHistory();
  return { timestamps: data.watches[videoId] || [], metadata: data.metadata[videoId] || null };
}

/** Forgets one video entirely. */
export function clearVideoHistory(videoId) {
  return withLock(async () => {
    const data = await getHistory();
    delete data.watches[videoId];
    delete data.metadata[videoId];
    await save(data);
    const { labels = {} } = await chrome.storage.local.get('labels');
    if (labels[videoId]) {
      delete labels[videoId];
      await chrome.storage.local.set({ labels });
    }
  });
}

/** Removes one watch of a video (the video goes when it was its last). */
export function deleteWatch(videoId, timestamp) {
  return withLock(async () => {
    const data = await getHistory();
    const list = (data.watches[videoId] || []).filter((t) => t !== timestamp);
    if (list.length) {
      data.watches[videoId] = list;
      const meta = data.metadata[videoId];
      if (meta && meta.approx) {
        meta.approx = meta.approx.filter((t) => t !== timestamp);
        if (!meta.approx.length) delete meta.approx;
      }
    } else {
      delete data.watches[videoId];
      delete data.metadata[videoId];
    }
    await save(data);
    return { remaining: list.length };
  });
}

/** Merges watch events (an import, the history page, a daily sync) without duplicates. */
export function batchImportHistory(events) {
  return withLock(async () => {
    const data = await getHistory();
    const { added, replaced } = C.mergeEvents(data, events || []);
    if (added || replaced) await save(data);
    return { addedCount: added, replacedCount: replaced };
  });
}

/** Empties the history, keeping one copy in `backups` until the next reset. */
export function clearAllHistory() {
  return withLock(async () => {
    const data = await getHistory();
    await keepBackup('before-reset', data);
    await chrome.storage.local.set({ watches: {}, metadata: {} });
  });
}

/** Stores a copy of the history under `backups[name]` (replacing an older copy of that name). */
export async function keepBackup(name, data) {
  const { backups = {} } = await chrome.storage.local.get('backups');
  backups[name] = { at: Date.now(), watches: data.watches, metadata: data.metadata };
  await chrome.storage.local.set({ backups });
}

export const STORAGE_VERSION = 2;

/**
 * Upgrades histories filled by older versions once: a backup copy first, then duplicate watches
 * (re-synced history pages, imports on top of live logs) are folded together. Returns how many
 * duplicates went, or null when already done.
 */
export function migrate() {
  return withLock(async () => {
    const { storageVersion = 1 } = await chrome.storage.local.get('storageVersion');
    if (storageVersion >= STORAGE_VERSION) return null;
    const data = await getHistory();
    if (Object.keys(data.watches).length) {
      await keepBackup('before-v2-repair', JSON.parse(JSON.stringify(data)));
      const removed = C.repairDuplicates(data);
      // A Short logged live was saved under the channel "YouTube Shorts": remember it's a Short.
      for (const id of Object.keys(data.metadata)) {
        const m = data.metadata[id];
        if (m && (m.channel === 'YouTube Shorts' || m.channel === 'Shorts')) m.isShort = true;
      }
      await save(data);
      await chrome.storage.local.set({ storageVersion: STORAGE_VERSION, lastRepair: { at: Date.now(), removed } });
      return removed;
    }
    await chrome.storage.local.set({ storageVersion: STORAGE_VERSION });
    return 0;
  });
}

// ───── AI labels: {videoId: {category, topics, why, at, by}} ─────

export async function getLabels() {
  const { labels = {} } = await chrome.storage.local.get('labels');
  return labels;
}

export function saveLabels(patch) {
  return withLock(async () => {
    const labels = await getLabels();
    Object.assign(labels, patch);
    await chrome.storage.local.set({ labels });
    return labels;
  });
}
