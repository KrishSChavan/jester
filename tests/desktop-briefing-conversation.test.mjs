import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingReply, createConversation } from '../desktop/src/main/conversation.js';

const OFFER = 'I have your morning briefing. Would you like me to read it?';
const BODY = `${'Your calendar lists a project meeting. '.repeat(18)}The final item is your evening deadline.`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function rig({ hold = '', fail = false, known = false } = {}) {
  let at = 1000, release;
  const spoken = [], entries = [], reads = [], responses = [], completed = [], interrupted = [];
  const card = { kind: 'brief', id: 'b1', title: 'Morning briefing', offer: true, status: 'offered' };
  const made = () => ({ text: BODY, briefingId: 'b1', readToken: 'r1', card: { ...card, offer: false, status: 'reading' }, untrusted: true });
  const conversation = createConversation({
    chat: async () => ({ say: 'A new conversation.', do: '' }),
    speaker: { say: async (text) => {
      spoken.push(text);
      if (fail && text === BODY) throw new Error('Playback failed');
      if ((hold === 'offer' && text === OFFER) || (hold === 'body' && text === BODY)) await new Promise((resolve) => { release = resolve; });
    }, stop: () => { const done = release; release = null; done?.(); } },
    memory: { add: (who, text, more = {}) => entries.push({ who, text, ...more }), current: () => entries.slice(), idleFor: () => null,
      startNew: () => [], clear: () => { entries.length = 0; } },
    recollections: { keep: async () => {}, relevant: () => [], forget() {} },
    commands: { knows: async () => false, risky: async () => false, run: async () => assert.fail('briefings must not use computer controls') },
    assistant: { asking: false, running: false, cancel() {} }, show() {}, knowsYou: () => known, now: () => at,
    briefs: { asked: (text) => /morning briefing/.test(text) ? 'morning' : '', compose: async () => made(),
      read: async (id) => { reads.push(id); return made(); }, respond: async (id, op) => responses.push({ id, op }),
      given: async (kind, record) => completed.push({ kind, id: record.briefingId }), interrupted: async (record) => interrupted.push(record?.briefingId) }
  });
  return { conversation, spoken, entries, reads, responses, completed, interrupted,
    advance: (ms) => (at += ms), offer: (written = false) => conversation.announce(OFFER, { written, card }) };
}

test('a scheduled offer announces availability without reading the briefing', async () => {
  const j = rig();
  await j.offer();
  assert.deepEqual(j.spoken, [OFFER]);
  assert.deepEqual(j.reads, []);
  assert.deepEqual(j.completed, []);
  assert.equal(j.entries[0].card.offer, true);
});

test('a spoken yes needs no wake word and reads the whole saved briefing beyond the normal speech limit', async () => {
  const j = rig();
  await j.offer();
  await j.conversation.heard('yes', { startedAt: j.advance(2000) });
  assert.deepEqual(j.reads, ['b1']);
  assert.equal(j.spoken.at(-1), BODY);
  assert.ok(j.spoken.at(-1).endsWith('The final item is your evening deadline.'));
  assert.deepEqual(j.completed, [{ kind: null, id: 'b1' }]);
});

test('yes spoken over the offer, in a voice the voiceprint knows, interrupts it and starts its saved briefing exactly once', async () => {
  const j = rig({ hold: 'offer', known: true });
  const announcing = j.offer();
  await tick();
  await j.conversation.heard('yes', { startedAt: j.advance(100) });
  await announcing;
  assert.deepEqual(j.reads, ['b1']);
  assert.equal(j.completed.length, 1);
});

test('Later and Dismiss replies affect the offered briefing without reading it', async () => {
  for (const [words, op] of [['not now', 'later'], ['no thanks', 'dismiss']]) {
    const j = rig();
    await j.offer(true);
    await j.conversation.told(words, { typed: true });
    assert.deepEqual(j.responses, [{ id: 'b1', op }]);
    assert.deepEqual(j.reads, []);
    assert.deepEqual(j.completed, []);
  }
});

test('a new request, expired reply window, or reset cannot become consent to read', async () => {
  for (const reason of ['new-topic', 'expired', 'reset']) {
    const j = rig();
    await j.offer(true);
    if (reason === 'new-topic') await j.conversation.told('hello there', { typed: true });
    if (reason === 'expired') j.advance(120001);
    if (reason === 'reset') j.conversation.reset();
    await j.conversation.told('yes', { typed: true });
    assert.deepEqual(j.reads, [], reason);
  }
});

test('the Read button speaks even when continuous listening is off', async () => {
  const j = rig();
  await j.conversation.readBriefing('b1');
  assert.deepEqual(j.reads, ['b1']);
  assert.equal(j.spoken.at(-1), BODY);
  assert.equal(j.completed.length, 1);
});

test('a specific briefing request reads directly without asking for consent again', async () => {
  const j = rig();
  await j.conversation.told('read my morning briefing');
  assert.deepEqual(j.spoken, [BODY]);
  assert.deepEqual(j.completed, [{ kind: 'morning', id: 'b1' }]);
});

test('an interrupted or failed full reading cannot mark a briefing as read', async () => {
  const interrupted = rig({ hold: 'body' });
  const reading = interrupted.conversation.readBriefing('b1');
  await tick();
  await interrupted.conversation.heard('stop', { startedAt: interrupted.advance(100) });
  await reading;
  assert.deepEqual(interrupted.completed, []);
  assert.deepEqual(interrupted.interrupted, ['b1']);
  const failed = rig({ fail: true });
  await failed.conversation.readBriefing('b1');
  assert.deepEqual(failed.completed, []);
  assert.deepEqual(failed.interrupted, ['b1']);
});

test('only direct consent replies are accepted; questions and unrelated actions are not yes', () => {
  for (const text of ['Yes, please', 'read it', 'play my briefing']) assert.equal(briefingReply(text), 'read', text);
  for (const text of ['later', 'in ten minutes']) assert.equal(briefingReply(text), 'later', text);
  for (const text of ['dismiss it', 'no thanks']) assert.equal(briefingReply(text), 'dismiss', text);
  for (const text of ['yes but what is in it?', 'read the page', 'okay open my calendar']) assert.equal(briefingReply(text), '', text);
});
