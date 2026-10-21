/**
 * The worker's half of the engine, for the desktop.
 *
 * In the extension, service-worker.js answers the engine's settings request,
 * pushes settings and calibrations as they change, and receives what the
 * engine decides: gestures, cursor frames, voice. Here the main process does
 * that, and hands each decision to whoever acts on it (OS actions, overlay).
 */

import { MSG, mergeSettings } from '../../../jester-extension/src/common/constants.js';
import { loadCalibration } from '../../../jester-extension/src/common/gaze-store.js';
import { onMessage, onStorageChanged, post, storage } from './chrome-bridge.js';

export const ENGINE_PAGE = 'jester://ext/src/offscreen/offscreen.html';

/**
 * The extension's settings, except that the desktop app starts switched on:
 * opening it is the request to run. Settings can still turn it off.
 */
export function desktopSettings(stored) {
  return mergeSettings({ enabled: true, ...(stored || {}) });
}

export async function loadSettings() {
  const { settings } = await storage.local.get('settings');
  return desktopSettings(settings);
}

/**
 * @param {object} hooks
 * @param {() => ({w:number,h:number})|null} hooks.screen  the display the cursor aims at
 * @param {() => 'fullscreen'|'windowed'} [hooks.context]
 * @param {(message) => void} [hooks.onTrigger]  a gesture fired an action
 * @param {(cursor) => void} [hooks.onCursor]  ~20/s while the cursor is up
 * @param {(message) => void} [hooks.onVoice]  pill state, levels, transcripts
 * @param {(text:string) => void} [hooks.onVoiceCommand]  a finished utterance
 * @param {(status) => void} [hooks.onStatus]
 * @param {(telemetry) => void} [hooks.onTelemetry]
 */
export function startEngineHost(hooks) {
  const fromEngine = (sender) => String(sender?.url || '').startsWith(ENGINE_PAGE);

  onMessage(async (message, sender) => {
    if (!fromEngine(sender)) return undefined;
    switch (message?.type) {
      case MSG.SETTINGS_REQUEST:
        return {
          settings: await loadSettings(),
          suspend: false,
          context: hooks.context?.() || 'windowed',
          screen: hooks.screen?.() || null,
          calibration: await loadCalibration()
        };
      case MSG.TRIGGER:
        hooks.onTrigger?.(message);
        return undefined;
      case MSG.CURSOR:
        hooks.onCursor?.(message.cursor);
        return undefined;
      case MSG.VOICE:
        hooks.onVoice?.(message);
        return undefined;
      case MSG.VOICE_COMMAND:
        hooks.onVoiceCommand?.(String(message.text || '').slice(0, 4000));
        return undefined;
      case MSG.ENGINE_STATUS:
        hooks.onStatus?.(message);
        return undefined;
      case MSG.TELEMETRY:
        hooks.onTelemetry?.(message.telemetry);
        return undefined;
      default:
        return undefined;
    }
  });

  // service-worker.js pushes the same two things when storage changes.
  onStorageChanged((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) post({ type: MSG.ENGINE_SETTINGS, settings: desktopSettings(changes.settings.newValue) });
    if (changes.gazeCalibration) post({ type: MSG.CALIBRATION_MODEL, calibration: changes.gazeCalibration.newValue || null });
  });

  return {
    /** Tell the engine which display it is aiming at, e.g. after a display change. */
    setScreen(screen) {
      post({ type: MSG.ENGINE_CONFIG, screen });
    },
    suspend(suspend) {
      post({ type: MSG.ENGINE_CONFIG, suspend: !!suspend });
    },
    voice(action) {
      post({ type: MSG.VOICE_CONTROL, action });
    }
  };
}
