import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appCatalog, findApp, installedApps } from '../desktop/src/main/apps.js';
import { createVoiceRunner, dictation, displayAt, frameFor, pickDisplay, playingNow, topResultPlay } from '../desktop/src/main/voice-runner.js';

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

/** Driver calls that only read: what's running, what has the focus. */
const LOOKUPS = new Set(['apps', 'focused']);

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
  const input = () => calls.filter(([cmd]) => !LOOKUPS.has(cmd));
  return { said, input, runs, dispatched, jester };
}

test('"go to sleep" asks Jester to sleep and says so; the app list isn\'t searched for it', async () => {
  const { said, jester, runs, input } = harness();
  assert.deepEqual(await said('Go to sleep.'), { ok: true, text: 'Going to sleep' });
  assert.deepEqual(jester, ['sleep']);
  assert.deepEqual(runs, []);
  assert.deepEqual(input(), []);
});

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

test('with the assistant but no model saved, the pill says where to add one', async () => {
  const runs = [];
  const runner = createVoiceRunner({
    driver: { call: async (cmd) => (cmd === 'apps' ? { apps: RUNNING } : cmd === 'frontmost' ? { app: { name: 'Spotify' } } : {}) },
    dispatch: async () => ({ ok: true, label: '', detail: '' }),
    canPost: () => true,
    onJester: () => undefined,
    run: async (file, args) => (runs.push([file, ...args]), ''),
    installed: () => [...INSTALLED, { name: 'System Settings', path: '/System/Applications/System Settings.app' }],
    platform: 'darwin',
    wait: async () => undefined,
    assistant: { ready: async () => false, run: async () => assert.fail('no model, no run') }
  });
  assert.deepEqual((await runner.run('Open system settings and turn on dark mode.')).outcome, {
    ok: false,
    text: '“turn on dark mode” needs a model for actions: choose one in Jester’s Settings › Models. Nothing was done.'
  });
  assert.deepEqual((await runner.run('Open Spotify and play Gunna')).outcome, {
    ok: true,
    text: 'Switched to Spotify · Searching Spotify for “gunna”: pick one to play. To have Jester press Play, choose a model for actions in Settings › Models.'
  });

  let asked = null;
  let told = null;
  const ready = createVoiceRunner({
    driver: { call: async (cmd) => (cmd === 'apps' ? { apps: RUNNING } : cmd === 'frontmost' ? { app: { name: 'Spotify' } } : {}) },
    dispatch: async () => ({ ok: true, label: '', detail: '' }),
    canPost: () => true,
    onJester: () => undefined,
    run: async () => '',
    installed: () => INSTALLED,
    platform: 'darwin',
    wait: async () => undefined,
    assistant: { ready: async () => true, run: async (goal, options) => ((asked = goal), (told = options), { ok: true, text: 'Playing Gunna.' }) }
  });
  assert.deepEqual((await ready.run('Open Spotify and play Gunna')).outcome, { ok: true, text: 'Playing Gunna.' });
  assert.equal(asked, 'Open Spotify and play Gunna', 'the assistant gets the whole sentence, after the search');
  assert.deepEqual(told, { pick: true }, 'all that\'s left is pressing Play: nothing to plan');
});

const LAPTOP = { id: 1, internal: true, primary: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const MONITOR = { id: 2, internal: false, bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, workArea: { x: 1512, y: -175, width: 2560, height: 1415 } };
const PIDS = { Notes: 44, Spotify: 42, 'Visual Studio Code': 41 };
/** Spotify's search (for Gunna, unless said), as the snapshot lists it; with a Pause control once something plays. */
const RESULTS = (snapshot, playing = false, query = 'gunna') => ({
  snapshot,
  app: { name: 'Spotify', pid: 42 },
  elements: [
    { id: 0, role: 'searchfield', label: 'What do you want to play?', value: query },
    { id: 1, role: 'button', label: playing ? 'Pause' : 'Play' },
    { id: 2, role: 'text', label: 'Top result' },
    { id: 3, role: 'button', label: playing ? 'Pause Gunna' : 'Play Gunna' },
    { id: 4, role: 'button', label: 'Play fukumean', in: 'Songs' }
  ]
});

/** A runner on a driver that answers from a table, with the displays, apps and helpers a test needs. */
function rig({ platform = 'darwin', answers = {}, displays = [LAPTOP], assistant = null, learned = null, convert = {}, browser = null, log = () => undefined } = {}) {
  const calls = [];
  const runs = [];
  const dispatched = [];
  let front = { name: 'Code', pid: 41 };
  const setFront = (app) => (front = app);
  const runner = createVoiceRunner({
    driver: {
      call: async (cmd, params) => {
        calls.push([cmd, params]);
        if (cmd === 'frontmost') return { app: { name: front.name, pid: front.pid }, ...(front.title ? { window: { title: front.title } } : {}) };
        if (cmd === 'apps') return { apps: platform === 'darwin' ? RUNNING : [] };
        const answer = answers[cmd];
        if (typeof answer === 'function') return answer(params, { setFront, calls });
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      }
    },
    dispatch: async (action) => (dispatched.push(action), { ok: true, label: '', detail: '' }),
    canPost: () => true,
    onJester: () => undefined,
    run: async (file, args) => {
      runs.push([file, ...args]);
      if (file === 'open' && args[0] === '-a') {
        const name = args[1].split('/').pop().replace(/\.app$/, '');
        setFront({ name, pid: PIDS[name] ?? 99 });
      }
      if (file === 'open' && args[0].startsWith('spotify:')) setFront({ name: 'Spotify', pid: 42 });
      return '';
    },
    installed: () => (platform === 'darwin' ? INSTALLED : []),
    platform,
    wait: async () => undefined,
    assistant,
    learned,
    displays: () => displays,
    browser,
    log,
    ...convert
  });
  return { runner, calls, runs, dispatched, setFront, said: async (text) => (await runner.run(text)).outcome };
}
const placed = (calls) => calls.filter(([cmd]) => cmd === 'placeWindow').map(([, params]) => params);

test('a window\'s place is worked out from the screen it\'s meant for: halves, all of it, its own size in the middle', () => {
  assert.deepEqual(frameFor('left', LAPTOP.workArea), { x: 0, y: 25, w: 756, h: 957 });
  assert.deepEqual(frameFor('right', LAPTOP.workArea), { x: 756, y: 25, w: 756, h: 957 });
  assert.deepEqual(frameFor('full', MONITOR.workArea), { x: 1512, y: -175, w: 2560, h: 1415 });
  assert.deepEqual(frameFor('center', MONITOR.workArea, { w: 800, h: 600 }), { x: 2392, y: 233, w: 800, h: 600 });
  assert.deepEqual(frameFor('center', LAPTOP.workArea, { w: 4000, h: 3000 }), { x: 0, y: 25, w: 1512, h: 957 }, 'never bigger than the screen');
  const both = [LAPTOP, MONITOR];
  assert.equal(displayAt(both, { x: 2000, y: 100, w: 400, h: 300 }), MONITOR);
  assert.equal(pickDisplay(both, 'laptop', MONITOR), LAPTOP);
  assert.equal(pickDisplay(both, 'monitor', LAPTOP), MONITOR);
  assert.equal(pickDisplay(both, 'other', MONITOR), LAPTOP);
  assert.equal(pickDisplay(both, 'current', MONITOR), MONITOR);
  assert.equal(pickDisplay([MONITOR], 'laptop', MONITOR), null);
});

test('"put Code on the left": moved, and where it landed checked, never assumed', async () => {
  const onLaptop = { frame: { x: 100, y: 100, w: 800, h: 600 } };
  const { said, calls } = rig({ displays: [LAPTOP, MONITOR], answers: { window: onLaptop, placeWindow: (params) => ({ frame: { x: params.x, y: params.y, w: params.w, h: params.h } }) } });
  assert.deepEqual(await said('Put code on the left.'), { ok: true, text: 'Visual Studio Code: left half' });
  assert.deepEqual(placed(calls), [{ pid: 41, x: 0, y: 25, w: 756, h: 957, maximize: false, fullscreen: false }]);
  assert.deepEqual(await said('Move code to my monitor.'), { ok: true, text: 'Visual Studio Code: centered on the monitor' });
  assert.deepEqual(placed(calls)[1], { pid: 41, x: 2392, y: 233, w: 800, h: 600, maximize: false, fullscreen: false });

  // It stayed where it was (in its own full-screen space, say): said, not claimed.
  const stuck = rig({ displays: [LAPTOP, MONITOR], answers: { window: onLaptop, placeWindow: onLaptop } });
  assert.deepEqual(await stuck.said('Move code to my monitor.'), { ok: false, text: 'Visual Studio Code didn’t move there: it may be full screen in a space of its own.' });
  const alone = rig({ displays: [MONITOR], answers: { window: onLaptop } });
  assert.deepEqual(await alone.said('Put code on the laptop.'), { ok: false, text: 'There’s no laptop screen here.' });
  assert.deepEqual(placed(alone.calls), []);
});

test('a window not open yet is opened first, then placed; the one in front needs no name', async () => {
  const { said, calls, runs } = rig({ answers: { window: { frame: { x: 0, y: 25, w: 700, h: 500 } }, placeWindow: (params) => ({ frame: { x: params.x, y: params.y, w: params.w, h: params.h } }) } });
  assert.deepEqual(await said('Put notes on the right.'), { ok: true, text: 'Notes: right half' });
  assert.deepEqual(runs, [['open', '-a', '/System/Applications/Notes.app']]);
  assert.equal(placed(calls)[0].pid, 44);
  // Notes is in front now: it's the window meant.
  assert.deepEqual(await said('Maximize.'), { ok: true, text: 'Notes: full size' });
  assert.deepEqual(placed(calls)[1], { pid: 44, x: 0, y: 25, w: 1512, h: 957, maximize: true, fullscreen: false });
});

test('on Windows the frame goes to the driver in physical pixels and comes back in DIPs', async () => {
  const convert = {
    toOsFrame: (frame) => ({ x: frame.x * 2, y: frame.y * 2, w: frame.w * 2, h: frame.h * 2 }),
    toDipFrame: (frame) => ({ x: frame.x / 2, y: frame.y / 2, w: frame.w / 2, h: frame.h / 2 })
  };
  const { said, calls } = rig({ platform: 'win32', convert, answers: { window: { frame: { x: 200, y: 200, w: 1600, h: 1200 } }, placeWindow: (params) => ({ frame: { x: params.x, y: params.y, w: params.w, h: params.h } }) } });
  assert.deepEqual(await said('Maximize.'), { ok: true, text: 'Code: full size' });
  assert.deepEqual(placed(calls), [{ pid: 41, x: 0, y: 50, w: 3024, h: 1914, maximize: true, fullscreen: false }]);
});

test('"play Gunna": Spotify\'s top result is pressed and seen playing, with no AI', async () => {
  let reads = 0;
  const { said, calls } = rig({ answers: { snapshot: () => RESULTS(++reads, reads > 1) } });
  assert.deepEqual(await said('Play Gunna.'), { ok: true, text: 'Playing Gunna on Spotify' });
  assert.deepEqual(calls.find(([cmd]) => cmd === 'act'), ['act', { snapshot: 1, element: 3, action: 'press' }], 'the result\'s Play, not the player\'s');

  assert.equal(topResultPlay(RESULTS(1, false, 'fukumean'), 'fukumean').label, 'Play fukumean', 'by name, where it\'s there');
  assert.equal(topResultPlay(RESULTS(1, false, 'u2'), 'u2').label, 'Play Gunna', 'else the top result');
  assert.equal(topResultPlay({ elements: [{ id: 0, role: 'searchfield', value: 'gunna' }, { id: 1, role: 'button', label: 'Play' }] }, 'gunna'), null, 'the player\'s own button is no result');
  // The last search's page, still showing: nothing on it is this search's.
  assert.equal(topResultPlay(RESULTS(1), 'drake'), null);
  assert.equal(playingNow(RESULTS(2, true), 'gunna', true), true);
  assert.equal(playingNow(RESULTS(2, false), 'gunna', false), false);
});

test('a result that can\'t be found goes to the assistant; one pressed but not seen playing is said, never pressed twice', async () => {
  let asked = null;
  const assistant = { ready: async () => true, run: async (goal) => ((asked = goal), { ok: true, text: 'Playing Gunna.' }), running: false, cancel() {} };
  const empty = rig({ assistant, answers: { snapshot: { snapshot: 1, app: { name: 'Spotify', pid: 42 }, elements: [] } } });
  assert.deepEqual(await empty.said('Play Gunna.'), { ok: true, text: 'Playing Gunna.' });
  assert.equal(asked, 'Play Gunna.');

  asked = null;
  let reads = 0;
  const silent = rig({ assistant, answers: { snapshot: () => RESULTS(++reads, false) } });
  assert.deepEqual(await silent.said('Play Gunna.'), { ok: true, text: 'Pressed Play on “Gunna” in Spotify, but couldn’t see it start' });
  assert.equal(asked, null, 'a second press would pause it');
  assert.equal(silent.calls.filter(([cmd]) => cmd === 'act').length, 1);
});

test('"open Spotify and play Gunna" on Windows plays it in Spotify, though Spotify wasn\'t running when the apps were read', async () => {
  const { said, runs } = rig({ platform: 'win32', answers: { text: (params, { setFront }) => /spotify/i.test(params.text) && setFront({ name: 'Spotify', pid: 42 }) } });
  await said('Open Spotify and play Gunna');
  assert.deepEqual(runs, [['rundll32.exe', 'url.dll,FileProtocolHandler', 'spotify:search:gunna']]);
});

/** chrome.storage's shape, in memory, for a real learned store. */
async function learnedStore(options = {}) {
  const { createLearned } = await import('../desktop/src/main/learned.js');
  const data = {};
  return createLearned({
    ...options,
    storage: { get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}), set: async (items) => Object.assign(data, structuredClone(items)) }
  });
}
/** Lets what was started and not waited for (a store's bookkeeping) finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const DAY = 86400000;

test('"when I say focus mode, …" does it, keeps it, and "focus mode" does it again', async () => {
  const learned = await learnedStore();
  const answers = { window: { frame: { x: 100, y: 100, w: 800, h: 600 } }, placeWindow: (params) => ({ frame: { x: params.x, y: params.y, w: params.w, h: params.h } }) };
  const { said, calls } = rig({ learned, answers });
  assert.deepEqual(await said('When I say focus mode, put Code on the left.'), { ok: true, text: 'Visual Studio Code: left half · Say “focus mode” any time to do that.' });
  assert.deepEqual(await said('Focus mode.'), { ok: true, text: 'Visual Studio Code: left half' });
  assert.equal(placed(calls).length, 2);
  // What didn't work isn't kept.
  assert.deepEqual(await said('When I say bedtime, put Photoshop on the left.'), { ok: false, text: '“put Photoshop on the left” isn’t a command Jester knows yet. So “bedtime” wasn’t saved.' });
  assert.equal(await learned.phrase('bedtime'), null);
  assert.deepEqual(await said('Forget the shortcut focus mode.'), { ok: true, text: 'Forgot “focus mode”' });
  assert.equal(await learned.phrase('focus mode'), null);
});

test('a task done before is done again its way first; the assistant takes over, told where it stopped', async () => {
  const learned = await learnedStore();
  const runs = [];
  const replays = [];
  let replayWorks = true;
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async (goal, options) => (runs.push([goal, options]), { ok: true, text: 'Wrote it.', trace: [{ action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' }] }),
    replay: async (entry, goal) => (replays.push([entry.steps.length, goal]), replayWorks ? { ok: true, text: 'Wrote it.' } : { ok: false, step: 0, detail: 'there was no “New Note” on screen' })
  };
  const { said } = rig({ assistant, learned });
  assert.deepEqual(await said('Make a fresh note in Notes.'), { ok: true, text: 'Wrote it. · Next time, no AI needed.' });
  assert.deepEqual(runs, [['Make a fresh note in Notes.', {}]]);
  assert.deepEqual(await said('Please make a fresh note in notes'), { ok: true, text: 'Wrote it.' });
  assert.deepEqual(replays, [[1, 'Please make a fresh note in notes']]);
  assert.equal(runs.length, 1, 'no model the second time');

  replayWorks = false;
  assert.deepEqual(await said('make a fresh note in notes'), { ok: true, text: 'Wrote it.' });
  assert.deepEqual(runs[1], ['make a fresh note in notes', { note: 'The way this was done before stopped at step 1: there was no “New Note” on screen.' }]);
});

test('in conversation the user\'s own words are the task, the model\'s command how they were taken; what was done is kept under the command', async () => {
  const learned = await learnedStore();
  const runs = [];
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async (goal, options) => (runs.push([goal, options]), { ok: true, text: 'It’s open.', trace: [{ action: { action: 'click' }, app: 'Google Chrome', target: { role: 'button', label: 'Canvas' } }] })
  };
  const { runner } = rig({ assistant, learned });
  // A follow-up: what it agrees to is the model's to say. The way is kept under the command, which comes again; "sure, go ahead" stands for nothing.
  const followed = await runner.run('open my Canvas bookmark', { talking: true, said: 'Sure, go ahead' });
  assert.deepEqual(runs[0], ['Sure, go ahead', { meant: 'open my Canvas bookmark' }]);
  assert.deepEqual(followed.outcome, { ok: true, text: 'It’s open.' }, 'those words still go to the model next time: no promise of no AI');
  assert.deepEqual((await learned.find('open my Canvas bookmark')).steps.map((step) => step.target.label), ['Canvas']);
  assert.equal(await learned.find('Sure, go ahead'), null);
  assert.equal(await learned.aliasFor('Sure, go ahead'), null);
  assert.equal(await runner.knows('Sure, go ahead'), false);
  // The same command both ways: learned, as a spoken one is.
  const same = await rig({ assistant, learned: await learnedStore() }).runner.run('open my Canvas bookmark', { talking: true, said: 'Open my Canvas bookmark.' });
  assert.deepEqual(runs[1], ['Open my Canvas bookmark.', {}]);
  assert.deepEqual(same.outcome, { ok: true, text: 'It’s open. · Next time, no AI needed.' });
});

test('a way kept under the conversation\'s command types only words the user said', async () => {
  const typed = [
    { action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' },
    { action: { action: 'type', text: 'hello world' }, app: 'Notes' }
  ];
  const assistant = { ready: async () => true, running: false, cancel() {}, run: async () => ({ ok: true, text: 'Written.', trace: typed }) };
  const command = 'make a new note in Notes saying hello world';
  const answered = await learnedStore();
  assert.deepEqual((await rig({ assistant, learned: answered }).runner.run(command, { talking: true, said: 'yes please' })).outcome, { ok: true, text: 'Written.' });
  assert.equal(await answered.find(command), null, '“hello world” was the model’s to write, not the user’s');
  const jotted = await learnedStore();
  const { runner } = rig({ assistant, learned: jotted });
  assert.deepEqual((await runner.run(command, { talking: true, said: 'jot hello world down in Notes' })).outcome, { ok: true, text: 'Written. · Next time, no AI needed.' });
  assert.equal((await jotted.find(command)).steps.length, 2);
  assert.equal((await jotted.aliasFor('Jot hello world down in Notes.')).does, command);
});

test('a new command ends a task still running, and typing never goes into a password field', async () => {
  let cancelled = 0;
  const assistant = { ready: async () => true, run: async () => ({ ok: true, text: '' }), running: true, cancel: () => (cancelled += 1) };
  const busy = rig({ assistant });
  await busy.said('Volume up.');
  assert.equal(cancelled, 1);

  const secure = rig({ answers: { focused: { element: { secure: true }, app: { pid: 41 } } } });
  assert.deepEqual(await secure.said('Type hunter2.'), { ok: false, text: 'Jester never types into password fields.' });
  assert.equal(secure.calls.some(([cmd]) => cmd === 'text'), false);
});

test('review fixes: a placed app comes forward for what\'s said next, and what it couldn\'t do is said', async () => {
  const moved = (params) => ({ frame: { x: params.x, y: params.y, w: params.w, h: params.h } });
  const { said, calls, runs } = rig({ answers: { window: { frame: { x: 100, y: 100, w: 800, h: 600 } }, placeWindow: moved } });
  assert.deepEqual(await said('Put Spotify on the left and type hello.'), { ok: true, text: 'Spotify: left half · Typed “hello”' });
  assert.deepEqual(runs, [['open', '-a', '/Applications/Spotify.app']], 'brought forward, running or not');
  assert.ok(calls.findIndex(([cmd]) => cmd === 'placeWindow') < calls.findIndex(([cmd]) => cmd === 'text'));

  // Minimized: the middle gets a sensible size, not the icon's.
  const icon = rig({ answers: { window: { frame: { x: 0, y: 0, w: 160, h: 28 }, minimized: true }, placeWindow: moved } });
  await icon.said('Center code.');
  const { w, h } = placed(icon.calls)[0];
  assert.deepEqual([w, h], [Math.round(1512 * 0.7), Math.round(957 * 0.7)]);

  // Asked for full screen, it wasn't; asked for a half, it kept its own size.
  const stubborn = rig({ answers: { window: { frame: { x: 100, y: 100, w: 800, h: 600 } }, placeWindow: (params) => ({ frame: { x: params.x, y: params.y, w: 600, h: 500 }, fullscreen: false }) } });
  assert.deepEqual(await stubborn.said('Make code full screen.'), { ok: false, text: 'Visual Studio Code moved, but couldn’t go full screen.' });
  assert.deepEqual(await stubborn.said('Put code on the left.'), { ok: true, text: 'Visual Studio Code: left half, as near as its size allows' });
});

test('review fixes: a learned way that stops part way keeps the steps it did', async () => {
  const learned = await learnedStore();
  await learned.remember('make a checklist note in notes', [
    { action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' },
    { action: { action: 'click' }, app: 'Notes', target: { role: 'button', label: 'Checklist' } }
  ]);
  const assistant = {
    ready: async () => true,
    running: false,
    cancel: async () => undefined,
    replay: async () => ({ ok: false, step: 1, detail: 'there was no “Checklist” on screen' }),
    run: async () => ({ ok: true, text: 'Made it.', trace: [{ action: { action: 'click' }, app: 'Notes', target: { role: 'button', label: 'Format checklist' } }] })
  };
  await rig({ assistant, learned }).said('make a checklist note in notes');
  const kept = await learned.find('make a checklist note in notes');
  assert.deepEqual(kept.steps.map((step) => step.action.action), ['menu', 'click'], 'the new note first, then the new way');
  assert.equal(kept.steps[1].target.label, 'Format checklist');

  const noModel = { ...assistant, ready: async () => false };
  const outcome = await rig({ assistant: noModel, learned }).said('make a checklist note in notes');
  assert.match(outcome.text, /The saved way did 1 step, then stopped\.$/);
});

test('review fixes: dictation types nothing when the focus can\'t be read, or may be a password field', async () => {
  const timeout = Object.assign(new Error('jester-driver: "focused" timed out'), { code: 'timeout' });
  const blind = rig({ answers: { focused: timeout } });
  assert.deepEqual(await blind.said('Type hello.'), { ok: false, text: 'Jester couldn’t tell what has the keyboard focus, so nothing was typed.' });
  assert.equal(blind.calls.some(([cmd]) => cmd === 'text'), false);
  const asleep = rig({ answers: { focused: { element: { role: 'AXWebArea', secure: false }, secureInput: true } } });
  assert.deepEqual(await asleep.said('Type hunter2.'), { ok: false, text: 'Jester never types into password fields.' });
  const field = rig({ answers: { focused: { element: { role: 'AXTextField', secure: false }, secureInput: true } } });
  assert.equal((await field.said('Type hello.')).ok, true, 'a plain text field, though some app has secure input on');
  const nowhere = rig({ answers: { focused: new Error('nothing has the keyboard focus') } });
  assert.equal((await nowhere.said('Type hello.')).ok, true, 'nothing focused: nothing to type into wrongly');
});

test('review fixes: on Windows an app opened by a spoken name counts as in front under its program\'s name', async () => {
  const { said } = rig({ platform: 'win32', answers: { text: (params, { setFront }) => /settings/i.test(params.text) && setFront({ name: 'SystemSettings', pid: 80 }) } });
  assert.deepEqual(await said('Open settings and type bluetooth.'), { ok: true, text: 'Opening settings · Typed “bluetooth”' });
});

test('second review: on Windows an app\'s program name or its window\'s title says it came forward, never a name inside another', async () => {
  const powerpoint = rig({ platform: 'win32', answers: { text: (params, { setFront }) => /powerpoint/i.test(params.text) && setFront({ name: 'POWERPNT', pid: 81 }) } });
  assert.deepEqual(await powerpoint.said('Open PowerPoint and type hello.'), { ok: true, text: 'Opening powerpoint · Typed “hello”' });
  const titled = rig({ platform: 'win32', answers: { text: (params, { setFront }) => /^word$/i.test(params.text) && setFront({ name: 'SomeWordProcessor', pid: 82, title: 'Document1 - Word' }) } });
  assert.equal((await titled.said('Open Word and type hello.')).ok, true, 'its window\'s title names it');
  // 1Password in front, Word asked for: "word" inside "1password" is no match, and nothing is typed into it.
  const wrong = rig({ platform: 'win32', answers: { text: (params, { setFront }) => /^word$/i.test(params.text) && setFront({ name: '1Password', pid: 83, title: '1Password' }) } });
  const outcome = await wrong.said('Open Word and type hello.');
  assert.equal(outcome.ok, false);
  assert.equal(wrong.calls.some(([cmd, params]) => cmd === 'text' && params.text === 'hello'), false);
});

test('what Chrome is handed: the user’s words, and what the conversation took them to mean when that says more', async () => {
  const handed = [];
  const runner = createVoiceRunner({
    driver: { call: async (cmd) => (cmd === 'apps' ? { apps: RUNNING } : cmd === 'frontmost' ? { app: { name: 'Code' } } : {}) },
    dispatch: async () => ({ ok: true }),
    canPost: () => true,
    run: async () => '',
    installed: () => INSTALLED,
    platform: 'darwin',
    wait: async () => undefined,
    browser: { claims: async () => true, run: async (text, meant) => (handed.push([text, meant]), { ok: true, text: 'Opened “PSU Canvas”.' }) }
  });
  const tried = await runner.run('open Chrome and open PSU Canvas bookmark', { talking: true, said: 'Try now' });
  assert.deepEqual(tried.outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  await runner.run('open my PSU Canvas bookmark', { talking: true, said: 'Open my PSU Canvas bookmark.' });
  await runner.run('open my PSU Canvas bookmark');
  assert.deepEqual(handed, [
    ['Try now', 'open Chrome and open PSU Canvas bookmark'],
    ['Open my PSU Canvas bookmark.', ''],
    ['open my PSU Canvas bookmark', '']
  ]);
});

test('words the conversation reworded into a command that worked stand for it: next time no model is asked, and Chrome is handed the command', async () => {
  const learned = await learnedStore();
  const handed = [];
  const browser = { claims: async (text) => /canvas|bookmark/i.test(text), run: async (text, meant) => (handed.push([text, meant]), { ok: true, text: 'Opened “PSU Canvas”.' }) };
  const { runner } = rig({ learned, browser });
  assert.equal(await runner.knows('open canvas'), false);
  const first = await runner.run('open the PSU Canvas bookmark', { talking: true, said: 'open canvas' });
  assert.deepEqual(first.outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  assert.equal((await learned.aliasFor('open canvas')).does, 'open the PSU Canvas bookmark');
  assert.equal(await runner.knows('open canvas'), true, 'the conversation needn’t ask its model');
  assert.equal(await runner.knows('Can you open Canvas?'), true);
  // Said again, in conversation or as a command: the command, with these as the user's words.
  assert.deepEqual((await runner.run('Open Canvas.', { talking: true })).outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  assert.deepEqual((await runner.run('open canvas')).outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  assert.deepEqual(handed, [
    ['open canvas', 'open the PSU Canvas bookmark'],
    ['Open Canvas.', 'open the PSU Canvas bookmark'],
    ['open canvas', 'open the PSU Canvas bookmark']
  ]);
});

test('a failed run teaches nothing, a shortcut that stops working is dropped, and “forget the shortcut” forgets one', async () => {
  const learned = await learnedStore();
  let works = false;
  const browser = { claims: async () => true, run: async () => (works ? { ok: true, text: 'Opened “PSU Canvas”.' } : { ok: false, text: 'There’s no bookmark called “PSU Canvas”.' }) };
  const { runner, said } = rig({ learned, browser });
  assert.equal((await runner.run('open the PSU Canvas bookmark', { talking: true, said: 'open canvas' })).outcome.ok, false);
  assert.equal(await runner.knows('open canvas'), false, 'nothing learned from what didn’t work');
  works = true;
  await runner.run('open the PSU Canvas bookmark', { talking: true, said: 'open canvas' });
  assert.equal(await runner.knows('open canvas'), true);
  // The bookmark's gone: so is the shortcut, and the next time the conversation works the words out afresh.
  works = false;
  assert.deepEqual(await said('open canvas'), { ok: false, text: 'There’s no bookmark called “PSU Canvas”.' });
  await settled();
  assert.equal(await runner.knows('open canvas'), false);
  works = true;
  await runner.run('open the PSU Canvas bookmark', { talking: true, said: 'open canvas' });
  assert.deepEqual(await said('Forget the shortcut open canvas.'), { ok: true, text: 'Forgot “open canvas”' });
  assert.equal(await runner.knows('open canvas'), false);
  assert.deepEqual(await learned.list(), []);
});

test('carrying on, answering, and words that lean on what came before never stand for a command', async () => {
  const learned = await learnedStore();
  const browser = { claims: async () => true, run: async () => ({ ok: true, text: 'Opened “PSU Canvas”.' }) };
  const { runner } = rig({ learned, browser });
  for (const said of ['Try now', 'keep going', 'do it again', 'open it']) {
    assert.equal((await runner.run('open the PSU Canvas bookmark', { talking: true, said })).outcome.ok, true, said);
    assert.equal(await learned.aliasFor(said), null, said);
    assert.equal(await runner.knows(said), false, said);
  }
  // The matcher played what the conversation chose: "play something" named nothing it did.
  let reads = 0;
  const music = rig({ learned, answers: { snapshot: () => RESULTS(++reads, reads > 1) } });
  assert.deepEqual((await music.runner.run('play Gunna on Spotify', { talking: true, said: 'play something' })).outcome, { ok: true, text: 'Playing Gunna on Spotify' });
  assert.equal(await learned.aliasFor('play something'), null);
  assert.deepEqual(await learned.list(), [], 'nothing learned at all: Chrome’s tasks leave no steps here');
});

test('words can stand for a command the matcher knows, done with no assistant, and asked about first when it would be', async () => {
  const learned = await learnedStore();
  const { runner, dispatched, calls } = rig({ learned });
  assert.equal(await runner.knows('crank the volume'), false);
  await runner.run('volume up', { talking: true, said: 'crank the volume' });
  assert.equal(await runner.knows('crank the volume'), true);
  assert.equal((await runner.run('Crank the volume.', { talking: true })).outcome.ok, true);
  assert.deepEqual(dispatched, ['VOLUME_UP', 'VOLUME_UP']);
  assert.equal(await runner.risky('crank the volume'), false);
  // Overheard, "shut Slack down" asks first, as "quit Slack" would.
  assert.equal(await runner.risky('shut slack down'), false, 'nothing it stands for yet: the assistant would ask for itself');
  await runner.run('quit Slack', { talking: true, said: 'shut slack down' });
  assert.equal(await runner.risky('shut slack down'), true);
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'quitApp'), [['quitApp', { pid: 43 }]]);
});

test('with words standing for a command and a way learned under it, the second time needs no AI at all', async () => {
  const learned = await learnedStore();
  const runs = [];
  const replays = [];
  const trace = [{ action: { action: 'click' }, app: 'zoom.us', target: { role: 'button', label: 'New Meeting' } }];
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async (goal, options) => (runs.push([goal, options]), { ok: true, text: 'Your meeting’s started.', trace }),
    replay: async (entry, goal) => (replays.push([entry.key, goal]), { ok: true, text: 'Done, the way it was done before.' })
  };
  const { runner } = rig({ assistant, learned });
  const first = await runner.run('open Zoom and start a new meeting', { talking: true, said: 'make a zoom meeting' });
  assert.deepEqual(runs, [['make a zoom meeting', { meant: 'open Zoom and start a new meeting' }]]);
  assert.deepEqual(first.outcome, { ok: true, text: 'Your meeting’s started. · Next time, no AI needed.' });
  assert.equal(await runner.knows('make a zoom meeting'), true);
  assert.deepEqual((await runner.run('Make a Zoom meeting.', { talking: true })).outcome, { ok: true, text: 'Done, the way it was done before.' });
  assert.deepEqual(replays, [['open zoom and make new meeting', 'open Zoom and start a new meeting']]);
  assert.equal(runs.length, 1, 'no model the second time: neither the conversation’s nor the assistant’s');
  assert.deepEqual((await learned.list()).map(({ kind, said, does }) => [kind, said, does]), [
    ['alias', 'make a zoom meeting', 'open Zoom and start a new meeting'],
    ['task', 'open Zoom and start a new meeting', '1 step in zoom.us']
  ]);
});

test('a way replayed through the words that stand for its command keeps both fresh: neither’s bookkeeping undoes the other’s', async () => {
  let clock = 1_000_000;
  const learned = await learnedStore({ now: () => clock });
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async () => assert.fail('a way was learned: no model'),
    replay: async () => ({ ok: true, text: 'Done, the way it was done before.' })
  };
  const { runner } = rig({ assistant, learned });
  const command = 'open Zoom and start a new meeting';
  await learned.remember(command, [{ action: { action: 'click' }, app: 'zoom.us', target: { role: 'button', label: 'New Meeting' } }]);
  const used = async () => [(await learned.find(command))?.used, (await learned.aliasFor('make a zoom meeting'))?.used];
  // New words for it in conversation: the way replayed, and the words kept, one just after the other.
  clock += 10 * DAY;
  assert.deepEqual((await runner.run(command, { talking: true, said: 'make a zoom meeting' })).outcome, { ok: true, text: 'Done, the way it was done before.' });
  await settled();
  assert.deepEqual(await used(), [clock, clock]);
  // Said each week from then on, through the words: neither lapses 30 days after it was learned.
  for (let week = 1; week <= 5; week++) {
    clock += 7 * DAY;
    assert.deepEqual((await runner.run('Make a Zoom meeting.', { talking: true })).outcome, { ok: true, text: 'Done, the way it was done before.' }, `week ${week}`);
    await settled();
    assert.deepEqual(await used(), [clock, clock], `week ${week}`);
  }
});

test('a command that dropped what the user said keeps no way that types it: the next entry isn’t typed with the last one’s words', async () => {
  const learned = await learnedStore();
  const runs = [];
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    // It works from the user's words, so it types what they said.
    run: async (goal, options) => {
      runs.push([goal, options]);
      const typed = goal.replace(/^.*journal:\s*/i, '');
      const trace = [
        { action: { action: 'open_app', name: 'Day One' }, app: '' },
        { action: { action: 'type', text: typed }, app: 'Day One' }
      ];
      return { ok: true, text: 'Written.', trace };
    },
    replay: async () => assert.fail('nothing was kept to replay')
  };
  const { runner } = rig({ assistant, learned });
  const command = 'open my journal app and add an entry';
  assert.deepEqual((await runner.run(command, { talking: true, said: 'add to my journal: today was great' })).outcome, { ok: true, text: 'Written.' }, 'nothing kept, nothing promised');
  assert.equal(await learned.find(command), null);
  assert.deepEqual((await runner.run(command, { talking: true, said: 'add to my journal: I failed my midterm' })).outcome, { ok: true, text: 'Written.' });
  assert.deepEqual(
    runs.map(([goal]) => goal),
    ['add to my journal: today was great', 'add to my journal: I failed my midterm']
  );
});

test('a question is the assistant’s to answer every time: nothing is learned from one, and no way learned for its command is replayed for one', async () => {
  const learned = await learnedStore();
  const steps = [
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'link', label: 'PSU Canvas' } },
    { action: { action: 'click' }, app: 'Google Chrome', target: { role: 'link', label: 'Assignments' } }
  ];
  const answer = { ok: true, text: 'You have the CMPSC 465 homework due Friday.' };
  const asked = [];
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async (goal) => (asked.push(goal), { ...(/\?$/.test(goal) ? answer : { ok: true, text: 'Your assignments are open.' }), trace: steps }),
    replay: async () => ({ ok: true, text: 'Done, the way it was done before.' })
  };
  const { runner } = rig({ assistant, learned });
  // The model's command dropped the asking.
  const command = 'open Canvas and check my assignments';
  const said = async (words) => (await runner.run(command, { talking: true, said: words })).outcome;
  assert.deepEqual(await said('what’s due on Canvas this week?'), answer);
  assert.equal(await learned.find(command), null, 'its answer was that day’s');
  assert.deepEqual(await said('do I have anything due tomorrow on Canvas?'), answer);
  // Asked for plainly, the way is learned; a question that comes as the same command is still answered.
  assert.deepEqual(await said('pull up my canvas assignments'), { ok: true, text: 'Your assignments are open. · Next time, no AI needed.' });
  assert.deepEqual(await said('is anything due on Canvas tomorrow?'), answer);
  assert.equal(asked.length, 4);
  assert.deepEqual(await said('pull up my canvas assignments'), { ok: true, text: 'Done, the way it was done before.' });
  assert.equal(asked.length, 4, 'the plain request needs no AI');
});

test('a task holding a passcode is kept sealed and done again, but never listed for the vault’s Routines note, and the words for it stand for nothing', async () => {
  const learned = await learnedStore();
  const asked = [];
  const assistant = {
    ready: async () => true,
    running: false,
    cancel() {},
    run: async (goal) => (
      asked.push(goal),
      {
        ok: true,
        text: 'You’re in the meeting.',
        trace: [
          { action: { action: 'click' }, app: 'zoom.us', target: { role: 'button', label: 'Join' } },
          { action: { action: 'type', text: '4321' }, app: 'zoom.us' }
        ]
      }
    ),
    replay: async () => ({ ok: true, text: 'Done, the way it was done before.' })
  };
  const { runner } = rig({ assistant, learned });
  const command = 'open Zoom and join meeting 812 345 6789 with passcode 4321';
  const said = 'join zoom meeting 812 345 6789 passcode 4321';
  const first = await runner.run(command, { talking: true, said });
  assert.deepEqual(first.outcome, { ok: true, text: 'You’re in the meeting.' }, 'the words won’t stand for it: no promise of no AI');
  assert.equal(await learned.aliasFor(said), null);
  assert.equal(await runner.knows(said), false);
  assert.deepEqual(await learned.list(), []);
  assert.deepEqual((await runner.run(command, { talking: true, said })).outcome, { ok: true, text: 'Done, the way it was done before.' });
  assert.equal(asked.length, 1);
});

test('a command’s own words that only Chrome or the assistant could do stand for it too: the next time, no model works them out', async () => {
  const learned = await learnedStore();
  const handed = [];
  const browser = { claims: async (text) => /canvas/i.test(text), run: async (text, meant) => (handed.push([text, meant]), { ok: true, text: 'Opened “PSU Canvas”.' }) };
  const { runner } = rig({ learned, browser });
  assert.equal(await runner.knows('open canvas'), false);
  assert.deepEqual((await runner.run('open Canvas', { talking: true, said: 'open canvas' })).outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  assert.equal(await runner.knows('open canvas'), true, 'the conversation needn’t ask its model');
  // Said again, the conversation runs the words as they are, and Chrome is handed them as it was the first time.
  assert.equal(await runner.knows('Open Canvas, please.'), true);
  assert.deepEqual((await runner.run('Open Canvas, please.', { talking: true })).outcome, { ok: true, text: 'Opened “PSU Canvas”.' });
  assert.deepEqual(handed, [
    ['open canvas', ''],
    ['Open Canvas, please.', '']
  ]);

  // What the matcher knows, or a way learned for the words, is known without one.
  const note = [{ action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' }];
  const assistant = { ready: async () => true, running: false, cancel() {}, run: async () => ({ ok: true, text: 'Made one.', trace: note }) };
  const others = rig({ learned, assistant });
  assert.equal((await others.runner.run('volume up', { talking: true, said: 'Volume up.' })).outcome.ok, true);
  assert.deepEqual((await others.runner.run('make a fresh note in Notes', { talking: true, said: 'Make a fresh note in Notes.' })).outcome, { ok: true, text: 'Made one. · Next time, no AI needed.' });
  assert.equal(await others.runner.knows('make a fresh note in notes'), true);
  assert.deepEqual((await learned.list()).map(({ kind, said, does }) => [kind, said, does]), [
    ['alias', 'open canvas', 'open Canvas'],
    ['task', 'make a fresh note in Notes', '1 step in Notes']
  ]);
  // One the assistant did with no way to keep (it wrote what it chose) has nothing left for the talking model either.
  const poet = rig({ learned, assistant: { ...assistant, run: async () => ({ ok: true, text: 'Written.', trace: [{ action: { action: 'type', text: 'Roses are red' }, app: 'Notes' }] }) } });
  assert.deepEqual((await poet.runner.run('write a poem in Notes', { talking: true, said: 'Write a poem in Notes.' })).outcome, { ok: true, text: 'Written.' });
  assert.equal(await learned.find('write a poem in Notes'), null);
  assert.equal(await poet.runner.knows('write a poem in notes'), true);
});

test('dev.log never holds words a shortcut was refused for holding a password, nor any words that plainly hold one', async () => {
  const learned = await learnedStore();
  const lines = [];
  const browser = { claims: async (text) => /canvas/i.test(text), run: async () => ({ ok: true, text: 'You’re logged in.' }) };
  const { runner } = rig({ learned, browser, log: (...parts) => lines.push(parts.join(' ')) });
  assert.deepEqual((await runner.run('type hunter2', { talking: true, said: 'type my wifi password hunter2 into the box' })).outcome, { ok: true, text: 'Typed “hunter2”' });
  assert.deepEqual(lines.filter((line) => line.startsWith('learned:')), ['learned: not kept (it holds a password)'], 'the command’s half is the password itself');
  const said = 'log into canvas, my password is Tiger2026';
  assert.deepEqual((await runner.run('log into Canvas with my password Tiger2026', { talking: true, said })).outcome, { ok: true, text: 'You’re logged in.' });
  assert.ok(lines.some((line) => line.startsWith('voice: Chrome’s to do: (words holding a password, left out)')), lines.join('\n'));
  assert.equal(lines.some((line) => /wifi password|Tiger2026/.test(line)), false, lines.join('\n'));
  assert.deepEqual(await learned.list(), []);
});
