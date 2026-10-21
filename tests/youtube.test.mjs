import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeIntent, chooseYouTubeAction, noteModelStep } from '../jester-extension/src/background/youtube.js';
import { validateAction } from '../jester-extension/src/common/agent-actions.js';

// Fixtures follow live youtube.com observations (2026-10-20): the masthead
// combobox, a results page's channel card, a channel's tabs and sort chips, and
// a watch page whose player is showing an ad first.
const YT = 'https://www.youtube.com';
const intent = parseYouTubeIntent("go to MrBeast's latest video");
const element = (id, role, name, extra = {}) => ({ id, role, name, ...extra });
const state = (path, elements, extra = {}) => ({ ok: true, pageId: `p-${path}`, revision: 1, url: `${YT}${path}`,
  title: 'YouTube', elements, ...extra });
/** Applies a proposed step the way the host does once it is confirmed. */
const commit = (decision) => decision.progress;
const search = (value = '') => element('search', 'combobox', 'Search', { expanded: true, value, order: 2 });
const results = () => state('/results?search_query=MrBeast', [
  element('card', 'link', 'MrBeast @MrBeast • 522M subscribers SUBSCRIBE FOR A COOKIE! New MrBeast or MrBeast Gaming video every single Saturday', { url: `${YT}/@MrBeast`, order: 4 }),
  element('avatar', 'link', 'Go to channel MrBeast', { url: `${YT}/@MrBeast`, order: 3 }),
  element('latest-from', 'link', 'Lose 150 Lbs Together, Win $250,000 43 minutes', { url: `${YT}/watch?v=RE3_PGwDwhw&pp=yg`, order: 5 }),
  element('owner', 'link', 'MrBeast', { url: `${YT}/@MrBeast`, order: 6 }),
  search('MrBeast')
], { title: 'MrBeast - YouTube' });
const channelTabs = (selected) => [
  element('tab-home', 'tab', 'Home', { selected: selected === 'Home', order: 10 }),
  element('tab-videos', 'tab', 'Videos', { selected: selected === 'Videos', order: 11 }),
  element('tab-shorts', 'tab', 'Shorts', { selected: false, order: 12 })
];
const chips = (selected = 'Latest') => ['Latest', 'Popular', 'Oldest'].map((name, index) =>
  element(`chip-${name}`, 'tab', name, { selected: name === selected, order: 13 + index }));
const grid = () => [
  // Ranked, not laid out: a later title that matches the goal's words comes first.
  element('third', 'link', 'My Latest Video Ever 19 minutes', { url: `${YT}/watch?v=third`, order: 19 }),
  element('first', 'link', 'Lose 150 Lbs Together, Win $250,000 43 minutes', { url: `${YT}/watch?v=RE3_PGwDwhw`, order: 16 }),
  element('first-menu', 'button', 'More actions', { order: 17 }),
  element('second', 'link', 'Eat Everything In A Grocery Store, Win $1,000,000 57 minutes', { url: `${YT}/watch?v=plN7JMbadRg`, order: 18 })
];
const videosPage = (elements, extra = {}) => state('/@MrBeast/videos', elements, { title: 'MrBeast - YouTube', ...extra });

for (const [input, creator] of [
  ["go to MrBeast's latest video", 'MrBeast'],
  ['Play the newest video from Mark Rober.', 'Mark Rober'],
  ['play the latest Veritasium video', 'Veritasium'],
  ['Hey Jester, could you put on Marques Brownlee’s most recent upload please', 'Marques Brownlee'],
  ["Show me Linus Tech Tips' new video", 'Linus Tech Tips'],
  ['play the latest video from the youtuber MrBeast on YouTube', 'MrBeast'],
  ['Mr. Beast’s latest video', 'Mr. Beast']
]) {
  test(`parses a creator's latest-video request: ${input}`, () => {
    const value = parseYouTubeIntent(input);
    assert.equal(value?.kind, 'latest-video');
    assert.equal(value.creator, creator);
    assert.deepEqual(value.names, [creator]);
  });
}

test('a possessive heard without its apostrophe also tries the name without the s', () => {
  assert.deepEqual(parseYouTubeIntent('go to MrBeasts latest video'),
    { kind: 'latest-video', creator: 'MrBeasts', names: ['MrBeasts', 'MrBeast'] });
});

test('requests without a creator, compound requests and episode requests are not this flow', () => {
  for (const text of ['play the latest video', 'go back to the last video', "play this channel's latest video",
    'play the next video', 'play MrBeast', 'Mark Rober latest video', 'play season 3 episode 1 of Rick and Morty',
    'play the latest video from MrBeast and then turn it up', "go to MrBeast's channel"]) {
    assert.equal(parseYouTubeIntent(text), null, text);
  }
});

test('searches from the masthead field: types the creator, then submits that same field', () => {
  const typed = chooseYouTubeAction(intent, state('/', [element('home', 'link', 'Home', { url: `${YT}/` }), search()]));
  assert.deepEqual(typed.action, { action: 'type', elementId: 'search', text: 'MrBeast', pageId: 'p-/', revision: 1 });
  assert.equal(typed.progress.searched, undefined, 'Typing alone is not a search');
  const submitted = chooseYouTubeAction(intent, state('/', [search('MrBeast')]), commit(typed));
  assert.deepEqual(submitted.action, { action: 'press_key', elementId: 'search', key: 'Enter', pageId: 'p-/', revision: 1 });
  assert.equal(submitted.progress.searched, 'p-/|https://www.youtube.com/');
  // A submit that went nowhere falls back to the results page's own address.
  const fallback = chooseYouTubeAction(intent, state('/', [search('MrBeast')]), commit(submitted));
  assert.deepEqual(fallback.action, { action: 'navigate', url: `${YT}/results?search_query=MrBeast` });
});

test('without exactly one search field, the results page is opened by address', () => {
  const page = state('/watch?v=other', [element('a', 'combobox', 'Search', {}), element('b', 'searchbox', 'Search', {})]);
  assert.deepEqual(chooseYouTubeAction(intent, page).action, { action: 'navigate', url: `${YT}/results?search_query=MrBeast` });
  assert.equal(chooseYouTubeAction(intent, state('/feed/you', [])).action.action, 'navigate');
});

test('on the results, opens the named channel by its own link, never a card link quoting "SUBSCRIBE"', () => {
  const decision = chooseYouTubeAction(intent, results());
  assert.deepEqual(decision.action, { action: 'click', elementId: 'avatar', pageId: 'p-/results?search_query=MrBeast', revision: 1 });
  assert.equal(decision.progress.channel, '/@MrBeast');
  assert.equal(decision.progress.name, 'MrBeast');
  // With only the long card link, the channel's Videos address is used instead.
  const onlyCard = state('/results?search_query=MrBeast', [results().elements[0]]);
  assert.deepEqual(chooseYouTubeAction(intent, onlyCard).action, { action: 'navigate', url: `${YT}/@MrBeast/videos` });
});

test('a handle names the channel when the spoken name is the handle', () => {
  const mkbhd = parseYouTubeIntent("play MKBHD's latest video");
  const page = state('/results?search_query=MKBHD', [
    element('card', 'link', 'Marques Brownlee', { url: `${YT}/@mkbhd`, context: 'Marques Brownlee @mkbhd • 20M subscribers' })
  ]);
  const decision = chooseYouTubeAction(mkbhd, page);
  assert.equal(decision.action.action, 'navigate');
  assert.equal(decision.action.url, `${YT}/@mkbhd/videos`);
});

test('namesakes: the channel card wins over an uploader of the same name; two cards are left to the model', () => {
  const card = (id, base) => element(id, 'link', 'Go to channel MrBeast', { url: `${YT}${base}` });
  const uploader = element('fan', 'link', 'MrBeast', { url: `${YT}/channel/UCfan` });
  const one = chooseYouTubeAction(intent, state('/results?search_query=MrBeast', [uploader, card('real', '/@MrBeast')]));
  assert.equal(one.action.elementId, 'real');
  assert.equal(chooseYouTubeAction(intent, state('/results?search_query=MrBeast', [card('a', '/@MrBeast'), card('b', '/channel/UCother')])), null);
});

test('results without the requested channel are the model’s; results still rendering are waited for', () => {
  const partial = state('/results?search_query=MrBeast', [
    element('ltt', 'link', 'Go to channel MrBeast Gaming', { url: `${YT}/@BeastGaming` }),
    element('topic', 'link', 'MrBeast - Topic', { url: `${YT}/channel/UCtopic` })
  ]);
  assert.equal(chooseYouTubeAction(intent, partial), null);
  assert.deepEqual(chooseYouTubeAction(intent, state('/results?search_query=MrBeast', [search('MrBeast')])), { wait: true });
});

test('the channel page opens its Videos tab; an autoplaying channel trailer is not the requested video', () => {
  const progress = { version: 1, channel: '/@MrBeast' };
  const page = state('/@MrBeast', [...channelTabs('Home'),
    element('trailer', 'video', 'Video', { playing: true, paused: false, context: 'Lose 150 Lbs Together 0:00 / 43:16' })]);
  const decision = chooseYouTubeAction(intent, page, progress);
  assert.deepEqual(decision.action, { action: 'click', elementId: 'tab-videos', pageId: 'p-/@MrBeast', revision: 1 });
  assert.equal(decision.done, undefined);
  // A tab click that changed nothing falls back to the tab's address.
  assert.deepEqual(chooseYouTubeAction(intent, page, commit(decision)).action, { action: 'navigate', url: `${YT}/@MrBeast/videos` });
});

test('a channel reached without the search is recognized by its handle, title or heading', () => {
  for (const page of [
    state('/@MrBeast', channelTabs('Home')),
    state('/channel/UC123', channelTabs('Home'), { title: '(3) MrBeast - YouTube' }),
    state('/channel/UC123', [...channelTabs('Home'), element('h', 'heading', 'MrBeast, Verified')])
  ]) assert.equal(chooseYouTubeAction(intent, page).action.elementId, 'tab-videos');
  assert.deepEqual(chooseYouTubeAction(intent, state('/@SomeoneElse', channelTabs('Home'))).action,
    { action: 'navigate', url: `${YT}/results?search_query=MrBeast` }, 'Another creator’s channel starts a search');
});

test('until the Videos tab shows as selected, the old tab’s content is not read as the grid', () => {
  const progress = { version: 1, channel: '/@MrBeast' };
  const stale = videosPage([...channelTabs('Home'), element('featured', 'link', 'Lose 150 Lbs Together, Win $250,000', { url: `${YT}/watch?v=RE3_PGwDwhw`, order: 9 })]);
  assert.deepEqual(chooseYouTubeAction(intent, stale, progress), { wait: true });
});

test('plays the first video of the Latest grid in document order, not the first-ranked one', () => {
  const decision = chooseYouTubeAction(intent, videosPage([...channelTabs('Videos'), ...chips(), ...grid()]), { version: 1, channel: '/@MrBeast' });
  assert.deepEqual(decision.action, { action: 'click', elementId: 'first', pageId: 'p-/@MrBeast/videos', revision: 1 });
  assert.deepEqual(decision.progress.opened, { videoId: 'RE3_PGwDwhw', title: 'Lose 150 Lbs Together, Win $250,000',
    from: 'p-/@MrBeast/videos|https://www.youtube.com/@MrBeast/videos' });
  assert.deepEqual(validateAction(decision.action), decision.action);
});

test('the newest video is chosen whatever its title says, and a malformed address never breaks a step', () => {
  const progress = { version: 1, channel: '/@MrBeast' };
  const titled = grid().map((entry) => entry.id === 'first' ? { ...entry, name: 'The Upcoming Election, Explained 12 minutes' } : entry);
  assert.equal(chooseYouTubeAction(intent, videosPage([...channelTabs('Videos'), ...chips(), ...titled]), progress).action.elementId, 'first');
  const malformed = state('/results?search_query=MrBeast', [
    element('broken', 'link', 'Go to channel MrBeast', { url: `${YT}/@%E0%A4%A` }),
    element('avatar', 'link', 'Go to channel MrBeast', { url: `${YT}/@MrBeast` })]);
  assert.doesNotThrow(() => chooseYouTubeAction(intent, malformed));
});

test('a control missing between the sort chips and the first listed video could be the real first: nothing is chosen', () => {
  const gap = [...channelTabs('Videos'), ...chips(), ...grid().filter((entry) => entry.id !== 'first' && entry.id !== 'first-menu')];
  assert.equal(chooseYouTubeAction(intent, videosPage(gap), { version: 1, channel: '/@MrBeast' }), null);
  const unordered = [...channelTabs('Videos'), ...chips(), ...grid().map(({ order, ...entry }) => entry)];
  assert.equal(chooseYouTubeAction(intent, videosPage(unordered), { version: 1, channel: '/@MrBeast' }), null);
});

test('another sort chip reloads the Videos tab, which starts on Latest; a grid below the fold is scrolled to once', () => {
  const progress = { version: 1, channel: '/@MrBeast' };
  const popular = chooseYouTubeAction(intent, videosPage([...channelTabs('Videos'), ...chips('Popular'), ...grid()]), progress);
  assert.deepEqual(popular.action, { action: 'navigate', url: `${YT}/@MrBeast/videos` });
  const empty = videosPage([...channelTabs('Videos'), ...chips()]);
  const scrolled = chooseYouTubeAction(intent, empty, progress);
  assert.deepEqual(scrolled.action, { action: 'scroll', direction: 'down', amount: 0.5 });
  // Scrolled away, the tabs are no longer observed; the page was already confirmed
  // ready, and a complete observation has no left-out controls to doubt.
  const below = chooseYouTubeAction(intent, videosPage(grid(), { truncated: false }), commit(scrolled));
  assert.equal(below.action.elementId, 'first');
  assert.equal(chooseYouTubeAction(intent, videosPage(grid(), { truncated: true }), commit(scrolled)), null);
  assert.equal(chooseYouTubeAction(intent, empty, commit(scrolled)), null);
});

test('completion needs the opened video’s own page playing; an ad first is still that video', () => {
  const opened = { version: 1, channel: '/@MrBeast', name: 'MrBeast',
    opened: { videoId: 'RE3_PGwDwhw', title: 'Lose 150 Lbs Together, Win $250,000',
      from: 'p-/@MrBeast/videos|https://www.youtube.com/@MrBeast/videos' } };
  const watch = (video, path = '/watch?v=RE3_PGwDwhw') => state(path, video ? [video] : [], { title: 'Lose 150 Lbs Together, Win $250,000 - YouTube' });
  const ad = element('v', 'video', 'Video', { playing: true, paused: false, context: '@native_cos Native Shop now Sponsored Native 0:02 / 0:15' });
  const done = chooseYouTubeAction(intent, watch(ad), opened);
  assert.equal(done.done, true);
  assert.equal(done.action.say, 'Playing MrBeast’s latest video, “Lose 150 Lbs Together, Win $250,000”, after the ad.');
  assert.deepEqual(validateAction(done.action), done.action);
  const paused = chooseYouTubeAction(intent, watch(element('v', 'video', 'Video', { playing: false, paused: true })), opened);
  assert.deepEqual(paused.action, { action: 'command', actionId: 'PLAY' });
  assert.deepEqual(chooseYouTubeAction(intent, watch(null), opened), { wait: true });
  assert.equal(chooseYouTubeAction(intent, watch(ad, '/watch?v=somethingElse'), opened), null);
  // Still on the grid the video was opened from: its navigation has not shown yet.
  assert.deepEqual(chooseYouTubeAction(intent, videosPage(grid()), opened), { wait: true });
});

test('once the search went through, or the model acted, an unrecognized page is never searched over', () => {
  const lttChannel = state('/@LinusTechTips', channelTabs('Home'), { title: 'Linus Tech Tips - YouTube' });
  const linus = parseYouTubeIntent('play the latest video from Linus');
  assert.equal(chooseYouTubeAction(linus, lttChannel, { version: 1, searched: 'p-/|https://www.youtube.com/' }), null);
  assert.equal(chooseYouTubeAction(linus, lttChannel, noteModelStep({})), null);
  assert.equal(chooseYouTubeAction(linus, lttChannel).action.action, 'navigate');
  // The model landing on the requested channel hands the steps back.
  const back = chooseYouTubeAction(intent, state('/@MrBeast', channelTabs('Home')), noteModelStep({}));
  assert.equal(back.action.elementId, 'tab-videos');
});

test('said on another site or a Chrome page, YouTube is opened first, once', () => {
  for (const url of ['https://www.netflix.com/search?q=MrBeast', 'chrome://newtab/']) {
    const elsewhere = { ok: true, pageId: 'x', url, elements: [] };
    const decision = chooseYouTubeAction(intent, elsewhere);
    assert.deepEqual(decision.action, { action: 'browser', op: 'open', url: 'https://www.youtube.com/' });
    assert.deepEqual(validateAction(decision.action), decision.action);
    assert.equal(chooseYouTubeAction(intent, elsewhere, decision.progress), null, 'An open that went nowhere is the model’s');
  }
  assert.equal(chooseYouTubeAction(intent, { ok: true, pageId: 'x', url: 'https://www.netflix.com/', elements: [] }, noteModelStep({})), null);
});

test('other intents are never planned here', () => {
  assert.equal(chooseYouTubeAction({ kind: 'play-episode', show: 'MrBeast', season: 1, episode: 1 }, results()), null);
  assert.equal(chooseYouTubeAction(intent, { ok: false }), null);
});
