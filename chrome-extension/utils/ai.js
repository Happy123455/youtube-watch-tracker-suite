// utils/ai.js
// Sorting watched videos into useful vs entertainment, with topics, and a short note on how
// interests shift. Only titles and channel names are sent (never times, ids or your account), in
// batches, and each video is labelled once. Gemini (cheap Flash-Lite models) or the Mac's local
// model through Ollama (free, nothing leaves the Mac).

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Cheapest first; the next one is tried when one is busy, rate limited or gone. */
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest'];
export const OLLAMA = 'http://127.0.0.1:11434';
export const BATCH = 50;

export const CLASSIFY_SYSTEM =
  'You label YouTube videos a person watched, from the title and channel only. For each item give: ' +
  "category: 'useful' when it teaches, informs or helps with work, study, health, money, skills or making things " +
  '(tutorials, lectures, explainers, documentaries, serious news analysis, how-tos, talks), otherwise ' +
  "'entertainment' (comedy, memes, gaming, reactions, music videos, vlogs, drama, gossip, trailers, most Shorts). " +
  'topics: 1 to 3 short lowercase topics such as "machine learning", "cricket", "personal finance"; use the same ' +
  'wording for the same subject every time. why: at most 8 words. Keep each item\'s i exactly as given.';

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          category: { type: 'string', enum: ['useful', 'entertainment'] },
          topics: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
        },
        required: ['i', 'category', 'topics'],
      },
    },
  },
  required: ['items'],
};

export const SUMMARY_SYSTEM =
  "You describe how a person's interests are shifting, from topic counts of the YouTube videos they watched. " +
  'Answer in JSON: summary = 2 or 3 plain sentences in the second person, concrete (name the topics), no judgement; ' +
  'focus = the 3 topics they are most into right now.';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, focus: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'focus'],
};

export class AiError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

/** One Gemini call returning parsed JSON, trying the models in order. */
export async function geminiJson({ key, system, prompt, schema, fetchImpl = fetch, models = GEMINI_MODELS, timeoutMs = 45000 }) {
  if (!key) throw new AiError('No Gemini API key set', false);
  let last = null;
  for (const model of models) {
    let res;
    try {
      res = await fetchImpl(`${GEMINI}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
        }),
      });
    } catch (e) {
      last = new AiError(`Gemini (${model}) didn't answer: ${e.message}`, true);
      continue;
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      // A bad key won't work on another model either.
      if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) throw new AiError('Gemini refused the API key', false);
      last = new AiError(`Gemini ${res.status} on ${model}`, false);
      continue;
    }
    if (res.status === 404 || res.status === 429 || res.status >= 500) {
      last = new AiError(`Gemini ${res.status} on ${model}`, true);
      continue;
    }
    if (!res.ok) throw new AiError(`Gemini ${res.status}`, true);
    const body = await res.json();
    const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map((p) => (p.thought ? '' : p.text || '')).join('');
    try {
      return { json: JSON.parse(text), model };
    } catch (e) {
      last = new AiError(`Unreadable answer from ${model}`, true);
    }
  }
  throw last || new AiError('No model answered', true);
}

/** The same through Ollama on this Mac (JSON shaped by the schema). */
export async function ollamaJson({ model, system, prompt, schema, fetchImpl = fetch, timeoutMs = 180000 }) {
  // (3 min: under the 5 min a service worker may wait on one request.)
  let res;
  try {
    res = await fetchImpl(`${OLLAMA}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: schema,
        keep_alive: '2m',
        options: { temperature: 0.2 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    throw new AiError(`Ollama isn't running on this Mac (${e.message})`, true);
  }
  if (!res.ok) throw new AiError(`Ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`, res.status >= 500);
  const body = await res.json();
  try {
    return { json: JSON.parse((body.message && body.message.content) || ''), model };
  } catch (e) {
    throw new AiError(`Unreadable answer from ${model}`, true);
  }
}

/** Gemini when there's a key (provider "auto" or "gemini"), else the local model. */
export function askJson(settings, req) {
  const provider = settings.aiProvider || 'auto';
  if (provider === 'local' || (provider === 'auto' && !settings.geminiKey)) {
    return ollamaJson({ ...req, model: settings.localModel || 'llama3.2' });
  }
  return geminiJson({ ...req, key: settings.geminiKey });
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Labels for videos that have none: [{videoId, title, channel}] → {videoId: {category, topics, why, at, by}}.
 * In batches; a failing batch stops the run (the rest stay unlabelled for the next run).
 * `onBatch(labels)` saves as it goes, so a long run that stops halfway keeps what it did.
 */
export async function classifyVideos(videos, settings, { fetchImpl, now = Date.now(), onBatch } = {}) {
  const labels = {};
  for (let s = 0; s < videos.length; s += BATCH) {
    const batch = videos.slice(s, s + BATCH);
    const prompt = batch.map((v, i) => `${i}. ${clip(v.title, 200)} | ${clip(v.channel, 60)}`).join('\n');
    const { json, model } = await askJson(settings, { system: CLASSIFY_SYSTEM, prompt, schema: CLASSIFY_SCHEMA, fetchImpl });
    const got = {};
    for (const it of (json && json.items) || []) {
      const v = batch[it && it.i];
      if (!v || got[v.videoId]) continue;
      const topics = (Array.isArray(it.topics) ? it.topics : []).map((t) => clip(t, 40).toLowerCase()).filter(Boolean).slice(0, 3);
      got[v.videoId] = { category: it.category === 'useful' ? 'useful' : 'entertainment', topics, why: clip(it.why, 80), at: now, by: model };
    }
    Object.assign(labels, got);
    if (onBatch) await onBatch(got);
  }
  return labels;
}

/** A short paragraph on shifting interests, from topic counts only (a few hundred tokens). */
export async function summariseInterests(settings, { recent, earlier, today, fetchImpl }) {
  const fmt = (c) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none';
  const prompt =
    `Last 7 days up to ${today.day}: ${fmt(recent)}\nThe 28 days before: ${fmt(earlier)}\n` +
    `That day: ${today.watches} watched, ${today.useful} useful, ${today.distraction} entertainment, ${today.shorts} Shorts.`;
  const { json, model } = await askJson(settings, { system: SUMMARY_SYSTEM, prompt, schema: SUMMARY_SCHEMA, fetchImpl });
  return { summary: clip(json && json.summary, 600), focus: ((json && json.focus) || []).map((f) => clip(f, 40)).slice(0, 3), by: model };
}
