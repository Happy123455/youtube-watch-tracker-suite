// The daily job end to end, with a fake Chrome (storage, history, cookies, alarms) and a fake
// network (YouTube's history page and API, Gemini, the journal's MCP server).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const at = (y, m, d, h = 12, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms).getTime();
const NOW = at(2026, 11, 14, 20, 0); // Saturday 14 Nov 2026, 20:00

let store;
let visits;
let calls;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store[k] = clone(v);
      },
      async remove(k) {
        delete store[k];
      },
    },
  },
  history: {
    async search({ startTime, endTime }) {
      const urls = [...new Set(visits.filter((v) => v.time >= startTime && v.time < endTime).map((v) => v.url))];
      return urls.map((url) => ({ url, title: visits.find((v) => v.url === url).title }));
    },
    async getVisits({ url }) {
      return visits.filter((v) => v.url === url).map((v) => ({ visitTime: v.time }));
    },
  },
  cookies: { async get({ name }) { return name === 'SAPISID' ? { value: 'cookie' } : null; } },
  alarms: { async create() {}, async clear() {}, async get() { return null; } },
};

const { runDailySync, saveSettings } = await import('../chrome-extension/utils/daily.js');
const { pushDigestToJournal } = await import('../chrome-extension/utils/journal.js');
const { getHistory, getLabels } = await import('../chrome-extension/utils/storage.js');

const textRuns = (t) => ({ runs: [{ text: t }] });
const section = (title, contents) => ({ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: textRuns(title) } }, contents } });
const video = (id, title, channel) => ({ videoRenderer: { videoId: id, title: textRuns(title), ownerText: textRuns(channel) } });
const shortVm = (id, title) => ({ shortsLockupViewModel: { entityId: `shorts-shelf-item-${id}`, overlayMetadata: { primaryText: { content: title } }, onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } } } });

const firstPage = {
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    section('Today', [video('lecture0001', 'Linear algebra lecture', 'MIT'), { reelShelfRenderer: { title: textRuns('Shorts'), items: [shortVm('phoneshort1', 'Funny cat')] } }]),
    section('Yesterday', [video('phonevideo1', 'Cricket highlights', 'ICC')]),
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT' } } } },
  ] } } } }] } },
};
const nextPage = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
  section('Thursday', [video('oldvideo001', 'Too old', 'X')]),
] } }] };
const historyHtml = `<script>ytcfg.set({"LOGGED_IN":true,"INNERTUBE_CLIENT_VERSION":"2.2026"});</script><script>var ytInitialData = ${JSON.stringify(firstPage)};</script>`;

const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), body: opts.body });
  if (String(url).startsWith('https://www.youtube.com/feed/history')) return Promise.resolve({ ok: true, status: 200, text: async () => historyHtml });
  if (String(url).startsWith('https://www.youtube.com/youtubei/v1/browse')) {
    assert.match(opts.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    return Promise.resolve(json(200, nextPage));
  }
  if (String(url).includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    let answer;
    if (body.systemInstruction.parts[0].text.startsWith('You label')) {
      answer = { items: prompt.split('\n').map((line) => {
        const i = Number(line.split('.')[0]);
        const useful = /lecture/i.test(line);
        return { i, category: useful ? 'useful' : 'entertainment', topics: [useful ? 'linear algebra' : 'fun'], why: 'test' };
      }) };
    } else {
      answer = { summary: 'You are into linear algebra.', focus: ['linear algebra'] };
    }
    return Promise.resolve(json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
}

beforeEach(async () => {
  store = {};
  calls = [];
  visits = [
    // Watched on this Mac at 18:00 (also in the account history as "Today").
    { url: 'https://www.youtube.com/watch?v=lecture0001', title: 'Linear algebra lecture - YouTube', time: at(2026, 11, 14, 18, 0, 5, 123) },
  ];
  globalThis.fetch = fakeFetch;
  await saveSettings({ geminiKey: 'test-key' });
});

test('daily sync: Chrome first, the account for other devices, no duplicates, labels and a digest', async () => {
  const entry = await runDailySync({ reason: 'daily', now: NOW });
  assert.deepEqual(entry.errors, []);
  // First run: yesterday and today.
  assert.deepEqual(entry.days, ['2026-11-13', '2026-11-14']);
  assert.equal(entry.chrome.watches, 1);
  assert.equal(entry.account.pages, 2);
  assert.equal(entry.added, 3); // lecture (exact), the phone's Short and video; Thursday is before the run.
  assert.equal((await getHistory()).watches.oldvideo001, undefined);

  const h = await getHistory();
  // The lecture counts once, at Chrome's exact time; the account's guess for it was dropped.
  assert.deepEqual(h.watches.lecture0001, [at(2026, 11, 14, 18, 0, 5, 123)]);
  assert.equal(h.metadata.lecture0001.approx, undefined);
  assert.equal(h.watches.phoneshort1.length, 1);
  assert.equal(h.metadata.phoneshort1.isShort, true);
  assert.deepEqual(h.metadata.phoneshort1.approx, h.watches.phoneshort1);
  assert.equal(new Date(h.watches.phonevideo1[0]).getDate(), 13);

  const labels = await getLabels();
  assert.equal(labels.lecture0001.category, 'useful');
  assert.equal(labels.phoneshort1.category, 'entertainment');

  const d = store.digests['2026-11-14'];
  assert.equal(d.watches, 2);
  assert.equal(d.useful, 1);
  assert.equal(d.distraction, 1);
  assert.equal(d.shorts, 1);
  assert.equal(d.note.summary, 'You are into linear algebra.');
  assert.equal(store.lastRunDay, '2026-11-14');
  assert.equal(store.lastCompleteDay, '2026-11-13');
  assert.equal(store.syncLog.length, 1);

  // Running again (the next catch-up, a second click) adds nothing and labels nothing again.
  calls = [];
  const again = await runDailySync({ reason: 'manual', now: NOW + 60_000 });
  assert.equal(again.added, 0);
  assert.equal(again.labelled, 0);
  assert.deepEqual((await getHistory()).watches, h.watches);
  assert.ok(!calls.some((c) => c.url.includes('generativelanguage') && c.body.includes('You label')));
  // The second run starts after the last day that had ended.
  assert.deepEqual(again.days, ['2026-11-14']);
});

test('daily sync: signed out of YouTube still logs Chrome history and says why the account failed', async () => {
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('https://www.youtube.com/feed/history')
      ? Promise.resolve({ ok: true, status: 200, text: async () => '<script>ytcfg.set({"LOGGED_IN":false});</script>' })
      : fakeFetch(url, opts);
  const entry = await runDailySync({ reason: 'daily', now: NOW });
  assert.equal(entry.added, 1);
  assert.match(entry.account.error, /Not signed in/);
  assert.equal(store.lastRunDay, '2026-11-14');
});

test('daily sync: one run at a time', async () => {
  const [a, b] = [runDailySync({ now: NOW }), runDailySync({ now: NOW })];
  assert.equal(a, b);
  await a;
});

test('journal: each changed digest is sent once as youtube_day', async () => {
  await runDailySync({ reason: 'daily', now: NOW });
  const sent = [];
  const journalFetch = async (url, opts) => {
    assert.equal(url, 'http://127.0.0.1:39477/mcp');
    const msg = JSON.parse(opts.body);
    if (msg.method === 'notifications/initialized') return { ok: true, status: 202 };
    if (msg.method === 'tools/call') sent.push(msg.params.arguments);
    return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  };
  const r = await pushDigestToJournal({ fetchImpl: journalFetch, now: NOW });
  assert.equal(r.sent, 2);
  const today = JSON.parse(sent.find((s) => s.date === '2026-11-14').data);
  assert.equal(today.useful, 1);
  assert.deepEqual(today.usefulVideos.map((v) => v.id), ['lecture0001']);
  assert.equal(today.note, 'You are into linear algebra.');
  // Nothing changed since: nothing to send.
  assert.equal((await pushDigestToJournal({ fetchImpl: journalFetch, now: NOW })).sent, 0);
  // The journal closed: the error is kept for the popup and the next run tries again.
  store.digests['2026-11-14'].at = NOW + 1;
  const off = await pushDigestToJournal({ fetchImpl: () => Promise.reject(new Error('connection refused')), now: NOW });
  assert.match(off.error, /connection refused/);
  assert.equal(store.journalPush.error, 'connection refused');
});
