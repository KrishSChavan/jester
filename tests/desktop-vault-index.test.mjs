import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkNote, createVaultIndex, TUNING } from '../desktop/src/main/vault-index.js';

/** Tuesday, November 10, 2026, 3 PM, here. */
const NOW = new Date(2026, 10, 10, 15, 0).getTime();
const MINUTE = 60 * 1000;

/**
 * nomic-embed-text, roughly: a dimension per topic, a little for every other word, and a part every
 * text shares, so a text on the question's topic scores well above the floor and an unrelated one
 * well below it.
 */
const TOPICS = {
  grocery: ['grocery', 'store', 'eggs', 'milk', 'shopping'],
  exam: ['midterm', 'exam', 'cmpsc', 'algorithms'],
  roommate: ['roommate', 'dev'],
  locker: ['locker', 'combination', 'combo'],
  conversation: ['talk', 'conversation', 'conversations', 'summary'],
  weather: ['weather', 'rain', 'forecast']
};
const TOPICAL = new Set(Object.values(TOPICS).flat());
function fakeVector(text) {
  const words = String(text).toLowerCase().replace(/^search_(?:query|document): /, '').match(/[a-z0-9]+/g) || [];
  const rest = new Array(32).fill(0);
  for (const word of words.filter((word) => !TOPICAL.has(word))) rest[[...word].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) % 32, 7)] += 0.3;
  return [0.5, ...Object.values(TOPICS).map((list) => words.filter((word) => list.includes(word)).length), ...rest];
}

/** Ollama's /api/embed, as far as the index uses it. */
function fakeOllama() {
  const calls = [];
  const state = { down: false, missing: false, slow: false };
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (state.down) throw new TypeError('fetch failed');
    if (state.slow) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (state.missing) return reply(404, { error: `model '${body.model}' not found` });
    return reply(200, { model: body.model, embeddings: body.input.map(fakeVector) });
  }
  const inputs = (prefix) => calls.flatMap((call) => call.body.input).filter((input) => input.startsWith(prefix));
  return { fetchImpl, calls, state, documents: () => inputs('search_document: '), questions: () => inputs('search_query: ') };
}

/** vault.js's listNotes and read, over notes in memory. */
function fakeVault(root, notes) {
  let clock = 5000;
  const files = new Map(Object.entries(notes).map(([rel, note]) => [rel, { data: {}, ...note, mtimeMs: clock++ }]));
  const calls = { list: 0, read: [] };
  return {
    root,
    calls,
    listNotes() {
      calls.list++;
      return [...files].map(([rel, note]) => ({ rel, abs: `${root}/${rel}`, mtimeMs: note.mtimeMs, size: Buffer.byteLength(note.body) }));
    },
    read(rel) {
      calls.read.push(rel);
      const note = files.get(rel);
      if (!note) throw Object.assign(new Error(`ENOENT: ${rel}`), { code: 'ENOENT' });
      const title = note.data.title || note.body.match(/^# (.+)$/m)?.[1] || path.posix.basename(rel, '.md');
      return { rel, title, data: note.data, body: note.body };
    },
    put(rel, note) {
      files.set(rel, { data: {}, ...note, mtimeMs: clock++ });
    },
    remove(rel) {
      files.delete(rel);
    }
  };
}

const NOTES = {
  'Jester/About me.md': {
    data: { type: 'profile', tags: ['jester/profile'], aliases: ['About me', 'What Jester knows about me'] },
    body: '# About me\n\nWhat Jester has learned about you.\n\n## Who you are\n- Name is Krish\n\n## People\n- Roommate is Dev Patel <!-- noted 2026-11-04 -->\n\n## Preferences\n'
  },
  'Notes/Grocery list.md': { data: { type: 'note', tags: ['note'] }, body: '# Grocery list\n\n- eggs\n- milk\n' },
  'School/CMPSC 465.md': {
    data: { aliases: ['Algorithms'] },
    body: '# CMPSC 465\n\n## Exams\n- Midterm 2: Friday, November 13, 10:10 AM\n\n## Homework\n- Problem set 5 due Wednesday\n'
  },
  'Jester/Remembered/2026-11-06 Locker combination.md': {
    data: { type: 'remembered', created: '2026-11-06T13:05:00-05:00', tags: ['jester/remembered'] },
    body: '# Locker combination\n\n> my locker combination is 12-34-56\n'
  },
  'Jester/Conversations/2026/2026-11-09.md': {
    data: { type: 'conversations', date: '2026-11-09', tags: ['jester/conversation'], topics: ['cmpsc 465'], people: [] },
    body: '# Conversations on Monday, November 9, 2026\n\n## 10:05 AM · Study plan\nSummary: Made a study plan for the midterm.\nTopics: studying\nPeople: none\n'
  },
  'Jester/Conversations/2026/2026-11-08.md': {
    data: { type: 'conversations', date: '2026-11-08', tags: ['jester/conversation'], topics: ['family'], people: ['Mom'] },
    body: '# Conversations on Sunday, November 8, 2026\n\n## 11:05 AM · Call with Mom\nSummary: Called Mom about her knee.\nTopics: family\nPeople: Mom\n'
  },
  // Jester's own view, and the bin: neither is searched.
  'Jester/Index.md': { data: { type: 'index', tags: ['jester/system'] }, body: '# Index\n\n- Grocery list: eggs, milk, store, roommate, midterm, locker combination\n' },
  '.trash/Old grocery list.md': { body: '# Old grocery list\n\n- eggs\n- milk\n- store\n' }
};

/** A folder for the index's file, gone when the test is over. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-vault-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup({ t, notes = NOTES, root = '/vaults/Jester Desktop', file, model, now, fs: fakeFs } = {}) {
  const dir = scratch(t);
  const ollama = fakeOllama();
  const vault = fakeVault(root, notes);
  const clock = { now: NOW };
  const logged = [];
  const index = createVaultIndex({
    vault: () => vault,
    file: file || path.join(dir, 'vault-index.json'),
    fetchImpl: ollama.fetchImpl,
    log: (...parts) => logged.push(parts.join(' ')),
    now: now || (() => clock.now),
    ...(model ? { model } : {}),
    ...(fakeFs ? { fs: fakeFs } : {})
  });
  return { dir, ollama, vault, clock, index, logged, file: file || path.join(dir, 'vault-index.json') };
}

/** node:fs with fs.watch as far as the index uses it: each watcher kept, and told of a change by calling its listener. */
function fakeWatching() {
  const watchers = [];
  const fakeFs = {
    ...fs,
    watch(root, options, listener) {
      const watcher = Object.assign(new EventEmitter(), { root, options, listener, closed: false, close() { this.closed = true; } });
      watchers.push(watcher);
      return watcher;
    }
  };
  return { watchers, fs: fakeFs };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a note is cut at its headings, cleaned, and labelled for embedding', () => {
  const chunks = chunkNote({ rel: 'Jester/About me.md', title: 'About me', ...NOTES['Jester/About me.md'] });
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['About me', 'About me › Who you are', 'About me › People'],
    'one piece a section, however short; an empty one (Preferences) is none'
  );
  const people = chunks[2];
  assert.deepEqual(people, {
    id: 'Jester/About me.md#2',
    rel: 'Jester/About me.md',
    title: 'About me',
    type: 'profile',
    heading: 'About me › People',
    text: '- Roommate is Dev Patel',
    embedText: 'search_document: About me › People\ntype: profile; folder: Jester; tags: jester/profile; aliases: About me, What Jester knows about me\n- Roommate is Dev Patel'
  });

  const messy = chunkNote({
    rel: 'School/PHIL 103.md',
    title: 'PHIL 103',
    data: { tags: '#school, ethics', topics: 'kant, mill', people: ['Jordan'] },
    body: '---\ntitle: stray\n---\nBefore any heading, see [[Syllabus]].\n\n## Essay\nCompare [[Immanuel Kant|Kant]] and [[Mill#Utilitarianism]]. ![[diagram.png]] ![chart](chart.jpg) ![[Reading list]]\n<!-- a note to self -->\n'
  });
  // Its topics and people are said as well as labelled: the model reads a piece's text, not its labels.
  assert.deepEqual(
    messy.map(({ heading, text }) => [heading, text]),
    [
      ['', '- topics: kant, mill\n- people: Jordan\n\nBefore any heading, see Syllabus.'],
      ['Essay', 'Compare Kant and Mill › Utilitarianism.   Reading list']
    ]
  );
  assert.equal(
    messy[0].embedText,
    'search_document: PHIL 103\nfolder: School; tags: school, ethics; topics: kant, mill; people: Jordan\n- topics: kant, mill\n- people: Jordan\n\nBefore any heading, see Syllabus.'
  );
  assert.ok(messy[1].embedText.startsWith('search_document: PHIL 103 › Essay\n'), 'the title goes on top of headings that aren’t it');

  // A day's topics and people are its conversations' together: each section has its own.
  const day = chunkNote({ rel: 'Jester/Conversations/2026/2026-11-08.md', title: 'Conversations on Sunday, November 8, 2026', ...NOTES['Jester/Conversations/2026/2026-11-08.md'] });
  assert.equal(day.length, 1);
  assert.equal(day[0].heading, 'Conversations on Sunday, November 8, 2026 › 11:05 AM · Call with Mom');
  assert.ok(day[0].embedText.startsWith('search_document: Conversations on Sunday, November 8, 2026 › 11:05 AM · Call with Mom\ntype: conversations; folder: Jester/Conversations/2026; tags: jester/conversation\nSummary:'));
});

test('a long section is cut at blank lines into parts of about 120 to 320 characters; a # in code is no heading', () => {
  const paragraph = (i) => `Paragraph ${i}: memoization keeps each subproblem’s answer so it’s worked out once. `.repeat(3).trim();
  const body = `# Lecture 18\n\n## Dynamic programming\n${Array.from({ length: 14 }, (_, i) => paragraph(i)).join('\n\n')}\n\n## Code\n\`\`\`python\n# not a heading\nmemo = {}\n\`\`\`\n`;
  const chunks = chunkNote({ rel: 'School/Lecture 18.md', title: 'Lecture 18', data: {}, body });
  const long = chunks.filter((chunk) => chunk.heading === 'Lecture 18 › Dynamic programming');
  assert.ok(long.length >= 3, `cut in parts (${long.length})`);
  for (const part of long) {
    assert.ok(part.text.length >= 120 && part.text.length <= 360, `a part of ${part.text.length} characters`);
    assert.ok(part.text.startsWith('Paragraph'), 'cut between paragraphs');
  }
  assert.equal(long.map((part) => part.text).join('\n\n'), Array.from({ length: 14 }, (_, i) => paragraph(i)).join('\n\n'), 'nothing lost');
  const code = chunks.at(-1);
  assert.equal(code.heading, 'Lecture 18 › Code');
  assert.match(code.text, /# not a heading/);
  // A paragraph with no breaks at all is still cut.
  const wall = chunkNote({ rel: 'Wall.md', title: 'Wall', data: {}, body: 'word '.repeat(700) });
  assert.ok(wall.length >= 10 && wall.every((chunk) => chunk.text.length <= 360));
});

test('a list longer than what the model is given of a piece is cut at its line ends', () => {
  // 709 characters, one section: the model was given its first 420, which ended partway through Wednesday.
  const lines = [
    '- Monday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM in Boucke 304',
    '- Tuesday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; Spanish 3 9:05–10:20 AM in Burrowes 118; CMPSC 465 recitation 3:05–3:55 PM in Westgate E201',
    '- Wednesday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM in Boucke 304',
    '- Thursday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; PHYS 212 lab 2:30–4:25 PM in Davey 214; Spanish 3 conversation hour 5:00–6:00 PM',
    '- Friday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 quiz section 10:10–11:00 AM in Willard 062; work at Pattee library 1–5 PM'
  ];
  const chunks = chunkNote({ rel: 'School/Schedule.md', title: 'Fall 2026 schedule', data: {}, body: `# Fall 2026 schedule\n${lines.join('\n')}\n` });
  assert.ok(chunks.length >= 3, `in parts (${chunks.length})`);
  for (const chunk of chunks) {
    assert.equal(chunk.heading, 'Fall 2026 schedule');
    assert.ok(chunk.text.length <= 360, `a part of ${chunk.text.length} characters`);
  }
  assert.equal(chunks.map((chunk) => chunk.text).join('\n'), lines.join('\n'), 'cut between lines, and nothing lost');
  assert.ok(chunks.some((chunk) => chunk.text.split('\n').includes(lines[3])), 'Thursday whole, in one piece');
});

test('what’s found comes with its whole section, and a section is found once', async (t) => {
  // Live, 2026-11-10: "what time is my physics lab" found Tuesday’s and Friday’s parts of a week’s schedule; the lab is
  // Thursday’s, in a third. The model is given the section, and the lines in it that share most with the question.
  const lines = [
    '- Monday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM',
    '- Tuesday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; CMPSC 465 recitation 3:35–4:25 PM in Westgate E201',
    '- Wednesday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 lecture 10:10–11:00 AM in Willard 062; ENGL 202C 1:25–2:15 PM',
    '- Thursday: PHYS 212 lecture 8:00–9:15 AM in Osmond 112; PHYS 212 lab 2:30–4:25 PM in Davey 410',
    '- Friday: CMPSC 465 lecture 9:05–9:55 AM in Thomas 100; STAT 318 quiz section 10:10–11:00 AM in Willard 062'
  ];
  const { index, ollama } = setup({ t, notes: { 'School/Fall 2026 schedule.md': { body: `# Fall 2026 schedule\n${lines.join('\n')}\n` }, 'School/STAT 318.md': { body: '# STAT 318\n\nProfessor Lee. Lecture notes are posted after class.\n' } } });
  ollama.state.down = true;
  await index.refresh();
  const found = await index.search('PHYS 212 lecture', { perNote: 3 });
  const schedule = found.filter((hit) => hit.rel === 'School/Fall 2026 schedule.md');
  assert.equal(schedule.length, 1, 'one section, found once however many of its parts match');
  assert.equal(schedule[0].section, lines.join('\n'));
  assert.ok(schedule[0].text.length < schedule[0].section.length, 'the piece itself is a part of it');
  const other = found.find((hit) => hit.rel === 'School/STAT 318.md');
  if (other) assert.equal(other.section, other.text, 'a section that wasn’t cut is the piece');
});

test('a note’s properties are its first lines, so they’re found and given to the model; one of only properties is a piece', async (t) => {
  const jordan = {
    data: { birthday: '2004-04-17', phone: '610-555-0144', 'met in': '[[CMPSC 132]]', tags: ['friend'], aliases: ['JK'], created: '2026-09-01', cssclasses: ['wide'] },
    body: 'Met in CMPSC 132. Plays intramural soccer on Tuesdays.\n'
  };
  assert.deepEqual(
    chunkNote({ rel: 'People/Jordan Kim.md', title: 'Jordan Kim', ...jordan }).map(({ heading, text }) => [heading, text]),
    [['', '- birthday: 2004-04-17\n- phone: 610-555-0144\n- met in: CMPSC 132\n\nMet in CMPSC 132. Plays intramural soccer on Tuesdays.']],
    'on top of what the note says first; its filing and dates are labels, or nothing anyone asks'
  );
  const sam = { data: { relationship: 'cousin', birthday: '2001-09-02' }, body: '' };
  assert.deepEqual(
    chunkNote({ rel: 'People/Sam Okafor.md', title: 'Sam Okafor', ...sam }).map(({ heading, text, embedText }) => [heading, text, embedText]),
    [['', '- relationship: cousin\n- birthday: 2001-09-02', 'search_document: Sam Okafor\nfolder: People\n- relationship: cousin\n- birthday: 2001-09-02']]
  );
  // A note that starts at a section of its own: the properties go above it, not under its heading.
  const hack = { data: { due: '2026-11-21', team: ['Jordan', 'Priya'], done: false, links: { a: 1 }, empty: null }, body: '# HackPSU\n\n## Plan\n- A study-group matcher\n' };
  assert.deepEqual(
    chunkNote({ rel: 'Projects/HackPSU.md', title: 'HackPSU', ...hack }).map(({ heading, text }) => [heading, text]),
    [
      ['', '- due: 2026-11-21\n- team: Jordan, Priya\n- done: false'],
      ['HackPSU › Plan', '- A study-group matcher']
    ]
  );

  const { index } = setup({ t, notes: { ...NOTES, 'People/Jordan Kim.md': jordan, 'People/Sam Okafor.md': sam, 'Projects/HackPSU.md': hack } });
  assert.equal((await index.refresh()).notes, 9);
  const cousin = await index.search('when is my cousin Sam’s birthday');
  assert.equal(cousin[0].rel, 'People/Sam Okafor.md');
  assert.match(cousin[0].text, /2001-09-02/);
  const birthday = await index.search('when is Jordan’s birthday');
  assert.equal(birthday[0].rel, 'People/Jordan Kim.md');
  assert.match(birthday[0].text, /2004-04-17/);
  assert.match((await index.search('when is the HackPSU project due'))[0].text, /^- due: 2026-11-21$/m);
});

test('the whole vault is searched but Jester’s views and hidden folders, with nomic’s prefixes', async (t) => {
  const { index, ollama, vault } = setup({ t });
  const status = await index.refresh();
  assert.deepEqual(status, { notes: 6, chunks: 9, mode: 'meaning', model: 'nomic-embed-text', error: '', updatedAt: NOW });
  assert.ok(!vault.calls.read.includes('.trash/Old grocery list.md'), 'a hidden folder isn’t read');
  for (const { url, body } of ollama.calls) {
    assert.equal(url, 'http://127.0.0.1:11434/api/embed');
    assert.equal(body.model, 'nomic-embed-text');
    assert.equal(body.keep_alive, '10m');
    assert.equal(body.truncate, true);
  }
  assert.equal(ollama.documents().length, 9);
  assert.ok(!ollama.documents().some((input) => /Index|Old grocery/.test(input)), 'neither the Index nor the bin is embedded');

  const store = await index.search('what did I want from the store');
  assert.equal(store[0].rel, 'Notes/Grocery list.md');
  assert.equal(store[0].why, 'meaning', 'none of its words are in the note');
  assert.deepEqual(ollama.questions(), ['search_query: what did I want from the store']);

  const roommate = await index.search('who’s my roommate?');
  assert.deepEqual(
    { rel: roommate[0].rel, heading: roommate[0].heading, text: roommate[0].text, why: roommate[0].why, type: roommate[0].type, title: roommate[0].title },
    { rel: 'Jester/About me.md', heading: 'About me › People', text: '- Roommate is Dev Patel', why: 'both', type: 'profile', title: 'About me' }
  );
  assert.ok(roommate.every((found) => found.score > 0));
  for (const query of ['Index', 'old grocery list store']) {
    assert.ok(!(await index.search(query)).some((found) => /Index|\.trash/.test(found.rel)), query);
  }
  // Something the vault doesn't hold: nothing above the floor, and no words of it.
  assert.deepEqual(await index.search('will it rain this weekend'), []);
});

test('Jester’s views are told by where they are, not by their type: a note of the user’s may say `type: index`', async (t) => {
  const notes = {
    ...NOTES,
    'School/Courses.md': { data: { type: 'index' }, body: '# Courses\n\n- CMPSC 465: midterm 2 on Friday in Thomas 100\n' },
    'Reading/Shelf.md': { data: { type: 'readme' }, body: '# Shelf\n\n- The Pragmatic Programmer\n' },
    'Health/Morning.md': { data: { type: 'routines' }, body: '# Morning\n\n- gym at 7 before class\n' },
    // Jester's own, their types changed by hand.
    'Jester/Routines.md': { data: { tags: ['jester/system'] }, body: '# Routines\n\n- “study music”: play lo-fi beats on Spotify\n' },
    'Jester/How Jester uses this vault.md': { data: { type: 'note' }, body: '# How Jester uses this vault\n\nJester reads every note in this vault.\n' }
  };
  const { index, ollama } = setup({ t, notes });
  assert.equal((await index.refresh()).notes, 6 + 3);
  assert.ok((await index.search('CMPSC 465 midterm')).some((hit) => hit.rel === 'School/Courses.md'));
  assert.equal((await index.search('pragmatic programmer'))[0]?.rel, 'Reading/Shelf.md');
  assert.equal((await index.search('when is the gym'))[0]?.rel, 'Health/Morning.md');
  for (const query of ['study music lo-fi beats spotify', 'Jester reads every note in this vault']) {
    assert.ok(!(await index.search(query)).some((hit) => hit.rel.startsWith('Jester/Routines') || hit.rel.startsWith('Jester/How')), query);
  }
  assert.ok(!ollama.documents().some((input) => /lo-fi|reads every note|Grocery list: eggs/.test(input)), 'none of Jester’s views is embedded');
});

test('a note named, or a day asked about, comes first', async (t) => {
  const { index } = setup({ t });
  await index.refresh();
  const grocery = await index.search('what’s on my grocery list');
  assert.equal(grocery[0].rel, 'Notes/Grocery list.md');
  assert.equal(grocery[0].why, 'both');
  assert.equal((await index.search('when is my algorithms midterm'))[0].rel, 'School/CMPSC 465.md', 'by an alias');
  const yesterday = await index.search('what did we talk about yesterday');
  assert.equal(yesterday[0].rel, 'Jester/Conversations/2026/2026-11-09.md');
  assert.equal(yesterday[0].heading, 'Conversations on Monday, November 9, 2026 › 10:05 AM · Study plan');
  assert.equal((await index.search('what did we talk about on Sunday'))[0].rel, 'Jester/Conversations/2026/2026-11-08.md');
  assert.equal((await index.search('what did I ask you to remember on November 6th'))[0].rel, 'Jester/Remembered/2026-11-06 Locker combination.md');
  // Without the nudges, yesterday is just another conversation.
  const flat = await index.search('what did we talk about yesterday', { tuning: { dayBonus: 0 } });
  assert.notEqual(flat[0]?.rel, 'Jester/Conversations/2026/2026-11-09.md');
});

/** NOTES and today's: a conversation this morning, and something remembered then. */
const TODAY = {
  ...NOTES,
  'Jester/Conversations/2026/2026-11-10.md': {
    data: { type: 'conversations', date: '2026-11-10', tags: ['jester/conversation'], topics: ['bus pass'], people: [] },
    body: '# Conversations on Tuesday, November 10, 2026\n\n## 9:15 AM · Bus pass\nSummary: Asked where to renew the bus pass.\nTopics: transit\nPeople: none\n'
  },
  'Jester/Remembered/2026-11-10 Bike lock.md': {
    data: { type: 'remembered', created: '2026-11-10T09:20:00-05:00', tags: ['jester/remembered'] },
    body: '# Bike lock\n\n> my bike lock code is 4-2-7\n'
  }
};

test('a day only mentioned in chit-chat brings back none of its notes', async (t) => {
  const { index } = setup({ t, notes: TODAY });
  assert.equal((await index.refresh()).mode, 'meaning');
  // The locker combination was remembered on a Friday, November 6.
  for (const question of ['what’s the weather like today', 'tell me a joke tonight', 'how are you doing this morning', 'what time does the sun set today', 'is it going to rain on Friday']) {
    assert.deepEqual(await index.search(question), [], question);
  }
});

test('a question about the day itself puts that day’s conversation first', async (t) => {
  const { index } = setup({ t, notes: TODAY });
  await index.refresh();
  const today = ['Jester/Conversations/2026/2026-11-10.md', 'Jester/Remembered/2026-11-10 Bike lock.md'];
  for (const question of ['what did we talk about today', 'summarize today']) {
    assert.deepEqual((await index.search(question)).slice(0, 2).map((hit) => hit.rel), today, `${question}: the conversation, then what was remembered`);
  }
  assert.deepEqual(
    (await index.search('did anything happen earlier today')).map((hit) => hit.rel),
    today,
    'all of the day’s notes, though no ranking had them, and nothing else'
  );
  // An evening's a day asked about too, and the day before yesterday isn't yesterday.
  assert.deepEqual((await index.search('did anything happen yesterday evening')).map((hit) => hit.rel), ['Jester/Conversations/2026/2026-11-09.md']);
  assert.equal((await index.search('what did we talk about the day before yesterday'))[0].rel, 'Jester/Conversations/2026/2026-11-08.md');
});

test('a day’s conversation is one piece however long, so a question about the day brings back two of them, not one twice', async (t) => {
  const summary =
    'Planned how to study for the CMPSC 465 midterm on Friday: dynamic programming first, then greedy proofs, with the old exams Professor Marsh posted, and a study session with Maya and Jordan on Thursday night at Pattee library, after the PHYS 212 lab ends at 4:25.';
  const rel = 'Jester/Conversations/2026/2026-11-10.md';
  const notes = {
    ...NOTES,
    [rel]: {
      data: { type: 'conversations', date: '2026-11-10', tags: ['jester/conversation'], topics: ['cmpsc 465', 'groceries'], people: ['Maya', 'Jordan'] },
      body: `# Conversations on Tuesday, November 10, 2026\n\n## 10:05 AM · Algorithms midterm prep\nSummary: ${summary}\nTopics: cmpsc 465, midterm, dynamic programming, study group\nPeople: Maya, Jordan, Professor Marsh\n\n## 1:15 PM · Groceries\nSummary: Added eggs and milk to the grocery list.\nTopics: groceries\nPeople: none\n`
    }
  };
  const day = chunkNote({ rel, title: 'Conversations on Tuesday, November 10, 2026', ...notes[rel] });
  assert.deepEqual(day.map((chunk) => chunk.heading.split(' › ')[1]), ['10:05 AM · Algorithms midterm prep', '1:15 PM · Groceries']);
  assert.ok(day[0].text.length > 360 && day[0].text.endsWith('People: Maya, Jordan, Professor Marsh'), 'longer than a piece of a note, and whole');
  // By words, with Ollama off, the day's pieces come in order: a conversation in two would be both.
  const { index, ollama } = setup({ t, notes });
  ollama.state.down = true;
  await index.refresh();
  const found = (await index.search('what did we talk about today')).filter((hit) => hit.rel === rel);
  assert.deepEqual(new Set(found.map((hit) => hit.heading.split(' › ')[1])), new Set(['10:05 AM · Algorithms midterm prep', '1:15 PM · Groceries']));
});

test('a day mentioned in a question about something else only nudges what was found', async (t) => {
  const { index } = setup({ t, notes: TODAY });
  await index.refresh();
  for (const question of ['what did I tell you about my bike lock today', 'what was the bike lock code I gave you this morning']) {
    const found = await index.search(question);
    const flat = await index.search(question, { tuning: { dayBonus: 0 } });
    assert.deepEqual(found.map((hit) => hit.rel), ['Jester/Remembered/2026-11-10 Bike lock.md'], `${question}: not today’s conversation`);
    assert.deepEqual(flat.map((hit) => hit.rel), ['Jester/Remembered/2026-11-10 Bike lock.md']);
    assert.equal(Math.round((found[0].score - flat[0].score) * 1e4) / 1e4, TUNING.dayBonus, `${question}: the day’s nudge, and no more`);
  }
});

test('a question of nothing but a day’s words finds nothing by words', async (t) => {
  const { index, ollama } = setup({ t, notes: { ...NOTES, 'Notes/Morning routine.md': { body: '# Morning routine\n\n- stretch\n- coffee\n' } } });
  ollama.state.down = true;
  await index.refresh();
  // Words alone, and at the looser share: any piece saying "morning" would do.
  assert.deepEqual(await index.search('how are you doing this morning'), []);
  assert.deepEqual(await index.search('how are you doing this morning', { only: 'words' }), []);
  assert.equal((await index.search('what’s my routine this morning'))[0].rel, 'Notes/Morning routine.md', 'a day’s word still counts beside another');
});

test('yesterday’s, last night’s, tomorrow’s, Sunday’s, November 8th’s and the like are those days', async (t) => {
  // A daily note written ahead, for tomorrow.
  const { index } = setup({ t, notes: { ...TODAY, 'Daily/2026-11-11.md': { body: '# Dentist\n\n- dentist at 9 AM\n' } } });
  await index.refresh();
  for (const [question, rel] of [
    ['what was yesterday’s conversation about', 'Jester/Conversations/2026/2026-11-09.md'],
    ['what was last night’s conversation about', 'Jester/Conversations/2026/2026-11-09.md'],
    ['what was the day before yesterday’s conversation about', 'Jester/Conversations/2026/2026-11-08.md'],
    ['what was Sunday’s conversation about', 'Jester/Conversations/2026/2026-11-08.md'],
    ['recap today’s conversations', 'Jester/Conversations/2026/2026-11-10.md'],
    ['what was this morning’s conversation about', 'Jester/Conversations/2026/2026-11-10.md'],
    ['when’s tomorrow’s dentist', 'Daily/2026-11-11.md'],
    ['what was November 8th’s conversation about', 'Jester/Conversations/2026/2026-11-08.md']
  ]) {
    const found = await index.search(question);
    assert.equal(found[0].rel, rel, question);
    const flat = await index.search(question, { tuning: { dayBonus: 0 } });
    assert.equal(Math.round((found[0].score - flat.find((hit) => hit.rel === rel).score) * 1e4) / 1e4, TUNING.dayBonus, `${question}: nudged as that day’s`);
  }
});

test('a plural and its singular find each other, with Ollama off', async (t) => {
  const pairs = [
    ['quizzes', 'quiz'],
    ['sizes', 'size'],
    ['prizes', 'prize'],
    ['caches', 'cache'],
    ['buses', 'bus'],
    ['headaches', 'headache'],
    ['classes', 'class'],
    ['notes', 'note'],
    ['boxes', 'box'],
    ['dishes', 'dish'],
    ['matches', 'match'],
    ['glasses', 'glass'],
    ['groceries', 'grocery'],
    ['campuses', 'campus'],
    ['courses', 'course'],
    ['buzzes', 'buzz'],
    ['axes', 'axe'],
    ['irises', 'iris'],
    ['skies', 'sky'],
    ['flies', 'fly']
  ];
  const notes = {};
  pairs.forEach(([plural, single], i) => {
    notes[`Lists/Plural ${i}.md`] = { body: `- the ${plural}\n` };
    notes[`Lists/Single ${i}.md`] = { body: `- a ${single}\n` };
  });
  const { index, ollama } = setup({ t, notes });
  ollama.state.down = true;
  assert.equal((await index.refresh()).mode, 'words');
  for (const [i, [plural, single]] of pairs.entries()) {
    const both = [`Lists/Plural ${i}.md`, `Lists/Single ${i}.md`];
    assert.deepEqual((await index.search(single)).map((hit) => hit.rel).sort(), both, `${single} finds ${plural}`);
    assert.deepEqual((await index.search(plural)).map((hit) => hit.rel).sort(), both, `${plural} finds ${single}`);
  }
});

test('at most perNote pieces from a note, and limit in all', async (t) => {
  const sections = ['Produce', 'Dairy', 'Bakery', 'Frozen'].map((name) => `## ${name}\n- grocery store eggs milk ${name}`).join('\n\n');
  const { index } = setup({ t, notes:{ ...NOTES, 'Notes/Big shop.md': { data: { type: 'note' }, body: `# Big shop\n\n${sections}\n` } } });
  await index.refresh();
  const found = await index.search('grocery store eggs milk', { limit: 10 });
  assert.ok(found.filter((hit) => hit.rel === 'Notes/Big shop.md').length === 2, 'two at most by default');
  assert.equal((await index.search('grocery store eggs milk', { perNote: 4, limit: 10 })).filter((hit) => hit.rel === 'Notes/Big shop.md').length, 4);
  assert.equal((await index.search('grocery store eggs milk', { limit: 1 })).length, 1);
});

test('only what changed is read and embedded again, and what’s gone goes', async (t) => {
  const { index, ollama, vault } = setup({ t });
  await index.refresh();
  const reads = vault.calls.read.length;
  const embedded = ollama.documents().length;
  await index.refresh();
  assert.equal(vault.calls.read.length, reads, 'nothing changed: nothing read');
  assert.equal(ollama.documents().length, embedded, 'nor embedded');

  // One section of three changes: only it is embedded again.
  const about = NOTES['Jester/About me.md'];
  vault.put('Jester/About me.md', { ...about, body: about.body.replace('- Name is Krish', '- Name is Krish Chavan') });
  await index.refresh();
  assert.deepEqual(vault.calls.read.slice(reads), ['Jester/About me.md']);
  assert.deepEqual(ollama.documents().slice(embedded), ['search_document: About me › Who you are\ntype: profile; folder: Jester; tags: jester/profile; aliases: About me, What Jester knows about me\n- Name is Krish Chavan']);

  vault.remove('Notes/Grocery list.md');
  await index.refresh();
  assert.ok(!(await index.search('what did I want from the store')).some((hit) => hit.rel === 'Notes/Grocery list.md'));
  assert.equal(index.status().notes, 5);
});

test('a note it can’t read is said once, not rebuilt for at every refresh, and read again each time', async (t) => {
  const writes = [];
  const counting = { ...fs, writeFileSync: (file, ...rest) => (writes.push(file), fs.writeFileSync(file, ...rest)) };
  const { index, vault, logged } = setup({ t, fs: counting, notes: { ...NOTES, 'Notes/Private.md': { body: '# Private\n\n- the spare key is under the blue pot\n' } } });
  const read = vault.read;
  let locked = true;
  let tried = 0;
  vault.read = (rel) => {
    if (rel !== 'Notes/Private.md' || !locked) return read(rel);
    tried++;
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  for (let i = 0; i < 3; i++) await index.refresh();
  assert.equal(logged.filter((line) => line.includes('couldn’t read Notes/Private.md')).length, 1);
  assert.equal(writes.length, 1, 'the index saved once, not at each refresh');
  assert.equal(tried, 3, 'tried each time');
  // Readable again, as an iCloud note downloaded is, with its time and size as they were.
  locked = false;
  await index.refresh();
  assert.equal(index.status().notes, 7);
  assert.equal((await index.search('where is the spare key'))[0].rel, 'Notes/Private.md');
});

test('the index is kept in its file and used again; another model or vault starts afresh', async (t) => {
  const first = setup({ t });
  await first.index.refresh();
  const stored = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.model, 'nomic-embed-text');
  assert.equal(stored.root, '/vaults/Jester Desktop');
  const people = stored.notes['Jester/About me.md'].chunks[2];
  assert.equal(people.heading, 'About me › People');
  assert.match(people.hash, /^[0-9a-f]{32}$/);
  const bytes = Buffer.from(people.vector, 'base64');
  const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const expected = fakeVector(people.embedText);
  const length = Math.hypot(...expected);
  assert.deepEqual([...vector].map((x) => x.toFixed(5)), expected.map((x) => (x / length).toFixed(5)), 'a base64 Float32Array, at length 1');
  assert.deepEqual(fs.readdirSync(first.dir), ['vault-index.json'], 'written whole: no .tmp left');

  // The app starts again: found straight away, nothing embedded again.
  const ollama = fakeOllama();
  const again = createVaultIndex({ vault: () => first.vault, file: first.file, fetchImpl: ollama.fetchImpl, now: () => NOW });
  assert.equal((await again.search('what did I want from the store'))[0].rel, 'Notes/Grocery list.md');
  await again.refresh();
  assert.deepEqual(ollama.documents(), []);

  // Another model's vectors are no use; nor is another vault's index.
  const other = fakeOllama();
  await createVaultIndex({ vault: () => first.vault, file: first.file, fetchImpl: other.fetchImpl, model: 'mxbai-embed-large', now: () => NOW }).refresh();
  assert.equal(other.documents().length, 9);
  assert.equal(other.calls[0].body.model, 'mxbai-embed-large');
  const elsewhere = fakeVault('/vaults/Other', { 'Ideas.md': { body: '# Ideas\n\n- a bus tracker\n' } });
  const moved = fakeOllama();
  const switched = createVaultIndex({ vault: () => elsewhere, file: first.file, fetchImpl: moved.fetchImpl, model: 'mxbai-embed-large', now: () => NOW });
  assert.deepEqual(await switched.search('grocery'), [], 'not the old vault’s notes');
  await switched.refresh();
  assert.deepEqual(switched.status().notes, 1);
  assert.deepEqual(moved.documents(), ['search_document: Ideas\n- a bus tracker']);

  // Kept before pieces were cut to fit and properties read: its pieces are no use either.
  fs.writeFileSync(first.file, JSON.stringify({ ...stored, version: 1 }));
  const older = fakeOllama();
  await createVaultIndex({ vault: () => first.vault, file: first.file, fetchImpl: older.fetchImpl, now: () => NOW }).refresh();
  assert.equal(older.documents().length, 9, 'every piece embedded again');
});

test('refreshes asked for together share one run', async (t) => {
  const { index, ollama } = setup({ t });
  const one = index.refresh();
  const two = index.refresh();
  assert.equal(one, two);
  await one;
  assert.equal(ollama.documents().length, 9, 'each piece embedded once');
});

test('with Ollama off it searches by words, says why, and tries again a minute later', async (t) => {
  const { index, ollama, clock } = setup({ t });
  ollama.state.down = true;
  const status = await index.refresh();
  assert.equal(status.mode, 'words');
  assert.equal(status.error, 'Ollama isn’t running');
  assert.equal(status.notes, 6, 'indexed all the same');
  const roommate = await index.search('who’s my roommate?');
  assert.equal(roommate[0].rel, 'Jester/About me.md');
  assert.equal(roommate[0].why, 'words');
  // Half its weight in a word the vault hasn't got: with no meaning to be had, the words that are there will do.
  assert.deepEqual((await index.search('my roommate situation')).map((hit) => [hit.rel, hit.why]), [['Jester/About me.md', 'words']]);
  assert.deepEqual(await index.search('my roommate situation', { only: 'words' }), [], 'at the usual share, not enough');

  // Back on, but it was off a moment ago: nothing's asked of it for a minute.
  ollama.state.down = false;
  const calls = ollama.calls.length;
  await index.refresh();
  await index.search('who’s my roommate?');
  assert.equal(ollama.calls.length, calls);
  assert.equal(index.status().mode, 'words');

  clock.now += MINUTE + 1;
  await index.refresh();
  assert.equal(ollama.documents().length, 9 + 9, 'all nine tried while it was off, then all nine again');
  assert.deepEqual(index.status(), { notes: 6, chunks: 9, mode: 'meaning', model: 'nomic-embed-text', error: '', updatedAt: clock.now });
  assert.equal((await index.search('what did I want from the store'))[0].why, 'meaning');
});

test('a search a minute after Ollama failed catches the vectors up, without waiting for them', async (t) => {
  const { index, ollama, clock } = setup({ t });
  ollama.state.down = true;
  await index.refresh();
  ollama.state.down = false;
  clock.now += MINUTE + 1;
  await index.search('who’s my roommate?');
  await index.refresh(); // the one that search started
  assert.equal(index.status().mode, 'meaning');
  assert.equal((await index.search('what did I want from the store'))[0].why, 'meaning');
});

test('without the model, or slow, it says so in plain words', async (t) => {
  const { index, ollama } = setup({ t });
  ollama.state.missing = true;
  assert.deepEqual((await index.refresh()).error, 'nomic-embed-text isn’t in Ollama');
  assert.equal(index.status().mode, 'words');

  const slow = setup({ t });
  slow.ollama.state.slow = true;
  await slow.index.search('anything');
  await slow.index.refresh();
  assert.equal(slow.index.status().error, 'Ollama didn’t answer in time');
  // A slow answer is worth asking again: the model may have been loading.
  const calls = slow.ollama.calls.length;
  await slow.index.search('who’s my roommate?');
  assert.equal(slow.ollama.calls.length, calls + 1);
});

test('Read again asks Ollama straight away, however lately it failed, even with nothing to embed', async (t) => {
  const gist = ({ mode, error }) => [mode, error];
  const { index, ollama, clock } = setup({ t });
  ollama.state.down = true;
  await index.refresh();
  // Ollama started, and Read again clicked 20 s later: embedded now, not a minute after it failed.
  ollama.state.down = false;
  clock.now += 20 * 1000;
  assert.deepEqual(gist(await index.refresh({ retry: true })), ['meaning', '']);
  assert.equal(ollama.documents().length, 9 + 9);

  // All embedded, then Ollama quits and a question finds it out. Read again with it still off says so, asking once…
  ollama.state.down = true;
  clock.now += 5 * MINUTE;
  await index.search('what did I want from the store');
  assert.deepEqual(gist(index.status()), ['words', 'Ollama isn’t running']);
  const calls = ollama.calls.length;
  assert.deepEqual(gist(await index.refresh({ retry: true })), ['words', 'Ollama isn’t running']);
  assert.equal(ollama.calls.length, calls + 1);
  // …and with it back, it's by meaning again, though no piece needed embedding.
  ollama.state.down = false;
  assert.deepEqual(gist(await index.refresh({ retry: true })), ['meaning', '']);
  assert.equal(ollama.documents().length, 9 + 9);

  // Asked for while a refresh is under way, whose embedding then fails: the look again it asks for tries Ollama anyway.
  const off = fakeOllama();
  off.state.down = true;
  let shared = null;
  const busy = createVaultIndex({
    vault: () => fakeVault('/vaults/Jester Desktop', NOTES),
    file: path.join(scratch(t), 'i.json'),
    fetchImpl: async (url, init) => {
      shared ??= busy.refresh({ retry: true });
      try {
        return await off.fetchImpl(url, init);
      } finally {
        off.state.down = false;
      }
    },
    now: () => NOW
  });
  const first = busy.refresh();
  assert.deepEqual(gist(await first), ['meaning', '']);
  assert.equal(shared, first);
  assert.equal(off.documents().length, 9 + 9);
});

test('with no vault, or one it may not read, it’s off', async (t) => {
  const ollama = fakeOllama();
  const none = createVaultIndex({ vault: () => null, file: path.join(scratch(t), 'i.json'), fetchImpl: ollama.fetchImpl, now: () => NOW });
  assert.deepEqual(await none.refresh(), { notes: 0, chunks: 0, mode: 'off', model: 'nomic-embed-text', error: '', updatedAt: null });
  assert.deepEqual(await none.search('who’s my roommate?'), []);

  const locked = fakeVault('/Users/k/Documents/Vault', NOTES);
  locked.listNotes = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, scandir'), { code: 'EPERM' });
  };
  const denied = createVaultIndex({ vault: () => locked, file: path.join(scratch(t), 'i.json'), fetchImpl: ollama.fetchImpl, now: () => NOW });
  await denied.refresh();
  assert.deepEqual(denied.status(), { notes: 0, chunks: 0, mode: 'off', model: 'nomic-embed-text', error: 'denied', updatedAt: null });
  assert.deepEqual(await denied.search('who’s my roommate?'), []);
  assert.deepEqual(ollama.calls, []);
});

test('warming loads the model with a tiny embed, and never throws', async (t) => {
  const { index, ollama } = setup({ t });
  await index.refresh();
  const before = ollama.calls.length;
  await index.warm();
  assert.equal(ollama.calls.length, before + 1);
  const { body } = ollama.calls.at(-1);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'keep_alive', 'model', 'truncate']);
  assert.equal(body.input.length, 1);
  assert.match(body.input[0], /^search_query: /);
  assert.equal(body.keep_alive, '10m');
  ollama.state.down = true;
  assert.equal(await index.warm(), undefined);
  assert.equal(index.status().error, 'Ollama isn’t running');
});

test('watching refreshes once the vault is quiet, and never for hidden folders, and says so as any refresh does', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { watchers, fs: fakeFs } = fakeWatching();
  const vault = fakeVault('/vaults/Jester Desktop', NOTES);
  const refreshed = [];
  const index = createVaultIndex({
    vault: () => vault,
    file: path.join(scratch(t), 'i.json'),
    fetchImpl: fakeOllama().fetchImpl,
    now: () => NOW,
    fs: fakeFs,
    onRefreshed: (status) => refreshed.push(status.notes)
  });
  await index.refresh();
  assert.equal(refreshed.length, 1);
  assert.equal(index.watch(), true);
  assert.equal(index.watch(), true, 'once');
  assert.equal(watchers.length, 1);
  assert.deepEqual([watchers[0].root, watchers[0].options], ['/vaults/Jester Desktop', { recursive: true }]);

  const listed = vault.calls.list;
  watchers[0].listener('change', '.obsidian/workspace.json');
  watchers[0].listener('rename', 'Attachments/photo.png');
  mock.timers.tick(5000);
  await settle();
  assert.equal(vault.calls.list, listed, 'Obsidian’s own files, and pictures, aren’t notes');

  for (let i = 0; i < 3; i++) watchers[0].listener('change', 'Notes/Grocery list.md');
  mock.timers.tick(1400);
  await settle();
  assert.equal(vault.calls.list, listed, 'still typing');
  mock.timers.tick(200);
  await settle();
  assert.equal(vault.calls.list, listed + 1, 'one refresh for the lot');
  // The app rewrites its Index note and tells Settings then: a note saved while it runs is listed (measured: it wasn't).
  assert.equal(refreshed.length, 2, 'a refresh the watcher began is told of too');

  index.close();
  assert.equal(watchers[0].closed, true);
  await index.refresh();
  assert.equal(refreshed.length, 2, 'closed, nothing is told');
});

test('another vault chosen is followed without closing, and none is off', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { watchers, fs: fakeFs } = fakeWatching();
  const first = fakeVault('/vaults/Jester Desktop', NOTES);
  const second = fakeVault('/vaults/Other', { 'Ideas.md': { body: '# Ideas\n\n- a bus tracker\n' } });
  let chosen = first;
  const index = createVaultIndex({ vault: () => chosen, file: path.join(scratch(t), 'i.json'), fetchImpl: fakeOllama().fetchImpl, now: () => NOW, fs: fakeFs });
  await index.refresh();
  assert.equal(index.watch(), true);

  chosen = second;
  assert.equal(index.watch(), true);
  assert.deepEqual(watchers.map((watcher) => [watcher.root, watcher.closed]), [['/vaults/Jester Desktop', true], ['/vaults/Other', false]]);
  assert.equal((await index.refresh()).notes, 1);
  assert.equal((await index.search('bus tracker'))[0].rel, 'Ideas.md');
  assert.deepEqual(await index.search('who’s my roommate?'), [], 'not the old vault’s notes');

  // Back to the first, and watch() not asked again: a change in the second isn't followed, nor refreshed for.
  chosen = first;
  const listed = [first.calls.list, second.calls.list];
  watchers[1].listener('change', 'Ideas.md');
  assert.equal(watchers[1].closed, true);
  mock.timers.tick(5000);
  await settle();
  assert.deepEqual([first.calls.list, second.calls.list], listed);

  // The second watched again, then none chosen: its watcher is closed, and no other opened.
  chosen = second;
  assert.equal(index.watch(), true);
  chosen = null;
  assert.equal(index.watch(), false);
  assert.deepEqual(watchers.map((watcher) => [watcher.root, watcher.closed]).slice(2), [['/vaults/Other', true]]);
  assert.deepEqual([index.status().mode, index.status().error], ['off', '']);
  assert.equal((await index.refresh()).mode, 'off');
});

test('another vault chosen mid-embed stops the old one’s embedding after the batch under way', async (t) => {
  const many = fakeVault('/vaults/Jester Desktop', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Notes/Note ${i + 1}.md`, { body: `- item ${i + 1}\n` }])));
  const other = fakeVault('/vaults/Other', { 'Ideas.md': { body: '# Ideas\n\n- a bus tracker\n' } });
  const ollama = fakeOllama();
  let chosen = many;
  const index = createVaultIndex({
    vault: () => chosen,
    file: path.join(scratch(t), 'i.json'),
    // The user picks another vault in Settings while the first batch is embedded.
    fetchImpl: (url, init) => {
      if (chosen === many) {
        chosen = other;
        index.refresh();
      }
      return ollama.fetchImpl(url, init);
    },
    now: () => NOW
  });
  const status = await index.refresh();
  assert.equal(ollama.calls.length, 2);
  assert.equal(ollama.documents().length, 32 + 1, 'the first batch of 40, then the new vault’s one piece');
  assert.ok(ollama.documents().slice(0, 32).every((input) => /- item \d+$/.test(input)));
  assert.equal(ollama.documents().at(-1), 'search_document: Ideas\n- a bus tracker');
  assert.deepEqual([status.notes, status.mode], [1, 'meaning']);
});

test('in a long first embedding, a note just written is found by words at once, and what’s done is saved as it goes', async (t) => {
  const forty = () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Notes/Note ${i + 1}.md`, { body: `- item ${i + 1}\n` }]));
  const many = fakeVault('/vaults/Jester Desktop', forty());
  const ollama = fakeOllama();
  const seen = [];
  const index = createVaultIndex({
    vault: () => many,
    file: path.join(scratch(t), 'i.json'),
    fetchImpl: async (url, init) => {
      if (!ollama.calls.length) {
        // "Remember that I parked on level 3", said while the vault is embedded: written, and a refresh asked for.
        many.put('Jester/Remembered/2026-11-10 Parking spot.md', { body: '# Parking spot\n\n> I parked on level 3 of the East Deck\n' });
        index.refresh();
      } else if (ollama.calls.length === 1) seen.push((await index.search('East Deck parking', { only: 'words' })).map((hit) => hit.rel));
      return ollama.fetchImpl(url, init);
    },
    now: () => NOW
  });
  const status = await index.refresh();
  assert.deepEqual(seen, [['Jester/Remembered/2026-11-10 Parking spot.md']], 'found before the rest of the vault was embedded');
  assert.deepEqual([status.notes, status.mode, ollama.documents().length], [41, 'meaning', 41]);

  // Stopped midway (a crash, a quit): what was embedded before is kept.
  const file = path.join(scratch(t), 'i.json');
  const clock = { now: NOW };
  const slow = fakeOllama();
  let saved = null;
  await createVaultIndex({
    vault: () => fakeVault('/vaults/Jester Desktop', forty()),
    file,
    // Each batch takes half a minute: the file as it is when the second begins.
    fetchImpl: (url, init) => {
      if (slow.calls.length === 1) saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      clock.now += 31 * 1000;
      return slow.fetchImpl(url, init);
    },
    now: () => clock.now
  }).refresh();
  assert.ok(saved, 'saved after the first batch, the second under way');
  assert.equal(Object.values(saved.notes).filter((note) => note.chunks[0].vector).length, 32);
});

test('closed, for quitting, it’s off for good and never reads the vault again', async (t) => {
  const gist = ({ notes, chunks, mode, error }) => ({ notes, chunks, mode, error });
  const off = { notes: 0, chunks: 0, mode: 'off', error: '' };
  const { watchers, fs: fakeFs } = fakeWatching();
  const { index, ollama, vault, clock } = setup({ t, fs: fakeFs });
  await index.refresh();
  assert.equal(index.watch(), true);
  const calls = ollama.calls.length;
  const listed = vault.calls.list;
  const read = vault.calls.read.length;
  index.close();
  assert.equal(watchers[0].closed, true);
  assert.deepEqual(gist(index.status()), off);
  vault.put('Notes/Grocery list.md', { body: '# Grocery list\n\n- eggs\n- milk\n- bread\n' });
  clock.now += MINUTE + 1;
  assert.deepEqual(gist(await index.refresh()), off);
  assert.deepEqual(await index.search('who’s my roommate?'), []);
  assert.equal(index.watch(), false);
  await index.warm();
  assert.equal(ollama.calls.length, calls, 'nothing asked of Ollama');
  assert.deepEqual([vault.calls.list, vault.calls.read.length], [listed, read], 'the vault isn’t read again');

  // Closed before it ever looked: the vault's never read, nor the index written.
  const early = setup({ t, fs: fakeFs });
  early.index.close();
  assert.deepEqual(gist(await early.index.refresh()), off);
  assert.deepEqual(await early.index.search('who’s my roommate?'), []);
  assert.equal(early.index.watch(), false);
  await early.index.warm();
  assert.deepEqual([early.vault.calls.list, early.vault.calls.read, early.ollama.calls], [0, [], []]);
  assert.equal(fs.existsSync(early.file), false);
  assert.equal(watchers.length, 1, 'neither watched again');

  // Closed while it embeds: Ollama's asked to stop, and the refresh under way ends off.
  const signals = [];
  const embedding = createVaultIndex({
    vault: () => vault,
    file: path.join(scratch(t), 'i.json'),
    // An Ollama that answers nothing, and gives up only when told to.
    fetchImpl: (url, init) => {
      signals.push(init.signal);
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    },
    now: () => NOW
  });
  const run = embedding.refresh();
  await settle();
  assert.equal(signals.length, 1);
  embedding.close();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(gist(await run), off);
});

test('the tuning is what the eval chose', () => {
  assert.deepEqual(Object.keys(TUNING), ['floor', 'wordShare', 'wordShareAlone', 'titleBonus', 'dayBonus']);
  assert.ok(TUNING.wordShareAlone < TUNING.wordShare, 'with Ollama off, words are all there is');
  assert.ok(TUNING.floor > 0.5 && TUNING.floor < 0.8, 'unrelated text scores about 0.5');
});
