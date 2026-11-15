/**
 * Saying something out loud: Jester's own voice (Kokoro, on this computer:
 * kokoro.js) when its model is there, and the computer's own otherwise, so he
 * is never silent. Nothing he says leaves the machine either way. What he says
 * is short, because a long answer isn't worth waiting through.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** Enough for three sentences or so. */
export const SPOKEN_CHARS = 400;
/**
 * An opening sentence longer than this is made in two: Kokoro takes about 110 ms and then 7 ms a character
 * (voice/voices.js), so a long one would be most of a second before any sound (0.9 s for one of 110 characters,
 * speed-check --spoken, 2026-11-15), and its first clause under half of one.
 */
const LONG_PIECE = 60;
/** Neither half of a sentence cut in two is shorter than this: a word or two on its own sounds cut off. */
const CLAUSE_LEAST = 18;
/** Where the cut is wanted: this many characters in, about 0.4 s to make and two seconds to say, which the rest is made in. */
const CUT_NEAR = 40;
/**
 * Or before one of these, where someone speaking might take a breath anyway. A comma is the better place, by this
 * many characters: "…breaks a complex problem | into overlapping subproblems, solves each once…" is cut at 44 and
 * not at the comma at 73, which was 0.85 s to make.
 */
const COMMA_WORTH = 8;
const JOINING = /\s(?=(?:and|but|or|so|because|which|that|while|when|where|if|as|then|since|until|before|after|by|with|without|from|into|through|for|than)\s)/g;
/** A piece that ends like this ends where the sentence pauses; one that doesn't runs on into the next (runsOn). */
const PAUSES = /[.!?…,;:—–]["'”’)]*$/;
/** A full stop after one of these, a lone capital or a figure isn't a sentence's end. */
const NO_END = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|No|a\.m|p\.m)|\b[A-Z]|\d)\.["'”’)]*$/;
const MAC_VOICE = 'Daniel';

/** What a line for the pill should be, to the ear: no symbols, no "·", and not too long. */
export function spokenLine(text) {
  const line = String(text ?? '')
    .replace(/\s*\([^)]*[⌘⌥⌃⇧][^)]*\)/g, '')
    .replace(/([.!?…])?\s+·\s+/g, (_, end) => `${end || '.'} `)
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= SPOKEN_CHARS) return line;
  const cut = line.slice(0, SPOKEN_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return sentence > 0 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * A line he writes rather than says (to someone typing to him): read, not heard, so every character stays and
 * nothing is cut. Only spacing is tidied, and a list run together with " · " reads as sentences, as said.
 */
export function writtenLine(text) {
  return String(text ?? '')
    .replace(/([.!?…])?[ \t]+·[ \t]+/g, (_, end) => `${end || '.'} `)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * The OS's own voice. `muted` (tests) writes the speech to a file instead.
 * @returns {{say:(text:string) => Promise<void>, stop:() => void}}
 */
export function systemVoice({ platform = process.platform, spawnImpl = spawn, muted = false } = {}) {
  let child = null;
  const macArgs = (voice) => [...(voice ? ['-v', voice] : []), ...(muted ? ['-o', path.join(os.tmpdir(), 'jester-say.aiff')] : []), '-f', '-'];
  const WINDOWS_SPEECH = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())';

  /** Text goes in on stdin: it's what was said, and never an argument. */
  const run = (file, args, text) =>
    new Promise((resolve) => {
      const started = spawnImpl(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child = started;
      const over = (code) => {
        if (child === started) child = null;
        resolve(code);
      };
      started.on('error', () => over(1));
      started.on('exit', (code) => over(code));
      started.stdin?.on('error', () => undefined);
      started.stdin?.end(text);
    });

  return {
    async say(text) {
      if (platform === 'win32') return void (await run('powershell.exe', ['-NoProfile', '-Command', WINDOWS_SPEECH], text));
      if (platform !== 'darwin') return undefined;
      // A Mac may not have this voice: its default will do.
      if ((await run('say', macArgs(MAC_VOICE), text)) === 1) await run('say', macArgs(), text);
      return undefined;
    },
    stop() {
      child?.kill();
      child = null;
    }
  };
}

const MONTHS = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Sept: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const YEAR_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = { Mon: 'Monday', Tue: 'Tuesday', Tues: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Thur: 'Thursday', Thurs: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const UNITS = { km: 'kilometres', kg: 'kilos', cm: 'centimetres', mm: 'millimetres', ml: 'millilitres', mph: 'miles an hour', 'km/h': 'kilometres an hour', kph: 'kilometres an hour', lb: 'pounds', lbs: 'pounds', oz: 'ounces', ft: 'feet', GB: 'gigabytes', MB: 'megabytes', TB: 'terabytes', hr: 'hours', hrs: 'hours', min: 'minutes', mins: 'minutes', sec: 'seconds', secs: 'seconds' };
const MONEY = { $: ['dollar', 'dollars', 'cents'], '£': ['pound', 'pounds', 'pence'], '€': ['euro', 'euros', 'cents'] };

/**
 * A line as his voice should be given it. Kokoro says what's written, sign by sign ("$12.50" came out as "dollar
 * twelve point five zero", "Nov 15" as "Nove fifteenth" and "7-9 PM" as "seven dash nine": scripts/voice-check.mjs),
 * so what's written for the eye is put the way it's said. Only what he says aloud goes through this: what's shown
 * stays as written.
 */
export function forEar(text) {
  return (
    String(text ?? '')
      // Money: the amount, then what it's in. "$0.99" is cents, and "$1.5 million" is a million and a half of them.
      .replace(/([$£€])\s?(\d+(?:,\d{3})*)(?:\.(\d+))?(\s?(?:thousand|million|billion|trillion)\b)?/g, (_, sign, whole, part, scale) => {
        const [one, many, small] = MONEY[sign];
        if (scale) return `${whole}${part ? `.${part}` : ''}${scale} ${many}`;
        const units = Number(whole.replace(/,/g, ''));
        const cents = part ? Number(part.padEnd(2, '0').slice(0, 2)) : 0;
        if (!units && cents) return `${cents} ${small}`;
        return `${whole} ${units === 1 ? one : many}${cents ? ` ${cents < 10 ? `and ${cents} ${small}` : cents}` : ''}`;
      })
      .replace(/\s?°\s?F\b/g, ' degrees Fahrenheit')
      .replace(/\s?°\s?C\b/g, ' degrees Celsius')
      .replace(/\s?°/g, ' degrees')
      // A phone number is said a figure at a time.
      .replace(/\b(?:\d{3}[-.\s])?\d{3}-\d{4}\b/g, (number) => number.replace(/\D+/g, ', ').split('').join(' ').replace(/ , /g, ', '))
      .replace(/\b24\/7\b/g, 'twenty-four seven')
      // "7-9 PM", "10:30–11:00", "pages 3-5": from one to the other. A date written 2026-11-15 is said as one.
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (all, year, month, day) => (YEAR_MONTHS[Number(month) - 1] ? `${YEAR_MONTHS[Number(month) - 1]} ${Number(day)}, ${year}` : all))
      .replace(/(?<![\d–-])\b(\d{1,2}(?::\d{2})?\s?(?:[ap]\.?m\.?)?)\s?[-–]\s?(\d{1,2}(?::\d{2})?)\b(?![-–\d])/gi, '$1 to $2')
      .replace(new RegExp(`(\\d)\\s?(${Object.keys(UNITS).map((unit) => unit.replace('/', '\\/')).join('|')})\\b(?!\\/)`, 'g'), (_, figure, unit) => `${figure} ${UNITS[unit]}`)
      // A month or a day cut short, by a date or a comma: never the words "sat", "sun", "may" or "mar" in a sentence.
      .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?(?=\s\d)/g, (_, month) => MONTHS[month])
      .replace(/(\d(?:st|nd|rd|th)?\s)(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/g, (_, before, month) => `${before}${MONTHS[month]}`)
      .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri)\b\.?(?=[,\s]|$)/g, (_, day) => DAYS[day])
      .replace(/\b(Sat|Sun)\b\.?(?=,|\s\d|\s(?:January|February|March|April|May|June|July|August|September|October|November|December)\b)/g, (_, day) => DAYS[day])
      .replace(/\bNo\.\s?(?=\d)/g, 'number ')
      .replace(/#(?=\d)/g, 'number ')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\betc\./gi, 'et cetera')
      .replace(/\bvs\.?(?=\s)/gi, 'versus')
      .replace(/(\w)@(\w)/g, '$1 at $2')
      .replace(/(\w)\.(com|org|net|edu|gov|io|co|uk|app|dev|ai)\b/g, '$1 dot $2')
      .replace(/\s&\s/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * A line as the pieces it's made and played in, put for the ear (forEar): its sentences, and a long first sentence
 * as two clauses, so the first sound comes soon. Each is made while the one before plays.
 * @returns {string[]}
 */
export function spokenPieces(text) {
  const line = forEar(text);
  if (!line) return [];
  const pieces = [];
  let from = 0;
  for (const end of line.matchAll(/[.!?…]+["'”’)]*(?=\s)/g)) {
    const upTo = end.index + end[0].length;
    const piece = line.slice(from, upTo).trim();
    if (!piece || NO_END.test(piece)) continue;
    pieces.push(piece);
    from = upTo;
  }
  const last = line.slice(from).trim();
  if (last) pieces.push(last);
  const first = pieces[0];
  if (first.length > LONG_PIECE) {
    // At a comma or before a joining word, whichever is nearest CUT_NEAR and leaves enough either side.
    const cuts = [
      ...[...first.matchAll(/[,;:—–]\s/g)].map((cut) => ({ at: cut.index + 1, far: Math.abs(cut.index + 1 - CUT_NEAR) })),
      ...[...first.matchAll(JOINING)].map((cut) => ({ at: cut.index, far: Math.abs(cut.index - CUT_NEAR) + COMMA_WORTH }))
    ].filter(({ at }) => at >= CLAUSE_LEAST && first.length - at >= CLAUSE_LEAST);
    const at = cuts.sort((a, b) => a.far - b.far)[0]?.at;
    if (at) pieces.splice(0, 1, first.slice(0, at).trim(), first.slice(at).trim());
  }
  return pieces;
}

/** Whether a piece stops mid-sentence with no pause written: its sound is made to run straight into the next. */
export const runsOn = (piece) => !PAUSES.test(piece);

/**
 * @param {object} deps
 * @param {{sound:(text:string, options:{signal?:AbortSignal, tight?:boolean}) => Promise<{bytes:Uint8Array, type:string}|null>}|null} [deps.voice]  his own voice: null from `sound` when it isn't there; `tight` for a piece that runs on into the next
 * @param {(bytes:Uint8Array, type:string) => Promise<void>} deps.play
 * @param {() => void} deps.stopPlaying
 * @param {{say:Function, stop:Function}} deps.system
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createSpeaker({ voice = null, play, stopPlaying, system, log = () => undefined }) {
  let controller = null;
  /** A piece's sound, being made ahead of its turn (prepare): the piece, and the sound or null. */
  let ahead = null;

  /** A piece's sound, or null when his own voice can't make it: never a rejection. */
  const made = (piece, signal) =>
    Promise.resolve()
      .then(() => (voice ? voice.sound(piece, { signal, tight: runsOn(piece) }) : null))
      .catch((err) => {
        if (!signal?.aborted) log('Jester’s voice:', err.message);
        return null;
      });

  return {
    /**
     * `onSound`: called as the sound starts, once.
     * @returns {Promise<void>} once it's been said, or stopped
     */
    async say(text, { onSound = () => undefined } = {}) {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      const { signal } = mine;
      let begun = false;
      const begin = () => {
        if (begun) return;
        begun = true;
        try {
          onSound();
        } catch {
          // A listener's trouble isn't the voice's.
        }
      };
      const pieces = spokenPieces(text);
      const early = ahead?.text === pieces[0] ? ahead.made : null;
      ahead = null;
      let next = pieces.length ? early || made(pieces[0], signal) : null;
      for (let index = 0; index < pieces.length; index++) {
        const sound = await next;
        if (signal.aborted) return;
        if (!sound) {
          // His own voice isn't there, or failed part-way: the computer's says what's left.
          begin();
          await system.say(pieces.slice(index).join(' '));
          return;
        }
        next = index + 1 < pieces.length ? made(pieces[index + 1], signal) : null;
        begin();
        try {
          await play(sound.bytes, sound.type);
        } catch (err) {
          if (signal.aborted) return;
          log('Jester’s voice:', err.message);
          await system.say(pieces.slice(index).join(' '));
          return;
        }
        if (signal.aborted) return;
      }
    },
    /** A line that's about to be said, after the one being said now: its start is made meanwhile, so no gap. */
    prepare(text) {
      const [first] = spokenPieces(text);
      ahead = first ? { text: first, made: made(first) } : null;
    },
    stop() {
      ahead = null;
      controller?.abort();
      stopPlaying();
      system.stop();
    }
  };
}
