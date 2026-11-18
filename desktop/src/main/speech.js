/**
 * Offline speech for the engine page: speech/service.js in a utilityProcess,
 * fed by the page's SpeechRecognition stand-in (src/preload/chrome-shim.cjs)
 * one utterance at a time.
 *
 * The page asks `jester:speech-available` before listening, then sends
 * begin / audio / end / abort for a numbered session and hears back
 * speech / partial / final / error for that session.
 *
 * The recognizer holds 0.6–1.9 GB depending on the model, so it is loaded
 * when a command begins and let go after IDLE_MS without one. Loading takes
 * 0.4–1.5 s, about what it takes to say a command; what is said meanwhile
 * waits in the service's queue behind the load and is heard once it's done.
 *
 * The continuous assistant keeps it loaded and listening, fed by a page of its
 * own (src/voice/voice.html). A command spoken with the shortcut, or the mic
 * opened for a yes, comes first: listening picks up again once that's over.
 */

import { app, ipcMain, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstalled, pickModel, SPEECH_CHOICES } from './speech/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, 'speech/service.js');
/** Only the engine page listens. */
const ENGINE_PAGE = 'jester://ext/src/offscreen/offscreen.html';
/** The always-on mic. */
const VOICE_PAGE = 'jester://app/voice/voice.html';
const IDLE_MS = 10 * 60 * 1000;
const SAMPLE_RATE = 16000;
/** A service that died is started again after this long, if something is listening. */
const REVIVE_MS = 1000;

/** If speech activity stops arriving, don't stay busy forever after a lost mic or service. */
const HEARING_MS = 10_000;

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
  /** Called with everything overheard, while the continuous assistant is on. */
  let listener = null;
  /** Called when his name starts something still being said. */
  let waker = null;
  /** Told what's been said so far at a pause that may be its end, and when they went on talking after all. */
  let pauser = null;
  /** Speech starts and stays active, including across a long answer. */
  let activity = null;
  /** The user's voice, sent to each service as it starts. */
  let voiceprint = null;
  /** Other ways the user's been heard to sound (voiceprint.js). */
  let learned = [];
  /** Where voices he wasn't sure of are kept for tuning, or '' (the user's choice, off until made). */
  let keepDir = '';
  let teaching = false;
  /** Kept across utility-process reloads so interruption checks follow playback. */
  let speaking = false;

  function send(message) {
    if (!current || current.contents.isDestroyed()) return;
    current.contents.send('jester:speech-event', { session: current.session, ...message });
  }

  function unload() {
    clearTimeout(idleTimer);
    const child = service;
    service = null;
    soundAt = 0;
    if (current) send({ type: 'error', detail: 'service-ended' });
    current = null;
    child?.kill();
  }

  /** Let the recognizer go once nothing has been said for a while. */
  function rest() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (current || listener) return rest();
      log(`speech: unloaded after ${IDLE_MS / 60000} idle minutes`);
      unload();
    }, IDLE_MS);
  }

  /** Last speech activity, and which utterance it belongs to; an older decode can't clear a newer voice. */
  let soundAt = 0;
  let soundStartedAt = null;

  function load() {
    if (service || quitting) return service;
    const child = utilityProcess.fork(SERVICE, [], { serviceName: 'Jester speech', stdio: 'pipe' });
    service = child;
    loadedModel = model;
    child.stderr?.on('data', (chunk) => log('speech:', String(chunk).trim()));
    child.on('message', (message) => {
      if (service !== child) return;
      if (message?.type === 'ready') return log('speech loaded:', message.model, `${message.loadMs} ms`);
      if (message?.type === 'speech' || message?.type === 'activity') {
        soundAt = Date.now();
        soundStartedAt = message.startedAt;
        if (listener && !current) activity?.(message);
      } else if (['heard', 'stranger', 'ended', 'final', 'error'].includes(message?.type) &&
        (message.startedAt === undefined || message.startedAt === soundStartedAt)) soundAt = 0;
      if (message?.type === 'heard') {
        // Every score, for tuning voiceprint.js against a real voice.
        // The voiceprint's own score too, when what was learned from use raised it.
        const raised = typeof message.enrolled === 'number' && message.score - message.enrolled >= 0.005 ? `, ${message.enrolled.toFixed(2)} by the voiceprint alone` : '';
        if (message.score !== null) log(`speech: ${message.unsure ? 'maybe your voice: with his name, or as an answer to him' : 'your voice'} (${message.score.toFixed(2)}${raised}, ${message.seconds.toFixed(1)} s)`);
        return void listener?.(message.text, message);
      }
      if (message?.type === 'wake') return void waker?.(message);
      if (message?.type === 'early') return void pauser?.(message.text, message);
      if (message?.type === 'resumed') return void pauser?.(null);
      if (message?.type === 'stranger') return log(`speech: not your voice (${message.score.toFixed(2)}, ${message.seconds.toFixed(1)} s)`);
      if (message?.type === 'error') log('speech error:', message.detail);
      if (message?.type === 'final' && current) {
        // Audio heard well short of the time taken means some never arrived.
        const heard = current.samples / SAMPLE_RATE;
        log('speech heard', JSON.stringify(message.text), `in ${message.decodeMs} ms · ${heard.toFixed(1)} s of audio over ${((Date.now() - current.started) / 1000).toFixed(1)} s`);
      }
      send(message);
      if (current && (message?.type === 'final' || message?.type === 'error')) {
        current = null;
        rest();
        resume();
      }
    });
    child.on('exit', (code) => {
      // Let go on purpose, or replaced: nothing to tidy.
      if (service !== child) return;
      service = null;
      soundAt = 0;
      if (current) send({ type: 'error', detail: 'service-ended' });
      current = null;
      if (quitting) return;
      log('speech service exited', code);
      if (listener) setTimeout(resume, REVIVE_MS);
    });
    // Messages queue behind this one, so audio sent while it loads waits.
    child.postMessage({ type: 'start', model });
    child.postMessage({ type: 'voiceprint', print: voiceprint, learned });
    child.postMessage({ type: 'keep', dir: keepDir });
    child.postMessage({ type: 'teaching', on: teaching });
    child.postMessage({ type: 'speaking', on: speaking });
    return child;
  }

  /** Back to listening, if that's wanted and nobody's holding the mic. */
  function resume() {
    if (listener && !current) load()?.postMessage({ type: 'listen' });
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
      resume();
    }
  });

  // The always-on mic, unless a command has it. Only ever the voice page's.
  ipcMain.on('jester:listen-audio', (event, samples) => {
    if (!String(event.senderFrame?.url || event.sender.getURL()).startsWith(VOICE_PAGE)) return;
    if (listener && !current && samples?.length) service?.postMessage({ type: 'audio', samples });
  });

  app.on('will-quit', () => {
    quitting = true;
    unload();
  });

  return {
    /**
     * The always-on mic's audio, from somewhere other than the voice page: a browser whose page is his window (the
     * web gateway), or the Mac using him in the cloud. 16 kHz mono, as the voice page sends it.
     */
    feed(samples) {
      if (listener && !current && samples?.length) service?.postMessage({ type: 'audio', samples });
    },
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
      if (listener && service && loadedModel !== model && !current) {
        unload();
        resume();
      }
    },
    /**
     * Every utterance from now on goes to `onHeard`, until stopListening; `onWake` hears his name as it's said.
     * `startedAt` on wake, pause, activity and heard identifies the same utterance, from when speech began.
     * `onPause(text, {unsure, startedAt})`: what's been said so far, at a pause that may be its end (it's `onHeard`'s, marked
     * `early`, if it was); `onPause(null)` when they went on talking instead.
     * `onActivity({startedAt})`: the utterance has begun or is still being spoken.
     * With `interrupt:true`, it is a verified user's voice, or partial `text`
     * without a voiceprint that the conversation must screen for playback echo.
     */
    listen(onHeard, onWake = () => undefined, onPause = () => undefined, onActivity = () => undefined) {
      listener = onHeard;
      waker = onWake;
      pauser = onPause;
      activity = onActivity;
      clearTimeout(idleTimer);
      resume();
    },
    /** Whatever's being heard right now doesn't count: he's just stopped talking, and it's him. */
    listenAfresh: () => resume(),
    /** Playback, for low-latency interruption checks. Never resets the mic. */
    setSpeaking(on) {
      const next = on === true;
      if (next === speaking) return;
      speaking = next;
      service?.postMessage({ type: 'speaking', on: speaking });
    },
    /** @param {number[]|null} print */
    /** `known`: other ways the user's been heard to sound, learned from use; they count only with a voiceprint. */
    setVoiceprint(print, known = []) {
      voiceprint = print;
      learned = print ? known : [];
      service?.postMessage({ type: 'voiceprint', print, learned });
    },
    /** Keeps voices he wasn't sure of in `dir`, for tuning; '' stops. */
    setKeeping(dir) {
      keepDir = dir || '';
      service?.postMessage({ type: 'keep', dir: keepDir });
    },
    /** While on, what's heard comes with its voice, and nobody's turned away. */
    setTeaching(on) {
      teaching = on;
      service?.postMessage({ type: 'teaching', on });
    },
    /** A voice is being heard right now, the always-on mic's: not the moment to start talking. */
    get hearing() {
      return !!listener && soundAt > 0 && Date.now() - soundAt < HEARING_MS;
    },
    stopListening() {
      soundAt = 0;
      if (!listener) return;
      listener = null;
      waker = null;
      pauser = null;
      activity = null;
      if (!current) service?.postMessage({ type: 'abort' });
      rest();
    }
  };
}
