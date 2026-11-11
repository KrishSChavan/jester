import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  createVault,
  detectObsidianVaults,
  findVaultRoot,
  parseFrontmatter,
  PATHS,
  safeTitle,
  SECTIONS,
  SYSTEM_TYPES,
  writeFrontmatter
} from '../desktop/src/main/vault.js';

// The notes' dates and times are local: these tests are on New York time.
process.env.TZ = 'America/New_York';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tuesday, November 10, 2026 at 1:05 PM. */
const AT = Date.parse('2026-11-10T13:05:00-05:00');

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = 'jester-vault-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A vault in a temp folder, with these files in it. */
function tempVault({ files = {}, now = () => AT } = {}) {
  const root = tempDir();
  mkdirSync(join(root, '.obsidian'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, vault: createVault({ root, now }), read: (rel) => readFileSync(join(root, rel), 'utf8') };
}

const ABOUT_ME_TEMPLATE = [
  '---',
  'type: profile',
  'tags:',
  '  - jester/profile',
  'aliases:',
  '  - About me',
  '  - What Jester knows about me',
  'updated: 2026-11-10',
  '---',
  '# About me',
  '',
  'What Jester has learned about you from your conversations. Edit or delete anything here: Jester reads this note as it is.',
  '',
  '## Who you are',
  '',
  '## School and work',
  '',
  '## People',
  '',
  '## Preferences',
  '',
  '## Plans and dates',
  '',
  '## Other',
  ''
].join('\n');

test('the sections and system types other modules build on stay as they are', () => {
  assert.deepEqual(SECTIONS, ['Who you are', 'School and work', 'People', 'Preferences', 'Plans and dates', 'Other']);
  assert.deepEqual(SYSTEM_TYPES, ['routines', 'index', 'readme']);
  assert.ok(Object.isFrozen(SECTIONS) && Object.isFrozen(SYSTEM_TYPES));
});

test('the vault is the folder holding .obsidian, or the one folder in the chosen folder that holds it', () => {
  // The user's layout: they chose Jester-Obsidian-DB, and the vault is "Jester Desktop" in it.
  const parent = tempDir('jester-vault-parent-');
  const vault = join(parent, 'Jester Desktop');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'Welcome.md'), 'Welcome\n');
  writeFileSync(join(parent, '.DS_Store'), '');
  writeFileSync(join(parent, 'Loose note.md'), '# Loose\n');
  mkdirSync(join(parent, 'Attachments'));
  mkdirSync(join(parent, '.hidden', '.obsidian'), { recursive: true });
  assert.equal(findVaultRoot(parent), vault);
  assert.equal(findVaultRoot(vault), vault);
  assert.equal(findVaultRoot(`${vault}${sep}`), vault);

  // Two vaults in it: no telling which, so the folder as it is.
  mkdirSync(join(parent, 'Other vault', '.obsidian'), { recursive: true });
  assert.equal(findVaultRoot(parent), parent);

  // A plain folder of notes works too; what isn't a folder doesn't.
  const plain = tempDir('jester-vault-plain-');
  assert.equal(findVaultRoot(plain), plain);
  assert.equal(findVaultRoot(join(plain, 'missing')), null);
  assert.equal(findVaultRoot(join(parent, 'Loose note.md')), null);
  assert.equal(findVaultRoot(''), null);
  assert.equal(findVaultRoot(undefined), null);
});

test('Obsidian’s own list of vaults is read, the open one first, without looking inside them', () => {
  const home = tempDir('jester-vault-home-');
  const mac = join(home, 'Library', 'Application Support', 'obsidian');
  mkdirSync(mac, { recursive: true });
  const vaults = {
    a1: { path: '/Users/k/Documents/Old vault', ts: 1794000000000 },
    b2: { path: '/Users/k/Documents/Jester-Obsidian-DB/Jester Desktop', ts: 1794336569935, open: true },
    c3: { path: '/Users/k/Newer', ts: 1794400000000 },
    d4: { ts: 5 },
    e5: { path: '/Users/k/Newer', ts: 1 }
  };
  writeFileSync(join(mac, 'obsidian.json'), JSON.stringify({ vaults, frame: 'hidden' }));
  // None of these folders exist, and they needn't: a vault in Documents would ask macOS for permission to look.
  assert.deepEqual(detectObsidianVaults({ home, platform: 'darwin' }), [
    { path: '/Users/k/Documents/Jester-Obsidian-DB/Jester Desktop', name: 'Jester Desktop', open: true },
    { path: '/Users/k/Newer', name: 'Newer', open: false },
    { path: '/Users/k/Documents/Old vault', name: 'Old vault', open: false }
  ]);

  // Windows keeps it in %APPDATA%; a home given is where that's looked for.
  const windows = join(home, 'AppData', 'Roaming', 'obsidian');
  mkdirSync(windows, { recursive: true });
  writeFileSync(join(windows, 'obsidian.json'), JSON.stringify({ vaults: { x: { path: 'C:\\Users\\krish\\Documents\\School', ts: 2, open: true } } }));
  assert.deepEqual(detectObsidianVaults({ home, platform: 'win32' }), [{ path: 'C:\\Users\\krish\\Documents\\School', name: 'School', open: true }]);
  assert.deepEqual(detectObsidianVaults({ home, platform: 'win32', appData: join(home, 'elsewhere') }), []);

  // None, or a list that can't be read: none.
  assert.deepEqual(detectObsidianVaults({ home: tempDir('jester-vault-nohome-'), platform: 'darwin' }), []);
  assert.deepEqual(detectObsidianVaults({ home, platform: 'linux' }), []);
  writeFileSync(join(mac, 'obsidian.json'), '{ not json');
  assert.deepEqual(detectObsidianVaults({ home, platform: 'darwin' }), []);
  writeFileSync(join(mac, 'obsidian.json'), JSON.stringify({ vaults: null }));
  assert.deepEqual(detectObsidianVaults({ home, platform: 'darwin' }), []);
});

test('frontmatter is read as Obsidian writes it: block and flow lists, quoted strings, colons in values', () => {
  const note = [
    '---',
    'title: "Plan: week 1"',
    'source: https://example.com/a?b=c#d',
    'time: 13:05',
    'summary: Note: a colon in a plain value',
    "single: 'it''s here'",
    'escaped: "line one\\nline two \\"quoted\\" \\x41"',
    'tags: [school, "cmpsc 465", \'a, b\', 3]',
    'aliases:',
    '  - Week one',
    '  - "Plan: 1"',
    'people:',
    '- Sam',
    '- Dr. Lee',
    'count: 3',
    'ratio: -0.5',
    'zip: 02139',
    'done: false',
    'nothing:',
    'tilde: ~',
    'empty: []',
    'comment: kept # not this',
    '# a comment line',
    'nested:',
    '  a: 1',
    '  b: 2',
    'wrapped: a long value',
    '  that wraps',
    'block: |',
    '  first',
    '  second',
    'folded: >-',
    '  one',
    '  two',
    '',
    '  three',
    'items:',
    '  # a comment among them',
    '  - |-',
    '    line a',
    '    line b',
    '  - plain item',
    '  - "quoted',
    '    across lines"',
    '  - - nested',
    '    - list',
    'maps:',
    '  - name: Sam',
    '    age: 3',
    '"quoted key": yes',
    '---',
    '# Plan',
    '',
    'Body: text.',
    ''
  ].join('\n');
  assert.deepEqual(parseFrontmatter(note), {
    data: {
      title: 'Plan: week 1',
      source: 'https://example.com/a?b=c#d',
      time: '13:05',
      summary: 'Note: a colon in a plain value',
      single: "it's here",
      escaped: 'line one\nline two "quoted" A',
      tags: ['school', 'cmpsc 465', 'a, b', 3],
      aliases: ['Week one', 'Plan: 1'],
      people: ['Sam', 'Dr. Lee'],
      count: 3,
      ratio: -0.5,
      zip: '02139',
      done: false,
      nothing: null,
      tilde: null,
      empty: [],
      comment: 'kept',
      nested: 'a: 1\nb: 2',
      wrapped: 'a long value that wraps',
      block: 'first\nsecond\n',
      folded: 'one two\nthree',
      items: ['line a\nline b', 'plain item', 'quoted across lines', ['nested', 'list']],
      // A list of maps is a shape this doesn't read: kept as its text.
      maps: ['name: Sam\nage: 3'],
      'quoted key': 'yes'
    },
    body: '# Plan\n\nBody: text.\n'
  });

  // No frontmatter, or one never closed: all body.
  assert.deepEqual(parseFrontmatter('# Just a note\n'), { data: {}, body: '# Just a note\n' });
  assert.deepEqual(parseFrontmatter('---\ntype: note\n# never closed\n'), { data: {}, body: '---\ntype: note\n# never closed\n' });
  // Windows line endings, and a byte-order mark.
  assert.deepEqual(parseFrontmatter('---\r\ntype: note\r\ntags:\r\n  - a\r\n---\r\n# T\r\n'), { data: { type: 'note', tags: ['a'] }, body: '# T\r\n' });
  assert.deepEqual(parseFrontmatter(`${String.fromCharCode(0xfeff)}---\ntype: note\n---\nx`), { data: { type: 'note' }, body: 'x' });
});

test('frontmatter written is read back the same, with lists in block style and quotes only where YAML needs them', () => {
  const data = {
    type: 'note',
    title: 'Plan: week 1',
    url: 'https://example.com/a?b=c#d',
    hash: 'a #b',
    said: 'He said "hi"',
    lead: "'tis",
    dash: '- not a list',
    time: '12:30',
    date: '2026-11-10',
    created: '2026-11-10T13:05:00-05:00',
    yes: 'yes',
    zip: '02139',
    number: 42,
    float: 1.5,
    negative: -3,
    flag: true,
    nothing: null,
    multiline: 'line 1\nline 2',
    tabbed: 'a\tb',
    unicode: 'café “quoted” ✓',
    'due date': '2026-11-12',
    'odd: key': 'v',
    tags: ['jester/profile', 'a: b', '[[Link]]', 'true', '7'],
    empty: [],
    mixed: [1, false, null, 'x']
  };
  const body = '# Title\n\nText with: colons\n';
  const text = writeFrontmatter(data, body);
  assert.deepEqual(parseFrontmatter(text), { data, body });
  const lines = text.split('\n');
  for (const line of [
    'type: note',
    'title: "Plan: week 1"',
    'url: https://example.com/a?b=c#d',
    'hash: "a #b"',
    'said: He said "hi"',
    'time: "12:30"',
    'date: 2026-11-10',
    'created: 2026-11-10T13:05:00-05:00',
    'yes: "yes"',
    'zip: "02139"',
    'nothing:',
    'multiline: "line 1\\nline 2"',
    'unicode: café “quoted” ✓',
    'due date: 2026-11-12',
    '"odd: key": v',
    'tags:',
    '  - jester/profile',
    '  - "a: b"',
    '  - "[[Link]]"',
    '  - "true"',
    '  - "7"',
    'empty: []'
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(text.startsWith('---\ntype: note\n') && text.endsWith(`---\n${body}`));

  // No properties, no frontmatter; a body that looks like frontmatter itself gets an empty one, so it reads back whole.
  assert.equal(writeFrontmatter({}, '# Hi\n'), '# Hi\n');
  const tricky = '---\nnot: properties\n---\n';
  assert.deepEqual(parseFrontmatter(writeFrontmatter({}, tricky)), { data: {}, body: tricky });
  assert.deepEqual(parseFrontmatter(writeFrontmatter({ skipped: undefined, kept: 1 }, '')), { data: { kept: 1 }, body: '' });
});

test('About me is made from its template, a fact goes under its section, and the same fact isn’t added twice', () => {
  const { vault, read } = tempVault();
  assert.deepEqual(vault.aboutMe(), { facts: [], text: '' });
  const first = vault.updateAboutMe(
    {
      add: [
        { section: 'School and work', fact: 'Takes CMPSC 465 at Penn State' },
        { section: 'people', fact: 'Roommate is Sam' },
        { section: 'Hobbies', fact: 'Plays guitar' },
        { section: 'Preferences', fact: '  - Likes   oat milk\nin coffee <!-- hidden -->' },
        { section: 'Other', fact: '' },
        { section: 'People', fact: 'roommate is sam.' }
      ]
    },
    AT
  );
  assert.deepEqual(first, { added: 4, removed: 0 });
  assert.equal(
    read(PATHS.aboutMe),
    ABOUT_ME_TEMPLATE.replace('## School and work\n', '## School and work\n- Takes CMPSC 465 at Penn State <!-- noted 2026-11-10 -->\n')
      .replace('## People\n', '## People\n- Roommate is Sam <!-- noted 2026-11-10 -->\n')
      .replace('## Preferences\n', '## Preferences\n- Likes oat milk in coffee hidden <!-- noted 2026-11-10 -->\n')
      .replace('## Other\n', '## Other\n- Plays guitar <!-- noted 2026-11-10 -->\n')
  );
  // A second fact in a section goes after the first.
  assert.deepEqual(vault.updateAboutMe({ add: [{ section: 'School and work', fact: 'Works at the library' }] }, AT), { added: 1, removed: 0 });
  assert.match(read(PATHS.aboutMe), /- Takes CMPSC 465 at Penn State <!-- noted 2026-11-10 -->\n- Works at the library <!-- noted 2026-11-10 -->\n\n## People/);

  // Case, spacing and punctuation don't make a fact new; nothing new leaves the note as it was, `updated` too.
  const before = read(PATHS.aboutMe);
  const nextDay = { add: [{ section: 'Other', fact: 'takes  CMPSC 465 at Penn State.' }, { section: 'People', fact: 'Roommate is SAM!' }] };
  assert.deepEqual(vault.updateAboutMe(nextDay, AT + DAY), { added: 0, removed: 0 });
  assert.equal(read(PATHS.aboutMe), before);

  assert.deepEqual(vault.aboutMe().facts, [
    { section: 'School and work', fact: 'Takes CMPSC 465 at Penn State' },
    { section: 'School and work', fact: 'Works at the library' },
    { section: 'People', fact: 'Roommate is Sam' },
    { section: 'Preferences', fact: 'Likes oat milk in coffee hidden' },
    { section: 'Other', fact: 'Plays guitar' }
  ]);

  // Removing goes by the same matching, and bumps `updated`.
  assert.deepEqual(vault.updateAboutMe({ remove: ['works at the library', 'Plays guitar <!-- noted 2026-11-10 -->', 'never said'] }, AT + DAY), { added: 0, removed: 2 });
  const after = read(PATHS.aboutMe);
  assert.doesNotMatch(after, /library|guitar/);
  assert.match(after, /^updated: 2026-11-11$/m);
});

test('About me keeps what the user wrote in it: their words, their sections, their properties', () => {
  const theirs = [
    '---',
    'type: profile',
    'tags:',
    '  - jester/profile',
    'aliases:',
    '  - About me',
    '  - What Jester knows about me',
    'updated: 2026-11-01',
    'cssclasses: [wide]',
    '---',
    '# About me',
    '',
    'What Jester has learned about you from your conversations. Edit or delete anything here: Jester reads this note as it is.',
    '',
    '## Who you are',
    'I go by Krish. Junior at Penn State.',
    '',
    '## School and work',
    '- Takes CMPSC 465 at Penn State <!-- noted 2026-11-01 -->',
    '- Works at the library on weekends',
    '',
    '## Health',
    '- Allergic to peanuts',
    '',
    '## People',
    '',
    '## Preferences',
    '',
    '## Plans and dates',
    '- Midterm on November 13 <!-- noted 2026-11-01 -->',
    '',
    '## Other',
    ''
  ].join('\n');
  const { vault, read } = tempVault({ files: { [PATHS.aboutMe]: theirs } });
  const changes = {
    add: [
      { section: 'Who you are', fact: 'Lives in State College' },
      { section: 'Plans and dates', fact: 'Midterm moved to November 14' }
    ],
    remove: ['midterm on November 13', 'Not a fact that’s there']
  };
  assert.deepEqual(vault.updateAboutMe(changes, AT), { added: 2, removed: 1 });
  assert.equal(
    read(PATHS.aboutMe),
    theirs
      .replace('updated: 2026-11-01', 'updated: 2026-11-10')
      // Under a paragraph of theirs, the list starts after a blank line.
      .replace('Junior at Penn State.\n', 'Junior at Penn State.\n\n- Lives in State College <!-- noted 2026-11-10 -->\n')
      .replace('- Midterm on November 13 <!-- noted 2026-11-01 -->', '- Midterm moved to November 14 <!-- noted 2026-11-10 -->')
  );

  const { facts, text } = vault.aboutMe();
  assert.deepEqual(facts, [
    { section: 'Who you are', fact: 'Lives in State College' },
    { section: 'School and work', fact: 'Takes CMPSC 465 at Penn State' },
    { section: 'School and work', fact: 'Works at the library on weekends' },
    { section: 'Health', fact: 'Allergic to peanuts' },
    { section: 'Plans and dates', fact: 'Midterm moved to November 14' }
  ]);
  // For a model: their words and the facts, without Jester's line, the noted dates or the empty sections.
  assert.equal(
    text,
    [
      '# About me',
      '',
      '## Who you are',
      'I go by Krish. Junior at Penn State.',
      '',
      '- Lives in State College',
      '',
      '## School and work',
      '- Takes CMPSC 465 at Penn State',
      '- Works at the library on weekends',
      '',
      '## Health',
      '- Allergic to peanuts',
      '',
      '## Plans and dates',
      '- Midterm moved to November 14'
    ].join('\n')
  );
});

test('a section the user took out of About me comes back at the end when a fact needs it', () => {
  const theirs = '---\ntype: profile\nupdated: 2026-11-01\n---\n# About me\n\n## Who you are\n- Is Krish\n';
  const { vault, read } = tempVault({ files: { [PATHS.aboutMe]: theirs } });
  assert.deepEqual(vault.updateAboutMe({ add: [{ section: 'preferences', fact: 'Likes jazz' }] }, AT), { added: 1, removed: 0 });
  assert.equal(read(PATHS.aboutMe), '---\ntype: profile\nupdated: 2026-11-10\n---\n# About me\n\n## Who you are\n- Is Krish\n\n## Preferences\n- Likes jazz <!-- noted 2026-11-10 -->\n');
});

test('+ and # count when facts are compared: C, C++ and C# are three things, and an A+ isn’t an A', () => {
  const { vault } = tempVault();
  const add = (...facts) => vault.updateAboutMe({ add: facts.map((fact) => ({ section: 'School and work', fact })) }, AT);
  const facts = () => vault.aboutMe().facts.map(({ fact }) => fact);
  assert.deepEqual(add('Knows C'), { added: 1, removed: 0 });
  assert.deepEqual(add('Knows C++', 'Knows C#', 'knows  c++.'), { added: 2, removed: 0 });
  assert.deepEqual(add('Got an A in CMPSC 465', 'Got an A+ in CMPSC 465'), { added: 2, removed: 0 });
  // Marks alone still aren't a fact.
  assert.deepEqual(add('++', '#'), { added: 0, removed: 0 });
  assert.deepEqual(facts(), ['Knows C', 'Knows C++', 'Knows C#', 'Got an A in CMPSC 465', 'Got an A+ in CMPSC 465']);

  // Removing a fact takes that one, not the others it differs from by a + or #.
  assert.deepEqual(vault.updateAboutMe({ remove: ['knows c', 'Got an A in CMPSC 465.'] }, AT), { added: 0, removed: 2 });
  assert.deepEqual(facts(), ['Knows C++', 'Knows C#', 'Got an A+ in CMPSC 465']);
});

test('a conversation goes into its day’s note, whose topics and people are the day’s together', () => {
  const { vault, read, root } = tempVault();
  const summary = 'The user asked Jester to open their PSU Canvas bookmark in Chrome.';
  const rel = vault.addConversation({ at: AT, title: 'Opening PSU Canvas', summary, topics: ['canvas', 'School'], people: [] });
  assert.equal(rel, 'Jester/Conversations/2026/2026-11-10.md');
  const first = [
    '---',
    'type: conversations',
    'date: 2026-11-10',
    'tags:',
    '  - jester/conversation',
    'topics:',
    '  - canvas',
    '  - school',
    'people: []',
    '---',
    '# Conversations on Tuesday, November 10, 2026',
    '',
    '## 1:05 PM · Opening PSU Canvas',
    `Summary: ${summary}`,
    'Topics: canvas, school',
    'People: none',
    ''
  ];
  assert.equal(read(rel), first.join('\n'));

  // The user adds a line of their own; the next conversation goes after it, and the day's labels grow.
  appendFileSync(join(root, rel), 'My own aside.\n');
  const later = { at: AT + 3.5 * HOUR, title: 'Grocery run', summary: 'Planned a grocery run with Sam and Ana.', topics: ['groceries', 'Canvas'], people: ['Sam', 'Ana', 'sam'] };
  assert.equal(vault.addConversation(later), rel);
  assert.equal(
    read(rel),
    [
      ...first.slice(0, 8),
      '  - groceries',
      'people:',
      '  - Sam',
      '  - Ana',
      ...first.slice(9, -1),
      'My own aside.',
      '',
      '## 4:35 PM · Grocery run',
      'Summary: Planned a grocery run with Sam and Ana.',
      'Topics: groceries, canvas',
      'People: Sam, Ana',
      ''
    ].join('\n')
  );
  assert.deepEqual(parseFrontmatter(read(rel)).data.topics, ['canvas', 'school', 'groceries']);

  // Another day, another note; another year, another folder.
  assert.equal(vault.addConversation({ at: AT + DAY, title: 'Hi', summary: 'Said hi.' }), 'Jester/Conversations/2026/2026-11-11.md');
  assert.equal(vault.addConversation({ at: '2027-01-01T09:00:00-05:00', title: 'New year' }), 'Jester/Conversations/2027/2027-01-01.md');
  assert.match(read('Jester/Conversations/2027/2027-01-01.md'), /# Conversations on Friday, January 1, 2027\n\n## 9:00 AM · New year\nTopics: none\nPeople: none\n$/);
});

test('a day’s labels written the user’s way are left alone when nothing new joins them', () => {
  const theirs = '---\ntype: conversations\ndate: 2026-11-10\ntopics: [Canvas]\npeople: [Sam]\n---\n# Conversations on Tuesday, November 10, 2026\n';
  const { vault, read } = tempVault({ files: { 'Jester/Conversations/2026/2026-11-10.md': theirs } });
  vault.addConversation({ at: AT, title: 'Again', summary: 'Opened Canvas with Sam.', topics: ['canvas'], people: ['sam'] });
  assert.equal(read('Jester/Conversations/2026/2026-11-10.md'), `${theirs}\n## 1:05 PM · Again\nSummary: Opened Canvas with Sam.\nTopics: canvas\nPeople: sam\n`);
});

test('what the user asks Jester to keep is kept word for word, a note each, never over another', () => {
  const { vault, read } = tempVault();
  const rel = vault.remember({ at: AT, title: 'Locker combination', text: 'my locker combination is 12-34-56', topics: ['Locker'] });
  assert.equal(rel, 'Jester/Remembered/2026-11-10 Locker combination.md');
  assert.equal(
    read(rel),
    [
      '---',
      'type: remembered',
      'created: 2026-11-10T13:05:00-05:00',
      'tags:',
      '  - jester/remembered',
      'topics:',
      '  - locker',
      '---',
      '# Locker combination',
      '',
      '> my locker combination is 12-34-56',
      '',
      'Said to Jester on Tuesday, November 10, 2026 at 1:05 PM.',
      ''
    ].join('\n')
  );
  assert.equal(vault.remember({ at: AT, title: 'Locker combination', text: 'new one: 99-88-77' }), 'Jester/Remembered/2026-11-10 Locker combination 2.md');
  assert.equal(vault.remember({ at: AT, title: 'Locker combination', text: 'third' }), 'Jester/Remembered/2026-11-10 Locker combination 3.md');
  assert.equal(read(rel).includes('12-34-56'), true, 'the first is still there');

  // Every line is quoted, a blank one too, exactly as said.
  const gate = vault.remember({ at: AT, title: 'Gate', text: '\nThe gate code is on the fridge,  \n\n  and the spare key: under the mat\n' });
  assert.match(read(gate), /\n> The gate code is on the fridge, {2}\n>\n> {3}and the spare key: under the mat\n\nSaid to Jester/);

  // With no title, the words name it; no title can lead out of Jester/Remembered.
  assert.equal(vault.remember({ at: AT, text: 'Ana’s birthday is March 3rd. She likes tulips.' }), 'Jester/Remembered/2026-11-10 Ana’s birthday is March 3rd. She.md');
  assert.equal(vault.remember({ at: AT, title: '../../escape', text: 'x' }), 'Jester/Remembered/2026-11-10 escape.md');
  assert.throws(() => vault.remember({ at: AT, title: 'Empty', text: '  \n ' }), /nothing to remember/);
});

test('a note asked for is made in Notes/, then added to: a line as a list item, more as a paragraph', () => {
  const { vault, read } = tempVault();
  assert.deepEqual(vault.addToNote({ title: 'Grocery list', text: 'eggs', at: AT }), { rel: 'Notes/Grocery list.md', created: true });
  const made = ['---', 'type: note', 'tags:', '  - note', 'created: 2026-11-10T13:05:00-05:00', 'updated: 2026-11-10T13:05:00-05:00', '---', '# Grocery list', '', '- eggs', ''];
  assert.equal(read('Notes/Grocery list.md'), made.join('\n'));

  assert.deepEqual(vault.addToNote({ title: 'grocery LIST', text: '- milk', at: AT + MINUTE }), { rel: 'Notes/Grocery list.md', created: false });
  assert.deepEqual(vault.addToNote({ title: 'Grocery list.md', text: 'For the party:\nchips\nsalsa', at: AT + 2 * MINUTE }), { rel: 'Notes/Grocery list.md', created: false });
  vault.addToNote({ title: 'Grocery list', text: 'bread', at: AT + 3 * MINUTE });
  assert.equal(
    read('Notes/Grocery list.md'),
    [...made.slice(0, 5), 'updated: 2026-11-10T13:08:00-05:00', ...made.slice(6, -1), '- milk', '', 'For the party:', 'chips', 'salsa', '', '- bread', ''].join('\n')
  );
  assert.deepEqual(vault.findNote('GROCERY LIST'), { rel: 'Notes/Grocery list.md', writable: true });
  assert.equal(vault.findNote('Shopping'), null);
  assert.equal(vault.findNote('  '), null);

  // Nothing to add makes the note, or leaves it be.
  assert.deepEqual(vault.addToNote({ title: 'Ideas', at: AT }), { rel: 'Notes/Ideas.md', created: true });
  assert.match(read('Notes/Ideas.md'), /---\n# Ideas\n$/);
  assert.deepEqual(vault.addToNote({ title: 'ideas', text: ' ', at: AT + DAY }), { rel: 'Notes/Ideas.md', created: false });
  assert.match(read('Notes/Ideas.md'), /^updated: 2026-11-10T13:05:00-05:00$/m);

  // A title no file can have is made safe for the file, and kept for the heading; it's found again by either.
  assert.deepEqual(vault.addToNote({ title: 'Plan: week 1/2', text: 'start', at: AT }), { rel: 'Notes/Plan week 1 2.md', created: true });
  assert.match(read('Notes/Plan week 1 2.md'), /\n# Plan: week 1\/2\n\n- start\n$/);
  assert.deepEqual(vault.addToNote({ title: 'plan: week 1/2', text: 'finish', at: AT }), { rel: 'Notes/Plan week 1 2.md', created: false });
  assert.deepEqual(vault.addToNote({ title: '../../Plan week 1 2', text: 'x', at: AT }), { rel: 'Notes/Plan week 1 2.md', created: false });
  assert.throws(() => vault.addToNote({ title: '  ', text: 'x' }), { code: 'no_title' });
});

test('adding to a note follows the list it ends with, its line endings, and its title or alias', () => {
  const { vault, read } = tempVault({
    files: {
      'Notes/To do.md': '# To do\n- [x] call mom\n',
      'Notes/Steps.md': '# Steps\n1. first\n2. second\n\n',
      'Notes/Plain.md': '# Plain\n* one\n',
      'Notes/Windows.md': '---\r\ntype: note\r\nupdated: 2026-11-01T09:00:00-05:00\r\n---\r\n# Windows\r\n- a\r\n',
      'Notes/cmpsc465.md': '---\naliases: [Algorithms]\n---\n# CMPSC 465 notes\n',
      'Notes/Untitled thoughts.md': '# Big ideas\n'
    }
  });
  vault.addToNote({ title: 'to do', text: 'email the professor', at: AT });
  assert.equal(read('Notes/To do.md'), '# To do\n- [x] call mom\n- [ ] email the professor\n');
  vault.addToNote({ title: 'steps', text: 'third', at: AT });
  assert.equal(read('Notes/Steps.md'), '# Steps\n1. first\n2. second\n3. third\n');
  vault.addToNote({ title: 'plain', text: 'two', at: AT });
  assert.equal(read('Notes/Plain.md'), '# Plain\n* one\n* two\n', 'no frontmatter of its own: none added');
  vault.addToNote({ title: 'windows', text: 'b', at: AT });
  assert.equal(read('Notes/Windows.md'), '---\r\ntype: note\r\nupdated: 2026-11-10T13:05:00-05:00\r\n---\r\n# Windows\r\n- a\r\n- b\r\n');
  assert.deepEqual(vault.addToNote({ title: 'algorithms', text: 'Exam Friday', at: AT }), { rel: 'Notes/cmpsc465.md', created: false });
  assert.deepEqual(vault.findNote('CMPSC 465 notes'), { rel: 'Notes/cmpsc465.md', writable: true });
  assert.deepEqual(vault.findNote('big ideas'), { rel: 'Notes/Untitled thoughts.md', writable: true });
});

test('a note asked for by a name with + or # in it isn’t the one without: C++ notes aren’t C notes', () => {
  const { vault, read, root } = tempVault({ files: { 'Notes/C notes.md': '# C notes\n- pointers\n', 'Notes/Lab 3.md': 'Bring a laptop.\n' } });
  assert.equal(vault.findNote('C++ notes'), null);
  assert.deepEqual(vault.addToNote({ title: 'C++ notes', text: 'templates and the STL', at: AT }), { rel: 'Notes/C++ notes.md', created: true });
  // No file can be called "C# notes": its # is spelled out, and the note keeps the name as said in its heading.
  assert.deepEqual(vault.addToNote({ title: 'C# notes', text: 'LINQ', at: AT }), { rel: 'Notes/C sharp notes.md', created: true });
  assert.match(read('Notes/C sharp notes.md'), /\n# C# notes\n\n- LINQ\n$/);
  assert.equal(read('Notes/C notes.md'), '# C notes\n- pointers\n');
  assert.deepEqual(vault.addToNote({ title: 'F# homework', text: 'pattern matching', at: AT }), { rel: 'Notes/F sharp homework.md', created: true });

  // With the C notes changed last, each is still found by its own name.
  const later = new Date(Date.now() + HOUR);
  utimesSync(join(root, 'Notes', 'C notes.md'), later, later);
  assert.deepEqual(vault.findNote('c++ notes'), { rel: 'Notes/C++ notes.md', writable: true });
  assert.deepEqual(vault.findNote('C# NOTES'), { rel: 'Notes/C sharp notes.md', writable: true });
  assert.deepEqual(vault.findNote('C sharp notes'), { rel: 'Notes/C sharp notes.md', writable: true });
  assert.deepEqual(vault.findNote('C notes'), { rel: 'Notes/C notes.md', writable: true });
  assert.deepEqual(vault.addToNote({ title: 'C# notes', text: 'async', at: AT }), { rel: 'Notes/C sharp notes.md', created: false });

  // A # that isn't part of a name goes as a file name drops it, and marks alone name no note.
  assert.deepEqual(vault.findNote('Lab #3'), { rel: 'Notes/Lab 3.md', writable: true });
  assert.equal(vault.findNote('#'), null);
  assert.throws(() => vault.addToNote({ title: '++', text: 'x', at: AT }), { code: 'no_title' });
});

test('a note of that name outside Notes/ is the user’s: Jester won’t add to it, or make a second one beside it', () => {
  const theirs = '# Grocery list\n- apples\n';
  const { vault, read, root } = tempVault({ files: { 'Shopping/Grocery list.md': theirs } });
  assert.deepEqual(vault.findNote('grocery list'), { rel: 'Shopping/Grocery list.md', writable: false });
  assert.throws(
    () => vault.addToNote({ title: 'Grocery list', text: 'eggs', at: AT }),
    (err) => err.code === 'read_only' && err.rel === 'Shopping/Grocery list.md'
  );
  assert.equal(read('Shopping/Grocery list.md'), theirs);
  assert.equal(existsSync(join(root, 'Notes')), false);

  // Nor is About me, by any of its names: Jester keeps facts there itself.
  vault.ensureLayout();
  assert.throws(() => vault.addToNote({ title: 'What Jester knows about me', text: 'x', at: AT }), { code: 'read_only' });

  // With one in Notes/ as well, that's the one.
  writeFileSync(join(root, 'Notes', 'Grocery list.md'), '# Grocery list\n');
  assert.deepEqual(vault.addToNote({ title: 'Grocery list', text: 'eggs', at: AT }), { rel: 'Notes/Grocery list.md', created: false });
  assert.equal(read('Notes/Grocery list.md'), '# Grocery list\n\n- eggs\n');
  assert.equal(read('Shopping/Grocery list.md'), theirs);
});

test('Jester’s own notes don’t stop the user’s note of that name being made in Notes/, but About me does', () => {
  const { vault, read, root } = tempVault();
  vault.ensureLayout();
  // vault-memory names "my grocery list is eggs, milk and bread", kept word for word, "Grocery list". It's still found, to open.
  const kept = vault.remember({ at: AT, title: 'Grocery list', text: 'my grocery list is eggs, milk and bread' });
  const words = read(kept);
  assert.deepEqual(vault.findNote('grocery list'), { rel: kept, writable: false });
  assert.deepEqual(vault.addToNote({ title: 'Grocery list', text: 'bread', at: AT }), { rel: 'Notes/Grocery list.md', created: true });
  assert.deepEqual(vault.addToNote({ title: 'grocery list', text: 'milk', at: AT }), { rel: 'Notes/Grocery list.md', created: false });
  assert.equal(read(kept), words);
  assert.deepEqual(vault.findNote('Grocery list'), { rel: 'Notes/Grocery list.md', writable: true });

  // Routines and Index are rewritten whole, so nothing added to them would last.
  vault.writeRoutines([]);
  vault.writeIndex();
  const routines = read(PATHS.routines);
  assert.deepEqual(vault.addToNote({ title: 'Routines', text: 'stretch for 10 minutes', at: AT }), { rel: 'Notes/Routines.md', created: true });
  assert.deepEqual(vault.addToNote({ title: 'Index', text: 'flash cards', at: AT }), { rel: 'Notes/Index.md', created: true });
  assert.match(read('Notes/Routines.md'), /\n# Routines\n\n- stretch for 10 minutes\n$/);
  assert.equal(read(PATHS.routines), routines);
  // The Index links them by their paths, as it shares a name with each.
  vault.writeIndex();
  const index = read(PATHS.index);
  for (const link of ['[[Notes/Index|Index]]', '[[Notes/Routines|Routines]]', '[[Jester/Routines|Routines]]']) {
    assert.ok(index.includes(link), link);
  }

  // About me is where Jester keeps facts: a second one in Notes/ would never be read as it.
  assert.throws(() => vault.addToNote({ title: 'About me', text: 'x', at: AT }), (err) => err.code === 'read_only' && err.rel === PATHS.aboutMe);
  assert.equal(existsSync(join(root, 'Notes', 'About me.md')), false);
});

test('Jester writes only inside Jester/ and Notes/, and no path climbs out', () => {
  const { vault } = tempVault();
  for (const rel of ['Jester/About me.md', 'Jester/Conversations/2026/2026-11-10.md', 'Notes/Grocery list.md', 'Notes/School/Deep note.md']) {
    assert.equal(vault.writable(rel), true, rel);
  }
  for (const rel of [
    'Welcome.md',
    'Jester',
    'Notes',
    'Jester/',
    'Notes/',
    'Jester/../Welcome.md',
    'Notes/../../etc/passwd',
    '../Jester/x.md',
    'Jester/./x.md',
    'Jester//x.md',
    '/Jester/x.md',
    '/etc/passwd',
    'C:/Jester/x.md',
    'c:Jester/x.md',
    'Jester\\..\\x.md',
    'Notes\\x.md',
    '\\\\server\\share\\x.md',
    'Jester2/x.md',
    'JesterX/x.md',
    'Notes2/x.md',
    'notes/x.md',
    'jester/x.md',
    'NOTES/x.md',
    'Jester/.obsidian/x.md',
    '.obsidian/app.json',
    'Notes/.hidden.md',
    `Notes/x.md${String.fromCharCode(0)}.txt`,
    '',
    null,
    undefined,
    42
  ]) {
    assert.equal(vault.writable(rel), false, String(rel));
  }
});

test('a note opens in Obsidian by a link that names the vault and the note', () => {
  const parent = tempDir('jester-vault-link-');
  mkdirSync(join(parent, 'Jester Desktop', '.obsidian'), { recursive: true });
  const vault = createVault({ root: findVaultRoot(parent) });
  assert.equal(vault.name, 'Jester Desktop');
  assert.equal(vault.root, join(parent, 'Jester Desktop'));
  assert.equal(vault.openUrl('Notes/Grocery list.md'), 'obsidian://open?vault=Jester%20Desktop&file=Notes%2FGrocery%20list');
  assert.equal(vault.openUrl('Notes/Q&A #1? 100%.md'), 'obsidian://open?vault=Jester%20Desktop&file=Notes%2FQ%26A%20%231%3F%20100%25');
  assert.equal(vault.openUrl('Jester/Remembered/2026-11-10 Ana’s day.md'), 'obsidian://open?vault=Jester%20Desktop&file=Jester%2FRemembered%2F2026-11-10%20Ana%E2%80%99s%20day');
});

test('ensureLayout makes the folders, About me and the readme once, and leaves the user’s About me be', () => {
  const { vault, read, root } = tempVault({ files: { 'Welcome.md': 'Obsidian’s\n' } });
  assert.deepEqual(vault.ensureLayout(), [PATHS.aboutMe, PATHS.readme]);
  assert.ok(statSync(join(root, 'Notes')).isDirectory());
  assert.equal(read(PATHS.aboutMe), ABOUT_ME_TEMPLATE);
  const readme = read(PATHS.readme);
  const { data, body } = parseFrontmatter(readme);
  assert.deepEqual(data, { type: 'readme', tags: ['jester/system'] });
  assert.ok(SYSTEM_TYPES.includes(data.type));
  for (const words of ['reads every note', 'only two folders', 'Jester/Conversations', 'Jester/Remembered', 'word for word', 'passwords', 'card numbers', 'Edit or delete']) {
    assert.ok(body.includes(words), words);
  }
  // What goes to a model is said as it is: About me with everything said, not only what answers a question.
  assert.ok(body.includes('Whenever what you say goes to the AI model Jester talks through, what’s in About me and the parts of your notes that look related to it go too'));
  assert.ok(body.includes('to a cloud provider, if you chose one in Jester’s Settings › Models.'));

  writeFileSync(join(root, PATHS.aboutMe), 'mine\n');
  assert.deepEqual(vault.ensureLayout(), []);
  assert.equal(read(PATHS.aboutMe), 'mine\n');
  // The readme is Jester's, so a changed one is put back.
  writeFileSync(join(root, PATHS.readme), 'changed\n');
  assert.deepEqual(vault.ensureLayout(), [PATHS.readme]);
  assert.equal(read(PATHS.readme), readme);
  assert.equal(read('Welcome.md'), 'Obsidian’s\n');
});

test('Routines lists what Jester does with no model, by kind, and is rewritten only when that changes', () => {
  const { vault, read, root } = tempVault();
  const items = [
    { kind: 'task', said: 'make a new zoom meeting', does: '3 steps', used: AT - DAY },
    { kind: 'phrase', said: 'focus mode', does: 'open Notes and put it on the left', used: AT },
    { kind: 'alias', said: 'open my exam stuff', does: 'open Canvas' },
    { kind: 'alias', said: 'post in #general', does: 'open Slack #general', used: AT - 2 * DAY },
    { kind: 'alias', said: '', does: 'nothing said' }
  ];
  assert.equal(vault.writeRoutines(items), PATHS.routines);
  const text = read(PATHS.routines);
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, { type: 'routines', tags: ['jester/system'], updated: '2026-11-10' });
  const lines = body.split('\n');
  const at = (line) => lines.indexOf(line);
  for (const line of [
    '# Routines',
    '## You taught',
    '- “focus mode” → open Notes and put it on the left · last used 2026-11-10',
    '## Shortcuts',
    '- “post in \\#general” → open Slack \\#general · last used 2026-11-08',
    '- “open my exam stuff” → open Canvas',
    '## Learned tasks',
    '- “make a new zoom meeting” → 3 steps · last used 2026-11-09'
  ]) {
    assert.ok(at(line) >= 0, line);
  }
  assert.ok(at('## You taught') < at('## Shortcuts') && at('## Shortcuts') < at('## Learned tasks'));
  assert.ok(at('- “post in \\#general” → open Slack \\#general · last used 2026-11-08') < at('- “open my exam stuff” → open Canvas'), 'latest used first');
  assert.doesNotMatch(body, /nothing said/);

  // The same a day later isn't news: not rewritten, `updated` and all.
  const later = createVault({ root, now: () => AT + DAY });
  later.writeRoutines(items);
  assert.equal(read(PATHS.routines), text);
  later.writeRoutines(items.slice(1));
  assert.match(read(PATHS.routines), /^updated: 2026-11-11$/m);
  assert.doesNotMatch(read(PATHS.routines), /zoom/);
  later.writeRoutines([]);
  assert.equal(read(PATHS.routines).match(/^None yet\.$/gm).length, 3);
});

test('Index maps the vault by top folder, linking by name, or by path where two notes share one', () => {
  const { vault, read } = tempVault({
    files: {
      'Welcome.md': 'Hello\n',
      'School/Ideas.md': '---\ntype: note\nupdated: 2026-11-02\n---\n# Ideas for class\n',
      'Notes/Ideas.md': '# Ideas\n',
      'School/CMPSC 465/Midterm.md': '---\ntitle: Algorithms midterm\n---\nFriday\n',
      '.obsidian/workspace.md': 'not a note',
      '.trash/Old.md': '# Old\n'
    }
  });
  assert.equal(
    vault.writeIndex([
      { rel: 'Welcome.md', title: 'Welcome', type: '', updated: '' },
      { rel: 'School/Ideas.md', title: 'Ideas for class', type: 'note', updated: '2026-11-02' },
      { rel: 'Notes/Ideas.md', title: 'Ideas', type: 'note', updated: AT },
      { rel: 'School/CMPSC 465/Midterm.md', title: 'Algorithms midterm', updated: '2026-11-09T10:00:00-05:00' },
      { rel: 'Jester/About me.md', title: 'About me', type: 'profile', updated: '2026-11-10' },
      { rel: 'Jester/Index.md', title: 'Index', type: 'index' },
      { rel: '../outside.md', title: 'Not in the vault' }
    ]),
    PATHS.index
  );
  const { data, body } = parseFrontmatter(read(PATHS.index));
  assert.deepEqual(data, { type: 'index', tags: ['jester/system'], updated: '2026-11-10' });
  assert.equal(
    body,
    [
      '# Index',
      '',
      'A map of this vault, folder by folder: 5 notes. Jester rewrites it as the vault changes.',
      '',
      '## Top level',
      '- [[Welcome]]',
      '',
      '## Jester',
      '- [[About me]] · profile · updated 2026-11-10',
      '',
      '## Notes',
      '- [[Notes/Ideas|Ideas]] · note · updated 2026-11-10',
      '',
      '## School',
      '- [[Midterm|Algorithms midterm]] · updated 2026-11-09',
      '- [[School/Ideas|Ideas for class]] · note · updated 2026-11-02',
      ''
    ].join('\n')
  );

  // Without a list, the vault is read for one: hidden folders and the Index itself left out.
  vault.ensureLayout();
  vault.writeIndex();
  const scanned = read(PATHS.index);
  for (const link of ['[[Welcome]]', '[[School/Ideas|Ideas for class]]', '[[Notes/Ideas|Ideas]]', '[[Midterm|Algorithms midterm]]', '[[About me]]', '[[How Jester uses this vault]]']) {
    assert.ok(scanned.includes(link), link);
  }
  assert.match(scanned, /folder by folder: 6 notes\./);
  assert.doesNotMatch(scanned, /\[\[Old\]\]|workspace|\[\[Index\]\]/);
});

test('listNotes finds every note but in hidden folders, and read() names each by its title, heading or file', () => {
  const { vault, root } = tempVault({
    files: {
      'Welcome.md': 'Hello\n',
      'School/CMPSC 465/Midterm.md': '---\ntitle: Algorithms midterm\naliases: [Exam]\n---\n# A heading loses to the property\n',
      'Notes/Grocery list.md': '---\ntype: note\n---\n# Groceries\n- eggs\n',
      'Notes/Plain.MD': 'no heading here, just ## not one',
      '.obsidian/workspace.md': 'x',
      '.trash/Old.md': 'x',
      '.git/HEAD.md': 'x',
      'Notes/.hidden.md': 'x',
      'Attachments/photo.png': 'x',
      'Jester/Index.md.tmp': 'x'
    }
  });
  const notes = vault.listNotes();
  assert.deepEqual(
    notes.map((note) => note.rel),
    ['Notes/Grocery list.md', 'Notes/Plain.MD', 'School/CMPSC 465/Midterm.md', 'Welcome.md']
  );
  const welcome = notes.at(-1);
  assert.equal(welcome.abs, join(root, 'Welcome.md'));
  assert.equal(welcome.size, 6);
  assert.ok(welcome.mtimeMs > 0);
  assert.equal(vault.read('School/CMPSC 465/Midterm.md').title, 'Algorithms midterm');
  assert.equal(vault.read('Notes/Plain.MD').title, 'Plain');
  assert.deepEqual(vault.read('Notes/Grocery list.md'), { rel: 'Notes/Grocery list.md', title: 'Groceries', data: { type: 'note' }, body: '# Groceries\n- eggs\n' });
  assert.throws(() => vault.read('../outside.md'), { code: 'bad_path' });
  assert.throws(() => vault.read('Notes/missing.md'), { code: 'ENOENT' });
  // A vault that can't be read says so, rather than looking empty.
  assert.throws(() => createVault({ root: join(root, 'missing') }).listNotes(), { code: 'ENOENT' });
});

test('a “# comment” in a note’s code isn’t its title', () => {
  const { vault, read } = tempVault({
    files: {
      'School/Python setup.md': 'How I set up Python for CMPSC 132.\n\n```bash\n# install the packages\npip install numpy\n```\n',
      'School/Shell tricks.md': '~~~sh\n# list everything\nls -la\n~~~\n\n# Shell tricks I use\n\n```\n# not this either\n```\n',
      'School/Windows.md': '```py\r\n# a comment\r\n```\r\n# On Windows\r\n'
    }
  });
  assert.equal(vault.read('School/Python setup.md').title, 'Python setup');
  assert.equal(vault.read('School/Shell tricks.md').title, 'Shell tricks I use');
  assert.equal(vault.read('School/Windows.md').title, 'On Windows');
  assert.equal(vault.findNote('install the packages'), null);
  assert.deepEqual(vault.findNote('python setup'), { rel: 'School/Python setup.md', writable: false });

  // Nor is it what the Index calls the note.
  vault.ensureLayout();
  vault.writeIndex();
  assert.match(read(PATHS.index), /^- \[\[Python setup\]\] · updated /m);
  assert.doesNotMatch(read(PATHS.index), /install the packages|list everything|a comment/);
});

test('every write lands whole: written beside the note, then renamed into place, only in Jester/ and Notes/', () => {
  const root = tempDir();
  mkdirSync(join(root, '.obsidian'));
  writeFileSync(join(root, 'Welcome.md'), 'Welcome\n');
  const calls = [];
  const recording = {
    ...fs,
    writeFileSync: (file, ...rest) => {
      calls.push(['write', file]);
      return fs.writeFileSync(file, ...rest);
    },
    renameSync: (from, to) => {
      calls.push(['rename', from, to]);
      return fs.renameSync(from, to);
    }
  };
  const vault = createVault({ root, fs: recording, now: () => AT });
  vault.ensureLayout();
  vault.updateAboutMe({ add: [{ section: 'Other', fact: 'Likes tea' }] }, AT);
  vault.addConversation({ at: AT, title: 'Hi', summary: 'Said hi.' });
  vault.addConversation({ at: AT + HOUR, title: 'Again', summary: 'Said hi again.' });
  vault.remember({ at: AT, title: 'Gate', text: 'the gate code is on the fridge' });
  vault.addToNote({ title: 'Ideas', text: 'a', at: AT });
  vault.addToNote({ title: 'Ideas', text: 'b', at: AT });
  vault.writeRoutines([]);
  vault.writeIndex();
  assert.equal(calls.length, 20);
  for (let i = 0; i < calls.length; i += 2) {
    const [kind, temp] = calls[i];
    const [next, from, to] = calls[i + 1];
    assert.deepEqual([kind, next, from], ['write', 'rename', temp]);
    // Beside it, under a name of its own: the process's, and the moment's.
    assert.ok(temp.startsWith(`${to}.`), temp);
    assert.match(temp.slice(to.length), /^\.\d+\.\d+\.tmp$/);
    assert.ok(to.startsWith(join(root, 'Jester') + sep) || to.startsWith(join(root, 'Notes') + sep), to);
  }
  const files = readdirSync(root, { recursive: true }).map(String);
  assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
  assert.equal(readFileSync(join(root, 'Welcome.md'), 'utf8'), 'Welcome\n');

  // One that fails part way leaves nothing beside the note.
  const failing = {
    ...fs,
    renameSync: () => {
      throw Object.assign(new Error('the disk went away'), { code: 'EIO' });
    }
  };
  assert.throws(() => createVault({ root, fs: failing, now: () => AT }).addToNote({ title: 'Ideas', text: 'c', at: AT }), { code: 'EIO' });
  assert.deepEqual(readdirSync(join(root, 'Notes')), ['Ideas.md']);
  assert.doesNotMatch(readFileSync(join(root, 'Notes', 'Ideas.md'), 'utf8'), /- c\n/);
});

test('a write never goes through a link: not one left where it writes beside a note, nor a note that is one', () => {
  const { vault, read, root } = tempVault({ files: { 'Notes/Grocery list.md': '# Grocery list\n\n- eggs\n' } });
  vault.ensureLayout();
  const outside = tempDir('jester-vault-outside-');
  writeFileSync(join(outside, 'zshrc'), 'export PATH\n');
  fs.symlinkSync(join(outside, 'zshrc'), join(root, 'Notes', 'Grocery list.md.tmp'));
  fs.symlinkSync(join(outside, 'zshrc'), join(root, 'Jester', 'About me.md.tmp'));
  assert.deepEqual(vault.addToNote({ title: 'Grocery list', text: 'milk', at: AT }), { rel: 'Notes/Grocery list.md', created: false });
  assert.deepEqual(vault.updateAboutMe({ add: [{ section: 'People', fact: 'Roommate is Sam' }] }, AT), { added: 1, removed: 0 });
  assert.equal(readFileSync(join(outside, 'zshrc'), 'utf8'), 'export PATH\n');
  assert.equal(read('Notes/Grocery list.md'), '# Grocery list\n\n- eggs\n- milk\n');
  assert.match(read(PATHS.aboutMe), /^- Roommate is Sam <!-- noted 2026-11-10 -->$/m);
  assert.equal(fs.lstatSync(join(root, 'Notes', 'Grocery list.md')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(join(root, PATHS.aboutMe)).isSymbolicLink(), false);

  // A note that's a link stays one, and the file it links to as it was: written over, it'd be a copy that's never changed again.
  writeFileSync(join(outside, 'real.md'), '# Linked\n\n- a\n');
  fs.symlinkSync(join(outside, 'real.md'), join(root, 'Notes', 'Linked.md'));
  assert.throws(() => vault.addToNote({ title: 'Linked', text: 'b', at: AT }), (err) => err.code === 'read_only' && err.rel === 'Notes/Linked.md' && err.linked === true);
  assert.equal(fs.lstatSync(join(root, 'Notes', 'Linked.md')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(outside, 'real.md'), 'utf8'), '# Linked\n\n- a\n');
  assert.equal(vault.read('Notes/Linked.md').title, 'Linked', 'it’s read all the same');
});

test('a vault whose notes folder is spelled “notes” keeps Jester’s notes in it, named Notes/… as everywhere else', () => {
  const { vault, read, root } = tempVault({ files: { 'notes/Grocery list.md': '# Grocery list\n- apples\n', 'jester/Old.md': '# Old\n' } });
  vault.ensureLayout();
  assert.deepEqual(readdirSync(root).sort(), ['.obsidian', 'jester', 'notes']);
  assert.deepEqual(
    vault.listNotes().map((note) => note.rel),
    [PATHS.aboutMe, PATHS.readme, 'Jester/Old.md', 'Notes/Grocery list.md']
  );
  assert.deepEqual(vault.findNote('grocery list'), { rel: 'Notes/Grocery list.md', writable: true });
  assert.deepEqual(vault.addToNote({ title: 'grocery list', text: 'eggs', at: AT }), { rel: 'Notes/Grocery list.md', created: false });
  assert.equal(read('notes/Grocery list.md'), '# Grocery list\n- apples\n- eggs\n');
  // A note made there is one that can be added to again.
  assert.deepEqual(vault.addToNote({ title: 'Packing list', text: 'charger', at: AT }), { rel: 'Notes/Packing list.md', created: true });
  assert.deepEqual(vault.addToNote({ title: 'Packing list', text: 'toothbrush', at: AT }), { rel: 'Notes/Packing list.md', created: false });
  assert.match(read('notes/Packing list.md'), /\n- charger\n- toothbrush\n$/);
  assert.equal(vault.read(PATHS.aboutMe).data.type, 'profile');
  // Obsidian is handed the folder as it's spelled, and no second one is made beside it.
  assert.equal(vault.openUrl('Notes/Packing list.md'), `obsidian://open?vault=${encodeURIComponent(vault.name)}&file=notes%2FPacking%20list`);
  assert.deepEqual(readdirSync(root).sort(), ['.obsidian', 'jester', 'notes']);
});

test('notes in a folder linked into the vault are listed, as Obsidian shows them, and a link that loops isn’t followed', () => {
  const { vault, root } = tempVault({ files: { 'School/Plan.md': '# Plan\n' } });
  const shared = tempDir('jester-vault-shared-');
  mkdirSync(join(shared, 'Week 1'));
  writeFileSync(join(shared, 'CMPSC 465.md'), '# CMPSC 465\nMidterm 2 is Friday.\n');
  writeFileSync(join(shared, 'Week 1', 'Lecture.md'), '# Lecture\n');
  fs.symlinkSync(shared, join(root, 'Courses'), 'dir');
  // Links back into what's walked already, into the vault, round it, and to nothing.
  fs.symlinkSync(shared, join(shared, 'Loop'), 'dir');
  fs.symlinkSync(shared, join(shared, 'Week 1', 'Back'), 'dir');
  fs.symlinkSync(join(root, 'School'), join(root, 'Again'), 'dir');
  fs.symlinkSync(dirname(root), join(root, 'Up'), 'dir');
  fs.symlinkSync(join(shared, 'missing'), join(root, 'Gone'), 'dir');
  assert.deepEqual(
    vault.listNotes().map((note) => note.rel),
    ['Courses/CMPSC 465.md', 'Courses/Week 1/Lecture.md', 'School/Plan.md']
  );
  assert.deepEqual(vault.findNote('CMPSC 465'), { rel: 'Courses/CMPSC 465.md', writable: false });
  assert.match(vault.read('Courses/CMPSC 465.md').body, /Midterm 2 is Friday/);
});

test('a vault that was moved or deleted isn’t made again, empty, where it was', () => {
  const root = join(tempDir('jester-vault-gone-'), 'Moved vault');
  const vault = createVault({ root, now: () => AT });
  assert.throws(() => vault.ensureLayout(), { code: 'ENOENT' });
  assert.throws(() => vault.updateAboutMe({ add: [{ section: 'Other', fact: 'Likes tea' }] }, AT), { code: 'ENOENT' });
  assert.throws(() => vault.addConversation({ at: AT, title: 'Hi', summary: 'Said hi.' }), { code: 'ENOENT' });
  assert.throws(() => vault.remember({ at: AT, title: 'Gate', text: 'the gate code is on the fridge' }), { code: 'ENOENT' });
  assert.throws(() => vault.addToNote({ title: 'Ideas', text: 'a', at: AT }), { code: 'ENOENT' });
  assert.throws(() => vault.writeRoutines([]), { code: 'ENOENT' });
  assert.equal(existsSync(root), false);
  assert.deepEqual(vault.aboutMe(), { facts: [], text: '' });
});

test('a title becomes a file name that’s safe everywhere', () => {
  assert.equal(safeTitle('Plan: week 1/2 *final*?'), 'Plan week 1 2 final');
  assert.equal(safeTitle('  Mom’s   B-day <ideas> | [draft] #2 ^x  '), 'Mom’s B-day ideas draft 2 x');
  assert.equal(safeTitle('say "hi"\\now'), 'say hi now');
  assert.equal(safeTitle('../../etc/passwd'), 'etc passwd');
  assert.equal(safeTitle('.hidden'), 'hidden');
  assert.equal(safeTitle('Ends with dots...'), 'Ends with dots');
  assert.equal(safeTitle(`a\tb\nc${String.fromCharCode(7)}d`), 'a b c d');
  assert.equal(safeTitle('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(safeTitle('CON'), 'CON note');
  assert.equal(safeTitle('???'), 'Untitled');
  assert.equal(safeTitle(''), 'Untitled');
  assert.equal(safeTitle(undefined), 'Untitled');
});
