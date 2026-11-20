// Where the user is, on a server: where the device they're using is (the user, 2026-11-18: "make it so the website
// takes the location of the computer accessing it and send it to the server"). A browser says from its own location;
// the Mac, for itself and for his website in its window, from Location Services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceLocate, deviceName, positionFrom } from '../desktop/src/main/device-location.js';
import { createWhereabouts } from '../desktop/src/main/whereabouts.js';
import { createRemoteHands } from '../desktop/src/main/remote-hands.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('a browser’s device is said as he’d say it', () => {
  assert.equal(deviceName(IPHONE), 'your iPhone');
  assert.equal(deviceName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'your iPad');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36'), 'your Android phone');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'a browser on Windows');
  assert.equal(deviceName(''), 'your browser');
});

test('only a position on Earth is taken from a browser', () => {
  const client = { id: 3, agent: IPHONE };
  assert.deepEqual(positionFrom({ ok: true, lat: 40.79, lon: -77.86, accuracy: 12 }, client), { ok: true, lat: 40.79, lon: -77.86, accuracy: 12, device: 'your iPhone', key: 'page-3' });
  assert.equal(positionFrom({ ok: true, lat: 140, lon: 0 }, client).ok, false);
  assert.equal(positionFrom({ ok: true, lat: 'x', lon: 0 }, client).ok, false);
  assert.deepEqual(positionFrom({ ok: false, code: 1, message: 'User denied Geolocation' }, client), { ok: false, code: 1, message: 'User denied Geolocation' });
  assert.equal(positionFrom({ ok: false, code: 9 }, client).code, 2);
});

/** A page of his website, as the gateway keeps it: what it's sent. */
function page(id, { agent = IPHONE, activeAt = 0, macWindow = false } = {}) {
  const sent = [];
  return { id, role: 'page', agent, activeAt, macWindow, sent, message: (message) => sent.push(message) };
}

test('the browser being talked through is asked, and only its own answer counts', async () => {
  const phone = page(1);
  const other = page(2, { agent: 'Mozilla/5.0 (Windows NT 10.0)' });
  const gateway = { voiceClient: phone, clients: [phone, other] };
  const located = createDeviceLocate({ gateway, hands: { where: async () => assert.fail('not the Mac') } });
  assert.equal(located.device(), 'page-1');
  const asking = located.locate({ timeoutMs: 20000 });
  const ask = phone.sent.at(-1);
  assert.equal(ask.type, 'jester/where-ask');
  assert.equal(ask.timeoutMs, 18000, 'a little less than the wait, so its answer is in time');
  assert.equal(located.told(other, { id: ask.id, ok: true, lat: 1, lon: 1 }), false, 'another page can’t answer it');
  assert.equal(located.told(phone, { id: ask.id, ok: true, lat: 40.79, lon: -77.86, accuracy: 30 }), true);
  assert.deepEqual(await asking, { ok: true, lat: 40.79, lon: -77.86, accuracy: 30, device: 'your iPhone', key: 'page-1' });
  assert.equal(located.told(phone, { id: ask.id, ok: true, lat: 0, lon: 0 }), false, 'answered once');
});

test('with nobody talked through, the page last heard from is asked; a page that goes, or says nothing, is no position', async () => {
  const older = page(1, { activeAt: 100 });
  const newer = page(2, { activeAt: 200 });
  const gateway = { voiceClient: null, clients: [older, newer] };
  const located = createDeviceLocate({ gateway, hands: {} });
  assert.equal(located.device(), 'page-2');
  const asking = located.locate({ timeoutMs: 20000 });
  assert.equal(newer.sent.length, 1);
  assert.equal(older.sent.length, 0);
  located.gone(newer);
  assert.deepEqual(await asking, { ok: false, code: 2, message: '' });
  const silent = await located.locate({ timeoutMs: 30 });
  assert.equal(silent.code, 3, 'not answered in time');
  assert.deepEqual(await createDeviceLocate({ gateway: { voiceClient: null, clients: [] }, hands: {} }).locate({ timeoutMs: 10 }), { ok: false, code: 2, message: 'No device is using Jester just now.' });
});

test('the Mac says where it is for itself and for his website in its own window', async () => {
  const asked = [];
  const hands = { where: async (ms) => (asked.push(ms), { ok: true, lat: 40.8, lon: -77.9, accuracy: 35 }) };
  const mac = { id: 7, role: 'mac' };
  const located = createDeviceLocate({ gateway: { voiceClient: mac, clients: [mac] }, hands });
  assert.equal(located.device(), 'mac');
  assert.deepEqual(await located.locate({ timeoutMs: 25000 }), { ok: true, lat: 40.8, lon: -77.9, accuracy: 35, device: 'your Mac', key: 'mac' });
  const window = page(8, { agent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0', macWindow: true });
  const inWindow = createDeviceLocate({ gateway: { voiceClient: window, clients: [window] }, hands });
  assert.equal(inWindow.device(), 'mac');
  assert.equal((await inWindow.locate({ timeoutMs: 25000 })).device, 'your Mac');
  assert.deepEqual(window.sent, [], 'the page itself isn’t asked: Electron has no location of its own there');
  assert.deepEqual(asked, [25000, 25000]);
  const refused = createDeviceLocate({ gateway: { voiceClient: mac, clients: [mac] }, hands: { where: async () => ({ ok: false, code: 1 }) } });
  assert.deepEqual(await refused.locate({ timeoutMs: 100 }), { ok: false, code: 1, message: '' });
});

test('the server asks the Mac where it is through its link', async () => {
  const hands = createRemoteHands();
  assert.deepEqual(await hands.where(100), { ok: false, code: 2, message: '' }, 'no Mac');
  const frames = [];
  const mac = { send: (frame) => frames.push(frame) };
  hands.join(mac);
  const asking = hands.where(25000);
  const ask = frames.at(-1);
  assert.equal(ask.t, 'hands');
  assert.equal(ask.op, 'where');
  assert.equal(ask.timeoutMs, 25000);
  hands.frame(mac, { t: 'hands-reply', id: ask.id, result: { ok: true, lat: 40.8, lon: -77.9, accuracy: 35 } });
  assert.deepEqual(await asking, { ok: true, lat: 40.8, lon: -77.9, accuracy: 35 });
});

test('another device in use is somewhere else: its position is asked at once, and one that can’t say holds back no other', async () => {
  let time = 1_000_000;
  let device = 'mac';
  const answers = {
    mac: [{ ok: true, lat: 40.79, lon: -77.86, accuracy: 30, device: 'your Mac', key: 'mac' }],
    'page-1': [{ ok: false, code: 1 }, { ok: true, lat: 41.88, lon: -87.63, accuracy: 15, device: 'your iPhone', key: 'page-1' }],
    'page-2': [{ ok: true, lat: 40.71, lon: -74.0, accuracy: 20, device: 'a browser on Windows', key: 'page-2' }]
  };
  const asked = [];
  const whereabouts = createWhereabouts({
    locate: async () => (asked.push(device), answers[device].shift()),
    device: () => device,
    setting: () => ({ source: 'here' }),
    fetchImpl: async () => Response.json({ address: { city: 'Somewhere', state: 'Pennsylvania', country_code: 'us' } }),
    now: () => time
  });
  const first = await whereabouts.here({ waitMs: 1000 });
  assert.equal(first.lat, 40.79);
  assert.equal(whereabouts.state().device, 'your Mac');
  time += 60_000;
  assert.equal((await whereabouts.here({ waitMs: 1000 })).lat, 40.79, 'the same device, a minute on: not asked again');
  assert.deepEqual(asked, ['mac']);
  // On the phone now: asked at once; it says no, so the last position stands, and it isn't asked again for a while…
  device = 'page-1';
  await whereabouts.here({ waitMs: 1000 });
  assert.equal(whereabouts.state().problem, 'denied');
  await whereabouts.here({ waitMs: 1000 });
  assert.deepEqual(asked, ['mac', 'page-1']);
  // …but another device that's used meanwhile is.
  device = 'page-2';
  assert.equal((await whereabouts.here({ waitMs: 1000 })).lat, 40.71);
  assert.equal(whereabouts.state().device, 'a browser on Windows');
  assert.deepEqual(asked, ['mac', 'page-1', 'page-2']);
});

test('a phone opened again is the same device: its new connection isn’t taken for another one and asked at once', async () => {
  // Each opening of his app on a phone is a new connection, with a new number; the id its browser keeps is the same.
  const opened = { ...page(4), device: { id: 'phone-abc123', app: true } };
  const reopened = { ...page(9), device: { id: 'phone-abc123', app: true } };
  let gateway = { voiceClient: opened, clients: [opened] };
  const located = createDeviceLocate({ gateway: { get voiceClient() { return gateway.voiceClient; }, get clients() { return gateway.clients; } }, hands: {} });
  assert.equal(located.device(), 'page-phone-abc123');
  let time = 1_000_000;
  const asked = [];
  const whereabouts = createWhereabouts({
    locate: async (options) => {
      asked.push(options);
      const asking = located.locate(options);
      const ask = gateway.voiceClient.sent.at(-1);
      located.told(gateway.voiceClient, { id: ask.id, ok: true, lat: 40.79, lon: -77.86, accuracy: 30 });
      return asking;
    },
    device: () => located.device(),
    setting: () => ({ source: 'here' }),
    fetchImpl: async () => Response.json({ address: { city: 'State College', state: 'Pennsylvania', country_code: 'us' } }),
    now: () => time
  });
  assert.equal((await whereabouts.here({ waitMs: 1000 })).lat, 40.79);
  gateway = { voiceClient: reopened, clients: [reopened] };
  time += 5 * 60 * 1000;
  await whereabouts.here({ waitMs: 1000 });
  assert.equal(asked.length, 1, 'opened again five minutes on: not asked');
  assert.deepEqual(reopened.sent, []);
});

test('a position the phone kept from earlier is taken as that old, and a turn about where they are asks for a new one', async () => {
  const client = { id: 3, agent: IPHONE, device: { id: 'phone-abc123' } };
  assert.deepEqual(positionFrom({ ok: true, lat: 40.79, lon: -77.86, accuracy: 30, kept: true, ageMs: 3 * 3600_000 }, client), { ok: true, lat: 40.79, lon: -77.86, accuracy: 30, device: 'your iPhone', key: 'page-phone-abc123', ageMs: 3 * 3600_000 });
  assert.equal(positionFrom({ ok: true, lat: 1, lon: 1, ageMs: 5000 }, client).ageMs, undefined, 'only a kept one has an age');
  assert.equal(positionFrom({ ok: true, lat: 1, lon: 1, kept: true, ageMs: 9e12 }, client).ageMs, 24 * 3600_000, 'a day at most');
  // The ask says when the turn's about where they are.
  const phone = { ...page(5), device: { id: 'phone-abc123' } };
  const located = createDeviceLocate({ gateway: { voiceClient: phone, clients: [phone] }, hands: {} });
  located.locate({ timeoutMs: 20000, fresh: true });
  assert.equal(phone.sent.at(-1).fresh, true);
  located.locate({ timeoutMs: 20000 });
  assert.equal('fresh' in phone.sent.at(-1), false);
  located.gone(phone);
  // whereabouts: a kept one, three hours old, is three hours old; asked "where am I?", it's asked for fresh.
  let time = 10_000_000_000;
  const asks = [];
  const whereabouts = createWhereabouts({
    locate: async (options) => (asks.push(options.fresh), { ok: true, lat: 40.79, lon: -77.86, accuracy: 30, ageMs: options.fresh ? 0 : 3 * 3600_000, device: 'your iPhone', key: 'page-phone-abc123' }),
    device: () => 'page-phone-abc123',
    setting: () => ({ source: 'here' }),
    fetchImpl: async () => Response.json({ address: { city: 'State College', state: 'Pennsylvania', country_code: 'us' } }),
    now: () => time
  });
  await whereabouts.here({ waitMs: 1000 });
  assert.equal(whereabouts.state().at, time - 3 * 3600_000);
  await whereabouts.here({ fresh: true, waitMs: 1000 });
  assert.deepEqual(asks, [false, true]);
  assert.equal(whereabouts.state().at, time);
});
