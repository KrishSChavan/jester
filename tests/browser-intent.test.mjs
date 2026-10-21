import test from 'node:test';
import assert from 'node:assert/strict';
import { quickBrowserAction, parseBrowserIntent, chooseBrowserAction, tabsNamed, spokenCommand } from '../jester-extension/src/background/browser-intent.js';
import { parseYouTubeIntent } from '../jester-extension/src/background/youtube.js';
import { validateAction } from '../jester-extension/src/common/agent-actions.js';

const tab = (tabId, title, url, extra = {}) => ({ tabId, title, url, ...extra });
const page = (url, elements = [], tabs = null, extra = {}) => ({ ok: true, pageId: `p:${url}`, revision: 1, url, title: 'Page',
  elements, ...(tabs ? { tabs } : {}), ...extra });
const commit = (decision) => decision.progress;

test('one-step tab and page commands, with or without politeness and dictation punctuation', () => {
  for (const [text, action] of [
    ['New tab.', { action: 'browser', op: 'new' }], ['open a new tab please', { action: 'browser', op: 'new' }],
    ['Close this tab', { action: 'browser', op: 'close' }], ['close the current tab', { action: 'browser', op: 'close' }],
    ['next tab', { action: 'browser', op: 'next' }], ['Go to the previous tab', { action: 'browser', op: 'previous' }],
    ['Reopen the last closed tab.', { action: 'browser', op: 'reopen' }], ['undo close tab', { action: 'browser', op: 'reopen' }],
    ['Go back', { action: 'browser', op: 'back' }], ['forward', { action: 'browser', op: 'forward' }],
    ['Refresh the page', { action: 'browser', op: 'reload' }], ['New window', { action: 'browser', op: 'window' }],
    ['Mute this tab', { action: 'browser', op: 'mute' }], ['unpin the tab', { action: 'browser', op: 'unpin' }],
    ['Can you bookmark this page?', { action: 'browser', op: 'bookmark' }],
    ['Scroll down', { action: 'scroll', direction: 'down' }], ['go to the top of the page', { action: 'scroll', direction: 'top' }]
  ]) {
    assert.deepEqual(quickBrowserAction(text), action, text);
    assert.deepEqual(validateAction(action), action);
  }
  for (const text of ['mute', 'go back to Gmail', 'close the Gmail tab', 'pause', 'play MrBeast']) assert.equal(quickBrowserAction(text), null, text);
  assert.equal(spokenCommand('Hey Jester, could you please open Gmail?'), 'open Gmail');
});

test('switching names a tab by site, title words or place in the tab strip', () => {
  assert.deepEqual(parseBrowserIntent('switch to Gmail'), { kind: 'switch', name: 'Gmail' });
  assert.deepEqual(parseBrowserIntent('go to my lasagna recipe tab'), { kind: 'switch', name: 'lasagna recipe' });
  assert.deepEqual(parseBrowserIntent('Go back to the YouTube tab.'), { kind: 'switch', name: 'YouTube' });
  assert.deepEqual(parseBrowserIntent('switch to tab 3'), { kind: 'switch', position: 3 });
  assert.deepEqual(parseBrowserIntent('go to the second tab'), { kind: 'switch', position: 2 });
  assert.deepEqual(parseBrowserIntent('switch to the last tab'), { kind: 'switch', position: 'last' });
  assert.equal(parseBrowserIntent('switch to this'), null);
});

test('opening a site resolves listed names and spoken domains, and splits "open X and …"', () => {
  assert.deepEqual(parseBrowserIntent('Open Gmail'), { kind: 'open', url: 'https://mail.google.com/', site: parseBrowserIntent('open gmail').site, name: 'Gmail' });
  assert.equal(parseBrowserIntent('go to amazon dot com').url, 'https://amazon.com/');
  assert.equal(parseBrowserIntent('take me to github.com/anthropics').url, 'https://github.com/anthropics');
  const compound = parseBrowserIntent("Open YouTube and play MrBeast's latest video.");
  assert.equal(compound.url, 'https://www.youtube.com/');
  assert.equal(compound.then, "play MrBeast's latest video");
  assert.equal(parseYouTubeIntent(compound.then).creator, 'MrBeast');
  // Not a site, so not split: the model resolves it, or a tab title does.
  assert.deepEqual(parseBrowserIntent('open the Anthropic docs'), { kind: 'open', name: 'Anthropic docs' });
  assert.equal(parseYouTubeIntent("open YouTube and play MrBeast's latest video"), null);
  assert.equal(parseYouTubeIntent("play Rhett and Link's latest video").creator, 'Rhett and Link');
});

test('named-tab operations and searches parse to their exact scope', () => {
  assert.deepEqual(parseBrowserIntent('close the Gmail tab'), { kind: 'tabs', op: 'close', name: 'Gmail', all: false });
  assert.deepEqual(parseBrowserIntent('Close all the cooking tabs'), { kind: 'tabs', op: 'close', name: 'cooking', all: true });
  assert.deepEqual(parseBrowserIntent('close all other tabs'), { kind: 'tabs', op: 'close', others: true });
  assert.deepEqual(parseBrowserIntent('mute the YouTube tab'), { kind: 'tabs', op: 'mute', name: 'YouTube', all: false });
  assert.deepEqual(parseBrowserIntent('google best pizza near me'), { kind: 'search', query: 'best pizza near me', where: 'web' });
  assert.deepEqual(parseBrowserIntent('Search the web for flights to Tokyo.'), { kind: 'search', query: 'flights to Tokyo', where: 'web' });
  assert.deepEqual(parseBrowserIntent('search Amazon for usb c hubs'), { kind: 'search', query: 'usb c hubs', where: 'site', site: 'amazon' });
  assert.deepEqual(parseBrowserIntent('search for lofi beats on YouTube'), { kind: 'search', query: 'lofi beats', where: 'site', site: 'youtube' });
  assert.deepEqual(parseBrowserIntent('search for cat videos'), { kind: 'search', query: 'cat videos', where: 'here' });
  assert.equal(parseBrowserIntent('new tab'), null, 'One-step commands are not multi-step intents');
});

test('open switches to the site’s open tab or opens it, then is done once the task shows it', () => {
  const intent = parseBrowserIntent('open YouTube');
  const step = chooseBrowserAction(intent, page('https://mail.google.com/'));
  assert.deepEqual(step.action, { action: 'browser', op: 'open', url: 'https://www.youtube.com/' });
  assert.deepEqual(validateAction(step.action), step.action);
  assert.equal(chooseBrowserAction(intent, page('https://www.youtube.com/watch?v=1')).done, true);
  // Confirmed open, whatever page it landed on: the host's reply is the answer.
  assert.equal(chooseBrowserAction(intent, page('https://consent.youtube.example/'), commit(step)).done, true);
  // An unlisted name may be an open tab's title; otherwise the model resolves it.
  const docs = parseBrowserIntent('open the Anthropic docs');
  const tabs = [tab(1, 'Inbox', 'https://mail.google.com/', { current: true }), tab(2, 'Anthropic Docs - Models', 'https://docs.anthropic.com/')];
  assert.deepEqual(chooseBrowserAction(docs, page('https://mail.google.com/', [], tabs)).action, { action: 'browser', op: 'switch', tabId: 2 });
  assert.equal(chooseBrowserAction(docs, page('https://mail.google.com/', [], [tabs[0]])), null);
});

test('switch picks the site’s most recent tab, a unique title, or a strip position; mixed matches go to the model', () => {
  const tabs = [tab(1, 'Inbox', 'https://mail.google.com/', { current: true, lastAccessed: 9 }),
    tab(2, 'Music - YouTube', 'https://www.youtube.com/watch?v=a', { lastAccessed: 3 }),
    tab(3, 'News - YouTube', 'https://www.youtube.com/watch?v=b', { lastAccessed: 7 }),
    tab(4, 'Lasagna recipe', 'https://food.example/lasagna'), tab(5, 'Recipe box', 'https://box.example/'),
    tab(6, 'Other window', 'https://w.example/', { otherWindow: true })];
  const choose = (text) => chooseBrowserAction(parseBrowserIntent(text), page('https://mail.google.com/', [], tabs));
  assert.equal(choose('switch to YouTube').action.tabId, 3);
  assert.equal(choose('go to my lasagna recipe tab').action.tabId, 4);
  assert.equal(choose('switch to the recipe tab'), null, 'Two different pages match');
  assert.equal(choose('switch to Gmail').say, 'Already on “Inbox”.');
  assert.equal(choose('switch to tab 2').action.tabId, 2);
  assert.equal(choose('switch to the last tab').action.tabId, 5, 'The last tab of this window');
  assert.deepEqual(choose('switch to Netflix').action, { action: 'browser', op: 'open', url: 'https://www.netflix.com/' });
  assert.equal(choose('switch to the spreadsheet tab'), null);
  assert.equal(tabsNamed(tabs, 'youtube').length, 2);
});

test('named-tab operations close every match only when asked for all; other tabs stay in this window', () => {
  const tabs = [tab(1, 'Inbox', 'https://mail.google.com/', { current: true }), tab(2, 'Soup recipe', 'https://a.example/soup'),
    tab(3, 'Cake recipe', 'https://b.example/cake'), tab(4, 'Elsewhere', 'https://c.example/', { otherWindow: true })];
  const choose = (text) => chooseBrowserAction(parseBrowserIntent(text), page('https://mail.google.com/', [], tabs));
  assert.deepEqual(choose('close all the recipe tabs').action, { action: 'browser', op: 'close', tabIds: [2, 3] });
  assert.equal(choose('close the recipe tab'), null, 'Which one is unclear');
  assert.deepEqual(choose('close all other tabs').action, { action: 'browser', op: 'close', tabIds: [2, 3] });
  assert.deepEqual(choose('mute the soup tab').action, { action: 'browser', op: 'mute', tabId: 2 });
  assert.equal(choose('close the banking tab').say, 'No open tab matches “banking”.');
});

test('search uses this site’s own box, then the web; a named site uses its search address', () => {
  const youtube = (elements, extra) => page('https://www.youtube.com/', elements, null, extra);
  const intent = parseBrowserIntent('search for lofi beats');
  const typed = chooseBrowserAction(intent, youtube([{ id: 's', role: 'combobox', name: 'Search', value: '' }]));
  assert.deepEqual(typed.action, { action: 'type', elementId: 's', text: 'lofi beats', pageId: 'p:https://www.youtube.com/', revision: 1 });
  const entered = chooseBrowserAction(intent, youtube([{ id: 's', role: 'combobox', name: 'Search', value: 'lofi beats' }]), commit(typed));
  assert.equal(entered.action.key, 'Enter');
  assert.equal(chooseBrowserAction(intent, page('https://www.youtube.com/results?search_query=lofi'), commit(entered)).say,
    'Searched youtube.com for “lofi beats”.');
  // A collapsed search opens by its button first.
  assert.equal(chooseBrowserAction(intent, youtube([{ id: 'b', role: 'button', name: 'Search' }])).action.elementId, 'b');
  // No search here, a Chrome page, or a request for the web: the default search engine.
  for (const where of [page('https://blog.example/'), page('chrome://newtab/', [], null, { restricted: true })]) {
    assert.deepEqual(chooseBrowserAction(intent, where).action, { action: 'browser', op: 'search', query: 'lofi beats' });
  }
  assert.equal(chooseBrowserAction(intent, youtube([{ id: 'a', role: 'searchbox', name: 'Search' }, { id: 'b', role: 'combobox', name: 'Search videos' }])), null);
  const amazon = chooseBrowserAction(parseBrowserIntent('search Amazon for usb c hubs'), page('https://mail.google.com/'));
  assert.deepEqual(amazon.action, { action: 'browser', op: 'open', url: 'https://www.amazon.com/s?k=usb%20c%20hubs' });
  assert.equal(chooseBrowserAction(parseBrowserIntent('search Amazon for usb c hubs'), page('https://www.amazon.com/s?k=x'), commit(amazon)).say,
    'Searched amazon.com for “usb c hubs”.');
  const hulu = chooseBrowserAction(parseBrowserIntent('search Hulu for The Bear'), page('https://mail.google.com/'));
  assert.deepEqual(hulu.action, { action: 'browser', op: 'open', url: 'https://www.hulu.com/' });
  assert.equal(hulu.progress.done, undefined, 'Without a search address the search box comes next');
});
