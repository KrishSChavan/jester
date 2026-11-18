// 2026-11-18: work he offers to do and does on a yes, as Claude Duet does (offers.js), at the end of a brief, with new
// mail and before a call; answered by voice, typed, or on its card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefs, strays } from '../desktop/src/main/briefs.js';
import { createConversation } from '../desktop/src/main/conversation.js';
import { BARE_ANSWER, callOffer, createOfferRunner, createOffers, draftOffer, eventKey, ideaOffers, meetingLink, MOST_ASKS, nextSlot, offerAsked, offerCandidates, offerReply, offersLine, openerLine, pageLink } from '../desktop/src/main/offers.js';
import { offerRows } from '../desktop/src/home/cards.js';

const at = (h, m = 0, day = 16) => new Date(2026, 10, day, h, m).getTime();
const MIN = 60_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const morning = (more = {}) => ({
  kind: 'morning', at: at(8, 42),
  events: [], due: [{ key: 'k-hw6', uid: 'hw6', title: 'Homework 6', start: at(0), end: at(0, 0, 17), allDay: true, url: 'https://psu.instructure.com/courses/1/assignments/6' }],
  mail: [{ id: 'm1', thread: '18f3a2b4c5d6e7f8', from: 'Sam Lee', subject: 'Lab 3 partners', at: at(7), person: true }],
  tasks: { overdue: [{ id: 't1', text: 'Call the dentist', due: at(9, 0, 15) }], given: [], today: [], loose: 0, looseItems: [] },
  ...more
});

test('by rule from the day: a reply to someone who wrote, what’s due with its page, and what’s overdue moved', () => {
  const offers = offerCandidates(morning(), { chrome: true });
  assert.deepEqual(offers.map((offer) => offer.kind), ['draft', 'open', 'move']);
  const [draft, open, move] = offers;
  assert.equal(draft.ask, 'draft a reply to Sam Lee');
  assert.equal(draft.assure, 'I won’t send it.');
  assert.match(draft.action.command, /^Open https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/18f3a2b4c5d6e7f8 in Gmail/);
  assert.doesNotMatch(draft.action.command, /Lab 3 partners/, 'the mail’s own words stay out of the command');
  assert.equal(open.ask, 'open Homework 6');
  assert.deepEqual(open.action, { type: 'open-event', event: { key: 'k-hw6', start: at(0), title: 'Homework 6' } });
  assert.ok(!JSON.stringify(open).includes('instructure'), 'no link is kept with an offer');
  assert.equal(move.ask, 'move “Call the dentist” to 12:00 PM');
  assert.deepEqual(move.action.moves, [{ taskId: 't1', due: at(12) }]);
  // No linked Chrome, a service writing, or no page to open: none of those.
  assert.deepEqual(offerCandidates(morning(), { chrome: false }).map((offer) => offer.kind), ['open', 'move']);
  assert.deepEqual(offerCandidates(morning({ mail: [{ ...morning().mail[0], from: 'Canvas Notifications' }] }), { chrome: true }).map((offer) => offer.kind), ['open', 'move']);
  assert.deepEqual(offerCandidates(morning({ mail: [{ ...morning().mail[0], person: false }] }), { chrome: true }).map((offer) => offer.kind), ['open', 'move']);
  assert.deepEqual(offerCandidates(morning({ due: [{ title: 'Quiz', start: at(0), allDay: true, url: 'https://cal.example/feeds/abc.ics' }] })).map((offer) => offer.kind), ['move']);
  // Something with no time that's overdue is moved to today, for the day.
  const loose = offerCandidates(morning({ due: [], tasks: { overdue: [{ id: 't2', text: 'Buy stamps', due: at(0, 0, 15), allDay: true }], given: [], today: [] } }));
  assert.deepEqual(loose[0].action.moves, [{ taskId: 't2', due: at(0), allDay: true }]);
  assert.equal(loose[0].ask, 'move “Buy stamps” to today');
});

test('the evening’s: what’s still open, carried to tomorrow at the same time', () => {
  const facts = { kind: 'evening', at: at(21), tomorrow: at(0, 0, 17), open: [{ id: 'a', text: 'Call the dentist', due: at(15) }, { id: 'b', text: 'Read chapter 4', due: at(0), allDay: true }] };
  const [carry] = offerCandidates(facts);
  assert.equal(carry.ask, 'move the two still open to tomorrow');
  assert.deepEqual(carry.action.moves, [{ taskId: 'a', due: at(15, 0, 17) }, { taskId: 'b', due: at(0, 0, 17), allDay: true }]);
  assert.equal(offerCandidates({ ...facts, open: facts.open.slice(0, 1) })[0].ask, 'move “Call the dentist” to tomorrow');
  assert.deepEqual(offerCandidates({ ...facts, open: [] }), []);
});

test('the next sensible time: noon, five or eight, an hour off at least; else nine tomorrow', () => {
  assert.equal(nextSlot(at(8)), at(12));
  assert.equal(nextSlot(at(11, 30)), at(17));
  assert.equal(nextSlot(at(16, 30)), at(20));
  assert.equal(nextSlot(at(19, 30)), at(9, 0, 17));
});

test('links: a call’s from its place, a page never a feed', () => {
  assert.equal(meetingLink({ place: 'Join: https://psu.zoom.us/j/845123?pwd=abc. Room 2' }), 'https://psu.zoom.us/j/845123?pwd=abc');
  assert.equal(meetingLink({ place: 'Westgate E201', url: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
  assert.equal(meetingLink({ place: 'http://zoom.us/j/1' }), '', 'only https');
  assert.equal(pageLink({ url: 'https://psu.instructure.com/feeds/calendars/user_x.ics' }), '');
  assert.equal(pageLink({ url: 'https://psu.instructure.com/courses/1/assignments/6' }), 'https://psu.instructure.com/courses/1/assignments/6');
  const call = callOffer({ title: 'Standup', start: at(10), key: 'k1', call: true }, at(9, 45));
  assert.equal(call.ask, 'open the call');
  assert.deepEqual(call.action.event, { key: 'k1', start: at(10), title: 'Standup', call: true });
  assert.equal(callOffer({ title: 'Lecture', start: at(10), place: 'Westgate' }), null);
});

test('what he says: one, two or three, and with new mail just the question', () => {
  const a = { id: 'a', ask: 'open Homework 6' };
  const b = { id: 'b', ask: 'move “Call the dentist” to 12:00 PM' };
  const c = { id: 'c', ask: 'draft a reply to Sam Lee', assure: 'I won’t send it.' };
  assert.equal(offersLine([a]), 'One thing I could do: open Homework 6. Want me to?');
  assert.equal(offersLine([a, b]), 'Two things I could do: open Homework 6, and move “Call the dentist” to 12:00 PM. Want me to do both?');
  assert.equal(offersLine([c, a, b]), 'Three things I could do: draft a reply to Sam Lee; open Homework 6; and move “Call the dentist” to 12:00 PM. Which should I do? I won’t send anything.');
  assert.equal(offersLine([c], { inline: true }), 'Want me to draft a reply to Sam Lee? I won’t send it.');
  assert.equal(offersLine([]), '');
  assert.equal(openerLine({ kind: 'morning', count: 3, offers: 2, at: at(8) }), 'Good morning. Your brief’s ready: three things today, and two I could do for you. Want me to read it?');
  assert.equal(openerLine({ kind: 'morning', count: 1, offers: 0, at: at(13) }), 'Good afternoon. Your brief’s ready: one thing today. Want me to read it?');
  assert.equal(openerLine({ kind: 'morning', count: 0, at: at(8) }), 'Good morning. Your brief’s ready: a quiet day. Want me to read it?');
  assert.equal(openerLine({ kind: 'evening', offers: 1 }), 'Good evening. Your wrap-up’s ready, with one thing I could do before tomorrow. Want me to read it?');
  assert.equal(openerLine({ kind: 'custom' }), 'I have your briefing. Would you like me to read it?');
});

test('their answer: all, some by place or by word, not now, or no; anything else isn’t one', () => {
  const list = [
    { id: 'd', kind: 'draft', ask: 'draft a reply to Sam Lee', label: 'Draft a reply to Sam Lee' },
    { id: 'o', kind: 'open', ask: 'open Homework 6 on Canvas', label: 'Open Homework 6 on Canvas' },
    { id: 'm', kind: 'move', ask: 'move “Call the dentist” to 12:00 PM', label: 'Move “Call the dentist” to 12:00 PM' }
  ];
  const yes = (ids) => ({ op: 'yes', ids });
  const cases = {
    'yes': yes(['d', 'o', 'm']), 'Yes please.': yes(['d', 'o', 'm']), 'sure, go ahead': yes(['d', 'o', 'm']), 'do all of them': yes(['d', 'o', 'm']), 'okay': yes(['d', 'o', 'm']), 'sure why not': yes(['d', 'o', 'm']),
    'just the first': yes(['d']), 'the second one': yes(['o']), 'number three': yes(['m']), 'the last one': yes(['m']), 'the first two': yes(['d', 'o']), 'the last two': yes(['o', 'm']), 'the first and the third': yes(['d', 'm']), 'two': yes(['o']),
    'the Canvas one': yes(['o']), 'draft the reply': yes(['d']), 'yeah, open it': yes(['o']), 'move the dentist one': yes(['m']), 'reply to Sam and open the homework': yes(['d', 'o']),
    'no, just the second': yes(['o']), 'not the first': yes(['o', 'm']), 'all but the reply': yes(['o', 'm']), 'everything except the last': yes(['d', 'o']),
    'no': { op: 'no', ids: ['d', 'o', 'm'] }, 'No thanks.': { op: 'no', ids: ['d', 'o', 'm'] }, 'neither': { op: 'no', ids: ['d', 'o', 'm'] }, 'none of them': { op: 'no', ids: ['d', 'o', 'm'] },
    'not now': { op: 'later', ids: ['d', 'o', 'm'] }, 'maybe later': { op: 'later', ids: ['d', 'o', 'm'] }, 'later please': { op: 'later', ids: ['d', 'o', 'm'] }
  };
  for (const [said, want] of Object.entries(cases)) assert.deepEqual(offerReply(said, list), want, said);
  for (const said of ['open Spotify', 'what’s the second one', 'what is the weather', 'yes and what’s the weather', 'tell me about the first one', 'remind me to call mom', 'not really', 'Why?', 'play some music', ''])
    assert.equal(offerReply(said, list), null, said);
  assert.equal(offerReply('yes', []), null);
});

test('nothing guessed (review, 2026-11-18): a no in it, words of their own, or a time that isn’t his, and it isn’t an answer', () => {
  const call = [{ id: 'c', kind: 'open', ask: 'open the call', label: 'Open the call for Standup' }];
  const move = [{ id: 'm', kind: 'move', ask: 'move “Call the dentist” to 12:00 PM', label: 'Move “Call the dentist” to 12:00 PM' }];
  const draft = [{ id: 'd', kind: 'draft', ask: 'draft a reply to Sam Lee', label: 'Draft a reply to Sam Lee' }];
  // One on offer, and "not" it: that's a no, not a yes to the rest of nothing.
  assert.deepEqual(offerReply('not the call', call), { op: 'no', ids: ['c'] });
  assert.deepEqual(offerReply('not the reply', draft), { op: 'no', ids: ['d'] });
  // Their own words about the task, for the list to deal with: never a yes to moving it.
  for (const said of ['I already called the dentist', 'cancel the dentist', 'mark the dentist done', 'call the dentist', 'I called the dentist', 'move it to 3 pm', 'move it later', 'move it to tomorrow'])
    assert.equal(offerReply(said, move), null, said);
  assert.deepEqual(offerReply('move it to 12', move), { op: 'yes', ids: ['m'] }, 'the time he offered');
  assert.deepEqual(offerReply('yes, move it', move), { op: 'yes', ids: ['m'] });
  assert.equal(offerReply('reply later', draft), null);
  assert.equal(offerReply('reply to Sam but say no', draft), null);
  // A mixed answer is the conversation's to work out, and never a no to all of them for a month.
  const two = [{ id: 'o', kind: 'open', ask: 'open Homework 6', label: 'Open Homework 6' }, ...move];
  for (const said of ['not the homework, yes the dentist', 'not the dentist one but the homework', 'no to the homework but move the dentist'])
    assert.equal(offerReply(said, two), null, said);
  assert.deepEqual(offerReply('the homework', two), { op: 'yes', ids: ['o'] }, 'a bare naming of one, to “which should I do?”');
  // Without his name, only these.
  for (const said of ['yes', 'Yeah.', 'no thanks', 'not now', 'both']) assert.ok(BARE_ANSWER.test(said), said);
  for (const said of ['just the first', 'move the dentist one', 'the homework', 'call the dentist']) assert.ok(!BARE_ANSWER.test(said), said);
});

test('a question about what he offered, and only that, keeps it standing', () => {
  const list = [{ id: 'd', kind: 'draft', ask: 'draft a reply to Sam Lee', label: 'Draft a reply to Sam Lee' }, { id: 'm', kind: 'move', ask: 'move “Buy stamps” to today', label: 'Move “Buy stamps” to today' }];
  for (const said of ['which one is the stamps?', 'what was the second one', 'say that again', 'who is Sam Lee?', 'what are they?']) assert.equal(offerAsked(said, list), true, said);
  for (const said of ['is it going to rain today?', 'can you open Spotify?', 'what time is it?', 'move my meeting', 'how are you?']) assert.equal(offerAsked(said, list), false, said);
});

test('a model’s ideas: a look-up or a reminder about one of the day’s facts, in its words, and nothing made up', () => {
  const lines = ['On their calendar today: CMPSC 465 Lecture at 4:00 PM, at Westgate E201.', 'Due today, by their calendar: History essay draft.', 'Talked about yesterday: The user said their stats exam is on Thursday.'];
  const stamp = '[Monday, November 16, 2026, 8:42 AM]';
  const context = (more = {}) => ({ lines, stamp, now: at(8, 42), web: true, existing: [], strays, ...more });
  const ideas = ideaOffers({ ideas: [
    { line: 3, kind: 'look up', what: 'practice problems for the stats exam', why: 'Stats exam on Thursday' },
    { line: 2, kind: 'remind', what: 'finish the history essay draft', at: '2026-11-16T19:00', why: 'Due today' }
  ] }, context());
  assert.deepEqual(ideas.map((idea) => idea.ask), ['look up practice problems for the stats exam', 'remind you at 7:00 PM to finish the history essay draft']);
  assert.deepEqual(ideas[0].action, { type: 'command', command: 'Look up practice problems for the stats exam', research: true });
  assert.deepEqual(ideas[1].action, { type: 'add-reminder', text: 'Finish the history essay draft', due: at(19) });
  const dropped = (idea, more) => ideaOffers({ ideas: [idea] }, context(more)).length === 0;
  assert.ok(dropped({ line: 3, kind: 'look up', what: 'practice problems for the stats exam', why: 'x' }, { web: false }), 'nothing to read the web with');
  assert.ok(dropped({ line: 3, kind: 'look up', what: 'buy a stats exam prep book', why: 'Exam' }), 'a look-up that would buy something');
  assert.ok(dropped({ line: 1, kind: 'look up', what: 'flights to Boston next month', why: 'Trip' }), 'about nothing in its fact');
  assert.ok(dropped({ line: 9, kind: 'look up', what: 'the stats exam', why: 'Exam' }), 'no such fact');
  assert.ok(dropped({ line: 1, kind: 'remind', what: 'leave for the CMPSC 465 lecture at 3:15', at: '2026-11-16T15:15', why: 'Lecture at 3:15 PM' }), 'a time the facts don’t have');
  assert.ok(dropped({ line: 2, kind: 'remind', what: 'finish the history essay', at: '2026-11-16T08:00', why: 'Due' }), 'a time gone by');
  assert.ok(dropped({ line: 2, kind: 'remind', what: 'finish the history essay', why: 'Due' }), 'a reminder with no time');
  assert.ok(dropped({ line: 2, kind: 'email', what: 'the history essay draft', why: 'Due' }), 'not a kind he can do');
  assert.ok(dropped({ line: 3, kind: 'look up', what: 'practice problems for the stats exam', why: 'Exam' }, { existing: [{ kind: 'research', label: 'Look up stats exam practice problems', ask: 'look up stats exam practice problems' }] }), 'already offered');
  assert.ok(dropped({ line: 2, kind: 'remind', what: 'finish the history essay draft', at: '2026-11-16T19:00', why: 'Due' }, { existing: [{ kind: 'task', label: 'History essay draft', ask: 'History essay draft' }] }), 'already on their list');
  // A reminder to start what's due is no copy of opening it.
  assert.equal(ideaOffers({ ideas: [{ line: 2, kind: 'remind', what: 'start the history essay draft', at: '2026-11-16T19:00', why: 'Due today' }] }, context({ existing: [{ kind: 'open', label: 'Open History essay draft', ask: 'open History essay draft' }] })).length, 1);
  assert.equal(ideaOffers({ ideas: [ideas, ideas, ideas].flat().map(() => ({ line: 3, kind: 'look up', what: 'practice problems for the stats exam', why: 'Exam' })) }, context()).length, 1, 'the same idea twice is one');
});

/** A storage.local: what's set is kept, as main.js's is. */
const memoryStore = () => {
  const kept = {};
  return { kept, get: async (key) => ({ [key]: structuredClone(kept[key]) }), set: async (patch) => Object.assign(kept, structuredClone(patch)), remove: async (key) => delete kept[key] };
};

test('kept: asked, answered, done; a no is never offered again, a not-now is, and three times unanswered is enough', async () => {
  let now = at(8, 42);
  let n = 0;
  const storage = memoryStore();
  const offers = createOffers({ storage, now: () => now, newId: () => `id${++n}` });
  const found = offerCandidates(morning(), { chrome: true });
  const first = await offers.propose(found, { source: 'morning' });
  assert.deepEqual(first.map((offer) => offer.status), ['open', 'open', 'open']);
  assert.ok(!('action' in first[0]), 'what the window and conversation see has no command');
  await offers.asked(['id1', 'id2', 'id3']);
  const [taken] = await offers.answer(['id1'], 'yes');
  assert.equal(taken.status, 'doing');
  assert.equal(taken.action.type, 'command');
  await offers.answer(['id2'], 'no');
  await offers.answer(['id3'], 'later');
  await offers.finish('id1', { ok: true, text: 'Drafted.' });
  assert.equal(offers.get('id1').status, 'done');
  // The evening's brief finds the same things: only the one put off comes back, as itself.
  const again = await offers.propose(found, { source: 'evening' });
  assert.deepEqual(again.map((offer) => offer.id), ['id3']);
  // Read back after a restart: the same.
  const reread = createOffers({ storage, now: () => now, newId: () => `id${++n}` });
  assert.deepEqual((await reread.propose(found)).map((offer) => offer.id), ['id3']);
  for (let i = 1; i < MOST_ASKS; i++) await reread.asked(['id3']);
  assert.deepEqual(await reread.propose(found), [], 'asked three times and never taken up');
  // Past its time, it's over.
  now = at(0, 1, 17);
  assert.equal(reread.waiting(['id3']).length, 0);
});

test('begun and never finished (quit mid-way) reads back as not done; and Forget it all forgets them', async () => {
  const storage = memoryStore();
  const offers = createOffers({ storage, now: () => at(9), newId: () => 'x1' });
  await offers.propose([draftOffer({ thread: 'abcdef12', from: 'Sam' }, at(9))]);
  await offers.answer(['x1'], 'yes');
  const reread = createOffers({ storage, now: () => at(9, 5) });
  await reread.start();
  assert.equal(reread.get('x1').status, 'failed');
  assert.equal(reread.get('x1').result, 'It was stopped before it finished.');
  await reread.forgetAll();
  assert.equal(reread.list().length, 0);
  assert.equal(storage.kept.workOffers, undefined);
});

test('done here: a page looked up on the calendar and opened, tasks moved, a reminder added; a command handed back', async () => {
  const events = [{ uid: 'hw6', title: 'Homework 6 [CMPSC 465]', start: at(0), end: at(0, 0, 17), allDay: true, url: 'https://psu.instructure.com/courses/1/assignments/6' },
    { uid: 's', title: 'Standup', start: at(10), end: at(10, 30), place: 'https://psu.zoom.us/j/845?pwd=abc' }];
  const opened = [];
  const list = new Map([['t1', { id: 't1', text: 'Call the dentist', due: at(9, 0, 15) }]]);
  const tasks = { get: (id) => list.get(id) || null, move: (id, when) => Object.assign(list.get(id), when), add: (task) => ({ id: 'n', ...task }) };
  const run = createOfferRunner({ tasks, calendars: { connected: true, between: () => events }, openExternal: async (url) => opened.push(url), now: () => at(8, 42) });
  const open = (event) => ({ action: { type: 'open-event', event } });
  assert.deepEqual(await run(open({ key: eventKey(events[0]), start: at(0), title: 'Homework 6' })), { ok: true, text: 'Homework 6’s open in your browser.' });
  assert.deepEqual(await run(open({ key: eventKey(events[1]), start: at(10), title: 'Standup', call: true })), { ok: true, text: 'The call’s opening in your browser.' });
  assert.deepEqual(opened, ['https://psu.instructure.com/courses/1/assignments/6', 'https://psu.zoom.us/j/845?pwd=abc']);
  assert.equal((await run(open({ key: 'gone', start: at(0), title: 'Quiz' }))).ok, false, 'moved or gone from the calendar since');
  assert.deepEqual(await run({ action: { type: 'move-tasks', moves: [{ taskId: 't1', due: at(12) }] } }), { ok: true, text: 'Moved “Call the dentist” to 12:00 PM.' });
  assert.equal(list.get('t1').due, at(12));
  assert.deepEqual(await run({ action: { type: 'move-tasks', moves: [{ taskId: 'nope', due: at(12) }] } }), { ok: false, text: 'That’s already off your list.' });
  assert.deepEqual(await run({ action: { type: 'add-reminder', text: 'Finish the essay', due: at(19) } }), { ok: true, text: 'Okay, I’ll remind you at 7:00 PM: finish the essay.' });
  assert.equal((await run({ action: { type: 'add-reminder', text: 'Late', due: at(8) } })).ok, false);
  assert.deepEqual(await run({ action: { type: 'command', command: 'Look up x', research: true } }), { command: 'Look up x', research: true });
});

test('the brief composes its offers: by rule, and a paid model’s ideas only when it may write', async () => {
  const requests = [];
  const make = ({ on = true, reply = null } = {}) => createBriefs({
    calendars: { connected: true, between: () => [{ uid: 'hw6', title: 'Homework 6', start: at(0), end: at(0, 0, 17), allDay: true, url: 'https://psu.instructure.com/courses/1/assignments/6' }] },
    tasks: { list: () => ({ open: [{ id: 't1', text: 'Call the dentist', due: at(9, 0, 15), overdue: true }], done: [] }) },
    request: reply && (async (options) => (requests.push(options), reply(options))),
    offering: () => ({ on, chrome: false, web: true }),
    lately: () => [{ at: at(20, 0, 15), summary: 'The user said their stats exam is on Thursday.' }],
    now: () => at(8, 42)
  });
  const plainly = await make().compose('morning');
  assert.deepEqual(plainly.offers.map((offer) => offer.kind), ['open', 'move']);
  assert.equal(plainly.count, 2, 'what’s due and what’s overdue');
  assert.deepEqual((await make({ on: false }).compose('morning')).offers, []);
  const withIdeas = await make({ reply: (options) => (/ideas/.test(options.system)
    // Fact 4: after the calendar, what's due and what's overdue, what was talked about yesterday.
    ? { json: { ideas: [{ line: 4, kind: 'look up', what: 'practice problems for the stats exam', why: 'Exam on Thursday' }] } }
    : { json: { say: 'Morning. Homework 6 is due today, and calling the dentist is overdue.' } }) }).compose('morning');
  assert.deepEqual(withIdeas.offers.map((offer) => offer.kind), ['open', 'move', 'research']);
  const ideaCall = requests.find((options) => /ideas/.test(options.system));
  assert.match(ideaCall.prompt, /Talked about yesterday: The user said their stats exam is on Thursday\./);
  assert.match(ideaCall.prompt, /Already offered or on their list: Open Homework 6; Move “Call the dentist” to 12:00 PM; On their list: Call the dentist\./);
});

test('his window: an offer’s row says why it’s offered, or how it went, and has buttons only while it waits', () => {
  const known = new Map([['a', { id: 'a', label: 'Open Homework 6', why: 'Due today', status: 'asked' }], ['b', { id: 'b', label: 'Draft a reply', status: 'done', result: 'Drafted it.' }], ['c', { id: 'c', label: 'Move it', status: 'later', why: 'Overdue' }]]);
  assert.deepEqual(offerRows(['a', 'b', 'c', 'z'], known).map(({ detail, actions }) => [detail, actions.length]), [['Due today', 3], ['Drafted it.', 0], ['Overdue · I’ll ask again later', 3], ['No longer on offer', 0]]);
});

/** A conversation with work to offer: what was asked, answered, done and said. */
function rig({ known = false, reply = 'It’s the dentist one.', outcome = { ok: true, text: 'Drafted a reply in Gmail and left it unsent.' } } = {}) {
  let now = 1000;
  const spoken = [];
  const entries = [];
  const calls = { asked: [], answered: [], ran: [], finished: [], commands: [] };
  const list = [
    { id: 'd', kind: 'draft', ask: 'draft a reply to Sam Lee', label: 'Draft a reply to Sam Lee', assure: 'I won’t send it.' },
    { id: 'm', kind: 'move', ask: 'move “Call the dentist” to 12:00 PM', label: 'Move “Call the dentist” to 12:00 PM' }
  ];
  const actions = { d: { type: 'command', command: 'Open https://mail.google.com/mail/u/0/#inbox/abc in Gmail…' }, m: { type: 'move-tasks', moves: [] } };
  const made = () => ({ text: 'Morning. Lab 3 at ten.', briefingId: 'b1', readToken: 'r', card: { kind: 'brief', id: 'b1' }, offers: list });
  const rigged = { gate: false, open: () => undefined };
  const conversation = createConversation({
    chat: async () => ({ say: reply, do: '' }),
    speaker: { say: async (text) => void spoken.push(text), stop() {} },
    memory: { add: (who, text, more = {}) => entries.push({ who, text, ...more }), current: () => entries.slice(), idleFor: () => 0, startNew: () => [], clear: () => { entries.length = 0; } },
    recollections: { keep: async () => {}, relevant: () => [], forget() {} },
    commands: { knows: async () => false, risky: async () => false, run: async (text) => (calls.commands.push(text), { steps: [], outcome }) },
    assistant: { asking: false, running: false, cancel() {} }, show() {}, knowsYou: () => known, now: () => now,
    briefs: { asked: () => '', read: async () => made(), respond: async () => {}, given: async () => {}, interrupted: async () => {} },
    work: {
      asked: async (ids) => calls.asked.push(ids),
      answer: async (ids, op) => {
        calls.answered.push([op, ids]);
        // Held open by a test, as a slow disk would: something else can be said meanwhile.
        if (op === 'yes' && rigged.gate) await new Promise((resolve) => (rigged.open = resolve));
        return op === 'yes' ? ids.map((id) => ({ ...list.find((offer) => offer.id === id), action: actions[id] })) : [];
      },
      run: async (offer) => (calls.ran.push(offer.id), offer.action.type === 'command' ? { command: offer.action.command } : { ok: true, text: 'Moved “Call the dentist” to 12:00 PM.' }),
      finish: async (id, out) => calls.finished.push([id, out.ok])
    }
  });
  return Object.assign(rigged, { conversation, spoken, entries, calls, list, advance: (ms) => (now += ms) });
}

test('read to the end, a brief asks what he could do; a yes does them: the move said, the draft begun and then told', async () => {
  const j = rig();
  await j.conversation.readBriefing('b1');
  assert.deepEqual(j.spoken, ['Morning. Lab 3 at ten.', 'Two things I could do: draft a reply to Sam Lee, and move “Call the dentist” to 12:00 PM. Want me to do both? I won’t send anything.']);
  assert.deepEqual(j.calls.asked, [['d', 'm']]);
  assert.deepEqual(j.entries.at(-1).card, { kind: 'offers', ids: ['d', 'm'] });
  // No name needed, a few seconds after: as a yes to his offer of a briefing.
  await j.conversation.heard('yes', { startedAt: j.advance(3000) });
  await tick();
  assert.deepEqual(j.calls.answered, [['yes', ['d', 'm']]]);
  assert.deepEqual(j.calls.ran, ['d', 'm']);
  assert.deepEqual(j.calls.commands, ['Open https://mail.google.com/mail/u/0/#inbox/abc in Gmail…']);
  assert.deepEqual(j.spoken.slice(2), ['Moved “Call the dentist” to 12:00 PM. On it: I’ll draft a reply to Sam Lee.', 'Drafted a reply in Gmail and left it unsent.']);
  assert.deepEqual(j.calls.finished, [['m', true], ['d', true]]);
});

test('some of them: the rest put off, to come up again; not now and no are said and nothing’s done', async () => {
  const some = rig();
  await some.conversation.readBriefing('b1');
  await some.conversation.told('just the second', { typed: true });
  assert.deepEqual(some.calls.answered, [['yes', ['m']], ['later', ['d']]]);
  assert.deepEqual(some.calls.commands, []);
  for (const [said, op, line] of [['not now', 'later', 'Okay, I’ll bring it up again later.'], ['no thanks', 'no', 'Okay, I’ll leave those.']]) {
    const j = rig();
    await j.conversation.readBriefing('b1');
    await j.conversation.told(said, { typed: true });
    assert.deepEqual(j.calls.answered, [[op, ['d', 'm']]], said);
    assert.deepEqual(j.calls.ran, []);
    assert.equal(j.entries.at(-1).text, line, 'typed to, he writes it');
  }
});

test('not an answer: something else is done as asked, and his offer is over; a question about it keeps it', async () => {
  const other = rig();
  await other.conversation.readBriefing('b1');
  await other.conversation.told('open Spotify', { typed: true });
  await other.conversation.told('yes', { typed: true });
  assert.deepEqual(other.calls.answered, [], 'a yes after something else isn’t to his offer');
  const asked = rig();
  await asked.conversation.readBriefing('b1');
  await asked.conversation.told('which one is the dentist?', { typed: true });
  assert.equal(asked.entries.at(-1).text, 'It’s the dentist one.');
  await asked.conversation.told('ok do that one, the dentist', { typed: true });
  assert.deepEqual(asked.calls.answered, [['yes', ['m']], ['later', ['d']]]);
  // Long after, a yes is nobody's answer to it.
  const late = rig();
  await late.conversation.readBriefing('b1');
  late.advance(3 * 60_000);
  await late.conversation.heard('yes', { startedAt: late.advance(1) });
  assert.deepEqual(late.calls.answered, []);
});

test('review, 2026-11-18: no name, only a bare answer; a click leaves another offer waiting; a newer turn leaves nothing “doing”', async () => {
  // Without his name or a voiceprint's window, "just the first" isn't for him; "yes" is.
  const quiet = rig();
  await quiet.conversation.readBriefing('b1');
  await quiet.conversation.heard('just the first', { startedAt: quiet.advance(2000) });
  assert.deepEqual(quiet.calls.answered, []);
  await quiet.conversation.heard('yes', { startedAt: quiet.advance(2000) });
  await tick();
  assert.deepEqual(quiet.calls.answered[0], ['yes', ['d', 'm']]);
  // A click on another card's Yes: the mail's offer still waits, and a yes after is to it.
  const click = rig();
  await click.conversation.announce('New email from Sam Lee: Lab 3 partners.', { card: { kind: 'mail' }, offers: [click.list[0]] });
  await click.conversation.takeOffers(['m'], 'Yes, do that.');
  assert.deepEqual(click.calls.answered, [['yes', ['m']]], 'nothing else put off');
  await click.conversation.told('yes', { typed: true });
  assert.deepEqual(click.calls.answered.at(-1), ['yes', ['d']]);
  // Something newer said while the yes was being kept: what was taken up is finished as not done, not left doing.
  const racing = rig();
  const answering = racing.calls;
  const slow = racing.conversation;
  await slow.readBriefing('b1');
  racing.gate = true;
  const yes = slow.told('yes', { typed: true });
  await tick();
  const other = slow.told('what time is it', { typed: true });
  racing.open();
  await Promise.all([yes, other]);
  assert.deepEqual(answering.ran, []);
  assert.deepEqual(answering.finished, [['d', false], ['m', false]]);
});

test('a question that isn’t about them ends them: a yes after his own question is to that', async () => {
  const j = rig({ reply: 'Rain after four. Want me to remind you to take an umbrella?' });
  await j.conversation.readBriefing('b1');
  await j.conversation.told('is it going to rain today?', { typed: true });
  await j.conversation.told('yes', { typed: true });
  assert.deepEqual(j.calls.answered, []);
  // About them, and his answer asks nothing: it still stands.
  const k = rig({ reply: 'It’s the dentist one.' });
  await k.conversation.readBriefing('b1');
  await k.conversation.told('which one is the dentist?', { typed: true });
  await k.conversation.told('yes', { typed: true });
  assert.deepEqual(k.calls.answered[0], ['yes', ['d', 'm']]);
});

test('with new mail: the question said with it, its card showing the offer; and their click on Yes', async () => {
  const j = rig();
  await j.conversation.announce('New email from Sam Lee: Lab 3 partners.', { card: { kind: 'mail', title: 'From Sam Lee' }, untrusted: true, offers: [j.list[0]] });
  assert.equal(j.spoken.at(-1), 'New email from Sam Lee: Lab 3 partners. Want me to draft a reply to Sam Lee? I won’t send it.');
  assert.deepEqual(j.entries.at(-1).card, { kind: 'mail', title: 'From Sam Lee', offerIds: ['d'] });
  assert.deepEqual(j.calls.asked, [['d']]);
  await j.conversation.takeOffers(['d'], 'Yes: Draft a reply to Sam Lee');
  assert.deepEqual(j.calls.commands.length, 1);
  assert.equal(j.entries.find((entry) => entry.who === 'you').text, 'Yes: Draft a reply to Sam Lee');
});
