// utils/journal.js
// Hands each day's digest to Dynamic Journal on this Mac (its MCP server, Settings → AI → MCP
// server), where it shows in that day's preview snippet and syncs to the phone. Optional: when the
// journal isn't open or its server is off, nothing happens and the next run tries again.
import './yt-core.js';
import { getHistory, getLabels } from './storage.js';
import { getSettings } from './daily.js';

const C = globalThis.YTCore;
export const JOURNAL_MCP = 'http://127.0.0.1:39477/mcp';

export async function rpc(body, fetchImpl) {
  const res = await fetchImpl(JOURNAL_MCP, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  });
  if (res.status === 202) return null;
  if (!res.ok) throw new Error(`Journal answered ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Journal error');
  return json.result;
}

/** What one day looks like in the journal: numbers, top topics, the useful videos, the AI note. */
export function journalDay(digest, history, labels) {
  const { start, end } = C.dayBounds(digest.day);
  const useful = [];
  for (const id of Object.keys(history.watches || {})) {
    const l = labels[id];
    if (!l || l.category !== 'useful') continue;
    if (!history.watches[id].some((t) => t >= start && t < end)) continue;
    const m = history.metadata[id] || {};
    useful.push({ id, title: String(m.title || '').slice(0, 120), channel: String(m.channel || '').slice(0, 60) });
  }
  const topics = Object.entries(digest.topics || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => ({ t, n }));
  return {
    v: 1,
    day: digest.day,
    watches: digest.watches,
    useful: digest.useful,
    distraction: digest.distraction,
    unlabelled: digest.unlabelled,
    shorts: digest.shorts,
    topics,
    usefulVideos: useful.slice(0, 8),
    note: digest.note ? digest.note.summary : '',
    focus: digest.note ? digest.note.focus : [],
    rising: ((digest.shift && digest.shift.rising) || []).map((r) => r.topic).slice(0, 4),
  };
}

/** Sends digests that changed since they were last sent (the last week only). */
export async function pushDigestToJournal({ fetchImpl = fetch, now = Date.now() } = {}) {
  const settings = await getSettings();
  if (!settings.journalDigest) return { sent: 0, skipped: 'off' };
  const { digests = {}, journalPush = {} } = await chrome.storage.local.get(['digests', 'journalPush']);
  const since = C.addDays(C.localDay(now), -7);
  const due = Object.keys(digests).filter((d) => d >= since && (journalPush.sent || {})[d] !== digests[d].at).sort();
  if (!due.length) return { sent: 0 };
  const history = await getHistory();
  const labels = await getLabels();
  const sent = { ...(journalPush.sent || {}) };
  try {
    await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'YouTube tracker', version: '2.0' } } }, fetchImpl);
    await rpc({ method: 'notifications/initialized' }, fetchImpl);
    let id = 2;
    for (const d of due) {
      const result = await rpc({ id: id++, method: 'tools/call', params: { name: 'youtube_day', arguments: { date: d, data: JSON.stringify(journalDay(digests[d], history, labels)) } } }, fetchImpl);
      if (result && result.isError) throw new Error((result.content && result.content[0] && result.content[0].text) || 'Journal refused it');
      sent[d] = digests[d].at;
    }
    await chrome.storage.local.set({ journalPush: { sent, at: now, error: null } });
    return { sent: due.length };
  } catch (e) {
    await chrome.storage.local.set({ journalPush: { sent, at: now, error: String(e.message || e) } });
    return { sent: 0, error: String(e.message || e) };
  }
}
