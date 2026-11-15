// utils/fw-core.js
// 🧯 Rhetoric firewall, the pure part: strips the delivery (confidence, urgency, jargon, flags,
// prestige) off what a video says and shows the bare argument: each claim as plain logic, what it
// rests on, the named trick, contradictions (also with the speaker's earlier videos), who gains, a
// plain sentence of what's going on, and what does hold up. The same rules, prompt and fallacy
// guide as Dynamic Journal's 🧯 (src/lib/firewall.ts), so a check means the same in both.
//
// Classic script like yt-core.js: a content script, a <script> tag, `import './fw-core.js'` in an
// ES module, or Node. Everything is on globalThis.FWCore. No chrome.* calls here.
(function (root) {
  'use strict';

  const FALLACIES = {
    'Straw man': "Answers a weaker, exaggerated version of the other side instead of what was actually said.",
    'False equivalence': 'Treats two things as the same because they share one surface feature.',
    'False dilemma': 'Offers two options as the only ones when there are more.',
    'Ad hominem': 'Attacks the person (their intelligence, motives, background) instead of their point.',
    'Appeal to authority': "It's true because an important or confident person says so.",
    'Appeal to emotion': "Uses fear, pride, anger or pity to carry a point the evidence doesn't.",
    'Appeal to patriotism': 'Wraps the claim in the flag: disagreeing is made to look disloyal.',
    Whataboutism: "Deflects a criticism by pointing at someone else's fault.",
    'Gish gallop': 'Fires many quick claims or questions so none can be checked or answered.',
    'Red herring': "Changes the subject to something that sounds related but isn't the question.",
    'Moving the goalposts': 'Changes what would count as proof once the first bar is met.',
    'Circular reasoning': "The conclusion is hidden in the premise: it's true because it's true.",
    'Conflicting conditions': "Holds two claims that can't both be true at once.",
    'Slippery slope': 'Claims one step leads to an extreme without showing the chain.',
    'Hasty generalisation': 'Draws a big rule from a few cases.',
    'Cherry picking': "Shows only the facts that help and leaves out the ones that don't.",
    Bandwagon: "It's right because everyone (or the winners) is doing it.",
    'Loaded language': 'Words chosen to make you feel the conclusion before it\'s argued.',
    'Vague claim': 'Says nothing checkable: no numbers, no who, no when.',
    Condescension: 'Treats doubt as stupidity so questioning feels embarrassing.',
    'Unfalsifiable claim': 'No outcome could ever show it wrong.',
    'Begging the question': 'Assumes the very thing being argued about.',
  };
  const NAMES = Object.keys(FALLACIES);
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

  /** The guide's name for whatever the model wrote ("strawman", "ad-hominem attack"…), or the text as it came. */
  function fallacyName(raw) {
    const k = squash(raw);
    if (!k) return '';
    for (const name of NAMES) {
      const n = squash(name);
      if (k === n || k.startsWith(n) || (n.length > 6 && k.includes(n))) return name;
    }
    const alias = [
      [/doublethink|contradict/, 'Conflicting conditions'],
      [/fear|pity|emotional/, 'Appeal to emotion'],
      [/nationalis|flag/, 'Appeal to patriotism'],
      [/tuquoque|whatabout/, 'Whataboutism'],
      [/falsedichotomy|blackandwhite|eitheror/, 'False dilemma'],
      [/falseanalogy|weakanalogy/, 'False equivalence'],
      [/personalattack|insult/, 'Ad hominem'],
      [/goalpost/, 'Moving the goalposts'],
      [/buzzword|jargon|weasel/, 'Vague claim'],
      [/circular/, 'Circular reasoning'],
    ];
    const hit = alias.find(([re]) => re.test(k));
    return hit ? hit[1] : String(raw).trim().slice(0, 40);
  }

  const SYSTEM =
    "You are the rhetoric firewall: a ruthless but fair epistemic auditor. Confident, emotional speakers can steer people before the logic is ever checked. Your job is to strip the delivery and show the bare argument.\n\n" +
    "Ignore the speaker's prestige, confidence, tone, urgency, jargon, flags and applause. For every real argument (skip greetings and filler; merge repeats), in the order said:\n" +
    "- t: when it's said (m:ss) if you can tell, else \"\".\n" +
    '- quote: their words, short.\n' +
    '- claim: what they want the audience to believe.\n' +
    '- premise: the bare logical form, "If A, then B" or "A, therefore B", with no adjectives, metaphors or buzzwords.\n' +
    '- basis: evidence (checkable facts or data given), reasoning (follows from stated premises), assertion (just stated), or emotion (carried by feeling).\n' +
    `- fallacies: exact names from this list when they clearly apply, else []: ${NAMES.join(', ')}.\n` +
    '- contradicts: numbers of EARLIER claims that cannot be true at the same time as this one.\n' +
    '- incentive: how believing it benefits the speaker (money, power, image, legal cover), or "" if none is visible. Say only what is plausible from who they are and what is at stake; never invent facts about them.\n' +
    '- plain: one blunt sentence in plain English of what is actually going on.\n' +
    '- heat: 0–100, how much of its pull is emotional rather than logical.\n\n' +
    "Be brutal by being exact, not cynical. A sound point is sound even from someone with an interest: say so. Don't take a side on the topic itself; judge the structure, not the conclusion. Name a fallacy only when it really is one. Then: heat for the whole (0–100), verdict (one exact sentence), steelman (the strongest honest version of their case), holds (points that stand up), ask (2–3 questions that would settle it if answered), and contradictions as pairs of claim numbers with why. If earlier claims by the same speaker are given, list in past any that a new claim contradicts. Write in the language of the source.";

  const str = { type: 'string' };
  const arr = (items) => ({ type: 'array', items });
  const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
  const CLAIM = obj({
    n: { type: 'integer' }, t: str, quote: str, claim: str, premise: str,
    basis: { type: 'string', enum: ['evidence', 'reasoning', 'assertion', 'emotion'] },
    fallacies: arr(str), contradicts: arr({ type: 'integer' }), incentive: str, plain: str, heat: { type: 'integer' },
  });
  const PAIR = obj({ a: { type: 'integer' }, b: { type: 'integer' }, why: str });
  const SCHEMA = obj({
    speaker: str, topic: str, claims: arr(CLAIM), contradictions: arr(PAIR),
    past: arr(obj({ n: { type: 'integer' }, prior: str, day: str, why: str })),
    heat: { type: 'integer' }, verdict: str, steelman: str, holds: arr(str), ask: arr(str),
  });

  // ───── Speaker memory ─────

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

  /** A speaker from earlier checks named in these hints (title, channel), longest name first. */
  function knownSpeaker(checks, hints) {
    const h = ` ${norm(hints)} `;
    const names = [...new Set(checks.map((c) => c.speaker).filter((s) => s && norm(s).length >= 3))].sort((a, b) => b.length - a.length);
    const last = (n) => norm(n).split(' ').pop() || '';
    return names.find((n) => h.includes(` ${norm(n)} `) || (last(n).length >= 5 && h.includes(` ${last(n)} `))) || '';
  }

  /** What this speaker claimed in earlier checks (bare premises, newest first). */
  function priorPremises(checks, speaker, max = 40) {
    if (!speaker) return [];
    const s = norm(speaker);
    return checks
      .filter((c) => norm(c.speaker) === s)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .flatMap((c) => (c.claims || []).map((x) => ({ day: String(c.at).slice(0, 10), premise: x.premise || x.claim })))
      .filter((x) => x.premise)
      .slice(0, max);
  }

  function request({ title, channel, speaker, prior }) {
    return [
      `Watch the attached video${title ? ` ("${title}")` : ''} and audit what is said in it.`,
      channel ? `(Channel: ${channel})` : '',
      speaker ? `\nThe speaker is probably ${speaker}.` : '',
      prior && prior.length ? `\nWhat ${speaker} claimed in earlier checks (bare premises):\n${prior.map((p) => `- (${p.day}) ${p.premise}`).join('\n')}` : '',
    ].join('\n');
  }

  // ───── Normalising ─────

  const text = (v, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const clamp = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : 0);
  const list = (v, max, len = 400) => (Array.isArray(v) ? v.map((x) => text(x, len)).filter(Boolean).slice(0, max) : []);
  const BASES = ['evidence', 'reasoning', 'assertion', 'emotion'];

  function normalizeClaims(raw, from = 1, earlier = []) {
    const out = [];
    const renum = new Map();
    for (const r of Array.isArray(raw) ? raw : []) {
      const c = r && typeof r === 'object' ? r : {};
      const claim = text(c.claim, 500);
      const premise = text(c.premise, 500);
      if (!claim && !premise) continue;
      const n = from + out.length;
      if (Number.isFinite(Number(c.n))) renum.set(Number(c.n), n);
      out.push({
        n,
        t: /^\d{1,2}:\d{2}(:\d{2})?$/.test(text(c.t, 8)) ? text(c.t, 8) : '',
        quote: text(c.quote, 400),
        claim,
        premise,
        basis: BASES.includes(c.basis) ? c.basis : 'assertion',
        fallacies: [...new Set(list(c.fallacies, 4, 60).map(fallacyName).filter(Boolean))],
        contradicts: (Array.isArray(c.contradicts) ? c.contradicts : []).map(Number).filter(Number.isFinite),
        incentive: text(c.incentive, 300),
        plain: text(c.plain, 300),
        heat: clamp(c.heat),
      });
    }
    const valid = new Set([...earlier, ...out.map((c) => c.n)]);
    for (const c of out) c.contradicts = [...new Set(c.contradicts.map((x) => (renum.has(x) ? renum.get(x) : x)))].filter((x) => x !== c.n && valid.has(x) && x < c.n);
    return out;
  }

  function normalizePairs(raw, claims) {
    const ns = new Set(claims.map((c) => c.n));
    const pairs = (Array.isArray(raw) ? raw : [])
      .map((p) => ({ a: Number(p && p.a), b: Number(p && p.b), why: text(p && p.why, 400) }))
      .filter((p) => ns.has(p.a) && ns.has(p.b) && p.a !== p.b);
    for (const c of claims) for (const x of c.contradicts) if (!pairs.some((p) => (p.a === x && p.b === c.n) || (p.a === c.n && p.b === x))) pairs.push({ a: x, b: c.n, why: '' });
    return pairs.slice(0, 12);
  }

  function normalizeCheck(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const claims = normalizeClaims(r.claims);
    const ns = new Set(claims.map((c) => c.n));
    const avg = claims.length ? Math.round(claims.reduce((s, c) => s + c.heat, 0) / claims.length) : 0;
    return {
      speaker: text(r.speaker, 80),
      topic: text(r.topic, 160),
      claims,
      contradictions: normalizePairs(r.contradictions, claims),
      past: (Array.isArray(r.past) ? r.past : [])
        .map((p) => ({ n: Number(p && p.n), prior: text(p && p.prior, 400), day: text(p && p.day, 10), why: text(p && p.why, 400) }))
        .filter((p) => ns.has(p.n) && p.prior)
        .slice(0, 8),
      heat: r.heat === undefined ? avg : clamp(r.heat),
      verdict: text(r.verdict, 400),
      steelman: text(r.steelman, 800),
      holds: list(r.holds, 6),
      ask: list(r.ask, 4),
    };
  }

  // ───── Showing ─────

  function tally(r) {
    const counts = new Map();
    for (const c of r.claims || []) for (const f of c.fallacies) counts.set(f, (counts.get(f) || 0) + 1);
    return {
      claims: (r.claims || []).length,
      tricks: [...counts.values()].reduce((a, b) => a + b, 0),
      contradictions: (r.contradictions || []).length + (r.past || []).length,
      bare: (r.claims || []).filter((c) => c.basis === 'assertion' || c.basis === 'emotion').length,
      top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }

  /** Conviction shift over checks with both numbers (negative: less convinced after). */
  function convictionShift(checks) {
    const both = checks.filter((c) => typeof c.before === 'number' && typeof c.after === 'number');
    return { n: both.length, avg: both.length ? Math.round((both.reduce((s, c) => s + (c.after - c.before), 0) / both.length) * 10) / 10 : 0 };
  }

  /** "1:23" → 83 seconds. */
  const seconds = (t) => String(t || '').split(':').reduce((s, p) => s * 60 + Number(p || 0), 0);
  const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

  const FWCore = { FALLACIES, NAMES, fallacyName, SYSTEM, SCHEMA, knownSpeaker, priorPremises, request, normalizeClaims, normalizeCheck, tally, convictionShift, seconds, watchUrl };
  root.FWCore = FWCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = FWCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
