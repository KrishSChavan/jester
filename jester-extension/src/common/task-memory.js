/** Small, serializable task state. No page snapshots or conversation history. */
import { isRecord, describeAction, READ_ACTIONS } from './agent-actions.js';

export const MEMORY_LIMITS = Object.freeze({ goal: 3000, constraints: 8, facts: 10, completed: 10,
  recent: 5, entry: 180, subgoal: 240 });
const tidy = (value, max = MEMORY_LIMITS.entry) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const list = (value, max) => [...new Set((Array.isArray(value) ? value : [])
  .filter((item) => typeof item === 'string').map((item) => tidy(item)).filter(Boolean))].slice(-max);

export function createMemory(goal, stored = null) {
  const original = typeof goal === 'string' ? goal.trim() : '';
  if (!original || original.length > MEMORY_LIMITS.goal) throw new Error('Please give a command under 3,000 characters.');
  const source = isRecord(stored) ? stored : {};
  return {
    goal: original,
    constraints: list(source.constraints, MEMORY_LIMITS.constraints),
    facts: list(source.facts, MEMORY_LIMITS.facts),
    subgoal: tidy(source.subgoal, MEMORY_LIMITS.subgoal),
    completed: list(source.completed, MEMORY_LIMITS.completed),
    recent: (Array.isArray(source.recent) ? source.recent : []).slice(-MEMORY_LIMITS.recent)
      .filter(isRecord).map((item) => ({ action: tidy(item.action, 120), ok: item.ok === true,
        detail: tidy(item.detail, 240) }))
  };
}

/**
 * A model's notes for the task, as they'll be kept. Notes of the wrong kind are refused; too many, or too long, are
 * cut to what's kept (the newest, each to its length): refusing them threw away the step that came with them, and
 * a model listing forty tabs' worth of facts lost a step each time (2026-11-15).
 */
export function validateMemoryPatch(patch) {
  if (patch === undefined) return {};
  if (!isRecord(patch) || Object.keys(patch).some((key) => !['constraints', 'facts', 'subgoal'].includes(key))) {
    throw new Error('Memory may update only constraints, facts, and subgoal.');
  }
  const kept = { ...patch };
  for (const field of ['constraints', 'facts']) {
    if (patch[field] === undefined) continue;
    if (!Array.isArray(patch[field]) || patch[field].some((item) => typeof item !== 'string')) {
      throw new Error(`Memory ${field} must be a list of short sentences.`);
    }
    kept[field] = list(patch[field], MEMORY_LIMITS[field]);
  }
  if (patch.subgoal !== undefined) {
    if (typeof patch.subgoal !== 'string') throw new Error('Memory subgoal must be a sentence.');
    kept.subgoal = tidy(patch.subgoal, MEMORY_LIMITS.subgoal);
  }
  return kept;
}

export function updateMemory(memory, given) {
  const patch = validateMemoryPatch(given);
  for (const field of ['constraints', 'facts']) {
    if (patch[field]) memory[field] = list([...memory[field], ...patch[field]], MEMORY_LIMITS[field]);
  }
  if (patch.subgoal !== undefined) memory.subgoal = tidy(patch.subgoal, MEMORY_LIMITS.subgoal);
  return memory;
}

export function recordResult(memory, action, result) {
  const entry = { action: tidy(describeAction(action), 120), ok: result?.ok === true,
    detail: tidy(result?.detail || result?.text || '', 240) };
  memory.recent = [...memory.recent, entry].slice(-MEMORY_LIMITS.recent);
  if (entry.ok && !READ_ACTIONS.has(action.action)) {
    memory.completed = list([...memory.completed,
      `${entry.action}${entry.detail ? `: ${entry.detail}` : ''}`], MEMORY_LIMITS.completed);
  }
  return memory;
}
