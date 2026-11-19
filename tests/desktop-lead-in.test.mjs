// Typed words that only lead into a paste ("now this:") wait for it, and go to him with it as one message
// (2026-11-18: he answered "the text didn't come through", and the passage, alone, opened a new chat).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, leadsIn, LEAD_MS, personaPrompt } from '../desktop/src/main/conversation.js';

function jester() {
  const entries = [];
  const asked = [];
  const shown = [];
  const conversation = createConversation({
    chat: async ({ text }) => {
      asked.push(text);
      return { say: 'Here you go.', do: '' };
    },
    speaker: { async say() {}, stop() {} },
    memory: {
      add: (who, text) => entries.push({ who, text }),
      current: () => entries.map((entry) => ({ ...entry, at: new Date().toISOString() })),
      idleFor: () => null,
      startNew: () => [],
      clear: () => entries.splice(0)
    },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    knowsYou: () => true,
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: { ok: true, text: '' } }) },
    assistant: { asking: false, running: false, answer() {}, cancel() {}, async confirm() { return true; } },
    show: (voice) => shown.push(voice)
  });
  return { conversation, entries, asked, shown };
}

test('what leads in is told from what asks something', () => {
  for (const lead of ['now this:', 'Now this', 'here’s another', 'okay next one', 'this one:', 'Comment on this paragraph:', 'another one']) assert.equal(leadsIn(lead), true, lead);
  for (const asks of ['tell me what to highlight in docs', 'what is this?', 'Give me a comment to make on this text in google docs', 'now this:\nThe passage itself.', 'Here is the thing: I think the essay is weak and I need to say why in a comment for my class.']) assert.equal(leadsIn(asks), false, asks);
});

test('typed "now this:" waits for the paste, and they go to him together, as one line of the chat', async () => {
  const j = jester();
  await j.conversation.told('now this:', { typed: true });
  assert.deepEqual(j.asked, [], 'not answered alone');
  assert.ok(j.shown.some((voice) => voice.transcript?.text === 'now this:'), 'shown while it waits');
  await j.conversation.told('Could the proliferation of machine intelligence highlight…', { typed: true });
  assert.deepEqual(j.asked, ['now this:\nCould the proliferation of machine intelligence highlight…']);
  assert.deepEqual(j.entries.map((entry) => entry.who), ['you', 'jester']);
});

test('with nothing pasted after it, what leads in is answered alone, in time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const j = jester();
    await j.conversation.told('now this:', { typed: true });
    mock.timers.tick(LEAD_MS - 1);
    assert.deepEqual(j.asked, []);
    mock.timers.tick(1);
    mock.timers.reset();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(j.asked, ['now this:']);
  } finally {
    mock.timers.reset();
  }
});

test('said aloud meanwhile, what leads in is let go: the spoken words are answered alone, and nothing comes later', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const j = jester();
    await j.conversation.told('now this:', { typed: true });
    await j.conversation.told('what time is it');
    mock.timers.tick(LEAD_MS);
    mock.timers.reset();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(j.asked, ['what time is it']);
  } finally {
    mock.timers.reset();
  }
});

test('his prompt asks for the words to paste, the exact words to highlight, and the same job for the next passage', () => {
  const prompt = personaPrompt(new Date('2026-11-18T15:00:00'));
  assert.match(prompt, /give the words themselves, ready to paste/);
  assert.match(prompt, /word for word in double quotation marks/);
  assert.match(prompt, /wants the same done to it/);
  assert.match(prompt, /Another passage pasted after you've worked on one is never a new subject/);
});

test('the next passage pasted for the same job carries the chat on, whatever the model says of it', async () => {
  const passage = (word) => `${word} `.repeat(80);
  const run = async (history, text, { typed = true } = {}) => {
    const entries = history.map(([who, line]) => ({ who, text: line }));
    let started = 0;
    const conversation = createConversation({
      chat: async () => ({ say: 'A comment.', do: '', new: true }),
      speaker: { async say() {}, stop() {} },
      memory: { add: (who, line) => entries.push({ who, text: line }), current: () => entries.map((entry) => ({ ...entry })), idleFor: () => null, startNew: () => { started += 1; return []; }, clear: () => entries.splice(0) },
      recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
      knowsYou: () => true,
      commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: { ok: true, text: '' } }) },
      assistant: { asking: false, running: false, answer() {}, cancel() {}, async confirm() { return true; } },
      show: () => undefined
    });
    await conversation.told(text, { typed });
    return started;
  };
  const before = [['you', passage('regulation')], ['you', 'Give me a comment to make on this text'], ['jester', 'A comment.']];
  assert.equal(await run(before, passage('machines')), 0, 'the next passage');
  assert.equal(await run(before, 'what should I eat tonight?'), 1, 'a new subject still is one');
  assert.equal(await run([['you', 'hi'], ['jester', 'Hello.']], passage('machines')), 1, 'a first passage can begin one');
});
