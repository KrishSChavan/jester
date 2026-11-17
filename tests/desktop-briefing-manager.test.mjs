import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingRequest, createBriefingManager, BRIEFING_KEY, BRIEFING_LATER_MS, BRIEFING_KEEP_MS } from '../desktop/src/main/briefing-manager.js';

const at = (hour, minute = 0, day = 17) => new Date(2026, 10, day, hour, minute).getTime();
const next = () => new Promise((resolve) => setImmediate(resolve));
function rig({ custom, compose, history = [], saved = {} } = {}) {
  let time = at(12), serial = 0;
  const state = structuredClone(saved), changes = [], given = [], calls = [];
  const storage = { get: async (key) => ({ [key]: structuredClone(state[key]) }), set: async (value) => Object.assign(state, structuredClone(value)), remove: async (key) => { delete state[key]; } };
  const manager = createBriefingManager({ storage, now: () => time, newId: () => `brief-${++serial}`, history: () => history,
    compose: async (kind, options) => { calls.push({ kind, ...options }); return compose ? compose(kind, options) : { text: `${kind} facts.`, plain: 'Plain facts.', card: { title: `Your ${kind} briefing`, lines: ['A recorded fact.'] }, mailIds: ['abcdef123456'], untrusted: true }; },
    composeCustom: async (options) => { calls.push(options); return custom ? custom(options) : { text: 'Your recorded updates.', card: { title: 'Your updates', lines: [options.rangeLabel] }, untrusted: true }; },
    onChange: () => changes.push(true), given: async (...args) => given.push(args) });
  return { manager, state, storage, changes, given, calls, advance: (ms) => (time += ms), now: () => time };
}

test('direct briefing requests distinguish replay, topical creation and explicit ranges', () => {
  assert.deepEqual(briefingRequest('Read my evening briefing.'), { kind: 'evening', topic: '', range: 'since-last', refresh: false });
  assert.equal(briefingRequest('Jester, brief me please').kind, 'morning');
  assert.equal(briefingRequest('what’s my morning brief?').kind, 'morning');
  assert.equal(briefingRequest('wrap up my day').kind, 'evening');
  assert.deepEqual(briefingRequest('Create a briefing about Canvas since the last time we talked'), { kind: 'custom', topic: 'Canvas', range: 'since-last', refresh: true });
  assert.deepEqual(briefingRequest('Give me a news briefing for today so far'), { kind: 'custom', topic: 'news', range: 'today', refresh: false, date: 'today' });
  assert.equal(briefingRequest('Read yesterday’s morning briefing').date, 'yesterday');
  assert.equal(briefingRequest('Read my evening briefing for 2026-11-16').date, '2026-11-16');
  assert.equal(briefingRequest('Update my email briefing').refresh, true);
  for (const text of ['remind me to read my briefing at 6', 'send my briefing to Sam', 'open my briefing document', 'remember the briefing is at noon', 'briefly explain recursion', 'How do I create a briefing?', "Don't read my morning briefing"]) assert.equal(briefingRequest(text), null, text);
  // "Brief" the adjective is never a briefing.
  for (const text of ['Make it brief please', 'keep it brief', 'make that brief', 'Tell me a brief history of Rome', 'Give me a brief summary of this article', "I'd like a brief break", "What's the brief for the essay"]) assert.equal(briefingRequest(text), null, text);
  assert.deepEqual(briefingRequest('create a brief on Canvas'), { kind: 'custom', topic: 'Canvas', range: 'since-last', refresh: true });
  assert.equal(briefingRequest('give me the brief').latest, true);
  assert.equal(briefingRequest('read my briefing').latest, true);
  assert.equal(briefingRequest('Create a briefing').latest, undefined);
});

test('preparing and offering never marks a briefing or its mail as read', async () => {
  const j = rig(); await j.manager.start();
  const made = await j.manager.prepare('morning');
  assert.equal(made.status, 'ready');
  assert.equal(j.manager.pending(), null);
  const offered = await j.manager.offer(made.id);
  assert.equal(offered.status, 'offered');
  assert.equal(j.manager.pending().id, made.id);
  assert.equal(j.manager.card(offered).offer, true);
  assert.deepEqual(j.given, []);
  assert.equal(j.state[BRIEFING_KEY].records[0].status, 'offered');
  const reading = await j.manager.respond(made.id, 'read');
  assert.equal(reading.record.status, 'reading');
  assert.equal(j.manager.pending(), null);
  assert.deepEqual(j.given, []);
  assert.equal((await j.manager.respond(made.id, 'read')).ok, false);
  await j.manager.respond(made.id, 'read-complete', { token: reading.record.readToken });
  assert.equal(j.given.length, 1);
  assert.equal(j.given[0][0], 'morning');
  assert.deepEqual(j.given[0][1].mailIds, ['abcdef123456']);
  await j.manager.respond(made.id, 'read-complete');
  assert.equal(j.given.length, 1, 'A duplicate completion cannot mark it given twice.');
});

test('interrupted reading can be replayed, and stale completion cannot finish a newer reading', async () => {
  const j = rig(); const made = await j.manager.prepare('evening');
  const first = await j.manager.respond(made.id, 'read');
  await j.manager.respond(made.id, 'interrupted', { token: first.record.readToken });
  assert.equal(j.manager.get(made.id).status, 'ready');
  assert.deepEqual(j.given, []);
  const second = await j.manager.respond(made.id, 'read');
  assert.notEqual(second.record.readToken, first.record.readToken);
  assert.equal((await j.manager.respond(made.id, 'read-complete', { token: first.record.readToken })).ok, false);
  assert.equal(j.manager.get(made.id).status, 'reading');
  await j.manager.respond(made.id, 'read-complete', { token: second.record.readToken });
  assert.equal(j.given.length, 1);
});

test('Later persists ten minutes and Dismiss suppresses scheduled reoffers without marking read', async () => {
  const j = rig(); const made = await j.manager.prepare('morning');
  await j.manager.offer(made.id);
  const later = await j.manager.respond(made.id, 'later');
  assert.equal(later.record.laterUntil, j.now() + BRIEFING_LATER_MS);
  assert.equal(j.manager.pending(), null);
  assert.equal((await j.manager.offer(made.id)).status, 'later');
  j.advance(BRIEFING_LATER_MS);
  assert.equal((await j.manager.offer(made.id)).status, 'offered');
  await j.manager.respond(made.id, 'dismiss');
  assert.equal((await j.manager.prepare('morning')).id, made.id);
  assert.equal((await j.manager.offer(made.id)).status, 'dismissed');
  assert.equal(j.calls.length, 1);
  assert.deepEqual(j.given, []);
  assert.equal((await j.manager.respond(made.id, 'read')).record.status, 'reading', 'An explicit replay remains available.');
});

test('a saved briefing replays without fetching again unless the user requests an update', async () => {
  const j = rig(); const request = briefingRequest('Read my Canvas briefing');
  const first = await j.manager.requested(request);
  j.advance(60_000);
  assert.equal((await j.manager.requested(request)).id, first.id);
  assert.equal(j.calls.length, 1);
  const updated = await j.manager.requested(briefingRequest('Update my Canvas briefing'));
  assert.notEqual(updated.id, first.id);
  assert.equal(j.calls.length, 2);
  assert.equal(j.manager.list().length, 2);
  assert.equal(j.manager.get(first.id).text, first.text, 'Updating does not rewrite the saved snapshot.');
});

test('since-last starts after the previous conversation, excludes the current request, and keeps authoritative times', async () => {
  const history = [
    { chat: 'old', at: new Date(at(9)).toISOString(), who: 'you', text: 'My exam is Friday.' },
    { chat: 'old', at: new Date(at(9, 2)).toISOString(), who: 'jester', text: 'Noted.' },
    { chat: 'current', at: new Date(at(11, 50)).toISOString(), who: 'you', text: 'Hi again.' },
    { chat: 'current', at: new Date(at(12)).toISOString(), who: 'you', text: 'Create a briefing.' }
  ];
  const j = rig({ history });
  const made = await j.manager.requested(briefingRequest('Create a briefing'));
  assert.equal(made.range.from, at(9, 2));
  assert.equal(made.range.to, at(12));
  assert.match(made.range.label, /Since our last conversation/);
  assert.equal(j.calls[0].from, at(9, 2));
  assert.equal(j.calls[0].to, at(12));
  assert.equal(j.calls[0].history.some((entry) => entry.chat === 'current'), false);
});

test('today-so-far and the no-history fallback describe their actual coverage', async () => {
  const j = rig();
  const fallback = await j.manager.requested(briefingRequest('Create a briefing'));
  assert.equal(fallback.range.from, at(0));
  assert.equal(fallback.range.fallback, true);
  assert.match(fallback.range.label, /no earlier conversation was available/);
  const today = await j.manager.requested(briefingRequest('Create a briefing for the whole day so far'));
  assert.equal(today.range.from, at(0));
  assert.equal(today.range.to, at(12));
  assert.equal(today.range.mode, 'today');
  assert.equal(today.range.label, 'Today so far');
});

test('unsolicited announcements do not move the previous-conversation boundary', async () => {
  const j = rig({ history: [
    { chat: 'conversation', at: new Date(at(8)).toISOString(), who: 'you', text: 'Good morning.' },
    { chat: 'conversation', at: new Date(at(8, 2)).toISOString(), who: 'jester', text: 'Morning.' },
    { chat: 'automatic', at: new Date(at(10)).toISOString(), who: 'jester', text: 'Your timer is up.' },
    { chat: 'current', at: new Date(at(12)).toISOString(), who: 'you', text: 'Create a briefing.' }
  ] });
  const made = await j.manager.requested(briefingRequest('Create a briefing'));
  assert.equal(made.range.from, at(8, 2));
  assert.equal(made.range.fallback, undefined);
});

test('historical scheduled replay uses the saved snapshot and never substitutes today’s facts', async () => {
  const archive = rig();
  archive.advance(-24 * 3600_000);
  const original = await archive.manager.prepare('morning');
  archive.advance(24 * 3600_000);
  assert.equal((await archive.manager.requested(briefingRequest('Read yesterday’s morning briefing'))).id, original.id);
  assert.equal(archive.calls.length, 1);
  const j = rig();
  const missing = await j.manager.requested(briefingRequest('Read yesterday’s morning briefing'));
  assert.equal(missing.missing, true);
  assert.match(missing.text, /don't have a saved morning briefing for November 16/);
  assert.equal(j.calls.length, 0);
  // Said, and never kept: it isn't a briefing, and it can't stand in for today's.
  assert.equal(missing.id, '');
  assert.deepEqual(j.manager.list(), []);
  assert.deepEqual(j.given, []);
  await assert.rejects(j.manager.requested({ kind: 'morning', date: '2026-02-30' }), /not valid/);
  await assert.rejects(j.manager.requested({ kind: 'custom', date: '2099-01-01' }), /not happened/);
});

test('a named saved custom briefing replays its original range even when the read request omits it', async () => {
  const j = rig();
  const made = await j.manager.requested(briefingRequest('Create a Canvas briefing for today so far'));
  assert.equal(made.range.mode, 'today');
  assert.equal((await j.manager.requested(briefingRequest('Read my Canvas briefing'))).id, made.id);
  j.advance(24 * 3600_000);
  assert.equal((await j.manager.requested(briefingRequest('Read yesterday’s Canvas briefing'))).id, made.id);
  assert.equal(j.calls.length, 1);
});

test('briefing items preserve authoritative actions and drop unsafe links or secret content', async () => {
  const j = rig({ custom: async () => ({ text: 'Recorded facts.', items: [
    { kind: 'event', id: 'event-1', title: 'Lecture', detail: 'At noon', url: 'https://school.instructure.com/courses/12', start: at(12), source: 'Canvas' },
    { kind: 'mail', title: 'Exam update', mailId: 'abcdef123456', source: 'Gmail' },
    { kind: 'task', title: 'Read chapter', taskId: 'task-local' },
    { kind: 'page', title: 'Unsafe script', url: 'javascript:alert(1)' },
    { kind: 'page', title: 'Private URL', url: 'https://example.com/?token=private' },
    { kind: 'event', title: 'Private calendar feed', url: 'https://calendar.google.com/calendar/ical/private/basic.ics' },
    { kind: 'activity', title: 'password is correcthorsebatterystaple' }
  ] }) });
  const made = await j.manager.requested(briefingRequest('Create a Canvas briefing'));
  assert.equal(made.items.length, 6);
  assert.equal(made.items[0].url, 'https://school.instructure.com/courses/12');
  assert.equal(made.items[1].mailId, 'abcdef123456');
  assert.equal(made.items[2].taskId, 'task-local');
  assert.ok(made.items.every((item) => item.id));
  assert.ok(made.items.slice(3).every((item) => !item.url));
  assert.deepEqual(j.manager.card(made).items, made.items);
  const copy = j.manager.get(made.id); copy.items[0].title = 'Tampered';
  assert.equal(j.manager.get(made.id).items[0].title, 'Lecture');
});

test('saved state restores offers but makes interrupted playback ready instead of speaking on startup', async () => {
  const j = rig(); const made = await j.manager.prepare('morning');
  await j.manager.offer(made.id);
  const restored = rig({ saved: j.state }); await restored.manager.start();
  assert.equal(restored.manager.pending().id, made.id);
  await j.manager.respond(made.id, 'read');
  const stopped = rig({ saved: j.state }); await stopped.manager.start();
  assert.equal(stopped.manager.get(made.id).status, 'ready');
  assert.equal(stopped.manager.pending(), null);
  assert.deepEqual(stopped.given, []);
});

test('cancellation and Forget suppress late composition without saving it', async () => {
  for (const forget of [false, true]) {
    let release;
    const j = rig({ custom: () => new Promise((resolve) => { release = resolve; }) });
    const controller = new AbortController();
    const pending = j.manager.requested(briefingRequest('Create a news briefing'), { signal: controller.signal });
    await next();
    if (forget) await j.manager.forgetAll(); else controller.abort();
    release({ text: 'Late facts.' });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(j.manager.list(), []);
    assert.equal(j.state[BRIEFING_KEY]?.records.length || 0, 0);
  }
});

test('Forget wins over a delayed storage write and suppresses its completion callback', async () => {
  const j = rig(); const made = await j.manager.prepare('morning');
  const reading = await j.manager.respond(made.id, 'read');
  const write = j.storage.set;
  let release;
  j.storage.set = async (value) => { await new Promise((resolve) => { release = resolve; }); await write(value); };
  const completed = j.manager.respond(made.id, 'read-complete', { token: reading.record.readToken });
  await next();
  const forgotten = j.manager.forgetAll();
  release();
  assert.equal((await completed).ok, false);
  await forgotten;
  assert.equal(j.state[BRIEFING_KEY], undefined);
  assert.deepEqual(j.manager.list(), []);
  assert.deepEqual(j.given, []);
});

test('simultaneous preparations share composition and saved snapshots have a bounded retention window', async () => {
  let release;
  const j = rig({ compose: () => new Promise((resolve) => { release = resolve; }) });
  const one = j.manager.prepare('morning'), two = j.manager.prepare('morning');
  await next(); release({ text: 'Facts.' });
  assert.equal((await one).id, (await two).id);
  assert.equal(j.calls.length, 1);
  j.advance(BRIEFING_KEEP_MS + 1);
  assert.deepEqual(j.manager.list(), []);
});

test('nothing to say, or the weather not in yet, is given back to be tried again and never kept or shelved', async () => {
  let reply = { text: '', unready: true };
  const j = rig({ compose: async () => reply });
  const first = await j.manager.prepare('morning');
  assert.equal(first.id, '');
  assert.equal(first.text, '');
  assert.equal(first.unready, true);
  assert.deepEqual(j.manager.list(), []);
  reply = { text: 'Sunny, and a lecture at ten.' };
  const second = await j.manager.prepare('morning');
  assert.ok(second.id);
  assert.equal(j.calls.length, 2, 'tried again');
  assert.equal(j.manager.list().length, 1);
});

test('a secret loses only its own sentence, never the whole briefing', async () => {
  const j = rig({ compose: async () => ({ text: 'Morning. Your lecture is at ten. The Zoom passcode is 482913. Lunch with Sam at one.', lines: ['Lecture at ten.', 'Zoom passcode 482913.'] }) });
  const made = await j.manager.prepare('morning');
  assert.equal(made.text, 'Morning. Your lecture is at ten. Lunch with Sam at one.');
  assert.deepEqual(made.lines, ['Lecture at ten.']);
});

test('"read my briefing" is today’s latest of the day’s two (the evening’s at night), before any new one is made', async () => {
  const j = rig();
  const morning = await j.manager.prepare('morning');
  assert.equal((await j.manager.requested(briefingRequest('read my briefing'))).id, morning.id);
  j.advance(9 * 3600_000);
  const evening = await j.manager.prepare('evening');
  assert.equal((await j.manager.requested(briefingRequest('the briefing'))).id, evening.id);
  assert.equal(j.calls.length, 2, 'nothing composed for the asking');
  // Nothing saved today: "give me my briefing" makes one since the last conversation, as before.
  const fresh = rig();
  const made = await fresh.manager.requested(briefingRequest('give me my briefing'));
  assert.equal(made.kind, 'custom');
});

test('an update replaces the one before it: off the shelf, never offered again, and its later job named for removal', async () => {
  const j = rig();
  const old = await j.manager.prepare('morning');
  await j.manager.offer(old.id);
  await j.manager.respond(old.id, 'later');
  const updated = await j.manager.requested(briefingRequest('Update my morning briefing'));
  assert.notEqual(updated.id, old.id);
  assert.deepEqual(updated.replaced, [old.id]);
  assert.equal(j.manager.get(old.id).status, 'replaced');
  assert.equal((await j.manager.offer(old.id)).status, 'replaced');
  assert.equal(j.manager.card(j.manager.get(old.id)).offer, false);
  assert.equal(j.manager.get(updated.id).replaced, undefined, 'only the answer names what it replaced');
  assert.equal((await j.manager.respond(old.id, 'read')).record.status, 'reading', 'still there to read');
});

test('Later and Dismiss only where they make sense: never mid-reading, and no Later on what’s read, dismissed or replaced', async () => {
  const j = rig();
  const made = await j.manager.prepare('morning');
  const reading = await j.manager.respond(made.id, 'read');
  assert.equal((await j.manager.respond(made.id, 'later')).ok, false);
  assert.equal((await j.manager.respond(made.id, 'dismiss')).ok, false);
  await j.manager.respond(made.id, 'read-complete', { token: reading.record.readToken });
  assert.equal(j.given.length, 1, 'the reading still counts');
  assert.equal((await j.manager.respond(made.id, 'later')).ok, false);
  assert.equal((await j.manager.respond(made.id, 'dismiss')).ok, true);
  assert.equal((await j.manager.respond(made.id, 'later')).ok, false);
});

test('cards carry their day, for a shelf of today’s only', async () => {
  const j = rig();
  const made = await j.manager.prepare('morning');
  assert.equal(j.manager.card(made).day, '2026-11-17');
});
