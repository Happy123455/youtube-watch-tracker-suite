// utils/firewall.js
// 🧯 Rhetoric firewall in the service worker: Gemini watches a YouTube video itself (no
// transcript needed) and takes its arguments apart (rules and prompt in fw-core.js, the same as
// Dynamic Journal's). One check per video is kept (opening it again costs nothing); each check also
// goes to the journal on this Mac when it's open, so both share one history and speaker memory.
import './fw-core.js';
import { getSettings } from './daily.js';
import { rpc } from './journal.js';

const F = globalThis.FWCore;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Pro first (the logic is the point); faster models when it's busy. */
export const FW_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-flash-latest'];
export const KEEP = 150;

export async function getChecks() {
  const { firewall = {} } = await chrome.storage.local.get('firewall');
  return firewall.checks || {};
}

let writing = Promise.resolve();
/** Changes the stored checks one write at a time (`change` gets and returns the {videoId: check} map). */
function updateChecks(change) {
  const next = writing.catch(() => {}).then(async () => {
    const checks = change(await getChecks()) || {};
    const ids = Object.keys(checks).sort((a, b) => String(checks[b].at).localeCompare(String(checks[a].at)));
    const kept = Object.fromEntries(ids.slice(0, KEEP).map((id) => [id, checks[id]]));
    await chrome.storage.local.set({ firewall: { checks: kept } });
    return kept;
  });
  writing = next;
  return next;
}

/** One Gemini call on a video, with the fallbacks. */
export async function watchAndAudit({ key, videoId, prompt, fetchImpl = fetch, models = FW_MODELS, timeoutMs = 240000 }) {
  if (!key) throw new Error('Add a Gemini key in ⚙ settings first (the firewall needs Gemini to watch the video).');
  let last = null;
  for (const model of models) {
    let res;
    try {
      res = await fetchImpl(`${GEMINI}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: F.SYSTEM }] },
          contents: [{ role: 'user', parts: [{ fileData: { fileUri: F.watchUrl(videoId) } }, { text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: F.SCHEMA, maxOutputTokens: 20000, mediaResolution: 'MEDIA_RESOLUTION_LOW' },
        }),
      });
    } catch (e) {
      last = new Error(`Gemini (${model}) didn't answer: ${e.message}`);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(body)) throw new Error('Gemini refused the API key.');
      const msg = (() => {
        try {
          return JSON.parse(body).error.message;
        } catch (e) {
          return '';
        }
      })();
      // A private, age-restricted or too-long video won't work on another model either.
      if (res.status === 400) throw new Error(`Gemini couldn't watch this video${msg ? `: ${msg}` : ''}.`);
      last = new Error(`Gemini ${res.status} on ${model}${msg ? `: ${msg}` : ''}`);
      continue;
    }
    const body = await res.json();
    const cand = (body.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
    try {
      return { json: JSON.parse(text), model };
    } catch (e) {
      last = new Error(`Unreadable answer from ${model}${cand.finishReason ? ` (${cand.finishReason})` : ''}`);
    }
  }
  throw last || new Error('No model answered.');
}

/** Keeps the service worker awake through a long call (an extension API call every 20 s). */
function keepAwake() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(t);
}

const running = new Map();

/** 🧯 Checks a video (or returns the kept check unless `force`). */
export function checkVideo({ videoId, title: title0 = '', channel: channel0 = '', speaker = '', before, force = false }, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!/^[\w-]{6,20}$/.test(String(videoId || ''))) return Promise.reject(new Error('Not a YouTube video.'));
  if (running.has(videoId)) return running.get(videoId);
  let title = title0;
  let channel = channel0;
  const job = (async () => {
    const checks = await getChecks();
    if (checks[videoId] && !force) return checks[videoId];
    const settings = await getSettings();
    if (!title) {
      // From the popup's link box: the title and channel from YouTube's oEmbed (a hint for the speaker).
      try {
        const o = await (await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(F.watchUrl(videoId))}`, { signal: AbortSignal.timeout(8000) })).json();
        title = String(o.title || '');
        channel = channel || String(o.author_name || '');
      } catch (e) {
        // Just no hint.
      }
    }
    const all = Object.values(checks);
    const who = String(speaker || '').trim() || F.knownSpeaker(all, `${title} ${channel}`);
    const prior = F.priorPremises(all.filter((c) => c.videoId !== videoId), who);
    const stop = keepAwake();
    let got;
    try {
      got = await watchAndAudit({ key: settings.geminiKey, videoId, prompt: F.request({ title, channel, speaker: who, prior }), fetchImpl });
    } finally {
      stop();
    }
    const c = F.normalizeCheck(got.json);
    if (!c.claims.length) throw new Error(c.verdict || 'No arguments found to check in this video.');
    const keepBefore = typeof before === 'number' ? before : checks[videoId] && checks[videoId].before;
    const rec = {
      videoId,
      title: String(title).slice(0, 200),
      channel: String(channel).slice(0, 80),
      at: new Date(now()).toISOString(),
      by: 'Gemini',
      model: got.model,
      ...c,
      speaker: c.speaker || who,
      ...(typeof keepBefore === 'number' ? { before: keepBefore } : {}),
    };
    await updateChecks((all2) => ({ ...all2, [videoId]: rec }));
    sendToJournal(rec, fetchImpl).catch(() => {});
    return rec;
  })().finally(() => running.delete(videoId));
  running.set(videoId, job);
  return job;
}

export const checking = (videoId) => running.has(videoId);

/** How convinced Hapi was before / is after (0–10). */
export async function setConviction(videoId, patch, { fetchImpl = fetch } = {}) {
  const out = {};
  for (const k of ['before', 'after']) if (typeof patch[k] === 'number' && patch[k] >= 0 && patch[k] <= 10) out[k] = Math.round(patch[k]);
  const all = await updateChecks((checks) => (checks[videoId] ? { ...checks, [videoId]: { ...checks[videoId], ...out } } : checks));
  const rec = all[videoId] || null;
  if (rec && 'after' in out) sendToJournal(rec, fetchImpl).catch(() => {});
  return rec;
}

export async function deleteCheck(videoId) {
  await updateChecks((checks) => {
    const next = { ...checks };
    delete next[videoId];
    return next;
  });
}

/** To the journal's 🧯 history (its MCP server, when the journal is open on this Mac and the setting is on). */
export async function sendToJournal(rec, fetchImpl = fetch) {
  const settings = await getSettings();
  if (!settings.journalDigest) return false;
  await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'YouTube tracker', version: '2.1' } } }, fetchImpl);
  await rpc({ method: 'notifications/initialized' }, fetchImpl);
  const result = await rpc({ id: 2, method: 'tools/call', params: { name: 'firewall_check', arguments: { data: JSON.stringify(rec) } } }, fetchImpl);
  if (result && result.isError) throw new Error((result.content && result.content[0] && result.content[0].text) || 'Journal refused it');
  return true;
}
