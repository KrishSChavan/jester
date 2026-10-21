import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, normaliseConnection, connectionOrigin, saveConnection, loadConnection,
  loadConnections, connectionSummary, clearConnection, listConnectionModels,
  reorderConnections, coolDownConnection } from '../jester-extension/src/common/credentials.js';

const secret = 'private-provider-secret-1234567890';
function mockChrome(t, { stored = {}, permitted = [] } = {}) {
  const original = globalThis.chrome;
  const values = structuredClone(stored);
  const checks = [];
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(values[key]) }),
      set: async (patch) => Object.assign(values, structuredClone(patch)),
      remove: async (key) => { delete values[key]; }
    } },
    permissions: { contains: async ({ origins }) => { checks.push(origins); return origins.every((origin) => permitted.includes(origin)); } }
  };
  t.after(() => { if (original === undefined) delete globalThis.chrome; else globalThis.chrome = original; });
  return { values, checks };
}

test('saving a provider binds its key to the known endpoint and returns only public metadata', async (t) => {
  const { values, checks } = mockChrome(t, { permitted: ['https://api.openai.com/*'] });
  const summary = await saveConnection({ provider: 'openai', protocol: 'anthropic', baseUrl: 'https://attacker.example/v1',
    model: 'user-chosen-model', key: secret });
  assert.equal(summary.baseUrl, PROVIDERS.openai.baseUrl);
  assert.equal(summary.protocol, 'openai-responses');
  assert.equal(summary.model, 'user-chosen-model');
  assert.equal(summary.connected, true);
  assert.equal(Object.hasOwn(summary, 'key'), false);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(values.modelConnections[0].key, secret);
  assert.equal(values.modelConnection, undefined);
  assert.equal(values.modelConnectionConfigured, true);
  assert.deepEqual(checks, [['https://api.openai.com/*']]);
  assert.equal((await loadConnection()).key, secret);
  assert.equal(JSON.stringify(await connectionSummary()).includes(secret), false);
});

test('changing a provider or custom endpoint never silently reuses the previous key', async (t) => {
  const previous = normaliseConnection({ provider: 'custom', baseUrl: 'https://first.example/v1', model: 'my-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: previous }, permitted: ['https://second.example/*', 'https://api.anthropic.com/*'] });
  await assert.rejects(saveConnection({ provider: 'custom', baseUrl: 'https://second.example/v1', model: 'another-model' }), /API key/);
  await assert.rejects(saveConnection({ provider: 'anthropic', model: 'my-claude-model' }), /API key/);
  assert.deepEqual(values.modelConnection, previous);
});

test('a new endpoint requires its own Chrome origin permission before saving credentials', async (t) => {
  const previous = normaliseConnection({ provider: 'custom', baseUrl: 'https://first.example/v1', model: 'my-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: previous }, permitted: ['https://first.example/*'] });
  await assert.rejects(saveConnection({ provider: 'custom', baseUrl: 'https://second.example/v1', model: 'my-model', key: 'new-provider-key' }), /Allow access/);
  assert.deepEqual(values.modelConnection, previous);
});

test('unsafe endpoint URLs and malformed keys/models never enter storage', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://provider.example/*'] });
  for (const baseUrl of ['http://provider.example/v1', 'javascript:alert(1)', 'file:///tmp/model',
    'https://u:password@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#secret']) {
    await assert.rejects(saveConnection({ provider: 'custom', baseUrl, model: 'my-model', key: secret }));
  }
  for (const model of ['', 'model\nother', 'model\0', 'm'.repeat(201)]) {
    assert.throws(() => normaliseConnection({ provider: 'groq', model, key: secret }));
  }
  assert.throws(() => normaliseConnection({ provider: 'groq', model: 'my-model', key: 'key with whitespace' }));
  assert.throws(() => normaliseConnection({ provider: '__proto__', model: 'my-model', key: secret }));
  assert.equal(values.modelConnection, undefined);
});

test('a local custom model can omit a key and exposes only a local-connection summary', async (t) => {
  mockChrome(t, { permitted: ['http://localhost:11434/*'] });
  const summary = await saveConnection({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'local-model' });
  assert.equal(summary.connected, true);
  assert.equal(summary.masked, 'Local connection');
  assert.equal(Object.hasOwn(summary, 'key'), false);
  assert.equal(connectionOrigin(summary), 'http://localhost:11434/*');
});

test('invalid persisted connections are unavailable and disconnect removes the secret', async (t) => {
  const { values } = mockChrome(t, { stored: { modelConnection: { provider: 'custom', baseUrl: 'http://insecure.example', model: 'bad', key: secret } } });
  assert.equal(await loadConnection(), null);
  assert.deepEqual(await connectionSummary(), { connected: false, connections: [] });
  assert.deepEqual(await clearConnection(), { connected: false, connections: [] });
  assert.equal(values.modelConnection, undefined);
  assert.equal(values.modelConnectionConfigured, true);
});

test('explicit disconnect preserves the marker that blocks legacy provider fallback', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  await saveConnection({ provider: 'groq', model: 'chosen-model', key: secret });
  assert.equal(values.modelConnectionConfigured, true);
  await clearConnection();
  assert.equal(await loadConnection(), null);
  assert.deepEqual(await connectionSummary(), { connected: false, connections: [] });
  assert.deepEqual(values, { modelConnectionConfigured: true });
  assert.equal(JSON.stringify(values).includes(secret), false);
});

test('model discovery sends the key only to the saved provider and does not change the selected model', async (t) => {
  const saved = normaliseConnection({ provider: 'anthropic', model: 'keep-this-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: saved } });
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ data: Array.from({ length: 350 }, (_, i) => ({ id: `choice-${i}` })) }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const ids = await listConnectionModels();
  assert.equal(ids.length, 300);
  assert.equal(ids[0], 'choice-0');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/models');
  assert.equal(sent.url.includes(secret), false);
  assert.equal(sent.init.headers['x-api-key'], secret);
  assert.equal(sent.init.redirect, 'error');
  assert.ok(sent.init.signal instanceof AbortSignal);
  assert.equal(values.modelConnections[0].model, 'keep-this-model');
  assert.equal(JSON.stringify(ids).includes(secret), false);
});

test('oversized model discovery responses are cancelled and cannot change the saved connection', async (t) => {
  const saved = normaliseConnection({ provider: 'groq', model: 'keep-this-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: saved, modelConnectionConfigured: true } });
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(270000))); },
    cancel() { cancelled = true; }
  }));
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(listConnectionModels(), /too large/);
  assert.equal(cancelled, true);
  assert.deepEqual(normaliseConnection(values.modelConnections[0]), saved);
  assert.equal(values.modelConnectionConfigured, true);
});

test('Gemini model discovery offers generateContent models and preserves metadata-free entries', async (t) => {
  const saved = normaliseConnection({ provider: 'google', model: 'my-saved-gemini-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: saved } });
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/no-generation-methods', supportedGenerationMethods: [] },
      { name: 'models/metadata-unavailable' }
    ] }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(await listConnectionModels(), ['gemini-3.5-flash-lite', 'metadata-unavailable']);
  assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(sent.init.headers['x-goog-api-key'], secret);
  assert.equal(sent.url.includes(secret), false);
  assert.deepEqual(normaliseConnection(values.modelConnections[0]), saved);
});

test('a legacy connection migrates once to an ordered stack with a stable ID', async (t) => {
  const legacy = normaliseConnection({ provider: 'groq', model: 'old-model', key: secret });
  const { values } = mockChrome(t, { stored: { modelConnection: legacy } });
  const connections = await loadConnections();
  assert.deepEqual(connections, [{ id: 'legacy', ...legacy, cooldownUntil: 0 }]);
  assert.deepEqual(values.modelConnections, connections);
  assert.equal(values.modelConnection, undefined);
  assert.equal(values.modelConnectionConfigured, true);
  assert.equal((await loadConnection()).id, 'legacy');
  const summary = await connectionSummary();
  assert.equal(summary.id, 'legacy');
  assert.equal(summary.connections.length, 1);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(Object.hasOwn(summary.connections[0], 'key'), false);
});

test('new connections append in order without replacing existing credentials', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://api.groq.com/*', 'https://generativelanguage.googleapis.com/*'] });
  await saveConnection({ provider: 'groq', model: 'first', key: secret });
  const summary = await saveConnection({ provider: 'google', model: 'second', key: 'different-secret' });
  assert.equal(summary.model, 'first');
  assert.deepEqual(summary.connections.map((entry) => entry.model), ['first', 'second']);
  assert.equal(new Set(summary.connections.map((entry) => entry.id)).size, 2);
  assert.deepEqual(values.modelConnections.map((entry) => entry.key), [secret, 'different-secret']);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('different-secret'), false);
  assert.equal((await loadConnection(summary.connections[1].id)).key, 'different-secret');
  assert.equal(await loadConnection('missing'), null);
});

test('editing a connection requires its explicit key and preserves its place and ID', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*', 'https://generativelanguage.googleapis.com/*'] });
  await saveConnection({ provider: 'groq', model: 'first', key: secret });
  await saveConnection({ provider: 'google', model: 'second', key: 'other-key' });
  const first = (await loadConnections())[0];
  await assert.rejects(saveConnection({ id: first.id, provider: 'google', model: 'edited' }), /API key/);
  await assert.rejects(saveConnection({ id: 'missing', provider: 'google', model: 'edited', key: 'new-key' }), /no longer saved/);
  await coolDownConnection(first.id, 12345);
  const edited = await saveConnection({ id: first.id, provider: 'google', model: 'edited', key: 'new-key' });
  assert.deepEqual(edited.connections.map((entry) => entry.model), ['second', 'edited']);
  assert.equal(edited.connections[1].id, first.id);
  assert.equal(edited.connections[1].cooldownUntil, 0);
  assert.equal((await loadConnection(first.id)).key, 'new-key');
});

test('duplicate adds retain the same ID, order, and provider cooldown', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  const config = { provider: 'groq', model: 'same-model', key: secret };
  await saveConnection(config);
  const first = await loadConnection();
  await coolDownConnection(first.id, 12345);
  const summary = await saveConnection({ ...config, model: ' same-model ' });
  assert.equal(summary.connections.length, 1);
  assert.equal(summary.id, first.id);
  assert.equal(summary.cooldownUntil, 12345);
  await saveConnection({ ...config, model: 'another-model' });
  const other = (await loadConnections())[1];
  await assert.rejects(saveConnection({ ...config, id: other.id }), /already saved/);
  assert.equal((await loadConnections()).length, 2);
});

test('reordering accepts only an exact permutation and persists the selected priority', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  await saveConnection({ provider: 'groq', model: 'first', key: secret });
  await saveConnection({ provider: 'groq', model: 'second', key: secret });
  const ids = (await loadConnections()).map((entry) => entry.id);
  for (const invalid of [null, [], [ids[0]], [ids[0], ids[0]], [ids[0], 'missing'], [...ids, 'extra']]) {
    await assert.rejects(reorderConnections(invalid), /each saved connection/);
  }
  const summary = await reorderConnections([...ids].reverse());
  assert.deepEqual(summary.connections.map((entry) => entry.model), ['second', 'first']);
  assert.equal((await loadConnection()).model, 'second');
  assert.deepEqual(values.modelConnections.map((entry) => entry.id), [...ids].reverse());
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test('rate-limit cooldowns move only the limited connection to the back and survive reload', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  for (const model of ['first', 'second', 'third']) await saveConnection({ provider: 'groq', model, key: secret });
  const first = await loadConnection();
  const summary = await coolDownConnection(first.id, 33000);
  assert.deepEqual(summary.connections.map((entry) => entry.model), ['second', 'third', 'first']);
  assert.deepEqual(values.modelConnections.map((entry) => entry.cooldownUntil), [0, 0, 33000]);
  assert.equal((await loadConnection(first.id)).cooldownUntil, 33000);
  await coolDownConnection(first.id, 1000);
  assert.equal((await loadConnection(first.id)).cooldownUntil, 33000);
  for (const invalid of [NaN, Infinity, -1, '40000']) await assert.rejects(coolDownConnection(first.id, invalid), /Invalid model cooldown/);
  await assert.rejects(coolDownConnection('missing', 40000), /no longer saved/);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test('disconnecting one connection preserves the rest while disconnecting all removes every key', async (t) => {
  const { values } = mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  await saveConnection({ provider: 'groq', model: 'first', key: secret });
  await saveConnection({ provider: 'groq', model: 'second', key: 'second-key' });
  const first = await loadConnection();
  const summary = await clearConnection(first.id);
  assert.equal(summary.model, 'second');
  assert.equal(summary.connections.length, 1);
  assert.equal(JSON.stringify(values).includes(secret), false);
  await assert.rejects(clearConnection(first.id), /no longer saved/);
  await clearConnection();
  assert.deepEqual(values, { modelConnectionConfigured: true });
});

test('concurrent connection saves and cooldown updates cannot lose another write', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveConnection({ provider: 'groq', model: `model-${i}`, key: secret })));
  const before = await loadConnections();
  assert.equal(before.length, 10);
  await Promise.all(before.map((entry, i) => coolDownConnection(entry.id, 10000 + i)));
  const after = await loadConnections();
  assert.deepEqual(after.map((entry) => entry.id), before.map((entry) => entry.id));
  assert.deepEqual(after.map((entry) => entry.cooldownUntil), before.map((_, i) => 10000 + i));
});

test('the stack is bounded at 20 connections while duplicates and edits still work at the limit', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  for (let i = 0; i < 20; i++) await saveConnection({ provider: 'groq', model: `model-${i}`, key: secret });
  await assert.rejects(saveConnection({ provider: 'groq', model: 'overflow', key: secret }), /up to 20/);
  const first = await loadConnection();
  await saveConnection({ provider: 'groq', model: first.model, key: secret });
  await saveConnection({ id: first.id, provider: 'groq', model: 'edited', key: secret });
  assert.equal((await loadConnections()).length, 20);
});

test('invalid stack entries never restore an obsolete legacy connection', async (t) => {
  const config = normaliseConnection({ provider: 'groq', model: 'valid', key: secret });
  mockChrome(t, { stored: { modelConnection: { ...config, model: 'obsolete' }, modelConnections: [
    { id: 'valid', ...config, cooldownUntil: 123 },
    { id: 'valid', ...config, model: 'duplicate-id' },
    { id: 'duplicate-config', ...config },
    { id: '../invalid', ...config, model: 'bad-id' },
    { id: 'bad-provider', ...config, provider: '__proto__' },
    { id: 'other', ...config, model: 'other', cooldownUntil: Infinity }
  ] } });
  const entries = await loadConnections();
  assert.deepEqual(entries.map((entry) => entry.model), ['valid', 'other']);
  assert.deepEqual(entries.map((entry) => entry.cooldownUntil), [123, 0]);
});

test('model discovery can target a saved connection without sending another connection’s key', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*', 'https://generativelanguage.googleapis.com/*'] });
  await saveConnection({ provider: 'groq', model: 'first', key: secret });
  await saveConnection({ provider: 'google', model: 'second', key: 'google-key' });
  const chosen = (await loadConnections())[1];
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ models: [{ name: 'models/choice' }] }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.deepEqual(await listConnectionModels(chosen.id), ['choice']);
  assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(sent.init.headers['x-goog-api-key'], 'google-key');
  assert.equal(JSON.stringify(sent).includes(secret), false);
  assert.equal((await loadConnection()).model, 'first');
});

test('a rejected storage write does not block subsequent connection operations', async (t) => {
  mockChrome(t, { permitted: ['https://api.groq.com/*'] });
  const originalSet = chrome.storage.local.set;
  let rejected = false;
  chrome.storage.local.set = async (patch) => {
    if (!rejected) { rejected = true; throw new Error('Temporary storage error'); }
    return originalSet(patch);
  };
  await assert.rejects(saveConnection({ provider: 'groq', model: 'failed', key: secret }), /Temporary storage error/);
  await saveConnection({ provider: 'groq', model: 'saved', key: secret });
  assert.deepEqual((await loadConnections()).map((entry) => entry.model), ['saved']);
});
