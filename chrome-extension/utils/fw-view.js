// utils/fw-view.js
// 🧯 How a firewall check looks: the same view on the YouTube page (side panel) and in the popup.
// Classic script (globalThis.FWView), needs fw-core.js first. Everything the AI wrote goes in as
// text, never as HTML.
(function (root) {
  'use strict';
  const F = root.FWCore;

  const CSS = `
.fw { --logic: #60a5fa; --heat: #f87171; --fair: #4ade80; --amber: #fbbf24; --muted: #a1a1aa; --line: rgba(255,255,255,.1);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f4f5; display: flex; flex-direction: column; gap: 10px; }
.fw * { box-sizing: border-box; }
.fw p { margin: 0; }
.fw button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--line); background: rgba(255,255,255,.06); border-radius: 999px; padding: 4px 12px; }
.fw button:hover { background: rgba(255,255,255,.12); }
.fw-head { display: flex; flex-direction: column; gap: 2px; }
.fw-head b { font-size: 16px; }
.fw-head span { color: var(--muted); font-size: 12px; }
.fw-meter { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 11px; font-weight: 600; }
.fw-meter .l { color: var(--logic); } .fw-meter .r { color: var(--heat); }
.fw-bar { position: relative; height: 8px; border-radius: 999px; background: linear-gradient(90deg, var(--logic), #a78bfa, var(--heat)); }
.fw-bar i { position: absolute; top: -4px; width: 6px; height: 16px; margin-left: -3px; border-radius: 3px; background: #fff; box-shadow: 0 0 0 2px #18181b; }
.fw-verdict { padding: 10px 12px; border-radius: 12px; background: #fafafa; color: #18181b; font-weight: 650; font-size: 14px; }
.fw-tally { display: flex; flex-wrap: wrap; gap: 4px; }
.fw-tally span { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: rgba(255,255,255,.08); color: var(--muted); }
.fw-tally span.hot { color: var(--heat); background: rgba(248,113,113,.14); }
.fw-claims { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.fw-claim { padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,.05); border-left: 4px solid var(--c); display: flex; flex-direction: column; gap: 5px; }
.fw-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.fw-n { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: #f4f4f5; color: #18181b; font-weight: 700; font-size: 10px; }
.fw button.fw-t { padding: 0 8px; font-size: 11px; color: var(--logic); background: rgba(96,165,250,.14); border-color: transparent; }
.fw-heatv { margin-left: auto; font-weight: 600; color: var(--c); }
.fw-quote { font-style: italic; color: var(--muted); }
.fw-premise { padding: 6px 9px; border-radius: 9px; background: rgba(96,165,250,.1); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.fw-premise small { display: block; font: 700 9px system-ui, sans-serif; letter-spacing: .07em; color: var(--logic); }
.fw-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.fw-badges details { max-width: 100%; }
.fw-badges summary { list-style: none; cursor: pointer; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; color: var(--heat); background: rgba(248,113,113,.14); }
.fw-badges summary::-webkit-details-marker { display: none; }
.fw-badges details p { margin-top: 3px; font-size: 12px; color: var(--muted); }
.fw-vs { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; color: var(--amber); background: rgba(251,191,36,.14); }
.fw-inc { font-size: 12px; color: var(--muted); }
.fw-plain { font-weight: 650; }
.fw-box { padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,.05); border-left: 4px solid var(--b, var(--line)); display: flex; flex-direction: column; gap: 4px; }
.fw-box h4 { margin: 0 0 2px; font-size: 12px; }
.fw-box ul { margin: 0; padding-left: 16px; }
.fw-conv { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 12px; }
.fw-conv div { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; }
.fw .fw-conv button { padding: 3px 0; border-radius: 7px; font-size: 11px; }
.fw .fw-conv button.on { background: var(--logic); color: #0b1220; border-color: transparent; font-weight: 700; }
.fw-shift { color: var(--logic); font-weight: 600; font-size: 12px; }
.fw-by { color: var(--muted); font-size: 11px; }
.fw-status { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-radius: 12px; background: rgba(96,165,250,.12); }
.fw-spin { width: 10px; height: 10px; flex: none; border-radius: 50%; border: 2px solid var(--logic); border-right-color: transparent; animation: fw-spin .9s linear infinite; }
@keyframes fw-spin { to { transform: rotate(360deg); } }
.fw-error { color: var(--heat); }
.fw-primary { background: linear-gradient(135deg, #3b82f6, #8b5cf6) !important; border-color: transparent !important; font-weight: 650; }
`;

  function h(tag, cls, text, kids) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null && text !== '') el.textContent = String(text);
    for (const k of kids || []) if (k) el.appendChild(k);
    return el;
  }
  const BASIS = { evidence: '📊 evidence', reasoning: '🧩 reasoning', assertion: '🗣️ just said', emotion: '🔥 feeling' };
  /** Blue (logic) to red (emotion). */
  const heatColor = (n) => `color-mix(in oklab, #f87171 ${n}%, #60a5fa)`;

  /** 0–10 taps; `onPick(n)`. */
  function conviction(label, value, onPick) {
    const row = h('div');
    for (let i = 0; i <= 10; i++) {
      const b = h('button', value === i ? 'on' : '', String(i));
      b.type = 'button';
      b.addEventListener('click', () => onPick(i));
      row.appendChild(b);
    }
    return h('div', 'fw-conv', null, [h('span', '', label), row]);
  }

  function claimCard(c, onSeek) {
    const top = h('div', 'fw-top', null, [h('span', 'fw-n', c.n)]);
    if (c.t) {
      const t = h('button', 'fw-t', `▶ ${c.t}`);
      t.type = 'button';
      t.title = 'Jump there';
      t.addEventListener('click', () => onSeek && onSeek(F.seconds(c.t)));
      top.appendChild(t);
    }
    top.appendChild(h('span', '', BASIS[c.basis] || c.basis));
    top.appendChild(h('span', 'fw-heatv', `${c.heat}% 🔥`));
    const li = h('li', 'fw-claim', null, [top]);
    li.style.setProperty('--c', heatColor(c.heat));
    if (c.quote) li.appendChild(h('p', 'fw-quote', `“${c.quote}”`));
    const prem = h('p', 'fw-premise', null, [h('small', '', 'STRIPPED')]);
    prem.appendChild(document.createTextNode(c.premise || c.claim));
    li.appendChild(prem);
    if (c.fallacies.length || c.contradicts.length) {
      const badges = h('div', 'fw-badges');
      for (const f of c.fallacies) badges.appendChild(h('details', '', null, [h('summary', '', f), h('p', '', F.FALLACIES[f] || 'A trick the model named; not in the guide.')]));
      for (const x of c.contradicts) badges.appendChild(h('span', 'fw-vs', `⚡ clashes with #${x}`));
      li.appendChild(badges);
    }
    if (c.incentive) li.appendChild(h('p', 'fw-inc', `💰 ${c.incentive}`));
    if (c.plain) li.appendChild(h('p', 'fw-plain', `→ ${c.plain}`));
    return li;
  }

  function box(title, color, kids) {
    const b = h('section', 'fw-box', null, [h('h4', '', title), ...kids]);
    if (color) b.style.setProperty('--b', color);
    return b;
  }
  const ul = (items) => h('ul', '', null, items.map((t) => h('li', '', t)));

  /** The whole check. opts: onSeek(seconds), onAfter(n), onRedo(). */
  function render(r, opts = {}) {
    const t = F.tally(r);
    const root2 = h('div', 'fw');
    root2.appendChild(h('div', 'fw-head', null, [h('b', '', r.speaker || 'Unknown speaker'), h('span', '', r.topic || r.title || '')]));
    const bar = h('span', 'fw-bar', null, [h('i')]);
    bar.firstChild.style.left = `${r.heat}%`;
    root2.appendChild(h('div', 'fw-meter', null, [h('span', 'l', `🧠 Logic ${100 - r.heat}%`), bar, h('span', 'r', `${r.heat}% Emotion 🔥`)]));
    if (r.verdict) root2.appendChild(h('p', 'fw-verdict', r.verdict));
    const tally = h('div', 'fw-tally', null, [
      h('span', '', `${t.claims} claims`),
      h('span', t.tricks ? 'hot' : '', `${t.tricks} tricks`),
      h('span', t.contradictions ? 'hot' : '', `${t.contradictions} contradictions`),
      h('span', '', `${t.bare} with nothing behind them`),
    ]);
    root2.appendChild(tally);
    root2.appendChild(h('ol', 'fw-claims', null, r.claims.map((c) => claimCard(c, opts.onSeek))));
    const clashes = [
      ...r.contradictions.map((p) => `#${p.a} vs #${p.b}${p.why ? `: ${p.why}` : ''}`),
      ...r.past.map((p) => `#${p.n} vs ${p.day || 'before'} “${p.prior}”${p.why ? `: ${p.why}` : ''}`),
    ];
    if (clashes.length) root2.appendChild(box("⚡ Can't both be true", '#fbbf24', [ul(clashes)]));
    if (r.steelman || r.holds.length) root2.appendChild(box('⚖️ Fair to them', '#4ade80', [r.steelman ? h('p', '', r.steelman) : null, r.holds.length ? ul(r.holds.map((x) => `✓ ${x}`)) : null]));
    if (r.ask.length) root2.appendChild(box('❓ What would settle it', '', [ul(r.ask)]));
    if (opts.onAfter) root2.appendChild(conviction('And now, how convinced are you?', r.after, opts.onAfter));
    if (typeof r.before === 'number' && typeof r.after === 'number') {
      const d = r.after - r.before;
      root2.appendChild(h('p', 'fw-shift', d === 0 ? "Same as before: the delivery wasn't doing the work." : d < 0 ? `${-d} point${d === -1 ? '' : 's'} less convinced once the delivery was stripped.` : `${d} point${d === 1 ? '' : 's'} more convinced: the argument held up.`));
    }
    const foot = h('div', 'fw-tally', null, [h('span', 'fw-by', `${r.by || 'Gemini'} · ${r.model || ''} · ${String(r.at).slice(0, 10)}`)]);
    if (opts.onRedo) {
      const b = h('button', '', '↺ Check again');
      b.type = 'button';
      b.addEventListener('click', opts.onRedo);
      foot.appendChild(b);
    }
    root2.appendChild(foot);
    return root2;
  }

  function status(text, error) {
    return h('div', 'fw', null, [h('p', error ? 'fw-status fw-error' : 'fw-status', null, [error ? null : h('span', 'fw-spin'), h('span', '', text)])]);
  }

  root.FWView = { CSS, render, status, conviction, h };
})(typeof globalThis !== 'undefined' ? globalThis : this);
