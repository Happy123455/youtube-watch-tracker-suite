import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../chrome-extension/utils/yt-core.js';

const C = globalThis.YTCore;
const at = (y, m, d, h = 12, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms).getTime();
const NOW = at(2026, 11, 14, 20, 0); // Saturday 14 Nov 2026, 20:00

test('history headers: words, weekdays, dates with and without a year', () => {
  assert.equal(C.parseHistoryHeader('Today', NOW), '2026-11-14');
  assert.equal(C.parseHistoryHeader('Yesterday', NOW), '2026-11-13');
  assert.equal(C.parseHistoryHeader('Thursday', NOW), '2026-11-12');
  // Today is Saturday, so "Saturday" is a week ago (today would say "Today").
  assert.equal(C.parseHistoryHeader('Saturday', NOW), '2026-11-07');
  assert.equal(C.parseHistoryHeader('Nov 3', NOW), '2026-11-03');
  assert.equal(C.parseHistoryHeader('3 Nov', NOW), '2026-11-03');
  // Without a year, a date after today is last year's.
  assert.equal(C.parseHistoryHeader('Dec 25', NOW), '2025-12-25');
  assert.equal(C.parseHistoryHeader('May 30, 2026', NOW), '2026-05-30');
  assert.equal(C.parseHistoryHeader('3 November 2025', NOW), '2025-11-03');
  assert.equal(C.parseHistoryHeader('Sunday, Nov 2', NOW), '2026-11-02');
  assert.equal(C.parseHistoryHeader('3 days ago', NOW), '2026-11-11');
  assert.equal(C.parseHistoryHeader('Shorts', NOW), null);
  assert.equal(C.parseHistoryHeader('', NOW), null);
  assert.equal(C.parseHistoryHeader('Feb 31', NOW), null);
});

test('merge: the same watch from live tracking, Chrome and Takeout counts once', () => {
  const h = { watches: {}, metadata: {} };
  const live = at(2026, 11, 14, 9, 0, 10, 345);
  assert.deepEqual(C.mergeEvents(h, [{ videoId: 'abcdefghijk', title: 'Lecture 1', channel: 'MIT', timestamp: live }]), { added: 1, replaced: 0 });
  // Chrome saw the page open 10 s earlier, Takeout records the start too.
  const r = C.mergeEvents(h, [
    { videoId: 'abcdefghijk', title: 'Lecture 1', channel: 'Unknown Channel', timestamp: live - 10_000, source: 'chrome' },
    { videoId: 'abcdefghijk', title: 'Lecture 1', channel: 'MIT', timestamp: live - 9_000, source: 'takeout' },
  ]);
  assert.deepEqual(r, { added: 0, replaced: 0 });
  assert.equal(h.watches.abcdefghijk.length, 1);
  assert.equal(h.metadata.abcdefghijk.channel, 'MIT');
  // A real rewatch later that day counts.
  C.mergeEvents(h, [{ videoId: 'abcdefghijk', title: 'Lecture 1', channel: 'MIT', timestamp: live + 3_600_000 }]);
  assert.equal(h.watches.abcdefghijk.length, 2);
});

test('merge: guessed (approx) times never double a day, and a real time replaces the guess', () => {
  const h = { watches: {}, metadata: {} };
  const guess = at(2026, 11, 13, 12, 0, 0, 1);
  assert.equal(C.mergeEvents(h, [{ videoId: 'shortAAAAAA', title: 'Cat', channel: 'YouTube Shorts', timestamp: guess, approx: true, isShort: true }]).added, 1);
  // Re-syncing the history page on another day gives another guess for the same day: skipped.
  assert.equal(C.mergeEvents(h, [{ videoId: 'shortAAAAAA', title: 'Cat', channel: 'YouTube Shorts', timestamp: guess - 5000, approx: true }]).added, 0);
  assert.deepEqual(h.metadata.shortAAAAAA.approx, [guess]);
  // Chrome's exact time for that day replaces the guess.
  const real = at(2026, 11, 13, 21, 14, 3, 120);
  assert.deepEqual(C.mergeEvents(h, [{ videoId: 'shortAAAAAA', title: 'Cat', channel: 'Some Cat Channel', timestamp: real, isShort: true }]), { added: 0, replaced: 1 });
  assert.deepEqual(h.watches.shortAAAAAA, [real]);
  assert.equal(h.metadata.shortAAAAAA.approx, undefined);
  assert.equal(h.metadata.shortAAAAAA.isShort, true);
  // A real channel beats "YouTube Shorts", and it stays.
  assert.equal(h.metadata.shortAAAAAA.channel, 'Some Cat Channel');
  C.mergeEvents(h, [{ videoId: 'shortAAAAAA', title: 'Cat', channel: 'YouTube Shorts', timestamp: real + 86_400_000 }]);
  assert.equal(h.metadata.shortAAAAAA.channel, 'Some Cat Channel');
  // A guess on a day that already has a real time is skipped.
  assert.equal(C.mergeEvents(h, [{ videoId: 'shortAAAAAA', timestamp: at(2026, 11, 13, 11, 59, 0, 1), approx: true }]).added, 0);
});

test('merge: titles, unknowns and bad ids', () => {
  const h = { watches: {}, metadata: {} };
  C.mergeEvents(h, [{ videoId: 'vid000000001', title: 'Old title', channel: 'A', timestamp: at(2026, 1, 1) }]);
  C.mergeEvents(h, [{ videoId: 'vid000000001', title: 'Unknown Video', channel: 'Unknown Channel', timestamp: at(2026, 2, 1) }]);
  assert.equal(h.metadata.vid000000001.title, 'Old title');
  assert.equal(h.metadata.vid000000001.channel, 'A');
  C.mergeEvents(h, [{ videoId: 'vid000000001', title: 'New title', channel: 'A', timestamp: at(2026, 3, 1) }]);
  assert.equal(h.metadata.vid000000001.title, 'New title');
  assert.equal(h.metadata.vid000000001.lastWatched, at(2026, 3, 1));
  // An older import doesn't put back the old title.
  C.mergeEvents(h, [{ videoId: 'vid000000001', title: 'Ancient title', channel: 'A', timestamp: at(2025, 1, 1) }]);
  assert.equal(h.metadata.vid000000001.title, 'New title');
  // Ids that could break out of an HTML attribute are refused.
  assert.equal(C.mergeEvents(h, [{ videoId: '"><img src=x>', timestamp: at(2026, 1, 1) }]).added, 0);
  assert.equal(C.mergeEvents(h, [{ videoId: 'search:cats%20dogs', title: 'Searched for cats dogs', timestamp: at(2026, 1, 1) }]).added, 1);
});

test('repair: old history-page guesses and near duplicates fold together, real watches stay', () => {
  const real = at(2026, 10, 1, 21, 5, 7, 431);
  const takeout = at(2026, 10, 2, 8, 30, 12, 0); // no milliseconds, but seconds aren't 0
  const h = {
    watches: {
      a1234567890: [at(2026, 10, 1, 12, 0), at(2026, 10, 1, 11, 59), real, real + 60_000],
      b1234567890: [at(2026, 10, 3, 11, 58), at(2026, 10, 3, 11, 40)],
      c1234567890: [takeout, takeout + 10 * 60_000],
    },
    metadata: { a1234567890: { title: 'A' }, b1234567890: { title: 'B' }, c1234567890: { title: 'C' } },
  };
  const removed = C.repairDuplicates(h);
  assert.deepEqual(h.watches.a1234567890, [real]);
  assert.deepEqual(h.watches.b1234567890, [at(2026, 10, 3, 11, 58)]);
  assert.deepEqual(h.watches.c1234567890, [takeout, takeout + 10 * 60_000]);
  assert.equal(removed, 4);
});

test('Takeout: watches, Shorts links, searches, sponsored visits; records without a time are skipped', () => {
  const raw = [
    { header: 'YouTube', title: 'Watched Rust in 100 seconds', titleUrl: 'https://www.youtube.com/watch?v=5C_HPTJg5ek', subtitles: [{ name: 'Fireship' }], time: '2026-11-01T10:00:00.123Z' },
    { title: 'Watched funny cat', titleUrl: 'https://www.youtube.com/shorts/AbCdEfGhIjK', time: '2026-11-01T10:05:00.000Z' },
    { title: 'Searched for how to fold a shirt', time: '2026-11-01T09:00:00Z' },
    { title: 'Visited https://example.com/x', titleUrl: 'https://www.google.com/url?q=https://example.com/x', details: [{ name: 'From Google Ads' }], time: '2026-11-01T09:01:00Z' },
    { title: 'Watched no time', titleUrl: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' },
  ];
  const ev = C.eventsFromTakeout(raw);
  assert.equal(ev.length, 4);
  assert.equal(ev[0].title, 'Rust in 100 seconds');
  assert.equal(ev[0].channel, 'Fireship');
  assert.equal(ev[1].isShort, true);
  assert.equal(ev[2].videoId, 'search:how%20to%20fold%20a%20shirt');
  assert.equal(ev[3].videoId, 'visit:example.com');
  assert.throws(() => C.eventsFromTakeout({}), /array/);
});

test("Chrome's visits: one watch per video, swiped-past Shorts skipped, titles cleaned", () => {
  const t0 = at(2026, 11, 14, 18, 0);
  const visits = [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=10', title: '(3) Big lecture - YouTube', time: t0 },
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Big lecture - YouTube', time: t0 + 60_000 },
    { url: 'https://www.youtube.com/shorts/sssssssssss', title: 'Quick one - YouTube', time: t0 + 120_000 },
    { url: 'https://www.youtube.com/shorts/ttttttttttt', title: 'Swiped - YouTube', time: t0 + 140_000 },
    { url: 'https://www.youtube.com/shorts/uuuuuuuuuuu', title: 'Kept - YouTube', time: t0 + 141_000 },
    { url: 'https://www.youtube.com/shorts/vvvvvvvvvvv', title: 'Last - YouTube', time: t0 + 160_000 },
    { url: 'https://example.com/', title: 'Not YouTube', time: t0 },
    { url: 'https://m.youtube.com/watch?v=bbbbbbbbbbb', title: 'Phone Chrome - YouTube', time: t0 - 86_400_000 },
  ];
  const ev = C.eventsFromChromeVisits(visits, at(2026, 11, 14, 0), at(2026, 11, 15, 0));
  assert.deepEqual(ev.map((e) => e.videoId), ['aaaaaaaaaaa', 'sssssssssss', 'uuuuuuuuuuu', 'vvvvvvvvvvv']);
  assert.equal(ev[0].title, 'Big lecture');
  assert.equal(ev[1].isShort, true);
});

const textRuns = (t) => ({ runs: [{ text: t }] });
const section = (title, contents) => ({ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: textRuns(title) } }, contents } });
const video = (id, title, channel) => ({ videoRenderer: { videoId: id, title: textRuns(title), ownerText: textRuns(channel) } });
const shortVm = (id, title) => ({ shortsLockupViewModel: { entityId: `shorts-shelf-item-${id}`, overlayMetadata: { primaryText: { content: title } }, onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } } } });
const lockup = (id, title, channel) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: channel } }] }] } } } } } });

test("account history: items under their day headers, Shorts shelves, new view models, continuations", () => {
  const data = {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
      section('Today', [video('vid00000001', 'Video one', 'Chan A'), { reelShelfRenderer: { title: textRuns('Shorts'), items: [shortVm('sho00000001', 'Short one'), shortVm('sho00000002', 'Short two')] } }]),
      section('Yesterday', [lockup('vid00000002', 'Video two', 'Chan B'), video('vid00000001', 'Video one', 'Chan A')]),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT-TOKEN' } } } },
    ] } } } }] } },
  };
  const { items, lastDay } = C.itemsFromHistoryData(data, NOW);
  assert.deepEqual(items.map((i) => `${i.day} ${i.videoId} ${i.isShort ? 'S' : 'V'}`), [
    '2026-11-14 vid00000001 V',
    '2026-11-14 sho00000001 S',
    '2026-11-14 sho00000002 S',
    '2026-11-13 vid00000002 V',
    '2026-11-13 vid00000001 V',
  ]);
  assert.equal(items[3].channel, 'Chan B');
  assert.equal(lastDay, '2026-11-13');
  assert.equal(C.findContinuation(data), 'NEXT-TOKEN');
  // The next page carries on the day the last page ended on, until its own header.
  const more = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
    { itemSectionRenderer: { contents: [video('vid00000003', 'Three', 'C')] } },
    section('Thursday', [video('vid00000004', 'Four', 'D')]),
  ] } }] };
  const next = C.itemsFromHistoryData(more, NOW, lastDay);
  assert.deepEqual(next.items.map((i) => `${i.day} ${i.videoId}`), ['2026-11-13 vid00000003', '2026-11-12 vid00000004']);
  assert.equal(C.findContinuation(more), null);
});

test('page parsing: ytInitialData and ytcfg out of HTML, braces inside strings', () => {
  const html = '<script>var ytInitialData = {"a":"x { y } z","b":{"c":[1,2,{"d":"}"}]}};</script>' +
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"k","LOGGED_IN":true}); ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.2026"});</script>';
  assert.deepEqual(C.extractJsonVar(html, 'ytInitialData'), { a: 'x { y } z', b: { c: [1, 2, { d: '}' }] } });
  assert.deepEqual(C.extractYtcfg(html), { INNERTUBE_API_KEY: 'k', LOGGED_IN: true, INNERTUBE_CLIENT_VERSION: '2.2026' });
  assert.equal(C.extractJsonVar('<html></html>', 'ytInitialData'), null);
});

test('guessed times keep the page order, stay inside the day, before noon, never in the future', () => {
  const items = [
    { day: '2026-11-13', videoId: 'vid00000001', title: 'A', channel: 'X' },
    { day: '2026-11-13', videoId: 'vid00000002', title: 'B', channel: 'X' },
    { day: '2026-11-14', videoId: 'vid00000003', title: 'C', channel: 'X' },
  ];
  const ev = C.eventsFromHistoryItems(items, '2026-11-13', NOW);
  assert.equal(ev.length, 2);
  assert.ok(ev[0].timestamp > ev[1].timestamp);
  assert.ok(ev.every((e) => e.approx && C.localDay(e.timestamp) === '2026-11-13' && new Date(e.timestamp).getHours() < 12));
  assert.ok(ev.every((e) => !C.looksGuessed(e.timestamp)));
  const early = at(2026, 11, 14, 8, 0);
  const todays = C.eventsFromHistoryItems(items, '2026-11-14', early);
  assert.ok(todays[0].timestamp <= early + 1);
});

test('interests: day summary and rising/fading topics by share', () => {
  const h = { watches: {}, metadata: {} };
  const labels = {};
  const add = (id, day, n, category, topics, isShort = false) => {
    h.watches[id] = Array.from({ length: n }, (_, i) => at(...day, 10, i * 10));
    h.metadata[id] = { title: id, channel: 'c', isShort };
    labels[id] = { category, topics };
  };
  add('ml000000001', [2026, 11, 14], 3, 'useful', ['machine learning']);
  add('cr000000001', [2026, 11, 14], 1, 'entertainment', ['cricket'], true);
  add('cr000000002', [2026, 10, 20], 5, 'entertainment', ['cricket']);
  add('ml000000002', [2026, 10, 21], 1, 'useful', ['machine learning']);
  const s = C.daySummary(h, labels, '2026-11-14');
  assert.deepEqual([s.watches, s.useful, s.distraction, s.shorts, s.unlabelled], [4, 3, 1, 1, 0]);
  const recent = C.topicCounts(h, labels, '2026-11-08', '2026-11-14');
  const earlier = C.topicCounts(h, labels, '2026-10-11', '2026-11-07');
  const shift = C.interestShift(recent, earlier);
  assert.equal(shift.rising[0].topic, 'machine learning');
  assert.equal(shift.fading[0].topic, 'cricket');
});

test('escaping and URL parsing', () => {
  assert.equal(C.esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.deepEqual(C.parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=3'), { videoId: 'dQw4w9WgXcQ', isShort: false });
  assert.deepEqual(C.parseYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ', isShort: false });
  assert.equal(C.parseYouTubeUrl('https://www.youtube.com/feed/history'), null);
  assert.equal(C.parseYouTubeUrl('https://www.youtube.com/watch?v=<script>'), null);
  assert.equal(C.cleanTitle('(12+) Title - YouTube Music'), 'Title');
});

test('the Obsidian plugin carries an exact copy of yt-core.js (npm run sync-core)', () => {
  const core = readFileSync(new URL('../chrome-extension/utils/yt-core.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../obsidian-plugin/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes(core), 'obsidian-plugin/main.js is out of date: run npm run sync-core');
});
