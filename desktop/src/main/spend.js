/**
 * What the user's paid models have cost this month, as near as Jester can
 * tell: each reply's own token counts, at its model's listed price. Settings ›
 * Models shows it beside the model, so "Claude for everything" (the user,
 * 2026-11-14, with $100 of credits) has a figure to go with it. It's an
 * estimate: the provider's bill is the bill, and what's left of a balance isn't
 * something an API key can ask.
 *
 * Only models with a price here are counted in dollars; the rest (a free plan,
 * a custom API) are counted in requests and tokens alone.
 *
 * Kept in the app's storage under `modelSpend`: this month and the last, by
 * "provider model". No key, prompt or reply is in it.
 */

/**
 * Dollars per million tokens: [input, output, cache read]. Anthropic's list prices, 2026-11-03 (the claude-api
 * skill's table). A cache write costs 1.25× input. A cache read is the listed price where that table gives one
 * (Fable 5.2, Opus 5.5, Sonnet 5.5) and a tenth of input elsewhere. Claude Haiku 5.5's are for prompts up to 100K
 * tokens, which Jester's are.
 */
export const PRICES = Object.freeze({
  anthropic: Object.freeze({
    'claude-fable-5-2': [8, 40, 0.2],
    'claude-fable-5-1': [10, 50, 1],
    'claude-fable-5': [10, 50, 1],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-opus-5': [5, 25, 0.5],
    'claude-opus-4-8': [5, 25, 0.5],
    'claude-opus-4-7': [5, 25, 0.5],
    'claude-opus-4-6': [5, 25, 0.5],
    'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-sonnet-5': [2, 10, 0.2],
    'claude-sonnet-4-6': [3, 15, 0.3],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
    'claude-haiku-4-5': [1, 5, 0.1]
  })
});
const CACHE_WRITE = 1.25;
export const SPEND_KEY = 'modelSpend';
/** Written at most this often: a task is a request every second or two. */
const SAVE_MS = 5000;

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * A reply's tokens, however its provider counts them: Anthropic's input leaves out what was cached, OpenAI's and
 * Gemini's are all of it.
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}}
 */
export function tokensOf(usage) {
  return {
    input: count(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount),
    output: count(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens)
  };
}

/** What a reply cost in dollars, or null for a model with no price here. */
export function costOf({ provider, model, usage }) {
  const price = PRICES[provider]?.[model];
  if (!price) return null;
  const tokens = tokensOf(usage);
  return (tokens.input * price[0] + tokens.cacheWrite * price[0] * CACHE_WRITE + tokens.cacheRead * price[2] + tokens.output * price[1]) / 1e6;
}

const monthOf = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage  chrome.storage-shaped
 * @param {() => number} [deps.now]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {number} [deps.saveMs]
 */
export function createSpend({ storage, now = Date.now, log = () => undefined, saveMs = SAVE_MS }) {
  /** { [month]: { [name]: {usd, priced, requests, input, output, cached} } } */
  let months = {};
  let loaded = null;
  let timer = null;

  const load = () =>
    (loaded ||= Promise.resolve(storage.get(SPEND_KEY))
      .then((stored) => {
        const kept = stored?.[SPEND_KEY];
        if (kept && typeof kept === 'object' && !Array.isArray(kept)) months = { ...kept, ...months };
      })
      .catch((err) => log('spend: couldn’t read what was kept:', err.message)));

  async function save() {
    timer = null;
    // This month and the last: the rest is history nobody's shown.
    const keep = Object.keys(months).sort().slice(-2);
    months = Object.fromEntries(keep.map((month) => [month, months[month]]));
    await Promise.resolve(storage.set({ [SPEND_KEY]: months })).catch((err) => log('spend: couldn’t keep it:', err.message));
  }

  return {
    /** A saved model answered. Counted at once; written soon after. */
    async record({ provider, model, usage }) {
      await load();
      const month = (months[monthOf(now())] ||= {});
      const entry = (month[`${provider} ${model}`] ||= { usd: 0, priced: false, requests: 0, input: 0, output: 0, cached: 0 });
      const tokens = tokensOf(usage);
      const usd = costOf({ provider, model, usage });
      entry.requests += 1;
      entry.input += tokens.input + tokens.cacheWrite;
      entry.cached += tokens.cacheRead;
      entry.output += tokens.output;
      if (usd !== null) {
        entry.usd += usd;
        entry.priced = true;
      }
      if (!timer && saveMs >= 0) timer = setTimeout(() => save(), saveMs);
    },

    /**
     * This month's figures for a model, or null when it hasn't answered this month.
     * @returns {Promise<{usd:number|null, requests:number, input:number, output:number, cached:number}|null>}  usd null: no price known
     */
    async of({ provider, model }) {
      await load();
      const entry = months[monthOf(now())]?.[`${provider} ${model}`];
      return entry ? { usd: entry.priced ? entry.usd : null, requests: entry.requests, input: entry.input, output: entry.output, cached: entry.cached } : null;
    },

    /** Writes what's waiting, now: before the app quits. */
    async flush() {
      if (!timer) return;
      clearTimeout(timer);
      await save();
    }
  };
}

/** A figure for a line of small print: "$0.04", "under 1¢", "$12.30". */
export function dollars(usd) {
  if (!(usd > 0)) return '$0.00';
  if (usd < 0.01) return 'under 1¢';
  return `$${usd.toFixed(2)}`;
}
