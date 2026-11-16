/**
 * Signing in with Google, to read the user's Gmail and nothing else: OAuth for
 * an installed app, with the browser doing the signing in.
 *
 * Google gives each app that signs people in a client (an id and a "secret",
 * which for a desktop app is no secret: it ships with the app). Jester has no
 * client of its own baked in: the user's comes from the file Google's console
 * gives for one ("Download JSON"), read once in Settings and kept sealed with
 * the other keys. Signing in opens Google's own page in their browser, asking
 * for one thing, to read their mail (gmail.readonly: he can't send, change or
 * delete), and Google sends the answer back to a port on this computer that's
 * open only while it's waited for. What that yields is kept sealed too, and
 * never logged: the log has that a sign-in happened, and why one failed, in
 * Google's own word for it ("invalid_grant").
 *
 * A client still in Google's "Testing" state is signed out by Google after
 * seven days. Then, or when the user takes his access away, he says so once
 * (`problem: 'signin'`) and reads nothing until they've signed in again.
 */

import crypto from 'node:crypto';
import http from 'node:http';

/** Read their mail, and no more. */
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** How long the browser's given to come back with an answer. */
const SIGN_IN_MS = 5 * 60_000;
const FETCH_MS = 15_000;
/** A token is asked for again this long before it runs out. */
const EARLY_MS = 60_000;

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * The client in the file Google's console gives for a Desktop app.
 * @returns {{id:string, secret:string}}  Throws, in words for Settings, when it isn't that file.
 */
export function clientIn(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('That isn’t the file from Google: it should be the JSON downloaded for the Desktop app client.');
  }
  if (json?.web) throw new Error('That file is for a “Web application” client. Make one of type “Desktop app” and download that.');
  const client = json?.installed;
  const id = String(client?.client_id ?? '');
  const secret = String(client?.client_secret ?? '');
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) || !secret) throw new Error('That isn’t the file from Google: it should be the JSON downloaded for the Desktop app client.');
  return { id, secret };
}

/** A port on this computer, open for the one answer: the browser is sent there by Google when they've signed in. */
function loopback() {
  let settle;
  const answered = new Promise((resolve) => (settle = resolve));
  const page = (words) => `<!doctype html><meta charset="utf-8"><title>Jester</title><body style="font:16px system-ui;background:#08060c;color:#efe9f7;display:grid;place-items:center;height:100vh;margin:0"><p>${words}</p>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/') return void response.writeHead(404).end();
    const ok = url.searchParams.has('code');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(ok ? 'Jester is signed in. You can close this tab.' : 'Jester wasn’t signed in. You can close this tab.'));
    settle(url.searchParams);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, answered, close: () => server.close() }));
  });
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function, remove:Function}} deps.storage  storage.local: the `google` key, sealed
 * @param {(url:string) => Promise<void>} deps.open  opens the user's browser
 * @param {() => Promise<{port:number, answered:Promise<URLSearchParams>, close:Function}>} [deps.listen]
 */
export function createGoogle({ storage, open, listen = loopback, fetchImpl = globalThis.fetch, now = Date.now, log = () => undefined, onChange = () => undefined }) {
  /** @type {{client:{id:string, secret:string}|null, refresh:string, access:string, expiresAt:number, email:string}} */
  let kept = { client: null, refresh: '', access: '', expiresAt: 0, email: '' };
  /** 'signin': Google wants them to sign in again. */
  let problem = '';
  /** The sign-in under way: what calls it off. */
  let waiting = null;
  let refreshing = null;

  async function save(next) {
    kept = { ...kept, ...next };
    await storage.set({ google: kept });
    onChange();
  }

  /** Google's token endpoint. Throws {code}: its own word for what went wrong, or 'unreachable'. */
  async function token(params) {
    let response;
    try {
      response = await fetchImpl(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
    } catch {
      throw Object.assign(new Error('Google couldn’t be reached.'), { code: 'unreachable' });
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) throw Object.assign(new Error(`Google refused it (${String(json.error || response.status).slice(0, 40)}).`), { code: String(json.error || 'refused').slice(0, 40) });
    return json;
  }

  /** A token to read with, asked for afresh when the one kept is about to run out. Throws {code:'signin'}. */
  async function access() {
    if (!kept.client || !kept.refresh) throw Object.assign(new Error('Not signed in to Google.'), { code: 'signin' });
    if (kept.access && kept.expiresAt - EARLY_MS > now()) return kept.access;
    refreshing ||= (async () => {
      try {
        const json = await token({ grant_type: 'refresh_token', refresh_token: kept.refresh, client_id: kept.client.id, client_secret: kept.client.secret });
        await save({ access: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 });
        problem = '';
        return kept.access;
      } catch (err) {
        // Google's taken the sign-in back: a week in Testing has passed, or the user took his access away.
        if (err.code === 'invalid_grant') {
          log('google: signed out by Google (invalid_grant): they need to sign in again');
          problem = 'signin';
          await save({ refresh: '', access: '', expiresAt: 0 });
          throw Object.assign(new Error('Google wants you to sign in again.'), { code: 'signin' });
        }
        throw err;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return {
    async start() {
      const stored = (await storage.get('google')).google;
      if (!stored || typeof stored !== 'object') return;
      const client = stored.client && typeof stored.client.id === 'string' && typeof stored.client.secret === 'string' ? { id: stored.client.id, secret: stored.client.secret } : null;
      kept = { client, refresh: client && typeof stored.refresh === 'string' ? stored.refresh : '', access: '', expiresAt: 0, email: typeof stored.email === 'string' ? stored.email : '' };
    },
    /** For Settings: nothing here is a key. */
    state: () => ({ client: !!kept.client, signedIn: !!kept.refresh, email: kept.email, problem, connecting: !!waiting }),
    get signedIn() {
      return !!kept.client && !!kept.refresh;
    },
    /** The file from Google's console, read: its client is kept, and anyone signed in with another is signed out. */
    async setClient(text) {
      const client = clientIn(text);
      if (kept.client?.id !== client.id) await save({ client, refresh: '', access: '', expiresAt: 0, email: '' });
      else await save({ client });
      log('google: a sign-in client was kept');
    },
    /**
     * Signs in: their browser opens Google's page, and this waits for its answer.
     * @returns {Promise<{ok:boolean, email?:string, error?:string}>}
     */
    async connect() {
      if (!kept.client) return { ok: false, error: 'Choose the file from Google first.' };
      if (waiting) return { ok: false, error: 'A sign-in is already open in your browser.' };
      const verifier = base64url(crypto.randomBytes(32));
      const state = base64url(crypto.randomBytes(16));
      let server;
      try {
        server = await listen();
      } catch {
        return { ok: false, error: 'Couldn’t open a port on this computer for Google’s answer.' };
      }
      const redirect = `http://127.0.0.1:${server.port}`;
      let timer;
      const gaveUp = new Promise((resolve) => {
        timer = setTimeout(resolve, SIGN_IN_MS, null);
        waiting = () => resolve(null);
      });
      onChange();
      try {
        const url = `${AUTH}?${new URLSearchParams({ client_id: kept.client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' })}`;
        await open(url);
        const answer = await Promise.race([server.answered, gaveUp]);
        if (!answer) return { ok: false, error: 'The sign-in wasn’t finished.' };
        // Only the answer to this asking counts: another page sending the browser here is nobody's sign-in.
        if (answer.get('state') !== state) return { ok: false, error: 'That answer wasn’t to this sign-in. Try it again.' };
        if (!answer.get('code')) return { ok: false, error: answer.get('error') === 'access_denied' ? 'You didn’t allow it, so nothing was connected.' : 'Google didn’t sign you in.' };
        const json = await token({ grant_type: 'authorization_code', code: answer.get('code'), client_id: kept.client.id, client_secret: kept.client.secret, code_verifier: verifier, redirect_uri: redirect });
        if (!json.refresh_token) return { ok: false, error: 'Google signed you in for an hour only. Try it again.' };
        if (!String(json.scope || SCOPE).split(' ').includes(SCOPE)) return { ok: false, error: 'Reading your mail wasn’t ticked on Google’s page, so there’s nothing he can read. Try again and leave it ticked.' };
        await save({ refresh: json.refresh_token, access: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000, email: '' });
        problem = '';
        const profile = await this.get('/profile').catch(() => null);
        await save({ email: typeof profile?.emailAddress === 'string' ? profile.emailAddress : '' });
        log('google: signed in');
        return { ok: true, email: kept.email };
      } catch (err) {
        log('google: the sign-in failed:', err.code || 'error');
        return { ok: false, error: err.message || 'Google didn’t sign you in.' };
      } finally {
        clearTimeout(timer);
        waiting = null;
        server.close();
        onChange();
      }
    },
    /** A sign-in that's waiting is called off. */
    cancel() {
      waiting?.();
    },
    /**
     * Reads from Gmail: `path` under users/me, with `params`. Throws {code}: 'signin' when they have to sign in
     * again, 'gone' for a 404, 'unreachable', or 'refused'.
     */
    async get(path, params = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) for (const one of [].concat(value)) query.append(key, String(one));
      const url = `${GMAIL}${path}${[...query].length ? `?${query}` : ''}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const bearer = await access();
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
        } catch {
          throw Object.assign(new Error('Gmail couldn’t be reached.'), { code: 'unreachable' });
        }
        if (response.ok) return response.json();
        // A token Google no longer takes is asked for again, once.
        if (response.status === 401 && attempt === 0) {
          kept = { ...kept, access: '', expiresAt: 0 };
          continue;
        }
        throw Object.assign(new Error(`Gmail answered ${Number(response.status) || 0}.`), { code: response.status === 404 ? 'gone' : response.status === 401 ? 'signin' : 'refused', status: Number(response.status) || 0 });
      }
      throw Object.assign(new Error('Gmail refused it.'), { code: 'refused' });
    },
    /** Signs out: Google's told to forget the sign-in, and it's forgotten here whether or not Google answered. */
    async signOut() {
      const refresh = kept.refresh;
      await save({ refresh: '', access: '', expiresAt: 0, email: '' });
      problem = '';
      if (refresh) await fetchImpl(REVOKE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }).toString(), redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) }).catch(() => undefined);
      log('google: signed out');
    },
    /** The client forgotten too: back to before the file was chosen. */
    async forget() {
      await this.signOut();
      await save({ client: null });
    }
  };
}
