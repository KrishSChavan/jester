import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeAction, validateTurn } from '../desktop/src/main/agent/actions.js';
import { createDesktopHost } from '../desktop/src/main/agent/host.js';
import { runDesktopAgent } from '../desktop/src/main/agent/loop.js';
import { findElements, screenText } from '../desktop/src/main/agent/screen.js';

const frame = (x, y) => ({ x, y, w: 80, h: 30 });
/** Spotify's search results, as jester-driver's snapshot lists them. */
const SPOTIFY = {
  snapshot: 7,
  app: { name: 'Spotify', pid: 42 },
  window: { title: 'Spotify Premium', frame: { x: 0, y: 0, w: 1200, h: 800 } },
  elements: [
    { id: 0, role: 'searchfield', label: 'What do you want to play?', value: 'gunna', depth: 4, frame: frame(300, 20) },
    { id: 1, role: 'text', label: 'Top result', depth: 6 },
    { id: 2, role: 'button', label: 'Play Gunna', depth: 7, frame: frame(400, 200) },
    { id: 3, role: 'checkbox', label: 'Shuffle', checked: false, depth: 5 },
    { id: 4, role: 'button', label: 'Send feedback', depth: 3 }
  ]
};
const MESSAGES = {
  snapshot: 3,
  app: { name: 'Messages', pid: 9 },
  window: { title: 'Messages' },
  elements: [
    { id: 0, role: 'textfield', label: 'Message', focused: true, depth: 5 },
    { id: 1, role: 'button', label: 'Send', depth: 5 },
    { id: 2, role: 'password', label: 'Apple ID password', depth: 5 }
  ]
};

test('the screen reads as numbered lines, keeping what the goal is about when it must cut', () => {
  assert.equal(
    screenText(SPOTIFY),
    [
      'App: Spotify — "Spotify Premium"',
      '[0] searchfield "What do you want to play?" value: "gunna"',
      '[1] text "Top result"',
      '[2] button "Play Gunna"',
      '[3] checkbox "Shuffle" (unchecked)',
      '[4] button "Send feedback"'
    ].join('\n')
  );
  const crowded = { ...SPOTIFY, elements: [...Array.from({ length: 200 }, (_, i) => ({ id: i + 10, role: 'button', label: `Album number ${i}` })), ...SPOTIFY.elements] };
  const text = screenText(crowded, { goal: 'play Gunna', chars: 1500 });
  assert.ok(text.length <= 1500);
  assert.match(text, /\[2\] button "Play Gunna"/, 'the control the goal names survives the cut');
  assert.match(text, /more on screen not shown: use find/);
  assert.deepEqual(findElements(crowded, 'album 199'), ['[209] button "Album number 199"']);
});

test('replies are checked: one action, or a group of up to three controls', () => {
  assert.deepEqual(validateTurn({ action: { action: 'click', id: 2 } }).actions, [{ action: 'click', id: 2 }]);
  assert.equal(validateTurn({ actions: [{ action: 'type', id: 0, text: 'gunna', enter: true }, { action: 'press', keys: 'down' }] }).actions.length, 2);
  for (const bad of [
    { action: { action: 'click' } },
    { action: { action: 'click', id: 2, selector: '#play' } },
    { action: { action: 'press', keys: 'cmd+banana' } },
    { action: { action: 'open_url', url: 'file:///etc/passwd' } },
    { action: { action: 'open_url', url: 'https://user:pw@example.com' } },
    { actions: [{ action: 'click', id: 1 }, { action: 'finish', say: 'done', success: true }] },
    { action: { action: 'click', id: 1 }, actions: [] },
    { action: { action: 'run_script', code: 'rm -rf ~' } }
  ]) {
    assert.throws(() => validateTurn(bad), Error, JSON.stringify(bad));
  }
});

test('the user\'s rule: ask before sending, buying, deleting or settings; never a password field', () => {
  const kind = (action, screen, goal = '') => classify(action, { screen, goal }).category;
  assert.equal(kind({ action: 'click', id: 2 }, SPOTIFY), 'browse');
  assert.equal(kind({ action: 'click', id: 4 }, SPOTIFY), 'sensitive', '"Send feedback" sends');
  assert.equal(kind({ action: 'type', id: 0, text: 'gunna', enter: true }, SPOTIFY), 'browse', 'Enter in a search box only searches');
  assert.equal(kind({ action: 'type', id: 0, text: 'hi', enter: true }, MESSAGES), 'sensitive', 'Enter in Messages sends');
  assert.equal(kind({ action: 'type', id: 0, text: 'hi' }, MESSAGES), 'browse', 'typing alone sends nothing');
  assert.equal(kind({ action: 'press', keys: 'enter' }, MESSAGES), 'sensitive');
  assert.equal(kind({ action: 'press', keys: 'cmd+enter' }, SPOTIFY), 'sensitive');
  assert.equal(kind({ action: 'press', keys: 'cmd+backspace' }, SPOTIFY), 'sensitive');
  assert.equal(kind({ action: 'press', keys: 'cmd+n' }, SPOTIFY), 'browse');
  assert.equal(kind({ action: 'click', id: 2 }, MESSAGES), 'blocked');
  assert.equal(kind({ action: 'click', id: 0 }, { app: { name: 'System Settings' }, elements: [{ id: 0, role: 'switch', label: 'Wi-Fi' }] }), 'sensitive');
  assert.equal(kind({ action: 'open_url', url: 'https://www.youtube.com/results?search_query=gunna' }, SPOTIFY), 'browse');
  assert.equal(kind({ action: 'open_url', url: 'https://www.theverge.com/' }, SPOTIFY, 'open the verge'), 'browse');
  assert.equal(kind({ action: 'open_url', url: 'https://evil.example/?q=secret' }, SPOTIFY, 'play gunna'), 'sensitive');
  assert.equal(kind({ action: 'find', query: 'play' }, SPOTIFY), 'read');
  assert.equal(describeAction({ action: 'click', id: 2 }, SPOTIFY), 'Click “Play Gunna”');
  assert.equal(describeAction({ action: 'press', keys: 'cmd+shift+t' }, SPOTIFY, 'darwin'), 'Press ⌘⇧T');
});

/** A model that answers from a script, and remembers what it was shown. */
function scripted(...replies) {
  const prompts = [];
  const model = async ({ prompt, schema }) => {
    assert.ok(schema, 'the desktop schema is sent');
    prompts.push(JSON.parse(prompt));
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { json: next };
  };
  return { model, prompts };
}

function fakeHost(screen) {
  const done = [];
  return {
    done,
    host: {
      observe: async () => ({ ok: true, snapshot: screen }),
      execute: async (action) => {
        done.push(action);
        return { ok: true };
      }
    }
  };
}

test('playing something: the model sees the screen, presses Play, and finishes', async () => {
  const { model, prompts } = scripted(
    { action: { action: 'click', id: 2 }, memory: { subgoal: 'check it plays' } },
    { action: { action: 'finish', say: 'Playing Gunna.', success: true } }
  );
  const { host, done } = fakeHost(SPOTIFY);
  const steps = [];
  const result = await runDesktopAgent({ goal: 'play Gunna on Spotify', host, model, confirm: async () => assert.fail('nothing here needs asking'), onStep: (step) => steps.push(step), platform: 'darwin' });
  assert.deepEqual(result, { ok: true, say: 'Playing Gunna.', actions: 1 });
  assert.deepEqual(done, [{ action: 'click', id: 2 }]);
  assert.match(prompts[0].screen, /\[2\] button "Play Gunna"/);
  assert.equal(prompts[1].lastResult.action, 'Click “Play Gunna”');
  assert.equal(prompts[1].memory.subgoal, 'check it plays');
  assert.ok(steps.some((step) => step.phase === 'acting' && step.label === 'Click “Play Gunna”'));
});

test('a sensitive step waits for the user; "no" means nothing is done', async () => {
  const asked = [];
  const { host, done } = fakeHost(MESSAGES);
  const declined = await runDesktopAgent({
    goal: 'text Sam that I am late',
    host,
    model: scripted({ actions: [{ action: 'type', id: 0, text: 'I am late' }, { action: 'click', id: 1 }] }).model,
    confirm: async (ask) => (asked.push(ask), false),
    platform: 'darwin'
  });
  assert.deepEqual(declined, { ok: false, say: 'Okay, I didn’t do that.', actions: 1, declined: true });
  assert.deepEqual(done, [{ action: 'type', id: 0, text: 'I am late' }], 'typed, but never sent');
  assert.deepEqual(asked, [{ label: 'Click “Send”', reason: 'it may send, buy or delete something' }]);

  const approved = fakeHost(MESSAGES);
  const sent = await runDesktopAgent({
    goal: 'text Sam that I am late',
    host: approved.host,
    model: scripted({ action: { action: 'click', id: 1 } }, { action: { action: 'finish', say: 'Sent.', success: true } }).model,
    confirm: async () => true,
    platform: 'darwin'
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(approved.done, [{ action: 'click', id: 1 }]);
});

test('a password field is refused, told to the model, and never touched', async () => {
  const { model, prompts } = scripted({ action: { action: 'click', id: 2 } }, { action: { action: 'finish', say: 'I can’t enter passwords.', success: false } });
  const { host, done } = fakeHost(MESSAGES);
  const result = await runDesktopAgent({ goal: 'sign in', host, model, confirm: async () => true, platform: 'darwin' });
  assert.equal(result.ok, false);
  assert.deepEqual(done, []);
  assert.equal(prompts[1].lastResult.detail, 'Jester never types into password fields.');
});

test('bad replies get one second chance; failed requests and cancellation end the task', async () => {
  const twice = await runDesktopAgent({ goal: 'play Gunna', host: fakeHost(SPOTIFY).host, model: scripted({ action: { action: 'dance' } }, { nonsense: true }).model, confirm: async () => true });
  assert.equal(twice.say, 'The AI model’s replies didn’t make sense, so I stopped.');

  const notJson = Object.assign(new Error('The model did not return valid JSON.'), { code: 'invalid_json' });
  const recovered = await runDesktopAgent({ goal: 'play Gunna', host: fakeHost(SPOTIFY).host, model: scripted(notJson, { action: { action: 'finish', say: 'Done.', success: true } }).model, confirm: async () => true });
  assert.equal(recovered.ok, true);

  const limited = Object.assign(new Error('Every model is rate-limited until 12:00.'), { code: 'rate_limit' });
  const busy = await runDesktopAgent({ goal: 'play Gunna', host: fakeHost(SPOTIFY).host, model: scripted(limited).model, confirm: async () => true });
  assert.equal(busy.say, 'The AI models are at their limits for now. Try again in a minute.');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runDesktopAgent({ goal: 'play Gunna', host: fakeHost(SPOTIFY).host, model: scripted().model, confirm: async () => true, signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
});

/** A driver with an app in front, and whose field has the keyboard focus. */
function fakeDriver({ front = 42, focusedIn = 42, secure = false, comesBack = true } = {}) {
  const calls = [];
  const state = { front, focusedIn, secure };
  return {
    calls,
    state,
    activate: async (app) => {
      calls.push(['activate', app.pid]);
      if (comesBack) state.front = app.pid;
    },
    driver: {
      call: async (cmd, params) => {
        calls.push([cmd, params]);
        if (cmd === 'act' && params.element === 2) throw new Error('AXPress didn’t work on it');
        if (cmd === 'frontmost') return { app: { pid: state.front } };
        if (cmd === 'focused') return { element: { secure: state.secure }, app: { pid: state.focusedIn } };
        return {};
      }
    }
  };
}
const hostWith = (fake) =>
  createDesktopHost({ driver: fake.driver, activate: fake.activate, openApp: async () => ({ ok: true, text: 'Opening Notes' }), openUrl: async () => undefined, dispatch: async () => ({ ok: true }), wait: async () => undefined });

test('the host presses through accessibility, clicks where drawn if refused, and guards typing', async () => {
  const fake = fakeDriver();
  const { calls } = fake;
  const host = hostWith(fake);
  assert.deepEqual(await host.execute({ action: 'click', id: 2 }, SPOTIFY), { ok: true, detail: 'clicked where it is drawn' });
  assert.deepEqual(calls.slice(0, 3), [['act', { snapshot: 7, element: 2, action: 'press' }], ['frontmost', undefined], ['click', { x: 440, y: 215 }]]);

  calls.length = 0;
  assert.deepEqual(await host.execute({ action: 'type', id: 0, text: 'gunna', enter: true }, SPOTIFY), { ok: true });
  assert.deepEqual(calls.map(([cmd]) => cmd), ['frontmost', 'act', 'focused', 'text', 'key']);
  const focusedSecure = (fake.state.secure = true);
  assert.ok(focusedSecure);

  assert.deepEqual(await host.execute({ action: 'type', text: 'hunter2' }, SPOTIFY), { ok: false, detail: 'Jester never types into password fields.' });
  assert.equal(calls.filter(([cmd]) => cmd === 'text').length, 1, 'nothing more was typed');
  assert.deepEqual(await host.execute({ action: 'find', query: 'shuffle' }, SPOTIFY), { ok: true, detail: '1 found', found: ['[3] checkbox "Shuffle" (unchecked)'] });
});

test('keys go only to the app that was read: brought back to the front, or nothing is typed', async () => {
  // VS Code came to the front while the step waited for an OK: Messages is brought back first.
  const back = fakeDriver({ front: 7, focusedIn: 9 });
  const typed = await hostWith(back).execute({ action: 'type', id: 0, text: 'hello', enter: true }, MESSAGES);
  assert.deepEqual(typed, { ok: true });
  assert.deepEqual(back.calls.filter(([cmd]) => ['activate', 'text', 'key'].includes(cmd)), [['activate', 9], ['text', { text: 'hello' }], ['key', { key: 'enter', modifiers: [] }]]);

  // It won't come back: nothing is typed, and the model is told why.
  const stuck = fakeDriver({ front: 7, comesBack: false });
  assert.deepEqual(await hostWith(stuck).execute({ action: 'type', id: 0, text: 'hello', enter: true }, MESSAGES), {
    ok: false,
    detail: 'Messages isn’t in front any more, so nothing was typed or clicked.'
  });
  assert.equal(stuck.calls.some(([cmd]) => cmd === 'text' || cmd === 'key'), false);

  // In front, but the keyboard focus is in another app's field: still nothing.
  const elsewhere = fakeDriver({ front: 9, focusedIn: 7 });
  assert.equal((await hostWith(elsewhere).execute({ action: 'type', text: 'hello' }, MESSAGES)).ok, false);
  assert.equal(elsewhere.calls.some(([cmd]) => cmd === 'text'), false);

  // Keys and scrolling wait for it too; a press through accessibility reaches the element anywhere.
  const keys = fakeDriver({ front: 7, comesBack: false });
  assert.equal((await hostWith(keys).execute({ action: 'press', keys: 'cmd+n' }, MESSAGES)).ok, false);
  assert.equal((await hostWith(keys).execute({ action: 'scroll', direction: 'down' }, MESSAGES)).ok, false);
  assert.equal(keys.calls.some(([cmd]) => cmd === 'key' || cmd === 'scroll'), false);
  assert.deepEqual(await hostWith(fakeDriver({ front: 7, comesBack: false })).execute({ action: 'click', id: 1 }, MESSAGES), { ok: true, detail: '' });
});

test('a send that was approved and done is never repeated in the same task', async () => {
  const asked = [];
  const { host, done } = fakeHost(MESSAGES);
  const result = await runDesktopAgent({
    goal: 'text Trisha hello',
    host,
    model: scripted(
      { action: { action: 'type', id: 0, text: 'hello', enter: true } },
      // The sent message doesn't show: the model asks to send it again, naming the field differently.
      { action: { action: 'type', id: 0, text: 'hello', enter: true } },
      { action: { action: 'type', id: 0, text: 'hello', enter: true } }
    ).model,
    confirm: async (ask) => (asked.push(ask.label), true),
    platform: 'darwin'
  });
  assert.equal(asked.length, 1, 'asked once');
  assert.equal(done.length, 1, 'sent once');
  assert.deepEqual(result, { ok: false, say: 'I’d already done “Type “hello” in “Message”, then Enter” once, so I stopped rather than do it again.', actions: 1 });
});

test('a screen that won\'t read is tried once more, then the user gets a plain message', async () => {
  let reads = 0;
  const flaky = (failures) =>
    createDesktopHost({
      driver: { call: async (cmd) => (cmd === 'snapshot' && reads++ < failures ? Promise.reject(new Error('the app has no window on screen to read')) : MESSAGES) },
      activate: async () => undefined,
      openApp: async () => ({ ok: true, text: '' }),
      openUrl: async () => undefined,
      dispatch: async () => ({ ok: true }),
      wait: async () => undefined
    });
  assert.equal((await flaky(1).observe()).ok, true, 'a second read can succeed');

  reads = 0;
  const steps = [];
  const result = await runDesktopAgent({ goal: 'text Trisha hello', host: flaky(2), model: scripted().model, confirm: async () => true, onStep: (step) => steps.push(step) });
  assert.equal(reads, 2, 'read twice, then gave up');
  assert.equal(result.say, 'I couldn’t read what’s on screen, so I stopped.');
  assert.deepEqual(steps.at(-1), { phase: 'unseen', detail: 'the app has no window on screen to read' });

  // After a step that did something, the user hears what was done.
  const { host } = fakeHost(MESSAGES);
  let looks = 0;
  host.observe = async () => (looks++ === 0 ? { ok: true, snapshot: MESSAGES } : { ok: false, detail: 'gone' });
  const sent = await runDesktopAgent({ goal: 'text Trisha hello', host, model: scripted({ action: { action: 'type', id: 0, text: 'hello', enter: true } }).model, confirm: async () => true, platform: 'darwin' });
  assert.equal(sent.say, 'I did “Type “hello” in “Message”, then Enter”, but then couldn’t read the screen to check it, so I stopped.');
});
