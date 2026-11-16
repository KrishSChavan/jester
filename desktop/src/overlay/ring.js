/**
 * A ringing timer's pill (src/main/ring-page.js): it rings from the moment
 * it's loaded until its window is closed, which is how it's stopped. The click
 * on Stop goes to the main process, which closes it.
 *
 * The ring is made here, not played from a file: three short notes and a rest,
 * over and over. The rest is long enough for "stop" to be heard in.
 */

const $ = (id) => document.getElementById(id);

let label = 'Timer';
try {
  label = decodeURIComponent(location.hash.slice(1)) || label;
} catch {
  /* a name that doesn't decode: "Timer" */
}
$('what').textContent = label;
$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/ring', op: 'stop' }).catch(() => undefined));

/** Seconds from one group of notes to the next. */
const EVERY = 2;
/** When each note of a group starts, and its pitch: a rising three, like a kitchen timer's. */
const NOTES = [
  [0, 1568],
  [0.16, 1568],
  [0.32, 2093]
];
const NOTE_SECONDS = 0.11;

const audio = new AudioContext();
const out = audio.createGain();
out.gain.value = 0.32;
out.connect(audio.destination);

function group(at) {
  for (const [after, pitch] of NOTES) {
    const tone = audio.createOscillator();
    const shape = audio.createGain();
    tone.type = 'sine';
    tone.frequency.value = pitch;
    // In and out over a few milliseconds, so a note doesn't click.
    shape.gain.setValueAtTime(0, at + after);
    shape.gain.linearRampToValueAtTime(1, at + after + 0.008);
    shape.gain.setValueAtTime(1, at + after + NOTE_SECONDS - 0.02);
    shape.gain.linearRampToValueAtTime(0, at + after + NOTE_SECONDS);
    tone.connect(shape).connect(out);
    tone.start(at + after);
    tone.stop(at + after + NOTE_SECONDS + 0.01);
  }
}

// Scheduled a little ahead by the audio clock, which keeps time where a page's timers drift.
let next = audio.currentTime + 0.05;
function ahead() {
  while (next < audio.currentTime + 1) {
    group(next);
    next += EVERY;
  }
}
audio.resume().catch(() => undefined);
// For a check: whether sound is being made at all (it may be muted, which is the window's business).
window.jesterRing = { state: () => audio.state, groups: () => Math.round((next - 0.05) / EVERY) };
ahead();
setInterval(ahead, 250);
