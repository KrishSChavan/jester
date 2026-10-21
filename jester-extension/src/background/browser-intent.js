/**
 * Spoken browser requests that need no model: tab and window commands, opening
 * a named site, switching to an open tab, and searching. Like the other planners,
 * each step is read off the current page and the open tabs (which stay on the
 * device); anything uncertain returns null and the model takes that step.
 */
import { siteNamed, spokenAddress, siteOf, siteSearch, showsAddress } from '../common/sites.js';

const VERSION = 1;
const WAIT = Object.freeze({ wait: true });
const OPEN = '(?:open(?:\\s+up)?|go\\s+to|take\\s+me\\s+to|visit|pull\\s+up|bring\\s+up|launch|load|navigate\\s+to|head\\s+to)';

/** What was said, without the wake word, the politeness and the dictation's punctuation. */
export function spokenCommand(text) {
  if (typeof text !== 'string' || text.length > 300) return '';
  const polite = /^(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:\s+would|['’]d)\s+like\s+(?:you\s+)?to\s+|i\s+want\s+(?:you\s+)?to\s+)/i;
  return text.trim().replace(/^(?:hey\s+)?jester[:,]?\s+/i, '').replace(/\s*,?\s+please[.!?]?$/i, '')
    .replace(/[.!?]+$/, '').replace(polite, '').replace(polite, '').trim();
}

const THIS = '(?:(?:this|the|current|this\\s+current|the\\s+current)\\s+)?';
/** One-step tab and page commands: an action to run as is. */
const QUICK = [
  [new RegExp('^(?:open\\s+)?(?:a\\s+)?new\\s+tab$|^open\\s+a\\s+tab$', 'i'), { action: 'browser', op: 'new' }],
  [new RegExp(`^close\\s+${THIS}tab$`, 'i'), { action: 'browser', op: 'close' }],
  [/^(?:(?:go|switch|move)\s+to\s+)?(?:the\s+)?next\s+tab$/i, { action: 'browser', op: 'next' }],
  [/^(?:(?:go|switch|move)\s+(?:back\s+)?to\s+)?(?:the\s+)?(?:previous|prior)\s+tab$/i, { action: 'browser', op: 'previous' }],
  [/^(?:reopen|re-open|re\s+open|restore|bring\s+back)\s+(?:the\s+|my\s+)?(?:last\s+)?(?:closed\s+)?tab$|^undo\s+(?:the\s+)?close(?:d)?\s+tab$/i, { action: 'browser', op: 'reopen' }],
  [/^(?:go\s+)?back(?:\s+a\s+page)?$|^(?:go\s+to\s+the\s+)?previous\s+page$/i, { action: 'browser', op: 'back' }],
  [/^(?:go\s+)?forward(?:\s+a\s+page)?$/i, { action: 'browser', op: 'forward' }],
  [new RegExp(`^(?:reload|refresh)(?:\\s+${THIS}(?:page|tab))?$`, 'i'), { action: 'browser', op: 'reload' }],
  [/^(?:open\s+)?(?:a\s+)?new\s+window$/i, { action: 'browser', op: 'window' }],
  ...['mute', 'unmute', 'pin', 'unpin', 'duplicate'].map((op) => [new RegExp(`^${op}\\s+${THIS}tab$`, 'i'), { action: 'browser', op }]),
  [/^bookmark\s+(?:this|it|the\s+(?:page|tab|site))(?:\s+(?:page|tab|site))?$|^add\s+(?:this|the)\s+page\s+to\s+(?:my\s+)?bookmarks$/i, { action: 'browser', op: 'bookmark' }],
  [/^scroll\s+down$|^page\s+down$/i, { action: 'scroll', direction: 'down' }],
  [/^scroll\s+up$|^page\s+up$/i, { action: 'scroll', direction: 'up' }],
  [/^(?:scroll|go|jump)\s+(?:to\s+)?(?:the\s+)?top(?:\s+of\s+(?:the|this)\s+page)?$/i, { action: 'scroll', direction: 'top' }],
  [/^(?:scroll|go|jump)\s+(?:to\s+)?(?:the\s+)?bottom(?:\s+of\s+(?:the|this)\s+page)?$/i, { action: 'scroll', direction: 'bottom' }]
];

/** "Next tab", "reopen closed tab", "scroll down": the one action it means, or null. */
export function quickBrowserAction(text) {
  const command = spokenCommand(text);
  const match = QUICK.find(([pattern]) => pattern.test(command));
  return match ? { ...match[1] } : null;
}

/** A site or address a name means: a listed site, or a spoken domain. */
function destination(name) {
  const site = siteNamed(name);
  if (site) return { url: site.url, site };
  const url = spokenAddress(name);
  return url ? { url, site: siteOf(url) } : null;
}

const NOT_A_NAME = /^(?:this|that|it|the|current|other|others|all|every|this\s+one|that\s+one)$/i;
const POSITIONS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/**
 * Multi-step requests: open a site (and maybe carry on there), switch to a tab,
 * act on named tabs, or search. `then` is the rest of "open YouTube and …".
 */
export function parseBrowserIntent(text) {
  const command = spokenCommand(text);
  if (!command || quickBrowserAction(command)) return null;
  // "Tab 3", "the second tab", "the last tab": a place in this window's tab strip.
  let match = /^(?:switch|go|change|jump)\s+to\s+(?:the\s+)?(?:tab\s+(?:number\s+)?(\d{1,2}|[a-z]+)|([a-z]+)\s+tab)$/i.exec(command);
  const place = match && String(match[1] || match[2]).toLowerCase();
  if (place && (place === 'last' || /^\d+$/.test(place) || Object.hasOwn(POSITIONS, place))) {
    return { kind: 'switch', position: place === 'last' ? 'last' : Number(POSITIONS[place] ?? place) };
  }
  match = /^(?:switch|change|jump|flip|go\s+back)\s+(?:back\s+)?to\s+(?:the\s+|my\s+)?(.+?)(?:\s+tab)?$/i.exec(command) ||
    /^(?:go|take\s+me)\s+(?:back\s+)?to\s+(?:the\s+|my\s+)(.+?)\s+tab$/i.exec(command) ||
    /^(?:show|bring\s+up|open)\s+(?:me\s+)?(?:the\s+|my\s+)(.+?)\s+tab$/i.exec(command);
  if (match && !NOT_A_NAME.test(match[1])) return { kind: 'switch', name: match[1].trim() };
  match = /^(close|mute|unmute|pin|unpin|reload|refresh|duplicate)\s+(all\s+)?(?:(?:of\s+)?the\s+|my\s+)?(.+?)\s+(tabs?)$/i.exec(command);
  if (match) {
    const name = match[3].trim();
    const op = match[1].toLowerCase() === 'refresh' ? 'reload' : match[1].toLowerCase();
    if (/^(?:all\s+)?(?:the\s+)?other$/i.test(name) && op === 'close') return { kind: 'tabs', op, others: true };
    if (!NOT_A_NAME.test(name)) return { kind: 'tabs', op, name, all: !!match[2] || match[4].toLowerCase() === 'tabs' };
  }
  match = /^(?:google|google\s+search(?:\s+for)?|search\s+google\s+for|search\s+the\s+(?:web|internet)\s+for|search\s+online\s+for|web\s+search(?:\s+for)?|look\s+up)\s+(.+)$/i.exec(command);
  if (match) return { kind: 'search', query: match[1].trim(), where: 'web' };
  match = /^search\s+(.+?)\s+for\s+(.+)$/i.exec(command);
  if (match && siteNamed(match[1])) return { kind: 'search', query: match[2].trim(), where: 'site', site: siteNamed(match[1]).key };
  match = /^search(?:\s+for)?\s+(.+?)\s+on\s+(.+)$/i.exec(command);
  if (match && siteNamed(match[2])) return { kind: 'search', query: match[1].trim(), where: 'site', site: siteNamed(match[2]).key };
  match = /^search(?:\s+for)?\s+(.+)$/i.exec(command);
  if (match) return { kind: 'search', query: match[1].trim(), where: 'here' };
  match = new RegExp(`^${OPEN}\\s+(?:the\\s+|my\\s+)?(.+)$`, 'i').exec(command);
  if (!match) return null;
  // "Open YouTube and play MrBeast's latest video": the site first, then the rest there.
  const compound = /^(.+?)(?:\s*,\s*|\s+)(?:and\s+then|and|then)\s+(.+)$/i.exec(match[1]);
  const first = compound && destination(compound[1]);
  if (first) return { kind: 'open', ...first, name: compound[1].trim(), then: compound[2].trim() };
  const whole = destination(match[1]);
  return { kind: 'open', ...(whole || {}), name: match[1].trim() };
}

function hostOf(address) {
  try { return new URL(address).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const compact = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
const words = (text) => String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/**
 * Open tabs a spoken name means: a listed site's tabs ("Gmail"), else tabs whose
 * title or address holds every word ("the lasagna recipe"). Most recent first.
 */
export function tabsNamed(tabs, name) {
  const list = Array.isArray(tabs) ? tabs.filter((tab) => Number.isInteger(tab?.tabId)) : [];
  const site = siteNamed(name);
  const wanted = words(name).filter((word) => !['the', 'my', 'tab', 'tabs', 'page', 'site', 'website'].includes(word));
  const matches = site
    ? list.filter((tab) => siteOf(tab.url) === site)
    : wanted.length ? list.filter((tab) => wanted.every((word) => `${tab.title} ${tab.url}`.toLowerCase().includes(word))) : [];
  return [...matches].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

function searchFields(elements) {
  return elements.filter((entry) => ['searchbox', 'combobox', 'textbox', 'input'].includes(entry.role) && !entry.offscreen &&
    !entry.disabled && (entry.role === 'searchbox' || /\bsearch\b/i.test(entry.name || '')));
}

/**
 * One schema-valid proposed action and proposed progress (committed only after
 * the host confirms it), {done, say} when the request is met, WAIT while the page
 * catches up, or null for the model.
 */
export function chooseBrowserAction(intent, page, progress = {}) {
  if (!intent || !['open', 'switch', 'tabs', 'search'].includes(intent.kind) || !page || page.ok === false) return null;
  const elements = Array.isArray(page.elements) ? page.elements : [];
  const tabs = Array.isArray(page.tabs) ? page.tabs : null;
  const current = tabs?.find((tab) => tab.current);
  const scope = `${page.pageId || ''}|${page.url || ''}`;
  const prior = progress?.version === VERSION ? progress : {};
  const attempted = Array.isArray(prior.attempted) ? prior.attempted.filter((value) => typeof value === 'string').slice(-12) : [];
  const next = { version: VERSION, attempted, ...(prior.done ? { done: prior.done } : {}), ...(prior.say ? { say: prior.say } : {}) };
  function propose(action, patch = {}) {
    const signature = `${scope}|${JSON.stringify(action)}`;
    if (attempted.includes(signature)) return null;
    const framed = { ...action };
    if (action.elementId) {
      if (typeof page.pageId === 'string') framed.pageId = page.pageId;
      if (Number.isSafeInteger(page.revision) && page.revision >= 0) framed.revision = page.revision;
    }
    return { action: framed, progress: { ...next, ...patch, attempted: [...attempted, signature].slice(-12) } };
  }
  const done = (say) => ({ done: true, ...(say ? { say } : {}), progress: next });
  // A step whose own success is the request: its answer, or else the host's reply.
  if (prior.done) return done(typeof prior.say === 'string' ? prior.say : undefined);

  if (intent.kind === 'open') {
    if (intent.url) {
      if (showsAddress(page.url, intent.url)) return done();
      return propose({ action: 'browser', op: 'open', url: intent.url }, { done: true });
    }
    // An unknown name may still be an open tab's title; otherwise the model knows addresses.
    if (!tabs) return null;
    const named = tabsNamed(tabs, intent.name);
    if (named.length !== 1) return null;
    // Whoever opened it — the model, or the user before asking — it is on screen now.
    return named[0].current ? done(`Here’s “${named[0].title}”.`) : propose({ action: 'browser', op: 'switch', tabId: named[0].tabId }, { done: true });
  }

  if (intent.kind === 'switch' && intent.position !== undefined) {
    if (!tabs) return null;
    const strip = tabs.filter((tab) => !tab.otherWindow);
    const tab = intent.position === 'last' ? strip.at(-1) : strip[intent.position - 1];
    if (!tab) return done(`There is no tab ${intent.position} in this window.`);
    return tab.current ? done(`Already on “${tab.title}”.`) : propose({ action: 'browser', op: 'switch', tabId: tab.tabId }, { done: true });
  }

  if (intent.kind === 'switch') {
    if (!tabs) return null;
    const named = tabsNamed(tabs, intent.name);
    const site = siteNamed(intent.name);
    if (!named.length) return site ? propose({ action: 'browser', op: 'open', url: site.url }, { done: true }) : null;
    // Several tabs of one site: the most recently used one, as a person would pick.
    const sameSite = site || new Set(named.map((tab) => siteOf(tab.url)?.key || hostOf(tab.url))).size === 1;
    if (named.length > 1 && !sameSite) return null;
    if (named[0].current) return done(`Already on “${named[0].title}”.`);
    return propose({ action: 'browser', op: 'switch', tabId: named[0].tabId }, { done: true });
  }

  if (intent.kind === 'tabs') {
    if (!tabs) return null;
    const window = tabs.filter((tab) => !tab.otherWindow);
    const named = intent.others ? window.filter((tab) => !tab.current) : tabsNamed(tabs, intent.name);
    if (!named.length) return done(intent.others ? 'There are no other tabs in this window.' : `No open tab matches “${intent.name}”.`);
    if (!intent.all && !intent.others && named.length > 1) return null;
    const ids = named.map((tab) => tab.tabId).slice(0, 40);
    if (intent.op === 'close') return propose({ action: 'browser', op: 'close', tabIds: ids }, { done: true });
    if (ids.length > 1) return null; // One tab at a time for the rest; the model can loop.
    return propose({ action: 'browser', op: intent.op, tabId: ids[0] }, { done: true });
  }

  // Search: a named site's own search, else this site's, else the web.
  const query = intent.query;
  const named = intent.where === 'site' ? siteNamed(intent.site) : null;
  if (intent.where === 'web' || (intent.where === 'here' && page.restricted)) {
    return propose({ action: 'browser', op: 'search', query }, { done: true });
  }
  if (named && siteOf(page.url) !== named) {
    const address = siteSearch(named, query);
    // Without a search address, open the site and use its search box there.
    return propose({ action: 'browser', op: 'open', url: address || named.url },
      address ? { done: true, say: `Searched ${hostOf(named.url)} for “${query}”.` } : {});
  }
  if (prior.submitted) return done(`Searched ${hostOf(page.url) || 'this site'} for “${query}”.`);
  const fields = searchFields(elements);
  if (fields.length > 1) return null;
  if (fields.length === 1) {
    const [field] = fields;
    return compact(field.value) === compact(query)
      ? propose({ action: 'press_key', elementId: field.id, key: 'Enter' }, { submitted: scope })
      : propose({ action: 'type', elementId: field.id, text: query });
  }
  // A collapsed search: its button opens the field.
  const buttons = elements.filter((entry) => ['button', 'link'].includes(entry.role) && !entry.offscreen && /^search\b/i.test(entry.name || ''));
  if (buttons.length === 1) return propose({ action: 'click', elementId: buttons[0].id }) || WAIT;
  return named ? null : propose({ action: 'browser', op: 'search', query }, { done: true });
}

/** "Yes" or "no" to a waiting step, from a short reply; null for anything else. */
export function approvalAnswer(text) {
  const said = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}’' ]+/gu, ' ').trim().replace(/\s+/g, ' ');
  if (!said || said.split(' ').length > 4) return null;
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|confirm|confirmed|approve|approved|allow|allow it|please do|affirmative)\b/.test(said)) return 'yes';
  if (/^(?:no|nope|nah|don[’']?t|do not|stop|cancel|deny|never mind|nevermind|negative)\b/.test(said)) return 'no';
  return null;
}
