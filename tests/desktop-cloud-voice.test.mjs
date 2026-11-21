import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudLink, parseCloudLink } from '../desktop/src/main/cloud-link.js';
import { createSpeaker } from '../desktop/src/main/speaker.js';
import { createRemoteVoice, createRemoteVoicePage, createWebGateway } from '../desktop/src/main/web-gateway.js';

const KEY = 'cloud-voice-test-key-0123';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
};
const wav = (who, text) => new Uint8Array(Buffer.from(`${who}:${text}`));
const said = (bytes) => Buffer.from(bytes).toString();

/**
 * His brain on a server (gateway, voice page, speaker) and a Mac (cloud link) being talked to, over a real socket.
 * `mac`: how the Mac makes his voice (null: it has none); `server`: the server's own voice.
 */
async function rig(t, { mac = null, state = 'ready', voiceState = () => state, voiceLoaded = () => true, serverVoice = 'george', playMs = 5 } = {}) {
  let page;
  const gateway = createWebGateway({ key: KEY, port: 0, onMessage: async () => null, onStorage: async () => null, onVoiceStatus: (report) => page.status(report) });
  page = createRemoteVoicePage(gateway);
  const port = await gateway.ready;
  const madeHere = [];
  const local = {
    warmed: 0,
    warm() {
      this.warmed += 1;
    },
    async sound(text) {
      madeHere.push(text);
      await wait(20);
      return { bytes: wav('server', text), type: 'audio/wav', seconds: text.length * 0.06, tookMs: 20 + text.length * 30 };
    }
  };
  const voice = createRemoteVoice(gateway, local, { voice: () => serverVoice });
  const lines = [];
  const speaker = createSpeaker({ voice, play: (bytes, type, options) => page.play(bytes, type, options), stopPlaying: () => page.stop(), system: { say: async () => undefined, stop: () => undefined }, log: (...words) => lines.push(words.join(' ')) });

  const played = [];
  const asked = [];
  const warmed = [];
  const link = createCloudLink({
    link: parseCloudLink(`http://127.0.0.1:${port}/?key=${KEY}`),
    onVoice: () => undefined,
    onPlay: (sound) => {
      if (sound.stop) return;
      played.push(said(sound.bytes));
      setTimeout(() => link.status({ ended: sound.id }), playMs);
    },
    handsState: () => ({ running: false, asking: false, abilities: {} }),
    idleSeconds: () => 0,
    onHands: async () => null,
    ...(mac
      ? {
          makeVoice: async (text, options) => {
            asked.push({ text, ...options, signal: undefined });
            return mac(text, options);
          },
          voiceState,
          voiceLoaded,
          onWarm: (named) => warmed.push(named)
        }
      : {})
  });
  t.after(() => {
    link.close();
    gateway.close();
  });
  await until(() => gateway.voiceClient?.role === 'mac');
  return { gateway, page, speaker, voice, local, link, played, asked, madeHere, warmed, lines };
}

const macVoice = async (text, { signal } = {}) => {
  await wait(5);
  if (signal?.aborted) return null;
  return { bytes: wav('mac', text), type: 'audio/wav', seconds: text.length * 0.06, tookMs: 5 };
};

test('the Mac being talked to makes his voice itself: the server makes none, and no sound is sent down', async (t) => {
  const { gateway, speaker, voice, played, asked, madeHere } = await rig(t, { mac: macVoice });
  assert.equal(voice.where, 'there');
  const frames = [];
  const original = gateway.play;
  gateway.play = (...args) => (frames.push(args), original(...args));
  await speaker.say('Good evening. Your wrap-up is ready. Want me to read it?');
  assert.deepEqual(played, ['mac:Good evening.', 'mac:Your wrap-up is ready.', 'mac:Want me to read it?']);
  assert.deepEqual(madeHere, []);
  // Asked for in the server's voice, not the Mac's own setting.
  assert.ok(asked.every((each) => each.voice === 'george'));
  // Only which piece to play goes down, never its sound.
  assert.ok(frames.every(([, bytes, , , made]) => bytes === null && Number.isFinite(made)));
});

test('a Mac without his voice downloaded is sent the server’s, as before', async (t) => {
  const { speaker, voice, played, asked, madeHere } = await rig(t, { mac: macVoice, state: 'missing' });
  assert.equal(voice.where, 'here');
  await speaker.say('Good evening. Your wrap-up is ready.');
  assert.deepEqual(played, ['server:Good evening.', 'server:Your wrap-up is ready.']);
  assert.deepEqual(asked, []);
  assert.deepEqual(madeHere, ['Good evening.', 'Your wrap-up is ready.']);
});

test('an older Mac that never said it makes his voice is sent the server’s', async (t) => {
  const { speaker, played } = await rig(t, { mac: null });
  await speaker.say('Hello there.');
  assert.deepEqual(played, ['server:Hello there.']);
});

test('a piece the Mac can’t make is made by the server, and the rest still by the Mac', async (t) => {
  let fails = 1;
  const { speaker, played } = await rig(t, { mac: async (text, options) => (fails-- > 0 ? null : macVoice(text, options)) });
  await speaker.say('Good evening. Your wrap-up is ready.');
  assert.deepEqual(played, ['server:Good evening.', 'mac:Your wrap-up is ready.']);
});

test('a Mac that says its voice is gone mid-line is not asked again', async (t) => {
  let state = 'ready';
  const rigged = await rig(t, {
    mac: async () => {
      state = 'missing';
      return null;
    },
    voiceState: () => state
  });
  await rigged.speaker.say('Good evening. Your wrap-up is ready.');
  assert.deepEqual(rigged.played, ['server:Good evening.', 'server:Your wrap-up is ready.']);
  assert.equal(rigged.asked.length, 1);
  assert.equal(rigged.voice.where, 'here');
});

test('a Mac too slow to answer is given up on, and the server says it', async (t) => {
  const { gateway, played } = await rig(t, { mac: () => new Promise(() => undefined) });
  const made = await gateway.make('Hello there.', { limitMs: 50 });
  assert.equal(made, null);
  assert.deepEqual(played, []);
});

test('a line cut short drops what the Mac made for it and hadn’t played', async (t) => {
  const { speaker, link, played, asked } = await rig(t, { mac: macVoice, playMs: 300 });
  const saying = speaker.say('Good evening. Your wrap-up is ready. Want me to read it?');
  // The first plays, the second's queued behind it, and the third is made and kept while they're said.
  await until(() => played.length === 2 && asked.length === 3);
  await wait(40);
  assert.equal(link.voiceKept, 1);
  speaker.stop();
  await saying;
  await wait(50);
  assert.deepEqual(played, ['mac:Good evening.', 'mac:Your wrap-up is ready.']);
  assert.equal(link.voiceKept, 0);
});

test('someone starting to talk to him loads the Mac’s voice, in the server’s choice of it', async (t) => {
  const { voice, local, warmed } = await rig(t, { mac: macVoice, serverVoice: 'emma' });
  voice.warm();
  await until(() => warmed.length === 1);
  assert.deepEqual(warmed, ['emma']);
  assert.equal(local.warmed, 1);
});

test('how quickly the Mac makes his voice is kept apart from how quickly the server does', async (t) => {
  // The server's voice is slow: its opening sentence is cut sooner. The Mac's isn't: it's cut where it always was.
  const slow = await rig(t, { mac: macVoice, state: 'missing' });
  const line = 'Your wrap-up is ready, the weather is cold and wet, and the gym is at eleven tomorrow.';
  for (let n = 0; n < 3; n++) await slow.speaker.say(line);
  const fast = await rig(t, { mac: macVoice });
  for (let n = 0; n < 3; n++) await fast.speaker.say(line);
  assert.equal(slow.played.at(-2), 'server:Your wrap-up is ready,');
  assert.equal(fast.played.at(-2), 'mac:Your wrap-up is ready, the weather is cold');
});

test('a Mac whose voice was let go loads it again, and the server says the first piece meanwhile', async (t) => {
  let loaded = false;
  const rigged = await rig(t, { mac: macVoice, serverVoice: 'emma', voiceLoaded: () => loaded });
  const warm = rigged.warmed;
  const original = warm.push.bind(warm);
  warm.push = (named) => ((loaded = true), original(named));
  await rigged.speaker.say('Good evening. Your wrap-up is ready. Want me to read it?');
  assert.deepEqual(rigged.played, ['server:Good evening.', 'mac:Your wrap-up is ready.', 'mac:Want me to read it?']);
  assert.deepEqual([...rigged.warmed], ['emma']);
});
