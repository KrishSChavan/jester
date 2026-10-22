/**
 * One display's overlay. The engine's telemetry reaches every page; only the
 * overlay on the active display (the main process says which) draws from it.
 */

import { GESTURES } from '../ext/src/common/constants.js';

const display = Number(new URLSearchParams(location.search).get('display'));
const $ = (id) => document.getElementById(id);
const TOAST_MS = { info: 1600, warn: 3200 };

let active = false;
let showHud = true;
let toastTimer = null;

function hideHud() {
  $('hud').hidden = true;
}

/** How far through holding a pose you are; gone once it fires or you let go. */
function drawHud(telemetry) {
  const pose = telemetry && GESTURES.find((gesture) => gesture.id === telemetry.gesture);
  const progress = Number(telemetry?.progress) || 0;
  if (!pose || telemetry.sleeping || progress <= 0 || progress >= 1) return hideHud();
  $('hud-glyph').textContent = pose.glyph;
  $('hud-label').textContent = pose.label;
  $('hud-fill').style.width = `${Math.round(progress * 100)}%`;
  $('hud').hidden = false;
}

function toast(text, tone = 'info', detail = '') {
  hideHud();
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
    default:
      break;
  }
});
