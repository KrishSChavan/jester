/**
 * How the user likes things done (ways.js): their answers to what he's asked at a fork, kept so he asks each once
 * (the user, 2026-11-21: "Remember it"), and the tools that keep and forget them (mcp/tools.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools, outcomeText } from '../desktop/src/main/mcp/tools.js';
import { createWays, wayKey } from '../desktop/src/main/ways.js';

function area(seed = {}) {
  const data = structuredClone(seed);
  return { data, get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}), set: async (values) => void Object.assign(data, structuredClone(values)) };
}

test('a choice is kept by what it’s about, however that’s worded; one about the same thing replaces it', async () => {
  const storage = area();
  let changes = 0;
  let time = 1000;
  const ways = createWays({ storage, onChange: () => (changes += 1), now: () => (time += 1000) });
  assert.deepEqual(ways.lines(), [], 'nothing until it’s read');
  const kept = await ways.set('Hulu profile', 'Krish');
  assert.equal(kept.ok, true);
  assert.deepEqual({ about: kept.way.about, choice: kept.way.choice }, { about: 'Hulu profile', choice: 'Krish' });
  assert.equal('was' in kept, false);
  assert.equal(wayKey('Which Hulu profile?'), wayKey('hulu profile'));
  assert.equal(ways.find('Which Hulu profile should I use?'), 'Krish');
  const changed = await ways.set('the Hulu profile', 'Sandeep Chavan.');
  assert.equal(changed.was, 'Krish');
  assert.equal(ways.list().length, 1);
  await ways.set('Dad', 'the contact Sandeep Chavan');
  assert.deepEqual(ways.lines(), ['Dad: the contact Sandeep Chavan', 'the Hulu profile: Sandeep Chavan'], 'the newest first');
  assert.equal(changes, 3);
  // Kept across a restart.
  const again = createWays({ storage });
  await again.ready();
  assert.deepEqual(again.lines(), ['Dad: the contact Sandeep Chavan', 'the Hulu profile: Sandeep Chavan']);
});

test('nothing empty and nothing secret is kept', async () => {
  const ways = createWays({ storage: area() });
  assert.equal((await ways.set('', 'Krish')).ok, false);
  assert.equal((await ways.set('Hulu profile', '  ')).ok, false);
  const secret = await ways.set('Hulu password', 'my password is hunter2-Xy9!');
  assert.equal(secret.ok, false);
  assert.match(secret.why, /don’t keep/);
  assert.deepEqual(ways.lines(), []);
});

test('one is forgotten by its id, by what it was about, or by a word of it; all of them at once', async () => {
  const ways = createWays({ storage: area() });
  await ways.set('Hulu profile', 'Krish');
  await ways.set('Netflix profile', 'Krish');
  await ways.set('Dad', 'Sandeep Chavan');
  assert.deepEqual((await ways.forget('the Hulu profile')).gone.map((way) => way.about), ['Hulu profile']);
  assert.equal((await ways.forget('Spotify')).ok, false);
  const id = ways.list().find((way) => way.about === 'Dad').id;
  assert.equal((await ways.forget(id)).ok, true);
  assert.deepEqual(ways.lines(), ['Netflix profile: Krish']);
  await ways.clear();
  assert.deepEqual(ways.list(), []);
});

test('the tools keep a choice, forget one, and keep the answer to a question that says what it’s about', async () => {
  const ways = createWays({ storage: area() });
  const asked = [];
  const tools = createTools({ ways, inquire: async (question) => (asked.push(question), 'Krish') });
  assert.match((await tools.call('remember_choice', { about: 'texting', choice: 'Messages' })).text, /Kept: texting: Messages/);
  const answer = await tools.call('ask_user', { question: 'Which Hulu profile should I use?', options: ['Krish', 'Sandeep Chavan'], about: 'Hulu profile' });
  assert.deepEqual(asked, [{ question: 'Which Hulu profile should I use?', options: ['Krish', 'Sandeep Chavan'] }]);
  assert.match(answer.text, /^The user answered: Krish \(Kept as how they like it: Hulu profile: Krish\./);
  // With nothing said of what it's about, the answer is one for now.
  await tools.call('ask_user', { question: 'Which file?', options: ['Lab 4', 'Lab 5'] });
  assert.deepEqual(ways.lines().sort(), ['Hulu profile: Krish', 'texting: Messages']);
  assert.match((await tools.call('forget_choice', { about: 'Hulu profile' })).text, /Forgotten: Hulu profile: Krish/);
  assert.equal((await tools.call('forget_choice', { about: 'Hulu profile' })).ok, false);
  // No answer: said as that, and nothing kept.
  const quiet = createTools({ ways, inquire: async () => null });
  const none = await quiet.call('ask_user', { question: 'Which Dad?', about: 'Dad' });
  assert.equal(none.ok, false);
  assert.match(none.text, /didn’t answer/);
  assert.equal(ways.find('Dad'), '');
});

test('a text to someone is a task for Messages by name, with who a name means when they’ve said, and where it belongs', async () => {
  const ways = createWays({ storage: area() });
  await ways.set('Dad', 'the contact Sandeep Chavan');
  const ran = [];
  const tools = createTools({ ways, run: async (text, more) => (ran.push({ text, more }), { outcome: { ok: true, text: 'Sent.', chose: [{ about: 'Mom', choice: 'Anita Chavan' }] } }) });
  const sent = await tools.call('send_message', { to: 'Dad', text: 'running late' }, { said: 'text dad running late' });
  assert.match(ran[0].text, /^In Messages, start a new message to Dad \(the contact Sandeep Chavan\) and write exactly: “running late”\./);
  assert.equal(ran[0].more.where, 'computer');
  assert.equal(ran[0].more.said, 'text dad running late');
  assert.deepEqual(ran[0].more.ways, ['Dad: the contact Sandeep Chavan']);
  assert.equal(sent.ok, true);
  // What they chose when the task asked them is kept too.
  assert.equal(ways.find('Mom'), 'Anita Chavan');
  await tools.call('use_browser', { task: 'play Modern Family on Hulu' });
  assert.equal(ran[1].more.where, 'browser');
  await tools.call('use_computer', { task: 'play some Gunna', app: 'Spotify' });
  assert.equal(ran[2].text, 'In Spotify: play some Gunna');
  assert.equal((await tools.call('use_computer', {})).ok, false, 'a call with nothing to do is refused, and says why');
  assert.equal((await tools.call('no_such_tool', {})).ok, false);
});

test('what a task came to is words for his model, quoted as a report: never bare for it to read out', () => {
  assert.match(outcomeText({ ok: true, text: 'Playing Modern Family.' }).text, /^It worked\. Its report: “Playing Modern Family\.” Now tell the user how it went, in a sentence of your own\.$/);
  assert.match(outcomeText({ ok: true, text: 'Done.' }).text, /^It worked; it reported nothing more\./);
  const failed = outcomeText({ ok: false, text: 'I couldn’t get past the profile screen.' });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /^It didn’t work\. Its report: “I couldn’t get past the profile screen\.”.*ask them with ask_user\.$/);
  assert.match(outcomeText(null).text, /stopped before it finished/);
  assert.match(outcomeText({ ok: true, text: 'What would you like me to search for?', clarification: { question: 'What would you like me to search for?' } }).text, /needs to know something first/);
  assert.match(outcomeText({ ok: true, text: 'Playing.', chose: [{ about: 'Hulu profile', choice: 'Krish' }] }).text, /Asked “Hulu profile”, the user chose: Krish\./);
});
