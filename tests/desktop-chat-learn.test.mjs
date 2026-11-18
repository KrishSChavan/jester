import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chatSaid, createChatLearner, learnedOf, LEARN_PROMPT, LEARN_SCHEMA, MOST_PER_CHAT, PICK_MOST, PICK_SCHEMA } from '../desktop/src/main/chat-learn.js';
import { createVault, parseFrontmatter } from '../desktop/src/main/vault.js';

process.env.TZ = 'America/New_York';
const NOW = Date.parse('2026-11-17T20:00:00-05:00');

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** An imported chat's note, as chat-import.js writes it. */
function chatNote({ source = 'Claude', id, title, created, said }) {
  const lines = said.flatMap(([who, words], i) => ['', `## ${who === 'you' ? 'You' : source} · 10:0${i} AM`, '', words]);
  return `---\ntype: chat\nsource: ${source}\ncreated: ${created}\nupdated: ${created}\nchat_id: ${id}\ntags:\n  - chat/${source.toLowerCase()}\n---\n# ${title}\n\nA chat with ${source}, started then, imported from ${source}’s export. [Open it on claude.ai](https://claude.ai/chat/${id})\n${lines.join('\n')}\n`;
}

const CHATS = {
  'Claude/2026/2026-03-17 Co-op advice.md': chatNote({
    id: 'c1',
    title: 'Co-op advice',
    created: '2026-03-17T10:00:00-04:00',
    said: [
      ['you', 'I’m finishing my AWS Cloud co-op at IBM and I study data science at Penn State. My sister Priya thinks I should stay. Should I apply internally?'],
      ['them', 'Applying internally is usually the stronger route. Here is how to pitch it, at length…']
    ]
  }),
  'ChatGPT/2025/2025-09-25 Essay help.md': chatNote({
    source: 'ChatGPT',
    id: 'g1',
    title: 'Essay help',
    created: '2025-09-25T10:00:00-04:00',
    said: [
      ['you', 'Write an essay from the point of view of a nurse in Chicago.'],
      ['them', 'As a nurse in Chicago, I have seen…']
    ]
  }),
  'ChatGPT/2024/2024-05-02 Old plans.md': chatNote({
    source: 'ChatGPT',
    id: 'g2',
    title: 'Old plans',
    created: '2024-05-02T10:00:00-04:00',
    said: [
      ['you', 'I play guitar and I’m a senior in high school. What should I practice?'],
      ['them', 'Scales.']
    ]
  })
};

function tempVault(files = CHATS) {
  const root = mkdtempSync(join(tmpdir(), 'jester-chat-learn-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const vault = createVault({ root, now: () => NOW });
  vault.ensureLayout();
  return { root, vault, props: (rel) => parseFrontmatter(readFileSync(join(root, rel), 'utf8')).data };
}

/** The talking job: answers a chat by its title, and picks the numbers it's told to. */
function fakeModel({ chats = {}, keep = () => [], fail = () => null } = {}) {
  const model = async (request) => {
    model.calls.push(request);
    const failure = fail(request);
    if (failure) throw failure;
    if (request.schema === PICK_SCHEMA) return { json: { keep: keep(request) } };
    const title = /called “([^”]+)”/.exec(request.prompt)?.[1];
    return { json: chats[title] || { summary: `The user talked about ${title}.`, topics: [], people: [], facts: [] } };
  };
  model.calls = [];
  return model;
}

const ANSWERS = {
  'Co-op advice': {
    summary: 'The user asked whether to apply internally at IBM after their co-op and got a pitch.',
    topics: ['Co-op', 'IBM'],
    people: ['Priya', 'Ginni Rometty'],
    facts: [
      { section: 'School and work', fact: 'Was finishing an AWS Cloud co-op at IBM in March 2026' },
      { section: 'School and work', fact: 'Studies data science at Penn State' },
      { section: 'People', fact: 'Sister is named Priya' },
      // Nothing they wrote: the model's own.
      { section: 'Other', fact: 'Enjoys kayaking' }
    ]
  },
  // Asking for an essay as a nurse doesn't make them one: here the model slips, and its fact shares "nurse" with their words.
  'Essay help': { summary: 'The user asked for an essay written as a nurse.', topics: ['essay'], people: [], facts: [] },
  'Old plans': {
    summary: 'The user asked what to practice on guitar.',
    topics: ['guitar'],
    people: [],
    facts: [
      { section: 'Preferences', fact: 'Plays guitar' },
      { section: 'School and work', fact: 'Was a high-school senior in May 2024' }
    ]
  }
};

test('a chat as the model reads it: their words, how replies began, nothing pasted, made or secret', () => {
  const body = [
    '# Title',
    '',
    'A chat with Claude, started then.',
    '',
    '## You · 10:00 AM',
    '',
    'Here’s my \\#resume, fix it',
    '',
    '> [!quote]- Pasted: resume.txt',
    '> Jane Doe, nurse',
    '',
    '_Attached: resume.pdf_',
    '(Jester left out a line here: it looked like it held a password.)',
    '',
    '## Claude · 10:01 AM',
    '',
    '#### Your resume',
    `${'A long reply. '.repeat(40)}`,
    '',
    '```js',
    '## You · not a heading, code',
    '```',
    '',
    '_Claude used: searched “resume tips”_'
  ].join('\n');
  const { text, yours } = chatSaid(body);
  assert.equal(yours, 'Here’s my #resume, fix it');
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'User: Here’s my #resume, fix it');
  assert.match(lines[1], /^Claude: Your resume A long reply\. .*…$/);
  assert.ok(lines[1].length < 260, 'only how the reply began');
  assert.doesNotMatch(text, /Jane Doe|resume\.pdf|left out|resume tips|not a heading/);
  // A long chat is its start and its end.
  const many = Array.from({ length: 80 }, (_, i) => `## You · 1:00 PM\n\nMessage number ${i} ${'with some words '.repeat(12)}`).join('\n\n');
  const long = chatSaid(`# T\n\n${many}`).text;
  assert.ok(long.length <= 6100, `${long.length} characters`);
  assert.match(long, /^User: Message number 0 /);
  assert.match(long, /\n\(\d+ messages left out here\.\)\n/);
  assert.match(long, /User: Message number 79 [^\n]*$/);
});

test('what a chat showed is kept only if they wrote it: a fact by a word of theirs, a person by name', () => {
  const yours = 'I’m finishing my AWS Cloud co-op at IBM. My sister Priya thinks I should stay.';
  const kept = learnedOf(ANSWERS['Co-op advice'], { title: 'Co-op advice', yours });
  // Penn State isn't in what they wrote here, nor kayaking anywhere.
  assert.deepEqual(kept.about.map((item) => item.fact), ['Was finishing an AWS Cloud co-op at IBM in March 2026', 'Sister is named Priya']);
  assert.deepEqual(kept.people, ['Priya']);
  assert.deepEqual(kept.topics, ['co-op', 'ibm']);
  // A secret in a fact, and more than a chat's share, are left out.
  const greedy = learnedOf({ summary: 'The user listed things.', topics: [], people: [], facts: [{ section: 'Other', fact: 'Their password is hunter2 for school' }, ...Array.from({ length: 9 }, (_, i) => ({ section: 'Other', fact: `Likes school subject number ${i}` }))] }, { title: 'T', yours: 'school password subject' });
  assert.equal(greedy.about.length, MOST_PER_CHAT);
  assert.ok(greedy.about.every((item) => !/hunter2/.test(item.fact)));
  assert.throws(() => learnedOf({ summary: '', topics: [], people: [], facts: [] }, { title: 'T', yours: 'x' }), /sum up/);
});

test('learning: each chat read once, what it was about kept in its note, and the picked facts put in About me by their dates', async () => {
  const { vault, root, props } = tempVault();
  vault.updateAboutMe({ add: [{ section: 'Preferences', fact: 'Plays guitar' }] });
  const request = fakeModel({
    chats: ANSWERS,
    // The list is oldest first: the senior year (1), the co-op (2), the sister (3). The model keeps 2 and 3, and a number that isn't there.
    keep: () => [3, 2, 2, 9]
  });
  const moved = [];
  const file = join(root, '.learning.json');
  const learner = createChatLearner({ vault: () => vault, request, file, now: () => NOW, onChange: () => moved.push(learner.status().done) });
  assert.equal(learner.counted(), null);
  assert.deepEqual(learner.count(), { chats: 3, learned: 0, sources: { ChatGPT: 2, Claude: 1 }, topics: [], from: 2024, to: 2026 });
  await learner.start();
  assert.deepEqual({ ...learner.status(), finished: 0 }, { running: false, phase: '', total: 3, done: 3, failed: 0, added: 2, error: '', finished: 0 });
  assert.ok(moved.includes(3));

  const coop = props('Claude/2026/2026-03-17 Co-op advice.md');
  assert.equal(coop.summary, 'The user asked whether to apply internally at IBM after their co-op and got a pitch.');
  assert.deepEqual(coop.topics, ['co-op', 'ibm']);
  assert.deepEqual(coop.people, ['Priya']);
  assert.deepEqual(coop.about_you, ['School and work: Was finishing an AWS Cloud co-op at IBM in March 2026', 'School and work: Studies data science at Penn State', 'People: Sister is named Priya']);
  assert.equal(coop.chat_id, 'c1');
  assert.equal(coop.updated, '2026-03-17T10:00:00-04:00', 'when the chat last changed is left as it was: importing again goes by it');
  assert.match(readFileSync(join(root, 'Claude/2026/2026-03-17 Co-op advice.md'), 'utf8'), /\n## You · 10:00 AM\n\nI’m finishing my AWS Cloud co-op/);
  assert.equal(props('ChatGPT/2025/2025-09-25 Essay help.md').about_you, undefined);

  // The model read each chat by the same prompt, with its day and its words after it.
  const read = request.calls.filter((call) => call.schema === LEARN_SCHEMA);
  assert.equal(read.length, 3);
  assert.ok(read.every((call) => call.system === LEARN_PROMPT));
  assert.ok(read.some((call) => call.prompt.startsWith('Chat with Claude on March 17, 2026, called “Co-op advice”.\n\nUser: I’m finishing my AWS Cloud co-op')));

  // One pick, of what About me doesn't have (the guitar is there already), oldest first, with what's known.
  const picks = request.calls.filter((call) => call.schema === PICK_SCHEMA);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].prompt, [
    '1. [May 2024] School and work: Was a high-school senior in May 2024',
    '2. [Mar 2026] School and work: Was finishing an AWS Cloud co-op at IBM in March 2026',
    '3. [Mar 2026] School and work: Studies data science at Penn State',
    '4. [Mar 2026] People: Sister is named Priya'
  ].join('\n'));
  assert.match(picks[0].system, /Today is November 17, 2026\./);
  assert.match(picks[0].system, new RegExp(`Keep at most ${PICK_MOST}\\.`));
  assert.match(picks[0].system, /What Jester knows about the user already:\n- Plays guitar$/);
  const about = readFileSync(join(root, 'Jester/About me.md'), 'utf8');
  assert.match(about, /- Was finishing an AWS Cloud co-op at IBM in March 2026 <!-- noted 2026-03-17 -->/);
  assert.match(about, /- Studies data science at Penn State <!-- noted 2026-03-17 -->/);
  assert.doesNotMatch(about, /high-school|Priya|kayak/);

  assert.deepEqual(learner.count(), { chats: 3, learned: 3, sources: { ChatGPT: 2, Claude: 1 }, topics: ['co-op', 'essay', 'guitar', 'ibm'], from: 2024, to: 2026 });

  // Again: nothing left to read, and what was offered once isn't offered again, kept or not, deleted from About me or not.
  vault.updateAboutMe({ remove: ['Studies data science at Penn State'] });
  const calls = request.calls.length;
  await learner.start();
  assert.equal(request.calls.length, calls);
  assert.equal(learner.status().added, 0);
  assert.doesNotMatch(readFileSync(join(root, 'Jester/About me.md'), 'utf8'), /Studies data science/);

  // Started again, he knows the count without reading a chat; another vault's isn't this one's.
  const later = createChatLearner({ vault: () => vault, request, file, now: () => NOW });
  assert.equal(later.counted().chats, 3);
  const other = tempVault({});
  assert.equal(createChatLearner({ vault: () => other.vault, request, file, now: () => NOW }).counted(), null);
});

test('learning: stopped partway it carries on from there; a model that keeps failing ends the run and says why', async () => {
  const { vault, props } = tempVault();
  let learner = null;
  const stopper = fakeModel({ chats: ANSWERS });
  const first = async (request) => {
    const reply = await stopper(request);
    learner.stop();
    return reply;
  };
  learner = createChatLearner({ vault: () => vault, request: first, now: () => NOW, atOnce: 1 });
  await learner.start();
  assert.equal(learner.status().done, 1);
  assert.equal(learner.status().added, 0, 'stopped: About me waits for the rest');
  assert.equal(learner.count().learned, 1);

  // A model that's away: four chats in a row, and the rest aren't tried.
  const many = tempVault(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`ChatGPT/2025/2025-01-0${i + 1} Chat ${i}.md`, chatNote({ source: 'ChatGPT', id: `m${i}`, title: `Chat ${i}`, created: `2025-01-0${i + 1}T10:00:00-05:00`, said: [['you', 'hello there']] })])));
  const failing = fakeModel({ fail: () => Object.assign(new Error('Claude is out of credit'), { code: 'http_error', status: 402 }) });
  const broken = createChatLearner({ vault: () => many.vault, request: failing, now: () => NOW, atOnce: 1 });
  await broken.start();
  assert.equal(broken.status().error, 'Claude is out of credit');
  assert.equal(broken.status().failed, 4);
  assert.equal(failing.calls.length, 4);
  // A key Settings has to put right ends it at once.
  const refused = fakeModel({ fail: () => Object.assign(new Error('The key was refused'), { code: 'http_error', status: 401 }) });
  const locked = createChatLearner({ vault: () => vault, request: refused, now: () => NOW, atOnce: 1 });
  await locked.start();
  assert.equal(refused.calls.length, 1);
  assert.equal(locked.status().error, 'The key was refused');

  const rest = fakeModel({ chats: ANSWERS, keep: () => [1] });
  const again = createChatLearner({ vault: () => vault, request: rest, now: () => NOW });
  await again.start();
  assert.equal(rest.calls.filter((call) => call.schema === LEARN_SCHEMA).length, 2, 'only the two not yet read');
  assert.equal(again.status().added, 1);
  assert.ok(Object.keys(CHATS).every((rel) => typeof props(rel).summary === 'string'));
});

test('what a chat was about goes only in an imported chat’s own note', () => {
  const { vault, root } = tempVault();
  mkdirSync(join(root, 'Notes'), { recursive: true });
  writeFileSync(join(root, 'Notes/Mine.md'), '---\ntype: chat\n---\n# Mine\n');
  writeFileSync(join(root, 'Claude/Prompts.md'), '# My own note here\n');
  for (const rel of ['Notes/Mine.md', 'Claude/Prompts.md', 'Claude/2026/Missing.md', 'Jester/About me.md']) {
    assert.throws(() => vault.learnedChat(rel, { summary: 'x' }), { code: 'not_a_chat' }, rel);
  }
  assert.equal(readFileSync(join(root, 'Claude/Prompts.md'), 'utf8'), '# My own note here\n');
});
