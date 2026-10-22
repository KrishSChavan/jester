/** Provider adapters. Each request uses exactly the model selected in Settings. */
import { DEFAULT_AI_MODEL } from '../common/env.js';
import { AGENT_RESPONSE_SCHEMA } from '../common/agent-response-schema.js';

const DEFAULTS = {
  openai: ['openai-responses', 'https://api.openai.com/v1'],
  anthropic: ['anthropic', 'https://api.anthropic.com/v1'],
  google: ['gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  groq: ['openai-compatible', 'https://api.groq.com/openai/v1'],
  custom: ['openai-compatible', '']
};
const ALIASES = { claude: 'anthropic', gemini: 'google', chatgpt: 'openai' };
const PROTOCOL_ALIASES = { responses: 'openai-responses', 'chat-completions': 'openai-compatible',
  'openai-chat': 'openai-compatible', messages: 'anthropic', generateContent: 'gemini' };
const MAX_BODY_CHARS = 65536;
export const MODEL_REQUEST_LIMITS = Object.freeze({ maxElapsedMs: 10000, maxRetryWaitMs: 1000,
  maxRetries: 1, maxOutputTokens: 600 });
const GROQ_GPT_OSS_MODELS = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
/** Room for a Claude model's thinking, on top of the reply's own output budget. */
const CLAUDE_THINKING_TOKENS = 1500;
const PROVIDER_NAMES = { google: 'Gemini', anthropic: 'Claude', openai: 'OpenAI', groq: 'Groq' };
const limits = { tokens: 0, remaining: 0 };
export const rateLimits = () => ({ ...limits });
// Kept for older worker diagnostics. There is deliberately no fallback model ladder.
export const spentModels = () => [];

export function normalizeModelConfig(env = {}) {
  const requestedProvider = String(env.provider || 'groq').toLowerCase();
  const provider = ALIASES[requestedProvider] || requestedProvider;
  const defaults = DEFAULTS[provider];
  if (!defaults) throw new Error('Choose a supported provider or a custom API endpoint in Settings.');
  const requestedProtocol = env.protocol || defaults[0];
  const protocol = PROTOCOL_ALIASES[requestedProtocol] || requestedProtocol;
  if (!['openai-responses', 'openai-compatible', 'anthropic', 'gemini'].includes(protocol)) {
    throw new Error('Unsupported model API protocol.');
  }
  const model = String(env.model || env.aiModel || (provider === 'groq' ? DEFAULT_AI_MODEL : '')).trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Enter the exact model ID in Settings.');
  const key = String(env.key ?? env.aiKey ?? '').trim();
  let url;
  try { url = new URL(env.baseUrl || defaults[1]); } catch { throw new Error('Enter a valid model API URL in Settings.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS API URL, or HTTP for a model on localhost.');
  }
  if (!key && !(provider === 'custom' && local)) throw new Error('Add your model API key in Settings.');
  if (/[\r\n]/.test(key)) throw new Error('The API key contains a line break.');
  return { provider, protocol, model, key, baseUrl: url.href.replace(/\/$/, '') };
}

function endpoint(config) {
  const base = config.baseUrl.replace(/\/$/, '');
  if (config.protocol === 'gemini') {
    return `${base}/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent`;
  }
  const suffix = config.protocol === 'anthropic' ? '/messages'
    : config.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/**
 * Whether a saved model can read a screenshot. Model IDs are the only signal
 * every provider shares; an unknown one is assumed text-only, so no image is
 * ever sent where it would be refused.
 */
export function supportsImages(connection) {
  const model = String(connection?.model || '').toLowerCase();
  if (/embed|tts|whisper|guard|imagen|veo/.test(model)) return false;
  if (connection?.provider === 'google') return /gemini|gemma-3/.test(model);
  if (connection?.provider === 'anthropic') return /claude/.test(model);
  if (connection?.provider === 'openai') return /gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|o[34]-|omni/.test(model);
  if (connection?.provider === 'groq') return /llama-4|scout|maverick|vision/.test(model);
  return /vision|\bvl\b|-vl|llava|gemma-3|llama-4|pixtral|qwen.*vl/.test(model);
}

/**
 * Claude 5-generation models think before answering unless told otherwise, and
 * the thinking counts toward max_tokens: at a small cap it can use the whole
 * budget and cut the JSON reply off. Earlier models think only when asked.
 */
export function claudeThinksByDefault(model) {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)/.exec(String(model || '').toLowerCase());
  return Boolean(match) && (['fable', 'mythos'].includes(match[1]) || Number(match[2]) >= 5);
}

const dataUrl = (image) => `data:${image.mimeType};base64,${image.data}`;

/** `schema`: the reply's shape for Gemini's structured output — the browser agent's unless
 * a caller with other actions (Jester Desktop) passes its own. */
export function buildModelRequest(config, { system, prompt, images = [], maxOutputTokens = MODEL_REQUEST_LIMITS.maxOutputTokens,
  schema = AGENT_RESPONSE_SCHEMA }) {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192) {
    throw new Error('Output token limit must be between 1 and 8192.');
  }
  const pictures = (Array.isArray(images) ? images : []).filter((image) =>
    /^image\/(?:jpeg|png|webp)$/.test(image?.mimeType) && typeof image.data === 'string' && image.data.length > 0);
  const headers = { 'content-type': 'application/json' };
  let body;
  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.key;
    headers['anthropic-version'] = '2023-06-01';
    // Required by Anthropic for intentional direct browser use with the user's key.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const thinks = claudeThinksByDefault(config.model);
    body = { model: config.model, max_tokens: maxOutputTokens + (thinks ? CLAUDE_THINKING_TOKENS : 0), system,
      messages: [{ role: 'user', content: pictures.length ? [...pictures.map((image) =>
        ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
      { type: 'text', text: prompt }] : prompt }],
      // Low effort keeps each step quick and cheap: a step picks one control, not a plan.
      ...(thinks ? { output_config: { effort: 'low' } } : {}) };
  } else if (config.protocol === 'gemini') {
    headers['x-goog-api-key'] = config.key;
    body = { systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt },
        ...pictures.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens,
        // Medium keeps numbered labels legible at a fraction of the default image cost.
        ...(pictures.length ? { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } : {}),
        ...(config.provider === 'google' && schema ? { responseJsonSchema: schema } : {}) } };
  } else if (config.protocol === 'openai-responses') {
    if (config.key) headers.authorization = `Bearer ${config.key}`;
    body = { model: config.model, instructions: system,
      input: pictures.length ? [{ role: 'user', content: [{ type: 'input_text', text: prompt },
        ...pictures.map((image) => ({ type: 'input_image', image_url: dataUrl(image) }))] }] : prompt,
      max_output_tokens: maxOutputTokens, store: false, text: { format: { type: 'json_object' } } };
  } else {
    if (config.key) headers.authorization = `Bearer ${config.key}`;
    body = { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user',
      content: pictures.length ? [{ type: 'text', text: prompt },
        ...pictures.map((image) => ({ type: 'image_url', image_url: { url: dataUrl(image) } }))] : prompt }],
      ...(config.provider === 'groq' ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }),
      response_format: { type: 'json_object' } };
    if (config.provider === 'groq' && GROQ_GPT_OSS_MODELS.has(config.model)) {
      // Groq GPT-OSS supports low effort + include_reasoning, not reasoning_format:
      // https://console.groq.com/docs/reasoning#options-for-reasoning-effort-gpt-oss
      // https://console.groq.com/docs/reasoning#gpt-oss-models
      body.reasoning_effort = 'low';
      body.include_reasoning = false;
    }
  }
  return { url: endpoint(config), init: { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' } };
}

/** The model answered, but not with a JSON object the host can read. */
export class ModelReplyError extends Error {
  constructor(message = 'The model did not return valid JSON.') {
    super(message);
    this.name = 'ModelReplyError';
    this.code = 'invalid_json';
    this.retryable = false;
  }
}

export function parseModelJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ModelReplyError('The model returned no text.');
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  try { return JSON.parse(text); } catch { throw new ModelReplyError(); }
}

/** Whether the provider stopped the reply at its output limit, leaving it incomplete. */
function truncated(config, data) {
  if (config.protocol === 'anthropic') return data.stop_reason === 'max_tokens';
  if (config.protocol === 'gemini') return data.candidates?.[0]?.finishReason === 'MAX_TOKENS';
  if (config.protocol === 'openai-responses') {
    return data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens';
  }
  return data.choices?.[0]?.finish_reason === 'length';
}

function extractText(config, data) {
  if (config.protocol === 'anthropic') return (data.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  if (config.protocol === 'gemini') return (data.candidates?.[0]?.content?.parts || []).filter((part) => !part.thought).map((part) => part.text || '').join('');
  if (config.protocol === 'openai-responses') {
    return (data.output || []).filter((item) => item.type === 'message').flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text').map((part) => part.text).join('') || data.output_text || '';
  }
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
}

export class ModelTimeoutError extends Error {
  constructor() {
    super('The model took too long to answer. The task is paused.');
    this.name = 'ModelTimeoutError';
    this.code = 'model_timeout';
    this.retryable = false;
  }
}

export class ModelTruncatedError extends Error {
  constructor(provider) {
    super(`${PROVIDER_NAMES[provider] || 'The model'} reached its response limit before completing an action. The task is paused.`);
    this.name = 'ModelTruncatedError';
    this.code = 'model_output_truncated';
    this.provider = provider;
    this.retryable = false;
  }
}

export class RateLimitError extends Error {
  constructor({ provider, retryAfterMs = null, daily = false }) {
    const delay = retryAfterMs === null ? '' : ` Try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds.`;
    super(daily ? `${provider} has reached its daily allowance. Resume after the allowance resets.`
      : `${provider} is rate limited.${delay}`);
    this.name = 'RateLimitError';
    this.code = 'rate_limit';
    this.status = 429;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.retryable = !daily;
  }
}

export class ProviderBusyError extends Error {
  constructor({ provider, status, retryAfterMs = null }) {
    super(`${provider} is temporarily busy. The task is paused.`);
    this.name = 'ProviderBusyError';
    this.code = 'provider_busy';
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.retryable = true;
  }
}

function abortError() { return Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
function abortReason(signal) { return signal?.reason?.code === 'model_timeout' ? signal.reason : abortError(); }
function checkAbort(signal) { if (signal?.aborted) throw abortReason(signal); }

export function abortableDelay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readBody(response, signal) {
  if (!response.body?.getReader) {
    const text = await response.text();
    checkAbort(signal);
    if (text.length > MAX_BODY_CHARS) throw new Error('The model response exceeded the size limit.');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let text = '';
  try {
    for (;;) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_BODY_CHARS) throw new Error('The model response exceeded the size limit.');
    }
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Do not await cancellation: a broken stream must not hold up the timeout.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Timeout covers both fetch headers and the entire response body. */
async function fetchBounded(request, { signal, fetchImpl, timeoutMs }) {
  checkAbort(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ModelTimeoutError()), timeoutMs);
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason || abortError());
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
      const body = await readBody(response, controller.signal);
      return { response, body };
    })(), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

function readLimits(headers) {
  const tokens = Number(headers?.get?.('x-ratelimit-limit-tokens'));
  const remaining = Number(headers?.get?.('x-ratelimit-remaining-tokens'));
  if (tokens > 0) limits.tokens = tokens;
  if (remaining >= 0 && headers?.get?.('x-ratelimit-remaining-tokens') !== null) limits.remaining = remaining;
}

function durationMs(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  let total = 0;
  let end = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi)) {
    if (value.slice(end, match.index).trim()) return null;
    total += Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 })[match[2].toLowerCase()];
    end = match.index + match[0].length;
  }
  return end && !value.slice(end).trim() && Number.isFinite(total) ? total : null;
}

/**
 * What a provider reports about its own limits: remaining requests and input
 * tokens with their refill times (Groq/OpenAI `x-ratelimit-*`, Anthropic
 * `anthropic-ratelimit-*`), and the quota a Gemini 429 names in its body. A
 * missing field means "not reported", never zero.
 */
export function readRateLimits(headers, body = '', now = Date.now()) {
  const out = {};
  const number = (name) => {
    const raw = headers?.get?.(name);
    const value = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const resetAt = (name) => {
    const raw = headers?.get?.(name)?.trim();
    if (!raw) return null;
    const relative = durationMs(raw);
    if (relative !== null) return now + relative;
    const absolute = Date.parse(raw);
    return Number.isFinite(absolute) ? absolute : null;
  };
  // Groq/OpenAI name the field first (x-ratelimit-remaining-tokens); Anthropic names the kind first.
  for (const [header, kind, as] of [[(field, kind) => `x-ratelimit-${field}-${kind}`, 'requests', 'requests'],
    [(field, kind) => `x-ratelimit-${field}-${kind}`, 'tokens', 'tokens'],
    [(field, kind) => `anthropic-ratelimit-${kind}-${field}`, 'requests', 'requests'],
    [(field, kind) => `anthropic-ratelimit-${kind}-${field}`, 'input-tokens', 'tokens']]) {
    const remaining = number(header('remaining', kind));
    if (remaining === null) continue;
    const limit = number(header('limit', kind)), reset = resetAt(header('reset', kind));
    out[as] = { remaining, ...(limit !== null ? { limit } : {}), ...(reset !== null ? { resetAt: reset } : {}) };
  }
  try {
    for (const detail of JSON.parse(body || 'null')?.error?.details || []) {
      if (!/QuotaFailure$/.test(String(detail?.['@type'] || ''))) continue;
      for (const violation of Array.isArray(detail.violations) ? detail.violations : []) {
        const id = String(violation?.quotaId || violation?.quotaMetric || '');
        const limit = Number(violation?.quotaValue);
        const window = /PerMinute/i.test(id) ? 'minute' : /PerDay/i.test(id) ? 'day' : null;
        if (!window || !(limit > 0)) continue;
        (out.quotas ||= []).push({ window, unit: /Tokens/i.test(id) ? 'tokens' : 'requests', limit });
      }
    }
  } catch { /* A body without structured quota details reports nothing. */ }
  return out;
}

/** Preserve the server's minimum delay; never clamp it down to a retry budget. */
export function parseRetryAfterMs(headers, body, now = Date.now()) {
  const candidates = [];
  const header = headers?.get?.('retry-after')?.trim();
  if (header && /^\d+(?:\.\d+)?$/.test(header)) candidates.push(Number(header) * 1000);
  else if (header && /[A-Za-z]{3}/.test(header)) {
    const at = Date.parse(header);
    if (Number.isFinite(at)) {
      candidates.push(Math.max(0, at - now));
      const serverDate = Date.parse(headers?.get?.('date'));
      const age = Number(headers?.get?.('age') || 0);
      if (Number.isFinite(serverDate) && Number.isFinite(age) && age >= 0) {
        candidates.push(Math.max(0, at - serverDate - age * 1000));
      }
    }
  }
  const millis = headers?.get?.('retry-after-ms')?.trim();
  if (millis && /^\d+(?:\.\d+)?$/.test(millis)) candidates.push(Number(millis));
  const inBody = /try again in\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\s*)+|\d+(?:\.\d+)?)/i.exec(body || '');
  const structured = /"retryDelay"\s*:\s*"([^"]+)"/i.exec(body || '');
  for (const text of [inBody?.[1], structured?.[1]]) {
    const parsed = durationMs(text);
    if (parsed !== null) candidates.push(parsed);
  }
  const usable = candidates.filter((ms) => Number.isFinite(ms) && ms >= 0);
  return usable.length ? Math.ceil(Math.max(...usable)) : null;
}

function httpError(config, status, body) {
  let detail = '';
  try { detail = JSON.parse(body)?.error?.message || ''; } catch { /* no provider detail */ }
  if (config.key) detail = String(detail).split(config.key).join('[redacted]');
  detail = String(detail).replace(/\s+/g, ' ').slice(0, 220);
  const message = status === 401 || status === 403 ? `${config.provider} rejected the API key. Check Settings.`
    : status === 404 ? `The provider could not find model "${config.model}" or its API endpoint. Check Settings.`
      : `${config.provider} returned ${status}${detail ? `: ${detail}` : ''}`;
  return Object.assign(new Error(message), { code: 'http_error', status, retryable: false });
}

export async function requestModel({ env, config = normalizeModelConfig(env), system, prompt, signal,
  fetchImpl = globalThis.fetch, timeoutMs = MODEL_REQUEST_LIMITS.maxElapsedMs,
  maxElapsedMs = MODEL_REQUEST_LIMITS.maxElapsedMs, maxRetryWaitMs = MODEL_REQUEST_LIMITS.maxRetryWaitMs,
  maxRetries = MODEL_REQUEST_LIMITS.maxRetries, maxOutputTokens = MODEL_REQUEST_LIMITS.maxOutputTokens, onRetry, images = [], schema }) {
  checkAbort(signal);
  const request = buildModelRequest(config, { system, prompt, images, maxOutputTokens, schema });
  const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const elapsedLimit = bounded(maxElapsedMs, MODEL_REQUEST_LIMITS.maxElapsedMs, 1, 60000);
  const attemptLimit = bounded(timeoutMs, elapsedLimit, 1, 60000);
  const waitLimit = bounded(maxRetryWaitMs, MODEL_REQUEST_LIMITS.maxRetryWaitMs, 0, 1000);
  const retries = Math.min(1, Math.max(0, Number.isInteger(maxRetries) ? maxRetries : 1));
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = clock();
  const operation = new AbortController();
  const onAbort = () => operation.abort(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => operation.abort(new ModelTimeoutError()), elapsedLimit);
  let attempts = 0;
  let requestMs = 0;
  let retryWaitMs = 0;
  let reservedWaitMs = 0;
  let requestStartedAt = null;
  let waitStartedAt = null;
  const timings = (usage = null) => {
    const metrics = { requestMs: Math.round(requestMs + (requestStartedAt === null ? 0 : clock() - requestStartedAt)),
      retryWaitMs: Math.round(retryWaitMs + (waitStartedAt === null ? 0 : clock() - waitStartedAt)),
      attempts, totalMs: Math.round(clock() - startedAt) };
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount;
    if (Number.isFinite(inputTokens) && inputTokens >= 0) metrics.inputTokens = inputTokens;
    if (Number.isFinite(outputTokens) && outputTokens >= 0) metrics.outputTokens = outputTokens;
    return metrics;
  };
  let rejectAbort;
  const interrupted = new Promise((_, reject) => {
    rejectAbort = () => reject(operation.signal.reason || abortError());
    operation.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const run = async () => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      checkAbort(operation.signal);
      const remainingMs = elapsedLimit - (clock() - startedAt);
      if (remainingMs <= 0) throw new ModelTimeoutError();
      let response;
      let body;
      attempts += 1;
      requestStartedAt = clock();
      try {
        ({ response, body } = await fetchBounded(request, { signal: operation.signal, fetchImpl,
          timeoutMs: Math.min(attemptLimit, remainingMs) }));
      } finally {
        requestMs += clock() - requestStartedAt;
        requestStartedAt = null;
      }
      checkAbort(operation.signal);
      readLimits(response.headers);
      if (!response.ok) {
        if (![429, 502, 503].includes(response.status)) throw httpError(config, response.status, body);
        const daily = response.status === 429 && /per day|\bRPD\b|\bTPD\b/i.test(body);
        const retryAfterMs = parseRetryAfterMs(response.headers, body);
        const error = response.status === 429 ? new RateLimitError({ provider: config.provider, retryAfterMs, daily })
          : new ProviderBusyError({ provider: config.provider, status: response.status, retryAfterMs });
        error.rateLimits = readRateLimits(response.headers, body);
        const delayMs = Math.max(25, retryAfterMs ?? 250);
        const remaining = elapsedLimit - (clock() - startedAt);
        // A short interactive retry is useful. Longer cooldowns pause once,
        // preserving the actual delay for the UI instead of polling too early.
        if (daily || attempt >= retries || reservedWaitMs + delayMs > waitLimit || delayMs >= remaining) throw error;
        await onRetry?.({ attempt: attempt + 1, nextAttempt: attempt + 2, delayMs, status: response.status,
          provider: config.provider, reason: response.status === 429 ? 'rate_limited' : 'provider_busy' });
        checkAbort(operation.signal);
        if (delayMs >= elapsedLimit - (clock() - startedAt)) throw error;
        reservedWaitMs += delayMs;
        waitStartedAt = clock();
        try { await abortableDelay(delayMs, operation.signal); }
        finally { retryWaitMs += clock() - waitStartedAt; waitStartedAt = null; }
        continue;
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new Error('The provider returned an invalid JSON response.'); }
      if (truncated(config, data)) throw new ModelTruncatedError(config.provider);
      if (config.protocol === 'anthropic' && data.stop_reason === 'refusal') {
        throw Object.assign(new Error('Claude declined this step. The task is paused.'),
          { code: 'model_refusal', retryable: false });
      }
      const raw = extractText(config, data);
      const usage = data.usage || data.usageMetadata || null;
      return { json: parseModelJson(raw), model: config.model, usage, responseChars: raw.length, timings: timings(usage),
        rateLimits: readRateLimits(response.headers) };
    }
    throw new Error('The model request could not be completed.');
  };
  try {
    return await Promise.race([run(), interrupted]);
  } catch (error) {
    const failure = signal?.aborted ? abortError() : error instanceof Error ? error : new Error(String(error));
    failure.timings = timings();
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    operation.signal.removeEventListener('abort', rejectAbort);
  }
}
