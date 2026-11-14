// utils/daily.js
// The once-a-day job: fetch the day's watches (Chrome's history on this Mac first, then the YouTube
// account's history for what was watched elsewhere, e.g. the phone app), merge them without
// duplicates, let the AI label new videos, and keep a small digest per day.
import './yt-core.js';
import { batchImportHistory, getHistory, getLabels, migrate, saveLabels, withLock } from './storage.js';
import { classifyVideos, summariseInterests } from './ai.js';

const C = globalThis.YTCore;

export const DEFAULT_SETTINGS = {
  dailySync: true,
  dailyTime: '23:30',
  useChromeHistory: true,
  useAccountHistory: true,
  aiEnabled: true,
  aiProvider: 'auto', // auto = Gemini with a key, else the Mac's local model
  geminiKey: '',
  localModel: 'llama3.2',
  journalDigest: true,
};

export async function getSettings() {
  const { dailySettings = {} } = await chrome.storage.local.get('dailySettings');
  return { ...DEFAULT_SETTINGS, ...dailySettings };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ dailySettings: next });
  return next;
}

// ───── Source 1: Chrome's history on this computer ─────

/** Chrome's visits to YouTube watch pages in [start, end) as {url, title, time}. */
export async function chromeVisits(start, end) {
  const items = await chrome.history.search({ text: '', startTime: start, endTime: end, maxResults: 100000 });
  const visits = [];
  for (const it of items) {
    if (!it.url || !C.parseYouTubeUrl(it.url)) continue;
    const vs = await chrome.history.getVisits({ url: it.url });
    for (const v of vs) if (v.visitTime >= start && v.visitTime < end) visits.push({ url: it.url, title: it.title || '', time: v.visitTime });
  }
  return visits;
}

// ───── Source 2: the YouTube account's history (all devices) ─────

const YT = 'https://www.youtube.com';

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The header YouTube's own page signs its API calls with (from the SAPISID cookie). */
async function authHeader(now = Date.now()) {
  const names = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];
  for (const name of names) {
    const c = await chrome.cookies.get({ url: YT, name }).catch(() => null);
    if (c && c.value) {
      const ts = Math.floor(now / 1000);
      return `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${c.value} ${YT}`)}`;
    }
  }
  return null;
}

/**
 * Items of the account's watch history page for days from `firstDay` on: the page's first part,
 * then its continuations until the list reaches before `firstDay` (at most `maxPages`).
 * Throws when not signed in to YouTube in this Chrome.
 */
export async function accountHistoryItems(firstDay, { fetchImpl = fetch, now = Date.now(), maxPages = 25 } = {}) {
  const res = await fetchImpl(`${YT}/feed/history?hl=en`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  const html = await res.text();
  const cfg = C.extractYtcfg(html);
  if (cfg.LOGGED_IN === false) throw new Error('Not signed in to YouTube in this Chrome');
  const data = C.extractJsonVar(html, 'ytInitialData');
  if (!data) throw new Error("Couldn't read YouTube's history page");
  let { items, lastDay } = C.itemsFromHistoryData(data, now);
  let token = C.findContinuation(data);
  let pages = 1;
  const auth = token ? await authHeader(now) : null;
  while (token && auth && pages < maxPages && (!lastDay || lastDay >= firstDay)) {
    const r = await fetchImpl(`${YT}/youtubei/v1/browse?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'X-Origin': YT,
        'X-Goog-AuthUser': String(cfg.SESSION_INDEX ?? '0'),
        ...(cfg.INNERTUBE_CONTEXT_CLIENT_NAME ? { 'X-Youtube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME) } : {}),
        ...(cfg.INNERTUBE_CLIENT_VERSION ? { 'X-Youtube-Client-Version': String(cfg.INNERTUBE_CLIENT_VERSION) } : {}),
      },
      body: JSON.stringify({ context: cfg.INNERTUBE_CONTEXT || { client: { clientName: 'WEB', clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '2.20260101.00.00', hl: 'en' } }, continuation: token }),
    });
    if (!r.ok) break; // Keep what the first pages gave.
    const more = await r.json();
    const next = C.itemsFromHistoryData(more, now, lastDay);
    const known = new Set(items.map((i) => `${i.day}|${i.videoId}`));
    items = items.concat(next.items.filter((i) => !known.has(`${i.day}|${i.videoId}`)));
    lastDay = next.lastDay;
    token = C.findContinuation(more);
    pages++;
  }
  return { items, pages, reachedDay: lastDay };
}

// ───── The job ─────

const LOG_KEEP = 30;

async function log(entry) {
  const { syncLog = [] } = await chrome.storage.local.get('syncLog');
  syncLog.unshift(entry);
  await chrome.storage.local.set({ syncLog: syncLog.slice(0, LOG_KEEP) });
}

let running = null;

/**
 * Syncs `days` (default: from the last synced day up to today, at most 14) and analyses them.
 * Safe to run again: anything already logged is skipped. One run at a time.
 */
export function runDailySync({ days, reason = 'manual', now = Date.now() } = {}) {
  if (running) return running;
  running = (async () => {
    const settings = await getSettings();
    const today = C.localDay(now);
    // From the day after the last one synced after it ended (a day synced at 23:30 is done again
    // next time, for its last half hour), up to today; at most two weeks back.
    const { lastCompleteDay } = await chrome.storage.local.get('lastCompleteDay');
    const list = days && days.length ? days : C.daysBetween(lastCompleteDay || C.addDays(today, -2), today, 14);
    const entry = { at: now, reason, days: list, chrome: null, account: null, added: 0, replaced: 0, labelled: 0, errors: [] };
    try {
      await migrate();
      const first = list[0];
      const span = { start: C.dayBounds(first).start, end: C.dayBounds(list[list.length - 1]).end };
      const events = [];
      // 1. This Mac's Chrome: exact times.
      if (settings.useChromeHistory) {
        try {
          const visits = await chromeVisits(span.start, span.end);
          const ev = C.eventsFromChromeVisits(visits, span.start, span.end);
          events.push(...ev);
          entry.chrome = { watches: ev.length };
        } catch (e) {
          entry.chrome = { error: String(e.message || e) };
        }
      }
      // 2. The account's history: what Chrome here didn't see (the phone app, other computers).
      if (settings.useAccountHistory) {
        try {
          const { items, pages, reachedDay } = await accountHistoryItems(first, { now });
          const ev = list.flatMap((d) => C.eventsFromHistoryItems(items, d, now));
          events.push(...ev);
          entry.account = { watches: ev.length, pages, complete: !reachedDay || reachedDay < first };
        } catch (e) {
          entry.account = { error: String(e.message || e) };
        }
      }
      // Exact times first, so a guessed time never takes a slot a real one fills.
      events.sort((a, b) => (a.approx ? 1 : 0) - (b.approx ? 1 : 0));
      const merged = await batchImportHistory(events);
      entry.added = merged.addedCount;
      entry.replaced = merged.replacedCount;
      const anySource = (entry.chrome && !entry.chrome.error) || (entry.account && !entry.account.error);
      if (anySource) {
        const ended = list.filter((d) => C.dayBounds(d).end <= now);
        const { lastCompleteDay: before } = await chrome.storage.local.get('lastCompleteDay');
        const done = ended.length ? ended[ended.length - 1] : before;
        await chrome.storage.local.set({ lastRunDay: today, ...(done && (!before || done > before) ? { lastCompleteDay: done } : {}) });
      }
      // 3. AI labels for videos watched on these days that don't have one yet.
      if (settings.aiEnabled) {
        try {
          entry.labelled = await labelDays(list, settings, now);
        } catch (e) {
          entry.errors.push(`AI: ${e.message || e}`);
        }
      }
      // 4. The digest of each day (numbers always; the AI note once a day).
      await updateDigests(list, settings, now).catch((e) => entry.errors.push(`Digest: ${e.message || e}`));
    } catch (e) {
      entry.errors.push(String(e.message || e));
    }
    await log(entry);
    return entry;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Labels unlabelled videos watched on these days (at most 300 per run). Returns how many. */
export async function labelDays(days, settings, now = Date.now(), cap = 300) {
  const history = await getHistory();
  const labels = await getLabels();
  const want = new Map();
  for (const d of days) {
    for (const w of C.watchesOnDay(history, d)) {
      if (labels[w.videoId] || want.has(w.videoId)) continue;
      const m = history.metadata[w.videoId] || {};
      if (m.isAd || !m.title || m.title === 'Unknown Video') continue;
      want.set(w.videoId, { videoId: w.videoId, title: m.title, channel: m.channel || '' });
    }
  }
  const videos = Array.from(want.values()).slice(0, cap);
  if (!videos.length) return 0;
  let n = 0;
  await classifyVideos(videos, settings, { now, onBatch: async (got) => {
    n += Object.keys(got).length;
    await saveLabels(got);
  } });
  return n;
}

/** Labels for older watches, newest first (the "Label older videos" button). */
export async function labelBacklog(settings, cap = 200, now = Date.now()) {
  const history = await getHistory();
  const labels = await getLabels();
  const videos = Object.keys(history.watches)
    .filter((id) => id.indexOf(':') < 0 && !labels[id])
    .map((id) => ({ id, m: history.metadata[id] || {}, last: Math.max.apply(null, history.watches[id]) }))
    .filter((x) => !x.m.isAd && x.m.title && x.m.title !== 'Unknown Video')
    .sort((a, b) => b.last - a.last)
    .slice(0, cap)
    .map((x) => ({ videoId: x.id, title: x.m.title, channel: x.m.channel || '' }));
  let n = 0;
  await classifyVideos(videos, settings, { now, onBatch: async (got) => {
    n += Object.keys(got).length;
    await saveLabels(got);
  } });
  return n;
}

/**
 * digests[day] = {day, watches, useful, distraction, unlabelled, shorts, topics, at} for each day,
 * and for the newest day the interest shift (7 days against the 28 before) with an AI note.
 */
export async function updateDigests(days, settings, now = Date.now()) {
  const history = await getHistory();
  const labels = await getLabels();
  const newest = days[days.length - 1];
  const recent = C.topicCounts(history, labels, C.addDays(newest, -6), newest);
  const earlier = C.topicCounts(history, labels, C.addDays(newest, -34), C.addDays(newest, -7));
  const shift = C.interestShift(recent, earlier);
  let note = null;
  const { digests: old = {} } = await chrome.storage.local.get('digests');
  const prev = old[newest];
  const s = C.daySummary(history, labels, newest);
  // One AI note per day, redone only when the day had new labelled watches since.
  if (settings.aiEnabled && Object.keys(recent).length && (!prev || !prev.note || prev.useful + prev.distraction !== s.useful + s.distraction)) {
    note = await summariseInterests(settings, { recent, earlier, today: s }).catch(() => null);
  }
  return withLock(async () => {
    const { digests = {} } = await chrome.storage.local.get('digests');
    for (const d of days) {
      const sum = C.daySummary(history, labels, d);
      digests[d] = { ...(digests[d] || {}), ...sum, at: now };
    }
    digests[newest] = { ...digests[newest], shift, ...(note ? { note } : {}) };
    // Keep a year of digests.
    const cutoff = C.addDays(C.localDay(now), -400);
    for (const d of Object.keys(digests)) if (d < cutoff) delete digests[d];
    await chrome.storage.local.set({ digests });
    return digests;
  });
}

// ───── When it runs ─────

/** The next time the clock shows `hhmm` ("23:30"), in ms. */
export function nextAt(hhmm, now = Date.now()) {
  const [h, m] = String(hhmm || '23:30').split(':').map(Number);
  const d = new Date(now);
  d.setHours(isFinite(h) ? h : 23, isFinite(m) ? m : 30, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export const ALARM = 'daily-sync';
export const CATCH_UP = 'daily-catch-up';

/** Sets the daily alarm from the settings (or clears it when daily sync is off). */
export async function schedule() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM);
  if (!settings.dailySync) return null;
  const when = nextAt(settings.dailyTime);
  await chrome.alarms.create(ALARM, { when, periodInMinutes: 24 * 60 });
  return when;
}

/** At Chrome's start: when a daily run was missed (Chrome was closed), run once a little later. */
export async function catchUpIfMissed(now = Date.now()) {
  const settings = await getSettings();
  if (!settings.dailySync) return false;
  const { lastRunDay } = await chrome.storage.local.get('lastRunDay');
  const yesterday = C.addDays(C.localDay(now), -1);
  if (lastRunDay && lastRunDay >= yesterday) return false;
  // Not right at start-up: Chrome is busy then.
  await chrome.alarms.create(CATCH_UP, { delayInMinutes: 3 });
  return true;
}
