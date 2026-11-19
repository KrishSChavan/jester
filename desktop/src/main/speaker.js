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
export function spokenLine(text, { limit = SPOKEN_CHARS } = {}) {
  const line = String(text ?? '')
    .replace(/\s*\([^)]*[⌘⌥⌃⇧][^)]*\)/g, '')
    .replace(/([.!?…])?\s+·\s+/g, (_, end) => `${end || '.'} `)
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const most = Number.isFinite(limit) ? Math.max(1, Math.min(16000, limit)) : SPOKEN_CHARS;
  if (line.length <= most) return line;
  const cut = line.slice(0, most);
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
  let generation = 0;
  const macArgs = (voice) => [...(voice ? ['-v', voice] : []), ...(muted ? ['-o', path.join(os.tmpdir(), 'jester-say.aiff')] : []), '-f', '-'];
  const WINDOWS_SPEECH = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())';

  /** Text goes in on stdin: it's what was said, and never an argument. */
  const run = (file, args, text, mine) =>
    new Promise((resolve) => {
      if (mine !== generation) return resolve(null);
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
      const mine = ++generation;
      child?.kill();
      child = null;
      if (platform === 'win32') return void (await run('powershell.exe', ['-NoProfile', '-Command', WINDOWS_SPEECH], text, mine));
      if (platform !== 'darwin') return undefined;
      // A Mac may not have this voice: its default will do.
      if ((await run('say', macArgs(MAC_VOICE), text, mine)) === 1 && mine === generation) await run('say', macArgs(), text, mine);
      return undefined;
    },
    stop() {
      generation += 1;
      child?.kill();
      child = null;
    }
  };
}

const MONTHS = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Sept: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const YEAR_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_NAMES = YEAR_MONTHS.join('|');
const DAYS = { Mon: 'Monday', Tue: 'Tuesday', Tues: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Thur: 'Thursday', Thurs: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
/** Each as one of it, then as more: "1 km" is a kilometre. */
const UNITS = {
  km: ['kilometre', 'kilometres'],
  kg: ['kilo', 'kilos'],
  cm: ['centimetre', 'centimetres'],
  mm: ['millimetre', 'millimetres'],
  ml: ['millilitre', 'millilitres'],
  mL: ['millilitre', 'millilitres'],
  mi: ['mile', 'miles'],
  mph: ['mile an hour', 'miles an hour'],
  'km/h': ['kilometre an hour', 'kilometres an hour'],
  kph: ['kilometre an hour', 'kilometres an hour'],
  lb: ['pound', 'pounds'],
  lbs: ['pound', 'pounds'],
  oz: ['ounce', 'ounces'],
  ft: ['foot', 'feet'],
  GB: ['gigabyte', 'gigabytes'],
  MB: ['megabyte', 'megabytes'],
  TB: ['terabyte', 'terabytes'],
  hr: ['hour', 'hours'],
  hrs: ['hour', 'hours'],
  min: ['minute', 'minutes'],
  mins: ['minute', 'minutes'],
  sec: ['second', 'seconds'],
  secs: ['second', 'seconds'],
  tsp: ['teaspoon', 'teaspoons'],
  tbsp: ['tablespoon', 'tablespoons'],
  wk: ['week', 'weeks'],
  wks: ['week', 'weeks'],
  yr: ['year', 'years'],
  yrs: ['year', 'years']
};
const MONEY = { $: ['dollar', 'dollars', 'cents'], '£': ['pound', 'pounds', 'pence'], '€': ['euro', 'euros', 'cents'] };
/** "$3M", "$1.2bn", "$100k": what the letter is short for. */
const SCALES = { k: 'thousand', K: 'thousand', m: 'million', M: 'million', mn: 'million', b: 'billion', B: 'billion', bn: 'billion', T: 'trillion', tn: 'trillion' };
const FRACTIONS = {
  '1/2': 'a half',
  '1/3': 'a third',
  '2/3': 'two thirds',
  '1/4': 'a quarter',
  '3/4': 'three quarters',
  '1/8': 'an eighth',
  '3/8': 'three eighths',
  '5/8': 'five eighths',
  '7/8': 'seven eighths'
};
const FRACTION_SIGNS = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8' };
/** A figure written with a slash after one of these is a date: "due 3/4" is March the 4th, not three quarters. */
const DATED = /\b(?:on|by|due|until|till|from|since|before|after|through|thru|starting|ending|dated|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+$/i;
/** A year written after one of these, and with the sentence or clause ending there, is said as a year ("In 2026."). */
const YEAR_BEFORE = /\b(in|since|until|till|by|before|after|from|of|during|through|circa|around|year)\s(1[1-9]\d\d|20\d\d)\b(?=\s*(?:[,.;:!?)]|$)|\s(?:and|or|to|through|until|when|was|is|will|had|has|but)\b)/gi;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** 0 to 99 as words: "forty-five". */
const underHundred = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
/** A year as it's said: "twenty twenty-six", "nineteen oh five", "two thousand nine", "nineteen hundred". */
export function yearWords(year) {
  if (year >= 2000 && year < 2010) return year === 2000 ? 'two thousand' : `two thousand ${ONES[year - 2000]}`;
  const [high, low] = [Math.floor(year / 100), year % 100];
  return `${underHundred(high)} ${low === 0 ? 'hundred' : low < 10 ? `oh ${ONES[low]}` : underHundred(low)}`;
}
/** "nineteen ninety" → "nineteen nineties", "two thousand" → "two thousands". */
const plural = (words) => words.replace(/(\w+)$/, (word) => (word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`));
/**
 * A time on a clock as it's said: "seven oh five AM", "eleven o'clock", "four forty-five PM". Noon and midnight by
 * name, and a 24-hour "17:45" in the twelve hours he speaks in: "five forty-five PM".
 */
export function clockWords(hours, minutes, half = '') {
  let hour = Number(hours);
  const minute = Number(minutes);
  let suffix = half ? (/^a/i.test(half) ? 'AM' : 'PM') : '';
  if (hour > 23 || minute > 59 || (suffix && (hour === 0 || hour > 12))) return null;
  if (!suffix && (hour === 0 || hour > 12)) {
    suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
  }
  if (hour === 12 && minute === 0 && suffix) return suffix === 'PM' ? 'noon' : 'midnight';
  const past = minute === 0 ? (suffix ? '' : 'o’clock') : minute < 10 ? `oh ${ONES[minute]}` : underHundred(minute);
  return [underHundred(hour), past, suffix].filter(Boolean).join(' ');
}
/** "17" → "17th": Kokoro says the figure and its ending as one word. */
const ordinal = (day) => `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] || 'th'}`;
/** Whether the sentence ends after `at`: a full stop eaten with "p.m." or "Jr." that was also the sentence's is given back. */
const endsAt = (whole, at) => /^(?:\s*$|\s+[A-Z“"‘(])/.test(whole.slice(at));
const giveBack = (match, at, whole) => (match.endsWith('.') && endsAt(whole, at + match.length) ? '.' : '');

/** "11/17", "3/4", "8/10": a date, a fraction or a score, by what's around it. */
function slashed(all, first, second, year, at, whole) {
  const [x, y] = [Number(first), Number(second)];
  const dated = Boolean(year) || DATED.test(whole.slice(Math.max(0, at - 16), at));
  const mixed = /\d\s$/.test(whole.slice(0, at)) ? 'and ' : '';
  if (!dated && FRACTIONS[`${x}/${y}`]) return `${mixed}${FRACTIONS[`${x}/${y}`]}`;
  // Month first, as written here (en_US); a first figure over 12 can only be a day.
  const [month, day] = x > 12 && y <= 12 ? [y, x] : [x, y];
  if (!dated && (y === 5 || y === 10 || y === 100 || month < 1 || month > 12 || day < 1 || day > 31)) return `${first} out of ${second}`;
  if (month < 1 || month > 12 || day < 1 || day > 31) return all;
  const said = `${YEAR_MONTHS[month - 1]} ${ordinal(day)}`;
  return year ? `${said}, ${yearWords(year.length === 2 ? 2000 + Number(year) : Number(year))}` : said;
}

/**
 * A line as his voice should be given it. Kokoro says what's written, sign by sign ("$12.50" came out as "dollar
 * twelve point five zero", "Nov 15" as "Nove fifteenth" and "7-9 PM" as "seven dash nine": scripts/voice-check.mjs),
 * so what's written for the eye is put the way it's said. Only what he says aloud goes through this: what's shown
 * stays as written.
 *
 * What it's put into is checked against what Kokoro is actually given: sherpa-onnx hands English to espeak-ng whole
 * (the model's voice is en-us, so the lexicon file isn't used for it), after turning every ":" into "," — so "11:00"
 * reached him as "11,00" and was said "eleven zero zero", and "7:05" "seven zero five". Seen with sherpa's debug
 * output (2026-11-17): "~" is "tilde", "→" "right arrow", "👍" "thumbs up", "w/" "double-u slash", "10k" "ten kay",
 * "1990s" "nineteen hundred ninety z", "ETA" "eeta", "NYC" "nick", "Ms" "em ess", "Mt" "em tee", and a full stop
 * after "Mr." or "Dr." ends a sentence there, with a pause before the name. "AM", "US", "AI", "ID", "IT", "CEO",
 * "URL", curly apostrophes and hyphenated words were already said right.
 */
export function forEar(text) {
  return (
    String(text ?? '')
      // What's only for the eye: a link's address, a source's number, a picture. "[the docs](https://…)" is "the docs".
      .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1')
      .replace(/\s?\[\d+(?:\s?[,–-]\s?\d+)*\]/g, '')
      .replace(/\s*(?:→|->|⇒|=>|⟶|➔|➡️?)\s*/g, ', then ')
      // The way to somewhere in Settings, as it's written for the eye: "System Settings › Privacy & Security › Camera".
      .replace(/\s*[›»]\s*/g, ', then ')
      .replace(/\s&\s/g, ' and ')
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
      .replace(/\bhttps?:\/\//gi, '')
      .replace(/\bwww\./gi, '')
      // Money: the amount, then what it's in. "$0.99" is cents, and "$1.5 million" (or "$1.5M") is a million and a half of them.
      .replace(/([$£€])\s?(\d+(?:,\d{3})*)(?:\.(\d+))?(\s?(?:thousand|million|billion|trillion)\b|(?:k|K|m|M|mn|b|B|bn|T|tn)\b)?/g, (_, sign, whole, part, scale) => {
        const [one, many, small] = MONEY[sign];
        if (scale) return `${whole}${part ? `.${part}` : ''} ${SCALES[scale] || scale.trim()} ${many}`;
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
      .replace(/\b50\/50\b/g, 'fifty-fifty')
      // "7-9 PM", "10:30–11:00", "pages 3-5", "2020-2024": from one to the other. A date written 2026-11-15 is said as one.
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (all, year, month, day) => (YEAR_MONTHS[Number(month) - 1] ? `${YEAR_MONTHS[Number(month) - 1]} ${Number(day)}, ${yearWords(Number(year))}` : all))
      .replace(/\b(1[1-9]\d\d|20\d\d)\s?[-–]\s?(1[1-9]\d\d|20\d\d)\b/g, (_, from, to) => `${yearWords(Number(from))} to ${yearWords(Number(to))}`)
      .replace(/(?<![\d–-])\b(\d{1,2}(?::\d{2})?\s?(?:[ap]\.?m\.?)?)\s?[-–]\s?(\d{1,2}(?::\d{2})?)(?=\s?[ap]\.?m|\b)(?![-–\d]|\s?=)/gi, '$1 to $2')
      // A time: "11:00" was "eleven zero zero" (see above). With seconds and no AM or PM it's how long something takes.
      .replace(/(?<![\d:.])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d:])(?:\s?([AaPp])\.?\s?[Mm]\b\.?)?/g, (all, hours, minutes, seconds, half, at, whole) => {
        if (seconds && !half) {
          const parts = [[hours, 'hour'], [minutes, 'minute'], [seconds, 'second']].filter(([n]) => Number(n)).map(([n, unit]) => `${Number(n)} ${unit}${Number(n) === 1 ? '' : 's'}`);
          return parts.length ? parts.join(' ').replace(/ (\d+ \w+)$/, ' and $1') : all;
        }
        // "0:45" is how long something takes, not a quarter to one in the morning: left as figures.
        const said = hours === '0' && !half ? null : clockWords(hours, minutes, half);
        return said ? `${said}${giveBack(all, at, whole)}` : all;
      })
      .replace(/\b12\s?([AaPp])\.?\s?[Mm]\b\.?/g, (all, half, at, whole) => `${/a/i.test(half) ? 'midnight' : 'noon'}${giveBack(all, at, whole)}`)
      // A slash between figures: a date, a fraction or a score ("eleven slash seventeen" otherwise).
      .replace(/(\d\s?)?([½⅓⅔¼¾⅛])/g, (_, before, sign) => `${before ? `${before.trim()} and ` : ''}${FRACTIONS[FRACTION_SIGNS[sign]]}`)
      .replace(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g, slashed)
      .replace(/\b(\d+(?:\.\d+)?)\/(\d+)\b/g, '$1 out of $2')
      .replace(/\bw\/o\b/gi, 'without')
      .replace(/\bw\/(?=\s)/gi, 'with')
      .replace(/\bN\/A\b/g, 'not applicable')
      // The nineties, the 1990s, the '90s.
      .replace(/\b(1[1-9]\d0|20\d0)['’]?s\b/g, (_, year) => plural(yearWords(Number(year))))
      .replace(/(?:['’]|(?<=\b(?:the|their|his|her|my|your|our|early|mid|late)[\s-]))([2-9]0)['’]?s\b/gi, (_, tens) => plural(underHundred(Number(tens))))
      // What's left of "30s" is seconds ("thirty z" otherwise). "1920x1080", "2x faster", "10k steps", "3M users".
      .replace(/\b(\d+)s\b/g, (_, figure) => `${figure} ${figure === '1' ? 'second' : 'seconds'}`)
      .replace(/\b(\d+)\s?x\s?(\d+)\b/g, '$1 by $2')
      .replace(/\b(\d+(?:\.\d+)?)x\b/g, '$1 times')
      .replace(/\b(\d+(?:\.\d+)?)k\b(?!\s(?:run|race|walk))/g, '$1 thousand')
      .replace(/\b(\d+(?:\.\d+)?)(M|B|mn|bn)\b/g, (_, figure, scale) => `${figure} ${SCALES[scale]}`)
      .replace(/\b(\d+)\s?ft\s(\d+)\s?in\b/g, (_, feet, inches) => `${feet} ${feet === '1' ? 'foot' : 'feet'} ${inches} ${inches === '1' ? 'inch' : 'inches'}`)
      .replace(
        new RegExp(`(?<![\\d.,])(\\d+(?:[.,]\\d+)*)\\s?(${Object.keys(UNITS).map((unit) => unit.replace('/', '\\/')).join('|')})\\b(?!\\/)`, 'g'),
        (_, figure, unit) => `${figure} ${UNITS[unit][figure === '1' ? 0 : 1]}`
      )
      // A month or a day cut short, by a date or a comma: never the words "sat", "sun", "may" or "mar" in a sentence.
      .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?(?=\s\d)/g, (_, month) => MONTHS[month])
      .replace(/(\d(?:st|nd|rd|th)?\s)(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/g, (_, before, month) => `${before}${MONTHS[month]}`)
      .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri)\b\.?(?=[,\s]|$)/g, (_, day) => DAYS[day])
      .replace(/\b(Sat|Sun)\b\.?(?=,|\s\d|\s(?:January|February|March|April|May|June|July|August|September|October|November|December)\b)/g, (_, day) => DAYS[day])
      // A year is said as one: "twenty twenty-six", not "two thousand twenty-six".
      .replace(new RegExp(`\\b(${MONTH_NAMES})(\\s\\d{1,2}(?:st|nd|rd|th)?)?(,?\\s)(1[1-9]\\d\\d|20\\d\\d)\\b`, 'g'), (_, month, day = '', between, year) => `${month}${day}${between}${yearWords(Number(year))}`)
      .replace(YEAR_BEFORE, (_, before, year) => `${before} ${yearWords(Number(year))}`)
      .replace(/\bNo\.\s?(?=\d)/g, 'number ')
      .replace(/#(?=\d)/g, 'number ')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\betc\./gi, 'et cetera')
      .replace(/\bvs\.?(?=\s)/gi, 'versus')
      // Titles, said whole and with no full stop: one there ends the sentence, with a pause before the name.
      .replace(/\bMr\.?(?=\s[A-Z])/g, 'Mister')
      .replace(/\bMrs\.?(?=\s[A-Z])/g, 'Missus')
      .replace(/\bMs\.?(?=\s[A-Z])/g, 'Miz')
      .replace(/\bDr\.?(?=\s[A-Z])/g, 'Doctor')
      .replace(/\bProf\.?(?=\s[A-Z])/g, 'Professor')
      .replace(/\bMt\.?(?=\s[A-Z])/g, 'Mount')
      .replace(/(?<![^.!?\s]\s[A-Z][a-z]*\s)\bSt\.?(?=\s[A-Z])/g, 'Saint')
      .replace(/\b(Jr|Sr)\.?(?=[\s,]|$)/g, (all, title, at, whole) => `${title === 'Jr' ? 'Junior' : 'Senior'}${giveBack(all, at, whole)}`)
      .replace(/(?<=[A-Z][a-z]*\s)(St|Ave|Rd|Blvd)\.(?=[\s,]|$)/g, (all, road, at, whole) => `${{ St: 'Street', Ave: 'Avenue', Rd: 'Road', Blvd: 'Boulevard' }[road]}${giveBack(all, at, whole)}`)
      .replace(/\bapprox\.?(?=\s)/gi, 'about')
      .replace(/\b(tsp|tbsp)\b\.?/g, (_, spoon) => (spoon === 'tsp' ? 'teaspoon' : 'tablespoon'))
      .replace(/\b(?:AKA\b|a\.k\.a\.)/g, 'also known as')
      // Letters said one by one, written with stops ("E T A" made the A "uh"); a full stop after them is theirs.
      .replace(/\b(ETA|FAQ)(s?)\b\.?/g, (_, letters, many) => `${letters.split('').join('.')}.${many}`)
      .replace(/\bNYC\b/g, 'New York City')
      .replace(/\bOllama\b/gi, 'Ohllama')
      // An address: "sam at example dot com", "example dot com slash news".
      .replace(/(\w)@(\w)/g, '$1 at $2')
      .replace(/(\w)\.(com|org|net|edu|gov|io|co|uk|app|dev|ai)\b((?:\/[\w-]+)*)\/?/g, (_, before, end, path) => `${before} dot ${end}${path.replace(/\//g, ' slash ').replace(/[-_]/g, ' ')}`)
      .replace(/\s&\s/g, ' and ')
      // "and/or", "on/off": either. Signs said as what they mean, and those said as their names left out.
      .replace(/\band\/or\b/g, 'and or')
      .replace(/\b([a-z]{2,})\/([a-z]{2,})\b/g, '$1 or $2')
      .replace(/\b(about|around|roughly|approximately)\s?~\s?/gi, '$1 ')
      .replace(/~\s?(?=[\d$£€])/g, 'about ')
      .replace(/~/g, '')
      .replace(/(^|\s)([<>≤≥])\s?(?=[\w$£€-])/g, (_, before, sign) => `${before}${{ '<': 'less than', '>': 'more than', '≤': 'at most', '≥': 'at least' }[sign]} `)
      .replace(/\s\|\s/g, ', ')
      // An ellipsis mid-line was no pause at all ("Wait... ok" ran into one word): a comma is.
      .replace(/\s*(?:…|\.{3})(?=\s+\S)/g, ',')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?;:])/g, '$1')
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
 * @param {(bytes:Uint8Array, type:string, options?:{queued?:boolean}) => Promise<void>} deps.play  `queued`: started as what's playing ends, not in its place
 * @param {() => void} deps.stopPlaying
 * @param {{say:Function, stop:Function}} deps.system
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createSpeaker({ voice = null, play, stopPlaying, system, log = () => undefined }) {
  let controller = null;
  /** A piece's sound, being made ahead of its turn (prepare): the piece, and the sound or null. */
  let ahead = null;

  /** A piece's sound, or null when his own voice can't make it: never a rejection. */
  const made = (piece, signal, pace = 1) =>
    Promise.resolve()
      .then(() => (voice ? voice.sound(piece, { signal, tight: runsOn(piece), ...(pace === 1 ? {} : { speed: pace }) }) : null))
      .catch((err) => {
        if (!signal?.aborted) log('Jester’s voice:', err.message);
        return null;
      });

  return {
    /**
     * `onSound`: called as the sound starts, once. `pace`: how fast, against his usual 1 (his own voice only).
     * @returns {Promise<void>} once it's been said, or stopped
     */
    async say(text, { onSound = () => undefined, pace = 1 } = {}) {
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
      const early = ahead?.text === pieces[0] && ahead.pace === pace ? ahead : null;
      if (ahead && ahead !== early) ahead.controller.abort();
      ahead = null;
      const dropEarly = () => early?.controller.abort();
      if (early) signal.addEventListener('abort', dropEarly, { once: true });
      let next = pieces.length ? early?.made || made(pieces[0], signal, pace) : null;
      /** The piece playing, handed over: its place in the line, and its end (an error, or null when it played). */
      let current = null;
      /** What's left of the line, in the computer's voice, from piece `from` on: after the piece playing ends. */
      const rest = async (from) => {
        stopPlaying();
        begin();
        await system.say(pieces.slice(from).join(' '));
      };
      for (let index = 0; index < pieces.length; index++) {
        const sound = await next;
        if (index === 0) signal.removeEventListener('abort', dropEarly);
        if (signal.aborted) return;
        if (!sound) {
          // His own voice isn't there, or failed part-way: the computer's says what's left, once his has.
          const failed = current && (await current.ended);
          if (signal.aborted) return;
          if (failed) log('Jester’s voice:', failed.message);
          return void (await rest(failed ? current.index : index));
        }
        next = index + 1 < pieces.length ? made(pieces[index + 1], signal, pace) : null;
        begin();
        // Queued behind the piece playing, it starts as that one ends, with no gap: a sentence never waits to hear
        // that the one before it is over (2026-11-19, a pause at the end of every sentence).
        const ended = play(sound.bytes, sound.type, { queued: !!current }).then(
          () => null,
          (err) => err
        );
        if (current) {
          const failed = await current.ended;
          if (signal.aborted) return;
          if (failed) {
            log('Jester’s voice:', failed.message);
            return void (await rest(current.index));
          }
        }
        current = { index, ended };
      }
      if (!current) return;
      const failed = await current.ended;
      if (signal.aborted || !failed) return;
      log('Jester’s voice:', failed.message);
      await rest(current.index);
    },
    /** A line that's about to be said, after the one being said now: its start is made meanwhile, so no gap. */
    prepare(text, { pace = 1 } = {}) {
      ahead?.controller.abort();
      const [first] = spokenPieces(text);
      const preparing = new AbortController();
      ahead = first ? { text: first, pace, controller: preparing, made: made(first, preparing.signal, pace) } : null;
    },
    stop() {
      ahead?.controller.abort();
      ahead = null;
      controller?.abort();
      stopPlaying();
      system.stop();
    }
  };
}
