import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bindingsFor, mergeSettings, MSG, resumeGlyphs, resumesStandby, swipeBindingsFor } from '../jester-extension/src/common/constants.js';

const source = await readFile(new URL('../jester-extension/src/offscreen/offscreen.js', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to}`);
  return source.slice(start, end);
}

const FRAME_MS = 50;

/** The engine's own pose machine, read from its source, with a scripted hand and a clock of its own. */
function engine(settings) {
  const messages = [];
  const reports = [];
  const sandbox = vm.createContext({
    MSG, bindingsFor, swipeBindingsFor, resumesStandby, resumeGlyphs, settings,
    standby: false, running: true, viewContext: 'windowed', pointerView: null, lastResult: null,
    HAND_LOST_MS: 300, TRAIL_MS: 700,
    rec: { candidate: null, candidateSince: 0, candidateSeenAt: 0, fired: false, switchTo: null, switchSince: 0, lastFireAt: 0, lastActionAt: -1e9, lastHandAt: 0, trail: [] },
    clamp: (value, low, high) => Math.min(high, Math.max(low, value)),
    updatePointer: () => ({ active: false, arming: false }),
    pointerUsable: () => false,
    readHand: () => (sandbox.seen ? { gesture: sandbox.seen, score: 0.9, palm: { x: 100, y: 100 }, size: 50, landmarks: {} } : null),
    continuesTrail: () => true,
    detectSwipe: () => null,
    speedOverWindow: () => 0,
    cancelArming: () => undefined,
    releaseIfGone: null,
    endPointer: () => undefined,
    ensureFaceLandmarker: () => undefined,
    voice: { stop: () => undefined },
    post: (message) => messages.push(message),
    reportRunning: () => reports.push(sandbox.standby)
  });
  vm.runInContext(`${slice('function fire(action, source, gesture)', '// ---------------------------------------------------------------------------\n// The click hand')}\n${slice('/**\n * How long the pose that put Jester to sleep', '// ---------------------------------------------------------------------------\n// Telemetry + preview')}`, sandbox);
  let now = 10000;
  return {
    /** That pose (or 'None', or no hand at all) for `ms`. */
    show(gesture, ms) {
      sandbox.seen = gesture;
      for (let at = 0; at < ms; at += FRAME_MS) {
        now += FRAME_MS;
        sandbox.processHand(now, { landmarks: null }, 640, 480);
      }
    },
    get asleep() {
      return sandbox.standby;
    },
    fired: (action) => messages.filter((message) => message.action === action).length,
    reports
  };
}

const sleepOnVictory = () => mergeSettings({ enabled: true, bindings: { Victory: { action: 'SLEEP', repeat: false } }, windowedBindings: { Victory: { action: 'SLEEP', repeat: false } }, windowedBindingsEnabled: true });

test('a hold sleeps once, and says which way it went', () => {
  const jester = engine(sleepOnVictory());
  jester.show('Victory', 600);
  assert.equal(jester.asleep, true);
  assert.equal(jester.fired('SLEEP'), 1);
  assert.deepEqual(jester.reports, [true]);
});

test('one long hold stays asleep, though the model loses the pose for a moment on the way', () => {
  const jester = engine(sleepOnVictory());
  jester.show('Victory', 1100);
  // Longer than releaseMs (250 ms): the hand shifting, not let go of.
  jester.show('None', 350);
  jester.show('Victory', 1300);
  assert.equal(jester.asleep, true, 'it woke itself up');
  assert.equal(jester.fired('SLEEP'), 1);
});

test('so does a hold whose hand leaves the frame for a moment', () => {
  const jester = engine(sleepOnVictory());
  jester.show('Victory', 800);
  jester.show(null, 400);
  jester.show('Victory', 1000);
  assert.equal(jester.asleep, true);
});

test('let go of properly, the same gesture wakes it, and stays awake through the same dropout', () => {
  const jester = engine(sleepOnVictory());
  jester.show('Victory', 600);
  jester.show(null, 1200);
  jester.show('Victory', 1100);
  assert.equal(jester.asleep, false);
  assert.equal(jester.fired('SLEEP'), 2);
  jester.show('None', 350);
  jester.show('Victory', 1300);
  assert.equal(jester.asleep, false, 'it put itself back to sleep');
  assert.equal(jester.fired('SLEEP'), 2);
});

test('asleep, nothing else fires', () => {
  const jester = engine(sleepOnVictory());
  jester.show('Victory', 600);
  jester.show(null, 1200);
  jester.show('Thumb_Up', 1500);
  assert.equal(jester.asleep, true);
  assert.equal(jester.fired('SCROLL_UP'), 0);
});

test('every other pose still lets go after releaseMs', () => {
  const jester = engine(sleepOnVictory());
  jester.show('ILoveYou', 600);
  assert.equal(jester.fired('FULLSCREEN_TOGGLE'), 1);
  jester.show('None', 300);
  jester.show('ILoveYou', 1200);
  assert.equal(jester.fired('FULLSCREEN_TOGGLE'), 2);
});

test('a pose bound to sleep in one set does the other set\'s action in that context', () => {
  const jester = engine(mergeSettings({ enabled: true, bindings: { Victory: { action: 'SLEEP', repeat: false } }, windowedBindingsEnabled: true }));
  jester.show('Victory', 600);
  assert.equal(jester.asleep, false);
  assert.equal(jester.fired('MUTE_TOGGLE'), 1);
});

test('the engine takes sleep from outside, for the desktop\'s spoken command and menu', () => {
  assert.match(slice('case MSG.ENGINE_CONFIG:', 'case MSG.ENGINE_QUERY:'), /typeof message\.standby === 'boolean'\) setStandby\(message\.standby\)/);
});
