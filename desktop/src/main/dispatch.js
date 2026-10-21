/**
 * A gesture's action, done to the computer: os-actions.js says what it
 * means here, jester-driver presses it, the overlay says what happened.
 */

import { execFile } from 'node:child_process';
import { ACTIONS, GESTURES, SWIPES } from '../../../jester-extension/src/common/constants.js';
import { DESKTOP_LABELS, describePlan, osPlan } from './os-actions.js';

export function actionLabel(action) {
  return DESKTOP_LABELS[action] || ACTIONS[action]?.label || action;
}

/** "✋ Open palm", "⬅️ Swipe left" — what the engine says was made. */
export function gestureName(source, gesture) {
  const known = (source === 'swipe' ? SWIPES : GESTURES).find((item) => item.id === gesture);
  return known ? `${known.glyph} ${known.label}` : String(gesture || '');
}

/**
 * @param {object} deps
 * @param {{call: Function}|null} deps.driver
 * @param {() => Promise<object>} deps.getSettings
 * @param {() => boolean} deps.canPost  false until macOS allows Accessibility
 * @param {(op:string) => void} deps.onJester  voice, calibrate
 * @param {(text:string, options?:object) => void} deps.toast
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {string} [deps.platform]
 */
export function createDispatcher({ driver, getSettings, canPost, onJester, toast, log = () => undefined, platform = process.platform }) {
  return async function dispatch(action, { source = 'pose', gesture = '' } = {}) {
    const plan = osPlan(action, platform, await getSettings());
    const label = actionLabel(action);
    const said = gesture ? `${gestureName(source, gesture)} → ${label}` : label;
    if (plan.kind === 'none') return plan;
    if (plan.kind === 'unsupported') {
      toast(said, { tone: 'warn', detail: plan.why });
      return plan;
    }
    if (plan.kind === 'jester') {
      onJester(plan.op);
      return plan;
    }
    if (!driver) {
      toast(said, { tone: 'warn', detail: 'Jester’s input helper isn’t built (npm run driver)' });
      return plan;
    }
    if (!canPost()) {
      toast(said, { tone: 'warn', detail: 'Allow Accessibility in Jester’s Settings first' });
      return plan;
    }
    try {
      if (plan.kind === 'key') await driver.call('key', { key: plan.key, modifiers: plan.modifiers });
      else if (plan.kind === 'media') await driver.call('media', { key: plan.key });
      else if (plan.kind === 'scroll') await driver.call('scroll', { dy: plan.dy, unit: 'pixel' });
      else if (plan.kind === 'system' && plan.op === 'lock' && platform === 'win32') execFile('rundll32.exe', ['user32.dll,LockWorkStation']);
      toast(said, { detail: describePlan(plan, platform) });
    } catch (err) {
      log('action failed:', action, err.message);
      toast(said, { tone: 'warn', detail: `Didn’t go through: ${err.message}` });
    }
    return plan;
  };
}
