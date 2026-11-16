// Step 12 (2026-11-15): getting started, the same for whoever opens him first (setup.js), and where its screen sits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupSteps, setupSummary } from '../desktop/src/main/setup.js';
import { backOf, direction, placeOf } from '../desktop/src/home/screens.js';

test('a new computer: what’s needed first, each with where it’s done, then what can be added', () => {
  const steps = setupSteps({ missing: ['Microphone', 'Accessibility'] });
  assert.deepEqual(steps.map((step) => [step.id, step.required, step.done, step.go]), [
    ['permissions', true, false, 'settings/permissions'],
    ['model', true, false, 'settings/models'],
    ['hearing', true, false, 'settings/controls'],
    ['listening', false, false, 'settings/assistant'],
    ['voiceprint', false, false, 'settings/assistant'],
    ['ownVoice', false, false, 'settings/assistant'],
    ['vault', false, false, 'settings/memory'],
    ['day', false, false, 'settings/day'],
    ['phone', false, false, 'settings/assistant'],
    ['mail', false, false, 'settings/mail'],
    ['chrome', false, false, 'settings/chrome']
  ]);
  assert.equal(steps[0].why, 'macOS has to allow it: Microphone and Accessibility.');
  assert.match(steps[1].why, /Paste a key for Claude, Gemini, Groq or another, or run Ollama/);
  assert.match(steps[2].why, /npm run models/);
  assert.deepEqual(setupSummary(steps), { ready: false, left: 3, more: 8, words: '3 things left before he’s ready' });
  // The first thing that can be added is what lets them say his name at all: off until they turn it on.
  assert.match(steps[3].why, /^Off until you turn it on, here or with the microphone under the orb\./);
  // A key pasted and saved for actions alone: the list says why he still can't answer.
  assert.match(setupSteps({ otherModel: true })[1].why, /None of your models is ticked for Talking/);
  assert.equal(setupSteps({ model: true, otherModel: true })[1].why, 'He has one.');
});

test('as things are set up they’re ticked, and he’s ready once what’s needed is', () => {
  const some = setupSteps({ missing: [], model: true });
  assert.deepEqual(setupSummary(some), { ready: false, left: 1, more: 8, words: '1 thing left before he’s ready' });
  const ready = setupSteps({ missing: [], model: true, hearing: true, vault: true });
  assert.deepEqual(setupSummary(ready), { ready: true, left: 0, more: 7, words: 'Ready. 7 more you can add' });
  assert.equal(ready.find((step) => step.id === 'vault').why, 'He keeps his notes and what he learns in your Obsidian vault.');
  const all = setupSteps({ missing: [], model: true, hearing: true, listening: true, ownVoice: true, voiceprint: true, vault: true, day: true, phone: true, mail: true, chrome: true });
  assert.ok(all.every((step) => step.done));
  assert.deepEqual(setupSummary(all), { ready: true, left: 0, more: 0, words: 'All set' });
});

test('the Getting started screen sits to the right of the orb, and goes back to it', () => {
  assert.equal(placeOf('setup'), 1);
  assert.equal(backOf('setup'), 'main');
  assert.equal(direction('main', 'setup'), 1);
});

test('nothing he says to a new user, or shows them, is about one person', () => {
  const read = (file) => readFileSync(new URL(`../desktop/src/${file}`, import.meta.url), 'utf8');
  // What's shown, and what a model is told: examples are anyone's.
  for (const file of ['home/home.html', 'main/setup.js', 'main/abilities.js']) assert.ok(!/Penn State|State College|Krish|psu\.edu/i.test(read(file)), file);
  const prompts = read('main/conversation.js').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.ok(!/Penn State|State College|Krish|psu\.edu/i.test(prompts), 'his prompt');
  const told = read('main/vault-memory.js').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.ok(!/Penn State|State College|Krish|\bPSU\b|CMPSC/i.test(told), 'what the model that keeps his memory is told');
  // Nor is the link to Chrome one computer's: the unpacked extension's id is worked out where it runs.
  assert.ok(!/fepkikohkficncoppffmemobjogdfdip/.test(read('main/link-host.js')));
});
