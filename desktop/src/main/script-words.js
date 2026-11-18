/**
 * The words that ask for a script's control, matched with no model, so "lights off" is done the moment it's said.
 * Each control's manifest lists phrases ("dim the {aim?} lights to {value}"): the whole sentence has to be one of
 * them, give or take "the", "my", "please" and his name, so a sentence that only mentions the lights is the model's
 * to make sense of. Pure.
 *
 *   {aim}    one of the manifest's aim choices, by label, value or its words ("bedside", "Krish's bedroom")
 *   {aim?}   the same, or nothing: then all of them
 *   {value}  a slider's number ("30", "thirty", "30 percent", "full") or one of a control's choices ("red")
 *
 * A phrase may come with its value fixed: {"say": "make the {aim?} lights warm", "value": 0}.
 */

import { aimChoice, choiceOf, sliderValue } from './script-manifest.js';
import { numberFrom } from './voice-commands.js';

/** Words that never change what's asked of a script. "All" too: no aim is all of them. */
const FILLER = new Set(['the', 'my', 'a', 'an', 'all', 'of', 'our', 'please', 'some', 'just']);
const LEADING = /^(?:(?:hey|ok|okay|so|and|um|uh|jester|please|can you|could you|would you|will you|can i get|i want|i'd like|go ahead and|let's)\s+)+/;
const TRAILING = /(?:\s+(?:please|thanks|thank you|now|for me|right now))+$/;
const ENDS = { full: 'max', max: 'max', maximum: 'max', highest: 'max', brightest: 'max', min: 'min', minimum: 'min', lowest: 'min', dimmest: 'min' };

/** What was said, as the matcher reads it: lower case, no punctuation, "%" as "percent", his name and please gone. */
export function plainWords(said) {
  return String(said ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent')
    .replace(/[.,!?;:()]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING, '')
    .replace(TRAILING, '')
    .split(' ')
    .filter((word) => word && !FILLER.has(word));
}

/** A phrase's tokens: words, and its slots as they're written. Marked so plainWords leaves them be ("?" is punctuation to it). */
const SLOTS = { 'aim': 'zzaimzz', 'aim?': 'zzaimoptzz', 'value': 'zzvaluezz', 'value?': 'zzvalueoptzz' };
const SLOT_OF = Object.fromEntries(Object.entries(SLOTS).map(([slot, mark]) => [mark, `{${slot}}`]));
const patternWords = (say) => plainWords(String(say).replace(/\{(aim\??|value\??)\}/g, (_, slot) => ` ${SLOTS[slot]} `)).map((word) => SLOT_OF[word] || word);

/** One and many are the same word here: "the black light" is a "{aim} lights" phrase, "bedside lamps" a "bedside lamp". */
const stem = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
/** Words that name an aim choice, as plainWords would leave them, one or many alike. */
const named = (phrase) => plainWords(phrase).map(stem).join(' ');

/**
 * A control's value said in so many words, or undefined: a slider's number, or one of its choices.
 * @returns {number|string|undefined}
 */
function valueSaid(control, words) {
  const phrase = words.join(' ');
  if (control.kind === 'slider') {
    const end = ENDS[phrase];
    if (end) return end === 'max' ? control.max : control.min;
    const number = numberFrom(phrase.replace(/\s*percent$/, ''));
    if (number === null || !/\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|zero/.test(phrase)) return undefined;
    const value = sliderValue(control, number);
    return Number.isFinite(value) ? value : undefined;
  }
  if (control.kind === 'choices') return choiceOf(control, phrase)?.value ?? choiceOf(control, words.join(''))?.value;
  return undefined;
}

/** The aim choice some words name, or undefined. */
function aimSaid(manifest, words) {
  const phrase = words.map(stem).join(' ');
  if (!phrase) return undefined;
  for (const choice of manifest.aim?.choices || []) {
    if (!choice.value) continue;
    if ([choice.label, choice.value, ...choice.words].some((name) => named(name) === phrase)) return choice;
  }
  return undefined;
}

/**
 * Whether `words` are one of a phrase's ways of saying it, and what its slots held.
 * @returns {{aim?:string, value?:any}|null}
 */
function fit(manifest, control, tokens, words, i = 0, j = 0, found = {}) {
  if (i === tokens.length) return j === words.length ? found : null;
  const token = tokens[i];
  if (token === '{aim}' || token === '{aim?}') {
    if (!manifest.aim) return token === '{aim?}' ? fit(manifest, control, tokens, words, i + 1, j, found) : null;
    // The longest name first: "brown main" before "brown".
    for (let k = Math.min(words.length, j + 5); k > j; k--) {
      const choice = aimSaid(manifest, words.slice(j, k));
      if (!choice) continue;
      const rest = fit(manifest, control, tokens, words, i + 1, k, { ...found, aim: choice.value });
      if (rest) return rest;
    }
    return token === '{aim?}' ? fit(manifest, control, tokens, words, i + 1, j, found) : null;
  }
  if (token === '{value}' || token === '{value?}') {
    for (let k = Math.min(words.length, j + 5); k > j; k--) {
      const value = valueSaid(control, words.slice(j, k));
      if (value === undefined) continue;
      const rest = fit(manifest, control, tokens, words, i + 1, k, { ...found, value });
      if (rest) return rest;
    }
    return token === '{value?}' ? fit(manifest, control, tokens, words, i + 1, j, found) : null;
  }
  return j < words.length && stem(words[j]) === stem(token) ? fit(manifest, control, tokens, words, i + 1, j + 1, found) : null;
}

/**
 * The control a sentence asks for, among the blocks', or null. Of several phrases that fit, the one with the most
 * words of its own wins ("set the lights to red" is color's, not brightness's: red isn't a number).
 * @param {string} said
 * @param {{id:string, manifest:object}[]} blocks
 * @returns {{script:string, control:string, value?:any, aim?:string, words:number}|null}
 */
export function matchWords(said, blocks) {
  const words = plainWords(said);
  if (!words.length) return null;
  let best = null;
  for (const { id, manifest } of blocks) {
    for (const control of manifest.controls) {
      for (const entry of control.words) {
        const tokens = patternWords(entry.say);
        const own = tokens.filter((token) => !token.startsWith('{')).length;
        if (!own || (best && best.words >= own)) continue;
        const found = fit(manifest, control, tokens, words);
        if (!found) continue;
        let { value } = found;
        if ('value' in entry) {
          // A fixed value has to be one the control takes.
          value = control.kind === 'slider' ? sliderValue(control, entry.value) : control.kind === 'choices' ? choiceOf(control, entry.value)?.value : undefined;
          if (value === undefined || Number.isNaN(value)) continue;
        }
        if ((control.kind === 'slider' || control.kind === 'choices') && value === undefined) continue;
        best = { script: id, control: control.id, ...(value !== undefined ? { value } : {}), ...(found.aim ? { aim: found.aim } : {}), words: own };
      }
    }
  }
  return best;
}

/** Words of a sentence's that name something of a block's: its name, an aim, a control. For "is this about my scripts?". */
export function blockWords(manifest) {
  const vocabulary = new Set();
  const add = (phrase) => {
    for (const word of plainWords(phrase)) if (word.length > 2 && !GENERIC.has(word)) vocabulary.add(word.replace(/s$/, ''));
  };
  add(manifest.name);
  add(manifest.aim?.all || '');
  for (const choice of manifest.aim?.choices || []) [choice.label, ...choice.words].forEach(add);
  for (const control of manifest.controls) {
    add(control.label);
    for (const entry of control.words) add(entry.say.replace(/\{[^}]*\}/g, ' '));
  }
  return vocabulary;
}
const GENERIC = new Set(['turn', 'set', 'make', 'put', 'switch', 'on', 'off', 'to', 'up', 'down', 'and', 'what', 'whats', 'is', 'are', 'it', 'them', 'they', 'that', 'this', 'run', 'start', 'stop', 'open', 'show', 'status', 'all']);

/** Whether a sentence names anything of these blocks'. */
export function mentions(said, vocabularies) {
  const words = plainWords(said).map((word) => word.replace(/s$/, ''));
  return vocabularies.some((vocabulary) => words.some((word) => vocabulary.has(word)));
}

/**
 * Words that put something at a time: "at 11", "at 5:30 pm", "at noon", "in 20 minutes", "tonight", "tomorrow".
 * Not a number where a level goes: "set the lights at 50", "at 30 percent", "at one hundred" (2026-11-18 review).
 * A script asked for with these is for later, kept with a task, never run now.
 */
const TIMED = new RegExp(
  [
    String.raw`\bat (?:[1-9]|1[0-2])(?::[0-5]\d)?(?![\d:])(?!\s*(?:%|percent|per ?cent))`,
    String.raw`\bat (?:[01]?\d|2[0-3]):[0-5]\d\b`,
    String.raw`\bat (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?:hundred|percent|%))`,
    String.raw`\bat (?:noon|midnight|midday)\b`,
    String.raw`\bin (?:\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|half an?) (?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b`,
    String.raw`\b(?:tonight|tomorrow|this (?:evening|afternoon|morning))\b`,
    String.raw`\b\d{1,2}(?::\d\d)? ?(?:am|pm|a\.m\.|p\.m\.)`,
    String.raw`\bo'?clock\b`,
    String.raw`\bwhen i (?:get|leave|wake)\b`
  ].join('|'),
  'i'
);
export const timedWords = (said) => TIMED.test(String(said ?? '').replace(/[‘’]/g, "'"));

/** A scene's name said as asking for it: "goodnight", "movie time", "start movie", "the movie scene". */
export function sceneAsked(said, name) {
  const words = plainWords(said).join(' ');
  const scene = plainWords(name).join(' ');
  if (!scene || !words) return false;
  const shapes = [scene, `${scene} scene`, `${scene} mode`, `${scene} time`, `${scene} lights`];
  return shapes.some((shape) => words === shape || new RegExp(`^(?:run|start|set|activate|do|play|put on|turn on|switch to|go to|use|make it) ${escape(shape)}$`).test(words));
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export { aimChoice };
