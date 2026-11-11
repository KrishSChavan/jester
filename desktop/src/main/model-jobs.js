/**
 * Which of the user's models does what (Settings › Models): talking with them,
 * and actions, which work their apps. A saved model does the jobs ticked for
 * it, tried in the order saved and paced to its plan as in the extension
 * (model-pool.js). This computer's own model (Ollama) does a job it's ticked
 * for when none of the saved ones can: none is set for it, or all of them are
 * out of requests for longer than is worth waiting. A free plan's per-minute
 * window is still waited out: a few seconds cost less than loading 8 GB of
 * local model into a full Mac. A request with a picture goes only to models
 * that read pictures, this computer's included.
 */

import { createPooledModelClient } from '../../../jester-extension/src/background/model-pool.js';
import { requestModel, supportsImages } from '../../../jester-extension/src/background/model-client.js';
import { loadConnections, normaliseConnection } from '../../../jester-extension/src/common/credentials.js';

/** This computer's model does both, unless Settings says otherwise. */
export const LOCAL_USES = Object.freeze(['talk', 'act']);
/** The saved models have given up for now, rather than failed. */
const UNAVAILABLE = new Set(['all_models_rate_limited', 'model_pool_retry_ready']);

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
 * @param {object} [deps.hooks]  model-pool.js's onSelected, onLimited, onPacing
 * @returns {Function & {ready:() => Promise<boolean>, canSee:() => Promise<boolean>, savedOnes:() => Promise<object[]>, localOne:() => Promise<object|null>, promptBudget:() => Promise<number|null>}}
 *   a request, as model-pool.js's pooled client takes it
 */
export function createModelJob({ job, local, keepAlive, saved = loadConnections, request = requestModel, log = () => undefined, ...hooks }) {
  const savedOnes = async () => (await saved()).filter((connection) => connection.uses?.includes(job));
  const localOne = async () => {
    const { model, uses, vision } = await local();
    if (!model || !uses.includes(job)) return null;
    return { id: 'ollama-local', ...normaliseConnection({ provider: 'ollama', model }), ...(typeof vision === 'boolean' ? { vision } : {}), keepAlive, cooldownUntil: 0 };
  };
  const savedPool = createPooledModelClient({ load: savedOnes, request, ...hooks });
  const localPool = createPooledModelClient({ load: async () => [await localOne()].filter(Boolean), request, ...hooks });

  async function ask(options) {
    const picture = options.images?.length > 0;
    // With a picture, only the models that read one count: this computer's takes it when none of the saved ones can.
    const fit = (connection) => !!connection && (!picture || supportsImages(connection));
    const localFits = async () => fit(await localOne());
    if ((await savedOnes()).some(fit)) {
      try {
        return await savedPool(options);
      } catch (err) {
        if (!UNAVAILABLE.has(err?.code) || options.signal?.aborted || !(await localFits())) throw err;
        log(`${job === 'talk' ? 'talking' : 'actions'}: the saved models are out for now (${err.message}), so this computer’s takes it`);
      }
    }
    if (!(await localFits())) {
      if (picture && ((await savedOnes()).length || (await localOne()))) throw Object.assign(new Error('None of your models for actions can read pictures.'), { code: 'no_vision_model' });
      throw Object.assign(new Error(noModel(job, (await local()).uses.includes(job))), { code: 'model_pool_empty' });
    }
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
