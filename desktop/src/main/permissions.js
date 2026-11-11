/**
 * Reading and asking for the OS permissions in permission-list.js.
 *
 * macOS keeps these per app, and only shows its camera and microphone prompt
 * once; after a "Don't Allow", the only way back is System Settings, which
 * `openSettings` opens at the right pane.
 *
 * Screen Recording lists an app only once it has asked to see the screen, and
 * Electron reads its status as granted or denied, never "not asked": so until
 * Jester asks, it's "not asked", and Allow… asks.
 */

import { app, desktopCapturer, shell, systemPreferences } from 'electron';
import { permissionItems } from './permission-list.js';

/** Long enough for macOS to put up its question; the answer comes later, in System Settings. */
const SCREEN_ASK_MS = 3000;
/** Whether macOS has been asked for the screen since Jester started. */
let askedForScreen = false;

function screenStatus() {
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return 'granted';
  return askedForScreen ? 'denied' : 'not-determined';
}

/**
 * Asks to see the screen once, which is how macOS asks the user: its prompt
 * comes up and Jester joins the list in System Settings, where it's allowed.
 * The one-pixel picture isn't kept.
 */
async function askForScreen() {
  askedForScreen = true;
  const asked = desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false }).catch(() => []);
  await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, SCREEN_ASK_MS))]);
  return screenStatus() === 'granted';
}

const SETTINGS_URLS = {
  darwin: {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  },
  win32: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone'
  }
};

export function readStatuses(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      camera: systemPreferences.getMediaAccessStatus('camera'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not-determined',
      screen: screenStatus()
    };
  }
  if (platform === 'win32') {
    return { camera: systemPreferences.getMediaAccessStatus('camera'), microphone: systemPreferences.getMediaAccessStatus('microphone') };
  }
  // Linux has no per-app switch for these.
  return { camera: 'granted', microphone: 'granted' };
}

export function readPermissions(platform = process.platform) {
  // Run from source, it's Electron that macOS lists and asks about.
  return permissionItems(platform, readStatuses(platform), { listedAs: platform === 'darwin' && !app.isPackaged ? 'Electron' : '' });
}

/** Shows the OS prompt where there is one; resolves when it is answered. */
export async function requestPermission(id, platform = process.platform) {
  if (platform !== 'darwin') return false;
  if (id === 'camera' || id === 'microphone') return systemPreferences.askForMediaAccess(id);
  if (id === 'accessibility') return systemPreferences.isTrustedAccessibilityClient(true);
  if (id === 'screen') return askForScreen();
  return false;
}

export function openSettings(id, platform = process.platform) {
  const url = SETTINGS_URLS[platform]?.[id];
  if (url) shell.openExternal(url);
  return !!url;
}
