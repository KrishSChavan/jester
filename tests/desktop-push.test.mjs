// Notifications from his own app (the user, 2026-11-18: "get rid of the ntfy app and get notifications from the
// jester pwa"): what's sent can be read by the device it's for and nobody between, is signed as his server's, and
// goes only to a browser's push service.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPush, encrypted, newKeys, pushService, subscriptionIn, vapid } from '../desktop/src/main/push.js';

/** A device, as a browser makes one: its key pair and secret, and how it reads what's pushed (RFC 8291). */
function device() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: 'https://web.push.apple.com/abc123', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const read = (body) => {
    const salt = body.subarray(0, 16);
    const idLength = body.readUInt8(20);
    const sender = body.subarray(21, 21 + idLength);
    const sealed = body.subarray(21 + idLength);
    const shared = ecdh.computeSecret(sender);
    const keying = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]), 32));
    const key = Buffer.from(crypto.hkdfSync('sha256', keying, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', keying, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(sealed.subarray(-16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'the last record');
    return plain.subarray(0, -1).toString('utf8');
  };
  return { subscription, read };
}

test('what’s pushed is read by the device it’s for, and by no other', () => {
  const phone = device();
  const body = encrypted(phone.subscription, 'Call the dentist at three.');
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(phone.read(body), 'Call the dentist at three.');
  assert.doesNotMatch(body.toString('latin1'), /dentist/);
  assert.throws(() => device().read.call(null, body));
});

test('the RFC’s own example comes out as the RFC has it', () => {
  // RFC 8291, appendix A.
  const local = crypto.createECDH('prime256v1');
  local.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const subscription = { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = encrypted(subscription, 'When I grow up, I want to be a watermelon', { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), local });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a push is signed as his server’s, for the push service it goes to, for half a day', () => {
  const keys = newKeys();
  const header = vapid('https://web.push.apple.com/abc123', keys, 1_800_000_000_000);
  const [, token, key] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header);
  assert.equal(key, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  const said = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(said.aud, 'https://web.push.apple.com');
  assert.equal(said.exp, 1_800_000_000 + 12 * 3600);
  assert.match(said.sub, /^https:\/\//);
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('only a browser’s push service is sent to', () => {
  for (const good of ['https://web.push.apple.com/x', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-by3p.notify.windows.com/w/?token=x']) assert.equal(pushService(good), true, good);
  for (const bad of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://push.apple.com.evil.example/x', 'https://evil.example/web.push.apple.com', 'https://user@web.push.apple.com/x', 'nope']) assert.equal(pushService(bad), false, bad);
  const phone = device();
  assert.ok(subscriptionIn(phone.subscription));
  assert.equal(subscriptionIn({ ...phone.subscription, endpoint: 'https://evil.example/x' }), null);
  assert.equal(subscriptionIn({ ...phone.subscription, keys: { ...phone.subscription.keys, auth: 'short' } }), null);
});

function pusher(answer = () => new Response(null, { status: 201 })) {
  let kept = {};
  const posts = [];
  let time = 1_800_000_000_000;
  const push = createPush({
    storage: { get: async () => ({ push: kept.push }), set: async (items) => Object.assign(kept, structuredClone(items)) },
    fetchImpl: async (endpoint, options) => (posts.push({ endpoint, ...options }), answer(endpoint)),
    now: () => time
  });
  return { push, posts, kept: () => kept, later: (ms) => (time += ms) };
}

test('a line goes to every device that takes notifications, once, and is kept off a lock screen if it looks like a secret', async () => {
  const { push, posts, later } = pusher();
  await push.start();
  assert.equal(push.ready, false);
  assert.deepEqual(await push.send({ text: 'Hello' }), { went: false, again: false, withheld: false }, 'nobody to send to');
  const phone = device();
  const tablet = device();
  assert.equal(await push.subscribe('phone', phone.subscription), true);
  assert.equal(await push.subscribe('tablet', tablet.subscription), true);
  assert.equal(await push.subscribe('bad', { endpoint: 'https://evil.example/x', keys: phone.subscription.keys }), false);
  assert.deepEqual(await push.send({ title: 'Reminder', text: 'Call the dentist.', priority: 4 }), { went: true, again: false, withheld: false });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['Content-Encoding'], 'aes128gcm');
  assert.equal(posts[0].headers.Urgency, 'high');
  assert.match(posts[0].headers.Authorization, /^vapid t=/);
  assert.deepEqual(JSON.parse(phone.read(posts[0].body)), { title: 'Reminder', body: 'Call the dentist.', tag: '' });
  // The same words again, straight away (a reply that's also a reminder): one telling.
  assert.equal((await push.send({ text: 'Call the dentist.' })).went, false);
  assert.equal(posts.length, 2);
  later(3 * 60 * 1000);
  await push.send({ text: 'Call the dentist.' }, { devices: ['phone'] });
  assert.equal(posts.length, 3);
  const secret = await push.send({ text: 'my password is hunter2-Tr0ub4dor' });
  assert.equal(secret.withheld, true);
  assert.equal(secret.went, false);
  assert.doesNotMatch(phone.read(posts.at(-2).body) + tablet.read(posts.at(-1).body), /hunter2/);
});

test('a device that’s stopped taking them is let go; a service that can’t be reached is tried again', async () => {
  const gone = pusher((endpoint) => new Response(null, { status: endpoint.includes('apple') ? 410 : 201 }));
  await gone.push.start();
  await gone.push.subscribe('phone', device().subscription);
  assert.deepEqual(await gone.push.send({ text: 'Hello' }), { went: false, again: false, withheld: false });
  assert.equal(gone.push.has('phone'), false);
  const down = pusher(() => Promise.reject(new TypeError('fetch failed')));
  await down.push.start();
  await down.push.subscribe('phone', device().subscription);
  assert.deepEqual(await down.push.send({ text: 'Hello' }), { went: false, again: true, withheld: false });
  // Its key and its devices outlast a restart.
  const again = createPush({ storage: { get: async () => ({ push: down.kept().push }), set: async () => undefined } });
  await again.start();
  assert.equal(again.publicKey, down.push.publicKey);
  assert.equal(again.has('phone'), true);
});
