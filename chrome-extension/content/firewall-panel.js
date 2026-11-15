// content/firewall-panel.js
// 🧯 Rhetoric firewall on YouTube: a small pill on every video and Short; tapping it opens a side
// panel that checks the video (Gemini watches it, through the service worker) and shows the bare
// argument. Times in the check jump the video there. Styles live in a shadow root, so YouTube's
// CSS and ours never mix. Nothing runs until the pill is tapped.
(function () {
  'use strict';
  const F = globalThis.FWCore;
  const V = globalThis.FWView;
  if (!F || !V) return;

  let host = null; // the pill + panel, in one shadow root
  let shadow = null;
  let open = false;
  let videoId = null;
  let check = null;
  let state = 'idle'; // idle | checking | error
  let error = '';
  let before; // conviction before looking

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : r || { success: false }));
      } catch (e) {
        resolve({ success: false, error: 'The extension was reloaded: refresh this page.' });
      }
    });

  function currentId() {
    const p = location.pathname;
    if (p.startsWith('/shorts/')) return p.split('/')[2] || null;
    if (p === '/watch') return new URLSearchParams(location.search).get('v');
    return null;
  }

  function details() {
    const short = location.pathname.startsWith('/shorts/');
    const scope = short ? document.querySelector('ytd-reel-video-renderer[is-active]') || document : document.querySelector('ytd-watch-flexy:not([hidden])') || document;
    const pick = (sel) => {
      for (const s of sel) {
        const el = scope.querySelector(s);
        const t = el && (el.textContent || '').trim();
        if (t) return t;
      }
      return '';
    };
    const title = pick(['h1.ytd-watch-metadata yt-formatted-string', 'h1.ytd-watch-metadata', 'h2.ytShortsVideoTitleViewModelShortsVideoTitle', 'yt-shorts-video-title-view-model h2', 'h2']) || document.title.replace(/ - YouTube$/, '');
    const channel = pick(['ytd-channel-name#channel-name a', '#owner #channel-name a', '#channel-name a', 'yt-reel-channel-bar-view-model a', '.ytReelChannelBarViewModelChannelName a']);
    return { title: title.slice(0, 200), channel: channel.slice(0, 80) };
  }

  function seek(s) {
    const v = document.querySelector('video');
    if (!v) return;
    v.currentTime = s;
    v.play().catch(() => {});
  }

  const PANEL_CSS = `
:host { all: initial; }
.pill { position: fixed; right: 18px; bottom: 96px; z-index: 2147483000; display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 999px;
  font: 600 13px system-ui, -apple-system, sans-serif; color: #fff; cursor: pointer; border: 1px solid rgba(255,255,255,.18);
  background: rgba(24,24,27,.82); backdrop-filter: blur(14px) saturate(1.6); box-shadow: 0 6px 22px rgba(0,0,0,.35); transition: transform .2s cubic-bezier(.34,1.56,.64,1); }
.pill:hover { transform: scale(1.06); }
.pill .h { width: 8px; height: 8px; border-radius: 50%; }
.panel { position: fixed; top: 64px; right: 12px; bottom: 12px; width: min(400px, calc(100vw - 24px)); z-index: 2147483001; display: flex; flex-direction: column;
  border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.14); background: rgba(18,18,22,.9); backdrop-filter: blur(20px) saturate(1.6);
  box-shadow: 0 20px 60px rgba(0,0,0,.5); animation: in .28s cubic-bezier(.34,1.56,.64,1); }
@keyframes in { from { opacity: 0; transform: translateX(24px); } }
.bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.08); font: 700 14px system-ui, sans-serif; color: #fff; }
.bar span { flex: 1; }
.bar button { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: rgba(255,255,255,.08); }
.body { flex: 1; overflow-y: auto; padding: 12px 14px 18px; overscroll-behavior: contain; }
.hint { margin: 0 0 10px; color: #a1a1aa; font: 12px/1.45 system-ui, sans-serif; }
${V.CSS}`;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'yt-firewall-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
  }

  function remove() {
    if (host) host.remove();
    host = shadow = null;
    open = false;
  }

  function draw() {
    if (!videoId) return remove();
    ensureHost();
    for (const el of [...shadow.children]) if (el.tagName !== 'STYLE') el.remove();
    if (!open) {
      const pill = document.createElement('button');
      pill.className = 'pill';
      pill.title = 'Rhetoric firewall: strip the delivery and see the bare argument';
      if (check) {
        const dot = document.createElement('span');
        dot.className = 'h';
        dot.style.background = `color-mix(in oklab, #f87171 ${check.heat}%, #60a5fa)`;
        pill.append('🧯 ', dot, ` ${100 - check.heat}% logic`);
      } else pill.textContent = state === 'checking' ? '🧯 Checking…' : '🧯 Check logic';
      pill.addEventListener('click', () => {
        open = true;
        draw();
      });
      shadow.appendChild(pill);
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'panel';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const title = document.createElement('span');
    title.textContent = '🧯 Rhetoric firewall';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', () => {
      open = false;
      draw();
    });
    bar.append(title, close);
    const body = document.createElement('div');
    body.className = 'body';
    // Keep YouTube's keyboard shortcuts out of the panel.
    body.addEventListener('keydown', (e) => e.stopPropagation());
    if (state === 'checking') body.appendChild(V.status('Gemini is watching the video and taking the arguments apart (about a minute; you can keep watching)…'));
    else if (check) {
      body.appendChild(
        V.render(check, {
          onSeek: seek,
          onAfter: async (n) => {
            const r = await send({ action: 'firewallConviction', videoId, patch: { after: n } });
            if (r.success && r.check) {
              check = r.check;
              draw();
            }
          },
          onRedo: () => run(true),
        }),
      );
    } else {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'Strips the confidence, urgency, jargon and flags off what is said and shows the bare argument: each claim as plain logic, the trick if there is one, contradictions, who gains, and what does hold up. Gemini watches the video itself.';
      body.appendChild(hint);
      const wrap = document.createElement('div');
      wrap.className = 'fw';
      wrap.appendChild(V.conviction('Before you look: how convinced are you? (optional)', before, (n) => {
        before = before === n ? undefined : n;
        draw();
      }));
      if (state === 'error') {
        const p = document.createElement('p');
        p.className = 'fw-status fw-error';
        p.textContent = error;
        wrap.appendChild(p);
      }
      const go = document.createElement('button');
      go.className = 'fw-primary';
      go.textContent = '🧯 Check this video';
      go.addEventListener('click', () => run(false));
      wrap.appendChild(go);
      body.appendChild(wrap);
    }
    panel.append(bar, body);
    shadow.appendChild(panel);
  }

  async function run(force) {
    const id = videoId;
    state = 'checking';
    draw();
    const r = await send({ action: 'firewallCheck', videoId: id, ...details(), before, force });
    if (id !== videoId) return;
    if (r.success && r.check) {
      check = r.check;
      state = 'idle';
    } else {
      state = 'error';
      error = r.error || 'The check failed.';
    }
    draw();
  }

  async function onNavigate() {
    const id = currentId();
    if (id === videoId) return;
    videoId = id;
    check = null;
    state = 'idle';
    before = undefined;
    open = false;
    if (!id) return remove();
    const r = await send({ action: 'firewallGet', videoId: id });
    if (id !== videoId) return;
    check = (r.success && r.check) || null;
    if (r.checking) state = 'checking';
    draw();
  }

  // A check finished in the background (or in the popup): show it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.firewall || !videoId) return;
    const next = ((changes.firewall.newValue || {}).checks || {})[videoId];
    if (next && (!check || next.at !== check.at || next.after !== check.after)) {
      check = next;
      state = 'idle';
      draw();
    }
  });
  window.addEventListener('yt-navigate-finish', () => void onNavigate());
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.action === 'urlChanged') setTimeout(() => void onNavigate(), 300);
  });
  void onNavigate();
})();
