import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../desktop/src/main/conversation.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const FIRST = 'The museum opens at nine and closes at six in the evening.';

function rig({ known = true, chat, risky = false, allow = true, ring = null } = {}) {
  let time = 1000;
  let release;
  const entries = [];
  const said = [];
  const shown = [];
  const ran = [];
  const questions = [];
  const assistant = { asking: false, running: false, answers: [], answer: (yes) => assistant.answers.push(yes),
    confirm: async (label) => { questions.push(label); return allow; }, cancel: () => undefined };
  const speaker = { stops: 0,
    say: async (line) => { said.push(line); if (line === FIRST) await new Promise((resolve) => { release = resolve; }); },
    stop: () => { speaker.stops++; const resolve = release; release = null; resolve?.(); } };
  const conversation = createConversation({
    chat: chat || (async ({ text }) => ({ say: text === 'first' ? FIRST : 'The answer to your new question.', do: '' })),
    speaker, memory: { add: (who, text) => entries.push({ who, text }), current: () => entries, idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] }, knowsYou: () => known,
    commands: { knows: async () => risky, risky: async () => risky, run: async (text) => { ran.push(text); return { outcome: { ok: true, text: 'Done.' } }; } },
    assistant, ring, show: (voice) => shown.push(voice), now: () => time
  });
  return { conversation, speaker, assistant, entries, said, shown, ran, questions,
    advance: (ms) => { time += ms; return time; },
    start: async () => {
      // An unsolicited spoken line exercises the same playback path as replies.
      const speaking = conversation.announce(FIRST);
      await tick();
      assert.ok(said.includes(FIRST));
      return { speaking };
    } };
}

test('a verified voice stops output at speech activity, then the complete interruption is answered without a wake word', async () => {
  const j = rig();
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt });
  const before = j.speaker.stops;
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  assert.equal(j.speaker.stops, before + 1, 'stops before a final transcript exists');
  assert.equal(j.conversation.speaking, false);
  assert.equal(j.shown.at(-1).start, true);
  await speaking;
  assert.equal(j.shown.at(-1).start, true, 'old playback cleanup leaves the listening state up');
  await j.conversation.heard('Actually, what about the science center?', { startedAt });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'Actually, what about the science center?');
  assert.equal(j.said.at(-1), 'The answer to your new question.');
});

test('without a voiceprint, only "stop" talks over him: his name, other words, raw VAD and playback text do not', async () => {
  const j = rig({ known: false });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  const before = j.speaker.stops;
  j.conversation.hearing({ startedAt });
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'The museum opens at nine' });
  // A television, or his own voice come back garbled: no voiceprint to say whose it is.
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'Actually can we discuss lunch instead' });
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'Jester, can we discuss lunch instead' });
  assert.equal(j.speaker.stops, before);
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'Stop' });
  assert.equal(j.speaker.stops, before + 1);
  await speaking;
  await j.conversation.heard('Stop. Can we discuss lunch instead, maybe somewhere close?', { startedAt });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'Stop. Can we discuss lunch instead, maybe somewhere close?');
});

test('without a voiceprint, an unnamed sentence said across him is let pass, however it ends', async () => {
  const j = rig({ known: false });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt });
  j.speaker.stop();
  await speaking;
  j.advance(2000);
  await j.conversation.heard('What a lovely evening it has been here.', { startedAt });
  assert.deepEqual(j.entries.filter((line) => line.who === 'you'), []);
});

test('a screened interruption can correct a reply even when most of its final words repeat that reply', async () => {
  const j = rig({ known: false });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'Stop' });
  await speaking;
  await j.conversation.heard('Stop, the museum opens at ten and closes at six in the evening.', { startedAt });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'Stop, the museum opens at ten and closes at six in the evening.');
});

test('a short overlapped playback echo cannot approve his own question after the quiet guard expires', async () => {
  const j = rig({ known: false });
  // Hold the normal approval-question playback while its VAD echo starts.
  let release;
  j.speaker.say = async (line) => { j.said.push(line); await new Promise((resolve) => { release = resolve; }); };
  j.assistant.asking = true;
  j.assistant.running = true;
  const question = j.conversation.ask('Allow the action');
  await tick();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt });
  release();
  await question;
  j.advance(2000);
  // "Allow" is a yes, and a word of his own question: heard across it, it's his voice come back.
  await j.conversation.heard('Allow.', { startedAt });
  assert.deepEqual(j.assistant.answers, []);
  // A separate answer after playback is still a valid confirmation.
  await j.conversation.heard('Yes.', { startedAt: j.advance(1000) });
  assert.deepEqual(j.assistant.answers, [true]);
});

test('playback timing catches a short echo even when its first activity event arrives after the reply ended', async () => {
  const j = rig({ known: false });
  let release;
  j.speaker.say = async () => new Promise((resolve) => { release = resolve; });
  j.assistant.asking = true;
  j.assistant.running = true;
  const question = j.conversation.ask('Allow the action');
  await tick();
  const startedAt = j.advance(100);
  release();
  await question;
  j.advance(2000);
  assert.equal(j.conversation.overlapped(startedAt), true);
  await j.conversation.heard('Allow.', { startedAt });
  assert.deepEqual(j.assistant.answers, []);
});

test('an unsure voice or short playback echo cannot cut off a reply', async () => {
  const j = rig({ known: false });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  const before = j.speaker.stops;
  j.conversation.hearing({ startedAt, interrupt: true, verified: false, text: 'museum' });
  j.conversation.hearing({ startedAt, interrupt: true, verified: true, unsure: true, text: 'Something else entirely' });
  assert.equal(j.speaker.stops, before);
  j.conversation.hush();
  await speaking;
});

test('a long interruption retains its original start across heartbeats, playback cleanup and slow transcription', async () => {
  const j = rig();
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  j.advance(65000);
  j.conversation.hearing({ startedAt });
  await j.conversation.heard('Here is the rest of my longer question, including its final words.', { startedAt, unsure: true });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'Here is the rest of my longer question, including its final words.');
});

test('a bare wait stops speech and leaves the microphone open without starting another reply', async () => {
  const j = rig();
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  await j.conversation.heard('Wait.', { startedAt });
  assert.equal(j.said.length, 1);
  assert.equal(j.shown.at(-1).start, true);
  await j.conversation.heard('I want to ask something different.', { startedAt: j.advance(3000) });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'I want to ask something different.');
});

test('stopping a spoken timer alert also leaves him listening for the next sentence', async () => {
  let ringing = true;
  const j = rig({ ring: { ringing: () => ringing, stop: () => { ringing = false; } } });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  await j.conversation.heard('Stop.', { startedAt });
  await speaking;
  assert.equal(ringing, false);
  assert.equal(j.shown.at(-1).start, true);
  await j.conversation.heard('What should we have for lunch?', { startedAt: j.advance(1000) });
  assert.equal(j.entries.filter((line) => line.who === 'you').at(-1).text, 'What should we have for lunch?');
});

test('interrupting a streamed answer aborts it and never waits for or resumes its unfinished remainder', async () => {
  let finishOld;
  let oldSignal;
  const j = rig({ chat: async ({ text, onFirst, signal }) => {
    if (text !== 'first') return { say: 'Your new answer.', do: '' };
    oldSignal = signal;
    onFirst(FIRST);
    return new Promise((resolve) => { finishOld = resolve; });
  } });
  const old = j.conversation.heard('Jester, first');
  await tick();
  assert.equal(j.said[0], FIRST);
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  assert.equal(oldSignal.aborted, true);
  await j.conversation.heard('What should we have for lunch?', { startedAt });
  assert.equal(j.said.at(-1), 'Your new answer.');
  finishOld({ say: FIRST + ' This old remainder must never be spoken.', do: 'open Notes' });
  await old;
  assert.equal(j.said.some((line) => /old remainder/.test(line)), false);
  assert.deepEqual(j.ran, []);
});

test('interrupting an approval question retains its boundary and an unsure yes still cannot approve', async () => {
  const j = rig();
  const { speaking } = await j.start();
  j.assistant.asking = true;
  j.assistant.running = true;
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  await j.conversation.heard('Yes.', { startedAt, unsure: true });
  assert.deepEqual(j.assistant.answers, []);
  await j.conversation.heard('Yes.', { startedAt, unsure: false });
  assert.deepEqual(j.assistant.answers, [true]);
});

test('an interrupted command still asks before a risky action', async () => {
  const j = rig({ risky: true, allow: false });
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  await j.conversation.heard('Quit Safari.', { startedAt });
  assert.deepEqual(j.questions, ['Go ahead and quit Safari']);
  assert.deepEqual(j.ran, []);
});

test('overlap metadata prevents mixed playback from training the user voice after output has stopped', async () => {
  const j = rig();
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt });
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  assert.equal(j.conversation.speaking, false);
  assert.equal(j.conversation.overlapped(startedAt), true);
  j.conversation.reset();
  assert.equal(j.conversation.overlapped(startedAt), false);
});

test('reset clears the interrupted utterance so a late final transcript cannot revive listening', async () => {
  const j = rig();
  const { speaking } = await j.start();
  const startedAt = j.advance(100);
  j.conversation.hearing({ startedAt, interrupt: true, verified: true });
  await speaking;
  j.conversation.reset();
  j.advance(30000);
  await j.conversation.heard('Something that finished after the microphone was closed.', { startedAt });
  assert.deepEqual(j.entries.filter((line) => line.who === 'you'), []);
});
