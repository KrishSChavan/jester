import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cardElement, cardView, refreshBriefingCards, showBriefingView } from '../desktop/src/home/cards.js';
import { briefingItemsOf, cardOf, createChatArchive } from '../desktop/src/main/chat-archive.js';

function dom() {
  const document = { roots: [], createElement(tag) {
    return { tag, ownerDocument: document, children: [], attributes: {}, dataset: {}, listeners: {},
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      remove() { this.removed = true; }, focus() { document.activeElement = this; },
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); },
      get childElementCount() { return this.children.filter((node) => typeof node === 'object').length; },
      set innerHTML(_) { assert.fail('briefing content must remain literal text'); }
    };
  }, createElementNS(_ns, tag) { return this.createElement(tag); },
  querySelectorAll(selector) { return selector === '.card' ? this.roots.flatMap(elements).filter((node) => /(?:^| )card(?: |$)/.test(node.className || '')) : []; },
  querySelector() { return null; }, dispatchEvent(event) { this.lastEvent = event; } };
  document.body = document.createElement('body');
  return document;
}
const elements = (node) => typeof node === 'object' ? [node, ...node.children.flatMap(elements)] : [];
const buttons = (node) => elements(node).filter((item) => item.tag === 'button');
const button = (node, label) => buttons(node).find((item) => item.children.includes(label) || item.textContent === label);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const brief = (extra = {}) => ({ kind: 'brief', id: 'brief-1', title: 'Morning briefing', lines: ['Today’s schedule.'], offer: true, status: 'offered',
  items: [{ kind: 'event', id: 'event-1', title: 'Class <script>alert(1)</script>', detail: 'Scheduled at 10:00 AM.\nRoom 204.', start: 1794927600000, source: 'School calendar' },
    { kind: 'mail', id: '012abc', title: 'A message', detail: 'From Alex about your project.', source: 'Gmail' },
    { kind: 'task', id: 'task-1', title: 'Submit the essay', detail: 'Due today.' },
    { kind: 'page', id: 'page-1', title: 'Course page', detail: 'Your assignment details.', url: 'https://school.example/assignments/1' },
    { kind: 'activity', id: 'activity-1', title: 'Our conversation', detail: 'You planned the next project step.' }], ...extra });

function globals(t, document, sendMessage) {
  const previousDocument = globalThis.document, previousChrome = globalThis.chrome;
  globalThis.document = document;
  globalThis.chrome = { runtime: { sendMessage } };
  refreshBriefingCards([brief()], { replace: true });
  t.after(async () => { await tick(); globalThis.document = previousDocument; globalThis.chrome = previousChrome; });
}

test('a briefing offer has Read, Later and Dismiss and keeps item details collapsed until requested', async (t) => {
  const document = dom(), sent = [];
  globals(t, document, async (message) => { sent.push(message); return { ok: true }; });
  const card = cardElement(brief()); document.roots.push(card);
  assert.deepEqual(buttons(card).filter((node) => node.children.includes('Read') || node.children.includes('Later') || node.children.includes('Dismiss')).map((node) => node.children.at(-1)), ['Read', 'Later', 'Dismiss']);
  const details = elements(card).find((node) => node.tag === 'details');
  assert.equal(details.open, false);
  assert.equal(details.children[0].textContent, 'See more');
  assert.ok(elements(details).some((node) => node.textContent === 'Scheduled at 10:00 AM.\nRoom 204.'));
  assert.ok(elements(details).some((node) => node.textContent === 'Class <script>alert(1)</script>'));
  assert.equal(buttons(details).length, 4, 'events, mail, tasks and pages have Open; conversation activity stays in Jester');
  await tick();
  assert.deepEqual(sent, [], 'rendering a briefing never reads or opens anything');
});

test('Read disables duplicate actions and refreshes every copy from the stored briefing response', async (t) => {
  const document = dom(), sent = [];
  let finish;
  globals(t, document, (message) => { sent.push(message); return new Promise((resolve) => { finish = resolve; }); });
  const first = cardElement(brief()), second = cardElement(brief()); document.roots.push(first, second);
  const read = button(first, 'Read');
  const started = read.listeners.click();
  await read.listeners.click();
  assert.deepEqual(sent, [{ type: 'jester/briefings', op: 'read', id: 'brief-1' }]);
  assert.ok(buttons(first).every((node) => node.disabled));
  finish({ ok: true, card: brief({ offer: false, status: 'read' }) });
  await started;
  assert.equal(first.card.status, 'read'); assert.equal(second.card.status, 'read');
  assert.equal(button(first, 'Later'), undefined); assert.equal(button(second, 'Dismiss'), undefined);
  assert.equal(button(first, 'Read').disabled, false, 'a saved briefing can be read again');
});

test('item Open sends only authoritative snapshot and item IDs and retains expanded details', async (t) => {
  const document = dom(), sent = [];
  globals(t, document, async (message) => { sent.push(message); return { ok: true }; });
  refreshBriefingCards([brief({ offer: false, status: 'read' })], { replace: true });
  const card = cardElement(brief({ offer: false, status: 'read' })); document.roots.push(card);
  const details = elements(card).find((node) => node.tag === 'details'); details.open = true;
  const open = buttons(details).find((node) => node.attributes['aria-label'] === 'Open Course page');
  await open.listeners.click();
  assert.deepEqual(sent, [{ type: 'jester/briefings', op: 'open', id: 'brief-1', itemId: 'page-1' }]);
  assert.equal(elements(card).find((node) => node.tag === 'details').open, true);
});

test('Later and Dismiss use their own stored-briefing actions; failures allow retry with a visible explanation', async (t) => {
  const document = dom(), sent = [];
  globals(t, document, async (message) => { sent.push(message); return message.op === 'later' ? { ok: true, record: { ...brief(), status: 'later' } } : { ok: false, error: 'This briefing is no longer available.' }; });
  const card = cardElement(brief()); document.roots.push(card);
  await button(card, 'Later').listeners.click();
  assert.equal(card.card.status, 'later');
  assert.ok(elements(card).some((node) => node.textContent === 'I’ll ask again in 10 minutes.'));
  refreshBriefingCards([brief()]);
  await button(card, 'Dismiss').listeners.click();
  assert.deepEqual(sent.map(({ op }) => op), ['later', 'dismiss']);
  assert.ok(elements(card).some((node) => node.attributes.role === 'status' && node.textContent === 'This briefing is no longer available.'));
  assert.equal(button(card, 'Dismiss').disabled, false);
});

test('legacy brief cards remain readable and spoken updates remove stale offer controls', (t) => {
  const document = dom(); globals(t, document, async () => ({ ok: true }));
  const legacy = cardElement({ kind: 'brief', title: 'Today', lines: ['An existing fact.'] });
  assert.ok(elements(legacy).some((node) => node.textContent === 'An existing fact.'));
  assert.deepEqual(buttons(legacy), []);
  const card = cardElement(brief()); document.roots.push(card);
  refreshBriefingCards([brief({ offer: false, status: 'dismissed' })]);
  assert.equal(button(card, 'Later'), undefined);
  assert.equal(button(card, 'Dismiss'), undefined);
  assert.equal(cardView(brief({ status: 'reading' })).detail, 'Reading…');
});

test('a chat rendered after a status update uses the authoritative briefing instead of stale saved card state', (t) => {
  const document = dom(); globals(t, document, async () => ({ ok: true }));
  const read = brief({ offer: false, status: 'read' });
  refreshBriefingCards([read], { replace: true });
  const card = cardElement(brief({ status: 'reading' })); document.roots.push(card);
  assert.equal(card.card.status, 'read');
  assert.equal(button(card, 'Read').disabled, false);
  assert.equal(button(card, 'Later'), undefined);
  const details = elements(card).find((node) => node.tag === 'details'); details.open = true;
  refreshBriefingCards([read], { replace: true });
  assert.equal(elements(card).find((node) => node.tag === 'details'), details, 'identical state ticks preserve focus and native expansion');
  refreshBriefingCards([], { replace: true });
  assert.equal(card.card.status, 'unavailable');
  assert.deepEqual(buttons(card), []);
  const restored = cardElement(brief());
  assert.equal(restored.card.status, 'unavailable', 'an archived card cannot revive a deleted briefing');
  assert.deepEqual(buttons(restored), []);
});

test('calendar items without a source page open an internal dialog and restore focus when closed', (t) => {
  const document = dom(); globals(t, document, async () => ({ ok: true }));
  const prior = document.createElement('button'); document.activeElement = prior;
  const dialog = showBriefingView({ kind: 'calendar', title: 'Calendar · November 17', items: [{ title: 'CS class', detail: '10:00 AM to 11:00 AM.\nRoom 204.', source: 'School calendar' }] }, document);
  assert.equal(dialog.tag, 'dialog'); assert.equal(dialog.open, true);
  assert.equal(dialog.attributes['aria-label'], 'Calendar · November 17');
  assert.ok(elements(dialog).some((node) => node.textContent === '10:00 AM to 11:00 AM.\nRoom 204.'));
  assert.equal(document.activeElement, button(dialog, 'Close'));
  button(dialog, 'Close').listeners.click();
  assert.equal(dialog.removed, true); assert.equal(document.activeElement, prior);
});

test('briefing card sanitization preserves bounded details and safe links while discarding commands, secrets and subscription feeds', () => {
  const source = brief();
  const cleaned = cardOf({ ...source, extra: 'no', items: [...source.items,
    { kind: 'page', id: 'evil', title: 'Unsafe', url: 'javascript:alert(1)', action: 'click' },
    { kind: 'event', id: 'feed', title: 'Private feed', url: 'https://calendar.google.com/calendar/ical/person/private-secret/basic.ics' },
    { kind: 'page', id: 'auth', title: 'Credentials', url: 'https://name:pass@example.com/page' },
    { kind: 'page', id: 'token', title: 'Token', url: 'https://example.com/page?token=private' },
    { kind: 'page', id: 'secret', title: 'My password is hunter23456' },
    { kind: 'script', id: 'command', title: 'Run code' }] });
  assert.equal(cleaned.offer, true); assert.equal(cleaned.status, 'offered');
  assert.equal(cleaned.extra, undefined);
  assert.equal(cardOf({ ...source, lines: ['Coverage: ' + 'x'.repeat(500)] }).lines[0].length, 510);
  assert.equal(cleaned.items.find((item) => item.id === 'page-1').url, 'https://school.example/assignments/1');
  assert.ok(cleaned.items.filter((item) => ['evil', 'feed', 'auth', 'token'].includes(item.id)).every((item) => !item.url && !item.action));
  assert.equal(cleaned.items.some((item) => item.id === 'secret' || item.id === 'command'), false);
  assert.equal(briefingItemsOf(Array.from({ length: 80 }, (_, index) => ({ kind: 'activity', id: String(index), title: 'A'.repeat(300), detail: 'x'.repeat(5000) }))).length, 40);
  assert.equal(briefingItemsOf([{ kind: 'activity', id: 'x', title: 'A', detail: 'x'.repeat(5000) }])[0].detail.length, 3000);
});

test('archived briefing metadata survives reload and hidden lines cannot retain its details or destinations', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'jester-briefing-card-'));
  const file = path.join(folder, 'chats.json');
  try {
    const at = new Date().toISOString();
    const archive = createChatArchive({ file });
    archive.keep([{ who: 'you', text: 'Read my briefing.', at, chat: 'one' }, { who: 'jester', text: 'Your briefing is ready.', at, chat: 'one', card: brief() },
      { who: 'jester', text: 'Left out.', at, chat: 'one', hidden: true, card: brief() }]);
    const restored = createChatArchive({ file }).get('one');
    assert.deepEqual(restored.lines[1].card, cardOf(brief()));
    assert.equal(restored.lines[2].card, undefined);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
