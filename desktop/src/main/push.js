/**
 * Notifications from his own app (the user, 2026-11-18: "get rid of the ntfy app and get notifications from the
 * jester pwa"): Web Push, from his server to his website installed on a phone's Home Screen, or any browser that
 * takes it.
 *
 * A device subscribes with its browser's push service (Apple's for an iPhone, Google's for Chrome, Mozilla's) and
 * hands the subscription here: an address at that service, and the device's public key. What's sent is encrypted to
 * that key (RFC 8291, aes128gcm), so the push service carries it without being able to read it, and signed as this
 * server's (VAPID, RFC 8292) with a key made here once and kept sealed. Nothing else is needed: no account, no app
 * but his own.
 *
 * Only to the push services browsers use, over https: a subscription is a page's word for where to send, and the
 * server sends nowhere else on it.
 */

import crypto from 'node:crypto';
import { phoneText, WITHHELD } from './phone.js';

const SEND_MS = 10_000;
/** A push service keeps what couldn't be delivered this long (a phone that's off). */
const KEEP_S = 24 * 60 * 60;
/** The same words to the same device again this soon are one telling, not two. */
const SAME_MS = 2 * 60 * 1000;
const MOST = 12;
/** Who a push service can write to about this sender: his project's page, never the user's own address. */
const CONTACT = 'https://github.com/KrishSChavan/jester';
/** The push services of Safari, Chrome and its kin, Firefox, and Edge on Windows. */
const SERVICES = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64 = (text) => Buffer.from(String(text || ''), 'base64url');

/** Whether an address is a push service's, over https. */
export function pushService(endpoint) {
  try {
    const url = new URL(String(endpoint));
    return url.protocol === 'https:' && !url.username && SERVICES.some((service) => service.test(url.hostname));
  } catch {
    return false;
  }
}

/** A subscription as it's kept, or null if it isn't one: an address, and the device's key and secret. */
export function subscriptionIn(given, { allowed = pushService } = {}) {
  const endpoint = String(given?.endpoint || '');
  const p256dh = unb64(given?.keys?.p256dh);
  const auth = unb64(given?.keys?.auth);
  if (endpoint.length > 2000 || !allowed(endpoint) || p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
  return { endpoint, keys: { p256dh: b64(p256dh), auth: b64(auth) } };
}

/**
 * A message, encrypted for one subscription (RFC 8291): the body to post to its address.
 * @param {{keys:{p256dh:string, auth:string}}} subscription
 * @param {Buffer|string} message
 * @param {{salt?:Buffer, local?:crypto.ECDH}} [fixed]  for a test: the salt and the sender's key, which are random
 */
export function encrypted(subscription, message, { salt = crypto.randomBytes(16), local = null } = {}) {
  const theirs = unb64(subscription.keys.p256dh);
  const secret = unb64(subscription.keys.auth);
  const sender = local || crypto.createECDH('prime256v1');
  if (!local) sender.generateKeys();
  const ours = sender.getPublicKey();
  const shared = sender.computeSecret(theirs);
  const keying = Buffer.from(crypto.hkdfSync('sha256', shared, secret, Buffer.concat([Buffer.from('WebPush: info\0'), theirs, ours]), 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', keying, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', keying, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  // One record: the message, then 0x02, which says it's the last.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(message), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(ours.length, 20);
  return Buffer.concat([header, ours, sealed]);
}

/** A new signing key for this server: its public half as browsers take it, and the private one to keep. */
export function newKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])), privateKey: privateKey.export({ format: 'jwk' }) };
}

/** The Authorization for a push to `endpoint`, signed as this server (RFC 8292). */
export function vapid(endpoint, keys, at = Date.now()) {
  const part = (value) => b64(JSON.stringify(value));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: CONTACT })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: crypto.createPrivateKey({ key: keys.privateKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage   storage.local: the `push` key, sealed (chrome-bridge.js)
 * @param {(endpoint:string) => boolean} [deps.allowed]  for a test: where a subscription may point
 */
export function createPush({ storage, fetchImpl = globalThis.fetch, allowed = pushService, now = Date.now, log = () => undefined, onChange = () => undefined }) {
  let keys = null;
  /** device id → { endpoint, keys, at } */
  let subs = {};
  /** What was last sent to each device, and when: the same again so soon isn't sent. */
  const lately = new Map();
  let last = null;

  const save = () => storage.set({ push: { keys, subs } }).then(onChange, (err) => log('push: couldn’t be kept:', err.message));

  async function post(device, payload, { urgent = false } = {}) {
    const subscription = subs[device];
    if (!subscription) return 'none';
    let response;
    try {
      response = await fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers: { TTL: String(KEEP_S), Urgency: urgent ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapid(subscription.endpoint, keys, now()) },
        body: encrypted(subscription, JSON.stringify(payload)),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_MS)
      });
    } catch (err) {
      return err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'late' : 'unreached';
    }
    if (response.status === 404 || response.status === 410) {
      // The device took its subscription back (the app removed, or notifications turned off there).
      delete subs[device];
      await save();
      return 'gone';
    }
    return response.ok ? 'sent' : `refused ${response.status}`;
  }

  return {
    async start() {
      const kept = (await storage.get('push')).push;
      if (kept?.keys?.publicKey && kept.keys.privateKey) keys = kept.keys;
      else {
        keys = newKeys();
        await save();
      }
      for (const [device, given] of Object.entries(kept?.subs && typeof kept.subs === 'object' ? kept.subs : {}).slice(0, MOST)) {
        const subscription = subscriptionIn(given, { allowed });
        if (subscription) subs[device] = { ...subscription, at: Number(given.at) || 0 };
      }
    },
    /** What a browser subscribes with: this server's public key. */
    get publicKey() {
      return keys?.publicKey || '';
    },
    /** Whether a device takes notifications, and whether any does. */
    has: (device) => !!subs[device],
    get ready() {
      return Object.keys(subs).length > 0;
    },
    devices: () => Object.keys(subs),
    /** How the last one went, for Settings: { at, ok, problem }. */
    state: () => ({ on: Object.keys(subs).length, last: last && { ...last } }),
    /** A device's subscription, kept: false if it isn't one a push service gave. */
    async subscribe(device, given) {
      const subscription = subscriptionIn(given, { allowed });
      if (!device || !subscription) return false;
      if (!subs[device] && Object.keys(subs).length >= MOST) delete subs[Object.entries(subs).sort((a, b) => a[1].at - b[1].at)[0][0]];
      subs[device] = { ...subscription, at: now() };
      await save();
      return true;
    },
    async unsubscribe(device) {
      if (!subs[device]) return false;
      delete subs[device];
      await save();
      return true;
    },
    /**
     * A notification to devices: all that take them, or those named.
     * @param {{title?:string, text:string, tag?:string, priority?:number}} message
     * @param {{devices?:string[]|null, anyway?:boolean}} [options]  anyway: though the same words just went (a test)
     * @returns {Promise<{went:boolean, again:boolean, withheld:boolean}>}  as phone.js's send: went, it reached a push
     *   service whole; again, it reached none and trying again is safe; withheld, only that there's something was sent
     */
    async send(message, { devices = null, anyway = false } = {}) {
      const text = phoneText(message?.text);
      const off = { went: false, again: false, withheld: false };
      if (!keys || !text) return off;
      const withheld = text === WITHHELD;
      const at = now();
      for (const [key, sentAt] of lately) if (at - sentAt > SAME_MS) lately.delete(key);
      const targets = (devices || Object.keys(subs)).filter((device) => subs[device] && (anyway || !lately.has(`${device}|${text}`)));
      if (!targets.length) return off;
      for (const device of targets) lately.set(`${device}|${text}`, at);
      const payload = { title: String(message.title || 'Jester').slice(0, 80), body: text, tag: String(message.tag || '').slice(0, 60) };
      const outcomes = await Promise.all(targets.map((device) => post(device, payload, { urgent: (Number(message.priority) || 3) >= 4 })));
      const sent = outcomes.filter((outcome) => outcome === 'sent').length;
      const problem = sent ? '' : outcomes.includes('late') ? 'the push service didn’t answer' : outcomes.includes('unreached') ? 'the push service couldn’t be reached' : outcomes.includes('gone') ? 'that device stopped taking notifications' : `the push service ${outcomes[0]}`;
      last = { at, ok: sent > 0, problem };
      // Why, never what: the log is plain text.
      log(sent ? `push: sent to ${sent} device${sent === 1 ? '' : 's'}${withheld ? ' (only that there’s something: it looked like a secret)' : ''}` : `push: didn’t go: ${problem}`);
      onChange();
      return { went: sent > 0 && !withheld, again: !sent && outcomes.every((outcome) => outcome === 'unreached' || outcome.startsWith('refused')), withheld: sent > 0 && withheld };
    }
  };
}
