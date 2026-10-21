/**
 * What each bindable action does to the computer, on each OS.
 *
 * Pure and import-free, so the main process (which sends the input through
 * jester-driver) and the Settings page (which offers only what can happen)
 * share one answer. An action becomes a plan:
 *
 *   { kind: 'key', key, modifiers }   a shortcut, e.g. ⌘⇧5
 *   { kind: 'media', key }            a media/brightness key
 *   { kind: 'scroll', dy }            the wheel, at the cursor (pixels, + is up)
 *   { kind: 'system', op }            something with no key (Windows lock)
 *   { kind: 'jester', op }            Jester's own: voice, calibrate, sleep
 *   { kind: 'none' }
 *   { kind: 'unsupported', why }
 *
 * The defaults are each OS's own shortcuts, which most apps follow.
 */

const MAC = 'darwin';
/** One SCROLL_* step at the default scrollStep (0.6), in pixels. */
const SCROLL_PIXELS = 400;
const ONLY_IN_CHROME = 'Works in Chrome once the extension is linked to Jester Desktop';

const key = (name, ...modifiers) => ({ kind: 'key', key: name, modifiers });
const media = (name) => ({ kind: 'media', key: name });
const unsupported = (why) => ({ kind: 'unsupported', why });

const MODIFIERS = { cmd: 'cmd', command: 'cmd', ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', win: 'win', windows: 'win', fn: 'fn' };

/** Other spellings of keys jester-driver knows (its protocol.rs canonical_key). */
const KEY_ALIASES = {
  return: 'enter', esc: 'escape', del: 'delete', pgup: 'pageup', pgdn: 'pagedown',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash',
  ';': 'semicolon', "'": 'quote', '`': 'grave', '[': 'leftbracket', ']': 'rightbracket'
};
const NAMED_KEYS = new Set([
  'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown',
  'minus', 'equal', 'comma', 'period', 'slash', 'backslash', 'semicolon', 'quote', 'grave', 'leftbracket', 'rightbracket'
]);
const knownKey = (name) => /^[a-z0-9]$/.test(name) || NAMED_KEYS.has(name) || /^f([1-9]|1[0-9]|20)$/.test(name);

/**
 * A shortcut as typed in Settings — "cmd+shift+4", "Ctrl + Alt + T" — or
 * null if it isn't one: exactly one key the driver knows, last.
 */
export function parseShortcut(text) {
  const parts = String(text || '').toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const name = KEY_ALIASES[parts.at(-1)] || parts.at(-1);
  if (MODIFIERS[name] || !knownKey(name)) return null;
  const modifiers = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part];
    if (!modifier) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return key(name, ...modifiers);
}

/**
 * @param {string} action  an ACTIONS id
 * @param {string} platform  process.platform
 * @param {object} [settings]  for scrollStep and desktopShortcuts
 */
export function osPlan(action, platform, settings = {}) {
  const mac = platform === MAC;
  const primary = mac ? 'cmd' : 'ctrl';
  const scroll = Math.round(SCROLL_PIXELS * ((Number(settings.scrollStep) || 0.6) / 0.6));
  switch (action) {
    case 'NONE':
      return { kind: 'none' };
    // There is one play/pause key; "play" and "pause" both press it.
    case 'PLAY_PAUSE':
    case 'PLAY':
    case 'PAUSE':
      return media('play');
    case 'NEXT_VIDEO':
    case 'MEDIA_NEXT':
      return media('next');
    case 'MEDIA_PREV':
      return media('previous');
    case 'VOLUME_UP':
      return media('volumeUp');
    case 'VOLUME_DOWN':
      return media('volumeDown');
    case 'MUTE_TOGGLE':
      return media('mute');
    case 'BRIGHTNESS_UP':
      return mac ? media('brightnessUp') : unsupported('Brightness keys exist only on a Mac');
    case 'BRIGHTNESS_DOWN':
      return mac ? media('brightnessDown') : unsupported('Brightness keys exist only on a Mac');
    // Video players and most media apps seek with the arrow keys.
    case 'SEEK_FORWARD':
      return key('right');
    case 'SEEK_BACK':
      return key('left');
    case 'FULLSCREEN_TOGGLE':
      return mac ? key('f', 'ctrl', 'cmd') : key('f11');
    case 'EXIT_FULLSCREEN':
      return key('escape');
    case 'SCROLL_UP':
      return { kind: 'scroll', dy: scroll };
    case 'SCROLL_DOWN':
      return { kind: 'scroll', dy: -scroll };
    case 'PAGE_TOP':
      return mac ? key('up', 'cmd') : key('home', 'ctrl');
    case 'PAGE_BOTTOM':
      return mac ? key('down', 'cmd') : key('end', 'ctrl');
    case 'HISTORY_BACK':
      return mac ? key('leftbracket', 'cmd') : key('left', 'alt');
    case 'HISTORY_FORWARD':
      return mac ? key('rightbracket', 'cmd') : key('right', 'alt');
    case 'RELOAD':
      return mac ? key('r', 'cmd') : key('f5');
    case 'TAB_NEXT':
      return key('tab', 'ctrl');
    case 'TAB_PREV':
      return key('tab', 'ctrl', 'shift');
    case 'TAB_NEW':
      return key('t', primary);
    case 'TAB_CLOSE':
      return key('w', primary);
    case 'TAB_REOPEN':
      return key('t', primary, 'shift');
    case 'WINDOW_NEXT':
    case 'APP_NEXT':
      return mac ? key('tab', 'cmd') : key('tab', 'alt');
    case 'APP_PREV':
      return mac ? key('tab', 'cmd', 'shift') : key('tab', 'alt', 'shift');
    case 'SHOW_ALL_WINDOWS':
      return mac ? key('up', 'ctrl') : key('tab', 'win');
    case 'DESKTOP_LEFT':
      return mac ? key('left', 'ctrl') : key('left', 'win', 'ctrl');
    case 'DESKTOP_RIGHT':
      return mac ? key('right', 'ctrl') : key('right', 'win', 'ctrl');
    case 'SHOW_DESKTOP':
      return mac ? key('f11') : key('d', 'win');
    // The capture toolbar on both, rather than a silent full-screen grab.
    case 'SCREENSHOT':
      return mac ? key('5', 'cmd', 'shift') : key('s', 'win', 'shift');
    // Windows reserves Win+L for real keyboards.
    case 'LOCK_SCREEN':
      return mac ? key('q', 'ctrl', 'cmd') : { kind: 'system', op: 'lock' };
    case 'SHORTCUT_1':
    case 'SHORTCUT_2':
    case 'SHORTCUT_3':
      return parseShortcut(settings.desktopShortcuts?.[action]) || unsupported('Set this shortcut in Jester’s Settings');
    case 'VOICE_CAPTURE_TOGGLE':
      return { kind: 'jester', op: 'voice' };
    case 'CALIBRATE_POINTER':
      return { kind: 'jester', op: 'calibrate' };
    // The engine itself goes to sleep; there is nothing to send.
    case 'SLEEP':
      return { kind: 'none' };
    case 'SPEED_UP':
    case 'SPEED_DOWN':
    case 'SKIP_AD':
    case 'TAB_MOVE_LEFT':
    case 'TAB_MOVE_RIGHT':
      return unsupported(ONLY_IN_CHROME);
    default:
      return unsupported('Jester doesn’t know that action');
  }
}

/** Whether Settings should offer an action for binding on this OS. */
export function bindable(action, platform) {
  if (/^SHORTCUT_\d$/.test(action)) return true;
  return osPlan(action, platform).kind !== 'unsupported';
}

/** What the desktop calls an action, where the extension's name would mislead. */
export const DESKTOP_LABELS = {
  // A computer has one play/pause key; these press it too.
  PLAY: 'Play (presses play/pause)',
  PAUSE: 'Pause (presses play/pause)',
  NEXT_VIDEO: 'Next track or video',
  SEEK_FORWARD: 'Skip forward (→ key)',
  SEEK_BACK: 'Skip back (← key)',
  VOLUME_UP: 'Volume up',
  VOLUME_DOWN: 'Volume down',
  MUTE_TOGGLE: 'Mute / unmute',
  RELOAD: 'Reload',
  WINDOW_NEXT: 'Next app'
};

const MAC_GLYPHS = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', fn: 'fn ' };
const KEY_NAMES = { leftbracket: '[', rightbracket: ']', left: '←', right: '→', up: '↑', down: '↓', escape: 'Esc', enter: '↩', tab: 'Tab', space: 'Space', backspace: '⌫', delete: '⌦', home: 'Home', end: 'End' };
const MEDIA_NAMES = { play: 'Play/pause key', next: 'Next-track key', previous: 'Previous-track key', volumeUp: 'Volume-up key', volumeDown: 'Volume-down key', mute: 'Mute key', brightnessUp: 'Brightness-up key', brightnessDown: 'Brightness-down key' };

/** A plan in words, for the overlay's toast: "⌘⇧5", "Ctrl+Shift+Tab", "Volume-up key". */
export function describePlan(plan, platform) {
  if (!plan) return '';
  if (plan.kind === 'key') {
    const keyName = KEY_NAMES[plan.key] || plan.key.toUpperCase();
    if (platform === MAC) return `${plan.modifiers.map((m) => MAC_GLYPHS[m] || m).join('')}${keyName}`;
    const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', cmd: 'Win', fn: 'Fn' };
    return [...plan.modifiers.map((m) => names[m] || m), keyName].join('+');
  }
  if (plan.kind === 'media') return MEDIA_NAMES[plan.key] || plan.key;
  if (plan.kind === 'scroll') return plan.dy > 0 ? 'Scroll up' : 'Scroll down';
  if (plan.kind === 'system' && plan.op === 'lock') return 'Lock';
  if (plan.kind === 'unsupported') return plan.why;
  return '';
}

/**
 * Whether the front window fills its display: the desktop's version of the
 * extension's "fullscreen" context, which picks the binding set.
 * `window` and `displays` must be in the same units.
 */
export function fillsDisplay(window, displays, slack = 2) {
  if (!window || !(window.w > 0) || !(window.h > 0)) return false;
  return displays.some(
    (d) => Math.abs(window.x - d.x) <= slack && Math.abs(window.y - d.y) <= slack && Math.abs(window.w - d.width) <= slack && Math.abs(window.h - d.height) <= slack
  );
}
