// popup/insights.js
// The "AI Insights & Daily Sync" section: a day's useful vs entertainment split, Shorts, topics,
// how interests shift, and the daily sync's settings and log. All data comes from the service
// worker (it owns storage); nothing here writes storage directly.

const C = globalThis.YTCore;
const esc = C.esc;

/** A small badge after a title: 🎓 useful / 🍿 entertainment (with the AI's reason as a tooltip). */
export function labelBadge(label) {
  if (!label) return '';
  const useful = label.category === 'useful';
  const tip = [useful ? 'Useful' : 'Entertainment', label.why, (label.topics || []).join(', ')].filter(Boolean).join(' · ');
  return ` <span class="ai-badge ${useful ? 'useful' : 'fun'}" title="${esc(tip)}">${useful ? '🎓' : '🍿'}</span>`;
}

const send = (msg) =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.success) return reject(new Error(r ? r.error : 'No answer'));
      resolve(r);
    }),
  );

const $ = (id) => document.getElementById(id);
let state = null;
let shownDay = C.localDay(Date.now());
let onChangedCb = () => {};

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

function sourceLine(name, r) {
  if (!r) return `${name}: off`;
  if (r.error) return `${name}: ${r.error}`;
  return `${name}: ${r.watches} watch${r.watches === 1 ? '' : 'es'}${r.pages ? ` (${r.pages} page${r.pages === 1 ? '' : 's'})` : ''}`;
}

function renderDay() {
  const box = $('ai-day');
  if (!box || !state) return;
  const digests = state.digests || {};
  const d = digests[shownDay];
  $('ai-day-label').textContent = shownDay === C.localDay(Date.now()) ? 'Today' : new Date(C.dayBounds(shownDay).start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('ai-next-day').disabled = shownDay >= C.localDay(Date.now());
  if (!d) {
    box.innerHTML = `<p class="ai-muted">No digest for this day yet. It's made by the daily sync (or ⟳ Sync now).</p>`;
    return;
  }
  const labelled = d.useful + d.distraction;
  const pct = labelled ? Math.round((d.useful / labelled) * 100) : 0;
  const topics = Object.entries(d.topics || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const shift = d.shift || null;
  const chips = (rows, cls) => rows.map((r) => `<span class="ai-chip ${cls}">${esc(r.topic)}</span>`).join('');
  box.innerHTML = `
    <div class="ai-stats">
      <div><b>${d.watches}</b><span>watched</span></div>
      <div><b>${d.useful}</b><span>🎓 useful</span></div>
      <div><b>${d.distraction}</b><span>🍿 entertainment</span></div>
      <div><b>${d.shorts}</b><span>Shorts</span></div>
    </div>
    <div class="ai-split" title="${pct}% of labelled watches were useful">
      <i style="width:${pct}%"></i>
    </div>
    <p class="ai-muted">${labelled ? `${pct}% useful` : 'Nothing labelled yet'}${d.unlabelled ? ` · ${d.unlabelled} not labelled yet` : ''}</p>
    ${topics.length ? `<div class="ai-chips">${topics.map(([t, n]) => `<span class="ai-chip">${esc(t)} <small>${n}</small></span>`).join('')}</div>` : ''}
    ${d.note && d.note.summary ? `<p class="ai-note">${esc(d.note.summary)}</p>` : ''}
    ${shift && (shift.rising.length || shift.fading.length) ? `
      <div class="ai-shift">
        ${shift.rising.length ? `<div><span class="ai-muted">Rising</span> ${chips(shift.rising, 'up')}</div>` : ''}
        ${shift.fading.length ? `<div><span class="ai-muted">Fading</span> ${chips(shift.fading, 'down')}</div>` : ''}
      </div>` : ''}
  `;
}

function renderSync() {
  if (!state) return;
  const s = state.settings || {};
  $('ai-daily-on').checked = !!s.dailySync;
  $('ai-daily-time').value = s.dailyTime || '23:30';
  $('ai-src-chrome').checked = !!s.useChromeHistory;
  $('ai-src-account').checked = !!s.useAccountHistory;
  $('ai-on').checked = !!s.aiEnabled;
  $('ai-provider').value = s.aiProvider || 'auto';
  $('ai-local-model').value = s.localModel || 'llama3.2';
  $('ai-key').placeholder = s.hasGeminiKey ? 'Saved (type to replace)' : 'Gemini API key (aistudio.google.com)';
  $('ai-journal').checked = !!s.journalDigest;
  const last = (state.syncLog || [])[0];
  const lines = [];
  if (state.nextRun) lines.push(`Next run: ${new Date(state.nextRun).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
  if (last) {
    lines.push(`Last run ${ago(last.at)} (${last.reason}): ${last.added} added${last.replaced ? `, ${last.replaced} got real times` : ''}${last.labelled ? `, ${last.labelled} labelled` : ''}`);
    lines.push(sourceLine('This Mac\'s Chrome', last.chrome));
    lines.push(sourceLine('YouTube account (phone and other devices)', last.account));
    for (const e of last.errors || []) lines.push(`⚠ ${e}`);
  }
  if (state.lastRepair && state.lastRepair.removed) lines.push(`Old duplicates folded together once: ${state.lastRepair.removed} (a backup copy was kept)`);
  const j = state.journalPush;
  if (j && j.at) lines.push(j.error ? `Dynamic Journal: not reached (${j.error}). Turn on its MCP server in Settings → AI.` : `Dynamic Journal: digests sent ${ago(j.at)}`);
  $('ai-sync-log').innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
}

async function refresh() {
  try {
    state = await send({ action: 'getDailyState' });
  } catch (e) {
    $('ai-sync-log').textContent = `Couldn't read the sync state: ${e.message}`;
    return;
  }
  renderDay();
  renderSync();
}

async function saveSetting(patch) {
  try {
    await send({ action: 'saveDailySettings', patch });
    await refresh();
  } catch (e) {
    $('ai-sync-log').textContent = `Couldn't save: ${e.message}`;
  }
}

async function busy(button, label, work) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await work();
  } catch (e) {
    $('ai-sync-log').insertAdjacentHTML('afterbegin', `<div>⚠ ${esc(e.message)}</div>`);
  } finally {
    button.disabled = false;
    button.textContent = before;
  }
}

export function initInsights({ onChanged } = {}) {
  if (!$('ai-insights')) return;
  onChangedCb = onChanged || onChangedCb;
  $('ai-prev-day').addEventListener('click', () => {
    shownDay = C.addDays(shownDay, -1);
    renderDay();
  });
  $('ai-next-day').addEventListener('click', () => {
    if (shownDay < C.localDay(Date.now())) shownDay = C.addDays(shownDay, 1);
    renderDay();
  });
  $('ai-sync-now').addEventListener('click', (e) =>
    busy(e.currentTarget, 'Syncing…', async () => {
      await send({ action: 'runDailySync' });
      await refresh();
      onChangedCb();
    }),
  );
  $('ai-label-old').addEventListener('click', (e) =>
    busy(e.currentTarget, 'Labelling…', async () => {
      const r = await send({ action: 'labelBacklog', cap: 200 });
      $('ai-sync-log').insertAdjacentHTML('afterbegin', `<div>Labelled ${r.labelled} older videos</div>`);
      onChangedCb();
    }),
  );
  $('ai-test').addEventListener('click', (e) =>
    busy(e.currentTarget, 'Testing…', async () => {
      const key = $('ai-key').value.trim();
      if (key) {
        await send({ action: 'saveDailySettings', patch: { geminiKey: key } });
        $('ai-key').value = '';
      }
      const r = await send({ action: 'testAi' });
      $('ai-sync-log').insertAdjacentHTML('afterbegin', `<div>✓ AI answered (${esc(r.model)})</div>`);
      await refresh();
    }),
  );
  $('ai-settings-toggle').addEventListener('click', () => $('ai-settings').classList.toggle('hidden'));
  $('ai-daily-on').addEventListener('change', (e) => saveSetting({ dailySync: e.target.checked }));
  $('ai-daily-time').addEventListener('change', (e) => saveSetting({ dailyTime: e.target.value || '23:30' }));
  $('ai-src-chrome').addEventListener('change', (e) => saveSetting({ useChromeHistory: e.target.checked }));
  $('ai-src-account').addEventListener('change', (e) => saveSetting({ useAccountHistory: e.target.checked }));
  $('ai-on').addEventListener('change', (e) => saveSetting({ aiEnabled: e.target.checked }));
  $('ai-provider').addEventListener('change', (e) => saveSetting({ aiProvider: e.target.value }));
  $('ai-local-model').addEventListener('change', (e) => saveSetting({ localModel: e.target.value.trim() || 'llama3.2' }));
  $('ai-journal').addEventListener('change', (e) => saveSetting({ journalDigest: e.target.checked }));
  $('ai-key').addEventListener('change', (e) => {
    const key = e.target.value.trim();
    if (!key) return;
    e.target.value = '';
    void saveSetting({ geminiKey: key });
  });
  $('ai-key-clear').addEventListener('click', () => saveSetting({ geminiKey: null }));
  void refresh();
}
