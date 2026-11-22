/**
 * What Jester's hands gained on 2026-11-22 from a second look at Atticus (github.com/SaarthurR/atticus-mac, 2.0.1):
 * a click checked by eye when nothing readable changed, a click on a place in a picture, text put in after words
 * already in a field, a shortcut known by the menu command it stands for, the menu bar's icons and what they open,
 * and a task that stays on its app when another comes in front of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { askLabel, classify, describeAction, validateTurn } from '../desktop/src/main/agent/actions.js';
import { createDesktopHost, glanceChanged } from '../desktop/src/main/agent/host.js';
import { pictureNote, runDesktopAgent } from '../desktop/src/main/agent/loop.js';
import { systemPrompt } from '../desktop/src/main/agent/prompt.js';
import { createWindowShot, SHOT_MAX_HEIGHT, viewOf } from '../desktop/src/main/window-shot.js';

const frame = (x, y, w = 80, h = 30) => ({ x, y, w, h });
/** A drawing app: two buttons the screen lists, and a canvas it says nothing of. */
const SKETCH = {
  snapshot: 21,
  app: { name: 'Sketchy', pid: 70 },
  window: { title: 'Untitled', frame: frame(100, 50, 1000, 600) },
  elements: [
    { id: 0, role: 'button', label: 'Brush', depth: 3, frame: frame(110, 60, 60, 30) },
    { id: 1, role: 'button', label: 'Send to printer', depth: 3, frame: frame(180, 60, 120, 30) },
    { id: 2, role: 'textarea', label: 'Caption', value: 'milk, eggs', depth: 3, frame: frame(110, 600, 600, 40) },
    { id: 3, role: 'text', label: 'Layers', depth: 3, frame: frame(900, 60, 80, 20) }
  ]
};

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
const names = (calls) => calls.map(([cmd, params]) => (cmd === 'act' ? `act ${params.action}` : cmd));
/** A glance: 64 × 40 grey bytes as hex, all one grey but for a patch. */
const grey = (level, patch = null) => Array.from({ length: 64 * 40 }, (_, at) => (patch && at < patch.count ? patch.level : level).toString(16).padStart(2, '0')).join('');

test('two glances differ when their greys are far enough apart; a missing one is no verdict', () => {
  assert.equal(glanceChanged(grey(40), grey(40)), false);
  assert.equal(glanceChanged(grey(40), grey(40, { count: 400, level: 200 })), true, 'a button’s new look');
  assert.equal(glanceChanged(grey(40), grey(41)), false, 'a shade of noise is none');
  assert.equal(glanceChanged(grey(40), grey(40, { count: 8, level: 255 })), false, 'a few pixels are a caret’s blink');
  assert.equal(glanceChanged(grey(40), null), false);
  assert.equal(glanceChanged('', ''), false);
  assert.equal(glanceChanged(grey(40), 'ff'), false, 'not the same patch');
});

test('a click that changed nothing readable is checked by eye: pixels that changed mean it took', async () => {
  // Pressed through accessibility; the screen reads the same after; the canvas looks different.
  const looks = [grey(40), grey(40, { count: 600, level: 220 })];
  const painted = scriptedDriver({ frontmost: inFront(70), snapshot: { ...SKETCH, snapshot: 22 }, glance: () => ({ allowed: true, gray: looks.shift() }) });
  const took = await hostOn(painted.driver, { exclude: 999 }).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(took.changed, true);
  assert.equal(took.changes, 'The screen changed where it was clicked, though no control reads differently.');
  assert.deepEqual(painted.calls.filter(([cmd]) => cmd === 'glance').map(([, params]) => params), [{ x: 140, y: 75, exclude: 999 }, { x: 140, y: 75, exclude: 999 }], 'the control’s middle, before and after, without Jester’s own windows');
  assert.equal(painted.calls.some(([cmd]) => cmd === 'click' || cmd === 'move'), false, 'no pointer: it was an accessibility press');

  // The same press, and nothing looks different either: nothing changed.
  const dead = scriptedDriver({ frontmost: inFront(70), snapshot: { ...SKETCH, snapshot: 22 }, glance: { allowed: true, gray: grey(40) } });
  const none = await hostOn(dead.driver).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(none.changed, false);
  assert.equal(none.changes, 'Nothing on screen changed.');

  // Something readable changed: that's what's said, and nobody looks again.
  const read = scriptedDriver({ frontmost: inFront(70), snapshot: { ...SKETCH, snapshot: 22, elements: [...SKETCH.elements, { id: 4, role: 'button', label: 'Undo' }] }, glance: { allowed: true, gray: grey(40) } });
  const said = await hostOn(read.driver).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(said.changes, 'New: button "Undo".');
  assert.equal(read.calls.filter(([cmd]) => cmd === 'glance').length, 1, 'only the look before');

  // An unchecked step (one in the middle of a group) is never glanced at.
  const middle = scriptedDriver({ frontmost: inFront(70) });
  await hostOn(middle.driver).execute({ action: 'click', id: 0 }, SKETCH);
  assert.equal(middle.calls.some(([cmd]) => cmd === 'glance'), false);
});

test('a click with the real pointer is looked at once the pointer is on it: hovering is not the change', async () => {
  const refused = new Error('none of the accessibility ways of clicking it worked');
  const looks = [grey(40), grey(90), grey(90)];
  const { calls, driver } = scriptedDriver({
    frontmost: inFront(70),
    snapshot: { ...SKETCH, snapshot: 22 },
    act: (params) => (params.action === 'point' ? { x: 150, y: 80, checked: true } : Promise.reject(refused)),
    glance: () => ({ allowed: true, gray: looks.shift() })
  });
  const result = await hostOn(driver).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.deepEqual(names(calls).slice(0, 8), ['frontmost', 'glance', 'act press', 'frontmost', 'act point', 'move', 'glance', 'click']);
  assert.deepEqual(calls.find(([cmd]) => cmd === 'move')[1], { x: 150, y: 80 });
  // Before the pointer came it was grey 40; hovered, 90; after the click, still 90: the click itself showed nothing.
  assert.equal(result.changed, false, 'the hover look is the "before"');
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'glance').at(-1)[1], { x: 150, y: 80 }, 'and it’s looked at where the click went');
});

test('without Screen Recording nothing is looked at, and it isn’t tried again for a minute', async () => {
  let time = 1000;
  const { calls, driver } = scriptedDriver({ frontmost: inFront(70), snapshot: { ...SKETCH, snapshot: 22 }, glance: { allowed: false } });
  const host = hostOn(driver, { now: () => time });
  const first = await host.execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(first.changes, 'Nothing on screen changed.', 'judged by what can be read, as before');
  await host.execute({ action: 'click', id: 0 }, { ...SKETCH, snapshot: 22 }, { verify: true });
  assert.equal(calls.filter(([cmd]) => cmd === 'glance').length, 1);
  time += 61_000;
  await host.execute({ action: 'click', id: 0 }, { ...SKETCH, snapshot: 22 }, { verify: true });
  assert.equal(calls.filter(([cmd]) => cmd === 'glance').length, 2, 'it may have been allowed since');
});

test('replies: a click is an id or a place in the picture, a type may go after words, a menu-bar icon has a name', () => {
  for (const good of [
    { action: { action: 'click', x: 412, y: 230, what: 'the red circle' } },
    { action: { action: 'click', x: 0, y: 0, what: 'corner', count: 2 } },
    { action: { action: 'type', id: 2, text: ' (oat)', after: 'milk' } },
    { action: { action: 'type', id: 2, text: '!', after: 'eggs', enter: true } },
    { action: { action: 'menu_bar', name: 'Wi-Fi' } },
    { actions: [{ action: 'click', x: 10, y: 10, what: 'first dot' }, { action: 'click', x: 40, y: 10, what: 'second dot' }] }
  ]) {
    assert.doesNotThrow(() => validateTurn(good), JSON.stringify(good));
  }
  for (const bad of [
    { action: { action: 'click', x: 412, y: 230 } },
    { action: { action: 'click', x: 412, what: 'half a place' } },
    { action: { action: 'click', id: 1, x: 412, y: 230, what: 'both' } },
    { action: { action: 'click', id: 1, what: 'a name for a control that has one' } },
    { action: { action: 'click', x: -4, y: 230, what: 'off the picture' } },
    { action: { action: 'click', x: 99999, y: 230, what: 'off the picture' } },
    { action: { action: 'click', x: 412, y: 230, what: 'x', at: { x: 1, y: 2 } } },
    { action: { action: 'click', x: 412, y: 230, what: 'x', under: 'Cancel' } },
    { action: { action: 'type', text: 'x', after: 'milk' } },
    { action: { action: 'type', id: 2, text: 'x', after: 'milk', mode: 'append' } },
    { action: { action: 'type', id: 2, text: 'x', after: '' } },
    { action: { action: 'press', keys: 'cmd+s', runs: ['File', 'Save'] } },
    { action: { action: 'menu_bar' } },
    { actions: [{ action: 'menu_bar', name: 'Wi-Fi' }, { action: 'click', id: 1 }] }
  ]) {
    assert.throws(() => validateTurn(bad), Error, JSON.stringify(bad));
  }
  assert.equal(describeAction({ action: 'click', x: 4, y: 5, what: 'the red circle' }, SKETCH), 'Click “the red circle”');
  assert.equal(describeAction({ action: 'click', x: 4, y: 5, what: 'the red circle', at: { x: 1, y: 2 }, under: 'Record' }, SKETCH), 'Click “Record”', 'the name read under it, once there is one');
  assert.equal(describeAction({ action: 'type', id: 2, text: ' (oat)', after: 'milk' }, SKETCH), 'Type “(oat)” after “milk” in “Caption”');
  assert.equal(describeAction({ action: 'menu_bar', name: 'Wi-Fi' }, SKETCH), 'Open “Wi-Fi” in the menu bar');
  assert.match(systemPrompt('darwin'), /^menu_bar: name/m);
  assert.doesNotMatch(systemPrompt('win32'), /menu_bar/, 'the menu bar is the Mac’s');
  assert.doesNotMatch(systemPrompt('darwin'), /x, y \(its middle/, 'a place in a picture is told only to a model that sees one');
  assert.match(systemPrompt('darwin', { see: true }), /x, y \(its middle/);
  assert.match(pictureNote({ width: 1280, height: 831 }), /It is 1280 × 831 pixels/);
  assert.doesNotMatch(pictureNote(null), /pixels/);
});

/** A host that has just taken a picture of SKETCH: 1000 × 600 points shown in 500 × 300 pixels. */
async function pictured(answers = {}, screen = SKETCH) {
  const scripted = scriptedDriver({ snapshot: screen, ...answers });
  const picture = Object.assign(async () => ({ ok: true, image: { mimeType: 'image/jpeg', data: 'eA==' }, marked: [0, 1], view: { x: 100, y: 50, w: 1000, h: 600, width: 500, height: 300 } }), { allowed: () => true });
  const host = hostOn(scripted.driver, { picture });
  const taken = await host.execute({ action: 'screenshot' }, screen);
  assert.equal(taken.ok, true);
  assert.deepEqual(taken.size, { width: 500, height: 300 });
  return { ...scripted, host, screen: taken.snapshot };
}

test('a place in a picture is found on screen: inside a listed control it is that control, else a spot with what can be read of it', async () => {
  // (20, 12) in the picture is (140, 74) on screen: inside "Brush", so it's a click on Brush by its id.
  const inside = await pictured();
  assert.deepEqual(await inside.host.locate({ action: 'click', x: 20, y: 12, what: 'the brush', count: 2 }, inside.screen), { ok: true, action: { action: 'click', count: 2, id: 0 } });
  assert.equal(inside.calls.some(([cmd]) => cmd === 'elementAt'), false, 'nothing more to ask');

  // (250, 150) is the canvas, (600, 350) on screen: no control there; accessibility names what is.
  const named = await pictured({ elementAt: { element: { role: 'AXImage', description: 'Record', frame: frame(580, 330, 40, 40) }, actionable: null, app: { pid: 70, name: 'Sketchy' } } });
  assert.deepEqual(await named.host.locate({ action: 'click', x: 250, y: 150, what: 'the red circle' }, named.screen), {
    ok: true,
    action: { action: 'click', x: 250, y: 150, what: 'the red circle', at: { x: 600, y: 350 }, under: 'Record' }
  });
  assert.deepEqual(named.calls.at(-1), ['elementAt', { x: 600, y: 350, wait: false }]);

  // A whole canvas called "Editor" names nothing at this spot; nor does nothing at all.
  const canvas = await pictured({ elementAt: { element: { role: 'AXGroup', description: 'Editor', frame: frame(100, 100, 1000, 500) }, actionable: null, app: { pid: 70 } } });
  assert.equal((await canvas.host.locate({ action: 'click', x: 250, y: 150, what: 'a dot' }, canvas.screen)).action.under, undefined);
  const silent = await pictured({ elementAt: new Error('nothing readable at 600,350') });
  assert.deepEqual((await silent.host.locate({ action: 'click', x: 250, y: 150, what: 'a dot' }, silent.screen)).action.at, { x: 600, y: 350 });

  // Words there are its name: a page whose "Delete account" is only text is still asked about.
  const words = await pictured({ elementAt: { element: { role: 'AXStaticText', value: 'Delete account', frame: frame(560, 340, 120, 20) }, actionable: null, app: { pid: 70 } } });
  assert.equal((await words.host.locate({ action: 'click', x: 250, y: 150, what: 'a link' }, words.screen)).action.under, 'Delete account');

  // Another app's window over it, a password field, off the picture: nothing is clicked.
  const other = await pictured({ elementAt: { element: { role: 'AXButton', title: 'Buy', frame: frame(580, 330, 40, 40) }, actionable: null, app: { pid: 71, name: 'Shop' } } });
  assert.deepEqual(await other.host.locate({ action: 'click', x: 250, y: 150, what: 'a button' }, other.screen), { ok: false, detail: 'That spot is in Shop’s window, not Sketchy.' });
  const secret = await pictured({ elementAt: { element: { role: 'AXTextField', secure: true, frame: frame(580, 330, 40, 40) }, actionable: null, app: { pid: 70 } } });
  assert.equal((await secret.host.locate({ action: 'click', x: 250, y: 150, what: 'a box' }, secret.screen)).detail, 'Jester never types into password fields.');
  const off = await pictured();
  assert.match((await off.host.locate({ action: 'click', x: 900, y: 150, what: 'far right' }, off.screen)).detail, /outside the picture, which is 500 × 300/);
});

test('a place in a picture is good for the screen pictured, and no other', async () => {
  const fresh = hostOn(scriptedDriver().driver);
  assert.match((await fresh.locate({ action: 'click', x: 250, y: 150, what: 'a dot' }, SKETCH)).detail, /take a screenshot/);
  const { host, screen } = await pictured();
  assert.match((await host.locate({ action: 'click', x: 250, y: 150, what: 'a dot' }, { ...screen, snapshot: screen.snapshot + 1 })).detail, /there isn’t one/, 'a later read: the picture is of a screen gone by');
  host.begin();
  assert.equal((await host.locate({ action: 'click', x: 250, y: 150, what: 'a dot' }, screen)).ok, false, 'nor is it the next task’s');
});

test('a spot is clicked with the pointer, its app in front; and judged by what could be read of it', async () => {
  const { calls, driver } = scriptedDriver({ frontmost: inFront(70) });
  const spot = { action: 'click', x: 250, y: 150, what: 'the red circle', at: { x: 600, y: 350 } };
  assert.deepEqual(await hostOn(driver).execute(spot, SKETCH), { ok: true, detail: 'clicked that spot' });
  assert.deepEqual(calls, [['frontmost', undefined], ['click', { x: 600, y: 350 }]]);
  const twice = scriptedDriver({ frontmost: inFront(70) });
  await hostOn(twice.driver).execute({ ...spot, count: 2, button: 'right' }, SKETCH);
  assert.deepEqual(twice.calls.at(-1), ['click', { x: 600, y: 350, button: 'right', count: 2 }]);
  const stuck = scriptedDriver({ frontmost: inFront(5) });
  assert.equal((await hostOn(stuck.driver, { behind: () => false }).execute(spot, SKETCH)).ok, false, 'it couldn’t be brought forward: nothing is clicked');
  assert.equal(stuck.calls.some(([cmd]) => cmd === 'click'), false);
  assert.equal((await hostOn(scriptedDriver().driver).execute({ action: 'click', x: 250, y: 150, what: 'unplaced' }, SKETCH)).ok, false, 'a place that was never found is never clicked');

  const kind = (action, screen = SKETCH) => classify(action, { screen, goal: '' });
  assert.deepEqual(kind(spot), { category: 'sensitive', reason: 'it’s a spot whose name can’t be read' });
  assert.equal(kind({ ...spot, under: 'Record' }).category, 'browse');
  assert.equal(kind({ ...spot, under: 'Send' }).category, 'sensitive');
  assert.equal(kind({ ...spot, under: 'Record', what: 'the delete cross' }).category, 'sensitive', 'what the model called it can only make it more careful');
  const asking = { ...SKETCH, elements: [{ id: 0, role: 'text', label: 'Delete this drawing?' }] };
  assert.equal(kind({ ...spot, under: 'OK' }, asking).category, 'sensitive', 'a plain OK to a dialog that deletes');
  assert.equal(kind({ ...spot, under: 'OK' }).category, 'browse');
  assert.equal(askLabel(spot, SKETCH, { reason: 'it’s a spot whose name can’t be read' }), 'Click what looks like “the red circle” in Sketchy');
  assert.equal(askLabel({ ...spot, under: 'Send' }, SKETCH), 'Press “Send” in Sketchy');
});

test('the loop settles a place before judging it, asks about what it can’t read, and learns nothing from it', async () => {
  const done = [];
  const asked = [];
  const host = {
    observe: async () => ({ ok: true, snapshot: SKETCH }),
    locate: async (action) => (action.x === 40 ? { ok: true, action: { action: 'click', id: 1 } } : { ok: true, action: { ...action, at: { x: 600, y: 350 } } }),
    execute: async (action) => (done.push(action), { ok: true, changed: true, changes: 'x' })
  };
  const replies = [{ action: { action: 'click', x: 250, y: 150, what: 'the red circle' } }, { action: { action: 'click', x: 40, y: 12, what: 'the printer' } }, { action: { action: 'finish', say: 'Done.', success: true } }];
  const result = await runDesktopAgent({ goal: 'record', host, model: async () => ({ json: replies.shift() }), confirm: async (ask) => (asked.push(ask.label), true), platform: 'darwin' });
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ['Click what looks like “the red circle” in Sketchy', 'Press “Send to printer” in Sketchy'], 'the spot nothing is known of; then the control the second place was in, by its own name');
  assert.deepEqual(done, [{ action: 'click', x: 250, y: 150, what: 'the red circle', at: { x: 600, y: 350 } }, { action: 'click', id: 1 }]);
  assert.equal(result.trace, undefined, 'where a place in a picture is next time is anyone’s guess');

  // A place that can't be found is a failed step, said to the model, and nothing is done.
  const lost = { observe: async () => ({ ok: true, snapshot: SKETCH }), locate: async () => ({ ok: false, detail: 'take a screenshot first' }), execute: async () => assert.fail('nothing to do') };
  const prompts = [];
  const tries = [{ action: { action: 'click', x: 1, y: 1, what: 'a dot' } }, { action: { action: 'finish', say: 'No.', success: false } }];
  await runDesktopAgent({ goal: 'x', host: lost, model: async ({ prompt }) => (prompts.push(JSON.parse(prompt)), { json: tries.shift() }), confirm: async () => true, platform: 'darwin' });
  assert.equal(prompts[1].lastResult.detail, 'take a screenshot first');
});

test('text goes in after words already in a field: set outright where the field takes it, typed where it doesn’t', async () => {
  // A field of the Mac's own: through accessibility, read back, no keys and no need to be in front.
  const native = scriptedDriver({ act: (params) => (params.action === 'insertAfter' ? { landed: true, value: 'milk (oat), eggs' } : {}) });
  assert.deepEqual(await hostOn(native.driver).execute({ action: 'type', id: 2, text: ' (oat)', after: 'milk' }, SKETCH), { ok: true, landed: true });
  assert.deepEqual(native.calls, [['act', { snapshot: 21, element: 2, action: 'insertAfter', value: ' (oat)', after: 'milk' }]]);

  // A web page's: the caret is put after the words, and the text typed there with the app in front.
  const typed = scriptedDriver({
    frontmost: inFront(70),
    focused: { element: { role: 'AXTextArea' }, app: { pid: 70 } },
    act: (params) => {
      if (params.action === 'insertAfter') return Promise.reject(new Error('web pages don\'t take text set this way; type it instead'));
      if (params.action === 'read') return params.value ? { contains: true, value: 'milk (oat), eggs', length: 16 } : { value: 'milk, eggs', length: 10 };
      return {};
    }
  });
  assert.deepEqual(await hostOn(typed.driver).execute({ action: 'type', id: 2, text: ' (oat)', after: 'milk' }, SKETCH), { ok: true, landed: true });
  assert.deepEqual(names(typed.calls), ['act insertAfter', 'frontmost', 'act focus', 'focused', 'act read', 'act caretAfter', 'text', 'act read']);
  assert.deepEqual(typed.calls.find(([cmd, params]) => cmd === 'act' && params.action === 'caretAfter')[1], { snapshot: 21, element: 2, action: 'caretAfter', after: 'milk' });
  assert.deepEqual(typed.calls.at(-1)[1].value, 'milk (oat)', 'read back as the words with the text right after them');

  // Twice in the field, or not there: which place was meant is anyone's guess, and nothing is typed.
  const twice = scriptedDriver({ act: new Error('the field holds “milk” 2 times: give more of the words before the place') });
  assert.deepEqual(await hostOn(twice.driver).execute({ action: 'type', id: 2, text: 'x', after: 'milk' }, SKETCH), { ok: false, detail: 'the field holds “milk” 2 times: give more of the words before the place' });
  assert.equal(twice.calls.some(([cmd]) => cmd === 'text' || cmd === 'key'), false);

  // It went in, but not as asked; or the app never answered: never typed again on a guess.
  const wrong = scriptedDriver({ act: { landed: false, value: 'milk, eggs (oat)' } });
  assert.match((await hostOn(wrong.driver).execute({ action: 'type', id: 2, text: ' (oat)', after: 'milk' }, SKETCH)).detail, /the field reads “milk, eggs \(oat\)”/);
  const slow = scriptedDriver({ act: Object.assign(new Error('timed out'), { code: 'timeout' }) });
  assert.match((await hostOn(slow.driver).execute({ action: 'type', id: 2, text: ' (oat)', after: 'milk' }, SKETCH)).detail, /may have gone in/);
  assert.equal(slow.calls.some(([cmd]) => cmd === 'text'), false);

  // The typed text didn't show up after the words: said, and Enter isn't pressed.
  const lost = scriptedDriver({
    frontmost: inFront(70),
    focused: { element: { role: 'AXTextArea' }, app: { pid: 70 } },
    act: (params) => (params.action === 'insertAfter' ? Promise.reject(new Error('type it instead')) : params.action === 'read' ? { contains: false, value: 'milk, eggs', length: 10 } : {})
  });
  const missed = await hostOn(lost.driver).execute({ action: 'type', id: 2, text: ' (oat)', after: 'milk', enter: true }, SKETCH);
  assert.match(missed.detail, /didn’t land after “milk”.*so Enter wasn’t pressed/);
  assert.equal(lost.calls.some(([cmd]) => cmd === 'key'), false);
  assert.equal((await hostOn(scriptedDriver().driver).execute({ action: 'type', id: 2, text: 'x\ty', after: 'milk' }, SKETCH)).ok, false, 'a tab is still never typed');
});

const MAIL = { snapshot: 30, app: { name: 'Mail', pid: 80 }, window: { title: 'New Message' }, elements: [{ id: 0, role: 'textarea', label: 'Body', focused: true, frame: frame(0, 0, 400, 300) }] };

test('a shortcut is known by the menu command it stands for: judged by its name, and said', async () => {
  const send = scriptedDriver({ shortcut: { found: true, path: ['Message', 'Send'], enabled: true, web: false, pressed: false } });
  const action = { action: 'press', keys: 'cmd+shift+d' };
  assert.deepEqual(await hostOn(send.driver).prepare(action, MAIL), { ok: true });
  assert.deepEqual(send.calls, [['shortcut', { pid: 80, key: 'd', modifiers: ['cmd', 'shift'] }]]);
  assert.deepEqual(action.runs, ['Message', 'Send']);
  assert.equal(classify(action, { screen: MAIL }).category, 'sensitive', '⇧⌘D sends, though no key of it says so');
  assert.equal(askLabel(action, MAIL, { reason: 'it may send, buy or delete something' }), 'Choose “Send” in Mail');
  assert.equal(classify({ action: 'press', keys: 'cmd+shift+d' }, { screen: MAIL }).category, 'browse', 'unknown, it was pressed unasked before');
  assert.equal(classify({ action: 'press', keys: 'cmd+s', runs: ['File', 'Save'] }, { screen: MAIL }).category, 'browse');
  assert.equal(classify({ action: 'press', keys: 'cmd+shift+j', runs: ['Message', 'Move to', 'Junk Bin'] }, { screen: MAIL }).category, 'sensitive');

  // Keys without ⌘, another system, a menu-bar panel: nothing is looked up.
  for (const [keys, extra, screen] of [['enter', {}, MAIL], ['shift+a', {}, MAIL], ['cmd+s', { platform: 'win32' }, MAIL], ['cmd+s', {}, { ...MAIL, panel: true }]]) {
    const none = scriptedDriver();
    const step = { action: 'press', keys };
    await hostOn(none.driver, extra).prepare(step, screen);
    assert.deepEqual([none.calls.length, step.runs], [0, undefined], keys);
  }
  // No item for it, or the menus can't be read: the keys are pressed, as before.
  for (const answer of [{ found: false }, new Error('timed out')]) {
    const step = { action: 'press', keys: 'cmd+k' };
    assert.deepEqual(await hostOn(scriptedDriver({ shortcut: answer }).driver).prepare(step, MAIL), { ok: true });
    assert.equal(step.runs, undefined);
  }
});

test('with its app in front a shortcut is the keys; behind another, it is the menu command chosen where the app is', async () => {
  const saved = { action: 'press', keys: 'cmd+s', runs: ['File', 'Save'] };
  const front = scriptedDriver({ frontmost: inFront(80), focused: { element: { role: 'AXTextArea' }, app: { pid: 80 } } });
  assert.deepEqual(await hostOn(front.driver).execute(saved, MAIL), { ok: true, detail: 'that’s File › Save' });
  assert.deepEqual(names(front.calls), ['frontmost', 'focused', 'key']);
  assert.equal(front.calls.some(([cmd]) => cmd === 'shortcut'), false);

  let activated = 0;
  const behind = scriptedDriver({ frontmost: inFront(5), shortcut: { found: true, path: ['File', 'Save'], pressed: true } });
  const result = await hostOn(behind.driver, { activate: async () => (activated += 1) }).execute({ ...saved, times: 2 }, MAIL);
  assert.deepEqual(result, { ok: true, detail: 'chose File › Save' });
  assert.deepEqual(behind.calls.filter(([cmd]) => cmd === 'shortcut').map(([, params]) => params), Array(2).fill({ pid: 80, key: 's', modifiers: ['cmd'], press: true }));
  assert.equal(activated, 0, 'the app stays where it is');
  assert.equal(behind.calls.some(([cmd]) => cmd === 'key'), false);

  // A web page keeps its keys (it may handle them itself); a command greyed out or refused falls back to them.
  for (const [action, answer] of [[{ ...saved, web: true }, { pressed: true }], [saved, new Error('“File › Save” is greyed out right now')]]) {
    let brought = 0;
    let frontNow = 5;
    const keys = scriptedDriver({ frontmost: () => inFront(frontNow), shortcut: answer, focused: { element: { role: 'AXTextArea' }, app: { pid: 80 } } });
    const pressed = await hostOn(keys.driver, { activate: async () => ((brought += 1), (frontNow = 80)) }).execute(action, MAIL);
    assert.equal(pressed.ok, true);
    assert.equal(brought, 1, 'brought forward for the keys');
    assert.deepEqual(keys.calls.at(-1), ['key', { key: 's', modifiers: ['cmd'] }]);
  }
  // No answer: it may have opened a dialog. Done, and never pressed again as keys.
  const dialog = scriptedDriver({ frontmost: inFront(5), shortcut: Object.assign(new Error('timed out'), { code: 'timeout' }) });
  const opened = await hostOn(dialog.driver).execute(saved, MAIL);
  assert.equal(opened.ok && opened.busy, true);
  assert.equal(dialog.calls.some(([cmd]) => cmd === 'key'), false);
});

const WIFI = {
  snapshot: 41,
  panel: true,
  app: { name: 'Control Center', pid: 844 },
  window: { title: 'Wi‑Fi, connected, 3 bars', frame: frame(1100, 30, 320, 400) },
  elements: [{ id: 0, role: 'switch', label: 'Wi‑Fi', checked: true }, { id: 1, role: 'row', label: 'Home network' }, { id: 2, role: 'button', label: 'Wi‑Fi Settings…' }]
};

test('a menu-bar icon opens by name, and what it opens is the screen until it has closed', async () => {
  let open = false;
  const { calls, driver } = scriptedDriver({
    frontmost: inFront(70),
    menuBar: () => ((open = true), { pressed: 'Wi‑Fi, connected, 3 bars', pid: 844, opened: true, busy: false }),
    snapshot: (params) => (params.panel ? (open ? WIFI : Promise.reject(new Error('what the menu-bar icon opened has closed'))) : SKETCH)
  });
  const host = hostOn(driver, { exclude: 999 });
  const result = await host.execute({ action: 'menu_bar', name: 'wifi' }, SKETCH, { verify: true });
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'opened “Wi‑Fi, connected, 3 bars”');
  assert.deepEqual(calls.find(([cmd]) => cmd === 'menuBar')[1], { press: 'wifi', exclude: 999 });
  assert.equal(result.snapshot.panel, true, 'the panel is the next step’s screen');
  assert.match(result.changes, /^Now in Control Center/);
  assert.equal((await host.observe()).snapshot.app.name, 'Control Center');

  // Pressed through accessibility there: its app is never "in front", and isn't asked to be.
  const before = calls.length;
  assert.equal((await host.execute({ action: 'click', id: 1 }, WIFI)).ok, true);
  assert.deepEqual(names(calls.slice(before)), ['act press']);

  // Closed (chosen from, clicked away): the window in front is the screen again.
  open = false;
  assert.equal((await host.observe()).snapshot.app.name, 'Sketchy');
  const reads = calls.filter(([cmd]) => cmd === 'snapshot').length;
  await host.observe();
  assert.equal(calls.filter(([cmd]) => cmd === 'snapshot').length, reads + 1, 'and the panel isn’t looked for again');

  // A wrong name comes back with the names there are; nothing opening is said.
  const wrong = hostOn(scriptedDriver({ menuBar: new Error('no “wify” among the menu bar\'s icons; there is: Focus, Battery, Clock') }).driver);
  assert.match((await wrong.execute({ action: 'menu_bar', name: 'wify' }, SKETCH)).detail, /there is: Focus, Battery, Clock/);
  const shut = hostOn(scriptedDriver({ menuBar: { pressed: 'Claude', opened: false } }).driver);
  assert.match((await shut.execute({ action: 'menu_bar', name: 'Claude' }, SKETCH)).detail, /nothing opened that can be read/);
});

test('opening an icon asks nothing; changing what it shows is changing the computer’s settings', () => {
  const kind = (action, screen) => classify(action, { screen, goal: '' }).category;
  assert.equal(kind({ action: 'menu_bar', name: 'Wi-Fi' }, SKETCH), 'browse');
  assert.equal(kind({ action: 'menu_bar', name: 'Wi-Fi' }, { app: { name: 'System Settings' }, elements: [] }), 'browse', 'whatever is in front');
  assert.equal(kind({ action: 'click', id: 0 }, WIFI), 'sensitive', 'the Wi-Fi switch');
  assert.equal(kind({ action: 'click', id: 1 }, WIFI), 'sensitive', 'a network to join: a row there is no way of getting around');
  assert.equal(kind({ action: 'click', id: 2 }, WIFI), 'sensitive');
  assert.equal(kind({ action: 'scroll', direction: 'down' }, WIFI), 'browse');
  const menu = { panel: true, app: { name: 'Cisco Secure Client' }, elements: [{ id: 0, role: 'menuitem', label: 'Show Window' }, { id: 1, role: 'menuitem', label: 'Sign Out' }] };
  assert.equal(kind({ action: 'click', id: 0 }, menu), 'browse', 'an app’s own menu is judged as any app’s controls are');
  assert.equal(kind({ action: 'click', id: 1 }, menu), 'sensitive');
});

test('a task whose app has gone behind another stays on it: read where it is, not brought forward', async () => {
  // Safari is in front (the user's gone there); the task is in Sketchy, pressing through accessibility.
  const after = { ...SKETCH, snapshot: 22, elements: [...SKETCH.elements, { id: 4, role: 'button', label: 'Undo' }] };
  let front = 5;
  let activated = 0;
  const { calls, driver } = scriptedDriver({ frontmost: () => inFront(front), snapshot: (params) => (params.pid === 70 ? after : { snapshot: 90, app: { name: 'Safari', pid: 5 }, window: { title: 'News' }, elements: [] }) });
  const host = hostOn(driver, { activate: async () => (activated += 1) });
  const result = await host.execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(result.changes, 'New: button "Undo".', 'checked on its own window, not on Safari’s');
  assert.equal(result.snapshot.app.name, 'Sketchy');
  assert.equal(activated, 0);
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'snapshot').map(([, params]) => params.pid), [70]);
  assert.equal((await host.observe()).snapshot.app.name, 'Sketchy', 'and so are the steps after');

  // In front again (the user came back, or a step needed it there): read as any window in front is.
  front = 70;
  const fronted = calls.length;
  await host.observe();
  assert.deepEqual(calls.slice(fronted).filter(([cmd]) => cmd === 'snapshot').map(([, params]) => params.pid), [undefined]);

  // A step that itself brought another app forward (a link that opens elsewhere) is read where it led.
  front = 5;
  const opens = scriptedDriver({ frontmost: () => inFront(front), act: () => ((front = 6), {}), snapshot: (params) => (params.pid ? after : { snapshot: 91, app: { name: 'Preview', pid: 6 }, window: { title: 'Export' }, elements: [] }) });
  const led = await hostOn(opens.driver).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.equal(led.snapshot.app.name, 'Preview');
  assert.match(led.changes, /^Now in Preview/);

  // A new task holds on to nothing of the last one's.
  front = 5;
  const next = scriptedDriver({ frontmost: () => inFront(5), snapshot: (params) => (params.pid === 70 ? after : { snapshot: 92, app: { name: 'Safari', pid: 5 }, window: { title: 'News' }, elements: [] }) });
  const again = hostOn(next.driver);
  await again.execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  again.begin();
  assert.equal((await again.observe()).snapshot.app.name, 'Safari');

  // With its app in front, nothing is different: the window in front is what's read.
  const usual = scriptedDriver({ frontmost: inFront(70), snapshot: after });
  await hostOn(usual.driver).execute({ action: 'click', id: 0 }, SKETCH, { verify: true });
  assert.deepEqual(usual.calls.filter(([cmd]) => cmd === 'snapshot').map(([, params]) => params.pid), [undefined]);
});

test('a learned task keeps the step, not what was worked out for one screen', async () => {
  const host = {
    observe: async () => ({ ok: true, snapshot: MAIL }),
    prepare: async (action) => (action.action === 'press' ? ((action.runs = ['File', 'Save']), { ok: true }) : { ok: true }),
    execute: async () => ({ ok: true, changed: true, changes: 'x' })
  };
  const replies = [{ action: { action: 'press', keys: 'cmd+s' } }, { action: { action: 'type', id: 0, text: '!', after: 'hello' } }, { action: { action: 'menu_bar', name: 'Wi-Fi' } }, { action: { action: 'finish', say: 'Done.', success: true } }];
  const result = await runDesktopAgent({ goal: 'save', host, model: async () => ({ json: replies.shift() }), confirm: async () => true, platform: 'darwin' });
  assert.deepEqual(result.trace.map((step) => step.action), [{ action: 'press', keys: 'cmd+s' }, { action: 'type', text: '!', after: 'hello' }, { action: 'menu_bar', name: 'Wi-Fi' }]);
  for (const step of result.trace) assert.doesNotThrow(() => validateTurn({ action: { ...step.action, ...(step.target ? { id: 0 } : {}) } }), 'each can be done again');
});

/** Electron's nativeImage, as far as the picture uses it. */
function fakeImage(width, height, log) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: (rect) => fakeImage(rect.width, rect.height, log),
    resize: ({ width: to }) => (log.push(['resize', to]), fakeImage(to, Math.round((height * to) / width), log)),
    toBitmap: () => Buffer.alloc(width * height * 4, 255)
  };
}

test('a picture says what of the screen it shows, and is never taller than a model takes whole', async () => {
  // The window's frame both ways: on a Mac they're the same; on Windows at 150% the driver's are half as big again.
  assert.deepEqual(viewOf({ x: 100, y: 50, w: 800, h: 600 }, { x: 100, y: 50, w: 800, h: 600 }, { x: 100, y: 50, w: 800, h: 600 }, { width: 1280, height: 960 }), { x: 100, y: 50, w: 800, h: 600, width: 1280, height: 960 });
  assert.deepEqual(viewOf({ x: 150, y: 75, w: 1200, h: 900 }, { x: 100, y: 50, w: 800, h: 600 }, { x: 100, y: 50, w: 800, h: 600 }, { width: 800, height: 600 }), { x: 150, y: 75, w: 1200, h: 900, width: 800, height: 600 });
  // Half off the left of its display: only the half pictured is the view.
  assert.deepEqual(viewOf({ x: -400, y: 0, w: 800, h: 600 }, { x: -400, y: 0, w: 800, h: 600 }, { x: 0, y: 0, w: 400, h: 600 }, { width: 800, height: 1200 }), { x: 0, y: 0, w: 400, h: 600, width: 800, height: 1200 });

  const log = [];
  const shoot = createWindowShot({
    capturer: { getSources: async () => [{ display_id: '1', thumbnail: fakeImage(3024, 1964, log) }] },
    screen: { getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, size: { width: 1512, height: 982 }, scaleFactor: 2 }) },
    images: { createFromBitmap: () => ({ toJPEG: () => Buffer.from('jpeg') }) },
    allowed: () => true
  });
  // A tall, narrow window: 400 × 900 points is 800 × 1800 pixels, taller than a model takes.
  const tall = await shoot({ snapshot: 1, app: { pid: 1 }, window: { frame: { x: 100, y: 40, w: 400, h: 900 } }, elements: [] });
  assert.ok(tall.height <= SHOT_MAX_HEIGHT, `${tall.height} tall`);
  assert.deepEqual([tall.view.x, tall.view.y, tall.view.w, tall.view.h], [100, 40, 400, 900]);
  assert.deepEqual([tall.view.width, tall.view.height], [tall.width, tall.height]);
  // One scale both ways: a place in the picture is a place on screen.
  assert.ok(Math.abs(tall.view.w / tall.width - tall.view.h / tall.height) < 0.01);
});

/**
 * Working behind (the app the task is in isn't in front): clicks, keys and a web page's text go to the app itself
 * (the driver's clickBehind, keyBehind, textBehind), and nothing is brought forward.
 */
const PAGE = {
  snapshot: 50,
  app: { name: 'Browser', pid: 90 },
  window: { title: 'Shop', frame: frame(0, 0, 900, 700), id: 4242 },
  elements: [
    { id: 0, role: 'searchfield', label: 'Search', value: 'old', depth: 3, frame: frame(100, 40, 300, 30) },
    { id: 1, role: 'link', label: 'Deals', depth: 3, frame: frame(100, 100, 80, 20) },
    { id: 2, role: 'textarea', label: 'Review', value: 'Good', depth: 3, frame: frame(100, 200, 400, 100) }
  ]
};
const refusedPress = new Error('none of the accessibility ways of clicking it worked');
/** A driver for a page behind another app (pid 5 in front), counting what would bring it forward. */
function behindDriver(answers = {}) {
  const scripted = scriptedDriver({ frontmost: inFront(5), ...answers });
  let activated = 0;
  return { ...scripted, host: (extra = {}) => hostOn(scripted.driver, { activate: async () => (activated += 1), ...extra }), activated: () => activated };
}

test('behind another app, a click accessibility can’t make is sent to the app itself: nothing comes forward, the pointer stays', async () => {
  const one = behindDriver({ act: (params) => (params.action === 'pointBehind' ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)) });
  assert.deepEqual(await one.host().execute({ action: 'click', id: 1 }, PAGE), { ok: true, detail: 'clicked where it is, behind the window in front' });
  assert.deepEqual(names(one.calls), ['act press', 'frontmost', 'act pointBehind', 'clickBehind']);
  assert.deepEqual(one.calls.at(-1)[1], { pid: 90, x: 140, y: 110, window: 4242 });
  assert.equal(one.activated(), 0);
  assert.equal(one.calls.some(([cmd]) => cmd === 'click' || cmd === 'move'), false, 'the real pointer isn’t touched');

  // A double click and a right click carry what they are; a spot in a picture goes the same way.
  const twice = behindDriver({ act: (params) => (params.action === 'pointBehind' ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)) });
  assert.equal((await twice.host().execute({ action: 'click', id: 1, count: 2 }, PAGE)).detail, 'double-clicked where it is, behind the window in front');
  assert.deepEqual(twice.calls.at(-1), ['clickBehind', { pid: 90, x: 140, y: 110, count: 2, window: 4242 }]);
  await twice.host().execute({ action: 'click', id: 1, button: 'right' }, PAGE);
  assert.deepEqual(twice.calls.at(-1), ['clickBehind', { pid: 90, x: 140, y: 110, button: 'right', window: 4242 }]);
  const spot = behindDriver();
  assert.equal((await spot.host().execute({ action: 'click', x: 1, y: 1, what: 'a dot', at: { x: 500, y: 400 } }, PAGE)).detail, 'clicked that spot where it is, behind the window in front');
  assert.deepEqual(spot.calls.at(-1), ['clickBehind', { pid: 90, x: 500, y: 400, window: 4242 }]);
  assert.equal(spot.activated(), 0);

  // Something of the app's own is over it (a sheet): not clicked, there or anywhere.
  const covered = behindDriver({ act: (params) => (params.action === 'pointBehind' ? { covered: 'the sheet “Sign in”' } : Promise.reject(refusedPress)) });
  assert.deepEqual(await covered.host().execute({ action: 'click', id: 1 }, PAGE), { ok: false, detail: 'It’s covered by the sheet “Sign in”, so it wasn’t clicked.' });
  assert.equal(covered.calls.some(([cmd]) => cmd === 'clickBehind' || cmd === 'click'), false);
  assert.equal(covered.activated(), 0);
});

test('a click behind is checked on its own window: pixels that changed mean it took; nothing at all, and the next is a hand’s in front', async () => {
  const looks = [grey(40), grey(40), grey(40, { count: 500, level: 200 })];
  const took = behindDriver({ act: (params) => (params.action === 'pointBehind' ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)), snapshot: { ...PAGE, snapshot: 51 }, glance: () => ({ allowed: true, gray: looks.shift() }) });
  const result = await took.host({ exclude: 999 }).execute({ action: 'click', id: 1 }, PAGE, { verify: true });
  assert.equal(result.changes, 'The screen changed where it was clicked, though no control reads differently.');
  const glances = took.calls.filter(([cmd]) => cmd === 'glance').map(([, params]) => params);
  assert.deepEqual(glances.slice(1), [{ x: 140, y: 110, window: 4242 }, { x: 140, y: 110, window: 4242 }], 'its own window alone, whatever lies over it');
  assert.deepEqual(took.calls.filter(([cmd]) => cmd === 'snapshot').map(([, params]) => params.pid), [90], 'read where it is');
  assert.equal(took.activated(), 0);

  // Neither read nor seen to change: said, and asked for again it's clicked with the app in front.
  let front = 5;
  const dead = scriptedDriver({ frontmost: () => inFront(front), act: (params) => (/^point/.test(params.action) ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)), snapshot: { ...PAGE, snapshot: 51 }, glance: { allowed: true, gray: grey(40) } });
  let brought = 0;
  const host = hostOn(dead.driver, { activate: async () => ((brought += 1), (front = 90)) });
  const nothing = await host.execute({ action: 'click', id: 1 }, PAGE, { verify: true });
  assert.equal(nothing.changed, false);
  assert.match(nothing.changes, /behind the window in front, and nothing changed: asked for again, it’s brought to the front/);
  assert.equal(brought, 0);
  await host.execute({ action: 'click', id: 1 }, { ...PAGE, snapshot: 51 });
  assert.equal(brought, 1);
  assert.deepEqual(dead.calls.at(-1), ['click', { x: 140, y: 110 }]);
  // The next task starts afresh.
  front = 5;
  host.begin();
  await host.execute({ action: 'click', id: 1 }, { ...PAGE, snapshot: 51 });
  assert.equal(dead.calls.at(-1)[0], 'clickBehind');
});

test('what can’t be sent behind is done as it always was: in front', async () => {
  // This macOS has no way in (or the app has no window there): brought forward and clicked, and not tried again.
  let front = 5;
  const none = scriptedDriver({ frontmost: () => inFront(front), act: (params) => (/^point/.test(params.action) ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)), clickBehind: new Error('this macOS has no way to click in a window that isn’t in front') });
  let brought = 0;
  const host = hostOn(none.driver, { activate: async () => ((brought += 1), (front = 90)) });
  assert.deepEqual(await host.execute({ action: 'click', id: 1 }, PAGE), { ok: true, detail: 'clicked where it is drawn' });
  assert.equal(brought, 1);
  front = 5;
  await host.execute({ action: 'click', id: 1 }, PAGE);
  assert.equal(none.calls.filter(([cmd]) => cmd === 'clickBehind').length, 1, 'once was enough to know');

  // Turned off in Settings, on Windows, or with macOS's own dialog in front: never tried.
  for (const [extra, frontApp] of [[{ behind: () => false }, { pid: 5 }], [{ platform: 'win32' }, { pid: 5 }], [{}, { pid: 5, name: 'SecurityAgent' }]]) {
    const old = scriptedDriver({ frontmost: { app: frontApp }, act: (params) => (/^point/.test(params.action) ? { x: 140, y: 110, checked: true } : Promise.reject(refusedPress)) });
    const result = await hostOn(old.driver, extra).execute({ action: 'click', id: 1 }, PAGE);
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(old.calls.some(([cmd]) => cmd === 'clickBehind'), false);
  }
  // A drag is always the pointer's.
  const drag = behindDriver({ act: { x: 1, y: 2, checked: true } });
  assert.equal((await drag.host().execute({ action: 'drag', from: 0, to: 1 }, PAGE)).ok, false);
  assert.equal(drag.activated(), 1);
});

test('text for a web page behind another app: its field focused and selected through accessibility, the text sent to the app, read back', async () => {
  const webOnly = new Error('web pages don\'t take text set this way; type it instead');
  const field = (value) => (params) => {
    if (params.action === 'setValue' || params.action === 'appendValue') return Promise.reject(webOnly);
    if (params.action === 'read') return params.value ? { contains: true, value, length: value.length } : { value: 'Good', length: 4 };
    return {};
  };
  const typed = behindDriver({ act: field('desk lamp') });
  assert.deepEqual(await typed.host().execute({ action: 'type', id: 0, text: 'desk lamp', enter: true }, PAGE), { ok: true, landed: true });
  assert.deepEqual(names(typed.calls), ['frontmost', 'act focus', 'act setValue', 'act select', 'textBehind', 'act read', 'keyBehind']);
  assert.deepEqual(typed.calls.find(([cmd, params]) => cmd === 'act' && params.action === 'select')[1].value, 'all', 'a one-line field is typed over');
  assert.deepEqual(typed.calls.find(([cmd]) => cmd === 'textBehind')[1], { pid: 90, window: 4242, text: 'desk lamp' });
  assert.deepEqual(typed.calls.at(-1)[1], { pid: 90, window: 4242, key: 'enter', sure: true });
  assert.equal(typed.activated(), 0);
  assert.equal(typed.calls.some(([cmd]) => cmd === 'key' || cmd === 'text'), false, 'no key goes to whatever is in front');

  // Added to a longer one: the caret put at its end, and read back longer than it was.
  const added = behindDriver({ act: field('Good and cheap') });
  assert.deepEqual(await added.host().execute({ action: 'type', id: 2, text: ' and cheap', mode: 'append' }, PAGE), { ok: true, landed: true });
  assert.equal(added.calls.find(([cmd, params]) => cmd === 'act' && params.action === 'select')[1].value, 'end');

  // It can't be typed there (a keyboard that isn't a US one, a letter with no key): nothing was sent, so it's
  // typed the usual way, the app brought forward.
  let front = 5;
  const usual = scriptedDriver({ frontmost: () => inFront(front), focused: { element: { role: 'AXTextField' }, app: { pid: 90 } }, act: field('café'), textBehind: new Error('“é” has no key of its own to type it behind with') });
  let brought = 0;
  const result = await hostOn(usual.driver, { activate: async () => ((brought += 1), (front = 90)) }).execute({ action: 'type', id: 0, text: 'café' }, PAGE);
  assert.deepEqual(result, { ok: true, landed: true });
  assert.equal(brought, 1);
  assert.deepEqual(usual.calls.filter(([cmd]) => cmd === 'key' || cmd === 'text').map(([cmd, params]) => [cmd, params.key || params.text]), [['key', 'a'], ['text', 'café']]);

  // Sent, and the field doesn't read as it should: said, and Enter isn't pressed anywhere.
  const lost = behindDriver({ act: (params) => (params.action === 'setValue' ? Promise.reject(webOnly) : params.action === 'read' ? { contains: false, value: 'old', length: 3 } : {}) });
  const missed = await lost.host().execute({ action: 'type', id: 0, text: 'desk lamp', enter: true }, PAGE);
  assert.match(missed.detail, /The text didn’t land: the field reads “old”, so Enter wasn’t pressed/);
  assert.equal(lost.calls.some(([cmd]) => cmd === 'keyBehind' || cmd === 'key'), false);

  // A field of the Mac's own is set outright, as ever; its Enter goes to the app too.
  const native = behindDriver({ act: (params) => (params.action === 'setValue' ? { landed: true, value: 'desk lamp' } : {}) });
  assert.deepEqual(await native.host().execute({ action: 'type', id: 0, text: 'desk lamp', enter: true }, PAGE), { ok: true, landed: true });
  assert.deepEqual(names(native.calls), ['frontmost', 'act focus', 'act setValue', 'keyBehind']);

  // Text where the cursor is, in an app that won't say where that is, waits for the app in front; a password field takes none.
  const cursor = behindDriver();
  assert.equal((await cursor.host().execute({ action: 'type', text: 'hello' }, PAGE)).ok, false);
  assert.equal(cursor.calls.some(([cmd]) => cmd === 'textBehind'), false);
  assert.equal(cursor.activated(), 1);
  const secret = behindDriver();
  assert.equal((await secret.host().execute({ action: 'type', id: 0, text: 'hunter2' }, { ...PAGE, elements: [{ id: 0, role: 'password', label: 'Password' }] })).detail, 'Jester never types into password fields.');
  assert.equal(secret.calls.length, 0);
});

test('a key for an app behind another goes to the app itself; a shortcut it has no command for, and what the driver won’t vouch for, wait for the front', async () => {
  const keys = behindDriver();
  assert.deepEqual(await keys.host().execute({ action: 'press', keys: 'down', times: 3 }, PAGE), { ok: true });
  assert.deepEqual(keys.calls, [['frontmost', undefined], ['keyBehind', { pid: 90, key: 'down', modifiers: [], times: 3, window: 4242 }]]);
  assert.equal(keys.activated(), 0);

  // After text was put in a field by its id, the key that follows is for that field: said to the driver.
  const after = behindDriver({ act: (params) => (params.action === 'setValue' ? { landed: true, value: 'x' } : {}) });
  const host = after.host();
  await host.execute({ action: 'type', id: 0, text: 'x' }, PAGE);
  await host.execute({ action: 'press', keys: 'enter' }, PAGE);
  assert.deepEqual(after.calls.at(-1), ['keyBehind', { pid: 90, key: 'enter', modifiers: [], times: 1, window: 4242, sure: true }]);
  await host.execute({ action: 'press', keys: 'enter' }, PAGE);
  assert.equal(after.calls.at(-1)[1].sure, undefined, 'once: after another step, where the focus is isn’t known');

  // ⌘ with no menu command behind it, and a key the driver refuses (the focus unreadable, a password field): in front.
  for (const [action, answers] of [[{ action: 'press', keys: 'cmd+k' }, {}], [{ action: 'press', keys: 'x' }, { keyBehind: new Error('the app won’t say what has its keyboard focus while it’s behind') }]]) {
    let front = 5;
    const scripted = scriptedDriver({ frontmost: () => inFront(front), focused: { element: { role: 'AXTextField' }, app: { pid: 90 } }, ...answers });
    let brought = 0;
    assert.equal((await hostOn(scripted.driver, { activate: async () => ((brought += 1), (front = 90)) }).execute(action, PAGE)).ok, true);
    assert.equal(brought, 1, action.keys);
    assert.equal(scripted.calls.at(-1)[0], 'key');
  }
});

test('text after words, in a web page behind another app: the caret put there, the text sent to the app, read back', async () => {
  const typed = behindDriver({
    act: (params) => {
      if (params.action === 'insertAfter') return Promise.reject(new Error('web pages don\'t take text set this way; type it instead'));
      if (params.action === 'read') return params.value ? { contains: true, value: 'Good value', length: 10 } : { value: 'Good', length: 4 };
      return {};
    }
  });
  assert.deepEqual(await typed.host().execute({ action: 'type', id: 2, text: ' value', after: 'Good', enter: true }, PAGE), { ok: true, landed: true });
  assert.deepEqual(names(typed.calls), ['frontmost', 'act focus', 'act insertAfter', 'act read', 'act caretAfter', 'textBehind', 'act read', 'keyBehind']);
  assert.equal(typed.activated(), 0);
  assert.equal(typed.calls.some(([cmd]) => cmd === 'text' || cmd === 'key'), false);

  // It can't be typed there: the app comes forward, the caret is put after the words again, and it's typed.
  let front = 5;
  const usual = scriptedDriver({
    frontmost: () => inFront(front),
    focused: { element: { role: 'AXTextArea' }, app: { pid: 90 } },
    textBehind: new Error('text for a web page behind others is typed key by key, which needs a US keyboard layout'),
    act: (params) => (params.action === 'insertAfter' ? Promise.reject(new Error('type it instead')) : params.action === 'read' ? (params.value ? { contains: true, value: 'Good value', length: 10 } : { value: 'Good', length: 4 }) : {})
  });
  let brought = 0;
  assert.deepEqual(await hostOn(usual.driver, { activate: async () => ((brought += 1), (front = 90)) }).execute({ action: 'type', id: 2, text: ' value', after: 'Good' }, PAGE), { ok: true, landed: true });
  assert.equal(brought, 1);
  assert.equal(usual.calls.filter(([cmd, params]) => cmd === 'act' && params.action === 'caretAfter').length, 2, 'bringing it forward may move the caret');
  assert.deepEqual(usual.calls.filter(([cmd]) => cmd === 'text').map(([, params]) => params.text), [' value']);
});
