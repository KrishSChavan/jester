import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasable, createLearned, gist, LEARNED_KEY, LEARNED_LIMITS, learnable, phraseKey } from '../desktop/src/main/learned.js';

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

test('a question in the user’s own words is never learned, though the command it came as asks nothing', () => {
  const steps = [
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'link', label: 'PSU Canvas' } },
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'link', label: 'Assignments' } }
  ];
  const command = 'open Canvas and check my assignments';
  assert.equal(learnable(command, steps).ok, true);
  assert.equal(learnable(command, steps, { said: 'pull up my canvas assignments' }).ok, true);
  assert.equal(learnable(command, steps, { said: 'what’s due on Canvas this week?' }).why, 'it asked something, and the answer changes');
  assert.equal(learnable(command, steps, { said: 'do I have anything due tomorrow on Canvas?' }).ok, false);
  assert.equal(learnable(command, steps, { said: 'open Canvas and tell me what’s due' }).ok, false);
  assert.equal(learnable(command, steps, { said: 'Can you open my Canvas assignments?' }).ok, true, 'a polite request, not a question');
  // "It" was the conversation's to work out, and the command says what: only asking counts against the user's words.
  assert.equal(learnable('open the PSU Canvas bookmark', steps, { said: 'open it' }).ok, true);
});

const DAY = 86400000;
const CANVAS = 'open the PSU Canvas bookmark';

test('words stand for the conversation’s command only when they name what it did and lean on nothing said before', () => {
  assert.equal(aliasable('open canvas', CANVAS), true);
  assert.equal(aliasable('Can you open Canvas?', CANVAS), true, 'a polite request, not a question');
  assert.equal(aliasable('make a zoom meeting', 'open Zoom and start a new meeting'), true);
  assert.equal(aliasable('crank the volume', 'volume up'), true);
  // Carrying on, answering, or leaning on what came before.
  const leaning = ['Try now', 'keep going', 'do it again', 'open it', 'Sure, go ahead', 'yes please', 'no, the canvas one', 'open canvas again', 'open the other canvas tab', 'try canvas'];
  for (const said of leaning) {
    assert.equal(aliasable(said, CANVAS), false, said);
  }
  // Which of a list just shown, or the newest of something: the command repeats the word, but what it picks changes.
  const picked = [
    ['the first result', 'click the first result on the YouTube page'],
    ['the second video', 'play the second video in the YouTube results'],
    ['the 2nd video', 'play the 2nd video in the YouTube results'],
    ['the top link', 'click the top link in the Google results'],
    ['the newest email', 'open the newest email in Mail'],
    ['the latest episode', 'play the latest episode of Serial on Spotify'],
    ['the third song', 'play the third song in the Spotify results']
  ];
  for (const [said, command] of picked) {
    assert.equal(aliasable(said, command), false, said);
  }
  // The command filled in what wasn't said.
  assert.equal(aliasable('play something', 'play Gunna on Spotify'), false);
  assert.equal(aliasable('play a song', 'play a Gunna song on Spotify'), false, 'a kind of thing names nothing');
  assert.equal(aliasable('play music on Spotify', 'play Gunna on Spotify'), false, 'nor does where it’s done');
  assert.equal(aliasable('remind me tomorrow to call mom', 'create a reminder for November 11 to call Mom'), false, 'a date the user didn’t say');
  assert.equal(aliasable('remind me tomorrow to call mom', 'create a reminder for Wednesday to call Mom'), false);
  assert.equal(aliasable('remind me tomorrow to call mom', 'add a reminder tomorrow to call Mom'), true, 'the user’s own day, kept as said');
  // A question is the conversation's to answer; the command's own words need no alias.
  assert.equal(aliasable('what’s due on canvas', 'open Canvas and tell me what’s due'), false);
  assert.equal(aliasable('canvas homework', 'open Canvas and tell me what’s due'), false);
  assert.equal(aliasable('Open my Canvas bookmark.', 'open my Canvas bookmark'), false);
  assert.equal(aliasable('', CANVAS), false);
});

test('a web address the user didn’t say never becomes a shortcut: the model’s guess at a site would be opened every time', async () => {
  assert.equal(aliasable('can you open canvas for me', 'open https://canvas.instructure.com/'), false);
  assert.equal(aliasable('pull up my canvas', 'open canvas.instructure.com'), false);
  assert.equal(aliasable('open my grades', 'open https://canvas.psu.edu/grades'), false);
  assert.equal(aliasable('pull up canvas.psu.edu', 'open https://canvas.instructure.com/'), false, 'not the one they said');
  // One they said, written out or spoken, is theirs.
  assert.equal(aliasable('open canvas.psu.edu', 'open canvas.psu.edu', { same: true }), true);
  assert.equal(aliasable('pull up canvas.psu.edu', 'open https://canvas.psu.edu/'), true);
  assert.equal(aliasable('pull up canvas dot psu dot edu', 'open canvas.psu.edu'), true);
  assert.equal(aliasable('take me to www.reddit.com', 'open reddit.com'), true);
  const learned = createLearned({ storage: memoryStorage() });
  assert.deepEqual(await learned.alias('can you open canvas for me', 'open https://canvas.instructure.com/'), { saved: false, why: 'the command had a web address you didn’t say' });
  assert.equal(await learned.aliasFor('can you open canvas for me'), null);
});

test('a command’s own words stand for it when asked to (`same`), held to everything else but naming what it did', async () => {
  assert.equal(aliasable('open canvas', 'open Canvas'), false, 'by default they need no alias');
  assert.equal(aliasable('Open Canvas.', 'open Canvas', { same: true }), true);
  assert.equal(aliasable('can you open canvas', 'open Canvas', { same: true }), true);
  // Words naming only the kind of thing done name it all the same, when they're the command's own.
  assert.equal(aliasable('Open my email.', 'open my email', { same: true }), true);
  assert.equal(aliasable('pull up my canvas', 'open Canvas', { same: true }), false, 'not the command’s own words');
  for (const words of ['try canvas again', 'open it', 'what’s due on canvas', 'open the first result', 'log into canvas, my password is Tiger2026']) {
    assert.equal(aliasable(words, words, { same: true }), false, words);
  }
  const learned = createLearned({ storage: memoryStorage() });
  assert.deepEqual(await learned.alias('open canvas', 'open Canvas'), { saved: false, why: 'they’re the command’s own words' });
  assert.deepEqual(await learned.alias('open canvas', 'open Canvas', { same: true }), { saved: true, known: false });
  assert.equal((await learned.aliasFor('Open Canvas, please.')).does, 'open Canvas');
  assert.deepEqual(await learned.alias('pull up my canvas', 'open Canvas', { same: true }), { saved: false, why: 'they aren’t the command’s own words' });
  assert.deepEqual(await learned.alias('type my password is hunter2', 'type my password is hunter2', { same: true }), { saved: false, why: 'it holds a password' });
  assert.deepEqual((await learned.list()).map(({ kind, said, does }) => [kind, said, does]), [['alias', 'open canvas', 'open Canvas']]);
});

test('an alias is found by its words, kept 30 days from its last use, and forgotten by its words', async () => {
  let now = 1_000_000;
  const learned = createLearned({ storage: memoryStorage(), now: () => now });
  assert.deepEqual(await learned.alias('Open canvas.', CANVAS), { saved: true, known: false });
  assert.deepEqual(await learned.alias('Try now', CANVAS), { saved: false, why: 'it leaned on what was said before' });
  assert.deepEqual(await learned.aliasFor('please open Canvas'), { key: 'open canvas', said: 'Open canvas.', does: CANVAS, at: 1_000_000, used: 1_000_000 });
  assert.equal(await learned.aliasFor(CANVAS), null, 'the command stands for nothing');
  assert.equal(await learned.find('open canvas'), null, 'an alias is no learned task');
  assert.deepEqual(await learned.alias('open canvas', CANVAS), { saved: true, known: true });

  now += 29 * DAY;
  await learned.used('open canvas', 'alias');
  now += 29 * DAY;
  assert.ok(await learned.aliasFor('open canvas'), 'used: its 30 days began again');
  now += 31 * DAY;
  assert.equal(await learned.aliasFor('open canvas'), null);

  await learned.alias('open canvas', CANVAS);
  assert.equal(await learned.forget('Open Canvas'), 'alias');
  assert.equal(await learned.aliasFor('open canvas'), null);
  assert.equal(await learned.forget('open canvas'), null);
  // Words whose command didn't work stand for nothing.
  await learned.alias('open canvas', CANVAS);
  assert.equal(await learned.unalias('open canvas'), true);
  assert.equal(await learned.unalias('open canvas'), false);
  // A phrase the user taught is only ever their own words.
  await learned.teach('study time', CANVAS);
  assert.deepEqual(await learned.alias('time to study', 'study time'), { saved: false, why: 'the command is a phrase you taught' });
});

test('forget takes everything learned by those words, and says the most deliberate', async () => {
  const learned = createLearned({ storage: memoryStorage() });
  await learned.teach('open canvas', CANVAS);
  await learned.alias('open canvas', 'open my PSU Canvas bookmark');
  await learned.remember('open canvas', [{ action: { action: 'click' }, app: 'Google Chrome', target: { role: 'button', label: 'Canvas' } }]);
  assert.equal(await learned.forget('open canvas'), 'phrase');
  assert.deepEqual([await learned.phrase('open canvas'), await learned.aliasFor('open canvas'), await learned.find('open canvas')], [null, null, null]);
});

test('no more than 50 aliases are kept: the least lately used go', async () => {
  let now = 1_000_000;
  const learned = createLearned({ storage: memoryStorage(), now: () => now });
  for (let course = 0; course <= LEARNED_LIMITS.aliases; course++) {
    now += 1000;
    assert.equal((await learned.alias(`open canvas course ${course}`, `open the PSU Canvas bookmark for course ${course}`)).saved, true);
  }
  assert.equal(await learned.aliasFor('open canvas course 0'), null);
  assert.ok(await learned.aliasFor(`open canvas course ${LEARNED_LIMITS.aliases}`));
  assert.equal((await learned.list()).length, LEARNED_LIMITS.aliases);
});

test('list() is what Jester does with no model, for the Routines note: phrases, then aliases, then tasks, newest first', async () => {
  let now = 1_000_000;
  const learned = createLearned({ storage: memoryStorage(), now: () => now });
  assert.deepEqual(await learned.list(), []);
  await learned.teach('Focus mode', 'open Notes and put it on the left');
  now += 1000;
  await learned.remember('open a new note and write hello world', NEW_NOTE);
  now += 1000;
  await learned.alias('open canvas', CANVAS);
  now += 1000;
  await learned.remember('open my calendar', [{ action: { action: 'open_app', name: 'Calendar' }, app: '' }]);
  now += 1000;
  await learned.remember('copy the link into notes', [
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'button', label: 'Share' } },
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'button', label: 'Copy link' } },
    { action: { action: 'menu', path: 'Edit > Paste' }, app: 'Notes' }
  ]);
  assert.deepEqual(await learned.list(), [
    { kind: 'phrase', said: 'Focus mode', does: 'open Notes and put it on the left', used: 1_000_000 },
    { kind: 'alias', said: 'open canvas', does: CANVAS, used: 1_002_000 },
    { kind: 'task', said: 'copy the link into notes', does: '3 steps in Google Chrome and Notes', used: 1_004_000 },
    { kind: 'task', said: 'open my calendar', does: '1 step', used: 1_003_000 },
    { kind: 'task', said: 'open a new note and write hello world', does: '2 steps in Notes', used: 1_001_000 }
  ]);
  // What's no longer kept isn't listed; a taught phrase lasts until it's forgotten.
  now += 31 * DAY;
  assert.deepEqual((await learned.list()).map((item) => item.kind), ['phrase']);
});

test('onChange is told after each save, never when nothing changed, and its trouble is never the store’s', async () => {
  let changes = 0;
  const learned = createLearned({ storage: memoryStorage(), onChange: () => (changes += 1) });
  await learned.teach('Focus mode', 'open Notes and put it on the left');
  assert.equal(changes, 1);
  await learned.remember('open a new note and write hello world', NEW_NOTE);
  await learned.alias('open canvas', CANVAS);
  await learned.used('open canvas', 'alias');
  await learned.used(gist('open a new note and write hello world'));
  assert.equal(changes, 5);
  await learned.remember('write a poem', [{ action: { action: 'type', text: 'Roses' }, app: 'Notes' }]);
  await learned.alias('Try now', CANVAS);
  await learned.forget('nothing learned by these words');
  await learned.used('no such task');
  await learned.unalias('no such words');
  assert.equal(changes, 5, 'nothing saved, nothing to tell');
  await learned.forget('focus mode');
  await learned.unalias('open canvas');
  assert.equal(changes, 7);

  const rejecting = createLearned({ storage: memoryStorage(), onChange: async () => Promise.reject(new Error('vault gone')) });
  assert.deepEqual(await rejecting.alias('open canvas', CANVAS), { saved: true, known: false });
  const throwing = createLearned({
    storage: memoryStorage(),
    onChange: () => {
      throw new Error('vault gone');
    }
  });
  await throwing.teach('Focus mode', 'open Notes');
  assert.ok(await throwing.phrase('focus mode'));
});

test('in conversation a way is kept under the command, but what it typed must be the user’s own words, and the command’s', async () => {
  const command = 'open a new note and write hello world';
  assert.deepEqual(learnable(command, NEW_NOTE, { said: 'jot hello world down in a new note' }), { ok: true, steps: NEW_NOTE });
  assert.equal(learnable(command, NEW_NOTE, { said: 'yes please' }).why, 'it typed words you didn’t say', 'the model’s words, though its command has them');
  assert.equal(learnable(command, NEW_NOTE.slice(0, 1), { said: 'yes please' }).ok, true, 'nothing typed, nothing to check');
  const learned = createLearned({ storage: memoryStorage() });
  assert.deepEqual(await learned.remember(command, NEW_NOTE, { said: 'yes please' }), { saved: false, why: 'it typed words you didn’t say' });
  assert.deepEqual(await learned.remember(command, NEW_NOTE, { said: 'jot hello world down in a new note' }), { saved: true, known: false });
  assert.equal((await learned.find(command)).said, command, 'kept under the command, which is what comes again');
  // A command that dropped what was typed comes again for other words: a replay would type this time's.
  const journal = [
    { action: { action: 'open_app', name: 'Day One' }, app: '' },
    { action: { action: 'type', text: 'today was great' }, app: 'Day One' }
  ];
  const said = 'add to my journal: today was great';
  assert.equal(learnable('open my journal app and add an entry', journal, { said }).why, 'it typed words the command didn’t say');
  assert.deepEqual(await learned.remember('open my journal app and add an entry', journal, { said }), { saved: false, why: 'it typed words the command didn’t say' });
  assert.equal(learnable('open my journal app and add today was great', journal, { said }).ok, true, 'in both, it’s what the command will always type');
});

test('the Routines note is a plain-text file: nothing holding a password or card number is listed for it, and no words holding one stand for a command', async () => {
  const zoom = ['join zoom meeting 812 345 6789 passcode 4321', 'open Zoom and join meeting 812 345 6789 with passcode 4321'];
  assert.equal(aliasable(...zoom), false);
  assert.equal(aliasable('log into canvas, my password is Tiger2026', 'log in to Canvas with the password Tiger2026'), false);
  assert.equal(aliasable('use card 4111 1111 1111 1111', 'pay on Amazon with card 4111 1111 1111 1111'), false);
  const learned = createLearned({ storage: memoryStorage() });
  assert.deepEqual(await learned.alias(...zoom), { saved: false, why: 'it holds a password' });
  // A task or phrase holding one is still kept, sealed in the app's storage, and done: it's only never listed.
  await learned.remember(zoom[1], [{ action: { action: 'type', text: '4321' }, app: 'zoom.us' }], { said: zoom[0] });
  await learned.teach('zoom time', zoom[1]);
  await learned.alias('open canvas', CANVAS);
  assert.ok(await learned.find(zoom[1]));
  assert.ok(await learned.phrase('zoom time'));
  assert.deepEqual((await learned.list()).map(({ kind, said }) => [kind, said]), [['alias', 'open canvas']]);
  // Nor are words that stood for one before they no longer could.
  const before = { said: zoom[0], does: zoom[1], at: Date.now(), used: Date.now() };
  const older = createLearned({ storage: memoryStorage({ [LEARNED_KEY]: { aliases: { [gist(zoom[0])]: before } } }) });
  assert.ok(await older.aliasFor(zoom[0]));
  assert.deepEqual(await older.list(), []);
});

test('changes made at once are made in turn: none is saved over by another, and one that fails holds up none after it', async () => {
  let now = 1_000_000;
  const learned = createLearned({ storage: memoryStorage(), now: () => now });
  const task = 'open a new note and write hello world';
  await learned.remember(task, NEW_NOTE);
  now += DAY;
  // A replay's bookkeeping isn't waited for, and the words that stood for its command are kept just after.
  await Promise.all([
    learned.used(gist(task)),
    learned.alias('open canvas', CANVAS),
    learned.teach('Focus mode', 'open Notes and put it on the left'),
    learned.remember('open my calendar', [{ action: { action: 'open_app', name: 'Calendar' }, app: '' }])
  ]);
  assert.equal((await learned.find(task)).used, now);
  assert.ok(await learned.aliasFor('open canvas'));
  assert.ok(await learned.phrase('focus mode'));
  assert.ok(await learned.find('open my calendar'));

  const storage = memoryStorage();
  let full = true;
  const flaky = createLearned({
    storage: {
      get: storage.get,
      set: async (items) => {
        if (full) {
          full = false;
          throw new Error('disk full');
        }
        return storage.set(items);
      }
    }
  });
  const failed = flaky.teach('Focus mode', 'open Notes');
  const kept = flaky.alias('open canvas', CANVAS);
  await assert.rejects(failed, /disk full/);
  assert.deepEqual(await kept, { saved: true, known: false });
  assert.ok(await flaky.aliasFor('open canvas'));
});
