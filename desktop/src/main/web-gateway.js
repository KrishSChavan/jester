/**
 * Jester's window as a website, for when he runs on a server (main.js's JESTER_SERVER).
 *
 * The window's pages talk to the main process with `chrome.runtime` messages and `chrome.storage`, over IPC in the
 * app. Here the same pages are served over HTTP, and src/web/shim.js gives them the same `chrome` over one
 * WebSocket: messages and their replies, storage and its changes. The same socket carries the always-on mic's
 * audio in (16 kHz mono floats, as the voice page sends them) and his voice out, for whichever browser said last
 * that it's the one being talked to (`voice-claim`): a phone, a laptop, or the Mac using him in the cloud.
 *
 * Only this machine can reach it (127.0.0.1): Tailscale (`tailscale serve`) puts it on the user's own devices, over
 * HTTPS. A key is asked for as well, so another program on the server, or a device someone else has on the tailnet,
 * gets nothing: opened once as `/?key=…`, it's kept as a cookie; the Mac sends it as a bearer token.
 *
 * No Electron here: tests run it in plain Node.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { resolveFile, ROOTS } from './files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '../web');
export const HOME_PATH = '/app/home/home.html';
const COOKIE = 'jester_key';
const YEAR_S = 365 * 24 * 3600;
/** A message bigger than this is no page's: a script's folder or a voice's take is far smaller. */
const MAX_FRAME = 8 * 1024 * 1024;
/** The extension's page policy, with the socket allowed: `'self'` covers wss:// to the same host. */
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon'
};
/**
 * Only his window's own files: the home page, what it imports, and the mic's worklet. Never the data folder, or the
 * main process's code. Checked on the file a path resolves to, so `..` can't step out of them.
 */
const SERVED_DIRS = [path.join(ROOTS.app, 'home'), path.join(ROOTS.app, 'vendor'), path.join(ROOTS.app, 'worklets'), path.join(ROOTS.ext, 'src', 'common'), path.join(ROOTS.ext, 'icons'), WEB_ROOT];
const SERVED_FILES = [path.join(ROOTS.app, 'main', 'os-actions.js'), path.join(ROOTS.app, 'main', 'watch-status.js')];

/** A key the gateway can be opened with: printed by the server's setup, kept in its data folder. */
export function makeKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function sameKey(given, key) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieOf(request) {
  for (const part of String(request.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function keyOf(request) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ''))?.[1];
  return bearer || cookieOf(request);
}

/** The file a request names, or null: only what SERVED allows, inside its root. */
export function servedFile(pathname) {
  let clean;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (clean.includes('\0')) return null;
  const file = clean.startsWith('/web/') ? path.resolve(WEB_ROOT, `.${clean.slice('/web'.length)}`) : clean.startsWith('/app/') ? resolveFile(`jester:/${clean}`, ROOTS) : null;
  if (!file) return null;
  return SERVED_FILES.includes(file) || SERVED_DIRS.some((dir) => file.startsWith(dir + path.sep)) ? file : null;
}

/** An HTML page, with the shim run before any of its own scripts. */
export function withShim(html) {
  const tag = '<script src="/web/shim.js"></script>';
  // The website's own styles, after the page's, so they win.
  const styled = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, '    <link rel="stylesheet" href="/web/web.css" />\n  </head>') : html;
  return /<head[^>]*>/i.test(styled) ? styled.replace(/<head[^>]*>/i, (head) => `${head}\n    ${tag}`) : `${tag}\n${styled}`;
}

/**
 * @param {object} options
 * @param {string} options.key
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {(client:object, message:any) => Promise<any>} options.onMessage   a page's chrome.runtime.sendMessage
 * @param {(area:string, op:string, arg:any) => Promise<any>} options.onStorage   a page's chrome.storage
 * @param {(client:object) => void} [options.onConnect]
 * @param {(client:object) => void} [options.onClose]
 * @param {(samples:Float32Array) => void} [options.onAudio]   the mic, from the client being talked to
 * @param {(report:object) => void} [options.onVoiceStatus]   the mic opened, or a sound ended
 * @param {(client:object, message:object) => void} [options.onOther]   anything else a client sends (the Mac's hands)
 * @param {(client:object) => void} [options.onVoiceClient]   the client being talked to changed
 */
export function createWebGateway({ key, port = 8770, host = '127.0.0.1', onMessage, onStorage, onConnect = () => undefined, onClose = () => undefined, onAudio = () => undefined, onVoiceStatus = () => undefined, onOther = () => undefined, onVoiceClient = () => undefined, log = () => undefined }) {
  if (!key || key.length < 16) throw new Error('The web gateway needs a key of at least 16 characters');
  const clients = new Set();
  /** The client being talked to: the mic is theirs, and so is his voice. */
  let voiceClient = null;
  /** Whether the mic should be open (the continuous assistant is listening). */
  let voiceWanted = false;
  let clientCount = 0;

  function refuse(response, status, text) {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(text);
  }

  async function serve(request, response) {
    const url = new URL(request.url, 'http://jester');
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'Not allowed');
    // Opened with the key: kept, and the address shown without it.
    const given = url.searchParams.get('key');
    if (given !== null) {
      if (!sameKey(given, key)) return refuse(response, 401, 'That key isn’t this Jester’s.');
      response.writeHead(303, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=${YEAR_S}; HttpOnly; Secure; SameSite=Strict`,
        Location: url.pathname === '/' ? HOME_PATH : url.pathname,
        'Cache-Control': 'no-store'
      });
      return response.end();
    }
    if (!sameKey(keyOf(request), key)) return refuse(response, 401, 'Open Jester with the link his server printed (it ends in ?key=…), once on each device.');
    if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/app/') {
      response.writeHead(302, { Location: HOME_PATH });
      return response.end();
    }
    const file = servedFile(url.pathname);
    if (!file) return refuse(response, 404, 'Not found');
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch {
      return refuse(response, 404, 'Not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (type.startsWith('text/html')) {
      body = Buffer.from(withShim(body.toString('utf8')));
      headers['Content-Security-Policy'] = CSP;
    }
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer((request, response) => {
    serve(request, response).catch((err) => {
      log('web: a request failed:', err.message);
      if (!response.headersSent) refuse(response, 500, 'Something went wrong');
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://jester');
    // A page on another site can't use a browser's cookie to reach him: its Origin isn't this one.
    const origin = request.headers.origin;
    const sameSite = !origin || new URL(origin).host === request.headers.host;
    if (url.pathname !== '/socket' || !sameSite || !sameKey(keyOf(request), key)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => accept(ws, request));
  });

  function send(client, frame) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(frame));
  }

  function setVoiceClient(client) {
    if (voiceClient === client) return;
    const before = voiceClient;
    voiceClient = client;
    if (before && voiceWanted) send(before, { t: 'voice', op: 'close' });
    if (client && voiceWanted) send(client, { t: 'voice', op: 'open' });
    log('web: talking through', client ? `${client.role} #${client.id}` : 'nobody');
    onVoiceClient(client);
  }

  function accept(ws, request) {
    clientCount += 1;
    const client = {
      id: clientCount,
      ws,
      role: 'page',
      url: 'jester://app/home/home.html',
      address: request.socket.remoteAddress,
      message: (message, sender) => send(client, { t: 'msg', message, sender }),
      storageChanged: (changes, area) => send(client, { t: 'storage-changed', changes, area }),
      send: (frame) => send(client, frame)
    };
    clients.add(client);
    log('web: connected', `#${client.id}`);

    ws.on('message', async (data, binary) => {
      if (binary) {
        // The mic: only the client being talked to's, and only while it should be open.
        if (client !== voiceClient || !voiceWanted || data.byteLength % 4) return;
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        onAudio(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
        return;
      }
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        switch (frame?.t) {
          case 'hello':
            client.role = frame.role === 'mac' ? 'mac' : 'page';
            onConnect(client);
            return;
          case 'msg':
            send(client, { t: 'reply', id: frame.id, reply: (await onMessage(client, frame.message)) ?? null });
            return;
          case 'storage':
            send(client, { t: 'reply', id: frame.id, reply: (await onStorage(String(frame.area), String(frame.op), frame.arg)) ?? null });
            return;
          case 'voice-claim':
            setVoiceClient(client);
            return;
          case 'voice-status':
            if (client === voiceClient) onVoiceStatus(frame.report || {});
            return;
          default:
            onOther(client, frame);
        }
      } catch (err) {
        log('web: a message failed:', err.message);
        if (frame?.id !== undefined) send(client, { t: 'reply', id: frame.id, reply: null, error: err.message });
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      log('web: gone', `#${client.id}`);
      onClose(client);
      if (client === voiceClient) {
        // The newest one left that has talked is talked through instead; until one claims it, nobody.
        voiceClient = null;
        onVoiceStatus({ gone: true });
        onVoiceClient(null);
      }
    });
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      log(`web: Jester's window at http://${host}:${server.address().port}`);
      resolve(server.address().port);
    });
  });

  return {
    ready,
    get clients() {
      return [...clients];
    },
    get voiceClient() {
      return voiceClient;
    },
    /** The mic opens on the client being talked to, now and whenever another claims it. */
    openVoice() {
      voiceWanted = true;
      if (voiceClient) send(voiceClient, { t: 'voice', op: 'open' });
    },
    closeVoice() {
      voiceWanted = false;
      if (voiceClient) send(voiceClient, { t: 'voice', op: 'close' });
    },
    /** His voice, to the client being talked to. False when there's nobody to play it. */
    play(id, bytes, type) {
      if (!voiceClient) return false;
      send(voiceClient, { t: 'play', id, type, bytes: Buffer.from(bytes).toString('base64') });
      return true;
    },
    stopPlaying() {
      if (voiceClient) send(voiceClient, { t: 'play', stop: true });
    },
    /** To every client of a role ('mac'), or all. */
    broadcast(frame, role = null) {
      for (const client of clients) if (!role || client.role === role) send(client, frame);
    },
    close() {
      for (const client of clients) client.ws.terminate();
      sockets.close();
      server.close();
    }
  };
}

/**
 * The voice page's half, for a gateway: what main.js's voice page does with a hidden window, done by the client
 * being talked to. Same shape as createVoicePage (voice-page.js).
 */
export function createRemoteVoicePage(gateway, { log = () => undefined } = {}) {
  let plays = 0;
  let playing = null;
  const PLAY_LIMIT_MS = 90000;
  const finish = () => {
    clearTimeout(playing?.limit);
    playing?.resolve();
    playing = null;
  };
  return {
    open: () => gateway.openVoice(),
    close() {
      finish();
      gateway.closeVoice();
    },
    play(bytes, type) {
      finish();
      plays += 1;
      const id = plays;
      if (!gateway.play(id, bytes, type)) return Promise.reject(new Error('Nobody’s browser is open to play his voice'));
      return new Promise((resolve) => {
        playing = { id, resolve, limit: setTimeout(finish, PLAY_LIMIT_MS) };
      });
    },
    stop() {
      if (!playing) return;
      gateway.stopPlaying();
      finish();
    },
    /** What the client being talked to said: its mic, or a sound that ended. */
    status(report) {
      if (report?.mic) log('web mic:', report.mic);
      if (playing && (report?.ended === playing.id || report?.gone)) finish();
    }
  };
}
