/**
 * Jester's ears and mouth while the continuous assistant is on: the always-on
 * mic, and the audio of what he says. A window nobody sees, opened with the
 * setting and closed without it, so the mic is only ever open when it should be.
 */

const { audio, status, onPlay } = window.jesterVoice;
/** The continuous mic hears the user while this same page plays Jester's
 * voice. Browser echo cancellation keeps that output out of incoming speech. */
const MIC = { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false };
/** A device that changed or went away is looked for again after this long. */
const REOPEN_MS = 1000;

let stream = null;
let context = null;
let reopening = null;

function closeMic() {
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
  stream = null;
  Promise.resolve(context?.close()).catch(() => undefined);
  context = null;
}

function reopen() {
  clearTimeout(reopening);
  reopening = setTimeout(openMic, REOPEN_MS);
}

async function openMic() {
  closeMic();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
    // The recognizer wants 16 kHz mono; the audio context resamples to it.
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('../worklets/speech-capture.js');
    const tap = new AudioWorkletNode(context, 'jester-speech-capture');
    tap.port.onmessage = ({ data }) => audio(data);
    context.createMediaStreamSource(stream).connect(tap);
    // Connected through, so the graph keeps pulling it; it outputs silence.
    tap.connect(context.destination);
    await context.resume();
    const [track] = stream.getAudioTracks();
    track.onended = reopen;
    status({ mic: track.label || 'open' });
  } catch (error) {
    closeMic();
    status({ mic: `not open: ${error?.message || error}` });
    reopen();
  }
}

/**
 * His voice, through one audio context that stays open while he talks: each piece of a line is started on the
 * context's own clock the moment the one before it ends. A new player per piece, started once main had heard the last
 * one end, left a pause at the end of every sentence (2026-11-19).
 */
/** With nothing said for this long, the output is let go: the next line opens it again. */
const OUTPUT_IDLE_MS = 30000;
let output = null;
/** What's playing or waiting its turn: {id, source}. */
let sounds = [];
/** When, on the output's clock, what's been given to it ends. */
let endsAt = 0;
let idleTimer = null;
/** Counted up by a stop and by a line that isn't queued: a piece still being got ready from before is dropped. */
let generation = 0;

function stopPlaying() {
  generation += 1;
  const over = sounds;
  sounds = [];
  endsAt = 0;
  for (const { id, source } of over) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Never started.
    }
    status({ ended: id });
  }
}

function idle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sounds.length) return idle();
    Promise.resolve(output?.close()).catch(() => undefined);
    output = null;
  }, OUTPUT_IDLE_MS);
}

/** A 16-bit mono WAV (main/voice/voices.js wav()) as an AudioBuffer: read here, so nothing waits on a decoder. */
function wavBuffer(bytes, into) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = data.byteLength >= 44 && data.getUint32(0, false) === 0x52494646 && data.getUint16(20, true) === 1 && data.getUint16(22, true) === 1 && data.getUint16(34, true) === 16;
  if (!pcm) return null;
  const rate = data.getUint32(24, true);
  const count = Math.floor(Math.min(data.getUint32(40, true), data.byteLength - 44) / 2);
  const buffer = into.createBuffer(1, Math.max(1, count), rate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < count; index++) channel[index] = data.getInt16(44 + index * 2, true) / 32768;
  return buffer;
}

async function play({ id, bytes, type, queued }) {
  if (!queued) stopPlaying();
  const mine = generation;
  clearTimeout(idleTimer);
  const ended = () => {
    sounds = sounds.filter((sound) => sound.id !== id);
    status({ ended: id });
    idle();
  };
  try {
    output ||= new AudioContext({ latencyHint: 'interactive' });
    const context = output;
    if (context.state !== 'running') await context.resume();
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = wavBuffer(raw, context) || (await context.decodeAudioData(raw.slice().buffer));
    if (context !== output || mine !== generation) return ended();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(context.currentTime, endsAt);
    endsAt = at + buffer.duration;
    sounds.push({ id, source });
    source.onended = ended;
    source.start(at);
  } catch (error) {
    console.error('voice: couldn’t play', error?.message || error, type);
    ended();
  }
}

onPlay((sound) => {
  if (sound.stop) return stopPlaying();
  play(sound);
});

navigator.mediaDevices.addEventListener('devicechange', reopen);
openMic();
