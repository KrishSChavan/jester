/**
 * A window that asks who is there: which profile, which account. Only the user can say, so a press on one of its
 * choices is theirs to settle, whatever the model was told about asking. 2026-11-21: Hulu's profile picker was met
 * with three clicks on the wrong profile; the extension holds such a click back on a page (chooser.js), and until
 * this, with the same page worked by hand in Chrome or a profile picker in an app of the Mac's own, only a sentence
 * of the prompt stood between a model and a guess. The local model keeps such a sentence about half the time.
 *
 * chooser.js knows a chooser by its controls; this gives it a window's controls in the shape it reads. A window has
 * no address to say whose it is, so that's read from its title (a site sites.js lists), or is the app itself when
 * the app is no browser.
 *
 * Pure: an action and the snapshot it was chosen from in; the choices, and what they're a choice of, out.
 */

import { chooserPick, chooserStep, siteName } from '../../../../jester-extension/src/common/chooser.js';
import { SITES } from '../../../../jester-extension/src/common/sites.js';
import { parseShortcut } from '../os-actions.js';
import { elementById } from './screen.js';

/** Apps whose window is a page's: the window's title says where it is, and the app's own name says nothing of it. */
const BROWSERS = /^(?:google chrome(?: (?:beta|dev|canary))?|chrome|chromium|safari(?: technology preview)?|firefox|microsoft edge|edge|msedge|arc|brave browser|brave|opera|vivaldi|orion|duckduckgo|zen(?: browser)?)$/i;
/** Words of what a kept answer is about that say nothing of where: "Which Hulu profile" is about Hulu. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'which', 'what', 'whose', 'who', 'profile', 'profiles', 'account', 'accounts', 'user', 'for', 'on', 'of', 'in', 'to', 'use']);
/** The shortest name of a listed site looked for in a title: "x" is in too many. */
const LEAST_NAME = 3;

const wordsOf = (text) => String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const holds = (words, run) => run.length > 0 && words.some((_, at) => run.every((word, index) => words[at + index] === word));
/** The longest names first: "YouTube Music" is no page of YouTube's. */
const LISTED = SITES.filter((site) => site.key.length >= LEAST_NAME).sort((a, b) => b.key.length - a.key.length);

/**
 * Where a window is, as far as it says: its title without the app's own name ("Hulu - Google Chrome" is Hulu's, and
 * not Google's), whose it is by name ("Hulu", "Netflix"; '' for a page of a site that isn't listed), and the words
 * a kept answer about it would have.
 */
function placeOf(snapshot) {
  const app = String(snapshot?.app?.name || '').trim();
  const browser = BROWSERS.test(app);
  const title = String(snapshot?.window?.title || '');
  const own = app ? title.replace(new RegExp(app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ') : title;
  const said = wordsOf(own);
  const listed = browser ? LISTED.find((site) => holds(said, wordsOf(site.key))) : null;
  return { title: own.replace(/\s+/g, ' ').trim(), name: browser ? (listed ? siteName(listed.url) : '') : app, words: browser ? said : [...said, ...wordsOf(app)] };
}

/** The control a step presses: a click's, or the focused one under Enter or Space. null for a step that presses none. */
function pressed(action, snapshot) {
  if (action?.action === 'click') return action.button === 'right' || action.id === undefined ? null : action.id;
  if (action?.action !== 'press') return null;
  const plan = parseShortcut(action.keys);
  if (!plan || plan.modifiers.length || !['enter', 'space'].includes(plan.key)) return null;
  return (snapshot?.elements || []).find((element) => element.focused)?.id ?? null;
}

/**
 * Whether a step presses one of the choices of who is there, on the screen it was chosen from.
 * @param {object} action  validated
 * @param {object} snapshot
 * @param {string} [goal]  the user's words, with what they were taken to mean
 * @returns {null | {target:number, named:{id:number, ids:number[], name:string}} | {target:number, named:null,
 *   choices:{id:number, ids:number[], name:string}[], question:string, options:string[], about:string, here:string[]}}
 *   null: no such choice, carry on. named: the user's words name this one of them, whichever was pressed. Else
 *   nothing they said does: `choices` (and the first four as `options`), the `question` to put to them, what it is
 *   `about` for remembering ("Hulu profile"; '' when the window doesn't say whose it is), and the words a kept answer
 *   about `here` would have.
 */
export function whoIsAsked(action, snapshot, goal = '') {
  const target = pressed(action, snapshot);
  if (target === null || !elementById(snapshot, target)) return null;
  const place = placeOf(snapshot);
  const elements = (snapshot?.elements || []).map((element) => ({ id: String(element.id), role: element.role, name: String(element.label ?? ''), ...(element.disabled ? { disabled: true } : {}) }));
  const step = chooserStep({ elements, targetId: String(target), goal, title: place.title });
  if (!step) return null;
  if (step.do === 'click') return { target, named: { id: Number(step.elementId), ids: [Number(step.elementId)], name: step.name } };
  // With no address given, chooser.js's `about` is the kind alone: "profile", "account".
  const what = [place.name, step.about].filter(Boolean).join(' ');
  return {
    target,
    named: null,
    choices: step.choices.map((choice) => ({ id: Number(choice.id), ids: choice.ids.map(Number), name: choice.name })),
    question: `Which ${what} should I use?`,
    options: step.options,
    about: place.name ? what : '',
    here: place.words
  };
}

/**
 * The one of the choices an answer means, or null (chooser.js chooserPick): by its name, or a word only it has.
 * `here`: the answer was given to these very choices, so its place counts too ("the second one"), and a name as the
 * microphone heard it ("Chris" for Krish). Said of something else, or kept from another day, "the first one" is no
 * profile.
 */
export function whoMeant(fork, answer, { here = false } = {}) {
  return chooserPick(fork.choices, answer, here ? {} : { strict: true, plainly: true });
}

/**
 * The choice the user's kept answers come to: the first of them (they come newest first) that is about this window
 * and names one of the choices as they are now. "Hulu profile: Krish" is about a window of Hulu's; "Google account:
 * Krish" is not, though both have a Krish.
 * @param {object} fork  whoIsAsked's, with choices
 * @param {string[]} ways  lines such as "Hulu profile: Krish"
 */
export function whoKept(fork, ways) {
  for (const way of Array.isArray(ways) ? ways : []) {
    const split = /^([^:]{1,60}):\s*(\S.*)$/.exec(String(way ?? '').replace(/\s+/g, ' ').trim());
    const subject = split ? wordsOf(split[1]).filter((word) => !FILLER.has(word)) : [];
    if (!subject.length || !subject.every((word) => fork.here.includes(word))) continue;
    const choice = whoMeant(fork, split[2]);
    if (choice) return choice;
  }
  return null;
}
