import test from 'node:test';
import assert from 'node:assert/strict';
import { openBriefingItem } from '../desktop/src/main/briefing-actions.js';

const items = [
  { id: 'event', kind: 'event', title: 'Meeting', detail: 'Scheduled, Room 1.', start: new Date(2026, 10, 17, 10).getTime() },
  { id: 'page', kind: 'page', title: 'Coursework', url: 'https://school.example/assignments/12' },
  { id: 'mail', kind: 'mail', title: 'Project update', mailId: 'abcdef123456' },
  { id: 'task', kind: 'task', title: 'Finish report', taskId: 't1' },
  { id: 'feed', kind: 'event', title: 'Private feed', url: 'https://school.example/calendar/ical/private/basic.ics' },
  { id: 'unsafe', kind: 'page', title: 'Unsafe', url: 'javascript:alert(1)' }
];
function rig() {
  const opened = [], mail = [];
  return { opened, mail, options: { manager: { get: (id) => id === 'b1' ? { items } : null }, id: 'b1',
    openExternal: async (url) => opened.push(url), openMail: async (id) => mail.push(id) } };
}
test('source Open resolves the saved item and never trusts a renderer supplied address', async () => {
  const j = rig();
  assert.equal((await openBriefingItem({ ...j.options, itemId: 'page', url: 'https://wrong.example/' })).ok, true);
  assert.deepEqual(j.opened, ['https://school.example/assignments/12']);
  assert.equal((await openBriefingItem({ ...j.options, itemId: 'mail' })).ok, true);
  assert.deepEqual(j.mail, ['abcdef123456']);
  assert.deepEqual(await openBriefingItem({ ...j.options, itemId: 'task' }), { ok: true, navigate: 'tasks' });
});
test('calendar events without an original link open their internal calendar details', async () => {
  const j = rig();
  const result = await openBriefingItem({ ...j.options, itemId: 'event' });
  assert.equal(result.view.kind, 'calendar');
  assert.match(result.view.title, /November 17/);
  assert.equal(result.view.items[0].title, 'Meeting');
  assert.deepEqual(j.opened, []);
});
test('unknown items, unsafe addresses, and private subscription links never open externally', async () => {
  const j = rig();
  for (const itemId of ['unknown', 'unsafe']) assert.equal((await openBriefingItem({ ...j.options, itemId })).ok, false);
  assert.equal((await openBriefingItem({ ...j.options, id: 'other', itemId: 'page' })).ok, false);
  await openBriefingItem({ ...j.options, itemId: 'feed' });
  assert.deepEqual(j.opened, []);
});
