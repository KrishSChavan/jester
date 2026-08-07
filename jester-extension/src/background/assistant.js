/**
 * The assistant: what happens to a sentence after you stop talking.
 *
 * One turn of the loop is: look at the page, ask Groq what to do about it, do
 * it. Repeat until the model says it's finished, or until the run is out of
 * budget. That shape — rather than asking for the whole plan up front — is the
 * only one that survives contact with a real site, because most of what you'd
 * need to plan against doesn't exist yet when you're asked:
 *
 *   "search for suits and play season 2 episode 3"
 *
 * There is no season dropdown on the page when that sentence arrives. There
 * isn't even a search field until the search button is clicked. Each turn the
 * model sees what its last actions actually produced and picks the next ones,
 * so a page that loaded slowly, or laid out differently, or asked "are you still
 * watching?" is just the next turn rather than a plan that has silently fallen
 * apart.
 *
 * What it does *not* get is the page. It says what it wants — "the search
 * button" — and the content script goes and finds it, trying the name, then
 * part of the name, then the words in it, then what that phrase usually means
 * on a page. That keeps a turn small enough to fit inside a free key's minute,
 * and it puts the job of recognising a control where the control actually is.
 * @see findElement in src/content/content.js
 *
 * Everything that touches Chrome is passed in as `host`, so this file is the
 * part that can be reasoned about on its own: intent in, steps out.
 */

import { ACTIONS } from '../common/constants.js';
import { DEFAULT_AI_MODEL } from '../common/env.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Tried in order, and the order is the point.
 *
 * Two things send us down this list. A model Groq has retired fails outright,
 * which would otherwise look to the user like the whole feature is broken. And
 * a model that has spent its allowance for the day is done until midnight UTC
 * — but only *that* model is. Every entry here has its own separate pool, so a
 * key that has exhausted the first still has the rest of the list intact.
 *
 * They descend by tokens-per-minute and ascend by tokens-per-day, which is the
 * right shape for a ladder: start on the one with the roomiest minute, and each
 * time one runs out of day, drop to one with more day left.
 *
 *   llama-3.3-70b-versatile   12K/min   100K/day
 *   openai/gpt-oss-120b        8K/min   200K/day
 *   qwen/qwen3.6-27b           8K/min   200K/day
 *   llama-3.1-8b-instant       6K/min   500K/day
 *
 * Not `groq/compound`, despite its 70K/min looking like it settles the whole
 * problem: it is a router rather than a model, and it spends the pools of the
 * models it routes to — ask it for something while gpt-oss-120b is capped and
 * the 429 you get back names gpt-oss-120b. It also carries a system prompt of
 * its own worth about 930 tokens before yours is counted, so the roomiest
 * minute on the board buys the smallest number of turns on it.
 *
 * `AI_MODEL` in .env goes to the front of this list.
 */
const MODELS = [
  DEFAULT_AI_MODEL,
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
  'llama-3.1-8b-instant'
];

// ---------------------------------------------------------------------------
// What a run is allowed to spend
//
// A turn count alone was the wrong budget, and it was the wrong budget in the
// direction that mattered: six turns is below the floor for the sentences
// people actually say. "Search for X and play season 6 episode 3" is click
// search, type, open the title, open the season list, pick the season, pick the
// episode — six turns of perfect play, with nothing loading slowly and nothing
// asking whether you are still watching. It could not have finished.
//
// So the ceiling is high enough to be reachable, and the things that actually
// stop a run are the ones worth stopping on: the user's patience, and the model
// going in circles. A run that is getting somewhere gets to keep going; a run
// that has made no progress in three turns is not going to make any in a
// fourth.
// ---------------------------------------------------------------------------

/** A runaway guard, not the budget. The two below are what normally stops a run. */
const MAX_TURNS = 14;
/** Roughly how long someone will wait after speaking before it stops being help. */
const RUN_BUDGET_MS = 90000;
/** Turns that changed nothing. Three in a row is a loop, not bad luck. */
const MAX_IDLE_TURNS = 3;

const REQUEST_TIMEOUT_MS = 30000;
/**
 * The replies are a sentence and a few steps — but the reasoning models on the
 * list spend this budget on thinking before they spend it on the answer, and a
 * reply cut off mid-JSON parses as nothing at all. Enough headroom for both.
 */
const MAX_OUTPUT_TOKENS = 800;
/** Two failed calls in a row is a bad key or a bad network, not bad luck. */
const MAX_CONSECUTIVE_ERRORS = 2;

/** How much of the trail is carried. Each line is ~15 tokens; failures are kept longest. */
const TRAIL_MAX = 14;
const TRAIL_DETAIL_CHARS = 110;

// ---------------------------------------------------------------------------
// Living inside a Groq minute
//
// The binding limit on a free key is tokens per minute, not requests: 6,000 on
// the small models, 12,000 on the larger ones. A command spends several turns
// and they all land inside the same minute, so what decides whether this works
// at all is the size of a single turn.
//
// Which is why the model is never sent the page. It gets a digest — the
// address, the title, and a few dozen names — and asks for elements by
// description; the finding happens in the content script, for free. A turn is
// then around 900 tokens rather than the 3,000 a page description costs.
//
// The conversation is not sent either. What goes up each turn is rebuilt from
// three things — the request, a one-line-per-action trail of what has been
// tried, and the page as it is *now*. Old page descriptions are at once the
// most expensive thing here and the most misleading, since their names refer to
// a page that no longer exists. The trail costs about fifteen tokens a line and
// is the part that stops the model trying the same wording twice.
// ---------------------------------------------------------------------------

/** What Groq last said about this key. Logged, so a tightening limit is visible. */
const limits = { tokens: 0, remaining: 0 };

function readLimits(headers) {
  const limit = Number(headers.get('x-ratelimit-limit-tokens'));
  const remaining = Number(headers.get('x-ratelimit-remaining-tokens'));
  if (Number.isFinite(limit) && limit > 0) limits.tokens = limit;
  if (Number.isFinite(remaining) && remaining >= 0) limits.remaining = remaining;
}

/** What Groq has told us about this key, for the worker's log. */
export const rateLimits = () => ({ ...limits });

/**
 * Models that have spent their day, and when they get it back.
 *
 * Module-level on purpose: a daily cap outlives the command that discovered it,
 * and re-learning it costs a wasted request at the start of every sentence for
 * the rest of the day.
 */
const spent = new Map();

/** Groq's per-day counters roll over at midnight UTC. */
function nextUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function isSpent(model) {
  const until = spent.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    spent.delete(model);
    return false;
  }
  return true;
}

/** Which models are out for the day, for the worker's log and the options page. */
export const spentModels = () =>
  [...spent.entries()].filter(([, until]) => Date.now() < until).map(([model]) => model);

function untilPhrase(timestamp) {
  const ms = Math.max(0, timestamp - Date.now());
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes || 1}m`;
}

/** A per-day cap and a per-minute one are the same status code and want opposite handling. */
const isPerDay = (body) => /per day|\bRPD\b|\bTPD\b|requests per day|tokens per day/i.test(body || '');

/**
 * Groq says "please try again in 1.5s" in the body and `retry-after` in
 * seconds in the header. The body is the precise one; the header is the one
 * that's always there.
 */
function retryDelayMs(response, body) {
  const inBody = /try again in ([\d.]+)\s*(ms|s|m)?/i.exec(body || '');
  if (inBody) {
    const value = Number(inBody[1]);
    const unit = (inBody[2] || 's').toLowerCase();
    const ms = unit === 'ms' ? value : unit === 'm' ? value * 60000 : value * 1000;
    if (Number.isFinite(ms)) return Math.min(ms + 250, 30000);
  }
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.min(header * 1000 + 250, 30000) : 4000;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a `command` step may run. Everything bindable, minus the two that make no
 * sense here — `SLEEP` because the way back out of it is a gesture, and someone
 * who got there by talking would have no idea which one.
 */
const COMMANDS = Object.keys(ACTIONS).filter((name) => name !== 'NONE' && name !== 'SLEEP');

const SYSTEM_PROMPT = `You are Jester. The user is looking at a web page and said something out loud; speech recognition may have misheard a word, so read for intent. You work the page for them.

You cannot see the page. You get its address, its title, and a few of the names on it — enough to know roughly where you are. To act, describe what you want in plain words and Jester finds it:

  {"type":"click","target":"the search button"}

It searches several ways — the exact name, part of the name, the words in it, the attributes, and what that phrase usually means on a page — so describe the thing as a person would. If nothing matches you are told so, with the nearest names on the page; aim at one of those next.

Reply with JSON and nothing else:

{"plan":["..."],"step":1,"thought":"one short sentence","actions":[...],"say":"what to tell the user, or null","status":"continue"|"done"}

"plan" — only on your first reply. Break what was asked into the few parts it really has, in order, one short phrase each. "play the office" is one part. "search for the office and play season 2 episode 3" is four: search for it, open it, choose season 2, play episode 3. You will be shown this list back every turn.
"step" — which part of the plan you are working on now, counting from 1. Move it on as parts get done.

Steps:

  {"type":"click","target":"play button"}
  {"type":"type","target":"search box","text":"suits","submit":true}   submit:true presses Enter after
  {"type":"select","target":"season dropdown","value":"Season 2"}      a real <select> dropdown
  {"type":"find","target":"episode"}                                   list what matches, without acting
  {"type":"press","key":"Enter"}                                       Escape, ArrowDown, Tab...
  {"type":"scroll","direction":"down"}                                 or up, top, bottom
  {"type":"scroll","target":"episode 3"}                               bring one thing into view
  {"type":"wait","ms":800}
  {"type":"command","name":"PAUSE"}

Add "index":2 to any step to take the second match instead of the first — that is how you say "the third episode" when several things share a name.

Commands, for what a click cannot reach — they work in fullscreen and inside players you cannot see into, and fullscreen only works this way:
${COMMANDS.join(', ')}

Rules:

- Few actions per turn. If the page is about to change, stop there — clicking a search button and typing into the field it opens are two turns, because that field does not exist yet.
- You are shown everything you have tried so far and what it did. Read it first. A wording that failed once will fail again — aim at one of the names you were offered instead of rephrasing your guess.
- Not sure what is there? "find" is cheap. Use it rather than guessing twice.
- "status":"done" when the whole plan is finished, with one short sentence in "say".
- A question about the page: answer in "say", no actions, "done". Use "find" first if you need to look.
- Not possible here — the thing isn't there, the site wants a login: say so in "say" and stop. Do not keep trying.
- Never enter payment details or touch passwords or account security.
- "say" is spoken to someone already looking at the screen. No preamble, no markdown.`;

/** Groq sometimes wraps JSON in prose despite being asked not to. Dig it out. */
function parseJson(raw) {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** True for the failures where trying a different model is the right answer. */
function isModelFailure(status, body) {
  if (status === 404) return true;
  return status === 400 && /model|decommission|deprecat/i.test(body || '');
}

function describeHttpFailure(status, body) {
  const detail = parseJson(body)?.error?.message || '';

  switch (status) {
    case 401:
    case 403:
      return 'Groq rejected the API key in .env. Check that it is the whole key and still valid.';
    case 413:
      return 'That page was too big to send to Groq.';
    default:
      return `Groq returned ${status}${detail ? `: ${detail}` : ''}`;
  }
}

/** Said when every model on the ladder has spent its day. */
function allSpentMessage(models) {
  const soonest = Math.min(...models.map((model) => spent.get(model) || 0).filter(Boolean));
  const when = Number.isFinite(soonest) && soonest ? ` They come back in ${untilPhrase(soonest)}.` : '';
  return (
    `That's the daily Groq allowance used up on all ${models.length} models Jester falls back through.` +
    `${when} A paid Groq tier lifts it, or a different key starts fresh.`
  );
}

/**
 * One call to Groq, walking `models` until one answers.
 *
 * Three different failures send us to the next name, and it matters that they
 * are told apart. A retired model is gone for good. A model that has spent its
 * day is gone until midnight, and is worth remembering so the next sentence
 * doesn't rediscover it. A model whose *minute* is full is fine — and since
 * every model has its own per-minute pool, the next one down the list is very
 * often free right now, which beats sitting out the ten seconds Groq asked for.
 * Only when all of them are full is the wait the best thing left to do.
 *
 * Mutates nothing but the day-cap registry; returns the parsed reply and which
 * model answered, so the caller can stop paying for the fallthrough next turn.
 */
async function ask({ key, models, messages, signal, retries = 1 }) {
  const usable = models.filter((model) => !isSpent(model));
  if (!usable.length) throw new Error(allSpentMessage(models));

  let lastError = 'No model to try.';
  /** The shortest "try again in" any model offered, if they were all busy. */
  let soonestFree = null;

  for (const model of usable) {
    // Its own timeout on top of the caller's abort: a request that hangs would
    // otherwise leave a ball spinning on the page with nothing behind it.
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => timer.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response;
    try {
      response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          // Low, not zero: this is a task with one right answer per turn, and
          // zero makes a model that has gone wrong go wrong identically twice.
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' }
        }),
        signal: timer.signal
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('cancelled');
      lastError = timer.signal.aborted
        ? 'Groq took too long to answer.'
        : `Could not reach Groq: ${err?.message || err}`;
      continue;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    readLimits(response.headers);

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      if (isModelFailure(response.status, body)) {
        console.warn(`[jester] Groq has no model "${model}" — trying the next one.`);
        lastError = `Groq has no model called "${model}".`;
        continue;
      }

      if (response.status === 429) {
        // Spent for the day. Remember it: every sentence for the rest of the day
        // would otherwise open by asking this model the same question again.
        if (isPerDay(body)) {
          const until = nextUtcMidnight();
          spent.set(model, until);
          console.warn(`[jester] ${model} has used its day — back in ${untilPhrase(until)}. Dropping to the next model.`);
          lastError = `${model} has used its daily allowance.`;
          continue;
        }

        // Full for the minute. Its pool is its own, so the next model down is
        // very likely free this second — try that before spending the wait.
        const delay = retryDelayMs(response, body);
        soonestFree = soonestFree === null ? delay : Math.min(soonestFree, delay);
        console.warn(`[jester] ${model}'s minute is full — trying the next model rather than waiting ${Math.round(delay / 100) / 10}s.`);
        lastError = `Every model's per-minute limit is full.`;
        continue;
      }

      throw new Error(describeHttpFailure(response.status, body));
    }

    const choice = (await response.json().catch(() => null))?.choices?.[0];
    const json = parseJson(choice?.message?.content);
    if (!json) {
      lastError =
        choice?.finish_reason === 'length'
          ? `${model} was still writing when it ran out of room — the JSON never closed.`
          : 'Groq replied with something that was not the JSON it was asked for.';
      console.warn(`[jester] ${lastError} Trying the next model.`);
      continue;
    }

    return { json, model };
  }

  // Every model was busy this minute, so there is nothing left to try but time.
  if (soonestFree !== null && retries > 0) {
    console.warn(`[jester] every model is full — waiting ${Math.round(soonestFree / 100) / 10}s.`);
    await wait(soonestFree);
    if (signal?.aborted) throw new Error('cancelled');
    return ask({ key, models, messages, signal, retries: retries - 1 });
  }

  throw new Error(lastError);
}

/** Everything we understood from one reply, with every field made safe to use. */
function readReply(json) {
  const plan = Array.isArray(json?.plan)
    ? json.plan.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const step = Number(json?.step);
  return {
    plan,
    step: Number.isFinite(step) && step > 0 ? Math.floor(step) : 0,
    actions: Array.isArray(json?.actions) ? json.actions.filter((a) => a && a.type) : [],
    say: typeof json?.say === 'string' ? json.say.trim() : '',
    thought: typeof json?.thought === 'string' ? json.thought : '',
    done: json?.status === 'done'
  };
}

const tidy = (value, max) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * The trail, trimmed to its cap.
 *
 * Successes go first when something has to go. What the trail is *for* is
 * stopping the model reaching for a wording that has already failed, and a
 * remembered failure does that where a remembered success does not.
 */
function trimTrail(trail) {
  while (trail.length > TRAIL_MAX) {
    // Never the newest line, whatever it is: once the trail has filled up with
    // failures, the only success in it is the one just added, and dropping that
    // would leave the model reading a wall of misses with no sign that the thing
    // it just did worked.
    const oldestSuccess = trail.findIndex((entry, i) => entry.ok && i < trail.length - 1);
    trail.splice(oldestSuccess >= 0 ? oldestSuccess : 0, 1);
  }
  return trail;
}

/** One turn's results, as lines the next turn can read. */
function recordTurn(trail, results) {
  for (const entry of results) {
    trail.push({
      ok: !!entry.ok,
      line: `${entry.step} → ${entry.ok ? 'ok' : 'FAILED'}${entry.detail ? `: ${tidy(entry.detail, TRAIL_DETAIL_CHARS)}` : ''}`
    });
  }
  return trimTrail(trail);
}

/**
 * Steps that cannot have changed anything by themselves, so their success says
 * nothing about whether the run is getting anywhere. `find` only looks, and
 * `wait` does nothing at all — both report `ok` unconditionally, so counting
 * them is how a loop detector ends up never firing.
 */
const CHANGES_NOTHING = /^(find|wait)\b/i;

/**
 * A turn got somewhere if something that could move the page succeeded *and* the
 * page then looked different.
 *
 * Both halves are needed. The content script says `ok` when it found the element
 * and dispatched the click — not when the click achieved anything — so a button
 * that silently does nothing reports success all day. Comparing the digest is
 * what catches that, and it is free: the next turn's digest is already being
 * fetched.
 */
const madeProgress = (results, before, after) => {
  if (typeof after !== 'string' || after === before) return false;
  return results.some((entry) => entry.ok && !CHANGES_NOTHING.test(String(entry.step || '')));
};

/** What is left of the plan from `step` on. */
const rest = (plan, step) => plan.slice(Math.max(0, step - 1)).filter(Boolean);

/**
 * The whole of what the model is sent, rebuilt every turn.
 *
 * One user message rather than a growing conversation, because two of the three
 * things it needs — where it is, and how far along it is — are only true right
 * now, and the third is a list that is cheaper to restate than to re-derive.
 */
function turnPrompt({ goal, plan, step, trail, page, wantPlan }) {
  const parts = [`The user said: "${goal}"`];

  if (plan.length) {
    parts.push(
      `Your plan, and where you are in it:\n${plan
        .map((item, i) => `  ${i + 1 < step ? '✓' : i + 1 === step ? '→' : ' '} ${i + 1}. ${item}`)
        .join('\n')}`
    );
  } else if (wantPlan) {
    parts.push('This is your first turn: include "plan" in your reply.');
  }

  if (trail.length) {
    parts.push(
      'What you have already tried, oldest first. Do not try a wording that failed here again:\n' +
        trail.map((entry, i) => `  ${i + 1}. ${entry.line}`).join('\n')
    );
  }

  parts.push(`Where you are now:\n\n${page}`);
  return parts.join('\n\n');
}

/**
 * @param text   what the user said.
 * @param env    the parsed .env — the key, and optionally the model.
 * @param host   the Chrome-shaped half: `{ digest, act, command, thinking }`.
 *               `digest()` returns `{ ok, text }` or `{ ok:false, detail }`;
 *               `act(steps)` returns `{ results }`; `command(name)` runs one of
 *               ACTIONS; `thinking()` re-asserts the spinner, which a page
 *               navigation would otherwise have taken down with the document.
 * @param signal aborts the whole run — the user has started a new sentence.
 * @param resume the `resume` handle from a run that ran out of budget, so
 *               "keep going" picks up the plan and the trail rather than the
 *               user having to say the whole sentence again.
 *
 * @returns `{ ok, say, resume }` — what to put on the pill, whether it went
 *          well, and the state to carry if it stopped with work left.
 */
export async function runAssistant({ text, env, host, signal, resume = null }) {
  const models = env.aiModel ? [env.aiModel, ...MODELS.filter((m) => m !== env.aiModel)] : MODELS;
  let model = models.find((name) => !isSpent(name)) || models[0];

  let page = await host.digest();
  if (!page?.ok) {
    return {
      ok: false,
      say: page?.detail || 'Jester can’t read this page — try it on a supported site.',
      // Handed straight back when this was a "keep going". Failing to read the
      // page says nothing about the plan, and dropping it here would mean a
      // resume attempted a moment too early destroyed the thing it resumed.
      resume: resume || null
    };
  }

  // A resumed run keeps the sentence, the plan and the trail. The page it is
  // looking at is deliberately *not* carried: that is the one thing that has
  // certainly moved on since.
  const goal = resume?.goal || text;
  const trail = Array.isArray(resume?.trail) ? trimTrail([...resume.trail]) : [];
  let plan = Array.isArray(resume?.plan) ? resume.plan : [];
  let step = Number(resume?.step) > 0 ? Number(resume.step) : 1;

  let errors = 0;
  let idle = 0;
  let said = '';
  let stopped = '';
  const deadline = Date.now() + RUN_BUDGET_MS;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (signal?.aborted) return { ok: false, say: '' };

    // Checked at the top of a turn rather than the bottom, so the budget stops
    // the *next* request rather than discarding a reply already paid for.
    if (turn > 0 && Date.now() >= deadline) {
      stopped = 'time';
      break;
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: turnPrompt({ goal, plan, step, trail, page: page.text, wantPlan: !trail.length })
      }
    ];

    let reply;
    try {
      reply = await ask({
        key: env.aiKey,
        models: [model, ...models.filter((m) => m !== model)],
        messages,
        signal
      });
    } catch (err) {
      if (signal?.aborted || /cancelled/i.test(String(err?.message))) return { ok: false, say: '' };
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_ERRORS) {
        const keep = trail.length ? { goal, plan, step, trail } : null;
        return {
          ok: false,
          // The run is resumable, so say so — the phrase is no use to anyone who
          // is never told it.
          say: `${String(err?.message || err)}${keep ? ' Say “keep going” to pick it up from here.' : ''}`,
          resume: keep
        };
      }
      trail.push({ ok: false, line: `(that request failed: ${tidy(err?.message || err, TRAIL_DETAIL_CHARS)})` });
      trimTrail(trail);
      continue;
    }

    errors = 0;
    model = reply.model;
    const turnPlan = readReply(reply.json);
    if (turnPlan.plan.length && !plan.length) plan = turnPlan.plan;
    if (turnPlan.step) step = Math.min(turnPlan.step, Math.max(plan.length, 1));
    if (turnPlan.thought) console.log(`[jester] assistant (${model}): ${turnPlan.thought}`);
    if (turnPlan.say) said = turnPlan.say;

    // Nothing to do is the end of the run whatever `status` says — either it was
    // a question, or the model has stopped making progress. Either way another
    // turn would ask the same thing of the same page.
    if (!turnPlan.actions.length) return { ok: true, say: said || 'Done.' };

    /**
     * What the pill shows beside the spinner. The part of the plan being worked
     * on is the honest answer to "what is it doing" — it is the same phrase the
     * model is steering by. `thought` stands in for the first turn of a one-part
     * request, where there is no checklist to point at yet.
     */
    const doing = tidy(plan[step - 1] || turnPlan.thought, 60);
    host.thinking(doing);

    // Split the built-in commands out: they belong to the worker, not to the
    // page, and a run of them in the middle of a plan must keep its order.
    const results = [];
    /** The content script went quiet. What that means is decided below. */
    let quiet = false;
    for (const group of groupActions(turnPlan.actions)) {
      if (signal?.aborted) return { ok: false, say: '' };
      if (group.kind === 'command') {
        for (const action of group.actions) {
          const name = String(action.name || action.action || '').toUpperCase();
          const outcome = COMMANDS.includes(name)
            ? await host.command(name)
            : { ok: false, detail: `there is no built-in command called "${name}"` };
          results.push({ step: `command ${name}`, ok: !!outcome?.ok, detail: outcome?.detail || '' });
        }
      } else {
        const outcome = await host.act(group.actions);
        results.push(...(outcome?.results || []));
        if (outcome?.navigated) quiet = true;
      }
      if (results.some((entry) => !entry.ok)) break;
    }

    // An abort does not interrupt the await above — the batch runs to the end
    // whatever happens — so this is the first moment a run cancelled during its
    // own actions can notice. Everything below paints the pill or spends a
    // request, and by now both belong to whatever the user said instead.
    if (signal?.aborted) return { ok: false, say: '' };

    // The spinner lives in the page, so anything that replaced the page took it
    // with it. Cheap to re-assert, and invisible when it's already up.
    host.thinking(doing);

    // Taken before the results are judged, not after, because it is the only
    // thing that can judge them. A click that navigated takes the content script
    // down with the reply still in it — and so does a click that landed on an
    // origin Jester has no content script for and cannot inject one into. They
    // are identical from `act()`; they are not remotely the same thing. The next
    // look tells them apart: a page that merely turned answers it.
    const next = await host.digest();
    if (quiet) {
      results.push(
        next?.ok
          ? { step: 'page', ok: true, detail: 'the page navigated' }
          : {
              step: 'page',
              ok: false,
              detail: 'the page went somewhere Jester cannot read, so nothing after this ran'
            }
      );
    }

    recordTurn(trail, results);

    // "done" was decided before it could know whether the actions landed. If
    // one didn't, give it the failure and a fresh page rather than reporting a
    // success neither of us has seen.
    const worked = results.length > 0 && results.every((entry) => entry.ok);
    if (turnPlan.done && worked) return { ok: true, say: said || 'Done.' };

    idle = madeProgress(results, page.text, next?.ok ? next.text : null) ? 0 : idle + 1;
    if (idle >= MAX_IDLE_TURNS) {
      stopped = 'stuck';
      break;
    }

    page = next?.ok
      ? next
      : { ...page, text: `The page could not be read: ${next?.detail || 'unknown error'}` };
  }

  if (!stopped) stopped = 'turns';

  return {
    ok: false,
    // Deliberately not `said || …`. Whatever the model last narrated was said
    // mid-run about something it was still in the middle of, and on this path it
    // did not get to the end — so a cheerful "playing season 2 now" would sit on
    // a failed pill about a page where nothing is playing. This message is also
    // the only place the user is told the two words that resume the run.
    say: stoppedMessage(stopped, plan, step, page),
    // Everything needed to pick this up where it stopped. The caller decides
    // whether "keep going" is on the table; this only makes it possible.
    resume: { goal, plan, step, trail }
  };
}

/**
 * What to say when a run stops with work left in it.
 *
 * The old message — "try asking for one thing at a time" — was both a dead end
 * and, usually, wrong: the request was fine, the budget wasn't. Saying where it
 * got to and what is still outstanding turns it into something the user can
 * answer with two words.
 */
function stoppedMessage(reason, plan, step, page) {
  const left = rest(plan, step);
  const where = page?.title ? ` I’m on ${tidy(page.title, 40)}.` : '';

  // Stuck is not the same as out of time, and it wants a different offer. "Keep
  // going" would only get stuck in the same place; what unsticks it is the user
  // naming the thing on screen that Jester couldn't find. Both branches have to
  // end in something the user can act on — a run that stops without saying what
  // would help is the dead end this message exists to replace.
  if (reason === 'stuck') {
    return left.length
      ? `I got stuck trying to ${left[0]}.${where} Say what to click and I’ll take it from there.`
      : `I couldn’t get any further with that.${where} Say what to click and I’ll take it from there.`;
  }

  return left.length
    ? `Still need to ${left[0]}.${where} Say “keep going” to carry on.`
    : `That took longer than I had.${where} Say “keep going” to carry on.`;
}

/** Consecutive actions of the same kind, so each batch goes to one place in order. */
function groupActions(actions) {
  const groups = [];
  for (const action of actions) {
    const kind = String(action.type).toLowerCase() === 'command' ? 'command' : 'page';
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.actions.push(action);
    else groups.push({ kind, actions: [action] });
  }
  return groups;
}
