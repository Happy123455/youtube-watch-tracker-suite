/* main.js */
const { Plugin, ItemView, WorkspaceLeaf, PluginSettingTab, Setting, Notice, Platform } = require('obsidian');

// ---- BEGIN yt-core.js (an exact copy of chrome-extension/utils/yt-core.js; tests check it) ----
// utils/yt-core.js
// Pure helpers shared by every part of the suite: the extension's service worker, content script
// and popup, the web dashboard, and the tests. No chrome.* calls here.
//
// It is a classic script (no import/export) so it can be loaded everywhere: a <script> tag, a
// content script list, `import './yt-core.js'` for its side effect in an ES module, or require()
// in Node. Everything is on globalThis.YTCore. The Obsidian plugin keeps copies of a few of these
// functions (it ships as one file); tests/core.test.js checks the copies stay identical.
(function (root) {
  'use strict';

  /** Two logs of the same video closer than this are one watch: a reload, a redirect, or the same
   *  watch seen twice (live tracking, Chrome's history, a Takeout import). Live tracking already
   *  used 5 minutes, so a real rewatch after that still counts. */
  const SAME_WATCH_MS = 5 * 60 * 1000;

  const pad = (n) => String(n).padStart(2, '0');

  /** Local calendar day of a timestamp, "YYYY-MM-DD". */
  function localDay(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Start (inclusive) and end (exclusive) of a local day, in ms. */
  function dayBounds(day) {
    const [y, m, d] = day.split('-').map(Number);
    return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
  }

  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return localDay(new Date(y, m - 1, d + n, 12).getTime());
  }

  /** The days after `from` up to and including `to` (both "YYYY-MM-DD"), oldest first, at most
   *  `max` (the newest ones). With no `from`, just `to`. */
  function daysBetween(from, to, max) {
    const limit = max || 30;
    const out = [];
    let d = from ? addDays(from, 1) : to;
    while (d <= to && out.length < 400) {
      out.push(d);
      d = addDays(d, 1);
    }
    return out.slice(-limit);
  }

  /** The video id and whether it is a Short, from a YouTube watch URL; null if it isn't one. */
  function parseYouTubeUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.replace(/^(www|m)\./, '');
    const valid = (id) => (id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null);
    if (host === 'youtu.be') {
      const id = valid(u.pathname.slice(1).split('/')[0]);
      return id ? { videoId: id, isShort: false } : null;
    }
    if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
    if (u.pathname.startsWith('/shorts/')) {
      const id = valid(u.pathname.split('/')[2]);
      return id ? { videoId: id, isShort: true } : null;
    }
    if (u.pathname === '/watch') {
      const id = valid(u.searchParams.get('v'));
      return id ? { videoId: id, isShort: false } : null;
    }
    return null;
  }

  /** "(3) Some title - YouTube" → "Some title". */
  function cleanTitle(t) {
    return String(t || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[-–]\s*YouTube( Music)?\s*$/i, '')
      .trim();
  }

  /** Text made safe to put inside HTML (titles come from YouTube: anyone can name a video `<img …>`). */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /**
   * A history section header ("Today", "Yesterday", "Monday", "Nov 3", "3 Nov 2025",
   * "May 30, 2026", "Sunday, Nov 2", "3 days ago") as a local day, or null when it isn't a date
   * (e.g. "Shorts"). A date without a year that would land in the future belongs to last year.
   */
  function parseHistoryHeader(text, now) {
    const at = now == null ? Date.now() : now;
    const s = String(text || '').trim().toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const today = localDay(at);
    if (s === 'today') return today;
    if (s === 'yesterday') return addDays(today, -1);
    const wd = WEEKDAYS.indexOf(s);
    if (wd >= 0) {
      // This week: Today and Yesterday have their own names, so a weekday is 2 to 7 days back.
      const back = (new Date(at).getDay() - wd + 7) % 7 || 7;
      return addDays(today, -back);
    }
    const rel = s.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/);
    if (rel) {
      const n = Number(rel[1]);
      const d = new Date(at);
      if (rel[2] === 'day') d.setDate(d.getDate() - n);
      else if (rel[2] === 'week') d.setDate(d.getDate() - n * 7);
      else if (rel[2] === 'month') d.setMonth(d.getMonth() - n);
      else d.setFullYear(d.getFullYear() - n);
      return localDay(d.getTime());
    }
    // "nov 3", "3 nov", "nov 3 2025", "3 november 2025", "sunday nov 2"
    let month = -1;
    let day = 0;
    let year = 0;
    for (const w of s.split(' ')) {
      if (WEEKDAYS.includes(w) || WEEKDAYS.some((x) => x.slice(0, 3) === w)) continue;
      const m = MONTHS.indexOf(w.slice(0, 3));
      if (m >= 0 && /^[a-z]+$/.test(w) && month < 0) month = m;
      else if (/^\d{4}$/.test(w)) year = Number(w);
      else if (/^\d{1,2}$/.test(w) && !day) day = Number(w);
      else return null;
    }
    if (month < 0 || day < 1 || day > 31) return null;
    let y = year || new Date(at).getFullYear();
    let candidate = new Date(y, month, day, 12);
    if (candidate.getMonth() !== month) return null; // "Feb 31"
    if (!year && localDay(candidate.getTime()) > today) candidate = new Date(y - 1, month, day, 12);
    return localDay(candidate.getTime());
  }

  /**
   * Watch events from a Google Takeout watch-history.json (an array of activity records).
   * Searches and sponsored visits are kept as before (`search:` / `visit:` ids).
   */
  function eventsFromTakeout(raw) {
    if (!Array.isArray(raw)) throw new Error('Takeout history must be a JSON array.');
    const out = [];
    const timeOf = (item) => {
      const t = item.time ? new Date(item.time).getTime() : NaN;
      return isFinite(t) ? t : null;
    };
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const ts = timeOf(item);
      if (ts === null) continue; // A record without a time can't be placed: skip it, don't guess "now".
      const p = item.titleUrl ? parseYouTubeUrl(item.titleUrl) : null;
      if (p) {
        let title = String(item.title || 'Unknown Video');
        if (title.startsWith('Watched ')) title = title.slice(8);
        let channel = 'Unknown Channel';
        if (item.subtitles && item.subtitles[0] && item.subtitles[0].name) channel = item.subtitles[0].name;
        else if (item.details && item.details[0] && item.details[0].name) channel = item.details[0].name;
        const isAd = !!(item.details && item.details[0] && item.details[0].name === 'From Google Ads') || channel === 'From Google Ads';
        out.push({ videoId: p.videoId, title, channel, timestamp: ts, isAd, isShort: p.isShort, source: 'takeout' });
        continue;
      }
      const title = String(item.title || '');
      if (title.startsWith('Searched for ')) {
        const query = title.slice(13).trim();
        if (query) out.push({ videoId: `search:${encodeURIComponent(query)}`, title, channel: 'YouTube Search', timestamp: ts, source: 'takeout' });
        continue;
      }
      if (title.startsWith('Visited ')) {
        let url = item.titleUrl || '';
        try {
          if (url.includes('google.com/url?q=')) url = new URL(url).searchParams.get('q') || url;
        } catch (e) {
          // Keep the raw link.
        }
        let domain = 'Sponsored Ad Link';
        if (url) {
          try {
            domain = new URL(url).hostname;
          } catch (e) {
            domain = url;
          }
        }
        const channel = (item.details && item.details[0] && item.details[0].name) || 'Google Ads';
        out.push({ videoId: `visit:${encodeURIComponent(domain)}`, title, channel, timestamp: ts, isAd: true, source: 'takeout' });
      }
    }
    return out;
  }

  /** A YouTube video id, or a search/visit record's id (what the pages put in links and attributes). */
  const validId = (id) => typeof id === 'string' && /^(?:[A-Za-z0-9_-]{6,20}|(?:search|visit):[A-Za-z0-9%._~!*'()-]{0,2000})$/.test(id);

  const KNOWN = (v, bad) => (v && bad.indexOf(v) < 0 ? v : '');

  /**
   * Merges watch events into a history ({watches, metadata}) in place, without duplicates.
   * An event: {videoId, title, channel, timestamp, duration?, isAd?, isShort?, approx?}.
   * `approx` = the time is a guess (YouTube's history page only gives the day): it is skipped when
   * the video already has a watch that day, and an exact time for that day replaces it.
   * Returns {added, replaced}.
   */
  function mergeEvents(history, events, sameMs) {
    const win = sameMs || SAME_WATCH_MS;
    history.watches = history.watches || {};
    history.metadata = history.metadata || {};
    let added = 0;
    let replaced = 0;
    for (const ev of events || []) {
      if (!ev || !validId(ev.videoId) || typeof ev.timestamp !== 'number' || !isFinite(ev.timestamp)) continue;
      const id = ev.videoId;
      const list = history.watches[id] || (history.watches[id] = []);
      const meta = history.metadata[id] || null;
      const approx = meta && Array.isArray(meta.approx) ? meta.approx.slice() : [];
      const day = localDay(ev.timestamp);
      let changed = false;
      if (ev.approx) {
        if (!list.some((t) => localDay(t) === day)) {
          list.push(ev.timestamp);
          approx.push(ev.timestamp);
          added++;
          changed = true;
        }
      } else if (!list.some((t) => approx.indexOf(t) < 0 && Math.abs(t - ev.timestamp) < win)) {
        // An exact time for a watch that so far only had a guessed one that day.
        const guess = list.findIndex((t) => approx.indexOf(t) >= 0 && localDay(t) === day);
        if (guess >= 0) {
          approx.splice(approx.indexOf(list[guess]), 1);
          list[guess] = ev.timestamp;
          replaced++;
        } else {
          list.push(ev.timestamp);
          added++;
        }
        changed = true;
      }
      if (changed) list.sort((a, b) => a - b);
      if (!list.length) {
        delete history.watches[id];
        continue;
      }
      const title = KNOWN(ev.title, ['Unknown Video']);
      const channel = KNOWN(ev.channel, ['Unknown Channel', 'YouTube Shorts', 'Shorts']);
      const oldTitle = meta ? KNOWN(meta.title, ['Unknown Video']) : '';
      const oldChannel = meta ? KNOWN(meta.channel, ['Unknown Channel', 'YouTube Shorts', 'Shorts']) : '';
      const next = Object.assign({}, meta || {}, {
        // The newest known title wins (titles get edited); a missing one never replaces a known one.
        title: title && (!oldTitle || ev.timestamp >= ((meta && meta.lastWatched) || 0)) ? title : oldTitle || 'Unknown Video',
        // A real channel name beats "YouTube Shorts" (what live tracking writes for Shorts).
        channel: oldChannel || channel || (meta && meta.channel) || ev.channel || 'Unknown Channel',
        duration: (meta && meta.duration) || ev.duration || '',
        lastWatched: list.reduce((m, t) => (t > m ? t : m), 0),
        isAd: !!(ev.isAd || (meta && meta.isAd)),
        isShort: !!(ev.isShort || (meta && meta.isShort) || ev.channel === 'YouTube Shorts'),
      });
      if (approx.length) next.approx = approx.filter((t) => list.indexOf(t) >= 0);
      else delete next.approx;
      if (next.approx && !next.approx.length) delete next.approx;
      history.metadata[id] = next;
    }
    return { added, replaced };
  }

  /** Old history-page guesses: whole minutes counted back from noon (12:00:00.000, 11:59:00.000…). */
  function looksGuessed(t) {
    const d = new Date(t);
    return d.getSeconds() === 0 && d.getMilliseconds() === 0 && (d.getHours() < 12 || (d.getHours() === 12 && d.getMinutes() === 0));
  }

  /**
   * One-time repair of histories filled by older versions: watches of one video less than
   * SAME_WATCH_MS apart become one; old history-page guesses on a day that also has a real time
   * go, and several guesses of one video on one day become one. Returns how many were removed.
   */
  function repairDuplicates(history, sameMs) {
    const win = sameMs || SAME_WATCH_MS;
    let removed = 0;
    for (const id of Object.keys(history.watches || {})) {
      const before = history.watches[id] || [];
      const meta = (history.metadata || {})[id];
      const marked = meta && Array.isArray(meta.approx) ? meta.approx : [];
      const guessed = (t) => marked.indexOf(t) >= 0 || looksGuessed(t);
      const sorted = Array.from(new Set(before.filter((t) => typeof t === 'number' && isFinite(t)))).sort((a, b) => a - b);
      const out = [];
      for (const t of sorted) {
        const prev = out[out.length - 1];
        if (prev !== undefined && t - prev < win && !guessed(prev) && !guessed(t)) continue;
        out.push(t);
      }
      const byDay = new Map();
      for (const t of out) {
        const k = localDay(t);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(t);
      }
      const keep = [];
      for (const ts of byDay.values()) {
        const exact = ts.filter((t) => !guessed(t));
        keep.push.apply(keep, exact);
        if (!exact.length) keep.push(ts[ts.length - 1]);
      }
      keep.sort((a, b) => a - b);
      removed += before.length - keep.length;
      if (keep.length) history.watches[id] = keep;
      else delete history.watches[id];
      if (meta && meta.approx) {
        meta.approx = meta.approx.filter((t) => keep.indexOf(t) >= 0);
        if (!meta.approx.length) delete meta.approx;
      }
    }
    return removed;
  }

  /**
   * Watch events from Chrome's history. `visits` = [{url, title, time}] (any sites, any order).
   * Visits of one video within SAME_WATCH_MS are one watch. A Short left within `minShortMs` for
   * another YouTube page was swiped past, not watched (live tracking needs 10 s too).
   */
  function eventsFromChromeVisits(visits, start, end, minShortMs) {
    const minShort = minShortMs == null ? 3000 : minShortMs;
    const yt = visits
      .map((v) => ({ v, p: parseYouTubeUrl(v.url) }))
      .filter((x) => x.p && x.v.time >= start && x.v.time < end)
      .sort((a, b) => a.v.time - b.v.time);
    const titles = new Map();
    for (const { v, p } of yt) {
      const t = cleanTitle(v.title);
      if (t && t.toLowerCase() !== 'youtube' && !titles.has(p.videoId)) titles.set(p.videoId, t);
    }
    const last = new Map();
    const events = [];
    yt.forEach(({ v, p }, i) => {
      const next = yt[i + 1];
      if (p.isShort && next && next.v.time - v.time < minShort) return;
      const prev = last.get(p.videoId);
      if (prev !== undefined && v.time - prev < SAME_WATCH_MS) return;
      last.set(p.videoId, v.time);
      events.push({
        videoId: p.videoId,
        title: titles.get(p.videoId) || 'Unknown Video',
        channel: p.isShort ? 'YouTube Shorts' : 'Unknown Channel',
        timestamp: v.time,
        isShort: p.isShort,
        source: 'chrome',
      });
    });
    return events;
  }

  const textOf = (t) => (!t ? '' : typeof t === 'string' ? t : t.simpleText || t.content || (Array.isArray(t.runs) ? t.runs.map((r) => r.text).join('') : ''));

  function videoOf(n) {
    for (const k of ['videoRenderer', 'reelItemRenderer', 'compactVideoRenderer', 'gridVideoRenderer']) {
      const r = n[k];
      if (r && r.videoId) {
        const title = textOf(r.title) || textOf(r.headline) || '';
        const channel = textOf(r.ownerText) || textOf(r.shortBylineText) || textOf(r.longBylineText) || '';
        const short = k === 'reelItemRenderer';
        return { videoId: r.videoId, title: title || 'Unknown Video', channel: channel || (short ? 'YouTube Shorts' : 'Unknown Channel'), isShort: short };
      }
    }
    const sl = n.shortsLockupViewModel;
    if (sl) {
      const ep = sl.onTap && sl.onTap.innertubeCommand && sl.onTap.innertubeCommand.reelWatchEndpoint;
      const id = (ep && ep.videoId) || String(sl.entityId || '').replace(/^shorts-shelf-item-/, '');
      const title = (sl.overlayMetadata && textOf(sl.overlayMetadata.primaryText)) || String(sl.accessibilityText || '').split(',')[0];
      if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return { videoId: id, title: title || 'Unknown Video', channel: 'YouTube Shorts', isShort: true };
    }
    const lv = n.lockupViewModel;
    if (lv && lv.contentId && (!lv.contentType || lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      const meta = lv.metadata && lv.metadata.lockupMetadataViewModel;
      const title = meta ? textOf(meta.title) : '';
      let channel = '';
      try {
        channel = textOf(meta.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text);
      } catch (e) {
        channel = '';
      }
      return { videoId: lv.contentId, title: title || 'Unknown Video', channel: channel || 'Unknown Channel', isShort: false };
    }
    return null;
  }

  /**
   * Videos in YouTube's history page data (ytInitialData, or a continuation answer), under their
   * date headers: [{day, videoId, title, channel, isShort}] in page order (newest first). Walks the
   * JSON generically, so renamed renderers don't break it as long as sections have a title and
   * items have a video id. `day` carries over from the previous page (a day split across pages).
   */
  function itemsFromHistoryData(data, now, startDay) {
    const out = [];
    const seen = new Set();
    let lastDay = startDay || null;
    const headerOf = (sec) => {
      const h = sec.header || {};
      for (const k of Object.keys(h)) {
        const t = textOf(h[k] && h[k].title);
        if (t) return t;
      }
      return '';
    };
    const visit = (node, day, depth) => {
      if (!node || typeof node !== 'object' || depth > 60) return;
      if (Array.isArray(node)) {
        for (const n of node) visit(n, day, depth + 1);
        return;
      }
      if (node.itemSectionRenderer) {
        const sec = node.itemSectionRenderer;
        const d = parseHistoryHeader(headerOf(sec), now);
        if (d) lastDay = d;
        // Sub-sections ("Shorts") stay on the day of the date section they're in.
        visit(sec.contents, d || day || lastDay, depth + 1);
        return;
      }
      const item = videoOf(node);
      if (item) {
        const d = day || lastDay;
        if (d) {
          const key = `${d}|${item.videoId}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(Object.assign({ day: d }, item));
          }
        }
        return;
      }
      for (const k of Object.keys(node)) visit(node[k], day, depth + 1);
    };
    visit(data, null, 0);
    return { items: out, lastDay };
  }

  /** The continuation token for the next page of the history list, or null. */
  function findContinuation(data) {
    let token = null;
    const visit = (node, depth) => {
      if (token || !node || typeof node !== 'object' || depth > 60) return;
      if (Array.isArray(node)) {
        for (const n of node) visit(n, depth + 1);
        return;
      }
      const c = node.continuationItemRenderer;
      if (c) {
        const ep = c.continuationEndpoint || (c.button && c.button.buttonRenderer && c.button.buttonRenderer.command) || {};
        const cmd = ep.continuationCommand;
        if (cmd && cmd.token) {
          token = cmd.token;
          return;
        }
      }
      for (const k of Object.keys(node)) visit(node[k], depth + 1);
    };
    visit(data, 0);
    return token;
  }

  /** The JSON assigned to `name` in a YouTube page's HTML (ytInitialData), or null. */
  function extractJsonVar(html, name) {
    const text = String(html);
    const marks = [`var ${name} = `, `window["${name}"] = `, `${name} = `];
    for (const m of marks) {
      const at = text.indexOf(m);
      if (at < 0) continue;
      const start = text.indexOf('{', at + m.length - 1);
      const end = matchBrace(text, start);
      if (end < 0) continue;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e) {
        // Try the next form.
      }
    }
    return null;
  }

  /** The index of the brace closing the one at `start` (strings and escapes respected), or -1. */
  function matchBrace(s, start) {
    if (start < 0 || s[start] !== '{') return -1;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** The values YouTube's own page sends with API calls (ytcfg.set({...})): key, client context. */
  function extractYtcfg(html) {
    const text = String(html);
    const cfg = {};
    let at = text.indexOf('ytcfg.set({');
    while (at >= 0) {
      const start = at + 'ytcfg.set('.length;
      const end = matchBrace(text, start);
      if (end < 0) break;
      try {
        Object.assign(cfg, JSON.parse(text.slice(start, end + 1)));
      } catch (e) {
        // Not JSON (rare): skip it.
      }
      at = text.indexOf('ytcfg.set({', end);
    }
    return cfg;
  }

  /**
   * One day's items from the account history page as events with guessed times (the page has no
   * times): seconds apart in page order, back from noon (or from now, for today before noon), so
   * the order stays right and they never show up as late-night watches. Marked `approx`.
   */
  function eventsFromHistoryItems(items, day, now) {
    const at = now == null ? Date.now() : now;
    const { start } = dayBounds(day);
    const anchor = Math.min(start + 12 * 3600 * 1000 - 1000, at); // the newest guess sits just before noon
    return items
      .filter((it) => it.day === day)
      .map((it, i) => ({
        videoId: it.videoId,
        title: it.title,
        channel: it.channel,
        isShort: it.isShort,
        timestamp: Math.max(start, Math.floor((anchor - i * 1000) / 1000) * 1000 + 1),
        approx: true,
        source: 'account',
      }));
  }

  // ───────── Interests (counting only, no AI) ─────────

  const isShortMeta = (meta) => !!(meta && (meta.isShort || meta.channel === 'YouTube Shorts' || meta.channel === 'Shorts'));

  /** Watches on a day, oldest first: [{videoId, timestamp}] (searches and ad visits left out). */
  function watchesOnDay(history, day) {
    const { start, end } = dayBounds(day);
    const out = [];
    const all = history.watches || {};
    for (const videoId of Object.keys(all)) {
      if (videoId.indexOf(':') >= 0) continue;
      for (const t of all[videoId]) if (t >= start && t < end) out.push({ videoId, timestamp: t });
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Topic counts for watches from `fromDay` to `toDay` (inclusive), using the AI labels. */
  function topicCounts(history, labels, fromDay, toDay) {
    const counts = {};
    const start = dayBounds(fromDay).start;
    const end = dayBounds(toDay).end;
    const all = history.watches || {};
    for (const videoId of Object.keys(all)) {
      const l = labels[videoId];
      if (!l || !Array.isArray(l.topics)) continue;
      const n = all[videoId].filter((t) => t >= start && t < end).length;
      if (!n) continue;
      for (const topic of l.topics) {
        const k = String(topic).toLowerCase().trim();
        if (k) counts[k] = (counts[k] || 0) + n;
      }
    }
    return counts;
  }

  /** How interests shift: each topic's share of watches recently against before (so a busy week
   *  doesn't make everything "rise"). */
  function interestShift(recent, earlier, limit) {
    const n = limit || 6;
    const total = (c) => Object.values(c).reduce((a, b) => a + b, 0) || 1;
    const rt = total(recent);
    const et = total(earlier);
    const keys = Array.from(new Set(Object.keys(recent).concat(Object.keys(earlier))));
    const rows = keys.map((k) => ({ topic: k, recent: recent[k] || 0, earlier: earlier[k] || 0, delta: (recent[k] || 0) / rt - (earlier[k] || 0) / et }));
    return {
      rising: rows.filter((r) => r.delta > 0 && r.recent >= 2).sort((a, b) => b.delta - a.delta).slice(0, n),
      fading: rows.filter((r) => r.delta < 0 && r.earlier >= 2).sort((a, b) => a.delta - b.delta).slice(0, n),
      top: rows.filter((r) => r.recent > 0).sort((a, b) => b.recent - a.recent).slice(0, n),
    };
  }

  /** A day's numbers: watches, useful vs entertainment, Shorts, not yet labelled. */
  function daySummary(history, labels, day) {
    const ws = watchesOnDay(history, day);
    const s = { day, watches: ws.length, useful: 0, distraction: 0, unlabelled: 0, shorts: 0, topics: {} };
    for (const w of ws) {
      const meta = (history.metadata || {})[w.videoId] || {};
      if (isShortMeta(meta)) s.shorts++;
      const l = labels[w.videoId];
      if (!l) s.unlabelled++;
      else if (l.category === 'useful') s.useful++;
      else s.distraction++;
      for (const t of (l && l.topics) || []) s.topics[t] = (s.topics[t] || 0) + 1;
    }
    return s;
  }

  const YTCore = {
    SAME_WATCH_MS, localDay, dayBounds, addDays, daysBetween, parseYouTubeUrl, cleanTitle, esc,
    parseHistoryHeader, eventsFromTakeout, mergeEvents, looksGuessed, repairDuplicates,
    eventsFromChromeVisits, itemsFromHistoryData, findContinuation, extractJsonVar, extractYtcfg,
    eventsFromHistoryItems, isShortMeta, validId, watchesOnDay, topicCounts, interestShift, daySummary,
  };
  root.YTCore = YTCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = YTCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
// ---- END yt-core.js ----
const YTCore = globalThis.YTCore;
const esc = YTCore.esc;

const VIEW_TYPE_YT_TRACKER = 'youtube-watch-tracker-dashboard';

const DEFAULT_SETTINGS = {
  historyFilePath: 'yt-history.json',
  ignoredVideoIds: [],
  statsRankingMode: 'count',
  statsLimit: 10,
  statsTimeframe: 'all',
  statsStartDate: '',
  statsEndDate: '',
  statsMinWatches: 2,
  statsMinSpan: 0,
  showThumbnails: false,
  embedPlayer: false,
  statsEmbedPlayer: false,
  statsMinimized: false,
  historyZoom: 1.0,
  calendarType: 'all',
  calendarHidden: false,
  enableLocalServer: true,
  localServerPort: 12314,
  statsLateNightEnabled: false,
  statsLateNightStart: '00:00',
  statsLateNightEnd: '04:00',
  statsLateNightGroupChannel: false,
  phaseMinDays: 30,
  phaseMaxDays: 60,
  phaseMinWatches: 10,
  focusTopVideos: false
};

// Helper to format date as YYYY-MM-DD in local time
function getLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Helpers for event link parsing
function getEventUrl(event) {
  if (event.videoId.startsWith('search:')) {
    const query = decodeURIComponent(event.videoId.substring(7));
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }
  if (event.videoId.startsWith('visit:')) {
    const link = event.title.startsWith('Visited ') ? event.title.substring(8).trim() : '';
    // Only web links (an imported file could carry a javascript: link).
    return /^https?:\/\//i.test(link) ? link : `https://www.google.com`;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(event.videoId)}`;
}

// Check if a timestamp falls within a specific local time window (e.g. "00:00" to "04:00")
function isTimestampInTimeRange(ts, startTimeStr, endTimeStr) {
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

class YtTrackerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.watchHistory = { watches: {}, metadata: {} };
    this.allLogEvents = [];
    this.currentSelectedYear = new Date().getFullYear();
    this.showAdsView = false;
    this.statsPaginateAlways = true;
    this.statsPaginatedLimit = 50;
    this.activePhaseHighlight = null;
  }

  getViewType() {
    return VIEW_TYPE_YT_TRACKER;
  }

  getDisplayText() {
    return 'YouTube Watch Activity';
  }

  getIcon() {
    return 'play';
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();

    const wrapper = container.createEl('div', { cls: 'yt-tracker-dashboard' });
    wrapper.innerHTML = `
      <header class="app-header">
        <div class="logo-group">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #818cf8;">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>
          <h1>YouTube Tracker</h1>
          <span class="badge">Obsidian Dashboard</span>
        </div>
      </header>

      <main class="app-body">
        <div class="column-left">
          <!-- Heatmap Section -->
          <section class="section heatmap-section">
            <div class="heatmap-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <h2 class="section-title" style="margin: 0;">Annual Watch Activity</h2>
              <div style="display: flex; gap: 6px; align-items: center;">
                <button id="btn-toggle-calendar" class="btn secondary" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1;">Hide Calendar</button>
                <button id="btn-focus-top" class="btn secondary" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1;" title="Highlight only watches of videos shown in Top Rewatched Videos list">Highlight Top</button>
                <select id="yt-calendar-year-select" style="display: none;"></select>
                <select id="yt-calendar-type-select" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 6px; font-size: 10px; outline: none; cursor: pointer;">
                  <option value="all">All Items</option>
                  <option value="videos">Videos Only</option>
                  <option value="shorts">Shorts Only</option>
                </select>
              </div>
            </div>
            <div id="yt-calendar-years-row" style="display: flex; gap: 8px; margin: 4px 0 12px 0; align-items: center; justify-content: flex-start; flex-wrap: wrap;"></div>
            <div class="yt-tracker-calendar-container scrollable-calendar">
              <div id="yt-calendar-vertical-list" class="yt-calendar-vertical-list"></div>
            </div>
            <div class="yt-tracker-calendar-legend">
              <span>Less</span>
              <div class="yt-tracker-legend-bar" style="width: 80px; height: 8px; border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.08); background: linear-gradient(to right, hsla(239, 84%, 67%, 0.15) 0%, hsla(259, 84%, 61%, 0.5) 50%, hsla(280, 84%, 55%, 0.85) 100%);"></div>
              <span>More</span>
            </div>
          </section>

          <!-- Weekend vs Weekday Shift Section -->
          <section class="section shift-section">
            <h2 class="section-title">Weekend vs. Weekday Shift</h2>
            <div id="shift-analysis-container">
              <div style="text-align: center; color: var(--color-text-muted); font-size: 11px; padding: 12px 0;">Loading shift analysis...</div>
            </div>
          </section>

          <!-- The Phase Detector Section -->
          <section class="section phase-section">
            <h2 class="section-title">The "Phase" Detector</h2>
            <div class="criteria-row" style="margin-bottom: 12px; font-size: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 4px;">
                <span>Window:</span>
                <input type="number" id="phase-min-days" value="30" style="width: 32px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 4px; color: #fff; font-size: 10px; text-align: center;">
                <span>to</span>
                <input type="number" id="phase-max-days" value="60" style="width: 32px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 4px; color: #fff; font-size: 10px; text-align: center;">
                <span>days</span>
              </div>
              <div style="display: flex; align-items: center; gap: 4px;">
                <span>Min Watches:</span>
                <input type="number" id="phase-min-watches" value="10" style="width: 32px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 4px; color: #fff; font-size: 10px; text-align: center;">
              </div>
              <button id="btn-recalculate-phases" class="btn secondary" style="font-size: 9px; padding: 2px 6px; height: 20px; line-height: 1;">Scan</button>
            </div>
            <div id="phase-detector-container">
              <div style="text-align: center; color: var(--color-text-muted); font-size: 11px; padding: 12px 0;">Scanning watch history for phases...</div>
            </div>
          </section>

          <!-- Format Shift Analysis Section -->
          <section class="section format-shift-section">
            <h2 class="section-title">Format Shift Analysis</h2>
            <div id="format-shift-container">
              <div style="text-align: center; color: var(--color-text-muted); font-size: 11px; padding: 12px 0;">Analyzing attention span trend...</div>
            </div>
          </section>

          <!-- Obsidian Daily Log Copy Tools -->
          <section class="section obsidian-tools">
            <h2 class="section-title">Daily Log Integration</h2>
            <div class="button-row" style="margin-bottom: 8px;">
              <button id="btn-copy-today" class="btn secondary flex-btn">Copy Today (Clipboard)</button>
              <button id="btn-copy-yesterday" class="btn secondary flex-btn">Copy Yesterday (Clipboard)</button>
            </div>
            <div class="button-row">
              <button id="btn-append-today" class="btn secondary flex-btn success" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399;">Append Today to Active File</button>
              <button id="btn-export-markdown" class="btn secondary flex-btn">Export Full Markdown</button>
            </div>
          </section>

          <!-- Sync Tools / JSON Upload -->
          <section class="section sync-section">
            <h2 class="section-title">Import History</h2>
            <div class="import-controls" style="display: flex; flex-direction: column; gap: 8px;">
              <button id="btn-import-trigger" class="btn secondary flex-btn" style="width: 100%;">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right: 4px;">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                </svg>
                Import JSON File
              </button>
              <button id="btn-reset-history" class="btn danger" style="width: 100%;">
                Clear All Watch Data
              </button>
            </div>
            <input type="file" id="takeout-file" accept=".json" style="display: none;">
            <div id="import-status" class="import-status-text hidden">Processing...</div>
          </section>
        </div>

        <div class="column-right">
          <!-- Top Rewatched Videos Section -->
          <section class="section stats-section">
            <div class="stats-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <div style="display: flex; gap: 6px; align-items: center;">
                <button id="btn-minimize-stats" class="btn secondary" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;" title="Minimize / Expand Section">
                  <svg id="stats-minimize-icon" viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                    <path d="M19 13H5v-2h14v2z"/>
                  </svg>
                </button>
                <h2 id="stats-section-title" class="section-title" style="margin: 0;">Top Rewatched Videos</h2>
                <button id="btn-toggle-stats-mode" class="btn secondary" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1; min-width: 80px;" title="Switch between count and watch ratio ranking">Show Ratio</button>
                <button id="btn-toggle-ads-view" class="btn secondary" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1; display: inline-flex; align-items: center; gap: 3px;" title="Toggle Advertisements View">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 14H4v-4h11v4zm0-5H4V9h11v4zm5 5h-4V9h4v9z"/>
                  </svg>
                  Ad
                </button>
              </div>
              <div style="display: flex; gap: 6px; align-items: center;">
                <button id="btn-reset-ignored" class="btn secondary hidden" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1;">Reset Hidden</button>
                <select id="stats-timeframe-select" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 10px; outline: none; cursor: pointer;">
                  <option value="all">All Time</option>
                  <option value="7">Past 7 Days</option>
                  <option value="30">Past 30 Days</option>
                  <option value="90">Past 90 Days</option>
                  <option value="365">Past Year</option>
                  <option value="custom">Custom...</option>
                </select>
                <span style="font-size: 10px; color: var(--color-text-secondary);">Show:</span>
                <div style="display: flex; align-items: center; gap: 2px;">
                  <input type="text" id="stats-limit-input" value="10" style="width: 32px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 10px; outline: none; text-align: center;" title="Enter a number or click the infinity button for all videos">
                  <button id="btn-stats-limit-infinity" class="btn secondary" style="padding: 2px 4px; font-size: 10px; border-radius: 4px; margin: 0; line-height: 1; min-width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; cursor: pointer;" title="Show all / Infinite limit">∞</button>
                </div>
              </div>
            </div>
            <div id="stats-custom-date-row" class="hidden" style="display: flex; gap: 6px; align-items: center; justify-content: flex-end; margin-bottom: 8px;">
              <span style="font-size: 9px; color: var(--color-text-secondary);">Start:</span>
              <input type="date" id="stats-start-date" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 9px; outline: none; cursor: pointer;">
              <span style="font-size: 9px; color: var(--color-text-secondary);">End:</span>
              <input type="date" id="stats-end-date" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 9px; outline: none; cursor: pointer;">
            </div>
            <div id="stats-settings-row" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); cursor: pointer; user-select: none;">
                <input type="checkbox" id="chk-stats-show-thumbnails" style="cursor: pointer; accent-color: #818cf8;">
                <span>Thumbnails</span>
              </label>
              <label id="lbl-stats-embed-player" style="display: none; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); cursor: pointer; user-select: none;">
                <input type="checkbox" id="chk-stats-embed-player" style="cursor: pointer; accent-color: #818cf8;">
                <span>Playable Video</span>
              </label>
              <div id="stats-zoom-control" class="hidden" style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--color-text-secondary); padding-left: 8px; border-left: 1px solid rgba(255, 255, 255, 0.1);">
                <span>Zoom:</span>
                <input type="range" id="stats-zoom-slider" min="1" max="3" step="0.1" value="1" style="width: 70px; height: 3px; accent-color: #818cf8; cursor: pointer;">
                <span id="stats-zoom-val" style="min-width: 34px; font-size: 9px; color: var(--color-text-muted);">1.0x</span>
              </div>
            </div>
            <div id="stats-criteria-row" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-bottom: 8px;">
              <span style="font-size: 9px; color: var(--color-text-secondary);">Min Watches:</span>
              <input type="number" id="stats-min-watches" value="2" min="1" max="100" style="width: 32px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 9px; outline: none; text-align: center;">
              <span style="font-size: 9px; color: var(--color-text-secondary);">Min Span (Days):</span>
              <input type="number" id="stats-min-span" value="0" min="0" max="365" style="width: 32px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 2px 4px; font-size: 9px; outline: none; text-align: center;">
            </div>
            <div id="stats-latenight-row" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); cursor: pointer; user-select: none; margin-right: auto;">
                <input type="checkbox" id="chk-late-night" style="cursor: pointer; accent-color: #818cf8;">
                <span style="font-weight: 600; color: #a5b4fc;">Late-Night Index 🌙</span>
              </label>
              <div id="late-night-settings" class="hidden" style="display: flex; align-items: center; gap: 6px; font-size: 9px; color: var(--color-text-secondary);">
                <span>Start:</span>
                <input type="time" id="late-night-start" value="00:00" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 1px 3px; font-size: 9px; outline: none; cursor: pointer; width: 48px;">
                <span>End:</span>
                <input type="time" id="late-night-end" value="04:00" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; border-radius: 6px; padding: 1px 3px; font-size: 9px; outline: none; cursor: pointer; width: 48px;">
                <label style="display: flex; align-items: center; gap: 3px; cursor: pointer; user-select: none; padding-left: 6px; border-left: 1px solid rgba(255, 255, 255, 0.1);">
                  <input type="checkbox" id="chk-group-channel" style="cursor: pointer; accent-color: #818cf8;">
                  <span>Group by Channel</span>
                </label>
              </div>
            </div>
            <div class="stats-container">
              <ul id="top-videos-list" class="stats-list"></ul>
              <ul id="top-ads-list" class="stats-list hidden"></ul>
            </div>
          </section>

          <!-- History Section -->
          <section class="section history-section">
            <div class="search-header">
              <h2 class="section-title">Watch History</h2>
              <div style="display: flex; gap: 8px; align-items: center;">
                <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); cursor: pointer; user-select: none;">
                  <input type="checkbox" id="chk-show-thumbnails" style="cursor: pointer; accent-color: #818cf8;">
                  <span>Thumbnails</span>
                </label>
                <label id="lbl-embed-player" style="display: none; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); cursor: pointer; user-select: none;">
                  <input type="checkbox" id="chk-embed-player" style="cursor: pointer; accent-color: #818cf8;">
                  <span>Playable Video</span>
                </label>
                <div id="history-zoom-control" class="hidden" style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--color-text-secondary); padding-left: 8px; border-left: 1px solid rgba(255, 255, 255, 0.1);">
                  <span>Zoom:</span>
                  <input type="range" id="history-zoom-slider" min="1" max="3" step="0.1" value="1" style="width: 70px; height: 3px; accent-color: #818cf8; cursor: pointer;">
                  <span id="history-zoom-val" style="min-width: 34px; font-size: 9px; color: var(--color-text-muted);">1.0x</span>
                </div>
                <div class="search-box">
                  <svg class="search-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                  </svg>
                  <input type="text" id="search-input" placeholder="Search title or channel...">
                </div>
              </div>
            </div>
            
            <div class="history-list-wrapper">
              <ul class="history-list" id="history-list"></ul>
            </div>
          </section>
        </div>
      </main>
    `;

    await this.loadHistory();
    this.setupEventListeners();
  }

  async loadHistory() {
    try {
      this.watchHistory = await this.plugin.loadHistoryData();
    } catch (e) {
      new Notice(`YouTube Tracker: ${e.message}`);
      this.watchHistory = { watches: {}, metadata: {} };
    }
    this.processLogEvents();

    const minWatchesInput = this.containerEl.querySelector('#stats-min-watches');
    if (minWatchesInput) minWatchesInput.value = this.plugin.settings.statsMinWatches;
    
    const minSpanInput = this.containerEl.querySelector('#stats-min-span');
    if (minSpanInput) minSpanInput.value = this.plugin.settings.statsMinSpan;

    const chkThumbnails = this.containerEl.querySelector('#chk-show-thumbnails');
    if (chkThumbnails) chkThumbnails.checked = this.plugin.settings.showThumbnails;

    const chkStatsThumbnails = this.containerEl.querySelector('#chk-stats-show-thumbnails');
    if (chkStatsThumbnails) chkStatsThumbnails.checked = this.plugin.settings.showThumbnails;

    const chkEmbedPlayer = this.containerEl.querySelector('#chk-embed-player');
    if (chkEmbedPlayer) chkEmbedPlayer.checked = this.plugin.settings.embedPlayer;

    const chkStatsEmbedPlayer = this.containerEl.querySelector('#chk-stats-embed-player');
    if (chkStatsEmbedPlayer) chkStatsEmbedPlayer.checked = this.plugin.settings.statsEmbedPlayer;

    const chkLateNight = this.containerEl.querySelector('#chk-late-night');
    if (chkLateNight) chkLateNight.checked = this.plugin.settings.statsLateNightEnabled;

    const lateNightStartInput = this.containerEl.querySelector('#late-night-start');
    if (lateNightStartInput) lateNightStartInput.value = this.plugin.settings.statsLateNightStart;

    const lateNightEndInput = this.containerEl.querySelector('#late-night-end');
    if (lateNightEndInput) lateNightEndInput.value = this.plugin.settings.statsLateNightEnd;

    const chkGroupChannel = this.containerEl.querySelector('#chk-group-channel');
    if (chkGroupChannel) chkGroupChannel.checked = this.plugin.settings.statsLateNightGroupChannel;

    const lateNightSettings = this.containerEl.querySelector('#late-night-settings');
    if (lateNightSettings) {
      if (this.plugin.settings.statsLateNightEnabled) {
        lateNightSettings.classList.remove('hidden');
      } else {
        lateNightSettings.classList.add('hidden');
      }
    }

    const phaseMinDaysInput = this.containerEl.querySelector('#phase-min-days');
    if (phaseMinDaysInput) phaseMinDaysInput.value = this.plugin.settings.phaseMinDays;

    const phaseMaxDaysInput = this.containerEl.querySelector('#phase-max-days');
    if (phaseMaxDaysInput) phaseMaxDaysInput.value = this.plugin.settings.phaseMaxDays;

    const phaseMinWatchesInput = this.containerEl.querySelector('#phase-min-watches');
    if (phaseMinWatchesInput) phaseMinWatchesInput.value = this.plugin.settings.phaseMinWatches;

    const zoomSlider = this.containerEl.querySelector('#history-zoom-slider');
    const zoomValText = this.containerEl.querySelector('#history-zoom-val');
    if (zoomSlider) zoomSlider.value = this.plugin.settings.historyZoom;
    if (zoomValText) zoomValText.textContent = `${this.plugin.settings.historyZoom.toFixed(1)}x`;

    const statsZoomSlider = this.containerEl.querySelector('#stats-zoom-slider');
    const statsZoomValText = this.containerEl.querySelector('#stats-zoom-val');
    if (statsZoomSlider) statsZoomSlider.value = this.plugin.settings.historyZoom;
    if (statsZoomValText) statsZoomValText.textContent = `${this.plugin.settings.historyZoom.toFixed(1)}x`;

    this.updateHistoryZoomVisibility();

    // Minimize stats container state
    const btnMinimizeStats = this.containerEl.querySelector('#btn-minimize-stats');
    const statsMinimizeIcon = this.containerEl.querySelector('#stats-minimize-icon');
    const statsContainer = this.containerEl.querySelector('.stats-section .stats-container');
    const statsCriteriaRow = this.containerEl.querySelector('#stats-criteria-row');
    const statsCustomDateRow = this.containerEl.querySelector('#stats-custom-date-row');
    const statsSettingsRow = this.containerEl.querySelector('#stats-settings-row');
    const statsHeaderRight = this.containerEl.querySelector('.stats-header-row div:last-child');
    
    if (this.plugin.settings.statsMinimized) {
      if (statsContainer) statsContainer.classList.add('hidden');
      if (statsCriteriaRow) statsCriteriaRow.classList.add('hidden');
      if (statsCustomDateRow) statsCustomDateRow.classList.add('hidden');
      if (statsSettingsRow) statsSettingsRow.classList.add('hidden');
      const statsLateNightRow = this.containerEl.querySelector('#stats-latenight-row');
      if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
      if (statsHeaderRight) statsHeaderRight.classList.add('hidden');
      if (statsMinimizeIcon) statsMinimizeIcon.innerHTML = '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>';
      if (btnMinimizeStats) btnMinimizeStats.title = "Expand Section";
    }

    const limitInput = this.containerEl.querySelector('#stats-limit-input');
    if (limitInput) limitInput.value = this.plugin.settings.statsLimit;

    const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');
    if (timeframeSelect) {
      timeframeSelect.value = this.plugin.settings.statsTimeframe;
      const dateRow = this.containerEl.querySelector('#stats-custom-date-row');
      if (dateRow) {
        if (timeframeSelect.value === 'custom') dateRow.classList.remove('hidden');
        else dateRow.classList.add('hidden');
      }
    }

    const modeBtn = this.containerEl.querySelector('#btn-toggle-stats-mode');
    const sectionTitle = this.containerEl.querySelector('#stats-section-title');
    if (modeBtn && sectionTitle) {
      if (this.plugin.settings.statsRankingMode === 'ratio') {
        modeBtn.textContent = 'Show Count';
        sectionTitle.textContent = 'Top Rewatched to duration ratio Videos';
      } else {
        modeBtn.textContent = 'Show Ratio';
        sectionTitle.textContent = 'Top Rewatched Videos';
      }
    }

    const startInput = this.containerEl.querySelector('#stats-start-date');
    const endInput = this.containerEl.querySelector('#stats-end-date');
    if (startInput) startInput.value = this.plugin.settings.statsStartDate;
    if (endInput) endInput.value = this.plugin.settings.statsEndDate;

    // Populate Year Dropdown
    const yearSelect = this.containerEl.querySelector('#yt-calendar-year-select');
    if (yearSelect) {
      yearSelect.innerHTML = '';
      const uniqueYears = new Set();
      const thisYear = new Date().getFullYear();
      uniqueYears.add(thisYear);
      
      this.allLogEvents.forEach(evt => {
        uniqueYears.add(new Date(evt.timestamp).getFullYear());
      });
      
      const sortedYears = Array.from(uniqueYears).sort((a, b) => a - b);
      sortedYears.forEach(yr => {
        const opt = document.createElement('option');
        opt.value = yr;
        opt.textContent = yr;
        yearSelect.appendChild(opt);
      });
      
      let defaultYear = thisYear;
      if (this.allLogEvents.length > 0) {
        defaultYear = new Date(this.allLogEvents[0].timestamp).getFullYear();
      }
      yearSelect.value = defaultYear;
      this.currentSelectedYear = defaultYear;
      
      yearSelect.onchange = (e) => {
        this.currentSelectedYear = parseInt(e.target.value);
        this.renderHeatmap(this.currentSelectedYear);
      };
    }

    const calendarTypeSelect = this.containerEl.querySelector('#yt-calendar-type-select');
    if (calendarTypeSelect) {
      calendarTypeSelect.value = this.plugin.settings.calendarType;
    }

    this.renderHeatmap(this.currentSelectedYear);
    this.renderHistoryList(this.allLogEvents);
    this.renderTopVideos();
    this.renderTopAds();

    if (this.showAdsView) {
      this.syncAdsViewUI(true);
    }

    this.renderShiftAnalysis();
    this.renderPhaseDetector();
    this.renderFormatShiftAnalysis();
  }

  processLogEvents() {
    const events = [];
    const { watches, metadata } = this.watchHistory;

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
          year: dt.getFullYear(),
          dateStr: getLocalDateString(dt)
        });
      });
    });

    events.sort((a, b) => b.timestamp - a.timestamp);
    this.allLogEvents = events;
  }

  setupEventListeners() {
    const searchInput = this.containerEl.querySelector('#search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) {
          this.renderHistoryList(this.allLogEvents);
          return;
        }
        const filtered = this.allLogEvents.filter(
          (event) =>
            event.title.toLowerCase().includes(query) ||
            event.channel.toLowerCase().includes(query)
        );
        this.renderHistoryList(filtered);
      });
    }

    const chkThumbnails = this.containerEl.querySelector('#chk-show-thumbnails');
    if (chkThumbnails) {
      chkThumbnails.addEventListener('change', (e) => this.handleThumbnailsChange(e.target.checked));
    }
    const chkStatsThumbnails = this.containerEl.querySelector('#chk-stats-show-thumbnails');
    if (chkStatsThumbnails) {
      chkStatsThumbnails.addEventListener('change', (e) => this.handleThumbnailsChange(e.target.checked));
    }

    const chkEmbedPlayer = this.containerEl.querySelector('#chk-embed-player');
    if (chkEmbedPlayer) {
      chkEmbedPlayer.addEventListener('change', (e) => this.handleEmbedPlayerChange(e.target.checked));
    }
    const chkStatsEmbedPlayer = this.containerEl.querySelector('#chk-stats-embed-player');
    if (chkStatsEmbedPlayer) {
      chkStatsEmbedPlayer.addEventListener('change', (e) => this.handleStatsEmbedPlayerChange(e.target.checked));
    }

    const zoomSlider = this.containerEl.querySelector('#history-zoom-slider');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => this.handleZoomSliderInput(parseFloat(e.target.value)));
      zoomSlider.addEventListener('change', () => this.handleZoomSliderChange());
    }
    const statsZoomSlider = this.containerEl.querySelector('#stats-zoom-slider');
    if (statsZoomSlider) {
      statsZoomSlider.addEventListener('input', (e) => this.handleZoomSliderInput(parseFloat(e.target.value)));
      statsZoomSlider.addEventListener('change', () => this.handleZoomSliderChange());
    }

    // Late-Night Index listeners
    const chkLateNight = this.containerEl.querySelector('#chk-late-night');
    if (chkLateNight) {
      chkLateNight.addEventListener('change', (e) => {
        this.plugin.settings.statsLateNightEnabled = e.target.checked;
        const lateNightSettings = this.containerEl.querySelector('#late-night-settings');
        if (lateNightSettings) {
          if (e.target.checked) {
            lateNightSettings.classList.remove('hidden');
          } else {
            lateNightSettings.classList.add('hidden');
          }
        }
        this.plugin.saveSettings().then(() => {
          this.renderTopVideos();
          if (this.plugin.settings.focusTopVideos) {
            this.renderHeatmap(this.currentSelectedYear);
          }
        });
      });
    }

    const lateNightStart = this.containerEl.querySelector('#late-night-start');
    if (lateNightStart) {
      lateNightStart.addEventListener('change', (e) => {
        this.plugin.settings.statsLateNightStart = e.target.value;
        this.plugin.saveSettings().then(() => {
          this.renderTopVideos();
          if (this.plugin.settings.focusTopVideos) this.renderHeatmap(this.currentSelectedYear);
        });
      });
    }

    const lateNightEnd = this.containerEl.querySelector('#late-night-end');
    if (lateNightEnd) {
      lateNightEnd.addEventListener('change', (e) => {
        this.plugin.settings.statsLateNightEnd = e.target.value;
        this.plugin.saveSettings().then(() => {
          this.renderTopVideos();
          if (this.plugin.settings.focusTopVideos) this.renderHeatmap(this.currentSelectedYear);
        });
      });
    }

    const chkGroupChannel = this.containerEl.querySelector('#chk-group-channel');
    if (chkGroupChannel) {
      chkGroupChannel.addEventListener('change', (e) => {
        this.plugin.settings.statsLateNightGroupChannel = e.target.checked;
        this.plugin.saveSettings().then(() => {
          this.renderTopVideos();
        });
      });
    }

    const calendarTypeSelect = this.containerEl.querySelector('#yt-calendar-type-select');
    if (calendarTypeSelect) {
      calendarTypeSelect.addEventListener('change', (e) => {
        this.plugin.settings.calendarType = e.target.value;
        this.plugin.saveSettings().then(() => this.renderHeatmap(this.currentSelectedYear));
      });
    }

    // Toggle Calendar Button
    const toggleCalendarBtn = this.containerEl.querySelector('#btn-toggle-calendar');
    const calendarContainer = this.containerEl.querySelector('.yt-tracker-calendar-container');
    const calendarLegend = this.containerEl.querySelector('.yt-tracker-calendar-legend');
    if (toggleCalendarBtn && calendarContainer && calendarLegend) {
      if (this.plugin.settings.calendarHidden) {
        calendarContainer.classList.add('hidden');
        calendarLegend.classList.add('hidden');
        toggleCalendarBtn.textContent = 'Show Calendar';
      }
      toggleCalendarBtn.addEventListener('click', () => {
        const isHidden = calendarContainer.classList.contains('hidden');
        if (isHidden) {
          calendarContainer.classList.remove('hidden');
          calendarLegend.classList.remove('hidden');
          toggleCalendarBtn.textContent = 'Hide Calendar';
          this.plugin.settings.calendarHidden = false;
        } else {
          calendarContainer.classList.add('hidden');
          calendarLegend.classList.add('hidden');
          toggleCalendarBtn.textContent = 'Show Calendar';
          this.plugin.settings.calendarHidden = true;
        }
        this.plugin.saveSettings();
      });
    }

    // Stats criteria settings listeners
    const limitInput = this.containerEl.querySelector('#stats-limit-input');
    if (limitInput) {
      limitInput.addEventListener('change', (e) => {
        let inputVal = e.target.value.trim();
        let val;
        if (inputVal === '∞' || inputVal.toLowerCase() === 'infinity') {
          val = '∞';
        } else {
          val = parseInt(inputVal) || 10;
          if (val < 1) val = 1;
        }
        e.target.value = val;
        this.plugin.settings.statsLimit = val;

        if (val === '∞' || val > 250) {
          const confirmPaginate = confirm(
            "Warning: Loading a very large number of results (or infinity) may cause Obsidian to lag or hang.\n\n" +
            "Would you like to enable paginated loading (50 items at a time) to prevent hanging?\n\n" +
            "Click OK to enable pagination (Recommended).\n" +
            "Click Cancel to load all results at once."
          );
          this.statsPaginateAlways = confirmPaginate;
        } else {
          this.statsPaginateAlways = true;
        }

        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }

    const btnStatsLimitInfinity = this.containerEl.querySelector('#btn-stats-limit-infinity');
    if (btnStatsLimitInfinity && limitInput) {
      btnStatsLimitInfinity.addEventListener('click', () => {
        limitInput.value = '∞';
        limitInput.dispatchEvent(new Event('change'));
      });
    }

    const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');
    if (timeframeSelect) {
      timeframeSelect.addEventListener('change', (e) => {
        this.plugin.settings.statsTimeframe = e.target.value;
        const dateRow = this.containerEl.querySelector('#stats-custom-date-row');
        if (dateRow) {
          if (e.target.value === 'custom') dateRow.classList.remove('hidden');
          else dateRow.classList.add('hidden');
        }
        this.plugin.saveSettings().then(() => {
          this.renderTopVideos();
          this.renderTopAds();
        });
      });
    }

    const startInput = this.containerEl.querySelector('#stats-start-date');
    if (startInput) {
      startInput.addEventListener('change', (e) => {
        this.plugin.settings.statsStartDate = e.target.value;
        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }
    const endInput = this.containerEl.querySelector('#stats-end-date');
    if (endInput) {
      endInput.addEventListener('change', (e) => {
        this.plugin.settings.statsEndDate = e.target.value;
        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }

    const minWatchesInput = this.containerEl.querySelector('#stats-min-watches');
    if (minWatchesInput) {
      minWatchesInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val) || val < 1) val = 1;
        e.target.value = val;
        this.plugin.settings.statsMinWatches = val;
        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }

    const minSpanInput = this.containerEl.querySelector('#stats-min-span');
    if (minSpanInput) {
      minSpanInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val) || val < 0) val = 0;
        e.target.value = val;
        this.plugin.settings.statsMinSpan = val;
        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }

    const toggleStatsModeBtn = this.containerEl.querySelector('#btn-toggle-stats-mode');
    const statsTitle = this.containerEl.querySelector('#stats-section-title');
    if (toggleStatsModeBtn && statsTitle) {
      toggleStatsModeBtn.addEventListener('click', () => {
        if (this.plugin.settings.statsRankingMode === 'count') {
          this.plugin.settings.statsRankingMode = 'ratio';
          toggleStatsModeBtn.textContent = 'Show Count';
          statsTitle.textContent = 'Top Rewatched to duration ratio Videos';
        } else {
          this.plugin.settings.statsRankingMode = 'count';
          toggleStatsModeBtn.textContent = 'Show Ratio';
          statsTitle.textContent = 'Top Rewatched Videos';
        }
        this.plugin.saveSettings().then(() => this.renderTopVideos());
      });
    }

    // Stats minimisation
    const btnMinimizeStats = this.containerEl.querySelector('#btn-minimize-stats');
    const statsMinimizeIcon = this.containerEl.querySelector('#stats-minimize-icon');
    const statsContainer = this.containerEl.querySelector('.stats-section .stats-container');
    const statsCriteriaRow = this.containerEl.querySelector('#stats-criteria-row');
    const statsCustomDateRow = this.containerEl.querySelector('#stats-custom-date-row');
    const statsSettingsRow = this.containerEl.querySelector('#stats-settings-row');
    const statsHeaderRight = this.containerEl.querySelector('.stats-header-row div:last-child');

    if (btnMinimizeStats) {
      btnMinimizeStats.addEventListener('click', () => {
        this.plugin.settings.statsMinimized = !this.plugin.settings.statsMinimized;
        if (this.plugin.settings.statsMinimized) {
          if (statsContainer) statsContainer.classList.add('hidden');
          if (statsCriteriaRow) statsCriteriaRow.classList.add('hidden');
          if (statsCustomDateRow) statsCustomDateRow.classList.add('hidden');
          if (statsSettingsRow) statsSettingsRow.classList.add('hidden');
          const statsLateNightRow = this.containerEl.querySelector('#stats-latenight-row');
          if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
          if (statsHeaderRight) statsHeaderRight.classList.add('hidden');
          if (statsMinimizeIcon) statsMinimizeIcon.innerHTML = '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>';
          btnMinimizeStats.title = "Expand Section";
        } else {
          if (statsContainer) statsContainer.classList.remove('hidden');
          if (statsSettingsRow) statsSettingsRow.classList.remove('hidden');
          if (!this.showAdsView) {
            if (statsCriteriaRow) statsCriteriaRow.classList.remove('hidden');
            const statsLateNightRow = this.containerEl.querySelector('#stats-latenight-row');
            if (statsLateNightRow) statsLateNightRow.classList.remove('hidden');
            const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');
            if (timeframeSelect && timeframeSelect.value === 'custom') {
              if (statsCustomDateRow) statsCustomDateRow.classList.remove('hidden');
            }
          }
          if (statsHeaderRight) statsHeaderRight.classList.remove('hidden');
          if (statsMinimizeIcon) statsMinimizeIcon.innerHTML = '<path d="M19 13H5v-2h14v2z"/>';
          btnMinimizeStats.title = "Minimize Section";
        }
        this.plugin.saveSettings();
      });
    }

    // Toggle ads button
    const toggleAdsViewBtn = this.containerEl.querySelector('#btn-toggle-ads-view');
    if (toggleAdsViewBtn) {
      toggleAdsViewBtn.addEventListener('click', () => {
        this.showAdsView = !this.showAdsView;
        this.syncAdsViewUI();
      });
    }

    const resetIgnoredBtn = this.containerEl.querySelector('#btn-reset-ignored');
    if (resetIgnoredBtn) {
      resetIgnoredBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to restore all discarded videos to the repeat stats?')) {
          this.plugin.settings.ignoredVideoIds = [];
          this.plugin.saveSettings().then(() => {
            this.renderTopVideos();
            this.renderShiftAnalysis();
            this.renderPhaseDetector();
            this.renderFormatShiftAnalysis();
            new Notice('Discarded videos restored!');
          });
        }
      });
    }

    // Recalculate phases
    const btnRecalcPhases = this.containerEl.querySelector('#btn-recalculate-phases');
    if (btnRecalcPhases) {
      btnRecalcPhases.addEventListener('click', () => {
        const minDaysInput = this.containerEl.querySelector('#phase-min-days');
        const maxDaysInput = this.containerEl.querySelector('#phase-max-days');
        const minWatchesInput = this.containerEl.querySelector('#phase-min-watches');
        
        let minD = minDaysInput ? parseInt(minDaysInput.value) : 30;
        let maxD = maxDaysInput ? parseInt(maxDaysInput.value) : 60;
        let minW = minWatchesInput ? parseInt(minWatchesInput.value) : 10;
        
        if (isNaN(minD) || minD < 1) minD = 30;
        if (isNaN(maxD) || maxD < minD) maxD = 60;
        if (isNaN(minW) || minW < 1) minW = 10;
        
        if (minDaysInput) minDaysInput.value = minD;
        if (maxDaysInput) maxDaysInput.value = maxD;
        if (minWatchesInput) minWatchesInput.value = minW;
        
        this.plugin.settings.phaseMinDays = minD;
        this.plugin.settings.phaseMaxDays = maxD;
        this.plugin.settings.phaseMinWatches = minW;
        
        this.plugin.saveSettings().then(() => {
          this.renderPhaseDetector();
        });
      });
    }

    // Highlight top focus toggle
    const focusTopBtn = this.containerEl.querySelector('#btn-focus-top');
    if (focusTopBtn) {
      if (this.plugin.settings.focusTopVideos) {
        focusTopBtn.style.background = 'rgba(99, 102, 241, 0.2)';
        focusTopBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
        focusTopBtn.style.color = '#a5b4fc';
      }
      focusTopBtn.addEventListener('click', () => {
        this.plugin.settings.focusTopVideos = !this.plugin.settings.focusTopVideos;
        if (this.plugin.settings.focusTopVideos) {
          focusTopBtn.style.background = 'rgba(99, 102, 241, 0.2)';
          focusTopBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
          focusTopBtn.style.color = '#a5b4fc';
        } else {
          focusTopBtn.style.background = '';
          focusTopBtn.style.borderColor = '';
          focusTopBtn.style.color = '';
        }
        this.plugin.saveSettings().then(() => {
          this.renderHeatmap(this.currentSelectedYear);
        });
      });
    }

    // Daily Log copy event listeners
    const btnCopyToday = this.containerEl.querySelector('#btn-copy-today');
    if (btnCopyToday) {
      btnCopyToday.addEventListener('click', () => {
        const mdText = this.getMarkdownForDate(new Date());
        navigator.clipboard.writeText(mdText);
        new Notice('Copied Today\'s logs to clipboard!');
      });
    }

    const btnCopyYesterday = this.containerEl.querySelector('#btn-copy-yesterday');
    if (btnCopyYesterday) {
      btnCopyYesterday.addEventListener('click', () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const mdText = this.getMarkdownForDate(yesterday);
        navigator.clipboard.writeText(mdText);
        new Notice('Copied Yesterday\'s logs to clipboard!');
      });
    }

    const btnAppendToday = this.containerEl.querySelector('#btn-append-today');
    if (btnAppendToday) {
      btnAppendToday.addEventListener('click', () => {
        const mdText = this.getMarkdownForDate(new Date());
        this.appendLogToActiveFile(mdText);
      });
    }

    const btnExportMarkdown = this.containerEl.querySelector('#btn-export-markdown');
    if (btnExportMarkdown) {
      btnExportMarkdown.addEventListener('click', () => this.exportFullHistory());
    }

    // JSON upload listener
    const importTrigger = this.containerEl.querySelector('#btn-import-trigger');
    const fileInput = this.containerEl.querySelector('#takeout-file');
    if (importTrigger && fileInput) {
      importTrigger.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => this.handleFileImport(e));
    }

    // Clear history
    const clearHistoryBtn = this.containerEl.querySelector('#btn-reset-history');
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        if (confirm('CAUTION: This will delete ALL watches and metadata. Are you sure?')) {
          this.plugin.updateHistory((h) => {
            // One copy is kept next to the history file until the next reset.
            return this.plugin.writeBackup(h).then(() => {
              h.watches = {};
              h.metadata = {};
            });
          }).then(() => {
            this.loadHistory();
            new Notice('YouTube history database reset! (A backup copy was kept)');
          }, (e) => new Notice(`Couldn't reset: ${e.message}`));
        }
      });
    }
  }

  syncAdsViewUI(initial = false) {
    const topVideosList = this.containerEl.querySelector('#top-videos-list');
    const topAdsList = this.containerEl.querySelector('#top-ads-list');
    const statsTitle = this.containerEl.querySelector('#stats-section-title');
    const toggleStatsModeBtn = this.containerEl.querySelector('#btn-toggle-stats-mode');
    const criteriaRow = this.containerEl.querySelector('#stats-criteria-row');
    const customDateRow = this.containerEl.querySelector('#stats-custom-date-row');
    const toggleAdsViewBtn = this.containerEl.querySelector('#btn-toggle-ads-view');
    const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');

    if (this.showAdsView) {
      if (topVideosList) topVideosList.classList.add('hidden');
      if (topAdsList) topAdsList.classList.remove('hidden');
      if (statsTitle) statsTitle.textContent = 'Top Serviced Advertisements';
      if (toggleStatsModeBtn) toggleStatsModeBtn.classList.add('hidden');
      if (criteriaRow) criteriaRow.classList.add('hidden');
      const statsLateNightRow = this.containerEl.querySelector('#stats-latenight-row');
      if (statsLateNightRow) statsLateNightRow.classList.add('hidden');
      if (customDateRow) customDateRow.classList.add('hidden');
      
      if (toggleAdsViewBtn) {
        toggleAdsViewBtn.style.background = 'rgba(99, 102, 241, 0.2)';
        toggleAdsViewBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
        toggleAdsViewBtn.style.color = '#a5b4fc';
      }
      
      this.renderTopAds();
    } else {
      if (topVideosList) topVideosList.classList.remove('hidden');
      if (topAdsList) topAdsList.classList.add('hidden');
      if (statsTitle) {
        if (this.plugin.settings.statsRankingMode === 'ratio') {
          statsTitle.textContent = 'Top Rewatched to duration ratio Videos';
        } else {
          statsTitle.textContent = 'Top Rewatched Videos';
        }
      }
      if (toggleStatsModeBtn) toggleStatsModeBtn.classList.remove('hidden');
      if (!this.plugin.settings.statsMinimized) {
        if (criteriaRow) criteriaRow.classList.remove('hidden');
        const statsLateNightRow = this.containerEl.querySelector('#stats-latenight-row');
        if (statsLateNightRow) statsLateNightRow.classList.remove('hidden');
        if (timeframeSelect && timeframeSelect.value === 'custom') {
          if (customDateRow) customDateRow.classList.remove('hidden');
        }
      }
      
      if (toggleAdsViewBtn) {
        toggleAdsViewBtn.style.background = '';
        toggleAdsViewBtn.style.borderColor = '';
        toggleAdsViewBtn.style.color = '';
      }
      
      this.renderTopVideos();
    }
  }

  handleThumbnailsChange(checked) {
    this.plugin.settings.showThumbnails = checked;
    
    const chkThumbnails = this.containerEl.querySelector('#chk-show-thumbnails');
    const chkStatsThumbnails = this.containerEl.querySelector('#chk-stats-show-thumbnails');
    if (chkThumbnails) chkThumbnails.checked = checked;
    if (chkStatsThumbnails) chkStatsThumbnails.checked = checked;

    this.plugin.saveSettings().then(() => {
      this.updateHistoryZoomVisibility();
      
      const searchInput = this.containerEl.querySelector('#search-input');
      const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
      const filtered = query
        ? this.allLogEvents.filter(
            (event) =>
              event.title.toLowerCase().includes(query) ||
              event.channel.toLowerCase().includes(query)
          )
        : this.allLogEvents;
      this.renderHistoryList(filtered);
      this.renderTopVideos();
      this.renderTopAds();
    });
  }

  handleEmbedPlayerChange(checked) {
    this.plugin.settings.embedPlayer = checked;

    const chkEmbedPlayer = this.containerEl.querySelector('#chk-embed-player');
    if (chkEmbedPlayer) chkEmbedPlayer.checked = checked;

    this.plugin.saveSettings().then(() => {
      this.updateHistoryZoomVisibility();
      
      const searchInput = this.containerEl.querySelector('#search-input');
      const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
      const filtered = query
        ? this.allLogEvents.filter(
            (event) =>
              event.title.toLowerCase().includes(query) ||
              event.channel.toLowerCase().includes(query)
          )
        : this.allLogEvents;
      this.renderHistoryList(filtered);
    });
  }

  handleStatsEmbedPlayerChange(checked) {
    this.plugin.settings.statsEmbedPlayer = checked;

    const chkStatsEmbedPlayer = this.containerEl.querySelector('#chk-stats-embed-player');
    if (chkStatsEmbedPlayer) chkStatsEmbedPlayer.checked = checked;

    this.plugin.saveSettings().then(() => {
      this.updateHistoryZoomVisibility();
      
      this.renderTopVideos();
      this.renderTopAds();
    });
  }

  handleZoomSliderInput(val) {
    this.plugin.settings.historyZoom = val;

    const zoomSlider = this.containerEl.querySelector('#history-zoom-slider');
    const statsZoomSlider = this.containerEl.querySelector('#stats-zoom-slider');
    if (zoomSlider) zoomSlider.value = val;
    if (statsZoomSlider) statsZoomSlider.value = val;

    const zoomValText = this.containerEl.querySelector('#history-zoom-val');
    const statsZoomValText = this.containerEl.querySelector('#stats-zoom-val');
    if (zoomValText) zoomValText.textContent = `${val.toFixed(1)}x`;
    if (statsZoomValText) statsZoomValText.textContent = `${val.toFixed(1)}x`;

    const dashboardEl = this.containerEl.querySelector('.yt-tracker-dashboard');
    if (dashboardEl) {
      dashboardEl.style.setProperty('--zoom-scale', val);
    }
  }

  handleZoomSliderChange() {
    this.plugin.saveSettings();
  }

  updateHistoryZoomVisibility() {
    const chkEmbed = this.containerEl.querySelector('#chk-embed-player');
    const chkStatsEmbed = this.containerEl.querySelector('#chk-stats-embed-player');
    const zoomControl = this.containerEl.querySelector('#history-zoom-control');
    const statsZoomControl = this.containerEl.querySelector('#stats-zoom-control');

    if (chkEmbed) chkEmbed.checked = this.plugin.settings.embedPlayer;
    if (chkStatsEmbed) chkStatsEmbed.checked = this.plugin.settings.statsEmbedPlayer;

    const isEmbedPlayer = this.plugin.settings.embedPlayer;
    const isStatsEmbedPlayer = this.plugin.settings.statsEmbedPlayer;

    const showZoom = isEmbedPlayer && this.plugin.settings.showThumbnails;
    const showStatsZoom = isStatsEmbedPlayer && this.plugin.settings.showThumbnails;

    if (zoomControl) {
      if (showZoom) zoomControl.classList.remove('hidden');
      else zoomControl.classList.add('hidden');
    }
    if (statsZoomControl) {
      if (showStatsZoom) statsZoomControl.classList.remove('hidden');
      else statsZoomControl.classList.add('hidden');
    }

    const lblEmbedPlayer = this.containerEl.querySelector('#lbl-embed-player');
    const lblStatsEmbedPlayer = this.containerEl.querySelector('#lbl-stats-embed-player');
    if (lblEmbedPlayer) {
      lblEmbedPlayer.style.display = this.plugin.settings.showThumbnails ? 'flex' : 'none';
    }
    if (lblStatsEmbedPlayer) {
      lblStatsEmbedPlayer.style.display = this.plugin.settings.showThumbnails ? 'flex' : 'none';
    }

    const dashboardEl = this.containerEl.querySelector('.yt-tracker-dashboard');
    if (dashboardEl) {
      if (showZoom || showStatsZoom) {
        dashboardEl.style.setProperty('--zoom-scale', this.plugin.settings.historyZoom);
      } else {
        dashboardEl.style.removeProperty('--zoom-scale');
      }
    }
  }

  renderHeatmap(selectedYear) {
    const containerEl = this.containerEl.querySelector('#yt-calendar-vertical-list');
    if (!containerEl) return;
    containerEl.innerHTML = '';

    const watchedDates = {};
    this.allLogEvents.forEach((event) => {
      if (event.year !== selectedYear) return;

      const isShort = event.channel === 'YouTube Shorts' || event.channel === 'Shorts';
      if (this.plugin.settings.calendarType === 'videos' && isShort) return;
      if (this.plugin.settings.calendarType === 'shorts' && !isShort) return;

      const dateStr = event.dateStr;
      if (!watchedDates[dateStr]) watchedDates[dateStr] = [];
      watchedDates[dateStr].push(event);
    });

    let maxCount = 1;
    Object.keys(watchedDates).forEach((dateStr) => {
      maxCount = Math.max(maxCount, watchedDates[dateStr].length);
    });

    for (let month = 0; month <= 11; month++) {
      const targetDate = new Date(selectedYear, month, 1);
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

      const firstDay = new Date(selectedYear, month, 1).getDay();
      for (let offset = 0; offset < firstDay; offset++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'yt-calendar-day-cell offset';
        daysGrid.appendChild(emptyCell);
      }

      const totalDays = new Date(selectedYear, month + 1, 0).getDate();
      for (let day = 1; day <= totalDays; day++) {
        const cell = document.createElement('div');
        cell.className = 'yt-calendar-day-cell';
        cell.textContent = day;

        const dateStr = `${selectedYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const cellDate = new Date(selectedYear, month, day);
        const watchesOnDay = watchedDates[dateStr] || [];

        // Check Phase Highlights
        let isPhaseTarget = false;
        let isPhaseRange = false;
        if (this.activePhaseHighlight) {
          const cellTimeStart = cellDate.getTime();
          const cellTimeEnd = new Date(selectedYear, month, day, 23, 59, 59, 999).getTime();
          if (cellTimeEnd >= this.activePhaseHighlight.startTimestamp && cellTimeStart <= this.activePhaseHighlight.endTimestamp) {
            isPhaseRange = true;
            isPhaseTarget = watchesOnDay.some(evt => evt.channel === this.activePhaseHighlight.channel);
          }
        }

        // Check Highlight Top focus filtering
        let isFocusTarget = false;
        if (this.plugin.settings.focusTopVideos && watchesOnDay.length > 0) {
          const topIds = this.getFilteredTopVideoIds();
          isFocusTarget = watchesOnDay.some(evt => topIds.includes(evt.videoId));
        }

        if (watchesOnDay.length > 0) {
          cell.classList.add('cell-watched');
          const count = watchesOnDay.length;
          const ratio = maxCount > 1 ? (count - 1) / (maxCount - 1) : 0;
          
          const hue = Math.floor(239 + ratio * 41);
          const alpha = 0.15 + ratio * 0.70;
          const lightness = Math.floor(67 - ratio * 12);
          
          let bgColor = `hsla(${hue}, 84%, ${lightness}%, ${alpha})`;
          let borderColor = `hsla(${hue}, 84%, ${lightness - 10}%, ${alpha + 0.2})`;
          let textColor = ratio > 0.5 ? '#ffffff' : '#a5b4fc';
          let finalShadow = '';

          let hoverBg = `hsla(${hue}, 84%, ${lightness - 5}%, ${Math.min(1, alpha + 0.15)})`;
          let hoverBorder = `hsla(${hue}, 84%, ${lightness - 15}%, ${Math.min(1, alpha + 0.3)})`;
          let hoverShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, ${Math.min(0.6, alpha + 0.2)})`;

          if (isPhaseTarget) {
            cell.classList.add('cell-phase-target');
            bgColor = 'rgba(251, 191, 36, 0.25)';
            borderColor = '#fbbf24';
            textColor = '#fff';
            finalShadow = '0 0 10px rgba(251, 191, 36, 0.4)';
            
            hoverBg = 'rgba(251, 191, 36, 0.35)';
            hoverBorder = '#fbbf24';
            hoverShadow = '0 0 15px rgba(251, 191, 36, 0.6)';
          } else if (isPhaseRange) {
            cell.classList.add('cell-phase-range');
            borderColor = 'rgba(251, 191, 36, 0.6)';
            hoverBorder = 'rgba(251, 191, 36, 0.8)';
          } else if (this.plugin.settings.focusTopVideos) {
            if (isFocusTarget) {
              bgColor = 'rgba(99, 102, 241, 0.65)';
              borderColor = '#818cf8';
              textColor = '#fff';
              finalShadow = '0 0 6px rgba(99, 102, 241, 0.4)';
              
              hoverBg = 'rgba(99, 102, 241, 0.8)';
              hoverBorder = '#a5b4fc';
              hoverShadow = '0 0 10px rgba(99, 102, 241, 0.6)';
            } else {
              bgColor = 'rgba(255, 255, 255, 0.02)';
              borderColor = 'rgba(255, 255, 255, 0.04)';
              textColor = 'rgba(255, 255, 255, 0.15)';
              
              hoverBg = 'rgba(255, 255, 255, 0.06)';
              hoverBorder = 'rgba(255, 255, 255, 0.1)';
            }
          }
          
          cell.style.background = bgColor;
          cell.style.borderColor = borderColor;
          cell.style.color = textColor;
          if (finalShadow) cell.style.boxShadow = finalShadow;

          cell.addEventListener('mouseenter', () => {
            cell.style.background = `hsla(${hue}, 84%, ${lightness - 5}%, ${Math.min(1, alpha + 0.15)})`;
            cell.style.borderColor = `hsla(${hue}, 84%, ${lightness - 15}%, ${Math.min(1, alpha + 0.3)})`;
            cell.style.boxShadow = `0 0 10px hsla(${hue}, 84%, ${lightness}%, ${Math.min(0.6, alpha + 0.2)})`;

            if (!cell.title) {
              const dateFormatted = cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              let tooltipText = `${dateFormatted}\n${count} video${count > 1 ? 's' : ''} watched\n\n`;
              const maxDetails = 5;
              const detailsList = [...watchesOnDay].reverse().map(event => {
                const timeStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                return `• [${timeStr}] ${event.title}`;
              });
              
              tooltipText += detailsList.slice(0, maxDetails).join('\n');
              if (detailsList.length > maxDetails) {
                tooltipText += `\n... and ${detailsList.length - maxDetails} more`;
              }
              cell.title = tooltipText;
            }
          });
          cell.addEventListener('mouseleave', () => {
            cell.style.background = bgColor;
            cell.style.borderColor = borderColor;
            cell.style.boxShadow = finalShadow;
          });
        } else {
          cell.classList.add('cell-empty');
          cell.addEventListener('mouseenter', () => {
            if (!cell.title) {
              cell.title = `${cellDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}\nNo activity recorded`;
            }
          });
        }

        daysGrid.appendChild(cell);
      }

      monthBlock.appendChild(daysGrid);
      containerEl.appendChild(monthBlock);
    }

    // Render visual years row
    this.renderYearSelectorRow();
  }

  renderYearSelectorRow() {
    const rowContainer = this.containerEl.querySelector('#yt-calendar-years-row');
    if (!rowContainer) return;
    rowContainer.innerHTML = '';

    // Get unique years and their watch counts
    const yearCounts = {};
    const uniqueYears = new Set();
    const thisYear = new Date().getFullYear();
    uniqueYears.add(thisYear);
    yearCounts[thisYear] = 0;

    this.allLogEvents.forEach((evt) => {
      const isShort = evt.channel === 'YouTube Shorts' || evt.channel === 'Shorts';
      if (this.plugin.settings.calendarType === 'videos' && isShort) return;
      if (this.plugin.settings.calendarType === 'shorts' && !isShort) return;

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
      if (yr === this.currentSelectedYear) {
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
        this.currentSelectedYear = yr;
        const yearSelect = this.containerEl.querySelector('#yt-calendar-year-select');
        if (yearSelect) {
          yearSelect.value = yr;
        }
        this.renderHeatmap(yr);
      });

      rowContainer.appendChild(pill);
    });
  }

  renderHistoryList(events) {
    const listEl = this.containerEl.querySelector('#history-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (events.length === 0) {
      listEl.innerHTML = '<li class="empty-history">No watch history found matching the filters.</li>';
      return;
    }

    const itemsToRender = events.slice(0, 100); // Caps history rendering to 100 items for layout performance
    itemsToRender.forEach((event) => {
      const li = document.createElement('li');
      li.className = 'history-item';

      const date = new Date(event.timestamp);
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      let mediaHtml = '';
      const isNormalVideo = !event.videoId.startsWith('search:') && !event.videoId.startsWith('visit:');
      if (this.plugin.settings.showThumbnails && isNormalVideo) {
        if (this.plugin.settings.embedPlayer) {
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

      const isSearch = event.videoId.startsWith('search:');
      const isVisit = event.videoId.startsWith('visit:');
      const url = getEventUrl(event);

      let titleMarkup = `<a href="${esc(url)}" target="_blank">${esc(event.title)}</a>`;
      if (isSearch) {
        const query = decodeURIComponent(event.videoId.substring(7));
        titleMarkup = `Searched: <a href="${esc(url)}" target="_blank" style="font-style: italic; color: #a855f7;">"${esc(query)}"</a>`;
      } else if (isVisit) {
        titleMarkup = `Visited Sponsored link: <a href="${esc(url)}" target="_blank" style="color: #f87171;">${esc(event.title)}</a>`;
      }

      let durationMarkup = event.duration ? `<span class="history-duration" style="background: rgba(255, 255, 255, 0.05); padding: 1px 4px; border-radius: 3px; font-weight: 500;">${event.duration}</span>` : '';

      li.innerHTML = `
        ${mediaHtml}
        <div class="history-info">
          <h4 class="history-title">${titleMarkup}</h4>
          <div class="history-meta">
            <span class="history-channel">${esc(event.channel)}</span>
            <span>•</span>
            <span class="history-time" title="${date.toLocaleString()}">${dateStr}, ${timeStr}</span>
            ${durationMarkup}
          </div>
        </div>
        <div class="history-actions">
          ${isNormalVideo ? `
          <button class="icon-btn calendar-btn" title="Open Watch History Calendar">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm-5-7h-5v5h5v-5z"/>
            </svg>
          </button>
          ` : ''}
          <button class="icon-btn delete-btn" title="Delete log entry">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
          </button>
        </div>
      `;

      const calendarBtn = li.querySelector('.calendar-btn');
      if (calendarBtn) {
        calendarBtn.addEventListener('click', () => {
          this.openVideoCalendarModal(event.videoId, event.title, event.channel);
        });
      }

      const deleteBtn = li.querySelector('.delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          if (confirm(`Remove this watch entry from database?`)) {
            this.plugin.updateHistory((h) => {
              const vWatches = (h.watches[event.videoId] || []).filter((t) => t !== event.timestamp);
              if (vWatches.length) h.watches[event.videoId] = vWatches;
              else {
                delete h.watches[event.videoId];
                delete h.metadata[event.videoId];
              }
            }).then(() => {
              this.loadHistory();
              new Notice('Entry removed!');
            }, (e) => new Notice(`Couldn't remove it: ${e.message}`));
          }
        });
      }

      listEl.appendChild(li);
    });
  }

  renderTopVideos(resetPagination = true) {
    if (resetPagination) {
      this.statsPaginatedLimit = 50;
    }
    const listEl = this.containerEl.querySelector('#top-videos-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const resetIgnoredBtn = this.containerEl.querySelector('#btn-reset-ignored');
    if (resetIgnoredBtn) {
      if (this.plugin.settings.ignoredVideoIds.length > 0) resetIgnoredBtn.classList.remove('hidden');
      else resetIgnoredBtn.classList.add('hidden');
    }

    const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');
    const timeframeVal = timeframeSelect ? timeframeSelect.value : 'all';
    
    let startTime = 0;
    let endTime = Infinity;
    
    if (timeframeVal === 'custom') {
      const startVal = this.plugin.settings.statsStartDate;
      const endVal = this.plugin.settings.statsEndDate;
      if (startVal) startTime = new Date(startVal + 'T00:00:00').getTime();
      if (endVal) endTime = new Date(endVal + 'T23:59:59').getTime();
    } else if (timeframeVal !== 'all') {
      const days = parseInt(timeframeVal) || 30;
      startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    }

    const limitVal = this.plugin.settings.statsLimit || '10';
    const limit = limitVal === '∞' || limitVal.toLowerCase() === 'infinity' ? Infinity : (parseInt(limitVal) || 10);
    const { watches, metadata } = this.watchHistory;
    // Group by Channel if Late-Night Index is enabled and Group by Channel is checked
    if (this.plugin.settings.statsLateNightEnabled && this.plugin.settings.statsLateNightGroupChannel) {
      const channelStatsMap = {};
      Object.keys(watches).forEach((videoId) => {
        if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
        if (this.plugin.settings.ignoredVideoIds.includes(videoId)) return;

        const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };

        // Ignore Google Ads items
        const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
        if (isAd) return;

        const rawTimestamps = watches[videoId] || [];
        let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
        timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, this.plugin.settings.statsLateNightStart, this.plugin.settings.statsLateNightEnd));
        
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
      let filteredChannelStats = channelStats.filter(c => c.count >= this.plugin.settings.statsMinWatches);
      filteredChannelStats.sort((a, b) => b.count - a.count);
      const topXChannels = filteredChannelStats.slice(0, limit);

      if (topXChannels.length === 0) {
        listEl.innerHTML = '<li class="empty-stats">No channel watch data matches this timeframe/Late-Night filter.</li>';
        return;
      }

      const renderLimit = this.statsPaginateAlways ? Math.min(limit, this.statsPaginatedLimit) : limit;
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
          this.statsPaginatedLimit += 50;
          this.renderTopVideos(false);
        });

        loadMoreLi.appendChild(loadMoreBtn);
        listEl.appendChild(loadMoreLi);
      }

      return;
    }

    const videoStats = [];

    Object.keys(watches).forEach((videoId) => {
      if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
      if (this.plugin.settings.ignoredVideoIds.includes(videoId)) return;

      const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
      const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
      if (isAd) return;

      const rawTimestamps = watches[videoId] || [];
      let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
      if (this.plugin.settings.statsLateNightEnabled) {
        timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, this.plugin.settings.statsLateNightStart, this.plugin.settings.statsLateNightEnd));
      }
      if (timestamps.length === 0) return;

      const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
      const firstSeen = sortedTimestamps[0];
      const lastSeen = sortedTimestamps[sortedTimestamps.length - 1];

      const diffMs = lastSeen - firstSeen;
      const displayDiffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const ratioDivisor = Math.max(1, displayDiffDays);
      const ratio = timestamps.length / ratioDivisor;

      if (timestamps.length < this.plugin.settings.statsMinWatches) return;
      if (displayDiffDays < this.plugin.settings.statsMinSpan) return;

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

    videoStats.sort((a, b) => {
      if (this.plugin.settings.statsRankingMode === 'ratio') {
        if (b.ratio !== a.ratio) return b.ratio - a.ratio;
        if (b.count !== a.count) return b.count - a.count;
        return b.lastSeen - a.lastSeen;
      } else {
        if (b.count !== a.count) return b.count - a.count;
        return b.lastSeen - a.lastSeen;
      }
    });

    const topX = videoStats.slice(0, limit);
    if (topX.length === 0) {
      listEl.innerHTML = '<li class="empty-stats">No watch data matches filters.</li>';
      return;
    }

    const renderLimit = this.statsPaginateAlways ? Math.min(limit, this.statsPaginatedLimit) : limit;
    const videosToRender = topX.slice(0, renderLimit);

    videosToRender.forEach((video, index) => {
      const li = document.createElement('li');
      li.className = 'stats-item';

      const firstDate = new Date(video.firstSeen);
      const lastDate = new Date(video.lastSeen);
      const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

      let spanStr = video.displayDiffDays === 0 ? 'Watched on a single day' : `Span of ${video.displayDiffDays} days`;
      const msAgo = Date.now() - video.lastSeen;
      const monthsAgo = (msAgo / (1000 * 60 * 60 * 24 * 30.44)).toFixed(1);
      const lastSeenMonthsAgoStr = `Last seen ${monthsAgo} months ago`;

      const url = getEventUrl(video);
      const countBadge = this.plugin.settings.statsRankingMode === 'ratio'
        ? `<span class="stats-watches-count" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border-color: rgba(168, 85, 247, 0.3); font-size: 9px;">Ratio: ${video.ratio.toFixed(2)}/day (${video.count} watches)</span>`
        : `<span class="stats-watches-count">${video.count} watches</span>`;

      let mediaHtml = '';
      if (this.plugin.settings.showThumbnails) {
        if (this.plugin.settings.statsEmbedPlayer) {
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
          <h4 class="stats-title"><a href="${esc(url)}" target="_blank" title="${esc(video.title)}">${esc(video.title)}</a></h4>
          <div class="stats-meta">
            <span class="stats-channel">${esc(video.channel)}</span>
            ${countBadge}
          </div>
          <div class="stats-timeline">
            <span>${firstStr}</span>
            <span>→</span>
            <span>${lastStr}</span>
            <span class="timeline-duration">(${spanStr})</span>
          </div>
          <div class="stats-last-seen" style="font-size: 8.5px; color: var(--color-text-muted); font-weight: 500; margin-top: 1px;">
            • ${lastSeenMonthsAgoStr}
          </div>
        </div>
        <div class="stats-actions" style="margin-left: 8px; flex-shrink: 0; display: flex; gap: 4px;">
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

      const calendarBtn = li.querySelector('.calendar-btn');
      if (calendarBtn) {
        calendarBtn.addEventListener('click', () => {
          this.openVideoCalendarModal(video.videoId, video.title, video.channel);
        });
      }

      const discardBtn = li.querySelector('.discard-ad-btn');
      if (discardBtn) {
        discardBtn.addEventListener('click', () => {
          if (confirm(`Discard this video from Top stats?`)) {
            this.plugin.settings.ignoredVideoIds.push(video.videoId);
            this.plugin.saveSettings().then(() => {
              this.renderTopVideos();
              this.renderShiftAnalysis();
              this.renderPhaseDetector();
              this.renderFormatShiftAnalysis();
              new Notice('Video hidden from stats!');
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
        this.statsPaginatedLimit += 50;
        this.renderTopVideos(false);
      });

      loadMoreLi.appendChild(loadMoreBtn);
      listEl.appendChild(loadMoreLi);
    }
  }

  renderTopAds() {
    const listEl = this.containerEl.querySelector('#top-ads-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const { watches, metadata } = this.watchHistory;
    const adStats = [];

    Object.keys(watches).forEach((videoId) => {
      if (videoId.startsWith('search:')) return;
      
      const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
      const isAd = videoId.startsWith('visit:') || meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
      if (!isAd) return;

      const timestamps = watches[videoId] || [];
      if (timestamps.length === 0) return;
      
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

    adStats.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen - a.lastSeen;
    });

    const top5Ads = adStats.slice(0, 5);
    if (top5Ads.length === 0) {
      listEl.innerHTML = '<li class="empty-stats">No ads records found.</li>';
      return;
    }

    top5Ads.forEach((ad, index) => {
      const li = document.createElement('li');
      li.className = 'stats-item';

      const firstDate = new Date(ad.firstSeen);
      const lastDate = new Date(ad.lastSeen);
      const firstStr = firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const lastStr = lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      
      const diffMs = ad.lastSeen - ad.firstSeen;
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      let spanStr = diffDays === 0 ? 'Served on a single day' : `Active for ${diffDays} days`;

      const msAgo = Date.now() - ad.lastSeen;
      const monthsAgo = (msAgo / (1000 * 60 * 60 * 24 * 30.44)).toFixed(1);
      const lastSeenMonthsAgoStr = `Last seen ${monthsAgo} months ago`;

      const url = getEventUrl(ad);

      let mediaHtml = '';
      const isNormalVideo = !ad.videoId.startsWith('search:') && !ad.videoId.startsWith('visit:');
      if (this.plugin.settings.showThumbnails && isNormalVideo) {
        if (this.plugin.settings.statsEmbedPlayer) {
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
          <h4 class="stats-title"><a href="${esc(url)}" target="_blank" title="${esc(ad.title)}">${esc(ad.title)}</a></h4>
          <div class="stats-meta">
            <span class="stats-channel">${esc(ad.channel)}</span>
            <span class="stats-watches-count" style="color: #ef4444; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2);">${ad.count} impressions</span>
          </div>
          <div class="stats-timeline">
            <span>${firstStr}</span>
            <span>→</span>
            <span>${lastStr}</span>
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

      const deleteBtn = li.querySelector('.delete-ad-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          if (confirm(`Delete ad "${ad.title}"?`)) {
            this.plugin.updateHistory((h) => {
              delete h.watches[ad.videoId];
              delete h.metadata[ad.videoId];
            }).then(() => {
              this.loadHistory();
              new Notice('Ad video removed!');
            }, (e) => new Notice(`Couldn't remove it: ${e.message}`));
          }
        });
      }

      listEl.appendChild(li);
    });
  }

  getMarkdownForDate(targetDate) {
    const targetDateStr = getLocalDateString(targetDate);
    const eventsForDay = this.allLogEvents.filter(event => {
      return getLocalDateString(new Date(event.timestamp)) === targetDateStr;
    });

    if (eventsForDay.length === 0) {
      return `### YouTube Watch Activity - ${targetDateStr}\nNo watch logs recorded for this day.`;
    }

    let md = `### YouTube Watch Activity - ${targetDateStr}\n`;
    const sorted = [...eventsForDay].sort((a, b) => a.timestamp - b.timestamp);
    sorted.forEach(event => {
      const timeStr = new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      if (event.videoId.startsWith('search:')) {
        const query = decodeURIComponent(event.videoId.substring(7));
        md += `- **${timeStr}** | Searched YouTube: *"${query}"*\n`;
      } else if (event.videoId.startsWith('visit:')) {
        md += `- **${timeStr}** | Visited Sponsored Link: [${event.title}](${getEventUrl(event)})\n`;
      } else {
        const durationStr = event.duration ? ` \`[${event.duration}]\`` : '';
        md += `- **${timeStr}** | Watched [${event.title}](https://www.youtube.com/watch?v=${event.videoId}) by *${event.channel}*${durationStr}\n`;
      }
    });

    return md;
  }

  async appendLogToActiveFile(mdText) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No active note open! Open a note file in Obsidian first.');
      return;
    }

    try {
      const currentContent = await this.app.vault.read(activeFile);
      const newContent = currentContent + '\n\n' + mdText + '\n';
      await this.app.vault.modify(activeFile, newContent);
      new Notice(`Appended logs to active note "${activeFile.name}"!`);
    } catch (e) {
      console.error(e);
      new Notice(`Failed to append log: ${e.message}`);
    }
  }

  async exportFullHistory() {
    if (this.allLogEvents.length === 0) {
      new Notice('No watch history logs recorded to export.');
      return;
    }

    // Sort by timestamp oldest first
    const sortedEvents = [...this.allLogEvents].sort((a, b) => a.timestamp - b.timestamp);
    let md = '# YouTube Watch History Logs\n\n';

    let lastDateHeader = '';
    sortedEvents.forEach(event => {
      const date = new Date(event.timestamp);
      const dateHeaderStr = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

      if (dateHeaderStr !== lastDateHeader) {
        lastDateHeader = dateHeaderStr;
        md += `\n## ${dateHeaderStr}\n`;
      }

      if (event.videoId.startsWith('search:')) {
        const query = decodeURIComponent(event.videoId.substring(7));
        md += `- **${timeStr}** | Searched YouTube: *"${query}"*\n`;
      } else if (event.videoId.startsWith('visit:')) {
        md += `- **${timeStr}** | Visited Sponsored Link: [${event.title}](${getEventUrl(event)})\n`;
      } else {
        const durationStr = event.duration ? ` \`[${event.duration}]\`` : '';
        md += `- **${timeStr}** | Watched [${event.title}](https://www.youtube.com/watch?v=${event.videoId}) by *${event.channel}*${durationStr}\n`;
      }
    });

    try {
      const fileName = 'YouTube-Tracker-Export.md';
      const file = this.app.vault.getAbstractFileByPath(fileName);
      if (file) {
        await this.app.vault.modify(file, md);
      } else {
        await this.app.vault.create(fileName, md);
      }
      new Notice(`Exported full history to "${fileName}" inside your vault!`);
    } catch (e) {
      console.error(e);
      new Notice(`Failed to export: ${e.message}`);
    }
  }


  // --- NEW METHODS ---

  getFilteredTopVideoIds() {
    const timeframeSelect = this.containerEl.querySelector('#stats-timeframe-select');
    const timeframeVal = timeframeSelect ? timeframeSelect.value : 'all';
    
    let startTime = 0;
    let endTime = Infinity;
    
    if (timeframeVal === 'custom') {
      const startVal = this.plugin.settings.statsStartDate;
      const endVal = this.plugin.settings.statsEndDate;
      
      if (startVal) startTime = new Date(startVal + 'T00:00:00').getTime();
      if (endVal) endTime = new Date(endVal + 'T23:59:59').getTime();
    } else if (timeframeVal !== 'all') {
      const days = parseInt(timeframeVal) || 30;
      startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    }

    const limitVal = this.plugin.settings.statsLimit || '10';
    const limit = limitVal === '∞' || limitVal.toLowerCase() === 'infinity' ? Infinity : (parseInt(limitVal) || 10);

    const { watches, metadata } = this.watchHistory;
    const videoStats = [];

    Object.keys(watches).forEach((videoId) => {
      if (videoId.startsWith('search:') || videoId.startsWith('visit:')) return;
      if (this.plugin.settings.ignoredVideoIds.includes(videoId)) return;

      const meta = metadata[videoId] || { title: 'Unknown Video', channel: 'Unknown Channel' };
      const isAd = meta.isAd || meta.channel === 'From Google Ads' || meta.channel === 'Google Ads' || meta.title.includes('From Google Ads');
      if (isAd) return;

      const rawTimestamps = watches[videoId] || [];
      let timestamps = rawTimestamps.filter(ts => ts >= startTime && ts <= endTime);
      if (this.plugin.settings.statsLateNightEnabled) {
        timestamps = timestamps.filter(ts => isTimestampInTimeRange(ts, this.plugin.settings.statsLateNightStart, this.plugin.settings.statsLateNightEnd));
      }
      if (timestamps.length === 0) return;

      const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
      const firstSeen = sortedTimestamps[0];
      const lastSeen = sortedTimestamps[sortedTimestamps.length - 1];

      const diffMs = lastSeen - firstSeen;
      const displayDiffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const ratioDivisor = Math.max(1, displayDiffDays);
      const ratio = timestamps.length / ratioDivisor;

      if (timestamps.length < this.plugin.settings.statsMinWatches) return;
      if (displayDiffDays < this.plugin.settings.statsMinSpan) return;

      videoStats.push({
        videoId,
        count: timestamps.length,
        lastSeen,
        ratio
      });
    });

    videoStats.sort((a, b) => {
      if (this.plugin.settings.statsRankingMode === 'ratio') {
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

  matchSearchQuery(title, channel, queryStr) {
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

  openVideoCalendarModal(videoId, title, channel) {
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
    const allWatches = this.watchHistory.watches[videoId] || [];
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
    modal.style.fontFamily = 'var(--font-interface, var(--font-primary, sans-serif))';

    // Build inside HTML
    modal.innerHTML = `
      <div class="yt-tracker-modal-header" style="padding: 16px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); display: flex; justify-content: space-between; align-items: flex-start; background: rgba(255, 255, 255, 0.01);">
        <div class="yt-tracker-modal-title-group" style="display: flex; flex-direction: column; max-width: 320px; text-align: left;">
          <h3 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 700; color: #ffffff; line-height: 1.2;">Watch History Calendar</h3>
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

  renderShiftAnalysis() {
    const container = this.containerEl.querySelector('#shift-analysis-container');
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

    this.allLogEvents.forEach(evt => {
      if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
      if (this.plugin.settings.ignoredVideoIds.includes(evt.videoId)) return;
      
      const dt = new Date(evt.timestamp);
      const day = dt.getDay(); // 0 is Sunday, 6 is Saturday
      const isWeekend = (day === 0 || day === 6);
      
      const dateStr = evt.dateStr;

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
            <span style="font-weight: 700; color: #fff;">${pct}% (	ext{count})</span>
          </div>
          <div style="width: 100%; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.04); overflow: hidden; position: relative;">
            <div style="width: 	ext{pct}%; height: 100%; border-radius: 3px; background: ${color}; transition: width 0.3s ease;"></div>
          </div>
        </div>
      `;
    }
  }

  renderPhaseDetector() {
    const container = this.containerEl.querySelector('#phase-detector-container');
    if (!container) return;

    // Group all watches by channel
    const channelWatches = {};
    this.allLogEvents.forEach(evt => {
      if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
      if (this.plugin.settings.ignoredVideoIds.includes(evt.videoId)) return;

      const channel = evt.channel || 'Unknown Channel';
      if (!channelWatches[channel]) {
        channelWatches[channel] = [];
      }
      channelWatches[channel].push(evt);
    });

    const phaseMinDays = this.plugin.settings.phaseMinDays || 30;
    const phaseMaxDays = this.plugin.settings.phaseMaxDays || 60;
    const phaseMinWatches = this.plugin.settings.phaseMinWatches || 10;

    const detectedPhases = [];
    Object.entries(channelWatches).forEach(([channel, events]) => {
      events.sort((a, b) => a.timestamp - b.timestamp);

      const firstTimestamp = events[0].timestamp;
      const lastTimestamp = events[events.length - 1].timestamp;

      const spanDays = (lastTimestamp - firstTimestamp) / (1000 * 60 * 60 * 24);

      if (spanDays >= phaseMinDays && spanDays <= phaseMaxDays) {
        if (events.length >= phaseMinWatches) {
          const windowWatches = {};
          this.allLogEvents.forEach(evt => {
            if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
            if (this.plugin.settings.ignoredVideoIds.includes(evt.videoId)) return;

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
          const isCurrentlyHighlighted = this.activePhaseHighlight && this.activePhaseHighlight.channel === phase.channel && this.activePhaseHighlight.startTimestamp === phase.startTimestamp;
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

    const buttons = container.querySelectorAll('.btn-phase-toggle');
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const channel = decodeURIComponent(e.target.getAttribute('data-channel'));
        const startTimestamp = parseInt(e.target.getAttribute('data-start'));
        const endTimestamp = parseInt(e.target.getAttribute('data-end'));

        const isCurrentlyHighlighted = this.activePhaseHighlight && this.activePhaseHighlight.channel === channel && this.activePhaseHighlight.startTimestamp === startTimestamp;

        if (isCurrentlyHighlighted) {
          this.activePhaseHighlight = null;
        } else {
          this.activePhaseHighlight = { channel, startTimestamp, endTimestamp };
          const phaseYear = new Date(startTimestamp).getFullYear();
          this.currentSelectedYear = phaseYear;
          const yearSelect = this.containerEl.querySelector('#yt-calendar-year-select');
          if (yearSelect) {
            yearSelect.value = String(phaseYear);
          }
        }

        this.renderPhaseDetector();
        this.renderHeatmap(this.currentSelectedYear);
        this.renderYearSelectorRow();
      });
    });
  }

  renderFormatShiftAnalysis() {
    const container = this.containerEl.querySelector('#format-shift-container');
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

    const totalVideoWatches = this.allLogEvents.filter(evt => {
      if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return false;
      if (this.plugin.settings.ignoredVideoIds.includes(evt.videoId)) return false;
      return true;
    });
    
    const totalWatchesWithDuration = totalVideoWatches.filter(evt => {
      const sec = parseDurationToSeconds(evt.duration);
      return sec > 0;
    }).length;
    
    const isDurationDataMissing = (totalVideoWatches.length > 0 && totalWatchesWithDuration === 0);

    const yearDurations = {};
    const yearCounts = {};

    this.allLogEvents.forEach(evt => {
      if (evt.videoId.startsWith('search:') || evt.videoId.startsWith('visit:')) return;
      if (this.plugin.settings.ignoredVideoIds.includes(evt.videoId)) return;

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
          value: avg / 60,
          label: formatDurationShort(avg),
          avgSeconds: avg
        };
      }
    });

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

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${topMargin + plotHeight} L ${points[0].x} ${topMargin + plotHeight} Z`;

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
        
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); font-weight: 600;">
            ${isDurationDataMissing ? 'Watch Volume Trend' : 'Attention Span Trend'}
          </div>
          <span class="badge ${trendClass}" style="font-size: 9px; padding: 2px 6px; border-radius: 4px;">${trendText}</span>
        </div>

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
            
            <path d="${areaPath}" fill="url(#trend-area-grad)" />
            <path d="${linePath}" fill="none" stroke="url(#trend-line-grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            
            ${points.map(p => `
              <circle cx="${p.x}" cy="${p.y}" r="4" fill="#fbbf24" stroke="rgba(251, 191, 36, 0.25)" stroke-width="3" style="transition: r 0.2s;" />
              <text x="${p.x}" y="${p.y - 8}" fill="#fff" font-size="8" font-weight="700" text-anchor="middle">	ext{p.data.label}</text>
              <text x="${p.x}" y="${svgHeight - 4}" fill="var(--color-text-muted)" font-size="8" font-weight="500" text-anchor="middle">${p.data.year}</text>
            `).join('')}
          </svg>
        </div>

        <div style="font-size: 10px; color: var(--color-text-secondary); line-height: 1.45; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 8px;">
          ${trendExplanation}
        </div>
        ${footnoteHTML}
      </div>
    `;
  }

  handleFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const statusEl = this.containerEl.querySelector('#import-status');
    statusEl.textContent = 'Reading file...';
    statusEl.className = 'import-status-text';
    statusEl.classList.remove('hidden');

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        statusEl.textContent = 'Parsing JSON...';
        const rawHistory = JSON.parse(evt.target.result);
        
        statusEl.textContent = 'Filtering events...';
        let parsedEvents;
        if (rawHistory && !Array.isArray(rawHistory) && rawHistory.watches && rawHistory.metadata) {
          // The extension's own export.
          parsedEvents = [];
          Object.keys(rawHistory.watches).forEach((videoId) => {
            const m = rawHistory.metadata[videoId] || {};
            const approx = new Set(m.approx || []);
            (rawHistory.watches[videoId] || []).forEach((timestamp) => parsedEvents.push({ videoId, timestamp, title: m.title, channel: m.channel, duration: m.duration, isAd: m.isAd, isShort: m.isShort, approx: approx.has(timestamp) }));
          });
        } else {
          parsedEvents = YTCore.eventsFromTakeout(rawHistory);
        }

        if (parsedEvents.length === 0) {
          throw new Error('No valid YouTube watch logs found in this file.');
        }

        statusEl.textContent = `Merging ${parsedEvents.length.toLocaleString()} history records...`;
        let addedCount = 0;
        await this.plugin.updateHistory((h) => {
          addedCount = YTCore.mergeEvents(h, parsedEvents).added;
        });
        statusEl.textContent = `Successfully merged ${addedCount.toLocaleString()} new watch events!`;
        statusEl.className = 'import-status-text success-import';
        this.loadHistory();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className = 'import-status-text error-import';
        console.error('[YtTracker] Import error:', err);
      }
    };

    reader.onerror = () => {
      statusEl.textContent = 'Failed to read history file.';
      statusEl.className = 'import-status-text error-import';
    };

    reader.readAsText(file);
  }
}

class YtTrackerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_YT_TRACKER,
      (leaf) => new YtTrackerView(leaf, this)
    );

    this.addRibbonIcon('play', 'YouTube Tracker Dashboard', () => {
      this.activateView();
    });

    this.addSettingTab(new YtTrackerSettingTab(this.app, this));

    // Start local sync server if running on desktop and enabled
    if (Platform.isDesktop && this.settings.enableLocalServer) {
      this.startLocalServer();
    }
  }

  onunload() {
    this.stopLocalServer();
  }

  startLocalServer() {
    try {
      const http = require('http');
      this.localServer = http.createServer(async (req, res) => {
        // Only the Chrome extension (and Obsidian itself) may talk to this server. Any web page
        // could otherwise post to 127.0.0.1 and overwrite the history (browsers send an Origin).
        const origin = req.headers.origin || '';
        const allowed = !origin || origin.startsWith('chrome-extension://') || origin === 'app://obsidian.md';
        if (!allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Forbidden origin' }));
          return;
        }
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          let tooBig = false;
          req.on('data', chunk => {
            body += chunk;
            if (body.length > 200 * 1024 * 1024) {
              tooBig = true;
              req.destroy();
            }
          });
          req.on('end', async () => {
            if (tooBig) return;
            const answer = (code, obj) => {
              res.writeHead(code, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(obj));
            };
            try {
              const payload = JSON.parse(body);
              if (req.url === '/watch' && payload && payload.videoId && typeof payload.timestamp === 'number') {
                const { videoId, title, channel, duration, timestamp, isAd, isShort } = payload;
                let added = 0;
                await this.updateHistory((h) => {
                  added = YTCore.mergeEvents(h, [{ videoId, title, channel, duration, timestamp, isAd, isShort }]).added;
                });
                this.refreshActiveViews();
                return answer(200, { success: true, added });
              }
              if (req.url === '/sync' && payload && payload.watches && payload.metadata) {
                const events = [];
                Object.keys(payload.watches).forEach((videoId) => {
                  const m = payload.metadata[videoId] || {};
                  const approx = new Set(m.approx || []);
                  (payload.watches[videoId] || []).forEach((timestamp) => events.push({ videoId, timestamp, title: m.title, channel: m.channel, duration: m.duration, isAd: m.isAd, isShort: m.isShort, approx: approx.has(timestamp) }));
                });
                let added = 0;
                await this.updateHistory((h) => {
                  added = YTCore.mergeEvents(h, events).added;
                });
                this.refreshActiveViews();
                return answer(200, { success: true, added });
              }
              answer(400, { success: false, error: 'Invalid payload' });
            } catch (err) {
              answer(500, { success: false, error: err.message });
            }
          });
          return;
        }

        if (req.method === 'GET' && req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'running', plugin: 'youtube-watch-tracker' }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.localServer.listen(this.settings.localServerPort, '127.0.0.1', () => {
        console.log(`[YtTracker] Local sync server started on port ${this.settings.localServerPort}`);
      });

      this.localServer.on('error', (err) => {
        console.error('[YtTracker] Local sync server error:', err);
        new Notice(`YouTube Tracker sync server failed to start on port ${this.settings.localServerPort}. Port might be in use.`);
      });
    } catch (err) {
      console.error('[YtTracker] Error starting server:', err);
    }
  }

  stopLocalServer() {
    if (this.localServer) {
      this.localServer.close();
      this.localServer = null;
      console.log('[YtTracker] Local sync server stopped');
    }
  }

  refreshActiveViews() {
    const { workspace } = this.app;
    workspace.getLeavesOfType(VIEW_TYPE_YT_TRACKER).forEach(leaf => {
      if (leaf.view instanceof YtTrackerView) {
        leaf.view.loadHistory();
      }
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_YT_TRACKER)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_YT_TRACKER, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadHistoryData() {
    const { vault } = this.app;
    const path = this.settings.historyFilePath;
    try {
      const file = vault.getAbstractFileByPath(path);
      if (file) {
        const content = await vault.read(file);
        return JSON.parse(content);
      }
    } catch (e) {
      console.error('Error loading history file:', e);
      // Saving over a file we couldn't read would wipe it.
      throw new Error(`Couldn't read ${path}: ${e.message}`);
    }
    return { watches: {}, metadata: {} };
  }

  async saveHistoryData(data) {
    const { vault } = this.app;
    const path = this.settings.historyFilePath;
    const file = vault.getAbstractFileByPath(path);
    if (file) {
      await vault.modify(file, JSON.stringify(data, null, 2));
    } else {
      await vault.create(path, JSON.stringify(data, null, 2));
    }
    return true;
  }

  /**
   * Reads the history, lets `change` edit it, and saves it, one change at a time (the sync server
   * and the dashboard both write; without this a late write lost an earlier one).
   */
  updateHistory(change) {
    const run = (this._chain || Promise.resolve()).then(async () => {
      const history = await this.loadHistoryData();
      history.watches = history.watches || {};
      history.metadata = history.metadata || {};
      await change(history);
      await this.saveHistoryData(history);
      return history;
    });
    this._chain = run.catch(() => undefined);
    return run;
  }

  /** A copy of the history next to it ("<file>.backup.json"). */
  async writeBackup(data) {
    const path = this.settings.historyFilePath.replace(/\.json$/i, '') + '.backup.json';
    const { vault } = this.app;
    const text = JSON.stringify(data);
    const file = vault.getAbstractFileByPath(path);
    if (file) await vault.modify(file, text);
    else await vault.create(path, text);
  }
}

class YtTrackerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'YouTube Watch Tracker Settings' });

    new Setting(containerEl)
      .setName('History File Path')
      .setDesc('Vault relative path to store the YouTube watch history database (JSON format).')
      .addText(text => text
        .setPlaceholder('yt-history.json')
        .setValue(this.plugin.settings.historyFilePath)
        .onChange(async (value) => {
          this.plugin.settings.historyFilePath = value || 'yt-history.json';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable Local Sync Server')
      .setDesc('Run a local HTTP server inside Obsidian on your Mac to automatically receive sync data from the Chrome extension in real-time.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableLocalServer)
        .onChange(async (value) => {
          this.plugin.settings.enableLocalServer = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.startLocalServer();
          } else {
            this.plugin.stopLocalServer();
          }
        }));

    new Setting(containerEl)
      .setName('Local Server Port')
      .setDesc('Port for the local HTTP server to listen on (default is 12314). Make sure it matches the port setting in your Chrome extension.')
      .addText(text => text
        .setPlaceholder('12314')
        .setValue(String(this.plugin.settings.localServerPort))
        .onChange(async (value) => {
          const port = parseInt(value);
          if (!isNaN(port) && port > 0 && port < 65536) {
            this.plugin.settings.localServerPort = port;
            await this.plugin.saveSettings();
            // Restart server with new port if enabled
            if (this.plugin.settings.enableLocalServer) {
              this.plugin.stopLocalServer();
              this.plugin.startLocalServer();
            }
          }
        }));
  }
}

module.exports = YtTrackerPlugin;
