import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatArchive, CHATS_KEPT_MS } from '../desktop/src/main/chat-archive.js';
import { createChatKeeper } from '../desktop/src/main/chat-keeper.js';
import { createConversation, NEW_AFTER_MS } from '../desktop/src/main/conversation.js';
import { createConversationLog } from '../desktop/src/main/conversation-log.js';
import { createRecollections } from '../desktop/src/main/recollections.js';
import { createVaultMemory } from '../desktop/src/main/vault-memory.js';
import { backOf, direction, placeOf } from '../desktop/src/home/screens.js';
import { dayLabel } from '../desktop/src/home/chats.js';

// Days are local days ("Yesterday", a transcript's day markers): the same ones wherever the tests run.
process.env.TZ = 'America/New_York';

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-chats-'));
  dirs.push(dir);
  return dir;
}

const minutes = (count) => count * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
/** Ids in order, so a test can say which chat is which. */
function ids(prefix = 'chat') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// ——— The archive: every chat that's over, word for word, for a week ———

test('a chat that is over is kept word for word, newest first, titled by how it opened until it has its sentence', () => {
  const file = path.join(scratch(), 'chats.json');
  let time = Date.UTC(2026, 10, 12, 15);
  const archive = createChatArchive({ file, now: () => time });
  const first = archive.keep([
    { who: 'you', text: 'what is on today', at: iso(time - minutes(6)), chat: 'a' },
    { who: 'jester', text: 'A lab at 2.', at: iso(time - minutes(6)), chat: 'a' }
  ]);
  time += minutes(30);
  archive.keep([{ who: 'you', text: 'remind me at 9', at: iso(time - minutes(5)), chat: 'b' }]);
  assert.equal(first, 'a');
  const list = archive.list();
  assert.deepEqual(list.map((chat) => [chat.id, chat.title, chat.lines]), [['b', 'remind me at 9', 1], ['a', 'what is on today', 2]]);
  assert.equal(list[1].lastAt, time - minutes(30) - minutes(6));
  archive.titled('a', 'The user asked what was on today: a lab at 2.');
  assert.equal(archive.get('a').title, 'The user asked what was on today: a lab at 2.');
  assert.deepEqual(archive.get('a').lines.map((line) => [line.who, line.text]), [['you', 'what is on today'], ['jester', 'A lab at 2.']]);
  // On disk, for this user alone, and read back after a restart.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(createChatArchive({ file, now: () => time }).list().map((chat) => chat.id), ['b', 'a']);
});

test('a line holding a card number or a password is kept only as that it did', () => {
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json') });
  archive.keep([
    { who: 'you', text: 'my card is 4111 1111 1111 1111', at: iso(Date.now()), chat: 'c' },
    { who: 'jester', text: 'Got it.', at: iso(Date.now()), chat: 'c' }
  ]);
  const [line] = archive.get('c').lines;
  assert.equal(line.hidden, true);
  assert.doesNotMatch(line.text, /4111/);
  assert.match(line.text, /^Left out: this held a card number\.$/);
  // Its title doesn't hold it either: how a chat opened is the first line that isn't left out.
  assert.equal(archive.list()[0].title, 'Got it.');
});

test('nothing the user said, nothing kept; a week on, a chat is gone', () => {
  let time = Date.UTC(2026, 10, 1);
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json'), now: () => time });
  assert.equal(archive.keep([{ who: 'jester', text: 'Your timer is done.', at: iso(time), chat: 'x' }]), '');
  assert.equal(archive.keep([]), '');
  archive.keep([{ who: 'you', text: 'hello', at: iso(time), chat: 'y' }]);
  time += CHATS_KEPT_MS - 1;
  assert.equal(archive.list().length, 1);
  time += 2;
  assert.deepEqual(archive.list(), []);
  assert.equal(archive.get('y'), null);
});

test('a chat carried on and over again takes the place of what was kept of it, title and all until it is summed up again', () => {
  let time = Date.UTC(2026, 10, 12, 9);
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json'), now: () => time });
  archive.keep([{ who: 'you', text: 'plan my Boston trip', at: iso(time), chat: 'trip' }]);
  archive.titled('trip', 'Planning a trip to Boston.');
  time += minutes(60);
  archive.keep([{ who: 'you', text: 'something else', at: iso(time), chat: 'other' }]);
  time += minutes(60);
  archive.keep([
    { who: 'you', text: 'plan my Boston trip', at: iso(time - minutes(120)), chat: 'trip', earlier: true },
    { who: 'you', text: 'and book the bus', at: iso(time), chat: 'trip' }
  ]);
  assert.deepEqual(archive.list().map((chat) => [chat.id, chat.title, chat.lines]), [['trip', 'Planning a trip to Boston.', 2], ['other', 'something else', 1]]);
  // Kept, a chat's lines are just its lines: which came before it was picked up is the log's business.
  assert.equal('earlier' in archive.get('trip').lines[0], false);
});

test('a chat deleted is gone; Forget it all clears every one', () => {
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json') });
  for (const id of ['p', 'q']) archive.keep([{ who: 'you', text: id, at: iso(Date.now()), chat: id }]);
  assert.equal(archive.remove('p'), true);
  assert.equal(archive.remove('p'), false);
  assert.deepEqual(archive.list().map((chat) => chat.id), ['q']);
  archive.clear();
  assert.deepEqual(archive.list(), []);
});

test('lines from a log kept before chats had ids are still kept, under a new one', () => {
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json'), newId: () => 'fresh' });
  assert.equal(archive.keep([{ who: 'you', text: 'hi', at: 'not a date' }]), 'fresh');
  assert.ok(Number.isFinite(Date.parse(archive.get('fresh').lines[0].at)));
});

// ——— The log: each conversation a chat, and one over carried on ———

test('each conversation is a chat with its own id, and the line that opens the next goes with it', () => {
  let time = Date.UTC(2026, 10, 12, 10);
  const log = createConversationLog({ file: path.join(scratch(), 'log.json'), now: () => time, newId: ids() });
  log.add('you', 'hello');
  log.add('jester', 'Hi.');
  assert.deepEqual(log.entries().map((entry) => entry.chat), ['chat-1', 'chat-1']);
  log.add('you', 'unrelated: the weather?');
  const over = log.startNew(1);
  assert.deepEqual(over.map((entry) => [entry.text, entry.chat]), [['hello', 'chat-1'], ['Hi.', 'chat-1']]);
  assert.equal(log.chatId(), 'chat-2');
  assert.deepEqual(log.entries().map((entry) => [entry.text, entry.chat]), [['unrelated: the weather?', 'chat-2']]);
});

test('a chat carried on: what was going on is handed back, its lines come back as earlier, and its quiet counts from now', () => {
  let time = Date.UTC(2026, 10, 12, 10);
  const ended = [];
  const log = createConversationLog({ file: path.join(scratch(), 'log.json'), now: () => time, endAfterMs: NEW_AFTER_MS, newId: ids(), onEnded: (entries) => ended.push(entries) });
  log.add('you', 'what time is it');
  const old = [
    { who: 'you', text: 'plan my Boston trip', at: iso(time - minutes(600)) },
    { who: 'jester', text: 'Saturday works.', at: iso(time - minutes(599)) }
  ];
  const over = log.restore(old, 'trip');
  assert.deepEqual(over.map((entry) => entry.text), ['what time is it']);
  assert.equal(log.chatId(), 'trip');
  assert.deepEqual(log.entries().map((entry) => [entry.who, entry.text, entry.chat, entry.earlier]), [
    ['you', 'plan my Boston trip', 'trip', true],
    ['jester', 'Saturday works.', 'trip', true]
  ]);
  // Ten hours old, but just picked up: it isn't over, and what's said next carries it on.
  assert.ok(log.idleFor() < minutes(1));
  time += minutes(4);
  assert.equal(log.current(10).length, 2);
  assert.equal(log.justResumed(), true);
  log.add('you', 'and book the bus');
  assert.equal(log.justResumed(), true);
  log.add('jester', 'Booked.');
  log.add('you', 'thanks');
  assert.equal(log.justResumed(), false);
  // Over again, it's handed on whole, with its id, so it takes its own place among the chats.
  time += NEW_AFTER_MS;
  log.expire();
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0].map((entry) => [entry.text, !!entry.earlier, entry.chat]), [
    ['plan my Boston trip', true, 'trip'],
    ['Saturday works.', true, 'trip'],
    ['and book the bus', false, 'trip'],
    ['Booked.', false, 'trip'],
    ['thanks', false, 'trip']
  ]);
  assert.notEqual(log.chatId(), 'trip');
});

test('a chat picked up and left alone is over again after the quiet, from when it was picked up', () => {
  let time = Date.UTC(2026, 10, 12, 10);
  const ended = [];
  const log = createConversationLog({ file: path.join(scratch(), 'log.json'), now: () => time, endAfterMs: NEW_AFTER_MS, onEnded: (entries) => ended.push(entries) });
  log.restore([{ who: 'you', text: 'old', at: iso(time - minutes(500)) }], 'old-chat');
  time += NEW_AFTER_MS - 1;
  log.expire();
  assert.equal(ended.length, 0);
  time += 2;
  log.expire();
  assert.deepEqual(ended.map((entries) => entries.map((entry) => entry.text)), [['old']]);
});

test('the log says when the conversation going on changes, and reading it back changes nothing', () => {
  let time = Date.UTC(2026, 10, 12, 10);
  let changes = 0;
  const log = createConversationLog({ file: path.join(scratch(), 'log.json'), now: () => time, endAfterMs: NEW_AFTER_MS, onChange: () => (changes += 1) });
  log.add('you', 'hi');
  log.startNew();
  log.restore([{ who: 'you', text: 'x', at: iso(time) }], 'r');
  log.clear();
  assert.equal(changes, 4);
  log.add('you', 'later');
  time += NEW_AFTER_MS * 2;
  // entries() is what the window shows: it doesn't end a conversation by asking.
  assert.equal(log.entries().length, 1);
  assert.equal(changes, 5);
  log.current(10);
  assert.equal(changes, 6, 'current() ends what has gone quiet, and says so');
});

test('a log from before chats had ids: what is going on becomes a chat as it loads', () => {
  const file = path.join(scratch(), 'log.json');
  const time = Date.UTC(2026, 10, 12, 10);
  fs.writeFileSync(file, JSON.stringify({ emptiedAt: time, conversation: 3, entries: [{ at: iso(time), who: 'you', text: 'hi', conversation: 3 }] }));
  const log = createConversationLog({ file, now: () => time, newId: () => 'given' });
  assert.equal(log.chatId(), 'given');
  assert.deepEqual(log.entries().map((entry) => entry.chat), ['given']);
});

// ——— What he's told of them: a sentence each, by chat ———

test('a sentence is kept for each chat: one carried on is summed up again in its place, and one deleted is forgotten', async () => {
  const file = path.join(scratch(), 'kept.json');
  const recollections = createRecollections({ file, summarize: async (entries) => `About ${entries.map((entry) => entry.text).join(' and ')}` });
  assert.equal(await recollections.keep([{ who: 'you', text: 'Boston', chat: 'trip' }]), 'About Boston');
  await recollections.keep([{ who: 'you', text: 'lunch', chat: 'food' }]);
  assert.equal(await recollections.keep([{ who: 'you', text: 'Boston', chat: 'trip', earlier: true }, { who: 'you', text: 'the bus', chat: 'trip' }]), 'About Boston and the bus');
  assert.deepEqual(recollections.all().map((item) => item.summary), ['About Boston and the bus', 'About lunch']);
  recollections.remove('trip');
  assert.deepEqual(recollections.all().map((item) => item.summary), ['About lunch']);
  assert.equal(await recollections.keep([{ who: 'jester', text: 'Hello?' }]), '');
});

// ——— Typed to, he writes back ———

/** A deferred: a promise, and the hands to settle it from the test. */
function later() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function jester({ reply = { say: 'Hello there.', do: '' }, chat, run, knows = () => false, risky = () => false, assistant: given = {}, memory: givenMemory } = {}) {
  const entries = [];
  const said = [];
  const shown = [];
  const archived = [];
  const answers = [];
  const assistant = {
    asking: false,
    running: false,
    cancelled: 0,
    reasked: 0,
    answer(yes) { answers.push(yes); },
    reask() { this.reasked += 1; return true; },
    cancel() { this.cancelled += 1; },
    async confirm() { return true; },
    ...given
  };
  const conversation = createConversation({
    chat: chat || (async () => reply),
    speaker: { async say(text) { said.push(text); }, stop() {} },
    memory: givenMemory || {
      add: (who, text) => entries.push({ who, text }),
      current: () => entries.map((entry) => ({ ...entry, at: new Date().toISOString() })),
      idleFor: () => null,
      startNew: () => [],
      clear: () => entries.splice(0)
    },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    archive: (ended) => archived.push(ended.map((entry) => entry.text)),
    knowsYou: () => true,
    commands: { knows: async (text) => knows(text), risky: async (text) => risky(text), run: run || (async (text) => ({ outcome: { ok: true, text: `Did ${text}` } })) },
    assistant,
    show: (voice) => shown.push(voice)
  });
  return { conversation, entries, said, shown, assistant, archived, answers };
}

test('typed to, he answers in writing: nothing is spoken, the answer is shown, and the mic is not held open for more', async () => {
  const j = jester();
  await j.conversation.told('how are you?', { typed: true });
  assert.deepEqual(j.said, []);
  assert.deepEqual(j.entries, [{ who: 'you', text: 'how are you?' }, { who: 'jester', text: 'Hello there.' }]);
  assert.ok(j.shown.some((voice) => voice.phase === 'answer' && voice.text === 'Hello there.' && voice.ok === true));
  assert.equal(j.shown.some((voice) => voice.phase === 'speaking'), false);
  assert.equal(j.shown.some((voice) => voice.hold), false, 'no listening on for a follow-up');
  // Spoken on purpose (the shortcut), he still speaks, and listens on.
  const spoken = jester();
  await spoken.conversation.told('how are you?');
  assert.deepEqual(spoken.said, ['Hello there.']);
  assert.ok(spoken.shown.some((voice) => voice.hold));
});

test('written, a reply keeps every character the speech filter would take out, and isn’t cut short; the pill’s copy is', async () => {
  const long = `${'C# beats C for games: try my_notes.md, then 12*12. '.repeat(12)}Press Undo (⌘Z) to go back.`;
  const j = jester({ reply: { say: long, do: '' } });
  await j.conversation.told('C# or Python?', { typed: true });
  const kept = j.entries.at(-1).text;
  assert.match(kept, /C# beats C/);
  assert.match(kept, /my_notes\.md/);
  assert.match(kept, /12\*12/);
  assert.match(kept, /\(⌘Z\)/);
  assert.ok(kept.length > 400, `kept whole (${kept.length})`);
  const pill = j.shown.find((voice) => voice.phase === 'answer').text;
  assert.ok(pill.length <= 280 && pill.endsWith('…'), 'the pill has a short copy');
  // Spoken, the same reply is filtered and cut, as before.
  const spoken = jester({ reply: { say: long, do: '' } });
  await spoken.conversation.told('C# or Python?');
  assert.ok(spoken.said[0].length <= 400);
  assert.doesNotMatch(spoken.said[0], /[#*_]/);
});

test('typed, a command and what it did are written too, and what went wrong shows as such', async () => {
  const j = jester({ reply: { say: 'On it.', do: 'open Notes' } });
  await j.conversation.told('I want to take some notes', { typed: true });
  assert.deepEqual(j.said, []);
  assert.deepEqual(j.entries.map((entry) => entry.text), ['I want to take some notes', 'On it.', 'Did open Notes']);
  const known = jester({ knows: () => true });
  await known.conversation.told('volume 30', { typed: true });
  assert.deepEqual(known.said, []);
  assert.deepEqual(known.entries.map((entry) => entry.text), ['volume 30', 'Did volume 30']);
  const failed = jester({ knows: () => true, run: async () => ({ outcome: { ok: false, text: 'Spotify isn’t installed.' } }) });
  await failed.conversation.told('play jazz', { typed: true });
  assert.deepEqual(failed.shown.filter((voice) => voice.phase === 'answer').map((voice) => voice.ok), [false]);
  const broken = jester({ chat: async () => { throw new Error('Ollama isn’t running.'); } });
  await broken.conversation.told('hello', { typed: true });
  assert.deepEqual(broken.shown.filter((voice) => voice.phase === 'answer').map((voice) => [voice.text, voice.ok]), [['Ollama isn’t running.', false]]);
});

test('typed while the assistant asks, only a whole yes or no answers it: a question back is asked again, never taken as yes', async () => {
  const asking = () => jester({ assistant: { asking: true } });
  for (const [typed, answers, reasked] of [
    ['yes', [true], 0],
    ['Sure', [true], 0],
    ['no', [false], 0],
    ['stop', [false], 0],
    ['ok, what’s it sending?', [], 1],
    ['sure, which one?', [], 1],
    ['okay so what', [], 1],
    ['Yes, please.', [true], 0],
    ['No, thanks!', [false], 0],
    ['Don’t', [false], 0],
    ['That’s enough', [false], 0]
  ]) {
    const j = asking();
    await j.conversation.told(typed, { typed: true });
    assert.deepEqual(j.answers, answers, typed);
    assert.equal(j.assistant.reasked, reasked, typed);
    assert.deepEqual(j.entries, [{ who: 'you', text: typed }], `${typed}: in the chat, and no turn of its own`);
  }
});

test('typed while a task works, "stop" or "shut up" stops it; anything else is a turn of its own', async () => {
  for (const typed of ['stop', 'shut up', 'be quiet', 'never mind']) {
    const j = jester({ assistant: { running: true } });
    await j.conversation.told(typed, { typed: true });
    assert.equal(j.assistant.cancelled, 1, typed);
    assert.deepEqual(j.entries, [{ who: 'you', text: typed }]);
  }
  const busy = jester({ assistant: { running: true } });
  await busy.conversation.told('what time is it', { typed: true });
  assert.equal(busy.assistant.cancelled, 0);
  assert.deepEqual(busy.entries.map((entry) => entry.text), ['what time is it', 'Hello there.']);
});

test('the assistant’s question about a typed command is written; a command said aloud makes them spoken again', async () => {
  const j = jester();
  await j.conversation.told('email Bob', { typed: true });
  assert.equal(j.conversation.typing, true);
  await j.conversation.ask('Send the email');
  assert.deepEqual(j.said, []);
  assert.equal(j.entries.at(-1).text, 'Send the email?');
  j.conversation.spoke();
  assert.equal(j.conversation.typing, false);
  await j.conversation.ask('Send the email');
  assert.deepEqual(j.said, ['Send the email?'], 'just asked: its window and the pill say how it’s answered');
});

test('listening switched off doesn’t cut a typed turn short; it does a spoken one', async () => {
  const thinking = later();
  const j = jester({ chat: () => thinking.promise });
  const turn = j.conversation.told('what’s on today?', { typed: true });
  await new Promise((resolve) => setImmediate(resolve));
  j.conversation.reset();
  thinking.resolve({ say: 'A lab at 2.', do: '' });
  await turn;
  assert.deepEqual(j.entries.map((entry) => entry.text), ['what’s on today?', 'A lab at 2.']);
  const voiced = later();
  const v = jester({ chat: () => voiced.promise });
  const spoken = v.conversation.told('what’s on today?');
  await new Promise((resolve) => setImmediate(resolve));
  v.conversation.reset();
  voiced.resolve({ say: 'A lab at 2.', do: '' });
  await spoken;
  assert.deepEqual(v.entries.map((entry) => entry.text), ['what’s on today?']);
});

test('a typed task’s result is written even after something else was typed; after Forget it all or a chat picked up, nothing', async () => {
  for (const [after, expected] of [
    [(j) => j.conversation.told('thanks', { typed: true }), true],
    [(j) => j.conversation.forget(), false],
    [(j) => j.conversation.end(), false]
  ]) {
    const working = later();
    const j = jester({ knows: (text) => text.startsWith('open'), run: () => working.promise });
    const task = j.conversation.told('open Canvas and tell me what’s due', { typed: true });
    await new Promise((resolve) => setImmediate(resolve));
    await after(j);
    working.resolve({ outcome: { ok: true, text: 'Your lab report is due Friday.' } });
    await task;
    assert.equal(j.entries.some((entry) => entry.text === 'Your lab report is due Friday.'), expected, String(after));
  }
});

test('Forget it all drops what he was about to say', async () => {
  const thinking = later();
  const j = jester({ chat: () => thinking.promise });
  const turn = j.conversation.told('remind me about therapy', { typed: true });
  await new Promise((resolve) => setImmediate(resolve));
  j.conversation.forget();
  assert.ok(j.shown.some((voice) => voice.phase === 'speaking' && voice.done), 'the orb stops');
  assert.deepEqual(j.shown.at(-1), { active: false }, 'and so does the pill');
  thinking.resolve({ say: 'I’ll remind you.', do: '' });
  await turn;
  assert.deepEqual(j.entries, []);
});

test('refused by a typed no, a spoken command’s “Okay, I won’t” is written, not said', async () => {
  const deciding = later();
  let j;
  j = jester({
    reply: { say: 'Sure.', do: 'delete the old invoices' },
    risky: () => true,
    assistant: {
      confirm() {
        j.assistant.asking = true;
        return deciding.promise;
      },
      answer(yes) {
        j.assistant.asking = false;
        deciding.resolve(yes);
      }
    }
  });
  const turn = j.conversation.heard('Jester, clean up my downloads');
  while (!j.assistant.asking) await new Promise((resolve) => setImmediate(resolve));
  await j.conversation.told('no', { typed: true });
  await turn;
  assert.deepEqual(j.said, ['Sure.']);
  assert.equal(j.entries.at(-1).text, 'Okay, I won’t.');
});

test('a typed refusal is written; a yes or no said aloud makes his next question spoken', async () => {
  const j = jester({ assistant: { asking: true } });
  await j.conversation.told('email Bob', { typed: true }).catch(() => undefined);
  await j.conversation.told('no', { typed: true });
  assert.equal(j.conversation.typing, true);
  // Overheard, with his name: a spoken no.
  const spoken = jester({ assistant: { asking: true } });
  await spoken.conversation.told('email Bob', { typed: true });
  await spoken.conversation.heard('Jester, no');
  assert.equal(spoken.conversation.typing, false);
});

test('a conversation that ends as a turn begins is archived then and there, not once the turn is done', async () => {
  const thinking = later();
  let ends = [{ who: 'you', text: 'an hour ago', chat: 'old' }];
  const memoryEntries = [];
  const j = jester({
    chat: () => thinking.promise,
    memory: {
      add: (who, text) => memoryEntries.push({ who, text }),
      current: () => [],
      idleFor: () => 10 * 60 * 1000,
      startNew: () => ends.splice(0)
    }
  });
  const turn = j.conversation.told('hello again', { typed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(j.archived, [['an hour ago']], 'in Chats while he still thinks');
  thinking.resolve({ say: 'Hi.', do: '' });
  await turn;
  assert.deepEqual(j.archived, [['an hour ago']], 'and only once');
});

test('a chat just picked up is not split off as a new subject by the model', async () => {
  const entries = [{ who: 'you', text: 'plan my Boston trip', earlier: true }, { who: 'jester', text: 'Saturday works.', earlier: true }];
  let started = 0;
  const memory = (justResumed) => ({
    add: (who, text) => entries.push({ who, text }),
    current: () => entries.map((entry) => ({ ...entry, at: new Date().toISOString() })),
    idleFor: () => 0,
    startNew: () => (started += 1, []),
    justResumed: () => justResumed
  });
  await jester({ reply: { say: 'Sure.', do: '', new: true }, memory: memory(true) }).conversation.told('what about Chicago', { typed: true });
  assert.equal(started, 0);
  await jester({ reply: { say: 'Sure.', do: '', new: true }, memory: memory(false) }).conversation.told('what about Chicago', { typed: true });
  assert.equal(started, 1);
});

// ——— The vault: a chat carried on is what went on today ———

test('a chat carried on is kept in the vault as a section of its own, when it was picked up, marked continued', async () => {
  const sections = [];
  const vault = {
    root: '/nowhere',
    name: 'Vault',
    aboutMe: () => ({ facts: [], text: '' }),
    addConversation: (entry) => (sections.push(entry), 'Jester/Conversations/2026/2026-11-12.md'),
    updateAboutMe: () => ({ added: 0, removed: 0 })
  };
  const memory = createVaultMemory({
    vault: () => vault,
    index: { search: async () => [], refresh: async () => undefined },
    request: async () => ({ json: { title: 'Boston trip', summary: 'The user planned a Boston trip and booked the bus.', topics: [], people: [], facts: { add: [], remove: [] } } }),
    now: () => Date.UTC(2026, 10, 12, 15),
    log: () => undefined
  });
  const picked = Date.UTC(2026, 10, 12, 14, 30);
  await memory.ended([
    { who: 'you', text: 'plan my Boston trip', at: iso(Date.UTC(2026, 10, 10, 9)), earlier: true },
    { who: 'jester', text: 'Saturday works.', at: iso(Date.UTC(2026, 10, 10, 9)), earlier: true },
    { who: 'you', text: 'book the bus', at: iso(picked) }
  ]);
  await memory.ended([{ who: 'you', text: 'plan my Boston trip', at: iso(Date.UTC(2026, 10, 10, 9)) }]);
  assert.deepEqual(sections.map((section) => [section.at, section.title]), [[picked, 'Boston trip (continued)'], [Date.UTC(2026, 10, 10, 9), 'Boston trip']]);
});

// ——— The window's screens ———

test('the screens are one strip: Chats to the left of the orb, Settings to the right, its pages further', () => {
  assert.deepEqual(['chat', 'chats', 'main', 'settings', 'settings/models'].map(placeOf), [-2, -1, 0, 1, 2]);
  assert.equal(direction('main', 'settings'), 1, 'Settings comes in from the right');
  assert.equal(direction('main', 'chats'), -1, 'Chats from the left');
  assert.equal(direction('settings/models', 'settings'), -1, 'back slides the other way');
  assert.equal(direction('chats', 'chat'), -1);
  assert.equal(direction('settings/models', 'settings/gestures'), 1);
  assert.equal(direction('main', 'settings/permissions'), 1);
  assert.deepEqual(['chat', 'chats', 'main', 'settings', 'settings/day'].map(backOf), ['chats', 'main', null, 'main', 'settings']);
});

test('Chats are grouped by day: today, yesterday, then the day itself', () => {
  const now = new Date(2026, 10, 12, 9, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 10, 12, 0, 5).getTime(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 10, 11, 23, 55).getTime(), now), 'Yesterday');
  assert.match(dayLabel(new Date(2026, 10, 9, 12).getTime(), now), /Monday/);
});

// ——— The keeper: what's kept, and when ———

function keeperWith({ summarize } = {}) {
  let time = Date.UTC(2026, 10, 12, 15);
  const dir = scratch();
  const file = path.join(dir, 'chats.json');
  const chats = createChatArchive({ file, now: () => time });
  const recollections = createRecollections({ file: path.join(dir, 'kept.json'), now: () => time, summarize: summarize || (async (entries) => `About ${entries[0].text}`) });
  let live = '';
  let told = 0;
  const keeper = createChatKeeper({ chats, recollections, live: () => live, onChats: () => (told += 1) });
  return { keeper, chats, recollections, file, setLive: (id) => (live = id), told: () => told, pass: (ms) => (time += ms), now: () => time };
}

test('the keeper: a chat is in Chats at once, and titled by its sentence once that is written', async () => {
  const k = keeperWith();
  const entries = [{ who: 'you', text: 'plan the Boston trip', at: iso(k.now()), chat: 'trip' }];
  assert.equal(k.keeper.keep(entries), 'trip');
  assert.deepEqual(k.keeper.list().map((chat) => chat.title), ['plan the Boston trip']);
  assert.equal(await k.keeper.sumUp(entries), 'About plan the Boston trip');
  assert.deepEqual(k.keeper.list().map((chat) => chat.title), ['About plan the Boston trip']);
  assert.deepEqual(k.recollections.all().map((item) => item.chat), ['trip']);
  // The chat going on isn't listed.
  k.setLive('trip');
  assert.deepEqual(k.keeper.list(), []);
});

test('the keeper: deleted or forgotten while its sentence was being written, a chat is forgotten after all', async () => {
  for (const meanwhile of [(k) => k.keeper.remove('therapy'), (k) => k.keeper.forgetAll()]) {
    const writing = later();
    const k = keeperWith({ summarize: () => writing.promise });
    const entries = [{ who: 'you', text: 'my therapy is moved to Thursday', at: iso(k.now()), chat: 'therapy' }];
    k.keeper.keep(entries);
    const summing = k.keeper.sumUp(entries);
    await new Promise((resolve) => setImmediate(resolve));
    meanwhile(k);
    writing.resolve('The user’s therapy moved to Thursday.');
    assert.equal(await summing, '');
    assert.deepEqual(k.recollections.all(), [], String(meanwhile));
    assert.deepEqual(k.keeper.list(), []);
    assert.equal(k.keeper.wanted(entries), false);
  }
});

test('the keeper: a chat deleted after its sentence is written is forgotten by him too', async () => {
  const k = keeperWith();
  const entries = [{ who: 'you', text: 'my therapy is moved to Thursday', at: iso(k.now()), chat: 'therapy' }];
  assert.equal(await k.keeper.over(entries), 'About my therapy is moved to Thursday');
  assert.equal(k.keeper.remove('therapy'), true);
  assert.deepEqual(k.recollections.all(), []);
  assert.deepEqual(k.keeper.list(), []);
});

test('the keeper: a chat picked up and left alone keeps its place, its title and its week, and nothing is summed up', async () => {
  let asked = 0;
  const k = keeperWith({ summarize: async (entries) => (asked += 1, `About ${entries[0].text}`) });
  const monday = k.now() - 3 * 24 * 60 * 60 * 1000;
  const old = [{ who: 'you', text: 'Boston on Saturday', at: iso(monday), chat: 'trip' }];
  // Kept after today's chat, though its lines are Monday's: the list still goes by what was said last.
  k.keeper.keep([{ who: 'you', text: 'weather today', at: iso(k.now()), chat: 'today' }]);
  k.keeper.keep(old);
  await k.keeper.sumUp(old);
  assert.deepEqual(k.keeper.list().map((chat) => chat.id), ['today', 'trip'], 'newest first, by what was said last');
  const before = k.keeper.get('trip');
  // Picked up an hour later, nothing said, over again.
  k.pass(minutes(60));
  await k.keeper.over(old.map((entry) => ({ ...entry, earlier: true })));
  assert.equal(asked, 1);
  assert.deepEqual(k.keeper.get('trip'), before, 'same place, title and week');
  assert.deepEqual(k.keeper.list().map((chat) => chat.id), ['today', 'trip']);
});

test('the keeper: what is a week old goes on the minute, not when next read', () => {
  const k = keeperWith();
  k.keeper.keep([{ who: 'you', text: 'hi', at: iso(k.now()), chat: 'a' }]);
  const before = k.told();
  k.pass(CHATS_KEPT_MS + 1);
  k.keeper.sweep();
  assert.equal(k.told(), before + 1, 'the Chats screen is told');
  assert.deepEqual(JSON.parse(fs.readFileSync(k.file, 'utf8')).chats, [], 'gone from chats.json, not just from view');
});

// ——— More of what's kept, and how ———

test('passwords, PINs, keys and card numbers are left out of what is kept on disk, said in one line or two', () => {
  const file = path.join(scratch(), 'chats.json');
  const at = iso(Date.UTC(2026, 10, 12, 15));
  const archive = createChatArchive({ file, now: () => Date.UTC(2026, 10, 12, 15) });
  archive.keep([
    { who: 'you', text: 'my card is 4111 1111 1111 1111', at, chat: 's' },
    { who: 'you', text: 'my Netflix password is tacos-alpaca-77', at, chat: 's' },
    { who: 'you', text: 'my PIN is', at, chat: 's' },
    { who: 'jester', text: 'Go on.', at, chat: 's' },
    { who: 'you', text: '8642', at, chat: 's' },
    { who: 'you', text: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', at, chat: 's' },
    { who: 'you', text: 'and what is the weather like on Saturday afternoon', at, chat: 's' }
  ]);
  const lines = archive.get('s').lines;
  assert.deepEqual(lines.map((line) => !!line.hidden), [true, true, false, false, true, true, false]);
  assert.match(lines[4].text, /^Left out: this held a PIN\.$/);
  const disk = fs.readFileSync(file, 'utf8');
  for (const secret of ['4111 1111', 'tacos-alpaca-77', '8642', 'sk-ant-api03']) assert.equal(disk.includes(secret), false, secret);
});

test('a question, or a secret named in passing, hides nothing after it; his asking for one does', () => {
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json') });
  const at = iso(Date.now());
  const kept = (id, lines) => {
    archive.keep(lines.map(([who, text]) => ({ who, text, at, chat: id })));
    return archive.get(id).lines.map((line) => (line.hidden ? '[left out]' : line.text));
  };
  assert.deepEqual(kept('a', [['you', 'how do I reset my Netflix password?'], ['jester', 'Open its settings.'], ['you', 'that worked, thanks']]).at(-1), 'that worked, thanks');
  assert.deepEqual(kept('b', [['you', 'where did I leave my car keys'], ['you', 'never mind']]).at(-1), 'never mind');
  assert.deepEqual(kept('c', [['you', 'what is a good promo code'], ['you', 'ok thanks']]).at(-1), 'ok thanks');
  assert.deepEqual(kept('d', [['you', 'do you know what my PIN is'], ['you', 'no idea']]).at(-1), 'no idea');
  assert.deepEqual(kept('e', [['jester', 'What is the wifi password?'], ['you', 'sunflower77']]).at(-1), '[left out]');
  assert.deepEqual(kept('f', [['you', 'wifi password:'], ['you', 'sunflower77']]).at(-1), '[left out]');
  assert.deepEqual(kept('g', [['you', 'the gate code is'], ['jester', 'Go on.'], ['you', '4471']]).at(-1), '[left out]');
});

test('a line left out stays left out when its chat is picked up and kept again', () => {
  const dir = scratch();
  const time = Date.UTC(2026, 10, 12, 10);
  const archive = createChatArchive({ file: path.join(dir, 'chats.json'), now: () => time });
  archive.keep([
    { who: 'you', text: 'my card is 4111 1111 1111 1111', at: iso(time), chat: 'c' },
    { who: 'jester', text: 'I won’t keep that.', at: iso(time), chat: 'c' },
    { who: 'you', text: 'my Netflix password is tacos-77', at: iso(time), chat: 'c' },
    { who: 'you', text: 'ok cool', at: iso(time), chat: 'c' }
  ]);
  const log = createConversationLog({ file: path.join(dir, 'log.json'), now: () => time });
  log.restore(archive.get('c').lines, 'c');
  assert.deepEqual(log.entries().map((entry) => [entry.text.slice(0, 9), !!entry.hidden]), [['Left out:', true], ['I won’t k', false], ['Left out:', true], ['ok cool', false]]);
  log.add('you', 'thanks');
  archive.keep(log.entries());
  // "Left out: this held a password." names one at its end: a placeholder doesn't hide the line after it.
  assert.deepEqual(archive.get('c').lines.map((line) => !!line.hidden), [true, false, true, false, false]);
});

test('his sentence for the chat going on, picked up again, isn’t offered as a conversation that is over', async () => {
  const recollections = createRecollections({ file: path.join(scratch(), 'kept.json'), summarize: async (entries) => `About ${entries[0].text} trip` });
  await recollections.keep([{ who: 'you', text: 'Boston', chat: 'trip' }]);
  await recollections.keep([{ who: 'you', text: 'Chicago', chat: 'other' }]);
  assert.deepEqual(recollections.relevant('the trip').map((item) => item.chat), ['trip', 'other']);
  assert.deepEqual(recollections.relevant('the trip', { except: 'trip' }).map((item) => item.chat), ['other']);
});

test('a conversation deleted while it was summed up isn’t kept in the vault; a chat over two days names each day for the model', async () => {
  const sections = [];
  const asked = [];
  const vault = { root: '/nowhere', name: 'Vault', aboutMe: () => ({ facts: [], text: '' }), addConversation: (entry) => (sections.push(entry), 'x.md'), updateAboutMe: () => ({}) };
  const memory = createVaultMemory({
    vault: () => vault,
    index: { search: async () => [], refresh: async () => undefined },
    request: async (request) => (asked.push(request), { json: { title: 'Boston trip', summary: 'The user planned a trip.', topics: [], people: [], facts: { add: [], remove: [] } } }),
    now: () => Date.UTC(2026, 10, 12, 15),
    log: () => undefined
  });
  await memory.ended([{ who: 'you', text: 'plan the trip', at: iso(Date.UTC(2026, 10, 12, 14)) }], { wanted: () => false });
  assert.deepEqual(sections, []);
  await memory.ended([
    { who: 'you', text: 'Boston on Friday', at: iso(Date.UTC(2026, 10, 9, 15)), earlier: true },
    { who: 'you', text: 'book the bus for Friday', at: iso(Date.UTC(2026, 10, 12, 15)) }
  ]);
  const [, continued] = asked;
  assert.match(continued.prompt, /^\[[^\]]*November 9, 2026\]\nUser: Boston on Friday\n\[[^\]]*November 12, 2026\]\nUser: book the bus for Friday$/);
  assert.match(continued.system, /It began on [^.]*November 9, 2026[^.]*\. It was picked up again on [^:]*November 12, 2026/);
  assert.equal(sections.length, 1);
});

test('a new subject with a task at work is archived at once, before the task is done', async () => {
  const entries = [{ who: 'you', text: 'my therapy moved to Thursday', at: iso(Date.now()), chat: 'old' }, { who: 'jester', text: 'Noted.', at: iso(Date.now()), chat: 'old' }];
  const working = later();
  const j = jester({
    reply: { say: 'On it.', do: 'check what is due on Canvas', new: true },
    run: () => working.promise,
    memory: {
      add: (who, text) => entries.push({ who, text, at: iso(Date.now()) }),
      current: (count = 99) => entries.slice(-count),
      idleFor: () => 0,
      justResumed: () => false,
      startNew: (keep = 0) => entries.splice(0, entries.length - keep)
    }
  });
  const turn = j.conversation.told('check what is due on Canvas', { typed: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(j.archived, [['my therapy moved to Thursday', 'Noted.']], 'in Chats while the task works');
  working.resolve({ outcome: { ok: true, text: 'Your lab report is due Friday.' } });
  await turn;
  assert.deepEqual(j.archived.length, 1);
});

test('a typed task’s late result keeps the conversation whole: a new subject doesn’t split it then', async () => {
  for (const late of [true, false]) {
    const time = Date.UTC(2026, 10, 12, 15);
    const log = createConversationLog({ file: path.join(scratch(), 'log.json'), now: () => time, newId: ids() });
    const working = later();
    const thinking = later();
    const j = jester({ knows: (text) => text.startsWith('open'), run: () => working.promise, chat: () => thinking.promise, memory: log });
    const task = j.conversation.told('open Canvas and tell me what is due', { typed: true });
    await new Promise((resolve) => setImmediate(resolve));
    if (!late) {
      working.resolve({ outcome: { ok: true, text: 'Your lab report is due Friday.' } });
      await task;
    }
    const weather = j.conversation.told('what is the weather like tomorrow?', { typed: true });
    await new Promise((resolve) => setImmediate(resolve));
    if (late) {
      working.resolve({ outcome: { ok: true, text: 'Your lab report is due Friday.' } });
      await task;
    }
    thinking.resolve({ say: 'Sunny, 64 degrees.', do: '', new: true });
    await weather;
    const going = log.entries().map((entry) => entry.text);
    if (late) {
      // The result came after the question: one conversation, nothing split off with a stranger's line.
      assert.deepEqual(j.archived, []);
      assert.deepEqual(going, ['open Canvas and tell me what is due', 'what is the weather like tomorrow?', 'Your lab report is due Friday.', 'Sunny, 64 degrees.']);
    } else {
      assert.deepEqual(j.archived, [['open Canvas and tell me what is due', 'Your lab report is due Friday.']]);
      assert.deepEqual(going, ['what is the weather like tomorrow?', 'Sunny, 64 degrees.']);
    }
  }
});
