/**
 * Jester's window in a browser (main/web-gateway.js): the `chrome` it has in the app (src/preload/chrome-shim.cjs),
 * over one WebSocket to his server. Runs before the page's own scripts.
 *
 *   chrome.runtime.sendMessage / onMessage    messages, as in the app
 *   chrome.storage.local / session / onChanged    his settings, private keys never sent
 *
 * The same socket is his ears and mouth in this browser, like the app's hidden voice page (src/voice/voice.js): the
 * mic is opened when the server says so, and only on the browser being talked to, which is whichever was last
 * clicked in (`voice-claim`), or his app on a phone's Home Screen as it opens. His voice plays here too, through
 * players readied by the first touch: a browser plays no sound before one (see `ready`).
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

  /**
   * Which of the user's devices this is (main/devices.js): an id made here once and kept, apart for a browser and for
   * his app on the Home Screen, which keep their own storage. With storage refused, it's a new device each time.
   */
  const standalone = () => globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  function deviceId() {
    try {
      let id = localStorage.getItem('jesterDevice');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || '')) {
        id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem('jesterDevice', id);
      }
      return id;
    } catch {
      return '';
    }
  }

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      open = true;
      tries = 0;
      // The Mac's own window (his website in Electron) says so: the Mac says where it is for it (device-location.js).
      socket.send(JSON.stringify({ t: 'hello', role: 'page', device: { id: deviceId(), app: standalone() }, visible: document.visibilityState !== 'hidden', ...(/\bElectron\//.test(navigator.userAgent) ? { macWindow: true } : {}) }));
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
  // In front or behind: he knows where he's being looked at (main/devices.js).
  document.addEventListener('visibilitychange', () => send({ t: 'here', visible: document.visibilityState !== 'hidden' }));

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
  let micWanted = false;
  /** The mic being opened: asked for, or its sound being joined up. */
  let micOpening = null;

  /*
   * An iPhone forgets that the mic was allowed soon after it's let go, and asks again: WebKit's rule (its
   * UserMediaPermissionRequestManagerProxy.cpp and WebPreferencesDefaultValues.cpp, read 2026-11-21) is that a mic
   * asked for without a tap is given without asking only within a minute of the last one being used, on an iPhone or
   * iPad; with a tap, within ten. This mic was let go each time his server's connection dropped, which it does as his
   * app is put away, so coming back asked again (the user, 2026-11-21: "everytime I open a new app even if the pwa is
   * not closed and come back to it it still asks for my microphone access").
   *
   * Put away, an iPhone only mutes a page's mic (WebKit's InterruptAudioOnPageVisibilityChangeEnabled, on there): it's
   * there again as the page comes back. So on an iPhone or iPad it's never let go while the page is open: closed, it's
   * muted (its tracks disabled) and its sound closed, and opened again it's the same mic, with nothing to ask, and a
   * new sound for it. Anywhere else it's let go, as before: those browsers keep the site's answer.
   *
   * A fresh start of his app on a Home Screen still asks, once: WebKit keeps no answer for those between launches
   * (WebKit bug 327237, 2026-10-12), and nothing a page does changes that.
   */
  const keepsMic = /\b(?:iPhone|iPad|iPod)\b/.test(navigator.userAgent) || (/\bMacintosh\b/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

  function status(report) {
    if (open) socket.send(JSON.stringify({ t: 'voice-status', report }));
  }

  /** This browser is the one being talked to: its mic opens if he's listening, and his voice plays here. */
  function claim() {
    claimed = true;
    if (open) socket.send(JSON.stringify({ t: 'voice-claim' }));
  }

  /** The mic's there to be used again: one of its tracks hasn't ended. */
  const kept = () => !!stream && stream.getAudioTracks().some((track) => track.readyState === 'live');

  /**
   * Nothing's heard here: the mic's sound isn't made or sent. Let go of, unless letting go would mean being asked again.
   * Kept, it's muted, and its sound closed rather than suspended: in Chrome, a context suspended while its mic was
   * muted made no sound again once both were back, unless it was going before the mic was (measured, 2026-11-21).
   */
  function closeMic() {
    micWanted = false;
    if (!keepsMic) return releaseMic();
    for (const track of stream?.getAudioTracks() || []) track.enabled = false;
    closeSound();
    return undefined;
  }

  function closeSound() {
    Promise.resolve(context?.close()).catch(() => undefined);
    context = null;
  }

  function releaseMic() {
    // Not this page's any more before its tracks stop: their end isn't taken for the device's (lostMic).
    const tracks = stream?.getTracks() || [];
    stream = null;
    for (const track of tracks) track.stop();
    closeSound();
  }

  /** Opened again while it was being opened: it may have been closed in between, so it's gone through once more. */
  let micAgain = false;
  function openMic() {
    micWanted = true;
    if (micOpening) {
      micAgain = true;
      return micOpening;
    }
    micOpening = (async () => {
      do {
        micAgain = false;
        await startMic();
      } while (micAgain && micWanted);
    })().finally(() => (micOpening = null));
    return micOpening;
  }

  /** The mic, the one kept or a new one, made to send its sound: unless it's closed again meanwhile. */
  async function startMic() {
    let got = null;
    let made = null;
    try {
      // Open and sending already (back in front, say): nothing to do, or to say.
      if (kept() && context?.state === 'running' && stream.getAudioTracks().every((track) => track.enabled)) return undefined;
      if (!kept()) {
        releaseMic();
        got = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
        if (!micWanted && !keepsMic) return got.getTracks().forEach((track) => track.stop());
        stream = got;
        for (const track of got.getAudioTracks()) track.addEventListener('ended', () => lostMic(got));
      }
      if (!micWanted) return closeMic();
      const mic = stream;
      for (const track of mic.getAudioTracks()) track.enabled = true;
      if (!context) {
        // The recognizer wants 16 kHz mono; the audio context resamples to it.
        made = new AudioContext({ sampleRate: 16000 });
        context = made;
        await made.audioWorklet.addModule('/app/worklets/speech-capture.js');
        // Closed or let go of meanwhile: so is this.
        if (context !== made || stream !== mic) return made.close().catch(() => undefined);
        const tap = new AudioWorkletNode(made, 'jester-speech-capture');
        tap.port.onmessage = ({ data }) => micWanted && open && socket.send(data.buffer);
        made.createMediaStreamSource(mic).connect(tap);
        tap.connect(made.destination);
      }
      // A phone may not start it without a touch: ready() starts it at the next one.
      const started = context.state === 'running' || (await Promise.race([context.resume().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1500))]));
      if (!micWanted) return undefined;
      const label = stream?.getAudioTracks()[0]?.label || 'open';
      status({ mic: started || context?.state === 'running' ? `${label}${got ? '' : ', the one kept: not asked for again'}` : 'waiting for a tap: this browser starts no mic before one' });
    } catch (error) {
      // Let go of, or closed, on purpose while it was being joined up: nothing went wrong, and a mic kept stays kept.
      if ((got && stream !== got) || (made && context !== made)) return undefined;
      const why = error?.message || String(error);
      releaseMic();
      status({ mic: `not open: ${why}` });
    }
    return undefined;
  }

  /**
   * Ended by the browser or the phone, not here (another app took the mic, it was unplugged): gone. Asked for again
   * if it's wanted, once his page is in front: a page behind gets no mic.
   */
  function lostMic(got) {
    if (stream !== got) return;
    releaseMic();
    status({ mic: 'ended by this device' });
    if (micWanted && document.visibilityState !== 'hidden') openMic();
  }

  /*
   * His voice. A browser plays nothing until the page has been touched, and an iPhone plays only from a player that
   * was readied in a touch: measured in iOS 27's Safari (2026-11-19), a new <audio> made 12 s after a tap is refused,
   * while one that had load() called in the tap plays then. His voice came as a new <audio> per sentence, seconds
   * after any tap, so a phone said nothing. Now two players are made once, readied by load() in the first touch,
   * click or key (no sound, so the user's music isn't stopped), and every sentence plays through them: one plays
   * while the next loads, as each starts when the one before ends (2026-11-19, a pause after every sentence).
   *
   * A sentence that comes before any touch can't be played at all. It's kept, the server is told it's over (its
   * words are on the screen), and a bar offers it: "Hear it" is a tap, which is what plays it.
   */
  const players = [new Audio(), new Audio()];
  /** The piece playing: {id, url, el}. */
  let playing = null;
  /** The pieces after it, in order. The first may be loading in the other player already. */
  let upcoming = [];
  /** Pieces this browser wouldn't play before a touch, kept for the bar. */
  let held = [];
  let heldTimer = null;
  let readied = false;
  const HELD_MS = 2 * 60 * 1000;

  for (const el of players) {
    el.preload = 'auto';
    el.addEventListener('ended', () => el.piece && over(el.piece));
    el.addEventListener('error', () => el.piece && over(el.piece));
    // Paused by the phone itself (a call, the lock screen's controls, the app put away): over. Still paused, so not a
    // pause of its last piece's arriving after its next one has started.
    el.addEventListener('pause', () => el.piece && el.piece === playing && el.paused && !el.ended && over(el.piece));
  }

  /** In a touch, a click or a key: the players may play from now on, and a mic refused its start without one opens. */
  function ready() {
    // A touch that scrolled isn't one a browser counts.
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    // Suspended, or interrupted by an iPhone while his app was put away.
    if (micWanted && context && context.state !== 'running' && context.state !== 'closed') context.resume().then(() => status({ mic: 'open, after a tap' }), () => undefined);
    if (readied) return;
    readied = true;
    for (const el of players) if (!el.piece) el.load();
  }

  /** A player for a piece, so it loads while the one before it plays. None while both are busy. */
  function load(piece) {
    if (piece.el) return piece.el;
    const el = players.find((each) => !each.piece);
    if (!el) return null;
    el.piece = piece;
    piece.el = el;
    el.src = piece.url;
    return el;
  }

  /** Its player is free for the next piece. */
  function letGo(piece) {
    const el = piece.el;
    if (!el) return;
    el.piece = null;
    piece.el = null;
    el.pause();
    el.removeAttribute('src');
  }

  /** The server hears that a piece is over once: played, refused, or stopped. */
  function told(piece) {
    if (piece.told) return;
    piece.told = true;
    status({ ended: piece.id });
  }

  function over(piece) {
    if (piece.done) return;
    piece.done = true;
    letGo(piece);
    URL.revokeObjectURL(piece.url);
    upcoming = upcoming.filter((each) => each !== piece);
    told(piece);
    if (playing !== piece) return;
    playing = null;
    startNext();
  }

  function startNext() {
    const piece = upcoming.shift();
    if (!piece) return;
    playing = piece;
    const el = load(piece);
    if (!el) return over(piece);
    el.play().catch((error) => {
      if (piece.done || held.includes(piece)) return;
      if (error?.name === 'NotAllowedError') hold(piece);
      else over(piece);
    });
    if (upcoming[0]) load(upcoming[0]);
    return undefined;
  }

  /** Refused before a touch: this piece and the ones after it wait for the bar's tap. */
  function hold(piece) {
    if (!held.length) status({ voice: 'held until this browser is tapped: it plays no sound before' });
    readied = false;
    const pieces = [piece, ...(playing === piece ? upcoming : [])];
    if (playing === piece) {
      playing = null;
      upcoming = [];
    }
    for (const each of pieces) {
      letGo(each);
      told(each);
      held.push(each);
    }
    clearTimeout(heldTimer);
    heldTimer = setTimeout(dropHeld, HELD_MS);
    offerHeld();
  }

  function dropHeld() {
    clearTimeout(heldTimer);
    for (const piece of held) URL.revokeObjectURL(piece.url);
    held = [];
    document.getElementById('jester-hear')?.remove();
  }

  /** The bar's "Hear it", a tap: what was kept plays now. */
  function hearHeld() {
    ready();
    const pieces = held;
    held = [];
    dropHeld();
    status({ voice: `a held line played after a tap (${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'})` });
    upcoming.push(...pieces);
    if (!playing) startNext();
  }

  function stopPlaying() {
    const pieces = [playing, ...upcoming].filter(Boolean);
    playing = null;
    upcoming = [];
    for (const piece of pieces) over(piece);
    dropHeld();
  }

  function play({ id, bytes, type, stop, queued }) {
    if (!queued || stop) stopPlaying();
    if (stop) return;
    const raw = atob(bytes);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) data[i] = raw.charCodeAt(i);
    const piece = { id, url: URL.createObjectURL(new Blob([data], { type })) };
    // The pieces before it are waiting for a tap: so is this one.
    if (held.length) return hold(piece);
    upcoming.push(piece);
    if (!playing) startNext();
    else load(upcoming[0]);
    return undefined;
  }

  /** The bar at the top of his page: he said something this browser couldn't play, and a tap that plays it. */
  function offerHeld() {
    if (document.getElementById('jester-hear')) return;
    const box = document.createElement('div');
    box.id = 'jester-hear';
    box.className = 'jester-landing jester-hear';
    box.setAttribute('role', 'alert');
    const words = document.createElement('p');
    words.textContent = 'Jester said something. This browser plays sound only after a tap.';
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Not now';
    no.onclick = dropHeld;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary';
    yes.textContent = 'Hear it';
    yes.onclick = hearHeld;
    const buttons = document.createElement('div');
    buttons.append(no, yes);
    box.append(words, buttons);
    document.body.append(box);
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
   *
   * A browser that's never been answered for this site may only put its question after a tap, and his server asks
   * whenever it needs to know, with no tap behind it: asked that way, some never show the question at all (the
   * user, 2026-11-19: nothing asked until Location was switched off and on in Settings, which is a tap). So while
   * the answer is still "ask", a bar says what he wants and why, and its button asks from a tap. `sure`: asked
   * for from Settings, on purpose; otherwise a "Not now" stands for a week.
   *
   * Allowed once, the bar never comes back, and the position is kept here. A browser that forgets it was allowed
   * (an iPhone's, for his app on the Home Screen, often each time it's opened: the user, 2026-11-19, "still asks me
   * each time on my phone") isn't asked again while the one kept is under 12 hours old, unless it's asked for on
   * purpose (`sure`) or the turn's about where they are (`fresh`): the kept one is answered with, and how old it is.
   */
  let whereDeclined = false;
  function answerWhere({ id, timeoutMs, sure, fresh }) {
    const answer = (fields) => ask({ t: 'msg', message: { type: 'jester/where-told', id, ...fields } }).catch(() => undefined);
    if (!globalThis.isSecureContext || !navigator.geolocation) return answer({ ok: false, code: 2, message: 'This browser can’t tell where it is.' });
    const limit = Math.min(Math.max(Number(timeoutMs) || 20000, 3000), 85000);
    const last = keptWhere();
    const lastAge = last ? Math.max(0, Date.now() - last.at) : Infinity;
    /** This browser has said where it is before: the bar's done its job. */
    const allowedBefore = !!last || storedWhere(WHERE_OK) === '1';
    const fromLast = () => ({ ok: true, lat: last.lat, lon: last.lon, accuracy: last.accuracy, kept: true, ageMs: lastAge });
    let done = false;
    let tapped = false;
    /** Whether the browser still has to ask: its question may be up, or waiting for a tap. */
    let unanswered = false;
    let timer = null;
    const finish = (fields) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.getElementById('jester-where')?.remove();
      answer(fields);
    };
    const offer = () =>
      askForWhere(
        () => {
          tapped = true;
          locate();
        },
        () => {
          whereDeclined = true;
          storeWhere(WHERE_NO, String(Date.now()));
          finish({ ok: false, code: 1, message: 'Not now.' });
        }
      );
    const locate = () =>
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          // Kept even when it comes too late for this question: the next is answered with it.
          keepWhere(coords);
          finish({ ok: true, lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy });
        },
        (error) => {
          // Refused without a tap, while the browser had still to ask: it wants the tap first. Allowed before, the
          // bar's only put up now; otherwise it's up already.
          if (error.code === 1 && unanswered && !tapped) {
            if (allowedBefore && !document.getElementById('jester-where')) offer();
            return;
          }
          // No position to be had just now (indoors, no signal): where it was last is better than nothing.
          if (error.code !== 1 && last && !sure) return finish(fromLast());
          // Refused: what was kept goes, and the bar isn't put up again for a week, unless it's asked for on purpose.
          if (error.code === 1) forgetWhere();
          finish({ ok: false, code: error.code, message: error.message });
        },
        { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: limit }
      );
    timer = setTimeout(() => finish(last && !sure ? fromLast() : { ok: false, code: 3, message: '', ...(unanswered ? { asking: true } : {}) }), limit);
    const state = navigator.permissions?.query ? navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state, () => 'unknown') : Promise.resolve('unknown');
    state.then((allowed) => {
      if (done) return;
      if (allowed === 'denied') return finish({ ok: false, code: 1, message: 'Location is turned off for this site.' });
      if (allowed === 'granted') return locate();
      // The browser would ask again: not while the one kept here will do.
      if (last && !sure && !fresh && lastAge < KEEP_WHERE_MS) return finish(fromLast());
      unanswered = true;
      // Allowed here before: the browser's own question, if it has one, with no bar of his.
      if (allowedBefore) return locate();
      if (!sure && (whereDeclined || Date.now() - Number(storedWhere(WHERE_NO) || 0) < NOT_NOW_MS)) return finish({ ok: false, code: 1, message: 'Not now.' });
      offer();
      // And at once, for a browser that will ask without the tap.
      locate();
    });
  }

  /** Where this device was last, as this browser said: kept here, and only here. */
  const WHERE = 'jesterWhere';
  /** When "Not now" was said to the bar, or the browser's question refused. */
  const WHERE_NO = 'jesterWhereNo';
  /** This browser has said where it is, once. */
  const WHERE_OK = 'jesterWhereOk';
  const KEEP_WHERE_MS = 12 * 60 * 60 * 1000;
  const NOT_NOW_MS = 7 * 24 * 60 * 60 * 1000;
  function storedWhere(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function storeWhere(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage refused: asked as before */
    }
  }
  /** The position kept, if it's a day old at most. */
  function keptWhere() {
    try {
      const kept = JSON.parse(storedWhere(WHERE) || 'null');
      const fine = kept && [kept.lat, kept.lon, kept.at].every(Number.isFinite) && Date.now() - kept.at < 24 * 60 * 60 * 1000 && kept.at <= Date.now() + 60000;
      return fine ? { lat: kept.lat, lon: kept.lon, accuracy: Math.max(0, Number(kept.accuracy) || 0), at: kept.at } : null;
    } catch {
      return null;
    }
  }
  function keepWhere(coords) {
    storeWhere(WHERE, JSON.stringify({ lat: coords.latitude, lon: coords.longitude, accuracy: Math.round(coords.accuracy || 0), at: Date.now() }));
    storeWhere(WHERE_OK, '1');
    storeWhere(WHERE_NO, null);
  }
  function forgetWhere() {
    storeWhere(WHERE, null);
    storeWhere(WHERE_OK, null);
    storeWhere(WHERE_NO, String(Date.now()));
  }

  /** The bar over his page: what he wants to know and why, and the tap a browser needs before it asks. */
  function askForWhere(allow, later) {
    document.getElementById('jester-where')?.remove();
    const box = document.createElement('div');
    box.id = 'jester-where';
    box.className = 'jester-landing';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Location');
    const words = document.createElement('p');
    words.textContent = 'Jester would like to know where this device is, for the weather and what’s near you. Your browser will ask you to allow it.';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary';
    yes.textContent = 'Allow location';
    yes.onclick = () => {
      words.textContent = 'Your browser is asking: choose Allow.';
      yes.disabled = true;
      allow();
    };
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Not now';
    no.onclick = later;
    const buttons = document.createElement('div');
    buttons.append(no, yes);
    box.append(words, buttons);
    document.body.append(box);
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
  //
  // The end of a touch, a click or a key is what lets a browser play his voice (ready): a touch's start isn't one.
  //
  // His app on a phone's Home Screen is in the user's hand while it's open, so it's talked through as it opens or
  // comes to the front, as the Mac's window is when it's focused. Before, it waited for a tap, and what he said as it
  // opened went to nobody (2026-11-19: "Nobody's browser is open to play his voice" each time it was opened).
  if (!/\bElectron\//.test(navigator.userAgent)) {
    addEventListener('pointerdown', claim, { capture: true });
    addEventListener('keydown', claim, { capture: true });
    for (const type of ['touchend', 'click', 'keydown']) addEventListener(type, ready, { capture: true, passive: true });
    if (standalone()) {
      if (document.visibilityState !== 'hidden') claim();
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && claim());
    }
    // Back in front with the mic still wanted (the connection lasted while it was away): the kept one, going again, or
    // a new one for one that was lost meanwhile.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && micWanted && openMic());
  }
  connect();
})();
