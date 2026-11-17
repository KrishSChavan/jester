/**
 * Reading the web without changing a tab, taking focus, or attaching a debugger.
 * Public pages use ordinary anonymous requests. Pages on an already-open origin
 * are read in its isolated content-script world, where Chrome keeps the user's
 * existing session. Cookies, page scripts and form values never leave that world.
 * Scrapling is the preferred public-page backend when the desktop is available;
 * this reader also works when it isn't.
 */

export const WEB_READER_LIMITS = Object.freeze({ text: 16000, links: 30, tabs: 40, search: 6, bytes: 1000000, timeoutMs: 15000 });

const tidy = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const abortError = () => Object.assign(new Error('Web reading cancelled.'), { name: 'AbortError' });
const failure = (code, detail) => ({ ok: false, code, detail });
const secret = (text) => String(text)
  .replace(/\b(?:sk-|gsk_)[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
  .replace(/\bBearer\s+[\w.+/-]+/gi, '[redacted]')
  .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
  .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]');

/** DNS resolution isn't exposed to extension workers; Chrome enforces transport. */
export function webReadAddress(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.length > 4096) return null;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  // Literal addresses are unnecessary for research and allow too many alternate
  // representations of loopback/private networks. URL normalizes integer IPv4.
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  if (/(?:^|[/?&=_-])(?:logout|log-out|signout|sign-out|delete|unsubscribe)(?:$|[/?&=_-])/i.test(url.pathname + url.search)) return null;
  if ([...url.searchParams.keys()].some((key) => /^(?:access_token|token|api_key|password|secret|auth|authorization|code)$/i.test(key))) return null;
  return url;
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, part) => {
    if (part[0] !== '#') return named[part.toLowerCase()] ?? ' ';
    const number = part[1].toLowerCase() === 'x' ? parseInt(part.slice(2), 16) : parseInt(part.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
  });
}

function htmlText(html, max = WEB_READER_LIMITS.text) {
  return secret(decodeEntities(String(html).replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|textarea|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:input|meta)\b[^>]*>/gi, ' ')
    .replace(/<\/?(?:p|div|h[1-6]|li|tr|br|section|article|main)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function anchors(html, base, max = WEB_READER_LIMITS.links) {
  const found = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!href) continue;
    let url;
    try { url = new URL(decodeEntities(href[1] ?? href[2] ?? href[3]), base); } catch { continue; }
    // DuckDuckGo redirects must become actual evidence URLs, never redirector links.
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.searchParams.has('uddg')) {
      try { url = new URL(url.searchParams.get('uddg')); } catch { continue; }
    }
    const safe = webReadAddress(url.href);
    if (!safe || seen.has(safe.href)) continue;
    seen.add(safe.href);
    found.push({ url: safe.href, text: tidy(htmlText(match[2]), 200), attributes: match[1] });
    if (found.length >= max) break;
  }
  return found;
}

/** Public HTML parsing is bounded and doesn't execute document code. */
export function parseWebHtml(html, url, { status = 200, fetchedAt = new Date().toISOString(), search = false } = {}) {
  const title = htmlText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] || '', 300);
  const text = htmlText(html);
  const all = anchors(html, url, search ? 100 : WEB_READER_LIMITS.links);
  const links = all.slice(0, WEB_READER_LIMITS.links).map(({ attributes, ...entry }) => entry);
  const page = { ok: !!text, url, title, text, links, status, fetchedAt, mode: 'browser-fetch', truncated: text.length >= WEB_READER_LIMITS.text };
  if (/^(?:just a moment|attention required|access denied|security check|verify (?:you are|you're) human)/i.test(title) || (text.length < 1200 && /checking your browser|verify (?:you are|you're) (?:a )?human|complete (?:the |a )?captcha/i.test(text))) {
    return { ...page, ...failure('browser_needed', 'This site returned a browser verification page instead of the requested information.') };
  }
  const emptyApp = /<(?:div|main)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\b(?:root|app|__next|application)\b[^"']*["'][^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<\/(?:div|main)\s*>/i.test(html);
  if (text.length < 600 && (/enable javascript|javascript (?:is required|must be enabled)|requires javascript|you need javascript/i.test(html) || (emptyApp && /<script\b/i.test(html)))) {
    return { ...page, ...failure('needs_rendering', 'This site returned a JavaScript shell; its requested data is not present in the background response.') };
  }
  if (!text) return { ...page, ...failure('empty_page', 'This page has no readable text without rendering it.') };
  if (search) {
    // Each result read from its own stretch of the page, from its link to the next one's, so a snippet is never
    // another result's. An ad's link has no real address in it (a y.js with no uddg), so it's dropped with its
    // snippet: reading one would count as a click on it.
    const marks = [...html.matchAll(/<a\b[^>]*class\s*=\s*["'][^"']*\bresult__a\b[^>]*>/gi)];
    const results = [];
    for (const [index, mark] of marks.entries()) {
      if (results.length >= WEB_READER_LIMITS.search) break;
      const block = html.slice(mark.index, marks[index + 1]?.index ?? html.length);
      const [link] = anchors(block, url, 1);
      if (!link || /(^|\.)duckduckgo\.com$/i.test(new URL(link.url).hostname) || results.some((entry) => entry.url === link.url)) continue;
      const snippet = /<(?:a|div|span)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)\s*>/i.exec(block)?.[1];
      results.push({ url: link.url, title: link.text, snippet: snippet ? htmlText(snippet, 500) : '' });
    }
    if (!results.length) return { ...page, ...failure('search_unavailable', 'Background search returned no usable results. It may require a browser check.'), results: [] };
    return { ...page, results, links: results.map(({ url: href, title: name }) => ({ url: href, text: name })), text: results.map((entry, index) => `${index + 1}. ${entry.title}\n${entry.url}\n${entry.snippet}`).join('\n\n') };
  }
  return page;
}

/**
 * Entirely self-contained: Chrome serializes this function into an ISOLATED
 * world. It reads the live DOM or fetches a same-origin document with that tab's
 * session. No eval, page script, click, navigation or debugger is involved.
 */
export async function readInTab(request, limits) {
  const fail = (code, detail) => ({ ok: false, code, detail });
  const redact = (value, max) => String(value ?? '').replace(/\b(?:sk-|gsk_)[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[\w.+/-]+/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, max);
  const url = new URL(request.url);
  if (url.origin !== location.origin) return fail('tab_changed', 'The open page changed before it could be read.');
  let doc = document;
  let mode = 'open-tab';
  let status = 200;
  let fetchedAt = new Date().toISOString();
  let shell = false;
  const current = new URL(location.href);
  const samePage = current.href === url.href || (current.pathname === url.pathname && current.search === url.search && !url.hash);
  if (!samePage) {
    if (url.hash && current.pathname === url.pathname && current.search === url.search) return fail('browser_needed', 'This page is another view of the open app; reading it requires navigation.');
    mode = 'signed-in-fetch';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const response = await fetch(url.href, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal });
      status = response.status;
      if (!response.ok) return fail(status === 401 || status === 403 ? 'sign_in_required' : 'http_error', `The signed-in page returned HTTP ${status}.`);
      const kind = response.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml\+xml|text\/plain|application\/json/i.test(kind)) return fail('unsupported_type', 'This address is not a readable web document.');
      if (Number(response.headers.get('content-length')) > limits.bytes) return fail('page_too_large', 'This document is too large for a background read.');
      let html = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limits.bytes) return fail('page_too_large', 'This document is too large for a background read.');
            html += decoder.decode(chunk.value, { stream: true });
          }
          html += decoder.decode();
        } finally { await reader.cancel().catch(() => undefined); }
      } else {
        html = await response.text();
        if (html.length > limits.bytes) return fail('page_too_large', 'This document is too large for a background read.');
      }
      if (/application\/json|text\/plain/i.test(kind)) {
        const text = redact(html, limits.text);
        return { ok: !!text.trim(), url: url.href, title: url.pathname, text, links: [], status, fetchedAt, mode, truncated: html.length > limits.text };
      }
      // Keep even inert documents from starting incidental image/frame requests.
      shell = /enable javascript|javascript (?:is required|must be enabled)|requires javascript|you need javascript/i.test(html)
        || (/<(?:div|main)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\b(?:root|app|__next|application)\b[^"']*["'][^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<\/(?:div|main)\s*>/i.test(html) && /<script\b/i.test(html));
      const inert = html.replace(/<(?:img|iframe|frame|object|embed|audio|video|source|link|meta)\b[^>]*>/gi, '');
      doc = new DOMParser().parseFromString(inert, 'text/html');
      fetchedAt = new Date().toISOString();
      if (doc.querySelector('input[type="password"]') && /sign.?in|log.?in/i.test(doc.title || '')) return fail('sign_in_required', 'The site returned its sign-in page instead of the requested data.');
    } catch (err) {
      return fail(err?.name === 'AbortError' ? 'timeout' : 'browser_needed', err?.name === 'AbortError' ? 'The signed-in page took too long to respond.' : 'The signed-in page could not be read without navigating.');
    } finally { clearTimeout(timer); }
  }
  let root;
  try { root = request.selector ? doc.querySelector(request.selector) : doc.body; }
  catch { return fail('invalid_selector', 'The requested CSS selector is invalid.'); }
  if (!root) return fail('empty_page', 'The requested part of this page is not present.');
  const copy = root.cloneNode(true);
  for (const node of copy.querySelectorAll('script,style,noscript,template,svg,iframe,object,embed,input,textarea,select,[hidden],[aria-hidden="true"],[contenteditable],[data-jester-overlay]')) node.remove();
  for (const node of copy.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,tr,br,section,article')) {
    node.prepend('\n');
    node.append('\n');
  }
  const raw = String(copy.textContent || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const text = redact(raw, limits.text);
  if (/^(?:just a moment|attention required|access denied|security check|verify (?:you are|you're) human)/i.test(doc.title || '') || (text.length < 1200 && /checking your browser|verify (?:you are|you're) (?:a )?human|complete (?:the |a )?captcha/i.test(text))) return fail('browser_needed', 'This site returned a browser verification page instead of the requested information.');
  if (shell && text.length < 600) return fail('needs_rendering', 'The signed-in page returned a JavaScript shell; the requested data needs a rendered page.');
  if (samePage && text.length < 200 && /^(?:loading[.\s…]*|please wait[.\s…]*|enable javascript.*)$/i.test(text)) return fail('needs_rendering', 'The open page has not rendered its data yet.');
  const links = [];
  const seen = new Set();
  for (const anchor of copy.querySelectorAll('a[href]')) {
    let href;
    try { href = new URL(anchor.getAttribute('href'), url); } catch { continue; }
    if (!['https:', 'http:'].includes(href.protocol) || href.username || href.password || seen.has(href.href)) continue;
    seen.add(href.href);
    links.push({ url: href.href, text: redact(String(anchor.textContent || '').replace(/\s+/g, ' ').trim(), 200) });
    if (links.length >= limits.links) break;
  }
  return { ok: !!text, ...(text ? {} : fail('empty_page', 'This page has no readable text yet.')), url: samePage ? location.href : url.href,
    title: redact(doc.title, 300), text, links, status, fetchedAt, mode, truncated: raw.length > limits.text };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Callable reader; .request is an alias for hosts that prefer a service object. */
export function createBrowserWebReader({ chrome = globalThis.chrome, fetch = globalThis.fetch, now = Date.now, timeoutMs = WEB_READER_LIMITS.timeoutMs } = {}) {
  const stamp = () => new Date(now()).toISOString();
  const openTabs = async () => (await chrome?.tabs?.query?.({}) || []).filter((tab) => Number.isInteger(tab.id) && webReadAddress(tab.url));
  async function permitted(url) {
    if (!chrome?.permissions?.contains) return true;
    return chrome.permissions.contains({ origins: [`${url.origin}/*`] }).catch(() => false);
  }

  async function publicFetch(url, { signal, search = false } = {}) {
    if (!await permitted(url)) return failure('permission_required', `Allow ${url.hostname} in Chrome’s extension site access, or enable “Also run on every other site” in Jester Settings, then try again.`);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(stop, timeoutMs);
    try {
      const response = await fetch(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok) return failure(response.status === 401 || response.status === 403 ? 'browser_needed' : 'http_error', `Background reading returned HTTP ${response.status}.`);
      const kind = response.headers.get('content-type') || '';
      if (kind && !/text\/html|application\/xhtml\+xml|text\/plain|application\/json/i.test(kind)) return failure('unsupported_type', 'This address is not a readable web document.');
      if (Number(response.headers.get('content-length')) > WEB_READER_LIMITS.bytes) return failure('page_too_large', 'This document is too large for a background read.');
      let html = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > WEB_READER_LIMITS.bytes) return failure('page_too_large', 'This document is too large for a background read.');
            html += decoder.decode(chunk.value, { stream: true });
          }
          html += decoder.decode();
        } finally { await reader.cancel().catch(() => undefined); }
      } else {
        html = await response.text();
        if (html.length > WEB_READER_LIMITS.bytes) return failure('page_too_large', 'This document is too large for a background read.');
      }
      if (!search && /text\/plain|application\/json/i.test(kind)) return { ok: !!html.trim(), url: url.href, title: url.pathname, text: secret(html).slice(0, WEB_READER_LIMITS.text), links: [], fetchedAt: stamp(), status: response.status, mode: 'browser-fetch', truncated: html.length > WEB_READER_LIMITS.text };
      return parseWebHtml(html, url.href, { status: response.status, fetchedAt: stamp(), search });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      return failure(controller.signal.aborted ? 'timeout' : 'browser_needed', controller.signal.aborted ? 'Background reading took too long.' : 'This page could not be read without rendering or following a redirect.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }

  const request = async (input, { signal } = {}) => {
    if (signal?.aborted) throw abortError();
    if (input?.op === 'tabs') {
      const [tabs, front] = await abortable(Promise.all([
        openTabs(),
        Promise.resolve().then(() => chrome?.tabs?.query?.({ active: true, lastFocusedWindow: true }) || []).catch(() => [])
      ]), signal);
      const currentId = front[0]?.id;
      // Put the current page first even when a large number of tabs needs
      // truncating. Multiple windows can each have one active tab.
      tabs.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId) || Number(b.active === true) - Number(a.active === true));
      return { ok: true, tabs: tabs.slice(0, WEB_READER_LIMITS.tabs).map(({ id, title, url, active, windowId }) => ({
        id, title: tidy(secret(title || ''), 300), url, active: active === true, current: id === currentId,
        ...(Number.isInteger(windowId) ? { windowId } : {})
      })), fetchedAt: stamp(), mode: 'open-tabs', truncated: tabs.length > WEB_READER_LIMITS.tabs };
    }
    if (input?.op === 'search') {
      const query = tidy(input.query, 500);
      if (!query) return failure('invalid_request', 'Give a search query.');
      return publicFetch(new URL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`), { signal, search: true });
    }
    if (input?.op !== 'scrape') return failure('invalid_request', 'Unsupported background web operation.');
    const url = webReadAddress(input.url);
    if (!url) return failure('invalid_url', 'Use a public HTTP or HTTPS page without passwords, tokens or account actions in its address.');
    if (input.selector !== undefined && (typeof input.selector !== 'string' || input.selector.length > 500)) return failure('invalid_selector', 'Use a CSS selector of at most 500 characters.');
    // Through an open tab, with its sign-in, only when the user asked about one (signedIn, web-research.js) or the
    // desktop asks for exactly that (openOnly): public research is read anonymously, whatever tabs are open.
    const viaTab = input.signedIn === true || input.openOnly === true;
    const tabs = viaTab ? await abortable(openTabs(), signal) : [];
    const matches = tabs.filter((tab) => new URL(tab.url).origin === url.origin).sort((a, b) => Number(b.url === url.href) - Number(a.url === url.href));
    if (matches.length && chrome?.scripting?.executeScript) {
      if (!await permitted(url)) return failure('permission_required', `Allow ${url.hostname} in Chrome’s extension site access, or enable “Also run on every other site” in Jester Settings, then try again.`);
      try {
        const results = await abortable(chrome.scripting.executeScript({ target: { tabId: matches[0].id, frameIds: [0] }, world: 'ISOLATED', func: readInTab,
          args: [{ url: url.href, ...(input.selector ? { selector: input.selector } : {}) }, { ...WEB_READER_LIMITS, timeoutMs }] }), signal);
        const result = results?.[0]?.result;
        if (!result || typeof result !== 'object') return failure('browser_needed', 'The open page could not be read.');
        return { ...result, links: (Array.isArray(result.links) ? result.links : []).filter((entry) => webReadAddress(entry.url)).slice(0, WEB_READER_LIMITS.links) };
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw abortError();
        return failure('permission_required', 'Chrome did not allow this open page to be read. Check Jester’s extension site access and refresh the page.');
      }
    }
    if (input.openOnly) return failure('no_open_tab', 'No open tab has this site’s signed-in session.');
    if (input.selector) return failure('browser_needed', 'Selecting part of this page requires an open tab or the Scrapling helper.');
    return publicFetch(url, { signal });
  };
  request.request = request;
  request.canReadOpen = async (address) => {
    const url = webReadAddress(address);
    return !!url && (await openTabs()).some((tab) => new URL(tab.url).origin === url.origin);
  };
  return request;
}
