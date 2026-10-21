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

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
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
