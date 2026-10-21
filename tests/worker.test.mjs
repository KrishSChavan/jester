import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); } };
}

const local = { settings: { enabled: false, voiceEnabled: true, agentPermissionBoundary: 'entertainment' } };
const session = {};
const sent = [];
const broadcasts = [];
const storageChanged = event();
function area(data) {
  return {
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
    async setAccessLevel(value) { return value; }
  };
}
const tab = { id: 7, windowId: 1, active: true, url: 'https://www.netflix.com/browse', title: 'Netflix' };
let classification = { ok: true, category: 'browse', label: 'Play episode', pageId: 'doc1' };
let replies = [];
let fetches = [];
let executeCount = 0;
let blockApprovalPill = null;
let failMutationReply = false;
const runtimeMessages = event();
globalThis.chrome = {
  runtime: { id: 'extension-test', getURL: (path = '') => `chrome-extension://extension-test/${path}`,
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async (message) => { broadcasts.push(structuredClone(message)); },
    onMessage: runtimeMessages, onStartup: event(), onInstalled: event() },
  storage: { local: area(local), session: area(session), onChanged: storageChanged },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true },
  tabs: { query: async ({ url } = {}) => url ? [] : [structuredClone(tab)],
    get: async () => structuredClone(tab), update: async (_id, patch) => Object.assign(tab, patch),
    sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message: structuredClone(message), options });
      if (blockApprovalPill && message.voice?.step?.startsWith('Allow')) await blockApprovalPill;
      if (message.type === 'jester/agent-observe') return { ok: true, pageId: 'doc1', revision: 1,
        url: tab.url, title: 'Netflix', text: '[button1] button "Play episode"' };
      if (message.type === 'jester/agent-classify') return structuredClone(classification);
      if (message.type === 'jester/agent-execute') {
        executeCount++;
        if (failMutationReply) throw new Error('Document navigated after the click landed');
        return { ok: true, detail: 'Playing episode' };
      }
      return { ok: true };
    },
    create: async () => structuredClone(tab), setZoomSettings: async () => {}, setZoom: async () => {},
    onActivated: event(), onRemoved: event(), onUpdated: event() },
  windows: { getLastFocused: async () => ({ id: 1, focused: true, state: 'normal', type: 'normal' }),
    get: async () => ({ id: 1, state: 'normal' }), update: async () => ({}),
    onFocusChanged: event(), onBoundsChanged: event(), onRemoved: event() },
  scripting: { executeScript: async () => [] },
  sessions: { restore: async () => ({}) }
};
globalThis.fetch = async (url, options) => {
  fetches.push({ url, options });
  if (String(url).startsWith('chrome-extension:')) return new Response('', { status: 404 });
  const reply = replies.shift();
  if (!reply) throw new Error('Unexpected inference request');
  if (reply instanceof Response) return reply;
  return String(url).includes('generativelanguage.googleapis.com')
    ? Response.json({candidates:[{content:{parts:[{text:JSON.stringify(reply)}]}}]})
    : Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
};

const uiSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') };
const engineSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/offscreen/offscreen.html') };
const pageSender = { id: chrome.runtime.id, url: tab.url, tab: structuredClone(tab), frameId: 0 };
await import('../jester-extension/src/background/service-worker.js');
const handler = runtimeMessages.listeners[0];
// Every test runs inside the same minute; each starts with no request history to pace against.
beforeEach(() => { delete session.modelPacing; });
const tick = () => new Promise((done) => setImmediate(done));
await tick();

async function message(payload, sender = uiSender) {
  return new Promise((resolve, reject) => {
    let replied = false;
    try {
      const asyncReply = handler(payload, sender, (value) => { replied = true; resolve(value); });
      if (asyncReply !== true && !replied) resolve(undefined);
    } catch (error) { reject(error); }
  });
}
async function settings(patch) {
  const previous = structuredClone(local.settings);
  local.settings = { ...local.settings, ...patch };
  for (const listener of storageChanged.listeners) listener({ settings: { oldValue: previous, newValue: structuredClone(local.settings) } }, 'local');
  await tick();
}
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await tick(); }
  assert.fail('Worker did not reach the expected state');
}
function goalReplies() {
  return [{ action: { action: 'click', elementId: 'button1' } },
    { action: { action: 'finish', say: 'Playing the requested episode.', success: true } }];
}

test('worker imports, rejects webpage control/credentials messages and never returns a raw key', async () => {
  assert.equal(runtimeMessages.listeners.length, 1);
  assert.equal(await message({ type: 'jester/model-get' }, pageSender), undefined);
  assert.equal(await message({ type: 'jester/set-enabled', enabled: true }, pageSender), undefined);
  const key = 'gsk_private_test_0123456789';
  const save = await message({ type: 'jester/model-save', connection: { provider: 'groq', model: 'chosen-model', key } });
  assert.equal(save.ok, true);
  assert.equal(local.modelConnections[0].key, key);
  const summary = await message({ type: 'jester/model-get' });
  assert.equal(summary.connection.model, 'chosen-model');
  assert.equal(summary.connection.key, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /gsk_private_test/);
  assert.ok(broadcasts.every((entry) => !JSON.stringify(entry).includes(key)));
  assert.equal(await message({type:'jester/model-reorder',ids:[]},pageSender),undefined);
  assert.equal(await message({type:'jester/model-clear',id:local.modelConnections[0].id},pageSender),undefined);
});

test('trusted voice command runs semantic observe/classify/execute on its task tab', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ enabled: true, agentPermissionBoundary: 'entertainment' });
  replies = goalReplies(); fetches = []; sent.length = 0;
  const before = executeCount;
  await message({ type: 'jester/voice-command', text: 'Play Rick and Morty season 3 episode 1' }, engineSender);
  await until(() => session.history?.some((entry) => entry.action === 'ASSISTANT' && entry.ok));
  assert.equal(executeCount, before + 1);
  const operations = sent.filter((entry) => entry.message.type.startsWith('jester/agent-'));
  assert.deepEqual(operations.map((entry) => entry.message.type), ['jester/agent-observe', 'jester/agent-classify', 'jester/agent-execute', 'jester/agent-observe']);
  assert.ok(operations.every((entry) => entry.tabId === 7 && entry.options.frameId === 0));
  const execute = operations.find((entry) => entry.message.type === 'jester/agent-execute').message;
  assert.equal(execute.action.pageId, 'doc1');
  assert.equal(execute.options.approved, false);
  assert.ok(fetches.every((entry) => entry.url === 'https://api.groq.com/openai/v1/chat/completions'));
  assert.ok(sent.every((entry) => !JSON.stringify(entry.message).includes('gsk_private_test')));
});

test('ask boundary requires exact approval ID, rejects webpage approvals, then executes once', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ agentPermissionBoundary: 'ask' });
  replies = goalReplies(); sent.length = 0; broadcasts.length = 0;
  const before = executeCount;
  await message({ type: 'jester/voice-command', text: 'Play episode 1' }, engineSender);
  await until(() => broadcasts.some((entry) => entry.type === 'jester/approval-state' && entry.approval));
  const approval = broadcasts.find((entry) => entry.type === 'jester/approval-state' && entry.approval).approval;
  assert.equal(executeCount, before);
  await message({ type: 'jester/agent-approval', id: approval.id, approved: true }, pageSender);
  await message({ type: 'jester/agent-approval', id: 'wrong-id', approved: true });
  await tick();
  assert.equal(executeCount, before);
  await message({ type: 'jester/agent-approval', id: approval.id, approved: true });
  await until(() => executeCount === before + 1);
  await until(() => sent.some((entry) => entry.message.voice?.phase === 'answer'));
  const executed = sent.find((entry) => entry.message.type === 'jester/agent-execute').message;
  assert.equal(executed.options.approved, true);
  assert.equal(executed.action.elementId, 'button1');
  assert.equal(executed.action.pageId, 'doc1');
});

test('a link to another site is followed, a non-web link never is, and cancelling clears a waiting approval', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ agentPermissionBoundary: 'entertainment' });
  classification = { ok: true, category: 'browse', label: 'External', url: 'https://other.example/play' };
  replies = goalReplies(); sent.length = 0;
  let before = executeCount;
  await message({ type: 'jester/voice-command', text: 'Open episode' }, engineSender);
  await until(() => sent.some((entry) => entry.message.voice?.phase === 'answer'));
  assert.equal(executeCount, before + 1, 'Tasks follow links to any web page');
  classification = { ok: true, category: 'browse', label: 'Script link', url: 'javascript:alert(1)' };
  replies = goalReplies(); sent.length = 0; delete session.modelPacing;
  before = executeCount;
  await message({ type: 'jester/voice-command', text: 'Open episode' }, engineSender);
  await until(() => sent.some((entry) => entry.message.voice?.phase === 'answer'));
  assert.equal(executeCount, before);
  classification = { ok: true, category: 'sensitive', label: 'Buy episode' };
  replies = goalReplies(); sent.length = 0; broadcasts.length = 0; delete session.modelPacing;
  await message({ type: 'jester/voice-command', text: 'Buy episode' }, engineSender);
  await until(() => broadcasts.some((entry) => entry.approval));
  await message({ type: 'jester/cancel-task' });
  await tick();
  assert.equal(executeCount, before);
  assert.ok(broadcasts.some((entry) => entry.type === 'jester/approval-state' && entry.approval === null));
});

test('cancelling while the approval pill is being delivered cannot publish a late approval', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ agentPermissionBoundary: 'ask' });
  classification = { ok: true, category: 'browse', label: 'Play episode' };
  replies = goalReplies(); sent.length = 0; broadcasts.length = 0;
  let release;
  blockApprovalPill = new Promise((resolve) => { release = resolve; });
  await message({ type: 'jester/voice-command', text: 'Play episode' }, engineSender);
  await until(() => sent.some((entry) => entry.message.voice?.step?.startsWith('Allow')));
  const before = executeCount;
  await message({ type: 'jester/cancel-task' });
  release(); blockApprovalPill = null;
  await tick(); await tick();
  assert.equal(executeCount, before);
  assert.equal(broadcasts.some((entry) => entry.approval), false);
});

test('a mutation whose reply is lost is executed once and is not reinjected or retried', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ agentPermissionBoundary: 'entertainment' });
  replies = [{ action: { action: 'click', elementId: 'button1' } },
    { action: { action: 'finish', say: 'Unable to verify playback.', success: false } }];
  sent.length = 0; failMutationReply = true;
  const before = executeCount;
  await message({ type: 'jester/voice-command', text: 'Play episode' }, engineSender);
  await until(() => sent.some((entry) => entry.message.voice?.phase === 'answer'));
  failMutationReply = false;
  assert.equal(executeCount, before + 1);
  assert.equal(sent.filter((entry) => entry.message.type === 'jester/agent-execute').length, 1);
});

test('keyboard approval keeps the classified target when page focus changes before approval', async (t) => {
  t.mock.method(console, 'info', () => {});
  await settings({ agentPermissionBoundary: 'ask' });
  classification = { ok: true, category: 'browse', label: 'Search titles', elementId: 'original-focused-field', pageId: 'doc1' };
  replies = [{ action: { action: 'press_key', key: 'Enter' } },
    { action: { action: 'finish', say: 'Search submitted.', success: true } }];
  sent.length = 0; broadcasts.length = 0;
  await message({ type: 'jester/voice-command', text: 'Submit this search' }, engineSender);
  await until(() => broadcasts.some((entry) => entry.approval));
  const approval = broadcasts.find((entry) => entry.approval).approval;
  classification = { ok: true, category: 'sensitive', label: 'Other field', elementId: 'new-focused-field', pageId: 'doc1' };
  await message({ type: 'jester/agent-approval', id: approval.id, approved: true });
  await until(() => sent.some((entry) => entry.message.type === 'jester/agent-execute'));
  const executed = sent.find((entry) => entry.message.type === 'jester/agent-execute').message;
  assert.equal(executed.action.elementId, 'original-focused-field');
  assert.equal(executed.action.pageId, 'doc1');
  assert.equal(executed.options.approved, true);
  await until(() => sent.some((entry) => entry.message.voice?.phase === 'answer'));
});

test('worker switches saved providers after a 429 without repeating the browser action',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await settings({agentPermissionBoundary:'entertainment'});
  await message({type:'jester/model-clear'});
  await message({type:'jester/model-save',connection:{provider:'groq',model:'first-model',key:'private-first-key'}});
  await message({type:'jester/model-save',connection:{provider:'google',model:'second-model',key:'private-second-key'}});
  classification={ok:true,category:'browse',label:'Play episode',pageId:'doc1'};
  replies=[Response.json({error:{message:'Rate limited'}},{status:429,headers:{'retry-after':'33'}}),...goalReplies()];
  sent.length=0;fetches=[];const before=executeCount;
  await message({type:'jester/voice-command',text:'Open the episode'},engineSender);
  await until(()=>sent.some(entry=>entry.message.voice?.phase==='answer'));
  assert.equal(executeCount,before+1);
  assert.equal(fetches.length,3);
  assert.equal(fetches[0].url,'https://api.groq.com/openai/v1/chat/completions');
  assert.ok(fetches.slice(1).every(entry=>entry.url.includes('generativelanguage.googleapis.com')));
  assert.equal(fetches[0].options.headers.authorization,'Bearer private-first-key');
  assert.equal(fetches[1].options.headers['x-goog-api-key'],'private-second-key');
  assert.deepEqual(local.modelConnections.map(entry=>entry.model),['second-model','first-model']);
  assert.ok(local.modelConnections[1].cooldownUntil>Date.now());
  assert.ok(sent.every(entry=>!JSON.stringify(entry.message).includes('private-first-key')&&!JSON.stringify(entry.message).includes('private-second-key')));
  // The pill says what the task is doing, not which model is answering.
  const steps=sent.map(entry=>entry.message.voice?.step).filter(Boolean);
  assert.ok(steps.includes('Clicking a control'));
  assert.ok(steps.every(step=>!/first-model|second-model|groq|google/i.test(step)));
});

test('all limited models show the closest countdown, preserve task and require explicit keep going',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await message({type:'jester/model-clear'});
  for(const [model,key] of [['soon-model','private-soon-key'],['later-model','private-later-key']]) {
    await message({type:'jester/model-save',connection:{provider:'groq',model,key}});
  }
  replies=[33,60].map(delay=>Response.json({error:{message:'Rate limited'}},{status:429,headers:{'retry-after':String(delay)}}));
  sent.length=0;fetches=[];const before=executeCount;
  await message({type:'jester/voice-command',text:'Open the next episode'},engineSender);
  await until(()=>sent.some(entry=>entry.message.voice?.phase==='answer'));
  const answer=sent.find(entry=>entry.message.voice?.phase==='answer').message.voice;
  assert.match(answer.text,/All saved models are rate-limited/);
  const badge=sent.filter(entry=>entry.message.type==='jester/model-cooldown').at(-1).message.cooldown;
  assert.equal(badge.model,'soon-model');
  assert.equal(badge.allLimited,true);
  assert.ok(badge.readyAt>Date.now()+30000&&badge.readyAt<=Date.now()+33000);
  assert.equal(executeCount,before);
  assert.equal(fetches.length,2);
  assert.equal(session.agentTask.snapshot.goal,'Open the next episode');
  sent.length=0;
  await message({type:'jester/voice-command',text:'keep going'},engineSender);
  await until(()=>sent.some(entry=>entry.message.voice?.phase==='answer'));
  assert.equal(fetches.length,2,'Keep going during cooldown does not poll the providers');
  local.modelConnections[0].cooldownUntil=Date.now()-1;
  await tick();await tick();
  assert.equal(fetches.length,2,'Expiry does not start a model request automatically');
  replies=goalReplies();sent.length=0;
  await message({type:'jester/voice-command',text:'keep going'},engineSender);
  await until(()=>sent.some(entry=>entry.message.voice?.phase==='answer'));
  assert.equal(executeCount,before+1);
  assert.equal(session.agentTask,undefined);
  assert.ok(sent.some(entry=>entry.message.type==='jester/model-cooldown'&&entry.message.cooldown===null));
});

const lastAnswer=()=>sent.filter(entry=>entry.message.voice?.phase==='answer').at(-1)?.message.voice.text;

test('a paused task is forgotten a minute after its last step, and a new command never inherits it',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await message({type:'jester/model-clear'});
  // Six requests at one frozen instant: a paid plan keeps free-tier pacing out of this lifecycle test.
  await message({type:'jester/model-save',connection:{provider:'groq',model:'pause-model',key:'private-pause-key',plan:'paid'}});
  const start=Date.now();let elapsed=0;
  t.mock.method(Date,'now',()=>start+elapsed);
  // Two unusable replies pause the task with its goal kept for "keep going".
  replies=[{unexpected:true},{unexpected:true}];sent.length=0;
  await message({type:'jester/voice-command',text:'go to rick and morty season 3 episode 2'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(session.agentTask.snapshot.goal,'go to rick and morty season 3 episode 2');
  assert.equal(session.agentTask.expiresAt,start+60000);
  elapsed=59000;
  assert.equal((await message({type:'jester/get-state'})).resumeAvailable,true,'Still resumable inside the minute');
  elapsed=60000;
  assert.equal((await message({type:'jester/get-state'})).resumeAvailable,false);
  assert.equal(session.agentTask,undefined,'A stale goal leaves session storage too');
  sent.length=0;
  await message({type:'jester/voice-command',text:'keep going'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(lastAnswer(),'There is no task to resume on this tab.');

  // Inside the minute, a different command still starts from its own goal.
  replies=[{unexpected:true},{unexpected:true}];sent.length=0;elapsed=0;
  await message({type:'jester/voice-command',text:'go to rick and morty season 3 episode 2'},engineSender);
  await until(()=>lastAnswer());
  replies=goalReplies();sent.length=0;fetches=[];
  await message({type:'jester/voice-command',text:'open my stuff'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(lastAnswer(),'Playing the requested episode.');
  assert.ok(fetches.length>0);
  for(const entry of fetches) assert.equal(JSON.parse(JSON.parse(entry.options.body).messages.at(-1).content).originalGoal,'open my stuff');
  assert.equal(session.agentTask,undefined);
});

test('waiting out a provider cooldown is not idle time; the minute starts when it ends',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await message({type:'jester/model-clear'});
  await message({type:'jester/model-save',connection:{provider:'groq',model:'cooling-model',key:'private-cooling-key'}});
  const start=Date.now();let elapsed=0;
  t.mock.method(Date,'now',()=>start+elapsed);
  replies=[Response.json({error:{message:'Rate limited'}},{status:429,headers:{'retry-after':'90'}})];sent.length=0;
  await message({type:'jester/voice-command',text:'go to rick and morty season 3 episode 2'},engineSender);
  await until(()=>lastAnswer());
  assert.match(lastAnswer(),/rate-limited/);
  assert.equal(session.agentTask.expiresAt,start+90000+60000);
  elapsed=120000;
  assert.equal((await message({type:'jester/get-state'})).resumeAvailable,true,'Keep going still works a minute after the cooldown');
  elapsed=150000;
  assert.equal((await message({type:'jester/get-state'})).resumeAvailable,false);
  assert.equal(session.agentTask,undefined);
  await message({type:'jester/model-clear'});
});

test('a follow-up sees the last few commands as context for two minutes, while its own command stays the goal',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await message({type:'jester/model-clear'});
  await message({type:'jester/model-save',connection:{provider:'groq',model:'memory-model',key:'private-memory-key',plan:'paid'}});
  delete session.recentCommands;
  const start=Date.now();let elapsed=0;
  t.mock.method(Date,'now',()=>start+elapsed);
  const prompts=()=>fetches.map(entry=>JSON.parse(JSON.parse(entry.options.body).messages.at(-1).content));
  replies=goalReplies();sent.length=0;fetches=[];
  await message({type:'jester/voice-command',text:'play rick and morty season 3 episode 2'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(prompts()[0].previousCommands,undefined,'Nothing came before the first command');

  replies=goalReplies();sent.length=0;fetches=[];elapsed=30000;
  await message({type:'jester/voice-command',text:'go to the next episode'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(prompts()[0].originalGoal,'go to the next episode');
  assert.deepEqual(prompts()[0].previousCommands,[{said:'play rick and morty season 3 episode 2',result:'Playing the requested episode.'}]);
  assert.equal(session.recentCommands.length,2);

  replies=goalReplies();sent.length=0;fetches=[];elapsed=30000+120000;
  await message({type:'jester/voice-command',text:'open my stuff'},engineSender);
  await until(()=>lastAnswer());
  assert.equal(prompts()[0].previousCommands,undefined,'Two minutes later the earlier commands are gone');
});

// The real-input path waits on real timers (a settle after each move), so poll by time.
async function eventually(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) { if (predicate()) return; await new Promise((done) => setTimeout(done, 10)); }
  assert.fail('Worker did not reach the expected state');
}

function realInputHarness(t, { attachError = null, cancelOnMove = false } = {}) {
  const debuggerCalls = [], steps = [], detachListeners = [];
  chrome.debugger = {
    attach: async (target, version) => { debuggerCalls.push(['attach', target.tabId, version]); if (attachError) throw new Error(attachError); },
    detach: async (target) => { debuggerCalls.push(['detach', target.tabId]); },
    sendCommand: async (target, method, params) => {
      debuggerCalls.push([method, params.type]);
      if (cancelOnMove && params.type === 'mouseMoved') {
        for (const listener of detachListeners) listener({ tabId: target.tabId }, 'canceled_by_user');
        throw new Error('Debugger is not attached to the tab');
      }
    },
    onDetach: { addListener: (fn) => detachListeners.push(fn) }
  };
  const original = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    if (message.type !== 'jester/agent-input') return original(tabId, message, options);
    steps.push(message.step);
    if (message.step === 'aim') return { ok: true, category: 'browse', label: 'Play episode', pageId: 'doc1', x: 40, y: 50 };
    if (message.step === 'land') return { ok: true, x: 40, y: 50, pageId: 'doc1' };
    return { ok: true, pageId: 'doc1' };
  };
  t.after(() => { chrome.tabs.sendMessage = original; delete chrome.debugger; });
  return { debuggerCalls, steps };
}

test('voice clicks use Chrome\'s real mouse for the task, and the debugger is released when it ends',async(t)=>{
  t.mock.method(console,'info',()=>{});
  await message({type:'jester/model-clear'});
  // These tests are about input, not pacing: a paid plan keeps free-tier windows out of them.
  await message({type:'jester/model-save',connection:{provider:'groq',model:'real-model',key:'private-real-key',plan:'paid'}});
  await settings({agentPermissionBoundary:'entertainment',agentRealInput:true});
  classification={ok:true,category:'browse',label:'Play episode',pageId:'doc1'};
  const {debuggerCalls,steps}=realInputHarness(t);
  replies=goalReplies();sent.length=0;const before=executeCount;
  await message({type:'jester/voice-command',text:'Play episode 1'},engineSender);
  await eventually(()=>lastAnswer());
  assert.equal(lastAnswer(),'Playing the requested episode.');
  assert.equal(executeCount,before,'No scripted click when the real one landed');
  assert.deepEqual(steps,['aim','aim','land','done'],'Aim again once the debugging bar has settled the layout');
  assert.deepEqual(debuggerCalls.map(([method,detail])=>method.startsWith('Input.')?detail:method),
    ['attach','mouseMoved','mousePressed','mouseReleased','detach']);
  assert.equal(debuggerCalls[0][2],'1.3');
});

test('real input falls back to scripted events when Chrome refuses, the bar is dismissed, or the setting is off',async(t)=>{
  t.mock.method(console,'info',()=>{});
  for(const scenario of ['refused','dismissed','off']){
    await settings({agentRealInput:scenario!=='off'});
    const {debuggerCalls,steps}=realInputHarness(t,{attachError:scenario==='refused'?'Cannot attach to this target.':null,
      cancelOnMove:scenario==='dismissed'});
    replies=goalReplies();sent.length=0;const before=executeCount;
    await message({type:'jester/voice-command',text:'Play episode 1'},engineSender);
    await eventually(()=>lastAnswer());
    assert.equal(lastAnswer(),'Playing the requested episode.',scenario);
    assert.equal(executeCount,before+1,`${scenario}: the scripted click still runs`);
    assert.equal(debuggerCalls.some(([,type])=>type==='mousePressed'),false,`${scenario}: nothing is pressed through the debugger`);
    if(scenario==='off') assert.deepEqual([steps,debuggerCalls],[[],[]]);
    if(scenario==='refused') assert.deepEqual(steps,['aim','done']);
    delete chrome.debugger;
  }
  await settings({agentRealInput:true});
});

test('a look labels the tab, captures it through the debugger and sends it only to a model that can read it',async(t)=>{
  t.mock.method(console,'info',()=>{});
  const steps=[],commands=[];
  chrome.debugger={attach:async()=>{},detach:async()=>{},onDetach:{addListener(){}},
    sendCommand:async(target,method)=>{commands.push(method);return method==='Page.captureScreenshot'?{data:'SHOT'}:{};}};
  const original=chrome.tabs.sendMessage;
  chrome.tabs.sendMessage=async(tabId,message,options)=>{
    if(message.type!=='jester/agent-marks') return original(tabId,message,options);
    steps.push(message.step);
    return message.step==='show'?{ok:true,legend:[{n:1,id:'doc1.9',role:'button',name:'(unnamed)'}]}:{ok:true};
  };
  t.after(()=>{chrome.tabs.sendMessage=original;delete chrome.debugger;});
  const lookThenFinish=()=>[{action:{action:'look'}},{action:{action:'finish',success:true,say:'Subtitles are on.'}}];
  const body=index=>JSON.parse(fetches[index].options.body);
  for(const scenario of ['vision','off','text-only']){
    await message({type:'jester/model-clear'});
    await message({type:'jester/model-save',connection:{provider:'groq',plan:'paid',key:'private-look-key',
      model:scenario==='text-only'?'openai/gpt-oss-120b':'meta-llama/llama-4-scout-17b-16e-instruct'}});
    await settings({agentScreenshots:scenario!=='off',agentRealInput:true});
    steps.length=0;commands.length=0;replies=lookThenFinish();sent.length=0;fetches=[];
    await message({type:'jester/voice-command',text:'turn on subtitles'},engineSender);
    await eventually(()=>lastAnswer());
    const second=body(1).messages[1].content;
    if(scenario==='vision'){
      assert.deepEqual(steps,['show','hide'],'Labels come off after the capture');
      assert.ok(commands.includes('Page.captureScreenshot'));
      assert.deepEqual(second[1],{type:'image_url',image_url:{url:'data:image/jpeg;base64,SHOT'}});
      assert.deepEqual(JSON.parse(second[0].text).screenshot.legend,['1=doc1.9 button "(unnamed)"']);
    } else {
      assert.deepEqual(steps,[],`${scenario}: nothing is labelled or captured`);
      assert.equal(typeof second,'string',`${scenario}: no image is sent`);
      assert.match(JSON.parse(second).lastResult.detail,scenario==='off'?/off in Settings/:/can read screenshots/);
    }
  }
  await settings({agentScreenshots:true});
});

// Last in the file: each restart loads another worker instance into this process.
test('a restarted worker keeps a paused task\'s own clock and drops stale or unclocked tasks',async(t)=>{
  t.mock.method(console,'info',()=>{});
  const snapshot={version:1,goal:'go to rick and morty season 3 episode 2',memory:{},steps:4};
  const start=Date.now();let elapsed=0;
  t.mock.method(Date,'now',()=>start+elapsed);
  const restart=async(task,name)=>{
    session.agentTask=structuredClone(task);
    const before=runtimeMessages.listeners.length;
    await import(`../jester-extension/src/background/service-worker.js?restart=${name}`);
    await tick();
    const worker=runtimeMessages.listeners[before];
    return ()=>new Promise(resolve=>worker({type:'jester/get-state'},uiSender,resolve));
  };
  const fresh=await restart({snapshot,tabId:7,initialUrl:tab.url,expiresAt:start+30000},'fresh');
  assert.equal((await fresh()).resumeAvailable,true,'A restart within the minute keeps the task');
  elapsed=30000;
  assert.equal((await fresh()).resumeAvailable,false,'Its minute runs from its last step, not from the restart');
  assert.equal(session.agentTask,undefined);
  const stale=await restart({snapshot,tabId:7,initialUrl:tab.url,expiresAt:start+29999},'stale');
  assert.equal((await stale()).resumeAvailable,false);
  assert.equal(session.agentTask,undefined);
  const unclocked=await restart({snapshot,tabId:7,initialUrl:tab.url},'unclocked');
  assert.equal((await unclocked()).resumeAvailable,false,'A task stored before expiry existed is dropped');
  assert.equal(session.agentTask,undefined);
});
