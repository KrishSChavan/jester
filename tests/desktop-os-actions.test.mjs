import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../jester-extension/src/common/constants.js';
import { bindable, describePlan, fillsDisplay, osPlan, parseShortcut } from '../desktop/src/main/os-actions.js';
import { createDispatcher } from '../desktop/src/main/dispatch.js';

const key = (name, ...modifiers) => ({ kind: 'key', key: name, modifiers });

test('each OS gets its own shortcuts for the same action', () => {
  const cases = {
    APP_NEXT: [key('tab', 'cmd'), key('tab', 'alt')],
    WINDOW_NEXT: [key('tab', 'cmd'), key('tab', 'alt')],
    DESKTOP_LEFT: [key('left', 'ctrl'), key('left', 'win', 'ctrl')],
    SHOW_ALL_WINDOWS: [key('up', 'ctrl'), key('tab', 'win')],
    SCREENSHOT: [key('5', 'cmd', 'shift'), key('s', 'win', 'shift')],
    TAB_REOPEN: [key('t', 'cmd', 'shift'), key('t', 'ctrl', 'shift')],
    HISTORY_BACK: [key('leftbracket', 'cmd'), key('left', 'alt')],
    LOCK_SCREEN: [key('q', 'ctrl', 'cmd'), { kind: 'system', op: 'lock' }],
    FULLSCREEN_TOGGLE: [key('f', 'ctrl', 'cmd'), key('f11')]
  };
  for (const [action, [mac, windows]] of Object.entries(cases)) {
    assert.deepEqual(osPlan(action, 'darwin'), mac, `${action} on a Mac`);
    assert.deepEqual(osPlan(action, 'win32'), windows, `${action} on Windows`);
  }
});

test('media actions press the media keys, and play, pause and play/pause share one', () => {
  for (const action of ['PLAY_PAUSE', 'PLAY', 'PAUSE']) assert.deepEqual(osPlan(action, 'darwin'), { kind: 'media', key: 'play' });
  assert.deepEqual(osPlan('NEXT_VIDEO', 'win32'), { kind: 'media', key: 'next' });
  assert.deepEqual(osPlan('VOLUME_DOWN', 'win32'), { kind: 'media', key: 'volumeDown' });
  assert.deepEqual(osPlan('BRIGHTNESS_UP', 'darwin'), { kind: 'media', key: 'brightnessUp' });
  assert.equal(osPlan('BRIGHTNESS_UP', 'win32').kind, 'unsupported');
});

test('every action the extension knows has a desktop answer, even if that answer is "not here"', () => {
  for (const action of Object.keys(ACTIONS)) {
    for (const platform of ['darwin', 'win32']) {
      const plan = osPlan(action, platform, { desktopShortcuts: { SHORTCUT_1: 'cmd+k', SHORTCUT_2: 'cmd+k', SHORTCUT_3: 'cmd+k' } });
      assert.notEqual(plan.why, 'Jester doesn’t know that action', `${action} on ${platform}`);
    }
  }
  assert.equal(osPlan('SPEED_UP', 'darwin').kind, 'unsupported');
  assert.equal(bindable('SPEED_UP', 'darwin'), false);
  assert.equal(bindable('SHORTCUT_2', 'win32'), true);
  assert.equal(bindable('APP_NEXT', 'win32'), true);
  assert.deepEqual(osPlan('SLEEP', 'darwin'), { kind: 'none' });
  assert.deepEqual(osPlan('VOICE_CAPTURE_TOGGLE', 'win32'), { kind: 'jester', op: 'voice' });
});

test('scrolling follows the scroll step setting', () => {
  assert.deepEqual(osPlan('SCROLL_DOWN', 'darwin'), { kind: 'scroll', dy: -400 });
  assert.deepEqual(osPlan('SCROLL_UP', 'darwin', { scrollStep: 0.3 }), { kind: 'scroll', dy: 200 });
});

test('your shortcuts are read the way people write them, and nonsense is refused', () => {
  assert.deepEqual(parseShortcut('cmd+shift+4'), key('4', 'cmd', 'shift'));
  assert.deepEqual(parseShortcut(' Ctrl + Alt + T '), key('t', 'ctrl', 'alt'));
  assert.deepEqual(parseShortcut('option+command+esc'), key('escape', 'alt', 'cmd'));
  assert.deepEqual(parseShortcut('ctrl+shift+['), key('leftbracket', 'ctrl', 'shift'));
  assert.deepEqual(parseShortcut('F5'), key('f5'));
  assert.deepEqual(parseShortcut('cmd+cmd+k'), key('k', 'cmd'));
  for (const bad of ['', 'cmd', 'cmd+shift', 'hyper+k', 'cmd+banana', 'cmd+f25', null, undefined]) assert.equal(parseShortcut(bad), null, String(bad));
  assert.deepEqual(osPlan('SHORTCUT_1', 'darwin', { desktopShortcuts: { SHORTCUT_1: 'cmd+shift+4' } }), key('4', 'cmd', 'shift'));
  assert.equal(osPlan('SHORTCUT_2', 'darwin', { desktopShortcuts: { SHORTCUT_1: 'cmd+k' } }).kind, 'unsupported');
});

test('toasts name the keys the way each OS writes them', () => {
  assert.equal(describePlan(key('5', 'cmd', 'shift'), 'darwin'), '⌘⇧5');
  assert.equal(describePlan(key('tab', 'ctrl', 'shift'), 'win32'), 'Ctrl+Shift+Tab');
  assert.equal(describePlan(key('left', 'win', 'ctrl'), 'win32'), 'Win+Ctrl+←');
  assert.equal(describePlan(key('leftbracket', 'cmd'), 'darwin'), '⌘[');
  assert.equal(describePlan({ kind: 'media', key: 'volumeUp' }, 'darwin'), 'Volume-up key');
  assert.equal(describePlan({ kind: 'scroll', dy: -400 }, 'darwin'), 'Scroll down');
});

test('a window that fills its display is "full screen", on any display', () => {
  const displays = [{ x: 0, y: 0, width: 1512, height: 982 }, { x: 1512, y: -200, width: 2560, height: 1440 }];
  assert.equal(fillsDisplay({ x: 0, y: 0, w: 1512, h: 982 }, displays), true);
  assert.equal(fillsDisplay({ x: 1512, y: -200, w: 2560, h: 1440 }, displays), true);
  assert.equal(fillsDisplay({ x: 1, y: 1, w: 1511, h: 981 }, displays), true);
  assert.equal(fillsDisplay({ x: 0, y: 25, w: 1512, h: 957 }, displays), false);
  assert.equal(fillsDisplay(null, displays), false);
  assert.equal(fillsDisplay({ x: 0, y: 0, w: 0, h: 0 }, displays), false);
});

function harness({ canPost = true, fail = false } = {}) {
  const calls = [];
  const toasts = [];
  const jester = [];
  const dispatch = createDispatcher({
    driver: { call: async (cmd, params) => { calls.push([cmd, params]); if (fail) throw new Error('boom'); return { ok: true }; } },
    getSettings: async () => ({ scrollStep: 0.6, desktopShortcuts: { SHORTCUT_1: 'cmd+shift+4' } }),
    canPost: () => canPost,
    onJester: (op) => jester.push(op),
    toast: (text, options = {}) => toasts.push({ text, ...options }),
    platform: 'darwin'
  });
  return { dispatch, calls, toasts, jester };
}

test('a gesture presses its keys and says what it did', async () => {
  const { dispatch, calls, toasts } = harness();
  await dispatch('APP_NEXT', { source: 'pose', gesture: 'Victory' });
  await dispatch('VOLUME_UP', { source: 'pose', gesture: 'Thumb_Up' });
  await dispatch('SCROLL_DOWN', { source: 'swipe', gesture: 'down' });
  await dispatch('SHORTCUT_1', { source: 'pose', gesture: 'ILoveYou' });
  assert.deepEqual(calls, [
    ['key', { key: 'tab', modifiers: ['cmd'] }],
    ['media', { key: 'volumeUp' }],
    ['scroll', { dy: -400, unit: 'pixel' }],
    ['key', { key: '4', modifiers: ['cmd', 'shift'] }]
  ]);
  assert.deepEqual(toasts[0], { text: '✌️ Victory / peace → Next app', detail: '⌘Tab' });
  assert.deepEqual(toasts[2], { text: '⬇️ Swipe down → Scroll down', detail: 'Scroll down' });
});

test('nothing is sent when it can\'t be, and the toast says why', async () => {
  const blocked = harness({ canPost: false });
  await blocked.dispatch('APP_NEXT', { gesture: 'Victory' });
  assert.deepEqual(blocked.calls, []);
  assert.equal(blocked.toasts[0].tone, 'warn');
  assert.match(blocked.toasts[0].detail, /Accessibility/);

  const chromeOnly = harness();
  await chromeOnly.dispatch('SKIP_AD', { gesture: 'ILoveYou' });
  assert.deepEqual(chromeOnly.calls, []);
  assert.match(chromeOnly.toasts[0].detail, /Chrome/);

  const failing = harness({ fail: true });
  await failing.dispatch('MEDIA_NEXT');
  assert.equal(failing.toasts[0].tone, 'warn');
  assert.match(failing.toasts[0].detail, /boom/);

  const own = harness();
  await own.dispatch('VOICE_CAPTURE_TOGGLE');
  await own.dispatch('SLEEP');
  assert.deepEqual(own.jester, ['voice']);
  assert.deepEqual(own.calls, []);
  assert.deepEqual(own.toasts, []);
});
