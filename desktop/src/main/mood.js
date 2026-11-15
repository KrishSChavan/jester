/**
 * How the user seems, from their own words, so his manner can follow it
 * (the user, 2026-11-14: "playful when chatting, all business when busy").
 *
 * His prompt already says to match their mood, and the models mostly do: with
 * no more than that, Claude Haiku 5.5 got 31 of 33 manner cases, Groq's
 * gpt-oss-120b 33 and qwen3.5:9b 26 (talk-check --only self, 2026-11-15). Every
 * miss was length: 49 words to someone who'd barely slept, and "On it, and
 * don't worry about the lateness" to someone late. So this reads only what's
 * plainly said, tells the model in the brackets before their words, and sets
 * how fast he speaks. It never guesses from tone it can't hear: nothing plain
 * means nothing told, and his own judgement, as before.
 *
 * Nothing here is kept: it's read from the words each turn and gone with them.
 */

/** In a hurry: said so. Not "how fast…", "right now" or a "quick" thing asked about. */
const HURRY =
  /\b(?:quick(?:ly)?|real quick|hurry(?: up)?|asap|i['’]?m (?:so |really |already |running |gonna be |going to be )*late|no time|in a (?:rush|hurry)|rushing|(?:gotta|got to|have to|need to) (?:go|run|leave)|make it (?:quick|fast|snappy)|keep it (?:short|brief)|just tell me)\b/i;
/** Low: how they say they feel, or what's happened. */
const FEELING = String.raw`(?:sad|down|low|depressed|exhausted|drained|burn(?:ed|t) out|overwhelmed|stressed(?: out)?|anxious|lonely|miserable|upset|heartbroken|devastated|awful|terrible|hopeless|worn out|scared|gutted|numb|a mess|not (?:ok|okay|doing (?:well|great|good)))`;
const LOW = new RegExp(
  String.raw`\b(?:i['’]?m|i am|i feel|i['’]?m feeling|feeling|i['’]?ve been|i have been|been)\s+(?:(?:so|really|pretty|very|just|kind of|kinda|a bit|a little|super|honestly|completely|totally)\s+)*${FEELING}\b` +
    // Someone's death, never a phone's or a laptop's.
    String.raw`|\b(?:mom|mum|mother|dad|father|grand(?:ma|pa|mother|father|dad)|nan|gran|brother|sister|friend|uncle|aunt|cousin|dog|cat|pet|wife|husband|partner|girlfriend|boyfriend|son|daughter|he|she|they)\b[^.?!]{0,30}\b(?:died|is dying|was killed)\b` +
    String.raw`|\b(?:bombed|failed|flunked) (?:my|the|that|it)\b|\b(?:passed away|funeral|broke up with me|dumped me|we broke up|got (?:fired|rejected|laid off|dumped)|didn['’]?t get (?:the|in|into)|(?:worst|rough|bad|hard|terrible|awful|long) (?:day|week|night)|can['’]?t (?:do this|cope|take (?:it|this))|want to cry|been crying|barely slept|couldn['’]?t sleep|haven['’]?t slept)\b`,
  'i'
);
/** Cross, with him or with something: he got it wrong, or it won't work. */
const CROSS =
  /(?:that['’]?s|that is|that was|it['’]?s|this is) not what i (?:said|asked|meant|wanted)|\bnot what i (?:said|asked|meant|wanted)\b|^\W*(?:no+|nope|ugh+|argh+|come on|seriously|jeez|damn it|dammit)\b[\s,!.]+(?:i said|i asked|i meant|not|wrong|that['’]?s|you|this|why)|\bi (?:said|asked for|meant)\b[^.?!]*\bnot\b|\byou(?:['’]re| are) not listening\b|\bwrong (?:one|app|thing|song|tab|site|page)\b|\bfor the (?:second|third|last|hundredth) time\b|\b(?:stupid|damn|freaking|bloody) (?:thing|wifi|wi-fi|laptop|computer|app|site|printer|internet)\b|\bkeeps (?:dropping|crashing|freezing|breaking|failing)\b|\bwon['’]?t (?:work|load|open|connect)\b/i;
/** Delighted. */
const GLAD =
  /!{2,}|\b(?:i (?:just )?got (?:the|in|into|an? |accepted|promoted)|i passed|i aced|i won|we won|got the (?:job|internship|offer|part|place)|let['’]?s go+|(?:so|really) (?:excited|happy|pumped|proud|stoked)|best (?:day|news)|(?:amazing|great|good|big) news|guess what)\b/i;

export const MOODS = Object.freeze(['hurried', 'low', 'cross', 'glad']);

/** Whether a line plainly shows one, and which: cross before low before hurried before glad. */
function shown(text) {
  const line = String(text ?? '');
  if (CROSS.test(line)) return 'cross';
  if (LOW.test(line)) return 'low';
  if (HURRY.test(line)) return 'hurried';
  return GLAD.test(line) ? 'glad' : '';
}

/** Someone low a moment ago still is: "yeah", after he asks, isn't said by someone who's fine again. */
const LASTS_MS = 5 * 60 * 1000;

/**
 * How they seem as they say `text`.
 * @param {string} text  what they just said
 * @param {{who:string, text:string, at?:string|number}[]} [history]  the conversation before it
 * @param {number} [now]
 * @returns {''|'hurried'|'low'|'cross'|'glad'}
 */
export function moodOf(text, history = [], now = Date.now()) {
  const here = shown(text);
  if (here) return here;
  const theirs = (Array.isArray(history) ? history : []).filter((entry) => entry?.who === 'you' || entry?.who === 'user');
  const last = theirs.at(-1);
  if (!last || shown(last.text) !== 'low') return '';
  const at = typeof last.at === 'number' ? last.at : Date.parse(last.at);
  // No time on it (a test's line, or an old log's): it's the line before, which is near enough.
  return !Number.isFinite(at) || now - at <= LASTS_MS ? 'low' : '';
}

/** What the model is told, in the brackets before their words: how they sound, and no more. His prompt says what to do about it. */
const LINES = Object.freeze({
  hurried: 'How they sound: in a hurry.',
  low: 'How they sound: low.',
  cross: 'How they sound: annoyed.',
  glad: 'How they sound: delighted.'
});
export const moodLine = (mood) => LINES[mood] || '';

/** How fast he speaks to it, against his usual 1: quicker to someone in a hurry, slower to someone low. */
const PACES = Object.freeze({ hurried: 1.08, low: 0.93, cross: 1, glad: 1.03 });
export const paceFor = (mood) => PACES[mood] || 1;
