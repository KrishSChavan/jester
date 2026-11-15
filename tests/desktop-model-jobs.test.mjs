import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelJob, LOCAL_USES, localUses } from '../desktop/src/main/model-jobs.js';

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
  assert.match(logged.join('\n'), /talking: the saved models failed \(groq returned 400.*\), so this computer’s takes it/);
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
