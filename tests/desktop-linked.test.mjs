// Everything linked (the user, 2026-11-18): where he's open and what each device is for, a chat per device with a
// banner for the others, more than one computer, and a Mac's Jester moved to his server when it links.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevices, describeAgent } from '../desktop/src/main/devices.js';
import { createSessions, following, sessionFile, sessionKeyOf } from '../desktop/src/main/sessions.js';
import { createRemoteHands, namedIn } from '../desktop/src/main/remote-hands.js';
import { apply, checked, collect, MOVE_KEYS } from '../desktop/src/main/move-in.js';
import { bannerFor } from '../desktop/src/home/others.js';
import { deviceLine, pushProblem } from '../desktop/src/home/devices-page.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('a browser is named for what it is; his app on a Home Screen is just the phone', () => {
  assert.deepEqual(describeAgent(IPHONE, { app: true }), { name: 'iPhone', kind: 'phone' });
  assert.deepEqual(describeAgent(IPHONE), { name: 'iPhone (Safari)', kind: 'phone' });
  assert.deepEqual(describeAgent(CHROME), { name: 'Chrome on a Mac', kind: 'browser' });
  assert.equal(describeAgent('Mozilla/5.0 (Windows NT 10.0) Edg/140.0').name, 'Edge on Windows');
});

function registry() {
  let kept = {};
  let time = 1_800_000_000_000;
  const computers = [];
  let voice = null;
  const devices = createDevices({ storage: { get: async () => kept, set: async (items) => Object.assign(kept, structuredClone(items)) }, computers: () => computers, voiceClient: () => voice, now: () => time });
  return { devices, computers, later: (ms) => (time += ms), talkThrough: (client) => (voice = client), kept: () => kept };
}

test('he knows where he’s open, on what, and where he isn’t', async () => {
  const r = registry();
  await r.devices.start();
  const phone = { id: 1, role: 'page', agent: IPHONE, device: { id: 'phone-device-0001', app: true }, visible: true, activeAt: 1_800_000_000_000, from: '100.64.0.2' };
  const mac = { id: 2, role: 'mac', device: { id: 'mac-device-00001', name: 'Krish’s MacBook Pro' }, from: '100.64.0.5' };
  const window = { id: 3, role: 'page', macWindow: true, agent: 'Electron/44', device: { id: 'window-storage-id', app: false }, visible: true, from: '100.64.0.5' };
  const tab = { id: 4, role: 'page', agent: CHROME, device: { id: 'chrome-device-001', app: false }, visible: false, from: '100.64.0.5' };
  for (const client of [phone, window, mac, tab]) r.devices.join(client);
  r.computers.push({ id: 'mac-device-00001', name: 'Krish’s MacBook Pro', running: true, asking: false, doing: 'open Canvas', engine: 'running', switches: { gestures: true }, idleSeconds: 30 });
  r.talkThrough(phone);
  assert.equal(r.devices.idOf(window), 'mac-device-00001', 'a computer’s own window is that computer');
  const list = r.devices.list({ viewer: 'phone-device-0001' });
  assert.deepEqual(list.map((device) => device.name).sort(), ['Chrome on Krish’s MacBook Pro', 'Krish’s MacBook Pro', 'iPhone']);
  assert.equal(list.find((device) => device.name === 'iPhone').here, true);
  assert.equal(list.find((device) => device.kind === 'computer').computer.doing, 'open Canvas');
  r.devices.seen(phone, { screen: 'controls' });
  const lines = r.devices.lines('phone-device-0001');
  assert.match(lines, /- iPhone \(your app on its Home Screen\): these words came from here; open and in front, on Controls \(their scripts\); the one you hear and speak through/);
  assert.match(lines, /- Krish’s MacBook Pro \(a computer running Jester\): open and in front; your hands[^\n]*at work on a task \(“open Canvas”\); being used now/);
  assert.match(lines, /- Chrome on Krish’s MacBook Pro: open, behind something else/);
  // Closed, it's said to be, and since when; named by the user, it keeps its name.
  r.devices.rename('phone-device-0001', 'My phone');
  r.devices.leave(phone);
  r.later(2 * 60 * 60 * 1000);
  assert.match(r.devices.lines(''), /- My phone \(your app on its Home Screen\): not open; last open 2 hours ago\./);
  assert.equal(r.devices.forget('mac-device-00001'), false, 'not while he’s open there');
  assert.equal(r.devices.forget('phone-device-0001'), true);
});

test('a chat per device: each has its own, and what nobody asked for goes to the one in front', () => {
  let front = '';
  const made = [];
  const sessions = createSessions({ make: (key) => (made.push(key), { conversation: { name: key, told() { return `${this.name} told`; } }, log: { chatId: () => `chat-${key}` } }), frontKey: () => front });
  assert.equal(sessions.front().key, 'local');
  sessions.used('phone');
  assert.equal(sessions.front().key, 'phone', 'the one last used');
  front = 'laptop';
  const talk = following(() => sessions.front().conversation);
  assert.equal(talk.told(), 'laptop told', 'the one being talked through, when something knows');
  assert.equal(sessions.ofChat('chat-phone').key, 'phone');
  assert.deepEqual(made, ['local', 'phone', 'laptop']);
  assert.equal(sessionFile('local'), 'conversation.json');
  assert.equal(sessionFile('phone-device-0001'), 'conversation-phone-device-0001.json');
  assert.equal(sessionFile('../../etc/passwd'), 'conversation-etcpasswd.json');
  assert.equal(sessionKeyOf('conversation-phone-device-0001.json'), 'phone-device-0001');
  assert.equal(sessionKeyOf('chats.json'), '');
});

test('the banner offers another device’s chat, one with a task first, until it’s closed; and the way back', () => {
  const others = [{ key: 'mac', chat: 'c1', name: 'MacBook Pro', running: true }, { key: 'tab', chat: 'c2', name: 'Chrome on a Mac', running: false }];
  const first = bannerFor({ others });
  assert.equal(first.text, 'See current chat from: MacBook Pro (a task is running)');
  assert.equal(first.key, 'mac');
  assert.equal(bannerFor({ others }, new Set([first.mark])).key, 'tab', 'closed, the next one');
  assert.equal(bannerFor({ others: [{ ...others[0], running: false }] }, new Set([first.mark])).key, 'mac', 'its task over, it’s offered again as it is now');
  assert.equal(bannerFor({ others: [] }), null);
  assert.deepEqual(bannerFor({ others, viewing: { key: 'mac', name: 'MacBook Pro' } }), { text: 'Showing the chat from MacBook Pro', action: 'Back to this device', key: '' });
});

test('with two computers, what’s asked goes to the one named, else the chat’s own, else the one touched last', async () => {
  const hands = createRemoteHands();
  const sent = { book: [], desk: [] };
  const computer = (name, id) => ({ id, device: { id, name }, send: (frame) => sent[id].push(frame) });
  const book = computer('Krish’s MacBook Pro', 'book');
  const desk = computer('Studio iMac', 'desk');
  hands.join(book);
  hands.join(desk);
  hands.frame(book, { t: 'presence', idleSeconds: 5 });
  hands.frame(desk, { t: 'presence', idleSeconds: 900 });
  assert.deepEqual(hands.list().map((entry) => entry.name), ['Krish’s MacBook Pro', 'Studio iMac'], 'the one in use first');
  const phone = hands.for('phone-chat', () => 'phone');
  const onDesk = hands.for('desk-chat', () => 'desk');
  phone.commands.knows('volume 30');
  assert.equal(sent.book.at(-1).op, 'knows', 'from a phone: the one touched last');
  onDesk.commands.knows('volume 30');
  assert.equal(sent.desk.at(-1).op, 'knows', 'from a computer’s own chat: that computer');
  phone.commands.run('open Notes on the iMac', 'open Notes on the iMac');
  assert.equal(sent.desk.at(-1).op, 'run', 'named in the words');
  // Its question comes back to the chat that started it, and only that chat answers.
  hands.frame(desk, { t: 'hands-state', running: true, asking: true });
  assert.equal(phone.assistant.asking, true);
  assert.equal(onDesk.assistant.asking, false);
  phone.assistant.answer(true);
  assert.equal(sent.desk.at(-1).op, 'answer');
  assert.equal(namedIn('open notes on my macbook', [{ name: 'Krish’s MacBook Pro' }, { name: 'Studio iMac' }]).name, 'Krish’s MacBook Pro');
  assert.equal(namedIn('open notes on my desktop', [{ name: 'Krish’s MacBook Pro' }, { name: 'Studio iMac' }]).name, 'Studio iMac');
  assert.equal(namedIn('turn the macbook stand lamp', [{ name: 'Krish’s MacBook Pro' }, { name: 'Studio iMac' }]), null);
  // A switch thrown from the phone goes to the computer named.
  hands.set('desk', { sleep: true });
  assert.deepEqual(sent.desk.at(-1).change, { sleep: true });
  // Gone, what was waiting on them is settled, not left for minutes.
  hands.leave(book);
  hands.leave(desk);
  assert.equal(hands.connected, false);
});

test('a Mac’s Jester moves to a server once: only what’s his, and the server’s own stays its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-move-'));
  const from = path.join(dir, 'mac');
  const to = path.join(dir, 'server');
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(from, 'tasks.json'), '{"tasks":[1]}');
  fs.writeFileSync(path.join(from, 'chats.json'), 'not json');
  fs.writeFileSync(path.join(to, 'tasks.json'), '{"tasks":[]}');
  const macKept = { settings: { eveningAt: '21:30', cameraDeviceId: 'cam' }, modelConnections: [{ id: 'a', key: 'sk-secret' }], watchKey: 'w', scripts: ['lights'], cloudBrain: { link: 'x' } };
  const move = await collect({ storage: { get: async (keys) => Object.fromEntries(keys.filter((key) => key in macKept).map((key) => [key, macKept[key]])) }, dataDir: from });
  assert.deepEqual(Object.keys(move.storage).sort(), ['modelConnections', 'settings']);
  assert.ok(!MOVE_KEYS.includes('cloudBrain') && !MOVE_KEYS.includes('watchKey') && !MOVE_KEYS.includes('scripts'));
  assert.deepEqual(Object.keys(checked({ storage: { ...move.storage, evil: 1 }, files: { ...move.files, '../x.json': '{}' } }).files), ['tasks.json'], 'only his files, and only JSON');
  const serverKept = { settings: { cameraDeviceId: '', locationSource: 'here' } };
  const storage = { get: async (key) => ({ [key]: serverKept[key] }), set: async (items) => Object.assign(serverKept, items) };
  const done = await apply(move, { storage, dataDir: to, from: 'MacBook Pro', now: () => 5 });
  assert.equal(done.ok, true);
  assert.equal(fs.readFileSync(path.join(to, 'tasks.json'), 'utf8'), '{"tasks":[1]}');
  assert.equal(fs.readFileSync(path.join(to, 'tasks.json.before-move'), 'utf8'), '{"tasks":[]}');
  assert.equal(serverKept.settings.eveningAt, '21:30');
  assert.equal(serverKept.settings.cameraDeviceId, '', 'a computer’s own setting stays the server’s');
  assert.deepEqual(serverKept.movedIn, { at: 5, from: 'MacBook Pro' });
  assert.deepEqual(await apply(move, { storage, dataDir: to }), { ok: false, already: true, why: 'This server already has a Jester moved to it.' });
  assert.equal(checked({ storage: 'x' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings says how each device stands, and why a browser can’t take notifications', () => {
  const now = 1_800_000_000_000;
  assert.equal(deviceLine({ open: false, lastAt: now - 3 * 3600_000 }, now), 'Not open · last open 3 hours ago');
  assert.equal(deviceLine({ open: true, front: true, screen: 'main', voice: true }, now), 'Open, in front, talking with him · he hears and speaks here');
  assert.equal(deviceLine({ open: true, computer: { running: true, doing: 'open Canvas', engine: 'sleeping', idleSeconds: 20 } }, now), 'Connected: Jester’s hands · working on “open Canvas” · asleep · in use now');
  assert.match(pushProblem({ agent: IPHONE, standalone: false, has: false }), /add him there \(Share › Add to Home Screen\)/);
  assert.equal(pushProblem({ agent: IPHONE, standalone: true, has: true, permission: 'default' }), '');
  assert.match(pushProblem({ agent: IPHONE, standalone: true, has: true, permission: 'denied' }), /turned off for Jester/);
  assert.match(pushProblem({ agent: 'Mozilla/5.0 Electron/44.7.0', has: true }), /On this Mac/);
});
