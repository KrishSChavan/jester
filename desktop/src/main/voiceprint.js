/**
 * Telling the user's voice from anyone else's. Five sentences read aloud become
 * a voiceprint: a list of numbers describing the voice, which can't be played back
 * or turned into words. It stays on this computer, sealed with the API keys.
 *
 * The thresholds started from TitaNet small on twelve synthetic voices (README),
 * where the same voice scored 0.75-0.9 and others 0.2. Through the MacBook's own
 * mic (dev.log, 2026-11-11 to 13) the user scored 0.42-0.74, a night at 0.42-0.51
 * leaving him deaf to them, while the rest of the room (videos, others) scored
 * -0.14-0.24, with a 0.31 and one long 0.40. Every score is still logged.
 */

/** Long enough each to give the model something to go on, and said the way he'll hear you. */
export const TEACHING_LINES = [
  'Jester, what does my day look like tomorrow?',
  'Hey Jester, open my notes and start a new list.',
  'Can you play something relaxing while I work on this?',
  'Jester, tell me something interesting about the ocean.',
  'Remind me what we were talking about a little while ago.'
];
/** What's been read must run at least this long to count. */
export const TEACHING_SECONDS = 1.2;

/** Scores at least this are the user: 1 is identical, 0 unrelated. */
export const MATCH = 0.5;
/** A word or two gives the model less to go on: "yes" must still be the user's, but it can't score as high. */
export const SHORT_MATCH = 0.4;
export const SHORT_SECONDS = 0.9;
/**
 * Below the user's bar but above the room's: maybe them, on a bad night for the mic. Such words are decoded and
 * count only when they start with his name, never as a "yes" or a follow-up: those are the user's alone.
 */
export const MAYBE = 0.35;

const unit = (values) => {
  const size = Math.hypot(...values);
  return values.map((value) => value / (size || 1));
};

/** One voiceprint from several takes, each counting the same however loud it was. */
export function averageVoice(takes) {
  const sum = new Array(takes[0].length).fill(0);
  for (const take of takes) unit(Array.from(take)).forEach((value, i) => (sum[i] += value));
  return unit(sum);
}

/** How alike two voices are, 1 at most. */
export function likeness(a, b) {
  let dot = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    sizeA += a[i] * a[i];
    sizeB += b[i] * b[i];
  }
  return dot / (Math.sqrt(sizeA * sizeB) || 1);
}

/**
 * Learning how the user sounds from use (2026-11-14). The voiceprint is five lines read once, close to the mic;
 * said from across the room, about half of what they say scores under MATCH (dev.log, 2026-11-14: 36 heard as
 * theirs, 38 as maybe), so it needs his name again mid-conversation. A voice heard as theirs in a turn he took is
 * kept as one more reference, and a voice scores as the best of them.
 *
 * So that the references can't wander off to someone else, one counts only for a voice the enrolled voiceprint
 * already half-knows (LEARN_GATE), and only such a voice is ever kept. On ten synthetic voices in a simulated room
 * (reverb, 20 dB of noise), the same voice was heard as itself 46% of the time against the voiceprint alone and
 * 76% with what it learned; other voices 0% and 2%, all of those from pairs that pass for each other read up close
 * too. Farther off than that (scores around 0.25) nothing helps: that's for push-to-talk.
 */
export const LEARN_GATE = 0.4;
/** The newest this many are kept: the room and the mic of last week, not of last year. */
export const LEARNED_MOST = 8;
/** Long enough to be worth keeping as how they sound. */
export const LEARN_SECONDS = 1.5;
/** As like one already kept as this, and it adds nothing. */
const SAME = 0.8;

/**
 * What training mode taught (voice-training.js): the user's voice as they talked with their face on camera, in their
 * own room, at their own distance from the mic: `centroid`, all of it, and `exemplars`, the ways it varied. The
 * centroid counts as the voiceprint does, being theirs as surely; an exemplar, for a voice already this like one of
 * the two, as a learned voice does for one the voiceprint half-knows. Lower than LEARN_GATE: a word or two ("yes")
 * scores lower than a sentence against anything, and it's the user's own short words, kept, that it's compared with.
 */
export const TRAINED_GATE = 0.3;

/**
 * How like the user a voice is: by the enrolled voiceprint or what training taught, the better, or, for a voice
 * that half-knows, by the best of what's been learned and the ways training heard it too.
 * @param {ArrayLike<number>|null} print  the voiceprint (taught, or made by training)
 * @param {{centroid?:ArrayLike<number>, exemplars?:ArrayLike<number>[]}|null} [trained]
 * @returns {{score:number, enrolled:number}}  score: what's judged; enrolled: the voiceprint's own word
 */
export function scored(voice, print, learned = [], trained = null) {
  const enrolled = print ? likeness(voice, print) : 0;
  const own = trained?.centroid?.length ? likeness(voice, trained.centroid) : -Infinity;
  const base = Math.max(enrolled, own);
  let score = base;
  if (base >= LEARN_GATE && learned?.length) score = Math.max(score, ...learned.map((known) => likeness(voice, known)));
  if (base >= TRAINED_GATE && trained?.exemplars?.length) score = Math.max(score, ...trained.exemplars.map((known) => likeness(voice, known)));
  return { score, enrolled };
}

/** Whether a voice heard as the user's is one more way they sound: theirs for sure, long enough, and not already kept. */
export function worthLearning(voice, { score, enrolled, seconds }, learned = []) {
  if (!(seconds >= LEARN_SECONDS) || !(score >= MATCH) || !(enrolled >= LEARN_GATE) || enrolled >= SAME) return false;
  return learned.every((known) => likeness(voice, known) < SAME);
}

/** What's learned with one more, the oldest let go past the most kept. */
export const withLearned = (learned, voice) => [...(Array.isArray(learned) ? learned : []), Array.from(voice)].slice(-LEARNED_MOST);

/** Whether this is the user. Short clips are given a lower bar. */
export const sounds = (score, seconds) => score >= (seconds < SHORT_SECONDS ? SHORT_MATCH : MATCH);

/** 'you', 'maybe' (only with his name) or 'stranger' (not even decoded). */
export const judged = (score, seconds) => (sounds(score, seconds) ? 'you' : score >= MAYBE ? 'maybe' : 'stranger');
