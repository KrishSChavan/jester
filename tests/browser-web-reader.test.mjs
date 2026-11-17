import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBrowserWebReader, parseWebHtml, readInTab, webReadAddress, WEB_READER_LIMITS } from '../jester-extension/src/background/web-reader.js';

const at = Date.UTC(2026, 10, 16, 12);
const html = '<html><head><title>Live &amp; useful</title><script>password=do-not-send</script></head><body><main><h1>Today</h1><p>Tickets cost $12.</p><a href="/details">Details</a><a href="javascript:alert(1)">bad</a><input value="private"><textarea>secret field</textarea></main></body></html>';
const response = (body, options = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...options });

function setup(tabs = [], result = {}) {
  const calls = [];
  const chrome = {
    tabs: { query: async (query = {}) => tabs.filter((tab) => (query.active === undefined || tab.active === query.active) && (!query.lastFocusedWindow || tab.lastFocusedWindow === true)), update: async () => assert.fail('must not focus or navigate a tab'), create: async () => assert.fail('must not create a tab') },
    windows: { update: async () => assert.fail('must not focus a window') },
    scripting: { executeScript: async (options) => { calls.push(options); return [{ result: { ok: true, url: options.args[0].url, text: 'Assignment due Friday.', links: [], mode: 'open-tab', fetchedAt: new Date(at).toISOString(), ...result } }]; } },
    permissions: { contains: async () => true }
  };
  return { chrome, calls };
}

test('public address validation rejects private literals, secrets, unsafe schemes and account action URLs', () => {
  for (const url of ['file:///etc/passwd', 'data:text/html,abc', 'https://user:pass@example.com/', 'http://localhost/a', 'http://x.local/a', 'http://192.168.1.1/', 'http://2130706433/', 'http://[::1]/', 'https://example.com/logout', 'https://example.com/a?action=delete', 'https://example.com/?access_token=secret']) {
    assert.equal(webReadAddress(url), null, url);
  }
  assert.equal(webReadAddress('https://canvas.example.edu/courses/20/assignments').href, 'https://canvas.example.edu/courses/20/assignments');
});

test('public HTML extraction removes executable and form content while retaining bounded text and source links', () => {
  const got = parseWebHtml(html, 'https://example.com/live', { fetchedAt: new Date(at).toISOString() });
  assert.equal(got.ok, true);
  assert.equal(got.title, 'Live & useful');
  assert.match(got.text, /Tickets cost \$12/);
  assert.doesNotMatch(got.text, /do-not-send|secret field|private/);
  assert.deepEqual(got.links, [{ url: 'https://example.com/details', text: 'Details' }]);
  assert.equal(got.fetchedAt, new Date(at).toISOString());
  const big = parseWebHtml(`<p>${'x'.repeat(30000)}</p>`, 'https://example.com/');
  assert.equal(big.text.length, WEB_READER_LIMITS.text);
  assert.equal(big.truncated, true);
});

test('JavaScript shells and verification pages cannot become successful research evidence', () => {
  const shell = parseWebHtml('<title>Canvas</title><div id="root"></div><script src="/app.js"></script><noscript>You need to enable JavaScript to run this app.</noscript>', 'https://canvas.example.edu/courses/20');
  assert.equal(shell.ok, false);
  assert.equal(shell.code, 'needs_rendering');
  const blocked = parseWebHtml('<title>Just a moment...</title><p>Checking your browser before continuing.</p>', 'https://example.com/');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'browser_needed');
  assert.equal(parseWebHtml('<title>Brief</title><div id="root"><p>Price today: $12.</p></div><script src="/analytics.js"></script>', 'https://example.com/').ok, true);
});

test('DuckDuckGo HTML search returns actual source URLs and snippets rather than redirectors', () => {
  const source = `<title>Search</title><div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsource.example%2Fnew%3Fa%3D1%26b%3D2&amp;rut=abc"><b>Useful</b> result</a></h2><a class="result__snippet">Price is &pound;20 <b>today</b></a></div>
  <div><a class='result__a' href='https://second.example/'>Second &amp; result</a><div class='result__snippet'>Another source.</div></div>`;
  const got = parseWebHtml(source, 'https://html.duckduckgo.com/html/?q=test', { search: true });
  assert.equal(got.ok, true);
  assert.deepEqual(got.results.map((entry) => entry.url), ['https://source.example/new?a=1&b=2', 'https://second.example/']);
  assert.equal(got.results[0].title, 'Useful result');
  assert.match(got.results[0].snippet, /today/);
  assert.equal(got.results[1].snippet, 'Another source.');
  assert.equal(parseWebHtml('<title>Challenge</title><p>Please prove you are human.</p>', 'https://html.duckduckgo.com/', { search: true }).code, 'search_unavailable');
});

test('existing signed-in pages are read in their isolated world without browser mutations or anonymous fallback', async () => {
  const { chrome, calls } = setup([{ id: 1, title: 'Canvas', url: 'https://canvas.example.edu/courses/20' }], { links: [{ url: 'javascript:void(0)', text: 'bad' }, { url: 'https://canvas.example.edu/courses/20/assignments', text: 'Assignments' }] });
  const reader = createBrowserWebReader({ chrome, fetch: () => assert.fail('a signed-in tab must be read through its own session'), now: () => at });
  assert.equal(await reader.canReadOpen('https://canvas.example.edu/courses/20/assignments'), true);
  const got = await reader({ op: 'scrape', url: 'https://canvas.example.edu/courses/20', signedIn: true });
  assert.equal(got.text, 'Assignment due Friday.');
  assert.equal(got.links.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].world, 'ISOLATED');
  assert.equal(calls[0].func, readInTab);
  assert.deepEqual(calls[0].target, { tabId: 1, frameIds: [0] });
});

test('matching exact page wins over another tab on the same signed-in origin', async () => {
  const { chrome, calls } = setup([{ id: 1, url: 'https://canvas.example.edu/' }, { id: 2, url: 'https://canvas.example.edu/courses/20' }]);
  await createBrowserWebReader({ chrome })({ op: 'scrape', url: 'https://canvas.example.edu/courses/20', signedIn: true });
  assert.equal(calls[0].target.tabId, 2);
});

test('public research never goes through an open tab of the same site, with its sign-in', async () => {
  const { chrome, calls } = setup([{ id: 1, title: 'Reddit', url: 'https://www.reddit.com/r/laptops' }]);
  let fetched = 0;
  const reader = createBrowserWebReader({ chrome, fetch: async () => { fetched += 1; throw new Error('offline'); } });
  await reader({ op: 'scrape', url: 'https://www.reddit.com/r/laptops' });
  assert.equal(calls.length, 0, 'no script in the signed-in tab');
  assert.equal(fetched, 1, 'read anonymously instead');
});

test('tabs inventory is bounded and includes only public page metadata', async () => {
  const tabs = [{ id: 0, url: 'chrome://settings', title: 'Settings' }, { id: 1, url: 'https://example.com/', title: 'one', discarded: true, secret: 'not returned' }, ...Array.from({ length: 50 }, (_, i) => ({ id: i + 2, url: `https://example.com/${i}`, title: `Page ${i}` }))];
  const { chrome } = setup(tabs);
  const got = await createBrowserWebReader({ chrome, now: () => at })({ op: 'tabs' });
  assert.equal(got.tabs.length, WEB_READER_LIMITS.tabs);
  assert.equal(got.truncated, true);
  assert.deepEqual(got.tabs[0], { id: 1, url: 'https://example.com/', title: 'one', active: false, current: false });
  assert.equal(got.fetchedAt, new Date(at).toISOString());
});

test('tab inventory identifies the last-focused window’s active page without changing focus', async () => {
  const { chrome } = setup([
    { id: 1, windowId: 1, url: 'https://other.example/', title: 'Other window', active: true },
    { id: 2, windowId: 2, url: 'https://canvas.example.edu/', title: 'Canvas', active: false, lastFocusedWindow: true },
    { id: 3, windowId: 2, url: 'https://article.example/', title: 'This page', active: true, lastFocusedWindow: true }
  ]);
  const got = await createBrowserWebReader({ chrome })({ op: 'tabs' });
  assert.deepEqual(got.tabs.map(({ id, active, current, windowId }) => ({ id, active, current, windowId })), [
    { id: 3, active: true, current: true, windowId: 2 },
    { id: 1, active: true, current: false, windowId: 1 },
    { id: 2, active: false, current: false, windowId: 2 }
  ]);
});

test('the current page survives a truncated tab inventory', async () => {
  const tabs = Array.from({ length: WEB_READER_LIMITS.tabs + 5 }, (_, i) => ({ id: i, url: `https://example.com/${i}` }));
  tabs.at(-1).active = true;
  tabs.at(-1).lastFocusedWindow = true;
  const { chrome } = setup(tabs);
  const got = await createBrowserWebReader({ chrome })({ op: 'tabs' });
  assert.equal(got.tabs.length, WEB_READER_LIMITS.tabs);
  assert.equal(got.tabs[0].id, tabs.at(-1).id);
  assert.equal(got.tabs[0].current, true);
});

test('standalone public fetch is anonymous, fresh, GET only, and refuses redirects', async () => {
  const { chrome } = setup();
  const calls = [];
  const reader = createBrowserWebReader({ chrome, now: () => at, fetch: async (...args) => { calls.push(args); return response(html); } });
  assert.equal((await reader.request({ op: 'scrape', url: 'https://example.com/live' })).ok, true);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal((await reader({ op: 'scrape', url: 'http://127.0.0.1/' })).code, 'invalid_url');
  assert.equal(calls.length, 1);
});

test('standalone search fetches bounded HTML without opening a results tab', async () => {
  const { chrome } = setup();
  let fetched;
  const reader = createBrowserWebReader({ chrome, fetch: async (url) => { fetched = url; return response('<a class="result__a" href="https://result.example/">Found it</a><a class="result__snippet">A live result.</a>'); } });
  const got = await reader({ op: 'search', query: 'current test' });
  assert.match(fetched, /html.duckduckgo.com\/html\/\?q=current%20test/);
  assert.equal(got.results[0].url, 'https://result.example/');
});

test('openOnly never falls through to public fetching', async () => {
  const { chrome } = setup();
  const reader = createBrowserWebReader({ chrome, fetch: () => assert.fail('openOnly must not fetch') });
  assert.equal((await reader({ op: 'scrape', url: 'https://example.com/', openOnly: true })).code, 'no_open_tab');
});

test('missing site permission reports setup rather than requesting permissions without a gesture', async () => {
  const { chrome } = setup();
  chrome.permissions.contains = async () => false;
  const got = await createBrowserWebReader({ chrome, fetch: () => assert.fail('permission missing') })({ op: 'search', query: 'find something' });
  assert.equal(got.code, 'permission_required');
  assert.match(got.detail, /site access/);
});

test('cancelled requests stop public fetch and do not return stale content', async () => {
  const { chrome } = setup();
  const controller = new AbortController();
  let fetched;
  const reader = createBrowserWebReader({ chrome, fetch: async (url, { signal }) => { fetched = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))); } });
  const pending = reader({ op: 'scrape', url: 'https://example.com/' }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetched.aborted, true);
});

test('oversized public responses are refused before they reach the model', async () => {
  const { chrome } = setup();
  const reader = createBrowserWebReader({ chrome, fetch: async () => response('x', { headers: { 'content-type': 'text/html', 'content-length': String(WEB_READER_LIMITS.bytes + 1) } }) });
  assert.equal((await reader({ op: 'scrape', url: 'https://example.com/' })).code, 'page_too_large');
});

test('in-tab fetch uses only its own origin and session, and treats redirects as interaction-needed', async () => {
  const calls = [];
  const context = vm.createContext({ URL, Date, AbortController, setTimeout, clearTimeout, location: { origin: 'https://canvas.example.edu', href: 'https://canvas.example.edu/courses' }, document: {}, fetch: async (...args) => { calls.push(args); throw new TypeError('redirect refused'); } });
  const run = vm.runInContext(`(${readInTab.toString()})`, context);
  const other = await run({ url: 'https://evil.example/path' }, WEB_READER_LIMITS);
  assert.equal(other.code, 'tab_changed');
  assert.equal(calls.length, 0);
  const got = await run({ url: 'https://canvas.example.edu/courses/20' }, WEB_READER_LIMITS);
  assert.equal(got.code, 'browser_needed');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'include');
  assert.equal(calls[0][1].redirect, 'error');
});

// A DOM small enough to exercise the actual injected function with mutations
// restricted to cloned nodes, rather than merely mocking executeScript's reply.
class DomNode {
  constructor(tag, attributes = {}, ...children) {
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this.parent = null;
    this.append(...children);
  }
  append(...children) {
    for (const child of children) {
      const node = typeof child === 'string' ? { tagName: '#TEXT', textContent: child, cloneNode: () => ({ tagName: '#TEXT', textContent: child }) } : child;
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(...children) {
    const previous = this.children;
    this.children = [];
    this.append(...children, ...previous);
  }
  get textContent() { return this.children.map((child) => child.textContent).join(''); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  cloneNode() { return new DomNode(this.tagName, { ...this.attributes }, ...this.children.map((child) => child.cloneNode(true))); }
  matches(selector) {
    const tag = /^[\w]+/.exec(selector)?.[0];
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    const attribute = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(selector);
    if (attribute && (!(attribute[1] in this.attributes) || (attribute[2] !== undefined && this.attributes[attribute[1]] !== attribute[2]))) return false;
    return !!tag || !!attribute;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',');
    const result = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.matches && selectors.some((item) => child.matches(item))) result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
}
const element = (...args) => new DomNode(...args);
function fixtureDocument(body, title = 'Canvas course') {
  return { body, title, querySelector: (selector) => body.querySelectorAll(selector)[0] || null };
}
function injected(document, extra = {}) {
  return vm.runInContext(`(${readInTab.toString()})`, vm.createContext({ URL, Date, AbortController, TextDecoder, setTimeout, clearTimeout,
    location: { origin: 'https://canvas.example.edu', href: 'https://canvas.example.edu/courses/20' }, document, ...extra }));
}

test('actual isolated read extracts rendered assignments, redacts secrets, and leaves the live DOM unchanged', async () => {
  const body = element('body', {},
    element('div', {}, 'Math homework due Friday'), element('p', {}, 'Bring your notebook.'),
    element('input', { value: 'private password' }), element('textarea', {}, 'private draft'),
    element('script', {}, 'private script'), element('div', { hidden: '' }, 'hidden token'),
    element('p', {}, 'api_key=123456789012345678901234'),
    element('a', { href: '/courses/20/assignments/5' }, 'Math homework'));
  const before = body.textContent;
  const run = injected(fixtureDocument(body));
  const got = await run({ url: 'https://canvas.example.edu/courses/20' }, WEB_READER_LIMITS);
  assert.equal(got.ok, true);
  assert.equal(got.mode, 'open-tab');
  assert.match(got.text, /Math homework due Friday\nBring your notebook\./);
  assert.match(got.text, /\[redacted\]/);
  assert.doesNotMatch(got.text, /private|hidden token|123456789/);
  assert.equal(got.links[0].url, 'https://canvas.example.edu/courses/20/assignments/5');
  assert.equal(body.textContent, before);
  assert.equal(body.querySelectorAll('script').length, 1);
});

test('actual signed-in follow-up read rejects a Canvas shell instead of claiming it read coursework', async () => {
  const shell = '<title>Canvas</title><div id="root"></div><script src="/app.js"></script><noscript>Enable JavaScript</noscript><img src="https://tracker.example/pixel">';
  let parsed;
  const run = injected(fixtureDocument(element('body', {}, 'Current course')), {
    fetch: async () => response(shell),
    DOMParser: class { parseFromString(html) { parsed = html; return fixtureDocument(element('body', {}, element('div', {}, 'Canvas')), 'Canvas'); } }
  });
  const got = await run({ url: 'https://canvas.example.edu/courses/20/assignments' }, WEB_READER_LIMITS);
  assert.equal(got.ok, false);
  assert.equal(got.code, 'needs_rendering');
  assert.doesNotMatch(parsed, /<img\b/);
});

test('actual signed-in JSON read retains task data without parsing it as page HTML', async () => {
  const run = injected(fixtureDocument(element('body', {}, 'Current course')), { fetch: async () => response('[{"name":"Math homework","due_at":"2026-11-20T17:00:00Z"}]', { headers: { 'content-type': 'application/json' } }) });
  const got = await run({ url: 'https://canvas.example.edu/api/v1/courses/20/assignments' }, WEB_READER_LIMITS);
  assert.equal(got.ok, true);
  assert.equal(got.mode, 'signed-in-fetch');
  assert.match(got.text, /Math homework/);
  assert.match(got.text, /2026-11-20/);
});

test('a search keeps no ads, and each result keeps its own snippet', () => {
  const html = `<title>Search</title>
  <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&u3=https%3A%2F%2Fwww.bing.com%2Faclick">Shop</a><a class="result__snippet">50% off everything</a></div>
  <div class="result results_links web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage">Real</a><a class="result__snippet">The real answer.</a></div>
  <div class="result results_links web-result"><a class="result__a" href="https://second.example/">Second</a></div>`;
  const got = parseWebHtml(html, 'https://html.duckduckgo.com/html/?q=x', { search: true });
  assert.deepEqual(got.results.map(({ url, snippet }) => [url, snippet]), [['https://real.example/page', 'The real answer.'], ['https://second.example/', '']]);
});
