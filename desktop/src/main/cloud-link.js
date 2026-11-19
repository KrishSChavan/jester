/**
 * The Mac's line to Jester's brain on a server ("Use Jester in the cloud", Settings › Jester in the cloud).
 *
 * With it on, the conversation, memory, tasks, reminders, mail and briefs are the server's (main.js JESTER_SERVER),
 * the same ones his website shows; the Mac is his hands, eyes and ears. Over the server's web gateway socket
 * (web-gateway.js), as a client of the role 'mac':
 *
 *   - his ears and mouth, when the Mac is the one being talked to: the always-on mic's audio goes up, and his voice
 *     comes down to play here, through the same hidden voice page as ever (voice-page.js);
 *   - his hands (remote-hands.js): the server asks, the Mac's own voice runner and assistant do it, and Controls on
 *     his website runs the Mac's scripts (script-remote.js says what it may);
 *   - how long since the user touched the Mac, so the server knows whether they're here.
 *
 * Reconnects by itself, a little slower each time, for as long as it's on.
 */

import WebSocket from 'ws';

const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
/** How often what the hands are up to is looked at, and the user's idle time sent. */
const STATE_MS = 200;
const PRESENCE_MS = 10000;

/** The link the user pasted ("https://jester.tailnet.ts.net/?key=…"), as the socket's address and its key; null if it isn't one. */
export function parseCloudLink(link) {
  let url;
  try {
    url = new URL(String(link || '').trim());
  } catch {
    return null;
  }
  const key = url.searchParams.get('key') || '';
  if (!['https:', 'http:'].includes(url.protocol) || key.length < 16) return null;
  // Plain http only to this machine (a test, or an SSH tunnel): anything else carries the key in the clear.
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return { origin: url.origin, socket: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/socket`, key, page: `${url.origin}/?key=${encodeURIComponent(key)}` };
}

/**
 * @param {object} deps
 * @param {{socket:string, key:string, origin:string}} deps.link   parseCloudLink's
 * @param {(op:'open'|'close') => void} deps.onVoice   open or close the always-on mic, for the server
 * @param {(sound:{id?:number, bytes?:Buffer, type?:string, stop?:boolean}) => void} deps.onPlay   his voice, to play here
 * @param {(request:object) => Promise<any>} deps.onHands   do what the server asks; the result goes back
 * @param {() => object} deps.handsState   { running, asking, abilities }: sent when it changes
 * @param {() => number} deps.idleSeconds
 * @param {(connected:boolean) => void} [deps.onChange]
 */
export function createCloudLink({ link, onVoice, onPlay, onHands, handsState, idleSeconds, onChange = () => undefined, log = () => undefined, WebSocketImpl = WebSocket }) {
  let socket = null;
  let connected = false;
  let closed = false;
  let tries = 0;
  let retry = null;
  let lastState = '';
  let wantsClaim = true;

  function send(frame) {
    if (connected) socket.send(JSON.stringify(frame));
  }

  function connect() {
    if (closed) return;
    socket = new WebSocketImpl(link.socket, { headers: { Authorization: `Bearer ${link.key}` }, handshakeTimeout: 10000 });
    socket.on('open', () => {
      connected = true;
      tries = 0;
      lastState = '';
      log('cloud: connected to', link.origin);
      send({ t: 'hello', role: 'mac' });
      if (wantsClaim) send({ t: 'voice-claim' });
      send({ t: 'presence', idleSeconds: idleSeconds() });
      pushState();
      onChange(true);
    });
    socket.on('message', (data, binary) => {
      if (binary) return;
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.t === 'voice') onVoice(frame.op === 'open' ? 'open' : 'close');
      else if (frame.t === 'play') onPlay(frame.stop ? { stop: true } : { id: frame.id, type: String(frame.type || 'audio/wav'), bytes: Buffer.from(String(frame.bytes || ''), 'base64') });
      else if (frame.t === 'hands') {
        Promise.resolve()
          .then(() => onHands(frame))
          .then(
            (result) => send({ t: 'hands-reply', id: frame.id, result: result ?? null }),
            (err) => send({ t: 'hands-reply', id: frame.id, error: String(err?.message || err) })
          );
      }
    });
    socket.on('close', () => {
      const was = connected;
      connected = false;
      // The mic was the server's to open: with no server, it's closed.
      onVoice('close');
      if (was) {
        log('cloud: disconnected');
        onChange(false);
      }
      if (!closed) retry = setTimeout(connect, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
    });
    socket.on('error', (err) => {
      if (tries < 2 || tries % 10 === 0) log('cloud: can’t reach the server:', err.message);
    });
  }

  function pushState() {
    let state;
    try {
      state = handsState();
    } catch {
      return;
    }
    const text = JSON.stringify(state);
    if (text === lastState) return;
    lastState = text;
    send({ t: 'hands-state', ...state });
  }

  const stateTimer = setInterval(() => connected && pushState(), STATE_MS);
  const presenceTimer = setInterval(() => connected && send({ t: 'presence', idleSeconds: idleSeconds() }), PRESENCE_MS);
  stateTimer.unref?.();
  presenceTimer.unref?.();
  connect();

  return {
    get connected() {
      return connected;
    },
    /** The Mac is the one being talked to: its mic opens if he's listening, and his voice plays here. */
    claim() {
      wantsClaim = true;
      send({ t: 'voice-claim' });
    },
    /** The mic's audio, 16 kHz mono floats. */
    audio(samples) {
      if (connected && samples?.length) socket.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    },
    /** A sound he was playing here ended, or the mic opened (or didn't). */
    status(report) {
      send({ t: 'voice-status', report });
    },
    /** The Mac's assistant has a question: the server asks it in the conversation. */
    ask(label) {
      send({ t: 'hands-ask', label: String(label || '') });
    },
    /** Typed to him in the Mac's own window: said to him on the server. */
    told(text) {
      if (!connected) return false;
      send({ t: 'told', text: String(text || '') });
      return true;
    },
    /** Something changed that the server should know at once. */
    stateChanged: pushState,
    /** This Mac's scripts, or what's on, changed: Controls on his website reads them again. */
    scriptsChanged(change = {}) {
      send({ t: 'scripts-changed', change: { ...(typeof change.script === 'string' ? { script: change.script } : {}) } });
    },
    close() {
      closed = true;
      clearTimeout(retry);
      clearInterval(stateTimer);
      clearInterval(presenceTimer);
      socket?.close();
    }
  };
}
