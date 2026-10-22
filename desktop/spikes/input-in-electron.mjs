/**
 * Phase 0 spike: real mouse and keyboard through jester-driver, aimed only at
 * this spike's own window. It moves your cursor for about ten seconds.
 *
 * Run it at the Mac, from desktop/:
 *   npm run dev:mac -- spikes/input-in-electron.mjs
 *
 * dev:mac launches through `open`, which makes Electron its own app as far as
 * macOS is concerned, so the Accessibility permission is asked for — and
 * granted to — "Electron", not the terminal or VS Code that started it. The
 * results show in the window, in the terminal and in spikes/input-report.json.
 *
 * Before every click it checks that this window is in front and that the
 * point is inside it; if not, it stops, so nothing lands anywhere else.
 *
 *   --dry-run   the driver describes events instead of posting them
 *   --ax-only   no input at all: only read the accessibility tree, with the
 *               window shown but not focused
 */

import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDriver, toOsPoint } from '../src/main/driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, 'input-report.json');
const mac = process.platform === 'darwin';
const dryRun = process.argv.includes('--dry-run');
const axOnly = process.argv.includes('--ax-only');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Ways to post keyboard events on macOS. Shortcuts failed with the first
 * driver (HID tap, HID source); each of these is tried until one works.
 */
const KEY_STYLES = mac
  ? [
      { keyTap: 'session', keySource: 'none' },
      { keyTap: 'session', keySource: 'combined' },
      { keyTap: 'hid', keySource: 'hid' },
      { keyTap: 'hid', keySource: 'private' }
    ]
  : [{}];

app.whenReady().then(async () => {
  // Not alwaysOnTop: that lifts the window off the ordinary window layer the
  // driver reads to tell which app is in front, and the guard would trip.
  const win = new BrowserWindow({ width: 460, height: 600, title: 'Jester input check', show: false });
  await win.loadFile(path.join(here, 'input-targets.html'));
  if (axOnly) win.showInactive();
  else win.show();
  const page = (code) => win.webContents.executeJavaScript(code);
  const status = (text) => page(`document.getElementById('status').textContent = ${JSON.stringify(text)}`);
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

  const driver = startDriver({ dryRun });
  let hello = await driver.call('hello');
  if (dryRun) hello.permissions = { ...hello.permissions, accessibility: true, postEvents: true };
  if (!hello.permissions.accessibility || !hello.permissions.postEvents) {
    await driver.call('trust', { prompt: true });
    await status('Allow "Electron" under System Settings › Privacy & Security › Accessibility.\nThis window waits up to 90 seconds, then carries on by itself.');
    for (let waited = 0; waited < 90_000 && !(hello.permissions.accessibility && hello.permissions.postEvents); waited += 1500) {
      await pause(1500);
      hello = await driver.call('hello');
    }
  }
  check('permission granted', hello.permissions.accessibility && hello.permissions.postEvents, JSON.stringify(hello.permissions));
  if (!results[0].pass) return finish();

  /** Centre of an element, in the driver's coordinates — refusing anything outside this window. */
  async function centre(id) {
    const content = win.getContentBounds();
    const rect = await page(`rectOf(${JSON.stringify(id)})`);
    const point = { x: content.x + rect.x + rect.w / 2, y: content.y + rect.y + rect.h / 2 };
    const inside = point.x > content.x && point.y > content.y && point.x < content.x + content.width && point.y < content.y + content.height;
    if (!inside) throw new Error(`${id} is outside the window`);
    return toOsPoint(screen, point);
  }
  async function guard() {
    const front = await driver.call('frontmost');
    if (dryRun) return console.log(`(dry run) front app: ${front.app.name} pid ${front.app.pid}; Electron is ${process.pid}`);
    if (front.app.pid !== process.pid) throw new Error(`stopped: ${front.app.name || 'another app'} came to the front`);
  }
  async function readTree() {
    const element = await driver.call('elementAt', { ...(await centre('b5')), debug: true }).catch((err) => ({ error: err.message }));
    const target = element.actionable || element.element;
    check('accessibility tree names the button', target && /button/i.test(target.role || '') && (target.title === '5' || target.description === '5'), `${JSON.stringify(target || element.error)}; wake polls ${element.wakePolls ?? '-'}`);
    const field = await driver.call('elementAt', await centre('field')).catch((err) => ({ error: err.message }));
    check('accessibility tree finds the text field', /text ?field/i.test(field.element?.role || '') || field.element?.role === 'AXTextField', JSON.stringify(field.element || field.error));
    const again = await driver.call('elementAt', await centre('b5')).catch((err) => ({ error: err.message }));
    const second = again.actionable || again.element;
    check('the button, asked again', second && /button/i.test(second.role || ''), JSON.stringify(second || again.error));
  }

  if (axOnly) {
    // The full run's order, with no gap: wake, then ask before the tree exists.
    await pause(500);
    await driver.call('wake', { pid: process.pid }).catch(() => undefined);
    await readTree();
    return finish();
  }

  await status('Testing — hands off the mouse for ten seconds.');
  if (!dryRun) {
    win.focus();
    app.focus({ steal: true });
  }
  // What the app will do whenever an app comes to the front: Chromium takes
  // about two seconds to build its accessibility tree once asked.
  await driver.call('wake', { pid: process.pid }).catch(() => undefined);
  await pause(800);
  const start = await driver.call('cursor');

  try {
    const started = performance.now();
    for (let n = 1; n <= 9; n++) {
      await guard();
      const reply = await driver.call('click', await centre(`b${n}`));
      if (dryRun && n === 5) console.log('(dry run) click on 5 would post:', JSON.stringify(reply.events));
      await pause(60);
    }
    const clickMs = (performance.now() - started) / 9;
    const hits = await page('window.hits');
    check('9 clicks land on their buttons', JSON.stringify(hits) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]), `hits ${JSON.stringify(hits)}, ${clickMs.toFixed(0)} ms per click incl. 60 ms pause`);

    await readTree();

    await guard();
    await driver.call('click', await centre('field'));
    const typed = 'Jester typed this: héllo ✓';
    await driver.call('text', { text: typed });
    await pause(200);
    check('text arrives intact', (await page(`document.getElementById('field').value`)) === typed, await page(`document.getElementById('field').value`));

    // Each posting style in turn, until one clears the field. What the page
    // saw is kept, so a failure says which keys arrived and with what held.
    const tried = [];
    for (const style of KEY_STYLES) {
      const applied = (await driver.call('configure', style)).style;
      await page(`document.getElementById('field').value = 'select all of this'; window.keys.length = 0;`);
      await guard();
      await driver.call('click', await centre('field'));
      await driver.call('key', { key: 'a', modifiers: [mac ? 'cmd' : 'ctrl'] });
      await driver.call('key', { key: 'backspace' });
      await pause(250);
      const value = await page(`document.getElementById('field').value`);
      const keys = await page('window.keys.slice()');
      tried.push({ style: applied, pass: value === '', value, keys });
      if (value === '') break;
    }
    const working = tried.find((attempt) => attempt.pass);
    check(
      'select-all + backspace clears it',
      working,
      tried.map((t) => `${t.pass ? 'works' : 'fails'} with tap ${t.style.keyTap}, source ${t.style.keySource} — page saw [${t.keys.join(', ')}], value "${t.value}"`).join('; ')
    );

    await guard();
    await driver.call('click', { ...(await centre('word')), count: 2 });
    await pause(200);
    check('double-click selects a word', (await page('String(window.getSelection())')).trim() === 'jester', await page('String(window.getSelection())'));

    await page('window.wheels.length = 0');
    await guard();
    await driver.call('scroll', { ...(await centre('scroller')), dy: -5, unit: 'line' });
    await pause(400);
    const scrolled = await page(`document.getElementById('scroller').scrollTop`);
    check('wheel scrolls the box under the cursor', scrolled > 0, `scrollTop ${scrolled}; wheel events ${JSON.stringify(await page('window.wheels.slice()'))}`);
  } catch (err) {
    check('run completed', false, err.message);
  }
  await driver.call('move', start).catch(() => undefined);
  return finish();

  async function finish() {
    const passed = results.filter((result) => result.pass).length;
    const summary = `${passed}/${results.length} passed\n` + results.map((r) => `${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n');
    fs.writeFileSync(REPORT, JSON.stringify({ platform: process.platform, results }, null, 2));
    console.log(summary);
    await status(`${summary}\n\nSaved to spikes/input-report.json. Closing in 15 s.`).catch(() => undefined);
    driver.close();
    setTimeout(() => app.quit(), dryRun || axOnly ? 1000 : 15_000);
  }
});
