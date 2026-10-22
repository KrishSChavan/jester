import test from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_MARGIN, chooseTarget, easeToward, frameHolds, isClosing, movedByHand, placeCursor, probePoints } from '../desktop/src/main/pointer-math.js';

const display = { x: 0, y: 0, width: 1512, height: 982 };
const frame = (x, y, extra = {}) => ({ active: true, x, y, mode: 'head', display: { w: 1512, h: 982 }, ...extra });

test('engine fractions land on the display the cursor aims at', () => {
  assert.deepEqual(placeCursor(frame(0.5, 0.5), display), { x: 756, y: 491, away: false });
  // A second display to the right and above: the same fractions, its own bounds.
  assert.deepEqual(placeCursor(frame(0.25, 0.5), { x: 1512, y: -200, width: 2560, height: 1440 }), { x: 2152, y: 520, away: false });
});

test('looking past the edge is looking away; a little past is still on screen', () => {
  const near = placeCursor(frame(-0.01, 0.5), display);
  assert.equal(near.away, false);
  assert.equal(near.x, 0);
  const far = placeCursor(frame(-(AWAY_MARGIN + 10) / 1512, 0.5), display);
  assert.equal(far.away, true);
  assert.equal(far.x, 0, 'clamped to the edge, where it waits');
  assert.equal(placeCursor(frame(0.5, 0.5, { offscreen: true }), display).away, true);
});

test('eyes calibrated on another screen can\'t be placed here; a head can', () => {
  const elsewhere = { display: { w: 2560, h: 1440 } };
  assert.match(placeCursor(frame(0.5, 0.5, { ...elsewhere, mode: 'eyes' }), display).refused, /different screen/);
  assert.match(placeCursor(frame(0.5, 0.5, { ...elsewhere, mode: 'hybrid' }), display).refused, /different screen/);
  assert.equal(placeCursor(frame(0.5, 0.5, { ...elsewhere, mode: 'head' }), display).refused, undefined);
});

test('the aim holds still from a quarter closed, through the click, while the fist is held', () => {
  assert.equal(isClosing({ progress: 0.2 }), false);
  assert.equal(isClosing({ progress: 0.25 }), true);
  assert.equal(isClosing({ progress: 0, down: true }), true);
  assert.equal(isClosing({ click: true }), true);
  assert.equal(isClosing(null), false);
});

test('the cursor eases most of the way each tick and settles exactly', () => {
  let at = { x: 0, y: 0 };
  const to = { x: 100, y: 50 };
  at = easeToward(at, to);
  assert.ok(at.x > 45 && at.x < 60, `first tick ${at.x}`);
  for (let i = 0; i < 12; i++) at = easeToward(at, to);
  assert.deepEqual(at, to);
  assert.deepEqual(easeToward(null, to), to);
});

test('a hand on the mouse is told apart from Jester\'s own moves', () => {
  assert.equal(movedByHand({ x: 103, y: 100 }, { x: 100, y: 100 }), false);
  assert.equal(movedByHand({ x: 120, y: 100 }, { x: 100, y: 100 }), true);
  assert.equal(movedByHand({ x: 120, y: 100 }, null), false);
});

test('aim assist looks at the point, then two rings around it', () => {
  const points = probePoints(500, 400, 40);
  assert.equal(points.length, 17);
  assert.deepEqual(points[0], { x: 500, y: 400 });
  const distances = points.slice(1).map((p) => Math.round(Math.hypot(p.x - 500, p.y - 400)));
  assert.deepEqual([...new Set(distances)].sort((a, b) => a - b), [20, 40]);
});

test('a click goes to what is under it, else the nearest pressable thing in reach', () => {
  const point = { x: 500, y: 400 };
  const button = { x: 520, y: 380, w: 60, h: 30 };
  const toolbar = { x: 0, y: 360, w: 1500, h: 80 };
  const far = { x: 900, y: 900, w: 50, h: 20 };
  // Under the point, the smaller of two wins: the toolbar holds the point too, but so would the button.
  assert.deepEqual(chooseTarget([toolbar, { x: 480, y: 390, w: 40, h: 20 }], point, 40), { x: 500, y: 400, frame: { x: 480, y: 390, w: 40, h: 20 } });
  // Nothing under it: the button 20 px away, clicked in its centre.
  assert.deepEqual(chooseTarget([button, far], point, 40), { x: 550, y: 395, frame: button });
  // Out of reach: click where aimed.
  assert.equal(chooseTarget([far], point, 40), null);
  assert.equal(chooseTarget([], point, 40), null);
  assert.equal(frameHolds(button, { x: 530, y: 390 }), true);
  assert.equal(frameHolds(null, point), false);
});
