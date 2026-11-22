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
/**
 * How long a Mac is given to make a piece of his voice (createRemoteVoice) before the server makes it instead. Its
 * M4 Pro makes one in well under half a second, and loading Kokoro there first is about half a second more.
 */
const MAKE_MS = 4000;
/** The extension's page policy, with the socket allowed: `'self'` covers wss:// to the same host. */
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const TYPES = {
  '.webmanifest': 'application/manifest+json',
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
const SERVED_DIRS = [path.join(ROOTS.app, 'home'), path.join(ROOTS.app, 'controls'), path.join(ROOTS.app, 'vendor'), path.join(ROOTS.app, 'worklets'), path.join(ROOTS.ext, 'src', 'common'), path.join(ROOTS.ext, 'icons'), WEB_ROOT];
const SERVED_FILES = [path.join(ROOTS.app, 'main', 'os-actions.js'), path.join(ROOTS.app, 'main', 'watch-status.js')];

/**
 * What anyone who reaches the server may have, signed in or not, for his website as an app on a Home Screen (the
 * user, 2026-11-18: "make the website so that I can download it as a PWA especially on my phone"): its worker, its
 * icons, and the pages for signing in and for being offline. Nothing of his is in them. The manifest is made below.
 */
const PUBLIC = new Map([
  ['/sw.js', 'sw.js'],
  ['/web/offline.html', 'offline.html'],
  ['/web/sign-in.js', 'sign-in.js'],
  ['/web/icons/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
  ['/web/icons/icon-192.png', 'icons/icon-192.png'],
  ['/web/icons/icon-512.png', 'icons/icon-512.png'],
  ['/web/icons/maskable-512.png', 'icons/maskable-512.png'],
  // A browser's tab. It asks for /favicon.ico by that name whatever a page says, the sign-in page's tab included.
  ['/web/icons/favicon-32.png', 'icons/favicon-32.png'],
  ['/favicon.ico', 'icons/favicon.ico']
]);

/**
 * A few letters that change when the icons' art does, put on every icon's address a page or the manifest gives
 * (`?v=`). A browser keeps a tab's icon, and a phone or a desktop its installed app's, by address: at the same
 * address a new icon was never looked for (the user, 2026-11-19: "the website did not get the new icon for the pwa
 * or favicon"). The files answer at their plain addresses too: the query is only what makes an address new.
 */
const ICON_FILES = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'maskable-512.png', 'favicon-32.png', 'favicon.ico'];
const ICONS_DIR = path.join(WEB_ROOT, 'icons');
let iconStamp = null;
export function iconVersion(dir = ICONS_DIR) {
  if (dir === ICONS_DIR && iconStamp !== null) return iconStamp;
  const hash = crypto.createHash('sha256');
  for (const name of ICON_FILES) {
    try {
      hash.update(name).update(fs.readFileSync(path.join(dir, name)));
    } catch {
      /* one that isn't there is no part of it */
    }
  }
  const stamp = hash.digest('hex').slice(0, 8);
  if (dir === ICONS_DIR) iconStamp = stamp;
  return stamp;
}

/**
 * A page of the website's own (the sign-in), with its icons' addresses stamped: only in `<link>` tags, and only
 * ones not stamped already. A picture on the page keeps its plain address, which the worker's offline copy has.
 */
export function withIconVersion(html, version = iconVersion()) {
  return html.replace(/(<link\b[^>]*\bhref=")(\/favicon\.ico|\/web\/icons\/[\w.-]+)(")/g, `$1$2?v=${version}$3`);
}
/**
 * A sign-in code (`?install=`) works this long: in the manifest his signed-in page links, so his website added to a
 * phone's Home Screen (which keeps its own cookies, apart from the browser's) signs itself in when first opened; and
 * copied from Settings, for another device. Never the key itself, which stays in its HttpOnly cookie.
 */
export const INSTALL_MS = 24 * 60 * 60 * 1000;
const INSTALL_KEPT = 64;

/** His website's app manifest: opened at `start`, the address that signs it in when there's a code to. */
export function manifestFor(install = '') {
  return {
    id: '/',
    name: 'Jester',
    short_name: 'Jester',
    description: 'Your own AI: talk or type to him, from your phone or any computer of yours.',
    start_url: install ? `/?install=${encodeURIComponent(install)}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#08060c',
    theme_color: '#08060c',
    icons: [
      { src: `/web/icons/icon-192.png?v=${iconVersion()}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/web/icons/icon-512.png?v=${iconVersion()}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/web/icons/maskable-512.png?v=${iconVersion()}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}

/** The address the proxy in front of him says a request came from: the last in X-Forwarded-For, the only one it wrote. */
export const forwardedFrom = (request) => String(request.headers['x-forwarded-for'] || '').split(',').at(-1).trim().slice(0, 64);

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

/**
 * An HTML page, with the shim run before any of its own scripts; and what makes it an app on a Home Screen: its
 * manifest (with a sign-in code, for one added from this signed-in page), its icon, and its look there.
 */
export function withShim(html, { install = '' } = {}) {
  const tag = '<script src="/web/shim.js"></script>';
  const app = [
    `<link rel="manifest" href="/manifest.webmanifest${install ? `?install=${encodeURIComponent(install)}` : ''}" />`,
    '<meta name="theme-color" content="#08060c" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
    '<meta name="apple-mobile-web-app-title" content="Jester" />',
    // The tab's icon, which a page of his had none of; and the Home Screen's.
    `<link rel="icon" href="/favicon.ico?v=${iconVersion()}" sizes="48x48" />`,
    `<link rel="icon" type="image/png" sizes="32x32" href="/web/icons/favicon-32.png?v=${iconVersion()}" />`,
    `<link rel="icon" type="image/png" sizes="192x192" href="/web/icons/icon-192.png?v=${iconVersion()}" />`,
    `<link rel="apple-touch-icon" href="/web/icons/apple-touch-icon.png?v=${iconVersion()}" />`
  ].join('\n    ');
  // The website's own styles, after the page's, so they win.
  const styled = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `    <link rel="stylesheet" href="/web/web.css" />\n    ${app}\n  </head>`) : html;
  return /<head[^>]*>/i.test(styled) ? styled.replace(/<head[^>]*>/i, (head) => `${head}\n    ${tag}`) : `${tag}\n${styled}`;
}

/**
 * A sign-in his server started sends the browser back to http://127.0.0.1:<port>/?state=…&code=…: on a phone, nothing.
 * The address is pasted instead, and this says where on the server it goes: only to the port that sign-in opened, its
 * root, with that sign-in's own state, and only the answer's own parameters. Anything else is null, so a page can't
 * use a pasted address to reach any other service on the server.
 * @param {string} pasted  what the user pasted
 * @param {string|null} page  the sign-in page that was opened (its redirect_uri and state)
 */
export function landingAddress(pasted, page) {
  let landed;
  let asked;
  let state;
  try {
    landed = new URL(String(pasted || '').trim());
    const opened = new URL(page);
    asked = new URL(opened.searchParams.get('redirect_uri'));
    state = opened.searchParams.get('state');
  } catch {
    return null;
  }
  if (!state || asked.hostname !== '127.0.0.1' || !asked.port) return null;
  if (landed.protocol !== 'http:' || landed.hostname !== '127.0.0.1' || landed.port !== asked.port || landed.pathname !== '/' || landed.searchParams.get('state') !== state) return null;
  const kept = [...landed.searchParams].filter(([name]) => ['state', 'code', 'scope', 'error'].includes(name));
  return `http://127.0.0.1:${asked.port}/?${new URLSearchParams(kept)}`;
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
export function createWebGateway({ key, port = 8770, host = '127.0.0.1', onMessage, onStorage, onConnect = () => undefined, onClose = () => undefined, onAudio = () => undefined, onVoiceStatus = () => undefined, onOther = () => undefined, onVoiceClient = () => undefined, onSeen = () => undefined, login = null, log = () => undefined }) {
  if (!key || key.length < 16) throw new Error('The web gateway needs a key of at least 16 characters');
  const clients = new Set();
  /** The client being talked to: the mic is theirs, and so is his voice. */
  let voiceClient = null;
  /** Whether the mic should be open (the continuous assistant is listening). */
  let voiceWanted = false;
  let clientCount = 0;
  /** Pieces of his voice a Mac's been asked to make: id → {client, finish}. */
  const making = new Map();
  /** Ones it's made and keeps until told to play them: id → the client keeping it. */
  const kept = new Map();
  let makes = 0;

  function refuse(response, status, text) {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(text);
  }

  /** Sign-in codes (INSTALL_MS), and when each runs out: kept in memory, so a restart ends them. */
  const installs = new Map();
  function installToken() {
    const at = Date.now();
    for (const [code, until] of installs) if (until <= at) installs.delete(code);
    while (installs.size >= INSTALL_KEPT) installs.delete(installs.keys().next().value);
    const code = crypto.randomBytes(18).toString('base64url');
    installs.set(code, at + INSTALL_MS);
    return code;
  }
  const installed = (code) => (installs.get(String(code ?? '')) || 0) > Date.now();

  /** A page opened, not a script or a message: shown the sign-in, not a plain refusal. */
  const opening = (request) => request.headers['sec-fetch-mode'] === 'navigate' || (!request.headers['sec-fetch-mode'] && /text\/html/.test(String(request.headers.accept || '')));

  /** A file of his website, as it's served: HTML with its policy (and, for a page of his, the shim). */
  async function send200(request, response, file, { status = 200, shim = false } = {}) {
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch {
      return refuse(response, 404, 'Not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
    if (type.startsWith('text/html')) {
      if (shim) body = Buffer.from(withShim(body.toString('utf8'), { install: installToken() }));
      // The sign-in page's own icon links, stamped. Not the offline page, which the worker keeps as it is.
      else if (path.basename(file) !== 'offline.html') body = Buffer.from(withIconVersion(body.toString('utf8')));
      headers['Content-Security-Policy'] = CSP;
    }
    response.writeHead(status, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  const signIn = (request, response) => send200(request, response, path.join(WEB_ROOT, 'sign-in.html'), { status: 401 });
  const keep = (response, location) => {
    response.writeHead(303, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=${YEAR_S}; HttpOnly; Secure; SameSite=Strict`, Location: location, 'Cache-Control': 'no-store' });
    return response.end();
  };

  /**
   * Where a request comes from, for counting wrong tries: the last address in X-Forwarded-For, which is the one
   * Tailscale's proxy on this machine wrote (he only listens to this machine). Anything before it is the sender's
   * own say-so, and a sender could change it with every try.
   */
  const sourceOf = (request) => forwardedFrom(request) || String(request.socket.remoteAddress || 'unknown');

  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    response.end(JSON.stringify(body));
  };

  /**
   * Signing in with the password (web-login.js): posted by his sign-in page, from this site only. Right, the browser
   * is given the cookie his key link gives; wrong, why, and how long before another try.
   */
  async function passwordSignIn(request, response) {
    const origin = request.headers.origin;
    let from = '';
    try {
      from = origin ? new URL(origin).host : '';
    } catch {
      from = 'unreadable';
    }
    if (origin && ![request.headers.host, request.headers['x-forwarded-host']].includes(from)) return json(response, 403, { ok: false, error: 'Sign in from Jester’s own page.' });
    if (!login) return json(response, 404, { ok: false, error: 'This Jester has no password sign-in.' });
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 2048) return json(response, 413, { ok: false, error: 'That’s too long to be a password.' });
    }
    let password = '';
    try {
      password = String(JSON.parse(body)?.password ?? '');
    } catch {
      return json(response, 400, { ok: false, error: 'That wasn’t a sign-in.' });
    }
    const result = await login.check(password, sourceOf(request));
    if (!result.ok) return json(response, result.wait ? 429 : 401, { ok: false, error: result.error, wait: Math.ceil(result.wait / 1000) }, result.wait ? { 'Retry-After': String(Math.ceil(result.wait / 1000)) } : {});
    log('web: signed in with the password');
    return json(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=${YEAR_S}; HttpOnly; Secure; SameSite=Strict` });
  }

  async function serve(request, response) {
    const url = new URL(request.url, 'http://jester');
    if (request.method === 'POST' && url.pathname === '/sign-in') return passwordSignIn(request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'Not allowed');
    // Reachable from anywhere, he's nobody's to list: search engines are asked to stay out.
    if (url.pathname === '/robots.txt') return refuse(response, 200, 'User-agent: *\nDisallow: /\n');
    // For his sign-in page: whether there's a password to ask for.
    if (url.pathname === '/sign-in.json') return json(response, 200, { password: !!login?.state().set });
    // This browser, signed out: its cookie's taken back.
    if (url.pathname === '/sign-out') {
      response.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`, Location: '/', 'Cache-Control': 'no-store' });
      return response.end();
    }
    // His website as an app: what's needed before signing in, for anyone.
    if (PUBLIC.has(url.pathname)) return send200(request, response, path.join(WEB_ROOT, PUBLIC.get(url.pathname)));
    if (url.pathname === '/manifest.webmanifest') {
      const code = url.searchParams.get('install');
      response.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return response.end(request.method === 'HEAD' ? undefined : JSON.stringify(manifestFor(installed(code) ? code : '')));
    }
    const signedIn = sameKey(keyOf(request), key);
    // Opened with the key: kept, and the address shown without it.
    const given = url.searchParams.get('key');
    if (given !== null) {
      if (!sameKey(given, key)) return opening(request) ? signIn(request, response) : refuse(response, 401, 'That key isn’t this Jester’s.');
      return keep(response, url.pathname === '/' ? HOME_PATH : url.pathname);
    }
    // Opened with a sign-in code (his website on a Home Screen, or a link copied from Settings): kept the same way.
    const code = url.searchParams.get('install');
    if (code !== null && url.pathname === '/') {
      if (installed(code)) return keep(response, HOME_PATH);
      if (!signedIn) return signIn(request, response);
    }
    if (!signedIn) return opening(request) ? signIn(request, response) : refuse(response, 401, 'Open Jester with the link his server printed (it ends in ?key=…), once on each device.');
    if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/app/') {
      response.writeHead(302, { Location: HOME_PATH });
      return response.end();
    }
    const file = servedFile(url.pathname);
    if (!file) return refuse(response, 404, 'Not found');
    return send200(request, response, file, { shim: true });
  }

  const server = http.createServer((request, response) => {
    serve(request, response).catch((err) => {
      log('web: a request failed:', err.message);
      if (!response.headersSent) refuse(response, 500, 'Something went wrong');
    });
  });
  // Reachable from anywhere, a request that dawdles is dropped: nothing he's asked takes long to send.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://jester');
    // A page on another site can't use a browser's cookie to reach him: its Origin isn't this one.
    // Behind `tailscale serve`, the host the browser asked for may come as X-Forwarded-Host.
    const origin = request.headers.origin;
    let originHost = '';
    try {
      originHost = origin ? new URL(origin).host : '';
    } catch {
      originHost = 'unreadable';
    }
    const sameSite = !origin || [request.headers.host, request.headers['x-forwarded-host']].includes(originHost);
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
    log('web: talking through', client ? `${client.role} #${client.id}${client.makesVoice ? ', his voice made there' : ''}` : 'nobody');
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
      // What it's on (device-location.js names it: "your iPhone"), and whether it's the Mac's own window (hello).
      agent: String(request.headers['user-agent'] || '').slice(0, 300),
      macWindow: false,
      // Where it connects from, as `tailscale serve` says: a computer and the browsers on it share one.
      from: forwardedFrom(request),
      device: { id: '', name: '', app: false },
      visible: true,
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
            // Which of the user's devices it is (devices.js): an id it keeps, a computer's own name, his app or a tab.
            client.device = { id: String(frame.device?.id ?? '').slice(0, 64), name: String(frame.device?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40), app: frame.device?.app === true };
            if (typeof frame.visible === 'boolean') client.visible = frame.visible;
            // His website in the Mac's own window (web/shim.js says so): the Mac answers where it is, not the page.
            client.macWindow = client.role === 'page' && frame.macWindow === true;
            // A Mac with his voice on it makes it there, when it's the one being talked to (createRemoteVoice).
            client.makesVoice = client.role === 'mac' && frame.makesVoice === true;
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
          // A piece of his voice it was asked to make (make): made and kept, or not.
          case 'made': {
            const asked = making.get(frame.id);
            if (asked?.client === client) asked.finish(frame);
            return;
          }
          // Its page came to the front or went behind.
          case 'here':
            onSeen(client, { visible: frame.visible === true });
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
      for (const asked of [...making.values()]) if (asked.client === client) asked.finish(null);
      for (const [id, keeper] of [...kept]) if (keeper === client) kept.delete(id);
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
    /** A sign-in code for another device, for a signed-in page to copy (Settings): never the key itself. */
    installToken,
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
    /**
     * His voice, to the client being talked to. False when there's nobody to play it. `made`: a piece that client
     * made and kept (make), played from there; false when it's another's, or gone.
     */
    play(id, bytes, type, queued = false, made = undefined) {
      if (!voiceClient) return false;
      if (made !== undefined) {
        const keeper = kept.get(made);
        kept.delete(made);
        if (keeper !== voiceClient) return false;
        send(voiceClient, { t: 'play', id, made, ...(queued ? { queued: true } : {}) });
        return true;
      }
      send(voiceClient, { t: 'play', id, type, bytes: Buffer.from(bytes).toString('base64'), ...(queued ? { queued: true } : {}) });
      return true;
    },
    /** Whether the client being talked to makes his voice itself: a Mac with Kokoro on it. */
    get voiceMadeThere() {
      return !!voiceClient?.makesVoice;
    },
    /**
     * A piece of his voice made by the client being talked to, a Mac with his voice on it, and kept there to play:
     * its id there and how long it lasts, or null (it isn't one, can't, or took too long; the server makes it then).
     * Dropped there if `signal` ends before it's played.
     * @returns {Promise<{made:number, seconds:number}|null>}
     */
    make(text, { signal, tight = false, speed = 1, voice, limitMs = MAKE_MS } = {}) {
      const client = voiceClient;
      if (!client?.makesVoice || client.ws.readyState !== 1 || signal?.aborted) return Promise.resolve(null);
      makes += 1;
      const id = makes;
      const drop = () => {
        if (making.has(id) || kept.has(id)) send(client, { t: 'unmake', id });
        kept.delete(id);
        making.get(id)?.finish(null);
      };
      return new Promise((resolve) => {
        const limit = setTimeout(() => {
          if (making.has(id)) log('web: the Mac took too long to make his voice; made here instead');
          drop();
        }, limitMs);
        making.set(id, {
          client,
          finish: (reply) => {
            if (!making.has(id)) return;
            making.delete(id);
            clearTimeout(limit);
            const ok = reply?.ok === true && client.ws.readyState === 1 && !signal?.aborted;
            if (ok) kept.set(id, client);
            // A Mac whose voice isn't there (not downloaded) isn't asked again until it connects again.
            else if (reply?.missing && client.makesVoice) {
              client.makesVoice = false;
              log(`web: ${client.role} #${client.id} has no voice of its own now; made here`);
            }
            resolve(ok ? { made: id, seconds: Number(reply.seconds) || 0 } : null);
          }
        });
        signal?.addEventListener('abort', drop, { once: true });
        send(client, { t: 'make', id, text: String(text), ...(voice ? { voice } : {}), ...(tight ? { tight: true } : {}), ...(speed !== 1 ? { speed } : {}) });
      });
    },
    /** Someone's started talking to him: a Mac that makes his voice loads it meanwhile. */
    warmVoice(voice) {
      if (voiceClient?.makesVoice) send(voiceClient, { t: 'warm', ...(voice ? { voice } : {}) });
    },
    stopPlaying() {
      if (voiceClient) send(voiceClient, { t: 'play', stop: true });
    },
    /** A frame for one client, while it's connected: the conversation for a computer's own pill (main.js showConversation). */
    tell(client, frame) {
      if (clients.has(client)) send(client, frame);
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
  /** The sounds playing or queued after it: id → what ends each. */
  const playing = new Map();
  const PLAY_LIMIT_MS = 90000;
  /** One sound over, or with no id every one of them. */
  const finish = (id) => {
    for (const [each, sound] of [...playing]) {
      if (id !== undefined && each !== id) continue;
      clearTimeout(sound.limit);
      playing.delete(each);
      sound.resolve();
    }
  };
  return {
    open: () => gateway.openVoice(),
    close() {
      finish();
      gateway.closeVoice();
    },
    /**
     * `queued`: played as what's playing there ends, with no gap and no round trip between. `made`: a piece the
     * client made and kept (createRemoteVoice), played from there.
     */
    play(bytes, type, { queued = false, made } = {}) {
      if (!queued) finish();
      plays += 1;
      const id = plays;
      const ended = new Promise((resolve) => {
        playing.set(id, { resolve, limit: setTimeout(() => finish(id), PLAY_LIMIT_MS) });
      });
      if (!gateway.play(id, bytes, type, queued, made)) {
        finish(id);
        return Promise.reject(new Error('Nobody’s browser is open to play his voice'));
      }
      return ended;
    },
    stop() {
      if (!playing.size) return;
      gateway.stopPlaying();
      finish();
    },
    /** What the client being talked to said: its mic, or a sound that ended. */
    status(report) {
      if (report?.mic) log('web mic:', report.mic);
      // Held for a tap, or played after one (web/shim.js): a phone plays no sound before it's touched.
      if (report?.voice) log('web voice:', report.voice);
      if (report?.gone) finish();
      else if (report?.ended !== undefined && playing.has(report.ended)) finish(report.ended);
    }
  };
}

/**
 * His voice, for a server's speaker (speaker.js): made by the client being talked to when that's a Mac with his voice
 * on it, and by the server's own (`local`, kokoro.js) otherwise. His server's four cores take about half a second and
 * then 28 to 42 ms a character, against about a tenth of a second and 7 to 10 on an M4 Pro, and the Mac is a round
 * trip of 40 ms or so away: "The speaking is still just a little slow even on the electron app" (2026-11-21).
 * What's made there stays there, and only which piece to play is sent.
 * @param {ReturnType<typeof createWebGateway>} gateway
 * @param {{sound:Function, warm?:Function}} local
 * @param {{voice?:() => string|undefined, now?:() => number}} [options]  `voice`: the one Settings names, on the server
 */
export function createRemoteVoice(gateway, local, { voice = () => undefined, now = Date.now } = {}) {
  return {
    /** Where it's made: how quickly differs (speaker.js keeps each one's timing). */
    get where() {
      return gateway.voiceMadeThere ? 'there' : 'here';
    },
    async sound(text, options = {}) {
      const started = now();
      const made = gateway.voiceMadeThere ? await gateway.make(text, { ...options, voice: voice() }) : null;
      if (options.signal?.aborted) return null;
      // How long it took, round trip and all: what the speaker cuts the first sentence by.
      if (made) return { made: made.made, bytes: null, type: 'audio/wav', seconds: made.seconds, tookMs: now() - started };
      return local.sound(text, options);
    },
    warm() {
      local.warm?.();
      gateway.warmVoice(voice());
    }
  };
}
