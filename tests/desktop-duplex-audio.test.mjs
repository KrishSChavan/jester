import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createSpeaker, systemVoice } from '../desktop/src/main/speaker.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function processes() {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdin = { on: () => undefined, end: (text) => { child.text = text; } };
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 1); };
    calls.push({ file, args, child });
    return child;
  };
  return { calls, spawn };
}

test('stopping the native fallback prevents a failed Mac voice from restarting in its default voice', async () => {
  const { calls, spawn } = processes();
  const voice = systemVoice({ platform: 'darwin', spawnImpl: spawn });
  const said = voice.say('Old speech.');
  calls[0].child.emit('exit', 1);
  // Stop in the microtask gap before say() considers trying the default voice.
  voice.stop();
  await said;
  assert.equal(calls.length, 1);
});

test('a newer native line invalidates the previous line even if killing it reports a voice failure', async () => {
  const { calls, spawn } = processes();
  const voice = systemVoice({ platform: 'darwin', spawnImpl: spawn });
  const old = voice.say('Old speech.');
  const newer = voice.say('New speech.');
  assert.equal(calls[0].child.killed, true);
  calls[1].child.emit('exit', 0);
  await Promise.all([old, newer]);
  assert.deepEqual(calls.map(({ child }) => child.text), ['Old speech.', 'New speech.']);
});

test('a genuinely unavailable Mac voice still falls back when nobody has stopped it', async () => {
  const { calls, spawn } = processes();
  const voice = systemVoice({ platform: 'darwin', spawnImpl: spawn });
  const said = voice.say('Say this.');
  calls[0].child.emit('exit', 1);
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-v', 'Daniel']);
  assert.equal(calls[1].args.includes('-v'), false);
  calls[1].child.emit('exit', 0);
  await said;
});

function synthesis() {
  const made = [];
  const played = [];
  const speaker = createSpeaker({
    voice: { sound: (text, { signal }) => new Promise((resolve) => {
      made.push({ text, signal, resolve });
      if (signal.aborted) resolve(null);
      else signal.addEventListener('abort', () => resolve(null), { once: true });
    }) },
    play: async (bytes) => { played.push(bytes); },
    stopPlaying: () => undefined,
    system: { say: async () => assert.fail('cancelled synthesis must never become native fallback'), stop: () => undefined }
  });
  return { speaker, made, played };
}

test('stopping cancels queued prepared speech instead of leaving old synthesis ahead of the new response', async () => {
  const { speaker, made, played } = synthesis();
  speaker.prepare('Old prepared speech.');
  await tick();
  speaker.stop();
  assert.equal(made[0].signal.aborted, true);
  const newer = speaker.say('New response.');
  await tick();
  made[1].resolve({ bytes: new Uint8Array([2]), type: 'audio/wav' });
  await newer;
  assert.deepEqual(played.map((bytes) => [...bytes]), [[2]]);
});

test('a prepared first piece inherits cancellation when its spoken line is interrupted', async () => {
  const { speaker, made, played } = synthesis();
  speaker.prepare('Prepared reply.');
  await tick();
  const said = speaker.say('Prepared reply.');
  speaker.stop();
  await said;
  assert.equal(made.length, 1, 'the prepared synthesis was reused');
  assert.equal(made[0].signal.aborted, true);
  assert.deepEqual(played, []);
});

test('replacing unused prepared speech cancels it instead of blocking later synthesis', async () => {
  const { speaker, made } = synthesis();
  speaker.prepare('Old prepared reply.');
  await tick();
  speaker.prepare('New prepared reply.');
  await tick();
  assert.equal(made[0].signal.aborted, true);
  assert.equal(made[1].signal.aborted, false);
  speaker.stop();
});

async function voicePage() {
  const requested = [];
  const reports = [];
  const sounds = [];
  let receive;
  const track = { label: 'Synthetic mic', stop: () => undefined };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    audioWorklet = { addModule: async () => undefined };
    destination = {};
    createMediaStreamSource() { return { connect: () => undefined }; }
    async resume() {}
    async close() {}
  }
  class Worklet { port = {}; connect() {} }
  class Sound {
    paused = false;
    constructor() { sounds.push(this); }
    async play() {}
    pause() { this.paused = true; this.onpause?.(); }
  }
  const sandbox = vm.createContext({
    window: { jesterVoice: { audio: () => undefined, status: (report) => reports.push(report), onPlay: (callback) => { receive = callback; } } },
    navigator: { mediaDevices: { getUserMedia: async (constraints) => { requested.push(constraints); return stream; }, addEventListener: () => undefined } },
    AudioContext: Context, AudioWorkletNode: Worklet, Audio: Sound, Blob,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => undefined },
    setTimeout, clearTimeout
  });
  vm.runInContext(await readFile(new URL('../desktop/src/voice/voice.js', import.meta.url), 'utf8'), sandbox);
  await tick();
  return { requested, reports, sounds, receive };
}

test('the continuous microphone requests echo cancellation while keeping other recognition processing unchanged', async () => {
  const { requested } = await voicePage();
  assert.equal(requested.length, 1);
  assert.equal(requested[0].audio.echoCancellation, true);
  assert.equal(requested[0].audio.noiseSuppression, false);
  assert.equal(requested[0].audio.autoGainControl, false);
  assert.equal(requested[0].audio.channelCount, 1);
  assert.equal(requested[0].video, false);
});

test('voice-page stop pauses audio, and an old completion cannot prevent the next line from being stopped', async () => {
  const { receive, sounds, reports } = await voicePage();
  receive({ id: 1, bytes: new Uint8Array([1]), type: 'audio/wav' });
  receive({ stop: true });
  assert.equal(sounds[0].paused, true);
  assert.ok(reports.some((report) => report.ended === 1));
  receive({ id: 2, bytes: new Uint8Array([2]), type: 'audio/wav' });
  sounds[0].onended();
  receive({ stop: true });
  assert.equal(sounds[1].paused, true);
  assert.ok(reports.some((report) => report.ended === 2));
});
