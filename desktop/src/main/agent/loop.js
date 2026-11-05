/**
 * The desktop assistant: a spoken goal, worked through the front app's
 * controls one model step at a time — read the screen, ask the model, check
 * its reply, ask the user first if the step is sensitive, act, remember.
 *
 * Each step is rebuilt from the goal, a bounded memory and a fresh screen
 * (as the extension's assistant does), so nothing grows from step to step.
 * The host reads and acts on the screen; the caller supplies the model, the
 * user's approval and progress reporting.
 */

import { requiresConfirmation } from '../../../../jester-extension/src/common/agent-permissions.js';
import { createMemory, MEMORY_LIMITS, updateMemory } from '../../../../jester-extension/src/common/task-memory.js';
import { classify, describeAction, menuPath, READ_ACTIONS, taskCaption, validateTurn } from './actions.js';
import { DESKTOP_SCHEMA, systemPrompt } from './prompt.js';
import { elementById, screenText } from './screen.js';

export const DESKTOP_LIMITS = Object.freeze({ maxActions: 40, runBudgetMs: 5 * 60 * 1000, failures: 3, invalidReplies: 2, idleSteps: 6 });
/** The user's choice: ask before sensitive steps only (agent-permissions.js's "entertainment"). */
const BOUNDARY = 'entertainment';

const tidy = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What happened, kept in the memory the model sees (task-memory.js's shape). */
function remember(memory, label, result, read) {
  const entry = { action: tidy(label, 120), ok: result?.ok === true, detail: tidy(result?.detail, 240) };
  memory.recent = [...memory.recent, entry].slice(-MEMORY_LIMITS.recent);
  if (entry.ok && !read) memory.completed = [...memory.completed, `${entry.action}${entry.detail ? `: ${entry.detail}` : ''}`].slice(-MEMORY_LIMITS.completed);
}

const aborted = (err) => err?.name === 'AbortError';

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
const UNREADABLE = new Set(['invalid_json', 'model_output_truncated']);

/** A model failure in words for the user. */
function modelTrouble(err) {
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

/**
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
 * @returns {Promise<{ok:boolean, say:string, cancelled?:boolean, declined?:boolean, actions:number, trace?:object[]}>}
 *   trace (on success): the steps done, as learned.js can do them again
 */
export async function runDesktopAgent({ goal, previous = [], host, model, confirm, onStep = () => undefined, signal, platform = process.platform, limits = DESKTOP_LIMITS, now = Date.now, note = '' }) {
  const memory = createMemory(goal);
  const startedAt = now();
  const system = systemPrompt(platform);
  let lastResult = null;
  /** The last step that changed something, for when the screen can't be read to check it. */
  let lastDone = '';
  let actions = 0;
  let failures = 0;
  let invalid = 0;
  let idle = 0;
  /** Sensitive steps done in this task (sensitiveKey), and how often the model has asked for one again. */
  const doneSensitive = new Set();
  let repeats = 0;
  /** The screen as read just after the last step, which is the next step's. */
  let next = null;
  const trace = [];
  const end = (ok, say, extra = {}) => ({ ok, say, actions, ...extra });
  // What the user said stands in for the caption until the model gives a shorter one.
  onStep({ phase: 'task', caption: taskCaption(goal), by: 'goal' });
  let captioned = false;

  for (;;) {
    if (signal?.aborted) return end(false, '', { cancelled: true });
    if (actions >= limits.maxActions || now() - startedAt > limits.runBudgetMs) return end(false, 'That was taking too many steps, so I stopped.');
    onStep({ phase: 'thinking' });
    const seen = next ? { ok: true, snapshot: next } : await host.observe();
    next = null;
    if (!seen.ok) {
      onStep({ phase: 'unseen', detail: tidy(seen.detail, 400) });
      return end(false, lastDone ? `I did “${lastDone}”, but then couldn’t read the screen to check it, so I stopped.` : 'I couldn’t read what’s on screen, so I stopped.');
    }
    const screen = screenText(seen.snapshot, { goal });
    onStep({ phase: 'seen', app: seen.snapshot.app?.name, window: seen.snapshot.window?.title, elements: seen.snapshot.elements?.length ?? 0, screen });
    const prompt = JSON.stringify({
      originalGoal: goal,
      ...(note ? { note: tidy(note, 300) } : {}),
      ...(previous.length ? { previousCommands: previous.slice(-3) } : {}),
      memory: { subgoal: memory.subgoal, constraints: memory.constraints, facts: memory.facts, completed: memory.completed.slice(-4), recent: memory.recent },
      screen,
      ...(lastResult ? { lastResult } : {})
    });

    let reply = null;
    try {
      reply = await model({ system, prompt, signal, schema: DESKTOP_SCHEMA });
    } catch (err) {
      if (aborted(err) || signal?.aborted) return end(false, '', { cancelled: true });
      // A reply that wasn't JSON (or was cut off) is the model's to fix; anything else ends the task.
      if (!UNREADABLE.has(err?.code)) return end(false, modelTrouble(err));
    }
    let turn;
    try {
      if (!reply) throw new Error('Reply with one short JSON object and nothing else.');
      turn = validateTurn(reply.json);
      updateMemory(memory, turn.memory ?? {});
      invalid = 0;
      if (turn.task && !captioned) {
        captioned = true;
        onStep({ phase: 'task', caption: taskCaption(turn.task), by: 'model' });
      }
    } catch (err) {
      invalid += 1;
      onStep({ phase: 'invalid', detail: tidy(err.message, 200) });
      if (invalid >= limits.invalidReplies) return end(false, 'The AI model’s replies didn’t make sense, so I stopped.');
      lastResult = { ok: false, detail: `Your reply was not usable: ${tidy(err.message, 200)}` };
      continue;
    }

    let progressed = false;
    // Each action of a group is judged on the focus the ones before it left:
    // a typed or clicked control has it; after a key, where it went is unknown.
    let judged = seen.snapshot;
    let focusKnown = true;
    for (const [index, action] of turn.actions.entries()) {
      if (action.action === 'finish') return end(action.success, action.say, action.success ? { trace } : {});
      if (signal?.aborted) return end(false, '', { cancelled: true });
      if (!focusKnown && (action.action === 'press' || (action.action === 'type' && action.id === undefined))) {
        const label = describeAction(action, seen.snapshot, platform);
        onStep({ phase: 'acted', label, ok: false, detail: 'left for a fresh look' });
        lastResult = { action: label, ok: false, detail: 'Not done: a key before it in the group may have moved the focus. Look at the screen and choose it again.' };
        remember(memory, label, lastResult, false);
        break;
      }
      // What it is exactly (a menu command's real titles) before it's judged.
      const ready = host.prepare ? await host.prepare(action, seen.snapshot) : { ok: true };
      if (signal?.aborted) return end(false, '', { cancelled: true });
      if (!ready.ok) {
        const label = describeAction(action, seen.snapshot, platform);
        onStep({ phase: 'acted', label, ok: false, detail: tidy(ready.detail, 160) });
        lastResult = { action: label, ok: false, detail: tidy(ready.detail, 240) };
        remember(memory, label, lastResult, false);
        failures += 1;
        break;
      }
      const label = describeAction(action, seen.snapshot, platform);
      const { category, reason } = judge(action, judged === seen.snapshot ? [seen.snapshot] : [seen.snapshot, judged], goal);
      if (category === 'blocked') {
        onStep({ phase: 'acted', label, ok: false, detail: reason });
        lastResult = { action: label, ok: false, detail: reason };
        remember(memory, label, lastResult, false);
        failures += 1;
        break;
      }
      const key = category === 'sensitive' ? sensitiveKey(action, seen.snapshot) : null;
      if (key && doneSensitive.has(key)) {
        repeats += 1;
        onStep({ phase: 'acted', label, ok: false, detail: 'not repeated' });
        if (repeats >= 2) return end(false, `I’d already done “${label}” once, so I stopped rather than do it again.`);
        lastResult = { action: label, ok: false, detail: 'Already done once in this task, with the user’s OK. It is never repeated: if the goal is done, finish.' };
        break;
      }
      if (requiresConfirmation(BOUNDARY, category)) {
        onStep({ phase: 'asking', label });
        const approved = await confirm({ label, reason });
        if (signal?.aborted) return end(false, '', { cancelled: true });
        if (!approved) return end(false, 'Okay, I didn’t do that.', { declined: true });
      }
      onStep({ phase: 'acting', label });
      let result;
      try {
        // The last of a group is checked: what it changed, read once, is the next step's screen.
        result = await host.execute(action, seen.snapshot, { verify: index === turn.actions.length - 1, signal });
      } catch (err) {
        result = { ok: false, detail: tidy(err?.message || err, 200) };
      }
      actions += 1;
      if (result.snapshot) next = result.snapshot;
      if (action.id !== undefined && (action.action === 'click' || action.action === 'type')) judged = focusOn(judged, action.id);
      else if (action.action === 'press' || action.action === 'type') focusKnown = false;
      onStep({ phase: 'acted', label, ok: result.ok === true, detail: tidy(result.detail, 160), ...(result.changes ? { changes: tidy(result.changes, 600) } : {}) });
      remember(memory, label, result, READ_ACTIONS.has(action.action));
      lastResult = {
        action: label,
        ok: result.ok === true,
        detail: tidy(result.detail, 240),
        ...(result.changes ? { changes: tidy(result.changes, 600) } : {}),
        ...(result.found ? { found: result.found } : {})
      };
      if (!result.ok) {
        failures += 1;
        // The rest of a group was chosen for a screen that didn't happen.
        break;
      }
      failures = 0;
      if (key) doneSensitive.add(key);
      if (!READ_ACTIONS.has(action.action)) trace.push(traced(action, seen.snapshot, category, result));
      // A step that changed nothing on screen is no progress, nor is one whose effect can't be seen.
      if (!READ_ACTIONS.has(action.action) && result.changed !== false && !result.unseen) {
        progressed = true;
        lastDone = label;
      }
    }
    if (failures >= limits.failures) return end(false, `I got stuck: ${tidy(lastResult?.detail || 'it kept failing', 160)}`);
    idle = progressed ? 0 : idle + 1;
    if (idle >= limits.idleSteps) return end(false, 'I wasn’t getting anywhere, so I stopped.');
  }
}
