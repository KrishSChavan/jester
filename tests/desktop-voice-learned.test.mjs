import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { judged, LEARN_GATE, LEARN_SECONDS, LEARNED_MOST, likeness, MATCH, scored, withLearned, worthLearning } from '../desktop/src/main/voiceprint.js';

/** A unit voice at `angle` (radians) from [1, 0, 0] in the plane of the first two numbers: its likeness to that is cos(angle). */
const at = (angle, lift = 0) => [Math.cos(angle) * Math.cos(lift), Math.sin(angle) * Math.cos(lift), Math.sin(lift)];
const PRINT = at(0);
const angleFor = (score) => Math.acos(score);

test('a voice scores by the voiceprint, or by the best of what was learned when the voiceprint half-knows it', () => {
  // Across the room: 0.45 by the voiceprint, so only "maybe" on its own.
  const far = at(angleFor(0.45));
  assert.equal(judged(scored(far, PRINT).score, 2), 'maybe');
  // Heard like that before, and kept: the same way of sounding is theirs outright.
  const learned = [at(angleFor(0.47))];
  const told = scored(far, PRINT, learned);
  assert.ok(told.score > 0.99, 'as like the learned one as can be');
  assert.ok(Math.abs(told.enrolled - 0.45) < 1e-9, 'and what the voiceprint itself says is still told');
  assert.equal(judged(told.score, 2), 'you');
  // Nothing learned, or no voice to compare: the voiceprint's word.
  assert.deepEqual(scored(far, PRINT, []), { score: likeness(far, PRINT), enrolled: likeness(far, PRINT) });
});

test('what was learned never counts for a voice the voiceprint doesn’t half-know', () => {
  // Someone else: 0.3 by the voiceprint, but as like a learned voice as can be (a recording of it, say).
  const other = at(angleFor(0.3));
  const told = scored(other, PRINT, [other]);
  assert.ok(Math.abs(told.score - 0.3) < 1e-9, 'the voiceprint’s score, whatever was learned');
  assert.equal(judged(told.score, 3), 'stranger');
  // Just under the gate is out, at it is in.
  const under = at(angleFor(LEARN_GATE - 0.01));
  const on = at(angleFor(LEARN_GATE + 0.001));
  assert.ok(scored(under, PRINT, [under]).score < LEARN_GATE);
  assert.ok(scored(on, PRINT, [on]).score > 0.99);
});

test('a voice is kept only when it’s theirs for sure, long enough, half-known to the voiceprint and not kept already', () => {
  const far = at(angleFor(0.45));
  const heard = (more) => ({ score: 0.6, enrolled: 0.45, seconds: 2, ...more });
  assert.equal(worthLearning(far, heard(), []), true);
  assert.equal(worthLearning(far, heard({ seconds: LEARN_SECONDS - 0.1 }), []), false, 'a word or two says too little');
  assert.equal(worthLearning(far, heard({ score: MATCH - 0.01 }), []), false, 'only maybe theirs');
  assert.equal(worthLearning(far, heard({ enrolled: LEARN_GATE - 0.01 }), []), false, 'the voiceprint doesn’t half-know it');
  assert.equal(worthLearning(far, heard({ enrolled: 0.85, score: 0.85 }), []), false, 'as the voiceprint has them already');
  assert.equal(worthLearning(far, heard(), [at(angleFor(0.46))]), false, 'kept already, near enough');
  assert.equal(worthLearning(far, heard(), [at(angleFor(0.45), 1.2)]), true, 'unlike what’s kept');
});

test('the newest few are kept, as plain numbers', () => {
  let learned = [];
  for (let i = 0; i < LEARNED_MOST + 3; i++) learned = withLearned(learned, Float32Array.from([i, 0, 1]));
  assert.equal(learned.length, LEARNED_MOST);
  assert.deepEqual(learned[0], [3, 0, 1], 'the oldest three let go');
  assert.deepEqual(learned.at(-1), [LEARNED_MOST + 2, 0, 1]);
  assert.ok(learned.every((voice) => Array.isArray(voice)), 'storable as JSON');
  assert.deepEqual(withLearned(undefined, [1, 2, 3]), [[1, 2, 3]]);
});

test('what’s learned is sealed with the voiceprint, forgotten with it, and started afresh when the voice is taught again', () => {
  const read = (file) => fs.readFileSync(new URL(`../desktop/src/main/${file}`, import.meta.url), 'utf8');
  assert.match(read('chrome-bridge.js'), /PRIVATE_KEYS = Object\.freeze\(\[[^\]]*'voiceprint', 'voiceLearned'/);
  const main = read('main.js');
  assert.match(main, /op === 'forget'\) await storage\.local\.remove\(\['voiceprint', 'voiceLearned'\]\)/);
  assert.match(main, /await storage\.local\.set\(\{ voiceprint: averageVoice\(takes\) \}\);\n\s+await storage\.local\.remove\('voiceLearned'\);/);
  // Kept only from something he took as said to him.
  assert.match(main, /if \(turned && !across && heard\?\.learn && heard\.voice && voiceprint\) learnVoice\(heard\.voice\);/);
});
