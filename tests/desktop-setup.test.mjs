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
    ['hearing', true, false, 'settings/general'],
    ['listening', false, false, 'settings/assistant'],
    ['voiceprint', false, false, 'settings/assistant'],
    ['face', false, false, 'settings/assistant'],
    ['ownVoice', false, false, 'settings/assistant'],
    ['gestures', false, false, 'settings/general'],
    ['vault', false, false, 'settings/memory'],
    ['day', false, false, 'settings/day'],
    ['phone', false, false, 'settings/assistant'],
    ['mail', false, false, 'settings/mail'],
    ['chrome', false, false, 'settings/chrome']
  ]);
  assert.equal(steps[0].why, 'macOS has to allow it: Microphone and Accessibility. He asks for each as it’s first needed; here you can allow them now.');
  // Elsewhere it's that system that's named, not Apple's.
  assert.match(setupSteps({ missing: ['Microphone'], os: 'Windows' })[0].why, /^Windows has to allow it: Microphone\./);
  assert.match(setupSteps({ missing: [], os: 'Windows' })[0].why, /^Windows has allowed what he needs so far\. Anything else is asked for when it’s first used\.$/);
  // Gestures start off for a new Jester, and say when the camera will be asked for.
  assert.match(steps.find((step) => step.id === 'gestures').why, /^Off until you turn Gestures on, which is when the camera is asked for\./);
  assert.equal(setupSteps({ gestures: true }).find((step) => step.id === 'gestures').done, true);
  assert.match(steps[1].why, /Paste a key for Claude, Gemini, Groq or another, or run Ollama/);
  // No terminal: what he hears with is a download his own button starts (he starts it himself on a first run).
  assert.equal(steps[2].why, 'Not downloaded yet. You can type to him meanwhile.');
  assert.deepEqual([steps[2].act, steps[2].button], ['fetch-models', 'Download']);
  assert.ok(!/npm|terminal|desktop folder/i.test(JSON.stringify(steps)), 'nothing sends a new user to a terminal');
  assert.deepEqual(setupSummary(steps), { ready: false, left: 3, more: 10, words: '3 things left before he’s ready' });
  // The first thing that can be added is what lets them say his name at all: off until they turn it on.
  assert.match(steps[3].why, /^Off until you turn it on, here or with the microphone under the orb\./);
  // A key pasted and saved for actions alone: the list says why he still can't answer.
  assert.match(setupSteps({ otherModel: true })[1].why, /None of your models is ticked for Talking/);
  assert.equal(setupSteps({ model: true, otherModel: true })[1].why, 'He has one.');
});

test('as things are set up they’re ticked, and he’s ready once what’s needed is', () => {
  const some = setupSteps({ missing: [], model: true });
  assert.deepEqual(setupSummary(some), { ready: false, left: 1, more: 10, words: '1 thing left before he’s ready' });
  const ready = setupSteps({ missing: [], model: true, hearing: true, vault: true });
  assert.deepEqual(setupSummary(ready), { ready: true, left: 0, more: 9, words: 'Ready. 9 more you can add' });
  assert.equal(ready.find((step) => step.id === 'vault').why, 'He keeps his notes and what he learns in your Obsidian vault.');
  const all = setupSteps({ missing: [], model: true, hearing: true, listening: true, ownVoice: true, voiceprint: true, face: true, gestures: true, vault: true, day: true, phone: true, mail: true, chrome: true });
  assert.ok(all.every((step) => step.done));
  assert.deepEqual(setupSummary(all), { ready: true, left: 0, more: 0, words: 'All set' });
});

test('a download says how far it has got, and offers itself again only when it stopped', () => {
  const hearing = (fetch) => setupSteps({ fetch }).find((step) => step.id === 'hearing');
  const voice = (fetch) => setupSteps({ fetch }).find((step) => step.id === 'ownVoice');
  // Nothing fetched or asked for: how big it is, and the button.
  assert.equal(hearing({ fetching: null, waiting: [], error: '', words: '', firstMb: 476 }).why, 'Not downloaded yet: about 476 MB, once. You can type to him meanwhile.');
  // Under way: its progress, and no button to start what's started.
  const going = { fetching: { id: 'parakeet-110m' }, waiting: ['voice', 'kokoro'], error: '', words: 'Downloading what he hears with: 43% (44 of 103 MB), then 2 more.' };
  assert.equal(hearing(going).why, going.words);
  assert.equal(hearing(going).act, undefined);
  // His voice waits behind it.
  assert.equal(voice(going).why, 'Waiting its turn to download.');
  assert.equal(voice(going).act, undefined);
  // It stopped: why, and Try again, on the step it stopped at and on those behind it.
  const stopped = { fetching: null, waiting: ['parakeet-110m', 'kokoro'], error: 'No connection to download it over.', words: 'The download stopped. No connection to download it over.' };
  assert.deepEqual([hearing(stopped).why, hearing(stopped).button], [stopped.words, 'Try again']);
  assert.deepEqual([voice(stopped).why, voice(stopped).button], [stopped.words, 'Try again']);
  // Here: nothing to download.
  assert.equal(setupSteps({ hearing: true, fetch: going }).find((step) => step.id === 'hearing').act, undefined);
  assert.equal(setupSteps({ ownVoice: true }).find((step) => step.id === 'ownVoice').why, 'He has it, made on this computer.');
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

test('on his website a computer’s own steps are left out, and the phone’s step is this device’s notifications', () => {
  const ids = (steps) => steps.map((step) => step.id);
  const app = setupSteps({ missing: ['Microphone'] });
  assert.ok(['permissions', 'gestures', 'chrome', 'phone'].every((id) => ids(app).includes(id)), 'his own window keeps them all');
  assert.ok(!ids(app).includes('push'));
  // His app on a phone: no macOS permissions, gestures or Chrome, and nothing about ntfy.
  const phone = setupSteps({ web: true, phoneHere: true, missing: ['Microphone', 'Accessibility'] });
  assert.ok(!['permissions', 'gestures', 'chrome', 'phone'].some((id) => ids(phone).includes(id)), ids(phone).join(' '));
  assert.ok(!JSON.stringify(phone).includes('ntfy'));
  const alerts = phone.find((step) => step.id === 'push');
  assert.equal(alerts.title, 'Alerts on this phone');
  assert.deepEqual([alerts.done, alerts.required, alerts.go, alerts.act, alerts.button], [false, false, 'settings/devices', 'push-on', 'Turn on']);
  // A permission the server's computer lacks isn't one left for this device to give.
  assert.equal(setupSummary(phone).left, setupSummary(phone.filter((step) => step.id !== 'permissions')).left);
  assert.ok(!phone.some((step) => step.required && /allow/i.test(step.why)));
  // On: done, and nothing to press but Change.
  const on = setupSteps({ web: true, phoneHere: true, pushHere: true }).find((step) => step.id === 'push');
  assert.equal(on.done, true);
  assert.equal(on.act, undefined);
  assert.match(on.why, /^On: .* comes to this phone as a notification\.$/);
  // A browser that can't take them says why, and offers no button that would fail.
  const problem = 'This browser can’t take notifications from a website.';
  const cannot = setupSteps({ web: true, pushProblem: problem }).find((step) => step.id === 'push');
  assert.deepEqual([cannot.title, cannot.why, cannot.act], ['Alerts on this device', problem, undefined]);
});
