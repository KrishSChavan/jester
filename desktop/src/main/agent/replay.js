/**
 * A learned task (learned.js) done again without the model: each control
 * found afresh by its kind and name, each step judged as the assistant's are
 * and checked as it's done. Anything not as it was — a control missing, the
 * wrong app in front, a step that would now need the user's OK, one that
 * fails or changes nothing — stops it there, for the assistant to take over
 * with a note of where.
 */

import { classify, describeAction } from './actions.js';
import { findTarget } from './screen.js';

/** Steps done to what's on screen, which a fresh read must find. */
const ON_SCREEN = new Set(['click', 'type', 'press', 'scroll', 'scroll_to', 'menu', 'drag']);

/**
 * @param {object} options
 * @param {object[]} options.steps  learned.js's
 * @param {string} options.goal
 * @param {{observe: Function, execute: Function, prepare?: Function}} options.host
 * @param {(step:{phase:string, label?:string}) => void} [options.onStep]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.platform]
 * @returns {Promise<{ok:true}|{ok:false, cancelled?:boolean, step:number, detail:string}>}
 */
export async function replaySteps({ steps, goal, host, onStep = () => undefined, signal, platform = process.platform }) {
  let screen = null;
  for (const [index, step] of steps.entries()) {
    const fail = (detail) => ({ ok: false, step: index, detail });
    if (signal?.aborted) return { ...fail('cancelled'), cancelled: true };
    const action = { ...step.action };
    if (ON_SCREEN.has(action.action)) {
      const seen = screen ? { ok: true, snapshot: screen } : await host.observe();
      if (signal?.aborted) return { ...fail('cancelled'), cancelled: true };
      if (!seen.ok) return fail('the screen couldn’t be read');
      screen = seen.snapshot;
      if (step.app && screen.app?.name !== step.app) return fail(`${step.app} wasn’t in front`);
      if (step.target) {
        const element = findTarget(screen, step.target);
        if (!element) return fail(`there was no “${step.target.label}” on screen`);
        action.id = element.id;
      }
      if (step.targets) {
        const from = findTarget(screen, step.targets.from);
        const to = findTarget(screen, step.targets.to);
        if (!from || !to) return fail(`there was no “${(from ? step.targets.to : step.targets.from).label}” on screen`);
        Object.assign(action, { from: from.id, to: to.id });
      }
    }
    const ready = host.prepare ? await host.prepare(action, screen) : { ok: true };
    if (signal?.aborted) return { ...fail('cancelled'), cancelled: true };
    if (!ready.ok) return fail(ready.detail);
    const { category } = classify(action, { screen, goal });
    if (category !== 'browse' && category !== 'read') return fail('it would need your OK now');
    const label = describeAction(action, screen, platform);
    onStep({ phase: 'acting', label });
    let result;
    try {
      result = await host.execute(action, screen || {}, { verify: true, signal });
    } catch (err) {
      return fail(String(err?.message || err));
    }
    if (signal?.aborted) return { ...fail('cancelled'), cancelled: true };
    if (!result.ok) return fail(result.detail || `“${label}” didn’t work`);
    // A step that changed the screen the first time and doesn't now went wrong;
    // one that didn't then (an unseen effect) isn't expected to.
    if (result.changed === false && step.changed === true) return fail(`nothing changed after “${label}”`);
    screen = result.snapshot || null;
  }
  return { ok: true };
}
