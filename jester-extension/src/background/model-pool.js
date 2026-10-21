/** Rotate saved connections only after a provider rate limit; never replay page actions. */
import { loadConnections, coolDownConnection, PROVIDERS } from '../common/credentials.js';
import { requestModel, normalizeModelConfig, MODEL_REQUEST_LIMITS, ModelTimeoutError, abortableDelay, supportsImages } from './model-client.js';
import { createRateGovernor, estimateTokens, usageInputTokens } from './rate-governor.js';

/** Longest a request waits for a per-minute window; past this the task pauses with a countdown. */
export const MAX_PACE_MS = 20000;
/** A request may use this share of a tokens-per-minute ceiling, so a task keeps moving within one. */
const REQUESTS_PER_MINUTE_TARGET = 4;
const providerLabel = (connection) => PROVIDERS[connection.provider]?.label || connection.provider;

export function nextModelCooldown(connections, now = Date.now()) {
  if (!connections.length || connections.some(connection => !(connection.cooldownUntil > now))) return null;
  const next = connections.reduce((first, connection) => connection.cooldownUntil < first.cooldownUntil ? connection : first);
  return { allLimited: true, readyAt: next.cooldownUntil, model: next.model,
    provider: PROVIDERS[next.provider]?.label || next.provider };
}

export class AllModelsRateLimitedError extends Error {
  constructor(cooldown, now = Date.now()) {
    const seconds = Math.max(1, Math.ceil((cooldown.readyAt - now) / 1000));
    super(`All saved models are rate-limited. Next retry: ${cooldown.provider} · ${cooldown.model} in ${seconds} seconds.`);
    this.name = 'AllModelsRateLimitedError';
    this.code = 'all_models_rate_limited';
    this.cooldown = cooldown;
    this.retryAfterMs = Math.max(0, cooldown.readyAt - now);
    this.retryable = true;
  }
}

const abortError = () => Object.assign(new Error('cancelled'), {name:'AbortError'});
const aborted = (signal) => {
  if (signal?.aborted) throw signal.reason?.code === 'model_timeout' ? signal.reason : abortError();
};
/** Settles with `promise`, or rejects the moment `signal` aborts — a stalled storage read included. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  let onAbort;
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, stop]).finally(() => signal.removeEventListener('abort', onAbort));
}

export function createPooledModelClient({
  load = loadConnections, markLimited = coolDownConnection, request = requestModel,
  now = Date.now, clock = () => performance.now(), onSelected, onLimited, onUnavailable,
  governor = createRateGovernor({ now }), onPacing, maxPaceMs = MAX_PACE_MS, delay = abortableDelay
} = {}) {
  // A screenshot goes only to a model that can read one.
  const fits = (options) => (connection) => !options?.images?.length || supportsImages(connection);
  const open = async (options) => (await load()).filter(connection => !(connection.cooldownUntil > now()) && fits(options)(connection));
  /** The soonest a pacing wait ends among these connections, as a cooldown. */
  async function pacedCooldown(connections, estimate) {
    if (!connections.length) return null;
    const waits = await Promise.all(connections.map(connection => governor.waitMs(connection, estimate)));
    const shortest = Math.min(...waits);
    const next = connections[waits.indexOf(shortest)];
    return { allLimited: true, readyAt: now()+shortest, model: next.model, provider: providerLabel(next), waitMs: shortest };
  }
  /**
   * Waits out a per-minute window before the request's own time budget starts:
   * a few seconds now costs less than a provider rate-limit error and a paused task.
   */
  async function pace(estimate, options) {
    const signal = options.signal;
    const cooldown = await pacedCooldown(await open(options), estimate);
    if (!(cooldown?.waitMs > 0)) return;
    if (cooldown.waitMs > maxPaceMs) {
      await onUnavailable?.(cooldown, signal);
      throw new AllModelsRateLimitedError(cooldown, now());
    }
    await onPacing?.(cooldown, signal);
    await delay(cooldown.waitMs, signal);
  }

  async function pooledModelRequest(options) {
    aborted(options.signal);
    const estimate = estimateTokens(options);
    await untilAborted(pace(estimate, options), options.signal);
    aborted(options.signal);
    const startedAt = clock();
    const budget = Math.min(MODEL_REQUEST_LIMITS.maxElapsedMs,
      Math.max(1, Number.isFinite(options.maxElapsedMs) ? options.maxElapsedMs : MODEL_REQUEST_LIMITS.maxElapsedMs));
    const tried = new Set();
    const operation = new AbortController();
    const signal = operation.signal;
    const onAbort = () => operation.abort(abortError());
    options.signal?.addEventListener('abort',onAbort,{once:true});
    const timer = setTimeout(()=>operation.abort(new ModelTimeoutError()),budget);
    let rejectInterrupted;
    const interrupted = new Promise((_,reject)=>{
      rejectInterrupted = () => reject(signal.reason || abortError());
      signal.addEventListener('abort',rejectInterrupted,{once:true});
    });
    const totals = {requestMs:0,retryWaitMs:0,attempts:0};
    let requestStartedAt = null;
    const aggregate = (timings) => {
      totals.requestMs += Number.isFinite(timings?.requestMs) && timings.requestMs >= 0
        ? timings.requestMs : clock()-requestStartedAt;
      if (Number.isFinite(timings?.retryWaitMs) && timings.retryWaitMs >= 0) totals.retryWaitMs += timings.retryWaitMs;
      requestStartedAt = null;
    };
    const timings = (last = {}) => ({...last,...totals,
      requestMs:Math.round(totals.requestMs+(requestStartedAt === null ? 0 : clock()-requestStartedAt)),
      totalMs:Math.round(clock()-startedAt)});
    const run = async () => {
      while (true) {
        aborted(signal);
        const connections = await load();
        aborted(signal);
        if (!connections.length) throw Object.assign(new Error('Connect a model in Settings before continuing.'), {code:'model_pool_empty'});
        if (!connections.some(fits(options))) throw Object.assign(new Error(
          'None of your saved models can read screenshots. Add one that can, such as Gemini, in Settings.'), {code:'no_vision_model'});
        const candidates = connections.filter(connection => !tried.has(connection.id) && !(connection.cooldownUntil > now()) && fits(options)(connection));
        let selected = null;
        for (const connection of candidates) {
          if (!(await governor.waitMs(connection, estimate))) { selected = connection; break; }
        }
        if (!selected) {
          // Every attempted connection is visited at most once in this request.
          // A very short cooldown may already have expired while another ran.
          const cooldown = nextModelCooldown(connections.filter(fits(options)), now()) || await pacedCooldown(candidates, estimate);
          await onUnavailable?.(cooldown,signal);
          aborted(signal);
          if (!cooldown) throw Object.assign(new Error(
            'Every model tried in this turn was rate-limited. A saved model can be retried now.'
          ), {code:'model_pool_retry_ready',retryAfterMs:0,retryable:true});
          throw new AllModelsRateLimitedError(cooldown, now());
        }
        const remaining = budget-(clock()-startedAt);
        if (remaining <= 0) throw new ModelTimeoutError();
        tried.add(selected.id);
        const config = normalizeModelConfig(selected);
        await onSelected?.({id:selected.id,provider:selected.provider,model:selected.model},signal);
        aborted(signal);
        const requestBudget = budget-(clock()-startedAt);
        if (requestBudget <= 0) throw new ModelTimeoutError();
        totals.attempts++;
        requestStartedAt = clock();
        try {
          const result = await request({...options,signal,config,maxElapsedMs:requestBudget,
            timeoutMs:Math.min(requestBudget,options.timeoutMs || requestBudget),maxRetries:0,maxRetryWaitMs:0});
          aggregate(result.timings);
          aborted(signal);
          await governor.record(selected, { inputTokens: usageInputTokens(result.usage) ?? estimate, rateLimits: result.rateLimits });
          return {...result,connectionId:selected.id,provider:selected.provider,timings:timings(result.timings)};
        } catch (error) {
          if (requestStartedAt !== null) aggregate(error.timings);
          aborted(signal);
          if (error?.code !== 'rate_limit' || error?.status !== 429) throw error;
          await governor.record(selected, { inputTokens: estimate, rateLimits: error.rateLimits });
          const providerDelay = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0
            ? error.retryAfterMs : error.retryable === false ? 24*60*60*1000 : 60000;
          const readyAt = now()+Math.max(1000,providerDelay);
          await markLimited(selected.id,readyAt);
          aborted(signal);
          await onLimited?.({id:selected.id,provider:selected.provider,model:selected.model,readyAt});
        }
      }
    };
    try {
      return await Promise.race([run(),interrupted]);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.timings = timings();
      throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',onAbort);
      signal.removeEventListener('abort',rejectInterrupted);
    }
  }
  /** Input tokens the next request should stay under, or null when no ceiling is known. */
  pooledModelRequest.promptBudget = async () => {
    const [first] = await open();
    const tpm = first ? await governor.tokensPerMinute(first) : null;
    return tpm ? Math.floor(tpm / REQUESTS_PER_MINUTE_TARGET) : null;
  };
  return pooledModelRequest;
}
