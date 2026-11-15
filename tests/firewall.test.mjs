// 🧯 The rhetoric firewall: the pure core, and the service-worker part with a fake Chrome and a fake
// network (Gemini watching the video, YouTube's oEmbed, the journal's MCP server).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import '../chrome-extension/utils/fw-core.js';

const F = globalThis.FWCore;
let store;
let calls;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
globalThis.chrome = {
  storage: { local: {
    async get(keys) { const out = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = clone(store[k]); return out; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); },
  } },
  runtime: { getPlatformInfo() {} },
};
const { checkVideo, setConviction, getChecks } = await import('../chrome-extension/utils/firewall.js');

const CHECK = {
  speaker: 'Jensen Huang', topic: 'Chips to China',
  claims: [
    { n: 1, t: '0:00', quote: 'any compute means we lose everything', claim: 'Critic is absurd', premise: 'If any compute goes to China, the US loses everything', basis: 'emotion', fallacies: ['strawman'], contradicts: [], incentive: 'Market access', plain: 'Answers a view nobody stated.', heat: 80 },
    { n: 2, t: '1:30', quote: 'China builds it anyway', claim: 'Controls change nothing', premise: 'If China builds it without Nvidia, sales do not matter', basis: 'assertion', fallacies: ['doublethink'], contradicts: [1, 9], incentive: '', plain: 'Clashes with #1.', heat: 50 },
  ],
  contradictions: [], past: [], heat: 65, verdict: 'Confidence over logic.', steelman: 'Controls may speed up rivals.', holds: ['Rivals get a protected market.'], ask: ['Why buy Nvidia then?'],
};
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
let gemini = (body) => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CHECK) }] } }] });
function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), body: opts.body && JSON.parse(opts.body) });
  if (String(url).includes('generativelanguage')) return Promise.resolve(gemini(JSON.parse(opts.body), String(url)));
  if (String(url).includes('/oembed')) return Promise.resolve(json(200, { title: 'Jensen Huang gets heated', author_name: 'Podcast' }));
  if (String(url).includes('127.0.0.1:39477')) {
    const b = JSON.parse(opts.body);
    return Promise.resolve(b.method === 'notifications/initialized' ? { ok: true, status: 202 } : json(200, { jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
  }
  return Promise.reject(new Error(`unexpected ${url}`));
}

beforeEach(() => {
  store = { dailySettings: { geminiKey: 'k', journalDigest: true } };
  calls = [];
  gemini = () => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CHECK) }] } }] });
});

test('core: names fallacies, numbers claims, keeps contradictions pointing back', () => {
  assert.equal(F.fallacyName('strawman'), 'Straw man');
  assert.equal(F.fallacyName('Ad-hominem attack'), 'Ad hominem');
  const c = F.normalizeCheck(CHECK);
  assert.deepEqual(c.claims[1].contradicts, [1]);
  assert.deepEqual(c.claims[1].fallacies, ['Conflicting conditions']);
  assert.deepEqual(c.contradictions, [{ a: 1, b: 2, why: '' }]);
  assert.deepEqual(F.tally(c), { claims: 2, tricks: 2, contradictions: 1, bare: 2, top: [['Straw man', 1], ['Conflicting conditions', 1]] });
  assert.equal(F.seconds('1:30'), 90);
  assert.equal(F.knownSpeaker([{ speaker: 'Jensen Huang' }], 'Huang on chips'), 'Jensen Huang');
});

test('Gemini watches the video; the check is kept and sent to the journal', async () => {
  const rec = await checkVideo({ videoId: 'rvs8Nljqmvw', title: '', before: 8 }, { fetchImpl: fakeFetch });
  assert.equal(rec.speaker, 'Jensen Huang');
  assert.equal(rec.title, 'Jensen Huang gets heated');
  assert.equal(rec.before, 8);
  const g = calls.find((c) => c.url.includes('generativelanguage'));
  assert.match(g.url, /gemini-3\.1-pro-preview/);
  assert.deepEqual(g.body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=rvs8Nljqmvw' } });
  assert.equal(g.body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  await new Promise((r) => setTimeout(r, 10));
  const mcp = calls.filter((c) => c.url.includes('39477')).map((c) => c.body);
  assert.equal(mcp[2].params.name, 'firewall_check');
  assert.equal(JSON.parse(mcp[2].params.arguments.data).videoId, 'rvs8Nljqmvw');
  // Opening it again costs nothing.
  const n = calls.length;
  await checkVideo({ videoId: 'rvs8Nljqmvw' }, { fetchImpl: fakeFetch });
  assert.equal(calls.length, n);
  const after = await setConviction('rvs8Nljqmvw', { after: 3, before: 99 }, { fetchImpl: fakeFetch });
  assert.equal(after.after, 3);
  assert.equal(after.before, 8);
});

test('busy models fall back; a video Gemini cannot watch stops at once; no key asks for one', async () => {
  gemini = (body, url) => (url.includes('pro') ? json(503, { error: { message: 'busy' } }) : json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(CHECK) }] } }] }));
  const rec = await checkVideo({ videoId: 'abcdefghijk', title: 't' }, { fetchImpl: fakeFetch });
  assert.equal(rec.model, 'gemini-3.8-flash');
  gemini = () => json(400, { error: { message: 'Video is private' } });
  await assert.rejects(checkVideo({ videoId: 'privatevid1', title: 't' }, { fetchImpl: fakeFetch }), /couldn't watch this video: Video is private/);
  assert.equal(calls.filter((c) => c.url.includes('privatevid1') || (c.body && JSON.stringify(c.body).includes('privatevid1'))).length, 1);
  store.dailySettings.geminiKey = '';
  await assert.rejects(checkVideo({ videoId: 'nokeyvideo1', title: 't' }, { fetchImpl: fakeFetch }), /Gemini key/);
  assert.equal(Object.keys(await getChecks()).length, 1);
});

test('the speaker\'s earlier claims go into the next check', async () => {
  await checkVideo({ videoId: 'firstvideo1', title: 'Jensen Huang keynote' }, { fetchImpl: fakeFetch });
  calls = [];
  await checkVideo({ videoId: 'secondvid01', title: 'Huang interview' }, { fetchImpl: fakeFetch });
  const g = calls.find((c) => c.url.includes('generativelanguage'));
  assert.match(g.body.contents[0].parts[1].text, /claimed in earlier checks/);
  assert.match(g.body.contents[0].parts[1].text, /US loses everything/);
});
