/**
 * Speech recognition, in a process of its own.
 *
 * Runs as an Electron utilityProcess so a decode never stalls the main process,
 * which moves the cursor and draws the overlay. Audio arrives as 16 kHz mono
 * Float32 chunks; a voice-activity detector decides where the utterance ends,
 * and the recognizer turns it into text. Nothing leaves the machine.
 *
 * Messages in:  start {model} · begin · listen · speaking {on} · awaiting {ms} · voiceprint {print, learned?} · teaching {on} · keep {dir} · audio {samples} · end · abort · transcribe {samples}
 * Messages out: ready {model, loadMs} · speech/activity {startedAt, interrupt?, verified?, text?} · partial {text} · final {text, decodeMs} · wake · early {text, startedAt, unsure?} · resumed · heard {text, startedAt, decodeMs, afterMs, early?, score, enrolled, seconds, unsure?, voice?, learn?} · stranger {score, enrolled, seconds} · ended {startedAt} · error {detail}
 *
 * `begin` hears one command. `listen` never stops: every utterance comes out as
 * `heard`, for the continuous assistant, and only a second or so is kept in
 * between. While someone's still talking, the last couple of seconds of it
 * are read a few times a second for his name, wherever in a sentence it
 * comes, and `wake` says it's there: only that, never the words.
 * Nothing heard this way is saved, whatever JESTER_SAVE_SPEECH says, unless the
 * user has turned on keeping what he wasn't sure of (`keep {dir}`, Settings ›
 * Assistant and voice): then a voice that scored near theirs without being
 * taken as theirs is kept as a WAV with its score, the newest KEEP_MOST of
 * them, on this computer only, for tuning voiceprint.js against the real voice
 * (scripts/hear-check.mjs reads them).
 * With a voiceprint set, a voice that isn't the user's is never even decoded:
 * no text of what anyone else says exists, here or anywhere. One that's only
 * maybe theirs (voiceprint.js MAYBE) is, marked `unsure`: it needs his name.
 *
 * JESTER_SAVE_SPEECH=folder keeps each utterance as a WAV with what was
 * heard beside it, for comparing models on a real voice. Off unless set.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { judged, scored, worthLearning } from '../voiceprint.js';
import { named, wakesEarly } from '../wake.js';
import { modelDir, SPEECH_MODELS, VAD_MODEL, VOICE_MODEL } from './models.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;
/** Silero reads 512-sample windows. */
const WINDOW = 512;
const MIN_SPEECH_S = 0.2;
/** How long the speaker must be quiet before the utterance counts as over. */
const END_SILENCE_S = 0.6;
/**
 * A pause this long, while listening, may be the end: who's talking and what they've said is read then (`early`), so
 * whoever's listening can start thinking, and the utterance is still only over at END_SILENCE_S. Shorter than that
 * it can't simply be: of 91 real utterances kept (2026-11-15), a 0.45 s pause came mid-sentence in a fifth to a third.
 */
const EARLY_SILENCE_S = 0.3;
/** Partial text is re-decoded from the audio so far this often while someone talks. */
const PARTIAL_EVERY_MS = 500;
/**
 * Decoding starts this long before the detector fired. It fires a syllable or
 * two into the first word, so its own segment loses "lock" in "lock the screen".
 */
const PREROLL_S = 1;
/** voice.js gives up on a capture after 30 s; so does this. */
const MAX_CAPTURE_S = 30;
/**
 * Listening, an utterance ends on a pause, or at this length: a television or music the detector takes for a voice
 * would otherwise make one utterance that never ends, held in memory and decoded whole, with someone "talking" all
 * the while. The detectors are refreshed every VAD_REFRESH_S below it, so the pause they allow stays the same.
 */
const MAX_HEARD_S = 60;
/** Keep the native detectors below their 20 s limit, which otherwise shortens pauses and raises the threshold. */
const VAD_REFRESH_S = 10;
/** How often to tell the main process that the same utterance is still being spoken. */
const ACTIVITY_S = 1;
/** While Jester speaks, check for the user's interruption before the endpoint.
 * The detector has already heard MIN_SPEECH_S before these samples begin. */
const INTERRUPT_CHECK_S = 0.45;
/** A recent slice can detect the user joining an already-active speaker echo. */
const INTERRUPT_WINDOW_S = 1.2;
/**
 * While someone's talking, the last LOOK_S of it is read for his name every LOOK_EVERY_S, from LOOK_FIRST_S in: so
 * that he shows he's listening the moment he's named, wherever in a sentence that is (the user, 2026-11-21: "the
 * listening animation is only shown after my whole sentence is complete… show that he is listening the second his
 * name is heard"). Before, the start of an utterance was read twice, a second and two seconds in, and only a name
 * that came first counted: named a moment in, or last, he showed nothing until it was all said.
 *
 * Measured that day on this Mac (M4 Pro, two threads), over six synthetic voices saying his name first, in the
 * middle and last: heard in 36 of 36 within a quarter second of the name ending, and in none of 24 sentences
 * without it ("the gesture he made at Chester"); a look takes 22 ms with the Light model and 71 ms with Accurate.
 * A slower computer looks less often: never again sooner than LOOK_BUSY times as long as the last look took.
 * Past LOOK_FAST_S of one utterance (a television, a long story) it's once a second.
 */
const LOOK_S = 2;
const LOOK_EVERY_S = 0.25;
const LOOK_FIRST_S = 0.4;
const LOOK_BUSY = 2;
const LOOK_FAST_S = 15;
/** All that's kept before speech while listening: the preroll, and a little. */
const KEPT_WINDOWS = Math.ceil((PREROLL_S * SAMPLE_RATE) / WINDOW) + 2;
/** The detector counts samples in 32 bits and finds nothing past 37 hours of them (measured), so it starts over. */
const VAD_RESTART_S = 6 * 60 * 60;
/**
 * A word or two said in answer to a question of his ("yes", "Krish") is too short to tell whose voice it is. On
 * 2026-11-21 the bare yes-and-no clips kept on the user's server, six of them, scored 0.26 to 0.44 against their
 * voiceprint: three "maybe", three "not theirs" and so never read, and none "theirs", which is what leave to do
 * something asked for. So a spoken yes could not work ("he is unable to register my simple yes"). While he's
 * waiting on an answer (`awaiting`), a short utterance that ends once he's stopped speaking is read from
 * ANSWER_FLOOR up and passed as maybe theirs: whoever asked decides what a yes, a no or a name is worth, and screens
 * it against his own words. It may begin on his last word (ANSWER_EARLY_MS), as answers do, and no sooner: nothing
 * said while he's still speaking, or under most of a sentence of his, is given that room.
 */
const ANSWER_FLOOR = 0.2;
/** With the second kept before speech: about a second and a half of talking. */
const ANSWER_SECONDS = 2.6;
const ANSWER_EARLY_MS = 600;
const AWAIT_MOST_MS = 2 * 60 * 1000;
const SAVE_DIR = process.env.JESTER_SAVE_SPEECH || '';
/** Kept for tuning, when the user's said to: voices that scored at least this, and weren't plainly theirs. */
const KEEP_FLOOR = 0.2;
const KEEP_MOST = 200;

const port = process.parentPort;
const send = (message) => port.postMessage(message);

let recognizer = null;
let vad = null;
/** A second detector, quicker to call a pause: see EARLY_SILENCE_S. */
let soon = null;
let state = null;
/** Windows since the detector last started over. */
let sinceRestart = 0;
let decoding = false;
/** The newest utterance overheard while another was decoding. */
let waiting = null;
/** Each `listen` starts one: what was said before it doesn't count, however late its decode ends. */
let listens = 0;
let voices = null;
/** The user's voice, once known. */
let voiceprint = null;
/** Where what he wasn't sure of is kept for tuning, or '' when the user hasn't said to. */
let keepDir = '';
/** Other ways the user's been heard to sound, learned from use (voiceprint.js). */
let learned = [];
/** Reading the lines that make a voiceprint: each utterance comes with its voice. */
let teaching = false;
/** Playback is active: only then do the extra low-latency speaker/text checks. */
let speaking = false;
/** When his playback last ended, and until when an answer to a question of his is awaited (ANSWER_FLOOR). */
let quietSince = 0;
let awaitUntil = 0;

function freshState(listening = false) {
  // `windows` is everything since `begin`; `speechAt` the window where speech was first detected.
  // `ahead`: what was read at a pause that may be the end (readAhead), until they go on talking.
  // `lookAt`: how much must have been said before the next look for his name; `woke`: it's been heard in this one.
  return { carry: new Float32Array(0), windows: [], speechAt: -1, startedAt: null, activityAt: 0, interruptAt: 0, interrupting: false, interruptVerified: false, vadWindows: 0, lastPartialAt: 0, partialBusy: false, done: false, listening, lookAt: LOOK_FIRST_S * SAMPLE_RATE, lookMs: 0, woke: false, peeking: false, ahead: null };
}

/** The utterance: from just before speech was detected to now. */
function utterance() {
  if (state.speechAt < 0) return new Float32Array(0);
  const from = Math.max(0, state.speechAt - Math.round((PREROLL_S * SAMPLE_RATE) / WINDOW));
  return concat(state.windows.slice(from));
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function decode(samples) {
  const stream = recognizer.createStream();
  // A quarter second of silence either side helps short words like "mute".
  const pad = new Float32Array(SAMPLE_RATE / 4);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: concat([pad, samples, pad]) });
  const started = performance.now();
  const result = await recognizer.decodeAsync(stream);
  return { text: String(result?.text || '').trim(), decodeMs: Math.round(performance.now() - started) };
}

/** A speaker's voice as numbers, or null with no model or too little to go on. */
function voiceOf(samples) {
  if (!voices) return null;
  const stream = voices.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  // Not an external buffer: Electron has none (see README, sherpa-onnx).
  return voices.isReady(stream) ? voices.compute(stream, false) : null;
}

function start(modelName) {
  const model = SPEECH_MODELS[modelName];
  if (!model || model.kind !== 'offline') throw new Error(`"${modelName}" is not an offline speech model`);
  const started = performance.now();
  recognizer = new sherpa.OfflineRecognizer(model.config(modelDir(modelName)));
  soon = new sherpa.Vad({ sileroVad: { model: VAD_MODEL, threshold: 0.5, minSilenceDuration: EARLY_SILENCE_S, minSpeechDuration: MIN_SPEECH_S, windowSize: WINDOW, maxSpeechDuration: 20 }, sampleRate: SAMPLE_RATE, numThreads: 1, provider: 'cpu', debug: 0 }, 30);
  vad = new sherpa.Vad({
    sileroVad: { model: VAD_MODEL, threshold: 0.5, minSilenceDuration: END_SILENCE_S, minSpeechDuration: MIN_SPEECH_S, windowSize: WINDOW, maxSpeechDuration: 20 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  }, 30);
  // Without its model, everyone's heard, as before it existed.
  if (fs.existsSync(VOICE_MODEL)) voices = new sherpa.SpeakerEmbeddingExtractor({ model: VOICE_MODEL, numThreads: 1, debug: 0, provider: 'cpu' });
  state = freshState();
  send({ type: 'ready', model: modelName, loadMs: Math.round(performance.now() - started) });
}

async function finish(samples) {
  if (state.done) return;
  state.done = true;
  const { text, decodeMs } = samples.length ? await decode(samples) : { text: '', decodeMs: 0 };
  if (SAVE_DIR && samples.length) save(samples, text);
  send({ type: 'final', text, decodeMs });
}

function save(samples, text) {
  try {
    const name = path.join(SAVE_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    sherpa.writeWave(`${name}.wav`, { samples, sampleRate: SAMPLE_RATE });
    fs.writeFileSync(`${name}.txt`, `${text}\n`);
  } catch (err) {
    console.error('could not save the utterance:', err.message);
  }
}

/**
 * Keeps a voice he wasn't sure of, for tuning: its sound, and beside it what it scored and how it was judged. What
 * was said is there only for a voice that was decoded anyway (maybe the user's). The oldest go past KEEP_MOST.
 */
function keepUnsure(samples, facts) {
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    const name = path.join(keepDir, new Date().toISOString().replace(/[:.]/g, '-'));
    sherpa.writeWave(`${name}.wav`, { samples, sampleRate: SAMPLE_RATE });
    fs.writeFileSync(`${name}.json`, `${JSON.stringify(facts)}\n`);
    const kept = fs.readdirSync(keepDir).filter((file) => file.endsWith('.wav')).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_MOST))) {
      fs.rmSync(path.join(keepDir, old), { force: true });
      fs.rmSync(path.join(keepDir, old.replace(/\.wav$/, '.json')), { force: true });
    }
  } catch (err) {
    console.error('could not keep the utterance:', err.message);
  }
}

/** Decodes off the audio's path, so nothing said meanwhile is lost. Falling behind keeps only the newest. */
async function overheard(samples, ahead = null, startedAt = null) {
  const during = listens;
  if (decoding) {
    waiting = { samples, ahead, startedAt, during };
    return;
  }
  decoding = true;
  try {
    for (let next = { samples, ahead, startedAt, during }; next; ) {
      await hear(next.samples, next.ahead, next.startedAt, next.during);
      next = waiting;
      waiting = null;
    }
  } finally {
    decoding = false;
  }
}

/** Who it was, then, if that's someone to listen to, what they said: a stranger's words aren't read. */
async function judge(samples, startedAt = null) {
  const seconds = samples.length / SAMPLE_RATE;
  const voice = voiceprint || teaching ? voiceOf(samples) : null;
  const { score, enrolled } = voiceprint ? (voice ? scored(voice, voiceprint, learned) : { score: 0, enrolled: 0 }) : { score: null, enrolled: null };
  let who = voiceprint && !teaching ? judged(score, seconds) : 'you';
  // A short answer to what he's just asked, ended once he'd stopped: read, and whoever asked says what it's worth.
  const answer = who === 'stranger' && !speaking && seconds <= ANSWER_SECONDS && score >= ANSWER_FLOOR && Number.isFinite(startedAt) && startedAt <= awaitUntil && startedAt >= quietSince - ANSWER_EARLY_MS;
  if (answer) who = 'maybe';
  if (who === 'stranger') return { seconds, voice, score, enrolled, who };
  return { seconds, voice, score, enrolled, who, ...(await decode(samples)) };
}

/** An utterance that's over, told. `ahead`: it was read at its last pause (readAhead), and nothing was said after. */
async function hear(samples, ahead, startedAt, during) {
  const began = performance.now();
  const early = ahead ? await ahead.catch(() => null) : null;
  const { seconds, voice, score, enrolled, who, text, decodeMs } = early || (await judge(samples, startedAt));
  if (during !== listens) return;
  const round = (value) => Math.round(value * 1000) / 1000;
  if (who === 'stranger') {
    if (keepDir && score >= KEEP_FLOOR) keepUnsure(samples, { who, score: round(score), enrolled: round(enrolled), seconds: round(seconds) });
    return send({ type: 'stranger', startedAt, score, enrolled, seconds });
  }
  if (keepDir && who === 'maybe') keepUnsure(samples, { who, score: round(score), enrolled: round(enrolled), seconds: round(seconds), text });
  if (!text) return send({ type: 'ended', startedAt });
  // The voice goes along while teaching, and when it's one more way the user sounds: kept only if this was for him.
  const keep = !!voice && (teaching || (who === 'you' && !!voiceprint && worthLearning(voice, { score, enrolled, seconds }, learned)));
  // afterMs: how long after the last word this is: the pause that ended it, then telling whose voice and what it said.
  // early: these are the words told at the pause, so what was begun on them then is this utterance's.
  return send({ type: 'heard', text, startedAt, decodeMs, afterMs: Math.round(END_SILENCE_S * 1000 + performance.now() - began), ...(early ? { early: true } : {}), score, enrolled, seconds, ...(who === 'maybe' ? { unsure: true } : {}), ...(keep ? { voice: Array.from(voice), ...(teaching ? {} : { learn: true }) } : {}) });
}

/** One utterance over, and straight on to the next. */
function endOverheard() {
  const samples = utterance();
  // What was read at the pause is what was said, when nothing was said after it.
  const ahead = state.ahead;
  const startedAt = state.startedAt;
  state = freshState(true);
  if (samples.length) overheard(samples, ahead, startedAt).catch((err) => send({ type: 'error', startedAt, detail: String(err?.message || err) }));
}

/**
 * A pause that may be the end of what's being said: whose voice it is and what it said are read now, and told as
 * `early` when it's someone to listen to. If nothing more is said, that reading is the utterance's own (hear), so
 * it's `heard` the moment the pause has lasted END_SILENCE_S, with nothing left to read.
 */
function readAhead() {
  const during = state;
  const samples = utterance();
  if (!samples.length) return;
  const read = judge(samples, during.startedAt);
  during.ahead = read;
  read
    .then((got) => {
      if (state !== during || during.ahead !== read || got.who === 'stranger' || !got.text) return;
      send({ type: 'early', text: got.text, startedAt: during.startedAt, ...(got.who === 'maybe' ? { unsure: true } : {}) });
    })
    .catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
}

/**
 * Whether his name is in what's just been said: the last LOOK_S of it. Not while teaching, nor while the last
 * utterance is still decoding; and a voiceprint keeps everyone else's words from being decoded here too, so the
 * voice is judged first and a stranger's is left unread. From the start of what's being said, the words that stand
 * for his name there count as well ("Just open…", "Jay, …": wake.js wakesEarly); further in, only his own name.
 */
async function look() {
  const during = state;
  const began = performance.now();
  during.peeking = true;
  try {
    const all = utterance();
    const whole = all.length <= LOOK_S * SAMPLE_RATE;
    const samples = whole ? all : all.subarray(all.length - LOOK_S * SAMPLE_RATE);
    if (voiceprint) {
      // Only his name wakes him early, so maybe the user's will do.
      const voice = voiceOf(samples);
      if (judged(voice ? scored(voice, voiceprint, learned).score : 0, samples.length / SAMPLE_RATE) === 'stranger') return;
    }
    const { text } = await decode(samples);
    if (state !== during || during.woke || !(named(text) || (whole && wakesEarly(text)))) return;
    during.woke = true;
    send({ type: 'wake', startedAt: during.startedAt });
  } finally {
    during.peeking = false;
    during.lookMs = performance.now() - began;
  }
}

/**
 * A raw VAD event may be Jester's own loudspeaker. With a voiceprint, only a
 * confident match can interrupt; without one, send actual partial words for
 * the conversation to compare with the line currently playing. No audio is
 * reset or consumed: the full utterance still reaches readAhead/hear later.
 */
async function checkInterruption() {
  const during = state;
  const listening = listens;
  during.interrupting = true;
  try {
    const from = Math.max(0, during.speechAt - Math.ceil(MIN_SPEECH_S * SAMPLE_RATE / WINDOW),
      during.windows.length - Math.ceil(INTERRUPT_WINDOW_S * SAMPLE_RATE / WINDOW));
    const samples = concat(during.windows.slice(from));
    const seconds = samples.length / SAMPLE_RATE;
    const current = () => state === during && listens === listening && !during.done && speaking && !teaching;
    if (voiceprint) {
      const voice = voiceOf(samples);
      if (!voice) return;
      const { score, enrolled } = scored(voice, voiceprint, learned);
      if (!current() || judged(score, seconds) !== 'you') return;
      during.interruptVerified = true;
      send({ type: 'activity', startedAt: during.startedAt, interrupt: true, verified: true, unsure: false, score, enrolled, seconds });
      return;
    }
    const { text } = await decode(samples);
    if (!current() || !text) return;
    // Repeat text checks until playback stops: a first slice may have been
    // only echo, with the user starting later in the same VAD segment.
    send({ type: 'activity', startedAt: during.startedAt, interrupt: true, verified: false, unsure: false, text, seconds });
  } finally {
    during.interrupting = false;
  }
}

/** One more window of listening: quiet ones aren't kept. */
function keepListening() {
  sinceRestart += 1;
  if (state.speechAt >= 0) {
    const said = (state.windows.length - state.speechAt) * WINDOW;
    if (said >= MAX_HEARD_S * SAMPLE_RATE) return endOverheard();
    if (said - state.activityAt >= ACTIVITY_S * SAMPLE_RATE) {
      state.activityAt = said;
      send({ type: 'activity', startedAt: state.startedAt });
    }
    if (speaking && !teaching && !decoding && !state.peeking && !state.interrupting && !state.interruptVerified &&
      said - state.interruptAt >= INTERRUPT_CHECK_S * SAMPLE_RATE) {
      state.interruptAt = said;
      checkInterruption().catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
    }
    // A native detector holds its own audio and tightens its endpoint after 20 s.
    // Refresh it during ongoing speech, replaying a second to preserve a pause
    // already in progress. The utterance's audio and start time stay intact.
    state.vadWindows += 1;
    if (state.vadWindows * WINDOW >= VAD_REFRESH_S * SAMPLE_RATE && vad.isDetected() && soon?.isDetected()) {
      const recent = state.windows.slice(-Math.ceil(PREROLL_S * SAMPLE_RATE / WINDOW));
      vad.reset();
      soon.reset();
      for (const window of recent) {
        vad.acceptWaveform(window);
        soon.acceptWaveform(window);
      }
      // Segments wholly within the replay were already handled on the first pass.
      while (!vad.isEmpty()) vad.pop();
      while (!soon.isEmpty()) soon.pop();
      state.vadWindows = recent.length;
      sinceRestart = recent.length;
    }
    // Not while he's speaking: what's heard then is mostly him, and talking over him has its own check above.
    if (!teaching && !speaking && !decoding && !state.woke && !state.peeking && !state.interrupting && said >= state.lookAt) {
      // The next one no sooner than a slow computer can keep up with, and seldom once this has gone on a while.
      const gap = Math.max(said >= LOOK_FAST_S * SAMPLE_RATE ? 1 : LOOK_EVERY_S, (state.lookMs / 1000) * LOOK_BUSY);
      state.lookAt = said + gap * SAMPLE_RATE;
      look().catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
    }
    return;
  }
  if (state.windows.length > KEPT_WINDOWS) state.windows.shift();
  if (sinceRestart * WINDOW >= VAD_RESTART_S * SAMPLE_RATE) {
    vad.reset();
    soon?.reset();
    sinceRestart = 0;
  }
}

async function partial() {
  if (state.partialBusy || state.done || state.speechAt < 0) return;
  state.partialBusy = true;
  try {
    const { text } = await decode(utterance());
    if (!state.done && text) send({ type: 'partial', text });
  } finally {
    state.partialBusy = false;
  }
}

async function audio(samples) {
  if (!vad || state.done) return;
  let buffer = concat([state.carry, samples]);
  let at = 0;
  for (; at + WINDOW <= buffer.length; at += WINDOW) {
    const window = buffer.slice(at, at + WINDOW);
    state.windows.push(window);
    vad.acceptWaveform(window);
    if (vad.isDetected() && state.speechAt < 0) {
      state.speechAt = state.windows.length - 1;
      // Account for the detector's minimum speech and the rest of this audio
      // packet: starting just before the reply window closes still counts.
      state.startedAt = Math.round(Date.now() - ((buffer.length - at - WINDOW) / SAMPLE_RATE + MIN_SPEECH_S) * 1000);
      send({ type: 'speech', startedAt: state.startedAt });
    }
    if (state.listening && soon) {
      soon.acceptWaveform(window);
      // They've gone on talking: what was read at the pause was only part of it.
      if (state.ahead && soon.isDetected()) {
        state.ahead = null;
        send({ type: 'resumed' });
      }
      if (!soon.isEmpty()) {
        while (!soon.isEmpty()) soon.pop();
        // Not over another reading: one utterance is read at a time.
        if (state.speechAt >= 0 && !state.ahead && !teaching && !decoding && !state.peeking && !state.interrupting && vad.isEmpty()) readAhead();
      }
    }
    // The detector hands back a segment once the speaker has been quiet for
    // END_SILENCE_S: that is the end of the command. Only its timing is
    // used — see PREROLL_S.
    if (!vad.isEmpty()) {
      while (!vad.isEmpty()) vad.pop();
      if (state.listening) {
        endOverheard();
        continue;
      }
      await finish(utterance());
      return;
    }
    if (state.listening) {
      keepListening();
      continue;
    }
    if (state.windows.length * WINDOW >= MAX_CAPTURE_S * SAMPLE_RATE) {
      await finish(utterance());
      return;
    }
  }
  state.carry = buffer.slice(at);
  if (!state.listening && state.speechAt >= 0 && performance.now() - state.lastPartialAt >= PARTIAL_EVERY_MS) {
    state.lastPartialAt = performance.now();
    partial().catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
  }
}

port.on('message', async ({ data }) => {
  try {
    switch (data?.type) {
      case 'start':
        start(data.model);
        break;
      case 'begin':
        vad?.reset();
        state = freshState();
        break;
      case 'voiceprint':
        voiceprint = data.print ? Float32Array.from(data.print) : null;
        learned = voiceprint && Array.isArray(data.learned) ? data.learned.map((voice) => Float32Array.from(voice)) : [];
        break;
      case 'speaking':
        if (speaking && data.on !== true) quietSince = Date.now();
        speaking = data.on === true;
        break;
      case 'awaiting':
        awaitUntil = data.ms > 0 ? Date.now() + Math.min(Number(data.ms), AWAIT_MOST_MS) : 0;
        break;
      case 'teaching':
        teaching = !!data.on;
        break;
      case 'keep':
        keepDir = typeof data.dir === 'string' ? data.dir : '';
        break;
      case 'listen':
        vad?.reset();
        soon?.reset();
        listens += 1;
        waiting = null;
        sinceRestart = 0;
        state = freshState(true);
        break;
      // A capture called off: forget it, say nothing.
      case 'abort':
        vad?.reset();
        state = { ...freshState(), done: true };
        break;
      case 'audio':
        await audio(data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples));
        break;
      case 'end':
        // Capture ended (gesture, timeout) before the speaker went quiet.
        if (vad && !state.done) {
          vad.flush();
          while (!vad.isEmpty()) vad.pop();
          await finish(utterance());
        }
        break;
      case 'transcribe':
        send({ type: 'final', ...(await decode(new Float32Array(data.samples))) });
        break;
      default:
        break;
    }
  } catch (err) {
    send({ type: 'error', detail: String(err?.message || err) });
  }
});
