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

// Cards (2026-11-15): a timer, a reminder, a task or a note as a thing to look at and act on in his window.

test('cards: what each shows, and what can be done to it', async () => {
  const { cardView, shelfOf, SOON_MS } = await import('../desktop/src/home/cards.js');
  const now = at(14, 30);
  const state = {
    timers: [{ id: 't1', text: 'Pasta timer', due: now + 8 * MIN, timer: 8 * MIN }],
    open: [
      { id: 'r1', text: 'Call the dentist', due: at(15), when: 'at 3:00 PM' },
      { id: 'r2', text: 'Stretch', due: at(14), when: 'at 2:00 PM', told: at(14), overdue: true },
      { id: 'r3', text: 'Renew passport', due: at(9, 0, 18), when: 'on Wednesday at 9:00 AM' },
      { id: 'd1', text: 'Homework 5', due: at(0, 0, 20), allDay: true, when: 'on Friday' },
      { id: 'p1', text: 'Buy stamps' }
    ],
    done: [{ id: 'x1', text: 'Email Sarah', done: now }]
  };
  const view = (card) => cardView(card, state);
  assert.deepEqual(view({ kind: 'task', id: 't1' }), { label: 'Timer', title: 'Pasta timer', detail: '', icon: 'i-timer', tick: null, tone: '', actions: ['cancel'], due: now + 8 * MIN, span: 8 * MIN });
  assert.deepEqual(view({ kind: 'task', id: 'r1' }), { label: 'Reminder', title: 'Call the dentist', detail: 'At 3:00 PM', icon: 'i-bell', tick: false, tone: '', actions: ['done', 'remove'] });
  assert.deepEqual(view({ kind: 'task', id: 'r2' }), { label: 'Reminder', title: 'Stretch', detail: 'At 2:00 PM · reminded', icon: 'i-bell', tick: false, tone: 'due', actions: ['done', 'snooze', 'remove'] }, 'given and not ticked: it can be snoozed');
  assert.deepEqual(view({ kind: 'task', id: 'd1' }).actions, ['done', 'remove'], 'a day’s task has nothing to snooze');
  assert.equal(view({ kind: 'task', id: 'p1' }).label, 'To do');
  assert.deepEqual(view({ kind: 'task', id: 'x1' }), { label: 'Done', title: 'Email Sarah', detail: '', icon: 'i-tasks', tick: true, tone: 'done', actions: ['undo'] });
  // Gone from the list, a card says what it was, and offers nothing.
  assert.deepEqual(view({ kind: 'task', id: 'gone', type: 'timer', text: '10 minute timer' }), { label: 'Timer', title: '10 minute timer', detail: 'Finished', icon: 'i-timer', tick: null, tone: 'gone', actions: [], gone: true });
  assert.equal(view({ kind: 'task', id: 'gone', type: 'reminder', text: 'Call mom' }).detail, 'No longer on your list');
  assert.deepEqual(view({ kind: 'note', title: 'Trip ideas', rel: 'Notes/Trip ideas.md', snippet: 'the coast road' }), { label: 'Note', title: 'Trip ideas', detail: 'the coast road', icon: 'i-note', tick: null, tone: '', actions: ['open'] });
  assert.deepEqual(view({ kind: 'remembered', title: 'Locker combination', rel: 'Jester/Remembered/x.md' }).actions, ['open']);
  assert.equal(view({ kind: 'remembered', title: 'Locker combination', rel: 'x' }).detail, '', 'what was kept isn’t shown on its card');
  // The shelf: timers, what's been given and not ticked, and what's due within a few hours. Not next week's.
  assert.deepEqual(shelfOf(state, now).cards.map((card) => card.id), ['t1', 'r2', 'r1']);
  assert.equal(shelfOf(state, now).more, 0);
  const busy = { timers: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, text: `Timer ${i}`, due: now + MIN, timer: MIN })), open: [], done: [] };
  assert.deepEqual([shelfOf(busy, now).cards.length, shelfOf(busy, now).more], [4, 2]);
  assert.equal(shelfOf({}, now).cards.length, 0);
  assert.ok(SOON_MS >= 3600_000);
});

test('cards: a line in the chat carries the card of what it made, and the archive keeps it clean', async () => {
  const { cardOf } = await import('../desktop/src/main/chat-archive.js');
  assert.deepEqual(cardOf({ kind: 'task', id: 'abc', type: 'timer', text: 'Pasta timer', extra: 'no', nested: { x: 1 } }), { kind: 'task', id: 'abc', type: 'timer', text: 'Pasta timer' });
  assert.equal(cardOf({ kind: 'script', id: 'abc' }), null);
  assert.equal(cardOf(null), null);
  assert.equal(cardOf({ kind: 'note', title: 'x'.repeat(500) }).title.length, 120);
  // A conversation whose memory notes the cards it's handed.
  const { createConversation } = await import('../desktop/src/main/conversation.js');
  const book2 = book();
  const lines = [];
  const conversation = createConversation({
    chat: async () => ({ say: 'Okay', do: '', new: false, task: { op: 'add', text: 'call your mom', at: '2026-11-16 15:00' } }),
    speaker: { say: async () => undefined, stop: () => undefined },
    memory: { add: (who, text, more) => lines.push({ who, text, ...(more?.card ? { card: more.card } : {}) }), current: () => [...lines], idleFor: () => 0, startNew: () => lines.splice(0), clear: () => (lines.length = 0) },
    recollections: { keep: async () => '', relevant: () => [], forget: () => undefined },
    commands: { knows: async () => false, risky: () => false, run: async () => ({ ok: true, text: '' }) },
    assistant: { asking: false, running: false, cancel: () => undefined },
    show: () => undefined,
    tasks: book2.tasks,
    now: () => book2.time
  });
  await conversation.told('set a timer for ten minutes', { typed: true });
  await conversation.told('remind me to call my mom tomorrow at 3 pm', { typed: true });
  const [timer] = book2.tasks.list().timers;
  const [reminder] = book2.tasks.list().open;
  assert.deepEqual(lines.filter((line) => line.who === 'jester'), [
    { who: 'jester', text: '10 minutes, starting now.', card: { kind: 'task', id: timer.id, type: 'timer', text: '10 minute timer' } },
    { who: 'jester', text: 'Okay, I’ll remind you tomorrow at 3:00 PM: Call your mom.', card: { kind: 'task', id: reminder.id, type: 'reminder', text: 'Call your mom' } }
  ]);
  // Told when it's due, the line has its card too; and one that only answers has none.
  await conversation.announce('Reminder: call your mom.', { written: true, card: book2.tasks.cardFor(reminder.id) });
  assert.deepEqual(lines.at(-1).card, { kind: 'task', id: reminder.id, type: 'reminder', text: 'Call your mom' });
  await conversation.told('how long is left on the timer?', { typed: true });
  assert.equal(lines.at(-1).card, undefined);
  // Snoozed from its card: ten minutes from now, and it rings again.
  book2.tasks.rang(reminder.id);
  assert.equal(book2.tasks.snooze(reminder.id).due, book2.time + 10 * MIN);
  assert.equal(book2.jobs.get(`task-${reminder.id}`).at, book2.time + 10 * MIN);
  assert.equal(book2.tasks.snooze(timer.id), null, 'a timer isn’t snoozed');
});

// 2026-11-16, the user's own conversation: asked when he'd remind them of their first class, he said it had no time
// and to say when, "like an hour before". Three answers running, each of which Haiku rightly gave as a "move", were
// left undone by the list, and he said "Okay" to each.
const CLASS = 'Go to your first class, DS 435 at Westgate Building';
const MONDAY = new Date(2026, 10, 16, 0, 20).getTime();
const on16 = (h, m = 0, day = 16) => new Date(2026, 10, day, h, m).getTime();
/** The list as it stood: that one reminder, for today, with no time. Plus any others named. */
function classBook(...others) {
  const b = book({ start: MONDAY });
  b.tasks.apply({ op: 'add', text: CLASS, at: '2026-11-16' }, { said: 'remind me to go to my first class today' });
  for (const [text, at] of others) b.tasks.apply({ op: 'add', text, at }, { said: `remind me to ${text.toLowerCase()} at 3 pm` });
  return b;
}
const ASKED_WHEN = 'Your first class is DS 435 at Westgate Building, and it starts at 2:30 this afternoon. I haven’t set a time for the reminder yet, so tell me when you want it, like an hour before, and I’ll set it.';
const OFFERED_130 = 'Not yet, I still need the time. Your first class, DS 435 at Westgate Building, starts at 2:30 this afternoon, so do you want the reminder at 1:30 PM, an hour before?';

test('an answer to his question about a reminder’s time sets it: "an hour before the class", and "yeah, 1:30’s perfect"', () => {
  // Counted from the time his line gave, whatever the model made of it (here, the class's own time).
  const b = classBook();
  assert.equal(b.tasks.apply({ op: 'move', text: CLASS, at: '2026-11-16 14:30' }, { said: 'Set it for one hour before the class', last: ASKED_WHEN }), `Okay, I’ll remind you at 1:30 PM: ${CLASS}.`);
  assert.equal(b.tasks.list().open[0].due, on16(13, 30));
  assert.ok(!b.tasks.list().open[0].allDay);
  assert.ok(b.logs.includes('tasks: one moved'));
  // His offer of a time, and their saying it back, with the model naming no task at all.
  const c = classBook();
  assert.equal(c.tasks.apply({ op: 'move', at: '1:30 PM' }, { said: 'Yeah, one thirty p.m.’s perfect.', last: OFFERED_130 }), `Okay, I’ll remind you at 1:30 PM: ${CLASS}.`);
  // A plain yes to it is the time he offered, whatever the model gave.
  const y = classBook();
  assert.equal(y.tasks.apply({ op: 'move', text: CLASS, at: '1:00 PM' }, { said: 'Yes please.', last: OFFERED_130 }), `Okay, I’ll remind you at 1:30 PM: ${CLASS}.`);
  // And "an hour before" said back to an offer that already is the hour before isn't taken off it again.
  const e = classBook();
  assert.equal(e.tasks.apply({ op: 'move', text: CLASS, at: '1:30 PM' }, { said: 'Yeah, an hour before is perfect.', last: 'Do you want the reminder at 1:30 PM, an hour before your first class, DS 435 at Westgate Building?' }), `Okay, I’ll remind you at 1:30 PM: ${CLASS}.`);
  // Asked for politely is still asked for; and so is naming it by the words that tell it from the rest.
  const p = classBook(['Call the dentist', '2026-11-16 15:00']);
  assert.equal(p.tasks.apply({ op: 'move', text: CLASS, at: '1:30 PM' }, { said: 'Can you set it for one hour before the class?', last: ASKED_WHEN }), `Okay, I’ll remind you at 1:30 PM: ${CLASS}.`);
  assert.equal(p.tasks.apply({ op: 'move', text: CLASS, at: '1:15 PM' }, { said: 'move my first class reminder to 1:15 pm' }), `Okay, I’ll remind you at 1:15 PM: ${CLASS}.`);
  // To his own way of asking, when the list itself asks.
  const d = classBook();
  assert.equal(d.tasks.apply({ op: 'move', text: CLASS, at: '9:00 AM' }, { said: 'set it for nine a.m.', last: `Not yet: “${CLASS}” is on your list for today, with no time. Tell me when, and I’ll set it.` }), `Okay, I’ll remind you at 9:00 AM: ${CLASS}.`);
});

test('but only an answer to that: the same words elsewhere move nothing, and nor does a time that isn’t plain', () => {
  const dentist = ['Call the dentist', '2026-11-16 15:00'];
  const still = (b) => b.tasks.list().open.map((task) => [task.text, task.due, !!task.allDay]);
  // His saying one's set, or giving the reminder itself, asks nothing: what's said next isn't about its time.
  const a = classBook(dentist);
  const before = still(a);
  assert.equal(a.tasks.apply({ op: 'move', text: 'Call the dentist', at: '8:00 PM' }, { said: 'I think I will watch a movie tonight', last: 'Okay, I’ll remind you at 3:00 PM: Call the dentist.' }), '');
  assert.equal(a.tasks.apply({ op: 'move', text: 'Call the dentist', at: '2026-11-17' }, { said: 'Can you tell me the weather for tomorrow', last: 'Reminder: call the dentist.' }), '');
  // "Set" and "earlier" in a sentence of theirs aren't asking for a move.
  assert.equal(a.tasks.apply({ op: 'move', text: 'Call the dentist', at: '2026-11-20 14:00' }, { said: 'I set the dentist appointment for Friday at 2' }), '');
  assert.equal(a.tasks.apply({ op: 'move', text: 'Call the dentist', at: '2026-11-17' }, { said: 'The dentist said earlier is better, maybe tomorrow' }), '');
  // He asked, but named two: which one isn't theirs to guess. And a question back at him moves nothing.
  assert.equal(a.tasks.apply({ op: 'move', text: CLASS, at: '1:30 PM' }, { said: 'Yeah, one thirty’s perfect.', last: 'You have go to your first class, DS 435 at Westgate Building, and call the dentist. Tell me when you want them.' }), '');
  assert.equal(a.tasks.apply({ op: 'move', text: CLASS, at: '1:30 PM' }, { said: 'can you tell me what time the class is at again', last: ASKED_WHEN }), '');
  assert.deepEqual(still(a), before);

  // What "an hour before" is counted from has to be one plain time of his, for something else, on a plain day.
  const now = on16(9);
  const model = { at: '2026-11-16 13:30' };
  const fromModel = { due: on16(13, 30), allDay: false };
  const ask = (line) => `${line} Tell me when you want the reminder.`;
  assert.deepEqual(whenAsked(model, 'an hour before', ask('It starts at 2:30 this afternoon.'), now), fromModel);
  assert.deepEqual(whenAsked({ at: '2026-11-16 09:30' }, 'an hour before', ask('It starts at 2:30 this afternoon.'), now), fromModel, 'his time, not the model’s sum');
  // A range, a time that could be either half of the day, another day, a number that's no time: left to the model, as it was.
  for (const line of ['It runs from 2:30 to 3:45 PM.', 'DS 320 is 3:05-4:20pm.', 'It starts at 2:30.', 'It’s on November 18 at 2:30 PM.', 'It’s tomorrow at 2:30 PM, and nothing else is on today.', 'It will reach 15 this afternoon, and class is in room 9 tonight.'])
    assert.deepEqual(whenAsked(model, 'an hour before', ask(line), now), fromModel, line);
  assert.deepEqual(whenAsked({ at: '2026-11-17 13:30' }, 'an hour before, tomorrow', ask('It starts at 2:30 this afternoon.'), now), { due: on16(13, 30, 17), allDay: false }, 'a day of their own');
  // Not asked when: a time in whatever he last said is nothing to count from.
  assert.deepEqual(whenAsked(model, 'ten minutes before my meeting', 'It is 10:00 AM.', now), fromModel);
  assert.deepEqual(whenAsked({ at: '2026-11-16 16:45' }, 'ten minutes after I get home', ask('Class ends at 4:20 PM.'), now), { due: on16(16, 45), allDay: false });
  // As it always was: a time of their own, and "in ten minutes".
  assert.deepEqual(whenAsked({ at: '2:50 PM' }, 'remind me ten minutes before 3 pm to call mom', '', now, 'call mom'), { due: on16(14, 50), allDay: false });
  assert.deepEqual(whenAsked({ in: 10 }, 'remind me in ten minutes before I forget to call mom', '', now, 'call mom'), { due: now + 10 * MIN, allDay: false });
  assert.deepEqual(whenAsked({}, 'ten minutes after that', 'It ends at 4:20 PM. When do you want the reminder?', now), { due: on16(16, 30), allDay: false });
  assert.equal(whenAsked({}, 'an hour before', ask('It starts at 2:30 this afternoon.'), on16(14)), 'past');
});

test('timesIn: the times of day a line of his gives for certain, and which he offered for the reminder', async () => {
  const { anchorIn, timesIn } = await import('../desktop/src/main/tasks.js');
  const now = on16(9);
  assert.equal(anchorIn('It starts at 2:30 this afternoon.', now), on16(14, 30));
  assert.equal(anchorIn('DS 435 at Westgate Building is at 3 PM.', now), on16(15));
  assert.equal(anchorIn('Your dentist is at 9:15 a.m. tomorrow.', now), on16(9, 15, 17));
  assert.equal(anchorIn('Dinner is at 7 tonight.', now), on16(19));
  assert.equal(anchorIn('Lunch is at 12 PM and nothing else.', now), on16(12));
  assert.equal(anchorIn('It starts at 12:05 AM.', now), on16(0, 5));
  assert.equal(anchorIn('It starts at 14:30.', now), on16(14, 30));
  assert.equal(anchorIn('It starts at 2:30.', now), null, 'morning or afternoon, it doesn’t say');
  assert.equal(anchorIn('It runs from 3:05 PM to 4:20 PM.', now), null, 'two times');
  assert.equal(anchorIn('It runs from 2:30 to 3:45 PM.', now), null, 'a range whose start doesn’t say');
  assert.equal(anchorIn('You have 10 events, DS 435 is in room 12, and it will reach 15 this afternoon.', now), null);
  assert.equal(anchorIn('It’s on November 18 at 2:30 PM.', now), null, 'a day that isn’t today or tomorrow');
  assert.equal(anchorIn('', now), null);
  assert.deepEqual(timesIn(OFFERED_130, MONDAY).map((time) => [time.due, time.offered]), [[on16(14, 30), false], [on16(13, 30), true]]);
});

test('undone: what he says of a change that wasn’t made', () => {
  const c = classBook();
  assert.equal(c.tasks.undone({ op: 'move', text: CLASS }, { said: 'did you set a time for my reminder to go to my first class?' }), `Not yet: “${CLASS}” is on your list for today, with no time. Tell me when, and I’ll set it.`);
  assert.equal(c.tasks.undone({ op: 'move', text: CLASS }, { said: 'I was thinking about lunch' }), `I haven’t changed it: “${CLASS}” is on your list for today, with no time. Tell me when, and I’ll set it.`);
  // What he said isn't a question of his that anything would answer.
  assert.equal(c.tasks.asked('tell me a joke about lunch', c.tasks.undone({ op: 'move', text: CLASS }, { said: 'is it set?' }), 'add', 'tell a joke'), false);
  c.tasks.apply({ op: 'move', text: CLASS, at: '1:30 PM' }, { said: 'move my first class reminder to 1:30 pm' });
  assert.equal(c.tasks.undone({ op: 'move', text: CLASS }, { said: 'is the reminder time set.' }), `Yes, it’s set: I’ll remind you at 1:30 PM: ${CLASS}.`);
  assert.equal(c.tasks.undone({ op: 'remove', text: CLASS }, { said: 'did I cancel my first class reminder?' }), `It’s still on your list, as it was: I’ll remind you at 1:30 PM: ${CLASS}.`);
  assert.equal(c.tasks.undone({ op: 'move' }, { said: 'the weather is nice' }), 'I haven’t changed anything on your list.');
  const t = book();
  t.tasks.direct('set a pasta timer for 8 minutes');
  assert.equal(t.tasks.undone({ op: 'move', text: 'pasta timer' }, { said: 'is the pasta timer okay?' }), 'Your pasta timer has 8 minutes left: I haven’t changed it.');
});

test('conversation: the user’s own exchange about a reminder’s time, end to end', async () => {
  // As it went on 2026-11-16, with the model's replies as the log has them: a "move" each time, and "Okay".
  const text = CLASS;
  const w = talking({ reply: { say: 'Okay', do: '', new: false, task: { op: 'add', text, at: '2026-11-15' } } });
  assert.equal(await w.type('No, you’re good, but remind me to go to my first class today.'), `Added to your list for today: ${text}.`);
  w.reply = { say: 'Your first class is DS 435 at Westgate Building, and it starts at 4:30 this afternoon. I haven’t set a time for the reminder yet, so tell me when you want it, like an hour before, and I’ll set it.', do: '', new: false };
  await w.type('Okay, what time are you going to remind me about that?');
  w.reply = { say: 'Okay', do: '', new: false, task: { op: 'move', text, at: '2026-11-15 15:30' } };
  assert.equal(await w.type('Set it for one hour before the class'), `Okay, I’ll remind you at 3:30 PM: ${text}.`);
  assert.equal(w.tasks.list().open[0].due, at(15, 30));
  // Asked whether it's set, the model gives another "move" and "Okay": nothing's moved, and he answers.
  assert.equal(await w.type('is the reminder time set.'), `Yes, it’s set: I’ll remind you at 3:30 PM: ${text}.`);
  assert.ok(w.clog.includes('he agreed to a change to the list that wasn’t made: said how it stands instead'));
  assert.equal(w.tasks.list().open[0].due, at(15, 30));
  // He says he'll set it, and the list wouldn't: never left as said.
  w.reply = { say: 'Okay, I’ll set your reminder for 5:00 this afternoon, for your first class.', do: '', new: false, task: { op: 'move', text, at: '5:00 PM' } };
  assert.equal(await w.type('hmm, what do you think about the weather'), `It’s still on your list, as it was: I’ll remind you at 3:30 PM: ${text}.`);
  // A real answer of his own to a question, with a stray "move" beside it, is still his answer.
  w.reply = { say: 'It’s the one for your first class, at half past three.', do: '', new: false, task: { op: 'move', text, at: '3:30 PM' } };
  assert.equal(await w.type('which reminder is that again?'), 'It’s the one for your first class, at half past three.');
});
