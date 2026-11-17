import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { judged, scored, worthLearning } from '../desktop/src/main/voiceprint.js';
import { wakesEarly } from '../desktop/src/main/wake.js';

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
    judged, scored, worthLearning, wakesEarly,
    modelDir: () => '', SPEECH_MODELS: { fake: { kind: 'offline', config: () => ({}) } }, VAD_MODEL: '', VOICE_MODEL: '',
    process: { env: {}, parentPort: { postMessage: (message) => messages.push(message), on: (_name, fn) => { receive = fn; } } },
    performance: { now: () => time }, Date: { now: () => time }, Float32Array, console
  });
  const post = (data) => receive({ data });
  return {
    messages, detectors, post,
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
    assert.equal(decodes, 0);
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
