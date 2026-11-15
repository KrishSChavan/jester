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

/** Whether this is the user. Short clips are given a lower bar. */
export const sounds = (score, seconds) => score >= (seconds < SHORT_SECONDS ? SHORT_MATCH : MATCH);

/** 'you', 'maybe' (only with his name) or 'stranger' (not even decoded). */
export const judged = (score, seconds) => (sounds(score, seconds) ? 'you' : score >= MAYBE ? 'maybe' : 'stranger');
