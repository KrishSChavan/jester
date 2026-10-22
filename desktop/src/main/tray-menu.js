/**
 * What the menu-bar (tray) menu says. Pure: state in, a description of the
 * menu out; tray.js turns it into Electron's menu and routes the clicks.
 */

import { ENGINE } from '../../../jester-extension/src/common/constants.js';

/** The popup's wording, minus what only makes sense in a browser. */
export const STATUS_TEXT = {
  [ENGINE.OFF]: 'Off',
  [ENGINE.STARTING]: 'Starting…',
  [ENGINE.RUNNING]: 'Watching for gestures',
  [ENGINE.SUSPENDED]: 'Paused',
  [ENGINE.SLEEPING]: 'Asleep — make your wake gesture',
  [ENGINE.NO_PERMISSION]: 'Camera access needed',
  [ENGINE.ERROR]: 'Something went wrong'
};

/**
 * @param {object} state
 * @param {{state:string, detail?:string}} state.engine
 * @param {object} state.settings  merged settings
 * @param {{id:string,label:string}[]} state.missing  needed permissions not yet granted
 * @param {string} [state.voice]  the speech model: 'ready' | 'off' | 'missing' (speech.js)
 */
export function trayModel({ engine, settings, missing = [], voice = 'missing' }) {
  const status = STATUS_TEXT[engine?.state] || engine?.state || STATUS_TEXT[ENGINE.OFF];
  const on = !!settings?.enabled;
  const items = [
    { id: 'status', label: on ? status : 'Jester is off', enabled: false },
    { type: 'separator' },
    { id: 'enabled', label: 'Jester on', type: 'checkbox', checked: on },
    { id: 'pointer', label: 'Cursor control', type: 'checkbox', checked: !!settings?.pointerEnabled, enabled: on }
  ];
  if (voice === 'missing') items.push({ id: 'voice', label: 'Voice commands — speech model not installed', enabled: false });
  else {
    items.push({ id: 'voice', label: 'Voice commands', type: 'checkbox', checked: !!settings?.voiceEnabled, enabled: on });
    // The shortcut is the global one; the menu only shows it.
    if (on && settings?.voiceEnabled) items.push({ id: 'listen', label: 'Speak a command', accelerator: 'Alt+Shift+J', registerAccelerator: false });
  }
  items.push({ type: 'separator' });
  if (missing.length) items.push({ id: 'permissions', label: `Allow ${missing.map((item) => item.label).join(' and ')}…` });
  items.push({ id: 'settings', label: 'Settings…' }, { type: 'separator' }, { id: 'quit', label: 'Quit Jester' });
  const tooltip = missing.length ? `Jester — needs ${missing.map((item) => item.label).join(' and ')}` : `Jester — ${on ? status : 'off'}`;
  return { tooltip, items };
}
