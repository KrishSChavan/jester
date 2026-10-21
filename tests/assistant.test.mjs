import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { runAssistant, validateTurn, compactObservation } from '../jester-extension/src/background/assistant.js';
import { validateAction } from '../jester-extension/src/common/agent-actions.js';
import { createMemory, updateMemory, recordResult } from '../jester-extension/src/common/task-memory.js';

const test = (name, fn) => nodeTest(name, async (t) => { t.mock.method(console, 'info', () => {}); await fn(t); });
const env = { provider: 'groq', model: 'my-model', key: 'user-key' };
const goal = 'Play season 3 episode 1 of Rick and Morty';
const page = (index = 0) => ({ ok: true, pageId: `document-${index}`, revision: index,
  url: 'https://netflix.com/browse', title: 'Netflix', text: `Current page ${index}: e${index} button` });

function harness(replies, extra = {}) {
  const actions = [];
  const checkpoints = [];
  const prompts = [];
  let index = 0;
  const host = { observe: async () => page(actions.length), execute: async (action) => {
    actions.push(action);
    return { ok: true, detail: `${action.action} worked` };
  }, checkpoint: async (value) => checkpoints.push(structuredClone(value)), thinking: async () => {}, ...extra };
  const modelClient = async (request) => {
    prompts.push(JSON.parse(request.prompt));
    const result = replies[index++];
    if (result instanceof Error) throw result;
    return { json: typeof result === 'function' ? result(request) : result };
  };
  return { actions, checkpoints, prompts, host, modelClient };
}

test('entertainment task executes one validated action then observes before the next task', async () => {
  const replies = [
    { action: { action: 'click', elementId: 'e0' }, memory: { subgoal: 'Choose season 3', facts: ['Requested title is visible'] } },
    { action: { action: 'click', elementId: 'e1' } },
    { action: { action: 'select', elementId: 'e2', value: 'Season 3' } },
    { action: { action: 'click', elementId: 'e3' } },
    { action: { action: 'command', actionId: 'PLAY' } },
    { action: { action: 'finish', say: 'Playing season 3, episode 1.', success: true } }
  ];
  const h = harness(replies);
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(result.ok, true);
  assert.equal(h.actions.length, 5);
  assert.equal(h.prompts.length, 6);
  assert.equal(h.actions[0].pageId, 'document-0');
  assert.equal(h.actions[2].revision, 2);
  assert.equal(h.prompts[3].page.text, page(3).text);
  assert.equal(h.prompts[3].originalGoal, goal);
  assert.equal(h.prompts[3].memory.goal, undefined);
  assert.deepEqual(h.prompts[3].memory.facts, ['Requested title is visible']);
  assert.equal(h.checkpoints.at(-1), null);
  assert.ok(h.checkpoints.some((value) => value?.pendingAction?.action === 'click'));
});

test('rejects arrays, unknown fields, selectors, scripts, and invalid action arguments', async () => {
  const invalid = [
    { actions: [] },
    { actions: Array.from({length:4},()=>({action:'click',elementId:'e0'})) },
    { action:{action:'click',elementId:'e0'},actions:[{action:'click',elementId:'e0'}] },
    { action: [{ action: 'click', elementId: 'e0' }] },
    { action: { action: 'click', selector: '#play' } },
    { action: { action: 'evaluate', script: 'document.body.click()' } },
    { action: { action: 'click', elementId: 'e0' }, memory: { goal: 'Different task' } },
    { action: { action: 'type', elementId: 'e0', text: 'x', submit: true } },
    { action: { action: 'wait', ms: 30001 } },
    { action: { action: 'press_key', key: 'Control+L' } }
  ];
  for (const value of invalid) {
    assert.throws(() => validateTurn(value));
    const h = harness([value, value]);
    const result = await runAssistant({ text: goal, env, ...h });
    assert.equal(result.ok, false);
    assert.equal(h.actions.length, 0);
  }
  assert.throws(() => validateAction({ action: 'navigate', url: 'javascript:alert(1)' }));
  assert.throws(() => validateAction({ action: 'command', actionId: 'SLEEP' }));
});

test('observations have a serialized 12,000-character limit and discard screenshots/HTML', () => {
  const observation = compactObservation({ ...page(), text: '\\"\n'.repeat(20000),
    screenshot: 'secret-image', html: '<html>raw content</html>' });
  assert.ok(JSON.stringify(observation).length <= 12000);
  assert.equal(observation.screenshot, undefined);
  assert.equal(observation.html, undefined);
  assert.ok(observation.text.length > 1000);
});

test('memory and history remain bounded across long runs and cannot replace the original goal', () => {
  const memory = createMemory(goal);
  for (let index = 0; index < 200; index += 1) {
    updateMemory(memory, { facts: [`fact ${index}`], constraints: [`constraint ${index}`], subgoal: `part ${index}` });
    recordResult(memory, { action: 'click', elementId: `e${index}` }, { ok: true, detail: 'x'.repeat(1000) });
  }
  assert.equal(memory.goal, goal);
  assert.equal(memory.facts.length, 10);
  assert.equal(memory.constraints.length, 8);
  assert.equal(memory.completed.length, 10);
  assert.equal(memory.recent.length, 5);
  assert.equal(memory.recent[0].action, 'click e195');
  assert.throws(() => updateMemory(memory, { goal: 'tampered' }));
  assert.ok(JSON.stringify(memory).length < 6000);
});

test('100 actions pause by default and a resume preserves goal and bounded memory', async () => {
  const h = harness(Array.from({ length: 100 }, (_, i) => ({ action: { action: 'click', elementId: `e${i}` } })));
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(result.ok, false);
  assert.equal(h.actions.length, 100);
  assert.equal(result.resume.steps, 100);
  assert.equal(result.resume.memory.recent.length, 5);
  assert.match(result.say, /keep going/);
  const next = harness([{ action: { action: 'finish', say: 'Playing the requested episode.', success: true } }]);
  const resumed = await runAssistant({ text: 'keep going', resume: result.resume, env, ...next });
  assert.equal(resumed.ok, true);
  assert.equal(next.prompts[0].originalGoal, goal);
  assert.equal(next.prompts[0].memory.goal, undefined);
  assert.equal(next.prompts[0].memory.recent.length, 5);
});

test('permission denial pauses immediately and never attempts the following action', async () => {
  let calls = 0;
  const h = harness([{ action: { action: 'click', elementId: 'e0' } },
    { action: { action: 'click', elementId: 'e1' } }], {
    execute: async () => { calls += 1; return { ok: false, denied: true, detail: 'Purchase needs approval.' }; }
  });
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(calls, 1);
  assert.equal(h.prompts.length, 1);
  assert.match(result.say, /approval/);
  assert.ok(result.resume);
});

test('an interrupted action is uncertain on resume and requires current-page verification', async () => {
  const h = harness([{ action: { action: 'finish', say: 'The episode is already playing.', success: true } }]);
  const resume = { goal, steps: 4, memory: createMemory(goal), pendingAction: { action: 'click', elementId: 'old-button' } };
  await runAssistant({ text: 'keep going', resume, env, ...h });
  assert.match(h.prompts[0].memory.recent.at(-1).detail, /outcome is unknown/);
  assert.equal(h.prompts[0].page.pageId, 'document-0');
  assert.equal(h.actions.length, 0);
});

test('repeated no-op actions stop before the third identical attempt', async () => {
  let actions = 0;
  const h = harness(Array.from({ length: 5 }, () => ({ action: { action: 'click', elementId: 'e0' } })), {
    observe: async () => page(0), execute: async () => { actions += 1; return { ok: true, detail: 'Dispatched.' }; }
  });
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(actions, 2);
  assert.match(result.say, /not responding/);
});

test('cancellation after planning or before execution prevents mutation', async () => {
  const controller = new AbortController();
  const h = harness([() => { controller.abort(); return { action: { action: 'click', elementId: 'e0' } }; }]);
  const result = await runAssistant({ text: goal, env, signal: controller.signal, ...h });
  assert.equal(h.actions.length, 0);
  assert.equal(result.say, '');
});

test('failed checkpoint stops execution before a mutating action', async () => {
  const h = harness([{ action: { action: 'click', elementId: 'e0' } }], {
    checkpoint: async (snapshot) => { if (snapshot?.pendingAction) throw new Error('Storage unavailable'); }
  });
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(h.actions.length, 0);
  assert.match(result.say, /Storage unavailable/);
  assert.equal(result.resume.pendingAction.action, 'click');
});

test('an unavailable model returns a resumable error using the exact configured model', async () => {
  const h = harness([new Error('The provider could not find model "my-model". Check Settings.')]);
  const result = await runAssistant({ text: goal, env, ...h });
  assert.equal(h.prompts.length, 1);
  assert.equal(h.actions.length, 0);
  assert.equal(result.resume.goal, goal);
  assert.match(result.say, /my-model/);
});
