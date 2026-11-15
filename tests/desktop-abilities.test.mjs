import test from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, abilitiesPart } from '../desktop/src/main/abilities.js';
import { createConversation, personaPrompt } from '../desktop/src/main/conversation.js';

const DATE = new Date('2026-11-13T21:07:00');
const ALL_ON = { notes: true, where: true, calendars: true, chrome: true, pictures: true, voice: true, gestures: true, watch: true };

/** The not-connected part of a prompt, or '' when everything is. */
const notConnected = (text) => /Not connected yet:\n([\s\S]*)/.exec(text)?.[1] ?? '';

test('he always knows he talks, remembers the week, works the laptop and learns, whatever is connected', () => {
  const part = abilitiesPart({});
  assert.match(part, /^What you can do, all of it\. Never claim an ability that isn’t here, and never deny one that is: anything a person can do on a computer, short of typing their secrets, the laptop can, so asked "can you…\?" about one, the answer is yes\./);
  assert.match(part, /Asked what you can do, answer from this confidently, the most useful things first, and offer to say more/);
  assert.match(part, /- Talk about anything, out loud or typed in your window/);
  assert.match(part, /- Remember the past week’s conversations, in brief/);
  // The laptop's, as voice-commands.js and agent/actions.js do it, and what asks first.
  assert.match(part, /- Through "do", the laptop works any app or site the way a person would/);
  assert.match(part, /plays music on Spotify or YouTube/);
  assert.match(part, /starts a new note, email, message, reminder or calendar event in the Mac's own apps; runs their Shortcuts/);
  assert.match(part, /It can send a message, order food or book a flight, but asks the user first before it sends or posts anything, buys, deletes or changes system settings, and it never types a password, card number or other secret: the user enters those themselves\./);
  assert.match(part, /- Learn the user’s own commands \("when I say focus mode/);
  assert.match(abilitiesPart({ computer: 'computer' }), /in the computer's own apps/);
});

test('a connector that’s off is said to be, with where in Settings it’s turned on; on, it’s among what he can do', () => {
  const off = notConnected(abilitiesPart({}));
  for (const where of ['Settings › Memory', 'Settings › Weather and calendars', 'Settings › Chrome', 'Settings › Assistant and voice › Your voice', 'Gestures, in the menu bar', 'Settings › Apple Watch']) {
    assert.ok(off.includes(where), where);
  }
  assert.match(off, /- Their calendars \(Settings › Weather and calendars\), so you don’t know what’s on them: the laptop can open their calendar app and look\./);
  // Pictures have no "off" line: reading a window's words is the laptop's anyway.
  assert.doesNotMatch(off, /picture/);

  const on = abilitiesPart(ALL_ON);
  assert.equal(notConnected(on), '', 'everything connected: no such part');
  assert.match(on, /- Read their calendars, all combined, from a week back to three months ahead\. You can’t change them/);
  assert.match(on, /- Know where the user is and the weather there/);
  assert.match(on, /- Keep the user’s notes in their Obsidian vault/);
  assert.match(on, /- Chrome is linked/);
  assert.match(on, /- The laptop can also look at a picture of a window/);
  assert.match(on, /- Know the user’s voice/);
  assert.match(on, /hand gestures through the camera/);
  assert.match(on, /their paired Apple Watch/);

  // One connector turned on moves from one list to the other, and nothing else changes.
  const calendars = abilitiesPart({ calendars: true });
  assert.match(calendars, /- Read their calendars/);
  assert.doesNotMatch(notConnected(calendars), /calendars \(/);
  assert.match(notConnected(calendars), /Where they are and the weather \(Settings › Weather and calendars\)/);
});

test('a new connector is one more entry: listed when on, and where it’s turned on when off', () => {
  const spotify = { id: 'spotify', on: (state) => !!state.spotify, can: () => 'Control Spotify directly.', off: 'Spotify (Settings › Spotify).' };
  assert.match(abilitiesPart({ spotify: true }, [...ABILITIES, spotify]), /- Control Spotify directly\.\nNot connected yet:/);
  assert.match(abilitiesPart({}, [...ABILITIES, spotify]), /Not connected yet:[\s\S]*- Spotify \(Settings › Spotify\)\.$/);
  assert.equal(new Set(ABILITIES.map((ability) => ability.id)).size, ABILITIES.length, 'every id is its own');
});

test('the prompt never assumes, closes with what he can do, and changes only when what’s connected does', () => {
  const prompt = personaPrompt(DATE, [], { notes: true, live: {}, can: {} });
  assert.match(prompt, /Never assume, and never make anything up\. Say as fact only what the user has told you, what the brackets hold, and general knowledge you're sure of\./);
  // 2026-11-13: a class from the 11-11 and 11-12 conversations became "a class starting in about an hour".
  assert.match(prompt, /was true when it was said: never make it something happening now, and never work out a time, a date or a plan from it\./);
  assert.match(prompt, /Only their calendars say what's on, and only when they're connected\./);
  assert.match(prompt, /never fill a gap with a guess\. Never say something's been done when it hasn't\./);
  // What he can do is after the rules, and the earlier conversations after it.
  const withEarlier = personaPrompt(DATE, [{ at: DATE.getTime() - 3600000, summary: 'Talked about a CMPSC 465 lecture.' }], { notes: true });
  assert.ok(withEarlier.indexOf('Never assume') < withEarlier.indexOf('What you can do, all of it') && withEarlier.indexOf('What you can do, all of it') < withEarlier.indexOf('Earlier conversations'));
  // The vault and the situation say what they say in the prompt and in the list alike.
  assert.match(personaPrompt(DATE, [], { notes: true, live: { calendars: true } }), /- Read their calendars/);
  assert.match(notConnected(personaPrompt(DATE, [], { notes: false })), /Obsidian notes/);
  // Ollama's ready copy: the same turn to turn, minute to minute, until a connector changes.
  assert.equal(personaPrompt(new Date('2026-11-13T21:08:00'), [], { notes: true, live: {}, can: {} }), prompt);
  assert.notEqual(personaPrompt(DATE, [], { notes: true, live: {}, can: { chrome: true } }), prompt);
});

/** A conversation whose model is recorded, with `abilities` as given. */
function talking(abilities, log = () => undefined) {
  const seen = [];
  const conversation = createConversation({
    chat: async (request) => (seen.push(request), { say: 'Hi.', do: '', new: false }),
    speaker: { async say() {}, stop() {} },
    memory: { add() {}, current: () => [], idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: () => undefined,
    ...(abilities ? { abilities } : {}),
    log
  });
  return { conversation, seen };
}

test('each turn is told what’s connected right then, so a connector turned on is in his next answer', async () => {
  let state = { chrome: false, voice: true };
  const { conversation, seen } = talking(async () => state);
  await conversation.told('what can you do?');
  state = { chrome: true, voice: true };
  await conversation.told('and now?');
  assert.deepEqual(seen.map((request) => request.can), [{ chrome: false, voice: true }, { chrome: true, voice: true }]);
  // Without it, as before: nothing more connected.
  const plain = talking(null);
  await plain.conversation.told('hello');
  assert.deepEqual(plain.seen[0].can, {});
});

test('what’s connected, broken or slow, is taken as last time’s, and the turn is answered all the same', async () => {
  const logged = [];
  let calls = 0;
  const { conversation, seen } = talking(async () => {
    calls += 1;
    if (calls === 1) return { chrome: true };
    if (calls === 2) throw new Error('boom');
    return new Promise(() => undefined);
  }, (...parts) => logged.push(parts.join(' ')));
  await conversation.told('one');
  await conversation.told('two');
  const started = Date.now();
  await conversation.told('three');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(seen.map((request) => request.can), [{ chrome: true }, { chrome: true }, { chrome: true }]);
  assert.match(logged.join('\n'), /couldn’t tell what’s connected: boom/);
  assert.match(logged.join('\n'), /telling what’s connected took too long: going by last time/);
});
