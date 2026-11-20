/**
 * Permissions asked for as they're needed, and said when they're missing (the user, 2026-11-19: "have him ask for all
 * the permissions he needs as people need it and if he is asked to do something that needs permissions he does not
 * have have him say so and point the person to where in settings"): where each is allowed and what he says
 * (permission-list.js), what his model is told (abilities.js), Location's question put so that it's seen
 * (mac-location.js, whereabouts.js, device-location.js), and the callers that say it (dispatch.js, voice-runner.js).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { abilitiesPart } from '../desktop/src/main/abilities.js';
import { createDeviceLocate, positionFrom } from '../desktop/src/main/device-location.js';
import { createDispatcher } from '../desktop/src/main/dispatch.js';
import { createMacLocate } from '../desktop/src/main/mac-location.js';
import { allowedIn, permissionItems, PERMISSIONS, refusal } from '../desktop/src/main/permission-list.js';
import { forEar } from '../desktop/src/main/speaker.js';
import { createWhereabouts } from '../desktop/src/main/whereabouts.js';
import { ACTIONS } from '../jester-extension/src/common/constants.js';

const read = (file) => fs.readFileSync(new URL(`../desktop/src/${file}`, import.meta.url), 'utf8');

test('where each permission is allowed is a path someone can follow, on each system', () => {
  assert.equal(allowedIn('accessibility', 'darwin'), 'System Settings › Privacy & Security › Accessibility');
  assert.equal(allowedIn('microphone', 'darwin'), 'System Settings › Privacy & Security › Microphone');
  assert.equal(allowedIn('location', 'darwin'), 'System Settings › Privacy & Security › Location Services');
  assert.equal(allowedIn('files', 'darwin'), 'System Settings › Privacy & Security › Files and Folders');
  assert.equal(allowedIn('bluetooth', 'darwin'), 'System Settings › Privacy & Security › Bluetooth');
  // Sequoia renamed the pane; before it, it was Screen Recording.
  assert.equal(allowedIn('screen', 'darwin', { macMajor: 26 }), 'System Settings › Privacy & Security › Screen & System Audio Recording');
  assert.equal(allowedIn('screen', 'darwin', { macMajor: 14 }), 'System Settings › Privacy & Security › Screen Recording');
  assert.equal(allowedIn('microphone', 'win32'), 'Windows Settings › Privacy & security › Microphone');
  assert.equal(allowedIn('location', 'win32'), 'Windows Settings › Privacy & security › Location');
  // Windows has no switch for these, and Linux none at all.
  assert.equal(allowedIn('accessibility', 'win32'), '');
  assert.equal(allowedIn('camera', 'linux'), '');
});

test('refused, he says what he can’t do, that the system hasn’t allowed it, and where it’s switched on', () => {
  const mac = (id, options) => refusal(id, { platform: 'darwin', ...options });
  assert.equal(mac('accessibility').say, 'I can’t click, type or read what’s on the screen: macOS hasn’t allowed it. Switch Jester on in System Settings › Privacy & Security › Accessibility, then ask me again.');
  assert.equal(mac('microphone').say, 'I can’t hear you: macOS hasn’t allowed it. Switch Jester on in System Settings › Privacy & Security › Microphone, then ask me again.');
  assert.equal(mac('microphone').note, 'Jester can’t hear you: switch Jester on in System Settings › Privacy & Security › Microphone.');
  assert.equal(mac('camera').where, 'System Settings › Privacy & Security › Camera');
  assert.match(mac('location').say, /^I can’t tell where you are: macOS hasn’t allowed it\. Switch Jester on in System Settings › Privacy & Security › Location Services/);
  // Run on npm's own Electron.app, it's "Electron" that's in the list.
  assert.match(mac('camera', { listedAs: 'Electron' }).say, /Switch Electron on in /);
  const windows = refusal('microphone', { platform: 'win32' });
  assert.equal(windows.say, 'I can’t hear you: Windows hasn’t allowed it. In Windows Settings › Privacy & security › Microphone, let desktop apps use it, then ask me again.');
  // Every permission listed has words for it, and none of them is left as "do that".
  for (const id of Object.keys(PERMISSIONS)) assert.doesNotMatch(mac(id).say, /can’t do that/, id);
});

test('never answered, macOS is asking: he says so, for the ones it asks with Allow and Don’t Allow', () => {
  const asking = (id) => refusal(id, { platform: 'darwin', asking: true });
  assert.equal(asking('microphone').say, 'I can’t hear you until macOS allows it, and it’s asking you now: choose Allow.');
  assert.equal(asking('microphone').note, 'macOS is asking whether Jester may use the microphone: choose Allow.');
  assert.equal(asking('camera').note, 'macOS is asking whether Jester may use the camera: choose Allow.');
  assert.match(asking('location').note, /may use this computer’s location: choose Allow\.$/);
  // Accessibility and the screen are a switch in System Settings: whether macOS's own dialog also comes up isn't
  // his to know, so he says where the switch is either way.
  assert.equal(asking('accessibility').say, refusal('accessibility', { platform: 'darwin' }).say);
  assert.equal(asking('screen').say, refusal('screen', { platform: 'darwin' }).say);
});

test('what he says aloud reads a path through Settings as a person would say it', () => {
  assert.equal(
    forEar(refusal('accessibility', { platform: 'darwin' }).say),
    'I can’t click, type or read what’s on the screen: macOS hasn’t allowed it. Switch Jester on in System Settings, then Privacy and Security, then Accessibility, then ask me again.'
  );
  assert.equal(forEar('Choose one in Jester’s Settings › Models.'), 'Choose one in Jester’s Settings, then Models.');
});

test('Location, Bluetooth and a vault’s folder are listed only once they’re in use and known', () => {
  const ids = (statuses, platform = 'darwin') => permissionItems(platform, statuses).map((item) => item.id);
  assert.deepEqual(ids({}), ['camera', 'accessibility', 'microphone', 'screen']);
  assert.deepEqual(ids({ location: 'not-determined' }), ['camera', 'accessibility', 'microphone', 'screen', 'location']);
  assert.deepEqual(ids({ bluetooth: 'denied', files: 'denied' }), ['camera', 'accessibility', 'microphone', 'screen', 'bluetooth', 'files']);
  assert.deepEqual(ids({ location: 'denied' }, 'win32'), ['camera', 'microphone', 'location']);
  const [location] = permissionItems('darwin', { location: 'not-determined' }).filter((item) => item.id === 'location');
  // Never answered, its button asks; refused, it opens System Settings; and it says where that is.
  assert.equal(location.action, 'request');
  assert.equal(permissionItems('darwin', { location: 'denied' }).find((item) => item.id === 'location').action, 'open-settings');
  assert.equal(location.where, 'System Settings › Privacy & Security › Location Services');
  assert.equal(location.tier, 'optional');
  // What's for his own words isn't sent to the page.
  assert.ok(!('cant' in location) && !('thing' in location) && !('whenKnown' in location));
});

test('his model is told what the system hasn’t allowed, with where it’s switched on, and claims none of it', () => {
  const where = (id) => allowedIn(id, 'darwin', { macMajor: 26 });
  const base = { computer: 'Mac', gestures: true, watch: true, notes: false, pictures: false };
  // Nothing in the way: the prompt is what it always was, to the letter.
  assert.equal(abilitiesPart({ ...base, blocked: {}, os: 'macOS' }), abilitiesPart(base));
  assert.doesNotMatch(abilitiesPart(base), /Not allowed by/);

  const blocked = abilitiesPart({ ...base, os: 'macOS', blocked: { accessibility: where('accessibility'), microphone: where('microphone'), camera: where('camera'), screen: where('screen'), files: where('files'), bluetooth: where('bluetooth') } });
  assert.match(blocked, /\nNot allowed by macOS yet\. Asked for one of these, say plainly what’s missing and where it’s switched on, in a sentence:\n/);
  // Without Accessibility the laptop isn't said to type or click, only what it still can; and what's asked is still
  // passed on, since it's the laptop that puts macOS's question up.
  assert.match(blocked, /- Through "do", the laptop can open and quit apps, open sites and bookmarks, change the volume and play, pause or skip\. That is all it can do for now/);
  assert.doesNotMatch(blocked, /works any app or site the way a person would/);
  assert.match(blocked, /- Typing, clicking, pressing keys, using menus and reading what’s on the screen: macOS hasn’t allowed Jester Accessibility, which is switched on in System Settings › Privacy & Security › Accessibility\. Asked for any of these, still pass it on with "do"/);
  assert.match(blocked, /- Hearing them: macOS hasn’t allowed Jester the microphone, which is switched on in System Settings › Privacy & Security › Microphone\. Until it is they can only type to you\./);
  assert.match(blocked, /- Looking at a picture of a window: macOS hasn’t allowed it, which is switched on in System Settings › Privacy & Security › Screen & System Audio Recording\./);
  // A vault that's chosen and can't be opened isn't "no vault is chosen".
  assert.match(blocked, /- Obsidian notes, and remembering what they ask you to: a vault is chosen, but macOS hasn’t let Jester into the folder it’s in, which is switched on in System Settings › Privacy & Security › Files and Folders\./);
  assert.doesNotMatch(blocked, /no vault is chosen/);
  // Gestures switched on with no camera aren't claimed, nor called turned off; the watch likewise.
  assert.match(blocked, /- Hand gestures: switched on, but macOS hasn’t allowed Jester the camera/);
  assert.doesNotMatch(blocked, /Jester also lets them work the computer with hand gestures/);
  assert.doesNotMatch(blocked, /turned off \(Gestures, in the menu bar\)/);
  assert.match(blocked, /- Steering the cursor with their Apple Watch: macOS hasn’t allowed Jester Bluetooth/);
  assert.doesNotMatch(blocked, /They can steer the cursor with their paired Apple Watch/);
  // Each thing is said once: not allowed, and not also "not connected".
  assert.equal(blocked.match(/Obsidian notes/g).length, 1);

  // On Windows it's Windows that's named.
  assert.match(abilitiesPart({ ...base, os: 'Windows', blocked: { microphone: allowedIn('microphone', 'win32') } }), /Not allowed by Windows yet\.[^\n]*\n- Hearing them: Windows hasn’t allowed Jester the microphone, which is switched on in Windows Settings › Privacy & security › Microphone\./);
  // A picture he could never have read (no model that reads them) isn't something that's missing.
  assert.doesNotMatch(abilitiesPart({ ...base, os: 'macOS', blocked: {} }), /picture of a window/);
});

/** A stand-in for the native Location module, with a clock that moves only when it's waited on. */
function macLocation({ answerAfter = Infinity, answer = 'allowed' } = {}) {
  let t = 0;
  const calls = { ask: [], locate: 0, front: [] };
  const native = {
    status: () => (calls.ask.length && t - calls.ask[0] >= answerAfter ? answer : 'not-determined'),
    ask: () => void calls.ask.push(t),
    locate: () => ++calls.locate,
    latest: () => ({ request: calls.locate, lat: 40.79, lon: -77.86, accuracy: 30, at: 1 })
  };
  return { native, calls, now: () => t, wait: async (ms) => void (t += ms), front: async () => void calls.front.push(t) };
}

test('macOS is asked about Location with Jester in front, and asked again until it answers', async () => {
  const mac = macLocation({ answerAfter: 7000 });
  const got = await createMacLocate(mac)({ timeoutMs: 90000 });
  assert.equal(got.ok, true);
  // In front first: asked from the menu bar, the question never came up.
  assert.deepEqual(mac.calls.front, [0]);
  assert.equal(mac.calls.ask[0], 0);
  // Put again every few seconds while it's unanswered, in case the first was asked before he'd got there.
  assert.deepEqual(mac.calls.ask, [0, 3000, 6000]);
  assert.equal(mac.calls.locate, 1);
});

test('a question nobody answers is "still asking", not "couldn’t"; allowed already, he isn’t brought forward', async () => {
  const unanswered = macLocation();
  const got = await createMacLocate(unanswered)({ timeoutMs: 10000 });
  assert.deepEqual(got, { ok: false, code: 3, asking: true, message: 'macOS’s question wasn’t answered' });
  const allowed = macLocation();
  allowed.native.status = () => 'allowed';
  assert.equal((await createMacLocate(allowed)({ timeoutMs: 5000 })).ok, true);
  assert.deepEqual(allowed.calls.front, []);
  assert.deepEqual(allowed.calls.ask, []);
  // Refused: no question, no coming forward, and it says so.
  const refused = macLocation();
  refused.native.status = () => 'denied';
  assert.equal((await createMacLocate(refused)({ timeoutMs: 5000 })).code, 1);
  assert.deepEqual(refused.calls.front, []);
});

test('while the question is up, the next turn asks again at once; a real failure waits its two minutes', async () => {
  let t = 1_000_000;
  const asked = [];
  let reply = { ok: false, code: 3, asking: true, message: '' };
  const whereabouts = createWhereabouts({
    locate: async (options) => (asked.push(options), reply),
    setting: () => ({ source: 'here' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    now: () => t
  });
  await whereabouts.locate();
  assert.equal(whereabouts.state().problem, 'asking');
  // Ten seconds on they talk to him again: asked again, not held off.
  t += 10_000;
  await whereabouts.here({ waitMs: 0 });
  await Promise.resolve();
  assert.equal(asked.length, 2);
  // From Settings it's asked on purpose, and the device is told so.
  await whereabouts.locate({ patient: true });
  assert.equal(asked.at(-1).patient, true);
  assert.equal(asked[0].patient, false);
  // A position that couldn't be had is another matter: not tried again for two minutes.
  reply = { ok: false, code: 2, message: '' };
  await whereabouts.locate({ patient: true });
  assert.equal(whereabouts.state().problem, 'unavailable');
  const before = asked.length;
  t += 10_000;
  await whereabouts.here({ waitMs: 0 });
  assert.equal(asked.length, before);
  // Answered at last: there's a position, and no problem.
  reply = { ok: true, lat: 40.79, lon: -77.86, accuracy: 30 };
  await whereabouts.locate({ patient: true });
  assert.equal(whereabouts.state().problem, '');
  assert.equal((await whereabouts.here()).lat, 40.79);
});

test('his website’s browser is told when it’s asked on purpose, and its unanswered question comes back as "asking"', async () => {
  const sent = [];
  const phone = { id: 1, role: 'page', agent: 'Mozilla/5.0 (iPhone)', message: (message) => sent.push(message) };
  const located = createDeviceLocate({ gateway: { voiceClient: phone, clients: [phone] }, hands: {} });
  // When he's only been talked to, a "Not now" on the page stands.
  const quiet = located.locate({ timeoutMs: 20000 });
  assert.equal(sent[0].sure, undefined);
  located.told(phone, { id: sent[0].id, ok: false, code: 1, message: 'Not now.' });
  assert.deepEqual(await quiet, { ok: false, code: 1, message: 'Not now.' });
  // From Settings: put to them again.
  const sure = located.locate({ timeoutMs: 20000, patient: true });
  assert.equal(sent[1].sure, true);
  located.told(phone, { id: sent[1].id, ok: false, code: 3, message: '', asking: true });
  assert.deepEqual(await sure, { ok: false, code: 3, message: '', asking: true });
  // A page that never says a word within the time: most likely its browser's question, up and unanswered.
  assert.deepEqual(await located.locate({ timeoutMs: 20 }), { ok: false, code: 3, message: '', asking: true });
  // Only a true `asking` is passed on.
  assert.equal('asking' in positionFrom({ ok: false, code: 1, asking: 'yes' }, phone), false);
});

test('the Mac’s unanswered question reaches his server as "asking" too', async () => {
  const mac = { id: 2, role: 'mac', device: { id: 'mac-1' } };
  const hands = { where: async () => ({ ok: false, code: 3, asking: true, message: 'macOS’s question wasn’t answered' }) };
  const located = createDeviceLocate({ gateway: { voiceClient: mac, clients: [mac] }, hands });
  assert.deepEqual(await located.locate({ timeoutMs: 1000 }), { ok: false, code: 3, message: 'macOS’s question wasn’t answered', asking: true });
});

test('a gesture that needs Accessibility says where it’s allowed, on its toast', async () => {
  const toasts = [];
  const key = Object.keys(ACTIONS).find((id) => /play/i.test(id)) || Object.keys(ACTIONS)[1];
  const dispatcher = (refused) =>
    createDispatcher({ driver: { call: async () => assert.fail('nothing is sent') }, getSettings: async () => ({}), canPost: () => false, refused, onJester: () => undefined, toast: (text, options) => toasts.push(options?.detail), platform: 'darwin' });
  const note = refusal('accessibility', { platform: 'darwin' }).note;
  const done = await dispatcher(() => note)(key);
  assert.equal(done.ok, false);
  assert.equal(done.detail, 'Jester can’t click, type or read what’s on the screen: switch Jester on in System Settings › Privacy & Security › Accessibility.');
  assert.equal(toasts.at(-1), done.detail);
  // Without the hook (a test's dispatcher), the old words.
  assert.equal((await dispatcher(null)(key)).detail, 'Allow Accessibility in Jester’s Settings first');
});

test('main asks as things are switched on or used, and nowhere says only "allow it in Settings"', () => {
  const main = read('main/main.js');
  // What's switched on is asked for at each refresh; a gesture, the watch and a command each say where it's allowed.
  assert.match(main, /askForWhatsOn\(before\);\n\s+updateListening\(\);/);
  assert.match(main, /refused: \(\) => inputRefusal\(\{ open: false, form: 'note' \}\)/);
  assert.match(main, /whyNoInput: \(\) => inputRefusal\(\)/);
  assert.match(main, /createMacLocate\(\{ native: macLocation, front: comeForward \}\)/);
  assert.doesNotMatch(main, /Allow (?:Accessibility|the Microphone) in Jester’s Settings first/);
  // A new Jester starts with his voice alone: the camera isn't asked for until gestures are turned on.
  assert.match(main, /settings: \{ \.\.\.desktopSettings\(undefined\), gesturesEnabled: false \}/);
  // The runner refuses before a task starts, rather than letting it start and not see.
  const runner = read('main/voice-runner.js');
  assert.match(runner, /if \(assistant && !canPost\(\)\) return \{ steps, outcome: bad\(noInput\(\)\) \};/);
  assert.match(runner, /if \(steps\.some\(needsInput\) && !canPost\(\)\) return \{ steps, outcome: bad\(noInput\(\)\) \};/);
});

test('his website asks for location from a tap when the browser has still to ask', () => {
  const shim = read('web/shim.js');
  assert.match(shim, /navigator\.permissions\.query\(\{ name: 'geolocation' \}\)/);
  assert.match(shim, /yes\.textContent = 'Allow location';/);
  // Refused outright, nothing's put to them; "Not now" stands unless it's asked for on purpose (run in a browser of
  // its own: desktop-web-location.test.mjs).
  assert.match(shim, /if \(allowed === 'denied'\) return finish\(\{ ok: false, code: 1/);
  assert.match(shim, /if \(!sure && \(whereDeclined \|\| Date\.now\(\) - Number\(storedWhere\(WHERE_NO\) \|\| 0\) < NOT_NOW_MS\)\) return finish\(/);
});
