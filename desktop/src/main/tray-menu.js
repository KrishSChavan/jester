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
 * @param {boolean} state.voiceReady  false until voice capture works in the app
 */
export function trayModel({ engine, settings, missing = [], voiceReady = false }) {
  const status = STATUS_TEXT[engine?.state] || engine?.state || STATUS_TEXT[ENGINE.OFF];
  const on = !!settings?.enabled;
  const items = [
    { id: 'status', label: on ? status : 'Jester is off', enabled: false },
    { type: 'separator' },
    { id: 'enabled', label: 'Jester on', type: 'checkbox', checked: on },
    { id: 'pointer', label: 'Cursor control', type: 'checkbox', checked: !!settings?.pointerEnabled, enabled: on },
    voiceReady
      ? { id: 'voice', label: 'Voice commands', type: 'checkbox', checked: !!settings?.voiceEnabled, enabled: on }
      : { id: 'voice', label: 'Voice commands — coming soon', enabled: false },
    { type: 'separator' }
  ];
  if (missing.length) items.push({ id: 'permissions', label: `Allow ${missing.map((item) => item.label).join(' and ')}…` });
  items.push({ id: 'settings', label: 'Settings…' }, { type: 'separator' }, { id: 'quit', label: 'Quit Jester' });
  const tooltip = missing.length ? `Jester — needs ${missing.map((item) => item.label).join(' and ')}` : `Jester — ${on ? status : 'off'}`;
  return { tooltip, items };
}
