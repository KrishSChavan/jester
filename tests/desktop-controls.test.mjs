// Controls as a screen of his window, and on his website through the cloud link (the user, 2026-11-18: "make the
// controls window part of the view", and "part of the website too"): where the screen sits, what the website is
// served, and what a server may ask of the Mac's scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { backOf, direction, placeOf } from '../desktop/src/home/screens.js';
import { ROOTS } from '../desktop/src/main/files.js';
import { servedFile, createWebGateway } from '../desktop/src/main/web-gateway.js';
import { commandLines, createScriptsRemote, PICKED_MS, runsMore } from '../desktop/src/main/script-remote.js';
import { checkManifest } from '../desktop/src/main/script-manifest.js';
import { createRemoteHands, NO_MAC_SCRIPTS } from '../desktop/src/main/remote-hands.js';
import { createCloudLink, parseCloudLink } from '../desktop/src/main/cloud-link.js';

test('Controls slides in from the right, as Settings does, and goes back to the orb', () => {
  assert.equal(placeOf('controls'), 1);
  assert.equal(direction('main', 'controls'), 1);
  assert.equal(direction('controls', 'main'), -1);
  assert.equal(backOf('controls'), 'main');
});

test('his website is served Controls too', () => {
  for (const file of ['controls.js', 'view.js', 'controls.css']) assert.equal(servedFile(`/app/controls/${file}`), path.join(ROOTS.app, 'controls', file));
  assert.equal(servedFile('/app/controls/../main/main.js'), null);
});

const LIGHTS = checkManifest({
  name: 'Lights',
  icon: 'bulb',
  run: 'lights',
  status: ['status', '--json'],
  aim: { label: 'Which', choices: [{ label: 'Bedside', value: 'Bedside' }] },
  controls: [
    { id: 'on', kind: 'button', label: 'On', args: ['on', '{aim}'], words: ['lights on'] },
    { id: 'brightness', kind: 'slider', label: 'Brightness', min: 1, max: 100, args: ['brightness', '{value}', '{aim}'], drag: ['--quick'] },
    { id: 'color', kind: 'choices', label: 'Color', choices: [{ label: 'Red', value: 'red', color: '#ff453a' }], args: ['color', '{value}', '{aim}'] }
  ]
}).manifest;
const changed = (change) => checkManifest(change(structuredClone(LIGHTS))).manifest;

test('names, icons, words, "Ask first" and fewer controls change nothing that runs; anything that runs does', () => {
  assert.ok(LIGHTS);
  for (const [why, same] of [
    ['renamed', (m) => ({ ...m, name: 'Room lights', about: 'Mine.' })],
    ['a new icon', (m) => ({ ...m, icon: 'home' })],
    ['other words, a label, ask first', (m) => ({ ...m, controls: m.controls.map((c) => ({ ...c, label: `${c.label}!`, words: ['switch it'], askFirst: true })) })],
    ['a colour renamed', (m) => ({ ...m, controls: m.controls.map((c) => (c.choices ? { ...c, choices: [{ label: 'Rouge', value: 'red', color: '#000000' }] } : c)) })],
    ['a control taken out', (m) => ({ ...m, controls: m.controls.slice(1) })]
  ]) {
    assert.equal(runsMore(changed(same), LIGHTS), false, why);
  }
  for (const [why, more] of [
    ['another program', (m) => ({ ...m, run: 'venv/bin/python' })],
    ['an argument changed', (m) => ({ ...m, controls: m.controls.map((c) => (c.id === 'on' ? { ...c, args: ['on', '--all'] } : c)) })],
    ['a control added', (m) => ({ ...m, controls: [...m.controls, { id: 'off', kind: 'button', label: 'Off', args: ['off'] }] })],
    ['what a choice puts in', (m) => ({ ...m, controls: m.controls.map((c) => (c.choices ? { ...c, choices: [{ label: 'Red', value: 'rm' }] } : c)) })],
    ['what a chip puts in', (m) => ({ ...m, aim: { ...m.aim, choices: [{ label: 'Bedside', value: 'Everything' }] } })],
    ['what checks what’s on', (m) => ({ ...m, status: ['status', '--all'] })],
    ['while dragged', (m) => ({ ...m, controls: m.controls.map((c) => (c.drag ? { ...c, drag: ['--slow'] } : c)) })],
    ['kept running', (m) => ({ ...m, serve: ['serve'] })]
  ]) {
    assert.equal(runsMore(changed(more), LIGHTS), true, why);
  }
  assert.equal(runsMore(LIGHTS, null), true, 'a script new to Controls');
});

test('what it would run is listed, as it would be typed, for the Mac to ask about', () => {
  assert.deepEqual(commandLines(LIGHTS), [
    'On: ./lights on {aim}',
    'Brightness: ./lights brightness {value} {aim} (dragged: --quick)',
    'Color: ./lights color {value} {aim}',
    'Checking what’s on: ./lights status --json',
    '{aim} is one of: Bedside'
  ]);
});

/** The Mac's side, with its scripts, own handler, folder dialog and yes-or-no stood in for. */
function remote({ inControls = [], onDisk = {}, pick = '', yes = true } = {}) {
  const asked = [];
  const confirmed = [];
  let clock = 1_000_000;
  const handler = createScriptsRemote({
    scripts: {
      list: async () => ({ blocks: inControls.map((folder, index) => ({ id: `s${index}`, folder })) }),
      inspect: async (folder) => (onDisk[folder] ? { ok: true, found: true, folder, manifest: onDisk[folder] } : { ok: false, folder })
    },
    ask: async (message) => {
      asked.push(message);
      return { ok: true, did: message.op };
    },
    choose: async () => pick,
    confirm: async (question) => {
      confirmed.push(question);
      return yes;
    },
    now: () => clock
  });
  return { handler, asked, confirmed, later: (ms) => (clock += ms) };
}

test('from his website, running and the rest go through as from his own window', async () => {
  const mac = remote();
  for (const op of ['list', 'opened', 'run', 'refresh', 'scene-run', 'scene-save', 'scene-remove', 'menu', 'remove', 'reveal', 'edit']) {
    assert.deepEqual(await mac.handler.handle({ op, script: 's0' }), { ok: true, did: op }, op);
  }
  assert.equal((await mac.handler.handle({ op: 'open' })).ok, false, 'there is no window to open from there');
  assert.equal((await mac.handler.handle({ op: 'whatever' })).ok, false);
});

test('a folder is read from his website only if it was picked on the Mac, lately, or is in Controls', async () => {
  const mac = remote({ pick: '/Users/k/bluetooth lights', inControls: ['/Users/k/fan'] });
  const refused = await mac.handler.handle({ op: 'inspect', folder: '/opt/homebrew/bin' });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /Choose that folder on your Mac/);
  assert.deepEqual(mac.asked, [], 'nothing was read');
  assert.deepEqual(await mac.handler.handle({ op: 'inspect', folder: '/Users/k/fan' }), { ok: true, did: 'inspect' });
  assert.deepEqual(await mac.handler.handle({ op: 'choose' }), { ok: true, folder: '/Users/k/bluetooth lights' });
  assert.deepEqual(await mac.handler.handle({ op: 'inspect', folder: '/Users/k/bluetooth lights/' }), { ok: true, did: 'inspect' });
  mac.later(PICKED_MS + 1);
  assert.equal((await mac.handler.handle({ op: 'inspect', folder: '/Users/k/bluetooth lights' })).ok, false, 'an hour on, it needs picking again');
  // Cancelled on the Mac: nothing picked.
  assert.deepEqual(await remote().handler.handle({ op: 'choose' }), { ok: false, folder: '' });
});

test('a script is added from his website only once the Mac says yes to what it runs', async () => {
  const folder = '/Users/k/bluetooth lights';
  const unpicked = remote();
  assert.equal((await unpicked.handler.handle({ op: 'save', folder, manifest: LIGHTS })).ok, false);
  assert.deepEqual(unpicked.confirmed, []);

  const allowed = remote({ pick: folder });
  await allowed.handler.handle({ op: 'choose' });
  assert.deepEqual(await allowed.handler.handle({ op: 'save', folder, manifest: LIGHTS }), { ok: true, did: 'save' });
  assert.equal(allowed.confirmed.length, 1);
  assert.equal(allowed.confirmed[0].adding, true);
  assert.equal(allowed.confirmed[0].name, 'Lights');
  assert.ok(allowed.confirmed[0].lines.includes('On: ./lights on {aim}'));

  const refused = remote({ pick: folder, yes: false });
  await refused.handler.handle({ op: 'choose' });
  const no = await refused.handler.handle({ op: 'save', folder, manifest: LIGHTS });
  assert.equal(no.ok, false);
  assert.match(no.why, /wasn’t allowed on your Mac/);
  assert.equal(refused.asked.length, 0, 'nothing was written');
});

test('a script in Controls is renamed from his website without asking; a change to what it runs asks', async () => {
  const folder = '/Users/k/bluetooth lights';
  const mac = remote({ inControls: [folder], onDisk: { [folder]: LIGHTS } });
  assert.deepEqual(await mac.handler.handle({ op: 'save', folder, manifest: changed((m) => ({ ...m, name: 'Room lights' })) }), { ok: true, did: 'save' });
  assert.deepEqual(mac.confirmed, []);
  await mac.handler.handle({ op: 'save', folder, manifest: changed((m) => ({ ...m, run: 'venv/bin/python' })) });
  assert.equal(mac.confirmed.length, 1);
  assert.equal(mac.confirmed[0].adding, false);
});

const KEY = 'controls-cloud-test-key-0123';
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('his website’s Controls asks the Mac through the link, and hears when its scripts change', async (t) => {
  const changes = [];
  const hands = createRemoteHands({ onScriptsChanged: (change) => changes.push(change) });
  assert.deepEqual(await hands.scripts({ op: 'list' }), { ok: false, why: NO_MAC_SCRIPTS }, 'no Mac: why');
  const gateway = createWebGateway({
    key: KEY,
    port: 0,
    onMessage: async () => null,
    onStorage: async () => null,
    onConnect: (client) => client.role === 'mac' && hands.join(client),
    onClose: (client) => hands.leave(client),
    onOther: (client, frame) => hands.frame(client, frame)
  });
  const port = await gateway.ready;
  const asked = [];
  const link = createCloudLink({
    link: parseCloudLink(`http://127.0.0.1:${port}/?key=${KEY}`),
    onVoice: () => undefined,
    onPlay: () => undefined,
    handsState: () => ({ running: false, asking: false, abilities: {} }),
    idleSeconds: () => 0,
    onHands: async (frame) => {
      asked.push(frame);
      return frame.op === 'scripts' ? { ok: true, blocks: [{ id: 'lights', name: 'Lights' }], scenes: [] } : null;
    }
  });
  t.after(() => {
    link.close();
    gateway.close();
  });
  await until(() => hands.connected);
  assert.deepEqual(changes.at(-1), { mac: true }, 'the Mac came: Controls reads its scripts');
  const reply = await hands.scripts({ op: 'list' });
  assert.deepEqual(reply, { ok: true, blocks: [{ id: 'lights', name: 'Lights' }], scenes: [] });
  assert.equal(asked.at(-1).op, 'scripts');
  assert.deepEqual(asked.at(-1).message, { op: 'list' });
  link.scriptsChanged({ script: 'lights', state: { power: true } });
  await until(() => changes.some((change) => change.script === 'lights'));
  link.close();
  await until(() => !hands.connected);
  assert.deepEqual(changes.at(-1), { mac: false }, 'the Mac went: Controls says why');
});

test('Controls never shows through his window’s other screens', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../desktop/src/controls/controls.css', import.meta.url), 'utf8');
  // A child's own `visible` outranks the `visibility: hidden` his window hides a screen by (2026-11-18: Controls
  // stayed over the orb, and the screen under it took the clicks). Shown things inherit instead.
  assert.doesNotMatch(css, /visibility:\s*visible/);
  const home = await readFile(new URL('../desktop/src/home/home.css', import.meta.url), 'utf8');
  assert.match(home, /\.screen:not\(\.shown\) > \.controls-host \{\s*content-visibility: hidden;/);
});
