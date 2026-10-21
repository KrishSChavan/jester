import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelRequest, normalizeModelConfig, supportsImages } from '../jester-extension/src/background/model-client.js';
import { createPooledModelClient } from '../jester-extension/src/background/model-pool.js';
import { createRateGovernor } from '../jester-extension/src/background/rate-governor.js';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

const image = { mimeType: 'image/jpeg', data: 'AAAA' };
const config = (provider, model) => normalizeModelConfig({ provider, model, key: 'k' });
const body = (provider, model) => JSON.parse(buildModelRequest(config(provider, model), { system: 's', prompt: 'p', images: [image] }).init.body);

test('a screenshot travels in each provider\'s own image format', () => {
  const gemini = body('google', 'gemini-3.5-flash-lite');
  assert.deepEqual(gemini.contents[0].parts, [{ text: 'p' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }]);
  assert.equal(gemini.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
  const claude = body('anthropic', 'claude-haiku-5-5');
  assert.deepEqual(claude.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.deepEqual(claude.messages[0].content[1], { type: 'text', text: 'p' });
  const chat = body('groq', 'meta-llama/llama-4-scout-17b-16e-instruct');
  assert.deepEqual(chat.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  const responses = body('openai', 'gpt-5-mini');
  assert.deepEqual(responses.input[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' });
  const plain = JSON.parse(buildModelRequest(config('google', 'gemini-3.5-flash-lite'), { system: 's', prompt: 'p' }).init.body);
  assert.equal(plain.generationConfig.mediaResolution, undefined, 'Text-only requests are unchanged');
  assert.deepEqual(plain.contents[0].parts, [{ text: 'p' }]);
});

test('only models known to read images are sent one', () => {
  for (const [provider, model, can] of [['google', 'gemini-3.5-flash-lite', true], ['anthropic', 'claude-sonnet-5-5', true],
    ['groq', 'openai/gpt-oss-120b', false], ['groq', 'llama-3.3-70b-versatile', false],
    ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct', true], ['openai', 'gpt-5-mini', true],
    ['google', 'gemini-embedding-001', false], ['custom', 'my-local-model', false], ['custom', 'qwen2.5-vl-7b', true]]) {
    assert.equal(supportsImages({ provider, model }), can, `${provider} ${model}`);
  }
});

test('the pool routes a screenshot past text-only models, and says so when none can read it', async () => {
  const entries = [{ id: 'g', ...config('groq', 'openai/gpt-oss-120b'), cooldownUntil: 0 },
    { id: 'v', ...config('google', 'gemini-3.5-flash-lite'), cooldownUntil: 0 }];
  const used = [];
  const client = createPooledModelClient({ load: async () => structuredClone(entries), markLimited: async () => {},
    governor: createRateGovernor({ storage: () => undefined }),
    request: async ({ config: chosen, images }) => { used.push([chosen.model, images?.length || 0]); return { json: {} }; } });
  await client({ system: 's', prompt: 'p' });
  await client({ system: 's', prompt: 'p', images: [image] });
  assert.deepEqual(used, [['openai/gpt-oss-120b', 0], ['gemini-3.5-flash-lite', 1]]);
  const textOnly = createPooledModelClient({ load: async () => [entries[0]], markLimited: async () => {},
    governor: createRateGovernor({ storage: () => undefined }), request: async () => ({ json: {} }) });
  await assert.rejects(textOnly({ system: 's', prompt: 'p', images: [image] }), { code: 'no_vision_model' });
});

test('a look attaches one labelled screenshot to the next step only, and at most three per task', async () => {
  const calls = [];
  let looks = 0;
  const replies = [
    { action: { action: 'look' } },
    { action: { action: 'click', elementId: 'p.7' } },
    { action: { action: 'look' } }, { action: { action: 'look' } }, { action: { action: 'look' } },
    { action: { action: 'finish', success: true, say: 'Done.' } }
  ];
  let revision = 0;
  const result = await runAssistant({ text: 'turn on subtitles', env: { provider: 'google', model: 'gemini-3.5-flash-lite', key: 'k' },
    host: {
      observe: async () => ({ ok: true, pageId: 'p', revision: ++revision, url: 'https://watch.example/v', title: 'Player', text: '[p.1] video "Video"', elements: [] }),
      execute: async () => ({ ok: true, detail: 'clicked' }),
      look: async () => { looks++; return { ok: true, image, legend: [{ n: 1, id: 'p.7', role: 'button', name: '(unnamed)' }] }; }
    },
    modelClient: async ({ prompt, images }) => { calls.push({ prompt: JSON.parse(prompt), images }); return { json: replies.shift() }; } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].images, undefined);
  assert.deepEqual(calls[1].images, [image], 'The step after a look sees the screenshot');
  assert.deepEqual(calls[1].prompt.screenshot.legend, ['1=p.7 button "(unnamed)"']);
  assert.equal(calls[2].images, undefined, 'and the step after that does not');
  assert.equal(calls[2].prompt.screenshot, undefined);
  assert.equal(looks, 3, 'A fourth look is refused without asking the host');
  assert.match(calls.at(-1).prompt.lastResult.detail, /used its screenshots/);
});

test('a refused look reaches the model as a result, with no image attached', async () => {
  const calls = [];
  const replies = [{ action: { action: 'look' } }, { action: { action: 'finish', success: false, say: 'Cannot see it.' } }];
  await runAssistant({ text: 'turn on subtitles', env: { provider: 'groq', model: 'openai/gpt-oss-120b', key: 'k' },
    host: { observe: async () => ({ ok: true, pageId: 'p', revision: 1, url: 'https://watch.example/v', title: 'Player', text: '', elements: [] }),
      execute: async () => ({ ok: true }),
      look: async () => ({ ok: false, detail: 'None of your saved models can read screenshots.' }) },
    modelClient: async ({ prompt, images }) => { calls.push({ prompt: JSON.parse(prompt), images }); return { json: replies.shift() }; } });
  assert.equal(calls[1].images, undefined);
  assert.match(calls[1].prompt.lastResult.detail, /can read screenshots/);
});
