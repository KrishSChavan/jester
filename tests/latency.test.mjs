import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { runAssistant, actionLabel } from '../jester-extension/src/background/assistant.js';
import { RateLimitError, ModelReplyError, ModelTruncatedError } from '../jester-extension/src/background/model-client.js';

const test = (name, callback) => nodeTest(name, async (t) => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  await callback(t, logs);
});
const taskMetrics = (logs) => logs.filter(([label]) => label === '[jester] task timing').map(([, json]) => JSON.parse(json));
const env = { provider: 'groq', model: 'openai/gpt-oss-120b', key: 'private-user-key' };
const goal = 'play season 3 episode 1 of Rick and Morty';
const element = (id, role, name, extra = {}) => ({ id, role, name, ...extra });
const season = (selected) => element('season', 'combobox', 'Season', { options: [
  { label: 'Season 1', value: 's1', selected: selected === 1 },
  { label: 'Season 3', value: 's3', selected: selected === 3 }
] });
const page = (elements = [], extra = {}) => ({ ok: true, pageId: 'document:1', revision: 1,
  url: 'https://watch.example/show/rick', title: 'Rick & Morty', elements,
  text: elements.map((entry) => `[${entry.id}] ${entry.role} ${entry.name}`).join('\n'), ...extra });
const flow = [
  page([element('show', 'link', 'Rick & Morty')], { title: 'Home' }),
  page([season(1)], { revision: 2 }),
  page([season(3), element('episode', 'button', 'Episode 1', { context: 'Rick & Morty Season 3 Episode 1' })], { revision: 3 }),
  page([element('video', 'video', 'Video', { paused: true, playing: false, context: 'Rick & Morty Season 3 Episode 1' })], { revision: 4 }),
  page([element('video', 'video', 'Video', { paused: false, playing: true, context: 'Rick & Morty Season 3 Episode 1' })], { revision: 5 })
];
const typeAndEnter = [
  { action: 'type', elementId: 'search', text: 'Dune' },
  { action: 'press_key', elementId: 'search', key: 'Enter' }
];
const finish = { action: { action: 'finish', say: 'Search completed.', success: true } };

function fixture({ pages = null, replies = [], execute, observe, checkpoint } = {}) {
  const actions = [];
  const checkpoints = [];
  const events = [];
  const prompts = [];
  let modelCalls = 0;
  const host = {
    observe: async (options) => {
      events.push({ type: 'observe' });
      if (observe) return observe({ actions, options });
      return pages ? pages[Math.min(actions.length, pages.length - 1)] : page([], { revision: actions.length + 1 });
    },
    execute: async (action) => {
      events.push({ type: 'execute', action: structuredClone(action) });
      actions.push(action);
      return execute ? execute(action, actions.length) : { ok: true, detail: 'Control activated.' };
    },
    checkpoint: async (value) => {
      const snapshot = structuredClone(value);
      events.push({ type: 'checkpoint', snapshot });
      checkpoints.push(snapshot);
      if (checkpoint) await checkpoint(snapshot);
    },
    thinking: async () => {}
  };
  const modelClient = async (request) => {
    prompts.push(JSON.parse(request.prompt));
    const reply = replies[modelCalls++];
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error('Unexpected model request');
    return { json: reply };
  };
  return { host, modelClient, actions, checkpoints, events, prompts, get modelCalls() { return modelCalls; } };
}

function assertEveryMutationCheckpointed(events) {
  const mutations = events.filter((event) => event.type === 'execute');
  assert.ok(mutations.length);
  for (const [index, event] of events.entries()) {
    if (event.type !== 'execute') continue;
    const before = events[index - 1];
    const after = events[index + 1];
    assert.equal(before.type, 'checkpoint');
    assert.deepEqual(before.snapshot.pendingAction, event.action);
    assert.equal(after.type, 'checkpoint');
    assert.equal(after.snapshot.pendingAction, null);
    assert.equal(after.snapshot.steps, before.snapshot.steps + 1);
  }
}

test('full exact title, season, episode and verified playback flow makes zero model requests', async (_t, logs) => {
  const h = fixture({ pages: flow });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  assert.equal(h.modelCalls, 0);
  assert.deepEqual(h.actions.map((action) => action.action), ['click', 'select', 'click', 'command']);
  assert.deepEqual(h.actions.map((action) => action.elementId || action.actionId), ['show', 'season', 'episode', 'PLAY']);
  assert.equal(h.checkpoints.at(-1), null);
  assertEveryMutationCheckpointed(h.events);
  const metrics = taskMetrics(logs)[0];
  assert.ok(metrics);
  assert.equal(metrics.modelCalls, 0);
  assert.equal(metrics.localActions, 4);
  assert.equal(metrics.actions, 4);
  assert.equal(metrics.retryWaitMs, 0);
  assert.equal(metrics.readinessWaitMs, 0);
  assert.equal(JSON.stringify(metrics).includes(env.key), false);
});

test('exact local controls can finish without a configured cloud provider', async () => {
  const h = fixture({ pages: flow });
  const result = await runAssistant({ text: goal, env: {}, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  assert.equal(h.modelCalls, 0);
  assert.equal(h.actions.length, 4);
});

test('exact playback commands skip both page extraction and model requests while retaining checkpoints', async (_t, logs) => {
  for (const [text, actionId] of [['pause', 'PAUSE'], ['play', 'PLAY'], ['volume up', 'VOLUME_UP'],
    ['volume down', 'VOLUME_DOWN'], ['toggle fullscreen', 'FULLSCREEN_TOGGLE']]) {
    const h = fixture({ observe: async () => { throw new Error('Playback shortcut must not extract the page'); } });
    const result = await runAssistant({ text, env: {}, host: h.host, modelClient: h.modelClient });
    assert.equal(result.ok, true);
    assert.equal(h.modelCalls, 0);
    assert.deepEqual(h.actions, [{ action: 'command', actionId }]);
    assertEveryMutationCheckpointed(h.events);
    assert.equal(h.events.some((event) => event.type === 'observe'), false);
    assert.equal(h.checkpoints.at(-1), null);
  }
  for (const metrics of taskMetrics(logs)) {
    assert.equal(metrics.observeMs, 0);
    assert.equal(metrics.modelCalls, 0);
    assert.equal(metrics.actions, 1);
    assert.equal(metrics.localActions, 1);
  }
});

test('a failed direct playback command pauses without page extraction or cloud fallback', async () => {
  const h = fixture({
    observe: async () => { throw new Error('Failed playback must not extract the page'); },
    execute: async () => ({ ok: false, detail: 'No player is available.' })
  });
  const result = await runAssistant({ text: 'pause', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.match(result.say, /No player/);
  assert.equal(h.actions.length, 1);
  assert.equal(h.modelCalls, 0);
  assert.equal(h.events.some((event) => event.type === 'observe'), false);
  assert.equal(result.resume.goal, 'pause');
  assertEveryMutationCheckpointed(h.events);
});

test('an interrupted playback command is inspected on resume instead of blindly replayed', async () => {
  const h = fixture({ replies: [{ action: { action: 'finish', say: 'Playback status is unavailable.', success: false } }] });
  const result = await runAssistant({ text: 'keep going', env, host: h.host, modelClient: h.modelClient,
    resume: { goal: 'pause', steps: 1, pendingAction: { action: 'command', actionId: 'PAUSE' } } });
  assert.equal(result.ok, false);
  assert.equal(h.actions.length, 0);
  assert.equal(h.modelCalls, 1);
  assert.equal(h.events.filter((event) => event.type === 'observe').length, 1);
  assert.match(h.prompts[0].memory.recent.at(-1).detail, /outcome is unknown/);
});

test('ambiguous mute and fullscreen requests are not converted into unsafe toggle shortcuts', async () => {
  for (const text of ['mute', 'unmute', 'fullscreen']) {
    const h = fixture({ replies: [{ action: { action: 'finish', say: 'Specify the intended control.', success: false } }] });
    await runAssistant({ text, env, host: h.host, modelClient: h.modelClient });
    assert.equal(h.actions.length, 0);
    assert.equal(h.modelCalls, 1);
    assert.equal(h.events.filter((event) => event.type === 'observe').length, 1);
  }
});

test('typing and Enter grouping uses one model request for two mutations instead of two', async (_t, logs) => {
  const grouped = fixture({ replies: [{ actions: typeAndEnter }] });
  const groupedResult = await runAssistant({ text: 'Find Dune in the catalog', env, host: grouped.host,
    modelClient: grouped.modelClient, maxActions: 2 });
  const separate = fixture({ replies: typeAndEnter.map((action) => ({ action })) });
  const separateResult = await runAssistant({ text: 'Find Dune in the catalog', env, host: separate.host,
    modelClient: separate.modelClient, maxActions: 2 });
  assert.equal(grouped.modelCalls, 1);
  assert.equal(separate.modelCalls, 2);
  assert.deepEqual(grouped.actions.map((action) => action.action), ['type', 'press_key']);
  assert.deepEqual(separate.actions, grouped.actions);
  assert.equal(groupedResult.resume.steps, 2);
  assert.equal(separateResult.resume.steps, 2);
  assertEveryMutationCheckpointed(grouped.events);
  assertEveryMutationCheckpointed(separate.events);
  const metrics = taskMetrics(logs);
  assert.deepEqual(metrics.map((entry) => entry.modelCalls), [1, 2]);
  assert.equal(grouped.prompts[0].originalGoal, 'Find Dune in the catalog');
  assert.equal(Object.hasOwn(grouped.prompts[0].memory, 'goal'), false);
});

test('a group discards its queued actions after navigation and obtains a fresh model decision', async () => {
  const h = fixture({
    replies: [{ actions: typeAndEnter }, finish],
    observe: async ({ actions }) => page([], { pageId: actions.length ? 'document:2' : 'document:1', revision: 1 })
  });
  const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  assert.equal(h.actions.length, 1);
  assert.equal(h.modelCalls, 2);
  assert.equal(h.prompts[1].page.pageId, 'document:2');
  assertEveryMutationCheckpointed(h.events);
});

test('failure or uncertain execution stops the group before another queued mutation', async () => {
  for (const outcome of [{ ok: false, detail: 'Target became stale.' },
    { ok: true, uncertain: true, detail: 'The document stopped replying.' }]) {
    const h = fixture({ replies: [{ actions: typeAndEnter }, finish], execute: async () => outcome });
    const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient });
    assert.equal(result.ok, true);
    assert.equal(h.actions.length, 1);
    assert.equal(h.modelCalls, 2);
    assertEveryMutationCheckpointed(h.events);
  }
});

test('permission denial pauses a grouped operation before any following action or model call', async () => {
  const h = fixture({ replies: [{ actions: typeAndEnter }],
    execute: async () => ({ ok: false, denied: true, detail: 'This action was not approved.' }) });
  const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.match(result.say, /not approved/);
  assert.equal(h.actions.length, 1);
  assert.equal(h.modelCalls, 1);
  assert.equal(result.resume.steps, 1);
  assertEveryMutationCheckpointed(h.events);
});

test('long rate limiting causes one outer model attempt and preserves resumable state', async (_t, logs) => {
  const limited = new RateLimitError({ provider: 'groq', retryAfterMs: 90000 });
  limited.timings = { requestMs: 8, retryWaitMs: 0, attempts: 1, totalMs: 8 };
  const h = fixture({ replies: [limited] });
  let delayCalls = 0;
  const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient,
    delay: async () => { delayCalls += 1; } });
  assert.equal(result.ok, false);
  assert.equal(h.modelCalls, 1);
  assert.equal(h.actions.length, 0);
  assert.equal(delayCalls, 0);
  assert.equal(result.resume.goal, 'Find Dune in the catalog');
  assert.match(result.say, /rate limited/);
  const metrics = taskMetrics(logs)[0];
  assert.equal(metrics.modelCalls, 1);
  assert.equal(metrics.retryWaitMs, 0);
});

test('a delayed season update waits locally for fresh season evidence without spending a model call', async (_t, logs) => {
  let ready = false;
  const waits = [];
  const h = fixture({ observe: async ({ actions }) => {
    if (actions.length === 2 && !ready) return page([season(1)], { revision: 2 });
    return flow[Math.min(actions.length, flow.length - 1)];
  } });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { waits.push(ms); ready = true; } });
  assert.equal(result.ok, true);
  assert.equal(h.modelCalls, 0);
  assert.deepEqual(waits, [60]);
  assert.deepEqual(h.actions.map((action) => action.action), ['click', 'select', 'click', 'command']);
  const metrics = taskMetrics(logs)[0];
  assert.equal(metrics.readinessWaitMs, 60);
  assertEveryMutationCheckpointed(h.events);
});

test('canceling between grouped actions preserves progress and never executes the queued mutation', async () => {
  const controller = new AbortController();
  const h = fixture({ replies: [{ actions: typeAndEnter }], execute: async () => {
    controller.abort();
    return { ok: true, detail: 'First control changed.' };
  } });
  const result = await runAssistant({ text: 'Find Dune in the catalog', env, signal: controller.signal,
    host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.equal(result.say, '');
  assert.equal(h.actions.length, 1);
  assert.equal(h.modelCalls, 1);
  assert.equal(result.resume.steps, 1);
  assert.equal(result.resume.pendingAction, null);
  assert.notEqual(h.checkpoints.at(-1), null);
});

test('cancellation during readiness observation cannot report completion or clear the saved task', async () => {
  const controller = new AbortController();
  let waiting = false;
  const h = fixture({ observe: async ({ actions }) => {
    if (actions.length < 2) return flow[actions.length];
    if (!waiting) return page([season(1)], { revision: 2 });
    controller.abort();
    return flow.at(-1);
  } });
  const result = await runAssistant({ text: goal, env, signal: controller.signal, host: h.host,
    modelClient: h.modelClient, delay: async () => { waiting = true; } });
  assert.equal(result.ok, false);
  assert.equal(result.say, '');
  assert.equal(h.modelCalls, 0);
  assert.equal(h.actions.length, 2);
  assert.notEqual(h.checkpoints.at(-1), null);
});

test('search results arriving after 700 ms are observed locally without any provider request', async (_t, logs) => {
  let elapsed = 0;
  const waits = [];
  const search = (value = '') => page([element('search', 'searchbox', 'Search Hulu', { value })], { title: 'Search', revision: 2 });
  const h = fixture({ observe: async ({ actions }) => {
    if (!actions.length) return page([element('search-nav', 'button', 'Search')], { title: 'Home' });
    if (actions.length === 1) return search();
    if (actions.length === 2 || (actions.length === 3 && elapsed < 1400)) return search('Rick and Morty');
    if (actions.length === 3) return page([element('show', 'link', 'Rick and Morty')], { title: 'Search', revision: 3 });
    if (actions.length === 4) return flow[1];
    if (actions.length === 5) return flow[2];
    return flow.at(-1);
  } });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { waits.push(ms); elapsed += ms; } });
  assert.equal(result.ok, true);
  assert.equal(h.modelCalls, 0);
  assert.ok(elapsed >= 1400 && elapsed <= 2000);
  assert.deepEqual(h.actions.map((action) => action.action), ['click', 'type', 'press_key', 'click', 'select', 'click']);
  assertEveryMutationCheckpointed(h.events);
  assert.equal(logs.some(([label]) => label === '[jester] local fallback'), false);
});

test('model-produced show typing and Enter also wait locally for delayed search results', async () => {
  let elapsed = 0;
  const h = fixture({ replies: [{ actions: [
    { action: 'type', elementId: 'explore', text: 'Rick and Morty' },
    { action: 'press_key', elementId: 'explore', key: 'Enter' }
  ] }], observe: async ({ actions }) => {
    const entered = actions.some((action) => action.action === 'press_key');
    const opened = actions.some((action) => action.elementId === 'show');
    const played = actions.some((action) => action.elementId === 'episode');
    if (played) return flow.at(-1);
    if (opened) return flow[2];
    if (entered && elapsed >= 1400) return page([element('show', 'link', 'Rick and Morty')], { title: 'Search', revision: 3 });
    return page([element('explore', 'textbox', 'Explore', {
      value: actions.some((action) => action.action === 'type') ? 'Rick and Morty' : ''
    })], { title: 'Search', revision: 2 });
  }, execute: async () => ({ ok: true, detail: 'Control activated.', elements: [] }) });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { elapsed += ms; } });
  assert.equal(result.ok, true);
  assert.equal(h.modelCalls, 1);
  assert.ok(elapsed >= 1400 && elapsed <= 2000);
  assert.deepEqual(h.actions.map((action) => action.action), ['find_text', 'type', 'press_key', 'click', 'click']);
  assertEveryMutationCheckpointed(h.events);
});

test('a local search transition waits at most two seconds before bounded provider fallback', async (_t, logs) => {
  let elapsed = 0;
  const h = fixture({ replies: [{ action: { action: 'finish', success: false, say: 'No verified result is available.' } }],
    observe: async ({ actions }) => page([element('search', 'searchbox', 'Search Hulu', {
      value: actions.length ? 'Rick and Morty' : ''
    })], { title: 'Search' }) });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { elapsed += ms; } });
  assert.equal(result.ok, false);
  assert.equal(h.modelCalls, 1);
  assert.equal(elapsed, 2000);
  assert.deepEqual(h.actions.map((action) => action.action), ['type', 'press_key']);
  const fallback = logs.find(([label]) => label === '[jester] local fallback')?.[1];
  assert.equal(fallback.reason, 'no-unique-verified-target');
  assert.equal(fallback.readinessWaitMs, 2000);
  assert.equal(JSON.stringify(fallback).includes('Rick'), false);
  assert.equal(JSON.stringify(fallback).includes(env.key), false);
});

test('failed and uncertain local search submissions do not start a readiness wait', async () => {
  for (const outcome of [{ ok: false, detail: 'Search became stale.' }, { ok: true, uncertain: true, detail: 'Search may not have submitted.' }]) {
    let waits = 0;
    const h = fixture({ replies: [{ action: { action: 'finish', success: false, say: 'Search needs inspection.' } }],
      observe: async () => page([element('search', 'searchbox', 'Search Hulu', { value: 'Rick and Morty' })], { title: 'Search' }),
      execute: async () => outcome });
    const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
      delay: async () => { waits++; } });
    assert.equal(result.ok, false);
    assert.equal(h.modelCalls, 1);
    assert.equal(waits, 0);
    assert.equal(h.actions.length, 1);
  }
});

test('search and show navigation share a four-second task readiness budget', async () => {
  let elapsed = 0;
  let readyAt = Infinity;
  let stage = 'empty-search';
  const search = (value) => page([element('search', 'searchbox', 'Search Hulu', { value })], { title: 'Search', revision: 1 });
  const results = () => page([element('show', 'link', 'Rick and Morty')], { title: 'Search', revision: 2 });
  const h = fixture({ replies: [{ action: { action: 'finish', success: false, say: 'The season is still loading.' } }],
    observe: async () => {
      if (stage === 'empty-search') return search('');
      if (stage === 'typed' || (stage === 'search-loading' && elapsed < readyAt)) return search('Rick and Morty');
      if (stage === 'search-loading' || (stage === 'show-loading' && elapsed < readyAt)) return results();
      return flow[1];
    }, execute: async (action) => {
      if (action.action === 'type') stage = 'typed';
      if (action.action === 'press_key') { stage = 'search-loading'; readyAt = elapsed + 2000; }
      if (action.elementId === 'show') { stage = 'show-loading'; readyAt = elapsed + 2000; }
      if (action.action === 'select') stage = 'season-loading';
      return { ok: true, detail: 'Control activated.' };
    } });
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { elapsed += ms; } });
  assert.equal(result.ok, false);
  assert.equal(h.modelCalls, 1);
  assert.equal(elapsed, 4000);
  assert.deepEqual(h.actions.map((action) => action.action), ['type', 'press_key', 'click', 'select']);
});

test('a model-assisted season click waits for the pane after a failed local attempt', async (_t, logs) => {
  let ready = false;
  const old = page([element('s1','heading','Season 1'),element('s3','button','Season 3')]);
  const h = fixture({replies:[{action:{action:'click',elementId:'s3'}}],
    observe:async({actions}) => actions.length < 2 || !ready ? old : actions.length === 2 ? flow[2] : flow.at(-1),
    execute:async(_action,count) => count === 1 ? {ok:false,detail:'Target is covered by another page element'} : {ok:true,detail:'Clicked'}
  });
  const result = await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient,
    delay:async()=>{ready=true;}});
  assert.equal(result.ok,true);
  assert.equal(h.modelCalls,1);
  assert.deepEqual(h.actions.map(action=>action.elementId),['s3','s3','episode']);
  assert.equal(taskMetrics(logs)[0].readinessWaitMs,60);
  assertEveryMutationCheckpointed(h.events);
});

test('uncertain local actions preserve the outcome flag and never commit shortcut progress', async (_t, logs) => {
  const h = fixture({pages:[flow[0]],replies:[{action:{action:'finish',success:false,say:'Inspect the show page.'}}],
    execute:async()=>({ok:true,uncertain:true,detail:'Document changed before replying'})});
  const result = await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient});
  assert.equal(result.ok,false);
  assert.equal(h.actions.length,1);
  assert.equal(h.prompts[0].lastResult.uncertain,true);
  const saved = h.checkpoints.find(snapshot=>snapshot?.steps===1);
  assert.deepEqual(saved.localProgress,{});
  assert.equal(saved.memory.recent.at(-1).ok,false);
  assert.equal(taskMetrics(logs)[0].readinessWaitMs,0);
});

test('failure diagnostics include the failed operation while removing private values', async (_t, logs) => {
  const h = fixture({pages:[flow[0]],replies:[{action:{action:'finish',success:false,say:'Inspect the control.'}}],
    execute:async()=>({ok:false,detail:`Target covered for Rick and Morty ${env.key} https://www.hulu.com/?token=private`})});
  await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient});
  const failures = logs.filter(([label])=>label==='[jester] action result').map(([,json])=>JSON.parse(json));
  assert.equal(failures[0].action,'click');
  assert.equal(failures[0].elementId,'show');
  assert.equal(failures[0].source,'local');
  assert.equal(failures[0].confirmed,false);
  assert.match(failures[0].detail,/Target covered/);
  assert.doesNotMatch(JSON.stringify(failures),/Rick|private|www\.hulu/);
  assert.equal(JSON.stringify(failures).includes(env.key),false);
});

test('covered-target diagnostics report bounded blocker identities and geometry without private page data', async (_t, logs) => {
  const privateUrl = 'https://www.hulu.com/?token=private';
  const blocker = {id:'cover',role:'button',name:`Rick & Morty ${env.key} ${privateUrl}`,
    sameDestination:false,sameCard:true,containsTarget:false,url:privateUrl,
    context:goal,selector:'#private-control',html:'private-draft'};
  const surface = {tag:'DIV',role:'presentation',pointerEvents:'auto',position:'fixed',zIndex:'999',
    rect:{left:-2.7,top:0,width:1920.1,height:1080,secret:env.key},relation:'unrelated',
    name:goal,className:env.key,url:privateUrl,outerHTML:'private-draft'};
  const hitTest = {samples:100,target:{...surface,tag:'A',role:'link'},hits:Array.from({length:8},()=>surface),
    transcript:goal,apiKey:env.key};
  const h = fixture({pages:[flow[0]],replies:[{action:{action:'finish',success:false,say:'Inspect the control.'}}],
    execute:async()=>({ok:false,errorClass:'covered_target',notDispatched:true,
      detail:'Target is covered by another page element',blockingElements:Array.from({length:6},()=>blocker),hitTest})});
  await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient});
  const failure = logs.filter(([label])=>label==='[jester] action result').map(([,json])=>JSON.parse(json))[0];
  assert.equal(failure.blockingElements.length,2);
  assert.equal(failure.blockingElements[0].id,'cover');
  assert.equal(failure.blockingElements[0].sameDestination,false);
  assert.equal(failure.blockingElements[0].sameCard,true);
  assert.match(failure.blockingElements[0].name,/requested show/);
  assert.equal(failure.hitTest.samples,48);
  assert.equal(failure.hitTest.hits.length,3);
  assert.equal(failure.hitTest.target.tag,'a');
  assert.equal(failure.hitTest.hits[0].position,'fixed');
  assert.deepEqual(failure.hitTest.hits[0].rect,{left:-3,top:0,width:1920,height:1080});
  assert.equal(failure.hitTest.hits[0].relation,'unrelated');
  assert.ok(JSON.stringify(failure).length<1800);
  assert.doesNotMatch(JSON.stringify(failure),/Rick|Morty|private|www\.hulu|outerHTML|className|selector|apiKey|transcript/);
  assert.deepEqual(h.prompts[0].lastResult.hitTest,failure.hitTest);
  assert.ok(JSON.stringify(h.prompts[0].lastResult).length<=1800);
});

test('an old control failure does not label a later missing target as the same failure', async (_t, logs) => {
  const h = fixture({pages:[flow[0],page([],{title:'Home'}),page([],{title:'Home'})],
    replies:[{action:{action:'finish',success:false,say:'No current target is verified.'}}],
    execute:async(_action,count)=>count===1?{ok:false,detail:'The title changed'}:{ok:true,elements:[]}});
  await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient});
  const fallback = logs.find(([label])=>label==='[jester] local fallback')?.[1];
  assert.equal(fallback.reason,'no-unique-verified-target');
});

test('invalid action diagnostics explain rejected fields without logging the proposed contents', async (_t, logs) => {
  const bad = {action:{action:'select',elementId:'picker',text:`private-draft ${env.key}`}};
  const h = fixture({replies:[bad,bad]});
  const result = await runAssistant({text:'Choose the next control',env,host:h.host,modelClient:h.modelClient});
  assert.equal(result.ok,false);
  assert.equal(h.actions.length,0);
  const invalid = logs.filter(([label])=>label==='[jester] invalid reply').map(([,json])=>JSON.parse(json));
  assert.equal(invalid.length,2);
  assert.match(invalid[0].error,/Unexpected action field/);
  assert.equal(invalid[0].proposal.actions[0].kind,'select');
  assert.deepEqual(invalid[0].proposal.actions[0].fields,['action','elementId','text']);
  assert.equal(JSON.stringify(invalid).includes(env.key),false);
  assert.equal(JSON.stringify(invalid).includes('private-draft'),false);
  assert.equal(taskMetrics(logs)[0].invalidReplyCount,2);
  assert.equal(taskMetrics(logs)[0].stopReason,'invalid-reply');
});

test('a model click on the requested episode finishes when its player starts, with no further model step', async (_t, logs) => {
  const watch = { pageId: 'document:2', url: 'https://www.hulu.com/watch/9f1c', title: 'Hulu' };
  const series = page([element('trailer', 'video', 'Video', { playing: true, paused: false }),
    element('s3e1', 'link', 'S3 E1 - The Rickshank Rickdemption')],
  { url: 'https://www.hulu.com/series/rick-and-morty-d76d6361', title: 'Hulu' });
  let polls = 0;
  const h = fixture({ replies: [{ action: { action: 'click', elementId: 's3e1' } }],
    observe: async ({ actions }) => {
      if (!actions.some((action) => action.action === 'click')) return series;
      polls += 1;
      return polls < 3 ? page([element('back', 'button', 'Back')], { ...watch, revision: polls })
        : page([element('player', 'video', 'Video', { playing: true, paused: false })], { ...watch, revision: 9 });
    } });
  const statuses = [];
  h.host.thinking = async ({ status }) => { statuses.push(status); };
  const waits = [];
  const result = await runAssistant({ text: goal, env, host: h.host, modelClient: h.modelClient,
    delay: async (ms) => { waits.push(ms); } });
  assert.equal(result.ok, true);
  assert.equal(result.say, 'Playing Rick and Morty, season 3, episode 1.');
  assert.equal(h.modelCalls, 1);
  assert.deepEqual(waits, [150, 250]);
  assert.ok(statuses.includes('Clicking “S3 E1 - The Rickshank Rickdemption”'));
  assert.ok(statuses.includes('Waiting for the episode to start'));
  const metrics = taskMetrics(logs)[0];
  assert.equal(metrics.stopReason, 'completed');
  assert.equal(metrics.playbackWaitMs, 400);
  assert.equal(metrics.readinessWaitMs, 0);
});

test('the pill names the control and the action, never an element ID', () => {
  const elements = [element('s3e1', 'link', 'S3 E1 - The Rickshank Rickdemption'), element('blank', 'button', '(unnamed)'),
    element('seasons', 'combobox', 'Season', { options: [{ label: 'Season 3', value: 's3' }] })];
  const cases = [
    [{ action: 'click', elementId: 's3e1' }, 'Clicking “S3 E1 - The Rickshank Rickdemption”'],
    [{ action: 'click', elementId: 'blank' }, 'Clicking a control'],
    [{ action: 'select', elementId: 'seasons', value: 's3' }, 'Choosing “Season 3”'],
    [{ action: 'type', elementId: 'search', text: 'Rick and Morty' }, 'Typing “Rick and Morty”'],
    [{ action: 'press_key', elementId: 'search', key: 'Enter' }, 'Pressing Enter'],
    [{ action: 'command', actionId: 'PLAY' }, 'Pressing Play'],
    [{ action: 'navigate', url: 'https://www.hulu.com/hub/tv' }, 'Opening hulu.com/hub/tv'],
    [{ action: 'find_text', query: 'Rick and Morty' }, 'Looking for “Rick and Morty”'],
    [{ action: 'look' }, 'Taking a screenshot']
  ];
  for (const [action, label] of cases) assert.equal(actionLabel(action, elements), label);
});

test('an unreadable or cut-off model reply is asked again instead of pausing the task', async (_t, logs) => {
  for (const failure of [new ModelReplyError(), new ModelTruncatedError('anthropic')]) {
    logs.length = 0;
    const h = fixture({ replies: [failure, finish] });
    const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient });
    assert.equal(result.ok, true);
    assert.equal(result.say, 'Search completed.');
    assert.equal(h.modelCalls, 2);
    assert.equal(h.prompts[1].lastResult.ok, false);
    assert.match(h.prompts[1].lastResult.detail, /^Invalid response: Your reply was (not valid JSON|cut off)\./);
    assert.equal(taskMetrics(logs)[0].invalidReplyCount, 1);
  }
});

test('repeated unreadable replies pause with a resumable task', async (_t, logs) => {
  const h = fixture({ replies: [new ModelReplyError(), new ModelReplyError()] });
  const result = await runAssistant({ text: 'Find Dune in the catalog', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.equal(h.modelCalls, 2);
  assert.equal(h.actions.length, 0);
  assert.equal(result.resume.goal, 'Find Dune in the catalog');
  assert.match(result.say, /valid JSON.*keep going/);
  assert.equal(taskMetrics(logs)[0].stopReason, 'invalid-reply');
});

test('the exact spoken go-to task opens a covering Details link using fresh destination evidence',async()=>{
  const text='go to rick and morty season 3 episode 2';
  const poster=element('poster','link','Rick and Morty',{url:'https://www.hulu.com/series/rick'});
  const details=element('details','link','Details',{url:poster.url,context:'Rick and Morty'});
  const search=page([poster,details],{title:'Hulu | Search'});
  const h=fixture({observe:async({actions})=>{
    if(actions.length<2)return search;
    if(actions.length===2)return page([season(1)]);
    if(actions.length===3)return page([season(3),element('episode2','button','S3 E2')]);
    return page([element('video','video','Video',{playing:true,paused:false,context:'Rick and Morty Season 3 Episode 2'})]);
  },execute:async(action)=>action.elementId==='poster'?{ok:false,pageId:search.pageId,
    errorClass:'covered_target',notDispatched:true,detail:'Target is covered by another page element',
    blockingElements:[{...details,sameDestination:true}]}:{ok:true,detail:'Activated'}});
  const result=await runAssistant({text,env,host:h.host,modelClient:h.modelClient});
  assert.equal(result.ok,true);
  assert.equal(h.modelCalls,0);
  assert.deepEqual(h.actions.map(action=>action.elementId),['poster','details','season','episode2']);
  assertEveryMutationCheckpointed(h.events);
});

test('covered-card recovery never clicks a blocker without proof or after an uncertain press',async()=>{
  for(const failure of [{notDispatched:true,sameDestination:false},{notDispatched:false,sameDestination:true,uncertain:true}]) {
    const poster=element('poster','link','Rick and Morty',{url:'https://www.hulu.com/series/rick'});
    const details=element('details','link','Details',{url:poster.url});
    const h=fixture({pages:[page([poster,details],{title:'Search'})],
      replies:[{action:{action:'finish',success:false,say:'The result needs inspection.'}}],
      execute:async()=>({ok:false,errorClass:'covered_target',notDispatched:failure.notDispatched,
        ...(failure.uncertain?{uncertain:true}:{}),blockingElements:[{...details,sameDestination:failure.sameDestination}]})});
    const result=await runAssistant({text:goal,env,host:h.host,modelClient:h.modelClient});
    assert.equal(result.ok,false);
    assert.deepEqual(h.actions.map(action=>action.elementId),['poster']);
    assert.equal(h.prompts[0].lastResult.notDispatched,failure.notDispatched);
    assert.equal(h.prompts[0].lastResult.blockingElements[0].sameDestination,failure.sameDestination);
  }
});

// YouTube: a creator's latest video, the reported "it stopped after searching".
const yt = 'https://www.youtube.com';
const ytPage = (path, elements, extra = {}) => ({ ok: true, pageId: `p${path}`, revision: 1, url: `${yt}${path}`,
  title: 'YouTube', elements, truncated: false, text: elements.map((entry) => `[${entry.id}] ${entry.role} ${entry.name}`).join('\n'), ...extra });
const ytSearch = (value = '') => element('search', 'combobox', 'Search', { value, order: 2 });
const ytFlow = (actions) => {
  if (actions.length === 0) return ytPage('/', [ytSearch()]);
  if (actions.length === 1) return ytPage('/', [ytSearch('MrBeast')]);
  if (actions.length === 2) return ytPage('/results?search_query=MrBeast', [ytSearch('MrBeast'),
    element('avatar', 'link', 'Go to channel MrBeast', { url: `${yt}/@MrBeast`, order: 3 })], { title: 'MrBeast - YouTube' });
  if (actions.length === 3) return ytPage('/@MrBeast', [element('tab-home', 'tab', 'Home', { selected: true, order: 4 }),
    element('tab-videos', 'tab', 'Videos', { selected: false, order: 5 }),
    element('trailer', 'video', 'Video', { playing: true, paused: false, order: 6 })], { title: 'MrBeast - YouTube' });
  if (actions.length === 4) return ytPage('/@MrBeast/videos', [element('tab-videos', 'tab', 'Videos', { selected: true, order: 5 }),
    element('chip-latest', 'tab', 'Latest', { selected: true, order: 6 }),
    element('second', 'link', 'Second newest 12 minutes', { url: `${yt}/watch?v=second`, order: 8 }),
    element('newest', 'link', 'Newest upload 43 minutes', { url: `${yt}/watch?v=newest`, order: 7 })], { title: 'MrBeast - YouTube' });
  return ytPage('/watch?v=newest', [element('player', 'video', 'Video', { playing: true, paused: false })],
    { title: 'Newest upload - YouTube' });
};

test('a creator’s latest video plays through search, channel and Videos tab with zero model requests', async (_t, logs) => {
  const options = [];
  const seen = [];
  const h = fixture({ observe: async ({ actions, options: given }) => {
    options.push(given);
    seen.push(ytFlow(actions));
    return seen.at(-1);
  } });
  const result = await runAssistant({ text: "Go to MrBeast's latest video.", env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  assert.equal(result.say, 'Playing MrBeast’s latest video, “Newest upload”.');
  assert.equal(h.modelCalls, 0);
  assert.deepEqual(h.actions.map((action) => `${action.action}:${action.elementId || action.key || ''}`),
    ['type:search', 'press_key:search', 'click:avatar', 'click:tab-videos', 'click:newest']);
  assertEveryMutationCheckpointed(h.events);
  // Each look after the first names the page last seen, so the host can wait out a navigation.
  assert.equal(options[0].since, undefined);
  assert.deepEqual(options.slice(1).map((given) => given.since), seen.slice(0, -1).map((entry) => entry.pageId));
  assert.ok(options.every((given) => given.order === true), 'The grid’s first video needs document order');
  assert.equal(taskMetrics(logs)[0].readinessWaitMs, 0);
});

test('when no channel bears the spoken name, the model gets the settled results at once', async (_t, logs) => {
  const results = ytPage('/results?search_query=Linus', [ytSearch('Linus'),
    element('ltt', 'link', 'Go to channel Linus Tech Tips', { url: `${yt}/@LinusTechTips`, order: 3 })]);
  const h = fixture({ observe: async ({ actions }) => actions.length === 0 ? ytPage('/', [ytSearch()])
    : actions.length === 1 ? ytPage('/', [ytSearch('Linus')]) : results,
  replies: [{ action: { action: 'click', elementId: 'ltt' } },
    { action: { action: 'finish', say: 'Stopped here.', success: false } }] });
  const result = await runAssistant({ text: 'play the latest video from Linus', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.equal(h.prompts[0].page.url, results.url);
  assert.equal(taskMetrics(logs)[0].readinessWaitMs, 0, 'A give-up is not a page still loading');
  // After the model's click the planner does not search over its work.
  assert.deepEqual(h.actions.map((action) => action.action), ['type', 'press_key', 'click']);
  assert.equal(h.modelCalls, 2);
});

test('a playback goal reported done with nothing playing is sent back once', async (_t, logs) => {
  const idle = page([element('trailer-link', 'link', 'Dune trailer')]);
  const h = fixture({ pages: [idle], replies: [
    { action: { action: 'finish', say: 'Searched for the trailer.', success: true } },
    { action: { action: 'finish', say: 'The trailer will not play here.', success: false } }] });
  const result = await runAssistant({ text: 'play the Dune trailer', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, false);
  assert.equal(result.say, 'The trailer will not play here.');
  assert.match(h.prompts[1].lastResult.detail, /no video is playing/);
  assert.equal(logs.filter(([label]) => label === '[jester] finish challenged').length, 1);
  // Playing evidence, or a goal that needs none, is accepted at once.
  for (const [text, pages] of [['play the Dune trailer', [page([element('v', 'video', 'Video', { playing: true, paused: false })])]],
    ['open my watchlist', [idle]]]) {
    const accepted = fixture({ pages, replies: [{ action: { action: 'finish', say: 'Done.', success: true } }] });
    assert.equal((await runAssistant({ text, env, host: accepted.host, modelClient: accepted.modelClient })).ok, true);
    assert.equal(accepted.modelCalls, 1);
  }
});

test('next-video and skip-ad requests go straight to the player', async () => {
  for (const [text, actionId] of [['Next video.', 'NEXT_VIDEO'], ['play the next video', 'NEXT_VIDEO'], ['Skip the ad', 'SKIP_AD']]) {
    const h = fixture({ observe: async () => { throw new Error('A player command must not extract the page'); } });
    const result = await runAssistant({ text, env: {}, host: h.host, modelClient: h.modelClient });
    assert.equal(result.ok, true);
    assert.deepEqual(h.actions, [{ action: 'command', actionId }]);
    assert.equal(h.modelCalls, 0);
  }
});

// Browser commands: one-step tab commands, and "open <site> and …" in two local stages.
test('one-step tab commands run once with no page read or model, and answer with what happened', async () => {
  for (const [text, op] of [['Next tab.', 'next'], ['close this tab', 'close'], ['Reopen the last closed tab', 'reopen'], ['new window', 'window']]) {
    const h = fixture({ observe: async () => { throw new Error('A tab command must not read the page'); },
      execute: async (action) => ({ ok: true, detail: `${action.op} done.` }) });
    const result = await runAssistant({ text, env: {}, host: h.host, modelClient: h.modelClient });
    assert.equal(result.ok, true);
    assert.equal(result.say, `${op} done.`);
    assert.deepEqual(h.actions, [{ action: 'browser', op }]);
    assert.equal(h.modelCalls, 0);
  }
  const scroll = fixture({ observe: async () => { throw new Error('no read'); } });
  assert.equal((await runAssistant({ text: 'scroll to the bottom', env: {}, host: scroll.host, modelClient: scroll.modelClient })).say,
    'Scrolled to the bottom.');
});

test('"open YouTube and play MrBeast’s latest video" opens YouTube, then plays locally there with zero model requests', async (_t, logs) => {
  // From Gmail: the first stage opens YouTube; the second is the YouTube flow, starting at its home page.
  const gmail = { ok: true, pageId: 'gmail', revision: 1, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', elements: [],
    text: 'Inbox', tabs: [{ tabId: 7, title: 'Inbox', url: 'https://mail.google.com/mail/u/0/', current: true }] };
  const h = fixture({ observe: async ({ actions }) => actions.length === 0 ? gmail : ytFlow(actions.slice(1)) });
  const result = await runAssistant({ text: "Open YouTube and play MrBeast's latest video.", env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true, result.say);
  assert.equal(result.say, 'Playing MrBeast’s latest video, “Newest upload”.');
  assert.equal(h.modelCalls, 0);
  assert.deepEqual(h.actions[0], { action: 'browser', op: 'open', url: 'https://www.youtube.com/' });
  assert.deepEqual(h.actions.slice(1).map((action) => `${action.action}:${action.elementId || action.key || ''}`),
    ['type:search', 'press_key:search', 'click:avatar', 'click:tab-videos', 'click:newest']);
  assert.ok(logs.some(([label, value]) => label === '[jester] next stage' && value.kind === 'latest-video'));
});

test('a second stage with no local plan is the model’s, working toward the whole original goal', async () => {
  const blank = { ok: true, pageId: 'ntp', revision: 0, url: 'chrome://newtab/', title: 'New Tab', restricted: true, elements: [],
    text: 'Page: New Tab\nJester cannot read or control this page.' };
  const inbox = { ok: true, pageId: 'gmail', revision: 1, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', elements: [],
    text: '[m1] link "Lunch on Friday?"' };
  const h = fixture({ observe: async ({ actions }) => actions.length === 0 ? blank : inbox,
    execute: async (action) => ({ ok: true, detail: action.op === 'open' ? 'Opened mail.google.com.' : 'Opened the email.' }),
    replies: [{ action: { action: 'click', elementId: 'm1' } }, { action: { action: 'finish', say: 'Opened your latest email.', success: true } }] });
  const result = await runAssistant({ text: 'open Gmail and open my latest email', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  assert.deepEqual(h.actions[0], { action: 'browser', op: 'open', url: 'https://mail.google.com/' });
  assert.equal(h.prompts[0].originalGoal, 'open Gmail and open my latest email');
  assert.equal(h.prompts[0].page.url, inbox.url);
  assert.match(JSON.stringify(h.prompts[0].memory), /Opened mail\.google\.com/);
});

test('a tab list from the browser reaches the model whole, bounded, without page elements', async () => {
  const tabs = Array.from({ length: 45 }, (_, i) => ({ tabId: i + 1, title: `Recipe ${i}`, url: `https://food.example/${i}`, ...(i === 0 ? { current: true } : {}) }));
  const h = fixture({ execute: async (action) => action.op === 'tabs' ? { ok: true, detail: '45 open tabs.', tabs } : { ok: true, detail: 'Closed 3 tabs.' },
    replies: [{ action: { action: 'browser', op: 'tabs' } }, { action: { action: 'browser', op: 'close', tabIds: [2, 3, 4] } },
      { action: { action: 'finish', say: 'Closed the soup tabs.', success: true } }] });
  const result = await runAssistant({ text: 'close the tabs I opened for soup', env, host: h.host, modelClient: h.modelClient });
  assert.equal(result.ok, true);
  const listed = h.prompts[1].lastResult.tabs;
  assert.ok(listed.length >= 30 && listed.length <= 40, String(listed.length));
  assert.deepEqual(listed[0], { tabId: 1, title: 'Recipe 0', url: 'https://food.example/0', current: true });
  assert.ok(JSON.stringify(h.prompts[1].lastResult).length <= 4000);
});
