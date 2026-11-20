// His website asking a phone where it is (web/shim.js), run as a browser would run it, with the browser's location,
// its permission and its storage faked. The user, 2026-11-19: "The location thing still asks me each time on my phone
// pwa": an iPhone's app on the Home Screen often forgets it was allowed, so each ask was the browser's question again,
// and his own bar with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = fs.readFileSync(path.join(here, '../desktop/src/web/shim.js'), 'utf8');
const HOUR = 60 * 60 * 1000;

/**
 * A browser with the shim loaded. `permission`: what navigator.permissions says. `position(ok, fail)`: what the
 * browser's getCurrentPosition does (default: its question goes unanswered). `store`: localStorage, kept between
 * openings of the app as a phone keeps it.
 */
function browser({ permission = 'prompt', position = () => undefined, store = new Map(), now = () => Date.now() } = {}) {
  const sockets = [];
  const elements = new Map();
  let located = 0;
  const element = (tag) => {
    const el = { tag, children: [], style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append: (...kids) => el.children.push(...kids), focus() {} };
    Object.defineProperty(el, 'id', { set: (id) => ((el._id = id), elements.set(id, el)), get: () => el._id });
    el.remove = () => elements.get(el._id) === el && elements.delete(el._id);
    return el;
  };
  class FakeSocket {
    constructor() {
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
  }
  const DateNow = class extends Date {
    static now() {
      return now();
    }
  };
  const context = {
    console,
    queueMicrotask,
    setTimeout,
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
    Date: DateNow,
    btoa,
    crypto: globalThis.crypto,
    isSecureContext: true,
    location: { protocol: 'https:', host: 'jester.example' },
    WebSocket: FakeSocket,
    Audio: class {
      addEventListener() {}
    },
    Event: class {},
    dispatchEvent() {},
    addEventListener() {},
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      standalone: true,
      permissions: { query: async () => ({ state: typeof permission === 'function' ? permission() : permission }) },
      geolocation: {
        getCurrentPosition: (ok, fail) => {
          located += 1;
          position(ok, fail);
        }
      }
    },
    document: {
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      body: { append: () => undefined },
      addEventListener() {},
      getElementById: (id) => elements.get(id) || null,
      createElement: element
    }
  };
  context.globalThis = context;
  vm.runInNewContext(SHIM, context);
  const socket = () => sockets.at(-1);
  return {
    store,
    get located() {
      return located;
    },
    bar: () => elements.get('jester-where') || null,
    /** The bar's buttons: [Not now, Allow location]. */
    buttons: () => elements.get('jester-where')?.children.at(-1).children || [],
    /** His server asks where it is; resolves with the page's answer. */
    async ask(fields = {}) {
      await new Promise((resolve) => setImmediate(resolve));
      const id = `where-${Math.random()}`;
      socket().onmessage({ data: JSON.stringify({ t: 'msg', message: { type: 'jester/where-ask', id, timeoutMs: 3000, ...fields } }) });
      for (let tries = 0; tries < 400; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const told = socket().sent.find((frame) => frame.t === 'msg' && frame.message?.type === 'jester/where-told' && frame.message.id === id);
        if (told) {
          const { type, id: _, ...answer } = told.message;
          return answer;
        }
      }
      return null;
    }
  };
}

const coords = (latitude, longitude, accuracy = 30) => ({ coords: { latitude, longitude, accuracy } });

test('allowed once, an iPhone that forgets it isn’t asked again, nor shown his bar, while what it said is under 12 hours old', async () => {
  const store = new Map();
  let time = Date.now();
  // The first time: his bar and the browser's question; allowed.
  const first = browser({ store, now: () => time, position: (ok) => setTimeout(() => ok(coords(40.79, -77.86)), 20) });
  const said = await first.ask();
  assert.deepEqual(said, { ok: true, lat: 40.79, lon: -77.86, accuracy: 30 });
  assert.equal(first.located, 1);
  // The app opened again, hours later: iOS says "prompt" again, as if never allowed.
  time += 5 * HOUR;
  const again = browser({ store, now: () => time, position: () => assert.fail('the browser isn’t asked') });
  const kept = await again.ask();
  assert.equal(again.located, 0, 'the browser isn’t asked, so it puts no question');
  assert.equal(again.bar(), null, 'nor is his bar shown');
  assert.equal(kept.ok, true);
  assert.equal(kept.kept, true);
  assert.equal(kept.lat, 40.79);
  assert.ok(Math.abs(kept.ageMs - 5 * HOUR) < 1000, 'and says how old it is');
});

test('older than 12 hours, or a turn about where they are, the browser is asked again, without his bar', async () => {
  const store = new Map();
  let time = Date.now();
  await browser({ store, now: () => time, position: (ok) => ok(coords(40.79, -77.86)) }).ask();
  time += 13 * HOUR;
  const later = browser({ store, now: () => time, position: (ok) => setTimeout(() => ok(coords(41.88, -87.63)), 20) });
  const moved = await later.ask();
  assert.equal(later.located, 1);
  assert.deepEqual(moved, { ok: true, lat: 41.88, lon: -87.63, accuracy: 30 });
  // Asked "where am I?": a new one, however recent the kept one.
  time += HOUR;
  const asked = browser({ store, now: () => time, position: (ok) => setTimeout(() => ok(coords(41.9, -87.6)), 20) });
  let barShown = false;
  const watching = setInterval(() => (barShown ||= !!asked.bar()), 2);
  assert.equal((await asked.ask({ fresh: true })).lat, 41.9);
  clearInterval(watching);
  assert.equal(asked.located, 1);
  assert.equal(barShown, false, 'allowed before: no bar of his, only the browser’s own question if it has one');
});

test('a browser that remembers it was allowed is asked each time, quietly, as before', async () => {
  const store = new Map();
  const phone = browser({ store, permission: 'granted', position: (ok) => ok(coords(51.5, -0.12)) });
  await phone.ask();
  assert.deepEqual(await phone.ask(), { ok: true, lat: 51.5, lon: -0.12, accuracy: 30 });
  assert.equal(phone.located, 2);
});

test('never allowed: his bar, once; "Not now" stands for a week across openings, unless Settings asks', async () => {
  const store = new Map();
  let time = Date.now();
  const phone = browser({ store, now: () => time });
  const asking = phone.ask();
  for (let tries = 0; tries < 50 && !phone.bar(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(phone.bar(), 'the bar says what he wants');
  phone.buttons()[0].onclick();
  assert.deepEqual(await asking, { ok: false, code: 1, message: 'Not now.' });
  time += 2 * 24 * HOUR;
  const reopened = browser({ store, now: () => time });
  assert.deepEqual(await reopened.ask(), { ok: false, code: 1, message: 'Not now.' });
  assert.equal(reopened.located, 0);
  assert.equal(reopened.bar(), null);
  // From Settings, on purpose: put to them again.
  const sure = reopened.ask({ sure: true });
  for (let tries = 0; tries < 50 && !reopened.bar(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(reopened.bar());
  reopened.buttons()[0].onclick();
  await sure;
});

test('refused in the browser’s own question, what was kept goes', async () => {
  const store = new Map();
  let time = Date.now();
  await browser({ store, now: () => time, position: (ok) => ok(coords(40.79, -77.86)) }).ask();
  time += 13 * HOUR;
  // Allowed before, so no bar: the browser asks, and is refused after a tap on its question.
  let tapped = false;
  const refusing = browser({
    store,
    now: () => time,
    position: (_ok, fail) => {
      if (!tapped) return fail({ code: 1, message: 'denied' });
      return fail({ code: 1, message: 'User denied Geolocation' });
    }
  });
  const asking = refusing.ask();
  for (let tries = 0; tries < 50 && !refusing.bar(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(refusing.bar(), 'refused without a tap: the browser wants one, so the bar comes now');
  tapped = true;
  refusing.buttons()[1].onclick();
  assert.deepEqual(await asking, { ok: false, code: 1, message: 'User denied Geolocation' });
  assert.equal(store.has('jesterWhere'), false);
  assert.equal(store.has('jesterWhereOk'), false);
});

test('no position to be had just now: the one kept, with its age', async () => {
  const store = new Map();
  let time = Date.now();
  await browser({ store, now: () => time, position: (ok) => ok(coords(40.79, -77.86)) }).ask();
  time += 3 * HOUR;
  const indoors = browser({ store, now: () => time, permission: 'granted', position: (_ok, fail) => fail({ code: 2, message: 'unavailable' }) });
  const said = await indoors.ask();
  assert.equal(said.kept, true);
  assert.equal(said.lat, 40.79);
});
