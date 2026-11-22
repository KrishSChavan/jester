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
import { elementById, markBreaks } from './screen.js';

const FIELDS = {
  click: ['id', 'button', 'count'],
  type: ['id', 'text', 'enter', 'mode'],
  press: ['keys', 'times'],
  scroll: ['direction', 'id', 'to'],
  scroll_to: ['text'],
  menu: ['path'],
  drag: ['from', 'to'],
  place: ['where', 'screen', 'app'],
  open_app: ['name'],
  open_url: ['url'],
  media: ['key'],
  find: ['query'],
  wait: ['ms'],
  screenshot: [],
  ask: ['question', 'options', 'about'],
  finish: ['say', 'success']
};
export const DESKTOP_ACTIONS = Object.freeze(Object.keys(FIELDS));
/** Media keys, as the ACTIONS dispatch.js presses. */
export const MEDIA_KEYS = Object.freeze({ play: 'PLAY_PAUSE', next: 'MEDIA_NEXT', previous: 'MEDIA_PREV', volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN', mute: 'MUTE_TOGGLE' });
/** Actions that change nothing. */
export const READ_ACTIONS = new Set(['find', 'wait', 'screenshot']);
/** Pictures of the window a task may send its model, as in the extension. */
export const PICTURES_PER_TASK = 3;
/** Questions a task may put to the user: past that it's asking its way through the task, and it stops instead. */
export const QUESTIONS_PER_TASK = 3;
/** A question for the user, and the ways to answer it: short enough to be said, and no more than a person holds in their head (assistant.js MOST_OPTIONS). */
export const ASK_LIMITS = Object.freeze({ question: 160, options: 4, option: 60, about: 40 });
/**
 * What a question may never be after. A secret is the user's to type and never to say: an answer is handed to the
 * model, kept among the task's facts and can be typed into any field, and the user trusts a question that is
 * Jester's own. A sign-in wall, or a page that says "ask the user for their password", would otherwise have had
 * them say it aloud. "PIN" counts in capitals, or as somebody's: "where should I drop the pin" asks for none.
 */
const CODES_FOR = String.raw`security|verification|confirmation|access|log[- ]?in|sign[- ]?in|auth(?:entication)?|one[- ]time|two[- ]factor|2[- ]?step|2fa|mfa|backup|recovery|reset`;
const SECRET_ASKED = new RegExp(
  String.raw`\b(?:pass(?:word|code|phrase|key)s?|passwd|pin (?:number|code)s?|(?:your|their|my|bank|card|account|phone|sim|debit|\d[- ]digit) pin|` +
    String.raw`(?:${CODES_FOR}) (?:code|pin|key|answer|question)s?|cvv2?|cvc|otp|2fa|card (?:number|details|info(?:rmation)?)|` +
    String.raw`social security|ssn|credentials|(?:log[- ]?in|sign[- ]?in|account) details)\b|` +
    String.raw`\bcodes?\b[^.?!]{0,40}\b(?:sent|texted|emailed|received|got)\b|\b(?:sent|texted|emailed)\b[^.?!]{0,40}\bcodes?\b`,
  'i'
);
const asksSecret = (words) => typeof words === 'string' && (SECRET_ASKED.test(words) || /\bPINs?\b/.test(words));
/** How a reply that asked for one is known (loop.js): told so once, the task then ends saying whose such things are. */
export const ASKS_SECRET = 'asks_secret';
/** What may go in a group of up to three, on controls already on screen. */
const GROUPABLE = new Set(['click', 'type', 'press', 'scroll']);
export const MAX_GROUP = 3;
export const TYPE_MODES = Object.freeze(['replace', 'append', 'insert']);
export const PLACES = Object.freeze(['left', 'right', 'full', 'center', 'fullscreen']);
export const SCREENS = Object.freeze(['current', 'laptop', 'monitor', 'other']);
/** Menu paths: "File > New Note", at most this many titles. */
export const MENU_DEPTH = 6;

/** A menu path's titles: "File > New Note" (or "File › New Note") → ["File", "New Note"]. */
export function menuPath(path) {
  return String(path)
    .split(/\s*[>›→]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function text(value, name, max, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be text of at most ${max} characters.`);
}

function oneOf(value, name, allowed) {
  if (value !== undefined && !allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}.`);
}

function controlId(value, name) {
  if (!(Number.isSafeInteger(value) && value >= 0)) throw new Error(`${name} must be a number from the screen.`);
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
  if (action.id !== undefined) controlId(action.id, 'id');
  if (action.action === 'click') {
    if (action.id === undefined) throw new Error('click needs the id of a control.');
    oneOf(action.button, 'button', ['left', 'right']);
    oneOf(action.count, 'count', [1, 2]);
  }
  if (action.action === 'type') {
    text(action.text, 'text', 2000, true);
    if (action.enter !== undefined && typeof action.enter !== 'boolean') throw new Error('enter must be true or false.');
    oneOf(action.mode, 'mode', TYPE_MODES);
  }
  if (action.action === 'press') {
    if (typeof action.keys !== 'string' || action.keys.length > 40 || !parseShortcut(action.keys)) throw new Error('keys must be one key or a shortcut, like "enter" or "cmd+n".');
    if (action.times !== undefined && !(Number.isInteger(action.times) && action.times >= 1 && action.times <= 10)) throw new Error('times must be 1 to 10.');
  }
  if (action.action === 'scroll') {
    oneOf(action.direction, 'direction', ['up', 'down', 'left', 'right']);
    if (action.direction === undefined) throw new Error('direction must be up, down, left or right.');
    oneOf(action.to, 'to', ['end']);
  }
  if (action.action === 'scroll_to') text(action.text, 'text', 120, true);
  if (action.action === 'menu') {
    text(action.path, 'path', 200, true);
    const parts = menuPath(action.path);
    if (!parts.length || parts.length > MENU_DEPTH) throw new Error(`path is 1 to ${MENU_DEPTH} menu titles, like "File > New Note".`);
  }
  if (action.action === 'drag') {
    controlId(action.from, 'from');
    controlId(action.to, 'to');
  }
  if (action.action === 'place') {
    oneOf(action.where, 'where', PLACES);
    if (action.where === undefined) throw new Error(`where must be one of ${PLACES.join(', ')}.`);
    oneOf(action.screen, 'screen', SCREENS);
    text(action.app, 'app', 80);
  }
  if (action.action === 'open_app') text(action.name, 'name', 80, true);
  if (action.action === 'open_url') webUrl(action.url);
  if (action.action === 'media' && !Object.hasOwn(MEDIA_KEYS, action.key)) throw new Error(`key must be one of ${Object.keys(MEDIA_KEYS).join(', ')}.`);
  if (action.action === 'find') text(action.query, 'query', 120, true);
  if (action.action === 'wait' && !(Number.isInteger(action.ms) && action.ms >= 100 && action.ms <= 3000)) throw new Error('ms must be 100 to 3000.');
  if (action.action === 'ask') {
    text(action.question, 'question', ASK_LIMITS.question, true);
    const squashed = (value, max) => value.replace(/\s+/g, ' ').trim().slice(0, max).trim();
    // Too much of what's right is cut to size, as task-memory.js cuts a list of facts (2026-11-15: refusing one threw
    // away the step it came with). A household's six profiles, all listed, were two unusable replies and the end of
    // the task, at the very moment it was asking instead of guessing. The first four are offered, and the user's own
    // words can still name another; a list left empty, or an `about` left blank, is one left out.
    if (action.options !== undefined) {
      if (!Array.isArray(action.options) || action.options.some((choice) => typeof choice !== 'string')) throw new Error('options is a list of short choices, each as text.');
      const read = new Set();
      const choices = action.options.map((choice) => squashed(choice, ASK_LIMITS.option)).filter((choice) => choice && !read.has(choice.toLowerCase()) && read.add(choice.toLowerCase()));
      // One way to answer is no question, and two that read the same can't be told apart by the answer.
      if (choices.length === 1) throw new Error(`options holds 2 to ${ASK_LIMITS.options} different choices; leave it out for a question answered in the user’s own words.`);
      if (choices.length) action.options = choices.slice(0, ASK_LIMITS.options);
      else delete action.options;
    }
    if (action.about !== undefined) {
      if (typeof action.about !== 'string') throw new Error('about must be text.');
      const about = squashed(action.about, ASK_LIMITS.about);
      if (about) action.about = about;
      else delete action.about;
    }
    if (asksSecret(action.question) || asksSecret(action.about)) {
      throw Object.assign(new Error('Never ask for a password, a code, a card number or any other secret: those are the user’s to type. If the task can’t go on without one, finish with success:false and say the user is needed.'), { code: ASKS_SECRET });
    }
  }
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
  if (keys.some((key) => !['task', 'action', 'actions', 'memory'].includes(key))) throw new Error('Reply with task, action (or actions) and memory only.');
  if ((value.action === undefined) === (value.actions === undefined)) throw new Error('Give exactly one of action or actions.');
  // The caption is only for show: one that isn't text is dropped, not refused.
  const task = typeof value.task === 'string' && value.task.trim() ? value.task : undefined;
  if (value.action !== undefined) return { actions: [validateAction(value.action)], memory: value.memory, task };
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > MAX_GROUP) throw new Error(`actions holds 1 to ${MAX_GROUP} actions.`);
  const actions = value.actions.map(validateAction);
  if (actions.some((action) => !GROUPABLE.has(action.action))) throw new Error('Only click, type, press and scroll go in a group.');
  return { actions, memory: value.memory, task };
}

/** The pill's caption for a task is at most this long. */
export const CAPTION_CHARS = 32;

/**
 * A task in a few words, for the pill while it runs: the model's caption
 * ("Texting Trisha hello") or, until there is one, what the user said —
 * tidied, and cut at a word when it's long.
 */
export function taskCaption(text, max = CAPTION_CHARS) {
  const tidied = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘](.*)["'”’]$/, '$1')
    .replace(/^(?:(?:can|could|would|will) you |please )+/i, '')
    .replace(/[\s.!?…]+$/, '');
  const caption = tidied.charAt(0).toUpperCase() + tidied.slice(1);
  if (caption.length <= max) return caption;
  const cut = caption.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

export const quoted = (value) => `“${markBreaks(value).replace(/\s+/g, ' ').trim().slice(0, 50)}”`;

const SCROLL_ENDS = { up: 'the top', down: 'the bottom', left: 'the far left', right: 'the far right' };
const PLACE_WORDS = { left: 'on the left', right: 'on the right', full: 'full size', center: 'in the middle', fullscreen: 'full screen' };
const SCREEN_WORDS = { laptop: ' of the laptop screen', monitor: ' of the monitor', other: ' of the other screen', current: '' };

/** The action in a few words, for the pill: the control's own name, never its number. */
export function describeAction(action, screen = null, platform = 'darwin') {
  const element = action.id === undefined ? null : elementById(screen, action.id);
  const named = (item) => (item?.label ? quoted(item.label) : item ? `the ${item.role}` : '');
  const target = named(element);
  switch (action.action) {
    case 'click':
      return `${action.count === 2 ? 'Double-click' : action.button === 'right' ? 'Right-click' : 'Click'} ${target || 'it'}`;
    case 'type':
      return `${action.mode === 'append' ? 'Add' : 'Type'} ${quoted(action.text)}${target ? ` ${action.mode === 'append' ? 'to the end of' : 'in'} ${target}` : ''}${action.enter ? ', then Enter' : ''}`;
    case 'press':
      return `Press ${describePlan(parseShortcut(action.keys), platform)}${action.times > 1 ? ` ${action.times} times` : ''}`;
    case 'scroll':
      return action.to === 'end' ? `Scroll to ${SCROLL_ENDS[action.direction]}${target ? ` of ${target}` : ''}` : `Scroll ${action.direction}${target ? ` in ${target}` : ''}`;
    case 'scroll_to':
      return `Scroll to ${quoted(action.text)}`;
    case 'menu':
      return `Choose ${(action.resolved || menuPath(action.path)).join(' › ')}`;
    case 'drag':
      return `Drag ${named(elementById(screen, action.from)) || 'it'} onto ${named(elementById(screen, action.to)) || 'there'}`;
    case 'place':
      return `Put ${action.app || screen?.app?.name || 'the window'} ${PLACE_WORDS[action.where]}${action.where === 'fullscreen' ? '' : SCREEN_WORDS[action.screen || 'current']}`;
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
    case 'screenshot':
      return 'Look at the window';
    case 'ask':
      return `Ask ${quoted(action.question)}`;
    case 'finish':
      return action.say;
    default:
      return action.action;
  }
}

/** Buttons and menu items whose press sends, buys or deletes ("Move to Bin" and "Deleted Items" are deleting too). */
export const SENSITIVE_LABEL =
  /\b(?:send|post|publish|tweet|reply all|submit|buy|purchase|pay|payment|check ?out|place order|order now|subscribe|donate|transfer|delete|trash|erase|uninstall|empty bin|move to bin|recycle bin|deleted items|move to deleted|sign out|log out)\b/i;
/** Fields where Delete and Backspace take out characters, not things. */
const TEXT_ROLES = new Set(['textfield', 'searchfield', 'textarea', 'combobox']);
/** A yes that means whatever the dialog asking it is about. */
const GENERIC_YES = /^\s*(?:ok|okay|yes|continue|confirm|allow|accept|agree|done|proceed)\s*$/i;
/** Where a drop deletes: the Trash, the Recycle Bin, an app's "Recently Deleted". */
const DELETE_DROP = /\b(?:trash|bin|recycle|delete|deleted)\b/i;
/** Apps where Enter usually sends what was typed. */
const SENDING_APPS = /^(?:messages|mail|slack|discord|whatsapp|telegram|signal|microsoft teams|teams|outlook|microsoft outlook|messenger|skype|zoom|facetime)$/i;
const MESSAGE_FIELD = /\b(?:message|reply|comment|chat|post|tweet|compose)\b/i;
/** Where any change is a change to the computer's own settings: Windows' Settings app is SystemSettings, its Quick Settings ShellExperienceHost (ShellHost from 24H2). */
const SETTINGS_APPS = /^(?:system settings|system preferences|settings|systemsettings|control panel|shellexperiencehost|shellhost)$/i;
/** Windows' own tools for settings: Control Panel opens in Explorer (or control.exe), its applets in rundll32, its consoles in mmc. */
const SETTINGS_TOOLS = /^(?:rundll32|mmc)$/i;
const CONTROL_PANEL = /^(?:explorer|control)$/i;

/**
 * Whether the screen is the computer's settings, on either system. A Control
 * Panel page in Explorer is titled by its own name ("Power Options"); its
 * address bar still says Control Panel. A Store app frame not resolved to its
 * app keeps the frame's name, and the window's title says Settings.
 */
function settingsScreen(screen) {
  const app = screen?.app?.name || '';
  if (SETTINGS_APPS.test(app) || SETTINGS_TOOLS.test(app)) return true;
  if (/^applicationframehost$/i.test(app)) return /^settings\b/i.test(screen?.window?.title || '');
  if (!CONTROL_PANEL.test(app)) return false;
  const says = [screen?.window?.title, ...(screen?.elements || []).map((item) => `${item.label || ''} ${typeof item.value === 'string' ? item.value : ''}`)];
  return says.some((text) => /\bcontrol panel\b/i.test(text || ''));
}
/**
 * Getting around the settings, which changes none of them: a section's row in the sidebar or the words beside it (as
 * macOS's System Settings reads: an unnamed row, then a line of text), a tab, a link, a disclosure, a scroll, words
 * typed in the search field, the Back button. Asked before each, he couldn't answer "which Wi-Fi am I on?" without a
 * yes to 'Click "Wi-Fi"?' (2026-11-14). What changes a setting is none of these: a switch, a checkbox, a popup, a
 * slider, any other button, a field.
 */
const WAYFINDING_ROLES = new Set(['row', 'cell', 'text', 'heading', 'link', 'tab', 'disclosure']);
const WAYFINDING_BUTTONS = /^(?:back|forward|show all|go back)$/i;
/** What leaves the settings window alone altogether: with it in front, "open Calculator" asked first too (2026-11-14). */
const ELSEWHERE = new Set(['open_app', 'open_url', 'media', 'place']);
function findsItsWay(action, element, focused) {
  if (action.action === 'scroll' || ELSEWHERE.has(action.action)) return true;
  if (action.action === 'click') {
    if (!element || action.button === 'right' || (action.count ?? 1) > 1) return false;
    return WAYFINDING_ROLES.has(element.role) || (element.role === 'button' && WAYFINDING_BUTTONS.test(String(element.label || '').trim()));
  }
  // Searching the settings: Enter there only searches.
  if (action.action === 'type') return (element || focused)?.role === 'searchfield';
  return false;
}

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
 * What a plain "OK" agrees to: the window's title and the text just before
 * the button in reading order, where a dialog puts its question — not the
 * whole window, whose content may mention sending anywhere.
 */
function dialogWords(screen, element) {
  const elements = screen?.elements || [];
  const at = elements.indexOf(element);
  const before = elements.slice(Math.max(0, at - 8), Math.max(0, at)).filter((item) => item.role === 'text' || item.role === 'heading');
  return [screen?.window?.title || '', ...before.map((item) => item.label || '')].join(' ');
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
  if (READ_ACTIONS.has(action.action) || action.action === 'finish' || action.action === 'scroll_to') return { category: 'read' };
  const app = screen?.app?.name || '';
  const element = action.id === undefined ? null : elementById(screen, action.id);
  const elements = screen?.elements || [];
  const focused = elements.find((item) => item.focused) || null;
  const field = element || focused;
  if (field?.role === 'password' && ['click', 'type', 'press'].includes(action.action)) {
    return { category: 'blocked', reason: 'Jester never types into password fields.' };
  }
  // A menu command (Paste, AutoFill) or a drop can put text into a password field too.
  if ((action.action === 'menu' && focused?.role === 'password') || (action.action === 'drag' && elementById(screen, action.to)?.role === 'password')) {
    return { category: 'blocked', reason: 'Jester never types into password fields.' };
  }
  if (settingsScreen(screen) && !findsItsWay(action, element, focused)) return { category: 'sensitive', reason: `it changes ${app || 'the computer’s settings'}` };
  const sends = { category: 'sensitive', reason: 'it may send, buy or delete something' };
  const deletes = { category: 'sensitive', reason: 'it may delete something' };
  /** Whether pressing this control sends, buys or deletes: by its name, or as the "OK" to a dialog asking to. */
  const pressSends = (control) => SENSITIVE_LABEL.test(control?.label || '') || (GENERIC_YES.test(control?.label || '') && SENSITIVE_LABEL.test(dialogWords(screen, control)));
  if (action.action === 'click' && (pressSends(element) || (element?.role === 'menuitem' && DELETE_DROP.test(element.label || '')))) return sends;
  if (action.action === 'menu') {
    // Every title counts: "Message › Move to › Bin" deletes as surely as "Delete".
    const titles = (action.resolved || menuPath(action.path)).join(' › ');
    if (SENSITIVE_LABEL.test(titles) || (/\bmove to\b/i.test(titles) && DELETE_DROP.test(titles))) return sends;
  }
  if (action.action === 'drag' && DELETE_DROP.test(elementById(screen, action.to)?.label || '')) return deletes;
  const plan = action.action === 'press' ? parseShortcut(action.keys) : null;
  /**
   * A dialog asking whether to send, buy or delete, whose default button
   * Enter may press: a small window whose own text asks it ("Are you sure
   * you want to delete…?"), with a button that does it.
   */
  const riskyDialog =
    elements.length <= 15 &&
    elements.some((item) => (item.role === 'text' || item.role === 'heading') && SENSITIVE_LABEL.test(item.label || '')) &&
    elements.some((item) => item.role === 'button' && pressSends(item));
  if (plan && ['enter', 'space'].includes(plan.key)) {
    // Enter or Space on a focused button presses it, as a click would.
    if (['button', 'link', 'menuitem'].includes(focused?.role) && pressSends(focused)) return sends;
    // Elsewhere (nothing focused, a checkbox, a radio), Enter is the dialog's default button.
    if (plan.key === 'enter' && !['button', 'link', 'menuitem'].includes(focused?.role) && !TEXT_ROLES.has(focused?.role) && riskyDialog) return sends;
  }
  // Typed into a dialog's field and sent with Enter: the default button again.
  if (action.action === 'type' && action.enter && riskyDialog) return sends;
  // Delete or Backspace outside a text field deletes what's selected: a file, a message, a note.
  if (plan && ['backspace', 'delete'].includes(plan.key) && !TEXT_ROLES.has(focused?.role)) return deletes;
  // A line break in typed text is an Enter, pressed mid-way.
  const enter = (action.action === 'type' && (action.enter || /[\r\n]/.test(action.text))) || plan?.key === 'enter';
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

const SAID_MODIFIERS = { cmd: 'Command', ctrl: 'Control', alt: 'Option', shift: 'Shift', fn: 'Fn', win: 'Windows' };
const SAID_KEYS = { enter: 'Enter', space: 'Space', escape: 'Escape', tab: 'Tab', left: 'Left Arrow', right: 'Right Arrow', up: 'Up Arrow', down: 'Down Arrow' };

/** A key or shortcut as it's said: "Command-Enter", where the pill shows ⌘↩. A question is spoken as well as shown. */
function keysSaid(plan, platform) {
  const mac = platform === 'darwin';
  const modifier = (name) => (!mac && name === 'cmd' ? 'Windows' : !mac && name === 'alt' ? 'Alt' : SAID_MODIFIERS[name] || name);
  const key = plan.key === 'backspace' ? (mac ? 'Delete' : 'Backspace') : plan.key === 'delete' ? (mac ? 'Forward Delete' : 'Delete') : SAID_KEYS[plan.key] || plan.key.charAt(0).toUpperCase() + plan.key.slice(1);
  return [...plan.modifiers.map(modifier), key].join('-');
}

/**
 * A step that waits for the user's yes, as the question a person would ask before doing it: "Send “hello” in
 * Messages", "Delete what’s selected in Finder", "Press “Send” in Mail". Until 2026-11-21 the user was asked the
 * pill's words for the step ("Type “hello” in “Message”, then Enter?", "Press ↩?"), which read as a machine's and
 * can't be said aloud. Only the words are chosen here: whether to ask, and why, is classify's alone, and what a step
 * comes to (a send, a delete) is said only where its `reason` is that sure of it.
 * @param {object} action  validated, and prepared (a menu's real titles)
 * @param {object} screen  the screen it was judged on
 * @param {{reason?:string, platform?:string}} [options]  reason: classify's, for this step
 */
export function askLabel(action, screen = null, { reason = '', platform = 'darwin' } = {}) {
  const app = screen?.app?.name || '';
  const where = app ? ` in ${app}` : '';
  const named = (item) => (item?.label ? quoted(item.label) : item ? `the ${item.role}` : '');
  const focused = (screen?.elements || []).find((item) => item.focused) || null;
  const said = describeAction(action, screen, platform);
  switch (action.action) {
    case 'type':
      // Typed where Enter sends: the message is what's asked about, not the keys.
      return reason === 'Enter may send it' ? `Send ${quoted(action.text)}${where}` : said.replace(/, then Enter$/, ' and press Enter');
    case 'press': {
      const plan = parseShortcut(action.keys);
      if (reason === 'Enter may send it') return `Send this${where}`;
      if (reason === 'it may delete something' && !TEXT_ROLES.has(focused?.role)) return `Delete what’s selected${where}`;
      // Enter on a button that sends is that button, pressed. Any other focus, and Enter may be the dialog's own button: only the key is sure.
      const pressed = ['enter', 'space'].includes(plan.key) && !plan.modifiers.length && ['button', 'link', 'menuitem'].includes(focused?.role) && SENSITIVE_LABEL.test(focused.label || '');
      return `Press ${pressed ? named(focused) : keysSaid(plan, platform)}${action.times > 1 ? ` ${action.times} times` : ''}${where}`;
    }
    case 'click':
      return action.count === 2 || action.button === 'right' ? `${said}${where}` : `Press ${named(elementById(screen, action.id)) || 'this'}${where}`;
    case 'menu': {
      const [menu, ...rest] = action.resolved || menuPath(action.path);
      return rest.length ? `Choose ${quoted(rest.join(' › '))} from the ${menu} menu${where}` : `${said}${where}`;
    }
    case 'drag':
      return reason === 'it may delete something' ? `Move ${named(elementById(screen, action.from)) || 'this'} to ${named(elementById(screen, action.to)) || 'there'}${where}` : `${said}${where}`;
    default:
      return said;
  }
}

/** A control that plays or pauses what's on: pressed twice, the second press undoes the first. */
export const PLAYS = /^(?:play|pause|resume)\b/i;

/**
 * Whether two steps of a task done (loop.js's trace) are the same press of Play or Pause, one after the other: the
 * second undid the first, whatever the task went on to say (a screen read before the app had caught up).
 */
export function pressedTwice(before, step) {
  const click = (item) => item?.action?.action === 'click' && item.action.button !== 'right' && PLAYS.test(String(item.target?.label || '').trim());
  return click(before) && click(step) && before.app === step.app && before.target.role === step.target.role && before.target.label === step.target.label;
}
