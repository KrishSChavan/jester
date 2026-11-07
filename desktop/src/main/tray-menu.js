/**
 * What the menu-bar (tray) menu says. Pure: state in, a description of the
 * menu out; tray.js turns it into Electron's menu and routes the clicks.
 */

import { ENGINE, resumeGlyphs } from '../../../jester-extension/src/common/constants.js';
import { wakeHint } from './os-actions.js';

/** The popup's wording, minus what only makes sense in a browser. */
export const STATUS_TEXT = {
  [ENGINE.OFF]: 'Off',
  [ENGINE.STARTING]: 'Starting…',
  [ENGINE.RUNNING]: 'Watching for gestures',
  [ENGINE.SUSPENDED]: 'Paused',
  [ENGINE.SLEEPING]: 'Asleep',
  [ENGINE.NO_PERMISSION]: 'Camera access needed',
  [ENGINE.ERROR]: 'Something went wrong'
};

/**
 * @param {object} state
 * @param {{state:string, detail?:string}} state.engine
 * @param {object} state.settings  merged settings
 * @param {{id:string,label:string}[]} state.missing  needed permissions not yet granted
 * @param {string} [state.voice]  the speech model: 'ready' | 'off' | 'missing' (speech.js)
 * @param {{paired?:boolean}} [state.watch]  the Apple Watch (watch.js)
 * @param {string} [state.platform]
 * @returns {{tooltip:string, title:string, items:object[]}} title: beside the icon, on a Mac
 */
export function trayModel({ engine, settings, missing = [], voice = 'missing', watch = null, platform = process.platform }) {
  const on = !!settings?.enabled;
  // Off, the camera's closed and voice, the watch and talking to him carry on.
  const gestures = settings?.gesturesEnabled !== false;
  const asleep = on && engine?.state === ENGINE.SLEEPING;
  const status = asleep
    ? `${STATUS_TEXT[ENGINE.SLEEPING]} — ${wakeHint(resumeGlyphs(settings), platform)}`
    : !gestures ? 'Gestures off' : STATUS_TEXT[engine?.state] || engine?.state || STATUS_TEXT[ENGINE.OFF];
  const items = [
    { id: 'status', label: on ? status : 'Jester is off', enabled: false },
    { type: 'separator' },
    { id: 'enabled', label: 'Jester on', type: 'checkbox', checked: on },
    { id: 'gestures', label: 'Gestures', type: 'checkbox', checked: gestures, enabled: on },
    // It's the camera's: the watch has its own.
    { id: 'pointer', label: 'Cursor control', type: 'checkbox', checked: !!settings?.pointerEnabled, enabled: on && gestures }
  ];
  // A quick way to take the watch off the cursor.
  if (watch?.paired) items.push({ id: 'watch', label: 'Steer with Apple Watch', type: 'checkbox', checked: !!settings?.watchEnabled, enabled: on });
  // Asleep, the mic is off: this is the way back when no gesture is bound to it.
  if (asleep) items.push({ id: 'wake', label: 'Wake Jester' });
  else if (on && engine?.state === ENGINE.RUNNING) items.push({ id: 'sleep', label: 'Put Jester to sleep' });
  if (voice === 'missing') items.push({ id: 'voice', label: 'Voice commands — speech model not installed', enabled: false });
  else {
    items.push({ id: 'voice', label: 'Voice commands', type: 'checkbox', checked: !!settings?.voiceEnabled, enabled: on });
    // The shortcut is the global one; the menu only shows it.
    if (on && settings?.voiceEnabled) items.push({ id: 'listen', label: 'Speak a command', accelerator: 'Alt+Shift+J', registerAccelerator: false });
    // The mic stays open with this on: the way to close it is always one click away.
    if (on && settings?.voiceEnabled) items.push({ id: 'continuous', label: 'Continuous assistant', type: 'checkbox', checked: !!settings?.continuousAssistant });
  }
  items.push({ type: 'separator' });
  if (missing.length) items.push({ id: 'permissions', label: `Allow ${missing.map((item) => item.label).join(' and ')}…` });
  items.push({ id: 'talk', label: 'Talk to Jester…' }, { id: 'settings', label: 'Settings…' }, { type: 'separator' }, { id: 'restart', label: 'Restart Jester' }, { id: 'quit', label: 'Quit Jester' });
  const tooltip = missing.length ? `Jester — needs ${missing.map((item) => item.label).join(' and ')}` : `Jester — ${on ? status : 'off'}`;
  // The extension's badge says the same: asleep looks just like awake otherwise.
  return { tooltip, title: asleep ? 'Zz' : '', items };
}
