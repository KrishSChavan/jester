// 2026-11-15: a timer that's up rings until it's turned off (ring.js), by a word, a gesture or a click.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRing, RING_MS, ringStopAsked } from '../desktop/src/main/ring.js';
import { createTeller } from '../desktop/src/main/tell.js';
import { trayModel } from '../desktop/src/main/tray-menu.js';
import { cardView, shelfOf } from '../desktop/src/home/cards.js';
import { pressedTwice } from '../desktop/src/main/agent/actions.js';
import { replaySteps } from '../desktop/src/main/agent/replay.js';
import { learnable } from '../desktop/src/main/learned.js';

function world({ ringMs } = {}) {
  const w = { time: 0, shown: [], hidden: 0, timers: [], logs: [], changes: 0 };
  w.ring = createRing({
    page: { show: (label) => w.shown.push(label), hide: () => (w.hidden += 1) },
    ...(ringMs ? { ringMs } : {}),
    now: () => w.time,
    setTimer: (fn, ms) => (w.timers.push({ fn, at: w.time + ms }), w.timers.at(-1)),
    clearTimer: (timer) => (w.timers = w.timers.filter((item) => item !== timer)),
    log: (...parts) => w.logs.push(parts.join(' ')),
    onChange: () => (w.changes += 1)
  });
  w.pass = (ms) => {
    w.time += ms;
    for (const timer of [...w.timers]) if (timer.at <= w.time) (w.timers = w.timers.filter((item) => item !== timer)), timer.fn();
  };
  return w;
}

test('it rings from when it starts until it’s stopped, and says who stopped it', () => {
  const w = world();
  assert.equal(w.ring.ringing, null);
  assert.equal(w.ring.stop('a click'), false, 'nothing to stop');
  w.ring.start({ id: 't1', label: '1 minute timer' });
  assert.deepEqual(w.ring.ringing, { id: 't1', label: '1 minute timer', since: 0 });
  assert.deepEqual(w.shown, ['1 minute timer']);
  w.pass(4200);
  assert.equal(w.ring.stop('a click'), true);
  assert.equal(w.ring.ringing, null);
  assert.equal(w.hidden, 1);
  assert.deepEqual(w.logs, ['ring: a timer is ringing', 'ring: stopped by a click, after 4 s']);
  assert.equal(w.changes, 2, 'his window and his menu are told when it starts and when it ends');
  assert.equal(w.timers.length, 0);
  assert.equal(w.ring.stop('a gesture'), false, 'once is enough');
});

test('left alone it stops by itself after a minute; a second timer takes over from the first', () => {
  const w = world();
  w.ring.start({ id: 't1', label: 'Pasta timer' });
  w.pass(RING_MS - 1);
  assert.ok(w.ring.ringing);
  w.pass(1);
  assert.equal(w.ring.ringing, null);
  assert.match(w.logs.at(-1), /^ring: stopped by itself, unanswered, after 60 s$/);
  w.ring.start({ id: 't1', label: 'Pasta timer' });
  w.pass(40_000);
  w.ring.start({ id: 't2', label: 'Tea timer' });
  assert.equal(w.ring.ringing.id, 't2');
  w.pass(40_000);
  assert.ok(w.ring.ringing, 'the second has its own minute');
  w.pass(20_000);
  assert.equal(w.ring.ringing, null);
  assert.equal(RING_MS, 60_000);
});

test('the words that turn it off are the whole of what was said', () => {
  for (const words of ['stop', 'Stop.', 'stop it', 'stop the timer', 'okay stop', 'turn it off', 'turn off the alarm', 'shut it off', 'switch that off', 'Jester, turn the timer off please', 'quiet', 'be quiet', 'enough', 'that’s enough', 'dismiss', 'cancel', 'got it', 'I got it', 'thanks', 'thank you', 'ok', 'Okay!', 'I’m up', "i'm coming", 'never mind', 'done', 'silence the alarm', 'stop ringing', 'stop stop', 'Stop. Stop!', 'stop already', 'enough already', 'alright', 'all right, stop', 'that is enough', 'okay okay, turn it off', 'I am up'])
    assert.equal(ringStopAsked(words), true, words);
  for (const words of ['', 'stop by the store', 'turn off the lights', 'thanks for the pasta', 'okay so what happened was', 'is it done yet', 'cancel my three o’clock', 'stop the music and play jazz', 'I got it from the library'])
    assert.equal(ringStopAsked(words), false, words);
});

test('the teller says when a line was said here, and not when it went another way', async () => {
  const make = (where, more = {}) => createTeller({ where: () => where, announce: () => Promise.resolve(true), release: async () => undefined, held: () => 0, ...more });
  const job = { id: 'j', payload: { text: 'Your 1 minute timer is up.' } };
  let how = null;
  assert.equal(await make('here').say(job, { said: (told) => (how = told) }), undefined);
  assert.deepEqual(how, { late: false });
  how = null;
  await make('here').say(job, { late: 10 * 60_000, meant: Date.now() - 10 * 60_000, said: (told) => (how = told) });
  assert.deepEqual(how, { late: true }, 'told late, on coming back: it rang its hour out already');
  // Away, it goes to their phone or is held: not said here.
  how = null;
  await make('away', { phone: async () => true }).say(job, { said: (told) => (how = told) });
  await make('away').say(job, { said: (told) => (how = told) });
  // Across a film, with a phone to take it: shown, not said.
  await make('here', { watching: () => true, phone: async () => true }).say(job, { said: (told) => (how = told) });
  // Now isn't the moment (someone's mid-sentence): tried again, and not counted as said.
  await make('here', { announce: () => null }).say(job, { said: (told) => (how = told) });
  assert.equal(how, null);
});

test('a ringing timer’s card says so and has a Stop; it comes first on the shelf', () => {
  const state = { timers: [{ id: 't2', text: 'Tea timer', due: 5000, timer: 5000 }], open: [], done: [], ringing: { id: 't1', label: 'Pasta timer', since: 0 } };
  assert.deepEqual(cardView({ kind: 'task', id: 't1', type: 'timer', text: 'Pasta timer' }, state), { label: 'Timer', title: 'Pasta timer', detail: 'Ringing', icon: 'i-timer', tick: null, tone: 'due', actions: ['quiet'] });
  assert.deepEqual(shelfOf(state, 0).cards.map((card) => [card.id, card.type, card.text]), [['t1', 'timer', 'Pasta timer'], ['t2', 'timer', 'Tea timer']]);
  // Stopped, it's a timer that finished.
  assert.equal(cardView({ kind: 'task', id: 't1', type: 'timer', text: 'Pasta timer' }, { ...state, ringing: null }).detail, 'Finished');
  assert.equal(shelfOf({ ...state, ringing: null }, 0).cards.length, 1);
});

test('his menu’s first item turns a ringing timer off', () => {
  const settings = { enabled: true, voiceEnabled: true };
  const ringing = trayModel({ engine: { state: 'running' }, settings, voice: 'ready', ringing: { label: 'Pasta timer' }, platform: 'darwin' });
  assert.deepEqual(ringing.items.slice(0, 2), [{ id: 'ring', label: 'Stop the ringing — Pasta timer' }, { type: 'separator' }]);
  const quiet = trayModel({ engine: { state: 'running' }, settings, voice: 'ready', platform: 'darwin' });
  assert.ok(!quiet.items.some((item) => item.id === 'ring'));
});

test('Play pressed twice running isn’t learned, and one learned that way presses it once', async () => {
  const play = { action: { action: 'click' }, app: 'Spotify', target: { role: 'button', label: 'Play' } };
  assert.equal(pressedTwice(play, play), true);
  assert.equal(pressedTwice(play, { ...play, target: { role: 'button', label: 'Play sakpase' } }), false, 'another Play is another control');
  assert.equal(pressedTwice(play, { ...play, app: 'Music' }), false);
  assert.equal(pressedTwice({ ...play, target: { role: 'button', label: 'Next' } }, { ...play, target: { role: 'button', label: 'Next' } }), false, 'only what undoes itself');
  assert.deepEqual(learnable('play Gunna’s newest song on Spotify', [play, play]), { ok: false, why: 'it pressed Play twice, which pauses it' });
  assert.equal(learnable('play Gunna’s newest song on Spotify', [play]).ok, true);
  // Kept from before this was caught (2026-11-15): done again, the second press is left out.
  const screen = { app: { name: 'Spotify', pid: 7 }, window: { title: 'Spotify' }, elements: [{ id: 3, role: 'button', label: 'Play', frame: { x: 0, y: 0, w: 20, h: 20 } }] };
  const done = [];
  const host = { observe: async () => ({ ok: true, snapshot: screen }), execute: async (action) => (done.push(action), { ok: true, changed: true, snapshot: screen }) };
  assert.deepEqual(await replaySteps({ steps: [play, play], goal: 'play Gunna’s newest song on Spotify', host, platform: 'darwin' }), { ok: true });
  assert.equal(done.length, 1);
});
