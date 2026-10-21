/** Native Gemini's documented JSON Schema subset; host validation stays authoritative. */
import { COMMAND_IDS, BROWSER_OPS, GROUP_COLORS } from './agent-actions.js';
import { MEMORY_LIMITS } from './task-memory.js';

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const object = (properties, required = []) => ({ type: 'object', properties, required,
  additionalProperties: false });
const string = { type: 'string' };
const target = { elementId: string, pageId: string,
  revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };
const action = (names, properties = {}, required = []) => object({
  action: { type: 'string', enum: names }, ...properties
}, ['action', ...required]);
const controls = ['target', 'type', 'select', 'scroll', 'key'];
const single = [...controls, 'readTarget', 'find', 'form', 'section', 'observe', 'wait', 'look',
  'navigate', 'command', 'browser', 'finish'];
const tabId = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const variants = (names) => ({ anyOf: names.map(ref) });

// String-length, ID-pattern and URL restrictions are deliberately enforced by the
// existing host validators: Gemini's supported schema subset has no such keywords.
// https://ai.google.dev/api/generate-content#v1beta.GenerationConfig
export const AGENT_RESPONSE_SCHEMA = {
  anyOf: [
    object({ action: ref('action'), memory: ref('memory') }, ['action']),
    object({ actions: { type: 'array', items: ref('control'), minItems: 1, maxItems: 3 },
      memory: ref('memory') }, ['actions'])
  ],
  $defs: {
    action: variants(single),
    control: variants(controls),
    target: action(['click', 'focus', 'clear', 'hover'], target, ['elementId']),
    type: action(['type'], { ...target, text: string }, ['elementId', 'text']),
    select: action(['select'], { ...target, value: string }, ['elementId', 'value']),
    scroll: action(['scroll'], { ...target,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      amount: { type: 'number', minimum: 0.1, maximum: 3 } }, ['direction']),
    key: action(['press_key'], { ...target, key: { type: 'string', enum: [
      'Enter', 'Escape', 'Tab', 'Space', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
      'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
    ] } }, ['key']),
    readTarget: action(['read_element', 'read_nearby', 'get_table'], target, ['elementId']),
    find: action(['find_text', 'find_elements'], { pageId: target.pageId,
      revision: target.revision, query: string }, ['query']),
    form: action(['get_form_fields'], target),
    section: action(['inspect_section'], { ...target, query: string }, ['elementId']),
    observe: action(['observe'], { query: string }),
    wait: action(['wait'], { ms: { type: 'integer', minimum: 100, maximum: 3000 } }, ['ms']),
    look: action(['look']),
    navigate: action(['navigate'], { url: string }, ['url']),
    command: action(['command'], { actionId: { type: 'string', enum: COMMAND_IDS } }, ['actionId']),
    // Which fields each operation takes is checked by the host validator.
    browser: action(['browser'], { op: { type: 'string', enum: BROWSER_OPS }, url: string,
      urls: { type: 'array', items: string, minItems: 1, maxItems: 8 }, query: string, tabId,
      tabIds: { type: 'array', items: tabId, minItems: 1, maxItems: 40 },
      index: { type: 'integer', minimum: 0, maximum: 1000 }, title: string,
      color: { type: 'string', enum: GROUP_COLORS }, group: string,
      days: { type: 'integer', minimum: 1, maximum: 90 } }, ['op']),
    finish: action(['finish'], { say: string, success: { type: 'boolean' } }, ['say', 'success']),
    memory: object({
      subgoal: string,
      facts: { type: 'array', items: string, maxItems: MEMORY_LIMITS.facts },
      constraints: { type: 'array', items: string, maxItems: MEMORY_LIMITS.constraints }
    })
  }
};
