import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchSources, sourceCardsElement, renderResearchState } from '../desktop/src/home/research.js';
import { lineElement } from '../desktop/src/home/chats.js';

function dom() {
  const document = { createElement(tag) {
    return { tag, ownerDocument: document, children: [], attributes: {}, dataset: {}, listeners: {},
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      set innerHTML(_) { assert.fail('page content must remain text'); }
    };
  } };
  return document;
}
const sources = (count) => Array.from({ length: count }, (_, index) => ({ url: `https://www.source${index}.example/page`, title: `Source ${index}`, fetchedAt: '2026-11-16T21:00:00Z' }));
const elements = (node) => [node, ...node.children.flatMap(elements)];
const buttons = (node) => elements(node).filter((item) => item.tag === 'button');

test('up to three sources show cards with explicit Open buttons and never open themselves', async () => {
  const document = dom();
  const opened = [];
  const section = sourceCardsElement(sources(3), { document, open: async (url) => { opened.push(url); return { ok: true }; } });
  assert.equal(section.tag, 'div');
  assert.equal(section.children[0].textContent, 'Sources');
  assert.equal(section.children[1].children.length, 3);
  assert.deepEqual(opened, []);
  const [button] = buttons(section);
  assert.equal(button.textContent, 'Open');
  assert.equal(button.attributes['aria-label'], 'Open Source 0');
  await button.listeners.click();
  assert.deepEqual(opened, ['https://www.source0.example/page']);
  assert.equal(button.disabled, false);
  assert.equal(section.children[1].children[0].children[0].children[0].textContent, 'source0.example');
});

test('four or more source cards go inside a collapsed keyboard-accessible dropdown', () => {
  const document = dom();
  const section = sourceCardsElement(sources(4), { document });
  assert.equal(section.tag, 'details');
  assert.equal(section.open, undefined, 'native details starts collapsed');
  assert.equal(section.children[0].tag, 'summary');
  assert.equal(section.children[0].textContent, '4 sources');
  assert.equal(section.children[1].children.length, 4);
  assert.equal(buttons(section).length, 4);
});

test('invalid source schemes, credentials and duplicates are removed; scraped markup remains literal', () => {
  const document = dom();
  const title = '<img src=x onerror=alert(1)>';
  const values = [
    { url: 'javascript:alert(1)' }, { url: 'file:///private/secret' }, { url: 'https://user:password@example.com' },
    { url: 'https://example.com/', title }, { url: 'https://example.com/', title: 'duplicate' }, { url: 'https://x.example/' + 'x'.repeat(5000) }
  ];
  assert.equal(researchSources(values).length, 1);
  const section = sourceCardsElement(values, { document });
  assert.equal(section.children[1].children[0].children[0].children[1].textContent, title);
  assert.equal(sourceCardsElement([], { document }), null);
  assert.equal(sourceCardsElement(null, { document }), null);
  assert.equal(researchSources(sources(40)).length, 24);
});

test('Open delegates only a validated URL to the desktop and contains failures for retry', async () => {
  const document = dom();
  const requests = [];
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async (request) => { requests.push(request); return { ok: false }; } } };
  try {
    const section = sourceCardsElement(sources(1), { document });
    await buttons(section)[0].listeners.click();
    assert.deepEqual(requests, [{ type: 'jester/research', op: 'open', url: 'https://www.source0.example/page' }]);
    assert.equal(buttons(section)[0].disabled, false);
    const error = section.children[1].children[0].children[0].children[2];
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /Try again/);
  } finally { globalThis.chrome = previous; }
});

test('source cards attach to the corresponding Jester line and hidden text cannot expose sources', () => {
  const document = dom();
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    const answer = lineElement({ who: 'jester', text: 'The answer.', sources: sources(2) });
    assert.equal(answer.textContent, 'The answer.');
    assert.equal(answer.children[0].children[1].children.length, 2);
    assert.deepEqual(lineElement({ who: 'jester', text: 'Left out.', hidden: true, sources: sources(2) }).children, []);
    assert.deepEqual(lineElement({ who: 'you', text: 'A request.', sources: sources(2) }).children, []);
  } finally { globalThis.document = previous; }
});

test('research progress has visible text, an explicit Stop control and clears on every inactive state', async () => {
  const document = dom();
  const container = document.createElement('div');
  let stopped = 0;
  const stop = async () => { stopped++; };
  renderResearchState(container, { active: true, phase: 'reading', label: 'Reading a source in the background' }, document, stop);
  assert.equal(container.hidden, false);
  assert.equal(container.children[1].children[0].textContent, 'Searching the internet');
  assert.equal(container.children[1].children[1].textContent, 'Reading a source in the background');
  assert.equal(buttons(container)[0].textContent, 'Stop');
  await buttons(container)[0].listeners.click();
  assert.equal(stopped, 1);
  const first = container.children[0];
  renderResearchState(container, { active: true, label: 'Reading a source in the background' }, document, stop);
  assert.equal(container.children[0], first, 'an identical update does not reannounce or rebuild');
  for (const phase of ['done', 'cancelled', 'error']) {
    renderResearchState(container, { active: true }, document, stop);
    renderResearchState(container, { active: false, phase }, document, stop);
    assert.equal(container.hidden, true);
    assert.deepEqual(container.children, []);
  }
});

test('the progress strip is available across screens and initializes from desktop state as well as live events', async () => {
  const html = await readFile(new URL('../desktop/src/home/home.html', import.meta.url), 'utf8');
  const code = await readFile(new URL('../desktop/src/home/home.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../desktop/src/home/home.css', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="research-progress"') < html.indexOf('id="screens"'));
  assert.match(html, /id="research-progress"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(code, /case 'jester\/research-state':[\s\S]*?drawResearch\(message\.research\)/);
  assert.match(code, /Object\.hasOwn\(desktop, 'research'\)\) drawResearch\(desktop\.research\)/);
  assert.match(css, /body\.researching \.screen > \.top/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('the search UI exposes the model score and updates it even when the progress text stays the same', () => {
  const document = dom();
  const container = document.createElement('div');
  renderResearchState(container, { active: true, phase: 'routing', label: 'Choosing how to search' }, document);
  assert.equal(container.children[1].children[0].textContent, 'Planning your search');
  renderResearchState(container, { active: true, label: 'Reading sources', scrapeConfidence: 85, strategyReason: 'Public source text is available.' }, document);
  let badge = container.children.find((node) => node.className === 'research-confidence');
  assert.equal(badge.textContent, '85/100');
  assert.match(badge.attributes['aria-label'], /Scraping confidence: 85\/100/);
  renderResearchState(container, { active: true, label: 'Reading sources', scrapeConfidence: 73 }, document);
  badge = container.children.find((node) => node.className === 'research-confidence');
  assert.equal(badge.textContent, '73/100');
  renderResearchState(container, { active: false, phase: 'clarifying' }, document);
  assert.equal(container.hidden, true);
});
