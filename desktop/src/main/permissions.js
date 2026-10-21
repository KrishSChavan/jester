/**
 * Reading and asking for the OS permissions in permission-list.js.
 *
 * macOS keeps these per app, and only shows its camera and microphone prompt
 * once; after a "Don't Allow", the only way back is System Settings, which
 * `openSettings` opens at the right pane.
 */

import { shell, systemPreferences } from 'electron';
import { permissionItems } from './permission-list.js';

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
      screen: systemPreferences.getMediaAccessStatus('screen')
    };
  }
  if (platform === 'win32') {
    return { camera: systemPreferences.getMediaAccessStatus('camera'), microphone: systemPreferences.getMediaAccessStatus('microphone') };
  }
  // Linux has no per-app switch for these.
  return { camera: 'granted', microphone: 'granted' };
}

export function readPermissions(platform = process.platform) {
  return permissionItems(platform, readStatuses(platform));
}

/** Shows the OS prompt where there is one; resolves when it is answered. */
export async function requestPermission(id, platform = process.platform) {
  if (platform !== 'darwin') return false;
  if (id === 'camera' || id === 'microphone') return systemPreferences.askForMediaAccess(id);
  if (id === 'accessibility') return systemPreferences.isTrustedAccessibilityClient(true);
  return false;
}

export function openSettings(id, platform = process.platform) {
  const url = SETTINGS_URLS[platform]?.[id];
  if (url) shell.openExternal(url);
  return !!url;
}
