/**
 * Training mode (2026-11-22): the user's face scanned once, then what they say facing the camera, mouth moving with
 * it, builds his idea of their voice, so that with it off he's surer it's them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { faceReading, faceShape, mouthOpening, shapeDistance, SHAPE_POINTS, SHAPE_SIZE } from '../jester-extension/src/common/face-print.js';
import { correlation, createFaceWitness, isTheirs, judgeLine, mouthMotion, moveWithSound, printFrom, tolerance, TOLERANCE_MIN } from '../desktop/src/main/face-witness.js';
import { buildImpression, createVoiceTrainer, FIRST_CLIPS, MOST_CLIPS, worthTraining } from '../desktop/src/main/voice-training.js';
import { averageVoice, likeness, scored, TRAINED_GATE } from '../desktop/src/main/voiceprint.js';
import { createRemoteHands } from '../desktop/src/main/remote-hands.js';
import { setupSteps } from '../desktop/src/main/setup.js';

// ——— Faces, made up ———

/** A face's sixteen points in centimetres (x right, y down, z away), and its lips: one person's build. */
const BUILD = {
  33: [-4.5, 0, 0], 133: [-1.6, 0, 0.4], 362: [1.6, 0, 0.4], 263: [4.5, 0, 0], 168: [0, -0.6, -0.6], 6: [0, 0.6, -1], 197: [0, 1.8, -1.6], 195: [0, 2.8, -2.1],
  1: [0, 4.2, -2.8], 98: [-1.4, 4.4, -1.4], 327: [1.4, 4.4, -1.4], 10: [0, -7.5, 0], 151: [0, -5, -0.5], 9: [0, -2, -0.6], 234: [-7, 1, 3], 454: [7, 1, 3]
};
/** Someone else: a longer nose, wider-set eyes, a narrower face. */
const OTHER = { ...BUILD, 33: [-5.2, 0, 0], 263: [5.2, 0, 0], 1: [0, 5.4, -3.2], 195: [0, 3.6, -2.4], 234: [-6.2, 1, 3], 454: [6.2, 1, 3], 10: [0, -6.6, 0] };

/**
 * A face as the tracker gives one: 478 points normalised to a 1280 × 720 picture, with the face `size` cm across
 * per 100 px, turned `yaw` radians, mouth open `open` (0 shut), a little noise.
 */
function face(build = BUILD, { yaw = 0, at = [640, 360], size = 1, open = 0, noise = 0, seed = 1 } = {}) {
  let random = seed;
  const jitter = () => {
    random = (random * 16807) % 2147483647;
    return ((random / 2147483647) * 2 - 1) * noise;
  };
  const lips = { 13: [0, 6.2 - open / 2, -1.6], 14: [0, 6.2 + open / 2, -1.6], 78: [-2.2, 6.2, -1], 308: [2.2, 6.2, -1] };
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const [index, [x, y, z]] of Object.entries({ ...build, ...lips })) {
    const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
    const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const px = at[0] + (rx + jitter()) * 10 * size;
    const py = at[1] + (y + jitter()) * 10 * size;
    points[index] = { x: px / 1280, y: py / 720, z: ((rz + jitter()) * 10 * size) / 1280 };
  }
  return points;
}
/** MediaPipe's transformation matrix for a head turned `yaw` radians (column-major; forward axis the third column). */
const matrix = (yaw = 0) => ({ data: [Math.cos(yaw), 0, Math.sin(yaw), 0, 0, 1, 0, 0, -Math.sin(yaw), 0, Math.cos(yaw), 0, 0, 0, -50, 1] });

test('a face’s shape: the same however near, wherever and however turned; another person’s isn’t', () => {
  const mine = faceShape(face(), 1280, 720);
  assert.equal(mine.length, SHAPE_SIZE);
  assert.equal(SHAPE_SIZE, (SHAPE_POINTS.length * (SHAPE_POINTS.length - 1)) / 2);
  assert.ok(shapeDistance(mine, faceShape(face(BUILD, { size: 1.6, at: [400, 300] }), 1280, 720)) < 0.002, 'nearer, elsewhere in the picture');
  assert.ok(shapeDistance(mine, faceShape(face(BUILD, { yaw: 0.35 }), 1280, 720)) < 0.002, 'turned, in 3D');
  assert.ok(shapeDistance(mine, faceShape(face(BUILD, { open: 2 }), 1280, 720)) < 1e-6, 'talking moves nothing it measures');
  assert.ok(shapeDistance(mine, faceShape(face(OTHER), 1280, 720)) > 0.06, 'someone else');
  assert.equal(faceShape(face().slice(0, 100), 1280, 720), null);
  assert.equal(faceShape(face(), 0, 720), null);
});

test('the mouth: how far open, shut to wide', () => {
  assert.ok(mouthOpening(face(BUILD, { open: 0 }), 1280, 720) < 0.01);
  assert.ok(Math.abs(mouthOpening(face(BUILD, { open: 1.1 }), 1280, 720) - 0.25) < 0.01);
  assert.equal(mouthOpening([], 1280, 720), null);
});

test('a reading: its shape only for a face square to the camera and near enough to tell', () => {
  const square = faceReading(face(), { width: 1280, height: 720, matrix: matrix(0) });
  assert.equal(square.shape.length, SHAPE_SIZE);
  assert.ok(square.span > 80);
  assert.equal(square.yaw, 0);
  assert.equal(faceReading(face(BUILD, { yaw: 0.7 }), { width: 1280, height: 720, matrix: matrix(0.7) }).shape, null, 'turned away: the far side is guessed at');
  assert.equal(faceReading(face(BUILD, { size: 0.4 }), { width: 1280, height: 720, matrix: matrix(0) }).shape, null, 'across the room: too small to tell');
  assert.ok(Number.isFinite(faceReading(face(BUILD, { size: 0.4 }), { width: 1280, height: 720, matrix: matrix(0) }).mouth), 'its mouth still read');
  assert.equal(faceReading(face().slice(0, 10), { width: 1280, height: 720 }), null);
});

// ——— The scan, and whose face it is ———

const reading = (build, options = {}) => faceReading(face(build, options), { width: 1280, height: 720, matrix: matrix(options.yaw || 0) });

test('the scan: the mean of its readings, the worst left out; then that face is theirs and another isn’t', () => {
  const shapes = Array.from({ length: 30 }, (_, i) => reading(BUILD, { noise: 0.05, seed: i + 1 }).shape);
  // A blink-ish reading, far off.
  shapes.push(reading(OTHER).shape);
  const print = printFrom(shapes);
  assert.equal(print.shape.length, SHAPE_SIZE);
  assert.ok(print.reads >= 24 && print.reads <= 31);
  assert.ok(print.spread > 0 && print.spread < 0.02, `${print.spread}`);
  assert.ok(tolerance(print) >= TOLERANCE_MIN);
  assert.ok(isTheirs(reading(BUILD, { noise: 0.05, seed: 99, yaw: 0.3 }).shape, print), 'theirs, turned a little, another time');
  assert.ok(!isTheirs(reading(OTHER, { noise: 0.05, seed: 7 }).shape, print), 'not theirs');
  assert.equal(printFrom(shapes.slice(0, 10)), null, 'too few to go on');
  assert.equal(printFrom([[1, 2, 3]]), null);
});

// ——— A line, judged ———

/** The face read 20 times a second over [from, to], its mouth opening and shutting `hz` times a second (0: still). */
function readings(build, from, to, { hz = 4, open = 1.6, shapeless = false, phase = 0 } = {}) {
  const out = [];
  for (let at = from; at <= to; at += 50) {
    const opening = hz ? (open * (1 + Math.sin(2 * Math.PI * hz * ((at - from) / 1000) + phase))) / 2 : 0.05;
    const read = reading(build, { open: opening, noise: 0.03, seed: at });
    out.push({ at, face: true, ...read, shape: shapeless ? null : read.shape });
  }
  return out;
}
/** The mic's loudness over [from, to], every 32 ms: loud as the mouth opens (`hz`, `phase`), or flat. */
function loudness(from, to, { hz = 4, phase = 0, flat = false } = {}) {
  const out = [];
  for (let at = from; at <= to; at += 32) out.push({ at, level: flat ? 0.05 : 0.02 + 0.1 * (1 + Math.sin(2 * Math.PI * hz * ((at - from) / 1000) + phase)) / 2 });
  return out;
}
const PRINT = printFrom(Array.from({ length: 30 }, (_, i) => reading(BUILD, { noise: 0.03, seed: i + 7 }).shape));

test('a line said with their face talking in time with it is theirs; everything else isn’t', () => {
  const line = { from: 10_000, to: 12_500 };
  const judge = (reads, sound = loudness(9_000, 13_500)) => judgeLine(line, { reads, loudness: sound, print: PRINT });
  const talking = judge(readings(BUILD, 9_500, 13_000));
  assert.equal(talking.verdict, 'speaking', JSON.stringify(talking));
  assert.ok(talking.sync > 0.5 && talking.theirs === 1 && talking.seen === 1);
  assert.equal(judge(readings(BUILD, 9_500, 13_000, { hz: 0 })).verdict, 'silent', 'their face, mouth still: someone else said it');
  assert.equal(judge(readings(OTHER, 9_500, 13_000)).verdict, 'someone', 'someone else’s face talking');
  assert.equal(judge([]).verdict, 'unseen');
  assert.equal(judge(readings(BUILD, 9_500, 10_400)).verdict, 'unseen', 'in view for a moment of it');
  // A mouth chewing while the television talks: moving, but not with what's heard.
  const chewing = judge(readings(BUILD, 9_500, 13_000, { hz: 1.3 }), loudness(9_000, 13_500, { hz: 4.7, phase: 1 }));
  assert.equal(chewing.verdict, 'unclear', JSON.stringify(chewing));
  assert.equal(judge(readings(BUILD, 9_500, 13_000), loudness(9_000, 13_500, { flat: true })).verdict, 'unclear', 'nothing heard with it');
  // Turned away the whole time: whose it is can't be told.
  assert.equal(judge(readings(BUILD, 9_500, 13_000, { shapeless: true })).verdict, 'unclear');
  // A word ("yes"): too short to tell timing by, a moving mouth will do.
  const yes = judgeLine({ from: 10_000, to: 10_500 }, { reads: readings(BUILD, 9_700, 10_800, { hz: 3 }), loudness: [], print: PRINT });
  assert.equal(yes.verdict, 'speaking', JSON.stringify(yes));
  assert.equal(judgeLine(line, { reads: readings(BUILD, 9_500, 13_000), loudness: loudness(9_000, 13_500), print: null }).verdict, 'unclear', 'no face scanned');
});

test('timing: the mouth and the sound agree at some lag within a third of a second; noise doesn’t', () => {
  assert.ok(correlation([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]) > 0.999);
  assert.equal(correlation([1, 2, 3], [1, 2, 3]), null, 'too few');
  assert.equal(correlation(Array(20).fill(1), Array.from({ length: 20 }, (_, i) => i)), null, 'a flat line correlates with nothing');
  const reads = readings(BUILD, 0, 3000).map(({ at, mouth }) => ({ at, mouth }));
  // The sound reaching here 150 ms later than the picture: still in time.
  assert.ok(moveWithSound(reads, loudness(150, 3150).map((frame) => ({ ...frame, at: frame.at })), 0, 3000) > 0.5);
  assert.ok(mouthMotion([0, 0.3, 0, 0.3, 0, 0.3]) > 0.25);
  assert.equal(mouthMotion([0.1]), null);
});

test('the witness: what the camera and the mic took in, judged by a line’s time, here or a server’s', () => {
  let time = 100_000;
  const seen = [];
  const witness = createFaceWitness({ now: () => time, onSeen: (who) => seen.push(who) });
  witness.setPrint(PRINT);
  for (const read of readings(BUILD, time, time + 3000)) {
    time = read.at;
    witness.read(read);
  }
  // The mic, as the voice page sends it: 2048 samples at a time, loud as the mouth opens.
  for (let at = 100_000; at <= 103_000; at += 128) {
    const samples = new Float32Array(2048);
    for (let i = 0; i < samples.length; i += 1) {
      const t = at - 128 + (i / 16000) * 1000;
      samples[i] = Math.sin(i / 3) * (0.02 + 0.1 * (1 + Math.sin(2 * Math.PI * 4 * ((t - 100_000) / 1000))) / 2);
    }
    witness.audio(samples, at);
  }
  assert.equal(witness.seen(), 'you');
  assert.deepEqual(seen, ['you']);
  assert.equal(witness.judge({ from: 100_300, to: 102_600 }).verdict, 'speaking');
  // The server's own clock is off by a minute: told how long ago, it's the same line.
  time = 103_000;
  assert.equal(witness.judgeAgo({ ago: 2_700 + 120, lasted: 2_300 }).verdict, 'speaking');
  // Another face comes into view.
  for (const read of readings(OTHER, 103_050, 105_000, { hz: 0 })) {
    time = read.at;
    witness.read(read);
  }
  assert.equal(witness.seen(), 'someone');
  time += 2000;
  witness.read({ at: time, face: false });
  assert.equal(witness.seen(), 'none');
  // A minute and a half on, it's all let go.
  time += 95_000;
  witness.read({ at: time, face: false });
  assert.equal(witness.judge({ from: 100_300, to: 102_600 }).verdict, 'unseen');
});

test('the scan, as the witness does it: done once there are enough readings, or stopped', async () => {
  let time = 0;
  const witness = createFaceWitness({ now: () => time });
  const progress = [];
  const scanning = witness.scan({ onProgress: (share) => progress.push(share) });
  assert.equal(witness.scanning, true);
  for (let i = 0; i < 60 && witness.scanning; i += 1) {
    time += 50;
    witness.read({ at: time, face: true, ...reading(BUILD, { noise: 0.03, seed: i + 3 }) });
  }
  const print = await scanning;
  assert.equal(print.shape.length, SHAPE_SIZE);
  assert.ok(progress.at(-1) >= 0.95 && progress[0] === 0);
  assert.ok(time >= 2500, 'it takes its few seconds');
  const stopped = witness.scan();
  witness.cancelScan();
  await assert.rejects(stopped, (err) => err.cancelled === true);
});

// ——— Voices, made up ———

/** A voice of 16 numbers: one speaker's own (`who`), a little different each time (`seed`). */
function voice(who, seed = 1, wobble = 0.35) {
  let random = seed * 7919 + who * 104729;
  const next = () => {
    random = (random * 16807) % 2147483647;
    return (random / 2147483647) * 2 - 1;
  };
  const base = Array.from({ length: 16 }, (_, i) => Math.sin((i + 1) * (who + 1) * 1.7));
  return averageVoice([base.map((value) => value + next() * wobble)]);
}
const clip = (who, seed, seconds = 2) => ({ v: voice(who, seed), s: seconds });

test('what the kept lines make of a voice: the like ones’ centroid, the ways they vary, and when it’s enough', () => {
  // As a real voice's lines are: alike, and never the same (the speaker model puts one person's at 0.5 to 0.8).
  const theirs = Array.from({ length: 8 }, (_, i) => ({ v: voice(1, i + 1, 0.9), s: 2 }));
  const impression = buildImpression([...theirs, clip(5, 3)]);
  assert.equal(impression.clips, 9);
  assert.equal(impression.inliers, 8, 'the one unlike the rest is left out');
  assert.ok(likeness(impression.centroid, voice(1, 50)) > likeness(impression.centroid, voice(5, 50)) + 0.3);
  assert.ok(impression.exemplars.length >= 2 && impression.exemplars.length <= 10);
  assert.equal(impression.ready, true);
  assert.equal(buildImpression(theirs.slice(0, FIRST_CLIPS - 1)).ready, false, 'too few lines');
  assert.equal(buildImpression(Array.from({ length: 8 }, (_, i) => clip(1, i + 1, 0.6))).ready, false, 'too little talking');
  assert.equal(buildImpression([]), null);
  assert.equal(buildImpression([{ v: [1, 2], s: 1 }]), null, 'nothing that’s a voice');
});

test('what training taught counts when a voice is scored: its centroid as the voiceprint does, its ways for a voice like them', () => {
  const impression = buildImpression(Array.from({ length: 8 }, (_, i) => clip(1, i + 1)));
  const print = voice(9, 1);
  const theirs = voice(1, 77);
  const before = scored(theirs, print).score;
  const after = scored(theirs, print, [], impression);
  assert.ok(after.score > before + 0.3, `${before} → ${after.score}`);
  assert.equal(after.enrolled, before, 'the voiceprint’s own word is unchanged');
  // Someone nothing like the user: nothing taught lifts them.
  const stranger = voice(4, 3);
  assert.ok(scored(stranger, print, [], impression).score < TRAINED_GATE + 0.2);
  assert.deepEqual(scored(theirs, print, [], null), scored(theirs, print), 'without training, as before');
});

test('a line is learned from only with their face talking, his own voice not in it, and like the rest', () => {
  const line = { voice: voice(1, 5), startedAt: 1000, endedAt: 3000, enrolled: 0.45 };
  const speaking = { verdict: 'speaking' };
  assert.deepEqual(worthTraining(line, speaking), { ok: true, seconds: 2 });
  assert.equal(worthTraining(line, { verdict: 'silent' }).why, 'your mouth wasn’t moving');
  assert.equal(worthTraining(line, { verdict: 'someone' }).why, 'that wasn’t your face');
  assert.equal(worthTraining(line, { verdict: 'unseen' }).why, 'your face wasn’t in view');
  assert.equal(worthTraining(line, { verdict: 'unclear', why: 'out of time' }).why, 'out of time');
  assert.equal(worthTraining(line, null).why, 'the camera didn’t say');
  assert.equal(worthTraining(line, speaking, { overlapped: true }).why, 'his own voice is in it');
  assert.equal(worthTraining({ ...line, endedAt: 1200 }, speaking).why, 'too short');
  assert.equal(worthTraining({ ...line, enrolled: 0.1 }, speaking, { print: [1] }).why, 'it sounds unlike your voiceprint');
  assert.equal(worthTraining({ ...line, enrolled: 0.1 }, speaking).ok, true, 'with no voiceprint, nothing to be unlike');
  const impression = buildImpression(Array.from({ length: 8 }, (_, i) => clip(1, i + 1)));
  assert.equal(worthTraining({ ...line, voice: voice(6, 2) }, speaking, { impression }).why, 'it sounds unlike the rest');
  assert.equal(worthTraining({ voice: null }, speaking).why, 'no voice to learn');
});

/** Storage, in memory. */
function memoryStorage(initial = {}) {
  const kept = { ...initial };
  return {
    kept,
    get: async (key) => (Array.isArray(key) ? Object.fromEntries(key.map((k) => [k, kept[k]])) : { [key]: kept[key] }),
    set: async (values) => void Object.assign(kept, JSON.parse(JSON.stringify(values))),
    remove: async (key) => void (Array.isArray(key) ? key : [key]).forEach((k) => delete kept[k])
  };
}

test('the trainer: lines kept as the camera says, his idea of the voice rebuilt each time, ready to be a voiceprint', async () => {
  const storage = memoryStorage();
  const applied = [];
  const reports = [];
  let verdict = 'speaking';
  let on = true;
  const asked = [];
  const trainer = createVoiceTrainer({ storage, active: () => on, judge: (line) => (asked.push(line), { verdict }), apply: (impression) => applied.push(impression), report: (report) => reports.push(report), now: () => 5 });
  await trainer.load();
  const heard = (seed, extra = {}) => trainer.heard({ voice: voice(1, seed), startedAt: seed * 10_000, endedAt: seed * 10_000 + 2000, seconds: 3.6, ...extra });
  assert.equal(await heard(1), true);
  assert.deepEqual(asked, [{ from: 10_000, to: 12_000 }], 'asked of the time it was said');
  assert.equal(storage.kept.voiceTrained.clips.length, 1);
  assert.ok(storage.kept.voiceTrained.clips[0].v.every((value) => Math.round(value * 1e4) === value * 1e4), 'kept as plain numbers, rounded');
  verdict = 'silent';
  assert.equal(await heard(2), false);
  verdict = 'speaking';
  assert.equal(await heard(3), true);
  assert.equal(await trainer.heard({ voice: voice(1, 4), startedAt: 1, endedAt: 3000 }, { overlapped: true }), false, 'his own voice over it');
  on = false;
  assert.equal(await heard(5), false, 'off: nothing is even asked of the camera');
  on = true;
  for (let seed = 6; applied.at(-1)?.ready !== true; seed += 1) assert.equal(await heard(seed), true);
  assert.ok(applied.at(-1).ready, 'enough to know them by');
  assert.equal(applied.at(-1).inliers, FIRST_CLIPS);
  assert.deepEqual(reports.at(-1), { kept: FIRST_CLIPS, clips: FIRST_CLIPS });
  // Read again, it's the same.
  const again = createVoiceTrainer({ storage, active: () => true, judge: () => ({ verdict }), apply: () => undefined });
  await again.load();
  assert.deepEqual(again.state, { kept: FIRST_CLIPS, clips: FIRST_CLIPS, ready: true });
  // Only the newest are kept.
  for (let seed = 100; seed < 100 + MOST_CLIPS + 5; seed += 1) await again.heard({ voice: voice(1, seed), startedAt: seed, endedAt: seed + 2000 });
  assert.equal(storage.kept.voiceTrained.clips.length, MOST_CLIPS);
  await again.forget();
  assert.equal(storage.kept.voiceTrained, undefined);
  assert.equal(again.impression, null);
});

// ——— On a server ———

test('on a server: the computers with training on are asked what their camera saw, by how long ago, and told how it went', async () => {
  let time = 50_000;
  const sent = [];
  const hands = createRemoteHands({ now: () => time });
  const client = (name) => ({ device: { id: name, name }, send: (frame) => sent.push([name, frame]) });
  const mac = client('mac');
  const other = client('other');
  hands.join(mac);
  hands.join(other);
  hands.frame(mac, { t: 'hands-state', switches: { training: true } });
  hands.frame(other, { t: 'hands-state', switches: { training: false } });
  const asking = hands.face({ from: 47_000, to: 49_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map(([name, frame]) => [name, frame.op, frame.ago, frame.lasted]), [['mac', 'face', 3000, 2000]], 'only the one with it on');
  hands.frame(mac, { t: 'hands-reply', id: sent[0][1].id, result: { verdict: 'speaking', theirs: 1 } });
  assert.deepEqual(await asking, { verdict: 'speaking', theirs: 1 });
  hands.trained({ kept: 4, clips: 4 });
  assert.deepEqual(sent.at(-1)[1].op, 'trained');
  assert.deepEqual([sent.at(-1)[0], sent.at(-1)[1].kept], ['mac', 4]);
  hands.frame(mac, { t: 'hands-reply', id: sent.at(-1)[1].id, result: true });
  hands.frame(mac, { t: 'hands-state', switches: { training: false } });
  assert.equal(await hands.face({ from: 1, to: 2 }), null, 'nobody watching');
});

test('getting started: a few seconds in front of the camera, on a computer only', () => {
  const step = setupSteps({}).find((one) => one.id === 'face');
  assert.equal(step.go, 'settings/assistant');
  assert.match(step.why, /^A few seconds in front of the camera/);
  assert.equal(setupSteps({ face: true }).find((one) => one.id === 'face').done, true);
  assert.equal(setupSteps({ web: true }).some((one) => one.id === 'face'), false, 'his website has no camera to scan with');
});
