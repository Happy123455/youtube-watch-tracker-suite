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
