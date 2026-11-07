import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearned, gist, LEARNED_KEY, LEARNED_LIMITS, learnable, phraseKey } from '../desktop/src/main/learned.js';

/** chrome.storage's shape, in memory. */
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: async (key) => (Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => Object.assign(data, structuredClone(items))
  };
}

const NEW_NOTE = [
  { action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' },
  { action: { action: 'type', text: 'hello world' }, app: 'Notes' }
];

test('the words that matter, in order: filler and politeness don\'t, prepositions do', () => {
  assert.equal(gist('Um, can you make a new Zoom meeting?'), 'make new zoom meeting');
  assert.equal(gist('Please create a new Zoom meeting'), 'make new zoom meeting');
  assert.equal(gist('start a new zoom meeting'), 'make new zoom meeting');
  assert.notEqual(gist('move the file from Desktop to Documents'), gist('move the file from Documents to Desktop'));
  assert.equal(phraseKey('Focus mode!'), 'focus mode');
});

test('only what can be found again, and was the user\'s to ask for, is learned', () => {
  assert.deepEqual(learnable('open a new note and write hello world', NEW_NOTE), { ok: true, steps: NEW_NOTE });
  assert.equal(learnable('play this', NEW_NOTE).ok, false, 'about what was on screen then');
  assert.equal(learnable('write a poem in a new note', [{ action: { action: 'type', text: 'Roses are red' }, app: 'Notes' }]).why, 'it typed words you didn’t say');
  assert.equal(learnable('text Sam hello', [{ action: { action: 'click' }, app: 'Messages', target: { role: 'button', label: 'Send' }, sensitive: true }]).why, 'a step needed your OK');
  assert.equal(learnable('press the icon', [{ action: { action: 'click' }, app: 'X', target: { role: 'button', label: '' } }]).why, 'a control it used has no name');
  assert.equal(learnable('a task', []).ok, false);
  assert.equal(learnable('a long task', Array.from({ length: LEARNED_LIMITS.steps + 1 }, () => NEW_NOTE[0])).ok, false);
  // Kept steps carry no flags.
  const kept = learnable('open spotify and play gunna', [{ action: { action: 'click' }, app: 'Spotify', target: { role: 'button', label: 'Play Gunna' }, sensitive: false }]);
  assert.deepEqual(kept.steps, [{ action: { action: 'click' }, app: 'Spotify', target: { role: 'button', label: 'Play Gunna' } }]);
});

test('a learned task is found by its words, any politeness, and forgotten after 30 days unused', async () => {
  let now = 1_000_000;
  const storage = memoryStorage();
  const learned = createLearned({ storage, now: () => now });
  assert.deepEqual(await learned.remember('Open a new note and write hello world', NEW_NOTE, 'Wrote “hello world” in a new note. It’s there now.'), { saved: true, known: false });
  assert.deepEqual(await learned.remember('open a new note and write hello world', NEW_NOTE, 'Done.'), { saved: true, known: true });
  assert.deepEqual(await learned.remember('write a poem', [{ action: { action: 'type', text: 'Roses' }, app: 'Notes' }]), { saved: false, why: 'it typed words you didn’t say' });

  const found = await learned.find('Please open a new note and write hello world.');
  assert.equal(found.key, 'open new note and write hello world');
  assert.deepEqual(found.steps, NEW_NOTE);
  assert.equal(await learned.find('open a new note and write goodbye'), null);

  now += 29 * 86400000;
  await learned.used(found.key);
  now += 29 * 86400000;
  assert.ok(await learned.find('open a new note and write hello world'), 'used: its 30 days began again');
  now += 31 * 86400000;
  assert.equal(await learned.find('open a new note and write hello world'), null);
  assert.ok(storage.data[LEARNED_KEY], 'kept in the app\'s storage');
});

test('a taught phrase is the user\'s own command until it\'s forgotten', async () => {
  const learned = createLearned({ storage: memoryStorage() });
  await learned.teach('Focus mode', 'open Notes and put it on the left');
  assert.deepEqual(await learned.phrase('focus mode.'), { phrase: 'Focus mode', say: 'open Notes and put it on the left', at: (await learned.phrase('focus mode')).at });
  assert.equal(await learned.phrase('focus'), null, 'the whole phrase, nothing less');
  assert.equal(await learned.forget('focus mode'), 'phrase');
  assert.equal(await learned.phrase('focus mode'), null);
  assert.equal(await learned.forget('focus mode'), null);

  await learned.remember('open a new note and write hello world', NEW_NOTE);
  assert.equal(await learned.forget('open a new note and write hello world'), 'task');
  assert.equal(await learned.find('open a new note and write hello world'), null);
});

test('a question is never learned: its answer was that day\'s screen', () => {
  const steps = [{ action: { action: 'open_app', name: 'Calendar' }, app: '' }];
  assert.equal(learnable('what is on my calendar today', steps).ok, false);
  assert.equal(learnable('Is my build passing?', steps).ok, false);
  assert.equal(learnable('open my calendar', steps).ok, true);
  // Asking to be told something part way through is a question too: a replay would open it and say nothing.
  const click = [{ action: { action: 'click' }, app: 'Google Chrome', target: { role: 'button', label: 'Canvas' } }];
  assert.equal(learnable('Can you open up my canvas and tell me what assignments I have due by tomorrow night', click).why, 'it asked something, and the answer changes');
  assert.equal(learnable('open Mail and check if Sarah replied', click).ok, false);
  assert.equal(learnable('open my Canvas bookmark, then which classes have homework', click).ok, false);
  assert.equal(learnable('open my Canvas bookmark', click).ok, true);
});

test('a polite request is learned though speech wrote it as a question; a real question isn\'t', () => {
  const steps = [{ action: { action: 'open_app', name: 'Zoom' }, app: '' }];
  assert.equal(learnable('Can you make a new Zoom meeting?', steps).ok, true);
  assert.equal(learnable('Could you open my notes?', steps).ok, true);
  assert.equal(learnable('Is my build passing?', steps).ok, false);
  assert.equal(learnable('Can you tell me what’s on my calendar?', steps).ok, false);
});
