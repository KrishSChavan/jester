/**
 * Where a command belongs: in the computer's own apps, or in the browser the
 * extension is in. Decided by what the command is, never by which app happens
 * to be in front.
 *
 * 2026-11-21: "text Dad: how are you doing?" came from the conversation as
 * "open Messages and start a text to Dad saying: how are you doing?", and went
 * to Chrome whole, because Chrome was in front and half of it was no command
 * the matcher knew (voice-runner.js). The extension can only use websites, so
 * it opened messages.google.com. What's in front says where the user is
 * looking: it says where a task belongs only when the task itself doesn't.
 *
 * Pure: the words, how the matcher read them and the apps there are, in; where
 * it belongs and why, out.
 */

import { browserish } from './chrome-link.js';

/** The browsers the extension can be in (link-host.js writes a relay for each): opening one is no sign of a task for an app. */
const LINKED_BROWSER = /^(?:google\s+)?chrom(?:e|ium)(?:\s+(?:beta|canary|dev))?$|^brave(?:\s+browser)?$|^(?:microsoft\s+)?edge$|^arc$|^vivaldi$/i;
/** Steps that name an app of the computer's to do something to. */
const APP_STEPS = new Set(['open', 'quit', 'minimize', 'place']);
/**
 * Apps whose names are everyday words: "work from home", "what's on TV", "the news on this page" name no app. They
 * count only when called an app ("in the Home app"), or opened by name, which the matcher's steps say.
 */
const EVERYDAY = new Set(['home', 'news', 'stocks', 'weather', 'clock', 'tips', 'tv', 'books', 'find my', 'preview', 'passwords', 'games']);
/** Before an app's name, these make it where something is done: "in Notes", "on WhatsApp", "using Mail". */
const AT = '(?:in|on|to|into|onto|with|using|via|through|from|inside)';

/**
 * Texting and calling someone: the computer's, in its own Messages or FaceTime. "Text", "message" and "call" are
 * also things on a page ("select the text", "the message box", "call it a day"), so they count only as something
 * done to a person: the verb first or after a joining word, and not followed by a word that says otherwise.
 */
const NOT_SOMEONE = '(?:on|in|at|of|from|to|for|that|this|it|is|was|and|or|here|there|above|below)\\b';
const NOT_TEXTED = `(?:${NOT_SOMEONE}|(?:size|box|boxes|field|fields|area|color|colour|bigger|smaller|larger|formatting|editor|file|files|document|documents)\\b)`;
const NOT_MESSAGED = `(?:${NOT_SOMEONE}|(?:board|boards|settings|history|requests?|center|centre|apps?|notifications?|box|field)\\b)`;
const NOT_CALLED = `(?:${NOT_SOMEONE}|an?\\s+(?:uber|lyft|taxi|cab|ride|car)\\b)`;
const TO_SOMEONE = new RegExp(
  '(?:^|\\b(?:and|then|to|please|you|just)\\s+)(?:' +
    '(?:send|shoot|write|start|compose|draft)\\s+(?:(?:a|an|another|my|the)\\s+)?(?:new\\s+)?(?:quick\\s+)?(?:text|texts|imessage|sms|message)(?:\\s+message)?\\b' +
    `|(?:send|shoot)\\s+(?!${NOT_SOMEONE})(?:my\\s+)?[\\p{L}'’]+\\s+(?:a|an)\\s+(?:quick\\s+)?(?:text|imessage|sms|message)\\b` +
    // The recognizer hears a pause after the verb as a comma: "text, dad, how are you doing?"
    `|(?:text|imessage)[\\s,:]+(?!${NOT_TEXTED})\\S` +
    `|message[\\s,:]+(?!${NOT_MESSAGED})(?:my\\s+)?\\p{L}` +
    `|(?:call|facetime|dial)[\\s,:]+(?!${NOT_CALLED})(?:my\\s+|up\\s+)?[\\p{L}\\d]` +
    ')',
  'iu'
);
/**
 * Services people message through that are sites too. One named, with no app of that name here, makes a message
 * that service's, not Messages': it's left to whoever knows the site. So do the words for a site's own messages.
 */
const WEB_SERVICE = /\b(?:whatsapp|instagram|insta|messenger|facebook|discord|slack|telegram|signal|linkedin|twitter|snapchat|teams|gmail|outlook|canvas|reddit|groupme|wechat|google\s+(?:chat|voice|messages))\b/i;
const SITE_MESSAGE = /\b(?:inbox|dms?|direct\s+messages?|comments?|thread|post|email|e-mail)\b/i;
/** The computer's own files and settings. */
const ITS_OWN = /\b(?:finder|(?:my|the)\s+(?:downloads|desktop|documents)(?:\s+folder)?|system\s+(?:settings|preferences)|wi-?fi|bluetooth|airdrop|brightness|dark\s+mode|light\s+mode|do\s+not\s+disturb|night\s+shift|screen\s?shot|screen\s+saver|wallpaper|the\s+dock|menu\s+bar|trash|battery)\b/i;

const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/** Whether an app of that name is one of the browsers the extension can be in. */
export const linkedBrowser = (name) => LINKED_BROWSER.test(String(name ?? '').trim());

/** An app named in the words as the place to do something: "in Notes", "on the Messages app". Never a linked browser. */
function namedApp(text, apps) {
  for (const name of apps) {
    const app = String(name ?? '').trim();
    if (app.length < 2 || linkedBrowser(app)) continue;
    if (new RegExp(`\\b${AT}\\s+(?:the\\s+|my\\s+)?${escaped(app)}\\s+app\\b`, 'i').test(text)) return app;
    if (EVERYDAY.has(app.toLowerCase())) continue;
    if (new RegExp(`\\b${AT}\\s+(?:the\\s+|my\\s+)?${escaped(app)}(?![\\p{L}\\d])`, 'iu').test(text)) return app;
  }
  return '';
}

/**
 * @param {string} text  a command, or the user's own words
 * @param {object} [about]
 * @param {object[]} [about.steps]  voice-commands.js parseSequence's reading of it
 * @param {string[]} [about.apps]  the names of the apps installed or running here
 * @returns {{where:'computer'|'browser'|'', why:string}}  where: '' when the command itself doesn't say. why: 'app'
 *   (it does something to an app by name), 'place' (an app is named as where to do it), 'kind' (texting, calling,
 *   the computer's files or settings), 'web' (it names a site, a tab, a bookmark or the browser), or ''
 */
export function belongs(text, { steps = [], apps = [] } = {}) {
  const words = String(text ?? '').replace(/[‘’]/g, "'").trim();
  if (!words) return { where: '', why: '' };
  if (steps.some((step) => (APP_STEPS.has(step?.kind) && step.app && !linkedBrowser(step.app)) || step?.kind === 'new' || step?.kind === 'shortcut')) return { where: 'computer', why: 'app' };
  if (namedApp(words, apps)) return { where: 'computer', why: 'place' };
  // Before the web's words: what's to be said to someone may hold any of them ("text Dad the link").
  if (TO_SOMEONE.test(words)) {
    const service = WEB_SERVICE.exec(words)?.[0] || '';
    const elsewhere = (service && !apps.some((app) => same(app, service))) || SITE_MESSAGE.test(words);
    if (!elsewhere) return { where: 'computer', why: 'kind' };
  }
  if (browserish(words)) return { where: 'browser', why: 'web' };
  if (ITS_OWN.test(words)) return { where: 'computer', why: 'kind' };
  return { where: '', why: '' };
}

/**
 * Where a command the conversation handed on belongs, from the command and the user's own words for it.
 * A command that does something to an app by name is the computer's whatever else is said. Then the user's own
 * words count before the conversation's rewording of them: a site in the command that they never named is the
 * model's idea, not theirs.
 * @param {string} text  the command
 * @param {{said?:string, steps?:object[], apps?:string[]}} [about]  said: the user's own words, when `text` is the
 *   conversation's command for them
 * @returns {{where:'computer'|'browser'|'', why:string}}
 */
export function routeOf(text, { said = '', steps = [], apps = [] } = {}) {
  const command = belongs(text, { steps, apps });
  if (command.why === 'app') return command;
  const theirs = said ? belongs(said, { apps }) : { where: '', why: '' };
  return theirs.where ? theirs : command;
}
