import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeAction, menuPath, validateTurn } from '../desktop/src/main/agent/actions.js';
import { createDesktopHost } from '../desktop/src/main/agent/host.js';
import { runDesktopAgent } from '../desktop/src/main/agent/loop.js';
import { replaySteps } from '../desktop/src/main/agent/replay.js';
import { findTarget, screenChanges } from '../desktop/src/main/agent/screen.js';

const frame = (x, y, w = 80, h = 30) => ({ x, y, w, h });
/** Notes, with a note list and a body, as jester-driver's snapshot lists them. */
const NOTES = {
  snapshot: 11,
  app: { name: 'Notes', pid: 50 },
  window: { title: 'Notes', frame: frame(0, 0, 1000, 700) },
  elements: [
    { id: 0, role: 'searchfield', label: 'Search', depth: 3, frame: frame(20, 10, 200, 24) },
    { id: 1, role: 'row', label: 'Shopping list', depth: 5, frame: frame(20, 60, 260, 40) },
    { id: 2, role: 'row', label: 'Trip ideas', depth: 5, frame: frame(20, 100, 260, 40) },
    { id: 3, role: 'textarea', label: 'Note body', value: 'milk', depth: 5, frame: frame(300, 60, 680, 600) },
    { id: 4, role: 'text', label: 'Updated 10:41', depth: 4 },
    { id: 5, role: 'button', label: 'Recently Deleted', depth: 4, frame: frame(20, 640, 120, 24) }
  ]
};
const DIALOG = {
  snapshot: 12,
  app: { name: 'Finder', pid: 60 },
  window: { title: 'Finder' },
  elements: [
    { id: 0, role: 'text', label: 'Are you sure you want to delete “Taxes”? This can’t be undone.' },
    { id: 1, role: 'button', label: 'Cancel' },
    { id: 2, role: 'button', label: 'OK' }
  ]
};

test('the new actions are checked like the old: menus, drags, places, scrolls and field modes', () => {
  assert.deepEqual(menuPath('File > New Note'), ['File', 'New Note']);
  assert.deepEqual(menuPath(' Edit › Find › Find… '), ['Edit', 'Find', 'Find…']);
  for (const good of [
    { action: { action: 'menu', path: 'File > New Note' } },
    { action: { action: 'drag', from: 1, to: 5 } },
    { action: { action: 'place', where: 'left', screen: 'monitor', app: 'Safari' } },
    { action: { action: 'scroll', direction: 'right', to: 'end' } },
    { action: { action: 'scroll_to', text: 'Trip ideas' } },
    { action: { action: 'click', id: 1, button: 'right' } },
    { action: { action: 'click', id: 1, count: 2 } },
    { action: { action: 'type', id: 3, text: 'eggs', mode: 'append' } },
    { action: { action: 'press', keys: 'cmd+z', times: 3 } }
  ]) {
    assert.doesNotThrow(() => validateTurn(good), JSON.stringify(good));
  }
  for (const bad of [
    { action: { action: 'menu', path: 'A > B > C > D > E > F > G' } },
    { action: { action: 'menu', path: ' > ' } },
    { action: { action: 'drag', from: 1 } },
    { action: { action: 'place', where: 'upside down' } },
    { action: { action: 'place', screen: 'monitor' } },
    { action: { action: 'click', id: 1, count: 3 } },
    { action: { action: 'click', id: 1, button: 'middle' } },
    { action: { action: 'scroll', direction: 'diagonal' } },
    { action: { action: 'type', id: 3, text: 'x', mode: 'overwrite' } },
    { action: { action: 'press', keys: 'cmd+z', times: 50 } },
    { actions: [{ action: 'menu', path: 'File > New Note' }, { action: 'type', text: 'hi' }] }
  ]) {
    assert.throws(() => validateTurn(bad), Error, JSON.stringify(bad));
  }
});

test('the user\'s rule holds for the new actions: a delete by menu, drop or plain OK asks first', () => {
  const kind = (action, screen = NOTES) => classify(action, { screen, goal: '' }).category;
  assert.equal(kind({ action: 'menu', path: 'File > New Note' }), 'browse');
  assert.equal(kind({ action: 'menu', path: 'File > Delete' }), 'sensitive');
  // The titles the app really has are what's judged, not the model's spelling of them.
  assert.equal(kind({ action: 'menu', path: 'File > Mov', resolved: ['File', 'Move to Trash'] }), 'sensitive');
  assert.equal(kind({ action: 'drag', from: 1, to: 5 }), 'sensitive', 'onto Recently Deleted');
  assert.equal(kind({ action: 'drag', from: 1, to: 2 }), 'browse');
  assert.equal(kind({ action: 'click', id: 2 }, DIALOG), 'sensitive', 'OK to a delete is the delete');
  assert.equal(kind({ action: 'click', id: 1 }, DIALOG), 'browse', 'Cancel is never one');
  const plainOk = { ...DIALOG, elements: [{ id: 0, role: 'text', label: 'Your changes were saved.' }, { id: 1, role: 'button', label: 'OK' }] };
  assert.equal(kind({ action: 'click', id: 1 }, plainOk), 'browse');
  const focusedSend = { app: { name: 'Feedback' }, elements: [{ id: 0, role: 'button', label: 'Send', focused: true }] };
  assert.equal(kind({ action: 'press', keys: 'enter' }, focusedSend), 'sensitive', 'Enter on a focused Send presses it');
  assert.equal(kind({ action: 'press', keys: 'space' }, focusedSend), 'sensitive');
  assert.equal(kind({ action: 'scroll_to', text: 'Trip ideas' }), 'read');
  assert.equal(kind({ action: 'place', where: 'left' }), 'browse');
  assert.equal(kind({ action: 'type', id: 3, text: 'eggs', mode: 'append' }), 'browse');

  assert.equal(describeAction({ action: 'menu', path: 'file > new note', resolved: ['File', 'New Note'] }, NOTES), 'Choose File › New Note');
  assert.equal(describeAction({ action: 'drag', from: 1, to: 2 }, NOTES), 'Drag “Shopping list” onto “Trip ideas”');
  assert.equal(describeAction({ action: 'click', id: 1, count: 2 }, NOTES), 'Double-click “Shopping list”');
  assert.equal(describeAction({ action: 'click', id: 1, button: 'right' }, NOTES), 'Right-click “Shopping list”');
  assert.equal(describeAction({ action: 'type', id: 3, text: 'eggs', mode: 'append' }, NOTES), 'Add “eggs” to the end of “Note body”');
  assert.equal(describeAction({ action: 'press', keys: 'cmd+z', times: 3 }, NOTES, 'darwin'), 'Press ⌘Z 3 times');
  assert.equal(describeAction({ action: 'scroll', direction: 'down', to: 'end' }, NOTES), 'Scroll to the bottom');
  assert.equal(describeAction({ action: 'place', where: 'left', screen: 'monitor' }, NOTES), 'Put Notes on the left of the monitor');
});

test('what a step changed is said by name, a ticking clock is no change, and nothing is "nothing"', () => {
  assert.deepEqual(screenChanges(NOTES, structuredClone(NOTES)), { changed: false, summary: 'Nothing on screen changed.' });
  const later = structuredClone(NOTES);
  later.snapshot = 12;
  later.elements[4].label = 'Updated 10:42';
  assert.equal(screenChanges(NOTES, later).changed, false, 'digits are a clock, not a change');

  const sheet = structuredClone(NOTES);
  sheet.elements.push({ id: 6, role: 'button', label: 'Delete', in: 'Delete this note?' }, { id: 7, role: 'textfield', label: 'Folder name', focused: true });
  const added = screenChanges(NOTES, sheet);
  assert.equal(added.changed, true);
  assert.match(added.summary, /^New: button "Delete" — in "Delete this note\?"; textfield "Folder name" \(focused\)\./);
  assert.match(added.summary, /Focus is on textfield "Folder name"/);

  const typed = structuredClone(NOTES);
  typed.elements[3].value = 'milk eggs';
  assert.equal(screenChanges(NOTES, typed).summary, 'Changed: textarea "Note body" value: "milk eggs".');

  const elsewhere = { ...structuredClone(NOTES), app: { name: 'Mail', pid: 51 }, window: { title: 'Inbox' } };
  assert.equal(screenChanges(NOTES, elsewhere).summary, 'Now in Mail — "Inbox".');
});

test('a remembered control is found again by kind and name, or not at all', () => {
  assert.equal(findTarget(NOTES, { role: 'row', label: 'trip  ideas' })?.id, 2);
  assert.equal(findTarget(NOTES, { role: 'button', label: 'Trip ideas' }), null, 'the kind counts');
  const twice = { elements: [{ id: 0, role: 'button', label: 'Play', in: 'Gunna' }, { id: 1, role: 'button', label: 'Play', in: 'Drake' }] };
  assert.equal(findTarget(twice, { role: 'button', label: 'Play', in: 'Drake' })?.id, 1);
  assert.equal(findTarget(twice, { role: 'button', label: 'Play' }), null, 'two alike, and nothing to tell them apart: no guess');
});

/** A driver that answers each command from a table (a function, or a value), and records every call. */
function scriptedDriver(answers = {}) {
  const calls = [];
  const driver = {
    call: async (cmd, params) => {
      calls.push([cmd, params]);
      const answer = answers[cmd];
      if (typeof answer === 'function') return answer(params, calls);
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    }
  };
  return { calls, driver };
}
const hostOn = (driver, extra = {}) =>
  createDesktopHost({
    driver,
    activate: async () => undefined,
    openApp: async () => ({ ok: true, text: '' }),
    openUrl: async () => undefined,
    dispatch: async () => ({ ok: true }),
    wait: async () => undefined,
    platform: 'darwin',
    ...extra
  });
const inFront = (pid) => ({ app: { pid } });

test('a menu command is found first (its real titles judged), then chosen', async () => {
  const { calls, driver } = scriptedDriver({ menu: (params) => ({ path: ['File', 'New Note'], enabled: true, pressed: params.press }) });
  const host = hostOn(driver);
  const action = { action: 'menu', path: 'file > new' };
  assert.deepEqual(await host.prepare(action, NOTES), { ok: true });
  assert.deepEqual(action.resolved, ['File', 'New Note']);
  assert.deepEqual(await host.execute(action, NOTES), { ok: true, detail: '' });
  assert.deepEqual(calls, [
    ['menu', { pid: 50, path: ['file', 'new'], press: false }],
    ['focused', undefined],
    // Word for word what was judged: the command chosen is the one approved.
    ['menu', { pid: 50, path: ['File', 'New Note'], press: true, exact: true }]
  ]);

  // A password field has the focus: no menu command (Paste would fill it).
  const secret = scriptedDriver({ menu: { path: ['Edit', 'Paste'], enabled: true }, focused: { element: { secure: true }, app: { pid: 50 } } });
  assert.deepEqual(await hostOn(secret.driver).execute({ action: 'menu', path: 'Edit > Paste', resolved: ['Edit', 'Paste'] }, NOTES), { ok: false, detail: 'Jester never types into password fields.' });
  assert.equal(secret.calls.some(([cmd, params]) => cmd === 'menu' && params.press), false);

  const greyed = hostOn(scriptedDriver({ menu: { path: ['Edit', 'Paste'], enabled: false } }).driver);
  assert.deepEqual(await greyed.prepare({ action: 'menu', path: 'Edit > Paste' }, NOTES), { ok: false, detail: '“Edit › Paste” is greyed out right now.' });
  const missing = hostOn(scriptedDriver({ menu: new Error('no “Nwe Note” in “File”; there is: New Note, New Folder') }).driver);
  assert.match((await missing.prepare({ action: 'menu', path: 'File > Nwe Note' }, NOTES)).detail, /there is: New Note, New Folder/);
});

test('text is set outright where a field takes it, read back, and never sent wrong', async () => {
  // Native field: set, landed, nothing typed and the app needn't be in front.
  const set = scriptedDriver({ act: (params) => (params.action === 'setValue' ? { value: params.value, landed: true } : { value: 'gro', length: 3 }) });
  assert.deepEqual(await hostOn(set.driver).execute({ action: 'type', id: 0, text: 'groceries' }, NOTES), { ok: true, landed: true });
  assert.deepEqual(set.calls, [['act', { snapshot: 11, element: 0, action: 'setValue', value: 'groceries' }]]);
  // A long one-line value (an address bar's) is meant to be replaced.
  const url = scriptedDriver({ act: (params) => (params.action === 'setValue' ? { value: params.value, landed: true } : { value: 'x'.repeat(310), length: 310 }) });
  assert.deepEqual(await hostOn(url.driver).execute({ action: 'type', id: 0, text: 'weather in Paris' }, NOTES), { ok: true, landed: true });
  // A text area is never replaced whole: its formatting would go.
  const whole = scriptedDriver();
  assert.match((await hostOn(whole.driver).execute({ action: 'type', id: 3, text: 'eggs', mode: 'replace' }, NOTES)).detail, /isn’t replaced whole/);
  assert.equal(whole.calls.length, 0);
  // A one-line field holding lines the screen didn't show: not replaced.
  const lined = { ...NOTES, elements: NOTES.elements.map((item) => (item.id === 0 ? { ...item, role: 'textfield', value: 'first line\nsecond' } : item)) };
  const hidden = scriptedDriver({ act: { value: 'x'.repeat(2000), length: 5000 } });
  assert.match((await hostOn(hidden.driver).execute({ action: 'type', id: 0, text: 'hi', mode: 'replace' }, lined)).detail, /holds more lines than the screen showed/);
  assert.equal(hidden.calls.some(([, params]) => params?.action === 'setValue'), false);
  // A tab would carry the rest into the next field.
  assert.match((await hostOn(scriptedDriver().driver).execute({ action: 'type', id: 0, text: 'me@example.com\thunter2' }, NOTES)).detail, /can’t hold a tab/);

  // A longer field is added to by default.
  const added = scriptedDriver({ act: (params) => (params.action === 'appendValue' ? { value: `milk${params.value}`, landed: true } : {}) });
  assert.equal((await hostOn(added.driver).execute({ action: 'type', id: 3, text: ' eggs' }, NOTES)).ok, true);
  assert.equal(added.calls[0][1].action, 'appendValue');
  // Added, but not as asked: never added again (it could go in twice).
  const half = scriptedDriver({ act: { value: 'milk eg', landed: false } });
  assert.match((await hostOn(half.driver).execute({ action: 'type', id: 3, text: ' eggs' }, NOTES)).detail, /check it before trying again/);
  assert.equal(half.calls.some(([cmd]) => cmd === 'text'), false);

  // A web page's field is typed into; when the words didn't land, Enter isn't pressed.
  const web = scriptedDriver({
    act: (params) => (params.action === 'setValue' ? Promise.reject(new Error('web pages don’t take text set this way')) : params.action === 'read' ? { value: 'gunn', length: 4, contains: params.value === '' } : {}),
    frontmost: inFront(50),
    focused: { element: { secure: false }, app: { pid: 50 } }
  });
  const result = await hostOn(web.driver).execute({ action: 'type', id: 0, text: 'gunna', enter: true }, NOTES);
  assert.deepEqual(result, { ok: false, detail: 'The text didn’t land: the field reads “gunn”, so Enter wasn’t pressed.' });
  assert.equal(web.calls.some(([cmd, params]) => cmd === 'key' && params.key === 'enter'), false);
});

test('scrolling is the scroll area\'s own first, the wheel only when that can\'t, and the end is said', async () => {
  const moved = scriptedDriver({ act: { moved: true, position: 0.4 } });
  assert.deepEqual(await hostOn(moved.driver).execute({ action: 'scroll', direction: 'down' }, NOTES), { ok: true, detail: 'now 40% of the way' });
  assert.deepEqual(moved.calls, [['act', { snapshot: 11, action: 'scrollPage', value: 'down' }]], 'no pointer, no front');

  const stuck = scriptedDriver({ act: { moved: false, position: 0.2 }, frontmost: inFront(50) });
  assert.equal((await hostOn(stuck.driver).execute({ action: 'scroll', direction: 'up', id: 3 }, NOTES)).ok, true);
  assert.deepEqual(stuck.calls.at(-1), ['scroll', { x: 640, y: 360, dy: 400, unit: 'pixel' }]);

  const atEnd = scriptedDriver({ act: { moved: false, position: 1, atEnd: true } });
  assert.deepEqual(await hostOn(atEnd.driver).execute({ action: 'scroll', direction: 'down', to: 'end' }, NOTES), { ok: false, detail: 'Already at the bottom: there’s no more to scroll.' });
  assert.equal(atEnd.calls[0][1].action, 'scrollEnd');
});

test('scroll_to pages through until the words are on screen, and hands that screen on', async () => {
  const far = { ...structuredClone(NOTES), snapshot: 13, elements: [...NOTES.elements, { id: 6, role: 'row', label: 'Packing list', depth: 5 }] };
  const reads = [structuredClone(NOTES), far];
  const { calls, driver } = scriptedDriver({ act: { moved: true }, snapshot: () => reads.shift() });
  const result = await hostOn(driver).execute({ action: 'scroll_to', text: 'packing list' }, NOTES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.found, ['[6] row "Packing list"']);
  assert.equal(result.snapshot, far, 'its numbers are the next step\'s');
  assert.equal(calls.filter(([cmd]) => cmd === 'act').length, 2);

  const wheeled = { ...structuredClone(NOTES), snapshot: 14, elements: [...NOTES.elements, { id: 6, role: 'row', label: 'Packing list' }] };
  const reads2 = [wheeled];
  const stiff = scriptedDriver({ act: { moved: false, atEnd: false }, frontmost: inFront(50), snapshot: () => reads2.shift() });
  const byWheel = await hostOn(stiff.driver).execute({ action: 'scroll_to', text: 'packing list' }, NOTES);
  assert.equal(byWheel.ok, true, 'it can\'t scroll itself, so the wheel does');
  assert.equal(stiff.calls.filter(([cmd]) => cmd === 'scroll').length, 1);

  const nowhere = scriptedDriver({ act: { moved: false, atEnd: false }, frontmost: inFront(50), snapshot: () => structuredClone(NOTES) });
  const missing = await hostOn(nowhere.driver).execute({ action: 'scroll_to', text: 'packing list' }, NOTES);
  assert.deepEqual([missing.ok, missing.detail], [false, 'Couldn’t find “packing list” by scrolling.']);
  assert.equal(missing.snapshot?.snapshot, 11, 'the screen read last is the next step\'s');
  assert.equal(nowhere.calls.filter(([cmd]) => cmd === 'scroll').length, 2, 'down, then up once, then stopped');
});

test('clicks: no answer is never clicked again, right is the control\'s menu, double is the pointer\'s', async () => {
  const timeout = Object.assign(new Error('jester-driver: "act" timed out'), { code: 'timeout' });
  const slow = scriptedDriver({ act: timeout });
  const pressed = await hostOn(slow.driver).execute({ action: 'click', id: 5 }, NOTES);
  assert.equal(pressed.ok, true);
  assert.equal(pressed.busy, true);
  assert.equal(slow.calls.some(([cmd]) => cmd === 'click'), false, 'a dialog may be up: a click could do it twice');

  const right = scriptedDriver();
  assert.deepEqual(await hostOn(right.driver).execute({ action: 'click', id: 1, button: 'right' }, NOTES), { ok: true, detail: '' });
  assert.deepEqual(right.calls, [['act', { snapshot: 11, element: 1, action: 'showMenu' }]]);

  // A double click is the element's own open where it has one; else the pointer's.
  const opens = scriptedDriver({ act: { element: {}, via: 'AXOpen' } });
  assert.deepEqual(await hostOn(opens.driver).execute({ action: 'click', id: 1, count: 2 }, NOTES), { ok: true, detail: 'opened it' });
  assert.deepEqual(opens.calls, [['act', { snapshot: 11, element: 1, action: 'open' }]]);
  const double = scriptedDriver({ frontmost: inFront(50), act: (params) => (params.action === 'open' ? Promise.reject(new Error('AXOpen didn\'t work on it')) : {}) });
  assert.equal((await hostOn(double.driver).execute({ action: 'click', id: 1, count: 2 }, NOTES)).ok, true);
  assert.deepEqual(double.calls.at(-1), ['click', { x: 150, y: 80, count: 2 }]);
});

test('a drag presses, moves in steps and lets go — and lets go even when a move fails', async () => {
  const { calls, driver } = scriptedDriver({ frontmost: inFront(50) });
  assert.deepEqual(await hostOn(driver).execute({ action: 'drag', from: 1, to: 2 }, NOTES), { ok: true });
  const input = calls.filter(([cmd]) => cmd !== 'frontmost' && cmd !== 'act');
  assert.deepEqual(input[0], ['move', { x: 150, y: 80 }]);
  assert.deepEqual(input[1], ['button', { x: 150, y: 80, down: true }]);
  assert.deepEqual(input.at(-2), ['move', { x: 150, y: 120 }]);
  assert.deepEqual(input.at(-1), ['button', { x: 150, y: 120, down: false }]);

  let moves = 0;
  const failing = scriptedDriver({ frontmost: inFront(50), move: () => (++moves === 3 ? Promise.reject(new Error('gone')) : {}) });
  await assert.rejects(hostOn(failing.driver).execute({ action: 'drag', from: 1, to: 2 }, NOTES));
  assert.deepEqual(failing.calls.at(-1), ['button', { x: 150, y: 120, down: false }]);
});

test('a click where it is drawn goes where the driver checked, never onto what covers it or where it was', async () => {
  const refused = new Error('none of the accessibility ways of clicking it worked');
  // Pressed through accessibility (here by selecting the row): no pointer at all.
  const selected = scriptedDriver({ act: { element: {}, via: 'select', selected: true } });
  assert.deepEqual(await hostOn(selected.driver).execute({ action: 'click', id: 1 }, NOTES), { ok: true, detail: 'selected it' });
  assert.equal(selected.calls.some(([cmd]) => cmd === 'click'), false);

  // Refused: brought to the front, then the point the driver hit-tested, not the snapshot's middle.
  const aimed = scriptedDriver({ frontmost: inFront(50), act: (params) => (params.action === 'point' ? { x: 60, y: 70, checked: true } : Promise.reject(refused)) });
  assert.deepEqual(await hostOn(aimed.driver).execute({ action: 'click', id: 1 }, NOTES), { ok: true, detail: 'clicked where it is drawn' });
  assert.deepEqual(
    aimed.calls.map(([cmd, params]) => (cmd === 'act' ? `act ${params.action}` : cmd)),
    ['act press', 'frontmost', 'act point', 'click']
  );
  assert.deepEqual(aimed.calls.at(-1), ['click', { x: 60, y: 70 }]);

  // Something on top of it: nothing is clicked, and the model hears what.
  const covered = scriptedDriver({ frontmost: inFront(50), act: (params) => (params.action === 'point' ? { covered: 'the sheet “Save”' } : Promise.reject(refused)) });
  assert.deepEqual(await hostOn(covered.driver).execute({ action: 'click', id: 1 }, NOTES), { ok: false, detail: 'It’s covered by the sheet “Save”, so it wasn’t clicked.' });
  assert.equal(covered.calls.some(([cmd]) => cmd === 'click'), false);
  const coveredDouble = scriptedDriver({ frontmost: inFront(50), act: (params) => (params.action === 'open' ? Promise.reject(refused) : { covered: 'the window “Inbox” of Slack' }) });
  assert.equal((await hostOn(coveredDouble.driver).execute({ action: 'click', id: 1, count: 2 }, NOTES)).ok, false);
  assert.equal(coveredDouble.calls.some(([cmd]) => cmd === 'click'), false);
  const coveredDrop = scriptedDriver({ frontmost: inFront(50), act: (params) => (params.element === 2 ? { covered: 'the popover' } : { x: 1, y: 2, checked: true }) });
  assert.equal((await hostOn(coveredDrop.driver).execute({ action: 'drag', from: 1, to: 2 }, NOTES)).detail, 'It’s covered by the popover, so it wasn’t dropped there.');
  assert.equal(coveredDrop.calls.some(([cmd]) => cmd === 'button' || cmd === 'move'), false, 'nothing picked up');

  // Gone since the screen was read: something else may be where it was drawn.
  const gone = new Error("it's gone from the screen since it was read; read it again");
  const left = scriptedDriver({ frontmost: inFront(50), act: gone });
  assert.deepEqual(await hostOn(left.driver).execute({ action: 'click', id: 1 }, NOTES), { ok: false, detail: 'The screen changed before it could be pressed; nothing was done.' });
  assert.equal((await hostOn(left.driver).execute({ action: 'click', id: 1, button: 'right' }, NOTES)).ok, false);
  assert.equal((await hostOn(left.driver).execute({ action: 'scroll', id: 3, direction: 'down' }, NOTES)).ok, false);
  assert.equal(left.calls.some(([cmd]) => ['click', 'scroll'].includes(cmd)), false);
  const goneByThePoint = scriptedDriver({ frontmost: inFront(50), act: (params) => Promise.reject(params.action === 'point' ? gone : refused) });
  assert.deepEqual(await hostOn(goneByThePoint.driver).execute({ action: 'click', id: 1 }, NOTES), { ok: false, detail: 'The screen changed before it could be clicked; nothing was done.' });
  assert.equal(goneByThePoint.calls.some(([cmd]) => cmd === 'click'), false);
});

test('a checked step says what changed and carries the new screen; the loop uses it as the next', async () => {
  const sheet = { ...structuredClone(NOTES), snapshot: 14, elements: [...NOTES.elements, { id: 6, role: 'button', label: 'New Folder' }] };
  const reads = [NOTES, sheet];
  const { driver } = scriptedDriver({ snapshot: () => reads.shift() || sheet, menu: (params) => ({ path: ['File', 'New Folder'], enabled: true, pressed: params.press }) });
  const prompts = [];
  const replies = [{ action: { action: 'menu', path: 'File > New Folder' } }, { action: { action: 'click', id: 6 } }, { action: { action: 'finish', say: 'Done.', success: true } }];
  const model = async ({ prompt }) => (prompts.push(JSON.parse(prompt)), { json: replies.shift() });
  const result = await runDesktopAgent({ goal: 'make a new folder', host: hostOn(driver), model, confirm: async () => assert.fail('nothing to ask'), platform: 'darwin' });
  assert.equal(result.ok, true);
  assert.equal(prompts[1].lastResult.changes, 'New: button "New Folder".');
  assert.match(prompts[1].screen, /\[6\] button "New Folder"/, 'the screen read after the step is the next step\'s');
  assert.equal(prompts[2].lastResult.changes, 'Nothing on screen changed.');
  assert.deepEqual(result.trace.map((step) => step.action), [{ action: 'menu', path: 'File > New Folder' }, { action: 'click' }]);
});

test('a menu command that deletes asks first, by the titles the app really has', async () => {
  const { calls, driver } = scriptedDriver({ snapshot: NOTES, menu: (params) => ({ path: ['File', 'Delete Note'], enabled: true, pressed: params.press }) });
  const asked = [];
  const replies = [{ action: { action: 'menu', path: 'File > Delete' } }];
  const result = await runDesktopAgent({ goal: 'delete this note', host: hostOn(driver), model: async () => ({ json: replies.shift() }), confirm: async (ask) => (asked.push(ask), false), platform: 'darwin' });
  assert.equal(result.declined, true);
  assert.deepEqual(asked, [{ label: 'Choose File › Delete Note', reason: 'it may send, buy or delete something' }]);
  assert.equal(calls.some(([cmd, params]) => cmd === 'menu' && params.press), false, 'refused, never pressed');
});

test('a learned task is done again without the model, and stops where it isn\'t as it was', async () => {
  const steps = [
    { action: { action: 'menu', path: 'File > New Note' }, app: 'Notes' },
    { action: { action: 'type', text: 'hello world' }, app: 'Notes' }
  ];
  const after = { ...structuredClone(NOTES), snapshot: 15, elements: [...NOTES.elements, { id: 6, role: 'row', label: 'New Note' }] };
  const written = structuredClone(after);
  written.snapshot = 16;
  written.elements[3].value = 'hello world';
  const reads = [NOTES, after, written];
  const { calls, driver } = scriptedDriver({
    snapshot: () => reads.shift() || written,
    menu: (params) => ({ path: ['File', 'New Note'], enabled: true, pressed: params.press }),
    frontmost: inFront(50),
    focused: { element: {}, app: { pid: 50 } }
  });
  const acting = [];
  assert.deepEqual(await replaySteps({ steps, goal: 'open a new note and write hello world', host: hostOn(driver), onStep: (step) => acting.push(step.label), platform: 'darwin' }), { ok: true });
  assert.deepEqual(acting, ['Choose File › New Note', 'Type “hello world”']);
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'text'), [['text', { text: 'hello world' }]]);

  // The control it pressed last time isn't there: it stops, and says where.
  const gone = await replaySteps({ steps: [{ action: { action: 'click' }, app: 'Notes', target: { role: 'button', label: 'Share' } }], goal: 'share it', host: hostOn(scriptedDriver({ snapshot: NOTES }).driver) });
  assert.deepEqual(gone, { ok: false, step: 0, detail: 'there was no “Share” on screen' });
  // Another app in front: nothing is done to it.
  const wrongApp = await replaySteps({ steps, goal: 'x', host: hostOn(scriptedDriver({ snapshot: { ...NOTES, app: { name: 'Mail', pid: 51 } } }).driver) });
  assert.deepEqual(wrongApp, { ok: false, step: 0, detail: 'Notes wasn’t in front' });
  // A step that would now need the user's OK is the assistant's, not a replay's.
  const risky = await replaySteps({ steps: [{ action: { action: 'click' }, app: 'Finder', target: { role: 'button', label: 'OK' } }], goal: 'x', host: hostOn(scriptedDriver({ snapshot: DIALOG }).driver) });
  assert.deepEqual(risky, { ok: false, step: 0, detail: 'it would need your OK now' });
  // A click that changed the screen the first time and doesn't now is a replay that went wrong…
  const noop = await replaySteps({ steps: [{ action: { action: 'click' }, app: 'Notes', target: { role: 'row', label: 'Trip ideas' }, changed: true }], goal: 'x', host: hostOn(scriptedDriver({ snapshot: NOTES }).driver) });
  assert.deepEqual(noop, { ok: false, step: 0, detail: 'nothing changed after “Click “Trip ideas””' });
  // …one that didn't then (an unseen effect) isn't expected to now.
  const unseen = await replaySteps({ steps: [{ action: { action: 'click' }, app: 'Notes', target: { role: 'row', label: 'Trip ideas' }, changed: false }], goal: 'x', host: hostOn(scriptedDriver({ snapshot: NOTES }).driver) });
  assert.deepEqual(unseen, { ok: true });
});

test('review fixes: what deletes, sends or fills a password field asks first or never happens', () => {
  const kind = (action, screen) => classify(action, { screen, goal: '' }).category;
  const login = { app: { name: 'Google Chrome' }, elements: [{ id: 0, role: 'textfield', label: 'Email' }, { id: 1, role: 'password', label: 'Password', focused: true }] };
  assert.equal(kind({ action: 'menu', path: 'Edit > Paste', resolved: ['Edit', 'Paste'] }, login), 'blocked', 'Paste into a password field is typing into it');
  assert.equal(kind({ action: 'drag', from: 0, to: 1 }, login), 'blocked');
  const chat = { app: { name: 'Messages' }, elements: [{ id: 0, role: 'textfield', label: 'Message', focused: true }] };
  assert.equal(kind({ action: 'type', id: 0, text: 'Running late.\nSee you at 10.' }, chat), 'sensitive', 'a line break is an Enter');
  const confirmFocused = { ...DIALOG, elements: DIALOG.elements.map((item) => (item.id === 2 ? { ...item, focused: true } : item)) };
  assert.equal(kind({ action: 'press', keys: 'enter' }, confirmFocused), 'sensitive', 'Enter on the focused OK of a delete dialog');
  assert.equal(kind({ action: 'press', keys: 'enter' }, DIALOG), 'sensitive', 'Enter with nothing focused: the default button may be the delete');
  const list = { app: { name: 'Finder' }, elements: [{ id: 0, role: 'row', label: 'Taxes.pdf', selected: true, focused: true }] };
  assert.equal(kind({ action: 'press', keys: 'delete' }, list), 'sensitive', 'Delete on a selected file');
  assert.equal(kind({ action: 'press', keys: 'shift+delete', times: 3 }, list), 'sensitive');
  assert.equal(kind({ action: 'press', keys: 'backspace' }, chat), 'browse', 'in a text field it takes out characters');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'SystemSettings' }, elements: [{ id: 0, role: 'switch', label: 'Bluetooth' }] }), 'sensitive', 'Windows\' Settings');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'explorer' }, window: { title: 'Control Panel\\All Control Panel Items\\Sound' }, elements: [{ id: 0, role: 'button', label: 'Apply' }] }), 'sensitive');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'explorer' }, window: { title: 'Downloads' }, elements: [{ id: 0, role: 'row', label: 'notes.txt' }] }), 'browse', 'an ordinary Explorer window');
  assert.equal(kind({ action: 'menu', path: 'File > Move to Bin', resolved: ['File', 'Move to Bin'] }, NOTES), 'sensitive');
  assert.equal(kind({ action: 'menu', path: 'Message > Move to > Deleted Items' }, NOTES), 'sensitive');
});

test('review fixes: a group is judged on the focus it leaves, and a key that moved it ends the group', async () => {
  const gmail = {
    snapshot: 20,
    app: { name: 'Google Chrome', pid: 70 },
    window: { title: 'Gmail' },
    elements: [{ id: 0, role: 'textfield', label: 'Subject', focused: true }, { id: 1, role: 'textarea', label: 'Message body' }, { id: 2, role: 'button', label: 'Send' }]
  };
  // Tab, tab, Enter: where the tabs landed is unknown, so Enter waits for a fresh look (it was on Send).
  const sent = [];
  const replies = [{ actions: [{ action: 'press', keys: 'tab', times: 2 }, { action: 'press', keys: 'enter' }] }, { action: { action: 'finish', say: 'Stopped.', success: false } }];
  const prompts = [];
  const tabbed = await runDesktopAgent({
    goal: 'email Sam',
    host: { observe: async () => ({ ok: true, snapshot: gmail }), execute: async (action) => (sent.push(action.keys), { ok: true }) },
    model: async ({ prompt }) => (prompts.push(JSON.parse(prompt)), { json: replies.shift() }),
    confirm: async () => assert.fail('nothing was judged without a fresh look'),
    platform: 'darwin'
  });
  assert.equal(tabbed.ok, false);
  assert.deepEqual(sent, ['tab'], 'Enter wasn\'t pressed');
  assert.match(prompts[1].lastResult.detail, /moved the focus/);

  // Typing into the composer, then Enter: judged as Enter in a message field, so it asks.
  const asked = [];
  await runDesktopAgent({
    goal: 'email Sam',
    host: { observe: async () => ({ ok: true, snapshot: gmail }), execute: async () => ({ ok: true }) },
    model: (() => {
      const queue = [{ actions: [{ action: 'type', id: 1, text: 'On my way' }, { action: 'press', keys: 'enter' }] }];
      return async () => ({ json: queue.shift() || { action: { action: 'finish', say: 'x', success: false } } });
    })(),
    confirm: async (ask) => (asked.push(ask.label), false),
    platform: 'darwin'
  });
  assert.deepEqual(asked, ['Press ↩'], 'judged with the composer focused');
});

test('review fixes: a menu that opened isn\'t right-clicked again, a changed screen isn\'t clicked, and unknown focus types nothing', async () => {
  const busyMenu = scriptedDriver({ act: { element: null, busy: true } });
  const right = await hostOn(busyMenu.driver).execute({ action: 'click', id: 1, button: 'right' }, NOTES);
  assert.equal(right.ok, true);
  assert.equal(busyMenu.calls.some(([cmd]) => cmd === 'click'), false);
  const slowMenu = scriptedDriver({ act: Object.assign(new Error('timed out'), { code: 'timeout' }) });
  assert.equal((await hostOn(slowMenu.driver).execute({ action: 'click', id: 1, button: 'right' }, NOTES)).ok, true);
  assert.equal(slowMenu.calls.some(([cmd]) => cmd === 'click'), false);

  const stale = scriptedDriver({ act: new Error('the screen has been read again since; use the newest numbers'), frontmost: inFront(50) });
  assert.deepEqual(await hostOn(stale.driver).execute({ action: 'click', id: 5 }, NOTES), { ok: false, detail: 'The screen changed before it could be pressed; nothing was done.' });
  assert.equal(stale.calls.some(([cmd]) => cmd === 'click'), false);

  const timeout = Object.assign(new Error('jester-driver: "focused" timed out'), { code: 'timeout' });
  const blind = scriptedDriver({ frontmost: inFront(50), focused: timeout });
  assert.deepEqual(await hostOn(blind.driver).execute({ action: 'type', text: 'hello' }, NOTES), { ok: false, detail: 'Jester couldn’t tell what has the keyboard focus, so nothing was typed.' });
  assert.equal(blind.calls.filter(([cmd]) => cmd === 'focused').length, 2, 'asked again once');
  assert.equal(blind.calls.some(([cmd]) => cmd === 'text'), false);
  // Secure input on, the focus on a page not read yet: as a password field.
  const asleep = scriptedDriver({ frontmost: inFront(50), focused: { element: { role: 'AXWebArea', secure: false }, app: { pid: 50 }, secureInput: true } });
  assert.deepEqual(await hostOn(asleep.driver).execute({ action: 'type', text: 'hunter2' }, NOTES), { ok: false, detail: 'Jester never types into password fields.' });
});

test('review fixes: the trace keeps a scroll to the end and what each step changed', async () => {
  const replies = [{ action: { action: 'scroll', direction: 'down', to: 'end', id: 3 } }, { action: { action: 'finish', say: 'Done.', success: true } }];
  const { trace } = await runDesktopAgent({
    goal: 'scroll to the bottom of my note',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async () => ({ ok: true, changed: true, changes: 'New: …' }) },
    model: async () => ({ json: replies.shift() }),
    confirm: async () => true,
    platform: 'darwin'
  });
  assert.deepEqual(trace, [{ action: { action: 'scroll', direction: 'down', to: 'end' }, app: 'Notes', target: { role: 'textarea', label: 'Note body' }, changed: true }]);
});

test('second review: a menu path, a Control Panel page and a dialog\'s default button are judged whole', () => {
  const kind = (action, screen) => classify(action, { screen, goal: '' }).category;
  assert.equal(kind({ action: 'menu', path: 'Message > Move to > Bin' }, NOTES), 'sensitive', 'every title counts');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'Mail' }, elements: [{ id: 0, role: 'menuitem', label: 'Bin' }] }), 'sensitive');
  const power = { app: { name: 'explorer' }, window: { title: 'Power Options' }, elements: [{ id: 0, role: 'textfield', label: 'Address', value: 'Control Panel › Hardware and Sound › Power Options' }, { id: 1, role: 'button', label: 'Save changes' }] };
  assert.equal(kind({ action: 'click', id: 1 }, power), 'sensitive', 'a Control Panel page, by its address bar');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'ShellExperienceHost' }, elements: [{ id: 0, role: 'switch', label: 'Bluetooth' }] }), 'sensitive', 'Quick Settings');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'ApplicationFrameHost' }, window: { title: 'Settings' }, elements: [{ id: 0, role: 'switch', label: 'Wi-Fi' }] }), 'sensitive');
  const askAgain = { ...DIALOG, elements: [...DIALOG.elements, { id: 3, role: 'checkbox', label: 'Don’t ask again', focused: true }] };
  assert.equal(kind({ action: 'press', keys: 'enter' }, askAgain), 'sensitive', 'Enter from a checkbox is the default button');
  const named = { ...DIALOG, elements: [{ id: 0, role: 'text', label: 'Delete the folder “Taxes”? Type its name to confirm.' }, { id: 1, role: 'textfield', label: 'Name' }, { id: 2, role: 'button', label: 'Delete' }] };
  assert.equal(kind({ action: 'type', id: 1, text: 'Taxes', enter: true }, named), 'sensitive', 'typed into the dialog, then Enter');
});

test('second review: a group action is judged on the screen before the group too, the stricter way', async () => {
  const askAgain = { ...DIALOG, snapshot: 30, elements: [...DIALOG.elements, { id: 3, role: 'checkbox', label: 'Don’t ask again' }] };
  const asked = [];
  const replies = [{ actions: [{ action: 'click', id: 3 }, { action: 'press', keys: 'enter' }] }];
  await runDesktopAgent({
    goal: 'delete the folder',
    host: { observe: async () => ({ ok: true, snapshot: askAgain }), execute: async () => ({ ok: true }) },
    model: async () => ({ json: replies.shift() || { action: { action: 'finish', say: 'x', success: false } } }),
    confirm: async (ask) => (asked.push(ask.label), false),
    platform: 'darwin'
  });
  assert.deepEqual(asked, ['Press ↩'], 'a click doesn\'t always take the focus: Enter may still be the dialog\'s Delete');
});

test('second review: a focus that can\'t be read while secure input is on is a password field\'s; menus wait for a known focus', async () => {
  const hidden = scriptedDriver({ frontmost: inFront(50), focused: { element: null, app: null, secureInput: true } });
  assert.deepEqual(await hostOn(hidden.driver).execute({ action: 'type', text: 'hunter2' }, NOTES), { ok: false, detail: 'Jester never types into password fields.' });
  const timeout = Object.assign(new Error('jester-driver: "focused" timed out'), { code: 'timeout' });
  const blind = scriptedDriver({ focused: timeout, menu: { path: ['Edit', 'Paste'], enabled: true } });
  assert.match((await hostOn(blind.driver).execute({ action: 'menu', path: 'Edit > Paste', resolved: ['Edit', 'Paste'] }, NOTES)).detail, /couldn’t tell what has the keyboard focus/);
  assert.equal(blind.calls.some(([cmd, params]) => cmd === 'menu' && params.press), false);
});

test('second review: no answer to an append is never typed again, and a changed screen isn\'t scrolled', async () => {
  const late = scriptedDriver({ act: Object.assign(new Error('jester-driver: "act" timed out'), { code: 'timeout' }) });
  assert.deepEqual(await hostOn(late.driver).execute({ action: 'type', id: 3, text: ' eggs' }, NOTES), { ok: false, detail: 'The app was busy: the text may have been added. Check the field before trying again.' });
  assert.equal(late.calls.some(([cmd]) => cmd === 'text'), false);
  const stale = scriptedDriver({ act: new Error('the screen has been read again since; use the newest numbers'), frontmost: inFront(50) });
  assert.deepEqual(await hostOn(stale.driver).execute({ action: 'scroll', direction: 'down' }, NOTES), { ok: false, detail: 'The screen changed before it could be scrolled; nothing was done.' });
  assert.equal(stale.calls.some(([cmd]) => cmd === 'scroll'), false);
});

test('second review: steps whose effect can\'t be seen aren\'t progress, and a cancel during a read does nothing', async () => {
  let steps = 0;
  const result = await runDesktopAgent({
    goal: 'play the video',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async () => ((steps += 1), { ok: true, unseen: true, changes: 'No visible change (its effect may not show here).' }) },
    model: async () => ({ json: { action: { action: 'press', keys: 'space' } } }),
    confirm: async () => true,
    platform: 'darwin'
  });
  assert.equal(result.say, 'I wasn’t getting anywhere, so I stopped.');
  assert.equal(steps, 2);

  const controller = new AbortController();
  const host = {
    observe: async () => (controller.abort(), { ok: true, snapshot: NOTES }),
    execute: async () => assert.fail('cancelled while it read: nothing is done')
  };
  const replayed = await replaySteps({ steps: [{ action: { action: 'click' }, app: 'Notes', target: { role: 'row', label: 'Trip ideas' } }], goal: 'x', host, signal: controller.signal });
  assert.equal(replayed.cancelled, true);
});

test('stuck detectors: failures add up across groups led by a click that worked', async () => {
  const done = [];
  let reads = 0;
  const host = {
    observe: async () => ({ ok: true, snapshot: { ...NOTES, window: { title: `Notes ${(reads += 1)}` } } }),
    execute: async (action) => (done.push(action.action), action.action === 'click' ? { ok: true } : { ok: false, detail: 'No.' })
  };
  const result = await runDesktopAgent({
    goal: 'tidy my note',
    host,
    model: async () => ({ json: { actions: [{ action: 'click', id: 1 }, { action: 'press', keys: 'cmd+k' }] } }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.equal(result.say, 'I got stuck: No.');
  assert.deepEqual(done, ['click', 'press', 'click', 'press', 'click', 'press'], 'three groups, not forever');
});

test('stuck detectors: a key left for a fresh look counts as a failure, each time', async () => {
  let reads = 0;
  const pressed = [];
  const result = await runDesktopAgent({
    goal: 'clear my note',
    host: { observe: async () => ({ ok: true, snapshot: { ...NOTES, window: { title: `Notes ${(reads += 1)}` } } }), execute: async (action) => (pressed.push(action.keys), { ok: true }) },
    model: async () => ({ json: { actions: [{ action: 'press', keys: 'cmd+a' }, { action: 'press', keys: 'backspace' }] } }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.match(result.say, /^I got stuck: Not done: a key before it in the group may have moved the focus/);
  assert.deepEqual(pressed, ['cmd+a', 'cmd+a', 'cmd+a'], '⌫ never pressed');
});

test('stuck detectors: a step in the middle of a group, unchecked, is no progress', async () => {
  let group = 0;
  const host = {
    observe: async () => ({ ok: true, snapshot: { ...NOTES, window: { title: `Notes ${(group += 1)}` } } }),
    // The last of each group changes nothing; the one before it can't say.
    execute: async (action, screen, { verify }) => ({ ok: true, ...(verify ? { changed: false } : {}) })
  };
  const result = await runDesktopAgent({
    goal: 'tidy my note',
    host,
    model: async () => ({ json: { actions: [{ action: 'click', id: 1 }, { action: 'click', id: 2 }] } }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.equal(result.say, 'I wasn’t getting anywhere, so I stopped.');
  assert.equal(result.actions, 6, 'three idle groups');
});

test('stuck detectors: the same actions on the same screen a third time aren\'t done', async () => {
  let done = 0;
  const steps = [];
  const result = await runDesktopAgent({
    goal: 'tidy my note',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async () => ((done += 1), { ok: true, changed: true }) },
    model: async () => ({ json: { action: { action: 'click', id: 1 } } }),
    confirm: async () => assert.fail('nothing to ask'),
    onStep: (step) => steps.push(step.phase),
    platform: 'darwin'
  });
  assert.equal(result.say, 'I wasn’t getting anywhere, so I stopped.');
  assert.equal(done, 2);
  assert.equal(steps.filter((phase) => phase === 'seen').length, 3, 'the third was asked for, and refused');
});

test('stuck detectors: unusable replies add up, even with good ones between them', async () => {
  const notJson = () => Object.assign(new Error('The model did not return valid JSON.'), { code: 'invalid_json' });
  const replies = [notJson(), { action: { action: 'wait', ms: 100 } }, notJson(), { action: { action: 'click', id: 1 } }, notJson(), { action: { action: 'finish', say: 'Never reached.', success: true } }];
  const invalid = [];
  const result = await runDesktopAgent({
    goal: 'tidy my note',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async () => ({ ok: true, changed: true }) },
    model: async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { json: next };
    },
    confirm: async () => assert.fail('nothing to ask'),
    onStep: (step) => step.phase === 'invalid' && invalid.push(step.code),
    platform: 'darwin'
  });
  assert.equal(result.say, 'The AI model’s replies didn’t make sense, so I stopped.');
  assert.deepEqual(invalid, ['invalid_json', 'invalid_json', 'invalid_json'], 'the log can tell what kind');
});

test('every model call counts, and the run stops at the limit however good the replies', async () => {
  let calls = 0;
  let reads = 0;
  const result = await runDesktopAgent({
    goal: 'tidy my note',
    host: { observe: async () => ({ ok: true, snapshot: { ...NOTES, window: { title: `Notes ${(reads += 1)}` } } }), execute: async () => ({ ok: true, changed: true }) },
    model: async () => ((calls += 1), { json: { action: { action: 'click', id: 1 } } }),
    confirm: async () => assert.fail('nothing to ask'),
    limits: { maxActions: 1000, maxModelCalls: 4, runBudgetMs: 60000, failures: 3, invalidReplies: 2, invalidTotal: 3, idleSteps: 3 },
    platform: 'darwin'
  });
  assert.equal(calls, 4);
  assert.equal(result.say, 'That was taking too many steps, so I stopped.');
});

test('⌘A then a field\'s id types over the selection; ⌘A then ⌫ is still left for a fresh look', async () => {
  const done = [];
  const replies = [{ actions: [{ action: 'press', keys: 'cmd+a' }, { action: 'type', id: 3, text: 'eggs' }] }, { action: { action: 'finish', say: 'Done.', success: true } }];
  await runDesktopAgent({
    goal: 'change my note to eggs',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async (action) => (done.push(action), { ok: true }) },
    model: async () => ({ json: replies.shift() }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.deepEqual(done, [{ action: 'press', keys: 'cmd+a' }, { action: 'type', id: 3, text: 'eggs', mode: 'insert' }], 'added to the end, it would have doubled');

  // What was asked for outright stands: a replace is still the host's to refuse.
  const named = [];
  const explicit = [{ actions: [{ action: 'press', keys: 'cmd+a' }, { action: 'type', id: 3, text: 'eggs', mode: 'replace' }] }, { action: { action: 'finish', say: 'Done.', success: true } }];
  await runDesktopAgent({
    goal: 'change my note to eggs',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async (action) => (named.push(action), { ok: true }) },
    model: async () => ({ json: explicit.shift() }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.equal(named[1].mode, 'replace');

  // A key between them moves the selection on.
  const later = [];
  const moved = [{ actions: [{ action: 'press', keys: 'cmd+a' }, { action: 'click', id: 1 }, { action: 'type', id: 3, text: 'eggs' }] }, { action: { action: 'finish', say: 'Done.', success: true } }];
  await runDesktopAgent({
    goal: 'change my note to eggs',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async (action) => (later.push(action), { ok: true }) },
    model: async () => ({ json: moved.shift() }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.equal(later[2].mode, undefined);

  const pressed = [];
  const prompts = [];
  const refused = [{ actions: [{ action: 'press', keys: 'cmd+a' }, { action: 'press', keys: 'backspace' }] }, { action: { action: 'finish', say: 'Stopped.', success: false } }];
  await runDesktopAgent({
    goal: 'clear my note',
    host: { observe: async () => ({ ok: true, snapshot: NOTES }), execute: async (action) => (pressed.push(action.keys), { ok: true }) },
    model: async ({ prompt }) => (prompts.push(JSON.parse(prompt)), { json: refused.shift() }),
    confirm: async () => assert.fail('nothing to ask'),
    platform: 'darwin'
  });
  assert.deepEqual(pressed, ['cmd+a'], '⌫ wasn\'t pressed');
  assert.match(prompts[1].lastResult.detail, /moved the focus/);
});

test('a text area with nothing in it takes a replace as an add; one with something in it never does', async () => {
  const blank = { ...NOTES, elements: NOTES.elements.map((item) => (item.id === 3 ? { ...item, value: undefined } : item)) };
  const empty = scriptedDriver({ act: (params) => (params.action === 'read' ? { value: '', length: 0, contains: true } : { value: params.value, landed: true }) });
  assert.deepEqual(await hostOn(empty.driver).execute({ action: 'type', id: 3, text: 'eggs', mode: 'replace' }, blank), { ok: true, landed: true });
  assert.deepEqual(empty.calls.map(([, params]) => params.action), ['read', 'appendValue']);

  // Shown as empty, but holding something (a blank line): not replaced, and said why.
  const lines = scriptedDriver({ act: { value: '\n\n', length: 2, contains: true } });
  const refused = await hostOn(lines.driver).execute({ action: 'type', id: 3, text: 'eggs', mode: 'replace' }, blank);
  assert.match(refused.detail, /isn’t replaced whole/);
  assert.match(refused.detail, /press cmd\+a and type/);
  assert.equal(lines.calls.some(([, params]) => params.action === 'appendValue'), false);

  // Can't be read: not known to be empty.
  const unread = scriptedDriver({ act: {} });
  assert.match((await hostOn(unread.driver).execute({ action: 'type', id: 3, text: 'eggs', mode: 'replace' }, blank)).detail, /isn’t replaced whole/);
});

test('text that\'s read back says so, and nothing that wasn\'t does', async () => {
  const written = scriptedDriver({ act: (params) => (params.action === 'appendValue' ? { value: `milk${params.value}`, landed: true } : {}) });
  assert.deepEqual(await hostOn(written.driver).execute({ action: 'type', id: 3, text: ' eggs' }, NOTES), { ok: true, landed: true });
  // Typed by keys, and read back.
  const keys = scriptedDriver({ act: (params) => (params.action === 'read' ? { value: 'eggs', length: 4, contains: true } : Promise.reject(new Error('web pages don’t take text set this way'))), frontmost: inFront(50), focused: { element: {}, app: { pid: 50 } } });
  assert.deepEqual(await hostOn(keys.driver).execute({ action: 'type', id: 0, text: 'eggs' }, NOTES), { ok: true, landed: true });
  // Typed where the cursor is: nothing to read.
  const blind = scriptedDriver({ frontmost: inFront(50), focused: { element: {}, app: { pid: 50 } } });
  assert.deepEqual(await hostOn(blind.driver).execute({ action: 'type', text: 'eggs' }, NOTES), { ok: true });
  // A field read, whatever else it holds, and a password field never.
  const peeked = scriptedDriver({ act: { value: 'milk', tail: 'milk', length: 4, contains: false } });
  assert.deepEqual(await hostOn(peeked.driver).peek(NOTES, 3, 'eggs'), { contains: false, length: 4, value: 'milk', tail: 'milk' });
  const login = { ...NOTES, elements: [{ id: 0, role: 'password', label: 'Password' }] };
  assert.equal(await hostOn(peeked.driver).peek(login, 0), null);
});

test('a patient step looks once more before saying nothing changed; an app that opened gets a moment', async () => {
  const later = { ...structuredClone(NOTES), snapshot: 15, elements: [...NOTES.elements, { id: 6, role: 'row', label: 'New Note' }] };
  const reads = [NOTES, later];
  const { driver } = scriptedDriver({ snapshot: () => reads.shift(), frontmost: inFront(50), focused: { element: {}, app: { pid: 50 } } });
  const waits = [];
  const patient = await hostOn(driver, { wait: async (ms) => void waits.push(ms) }).execute({ action: 'press', keys: 'cmd+n' }, NOTES, { verify: true, patient: true });
  assert.equal(patient.changed, true);
  assert.deepEqual(waits, [350, 700]);
  const hasty = scriptedDriver({ snapshot: NOTES, frontmost: inFront(50), focused: { element: {}, app: { pid: 50 } } });
  assert.equal((await hostOn(hasty.driver).execute({ action: 'press', keys: 'cmd+n' }, NOTES, { verify: true })).unseen, true);

  const settled = [];
  await hostOn(scriptedDriver().driver, { wait: async (ms) => void settled.push(ms) }).execute({ action: 'open_app', name: 'Notes' }, NOTES);
  assert.deepEqual(settled, [400]);
  const missing = [];
  await hostOn(scriptedDriver().driver, { wait: async (ms) => void missing.push(ms), openApp: async () => ({ ok: false, text: 'No.' }) }).execute({ action: 'open_app', name: 'Nope' }, NOTES);
  assert.deepEqual(missing, []);
});
