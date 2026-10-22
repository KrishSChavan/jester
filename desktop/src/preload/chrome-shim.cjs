/**
 * The slice of `chrome.*` the extension's pages use, for the desktop app.
 *
 * The engine (offscreen.js) and the calibration screen run here unchanged. In
 * Chrome they talk to the service worker with `chrome.runtime` messages; here
 * the main process plays the worker, over IPC. Messages keep Chrome's shape:
 * a page's message reaches the main process and every other page, and a
 * listener is called as `(message, sender, sendResponse)`, with `sender.url`
 * set by the main process, never by the page — `senders.js` relies on that.
 */

const { contextBridge, ipcRenderer } = require('electron');

const RUNTIME_ID = 'jester-desktop';
const ROOT = 'jester://ext/';

const messageListeners = new Set();
const storageListeners = new Set();

ipcRenderer.on('jester:message', (_event, message, sender) => {
  for (const listener of messageListeners) {
    try {
      listener(message, sender, () => undefined);
    } catch (err) {
      console.error(err);
    }
  }
});

ipcRenderer.on('jester:storage-changed', (_event, changes, area) => {
  for (const listener of storageListeners) {
    try {
      listener(changes, area);
    } catch (err) {
      console.error(err);
    }
  }
});

const event = (listeners) => ({
  addListener: (fn) => void listeners.add(fn),
  removeListener: (fn) => void listeners.delete(fn),
  hasListener: (fn) => listeners.has(fn)
});

const area = (name) => ({
  get: (keys) => ipcRenderer.invoke('jester:storage', name, 'get', keys ?? null),
  set: (items) => ipcRenderer.invoke('jester:storage', name, 'set', items),
  remove: (keys) => ipcRenderer.invoke('jester:storage', name, 'remove', keys)
});

const api = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (path = '') => ROOT + String(path).replace(/^\/+/, ''),
    sendMessage: (message) => ipcRenderer.invoke('jester:message', message),
    onMessage: event(messageListeners)
  },
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: event(storageListeners)
  }
};

// Electron pages already have a `window.chrome`, so exposeInMainWorld('chrome')
// refuses. Hang the two namespaces on the existing object instead, from inside
// the page's own world, before any of its scripts run.
//
// `window.close()` goes to the main process too. A page closing itself (the
// calibration screen's Done) would otherwise close its window on the spot,
// mid-way through leaving full screen, which macOS loses.
contextBridge.executeInMainWorld({
  func: (shim, closeWindow) => {
    if (typeof globalThis.chrome !== 'object' || globalThis.chrome === null) {
      Object.defineProperty(globalThis, 'chrome', { value: {}, configurable: true, writable: true });
    }
    for (const name of ['runtime', 'storage']) {
      Object.defineProperty(globalThis.chrome, name, { value: shim[name], configurable: true, writable: true });
    }
    Object.defineProperty(globalThis, 'close', { value: () => closeWindow(), configurable: true, writable: true });
  },
  args: [api, () => ipcRenderer.send('jester:close-window')]
});

// ---------------------------------------------------------------------------
// Speech, for the engine page only
// ---------------------------------------------------------------------------
//
// voice.js uses the Web Speech API's on-device recognizer, which Electron
// doesn't have. This is a SpeechRecognition of the same shape — available(),
// processLocally, start/stop/abort, onstart/onresult/onerror/onend — whose
// audio goes to the app's own offline recognizer (src/main/speech.js).

const ENGINE_PAGE = 'jester://ext/src/offscreen/offscreen.html';

if (location.href.startsWith(ENGINE_PAGE)) {
  let listener = null;
  ipcRenderer.on('jester:speech-event', (_event, message) => listener?.(message));
  const speech = {
    available: () => ipcRenderer.invoke('jester:speech-available'),
    // `payload`: the samples, for 'audio'; what the mic is doing, for 'begin'.
    send: (op, session, payload) => ipcRenderer.send('jester:speech', op, session, payload),
    // Once: a function crossing the bridge twice needn't arrive as the same one.
    listen: (fn) => void (listener = fn)
  };

  contextBridge.executeInMainWorld({
    func: (speech) => {
      /** Silence before anything is said: Chrome's recognizer gives up about as soon. */
      const NO_SPEECH_MS = 8000;
      /** Same-origin for this page; see src/main/files.js. */
      const WORKLET = new URL('/_desktop/worklets/speech-capture.js', location.href).href;
      /**
       * The raw mic. Each command opens a fresh stream, and noise suppression
       * and auto-gain spend their first moments adapting — just when the first
       * word arrives.
       */
      const MIC = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      let sessions = 0;
      /** The recognizer listening for each session. */
      const live = new Map();
      speech.listen((message) => live.get(message.session)?.heard(message));

      const resultList = (text, isFinal) => {
        const alternative = { transcript: text, confidence: 1 };
        const result = Object.assign([alternative], { isFinal, item: (i) => (i === 0 ? alternative : null) });
        return Object.assign([result], { item: (i) => (i === 0 ? result : null) });
      };

      class LocalSpeechRecognition {
        static async available() {
          return speech.available();
        }
        static async install() {
          return false;
        }
        constructor() {
          this.processLocally = false;
          this.lang = 'en-US';
          this.continuous = false;
          this.interimResults = false;
          this.maxAlternatives = 1;
          this.onstart = this.onresult = this.onerror = this.onend = null;
          this.session = 0;
          this.over = false;
        }
        start() {
          this.run().catch(() => this.fail('audio-capture'));
        }
        /** Finish: whatever has been heard so far becomes the result. */
        stop() {
          if (this.session && !this.over) speech.send('end', this.session);
        }
        abort() {
          if (this.over) return;
          this.over = true;
          if (this.session) speech.send('abort', this.session);
          this.teardown();
        }
        async run() {
          const session = ++sessions;
          this.session = session;
          const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false }).catch((error) => {
            this.fail(error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
            return null;
          });
          if (!stream) return;
          this.stream = stream;
          if (this.over) return this.teardown();
          // The recognizer wants 16 kHz mono; the audio context resamples to it.
          this.context = new AudioContext({ sampleRate: 16000 });
          await this.context.audioWorklet.addModule(WORKLET);
          if (this.over) return this.teardown();
          live.set(session, this);
          const { echoCancellation, noiseSuppression, autoGainControl, sampleRate } = stream.getAudioTracks()[0]?.getSettings() || {};
          speech.send('begin', session, { echoCancellation, noiseSuppression, autoGainControl, sampleRate });
          const source = this.context.createMediaStreamSource(stream);
          const tap = new AudioWorkletNode(this.context, 'jester-speech-capture');
          tap.port.onmessage = ({ data }) => {
            if (!this.over) speech.send('audio', session, data);
          };
          source.connect(tap);
          // Connected through, so the graph keeps pulling it; it outputs silence.
          tap.connect(this.context.destination);
          this.context.resume().catch(() => undefined);
          this.silence = setTimeout(() => this.fail('no-speech'), NO_SPEECH_MS);
          this.onstart?.();
        }
        heard(message) {
          if (message.session !== this.session || this.over) return;
          if (message.type === 'speech') clearTimeout(this.silence);
          else if (message.type === 'partial' && this.interimResults && message.text) this.onresult?.({ resultIndex: 0, results: resultList(message.text, false) });
          else if (message.type === 'final') {
            if (message.text) this.onresult?.({ resultIndex: 0, results: resultList(message.text, true) });
            this.finish();
          } else if (message.type === 'error') this.fail(message.detail === 'not-ready' ? 'service-not-allowed' : 'aborted');
        }
        fail(error) {
          if (this.over) return;
          this.over = true;
          if (this.session) speech.send('abort', this.session);
          this.teardown();
          this.onerror?.({ error });
          this.onend?.();
        }
        finish() {
          if (this.over) return;
          this.over = true;
          this.teardown();
          this.onend?.();
        }
        teardown() {
          clearTimeout(this.silence);
          live.delete(this.session);
          this.stream?.getTracks().forEach((track) => track.stop());
          this.stream = null;
          Promise.resolve(this.context?.close()).catch(() => undefined);
          this.context = null;
        }
      }

      for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
        Object.defineProperty(globalThis, name, { value: LocalSpeechRecognition, configurable: true, writable: true });
      }
    },
    args: [speech]
  });
}
