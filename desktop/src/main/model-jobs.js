/**
 * Which of the user's models does what (Settings › Models): talking with them,
 * and actions, which work their apps. A saved model does the jobs ticked for
 * it, paced to its plan as in the extension (model-pool.js). Paid ones are
 * tried first, then free ones, each in the order saved: the user, 2026-11-14,
 * with $100 of Claude credits and a free Groq key, wanted Claude for everything
 * and the free models as what's left when it can't. `paidFirst` false is the
 * order saved alone.
 *
 * A saved model that fails is covered for by the next one ticked for the job,
 * and after them by this computer's own (Ollama), when it's ticked for it too
 * (2026-11-13: Groq's gpt-oss-120b answered "Oh, that class already happened"
 * with a 400, "Failed to generate JSON", which Jester said aloud). One that's
 * down (too slow, a 5xx, no network) is left alone for a minute, and one out
 * of credit for an hour, so the turns after go straight to the next rather
 * than wait on it again. Only a failure the user has to put right in Settings,
 * a key refused or a model that isn't there, is theirs to see rather than
 * covered for.
 *
 * This computer's model also does a job it's ticked for when no saved one is
 * set for it, or all of them are out of requests for longer than is worth
 * waiting. A free plan's per-minute window is still waited out: a few seconds
 * cost less than loading 8 GB of local model into a full Mac. A request with a
 * picture goes only to models that read pictures, this computer's included.
 */

import { createPooledModelClient } from '../../../jester-extension/src/background/model-pool.js';
import { requestModel, supportsImages } from '../../../jester-extension/src/background/model-client.js';
import { loadConnections, normaliseConnection } from '../../../jester-extension/src/common/credentials.js';

/** This computer's model does both, unless Settings says otherwise. */
export const LOCAL_USES = Object.freeze(['talk', 'act']);
/** The saved models have given up for now, rather than failed. */
const UNAVAILABLE = new Set(['all_models_rate_limited', 'model_pool_retry_ready']);
/** Failures only Settings puts right: the key refused, the model or its address not found (model-client.js). */
const SETTINGS_WRONG = new Set([401, 403, 404]);
const theirsToFix = (err) => err?.code === 'http_error' && SETTINGS_WRONG.has(err.status);
/** Nothing left to pay for it with: Anthropic's 402 "billing_error", or its 400 "Your credit balance is too low". */
const outOfCredit = (err) => err?.code === 'http_error' && (err.status === 402 || err.type === 'billing_error' || (err.status === 400 && /credit balance|billing/i.test(String(err.message))));
/** Not answering, whatever was asked: too slow, the provider's own trouble, or no way to reach it. */
const down = (err) => err?.code === 'model_timeout' || err?.code === 'provider_busy' || (err?.code === 'http_error' && err.status >= 500) || err instanceof TypeError;
/** How long a saved model is left alone after failing that way. */
export const REST_MS = Object.freeze({ credit: 60 * 60 * 1000, down: 60 * 1000 });
const paid = (connection) => connection.plan === 'paid';

/** What this computer's model may do, from the settings. */
export const localUses = (settings) => (Array.isArray(settings?.localModelUses) ? settings.localModelUses : LOCAL_USES);

/** What to say when a job has no model at all. */
function noModel(job, localWanted) {
  if (job === 'talk') {
    return localWanted
      ? 'I can’t reach Ollama. Open it, or choose a model for talking in Settings › Models, and I’ll be able to talk.'
      : 'None of your models is set to talk. Choose one in Jester’s Settings › Models.';
  }
  return localWanted
    ? 'Ollama isn’t running, and none of your other models does actions. Open Ollama, or add a model in Jester’s Settings › Models.'
    : 'None of your models is set for actions. Choose one in Jester’s Settings › Models.';
}

/**
 * @param {object} deps
 * @param {'talk'|'act'} deps.job
 * @param {() => Promise<{model:string, uses:string[], vision?:boolean}>} deps.local  this computer's model ('' when Ollama has none or isn't
 *   running), its jobs, and whether it reads pictures (as Ollama lists it)
 * @param {string} deps.keepAlive  how long Ollama holds it after
 * @param {() => Promise<object[]>} [deps.saved]  every saved model, keys and all (credentials.js)
 * @param {Function} [deps.request]  model-client.js's requestModel
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {() => boolean} [deps.paidFirst]  paid models before free ones (Settings › Models); false: as saved
 * @param {(failed:{id:string, provider:string, model:string, kind:'credit'|'down'|'', message:string, next:string}) => void} [deps.onFailed]
 *   a saved model failed and is being covered for; kind: why it's being left alone a while, or '' for just this once;
 *   next: who takes it, "provider model" or "this computer" or ''
 * @param {(used:{provider:string, model:string, usage:object|null}) => void} [deps.onUsed]  a saved model answered: what it cost in tokens
 * @param {() => number} [deps.now]
 * @param {object} [deps.hooks]  model-pool.js's onSelected, onLimited, onPacing
 * @returns {Function & {ready:() => Promise<boolean>, canSee:() => Promise<boolean>, savedOnes:() => Promise<object[]>, localOne:() => Promise<object|null>, promptBudget:() => Promise<number|null>}}
 *   a request, as model-pool.js's pooled client takes it
 */
export function createModelJob({ job, local, keepAlive, saved = loadConnections, request = requestModel, log = () => undefined, paidFirst = () => true, onFailed = () => undefined, onUsed = () => undefined, now = Date.now, ...hooks }) {
  const savedOnes = async () => {
    const mine = (await saved()).filter((connection) => connection.uses?.includes(job));
    // Stable: within paid and within free, the order saved.
    return paidFirst() ? [...mine.filter(paid), ...mine.filter((connection) => !paid(connection))] : mine;
  };
  const localOne = async () => {
    const { model, uses, vision } = await local();
    if (!model || !uses.includes(job)) return null;
    return { id: 'ollama-local', ...normaliseConnection({ provider: 'ollama', model }), ...(typeof vision === 'boolean' ? { vision } : {}), keepAlive, cooldownUntil: 0 };
  };
  const savedPool = createPooledModelClient({ load: savedOnes, request, ...hooks });
  const localPool = createPooledModelClient({ load: async () => [await localOne()].filter(Boolean), request, ...hooks });
  const what = job === 'talk' ? 'talking' : 'actions';
  /** Saved models left alone for now, by id: when each may be asked again. */
  const resting = new Map();

  async function ask(options) {
    const picture = options.images?.length > 0;
    // With a picture, only the models that read one count: this computer's takes it when none of the saved ones can.
    const fit = (connection) => !!connection && (!picture || supportsImages(connection));
    const localFits = async () => fit(await localOne());
    const mine = (await savedOnes()).filter(fit);
    let skip = new Set(mine.filter((connection) => resting.get(connection.id) > now()).map((connection) => connection.id));
    // With nobody else to turn to, one that's resting is asked all the same.
    if (mine.length && skip.size === mine.length && !(await localFits())) skip = new Set();
    /** The first failure: what the user's told if nobody could cover for it. */
    let failed = null;
    while (mine.some((connection) => !skip.has(connection.id))) {
      try {
        const reply = await savedPool({ ...options, skip });
        try {
          onUsed({ provider: reply.provider, model: reply.model, usage: reply.usage ?? null });
        } catch (err) {
          log(`${what}: couldn’t note what a reply cost:`, err.message);
        }
        return reply;
      } catch (err) {
        if (theirsToFix(err) || options.signal?.aborted) throw err;
        failed ||= err;
        // Out of requests for now, all of them that are left: nobody failed, and this computer's is next.
        if (UNAVAILABLE.has(err?.code) || !err?.connectionId || skip.has(err.connectionId)) break;
        skip.add(err.connectionId);
        const kind = outOfCredit(err) ? 'credit' : down(err) ? 'down' : '';
        if (kind) resting.set(err.connectionId, now() + REST_MS[kind]);
        const after = mine.find((connection) => !skip.has(connection.id));
        const next = after ? `${after.provider} ${after.model}` : (await localFits()) ? 'this computer' : '';
        log(`${what}: ${err.provider} ${err.model} failed (${err.message})${next ? `, so ${next === 'this computer' ? 'this computer’s' : next} takes it` : ''}`);
        try {
          onFailed({ id: err.connectionId, provider: err.provider, model: err.model, kind, message: err.message, next });
        } catch (hookErr) {
          log(`${what}: couldn’t say a model failed:`, hookErr.message);
        }
      }
    }
    if (!(await localFits())) {
      if (failed) throw failed;
      if (picture && ((await savedOnes()).length || (await localOne()))) throw Object.assign(new Error('None of your models for actions can read pictures.'), { code: 'no_vision_model' });
      throw Object.assign(new Error(noModel(job, (await local()).uses.includes(job))), { code: 'model_pool_empty' });
    }
    if (failed && UNAVAILABLE.has(failed.code)) log(`${what}: the saved models are out for now (${failed.message}), so this computer’s takes it`);
    return localPool(options);
  }
  ask.savedOnes = savedOnes;
  ask.localOne = localOne;
  /** Whether anything can do the job right now. */
  ask.ready = async () => (await savedOnes()).length > 0 || !!(await localOne());
  /** Whether a model for the job can read a picture. */
  ask.canSee = async () => (await savedOnes()).some(supportsImages) || supportsImages((await localOne()) || {});
  /** The saved models' per-minute budget; this computer's has none. */
  ask.promptBudget = async () => ((await savedOnes()).length ? savedPool.promptBudget() : null);
  return ask;
}
