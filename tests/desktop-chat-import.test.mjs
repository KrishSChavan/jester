import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { chatNote, importChats, readExports, SOURCES } from '../desktop/src/main/chat-import.js';
import { createVault, IMPORTED_IN, parseFrontmatter } from '../desktop/src/main/vault.js';
import { openZip } from '../desktop/src/main/zip-read.js';

// The notes' dates and times are local: these tests are on New York time.
process.env.TZ = 'America/New_York';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = 'jester-chat-import-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// ——— A zip, made here as zip tools make them ———

function zip64Extra(values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, i) => extra.writeBigUInt64LE(BigInt(value), 4 + i * 8));
  return extra;
}

/** A zip of these files: deflated or stored, its sizes in zip64's records or not, some marked as locked. */
function makeZip(files, { deflate = true, zip64 = false, locked = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const flags = 0x800 | (locked.includes(name) ? 1 : 0);
    const method = deflate ? 8 : 0;
    const localExtra = zip64 ? zip64Extra([data.length, packed.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, nameBytes, localExtra, packed);
    const extra = zip64 ? zip64Extra([data.length, packed.length, offset]) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, nameBytes, extra);
    offset += 30 + nameBytes.length + localExtra.length + packed.length;
  }
  const list = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const parts = [...locals, list];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(list.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + list.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : list.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

function zipFile(files, options, name = 'export.zip') {
  const file = join(tempDir(), name);
  writeFileSync(file, makeZip(files, options));
  return file;
}

// ——— Exports, as Claude and ChatGPT write them ———

const ROOT = '00000000-0000-4000-8000-000000000000';
const API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

/** Claude's conversations.json: a chat with a retried question, an old one without parents, and an empty one. */
function claudeExport({ updated = '2026-03-15T16:00:00Z', more = [] } = {}) {
  return [
    {
      uuid: 'c-trip',
      name: 'Planning the trip',
      summary: '',
      created_at: '2026-03-14T14:05:00Z',
      updated_at: updated,
      account: { uuid: 'acct' },
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-03-14T14:05:00Z',
          text: 'Plan a trip',
          content: [{ type: 'text', text: 'Plan a trip to Boston', citations: [] }],
          attachments: [{ file_name: 'notes.txt', file_size: 10, file_type: 'text/plain', extracted_content: 'day one\nday two #packing' }],
          files: [{ file_uuid: 'f1', file_name: 'map.png' }],
          parent_message_uuid: ROOT
        },
        {
          uuid: 'm2',
          sender: 'assistant',
          created_at: '2026-03-14T14:06:00Z',
          text: '',
          content: [
            { type: 'thinking', thinking: 'Mulling it over privately.' },
            { type: 'text', text: '# Itinerary\nDay 1: the Freedom Trail\nWear #f59e0b, see `#inline` code, and #boston' },
            { type: 'tool_use', name: 'web_search', input: { query: 'boston weather' } },
            { type: 'tool_result', name: 'web_search', content: [{ type: 'text', text: 'Rain.' }] },
            { type: 'tool_use', name: 'web_search', input: { query: 'boston weather' } },
            { type: 'tool_use', name: 'web_fetch', input: { url: 'https://www.boston.gov/visit' } },
            { type: 'tool_use', name: 'artifacts', input: { id: 'a1', command: 'create', title: 'Packing list', type: 'text/markdown', content: '- socks\n```js\nlet x = 1;\n```' } },
            { type: 'text', text: 'Here it is.' }
          ],
          attachments: [],
          files: [],
          parent_message_uuid: 'm1'
        },
        { uuid: 'm3', sender: 'human', created_at: '2026-03-15T14:00:00Z', content: [{ type: 'text', text: 'First try at a question' }], parent_message_uuid: 'm2' },
        { uuid: 'm4', sender: 'assistant', created_at: '2026-03-15T14:01:00Z', content: [{ type: 'text', text: 'An answer nobody saw again' }], parent_message_uuid: 'm3' },
        { uuid: 'm5', sender: 'human', created_at: '2026-03-15T15:00:00Z', content: [{ type: 'text', text: 'Edited question\n## A heading of mine\n```\nunclosed' }], parent_message_uuid: 'm2' },
        {
          uuid: 'm6',
          sender: 'assistant',
          created_at: '2026-03-15T15:01:00Z',
          content: [
            { type: 'tool_use', name: 'artifacts', input: { id: 'a1', command: 'update', old_str: 'socks', new_str: 'warm socks' } },
            { type: 'tool_use', name: 'mcp__claude-device__chrome_browser_batch', input: {} },
            { type: 'text', text: `Updated it.\nThe api key is ${API_KEY}\nSee you.` }
          ],
          parent_message_uuid: 'm5'
        },
        ...more
      ]
    },
    {
      uuid: 'c-old',
      name: '',
      created_at: '2023-09-18T15:22:58Z',
      updated_at: '2023-09-18T15:25:18Z',
      chat_messages: [
        { uuid: 'o1', sender: 'human', created_at: '2023-09-18T15:23:13Z', text: 'How are you better than other assistants?', content: [], parent_message_uuid: null },
        { uuid: 'o2', sender: 'assistant', created_at: '2023-09-18T15:23:14Z', text: 'I try to be helpful.', content: [], parent_message_uuid: null }
      ]
    },
    { uuid: 'c-empty', name: 'Nothing here', created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:00:00Z', chat_messages: [] }
  ];
}

/** Private-use characters, as ChatGPT marks citations and named things with them. */
const mark = (code) => String.fromCharCode(code);
const CITE = `${mark(0xe200)}cite${mark(0xe202)}turn0search0${mark(0xe201)}`;
const ENTITY = `${mark(0xe200)}entity${mark(0xe202)}["dish","Eggs Benedict","brunch"]${mark(0xe201)}`;
const seconds = (iso) => Date.parse(iso) / 1000;

/** ChatGPT's conversations.json: a chat with a retried answer, a search between two parts of a reply, and a picture. */
function chatgptExport({ current = true } = {}) {
  const message = (role, parts, extra = {}) => ({
    id: extra.id,
    author: { role, name: null, metadata: {} },
    create_time: extra.at ?? null,
    content: { content_type: extra.type || 'text', parts },
    status: 'finished_successfully',
    recipient: extra.recipient || 'all',
    metadata: extra.metadata || {}
  });
  return [
    {
      title: 'Recipe ideas',
      create_time: seconds('2026-03-14T18:00:00Z'),
      update_time: seconds('2026-03-14T18:10:00Z'),
      conversation_id: 'g-1',
      id: 'g-1',
      default_model_slug: 'gpt-5',
      ...(current ? { current_node: 'n5' } : {}),
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['n0'] },
        n0: { id: 'n0', message: message('system', [''], { metadata: { is_visually_hidden_from_conversation: true } }), parent: 'root', children: ['n1'] },
        n1: { id: 'n1', message: message('user', ['What can I cook with eggs?'], { at: seconds('2026-03-14T18:00:00Z') }), parent: 'n0', children: ['old', 'n2'] },
        old: { id: 'old', message: message('assistant', ['An older answer'], { at: seconds('2026-03-14T18:00:30Z') }), parent: 'n1', children: [] },
        n2: { id: 'n2', message: message('assistant', [`Try a frittata${CITE} or shakshuka【3†source】.`], { at: seconds('2026-03-14T18:01:00Z') }), parent: 'n1', children: ['n3'] },
        n3: { id: 'n3', message: message('assistant', ['search("eggs")'], { type: 'code', recipient: 'web' }), parent: 'n2', children: ['tool'] },
        tool: { id: 'tool', message: message('tool', ['results'], {}), parent: 'n3', children: ['n4'] },
        n4: { id: 'n4', message: message('assistant', [`Also: ${ENTITY}.`], { at: seconds('2026-03-14T18:01:30Z') }), parent: 'tool', children: ['n5'] },
        n5: {
          id: 'n5',
          message: message('user', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-1' }, { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-2' }, 'And with these?'], {
            type: 'multimodal_text',
            at: seconds('2026-03-14T18:10:00Z'),
            metadata: { attachments: [{ id: 'file-1', name: 'fridge.jpg', mimeType: 'image/jpeg' }] }
          }),
          parent: 'n4',
          children: []
        }
      }
    }
  ];
}

// ——— The zip reader ———

test('zip: reads deflated, stored and zip64 files, by their UTF-8 names', () => {
  const files = { 'conversations.json': '[1,2,3]', 'nested/naïve.txt': 'héllo'.repeat(200), 'empty.txt': '' };
  for (const options of [{}, { deflate: false }, { zip64: true }]) {
    const zip = openZip(zipFile(files, options));
    try {
      assert.deepEqual(zip.names, Object.keys(files));
      for (const [name, content] of Object.entries(files)) {
        assert.equal(zip.read(name).toString('utf8'), content, `${name} ${JSON.stringify(options)}`);
        assert.equal(zip.size(name), Buffer.byteLength(content));
      }
      assert.throws(() => zip.read('missing.json'), { code: 'ENOENT' });
    } finally {
      zip.close();
    }
  }
});

test('zip: a file that isn’t one, or a locked file in one, says so', () => {
  const notZip = join(tempDir(), 'fake.zip');
  writeFileSync(notZip, 'this is plain text, not a zip');
  assert.throws(() => openZip(notZip), { code: 'bad_zip' });
  const locked = openZip(zipFile({ 'conversations.json': '[]' }, { locked: ['conversations.json'] }));
  try {
    assert.throws(() => locked.read('conversations.json'), /locked with a password/);
  } finally {
    locked.close();
  }
});

// ——— Reading Claude’s export ———

test('Claude: the version last shown, what was said and made, tools in a line, thinking left out', () => {
  const file = zipFile({ 'conversations.json': JSON.stringify(claudeExport()) }, {}, 'conversations-000.zip');
  const { chats, problems } = readExports([file]);
  assert.deepEqual(problems, []);
  assert.equal(chats.length, 3);
  const [trip, old, empty] = chats;
  assert.equal(trip.source, 'claude');
  assert.equal(trip.id, 'c-trip');
  assert.equal(trip.branched, true);
  // m3 and m4 were the question before it was edited: what the chat shows now is m1, m2, m5, m6.
  assert.deepEqual(trip.messages.map((message) => message.you), [true, false, true, false]);
  const all = JSON.stringify(trip.messages);
  assert.doesNotMatch(all, /First try|nobody saw|Mulling/);
  assert.deepEqual(trip.messages[0].parts, [
    { kind: 'text', text: 'Plan a trip to Boston' },
    { kind: 'pasted', title: 'notes.txt', text: 'day one\nday two #packing' },
    { kind: 'files', items: ['map.png'] }
  ]);
  assert.deepEqual(trip.messages[1].parts, [
    { kind: 'text', text: '# Itinerary\nDay 1: the Freedom Trail\nWear #f59e0b, see `#inline` code, and #boston' },
    { kind: 'tools', items: ['searched “boston weather”', 'searched “boston weather”', 'read boston.gov'] },
    { kind: 'made', title: 'Packing list', lang: 'markdown', text: '- socks\n```js\nlet x = 1;\n```' },
    { kind: 'text', text: 'Here it is.' }
  ]);
  assert.deepEqual(trip.messages[3].parts[0], { kind: 'tools', items: ['updated “Packing list”', 'chrome browser batch'] });
  // An old export, with no parents: in order.
  assert.equal(old.branched, false);
  assert.deepEqual(old.messages.map((message) => message.parts[0].text), ['How are you better than other assistants?', 'I try to be helpful.']);
  assert.equal(empty.messages.length, 0);
});

test('Claude: the note, with its properties, headings under its own, and a key left out', () => {
  const [trip, old] = readExports([zipFile({ 'conversations.json': JSON.stringify(claudeExport()) })]).chats;
  const note = chatNote(trip);
  assert.equal(note.folder, 'Claude/2026');
  assert.equal(note.name, '2026-03-14 Planning the trip');
  assert.equal(note.leftOut, 1);
  const { data, body } = parseFrontmatter(note.text);
  assert.deepEqual(data, {
    type: 'chat',
    source: 'Claude',
    created: '2026-03-14T10:05:00-04:00',
    updated: '2026-03-15T12:00:00-04:00',
    chat_id: 'c-trip',
    tags: ['chat/claude']
  });
  const lines = body.split('\n');
  assert.equal(lines[0], '# Planning the trip');
  assert.match(body, /A chat with Claude, started Saturday, March 14, 2026 at 10:05 AM, imported from Claude’s export\. \[Open it on claude\.ai\]\(https:\/\/claude\.ai\/chat\/c-trip\)/);
  assert.match(body, /Some of its messages were edited or retried/);
  // Who and when; the day too, once it's another.
  assert.deepEqual(
    lines.filter((line) => line.startsWith('## ')),
    ['## You · 10:05 AM', '## Claude · 10:06 AM', '## You · Mar 15, 11:00 AM', '## Claude · Mar 15, 11:01 AM']
  );
  // Its words' headings sit under the message's, and a code block left open is closed before the next message.
  assert.ok(lines.includes('#### Itinerary'));
  assert.ok(lines.includes('##### A heading of mine'));
  assert.match(body, /```\nunclosed\n```\n\n## Claude · Mar 15/);
  assert.ok(lines.includes('_Claude used: searched “boston weather” ×2 · read boston.gov_'));
  assert.ok(lines.includes('_Attached: map.png_'));
  assert.match(body, /> \[!quote\]- Pasted: notes\.txt\n> day one\n> day two \\#packing/);
  // A #word isn't made one of the user's tags: escaped, but not in code, where it's code.
  assert.ok(lines.includes('Wear \\#f59e0b, see `#inline` code, and \\#boston'));
  assert.match(body, /```js\n> let x = 1;/);
  // What it made, folded, in a fence its own code block can't close.
  assert.match(body, /> \[!example\]- Made: Packing list\n> ````markdown\n> - socks\n> ```js\n> let x = 1;\n> ```\n> ````/);
  assert.doesNotMatch(note.text, new RegExp(API_KEY));
  assert.match(body, /Updated it\.\n\(Jester left out a line here: it looked like it held an API key\.\)\nSee you\./);
  // A chat with no name is called by its first words, in its own year.
  const named = chatNote(old);
  assert.equal(named.folder, 'Claude/2023');
  assert.equal(named.name, '2023-09-18 How are you better than other assistants');
  assert.match(named.text, /^# How are you better than other assistants$/m);
});

// ——— Reading ChatGPT’s export ———

test('ChatGPT: the branch it shows, one reply across a search, its citation marks gone, pictures named', () => {
  for (const current of [true, false]) {
    const { chats, problems } = readExports([zipFile({ 'conversations.json': JSON.stringify(chatgptExport({ current })), 'chat.html': '<html></html>' })]);
    assert.deepEqual(problems, []);
    const [chat] = chats;
    assert.equal(chat.source, 'chatgpt');
    assert.equal(chat.id, 'g-1');
    assert.equal(chat.model, 'gpt-5');
    assert.equal(chat.branched, true);
    assert.deepEqual(chat.messages, [
      { you: true, at: Date.parse('2026-03-14T18:00:00Z'), parts: [{ kind: 'text', text: 'What can I cook with eggs?' }] },
      {
        you: false,
        at: Date.parse('2026-03-14T18:01:00Z'),
        parts: [
          { kind: 'text', text: 'Try a frittata or shakshuka.' },
          { kind: 'text', text: 'Also: Eggs Benedict.' }
        ]
      },
      {
        you: true,
        at: Date.parse('2026-03-14T18:10:00Z'),
        parts: [
          { kind: 'text', text: 'And with these?' },
          { kind: 'files', items: ['fridge.jpg', 'an image'] }
        ]
      }
    ], `current_node ${current ? 'given' : 'missing'}`);
  }
  const note = chatNote(readExports([zipFile({ 'conversations.json': JSON.stringify(chatgptExport()) })]).chats[0]);
  assert.equal(note.folder, 'ChatGPT/2026');
  assert.equal(note.name, '2026-03-14 Recipe ideas');
  const { data, body } = parseFrontmatter(note.text);
  assert.equal(data.source, 'ChatGPT');
  assert.equal(data.model, 'gpt-5');
  assert.deepEqual(data.tags, ['chat/chatgpt']);
  assert.match(body, /\[Open it on chatgpt\.com\]\(https:\/\/chatgpt\.com\/c\/g-1\)/);
  assert.match(body, /## ChatGPT · 2:01 PM\n\nTry a frittata or shakshuka\.\n\nAlso: Eggs Benedict\./);
});

// ——— What's chosen ———

test('choosing: a folder it was unzipped into, the JSON itself, and what isn’t an export', () => {
  const unzipped = tempDir();
  mkdirSync(join(unzipped, 'conversations-000'), { recursive: true });
  writeFileSync(join(unzipped, 'conversations-000', 'conversations.json'), JSON.stringify(claudeExport()));
  const json = join(tempDir(), 'conversations.json');
  writeFileSync(json, JSON.stringify(chatgptExport()));
  const manifest = join(tempDir(), 'manifest-abc-2026-11-17.json');
  writeFileSync(manifest, JSON.stringify({ instructions: 'Download each file', data_files: [{ filename: 'conversations-000.zip' }] }));
  const other = join(tempDir(), 'settings.json');
  writeFileSync(other, JSON.stringify({ theme: 'dark' }));
  const noChats = zipFile({ 'projects.json': '[]' }, {}, 'projects-000.zip');
  const nothing = tempDir();
  const { chats, problems } = readExports([unzipped, json, manifest, other, noChats, nothing, join(nothing, 'gone.zip')]);
  assert.deepEqual(chats.map((chat) => chat.id), ['c-trip', 'c-old', 'c-empty', 'g-1']);
  assert.equal(problems.length, 5);
  assert.match(problems[0].why, /Claude’s list of download links.*conversations-000\.zip/);
  assert.match(problems[1].why, /no chats in it/);
  assert.match(problems[2].why, /no chats in it/);
  assert.match(problems[3].why, /no chats in it/);
  assert.match(problems[4].why, /isn’t there any more/);
});

// ——— Into the vault ———

test('import: a folder each, again only what changed, and nothing of anyone else’s written over', async () => {
  const root = tempDir();
  mkdirSync(join(root, '.obsidian'));
  // A note of the user's where one of the chats would go.
  mkdirSync(join(root, 'Claude', '2026'), { recursive: true });
  writeFileSync(join(root, 'Claude', '2026', '2026-03-14 Planning the trip.md'), '# My own trip plan\n');
  const vault = createVault({ root });
  const claude = zipFile({ 'conversations.json': JSON.stringify(claudeExport()) }, {}, 'conversations-000.zip');
  const chatgpt = zipFile({ 'conversations.json': JSON.stringify(chatgptExport()) });

  const first = await importChats({ vault, files: [claude, chatgpt] });
  assert.deepEqual(first, {
    sources: {
      Claude: { added: 2, updated: 0, same: 0, empty: 1, folder: 'Claude' },
      ChatGPT: { added: 1, updated: 0, same: 0, empty: 0, folder: 'ChatGPT' }
    },
    leftOut: 1,
    problems: [],
    failed: 0
  });
  assert.equal(readFileSync(join(root, 'Claude', '2026', '2026-03-14 Planning the trip.md'), 'utf8'), '# My own trip plan\n');
  const trip = join(root, 'Claude', '2026', '2026-03-14 Planning the trip 2.md');
  assert.match(readFileSync(trip, 'utf8'), /chat_id: c-trip/);
  assert.ok(existsSync(join(root, 'Claude', '2023', '2023-09-18 How are you better than other assistants.md')));
  assert.ok(existsSync(join(root, 'ChatGPT', '2026', '2026-03-14 Recipe ideas.md')));
  assert.deepEqual([...vault.importedChats('Claude').keys()].sort(), ['c-old', 'c-trip']);

  const again = await importChats({ vault, files: [claude, chatgpt] });
  assert.deepEqual(again.sources.Claude, { added: 0, updated: 0, same: 2, empty: 1, folder: 'Claude' });
  assert.deepEqual(again.sources.ChatGPT, { added: 0, updated: 0, same: 1, empty: 0, folder: 'ChatGPT' });

  // Carried on since: the same note, rewritten.
  const later = claudeExport({
    updated: '2026-03-20T12:00:00Z',
    more: [{ uuid: 'm7', sender: 'human', created_at: '2026-03-20T12:00:00Z', content: [{ type: 'text', text: 'One more thing' }], parent_message_uuid: 'm6' }]
  });
  const third = await importChats({ vault, files: [zipFile({ 'conversations.json': JSON.stringify(later) })] });
  assert.deepEqual(third.sources.Claude, { added: 0, updated: 1, same: 1, empty: 1, folder: 'Claude' });
  assert.match(readFileSync(trip, 'utf8'), /## You · Mar 20, 8:00 AM\n\nOne more thing/);
  assert.equal(vault.importedChats('Claude').size, 2);
});

test('import: written only in Claude/ and ChatGPT/, and only over that chat’s own note', () => {
  const root = tempDir();
  const vault = createVault({ root });
  assert.deepEqual(IMPORTED_IN, Object.values(SOURCES).map((source) => source.folder));
  for (const name of ['Notes/x', 'Jester/About me', 'Elsewhere/x', 'Claude/../Notes/x', 'Claude/.hidden/x']) {
    assert.throws(() => vault.writeImported({ name, text: '# x\n', id: 'a' }), { code: 'not_writable' }, name);
  }
  // Jester's own writes still stay in Jester/ and Notes/.
  assert.equal(vault.writable('Claude/2026/x.md'), false);
  assert.equal(vault.importedChats('Notes').size, 0);
  // A note that's another chat's isn't rewritten: the chat gets one of its own.
  const first = vault.writeImported({ name: 'ChatGPT/2026/2026-01-01 Hello', text: '---\ntype: chat\nchat_id: one\n---\n# Hello\n', id: 'one' });
  const second = vault.writeImported({ rel: first, name: 'ChatGPT/2026/2026-01-01 Hello', text: '---\ntype: chat\nchat_id: two\n---\n# Hello\n', id: 'two' });
  assert.equal(first, 'ChatGPT/2026/2026-01-01 Hello.md');
  assert.equal(second, 'ChatGPT/2026/2026-01-01 Hello 2.md');
  assert.match(readFileSync(join(root, first), 'utf8'), /chat_id: one/);
});

test('the vault’s readme says where imported chats go', () => {
  const root = tempDir();
  const vault = createVault({ root });
  vault.ensureLayout();
  const readme = readFileSync(join(root, 'Jester', 'How Jester uses this vault.md'), 'utf8');
  assert.match(readme, /only two folders, Jester and Notes, and in Claude and ChatGPT only when you import your chats there/);
  assert.match(readme, /- Claude and ChatGPT: the chats you imported/);
});
