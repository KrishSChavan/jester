// Step 7 (2026-11-15): his clock (clock.js), whether the user's at the computer (presence.js), and telling them
// something when its time comes: said if they're there, held until they're back if they aren't (tell.js).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClock, dueAt, meantAt, nextDaily, RETRY_MS } from '../desktop/src/main/clock.js';
import { createConversation } from '../desktop/src/main/conversation.js';
import { AWAY_MS, createPresence, dayOf, HELD_MS, HERE_MS, lasting, macScreenKeptAwake, PRESENCE_WORDS } from '../desktop/src/main/presence.js';
import { createSituation } from '../desktop/src/main/situation.js';
import { BUSY_MS, createTeller, lateLine, LATE_MS } from '../desktop/src/main/tell.js';

const at = (h, m = 0, day = 15) => new Date(2026, 10, day, h, m).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const scratch = (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'jester-clock-'));
  made.push(dir);
  return join(dir, name);
};

/** A clock whose time and timers are the test's: `pass(ms)` moves time on and fires what's due on the way. */
function timed({ file = scratch('jobs.json'), start = at(9), tickMs } = {}) {
  let time = start;
  let timers = [];
  let serial = 0;
  const logs = [];
  const make = () =>
    createClock({
      file,
      now: () => time,
      setTimer: (fn, ms) => {
        const timer = { id: ++serial, at: time + ms, fn };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => (timers = timers.filter((item) => item !== timer)),
      log: (...parts) => logs.push(parts.join(' ')),
      ...(tickMs ? { tickMs } : {})
    });
  const clock = make();
  return {
    clock,
    file,
    logs,
    make,
    get time() {
      return time;
    },
    /** Time passes with no timer firing: the computer was asleep. */
    sleep: (ms) => (time += ms),
    async pass(ms) {
      const end = time + ms;
      // Whatever was just added or started has set its timer by now.
      await clock.tick();
      for (;;) {
        const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        time = Math.max(time, next.at);
        await next.fn();
        await clock.tick();
      }
      time = end;
    }
  };
}

test('nextDaily: the next time by the wall clock, on the days given', () => {
  assert.equal(nextDaily('07:30', at(6)), at(7, 30));
  assert.equal(nextDaily('07:30', at(7, 30)), at(7, 30, 16), 'the moment itself is past');
  assert.equal(nextDaily('07:30', at(9)), at(7, 30, 16));
  // 2026-11-15 is a Sunday: weekdays only starts Monday.
  assert.equal(nextDaily('07:30', at(6), [1, 2, 3, 4, 5]), at(7, 30, 16));
  assert.equal(nextDaily('7:05', at(6)), at(7, 5));
  assert.ok(Number.isNaN(nextDaily('25:00', at(6))));
  assert.ok(Number.isNaN(nextDaily('', at(6))));
});

test('dueAt and meantAt: a repeating job missed for days is meant for the latest of them', () => {
  const daily = { daily: '07:00', made: at(6, 0, 10) };
  assert.equal(dueAt(daily), at(7, 0, 10));
  assert.equal(meantAt(daily, at(9, 0, 15)), at(7, 0, 15), 'this morning’s, not the first one missed');
  assert.equal(meantAt(daily, at(6, 0, 15)), at(7, 0, 14), 'before today’s, it’s yesterday’s');
  assert.equal(meantAt({ ...daily, last: at(7, 0, 15) }, at(9, 0, 15)), at(7, 0, 16), 'done today, the next is tomorrow’s');
  assert.equal(meantAt({ everyMs: 10 * MIN, made: at(9) }, at(9, 35)), at(9, 30));
  assert.equal(meantAt({ at: at(8) }, at(9)), at(8));
  assert.equal(dueAt({ at: at(8), retryAt: at(9, 1) }), at(9, 1));
});

test('a job runs when it’s due, once, and is gone', async () => {
  const t = timed();
  const ran = [];
  t.clock.on('say', (job, info) => void ran.push({ id: job.id, text: job.payload.text, late: info.late }));
  t.clock.start();
  const job = t.clock.add({ kind: 'say', inMs: 10 * MIN, payload: { text: 'tea' } });
  assert.equal(job.at, at(9, 10));
  await t.pass(9 * MIN);
  assert.equal(ran.length, 0);
  await t.pass(2 * MIN);
  assert.deepEqual(ran, [{ id: job.id, text: 'tea', late: 0 }]);
  assert.equal(t.clock.list().length, 0);
  assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')).jobs, []);
  await t.pass(HOUR);
  assert.equal(ran.length, 1);
});

test('what came due while the computer slept is done on waking, and told how late', async () => {
  const t = timed();
  const ran = [];
  t.clock.on('say', (job, info) => void ran.push(info.late));
  t.clock.start();
  t.clock.add({ kind: 'say', at: at(9, 30), payload: { text: 'x' } });
  t.sleep(2 * HOUR);
  await t.clock.wake();
  assert.deepEqual(ran, [90 * MIN]);
});

test('jobs are kept on disk: one due while he wasn’t running is done when he starts', async () => {
  const file = scratch('jobs.json');
  const first = timed({ file });
  first.clock.add({ kind: 'say', at: at(9, 30), payload: { text: 'kept' } });
  first.clock.add({ id: 'brief', kind: 'say', daily: '07:00', payload: { text: 'morning' } });
  const later = timed({ file, start: at(11) });
  const ran = [];
  later.clock.on('say', (job, info) => void ran.push([job.payload.text, info.late]));
  later.clock.start();
  await later.clock.tick();
  assert.deepEqual(ran, [['kept', 90 * MIN]]);
  assert.deepEqual(later.clock.list().map((job) => [job.id, job.due]), [['brief', at(7, 0, 16)]]);
});

test('a daily job runs each day, and one missed for days runs once', async () => {
  const t = timed({ start: at(6) });
  const ran = [];
  t.clock.on('brief', (job, info) => void ran.push([t.time, info.late]));
  t.clock.start();
  t.clock.add({ id: 'brief', kind: 'brief', daily: '07:00' });
  await t.pass(25 * HOUR + MIN);
  assert.deepEqual(ran, [[at(7), 0], [at(7, 0, 16), 0]]);
  t.sleep(3 * 24 * HOUR + 2 * HOUR);
  await t.clock.wake();
  assert.equal(ran.length, 3, 'once, not once for each day missed');
  assert.equal(ran[2][1], 2 * HOUR + MIN, 'late by this morning’s, not the first one missed');
  assert.equal(t.clock.list()[0].due, at(7, 0, 20));
});

test('too late to be worth it, a job is skipped: the handler isn’t asked', async () => {
  const t = timed({ start: at(6) });
  const ran = [];
  t.clock.on('brief', () => void ran.push(t.time));
  t.clock.start();
  t.clock.add({ id: 'brief', kind: 'brief', daily: '07:00', keepFor: 6 * HOUR });
  t.clock.add({ kind: 'brief', at: at(8), keepFor: HOUR });
  t.sleep(9 * HOUR);
  await t.clock.wake();
  assert.deepEqual(ran, []);
  assert.equal(t.logs.filter((line) => /too late to be worth it: skipped/.test(line)).length, 2);
  assert.deepEqual(t.clock.list().map((job) => job.id), ['brief'], 'the daily one is still on for tomorrow');
  await t.pass(16 * HOUR + MIN);
  assert.deepEqual(ran, [at(7, 0, 16)]);
});

test('a handler that throws is tried again after a minute, five, fifteen, then given up on', async () => {
  const t = timed();
  const tried = [];
  t.clock.on('say', () => {
    tried.push(t.time);
    throw new Error('no voice');
  });
  t.clock.start();
  t.clock.add({ kind: 'say', inMs: MIN });
  await t.pass(2 * HOUR);
  assert.deepEqual(tried.map((time) => time - at(9, 1)), [0, RETRY_MS[0], RETRY_MS[0] + RETRY_MS[1], RETRY_MS[0] + RETRY_MS[1] + RETRY_MS[2]]);
  assert.equal(t.clock.list().length, 0);
  assert.ok(t.logs.some((line) => /failed 4 times \(no voice\): given up on/.test(line)));
});

test('held, a job waits for release, however long, and across a restart', async () => {
  const file = scratch('jobs.json');
  const t = timed({ file });
  let away = true;
  const ran = [];
  const handler = (job, info) => (away ? { hold: true } : void ran.push([info.late, info.held]));
  t.clock.on('say', handler);
  t.clock.start();
  t.clock.add({ kind: 'say', inMs: MIN, payload: { text: 'held' } });
  await t.pass(3 * HOUR);
  assert.equal(t.clock.held, 1);
  assert.deepEqual(ran, []);
  // He's restarted: it's still held.
  const again = timed({ file, start: at(12, 30) });
  again.clock.on('say', handler);
  again.clock.start();
  await again.pass(HOUR);
  assert.equal(again.clock.held, 1);
  assert.ok(again.logs.some((line) => /clock: 1 job, 1 held/.test(line)));
  away = false;
  await again.clock.release();
  assert.deepEqual(ran, [[at(13, 30) - at(9, 1), true]]);
  assert.equal(again.clock.held, 0);
  assert.equal(again.clock.list().length, 0);
});

test('asked to wait a moment, a job is tried again then, with no count against it', async () => {
  const t = timed();
  let busy = 3;
  const tried = [];
  t.clock.on('say', () => (tried.push(t.time), busy-- > 0 ? { retryIn: 5000 } : undefined));
  t.clock.start();
  t.clock.add({ kind: 'say', inMs: MIN });
  await t.pass(10 * MIN);
  assert.deepEqual(tried.map((time) => time - at(9, 1)), [0, 5000, 10000, 15000]);
});

test('a job with the id of one there takes its place; removed, it never runs', async () => {
  const t = timed();
  const ran = [];
  t.clock.on('say', (job) => void ran.push(job.payload.text));
  t.clock.start();
  t.clock.add({ id: 'a', kind: 'say', inMs: MIN, payload: { text: 'first' } });
  t.clock.add({ id: 'a', kind: 'say', inMs: 2 * MIN, payload: { text: 'second' } });
  t.clock.add({ id: 'b', kind: 'say', inMs: MIN, payload: { text: 'gone' } });
  assert.equal(t.clock.remove('b'), true);
  assert.equal(t.clock.remove('b'), false);
  await t.pass(5 * MIN);
  assert.deepEqual(ran, ['second']);
});

test('a kind nothing does yet is kept, not run and not lost', async () => {
  const t = timed();
  t.clock.add({ kind: 'from-a-newer-jester', inMs: MIN });
  t.clock.start();
  await t.pass(HOUR);
  assert.equal(t.clock.list().length, 1);
  assert.ok(t.logs.some((line) => /nothing here does “from-a-newer-jester” jobs: kept, not run/.test(line)));
  const ran = [];
  t.clock.on('from-a-newer-jester', (job, info) => void ran.push(info.late));
  await t.clock.tick();
  assert.equal(ran.length, 1);
});

test('a job with no kind or no time isn’t kept, and a file that isn’t his is set aside', () => {
  const t = timed();
  assert.equal(t.clock.add({ kind: 'say' }), null);
  assert.equal(t.clock.add({ inMs: 1000 }), null);
  assert.equal(t.clock.add({ kind: 'say', daily: '7 o’clock' }), null);
  assert.equal(t.clock.list().length, 0);
  const file = scratch('jobs.json');
  writeFileSync(file, '{ not json');
  const broken = timed({ file });
  assert.equal(broken.clock.list().length, 0);
  assert.ok(existsSync(`${file}.unreadable`));
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: 'ok', kind: 'say', made: 1, at: 2 }, { id: 'no-kind', made: 1, at: 2 }, 'nonsense', { id: 'no-time', kind: 'say', made: 1 }] }));
  assert.deepEqual(timed({ file }).clock.list().map((job) => job.id), ['ok']);
});

test('jobs run one at a time, the earliest first', async () => {
  const t = timed();
  const order = [];
  let inside = 0;
  t.clock.on('say', async (job) => {
    inside += 1;
    assert.equal(inside, 1);
    await new Promise((resolve) => setImmediate(resolve));
    order.push(job.payload.text);
    inside -= 1;
  });
  t.clock.add({ kind: 'say', at: at(9, 3), payload: { text: 'third' } });
  t.clock.add({ kind: 'say', at: at(9, 1), payload: { text: 'first' } });
  t.clock.add({ kind: 'say', at: at(9, 2), payload: { text: 'second' } });
  t.sleep(HOUR);
  t.clock.start();
  await Promise.all([t.clock.tick(), t.clock.tick()]);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

/** Presence with the test's time, idle count and screen. */
function watched({ file = '', start = at(9), idle = 9999, kept = null } = {}) {
  const world = { time: start, idle, kept, arrivals: [], leaves: [], changes: [], logs: [], asked: 0 };
  const make = () =>
    createPresence({
      idleSeconds: () => world.idle,
      keptAwake: async () => ((world.asked += 1), world.kept),
      file,
      now: () => world.time,
      log: (...parts) => world.logs.push(parts.join(' ')),
      onArrive: (arrival) => world.arrivals.push(arrival),
      onLeave: (left) => world.leaves.push(left),
      onChange: (where) => world.changes.push(where)
    });
  world.presence = make();
  world.make = make;
  /** Time passes; `touched`: the user was at the keys until `touched` ms before the end of it. */
  world.pass = async (ms, { touched = null } = {}) => {
    world.time += ms;
    world.idle = touched === null ? world.idle + ms / 1000 : touched / 1000;
    return world.presence.tick();
  };
  return world;
}

test('dayOf: a day begins at four in the morning', () => {
  assert.equal(dayOf(at(3, 59)), '2026-11-14');
  assert.equal(dayOf(at(4)), '2026-11-15');
  assert.equal(dayOf(at(23, 59)), '2026-11-15');
});

test('lasting: how long, in words', () => {
  assert.equal(lasting(20_000), 'under a minute');
  assert.equal(lasting(MIN), '1 minute');
  assert.equal(lasting(40 * MIN), '40 minutes');
  assert.equal(lasting(HOUR), '1 hour');
  assert.equal(lasting(2 * HOUR + 10 * MIN), '2 hours 10 minutes');
});

test('a key or the mouse says they’re here: the day’s first sit-down, once', async () => {
  const w = watched();
  assert.equal(await w.presence.tick(), 'away', 'nothing’s been touched in hours');
  assert.equal(w.arrivals.length, 0);
  await w.pass(MIN, { touched: 3000 });
  assert.equal(w.presence.where, 'here');
  assert.deepEqual(w.arrivals, [{ at: w.time - 3000, by: 'keys or mouse', first: true, awayMs: null }]);
  await w.pass(MIN, { touched: 1000 });
  assert.equal(w.arrivals.length, 1, 'still here is no new arrival');
  assert.ok(w.logs.some((line) => /presence: here \(keys or mouse\), the day’s first sit-down$/.test(line)));
});

test('quiet for two minutes they’re near, for ten away; the sitting ended when they were last seen', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  const sat = w.time;
  await w.pass(HERE_MS - 1000);
  assert.equal(w.presence.where, 'here');
  await w.pass(2000);
  assert.equal(w.presence.where, 'near');
  await w.pass(AWAY_MS - HERE_MS);
  assert.equal(w.presence.where, 'away');
  assert.deepEqual(w.leaves, [{ at: sat, why: 'quiet for 10 minutes' }]);
  assert.deepEqual(w.changes, ['here', 'near', 'away']);
  // Back: not the day's first, and it says how long they were gone, from when they were last seen.
  await w.pass(30 * MIN, { touched: 0 });
  assert.equal(w.arrivals.length, 2);
  assert.deepEqual(w.arrivals[1], { at: w.time, by: 'keys or mouse', first: false, awayMs: w.time - sat });
  assert.equal(w.presence.state().lastAway.from, sat);
});

test('with something keeping the screen awake, quiet is someone watching, for three hours', async () => {
  const w = watched({ idle: 0, kept: true });
  await w.presence.tick();
  await w.pass(45 * MIN);
  assert.equal(w.presence.where, 'near');
  assert.equal(w.asked, 1);
  await w.pass(20_000);
  assert.equal(w.asked, 1, 'asked no oftener than once a minute');
  await w.pass(HELD_MS);
  assert.equal(w.presence.where, 'away');
  // The film ends: ten quiet minutes is away again.
  const v = watched({ idle: 0, kept: true });
  await v.presence.tick();
  await v.pass(30 * MIN);
  v.kept = false;
  await v.pass(2 * MIN);
  assert.equal(v.presence.where, 'away');
});

test('a locked screen or a sleeping computer is away at once, and unlocking is them, back', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  await w.pass(5 * MIN, { touched: 2000 });
  const lockedAt = w.time;
  w.presence.screen('locked', true);
  assert.equal(w.presence.where, 'away');
  assert.equal(w.leaves[0].why, 'locked');
  assert.equal(w.leaves[0].at, lockedAt - 2000, 'what they did up to the lock counts');
  // Typing a password behind the lock isn't being here yet.
  await w.pass(20 * MIN, { touched: 0 });
  assert.equal(w.presence.where, 'away');
  w.presence.seen('voice');
  assert.equal(w.presence.where, 'away');
  w.presence.screen('locked', false);
  assert.equal(w.presence.where, 'here');
  assert.equal(w.arrivals.at(-1).by, 'unlocked');
  assert.equal(w.arrivals.at(-1).awayMs, 20 * MIN + 2000);
  // Asleep, then awake with no lock: waking isn't them, the first key is.
  w.presence.screen('suspended', true);
  w.time += HOUR;
  w.idle = 3600;
  w.presence.screen('suspended', false);
  assert.equal(w.presence.where, 'away');
  await w.pass(MIN, { touched: 500 });
  assert.equal(w.presence.where, 'here');
});

test('a key pressed long before isn’t them coming back', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  w.presence.screen('suspended', true);
  w.time += 8 * HOUR;
  // The count carries on from before the lid closed, or says a few minutes: neither is now.
  w.idle = 5 * 60;
  w.presence.screen('suspended', false);
  assert.equal(await w.presence.tick(), 'away');
  assert.equal(w.arrivals.length, 1);
});

test('his own typing and clicking isn’t the user’s', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  const done = w.presence.own();
  // A task at work for eleven minutes, typing all the while, with the user gone.
  for (let i = 0; i < 44; i++) await w.pass(15_000, { touched: 0 });
  assert.equal(w.presence.where, 'away', 'ten minutes of only his own input');
  done();
  await w.pass(1000, { touched: 900 });
  assert.equal(w.presence.where, 'away', 'the last of his own, a moment after');
  // Then a real key, well clear of his.
  await w.pass(30_000, { touched: 0 });
  assert.equal(w.presence.where, 'here');
});

test('their voice, the watch or a hand in view says they’re here with nothing touched', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  await w.pass(9 * MIN);
  assert.equal(w.presence.where, 'near');
  w.presence.seen('voice');
  assert.equal(w.presence.where, 'here');
  await w.pass(9 * MIN);
  assert.equal(w.presence.where, 'near', 'counted from the voice, not the last key');
  await w.pass(2 * MIN);
  assert.equal(w.presence.where, 'away');
  w.presence.seen('camera');
  assert.equal(w.arrivals.at(-1).by, 'camera');
});

test('the day’s first sit-down is once a day, and working past midnight isn’t a new day', async () => {
  const w = watched({ start: at(22), idle: 0 });
  await w.presence.tick();
  assert.equal(w.arrivals[0].first, true);
  // Away for a while, back at 1 AM: the same day.
  await w.pass(30 * MIN);
  await w.pass(150 * MIN, { touched: 0 });
  assert.equal(new Date(w.time).getHours(), 1);
  assert.equal(w.arrivals.at(-1).first, false);
  // To bed, and back at nine: the next day's first.
  await w.pass(30 * MIN);
  await w.pass(7.5 * HOUR, { touched: 0 });
  assert.equal(w.arrivals.at(-1).first, true);
  assert.deepEqual(w.presence.days().map((day) => day.day), ['2026-11-15', '2026-11-16']);
});

test('restarted mid-sitting he carries it on; started after a night off, it’s a new arrival', async () => {
  const file = scratch('presence.json');
  const w = watched({ file, idle: 0 });
  await w.presence.tick();
  await w.pass(40 * MIN, { touched: 0 });
  w.presence.stop();
  // Restarted two minutes later: the same sitting, and no arrival.
  w.time += 2 * MIN;
  w.idle = 5;
  w.presence = w.make();
  assert.equal(w.presence.where, 'near');
  await w.presence.tick();
  assert.equal(w.presence.where, 'here');
  assert.equal(w.arrivals.length, 1);
  assert.equal(w.presence.state().sittingSince, at(9));
  w.presence.stop();
  // Quit for the night: the sitting ended when they were last seen.
  const leftAt = w.presence.state().lastSeenAt;
  w.time = at(8, 30, 16);
  w.idle = 2;
  w.presence = w.make();
  assert.equal(w.presence.where, 'away');
  await w.presence.tick();
  assert.equal(w.arrivals.length, 2);
  assert.equal(w.arrivals[1].first, true);
  assert.equal(w.arrivals[1].awayMs, at(8, 30, 16) - 2000 - leftAt);
  const days = w.presence.days();
  assert.deepEqual(days[0].sittings, [[at(9), leftAt]]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('only a week of days is kept', async () => {
  const w = watched({ start: at(9, 0, 1), idle: 0 });
  for (let day = 0; day < 10; day++) {
    await w.presence.tick();
    await w.pass(HOUR);
    w.time += 23 * HOUR;
    w.idle = 0;
  }
  assert.equal(w.presence.days().length, 7);
});

test('lines: when they sat down, for how long, and what it’s counted from; nothing while away', async () => {
  const w = watched({ idle: 0 });
  assert.equal(w.presence.lines(), '');
  await w.presence.tick();
  await w.pass(50 * MIN, { touched: 0 });
  assert.equal(
    w.presence.lines(),
    ['How long the user has been at this computer (give these figures as they are, and work out no others):', '- This sitting: since 9:00 AM, which is 50 minutes.', '- That is all of today: this is their first sitting.', '(Counted from keys, the mouse, unlocking and their voice. Ten minutes with none of them counts as away, unless something was playing.)'].join('\n')
  );
  await w.pass(40 * MIN);
  await w.pass(HOUR, { touched: 0 });
  await w.pass(30 * MIN, { touched: 0 });
  assert.deepEqual(w.presence.lines().split('\n').slice(1, 4), ['- This sitting: since 11:30 AM, which is 30 minutes.', '- Before this sitting they were away from it for 1 hour 40 minutes.', '- Today in all: 1 hour 20 minutes, over 2 sittings, the first begun at 9:00 AM.']);
});

test('PRESENCE_WORDS: asked how long they’ve been at it, not anything about time', () => {
  for (const yes of ['how long have I been working?', 'How long have I been at this', 'when did I sit down today', 'what time did I start', 'should I take a break?', 'how long was I gone', 'how much screen time today', 'I’ve been sitting at this laptop forever', 'how long have I been here'])
    assert.ok(PRESENCE_WORDS.test(yes), yes);
  for (const no of ['what time is it', 'how long is the flight to Boston', 'when does class start', 'break this into steps', 'how long does pasta take', 'I was away last weekend'])
    assert.ok(!PRESENCE_WORDS.test(no), no);
});

test('macScreenKeptAwake: pmset’s count of what keeps the screen on', async () => {
  const out = (n) => `Assertion status system-wide:\n   BackgroundTask                 0\n   PreventUserIdleDisplaySleep    ${n}\n   PreventUserIdleSystemSleep     1\n`;
  assert.equal(await macScreenKeptAwake(async () => out(1)), true);
  assert.equal(await macScreenKeptAwake(async () => out(0)), false);
  assert.equal(await macScreenKeptAwake(async () => 'something else'), null);
  assert.equal(await macScreenKeptAwake(async () => Promise.reject(new Error('no pmset'))), null);
});

test('situation: how long they’ve sat is told only when asked', async () => {
  const off = { connected: false, state: () => ({}) };
  const situation = createSituation({ whereabouts: off, weather: {}, calendars: { connected: false }, units: () => 'fahrenheit', presence: { lines: () => 'At this computer: they sat down at 9:00 AM, 50 minutes ago.' } });
  assert.deepEqual(await situation.brief('how long have I been at this?'), { block: 'At this computer: they sat down at 9:00 AM, 50 minutes ago.', untrusted: false, summary: 'how long they’ve sat' });
  assert.equal((await situation.brief('what should I have for lunch?')).block, '');
  const away = createSituation({ whereabouts: off, weather: {}, calendars: { connected: false }, units: () => 'fahrenheit', presence: { lines: () => '' } });
  assert.equal((await away.brief('how long have I been at this?')).block, '');
});

test('lateLine: a line told late says when it was for', () => {
  assert.equal(lateLine('Call the dentist.', at(15, 5), at(16)), 'This was for 3:05 PM: Call the dentist.');
  assert.equal(lateLine('Call the dentist.', at(15, 5, 14), at(9)), 'This was for yesterday at 3:05 PM: Call the dentist.');
  assert.equal(lateLine('Call the dentist.', at(15, 5, 12), at(9)), 'This was for Thursday at 3:05 PM: Call the dentist.');
});

/** A teller with the test's presence, voice and timers. */
function telling({ where = 'here' } = {}) {
  const world = { where, said: [], busy: false, held: 0, released: 0, timers: [], logs: [], time: at(16) };
  world.teller = createTeller({
    where: () => world.where,
    announce: (text) => (world.busy ? null : (world.said.push(text), Promise.resolve())),
    release: async () => void (world.released += 1),
    held: () => world.held,
    setTimer: (fn, ms) => (world.timers.push({ fn, ms }), world.timers.length),
    clearTimer: (id) => (world.timers[id - 1] = null),
    now: () => world.time,
    log: (...parts) => world.logs.push(parts.join(' '))
  });
  return world;
}

test('telling: here, it’s said; late, with when it was for; and the log never says what', async () => {
  const w = telling();
  assert.equal(await w.teller.say({ payload: { text: 'Time to stretch.' } }, { late: 0, meant: at(16) }), undefined);
  assert.equal(await w.teller.say({ payload: { text: 'Call the dentist.' } }, { late: 55 * MIN, meant: at(15, 5) }), undefined);
  assert.equal(await w.teller.say({ payload: { text: 'Barely late.' } }, { late: LATE_MS - 1, meant: at(15, 58) }), undefined);
  assert.deepEqual(w.said, ['Time to stretch.', 'This was for 3:05 PM: Call the dentist.', 'Barely late.']);
  assert.deepEqual(w.logs, ['telling: a line', 'telling: a line, 55 min late', 'telling: a line']);
});

test('telling: told late, a job’s own words for that are used', async () => {
  const w = telling();
  await w.teller.say({ payload: { text: 'Reminder: stretch.', late: 'Reminder, from 3:05 PM: stretch.' } }, { late: 55 * MIN, meant: at(15, 5) });
  await w.teller.say({ payload: { text: 'Reminder: stretch.', late: 'Reminder, from 3:05 PM: stretch.' } }, { late: 1000, meant: at(15, 59) });
  assert.deepEqual(w.said, ['Reminder, from 3:05 PM: stretch.', 'Reminder: stretch.']);
});

test('telling: away, it’s held; mid-sentence, tried again in a moment; nothing to say is done with', async () => {
  const w = telling({ where: 'away' });
  assert.deepEqual(await w.teller.say({ payload: { text: 'Held.' } }, {}), { hold: true });
  assert.deepEqual(w.said, []);
  w.where = 'near';
  w.busy = true;
  assert.deepEqual(await w.teller.say({ payload: { text: 'Later.' } }, {}), { retryIn: BUSY_MS });
  w.busy = false;
  assert.equal(await w.teller.say({ payload: { text: 'Later.' } }, {}), undefined);
  assert.deepEqual(w.said, ['Later.'], 'near, they can still hear it');
  assert.equal(await w.teller.say({ payload: {} }, {}), undefined);
  assert.equal(await w.teller.say({}, {}), undefined);
  assert.equal(w.said.length, 1);
});

test('telling: back at the computer, what was held is told after a moment, unless they’ve gone again', async () => {
  const w = telling({ where: 'away' });
  w.teller.moved('here');
  assert.equal(w.timers.length, 0, 'nothing held, nothing to do');
  w.held = 2;
  w.where = 'here';
  w.teller.moved('here');
  w.teller.moved('here');
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0].ms, 8000);
  w.timers[0].fn();
  assert.equal(w.released, 1);
  // Back, and gone again before the moment's up.
  w.teller.moved('here');
  w.where = 'away';
  w.teller.moved('away');
  assert.equal(w.timers[1], null);
  w.teller.moved('near');
  assert.equal(w.timers.length, 2, 'near isn’t back');
  assert.equal(w.released, 1);
});

/** A conversation with the least around it: what announce needs. */
function conversing({ knows = false } = {}) {
  const world = { time: at(16), spoken: [], shown: [], entries: [], asking: false, running: false, archived: [], idle: 0 };
  let finish = null;
  world.conversation = createConversation({
    chat: async () => ({ say: 'Hello.', do: '', new: false }),
    speaker: {
      say: (text) => (world.spoken.push(text), world.hold ? new Promise((resolve) => (finish = resolve)) : Promise.resolve()),
      stop: () => finish?.()
    },
    memory: {
      add: (who, text) => world.entries.push({ who, text }),
      current: () => [...world.entries],
      idleFor: () => world.idle,
      startNew: () => world.entries.splice(0),
      clear: () => (world.entries.length = 0)
    },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    commands: { knows: async () => false, risky: () => false, run: async () => ({ ok: true, text: '' }) },
    assistant: {
      get asking() {
        return world.asking;
      },
      get running() {
        return world.running;
      },
      cancel: () => undefined
    },
    archive: (entries) => world.archived.push(entries),
    show: (voice) => world.shown.push(voice),
    knowsYou: () => knows,
    now: () => world.time
  });
  world.finish = () => finish?.();
  return world;
}

test('announce: he says it, it’s in the conversation, and he listens on for what they say back', async () => {
  const w = conversing({ knows: true });
  await w.conversation.announce('Time to stretch.');
  assert.deepEqual(w.spoken, ['Time to stretch.']);
  assert.deepEqual(w.entries, [{ who: 'jester', text: 'Time to stretch.' }]);
  assert.ok(w.shown.some((voice) => voice.active === true && voice.hold), 'the pill stays open');
  // Waiting on what they'll say next, now isn't the moment for another.
  assert.equal(w.conversation.announce('And another.'), null);
  w.time += 12_000;
  assert.notEqual(w.conversation.announce('And another.'), null);
});

test('announce: not across his own sentence, a question of the assistant’s, or a task at work', async () => {
  const w = conversing();
  w.hold = true;
  const first = w.conversation.announce('A long line.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.conversation.announce('Across it.'), null, 'he’s talking');
  w.finish();
  await first;
  w.hold = false;
  w.time += 5000;
  w.asking = true;
  assert.equal(w.conversation.announce('Across a question.'), null);
  w.asking = false;
  w.running = true;
  assert.equal(w.conversation.announce('Across a task.'), null);
  w.running = false;
  await w.conversation.announce('Now.');
  assert.deepEqual(w.spoken, ['A long line.', 'Now.']);
});

test('announce: written with the mic closed, and long after the last words it begins the next conversation', async () => {
  const w = conversing();
  w.entries.push({ who: 'you', text: 'hello' }, { who: 'jester', text: 'Hello.' });
  w.idle = 2 * HOUR;
  await w.conversation.announce('This was for 3:05 PM: Call the dentist.', { written: true });
  assert.deepEqual(w.spoken, [], 'not said');
  assert.deepEqual(w.entries, [{ who: 'jester', text: 'This was for 3:05 PM: Call the dentist.' }]);
  assert.equal(w.archived.length, 1, 'what came before is over, and kept');
  assert.ok(w.shown.some((voice) => voice.phase === 'answer' && /Call the dentist/.test(voice.text)));
});

// What a review of the above found (2026-11-15), each one a way it went wrong.

test('one of his clicks, then a read of the screen seconds later, still isn’t the user', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  await w.pass(15 * MIN);
  assert.equal(w.presence.where, 'away');
  // He clicks; six seconds on he reads a control (no input of its own), and the count still says six seconds.
  w.presence.own()();
  w.time += 6000;
  w.idle = 6;
  w.presence.own()();
  assert.equal(await w.presence.tick(), 'away');
  // And a quarter of an hour of clicking and reading by turns, with nobody there, ends as away.
  const v = watched({ idle: 0 });
  await v.presence.tick();
  for (let i = 0; i < 60; i++) {
    v.presence.own()();
    v.time += 6000;
    v.presence.own()();
    await v.pass(9000, { touched: 15_000 });
  }
  assert.equal(v.presence.where, 'away');
});

test('quiet through a film, they were at it until it ended', async () => {
  const w = watched({ idle: 0, kept: true });
  await w.presence.tick();
  for (let i = 0; i < 120; i++) await w.pass(MIN);
  assert.equal(w.presence.where, 'near');
  const ended = w.time;
  w.kept = false;
  await w.pass(MIN);
  assert.equal(w.presence.where, 'away');
  assert.equal(w.leaves[0].at, ended);
  await w.pass(MIN, { touched: 0 });
  assert.equal(w.arrivals.at(-1).awayMs, 2 * MIN);
  assert.equal(w.presence.days()[0].sittings[0][1], ended, 'the film is in the sitting');
});

test('a key from before the lid closed isn’t them coming back, however the count behaves', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  await w.pass(MIN, { touched: 5000 });
  w.presence.screen('suspended', true);
  // Eight hours shut, and the count stood still: it says fifteen seconds.
  w.time += 8 * HOUR;
  w.idle = 15;
  w.presence.screen('suspended', false);
  assert.equal(await w.presence.tick(), 'away');
  assert.equal(w.arrivals.length, 1);
  // Their voice just before a short nap, and a key from before it: what was seen never moves back.
  const v = watched({ idle: 0 });
  await v.presence.tick();
  await v.pass(90_000);
  v.presence.seen('voice');
  const spoke = v.time;
  v.presence.screen('suspended', true);
  v.time += 30_000;
  v.idle = 100;
  v.presence.screen('suspended', false);
  await v.presence.tick();
  assert.ok(v.presence.state().lastSeenAt >= spoke);
});

test('the computer’s clock set back doesn’t leave them here for good', async () => {
  const w = watched({ idle: 0 });
  await w.presence.tick();
  w.time -= HOUR;
  await w.pass(15_000);
  await w.pass(15 * MIN);
  assert.equal(w.presence.where, 'away');
});

test('a daily job doesn’t run twice for one day when the clock is set back past its time', async () => {
  const t = timed({ start: at(6) });
  const ran = [];
  t.clock.on('brief', () => void ran.push(t.time));
  t.clock.start();
  t.clock.add({ id: 'brief', kind: 'brief', daily: '07:00' });
  await t.pass(HOUR + MIN);
  assert.equal(ran.length, 1);
  // Back to half past six, the same morning: seven comes round again.
  t.sleep(-31 * MIN);
  await t.clock.wake();
  await t.pass(2 * HOUR);
  assert.equal(ran.length, 1);
  assert.equal(t.clock.list()[0].due, at(7, 0, 16));
  await t.pass(24 * HOUR);
  assert.equal(ran.length, 2);
});

test('a handler that never answers doesn’t stop the clock', async () => {
  const file = scratch('jobs.json');
  let time = at(9);
  const logs = [];
  const clock = createClock({ file, now: () => time, setTimer: () => 1, clearTimer: () => undefined, handlerMs: 20, log: (...parts) => logs.push(parts.join(' ')) });
  const ran = [];
  clock.on('stuck', () => new Promise(() => undefined));
  clock.on('say', (job) => void ran.push(job.id));
  clock.add({ id: 'a', kind: 'stuck', at: at(9, 1) });
  clock.add({ id: 'b', kind: 'say', at: at(9, 2) });
  time = at(9, 5);
  clock.start();
  await clock.tick();
  assert.deepEqual(ran, ['b']);
  assert.ok(logs.some((line) => /clock: stuck a failed \(no answer in 0 min\): again in 1 min/.test(line)), logs.join('\n'));
});

test('announce: his name heard and nothing come of it doesn’t keep him quiet for good', async () => {
  const w = conversing();
  w.conversation.woken();
  assert.equal(w.conversation.announce('Mid-sentence.'), null, 'they may still be talking');
  w.time += 13_000;
  assert.equal(await w.conversation.announce('Now.'), true);
  w.conversation.woken();
  w.conversation.reset();
  w.time += 2000;
  assert.notEqual(w.conversation.announce('After the mic closed.', { written: true }), null);
});

test('announce: cut off as listening ends, it wasn’t told; and the teller tries again', async () => {
  const w = conversing();
  w.hold = true;
  const told = w.conversation.announce('Your laundry is done.');
  await new Promise((resolve) => setImmediate(resolve));
  // The screen locks: listening ends, and he stops mid-line.
  w.conversation.reset();
  assert.equal(await told, false);
  const t = telling();
  t.teller = createTeller({ where: () => 'here', announce: () => Promise.resolve(false), release: async () => undefined, held: () => 0, log: (...parts) => t.logs.push(parts.join(' ')) });
  assert.deepEqual(await t.teller.say({ payload: { text: 'Your laundry is done.' } }, {}), { retryIn: BUSY_MS });
  assert.deepEqual(t.logs, ['telling: a line was cut off as listening ended, so it’s still to tell']);
});
