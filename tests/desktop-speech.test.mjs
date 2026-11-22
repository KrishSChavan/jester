import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { judged, scored, worthLearning } from '../desktop/src/main/voiceprint.js';
import { named, wakesEarly } from '../desktop/src/main/wake.js';

const RATE = 16000;
const WINDOW = 512;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual service with deterministic audio/detectors and no Electron or
// model downloads. The fake detector includes sherpa's shorter endpoint after
// maxSpeechDuration; resetting/replaying must preserve the real silence timing.
function service({ decode = async () => ({ text: 'Jester, the whole response.' }), voice = null, voiceReady = true } = {}) {
  let receive;
  let time = 100000;
  const messages = [];
  const detectors = [];
  class Vad {
    constructor({ sileroVad }) { this.config = sileroVad; this.resets = 0; this.reset(); detectors.push(this); }
    reset() { this.resets++; this.detected = false; this.voiced = 0; this.quiet = 0; this.length = 0; this.segments = 0; }
    acceptWaveform(samples) {
      this.length += samples.length;
      const long = this.length / RATE > this.config.maxSpeechDuration;
      const speech = samples[0] > (long ? 0.9 : this.config.threshold);
      if (speech) {
        this.voiced += samples.length;
        this.quiet = 0;
        if (this.voiced / RATE >= this.config.minSpeechDuration) this.detected = true;
      } else {
        this.voiced = 0;
        this.quiet += samples.length;
        if (this.detected && this.quiet / RATE >= (long ? 0.1 : this.config.minSilenceDuration)) {
          this.segments++;
          this.detected = false;
          this.length = 0;
        }
      }
    }
    isDetected() { return this.detected; }
    isEmpty() { return !this.segments; }
    pop() { this.segments--; }
    flush() { if (this.detected) this.segments++; this.detected = false; }
  }
  class OfflineRecognizer {
    createStream() { return { acceptWaveform: (wave) => { this.wave = wave; } }; }
    decodeAsync(stream) { return decode(stream); }
  }
  class SpeakerEmbeddingExtractor {
    createStream() { return { acceptWaveform() {}, inputFinished() {} }; }
    isReady() { return typeof voiceReady === 'function' ? voiceReady() : voiceReady; }
    compute() { return Float32Array.from(typeof voice === 'function' ? voice() : voice); }
  }
  const source = fs.readFileSync(new URL('../desktop/src/main/speech/service.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('import.meta.url', "'file:///speech/service.js'");
  vm.runInNewContext(source, {
    fs: { existsSync: () => voice !== null }, path: {},
    createRequire: () => () => ({ Vad, OfflineRecognizer, SpeakerEmbeddingExtractor }),
    judged, scored, worthLearning, named, wakesEarly,
    modelDir: () => '', SPEECH_MODELS: { fake: { kind: 'offline', config: () => ({}) } }, VAD_MODEL: '', VOICE_MODEL: '',
    process: { env: {}, parentPort: { postMessage: (message) => messages.push(message), on: (_name, fn) => { receive = fn; } } },
    performance: { now: () => time }, Date: { now: () => time }, Float32Array, console
  });
  const post = (data) => receive({ data });
  return {
    messages, detectors, post,
    /** How long the harness has run, in seconds: for a decode that answers by what's been said so far. */
    seconds: () => (time - 100000) / 1000,
    /** A decode that takes this long on the harness's clock. */
    spend: (ms) => { time += ms; },
    async feed(seconds, level = 0.7) {
      for (let frames = Math.round(seconds * RATE / WINDOW); frames > 0; frames--) {
        time += WINDOW / RATE * 1000;
        await post({ type: 'audio', samples: new Float32Array(WINDOW).fill(level) });
      }
      await flush();
    }
  };
}

test('continuous speech passes the old 20/30 second cutoffs and is submitted once after silence', async () => {
  const s = service();
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.feed(50);
  assert.equal(s.messages.filter((m) => m.type === 'heard').length, 0);
  assert.ok(s.detectors.every((vad) => vad.resets >= 4));
  const start = s.messages.find((m) => m.type === 'speech').startedAt;
  const ongoing = s.messages.filter((m) => m.type === 'activity');
  assert.ok(ongoing.length >= 45);
  assert.ok(ongoing.every((m) => m.startedAt === start));
  await s.feed(0.45, 0);
  assert.equal(s.messages.filter((m) => m.type === 'heard').length, 0, 'a normal mid-sentence breath is still allowed');
  await s.feed(0.3, 0);
  const heard = s.messages.filter((m) => m.type === 'heard');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].startedAt, start);
  assert.ok(heard[0].seconds >= 50);
  assert.equal(s.messages.some((m) => m.type === 'error'), false);
});

test('a voice that never pauses (a television, music) is cut at a minute, not held and decoded whole', async () => {
  const s = service();
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.feed(65);
  const heard = s.messages.filter((m) => m.type === 'heard');
  assert.equal(heard.length, 1);
  assert.ok(heard[0].seconds >= 59 && heard[0].seconds <= 62, String(heard[0].seconds));
});

test('a breath across a detector refresh stays part of the same utterance', async () => {
  const s = service();
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.feed(10.1);
  await s.feed(0.45, 0);
  await s.feed(25);
  assert.equal(s.messages.some((m) => m.type === 'heard'), false);
  await s.feed(0.7, 0);
  assert.equal(s.messages.filter((m) => m.type === 'heard').length, 1);
  assert.ok(s.messages.find((m) => m.type === 'heard').seconds > 35);
});

test('listening reset discards the result of an older decode', async () => {
  let finish;
  const s = service({ decode: () => new Promise((resolve) => { finish = resolve; }) });
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.post({ type: 'teaching', on: true }); // No wake peeks or speculative decodes.
  await s.feed(1);
  await s.feed(0.7, 0);
  await s.post({ type: 'listen' });
  finish({ text: 'Jester, something from before the reset.' });
  await flush();
  assert.equal(s.messages.some((m) => m.type === 'heard'), false);
});

test('the enrolled speaker can interrupt before an endpoint without losing their utterance', async () => {
  const s = service({ voice: [1, 0] });
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'voiceprint', print: [1, 0] });
  await s.post({ type: 'listen' });
  await s.post({ type: 'speaking', on: true });
  await s.feed(0.8);
  const interrupted = s.messages.filter((m) => m.interrupt);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].type, 'activity');
  assert.equal(interrupted[0].verified, true);
  assert.equal(interrupted[0].unsure, false);
  assert.ok(interrupted[0].seconds < 0.9);
  assert.equal(interrupted[0].text, undefined, 'verified speech does not wait for recognition');
  assert.equal(s.messages.some((m) => m.type === 'heard'), false);
  await s.post({ type: 'speaking', on: false });
  await s.feed(2);
  await s.feed(0.7, 0);
  const heard = s.messages.find((m) => m.type === 'heard');
  assert.equal(heard.startedAt, interrupted[0].startedAt);
  assert.ok(heard.seconds > 2.5, 'the whole incoming utterance remains available');
});

test('raw VAD and an uncertain or other speaker never request a verified interruption', async () => {
  for (const voice of [[0, 1], [0.37, Math.sqrt(1 - 0.37 ** 2)]]) {
    let decodes = 0;
    const s = service({ voice, decode: async () => { decodes++; return { text: 'Other words.' }; } });
    await s.post({ type: 'start', model: 'fake' });
    await s.post({ type: 'voiceprint', print: [1, 0] });
    await s.post({ type: 'listen' });
    await s.post({ type: 'speaking', on: true });
    await s.feed(0.8);
    assert.equal(s.messages.some((m) => m.type === 'speech'), true);
    assert.equal(s.messages.some((m) => m.interrupt), false);
    assert.equal(decodes, 0, 'early checks do not decode another speaker');
  }
});

test('without a voiceprint, actual partial words are screened by the conversation and keep updating', async () => {
  let decodes = 0;
  const s = service({ decode: async () => ({ text: ++decodes === 1 ? 'The answer is long.' : 'Wait, I meant tomorrow.' }) });
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.post({ type: 'speaking', on: true });
  await s.feed(0.8);
  const first = s.messages.find((m) => m.interrupt);
  assert.equal(first.verified, false);
  assert.equal(first.unsure, false);
  assert.equal(first.text, 'The answer is long.');
  await s.feed(0.6);
  const later = s.messages.filter((m) => m.interrupt);
  assert.ok(later.length >= 2, 'an initial playback echo does not exhaust interruption detection');
  assert.equal(later.at(-1).text, 'Wait, I meant tomorrow.');
  assert.equal(later.at(-1).startedAt, first.startedAt);
  assert.equal(s.messages.some((m) => m.type === 'heard'), false);
});

test('interruption probes stay off outside playback and while teaching', async () => {
  for (const teaching of [false, true]) {
    let decodes = 0;
    const s = service({ decode: async () => { decodes++; return { text: 'Words.' }; } });
    await s.post({ type: 'start', model: 'fake' });
    await s.post({ type: 'listen' });
    await s.post({ type: 'speaking', on: teaching });
    await s.post({ type: 'teaching', on: teaching });
    await s.feed(0.8);
    assert.equal(s.messages.some((m) => m.interrupt), false);
    // Outside playback the only reading is the look for his name; teaching, there's none at all.
    if (teaching) assert.equal(decodes, 0);
    else assert.ok(decodes >= 1 && decodes <= 3, `${decodes} looks`);
  }
});

test('late interruption transcripts are suppressed after playback ends or listening restarts', async () => {
  for (const reset of [{ type: 'speaking', on: false }, { type: 'listen' }]) {
    let finish;
    const s = service({ decode: () => new Promise((resolve) => { finish = resolve; }) });
    await s.post({ type: 'start', model: 'fake' });
    await s.post({ type: 'listen' });
    await s.post({ type: 'speaking', on: true });
    await s.feed(0.8);
    assert.equal(typeof finish, 'function');
    await s.post(reset);
    finish({ text: 'Wait, a newer request.' });
    await flush();
    assert.equal(s.messages.some((m) => m.interrupt), false);
  }
});

function speechHost() {
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const children = [];
  const sent = [];
  const fork = () => {
    const child = new EventEmitter();
    child.postMessage = (message) => sent.push(message);
    child.kill = () => {};
    children.push(child);
    return child;
  };
  let time = 1000;
  const source = fs.readFileSync(new URL('../desktop/src/main/speech.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export function startSpeech', 'function startSpeech')
    .replace('import.meta.url', "'file:///speech.js'");
  const host = vm.runInNewContext(`${source}\nstartSpeech()`, {
    app: new EventEmitter(), ipcMain, utilityProcess: { fork }, path: { dirname: () => '', join: (...p) => p.join('/') },
    fileURLToPath: () => '', pickModel: () => 'fake', SPEECH_CHOICES: [], isInstalled: () => true,
    Date: { now: () => time }, setTimeout: () => 1, clearTimeout: () => {},
  });
  return { host, sent, children, send: (message) => children.at(-1).emit('message', message), pass: (ms) => { time += ms; } };
}

test('speech activity remains busy during a long answer and older results cannot clear it', () => {
  const s = speechHost();
  const activity = [];
  s.host.listen(() => {}, () => {}, () => {}, (message) => activity.push(message));
  s.send({ type: 'speech', startedAt: 1000 });
  for (let n = 0; n < 45; n++) {
    s.pass(1000);
    s.send({ type: 'activity', startedAt: 1000 });
    assert.equal(s.host.hearing, true);
  }
  s.send({ type: 'heard', text: 'Previous utterance', score: null, startedAt: 500 });
  assert.equal(s.host.hearing, true);
  s.send({ type: 'ended', startedAt: 1000 });
  assert.equal(s.host.hearing, false);
  assert.equal(activity.length, 46);
  s.send({ type: 'speech', startedAt: 47000 });
  s.pass(10001);
  assert.equal(s.host.hearing, false, 'a lost mic cannot hold it busy forever');
});

test('speech host forwards interruption metadata and remembers playback across service reloads', () => {
  const s = speechHost();
  const activity = [];
  s.host.setSpeaking(true);
  s.host.listen(() => {}, () => {}, () => {}, (message) => activity.push(message));
  assert.equal(s.sent.find((m) => m.type === 'speaking').on, true);
  const was = s.sent.length;
  s.host.setSpeaking(true);
  assert.equal(s.sent.length, was, 'repeated speaking frames do not send extra updates');
  s.send({ type: 'activity', startedAt: 1000, interrupt: true, verified: true, score: 0.8, seconds: 0.65 });
  assert.equal(activity.at(-1).interrupt, true);
  assert.equal(activity.at(-1).verified, true);
  assert.equal(s.host.hearing, true);
  s.children.at(-1).emit('exit', 0);
  s.host.listen(() => {}, () => {}, () => {}, (message) => activity.push(message));
  assert.equal(s.children.length, 2);
  assert.equal(s.sent.filter((m) => m.type === 'speaking').at(-1).on, true);
  s.host.setSpeaking(false);
  assert.equal(s.sent.filter((m) => m.type === 'speaking').at(-1).on, false);
});

test('his name is heard the moment it’s said, wherever in the sentence: looked for a few times a second, and told once', async () => {
  // 2026-11-21: "the listening animation is only shown after my whole sentence is complete". The start of an
  // utterance was read twice, and only a name that came first counted.
  let looks = 0;
  let s;
  // What the recognizer makes of the last couple of seconds: his name comes three seconds in.
  s = service({ decode: async () => (looks++, { text: s.seconds() >= 3 ? 'so I was thinking, Jester, can you' : 'so I was thinking' }) });
  await s.post({ type: 'start', model: 'fake' });
  await s.post({ type: 'listen' });
  await s.feed(2.9);
  assert.equal(s.messages.some((m) => m.type === 'wake'), false);
  assert.ok(looks >= 8 && looks <= 12, `looked ${looks} times in under three seconds`);
  await s.feed(0.4);
  const wakes = s.messages.filter((m) => m.type === 'wake');
  assert.equal(wakes.length, 1, 'within a look or two of his name');
  assert.equal(wakes[0].startedAt, s.messages.find((m) => m.type === 'speech').startedAt);
  const after = looks;
  await s.feed(3);
  assert.equal(s.messages.filter((m) => m.type === 'wake').length, 1, 'told once');
  assert.equal(looks, after, 'and not looked for again in the same breath');
});

test('named first, he’s woken by the first look; words that stand for his name count only from the start', async () => {
  const first = service({ decode: async () => ({ text: 'Jester, what' }) });
  await first.post({ type: 'start', model: 'fake' });
  await first.post({ type: 'listen' });
  await first.feed(0.7);
  assert.equal(first.messages.filter((m) => m.type === 'wake').length, 1, 'well inside the first second');
  // "Just open Spotify" is how some voices' "Jester, open Spotify" is written: from the start, it's him.
  const just = service({ decode: async () => ({ text: 'Just open Spotify' }) });
  await just.post({ type: 'start', model: 'fake' });
  await just.post({ type: 'listen' });
  await just.feed(1.2);
  assert.equal(just.messages.filter((m) => m.type === 'wake').length, 1);
  // Further in, only his own name: "…and I just open Spotify" is talk.
  let late;
  late = service({ decode: async () => ({ text: late.seconds() > 3.5 ? 'and then I just open Spotify' : 'and then I' }) });
  await late.post({ type: 'start', model: 'fake' });
  await late.post({ type: 'listen' });
  await late.feed(6);
  assert.equal(late.messages.some((m) => m.type === 'wake'), false);
});

test('a voice that isn’t the user’s is never read for his name, and a slow computer looks less often', async () => {
  let decoded = 0;
  // A voiceprint set, and the voice heard nothing like it.
  const stranger = service({ voice: [0, 1, 0], decode: async () => (decoded++, { text: 'Jester, open the door' }) });
  await stranger.post({ type: 'start', model: 'fake' });
  await stranger.post({ type: 'voiceprint', print: [1, 0, 0] });
  await stranger.post({ type: 'listen' });
  await stranger.feed(3);
  assert.equal(decoded, 0, 'not a word of it was decoded');
  assert.equal(stranger.messages.some((m) => m.type === 'wake'), false);
  // Each look taking 400 ms: the next comes no sooner than twice that after.
  let looks = 0;
  let slow;
  slow = service({ decode: async () => (looks++, slow.spend(400), { text: 'nothing of his in this' }) });
  await slow.post({ type: 'start', model: 'fake' });
  await slow.post({ type: 'listen' });
  await slow.feed(6);
  assert.ok(looks >= 5 && looks <= 8, `looked ${looks} times in six seconds, where a quick one looks twenty`);
  // While teaching him their voice, nothing is looked for.
  let taught = 0;
  const teaching = service({ decode: async () => (taught++, { text: 'Jester' }) });
  await teaching.post({ type: 'start', model: 'fake' });
  await teaching.post({ type: 'listen' });
  await teaching.post({ type: 'teaching', on: true });
  await teaching.feed(3);
  assert.equal(taught, 0);
});

test('while he waits on an answer, a word too short for the voiceprint is read all the same; never his own voice dying away, a long clip or a far-off voice', async () => {
  // 2026-11-21: the user's own bare yeses scored 0.26 to 0.44 against their voiceprint. Below 0.35 they were never
  // read, so no spoken yes to a question of his could count.
  const low = [0.3, Math.sqrt(1 - 0.3 ** 2)];
  const run = async ({ voice = low, before = async () => undefined, seconds = 0.6 } = {}) => {
    let decodes = 0;
    const s = service({ voice, decode: async () => (decodes++, { text: 'Yes.' }) });
    await s.post({ type: 'start', model: 'fake' });
    await s.post({ type: 'voiceprint', print: [1, 0] });
    await s.post({ type: 'listen' });
    await before(s);
    await s.feed(seconds);
    await s.feed(1.2, 0);
    return { heard: s.messages.find((m) => m.type === 'heard'), stranger: s.messages.some((m) => m.type === 'stranger'), decodes };
  };
  const unasked = await run();
  assert.equal(unasked.heard, undefined);
  assert.equal(unasked.stranger, true);
  assert.equal(unasked.decodes, 0, 'not read at all');
  const asked = await run({ before: (s) => s.post({ type: 'awaiting', ms: 60000 }) });
  assert.equal(asked.heard?.text, 'Yes.');
  assert.equal(asked.heard.unsure, true, 'as a voice that may be theirs: whoever asked says what it’s worth');
  // No longer awaited.
  const over = await run({ before: async (s) => { await s.post({ type: 'awaiting', ms: 60000 }); await s.post({ type: 'awaiting', ms: 0 }); } });
  assert.equal(over.decodes, 0);
  // On his last word, as answers come: read.
  const eager = await run({ before: async (s) => { await s.post({ type: 'awaiting', ms: 60000 }); await s.post({ type: 'speaking', on: true }); await s.post({ type: 'speaking', on: false }); } });
  assert.equal(eager.heard?.text, 'Yes.');
  // Under most of a sentence of his: that could be him.
  const under = await run({ before: async (s) => { await s.post({ type: 'awaiting', ms: 60000 }); await s.post({ type: 'speaking', on: true }); await s.feed(1); await s.post({ type: 'speaking', on: false }); }, seconds: 0.2 });
  assert.equal(under.heard, undefined);
  assert.equal(under.decodes, 0);
  // More than a word or two, or nothing like their voice.
  const long = await run({ before: (s) => s.post({ type: 'awaiting', ms: 60000 }), seconds: 4 });
  assert.equal(long.heard, undefined);
  const far = await run({ voice: [0.1, Math.sqrt(1 - 0.1 ** 2)], before: (s) => s.post({ type: 'awaiting', ms: 60000 }) });
  assert.equal(far.heard, undefined);
  assert.equal(far.decodes, 0);
});

test('the speech host tells the service how long an answer is awaited, and when it no longer is', () => {
  const s = speechHost();
  s.host.listen(() => {}, () => {}, () => {}, () => {});
  s.host.expect(60000);
  s.host.expect(0);
  s.host.expect(-5);
  assert.deepEqual(s.sent.filter((m) => m.type === 'awaiting').map((m) => m.ms), [60000, 0, 0]);
});
