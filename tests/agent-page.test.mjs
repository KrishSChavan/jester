import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../jester-extension/src/content/agent-page.js', import.meta.url), 'utf8');

// A small DOM fixture supplies browser primitives; all extraction, identity,
// budgeting, validation and permission logic runs from the production script.
function browser(script = source) {
  let doc;
  const metrics = { styles: 0, rects: 0, queries: 0 };
  class Text {
    constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null; }
    get textContent() { return this.nodeValue; }
  }
  class Element {
    constructor(tag, attributes = {}) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attributes = new Map(Object.entries(attributes));
      this.childNodes = [];
      this.parentElement = null;
      this.style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
      this.rect = { left: 10, top: 10, width: 200, height: 35, right: 210, bottom: 45 };
      this.events = [];
      this.clientHeight = 600; this.clientWidth = 900; this.scrollHeight = 600;
      this.disabled = false; this.readOnly = false;
      this._value = attributes.value || '';
      this.scrolls = [];
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : this.tagName === 'BUTTON' ? 'submit' : ''); }
    get hidden() { return this.hasAttribute('hidden'); }
    get inert() { return this.hasAttribute('inert'); }
    get isContentEditable() { return this.getAttribute('contenteditable') === 'true' || this.getAttribute('contenteditable') === ''; }
    get isConnected() { return this === doc?.documentElement || !!this.parentElement?.isConnected; }
    get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
    set textContent(value) { this.childNodes = []; this.append(new Text(String(value))); }
    get form() { return this.closest('form'); }
    get options() { return this.querySelectorAll('option'); }
    get selected() { return this.parentElement?._value === this._value; }
    get labels() { return doc.querySelectorAll('label').filter((label) => label.getAttribute('for') === this.id && this.id); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    append(...nodes) {
      for (let node of nodes) {
        if (typeof node === 'string') node = new Text(node);
        if (node.parentElement) node.remove();
        node.parentElement = this; this.childNodes.push(node);
      }
      return this;
    }
    remove() {
      if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
      this.parentElement = null;
    }
    matches(selector) {
      return selector.split(',').some((part) => {
        const item = part.trim();
        const tag = item.match(/^[a-z][a-z0-9]*/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const attrs = [...item.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
        return attrs.every(([, key, value]) => value === undefined ? this.hasAttribute(key) : this.getAttribute(key) === value);
      });
    }
    closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
    contains(node) { for (let el = node; el; el = el.parentElement) if (el === this) return true; return false; }
    querySelectorAll(selector) {
      metrics.queries++;
      const result = [];
      const visit = (el) => {
        for (const child of el.childNodes) if (child.nodeType === 1) { if (child.matches(selector)) result.push(child); visit(child); }
      };
      visit(this); return result;
    }
    getBoundingClientRect() { metrics.rects++; return this.rect; }
    getClientRects() { return this.fragments || [this.rect]; }
    scrollIntoView() {}
    scrollBy(args) { this.scrolls.push(args); }
    scrollTo(args) { this.scrolls.push(args); }
    focus() { doc.activeElement = this; }
    dispatchEvent(event) { this.events.push(event.type); this.onEvent?.(event); return !event.defaultPrevented; }
    click() { this.clicked = (this.clicked || 0) + 1; if (this.type === 'checkbox') this.checked = !this.checked; this.events.push('click'); this.onClick?.(); }
    requestSubmit() { this.submitted = (this.submitted || 0) + 1; }
  }
  class Input extends Element {
    constructor(attributes) { super('input', attributes); }
    get value() { return this._value; }
    set value(value) { this.nativeSets = (this.nativeSets || 0) + 1; this._value = String(value); }
    select() { this.selection = [0, this._value.length]; }
    setSelectionRange(start, end) { this.selection = [start, end]; }
  }
  class TextArea extends Input { constructor(attributes) { super(attributes); this.tagName = 'TEXTAREA'; } }
  class Select extends Element { constructor(attributes) { super('select', attributes); } }
  class BrowserEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
  }
  const html = new Element('html');
  const body = new Element('body');
  doc = { documentElement: html, body, title: 'Watch Rick & Morty', activeElement: body, scrollingElement: body,
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) { return html.querySelectorAll(selector); },
    getElementById(id) { return [html, ...html.querySelectorAll('[id]')].find((el) => el.id === id) || null; }
  };
  html.append(body);
  const location = { href: 'https://watch.example/shows?token=private-token&query=rick' };
  // Window listeners, so a test can deliver the trusted mousemove a real (debugger) pointer makes.
  const listeners = new Map();
  const windowEvents = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }
  };
  const trustedMove = (x, y) => { for (const fn of listeners.get('mousemove') || []) fn({ type: 'mousemove', isTrusted: true, clientX: x, clientY: y }); };
  const context = vm.createContext({ ...windowEvents, document: doc, location, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: (el) => { metrics.styles++; return el.style; }, URL, Math, setTimeout, clearTimeout,
    Event: BrowserEvent, MouseEvent: BrowserEvent, PointerEvent: BrowserEvent, KeyboardEvent: BrowserEvent,
    HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select
  });
  vm.runInContext(script, context);
  function el(tag, attrs = {}, text = '') {
    const node = tag === 'input' ? new Input(attrs) : tag === 'textarea' ? new TextArea(attrs) : tag === 'select' ? new Select(attrs) : new Element(tag, attrs);
    if (text) node.append(text);
    return node;
  }
  return { api: context.__jesterAgentPage, doc, body, location, el, metrics, trustedMove, listeners };
}

function idFor(state, name) {
  return state.elements.find((entry) => entry.name === name)?.id;
}

test('semantic observation retains episode context and excludes hidden, draft, secret and overlay content', () => {
  const { api, body, el } = browser();
  const article = el('article', {}, 'Rick & Morty Season 3 Episode 1 ');
  article.append(el('button', { type: 'button' }, 'Play'));
  const hidden = el('p', { hidden: '' }, 'private hidden answer');
  const caption = el('p', {}, 'Visible story '); caption.append(hidden);
  body.append(article, caption, el('input', { type: 'password', value: 'secret123', placeholder: 'Password' }),
    el('textarea', { 'aria-label': 'Draft note', value: 'do not send this draft' }),
    el('div', { id: 'jester-voice-host' }, 'Assistant internal transcript'),
    el('p', {}, 'api_key=sk-private-key-12345678912345'));
  const result = api.observe({ goal: 'Rick & Morty season 3 episode 1' });
  assert.match(result.text, /Rick & Morty Season 3 Episode 1/);
  assert.ok(result.elements.find((entry) => entry.name === 'Play').context.includes('Episode 1'));
  assert.doesNotMatch(JSON.stringify(result), /private hidden answer|secret123|do not send this draft|Assistant internal transcript|private-token|sk-private-key/);
  assert.match(result.url, /query=rick/);
});

test('IDs are stable across observations and reject changed, detached and navigated targets', async () => {
  const { api, body, el, location } = browser();
  const button = el('button', { type: 'button' }, 'Play episode 1'); body.append(button);
  const first = api.observe();
  const id = idFor(first, 'Play episode 1');
  assert.equal(idFor(api.observe(), 'Play episode 1'), id);
  button.textContent = 'Buy episode 1';
  assert.match((await api.execute({ action: 'click', elementId: id, pageId: first.pageId })).detail, /STALE_ELEMENT/);
  assert.equal(button.clicked, undefined);
  const second = api.observe();
  const secondId = idFor(second, 'Buy episode 1');
  assert.notEqual(secondId, id);
  button.remove();
  assert.match((await api.execute({ action: 'click', elementId: secondId })).detail, /STALE_ELEMENT/);
  body.append(button);
  const beforeRoute = api.observe();
  location.href = 'https://watch.example/new-show';
  assert.match((await api.execute({ action: 'click', elementId: idFor(beforeRoute, 'Buy episode 1'), pageId: beforeRoute.pageId })).detail, /STALE_PAGE/);
});

test('serialized page state has a hard character and element budget', () => {
  const { api, body, el } = browser();
  for (let i = 0; i < 260; i++) body.append(el('button', { type: 'button' }, `Episode ${i} ` + 'a'.repeat(500)));
  const state = api.observe({ maxChars: 12000, maxElements: 1000 });
  assert.ok(JSON.stringify(state).length <= 12000);
  assert.ok(state.elements.length <= 100);
  assert.ok(state.elements.every((entry) => entry.name.length <= 300));
  assert.equal(state.truncated, true);
  assert.ok(JSON.stringify(api.observe({ maxChars: 700 })).length <= 700);
});

test('visible dialogs take precedence; retrieval finds offscreen content without clicking', async () => {
  const { api, body, el } = browser();
  const outside = el('button', { type: 'button' }, 'Background account');
  const dialog = el('dialog', { open: '' });
  const season = el('button', { type: 'button' }, 'Season 3');
  const offscreen = el('button', { type: 'button' }, 'Episode 11');
  offscreen.rect = { left: 0, top: 1800, width: 100, height: 30, right: 100, bottom: 1830 };
  dialog.append(season, offscreen); body.append(outside, dialog);
  const state = api.observe();
  assert.ok(idFor(state, 'Season 3'));
  assert.equal(idFor(state, 'Background account'), undefined);
  assert.equal(idFor(state, 'Episode 11'), undefined);
  const found = await api.execute({ action: 'find_text', query: 'Episode 11' });
  assert.ok(idFor(found, 'Episode 11'));
  assert.equal(found.elements.find((entry) => entry.name === 'Episode 11').offscreen, true);
  assert.equal(offscreen.clicked, undefined);
});

test('locally classified purchases require confirmation; ask applies to normal actions', async () => {
  const { api, body, el } = browser();
  const play = el('button', { type: 'button' }, 'Play');
  const purchase = el('a', { href: '/checkout?episode=1' }, 'Buy episode');
  body.append(play, purchase);
  const state = api.observe();
  const action = { action: 'click', elementId: idFor(state, 'Buy episode'), pageId: state.pageId };
  assert.equal(api.classify(action).category, 'sensitive');
  assert.equal((await api.execute(action)).needsConfirmation, true);
  assert.equal(purchase.clicked, undefined);
  assert.equal((await api.execute(action, { boundary: 'entertainment', approved: true })).ok, true);
  assert.equal(purchase.clicked, 1);
  const normal = { action: 'click', elementId: idFor(state, 'Play') };
  assert.equal((await api.execute(normal, { boundary: 'ask' })).needsConfirmation, true);
  assert.equal((await api.execute(normal)).ok, true);
  assert.equal(play.clicked, 1);
});

test('type uses native controlled-input setter; select uses exact option and key submits search once', async () => {
  const { api, body, el } = browser();
  const form = el('form', { 'aria-label': 'Search titles' });
  const input = el('input', { type: 'search', 'aria-label': 'Search titles' });
  Object.defineProperty(input, 'value', { get() { return this._value; }, set() { throw new Error('framework own setter must not be used'); } });
  const select = el('select', { 'aria-label': 'Season' });
  select.append(el('option', { value: 's1' }, 'Season 1'), el('option', { value: 's3' }, 'Season 3'));
  form.append(input); body.append(form, select);
  const state = api.observe();
  const type = await api.execute({ action: 'type', elementId: idFor(state, 'Search titles'), text: 'Rick & Morty' });
  assert.equal(type.ok, true, type.detail);
  assert.equal(input.value, 'Rick & Morty');
  assert.equal(input.nativeSets, 1);
  assert.ok(input.events.includes('input'));
  assert.equal((await api.execute({ action: 'press_key', elementId: idFor(state, 'Search titles'), key: 'Enter' })).ok, true);
  assert.equal(form.submitted, 1);
  assert.equal((await api.execute({ action: 'select', elementId: idFor(state, 'Season'), value: 's3' })).ok, true);
  assert.equal(select.value, 's3');
  assert.equal((await api.execute({ action: 'select', elementId: idFor(state, 'Season'), value: 'Season' })).ok, false);
});

test('strict action validation rejects unexpected properties, scripts and unsupported inputs', async () => {
  const { api, body, el } = browser();
  const button = el('button', { type: 'button' }, 'Play'); body.append(button);
  const id = idFor(api.observe(), 'Play');
  assert.equal((await api.execute({ action: 'click', elementId: id, approved: true })).ok, false);
  assert.equal((await api.execute({ action: 'evaluate', code: 'alert(1)' })).ok, false);
  assert.equal((await api.execute({ action: 'scroll', direction: 'down', amount: 1000 })).ok, false);
  assert.equal((await api.execute({ action: 'press_key', key: 'F12' })).ok, false);
  assert.equal((await api.execute({ action: 'click', elementId: id }, { boundary: 'unknown' })).ok, false);
  assert.equal(button.clicked, undefined);
});

test('a dialog opened after observation prevents background clicks', async () => {
  const { api, body, el } = browser();
  const button = el('button', { type: 'button' }, 'Play'); body.append(button);
  const state = api.observe();
  const dialog = el('dialog', { open: '' }); dialog.append(el('button', { type: 'button' }, 'Continue'));
  body.append(dialog);
  const result = await api.execute({ action: 'click', elementId: idFor(state, 'Play') });
  assert.match(result.detail, /active dialog/);
  assert.equal(button.clicked, undefined);
});

test('cursor targeting skips extension overlays, resolves nested controls and toggles exact video', async () => {
  const { api, body, el, doc } = browser();
  const button = el('button', { type: 'button' }, 'Play episode');
  const inner = el('span', {}, ' 1'); button.append(inner);
  const overlay = el('div', { id: 'jester-cursor-host' });
  const video = el('video', { 'aria-label': 'Current video' });
  video.paused = true;
  video.play = async () => { video.paused = false; video.played = (video.played || 0) + 1; };
  video.pause = () => { video.paused = true; };
  body.append(button, overlay, video);
  doc.elementsFromPoint = () => [overlay, inner, button];
  const target = api.targetAtPoint(40, 40);
  assert.equal(target.ok, true);
  assert.match(target.label, /Play episode/);
  assert.equal((await api.execute({ action: 'click', elementId: target.elementId, pageId: target.pageId })).ok, true);
  assert.equal(button.clicked, 1);
  doc.elementsFromPoint = () => [video];
  const mediaTarget = api.targetAtPoint(40, 40);
  assert.equal(mediaTarget.kind, 'video');
  assert.equal((await api.execute({ action: 'click', elementId: mediaTarget.elementId })).ok, true);
  assert.equal(video.played, 1);
  assert.equal(video.paused, false);
  assert.equal(api.targetAtPoint(-1, 0).ok, false);
});

test('form discovery omits values of unrelated fields and keyboard editing still requires approval', async () => {
  const { api, body, el } = browser();
  const note = el('input', { 'aria-label': 'Public comment', value: 'private draft' });
  const secret = el('input', { 'aria-label': 'API key', value: 'another-secret' });
  body.append(note, secret);
  const fields = await api.execute({ action: 'get_form_fields' });
  assert.equal(fields.elements.length, 1);
  assert.doesNotMatch(JSON.stringify(fields), /private draft|another-secret/);
  note.focus();
  const result = await api.execute({ action: 'press_key', key: 'x' });
  assert.equal(result.needsConfirmation, true);
  assert.equal(note.value, 'private draft');
});

test('table retrieval returns bounded row context on demand', async () => {
  const { api, body, el } = browser();
  const table = el('table');
  for (let n = 0; n < 40; n++) {
    const row = el('tr'); row.append(el('td', {}, `Episode ${n}`), el('td', {}, 'Available')); table.append(row);
  }
  body.append(table);
  const state = api.observe({ goal: 'Episode 1' });
  const row = state.elements.find((entry) => entry.role === 'tr');
  const result = await api.execute({ action: 'get_table', elementId: row.id });
  assert.equal(result.ok, true);
  assert.ok(result.elements.length <= 30);
  assert.match(result.text, /Available/);
  assert.ok(JSON.stringify(result).length <= 12000);
});

test('show artwork names distinguish identical play buttons in streaming cards', () => {
  const { api, body, el } = browser();
  for (const title of ['Rick & Morty', 'The Office']) {
    const card = el('div', { class: 'title-card-container' });
    card.append(el('img', { alt: title }), el('button', { type: 'button' }, 'Play')); body.append(card);
  }
  const state = api.observe({ goal: 'Rick & Morty' });
  const buttons = state.elements.filter((entry) => entry.name === 'Play');
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].context, /Rick & Morty/);
  assert.match(buttons[1].context, /The Office/);
  assert.notEqual(buttons[0].id, buttons[1].id);
});

test('poster-only title controls inherit one visible image name and keep distinct show identities', async () => {
  const { api, body, el } = browser();
  const show = el('a', { href: '/series/rick-and-morty' });
  const anime = el('button', { type: 'button' });
  show.append(el('span', {}).append(el('img', { alt: 'Rick and Morty' })));
  anime.append(el('img', { alt: 'Rick and Morty: The Anime' }));
  body.append(show, anime);
  const page = api.observe({ goal: 'play Rick and Morty season 3 episode 1' });
  const showId = idFor(page, 'Rick and Morty');
  const animeId = idFor(page, 'Rick and Morty: The Anime');
  assert.ok(showId); assert.ok(animeId); assert.notEqual(showId, animeId);
  assert.equal(api.classify({ action: 'click', elementId: showId }).label, 'Rick and Morty');
  const result = await api.execute({ action: 'click', elementId: showId }, { boundary: 'entertainment' });
  assert.equal(result.ok, true);
  assert.equal(show.clicked, 1); assert.equal(anime.clicked, undefined);
});

test('poster-name fallback excludes private images and rejects controls with multiple visible titles', () => {
  const { api, body, el } = browser();
  const show = el('a', { href: '/series/rick-and-morty' });
  show.append(el('img', { alt: 'Rick and Morty' }),
    el('img', { alt: 'hidden poster secret', hidden: '' }),
    el('img', { alt: 'aria hidden poster secret', 'aria-hidden': 'true' }),
    el('img', { alt: 'private image secret', id: 'api-key-image' }),
    el('span', { id: 'access-token-wrapper' }).append(el('img', { alt: 'private wrapper secret' })),
    el('span', { id: 'jester-private-overlay' }).append(el('img', { alt: 'overlay poster secret' })),
    el('img', { alt: '' }));
  const collage = el('a', { href: '/collection' });
  collage.append(el('img', { alt: 'Show One' }), el('img', { alt: 'Show Two' }));
  const labelled = el('button', { type: 'button', 'aria-label': 'Open details' });
  labelled.append(el('img', { alt: 'Poster title' }));
  const text = el('button', { type: 'button' }, 'Visible button name');
  text.append(el('img', { alt: 'Another poster title' }));
  body.append(el('article', {}).append(show), collage, labelled, text);
  const page = api.observe();
  assert.ok(idFor(page, 'Rick and Morty'));
  assert.ok(idFor(page, 'Open details'));
  assert.ok(idFor(page, 'Visible button name'));
  assert.equal(page.elements.some((entry) => entry.role === 'link' && entry.url?.endsWith('/collection')), false);
  assert.doesNotMatch(JSON.stringify(page), /hidden poster secret|private image secret|private wrapper secret|overlay poster secret|Show One|Show Two/);
});

test('the registry evicts old live targets after its bounded lifetime', async () => {
  const { api, body, el, doc } = browser();
  let oldest;
  let newest;
  for (let n = 0; n < 1002; n++) {
    const button = el('button', { type: 'button' }, `Play episode ${n}`); body.append(button);
    doc.elementsFromPoint = () => [button];
    newest = api.targetAtPoint(20, 20);
    if (!n) oldest = newest;
  }
  assert.match((await api.execute({ action: 'click', elementId: oldest.elementId })).detail, /STALE_ELEMENT/);
  assert.equal((await api.execute({ action: 'click', elementId: newest.elementId })).ok, true);
});

test('scroll end aliases and Space key match the worker action schema', async () => {
  const { api, body } = browser();
  body.scrollHeight = 5000;
  assert.equal((await api.execute({ action: 'scroll', direction: 'bottom' })).ok, true);
  assert.equal(body.scrolls.at(-1).top, 5000);
  assert.equal((await api.execute({ action: 'scroll', direction: 'top' })).ok, true);
  assert.equal(body.scrolls.at(-1).top, 0);
  assert.equal((await api.execute({ action: 'press_key', key: 'Space' })).ok, true);
});

test('a player is observed first, even after many unrelated text blocks and controls', () => {
  const { api, body, el } = browser();
  for (let i = 0; i < 20; i += 1) body.append(el('p', {}, `Episode description ${i}`));
  for (let i = 0; i < 8; i += 1) body.append(el('button', {}, `Control ${i}`));
  const video = el('video'); video.paused = false; video.currentTime = 3; video.duration = 1320;
  body.append(video);
  const page = api.observe({ goal: 'play season 3 episode 1 of Rick and Morty' });
  assert.equal(page.elements[0].role, 'video');
  assert.equal(page.elements[0].playing, true);
});

test('observations expose playback and scroll progress while retaining media element identity', () => {
  const { api, body, el } = browser();
  const video = el('video'); video.paused = true; video.currentTime = 12; video.duration = 1200;
  body.scrollHeight = 5000; body.scrollTop = 600; body.append(video);
  const first = api.observe();
  assert.match(first.text, /paused at 12s\/1200s/);
  assert.match(first.text, /Scroll: 600\/4400px/);
  const id = first.elements.find((entry) => entry.role === 'video').id;
  video.paused = false; video.currentTime = 15; body.scrollTop = 1200;
  const next = api.observe();
  assert.match(next.text, /playing at 15s\/1200s/);
  assert.match(next.text, /Scroll: 1200\/4400px/);
  assert.equal(next.elements.find((entry) => entry.role === 'video').id, id);
  assert.ok(next.revision > first.revision);
});

test('inspect_section accepts bounded query and keeps retrieval within its registered section', async () => {
  const { api, body, el } = browser();
  const section = el('article', { 'aria-label': 'Episode list' });
  section.append(el('button', { type: 'button' }, 'Episode 1'), el('button', { type: 'button' }, 'Episode 2'));
  body.append(section, el('button', { type: 'button' }, 'Outside the section'));
  const id = idFor(api.observe(), 'Episode list');
  const result = await api.execute({ action: 'inspect_section', elementId: id, query: 'Episode 2' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Episode 2/);
  assert.doesNotMatch(result.text, /Outside the section/);
  assert.equal((await api.execute({ action: 'inspect_section', elementId: id, query: 'nothing matches' })).elements.length, 0);
  assert.equal((await api.execute({ action: 'inspect_section', elementId: id, query: 'x'.repeat(301) })).ok, false);
});

test('semantic clicks and hover cannot bypass opaque overlays appearing after scrolling', async () => {
  const { api, body, el, doc } = browser();
  const button = el('button', { type: 'button' }, 'Play episode');
  const child = el('span', {}, ' 1'); button.append(child);
  const cover = el('div', {}, 'Loading'); body.append(button, cover);
  const id = idFor(api.observe(), 'Play episode 1');
  doc.elementFromPoint = () => button;
  button.scrollIntoView = () => { doc.elementFromPoint = () => cover; };
  const result = await api.execute({ action: 'click', elementId: id });
  assert.match(result.detail, /covered by another page element/);
  assert.equal(button.clicked, undefined);
  assert.equal(button.events.length, 0);
  assert.equal((await api.execute({ action: 'hover', elementId: id })).ok, false);
  button.scrollIntoView = () => {};
  doc.elementFromPoint = () => child;
  assert.equal((await api.execute({ action: 'hover', elementId: id })).ok, true);
  assert.ok(button.events.includes('pointerover'));
  assert.equal((await api.execute({ action: 'click', elementId: id })).ok, true);
  assert.equal(button.clicked, 1);
});

test('multi-fragment links use a real client rectangle rather than empty union-box space', async () => {
  const { api, body, doc, el } = browser();
  const poster = el('a', { href: '/series/rick-and-morty', 'aria-label': 'Rick and Morty' });
  poster.rect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  poster.fragments = [
    { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 },
    { left: 0, top: 360, right: 400, bottom: 400, width: 400, height: 40 }
  ];
  body.append(poster);
  doc.elementsFromPoint = (x, y) => y < 40 || y >= 360 ? [poster, body] : [body];
  const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(result.ok, true);
  assert.equal(poster.clicked, 1);
  const pointer = poster.events.indexOf('pointerdown');
  assert.ok(pointer >= 0);
});

test('a narrow overflow-clipped card remains clickable at its visible part', async () => {
  const { api, body, doc, el } = browser();
  const viewport = el('div');
  viewport.style.overflowY = 'hidden';
  viewport.rect = { left: 0, top: 180, right: 400, bottom: 190, width: 400, height: 10 };
  const poster = el('a', { href: '/series/rick-and-morty', 'aria-label': 'Rick and Morty' });
  poster.rect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  viewport.append(poster); body.append(viewport);
  doc.elementsFromPoint = (x, y) => y >= 180 && y < 190 ? [poster, viewport, body] : [body];
  const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(result.ok, true);
  assert.equal(poster.clicked, 1);
});

test('a bounded descendant hit surface can activate its original observed link', async () => {
  const { api, body, doc, el } = browser();
  const poster = el('a', { href: '/series/rick-and-morty', 'aria-label': 'Rick and Morty' });
  poster.rect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  const image = el('img', { alt: 'Rick and Morty' });
  image.rect = { left: 155, top: 170, right: 175, bottom: 180, width: 20, height: 10 };
  poster.append(image); body.append(poster);
  doc.elementsFromPoint = (x, y) => x >= 155 && x < 175 && y >= 170 && y < 180 ? [image, poster, body] : [body];
  const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(result.ok, true);
  assert.equal(poster.clicked, 1);
  assert.equal(image.clicked, undefined);
});

test('covered failures include bounded geometry for a nonactionable surface without its private text or attributes', async () => {
  const { api, body, doc, el } = browser();
  const poster = el('a', { href: '/series/rick-and-morty', 'aria-label': 'Rick and Morty' });
  const cover = el('div', { id: 'private-container-123', 'aria-label': 'private-name-456', role: 'private-role-789' },
    'private-text-000 api_key=sk-secret-123456789012345');
  cover.style = { ...cover.style, pointerEvents: 'auto', position: 'fixed', zIndex: '99999' };
  cover.rect = { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
  body.append(poster, cover);
  let reads = 0;
  doc.elementsFromPoint = () => { reads++; return [cover, poster, body]; };
  const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(result.errorClass, 'covered_target');
  assert.equal(result.notDispatched, true);
  assert.ok(result.hitTest.samples <= 48);
  assert.equal(result.hitTest.target.tag, 'A');
  assert.equal(result.hitTest.hits.length, 1);
  assert.equal(result.hitTest.hits[0].tag, 'DIV');
  assert.equal(result.hitTest.hits[0].role, 'element');
  assert.equal(result.hitTest.hits[0].relation, 'unrelated');
  assert.equal(result.hitTest.hits[0].pointerEvents, 'auto');
  assert.equal(result.hitTest.hits[0].position, 'fixed');
  assert.equal(result.hitTest.hits[0].zIndex, '99999');
  assert.equal(result.hitTest.hits[0].rect.width, 1200);
  assert.ok(JSON.stringify(result.hitTest).length <= 1600);
  assert.doesNotMatch(JSON.stringify(result.hitTest), /private|api_key|sk-secret/);
  assert.ok(reads <= 144, `bounded sampling and diagnostic reads: ${reads}`);
  assert.equal(poster.clicked, undefined);
  assert.equal(cover.clicked, undefined);
  assert.deepEqual(poster.events, []);
  cover.tagName = 'PRIVATE-CUSTOM-ELEMENT-123';
  const customCover = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(customCover.hitTest.hits[0].tag, 'ELEMENT');
  assert.doesNotMatch(JSON.stringify(customCover.hitTest), /PRIVATE|private/);
});

test('a poster replaced on hover is not clicked and a fresh observation can target its replacement', async () => {
  const { api, body, el, doc } = browser();
  const original = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
  const replacement = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
  const card = el('article'); card.append(original); body.append(card);
  doc.elementsFromPoint = () => [original.isConnected ? original : replacement];
  original.onEvent = (event) => {
    if (event.type === 'pointerover') { original.remove(); card.append(replacement); }
  };
  const first = api.observe();
  const originalId = idFor(first, 'Rick and Morty');
  const interrupted = await api.execute({ action: 'click', elementId: originalId, pageId: first.pageId });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.errorClass, 'stale_target');
  assert.equal(interrupted.notDispatched, true);
  assert.equal(interrupted.uncertain, undefined);
  assert.deepEqual(original.events, ['pointerover']);
  assert.equal(original.clicked, undefined);
  assert.equal(replacement.clicked, undefined);
  const refreshed = api.observe();
  const replacementId = idFor(refreshed, 'Rick and Morty');
  assert.notEqual(replacementId, originalId);
  assert.equal((await api.execute({ action: 'click', elementId: replacementId, pageId: refreshed.pageId })).ok, true);
  assert.equal(replacement.clicked, 1);
});

test('a covering page panel appearing on hover stops the press without bypassing the panel', async () => {
  const { api, body, el, doc } = browser();
  const poster = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
  const cover = el('div', {}, 'Expanded title panel'); body.append(poster, cover);
  let covered = false;
  doc.elementsFromPoint = () => [covered ? cover : poster];
  poster.onEvent = (event) => { if (event.type === 'pointerover') covered = true; };
  const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'covered_target');
  assert.equal(result.notDispatched, true);
  assert.equal(result.uncertain, undefined);
  assert.equal(poster.clicked, undefined);
  assert.equal(cover.clicked, undefined);
  assert.equal(poster.events.includes('pointerdown'), false);
});

// Hulu's instant search lays one of these over its results while the keyboard
// drives the list and removes it, a microtask later, on the next mouse move.
function mouseBlocker(el) {
  const blocker = el('div', { role: 'none' });
  blocker.style = { ...blocker.style, position: 'fixed', zIndex: '200', pointerEvents: 'auto',
    backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' };
  blocker.rect = { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
  return blocker;
}

test('an empty unpainted layer gets the mouse move that removes it, then the observed result is clicked', async () => {
  const { api, body, el, doc } = browser();
  const result = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
  const blocker = mouseBlocker(el);
  blocker.onEvent = (event) => { if (event.type === 'mousemove') Promise.resolve().then(() => blocker.remove()); };
  body.append(result, blocker);
  doc.elementsFromPoint = () => blocker.isConnected ? [blocker, result, body] : [result, body];
  const page = api.observe();
  const outcome = await api.execute({ action: 'click', elementId: idFor(page, 'Rick and Morty'), pageId: page.pageId });
  assert.equal(outcome.ok, true, outcome.detail);
  assert.equal(result.clicked, 1);
  assert.deepEqual(blocker.events, ['pointerover', 'mouseover', 'pointermove', 'mousemove']);
  assert.equal(blocker.clicked, undefined);
});

test('a layer that stays, a replaced target, or a cover the user can see or use still stops the press', async () => {
  for (const kind of ['stays', 'replaced', 'painted', 'content', 'control']) {
    const { api, body, el, doc } = browser();
    const result = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
    const replacement = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
    const cover = kind === 'control' ? el('button', { type: 'button' }) : kind === 'content' ? el('div', {}, 'Loading') : mouseBlocker(el);
    cover.style = { ...mouseBlocker(el).style, ...(kind === 'painted' ? { backgroundColor: 'rgb(0, 0, 0)' } : {}) };
    if (kind === 'replaced') cover.onEvent = (event) => {
      if (event.type === 'mousemove') { cover.remove(); result.remove(); body.append(replacement); }
    };
    body.append(result, cover);
    doc.elementsFromPoint = () => [cover, result, replacement].filter((node) => node.isConnected).concat(body);
    const outcome = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
    assert.equal(outcome.errorClass, kind === 'replaced' ? 'stale_target' : 'covered_target', kind);
    assert.equal(outcome.notDispatched, true, kind);
    assert.equal(result.clicked, undefined, kind);
    assert.equal(replacement.clicked, undefined, kind);
    assert.deepEqual(result.events, [], kind);
    assert.equal(cover.clicked, undefined, kind);
    assert.deepEqual(cover.events, ['stays', 'replaced'].includes(kind) ? ['pointerover', 'mouseover', 'pointermove', 'mousemove'] : [], kind);
  }
});

test('real input aims without dispatching and lands only once a trusted move proves the target is under the pointer', async () => {
  const { api, body, el, doc, trustedMove, listeners } = browser();
  const result = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
  body.append(result);
  doc.elementsFromPoint = () => [result, body];
  const page = api.observe();
  const action = { action: 'click', elementId: idFor(page, 'Rick and Morty'), pageId: page.pageId };
  const aimed = api.input('aim', action, { boundary: 'entertainment' });
  assert.equal(aimed.ok, true, aimed.detail);
  assert.ok(Number.isFinite(aimed.x) && Number.isFinite(aimed.y));
  assert.equal(aimed.label, 'Rick and Morty');
  assert.equal(api.input('land', action, { boundary: 'entertainment' }).unseen, true, 'No press without a trusted move');
  trustedMove(aimed.x + 9, aimed.y);
  assert.equal(api.input('land', action, { boundary: 'entertainment' }).misaligned, true, 'The pointer is somewhere else');
  trustedMove(aimed.x, aimed.y);
  const landed = api.input('land', action, { boundary: 'entertainment' });
  assert.deepEqual([landed.ok, landed.x, landed.y], [true, aimed.x, aimed.y]);
  assert.equal(api.input('done', action).ok, true);
  assert.equal(listeners.get('mousemove').size, 0, 'Pointer tracking ends with the gesture');
  assert.deepEqual(result.events, [], 'The page dispatches nothing itself; the debugger mouse does');
  assert.equal(result.clicked, undefined);
});

test('real input aims through a layer that the real move dismisses, and reports a cover that stays', async () => {
  for (const kind of ['dismissed', 'stays']) {
    const { api, body, el, doc, trustedMove } = browser();
    const result = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
    const cover = kind === 'dismissed' ? mouseBlocker(el) : el('div', {}, 'Expanded title panel');
    body.append(result, cover);
    doc.elementsFromPoint = () => [cover, result, body].filter((node) => node.isConnected);
    const page = api.observe();
    const action = { action: 'click', elementId: idFor(page, 'Rick and Morty'), pageId: page.pageId };
    const aimed = api.input('aim', action, { boundary: 'entertainment' });
    assert.equal(aimed.ok, true, kind);
    if (kind === 'dismissed') cover.remove();
    trustedMove(aimed.x, aimed.y);
    const landed = api.input('land', action, { boundary: 'entertainment' });
    if (kind === 'dismissed') assert.equal(landed.ok, true);
    else {
      assert.equal(landed.errorClass, 'covered_target');
      assert.equal(landed.notDispatched, true);
      assert.equal(landed.hitTest.hits[0].tag, 'DIV');
    }
    assert.deepEqual(cover.events, [], `${kind}: the page sends no synthetic move to the cover`);
  }
});

test('real input respects approval, hands own overlays and native pickers back, and readies fields without secrets', async () => {
  const { api, body, el, doc, trustedMove } = browser();
  const buy = el('a', { href: '/checkout?episode=1' }, 'Buy episode');
  const season = el('select', { 'aria-label': 'Season' });
  season.append(el('option', { value: '1' }, 'Season 1'));
  const search = el('input', { type: 'search', 'aria-label': 'Search titles', value: 'old query' });
  const password = el('input', { type: 'password', 'aria-label': 'Password' });
  const pill = el('div', { id: 'jester-voice-host' });
  body.append(buy, season, search, password, pill);
  const page = api.observe();
  const buyAction = { action: 'click', elementId: idFor(page, 'Buy episode') };
  assert.equal(api.input('aim', buyAction, { boundary: 'entertainment' }).needsConfirmation, true);
  doc.elementsFromPoint = () => [pill, buy, body];
  const approved = api.input('aim', buyAction, { boundary: 'entertainment', approved: true });
  assert.equal(approved.ok, true);
  trustedMove(approved.x, approved.y);
  assert.equal(api.input('land', buyAction, { boundary: 'entertainment', approved: true }).native, false,
    'A real press would land on Jester\'s pill; the scripted path reaches the target');
  assert.equal(api.input('aim', { action: 'click', elementId: idFor(page, 'Season') }, {}).native, false);
  const typing = api.input('ready', { action: 'type', elementId: idFor(page, 'Search titles'), text: 'rick and morty' }, {});
  assert.equal(typing.ok, true, typing.detail);
  assert.equal(doc.activeElement, search);
  assert.deepEqual(search.selection, [0, 'old query'.length], 'Real text replaces what is selected');
  assert.equal(search.value, 'old query', 'Readying a field never writes into it');
  assert.equal(api.observe().elements.some((entry) => entry.name === 'Password'), false,
    'A password field never gets an ID, so real typing cannot be aimed at it');
  doc.activeElement = body;
  assert.equal(api.input('ready', { action: 'press_key', key: 'Enter', elementId: idFor(page, 'Search titles') }, {}).ok, true);
  assert.equal(doc.activeElement, search, 'Real keys go to the focused field');
});

test('screenshot labels number every clickable control, unnamed icons included, and hide Jester\'s own overlays', async () => {
  const { api, body, el, doc } = browser();
  const play = el('button', { type: 'button' }, 'Play');
  const icon = el('button', { type: 'button', class: 'icon-only' });
  icon.rect = { left: 300, top: 10, width: 40, height: 40, right: 340, bottom: 50 };
  const hidden = el('button', { type: 'button', hidden: '' }, 'Hidden control');
  const covered = el('a', { href: '/behind' }, 'Behind a panel');
  covered.rect = { left: 10, top: 400, width: 200, height: 35, right: 210, bottom: 435 };
  const panel = el('div', {}, 'Panel');
  const pill = el('div', { id: 'jester-voice-host' });
  body.append(play, icon, hidden, covered, panel, pill);
  doc.elementsFromPoint = (x, y) => y >= 400 && y < 435 ? [panel, covered, body] : [x >= 300 ? icon : play, body];
  assert.equal(api.observe().elements.some((entry) => entry.name === '(unnamed)'), false, 'The text list skips unnamed icons');
  const pillVisibility = pill.style.visibility;
  const shown = api.marks('show');
  assert.equal(shown.ok, true, shown.detail);
  assert.deepEqual(Array.from(shown.legend, (entry) => [entry.n, entry.role, entry.name]), [[1, 'button', 'Play'], [2, 'button', '(unnamed)']],
    'Hidden and covered controls get no label');
  const host = doc.getElementById('jester-marks');
  assert.ok(host, 'Labels are drawn in Jester\'s own overlay');
  assert.equal(pill.style.visibility, 'hidden', 'Jester\'s pill stays out of the picture');
  assert.equal(api.observe().elements.some((entry) => /^\d+$/.test(entry.name)), false, 'Observation ignores the labels');
  const iconId = shown.legend[1].id;
  doc.elementsFromPoint = () => [icon, body];
  assert.equal((await api.execute({ action: 'click', elementId: iconId })).ok, true, 'A legend ID is a live target');
  assert.equal(icon.clicked, 1);
  assert.equal(api.marks('hide').ok, true);
  assert.equal(doc.getElementById('jester-marks'), null);
  assert.equal(pill.style.visibility, pillVisibility, 'The pill comes back as it was');
});

test('no screenshot is labelled while a password or payment field is on screen', () => {
  const { api, body, el } = browser();
  body.append(el('button', { type: 'button' }, 'Play'), el('input', { type: 'password', 'aria-label': 'Password' }));
  const refused = api.marks('show');
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /password or payment field/);
});

test('a covered poster reports only the visible blocking control with a bounded semantic identity', async () => {
  const { api, body, el, doc } = browser();
  const card = el('article', { class: 'title-card' });
  const poster = el('a', { href: '/series/rick-and-morty?token=private' }, 'Rick and Morty');
  const details = el('a', { href: '/series/rick-and-morty?token=private', 'aria-label': 'View details' });
  const icon = el('span', {}, 'Open'); details.append(icon); card.append(poster, details); body.append(card);
  doc.elementsFromPoint = () => [icon, details, poster];
  const page = api.observe();
  const result = await api.execute({ action: 'click', elementId: idFor(page, 'Rick and Morty'), pageId: page.pageId });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'covered_target');
  assert.equal(result.notDispatched, true);
  assert.equal(result.pageId, page.pageId);
  assert.equal(result.blockingElements.length, 1);
  assert.equal(result.blockingElements[0].id, idFor(page, 'View details'));
  assert.equal(result.blockingElements[0].role, 'link');
  assert.equal(result.blockingElements[0].name, 'View details');
  assert.match(result.blockingElements[0].context, /Rick and Morty/);
  assert.equal(result.blockingElements[0].url, 'https://watch.example/series/rick-and-morty');
  assert.equal(result.blockingElements[0].sameDestination, true);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.ok(JSON.stringify(result.blockingElements).length <= 1400);
  assert.equal(poster.clicked, undefined);
  assert.equal(details.clicked, undefined);
  assert.equal(details.events.length, 0);
});

test('matching redacted URLs do not prove the same destination when secret query values differ', async () => {
  const { api, body, el, doc } = browser();
  const poster = el('a', { href: '/series/rick-and-morty?token=original-secret' }, 'Rick and Morty');
  const details = el('a', { href: '/series/rick-and-morty?token=different-secret', 'aria-label': 'View details' });
  body.append(poster, details);
  doc.elementsFromPoint = () => [details, poster];
  const page = api.observe();
  const result = await api.execute({ action: 'click', elementId: idFor(page, 'Rick and Morty') });
  assert.equal(result.blockingElements[0].url, page.elements.find((entry) => entry.name === 'Rick and Morty').url);
  assert.equal(result.blockingElements[0].sameDestination, false);
  assert.doesNotMatch(JSON.stringify(result), /original-secret|different-secret/);
  assert.equal(poster.clicked, undefined);
  assert.equal(details.clicked, undefined);
});

test('blocker evidence never looks through an opaque or private panel to an underlying control', async () => {
  for (const panel of ['opaque', 'private', 'outside-dialog']) {
    const { api, body, el, doc } = browser();
    const poster = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
    const details = el('a', { href: '/series/rick-and-morty', 'aria-label': 'View details' });
    const cover = panel === 'opaque' ? el('div', {}, 'Loading')
      : el('button', { type: 'button', ...(panel === 'private' ? { 'aria-label': 'API key secret' } : {}) }, 'Covered control');
    body.append(poster, details, cover);
    if (panel === 'outside-dialog') {
      const dialog = el('dialog', { open: '' }); dialog.append(poster); body.append(dialog);
    }
    doc.elementsFromPoint = () => [cover, details, poster];
    const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
    assert.equal(result.errorClass, 'covered_target', panel);
    assert.equal(result.notDispatched, true, panel);
    assert.equal(result.blockingElements, undefined, panel);
    assert.equal(poster.clicked, undefined, panel);
    assert.equal(details.clicked, undefined, panel);
    assert.equal(cover.clicked, undefined, panel);
  }
});

test('hover cannot carry an old approval through a changed identity or newly active dialog', async () => {
  for (const change of ['identity', 'dialog']) {
    const { api, body, el, doc } = browser();
    const poster = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty'); body.append(poster);
    doc.elementsFromPoint = () => [poster];
    poster.onEvent = (event) => {
      if (event.type !== 'pointerover') return;
      if (change === 'identity') { poster.textContent = 'Buy series'; poster.setAttribute('href', '/checkout'); }
      else body.append(el('dialog', { open: '' }).append(el('button', { type: 'button' }, 'Confirm')));
    };
    const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') }, { approved: true });
    assert.equal(result.ok, false, change);
    assert.equal(result.errorClass, 'stale_target', change);
    assert.equal(result.notDispatched, true, change);
    assert.equal(poster.clicked, undefined, change);
    assert.equal(poster.events.includes('pointerdown'), false, change);
  }
});

test('a replacement after a dispatched press is reported uncertain without a detached native click', async () => {
  for (const phase of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup']) {
    const { api, body, el, doc } = browser();
    const original = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty');
    const replacement = el('a', { href: '/series/rick-and-morty' }, 'Rick and Morty'); body.append(original);
    doc.elementsFromPoint = () => [original.isConnected ? original : replacement];
    const replace = () => { original.remove(); body.append(replacement); };
    original.onEvent = (event) => { if (event.type === phase) replace(); };
    if (phase === 'focus') original.focus = replace;
    const result = await api.execute({ action: 'click', elementId: idFor(api.observe(), 'Rick and Morty') });
    assert.equal(result.ok, false, phase);
    assert.equal(result.errorClass, 'stale_target', phase);
    assert.equal(result.notDispatched, false, phase);
    assert.equal(result.uncertain, true, phase);
    assert.equal(original.clicked, undefined, phase);
    assert.equal(replacement.clicked, undefined, phase);
  }
});

test('Enter and submit classification expose form navigation and invalidate changed destinations', () => {
  const { api, body, el, doc } = browser();
  const form = el('form', { action: 'https://elsewhere.example/search', 'aria-label': 'Search titles' });
  const input = el('input', { type: 'search', 'aria-label': 'Search titles' });
  const submit = el('button', {}, 'Search'); form.append(input, submit); body.append(form);
  const state = api.observe();
  const inputId = idFor(state, 'Search titles');
  const submitId = idFor(state, 'Search');
  assert.equal(api.classify({ action: 'press_key', key: 'Enter', elementId: inputId }).url, 'https://elsewhere.example/search');
  assert.equal(api.classify({ action: 'click', elementId: submitId }).url, 'https://elsewhere.example/search');
  submit.setAttribute('formaction', 'https://payments.example/order');
  assert.match(api.classify({ action: 'press_key', key: 'Enter', elementId: inputId }).detail, /STALE_ELEMENT/);
  const refreshed = api.observe();
  assert.equal(api.classify({ action: 'press_key', key: 'Enter', elementId: idFor(refreshed, 'Search titles') }).url, 'https://payments.example/order');
  submit.attributes.delete('formaction'); form.setAttribute('action', '/search');
  doc.baseURI = 'https://base.example/';
  const based = api.observe();
  assert.equal(api.classify({ action: 'click', elementId: idFor(based, 'Search') }).url, 'https://base.example/search');
});

test('implicit keyboard classification binds the original field despite later focus changes', async () => {
  const { api, body, el, doc } = browser();
  const first = el('input', { type: 'search', 'aria-label': 'Search titles' });
  const second = el('input', { 'aria-label': 'Public comment' }); body.append(first, second);
  first.focus();
  const classification = api.classify({ action: 'press_key', key: 'x' });
  assert.equal(classification.ok, true);
  assert.ok(classification.elementId);
  second.focus();
  const result = await api.execute({ action: 'press_key', key: 'x', elementId: classification.elementId, pageId: classification.pageId }, { approved: true });
  assert.equal(result.ok, true);
  assert.equal(first.value, 'x');
  assert.equal(second.value, '');
  assert.equal(doc.activeElement, first);
});

test('global keys bind the active dialog when body focus lies behind it', async () => {
  const { api, body, el, doc } = browser();
  const dialog = el('dialog', { open: '', 'aria-label': 'Choose a season' });
  dialog.append(el('button', { type: 'button' }, 'Season 3')); body.append(dialog);
  doc.activeElement = body;
  const target = api.classify({ action: 'press_key', key: 'Escape' });
  assert.equal(target.ok, true);
  assert.equal(target.label, 'Choose a season');
  const result = await api.execute({ action: 'press_key', key: 'Escape', elementId: target.elementId, pageId: target.pageId });
  assert.equal(result.ok, true);
  assert.ok(dialog.events.includes('keydown'));
  assert.equal(body.events.length, 0);
});

test('large page observations share layout reads and retain the exact episode inside a smaller budget', () => {
  const { api, body, el, metrics } = browser();
  const cards = 120;
  for (let n = 0; n < cards; n++) {
    const card = el('article', { class: 'episode-card' });
    const outer = el('div'), inner = el('div');
    inner.append(el('h3', {}, 'Rick & Morty'), el('p', {}, `Season 3 Episode ${n}`),
      el('button', { type: 'button' }, `Play episode ${n}`));
    outer.append(inner); card.append(outer); body.append(card);
  }
  const state = api.observe({ goal: 'Rick & Morty Season 3 Episode 1', maxChars: 5000, maxElements: 40 });
  assert.equal(state.elements[0].name, 'Play episode 1');
  assert.ok(JSON.stringify(state).length <= 5000);
  assert.ok(state.elements.length <= 40);
  // Deterministic operation ceilings replace a timing assertion that depends on
  // the machine. This fixture has 720 elements plus body/html; each is styled
  // and measured at most once during this synchronous observation.
  assert.ok(metrics.styles <= cards * 6 + 2, `style reads: ${metrics.styles}`);
  assert.ok(metrics.rects <= cards * 6 + 2, `bounds reads: ${metrics.rects}`);
  assert.ok(metrics.queries <= cards * 6 + 10, `DOM queries: ${metrics.queries}`);
  assert.ok(state.metrics?.cacheHits > cards);
  assert.equal(state.metrics.styleReads, metrics.styles);
  assert.doesNotMatch(state.text, /cacheHits|styleReads|elapsedMs/);
});

test('snapshot caches end before actions and are rebuilt after hidden/name/context changes', () => {
  const { api, body, el } = browser();
  const card = el('article', {}, 'Season 3 Episode 1 ');
  const button = el('button', { type: 'button' }, 'Play'); card.append(button); body.append(card);
  const first = api.observe();
  const oldId = idFor(first, 'Play');
  button.textContent = 'Buy episode';
  assert.match(api.classify({ action: 'click', elementId: oldId }).detail, /STALE_ELEMENT/);
  const changed = api.observe();
  assert.ok(idFor(changed, 'Buy episode'));
  assert.equal(api.classify({ action: 'click', elementId: idFor(changed, 'Buy episode') }).category, 'sensitive');
  card.style.display = 'none';
  assert.equal(api.observe().elements.length, 0);
  card.style.display = 'block';
  card.childNodes[0].nodeValue = 'Season 3 Episode 2 ';
  const refreshed = api.observe();
  assert.match(refreshed.elements.find((entry) => entry.name === 'Buy episode').context, /Episode 2/);
  assert.notEqual(idFor(refreshed, 'Buy episode'), idFor(changed, 'Buy episode'));
});

test('video clock ticks preserve semantic revision but playback changes remain observable', () => {
  const { api, body, el } = browser();
  const video = el('video'); video.paused = false; video.currentTime = 12; video.duration = 1200; body.append(video);
  const first = api.observe();
  video.currentTime = 13;
  const tick = api.observe();
  assert.notEqual(tick.text, first.text);
  assert.equal(tick.revision, first.revision);
  video.paused = true;
  assert.ok(api.observe().revision > tick.revision);
});

test('viewport observation rejects long offscreen lists before style/text extraction', async () => {
  const { api, body, el, metrics } = browser();
  body.append(el('button', { type: 'button' }, 'Search titles'));
  for (let n = 0; n < 400; n++) {
    const button = el('button', { type: 'button' }, `Episode ${n}`);
    button.rect = { left: 0, top: 1800 + n * 40, width: 100, height: 30, right: 100, bottom: 1830 + n * 40 };
    body.append(button);
  }
  const state = api.observe({ maxChars: 5000, maxElements: 40 });
  assert.deepEqual(state.elements.map((entry) => entry.name).join(','), 'Search titles');
  assert.ok(metrics.styles <= 3);
  const found = await api.execute({ action: 'find_elements', query: 'Episode 399' });
  assert.ok(found.elements.some((entry) => entry.name === 'Episode 399' && entry.offscreen));
});

test('season controls expose actual aria selection and expansion state', () => {
  const { api, body, el } = browser();
  const first = el('button', { role: 'tab', 'aria-selected': 'false' }, 'Season 1');
  const third = el('button', { role: 'tab', 'aria-selected': 'true' }, 'Season 3');
  const menu = el('button', { 'aria-expanded': 'true' }, 'Season 3 menu');
  body.append(first, third, menu);
  const state = api.observe();
  assert.equal(state.elements.find((entry) => entry.name === 'Season 1').selected, false);
  assert.equal(state.elements.find((entry) => entry.name === 'Season 3').selected, true);
  assert.equal(state.elements.find((entry) => entry.name === 'Season 3 menu').expanded, true);
  assert.match(state.text, /selected=true/);
  menu.setAttribute('aria-expanded', 'false');
  assert.equal(api.observe().elements.find((entry) => entry.name === 'Season 3 menu').expanded, false);
});

test('a goal’s function words match nothing: "go to" no longer ranks History above the results', () => {
  const { api, body, el } = browser();
  const main = el('main');
  main.append(el('a', { href: '/watch?v=1' }, 'Explore the city'), el('a', { href: '/feed/history' }, 'History'));
  body.append(main);
  const state = api.observe({ goal: "go to MrBeast's latest video" });
  assert.deepEqual([...state.elements.map((entry) => entry.name)], ['Explore the city', 'History']);
});

test('the site’s navigation ranks below the page’s own results; search and goal matches keep their rank', () => {
  const { api, body, el } = browser();
  const banner = el('div', { role: 'banner' });
  banner.append(el('button', {}, 'Settings'), el('input', { 'aria-label': 'Search' }));
  const guide = el('div', { role: 'navigation' });
  for (let i = 0; i < 30; i++) guide.append(el('a', { href: `/feed/${i}` }, `Guide ${i}`));
  guide.append(el('a', { href: '/feed/subscriptions' }, 'Subscriptions'));
  const main = el('div', { role: 'main' });
  for (let i = 0; i < 8; i++) main.append(el('a', { href: `/watch?v=${i}` }, `Video ${i}`));
  const article = el('article');
  const cardHeader = el('header');
  cardHeader.append(el('a', { href: '/watch?v=card' }, 'Card title'));
  article.append(cardHeader); main.append(article);
  body.append(banner, guide, main);
  const state = api.observe({ goal: 'open my subscriptions', maxElements: 12 });
  const names = state.elements.map((entry) => entry.name);
  assert.equal(names[0], 'Subscriptions', 'A navigation link the goal names is not demoted');
  for (const name of ['Search', 'Card title', ...Array.from({ length: 8 }, (_, i) => `Video ${i}`)]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('Guide 29'));
  assert.ok(names.indexOf('Settings') > names.indexOf('Video 7'), 'Banner controls follow the content');
});

test('a control nested in a same-named link is reported once, as the link', () => {
  const { api, body, el } = browser();
  const link = el('a', { href: '/' });
  link.append(el('div', { role: 'link', tabindex: '0' }, 'Home'));
  const wrapper = el('li', { tabindex: '0' });
  wrapper.append(el('a', { href: '/shorts' }, 'Shorts'));
  body.append(link, wrapper);
  const state = api.observe();
  assert.deepEqual([...state.elements.filter((entry) => entry.name === 'Home').map((entry) => entry.role)], ['link']);
  // A wrapper that is not itself a real control never hides the link inside it.
  assert.ok(state.elements.some((entry) => entry.name === 'Shorts' && entry.role === 'link' && entry.url));
});

test('document order among controls is reported on request; ranked lists keep their ranking', () => {
  const { api, body, el } = browser();
  body.append(el('h2', {}, 'Videos'), el('a', { href: '/watch?v=a' }, 'First upload'),
    el('a', { href: '/watch?v=b' }, 'Latest video recap'));
  const ordered = api.observe({ goal: 'latest video', order: true });
  assert.equal(ordered.elements[0].name, 'Latest video recap', 'Still ranked by the goal');
  const order = Object.fromEntries(ordered.elements.map((entry) => [entry.name, entry.order]));
  assert.ok(order['First upload'] < order['Latest video recap']);
  assert.equal(order.Videos, undefined, 'Only controls are counted');
  assert.ok(api.observe({ goal: 'latest video' }).elements.every((entry) => entry.order === undefined));
});

test('route() names the current page and changes when the address does', () => {
  const { api, location } = browser();
  const first = api.observe();
  assert.equal(api.route(), first.pageId);
  location.href = 'https://watch.example/results?search_query=next';
  const moved = api.route();
  assert.notEqual(moved, first.pageId);
  assert.equal(api.observe().pageId, moved);
});
