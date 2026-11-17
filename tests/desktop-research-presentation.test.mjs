import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchPresentation, homeVisible } from '../desktop/src/main/research-presentation.js';

function rig() {
  const broadcast = [];
  const sent = [];
  const overlaySent = [];
  const stop = [];
  let visible = true;
  let minimized = false;
  let open = true;
  const window = { webContents: { name: 'home' }, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized, isFocused: () => false };
  const overlay = { webContents: { name: 'overlay' }, isDestroyed: () => false };
  const presenter = createResearchPresentation({ home: () => (open ? window : null),
    post: (message) => broadcast.push(message),
    postTo: (contents, message) => (contents === overlay.webContents ? overlaySent : sent).push({ contents, message }),
    overlays: () => [overlay],
    stopButton: () => ({ show: () => stop.push('show'), hide: () => stop.push('hide') }) });
  return { presenter, window, broadcast, sent, overlaySent, stop,
    visibility: (on) => { visible = on; }, minimize: (on) => { minimized = on; }, close: () => { open = false; } };
}

const searching = (r, owner = 'search-1') => {
  r.presenter.busy(true, { kind: 'research' });
  r.presenter.update({ active: true, phase: 'searching', label: 'Finding sources', goal: 'search for launch news' }, { owner });
  r.presenter.voice({ phase: 'thinking', step: 'Finding sources' }, { kind: 'research' });
};

test('a search stays in his open window, unfocused too: no pill, no ×, and any step it left on the pill taken off', () => {
  const r = rig();
  searching(r);
  assert.deepEqual(r.stop, ['hide']);
  assert.deepEqual(r.broadcast, []);
  assert.ok(r.overlaySent.some(({ message }) => message.voice?.active === false));
  assert.ok(r.sent.some(({ message }) => message.type === 'jester/research-state' && message.research.active));
  assert.ok(r.sent.some(({ message }) => message.type === 'jester/voice' && message.voice.step === 'Finding sources'));
  assert.equal(homeVisible(r.window), true);
});

test('hidden, minimized or closed mid-search, it goes to the pill with its ×; shown again, back to his window', () => {
  for (const kind of ['hide', 'minimize', 'close']) {
    const r = rig();
    searching(r);
    if (kind === 'hide') r.visibility(false);
    else if (kind === 'minimize') r.minimize(true);
    else r.close();
    r.presenter.sync();
    assert.equal(r.stop.at(-1), 'show', kind);
    assert.equal(r.broadcast.at(-1).voice.step, 'Finding sources', kind);
    if (kind !== 'close') {
      r.visibility(true); r.minimize(false); r.presenter.sync();
      assert.equal(r.stop.at(-1), 'hide', kind);
    }
  }
});

test('the × is made once per move, not again under a click on it (Yes, then a "Stopping…" step)', () => {
  const r = rig();
  r.visibility(false);
  searching(r);
  assert.deepEqual(r.stop, ['show']);
  r.presenter.voice({ phase: 'thinking', step: 'Stopping…' }, { kind: 'research' });
  r.presenter.update({ active: true, label: 'Reading' }, { owner: 'search-1' });
  r.presenter.sync();
  assert.deepEqual(r.stop, ['show']);
});

test('an ordinary task, and everything else, keeps its pill and × with his window open', () => {
  const r = rig();
  r.presenter.busy(true, { kind: 'task' });
  r.presenter.voice({ phase: 'thinking', step: 'Working in Notes' }, { kind: 'task' });
  assert.equal(r.stop.at(-1), 'show');
  assert.equal(r.broadcast.at(-1).voice.step, 'Working in Notes');
  r.presenter.observe();
  r.presenter.sync();
  assert.equal(r.stop.at(-1), 'show');
  assert.deepEqual(r.overlaySent, []);
  r.presenter.busy(false, { kind: 'task' });
  assert.equal(r.stop.at(-1), 'hide');
});

test('a search over clears its bar and leaves nothing to put back on the pill later', () => {
  const r = rig();
  searching(r);
  r.presenter.update({ active: false }, { owner: 'search-1' });
  r.presenter.busy(false, { kind: 'research' });
  assert.equal(r.presenter.state().active, false);
  assert.equal(r.sent.filter(({ message }) => message.type === 'jester/research-state').at(-1).message.research.active, false);
  r.visibility(false); r.presenter.sync();
  assert.deepEqual(r.broadcast, []);
  assert.equal(r.stop.at(-1), 'hide');
});

test('an older search ending after a newer one began leaves the newer one’s bar, and Stop stops only what the bar shows', () => {
  const r = rig();
  const stopped = [];
  r.presenter.update({ active: true, label: 'First' }, { owner: 'one', stop: () => stopped.push('one') });
  r.presenter.update({ active: true, label: 'Second' }, { owner: 'two', stop: () => stopped.push('two') });
  r.presenter.update({ active: false }, { owner: 'one' });
  assert.equal(r.presenter.state().label, 'Second');
  r.presenter.stop();
  assert.deepEqual(stopped, ['two']);
  r.presenter.update({ active: false }, { owner: 'two' });
  r.presenter.stop();
  assert.deepEqual(stopped, ['two'], 'nothing shown, nothing stopped');
});

test('a show or hide event counts before the window’s own flags catch up with it', () => {
  const r = rig();
  searching(r);
  r.presenter.sync({ visible: false });
  assert.equal(r.stop.at(-1), 'show');
  assert.equal(r.broadcast.at(-1).voice.step, 'Finding sources');
  r.presenter.observe();
  assert.equal(r.stop.at(-1), 'show', 'the flags still say visible: the event wins until they agree');
  r.visibility(false);
  r.presenter.observe();
  r.visibility(true);
  r.presenter.observe();
  assert.equal(r.stop.at(-1), 'hide', 'once they agreed, the flags are read again');
});

test('the tick reads nothing without a search, and only moves on a change', () => {
  const r = rig();
  r.presenter.observe();
  assert.deepEqual(r.stop, []);
  searching(r);
  const sent = r.sent.length;
  r.presenter.observe();
  assert.equal(r.sent.length, sent);
  r.visibility(false);
  r.presenter.observe();
  assert.equal(r.stop.at(-1), 'show');
});
