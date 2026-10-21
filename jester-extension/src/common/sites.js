/**
 * Sites people name by voice ("open Gmail", "search Amazon for…"), and which
 * open tab counts as already being on one. Anything not listed is left to the
 * model, which knows addresses; a spoken domain ("github.com") needs neither.
 */
const LIST = [
  // key, spoken names, address, search address (the query is appended, encoded)
  ['youtube', ['youtube', 'you tube'], 'https://www.youtube.com/', 'https://www.youtube.com/results?search_query='],
  ['youtube music', ['youtube music'], 'https://music.youtube.com/', 'https://music.youtube.com/search?q='],
  ['gmail', ['gmail', 'g mail', 'google mail', 'my gmail'], 'https://mail.google.com/', null],
  ['google', ['google'], 'https://www.google.com/', 'https://www.google.com/search?q='],
  ['google docs', ['google docs', 'docs', 'my docs'], 'https://docs.google.com/document/', null],
  ['google sheets', ['google sheets', 'sheets'], 'https://docs.google.com/spreadsheets/', null],
  ['google slides', ['google slides', 'slides'], 'https://docs.google.com/presentation/', null],
  ['google drive', ['google drive', 'drive', 'my drive'], 'https://drive.google.com/', null],
  ['google calendar', ['google calendar', 'calendar', 'my calendar'], 'https://calendar.google.com/', null],
  ['google maps', ['google maps', 'maps'], 'https://www.google.com/maps', 'https://www.google.com/maps/search/'],
  ['google photos', ['google photos', 'photos', 'my photos'], 'https://photos.google.com/', null],
  ['netflix', ['netflix'], 'https://www.netflix.com/', 'https://www.netflix.com/search?q='],
  ['hulu', ['hulu'], 'https://www.hulu.com/', null],
  ['disney plus', ['disney plus', 'disney+', 'disneyplus'], 'https://www.disneyplus.com/', null],
  ['prime video', ['prime video', 'amazon prime video', 'amazon prime'], 'https://www.primevideo.com/', null],
  ['max', ['hbo max', 'max'], 'https://play.max.com/', null],
  ['crunchyroll', ['crunchyroll'], 'https://www.crunchyroll.com/', null],
  ['twitch', ['twitch'], 'https://www.twitch.tv/', 'https://www.twitch.tv/search?term='],
  ['vimeo', ['vimeo'], 'https://vimeo.com/', 'https://vimeo.com/search?q='],
  ['spotify', ['spotify'], 'https://open.spotify.com/', 'https://open.spotify.com/search/'],
  ['amazon', ['amazon'], 'https://www.amazon.com/', 'https://www.amazon.com/s?k='],
  ['ebay', ['ebay', 'e bay'], 'https://www.ebay.com/', 'https://www.ebay.com/sch/i.html?_nkw='],
  ['reddit', ['reddit'], 'https://www.reddit.com/', 'https://www.reddit.com/search/?q='],
  ['wikipedia', ['wikipedia'], 'https://www.wikipedia.org/', 'https://en.wikipedia.org/w/index.php?search='],
  ['github', ['github', 'git hub'], 'https://github.com/', 'https://github.com/search?q='],
  ['x', ['twitter', 'x', 'x dot com'], 'https://x.com/', 'https://x.com/search?q='],
  ['facebook', ['facebook'], 'https://www.facebook.com/', 'https://www.facebook.com/search/top?q='],
  ['instagram', ['instagram'], 'https://www.instagram.com/', null],
  ['linkedin', ['linkedin', 'linked in'], 'https://www.linkedin.com/', 'https://www.linkedin.com/search/results/all/?keywords='],
  ['pinterest', ['pinterest'], 'https://www.pinterest.com/', 'https://www.pinterest.com/search/pins/?q='],
  ['chatgpt', ['chatgpt', 'chat gpt'], 'https://chatgpt.com/', null],
  ['claude', ['claude'], 'https://claude.ai/', null],
  ['outlook', ['outlook'], 'https://outlook.live.com/', null],
  ['whatsapp', ['whatsapp', 'whats app'], 'https://web.whatsapp.com/', null],
  ['discord', ['discord'], 'https://discord.com/app', null]
];

export const SITES = Object.freeze(LIST.map(([key, names, url, search]) => Object.freeze({ key, names, url, search })));

const spoken = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[’']/g, '')
  .replace(/[^\p{L}\p{N}+.]+/gu, ' ').trim().replace(/\s+/g, ' ');
const bareHost = (host) => host.replace(/^www\./, '');

/** The listed site a spoken name means: "gmail", "my calendar", "Disney+". */
export function siteNamed(name) {
  const value = spoken(name).replace(/^(?:the|my)\s+/, '').replace(/\s+(?:website|site|app)$/, '');
  return SITES.find((site) => site.names.includes(value)) || null;
}

/**
 * A spoken address: "github.com", "amazon dot com slash deals", "en.wikipedia.org/wiki/Moon".
 * Returns an https URL, or null for anything that is not plainly a host name.
 */
export function spokenAddress(text) {
  // Paths are case-sensitive ("/wiki/Moon"); the URL parser lowercases the host itself.
  const value = String(text || '').trim()
    .replace(/\s+dot\s+/gi, '.').replace(/\s+slash\s+/gi, '/').replace(/^https?:\/\//i, '');
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:[/?#]\S*)?$/i.test(value)) return null;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname.includes('.') ? url.href : null;
  } catch { return null; }
}

/** The most specific listed site an address belongs to: maps.google… is Maps, not Google. */
export function siteOf(address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  let best = null;
  for (const site of SITES) {
    const home = new URL(site.url);
    if (bareHost(home.hostname) !== bareHost(url.hostname)) continue;
    const prefix = home.pathname.replace(/\/$/, '');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best.prefix.length) best = { site, prefix };
  }
  return best?.site || null;
}

/** A listed site's own search for a query, or null where it has none. */
export function siteSearch(site, query) {
  if (!site?.search) return null;
  return `${site.search}${encodeURIComponent(String(query).trim())}`;
}

/**
 * Whether an open tab already shows what an address asks for: for a site's home
 * ("open YouTube"), any page of that site; for anything more specific, that page.
 */
export function showsAddress(tabUrl, address) {
  let tab;
  let wanted;
  try { tab = new URL(tabUrl); wanted = new URL(address); } catch { return false; }
  if (!/^https?:$/.test(tab.protocol)) return false;
  const site = siteOf(address);
  const home = site ? new URL(site.url).href === wanted.href : wanted.pathname === '/' && !wanted.search && !wanted.hash;
  if (home) return site ? siteOf(tab.href) === site : bareHost(tab.hostname) === bareHost(wanted.hostname);
  const strip = (url) => `${bareHost(url.hostname)}${url.pathname.replace(/\/$/, '')}${url.search}`;
  return strip(tab) === strip(wanted);
}
