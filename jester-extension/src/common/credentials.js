/** Provider configuration is worker-owned and deliberately outside broadcast settings. */
export const PROVIDERS = {
  openai: { label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  google: { label: 'Google (Gemini)', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  groq: { label: 'Groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  custom: { label: 'Custom OpenAI-compatible API', protocol: 'openai-compatible', baseUrl: '' }
};
const STORE_KEY = 'modelConnections';
const LEGACY_STORE_KEY = 'modelConnection';
const MAX_CONNECTIONS = 20;
let storageQueue = Promise.resolve();

// The service worker owns this module. Serialize read/modify/write operations so a
// cooldown update cannot overwrite a connection saved while a request was pending.
function withConnections(operation) {
  const result = storageQueue.then(operation);
  storageQueue = result.catch(() => {});
  return result;
}

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(id);
}

function newId() {
  return globalThis.crypto?.randomUUID?.()
    || `connection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sameConnection(a, b) {
  return a.provider === b.provider && a.baseUrl === b.baseUrl
    && a.model === b.model && a.key === b.key;
}

function publicSummary(connections) {
  const summaries = connections.map(({ key, ...config }) => ({ ...config, masked: maskKey(key) }));
  if (!summaries.length) return { connected: false, connections: [] };
  return { ...summaries[0], connected: true, connections: summaries };
}

async function persistConnections(connections) {
  await chrome.storage.local.set({ [STORE_KEY]: connections, modelConnectionConfigured: true });
  await chrome.storage.local.remove(LEGACY_STORE_KEY);
}

async function readConnections() {
  const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  if (stored !== undefined) {
    if (!Array.isArray(stored)) return [];
    const connections = [];
    const ids = new Set();
    for (const entry of stored.slice(0, MAX_CONNECTIONS)) {
      try {
        if (!validId(entry?.id) || ids.has(entry.id)) continue;
        const config = normaliseConnection(entry);
        if (connections.some((other) => sameConnection(other, config))) continue;
        const cooldownUntil = Number.isFinite(entry.cooldownUntil) && entry.cooldownUntil >= 0
          ? entry.cooldownUntil : 0;
        connections.push({ id: entry.id, ...config, cooldownUntil });
        ids.add(entry.id);
      } catch { /* Invalid entries are never available for inference. */ }
    }
    return connections;
  }
  const legacy = (await chrome.storage.local.get(LEGACY_STORE_KEY))[LEGACY_STORE_KEY];
  if (legacy === undefined) return [];
  let connections = [];
  try { connections = [{ id: 'legacy', ...normaliseConnection(legacy), cooldownUntil: 0 }]; }
  catch { /* Preserve the configured marker even for an invalid legacy connection. */ }
  await persistConnections(connections);
  return connections;
}
export function normaliseConnection(input) {
  if (!Object.hasOwn(PROVIDERS, input?.provider)) throw new Error('Choose a supported provider.');
  const preset = PROVIDERS[input.provider];
  const url = new URL(input.provider === 'custom' ? input.baseUrl : preset.baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS, or HTTP on localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL must not contain credentials, query parameters, or a fragment.');
  const model = String(input.model || '').trim();
  if (!model || model.length > 200 || /[\r\n\x00]/.test(model)) throw new Error('Enter the model ID from your provider.');
  const key = String(input.key || '').trim();
  if ((!key && !local) || key.length > 2000 || /\s/.test(key)) throw new Error('Paste the complete API key without spaces.');
  // Free-tier connections are paced to conservative published limits until the
  // provider reports its own; Gemini reports none until a request is refused.
  const plan = ['free', 'paid'].includes(input.plan) ? input.plan : FREE_TIER_PROVIDERS.has(input.provider) ? 'free' : 'paid';
  return { provider: input.provider, protocol: preset.protocol, baseUrl: url.href.replace(/\/$/, ''), model, key, plan };
}
const FREE_TIER_PROVIDERS = new Set(['google', 'groq']);
export function connectionOrigin(input) {
  return `${new URL(input.baseUrl).origin}/*`;
}
export function maskKey(key) {
  return key ? `••••••••${key.slice(-4)}` : 'Local connection';
}
export function loadConnections() {
  return withConnections(readConnections);
}

export function loadConnection(id) {
  return withConnections(async () => {
    const connections = await readConnections();
    return (id === undefined ? connections[0] : connections.find((config) => config.id === id)) || null;
  });
}

export function connectionSummary() {
  return withConnections(async () => publicSummary(await readConnections()));
}

export async function saveConnection(input) {
  const config = normaliseConnection(input);
  const id = input.id;
  if (id !== undefined && !validId(id)) throw new Error('Choose a saved model connection.');
  if (!(await chrome.permissions.contains({ origins: [connectionOrigin(config)] }))) {
    throw new Error('Allow access to this API provider using Connect in Settings.');
  }
  return withConnections(async () => {
    const connections = await readConnections();
    const existing = id === undefined ? -1 : connections.findIndex((entry) => entry.id === id);
    if (id !== undefined && existing < 0) throw new Error('This model connection is no longer saved.');
    const duplicate = connections.findIndex((entry) => sameConnection(entry, config));
    if (duplicate >= 0 && duplicate !== existing) {
      if (existing >= 0) throw new Error('This model connection is already saved.');
      return publicSummary(connections);
    }
    if (existing >= 0) {
      const previous = connections[existing];
      connections[existing] = { id: previous.id, ...config,
        cooldownUntil: sameConnection(previous, config) ? previous.cooldownUntil : 0 };
    } else {
      if (connections.length >= MAX_CONNECTIONS) throw new Error(`You can save up to ${MAX_CONNECTIONS} model connections.`);
      connections.push({ id: newId(), ...config, cooldownUntil: 0 });
    }
    await persistConnections(connections);
    return publicSummary(connections);
  });
}

export function clearConnection(id) {
  return withConnections(async () => {
    if (id === undefined) {
      await chrome.storage.local.set({ modelConnectionConfigured: true });
      await chrome.storage.local.remove(STORE_KEY);
      await chrome.storage.local.remove(LEGACY_STORE_KEY);
      return publicSummary([]);
    }
    const connections = await readConnections();
    const next = connections.filter((entry) => entry.id !== id);
    if (next.length === connections.length) throw new Error('This model connection is no longer saved.');
    await persistConnections(next);
    return publicSummary(next);
  });
}

export function reorderConnections(ids) {
  return withConnections(async () => {
    const connections = await readConnections();
    if (!Array.isArray(ids) || ids.length !== connections.length || new Set(ids).size !== ids.length
      || ids.some((id) => !connections.some((entry) => entry.id === id))) {
      throw new Error('The model order must include each saved connection exactly once.');
    }
    const reordered = ids.map((id) => connections.find((entry) => entry.id === id));
    await persistConnections(reordered);
    return publicSummary(reordered);
  });
}

export function coolDownConnection(id, until) {
  return withConnections(async () => {
    if (!Number.isFinite(until) || until < 0) throw new Error('Invalid model cooldown.');
    const connections = await readConnections();
    const index = connections.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('This model connection is no longer saved.');
    const [limited] = connections.splice(index, 1);
    limited.cooldownUntil = Math.max(limited.cooldownUntil, until);
    connections.push(limited);
    await persistConnections(connections);
    return publicSummary(connections);
  });
}
/** Lists model IDs on explicit request; never performs inference or switches models. */
export async function listConnectionModels(id) {
  const config = await loadConnection(id);
  if (!config) throw new Error('Save a connection first.');
  const headers = config.protocol === 'anthropic'
    ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : config.protocol === 'gemini' ? { 'x-goog-api-key': config.key } : config.key ? { Authorization: `Bearer ${config.key}` } : {};
  const controller = new AbortController();
  let timeout;
  try {
    const expired = new Promise((_,reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('The model list timed out. Enter a model ID manually.')); },10000);
    });
    const request = (async () => {
      const response = await fetch(`${config.baseUrl}/models`, { headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}. You can enter a model ID manually.`);
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const {value,done} = await reader.read();
            if (done) break;
            text += decoder.decode(value,{stream:true});
            if (text.length > 262144) { await reader.cancel(); throw new Error('The model list is too large. Enter a model ID manually.'); }
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
      } else if (response.text) text = await response.text();
      else text = JSON.stringify(await response.json());
      if (text.length > 262144) throw new Error('The model list is too large. Enter a model ID manually.');
      const body = JSON.parse(text);
      return (body.data || body.models || [])
        .filter((m) => config.protocol !== 'gemini' || !Array.isArray(m.supportedGenerationMethods)
          || m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).slice(0, 300);
    })();
    return await Promise.race([request,expired]);
  } finally { clearTimeout(timeout); }
}
