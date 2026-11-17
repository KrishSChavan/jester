import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourcesOf, sourceAddress } from '../desktop/src/main/research-sources.js';
import { createConversation } from '../desktop/src/main/conversation.js';
import { createConversationLog } from '../desktop/src/main/conversation-log.js';
import { createChatArchive } from '../desktop/src/main/chat-archive.js';
import { createVoiceRunner } from '../desktop/src/main/voice-runner.js';

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-sources-'));
  dirs.push(dir);
  return dir;
}
const AT = '2026-11-16T20:00:00Z';
const SOURCE = { url: 'https://school.example.edu/#/course/12', title: 'My course', fetchedAt: AT, kind: 'page', cited: true };

test('research source records allow web pages and hash routes, reject actions and private addresses, and stay bounded', () => {
  for (const url of [
    'javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com/', 'http://localhost/',
    'http://127.0.0.1/', 'https://example.com/delete', 'https://example.com/?access_token=private',
    'https://example.com/?sessionId=private', 'https://example.com/#access_token=private',
    'https://example.com/#/course?refresh_token=private'
  ]) assert.equal(sourceAddress(url), null, url);
  assert.equal(sourceAddress(SOURCE.url).href, SOURCE.url);
  const sanitized = sourcesOf([SOURCE, { ...SOURCE, title: 'Duplicate' }, { url: 'https://example.com/', title: 'My password is hunter2', fetchedAt: 'nonsense', kind: 'injected', html: '<script>' }]);
  assert.deepEqual(sanitized, [SOURCE, { url: 'https://example.com/', title: 'example.com' }]);
  assert.equal(sourcesOf(Array.from({ length: 50 }, (_, i) => ({ url: `https://example.com/${i}` }))).length, 24);
  assert.equal(sourcesOf([{ ...SOURCE, title: 'x'.repeat(500) }])[0].title.length, 200);
  assert.deepEqual(sourcesOf(null), []);
});

test('source cards survive log restart, archive and resume, with unsafe or hidden metadata removed', () => {
  const dir = scratch();
  const file = path.join(dir, 'conversation.json');
  const archivedFile = path.join(dir, 'chats.json');
  const now = () => Date.parse(AT);
  const unsafe = { url: 'https://example.com/?token=must-not-persist', title: 'Private' };
  const log = createConversationLog({ file, now });
  log.add('you', 'Read my course');
  log.add('jester', 'Your essay is due Friday.', { sources: [SOURCE, unsafe] });
  assert.deepEqual(log.entries().at(-1).sources, [SOURCE]);
  const restarted = createConversationLog({ file, now });
  assert.deepEqual(restarted.entries().at(-1).sources, [SOURCE]);
  const archive = createChatArchive({ file: archivedFile, now });
  const id = archive.keep(restarted.entries());
  const saved = newArchive().get(id);
  assert.deepEqual(saved.lines.at(-1).sources, [SOURCE]);
  restarted.restore([...saved.lines, { who: 'jester', text: 'Left out.', at: AT, hidden: true, sources: [SOURCE, unsafe] }], id);
  assert.deepEqual(restarted.entries().at(-2).sources, [SOURCE]);
  assert.equal('sources' in restarted.entries().at(-1), false);
  archive.keep(restarted.entries());
  assert.equal('sources' in newArchive().get(id).lines.at(-1), false);
  for (const stored of [file, archivedFile]) assert.doesNotMatch(fs.readFileSync(stored, 'utf8'), /must-not-persist/);
  function newArchive() { return createChatArchive({ file: archivedFile, now }); }
});

test('a redacted secret line cannot keep source cards in the archive', () => {
  const archive = createChatArchive({ file: path.join(scratch(), 'chats.json'), now: () => Date.parse(AT) });
  archive.keep([
    { who: 'you', text: 'Read this page', at: AT, chat: 'private' },
    { who: 'jester', text: 'The password is hunter2', at: AT, sources: [SOURCE] }
  ]);
  const line = archive.get('private').lines.at(-1);
  assert.equal(line.hidden, true);
  assert.equal('sources' in line, false);
});

for (const typed of [true, false]) test(`${typed ? 'typed' : 'spoken'} research keeps its complete answer with cards, without reading out the citation appendix`, async () => {
  const memory = createConversationLog({ file: path.join(scratch(), 'conversation.json') });
  const answer = 'The assignment is due Friday. '.repeat(30).trim();
  const said = [];
  const conversation = createConversation({
    chat: async () => assert.fail('known research bypasses conversation model'),
    speaker: { say: async (text) => { said.push(text); }, stop() {} }, memory,
    recollections: { keep: async () => '', relevant: () => [], forget() {} },
    commands: { knows: async () => true, risky: async () => false, run: async () => ({ outcome: {
      ok: true, text: `${answer}\n\nSources:\n1. My course — ${SOURCE.url}`, answer, sources: [SOURCE]
    } }) },
    assistant: { asking: false, running: false, cancel() {} }, show() {}
  });
  await conversation.told('Read my course', { typed });
  assert.equal(memory.entries().at(-1).text, answer);
  assert.deepEqual(memory.entries().at(-1).sources, [SOURCE]);
  if (typed) assert.deepEqual(said, []);
  else { assert.ok(said[0].length <= 400); assert.doesNotMatch(said[0], /Sources:|https:/); }
});

test('failed research keeps its failure message and does not attach stale cards', async () => {
  const memory = createConversationLog({ file: path.join(scratch(), 'conversation.json') });
  const conversation = createConversation({
    chat: async () => assert.fail('no conversation model'),
    speaker: { say: async () => undefined, stop() {} }, memory,
    recollections: { keep: async () => '', relevant: () => [], forget() {} },
    commands: { knows: async () => true, risky: async () => false, run: async () => ({ outcome: { ok: false, text: 'Reading failed.', answer: 'Stale answer.', sources: [SOURCE] } }) },
    assistant: { asking: false, running: false, cancel() {} }, show() {}
  });
  await conversation.told('Read my course', { typed: true });
  assert.equal(memory.entries().at(-1).text, 'Reading failed.');
  assert.equal('sources' in memory.entries().at(-1), false);
});

test('browser research handoff preserves answer and safe source metadata', async () => {
  const runner = createVoiceRunner({ driver: { call: async () => ({ apps: [] }) }, installed: () => [],
    dispatch: async () => assert.fail('no computer input'), canPost: () => true, onJester() {},
    browser: { claims: async () => true, run: async () => ({ ok: true, text: 'Friday. Sources: course', answer: 'Friday.', sources: [SOURCE, { url: 'javascript:alert(1)' }] }) }
  });
  const { outcome } = await runner.run('read my Canvas assignments');
  assert.equal(outcome.answer, 'Friday.');
  assert.deepEqual(outcome.sources, [SOURCE]);
});
