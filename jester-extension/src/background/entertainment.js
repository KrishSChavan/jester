/** Exact semantic entertainment shortcuts. Uncertain observations fall back to the agent. */
const ROLES = new Set(['button', 'link', 'option', 'tab', 'menuitem', 'combobox']);
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };
const NUMBER = '(?:[0-9]{1,3}(?:st|nd|rd|th)?|' + [...Object.keys(NUMBERS), ...Object.keys(ORDINALS)].join('|') + ')';
const VERSION = 1;
const normalize = (text) => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const number = (text) => NUMBERS[text] ?? ORDINALS[text] ?? Number(text.replace(/(?:st|nd|rd|th)$/, ''));
const scope = (page) => `${page.pageId || ''}|${page.url || ''}`;

/** Deliberately accepts only a named show plus explicit season and episode. */
export function parseEntertainmentIntent(text) {
  if (typeof text !== 'string' || text.length > 500) return null;
  let input = text.trim().replace(/^(?:hey\s+)?jester[:,]?\s+/i, '')
    .replace(/\s*,?\s+please[.!?]?$/i, '').replace(/[.!?]+$/, '');
  // On-device dictation adds punctuation and users naturally include a polite
  // request. Strip only explicit wrappers; retain the complete playback task.
  const polite = /^(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:\s+would|['’]d)\s+like\s+(?:you\s+)?to\s+|i\s+want\s+(?:you\s+)?to\s+)/i;
  input = input.replace(polite, '').replace(polite, '');
  const verb = '(?:play|watch|start|put\\s+on|go\\s+to)';
  const gap = '[\\s,;:]+';
  const before = new RegExp(`^${verb}\\s+(?:the\\s+)?season\\s+(${NUMBER})${gap}episode\\s+(${NUMBER})\\s+(?:of|from)\\s+(.+)$`, 'i').exec(input);
  const after = before ? null : new RegExp(`^${verb}\\s+(.+?)${gap}season\\s+(${NUMBER})${gap}episode\\s+(${NUMBER})$`, 'i').exec(input);
  const ordered = before || after ? null : new RegExp(`^${verb}\\s+(?:the\\s+)?(${NUMBER})\\s+episode\\s+(?:of|from)\\s+(?:the\\s+)?(${NUMBER})\\s+season\\s+(?:of|from)\\s+(.+)$`, 'i').exec(input);
  if (!before && !after && !ordered) return null;
  const show = (before ? before[3] : after ? after[1] : ordered[3]).trim().replace(/^["“](.*)["”]$/, '$1');
  const season = number((before ? before[1] : after ? after[2] : ordered[2]).toLowerCase());
  const episode = number((before ? before[2] : after ? after[3] : ordered[1]).toLowerCase());
  if (!show || show.length > 180 || !normalize(show) || !(season > 0 && season <= 999) || !(episode > 0 && episode <= 999)) return null;
  return { kind: 'play-episode', show, season, episode };
}

function usable(element) {
  return element && typeof element.id === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(element.id) && !element.disabled;
}
function exactTitle(text, show) {
  return normalize(text) === normalize(show);
}
function showControlTitle(text, show) {
  const value = normalize(text).replace(/^(?:view details for|details for|more info for)\s+/, '');
  const title = normalize(show);
  if (value === title) return true;
  if (!value.startsWith(title + ' ')) return false;
  // Catalog cards may append ratings/year/counts. Only complete known metadata
  // is accepted; a title suffix such as "The Anime" must still fall back.
  return /^(?:(?:tv (?:y|y7|g|pg|14|ma)|(?:19|20)\d{2}|\d{1,3} (?:seasons?|episodes?)|series|details)(?:\s+|$))+$/.test(value.slice(title.length + 1));
}
function withoutPrefix(text) {
  return String(text || '').trim().replace(/^(?:watch|play|continue watching|resume)\s+/i, '');
}
/** A title may be followed by metadata, but never by another title suffix. */
function startsWithShow(text, show) {
  const value = normalize(withoutPrefix(text));
  const title = normalize(show);
  if (value === title) return true;
  if (!value.startsWith(title + ' ')) return false;
  return /^(?:season\b|episode\b|s\d+(?:e\d+)?\b|e\d+\b|play\b|watch\b|resume\b)/.test(value.slice(title.length + 1));
}
function markers(text, kind) {
  const value = normalize(text);
  const expression = kind === 'season' ? /\bseason\s+(\d+)\b|\bs(\d+)\b/g : /\bepisode\s+(\d+)\b|\be(\d+)\b/g;
  const values = new Set([...value.matchAll(expression)].map((match) => Number(match[1] || match[2])));
  for (const match of value.matchAll(/\bs(\d+)e(\d+)\b/g)) values.add(Number(match[kind === 'season' ? 1 : 2]));
  return values;
}
function hasOne(text, kind, desired) {
  const found = markers(text, kind);
  return found.size === 1 && found.has(desired);
}
function seasonNumber(label) {
  // Pickers commonly append an episode count. Recognize that complete known
  // suffix without interpreting a title, an episode number, or arbitrary text.
  const match = /^(?:season\s+)?0*(\d+)(?:\s+\d+\s+episodes?)?$/.exec(normalize(label));
  return match ? Number(match[1]) : null;
}
function seasonLabel(label) {
  return /^season\s+\d+(?:\s+\d+\s+episodes?)?$/.test(normalize(label));
}
function seasonMenuLabel(label) {
  return seasonLabel(label) || /^(?:seasons?(?:\s+(?:selector|picker))?|(?:select|choose)(?:\s+a)?\s+season)$/.test(normalize(label));
}
function episodeNumber(label) {
  const name = normalize(withoutPrefix(label));
  const match = /^(?:season\s+\d+\s+)?episode\s+0*(\d+)\b|^s\d+\s*e0*(\d+)\b|^0*(\d+)\s/.exec(name);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}
function titlePart(text) {
  return String(text || '').split(/\s+[|–—]\s+|\s+-\s+/)[0];
}
function identity(text, intent) {
  return startsWithShow(text, intent.show) && hasOne(text, 'season', intent.season) && hasOne(text, 'episode', intent.episode);
}
function unique(items) {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  return byId.size === 1 ? [...byId.values()][0] : null;
}
function ambiguous(items) { return new Set(items.map((entry) => entry.id)).size > 1; }
function notExtra(element) {
  return !/\b(?:trailer|teaser|recap|preview|clip|bonus|behind the scenes)\b/.test(normalize(element.name));
}
/** A player naming a different season or episode is not the requested one. */
function namesOtherEpisode(text, intent) {
  const seasons = markers(text, 'season');
  const episodes = markers(text, 'episode');
  return (seasons.size > 0 && !(seasons.size === 1 && seasons.has(intent.season))) ||
    (episodes.size > 0 && !(episodes.size === 1 && episodes.has(intent.episode)));
}
/** The page itself is about the show: its title, its address, a heading, or a control named for it. */
function aboutShow(page, show) {
  const phrase = ` ${normalize(show)} `;
  let path = '';
  try { path = decodeURIComponent(new URL(page.url).pathname); } catch { /* no usable address */ }
  return [page.title, path].some((text) => ` ${normalize(text)} `.includes(phrase)) ||
    page.elements.some((entry) => (entry?.role === 'heading' && startsWithShow(entry.name, show)) ||
      exactTitle(entry?.name, show));
}
/**
 * The players already on the page an episode was opened from, such as a trailer:
 * they are not that episode. Element IDs change with the address, so after the
 * click navigates, every player is new.
 */
function openedFrom(videos) {
  return { videos: videos.map((video) => video.id).slice(0, 8) };
}
function readOpened(prior) {
  const opened = prior.opened;
  return opened && typeof opened === 'object' && Array.isArray(opened.videos)
    ? { videos: opened.videos.filter((id) => typeof id === 'string').slice(0, 8) }
    : null;
}
function searchLabel(text, page) {
  const label = normalize(text);
  if (/^(?:(?:open|go to)\s+)?search(?:\s+(?:for|shows?|titles?|movies?|tv|videos?|the|site|catalog|catalogue|and|or|more))*$/.test(label)) return true;
  // A branded navigation label is useful only on that service's own origin.
  try {
    const host = new URL(page.url).hostname;
    return /^(?:www\.)?hulu\.com$/.test(host) && label === 'search hulu';
  } catch { return false; }
}

/** A covered exact-show link may have a sibling Details link above it. Only
 * recover using host-reported, identical destinations and a fresh visible ID. */
export function chooseEntertainmentRecovery(intent, page, failed, progress = {}) {
  if (!intent || failed?.errorClass !== 'covered_target' || failed.notDispatched !== true ||
      failed.uncertain === true || failed.action?.action !== 'click' ||
      failed.pageId !== page?.pageId || !Array.isArray(page?.elements) ||
      !Array.isArray(failed.blockingElements)) return null;
  // The exact source was observed before the failed press. Hover can remove it
  // or change its surrounding card text, and a compact observation can omit it.
  // The actual covering link must still have its original live identity below.
  const source = failed.target;
  if (!usable(source) || source.id !== failed.action.elementId || source.role !== 'link' ||
      !source.url || !showControlTitle(source.name, intent.show)) return null;
  const currentSource = page.elements.find(entry => entry.id === source.id);
  if (currentSource && (currentSource.role !== source.role || currentSource.name !== source.name ||
      currentSource.url !== source.url)) return null;
  const reported = failed.blockingElements.filter(entry => usable(entry) && entry.role === 'link' &&
    entry.sameDestination === true && entry.url === source.url);
  const prior = progress?.version === VERSION ? progress : {};
  const queries = Array.isArray(prior.queries) ? prior.queries.filter(value => typeof value === 'string').slice(-4) : [];
  const candidates = page.elements.filter(entry => usable(entry) && !entry.offscreen &&
    entry.role === 'link' && entry.id !== source.id && entry.url === source.url &&
    reported.some(blocker => blocker.id === entry.id && blocker.name === entry.name));
  const blocker = unique(candidates);
  if (!blocker) {
    // A compact observation can omit a generic Details link. Retrieve its
    // reported ID once through the normal host before proposing any click.
    const missing = unique(reported);
    const key = missing && `${scope(page)}|covered-link:${missing.id}`;
    if (!missing || page.elements.some(entry => entry.id === missing.id) || queries.includes(key)) return null;
    return {action:{action:'read_element',elementId:missing.id,pageId:page.pageId,revision:page.revision},
      progress:{...prior,version:VERSION,queries:[...queries,key].slice(-4)}};
  }
  const action = {action:'click',elementId:blocker.id};
  const attempted = Array.isArray(prior.attempted) ? prior.attempted.filter(value => typeof value === 'string') : [];
  if (attempted.includes(`${scope(page)}|${JSON.stringify(action)}`)) return null;
  return {action:{...action,pageId:page.pageId,revision:page.revision},progress:{
    ...prior,version:VERSION,
    attempted:[...attempted,
      `${scope(page)}|${JSON.stringify({action:'click',elementId:source.id})}`,
      `${scope(page)}|${JSON.stringify(action)}`].slice(-12),
    queries
  }};
}

/**
 * Progress after a confirmed click on a control that itself names the requested
 * season and episode, on a page about the requested show: the player that starts
 * next is then that episode. null for any other control.
 */
export function noteEpisodeOpened(intent, page, target, progress = {}) {
  if (!intent || intent.kind !== 'play-episode' || !Array.isArray(page?.elements) || !usable(target) ||
      !ROLES.has(target.role) || !notExtra(target) || episodeNumber(target.name) !== intent.episode) return null;
  const text = `${target.name} ${target.context || ''}`;
  if (!hasOne(text, 'season', intent.season) || !hasOne(text, 'episode', intent.episode)) return null;
  // A card from another title names that title first.
  if (target.context && !/^(?:season\b|episode\b|s\d+\b|e\d+\b|\d+\b)/.test(normalize(target.context)) &&
      !startsWithShow(target.context, intent.show)) return null;
  if (!startsWithShow(text, intent.show) && !aboutShow(page, intent.show)) return null;
  const prior = progress?.version === VERSION ? progress : {};
  return { ...prior, version: VERSION,
    opened: openedFrom(page.elements.filter((entry) => entry?.role === 'video' && usable(entry))) };
}

/**
 * Returns one schema-valid proposed action and proposed progress. Commit progress
 * only after host.execute succeeds. Never execute here: the host must enforce the
 * same permissions/checkpointing as model actions. null means fall back unchanged.
 * For find_text, feed its structured result (or a queried observation) back here.
 */
export function chooseEntertainmentAction(intent, page, progress = {}) {
  if (!intent || intent.kind !== 'play-episode' || !parseEntertainmentIntent(`play ${intent.show} season ${intent.season} episode ${intent.episode}`) ||
      page?.ok === false || !Array.isArray(page?.elements)) return null;
  const elements = page.elements.filter(usable).slice(0, 100);
  const currentScope = scope(page);
  const prior = progress?.version === VERSION ? progress : {};
  const attempted = Array.isArray(prior.attempted) ? prior.attempted.filter((value) => typeof value === 'string').slice(-12) : [];
  const queries = Array.isArray(prior.queries) ? prior.queries.filter((value) => typeof value === 'string').slice(-4) : [];
  const opened = readOpened(prior);
  const next = { version: VERSION, attempted: [...attempted], queries: [...queries], ...(opened ? { opened } : {}),
    ...(prior.seasonScope === currentScope && prior.season === intent.season ? { season: prior.season, seasonScope: currentScope } : {}) };
  function propose(action, patch = {}) {
    const signature = `${currentScope}|${JSON.stringify(action)}`;
    if (attempted.includes(signature)) return null;
    const framed = { ...action };
    if (action.elementId || action.action === 'find_text') {
      if (typeof page.pageId === 'string') framed.pageId = page.pageId;
      if (Number.isSafeInteger(page.revision) && page.revision >= 0) framed.revision = page.revision;
    }
    return { action: framed, progress: { ...next, ...patch, attempted: [...attempted, signature].slice(-12) } };
  }
  function find(query) {
    const key = `${currentScope}|${normalize(query)}`;
    if (queries.includes(key)) return null;
    return propose({ action: 'find_text', query }, { queries: [...queries, key].slice(-4) });
  }

  // Playing alone is insufficient: identity must describe the player itself or
  // the document's active-media title, never a matching card elsewhere on a page.
  const videos = elements.filter((entry) => entry.role === 'video');
  const playerTitle = titlePart(page.title);
  const exactPlayers = videos.filter((video) => notExtra({ name: `${video.name} ${video.context || ''}` }) &&
    (identity(video.name, intent) || identity(video.context, intent) || identity(`${video.name} ${video.context || ''}`, intent) ||
      (videos.length === 1 && identity(playerTitle, intent))));
  if (exactPlayers.length === 1 && exactPlayers[0].playing === true && exactPlayers[0].paused !== true) {
    return { action: { action: 'finish', success: true,
      say: `Playing ${intent.show}, season ${intent.season}, episode ${intent.episode}.` }, progress: next, done: true };
  }
  if (exactPlayers.length === 1 && exactPlayers[0].paused === true) return propose({ action: 'command', actionId: 'PLAY' });
  if (opened) {
    // The requested episode's own control was activated. A player that appears
    // after that is the episode unless it names another one; until then, wait.
    const started = videos.filter((video) => !opened.videos.includes(video.id) &&
      notExtra({ name: `${video.name} ${video.context || ''}` }) &&
      !namesOtherEpisode(`${video.name} ${video.context || ''} ${videos.length === 1 ? playerTitle : ''}`, intent));
    const playing = started.filter((video) => video.playing === true && video.paused !== true);
    if (playing.length === 1) {
      return { action: { action: 'finish', success: true,
        say: `Playing ${intent.show}, season ${intent.season}, episode ${intent.episode}.` }, progress: next, done: true };
    }
    if (started.length === 1 && started[0].paused === true) return propose({ action: 'command', actionId: 'PLAY' });
    return null;
  }

  const headings = elements.filter((entry) => entry.role === 'heading');
  const controls = elements.filter((entry) => ROLES.has(entry.role));
  const seasonSelects = elements.filter((entry) => Array.isArray(entry.options) &&
    (/\bseasons?\b/.test(normalize(entry.name)) ||
      (entry.options.length > 0 && entry.options.every((option) => seasonLabel(option.label)))));
  const seasonSection = seasonSelects.length > 0 ||
    controls.some((entry) => seasonMenuLabel(entry.name)) ||
    headings.some((entry) => seasonLabel(entry.name) || /^episodes?$/.test(normalize(entry.name)));
  const showPage = startsWithShow(playerTitle, intent.show) ||
    (headings.some((entry) => exactTitle(entry.name, intent.show)) && seasonSection);

  if (!showPage) {
    // An exact title control is safer than the ambiguous Play buttons on a grid.
    const titles = controls.filter((entry) => showControlTitle(entry.name, intent.show));
    if (ambiguous(titles)) return null;
    const title = unique(titles);
    if (title) return propose({ action: 'click', elementId: title.id });
    const searches = elements.filter((entry) => entry.role === 'searchbox' ||
      (['textbox', 'input'].includes(entry.role) && searchLabel(entry.name, page)));
    if (ambiguous(searches)) return null;
    const search = unique(searches);
    if (search) {
      if (!exactTitle(search.value, intent.show)) return propose({ action: 'type', elementId: search.id, text: intent.show });
      return propose({ action: 'press_key', elementId: search.id, key: 'Enter' });
    }
    const searchButtons = controls.filter((entry) => searchLabel(entry.name, page));
    if (ambiguous(searchButtons)) return null;
    const searchButton = unique(searchButtons);
    if (searchButton) return propose({ action: 'click', elementId: searchButton.id });
    return find(intent.show);
  }

  if (ambiguous(seasonSelects)) return null;
  const select = unique(seasonSelects);
  // A successful dispatch is not evidence that the episode pane changed.
  // Progress only prevents duplicate actions; active season comes from this
  // observation, including conflicting old headings during asynchronous updates.
  const activeSeasons = new Set();
  for (const entry of elements) {
    const value = seasonNumber(entry.name);
    if (!seasonLabel(entry.name) || value === null) continue;
    const activeHeading = entry.role === 'heading';
    const activeTab = ['tab', 'option'].includes(entry.role) && entry.selected === true;
    const collapsedSelector = ['button', 'combobox'].includes(entry.role) && entry.expanded === false;
    if (activeHeading || activeTab || collapsedSelector) activeSeasons.add(value);
  }
  if (select) {
    for (const option of select.options) {
      const value = seasonNumber(option.label);
      if (option.selected && value !== null) activeSeasons.add(value);
    }
  }
  if (activeSeasons.size > 1) return null;
  let seasonReady = activeSeasons.size === 1 && activeSeasons.has(intent.season);
  if (select) {
    const matches = select.options.filter((option) => seasonNumber(option.label) === intent.season && typeof option.value === 'string' && !option.disabled);
    if (matches.length !== 1) return null;
    if (!matches[0].selected) return propose({ action: 'select', elementId: select.id, value: matches[0].value },
      { season: intent.season, seasonScope: currentScope });
    seasonReady = true;
  }
  if (!seasonReady) {
    const requestedSeasons = controls.filter((entry) => seasonLabel(entry.name) && seasonNumber(entry.name) === intent.season);
    if (ambiguous(requestedSeasons)) return null;
    const requested = unique(requestedSeasons);
    if (requested) return propose({ action: 'click', elementId: requested.id }, { season: intent.season, seasonScope: currentScope });
    const seasonMenus = controls.filter((entry) => seasonMenuLabel(entry.name));
    if (ambiguous(seasonMenus)) return null;
    const menu = unique(seasonMenus);
    if (menu) return propose({ action: 'click', elementId: menu.id });
  }

  const episodes = controls.filter((entry) => {
    if (!notExtra(entry)) return false;
    const name = normalize(entry.name);
    const context = `${entry.name} ${entry.context || ''}`;
    const directEpisode = episodeNumber(entry.name) === intent.episode;
    const play = /^(?:play|watch|resume)(?: episode)?$/.test(name) && hasOne(entry.context, 'episode', intent.episode);
    if (!directEpisode && !play) return false;
    const seasons = markers(context, 'season');
    const episodeMarkers = markers(context, 'episode');
    if (seasons.size && !(seasons.size === 1 && seasons.has(intent.season))) return false;
    if (episodeMarkers.size && !(episodeMarkers.size === 1 && episodeMarkers.has(intent.episode))) return false;
    // A show-linked card from another title is never a target, even if this
    // page also contains the requested show's heading somewhere else.
    if (entry.context &&
      !/^(?:season\b|episode\b|s\d+\b|e\d+\b|\d+\b)/.test(normalize(entry.context)) &&
      !startsWithShow(entry.context, intent.show)) return false;
    return seasonReady || (seasons.size === 1 && seasons.has(intent.season) && startsWithShow(entry.context, intent.show));
  });
  if (ambiguous(episodes)) return null;
  const episode = unique(episodes);
  if (episode) return propose({ action: 'click', elementId: episode.id }, { opened: openedFrom(videos) });
  return find(`${intent.show} season ${intent.season} episode ${intent.episode}`);
}
