import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTools, blankTab, publicAddress, tabMatches } from '../jester-extension/src/background/browser-tools.js';
import { siteNamed, spokenAddress, siteOf, siteSearch, showsAddress } from '../jester-extension/src/common/sites.js';

function event() {
  const listeners = new Set();
  return { listeners, addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => { for (const fn of [...listeners]) fn(...args); } };
}

/** A small Chrome: tabs in windows, loads that complete a moment later, and the read APIs. */
function fakeChrome(initial = [], extra = {}) {
  let nextId = 100;
  const tabs = initial.map((tab, index) => ({ windowId: 1, index, active: false, title: '', lastAccessed: index, ...tab }));
  const calls = [];
  const onUpdated = event();
  const onCreated = event();
  const complete = (tabId, sync = false) => sync ? onUpdated.fire(tabId, { status: 'complete' })
    : setTimeout(() => onUpdated.fire(tabId, { status: 'complete' }), 5);
  const groups = [...(extra.groups || [])];
  const chrome = {
    calls, tabsList: tabs, groupsList: groups,
    tabs: {
      onUpdated, onCreated,
      query: async (info = {}) => tabs.filter((tab) => (info.active === undefined || tab.active === info.active) &&
        (info.windowId === undefined || tab.windowId === info.windowId)).map((tab) => ({ ...tab })),
      get: async (id) => { const tab = tabs.find((entry) => entry.id === id); if (!tab) throw new Error('No tab'); return { ...tab }; },
      update: async (id, patch) => {
        calls.push(['update', id, patch]);
        const tab = tabs.find((entry) => entry.id === id);
        if (patch.active) for (const other of tabs) if (other.windowId === tab.windowId) other.active = other.id === id;
        if (patch.url) { tab.url = patch.url; tab.title = new URL(patch.url).hostname; complete(id); }
        if (patch.muted !== undefined) tab.mutedInfo = { muted: patch.muted };
        if (patch.pinned !== undefined) tab.pinned = patch.pinned;
        return { ...tab };
      },
      create: async (props) => {
        const tab = { id: nextId++, windowId: props.windowId ?? 1, index: props.index ?? tabs.length, url: props.url || 'chrome://newtab/',
          title: props.url ? new URL(props.url).hostname : 'New Tab', active: props.active !== false };
        if (tab.active) for (const other of tabs) if (other.windowId === tab.windowId) other.active = false;
        tabs.push(tab); calls.push(['create', props]); onCreated.fire({ ...tab });
        // A cached page can finish before create() even returns.
        complete(tab.id, extra.instantLoads);
        return { ...tab };
      },
      remove: async (ids) => {
        calls.push(['remove', ids]);
        for (const id of [].concat(ids)) tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
        const left = tabs.filter((tab) => tab.windowId === 1);
        if (left.length && !left.some((tab) => tab.active)) left.at(-1).active = true;
      },
      duplicate: async (id) => { const source = tabs.find((tab) => tab.id === id); return chrome.tabs.create({ url: source.url, windowId: source.windowId }); },
      move: async (id, props) => { calls.push(['move', id, props]); },
      goBack: async (id) => { calls.push(['back', id]); if (extra.noHistory) throw new Error('Cannot go back'); },
      goForward: async (id) => { calls.push(['forward', id]); },
      reload: async (id) => { calls.push(['reload', id]); complete(id); },
      group: async (props) => { calls.push(['group', props]); return props.groupId ?? 9; },
      ungroup: async (ids) => { calls.push(['ungroup', ids]); }
    },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      update: async (id, patch) => { calls.push(['focus-window', id, patch]); },
      create: async (props) => { calls.push(['window', props]); const tab = await chrome.tabs.create({ url: props.url, windowId: 2 }); return { id: 2, tabs: [tab] }; }
    },
    sessions: { restore: async () => { if (!extra.closed) throw new Error('Nothing'); const tab = await chrome.tabs.create({ url: extra.closed }); return { tab }; } },
    tabGroups: { query: async () => groups.map((group) => ({ ...group })), update: async (id, patch) => { calls.push(['group-update', id, patch]); } },
    history: { search: async (query) => { calls.push(['history', query]); return extra.history || []; } },
    bookmarks: {
      search: async (query) => typeof query === 'object' ? (extra.bookmarked || []) : (extra.bookmarks || []),
      getChildren: async () => extra.children || [],
      create: async (props) => { calls.push(['bookmark', props]); return props; }
    },
    ...(extra.noSearch ? {} : { search: { query: async (info) => {
      calls.push(['search', info]);
      if (info.tabId) { tabs.find((tab) => tab.id === info.tabId).url = 'https://www.google.com/search?q=x'; complete(info.tabId); }
      else await chrome.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(info.text)}`, windowId: 1 });
    } } })
  };
  return chrome;
}
const tools = (chrome) => createBrowserTools({ api: () => chrome, now: () => Date.UTC(2026, 9, 20, 12) });

test('spoken site names, domains and addresses resolve to the most specific listed site', () => {
  assert.equal(siteNamed('Gmail').url, 'https://mail.google.com/');
  assert.equal(siteNamed('my calendar').key, 'google calendar');
  assert.equal(siteNamed('Disney+').key, 'disney plus');
  assert.equal(siteNamed('the YouTube website').key, 'youtube');
  assert.equal(siteNamed('my bank'), null);
  assert.equal(spokenAddress('amazon dot com slash deals'), 'https://amazon.com/deals');
  assert.equal(spokenAddress('en.wikipedia.org/wiki/Moon'), 'https://en.wikipedia.org/wiki/Moon');
  assert.equal(spokenAddress('MrBeast'), null);
  assert.equal(siteOf('https://www.google.com/maps/place/x').key, 'google maps');
  assert.equal(siteOf('https://www.google.com/search?q=x').key, 'google');
  assert.equal(siteOf('https://docs.google.com/spreadsheets/d/1').key, 'google sheets');
  assert.equal(siteSearch(siteNamed('amazon'), 'usb c hub'), 'https://www.amazon.com/s?k=usb%20c%20hub');
  assert.equal(siteSearch(siteNamed('hulu'), 'x'), null);
  // "Open YouTube" is any YouTube page; a specific page is only that page.
  assert.equal(showsAddress('https://www.youtube.com/watch?v=1', 'https://www.youtube.com/'), true);
  assert.equal(showsAddress('https://www.google.com/maps', 'https://www.google.com/'), false);
  assert.equal(showsAddress('https://example.com/a/', 'https://example.com/a'), true);
  assert.equal(showsAddress('https://example.com/b', 'https://example.com/a'), false);
  assert.equal(showsAddress('chrome://newtab/', 'https://example.com/'), false);
});

test('open switches to a tab already on that site, in any window, before opening anything', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox', active: true },
    { id: 2, windowId: 2, url: 'https://www.youtube.com/watch?v=1', title: 'Music - YouTube', lastAccessed: 50 }]);
  const result = await tools(chrome).run({ action: 'browser', op: 'open', url: 'https://www.youtube.com/' }, { tabId: 1 });
  assert.deepEqual(result, { ok: true, tabId: 2, detail: 'Switched to “Music - YouTube”.' });
  assert.ok(chrome.calls.some(([kind, id]) => kind === 'focus-window' && id === 2));
  assert.equal(chrome.calls.some(([kind]) => kind === 'create'), false);
  const already = await tools(chrome).run({ action: 'browser', op: 'open', url: 'https://mail.google.com/' }, { tabId: 1 });
  assert.equal(already.detail, 'Already on “Inbox”.');
});

test('open uses a blank New Tab page in place, otherwise a new tab beside the current one, and waits for it to load', async () => {
  const blank = fakeChrome([{ id: 1, url: 'chrome://newtab/', title: 'New Tab', active: true }]);
  const here = await tools(blank).run({ action: 'browser', op: 'open', url: 'https://github.com/' }, { tabId: 1 });
  assert.deepEqual(here, { ok: true, tabId: 1, detail: 'Opened github.com.' });
  for (const instantLoads of [false, true]) {
    const chrome = fakeChrome([{ id: 1, url: 'https://news.example/', title: 'News', active: true }], { instantLoads });
    let settled = false;
    const pending = tools(chrome).run({ action: 'browser', op: 'open', url: 'https://github.com/anthropics' }, { tabId: 1 })
      .then((value) => { settled = true; return value; });
    const result = await pending;
    assert.equal(settled, true);
    assert.equal(result.detail, 'Opened github.com/anthropics.');
    assert.deepEqual(chrome.calls.find(([kind]) => kind === 'create')[1],
      { url: 'https://github.com/anthropics', active: true, windowId: 1, index: 1, openerTabId: 1 });
  }
  assert.equal(blankTab({ url: 'chrome://new-tab-page/' }), true);
  assert.equal(blankTab({ url: 'https://example.com/' }), false);
});

test('web search uses the default engine in a new tab, or in place on a blank tab, or Google without the permission', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://news.example/', title: 'News', active: true }]);
  const result = await tools(chrome).run({ action: 'browser', op: 'search', query: 'flights to Tokyo' }, { tabId: 1 });
  assert.deepEqual(chrome.calls.find(([kind]) => kind === 'search')[1], { text: 'flights to Tokyo', disposition: 'NEW_TAB' });
  assert.equal(result.tabId, 100);
  assert.equal(result.detail, 'Searched the web for “flights to Tokyo”.');
  const blank = fakeChrome([{ id: 1, url: 'chrome://newtab/', active: true }]);
  assert.equal((await tools(blank).run({ action: 'browser', op: 'search', query: 'x' }, { tabId: 1 })).tabId, 1);
  assert.deepEqual(blank.calls.find(([kind]) => kind === 'search')[1], { text: 'x', tabId: 1 });
  const plain = fakeChrome([{ id: 1, url: 'https://news.example/', active: true }], { noSearch: true });
  await tools(plain).run({ action: 'browser', op: 'search', query: 'a b' }, { tabId: 1 });
  assert.equal(plain.calls.find(([kind]) => kind === 'create')[1].url, 'https://www.google.com/search?q=a%20b');
});

test('closing the task’s own tab hands the task to the tab Chrome shows next', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://a.example/', title: 'A' }, { id: 2, url: 'https://b.example/', title: 'B', active: true },
    { id: 3, url: 'https://c.example/', title: 'C' }]);
  const one = await tools(chrome).run({ action: 'browser', op: 'close' }, { tabId: 2 });
  assert.equal(one.detail, 'Closed “B”.');
  assert.equal(one.tabId, 3);
  const many = await tools(chrome).run({ action: 'browser', op: 'close', tabIds: [1, 3] }, { tabId: 3 });
  assert.equal(many.detail, 'Closed 2 tabs.');
  assert.equal((await tools(chrome).run({ action: 'browser', op: 'close', tabIds: [1] }, { tabId: 3 })).ok, false);
});

test('the tab list marks the current tab, other windows and groups, filters by words, and hides secrets', async () => {
  const chrome = fakeChrome([
    { id: 1, url: 'https://mail.google.com/?auth=secret-value&tab=inbox', title: 'Inbox (3)', active: true },
    { id: 2, url: 'https://www.allrecipes.com/lasagna', title: 'Best Lasagna Recipe', groupId: 4, audible: true },
    { id: 3, windowId: 2, url: 'https://cooking.example/soup', title: 'Soup recipe', pinned: true }
  ], { groups: [{ id: 4, title: 'Cooking' }] });
  const all = await tools(chrome).run({ action: 'browser', op: 'tabs' }, { tabId: 1 });
  assert.deepEqual(all.tabs.map((tab) => tab.tabId), [1, 2, 3]);
  assert.equal(all.tabs[0].current, true);
  assert.equal(all.tabs[0].url, 'https://mail.google.com/?tab=inbox');
  assert.equal(all.tabs[1].group, 'Cooking');
  assert.equal(all.tabs[1].audible, true);
  assert.equal(all.tabs[2].otherWindow, true);
  const recipes = await tools(chrome).run({ action: 'browser', op: 'tabs', query: 'recipe' }, { tabId: 1 });
  assert.deepEqual(recipes.tabs.map((tab) => tab.tabId), [2, 3]);
  assert.equal(recipes.detail, '2 open tabs match “recipe”.');
  assert.equal(tabMatches({ title: 'Inbox', url: 'https://mail.google.com/' }, 'google inbox'), true);
  assert.equal(publicAddress('https://u:p@example.com/?token=1&q=2'), 'https://example.com/?q=2');
});

test('reopen, new window, duplicate and history steps hand back the tab they produced', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://a.example/', title: 'A', active: true }], { closed: 'https://closed.example/' });
  const run = (action) => tools(chrome).run({ action: 'browser', ...action }, { tabId: 1 });
  assert.equal((await run({ op: 'reopen' })).detail, 'Reopened “closed.example”.');
  assert.equal((await run({ op: 'window' })).detail, 'Opened a new window.');
  assert.ok(Number.isInteger((await run({ op: 'duplicate' })).tabId));
  assert.deepEqual(await run({ op: 'back' }), { ok: true, detail: 'Went back.' });
  const empty = fakeChrome([{ id: 1, url: 'https://a.example/', active: true }], { noHistory: true });
  assert.equal((await tools(empty).run({ action: 'browser', op: 'back' }, { tabId: 1 })).detail, 'There is no page to go back to.');
  assert.equal((await tools(empty).run({ action: 'browser', op: 'reopen' }, { tabId: 1 })).ok, false);
});

test('pin, mute, move and bookmark act on the task’s tab and say what they did', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://a.example/page', title: 'Page A', active: true }]);
  const run = (action) => tools(chrome).run({ action: 'browser', ...action }, { tabId: 1 });
  assert.equal((await run({ op: 'mute' })).detail, 'Muted “Page A”.');
  assert.equal((await run({ op: 'pin' })).detail, 'Pinned “Page A”.');
  assert.equal((await run({ op: 'move', index: 0 })).detail, 'Moved “Page A” to position 1.');
  assert.equal((await run({ op: 'bookmark' })).detail, 'Bookmarked “Page A”.');
  assert.deepEqual(chrome.calls.find(([kind]) => kind === 'bookmark')[1], { title: 'Page A', url: 'https://a.example/page' });
  const saved = fakeChrome([{ id: 1, url: 'https://a.example/page', title: 'Page A', active: true }], { bookmarked: [{ id: 'b' }] });
  assert.equal((await tools(saved).run({ action: 'browser', op: 'bookmark' }, { tabId: 1 })).detail, '“Page A” is already bookmarked.');
  const gone = await tools(chrome).run({ action: 'browser', op: 'mute' }, { tabId: 999 });
  assert.equal(gone.detail, 'The task’s tab is no longer open.');
});

test('groups reuse a group of the same name; collapse finds a group by name', async () => {
  const chrome = fakeChrome([{ id: 1, url: 'https://a.example/', active: true }, { id: 2, url: 'https://b.example/' }],
    { groups: [{ id: 4, title: 'Work' }] });
  const run = (action) => tools(chrome).run({ action: 'browser', ...action }, { tabId: 1 });
  assert.equal((await run({ op: 'group', tabIds: [1, 2], group: 'work' })).detail, 'Grouped 2 tabs in “work”.');
  assert.deepEqual(chrome.calls.find(([kind]) => kind === 'group')[1], { tabIds: [1, 2], groupId: 4 });
  await run({ op: 'group', tabIds: [2], group: 'Reading', color: 'blue' });
  assert.deepEqual(chrome.calls.filter(([kind]) => kind === 'group-update').at(-1), ['group-update', 9, { title: 'Reading', color: 'blue' }]);
  assert.equal((await run({ op: 'collapse', group: 'WORK' })).detail, 'Collapsed “Work”.');
  assert.equal((await run({ op: 'expand', group: 'Nope' })).ok, false);
});

test('history and bookmark reads are bounded, web-only and safe to show a model', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ url: i === 0 ? 'chrome://settings' : `https://recipes.example/${i}?session=x`,
    title: `Recipe ${i}`, lastVisitTime: Date.UTC(2026, 9, 19, 12) }));
  const chrome = fakeChrome([{ id: 1, url: 'https://a.example/', active: true }], { history,
    bookmarks: [{ id: 'f', title: 'Work' }, { id: 'b', title: 'Docs', url: 'https://docs.example/' }],
    children: [{ url: 'https://jira.example/' }, { url: 'javascript:alert(1)' }] });
  const found = await tools(chrome).run({ action: 'browser', op: 'history', query: 'lasagna', days: 7 }, { tabId: 1 });
  assert.equal(found.items.length, 10);
  assert.deepEqual(found.items[0], { title: 'Recipe 1', url: 'https://recipes.example/1', visited: 'yesterday' });
  assert.equal(chrome.calls.find(([kind]) => kind === 'history')[1].startTime, Date.UTC(2026, 9, 13, 12));
  const marks = await tools(chrome).run({ action: 'browser', op: 'bookmarks', query: 'work' }, { tabId: 1 });
  assert.deepEqual(marks.items, [{ title: 'Work', folder: true, urls: ['https://jira.example/'] }, { title: 'Docs', url: 'https://docs.example/' }]);
});
