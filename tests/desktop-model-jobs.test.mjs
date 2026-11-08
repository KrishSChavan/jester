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

test('a saved model that fails for another reason isn’t covered for: the error is the user’s to see', async () => {
  const { ask, asked } = job({ models: [saved({ uses: ['talk'] })], reply: () => { throw Object.assign(new Error('Groq refused the API key.'), { status: 401 }); } });
  await assert.rejects(ask({ system: 'S', prompt: 'hi' }), /refused the API key/);
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
