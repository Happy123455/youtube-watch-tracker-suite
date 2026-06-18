// utils/storage.js

/**
 * Retrieves the full watch history and metadata.
 * @returns {Promise<{watches: Object, metadata: Object}>}
 */
export async function getHistory() {
  const result = await chrome.storage.local.get(['watches', 'metadata']);
  return {
    watches: result.watches || {},
    metadata: result.metadata || {}
  };
}

/**
 * Records a watch event for a specific YouTube video.
 * @param {string} videoId - The YouTube video ID.
 * @param {string} title - The video title.
 * @param {string} channel - The channel name.
 * @param {string} duration - The video length/duration (optional).
 * @returns {Promise<{timestamp: number, watchesCount: number}>}
 */
export async function recordWatch(videoId, title, channel, duration = '') {
  const data = await getHistory();
  const timestamp = Date.now();
  
  if (!data.watches[videoId]) {
    data.watches[videoId] = [];
  }
  
  // Prevent duplicate watch logs within the same 5-minute window
  const videoWatches = data.watches[videoId];
  const lastWatch = videoWatches[videoWatches.length - 1];
  const FIVE_MINUTES = 5 * 60 * 1000;
  
  if (!lastWatch || (timestamp - lastWatch) > FIVE_MINUTES) {
    videoWatches.push(timestamp);
  }
  
  data.metadata[videoId] = {
    title,
    channel,
    duration,
    lastWatched: timestamp
  };
  
  await chrome.storage.local.set({
    watches: data.watches,
    metadata: data.metadata
  });
  
  return {
    timestamp,
    watchesCount: videoWatches.length
  };
}

/**
 * Retrieves watch timestamps and metadata for a specific video.
 * @param {string} videoId 
 * @returns {Promise<{timestamps: number[], metadata: Object|null}>}
 */
export async function getVideoHistory(videoId) {
  const data = await getHistory();
  return {
    timestamps: data.watches[videoId] || [],
    metadata: data.metadata[videoId] || null
  };
}

/**
 * Clears the watch history for a specific video ID.
 * @param {string} videoId 
 */
export async function clearVideoHistory(videoId) {
  const data = await getHistory();
  delete data.watches[videoId];
  delete data.metadata[videoId];
  await chrome.storage.local.set({
    watches: data.watches,
    metadata: data.metadata
  });
}

/**
 * Batches and merges a list of watch events into storage.
 * @param {Array<{videoId: string, title: string, channel: string, timestamp: number}>} events 
 * @returns {Promise<{addedCount: number}>}
 */
export async function batchImportHistory(events) {
  const data = await getHistory();
  let addedCount = 0;

  events.forEach(({ videoId, title, channel, timestamp, isAd }) => {
    if (!videoId) return;

    if (!data.watches[videoId]) {
      data.watches[videoId] = [];
    }

    const videoWatches = data.watches[videoId];
    
    // Check if the timestamp is already logged (avoid exact duplicates)
    if (!videoWatches.includes(timestamp)) {
      videoWatches.push(timestamp);
      addedCount++;
    }

    // Update metadata if not present or if this is the newest watch
    const currentMeta = data.metadata[videoId];
    if (!currentMeta || timestamp > (currentMeta.lastWatched || 0)) {
      data.metadata[videoId] = {
        title,
        channel,
        duration: currentMeta ? currentMeta.duration : '',
        lastWatched: currentMeta ? Math.max(currentMeta.lastWatched || 0, timestamp) : timestamp,
        isAd: isAd || (currentMeta ? currentMeta.isAd : false)
      };
    }
  });

  // Sort timestamps chronologically for consistency
  Object.keys(data.watches).forEach(videoId => {
    data.watches[videoId].sort((a, b) => a - b);
  });

  await chrome.storage.local.set({
    watches: data.watches,
    metadata: data.metadata
  });

  return { addedCount };
}

/**
 * Clears all history (resets watches and metadata to empty objects).
 * @returns {Promise<void>}
 */
export async function clearAllHistory() {
  await chrome.storage.local.set({
    watches: {},
    metadata: {}
  });
}
