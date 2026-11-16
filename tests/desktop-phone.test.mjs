// Step 10 (2026-11-15): their phone, for what's told while they're away (phone.js, through ntfy), and when a line
// goes there, is said, or is only shown (tell.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { abilitiesPart } from '../desktop/src/main/abilities.js';
import { createPhone, DEFAULT_SERVER, newTopic, phoneText, serverUrl, WITHHELD } from '../desktop/src/main/phone.js';
import { AWAY_MS, createPresence, HERE_MS } from '../desktop/src/main/presence.js';
import { BUSY_MS, createTeller, PHONE_RETRY_MS, PHONE_TRIES } from '../desktop/src/main/tell.js';
import { readFileSync } from 'node:fs';

const MIN = 60_000;

/** A phone over a store and a server that are the test's. */
function phoned({ stored, answer = () => ({ ok: true, status: 200 }) } = {}) {
  const w = { kept: stored ? { phone: stored } : {}, sent: [], logs: [], changes: 0 };
  w.phone = createPhone({
    storage: { get: async (key) => ({ [key]: w.kept[key] }), set: async (items) => Object.assign(w.kept, items) },
    fetchImpl: async (url, options) => {
      w.sent.push({ url, ...options, body: JSON.parse(options.body) });
      return answer(url, options);
    },
    now: () => 1000,
    log: (...parts) => w.logs.push(parts.join(' ')),
    onChange: () => (w.changes += 1)
  });
  return w;
}

test('newTopic: a name nobody could guess, in fours for typing', () => {
  const topic = newTopic();
  assert.match(topic, /^jester-(?:[abcdefghjkmnpqrstuvwxyz]{4}-){3}[abcdefghjkmnpqrstuvwxyz]{4}$/);
  assert.notEqual(newTopic(), topic);
  assert.ok(topic.length <= 64 && /^[-_A-Za-z0-9]+$/.test(topic), 'a name ntfy takes');
  // No letter favoured: a byte that would be is thrown away, not folded in.
  assert.equal(newTopic(() => new Uint8Array(32).fill(255).fill(0, 16)), 'jester-aaaa-aaaa-aaaa-aaaa');
  // Kept sealed, and away from pages, with the other keys (chrome-bridge.js needs Electron, so it's read, not run).
  assert.match(readFileSync(new URL('../desktop/src/main/chrome-bridge.js', import.meta.url), 'utf8'), /export const PRIVATE_KEYS = Object\.freeze\(\[[^\]]*'phone'[^\]]*\]\)/);
});

test('serverUrl: ntfy.sh unless another, and only over https', () => {
  assert.equal(serverUrl(''), DEFAULT_SERVER);
  assert.equal(serverUrl('ntfy.example.org'), 'https://ntfy.example.org');
  assert.equal(serverUrl('https://ntfy.example.org/some/path'), 'https://ntfy.example.org');
  assert.throws(() => serverUrl('http://ntfy.example.org'), /has to start with https/);
  assert.throws(() => serverUrl('not a server'), /isn’t a server’s address/);
});

test('phoneText: what’s sent of a line', () => {
  assert.equal(phoneText('  Reminder:   call your mom.\n'), 'Reminder: call your mom.');
  assert.equal(phoneText('Reminder: my card is 4111 1111 1111 1111'), 'There’s something for you on your computer.');
  assert.equal(phoneText('Reminder: the wifi password is hunter2'), 'There’s something for you on your computer.');
  const long = phoneText('é'.repeat(5000));
  assert.ok(new TextEncoder().encode(long).length <= 3510 && long.endsWith('…') && !long.includes('�'));
});

test('nothing is sent until there’s a topic and it’s turned on', async () => {
  const w = phoned();
  await w.phone.start();
  assert.deepEqual(w.phone.state(), { on: false, topic: '', server: DEFAULT_SERVER, usual: true, last: null });
  assert.deepEqual(await w.phone.send({ text: 'Reminder: stretch.' }), { went: false, again: false, withheld: false });
  await w.phone.setOn(true);
  assert.equal(w.phone.ready, false, 'on means nothing with no topic');
  const { topic } = await w.phone.setUp();
  assert.match(topic, /^jester-/);
  assert.equal((await w.phone.setUp()).topic, topic, 'set up twice, it’s the same topic');
  assert.equal((await w.phone.send({ text: 'Reminder: stretch.' })).went, false, 'made, and still off');
  assert.equal(w.sent.length, 0);
  // Settings' test goes though it's off.
  assert.equal((await w.phone.send({ title: 'Jester', text: 'A test.' }, { anyway: true })).went, true);
  await w.phone.setOn(true);
  assert.deepEqual(await w.phone.send({ title: 'Reminder', text: 'Call your mom.', priority: 4 }), { went: true, again: false, withheld: false });
  assert.deepEqual(w.sent[1], { url: DEFAULT_SERVER, method: 'POST', headers: { 'content-type': 'application/json' }, body: { topic, title: 'Reminder', message: 'Call your mom.', priority: 4 }, redirect: 'error', signal: w.sent[1].signal });
  assert.deepEqual(w.kept.phone, { on: true, topic, server: DEFAULT_SERVER });
  assert.deepEqual(w.phone.state().last, { at: 1000, ok: true, problem: '' });
  // A new topic, for one that got out: off until the phone's subscribed again.
  const renewed = await w.phone.renew();
  assert.ok(renewed.topic !== topic && renewed.on === false);
  // And it comes back as it was kept.
  const again = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd', server: 'https://ntfy.example.org' } });
  await again.phone.start();
  assert.deepEqual([again.phone.ready, again.phone.state().usual], [true, false]);
  const bad = phoned({ stored: { on: true, topic: 'not a topic!', server: '' } });
  await bad.phone.start();
  assert.equal(bad.phone.ready, false);
});

test('a send that fails says why, never what, and counts as not gone', async () => {
  const limited = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' }, answer: () => ({ ok: false, status: 429 }) });
  await limited.phone.start();
  assert.deepEqual(await limited.phone.send({ text: 'Reminder: call your mom.' }), { went: false, again: true, withheld: false }, 'refused: nothing got there, so again is safe');
  assert.deepEqual(limited.logs, ['phone: a line didn’t go: the server says that’s too many for now']);
  assert.equal(limited.phone.state().last.problem, 'the server says that’s too many for now');
  const down = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' }, answer: () => Promise.reject(new TypeError('fetch failed')) });
  await down.phone.start();
  assert.deepEqual(await down.phone.send({ text: 'Reminder: call your mom.' }), { went: false, again: true, withheld: false });
  assert.deepEqual(down.logs, ['phone: a line didn’t go: the server couldn’t be reached']);
  assert.ok(![...limited.logs, ...down.logs].some((line) => /mom|jester-aaaa/.test(line)));
});

/** A teller with the test's presence, voice, phone and screen. */
function telling({ where = 'here', phone = true, watching = false } = {}) {
  const w = { where, watching, phoneOk: phone, said: [], phoned: [], shown: [], logs: [] };
  w.teller = createTeller({
    where: () => w.where,
    announce: (text) => (w.said.push(text), Promise.resolve(true)),
    release: async () => undefined,
    held: () => 0,
    phone: async (message) => (w.phoneOk ? (w.phoned.push(message), true) : false),
    watching: () => w.watching,
    show: (text, title, card) => w.shown.push({ text, title, card }),
    now: () => new Date(2026, 10, 16, 16).getTime(),
    log: (...parts) => w.logs.push(parts.join(' '))
  });
  w.job = (more = {}) => ({ payload: { text: 'Reminder: call your mom.', title: 'Reminder', priority: 4, ...more } });
  return w;
}

test('telling: away, a line goes to their phone, and that’s it told', async () => {
  const w = telling({ where: 'away' });
  assert.equal(await w.teller.say(w.job()), undefined);
  assert.deepEqual(w.phoned, [{ title: 'Reminder', text: 'Reminder: call your mom.', priority: 4 }]);
  assert.deepEqual([w.said, w.shown], [[], []]);
  assert.deepEqual(w.logs, ['telling: a line, to their phone']);
  // No phone, or the send failing: kept until they're back, as before there was one.
  const none = telling({ where: 'away', phone: false });
  assert.deepEqual(await none.teller.say(none.job()), { hold: true });
  assert.deepEqual(none.logs, ['telling: they’re away, so a line is held until they’re back']);
  // One that isn't for a phone (the morning's brief) is held even with one.
  const morning = telling({ where: 'away' });
  assert.deepEqual(await morning.teller.say(morning.job({ phone: false })), { hold: true });
  assert.deepEqual(morning.phoned, []);
});

test('telling: here it’s said and the phone left alone; near, both', async () => {
  const here = telling();
  await here.teller.say(here.job());
  assert.deepEqual([here.said, here.phoned], [['Reminder: call your mom.'], []]);
  const near = telling({ where: 'near' });
  await near.teller.say(near.job());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([near.said.length, near.phoned.length], [1, 1], 'quiet a few minutes, they may have stepped out');
});

test('telling: with a film or a call on, it’s shown and sent, never said across it', async () => {
  const w = telling({ where: 'near', watching: true });
  assert.equal(await w.teller.say(w.job({ card: { kind: 'task', id: 'x' } })), undefined);
  assert.deepEqual(w.said, []);
  assert.deepEqual(w.shown, [{ text: 'Reminder: call your mom.', title: 'Reminder', card: { kind: 'task', id: 'x' } }]);
  assert.equal(w.phoned.length, 1);
  assert.deepEqual(w.logs, ['telling: a line, shown and not said: something’s playing']);
  assert.equal(BUSY_MS > 0, true);
});

test('presence: watching is near only because something’s playing', async () => {
  const world = { time: new Date(2026, 10, 16, 20).getTime(), idle: 0, kept: true };
  const presence = createPresence({ idleSeconds: () => world.idle, keptAwake: async () => world.kept, now: () => world.time });
  const pass = async (ms, idle) => {
    world.time += ms;
    world.idle = idle ?? world.idle + ms / 1000;
    return presence.tick();
  };
  await presence.tick();
  assert.equal(presence.watching, false);
  await pass(HERE_MS + 1000);
  assert.deepEqual([presence.where, presence.watching], ['near', false], 'quiet a few minutes is just quiet');
  await pass(AWAY_MS);
  assert.deepEqual([presence.where, presence.watching], ['near', true], 'ten minutes untouched with the screen kept awake: a film');
  await pass(MIN, 0);
  assert.deepEqual([presence.where, presence.watching], ['here', false], 'a touch, and they’re just here');
  await pass(AWAY_MS + MIN);
  assert.equal(presence.watching, true);
  world.kept = false;
  await pass(2 * MIN);
  assert.deepEqual([presence.where, presence.watching], ['away', false]);
});

test('what he can do says whether their phone is set up', () => {
  assert.match(abilitiesPart({ phone: true }), /- Reach them on their phone when they’re away from the computer/);
  assert.match(abilitiesPart({}), /- Their phone \(Settings › Assistant and voice › Your phone\)/);
});

// What a review of the above found (2026-11-15), each one a way it went wrong.

test('review: a line that looks like a secret is noted on the phone and still to tell, not lost', async () => {
  const w = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' } });
  await w.phone.start();
  assert.deepEqual(await w.phone.send({ title: 'Reminder', text: 'Reminder: call 555-12-3456 about the order.' }), { went: false, again: false, withheld: true });
  assert.equal(w.sent[0].body.message, WITHHELD);
  assert.deepEqual(w.logs, ['phone: a line looked like a secret, so only that there’s something was sent']);
  // So away, it's held, and said when they're back.
  const t = telling({ where: 'away' });
  t.teller = createTeller({ where: () => 'away', announce: () => Promise.resolve(true), release: async () => undefined, held: () => 0, phone: (message) => w.phone.send(message) });
  assert.deepEqual(await t.teller.say({ id: 'j', payload: { text: 'Reminder: call 555-12-3456 about the order.' } }), { hold: true });
});

test('review: a send that can’t have arrived is tried again a few times, then held; one that may have isn’t', async () => {
  const outcomes = [{ went: false, again: true }, { went: false, again: true }, { went: true, again: false }];
  const logs = [];
  const make = (phone) => createTeller({ where: () => 'away', announce: () => Promise.resolve(true), release: async () => undefined, held: () => 0, phone, log: (...parts) => logs.push(parts.join(' ')) });
  const teller = make(async () => outcomes.shift());
  const job = { id: 'task-1', payload: { text: 'Reminder: stretch.' } };
  assert.deepEqual(await teller.say(job), { retryIn: PHONE_RETRY_MS });
  assert.deepEqual(await teller.say(job), { retryIn: PHONE_RETRY_MS });
  assert.equal(await teller.say(job), undefined, 'the network came back');
  const never = make(async () => ({ went: false, again: true }));
  const got = [];
  for (let i = 0; i < PHONE_TRIES; i++) got.push(await never.say(job));
  assert.deepEqual(got.at(-1), { hold: true }, 'not for ever');
  assert.equal(got.filter((answer) => answer?.retryIn).length, PHONE_TRIES - 1);
  // No answer in time may have been delivered: held at once, and said when they're back.
  assert.deepEqual(await make(async () => ({ went: false, again: false })).say(job), { hold: true });
  const slow = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' }, answer: () => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })) });
  await slow.phone.start();
  assert.deepEqual(await slow.phone.send({ text: 'Reminder: stretch.' }), { went: false, again: false, withheld: false });
});

test('review: with a film on and no phone to take it, a line is said; shown, it keeps whose words it holds', async () => {
  const none = telling({ where: 'near', watching: true, phone: false });
  assert.equal(await none.teller.say(none.job()), undefined);
  assert.deepEqual([none.said, none.shown], [['Reminder: call your mom.'], []], 'a timer missed is worse than a film interrupted');
  const shown = [];
  const teller = createTeller({ where: () => 'near', announce: () => Promise.resolve(true), release: async () => undefined, held: () => 0, phone: async () => true, watching: () => true, show: (...args) => shown.push(args) });
  await teller.say({ payload: { text: 'Standup starts in 15 minutes.', title: 'Coming up', untrusted: true } });
  assert.deepEqual(shown, [['Standup starts in 15 minutes.', 'Coming up', null, { untrusted: true }]]);
});

test('review: near, it goes to the phone only if they’re still quiet once it’s said', async () => {
  let where = 'near';
  const phonedTo = [];
  const teller = createTeller({ where: () => where, announce: () => ((where = 'here'), Promise.resolve(true)), release: async () => undefined, held: () => 0, phone: async (message) => (phonedTo.push(message), true) });
  await teller.say({ payload: { text: 'Reminder: stretch.' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(phonedTo, [], 'they touched a key while he spoke: they heard it');
});

test('review: what was kept is used only if it’s what he’d have kept, and the server isn’t followed elsewhere', async () => {
  const odd = phoned({ stored: { on: true, topic: 'not a topic!', server: 'http://plain.example' } });
  await odd.phone.start();
  assert.deepEqual(odd.phone.state(), { on: false, topic: '', server: DEFAULT_SERVER, usual: true, last: null }, 'no topic, so not on; and never a server in the clear');
  await odd.phone.setUp();
  assert.equal(odd.phone.ready, false, 'a topic made is off until they turn it on');
  // An error nobody's seen before is said in his words, not its own, which might hold anything.
  const strange = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' }, answer: () => Promise.reject(new Error('could not POST to topic jester-aaaa-bbbb-cccc-dddd')) });
  await strange.phone.start();
  await strange.phone.send({ text: 'Reminder: stretch.' });
  assert.deepEqual(strange.logs, ['phone: a line didn’t go: it couldn’t be sent']);
  assert.equal(strange.phone.state().last.problem, 'it couldn’t be sent');
  const nothing = phoned({ stored: { on: true, topic: 'jester-aaaa-bbbb-cccc-dddd' }, answer: () => null });
  await nothing.phone.start();
  assert.deepEqual(await nothing.phone.send({ text: 'Reminder: stretch.' }), { went: false, again: true, withheld: false });
  assert.deepEqual(nothing.logs, ['phone: a line didn’t go: the server answered nothing it should']);
});
