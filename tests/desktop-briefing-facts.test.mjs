import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefs } from '../desktop/src/main/briefs.js';
import { calendarEventUrl, readFeed, combine } from '../desktop/src/main/calendars.js';

const at = (hour, day = 17) => new Date(2026, 10, day, hour).getTime();
const empty = { open: [], done: [] };

test('calendar records retain only an explicit safe event page and share it when duplicates combine', () => {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:course\r\nDTSTART:20261117T150000Z\r\nDTEND:20261117T160000Z\r\nSUMMARY:Course lecture\r\nURL:https://school.instructure.com/calendar?event_id=123\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const { events } = readFeed(ics, { from: at(0, 16), to: at(0, 18) });
  assert.equal(events[0].url, 'https://school.instructure.com/calendar?event_id=123');
  const { url, ...without } = events[0];
  const merged = combine([{ calendar: 'Calendar', events: [without] }, { calendar: 'Canvas', events }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, url);
  assert.deepEqual(merged[0].calendars, ['Calendar', 'Canvas']);
  for (const value of ['javascript:alert(1)', 'https://user:password@example.com/event', 'https://example.com/event?token=secret', 'https://example.com/private.ics', 'https://calendar.google.com/calendar/ical/private-key/basic.ics', 'webcal://example.com/event', 'https://school.instructure.com/feeds/calendars/private-key']) {
    assert.equal(calendarEventUrl(value), '', value);
  }
  assert.equal(Object.hasOwn(combine([{ calendar: 'Calendar', events: [{ ...without, url: 'javascript:alert(1)' }] }])[0], 'url'), false);
});

test('scheduled briefing items retain safe calendar, task and mail targets independently of spoken text', async () => {
  const briefs = createBriefs({ now: () => at(8),
    calendars: { connected: true, between: () => [{ uid: 'lecture', title: 'Lecture', start: at(10), end: at(11), allDay: false, calendars: ['Classes'], url: 'https://example.com/lecture' }] },
    tasks: { list: () => ({ open: [{ id: 'task1', text: 'Read textbook' }], done: [] }) },
    mail: { unsaid: () => [{ id: 'abc123', thread: 'def456', from: 'Professor', subject: 'Course update', at: at(7) }] }
  });
  const made = await briefs.compose('morning');
  assert.equal(made.items.find((item) => item.kind === 'event').url, 'https://example.com/lecture');
  assert.match(made.items.find((item) => item.kind === 'event').detail, /^Scheduled/);
  assert.equal(made.items.find((item) => item.kind === 'task').taskId, 'task1');
  assert.equal(made.items.find((item) => item.kind === 'mail').mailId, 'def456');
  assert.deepEqual(made.mailIds, ['abc123']);
  assert.equal(made.untrusted, true);
});

test('custom briefing includes only records inside the requested period and labels scheduled events honestly', async () => {
  const from = at(9), to = at(15);
  let requestedSince;
  const briefs = createBriefs({ now: () => to,
    calendars: { connected: true, between: () => [{ title: 'Lab', start: at(11), end: at(12), allDay: false }] },
    tasks: { list: () => ({ open: [{ id: 'old', text: 'Old task', made: at(8) }, { id: 'new', text: 'New task', made: at(10) }], done: [{ id: 'done', text: 'Finished task', made: at(8), done: at(13) }, { id: 'tomorrow', text: 'Future task', done: at(16) }] }) },
    mail: { recent: (since) => (requestedSince = since, [{ id: 'abc123', thread: 'def456', from: 'Professor', subject: 'New update', at: at(10) }, { id: 'fff123', from: 'Later', subject: 'Future message', at: at(16) }]) }
  });
  const made = await briefs.composeCustom({ topic: 'Your day', from, to, rangeLabel: 'since we last talked', history: [{ at: new Date(at(10)).toISOString(), who: 'you', text: 'I started the lab report.' }, { at: new Date(at(8)).toISOString(), who: 'you', text: 'Old conversation' }, { at: new Date(at(12)).toISOString(), who: 'you', text: 'Hidden text', hidden: true }] });
  assert.equal(requestedSince, from);
  assert.match(made.text, /Scheduled on your calendar/);
  assert.match(made.text, /not attendance/);
  assert.match(made.text, /New task|Finished task/);
  assert.doesNotMatch(made.text, /Old task|Future task|Future message|Old conversation|Hidden text/);
  // How the records go is on the card, not read out.
  assert.doesNotMatch(made.text, /sender and subject only|retained creation/);
  assert.ok(made.card.lines.some((line) => /sender and subject only/.test(line)));
  assert.equal(made.items.find((item) => item.kind === 'mail').mailId, 'def456');
  assert.equal(made.items.find((item) => item.kind === 'activity').source, 'Conversation');
  assert.deepEqual(made.range, { from, to, label: 'since we last talked' });
});

test('mail-only briefs do not read calendar, tasks, history or web pages', async () => {
  let called = false;
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => assert.fail('not a task briefing') },
    calendars: { connected: true, between: () => assert.fail('not a calendar briefing') },
    research: async () => assert.fail('mail metadata needs no research'), mail: { recent: () => [] },
    request: async () => { called = true; return { json: { say: 'No important mail was retained.' } }; }
  });
  const made = await briefs.composeCustom({ topic: 'mail', from: at(9), to: at(15), history: [{ who: 'you', at: new Date(at(10)).toISOString(), text: 'Unrelated private conversation.' }] });
  assert.equal(called, true);
  assert.equal(made.items.length, 0);
  assert.doesNotMatch(made.text, /Unrelated private/);
});

test('Canvas briefings filter unrelated records and use injected background reading with observed source links', async () => {
  const calls = [];
  const briefs = createBriefs({ now: () => at(15),
    tasks: { list: () => ({ open: [{ id: 'school', text: 'Write homework', made: at(10) }, { id: 'shopping', text: 'Buy groceries', made: at(11) }], done: [] }) },
    calendars: { connected: true, between: () => [{ title: 'Lecture', start: at(11), end: at(12), calendars: ['Canvas'] }, { title: 'Dentist', start: at(12), end: at(13), calendars: ['Personal'] }] },
    mail: { recent: () => assert.fail('not a mail briefing') }, research: async (request) => {
      calls.push(request);
      return { ok: true, answer: 'The essay is due tonight.', sources: [{ url: 'https://school.instructure.com/courses/12/assignments/34', title: 'Essay' }, { url: 'javascript:alert(1)', title: 'Bad' }] };
    }
  });
  const made = await briefs.composeCustom({ topic: 'Canvas classes', from: at(9), to: at(15) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].goal, /existing signed-in Canvas/);
  assert.match(calls[0].goal, /background reading only/);
  assert.doesNotMatch(calls[0].context, /Dentist|groceries/);
  assert.match(made.text, /The essay is due tonight/);
  assert.doesNotMatch(made.text, /Dentist|groceries/);
  const pages = made.items.filter((item) => item.kind === 'page');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, 'https://school.instructure.com/courses/12/assignments/34');
  assert.match(made.coverage.join(' '), /not verified/);
  assert.equal(made.untrusted, true);
});

test('unreadable news yields an honest briefing without computer control', async () => {
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty }, research: async () => ({ ok: false, why: 'Needs clicks' }) });
  const made = await briefs.composeCustom({ topic: 'news', from: at(9), to: at(15) });
  assert.match(made.text, /could not be read in the background/);
  assert.deepEqual(made.items, []);
});

test('cancelling custom composition propagates to research and cannot become a saved unavailable-source answer', async () => {
  const controller = new AbortController();
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty }, research: async ({ signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { ok: true, answer: 'Late answer.', sources: [] };
  } });
  await assert.rejects(briefs.composeCustom({ topic: 'news', from: at(9), to: at(15), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(briefs.compose('morning', { signal: controller.signal }), { name: 'AbortError' });
});

test('custom mail privacy setting prevents the writer from seeing watched mail', async () => {
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty },
    mail: { recent: () => [{ id: 'abc123', thread: 'def456', from: 'Professor', subject: 'Sensitive update', at: at(10) }] },
    mailToModel: () => false, request: async () => assert.fail('mail cannot reach the writer')
  });
  const made = await briefs.composeCustom({ topic: 'mail', from: at(9), to: at(15) });
  assert.match(made.text, /Sensitive update/);
  assert.deepEqual(made.mailIds, ['abc123']);
});

test('upcoming events use a separate future window instead of the retrospective range', async () => {
  const queried = [];
  const events = [
    { title: 'Past appointment', start: at(10), end: at(11) },
    { title: 'Afternoon meeting', start: at(16), end: at(17) },
    { title: 'Tomorrow lecture', start: at(10, 18), end: at(11, 18) },
    { title: 'Later appointment', start: at(16, 18), end: at(17, 18) }
  ];
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty }, calendars: { connected: true,
    between: (from, to) => (queried.push({ from, to }), events.filter((event) => event.start < to && event.end > from)) }
  });
  const upcoming = await briefs.composeCustom({ topic: 'upcoming events', from: at(9), to: at(15), rangeLabel: 'Since our last conversation' });
  assert.deepEqual(queried[0], { from: at(15), to: at(15) + 24 * 3600_000 });
  assert.match(upcoming.text, /Upcoming on your calendar, the next 24 hours/);
  assert.match(upcoming.text, /future scheduled plans/);
  assert.doesNotMatch(upcoming.text, /Past appointment|Later appointment|Since our last conversation/);
  assert.deepEqual(upcoming.items.map((item) => item.title), ['Afternoon meeting', 'Tomorrow lecture']);
  const tomorrow = await briefs.composeCustom({ topic: 'tomorrow events', from: at(9), to: at(15) });
  assert.deepEqual(queried[1], { from: at(0, 18), to: at(0, 19) });
  assert.match(tomorrow.text, /Upcoming on your calendar, tomorrow/);
  assert.deepEqual(tomorrow.items.map((item) => item.title), ['Tomorrow lecture', 'Later appointment']);
});

test('large custom source records produce a short readout and retain details under See more', async () => {
  const article = 'Verified reporting from the connected source. '.repeat(80);
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => ({ open: Array.from({ length: 8 }, (_, i) => ({ id: `task${i}`, text: `Task ${i} ${'detail '.repeat(30)}`, made: at(10) })), done: [] }) },
    mail: { recent: () => Array.from({ length: 8 }, (_, i) => ({ id: `abc12${i}`, thread: `def45${i}`, from: 'Professor', subject: `Update ${i}`, at: at(10) })) },
    research: async () => ({ ok: true, answer: article, sources: [{ title: 'Reporting', url: 'https://example.com/report' }] })
  });
  const made = await briefs.composeCustom({ topic: 'general daily news', from: at(9), to: at(15), rangeLabel: 'Today so far' });
  assert.ok(made.text.length < 2000, `${made.text.length} characters`);
  assert.match(made.text, /See more has the full records/);
  // What wasn't there is said; how the sources go is on the card only.
  assert.match(made.text, /No calendar is connected/);
  assert.doesNotMatch(made.text, /not the full inbox|not verified/);
  assert.ok(made.card.lines.some((line) => /not the full inbox/.test(line)) && made.card.lines.some((line) => /not verified/.test(line)));
  assert.equal(made.items.find((item) => item.kind === 'page').detail.length, 3000);
  assert.ok(made.card.lines.some((line) => line.length > 160));
});

test('writer cannot turn a scheduled calendar entry into claimed attendance', async () => {
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty },
    calendars: { connected: true, between: () => [{ title: 'Lecture', start: at(10), end: at(11) }] },
    request: async () => ({ json: { say: 'You attended Lecture at 10:00 AM.' } })
  });
  const made = await briefs.composeCustom({ topic: 'calendar', from: at(9), to: at(15) });
  assert.match(made.text, /not attendance/);
  assert.doesNotMatch(made.text, /You attended/);
});

test('a secret in an event title or a mail subject is left out, and the rest of the briefing still said', async () => {
  const briefs = createBriefs({ now: () => at(8),
    calendars: { connected: true, between: () => [{ title: 'Zoom: CMPSC 465 lecture, passcode 482913', place: 'Room 2, PIN 4821', start: at(10), end: at(11), allDay: false }] },
    tasks: { list: () => empty },
    mail: { unsaid: () => [{ id: 'abc123', from: 'Bank', subject: 'Your verification code is 482913', at: at(7) }] } });
  const made = await briefs.compose('morning');
  assert.ok(made.text, 'the briefing is not blanked');
  assert.match(made.text, /CMPSC 465 lecture/);
  assert.doesNotMatch(`${made.text} ${made.card.lines.join(' ')} ${JSON.stringify(made.items)}`, /482913|4821/);
});

test('research stopped some other way than by the briefing’s own asker leaves the briefing to go on without it', async () => {
  const briefs = createBriefs({ now: () => at(15), tasks: { list: () => empty },
    research: async () => { throw Object.assign(new Error('Research cancelled.'), { name: 'AbortError' }); } });
  const made = await briefs.composeCustom({ topic: 'news', from: at(9), to: at(15), rangeLabel: 'Today so far' });
  assert.match(made.text, /News sources could not be read in the background/);
  const asker = new AbortController();
  asker.abort();
  await assert.rejects(briefs.composeCustom({ topic: 'news', from: at(9), to: at(15), signal: asker.signal }), { name: 'AbortError' });
});
