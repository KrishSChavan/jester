/**
 * Working behind your windows, tried for real: jester-driver and the assistant's host (src/main/agent/host.js)
 * against two windows of this check's own, which open in a corner without coming to the front: a web page (Electron,
 * so Chromium) and, where Swift is installed, a small Mac window with a button, a canvas, fields and two menu-bar
 * icons. Nothing of yours is touched: every command that would move the real pointer or press a real key is refused
 * before it reaches the driver, and the host is told another app is in front, so whatever it does it must do to
 * the page where it is.
 *
 *   node spikes/behind-check.mjs          (from desktop/, with Accessibility allowed for the terminal it runs in)
 *
 * It needs the driver built (npm run driver). Screen Recording, where allowed, lets it check the glance too.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopHost, glanceChanged } from '../src/main/agent/host.js';
import { startDriver } from '../src/main/driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const real = startDriver();
const hello = await real.call('hello');
if (hello.platform !== 'macos' || !hello.permissions?.accessibility) {
  console.log('This check is for a Mac, with Accessibility allowed for the app it runs in. Nothing was tried.');
  real.close();
  process.exit(1);
}
const ask = (cmd, params) => real.call(cmd, params).then(({ id, ok, ...rest }) => rest, (err) => ({ error: err.message }));
const started = (child) => new Promise((resolve, reject) => {
  child.stdout.on('data', (data) => { const found = String(data).match(/pid (\d+)/); if (found) resolve(Number(found[1])); });
  child.on('exit', () => reject(new Error('the test window closed before it opened')));
});
const cursor = await ask('cursor');

// --- A web page (Chromium), worked by the real host.
console.log('A web page behind other windows, through the assistant’s own host:');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = path.join(here, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const page = spawn(electron, [path.join(here, 'behind/page-window.cjs'), '60'], { stdio: ['ignore', 'pipe', 'ignore'], env });
const pagePid = await started(page);
const REAL_INPUT = new Set(['click', 'move', 'button', 'scroll', 'key', 'text', 'media', 'activateApp', 'quitApp', 'hideApp', 'placeWindow', 'windowAt', 'moveWindow', 'menuBar', 'menu']);
let refused = 0;
const guarded = {
  call: async (cmd, params) => {
    if (REAL_INPUT.has(cmd)) {
      refused += 1;
      throw new Error(`refused in this check: ${cmd}`);
    }
    // Another app is in front, as far as the host knows: it must work the page where it is.
    if (cmd === 'frontmost') return { app: { pid: 1, name: 'Somebody Else' } };
    return real.call(cmd, params);
  }
};
let brought = 0;
const host = createDesktopHost({ driver: guarded, activate: async () => (brought += 1), openApp: async () => ({ ok: false, text: '' }), openUrl: async () => undefined, dispatch: async () => ({ ok: false }), pid: pagePid, platform: 'darwin' });
await pause(1800);
let screen = (await host.observe()).snapshot;
const said = () => String(screen?.window?.title || '');
const id = (label) => screen.elements.find((element) => element.label === label)?.id;
const step = async (action) => {
  const result = await host.execute(action, screen, { verify: true });
  screen = result.snapshot || (await host.observe()).snapshot;
  return result;
};
check('the page is read by its process', id('Go') !== undefined && id('Words') !== undefined, `${screen?.elements?.length ?? 0} controls`);
await step({ action: 'click', id: id('Go') });
check('a button pressed', /go=1 trusted=1 active=1/.test(said()));
const go = screen.elements.find((element) => element.label === 'Go');
const square = { x: go.frame.x + 320, y: go.frame.y + go.frame.h + 70 };
const first = await step({ action: 'click', x: 1, y: 1, what: 'the square', at: square });
check('a spot with no control clicked where it is', /behind the window in front/.test(first.detail || ''), first.detail);
const again = await step({ action: 'click', x: 1, y: 1, what: 'the square', at: square });
if (hello.permissions.screenCapture) check('a click that changed only pixels is seen', /The screen changed where it was clicked/.test(again.changes || ''), again.changes);
else console.log('  --    the glance wasn’t checked: Screen Recording isn’t allowed here');
const canvas = await step({ action: 'click', x: 1, y: 1, what: 'the grey box', at: { x: go.frame.x + 100, y: go.frame.y + go.frame.h + 70 } });
check('a click lands where it was aimed', /canvas=1 at=100,58/.test(said()), said().match(/canvas=\S+ at=\S*/)?.[0]);
const typed = await step({ action: 'type', id: id('Words'), text: 'desk lamp under $30', enter: true });
check('text typed over a field, then Return', typed.ok && /sub=1 .*i=\[desk lamp under \$30\]/.test(said()), typed.detail);
const added = await step({ action: 'type', id: id('Notes'), text: ' gamma', mode: 'append' });
check('text added to the end of a longer one', added.ok && /t=\[alpha beta gamma\]/.test(said()), added.detail);
const after = await step({ action: 'type', id: id('Notes'), text: ' NEW', after: 'alpha' });
check('text put after chosen words', after.ok && /t=\[alpha NEW beta gamma\]/.test(said()), after.detail);
const tab = await step({ action: 'press', keys: 'tab' });
check('a key reaches it', tab.ok && /last=Tab/.test(said()));
check('nothing was brought forward, and no real key or click was asked for', brought === 0 && refused === 0, `${brought} brought forward, ${refused} refused`);
page.kill();

// --- A Mac window of its own, at the driver.
const built = path.join(os.tmpdir(), `jester-behind-${process.pid}`);
let swift = true;
try {
  fs.mkdirSync(built, { recursive: true });
  fs.copyFileSync(path.join(here, 'behind/page.html'), path.join(built, 'page.html'));
  execFileSync('swiftc', ['-O', path.join(here, 'behind/window.swift'), '-o', path.join(built, 'window')], { stdio: 'ignore' });
} catch {
  swift = false;
  console.log('A Mac window of its own: not tried (no Swift compiler here; xcode-select --install has one).');
}
if (swift) {
  console.log('A Mac window behind other windows, at the driver:');
  const app = spawn(path.join(built, 'window'), ['40', '300', '200', 'back', 'icons'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await started(app);
  await pause(900);
  const read = () => ask('snapshot', { pid });
  const title = async () => (await read()).window?.title || '';
  let snap = await read();
  const frame = snap.window.frame;
  const window = snap.window.id;
  const spot = { x: frame.x + 210, y: frame.y + (frame.h - 300) + 237 };
  await ask('clickBehind', { pid, ...spot, window });
  await pause(200);
  check('a click on a canvas accessibility can’t see', /canvas=1 .*at=190,4[78]/.test(await title()));
  await ask('clickBehind', { pid, ...spot, window, count: 2 });
  await ask('clickBehind', { pid, ...spot, window, button: 'right' });
  await pause(250);
  check('a double click and a right click', /canvas=3 right=1 double=1/.test(await title()));
  snap = await read();
  const notes = snap.elements.find((element) => element.role === 'textarea');
  const field = snap.elements.find((element) => element.role === 'textfield');
  const label = snap.elements.find((element) => /^Presses/.test(element.label || ''));
  const before = await ask('glance', { x: label.frame.x + 30, y: label.frame.y + 10, window });
  await ask('act', { snapshot: snap.snapshot, element: snap.elements.find((element) => element.label === 'Count').id, action: 'press' });
  await pause(300);
  if (hello.permissions.screenCapture) check('its own window is glanced at, whatever lies over it', glanceChanged(before.gray, (await ask('glance', { x: label.frame.x + 30, y: label.frame.y + 10, window })).gray));
  const put = await ask('act', { snapshot: snap.snapshot, element: field.id, action: 'insertAfter', value: ' (oat)', after: 'milk' });
  check('text put after words in a field', put.landed === true && put.value === 'milk (oat), eggs', put.error || put.value);
  await ask('act', { snapshot: snap.snapshot, element: notes.id, action: 'focus' });
  await ask('act', { snapshot: snap.snapshot, element: notes.id, action: 'select', value: 'end' });
  await ask('textBehind', { pid, text: ' Typed behind: café 😀', window });
  await pause(250);
  check('text in any script, typed where the app is', /Typed behind: café 😀$/.test((await ask('act', { snapshot: snap.snapshot, element: notes.id, action: 'read' })).value || ''));
  const found = await ask('shortcut', { pid, key: 'd', modifiers: ['cmd', 'shift'] });
  check('a shortcut known by its command', found.found === true && found.path?.join(' › ') === 'File › Send Stamp', found.path?.join(' › '));
  await ask('shortcut', { pid, key: 't', modifiers: ['cmd'], press: true });
  await pause(250);
  check('its command chosen with the app behind', /stamps=1/.test(await title()));
  const refusedKey = await ask('keyBehind', { pid, key: 'a', modifiers: ['cmd'], window });
  check('a ⌘ shortcut is never sent as keys from behind', /shortcut/.test(refusedKey.error || ''));
  const opened = await ask('menuBar', { press: 'FixPanel', exact: true, exclude: process.pid });
  const panel = await ask('snapshot', { panel: true });
  check('a menu-bar icon opened, and what it opened read', opened.opened === true && (panel.elements || []).some((element) => element.label === 'Ping'), opened.error || panel.error);
  if (panel.elements) await ask('act', { snapshot: panel.snapshot, element: panel.elements.find((element) => element.label === 'Ping').id, action: 'press' });
  await ask('menuBar', { press: 'FixPanel', exact: true, exclude: process.pid });
  await pause(200);
  check('and pressed in', /pings=1/.test(await title()));
  app.kill();
  fs.rmSync(built, { recursive: true, force: true });
}
const moved = await ask('cursor');
check('your pointer never moved', Math.abs(moved.x - cursor.x) < 1 && Math.abs(moved.y - cursor.y) < 1);
real.close();
console.log(failed ? `\n${failed} failed.` : '\nAll of it worked here.');
process.exit(failed ? 1 : 0);
