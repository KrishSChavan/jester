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
 *   { kind: 'place', app, heard, where, screen }   a window moved: where left | right | full |
 *                                       center | fullscreen, screen current | laptop | monitor | other;
 *                                       app null: the window in front
 *   { kind: 'teach', phrase, then }     "when I say <phrase>, <then>": the user's own command
 *   { kind: 'forget', phrase }          a taught phrase (or a learned task) forgotten
 *   { kind: 'jester', op }              Jester's own: calibrate, settings, sleep
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
  // Jester's own sleep, before "go to" takes it for an app. The computer's isn't this.
  [/^(?:go (?:back )?to sleep|sleep(?: now)?|go to bed|take a nap|put (?:jester|yourself) to sleep|pause (?:jester|yourself))$/, () => ({ kind: 'jester', op: 'sleep' })],
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
const SERVICES = { spotify: 'spotify', youtube: 'youtube', google: 'web', web: 'web', 'the web': 'web', 'the internet': 'web', online: 'web' };

/** What to look for, without the words around it: "a Gunna song" → "gunna". */
function searchTerms(text) {
  return text
    .replace(/^(?:(?:me|some|a|an|the|something|songs?|music|tracks?) (?:by |from )?)+/, '')
    .replace(/ (?:songs?|music|tracks?)$/, '')
    .trim();
}

/** Dictation takes the rest of a sentence, whatever is in it. */
const DICTATION = /^\W*(?:please\s+)?(type|write|say)\b[\s,:]*(.+)$/i;

/** "When I say focus mode, open Notes and put it on the left": the phrase, then what it does. */
const TEACH = /^\W*(?:(?:ok|okay|hey)\s+)?(?:jester\W+)?when(?:ever)? i say\s+["“']?(.+?)["”']?\s*,\s*(?:(?:then|please|you should)\s+)?(.+?)[.!]*$/i;
/** The same without a comma: where the phrase ends is found by what follows being a command. */
const TEACH_LOOSE = /^\W*(?:(?:ok|okay|hey)\s+)?(?:jester\W+)?when(?:ever)? i say\s+(.+?)[.!]*$/i;
const FORGET = /^(?:forget|delete|remove|unlearn) (?:the |my )?(?:shortcut|command|phrase) (?:called |named |for )?(.+)$|^forget how to (.+)$/;
/** The longest phrase a teach without a comma may have. */
const PHRASE_WORDS = 4;

/** Ways to say where a window goes, or which screen, each made one word. Order matters: "full screen" before "screen". */
const PLACE_WORDS = [
  [/\bfull ?screen\b/g, ' fullscreen '],
  [/\bmaximi[sz]e[ds]?\b|\bfull size\b|\bfill (?:the )?screen\b/g, ' full '],
  [/\b(?:the )?(?:other|another|second|next) (?:screen|monitor|display)\b/g, ' other '],
  [/\b(?:(?:big|bigger|large|larger|external) (?:screen|monitor|display)|external (?:monitor|display)|monitor)\b/g, ' monitor '],
  [/\b(?:laptop|macbook|built ?in)(?: (?:screen|display))?\b|\b(?:small|smaller|little) (?:screen|display)\b/g, ' laptop '],
  [/\b(?:middle|centre)\b/g, ' center ']
];
const WHERE = new Set(['left', 'right', 'full', 'fullscreen', 'center']);
const SCREENS = new Set(['laptop', 'monitor', 'other']);
/** Everything else a placement may say. */
const PLACE_FILLER = new Set(['put', 'move', 'snap', 'throw', 'send', 'place', 'make', 'set', 'open', 'launch', 'drag', 'to', 'on', 'onto', 'in', 'into', 'at', 'over', 'the', 'my', 'of', 'and', 'a', 'side', 'half', 'screen', 'window', 'app', 'its']);
const THE_FRONT = new Set(['it', 'this', 'that']);
const PLACE_VERB = /^(?:put|move|snap|throw|send|place|make|maximi[sz]e|center|centre)\b/;
/** A placement's verb and the word straight after it, where an app not running is named on Windows. */
const WIN_PLACE = /^(?:put|move|snap|place|maximi[sz]e|open|launch)\s+(\S+)/;
/** What comes before a thing, not an app: "move the meeting to the right". */
const ARTICLES = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'it', 'all', 'some', 'every']);
/** Words of a browser's own commands, never an app to place ("open a new tab on the left"). */
const NOT_APPS = new Set(['new', 'tab', 'tabs', 'window', 'windows', 'page', 'click']);
const nameWords = (name) => plainName(name).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The app a heard name is, strictly: its whole name, or its last words
 * ("chrome" for Google Chrome) — never a guess from a few letters or a near
 * spelling, which suits opening an app but not finding one in a sentence.
 */
export function matchAppStrictly(heard, apps = []) {
  const wanted = nameWords(heard);
  if (!wanted) return null;
  const fits = apps.filter((name) => nameWords(name) === wanted || ` ${nameWords(name)}`.endsWith(` ${wanted}`));
  return fits.sort((a, b) => a.length - b.length)[0] || null;
}

/** An app named in full in a sentence, longest name first: it, and the sentence without it. */
function appNamedIn(text, apps) {
  for (const name of [...apps].sort((a, b) => b.length - a.length)) {
    const words = nameWords(name);
    if (words.length < 3 || !` ${text} `.includes(` ${words} `)) continue;
    return { app: name, heard: words, rest: ` ${text} `.replace(` ${words} `, ' ').trim() };
  }
  return null;
}

/**
 * "Put Chrome on the left", "Safari on my monitor", "maximize Notes", "move
 * this to the other screen": everything but the app, one place and one screen
 * must be filler, so "what's on my monitor" stays someone else's. An app
 * named in full is the app, place words in its name and all, so "open
 * Activity Monitor" is an app opened, not one moved to a monitor.
 */
function parsePlace(text, apps, platform, listed = false) {
  const named = appNamedIn(text, apps);
  let said = ` ${named ? named.rest : text} `;
  for (const [pattern, word] of PLACE_WORDS) said = said.replace(pattern, word);
  const words = said.trim().split(/\s+/).filter(Boolean);
  const where = words.filter((word) => WHERE.has(word));
  const screen = words.filter((word) => SCREENS.has(word));
  if (where.length > 1 || screen.length > 1 || !(where.length || screen.length)) return null;
  const rest = words.filter((word) => !WHERE.has(word) && !SCREENS.has(word) && !PLACE_FILLER.has(word));
  const place = { kind: 'place', where: where[0] || 'center', screen: screen[0] || 'current' };
  if (named) return rest.length ? null : { ...place, app: named.app, heard: named.heard };
  // Nothing named: the window in front, if the sentence plainly moves one ("snap it left", not "left").
  if (rest.every((word) => THE_FRONT.has(word))) return rest.length || PLACE_VERB.test(text) ? { ...place, app: null, heard: null } : null;
  const heard = rest.join(' ');
  const app = matchAppStrictly(heard, apps);
  if (app) return { ...place, app, heard };
  // Windows knows only the apps running: one that isn't, placed in so many words, is opened from the Start menu.
  // "In so many words": a move verb and straight away a name ("put Notepad on the left"), not "move the meeting…".
  const object = text.match(WIN_PLACE)?.[1];
  const plainly = listed || (object && !ARTICLES.has(object));
  if (platform === 'win32' && plainly && rest.length <= 3 && !rest.some((word) => NOT_APPS.has(word))) return { ...place, app: heard, heard };
  return null;
}

/** "When I say …": the phrase and what it does; without a comma, cut where the rest is a command. */
function parseTeach(original, context) {
  const taught = original.match(TEACH);
  if (taught) return { kind: 'teach', phrase: taught[1].trim(), then: taught[2].trim() };
  const loose = original.match(TEACH_LOOSE);
  if (!loose) return null;
  const words = loose[1].split(/\s+/);
  for (let cut = 1; cut <= Math.min(PHRASE_WORDS, words.length - 1); cut++) {
    const then = words.slice(cut).join(' ');
    if (parseSequence(then, context).every(known)) return { kind: 'teach', phrase: words.slice(0, cut).join(' '), then };
  }
  return { kind: 'unknown', text: original };
}

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
 * @param {boolean} [context.listed]  one of several moves listed with commas: plainly a placement
 * @param {boolean} [context.talking]  said in conversation, where "write me a poem" and "say something funny" aren't dictation; "type" still is
 */
export function parseCommand(transcript, { apps = [], platform = 'darwin', listed = false, talking = false } = {}) {
  const original = String(transcript || '').trim();
  const text = normalize(original);
  if (!text) return { kind: 'unknown', text: original };

  // A command being taught holds others ("…, type hello"): it comes first.
  const taught = parseTeach(original, { apps, platform });
  if (taught) return taught;
  const forget = text.match(FORGET);
  if (forget) return { kind: 'forget', phrase: forget[1] || forget[2] };

  // Typed text keeps its own case and punctuation, from the original. "Write
  // a new note" is a new note, not those words; "type" is always typing.
  const fresh = text.match(NEW_ITEM);
  const dictated = original.match(DICTATION);
  if (dictated && (dictated[1].toLowerCase() === 'type' || (!fresh && !talking))) return { kind: 'type', text: dictated[2].trim() };
  if (fresh) return { kind: 'new', item: ITEM_NAMES[fresh[1] || fresh[2]] };

  for (const [pattern, make] of PHRASES) {
    const found = text.match(pattern);
    if (found) return make(platform, found);
  }

  const play = text.match(/^play (.+?)(?: (?:on|in|from) (spotify|youtube))?$/);
  if (play && searchTerms(play[1])) return { kind: 'play', query: searchTerms(play[1]), service: SERVICES[play[2]] || null };

  const searchOn = text.match(/^search (youtube|google|spotify|the web|the internet|online) for (.+)$/);
  if (searchOn) return { kind: 'search', query: searchOn[2], site: SERVICES[searchOn[1]] };
  const searchFor = text.match(/^(?:search|google|look up)(?: for| up)? (.+?)(?: (?:on|in) (youtube|google|spotify|the web|the internet))?$/);
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

  // Before "open": "open Chrome on my monitor" opens it there.
  const place = parsePlace(text, apps, platform, listed);
  if (place) return place;

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
  // "Chrome left, Terminal right": moves listed with commas, every one of them a move.
  if (/[,;]/.test(original)) {
    const moves = original.split(/\s*[,;]\s*|\s+(?:and\s+then|then|and)\s+/i).filter((part) => part.trim());
    const placed = moves.map((part) => parseCommand(part, { ...context, listed: true }));
    if (placed.length > 1 && placed.every((step) => step.kind === 'place')) return placed;
  }
  let partial = null;
  for (const join of original.matchAll(JOINS)) {
    const first = parseCommand(original.slice(0, join.index), context);
    // Dictation and a command being taught take the rest of the sentence.
    if (['unknown', 'type', 'cancel', 'teach'].includes(first.kind)) continue;
    const rest = parseSequence(original.slice(join.index + join[0].length), context);
    if (rest.every(known)) return [first, ...rest];
    partial ||= [first, ...rest];
  }
  const whole = parseCommand(original, context);
  return whole.kind === 'unknown' && partial ? partial : [whole];
}

/** What goes ahead without asking when overheard: the worst of these is a nuisance. Anything not listed asks. */
const UNASKED_KINDS = new Set(['action', 'volume', 'open', 'new', 'minimize', 'place', 'play', 'search', 'jester', 'cancel']);
const UNASKED_KEYS = new Set(['Copy', 'Select all', 'Find', 'Page up', 'Page down', 'New window', 'Undo', 'Redo']);
/** The same ⌘W as closing a window, which asks. */
const ASKED_ACTIONS = new Set(['TAB_CLOSE']);

/**
 * Whether a step should ask first when it comes off the always-on mic, where
 * anything saying the name can set it off. Typing, keys, quitting and clicks do.
 * @param {object} step  from parseSequence
 * @param {object} [context]
 * @param {string} [context.platform]
 * @param {(app:string) => boolean} [context.listed]  Windows: an unlisted name goes to the Start menu, and Enter
 */
export function asksFirst(step, { platform = 'darwin', listed = () => true } = {}) {
  if (step.kind === 'press') return !UNASKED_KEYS.has(step.label);
  if (step.kind === 'action') return ASKED_ACTIONS.has(step.action);
  if (step.kind === 'open' && platform === 'win32') return !listed(step.app);
  return !UNASKED_KINDS.has(step.kind);
}
