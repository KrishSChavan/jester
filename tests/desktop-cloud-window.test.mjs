// A Mac linked to the cloud keeps one window (the user, 2026-11-19: "when I send a chat to jester on my mac electron
// app a new window is opening up"). His window there is his website; the app's own page is only this Mac's settings,
// opened in the website's place, and leaving them puts the website back where they were. Checked end to end in
// Electron by a scratch run (real main.js, a pretend server): Settings in the website's place, back to it, typing
// and Chats each leave one window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScreens } from '../desktop/src/home/screens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '../desktop/src', file), 'utf8');

/** A strip of screens with just what createScreens touches. */
function strip(names, shown = names[0]) {
  globalThis.matchMedia ??= () => ({ matches: true });
  globalThis.CSS ??= { escape: (text) => text };
  const screens = names.map((name) => {
    const classes = new Set(name === shown ? ['shown'] : []);
    return { dataset: { screen: name }, inert: false, classList: { toggle: (cls, on) => (on ? classes.add(cls) : classes.delete(cls)), contains: (cls) => classes.has(cls) }, querySelector: () => null };
  });
  return {
    querySelector: (selector) => {
      if (selector === '.screen.shown') return screens.find((el) => el.classList.contains('shown')) || null;
      const name = /data-screen="([^"]+)"/.exec(selector)?.[1];
      return screens.find((el) => el.dataset.screen === name) || null;
    },
    classList: { add() {}, remove() {} }
  };
}

test('a screen this window doesn’t show is gone to elsewhere, and this one stays as it is', () => {
  const handed = [];
  const changed = [];
  const screens = createScreens({
    root: strip(['main', 'chats', 'settings', 'settings/general', 'setup', 'controls'], 'settings'),
    onChange: (screen) => changed.push(screen),
    elsewhere: (screen) => !screen.startsWith('settings') && screen !== 'setup' && (handed.push(screen), true)
  });
  assert.equal(screens.current, 'settings');
  assert.equal(screens.back(), false, 'back from Settings is the website’s window');
  assert.equal(screens.go('chats'), false);
  assert.deepEqual(handed, ['main', 'chats']);
  assert.equal(screens.current, 'settings');
  assert.equal(screens.go('settings/general'), true, 'this Mac’s own settings are shown here');
  assert.equal(screens.go('setup'), true);
  assert.deepEqual(changed, ['settings/general', 'setup']);
});

test('without the hook, every screen is this window’s', () => {
  const screens = createScreens({ root: strip(['main', 'settings'], 'settings') });
  assert.equal(screens.back(), true);
  assert.equal(screens.current, 'main');
});

test('typed in this Mac’s own window while linked, the website takes its place rather than opening over it', () => {
  const main = read('main/main.js');
  const typed = main.slice(main.indexOf("case 'jester/talk-type':"), main.indexOf("case 'jester/sign-in-return':"));
  assert.match(typed, /if \(cloudTarget\) \{\n\s+if \(url\.startsWith\('jester:\/\/app\/home\/'\)\) backToCloud\('main'\);/);
  assert.doesNotMatch(typed, /showTalk\(\)/);
  assert.match(main, /case 'jester\/home-cloud':\n\s+if \(SERVER \|\| !cloudTarget \|\| !url\.startsWith\('jester:\/\/app\/home\/'\)\) return \{ ok: false \};\n\s+backToCloud\(/);
  const home = read('home/home.js');
  assert.match(home, /elsewhere: inCloudWindow,/);
  assert.match(home, /if \(website \|\| !state\(\)\.desktop\?\.cloud\?\.on \|\| name\.startsWith\('settings'\) \|\| name === 'setup'\) return false;/);
  const windows = read('main/windows.js');
  // This Mac's settings open where the website is, and it steps aside.
  assert.match(windows, /const spot = cloudPage \? cloudSpot\(\) : null;/);
  assert.match(windows, /if \(spot && cloud && !cloud\.isDestroyed\(\)\) cloud\.hide\(\);/);
});
