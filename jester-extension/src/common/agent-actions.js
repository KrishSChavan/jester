/** The model can request semantic operations only. The worker owns permissions. */
import { ACTIONS } from './constants.js';

const TARGET = ['elementId', 'pageId', 'revision'];
const FIELDS = {
  click: TARGET, focus: TARGET, clear: TARGET, hover: TARGET,
  type: [...TARGET, 'text'], select: [...TARGET, 'value'],
  scroll: ['elementId', 'pageId', 'revision', 'direction', 'amount'],
  press_key: ['elementId', 'pageId', 'revision', 'key'],
  read_element: TARGET, read_nearby: TARGET,
  find_text: ['query', 'pageId', 'revision'],
  find_elements: ['query', 'pageId', 'revision'],
  get_form_fields: ['elementId', 'pageId', 'revision'],
  get_table: TARGET, inspect_section: [...TARGET, 'query'],
  observe: ['query'], wait: ['ms'], look: [],
  navigate: ['url'],
  command: ['actionId'], finish: ['say', 'success'],
  browser: ['op', 'url', 'urls', 'query', 'tabId', 'tabIds', 'index', 'title', 'color', 'group', 'days']
};

/**
 * Chrome's own tabs, windows, history, bookmarks and tab groups. The worker runs
 * these, not the page, so they work on any tab, Chrome's own pages included.
 */
const BROWSER_FIELDS = {
  tabs: ['query'], new: [], next: [], previous: [],
  open: ['url', 'urls', 'group'], search: ['query'], switch: ['tabId'],
  close: ['tabId', 'tabIds'], reopen: [], window: ['url'], back: ['tabId'], forward: ['tabId'],
  reload: ['tabId'], pin: ['tabId'], unpin: ['tabId'], mute: ['tabId'], unmute: ['tabId'],
  duplicate: ['tabId'], move: ['tabId', 'index'], group: ['tabIds', 'group', 'color'], ungroup: ['tabIds'],
  collapse: ['group'], expand: ['group'], history: ['query', 'days'], bookmarks: ['query'], bookmark: ['title']
};
export const BROWSER_OPS = Object.freeze(Object.keys(BROWSER_FIELDS));
/** Browser operations that only read. */
export const BROWSER_READS = new Set(['tabs', 'history', 'bookmarks']);
export const GROUP_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const REQUIRES_ELEMENT = new Set([
  'click', 'focus', 'clear', 'hover', 'type', 'select', 'read_element', 'read_nearby', 'get_table', 'inspect_section'
]);
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Space', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
  'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
export const READ_ACTIONS = new Set([
  'observe', 'wait', 'read_element', 'read_nearby', 'find_text', 'find_elements',
  'get_form_fields', 'get_table', 'inspect_section', 'look'
]);
export const COMMAND_IDS = ['PLAY', 'PAUSE', 'PLAY_PAUSE', 'SEEK_FORWARD', 'SEEK_BACK',
  'VOLUME_UP', 'VOLUME_DOWN', 'MUTE_TOGGLE', 'SPEED_UP', 'SPEED_DOWN', 'SKIP_AD', 'NEXT_VIDEO',
  'FULLSCREEN_TOGGLE', 'EXIT_FULLSCREEN'].filter((id) => Object.hasOwn(ACTIONS, id));

/** An action that changes nothing: a page read, or a browser listing. */
export function isReadAction(action) {
  return READ_ACTIONS.has(action?.action) || (action?.action === 'browser' && BROWSER_READS.has(action.op));
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function stringField(value, name, max, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`Invalid ${name}.`);
  }
}

function webAddress(value) {
  stringField(value, 'url', 2000, true);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid navigation URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS navigation is supported.');
  }
}

function tabNumber(value, name) {
  if (!(Number.isSafeInteger(value) && value >= 0)) throw new Error(`Invalid ${name}.`);
}

function validateBrowser(action) {
  if (!Object.hasOwn(BROWSER_FIELDS, action.op)) throw new Error('Choose a supported browser operation.');
  for (const key of Object.keys(action)) {
    if (key !== 'action' && key !== 'op' && !BROWSER_FIELDS[action.op].includes(key)) {
      throw new Error(`Unexpected field for browser ${action.op}.`);
    }
  }
  if (action.url !== undefined) webAddress(action.url);
  if (action.urls !== undefined) {
    if (!Array.isArray(action.urls) || action.urls.length < 1 || action.urls.length > 8) throw new Error('Open 1–8 addresses at once.');
    action.urls.forEach(webAddress);
  }
  if (action.tabId !== undefined) tabNumber(action.tabId, 'tab ID');
  if (action.tabIds !== undefined) {
    if (!Array.isArray(action.tabIds) || action.tabIds.length < 1 || action.tabIds.length > 40) throw new Error('Name 1–40 tabs.');
    action.tabIds.forEach((id) => tabNumber(id, 'tab ID'));
  }
  stringField(action.query, 'query', 200, ['search', 'bookmarks'].includes(action.op));
  stringField(action.title, 'title', 120);
  stringField(action.group, 'group', 80, ['collapse', 'expand'].includes(action.op));
  if (action.color !== undefined && !GROUP_COLORS.includes(action.color)) throw new Error('Invalid group color.');
  if (action.index !== undefined && !(Number.isSafeInteger(action.index) && action.index >= 0 && action.index <= 1000)) {
    throw new Error('Invalid tab position.');
  }
  if (action.days !== undefined && !(Number.isInteger(action.days) && action.days >= 1 && action.days <= 90)) {
    throw new Error('History reaches back 1–90 days.');
  }
  if (action.op === 'open' && (action.url === undefined) === (action.urls === undefined)) throw new Error('Open needs url or urls.');
  if (action.op === 'switch' && action.tabId === undefined) throw new Error('Switch needs a tab ID.');
  if (['group', 'ungroup'].includes(action.op) && action.tabIds === undefined) throw new Error(`${action.op} needs tab IDs.`);
  if (action.op === 'move' && action.index === undefined) throw new Error('Move needs a position.');
}

export function validateAction(input) {
  if (!isRecord(input) || typeof input.action !== 'string' || !Object.hasOwn(FIELDS, input.action)) {
    throw new Error('Choose one supported semantic action.');
  }
  const allowed = new Set(['action', ...FIELDS[input.action]]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Unexpected action field.');
  const action = { ...input };
  if ('elementId' in action || REQUIRES_ELEMENT.has(action.action)) {
    stringField(action.elementId, 'elementId', 80, true);
    if (!/^[A-Za-z0-9_:.-]+$/.test(action.elementId)) throw new Error('Invalid semantic element ID.');
  }
  stringField(action.pageId, 'pageId', 120);
  if (action.revision !== undefined && !(Number.isSafeInteger(action.revision) && action.revision >= 0)) {
    throw new Error('Invalid page revision.');
  }
  if (action.action === 'type') stringField(action.text, 'text', 2000, true);
  if (action.action === 'select') stringField(action.value, 'value', 300, true);
  if (['find_text', 'find_elements'].includes(action.action)) stringField(action.query, 'query', 300, true);
  else stringField(action.query, 'query', 300);
  if (action.action === 'scroll') {
    if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(action.direction)) {
      throw new Error('Invalid scroll direction.');
    }
    if (action.amount !== undefined && (!Number.isFinite(action.amount) || action.amount < 0.1 || action.amount > 3)) {
      throw new Error('Scroll amount must be between 0.1 and 3 viewports.');
    }
  }
  if (action.action === 'press_key' && !KEYS.has(action.key)) throw new Error('Unsupported key.');
  if (action.action === 'wait' && (!Number.isInteger(action.ms) || action.ms < 100 || action.ms > 3000)) {
    throw new Error('Wait must be between 100 and 3000 milliseconds.');
  }
  if (action.action === 'navigate') webAddress(action.url);
  if (action.action === 'browser') validateBrowser(action);
  if (action.action === 'command' && !COMMAND_IDS.includes(action.actionId)) throw new Error('Unknown built-in command.');
  if (action.action === 'finish') {
    stringField(action.say, 'say', 500, true);
    if (typeof action.success !== 'boolean') throw new Error('Finish must declare success true or false.');
  }
  return action;
}

export function describeAction(action) {
  let site = '';
  try { if (action.url) site = ` ${new URL(action.url).hostname}`; } catch { /* validated before use */ }
  return `${action.action}${action.op ? ` ${action.op}` : ''}${action.elementId ? ` ${action.elementId}` : ''}` +
    `${site}${action.query ? ` ${action.query}` : ''}${action.actionId ? ` ${action.actionId}` : ''}`;
}
