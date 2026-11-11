import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createVault, SECTIONS } from '../desktop/src/main/vault.js';
import { createVaultMemory, ENDED_SCHEMA, MOST_FACTS, RECALL_CHARS, secretIn, verbatim } from '../desktop/src/main/vault-memory.js';

/** Tuesday, November 10, 2026, 1:30 PM here. */
const NOW = new Date(2026, 10, 10, 13, 30).getTime();
const SECRET = 'I don’t keep passwords or card numbers in your notes: they’re plain text files.';
const NO_VAULT = 'I can’t get to your Obsidian vault. Choose it, or let Jester into it, in Jester’s Settings › Memory.';

/** vault.js's shape (Module A), in memory: `notes` by path, `facts` as [section, fact]. */
function fakeVault({ facts = [], notes = {}, fail = {} } = {}) {
  const calls = { conversations: [], aboutMe: [], remembered: [], added: [] };
  const writable = (rel) => /^(?:Jester|Notes)\//.test(rel);
  const titleOf = (rel) => rel.split('/').pop().replace(/\.md$/, '');
  const findNote = (title) => {
    const rel = Object.keys(notes).find((each) => titleOf(each).toLowerCase() === String(title).toLowerCase());
    return rel ? { rel, writable: writable(rel) } : null;
  };
  return {
    root: '/nowhere/Jester Desktop',
    name: 'Jester Desktop',
    calls,
    notes,
    writable,
    findNote,
    listNotes: () => Object.keys(notes).map((rel) => ({ rel, abs: `/nowhere/Jester Desktop/${rel}`, mtimeMs: 1, size: notes[rel].length })),
    read: (rel) => ({ rel, title: titleOf(rel), data: {}, body: notes[rel] }),
    aboutMe: () => ({ facts: facts.map(([section, fact]) => ({ section, fact })), text: '' }),
    updateAboutMe(changes, at) {
      calls.aboutMe.push({ changes, at });
      return { added: changes.add.length, removed: changes.remove.length };
    },
    addConversation(entry) {
      if (fail.conversation) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      calls.conversations.push(entry);
      return 'Jester/Conversations/2026/2026-11-10.md';
    },
    remember(entry) {
      if (fail.remember) throw new Error('EACCES');
      calls.remembered.push(entry);
      return `Jester/Remembered/2026-11-10 ${entry.title}.md`;
    },
    addToNote({ title, text, at }) {
      calls.added.push({ title, text, at });
      const found = findNote(title);
      if (found && !found.rel.startsWith('Notes/')) throw Object.assign(new Error('That note isn’t Jester’s to change.'), { code: 'read_only' });
      if (found) {
        notes[found.rel] += `\n- ${text}`;
        return { rel: found.rel, created: false };
      }
      const rel = `Notes/${title}.md`;
      notes[rel] = `- ${text}`;
      return { rel, created: true };
    },
    openUrl: (rel) => `obsidian://open?vault=${encodeURIComponent('Jester Desktop')}&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`
  };
}

/** vault-index.js's shape (Module B): what it finds, and what it was asked. */
function fakeIndex(hits = []) {
  const index = {
    queries: [],
    refreshes: 0,
    async search(query, options) {
      index.queries.push({ query, options });
      if (hits instanceof Error) throw hits;
      return hits;
    },
    async refresh() {
      index.refreshes += 1;
    }
  };
  return index;
}

/** The talking job, as conversation.js's summarize calls it. */
function fakeModel(reply) {
  const model = async (request) => {
    model.calls.push(request);
    if (reply instanceof Error) throw reply;
    return { json: reply };
  };
  model.calls = [];
  return model;
}

function memoryWith({ vault = fakeVault(), index = fakeIndex(), request = fakeModel({}), keepConversations, openExternal } = {}) {
  const logged = [];
  const memory = createVaultMemory({
    vault: () => vault,
    index,
    request,
    now: () => NOW,
    log: (...parts) => logged.push(parts.join(' ')),
    ...(keepConversations ? { keepConversations } : {}),
    ...(openExternal ? { openExternal } : {})
  });
  return { memory, vault, index, request, logged };
}

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** vault.js itself, in a temp folder, with these files in it. */
function realVault(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jester-memory-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const vault = createVault({ root, now: () => NOW });
  return { root, vault, read: (rel) => readFileSync(join(root, rel), 'utf8'), rels: () => vault.listNotes().map(({ rel }) => rel) };
}

const at = (hour, minute) => new Date(2026, 10, 10, hour, minute).toISOString();

test('secrets said with what they are: passwords, PINs and codes', () => {
  assert.equal(secretIn('my wifi password is hunter2'), 'a password');
  assert.equal(secretIn('Password: tacos123'), 'a password');
  assert.equal(secretIn('the passcode for my phone is 482913'), 'a password');
  assert.equal(secretIn('my Netflix password, it’s tacos123'), 'a password');
  assert.equal(secretIn('My PIN is 4821'), 'a PIN');
  assert.equal(secretIn('my pin is 4821'), 'a PIN');
  assert.equal(secretIn('Bank PIN: 4821'), 'a PIN');
  assert.equal(secretIn('the verification code is 552910'), 'a security code');
  assert.equal(secretIn('cvv 123'), 'a security code');
  assert.equal(secretIn('my SSN is 123456789'), 'a Social Security number');
  // A word that only looks like one, or a secret named with nothing in it, is no secret.
  for (const text of ['I pinned the Canvas tab', 'Pinned tabs are handy', 'pin this tab to the left', 'Pin the tab that’s open', 'I’m passing CMPSC 465 with an A',
    'I need to change my password tomorrow', 'Uses a password manager', 'Prefers passwordless sign-in', 'my locker combination is 12-34-56',
    'the garage code is on the fridge', 'Spin class at 530', '', null, undefined]) {
    assert.equal(secretIn(text), '', String(text));
  }
});

test('a password given as what it was set to, or as the last word after its name, is a secret; so are "pw" and a PIN’s digits one by one', () => {
  for (const text of ['I changed my Netflix password to tacos', 'I set the bank password to Tacos123', 'The user set their Netflix password to tacos.',
    'The user changed their Wi-Fi password to BlueMoon.', 'set my netflix password to "purple monkey"', 'join the wifi network Lakehouse with password lakehouse',
    'Netflix pw: tacos123', 'netflix pwd tacos123', 'wifi pw sunflower', 'login: krish pass: Blue-Moon', 'pass = hunter2']) {
    assert.equal(secretIn(text), 'a password', text);
  }
  assert.equal(secretIn('pin is 4 8 2 1'), 'a PIN');
  // A bare "pass" is one only labelling a value: a bus or gym pass isn't.
  for (const text of ['got my bus pass today', 'the pass expires in May', 'a hall pass for 3 people']) assert.equal(secretIn(text), '', text);
  // What it's set to that's no password, a word about passwords, or more words after it: none gives one.
  for (const text of ['remember to change my password to something stronger', 'change my password to something', 'reset my password to the default',
    'set the password to expire', 'I updated my password to something new', 'my Canvas password expired', 'I reset my password yesterday',
    'Jester opened the password reset page', 'pin the 3 tabs from 2026', 'remember to change my Netflix password Friday',
    'The user turned on password autofill.']) {
    assert.equal(secretIn(text), '', text);
  }
});

test('card numbers pass Luhn’s check; phone numbers, dates and other long numbers don’t', () => {
  for (const text of ['4111 1111 1111 1111', 'my card is 4111-1111-1111-1111, expires 12/28', '5555555555554444', 'Amex 3782 822463 10005', '6011 1111 1111 1117']) {
    assert.equal(secretIn(text), 'a card number', text);
  }
  for (const text of ['4111 1111 1111 1112', '1234 5678 1234 5678', '814-555-0123', '(814) 555-0123', '+1 814 555 0123', '814 555 0123 814 555 0199',
    '8145550123', '2026-11-10', '11/10/2026', 'from 2026-11-10 to 2026-11-17', 'order 112-4567890-1234567', 'ISBN 9780306406157', '20261110202611']) {
    assert.equal(secretIn(text), '', text);
  }
});

test('Social Security numbers and API keys are secrets; slugs, long words and paths are not', () => {
  assert.equal(secretIn('my social is 123-45-6789'), 'a Social Security number');
  assert.equal(secretIn('123 45 6789'), 'a Social Security number');
  for (const key of ['sk-proj-AbCdEf0123456789XyZ', 'gsk_abcdefghijklmnop0123456789', 'AIzaSyD-abcdefghijklmnopqrstuvwxyz01234', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'my key is 3f786850e387550fdab836ed7e6dc881de23001b', 'dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3Rpbmc=']) {
    assert.equal(secretIn(key), 'an API key', key);
  }
  for (const text of ['how-to-boil-an-egg-perfectly-every-time-2024', 'supercalifragilisticexpialidocious', '/Users/krish/Code/jester-extension-v2/desktop', 'desk-lamp-from-ikea-model-2024-white']) {
    assert.equal(secretIn(text), '', text);
  }
});

test('a password or PIN set off by a comma, a dash, a bracket or a question mark, or given in the next sentence, is a secret', () => {
  // As people say them, and as models write them in a summary.
  for (const text of ['The user shared their wifi password, hunter2, and asked Jester to remember it.', 'the wifi password, hunter2, remember that', 'wifi password, hunter2',
    'Wifi password — hunter2', 'Wifi password – hunter2', 'password - hunter2', 'The user said the Netflix password — tacos123 — is shared with Sam.',
    'Wifi password — hunter2 for the guest network', 'my wifi password? hunter2', 'my Netflix password? it\'s tacos123', 'my Netflix password? It is tacos123',
    'The wifi password. It\'s hunter2.']) {
    assert.equal(secretIn(text), 'a password', text);
  }
  for (const text of ['The user gave their bank PIN, 4821, and asked about rates.', 'my bank pin, 4821', 'My bank PIN — 4821', 'My bank PIN? It’s 4821.', 'pin? it’s 4821']) {
    assert.equal(secretIn(text), 'a PIN', text);
  }
  for (const text of ['the verification code, 552910', 'the verification code ("552910")']) assert.equal(secretIn(text), 'a security code', text);
  // A password needn't have a digit in it: a word on its own after its name, or what's in brackets or quotes.
  for (const text of ['password (tacos)', 'password, tacos', 'the Netflix password, tacos, is shared with Sam', 'password (purple monkey dishwasher)',
    'The user read out the garage door code and their Netflix password (tacos).', 'my wifi password “purple monkey dishwasher”', 'my wifi password "purple monkey dishwasher"']) {
    assert.equal(secretIn(text), 'a password', text);
  }
  // The clause a comma starts, a word that carries the sentence on, a hyphen, a line's end, a question or digits further on: none gives a password.
  for (const text of ['reset their Canvas password, and Jester opened the reset page', 'The user asked how to reset their Canvas password, and Jester opened the reset page.',
    'password, then email Dr. Smith', 'reset my Canvas password, then email Dr. Smith', 'I reset my Canvas password, Sam helped me', 'password (again)',
    'Changed my password (again) after the breach', 'Changed my password after the breach, 3 days ago', 'passkey, finally.', 'I set up a passkey, finally.',
    'password-protected', 'The PDF is password-protected.', 'Turned on passkey-2FA for GitHub', '- change Canvas password\n- 2 eggs', '- change Canvas password\n- milk\n- eggs',
    'Forgot your password? Click here', 'Forgot your password? Click the link to reset it.', 'passwords, PINs, card numbers or keys', 'Jester never keeps passwords, PINs, card numbers or keys.']) {
    assert.equal(secretIn(text), '', text);
  }
  // However long the line, it's quick: what sets a secret off is looked for only straight after its name.
  const started = performance.now();
  for (const text of ['password, '.repeat(5000), `${'card '.repeat(5000)}1 2 3`, '4 '.repeat(20000), `PIN ${'- '.repeat(10000)}`, `${'my password '.repeat(6000)}(${'x '.repeat(5000)}`,
    'password — '.repeat(5000)]) secretIn(text);
  assert.ok(performance.now() - started < 250, `${Math.round(performance.now() - started)} ms`);
});

test('a card’s number after its name is one however it’s grouped; groups not named join on one line, never across lines', () => {
  for (const text of ['my card number is 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', 'my card number is 41 11 11 11 11 11 11 11', 'my debit card is 4111  1111  1111  1111',
    'card 4111 - 1111 - 1111 - 1111', 'card 4111.1111.1111.1111', 'my Mastercard is 5 5 5 5 5 5 5 5 5 5 5 5 4 4 4 4', 'Visa 41 11 11 11 11 11 11 11', 'Amex 37 82 82 24 63 10 005',
    '4111.1111.1111.1111', '4111 . 1111 . 1111 . 1111', '4111 – 1111 – 1111 – 1111', 'Visa 41 11 11 11 11 11 11 11 12 28']) {
    assert.equal(secretIn(text), 'a card number', text);
  }
  for (const text of ['4111\n1111\n1111\n1111', '- 4111\n- 1111\n- 1111\n- 1111',
    '2019 - 2020 - 2021 - 2022', 'Scores: 1200. 1350. 1410. 1500.', 'card 3 of 10', 'my card number ends in 1111', 'my card number is 814-555-0123',
    'call the card company at 1 800 555 0123', 'my library card expires 11.10.2026', 'library card', 'flashcards', 'flashcards 1 2 3 4 5 6 7 8 9 10 11 12 13 14',
    'flashcards 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1']) {
    assert.equal(secretIn(text), '', text);
  }
  // A known miss, not a goal: digits on the lines after a card's name aren't taken for its number. A change that catches them should change these.
  for (const text of ['my card:\n4111\n1111\n1111\n1111', 'card\n41 11 11 11 11 11 11 11']) assert.equal(secretIn(text), '', text);
});

test('the words kept are the ones said: case, quotes and spacing aside, in the transcript’s own characters', () => {
  assert.equal(verbatim('my locker combination is 12-34-56', [{ who: 'you', text: 'My locker combination is 12-34-56, remember that.' }]), 'My locker combination is 12-34-56');
  // Curly where the model wrote straight, and the other way round; its spacing, case and quotes round it don't count.
  const birthday = [{ who: 'you', text: 'Remember that Sam’s birthday is March 3rd!' }];
  assert.equal(verbatim('"sam\'s  BIRTHDAY is march 3rd."', birthday), 'Sam’s birthday is March 3rd');
  assert.equal(verbatim('“Sam’s birthday is March 3rd”', birthday), 'Sam’s birthday is March 3rd');
  assert.equal(verbatim('Sam\'s birthday', [{ who: 'you', text: 'Don’t forget: “Sam’s birthday” is the 3rd' }]), 'Sam’s birthday');
  // A quote the words open, they close.
  assert.equal(verbatim('Dad\'s wifi is “Chavan Home 5G”', [{ who: 'you', text: 'remember that Dad’s wifi is "Chavan Home 5G" okay' }]), 'Dad’s wifi is "Chavan Home 5G"');
  // The model copying the asking too: it isn't kept.
  assert.equal(verbatim('remember that my locker combination is 12-34-56', [{ who: 'you', text: 'Remember that my locker combination is 12-34-56.' }]), 'my locker combination is 12-34-56');
  // His words count too, when they're what's asked for.
  const capital = [{ who: 'you', text: 'what is the capital of Australia' }, { who: 'jester', text: 'It’s Canberra.' }, { who: 'you', text: 'remember that' }];
  assert.equal(verbatim("it's canberra", capital), 'It’s Canberra');
  // Whole words only: "locker combo" was never said.
  assert.equal(verbatim('locker combo', [{ who: 'you', text: 'my locker combination is 12-34-56' }]), '');
});

test('"remember that …", "… remember that" and "don’t forget …": what’s round the asking', () => {
  const kept = (text, model = 'something the model made up') => verbatim(model, [{ who: 'jester', text: 'Hi.' }, { who: 'you', text }]);
  assert.equal(kept('Remember that the dentist moved my cleaning to Friday at 3.'), 'the dentist moved my cleaning to Friday at 3');
  assert.equal(kept('my locker combination is 12-34-56, remember that'), 'my locker combination is 12-34-56');
  assert.equal(kept('Don’t forget I parked on level 3 of the East Deck.'), 'I parked on level 3 of the East Deck');
  assert.equal(kept('Jester, please remember this: the wifi is KrishNet'), 'the wifi is KrishNet');
  assert.equal(kept('Can you remember that my bike lock is 4412?'), 'my bike lock is 4412');
  assert.equal(kept('remember that my sister lands at 6, okay?'), 'my sister lands at 6');
  assert.equal(kept('my mom’s flight is UA 455, I want you to remember that, Jester.'), 'my mom’s flight is UA 455');
  assert.equal(kept('Remember: the spare key is under the blue pot', ''), 'the spare key is under the blue pot');
  // However long the line, it's quick: the asking at its end is looked for only there.
  const started = performance.now();
  for (const text of [`${'- '.repeat(10000)}z`, 'hey jester please '.repeat(1200), `remember that a${', okay'.repeat(3300)} z`, `${'so and ok '.repeat(2000)}remember that`]) kept(text);
  assert.ok(performance.now() - started < 250, `${Math.round(performance.now() - started)} ms`);
});

test('a bare "remember this" keeps the line before it, past his own "Got it."; a paraphrase keeps nothing', () => {
  const locker = [{ who: 'you', text: 'my locker combination is 12-34-56' }, { who: 'jester', text: 'Got it.' }, { who: 'you', text: 'remember that, please' }];
  assert.equal(verbatim('', locker), 'my locker combination is 12-34-56');
  assert.equal(verbatim('this', locker), 'my locker combination is 12-34-56', 'a pronoun from the model is no words to look for');
  const capital = [{ who: 'you', text: 'what is the capital of Australia' }, { who: 'jester', text: 'Canberra.' }, { who: 'you', text: 'Jester, remember that' }];
  assert.equal(verbatim('Capital of Australia: Canberra', capital), 'Canberra.');
  // "This" after his answer is what they're about to say ("remember this", a pause, the spare key): nothing yet.
  const ahead = [...capital.slice(0, 2), { who: 'you', text: 'Jester, remember this' }];
  assert.equal(verbatim('Capital of Australia: Canberra', ahead), '');
  assert.equal(verbatim('Canberra', ahead), '', 'nor his answer when the model copies it');
  assert.equal(verbatim('', [...locker.slice(0, 2), { who: 'you', text: 'remember this' }]), 'my locker combination is 12-34-56', 'their own words are still this');
  // His reply to something they told him isn't "that": what they told him is (measured: the model writing "that",
  // or "your sister", left this to the fallback in 5 of 12 runs, which kept "Good to know: March 3rd.").
  const sister = [{ who: 'you', text: 'my sister’s birthday is March 3rd' }, { who: 'jester', text: 'Good to know: March 3rd.' }, { who: 'you', text: 'remember that' }];
  assert.equal(verbatim('that', sister), 'my sister’s birthday is March 3rd');
  assert.equal(verbatim('your sister’s birthday is March 3rd', sister), 'my sister’s birthday is March 3rd');
  const asked = (text) => verbatim('', [{ who: 'you', text }, { who: 'jester', text: 'Thursday at 3.' }, { who: 'you', text: 'remember that' }]);
  assert.equal(asked('when is my dentist appointment?'), 'Thursday at 3.');
  assert.equal(asked('hey jester when is my dentist appointment'), 'Thursday at 3.', 'a question without its question mark');
  assert.equal(asked('my dentist appointment got moved'), 'my dentist appointment got moved');
  // Not asked to remember, and not said: nothing.
  assert.equal(verbatim('Locker combo 123456', [{ who: 'you', text: 'my locker combination is 12-34-56' }, { who: 'jester', text: 'Nice.' }, { who: 'you', text: 'what time is it' }]), '');
  assert.equal(verbatim('anything', []), '');
  assert.equal(verbatim('', [{ who: 'you', text: 'remember this' }]), '', 'nothing before it');
});

test('after a bare "remember that", a line starting "May", "Will" or "Have" is the user’s to keep; a question without its mark is still one', () => {
  const said = (text, reply) => verbatim('', [{ who: 'you', text }, { who: 'jester', text: reply }, { who: 'you', text: 'remember that' }]);
  assert.equal(said('May is my new lab partner', 'Great, a new lab partner.'), 'May is my new lab partner');
  assert.equal(said('Will lands at JFK at 6:40 on Friday', 'Nice, so Will gets in Friday evening.'), 'Will lands at JFK at 6:40 on Friday');
  assert.equal(said('Have to pick up Sam at five tomorrow', 'Okay, Sam at 5 PM tomorrow.'), 'Have to pick up Sam at five tomorrow');
  assert.equal(said('did my package arrive', 'Yes, at 2 PM.'), 'Yes, at 2 PM.');
  assert.equal(said('can I park on level 3', 'Only on weekends.'), 'Only on weekends.');
  assert.equal(said('is it going to rain tomorrow', 'Light rain after 4 PM.'), 'Light rain after 4 PM.');
  // "is", "are", "does" and "can" first ask whoever follows them.
  assert.equal(said('is Pluto a planet', 'No, a dwarf planet since 2006.'), 'No, a dwarf planet since 2006.');
  assert.equal(said('does Canvas have an app', 'Yes, Canvas Student.'), 'Yes, Canvas Student.');
  assert.equal(said('Can’t make it Friday', 'Okay, not Friday.'), 'Can’t make it Friday');
});

test('"no, just remember that", "keep that in mind" and "memorize this" ask him to remember; "how do I memorize…" doesn’t', () => {
  // His offer turned down, but the asking meant: what the user said before it.
  const offered = [{ who: 'you', text: 'my sister Maya’s birthday is March 3rd' }, { who: 'jester', text: 'Nice! Want me to set a reminder for it?' }];
  for (const no of ['No, just remember that', 'Nope, remember it', 'Actually, just remember that', 'Not now, just remember it', 'No thanks, just remember that']) {
    assert.equal(verbatim('', [...offered, { who: 'you', text: no }]), 'my sister Maya’s birthday is March 3rd', no);
  }
  const bike = [{ who: 'you', text: 'my bike lock is on the rack behind Willard' }, { who: 'jester', text: 'Okay.' }];
  for (const ask of ['keep that in mind', 'keep it in mind', 'Keep this in mind, please']) {
    assert.equal(verbatim('', [...bike, { who: 'you', text: ask }]), 'my bike lock is on the rack behind Willard', ask);
  }
  const alone = (text) => verbatim('', [{ who: 'you', text: 'something said before' }, { who: 'you', text }]);
  assert.equal(alone('keep this in mind: the spare key is under the blue pot'), 'the spare key is under the blue pot');
  assert.equal(alone('memorize this: my locker combination is 12-34-56'), 'my locker combination is 12-34-56');
  assert.equal(alone('Jester, memorize my locker combination, 12-34-56'), 'my locker combination, 12-34-56');
  assert.equal(alone('my locker is 214, memorise that'), 'my locker is 214');
  assert.equal(alone('how do I memorize the periodic table'), '');
  // Quick however long: one way to read "no thanks".
  const started = performance.now();
  for (const text of [`${'no thanks '.repeat(3000)}x`, `${'no, '.repeat(5000)}remember that`, `${'not now '.repeat(3000)}x`]) alone(text);
  assert.ok(performance.now() - started < 250, `${Math.round(performance.now() - started)} ms`);
});

test('"yes, remember that" after his offer keeps what the user said before it, never their "yes" or his offer', () => {
  const offered = (yes, model = '') =>
    verbatim(model, [{ who: 'you', text: 'my locker combination is 12-34-56' }, { who: 'jester', text: 'Got it. Want me to remember that?' }, { who: 'you', text: yes }]);
  for (const yes of ['yes, remember that', 'yeah remember it', 'sure, just remember that', 'okay, remember it', 'yep, just remember it', 'perfect, remember that',
    'Yes please, remember that.', 'great, just remember that, thanks']) {
    assert.equal(offered(yes), 'my locker combination is 12-34-56', yes);
  }
  // The model copying the "yes", a pronoun or his offer: none of it is words of the user's to look for.
  for (const model of ['yes', 'that', 'Got it', 'want me to remember that']) assert.equal(offered('yes, remember that', model), 'my locker combination is 12-34-56', model);
  // Their line before it asked him to remember too: its words, without the asking.
  const askedTwice = [{ who: 'you', text: 'remember that my locker combination is 12-34-56' }, { who: 'jester', text: 'Got it. Want me to remember that?' },
    { who: 'you', text: 'yes, remember that' }];
  assert.equal(verbatim('', askedTwice), 'my locker combination is 12-34-56');
  // Their "yes" before the asking, and the words after it, in one line.
  for (const yes of ['yes, remember that the spare key is under the blue pot', 'yes, just remember that the spare key is under the blue pot',
    'perfect, don’t forget the spare key is under the blue pot']) {
    assert.equal(verbatim('', [{ who: 'jester', text: 'Want me to remember anything else?' }, { who: 'you', text: yes }]), 'the spare key is under the blue pot', yes);
  }

  // His answer is kept without the question or offer he ended on.
  const capital = (answer, model = '') =>
    verbatim(model, [{ who: 'you', text: 'what is the capital of Australia' }, { who: 'jester', text: answer }, { who: 'you', text: 'yeah, just remember it' }]);
  assert.equal(capital('It’s Canberra. Want me to remember that?'), 'It’s Canberra.');
  assert.equal(capital('It’s Canberra. Want me to remember that?', 'It’s Canberra. Want me to remember that?'), 'It’s Canberra.');
  assert.equal(capital('It’s Canberra. Should I keep that in mind?'), 'It’s Canberra.');
  assert.equal(capital('Canberra, since 1913. Want me to remember it?'), 'Canberra, since 1913.');
  // Any question he ends on, however many; and an offer that asks nothing.
  assert.equal(capital('It’s Canberra. Anything else?'), 'It’s Canberra.');
  assert.equal(capital('It’s Canberra. Anything else? Want me to remember it?'), 'It’s Canberra.');
  assert.equal(capital('It’s Canberra. I can remember that for you.'), 'It’s Canberra.');
});

test('recall: About me, then what was found, each in its own words, in brackets', async () => {
  const vault = fakeVault({ facts: [['School and work', 'Takes CMPSC 465 at Penn State'], ['People', 'Roommate is Sam Lee.']] });
  const index = fakeIndex([
    { rel: 'Notes/Grocery list.md', title: 'Grocery list', type: 'note', heading: 'Grocery list', text: '- eggs\n- milk', score: 0.033, why: 'both' },
    { rel: 'Jester/Conversations/2026/2026-11-09.md', title: 'Conversations on Monday, November 9, 2026', type: 'conversations',
      heading: 'Conversations on Monday, November 9, 2026 › 1:05 PM · Opening PSU Canvas',
      text: 'Summary: The user asked Jester to open their PSU Canvas bookmark in Chrome.\nTopics: canvas, school\nPeople: none', score: 0.03, why: 'meaning' },
    { rel: 'Jester/Remembered/2026-11-10 Locker combination.md', title: 'Locker combination', type: 'remembered', heading: 'Locker combination',
      text: '> my locker combination is 12-34-56\n\nSaid to Jester on Tuesday, November 10, 2026 at 1:05 PM.', score: 0.029, why: 'words' },
    { rel: 'Jester/About me.md', title: 'About me', type: 'profile', heading: 'About me › People', text: '- Roommate is Sam Lee <!-- noted 2026-11-01 -->', score: 0.028, why: 'both' },
    { rel: 'Classes/CMPSC 465.md', title: 'CMPSC 465', type: '', heading: 'CMPSC 465 › Exams', text: 'Midterm: Friday, November 13 at 10am in 22 Deike.', score: 0.027, why: 'meaning' },
    { rel: 'Jester/Index.md', title: 'Index', type: 'index', heading: 'Index', text: '[[Grocery list]]', score: 0.02, why: 'words' }
  ]);
  const { memory } = memoryWith({ vault, index });
  const { block, used } = await memory.recall('what do I need from the store before my midterm', { history: [] });
  assert.equal(block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    'About the user: Takes CMPSC 465 at Penn State; Roommate is Sam Lee',
    '- Note “Grocery list” (Notes): - eggs - milk',
    '- Conversation on Monday, November 9 at 1:05 PM: The user asked Jester to open their PSU Canvas bookmark in Chrome.',
    '- Remembered word for word on November 10: “my locker combination is 12-34-56”',
    '- Note “CMPSC 465” (Classes) › Exams: Midterm: Friday, November 13 at 10am in 22 Deike.]'
  ].join('\n'));
  assert.deepEqual(used, [
    { rel: 'Jester/About me.md', heading: 'About me' },
    { rel: 'Notes/Grocery list.md', heading: 'Grocery list' },
    { rel: 'Jester/Conversations/2026/2026-11-09.md', heading: 'Conversations on Monday, November 9, 2026 › 1:05 PM · Opening PSU Canvas' },
    { rel: 'Jester/Remembered/2026-11-10 Locker combination.md', heading: 'Locker combination' },
    { rel: 'Classes/CMPSC 465.md', heading: 'CMPSC 465 › Exams' }
  ]);
  assert.deepEqual(index.queries, [{ query: 'what do I need from the store before my midterm', options: { limit: 6, perNote: 2 } }]);
});

test('recall: kept to its size, and About me whole only while it’s short', async () => {
  const long = (rel) => ({ rel, title: rel.slice(6, -3), type: 'note', heading: rel.slice(6, -3), text: `${'many words here '.repeat(100)}`, score: 0.01, why: 'meaning' });
  const facts = Array.from({ length: 20 }, (_, i) => ['Other', `Has a long-standing fondness for item number ${String(i).padStart(2, '0')}`]);
  const { memory } = memoryWith({ vault: fakeVault({ facts }), index: fakeIndex(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => long(`Notes/${name}.md`))) });
  const { block, used } = await memory.recall('tell me about my things');
  assert.ok(block.length <= RECALL_CHARS, `${block.length} characters`);
  assert.ok(block.startsWith('[') && block.endsWith(']'));
  assert.match(block, /About the user: Has a long-standing fondness for item number 00; .* item number 19\n/);
  assert.match(block, /- Note “A” \(Notes\): many words here .*…/);
  assert.ok(used.length >= 2 && used.length < 7, 'notes stop where the room does');

  // Too much of About me to give whole: only the parts of it that came back.
  const many = Array.from({ length: 40 }, (_, i) => ['Other', `Has a long-standing fondness for item number ${String(i).padStart(2, '0')}`]);
  const profile = { rel: 'Jester/About me.md', title: 'About me', type: 'profile', heading: 'About me › People', text: '- Roommate is Sam Lee <!-- noted 2026-11-01 -->\n- Sister Priya lives in Boston.', score: 0.03, why: 'both' };
  const { memory: crowded } = memoryWith({ vault: fakeVault({ facts: many }), index: fakeIndex([profile]) });
  const recalled = await crowded.recall('where does my sister live');
  assert.equal(recalled.block, '[From your memory and the user’s Obsidian notes, in case it helps:\nAbout the user: Roommate is Sam Lee; Sister Priya lives in Boston]');
  assert.deepEqual(recalled.used, [{ rel: 'Jester/About me.md', heading: 'About me › People' }]);
});

test('recall: a short follow-up is searched with the user’s line before it; anything longer as it was said', async () => {
  const index = fakeIndex([]);
  const { memory } = memoryWith({ index });
  const history = [{ who: 'you', text: 'what’s on my  grocery list' }, { who: 'jester', text: 'Eggs and milk.' }];
  await memory.recall('and for dinner?', { history });
  await memory.recall('and for dinner?', history);
  await memory.recall('what time is my algorithms midterm on Friday', { history });
  // Given with the line being said already in it, the one before that is used.
  await memory.recall('and for dinner?', { history: [...history, { who: 'you', text: 'and for dinner?' }] });
  await memory.recall('and for dinner?');
  // The days it names are vault-index.js's to work out.
  await memory.recall('what did we talk about yesterday', { history });
  assert.deepEqual(index.queries.map(({ query }) => query), [
    'what’s on my grocery list and for dinner?',
    'what’s on my grocery list and for dinner?',
    'what time is my algorithms midterm on Friday',
    'what’s on my grocery list and for dinner?',
    'and for dinner?',
    'what did we talk about yesterday'
  ]);
});

test('recall: a follow-up of any length that points back is searched with the user’s line before it', async () => {
  const index = fakeIndex([]);
  const { memory } = memoryWith({ index });
  const rent = [{ who: 'you', text: 'how much is my rent' }, { who: 'jester', text: '$725 a month.' }];
  await memory.recall('and when do I have to pay it', { history: rent });
  await memory.recall('when do I have to pay that', { history: rent });
  await memory.recall('so what’s left after groceries this month', { history: rent });
  await memory.recall('what room is the midterm in again', { history: [{ who: 'you', text: 'when is my algorithms midterm' }, { who: 'jester', text: 'Friday at 6:30.' }] });
  assert.deepEqual(index.queries.map(({ query }) => query), [
    'how much is my rent and when do I have to pay it',
    'how much is my rent when do I have to pay that',
    'how much is my rent so what’s left after groceries this month',
    'what room is the midterm in again'
  ]);
});

test('recall: no vault, or nothing known or found, is no block; a failed search still gives About me', async () => {
  const index = fakeIndex([{ rel: 'Notes/Grocery list.md', title: 'Grocery list', type: 'note', heading: 'Grocery list', text: '- eggs' }]);
  const none = createVaultMemory({ vault: () => null, index, request: fakeModel({}) });
  assert.deepEqual(await none.recall('what’s on my grocery list'), { block: '', used: [] });
  assert.equal(index.queries.length, 0, 'no vault: nothing searched');

  const { memory: empty } = memoryWith({ index: fakeIndex([]) });
  assert.deepEqual(await empty.recall('tell me a joke'), { block: '', used: [] });

  const { memory: failing, logged } = memoryWith({ vault: fakeVault({ facts: [['People', 'Roommate is Sam Lee']] }), index: fakeIndex(new Error('Ollama isn’t running')) });
  const { block } = await failing.recall('who is my roommate');
  assert.equal(block, '[From your memory and the user’s Obsidian notes, in case it helps:\nAbout the user: Roommate is Sam Lee]');
  assert.ok(logged.some((line) => /couldn’t search the vault: Ollama isn’t running/.test(line)));
});

test('recall: a fact in About me holding a secret is left out, whether About me goes whole or only its parts that were found', async () => {
  const facts = [['People', 'Roommate is Sam Lee'], ['Other', 'Bank PIN is 4821'], ['Other', 'Wifi password is hunter2']];
  const { memory, logged } = memoryWith({ vault: fakeVault({ facts }), index: fakeIndex([]) });
  assert.equal((await memory.recall('what’s my bank pin')).block, '[From your memory and the user’s Obsidian notes, in case it helps:\nAbout the user: Roommate is Sam Lee]');
  // Each kind it holds is said once.
  assert.deepEqual(logged, ['memory: kept from the model, as it holds a PIN: Jester/About me.md', 'memory: kept from the model, as it holds a password: Jester/About me.md']);

  // Too much of About me to give whole: its parts that came back, without the PIN.
  const many = Array.from({ length: 40 }, (_, i) => ['Other', `Has a long-standing fondness for item number ${String(i).padStart(2, '0')}`]);
  const profile = { rel: 'Jester/About me.md', title: 'About me', type: 'profile', heading: 'About me › Other', text: '- Bank PIN is 4821 <!-- noted 2026-11-01 -->\n- Sister Priya lives in Boston.', score: 0.03, why: 'both' };
  const { memory: crowded } = memoryWith({ vault: fakeVault({ facts: [...many, ['Other', 'Bank PIN is 4821']] }), index: fakeIndex([profile]) });
  assert.deepEqual(await crowded.recall('where does my sister live, and what’s my bank pin'), {
    block: '[From your memory and the user’s Obsidian notes, in case it helps:\nAbout the user: Sister Priya lives in Boston]',
    used: [{ rel: 'Jester/About me.md', heading: 'About me › Other' }]
  });
  const { memory: onlyPin } = memoryWith({ vault: fakeVault({ facts: [...many, ['Other', 'Bank PIN is 4821']] }), index: fakeIndex([{ ...profile, text: '- Bank PIN is 4821' }]) });
  assert.deepEqual(await onlyPin.recall('what’s my bank pin'), { block: '', used: [] });
});

test('recall: a secret in a note leaves out the lines holding it, or all the note says; in a conversation or remembered words, all of it; each logged once', async () => {
  const index = fakeIndex([
    { rel: 'Notes/Wifi.md', title: 'Wifi', type: 'note', heading: 'Wifi', text: 'Network: KrishNet\nPassword: hunter2', score: 0.033, why: 'both' },
    // Its line alone isn't a secret, but with the note's name it is.
    { rel: 'Notes/Bank PIN.md', title: 'Bank PIN', type: 'note', heading: 'Bank PIN', text: '4821', score: 0.032, why: 'words' },
    // Named for its secret: nothing of it.
    { rel: 'Notes/PIN 4821.md', title: 'PIN 4821', type: 'note', heading: 'PIN 4821', text: 'for the debit card', score: 0.031, why: 'words' },
    { rel: 'Jester/Conversations/2026/2026-11-09.md', title: 'Conversations on Monday, November 9, 2026', type: 'conversations',
      heading: 'Conversations on Monday, November 9, 2026 › 1:05 PM · Wifi', text: 'Summary: The user shared their wifi password, hunter2.\nTopics: wifi\nPeople: none', score: 0.03, why: 'meaning' },
    { rel: 'Jester/Remembered/2026-11-10 Bank PIN.md', title: 'Bank PIN', type: 'remembered', heading: 'Bank PIN',
      text: '> my bank PIN is 4821\n\nSaid to Jester on Tuesday, November 10, 2026 at 1:05 PM.', score: 0.029, why: 'words' }
  ]);
  const { memory, logged } = memoryWith({ index });
  const { block, used } = await memory.recall('what’s the wifi password, and my bank pin');
  assert.equal(block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    '- Note “Wifi” (Notes) (a password left out): Network: KrishNet',
    '- Note “Bank PIN” (Notes): (left out, as it may hold a PIN)',
    '- Conversation on Monday, November 9 at 1:05 PM: (left out, as it may hold a password)',
    '- Remembered word for word on November 10: (left out, as it may hold a PIN)]'
  ].join('\n'));
  assert.ok(!/hunter2|4821/.test(block));
  assert.deepEqual(used.map(({ rel }) => rel), ['Notes/Wifi.md', 'Notes/Bank PIN.md', 'Jester/Conversations/2026/2026-11-09.md', 'Jester/Remembered/2026-11-10 Bank PIN.md']);

  // Left out each time it's found, but said once.
  assert.equal((await memory.recall('what’s the wifi password, and my bank pin')).block, block);
  assert.deepEqual(logged, [
    'memory: kept from the model, as it holds a password: Notes/Wifi.md',
    'memory: kept from the model, as it holds a PIN: Notes/Bank PIN.md',
    'memory: kept from the model, as it holds a PIN: Notes/PIN 4821.md',
    'memory: kept from the model, as it holds a password: Jester/Conversations/2026/2026-11-09.md',
    'memory: kept from the model, as it holds a PIN: Jester/Remembered/2026-11-10 Bank PIN.md'
  ]);
});

test('recall: in a note of the user’s, a line naming a secret, the line after a name that ends one, and a table with a column for one are left out', async () => {
  const note = (rel, text) => ({ rel, title: rel.split('/').pop().slice(0, -3), type: '', heading: rel.split('/').pop().slice(0, -3), text, score: 0.03, why: 'words' });
  const index = fakeIndex([
    note('Wifi.md', 'Network: KrishNet\npw: hunter2'),
    note('Home/Home wifi.md', 'Network: Lakehouse\nwifi password\n\nsunflower\nRouter is in the hall closet'),
    note('Accounts.md', 'Streaming, shared with Sam:\n\n| Site | Username | Password |\n|---|---|---|\n| Netflix | krish | tacos123 |\n| Spotify | krish | Blue-Moon |\n\nRenew Spotify in March.'),
    note('Bank.md', 'Debit PIN:\n4821\nBranch on College Ave'),
    note('Todo.md', '- milk\n- change the Canvas password, it expired'),
    // A table with no column for a secret goes as it is.
    note('School/Rooms.md', '| Course | Room |\n|---|---|\n| CMPSC 465 | Thomas 100 |')
  ]);
  const { memory, logged } = memoryWith({ index });
  const { block } = await memory.recall('what’s the wifi password');
  assert.equal(block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    '- Note “Wifi” (a password left out): Network: KrishNet',
    '- Note “Home wifi” (Home) (a password left out): Network: Lakehouse Router is in the hall closet',
    '- Note “Accounts” (a password left out): Streaming, shared with Sam: Renew Spotify in March.',
    '- Note “Bank” (a PIN left out): Branch on College Ave',
    '- Note “Todo” (a password left out): - milk',
    '- Note “Rooms” (School): | Course | Room | |---|---| | CMPSC 465 | Thomas 100 |]'
  ].join('\n'));
  assert.ok(!/hunter2|sunflower|tacos123|Blue-Moon|4821/.test(block));
  assert.equal(logged.length, 5);
  // A note that's all secret: nothing of what it says.
  const { memory: all } = memoryWith({ index: fakeIndex([note('Logins.md', '| Site | Pass |\n|---|---|\n| Canvas | Nittany1 |')]) });
  assert.equal((await all.recall('what’s my canvas login')).block, '[From your memory and the user’s Obsidian notes, in case it helps:\n- Note “Logins”: (left out, as it may hold a password)]');
});

test('recall: a piece cut partway down a table goes by the note’s first row, past a blank line the cut left', async () => {
  const rows = ['| Netflix | krish | tacos123 |', '| Spotify | krish | Blue-Moon |', '| Venmo | krish-c | MoneyMoney5 |'];
  const top = '| Site | Username | Password |\n|---|---|---|';
  const rooms = '| Course | Room |\n|---|---|\n| CMPSC 465 | Thomas 100 |\n| STAT 318 | Willard 062 |';
  const vault = fakeVault({ notes: { 'Accounts.md': `${top}\n${rows.join('\n')}`, 'School/Rooms.md': rooms } });
  const piece = (rel, text) => ({ rel, title: rel.split('/').pop().slice(0, -3), type: '', heading: rel.split('/').pop().slice(0, -3), text, score: 0.03, why: 'words' });
  const index = fakeIndex([
    // vault-index.js's later parts of a long table, and its first part with a short last one joined on.
    piece('Accounts.md', rows.slice(1).join('\n')),
    piece('Accounts.md', `${top}\n${rows[0]}\n\n${rows[2]}\n\nShared with Sam.`),
    piece('School/Rooms.md', '| STAT 318 | Willard 062 |')
  ]);
  const { memory } = memoryWith({ vault, index });
  const { block } = await memory.recall('what’s my venmo login');
  assert.equal(block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    '- Note “Accounts”: (left out, as it may hold a password)',
    '- Note “Accounts” (a password left out): Shared with Sam.',
    '- Note “Rooms” (School): | STAT 318 | Willard 062 |]'
  ].join('\n'));
});

test('recall: a piece too long to give whole gives its lines sharing most with what was asked, in their order', async () => {
  const days = [
    'Monday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM in Boucke 304',
    'Tuesday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; Spanish 3 9:05–10:20 AM in Burrowes 118; CMPSC 465 recitation 3:05–3:55 PM in Westgate E201',
    'Wednesday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM in Boucke 304',
    'Thursday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; PHYS 212 lab 2:30–4:25 PM in Davey 214; Spanish 3 conversation hour 5:00–6:00 PM',
    'Friday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 quiz section 10:10–11:00 AM in Willard 062; work at Pattee library 1–5 PM'
  ];
  const schedule = { rel: 'School/Schedule.md', title: 'Fall 2026 schedule', type: '', heading: 'Fall 2026 schedule', text: days.map((day) => `- ${day}`).join('\n'), score: 0.03, why: 'both' };
  const { memory } = memoryWith({ index: fakeIndex([schedule]) });
  const line = async (asked) => (await memory.recall(asked)).block.split('\n')[1].replace(/\]$/, '');
  assert.equal(await line('what is my last class on thursday'), `- Note “Fall 2026 schedule” (School): - ${days[0]} … - ${days[3]}`);
  assert.equal(await line('what time is my physics lab'), `- Note “Fall 2026 schedule” (School): - ${days[0]} … - ${days[3]}`);
  assert.equal(await line('when do I work at the library'), `- Note “Fall 2026 schedule” (School): - ${days[0]} … - ${days[4]}`);
  assert.ok((await line('what’s on Tuesday and Thursday')).includes(`- ${days[1]} … - ${days[3]}`));
  // Nothing in common: its first lines, as far as they go.
  const first = await line('tell me about my week');
  assert.ok(first.startsWith(`- Note “Fall 2026 schedule” (School): - ${days[0]} - ${days[1]}`) && first.endsWith('…') && first.length <= 420, first);
  // Found by a part of it (vault-index.js cuts a long section), the lines come from the whole section.
  const part = { ...schedule, text: `- ${days[1]}`, section: schedule.text };
  const { memory: parted } = memoryWith({ index: fakeIndex([part]) });
  assert.match((await parted.recall('what time is my physics lab')).block, /PHYS 212 lab 2:30–4:25 PM/);
});

test('recall: notes of the same name are told apart by their folders; one at the top has none', async () => {
  const syllabus = (course, midterm) => ({ rel: `School/${course}/Syllabus.md`, title: 'Syllabus', type: '', heading: 'Syllabus › Exams', text: `- Midterm: ${midterm}`, score: 0.03, why: 'both' });
  const index = fakeIndex([
    syllabus('PHYS 212', 'Wednesday, November 18'),
    syllabus('STAT 318', 'Monday, November 16'),
    { rel: 'Syllabus.md', title: 'Syllabus', type: '', heading: 'Syllabus', text: 'Template for a new course.', score: 0.02, why: 'words' }
  ]);
  const { memory } = memoryWith({ index });
  assert.equal((await memory.recall('when is my physics midterm')).block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    '- Note “Syllabus” (School/PHYS 212) › Exams: - Midterm: Wednesday, November 18',
    '- Note “Syllabus” (School/STAT 318) › Exams: - Midterm: Monday, November 16',
    '- Note “Syllabus”: Template for a new course.]'
  ].join('\n'));
});

test('recall: About me and Jester’s own views are told by where they are; a note of the user’s may have any type', async () => {
  const index = fakeIndex([
    { rel: 'People/Sam Lee.md', title: 'Sam Lee', type: 'profile', heading: 'Sam Lee', text: '- Allergic to peanuts\n- Birthday March 3', score: 0.04, why: 'both' },
    { rel: 'Jester/About me.md', title: 'About me', type: '', heading: 'About me › People', text: '- Roommate is Sam Lee', score: 0.035, why: 'both' },
    { rel: 'School/Courses.md', title: 'Courses', type: 'index', heading: 'Courses › CMPSC 465', text: 'Taught by Professor Smith.', score: 0.03, why: 'both' },
    { rel: 'Journal/Quotes.md', title: 'Quotes', type: 'remembered', heading: 'Quotes', text: '> Stay hungry', score: 0.025, why: 'words' },
    { rel: 'Jester/Routines.md', title: 'Routines', type: '', heading: 'Routines', text: '- "study mode" → open Canvas', score: 0.02, why: 'words' },
    { rel: 'Jester/Index.md', title: 'Index', type: '', heading: 'Index', text: '[[Sam Lee]]', score: 0.02, why: 'words' },
    { rel: 'Jester/How Jester uses this vault.md', title: 'How Jester uses this vault', type: '', heading: 'How Jester uses this vault', text: 'Jester reads this vault.', score: 0.02, why: 'words' }
  ]);
  const { memory } = memoryWith({ index });
  const { block, used } = await memory.recall('is Sam allergic to anything');
  assert.equal(block, [
    '[From your memory and the user’s Obsidian notes, in case it helps:',
    'About the user: Roommate is Sam Lee',
    '- Note “Sam Lee” (People): - Allergic to peanuts - Birthday March 3',
    '- Note “Courses” (School) › CMPSC 465: Taught by Professor Smith.',
    '- Note “Quotes” (Journal): > Stay hungry]'
  ].join('\n'));
  assert.deepEqual(used.map(({ rel }) => rel), ['Jester/About me.md', 'People/Sam Lee.md', 'School/Courses.md', 'Journal/Quotes.md']);
});

const CONVERSATION = [
  { who: 'you', text: 'my algorithms midterm is on Friday', at: at(13, 5) },
  { who: 'jester', text: 'Good luck! Want a study plan?', at: at(13, 5) },
  { who: 'you', text: 'yes, and remind me Sam Lee is my study partner now', at: at(13, 6) }
];

test('a conversation that’s over: one model call, a section in the day’s note, checked facts in About me, then the index', async () => {
  const vault = fakeVault({ facts: [['People', 'Roommate is Alex'], ['School and work', 'Takes CMPSC 465 at Penn State']] });
  const request = fakeModel({
    title: 'Planning for the CMPSC 465 midterm next week',
    summary: '  The user said their CMPSC 465 midterm is on Friday, November 13, and asked for a study plan.  ',
    topics: ['School', 'cmpsc 465', 'school', ''],
    people: ['Sam Lee', 'Jester', 'the user'],
    facts: {
      add: [{ section: 'School and work', fact: 'The user takes CMPSC 465 at Penn State.' }, { section: 'Plans and dates', fact: 'CMPSC 465 midterm on Friday, November 13, 2026' }],
      remove: ['People: Roommate is Alex']
    }
  });
  const { memory, index } = memoryWith({ vault, request });
  const result = await memory.ended(CONVERSATION);
  assert.equal(result.summary, 'The user said their CMPSC 465 midterm is on Friday, November 13, and asked for a study plan.');

  assert.equal(request.calls.length, 1);
  const [sent] = request.calls;
  assert.equal(sent.schema, ENDED_SCHEMA);
  assert.deepEqual(sent.schema.properties.facts.properties.add.items.properties.section.enum, [...SECTIONS]);
  assert.equal(sent.maxOutputTokens, 700);
  assert.match(sent.system, /It began on Tuesday, November 10, 2026 at 1:05 PM\./);
  assert.match(sent.system, /"Friday", said on Tuesday, November 10, 2026, is Friday, November 13, 2026\./);
  assert.match(sent.system, /People:\n- Roommate is Alex\nSchool and work:\n- Takes CMPSC 465 at Penn State/);
  assert.match(sent.system, /Who you are, School and work, People, Preferences, Plans and dates, Other/);
  assert.equal(sent.prompt, 'User: my algorithms midterm is on Friday\nJester: Good luck! Want a study plan?\nUser: yes, and remind me Sam Lee is my study partner now');

  assert.deepEqual(vault.calls.conversations, [{
    at: Date.parse(at(13, 5)),
    title: 'Planning for the CMPSC 465 midterm',
    summary: 'The user said their CMPSC 465 midterm is on Friday, November 13, and asked for a study plan.',
    topics: ['school', 'cmpsc 465'],
    people: ['Sam Lee']
  }]);
  // Known already, it isn't added again; the fact the model named for removal is About me's own.
  assert.deepEqual(vault.calls.aboutMe, [{
    changes: { add: [{ section: 'Plans and dates', fact: 'CMPSC 465 midterm on Friday, November 13, 2026' }], remove: ['Roommate is Alex'] },
    at: Date.parse(at(13, 5))
  }]);
  assert.equal(index.refreshes, 1);
});

test('a conversation’s facts are checked: bad sections, too many, secrets, one-off requests, and removals of facts not known', async () => {
  const vault = fakeVault({ facts: [['Other', 'Lives in East Halls']] });
  const request = fakeModel({
    title: 42,
    summary: 'They talked about the user’s card 4111 1111 1111 1111 and weekend plans.',
    topics: 'weekend',
    people: ['Jester', 7],
    facts: {
      add: [
        { section: 'Hobbies', fact: 'Plays chess on weekends' },
        { section: 'preferences', fact: 'Likes oat milk in coffee.' },
        { section: 'Other', fact: 'Wifi password is hunter2' },
        { section: 'Other', fact: 'Main card is 4111 1111 1111 1111' },
        { section: 'Other', fact: 'Asked Jester to open Canvas' },
        { section: 'Other', fact: 'The user asked to open Canvas' },
        { section: 'Other', fact: 42 },
        { section: 'Other', fact: 'x '.repeat(150) },
        ...'ABCDEFGHIJ'.split('').map((letter) => ({ section: 'People', fact: `Knows someone called Pat ${letter}` }))
      ],
      remove: ['Not a fact we know', 'Lives in East Halls', 'Lives in East Halls', 5]
    }
  });
  const { memory, logged } = memoryWith({ vault, request });
  const result = await memory.ended([{ who: 'you', text: 'I play chess on weekends and I like oat milk', at: at(9, 0) }, { who: 'jester', text: 'Nice.', at: at(9, 0) }]);
  assert.equal(result.summary, 'I play chess on weekends. The details are left out, as they held a card number.');
  const [{ title, topics, people }] = vault.calls.conversations;
  assert.deepEqual({ title, topics, people }, { title: 'I play chess on weekends', topics: [], people: [] });
  const [{ changes }] = vault.calls.aboutMe;
  assert.equal(changes.add.length, MOST_FACTS);
  assert.deepEqual(changes.add.slice(0, 3), [
    { section: 'Other', fact: 'Plays chess on weekends' },
    { section: 'Preferences', fact: 'Likes oat milk in coffee' },
    { section: 'People', fact: 'Knows someone called Pat A' }
  ]);
  assert.ok(changes.add.every(({ section }) => SECTIONS.includes(section)));
  assert.ok(!changes.add.some(({ fact }) => /hunter2|4111|Canvas/.test(fact)));
  assert.deepEqual(changes.remove, ['Lives in East Halls']);
  assert.ok(logged.some((line) => /left a fact out, as it held a password/.test(line)));
});

test('a conversation’s summary holding a password is kept as its title alone, and the model is told never to write one', async () => {
  const vault = fakeVault();
  const request = fakeModel({ title: 'Wifi password', summary: 'The user shared their wifi password, hunter2, with Jester.', topics: ['wifi'], people: [], facts: { add: [], remove: [] } });
  const { memory, logged } = memoryWith({ vault, request });
  assert.deepEqual(await memory.ended(CONVERSATION), { summary: 'Wifi password. The details are left out, as they held a password.', title: 'Wifi password' });
  assert.equal(vault.calls.conversations[0].summary, 'Wifi password. The details are left out, as they held a password.');
  assert.ok(logged.includes('memory: left a summary out, as it held a password'));
  assert.match(request.calls[0].system, /\n"summary": [^\n]*\bnever a password, PIN, code, card number or key\./);

  const pin = fakeModel({ title: 'Bank questions', summary: 'The user gave their bank PIN, 4821, and asked about rates.', topics: [], people: [], facts: { add: [], remove: [] } });
  assert.equal((await memoryWith({ request: pin }).memory.ended(CONVERSATION)).summary, 'Bank questions. The details are left out, as they held a PIN.');
  // A summary of a password reset holds no password.
  const reset = fakeModel({ title: 'Canvas password', summary: 'The user asked how to reset their Canvas password, and Jester opened the reset page.', topics: [], people: [], facts: { add: [], remove: [] } });
  assert.equal((await memoryWith({ request: reset }).memory.ended(CONVERSATION)).summary, 'The user asked how to reset their Canvas password, and Jester opened the reset page.');
});

test('a conversation’s facts tell C, C++ and C# apart: each is added, known and removed on its own', async () => {
  const vault = fakeVault({ facts: [['School and work', 'Learning C'], ['School and work', 'Learning C++'], ['Other', 'Knows C']] });
  const request = fakeModel({
    title: 'Moving on to C++',
    summary: 'The user finished learning C and is learning C++ now.',
    topics: ['programming'],
    people: [],
    facts: {
      add: [{ section: 'School and work', fact: 'Learning C++' }, { section: 'Other', fact: 'Knows C++' }, { section: 'Other', fact: 'Knows C#' }, { section: 'Other', fact: 'knows C.' }],
      remove: ['Learning C']
    }
  });
  const { memory } = memoryWith({ vault, request });
  await memory.ended([{ who: 'you', text: 'I finished learning C, it’s C++ now', at: at(15, 0) }, { who: 'jester', text: 'Nice.', at: at(15, 0) }]);
  assert.deepEqual(vault.calls.aboutMe, [{
    changes: { add: [{ section: 'Other', fact: 'Knows C++' }, { section: 'Other', fact: 'Knows C#' }], remove: ['Learning C'] },
    at: Date.parse(at(15, 0))
  }]);
});

test('a conversation that’s over writes nothing with conversations not kept, or no vault, but still gives its summary', async () => {
  const reply = { title: 'Weekend plans', summary: 'The user plans to visit Boston on Saturday.', topics: ['travel'], people: [], facts: { add: [{ section: 'Plans and dates', fact: 'Visiting Boston on Saturday, November 14, 2026' }], remove: [] } };
  const { memory, vault, index } = memoryWith({ request: fakeModel(reply), keepConversations: () => false });
  assert.equal((await memory.ended(CONVERSATION)).summary, 'The user plans to visit Boston on Saturday.');
  assert.deepEqual(vault.calls, { conversations: [], aboutMe: [], remembered: [], added: [] });
  assert.equal(index.refreshes, 0);

  const request = fakeModel(reply);
  const none = createVaultMemory({ vault: () => null, index: fakeIndex(), request });
  assert.equal((await none.ended(CONVERSATION)).summary, 'The user plans to visit Boston on Saturday.');
  assert.match(request.calls[0].system, /What Jester knows about the user already \(never add these again\):\nNothing yet\./);

  // Nothing the user said: nothing to sum up, and no model call.
  const quiet = fakeModel(reply);
  const { memory: unasked } = memoryWith({ request: quiet });
  assert.deepEqual(await unasked.ended([{ who: 'jester', text: 'Hello?' }]), { summary: '' });
  assert.equal(quiet.calls.length, 0);
});

test('a conversation that’s over rejects when the model call fails, or sums up nothing, and writes nothing', async () => {
  const { memory, vault, index } = memoryWith({ request: fakeModel(new Error('Ollama isn’t running')) });
  await assert.rejects(memory.ended(CONVERSATION), /Ollama isn’t running/);
  const { memory: blank } = memoryWith({ vault, index, request: fakeModel({ title: 'Hi', summary: '   ', topics: [], people: [], facts: { add: [], remove: [] } }) });
  await assert.rejects(blank.ended(CONVERSATION), /didn’t sum up/);
  const { memory: nothing } = memoryWith({ vault, index, request: fakeModel(null) });
  await assert.rejects(nothing.ended(CONVERSATION));
  assert.deepEqual(vault.calls, { conversations: [], aboutMe: [], remembered: [], added: [] });
  assert.equal(index.refreshes, 0);

  // The vault refusing a write still gives the summary, for recollections.js.
  const locked = fakeVault({ fail: { conversation: true } });
  const { memory: denied, logged } = memoryWith({ vault: locked, request: fakeModel({ title: 'Hi', summary: 'A greeting.', topics: [], people: [], facts: { add: [], remove: [] } }) });
  assert.equal((await denied.ended(CONVERSATION)).summary, 'A greeting.');
  assert.ok(logged.some((line) => /couldn’t keep the conversation: EPERM/.test(line)));
});

test('remember: the words said, kept word for word, unless they’re a secret or there’s no vault', async () => {
  const { memory, vault, index } = memoryWith();
  const transcript = [{ who: 'you', text: 'My locker combination is 12-34-56, remember that.' }];
  assert.deepEqual(await memory.remember({ text: 'my locker combination is 12-34-56', transcript }), { ok: true, title: 'Locker combination', rel: 'Jester/Remembered/2026-11-10 Locker combination.md' });
  assert.deepEqual(vault.calls.remembered, [{ at: NOW, title: 'Locker combination', text: 'My locker combination is 12-34-56', topics: ['locker', 'combination'] }]);
  assert.equal(index.refreshes, 1);

  // "remember that" after the words, with his "Got it." between.
  const parked = [{ who: 'you', text: 'I parked on level 3 of the East Deck' }, { who: 'jester', text: 'Got it.' }, { who: 'you', text: 'remember that' }];
  assert.equal((await memory.remember({ text: '', transcript: parked })).title, 'I parked on level 3');
  assert.equal(vault.calls.remembered[1].text, 'I parked on level 3 of the East Deck');

  assert.deepEqual(await memory.remember({ text: 'my bank PIN is 4821', transcript: [{ who: 'you', text: 'remember that my bank PIN is 4821' }] }), { ok: false, why: SECRET });
  assert.deepEqual(await memory.remember({ text: 'card 4111 1111 1111 1111', transcript: [{ who: 'you', text: 'what’s the weather' }] }), { ok: false, why: SECRET });
  assert.deepEqual(await memory.remember({ text: 'Locker combo 123456', transcript: [{ who: 'you', text: 'what’s the weather' }] }), { ok: false, why: 'I couldn’t find those exact words to keep.' });
  assert.equal(vault.calls.remembered.length, 2, 'none of those was written');

  const none = createVaultMemory({ vault: () => null, index: fakeIndex(), request: fakeModel({}) });
  assert.deepEqual(await none.remember({ text: 'my locker combination is 12-34-56', transcript }), { ok: false, why: NO_VAULT });

  const { memory: denied } = memoryWith({ vault: fakeVault({ fail: { remember: true } }) });
  assert.deepEqual(await denied.remember({ text: 'my locker combination is 12-34-56', transcript }), { ok: false, why: 'I couldn’t write to your Obsidian vault.' });
});

test('remember: a password said with what it was set to isn’t kept, but a plan to change one is', async () => {
  const { memory, vault } = memoryWith();
  for (const said of ['remember that I changed my Netflix password to tacos', 'remember I set the bank password to Tacos123']) {
    assert.deepEqual(await memory.remember({ text: said.replace(/^remember (?:that )?/, ''), transcript: [{ who: 'you', text: said }] }), { ok: false, why: SECRET }, said);
  }
  assert.equal(vault.calls.remembered.length, 0);
  const plan = await memory.remember({ text: '', transcript: [{ who: 'you', text: 'remember that I need to change my password to something stronger' }] });
  assert.equal(plan.ok, true);
  assert.equal(vault.calls.remembered[0].text, 'I need to change my password to something stronger');
});

test('remember: asked with nothing to keep, he asks what to remember; words he can’t find are still not found', async () => {
  const { memory, vault } = memoryWith();
  for (const transcript of [[{ who: 'you', text: 'remember this' }], [{ who: 'jester', text: 'Sure, what is it?' }, { who: 'you', text: 'Jester, remember this.' }],
    [{ who: 'you', text: 'don’t forget' }]]) {
    assert.deepEqual(await memory.remember({ text: '', transcript }), { ok: false, why: 'Sure. What should I remember?' }, transcript.at(-1).text);
  }
  assert.deepEqual(await memory.remember({ text: 'Locker combo 123456', transcript: [{ who: 'you', text: 'what’s the weather' }] }), { ok: false, why: 'I couldn’t find those exact words to keep.' });
  // Words with the asking are kept, whatever the model copied.
  assert.equal((await memory.remember({ text: 'the user’s locker', transcript: [{ who: 'you', text: 'remember my locker combination is 12-34-56' }] })).ok, true);
  assert.equal(vault.calls.remembered.length, 1);
});

test('remember: "yes, remember that" after his offer keeps the user’s words in the vault, not their "yes"', async () => {
  const { vault, read, rels } = realVault();
  const { memory } = memoryWith({ vault });
  const transcript = [{ who: 'you', text: 'my locker combination is 12-34-56' }, { who: 'jester', text: 'Got it. Want me to remember that?' }, { who: 'you', text: 'yes, remember that' }];
  assert.deepEqual(await memory.remember({ text: 'yes', transcript }), { ok: true, title: 'Locker combination', rel: 'Jester/Remembered/2026-11-10 Locker combination.md' });
  assert.deepEqual(rels(), ['Jester/Remembered/2026-11-10 Locker combination.md']);
  assert.match(read('Jester/Remembered/2026-11-10 Locker combination.md'), /\n# Locker combination\n\n> my locker combination is 12-34-56\n\nSaid to Jester on Tuesday, November 10, 2026 at 1:30 PM\.\n$/);
});

test('notes: added to, made, opened and refused, with what Jester says', async () => {
  const opened = [];
  const vault = fakeVault({ notes: { 'Notes/Grocery list.md': '- eggs', 'Reading/Reading list.md': '- Dune', 'Jester/About me.md': '# About me' } });
  const { memory, index } = memoryWith({ vault, openExternal: async (url) => void opened.push(url) });

  assert.deepEqual(await memory.note({ title: 'grocery list', add: 'milk' }), { ok: true, text: 'Added “milk” to Grocery list.' });
  assert.equal(vault.notes['Notes/Grocery list.md'], '- eggs\n- milk');
  // Much the same name: the list there is, rather than a second one.
  assert.deepEqual(await memory.note({ title: 'my groceries', add: 'bread' }), { ok: true, text: 'Added “bread” to Grocery list.' });
  assert.deepEqual(await memory.note({ title: 'Packing list', add: 'socks' }), { ok: true, text: 'Made a note called Packing list, with “socks” in it.' });
  assert.deepEqual(await memory.note({ title: 'Reading list', add: 'Piranesi' }), { ok: false, text: '“Reading list” isn’t in your Notes folder, so I can’t change it.' });
  assert.deepEqual(await memory.note({ title: 'About me', add: 'likes jazz' }), { ok: false, text: '“About me” isn’t in your Notes folder, so I can’t change it.' });
  assert.equal(index.refreshes, 3);

  assert.deepEqual(await memory.note({ title: 'Grocery list', open: true }), { ok: true, text: 'Opening Grocery list.' });
  assert.deepEqual(await memory.note({ title: 'groceries', open: true }), { ok: true, text: 'Opening Grocery list.' });
  assert.deepEqual(await memory.note({ title: 'Reading list', open: true }), { ok: true, text: 'Opening Reading list.' }, 'any note opens, the user’s own too');
  assert.deepEqual(opened, ['obsidian://open?vault=Jester%20Desktop&file=Notes%2FGrocery%20list', 'obsidian://open?vault=Jester%20Desktop&file=Notes%2FGrocery%20list', 'obsidian://open?vault=Jester%20Desktop&file=Reading%2FReading%20list']);
  assert.deepEqual(await memory.note({ title: 'Recipes', open: true }), { ok: false, text: 'There’s no note called “Recipes”.' });

  const added = vault.calls.added.length;
  assert.deepEqual(await memory.note({ title: 'Wifi', add: 'the password is hunter2' }), { ok: false, text: SECRET });
  assert.deepEqual(await memory.note({ title: 'Bank PIN', add: '4821' }), { ok: false, text: SECRET });
  assert.deepEqual(await memory.note({ title: 'Cards', add: '4111 1111 1111 1111' }), { ok: false, text: SECRET });
  assert.equal(vault.calls.added.length, added, 'no secret reached the vault');

  const none = createVaultMemory({ vault: () => null, index: fakeIndex(), request: fakeModel({}) });
  assert.deepEqual(await none.note({ title: 'Grocery list', add: 'milk' }), { ok: false, text: NO_VAULT });
  const { memory: noObsidian } = memoryWith({ vault, openExternal: async () => { throw new Error('No application knows obsidian://'); } });
  assert.deepEqual(await noObsidian.note({ title: 'Grocery list', open: true }), { ok: false, text: 'I couldn’t open Obsidian.' });
});

test('notes: added to the very note found, though its title is another note’s name', async () => {
  const { vault, read } = realVault({ 'Notes/Groceries.md': '# Shopping list\n\n- eggs\n', 'Notes/Shopping list.md': '# Shopping list\n\n- batteries\n' });
  const { memory } = memoryWith({ vault });
  assert.deepEqual(await memory.note({ title: 'Groceries', add: 'milk' }), { ok: true, text: 'Added “milk” to Groceries.' });
  // Much the same name as Groceries, by its file: that note, not the one its title names.
  assert.deepEqual(await memory.note({ title: 'my groceries', add: 'bread' }), { ok: true, text: 'Added “bread” to Groceries.' });
  assert.equal(read('Notes/Groceries.md'), '# Shopping list\n\n- eggs\n- milk\n- bread\n');
  assert.equal(read('Notes/Shopping list.md'), '# Shopping list\n\n- batteries\n');
});

test('notes: a note in Notes/ that’s a link to a file elsewhere is said to be one, and left as it is', async () => {
  const { root, vault, read } = realVault({ 'Elsewhere/Reading list.md': '- Dune\n' });
  mkdirSync(join(root, 'Notes'), { recursive: true });
  symlinkSync(join(root, 'Elsewhere/Reading list.md'), join(root, 'Notes/Reading list.md'));
  const { memory } = memoryWith({ vault });
  assert.deepEqual(await memory.note({ title: 'Reading list', add: 'Hyperion' }), { ok: false, text: '“Reading list” is a link to a file elsewhere, so I won’t change it.' });
  assert.equal(read('Elsewhere/Reading list.md'), '- Dune\n');
});

test('notes: a lookalike whose names find another note isn’t added to, nor is the other', async () => {
  // "my C# lists" is most like C# list.md; but "C# list" is also "C sharp list" as a file name, and finds the newer note.
  const { root, vault, read } = realVault({ 'Notes/C# list.md': '- events\n', 'Notes/C sharp list.md': '- delegates\n' });
  utimesSync(join(root, 'Notes/C# list.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(root, 'Notes/C sharp list.md'), new Date(2026, 5, 1), new Date(2026, 5, 1));
  const { memory } = memoryWith({ vault });
  assert.deepEqual(await memory.note({ title: 'my C# lists', add: 'LINQ' }), { ok: false, text: 'I couldn’t tell which note “my C# lists” is.' });
  assert.equal(read('Notes/C# list.md'), '- events\n');
  assert.equal(read('Notes/C sharp list.md'), '- delegates\n');
});

test('notes: C++ notes and C# notes aren’t C notes, and C# notes are found again by that name', async () => {
  const { vault, read, rels } = realVault({ 'Notes/C notes.md': '# C notes\n\n- pointers\n' });
  const { memory } = memoryWith({ vault });
  assert.deepEqual(await memory.note({ title: 'C++ notes', add: 'templates' }), { ok: true, text: 'Made a note called C++ notes, with “templates” in it.' });
  // No file can be called "C# notes": vault.js spells its # out.
  assert.deepEqual(await memory.note({ title: 'C# notes', add: 'LINQ' }), { ok: true, text: 'Made a note called C sharp notes, with “LINQ” in it.' });
  assert.deepEqual(await memory.note({ title: 'C# notes', add: 'async' }), { ok: true, text: 'Added “async” to C sharp notes.' });
  assert.deepEqual(await memory.note({ title: 'my C++ note', open: true }), { ok: true, text: 'Opening C++ notes.' });
  assert.deepEqual(rels(), ['Notes/C notes.md', 'Notes/C sharp notes.md', 'Notes/C++ notes.md']);
  assert.equal(read('Notes/C notes.md'), '# C notes\n\n- pointers\n');
  assert.match(read('Notes/C++ notes.md'), /\n# C\+\+ notes\n\n- templates\n$/);
  assert.match(read('Notes/C sharp notes.md'), /\n# C# notes\n\n- LINQ\n- async\n$/);
});
