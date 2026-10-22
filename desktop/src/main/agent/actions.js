/**
 * What the desktop assistant may ask for, checked before anything happens,
 * and how careful each request is. The user's rule (2026-10-21): act without
 * asking, except to send or post, buy, delete, or change system settings —
 * and never type into a password field.
 *
 * Pure: a model's reply in; validated actions, their categories and the
 * words for the pill out.
 */

import { isRecord } from '../../../../jester-extension/src/common/agent-actions.js';
import { describePlan, parseShortcut } from '../os-actions.js';
import { elementById } from './screen.js';

const FIELDS = {
  click: ['id'],
  type: ['id', 'text', 'enter'],
  press: ['keys'],
  scroll: ['direction', 'id'],
  open_app: ['name'],
  open_url: ['url'],
  media: ['key'],
  find: ['query'],
  wait: ['ms'],
  finish: ['say', 'success']
};
export const DESKTOP_ACTIONS = Object.freeze(Object.keys(FIELDS));
/** Media keys, as the ACTIONS dispatch.js presses. */
export const MEDIA_KEYS = Object.freeze({ play: 'PLAY_PAUSE', next: 'MEDIA_NEXT', previous: 'MEDIA_PREV', volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN', mute: 'MUTE_TOGGLE' });
/** Actions that change nothing. */
export const READ_ACTIONS = new Set(['find', 'wait']);
/** What may go in a group of up to three, on controls already on screen. */
const GROUPABLE = new Set(['click', 'type', 'press', 'scroll']);
export const MAX_GROUP = 3;

function text(value, name, max, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be text of at most ${max} characters.`);
}

/** A web address the default browser may open: http(s), no credentials in it. */
export function webUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Not a web address.');
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Only plain http(s) addresses can be opened.');
  return url;
}

export function validateAction(input) {
  if (!isRecord(input) || !Object.hasOwn(FIELDS, input.action)) throw new Error(`Choose one of: ${DESKTOP_ACTIONS.join(', ')}.`);
  const allowed = new Set(['action', ...FIELDS[input.action]]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Unexpected action field.');
  const action = { ...input };
  if (action.id !== undefined && !(Number.isSafeInteger(action.id) && action.id >= 0)) throw new Error('id must be a number from the screen.');
  if (action.action === 'click' && action.id === undefined) throw new Error('click needs the id of a control.');
  if (action.action === 'type') {
    text(action.text, 'text', 2000, true);
    if (action.enter !== undefined && typeof action.enter !== 'boolean') throw new Error('enter must be true or false.');
  }
  if (action.action === 'press' && (typeof action.keys !== 'string' || action.keys.length > 40 || !parseShortcut(action.keys))) {
    throw new Error('keys must be one key or a shortcut, like "enter" or "cmd+n".');
  }
  if (action.action === 'scroll' && !['up', 'down'].includes(action.direction)) throw new Error('direction must be up or down.');
  if (action.action === 'open_app') text(action.name, 'name', 80, true);
  if (action.action === 'open_url') webUrl(action.url);
  if (action.action === 'media' && !Object.hasOwn(MEDIA_KEYS, action.key)) throw new Error(`key must be one of ${Object.keys(MEDIA_KEYS).join(', ')}.`);
  if (action.action === 'find') text(action.query, 'query', 120, true);
  if (action.action === 'wait' && !(Number.isInteger(action.ms) && action.ms >= 100 && action.ms <= 3000)) throw new Error('ms must be 100 to 3000.');
  if (action.action === 'finish') {
    text(action.say, 'say', 300, true);
    if (typeof action.success !== 'boolean') throw new Error('finish needs success true or false.');
  }
  return action;
}

/** A model's reply: {action, memory?} or {actions: [up to 3 on-screen controls], memory?}. */
export function validateTurn(value) {
  if (!isRecord(value)) throw new Error('Reply with one JSON object.');
  const keys = Object.keys(value);
  if (keys.some((key) => !['action', 'actions', 'memory'].includes(key))) throw new Error('Reply with action (or actions) and memory only.');
  if ((value.action === undefined) === (value.actions === undefined)) throw new Error('Give exactly one of action or actions.');
  if (value.action !== undefined) return { actions: [validateAction(value.action)], memory: value.memory };
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > MAX_GROUP) throw new Error(`actions holds 1 to ${MAX_GROUP} actions.`);
  const actions = value.actions.map(validateAction);
  if (actions.some((action) => !GROUPABLE.has(action.action))) throw new Error('Only click, type, press and scroll go in a group.');
  return { actions, memory: value.memory };
}

const quoted = (value) => `“${String(value).replace(/\s+/g, ' ').trim().slice(0, 50)}”`;

/** The action in a few words, for the pill: the control's own name, never its number. */
export function describeAction(action, screen = null, platform = 'darwin') {
  const element = action.id === undefined ? null : elementById(screen, action.id);
  const target = element?.label ? quoted(element.label) : element ? `the ${element.role}` : '';
  switch (action.action) {
    case 'click':
      return `Click ${target || 'it'}`;
    case 'type':
      return `Type ${quoted(action.text)}${target ? ` in ${target}` : ''}${action.enter ? ', then Enter' : ''}`;
    case 'press':
      return `Press ${describePlan(parseShortcut(action.keys), platform)}`;
    case 'scroll':
      return `Scroll ${action.direction}${target ? ` in ${target}` : ''}`;
    case 'open_app':
      return `Open ${action.name}`;
    case 'open_url':
      return `Open ${new URL(action.url).hostname.replace(/^www\./, '')}`;
    case 'media':
      return { play: 'Play/pause', next: 'Next track', previous: 'Previous track', volume_up: 'Volume up', volume_down: 'Volume down', mute: 'Mute' }[action.key];
    case 'find':
      return `Look for ${quoted(action.query)}`;
    case 'wait':
      return 'Wait';
    case 'finish':
      return action.say;
    default:
      return action.action;
  }
}

/** Buttons whose press sends, buys or deletes. */
const SENSITIVE_LABEL =
  /\b(?:send|post|publish|tweet|reply all|submit|buy|purchase|pay|payment|check ?out|place order|order now|subscribe|donate|transfer|delete|trash|erase|uninstall|empty bin|sign out|log out)\b/i;
/** Apps where Enter usually sends what was typed. */
const SENDING_APPS = /^(?:messages|mail|slack|discord|whatsapp|telegram|signal|microsoft teams|teams|outlook|microsoft outlook|messenger|skype|zoom|facetime)$/i;
const MESSAGE_FIELD = /\b(?:message|reply|comment|chat|post|tweet|compose)\b/i;
/** Where any change is a change to the computer's own settings. */
const SETTINGS_APPS = /^(?:system settings|system preferences|settings|control panel)$/i;
/** Sites a step may open without the user having named them. */
const KNOWN_SITES = ['google.com', 'youtube.com', 'spotify.com', 'wikipedia.org', 'github.com', 'netflix.com', 'apple.com', 'microsoft.com', 'bing.com', 'duckduckgo.com'];

function knownSite(url, goal) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (KNOWN_SITES.some((site) => host === site || host.endsWith(`.${site}`))) return true;
  // A site the user named, in whole words: "open the verge" → theverge.com.
  const name = host.split('.').slice(-2, -1)[0] || '';
  const words = String(goal).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (let from = 0; from < words.length; from++) {
    for (let to = from + 1; to <= Math.min(words.length, from + 4); to++) if (words.slice(from, to).join('') === name) return true;
  }
  return false;
}

/**
 * How careful to be: 'read' and 'browse' go ahead, 'sensitive' asks first,
 * 'blocked' never happens. `reason` says why, for the model or the pill.
 * @param {object} action  validated
 * @param {object} context
 * @param {object} context.screen  the snapshot the action was chosen from
 * @param {string} [context.goal]
 */
export function classify(action, { screen = null, goal = '' } = {}) {
  if (READ_ACTIONS.has(action.action) || action.action === 'finish') return { category: 'read' };
  const app = screen?.app?.name || '';
  const element = action.id === undefined ? null : elementById(screen, action.id);
  const focused = (screen?.elements || []).find((item) => item.focused) || null;
  const field = element || focused;
  if (field?.role === 'password' && ['click', 'type', 'press'].includes(action.action)) {
    return { category: 'blocked', reason: 'Jester never types into password fields.' };
  }
  if (SETTINGS_APPS.test(app)) return { category: 'sensitive', reason: `it changes ${app}` };
  if (action.action === 'click' && SENSITIVE_LABEL.test(element?.label || '')) return { category: 'sensitive', reason: 'it may send, buy or delete something' };
  const plan = action.action === 'press' ? parseShortcut(action.keys) : null;
  const enter = (action.action === 'type' && action.enter) || plan?.key === 'enter';
  if (enter) {
    // ⌘/Ctrl+Enter sends almost everywhere; plain Enter does in chat and mail.
    if (plan?.modifiers.some((modifier) => modifier === 'cmd' || modifier === 'ctrl')) return { category: 'sensitive', reason: 'it may send something' };
    if (SENDING_APPS.test(app) || MESSAGE_FIELD.test(`${field?.label || ''} ${field?.placeholder || ''}`)) return { category: 'sensitive', reason: 'Enter may send it' };
  }
  if (plan && ['backspace', 'delete'].includes(plan.key) && plan.modifiers.some((modifier) => modifier === 'cmd' || modifier === 'ctrl')) {
    return { category: 'sensitive', reason: 'it may delete something' };
  }
  if (action.action === 'open_url' && !knownSite(action.url, goal)) return { category: 'sensitive', reason: 'it opens a site you didn’t name' };
  return { category: 'browse' };
}
