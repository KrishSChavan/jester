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

/** A server's address as typed ("jester.tail1234.ts.net", with or without https://), as its origin. Throws in words. */
export function serverOrigin(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Type his server’s address, like jester.your-tailnet.ts.net.');
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error('That isn’t a server’s address. It looks like jester.your-tailnet.ts.net.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('His server’s address starts with https://.');
  return url.origin;
}

/** Signs in to his server with the password, as his sign-in page does: the key it answers with, or why not, in words. */
export async function cloudKeyFor(server, password, { fetchImpl = globalThis.fetch } = {}) {
  const origin = serverOrigin(server);
  if (!password) throw new Error('Type the password you set for Jester (his website’s Settings › Devices).');
  let response;
  try {
    response = await fetchImpl(`${origin}/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('His server couldn’t be reached at that address. Check it, and that this Mac is online.');
  }
  const reply = await response.json().catch(() => ({}));
  if (!response.ok || !reply.ok) throw new Error(reply.error || (response.status === 404 ? 'That server has no password set. Set one on his website (Settings › Devices), or paste his link.' : `His server answered ${response.status}.`));
  const cookie = (response.headers.getSetCookie?.() || []).map((line) => /^jester_key=([^;]+)/.exec(line)?.[1]).find(Boolean);
  const key = cookie ? decodeURIComponent(cookie) : '';
  if (key.length < 16) throw new Error('His server signed in, but gave no key. Is it up to date?');
  return key;
}

/**
 * @param {object} deps
 * @param {{socket:string, key:string, origin:string}} deps.link   parseCloudLink's
 * @param {(op:'open'|'close') => void} deps.onVoice   open or close the always-on mic, for the server
 * @param {(sound:{id?:number, bytes?:Buffer, type?:string, stop?:boolean}) => void} deps.onPlay   his voice, to play here
 * @param {(request:object) => Promise<any>} deps.onHands   do what the server asks; the result goes back
 * @param {() => object} deps.handsState   { running, asking, abilities }: sent when it changes
 * @param {() => number} deps.idleSeconds
 * @param {{id:string, name:string}} [deps.device]   which of the user's computers this is (devices.js)
 * @param {(frame:object) => void} [deps.onFrame]   anything else the server says (a move's answer)
 * @param {() => void} [deps.onRefused]   the server turned its key away: the user has to sign in again
 * @param {(connected:boolean) => void} [deps.onChange]
 */
export function createCloudLink({ link: given, device = null, onVoice, onPlay, onHands, handsState, idleSeconds, onChange = () => undefined, onFrame = () => undefined, onRefused = () => undefined, log = () => undefined, WebSocketImpl = WebSocket }) {
  /** Where it connects, and with what key: changed when the user signs in again (`use`). */
  let link = given;
  /** The server said the key isn't its own (it was replaced): told once, and tried again more slowly. */
  let refused = false;
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
    // One line at a time: a try already on its way, or open, is the one.
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    const mine = new WebSocketImpl(link.socket, { headers: { Authorization: `Bearer ${link.key}` }, handshakeTimeout: 10000 });
    socket = mine;
    socket.on('open', () => {
      connected = true;
      refused = false;
      tries = 0;
      lastState = '';
      log('cloud: connected to', link.origin);
      send({ t: 'hello', role: 'mac', device });
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
      else if (frame.t === 'play') onPlay(frame.stop ? { stop: true } : { id: frame.id, type: String(frame.type || 'audio/wav'), bytes: Buffer.from(String(frame.bytes || ''), 'base64'), queued: frame.queued === true });
      else if (frame.t === 'hands') {
        Promise.resolve()
          .then(() => onHands(frame))
          .then(
            (result) => send({ t: 'hands-reply', id: frame.id, result: result ?? null }),
            (err) => send({ t: 'hands-reply', id: frame.id, error: String(err?.message || err) })
          );
      } else onFrame(frame);
    });
    socket.on('close', () => {
      // A line given up for a newer one (signed in again): its end is nothing.
      if (socket !== mine) return;
      const was = connected;
      connected = false;
      // The mic was the server's to open: with no server, it's closed.
      onVoice('close');
      if (was) {
        log('cloud: disconnected');
        onChange(false);
      }
      // Turned away, it's tried again only now and then: signing in again connects at once (use).
      if (!closed) retry = setTimeout(connect, refused ? RETRY_MS.at(-1) : RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
    });
    socket.on('error', (err) => {
      // Reached, and turned away: its key was replaced, or the user signed this Mac out. Signing in again mends it.
      if (/\b401\b/.test(String(err?.message))) {
        if (!refused) {
          refused = true;
          log('cloud: the server no longer takes this Mac’s key: sign in again');
          onRefused();
        }
        return;
      }
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
    /** The server turned this Mac's key away, and nothing's mended it yet. */
    get refused() {
      return refused;
    },
    /** Signed in again: the new key, used at once. */
    use(next) {
      link = next;
      refused = false;
      tries = 0;
      clearTimeout(retry);
      const old = socket;
      socket = null;
      if (connected) {
        connected = false;
        onVoice('close');
        onChange(false);
      }
      try {
        old?.terminate();
      } catch {
        /* not open */
      }
      connect();
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
    /** Anything else for the server: this Mac's things, moved in (move-in.js). */
    send(frame) {
      if (!connected) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
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
