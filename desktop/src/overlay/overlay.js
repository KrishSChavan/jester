/**
 * One display's overlay. The engine's telemetry reaches every page; only the
 * overlay on the active display (the main process says which) draws from it.
 */

import { GESTURES, MSG } from '../ext/src/common/constants.js';
import { createOrb, ORB_STATES } from '../talk/orb.js';

const display = Number(new URLSearchParams(location.search).get('display'));
const $ = (id) => document.getElementById(id);
const TOAST_MS = { info: 1600, warn: 3200 };
/** No frame for this long while listening and the pill leaves: the engine stopped mid-sentence. */
const VOICE_IDLE_MS = 1600;
/** How long what a command did stays up; a failure needs reading, and a little longer. */
const VOICE_ANSWER_MS = { ok: 2600, bad: 5200 };
/** The assistant ends its own phase; this only catches one that died mid-task. */
const VOICE_THINKING_MS = 90000;
/** The main process ends what's said; this only catches a voice that died mid-sentence. */
const VOICE_SPEAKING_MS = 120000;
const BAR_MIN = 6;
const BAR_MAX = 26;
/** What has been heard so far, kept to its end: the pill is one line. */
const HEARD_CHARS = 48;
/** The library's 32 px design: its 20 px one is too faint to read in the pill. */
const ORB_PX = 32;
/** At 32 px, listening's and speaking's dots are too faint beside thinking's. Picked by eye from renders. */
const ORB_TUNE = { listening: { dotSize: 1.35 }, composing: { dotSize: 1.2 } };
/** What the pill says beside the orb. A task says what it's doing instead. */
const LABELS = { listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };

let active = false;
let showHud = true;
let toastTimer = null;
let voiceTimer = null;
/** What came for the pill while Jester talked, and takes it when he stops. */
let afterSpeech = null;
/** The last place reportPill said the pill ends. */
let pillSaid = '';
/** Only while the pill's up: this window always is, so a running orb would never stop. */
const orb = createOrb($('voice-orb'), {
  size: ORB_PX,
  preset: ORB_PX,
  color: getComputedStyle(document.documentElement).getPropertyValue('--orb'),
  tune: ORB_TUNE
});

/**
 * Keeps the pills inside the screen's usable area. macOS slides this window
 * down below the menu bar, so its bottom hangs off the screen, and the Dock
 * (or Windows' taskbar) covers the bottom of what's left.
 */
function fitToScreen() {
  const hidden = window.screenY + window.innerHeight - (screen.availTop + screen.availHeight);
  document.documentElement.style.setProperty('--inset-bottom', `${Math.max(0, hidden)}px`);
}

function hideHud() {
  $('hud').hidden = true;
}

/** How far through holding a pose you are; gone once it fires or you let go. */
function drawHud(telemetry) {
  const pose = telemetry && GESTURES.find((gesture) => gesture.id === telemetry.gesture);
  const progress = Number(telemetry?.progress) || 0;
  if (!pose || telemetry.sleeping || progress <= 0 || progress >= 1) return hideHud();
  if ($('hud').hidden) fitToScreen();
  $('hud-glyph').textContent = pose.glyph;
  $('hud-label').textContent = pose.label;
  $('hud-fill').style.width = `${Math.round(progress * 100)}%`;
  $('hud').hidden = false;
}

function toast(text, tone = 'info', detail = '') {
  hideHud();
  fitToScreen();
  $('toast-text').textContent = text;
  $('toast-detail').textContent = detail;
  $('toast').className = `pill toast ${tone}`;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), TOAST_MS[tone] || TOAST_MS.info);
}

const RING = 125.66;

/** The ring around the real cursor, in this overlay's own coordinates. */
function drawCursor(message) {
  const cursor = $('cursor');
  if (message.hidden) {
    cursor.hidden = true;
    return;
  }
  cursor.style.transform = `translate3d(${message.x}px, ${message.y}px, 0)`;
  $('ring').style.strokeDashoffset = String(RING * (1 - Math.min(1, Math.max(0, message.progress || 0))));
  cursor.classList.toggle('down', !!message.down);
  cursor.classList.toggle('head', !!message.head);
  cursor.classList.toggle('away', !!message.away);
  cursor.hidden = false;
}

/** The outline round a window being carried, in this overlay's own coordinates. */
function drawOutline(message) {
  const outline = $('outline');
  outline.hidden = !!message.hidden;
  if (message.hidden) return;
  outline.style.transform = `translate3d(${message.x}px, ${message.y}px, 0)`;
  outline.style.width = `${message.w}px`;
  outline.style.height = `${message.h}px`;
}

/**
 * Says where the pill ends, for the × beside it (src/main/stop-button.js), which
 * has a window of its own: this one lets every click through. Where it's laid
 * out, so before it has slid into place too.
 */
function reportPill() {
  const pill = $('voice');
  if (pill.hidden) return;
  const end = { x: pill.offsetLeft + pill.offsetWidth / 2, y: pill.offsetTop + pill.offsetHeight / 2 };
  const said = JSON.stringify(end);
  if (said === pillSaid) return;
  pillSaid = said;
  chrome.runtime.sendMessage({ type: 'jester/pill', display, end });
}

function hideVoice() {
  clearTimeout(voiceTimer);
  afterSpeech = null;
  orb.show(null);
  $('voice').hidden = true;
  $('voice').style.minWidth = '';
  pillSaid = '';
  document.body.classList.remove('voice-up');
}

/**
 * Puts the pill up with one face — listening, thinking, speaking or an
 * answer — and re-arms its timeout. `held`: listening with no mic frames
 * coming, as when he's waiting for what's said to him; the orb shows it.
 */
function showVoice(face, ms, { held = false } = {}) {
  if ($('voice').hidden) fitToScreen();
  $('voice').className = `voice ${face}${held ? ' held' : ''}`;
  const mood = face === 'listening' && !held ? '' : face;
  orb.show(ORB_STATES[mood] || null);
  const working = mood === 'thinking' && !!($('voice-task').textContent || $('voice-step').textContent);
  $('voice-label').textContent = working ? '' : LABELS[mood] || '';
  if (face !== 'thinking' && face !== 'speaking') $('voice').style.minWidth = '';
  $('voice').hidden = false;
  document.body.classList.add('voice-up');
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(hideVoice, ms);
  reportPill();
}

function answer(text, ok) {
  $('voice-say').textContent = String(text || '');
  showVoice(ok ? 'answer' : 'answer bad', ok ? VOICE_ANSWER_MS.ok : VOICE_ANSWER_MS.bad);
}

/**
 * The engine's voice frames — the mic's levels, what has been heard — and the
 * main process's answer once the command has been done (as in content.js).
 */
function drawLevels(levels) {
  if (!Array.isArray(levels)) return;
  [...$('voice-bars').children].forEach((bar, i) => {
    const level = Math.min(1, Math.max(0, Number(levels[i]) || 0));
    bar.style.height = `${BAR_MIN + level * (BAR_MAX - BAR_MIN)}px`;
  });
}

/** Which face the pill shows now, if it's up. */
function face() {
  const pill = $('voice');
  return pill.hidden ? '' : ['speaking', 'listening', 'thinking', 'answer'].find((name) => pill.classList.contains(name)) || '';
}

/** The assistant's work is over, and was said rather than shown: its pill goes, and so does one waiting behind his speech. */
function taskOver() {
  if (afterSpeech?.phase === 'thinking') afterSpeech = null;
  if (face() === 'thinking') hideVoice();
}

/** Jester talking: {ms?} starts it or keeps it up, {done:true} ends it, and what waited takes over. */
function speak({ done = false, ms = VOICE_SPEAKING_MS }) {
  if (!done) return showVoice('speaking', ms);
  if (face() !== 'speaking') return;
  const next = afterSpeech;
  afterSpeech = null;
  $('voice').classList.remove('speaking');
  orb.show(null);
  if (next) drawVoice(next);
  else hideVoice();
}

/**
 * The engine's voice frames — the mic's levels, what has been heard — and the
 * main process's: the assistant at work and how a command went (as in
 * content.js). The assistant's questions have a window of their own
 * (src/main/approval.js), which takes clicks; this one never does.
 */
function drawVoice(voice) {
  const showing = face();
  if (voice.phase === 'speaking') return speak(voice);
  if (voice.phase === 'thinking' && voice.done) return taskOver();
  if (showing === 'speaking') {
    // Only the end of speech, or a deliberate new command, takes the pill from him.
    if (voice.phase === 'thinking' || voice.phase === 'answer' || voice.hold) afterSpeech = voice;
    else if (voice.active === false || voice.start) afterSpeech = null;
    if (!voice.start || voice.hold) return;
  }
  if (voice.mic?.detail && ['error', 'no-permission'].includes(voice.mic.state)) return answer(voice.mic.detail, false);
  if (voice.phase === 'answer') return answer(voice.text, voice.ok !== false);
  // The assistant at work: what it's doing ("stop" ends it).
  if (voice.phase === 'thinking') {
    $('voice-task').textContent = voice.task || '';
    $('voice-step').textContent = voice.step || '';
    showVoice('thinking', VOICE_THINKING_MS);
    // It only grows during a task: the × beside it is something to aim at.
    $('voice').style.minWidth = `${$('voice').offsetWidth}px`;
    return;
  }
  if (voice.transcript?.text) {
    const text = voice.transcript.text;
    $('voice-heard').textContent = text.length > HEARD_CHARS ? `…${text.slice(-HEARD_CHARS)}` : text;
  }
  // A transcript-only frame says nothing about whether the pill should be up.
  if (voice.active === undefined) return;
  if (!voice.active) return hideVoice();
  // The assistant at work keeps the pill, unless a new command is starting.
  if (showing === 'thinking' && !voice.start) return;
  if (voice.start) $('voice-heard').textContent = '';
  // `hold`: Jester waiting for more, with no mic frames to keep the pill up.
  showVoice('listening', voice.hold || VOICE_IDLE_MS, { held: !!voice.hold });
  drawLevels(voice.levels);
}

function ripple(message) {
  const ring = $('ripple');
  ring.style.transform = `translate3d(${message.x}px, ${message.y}px, 0)`;
  ring.classList.remove('go');
  void ring.offsetWidth; // restart the animation
  ring.classList.add('go');
}

new ResizeObserver(reportPill).observe($('voice'));

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'jester/overlay-cursor':
      drawCursor(message);
      break;
    case 'jester/overlay-outline':
      drawOutline(message);
      break;
    case 'jester/overlay-ripple':
      ripple(message);
      break;
    case 'jester/overlay-active':
      active = message.display === display;
      showHud = message.showHud !== false;
      if (!active || !showHud) hideHud();
      break;
    case 'jester/telemetry':
      if (active && showHud) drawHud(message.telemetry);
      break;
    case 'jester/overlay-toast':
      toast(message.text, message.tone, message.detail);
      break;
    case MSG.VOICE:
      // An ending reaches a display the pointer has left, or its pill would stay up.
      if (active || message.voice?.done) drawVoice(message.voice || {});
      break;
    default:
      break;
  }
});
