import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelJob, LOCAL_USES, localUses, REST_MS } from '../desktop/src/main/model-jobs.js';

const saved = (overrides = {}) => ({
  id: 'groq-1',
  provider: 'groq',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'llama-3.3-70b-versatile',
  key: 'gsk_private',
  plan: 'paid',
  uses: ['act'],
  cooldownUntil: 0,
  ...overrides
});

/** A job whose requests are recorded: which provider and model each went to. */
function job({ name = 'talk', models = [], local = { model: 'qwen3.5:9b', uses: LOCAL_USES }, reply = () => ({ json: { say: 'Hi.' } }) } = {}) {
  const asked = [];
  const ask = createModelJob({
    job: name,
    saved: async () => models,
    local: async () => local,
    keepAlive: '2m',
    markLimited: async () => undefined,
    request: async (options) => {
      asked.push(`${options.config.provider} ${options.config.model}`);
      return reply(options);
    }
  });
  return { ask, asked };
}

test('with no saved model set to talk, he talks through this computer’s, which Ollama lets go after two minutes', async () => {
  let config = null;
  const { ask, asked } = job({ models: [saved()], reply: (options) => ((config = options.config), { json: { say: 'Hi.' } }) });
  await ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(asked, ['ollama qwen3.5:9b'], 'the saved model does actions only');
  assert.equal(config.keepAlive, '2m');
  assert.equal(await ask.ready(), true);
});

test('a saved model set to talk is the one he talks through, and an actions-only one never is', async () => {
  const { ask, asked } = job({ models: [saved(), saved({ id: 'gemini', provider: 'google', protocol: 'gemini', model: 'gemini-2.5-flash', uses: ['talk'] })] });
  await ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(asked, ['google gemini-2.5-flash']);
  const acting = job({ name: 'act', models: [saved(), saved({ id: 'gemini', provider: 'google', protocol: 'gemini', model: 'gemini-2.5-flash', uses: ['talk'] })] });
  await acting.ask({ system: 'S', prompt: 'do it' });
  assert.deepEqual(acting.asked, ['groq llama-3.3-70b-versatile']);
});

test('saved models out of requests for a while hand the job to this computer’s, if it may take it', async () => {
  const resting = saved({ uses: ['talk', 'act'], cooldownUntil: Date.now() + 3600000 });
  const { ask, asked } = job({ models: [resting] });
  await ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(asked, ['ollama qwen3.5:9b']);
  const kept = job({ models: [resting], local: { model: 'qwen3.5:9b', uses: ['act'] } });
  await assert.rejects(kept.ask({ system: 'S', prompt: 'hi' }), (err) => err.code === 'all_models_rate_limited');
  assert.deepEqual(kept.asked, [], 'this computer’s isn’t set to talk');
});

/** A saved model that fails as model-client.js says it did, then this computer's that answers. */
const failing = (err) => (options) => {
  if (options.config.provider !== 'ollama') throw err;
  return { json: { say: 'Hi.' } };
};

test('a saved model that fails is covered for by this computer’s, if it may take the job', async () => {
  // 2026-11-13, word for word: gpt-oss-120b's JSON mode gave up on "Oh, that class already happened…".
  const invalid = Object.assign(new Error('groq returned 400: Failed to generate JSON. Please adjust your prompt. See \'failed_generation\' for more details.'), { code: 'http_error', status: 400, retryable: false });
  const logged = [];
  const asked = [];
  const ask = createModelJob({
    job: 'talk',
    saved: async () => [saved({ uses: ['talk'], model: 'openai/gpt-oss-120b' })],
    local: async () => ({ model: 'qwen3.5:9b', uses: LOCAL_USES }),
    keepAlive: '2m',
    log: (line) => logged.push(line),
    request: async (options) => {
      asked.push(`${options.config.provider} ${options.config.model}`);
      return failing(invalid)(options);
    }
  });
  assert.equal((await ask({ system: 'S', prompt: 'hi' })).json.say, 'Hi.');
  assert.deepEqual(asked, ['groq openai/gpt-oss-120b', 'ollama qwen3.5:9b']);
  assert.match(logged.join('\n'), /talking: groq openai\/gpt-oss-120b failed \(groq returned 400.*\), so this computer’s takes it/);
  for (const err of [Object.assign(new Error('groq returned 503'), { code: 'http_error', status: 503 }), Object.assign(new Error('timed out'), { code: 'model_timeout' }), Object.assign(new Error('fetch failed'), { name: 'TypeError' })]) {
    const { ask: again, asked: went } = job({ models: [saved({ uses: ['talk'] })], reply: failing(err) });
    await again({ system: 'S', prompt: 'hi' });
    assert.deepEqual(went, ['groq llama-3.3-70b-versatile', 'ollama qwen3.5:9b'], err.message);
  }
});

test('a saved model that fails isn’t covered for when this computer’s may not take the job, or isn’t running', async () => {
  const err = Object.assign(new Error('groq returned 500'), { code: 'http_error', status: 500 });
  const kept = job({ models: [saved({ uses: ['talk'] })], local: { model: 'qwen3.5:9b', uses: ['act'] }, reply: failing(err) });
  await assert.rejects(kept.ask({ system: 'S', prompt: 'hi' }), /groq returned 500/);
  assert.deepEqual(kept.asked, ['groq llama-3.3-70b-versatile']);
  const down = job({ models: [saved({ uses: ['talk'] })], local: { model: '', uses: LOCAL_USES }, reply: failing(err) });
  await assert.rejects(down.ask({ system: 'S', prompt: 'hi' }), /groq returned 500/, 'the saved model’s error, not that Ollama’s missing');
});

test('a key refused or a model not found isn’t covered for: only Settings puts it right, so it’s the user’s to see', async () => {
  for (const [status, message] of [[401, 'groq rejected the API key. Check Settings.'], [403, 'groq rejected the API key. Check Settings.'], [404, 'The provider could not find model "x" or its API endpoint. Check Settings.']]) {
    const { ask, asked } = job({ models: [saved({ uses: ['talk'] })], reply: failing(Object.assign(new Error(message), { code: 'http_error', status })) });
    await assert.rejects(ask({ system: 'S', prompt: 'hi' }), (err) => err.status === status);
    assert.deepEqual(asked, ['groq llama-3.3-70b-versatile'], String(status));
  }
});

test('a turn the user’s moved on from isn’t carried on by this computer’s', async () => {
  const controller = new AbortController();
  const { ask, asked } = job({
    models: [saved({ uses: ['talk'] })],
    reply: (options) => {
      if (options.config.provider !== 'ollama') {
        controller.abort();
        throw Object.assign(new Error('groq returned 500'), { code: 'http_error', status: 500 });
      }
      return { json: { say: 'Hi.' } };
    }
  });
  await assert.rejects(ask({ system: 'S', prompt: 'hi', signal: controller.signal }));
  assert.deepEqual(asked, ['groq llama-3.3-70b-versatile']);
});

const claude = (overrides = {}) => saved({ id: 'claude', provider: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', plan: 'paid', uses: ['talk', 'act'], ...overrides });
const groq = (overrides = {}) => saved({ id: 'groq', model: 'openai/gpt-oss-120b', plan: 'free', uses: ['talk'], ...overrides });

/** A talking job over Claude and Groq, whose clock and failures a test sets. */
function pair({ models = [groq(), claude()], local = { model: 'qwen3.5:9b', uses: LOCAL_USES }, fails = () => null, paidFirst } = {}) {
  const state = { time: 5_000_000, asked: [], failed: [], used: [], logged: [] };
  const ask = createModelJob({
    job: 'talk',
    saved: async () => models,
    local: async () => local,
    keepAlive: '2m',
    markLimited: async () => undefined,
    now: () => state.time,
    log: (...parts) => state.logged.push(parts.join(' ')),
    onFailed: (failure) => state.failed.push(failure),
    onUsed: (used) => state.used.push(used),
    ...(paidFirst === undefined ? {} : { paidFirst: () => paidFirst }),
    request: async (options) => {
      state.asked.push(options.config.provider);
      const err = fails(options.config);
      if (err) throw err;
      return { json: { say: 'Hi.' }, model: options.config.model, usage: { input_tokens: 1800, output_tokens: 40 } };
    }
  });
  return Object.assign(state, { ask });
}
const http = (status, message = `returned ${status}`, extra = {}) => Object.assign(new Error(message), { code: 'http_error', status, retryable: false, ...extra });

test('paid models are asked before free ones, whatever order they were saved in', async () => {
  const first = pair();
  await first.ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(first.asked, ['anthropic'], 'Groq was saved first, and Claude is paid');
  assert.deepEqual(first.used, [{ provider: 'anthropic', model: 'claude-haiku-5-5', usage: { input_tokens: 1800, output_tokens: 40 } }]);
  const asSaved = pair({ paidFirst: false });
  await asSaved.ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(asSaved.asked, ['groq']);
  // Among paid ones, and among free ones, the order saved.
  const two = pair({ models: [groq(), claude({ id: 'c2', model: 'claude-sonnet-5-5' }), claude()] });
  await two.ask({ system: 'S', prompt: 'hi' });
  assert.equal(two.used[0].model, 'claude-sonnet-5-5');
});

test('a saved model that fails is covered for by the next saved one, before this computer’s', async () => {
  const run = pair({ fails: (config) => (config.provider === 'anthropic' ? http(400, "anthropic returned 400: Failed to parse") : null) });
  assert.equal((await run.ask({ system: 'S', prompt: 'hi' })).json.say, 'Hi.');
  assert.deepEqual(run.asked, ['anthropic', 'groq']);
  assert.deepEqual(run.failed, [{ id: 'claude', provider: 'anthropic', model: 'claude-haiku-5-5', kind: '', message: 'anthropic returned 400: Failed to parse', next: 'groq openai/gpt-oss-120b' }]);
  assert.match(run.logged.join('\n'), /talking: anthropic claude-haiku-5-5 failed \(anthropic returned 400: Failed to parse\), so groq openai\/gpt-oss-120b takes it/);
  // A failure of that one request alone: asked again the next time.
  await run.ask({ system: 'S', prompt: 'again' });
  assert.deepEqual(run.asked, ['anthropic', 'groq', 'anthropic', 'groq']);
  // Both failing: this computer's, last.
  const both = pair({ fails: (config) => (config.provider === 'ollama' ? null : http(400)) });
  await both.ask({ system: 'S', prompt: 'hi' });
  assert.deepEqual(both.asked, ['anthropic', 'groq', 'ollama']);
  assert.deepEqual(both.failed.map((failure) => failure.next), ['groq openai/gpt-oss-120b', 'this computer']);
});

test('a model that’s down is left alone for a minute, so the next turns don’t wait on it again', async () => {
  for (const err of [http(500), http(529), Object.assign(new Error('too slow'), { code: 'model_timeout' }), Object.assign(new Error('busy'), { code: 'provider_busy', status: 503 }), new TypeError('fetch failed')]) {
    let broken = true;
    const run = pair({ fails: (config) => (config.provider === 'anthropic' && broken ? err : null) });
    await run.ask({ system: 'S', prompt: 'one' });
    assert.equal(run.failed[0].kind, 'down', err.message);
    await run.ask({ system: 'S', prompt: 'two' });
    assert.deepEqual(run.asked, ['anthropic', 'groq', 'groq'], `${err.message}: straight to the next`);
    broken = false;
    run.time += REST_MS.down + 1;
    await run.ask({ system: 'S', prompt: 'three' });
    assert.deepEqual(run.asked, ['anthropic', 'groq', 'groq', 'anthropic'], `${err.message}: asked again once it’s rested`);
  }
});

test('a model out of credit is left alone for an hour, and who covers for it is said', async () => {
  for (const err of [http(400, 'anthropic returned 400: Your credit balance is too low to access the Anthropic API.', { type: 'invalid_request_error' }), http(402, 'anthropic returned 402', { type: 'billing_error' })]) {
    const run = pair({ fails: (config) => (config.provider === 'anthropic' ? err : null) });
    await run.ask({ system: 'S', prompt: 'one' });
    assert.deepEqual([run.failed[0].kind, run.failed[0].next], ['credit', 'groq openai/gpt-oss-120b']);
    run.time += REST_MS.credit - 1000;
    await run.ask({ system: 'S', prompt: 'two' });
    assert.deepEqual(run.asked, ['anthropic', 'groq', 'groq']);
    run.time += 2000;
    await run.ask({ system: 'S', prompt: 'three' });
    assert.deepEqual(run.asked, ['anthropic', 'groq', 'groq', 'anthropic', 'groq']);
  }
});

test('with nobody else to turn to, a model that’s resting is asked all the same', async () => {
  let broken = true;
  const run = pair({ models: [claude()], local: { model: '', uses: LOCAL_USES }, fails: () => (broken ? http(500, 'anthropic returned 500') : null) });
  await assert.rejects(run.ask({ system: 'S', prompt: 'one' }), /anthropic returned 500/);
  broken = false;
  assert.equal((await run.ask({ system: 'S', prompt: 'two' })).json.say, 'Hi.');
  assert.deepEqual(run.asked, ['anthropic', 'anthropic']);
});

test('a key refused on the first model is the user’s to see: the next isn’t asked to cover for it', async () => {
  const run = pair({ fails: (config) => (config.provider === 'anthropic' ? http(401, 'anthropic rejected the API key. Check Settings.') : null) });
  await assert.rejects(run.ask({ system: 'S', prompt: 'hi' }), /rejected the API key/);
  assert.deepEqual(run.asked, ['anthropic']);
  assert.deepEqual(run.failed, []);
});

test('with no model for a job, he says where to choose one', async () => {
  const off = job({ local: { model: 'qwen3.5:9b', uses: ['act'] } });
  await assert.rejects(off.ask({ system: 'S', prompt: 'hi' }), /None of your models is set to talk.*Settings › Models/);
  assert.equal(await off.ask.ready(), false);
  const down = job({ local: { model: '', uses: LOCAL_USES } });
  await assert.rejects(down.ask({ system: 'S', prompt: 'hi' }), /can’t reach Ollama/);
  const acting = job({ name: 'act', local: { model: '', uses: ['talk'] } });
  await assert.rejects(acting.ask({ system: 'S', prompt: 'do it' }), /None of your models is set for actions/);
});

test('this computer’s model does both jobs until Settings says otherwise', () => {
  assert.deepEqual(localUses(undefined), ['talk', 'act']);
  assert.deepEqual(localUses({}), ['talk', 'act']);
  assert.deepEqual(localUses({ localModelUses: ['talk'] }), ['talk']);
  assert.deepEqual(localUses({ localModelUses: [] }), []);
});

test('Claude is held to the desktop agent’s and the planner’s schemas, which it takes (measured live, 2026-11-14)', async () => {
  const { claudeSchema } = await import('../jester-extension/src/background/model-client.js');
  const { DESKTOP_SCHEMA } = await import('../desktop/src/main/agent/prompt.js');
  const { PLAN_SCHEMA } = await import('../desktop/src/main/agent/plan.js');
  for (const [name, schema] of [['the desktop agent', DESKTOP_SCHEMA], ['the planner', PLAN_SCHEMA]]) {
    const taken = claudeSchema(schema);
    assert.ok(taken, `${name}’s schema is one Claude takes`);
    assert.equal(taken.type, 'object');
    assert.doesNotMatch(JSON.stringify(taken), /"(?:minimum|maximum|minItems|maxItems)"/, name);
  }
  // Either shape of the agent's reply fits the one object Claude is held to.
  assert.deepEqual(Object.keys(claudeSchema(DESKTOP_SCHEMA).properties).sort(), ['action', 'actions', 'memory', 'task']);
});
