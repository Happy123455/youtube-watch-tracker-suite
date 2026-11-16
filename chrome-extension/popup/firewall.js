// popup/firewall.js
// 🧯 The firewall section of the popup: check any YouTube link, and every check kept so far
// (newest first); tap one to read it. Times open the video at that moment.
const F = globalThis.FWCore;
const V = globalThis.FWView;
const $ = (id) => document.getElementById(id);

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { success: false, error: chrome.runtime.lastError?.message })));
let checks = {};
let shown = null;

function videoIdOf(url) {
  const p = globalThis.YTCore && globalThis.YTCore.parseYouTubeUrl ? globalThis.YTCore.parseYouTubeUrl(url) : null;
  if (p && p.videoId) return p.videoId;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{6,20})/.exec(url);
  return m ? m[1] : null;
}

function drawList() {
  const list = $('fw-list');
  list.textContent = '';
  const all = Object.values(checks).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const shift = F.convictionShift(all);
  $('fw-shift').textContent = shift.n ? `${shift.avg > 0 ? '+' : ''}${shift.avg} conviction on average (${shift.n})` : '';
  for (const c of all.slice(0, 30)) {
    const b = V.h('button', `fw-item${shown === c.videoId ? ' on' : ''}`);
    b.type = 'button';
    const dot = V.h('span', 'fw-dot');
    dot.style.background = `color-mix(in oklab, #f87171 ${c.heat}%, #60a5fa)`;
    b.append(dot, V.h('b', '', c.speaker || 'Unknown'), V.h('span', 'fw-item-t', c.title || c.topic || ''), V.h('span', 'fw-item-d', `${100 - c.heat}% logic · ${String(c.at).slice(5, 10)}`));
    b.addEventListener('click', () => {
      shown = shown === c.videoId ? null : c.videoId;
      draw();
    });
    list.appendChild(V.h('li', '', null, [b]));
  }
}

function drawView() {
  const view = $('fw-view');
  view.textContent = '';
  const c = shown && checks[shown];
  if (!c) return;
  view.appendChild(
    V.render(c, {
      onSeek: (s) => chrome.tabs.create({ url: `${F.watchUrl(c.videoId)}&t=${s}s` }),
      onAfter: async (n) => {
        const r = await send({ action: 'firewallConviction', videoId: c.videoId, patch: { after: n } });
        if (r.success && r.check) checks[c.videoId] = r.check;
        draw();
      },
      onRedo: () => run(c.videoId, true),
    }),
  );
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function draw() {
  drawList();
  drawView();
}

async function run(videoId, force = false) {
  const status = $('fw-status');
  status.textContent = '';
  status.appendChild(V.status('Gemini is watching the video and taking the arguments apart (about a minute; you can close this, it keeps going)…'));
  const r = await send({ action: 'firewallCheck', videoId, title: '', channel: '', force });
  status.textContent = '';
  if (!r.success) {
    status.appendChild(V.status(r.error || 'The check failed.', true));
    return;
  }
  checks[videoId] = r.check;
  shown = videoId;
  draw();
}

async function load() {
  const r = await send({ action: 'firewallList' });
  checks = (r.success && r.checks) || {};
  draw();
}

const style = document.createElement('style');
style.textContent = `${V.CSS}
.fw-hint { margin: 4px 0 8px; font-size: 11px; color: var(--color-text-secondary); }
.fw-form { display: flex; gap: 6px; margin-bottom: 8px; }
.fw-form input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-card); background: rgba(255,255,255,.04); color: inherit; font: inherit; font-size: 12px; }
.fw-shift-chip { font-size: 10px; color: #60a5fa; }
.fw-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow-y: auto; }
.fw-item { width: 100%; display: grid; grid-template-columns: auto auto 1fr auto; gap: 6px; align-items: center; text-align: left; padding: 5px 8px; border-radius: 8px; border: 1px solid transparent; background: rgba(255,255,255,.03); color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
.fw-item:hover, .fw-item.on { border-color: rgba(96,165,250,.45); }
.fw-item-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
.fw-item-d { color: var(--color-text-muted); font-size: 10px; }
.fw-dot { width: 8px; height: 8px; border-radius: 50%; }
#fw-view .fw { margin-top: 6px; }`;
document.head.appendChild(style);

$('fw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = videoIdOf($('fw-url').value.trim());
  if (!id) {
    $('fw-status').textContent = '';
    $('fw-status').appendChild(V.status('Paste a YouTube video or Shorts link.', true));
    return;
  }
  $('fw-url').value = '';
  if (checks[id]) {
    shown = id;
    draw();
  } else void run(id);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.firewall) {
    checks = (changes.firewall.newValue || {}).checks || {};
    draw();
  }
});
void load();
