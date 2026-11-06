/**
 * The desktop assistant: a spoken goal, worked through the front app's
 * controls one model step at a time — read the screen, ask the model, check
 * its reply, ask the user first if the step is sensitive, act, remember.
 * executor.js uses the same parts for the steps of a plan that need eyes.
 *
 * Each step is rebuilt from the goal, a bounded memory and a fresh screen
 * (as the extension's assistant does), so nothing grows from step to step.
 * The host reads and acts on the screen; the caller supplies the model, the
 * user's approval and progress reporting.
 */

import { requiresConfirmation } from '../../../../jester-extension/src/common/agent-permissions.js';
import { createMemory, MEMORY_LIMITS, updateMemory } from '../../../../jester-extension/src/common/task-memory.js';
import { parseShortcut } from '../os-actions.js';
import { classify, describeAction, menuPath, quoted, READ_ACTIONS, taskCaption, validateTurn } from './actions.js';
import { DESKTOP_SCHEMA, systemPrompt } from './prompt.js';
import { elementById, plain, SCREEN_LIMITS, screenText } from './screen.js';

export const DESKTOP_LIMITS = Object.freeze({ maxActions: 30, maxModelCalls: 16, runBudgetMs: 5 * 60 * 1000, failures: 3, invalidReplies: 2, invalidTotal: 3, idleSteps: 3, stepCalls: 6, replans: 2 });
/** The user's choice: ask before sensitive steps only (agent-permissions.js's "entertainment"). */
const BOUNDARY = 'entertainment';
/** The least of the screen a model gets, however tight its tokens-per-minute ceiling. */
const MIN_SCREEN_CHARS = 1500;

export const tidy = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What happened, kept in the memory the model sees (task-memory.js's shape). */
function remember(memory, label, result, read) {
  const entry = { action: tidy(label, 120), ok: result?.ok === true, detail: tidy(result?.detail, 240) };
  memory.recent = [...memory.recent, entry].slice(-MEMORY_LIMITS.recent);
  if (entry.ok && !read) memory.completed = [...memory.completed, `${entry.action}${entry.detail ? `: ${entry.detail}` : ''}`].slice(-MEMORY_LIMITS.completed);
}

export const aborted = (err) => err?.name === 'AbortError';

/**
 * A sensitive step as what it does and where, whatever the model calls its
 * field: "type hello, Enter, in Messages / Trisha Seth". One that was approved
 * and done isn't done again in the same task — a sent message may not show on
 * screen, and a model that can't see it asks to send it again.
 */
function sensitiveKey(action, screen) {
  const where = `${screen?.app?.name || ''} / ${screen?.window?.title || ''}`;
  const element = action.id === undefined ? null : elementById(screen, action.id);
  if (action.action === 'type') return `type ${action.text}${action.enter ? ', Enter' : ''} in ${where}`;
  if (action.action === 'click') return `click ${element?.label || action.id} in ${where}`;
  if (action.action === 'press') return `press ${action.keys} in ${where}`;
  if (action.action === 'menu') return `menu ${(action.resolved || menuPath(action.path)).join(' > ')} in ${where}`;
  if (action.action === 'drag') return `drag ${elementById(screen, action.from)?.label || action.from} onto ${elementById(screen, action.to)?.label || action.to} in ${where}`;
  return `${action.action} ${action.url || ''} in ${where}`;
}
/** model-client.js's codes for a reply the model can be asked to redo. */
export const UNREADABLE = new Set(['invalid_json', 'model_output_truncated']);

/** A model failure in words for the user. */
export function modelTrouble(err) {
  if (/rate|429|limit/i.test(`${err?.name} ${err?.message}`)) return 'The AI models are at their limits for now. Try again in a minute.';
  if (/timeout/i.test(err?.name || '')) return 'The AI model took too long to answer.';
  return `The AI model didn’t answer: ${tidy(err?.message || err, 160)}`;
}

/**
 * A step that worked, as it can be done again without the model (learned.js):
 * the action without its screen numbers, and the controls it was done to by
 * kind, name and section, which a fresh read can find again.
 */
function traced(action, screen, category, result) {
  const target = (id) => {
    const element = elementById(screen, id);
    return element ? { role: element.role, label: element.label || '', ...(element.in ? { in: element.in } : {}) } : null;
  };
  const { id, resolved, ...rest } = action;
  // A drag's ends are controls; a scroll's `to` is "end".
  if (action.action === 'drag') {
    delete rest.from;
    delete rest.to;
  }
  const step = { action: rest, app: screen?.app?.name || '' };
  if (resolved) step.action.path = resolved.join(' > ');
  if (id !== undefined) step.target = target(id);
  if (action.action === 'drag') step.targets = { from: target(action.from), to: target(action.to) };
  if (category === 'sensitive') step.sensitive = true;
  // Whether it visibly changed the screen then: a replay expects the same.
  if (typeof result?.changed === 'boolean') step.changed = result.changed;
  return step;
}

/** The screen with the keyboard focus on one element: what a typed or clicked control may leave for the next action of a group. */
function focusOn(screen, id) {
  return { ...screen, elements: (screen?.elements || []).map((element) => ({ ...element, focused: element.id === id })) };
}

const CAUTION = { read: 0, browse: 1, sensitive: 2, blocked: 3 };

/**
 * How careful to be with an action of a group, judged both on the screen
 * from before the group and on the focus the actions before it may have left
 * (a press or a value set through accessibility doesn't always move it), the
 * more careful of the two.
 */
function judge(action, screens, goal) {
  return screens.map((screen) => classify(action, { screen, goal })).reduce((most, next) => (CAUTION[next.category] > CAUTION[most.category] ? next : most));
}

/** A new group of actions, on the screen it was chosen from: `judged`, as perform() leaves it for the next. */
const newGroup = (seen) => ({ screen: seen.snapshot, focusKnown: true, selectedAll: false });

/** ⌘A (Ctrl+A on Windows), which leaves all of a field selected. */
function selectsAll(action, platform) {
  const plan = action.action === 'press' ? parseShortcut(action.keys) : null;
  return plan?.key === 'a' && plan.modifiers.length === 1 && plan.modifiers[0] === (platform === 'darwin' ? 'cmd' : 'ctrl');
}

/** Text in a field, as it's known across reads: the field's kind and name, and the words. */
function landedKey(action, screen) {
  const field = elementById(screen, action.id);
  return [field?.role, plain(field?.label), plain(action.text)].join('|');
}

/**
 * How much of the screen a step shows: a model with a small tokens-per-minute
 * ceiling gets less, so a task fits more steps in each minute (as the
 * extension's assistant does).
 */
async function screenChars(run, rest) {
  const tokens = await Promise.resolve(run.model.promptBudget?.()).catch(() => null);
  if (!Number.isFinite(tokens) || tokens <= 0) return SCREEN_LIMITS.chars;
  return Math.max(MIN_SCREEN_CHARS, Math.min(SCREEN_LIMITS.chars, tokens * 4 - run.system.length - JSON.stringify(rest).length));
}

/**
 * One task's state, for the steps of a run to share.
 * @param {object} options
 * @param {string} options.goal  what the user said
 * @param {{said:string, result:string}[]} [options.previous]  the last few commands
 * @param {{observe: Function, execute: Function}} options.host
 * @param {(request:object) => Promise<{json:object}>} options.model  model-pool's client, or requestModel
 * @param {(ask:{label:string, reason:string}) => Promise<boolean>} options.confirm  the user's yes
 * @param {(step:{phase:string, label?:string}) => void} [options.onStep]  task (the caption: from the goal,
 *   then the model's), thinking, asking, acting; and for the log: seen (what was read), acted (how a
 *   step went), invalid (an unusable reply), unseen (why the screen couldn't be read)
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.platform]
 * @param {string} [options.note]  what the model should know first: a saved way of doing it that failed
 */
export function createRun({ goal, previous = [], host, model, confirm, onStep = () => undefined, signal, platform = process.platform, limits = DESKTOP_LIMITS, now = Date.now, note = '' }) {
  const run = {
    goal,
    previous,
    host,
    model,
    confirm,
    onStep,
    signal,
    platform,
    limits,
    now,
    note,
    memory: createMemory(goal),
    startedAt: now(),
    system: systemPrompt(platform),
    lastResult: null,
    /** The last step that changed something, for when the screen can't be read to check it. */
    lastDone: '',
    actions: 0,
    /** Every call to the model, however it's answered. */
    calls: 0,
    failures: 0,
    invalid: 0,
    invalidTotal: 0,
    idle: 0,
    /** Sensitive steps done in this task (sensitiveKey), and how often the model has asked for one again. */
    doneSensitive: new Set(),
    repeats: 0,
    /** The screen as read just after the last step, which is the next step's. */
    next: null,
    trace: [],
    captioned: false,
    /** How often a screen and the actions chosen for it have been done. */
    signatures: new Map(),
    /** Text read back in its field (landedKey), and how often the model has tried to type it again. */
    landed: new Map(),
    /** The app a plan opened, which later steps need in front. */
    expectApp: '',
    end: (ok, say, extra = {}) => ({ ok, say, actions: run.actions, ...extra })
  };
  return run;
}

/**
 * One action, whoever chose it: prepared, judged, asked about if it must be,
 * done and remembered. Nothing reaches the host another way.
 * @param {object} run  createRun's
 * @param {object} chosen  the action, validated
 * @param {{ok:true, snapshot:object}} seen  the screen it was chosen from
 * @param {object} [options]
 * @param {boolean} [options.verify]  check it on screen: the last action of a group
 * @param {object} [options.judged]  what the group's actions before it left (newGroup)
 * @param {boolean} [options.patient]  a slow app gets a second look before "nothing changed"
 * @returns {Promise<{stop:object}|{halted:true, repeated?:boolean}|{result:object, moved:boolean}>}
 *   stop: the run is over; halted: not done, or failed, and the rest of its group goes with it
 *   (repeated: because it was done once already, with the user's OK); moved: this was a group's
 *   last action, and something came of it
 */
export async function perform(run, chosen, seen, { verify = false, judged = newGroup(seen), patient = false } = {}) {
  const { host, signal, onStep, memory, platform, goal, confirm, doneSensitive, landed } = run;
  // Over a selection a field's id would otherwise add to the end, past what's selected.
  const action = judged.selectedAll && chosen.action === 'type' && chosen.id !== undefined && !chosen.mode ? { ...chosen, mode: 'insert' } : chosen;
  if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
  if (!judged.focusKnown && (action.action === 'press' || (action.action === 'type' && action.id === undefined))) {
    const label = describeAction(action, seen.snapshot, platform);
    onStep({ phase: 'acted', label, ok: false, detail: 'left for a fresh look' });
    run.lastResult = { action: label, ok: false, detail: 'Not done: a key before it in the group may have moved the focus. Look at the screen and choose it again.' };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  // What it is exactly (a menu command's real titles) before it's judged.
  const ready = host.prepare ? await host.prepare(action, seen.snapshot) : { ok: true };
  if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
  if (!ready.ok) {
    const label = describeAction(action, seen.snapshot, platform);
    onStep({ phase: 'acted', label, ok: false, detail: tidy(ready.detail, 160) });
    run.lastResult = { action: label, ok: false, detail: tidy(ready.detail, 240) };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  const label = describeAction(action, seen.snapshot, platform);
  const { category, reason } = judge(action, judged.screen === seen.snapshot ? [seen.snapshot] : [seen.snapshot, judged.screen], goal);
  if (category === 'blocked') {
    onStep({ phase: 'acted', label, ok: false, detail: reason });
    run.lastResult = { action: label, ok: false, detail: reason };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  // Text read back is in: a model that can't tell may only double it.
  if (action.action === 'type' && action.id !== undefined && landed.has(landedKey(action, seen.snapshot))) {
    const written = landedKey(action, seen.snapshot);
    if ((await host.peek?.(seen.snapshot, action.id, action.text))?.contains) {
      landed.set(written, landed.get(written) + 1);
      onStep({ phase: 'acted', label, ok: false, detail: 'already in' });
      if (landed.get(written) >= 2) return { stop: run.end(false, `${quoted(action.text)} is in the field and reads back right, so I stopped there.`) };
      run.lastResult = { action: label, ok: false, landed: true, detail: 'Not done: it’s already in the field, word for word. Never type it again: if the goal is done, finish.' };
      return { halted: true };
    }
  }
  const key = category === 'sensitive' ? sensitiveKey(action, seen.snapshot) : null;
  if (key && doneSensitive.has(key)) {
    run.repeats += 1;
    onStep({ phase: 'acted', label, ok: false, detail: 'not repeated' });
    if (run.repeats >= 2) return { stop: run.end(false, `I’d already done “${label}” once, so I stopped rather than do it again.`) };
    run.lastResult = { action: label, ok: false, detail: 'Already done once in this task, with the user’s OK. It is never repeated: if the goal is done, finish.' };
    return { halted: true, repeated: true };
  }
  if (requiresConfirmation(BOUNDARY, category)) {
    onStep({ phase: 'asking', label });
    const approved = await confirm({ label, reason });
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (!approved) return { stop: run.end(false, 'Okay, I didn’t do that.', { declined: true }) };
  }
  onStep({ phase: 'acting', label });
  let result;
  try {
    // The last of a group is checked: what it changed, read once, is the next step's screen.
    result = await host.execute(action, seen.snapshot, { verify, signal, patient });
  } catch (err) {
    result = { ok: false, detail: tidy(err?.message || err, 200) };
  }
  run.actions += 1;
  if (result.snapshot) run.next = result.snapshot;
  if (action.id !== undefined && (action.action === 'click' || action.action === 'type')) judged.screen = focusOn(judged.screen, action.id);
  else if (action.action === 'press' || action.action === 'type') judged.focusKnown = false;
  judged.selectedAll = result.ok === true && selectsAll(action, platform);
  onStep({ phase: 'acted', label, ok: result.ok === true, detail: tidy(result.detail, 160), ...(result.changes ? { changes: tidy(result.changes, 600) } : {}) });
  remember(memory, label, result, READ_ACTIONS.has(action.action));
  run.lastResult = {
    action: label,
    ok: result.ok === true,
    detail: tidy(result.detail, 240),
    ...(result.changes ? { changes: tidy(result.changes, 600) } : {}),
    ...(result.found ? { found: result.found } : {}),
    ...(result.landed ? { landed: true } : {})
  };
  if (!result.ok) {
    run.failures += 1;
    // The rest of a group was chosen for a screen that didn't happen.
    return { halted: true };
  }
  if (key) doneSensitive.add(key);
  if (result.landed) landed.set(landedKey(action, seen.snapshot), 0);
  if (!READ_ACTIONS.has(action.action)) run.trace.push(traced(action, seen.snapshot, category, result));
  // A step that changed nothing on screen is no progress, nor is one whose effect can't be seen.
  const effect = !READ_ACTIONS.has(action.action) && result.changed !== false && !result.unseen;
  if (effect) run.lastDone = label;
  // Only a group's last action is checked: one before it may have done nothing at all.
  const moved = verify && effect;
  if (moved) run.failures = 0;
  return { result, moved };
}

/**
 * The model at the wheel, one step at a time, until it finishes or can't.
 * @param {object} run  createRun's
 * @param {object} [step]  with none, the whole goal is the model's
 * @param {string} [step.what]  the part of the goal it's doing: only that, and the screen is ranked by it too
 * @param {(screen:object) => boolean|Promise<boolean>} [step.done]  checked on the screen after every group:
 *   true ends the step at once, with no further model call
 * @param {number} [step.maxCalls]  model calls this step may use
 * @param {{step?:string, planned?:string[], text?:string, told?:object}} [step.info]  where it is in a plan
 *   (step: "2 of 3"), the text to write, and what it should hear first
 * @returns {Promise<{finished:{ok:boolean, say:string}}|{done:true}|{stop:object}|{stuck:{why:string, say:string}}>}
 *   finished: the model's own finish; done: `done` said so; stop: the run is over, this is how;
 *   stuck: it can't go on, and says why
 */
export async function lookStep(run, { what = '', done = null, maxCalls = Infinity, info = {} } = {}) {
  const { goal, note, previous, host, model, onStep, signal, platform, memory, limits, now, system } = run;
  const doing = what ? { step: info.step, what, ...(info.text ? { text: info.text } : {}) } : null;
  const started = run.calls;
  run.failures = 0;
  run.idle = 0;
  if (info.told) run.lastResult = info.told;
  for (;;) {
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (run.actions >= limits.maxActions || run.calls >= limits.maxModelCalls || now() - run.startedAt > limits.runBudgetMs) return { stuck: { why: 'limit', say: 'That was taking too many steps, so I stopped.' } };
    if (run.calls - started >= maxCalls) return { stuck: { why: 'step_too_long', say: 'That step was taking too many tries, so I stopped.' } };
    onStep({ phase: 'thinking' });
    const seen = run.next ? { ok: true, snapshot: run.next } : await host.observe();
    run.next = null;
    if (!seen.ok) {
      onStep({ phase: 'unseen', detail: tidy(seen.detail, 400) });
      return { stuck: { why: 'unseen', say: run.lastDone ? `I did “${run.lastDone}”, but then couldn’t read the screen to check it, so I stopped.` : 'I couldn’t read what’s on screen, so I stopped.' } };
    }
    const rest = {
      originalGoal: goal,
      ...(note ? { note: tidy(note, 300) } : {}),
      ...(previous.length ? { previousCommands: previous.slice(-3) } : {}),
      ...(doing ? { doing, ...(info.planned ? { planned: info.planned } : {}) } : {}),
      memory: { subgoal: memory.subgoal, constraints: memory.constraints, facts: memory.facts, ...(doing ? {} : { completed: memory.completed.slice(-4) }), recent: memory.recent },
      ...(run.lastResult ? { lastResult: run.lastResult } : {})
    };
    const screen = screenText(seen.snapshot, { goal: what ? `${goal} ${what}` : goal, chars: await screenChars(run, rest) });
    onStep({ phase: 'seen', app: seen.snapshot.app?.name, window: seen.snapshot.window?.title, elements: seen.snapshot.elements?.length ?? 0, screen });
    const prompt = JSON.stringify({ ...rest, screen });

    let reply = null;
    let unusable = '';
    run.calls += 1;
    try {
      reply = await model({ system, prompt, signal, schema: DESKTOP_SCHEMA });
    } catch (err) {
      if (aborted(err) || signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
      // A reply that wasn't JSON (or was cut off) is the model's to fix; anything else ends the task.
      if (!UNREADABLE.has(err?.code)) return { stuck: { why: 'model', say: modelTrouble(err) } };
      unusable = err.code;
    }
    let turn;
    try {
      if (!reply) throw new Error('Reply with one short JSON object and nothing else.');
      turn = validateTurn(reply.json);
      updateMemory(memory, turn.memory ?? {});
      run.invalid = 0;
      if (turn.task && !run.captioned) {
        run.captioned = true;
        onStep({ phase: 'task', caption: taskCaption(turn.task), by: 'model' });
      }
    } catch (err) {
      run.invalid += 1;
      run.invalidTotal += 1;
      onStep({ phase: 'invalid', detail: tidy(err.message, 200), ...(unusable ? { code: unusable } : {}) });
      if (run.invalid >= limits.invalidReplies || run.invalidTotal >= limits.invalidTotal) return { stuck: { why: 'invalid', say: 'The AI model’s replies didn’t make sense, so I stopped.' } };
      run.lastResult = { ok: false, detail: `Your reply was not usable: ${tidy(err.message, 200)}` };
      continue;
    }

    // The same actions on the same screen, done twice already, won't go differently a third time.
    const signature = JSON.stringify([screen, turn.actions]);
    if ((run.signatures.get(signature) || 0) >= 2) {
      run.idle += 1;
      return { stuck: { why: 'no_effect', say: 'I wasn’t getting anywhere, so I stopped.' } };
    }
    const actionsBefore = run.actions;

    let progressed = false;
    // Each action of a group is judged on the focus the ones before it left:
    // a typed or clicked control has it; after a key, where it went is unknown.
    const judged = newGroup(seen);
    for (const [index, action] of turn.actions.entries()) {
      if (action.action === 'finish') return { finished: { ok: action.success, say: action.say } };
      if (run.actions >= limits.maxActions) break;
      const outcome = await perform(run, action, seen, { verify: index === turn.actions.length - 1, judged });
      if (outcome.stop) return { stop: outcome.stop };
      if (outcome.halted) break;
      progressed ||= outcome.moved;
    }
    // Refused outright, it's the guards' to count: nothing was done again.
    if (run.actions > actionsBefore) run.signatures.set(signature, (run.signatures.get(signature) || 0) + 1);
    if (done) {
      const after = run.next ? { ok: true, snapshot: run.next } : await host.observe();
      if (after.ok) {
        run.next = after.snapshot;
        if (await done(after.snapshot)) return { done: true };
      }
    }
    if (run.failures >= limits.failures) return { stuck: { why: 'step_failed', say: `I got stuck: ${tidy(run.lastResult?.detail || 'it kept failing', 160)}` } };
    run.idle = progressed ? 0 : run.idle + 1;
    if (run.idle >= limits.idleSteps) return { stuck: { why: 'no_effect', say: 'I wasn’t getting anywhere, so I stopped.' } };
  }
}

/**
 * @param {object} options  createRun's
 * @returns {Promise<{ok:boolean, say:string, cancelled?:boolean, declined?:boolean, actions:number, trace?:object[]}>}
 *   trace (on success): the steps done, as learned.js can do them again
 */
export async function runDesktopAgent(options) {
  const run = createRun(options);
  // What the user said stands in for the caption until the model gives a shorter one.
  run.onStep({ phase: 'task', caption: taskCaption(run.goal), by: 'goal' });
  const { finished, stop, stuck } = await lookStep(run);
  if (stop) return stop;
  if (stuck) return run.end(false, stuck.say);
  return run.end(finished.ok, finished.say, finished.ok ? { trace: run.trace } : {});
}
