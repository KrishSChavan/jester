import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { runAssistant, validateTurn, compactObservation, localStages } from '../jester-extension/src/background/assistant.js';
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
  // Said as where it was stuck, in a person's words: it used to be "A control is not responding."
  assert.equal(result.say, 'I kept trying the same thing on Netflix and nothing changed, so have a look and say “keep going”.');
  // What was done comes with how it ended, for Jester Desktop's log: each step, the step that was one too many, and
  // why it stopped. Not among the result's own fields, which are what they were.
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'resume', 'say']);
  assert.equal(result.trace.length, 4);
  assert.match(result.trace[0], /^did: .*\(Dispatched\.\)$/);
  assert.match(result.trace[1], /^did: /);
  assert.match(result.trace[2], /^the same step a third time on a page that hadn’t changed: /);
  assert.match(result.trace[3], /^paused \(unresponsive-control\): I kept trying the same thing on Netflix/);
});

test('a tab list cut short says so; asked for again it isn’t read again, and a third asking ends as what it is', async () => {
  // 2026-11-15: 40 tabs open, some 20 of them shown to the model with "40 open tabs", asked for three times running
  // and ended as "A control is not responding".
  const tabs = Array.from({ length: 40 }, (_, i) => ({ tabId: 1000 + i, title: `A rather long title for tab number ${i}, as most pages have`, url: `https://www.example-site-${i}.com/some/path/that/goes/on/for/a/while` }));
  const read = { action: { action: 'browser', op: 'tabs' } };
  const fixed = { ok: true, pageId: 'document-0', revision: 0, url: 'https://example.com/', title: 'Example', text: 'A page that stays as it is.' };
  let reads = 0;
  const listing = { observe: async () => fixed, execute: async () => ((reads += 1), { ok: true, detail: '40 open tabs.', tabs }) };
  const h = harness([read, read, { action: { action: 'finish', say: 'You have 40 tabs open.', success: true } }], listing);
  const result = await runAssistant({ text: 'what tabs do I have open', env, ...h });
  assert.equal(result.ok, true);
  // Read once: the second asking was answered with what it already had.
  assert.equal(reads, 1);
  const shown = h.prompts[1].lastResult;
  assert.ok(shown.tabs.length < 40 && shown.tabs.length >= 20, `${shown.tabs.length} listed`);
  assert.match(shown.detail, new RegExp(`^40 open tabs\\. Only the first ${shown.tabs.length} are listed here, ${40 - shown.tabs.length} are not: asking again lists the same ones\\.`));
  assert.equal(h.prompts[2].lastResult.tabs.length, shown.tabs.length);
  assert.match(h.prompts[2].lastResult.note, /asking again gives the same/);
  assert.ok(result.trace.some((line) => /^asked again for what it had just read: /.test(line)));
  // A model that asks a third time all the same: over, and not as a control that failed.
  reads = 0;
  const stuck = harness([read, read, read, read], listing);
  const ended = await runAssistant({ text: 'what tabs do I have open', env, ...stuck });
  assert.equal(ended.ok, false);
  assert.equal(reads, 1);
  assert.match(ended.say, /^I kept reading the same thing/);
  assert.doesNotMatch(ended.say, /control/);
  assert.match(ended.trace.at(-1), /^paused \(repeated-read\)/);
  // A short list is shown whole, with nothing added.
  const few = harness([read, { action: { action: 'finish', say: 'Three.', success: true } }], { observe: async () => fixed, execute: async () => ({ ok: true, detail: '3 open tabs.', tabs: tabs.slice(0, 3) }) });
  await runAssistant({ text: 'what tabs do I have open', env, ...few });
  assert.equal(few.prompts[1].lastResult.detail, '3 open tabs.');
  assert.equal(few.prompts[1].lastResult.tabs.length, 3);
});

test('every step’s prompt carries the date and time, and the model is told a date gone by is over', async () => {
  // 2026-11-14: a dashboard's items of November 2 and 3 were read out as due "this week".
  const h = harness([{ action: { action: 'finish', say: 'Nothing is due.', success: true } }]);
  await runAssistant({ text: 'tell me what is due this week', env, ...h });
  assert.match(h.prompts[0].now, /^\w+day, \w+ \d{1,2}, \d{4} at \d{1,2}:\d\d.[AP]M$/);
  const { SYSTEM_PROMPT } = await import('../jester-extension/src/background/assistant.js');
  assert.match(SYSTEM_PROMPT, /now is today's date and the time\. A date on the page before it has passed: never call it due, upcoming or "this week"/);
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

test('“open <name>” goes to the bookmark of that name; words with no local plan take what a conversation took them to mean', async () => {
  const bookmarks = { 'PSU Canvas bookmark': 'https://psu.instructure.com/', 'PSU Canvas': 'https://psu.instructure.com/' };
  const bookmark = async (name) => bookmarks[name] || null;
  assert.equal((await localStages('open my PSU Canvas bookmark', '', bookmark))[0].url, 'https://psu.instructure.com/');
  // A name nothing has: the planner's, with the open tabs.
  assert.equal((await localStages('open my lasagna recipe', '', bookmark))[0].url, undefined);
  assert.equal((await localStages('Try now', 'open Chrome and open PSU Canvas bookmark', bookmark))[0].url, 'https://psu.instructure.com/');
  assert.equal((await localStages('open my google chrome extension PSU Canvas', 'open the PSU Canvas bookmark', bookmark))[0].url, 'https://psu.instructure.com/');
  // The words' own plan stands: the meaning only fills in what they leave out.
  assert.equal((await localStages('open YouTube', 'open the PSU Canvas bookmark', bookmark))[0].url, 'https://www.youtube.com/');
  assert.deepEqual(await localStages('Try now', 'tell me what’s due', bookmark), []);
});

test('the model is given the words, with what the conversation took them to mean', async () => {
  const h = harness([{ action: { action: 'finish', say: 'Nothing to try here.', success: false } }]);
  await runAssistant({ text: 'Try now', meant: 'tell me what’s due on Canvas', env, ...h });
  assert.equal(h.prompts[0].originalGoal, 'Try now (taken in conversation to mean: tell me what’s due on Canvas)');
  const plain = harness([{ action: { action: 'finish', say: 'Done.', success: true } }]);
  await runAssistant({ text: 'tell me what’s due on Canvas', env, ...plain });
  assert.equal(plain.prompts[0].originalGoal, 'tell me what’s due on Canvas');
});
