import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The worker against a small multi-tab Chrome: Chrome's own pages refuse content
// scripts, new tabs load a moment later, and nothing calls a model.
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    fire(...args) { for (const fn of [...listeners]) fn(...args); } };
}
const local = { settings: { enabled: true, voiceEnabled: true, agentPermissionBoundary: 'entertainment', agentRealInput: false },
  modelConnectionConfigured: true };
const session = {};
function area(data) {
  return { async get(key) { return typeof key === 'string' ? { [key]: structuredClone(data[key]) } : structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; },
    async setAccessLevel() {} };
}
let tabs = [];
let nextId = 100;
let videos = {};
const sent = [];
const broadcasts = [];
const badges = [];
const notifications = [];
const created = [];
const focused = [];
const tabUpdates = [];
const publicPages = new Map();
const publicRequests = [];
const openPageReads = new Map();
const runtimeMessages = event();
const onUpdated = event();
const onCreated = event();
const onActivated = event();
const onRemoved = event();
const commands = event();
/** Chrome changes the active tab and says so; the worker re-reads what is in front. */
function activate(id) {
  const tab = tabs.find((entry) => entry.id === id);
  for (const other of tabs) if (other.windowId === tab.windowId) other.active = other.id === id;
  onActivated.fire({ tabId: id, windowId: tab.windowId });
}
const readable = (tab) => /^https?:/.test(tab?.url || '');
const loadLater = (id) => setTimeout(() => onUpdated.fire(id, { status: 'complete' }), 1);
globalThis.chrome = {
  runtime: { id: 'extension-test', getURL: (path = '') => `chrome-extension://extension-test/${path}`,
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async (message) => { broadcasts.push(structuredClone(message)); },
    onMessage: runtimeMessages, onStartup: event(), onInstalled: event() },
  storage: { local: area(local), session: area(session), onChanged: event() },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  action: { setBadgeText: async ({ text }) => { badges.push(text); }, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true },
  notifications: { create: async (id, options) => { notifications.push({ id, ...options }); return id; }, clear: async () => {},
    onClicked: event(), onClosed: event() },
  commands: { onCommand: commands },
  tabs: {
    onUpdated, onCreated, onActivated, onRemoved,
    remove: async (ids) => {
      for (const id of [].concat(ids)) {
        const index = tabs.findIndex((tab) => tab.id === id);
        const [gone] = tabs.splice(index, 1);
        // Chrome reports the removal, then activates a neighbour.
        onRemoved.fire(id, { windowId: gone.windowId });
        if (gone.active && tabs.length) activate(tabs[Math.min(index, tabs.length - 1)].id);
      }
    },
    query: async (info = {}) => tabs.filter((tab) => (info.active === undefined || tab.active === info.active) &&
      (info.windowId === undefined || tab.windowId === info.windowId) && (info.audible === undefined || !!tab.audible === info.audible) &&
      (info.url === undefined)).map((tab) => structuredClone(tab)),
    get: async (id) => { const tab = tabs.find((entry) => entry.id === id); if (!tab) throw new Error('No tab'); return structuredClone(tab); },
    update: async (id, patch) => {
      tabUpdates.push({id,patch:structuredClone(patch)});
      const tab = tabs.find((entry) => entry.id === id);
      if (patch.active) activate(id);
      if (patch.url) { tab.url = patch.url; tab.title = new URL(patch.url).hostname; loadLater(id); }
      return structuredClone(tab);
    },
    create: async (props) => {
      const tab = { id: nextId++, windowId: props.windowId ?? 1, index: props.index ?? tabs.length, active: true,
        url: props.url || 'chrome://newtab/', title: props.url ? new URL(props.url).hostname : 'New Tab' };
      tabs.push(tab); created.push(structuredClone(props)); onCreated.fire(structuredClone(tab)); activate(tab.id); loadLater(tab.id);
      return structuredClone(tab);
    },
    reload: async (id) => { loadLater(id); },
    sendMessage: async (tabId, message, options) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!readable(tab)) throw new Error('Receiving end does not exist');
      sent.push({ tabId, message: structuredClone(message), options });
      if (message.type === 'jester/agent-observe') return { ok: true, pageId: `doc${tabId}`, revision: 1, url: tab.url, title: tab.title,
        elements: [], text: `Page: ${tab.title}` };
      if (message.type === 'jester/agent-classify') return { ok: true, category: 'browse', label: 'Control', pageId: `doc${tabId}` };
      if (message.type === 'jester/agent-execute') return { ok: true, detail: 'Done' };
      if (message.type === 'jester/do-action') return { ok: true, detail: message.action === 'PAUSE' ? 'Paused' : message.action };
      if (message.type === 'jester/probe') return videos[tabId] || { hasVideo: false };
      return { ok: true };
    },
    setZoomSettings: async () => {}, setZoom: async () => {}
  },
  windows: { getLastFocused: async () => ({ id: 1, focused: true, state: 'normal', type: 'normal' }),
    get: async () => ({ id: 1, state: 'normal' }), update: async (id,patch) => (focused.push({id,patch}),{}),
    onFocusChanged: event(), onBoundsChanged: event(), onRemoved: event() },
  scripting: { executeScript: async ({ target, files, func, args }) => {
    const tab = tabs.find((entry) => entry.id === target.tabId);
    if (!readable(tab)) throw new Error('Cannot access a chrome:// URL');
    if (files) return [];
    if (func?.name === 'readInTab') return [{frameId:0,result:openPageReads.get(args?.[0]?.url) || {ok:false,code:'empty_page',detail:'No readable page'}}];
    return [{ frameId: 0, result: videos[target.tabId] || { hasVideo: false } }];
  } },
  sessions: { restore: async () => { throw new Error('Nothing to restore'); } },
  search: { query: async () => {} }
};
/** Scripted model replies, for the tests that reach the model; otherwise asking one fails. */
let modelReplies = [];
let modelCalls = 0;
const modelRequests = [];
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('chrome-extension:')) return new Response('', { status: 404 });
  if (publicPages.has(String(url))) {
    publicRequests.push({url:String(url),options});
    return new Response(publicPages.get(String(url)),{headers:{'content-type':'text/html'}});
  }
  const reply = modelReplies.shift();
  if (!reply) throw new Error('No model may be asked');
  modelCalls++;
  modelRequests.push(JSON.parse(options.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
};

await import('../jester-extension/src/background/service-worker.js');
const handler = runtimeMessages.listeners[0];
const engineSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/offscreen/offscreen.html') };
const uiSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') };
const tick = () => new Promise((done) => setTimeout(done, 2));
async function until(predicate, label = 'the expected state') {
  for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await tick(); }
  assert.fail(`Worker did not reach ${label}`);
}
function message(payload, sender = uiSender) {
  return new Promise((resolve) => {
    const async = handler(payload, sender, resolve);
    if (async !== true) resolve(undefined);
  });
}
const say = (text) => message({ type: 'jester/voice-command', text }, engineSender);
const answers = () => sent.filter((entry) => entry.message.voice?.phase === 'answer');
const history = () => session.history || [];
const scrapeRoute = goal => ({route:'scrape',goal,scrapeConfidence:94,reason:'Background reading can get this information.'});
async function connectResearchModel() {
  await message({type:'jester/model-clear'});
  await message({type:'jester/model-save',connection:{provider:'groq',model:'test-model',key:'gsk_test_key_0123456789',plan:'paid'}});
  delete session.modelPacing;
}

beforeEach(async () => {
  tabs = [
    { id: 7, windowId: 1, index: 0, active: true, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' },
    { id: 8, windowId: 1, index: 1, active: false, url: 'chrome://newtab/', title: 'New Tab' },
    { id: 9, windowId: 1, index: 2, active: false, url: 'https://www.youtube.com/watch?v=1', title: 'Music - YouTube' }
  ];
  activate(7);
  videos = {};
  sent.length = 0; broadcasts.length = 0; badges.length = 0; notifications.length = 0; created.length = 0;
  focused.length = 0; tabUpdates.length = 0; publicRequests.length = 0; publicPages.clear(); openPageReads.clear();
  session.history = [];
  delete session.recentCommands;
  delete session.lastWebResult;
  modelReplies = [];
  modelRequests.length = 0;
  await message({ type: 'jester/cancel-task' });
  await tick();
});
const front = (id) => activate(id);

test('"open YouTube" switches to its open tab; "open GitHub" opens one, and the task follows to it', async (t) => {
  t.mock.method(console, 'info', () => {});
  await say('Open YouTube');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].detail, 'Switched to “Music - YouTube”.');
  assert.equal(tabs.find((tab) => tab.id === 9).active, true);
  assert.equal(created.length, 0);
  // The answer is shown where the task ended up.
  assert.equal(answers().at(-1).tabId, 9);

  sent.length = 0; session.history = [];
  await say('open github dot com');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok, true, JSON.stringify(history()));
  assert.deepEqual(created.map((props) => props.url), ['https://github.com/']);
  const github = tabs.find((tab) => tab.url === 'https://github.com/');
  assert.equal(answers().at(-1).tabId, github.id);
  assert.equal(answers().at(-1).message.voice.text, 'Opened github.com.');
});

test('on the New Tab page the agent describes the page instead of reading it, and still opens sites there', async (t) => {
  t.mock.method(console, 'info', () => {});
  front(8);
  await say('go to wikipedia');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok, true, JSON.stringify(history()));
  // The blank tab itself became the site, rather than leaving an empty tab behind.
  assert.equal(tabs.find((tab) => tab.id === 8).url, 'https://www.wikipedia.org/');
  assert.equal(created.length, 0);
  assert.equal(sent.some((entry) => entry.tabId === 8 && entry.message.type === 'jester/agent-observe' &&
    tabs.find((tab) => tab.id === 8).url.startsWith('chrome://')), false, 'A Chrome page is never messaged');
});

test('where the pill cannot be drawn, the reply is a toolbar badge and a notification', async (t) => {
  t.mock.method(console, 'info', () => {});
  front(8);
  await say('reload the page');
  await until(() => notifications.length > 0, 'a notification');
  assert.equal(notifications[0].message, 'Reloaded the page.');
  assert.equal(notifications[0].title, 'Jester');
  assert.ok(badges.includes('✓'));
  assert.equal(history()[0].detail, 'Reloaded the page.', 'The popup’s list keeps the reply too');
});

test('a spoken playback command reaches the tab that is playing when this one has none; a gesture never does', async (t) => {
  t.mock.method(console, 'info', () => {});
  videos[9] = { hasVideo: true, playing: true, area: 1000 };
  await message({ type: 'jester/video-state', info: videos[9] }, { id: chrome.runtime.id, url: tabs[2].url, tab: structuredClone(tabs[2]), frameId: 0 });
  await say('pause');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  const command = sent.find((entry) => entry.message.type === 'jester/do-action');
  assert.equal(command.tabId, 9);
  assert.equal(history()[0].detail, 'Paused “Music” in another tab.');
  // A pose held at Gmail stays on Gmail.
  sent.length = 0;
  await message({ type: 'jester/trigger', action: 'PAUSE', source: 'pose' }, engineSender);
  await tick();
  assert.equal(sent.some((entry) => entry.message.type === 'jester/do-action' && entry.tabId === 9), false);
});

test('a step that needs approval asks by voice, listens, and takes "yes" or "no" for an answer', async (t) => {
  t.mock.method(console, 'info', () => {});
  local.settings = { ...local.settings, agentPermissionBoundary: 'ask' };
  for (const listener of chrome.storage.onChanged.listeners) listener({ settings: { newValue: local.settings } }, 'local');
  await say('open github dot com');
  await until(() => broadcasts.some((entry) => entry.type === 'jester/approval-state' && entry.approval), 'an approval');
  assert.ok(sent.some((entry) => entry.message.voice?.step === 'Is it okay if I do this: “Open github.com”?'));
  assert.ok(broadcasts.some((entry) => entry.type === 'jester/voice-control' && entry.action === 'start'), 'The microphone opens for the answer');
  // Listening for the answer neither cancels the task nor paints over the question.
  sent.length = 0;
  await message({ type: 'jester/voice', voice: { active: true, start: true, levels: [1, 1, 1, 1, 1] } }, engineSender);
  assert.equal(sent.some((entry) => entry.message.type === 'jester/voice'), false);
  await say('Yes.');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.deepEqual(created.map((props) => props.url), ['https://github.com/']);

  session.history = [];
  await say('open reddit');
  await until(() => broadcasts.filter((entry) => entry.type === 'jester/approval-state' && entry.approval).length === 2, 'a second approval');
  await say('no thanks');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].detail, 'Okay, I didn’t do that.');
  assert.equal(created.length, 1, 'Nothing more was opened');
  local.settings = { ...local.settings, agentPermissionBoundary: 'entertainment' };
  for (const listener of chrome.storage.onChanged.listeners) listener({ settings: { newValue: local.settings } }, 'local');
});

test('the keyboard shortcut starts voice, on Chrome’s own pages too', async () => {
  front(8);
  commands.fire('toggle-voice');
  await until(() => broadcasts.some((entry) => entry.type === 'jester/voice-control' && entry.action === 'toggle'), 'a toggle');
  commands.fire('something-else');
  await tick();
  assert.equal(broadcasts.filter((entry) => entry.type === 'jester/voice-control' && entry.action === 'toggle').length, 1);
});

test('"close this tab" closes the task’s own tab and answers from the tab Chrome shows next', async (t) => {
  t.mock.method(console, 'info', () => {});
  await say('close this tab');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'), 'an answer');
  assert.equal(history()[0].ok, true, JSON.stringify(history()));
  assert.equal(history()[0].detail, 'Closed “Inbox”.');
  assert.equal(tabs.some((tab) => tab.id === 7), false);
  // The tab that came forward is the New Tab page, where the pill can't appear.
  assert.equal(tabs.find((tab) => tab.active).id, 8);
  assert.equal(notifications.at(-1).message, 'Closed “Inbox”.');
});

test('a model-made destination the task has not seen needs a yes; a site the request names does not', async (t) => {
  t.mock.method(console, 'info', () => {});
  await message({ type: 'jester/model-save', connection: { provider: 'groq', model: 'test-model', key: 'gsk_test_key_0123456789' } });
  delete session.modelPacing;
  modelReplies = [{ action: { action: 'browser', op: 'open', url: 'https://collector.example/?inbox=private' } }];
  await say('open the weather forecast');
  await until(() => broadcasts.some((entry) => entry.type === 'jester/approval-state' && entry.approval), 'an approval');
  assert.match(broadcasts.find((entry) => entry.approval).approval.label, /collector\.example/);
  await say('no');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(created.length, 0, 'Nothing was opened');

  session.history = []; broadcasts.length = 0; delete session.modelPacing;
  modelReplies = [{ action: { action: 'browser', op: 'open', url: 'https://docs.anthropic.com/' } },
    { action: { action: 'finish', say: 'Opened the Anthropic docs.', success: true } }];
  await say('open the Anthropic docs');
  await until(() => history().some((entry) => entry.action === 'ASSISTANT'));
  assert.equal(broadcasts.some((entry) => entry.type === 'jester/approval-state' && entry.approval), false);
  assert.deepEqual(created.map((props) => props.url), ['https://docs.anthropic.com/']);
  // Once the named page is on screen, the local planner says so without another model step.
  assert.equal(history()[0].detail, 'Here’s “docs.anthropic.com”.');
  assert.equal(modelReplies.length, 1);
  modelReplies = [];
});

test('with Desktop closed, a research request reads public live data without observing or controlling the visible page', async (t) => {
  t.mock.method(console, 'info', () => {});
  await connectResearchModel();
  publicPages.set('https://example.com/report','<html><title>Live Report</title><main>Current score: 4 to 2.</main></html>');
  modelReplies = [scrapeRoute('research https://example.com/report'),{action:'scrape',url:'https://example.com/report'},
    {action:'answer',text:'The current score is 4 to 2.',sources:['https://example.com/report']}];
  await say('research https://example.com/report');
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok,true,history()[0].detail);
  assert.match(history()[0].detail,/4 to 2/);
  assert.match(history()[0].detail,/https:\/\/example.com\/report/);
  assert.equal(publicRequests.length,1);
  assert.equal(publicRequests[0].options.credentials,'omit');
  assert.equal(publicRequests[0].options.cache,'no-store');
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
  assert.match(session.lastWebResult.text,/4 to 2/);
  assert.equal(session.lastWebResult.sources[0].url,'https://example.com/report');
  assert.equal(session.lastWebResult.scrapeConfidence,94);
  assert.match(session.lastWebResult.strategyReason,/Background reading/);
  const state = await message({type:'jester/get-state'});
  assert.deepEqual(state.webResult,session.lastWebResult);
  assert.ok(broadcasts.some(entry => entry.type === 'jester/research-result' && entry.result.text.includes('4 to 2')));
});

test('signed-in Canvas research reads an open page without public search, focus, or browser input', async (t) => {
  t.mock.method(console, 'info', () => {});
  await connectResearchModel();
  tabs.push({id:10,windowId:1,index:3,active:false,url:'https://school.instructure.com/courses',title:'Canvas courses'});
  openPageReads.set('https://school.instructure.com/courses',{ok:true,url:'https://school.instructure.com/courses',title:'Canvas courses',text:'Homework due November 20, 2026.',links:[],fetchedAt:'2026-11-16T20:00:00Z',mode:'open-tab',status:200});
  modelReplies = [scrapeRoute('research my Canvas assignments'),{action:'scrape',url:'https://school.instructure.com/courses'},
    {action:'answer',text:'Homework is due November 20, 2026.',sources:['https://school.instructure.com/courses']}];
  await say('research my Canvas assignments');
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok,true,history()[0].detail);
  assert.match(history()[0].detail,/November 20/);
  assert.equal(publicRequests.length,0);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(tabs.find(tab => tab.id === 7).active,true);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
});

test('a search without a target asks, remembers the question, and researches a spoken reply without a wake word', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  const beforeCalls = modelCalls;
  await say('search something');
  await until(() => answers().some(entry => /What would you like me to search for/.test(entry.message.voice.text)));
  assert.equal(modelCalls,beforeCalls,'A missing topic does not need a research/model call.');
  assert.equal(publicRequests.length,0);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
  assert.equal(session.pendingSearchClarification.goal,'search something');
  assert.ok(session.pendingSearchClarification.expiresAt > Date.now());
  assert.ok(session.pendingSearchClarification.expiresAt <= Date.now()+120000);
  assert.ok(broadcasts.some(entry => entry.type === 'jester/voice-control' && entry.action === 'start'));
  assert.equal(session.lastWebResult.scrapeConfidence,0);
  assert.equal(session.recentCommands,undefined,'The question is not learned as a completed search.');

  publicPages.set('https://example.com/report','<html><title>Cat cafes</title><main>Two cat cafes opened today.</main></html>');
  publicPages.set('https://html.duckduckgo.com/html/?q=current%20cat%20cafes','<html><title>Cat cafes search</title><a class="result__a" href="https://example.com/report">Cat cafe report</a><div class="result__snippet">Two cafes opened.</div></html>');
  modelReplies = [scrapeRoute('search for current cat cafes'),{action:'search',query:'current cat cafes'},{action:'scrape',url:'https://example.com/report'},
    {action:'answer',text:'Two cat cafes opened today.',sources:['https://example.com/report']}];
  session.history = [];
  await say('current cat cafes');
  await until(() => history().some(entry => /Two cat cafes/.test(entry.detail)));
  const assessment = JSON.parse(modelRequests[0].messages.at(-1).content);
  assert.match(assessment.goal,/search something/);
  assert.match(assessment.goal,/current cat cafes/);
  const context = JSON.parse(assessment.context);
  assert.equal(context.searchClarification.originalGoal,'search something');
  assert.equal(context.searchClarification.answer,'current cat cafes');
  assert.equal(session.pendingSearchClarification,undefined);
  assert.equal(publicRequests.length,2);
  assert.equal(session.lastWebResult.scrapeConfidence,94);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
});

test('search explanations and declined searches bypass research preflight', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  for (const command of ['How do I search the internet?', "I don't want you to search for cats"]) {
    session.history = []; delete session.modelPacing;
    modelReplies = [{action:{action:'finish',success:true,say:'Understood.'}}];
    await say(command);
    await until(() => history().some(entry => entry.action === 'ASSISTANT'));
    assert.equal(session.lastWebResult,undefined);
    assert.doesNotMatch(modelRequests.at(-1).messages[0].content,/You route Jester's search requests/);
  }
  assert.equal(publicRequests.length,0);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
});

test('low scraping confidence asks before either reading sources or using browser controls', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  modelReplies = [{route:'scrape',goal:'look up the city budget in its records portal',scrapeConfidence:32,reason:'The records portal needs a search form filled in, which is computer interaction.'}];
  await say('look up the city budget in its records portal');
  await until(() => broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval));
  const question = broadcasts.find(entry => entry.approval).approval.label;
  assert.match(question,/32\/100/);
  assert.match(question,/search form/);
  assert.match(question,/Should I do “look up the city budget in its records portal” by hand instead/);
  assert.equal(session.lastWebResult.scrapeConfidence,32);
  assert.match(session.lastWebResult.strategyReason,/computer interaction/);
  assert.equal(publicRequests.length,0);
  assert.equal(openPageReads.size,0);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(sent.some(entry => entry.message.voice?.step === 'Reading live web data'),false);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
  await say('no');
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok,false);
  assert.match(history()[0].detail,/not approved/);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
});

test('an approved low confidence route uses the resolved goal once without retrying research', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  await say('search');
  await until(() => session.pendingSearchClarification);
  modelReplies = [{route:'interaction',goal:'open https://example.com/report',scrapeConfidence:20,reason:'The requested report needs the browser.'}];
  await say('the report from example.com');
  await until(() => broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval));
  assert.equal(created.length,0);
  await say('yes');
  await until(() => history().some(entry => entry.action === 'ASSISTANT' && !/What would/.test(entry.detail)));
  assert.equal(history()[0].ok,true,history()[0].detail);
  assert.deepEqual(created.map(props => props.url),['https://example.com/report']);
  assert.equal(broadcasts.filter(entry => entry.type === 'jester/approval-state' && entry.approval).length,1);
  assert.equal(modelReplies.length,0);
  assert.equal(publicRequests.length,0);
  assert.equal(session.pendingSearchClarification,undefined);
});

test('cancelling a search question or issuing a new explicit task forgets the pending topic', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  await say('search');
  await until(() => session.pendingSearchClarification);
  await say('never mind');
  await until(() => answers().some(entry => /stopped the search/.test(entry.message.voice.text)));
  assert.equal(session.pendingSearchClarification,undefined);
  assert.equal(created.length,0);
  assert.equal(modelRequests.length,0);

  await say('search');
  await until(() => session.pendingSearchClarification);
  await say('open github dot com');
  await until(() => created.length > 0);
  assert.deepEqual(created.map(props => props.url),['https://github.com/']);
  assert.equal(session.pendingSearchClarification,undefined);
  assert.equal(modelRequests.length,0);

  delete session.recentCommands;
  await say('search');
  await until(() => session.pendingSearchClarification);
  await message({type:'jester/cancel-task'});
  await until(() => session.pendingSearchClarification === undefined);
});

test('an expired search question does not turn an unrelated fragment into a new search', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  await say('search');
  await until(() => session.pendingSearchClarification);
  const later = Date.now()+120001;
  t.mock.method(Date,'now',() => later);
  modelReplies = [{action:{action:'finish',success:true,say:'Please give me a complete request.'}}];
  await say('the older topic');
  await until(() => history().some(entry => /complete request/.test(entry.detail)));
  assert.equal(session.pendingSearchClarification,undefined);
  assert.equal(modelRequests.length,1);
  assert.doesNotMatch(modelRequests[0].messages[0].content,/You route Jester's search requests/,'The expired answer reaches the normal assistant, not search routing.');
  assert.equal(publicRequests.length,0);
});

test('a replaced routing call cannot arm a stale search clarification', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  const originalFetch = globalThis.fetch;
  let release;
  let assessing = false;
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis,'fetch',(url,options) => {
    if (!String(url).startsWith('chrome-extension:')) { assessing = true; return pending; }
    return originalFetch(url,options);
  });
  await say('search for that report');
  await until(() => assessing);
  await say('open github dot com');
  release(Response.json({choices:[{message:{content:JSON.stringify({route:'clarify',goal:'',scrapeConfidence:0,reason:'The report is unclear.',question:'Which report?'})}}]}));
  await until(() => created.length > 0);
  await tick();
  assert.deepEqual(created.map(props => props.url),['https://github.com/']);
  assert.equal(session.pendingSearchClarification,undefined);
  assert.equal(answers().some(entry => /Which report/.test(entry.message.voice.text)),false);
});

test('unsuccessful background research asks before any UI fallback even with permissive browsing settings', async (t) => {
  t.mock.method(console, 'info', () => {});
  await connectResearchModel();
  modelReplies = [scrapeRoute('research https://example.com/report'),{action:'fallback',text:'This page needs a sign-in check.'}];
  await say('research https://example.com/report');
  await until(() => broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval));
  const question = broadcasts.find(entry => entry.approval).approval.label;
  assert.match(question,/sign-in check/);
  assert.doesNotMatch(question,/\/100/, 'a read that failed has no score');
  assert.equal(session.lastWebResult.scrapeConfidence,null);
  assert.match(session.lastWebResult.strategyReason,/sign-in check/);
  assert.match(question,/^I couldn’t read this in the background: .*Should I do .* by hand instead\?$/);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(created.length,0);
  assert.equal(tabUpdates.length,0);
  assert.equal(focused.length,0);
  await say('no');
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok,false);
  assert.equal(sent.some(entry => entry.message.type === 'jester/agent-observe'),false);
  assert.equal(created.length,0);
  assert.equal(focused.length,0);
});

test('an approved research fallback starts the existing UI assistant once', async (t) => {
  t.mock.method(console, 'info', () => {});
  await connectResearchModel();
  modelReplies = [scrapeRoute('research https://example.com/approved'),{action:'fallback',text:'The source needs browser rendering.'},
    {action:{action:'browser',op:'open',url:'https://example.com/approved'}},
    {action:{action:'finish',success:true,say:'Read the report in your browser.'}}];
  await say('research https://example.com/approved');
  await until(() => broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval));
  assert.equal(created.length,0);
  await say('yes');
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  assert.equal(history()[0].ok,true,history()[0].detail);
  assert.deepEqual(created.map(props => props.url),['https://example.com/approved']);
  assert.equal(broadcasts.filter(entry => entry.type === 'jester/approval-state' && entry.approval).length,1);
  assert.equal(modelReplies.length,0);
});

test('a newer command supersedes research while its initial tab lookup is still pending', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  await tick();
  let release;
  let lookedUp = false;
  const pendingWindow = new Promise(resolve => { release = resolve; });
  t.mock.method(chrome.windows,'getLastFocused',() => { lookedUp = true; return pendingWindow; });
  chrome.windows.onBoundsChanged.fire();
  const beforeCalls = modelCalls;
  modelReplies = [{action:'fallback',text:'Superseded research should never start.'}];
  await say('research https://old.example/report');
  await until(() => lookedUp);
  await tick();
  await say('open github dot com');
  await tick();
  release({id:1,focused:true,state:'normal',type:'normal'});
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  await tick();
  assert.deepEqual(created.map(props => props.url),['https://github.com/']);
  assert.equal(modelCalls,beforeCalls,'The old lookup cannot revive a research model call.');
  assert.equal(modelReplies.length,1);
  assert.equal(history().some(entry => entry.label.includes('old.example')),false);
  assert.equal(broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval),false);
  modelReplies = [];
});

test('a newer command cancels an approved research fallback before its UI setup finishes', async (t) => {
  t.mock.method(console,'info',() => {});
  await connectResearchModel();
  modelReplies = [scrapeRoute('research https://stale.example/report'),{action:'fallback',text:'This report needs visible controls.'}];
  await say('research https://stale.example/report');
  await until(() => broadcasts.some(entry => entry.type === 'jester/approval-state' && entry.approval));
  let release;
  let lookedUp = false;
  const pendingWindow = new Promise(resolve => { release = resolve; });
  t.mock.method(chrome.windows,'getLastFocused',() => { lookedUp = true; return pendingWindow; });
  chrome.windows.onBoundsChanged.fire();
  await until(() => lookedUp);
  await say('yes');
  await tick();
  const beforeCalls = modelCalls;
  modelReplies = [{action:{action:'browser',op:'open',url:'https://stale.example/report'}}];
  await say('open github dot com');
  await tick();
  release({id:1,focused:true,state:'normal',type:'normal'});
  await until(() => history().some(entry => entry.action === 'ASSISTANT'));
  await tick();
  assert.deepEqual(created.map(props => props.url),['https://github.com/']);
  assert.equal(modelCalls,beforeCalls,'Approval for the old request does not revive it after replacement.');
  assert.equal(modelReplies.length,1);
  assert.equal(history().some(entry => entry.label.includes('stale.example')),false);
  modelReplies = [];
});
