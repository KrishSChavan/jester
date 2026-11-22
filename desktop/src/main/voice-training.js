/**
 * Training mode: his idea of the user's voice, built from what they say with their face on camera (the user,
 * 2026-11-22: "when the train mode is on every voice line it picks up while seeing my face from the camera should be
 * used to build the voice impression so when training mode is off he will be more confident that it is me when I
 * just speak anything to him").
 *
 * The voiceprint (voiceprint.js) is five sentences read once, close to the mic. Across a room, in another mood, or a
 * word long ("yes"), the user scores under it: on 2026-11-14 about half of what they said needed his name again, and
 * no bare yes of theirs ever scored as theirs. What's learned from use helps only a voice the voiceprint already
 * half-knows. A line said to the camera, with the user's own face talking with it (face-witness.js), is theirs
 * however it scores: it's kept, as a voice (the numbers the speaker model makes of it, which can't be played back or
 * turned into words), and every one kept so far makes his idea of them:
 *
 *   - the centroid: all of them at once, the user as they sound in their own room, which counts as the voiceprint
 *     does (voiceprint.js `scored`);
 *   - exemplars: up to EXEMPLARS of them, as different from each other as they come, the ways they sound;
 *   - and with no voiceprint yet, one's made once there's enough to go on (FIRST_CLIPS lines, FIRST_SECONDS of
 *     talking): reading the five sentences is then never needed. Only lines whose timing the camera checked count
 *     for it (`t`: face-witness.js, a line 1.5 s or longer): on a shorter one it saw only that the user's mouth
 *     moved, which it might while someone else talked, and with no voiceprint yet nothing else says whose voice it
 *     was.
 *
 * So that it can't drift to someone else's voice, a line counts only when the camera saw the user's own face talking
 * in time with it, never with his own voice over it, never one that sounds plainly unlike the voiceprint (FLOOR),
 * and, once there are a few, never one unlike the rest (FITS). Kept are the newest MOST_CLIPS.
 */

import { averageVoice, likeness } from './voiceprint.js';

export const TRAINING_KEY = 'voiceTrained';
/** Kept: the newest this many lines. */
export const MOST_CLIPS = 60;
/** With no voiceprint, one's made from what's kept once there are this many timed lines, this many seconds of them in all. */
export const FIRST_CLIPS = 6;
export const FIRST_SECONDS = 8;
/** Under this much talking (s), a line's voice is mostly the room. */
export const MIN_SPEECH = 0.4;
/** Against the voiceprint, a voice under this is someone else's, whatever the camera saw (the room scored up to 0.24). */
export const FLOOR = 0.2;
/** Once there are this many lines, one must be at least FITS like the rest of them. */
const FITS_FROM = 5;
export const FITS = 0.3;
/** How many of the ways they sound are kept for comparing with, and how alike two may be and both count. */
export const EXEMPLARS = 10;
const SAME = 0.85;

const valid = (clip) => clip && Array.isArray(clip.v) && clip.v.length > 8 && clip.v.every(Number.isFinite) && Number.isFinite(clip.s);
const rounded = (voice) => Array.from(voice, (value) => Math.round(value * 1e4) / 1e4);
/** A line the camera saw the user's mouth move in time with, not only move. */
const timed = (clip) => clip.t === 1;

/**
 * What the kept lines make of the user's voice: `centroid` (of the ones like the rest: `inliers` of them), the
 * `exemplars`, how many lines and seconds there are, and whether that's enough to stand for a voiceprint (`ready`):
 * `anchor`, the centroid of the `timed` ones alone, is what would.
 * @param {{v:number[], s:number, t?:1}[]} clips
 */
export function buildImpression(clips) {
  const kept = (clips || []).filter(valid);
  if (!kept.length) return null;
  let inliers = kept;
  if (kept.length >= FITS_FROM) {
    // Each against the rest without it: one that isn't like them was someone else, or the room.
    const fits = kept.filter((clip, i) => likeness(clip.v, averageVoice(kept.filter((_, j) => j !== i).map((other) => other.v))) >= FITS);
    if (fits.length >= 3) inliers = fits;
  }
  const centroid = averageVoice(inliers.map((clip) => clip.v));
  // The most typical first, then each time the one least like those chosen, until the rest add nothing new.
  const exemplars = [];
  const left = [...inliers].sort((a, b) => likeness(b.v, centroid) - likeness(a.v, centroid));
  if (left.length) exemplars.push(left.shift().v);
  while (exemplars.length < EXEMPLARS && left.length) {
    let pick = -1;
    let closest = Infinity;
    left.forEach((clip, i) => {
      const nearest = Math.max(...exemplars.map((known) => likeness(clip.v, known)));
      if (nearest < closest) {
        closest = nearest;
        pick = i;
      }
    });
    if (closest >= SAME) break;
    exemplars.push(left.splice(pick, 1)[0].v);
  }
  const seconds = inliers.reduce((sum, clip) => sum + clip.s, 0);
  const sure = inliers.filter(timed);
  const sureSeconds = sure.reduce((sum, clip) => sum + clip.s, 0);
  return {
    centroid,
    exemplars,
    clips: kept.length,
    inliers: inliers.length,
    seconds,
    timed: sure.length,
    anchor: sure.length ? averageVoice(sure.map((clip) => clip.v)) : null,
    ready: sure.length >= FIRST_CLIPS && sureSeconds >= FIRST_SECONDS
  };
}

/**
 * Whether a line is one to learn from, and if not, why not. `line` is what the speech service said of it (its
 * `voice`, `startedAt`, `endedAt` and, with a voiceprint, `enrolled`); `seen`, the camera's verdict (face-witness.js).
 * @returns {{ok:true, seconds:number}|{ok:false, why:string}}
 */
export function worthTraining(line, seen, { print = null, impression = null, overlapped = false } = {}) {
  if (!Array.isArray(line?.voice) || !line.voice.length) return { ok: false, why: 'no voice to learn' };
  const seconds = (Number(line.endedAt) - Number(line.startedAt)) / 1000;
  if (!(seconds >= MIN_SPEECH)) return { ok: false, why: 'too short' };
  if (overlapped) return { ok: false, why: 'his own voice is in it' };
  if (seen?.verdict !== 'speaking') return { ok: false, why: ({ silent: 'your mouth wasn’t moving', someone: 'that wasn’t your face', unseen: 'your face wasn’t in view', unclear: seen?.why || 'the camera couldn’t tell' })[seen?.verdict] || 'the camera didn’t say' };
  if (print && Number.isFinite(line.enrolled) && line.enrolled < FLOOR) return { ok: false, why: 'it sounds unlike your voiceprint' };
  if (impression && impression.clips >= FITS_FROM && likeness(line.voice, impression.centroid) < FITS) return { ok: false, why: 'it sounds unlike the rest' };
  return { ok: true, seconds };
}

/**
 * The lines kept, and what's made of them.
 * @param {object} deps
 * @param {{get:Function, set:Function, remove:Function}} deps.storage  where they're kept (sealed: chrome-bridge.js PRIVATE_KEYS)
 * @param {(line:{from:number, to:number}) => Promise<object|null>|object|null} deps.judge  the camera's verdict on a line
 * @param {(impression:object|null) => void|Promise<void>} deps.apply  his idea of the voice changed
 * @param {(report:{kept:number, clips:number}) => void} [deps.report]  a line was learned from
 * @param {() => boolean} deps.active  whether training mode is on, and has a face to go by
 */
export function createVoiceTrainer({ storage, judge, apply, report = () => undefined, active, log = () => undefined, now = Date.now }) {
  let clips = [];
  let impression = null;
  /** Lines learned from since this started: what Settings says. */
  let kept = 0;
  let loading = null;

  async function load() {
    const { [TRAINING_KEY]: stored } = await storage.get(TRAINING_KEY);
    clips = Array.isArray(stored?.clips) ? stored.clips.filter(valid).slice(-MOST_CLIPS) : [];
    kept = Number.isFinite(stored?.kept) ? stored.kept : clips.length;
    impression = buildImpression(clips);
    return impression;
  }

  return {
    /** What's kept, read again (at start, and after anything outside this changed it). */
    load() {
      loading = load();
      return loading;
    },
    get impression() {
      return impression;
    },
    get state() {
      return { kept, clips: clips.length, ready: !!impression?.ready };
    },
    /**
     * A line heard, judged and, when it's the user's, learned from.
     * @param {object} line  the speech service's `heard` or `stranger`
     * @param {{overlapped?:boolean, print?:ArrayLike<number>|null}} [about]
     * @returns {Promise<boolean>} whether it was kept
     */
    async heard(line, { overlapped = false, print = null } = {}) {
      if (!active() || !Array.isArray(line?.voice)) return false;
      await loading;
      if (!Number.isFinite(line.startedAt) || !Number.isFinite(line.endedAt)) return false;
      const seen = overlapped ? null : await Promise.resolve(judge({ from: line.startedAt, to: line.endedAt })).catch(() => null);
      const worth = worthTraining(line, seen, { print, impression, overlapped });
      const facts = seen ? ` (face ${seen.theirs ?? '?'}, mouth ${seen.motion ?? '?'}, in time ${seen.sync ?? '–'})` : '';
      if (!worth.ok) {
        log(`training: not learned from: ${worth.why}${facts}`);
        return false;
      }
      // `sync`: how the mouth moved with the sound, on a line long enough to tell (face-witness.js judgeLine).
      const clip = { v: rounded(line.voice), s: Math.round(worth.seconds * 100) / 100, at: now(), ...(Number.isFinite(seen?.sync) ? { t: 1 } : {}) };
      clips = [...clips, clip].slice(-MOST_CLIPS);
      kept += 1;
      const before = impression;
      impression = buildImpression(clips);
      await storage.set({ [TRAINING_KEY]: { clips, kept } });
      log(`training: learned from what you said${facts}: ${clips.length} kept${impression?.ready && !before?.ready ? ', enough to know your voice by' : ''}`);
      await apply(impression);
      report({ kept, clips: clips.length });
      return true;
    },
    /** All of it forgotten. */
    async forget() {
      clips = [];
      kept = 0;
      impression = null;
      await storage.remove(TRAINING_KEY);
      await apply(null);
      report({ kept: 0, clips: 0 });
    }
  };
}
