import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const electron = 'data:text/javascript,export const app={},BrowserWindow={},ipcMain={},webContents={getAllWebContents:()=>[]};';
registerHooks({ resolve: (specifier, context, next) => specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context) });
const { createAssistant } = await import('../desktop/src/main/assistant.js');
const url = 'https://example.com/latest';

function rig({ turns = [], web, fail = false, decision = null }) {
  const busy = [];
  const questions = [];
  const research = [];
  const requests = [];
  const assistant = createAssistant({
    driver: { call: async () => assert.fail('research must not read or act on the desktop') },
    openApp: async () => assert.fail('no app opening'), activate: async () => assert.fail('no activation'),
    openUrl: async () => assert.fail('no browser navigation'), dispatch: async () => assert.fail('no input'),
    listen: () => undefined, prompt: { show: (question) => questions.push(question), hide: () => undefined },
    onBusy: (value) => busy.push(value), onResearch: (state) => research.push(state), web,
    modelHooks: { local: async () => ({ model: '', uses: [] }), saved: async () => [{ id: 'test', provider: 'groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', key: 'test', model: 'test-model', uses: ['act'], plan: 'paid' }],
      request: async (request) => {
        requests.push(request);
        if (fail) throw new Error('Research model is unavailable.');
        if (request.schema?.properties?.scrapeConfidence) return { json: decision || { route: 'scrape', goal: JSON.parse(request.prompt).goal, scrapeConfidence: 95, reason: 'Background page reading suits this request.' } };
        return { json: turns.shift() };
      }, markLimited: async () => undefined }
  });
  return { assistant, busy, questions, research, requests };
}
const until = async (condition) => {
  for (let count = 0; count < 100; count += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition did not become true');
};

test('desktop research returns sources and owns stop-button lifecycle with no screen access', async () => {
  const { assistant, busy, questions, research } = rig({ turns: [{ action: 'scrape', url }, { action: 'answer', text: 'Fresh news.', sources: [url] }],
    web: async () => ({ ok: true, url, title: 'News', text: 'Fresh news.', links: [], fetchedAt: '2026-11-16T20:00:00Z', status: 200 }) });
  const result = await assistant.research(`Read ${url}`);
  assert.equal(result.ok, true);
  assert.match(result.text, /Sources:/);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(questions, []);
  assert.equal(assistant.running, false);
  assert.equal(research[0].active, true);
  assert.ok(research.some((state) => state.phase === 'reading'));
  assert.equal(research.at(-1).active, false);
});

test('background failure waits for explicit approval; declining cannot start computer control', async () => {
  const { assistant, questions } = rig({ turns: [{ action: 'fallback', text: 'Canvas requires navigation.' }], web: async () => ({ ok: true, tabs: [] }) });
  const pending = assistant.research('Read my Canvas assignments');
  await until(() => assistant.asking);
  // A read that failed says so, with no score: the model's 95 was for trying.
  assert.match(questions[0], /^I couldn’t read this in the background: Canvas requires navigation\. Should I do “Read my Canvas assignments” by hand instead/);
  assert.doesNotMatch(questions[0], /\/100/);
  assert.equal(assistant.running, true);
  assistant.answer(false);
  const result = await pending;
  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.match(result.text, /left your browser and desktop/);
});

test('approval returns an explicit handoff token without itself using UI controls', async () => {
  const { assistant } = rig({ turns: [{ action: 'fallback', text: 'A browser check is needed.' }], web: async () => ({ ok: false }) });
  const pending = assistant.research('Research the latest news');
  await until(() => assistant.asking);
  assistant.answer(true);
  assert.deepEqual(await pending, { handled: false, approvedInteraction: true, goal: 'Research the latest news', why: 'A browser check is needed.', scrapeConfidence: 95, strategyReason: 'A browser check is needed.' });
});

test('stopping research cancels the in-flight read and suppresses its answer', async () => {
  let started = false;
  let stopped = false;
  const { assistant, busy, research } = rig({ turns: [{ action: 'scrape', url }], web: (_request, { signal }) => new Promise((resolve) => {
    started = true;
    signal.addEventListener('abort', () => { stopped = true; resolve({ ok: false }); }, { once: true });
  }) });
  const pending = assistant.research(`Read ${url}`);
  await until(() => started);
  await assistant.cancel();
  assert.equal(await pending, null);
  assert.equal(stopped, true);
  assert.deepEqual(busy, [true, false]);
  assert.equal(research.at(-1).active, false);
});

test('a routing model failure asks for controls and clears the searching state', async () => {
  const { assistant, research } = rig({ turns: [], fail: true, web: async () => ({ ok: false }) });
  const pending = assistant.research('Search for current launch news');
  await until(() => assistant.asking);
  assistant.answer(false);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(research.find((state) => state.phase === 'review').active, false);
  assert.equal(research.at(-1).active, false);
});

test('a bare search asks for a topic without a model, read or interaction', async () => {
  const { assistant, requests, questions, research } = rig({ web: async () => assert.fail('no reads before a topic') });
  const result = await assistant.research('search');
  assert.equal(result.handled, true);
  assert.match(result.text, /What.*search for\?/);
  assert.deepEqual(result.clarification, { goal: 'search', question: result.text });
  assert.deepEqual(requests, []);
  assert.deepEqual(questions, []);
  assert.equal(research.some((state) => state.active), false);
});

test('search explanations and declined searches cannot enter desktop research', async () => {
  const { assistant, requests, questions } = rig({ web: async () => assert.fail('no reads without a search request') });
  for (const goal of ['How do I search the internet?', "I don't want you to search for cats"]) {
    assert.equal(assistant.canResearch(goal), false);
    assert.deepEqual(await assistant.research(goal), { handled: false });
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(questions, []);
});

test('a low confidence strategy waits before reading and hands off only the resolved goal on yes', async () => {
  const { assistant, questions, requests, research } = rig({ web: async () => assert.fail('low confidence never reads'),
    decision: { route: 'scrape', goal: 'Search Spotify for jazz', scrapeConfidence: 35, reason: 'Spotify needs its app search controls.' } });
  assert.equal(assistant.canResearch('search Spotify for jazz'), false, 'Spotify’s own search, as before research');
  const context = '[{"who":"you","text":"I want jazz"}]';
  const pending = assistant.research('search for it', { context });
  await until(() => assistant.asking);
  assert.match(questions[0], /35\/100.*Spotify.*Should I do “Search Spotify for jazz” by hand instead/);
  assert.equal(JSON.parse(requests[0].prompt).context, context);
  assert.equal(research.find((state) => state.phase === 'review').active, false);
  assert.equal(research.find((state) => state.phase === 'review').scrapeConfidence, 35);
  assistant.answer(true);
  const result = await pending;
  assert.equal(result.approvedInteraction, true);
  assert.equal(result.goal, 'Search Spotify for jazz');
});
