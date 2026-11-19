// Typing to him (2026-11-18, asking for Google Docs comments on an essay's paragraphs): Return on "now this:" keeps it
// in the box for the paste (home/typing.js), the next passage carries the chat on, and a message sent while he's
// still thinking stops that thought and is answered with what came before it, as one.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, personaPrompt } from '../desktop/src/main/conversation.js';
import { leadsIn, typingBox } from '../desktop/src/home/typing.js';

const realMatchMedia = globalThis.matchMedia;
after(() => {
  globalThis.matchMedia = realMatchMedia;
});

test('what leads into a paste is told from what asks something', () => {
  for (const lead of ['now this:', 'Now this', 'now this one', 'here’s another', "here's the next one", 'okay, and this', 'this one:', 'Comment on this paragraph:', 'next paragraph']) {
    assert.equal(leadsIn(lead), true, lead);
  }
  // Bare "next", "another one" and the like ask for the next song or another joke, typed.
  for (const asks of ['next', 'next one', 'another one', 'this', 'here', 'tell me what to highlight in docs', 'what is this?', 'Give me a comment to make on this text in google docs', 'now this:\nThe passage itself.', 'Here is the thing: I think the essay is weak and I need to say why in a comment for my class.']) {
    assert.equal(leadsIn(asks), false, asks);
  }
});

/** A .type form and its textarea, as typingBox sees them: Return's what's checked, not how the page draws it. */
function box(value, { caret = value.length } = {}) {
  const handlers = {};
  const classes = new Set(['type']);
  const textarea = {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    addEventListener: (type, fn) => (handlers[`box:${type}`] = fn)
  };
  const form = {
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    querySelector: () => textarea,
    addEventListener: (type, fn) => (handlers[`form:${type}`] = fn),
    sent: 0,
    requestSubmit() {
      this.sent += 1;
    }
  };
  typingBox(form);
  const press = (keys = {}) => {
    const event = { key: 'Enter', isComposing: false, keyCode: 13, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, prevented: false, ...keys, preventDefault() { this.prevented = true; } };
    handlers['box:keydown'](event);
    return { sent: form.sent > 0, newLine: !event.prevented && form.sent === 0, tall: classes.has('tall') };
  };
  return { press };
}

test('Return sends; Shift-Return, and Return after "now this:", start a new line in the tall box', () => {
  globalThis.matchMedia = () => ({ matches: false });
  assert.deepEqual(box('what time is it').press(), { sent: true, newLine: false, tall: false });
  assert.deepEqual(box('what time is it').press({ shiftKey: true }), { sent: false, newLine: true, tall: true });
  assert.deepEqual(box('now this:').press(), { sent: false, newLine: true, tall: true });
  // With the new line there, Return sends: one that wasn't a lead-in costs a key, not a wait.
  assert.deepEqual(box('Give me three dinner ideas:\n').press(), { sent: true, newLine: false, tall: false });
  // Return in the middle of what's typed is a send, as anywhere else.
  assert.deepEqual(box('now this:', { caret: 3 }).press(), { sent: true, newLine: false, tall: false });
  // An input method's Return ends its word: nothing's sent.
  assert.deepEqual(box('now').press({ isComposing: true }), { sent: false, newLine: true, tall: false });
  assert.deepEqual(box('now').press({ keyCode: 229 }), { sent: false, newLine: true, tall: false });
});

test('on a phone, return is a new line, and the arrow sends', () => {
  globalThis.matchMedia = (query) => ({ matches: query === '(hover: none) and (pointer: coarse)' });
  assert.deepEqual(box('what time is it').press(), { sent: false, newLine: true, tall: true });
});

function jester({ chat, history = [] } = {}) {
  const entries = history.map(([who, text]) => ({ who, text }));
  const calls = [];
  const shown = [];
  let started = 0;
  const conversation = createConversation({
    chat: async (options) => {
      calls.push({ text: options.text, history: options.history.map((entry) => `${entry.who}: ${entry.text}`) });
      return chat(options);
    },
    speaker: { async say() {}, stop() {} },
    memory: {
      add: (who, text) => entries.push({ who, text }),
      current: () => entries.map((entry) => ({ ...entry })),
      idleFor: () => null,
      startNew: () => {
        started += 1;
        return [];
      },
      clear: () => entries.splice(0)
    },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    knowsYou: () => true,
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: { ok: true, text: '' } }) },
    assistant: { asking: false, running: false, answer() {}, cancel() {}, async confirm() { return true; } },
    show: (voice) => shown.push(voice)
  });
  return { conversation, entries, calls, shown, started: () => started };
}

test('a message sent while he is thinking stops that thought, and is answered with what came before it, in one chat', async () => {
  let thinking = 0;
  const j = jester({
    chat: ({ text, signal }) =>
      new Promise((resolve, reject) => {
        thinking += 1;
        const timer = setTimeout(() => resolve({ say: `About ${text}.`, do: '', new: true }), text === 'A' ? 300 : 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          thinking -= 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
  });
  const first = j.conversation.told('A', { typed: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = j.conversation.told('B', { typed: true });
  await Promise.allSettled([first, second]);
  assert.equal(thinking, 1, 'the thought about A was stopped');
  assert.deepEqual(j.calls.at(-1), { text: 'B', history: ['you: A'] }, 'B is thought about with A before it');
  assert.deepEqual(j.entries.map((entry) => `${entry.who}: ${entry.text}`), ['you: A', 'you: B', 'jester: About B.']);
  assert.deepEqual(j.shown.filter((voice) => voice.phase === 'answer').map((voice) => voice.text), ['About B.'], 'one answer');
  // The model called B a new subject; it came while A was unanswered, so the two stay one chat.
  assert.equal(j.started(), 0);
});

test('the next passage pasted for the same job carries the chat on, whatever the model says of it', async () => {
  const passage = (word) => `${word} `.repeat(80);
  const started = async (history, text) => {
    const j = jester({ history, chat: async () => ({ say: 'A comment.', do: '', new: true }) });
    await j.conversation.told(text, { typed: true });
    return j.started();
  };
  const before = [['you', passage('regulation')], ['you', 'Give me a comment to make on this text'], ['jester', 'A comment.']];
  assert.equal(await started(before, passage('machines')), 0, 'the next passage');
  assert.equal(await started(before, 'now this:\nMachines free us for the human work.'), 0, 'a short one, said to be the next');
  assert.equal(await started(before, 'what should I eat tonight?'), 1, 'a new subject still is one');
  assert.equal(await started([['you', 'hi'], ['jester', 'Hello.']], passage('machines')), 1, 'a first passage can begin one');
});

test('his prompt asks for the words to paste, the exact words to highlight, the same job for the next passage, and both of two messages answered', () => {
  const prompt = personaPrompt(new Date('2026-11-18T15:00:00'));
  assert.match(prompt, /give the words themselves, ready to paste/);
  assert.match(prompt, /word for word in double quotation marks/);
  assert.match(prompt, /wants the same done to it/);
  assert.match(prompt, /Another passage pasted after you've worked on one is never a new subject/);
  assert.match(prompt, /take both together and answer them as one/);
});
