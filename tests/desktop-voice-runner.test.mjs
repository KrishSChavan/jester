import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appCatalog, findApp, installedApps } from '../desktop/src/main/apps.js';
import { createVoiceRunner, dictation } from '../desktop/src/main/voice-runner.js';

const INSTALLED = [
  { name: 'Spotify', path: '/Applications/Spotify.app' },
  { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' },
  { name: 'Safari', path: '/Applications/Safari.app' },
  { name: 'Notes', path: '/System/Applications/Notes.app' }
];
const RUNNING = [
  { name: 'Code', pid: 41, path: '/Applications/Visual Studio Code.app', active: true },
  { name: 'Spotify', pid: 42, path: '/Applications/Spotify.app' },
  { name: 'Slack', pid: 43, path: '/Applications/Slack.app' }
];

function harness({ platform = 'darwin', canPost = true, comesForward = true } = {}) {
  const calls = [];
  const runs = [];
  const dispatched = [];
  const jester = [];
  /** The app in front: what `open -a` last opened, as an app that does come forward. */
  let front = 'Code';
  const runner = createVoiceRunner({
    driver: {
      call: async (cmd, params) => {
        if (cmd === 'frontmost') return { app: { name: front } };
        calls.push([cmd, params]);
        return cmd === 'apps' ? { apps: platform === 'darwin' ? RUNNING : [{ name: 'Spotify', pid: 7 }] } : {};
      }
    },
    dispatch: async (action, options) => {
      dispatched.push([action, options]);
      return { ok: true, label: `did ${action}`, detail: '' };
    },
    canPost: () => canPost,
    onJester: (op) => jester.push(op),
    run: async (file, args) => {
      runs.push([file, ...args]);
      if (file === 'open' && args[0] === '-a' && comesForward) front = args[1].split('/').pop().replace(/\.app$/, '');
      return file === 'shortcuts' && args[0] === 'list' ? 'Morning Routine\nFocus\n' : '';
    },
    installed: () => (platform === 'darwin' ? INSTALLED : []),
    platform,
    wait: async () => undefined
  });
  const said = async (text) => (await runner.run(text)).outcome;
  /** What reached the keyboard, mouse and apps — not the lookups. */
  const input = () => calls.filter(([cmd]) => cmd !== 'apps');
  return { said, input, runs, dispatched, jester };
}

test('on a Mac, apps open through LaunchServices and quit when asked', async () => {
  const { said, input, runs } = harness();
  assert.deepEqual(await said('Open Spotify.'), { ok: true, text: 'Switched to Spotify' });
  assert.deepEqual(await said('Open spot of fire.'), { ok: true, text: 'Switched to Spotify' });
  assert.deepEqual(await said('Switch to code.'), { ok: true, text: 'Switched to Visual Studio Code' });
  assert.deepEqual(await said('Open notes.'), { ok: true, text: 'Opening Notes' });
  assert.deepEqual(runs, [
    ['open', '-a', '/Applications/Spotify.app'],
    ['open', '-a', '/Applications/Spotify.app'],
    ['open', '-a', '/Applications/Visual Studio Code.app'],
    ['open', '-a', '/System/Applications/Notes.app']
  ]);

  assert.deepEqual(await said('Quit Slack.'), { ok: true, text: 'Quitting Slack' });
  assert.deepEqual(await said('Quit Notes.'), { ok: false, text: 'Notes isn’t open.' });
  assert.deepEqual(await said('Minimize Spotify.'), { ok: true, text: 'Hid Spotify' });
  assert.deepEqual(input(), [
    ['quitApp', { pid: 43 }],
    ['hideApp', { pid: 42 }]
  ]);
});

test('volume, keys, typing, clicks and the actions gestures share', async () => {
  const { said, input, runs, dispatched } = harness();
  assert.deepEqual(await said('Set the volume to thirty percent.'), { ok: true, text: 'Volume 30%' });
  assert.deepEqual(runs, [['osascript', '-e', 'set volume output volume 30 without output muted']]);

  assert.deepEqual(await said('Press command shift four.'), { ok: true, text: 'Pressed ⌘⇧4' });
  assert.deepEqual(await said('Undo.'), { ok: true, text: 'Undo (⌘Z)' });
  assert.deepEqual(await said("Type Hello, I'll be there in five minutes."), { ok: true, text: "Typed “Hello, I'll be there in five minutes.”" });
  assert.deepEqual(await said('Type cat videos.'), { ok: true, text: 'Typed “cat videos”' });
  assert.deepEqual(await said('Double click.'), { ok: true, text: 'Double-click' });
  assert.deepEqual(input(), [
    ['key', { key: '4', modifiers: ['cmd', 'shift'] }],
    ['key', { key: 'z', modifiers: ['cmd'] }],
    ['text', { text: "Hello, I'll be there in five minutes." }],
    ['text', { text: 'cat videos' }],
    ['click', { button: 'left', count: 2 }]
  ]);

  assert.deepEqual(await said('Next song.'), { ok: true, text: 'did MEDIA_NEXT' });
  assert.deepEqual(dispatched, [['MEDIA_NEXT', { source: 'voice', quiet: true }]]);
});

test('nothing is pressed without Accessibility; other sentences say what happened', async () => {
  const blocked = harness({ canPost: false });
  assert.match((await blocked.said('Type hello.')).text, /Accessibility/);
  assert.deepEqual(blocked.input(), []);
  // LaunchServices needs no permission.
  assert.equal((await blocked.said('Open Spotify.')).ok, true);

  const { said, jester } = harness();
  assert.deepEqual(await said('Turn on do not disturb.'), { ok: false, text: '“Turn on do not disturb.” isn’t a command Jester knows yet.' });
  assert.equal(await said('Never mind.'), null);
  assert.deepEqual(await said('Calibrate my eyes.'), { ok: true, text: 'Calibrating' });
  assert.deepEqual(jester, ['calibrate']);
});

test('shortcuts are found by a forgiving name, and started rather than waited for', async () => {
  const { said, runs } = harness();
  assert.deepEqual(await said('Run shortcut morning routine.'), { ok: true, text: 'Running “Morning Routine”' });
  assert.deepEqual(await said('Run shortcut taxes.'), { ok: false, text: 'No shortcut called “taxes”.' });
  assert.deepEqual(runs.filter(([, verb]) => verb === 'run'), [['shortcuts', 'run', 'Morning Routine']]);
});

test('on Windows, running apps come forward, the Start menu finds the rest, and volume is set by key', async () => {
  const { said, input } = harness({ platform: 'win32' });
  assert.deepEqual(await said('Open Spotify.'), { ok: true, text: 'Switched to Spotify' });
  assert.deepEqual(await said('Open Photoshop.'), { ok: true, text: 'Opening photoshop' });
  assert.deepEqual(input(), [
    ['activateApp', { pid: 7 }],
    ['key', { key: 'escape', modifiers: ['ctrl'] }],
    ['text', { text: 'photoshop' }],
    ['key', { key: 'enter', modifiers: [] }]
  ]);

  const volume = harness({ platform: 'win32' });
  await volume.said('Volume 30.');
  const keys = volume.input().map(([, params]) => params.key);
  assert.equal(keys.length, 65);
  assert.deepEqual([keys.filter((key) => key === 'volumeDown').length, keys.at(-1)], [50, 'volumeUp']);
});

test('the catalog knows an app by both its names, running or not', () => {
  const catalog = appCatalog(INSTALLED, RUNNING);
  const code = findApp(catalog, 'Code');
  assert.deepEqual(code.names, ['Visual Studio Code', 'Code']);
  assert.equal(code.pid, 41);
  assert.equal(findApp(catalog, 'Visual Studio Code'), code);
  assert.equal(findApp(catalog, 'Slack').running, true, 'running apps from elsewhere count too');
  assert.equal(findApp(catalog, 'Notes').running, false);
  assert.equal(findApp(catalog, 'Photoshop'), null);
});

test('installed apps are the .app bundles in the folders, and one folder down', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-apps-'));
  try {
    fs.mkdirSync(path.join(root, 'Spotify.app'));
    fs.mkdirSync(path.join(root, 'Microsoft Office', 'Microsoft Word.app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Deep', 'Deeper', 'Buried.app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    assert.deepEqual(installedApps('darwin', [root]).map((app) => app.name).sort(), ['Microsoft Word', 'Spotify']);
    assert.deepEqual(installedApps('win32', [root]), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dictation drops the full stop that a few words get', () => {
  assert.equal(dictation('cat videos.'), 'cat videos');
  assert.equal(dictation("Hello, I'll be there in five minutes."), "Hello, I'll be there in five minutes.");
  assert.equal(dictation('Is it on?'), 'Is it on?');
});

test('a new note, written in: Notes opens, comes forward, gets ⌘N, then the words', async () => {
  const { said, input, runs } = harness();
  assert.deepEqual(await said('Open a new note and say hello world.'), { ok: true, text: 'New note · Typed “hello world”' });
  assert.deepEqual(runs, [['open', '-a', '/System/Applications/Notes.app']]);
  assert.deepEqual(input(), [
    ['key', { key: 'n', modifiers: ['cmd'] }],
    ['text', { text: 'hello world' }]
  ]);
});

test('nothing is typed into an app that never came forward', async () => {
  const { said, input } = harness({ comesForward: false });
  assert.deepEqual(await said('Open a new note and write my password'), { ok: false, text: 'Notes didn’t come to the front, so Jester stopped.' });
  assert.deepEqual(input(), []);
  const opened = harness({ comesForward: false });
  assert.deepEqual(await opened.said('Open Notes and type hello'), { ok: false, text: 'Opening Notes · Notes didn’t come to the front, so Jester stopped' });
  assert.deepEqual(opened.input(), []);
});

test('play: Spotify\'s search for it, honest that the pick is still yours', async () => {
  const { said, runs } = harness();
  assert.deepEqual(await said('Open Spotify and play a Gunna song'), { ok: true, text: 'Switched to Spotify · Searching Spotify for “gunna”: pick one to play' });
  assert.deepEqual(runs, [
    ['open', '-a', '/Applications/Spotify.app'],
    ['open', 'spotify:search:gunna']
  ]);
  const youtube = harness();
  assert.deepEqual(await youtube.said('Search YouTube for cat videos.'), { ok: true, text: 'Searching YouTube for “cat videos”' });
  assert.deepEqual(youtube.runs, [['open', 'https://www.youtube.com/results?search_query=cat%20videos']]);
});

test('half a sentence understood does nothing, and says which half', async () => {
  const { said, runs, input } = harness();
  assert.deepEqual(await said('Open Spotify and do a little dance'), { ok: false, text: 'Jester doesn’t know how to “do a little dance” yet, so it did nothing.' });
  assert.deepEqual(runs, []);
  assert.deepEqual(input(), []);
});
