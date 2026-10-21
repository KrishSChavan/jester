import test from 'node:test';
import assert from 'node:assert/strict';
import { driverPath, startDriver, toOsPoint } from '../desktop/src/main/driver.js';

let binary = null;
try {
  binary = driverPath();
} catch {
  binary = null;
}
const skip = !binary && 'jester-driver is not built (npm run driver in desktop/)';

/** A dry run describes the events it would post and posts none. */
async function withDriver(run) {
  const driver = startDriver({ binary, dryRun: true });
  try {
    return await run(driver);
  } finally {
    driver.close();
  }
}

test('a dry run says so, and reports what the OS allows', { skip }, () =>
  withDriver(async (driver) => {
    const hello = await driver.call('hello');
    assert.equal(hello.dryRun, true);
    assert.equal(typeof hello.permissions.accessibility, 'boolean');
    assert.equal(typeof hello.permissions.postEvents, 'boolean');
  }));

test('a shortcut presses its modifiers first and lets go of them last', { skip }, () =>
  withDriver(async (driver) => {
    const { events } = await driver.call('key', { key: '4', modifiers: ['cmd', 'shift'] });
    assert.deepEqual(events.map((e) => `${e.event} ${e.key}`), ['keydown meta', 'keydown shift', 'keydown 4', 'keyup 4', 'keyup shift', 'keyup meta']);
    const held = await driver.call('key', { key: 'tab', modifiers: ['alt'], action: 'down' });
    assert.deepEqual(held.events.map((e) => `${e.event} ${e.key}`), ['keydown alt', 'keydown tab']);
    const released = await driver.call('key', { key: 'tab', modifiers: ['alt'], action: 'up' });
    assert.deepEqual(released.events.map((e) => `${e.event} ${e.key}`), ['keyup tab', 'keyup alt']);
  }));

test('a double-click moves there first and numbers its clicks', { skip }, () =>
  withDriver(async (driver) => {
    const { events } = await driver.call('click', { x: 120, y: 80, count: 2 });
    assert.deepEqual(events.map((e) => [e.event, e.count ?? null]), [['move', null], ['down', 1], ['up', 1], ['down', 2], ['up', 2]]);
    assert.ok(events.every((e) => e.x === 120 && e.y === 80));
  }));

test('moving with a button held is a drag', { skip }, () =>
  withDriver(async (driver) => {
    await driver.call('button', { x: 10, y: 10, down: true });
    assert.equal((await driver.call('move', { x: 50, y: 60 })).events[0].event, 'drag');
    await driver.call('button', { x: 50, y: 60, down: false });
    assert.equal((await driver.call('move', { x: 70, y: 60 })).events[0].event, 'move');
  }));

test('text keeps every character, and line breaks are Enter', { skip }, () =>
  withDriver(async (driver) => {
    const { events } = await driver.call('text', { text: 'héllo\nworld 👋' });
    assert.deepEqual(events, [{ event: 'text', text: 'héllo' }, { event: 'keydown', key: 'enter' }, { event: 'keyup', key: 'enter' }, { event: 'text', text: 'world 👋' }]);
  }));

test('bad requests fail with a reason and leave the driver running', { skip }, () =>
  withDriver(async (driver) => {
    await assert.rejects(driver.call('key', { key: 'nope' }), /unknown key "nope"/);
    await assert.rejects(driver.call('key', { key: 'a', modifiers: ['hyper'] }), /unknown modifier "hyper"/);
    await assert.rejects(driver.call('teleport'), /bad request/);
    assert.equal((await driver.call('hello')).ok, true);
  }));

test('Electron DIPs become physical pixels only on Windows', () => {
  const screen = { dipToScreenPoint: ({ x, y }) => ({ x: x * 1.5, y: y * 1.5 }) };
  assert.deepEqual(toOsPoint(screen, { x: 100, y: 40 }, 'win32'), { x: 150, y: 60 });
  assert.deepEqual(toOsPoint(screen, { x: 100, y: 40 }, 'darwin'), { x: 100, y: 40 });
});
