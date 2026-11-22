import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chooserStep, chooserPick, findChooser, siteName } from '../jester-extension/src/common/chooser.js';
import { validateAction } from '../jester-extension/src/common/agent-actions.js';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

// The worker linked to Jester Desktop, with a scripted model and a page that asks who is there. 2026-11-21: "go to
// Hulu and start playing Modern Family" met Hulu's profile picker, and the model clicked "Switch profile to Sandeep
// Chavan" three times, which was the wrong profile. A choice like that is the user's: the task stops and asks, and
// what they answer is handed back to be remembered.
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    fire(...args) { for (const fn of [...listeners]) fn(...args); } };
}
const local = { settings: { enabled: true, voiceEnabled: true, agentPermissionBoundary: 'entertainment', agentRealInput: false } };
const session = {};
function area(data) {
  return { async get(key) { return typeof key === 'string' ? { [key]: structuredClone(data[key]) } : structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; },
    async setAccessLevel() {} };
}

const PROFILES = [
  { id: 'p1', role: 'button', name: 'Switch profile to Krish' },
  { id: 'p2', role: 'button', name: 'Switch profile to Sandeep Chavan' },
  { id: 'p3', role: 'link', name: 'Manage profiles' }
];
const HOME = { id: 'home', url: 'https://www.hulu.com/hub/home', title: 'Hulu', elements: [
  { id: 'v1', role: 'video', name: 'Video', playing: true, paused: false, currentTime: 3 },
  { id: 'h1', role: 'link', name: 'Modern Family' }] };
/** Hulu's profile picker; choosing either profile goes on to the home page. */
const picker = () => ({ id: 'profiles', url: 'https://www.hulu.com/profiles?next=/', title: 'Hulu', elements: PROFILES, after: { p1: HOME, p2: HOME } });
const SIGNED_IN = { id: 'canvas', url: 'https://canvas.example.edu/', title: 'Dashboard', elements: [{ id: 'd1', role: 'link', name: 'Courses' }] };
/** A Google account chooser as a site's sign-in shows it. */
const accounts = () => ({ id: 'accounts', url: 'https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount', title: 'Sign in - Google Accounts', elements: [
  { id: 'g1', role: 'button', name: 'Continue as Krish' },
  { id: 'g2', role: 'button', name: 'Use another account' },
  { id: 'g3', role: 'link', name: 'Help' }], after: { g1: SIGNED_IN, g2: SIGNED_IN } });

let screen = picker();
// The control that has the focus on the page, as the page itself would say: '' is the page's own body.
let focusOn = '';
const tab = { id: 7, windowId: 1, index: 0, active: true, url: screen.url, title: screen.title };
let chromeInFront = false;
let replies = [];
let prompts = [];
const posted = [];
const sent = [];
const broadcasts = [];
const clicked = [];
const runtimeMessages = event();
const portMessages = event();
const portClosed = event();
const focusChanged = event();
globalThis.chrome = {
  runtime: { id: 'extension-test', getURL: (path = '') => `chrome-extension://extension-test/${path}`,
    getManifest: () => ({ version: '0.3.0' }),
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async (message) => { broadcasts.push(structuredClone(message)); },
    connectNative: () => ({ postMessage: (message) => posted.push(structuredClone(message)), onMessage: portMessages,
      onDisconnect: portClosed, disconnect() {} }),
    onMessage: runtimeMessages, onStartup: event(), onInstalled: event() },
  storage: { local: area(local), session: area(session), onChanged: event() },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true, onAdded: event(), onRemoved: event() },
  alarms: { create() {}, clear() {}, onAlarm: event() },
  notifications: { create: async (id) => id, clear: async () => {}, onClicked: event(), onClosed: event() },
  commands: { onCommand: event() },
  bookmarks: { search: async () => [], getChildren: async () => [] },
  tabs: {
    onUpdated: event(), onActivated: event(), onCreated: event(), onRemoved: event(),
    query: async ({ url } = {}) => url ? [] : [structuredClone(tab)],
    get: async () => structuredClone(tab), update: async (_id, patch) => structuredClone(Object.assign(tab, patch)),
    create: async () => structuredClone(tab),
    sendMessage: async (tabId, message) => {
      sent.push({ tabId, message: structuredClone(message) });
      if (message.type === 'jester/agent-observe') return { ok: true, pageId: `doc-${screen.id}`, revision: 1, url: screen.url, title: screen.title,
        elements: structuredClone(screen.elements), text: screen.elements.map((entry) => `[${entry.id}] ${entry.role} ${JSON.stringify(entry.name)}`).join('\n') };
      // A key with no element named is classified as landing on whatever has the focus, and is sent there.
      if (message.type === 'jester/agent-classify') return { ok: true, category: 'browse', label: 'Control', pageId: `doc-${screen.id}`,
        ...(message.action.action === 'press_key' ? { elementId: message.action.elementId || focusOn || 'body' } : {}) };
      if (message.type === 'jester/agent-execute') {
        // Giving a control the focus presses nothing.
        const pressed = message.action.action !== 'focus';
        if (['focus', 'click'].includes(message.action.action)) focusOn = message.action.elementId;
        if (pressed) clicked.push(message.action.elementId);
        const next = pressed ? screen.after?.[message.action.elementId] : null;
        if (next) { screen = next; tab.url = next.url; tab.title = next.title; focusOn = ''; }
        return { ok: true, detail: 'click: Control' };
      }
      if (message.type === 'jester/probe') return { hasVideo: false };
      return { ok: true };
    },
    setZoomSettings: async () => {}, setZoom: async () => {}
  },
  // Behind Jester Desktop's window, Chrome's never says it has the focus; by itself, it does.
  windows: {
    getLastFocused: async () => ({ id: 1, focused: chromeInFront, state: 'normal', type: 'normal' }),
    get: async (id) => ({ id, state: 'normal' }), update: async () => ({}), create: async () => ({ id: 1, tabs: [structuredClone(tab)] }),
    onFocusChanged: focusChanged, onBoundsChanged: event(), onRemoved: event()
  },
  scripting: { executeScript: async ({ files }) => files ? [] : [{ frameId: 0, result: { hasVideo: false } }] },
  sessions: { restore: async () => { throw new Error('Nothing to restore'); } },
  search: { query: async () => {} }
};
// The model: each request takes the next scripted reply, and what it was shown is kept.
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('chrome-extension:')) return new Response('', { status: 404 });
  prompts.push(JSON.parse(JSON.parse(options.body).messages.at(-1).content));
  const reply = replies.shift();
  if (!reply) throw new Error('The model was asked more often than the test expects');
  return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
};

await import('../jester-extension/src/background/service-worker.js');
const tick = () => new Promise((done) => setTimeout(done, 2));
async function until(predicate, label = 'the expected state') {
  for (let attempt = 0; attempt < 1500; attempt++) { if (predicate()) return; await tick(); }
  assert.fail(`Worker did not reach ${label}`);
}
const uiSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') };
const engineSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/offscreen/offscreen.html') };
const message = (payload, sender = uiSender) => new Promise((resolve, reject) => {
  let replied = false;
  try {
    const later = runtimeMessages.listeners[0](payload, sender, (value) => { replied = true; resolve(value); });
    if (later !== true && !replied) resolve(undefined);
  } catch (error) { reject(error); }
});
await until(() => posted.some((entry) => entry.type === 'hello'), 'its hello');
portMessages.fire({ type: 'welcome', version: 'test' });
// A paid plan keeps free-tier pacing out of tests that all run inside one minute.
await message({ type: 'jester/model-save', connection: { provider: 'groq', model: 'ask-model', key: 'private-ask-key', plan: 'paid' } });

let nextTask = 0;
/** A command from Jester Desktop, begun: `done()` waits for how the extension says it went. */
function fromDesktop(text, more = {}) {
  const id = `t${++nextTask}`;
  portMessages.fire({ type: 'task', id, text, ...more });
  const done = async () => {
    await until(() => posted.some((entry) => entry.type === 'done' && entry.id === id), `an end to “${text}”`);
    return posted.find((entry) => entry.type === 'done' && entry.id === id);
  };
  return { id, done };
}
const asks = () => posted.filter((entry) => entry.type === 'ask');
/** The next question the extension puts to the app. */
async function asked(count = 1) {
  await until(() => asks().length >= count, `question ${count}`);
  return asks()[count - 1];
}
const answer = (ask, text) => portMessages.fire({ type: 'answer', id: ask.id, approved: true, text });
const click = (elementId) => ({ action: { action: 'click', elementId } });
const finished = (say = 'Modern Family is playing.') => ({ action: { action: 'finish', say, success: true } });
const HULU = 'go to Hulu and start playing Modern Family';

beforeEach(() => {
  screen = picker();
  focusOn = '';
  Object.assign(tab, { url: screen.url, title: screen.title });
  replies = []; prompts = [];
  posted.length = 0; sent.length = 0; broadcasts.length = 0; clicked.length = 0;
  delete session.modelPacing;
  delete local.userChoices;
});

test('a chooser is known by its choices, and an ordinary page with two buttons is not one', () => {
  const hulu = { elements: PROFILES, url: 'https://www.hulu.com/profiles', title: 'Hulu' };
  assert.deepEqual(chooserStep({ ...hulu, targetId: 'p2', goal: HULU }), {
    do: 'ask', question: 'Which Hulu profile should I use?', options: ['Krish', 'Sandeep Chavan'], about: 'Hulu profile',
    choices: [{ id: 'p1', ids: ['p1'], name: 'Krish', label: 'Switch profile to Krish' }, { id: 'p2', ids: ['p2'], name: 'Sandeep Chavan', label: 'Switch profile to Sandeep Chavan' }] });
  // What was asked for names one, whichever the model picked; so does an earlier answer about this site.
  assert.deepEqual(chooserStep({ ...hulu, targetId: 'p2', goal: `${HULU} on my Krish profile` }), { do: 'click', elementId: 'p1', name: 'Krish', about: 'Hulu profile' });
  assert.deepEqual(chooserStep({ ...hulu, targetId: 'p1', goal: 'put on Modern Family for sandeep' }), { do: 'click', elementId: 'p2', name: 'Sandeep Chavan', about: 'Hulu profile' });
  assert.equal(chooserStep({ ...hulu, targetId: 'p2', goal: HULU, ways: ['Hulu profile: Krish'] }).elementId, 'p1');
  // The newest answer is the one that counts; one about another site says nothing here.
  assert.equal(chooserStep({ ...hulu, targetId: 'p1', goal: HULU, ways: ['Hulu profile: Krish', 'Hulu profile: Sandeep Chavan'] }).elementId, 'p2');
  assert.equal(chooserStep({ ...hulu, targetId: 'p2', goal: HULU, ways: ['Netflix profile: Krish', 'Dad’s number: the mobile one'] }).do, 'ask');
  // Naming both names neither.
  assert.equal(chooserStep({ ...hulu, targetId: 'p2', goal: 'switch Hulu from Krish to Sandeep Chavan' }).do, 'ask');
  // A click on something that isn't a choice is the model's own.
  assert.equal(chooserStep({ ...hulu, targetId: 'p3', goal: HULU }), null);

  // Two people who share a name are told apart by the rest of it.
  const family = [{ id: 'a', role: 'button', name: 'Switch profile to Krish Chavan' }, { id: 'b', role: 'button', name: 'Switch profile to Sandeep Chavan' }];
  assert.equal(chooserStep({ elements: family, targetId: 'b', goal: 'play it on krish’s profile', url: hulu.url }).elementId, 'a');
  assert.equal(chooserStep({ elements: family, targetId: 'b', goal: 'play it for the Chavan family', url: hulu.url }).do, 'ask');
  // A profile called Kids is not asked for by "a kids show", and is by "the kids profile".
  const kids = [{ id: 'a', role: 'button', name: 'Switch profile to Kids' }, { id: 'b', role: 'button', name: 'Switch profile to Krish' }];
  assert.equal(chooserStep({ elements: kids, targetId: 'b', goal: 'put on a kids show on Hulu', url: hulu.url }).do, 'ask');
  assert.equal(chooserStep({ elements: kids, targetId: 'b', goal: 'put on Bluey on the kids profile', url: hulu.url }).elementId, 'a');

  // Not choosers: two ordinary buttons, sign-in by provider, "Use" and "Choose" of other things, one account alone.
  const not = (elements, targetId = elements[0].id) => assert.equal(chooserStep({ elements, targetId, goal: 'check out', url: 'https://shop.example.com/cart' }), null, JSON.stringify(elements));
  not([{ id: 'c1', role: 'button', name: 'Continue' }, { id: 'c2', role: 'button', name: 'Continue' }]);
  not([{ id: 'c1', role: 'button', name: 'Continue with Google' }, { id: 'c2', role: 'button', name: 'Continue with Apple' }]);
  not([{ id: 'c1', role: 'button', name: 'Use my location' }, { id: 'c2', role: 'button', name: 'Choose file' }, { id: 'c3', role: 'button', name: 'Use a different card' }]);
  not([{ id: 'c1', role: 'button', name: 'Continue as Krish' }, { id: 'c2', role: 'button', name: 'Continue' }]);
  not([{ id: 'c1', role: 'link', name: 'How to choose a profile picture' }, { id: 'c2', role: 'link', name: 'Sign in' }]);

  // A page headed like a chooser: the choices are the controls of the clicked one's kind, without its housekeeping.
  const netflix = { url: 'https://www.netflix.com/browse', title: 'Netflix', elements: [
    { id: 'n0', role: 'heading', name: 'Who’s watching?' }, { id: 'n1', role: 'link', name: 'Krish' }, { id: 'n2', role: 'link', name: 'Kids' },
    { id: 'n3', role: 'link', name: 'Add Profile' }, { id: 'n4', role: 'button', name: 'Manage Profiles' }] };
  const who = chooserStep({ ...netflix, targetId: 'n2', goal: 'play Stranger Things on Netflix' });
  assert.deepEqual([who.do, who.question, who.options], ['ask', 'Which Netflix profile should I use?', ['Krish', 'Kids']]);
  assert.equal(chooserStep({ ...netflix, targetId: 'n4', goal: 'play Stranger Things on Netflix' }), null);
  assert.equal(findChooser({ ...netflix }).kind, 'profile', 'headed like one is enough to say where a task got stuck');
  // A heading that only begins like a chooser's is for something else, in a heading or in the page's title.
  // 2026-11-21 review: "Choose your profile picture" over Upload a photo, Remove photo and Save was asked about as
  // "Which GitHub profile should I use? Upload a photo or Save?".
  const under = [{ id: 'u1', role: 'button', name: 'Octocat' }, { id: 'u2', role: 'button', name: 'Identicon' }, { id: 'u3', role: 'button', name: 'Guest' }];
  for (const name of ['Choose your profile picture', 'Choose an account type', 'Select a profile to edit', 'Who’s watching the kids tonight?']) {
    assert.equal(chooserStep({ elements: [{ id: 'u0', role: 'heading', name }, ...under], targetId: 'u1', goal: 'change my picture', url: 'https://github.com/settings/profile' }), null, name);
    assert.equal(chooserStep({ elements: under, title: `${name} · GitHub`, targetId: 'u1', goal: 'change my picture', url: 'https://github.com/settings/profile' }), null, name);
  }
  for (const name of ['Choose an account', 'Choose an account to continue to YouTube', 'Select a profile.', 'Who is watching?', 'Pick an account:']) {
    assert.equal(chooserStep({ elements: [{ id: 'u0', role: 'heading', name }, ...under], targetId: 'u1', goal: 'open it', url: 'https://example.com/' })?.do, 'ask', name);
  }
  assert.equal(chooserStep({ elements: under, title: 'Choose an account - Google Accounts', targetId: 'u1', goal: 'open it', url: 'https://accounts.google.com/' })?.do, 'ask');
  const dialog = [{ id: 'u0', role: 'heading', name: 'Choose your profile' }, { id: 'u1', role: 'button', name: 'Upload a photo' }, { id: 'u2', role: 'button', name: 'Remove photo' }, { id: 'u3', role: 'button', name: 'Save' }];
  assert.equal(chooserStep({ elements: dialog, targetId: 'u1', goal: 'change my picture', url: 'https://github.com/settings/profile' }), null, 'what a page does with a choice is not a choice');
  // What carries a choice out is not one of the choices: with Krish remembered, Continue is still the model's to
  // press, and it is not offered as a third profile. A click on the other profile is turned to the one remembered.
  const max = { url: 'https://www.max.com/', title: 'Max', elements: [{ id: 'm0', role: 'heading', name: 'Who’s watching?' }, { id: 'm1', role: 'button', name: 'Krish' },
    { id: 'm2', role: 'button', name: 'Sandeep' }, { id: 'm3', role: 'button', name: 'Continue' }, { id: 'm4', role: 'button', name: 'Save' }] };
  assert.equal(chooserStep({ ...max, targetId: 'm3', goal: 'play Dune on Max', ways: ['Max profile: Krish'] }), null);
  assert.equal(chooserStep({ ...max, targetId: 'm4', goal: 'play Dune on Max' }), null);
  assert.equal(chooserStep({ ...max, targetId: 'm2', goal: 'play Dune on Max', ways: ['Max profile: Krish'] }).elementId, 'm1');
  assert.deepEqual(chooserStep({ ...max, targetId: 'm2', goal: 'play Dune on Max' }).options, ['Krish', 'Sandeep']);

  // An answer picks by name, by a word only one has, or by place; anything else picks nothing.
  const choices = who.choices;
  assert.equal(chooserPick(choices, 'Krish.').id, 'n1');
  assert.equal(chooserPick(choices, 'the kids one').id, 'n2');
  assert.equal(chooserPick(choices, 'the second one').id, 'n2');
  assert.equal(chooserPick(choices, 'neither of them'), null);
  // A name as the microphone heard it is the one it is near, when it is near only one; a word that is no name is none.
  const two = [{ id: 'p1', ids: ['p1'], name: 'Krish' }, { id: 'p2', ids: ['p2'], name: 'Sandeep Chavan' }];
  assert.equal(chooserPick(two, 'Chris').id, 'p1');
  assert.equal(chooserPick(two, 'I think Kris').id, 'p1');
  assert.equal(chooserPick(two, 'Sundip').id, 'p2');
  for (const none of ['yes', 'what?', 'sandy', 'the TV is on', 'neither, leave it']) assert.equal(chooserPick(two, none), null, none);
  assert.equal(chooserPick([{ id: 'a', name: 'Chris' }, { id: 'b', name: 'Krish' }], 'Kris'), null, 'near two of them is near neither');
  // Which one not is not which one: the name in it is the one refused.
  assert.equal(chooserPick(two, 'not Krish'), null);
  assert.equal(chooserPick(two, 'anyone but Sandeep'), null);
  assert.equal(chooserPick(two, 'no, Krish').id, 'p1');
  // Words said of something else pick by name only: never by place, never by a near sound.
  assert.equal(chooserPick(two, 'the first one', { strict: true }), null);
  assert.equal(chooserPick(two, 'Chris', { strict: true }), null);
  assert.equal(chooserPick(two, 'sandeep', { strict: true }).id, 'p2');
  // A remembered answer that chose nothing settles nothing.
  assert.equal(chooserStep({ ...hulu, targetId: 'p2', goal: HULU, ways: ['Hulu profile: neither, leave it'] }).do, 'ask');
  assert.equal(chooserStep({ ...hulu, targetId: 'p2', goal: HULU, ways: ['Hulu profile: the first one'] }).do, 'ask');
  assert.equal(siteName('https://accounts.google.com/signin'), 'Google');
  assert.equal(siteName('https://www.bbc.co.uk/iplayer'), 'Bbc');
  assert.equal(siteName('https://www.youtube.com/'), 'YouTube');
});

test('the ask action: a question, two to four short ways to answer it, and what it is about', () => {
  assert.deepEqual(validateAction({ action: 'ask', question: 'Which Sarah should I message?', options: ['Sarah Miller', 'Sarah Chen'], about: 'Sarah' }),
    { action: 'ask', question: 'Which Sarah should I message?', options: ['Sarah Miller', 'Sarah Chen'], about: 'Sarah' });
  assert.deepEqual(validateAction({ action: 'ask', question: 'Which plan do you want?' }), { action: 'ask', question: 'Which plan do you want?' });
  assert.throws(() => validateAction({ action: 'ask' }));
  assert.throws(() => validateAction({ action: 'ask', question: '   ' }));
  assert.throws(() => validateAction({ action: 'ask', question: 'Which?', options: 'Krish' }));
  assert.throws(() => validateAction({ action: 'ask', question: 'Which?', options: ['Krish', 2] }));
  assert.throws(() => validateAction({ action: 'ask', question: 'Which?', elementId: 'p1' }));
  // Too long or too many is cut to what's kept, and one way to answer is none: the question is still asked.
  const long = validateAction({ action: 'ask', question: 'q'.repeat(300), options: ['a', 'b', 'c', 'd', 'e', 'x'.repeat(90)], about: 'y'.repeat(90) });
  assert.deepEqual([long.question.length, long.options, long.about.length], [160, ['a', 'b', 'c', 'd'], 40]);
  assert.equal(validateAction({ action: 'ask', question: 'Which?', options: ['only one'] }).options, undefined);
});

test('Hulu’s profile picker, and a request that names no profile: the model’s click is held back, the app is asked, and the answer is clicked', async (t) => {
  t.mock.method(console, 'info', () => {});
  replies = [click('p2'), finished()];
  const task = fromDesktop(HULU);
  const ask = await asked();
  assert.deepEqual({ ...ask, id: '' }, { type: 'ask', id: '', label: 'Which Hulu profile should I use?', open: true, options: ['Krish', 'Sandeep Chavan'] });
  assert.deepEqual(clicked, [], 'nothing is clicked while the question is open');
  answer(ask, 'Krish');
  const done = await task.done();
  assert.equal(done.ok, true, done.say);
  assert.deepEqual(clicked, ['p1'], 'the profile the user chose, not the one the model picked');
  assert.deepEqual(done.chose, [{ about: 'Hulu profile', choice: 'Krish' }]);
  assert.equal(asks().length, 1);
  // The step after the answer is told of it: as a fact of the task, and as a choice to go by.
  assert.deepEqual(prompts[1].userChoices, ['Hulu profile: Krish']);
  assert.ok(prompts[1].memory.facts.some((fact) => /^The user said “Krish” when asked: Which Hulu profile should I use\?/.test(fact)), JSON.stringify(prompts[1].memory.facts));
});

test('a request that names a profile, or an answer remembered from before: that one is clicked with no question, whichever the model chose', async (t) => {
  t.mock.method(console, 'info', () => {});
  replies = [click('p2'), finished()];
  const named = await fromDesktop(`${HULU} on my Krish profile`).done();
  assert.equal(named.ok, true, named.say);
  assert.deepEqual(clicked, ['p1']);
  assert.equal(named.chose, undefined, 'nothing was asked, so nothing new was chosen');

  screen = picker(); Object.assign(tab, { url: screen.url }); clicked.length = 0; prompts = [];
  replies = [click('p1'), finished()];
  const remembered = await fromDesktop(HULU, { ways: ['Text Dad: use Messages', 'Hulu profile: Sandeep Chavan'] }).done();
  assert.equal(remembered.ok, true, remembered.say);
  assert.deepEqual(clicked, ['p2']);
  assert.deepEqual(prompts[0].userChoices, ['Text Dad: use Messages', 'Hulu profile: Sandeep Chavan'], 'the model is shown them too');
  assert.equal(asks().length, 0);

  // Enter on a choice is a click on it by another name, and is held to the same.
  screen = picker(); Object.assign(tab, { url: screen.url }); clicked.length = 0;
  replies = [{ action: { action: 'press_key', elementId: 'p2', key: 'Enter' } }, finished()];
  assert.equal((await fromDesktop(`${HULU} as Krish`).done()).ok, true);
  assert.deepEqual(clicked, ['p1']);
  assert.equal(asks().length, 0);
});

test('a Google account chooser is the same: asked once, and not when the request or an earlier answer names the account', async (t) => {
  t.mock.method(console, 'info', () => {});
  const google = () => { screen = accounts(); Object.assign(tab, { url: screen.url, title: screen.title }); clicked.length = 0; };
  google();
  replies = [click('g1'), { action: { action: 'finish', say: 'You’re signed in to Canvas.', success: true } }];
  const task = fromDesktop('sign in to Canvas with my Google account');
  const ask = await asked();
  assert.deepEqual([ask.label, ask.open, ask.options], ['Which Google account should I use?', true, ['Krish', 'Use another account']]);
  assert.deepEqual(clicked, []);
  answer(ask, 'Krish');
  const done = await task.done();
  assert.equal(done.ok, true, done.say);
  assert.deepEqual(clicked, ['g1']);
  assert.deepEqual(done.chose, [{ about: 'Google account', choice: 'Krish' }]);

  google();
  replies = [click('g2'), { action: { action: 'finish', say: 'You’re signed in to Canvas.', success: true } }];
  assert.equal((await fromDesktop('sign in to Canvas with Google as Krish').done()).ok, true);
  assert.deepEqual(clicked, ['g1']);

  google();
  replies = [click('g2'), { action: { action: 'finish', say: 'You’re signed in to Canvas.', success: true } }];
  assert.equal((await fromDesktop('sign in to Canvas', { ways: ['Google account: Krish'] }).done()).ok, true);
  assert.deepEqual(clicked, ['g1']);
  assert.equal(asks().length, 1, 'only the first was asked');
});

test('the model’s own question goes to the app with its options, and the answer comes back into the next step', async (t) => {
  t.mock.method(console, 'info', () => {});
  screen = { id: 'people', url: 'https://mail.example.com/contacts', title: 'Contacts', elements: [{ id: 's1', role: 'link', name: 'Sarah Miller' }, { id: 's2', role: 'link', name: 'Sarah Chen' }] };
  Object.assign(tab, { url: screen.url, title: screen.title });
  replies = [{ action: { action: 'ask', question: 'Which Sarah do you mean?', options: ['Sarah Miller', 'Sarah Chen'], about: 'Sarah' } },
    click('s2'), { action: { action: 'finish', say: 'Here is Sarah Chen.', success: true } }];
  const task = fromDesktop('show me Sarah’s contact card');
  const ask = await asked();
  assert.deepEqual({ ...ask, id: '' }, { type: 'ask', id: '', label: 'Which Sarah do you mean?', open: true, options: ['Sarah Miller', 'Sarah Chen'] });
  answer(ask, 'the one from work, Chen');
  const done = await task.done();
  assert.equal(done.ok, true, done.say);
  assert.deepEqual(clicked, ['s2']);
  // What is kept is the option their words meant; the model has the words too.
  assert.deepEqual(done.chose, [{ about: 'Sarah', choice: 'Sarah Chen' }]);
  assert.equal(prompts[1].lastResult.ok, true);
  assert.equal(prompts[1].lastResult.question, 'Which Sarah do you mean?');
  assert.equal(prompts[1].lastResult.answer, 'the one from work, Chen');
  assert.equal(prompts[1].lastResult.chosen, 'Sarah Chen');
  assert.deepEqual(prompts[1].userChoices, ['Sarah: Sarah Chen']);
  assert.equal(prompts[1].originalGoal, 'show me Sarah’s contact card', 'the same task carries on');
});

test('no answer ends the task, unsure and saying of what, with nothing clicked; an old app’s bare yes is no answer either', async (t) => {
  t.mock.method(console, 'info', () => {});
  replies = [click('p2')];
  const unanswered = fromDesktop(HULU);
  portMessages.fire({ type: 'answer', id: (await asked()).id, approved: false });
  const left = await unanswered.done();
  assert.deepEqual([left.ok, left.say], [false, 'I wasn’t sure which Hulu profile to use, so I stopped there.']);
  assert.deepEqual(clicked, []);
  assert.equal(left.chose, undefined);
  assert.equal(session.agentTask, undefined, 'nothing is left to be picked up and guessed at');

  // Jester Desktop from before such questions answers every ask with allowed or not: allowed says nothing of which.
  replies = [click('p2')];
  const old = fromDesktop(HULU);
  portMessages.fire({ type: 'answer', id: (await asked(2)).id, approved: true });
  const bare = await old.done();
  assert.deepEqual([bare.ok, bare.say], [false, 'I wasn’t sure which Hulu profile to use, so I stopped there.']);
  assert.deepEqual(clicked, []);

  // The model's own question, left unanswered, is said as what it was.
  replies = [{ action: { action: 'ask', question: 'Which plan do you want?' } }];
  const plan = fromDesktop('upgrade my Hulu plan');
  portMessages.fire({ type: 'answer', id: (await asked(3)).id, approved: false });
  assert.equal((await plan.done()).say, 'I stopped there because I wasn’t sure about this: Which plan do you want?');
  assert.equal(replies.length, 0);
});

const left = (say = 'I left the profile screen as it was.') => ({ action: { action: 'finish', say, success: false } });
/** What the page was asked to do, in order: ["click p1"], ["focus p2", "press_key Enter"]. */
const carried = () => sent.filter((entry) => entry.message.type === 'jester/agent-execute')
  .map(({ message }) => [message.action.action, message.action.elementId, message.action.key].filter(Boolean).join(' '));

test('an answer that names none of the choices goes to the model as the user’s words, and the model still may not pick one of them', async (t) => {
  t.mock.method(console, 'info', () => {});
  replies = [click('p2'), left()];
  const task = fromDesktop(HULU);
  answer(await asked(), 'neither, leave it');
  const done = await task.done();
  assert.equal(done.ok, false);
  assert.deepEqual(clicked, [], 'the answer chose neither, so neither was clicked');
  assert.equal(prompts[1].lastResult.answer, 'neither, leave it');
  assert.match(prompts[1].lastResult.detail, /name none of the choices/);
  assert.equal(asks().length, 1);
  assert.equal(done.chose, undefined, 'words that chose nothing are not handed back as a choice');
  assert.equal(prompts[1].userChoices, undefined);

  // 2026-11-21 review: after such an answer the model's next click on a profile went through, and the task ended ok
  // on a profile nobody chose. Whatever the answer was ("yes", the television), the choice is still the user's.
  for (const words of ['neither, leave it', 'yes', 'not Krish']) {
    posted.length = 0; clicked.length = 0;
    replies = [click('p2'), click('p2'), finished()];
    const again = fromDesktop(HULU);
    answer(await asked(), words);
    const ended = await again.done();
    assert.deepEqual([ended.ok, ended.say], [false, 'I wasn’t sure which Hulu profile to use, so I stopped there.'], words);
    assert.deepEqual(clicked, [], words);
    assert.equal(asks().length, 1, 'and the same thing is not asked twice');
    assert.equal(ended.chose, undefined);
    assert.equal(replies.length, 1, 'the task ended at the click');
  }

  // What the answer really asked for is not one of the choices, and is the model's to do.
  posted.length = 0; clicked.length = 0;
  replies = [click('p2'), click('p3'), left('The profiles are open to manage.')];
  const manage = fromDesktop(HULU);
  answer(await asked(), 'neither, open manage profiles');
  await manage.done();
  assert.deepEqual(clicked, ['p3']);
});

test('what is handed back to be remembered is the name of what was chosen: by place, or as the microphone heard it', async (t) => {
  t.mock.method(console, 'info', () => {});
  // The picker stays up whatever is clicked, so the model gets to choose again.
  screen = { ...picker(), after: {} };
  replies = [click('p2'), click('p2'), left()];
  const placed = fromDesktop(HULU);
  answer(await asked(), 'the first one');
  const first = await placed.done();
  assert.deepEqual(first.chose, [{ about: 'Hulu profile', choice: 'Krish' }], '“the first one” names nothing the next time');
  assert.deepEqual(clicked, ['p1', 'p1'], 'and for the rest of the task the model’s other pick is turned to it');
  assert.deepEqual(prompts[1].userChoices, ['Hulu profile: Krish']);
  assert.equal(asks().length, 1);

  screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; clicked.length = 0;
  replies = [click('p2'), finished()];
  const misheard = fromDesktop(HULU);
  answer(await asked(), 'Chris');
  const heard = await misheard.done();
  assert.equal(heard.ok, true, heard.say);
  assert.deepEqual(clicked, ['p1']);
  assert.deepEqual(heard.chose, [{ about: 'Hulu profile', choice: 'Krish' }]);

  // A new answer about the same thing takes the old one's place among what the model is shown.
  screen = { ...picker(), elements: [PROFILES[1], { id: 'p4', role: 'button', name: 'Switch profile to Kids' }], after: { p4: HOME } };
  posted.length = 0; clicked.length = 0; prompts = [];
  replies = [click('p2'), finished()];
  const gone = fromDesktop(HULU, { ways: ['Hulu profile: Krish'] });
  answer(await asked(), 'Kids');
  assert.deepEqual((await gone.done()).chose, [{ about: 'Hulu profile', choice: 'Kids' }]);
  assert.deepEqual(clicked, ['p4']);
  assert.deepEqual(prompts[1].userChoices, ['Hulu profile: Kids']);
});

test('the model asks which profile for itself, and the page’s own guard does not ask the same thing again', async (t) => {
  t.mock.method(console, 'info', () => {});
  const own = (more = {}) => ({ action: { action: 'ask', question: 'Which profile should I use?', options: ['Krish', 'Sandeep Chavan'], ...more } });
  // 2026-11-21 review: with no `about`, or one like "profile", nothing the guard goes by held the answer, and "Which
  // Hulu profile should I use?" came straight after "Which profile should I use?" had been answered.
  for (const more of [{}, { about: 'profile' }, { about: 'Hulu profile' }]) {
    screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; clicked.length = 0;
    replies = [own(more), click('p2'), finished()];
    const task = fromDesktop(HULU);
    const ask = await asked();
    assert.equal(ask.label, 'Which profile should I use?');
    answer(ask, 'Krish');
    const done = await task.done();
    assert.equal(done.ok, true, done.say);
    assert.equal(asks().length, 1, `one question only (${JSON.stringify(more)})`);
    assert.deepEqual(clicked, ['p1'], 'the one they named, though the model then clicked the other');
    assert.deepEqual(done.chose, [{ about: 'Hulu profile', choice: 'Krish' }], 'kept once, as what it is');
  }

  // Answered with neither of them, the model's click on one is not carried out and nothing more is asked.
  screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; clicked.length = 0;
  replies = [own(), click('p2'), finished()];
  const refused = fromDesktop(HULU);
  answer(await asked(), 'neither of them');
  const ended = await refused.done();
  assert.deepEqual([ended.ok, ended.say], [false, 'I wasn’t sure which Hulu profile to use, so I stopped there.']);
  assert.deepEqual(clicked, []);
  assert.equal(asks().length, 1);

  // An answer about something else is not an answer to this: the Sarah of their contacts is not the profile to use,
  // and "the first one" said of plans is not the first profile.
  for (const [question, words] of [[{ question: 'Which Sarah do you mean?', options: ['Sarah Miller', 'Krish'], about: 'Sarah' }, 'Krish'],
    [{ question: 'Which plan do you want?', options: ['Basic', 'Premium'] }, 'the first one']]) {
    screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; clicked.length = 0;
    replies = [{ action: { action: 'ask', ...question } }, click('p2'), finished()];
    const other = fromDesktop(HULU);
    answer(await asked(1), words);
    const second = await asked(2);
    assert.equal(second.label, 'Which Hulu profile should I use?', question.question);
    assert.deepEqual(clicked, []);
    answer(second, 'Sandeep');
    assert.deepEqual((await other.done()).chose.at(-1), { about: 'Hulu profile', choice: 'Sandeep Chavan' });
    assert.deepEqual(clicked, ['p2']);
  }
});

test('the keyboard is held to the same: Enter on whatever has the focus picks no profile by itself', async (t) => {
  t.mock.method(console, 'info', () => {});
  // 2026-11-21 review: focus on a profile and then a bare Enter went past the guard, which looked only at keys that
  // named their element. A model whose clicks aren't taking is the one that tries the keyboard next.
  replies = [{ actions: [{ action: 'focus', elementId: 'p2' }, { action: 'press_key', key: 'Enter' }] }, finished()];
  const grouped = fromDesktop(HULU);
  const ask = await asked();
  assert.equal(ask.label, 'Which Hulu profile should I use?');
  assert.deepEqual(carried(), ['focus p2'], 'the key is not sent while the question is open');
  answer(ask, 'Krish');
  assert.equal((await grouped.done()).ok, true);
  assert.deepEqual(carried(), ['focus p2', 'click p1']);

  // The focus in one step and the key in the next; and with Krish named, the key becomes a click on Krish.
  screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; sent.length = 0;
  replies = [{ action: { action: 'focus', elementId: 'p2' } }, { action: { action: 'press_key', key: 'Space' } }, finished()];
  assert.equal((await fromDesktop(`${HULU} as Krish`).done()).ok, true);
  assert.deepEqual(carried(), ['focus p2', 'click p1']);
  assert.equal(asks().length, 0);

  // The page put the focus on a profile itself, and the model only presses the key.
  screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; sent.length = 0; focusOn = 'p2';
  replies = [{ action: { action: 'press_key', key: 'Enter' } }, finished()];
  const bare = fromDesktop(HULU);
  const which = await asked();
  assert.deepEqual(carried(), []);
  answer(which, 'Sandeep Chavan');
  assert.equal((await bare.done()).ok, true);
  assert.deepEqual(carried(), ['click p2']);

  // Enter on a control that is no choice is the model's own, here as anywhere.
  screen = picker(); Object.assign(tab, { url: screen.url }); posted.length = 0; sent.length = 0; focusOn = '';
  replies = [{ actions: [{ action: 'focus', elementId: 'p3' }, { action: 'press_key', key: 'Enter' }] }, left('The profiles are open to manage.')];
  await fromDesktop(HULU).done();
  assert.deepEqual(carried(), ['focus p3', 'press_key p3 Enter']);
  assert.equal(asks().length, 0);
});

test('where the page cannot say what has the focus, a bare Enter goes by the control last given it, and on a chooser is never let pick', async (t) => {
  t.mock.method(console, 'info', () => {});
  const env = { provider: 'groq', model: 'ask-model', key: 'private-ask-key' };
  /** The agent by itself, on the picker, with a host that only observes, acts and asks. */
  const run = async (script, said = 'Krish') => {
    const did = [];
    const questions = [];
    let on = 'profiles';
    const queue = [...script];
    const host = {
      observe: async () => on === 'profiles' ? { ok: true, pageId: 'doc-profiles', revision: 1, url: 'https://www.hulu.com/profiles', title: 'Hulu', elements: structuredClone(PROFILES), text: 'profiles' }
        : { ok: true, pageId: 'doc-home', revision: 1, url: HOME.url, title: HOME.title, elements: structuredClone(HOME.elements), text: 'home' },
      execute: async (action) => {
        did.push([action.action, action.elementId, action.key].filter(Boolean).join(' '));
        if (action.action === 'click' && ['p1', 'p2'].includes(action.elementId)) on = 'home';
        return { ok: true, detail: 'done' };
      },
      ask: async ({ question }) => { questions.push(question); return said; }
    };
    const result = await runAssistant({ text: HULU, env, host, modelClient: async () => ({ json: queue.shift() }) });
    return { did, questions, result };
  };
  const enter = { action: { action: 'press_key', key: 'Enter' } };
  const focus = (elementId) => ({ action: { action: 'focus', elementId } });

  const onProfile = await run([focus('p2'), enter, finished()]);
  assert.deepEqual(onProfile.questions, ['Which Hulu profile should I use?']);
  assert.deepEqual(onProfile.did, ['focus p2', 'click p1']);
  assert.deepEqual(onProfile.result.chose, [{ about: 'Hulu profile', choice: 'Krish' }]);

  const onManage = await run([focus('p3'), enter, left()]);
  assert.deepEqual([onManage.questions, onManage.did], [[], ['focus p3', 'press_key Enter']], 'Enter on what is no choice is the model’s own');

  // Tab moved the focus on from Manage profiles, and nothing says where to: such a key here would pick a profile.
  const tabbed = await run([focus('p3'), { action: { action: 'press_key', key: 'Tab' } }, enter, finished()], 'Sandeep');
  assert.deepEqual(tabbed.questions, ['Which Hulu profile should I use?']);
  assert.deepEqual(tabbed.did, ['focus p3', 'press_key Tab', 'click p2']);

  // Nothing was given the focus at all.
  const blind = await run([enter, left()], 'neither');
  assert.deepEqual([blind.questions.length, blind.did], [1, []], 'asked, and with neither chosen the key is not sent');
});

test('three questions a task at most, and never the same one twice', async (t) => {
  t.mock.method(console, 'info', () => {});
  screen = { id: 'form', url: 'https://shop.example.com/order', title: 'Order', elements: [{ id: 'f1', role: 'button', name: 'Next' }] };
  Object.assign(tab, { url: screen.url, title: screen.title });
  const question = (words) => ({ action: { action: 'ask', question: words } });
  replies = [question('Which size?'), question('Which colour?'), question('which size'), question('Gift wrapped?'), question('Which card?'), question('Which address?')];
  const task = fromDesktop('order the jacket I looked at');
  answer(await asked(1), 'medium');
  answer(await asked(2), 'green');
  answer(await asked(3), 'no');
  const done = await task.done();
  assert.deepEqual(asks().map((ask) => ask.label), ['Which size?', 'Which colour?', 'Gift wrapped?']);
  // The repeat and the fourth were refused with the reason; asking on after that ends it, unsure, with no guess.
  assert.match(prompts[3].lastResult.detail, /already answered this/);
  assert.match(prompts[5].lastResult.detail, /as many questions as one task may ask/);
  assert.deepEqual([done.ok, done.say], [false, 'I stopped there because I wasn’t sure about this: Which address?']);
  assert.deepEqual(clicked, []);
});

test('a question does not count as a step repeated: after it, a control that really is stuck is said as where', async (t) => {
  t.mock.method(console, 'info', () => {});
  // The picker stays up whatever is clicked.
  screen = { ...picker(), after: {} };
  replies = [click('p2'), click('p2'), click('p2'), click('p2')];
  const task = fromDesktop(HULU);
  answer(await asked(), 'Krish');
  const done = await task.done();
  assert.equal(done.ok, false);
  assert.equal(done.say, 'I couldn’t get past the profile screen on Hulu, so pick one there and say “keep going”.');
  assert.deepEqual(clicked, ['p1', 'p1'], 'the user’s profile each time, and the third try is not made');
  assert.equal(asks().length, 1, 'asked once: the answer is remembered for the rest of the task');
  assert.deepEqual(done.chose, [{ about: 'Hulu profile', choice: 'Krish' }], 'what they chose is handed back however the task ended');
});

test('by itself, the extension asks on its own pill, hears the answer, and remembers it for next time', async (t) => {
  t.mock.method(console, 'info', () => {});
  // The link to Jester Desktop closes: the extension has the mic, and Chrome is what the user is looking at.
  portClosed.fire();
  chromeInFront = true;
  focusChanged.fire(1);
  t.after(() => { chromeInFront = false; });
  await tick();
  const say = (text) => message({ type: 'jester/voice-command', text }, engineSender);
  const answered = () => sent.filter((entry) => entry.message.voice?.phase === 'answer').at(-1)?.message.voice;
  const QUESTION = 'Which Hulu profile should I use? Krish or Sandeep Chavan?';
  replies = [click('p2'), finished()];
  await say(HULU);
  await until(() => sent.some((entry) => entry.message.voice?.step === QUESTION), 'the question on the pill');
  assert.ok(broadcasts.some((entry) => entry.type === 'jester/voice-control' && entry.action === 'start'), 'the microphone opens for the answer');
  assert.deepEqual(broadcasts.findLast((entry) => entry.type === 'jester/approval-state').approval.options, ['Krish', 'Sandeep Chavan'], 'the popup can answer too');
  assert.deepEqual(clicked, []);
  await say('Sandeep.');
  await until(() => answered(), 'the task’s end');
  assert.equal(answered().ok, true, answered().text);
  assert.deepEqual(clicked, ['p2']);
  assert.deepEqual(local.userChoices.map(({ about, choice }) => ({ about, choice })), [{ about: 'Hulu profile', choice: 'Sandeep Chavan' }]);

  // Next time the picker comes up, nobody is asked.
  screen = picker(); Object.assign(tab, { url: screen.url }); clicked.length = 0; sent.length = 0; delete session.modelPacing;
  replies = [click('p1'), finished()];
  await say(HULU);
  await until(() => answered(), 'the second task’s end');
  assert.deepEqual(clicked, ['p2']);
  assert.equal(sent.some((entry) => entry.message.voice?.step === QUESTION), false);

  // Something else said instead of an answer is a new request: the question is left unanswered, and nothing is clicked for it.
  delete local.userChoices;
  screen = picker(); Object.assign(tab, { url: screen.url }); clicked.length = 0; sent.length = 0; delete session.modelPacing;
  replies = [click('p2')];
  await say(HULU);
  await until(() => sent.some((entry) => entry.message.voice?.step === QUESTION), 'the question again');
  await say('never mind');
  await until(() => answered(), 'the called-off task’s end');
  assert.deepEqual([answered().ok, answered().text], [false, 'I wasn’t sure which Hulu profile to use, so I stopped there.']);
  assert.deepEqual(clicked, []);
  assert.equal(local.userChoices, undefined);
});
