/**
 * Jester's window in a browser (main/web-gateway.js): the `chrome` it has in the app (src/preload/chrome-shim.cjs),
 * over one WebSocket to his server. Runs before the page's own scripts.
 *
 *   chrome.runtime.sendMessage / onMessage    messages, as in the app
 *   chrome.storage.local / session / onChanged    his settings, private keys never sent
 *
 * The same socket is his ears and mouth in this browser, like the app's hidden voice page (src/voice/voice.js): the
 * mic is opened when the server says so, and only on the browser being talked to, which is whichever was last
 * clicked in (`voice-claim`). His voice plays here too. A click is also what lets a browser play sound at all.
 */
(() => {
  const RUNTIME_ID = 'jester-desktop';
  const MIC = { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  const RETRY_MS = [500, 1000, 2000, 5000];
  const messageListeners = new Set();
  const storageListeners = new Set();
  const waiting = new Map();
  let socket = null;
  let open = false;
  let queue = [];
  let nextId = 0;
  let tries = 0;
  let claimed = false;

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      open = true;
      tries = 0;
      // The Mac's own window (his website in Electron) says so: the Mac says where it is for it (device-location.js).
      socket.send(JSON.stringify({ t: 'hello', role: 'page', ...(/\bElectron\//.test(navigator.userAgent) ? { macWindow: true } : {}) }));
      if (claimed) socket.send(JSON.stringify({ t: 'voice-claim' }));
      for (const frame of queue) socket.send(frame);
      queue = [];
      document.documentElement.dataset.server = 'on';
    };
    socket.onmessage = ({ data }) => {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.t === 'reply') {
        waiting.get(frame.id)?.(frame.reply ?? undefined);
        waiting.delete(frame.id);
      } else if (frame.t === 'msg') {
        if (frame.message?.type === 'jester/open-url') openUrl(frame.message);
        if (frame.message?.type === 'jester/where-ask') answerWhere(frame.message);
        for (const listener of messageListeners) {
          try {
            listener(frame.message, frame.sender, () => undefined);
          } catch (err) {
            console.error(err);
          }
        }
      } else if (frame.t === 'storage-changed') {
        for (const listener of storageListeners) {
          try {
            listener(frame.changes, frame.area);
          } catch (err) {
            console.error(err);
          }
        }
      } else if (frame.t === 'voice') {
        if (frame.op === 'open') openMic();
        else closeMic();
      } else if (frame.t === 'play') play(frame);
    };
    socket.onclose = () => {
      open = false;
      closeMic();
      stopPlaying();
      document.documentElement.dataset.server = 'off';
      // Asked and never answered: nothing will answer now.
      for (const resolve of waiting.values()) resolve(undefined);
      waiting.clear();
      setTimeout(connect, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
    };
  }

  function send(frame) {
    const text = JSON.stringify(frame);
    if (open) socket.send(text);
    else queue.push(text);
  }

  function ask(frame) {
    const id = ++nextId;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      send({ ...frame, id });
    });
  }

  const event = (listeners) => ({
    addListener: (fn) => void listeners.add(fn),
    removeListener: (fn) => void listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn)
  });

  const area = (name) => ({
    get: (keys) => ask({ t: 'storage', area: name, op: 'get', arg: keys ?? null }).then((items) => items || {}),
    set: (items) => ask({ t: 'storage', area: name, op: 'set', arg: items }),
    remove: (keys) => ask({ t: 'storage', area: name, op: 'remove', arg: keys })
  });

  if (typeof globalThis.chrome !== 'object' || globalThis.chrome === null) globalThis.chrome = {};
  globalThis.chrome.runtime = {
    id: RUNTIME_ID,
    getURL: (file = '') => `/app/ext/${String(file).replace(/^\/+/, '')}`,
    sendMessage: (message) => ask({ t: 'msg', message }),
    onMessage: event(messageListeners)
  };
  globalThis.chrome.storage = { local: area('local'), session: area('session'), onChanged: event(storageListeners) };
  // His window can't close a browser's tab.
  globalThis.close = () => undefined;
  // For pages that do something else in a browser: Settings' card for putting him on a Home Screen (home/install.js).
  globalThis.jesterWeb = { claim: () => claim(), installPrompt: null };

  // ---------------------------------------------------------------------------
  // His website as an app (a phone's Home Screen)
  // ---------------------------------------------------------------------------
  //
  // The worker shows a page of his own when the server can't be reached (sw.js). Not in the Mac's own window, which
  // is an app already. A browser that can install him says so before his page's scripts run: its prompt is kept
  // for Settings' Install button.
  const inMacWindow = /\bElectron\//.test(navigator.userAgent);
  if (!inMacWindow && 'serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined));
  }
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    globalThis.jesterWeb.installPrompt = event;
    dispatchEvent(new Event('jester-installable'));
  });
  addEventListener('appinstalled', () => {
    globalThis.jesterWeb.installPrompt = null;
    dispatchEvent(new Event('jester-installable'));
  });

  // ---------------------------------------------------------------------------
  // His ears and mouth, here
  // ---------------------------------------------------------------------------

  let stream = null;
  let context = null;
  let player = null;
  let micWanted = false;

  function status(report) {
    if (open) socket.send(JSON.stringify({ t: 'voice-status', report }));
  }

  /** This browser is the one being talked to: its mic opens if he's listening, and his voice plays here. */
  function claim() {
    claimed = true;
    if (open) socket.send(JSON.stringify({ t: 'voice-claim' }));
  }

  function closeMic() {
    micWanted = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    Promise.resolve(context?.close()).catch(() => undefined);
    context = null;
  }

  async function openMic() {
    if (micWanted && stream) return;
    micWanted = true;
    try {
      const got = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
      if (!micWanted) return got.getTracks().forEach((track) => track.stop());
      stream = got;
      // The recognizer wants 16 kHz mono; the audio context resamples to it.
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule('/app/worklets/speech-capture.js');
      const tap = new AudioWorkletNode(context, 'jester-speech-capture');
      tap.port.onmessage = ({ data }) => open && socket.send(data.buffer);
      context.createMediaStreamSource(stream).connect(tap);
      tap.connect(context.destination);
      await context.resume();
      status({ mic: stream.getAudioTracks()[0]?.label || 'open' });
    } catch (error) {
      const why = error?.message || String(error);
      closeMic();
      status({ mic: `not open: ${why}` });
    }
  }

  function stopPlaying() {
    player?.pause();
    player = null;
  }

  function play({ id, bytes, type, stop }) {
    stopPlaying();
    if (stop) return;
    const raw = atob(bytes);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) data[i] = raw.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([data], { type }));
    const sound = new Audio(url);
    player = sound;
    const over = () => {
      URL.revokeObjectURL(url);
      if (player === sound) player = null;
      status({ ended: id });
    };
    sound.onended = over;
    sound.onpause = over;
    sound.onerror = over;
    sound.play().catch(over);
  }

  // ---------------------------------------------------------------------------
  // A page his server can't open itself: a sign-in
  // ---------------------------------------------------------------------------
  //
  // Google's sign-in sends the browser back to a port on the computer that asked, which here is his server. The tab
  // it lands on shows nothing; its address is what he needs, pasted here.

  /**
   * Where this device is, asked by his server (main/device-location.js) when he's talked to here and the last
   * position is old, or this is a different device: the browser's own location, which it asks the user about the
   * first time. Answered with why not, too, so Settings can say.
   */
  function answerWhere({ id, timeoutMs }) {
    const answer = (fields) => ask({ t: 'msg', message: { type: 'jester/where-told', id, ...fields } }).catch(() => undefined);
    if (!globalThis.isSecureContext || !navigator.geolocation) return answer({ ok: false, code: 2, message: 'This browser can’t tell where it is.' });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => answer({ ok: true, lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy }),
      (error) => answer({ ok: false, code: error.code, message: error.message }),
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: Math.min(Math.max(Number(timeoutMs) || 20000, 3000), 85000) }
    );
  }

  function openUrl({ url, landing }) {
    if (!/^https:\/\//.test(String(url))) return;
    const tab = window.open(url, '_blank', 'noopener');
    if (landing) askForLanding(url, !tab);
  }

  function askForLanding(url, blocked) {
    document.getElementById('jester-landing')?.remove();
    const box = document.createElement('form');
    box.id = 'jester-landing';
    box.className = 'jester-landing';
    const words = document.createElement('p');
    words.textContent = blocked
      ? 'Your browser kept the sign-in from opening. Open it, sign in, then paste the address of the page it ends on (it starts with http://127.0.0.1 and says it can’t be reached).'
      : 'Sign in in the tab that opened. It ends on a page that can’t be reached: copy that page’s whole address from the address bar and paste it here.';
    const open = document.createElement('a');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open the sign-in';
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'http://127.0.0.1:…/?state=…&code=…';
    input.required = true;
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'primary';
    send.textContent = 'Finish signing in';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => box.remove();
    box.onsubmit = async (event) => {
      event.preventDefault();
      send.disabled = true;
      const reply = await ask({ t: 'msg', message: { type: 'jester/sign-in-return', url: input.value } });
      send.disabled = false;
      if (reply?.ok) box.remove();
      else error.textContent = reply?.error || 'His server didn’t answer.';
    };
    const buttons = document.createElement('div');
    buttons.append(cancel, send);
    box.append(words, open, input, error, buttons);
    document.body.append(box);
    input.focus();
  }

  // A click or a key here makes this the browser he's talking to. Not in Jester's own app on a Mac, whose window this
  // is when it uses him in the cloud: the Mac's own voice page is his ears there, and it claims him itself.
  if (!/\bElectron\//.test(navigator.userAgent)) {
    addEventListener('pointerdown', claim, { capture: true });
    addEventListener('keydown', claim, { capture: true });
  }
  connect();
})();
