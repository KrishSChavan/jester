/**
 * A yes or a no on its own, to a question he's just asked, needs no name (2026-11-22, the user: "if he asks me
 * questions that are a yes no answer I should not need a trigger word and a yes or no by themselves should work").
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { asksYou, bareAnswer, createConversation } from '../desktop/src/main/conversation.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ASKS = 'The museum opens at nine. Want me to look up the tickets? It only takes a second.';
const TELLS = 'The museum opens at nine and closes at six.';

function rig({ known = true } = {}) {
  let time = 1000;
  const entries = [];
  const said = [];
  const asked = [];
  const expected = [];
  const assistant = { asking: false, running: false, answers: [], answer: (yes) => assistant.answers.push(yes), confirm: async () => true, cancel: () => undefined };
  const conversation = createConversation({
    // His model, which stays quiet when told the words came without his name and judges them someone else's.
    chat: async (request) => {
      const prompt = JSON.stringify(request);
      asked.push(prompt);
      if (/Said without your name/.test(prompt)) return { forYou: false, say: '', do: '', new: false };
      return { say: asked.length === 1 && /what time/i.test(prompt) ? ASKS : 'Okay, looking them up.', do: '' };
    },
    speaker: { say: async (line) => void said.push(line), stop: () => undefined },
    memory: { add: (who, text) => entries.push({ who, text }), current: () => entries, idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    knowsYou: () => known,
    expecting: (ms) => expected.push(ms),
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: { ok: true, text: 'Done.' } }) },
    assistant,
    show: () => undefined,
    now: () => time
  });
  return { conversation, entries, said, asked, expected, assistant, advance: (ms) => (time += ms), at: () => time };
}
const theirs = (j) => j.entries.filter((entry) => entry.who === 'you').map((entry) => entry.text);

test('what asks: a question in either of his last two sentences, or one begun as a question is', () => {
  for (const line of [ASKS, 'Want me to set it for nine?', 'Should I go ahead and send it', 'I found two. Do you want the first one?', 'Shall I read it to you.', 'Done. Is that okay?'])
    assert.ok(asksYou(line), line);
  for (const line of [TELLS, 'Why would anyone want that? Anyway, it opens at nine. It closes at six.', '', 'I set it for nine.'])
    assert.ok(!asksYou(line), line);
  for (const said of ['Yes.', 'yeah', 'Sure, go ahead', 'Okay', 'Yes please']) assert.equal(bareAnswer(said, ASKS), 'yes', said);
  for (const said of ['No.', 'Nope', 'No, that’s okay.', 'Nah, I’m good', 'not now']) assert.equal(bareAnswer(said, ASKS), 'no', said);
  for (const said of ['yes and what’s the weather', 'Yes?', 'what time is it', 'no but the other one', 'pass me that'])
    assert.equal(bareAnswer(said, ASKS), '', said);
});

test('with a voiceprint: a yes to his question, too short for it to be sure of, is his, with no name', async () => {
  const j = rig();
  await j.conversation.heard('Jester, what time does the museum open?');
  await tick();
  assert.equal(j.said.at(-1), ASKS);
  // The question ends a sentence before his line does: it's waited on as a question, and a word is listened for.
  assert.ok(j.expected.includes(20000), 'a short answer is read for the 20 s he waits');
  const startedAt = j.advance(2500);
  await j.conversation.heard('Yes.', { startedAt, unsure: true });
  assert.equal(theirs(j).at(-1), 'Yes.');
  assert.equal(j.said.at(-1), 'Okay, looking them up.');
  assert.doesNotMatch(j.asked.at(-1), /Said without your name/, 'plainly to him: his model isn’t asked whether it was');
});

test('without a voiceprint: a bare yes or no to his question is his; anything else, or later, still needs his name', async () => {
  const j = rig({ known: false });
  await j.conversation.announce(ASKS);
  await tick();
  await j.conversation.heard('No, that’s okay.', { startedAt: j.advance(1500) });
  assert.equal(theirs(j).at(-1), 'No, that’s okay.');
  assert.equal(j.said.at(-1), 'Okay, looking them up.');

  // More than a yes or a no: someone in the room, as far as he can tell.
  const more = rig({ known: false });
  await more.conversation.announce(ASKS);
  await tick();
  await more.conversation.heard('Yes and can you pass me the salt', { startedAt: more.advance(1500) });
  assert.deepEqual(theirs(more), []);

  // Too late, or after a line that asked nothing: not an answer to anything.
  const late = rig({ known: false });
  await late.conversation.announce(ASKS);
  await tick();
  await late.conversation.heard('Yes.', { startedAt: late.advance(21000) });
  assert.deepEqual(theirs(late), []);
  const told = rig({ known: false });
  await told.conversation.announce(TELLS);
  await tick();
  await told.conversation.heard('Yes.', { startedAt: told.advance(1500) });
  assert.deepEqual(theirs(told), []);

  // Once: the yes answered it, and a second yes is to nothing.
  await j.conversation.heard('Yes.', { startedAt: j.advance(1500) });
  assert.equal(theirs(j).filter((said) => said === 'Yes.').length, 0);
});

test('a yes begun before he’d started asking is no answer to it', async () => {
  const j = rig({ known: false });
  const before = j.advance(0) - 5000;
  await j.conversation.announce(ASKS);
  await tick();
  await j.conversation.heard('Yes.', { startedAt: before });
  assert.deepEqual(theirs(j), []);
});
