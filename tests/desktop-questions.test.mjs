/**
 * A question only the user can settle (the user, 2026-11-21: "you see two accounts: stop the task and ask what I
 * would want you to do"): asked with the ways to answer it, answered in their own words by voice, typing or a
 * click, and carried between a Mac, the server and the Chrome extension.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createChromeLink } from '../desktop/src/main/chrome-link.js';
import { createCloudLink, parseCloudLink } from '../desktop/src/main/cloud-link.js';
import { agrees, createConversation, questionLine } from '../desktop/src/main/conversation.js';
import { createRemoteHands } from '../desktop/src/main/remote-hands.js';
import { createWebGateway } from '../desktop/src/main/web-gateway.js';

// The assistant reaches Electron through chrome-bridge.js: a page list is all it needs here.
const electron = `data:text/javascript,
  export const app = {}, BrowserWindow = {}, ipcMain = {};
  export const webContents = { getAllWebContents: () => [] };`;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context)) });
const { chosen, createAssistant } = await import('../desktop/src/main/assistant.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function realAssistant() {
  const shown = [];
  const heard = [];
  const assistant = createAssistant({
    driver: { call: () => Promise.resolve({}) },
    openApp: async () => ({ ok: true, text: '' }),
    activate: async () => undefined,
    openUrl: async () => undefined,
    dispatch: async () => ({ ok: true, detail: '' }),
    listen: (label, more) => heard.push([label, more]),
    prompt: { show: (text, more) => shown.push([text, more]), hide: () => shown.push('hidden') },
    platform: 'darwin'
  });
  const asking = async () => {
    while (!assistant.asking) await tick();
  };
  return { assistant, shown, heard, asking };
}

test('an answer chooses an option by its name, most of its name or its place, and by one only; else it’s their own words', () => {
  const profiles = ['Krish', 'Sandeep Chavan'];
  assert.equal(chosen('Krish', profiles), 'Krish');
  assert.equal(chosen('krish.', profiles), 'Krish');
  assert.equal(chosen('use the Krish one', profiles), 'Krish');
  assert.equal(chosen('Sandeep', profiles), 'Sandeep Chavan');
  assert.equal(chosen('the first one', profiles), 'Krish');
  assert.equal(chosen('the second', profiles), 'Sandeep Chavan');
  assert.equal(chosen('the last one', ['A', 'B', 'C']), 'C');
  // A word two of them share chooses neither, and so does something else altogether.
  assert.equal(chosen('Chavan', ['Krish Chavan', 'Sandeep Chavan']), 'Chavan');
  assert.equal(chosen('neither, use my work profile', profiles), 'neither, use my work profile');
  assert.equal(chosen('whatever you think', []), 'whatever you think');
});

test('a question of the assistant’s own is shown with its options and answered in the user’s words, never by a yes', async () => {
  const { assistant, shown, heard, asking } = realAssistant();
  const answer = assistant.inquire({ question: 'Which Hulu profile should I use?', options: ['Krish', 'Sandeep Chavan'] });
  await asking();
  assert.deepEqual(shown.at(-1), ['Which Hulu profile should I use?', { options: ['Krish', 'Sandeep Chavan'], open: true }]);
  assert.deepEqual(heard.at(-1), ['Which Hulu profile should I use', { options: ['Krish', 'Sandeep Chavan'], open: true }]);
  assert.deepEqual(assistant.asked, { label: 'Which Hulu profile should I use', options: ['Krish', 'Sandeep Chavan'], open: true });
  // A thumbs up is no answer to "which"; neither is `true`.
  assert.equal(assistant.gesture('Thumb_Up'), false);
  assistant.answer(true);
  assert.equal(assistant.asking, false, 'something that isn’t words leaves it unanswered');
  assert.equal(await answer, null);

  const again = assistant.inquire({ question: 'Which Hulu profile should I use?', options: ['Krish', 'Sandeep Chavan'] });
  await asking();
  assert.equal(assistant.heard('the second one'), true);
  assert.equal(await again, 'Sandeep Chavan');
  assert.equal(assistant.asked, null);

  // With nothing to choose from, their words are the answer; 👎 and "never mind" leave it.
  const free = assistant.inquire({ question: 'Who should it go to?' });
  await asking();
  assert.equal(assistant.asked.open, true);
  assistant.answer('my dad, Sandeep');
  assert.equal(await free, 'my dad, Sandeep');
  const left = assistant.inquire({ question: 'Who should it go to?' });
  await asking();
  assert.equal(assistant.gesture('Thumb_Down'), true);
  assert.equal(await left, null);
  const dropped = assistant.inquire({ question: 'Who should it go to?' });
  await asking();
  assistant.heard('never mind');
  assert.equal(await dropped, null);
});

test('leave to do something is still a yes or a no: words alone are never a yes', async () => {
  const { assistant, shown, asking } = realAssistant();
  const answer = assistant.confirm('Send the message to Dad');
  await asking();
  assert.deepEqual(shown.at(-1), ['Send the message to Dad?', { options: [], open: false }]);
  assert.deepEqual(assistant.asked, { label: 'Send the message to Dad', options: [], open: false });
  assistant.answer('yes');
  assert.equal(await answer, false, 'a string isn’t leave');
  const second = assistant.confirm('Send the message to Dad');
  await asking();
  assistant.answer(true);
  assert.equal(await second, true);
});

test('he asks a question the way a person would: no “say yes or no”, and the ways to answer it said once', () => {
  assert.equal(questionLine('Send the message to Dad'), 'Send the message to Dad?');
  assert.equal(questionLine('Which Hulu profile should I use', { options: ['Krish', 'Sandeep Chavan'], open: true }), 'Which Hulu profile should I use: Krish, or Sandeep Chavan?');
  assert.equal(questionLine('Which one', { options: ['Dad', 'Dad (work)', 'Dan'], open: true }), 'Which one: Dad, Dad (work), or Dan?');
  // Named in the question already, they aren't said twice.
  assert.equal(questionLine('Should I use Krish or Sandeep Chavan', { options: ['Krish', 'Sandeep Chavan'], open: true }), 'Should I use Krish or Sandeep Chavan?');
  assert.equal(questionLine('Who should it go to', { open: true }), 'Who should it go to?');
  assert.equal(questionLine('Send the message to Dad', { again: true }), 'Sorry, was that a yes or a no? Send the message to Dad?');
  assert.match(questionLine('Which profile', { options: ['A', 'B'], open: true, again: true }), /^Sorry, I didn’t catch which\. Which profile: A, or B\?$/);
});

/** A conversation whose assistant is waiting on a question. */
function talking(asked, { now, expecting, knowsYou = true } = {}) {
  const answers = [];
  const said = [];
  const entries = [];
  const assistant = { asking: true, running: true, asked, answers, answer: (value) => answers.push(value), cancel: () => undefined, reask: () => (answers.push('asked again'), true) };
  const conversation = createConversation({
    chat: async () => ({ say: 'Hello there.', do: '' }),
    speaker: { say: async (line) => said.push(line), stop: () => undefined },
    memory: { add: (who, text) => entries.push({ who, text }), current: () => entries, idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    knowsYou: () => knowsYou,
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant,
    show: () => undefined,
    ...(now ? { now } : {}),
    ...(expecting ? { expecting } : {})
  });
  return { conversation, assistant, answers, said, entries };
}

test('what’s said to a question that wants their own answer is the answer, with no name and no yes; “never mind” leaves it', async () => {
  const open = { label: 'Which Hulu profile should I use', options: ['Krish', 'Sandeep Chavan'], open: true };
  const j = talking(open);
  await j.conversation.heard('Krish.');
  await j.conversation.heard('the second one', { unsure: true });
  await j.conversation.heard('never mind');
  assert.deepEqual(j.answers, ['Krish.', 'the second one', null]);
  // Typed, the same.
  await j.conversation.told('use Krish', { typed: true });
  await j.conversation.told('forget it', { typed: true });
  assert.deepEqual(j.answers.slice(3), ['use Krish', null]);
  assert.equal(j.said.length, 0, 'none of it was a turn for his model');
});

test('leave is given the ways people give it, in a voice too short to be sure of as well, and never by half a sentence', async () => {
  const j = talking({ label: 'Send the message to Dad', options: [], open: false });
  for (const yes of ['Yes.', 'yeah, go ahead', 'Sure, send it', 'okay do it', 'go for it', 'Yes please']) await j.conversation.heard(yes);
  assert.deepEqual(j.answers, [true, true, true, true, true, true]);
  for (const no of ['No.', 'no, don’t send it', 'not yet', 'wait, hold on', 'never mind']) await j.conversation.heard(no);
  assert.deepEqual(j.answers.slice(6), [false, false, false, false, false]);
  const before = j.answers.length;
  await j.conversation.heard('okay so what does it say');
  await j.conversation.heard('yes but use the other account');
  await j.conversation.heard('sure, tell me about the weather');
  assert.equal(j.answers.length, before, 'none of them is an answer');
  // A yes with what it's for said after it.
  for (const yes of ['yes, go ahead and click it', 'Yeah you can do that', 'okay, click allow', 'sure go ahead and send it please']) await j.conversation.heard(yes);
  assert.deepEqual(j.answers.slice(before), [true, true, true, true]);
  // 2026-11-21: the user's own bare yeses scored 0.26 to 0.44 against their voiceprint, none as surely theirs.
  await j.conversation.heard('Yes.', { unsure: true });
  await j.conversation.heard('go ahead', { unsure: true });
  assert.deepEqual(j.answers.slice(before + 4), [true, true]);
});

test('agrees reads a yes alone or a yes and its go-ahead, and nothing with a condition or a question in it', () => {
  for (const yes of ['yes', 'Yeah.', 'ok', 'go ahead', 'yes go ahead and click on it', 'yep, that’s fine', 'Sure, please do that']) assert.equal(agrees(yes), true, yes);
  for (const not of ['', 'yes but not that one', 'okay so what', 'yes, which one?', 'sure if it’s free', 'yesterday I went out', 'okay wait', 'yes click the other one', 'I don’t know', 'yes go ahead and click it and then open the other tab and send that to him too']) assert.equal(agrees(not), false, not);
});

test('waiting on a yes or a no he isn’t deaf to anything else said to him: the question is left, and that’s answered', async () => {
  // 2026-11-21: for the minute a question waited, all but a bare yes or no was let pass, his name or not ("I need to
  // hit the stop listening and then start listening for him to hear me").
  const j = talking({ label: 'Click Allow', options: [], open: false });
  await j.conversation.heard('Jester, what does that do?');
  assert.deepEqual(j.answers, [false], 'the question is left');
  assert.deepEqual(j.entries.filter((entry) => entry.who === 'you').map((entry) => entry.text), ['what does that do?']);
  assert.deepEqual(j.said, ['Hello there.'], 'and what they said is answered');
  // Without his name, and with no question of his just asked aloud: someone talking in the room.
  const k = talking({ label: 'Click Allow', options: [], open: false });
  await k.conversation.heard('I think we should get lunch.');
  await k.conversation.heard('Jester, what does that do?', { unsure: true });
  assert.deepEqual(k.answers, [false], 'his name will do from a voice that may be theirs; no name won’t');
});

test('once he’s asked, a short answer is read whoever’s voice it seems, and what’s said next in their voice is to him', async () => {
  let time = 5000;
  const awaited = [];
  const j = talking({ label: 'Click Allow', options: [], open: false }, { now: () => time, expecting: (ms) => awaited.push(ms) });
  await j.conversation.ask('Click Allow');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(j.said, ['Click Allow?']);
  assert.deepEqual(awaited, [60000], 'for as long as the question waits, and only once it’s been asked');
  // A yes begun before he asked was a yes to something else.
  await j.conversation.heard('Yes.', { startedAt: 4000 });
  assert.deepEqual(j.answers, []);
  time += 3000;
  // Their voice for sure, just after he asked, and no yes or no: to him.
  await j.conversation.heard('what does that do', { startedAt: time - 500 });
  assert.deepEqual(j.answers, [false]);
  assert.equal(awaited.at(-1), 0, 'and he’s no longer waiting');
});

test('a yes said the moment he stops asking is taken, not let pass as his own voice dying away', async () => {
  let time = 5000;
  const j = talking({ label: 'Click Allow', options: [], open: false }, { now: () => time });
  await j.conversation.ask('Click Allow');
  await new Promise((resolve) => setImmediate(resolve));
  // 0.3 s after his last word, in a voice that may be theirs: until 2026-11-21 dropped for 1.2 s after he spoke.
  time += 900;
  await j.conversation.heard('Yes.', { unsure: true, startedAt: time - 600 });
  assert.deepEqual(j.answers, [true]);
  // An answer that shares its words with the question isn't his echo.
  const k = talking({ label: 'Want me to read it', options: [], open: false }, { now: () => time });
  await k.conversation.ask('Want me to read it');
  await new Promise((resolve) => setImmediate(resolve));
  time += 2000;
  await k.conversation.heard('Yes, read it.', { unsure: true, startedAt: time - 800 });
  assert.deepEqual(k.answers, [true]);
  assert.equal(agrees('Yes, read it.', 'Want me to read it'), true);
  assert.equal(agrees('Yes, read me the news', 'Want me to read it'), false);
});

test('a Mac’s open question is asked on the server with its options, and the answer goes back as their words', async (t) => {
  const asked = [];
  const hands = createRemoteHands({ onAsk: (label, chat, more) => asked.push([label, more]) });
  const gateway = createWebGateway({
    key: 'questions-test-key-0123456',
    port: 0,
    onMessage: async () => null,
    onStorage: async () => null,
    onConnect: (client) => client.role === 'mac' && hands.join(client),
    onClose: (client) => hands.leave(client),
    onOther: (client, frame) => hands.frame(client, frame)
  });
  const port = await gateway.ready;
  const state = { running: true, asking: true, abilities: { computer: 'Mac' } };
  const did = [];
  const link = createCloudLink({
    link: parseCloudLink(`http://127.0.0.1:${port}/?key=questions-test-key-0123456`),
    onVoice: () => undefined,
    onPlay: () => undefined,
    handsState: () => state,
    idleSeconds: () => 1,
    onHands: async (frame) => (did.push(frame), frame.op === 'inquire' ? 'Krish' : null)
  });
  t.after(() => {
    link.close();
    gateway.close();
  });
  await until(() => hands.connected);
  link.changed?.();
  // The Mac's task has a question only they can settle.
  link.ask('Which Hulu profile should I use', { open: true, options: ['Krish', 'Sandeep Chavan'] });
  await until(() => asked.length === 1);
  assert.deepEqual(asked[0], ['Which Hulu profile should I use', { open: true, options: ['Krish', 'Sandeep Chavan'] }]);
  await until(() => hands.assistant.asking);
  assert.deepEqual(hands.assistant.asked, { label: 'Which Hulu profile should I use', options: ['Krish', 'Sandeep Chavan'], open: true });
  hands.assistant.answer('Krish');
  await until(() => did.some((frame) => frame.op === 'answer'));
  assert.deepEqual(did.find((frame) => frame.op === 'answer'), { t: 'hands', id: did.find((frame) => frame.op === 'answer').id, op: 'answer', yes: true, text: 'Krish' });
  // Left unanswered, and a plain yes, go back as what they are.
  hands.assistant.answer(null);
  hands.assistant.answer(true);
  await until(() => did.filter((frame) => frame.op === 'answer').length === 3);
  const [, left, yes] = did.filter((frame) => frame.op === 'answer');
  assert.equal(left.left, true);
  assert.equal(left.yes, false);
  assert.equal(yes.yes, true);
  assert.equal('text' in yes, false);
  // A yes-or-no question after it is one again.
  link.ask('Send the message to Dad');
  await until(() => asked.length === 2);
  assert.deepEqual(asked[1], ['Send the message to Dad', {}]);
  assert.equal(hands.assistant.asked.open, false);
  // The conversation's own question goes to the Mac, whose window shows it, and comes back answered.
  assert.equal(await hands.assistant.inquire({ question: 'Which Dad?', options: ['Dad', 'Dad (work)'] }), 'Krish');
  assert.deepEqual(did.find((frame) => frame.op === 'inquire').options, ['Dad', 'Dad (work)']);
});

test('with no Mac, a question is asked in the conversation itself and answered by what’s said next', async () => {
  const asked = [];
  const hands = createRemoteHands({ onAsk: (label, chat, more) => asked.push([label, more]) });
  const answer = hands.assistant.inquire({ question: 'Which list', options: ['Groceries', 'Hardware'] });
  assert.deepEqual(asked, [['Which list', { open: true, options: ['Groceries', 'Hardware'] }]]);
  assert.deepEqual(hands.assistant.asked, { label: 'Which list', options: ['Groceries', 'Hardware'], open: true });
  hands.assistant.answer('Groceries');
  assert.equal(await answer, 'Groceries');
  assert.equal(hands.assistant.asked, null);
  const left = hands.assistant.inquire({ question: 'Which list' });
  hands.assistant.cancel();
  assert.equal(await left, null);
});

test('the extension’s question with options comes back with the user’s own answer; one that asks leave, approved or not', async () => {
  const sent = [];
  const asks = [];
  const link = createChromeLink({
    send: (message) => (sent.push(message), true),
    version: '0.1.0',
    onAsk: async (label, more) => (asks.push([label, more]), more?.open ? (label.startsWith('Which') ? 'Krish' : null) : label === 'Send the email')
  });
  link.connected('chrome-extension://x/', {});
  link.message({ type: 'hello', version: '0.3.0', settings: {} });
  link.message({ type: 'ask', id: 'a1', label: 'Which profile should I use', options: ['Krish', 'Sandeep Chavan'] });
  link.message({ type: 'ask', id: 'a2', label: 'Who is this for', open: true });
  link.message({ type: 'ask', id: 'a3', label: 'Send the email' });
  link.message({ type: 'ask', id: 'a4', label: 'Buy it' });
  await tick();
  await tick();
  assert.deepEqual(asks, [
    ['Which profile should I use', { open: true, options: ['Krish', 'Sandeep Chavan'] }],
    ['Who is this for', { open: true, options: [] }],
    ['Send the email', {}],
    ['Buy it', {}]
  ]);
  assert.deepEqual(sent.filter((message) => message.type === 'answer'), [
    { type: 'answer', id: 'a1', approved: true, text: 'Krish' },
    { type: 'answer', id: 'a2', approved: false },
    { type: 'answer', id: 'a3', approved: true },
    { type: 'answer', id: 'a4', approved: false }
  ]);
});
