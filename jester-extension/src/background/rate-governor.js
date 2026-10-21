/**
 * Paces model requests per saved connection, so a task waits a few seconds for a
 * per-minute window instead of tripping the provider's limit and pausing.
 *
 * What the provider reports wins: remaining requests and input tokens with their
 * refill times (Groq/OpenAI/Anthropic headers), and the quota a Gemini 429 names.
 * Until then a free-tier connection is held to conservative published limits; a
 * paid one is limited only by what its provider reports. The last minute of
 * requests lives in session storage, because the worker restarts far more often
 * than a minute passes.
 */
const WINDOW_MS = 60000;
const STORE_KEY = 'modelPacing';
/** Free-tier ceilings until the provider reports its own. AI Studio and Groq's console show a project's actual numbers. */
export const FREE_TIER_LIMITS = Object.freeze({
  google: Object.freeze({ rpm: 15, tpm: 250000 }),
  groq: Object.freeze({ rpm: 30, tpm: 6000 })
});

/** What one screenshot costs at most: Gemini 3 bills a default-resolution image at 1,120 tokens. */
export const IMAGE_TOKENS = 1120;

/** A conservative input-token estimate for a request that has not been sent. */
export function estimateTokens({ system = '', prompt = '', images = [] } = {}) {
  return Math.ceil((String(system).length + String(prompt).length) / 3.5) +
    (Array.isArray(images) ? images.length : 0) * IMAGE_TOKENS;
}

/** Actual input tokens from any provider's usage block. */
export function usageInputTokens(usage) {
  const value = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function createRateGovernor({ storage = () => globalThis.chrome?.storage?.session, now = Date.now } = {}) {
  let cache = null;

  async function state() {
    if (!cache) {
      try { cache = (await storage()?.get(STORE_KEY))?.[STORE_KEY]; } catch { cache = null; }
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    }
    return cache;
  }
  async function save() {
    try { await storage()?.set({ [STORE_KEY]: cache }); } catch { /* Pacing still works for this worker's lifetime. */ }
  }
  const entryFor = (all, id) => (all[id] ||= { events: [], reported: {}, learned: {} });
  const recent = (entry, at) => entry.events.filter(([t]) => at - t < WINDOW_MS);

  function limits(connection, entry) {
    const preset = connection.plan === 'paid' ? {} : FREE_TIER_LIMITS[connection.provider] || {};
    return { rpm: entry.learned.rpm ?? preset.rpm ?? null,
      tpm: entry.learned.tpm ?? entry.reported.tokens?.limit ?? preset.tpm ?? null };
  }

  function waitFor(connection, entry, estimate, at) {
    const { rpm, tpm } = limits(connection, entry);
    const window = recent(entry, at);
    let wait = 0;
    if (rpm && window.length >= rpm) wait = Math.max(wait, window[window.length - rpm][0] + WINDOW_MS - at);
    if (tpm) {
      let used = window.reduce((sum, [, tokens]) => sum + tokens, 0);
      if (used + estimate > tpm) {
        // The window frees as its oldest requests age out; one too big for any window waits a full minute.
        let freed = at + WINDOW_MS;
        for (const [t, tokens] of window) {
          used -= tokens;
          if (used + estimate <= tpm) { freed = t + WINDOW_MS; break; }
        }
        wait = Math.max(wait, freed - at);
      }
    }
    for (const [kind, need] of [['requests', 1], ['tokens', estimate]]) {
      const bucket = entry.reported[kind];
      if (!bucket || bucket.remaining >= need || !(bucket.resetAt > at)) continue;
      // A bucket refills steadily toward its limit by its reset time; without a limit, wait for the reset.
      const span = bucket.resetAt - bucket.at;
      const refill = bucket.limit > bucket.remaining && span > 0
        ? bucket.at + ((need - bucket.remaining) / (bucket.limit - bucket.remaining)) * span : bucket.resetAt;
      wait = Math.max(wait, Math.min(bucket.resetAt, refill) - at);
    }
    return Math.max(0, Math.ceil(wait));
  }

  return {
    /** Milliseconds to wait before this connection can take a request of `estimate` input tokens. */
    async waitMs(connection, estimate) {
      const all = await state();
      return waitFor(connection, all[connection.id] || { events: [], reported: {}, learned: {} }, estimate, now());
    },

    /** The connection's tokens-per-minute ceiling, if one is known. */
    async tokensPerMinute(connection) {
      const all = await state();
      return limits(connection, all[connection.id] || { events: [], reported: {}, learned: {} }).tpm;
    },

    /** One request sent: its input tokens, and whatever the provider reported back. */
    async record(connection, { inputTokens = 0, rateLimits = {} } = {}) {
      const all = await state();
      const at = now();
      const entry = entryFor(all, connection.id);
      entry.events = [...recent(entry, at), [at, Math.max(0, Math.round(inputTokens) || 0)]].slice(-200);
      for (const kind of ['requests', 'tokens']) {
        const bucket = rateLimits[kind];
        if (bucket && Number.isFinite(bucket.remaining)) entry.reported[kind] = { ...bucket, at };
      }
      for (const quota of Array.isArray(rateLimits.quotas) ? rateLimits.quotas : []) {
        if (quota.window === 'minute') entry.learned[quota.unit === 'tokens' ? 'tpm' : 'rpm'] = quota.limit;
      }
      // Connections that are gone keep no history.
      for (const [id, other] of Object.entries(all)) {
        if (id !== connection.id && !recent(other, at).length && !Object.keys(other.learned || {}).length) delete all[id];
      }
      await save();
    }
  };
}
