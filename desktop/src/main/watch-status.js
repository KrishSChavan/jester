/**
 * What Settings says about the Apple Watch. Pure: the watch's state (watch.js)
 * and the settings in, words out.
 */

const BLUETOOTH_TROUBLE = {
  off: 'Turn Bluetooth on to use your watch.',
  denied: 'Bluetooth is off for Electron: turn it on in System Settings › Privacy & Security › Bluetooth.',
  unsupported: 'This Mac can’t do what the watch needs over Bluetooth.',
  failed: 'Bluetooth wouldn’t start. Try turning it off and on.'
};

/** The line under the switch. */
export function watchStatus(watch, settings) {
  if (!watch?.built) return 'Needs its Bluetooth helper. In desktop/, run: npm run watch';
  if (!settings?.enabled) return 'Jester is off.';
  if (!settings.watchEnabled) return 'Move the cursor with your wrist, using Jester on your watch.';
  if (watch.problem) return watch.problem;
  if (BLUETOOTH_TROUBLE[watch.bluetooth]) return BLUETOOTH_TROUBLE[watch.bluetooth];
  if (watch.bluetooth !== 'on') return 'Starting Bluetooth…';
  if (!watch.paired) return 'Pair your watch to start.';
  if (watch.steering) return 'Steering. Pinch to click, twice to double-click, pinch and hold to drag. Move the real mouse to take over.';
  if (watch.connected) return 'Connected. Tap Start on your watch.';
  return 'Waiting for your watch: open Jester on it.';
}

/** The pairing row: what it says and what its button does. */
export function watchPairing(watch, settings) {
  const on = !!watch?.built && !!settings?.enabled && !!settings?.watchEnabled && watch?.bluetooth === 'on';
  if (watch?.pairing === 'waiting') {
    return { title: 'Pairing…', hint: 'On your watch, open Jester and tap Pair.', action: 'They match', op: 'confirm', disabled: true, cancellable: true };
  }
  if (watch?.pairing) {
    return { title: watch.pairing, hint: 'Is this the number on your watch? Only say so if it is.', action: 'They match', op: 'confirm', disabled: false, cancellable: true };
  }
  if (watch?.paired) return { title: 'Your watch is paired', hint: 'Forget it to stop it steering this Mac for good.', action: 'Forget', op: 'forget', disabled: false, cancellable: false };
  return { title: 'Pair your watch', hint: 'Once only. You’ll compare a number on both screens.', action: 'Pair', op: 'pair', disabled: !on, cancellable: false };
}
