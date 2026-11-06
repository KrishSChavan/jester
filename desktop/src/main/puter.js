/**
 * Jester's voice, from Puter's text-to-speech. Text goes to Puter, which passes
 * it to the voice's provider; audio comes back and the app plays it.
 *
 * Puter's script isn't run in the app. It's remote code, and in a page it needs a
 * sign-in the page can't show, so this makes the same call it makes, from the
 * main process, with a token from the way Puter's own Node package signs in: the
 * user approves in their browser, which comes back to a port here.
 *
 * "Free" means an allowance on the user's Puter account, $0.50 a month in Puter's
 * source (tempUserFreePolicy, registeredUserFreePolicy). An hour of use won't reach
 * it, but a month of talking can: then it answers 402, and the Mac's voice takes over.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';

const API = 'https://api.puter.com/drivers/call';
const SIGN_IN = 'https://puter.com/';
const VOICE = { provider: 'aws-polly', voice: 'Matthew', engine: 'neural', language: 'en-US' };
/** Enough for the page to load and a person to read it. */
const SIGN_IN_MS = 5 * 60 * 1000;
const SYNTHESIZE_MS = 15000;
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Jester</title><body style="font:16px system-ui;margin:4rem;text-align:center"><h1>Jester can talk now</h1><p>You can close this tab.</p>`;

/** Puter's refusal, with what to do about it: `code` is for telling them apart. */
export class PuterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PuterError';
    this.code = code;
  }
}

/**
 * Signs in through the browser.
 * @param {(url:string) => unknown} openBrowser
 * @param {{listen?:typeof http.createServer, limitMs?:number}} [options]
 * @returns {Promise<string>} the token
 */
export function signInToPuter(openBrowser, { createServer = http.createServer, limitMs = SIGN_IN_MS } = {}) {
  const state = randomBytes(32).toString('base64url');
  return new Promise((resolve, reject) => {
    let limit = null;
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1/');
      const token = url.searchParams.get('token');
      if (url.searchParams.get('state') !== state || !token) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      response.end(DONE_PAGE);
      clearTimeout(limit);
      server.close();
      resolve(token);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      limit = setTimeout(() => {
        server.close();
        reject(new PuterError('The sign-in wasn’t finished.', 'sign_in_timeout'));
      }, limitMs);
      const back = new URL(`http://127.0.0.1:${server.address().port}/`);
      back.searchParams.set('state', state);
      const signIn = new URL(SIGN_IN);
      signIn.searchParams.set('action', 'authme');
      signIn.searchParams.set('redirectURL', back.href);
      openBrowser(signIn.href);
    });
  });
}

/**
 * @param {string} text
 * @param {string} token
 * @returns {Promise<{bytes:Uint8Array, type:string}>} the audio
 */
export async function synthesize(text, token, { fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await fetchImpl(API, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;actually=json' },
    body: JSON.stringify({ interface: 'puter-tts', driver: 'ai-tts', test_mode: false, method: 'synthesize', args: { text, ...VOICE }, auth_token: token }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SYNTHESIZE_MS)]) : AbortSignal.timeout(SYNTHESIZE_MS)
  });
  const type = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (response.ok && type.startsWith('audio/')) return { bytes: new Uint8Array(await response.arrayBuffer()), type };
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new PuterError('Puter needs signing in to again.', 'signed_out');
  if (response.status === 402) throw new PuterError('Puter’s free allowance has run out for this month.', 'no_credits');
  // A result as text: a data URL, the other shape the driver answers with.
  const inline = /^data:(audio\/[^;]+);base64,(.+)$/.exec(typeof body.result === 'string' ? body.result : '');
  if (inline) return { bytes: new Uint8Array(Buffer.from(inline[2], 'base64')), type: inline[1] };
  throw new PuterError(`Puter said: ${body.message || body.error?.message || response.status}`, 'refused');
}
