import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice, MIC } from '../jester-extension/src/offscreen/voice.js';
import { mergeSettings } from '../jester-extension/src/common/constants.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function flush() { await new Promise((resolve) => setImmediate(resolve)); }
function result(text, final = true) {
  return { resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] };
}
function setup({ available = 'available', microphone, support = true } = {}) {
  const scheduled = new Map();
  let nextTimer = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++nextTimer; scheduled.set(id, { fn, ms }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; scheduled.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { scheduled.delete(id); }
  };
  let stops = 0;
  let microphoneRequests = 0;
  const stream = { getTracks: () => [{ stop: () => stops++ }] };
  const instances = [];
  class Recognition {
    static requests = [];
    static async available(options) { this.requests.push(options); return available; }
    constructor() { if (support) this.processLocally = false; instances.push(this); }
    start() { this.started = true; this.onstart?.(); }
    abort() { this.aborted = true; }
    stop() { this.stopped = true; }
  }
  const commands = [];
  const statuses = [];
  const transcripts = [];
  const completions = [];
  const voice = createVoice({
    Recognition,
    mediaDevices: { getUserMedia: () => { microphoneRequests++; return microphone || Promise.resolve(stream); } },
    permissions: { query: async () => ({ state: 'granted' }) },
    AudioContextImpl: null, timers,
    onCommand: (command) => commands.push(command),
    onStatus: (status) => statuses.push(status),
    onTranscript: (transcript) => transcripts.push(transcript),
    onComplete: (completion) => completions.push(completion)
  });
  return {
    voice, Recognition, instances, commands, statuses, transcripts, completions,
    stream, scheduled,
    get stops() { return stops; }, get microphoneRequests() { return microphoneRequests; }
  };
}

test('capture requires local support and a preinstalled language before opening a microphone', async () => {
  for (const configuration of [{ support: false }, { available: 'downloadable' }, { available: 'unavailable' }]) {
    const fixture = setup(configuration);
    await fixture.voice.start();
    assert.equal(fixture.microphoneRequests, 0);
    assert.equal(fixture.voice.active, false);
    assert.equal(fixture.statuses.at(-1).state, MIC.ERROR);
    assert.equal(fixture.scheduled.size, 0);
  }
});

test('capture uses only local recognition and interim speech never executes', async () => {
  const fixture = setup();
  await fixture.voice.start({ language: 'en-US' });
  const engine = fixture.instances.at(-1);
  assert.equal(engine.processLocally, true);
  assert.equal(engine.continuous, false);
  assert.deepEqual(fixture.Recognition.requests, [{ langs: ['en-US'], processLocally: true }]);
  engine.onresult(result('click', false));
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(fixture.transcripts, [{ text: 'click', final: false }]);
  fixture.voice.stop();
  assert.deepEqual(fixture.commands, []);
});

test('a finalized utterance executes once and stale recognition callbacks are ignored', async () => {
  const fixture = setup();
  await fixture.voice.start();
  const engine = fixture.instances.at(-1);
  const lateResult = engine.onresult;
  engine.onresult(result('  click   that  '));
  lateResult(result('click that'));
  assert.deepEqual(fixture.commands, [{ text: 'click that' }]);
  assert.equal(fixture.voice.active, false);
  assert.equal(fixture.stops, 1);
  assert.equal(engine.aborted, true);
  assert.equal(fixture.scheduled.size, 0);
});

test('cancelling an opening capture releases a microphone that resolves later', async () => {
  const pending = deferred();
  const fixture = setup({ microphone: pending.promise });
  const opening = fixture.voice.start();
  await flush();
  assert.equal(fixture.microphoneRequests, 1);
  fixture.voice.stop();
  pending.resolve(fixture.stream);
  await opening;
  assert.equal(fixture.stops, 1);
  assert.equal(fixture.voice.active, false);
  assert.equal(fixture.instances.filter((engine) => engine.started).length, 0);
  assert.deepEqual(fixture.commands, []);
});

test('repeating the capture gesture requests a final result without submitting interim text', async () => {
  const fixture = setup();
  await fixture.voice.start();
  const engine = fixture.instances.at(-1);
  engine.onresult(result('go back', false));
  fixture.voice.finish();
  assert.equal(engine.stopped, true);
  assert.deepEqual(fixture.commands, []);
  engine.onresult(result('go back'));
  assert.deepEqual(fixture.commands, [{ text: 'go back' }]);
  assert.equal(fixture.scheduled.size, 0);
});

test('capture timeout releases microphone and discards incomplete speech', async () => {
  const fixture = setup();
  await fixture.voice.start();
  fixture.instances.at(-1).onresult(result('unfinished task', false));
  const deadline = [...fixture.scheduled.values()].find(({ ms }) => ms === 30000);
  deadline.fn();
  assert.equal(fixture.voice.active, false);
  assert.equal(fixture.stops, 1);
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.scheduled.size, 0);
});

test('shipped pointing bindings migrate to command capture, custom bindings survive, toggles cannot repeat', () => {
  const settings = mergeSettings({
    pointerTolerance: .4,
    bindings: { Pointing_Up: { action: 'SKIP_AD', repeat: false }, Victory: { action: 'SLEEP', repeat: true } },
    windowedBindings: { Pointing_Up: { action: 'RELOAD', repeat: false } }
  });
  assert.equal(settings.bindings.Pointing_Up.action, 'VOICE_CAPTURE_TOGGLE');
  assert.equal(settings.windowedBindings.Pointing_Up.action, 'RELOAD');
  assert.equal(settings.bindings.Victory.repeat, false);
  assert.equal(settings.pointerTolerance, undefined);
  assert.equal(settings.pointerInput, 'eyes-head');
  assert.equal(settings.voiceEnabled, true);
});
