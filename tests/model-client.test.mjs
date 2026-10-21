import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelConfig, buildModelRequest, requestModel, parseModelJson, parseRetryAfterMs,
  RateLimitError, ProviderBusyError, ModelTimeoutError, ModelTruncatedError, ModelReplyError, MODEL_REQUEST_LIMITS,
  claudeThinksByDefault } from '../jester-extension/src/background/model-client.js';
import { AGENT_RESPONSE_SCHEMA } from '../jester-extension/src/common/agent-response-schema.js';

const key = 'user-secret-api-key';
const reply = JSON.stringify({ action: { action: 'finish', say: 'Playing.', success: true } });
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const chat = (content = reply) => jsonResponse({ choices: [{ message: { content } }] });
const config = (extra = {}) => normalizeModelConfig({ provider: 'groq', key, model: 'my-exact-model', ...extra });

test('provider adapters send the selected model and parse native response formats', async () => {
  const cases = [
    { provider: 'openai', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1/responses',
      result: { output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: reply }] }] } },
    { provider: 'anthropic', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages',
      result: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: reply }] } },
    { provider: 'google', protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/my-exact-model:generateContent',
      result: { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: reply }] } }] } },
    { provider: 'groq', protocol: 'openai-compatible', endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      result: { choices: [{ message: { content: reply } }] } },
    { provider: 'custom', protocol: 'openai-compatible', baseUrl: 'https://model.example/v1',
      endpoint: 'https://model.example/v1/chat/completions', result: { choices: [{ message: { content: reply } }] } }
  ];
  for (const item of cases) {
    let sent;
    const result = await requestModel({ env: { ...item, model: 'my-exact-model', key }, system: 'Return JSON.', prompt: 'Play episode 1.',
      fetchImpl: async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return jsonResponse(item.result); } });
    assert.equal(sent.url, item.endpoint);
    assert.equal(sent.init.redirect, 'error');
    assert.equal(result.model, 'my-exact-model');
    assert.deepEqual(result.json, JSON.parse(reply));
    assert.equal(sent.url.includes(key), false);
    if (item.provider !== 'google') assert.equal(sent.body.model, 'my-exact-model');
    if (item.provider === 'openai') {
      assert.equal(sent.body.store, false);
      assert.deepEqual(sent.body.text.format, { type: 'json_object' });
    } else if (item.provider === 'anthropic') {
      assert.equal(sent.init.headers['x-api-key'], key);
      assert.equal(sent.init.headers['anthropic-version'], '2023-06-01');
      assert.equal(sent.body.system, 'Return JSON.');
    } else if (item.provider === 'google') {
      assert.equal(sent.init.headers['x-goog-api-key'], key);
      assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
    } else assert.equal(sent.init.headers.authorization, `Bearer ${key}`);
  }
});

test('legacy Groq configuration remains usable without replacing an explicit model', () => {
  const result = normalizeModelConfig({ aiKey: key, aiModel: 'user/model-2026' });
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'user/model-2026');
  assert.equal(result.key, key);
});

test('native Gemini requests constrain action output without changing the selected model or other providers', () => {
  const google = config({provider:'google',model:'gemini-3.5-flash-lite'});
  const request = buildModelRequest(google,{system:'Return an action',prompt:'Choose season 3'});
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.generationConfig.responseJsonSchema,AGENT_RESPONSE_SCHEMA);
  assert.equal(body.generationConfig.responseSchema,undefined);
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.match(request.url,/gemini-3\.5-flash-lite:generateContent$/);
  for (const provider of ['groq','openai','anthropic']) {
    const other = JSON.parse(buildModelRequest(config({provider}),{system:'JSON',prompt:'Task'}).init.body);
    assert.equal(JSON.stringify(other).includes('responseJsonSchema'),false);
  }
});

test('a truncated Gemini action pauses once and is never parsed or retried as executable JSON', async () => {
  let calls=0;
  await assert.rejects(requestModel({config:config({provider:'google'}),system:'JSON',prompt:'Task',
    fetchImpl:async()=>{calls++;return jsonResponse({candidates:[{finishReason:'MAX_TOKENS',
      content:{parts:[{text:'{"action":{"action":"click"'}]}}]});}
  }),error=>{
    assert.ok(error instanceof ModelTruncatedError);
    assert.equal(error.code,'model_output_truncated');
    assert.equal(error.retryable,false);
    assert.equal(error.timings.attempts,1);
    return true;
  });
  assert.equal(calls,1);
});

test('Claude models that think by default get low effort and room to think before the reply', () => {
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
    assert.equal(claudeThinksByDefault(model), true, model);
    const body = JSON.parse(buildModelRequest(config({ provider: 'anthropic', model }), { system: 'JSON', prompt: 'Play.' }).init.body);
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.max_tokens, MODEL_REQUEST_LIMITS.maxOutputTokens + 1500);
    assert.equal(Object.hasOwn(body, 'thinking'), false);
  }
  // Older models think only when asked, and some reject effort outright.
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-3-5-sonnet-latest']) {
    assert.equal(claudeThinksByDefault(model), false, model);
    const body = JSON.parse(buildModelRequest(config({ provider: 'anthropic', model }), { system: 'JSON', prompt: 'Play.' }).init.body);
    assert.equal(Object.hasOwn(body, 'output_config'), false);
    assert.equal(body.max_tokens, MODEL_REQUEST_LIMITS.maxOutputTokens);
  }
});

test('a reply cut off at the output limit is typed for every provider and never parsed', async () => {
  const partial = '{"action":{"action":"click"';
  const cases = [
    ['anthropic', { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: partial }], stop_reason: 'max_tokens' }],
    ['anthropic', { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' }],
    ['groq', { choices: [{ message: { content: partial }, finish_reason: 'length' }] }],
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: partial }]
  ];
  for (const [provider, result] of cases) {
    await assert.rejects(requestModel({ config: config({ provider }), system: 'JSON', prompt: 'Task',
      fetchImpl: async () => jsonResponse(result) }), (error) => {
      assert.ok(error instanceof ModelTruncatedError, provider);
      assert.equal(error.code, 'model_output_truncated');
      return true;
    });
  }
  await assert.rejects(requestModel({ config: config({ provider: 'anthropic', model: 'claude-haiku-5-5' }), system: 'JSON',
    prompt: 'Task', fetchImpl: async () => jsonResponse({ content: [], stop_reason: 'refusal' }) }),
  { code: 'model_refusal' });
});

test('unreadable replies are typed so the assistant can ask again', () => {
  for (const raw of ['', '   ', '{"action":', 'Sure, clicking it now.']) {
    assert.throws(() => parseModelJson(raw), (error) => {
      assert.ok(error instanceof ModelReplyError);
      assert.equal(error.code, 'invalid_json');
      return true;
    });
  }
});

test('endpoint configuration rejects insecure remote URLs and credentials, permits local models', () => {
  assert.throws(() => config({ provider: 'custom', baseUrl: 'http://remote.example/v1' }), /HTTPS/);
  assert.throws(() => config({ provider: 'custom', baseUrl: 'https://u:p@remote.example/v1' }), /HTTPS/);
  assert.throws(() => config({ provider: 'custom', baseUrl: 'https://remote.example/v1?key=secret' }), /HTTPS/);
  assert.throws(() => normalizeModelConfig({ provider: 'openai', key }), /model ID/);
  const local = normalizeModelConfig({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'local-model' });
  const request = buildModelRequest(local, { system: 'JSON', prompt: 'Play.' });
  assert.equal(request.init.headers.authorization, undefined);
  assert.equal(request.url, 'http://localhost:11434/v1/chat/completions');
});

test('interactive retry makes at most two attempts and keeps exactly the selected model', async () => {
  const sent = [];
  const result = await requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
    fetchImpl: async (_, init) => {
      sent.push(JSON.parse(init.body).model);
      return sent.length < 2 ? jsonResponse({ error: { message: 'Rate limit' } }, 429, { 'retry-after': '0' }) : chat();
    } });
  assert.equal(result.model, 'my-exact-model');
  assert.deepEqual(sent, ['my-exact-model', 'my-exact-model']);
  assert.equal(result.timings.attempts, 2);
  assert.ok(result.timings.retryWaitMs >= 20);
});

test('retired model and daily quota errors do not switch to another model', async () => {
  for (const [status, message] of [[404, 'model retired'], [429, 'tokens per day exceeded']]) {
    let calls = 0;
    await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
      fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message } }, status); } }));
    assert.equal(calls, 1);
  }
});

test('API errors redact the configured key', async () => {
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
    fetchImpl: async () => jsonResponse({ error: { message: `invalid parameter ${key}` } }, 400) }), (error) => {
    assert.equal(error.message.includes(key), false);
    assert.match(error.message, /redacted/);
    return true;
  });
});

test('timeout includes a stalled fetch even if the transport ignores AbortSignal', async () => {
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', timeoutMs: 15,
    fetchImpl: async () => new Promise(() => {}) }), /too long/);
});

test('timeout remains active while reading the response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; } });
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', timeoutMs: 15,
    fetchImpl: async () => new Response(body) }), /too long/);
  assert.equal(cancelled, true);
});

test('AbortSignal cancels rate limit backoff before another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', signal: controller.signal,
    onRetry: () => controller.abort(), fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'Try again in 100ms' } }, 429);
    } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a pre-aborted signal prevents the request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', signal: controller.signal,
    fetchImpl: async () => { calls += 1; return chat(); } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('responses are bounded and JSON parsing does not fish an action out of prose', async () => {
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
    fetchImpl: async () => chat('x'.repeat(70000)) }), /size limit/);
  assert.throws(() => parseModelJson(`Here is the answer: ${reply}`), /valid JSON/);
  assert.deepEqual(parseModelJson(`\`\`\`json\n${reply}\n\`\`\``), JSON.parse(reply));
});

test('known Groq GPT-OSS models use documented low effort and suppress returned reasoning', () => {
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
    const request = buildModelRequest(config({ model }), { system: 'JSON', prompt: 'Play.' });
    const body = JSON.parse(request.init.body);
    assert.equal(body.model, model);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.include_reasoning, false);
    assert.equal(Object.hasOwn(body, 'reasoning_format'), false);
    assert.equal(body.max_completion_tokens, 600);
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  }
  for (const selected of [config({ model: 'a-different-model' }),
    config({ provider: 'custom', baseUrl: 'https://model.example/v1', model: 'openai/gpt-oss-120b' })]) {
    const body = JSON.parse(buildModelRequest(selected, { system: 'JSON', prompt: 'Play.' }).init.body);
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    assert.equal(Object.hasOwn(body, 'include_reasoning'), false);
  }
  assert.equal(MODEL_REQUEST_LIMITS.maxElapsedMs, 10000);
  assert.equal(MODEL_REQUEST_LIMITS.maxRetryWaitMs, 1000);
  assert.equal(MODEL_REQUEST_LIMITS.maxRetries, 1);
});

test('an explicit output budget reaches the provider without selecting another model', async () => {
  let sent;
  await requestModel({ config: config({ model: 'openai/gpt-oss-120b' }), system: 'JSON', prompt: 'Play.', maxOutputTokens: 480,
    fetchImpl: async (_, init) => { sent = JSON.parse(init.body); return chat(); } });
  assert.equal(sent.max_completion_tokens, 480);
  assert.equal(sent.model, 'openai/gpt-oss-120b');
});

test('Retry-After preserves actual seconds, dates, milliseconds, and longer body hints', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const cases = [
    [{ 'retry-after': '60' }, '', 60000],
    [{ 'retry-after': 'Mon, 19 Oct 2026 12:00:30 GMT' }, '', 30000],
    [{ 'retry-after': 'Mon, 19 Oct 2026 11:59:59 GMT' }, '', 0],
    [{ 'retry-after-ms': '75' }, '', 75],
    [{ 'retry-after': '1' }, 'Please try again in 1.5s.', 1500],
    [{}, 'Please try again in 1m2.5s.', 62500],
    [{}, '{"retryDelay":"2s"}', 2000],
    [{ 'retry-after': '-3' }, '', null],
    [{ 'retry-after': 'invalid' }, 'Please try again in 80ms.', 80]
  ];
  for (const [headers, body, expected] of cases) assert.equal(parseRetryAfterMs(new Headers(headers), body, now), expected);
  // A client clock ahead of the provider must not cause an early retry.
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': 'Mon, 19 Oct 2026 12:00:30 GMT',
    date: 'Mon, 19 Oct 2026 12:00:00 GMT' }), '', now + 60000), 30000);
});

test('long rate limits pause immediately with actual cooldown and no misleading wait banner', async () => {
  let calls = 0;
  let banners = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', onRetry: () => { banners += 1; },
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message: `Try again in 90s. ${key}` } }, 429,
      { 'retry-after': '60' }); } }), (error) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.code, 'rate_limit');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 90000);
    assert.equal(error.retryable, true);
    assert.equal(error.timings.attempts, 1);
    assert.equal(error.timings.retryWaitMs, 0);
    assert.equal(error.message.includes(key), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(banners, 0);
});

test('a short retry waits at least the provider delay and reports the precise reason', async () => {
  for (const [status, reason] of [[429, 'rate_limited'], [503, 'provider_busy']]) {
    const starts = [];
    const banners = [];
    const result = await requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
      onRetry: (info) => banners.push(info), fetchImpl: async () => {
        starts.push(performance.now());
        return starts.length === 1 ? jsonResponse({ error: { message: 'Temporarily unavailable' } }, status,
          { 'retry-after': '0.06' }) : chat();
      } });
    assert.ok(starts[1] - starts[0] >= 59, 'Must not retry before the required 60 ms');
    assert.equal(banners.length, 1);
    assert.equal(banners[0].reason, reason);
    assert.equal(banners[0].provider, 'groq');
    assert.equal(banners[0].delayMs, 60);
    assert.equal(banners[0].status, status);
    assert.equal(result.timings.attempts, 2);
  }
});

test('busy and daily quota failures are typed and never multiply automatic retries', async () => {
  for (const status of [502, 503]) {
    let calls = 0;
    await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'Busy' } }, status, { 'retry-after': '12' });
    } }), (error) => {
      assert.ok(error instanceof ProviderBusyError);
      assert.equal(error.code, 'provider_busy');
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 12000);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.',
    fetchImpl: async () => jsonResponse({ error: { message: 'Tokens per day exceeded' } }, 429) }), (error) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryable, false);
    assert.equal(error.timings.attempts, 1);
    return true;
  });
  let calls = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', maxRetries: 99,
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message: 'Rate limit' } }, 429, { 'retry-after': '0' }); }
  }), RateLimitError);
  assert.equal(calls, 2);
});

test('the overall deadline includes the first request, retry wait, and a stalled second request', async () => {
  let calls = 0;
  const startedAt = performance.now();
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', maxElapsedMs: 80, timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse({ error: { message: 'Busy' } }, 503, { 'retry-after': '0.03' });
    } }), (error) => {
    assert.ok(error instanceof ModelTimeoutError);
    assert.equal(error.code, 'model_timeout');
    assert.equal(error.timings.attempts, 2);
    assert.ok(error.timings.retryWaitMs >= 25);
    assert.ok(error.timings.requestMs >= 15);
    return true;
  });
  assert.equal(calls, 2);
  assert.ok(performance.now() - startedAt < 400, 'Retry must not receive a fresh 1000 ms timeout');
});

test('a stalled retry callback is covered by the overall deadline', async () => {
  let calls = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', maxElapsedMs: 60,
    onRetry: async () => new Promise(() => {}), fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'Busy' } }, 503, { 'retry-after': '0' });
    } }), ModelTimeoutError);
  assert.equal(calls, 1);
});

test('the interactive wait budget never truncates a provider delay to retry early', async () => {
  let calls = 0;
  await assert.rejects(requestModel({ config: config(), system: 'JSON', prompt: 'Play.', maxRetryWaitMs: 20,
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message: 'Rate limit' } }, 429,
      { 'retry-after': '0.05' }); } }), (error) => {
    assert.equal(error.retryAfterMs, 50);
    assert.equal(error.timings.retryWaitMs, 0);
    return true;
  });
  assert.equal(calls, 1);
});

test('timings include actual requests, retries, and provider token counts without prompt/key content', async () => {
  const cases = [
    { config: config(), result: { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 42, completion_tokens: 18 } } },
    { config: config({ provider: 'openai' }), result: { output_text: reply, usage: { input_tokens: 42, output_tokens: 18 } } },
    { config: config({ provider: 'anthropic' }), result: { content: [{ type: 'text', text: reply }], usage: { input_tokens: 42, output_tokens: 18 } } },
    { config: config({ provider: 'google' }), result: { candidates: [{ content: { parts: [{ text: reply }] } }], usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 18 } } }
  ];
  for (const item of cases) {
    const result = await requestModel({ config: item.config, system: 'Private prompt', prompt: 'Private command',
      fetchImpl: async () => jsonResponse(item.result) });
    assert.equal(result.timings.inputTokens, 42);
    assert.equal(result.timings.outputTokens, 18);
    assert.equal(result.timings.attempts, 1);
    assert.equal(result.timings.retryWaitMs, 0);
    assert.ok(result.timings.totalMs >= result.timings.requestMs);
    assert.equal(JSON.stringify(result.timings).includes(key), false);
    assert.equal(JSON.stringify(result.timings).includes('Private'), false);
  }
});
