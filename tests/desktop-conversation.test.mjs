import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressed, wakesEarly } from '../desktop/src/main/wake.js';
import { asksFirst, parseCommand, parseSequence } from '../desktop/src/main/voice-commands.js';
import { createConversationLog, EMPTIED_EVERY_MS } from '../desktop/src/main/conversation-log.js';
import { askOllama, createConversation, LOCAL_KEEP_ALIVE, personaPrompt, pickModel, stamped, summarize, warmOllama } from '../desktop/src/main/conversation.js';
import { createRecollections, KEPT_MS } from '../desktop/src/main/recollections.js';
import { averageVoice, likeness, sounds, TEACHING_LINES } from '../desktop/src/main/voiceprint.js';
import { createSpeaker, spokenLine, SPOKEN_CHARS } from '../desktop/src/main/speaker.js';
import { PuterError, signInToPuter, synthesize } from '../desktop/src/main/puter.js';

test('his name, and what the recognizer really writes for it', () => {
  for (const [heard, rest] of [
    ['Jester, what time is it?', 'what time is it?'],
    ['Hey Jester, open Spotify.', 'open Spotify.'],
    ['Jester.', ''],
    ['J what time is it', 'what time is it'],
    ['Jay, how are you?', 'how are you?'],
    ['Hey J', ''],
    ['Jes stop', 'stop'],
    ['Jess, what do you think?', 'what do you think?'],
    // Non-American voices, as transcribed.
    ['Just a new tab.', 'new tab.'],
    ['Just to minimize this.', 'minimize this.'],
    ['Just tell me a joke.', 'tell me a joke.'],
    ['Just open notes.', 'open notes.'],
    ['Chester, what time is it?', 'what time is it?'],
    // Last, as you'd call someone.
    ['What time is it, Jester?', 'What time is it'],
    ['Open Spotify Jester.', 'Open Spotify']
  ]) {
    const result = addressed(heard);
    assert.equal(result.woken, true, heard);
    assert.equal(result.rest, rest, heard);
  }
});

test('ordinary speech is not for him', () => {
  for (const heard of ['Just kidding.', 'Just what I needed.', 'Yes please.', 'Yesterday was fun.', 'The rest of it is fine.', 'Gesture control is cool.', 'Jessica is here.', 'Chester is a town in England.', 'Jess is late.', 'Jess and I went out.', 'Jay walked home.', 'I told Jester.', 'Best of luck.', 'Guess what.', 'Test this.', '', '   ']) {
    assert.equal(addressed(heard).woken, false, heard);
  }
});

test('overheard, what could do harm asks first and what can only annoy does not', () => {
  const context = { apps: ['Safari', 'Spotify', 'Notes'], platform: 'darwin' };
  const asks = (line) => parseSequence(line, context).some((step) => asksFirst(step));
  for (const line of ['type hello', 'press enter', 'paste', 'quit Safari', 'close window', 'close tab', 'click', 'open Notes and paste']) assert.equal(asks(line), true, line);
  for (const line of ['volume 30', 'mute', 'next song', 'open Spotify', 'play gunna', 'new tab', 'take a screenshot', 'lock the screen']) assert.equal(asks(line), false, line);
  // Fail closed: a kind nobody has listed asks.
  assert.equal(asksFirst({ kind: 'something new' }), true);
});

test('in conversation, "write" and "say" are talk; "type" is still typing', () => {
  assert.equal(parseCommand('write me a poem', { talking: true }).kind, 'unknown');
  assert.equal(parseCommand('say something funny', { talking: true }).kind, 'unknown');
  assert.equal(parseCommand('type hello', { talking: true }).kind, 'type');
  assert.equal(parseCommand('write me a poem').kind, 'type');
});

test('searching the internet searches for what was asked, not for "the internet"', () => {
  assert.deepEqual(parseCommand('search the internet for pizza places.'), { kind: 'search', query: 'pizza places', site: 'web' });
  assert.deepEqual(parseCommand('search online for cats'), { kind: 'search', query: 'cats', site: 'web' });
});

test('the log keeps what was said, and is emptied every hour, even across a restart or a sleep', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-log-'));
  const file = path.join(dir, 'conversation.json');
  let time = 1_000_000;
  const log = createConversationLog({ file, now: () => time });
  log.add('you', 'hello');
  log.add('jester', 'hi');
  assert.deepEqual(log.current(1).map((entry) => entry.text), ['hi']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createConversationLog({ file, now: () => time });
  assert.equal(again.current(10).length, 2);
  time += EMPTIED_EVERY_MS;
  log.expire();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 0);
  log.add('you', 'still here');
  time += EMPTIED_EVERY_MS;
  // Started again long after: nothing older than the hour is read.
  assert.equal(createConversationLog({ file, now: () => time }).current(10).length, 0);
  fs.rmSync(dir, { recursive: true });
});

function jester({ knows = () => false, risky = () => false, reply = { say: 'Hello there.', do: '' }, allow = true, chat, knowsYou = false } = {}) {
  let time = 1000;
  const entries = [];
  const said = [];
  const ran = [];
  const runWith = [];
  const shown = [];
  const questions = [];
  const assistant = {
    asking: false,
    running: false,
    answers: [],
    cancelled: 0,
    answer(yes) { this.answers.push(yes); },
    cancel() { this.cancelled += 1; },
    async confirm(label) { questions.push(label); return allow; }
  };
  const speaker = { stops: 0, hold: null, async say(text) { said.push(text); if (this.hold) await this.hold; }, stop() { this.stops += 1; } };
  const conversation = createConversation({
    chat: chat || (async () => reply),
    speaker,
    memory: { add: (who, text) => entries.push({ who, text }), current: () => [...entries], idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    knowsYou: () => knowsYou,
    commands: { knows: async (text) => knows(text), risky: async (text) => risky(text), run: async (text, said) => (ran.push(text), runWith.push(said), { outcome: { ok: true, text: `Did ${text}` } }) },
    assistant,
    show: (voice) => shown.push(voice),
    now: () => time
  });
  return { conversation, entries, said, ran, runWith, shown, questions, assistant, speaker, pass: (ms) => (time += ms) };
}

test('what is not said to him is dropped, and not kept', async () => {
  const j = jester();
  await j.conversation.heard('I think we should get lunch.');
  assert.deepEqual(j.entries, []);
  assert.deepEqual(j.said, []);
});

test('said to him, Ollama answers aloud, the pill waves, and it is all logged', async () => {
  const j = jester();
  await j.conversation.heard('Jester, how are you?');
  assert.deepEqual(j.said, ['Hello there.']);
  assert.deepEqual(j.entries, [{ who: 'you', text: 'how are you?' }, { who: 'jester', text: 'Hello there.' }]);
  const faces = j.shown.map((voice) => voice.phase);
  assert.deepEqual(j.shown[0], { phase: 'heard', text: 'how are you?', matched: false });
  assert.ok(faces.indexOf('thinking') < faces.indexOf('speaking'));
  assert.ok(j.shown.some((voice) => voice.phase === 'speaking' && voice.done));
});

test('a command he knows needs no model, and its result is said', async () => {
  let asked = 0;
  const j = jester({ knows: () => true, chat: async () => (asked += 1, { say: 'x', do: '' }) });
  await j.conversation.heard('Jester, volume 30');
  assert.equal(asked, 0);
  assert.deepEqual(j.ran, ['volume 30']);
  assert.deepEqual(j.said, ['Did volume 30']);
});

test('the model can hand back a command: it goes through the same doors', async () => {
  const j = jester({ reply: { say: 'On it.', do: 'open Notes' } });
  await j.conversation.heard('Jester, I want to take some notes');
  assert.deepEqual(j.ran, ['open Notes']);
  assert.deepEqual(j.said, ['On it.', 'Did open Notes']);
});

test('a command the model hands back goes with what the user said, which it may have changed', async () => {
  // qwen3.5:9b, 2026-11-07: "open up my canvas and tell me what's due by tomorrow night" came back as "open Canvas".
  const j = jester({ reply: { say: 'On it.', do: 'open Canvas' } });
  await j.conversation.heard('Jester, open up my Canvas bookmark and tell me what is due by tomorrow night');
  assert.deepEqual(j.ran, ['open Canvas']);
  assert.deepEqual(j.runWith, ['open up my Canvas bookmark and tell me what is due by tomorrow night']);
  // A command the matcher knows was the user's words already.
  const known = jester({ knows: () => true });
  await known.conversation.heard('Jester, volume 30');
  assert.deepEqual(known.runWith, [undefined]);
});

test('a conversation that ended is summed up once he has answered, not while his answer waits on the model', async () => {
  const order = [];
  const conversation = createConversation({
    chat: async () => (order.push('chat'), { say: 'Hi.', do: '', new: false }),
    speaker: { say: async () => void order.push('said'), stop: () => undefined },
    memory: { add: () => undefined, current: () => [], idleFor: () => 10 * 60 * 1000, startNew: () => [{ who: 'you', text: 'an hour ago' }] },
    recollections: { keep: async (entries) => void order.push(`keep ${entries[0].text}`), relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: () => undefined
  });
  await conversation.heard('Jester, hello');
  assert.deepEqual(order, ['chat', 'said', 'keep an hour ago']);
});

test('when listening ends his pill goes, but a task at work keeps its own', () => {
  const j = jester();
  j.conversation.reset();
  assert.deepEqual(j.shown.at(-1), { active: false });
  const busy = jester();
  busy.assistant.running = true;
  busy.conversation.reset();
  assert.equal(busy.shown.some((voice) => voice.active === false), false);
});

test('typing to him loads his model meanwhile, and a closed Ollama is no trouble', async () => {
  const asked = [];
  await warmOllama({ model: 'qwen3.5:9b', fetchImpl: async (url, init) => (asked.push({ url, method: init.method, body: JSON.parse(init.body) }), { arrayBuffer: async () => new ArrayBuffer(0) }) });
  assert.deepEqual(asked, [{ url: 'http://127.0.0.1:11434/api/generate', method: 'POST', body: { model: 'qwen3.5:9b', keep_alive: LOCAL_KEEP_ALIVE } }]);
  await warmOllama({ model: 'qwen3.5:9b', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await warmOllama({ model: '', fetchImpl: async () => assert.fail('no model, nothing to load') });
});

test('overheard and risky, it asks; refused, nothing is done', async () => {
  const j = jester({ knows: () => true, risky: () => true, allow: false });
  await j.conversation.heard('Jester, quit Safari.');
  assert.deepEqual(j.questions, ['Do “quit Safari”']);
  assert.deepEqual(j.ran, []);
  assert.deepEqual(j.said, ['Okay, I won’t.']);
  const allowed = jester({ knows: () => true, risky: () => true });
  await allowed.conversation.heard('Jester, quit Safari');
  assert.deepEqual(allowed.ran, ['quit Safari']);
});

test('a command given on purpose does not ask', async () => {
  const j = jester({ knows: () => true, risky: () => true });
  await j.conversation.told('quit Safari');
  assert.deepEqual(j.questions, []);
  assert.deepEqual(j.ran, ['quit Safari']);
  // Heard from the voice he knows, the window's light can say so.
  const known = jester({ knowsYou: true });
  await known.conversation.heard('Jester, hello');
  assert.equal(known.shown[0].matched, true);
  await known.conversation.told('hello');
  assert.equal(known.shown.find((voice, i) => i > 0 && voice.phase === 'heard').matched, false);
});

test('he never answers himself: while he talks and just after, only stop gets through', async () => {
  const j = jester();
  let finish;
  j.speaker.hold = new Promise((resolve) => (finish = resolve));
  const talking = j.conversation.heard('Jester, tell me something');
  await new Promise((resolve) => setImmediate(resolve));
  await j.conversation.heard('Jester, I am Jester and I am talking.');
  assert.equal(j.said.length, 1);
  await j.conversation.heard('Stop.');
  assert.equal(j.speaker.stops, 2); // one on starting the turn, one for this
  finish();
  await talking;
  await j.conversation.heard('Hello there.');
  assert.equal(j.entries.filter((entry) => entry.who === 'you').length, 1);
});

test('a question is answered with a whole yes or no, without his name', async () => {
  const j = jester();
  j.assistant.asking = true;
  await j.conversation.heard('Okay so what do we do now');
  await j.conversation.heard('What time is it?');
  assert.deepEqual(j.assistant.answers, []);
  await j.conversation.heard('Yes.');
  await j.conversation.heard('Jester, no.');
  assert.deepEqual(j.assistant.answers, [true, false]);
});

test('"stop" ends a task with or without his name', async () => {
  const j = jester();
  j.assistant.running = true;
  await j.conversation.heard('Jester, stop');
  await j.conversation.heard('Stop.');
  await j.conversation.heard('Keep going, I think.');
  assert.equal(j.assistant.cancelled, 2);
});

test('his name alone waits for the rest, for a while', async () => {
  const j = jester();
  await j.conversation.heard('Jester.');
  assert.equal(j.shown.at(-1).active, true);
  await j.conversation.heard('What time is it?');
  assert.deepEqual(j.entries[0], { who: 'you', text: 'What time is it?' });
  j.pass(60000);
  await j.conversation.heard('Nice weather today.');
  assert.equal(j.entries.filter((entry) => entry.who === 'you').length, 1);
});

test('the start of what is still being said wakes him only when it opens with his name', () => {
  for (const partial of ['Jester', 'Hey Jester what', 'Jester, open', 'Jay what time', 'Just open Spotify']) assert.equal(wakesEarly(partial), true, partial);
  for (const partial of ['', 'Jess', 'Jay', 'I told Jester', 'Tell me Jester', 'Just kidding', 'Chester is', 'What time is it']) assert.equal(wakesEarly(partial), false, partial);
});

test('his name heard mid-sentence puts him to listening, and he lets it go if it was not for him', async () => {
  const j = jester();
  j.conversation.woken();
  assert.equal(j.shown.at(-1).active, true);
  assert.equal(j.shown.at(-1).start, true);
  await j.conversation.heard('Jester, how are you?');
  assert.deepEqual(j.said, ['Hello there.']);
  assert.equal(j.shown.some((voice) => voice.active === false), false);
  j.pass(5000);
  j.conversation.woken();
  await j.conversation.heard('Jessica and I went out.');
  assert.deepEqual(j.shown.at(-1), { active: false });
});

test('his name mid-sentence changes nothing while he talks, asks or works', async () => {
  const j = jester();
  j.speaker.hold = new Promise(() => undefined);
  j.conversation.heard('Jester, tell me something');
  await new Promise((resolve) => setImmediate(resolve));
  const before = j.shown.length;
  j.conversation.woken();
  assert.equal(j.shown.length, before);
  const busy = jester();
  busy.assistant.running = true;
  busy.conversation.woken();
  busy.assistant.running = false;
  busy.assistant.asking = true;
  busy.conversation.woken();
  assert.deepEqual(busy.shown, []);
});

test('Ollama lets his model go two minutes after he last used it', async () => {
  let env = null;
  await askOllama({ model: 'qwen3.5:9b', text: 'hi', history: [], request: async (options) => ((env = options.env), { json: { say: 'Hi.', do: '', new: false } }) });
  assert.equal(env.keepAlive, LOCAL_KEEP_ALIVE);
  assert.equal(LOCAL_KEEP_ALIVE, '2m');
});

test('a newer turn silences an older one, and a turned-off Jester stays quiet', async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const j = jester({ chat: async ({ text }) => (text === 'first' ? (await slow, { say: 'too late', do: '' }) : { say: 'second answer', do: '' }) });
  const first = j.conversation.heard('Jester, first');
  await new Promise((resolve) => setImmediate(resolve));
  await j.conversation.heard('Jester, second');
  release();
  await first;
  assert.deepEqual(j.said, ['second answer']);
  const off = jester({ chat: async () => (await slow, { say: 'nobody here', do: '' }) });
  const going = off.conversation.heard('Jester, hello');
  off.conversation.reset();
  await going;
  assert.deepEqual(off.said, []);
});

test('Ollama being closed is said, not swallowed', async () => {
  const j = jester({ chat: async () => { throw new Error('Ollama isn’t running. Open it and try again.'); } });
  await j.conversation.heard('Jester, hello');
  assert.deepEqual(j.said, ['Ollama isn’t running. Open it and try again.']);
});

test('his own voice coming back is not the user, even past the quiet moment', async () => {
  let time = 1000;
  const entries = [];
  let afresh = 0;
  const conversation = createConversation({
    chat: async () => ({ say: 'That sounds like a rough day, maybe take a break or grab some coffee.', do: '', new: false }),
    speaker: { say: async () => undefined, stop: () => undefined },
    memory: { add: (who, text) => entries.push({ who, text }), current: () => [], idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: () => undefined,
    listenAfresh: () => (afresh += 1),
    now: () => time
  });
  await conversation.heard('Jester, I had a bad day');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(afresh, 1, 'what was mid-utterance when he stopped goes');
  time += 2000;
  // As the Mac's mic really heard him, seven seconds on.
  await conversation.heard('Jester, that sounds like a rough day. Maybe take a break while grabbing the bottom.');
  assert.equal(entries.filter((entry) => entry.who === 'you').length, 1);
  // The user saying something of their own still gets through.
  await conversation.heard('Jester, what should I cook for dinner tonight?');
  assert.equal(entries.filter((entry) => entry.who === 'you').length, 2);
});

test('without a voiceprint he needs his name again; with one, you can talk on', async () => {
  const stranger = jester();
  await stranger.conversation.heard('Jester, hello');
  stranger.pass(2000);
  await stranger.conversation.heard('Pass me the salt, would you?');
  assert.equal(stranger.entries.filter((entry) => entry.who === 'you').length, 1);
  const known = jester({ knowsYou: true });
  await known.conversation.heard('Jester, hello');
  known.pass(2000);
  await known.conversation.heard('And what about tomorrow?');
  assert.equal(known.entries.filter((entry) => entry.who === 'you').length, 2);
});

test('a conversation ends after five quiet minutes, or when the subject changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-talk-'));
  let time = 1_000_000;
  const kept = [];
  const seen = [];
  const memory = createConversationLog({ file: path.join(dir, 'log.json'), now: () => time });
  let reply = { say: 'Sure.', do: '', new: false };
  const conversation = createConversation({
    chat: async ({ history, earlier }) => (seen.push({ history: history.map((entry) => entry.text), earlier }), reply),
    speaker: { say: async () => undefined, stop: () => undefined },
    memory,
    recollections: { keep: async (entries) => void kept.push(entries.map((entry) => entry.text)), relevant: () => ['a recollection'] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: () => undefined,
    now: () => time
  });
  const turn = async (text, ms = 3000) => {
    await conversation.heard(`Jester, ${text}`);
    time += ms;
  };
  await turn('let us plan a trip to Boston');
  await turn('what about the hotels');
  assert.deepEqual(seen[1].history, ['let us plan a trip to Boston', 'Sure.']);
  assert.deepEqual(seen[1].earlier, ['a recollection']);
  // Five minutes on: what came before is over.
  time += 5 * 60 * 1000;
  await turn('how do I boil an egg');
  assert.deepEqual(seen[2].history, []);
  assert.deepEqual(kept[0].slice(0, 2), ['let us plan a trip to Boston', 'Sure.']);
  // A change of subject mid-flow: this line opens the next conversation.
  reply = { say: 'Sure.', do: '', new: true };
  await turn('what is the capital of France');
  reply = { say: 'Sure.', do: '', new: false };
  await turn('and of Spain');
  assert.deepEqual(kept[1], ['how do I boil an egg', 'Sure.']);
  assert.deepEqual(seen[4].history, ['what is the capital of France', 'Sure.']);
  fs.rmSync(dir, { recursive: true });
});

test('the hour takes what is going on, and it is remembered in a sentence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-keep-'));
  let time = 1_000_000;
  const recollections = createRecollections({ file: path.join(dir, 'kept.json'), now: () => time, summarize: async (entries) => `About ${entries[0].text}` });
  const taken = [];
  const log = createConversationLog({ file: path.join(dir, 'log.json'), now: () => time, onEmptied: (entries) => taken.push(entries) });
  log.add('you', 'my dog is named Toby');
  time += EMPTIED_EVERY_MS;
  log.expire();
  await recollections.keep(taken[0]);
  assert.deepEqual(recollections.relevant('anything').map((item) => item.summary), ['About my dog is named Toby']);
  // Kept across a restart, and for a week.
  const later = createRecollections({ file: path.join(dir, 'kept.json'), now: () => time, summarize: async () => '' });
  assert.equal(later.relevant('hello').length, 1);
  time += KEPT_MS + 1;
  assert.equal(later.relevant('hello').length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('with no model to sum it up, the opening line stands for the conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-open-'));
  const recollections = createRecollections({ file: path.join(dir, 'kept.json'), summarize: async () => { throw new Error('Ollama isn’t running'); } });
  await recollections.keep([{ who: 'you', text: 'plan a trip' }, { who: 'jester', text: 'sure' }]);
  assert.match(recollections.relevant('x')[0].summary, /plan a trip/);
  fs.rmSync(dir, { recursive: true });
});

test('what matters to what is being said comes first, then the latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-rel-'));
  let time = 1_000_000;
  const recollections = createRecollections({ file: path.join(dir, 'kept.json'), now: () => time, summarize: async ([entry]) => entry.text });
  for (const text of ['Booked a trip to Boston in March', ...Array.from({ length: 8 }, (_, i) => `Chatted about thing number ${i}`)]) {
    await recollections.keep([{ who: 'you', text }]);
    time += 1000;
  }
  const found = recollections.relevant('what was that trip to Boston').map((item) => item.summary);
  assert.equal(found.length, 6);
  assert.equal(found[0], 'Booked a trip to Boston in March');
  assert.equal(recollections.all().length, 9);
  assert.equal(recollections.all()[0].summary, 'Chatted about thing number 7');
  fs.rmSync(dir, { recursive: true });
});

test('a voiceprint: takes averaged, voices compared, and short clips given a lower bar', () => {
  const print = averageVoice([[1, 0, 0], [2, 0, 0], [0.9, 0.1, 0]]);
  assert.ok(likeness(print, [1, 0, 0]) > 0.99);
  assert.ok(likeness(print, [0, 1, 0]) < 0.1);
  assert.equal(sounds(0.55, 2), false);
  assert.equal(sounds(0.55, 0.5), true);
  assert.equal(sounds(0.2, 0.5), false);
  assert.equal(TEACHING_LINES.length, 5);
});

test('the prompt says who he is, what the laptop can do for him and what he cannot know; the clock is on what was said', () => {
  const prompt = personaPrompt(new Date('2026-11-06T17:40:00'));
  assert.match(prompt, /Your name is Jester\. You are a helpful AI assistant that can take control of the user's laptop and search the internet\./);
  assert.match(prompt, /The laptop sees its own screen and does all of that, so never say you can't/);
  assert.match(prompt, /never a web address they didn't say/);
  assert.match(prompt, /never give weather, news, prices/);
  // Ollama reuses what it read of a prompt the same as the last: with the time in it, that was every minute.
  assert.equal(personaPrompt(new Date('2026-11-06T17:41:00')), prompt);
  assert.doesNotMatch(prompt, /November 6, 2026/);
  assert.match(stamped('what time is it?', new Date('2026-11-06T17:40:00')), /^\[Friday, November 6, 2026 at 5:40.PM\] what time is it\?$/);
});

test('the conversation so far reaches the model as turns, and none without Ollama', async () => {
  let sent;
  const reply = await askOllama({ model: 'm', text: 'and you?', history: [{ who: 'you', text: 'hi' }, { who: 'jester', text: 'hey' }], request: async (request) => ((sent = request), { json: { say: ' fine ', do: '' } }) });
  assert.deepEqual(reply, { say: 'fine', do: '', new: false });
  assert.deepEqual(sent.history, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }]);
  assert.match(sent.prompt, /^\[.+\] and you\?$/);
  assert.equal(sent.env.provider, 'ollama');
  await assert.rejects(askOllama({ model: '', text: 'hi', history: [] }), /can’t reach Ollama/);
});

test('earlier conversations reach the prompt as over and separate, and none means no such part', async () => {
  const date = new Date('2026-11-06T17:40:00');
  assert.doesNotMatch(personaPrompt(date), /Earlier conversations/);
  const prompt = personaPrompt(date, [{ at: date.getTime() - 3600000, summary: 'Planned a trip to Boston.' }]);
  assert.match(prompt, /Earlier conversations, which are over/);
  assert.match(prompt, /Today at 4:40.PM: Planned a trip to Boston\./);
  let sent;
  const text = await summarize({ model: 'm', entries: [{ who: 'you', text: 'hi' }, { who: 'jester', text: 'hey' }], request: async (request) => ((sent = request), { json: { summary: ' A greeting. ' } }) });
  assert.equal(text, 'A greeting.');
  assert.match(sent.prompt, /User: hi\nJester: hey/);
});

test('with no model chosen, the biggest that leaves the computer room', () => {
  const models = [{ name: 'huge', size: 19.8e9 }, { name: 'small', size: 3.1e9 }, { name: 'medium', size: 7.6e9 }];
  assert.equal(pickModel(models), 'medium');
  assert.equal(pickModel([models[0]]), 'huge');
  assert.equal(pickModel([]), '');
});

test('what is spoken is made for the ear, and kept short', () => {
  assert.equal(spokenLine('Undo (⌘Z) · Done'), 'Undo. Done');
  assert.equal(spokenLine('Canvas is open. · Next time, no AI needed.'), 'Canvas is open. Next time, no AI needed.');
  const long = spokenLine(`${'One sentence here. '.repeat(40)}`);
  assert.ok(long.length <= SPOKEN_CHARS && long.endsWith('.'));
});

function voices({ token = 'tok', synth } = {}) {
  const log = { played: [], system: [], trouble: [], synths: 0 };
  let time = 0;
  const speaker = createSpeaker({
    token: async () => token,
    synthesize: synth || (async () => (log.synths += 1, { bytes: new Uint8Array([1]), type: 'audio/mpeg' })),
    play: async (bytes, type) => void log.played.push(type),
    stopPlaying: () => undefined,
    system: { say: async (text) => void log.system.push(text), stop: () => undefined },
    onTrouble: (trouble) => log.trouble.push(trouble),
    now: () => time
  });
  return { speaker, log, pass: (ms) => (time += ms) };
}

test('Puter speaks when connected, and the computer does otherwise', async () => {
  const on = voices();
  await on.speaker.say('hi');
  assert.deepEqual(on.log.played, ['audio/mpeg']);
  assert.deepEqual(on.log.system, []);
  const off = voices({ token: null });
  await off.speaker.say('hi');
  assert.deepEqual(off.log.system, ['hi']);
  const down = voices({ synth: async () => { throw new TypeError('fetch failed'); } });
  await down.speaker.say('hi');
  assert.deepEqual(down.log.system, ['hi']);
});

test('out of credits, Puter rests rather than delaying every line', async () => {
  let asked = 0;
  const v = voices({ synth: async () => { asked += 1; throw new PuterError('Puter’s free allowance has run out for this month.', 'no_credits'); } });
  await v.speaker.say('one');
  await v.speaker.say('two');
  assert.equal(asked, 1);
  assert.deepEqual(v.log.system, ['one', 'two']);
  assert.match(v.log.trouble[0], /allowance/);
  v.pass(3600000);
  await v.speaker.say('three');
  assert.equal(asked, 2);
});

test('Puter is called as its client calls it, and its refusals are told apart', async () => {
  let sent;
  const audio = await synthesize('hi', 'tok', { fetchImpl: async (url, init) => ((sent = { url, init }), new Response(new Uint8Array([7, 8]), { headers: { 'content-type': 'audio/mpeg' } })) });
  assert.deepEqual([...audio.bytes], [7, 8]);
  assert.equal(sent.url, 'https://api.puter.com/drivers/call');
  const body = JSON.parse(sent.init.body);
  assert.deepEqual([body.interface, body.driver, body.method, body.auth_token, body.args.text], ['puter-tts', 'ai-tts', 'synthesize', 'tok', 'hi']);
  const refusal = (status) => synthesize('hi', 'tok', { fetchImpl: async () => new Response('{"message":"no"}', { status, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(refusal(401), (err) => err.code === 'signed_out');
  await assert.rejects(refusal(402), (err) => err.code === 'no_credits');
  await assert.rejects(refusal(500), (err) => err.code === 'refused');
  const inline = await synthesize('hi', 'tok', { fetchImpl: async () => new Response(JSON.stringify({ result: 'data:audio/mpeg;base64,AQI=' }), { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual([...inline.bytes], [1, 2]);
});

test('signing in takes the token from the browser, and only with the right state', async () => {
  const token = await signInToPuter(async (url) => {
    const signIn = new URL(url);
    assert.equal(signIn.searchParams.get('action'), 'authme');
    const back = new URL(signIn.searchParams.get('redirectURL'));
    assert.equal(back.hostname, '127.0.0.1');
    const forged = new URL(back);
    forged.searchParams.set('state', 'wrong');
    forged.searchParams.set('token', 'stolen');
    assert.equal((await fetch(forged)).status, 400);
    back.searchParams.set('token', 'the-token');
    assert.equal((await fetch(back)).status, 200);
  });
  assert.equal(token, 'the-token');
});
