/**
 * The assistant, plan first: one model call says what to do before anything
 * is done (plan.js), and this does it, step by step, stopping on what the
 * screen proves. The model is asked again only for a step that needs eyes,
 * or one that failed.
 *
 * Every action, planned or not, goes through the same perform() as the
 * model's (loop.js): prepared, judged on the user's words and the screen as it
 * is then, asked about if it must be. A plan can't approve anything.
 *
 * A step that fails goes to the model, told what failed; one that stays stuck
 * is planned around, at most twice; then the run stops and says how far it got.
 */

import { taskCaption } from './actions.js';
import { aborted, createRun, lookStep, modelTrouble, perform, tidy, UNREADABLE } from './loop.js';
import { pickPlan, PLAN_SCHEMA, plannerInput, plannerPrompt, PLANNER_TOKENS, reactivePlan, shouldPlan, STUCK_WHYS, untilMet, validatePlan, writeTarget } from './plan.js';
import { plain, screenChanges } from './screen.js';

/** What the snapshot shows of a field's value, less a margin: the text is compared this far. */
const COMPARED_CHARS = 180;
/** Steps sent to the app in front, which must be the one the plan opened. */
const NEEDS_FRONT = new Set(['press', 'menu', 'write', 'place']);
/** Steps whose effect should show on screen: a slow app gets a second look. */
const VISIBLE_STEPS = new Set(['press', 'menu']);
const ENDS_IN_BREAK = /[\r\n\u2028\u2029]$/;
/** Text fields, whose values can show a write landed. */
const FIELD_ROLES = new Set(['textfield', 'searchfield', 'textarea', 'combobox']);
/** A failed step's wording, for the model that takes it over. */
const NOT_EMPTY = 'The field already holds other text, so nothing was written: it isn’t the new, blank field the plan expected. Don’t add to it: get to a blank one, or finish with success:false and say why.';

const failed = (why, detail) => ({ failed: { why, detail } });
const stepKey = ({ label, ...step }) => JSON.stringify(step);
const screenNow = async (run) => (run.next ? { ok: true, snapshot: run.next } : run.host.observe());

/** The app in front is the one meant, by either name holding the other ("Code", "Visual Studio Code"). */
function isFront(run, snapshot) {
  const front = plain(snapshot.app?.name);
  const wanted = plain(run.expectApp);
  return !!front && (front.includes(wanted) || wanted.includes(front));
}

/** Whether `text` is in a field, by what the screen shows or, past that, by reading the field. */
async function holds(run, snapshot, text) {
  const wanted = plain(text).slice(0, COMPARED_CHARS);
  const shown = (snapshot?.elements || []).some((element) => FIELD_ROLES.has(element.role) && typeof element.value === 'string' && plain(element.value).includes(wanted));
  if (shown) return true;
  const target = writeTarget(snapshot);
  return !!target && !!(await run.host.peek?.(snapshot, target.id, text))?.contains;
}

/** A write step as the action that does it, or why it can't be done here. */
async function compileWrite(run, step, snapshot) {
  const target = writeTarget(snapshot);
  if (!target) return failed('no_field', 'There’s no field to write in on screen, so nothing was written.');
  const held = await run.host.peek?.(snapshot, target.id);
  // A field that can't be read isn't known to be empty.
  const empty = !target.value && (!run.host.peek || held?.length === 0);
  const end = step.into === 'end';
  if (!end && !empty) return failed('field_not_empty', NOT_EMPTY);
  const area = target.role === 'textarea';
  const onNewLine = end && area && !empty && !ENDS_IN_BREAK.test(held?.tail || held?.value || '');
  return { action: 'type', id: target.id, text: `${onNewLine ? '\n' : ''}${step.text}`, ...(area || end ? { mode: 'append' } : {}), ...(step.enter ? { enter: true } : {}) };
}

/**
 * A concrete step, done and checked with no model. Passed unconfirmed: it was
 * done, and nothing on screen says either way.
 * @returns {Promise<{passed:true, unconfirmed?:boolean}|{failed:{why:string, detail:string}}|{stop:object}|{stuck:{why:string, say:string}}>}
 */
async function directStep(run, step) {
  const { host, onStep, signal } = run;
  const seen = await screenNow(run);
  run.next = null;
  if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
  if (!seen.ok) {
    onStep({ phase: 'unseen', detail: tidy(seen.detail, 400) });
    return { stuck: { why: 'unseen', say: 'I couldn’t read what’s on screen, so I stopped.' } };
  }
  const { snapshot } = seen;
  // Keys never go to an app that took the focus. A window placed by name needs no app in front.
  if (run.expectApp && NEEDS_FRONT.has(step.action) && !step.app && !isFront(run, snapshot)) {
    run.next = snapshot;
    return failed('step_failed', `${run.expectApp} isn’t in front, so nothing was done.`);
  }
  const { label, ...concrete } = step;
  const action = step.action === 'write' ? await compileWrite(run, step, snapshot) : concrete;
  if (action.failed) {
    run.next = snapshot;
    return action;
  }
  const outcome = await perform(run, action, seen, { verify: true, patient: VISIBLE_STEPS.has(step.action) });
  if (outcome.stop) return outcome;
  // Done once already, with the user's OK: that's this step, and it isn't done twice.
  if (outcome.repeated) return { passed: true };
  if (outcome.halted) return failed(step.action === 'open_app' ? 'app_missing' : 'step_failed', run.lastResult?.detail || 'It didn’t work.');
  const { result } = outcome;
  // Opened, or (a window placed by name) brought forward: it's the one the next keys are for.
  if (step.action === 'open_app' || step.app) run.expectApp = step.name || step.app;
  if (step.action === 'open_url') {
    run.expectApp = '';
    const after = await host.observe();
    if (!after.ok) return { passed: true, unconfirmed: true };
    run.next = after.snapshot;
    return screenChanges(snapshot, after.snapshot).changed ? { passed: true } : failed('no_effect', 'The page didn’t open: nothing on screen changed.');
  }
  if (VISIBLE_STEPS.has(step.action)) {
    if (result.changed === false) return failed('no_effect', 'Nothing on screen changed.');
    return result.changed ? { passed: true } : { passed: true, unconfirmed: true };
  }
  if (step.action === 'write' && !result.landed) {
    // Written, but unread: typing it again could put it in twice.
    if (!(await holds(run, run.next, step.text))) return { passed: true, unconfirmed: true };
  }
  return { passed: true };
}

/** A step for the model's eyes: over when it says so, or when the screen does. */
async function eyesOn(run, { what, until, text, told, info, maxCalls }) {
  const start = await screenNow(run);
  if (start.ok) run.next = start.snapshot;
  // The text may be in after all (a busy app's write can land late): it's never put in twice.
  if (text && start.ok && (await holds(run, start.snapshot, text))) return { passed: true };
  // What's already on screen proves nothing: it has to appear.
  const watching = until && start.ok && !untilMet(start.snapshot, until);
  const done = text ? (screen) => holds(run, screen, text) : watching ? (screen) => untilMet(screen, until) : null;
  const { done: shown, finished, stop, stuck } = await lookStep(run, { what, done, maxCalls, info: { ...info, ...(text ? { text } : {}), ...(told ? { told } : {}) } });
  if (stop) return { stop };
  if (stuck) return { stuck };
  if (shown) return { passed: true };
  return finished.ok ? { passed: true, say: finished.say } : { stop: run.end(false, finished.say) };
}

/** One call to the planner: a plan, or the run's end, or (unusable) nothing to go on. */
async function askPlanner(run, input) {
  const { model, onStep, signal, platform } = run;
  run.calls += 1;
  let reply;
  try {
    reply = await model({ system: plannerPrompt(platform), prompt: JSON.stringify(input), signal, schema: PLAN_SCHEMA, maxOutputTokens: PLANNER_TOKENS });
  } catch (err) {
    if (aborted(err) || signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (!UNREADABLE.has(err?.code) && err?.code !== 'model_timeout') return { stop: run.end(false, modelTrouble(err)) };
    onStep({ phase: 'invalid', detail: tidy(err.message, 200), code: err.code });
    return { unusable: true };
  }
  try {
    return { plan: validatePlan(reply?.json) };
  } catch (err) {
    onStep({ phase: 'invalid', detail: tidy(err.message, 200) });
    return { unusable: true };
  }
}

/**
 * @param {object} options  loop.js's createRun's, and:
 * @param {boolean} [options.pick]  a search is waiting for its result to be pressed
 * @param {(labels:string[]) => (Promise<void>|void)} [options.onPlan]  awaited when a plan is made, to let it be read
 * @returns {Promise<{ok:boolean, say:string, cancelled?:boolean, declined?:boolean, actions:number, calls:number, trace?:object[]}>}
 *   onStep's phases also include planning, plan (labels), step (index, total, label) and replanning (attempt, of, why)
 */
export async function runPlannedAgent({ pick = false, onPlan = () => undefined, ...options }) {
  const run = createRun(options);
  const { goal, note, previous, host, onStep, signal, platform, limits, now } = run;
  const close = (result) => ({ ...result, calls: run.calls });
  const cancelled = () => close(run.end(false, '', { cancelled: true }));
  // What the user said stands in for the caption until the plan gives a shorter one.
  onStep({ phase: 'task', caption: taskCaption(goal), by: 'goal' });
  if (signal?.aborted) return cancelled();
  // Only the app's name goes further than this: the planner never sees the screen.
  const first = await host.observe();
  if (signal?.aborted) return cancelled();
  if (!first.ok) {
    onStep({ phase: 'unseen', detail: tidy(first.detail, 400) });
    return close(run.end(false, 'I couldn’t read what’s on screen, so I stopped.'));
  }
  run.next = first.snapshot;

  let plan = pick ? pickPlan() : reactivePlan();
  if (shouldPlan(goal, { note, pick })) {
    onStep({ phase: 'planning' });
    const asked = await askPlanner(run, plannerInput({ goal, platform, front: first.snapshot.app?.name, previous }));
    if (asked.stop) return close(asked.stop);
    plan = asked.plan || plan;
  }
  if (signal?.aborted) return cancelled();

  /** The labels of the steps done, and those steps, which a replan may not do again. */
  const done = [];
  const doneSteps = new Set();
  let queue = plan.steps;
  let replans = 0;
  /** The last step that passed with nothing on screen to show for it. */
  let unconfirmed = '';
  /** What the model said of the last step, which it saw through. */
  let closing = '';

  /** The run's honest end: how far it got, and why it stopped. */
  const stopped = (reason) => {
    if (!done.length) return close(run.end(false, reason));
    const why = tidy(reason, 200).replace(/,? so I stopped\.?$/, '').replace(/[.!?…]+$/, '');
    return close(run.end(false, `I did ${done.length} of ${done.length + queue.length} steps (${done.join(', ')}), then stopped: ${why}.`));
  };
  const announce = async () => {
    if (plan.task && !run.captioned) {
      run.captioned = true;
      onStep({ phase: 'task', caption: taskCaption(plan.task), by: 'plan' });
    }
    if (plan.reactive) return;
    const labels = queue.map((step) => step.label);
    onStep({ phase: 'plan', labels });
    await onPlan(labels);
  };
  await announce();

  while (queue.length) {
    if (signal?.aborted) return cancelled();
    if (run.actions >= limits.maxActions || now() - run.startedAt > limits.runBudgetMs) return stopped('That was taking too many steps, so I stopped.');
    const [step] = queue;
    const index = done.length + 1;
    const total = done.length + queue.length;
    if (step.label) onStep({ phase: 'step', index, total, label: step.label });
    const info = { step: `${index} of ${total}`, ...(total > 1 ? { planned: [...done, ...queue.map(({ label }) => label)] } : {}) };
    const stepCalls = plan.reactive ? Infinity : limits.stepCalls;

    let outcome = step.action === 'look' ? await eyesOn(run, { what: step.what, until: step.until, info, maxCalls: stepCalls }) : await directStep(run, step);
    // A step that failed is the model's, told why, unless it's an app that isn't there.
    if (outcome.failed && outcome.failed.why !== 'app_missing') {
      const { why, detail } = outcome.failed;
      const told = { action: step.label, ok: false, detail: tidy(detail, 240) };
      const taken = await eyesOn(run, { what: step.label, text: step.action === 'write' ? step.text : '', told, info, maxCalls: stepCalls });
      outcome = taken.stuck ? { stuck: { ...taken.stuck, why: STUCK_WHYS.includes(taken.stuck.why) ? why : taken.stuck.why, hint: detail } } : taken;
    } else if (outcome.failed) {
      outcome = { stuck: { why: outcome.failed.why, say: outcome.failed.detail, hint: outcome.failed.detail } };
    }
    if (outcome.stop) return close(outcome.stop);

    if (outcome.passed) {
      done.push(step.label);
      doneSteps.add(stepKey(step));
      queue = queue.slice(1);
      closing = outcome.say || '';
      if (outcome.unconfirmed) unconfirmed = step.label;
      continue;
    }

    const { why, say, hint } = outcome.stuck;
    if (plan.reactive || !STUCK_WHYS.includes(why) || replans >= limits.replans || run.calls >= limits.maxModelCalls) return stopped(say);
    if (signal?.aborted) return cancelled();
    replans += 1;
    onStep({ phase: 'replanning', attempt: replans, of: limits.replans, why });
    const front = await screenNow(run);
    if (front.ok) run.next = front.snapshot;
    const asked = await askPlanner(run, plannerInput({ goal, platform, front: front.snapshot?.app?.name ?? first.snapshot.app?.name, previous, replan: { done, stuckOn: step.label, why, hint: hint || say } }));
    if (asked.stop) return close(asked.stop);
    const fresh = asked.plan ? asked.plan.steps.filter((next) => !doneSteps.has(stepKey(next))) : [];
    // The same way again would get stuck the same way.
    if (!fresh.length || JSON.stringify(fresh.map(stepKey)) === JSON.stringify(queue.map(stepKey))) return stopped(say);
    plan = { ...asked.plan, steps: fresh };
    queue = fresh;
    await announce();
  }

  if (signal?.aborted) return cancelled();
  const say = closing || (unconfirmed ? `I did “${unconfirmed}”, but it doesn’t show on screen, so I can’t be sure it took.` : plan.say);
  return close(run.end(true, say, { trace: run.trace }));
}
