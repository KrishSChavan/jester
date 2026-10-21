/**
 * A creator's latest YouTube video, the way a person gets there: search the
 * name, open that channel, its Videos tab (newest first), and the first video.
 * Each step is read off the current page alone; whenever the page does not say
 * for certain, this returns null and the model takes that step instead.
 */
const VERSION = 1;
const YOUTUBE = /^(?:www\.)?youtube\.com$/;
const VERB = '(?:play|watch|open|show(?:\\s+me)?|go\\s+to|put\\s+on|pull\\s+up|bring\\s+up|find|start|load|take\\s+me\\s+to|get(?:\\s+me)?|navigate\\s+to)';
const LATEST = '(?:latest|newest|most\\s+recent|brand\\s+new|new|last|recent)';
const VIDEO = '(?:youtube\\s+)?(?:video|upload)';
const ON_YOUTUBE = '(?:\\s+on\\s+youtube)?';
const AMBIGUOUS = Symbol('ambiguous');
const WAIT = Object.freeze({ wait: true });

const compact = (text) => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
const scope = (page) => `${page.pageId || ''}|${page.url || ''}`;

/** A name, not a reference to something on screen or the rest of a sentence. */
function creatorName(text) {
  const name = String(text || '').trim().replace(/^["“](.*)["”]$/, '$1').trim();
  if (!name || name.length > 60 || name.split(/\s+/).length > 6 || !compact(name)) return null;
  if (/^(?:this|that|the|his|her|their|its|my|our|your|him|them|it)(?:\s+(?:channel|creator|youtuber|guy|person|one))?$/i.test(name)) return null;
  if (/\b(?:then|after|before|also|again|back|previous|next|instead)\b/i.test(name)) return null;
  // "Rhett and Link" is a name; "YouTube and play MrBeast" is two requests.
  if (/\band\s+(?:play|watch|open|go|search|show|put|find|pull|take)\b/i.test(name)) return null;
  if (/\b(?:the|a|an|to|of|for|from|by|on|my|your|our|his|her|their|this|that)$/i.test(name)) return null;
  return name;
}

/** "Play MrBeast's latest video", "the newest video from Mark Rober", "the latest MKBHD upload". */
export function parseYouTubeIntent(text) {
  if (typeof text !== 'string' || text.length > 300) return null;
  let input = text.trim().replace(/^(?:hey\s+)?jester[:,]?\s+/i, '')
    .replace(/\s*,?\s+please[.!?]?$/i, '').replace(/[.!?]+$/, '');
  const polite = /^(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:\s+would|['’]d)\s+like\s+(?:you\s+)?to\s+|i\s+want\s+(?:you\s+)?to\s+)/i;
  input = input.replace(polite, '').replace(polite, '');
  const from = new RegExp(`^(?:${VERB}\\s+)?(?:the\\s+)?${LATEST}\\s+${VIDEO}\\s+(?:from|by|of|on)\\s+(?:the\\s+)?(?:youtuber\\s+|channel\\s+|creator\\s+)?(.+?)(?:['’]s?\\s+channel|\\s+channel)?${ON_YOUTUBE}$`, 'i').exec(input);
  const owned = from ? null : new RegExp(`^(?:${VERB}\\s+)?(.+?)(['’]s|['’])?\\s+${LATEST}\\s+${VIDEO}${ON_YOUTUBE}$`, 'i').exec(input);
  const named = from || owned ? null : new RegExp(`^(?:${VERB}\\s+)?(?:the\\s+)?${LATEST}\\s+(.+?)\\s+${VIDEO}${ON_YOUTUBE}$`, 'i').exec(input);
  // Without an apostrophe only a trailing s marks the owner: "go back to the
  // last video" names nobody, while dictation often drops it from "MrBeast's".
  if (owned && !owned[2] && !/s$/i.test(owned[1])) return null;
  const creator = creatorName((from || owned || named)?.[1]);
  if (!creator) return null;
  const names = [creator];
  if (owned && !owned[2] && creator.length > 2) names.push(creator.slice(0, -1));
  return { kind: 'latest-video', creator, names };
}

function usable(element) {
  return element && typeof element.id === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(element.id) && !element.disabled;
}
function youtubeUrl(href) {
  try {
    const url = new URL(href);
    return YOUTUBE.test(url.hostname) ? url : null;
  } catch { return null; }
}
/** "/@MrBeast" for any link to that channel's own page, else null. */
function channelBase(href) {
  const url = youtubeUrl(href);
  const match = url && /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.exec(url.pathname);
  return match ? `/${match[1]}` : null;
}
function videoId(href) {
  const url = youtubeUrl(href);
  return url?.pathname === '/watch' && !url.searchParams.has('list') ? url.searchParams.get('v') : null;
}
/** Percent-decoded, or as written when the escape is malformed. */
const decode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
const sameBase = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  decode(a).toLowerCase() === decode(b).toLowerCase();
/** A channel page's title and heading carry decorations: "(3) MrBeast - YouTube", "MrBeast, Verified". */
const bare = (text) => String(text || '').replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/i, '').replace(/,?\s*verified$/i, '').trim();
/** Title links end in a spoken duration: "Lose 150 Lbs Together, Win $250,000 43 minutes". */
const title = (name) => String(name || '')
  .replace(/(?:\s+\d+\s+(?:hours?|minutes?|seconds?),?)+$/i, '').trim();
const possessive = (name) => /s$/i.test(name) ? `${name}’` : `${name}’s`;

/** Every name a link gives its channel: its label, a card's "Name @handle • …", the handle in its address. */
function channelNames(entry, base) {
  const names = [bare(entry.name)];
  const go = /^go to channel\s+(.+)$/i.exec(entry.name);
  if (go) names.push(go[1]);
  for (const text of [entry.name, entry.context || '']) {
    const card = /^(.+?)\s+@([\p{L}\p{N}._-]+)/u.exec(text);
    if (card) names.push(card[1], card[2]);
  }
  if (base.startsWith('/@')) names.push(decode(base.slice(2)));
  return names;
}

/** The one channel on a results page that bears the requested name. */
function chooseChannel(elements, named) {
  const byBase = new Map();
  for (const entry of elements) {
    if (entry.role !== 'link' || entry.offscreen) continue;
    const base = channelBase(entry.url);
    if (!base || !channelNames(entry, base).some(named)) continue;
    const key = decode(base).toLowerCase();
    if (!byBase.has(key)) byBase.set(key, { base, links: [] });
    byBase.get(key).links.push(entry);
  }
  let channels = [...byBase.values()];
  // A namesake can appear as a video's uploader; the channel card itself counts subscribers.
  if (channels.length > 1) {
    channels = channels.filter((channel) => channel.links.some((entry) =>
      /^go to channel\s/i.test(entry.name) || /\bsubscribers?\b/i.test(`${entry.name} ${entry.context || ''}`)));
  }
  if (channels.length > 1) return AMBIGUOUS;
  if (!channels.length) return null;
  const [channel] = channels;
  // Only a link labelled with just the channel's name: a card's long link quotes
  // its description ("SUBSCRIBE FOR A COOKIE!"), which reads as a sensitive press.
  const clean = channel.links.filter((entry) => named(bare(entry.name)) || /^go to channel\s/i.test(entry.name))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // The channel's own spelling, for the answer: "MrBeast", not the heard "MrBeasts".
  const label = channel.links.map((entry) => bare(entry.name.replace(/^go to channel\s+/i, ''))).find(named);
  return { base: channel.base, link: clean[0] || null, ...(label ? { name: label } : {}) };
}

/**
 * The first video of the grid, in document order. A budgeted observation can
 * leave controls out, and one missing between the sort chips and this link could
 * be the true first video: then nothing is chosen. A complete one has no gaps.
 * Titles are never filtered by their words: a premiere that cannot play yet is
 * caught by playback verification, and a newest video titled "Upcoming…" is not.
 */
function firstVideo(elements, after, complete) {
  const links = elements.filter((entry) => entry.role === 'link' && videoId(entry.url));
  if (!links.length) return null;
  if (!links.every((entry) => Number.isInteger(entry.order))) return AMBIGUOUS;
  const first = links.reduce((best, entry) => entry.order < best.order ? entry : best);
  const seen = new Set(elements.map((entry) => entry.order).filter(Number.isInteger));
  if (!complete) for (let order = after + 1; order < first.order; order++) if (!seen.has(order)) return AMBIGUOUS;
  return first.offscreen ? null : first;
}

/** Progress after a confirmed model action: from then on the planner only continues its own verified steps. */
export function noteModelStep(progress = {}) {
  const prior = progress?.version === VERSION ? progress : {};
  return { ...prior, version: VERSION, model: true };
}

/**
 * Returns one schema-valid proposed action and proposed progress, like the
 * episode planner: commit progress only after host.execute succeeds. null means
 * fall back to the model for this step; {wait: true} means the page has not yet
 * shown what the next step needs, so look again before asking the model.
 */
export function chooseYouTubeAction(intent, page, progress = {}) {
  if (intent?.kind !== 'latest-video' || page?.ok === false || !Array.isArray(page?.elements)) return null;
  const url = youtubeUrl(page.url);
  if (!url) {
    // Said on any other tab: YouTube first (its open tab, else a new one), once.
    const signature = `${scope(page)}|open-youtube`;
    const prior = progress?.version === VERSION ? progress : {};
    const attempted = Array.isArray(prior.attempted) ? prior.attempted.filter((value) => typeof value === 'string').slice(-12) : [];
    if (prior.model || attempted.includes(signature)) return null;
    return { action: { action: 'browser', op: 'open', url: 'https://www.youtube.com/' },
      progress: { ...prior, version: VERSION, attempted: [...attempted, signature].slice(-12) } };
  }
  // Navigation must stay on the task's origin, so addresses are built on the page's own.
  const origin = url.origin;
  const names = new Set((Array.isArray(intent.names) ? intent.names : [intent.creator]).map(compact).filter(Boolean));
  const named = (text) => names.has(compact(text));
  const elements = page.elements.filter(usable);
  const currentScope = scope(page);
  const prior = progress?.version === VERSION ? progress : {};
  const attempted = Array.isArray(prior.attempted) ? prior.attempted.filter((value) => typeof value === 'string').slice(-12) : [];
  const next = { version: VERSION, attempted: [...attempted],
    ...Object.fromEntries(['searched', 'model', 'channel', 'name', 'ready', 'opened'].filter((key) => prior[key]).map((key) => [key, prior[key]])) };
  function propose(action, patch = {}) {
    const signature = `${currentScope}|${JSON.stringify(action)}`;
    if (attempted.includes(signature)) return null;
    const framed = { ...action };
    if (action.elementId) {
      if (typeof page.pageId === 'string') framed.pageId = page.pageId;
      if (Number.isSafeInteger(page.revision) && page.revision >= 0) framed.revision = page.revision;
    }
    return { action: framed, progress: { ...next, ...patch, attempted: [...attempted, signature].slice(-12) } };
  }
  function search() {
    const fields = elements.filter((entry) => ['combobox', 'searchbox', 'textbox', 'input'].includes(entry.role) &&
      /^search$/i.test(entry.name.trim()) && !entry.offscreen);
    const field = fields.length === 1 ? fields[0] : null;
    const submitted = { searched: currentScope };
    if (field) {
      const step = named(field.value)
        ? propose({ action: 'press_key', elementId: field.id, key: 'Enter' }, submitted)
        : propose({ action: 'type', elementId: field.id, text: intent.creator });
      if (step) return step;
    }
    // No single search field, or it did not take: the results page has an address.
    return propose({ action: 'navigate', url: `${origin}/results?search_query=${encodeURIComponent(intent.creator)}` }, submitted);
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (prior.opened) {
    // The requested video was opened: its own page playing is the goal.
    if (currentScope === prior.opened.from) return WAIT;
    if (path !== '/watch' || url.searchParams.get('v') !== prior.opened.videoId) return null;
    const videos = elements.filter((entry) => entry.role === 'video');
    if (videos.some((entry) => entry.playing === true && entry.paused !== true)) {
      const pageTitle = bare(page.title);
      const name = pageTitle && !/^youtube$/i.test(pageTitle) ? pageTitle : prior.opened.title;
      const ad = videos.some((entry) => /\bsponsored\b|\bskip ad\b/i.test(entry.context || ''));
      return { action: { action: 'finish', success: true,
        say: `Playing ${possessive(prior.name || intent.creator)} latest video${name ? `, “${name}”` : ''}${ad ? ', after the ad' : ''}.` },
        progress: next, done: true };
    }
    if (videos.length && videos.every((entry) => entry.paused === true)) return propose({ action: 'command', actionId: 'PLAY' });
    return WAIT;
  }

  if (path === '/results' && named(url.searchParams.get('search_query'))) {
    // No result links at all is a page still rendering; results without the channel are the model's to judge.
    if (!elements.some((entry) => entry.role === 'link' && (channelBase(entry.url) || videoId(entry.url)))) return WAIT;
    const channel = chooseChannel(elements, named);
    if (channel === AMBIGUOUS || !channel) return null;
    const found = { channel: channel.base, ...(channel.name ? { name: channel.name } : {}) };
    return (channel.link && propose({ action: 'click', elementId: channel.link.id }, found)) ||
      propose({ action: 'navigate', url: `${origin}${channel.base}/videos` }, found);
  }

  const onChannel = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/([^/]+))?$/.exec(path);
  const base = onChannel && `/${onChannel[1]}`;
  const ours = base && (sameBase(prior.channel, base) || (base.startsWith('/@') && named(decode(base.slice(2)))) ||
    named(bare(page.title)) || elements.some((entry) => entry.role === 'heading' && named(bare(entry.name))));
  // Once the search has gone through, or the model has acted, an unrecognized
  // page is the model's (say, a channel whose name was only partly heard): never
  // search again over its work. A submit that went nowhere still gets its fallback.
  if (!ours) return prior.model || (prior.searched && prior.searched !== currentScope) ? null : search();
  const patch = { channel: base, ...(!prior.name && named(bare(page.title)) ? { name: bare(page.title) } : {}) };
  const videosTabs = elements.filter((entry) => entry.role === 'tab' && /^videos$/i.test(entry.name.trim()));
  if ((onChannel[2] || '').toLowerCase() !== 'videos') {
    return (videosTabs.length === 1 && propose({ action: 'click', elementId: videosTabs[0].id }, patch)) ||
      propose({ action: 'navigate', url: `${origin}${base}/videos` }, patch);
  }
  // The address changes before the tab does: until the Videos tab shows as
  // selected, the grid on screen can still be the tab just left.
  if (prior.ready !== currentScope && videosTabs.length && !videosTabs.some((entry) => entry.selected === true)) return WAIT;
  const ready = { ...patch, ready: currentScope };
  const latest = elements.filter((entry) => entry.role === 'tab' && /^latest$/i.test(entry.name.trim()));
  // Another sort is chosen. A reload starts on Latest; re-sorting in place
  // leaves the old order on screen for a moment, with Latest already selected.
  if (latest.length === 1 && latest[0].selected === false) {
    return propose({ action: 'navigate', url: `${origin}${base}/videos` }, ready);
  }
  // The grid follows the channel's tabs and sort chips, in any language.
  const tabs = elements.filter((entry) => entry.role === 'tab').map((entry) => entry.order).filter(Number.isInteger);
  const first = firstVideo(elements, tabs.length ? Math.max(...tabs) : -1, page.truncated === false);
  if (first === AMBIGUOUS) return null;
  if (first) {
    return propose({ action: 'click', elementId: first.id },
      { ...ready, opened: { videoId: videoId(first.url), title: title(first.name), from: currentScope } });
  }
  // The grid starts below the fold in a short window.
  return propose({ action: 'scroll', direction: 'down', amount: 0.5 }, ready);
}
