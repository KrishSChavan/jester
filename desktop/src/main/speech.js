/**
 * Offline speech for the engine page: speech/service.js in a utilityProcess,
 * fed by the page's SpeechRecognition stand-in (src/preload/chrome-shim.cjs)
 * one utterance at a time.
 *
 * The page asks `jester:speech-available` before listening, then sends
 * begin / audio / end / abort for a numbered session and hears back
 * speech / partial / final / error for that session.
 *
 * The recognizer holds 250–800 MB depending on the model, so it is loaded
 * when a command begins and let go after IDLE_MS without one. Loading takes
 * 0.5–1.4 s, about what it takes to say a command; what is said meanwhile
 * waits in the service's queue behind the load and is heard once it's done.
 */

import { app, ipcMain, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstalled, pickModel, SPEECH_CHOICES } from './speech/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, 'speech/service.js');
/** Only the engine page listens. */
const ENGINE_PAGE = 'jester://ext/src/offscreen/offscreen.html';
const IDLE_MS = 10 * 60 * 1000;
const SAMPLE_RATE = 16000;

export function startSpeech({ log = () => undefined } = {}) {
  /** The service, from the moment it's asked to load until it's let go. */
  let service = null;
  let loadedModel = null;
  let model = pickModel(undefined);
  let enabled = false;
  let quitting = false;
  let idleTimer = null;
  /** The utterance being heard: who asked, which of their sessions, and how much audio has come. */
  let current = null;

  function send(message) {
    if (!current || current.contents.isDestroyed()) return;
    current.contents.send('jester:speech-event', { session: current.session, ...message });
  }

  function unload() {
    clearTimeout(idleTimer);
    const child = service;
    service = null;
    if (current) send({ type: 'error', detail: 'service-ended' });
    current = null;
    child?.kill();
  }

  /** Let the recognizer go once nothing has been said for a while. */
  function rest() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (current) return rest();
      log(`speech: unloaded after ${IDLE_MS / 60000} idle minutes`);
      unload();
    }, IDLE_MS);
  }

  function load() {
    if (service || quitting) return service;
    const child = utilityProcess.fork(SERVICE, [], { serviceName: 'Jester speech', stdio: 'pipe' });
    service = child;
    loadedModel = model;
    child.stderr?.on('data', (chunk) => log('speech:', String(chunk).trim()));
    child.on('message', (message) => {
      if (service !== child) return;
      if (message?.type === 'ready') return log('speech loaded:', message.model, `${message.loadMs} ms`);
      if (message?.type === 'error') log('speech error:', message.detail);
      if (message?.type === 'final' && current) {
        // Audio heard well short of the time taken means some never arrived.
        const heard = current.samples / SAMPLE_RATE;
        log('speech heard', JSON.stringify(message.text), `in ${message.decodeMs} ms · ${heard.toFixed(1)} s of audio over ${((Date.now() - current.started) / 1000).toFixed(1)} s`);
      }
      send(message);
      if (message?.type === 'final' || message?.type === 'error') {
        current = null;
        rest();
      }
    });
    child.on('exit', (code) => {
      // Let go on purpose, or replaced: nothing to tidy.
      if (service !== child) return;
      service = null;
      if (current) send({ type: 'error', detail: 'service-ended' });
      current = null;
      if (!quitting) log('speech service exited', code);
    });
    // Messages queue behind this one, so audio sent while it loads waits.
    child.postMessage({ type: 'start', model });
    return child;
  }

  const fromEngine = (event) => String(event.senderFrame?.url || event.sender.getURL()).startsWith(ENGINE_PAGE);

  // What SpeechRecognition.available() says, in the Web Speech API's words.
  ipcMain.handle('jester:speech-available', (event) => {
    if (!fromEngine(event)) return 'unavailable';
    if (!model) return 'downloadable';
    return enabled ? 'available' : 'unavailable';
  });

  ipcMain.on('jester:speech', (event, op, session, payload) => {
    if (!fromEngine(event)) return;
    if (op === 'begin') {
      // A new choice of model takes over at the next command.
      if (service && loadedModel !== model && !current) unload();
      const child = enabled && model ? load() : null;
      if (!child) {
        event.sender.send('jester:speech-event', { session, type: 'error', detail: 'not-ready' });
        return;
      }
      clearTimeout(idleTimer);
      current = { contents: event.sender, session, started: Date.now(), samples: 0 };
      child.postMessage({ type: 'begin' });
      const mic = payload || {};
      log(`speech: listening (${loadedModel}; mic ${mic.sampleRate || '?'} Hz, echo cancellation ${mic.echoCancellation}, noise suppression ${mic.noiseSuppression}, auto gain ${mic.autoGainControl})`);
      return;
    }
    if (!current || current.session !== session || current.contents !== event.sender) return;
    if (op === 'audio' && payload?.length) {
      current.samples += payload.length;
      service?.postMessage({ type: 'audio', samples: payload });
    } else if (op === 'end') service?.postMessage({ type: 'end' });
    else if (op === 'abort') {
      current = null;
      service?.postMessage({ type: 'abort' });
      rest();
    }
  });

  app.on('will-quit', () => {
    quitting = true;
    unload();
  });

  return {
    /** 'ready' | 'off' (voice commands switched off) | 'missing' (no model downloaded) */
    get state() {
      if (!model) return 'missing';
      return enabled ? 'ready' : 'off';
    },
    /** The model in use, and the choices with whether each is downloaded, for Settings. */
    get model() {
      return model;
    },
    get choices() {
      return SPEECH_CHOICES.map((choice) => ({ ...choice, installed: isInstalled(choice.id) }));
    },
    /** Voice off lets the recognizer go at once. */
    setEnabled(on) {
      enabled = !!on;
      if (!enabled && service) {
        log('speech: unloaded (voice commands off)');
        unload();
      }
    },
    /** The setting's choice, or the best downloaded model without one. */
    setModel(wanted) {
      model = pickModel(wanted);
    }
  };
}
