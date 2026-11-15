// Step 8 (2026-11-15): the to-do list, reminders and timers he keeps (tasks.js), how the conversation asks for
// them ("task" in a model's reply, and timers by the user's own words), and that only the user ticks one off.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abilitiesPart } from '../desktop/src/main/abilities.js';
import { askModel, createConversation, personaPrompt } from '../desktop/src/main/conversation.js';
import { createSituation } from '../desktop/src/main/situation.js';
import { createTasks, dayIn, dayWords, dueWords, durationOf, reminderText, spanWords, stems, TASK_WORDS, timerAsked, timerCancelAsked, timerLeftAsked, whenAsked, whenOf } from '../desktop/src/main/tasks.js';
import { countdown, groupOf } from '../desktop/src/home/tasks.js';
import { backOf, direction, placeOf } from '../desktop/src/home/screens.js';

const at = (h, m = 0, day = 15) => new Date(2026, 10, day, h, m).getTime();
const MIN = 60_000;
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A task book on a scratch file, with the test's time and a clock that only notes what it's asked. */
function book({ start = at(14, 30), file } = {}) {
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), 'jester-tasks-'));
    made.push(dir);
    file = join(dir, 'tasks.json');
  }
  const world = { time: start, jobs: new Map(), logs: [], changes: 0, file };
  world.clock = { add: (job) => (world.jobs.set(job.id, job), job), remove: (id) => world.jobs.delete(id) };
  world.make = () => createTasks({ file, clock: world.clock, now: () => world.time, log: (...parts) => world.logs.push(parts.join(' ')), onChange: () => (world.changes += 1) });
  world.tasks = world.make();
  world.texts = () => world.tasks.list().open.map((task) => task.text);
  return world;
}

test('durationOf: lengths of time as they’re said', () => {
  const cases = { 'ten minutes': 10 * MIN, 'an hour and a half': 90 * MIN, '1 hour 30 minutes': 90 * MIN, 'two and a half minutes': 150_000, 'half an hour': 30 * MIN, '90 seconds': 90_000, '5 min': 5 * MIN, 'twenty five minutes': 25 * MIN, 'twenty-five minutes': 25 * MIN, '1 hour and 15 minutes': 75 * MIN, 'a minute': MIN, '2.5 hours': 150 * MIN, '5 minute': 5 * MIN };
  for (const [phrase, ms] of Object.entries(cases)) assert.equal(durationOf(phrase), ms, phrase);
  for (const not of ['pasta', 'ten', 'minutes', '', 'ten minutes ago', 'a while']) assert.ok(Number.isNaN(durationOf(not)), not);
});

test('spanWords: how long, said', () => {
  assert.equal(spanWords(10 * MIN), '10 minutes');
  assert.equal(spanWords(90 * MIN), '1 hour 30 minutes');
  assert.equal(spanWords(45_000), '45 seconds');
  assert.equal(spanWords(9 * MIN + 20_000), '9 minutes 20 seconds');
  assert.equal(spanWords(12 * MIN + 20_000), '12 minutes', 'seconds only matter under ten minutes');
  assert.equal(spanWords(MIN), '1 minute');
});

test('timerAsked: a timer in the user’s own words, and only when that’s all they asked', () => {
  const yes = {
    'set a timer for ten minutes': [10 * MIN, ''],
    'Set a timer for 10 minutes.': [10 * MIN, ''],
    'can you set a timer for an hour and a half please': [90 * MIN, ''],
    'start a 5 minute timer': [5 * MIN, ''],
    'ten-minute timer': [10 * MIN, ''],
    'timer for 90 seconds': [90_000, ''],
    'set a pasta timer for 8 minutes': [8 * MIN, 'pasta'],
    'set a timer for 20 minutes for the laundry': [20 * MIN, 'laundry'],
    'time me for two minutes': [2 * MIN, ''],
    'put a twenty five minute timer on': [25 * MIN, ''],
    'I need a timer for half an hour': [30 * MIN, ''],
    'set another timer for 3 minutes': [3 * MIN, '']
  };
  for (const [said, [ms, name]] of Object.entries(yes)) assert.deepEqual(timerAsked(said), { ms, name }, said);
  for (const no of ['set a timer', 'set a timer for 10 minutes before class ends', 'open Spotify and set a timer for ten minutes', 'cancel the timer', 'how long is left on the timer', 'remind me in ten minutes to call mom', 'what is a timer', 'set a timer for 30 hours'])
    assert.equal(timerAsked(no), null, no);
  assert.ok(timerCancelAsked('cancel the timer') && timerCancelAsked('stop my timers') && !timerCancelAsked('cancel my 3pm reminder'));
  assert.ok(timerLeftAsked('how long is left on the timer') && timerLeftAsked('how much time is left?') && timerLeftAsked("how's the timer doing") && !timerLeftAsked('how long is the flight'));
});

test('whenOf: the time a model gave, read as this computer’s own', () => {
  const now = at(14, 30);
  assert.deepEqual(whenOf({ at: '2026-11-16 15:00' }, now), { due: at(15, 0, 16), allDay: false });
  assert.deepEqual(whenOf({ at: '2026-11-16T09:30:00' }, now), { due: at(9, 30, 16), allDay: false });
  assert.deepEqual(whenOf({ at: '2026-11-15 3:00 PM' }, now), { due: at(15), allDay: false });
  assert.deepEqual(whenOf({ at: '2026-11-20' }, now), { due: at(0, 0, 20), allDay: true });
  assert.deepEqual(whenOf({ at: '2026-11-15' }, now), { due: at(0), allDay: true }, 'today, as a day, isn’t past');
  assert.deepEqual(whenOf({ in: 20 }, now), { due: at(14, 50), allDay: false });
  assert.deepEqual(whenOf({ in: 0.5, at: '2026-11-16 15:00' }, now), { due: now + 30_000, allDay: false }, '"in" is the surer of the two');
  assert.equal(whenOf({ at: '2026-11-15 09:00' }, now), 'past');
  assert.equal(whenOf({ at: '2026-11-14' }, now), 'past');
  for (const none of [{}, { at: 'tomorrow' }, { at: '' }, { in: -5 }, { at: '2026-13-40 10:00' }, { at: '2026-11-16 27:00' }]) assert.equal(whenOf(none, now), null, JSON.stringify(none));
});

test('dayWords and dueWords: when, as he says it back', () => {
  const now = at(14, 30);
  assert.equal(dayWords(at(9, 0, 16), now), 'tomorrow');
  assert.equal(dayWords(at(9, 0, 18), now), 'on Wednesday');
  assert.equal(dayWords(at(9, 0, 27), now), 'on Friday, Nov 27');
  assert.equal(dueWords({ due: at(15) }, now), 'at 3:00 PM');
  assert.equal(dueWords({ due: at(9, 0, 16) }, now), 'tomorrow at 9:00 AM');
  assert.equal(dueWords({ due: at(0, 0, 20), allDay: true }, now), 'on Friday');
  assert.equal(dueWords({}, now), '');
});

test('stems: the words that say which task', () => {
  assert.deepEqual([...stems('Call the dentist')], ['call', 'dent']);
  assert.deepEqual([...stems('I called my dentist already')], ['call', 'dent']);
  assert.deepEqual([...stems('the reminder, done')], []);
});

test('TASK_WORDS: words that may be about the list, a reminder or a timer', () => {
  for (const yes of ['remind me to call mom', 'what’s on my to-do list', 'set a timer', 'what do I have to do today', 'snooze that', 'tick that off', 'mark it as done', 'add milk to my list', 'any tasks left?']) assert.ok(TASK_WORDS.test(yes), yes);
  for (const no of ['what time is it', 'open Spotify', 'how was your day', 'I did well on the exam', 'tell me a joke']) assert.ok(!TASK_WORDS.test(no), no);
});

test('a task is kept, on the clock if it has a time, and survives a restart', () => {
  const w = book();
  const plain = w.tasks.add({ text: 'Buy stamps' });
  const timed = w.tasks.add({ text: 'Call the dentist', due: at(15) });
  const day = w.tasks.add({ text: 'Homework 5', due: at(0, 0, 20), allDay: true });
  assert.deepEqual([...w.jobs.keys()], [`task-${timed.id}`], 'only what rings is on the clock');
  assert.deepEqual(w.jobs.get(`task-${timed.id}`), { id: `task-${timed.id}`, kind: 'task', at: at(15), payload: { id: timed.id } });
  assert.equal(w.tasks.count, 3);
  assert.deepEqual(w.texts(), ['Call the dentist', 'Homework 5', 'Buy stamps'], 'soonest first, then what has no time');
  const again = w.make();
  assert.deepEqual(again.list().open.map((task) => task.id), [timed.id, day.id, plain.id]);
  assert.equal(JSON.parse(readFileSync(w.file, 'utf8')).version, 1);
  w.jobs.clear();
  again.reschedule();
  assert.deepEqual([...w.jobs.keys()], [`task-${timed.id}`], 'a clock that lost its jobs gets them back');
});

test('a reminder told stays on the list until it’s ticked; a timer told is gone', () => {
  const w = book();
  const reminder = w.tasks.add({ text: 'Call the dentist', due: at(15) });
  w.tasks.direct('set a timer for ten minutes');
  const timer = w.tasks.list().timers[0];
  assert.equal(w.tasks.ringLine(reminder.id), 'Reminder: call the dentist.');
  assert.equal(w.tasks.ringLine(timer.id), 'Your 10 minute timer is up.');
  // Told late (they were away), each says when it was for.
  assert.equal(w.tasks.ringLine(reminder.id, at(13, 5)), 'Reminder, from 1:05 PM: call the dentist.');
  assert.equal(w.tasks.ringLine(reminder.id, at(13, 5, 14)), 'Reminder, from yesterday at 1:05 PM: call the dentist.');
  assert.equal(w.tasks.ringLine(timer.id, at(13, 5)), 'Your 10 minute timer went off at 1:05 PM.');
  w.time = at(15);
  w.tasks.rang(timer.id);
  w.tasks.rang(reminder.id);
  const list = w.tasks.list();
  assert.equal(list.timers.length, 0);
  assert.equal(list.open.length, 1);
  assert.equal(list.open[0].told, at(15));
  // Ticked off: nothing more to say about it, and off the clock.
  w.tasks.done(reminder.id);
  assert.equal(w.tasks.ringLine(reminder.id), '');
  assert.equal(w.tasks.list().open.length, 0);
  assert.equal(w.tasks.list().done[0].text, 'Call the dentist');
  assert.equal(w.jobs.size, 0);
  // Put back, with its time gone by and already told: it doesn't ring again.
  w.time += MIN;
  w.tasks.done(reminder.id, false);
  assert.equal(w.jobs.size, 0);
  assert.equal(w.tasks.list().open[0].overdue, true);
});

test('what’s ticked off is kept a week, then gone', () => {
  const w = book();
  const task = w.tasks.add({ text: 'Buy stamps' });
  w.tasks.done(task.id);
  w.time += 6 * 24 * 3600_000;
  w.tasks.add({ text: 'Another' });
  assert.equal(w.tasks.list().done.length, 1);
  w.time += 2 * 24 * 3600_000;
  w.tasks.add({ text: 'And another' });
  assert.equal(w.tasks.list().done.length, 0);
});

test('timers by the user’s own words: set, asked after, cancelled', () => {
  const w = book();
  assert.equal(w.tasks.direct('what’s the weather'), '');
  assert.equal(w.tasks.direct('how long is left?'), '', 'with no timer running, that isn’t about one');
  assert.equal(w.tasks.direct('how long is left on the timer?'), 'There’s no timer running.');
  assert.equal(w.tasks.direct('cancel the timer'), 'There’s no timer running.');
  assert.equal(w.tasks.direct('Set a timer for 10 minutes.'), '10 minutes, starting now.');
  const [job] = [...w.jobs.values()];
  assert.equal(job.at, at(14, 40));
  w.time += 6 * MIN + 40_000;
  assert.equal(w.tasks.direct('how long is left on the timer?'), '3 minutes 20 seconds left on your 10 minute timer.');
  assert.equal(w.tasks.direct('how much time is left'), '3 minutes 20 seconds left on your 10 minute timer.');
  assert.equal(w.tasks.direct('set a pasta timer for 8 minutes'), '8 minutes, for the pasta, starting now.');
  assert.equal(w.tasks.direct('how are the timers doing?'), '3 minutes 20 seconds left on the 10 minute timer, and 8 minutes left on the pasta timer.');
  assert.match(w.tasks.direct('cancel the timer'), /^You have 2 running: 10 minute, 3 minutes 20 seconds left; Pasta, 8 minutes left\. Which one\?$/);
  assert.equal(w.tasks.direct('cancel the pasta timer'), 'Cancelled, with 8 minutes left.');
  assert.equal(w.tasks.direct('stop the timer'), 'Cancelled, with 3 minutes 20 seconds left.');
  assert.equal(w.jobs.size, 0);
  w.tasks.direct('timer for 1 minute');
  w.tasks.direct('timer for 2 minutes');
  assert.equal(w.tasks.direct('cancel all the timers'), 'All 2 timers cancelled.');
  assert.equal(w.tasks.count, 0, 'timers aren’t counted as tasks');
});

test('apply: what a model asked for is said back from what was kept', () => {
  const w = book();
  const said = 'put that on my list';
  assert.equal(w.tasks.apply({ op: 'add', text: 'call your mom', at: '2026-11-16 15:00' }, { said: 'remind me to call my mom tomorrow at 3 pm' }), 'Okay, I’ll remind you tomorrow at 3:00 PM: Call your mom.');
  assert.equal(w.tasks.apply({ op: 'add', text: 'check the oven', in: 20 }, { said: 'remind me in twenty minutes to check the oven' }), 'Okay, I’ll remind you at 2:50 PM: Check the oven.');
  assert.equal(w.tasks.apply({ op: 'add', text: '"buy stamps."' }, { said }), 'Added to your list: Buy stamps.');
  assert.equal(w.tasks.apply({ op: 'add', text: 'submit homework 5', at: '2026-11-20' }, { said: 'put homework 5 on my list for Friday' }), 'Added to your list for Friday: Submit homework 5.');
  assert.equal(w.tasks.apply({ op: 'add', text: 'Buy stamps' }, { said }), 'That’s already on your list.');
  assert.equal(w.tasks.apply({ op: 'add', text: 'go back in time', at: '2026-11-15 09:00' }, { said: 'remind me today at 9 am to go back in time' }), 'That time has already gone by, so I haven’t set it. When should it be?');
  assert.equal(w.tasks.apply({ op: 'add' }, { said }), 'What should I put on your list?');
  assert.equal(w.tasks.apply({ op: 'timer', in: 25 }, { said: 'time me, twenty five minutes' }), '25 minutes, starting now.');
  assert.equal(w.tasks.apply({ op: 'timer' }, { said }), 'How long should the timer be?');
  assert.equal(w.tasks.apply({ op: 'dance' }, { said }), '');
  assert.deepEqual(w.texts(), ['Check the oven', 'Call your mom', 'Submit homework 5', 'Buy stamps']);
  assert.ok(!w.logs.some((line) => /mom|oven|stamps/i.test(line)), 'the log never says what');
});

test('dayIn: the day their words name, when it’s just the one', () => {
  const now = at(14, 30); // a Sunday
  assert.equal(dayIn('remind me tomorrow at 3', now), at(0, 0, 16));
  assert.equal(dayIn('for the day after tomorrow', now), at(0, 0, 17));
  assert.equal(dayIn('tonight at 8', now), at(0));
  assert.equal(dayIn('on Friday', now), at(0, 0, 20));
  assert.equal(dayIn('Friday at 3 pm', now), at(0, 0, 20));
  assert.equal(dayIn('next Sunday', now), at(0, 0, 22), 'not today');
  assert.equal(dayIn('remind me at 5 to call mom about Sunday dinner', now), null, 'a day that’s only what it’s about');
  assert.equal(dayIn('remind me tomorrow about the report due on Friday', now), null, 'two days: the model’s to sort out');
  assert.equal(dayIn('add stamps to my list', now), null);
});

test('whenAsked: a model’s time is checked against what they said', () => {
  const now = at(17, 18);
  // No time in their words: none is kept, whatever the model gave.
  assert.equal(whenAsked({ at: '2026-11-15 17:18' }, 'add buy stamps to my to-do list', '', now), null);
  assert.equal(whenAsked({ in: 5 }, 'add buy stamps to my to-do list', '', now), null);
  // A day and no time of day is the day.
  assert.deepEqual(whenAsked({ at: '2026-11-17 15:00' }, 'put the lab report on my list for the day after tomorrow', '', now), { due: at(0, 0, 17), allDay: true });
  // The day they named, not the one the model worked out.
  assert.deepEqual(whenAsked({ at: '2026-11-17 14:00' }, 'push the dentist to tomorrow at 2 pm', '', now), { due: at(14, 0, 16), allDay: false });
  assert.deepEqual(whenAsked({ at: '2026-11-18 17:00' }, 'put the lab report on my list for the day after tomorrow', '', now), { due: at(0, 0, 17), allDay: true });
  // A time already gone today is tomorrow's, unless they said today.
  assert.deepEqual(whenAsked({ at: '2026-11-15 17:00' }, 'remind me at 5 pm to leave for the gym', '', now), { due: at(17, 0, 16), allDay: false });
  assert.equal(whenAsked({ at: '2026-11-15 17:00' }, 'remind me today at 5 pm to leave for the gym', '', now), 'past');
  // Right as it is, it's left alone.
  assert.deepEqual(whenAsked({ at: '2026-11-16 15:00' }, 'remind me to call my mom tomorrow at 3 pm', '', now), { due: at(15, 0, 16), allDay: false });
  assert.deepEqual(whenAsked({ at: '2026-11-20' }, 'homework 5 is due on the 20th, put it on my list', '', now), { due: at(0, 0, 20), allDay: true });
  assert.deepEqual(whenAsked({ in: 20 }, 'remind me in twenty minutes to check the oven', '', now), { due: now + 20 * MIN, allDay: false });
  // A yes to his offer: the time is in what he offered.
  assert.deepEqual(whenAsked({ at: '2026-11-16 09:00' }, 'yes please', 'Want me to remind you tomorrow at 9?', now), { due: at(9, 0, 16), allDay: false });
  // A day named and no date from the model: the day.
  assert.deepEqual(whenAsked({}, 'put it on my list for tomorrow', '', now), { due: at(0, 0, 16), allDay: true });
});

test('reminderText: what a reminder is of, said back to them', () => {
  assert.equal(reminderText('remind me in twenty minutes to check the oven'), 'check the oven');
  assert.equal(reminderText('Remind me to call my mom in an hour.'), 'call your mom');
  assert.equal(reminderText('can you remind me about my dentist appointment tomorrow'), 'your dentist appointment');
  assert.equal(reminderText('remind me later'), '');
});

test('apply: a model’s timer for what was a reminder or a snooze is taken as what it was', () => {
  const w = book();
  assert.equal(w.tasks.apply({ op: 'timer', in: 20 }, { said: 'remind me in twenty minutes to check the oven' }), 'Okay, I’ll remind you at 2:50 PM: Check the oven.');
  assert.equal(w.tasks.list().timers.length, 0);
  const [task] = w.tasks.list().open;
  w.time = at(14, 50);
  w.tasks.rang(task.id);
  assert.equal(w.tasks.apply({ op: 'timer', in: 10 }, { said: 'snooze that for ten minutes' }), 'Okay, I’ll remind you at 3:00 PM: Check the oven.');
  assert.equal(w.tasks.list().timers.length, 0);
  // Asked for every morning, they get the once and are told so.
  assert.equal(w.tasks.apply({ op: 'add', text: 'take your vitamins', at: '2026-11-16 08:00' }, { said: 'remind me every morning at 8 to take my vitamins' }), 'Okay, I’ll remind you tomorrow at 8:00 AM: Take your vitamins. Just the once, though: I can’t repeat a reminder yet.');
});

test('only the user ticks one off: their words have to be about it', () => {
  const w = book();
  for (const text of ['Buy stamps', 'Email Sarah', 'Call the dentist']) w.tasks.add({ text });
  // The model picks the wrong one, and their words say they did something else nothing's about: he asks.
  assert.equal(w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'I finished the laundry' }), 'Do you mean “Buy stamps”? Say which one and I’ll tick it off.');
  assert.equal(w.tasks.list().done.length, 0);
  // The model picks the wrong one, and their words are plainly about another: that's the one they did.
  assert.equal(w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'I emailed Sarah' }), 'Ticked off: Email Sarah.');
  assert.deepEqual(w.texts(), ['Buy stamps', 'Call the dentist']);
  // A tick nobody's words asked for is left undone, and he answers what was asked.
  assert.equal(w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'what’s on my to-do list?' }), '');
  assert.equal(w.tasks.apply({ op: 'done', text: 'Email Sarah' }, { said: 'what’s on my to-do list?' }), '', 'nor one for what’s already ticked');
  assert.equal(w.tasks.list().done.length, 1);
  // "Done", with his last line naming it.
  assert.equal(w.tasks.apply({ op: 'done', text: 'dentist' }, { said: 'yeah that’s done', last: 'You still have call the dentist on your list.' }), 'Ticked off: Call the dentist.');
  // "Done" out of nowhere doesn't tick whatever the model fancied.
  assert.equal(w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'done', last: 'The weather is fine.' }), 'Do you mean “Buy stamps”? Say which one and I’ll tick it off.');
  assert.equal(w.tasks.apply({ op: 'done', text: 'the garden' }, { said: 'I did the garden' }), 'I don’t see “the garden” on your list.');
  assert.deepEqual(w.texts(), ['Buy stamps']);
});

test('right after a reminder, “done” and “snooze” are about it', () => {
  const w = book();
  const task = w.tasks.add({ text: 'Call your mom', due: at(15) });
  w.tasks.add({ text: 'Buy stamps' });
  w.time = at(15);
  w.tasks.rang(task.id);
  assert.ok(w.tasks.wanted('okay'), 'what’s said next is shown the list');
  assert.equal(w.tasks.apply({ op: 'move', in: 10 }, { said: 'snooze that ten minutes' }), 'Okay, I’ll remind you at 3:10 PM: Call your mom.');
  assert.equal(w.jobs.get(`task-${task.id}`).at, at(15, 10), 'it rings again');
  assert.equal(w.tasks.get(task.id).told, undefined);
  w.time = at(15, 10);
  w.tasks.rang(task.id);
  assert.equal(w.tasks.apply({ op: 'done' }, { said: 'done' }), 'Ticked off: Call your mom.');
  w.time += 10 * MIN;
  assert.ok(!w.tasks.wanted('okay'));
  assert.equal(w.tasks.apply({ op: 'done' }, { said: 'done' }), 'Which one do you mean?');
});

test('saidDone, and a time from their own words when the model gave none', () => {
  const w = book();
  w.tasks.add({ text: 'Call the dentist', due: at(16) });
  w.tasks.add({ text: 'Call the bank' });
  assert.equal(w.tasks.saidDone('I called them'), '', 'their words name none');
  assert.equal(w.tasks.saidDone('I made a call'), '', 'nor one of two');
  assert.equal(w.tasks.saidDone('I called the dentist'), 'Ticked off: Call the dentist.');
  assert.equal(w.tasks.saidDone('I called the dentist'), '', 'not the bank, for sharing "call"');
  assert.deepEqual(w.texts(), ['Call the bank']);
  // The model picks the bank for it: it isn't what their words are about, and it's a statement, so he asks.
  assert.equal(w.tasks.apply({ op: 'done', text: 'bank' }, { said: 'I rang the dentist' }), 'Do you mean “Call the bank”? Say which one and I’ll tick it off.');
  assert.deepEqual(w.texts(), ['Call the bank']);
  const now = at(14, 30);
  assert.deepEqual(whenAsked({ at: 'in 10' }, 'snooze that for ten minutes', '', now), { due: at(14, 40), allDay: false });
  assert.deepEqual(whenAsked({}, 'remind me in an hour and a half to stretch', '', now), { due: at(16), allDay: false });
});

test('removing and moving need their words too, and two that fit are asked about', () => {
  const w = book();
  w.tasks.add({ text: 'Call the dentist', due: at(16) });
  w.tasks.add({ text: 'Call the bank' });
  w.tasks.add({ text: 'Buy stamps' });
  assert.equal(w.tasks.apply({ op: 'remove', text: 'call' }, { said: 'take the call off my list' }), 'Which one: “Call the dentist” or “Call the bank”?');
  assert.equal(w.tasks.apply({ op: 'remove', text: 'stamps' }, { said: 'never mind that one' }), 'Do you mean “Buy stamps”? Say which one and I’ll take it off.');
  // The model's pick is wrong and their words say which: theirs goes.
  assert.equal(w.tasks.apply({ op: 'remove', text: 'stamps' }, { said: 'never mind the bank call' }), 'Removed from your list: Call the bank.');
  assert.equal(w.tasks.apply({ op: 'move', text: 'dentist', at: '2026-11-16 10:00' }, { said: 'move the dentist to tomorrow at ten' }), 'Okay, I’ll remind you tomorrow at 10:00 AM: Call the dentist.');
  assert.equal(w.tasks.apply({ op: 'move', text: 'dentist' }, { said: 'move the dentist one' }), 'When should I remind you about “Call the dentist”?');
  assert.equal(w.tasks.apply({ op: 'move', text: 'stamps', at: '2026-11-18' }, { said: 'do the stamps on Wednesday instead' }), 'Moved to Wednesday: Buy stamps.');
  w.tasks.direct('set a timer for 5 minutes');
  assert.equal(w.tasks.apply({ op: 'remove', text: '5 minute timer' }, { said: 'cancel the five minute one', last: 'You have a 5 minute timer going.' }), 'Cancelled, with 5 minutes left.');
});

test('asked: a task is made only when their words ask, or say yes to his offer', () => {
  const { tasks } = book();
  assert.ok(tasks.asked('remind me to call mom at 3'));
  assert.ok(tasks.asked('put stamps on my to-do list'));
  assert.ok(tasks.asked('yes please', 'Want me to set a reminder for that?'));
  assert.ok(tasks.asked('in twenty minutes', 'Sure. When should I remind you?'));
  assert.ok(!tasks.asked('I need to call the dentist tomorrow'));
  assert.ok(!tasks.asked('yes please', 'Want me to open Spotify?'));
  assert.ok(!tasks.asked('what’s the capital of France'));
  assert.ok(tasks.asked('write down that I need to call mom', '', 'add', 'call your mom'), 'asked to keep it, and it’s what they said');
  assert.ok(!tasks.asked('write down that I need to call mom', '', 'add', 'buy a boat'));
  assert.ok(tasks.asked('I need you to time my break, fifteen minutes', '', 'timer'), 'a length of time asks for a timer');
  assert.ok(!tasks.asked('I need you to time my break, fifteen minutes', '', 'add'));
  assert.ok(!tasks.asked('how was your day', '', 'timer'));
});

test('lines: the list as the model’s told it', () => {
  const w = book();
  assert.equal(w.tasks.lines(), 'The user’s to-do list, which you keep, is empty, and no timer is running.');
  w.tasks.add({ text: 'Buy stamps' });
  const told = w.tasks.add({ text: 'Pay rent', due: at(9) });
  w.tasks.add({ text: 'Call the dentist', due: at(15) });
  w.tasks.add({ text: 'Homework 5', due: at(0, 0, 20), allDay: true });
  w.tasks.add({ text: 'Renew passport', due: at(0, 0, 13), allDay: true });
  const done = w.tasks.add({ text: 'Email Sarah' });
  w.tasks.done(done.id);
  w.tasks.rang(told.id);
  w.tasks.direct('set a timer for ten minutes');
  w.time += 4 * MIN;
  assert.deepEqual(w.tasks.lines().split('\n'), [
    'The user’s to-do list, reminders and timers, which you keep. Nothing on it is done until they say so:',
    '- Timer: 10 minute timer, 6 minutes left.',
    '- Renew passport (for Friday, Nov 13, overdue)',
    '- Pay rent (reminder at 9:00 AM, already given)',
    '- Call the dentist (reminder at 3:00 PM)',
    '- Homework 5 (for Friday)',
    '- Buy stamps',
    'Ticked off today: Email Sarah.'
  ]);
});

test('situation: the list is told when their words may be about it', async () => {
  const off = { connected: false, state: () => ({}) };
  const w = book();
  w.tasks.add({ text: 'Buy stamps' });
  const situation = createSituation({ whereabouts: off, weather: {}, calendars: { connected: false }, units: () => 'fahrenheit', tasks: w.tasks });
  const told = await situation.brief('what’s on my to-do list?');
  assert.match(told.block, /^The user’s to-do list, reminders and timers, which you keep\. Nothing on it is done until they say so:\n- Buy stamps$/);
  assert.equal(told.summary, 'their list');
  assert.equal((await situation.brief('tell me a joke')).block, '');
});

test('the prompt says how to ask for a task only when he keeps them, and what he can do says so too', () => {
  const date = new Date(at(14, 30));
  const without = personaPrompt(date, [], {});
  const withTasks = personaPrompt(date, [], { tasks: true });
  assert.ok(!/"task"/.test(without));
  assert.match(without, /A to-do list, a shopping list or any list of theirs is a note you keep/);
  assert.match(withTasks, /Whenever they ask for one of those, set "task" in your reply, leave "do" empty, and make "say" just "Okay"/);
  assert.match(withTasks, /you reply \{"say":"Okay","do":"","new":false,"task":\{"op":"add","text":"call your mom","at":"2026-11-16 15:00"\}\}\./, 'the example is for tomorrow, by the date he’s given');
  assert.match(withTasks, /that is them ticking it off, so set it at once without asking, and never on a guess of your own\./);
  assert.match(withTasks, /A shopping list or any other list of theirs is a note you keep, not an app's; their to-do list is the one "task" keeps\./);
  assert.match(withTasks, /Leave out "note", "remember", "forget" and "task" unless the user asks/);
  assert.match(withTasks, /- Keep their to-do list, remind them of something at a time or on a day, and run timers\./);
  assert.ok(!/run timers/.test(abilitiesPart({})));
});

test('askModel: "task" comes back only when he keeps tasks, and only as one of its ops', async () => {
  const reply = (json) => async (options) => ({ json, schema: options.schema });
  const base = { text: 'remind me', history: [], date: new Date(at(14, 30)) };
  const got = await askModel({ ...base, tasks: true, request: reply({ say: 'Okay', do: '', new: false, task: { op: 'ADD', text: ' call your mom ', at: '2026-11-16 15:00', in: 0 } }) });
  assert.deepEqual(got.task, { op: 'add', text: 'call your mom', at: '2026-11-16 15:00' });
  assert.equal((await askModel({ ...base, tasks: true, request: reply({ say: 'Okay', do: '', new: false, task: { op: 'explode' } }) })).task, undefined);
  assert.equal((await askModel({ ...base, request: reply({ say: 'Okay', do: '', new: false, task: { op: 'add', text: 'x' } }) })).task, undefined);
  // A small model's "task", put in "do" as the JSON it was shown: taken as the task, and nothing's the laptop's.
  const stray = await askModel({ ...base, tasks: true, request: reply({ say: 'On it.', do: '{"op":"move","text":"Call the dentist","at":"2026-11-16 14:00"}', new: false }) });
  assert.deepEqual([stray.task, stray.do], [{ op: 'move', text: 'Call the dentist', at: '2026-11-16 14:00' }, '']);
  const plain = await askModel({ ...base, tasks: true, request: reply({ say: 'On it.', do: 'open Spotify', new: false }) });
  assert.deepEqual([plain.task, plain.do], [undefined, 'open Spotify']);
  let schema;
  await askModel({ ...base, tasks: true, request: async (options) => ((schema = options.schema), { json: { say: '', do: '', new: false } }) });
  assert.deepEqual(schema.properties.task.properties.op.enum, ['add', 'timer', 'done', 'remove', 'move']);
  await askModel({ ...base, request: async (options) => ((schema = options.schema), { json: { say: '', do: '', new: false } }) });
  assert.equal(schema.properties.task, undefined);
});

/** A conversation typed to, with a real task book and a model that says what the test tells it. */
function talking({ reply }) {
  const w = book();
  w.entries = [];
  w.ran = [];
  w.asked = 0;
  w.clog = [];
  w.reply = reply;
  w.conversation = createConversation({
    chat: async (request) => {
      w.asked += 1;
      w.request = request;
      return typeof w.reply === 'function' ? w.reply(request) : w.reply;
    },
    speaker: { say: async () => undefined, stop: () => undefined },
    memory: {
      add: (who, text) => w.entries.push({ who, text }),
      current: (most) => (most ? w.entries.slice(-most) : [...w.entries]),
      idleFor: () => 0,
      startNew: () => w.entries.splice(0),
      clear: () => (w.entries.length = 0)
    },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    commands: { knows: async () => false, risky: () => false, run: async (text) => (w.ran.push(text), { ok: true, text: 'Done.' }) },
    assistant: { asking: false, running: false, cancel: () => undefined },
    show: () => undefined,
    tasks: w.tasks,
    log: (...parts) => w.clog.push(parts.join(' ')),
    now: () => w.time
  });
  /** Types to him, and gives what he wrote back. */
  w.type = async (text) => {
    const before = w.entries.length;
    await w.conversation.told(text, { typed: true });
    return w.entries.slice(before).filter((entry) => entry.who === 'jester').map((entry) => entry.text).join(' ');
  };
  return w;
}

test('conversation: a timer is set on their own words, with no model asked', async () => {
  const w = talking({ reply: { say: 'This should not be said.', do: '', new: false } });
  assert.equal(await w.type('set a timer for ten minutes'), '10 minutes, starting now.');
  assert.equal(await w.type('how long is left on the timer?'), '10 minutes left on your 10 minute timer.');
  assert.equal(await w.type('cancel the timer'), 'Cancelled, with 10 minutes left.');
  assert.equal(w.asked, 0);
});

test('conversation: a reminder the model asks for is said back from what was kept, not its own line', async () => {
  const w = talking({ reply: { say: 'Sure, I’ll remind you at 4.', do: '', new: false, task: { op: 'add', text: 'call your mom', at: '2026-11-16 15:00' } } });
  assert.equal(await w.type('remind me to call my mom tomorrow at 3'), 'Okay, I’ll remind you tomorrow at 3:00 PM: Call your mom.');
  assert.deepEqual(w.texts(), ['Call your mom']);
  assert.equal(w.request.tasks, true);
  assert.ok(w.clog.some((line) => /"task":\{"op":"add","timed":true\}/.test(line)) && !w.clog.some((line) => /jester:.*mom/.test(line.replace(/"say":"[^"]*"/, ''))), 'the log has the op, not the words');
});

test('conversation: a task nobody asked for isn’t made, and a claim with none set is owned up to', async () => {
  const w = talking({ reply: { say: 'Paris.', do: '', new: false, task: { op: 'add', text: 'learn capitals' } } });
  assert.equal(await w.type('what’s the capital of France?'), 'Paris.');
  assert.deepEqual(w.texts(), []);
  assert.ok(w.clog.includes('a task nobody asked for wasn’t made'));
  w.reply = { say: 'I’ll remind you at six to water the plants.', do: '', new: false };
  assert.equal(await w.type('remind me to water the plants at 6'), 'Sorry, that didn’t get set. Tell me again: what, and when?');
  w.reply = { say: 'Timer is set for five minutes.', do: '', new: false };
  assert.equal(await w.type('could you get a timer going, five minutes or so, once I say go'), 'Sorry, that didn’t get set. Tell me again: what, and when?');
  // Talking about reminders isn't claiming one.
  w.reply = { say: 'A reminder works best right before you leave.', do: '', new: false };
  assert.equal(await w.type('when should I set a reminder for the gym?'), 'A reminder works best right before you leave.');
});

test('conversation: the model can’t tick off what the user didn’t say was done', async () => {
  const w = talking({ reply: { say: 'Looking clear.', do: '', new: false, task: { op: 'done', text: 'stamps' } } });
  w.tasks.add({ text: 'Buy stamps' });
  w.tasks.add({ text: 'Email Sarah' });
  assert.equal(await w.type('how’s my day looking?'), 'Looking clear.', 'he answers what was asked');
  assert.equal(w.tasks.list().done.length, 0);
  assert.ok(w.logs.some((line) => /a model’s “done” their words didn’t ask for was left undone/.test(line)));
  assert.equal(await w.type('I’m done with that one'), 'Do you mean “Buy stamps”? Say which one and I’ll tick it off.');
  assert.equal(w.tasks.list().done.length, 0);
  w.reply = { say: 'Okay', do: '', new: false, task: { op: 'done', text: 'email sarah' } };
  assert.equal(await w.type('I emailed Sarah'), 'Ticked off: Email Sarah.');
  assert.deepEqual(w.texts(), ['Buy stamps']);
  // He says one's removed and sets nothing: their words ask for that of it, so it goes.
  w.tasks.add({ text: 'Renew passport' });
  w.reply = { say: 'Got it, I’ve removed that from your list.', do: '', new: false };
  assert.equal(await w.type('take the passport one off my list'), 'Removed from your list: Renew passport.');
  assert.equal(await w.type('what is a passport for?'), 'Got it, I’ve removed that from your list.', 'a question takes nothing off');
  assert.deepEqual(w.texts(), ['Buy stamps']);
  // He says it's done and sets nothing: their own words name it, so it's ticked, and said from the list.
  w.reply = { say: 'Nice, that’s off your list.', do: '', new: false };
  assert.equal(await w.type('I bought the stamps'), 'Ticked off: Buy stamps.');
  w.tasks.add({ text: 'Water the plants' });
  assert.equal(await w.type('I finished my essay'), 'Nice, that’s off your list.', 'nothing of theirs to tick: his words stand');
  assert.deepEqual(w.texts(), ['Water the plants']);
});

test('conversation: the same reminder handed to the laptop as well is done once, by him', async () => {
  const w = talking({ reply: { say: 'On it.', do: 'open Reminders and add call mom at 3', new: false, task: { op: 'add', text: 'call your mom', in: 30 } } });
  assert.equal(await w.type('remind me in half an hour to call my mom'), 'Okay, I’ll remind you at 3:00 PM: Call your mom.');
  assert.deepEqual(w.ran, []);
});

test('the Tasks panel: where it sits, what’s left of a timer, and which heading a task goes under', () => {
  assert.equal(placeOf('tasks'), -1);
  assert.equal(backOf('tasks'), 'main');
  assert.equal(direction('main', 'tasks'), -1, 'it comes in from the left, as Chats does');
  assert.equal(countdown(200_000), '3:20');
  assert.equal(countdown(3_909_000), '1:05:09');
  assert.equal(countdown(400), '0:01');
  assert.equal(countdown(-5), '0:00');
  const now = at(14, 30);
  assert.equal(groupOf({}, now), 'No date');
  assert.equal(groupOf({ due: at(9), overdue: true }, now), 'Overdue');
  assert.equal(groupOf({ due: at(15) }, now), 'Today');
  assert.equal(groupOf({ due: at(9, 0, 16) }, now), 'Tomorrow');
  assert.equal(groupOf({ due: at(0, 0, 20) }, now), 'Later');
});

// What a review of the above found (2026-11-15), each one a way it went wrong.

test('review: a sentence that only mentions a timer, denies one or asks for more isn’t the clock’s to act on', () => {
  for (const no of ['don’t set a timer for ten minutes', 'did you set a timer for ten minutes?', 'I don’t need a ten minute timer', 'my oven has a 10 minute timer', 'text mom that I set a timer for ten minutes', 'the 5 minute timer', 'start a second timer', 'set a timer for 45 minutes to an hour', 'what timer for ten minutes'])
    assert.equal(timerAsked(no), null, no);
  assert.deepEqual(timerAsked('set a 1.5 hour timer'), { ms: 90 * MIN, name: '' });
  assert.deepEqual(timerAsked('Okay Jester, could you set a timer for 2.5 minutes, please.'), { ms: 150_000, name: '' });
  assert.deepEqual(timerAsked('set a second timer for 3 minutes'), { ms: 3 * MIN, name: '' });
  const w = book();
  w.tasks.direct('set a timer for 30 minutes');
  for (const said of ['stop the music and set a timer for 5 minutes', 'don’t stop the timer', 'remind me to stop by the store when the timer ends', 'stop the Toggl timer', 'stop the music when the timer goes off', 'how long should I set the timer for pasta', 'how much is a kitchen timer on Amazon'])
    assert.equal(w.tasks.direct(said), '', said);
  assert.equal(w.tasks.list().timers.length, 1, 'and the one running is still running');
  assert.equal(timerCancelAsked('cancel my 3pm reminder'), null);
  assert.equal(timerLeftAsked('how long is the flight'), null);
});

test('review: two timers are told apart by their lengths, and "Which one?" is answered by a name', () => {
  const w = book();
  w.tasks.direct('set a timer for 5 minutes');
  w.tasks.direct('set a timer for 8 minutes');
  assert.match(w.tasks.direct('cancel the timer'), /Which one\?$/);
  assert.equal(w.tasks.direct('the 5 minute timer'), 'Cancelled, with 5 minutes left.', 'not a third timer');
  assert.equal(w.tasks.list().timers.length, 1);
  w.tasks.direct('set a timer for ten minutes');
  w.tasks.direct('set a timer for twenty minutes');
  assert.equal(w.tasks.direct('cancel the ten minute timer'), 'Cancelled, with 10 minutes left.');
  assert.equal(w.tasks.direct('how long is left on the twenty minute timer?'), '20 minutes left on your 20 minute timer.');
  assert.deepEqual(w.tasks.list().timers.map((timer) => timer.text), ['8 minute timer', '20 minute timer']);
});

test('review: what counts as asking for a task', () => {
  const { tasks } = book();
  for (const yes of ['tell me in 20 minutes to check the oven', 'let me know at 3 that I need to leave', 'alert me in ten minutes', 'remind me to call mom']) assert.ok(tasks.asked(yes), yes);
  assert.ok(tasks.asked('add call the dentist', '', 'add', 'call the dentist'));
  assert.ok(tasks.asked('buy stamps', 'What should I put on your list?'), 'the answer to his own question');
  assert.ok(tasks.asked('at six', 'That time has already gone by, so I haven’t set it. When should it be?'));
  assert.ok(tasks.asked('yes', 'That isn’t on your list yet: want me to add it?'));
  for (const no of ['what do I have to do today', 'I have so much to do this week', 'what’s on my to-do list?', 'add milk to my shopping list', 'how many tasks do I have']) assert.ok(!tasks.asked(no, '', 'add', 'milk'), no);
});

test('review: naming a task isn’t saying it’s done, gone or moved', () => {
  const w = book();
  w.tasks.add({ text: 'Call the dentist', due: at(16) });
  for (const said of ['I haven’t called the dentist yet', 'did I call the dentist yet?', 'I should really call the dentist at some point', 'I’ll call the dentist tomorrow'])
    assert.equal(w.tasks.apply({ op: 'done', text: 'dentist' }, { said }), '', said);
  assert.equal(w.tasks.apply({ op: 'remove', text: 'dentist' }, { said: 'what time does the dentist open' }), '');
  assert.equal(w.tasks.apply({ op: 'move', text: 'dentist', in: 60 }, { said: 'the dentist is nice' }), '');
  for (const said of ['did I call the dentist yet?', 'I still need to call the dentist', 'I haven’t called the dentist']) assert.equal(w.tasks.saidDone(said), '', said);
  assert.deepEqual(w.texts(), ['Call the dentist']);
  assert.equal(w.tasks.list().open[0].due, at(16));
});

test('review: after a reminder, only plain words are about it', () => {
  const w = book();
  const mom = w.tasks.add({ text: 'Call mom', due: at(15) });
  w.tasks.add({ text: 'Buy milk' });
  w.time = at(15);
  w.tasks.rang(mom.id);
  assert.match(w.tasks.apply({ op: 'done' }, { said: 'I’m done with the dishes', last: 'Reminder: call mom.' }), /^Do you mean “Call mom”\?/);
  assert.equal(w.tasks.apply({ op: 'move', in: 60 }, { said: 'what’s the weather tomorrow', last: 'Reminder: call mom.' }), '');
  assert.equal(w.tasks.apply({ op: 'remove' }, { said: 'never mind, forget the weather', last: 'It’s raining.' }), 'Do you mean “Call mom”? Say which one and I’ll take it off.');
  // He read the list out, and they said they knew: the model's pick from it isn't theirs.
  assert.match(w.tasks.apply({ op: 'done', text: 'buy milk' }, { said: 'okay I already knew that', last: 'You have call mom and buy milk on your list.' }), /^$|^Do you mean/);
  assert.equal(w.tasks.list().done.length, 0);
  assert.deepEqual(w.texts(), ['Call mom', 'Buy milk']);
  assert.equal(w.tasks.apply({ op: 'done' }, { said: 'okay, done', last: 'Reminder: call mom.' }), 'Ticked off: Call mom.');
});

test('review: his own questions can be answered', () => {
  const w = book();
  w.tasks.add({ text: 'Call the dentist', due: at(16) });
  w.tasks.add({ text: 'Buy stamps' });
  const when = w.tasks.apply({ op: 'move', text: 'dentist' }, { said: 'move the dentist reminder' });
  assert.equal(when, 'When should I remind you about “Call the dentist”?');
  assert.ok(w.tasks.wanted('at six'), 'the list goes with their answer');
  assert.equal(w.tasks.apply({ op: 'move', text: 'dentist', at: '2026-11-15 18:00' }, { said: 'at six', last: when }), 'Okay, I’ll remind you at 6:00 PM: Call the dentist.');
  const which = w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'that one’s done', last: 'It’s raining.' });
  assert.equal(which, 'Do you mean “Buy stamps”? Say which one and I’ll tick it off.');
  assert.equal(w.tasks.apply({ op: 'done', text: 'stamps' }, { said: 'yes', last: which }), 'Ticked off: Buy stamps.');
  assert.ok(w.tasks.wanted('I called the dentist'), 'words that name something on it bring the list');
  assert.ok(!book().tasks.wanted('I called the dentist'));
});

test('review: times as models write them, and as people mean them', () => {
  const now = at(14, 30);
  assert.deepEqual(whenOf({ at: '3pm' }, now), { due: at(15), allDay: false });
  assert.deepEqual(whenOf({ at: '2026-11-16 at 3pm' }, now), { due: at(15, 0, 16), allDay: false });
  assert.deepEqual(whenOf({ at: '2026-11-16, 3:00 PM' }, now), { due: at(15, 0, 16), allDay: false });
  for (const bad of [{ at: '2026-11-16 9:75' }, { at: '2026-02-30 10:00' }, { at: '2026-11-16 15:00 or so' }, { in: 1e15 }, { at: '2026-11-16 13pm' }]) assert.equal(whenOf(bad, now), null, JSON.stringify(bad));
  assert.deepEqual(whenAsked({ at: '3pm' }, 'remind me at 3 to call mom', '', now, 'call mom'), { due: at(15), allDay: false });
  // A time in what the task is isn't when it's for.
  assert.equal(whenAsked({ at: '2026-11-15 14:30' }, 'add buy a dinner gift to my to-do list', '', now, 'buy a dinner gift'), null);
  // They gave a time and the model's can't be read: asked for, not dropped.
  assert.equal(whenAsked({ at: 'three-ish' }, 'remind me at 3 to call mom', '', now, 'call mom'), 'unclear');
  assert.deepEqual(whenAsked({ at: '2026-11-25 10:00' }, 'remind me in ten days to renew it', '', now, 'renew it'), { due: at(0, 0, 25), allDay: true });
  // "In twenty minutes" is theirs, whatever a model made of it (qwen3.5:9b: 5:48 for 5:48 PM).
  assert.deepEqual(whenAsked({ at: '2026-11-15 5:48' }, 'remind me in twenty minutes to check the oven', '', at(17, 28), 'check the oven'), { due: at(17, 48), allDay: false });
  // "At 6" with no AM or PM, after six in the morning has gone: this evening.
  assert.deepEqual(whenAsked({ at: '2026-11-15 6:00' }, 'remind me at 6 to water the plants', '', now, 'water the plants'), { due: at(18), allDay: false });
  // Half past midnight on Monday the 16th: "tomorrow at 9" is nine this morning.
  assert.deepEqual(whenAsked({ at: '2026-11-17 09:00' }, 'remind me tomorrow at 9 to call the bank', '', at(0, 30, 16), 'call the bank'), { due: at(9, 0, 16), allDay: false });
  // "This Sunday", said on Sunday: today.
  assert.deepEqual(whenAsked({ at: '2026-11-15 20:00' }, 'remind me this sunday at 8 pm to call home', '', at(17, 15), 'call home'), { due: at(20), allDay: false });
  const w = book();
  assert.equal(w.tasks.apply({ op: 'add', text: 'call mom', at: 'three-ish' }, { said: 'remind me at 3 to call mom' }), 'When should it be for? I didn’t catch the time.');
  assert.deepEqual(w.texts(), []);
});

test('review: a clock with no room keeps nothing, and a task put back after its time doesn’t ring', () => {
  const w = book();
  w.clock.add = () => null;
  assert.equal(w.tasks.apply({ op: 'add', text: 'call mom', in: 10 }, { said: 'remind me in ten minutes to call mom' }), 'Your list is full, so I couldn’t add that.');
  assert.deepEqual(w.texts(), []);
  const v = book();
  const task = v.tasks.add({ text: 'Call mom', due: at(15) });
  v.tasks.done(task.id);
  v.time = at(16);
  v.tasks.done(task.id, false);
  assert.equal(v.jobs.size, 0);
  assert.equal(v.tasks.list().open[0].overdue, true);
});

test('review: refused, a task is offered rather than agreed to; and no first sentence claims one', async () => {
  const w = talking({ reply: { say: 'Okay', do: '', new: false, task: { op: 'add', text: 'learn to juggle' } } });
  assert.equal(await w.type('I wish I could juggle'), 'That isn’t on your list yet: want me to add it?');
  assert.deepEqual(w.texts(), []);
  assert.equal(await w.type('yes'), 'Added to your list: Learn to juggle.');
  // His question about one, answered in words that are no request on their own.
  w.reply = (request) => (request.text === 'buy stamps' ? { say: 'Okay', do: '', new: false, task: { op: 'add', text: 'buy stamps' } } : { say: 'Okay', do: '', new: false, task: { op: 'add' } });
  assert.equal(await w.type('add something to my to-do list'), 'What should I put on your list?');
  assert.equal(await w.type('buy stamps'), 'Added to your list: Buy stamps.');
});
