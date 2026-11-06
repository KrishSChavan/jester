/**
 * Jester's ears and mouth while the continuous assistant is on: the always-on
 * mic, and the audio of what he says. A window nobody sees, opened with the
 * setting and closed without it, so the mic is only ever open when it should be.
 */

const { audio, status, onPlay } = window.jesterVoice;
/** The raw mic, as for a spoken command (src/preload/chrome-shim.cjs): what the recognizer was measured on. */
const MIC = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
/** A device that changed or went away is looked for again after this long. */
const REOPEN_MS = 1000;

let stream = null;
let context = null;
let reopening = null;
let player = null;

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

function stopPlaying() {
  player?.pause();
  player = null;
}

onPlay(({ id, bytes, type, stop }) => {
  stopPlaying();
  if (stop) return;
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const sound = new Audio(url);
  player = sound;
  const over = () => {
    URL.revokeObjectURL(url);
    if (player === sound) player = null;
    status({ ended: id });
  };
  sound.onended = over;
  sound.onpause = over;
  sound.onerror = over;
  sound.play().catch(over);
});

navigator.mediaDevices.addEventListener('devicechange', reopen);
openMic();
