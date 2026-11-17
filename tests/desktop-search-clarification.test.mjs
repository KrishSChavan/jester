import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../desktop/src/main/conversation.js';
import { createVoiceRunner } from '../desktop/src/main/voice-runner.js';

const QUESTION = 'What would you like me to search for?';
const clarify = () => ({ ok: true, handled: true, text: QUESTION, clarification: { goal: 'search', question: QUESTION } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function rig({ hold = false, run = null, known = false } = {}) {
  let time = 1000;
  let release;
  const entries = [], ran = [], chats = [], said = [];
  const speaker = {
    say: async (text) => { said.push(text); if (hold && text === QUESTION) await new Promise((resolve) => { release = resolve; }); },
    stop: () => { const done = release; release = null; done?.(); }
  };
  const conversation = createConversation({
    chat: async ({ text }) => { chats.push(text); return { say: 'An ordinary chat response.', do: '' }; },
    speaker, memory: { add: (who, text) => entries.push({ who, text }), current: () => entries.slice(), idleFor: () => null, startNew: () => [], clear: () => { entries.length = 0; } },
    recollections: { keep: async () => undefined, relevant: () => [], forget() {} },
    commands: { knows: async (text) => /^(?:search|open)\b/.test(text), risky: async () => false,
      run: async (text, original, context) => { ran.push({ text, original, context }); return { outcome: run ? await run(text) : text === 'search' ? clarify() : { ok: true, text: 'Fresh results.' } }; } },
    assistant: { asking: false, running: false, cancel() {} }, show() {}, knowsYou: () => known, now: () => time
  });
  return { conversation, entries, ran, chats, said, advance: (ms) => (time += ms) };
}

test('a topic-only typed reply resumes search with the original request and recent context', async () => {
  const j = rig();
  await j.conversation.told('search', { typed: true });
  await j.conversation.told('news', { typed: true });
  assert.equal(j.ran.length, 2);
  assert.match(j.ran[1].text, /^search\nSearch target supplied by the user: news$/);
  assert.match(j.ran[1].context, /What would you like.*news/);
  assert.deepEqual(j.chats, []);
  assert.equal(j.entries.at(-1).text, 'Fresh results.');
});

test('a search answer needs no wake word from a voice the voiceprint knows', async () => {
  const j = rig({ known: true });
  await j.conversation.heard('Jester search', { startedAt: j.advance(100) });
  await j.conversation.heard('news', { startedAt: j.advance(2000) });
  assert.equal(j.ran.length, 2);
  assert.match(j.ran[1].text, /user: news$/);
  assert.deepEqual(j.chats, []);
});

test('without a voiceprint a search answer takes his name, as an answer to any question of his does', async () => {
  const j = rig();
  await j.conversation.heard('Jester search', { startedAt: j.advance(100) });
  // Anyone in the room, or the television: not taken for the topic.
  await j.conversation.heard('news', { startedAt: j.advance(2000) });
  assert.equal(j.ran.length, 1);
  await j.conversation.heard('Jester, news', { startedAt: j.advance(2000) });
  assert.equal(j.ran.length, 2);
  assert.match(j.ran[1].text, /user: news$/);
});

test('a first answer begun while the clarification is spoken interrupts and resumes the search', async () => {
  const j = rig({ hold: true, known: true });
  const question = j.conversation.told('search');
  await tick();
  assert.ok(j.said.includes(QUESTION));
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await j.conversation.heard('news', { startedAt });
  await question;
  assert.equal(j.ran.length, 2);
  assert.match(j.ran[1].text, /user: news$/);
  assert.equal(j.entries.at(-1).text, 'Fresh results.');
});

test('an answer begun during the clarification window survives a long utterance and transcription', async () => {
  const j = rig({ known: true });
  await j.conversation.told('search');
  const startedAt = j.advance(2000);
  j.conversation.hearing({ startedAt });
  j.advance(121000);
  await j.conversation.heard('news', { startedAt });
  assert.equal(j.ran.length, 2);
  assert.match(j.ran[1].text, /user: news$/);
});

for (const method of ['reset', 'forget', 'end']) test(`${method} clears a pending search question`, async () => {
  const j = rig();
  await j.conversation.told('search', { typed: true });
  j.conversation[method]();
  await j.conversation.told('news', { typed: true });
  assert.equal(j.ran.length, 1);
  assert.deepEqual(j.chats, ['news']);
});

test('a complete new task replaces the pending question', async () => {
  const j = rig();
  await j.conversation.told('search', { typed: true });
  await j.conversation.told('open Notes', { typed: true });
  assert.equal(j.ran[1].text, 'open Notes');
  await j.conversation.told('news', { typed: true });
  assert.deepEqual(j.chats, ['news']);
});

test('cancelling or waiting two minutes clears the pending question', async () => {
  for (const cancel of [true, false]) {
    const j = rig();
    await j.conversation.told('search', { typed: true });
    if (cancel) await j.conversation.told('never mind', { typed: true });
    else j.advance(120001);
    await j.conversation.told('news', { typed: true });
    assert.equal(j.ran.length, 1);
    assert.deepEqual(j.chats, ['news']);
  }
});

test('a late clarification from a replaced turn cannot capture a later reply', async () => {
  let finish;
  const j = rig({ run: (text) => text === 'search' ? new Promise((resolve) => { finish = resolve; }) : { ok: true, text: 'Opened Notes.' } });
  const first = j.conversation.told('search', { typed: true });
  await tick();
  await j.conversation.told('open Notes', { typed: true });
  finish(clarify());
  await first;
  await j.conversation.told('news', { typed: true });
  assert.equal(j.ran.length, 2);
  assert.deepEqual(j.chats, ['news']);
});

test('search clarification runs before learned shortcuts and app discovery', async () => {
  const contexts = [];
  const runner = createVoiceRunner({ driver: { call: async () => assert.fail('no app discovery before topic') },
    dispatch: async () => assert.fail('no input'), canPost: () => true, onJester() {},
    learned: { phrase: async () => assert.fail('search cannot bypass routing through a learned phrase') },
    assistant: { canResearch: (text) => /^search\b/.test(text || ''), research: async (goal, options) => { contexts.push(options); return clarify(); } }
  });
  const { outcome } = await runner.run('search', { context: 'Recent conversation' });
  assert.deepEqual(outcome, clarify());
  assert.deepEqual(contexts, [{ context: 'Recent conversation' }]);
});

test('approved interaction executes the resolved goal and skips a second research gate in Chrome', async () => {
  const research = [], handed = [];
  const runner = createVoiceRunner({ driver: { call: async () => ({ apps: [] }) }, installed: () => [],
    dispatch: async () => assert.fail('no desktop input'), canPost: () => true, onJester() {},
    assistant: { canResearch: (text) => /^search\b/.test(text || ''), research: async (goal, options) => {
      research.push({ goal, options }); return { handled: false, approvedInteraction: true, goal: 'Read my Canvas assignments' };
    } },
    browser: { claims: async () => true, run: async (...args) => { handed.push(args); return { ok: true, text: 'Friday.' }; } }
  });
  const { outcome } = await runner.run('search for that', { context: 'My assignments' });
  assert.equal(outcome.text, 'Friday.');
  assert.equal(research.length, 1);
  assert.deepEqual(handed, [['Read my Canvas assignments', '', { skipResearch: true }]]);
});
