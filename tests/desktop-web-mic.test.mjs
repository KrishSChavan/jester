// His website's ears on a phone (web/shim.js), run as a browser would run it, with the browser's mic, its audio and
// his server's connection faked. The user, 2026-11-21: "on the phone (PWA) everytime I open a new app even if the pwa
// is not closed and come back to it it still asks for my microphone access". An iPhone gives a mic asked for without
// a tap, without asking, only within a minute of the last one being used, and the mic was let go each time the
// connection dropped, as it does when the app is put away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = fs.readFileSync(path.join(here, '../desktop/src/web/shim.js'), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise and what settles it. */
function held() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * A browser with the shim loaded, standing for his app on a Home Screen (`ua`: an iPhone's, or a Mac's Chrome).
 * `asking`: the browser's question about the mic, left open until `answer()`. Its timers run at most 20 ms, so a
 * reconnect after a dropped connection doesn't wait half a second.
 */
function browser({ ua = IPHONE, asking = false, loading = false, label = 'iPhone Microphone' } = {}) {
  const sockets = [];
  const tracks = [];
  const contexts = [];
  const pageListeners = new Map();
  const windowListeners = new Map();
  let asks = 0;
  let question = null;
  /** The mic's worklet loading, held until `loaded()` when `loading`; it fails, as a browser's does, if its context closed meanwhile. */
  const modules = [];
  const on = (listeners) => (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]);

  class FakeSocket {
    constructor() {
      this.sent = [];
      this.audio = 0;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      if (typeof data === 'string') this.sent.push(JSON.parse(data));
      else this.audio += 1;
    }
    /** His server says something. */
    tell(frame) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
    /** Dropped, as an iPhone drops it when his app is put away. */
    drop() {
      this.onclose?.();
    }
  }

  function makeTrack() {
    const ended = [];
    const track = {
      kind: 'audio',
      label,
      enabled: true,
      readyState: 'live',
      stopped: false,
      stop() {
        track.readyState = 'ended';
        track.stopped = true;
      },
      addEventListener: (type, fn) => type === 'ended' && ended.push(fn),
      /** Ended by the phone, not the page. */
      end() {
        track.readyState = 'ended';
        for (const fn of ended) fn();
      }
    };
    tracks.push(track);
    return track;
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.destination = {};
      const opened = () => (this.state === 'closed' ? Promise.reject(new Error('The audio context is closed')) : Promise.resolve());
      this.audioWorklet = {
        addModule: () => {
          if (!loading) return opened();
          const wait = held();
          modules.push(wait.release);
          return wait.promise.then(opened);
        }
      };
      contexts.push(this);
    }
    resume() {
      if (this.state !== 'closed') this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      if (this.state !== 'closed') this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
    createMediaStreamSource() {
      return { connect: () => undefined };
    }
  }

  const nodes = [];
  class FakeWorkletNode {
    constructor() {
      this.port = {};
      nodes.push(this);
    }
    connect() {}
  }

  const document = {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
    body: { append: () => undefined },
    addEventListener: on(pageListeners),
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, append() {}, addEventListener() {} })
  };

  const context = {
    console,
    queueMicrotask,
    setTimeout: (fn, ms, ...rest) => setTimeout(fn, Math.min(Number(ms) || 0, 20), ...rest),
    clearTimeout,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    Uint8Array,
    Float32Array,
    Date,
    btoa,
    crypto: globalThis.crypto,
    isSecureContext: true,
    location: { protocol: 'https:', host: 'jester.example' },
    WebSocket: FakeSocket,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    Audio: class {
      addEventListener() {}
    },
    Event: class {},
    dispatchEvent() {},
    addEventListener: on(windowListeners),
    matchMedia: () => ({ matches: true }),
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    navigator: {
      userAgent: ua,
      standalone: true,
      maxTouchPoints: ua === IPHONE ? 5 : 0,
      mediaDevices: {
        getUserMedia: () => {
          asks += 1;
          const stream = { tracks: [makeTrack()] };
          stream.getTracks = () => stream.tracks;
          stream.getAudioTracks = () => stream.tracks;
          if (!asking) return Promise.resolve(stream);
          question = held();
          return question.promise.then(() => stream);
        }
      }
    },
    document
  };
  context.globalThis = context;
  vm.runInNewContext(SHIM, context);

  const socket = () => sockets.at(-1);
  return {
    socket,
    get asks() {
      return asks;
    },
    track: () => tracks.at(-1),
    context: () => contexts.at(-1),
    contexts,
    /** The browser's question, answered "Allow". */
    answer: () => question?.release(),
    /** The worklets being loaded, loaded. */
    loaded: () => modules.splice(0).forEach((release) => release()),
    /** A frame of the mic's sound, from its worklet. */
    hear: () => nodes.at(-1)?.port.onmessage?.({ data: new Float32Array(128) }),
    /** His app put away, or brought back. */
    async show(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      for (const fn of pageListeners.get('visibilitychange') || []) fn();
      await settle();
    },
    /** What the page told his server of its mic. */
    micReports: () => sockets.flatMap((each) => each.sent.filter((frame) => frame.t === 'voice-status' && frame.report?.mic).map((frame) => frame.report.mic))
  };
}

test('on an iPhone, his app put away and brought back keeps the mic it had: the browser isn’t asked again', async () => {
  const phone = browser();
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  assert.equal(phone.asks, 1);
  const mic = phone.track();
  assert.equal(phone.context().state, 'running');
  phone.hear();
  assert.equal(phone.socket().audio, 1, 'what it hears goes to his server');
  assert.deepEqual(phone.micReports(), ['iPhone Microphone']);

  // Put away: the connection drops. The mic is muted, not let go; its sound is closed, and made anew when it's opened.
  await phone.show(false);
  const sound = phone.context();
  phone.socket().drop();
  assert.equal(mic.stopped, false, 'not let go: letting go means being asked again');
  assert.equal(mic.enabled, false, 'muted while nobody’s listening');
  assert.equal(sound.state, 'closed');

  // Back: the page reconnects and claims his voice; the server opens the mic again.
  await phone.show(true);
  await settle(60);
  const again = phone.socket();
  assert.notEqual(again, null);
  assert.ok(again.sent.some((frame) => frame.t === 'voice-claim'), 'his app in front claims him');
  again.tell({ t: 'voice', op: 'open' });
  await settle();
  assert.equal(phone.asks, 1, 'the same mic: nothing to ask');
  assert.equal(phone.track(), mic);
  assert.equal(mic.enabled, true);
  assert.notEqual(phone.context(), sound);
  assert.equal(phone.context().state, 'running');
  phone.hear();
  assert.equal(again.audio, 1);
  assert.match(phone.micReports().at(-1), /^iPhone Microphone, the one kept: not asked for again$/);
});

test('on an iPhone, closed while its sound was still being joined up, the mic is kept, and opened again without asking', async () => {
  const phone = browser({ loading: true });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'close' });
  phone.loaded();
  await settle();
  assert.equal(phone.track().stopped, false, 'nothing went wrong: the mic kept stays kept');
  assert.equal(phone.track().enabled, false);
  assert.ok(!phone.micReports().some((line) => /^not open/.test(line)), phone.micReports().join(' | '));
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  phone.loaded();
  await settle();
  assert.equal(phone.asks, 1);
  assert.equal(phone.track().enabled, true);
  assert.equal(phone.context().state, 'running');
  phone.hear();
  assert.equal(phone.socket().audio, 1);
});

test('on an iPhone, his server no longer listening here mutes the mic, sends nothing, and opening it again asks nothing', async () => {
  const phone = browser();
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  const mic = phone.track();
  phone.socket().tell({ t: 'voice', op: 'close' });
  await settle();
  assert.equal(mic.enabled, false);
  assert.equal(mic.stopped, false);
  phone.hear();
  assert.equal(phone.socket().audio, 0, 'nothing heard is sent while it’s closed');
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  assert.equal(phone.asks, 1);
  assert.equal(mic.enabled, true);
  phone.hear();
  assert.equal(phone.socket().audio, 1);
});

test('in a browser that keeps the site’s answer, a closed mic is let go, as before, and asked for afresh', async () => {
  const laptop = browser({ ua: CHROME, label: 'MacBook Pro Microphone (Built-in)' });
  await settle();
  laptop.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  const mic = laptop.track();
  laptop.socket().tell({ t: 'voice', op: 'close' });
  await settle();
  assert.equal(mic.stopped, true, 'its light goes out');
  assert.equal(laptop.context().state, 'closed');
  laptop.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  assert.equal(laptop.asks, 2);
  assert.notEqual(laptop.track(), mic);
  // The connection dropping lets it go too.
  laptop.socket().drop();
  assert.equal(laptop.track().stopped, true);
});

test('a mic the phone ended is asked for again: at once in front, and when the page comes back if it was behind', async () => {
  const phone = browser();
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  phone.track().end();
  await settle();
  assert.equal(phone.asks, 2, 'in front: asked for again at once');
  assert.equal(phone.track().readyState, 'live');
  assert.ok(phone.micReports().includes('ended by this device'));

  await phone.show(false);
  phone.track().end();
  await settle();
  assert.equal(phone.asks, 2, 'a page behind gets no mic: not asked for yet');
  await phone.show(true);
  assert.equal(phone.asks, 3);
  assert.equal(phone.track().enabled, true);
  assert.equal(phone.context().state, 'running');
});

test('closed while the browser was still asking: an iPhone keeps the mic it’s given, muted; Chrome lets it go', async () => {
  const phone = browser({ asking: true });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'close' });
  phone.answer();
  await settle();
  assert.equal(phone.track().stopped, false);
  assert.equal(phone.track().enabled, false);
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  assert.equal(phone.asks, 1, 'the mic given then is the one used now');
  assert.equal(phone.track().enabled, true);

  const laptop = browser({ ua: CHROME, asking: true });
  await settle();
  laptop.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  laptop.socket().tell({ t: 'voice', op: 'close' });
  laptop.answer();
  await settle();
  assert.equal(laptop.track().stopped, true);
});

test('closed and opened again while it was being opened, the mic ends up open', async () => {
  const phone = browser({ asking: true });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  phone.socket().tell({ t: 'voice', op: 'close' });
  phone.socket().tell({ t: 'voice', op: 'open' });
  phone.answer();
  await settle(60);
  assert.equal(phone.asks, 1);
  assert.equal(phone.track().enabled, true);
  assert.equal(phone.context().state, 'running');
  phone.hear();
  assert.equal(phone.socket().audio, 1);
});

test('brought back with the connection still up, a mic that’s open and sending is left alone, and says nothing', async () => {
  const phone = browser();
  await settle();
  phone.socket().tell({ t: 'voice', op: 'open' });
  await settle();
  const reports = phone.micReports().length;
  await phone.show(false);
  await phone.show(true);
  assert.equal(phone.asks, 1);
  assert.equal(phone.micReports().length, reports);
  // An iPhone left its sound interrupted while it was away: it's started again as the page comes back.
  phone.context().state = 'interrupted';
  await phone.show(true);
  assert.equal(phone.context().state, 'running');
  assert.equal(phone.asks, 1);
});
