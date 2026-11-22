/**
 * Tools for a model to call (2026-11-21): Claude given them, its reply read as words and calls, streamed or whole,
 * and kept as it sent it so its own blocks can go back to it with the calls' results.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelRequest, normalizeModelConfig, requestModel, supportsTools, ToolsUnsupportedError } from '../jester-extension/src/background/model-client.js';
import { createPooledModelClient } from '../jester-extension/src/background/model-pool.js';
import { createModelJob } from '../desktop/src/main/model-jobs.js';

const key = 'user-secret-api-key';
const claude = normalizeModelConfig({ provider: 'anthropic', key, model: 'claude-haiku-5-5' });
const groq = normalizeModelConfig({ provider: 'groq', key, model: 'openai/gpt-oss-120b' });
const TOOLS = [
  { name: 'send_message', description: 'Text someone from Messages.', input_schema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] }, run: () => 'never sent to the model' },
  { name: 'ask_user', description: 'Ask the user.', input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } }
];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const events = (chunks) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('Claude is given the tools before its cached system prompt, and this turn’s calls and results after the prompt, as they were', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'text', text: 'One moment.' }, { type: 'tool_use', id: 'toolu_1', name: 'send_message', input: { to: 'Dad', text: 'hi' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The text is ready in Messages.' }] }
  ];
  const body = JSON.parse(buildModelRequest(claude, { system: 'You are Jester.', prompt: 'text Dad hi', history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi.' }], tools: TOOLS, messages, stream: true }).init.body);
  assert.deepEqual(body.tools, TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })), 'only what the API takes: no strict, nothing of the host’s');
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are Jester.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi.' }, { role: 'user', content: 'text Dad hi' }, ...messages]);
  assert.deepEqual(body.output_config, { effort: 'low' }, 'not held to a JSON reply: its reply is words and calls');
  assert.equal(body.stream, true);
  // With no tools, nothing of this is sent.
  const plain = JSON.parse(buildModelRequest(claude, { system: 's', prompt: 'p', messages }).init.body);
  assert.equal('tools' in plain, false);
  assert.equal(plain.messages.length, 1);
});

test('only Claude can be given tools: anyone else says so, for the caller to ask the old way', async () => {
  assert.equal(supportsTools({ provider: 'anthropic', model: 'claude-haiku-5-5' }), true);
  assert.equal(supportsTools(claude), true);
  assert.equal(supportsTools({ provider: 'groq', model: 'openai/gpt-oss-120b' }), false);
  assert.equal(supportsTools({ provider: 'ollama', model: 'qwen3.5:9b' }), false);
  assert.throws(() => buildModelRequest(groq, { system: 's', prompt: 'p', tools: TOOLS }), ToolsUnsupportedError);
  await assert.rejects(requestModel({ config: groq, system: 's', prompt: 'p', tools: TOOLS, fetchImpl: async () => assert.fail('never sent') }), { code: 'tools_unsupported' });
});

test('a reply with tools is its words and its calls, with its blocks kept whole; it’s never read as JSON', async () => {
  const content = [{ type: 'text', text: 'Sure, texting your dad.' }, { type: 'tool_use', id: 'toolu_9', name: 'send_message', input: { to: 'Dad', text: 'how are you doing?' } }];
  const reply = await requestModel({ config: claude, system: 's', prompt: 'text dad', tools: TOOLS, plain: true,
    fetchImpl: async () => json({ content, stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 40 } }) });
  assert.equal(reply.text, 'Sure, texting your dad.');
  assert.deepEqual(reply.calls, [{ id: 'toolu_9', name: 'send_message', input: { to: 'Dad', text: 'how are you doing?' } }]);
  assert.deepEqual(reply.content, content);
  assert.equal(reply.stopReason, 'tool_use');
  assert.equal(reply.json, null);
  assert.equal(reply.timings.inputTokens, 900);
  // Just words: no calls, and still no JSON wanted.
  const words = await requestModel({ config: claude, system: 's', prompt: 'hi', tools: TOOLS, fetchImpl: async () => json({ content: [{ type: 'text', text: 'Evening. Good to hear you.' }], stop_reason: 'end_turn' }) });
  assert.deepEqual(words.calls, []);
  assert.equal(words.text, 'Evening. Good to hear you.');
});

test('read as it’s written, its words are told as they come and its blocks are put back together: thinking, words, calls', async () => {
  const stream = [
    `event: message_start\n${data({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 1800, output_tokens: 1 } } })}`,
    `event: content_block_start\n${data({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`,
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } })}`,
    `event: content_block_stop\n${data({ type: 'content_block_stop', index: 0 })}`,
    `event: content_block_start\n${data({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Sure, ' } })}`,
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'texting your dad.' } })}`,
    `event: content_block_stop\n${data({ type: 'content_block_stop', index: 1 })}`,
    `event: content_block_start\n${data({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_5', name: 'send_message', input: {} } })}`,
    // A call's input comes in pieces of JSON, split anywhere.
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"to":"Da' } })}`,
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'd","text":"how are you doing?"}' } })}`,
    `event: content_block_stop\n${data({ type: 'content_block_stop', index: 2 })}`,
    `event: content_block_start\n${data({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_6', name: 'ask_user', input: {} } })}`,
    `event: content_block_delta\n${data({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"question": "Whi' } })}`,
    `event: content_block_stop\n${data({ type: 'content_block_stop', index: 3 })}`,
    `event: message_delta\n${data({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 44 } })}`,
    `event: message_stop\n${data({ type: 'message_stop' })}`
  ];
  const heard = [];
  const reply = await requestModel({ config: claude, system: 's', prompt: 'text dad', tools: TOOLS, onText: (text) => heard.push(text), fetchImpl: async () => events(stream) });
  assert.deepEqual(heard, ['Sure, ', 'Sure, texting your dad.']);
  assert.equal(reply.text, 'Sure, texting your dad.');
  assert.deepEqual(reply.content, [
    { type: 'thinking', thinking: '', signature: 'sig-abc' },
    { type: 'text', text: 'Sure, texting your dad.' },
    { type: 'tool_use', id: 'toolu_5', name: 'send_message', input: { to: 'Dad', text: 'how are you doing?' } },
    // Input that never became JSON is a call with none: whoever runs it refuses it, and says so.
    { type: 'tool_use', id: 'toolu_6', name: 'ask_user', input: {} }
  ]);
  assert.deepEqual(reply.calls.map((call) => call.name), ['send_message', 'ask_user']);
  assert.equal(reply.usage.output_tokens, 44);
});

test('a request with tools goes only to a model that can be given them', async () => {
  const saved = [
    { id: 'g', provider: 'groq', model: 'openai/gpt-oss-120b', key: 'k', plan: 'free', uses: ['talk'], cooldownUntil: 0 },
    { id: 'c', provider: 'anthropic', model: 'claude-haiku-5-5', key: 'k', plan: 'paid', uses: ['talk'], cooldownUntil: 0 }
  ];
  const asked = [];
  const pool = createPooledModelClient({ load: async () => saved, markLimited: async () => undefined, governor: { waitMs: async () => 0, record: async () => undefined, tokensPerMinute: async () => null },
    request: async (options) => (asked.push(options.config.provider), { json: null, text: 'ok', calls: [], content: [], usage: null, timings: {} }) });
  await pool({ system: 's', prompt: 'p', tools: TOOLS });
  await pool({ system: 's', prompt: 'p' });
  assert.deepEqual(asked, ['anthropic', 'groq'], 'with tools: Claude, though Groq was saved first; without: as saved');
  const none = createPooledModelClient({ load: async () => [saved[0]], governor: { waitMs: async () => 0, record: async () => undefined, tokensPerMinute: async () => null }, request: async () => assert.fail('nobody to ask') });
  await assert.rejects(none({ system: 's', prompt: 'p', tools: TOOLS }), { code: 'no_tool_model' });
});

test('the talking job says whether its first model takes tools, and stops saying so while that one’s being left alone', async () => {
  let time = 1000;
  let fail = false;
  const models = [
    { id: 'c', provider: 'anthropic', model: 'claude-haiku-5-5', key: 'k', plan: 'paid', uses: ['talk'], cooldownUntil: 0 },
    { id: 'g', provider: 'groq', model: 'openai/gpt-oss-120b', key: 'k', plan: 'free', uses: ['talk'], cooldownUntil: 0 }
  ];
  const asked = [];
  const ask = createModelJob({ job: 'talk', saved: async () => models, local: async () => ({ model: '', uses: [] }), keepAlive: '2m', markLimited: async () => undefined, now: () => time,
    request: async (options) => {
      asked.push(`${options.config.provider}${options.tools ? '+tools' : ''}`);
      if (fail && options.config.provider === 'anthropic') throw Object.assign(new Error('Claude is having trouble.'), { code: 'http_error', status: 529 });
      return { json: { say: 'Hi.' }, text: 'Hi.', calls: [], content: [], usage: null, timings: {} };
    } });
  assert.equal(await ask.usesTools(), true);
  await ask({ system: 's', prompt: 'p', tools: TOOLS });
  assert.deepEqual(asked, ['anthropic+tools']);
  // Claude down: with tools there's nobody else, so the failure is the caller's to cover by asking for JSON.
  fail = true;
  await assert.rejects(ask({ system: 's', prompt: 'p', tools: TOOLS }), /having trouble/);
  assert.equal(await ask.usesTools(), false, 'left alone for a minute: the next turns don’t wait on it');
  assert.equal((await ask({ system: 's', prompt: 'p' })).json.say, 'Hi.');
  assert.equal(asked.at(-1), 'groq');
  time += 61 * 1000;
  assert.equal(await ask.usesTools(), true);
  // Groq first: no tools, whatever comes after it.
  const groqFirst = createModelJob({ job: 'talk', saved: async () => [...models].reverse(), paidFirst: () => false, local: async () => ({ model: '', uses: [] }), keepAlive: '2m', request: async () => ({}) });
  assert.equal(await groqFirst.usesTools(), false);
});
