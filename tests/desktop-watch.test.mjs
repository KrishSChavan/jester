import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATCH_DEAD, WATCH_FAST_GAIN, WATCH_SLOW_GAIN, WATCH_SURE, WATCH_UNITS, createSteady, easeToward, moveAcross, moveWithin, steerBy, whereAimed, whereAt } from '../desktop/src/main/pointer-math.js';
import { trayModel } from '../desktop/src/main/tray-menu.js';
import { bridgePath, createWatch } from '../desktop/src/main/watch.js';
import { watchPairing, watchStatus } from '../desktop/src/main/watch-status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.resolve(here, '../desktop/native/jester-watch');
const swiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;

test('the watch and the Mac agree, and strangers get nowhere (Swift: pairing, frames, steering, pinches)', { skip: !swiftc && 'needs swiftc' }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-watch-'));
  const sources = ['Core', 'Tests'].flatMap((dir) => fs.readdirSync(path.join(native, dir)).filter((file) => file.endsWith('.swift')).map((file) => path.join(native, dir, file)));
  const binary = path.join(folder, 'tests');
  const build = spawnSync('swiftc', ['-swift-version', '5', ...sources, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, { encoding: 'utf8' });
  fs.rmSync(folder, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /checks passed/);
});

/** A frame's worth of turning at `rate` rad/s. */
const turning = (rate, extra = {}) => ({ yaw: Math.round((rate * 0.02) * WATCH_UNITS), pitch: 0, ms: 20, ...extra });

test('reports are in the units the watch sends', () => {
  // Core/Wire.swift's Report; the Swift tests send a known turn and count them.
  assert.equal(WATCH_UNITS, 10000);
});

test('a slow turn aims and a quick one travels', () => {
  const slow = steerBy(turning(0.1));
  const quick = steerBy(turning(2));
  assert.ok(Math.abs(slow.dx / (0.1 * 0.02) - WATCH_SLOW_GAIN) < 1, `slow gain ${slow.dx / 0.002}`);
  assert.ok(Math.abs(quick.dx / (2 * 0.02) - WATCH_FAST_GAIN) < 1, `fast gain ${quick.dx / 0.04}`);
  // A full swing across the screen is a comfortable turn of the wrist, not a lunge.
  assert.ok(1512 / WATCH_FAST_GAIN < 0.7, 'crosses a laptop screen in under 40°');
});

test('gain never falls as speed rises', () => {
  let last = 0;
  for (let rate = 0.04; rate < 3; rate += 0.05) {
    const { dx } = steerBy({ yaw: rate * 0.02 * WATCH_UNITS, pitch: 0, ms: 20 });
    const gain = dx / (rate * 0.02);
    assert.ok(gain >= last - 2, `at ${rate.toFixed(2)} rad/s: ${gain} after ${last}`);
    last = gain;
  }
});

test('a hand holding still doesn\'t move the cursor', () => {
  assert.deepEqual(steerBy(turning(WATCH_DEAD * 0.8)), { dx: 0, dy: 0 });
  assert.deepEqual(steerBy({ yaw: 0, pitch: 0, ms: 200 }), { dx: 0, dy: 0 });
});

test('the slowest aim has no step in it: gain comes in gradually', () => {
  let last = 0;
  for (let rate = WATCH_DEAD; rate <= WATCH_SURE; rate += 0.001) {
    const { dx } = steerBy({ yaw: rate * 0.02 * WATCH_UNITS, pitch: 0, ms: 20 });
    assert.ok(dx >= last && dx - last < 0.06, `at ${rate.toFixed(3)} rad/s: ${dx} after ${last}`);
    last = dx;
  }
  const rate = WATCH_SURE * 1.01;
  assert.ok(Math.abs(steerBy({ yaw: rate * 0.02 * WATCH_UNITS, pitch: 0, ms: 20 }).dx / (rate * 0.02) - WATCH_SLOW_GAIN) < 1, 'and counts in full from there');
});

/**
 * `seconds` of a hand (rate in rad/s) reported as the watch reports it: 100 Hz
 * samples summed into frames, the rounding carried over. Where the cursor went after each.
 */
function ride(steady, rateAt, seconds, msAt = () => 20) {
  const path = [];
  let x = 0;
  let t = 0;
  let carried = 0;
  while (t < seconds) {
    const ms = msAt();
    let angle = carried;
    for (let i = 0; i < ms / 10; i++, t += 0.01) angle += rateAt(t) * 0.01;
    const yaw = Math.round(angle * WATCH_UNITS);
    carried = angle - yaw / WATCH_UNITS;
    const report = { yaw, pitch: 0, ms, steering: true };
    x += steerBy(steady ? steady(report) : report).dx;
    path.push(x);
  }
  return path;
}
const spread = (path) => Math.max(...path) - Math.min(...path);
const shaking = (amount, hz) => (t) => amount * Math.sin(2 * Math.PI * hz * t);

test('a hand\'s tremor is steadied out', () => {
  for (const [amount, hz] of [[0.1, 8], [0.2, 9.3], [0.2, 12.5]]) {
    // Once under way: the filter is always running, and a tremor doesn't start from nothing.
    const raw = spread(ride(null, shaking(amount, hz), 6).slice(100));
    const steadied = spread(ride(createSteady(), shaking(amount, hz), 6).slice(100));
    assert.ok(steadied < raw / 2, `${amount} rad/s at ${hz} Hz: ${steadied.toFixed(2)} px of shake, down from ${raw.toFixed(2)}`);
    assert.ok(steadied < 1.5, `${amount} rad/s at ${hz} Hz: ${steadied.toFixed(2)} px`);
  }
  assert.equal(spread(ride(createSteady(), shaking(0.03, 10), 6)), 0, 'a hand at rest keeps the cursor dead still');
});

test('a tremor doesn\'t creep: its two halves still cancel out', () => {
  // Frames get unevenly spaced on a busy radio, which is when this would show.
  let turn = 0;
  const uneven = () => [20, 30, 20, 40, 30][turn++ % 5];
  for (const [amount, hz] of [[0.1, 10], [0.2, 10], [0.2, 8], [0.2, 12.5], [0.3, 9]]) {
    for (const frames of [() => 20, uneven]) {
      const end = ride(createSteady(), shaking(amount, hz), 6, frames).at(-1);
      assert.ok(Math.abs(end) < 2.5, `${amount} rad/s at ${hz} Hz: crept ${end.toFixed(2)} px in six seconds`);
    }
  }
});

test('steadying adds up to the same turn: nothing deliberate is lost', () => {
  for (const rate of [0.05, 0.3, 1]) {
    const turn = (t) => (t < 1 ? rate : 0);
    const raw = ride(null, turn, 2.5).at(-1);
    const steadied = ride(createSteady(), turn, 2.5).at(-1);
    assert.ok(Math.abs(steadied / raw - 1) < 0.08, `${rate} rad/s for a second: ${steadied.toFixed(1)} px, unsteadied ${raw.toFixed(1)}`);
  }
});

test('a quick turn hardly lags', () => {
  const steady = createSteady();
  const report = { yaw: 1.5 * 0.02 * WATCH_UNITS, pitch: 0, ms: 20, steering: true };
  let out;
  for (let i = 0; i < 3; i++) out = steady(report);
  assert.ok(out.yaw > report.yaw * 0.9, `after 60 ms: ${(out.yaw / report.yaw).toFixed(2)} of the way`);
});

test('after a quick turn, the small correction is as fine as ever', () => {
  const steady = createSteady();
  for (let i = 0; i < 15; i++) steady({ yaw: 400, pitch: 0, ms: 20, steering: true });
  for (let i = 0; i < 10; i++) steady({ yaw: 0, pitch: 0, ms: 20, steering: true });
  const fine = steerBy(steady({ yaw: 4, pitch: 0, ms: 20, steering: true }));
  assert.ok(fine.dx / 0.0004 < WATCH_SLOW_GAIN * 1.1, `gain ${(fine.dx / 0.0004).toFixed(0)}, 200 ms after the turn ended`);
});

test('steadying starts afresh, and passes on what it doesn\'t change', () => {
  const steady = createSteady();
  for (let i = 0; i < 20; i++) steady({ yaw: 300, pitch: 0, ms: 20, steering: true });
  assert.deepEqual(steady({ steering: false }), { steering: false });
  const first = steady({ yaw: 0, pitch: 0, ms: 20, steering: true, click: true, typing: true });
  assert.deepEqual([first.yaw, first.moving, first.click, first.typing], [0, 0, true, true], 'nothing left over from before');
});

test('tipping up moves it up, unless reversed; the speed setting scales it, within reason', () => {
  const up = { yaw: 0, pitch: 100, ms: 20 };
  assert.ok(steerBy(up).dy < 0);
  assert.ok(steerBy(up, { invertY: true }).dy > 0);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(steerBy(up, { speed: 2 }).dy, steerBy(up).dy * 2);
  close(steerBy(up, { speed: 900 }).dy, steerBy(up).dy * 2.5);
  assert.equal(steerBy(up, { speed: undefined }).dy, steerBy(up).dy);
});

test('while you type, the wrist isn\'t aiming', () => {
  assert.deepEqual(steerBy(turning(2, { typing: true })), { dx: 0, dy: 0 });
});

test('junk from the helper moves nothing', () => {
  for (const report of [null, {}, { yaw: 'x', pitch: null, ms: 0 }]) assert.deepEqual(steerBy(report), { dx: 0, dy: 0 });
});

test('the cursor stops at the edges of the display', () => {
  const display = { x: 100, y: -50, width: 1000, height: 800 };
  assert.deepEqual(moveWithin({ x: 200, y: 200 }, 10, -5, display), { x: 210, y: 195 });
  assert.deepEqual(moveWithin({ x: 200, y: 200 }, -5000, -5000, display), { x: 100, y: -50 });
  assert.deepEqual(moveWithin({ x: 200, y: 200 }, 5000, 5000, display), { x: 1099, y: 749 });
});

// How this Mac's screens really sit: the monitor is left of the laptop, and rises above it.
const LAPTOP = { x: 0, y: 0, width: 1512, height: 982 };
const MONITOR = { x: -1920, y: -98, width: 1920, height: 1080 };

test('the screens are one space: across where they meet, along the edge where they don\'t', () => {
  const screens = [LAPTOP, MONITOR];
  assert.deepEqual(moveAcross({ x: 5, y: 500 }, -50, 0, screens), { x: -45, y: 500 }, 'onto the monitor');
  assert.deepEqual(moveAcross({ x: -45, y: 500 }, 50, 0, screens), { x: 5, y: 500 }, 'and back');
  assert.deepEqual(moveAcross({ x: -10, y: -50 }, 40, 0, screens), { x: -1, y: -50 }, 'above the laptop there\'s nothing to cross to');
  assert.deepEqual(moveAcross({ x: -3, y: -50 }, 10, 5, screens), { x: -1, y: -45 }, 'and it slides along that edge');
  assert.deepEqual(moveAcross({ x: -1900, y: 500 }, -90, 0, screens), { x: -1920, y: 500 }, 'the far side is an edge');
  assert.deepEqual(moveAcross({ x: 1500, y: 500 }, 90, 0, screens), { x: 1511, y: 500 });
  assert.deepEqual(moveAcross({ x: 700, y: 970 }, 0, 50, screens), { x: 700, y: 981 });
  assert.deepEqual(moveAcross({ x: 700, y: 400 }, 3000, 0, [LAPTOP]), { x: 1511, y: 400 }, 'one screen is one screen');
  assert.deepEqual(moveAcross({ x: 9, y: 9 }, 1, 1, []), { x: 10, y: 10 }, 'with none known, it isn\'t lost');
});

test('where the cursor was: the last place it had reached by then', () => {
  const trail = [{ x: 1, at: 100 }, { x: 2, at: 200 }, { x: 3, at: 300 }];
  assert.equal(whereAt(trail, 250).x, 2);
  assert.equal(whereAt(trail, 300).x, 3);
  assert.equal(whereAt(trail, 999).x, 3);
  assert.equal(whereAt(trail, 50).x, 1, 'before the trail began: as far back as it goes');
  assert.equal(whereAt([], 50), null);
});

test('a press takes back the turn of the pinch, but not the way a hand was still travelling', () => {
  const stopped = [{ x: 500, y: 400, at: 100 }, { x: 506, y: 400, at: 900 }, { x: 520, y: 400, at: 960 }, { x: 530, y: 400, at: 1000 }];
  assert.equal(whereAimed(stopped, 1000).x, 500);
  const travelling = [{ x: 300, y: 400, at: 800 }, { x: 420, y: 400, at: 850 }, { x: 480, y: 400, at: 905 }, { x: 530, y: 400, at: 1000 }];
  assert.equal(whereAimed(travelling, 1000).x, 480, 'that far back it was somewhere else');
  assert.equal(whereAimed([], 1000), null);
});

test('on real pinches a click lands where the cursor sat before them (Tests/pinch-recording-fingers.csv)', () => {
  const marks = [];
  const rows = [];
  for (const line of fs.readFileSync(path.join(native, 'Tests/pinch-recording-fingers.csv'), 'utf8').trim().split('\n')) {
    const cells = line.split(',');
    if (cells[0] === 'm') marks.push(Number(cells[1]));
    else rows.push(cells.map(Number));
  }
  // As the watch sends it: 50 frames a second, the wrist flat, over a 30 ms radio.
  const LINK = 0.03;
  const frames = [];
  let [yaw, pitch, seconds] = [0, 0, 0];
  rows.forEach(([t, , , , , spinY, spinZ], i) => {
    const dt = i ? t - rows[i - 1][0] : 0.01;
    yaw -= spinZ * dt;
    pitch -= spinY * dt;
    seconds += dt;
    if (seconds < 0.02) return;
    const sent = { yaw: Math.round(yaw * WATCH_UNITS), pitch: Math.round(pitch * WATCH_UNITS), ms: Math.round(seconds * 1000), steering: true, arrives: t + LINK };
    yaw -= sent.yaw / WATCH_UNITS;
    pitch -= sent.pitch / WATCH_UNITS;
    seconds = 0;
    frames.push(sent);
  });
  // As the Mac follows it, keeping a trail as pointer.js does.
  const steady = createSteady();
  const trail = [];
  let aim = { x: 0, y: 0 };
  let shown = null;
  let next = 0;
  for (let t = rows[0][0]; t < rows.at(-1)[0]; t += 0.016) {
    for (; next < frames.length && frames[next].arrives <= t; next++) {
      const moved = steerBy(steady(frames[next]));
      aim = { x: aim.x + moved.dx, y: aim.y + moved.dy };
    }
    const eased = easeToward(shown || aim, aim);
    if (!shown || Math.hypot(eased.x - shown.x, eased.y - shown.y) >= 0.5) trail.push({ x: eased.x, y: eased.y, at: t * 1000 });
    shown = eased;
  }
  // Each pinch's peak, and its press 40 ms on: 70 ms after it began, the detector's median, less the 30 to its peak.
  const jump = (i) => Math.hypot(rows[i][1] - rows[i - 1][1], rows[i][2] - rows[i - 1][2], rows[i][3] - rows[i - 1][3]);
  const misses = (aimedAt) => marks.map((mark, i) => {
    const after = rows.map((row, at) => at).filter((at) => at && rows[at][0] >= mark + 0.22 && rows[at][0] < Math.min(marks[i + 1] ?? Infinity, mark + 1.2));
    const peak = rows[after.reduce((best, at) => (jump(at) > jump(best) ? at : best))][0];
    const before = whereAt(trail, (peak - 0.3 + LINK + 0.04) * 1000);
    const landed = aimedAt((peak + 0.04 + LINK) * 1000);
    return Math.hypot(landed.x - before.x, landed.y - before.y);
  }).sort((a, b) => a - b);
  const middle = (values) => values[Math.floor(values.length / 2)];
  assert.equal(marks.length, 20);
  assert.ok(middle(misses((at) => whereAt(trail, at - 90))) > 8, 'the fixed look-back this replaced really was off');
  const now = middle(misses((at) => whereAimed(trail, at)));
  assert.ok(now < 5, `half of them land within ${now.toFixed(1)} px`);
});

// The pointer, with Electron's screen and the driver played by the test.
const electron = `data:text/javascript,
  export const screen = { getCursorScreenPoint: () => globalThis.jesterCursor(), getAllDisplays: () => globalThis.jesterDisplays() };`;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context)) });
const { createPointer } = await import('../desktop/src/main/pointer.js');

const DISPLAY = { x: 0, y: 0, width: 1512, height: 982 };

/** A pointer whose OS applies each move `lag` ticks late, the way a busy Mac might. */
function rig({ start = { x: 700, y: 400 }, lag = 0, frames = {}, displays = [DISPLAY], window = { x: 300, y: 100, w: 800, h: 600 }, log } = {}) {
  const state = { real: { ...start }, calls: [], overlay: [], outlines: [], toasts: [], pending: [] };
  globalThis.jesterCursor = () => state.real;
  globalThis.jesterDisplays = () => displays.map((bounds) => ({ bounds }));
  const driver = {
    call: async (cmd, params) => {
      state.calls.push([cmd, params]);
      if (cmd === 'move' || cmd === 'click' || (cmd === 'button' && params.x !== undefined)) {
        if (lag) state.pending.push({ x: params.x, y: params.y });
        else state.real = { x: params.x, y: params.y };
      }
      if (cmd === 'elementAt') return { actionable: { frame: frames[`${Math.round(params.x)},${Math.round(params.y)}`] || frames.all } };
      if (cmd === 'windowAt') {
        if (!window) throw new Error('there\'s no window here');
        return { title: 'Notes', frame: window };
      }
      if (cmd === 'moveWindow' && state.holdMoves) await new Promise((resolve) => state.holdMoves.push(resolve));
      return { ok: true };
    }
  };
  const overlays = { cursor: (shown) => state.overlay.push(shown), outline: (frame) => state.outlines.push(frame), ripple: () => undefined, whileHidden: (task) => task() };
  state.pointer = createPointer({ driver, overlays, display: () => ({ bounds: DISPLAY }), toast: (text) => state.toasts.push(text), log });
  state.settle = (ms) => {
    for (let t = 0; t < ms; t += 16) {
      mock.timers.tick(16);
      if (lag && state.pending.length > lag) state.real = state.pending.shift();
    }
  };
  state.moves = () => state.calls.filter(([cmd]) => cmd === 'move').map(([, point]) => point);
  state.clicks = () => state.calls.filter(([cmd]) => cmd === 'click').map(([, point]) => point);
  state.buttons = () => state.calls.filter(([cmd]) => cmd === 'button').map(([, press]) => press);
  state.found = () => state.calls.filter(([cmd]) => cmd === 'windowAt').map(([, point]) => point);
  state.carried = () => state.calls.filter(([cmd]) => cmd === 'moveWindow').map(([, point]) => point);
  return state;
}

/** Long enough for a click's promises to run, with the clock stopped. */
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const withClock = (name, run) =>
  test(name, async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
    try {
      await run();
    } finally {
      mock.timers.reset();
    }
  });

withClock('nudges move the real cursor from wherever it is', () => {
  const r = rig();
  r.pointer.nudge({ dx: 100, dy: -40 });
  r.settle(200);
  const end = r.moves().at(-1);
  assert.ok(Math.abs(end.x - 800) < 1 && Math.abs(end.y - 360) < 1, JSON.stringify(end));
  assert.ok(r.overlay.at(-1)?.head, 'the ring follows it');
});

withClock('steering stops at the edge and comes straight back', () => {
  const r = rig({ start: { x: 1500, y: 400 } });
  r.pointer.nudge({ dx: 5000, dy: 0 });
  r.settle(200);
  r.pointer.nudge({ dx: -20, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 1491) < 1, 'piling up past the edge isn\'t stored');
});

withClock('while the watch steers, the camera\'s cursor waits; after, it\'s back', async () => {
  const r = rig();
  r.pointer.nudge({ dx: 10, dy: 0 });
  r.settle(100);
  const frame = { active: true, x: 0.1, y: 0.1, mode: 'head', progress: 0 };
  r.pointer.frame(frame);
  r.settle(100);
  assert.ok(r.moves().at(-1).x > 500, 'the camera\'s aim didn\'t happen');
  r.pointer.frame({ ...frame, click: true });
  await flush();
  r.settle(100);
  assert.equal(r.clicks().length, 0, 'nor did its click');
  r.pointer.frame({ active: false });
  r.settle(100);
  assert.ok(r.moves().at(-1).x > 500, 'its "gone" doesn\'t end the watch\'s steering either');
  r.pointer.nudge({ steering: false });
  assert.equal(r.overlay.at(-1), null, 'stopping puts the ring away');
  r.pointer.frame(frame);
  r.settle(100);
  assert.ok(r.moves().at(-1).x < 500, 'the camera has it again');
});

withClock('a stop from a watch that wasn\'t steering leaves the camera\'s cursor alone', () => {
  const r = rig();
  r.pointer.frame({ active: true, x: 0.1, y: 0.1, mode: 'head' });
  r.settle(100);
  r.pointer.nudge({ steering: false });
  assert.notEqual(r.overlay.at(-1), null);
});

withClock('reports stopping, as when the watch walks out of range, puts the cursor down', () => {
  const r = rig();
  r.pointer.nudge({ dx: 10, dy: 0 });
  r.settle(1300);
  assert.equal(r.overlay.at(-1), null);
  const moved = r.moves().length;
  r.settle(500);
  assert.equal(r.moves().length, moved, 'and nothing moves it');
});

withClock('a quick swing on a laggy Mac isn\'t mistaken for a hand on the mouse', () => {
  const r = rig({ lag: 4 });
  for (let i = 0; i < 60; i++) {
    r.pointer.nudge({ dx: 12, dy: 0 });
    r.settle(16);
  }
  r.settle(100);
  assert.ok(Math.abs(r.moves().at(-1).x - 1420) < 2, `kept moving, to ${r.moves().at(-1).x}`);
  assert.ok(r.moves().length > 50, `${r.moves().length} moves`);
});

withClock('a hand on the mouse takes over, clicks included, and steering resumes from there', () => {
  const r = rig();
  r.pointer.nudge({ dx: 10, dy: 0 });
  r.settle(100);
  r.real = { x: 200, y: 200 };
  r.settle(20);
  const moved = r.moves().length;
  r.pointer.nudge({ dx: 50, dy: 0, click: true });
  r.settle(100);
  assert.equal(r.moves().length, moved, 'the watch doesn\'t move it');
  assert.equal(r.clicks().length, 0, 'or click');
  // The watch goes on reporting while it waits, at least five times a second.
  for (let t = 0; t < 1600; t += 200) {
    r.pointer.nudge({ dx: 0, dy: 0 });
    r.settle(200);
  }
  r.pointer.nudge({ dx: 30, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 230) < 1, `from the hand's spot: ${r.moves().at(-1).x}`);
});

withClock('as long as the mouse keeps moving, the watch keeps waiting', () => {
  const r = rig();
  r.pointer.nudge({ dx: 10, dy: 0 });
  r.settle(100);
  for (let i = 0; i < 40; i++) {
    r.real = { x: 200 + i * 5, y: 200 };
    r.pointer.nudge({ dx: 0, dy: 0 });
    r.settle(100);
  }
  assert.equal(r.moves().filter((move) => move.x < 650).length, 0, 'four seconds of mouse, and it never pulled the cursor away');
});

withClock('a pinch clicks where the cursor was before the pinch jolted it', async () => {
  const r = rig();
  r.pointer.nudge({ dx: 0, dy: 0 });
  r.settle(300);
  r.pointer.nudge({ dx: 60, dy: 0 });
  r.settle(80);
  r.pointer.nudge({ dx: 0, dy: 0, click: true });
  await flush();
  r.settle(50);
  assert.equal(r.clicks().length, 1);
  assert.ok(r.clicks()[0].x < 720, `clicked at ${r.clicks()[0].x}, not at the end of the jolt (760)`);
});

withClock('a near miss lands on the button, and steering carries on from there', async () => {
  const button = { x: 650, y: 390, w: 40, h: 20 };
  const r = rig({ frames: { all: button } });
  r.pointer.nudge({ dx: 0, dy: 0, click: true });
  await flush();
  r.settle(150);
  assert.deepEqual(r.clicks()[0], { x: 670, y: 400 });
  r.pointer.nudge({ dx: 10, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 680) < 1, `went on from the button: ${r.moves().at(-1).x}`);
});

withClock('a click isn\'t pulled to a button it wasn\'t pointed at', async () => {
  const r = rig({ frames: { all: { x: 640, y: 390, w: 40, h: 20 } } });
  r.pointer.nudge({ dx: 0, dy: 0, click: true });
  await flush();
  assert.deepEqual(r.clicks()[0], { x: 700, y: 400 }, 'twenty pixels off is somewhere else');
});

const pinch = (r, extra = {}) => r.pointer.nudge({ dx: 0, dy: 0, click: true, ...extra });
/** Up and aimed at (700, 400). */
function steering(options) {
  const r = rig(options);
  r.pointer.nudge({ dx: 0, dy: 0 });
  r.settle(300);
  return r;
}
/** Two pinches, as far apart as a person manages. */
async function pair(r) {
  pinch(r);
  await flush();
  r.settle(350);
  pinch(r);
  await flush();
}

withClock('the cursor waits out a pinch\'s jolt, then steering goes on', async () => {
  const r = steering();
  pinch(r);
  await flush();
  r.settle(50);
  r.pointer.nudge({ dx: 40, dy: 0 });
  r.settle(50);
  assert.ok(Math.abs(r.moves().at(-1).x - 700) < 1, `stayed put: ${r.moves().at(-1).x}`);
  r.settle(40);
  r.pointer.nudge({ dx: 15, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 715) < 1, `and only the jolt was lost: ${r.moves().at(-1).x}`);
});

withClock('a second pinch at the same spot makes a double-click, with only its second half pressed', async () => {
  const r = steering();
  await pair(r);
  r.settle(500);
  await flush();
  assert.equal(r.clicks().length, 1, 'the first click, once');
  assert.deepEqual(r.buttons(), [{ x: 700, y: 400, down: true, count: 2 }, { x: 700, y: 400, down: false, count: 2 }]);
});

withClock('the double-click lands where the first click did, even if that was a near miss', async () => {
  const r = steering({ frames: { all: { x: 650, y: 390, w: 40, h: 20 } } });
  await pair(r);
  r.settle(500);
  await flush();
  assert.equal(r.buttons()[0].x, 670);
});

withClock('the double-click stays where the first click was, though the hand has drifted a little', async () => {
  const r = steering();
  pinch(r);
  await flush();
  r.settle(150);
  r.pointer.nudge({ dx: 8, dy: 0 });
  r.settle(200);
  pinch(r);
  await flush();
  r.settle(500);
  await flush();
  assert.equal(r.buttons()[0].x, 700);
});

withClock('a drag in between keeps two clicks from being a pair', async () => {
  const r = steering();
  pinch(r);
  await flush();
  r.settle(130);
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(320);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  r.settle(130);
  pinch(r);
  await flush();
  r.settle(500);
  await flush();
  assert.equal(r.clicks().length, 2);
  assert.equal(r.buttons().filter((press) => press.count === 2).length, 0);
});

withClock('a second pinch somewhere else, or later, is simply another click', async () => {
  const r = steering();
  pinch(r);
  await flush();
  r.settle(200);
  r.pointer.nudge({ dx: 100, dy: 0 });
  r.settle(200);
  pinch(r);
  await flush();
  r.settle(900);
  pinch(r);
  await flush();
  r.settle(500);
  assert.equal(r.clicks().length, 3);
  assert.equal(r.buttons().length, 0);
});

withClock('a pair and then a move picks up what\'s there, and the next pinch puts it down', async () => {
  const r = steering();
  await pair(r);
  r.settle(150);
  r.pointer.nudge({ dx: 6, dy: 0 });
  r.settle(30);
  assert.deepEqual(r.buttons(), [{ x: 700, y: 400, down: true }], 'down where it was aimed, not where the hand has got to');
  for (let i = 0; i < 10; i++) {
    r.pointer.nudge({ dx: 10, dy: 5 });
    r.settle(32);
  }
  r.settle(300);
  assert.ok(Math.abs(r.moves().at(-1).x - 806) < 1, `dragged to ${r.moves().at(-1).x}`);
  assert.equal(r.overlay.at(-1).down, true, 'the ring shows it\'s held');
  pinch(r);
  await flush();
  const up = r.buttons().at(-1);
  assert.equal(up.down, false);
  assert.ok(Math.abs(up.x - 806) < 1 && Math.abs(up.y - 450) < 1, `put down at ${up.x}, ${up.y}`);
  assert.equal(r.clicks().length, 1, 'nothing extra was clicked');
  r.settle(600);
  pinch(r);
  await flush();
  assert.equal(r.clicks().length, 2, 'and the pinch after is an ordinary click, not half a pair');
  assert.equal(r.buttons().length, 2);
});

withClock('the second pinch\'s own jolt isn\'t a drag', async () => {
  const r = steering();
  await pair(r);
  r.settle(50);
  r.pointer.nudge({ dx: 40, dy: 10 });
  r.settle(600);
  await flush();
  assert.deepEqual(r.buttons().map((press) => press.count), [2, 2], 'still a double-click');
});

withClock('a press held on is the mouse button held down, from a pinch or the watch\'s button alike', async () => {
  const r = steering();
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(240);
  assert.equal(r.buttons().length, 0, 'not yet: it may be a quick one');
  r.settle(80);
  assert.deepEqual(r.buttons(), [{ x: 700, y: 400, down: true }]);
  r.pointer.nudge({ dx: 80, dy: 0, held: true });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 780) < 1);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.buttons().at(-1).down, false, 'and letting go lets go');
  assert.equal(r.clicks().length, 0);
});

withClock('a quick pinch\'s hand swinging back neither moves the cursor nor makes it a drag', async () => {
  const r = steering();
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  for (let i = 0; i < 8; i++) {
    r.settle(20);
    r.pointer.nudge({ dx: 6, dy: -3, held: true });
  }
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.buttons().length, 0);
  assert.deepEqual(r.clicks(), [{ x: 700, y: 400 }]);
});

withClock('a press that\'s let go just too late to be quick is still only a click at that spot', async () => {
  const r = steering();
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(320);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.deepEqual(r.buttons(), [{ x: 700, y: 400, down: true }, { x: 700, y: 400, down: false }]);
});

withClock('a tap of the watch\'s button is a click, and two are a double-click', async () => {
  const r = steering();
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(80);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.clicks().length, 1);
  assert.equal(r.buttons().length, 0);
  r.settle(250);
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(80);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  r.settle(500);
  await flush();
  assert.equal(r.clicks().length, 1);
  assert.deepEqual(r.buttons().map((press) => press.count), [2, 2]);
});

withClock('a press takes back the turn of the wrist that led up to it', async () => {
  const r = steering();
  for (let i = 0; i < 6; i++) {
    r.pointer.nudge({ dx: 4, dy: 0 });
    r.settle(20);
  }
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(80);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.deepEqual(r.clicks(), [{ x: 700, y: 400 }]);
});

withClock('the log says what a press took back, not what the frozen cursor shows afterwards', async () => {
  const lines = [];
  const r = steering({ log: (...parts) => lines.push(parts.join(' ')) });
  for (let i = 0; i < 6; i++) {
    r.pointer.nudge({ dx: 4, dy: 0 });
    r.settle(20);
  }
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(160);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  const said = lines.find((line) => line.startsWith('watch click')).match(/(\d+) px/)[1];
  assert.ok(Number(said) > 15, `said ${said}`);
});

withClock('the arm is aiming while it moves and a moment after; a tremor isn\'t aiming', () => {
  const r = steering();
  assert.equal(r.pointer.aiming(), false);
  r.pointer.nudge({ dx: 0.3, dy: 0.3 });
  assert.equal(r.pointer.aiming(), false);
  r.pointer.nudge({ dx: 3, dy: 0 });
  assert.equal(r.pointer.aiming(), true);
  r.settle(700);
  assert.equal(r.pointer.aiming(), true);
  r.settle(200);
  assert.equal(r.pointer.aiming(), false);
});

/** Mid-drag, with the mouse button down. */
async function dragging(options) {
  const r = steering(options);
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(320);
  r.pointer.nudge({ dx: 20, dy: 0, held: true });
  r.settle(100);
  assert.equal(r.buttons().length, 1);
  return r;
}
const lastPress = (r) => r.buttons().at(-1);

withClock('a drag let go on the move comes down where the cursor was, not a moment behind it', async () => {
  const r = await dragging();
  for (let i = 0; i < 12; i++) {
    r.pointer.nudge({ dx: 20, dy: 0, held: true });
    r.settle(16);
  }
  const reached = r.moves().at(-1).x;
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(lastPress(r).down, false);
  assert.ok(reached - lastPress(r).x < 70, `${reached - lastPress(r).x} px behind, at 1,250 px/s`);
});

withClock('a pinch putting a drag down lands where that pinch was aimed', async () => {
  const r = steering();
  await pair(r);
  r.settle(150);
  r.pointer.nudge({ dx: 6, dy: 0 });
  r.settle(30);
  r.pointer.nudge({ dx: 60, dy: 0 });
  r.settle(300);
  const aimed = r.moves().at(-1).x;
  for (let i = 0; i < 6; i++) {
    r.pointer.nudge({ dx: 4, dy: 0 });
    r.settle(20);
  }
  r.pointer.nudge({ dx: 0, dy: 0, held: true });
  r.settle(150);
  r.pointer.nudge({ dx: 9, dy: 0, held: true });
  r.settle(60);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(lastPress(r).down, false);
  assert.ok(Math.abs(lastPress(r).x - aimed) < 1, `came down at ${lastPress(r).x}, aimed at ${aimed}`);
});

withClock('stopping lets go of a drag', async () => {
  const r = await dragging();
  r.pointer.nudge({ steering: false });
  await flush();
  assert.equal(lastPress(r).down, false);
  assert.equal(r.buttons().length, 2);
});

withClock('reports stopping lets go of a drag', async () => {
  const r = await dragging();
  r.settle(1300);
  await flush();
  assert.equal(lastPress(r).down, false);
});

withClock('a hand on the mouse lets go of a drag, and doesn\'t pick it up again', async () => {
  const r = await dragging();
  r.real = { x: 200, y: 200 };
  r.settle(40);
  await flush();
  assert.equal(lastPress(r).down, false);
  for (let t = 0; t < 1800; t += 200) {
    r.pointer.nudge({ dx: 0, dy: 0, held: true });
    r.settle(200);
  }
  assert.equal(r.buttons().filter((press) => press.down).length, 1, 'a finger still on the button doesn\'t start another');
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.clicks().length, 0, 'and lifting it clicks nothing');
});

const allFingers = (r, extra = {}) => r.pointer.nudge({ dx: 0, dy: 0, held: true, whole: true, ...extra });
/** Mid-carry: the window under the cursor has been picked up. */
async function carrying(options) {
  const r = steering(options);
  allFingers(r);
  r.settle(320);
  await flush();
  return r;
}

withClock('a quick pinch with all fingers is only ever a click: it can\'t move a window', async () => {
  const r = steering();
  allFingers(r);
  r.settle(120);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  r.settle(500);
  await flush();
  assert.deepEqual(r.clicks(), [{ x: 700, y: 400 }]);
  assert.equal(r.found().length, 0);
  assert.equal(r.outlines.length, 0);
});

withClock('held, all fingers pick up the window: outlined, and nothing is pressed', async () => {
  const r = await carrying();
  assert.deepEqual(r.found(), [{ x: 700, y: 400 }], 'the window at the spot aimed at');
  assert.deepEqual(r.outlines.at(-1), { x: 300, y: 100, w: 800, h: 600 });
  assert.equal(r.overlay.at(-1).down, true);
  assert.equal(r.buttons().length, 0);
  assert.equal(r.clicks().length, 0);
});

withClock('held, one finger still drags what\'s under the cursor, not the window', async () => {
  const r = steering();
  r.pointer.nudge({ dx: 0, dy: 0, held: true, whole: false });
  r.settle(320);
  await flush();
  assert.equal(r.found().length, 0);
  assert.equal(r.buttons().length, 1);
});

withClock('the window follows the hand, by as much as the cursor moves, and stays put when let go', async () => {
  const r = await carrying();
  allFingers(r, { dx: 120, dy: -40 });
  r.settle(200);
  await flush();
  const to = r.carried().at(-1);
  assert.ok(Math.abs(to.x - 420) < 1 && Math.abs(to.y - 60) < 1, `moved to ${to.x}, ${to.y}`);
  assert.equal(r.outlines.at(-1).w, 800, 'the outline keeps its size');
  assert.ok(Math.abs(r.outlines.at(-1).x - 420) < 1);
  const sent = r.carried().length;
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.outlines.at(-1), null, 'letting go puts the outline away');
  r.pointer.nudge({ dx: 50, dy: 0 });
  r.settle(200);
  await flush();
  assert.equal(r.carried().length, sent, 'and the window stays where it was put');
  assert.equal(r.clicks().length, 0, 'letting go isn\'t a click');
});

withClock('a window crosses onto the monitor', async () => {
  const r = await carrying({ start: { x: 20, y: 500 }, displays: [LAPTOP, MONITOR], window: { x: 0, y: 100, w: 500, h: 400 } });
  allFingers(r, { dx: -300 });
  r.settle(200);
  await flush();
  assert.ok(Math.abs(r.carried().at(-1).x + 300) < 1, `to ${r.carried().at(-1).x}`);
});

withClock('a slow app gets one move at a time, and ends up at the latest', async () => {
  const r = await carrying();
  r.holdMoves = [];
  for (let i = 0; i < 10; i++) {
    allFingers(r, { dx: 10 });
    r.settle(32);
    await flush();
  }
  assert.equal(r.carried().length, 1, 'the rest wait, not pile up');
  r.settle(200);
  await flush();
  r.holdMoves.shift()();
  await flush();
  r.holdMoves.shift()();
  await flush();
  assert.equal(r.carried().length, 2);
  assert.ok(Math.abs(r.carried().at(-1).x - 400) < 1, `caught up to ${r.carried().at(-1).x}`);
});

withClock('nothing to pick up: it says so, and nothing is clicked or left held', async () => {
  const r = await carrying({ window: null });
  assert.equal(r.toasts.at(-1), 'No window to move');
  allFingers(r);
  r.settle(40);
  assert.equal(r.overlay.at(-1).down, false, 'the ring doesn\'t say something is held');
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.clicks().length, 0);
  allFingers(r, { dx: 5 });
  r.settle(40);
  assert.equal(r.carried().length, 0);
});

withClock('let go just before it counts as held, it\'s a click, and no window is touched', async () => {
  const r = steering();
  allFingers(r);
  r.settle(280);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  assert.equal(r.found().length, 0);
  assert.equal(r.clicks().length, 1);
});

for (const [how, stop] of [
  ['stopping', (r) => r.pointer.nudge({ steering: false })],
  ['reports stopping', (r) => r.settle(1300)],
  ['a hand on the mouse', (r) => { r.real = { x: 200, y: 200 }; r.settle(40); }]
]) {
  withClock(`${how} puts a window down`, async () => {
    const r = await carrying();
    allFingers(r, { dx: 30 });
    r.settle(100);
    await flush();
    stop(r);
    await flush();
    assert.equal(r.outlines.at(-1), null);
    const sent = r.carried().length;
    r.settle(100);
    await flush();
    assert.equal(r.carried().length, sent);
    assert.equal(r.buttons().length, 0);
  });
}

withClock('steering crosses onto the monitor, which is at negative coordinates, and comes back', () => {
  const r = rig({ start: { x: 20, y: 500 }, displays: [LAPTOP, MONITOR] });
  r.pointer.nudge({ dx: -500, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x + 480) < 1, `reached ${r.moves().at(-1).x}`);
  assert.ok(r.overlay.at(-1).x < 0, 'and the ring went with it');
  r.pointer.nudge({ dx: 600, dy: 0 });
  r.settle(200);
  assert.ok(Math.abs(r.moves().at(-1).x - 120) < 1, `back to ${r.moves().at(-1).x}`);
});

withClock('a drag crosses screens too', async () => {
  const r = await dragging({ start: { x: 20, y: 500 }, displays: [LAPTOP, MONITOR] });
  r.pointer.nudge({ dx: -300, dy: 0, held: true });
  r.settle(200);
  r.pointer.nudge({ dx: 0, dy: 0, held: false });
  await flush();
  const up = lastPress(r);
  assert.equal(up.down, false);
  assert.ok(up.x < -200, `put down on the monitor, at ${up.x}`);
});

// The app's side of the helper, with a stand-in for it.
const FAKE_BRIDGE = `
  import readline from 'node:readline';
  const say = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
  const script = process.env.FAKE_BRIDGE || '';
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    say('heard', { message, argv: process.argv.slice(2) });
    if (message.cmd === 'start') {
      if (script === 'die') process.exit(1);
      say('bluetooth', { state: 'on' });
      say('nearby', { count: 1 });
      say('motion', { yaw: 10, pitch: 0, ms: 20, steering: true, click: false, typing: false });
      if (script === 'vanish') setTimeout(() => process.exit(1), 50);
    }
    if (message.cmd === 'pair') say('code', { code: '012345' });
    if (message.cmd === 'confirm') say('paired', { key: 'a2V5' });
  });
  process.stdin.on('end', () => process.exit(0));
`;

/** `refreshing`: as main.js does, setEnabled again after every change. */
function watchRig(t, { key, env = '', pairWindowMs, refreshing = false, saveKey } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-fake-bridge-'));
  const script = path.join(folder, 'bridge.mjs');
  fs.writeFileSync(script, FAKE_BRIDGE.replace("process.env.FAKE_BRIDGE || ''", JSON.stringify(env)));
  const r = { saved: [], reports: [], changes: 0, stored: key };
  r.watch = createWatch({
    binary: process.execPath,
    args: [script],
    loadKey: async () => r.stored,
    saveKey: saveKey || (async (value) => { r.saved.push(value); r.stored = value; }),
    forgetKey: async () => { r.stored = undefined; },
    onReport: (report) => r.reports.push(report),
    onChange: () => {
      r.changes += 1;
      if (refreshing) r.watch.setEnabled(true);
    },
    pairWindowMs
  });
  r.until = async (what, ms = 4000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error(`waited for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  t.after(() => {
    r.watch.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return r;
}

test('nothing runs until it\'s turned on, so nothing asks about Bluetooth', async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  await r.until(() => r.watch.state.paired);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(r.watch.state.bluetooth, '');
  assert.equal(r.reports.length, 0);
});

test('turned on, it starts the helper with the key, and steers once a frame is proved', async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length);
  assert.equal(r.watch.state.bluetooth, 'on');
  assert.equal(r.watch.state.connected, true);
  assert.equal(r.watch.state.steering, true);
  assert.equal(r.reports[0].yaw, 10);
});

test('turned off, the helper stops and steering is let go at once', async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length);
  r.watch.setEnabled(false);
  assert.deepEqual(r.reports.at(-1), { steering: false });
  assert.equal(r.watch.state.bluetooth, '');
  assert.equal(r.watch.state.connected, false);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(r.reports.length, 2, 'and it doesn\'t come back');
});

test('setEnabled is idempotent, as every refresh calls it', async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  r.watch.setEnabled(true);
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length);
  r.watch.setEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(r.reports.length, 1, 'one helper, not two');
});

test('pairing: a code to compare, then the key is saved, never before', async (t) => {
  const r = watchRig(t);
  r.watch.setEnabled(true);
  await r.until(() => r.watch.state.bluetooth === 'on');
  assert.equal(r.watch.state.paired, false);
  r.watch.pair();
  await r.until(() => r.watch.state.pairing === '012345');
  assert.deepEqual(r.saved, [], 'not until you confirm');
  r.watch.confirm();
  await r.until(() => r.watch.state.paired);
  assert.deepEqual(r.saved, ['a2V5']);
  assert.equal(r.watch.state.pairing, null);
});

test('confirming with no code to compare does nothing', async (t) => {
  const r = watchRig(t);
  r.watch.setEnabled(true);
  await r.until(() => r.watch.state.bluetooth === 'on');
  r.watch.confirm();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(r.watch.state.paired, false);
});

test('pairing closes by itself', async (t) => {
  const r = watchRig(t, { pairWindowMs: 50 });
  r.watch.setEnabled(true);
  await r.until(() => r.watch.state.bluetooth === 'on');
  r.watch.pair();
  await r.until(() => r.watch.state.problem);
  assert.equal(r.watch.state.pairing, null);
  assert.match(r.watch.state.problem, /timed out/);
});

test('forgetting drops the key', async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  await r.until(() => r.watch.state.paired);
  await r.watch.forget();
  assert.equal(r.stored, undefined);
  assert.equal(r.watch.state.paired, false);
});

test('a helper that keeps dying stops being restarted, and says so, however often the app refreshes', { timeout: 15000 }, async (t) => {
  const r = watchRig(t, { env: 'die', refreshing: true });
  r.watch.setEnabled(true);
  await r.until(() => r.watch.state.problem, 10000);
  assert.match(r.watch.state.problem, /keeps stopping/);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.match(r.watch.state.problem, /keeps stopping/, 'and it stays stopped');
  assert.equal(r.watch.state.bluetooth, '');
});

test('a helper that dies mid-steer lets go of the cursor at once', { timeout: 8000 }, async (t) => {
  const r = watchRig(t, { env: 'vanish' });
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length === 1);
  await r.until(() => r.reports.length === 2);
  assert.deepEqual(r.reports[1], { steering: false });
  assert.equal(r.watch.state.steering, false);
});

test('turned off while it waits to restart, it stays off', { timeout: 8000 }, async (t) => {
  const r = watchRig(t, { env: 'die' });
  r.watch.setEnabled(true);
  await r.until(() => r.changes >= 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  r.watch.setEnabled(false);
  const changes = r.changes;
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(r.watch.state.bluetooth, '');
  assert.equal(r.changes, changes, 'no helper came back');
});

test('turning it on again after that starts afresh', { timeout: 8000 }, async (t) => {
  const r = watchRig(t, { key: 'a2V5' });
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length === 1);
  r.watch.setEnabled(false);
  r.watch.setEnabled(true);
  await r.until(() => r.reports.length === 3);
  assert.equal(r.watch.state.steering, true);
});

test('a key that can\'t be saved isn\'t called paired', async (t) => {
  const r = watchRig(t, { saveKey: async () => { throw new Error('no keychain'); } });
  r.watch.setEnabled(true);
  await r.until(() => r.watch.state.bluetooth === 'on');
  r.watch.pair();
  await r.until(() => r.watch.state.pairing === '012345');
  r.watch.confirm();
  await r.until(() => r.watch.state.problem);
  assert.equal(r.watch.state.paired, false);
  assert.match(r.watch.state.problem, /save/);
});

test('on Windows, there\'s no helper to look for', () => {
  assert.equal(bridgePath({ platform: 'win32' }), null);
  assert.equal(createWatch({ binary: null, loadKey: async () => undefined }).state.built, false);
});

test('the key isn\'t something a page can read', async () => {
  const bridge = fs.readFileSync(path.resolve(here, '../desktop/src/main/chrome-bridge.js'), 'utf8');
  assert.match(bridge, /PRIVATE_KEYS = Object\.freeze\(\[[^\]]*'watchKey'/);
});

const on = { enabled: true, watchEnabled: true };
const ready = { built: true, bluetooth: 'on', paired: true };

test('Settings says what the watch needs next', () => {
  assert.match(watchStatus({}, on), /npm run watch/);
  assert.match(watchStatus({ built: true }, { enabled: false }), /off/);
  assert.match(watchStatus({ built: true }, { enabled: true }), /wrist/);
  assert.match(watchStatus({ ...ready, bluetooth: 'denied' }, on), /Privacy & Security/);
  assert.match(watchStatus({ ...ready, bluetooth: 'off' }, on), /Turn Bluetooth on/);
  assert.match(watchStatus({ ...ready, bluetooth: 'starting' }, on), /Starting/);
  assert.match(watchStatus({ ...ready, paired: false }, on), /Pair/);
  assert.match(watchStatus(ready, on), /open Jester/);
  assert.match(watchStatus({ ...ready, connected: true }, on), /Tap Start/);
  assert.match(watchStatus({ ...ready, connected: true, steering: true }, on), /Steering/);
  assert.match(watchStatus({ ...ready, problem: 'Pairing failed.' }, on), /Pairing failed/);
});

test('pairing can only be confirmed with a number showing', () => {
  const start = watchPairing({ built: true, bluetooth: 'on' }, on);
  assert.deepEqual([start.op, start.disabled], ['pair', false]);
  assert.equal(watchPairing({ built: true, bluetooth: 'off' }, on).disabled, true, 'Bluetooth off');
  assert.equal(watchPairing({ built: true, bluetooth: 'on' }, { enabled: true }).disabled, true, 'switched off');
  const waiting = watchPairing({ ...ready, pairing: 'waiting' }, on);
  assert.deepEqual([waiting.op, waiting.disabled, waiting.cancellable], ['confirm', true, true]);
  const code = watchPairing({ ...ready, pairing: '012345' }, on);
  assert.deepEqual([code.title, code.op, code.disabled], ['012345', 'confirm', false]);
  assert.equal(watchPairing(ready, on).op, 'forget');
});

test('the menu offers the watch only once it\'s paired', () => {
  const byId = (model) => Object.fromEntries(model.items.filter((item) => item.id).map((item) => [item.id, item]));
  const engine = { state: 'running' };
  assert.equal(byId(trayModel({ engine, settings: on })).watch, undefined);
  assert.equal(byId(trayModel({ engine, settings: on, watch: { paired: false } })).watch, undefined);
  assert.equal(byId(trayModel({ engine, settings: on, watch: { paired: true } })).watch.checked, true);
  assert.equal(byId(trayModel({ engine, settings: { enabled: false }, watch: { paired: true } })).watch.enabled, false);
});
