/**
 * The calibration screen.
 *
 * Runs in its own tab, put fullscreen, because that is the only way to know
 * exactly where a dot is on the *screen* — which is what the eyes are looking
 * at. A content-script overlay would only know its own viewport, and a
 * viewport moves and resizes independently of the screen.
 *
 * The rules are the pointer's own: look at the dot, then show the camera an
 * open palm and close it into a fist. The fist is the click, and here the click
 * says "I'm looking at it now". What is learned is how the face tracker's
 * reading of your eyes and head — iris positions, lids, gaze blendshapes, head
 * pose; numbers, never pictures — maps to where on the screen you look.
 *
 * Thirteen dots, three rounds: the same dots in the same order each round, and
 * every look teaches the model. Each round is then graded by a fit made from
 * the other two — the same question the cursor will be asked, so the grade is
 * roughly what you will get. A re-centre is one dot, for when you've moved
 * since.
 *
 * The division of labour: the offscreen document streams what it reads off the
 * eyes and the hand every frame and knows nothing about dots; this page owns
 * the capture and the fit, because it is the only context that knows which dot
 * is lit and where on the screen it sits.
 */

import { MSG, loadSettings } from '../common/constants.js';
import { fromEngine } from '../common/senders.js';
import {
  CALIBRATION_DOTS,
  CALIBRATION_ROUNDS,
  CAPTURE_WINDOW_MS,
  GazeModel,
  MIN_LOOK_MS,
  RECENTRE_TARGET,
  SETTLE_MS,
  fitCalibration,
  gradeHold,
  holdMinFrames,
  makeGazeFilter,
  poseSummary,
  recentreBias,
  screenToViewport,
  summariseHold,
  viewportToScreen
} from '../common/gaze.js';
import {
  STORE_KEY,
  calibrationGrade,
  loadCalibration,
  saveCalibration,
  usableModel
} from '../common/gaze-store.js';

const el = (id) => document.getElementById(id);
const ui = {
  intro: el('intro'), field: el('field'), result: el('result'),
  startBtn: el('startBtn'), recentreBtn: el('recentreBtn'), cancelBtn: el('cancelBtn'),
  doneBtn: el('doneBtn'), redoBtn: el('redoBtn'), redoPointsBtn: el('redoPointsBtn'),
  target: el('target'), ringFill: el('ringFill'), monitor: el('monitor'),
  hint: el('hint'), progress: el('progress'),
  introPreview: el('introPreview'), introPlaceholder: el('introPlaceholder'),
  livePreview: el('livePreview'), livePlaceholder: el('livePlaceholder'),
  checkEngine: el('checkEngine'), checkTracker: el('checkTracker'), checkFace: el('checkFace'),
  checkEyes: el('checkEyes'), checkClear: el('checkClear'), checkPalm: el('checkPalm'),
  checkFist: el('checkFist'), preflightHint: el('preflightHint'), readout: el('readout'),
  chipFace: el('chipFace'), chipEyes: el('chipEyes'), chipHand: el('chipHand'),
  resultTitle: el('resultTitle'), resultGrade: el('resultGrade'),
  resultHint: el('resultHint'), resultDetail: el('resultDetail'),
  resultPoints: el('resultPoints'), tryNote: el('tryNote'), tryNotePlain: el('tryNotePlain'),
  gazeDot: el('gazeDot'),
  misses: el('misses'),
  breakCard: el('breakCard'), breakTitle: el('breakTitle'), breakText: el('breakText'), breakCount: el('breakCount')
};

/**
 * How many times one dot is offered before the run stops insisting, when it
 * won't come round again: a re-centre, or a dot redone from the result screen.
 *
 * There has to be a limit. A hold that fails the same way three times is
 * usually a person who holds still like that, and a screen that refuses to move
 * on is a screen you close. Past this the attempt with the most usable frames
 * is taken — flagged, so the result screen can offer it back — or, with
 * nothing usable in any of them, the dot is skipped.
 */
const MAX_ATTEMPTS = 3;

/**
 * Within a round, a dot is offered twice, then the round moves on without it:
 * it comes round again next round. Simulated, dropping 15% of holds at random
 * cost nothing measurable, and a flawed best-of hold was no better than none —
 * what matters is not losing a dot in every round, which the catch-up covers.
 */
const ROUND_ATTEMPTS = 2;

/** The breather between rounds: lower the hand, blink, rest the eyes. */
const BREAK_MS = 3000;

/** Readings kept, for a capture to look back over. Comfortably longer than the window. */
const BUFFER_MS = 1500;

/**
 * The dot doesn't slide to its next place — the eyes would follow it and be
 * mid-flight when it stopped. It goes blank for a moment, then appears.
 */
const BLANK_MS = 200;
/** How long a taken dot shows as taken before the next one. */
const TAKEN_MS = 260;

/**
 * Lost eyes are only mentioned once they've been lost this long. Anything that
 * changes on screen pulls the eyes toward it, and a blink or a hand passing
 * the face shouldn't cost a sample of somewhere other than the dot.
 */
const LOST_GRACE_MS = 1000;

/** A hold's verdict stays on screen this long before anything replaces it. */
const VERDICT_HOLD_MS = 2600;

/**
 * An eye narrower than this corner to corner, in camera pixels, is a few
 * pixels of iris: the reading is noise, and the engine aims with the head
 * instead (its `EYES_MIN_PX`). Calibrating from there would teach it noise —
 * and make a calibration the engine would never use from that seat — so a
 * hold's frames are held to it too.
 */
const MIN_EYE_WIDTH = 22;
const MIN_EYE_HEIGHT = 5;

/** Redo passes the result screen offers, so it can't ask forever. */
const MAX_REDO_PASSES = 2;

const RING_CIRCUMFERENCE = 263.9;

let stage = 'intro';
/** 'full' — three rounds of thirteen dots — or 'recentre', one dot against the stored calibration. */
let mode = 'full';
/**
 * Dots still to show, in order: `{ kind: 'dot' | 'recentre', pass, round, index }`,
 * `pass` being 'round', 'catch-up', 'redo' or 'recentre'.
 *
 * A queue rather than a counter because a dot can be handed back — offered
 * again after a bad hold, or picked out for a redo once the result is in.
 */
let queue = [];
/**
 * What each look taught, by round and dot: `holds[round][index]` is
 * `{ rows, poses, x, y, bestOf }` — or null, skipped this round; undefined,
 * not taken yet.
 */
let holds = [];
/** Per queued dot key: how many holds it has taken, and the best of them so far. */
let attempts = new Map();
/** Per dot, the failed attempt with the most usable frames in any round: the catch-up's and the redo's best-of. */
let dotBest = new Map();
let redoPasses = 0;
/** Whether the one-more-go pass after round three has been offered. */
let catchUpOffered = false;
let catchUpTotal = 0;
/** The breather's timers, so Esc and Backspace can stop it. */
let interludeTimer = null;
let interludeStart = null;
let lastAccepted = null;
/** When the current dot appeared. The eyes need a moment to get there. */
let dotShownAt = 0;
let dotTimer = null;
/** The pause between a dot being taken and the next one appearing — tracked, so Esc and Backspace can stop it. */
let nextDotTimer = null;
/**
 * After a hold is sent back, the next try's frames start once the hand has
 * opened again (`retryFrom`), not while it was still closed on the last one.
 */
let retryFrom = 0;
let awaitingRearm = false;
/** The camera the run started with: readings from two cameras can't make one calibration. */
let runCamera = '';
/** The round whose breather has been shown, so handing back that round's last dot doesn't show it twice. */
let breatherFor = -1;
/** Recent readings, one per camera frame, for a capture to look back over. */
let frames = [];
let lastSample = 0;
/** A fist has closed since the page opened — the pre-flight's practice click. */
let fistSeen = false;
/** Since when the eyes have been unreadable while a dot is lit, or 0. */
let lostSince = 0;
/** Lost-eyes advice is on screen, to be cleared once the eyes are back. */
let lostShown = false;
let hintHoldUntil = 0;
/** Why the last Start was refused, kept on screen until the engine speaks again. */
let refusal = '';
/**
 * Why the last run was stopped, kept on the intro until another starts. Not
 * `refusal`: the engine that noticed the problem is still talking, and every
 * message it sends clears that.
 */
let notice = '';
/** The calibration being made — or, for a re-centre, the one being adjusted. */
let model = null;
/** The stored calibration, if it can be re-centred. */
let stored = null;
/** The calibration a re-centre is adjusting, as it was when the re-centre began. */
let recentring = null;
/** The result screen's dot: the new calibration, live. */
let tryModel = null;
/** The grade's held-out readings, redrawn as lines when the screen changes size. */
let lastScore = null;
let tryFilter = null;
let settings = await loadSettings();

/**
 * The clock every timing here runs on: milliseconds since the epoch, at
 * high resolution. The engine says how old each reading's picture is, and it
 * is placed on this clock from that, so a hold's frames are judged by when
 * they were seen, not by when the message carrying them happened to arrive —
 * which, behind a busy engine, can be a frame or two later.
 */
const clock = () => performance.timeOrigin + performance.now();

/**
 * Everything the engine last told us about what it can see, and when.
 *
 * `at` is the important one: the engine only speaks while it is actually
 * running, so silence here is itself the diagnosis — a stopped or suspended
 * engine looks exactly like a face that isn't being seen, and without a
 * timestamp the screen cannot tell the user which it is.
 */
let live = {
  at: 0, tracker: 'idle', trackerError: '', cameraId: '',
  face: false, eyes: false, occluded: false, cropped: false,
  eyeWidth: 0, eyeHeight: 0, ear: 0,
  hand: false, handState: null, handArmed: false, handOpenness: 0, handProgress: 0
};

const dotKey = (item) => `${item.kind}:${item.round}:${item.index}`;
const targetOf = (item) => (item.kind === 'recentre' ? RECENTRE_TARGET : CALIBRATION_DOTS[item.index]);
/** Mid-run: a dot on screen, or the breather between rounds. */
const inRun = () => stage === 'running' || stage === 'break';
/** A hold taken cleanly (not a best-of) in any round. */
const cleanHold = (index) => holds.some((round) => round[index] && !round[index].bestOf);
/** The round slot a catch-up or redo hold fills: the first one missing, or taken as a best-of. */
const slotFor = (index) => Math.max(0, holds.findIndex((round) => !round[index] || round[index].bestOf));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function show(next) {
  stage = next;
  document.body.dataset.stage = next;
  ui.intro.hidden = next !== 'intro';
  ui.field.hidden = !['running', 'break', 'fitting'].includes(next);
  ui.breakCard.hidden = next !== 'break';
  ui.result.hidden = next !== 'result';
  if (next !== 'result') {
    ui.gazeDot.hidden = true;
    ui.misses.replaceChildren();
  }
}

const current = () => queue[0] ?? null;

/** Blank for a moment, then the next dot — where it is, not sliding there. */
function presentDot() {
  clearTimeout(dotTimer);
  const item = current();
  if (!item) return;
  ui.target.hidden = true;
  dotShownAt = Infinity;
  dotTimer = setTimeout(() => {
    const target = targetOf(item);
    ui.target.style.setProperty('--tx', target.x);
    ui.target.style.setProperty('--ty', target.y);
    // The hint sits beside the dot — below it, or above for the bottom row —
    // so reading it doesn't take the eyes across the screen.
    ui.hint.style.setProperty('--tx', target.x);
    ui.hint.style.setProperty('--ty', target.y);
    ui.hint.classList.toggle('above', target.y > 0.7);
    // The progress and Esc lines sit at the bottom middle — where the bottom
    // row's middle dot is. While a dot is down there, they move to the top.
    ui.field.classList.toggle('dot-low', target.y > 0.8 && Math.abs(target.x - 0.5) < 0.3);
    // Farthest corner from the dot, for when the camera view is needed.
    ui.monitor.style.setProperty('--mx', target.x < 0.5 ? 1 : 0);
    ui.monitor.style.setProperty('--my', target.y < 0.5 ? 1 : 0);
    ui.target.classList.remove('captured');
    ui.target.hidden = false;
    paintRing(0);
    dotShownAt = clock();
    retryFrom = 0;
    awaitingRearm = false;
    // Words about the last dot don't belong beside this one, and anything
    // beside the dot pulls the eyes; let a verdict finish, then clear it.
    setTimeout(() => {
      if (clock() >= hintHoldUntil && !lostShown) hint('');
    }, Math.max(0, hintHoldUntil - clock()));
  }, BLANK_MS);
  paintProgress(item);
}

function paintProgress(item) {
  const label = targetOf(item).label;
  if (item.pass === 'recentre') {
    ui.progress.textContent = 'Re-centring — one dot';
  } else if (item.pass === 'catch-up') {
    ui.progress.textContent = `One more go · ${catchUpTotal - queue.length + 1} of ${catchUpTotal} — ${label}`;
  } else if (item.pass === 'redo') {
    ui.progress.textContent = `Redoing ${label} — ${queue.length} left`;
  } else {
    ui.progress.textContent =
      `Round ${item.round + 1} of ${CALIBRATION_ROUNDS} · ${item.index + 1} of ${CALIBRATION_DOTS.length} — ${label}`;
  }
}

function paintRing(fraction) {
  ui.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
}

function hint(text, warn = false) {
  ui.hint.textContent = text;
  ui.hint.classList.toggle('warn', warn);
}

function verdictHint(text, warn = true) {
  hint(text, warn);
  hintHoldUntil = clock() + VERDICT_HOLD_MS;
}

// ---------------------------------------------------------------------------
// Live feedback
//
// The screen has to answer "is it seeing me?" at a glance. Without that, a dot
// that never takes is indistinguishable from a stopped camera, a face it can't
// find, eyes too small to read, a hand in front of them, and a hand that never
// quite opens — five problems with five different fixes.
// ---------------------------------------------------------------------------

/** Feed older than this means the engine has stopped talking to us. */
const SIGNAL_TIMEOUT_MS = 1500;

const alive = () => clock() - live.at < SIGNAL_TIMEOUT_MS;
const eyesReadable = () =>
  live.eyes && !live.cropped && live.eyeWidth >= MIN_EYE_WIDTH && live.eyeHeight >= MIN_EYE_HEIGHT;

function setCheck(node, ok, bad = false) {
  node.className = `check${ok ? ' ok' : bad ? ' bad' : ''}`;
}

function setChip(node, ok) {
  node.className = `chip${ok ? ' ok' : ''}`;
}

/** The pre-flight's one line: the first thing in the way, or else the next step. */
function preflightText(signal, ready) {
  if (!signal) {
    if (refusal || notice) return refusal || notice;
    // The lease lapses on purpose while this page is in the background.
    if (!document.hasFocus()) return 'Paused while this window is in the background — click on it to carry on.';
    return "Jester isn't sending camera frames. Check it's switched on and the camera is allowed.";
  }
  if (notice) return notice;
  if (live.tracker === 'failed') {
    return `The eye tracker couldn't start (${live.trackerError || 'unknown error'}). Try Restart in the toolbar popup.`;
  }
  if (!ready) return 'Loading the eye tracker…';
  if (!live.face) return 'No face in view — sit where the camera can see you.';
  if (live.occluded) return 'Your hand is in front of your eyes — hold it out beside your shoulder instead.';
  if (live.cropped || (live.eyes && (live.eyeWidth < MIN_EYE_WIDTH || live.eyeHeight < MIN_EYE_HEIGHT))) {
    return (
      "You're too far from the camera for your eyes to be read. Calibrate from about arm's length — " +
      'from across the room the pointer aims with your head, which needs no calibration.'
    );
  }
  if (!live.eyes) {
    return "Your face is in view but your eyes aren't readable. Face the camera, with light on your face and nothing across your eyes.";
  }
  if (fistSeen) return "That's it — you're ready. Start when you like.";
  if (!live.hand) return 'Now raise your open palm to the camera, out beside your shoulder.';
  return "Close it into a fist. That's the click: open, then closed.";
}

function paintFeedback() {
  const signal = alive();
  const ready = signal && live.tracker === 'ready';

  // Intro pre-flight.
  setCheck(ui.checkEngine, signal, !signal);
  setCheck(ui.checkTracker, ready, signal && live.tracker === 'failed');
  setCheck(ui.checkFace, ready && live.face);
  // The tracker places eyes behind a hand as confidently as in plain view, so
  // "readable" has to mean uncovered too.
  setCheck(ui.checkEyes, ready && eyesReadable() && !live.occluded, ready && live.face && live.eyes && !eyesReadable());
  setCheck(ui.checkClear, ready && live.hand && !live.occluded, ready && live.occluded);
  setCheck(ui.checkPalm, signal && (live.handArmed || live.handState === 'open'));
  setCheck(ui.checkFist, signal && fistSeen);

  ui.preflightHint.textContent = preflightText(signal, ready);

  // The raw measurements, so eyes that "won't register" can be diagnosed
  // against actual numbers instead of guesswork.
  ui.readout.textContent = signal
    ? `eyes ${live.eyes ? `${Math.round(live.eyeWidth)}×${Math.round(live.eyeHeight)} px` : '—'} · ` +
      `lids ${live.ear.toFixed(2)} · hand ${live.hand ? live.handOpenness.toFixed(2) : '—'}`
    : '—';
  ui.readout.className = `readout ${ready && eyesReadable() ? 'ok' : ''}`;

  // Live monitor.
  if (signal) {
    setChip(ui.chipFace, live.face);
    setChip(ui.chipEyes, eyesReadable() && !live.occluded);
    setChip(ui.chipHand, live.handArmed);
    ui.chipHand.textContent =
      live.handState === 'fist' ? 'Hand ✊'
        : live.handArmed ? 'Hand ✋ ready'
          : live.hand ? 'Hand — open it'
            : 'Hand';
  } else {
    // Not "absent" — unknown. Nothing is reporting, so claiming the face is
    // merely missing would be inventing an observation we never made.
    for (const chip of [ui.chipFace, ui.chipEyes, ui.chipHand]) chip.className = 'chip bad';
  }

  if (!signal) {
    ui.introPreview.classList.remove('live');
    ui.livePreview.classList.remove('live');
    ui.introPlaceholder.hidden = false;
    ui.livePlaceholder.hidden = false;
    ui.introPlaceholder.textContent = 'No camera frames';
    ui.livePlaceholder.textContent = 'No camera';
  }
}

/** What's wrong, once the eyes have been lost for a while — in the order the problems block you. */
function lostAdvice() {
  if (!alive()) return "Jester has stopped sending camera frames — press Esc, then check it's still switched on.";
  if (live.tracker === 'failed') return 'The eye tracker stopped — press Esc, then Restart from the toolbar popup.';
  if (live.tracker !== 'ready') return 'Loading the eye tracker…';
  if (!live.face) return "Your face isn't in view.";
  if (live.occluded) return 'Your hand is in front of your eyes — hold it out beside your shoulder.';
  if (live.cropped || (live.eyes && live.eyeWidth < MIN_EYE_WIDTH)) {
    return "You're too far from the camera for your eyes to be read — come closer.";
  }
  return "Can't read your eyes — face the camera, with light on your face.";
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/**
 * One frame of readings from the offscreen document.
 *
 * `confirm` is the engine's own open-to-fist edge — the same one that clicks
 * the cursor — so calibration is taught with exactly the gesture it will be
 * used with.
 */
function onFeed(msg) {
  const now = clock();
  // When the reading's picture was taken: the engine says how long ago.
  const seenAt = msg.age >= 0 ? now - msg.age : now;
  // Recorded whatever the stage, because the intro screen's pre-flight is
  // driven by exactly the same feed.
  live = {
    at: now,
    tracker: msg.tracker || 'idle',
    trackerError: msg.trackerError || '',
    cameraId: msg.cameraId || '',
    face: !!msg.face,
    eyes: !!msg.eyes,
    occluded: !!msg.occluded,
    cropped: !!msg.cropped,
    eyeWidth: msg.eyeWidth || 0,
    eyeHeight: msg.eyeHeight || 0,
    ear: msg.ear || 0,
    hand: !!msg.hand,
    handState: msg.handState || null,
    handArmed: !!msg.handArmed,
    handOpenness: msg.handOpenness || 0,
    handProgress: msg.handProgress || 0
  };
  if (msg.confirm) fistSeen = true;
  // A hold was sent back: the next one's frames start when the hand has opened
  // again, not while it was still closed on the last try or the eyes were
  // reading the advice.
  if (awaitingRearm && msg.handArmed) {
    awaitingRearm = false;
    retryFrom = seenAt;
  }
  // The engine is speaking again: whatever stopped the last Start is no longer
  // the reason if it goes quiet later.
  refusal = '';
  if (existing && stage === 'intro') paintRecentre();
  // The camera the run started with went away — the engine restarted onto
  // another. Readings from two cameras can't make one calibration.
  if (inRun() && runCamera && msg.cameraId && msg.cameraId !== runCamera) {
    cancel('The camera changed during the calibration, so it was stopped. Start again with the camera you will use.');
    return;
  }

  // The engine speaks every tick, and ticks can outrun the camera: count each
  // camera frame once, or a stalled camera would look like a steady gaze.
  const fresh = !!msg.sample && msg.sample !== lastSample;
  if (fresh) {
    lastSample = msg.sample;
    frames.push({
      at: seenAt,
      face: !!msg.face,
      occluded: !!msg.occluded,
      // Too far away to learn from: a face read zoomed-in isn't comparable
      // with one from the whole frame (see the engine's zoom), and eyes this
      // small are aimed with the head, not the eyes, once calibrated.
      far: !!msg.cropped || (!!msg.eyes && !((msg.eyeWidth || 0) >= MIN_EYE_WIDTH)),
      features: msg.eyes && !msg.cropped ? msg.features : null,
      ear: msg.ear || 0,
      iris: msg.iris || null,
      pose: msg.pose || null
    });
    while (frames.length && now - frames[0].at > BUFFER_MS) frames.shift();
  }
  paintFeedback();

  if (stage === 'result') {
    if (fresh && msg.eyes && !msg.cropped && !msg.occluded && !msg.blink) followGaze(msg.features);
    return;
  }
  if (stage !== 'running') return;

  // The dot itself carries the feedback, since that is where the eyes are:
  // a full ring once the palm is open and armed, emptying as the hand closes,
  // red once the eyes have been lost for more than a moment.
  // What a hold's frames are tested for: eyes read, uncovered, near enough.
  const readable =
    live.tracker === 'ready' && live.face && live.eyes && !live.cropped && live.eyeWidth >= MIN_EYE_WIDTH && !live.occluded;
  if (readable) lostSince = 0;
  else if (!lostSince) lostSince = now;
  paintLost(now);
  paintRing(live.handArmed ? 1 - live.handProgress : 0);

  if (msg.confirm) {
    capture(seenAt);
    return;
  }
}

/**
 * The lost state, painted on the dot. Also run on a timer, because silence is
 * a way of being lost too: an engine that stops sends nothing to say so.
 */
function paintLost(now) {
  if (!alive() && !lostSince) lostSince = now;
  const lost = !!lostSince && now - lostSince > LOST_GRACE_MS;
  ui.target.classList.toggle('lost', lost);
  ui.monitor.classList.toggle('show', lost);
  if (!alive()) paintRing(0);
  // Words only when something has been wrong for a while: text changing next
  // to the dot is the other thing that pulls the eyes off it — and gone again
  // once it's put right.
  if (lost && now >= hintHoldUntil) {
    hint(lostAdvice(), true);
    lostShown = true;
  } else if (!lost && lostShown) {
    hint('');
    lostShown = false;
  }
}

// ---------------------------------------------------------------------------
// Judging a hold
//
// What separates this from "capture thirty-nine things and fit them" is that a hold
// can be *wrong* in ways the user can fix — and only while they're still in
// front of the dot. Saying so then costs one more close of the hand; saying so
// at the end costs the whole run.
// ---------------------------------------------------------------------------

/**
 * What to tell the user, per reason a hold was sent back.
 *
 * `covered` earns the longest explanation because nobody guesses it: the hand
 * that confirms goes up "to the camera", which for a laptop is straight in
 * front of the face it is confirming for.
 */
const HOLD_ADVICE = {
  'no-frames': 'Nothing came through for that one — look at the dot, then close your hand.',
  'too-short': 'Too quick to read. Look at the dot for a moment before you close your hand.',
  'no-face': "Your face wasn't in view for that one. Face the camera and try that dot again.",
  'too-far': "You're too far from the camera for your eyes to be read. Come closer — about arm's length — and try that dot again.",
  covered: 'Your hand was in front of your eyes. Hold it out beside your shoulder, and try that dot again.',
  blinked: 'You blinked as your hand closed. Try that dot again — eyes open until the fist lands.',
  unreadable: "Couldn't read your eyes for that one — face the camera, with light on your face, and try again.",
  slow: 'The camera is sending too few frames to read that one. More light helps (cameras slow down in the dark), or hit Restart in the toolbar popup.',
  'eyes-moved': 'Your eyes moved off the dot as your hand closed — often a glance at the hand. Keep looking at the dot until the fist lands.'
};

/**
 * Where a dot is on the screen, in CSS pixels — what the eyes were aimed at.
 *
 * Fullscreen, the page *is* the screen. If fullscreen was refused, the page's
 * own position on the screen is added back; if even that can't be worked out,
 * the page is treated as the screen, which is at least not worse than the
 * guess the finger pointer always made.
 */
function targetOnScreen(target) {
  return (
    viewportToScreen(window, target.x * window.innerWidth, target.y * window.innerHeight) ||
    { x: target.x * window.screen.width, y: target.y * window.screen.height }
  );
}

/** The typical gap between camera frames lately, in ms — or 0 if there's too little to say. */
function frameInterval() {
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].at - frames[i - 1].at);
  if (gaps.length < 3) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

function capture(now) {
  const item = current();
  if (!item) return;

  // The eyes take a beat to find a new dot. A fist this soon after it lit up
  // was made while they were still travelling — or was meant for the last one.
  if (now - dotShownAt < MIN_LOOK_MS) {
    verdictHint('Look at the dot first, then close your hand.');
    return;
  }

  // From the moment the eyes had settled on the dot — and, after a try that
  // was sent back, from when the hand opened again for this one.
  const from = Math.max(now - CAPTURE_WINDOW_MS, dotShownAt + SETTLE_MS, retryFrom);
  const summary = summariseHold(frames.filter((f) => f.at >= from && f.at <= now));
  // How many frames to expect depends on how fast they are really arriving.
  const interval = frameInterval();
  let verdict = gradeHold(summary, { minFrames: holdMinFrames(interval, now - from) });
  if (verdict.reason === 'too-short' && interval > 90) verdict = { verdict: 'reject', reason: 'slow' };

  const key = dotKey(item);
  const record = attempts.get(key) || { tries: 0, best: null };
  record.tries += 1;
  // The attempt with the most usable frames, kept in case the dot runs out of tries.
  if (summary && summary.usable > 0 && (!record.best || summary.usable > record.best.usable)) {
    record.best = summary;
  }
  attempts.set(key, record);
  // The best *failed* attempt at this dot, in any round: a passing one is
  // either kept already or was handed back with Backspace, and must not come
  // back as a best-of.
  if (
    item.kind === 'dot' &&
    verdict.verdict !== 'ok' &&
    summary &&
    summary.usable > 0 &&
    !(dotBest.get(item.index)?.usable >= summary.usable)
  ) {
    dotBest.set(item.index, summary);
  }

  const limit = item.pass === 'round' || item.pass === 'catch-up' ? ROUND_ATTEMPTS : MAX_ATTEMPTS;
  if (verdict.verdict !== 'ok' && record.tries < limit) {
    verdictHint(HOLD_ADVICE[verdict.reason] || HOLD_ADVICE['no-frames']);
    awaitingRearm = true;
    return;
  }

  // Out of attempts. Inside a round the dot is simply left for its next round:
  // a flawed hold teaches nothing a clean one next time round won't. Once it
  // won't come round again, the attempt with the most to learn from is taken,
  // flagged so the result screen can offer it back — or, with nothing usable
  // in any of them, the dot is skipped rather than teach the model a blink or
  // a hand.
  let accepted = verdict.verdict === 'ok' ? summary : null;
  let bestOf = false;
  if (verdict.verdict === 'ok') {
    verdictHint('Got it.', false);
  } else if (item.pass === 'round') {
    verdictHint(movingOn(item));
  } else {
    const best = item.kind === 'recentre' ? record.best : dotBest.get(item.index);
    // A re-centre is one dot that moves everything: a best-of must be a real
    // reading, not two frames, or it would shift the whole cursor on noise.
    const floor = item.kind === 'recentre' ? holdMinFrames(interval, now - from) : 2;
    accepted = best && best.usable >= floor ? best : null;
    bestOf = true;
    // Only promise a redo that the result screen will actually offer.
    const redoable = item.kind === 'dot' && redoPasses < MAX_REDO_PASSES;
    verdictHint(
      accepted
        ? `Taking the best of those${redoable ? ' — you can redo it at the end' : ''}.`
        : `Skipping that one${redoable ? '. You can redo it at the end' : ''}.`
    );
  }

  const point = targetOnScreen(targetOf(item));
  const taken = accepted && { rows: accepted.rows, index: accepted.index, poses: accepted.poses, x: point.x, y: point.y, bestOf };
  if (item.kind === 'recentre') {
    if (taken) {
      finishRecentre(taken);
      return;
    }
  } else {
    // null: skipped this round.
    holds[item.round][item.index] = taken || null;
  }
  lastAccepted = item;

  // Green only for a dot that was taken; one moved past or skipped just goes.
  if (accepted) {
    ui.target.classList.add('captured');
    paintRing(1);
  }
  queue.shift();
  // Until the next dot is actually on screen, nothing counts: a second fist in
  // the moment between dots would otherwise be credited to a dot not yet shown,
  // with the eyes still on this one.
  dotShownAt = Infinity;
  advance(item);
}

/** What a round says when it moves on without a dot. */
function movingOn(item) {
  if (cleanHold(item.index)) return 'Moving on — that dot already read cleanly.';
  if (item.round < CALIBRATION_ROUNDS - 1) return 'Moving on — that dot comes round again.';
  return 'Moving on — one more go at the end.';
}

/**
 * After a dot is settled: the next dot — or the breather before a new round,
 * the one-more-go pass once the rounds are done, or the fit.
 */
function advance(done) {
  const next = current();
  if (!next) {
    if (mode === 'recentre') {
      finishRecentre(null);
      return;
    }
    const missing = catchUpOffered ? [] : uncleanDots();
    if (missing.length) {
      interlude({ kind: 'catch-up', count: missing.length }, startCatchUp);
      return;
    }
    finish();
    return;
  }
  // A new round gets its breather once: handing back the last round's final
  // dot and retaking it mustn't make the user sit through it again.
  if (next.pass === 'round' && done.kind === 'dot' && next.round !== done.round && breatherFor !== done.round) {
    breatherFor = done.round;
    interlude({ kind: 'round', finished: done.round + 1, next: next.round + 1 }, () => {
      presentDot();
      verdictHint('Same dots, same order. Keep looking at each one until your fist lands.', false);
    });
    return;
  }
  clearTimeout(nextDotTimer);
  nextDotTimer = setTimeout(presentDot, TAKEN_MS);
}

/**
 * Dots with no clean hold in any round: the one-more-go pass's list after the
 * rounds, and the result screen's offer to redo after it.
 */
const uncleanDots = () => CALIBRATION_DOTS.map((_, index) => index).filter((index) => !cleanHold(index));

function startCatchUp() {
  catchUpOffered = true;
  // Recomputed: a Backspace retake during the breather may have filled one.
  queue = uncleanDots().map((index) => ({ kind: 'dot', pass: 'catch-up', round: slotFor(index), index }));
  catchUpTotal = queue.length;
  // Its own two tries: the slot's record still holds that round's two failures.
  for (const item of queue) attempts.delete(dotKey(item));
  if (!queue.length) {
    finish();
    return;
  }
  presentDot();
  verdictHint('One more go at this one. Look at the dot, then close your hand.', false);
}

/**
 * The breather: between rounds, and before the one-more-go pass. A card in the
 * middle of the screen — where the next round's first dot will light — counts
 * down, then the run goes on by itself. The next dot waits for a fist anyway,
 * so the rest is as long as anyone wants.
 */
function interlude(what, then) {
  clearInterlude();
  interludeStart = setTimeout(() => {
    interludeStart = null;
    show('break');
    ui.target.hidden = true;
    hint('');
    lostShown = false;
    ui.progress.textContent = '';
    if (what.kind === 'round') {
      ui.breakTitle.textContent = `Round ${what.finished} of ${CALIBRATION_ROUNDS} done`;
      // The "moving on" for a round's last dot would only have been on screen
      // for a moment before this card, so the card says it.
      const last = holds[what.finished - 1]?.[CALIBRATION_DOTS.length - 1];
      ui.breakText.textContent =
        (last === null ? "The last dot didn't read — it comes round again. " : '') +
        'Lower your hand, blink, rest your eyes — but keep your head where it is.';
    } else {
      ui.breakTitle.textContent = 'Nearly done';
      ui.breakText.textContent =
        what.count === 1
          ? "One dot didn't read cleanly in any round. One more go at it."
          : `${what.count} dots didn't read cleanly in any round. One more go at each.`;
    }
    let left = Math.round(BREAK_MS / 1000);
    const paint = () => {
      ui.breakCount.textContent = what.kind === 'round' ? `Round ${what.next} starts in ${left}` : `Starting in ${left}`;
    };
    paint();
    interludeTimer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        paint();
        return;
      }
      clearInterlude();
      // Whatever was lost before the breather is judged afresh on the next dot.
      lostSince = 0;
      show('running');
      then();
    }, 1000);
  }, TAKEN_MS);
}

function clearInterlude() {
  clearTimeout(interludeStart);
  clearInterval(interludeTimer);
  interludeStart = null;
  interludeTimer = null;
}

/**
 * Hand the last dot back, on request.
 *
 * The user knows they fluffed a hold a beat before any measurement can — they
 * felt their eyes flick away. Without this the only remedy is the whole run
 * again.
 */
function redoLast() {
  if (!inRun() || !lastAccepted) return;
  // Works in the breather too: the last dot of the round before comes back,
  // and once it's taken the breather — cut short, or not yet shown — comes
  // round again. One that already ran its course doesn't.
  const breatherPending = interludeStart !== null;
  clearInterlude();
  clearTimeout(nextDotTimer);
  if (breatherPending) breatherFor = -1;
  if (stage === 'break') {
    breatherFor = -1;
    show('running');
  }
  const item = lastAccepted;
  if (item.kind === 'dot') {
    // A hold handed back is not to return as some later "best of those".
    const handedBack = holds[item.round][item.index];
    if (handedBack && dotBest.get(item.index)?.rows === handedBack.rows) dotBest.delete(item.index);
    holds[item.round][item.index] = undefined;
  }
  attempts.delete(dotKey(item));
  if (current() !== item) queue.unshift(item);
  lastAccepted = null;
  presentDot();
  verdictHint('Back to that one. Take it again.', false);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function setMode(on) {
  await chrome.runtime.sendMessage({ type: MSG.CALIBRATION_MODE, on }).catch(() => {});
}

/** How long Start waits for the feed to come back to a page brought to the front. */
const RESUME_WAIT_MS = 1500;

/** Refuse to start into a dead engine, and say what to fix. */
async function engineReady() {
  // `alive()` is trustworthy here because the feed has been running since the
  // page loaded — see the boot block at the bottom — except while the page
  // was in the background, when the lease lapses on purpose: the click that
  // brought it back renewed it, and the feed is a moment behind.
  if (!alive()) {
    await setMode(true);
    const until = clock() + RESUME_WAIT_MS;
    while (!alive() && clock() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let problem = '';
  if (!alive()) {
    const state = await chrome.runtime.sendMessage({ type: MSG.GET_STATE }).catch(() => null);
    problem = engineProblem(state);
  } else if (live.tracker === 'failed') {
    problem = `The eye tracker couldn't start (${live.trackerError || 'unknown error'}). Try Restart in the toolbar popup.`;
  } else if (live.tracker !== 'ready') {
    problem = 'The eye tracker is still loading — give it a moment, then start again.';
  }
  if (!problem) {
    refusal = '';
    return true;
  }
  refusal = problem;
  // Said where the user pressed the button: on the result screen too, whose
  // "Calibrate again" would otherwise seem to do nothing.
  if (stage === 'result') ui.resultHint.textContent = problem;
  paintFeedback();
  ui.preflightHint.textContent = problem;
  return false;
}

async function start() {
  if (!(await engineReady())) return;
  mode = 'full';
  holds = Array.from({ length: CALIBRATION_ROUNDS }, () => []);
  attempts = new Map();
  dotBest = new Map();
  redoPasses = 0;
  catchUpOffered = false;
  catchUpTotal = 0;
  model = null;
  // Every dot, in order, then all of them again: the user's own definition of
  // one calibration.
  queue = [];
  for (let round = 0; round < CALIBRATION_ROUNDS; round += 1) {
    CALIBRATION_DOTS.forEach((_, index) => queue.push({ kind: 'dot', pass: 'round', round, index }));
  }
  await runField('Look at the dot, then show your open palm and close it into a fist.');
}

async function startRecentre() {
  if (!stored || !(await engineReady())) return;
  mode = 'recentre';
  recentring = stored;
  attempts = new Map();
  queue = [{ kind: 'recentre', pass: 'recentre', round: 0, index: 0 }];
  await runField('Look at the dot, then open your hand and close it.');
}

/**
 * Show the queued dots, keeping every dot already taken.
 *
 * This is the whole reason the run is a queue: redoing the two dots that went
 * badly is twenty seconds, and redoing all thirteen to get at them is the
 * reason people don't bother.
 */
async function runField(message, redo = null) {
  clearInterlude();
  clearTimeout(nextDotTimer);
  if (redo) {
    redoPasses += 1;
    // The dots being redone are the whole of this pass: when they're done the
    // result comes back, not the one-more-go pass.
    catchUpOffered = true;
    queue = redo.map((index) => ({ kind: 'dot', pass: 'redo', round: slotFor(index), index }));
    for (const item of queue) {
      holds[item.round][item.index] = undefined;
      attempts.delete(dotKey(item));
    }
  }
  lastAccepted = null;
  tryModel = null;
  // A run that fails mustn't show the last one's miss lines on its result.
  lastScore = null;
  notice = '';
  lostSince = 0;
  lostShown = false;
  breatherFor = -1;
  runCamera = live.cameraId || '';
  ui.target.classList.remove('lost');
  ui.monitor.classList.remove('show');

  // Fullscreen first, and only then the first dot: the page becoming the
  // screen moves everything on it, and a dot lit before that would have its
  // settling time spent while it jumped. Failing is survivable —
  // `targetOnScreen()` adds the page's position back — so don't abort over it.
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  }
  show('running');
  presentDot();
  verdictHint(message, false);
}


/**
 * Where the display's real corner is relative to where Chrome says its usable
 * area starts. The content script needs it to place the cursor on a second
 * screen, and only now — fullscreen, with the window at the display's corner —
 * can it be measured.
 */
function displayInsets() {
  if (!document.fullscreenElement) return null;
  return {
    insetX: window.screen.availLeft - window.screenX,
    insetY: window.screen.availTop - window.screenY
  };
}

async function finish() {
  // Fresh: Settings may have changed while this tab was open — the camera
  // picked, the smoothing, the pointer switched on or off.
  settings = await loadSettings();
  show('fitting');
  ui.target.hidden = true;
  hint('Checking each round against the other two…');
  ui.progress.textContent = '';
  // Let that paint: the fits below are a few hundred milliseconds of solid work.
  await new Promise((resolve) => setTimeout(resolve, 30));

  const taken = [];
  holds.forEach((round, r) =>
    round.forEach((hold, index) => {
      if (hold) taken.push({ ...hold, round: r, dot: index });
    })
  );
  const fitted = fitCalibration(taken, {
    screenW: window.screen.width,
    screenH: window.screen.height,
    display: displayInsets(),
    cameraDeviceId: settings.cameraDeviceId || '',
    // The camera the run was made through — checked on every frame of it.
    cameraId: runCamera || live.cameraId || '',
    pose: poseSummary(taken.flatMap((hold) => hold.poses))
  });

  show('result');
  ui.redoPointsBtn.hidden = true;
  ui.resultPoints.textContent = '';
  ui.tryNote.hidden = true;
  ui.tryNotePlain.hidden = true;

  if (!fitted.ok) {
    await document.exitFullscreen?.().catch(() => {});
    ui.resultTitle.textContent = "That didn't take";
    ui.resultGrade.textContent = '';
    ui.resultGrade.className = 'grade poor';
    ui.resultHint.textContent = fitted.detail;
    ui.resultDetail.textContent = '';
    return;
  }

  model = fitted.model;
  const score = fitted.score;
  lastScore = score;
  // A look the other rounds disagreed with was left out. If it was its dot's
  // only look, that dot now has nothing — say so, and offer it back.
  for (const hold of fitted.dropped) {
    if (!taken.some((other) => other.dot === hold.dot && !fitted.dropped.includes(other))) holds[hold.round][hold.dot] = null;
  }
  await saveCalibration(model);
  await chrome.runtime.sendMessage({ type: MSG.CALIBRATION_SAVED }).catch(() => {});

  const grade = calibrationGrade(model.error);
  ui.resultTitle.textContent = 'Calibrated';
  // Partly checked: a round couldn't be read by a fit made from the others,
  // so the figure comes from the rounds that could.
  const partial = model.errorMethod === 'rounds-partial';
  ui.resultGrade.textContent = score ? `Accuracy: ${grade.grade}${partial ? ' (partly checked)' : ''}` : 'Accuracy: not checked';
  ui.resultGrade.className = `grade ${score ? grade.grade : 'usable'}`;
  ui.resultHint.textContent = score
    ? grade.hint
    : "There weren't two rounds to check against each other, so there's no measure of how close it is. Try it below.";
  // Said only when it's so: with the pointer switched off, ✋ still fires its
  // own binding, and a user reading "✋ raises the cursor" would be misled.
  const aims = {
    auto: 'it appears where you look, and small turns of your head fine-tune it',
    eyes: 'it goes where you look',
    head: 'it follows your head — set Aim with to "Eyes and head" in Settings to use this calibration'
  };
  const palm = settings.pointerEnabled
    ? ` From now on, an open palm ✋ raises the cursor instead of firing its pose: ${aims[settings.pointerAim] || aims.auto}. ` +
      'To play or pause, put it on the video and close your hand.'
    : ' The pointer is switched off — turn it on in Settings to use it.';
  ui.resultDetail.textContent =
    (score
      ? `Typical miss about ${Math.round(model.errorPx)} px — ${(model.error * 100).toFixed(1)}% of the screen's width — ` +
        (partial
          ? 'reading the rounds that could be checked with a fit made from the others.'
          : 'reading each round with a fit made from the other two.')
      : '') + palm;
  drawMisses(score);

  // Stay fullscreen and show where the new calibration thinks you're looking:
  // seeing it is worth more than any number above.
  startTry(model);
  // The note about lines only where lines were drawn.
  ui.tryNote.hidden = !score;
  ui.tryNotePlain.hidden = !!score;

  // Worth offering back: no clean hold in any round. After the catch-up this is almost always none.
  const trouble = redoPasses < MAX_REDO_PASSES ? uncleanDots() : [];
  if (!trouble.length) return;
  const labels = trouble.map((index) => CALIBRATION_DOTS[index].label);
  ui.resultPoints.textContent =
    trouble.length === 1
      ? `The ${labels[0]} dot never read cleanly — redoing it on its own may help.`
      : `These never read cleanly: ${labels.join(', ')}. Redoing just those is quicker than starting over.`;
  ui.redoPointsBtn.hidden = false;
  ui.redoPointsBtn.textContent =
    trouble.length === 1 ? `Redo the ${labels[0]} dot` : `Redo those ${trouble.length} dots`;
  ui.redoPointsBtn.onclick = async () => {
    if (await engineReady()) runField('Just these. Look at the dot, then open your hand and close it.', trouble);
  };
}

/** The result screen's dot: a calibration, live, through the cursor's own filter. */
function startTry(calibrationModel) {
  tryModel = new GazeModel(calibrationModel);
  tryFilter = makeGazeFilter({
    smoothing: settings.pointerSmoothing,
    noisePx: tryModel.noisePx,
    noiseRho: tryModel.noiseRho,
    screenW: tryModel.screenW,
    fps: Math.max(5, 1000 / (frameInterval() || 50))
  });
}

/**
 * A re-centre: one dot, measured through the stored calibration, and the
 * difference kept as an offset. The pose is re-recorded too, since this is the
 * new "how you sit".
 */
async function finishRecentre(taken) {
  show('result');
  ui.redoPointsBtn.hidden = true;
  ui.resultPoints.textContent = '';
  ui.tryNote.hidden = true;
  ui.tryNotePlain.hidden = true;
  // Cleared or replaced — from Settings, or another tab — while the dot was
  // up: adjusting the old one would bring it back over whatever is there now.
  const changed = !recentring || stored !== recentring;
  const bias = !changed && taken && recentreBias(recentring, taken.rows, { x: taken.x, y: taken.y });
  if (!bias) {
    await document.exitFullscreen?.().catch(() => {});
    ui.resultTitle.textContent = "That didn't take";
    ui.resultGrade.textContent = '';
    ui.resultGrade.className = 'grade poor';
    ui.resultHint.textContent = changed
      ? 'The calibration was changed or cleared while the dot was up, so nothing was saved.'
      : "The dot couldn't be read. Try again, or run the full calibration.";
    ui.resultDetail.textContent = '';
    ui.redoPointsBtn.hidden = !stored;
    ui.redoPointsBtn.textContent = 'Try the re-centre again';
    ui.redoPointsBtn.onclick = startRecentre;
    return;
  }
  const previous = recentring.bias || [0, 0];
  // The new "how you sit" — except how far from the camera: a re-centre can't
  // fix distance, so the calibration's own distance stays the reference, and
  // "you've moved nearer or farther, recalibrate" can still be said.
  const now = poseSummary(taken.poses);
  const pose = now ? { ...now, span: recentring.pose?.span ?? now.span } : recentring.pose;
  model = { ...recentring, bias, pose, recentredAt: Date.now() };
  await saveCalibration(model);
  await chrome.runtime.sendMessage({ type: MSG.CALIBRATION_SAVED }).catch(() => {});

  ui.resultTitle.textContent = 'Re-centred';
  ui.resultGrade.textContent = '';
  ui.resultGrade.className = 'grade good';
  ui.resultHint.textContent =
    `The cursor moves ${Math.round(Math.hypot(bias[0] - previous[0], bias[1] - previous[1]))} px to match where you sit now. ` +
    "If it's still off, or you've moved nearer or farther from the camera, run the full calibration.";
  ui.resultDetail.textContent = '';
  startTry(model);
  ui.tryNotePlain.hidden = false;
  stored = model;
  existing = model;
}

/**
 * Where the other two rounds read each dot, drawn as a line from the dot: the
 * grade, made visible. Short lines are good; lines all pointing the same way
 * mean you moved during the calibration.
 */
function drawMisses(score) {
  ui.misses.replaceChildren();
  if (!score) return;
  const svgNs = 'http://www.w3.org/2000/svg';
  for (const dot of score.dots) {
    const from = screenToViewport(window, dot.x, dot.y);
    const to = screenToViewport(window, dot.px, dot.py);
    if (!from || !to) continue;
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    const start = document.createElementNS(svgNs, 'circle');
    start.setAttribute('cx', from.x);
    start.setAttribute('cy', from.y);
    start.setAttribute('r', 5);
    ui.misses.append(line, start);
  }
}

/** Move the result screen's dot to where the new calibration says you're looking. */
function followGaze(features) {
  if (!tryModel || !Array.isArray(features)) return;
  const reading = tryModel.predict(features);
  if (!reading) return;
  const smoothed = tryFilter.next(reading.x, reading.y);
  const inPage = screenToViewport(window, smoothed.x, smoothed.y);
  if (!inPage) return;
  const x = Math.min(window.innerWidth, Math.max(0, inPage.x));
  const y = Math.min(window.innerHeight, Math.max(0, inPage.y));
  ui.gazeDot.style.transform = `translate(${x}px, ${y}px)`;
  ui.gazeDot.hidden = false;
}

/** Turn the engine's own state into the specific thing the user must fix. */
function engineProblem(state) {
  if (!state) return "Jester's background service isn't responding. Reload the extension and try again.";
  if (!state.settings?.enabled) return 'Jester is switched off. Turn it on from the toolbar popup or Settings, then try again.';
  const engine = state.engine?.state;
  if (engine === 'no-permission') return 'Camera access has not been granted. Allow it from the Settings page, then try again.';
  if (engine === 'error') return `The engine reported a problem: ${state.engine.detail || 'unknown error'}`;
  return 'No camera frames are arriving yet. Give it a second, or hit Restart in the toolbar popup.';
}

/**
 * Stop the run. With a reason, back to the start, saying it; without one —
 * Esc — the tab closes. Either way nothing is saved, and the calibration that
 * was there stays.
 */
async function cancel(reason = '') {
  clearTimeout(dotTimer);
  clearTimeout(nextDotTimer);
  clearInterlude();
  if (reason) {
    queue = [];
    // Off the field first: leaving fullscreen mid-run is itself a cancel —
    // the plain kind, which closes the tab — and the reason would go unread.
    show('intro');
    notice = reason;
    paintFeedback();
    await document.exitFullscreen?.().catch(() => {});
    return;
  }
  await setMode(false);
  await document.exitFullscreen?.().catch(() => {});
  window.close();
}

async function done() {
  await document.exitFullscreen?.().catch(() => {});
  window.close();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ui.startBtn.addEventListener('click', start);
ui.recentreBtn.addEventListener('click', startRecentre);
// Not `cancel` itself: the click event would arrive as its reason.
ui.cancelBtn.addEventListener('click', () => cancel());
ui.doneBtn.addEventListener('click', done);
ui.redoBtn.addEventListener('click', start);

document.addEventListener('keydown', (event) => {
  if (!inRun()) return;
  if (event.key === 'Escape') cancel();
  // You know you fluffed a hold before any measurement can — you felt your
  // eyes move. Backspace hands the last dot back rather than making that cost
  // the whole run.
  if (event.key === 'Backspace') redoLast();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  // Readings and pictures come from the engine, and only from it: a content
  // script's messages reach this page too.
  if (!fromEngine(sender)) return false;
  if (message?.type === MSG.CALIBRATION_FEED) onFeed(message);
  if (message?.type === MSG.PREVIEW_FRAME) showPreview(message.dataUrl);
  return false;
});

/**
 * The camera preview, in both stages.
 *
 * This is the part that actually answers "can it see my eyes" — the offscreen
 * document draws the hand skeleton and boxes the two eyes it is reading onto
 * these frames, so the user can see the tracking rather than infer it from a
 * dot that isn't taking.
 */
function showPreview(dataUrl) {
  for (const [img, placeholder] of [
    [ui.introPreview, ui.introPlaceholder],
    [ui.livePreview, ui.livePlaceholder]
  ]) {
    img.src = dataUrl;
    img.classList.add('live');
    placeholder.hidden = true;
  }
}

// Preview frames are only produced while something asks for them, at a cost of
// one JPEG encode per frame — so it is a heartbeat, not a switch, and it beats
// only while a preview is on screen: the intro's, or the run's corner monitor.
const previewShown = () =>
  document.visibilityState === 'visible' && (stage === 'intro' || (inRun() && ui.monitor.classList.contains('show')));
setInterval(() => {
  if (previewShown()) chrome.runtime.sendMessage({ type: MSG.PREVIEW_PING }).catch(() => {});
}, 700);
chrome.runtime.sendMessage({ type: MSG.PREVIEW_PING }).catch(() => {});

// Silence is a state too, and nothing pushes it — a stopped engine sends no
// message saying it stopped. Repaint on a timer so the readout decays to "no
// camera" instead of freezing on the last good frame.
setInterval(() => {
  paintFeedback();
  if (stage === 'running') paintLost(clock());
}, 400);

// Leaving fullscreen part-way through means the dots no longer sit where the
// fit will think they did, so the run is void rather than merely interrupted —
// in any round, or a breather. Nothing is saved until the end.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && inRun()) cancel();
  // The result screen's lines are drawn in page pixels, which move when the
  // page stops (or starts) being the whole screen.
  else if (stage === 'result') drawMisses(lastScore);
});

window.addEventListener('pagehide', () => setMode(false));

/**
 * Calibration mode follows this tab's visibility.
 *
 * It has to be on while the tab is in front, so the pre-flight can see the
 * camera and no stray cursor lands on top of the dots. It has to be off the
 * moment the tab isn't, or a finished calibration screen left open in the
 * background would keep the pointer suppressed everywhere else and hold the
 * engine awake for nothing.
 */
document.addEventListener('visibilitychange', () => {
  setMode(document.visibilityState === 'visible');
});

/**
 * The feed runs from page load, not from Start.
 *
 * The pre-flight readout above is driven by the same messages as the run
 * itself, so it can only tell the user whether the camera can see them if the
 * engine is already streaming while they are still reading the instructions.
 * It also keeps the engine awake: this tab has no video in it, so
 * `pauseWhenNoVideo` would otherwise suspend inference the moment it opened —
 * and it is what makes the engine load its eye tracker.
 */
setMode(true);
// The engine holds calibration on a short lease and drops it when the beats
// stop. That is deliberate: if this tab dies without a clean shutdown, the
// engine must recover on its own rather than stay stuck suppressing every
// gesture until the browser restarts. And the beats only come while this page
// is in use — mid-run, or focused: a result screen left open on another
// monitor mustn't keep every gesture switched off.
setInterval(() => {
  if (document.visibilityState === 'visible' && (inRun() || document.hasFocus())) setMode(true);
}, 900);
window.addEventListener('focus', () => {
  if (document.visibilityState === 'visible') setMode(true);
});

/**
 * A calibration that still applies can be re-centred instead of redone — but
 * only one that applies *here*: made through the camera that's open now, for a
 * screen this size. Re-centring any other would report success and change
 * nothing, since the engine and the page would still refuse it.
 */
let existing = null;
function paintRecentre() {
  const fits =
    usableModel(existing, { cameraId: live.cameraId || undefined }) &&
    existing.screenW === window.screen.width &&
    existing.screenH === window.screen.height;
  stored = fits ? existing : null;
  ui.recentreBtn.hidden = !stored;
}
loadCalibration().then((model) => {
  existing = model;
  paintRecentre();
});
// Cleared in Settings, or replaced from another tab, while this one is open:
// "Re-centre only" must adjust what is stored now, not what was there when the
// page loaded — or it would bring a cleared calibration back.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORE_KEY]) return;
  existing = changes[STORE_KEY].newValue || null;
  if (stored && stored !== existing) stored = null;
  paintRecentre();
});
paintFeedback();
show('intro');
