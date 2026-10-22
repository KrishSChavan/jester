/**
 * One display's overlay. The engine's telemetry reaches every page; only the
 * overlay on the active display (the main process says which) draws from it.
 */

import { GESTURES, MSG } from '../ext/src/common/constants.js';

const display = Number(new URLSearchParams(location.search).get('display'));
const $ = (id) => document.getElementById(id);
const TOAST_MS = { info: 1600, warn: 3200 };
/** No frame for this long while listening and the pill leaves: the engine stopped mid-sentence. */
const VOICE_IDLE_MS = 1600;
/** How long what a command did stays up; a failure needs reading, and a little longer. */
const VOICE_ANSWER_MS = { ok: 2600, bad: 5200 };
const BAR_MIN = 6;
const BAR_MAX = 26;
/** What has been heard so far, kept to its end: the pill is one line. */
const HEARD_CHARS = 48;

let active = false;
let showHud = true;
let toastTimer = null;
let voiceTimer = null;

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

function hideVoice() {
  clearTimeout(voiceTimer);
  $('voice').hidden = true;
  document.body.classList.remove('voice-up');
}

/** Puts the pill up with one face — listening, or an answer — and re-arms its timeout. */
function showVoice(face, ms) {
  if ($('voice').hidden) fitToScreen();
  $('voice').className = `voice ${face}`;
  $('voice').hidden = false;
  document.body.classList.add('voice-up');
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(hideVoice, ms);
}

function answer(text, ok) {
  $('voice-say').textContent = String(text || '');
  showVoice(ok ? 'answer' : 'answer bad', ok ? VOICE_ANSWER_MS.ok : VOICE_ANSWER_MS.bad);
}

/**
 * The engine's voice frames — the mic's levels, what has been heard — and the
 * main process's answer once the command has been done (as in content.js).
 */
function drawVoice(voice) {
  if (voice.mic?.detail && ['error', 'no-permission'].includes(voice.mic.state)) return answer(voice.mic.detail, false);
  if (voice.phase === 'answer') return answer(voice.text, voice.ok !== false);
  if (voice.transcript?.text) {
    const text = voice.transcript.text;
    $('voice-heard').textContent = text.length > HEARD_CHARS ? `…${text.slice(-HEARD_CHARS)}` : text;
  }
  // A transcript-only frame says nothing about whether the pill should be up.
  if (voice.active === undefined) return;
  if (!voice.active) return hideVoice();
  if (voice.start) $('voice-heard').textContent = '';
  showVoice('listening', VOICE_IDLE_MS);
  if (!Array.isArray(voice.levels)) return;
  [...$('voice-bars').children].forEach((bar, i) => {
    const level = Math.min(1, Math.max(0, Number(voice.levels[i]) || 0));
    bar.style.height = `${BAR_MIN + level * (BAR_MAX - BAR_MIN)}px`;
  });
}

function ripple(message) {
  const ring = $('ripple');
  ring.style.transform = `translate3d(${message.x}px, ${message.y}px, 0)`;
  ring.classList.remove('go');
  void ring.offsetWidth; // restart the animation
  ring.classList.add('go');
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'jester/overlay-cursor':
      drawCursor(message);
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
      if (active) drawVoice(message.voice || {});
      break;
    default:
      break;
  }
});
