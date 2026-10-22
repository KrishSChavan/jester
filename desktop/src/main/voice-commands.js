/**
 * What a spoken sentence asks the computer to do, without a model: the
 * everyday commands — volume, media, apps, windows, tabs, desktops, typing,
 * keys, clicks — matched locally, as the extension matches its quick commands.
 * Anything else is `unknown`, for the assistant (phase 6).
 *
 * Pure: the transcript and the installed apps come in, a command comes out
 * (parseSequence: one per step, for "open Notes and write hello"):
 *   { kind: 'action', action }          an ACTIONS id, done by dispatch.js
 *   { kind: 'volume', level }           0–100
 *   { kind: 'open' | 'quit' | 'minimize', app, heard }
 *   { kind: 'new', item }               note, email, message, reminder, event, document
 *   { kind: 'type', text }
 *   { kind: 'press', key, modifiers, label? }   label: what the keys do ("Undo")
 *   { kind: 'click', button, count }
 *   { kind: 'play', query, service }    service: spotify | youtube | null (the default)
 *   { kind: 'search', query, site }     site: web | youtube | spotify
 *   { kind: 'shortcut', name }          a Shortcuts shortcut (macOS)
 *   { kind: 'jester', op }              Jester's own: calibrate, settings
 *   { kind: 'cancel' } · { kind: 'unknown', text }
 */

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "thirty five", "35", "a hundred", "100%" → a number, or null. */
export function numberFrom(text) {
  const words = String(text).toLowerCase().replace(/%/g, ' ').replace(/-/g, ' ').trim().split(/\s+/).filter((word) => word && word !== 'percent' && word !== 'and');
  if (words.length === 1 && /^\d+$/.test(words[0])) return Number(words[0]);
  if (!words.length) return null;
  let total = 0;
  for (const word of words) {
    if (UNITS.includes(word)) total += UNITS.indexOf(word);
    else if (TENS[word]) total += TENS[word];
    else if (word === 'hundred') total = (total || 1) * 100;
    else if (word === 'a' || word === 'an') continue;
    else return null;
  }
  return total;
}

/** Jaro–Winkler similarity, 0–1: forgiving of the letters speech gets wrong. */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array(a.length).fill(false);
  const matchedB = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = matchedB[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const plainName = (text) => String(text).toLowerCase().replace(/^the\s+/, '').replace(/\s+app$/, '').trim();
const squash = (text) => plainName(text).replace(/[^a-z0-9]/g, '');
/** How alike a heard name must be to an app's: "spot of fire" still finds Spotify. */
const APP_MATCH = 0.82;

/** How well a heard name fits an app's: the whole name, its start, its last words, or near enough. */
function nameScore(heard, name) {
  const wanted = squash(heard);
  const candidate = squash(name);
  if (!wanted || !candidate) return 0;
  if (candidate === wanted) return 2;
  // "Spotify and play Gunna" is two steps, not a long way of saying Spotify.
  if (/\b(?:and|then)\b/.test(plainName(heard))) return 0;
  if ((wanted.length >= 3 && candidate.startsWith(wanted)) || wanted.startsWith(candidate)) return 1.5;
  // "chrome" for Google Chrome, "settings" for System Settings, "word" for Microsoft Word.
  if (` ${plainName(name).replace(/[^a-z0-9]+/g, ' ')}`.endsWith(` ${plainName(heard).replace(/[^a-z0-9]+/g, ' ')}`)) return 1.3;
  return jaroWinkler(wanted, candidate);
}

/** The app a heard name means, or null. `apps`: names, e.g. "Visual Studio Code". */
export function matchApp(heard, apps = []) {
  let best = null;
  for (const name of apps) {
    const score = nameScore(heard, name);
    if (score >= APP_MATCH && (!best || score > best.score || (score === best.score && name.length < best.name.length))) best = { name, score };
  }
  return best?.name || null;
}

const MODIFIER_WORDS = { command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl', option: 'alt', alt: 'alt', shift: 'shift', function: 'fn', fn: 'fn', windows: 'win', win: 'win', super: 'win' };
const KEY_WORDS = {
  enter: 'enter', return: 'enter', escape: 'escape', esc: 'escape', tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', delete: 'backspace', home: 'home', end: 'end', up: 'up', down: 'down', left: 'left', right: 'right',
  comma: 'comma', period: 'period', dot: 'period', slash: 'slash', backslash: 'backslash', semicolon: 'semicolon',
  quote: 'quote', apostrophe: 'quote', minus: 'minus', dash: 'minus', hyphen: 'minus', equals: 'equal', equal: 'equal',
  grave: 'grave', backtick: 'grave'
};
const TWO_WORD_KEYS = { 'page up': 'pageup', 'page down': 'pagedown', 'forward delete': 'delete', 'left bracket': 'leftbracket', 'right bracket': 'rightbracket' };

/** "command shift four", "control c", "page down", "f five" → { key, modifiers }, or null. */
export function spokenKeys(text) {
  let words = String(text).toLowerCase().replace(/[.,!?]/g, ' ').replace(/[+-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  words = words.filter((word) => !['the', 'key', 'keys', 'arrow', 'and', 'plus'].includes(word));
  const modifiers = [];
  while (words.length && MODIFIER_WORDS[words[0]]) {
    const modifier = MODIFIER_WORDS[words.shift()];
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const rest = words.join(' ');
  if (!rest) return null;
  let key = TWO_WORD_KEYS[rest] || KEY_WORDS[rest] || null;
  if (!key && /^[a-z0-9]$/.test(rest)) key = rest;
  if (!key && /^letter [a-z]$/.test(rest)) key = rest.at(-1);
  if (!key && UNITS.slice(0, 10).includes(rest)) key = String(UNITS.indexOf(rest));
  const fn = rest.match(/^f ?(\w+)$/);
  if (!key && fn) {
    const n = numberFrom(fn[1]);
    if (n >= 1 && n <= 20) key = `f${n}`;
  }
  return key ? { key, modifiers } : null;
}

const action = (id) => ({ kind: 'action', action: id });
const press = (label, key, ...modifiers) => ({ kind: 'press', key, modifiers, label });
/** ⌘ on a Mac, Ctrl elsewhere: the key the editing shortcuts share. */
const primary = (platform) => (platform === 'darwin' ? 'cmd' : 'ctrl');
const TO = '(?:(?:go|switch|move) to )?(?:the )?';

/** Fixed commands, matched against the whole normalised sentence; `make(platform, match)`. */
const PHRASES = [
  [/^(?:cancel|never ?mind|nothing|forget it)$/, () => ({ kind: 'cancel' })],
  [/^(?:open |show )?(?:the )?jester(?:'s)? settings$/, () => ({ kind: 'jester', op: 'settings' })],
  // Volume
  [/^(?:turn |set )?(?:the )?volume up$|^turn (?:it |the volume |the sound )?up(?: the (?:volume|sound))?$|^louder$/, () => action('VOLUME_UP')],
  [/^(?:turn |set )?(?:the )?volume down$|^turn (?:it |the volume |the sound )?down(?: the (?:volume|sound))?$|^(?:quieter|softer)$/, () => action('VOLUME_DOWN')],
  [/^(?:max(?:imum)?|full) volume$/, () => ({ kind: 'volume', level: 100 })],
  [/^(?:un)?mute(?: (?:the )?(?:sound|volume|audio|computer))?$/, () => action('MUTE_TOGGLE')],
  // Media
  [/^(?:play|pause|resume|stop)(?: (?:the )?(?:music|song|video|playback|track))$|^(?:play|pause|resume)$|^play (?:some |my )music$/, () => action('PLAY_PAUSE')],
  [/^(?:next|skip)(?: (?:the |this )?(?:song|track))?$|^skip (?:this|the) (?:song|track)$/, () => action('MEDIA_NEXT')],
  [/^(?:previous|last)(?: (?:song|track))?$|^go back (?:a|one) (?:song|track)$/, () => action('MEDIA_PREV')],
  [/^(?:turn (?:the )?)?brightness up$|^brighter$/, () => action('BRIGHTNESS_UP')],
  [/^(?:turn (?:the )?)?brightness down$|^(?:dimmer|darker)$/, () => action('BRIGHTNESS_DOWN')],
  // Tabs and windows, before "open"/"close" take the rest
  [/^(?:open )?(?:a )?new tab$/, () => action('TAB_NEW')],
  [/^close (?:this |the )?tab$/, () => action('TAB_CLOSE')],
  [/^reopen (?:the )?(?:last |closed )*tab$/, () => action('TAB_REOPEN')],
  [new RegExp(`^${TO}next tab$`), () => action('TAB_NEXT')],
  [new RegExp(`^${TO}previous tab$`), () => action('TAB_PREV')],
  [/^(?:open )?(?:a )?new window$/, (platform) => press('New window', 'n', primary(platform))],
  [/^close (?:this |the )?window$/, (platform) => (platform === 'darwin' ? press('Close window', 'w', 'cmd') : press('Close window', 'f4', 'alt'))],
  [/^(?:go |enter |make it |toggle )?full ?screen$/, () => action('FULLSCREEN_TOGGLE')],
  [/^(?:exit|leave|get out of) full ?screen$/, () => action('EXIT_FULLSCREEN')],
  // Editing, in any app
  [/^undo(?: that)?$/, (platform) => press('Undo', 'z', primary(platform))],
  [/^redo(?: that)?$/, (platform) => (platform === 'darwin' ? press('Redo', 'z', 'cmd', 'shift') : press('Redo', 'y', 'ctrl'))],
  [/^copy(?: (?:that|this|it))?$/, (platform) => press('Copy', 'c', primary(platform))],
  [/^paste(?: (?:that|this|it))?$/, (platform) => press('Paste', 'v', primary(platform))],
  [/^cut(?: (?:that|this|it))?$/, (platform) => press('Cut', 'x', primary(platform))],
  [/^select (?:all|everything)$/, (platform) => press('Select all', 'a', primary(platform))],
  [/^save(?: (?:this|it|the file))?$/, (platform) => press('Save', 's', primary(platform))],
  [/^find(?: (?:on |in )?(?:this |the )?page)?$/, (platform) => press('Find', 'f', primary(platform))],
  [/^(enter|return|escape|backspace|delete)$/, (_platform, found) => ({ kind: 'press', ...spokenKeys(found[1]) })],
  // Pages
  [/^(?:go )?back$/, () => action('HISTORY_BACK')],
  [/^(?:go )?forward$/, () => action('HISTORY_FORWARD')],
  [/^(?:reload|refresh)(?: (?:the |this )?page)?$/, () => action('RELOAD')],
  [/^scroll up$/, () => action('SCROLL_UP')],
  [/^scroll down$/, () => action('SCROLL_DOWN')],
  [/^page (up|down)$/, (_platform, found) => press(`Page ${found[1]}`, `page${found[1]}`)],
  [/^(?:go |scroll |jump )?(?:to )?(?:the )?top(?: of the page)?$/, () => action('PAGE_TOP')],
  [/^(?:go |scroll |jump )?(?:to )?(?:the )?bottom(?: of the page)?$/, () => action('PAGE_BOTTOM')],
  // The desktop
  [/^(?:show|go to) (?:me )?(?:the )?desktop$/, () => action('SHOW_DESKTOP')],
  [/^mission control$|^show (?:me )?(?:all )?(?:the |my )?windows$|^task view$/, () => action('SHOW_ALL_WINDOWS')],
  [new RegExp(`^${TO}next desktop$|^desktop (?:to the )?right$`), () => action('DESKTOP_RIGHT')],
  [new RegExp(`^${TO}previous desktop$|^desktop (?:to the )?left$`), () => action('DESKTOP_LEFT')],
  [/^(?:take |grab )?(?:a )?screen ?shot$/, () => action('SCREENSHOT')],
  [/^lock(?: (?:the |my )?(?:screen|computer|mac|laptop|pc))?$/, () => action('LOCK_SCREEN')],
  [new RegExp(`^${TO}next (?:app|window)$|^switch (?:apps?|windows?)$`), () => action('APP_NEXT')],
  [new RegExp(`^${TO}(?:previous|last) (?:app|window)$`), () => action('APP_PREV')],
  // The pointer
  [/^(?:left )?click(?: (?:here|that|it|this))?$/, () => ({ kind: 'click', button: 'left', count: 1 })],
  [/^double click(?: (?:here|that|it|this))?$/, () => ({ kind: 'click', button: 'left', count: 2 })],
  [/^right click(?: (?:here|that|it|this))?$/, () => ({ kind: 'click', button: 'right', count: 1 })],
  [/^calibrate(?: (?:my |the )?(?:eyes|pointer|cursor))?$/, () => ({ kind: 'jester', op: 'calibrate' })]
];

/** What a level can be called besides a number. */
const LEVEL_WORDS = { max: 100, maximum: 100, full: 100, half: 50, off: 0 };

/** "A new note", "new email", "take a note": something new, in the app it belongs to. */
const NEW_ITEM = /^(?:(?:open|create|make|start|write|compose) )?(?:me )?(?:a |an )?new (note|e ?mail|mail|message|text(?: message)?|reminder|(?:calendar )?event|document|doc|file)$|^(?:take|make|create) a (note)$/;
const ITEM_NAMES = { note: 'note', email: 'email', 'e mail': 'email', mail: 'email', message: 'message', text: 'message', 'text message': 'message', reminder: 'reminder', event: 'event', 'calendar event': 'event', document: 'document', doc: 'document', file: 'document' };
const SERVICES = { spotify: 'spotify', youtube: 'youtube', google: 'web', web: 'web', 'the web': 'web' };

/** What to look for, without the words around it: "a Gunna song" → "gunna". */
function searchTerms(text) {
  return text
    .replace(/^(?:(?:me|some|a|an|the|something|songs?|music|tracks?) (?:by |from )?)+/, '')
    .replace(/ (?:songs?|music|tracks?)$/, '')
    .trim();
}

/** Dictation takes the rest of a sentence, whatever is in it. */
const DICTATION = /^\W*(?:please\s+)?(type|write|say)\b[\s,:]*(.+)$/i;

/** Polite padding and the recognizer's punctuation, gone: "Please, mute." → "mute". */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/,/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hey |ok |okay )?jester (?!settings$)/, '')
    .replace(/^(?:please |can you |could you |would you )+/, '')
    .replace(/ please$/, '')
    .trim();
}

/**
 * @param {string} transcript  what the recognizer heard
 * @param {object} [context]
 * @param {string[]} [context.apps]  installed app names (macOS)
 * @param {string} [context.platform]
 */
export function parseCommand(transcript, { apps = [], platform = 'darwin' } = {}) {
  const original = String(transcript || '').trim();
  const text = normalize(original);
  if (!text) return { kind: 'unknown', text: original };

  // Typed text keeps its own case and punctuation, from the original. "Write
  // a new note" is a new note, not those words; "type" is always typing.
  const fresh = text.match(NEW_ITEM);
  const dictated = original.match(DICTATION);
  if (dictated && (dictated[1].toLowerCase() === 'type' || !fresh)) return { kind: 'type', text: dictated[2].trim() };
  if (fresh) return { kind: 'new', item: ITEM_NAMES[fresh[1] || fresh[2]] };

  for (const [pattern, make] of PHRASES) {
    const found = text.match(pattern);
    if (found) return make(platform, found);
  }

  const play = text.match(/^play (.+?)(?: (?:on|in|from) (spotify|youtube))?$/);
  if (play && searchTerms(play[1])) return { kind: 'play', query: searchTerms(play[1]), service: SERVICES[play[2]] || null };

  const searchOn = text.match(/^search (youtube|google|spotify|the web) for (.+)$/);
  if (searchOn) return { kind: 'search', query: searchOn[2], site: SERVICES[searchOn[1]] };
  const searchFor = text.match(/^(?:search|google|look up)(?: for| up)? (.+?)(?: (?:on|in) (youtube|google|spotify|the web))?$/);
  if (searchFor) return { kind: 'search', query: searchFor[1], site: SERVICES[searchFor[2]] || 'web' };

  const volume = text.match(/^(?:(?:set|turn|change|put) )?(?:the )?volume (?:to |at )?(.+)$/);
  if (volume) {
    const level = LEVEL_WORDS[volume[1]] ?? numberFrom(volume[1]);
    if (level !== null && level >= 0 && level <= 100) return { kind: 'volume', level };
  }

  const keys = text.match(/^(?:press|hit|push) (.+)$/);
  if (keys) {
    const parsed = spokenKeys(keys[1]);
    return parsed ? { kind: 'press', ...parsed } : { kind: 'unknown', text: original };
  }

  const shortcut = text.match(/^run (?:the |my )?shortcut (?:called |named )?(.+)$/);
  if (shortcut && platform === 'darwin') return { kind: 'shortcut', name: shortcut[1] };

  const minimize = text.match(/^minimi[sz]e(?: (?:this |the )?window)?(?: (.+))?$/);
  if (minimize) {
    const heard = minimize[1];
    return { kind: 'minimize', app: heard ? matchApp(heard, apps) || heard : null, heard: heard || null };
  }

  const verbs = [
    [/^(?:open|launch|start|run) (.+)$/, 'open'],
    [/^(?:switch to|go to|bring up|show me|show) (.+)$/, 'open'],
    [/^(?:quit|close|exit) (.+)$/, 'quit']
  ];
  for (const [pattern, kind] of verbs) {
    const found = text.match(pattern);
    if (!found) continue;
    const heard = found[1];
    const app = matchApp(heard, apps);
    // On Windows there is no list to check against; the Start menu finds it.
    if (app || (platform === 'win32' && kind === 'open')) return { kind, app: app || heard, heard };
  }
  return { kind: 'unknown', text: original };
}

/** Where a sentence may be cut into steps: "…, then …", "… and then …", "… and …". */
const JOINS = /,?\s+(?:and\s+then|then|and)\s+/gi;

const known = (step) => step.kind !== 'unknown' && step.kind !== 'cancel';

/**
 * A sentence as the steps it asks for, in order: "open Notes and write hello"
 * is two. A cut is made only where every piece is a command, and never inside
 * dictation, which takes the rest ("type salt and pepper"). Failing that, the
 * sentence is one command; failing that too, the steps as far as they were
 * understood, with the rest `unknown`, so it can be named.
 */
export function parseSequence(transcript, context = {}) {
  const original = String(transcript || '').trim();
  let partial = null;
  for (const join of original.matchAll(JOINS)) {
    const first = parseCommand(original.slice(0, join.index), context);
    if (['unknown', 'type', 'cancel'].includes(first.kind)) continue;
    const rest = parseSequence(original.slice(join.index + join[0].length), context);
    if (rest.every(known)) return [first, ...rest];
    partial ||= [first, ...rest];
  }
  const whole = parseCommand(original, context);
  return whole.kind === 'unknown' && partial ? partial : [whole];
}
