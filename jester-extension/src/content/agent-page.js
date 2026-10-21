/**
 * Bounded semantic browser tools. Classic script: no imports, raw HTML or screenshots.
 *
 * globalThis.__jesterAgentPage:
 *   observe({goal?, query?, maxChars?, maxElements?}) -> compact page state
 *   classify(action) -> {ok, category: 'read'|'browse'|'sensitive', label, pageId}
 *   execute(action, {boundary: 'ask'|'entertainment'|'site', approved?: boolean})
 *
 * Actions use `action` and opaque `elementId`, optionally `pageId`/`revision`.
 * Only the worker may supply `approved`, after binding approval to the exact action.
 * Registry nodes stay in this isolated world. A route change or a reused node with
 * a different semantic identity invalidates old IDs; detached nodes never retarget.
 */
(() => {
  'use strict';
  if (globalThis.__jesterAgentPage?.version === 1) return;

  const LIMITS = Object.freeze({ maxChars: 12000, maxElements: 100, maxText: 300, maxScan: 5000, maxRegistry: 1000 });
  const ACTIONABLE = 'a[href],button,input,textarea,select,summary,[contenteditable],'+
    '[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],'+
    '[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="textbox"],'+
    '[role="searchbox"],[role="slider"],[onclick],[tabindex]';
  const SEMANTIC = ACTIONABLE + ',video,h1,h2,h3,h4,h5,h6,[role="heading"],label,p,li,article,tr,'+
    '[role="listitem"],[role="row"],[role="alert"],[role="status"],dialog,[role="dialog"]';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK']);
  const SECRET = /password|passcode|one.time.code|cc-number|cc-csc|cc-exp|credit.?card|api.?key|access.?token|authorization|secret|security.?code/i;
  const SENSITIVE = /\b(?:buy|purchase|checkout|payment|billing|subscribe|subscription|cancel membership|delete|remove account|sign ?out|log ?out|sign ?in|log ?in|password|account settings|send|post|publish|upload|transfer|donate)\b/i;
  const SEARCH = /\b(?:search|find|query|titles?|movies?|shows?|episodes?)\b/i;
  const READ = new Set(['observe', 'query', 'find_text', 'find_elements', 'read_element', 'read_nearby', 'inspect_section', 'get_form_fields', 'get_table', 'wait']);
  const TARGET = new Set(['click', 'focus', 'hover', 'type', 'clear', 'select', 'read_element', 'read_nearby', 'inspect_section', 'get_table']);
  const ALLOWED = new Set([...READ, ...TARGET, 'scroll', 'press_key']);
  const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ']);
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const tidy = (value, max = LIMITS.maxText) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const redact = (value, max = LIMITS.maxText) => tidy(value, max * 2)
    .replace(/\b(?:sk-|gsk_)[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[\w.+/-]+/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]')
    .slice(0, max);
  const attr = (el, name) => el?.getAttribute?.(name) || '';
  function all(root, selector) {
    const query = () => {
      if (extraction) extraction.metrics.queryReads++;
      return Array.from(root?.querySelectorAll?.(selector) || []).slice(0, LIMITS.maxScan);
    };
    if (!extraction || !root) return query();
    let queries = extraction.queries.get(root);
    if (!queries) extraction.queries.set(root, queries = new Map());
    if (queries.has(selector)) { extraction.metrics.cacheHits++; return queries.get(selector); }
    const result = query(); queries.set(selector, result); return result;
  }
  // Terms match by substring, so a short function word matches almost anything:
  // "go to" in a goal once ranked YouTube's "History" link above its results.
  const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'play', 'please', 'watch', 'open', 'this', 'that', 'from',
    'into', 'to', 'go', 'of', 'on', 'in', 'at', 'by', 'me', 'my', 'is', 'it', 'an', 'or', 'as', 'can', 'you', 'your',
    'could', 'would', 'will', 'want', 'like', 'get', 'put', 'show', 'take', 'find', 'let', 'just', 'now', 'some', 'all']);
  const words = (text) => tidy(text, 600).toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) =>
    (w.length > 1 || /^\d+$/.test(w)) && !STOP_WORDS.has(w)) || [];

  let route = location.href;
  let serial = 0;
  let revision = 0;
  let lastSignature = '';
  let pageId = nonce();
  let byNode = new WeakMap();
  const byId = new Map();
  let extraction = null;

  /** Synchronous read transaction only. Nothing survives an action or the next observation. */
  function readSnapshot(callback) {
    if (extraction) return callback();
    extraction = { queries: new WeakMap(), metrics: { queryReads: 0, styleReads: 0, rectReads: 0, cacheHits: 0, candidates: 0 } };
    for (const name of ['overlay', 'secret', 'style', 'styleVisible', 'rect', 'visible', 'text', 'name', 'role', 'context', 'parentContext', 'identity']) extraction[name] = new WeakMap();
    try { return callback(); } finally { extraction = null; }
  }

  function memo(name, node, compute) {
    if (!extraction || !node) return compute();
    const cache = extraction[name];
    if (cache.has(node)) { extraction.metrics.cacheHits++; return cache.get(node); }
    const result = compute(); cache.set(node, result); return result;
  }

  function nonce() {
    return 'p' + (globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 10) || Math.random().toString(36).slice(2, 12));
  }

  function syncRoute() {
    if (route === location.href) return;
    route = location.href;
    pageId = nonce();
    serial = 0;
    revision = 0;
    lastSignature = '';
    byNode = new WeakMap();
    byId.clear();
  }

  function ownOverlay(el) {
    if (el?.nodeType !== 1) return false;
    return memo('overlay', el, () => /^jester-/i.test(el.id || '') || el.hasAttribute?.('data-jester') || ownOverlay(el.parentElement));
  }

  function secret(el) {
    return memo('secret', el, () => SECRET.test([el?.type, attr(el, 'autocomplete'), attr(el, 'name'), el?.id,
      attr(el, 'aria-label'), attr(el, 'placeholder')].join(' ')));
  }

  function styleVisible(el) {
    if (el?.nodeType !== 1) return true;
    return memo('styleVisible', el, () => {
      if (el.hidden || el.inert || attr(el, 'aria-hidden') === 'true') return false;
      const style = styleOf(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        style.opacity !== '0' && styleVisible(el.parentElement);
    });
  }

  function styleOf(el) {
    return memo('style', el, () => {
      if (extraction) extraction.metrics.styleReads++;
      return getComputedStyle(el);
    });
  }

  function rectOf(el) {
    return memo('rect', el, () => {
      if (extraction) extraction.metrics.rectReads++;
      return el.getBoundingClientRect();
    });
  }

  function visible(el, viewport = false) {
    if (!el?.isConnected) return false;
    // Long pages mostly contain offscreen cards. Reject their geometry before
    // computing styles/text, while on-demand reads still inspect them normally.
    if (viewport) {
      const r = rectOf(el);
      if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    }
    const shown = memo('visible', el, () => {
      if (ownOverlay(el) || SKIP.has(el.tagName) || secret(el) || !styleVisible(el)) return false;
      const r = rectOf(el);
      return r.width > 0 && r.height > 0;
    });
    return shown;
  }

  /** Never use textContent on a container: hidden descendants may contain secrets. */
  function safeText(root, max = LIMITS.maxText) {
    return memo('text', root, () => readText(root)).slice(0, max);
  }

  function readText(root) {
    const max = LIMITS.maxText;
    const pieces = [];
    let size = 0;
    let visited = 0;
    function walk(node) {
      if (++visited > 1200 || size >= max) return;
      if (node.nodeType === 3) {
        const text = tidy(node.nodeValue, max - size);
        if (text) { pieces.push(text); size += text.length + 1; }
        return;
      }
      if (node.nodeType !== 1 || SKIP.has(node.tagName) || secret(node) || ownOverlay(node)) return;
      if (!visible(node)) return;
      // Drafts and field contents remain in the browser, even when reading parents.
      if (/^(INPUT|TEXTAREA)$/.test(node.tagName) || node.isContentEditable) return;
      for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return redact(pieces.join(' '), max);
  }

  function readableImageAlt(image, root, max = LIMITS.maxText) {
    for (let node = image; node; node = node.parentElement) {
      if (secret(node) || !visible(node)) return '';
      if (node === root) break;
    }
    return redact(attr(image, 'alt'), max);
  }

  function descendantImageName(el) {
    // Poster-only links/buttons often expose their title through image alt.
    // A collage with distinct titles has no single safe control name.
    if (!el.matches?.('a[href],button,[role="link"],[role="button"]')) return '';
    const names = new Set();
    for (const image of all(el, 'img[alt]')) {
      const name = readableImageAlt(image, el);
      if (name) names.add(name);
      if (names.size > 1) return '';
    }
    return names.values().next().value || '';
  }

  function nameOf(el) {
    return memo('name', el, () => {
      const aria = attr(el, 'aria-label');
      if (aria) return redact(aria);
      const labelled = attr(el, 'aria-labelledby').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)).filter((node) => node && visible(node))
      .map((node) => safeText(node, 150)).join(' ');
    const labels = Array.from(el.labels || []).filter((node) => visible(node)).map((node) => safeText(node, 150)).join(' ');
    return redact(labelled || labels || attr(el, 'alt') ||
      attr(el, 'title') || attr(el, 'placeholder') || safeText(el) || descendantImageName(el) ||
      (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? attr(el, 'name') || el.type || el.tagName.toLowerCase() : el.tagName === 'VIDEO' ? 'Video' : ''), LIMITS.maxText);
    });
  }

  function roleOf(el) {
    return memo('role', el, () => {
    if (attr(el, 'role')) return attr(el, 'role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return /^(checkbox|radio|range|button|submit)$/.test(el.type) ? el.type : (el.type === 'search' ? 'searchbox' : 'input');
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return tag;
    });
  }

  function cardContext(el) {
    return memo('context', el, () => {
    let parent = el.parentElement;
    for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
      if (/^(BODY|HTML|MAIN|NAV|HEADER|FOOTER|DIALOG)$/.test(parent.tagName) || attr(parent, 'role') === 'dialog') break;
      const context = memo('parentContext', parent, () => {
        const images = all(parent, 'img[alt]').map((img) => readableImageAlt(img, parent, 100)).filter(Boolean).slice(0, 2);
        const text = redact([...images, safeText(parent, 240)].filter(Boolean).join(' '), 240);
        const card = /card|episode|title-item|media-item/i.test(`${attr(parent, 'class')} ${attr(parent, 'data-uia')} ${attr(parent, 'data-testid')}`);
        return { text, useful: parent.matches?.('article,li,tr,[role="listitem"],[role="row"]') ||
          card || images.length || /episode|season|\bS\d+\s*E\d+\b|\b\d+\s*min\b/i.test(text) };
      });
      if (context.text && context.text !== nameOf(el) && context.useful) return context.text;
    }
    return '';
    });
  }

  function safeUrl(raw = location.href) {
    try {
      const u = new URL(raw, document.baseURI || location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      u.username = ''; u.password = '';
      for (const key of [...u.searchParams.keys()]) if (/token|key|password|auth|code|session|secret/i.test(key)) u.searchParams.delete(key);
      if (/token|key|password|auth|secret/i.test(u.hash)) u.hash = '';
      return redact(u.href, 350);
    } catch { return ''; }
  }

  function identity(el) {
    return memo('identity', el, () => {
    const form = el.form || el.closest?.('form');
    const defaultSubmitter = form && all(form, 'button,input').find((node) => ['submit', 'image'].includes(node.type));
    return [roleOf(el), nameOf(el), attr(el, 'href'), attr(el, 'type'), cardContext(el),
      attr(el, 'formaction'), attr(el.closest?.('button,input'), 'formaction'), attr(form, 'action'),
      attr(defaultSubmitter, 'formaction'), document.baseURI || ''].join('|');
    });
  }

  function register(el) {
    const signature = identity(el);
    let record = byNode.get(el);
    if (!record || !byId.has(record.id) || record.signature !== signature) {
      if (record) byId.delete(record.id);
      record = { id: `${pageId.slice(1)}.${(++serial).toString(36)}`, node: el, signature };
      byNode.set(el, record);
      byId.set(record.id, record);
    }
    // LRU order keeps recently observed/cursor targets available. A WeakMap
    // entry is removed too, so a large virtual list cannot retain old records.
    byId.delete(record.id);
    byId.set(record.id, record);
    while (byId.size > LIMITS.maxRegistry) {
      const oldest = byId.values().next().value;
      byId.delete(oldest.id);
      byNode.delete(oldest.node);
    }
    return record.id;
  }

  function describe(el) {
    const result = { id: register(el), role: roleOf(el), name: nameOf(el) || '(unnamed)' };
    const context = cardContext(el);
    if (context) result.context = context;
    if (!visible(el, true)) result.offscreen = true;
    if (el.disabled || attr(el, 'aria-disabled') === 'true') result.disabled = true;
    if (['true', 'false'].includes(attr(el, 'aria-selected'))) result.selected = attr(el, 'aria-selected') === 'true';
    if (['true', 'false'].includes(attr(el, 'aria-expanded'))) result.expanded = attr(el, 'aria-expanded') === 'true';
    if (el.checked !== undefined && /checkbox|radio|switch/.test(result.role)) result.checked = !!el.checked;
    if (el.tagName === 'VIDEO') {
      result.playing = !el.paused && !el.ended;
      result.paused = !!el.paused;
      result.currentTime = Number.isFinite(el.currentTime) ? Math.round(el.currentTime) : 0;
      if (Number.isFinite(el.duration)) result.duration = Math.round(el.duration);
    }
    if (el.tagName === 'SELECT') {
      result.options = Array.from(el.options || []).filter((o) => !o.disabled).slice(0, 20)
        .map((o) => ({ value: redact(o.value, 80), label: redact(o.textContent, 100), selected: !!o.selected }));
    }
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && SEARCH.test(`${result.name} ${el.type} ${attr(el, 'role')}`)) {
      result.value = redact(el.value, 120);
    }
    const href = attr(el, 'href');
    if (href) result.url = safeUrl(href);
    return result;
  }

  function scopeRoot() {
    const dialogs = all(document, 'dialog[open],[role="dialog"],[aria-modal="true"]').filter((el) => visible(el));
    return dialogs.at(-1) || document.body || document.documentElement;
  }

  /**
   * The site's own navigation, banner or footer rather than the page's content.
   * A header or footer inside an article or section belongs to that content.
   */
  function siteChrome(el) {
    const landmark = el.closest?.('nav,[role="navigation"],[role="banner"],[role="contentinfo"],header,footer');
    if (!landmark) return false;
    return !!attr(landmark, 'role') || !/^(?:HEADER|FOOTER)$/.test(landmark.tagName) ||
      !landmark.parentElement?.closest?.('main,article,section,aside,dialog,[role="main"],[role="article"],[role="region"],[role="dialog"]');
  }

  /** Search is how most tasks start, wherever the site puts it. */
  function searchControl(el, name) {
    return !!el.closest?.('[role="search"]') || /\bsearch\b/i.test(name) || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
      ['combobox', 'searchbox', 'textbox'].includes(roleOf(el));
  }

  /** A control inside a real control of the same name (YouTube's sidebar nests one in each link) is that control again. */
  function nestedDuplicate(el, name) {
    const outer = el.parentElement?.closest?.(ACTIONABLE);
    return !!outer && outer.matches('a[href],button,input,select,textarea,summary') && nameOf(outer) === name && visible(outer);
  }

  function collect(root, { goal = '', query = '', offscreen = false, fields = false } = {}) {
    const terms = words(query || goal);
    const hasNumbers = terms.some((term) => /^\d+$/.test(term));
    const numberSet = (text) => new Set((text.match(/\d+/g) || []).map((number) => number.replace(/^0+(?=\d)/, '')));
    const seen = new Set();
    const found = [];
    let nonActionable = 0;
    let controls = 0;
    for (const el of all(root, fields ? 'input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"]' : SEMANTIC)) {
      if (extraction) extraction.metrics.candidates++;
      if (!visible(el, !offscreen)) continue;
      const actionable = el.matches(ACTIONABLE);
      const name = nameOf(el);
      const context = cardContext(el);
      const hay = `${name} ${context}`.toLowerCase();
      const numbers = hasNumbers ? numberSet(hay) : null;
      const nameNumbers = hasNumbers ? numberSet(name) : null;
      const matches = terms.reduce((n, word) => n + Number(/^\d+$/.test(word) ? numbers.has(word.replace(/^0+(?=\d)/, '')) : hay.includes(word)), 0);
      const nameMatches = terms.reduce((n, word) => n + Number(/^\d+$/.test(word) ? nameNumbers.has(word.replace(/^0+(?=\d)/, '')) : name.toLowerCase().includes(word)), 0);
      // A player's state is the evidence a playback task finishes on: never crowd it out.
      const media = el.tagName === 'VIDEO';
      if (!name || (!actionable && !media && !/^H[1-6]$/.test(el.tagName) && !matches && nonActionable >= 12)) continue;
      if (query && !matches) continue;
      // Navigation/footer text rarely helps a title/episode task.
      if (!matches && el.closest?.('nav,header,footer') && !actionable) continue;
      if (actionable && nestedDuplicate(el, name)) continue;
      const key = `${roleOf(el)}|${name}|${context}|${attr(el, 'href')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A wide YouTube window shows ~30 sidebar links ahead of the results in
      // document order; ranked equally, they used to fill the element budget.
      const chrome = actionable && !matches && siteChrome(el) && !searchControl(el, name);
      const score = nameMatches * 100 + matches * (actionable ? 100 : 30) + (actionable ? 200 : 0) +
        (visible(el, true) ? 20 : 0) + (/^H[1-6]$/.test(el.tagName) ? 15 : 0) + (media ? 1000 : 0) - (chrome ? 60 : 0);
      // A control's place among the page's controls in document order, for
      // "the first video": the list itself is ranked, not laid out.
      found.push({ el, actionable, score, ...(actionable || media ? { order: controls++ } : {}) });
      if (!actionable) nonActionable++;
    }
    return found.sort((a, b) => b.score - a.score);
  }

  function compactResult(nodes, opts = {}) {
    const maxChars = clamp(Number(opts.maxChars) || LIMITS.maxChars, 600, LIMITS.maxChars);
    const budget = maxChars - (opts.diagnostics ? 240 : 16);
    const maxElements = clamp(Number(opts.maxElements) || LIMITS.maxElements, 1, LIMITS.maxElements);
    const entries = [];
    const scroller = scrollContainer();
    const scroll = { top: Math.round(scroller.scrollTop || 0), left: Math.round(scroller.scrollLeft || 0),
      maxTop: Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || innerHeight)),
      maxLeft: Math.max(0, (scroller.scrollWidth || 0) - (scroller.clientWidth || innerWidth)) };
    const result = { ok: true, pageId, revision, url: safeUrl(), title: redact(document.title, 160), scroll,
      count: nodes.length, elements: entries, text: '', truncated: false, limits: { maxChars, maxElements, maxText: LIMITS.maxText } };
    const render = () => {
      result.text = [`Page: ${result.title}`, `URL: ${result.url}`, `Page ID: ${pageId}`,
        `Scroll: ${scroll.top}/${scroll.maxTop}px vertically; ${scroll.left}/${scroll.maxLeft}px horizontally`,
        ...entries.map((e) => `[${e.id}] ${e.role} ${JSON.stringify(e.name)}${e.context ? ` — ${e.context}` : ''}`+
          `${e.disabled ? ' (disabled)' : ''}${e.offscreen ? ' (offscreen)' : ''}`+
          `${e.selected !== undefined ? ` (selected=${e.selected})` : ''}${e.expanded !== undefined ? ` (expanded=${e.expanded})` : ''}`+
          `${e.role === 'video' ? ` ${e.playing ? 'playing' : e.paused ? 'paused' : 'ended'} at ${e.currentTime}s${e.duration !== undefined ? `/${e.duration}s` : ''}` : ''}`+
          `${e.options ? ` options: ${e.options.map((o) => `${o.selected ? '*' : ''}${o.label}=${o.value}`).join('; ')}` : ''}`+
          `${e.value ? ` value: ${JSON.stringify(e.value)}` : ''}`)].join('\n');
    };
    for (const node of nodes.slice(0, maxElements)) {
      const entry = describe(node.el);
      // Opt-in. A gap between two controls' orders means a control between
      // them was left out of this observation by its budget.
      if (opts.order && Number.isInteger(node.order)) entry.order = node.order;
      entries.push(entry);
      render();
      if (JSON.stringify(result).length > budget) { entries.pop(); break; }
    }
    result.truncated = entries.length < nodes.length;
    render();
    // Budget includes metadata and both structured/text representations.
    while (entries.length && JSON.stringify(result).length > budget) { entries.pop(); result.truncated = true; render(); }
    if (JSON.stringify(result).length > maxChars) { result.url = ''; result.title = result.title.slice(0, 40); render(); }
    return result;
  }

  function observe(opts = {}) {
    return readSnapshot(() => {
      const started = globalThis.performance?.now?.() ?? Date.now();
      syncRoute();
      for (const [id, record] of byId) if (!record.node.isConnected) byId.delete(id);
      const nodes = collect(scopeRoot(), { goal: tidy(`${opts.goal || ''} ${opts.hint || ''}`, 1000), query: tidy(opts.query, 300) });
      const result = compactResult(nodes, { ...opts, diagnostics: true });
      const signature = result.url + result.text.replace(/(\b(?:playing|paused|ended) at )\d+s/g, '$1#s');
      if (signature !== lastSignature) { lastSignature = signature; revision++; }
      result.revision = revision;
      result.metrics = { ...extraction.metrics, elapsedMs: Math.round(((globalThis.performance?.now?.() ?? Date.now()) - started) * 100) / 100 };
      // Diagnostics are returned to the controller, never repeated in page text.
      if (JSON.stringify(result).length > result.limits.maxChars) delete result.metrics;
      return result;
    });
  }

  function normalize(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Action must be an object');
    const kind = action.action || action.type;
    if (!ALLOWED.has(kind)) throw new Error('Unsupported page action');
    const allowed = new Set(['action', 'type', 'elementId', 'pageId', 'revision', 'reason']);
    const extras = {
      type: ['text', 'value', 'append'], select: ['value', 'text'], scroll: ['direction', 'amount'],
      press_key: ['key'], find_text: ['query', 'text'], find_elements: ['query', 'text'], query: ['query', 'text'],
      observe: ['goal', 'query'], wait: ['ms'], read_nearby: ['limit'], inspect_section: ['limit', 'query'],
      get_table: ['limit'], get_form_fields: ['limit']
    };
    for (const key of extras[kind] || []) allowed.add(key);
    for (const key of Object.keys(action)) if (!allowed.has(key)) throw new Error(`Unexpected action property: ${key}`);
    if (TARGET.has(kind) && (typeof action.elementId !== 'string' || action.elementId.length > 80)) throw new Error('Action requires an elementId');
    if (action.elementId !== undefined && typeof action.elementId !== 'string') throw new Error('Invalid elementId');
    if (action.pageId !== undefined && typeof action.pageId !== 'string') throw new Error('Invalid pageId');
    if (action.revision !== undefined && (!Number.isInteger(action.revision) || action.revision < 0)) throw new Error('Invalid revision');
    if (kind === 'type' && (typeof (action.text ?? action.value) !== 'string' || (action.text ?? action.value).length > 4000)) throw new Error('Type requires text of at most 4000 characters');
    if (kind === 'select' && (typeof (action.value ?? action.text) !== 'string' || (action.value ?? action.text).length > 300)) throw new Error('Select requires a short value');
    if (['query', 'find_text', 'find_elements'].includes(kind) && (typeof (action.query ?? action.text) !== 'string' || !(action.query ?? action.text).trim() || (action.query ?? action.text).length > 300)) throw new Error('Find requires a query of 1–300 characters');
    if (action.query !== undefined && (typeof action.query !== 'string' || action.query.length > 300)) throw new Error('Query must be at most 300 characters');
    if (kind === 'scroll' && !['up', 'down', 'left', 'right', 'top', 'bottom'].includes(action.direction)) throw new Error('Invalid scroll direction');
    if (action.amount !== undefined && (!Number.isFinite(action.amount) || action.amount < 0.1 || action.amount > 3)) throw new Error('Invalid scroll amount');
    const key = action.key === 'Space' ? ' ' : action.key;
    if (kind === 'press_key' && (typeof key !== 'string' || (!KEYS.has(key) && !/^[\p{L}\p{N}]$/u.test(key)))) throw new Error('Unsupported key');
    if (action.ms !== undefined && (!Number.isFinite(action.ms) || action.ms < 0 || action.ms > 4000)) throw new Error('Wait must be between 0 and 4000 ms');
    if (action.append !== undefined && typeof action.append !== 'boolean') throw new Error('Invalid append option');
    return { ...action, action: kind, ...(kind === 'press_key' ? { key } : {}) };
  }

  function resolve(action) {
    syncRoute();
    if (action.pageId && action.pageId !== pageId) throw new Error('STALE_PAGE: observe the current page again');
    if (!action.elementId) return null;
    const record = byId.get(action.elementId);
    if (!record || !record.node.isConnected || !visible(record.node) || identity(record.node) !== record.signature) {
      if (record) byId.delete(record.id);
      throw new Error('STALE_ELEMENT: observe the current page again');
    }
    const scope = scopeRoot();
    if (scope !== document.body && scope !== document.documentElement && !scope.contains(record.node)) {
      throw new Error('STALE_ELEMENT: an active dialog changed the page');
    }
    return record.node;
  }

  function classification(action, el) {
    let target = el;
    if (action.action === 'press_key' && !target) {
      const scope = scopeRoot();
      const focused = document.activeElement;
      if (focused && secret(focused)) throw new Error('Sensitive fields are not available to the agent');
      target = focused && visible(focused) && (scope === document.body || scope === document.documentElement || scope.contains(focused))
        ? focused : scope;
      if (!visible(target)) throw new Error('No visible keyboard target is available');
    }
    const label = redact(target ? nameOf(target) || roleOf(target) : action.action, 120);
    let url = target && attr(target, 'href') ? safeUrl(attr(target, 'href')) : undefined;
    const kind = target?.tagName === 'VIDEO' ? 'video' : 'element';
    if (READ.has(action.action)) return { ok: true, category: 'read', label, pageId, kind };
    if (target && secret(target)) throw new Error('Sensitive fields are not available to the agent');
    const form = target?.form || target?.closest?.('form');
    const clickControl = target?.closest?.('button,input') || target;
    const submitter = action.action === 'press_key' && action.key === 'Enter'
      ? (['submit', 'image'].includes(target?.type) ? target : form && all(form, 'button,input').find((node) => ['submit', 'image'].includes(node.type)))
      : ['submit', 'image'].includes(clickControl?.type) ? clickControl : null;
    if (form && ((action.action === 'press_key' && action.key === 'Enter') || (action.action === 'click' && submitter))) {
      url = safeUrl(submitter?.hasAttribute('formaction') ? attr(submitter, 'formaction') : attr(form, 'action') || location.href);
    }
    const context = [label, attr(target, 'name'), attr(target, 'autocomplete'), url || '',
      form && `${attr(form, 'aria-label')} ${attr(form, 'action')}`].filter(Boolean).join(' ');
    let sensitive = SENSITIVE.test(context.replace(/[\/_-]/g, ' '));
    if (['type', 'clear', 'select'].includes(action.action) && !SEARCH.test(context) && !/season|episode|subtitles?|language|quality|playback|volume/i.test(context)) sensitive = true;
    if (action.action === 'press_key' && target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable) &&
        !SEARCH.test(context) && (action.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(action.key))) sensitive = true;
    if (action.action === 'press_key' && action.key === 'Enter' && form && !SEARCH.test(context)) sensitive = true;
    if (action.action === 'click' && target?.type === 'submit' && form && !SEARCH.test(context + safeText(form, 200))) sensitive = true;
    return { ok: true, category: sensitive ? 'sensitive' : 'browse', label, ...(url ? { url } : {}), pageId, kind,
      ...(action.action === 'press_key' ? { elementId: register(target) } : {}) };
  }

  function targetAtPoint(x, y) {
    try {
      syncRoute();
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
        throw new Error('Cursor is outside the current viewport');
      }
      const stack = document.elementsFromPoint?.(x, y) || [document.elementFromPoint?.(x, y)].filter(Boolean);
      for (const node of stack) {
        if (ownOverlay(node)) continue;
        const el = node.closest?.(ACTIONABLE + ',video');
        // Do not aim through a site's own overlay at a covered control.
        if (!el || !visible(el, true) || secret(el)) break;
        const elementId = register(el);
        const action = { action: 'click', elementId, pageId };
        const target = resolve(action);
        return { ...classification(action, target), elementId, revision, label: nameOf(el) || (el.tagName === 'VIDEO' ? 'Video' : '(unnamed)') };
      }
      throw new Error('No actionable element under the cursor');
    } catch (err) { return { ok: false, detail: String(err.message || err), pageId }; }
  }

  function classify(raw) {
    try { const action = normalize(raw); return classification(action, resolve(action)); }
    catch (err) { return { ok: false, detail: String(err.message || err), pageId }; }
  }

  function emit(el, type, init = {}) {
    const mouse = /^(mouse|click)/.test(type);
    const Ctor = type.startsWith('pointer') ? globalThis.PointerEvent || MouseEvent : mouse ? MouseEvent : Event;
    return el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  /** The topmost page node at a point; undefined when the browser offers no hit testing. */
  function topAt(x, y) {
    if (!document.elementsFromPoint && !document.elementFromPoint) return undefined;
    const stack = document.elementsFromPoint?.(x, y) || [document.elementFromPoint(x, y)];
    return stack.find((node) => node && !ownOverlay(node)) || null;
  }

  function reaches(el, hit) {
    return hit === undefined || (!!hit && (hit === el || el.contains(hit)));
  }

  function hitTarget(el, x, y) {
    return reaches(el, topAt(x, y));
  }

  /** An empty layer with no paint of its own: nothing the user can see, read or press. */
  function pointerShield(node) {
    if (node?.nodeType !== 1 || node.shadowRoot || node.matches?.(ACTIONABLE) ||
        /^(?:BODY|HTML|IMG|PICTURE|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|SVG)$/.test(node.tagName)) return false;
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1 || (child.nodeType === 3 && child.nodeValue.trim())) return false;
    }
    const style = styleOf(node);
    return /^(?:fixed|absolute)$/.test(style.position) && (style.opacity === '0' ||
      (/^(?:transparent|rgba\([^)]*,\s*0\))$/.test(style.backgroundColor) && style.backgroundImage === 'none'));
  }

  /**
   * A real pointer gets to a control by moving there, and those moves go to
   * whatever is on top. Some sites lay an empty, unpainted layer over a list
   * the keyboard is driving and take it away on the next mouse move (Hulu's
   * instant search does). Such a layer gets exactly that move, never a press;
   * whether it went is for the caller's next hit test to decide.
   */
  async function moveOff(layer, x, y) {
    if (!pointerShield(layer)) return false;
    const init = { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 };
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) emit(layer, type, init);
    for (const ms of [0, 16, 50, 100]) {
      await new Promise((done) => setTimeout(done, ms));
      if (topAt(x, y) !== layer) return true;
    }
    return false;
  }

  function coveredTargetError(el, points) {
    const error = new Error('Target is covered by another page element; inspect the current page');
    // Geometry/style evidence is useful even when the top surface is a plain
    // layout div, rather than another actionable control. Do not read its text,
    // attributes, selectors or HTML: a covering container can contain secrets.
    error.hitTest = readSnapshot(() => {
      const surface = (node) => {
        const style = styleOf(node), rect = rectOf(node);
        const numeric = (value) => Math.round(clamp(Number(value) || 0, -100000, 100000));
        const role = roleOf(node);
        const roles = new Set(['link', 'button', 'dialog', 'alertdialog', 'main', 'navigation', 'region', 'banner',
          'contentinfo', 'complementary', 'article', 'list', 'listitem', 'menu', 'menuitem', 'option', 'tab', 'tabpanel',
          'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'heading', 'alert', 'status',
          'generic', 'presentation', 'none', 'input', 'textarea', 'select', 'video', 'body', 'html', 'div', 'span', 'img']);
        const tags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SUMMARY', 'DETAILS',
          'DIV', 'SPAN', 'IMG', 'PICTURE', 'SVG', 'PATH', 'VIDEO', 'CANVAS', 'DIALOG', 'BODY', 'HTML',
          'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'FORM',
          'LABEL', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH', 'IFRAME']);
        return { tag: tags.has(node.tagName) ? node.tagName : 'ELEMENT',
          role: roles.has(role) ? role : 'element',
          pointerEvents: ['auto', 'none'].includes(style.pointerEvents) ? style.pointerEvents : 'other',
          position: ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(style.position) ? style.position : 'other',
          zIndex: /^(?:auto|-?\d{1,8})$/.test(style.zIndex) ? style.zIndex : 'other',
          rect: { left: numeric(rect.left), top: numeric(rect.top), width: numeric(rect.width), height: numeric(rect.height) } };
      };
      const hits = [], seen = new Set();
      for (const [x, y] of points.slice(0, 48)) {
        const stack = document.elementsFromPoint?.(x, y) || [document.elementFromPoint?.(x, y)].filter(Boolean);
        const hit = stack.find((node) => node && !ownOverlay(node));
        if (!hit || seen.has(hit)) continue;
        seen.add(hit);
        const entry = { ...surface(hit), relation: hit === el || el.contains(hit) ? 'descendant' : hit.contains?.(el) ? 'ancestor' : 'unrelated' };
        if (JSON.stringify([...hits, entry]).length > 1100) break;
        hits.push(entry);
        if (hits.length === 3) break;
      }
      return { samples: Math.min(points.length, 48), target: surface(el), hits };
    });
    // Report only actual controls on top of rejected points. These observations
    // do not authorize a substitute click or expose elements behind an overlay.
    error.blockingElements = readSnapshot(() => {
      const scope = scopeRoot(), entries = [], ids = new Set();
      for (const [x, y] of points) {
        if (!document.elementsFromPoint && !document.elementFromPoint) break;
        const stack = document.elementsFromPoint?.(x, y) || [document.elementFromPoint(x, y)];
        const hit = stack.find((node) => node && !ownOverlay(node));
        const control = hit?.closest?.(ACTIONABLE);
        if (!control || control === el || el.contains(control) || !scope.contains(control) || !visible(control, true)) continue;
        let privateControl = false;
        for (let parent = control; parent; parent = parent.parentElement) {
          if (secret(parent) || ownOverlay(parent)) { privateControl = true; break; }
          if (parent === scope) break;
        }
        if (privateControl) continue;
        const description = describe(control);
        if (ids.has(description.id)) continue;
        let sameDestination = false;
        const sourceHref = attr(el, 'href'), blockingHref = attr(control, 'href');
        if (sourceHref && blockingHref) {
          try {
            const sourceUrl = new URL(sourceHref, document.baseURI || location.href);
            const blockingUrl = new URL(blockingHref, document.baseURI || location.href);
            // Compare the complete browser-local destinations. Redacted public
            // URLs alone cannot prove equality when secret query values differ.
            sameDestination = /^https?:$/.test(sourceUrl.protocol) && sourceUrl.href === blockingUrl.href;
          } catch { /* Invalid destinations provide no substitution evidence. */ }
        }
        const entry = { id: description.id, role: description.role, name: description.name.slice(0, 120),
          ...(description.context ? { context: description.context.slice(0, 160) } : {}),
          ...(description.url ? { url: description.url } : {}), sameDestination };
        if (JSON.stringify([...entries, entry]).length > 1400) break;
        entries.push(entry); ids.add(entry.id);
        if (entries.length === 2) break;
      }
      return entries;
    });
    return error;
  }

  /** Scrolls the target into view (unless told not to) and samples up to 48 points on its visible surfaces. */
  function samplePoints(el, scroll = true) {
    if (scroll) el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const record = byNode.get(el);
    if (!record || !el.isConnected || identity(el) !== record.signature) throw new Error('STALE_ELEMENT: the target changed while scrolling');
    const rects = [], rectKeys = new Set();
    const addRect = (raw) => {
      if (rects.length >= 16) return;
      const left = Math.max(0, raw.left), right = Math.min(innerWidth, raw.right);
      const top = Math.max(0, raw.top), bottom = Math.min(innerHeight, raw.bottom);
      if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return;
      const key = [left, top, right, bottom].join(',');
      if (!rectKeys.has(key)) { rectKeys.add(key); rects.push({ left, top, right, bottom }); }
    };
    const addSurface = (node, raw) => {
      // Overflow clipping can leave a narrow visible strip far from the union
      // box's center/quadrants. Its center is another candidate, never proof of
      // a click: the final browser hit test remains authoritative.
      const clipped = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom };
      let ancestor = node.parentElement;
      for (let depth = 0; ancestor && depth < 12; depth++, ancestor = ancestor.parentElement) {
        const style = styleOf(ancestor);
        const clipX = /^(?:hidden|clip|auto|scroll|overlay)$/.test(style.overflowX || style.overflow);
        const clipY = /^(?:hidden|clip|auto|scroll|overlay)$/.test(style.overflowY || style.overflow);
        if (!clipX && !clipY) continue;
        const r = rectOf(ancestor);
        if (clipX) { clipped.left = Math.max(clipped.left, r.left); clipped.right = Math.min(clipped.right, r.right); }
        if (clipY) { clipped.top = Math.max(clipped.top, r.top); clipped.bottom = Math.min(clipped.bottom, r.bottom); }
      }
      addRect(clipped); addRect(raw);
    };
    // A wrapped/fragmented inline link's bounding box includes empty space.
    // Sample actual fragments before considering the union box.
    const fragments = el.getClientRects?.();
    for (let i = 0; fragments && i < Math.min(fragments.length, 8); i++) addSurface(el, fragments[i]);
    addSurface(el, el.getBoundingClientRect());
    // Pointer-events and card layouts can expose only a small descendant image
    // or label. Inspect a bounded part of this exact target's subtree; no other
    // control or guessed destination becomes eligible for activation.
    const descendants = [];
    for (let i = 0; i < (el.childNodes?.length || 0) && descendants.length < 32; i++) descendants.push(el.childNodes[i]);
    let scanned = 0, surfaces = 0;
    while (descendants.length && scanned++ < 32 && surfaces < 8 && rects.length < 16) {
      const node = descendants.shift();
      if (node.nodeType !== 1 || secret(node) || ownOverlay(node) || !styleVisible(node)) continue;
      addSurface(node, node.getBoundingClientRect()); surfaces++;
      for (let i = 0; i < (node.childNodes?.length || 0) && descendants.length < 32; i++) descendants.push(node.childNodes[i]);
    }
    if (!rects.length) throw new Error('Target is outside the viewport after scrolling');
    const points = [], pointKeys = new Set();
    const positions = [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75],
      [0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]];
    for (const [fx, fy] of positions) {
      for (const r of rects) {
        const insetX = Math.min(3, (r.right - r.left) / 4), insetY = Math.min(3, (r.bottom - r.top) / 4);
        const x = fx === 0 ? r.left + insetX : fx === 1 ? r.right - insetX : r.left + (r.right - r.left) * fx;
        const y = fy === 0 ? r.top + insetY : fy === 1 ? r.bottom - insetY : r.top + (r.bottom - r.top) * fy;
        const key = `${x},${y}`;
        if (!pointKeys.has(key)) { pointKeys.add(key); points.push([x, y]); }
        if (points.length === 48) break;
      }
      if (points.length === 48) break;
    }
    return points;
  }

  async function actionablePoint(el, retry = true) {
    const points = samplePoints(el);
    let cover = null;
    for (const [x, y] of points) {
      const hit = topAt(x, y);
      if (reaches(el, hit)) return { clientX: x, clientY: y };
      if (!cover && hit && !hit.contains?.(el)) cover = { node: hit, x, y };
    }
    // One move, then every point is sampled afresh: a layer that stays, or
    // anything else left on top, is still a covered target.
    if (retry && cover && await moveOff(cover.node, cover.x, cover.y)) return actionablePoint(el, false);
    throw coveredTargetError(el, points);
  }

  async function click(el, hover = false, action) {
    let pressed = false;
    try {
      if (!hover && (el.disabled || attr(el, 'aria-disabled') === 'true')) throw new Error('Element is disabled');
      const init = { ...(await actionablePoint(el)), pointerId: 1, pointerType: 'mouse', button: 0 };
      const validate = () => {
        // Hover/focus handlers can replace streaming poster controls or open a
        // covering panel. Never finish the gesture on an old or hidden node.
        if (resolve(action) !== el) throw new Error('STALE_ELEMENT: the target changed during the pointer gesture');
        if (!hover && (el.disabled || attr(el, 'aria-disabled') === 'true')) throw new Error('Element is disabled');
        if (!hitTarget(el, init.clientX, init.clientY)) throw coveredTargetError(el, [[init.clientX, init.clientY]]);
      };
      validate();
      for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
        emit(el, type, init);
        validate();
      }
      if (hover) return;
      // A press handler may already perform the action. An interrupted gesture
      // after this point is uncertain and must be observed instead of replayed.
      pressed = true;
      const pointerDown = emit(el, 'pointerdown', { ...init, buttons: 1 });
      validate();
      if (pointerDown) { emit(el, 'mousedown', { ...init, buttons: 1 }); validate(); }
      el.focus?.({ preventScroll: true });
      validate();
      emit(el, 'pointerup', init);
      validate();
      emit(el, 'mouseup', init);
      validate();
      // Native click performs checkbox/radio/link activation and emits input/change.
      if (typeof el.click === 'function') el.click();
      else emit(el, 'click', { ...init, detail: 1 });
    } catch (err) {
      err.errorClass = /STALE_(?:ELEMENT|PAGE)/.test(err.message) ? 'stale_target'
        : /covered by another page element/.test(err.message) ? 'covered_target'
        : /disabled/.test(err.message) ? 'disabled_target' : 'click_interrupted';
      err.notDispatched = !pressed;
      if (pressed) err.uncertain = true;
      throw err;
    }
  }

  function checkTextField(el) {
    if (el.disabled || el.readOnly) throw new Error('Field is disabled or read-only');
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) throw new Error('Element is not a text field');
    if (el.tagName === 'INPUT' && /^(file|password|checkbox|radio|submit|button|hidden)$/i.test(el.type)) throw new Error('Unsupported input type');
  }

  function setValue(el, value) {
    checkTextField(el);
    el.focus?.({ preventScroll: true });
    if (el.isContentEditable) el.textContent = value;
    else {
      const proto = el.tagName === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    emit(el, 'input'); emit(el, 'change');
  }

  function pressKey(el, key) {
    const target = el || document.activeElement || document.body;
    target.focus?.({ preventScroll: true });
    const init = { key, code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
    const live = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (live && key === 'Enter' && target.form?.requestSubmit) target.form.requestSubmit();
    if (live && (key.length === 1 || key === 'Backspace' || key === 'Delete') && /^(INPUT|TEXTAREA)$/.test(target.tagName)) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const left = key === 'Backspace' && start === end ? Math.max(0, start - 1) : start;
      const right = key === 'Delete' && start === end ? end + 1 : end;
      setValue(target, target.value.slice(0, left) + (key.length === 1 ? key : '') + target.value.slice(right));
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function scrollContainer(el) {
    let root = el || scopeRoot();
    if (!el && root === document.body) root = document.scrollingElement || root;
    if (!el && root !== document.scrollingElement) {
      const containers = [root, ...all(root, 'main,[role="main"],section,div')];
      root = containers.find((node) => visible(node, true) && node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(styleOf(node).overflowY)) || document.scrollingElement || root;
    }
    return root;
  }

  function scroll(action, el) {
    const root = scrollContainer(el);
    if (action.direction === 'top' || action.direction === 'bottom') {
      root.scrollTo?.({ top: action.direction === 'top' ? 0 : root.scrollHeight, behavior: 'instant' });
      return;
    }
    const vertical = action.direction === 'up' || action.direction === 'down';
    const sign = action.direction === 'up' || action.direction === 'left' ? -1 : 1;
    const amount = sign * (Number(action.amount) || 1) * 0.75 * (vertical ? root.clientHeight || innerHeight : root.clientWidth || innerWidth);
    root.scrollBy?.({ [vertical ? 'top' : 'left']: amount, behavior: 'instant' });
  }

  /** The page's own permission check; only the worker may pass `approved`. */
  function refusal(policy, options) {
    const boundary = options.boundary || options.permissionBoundary || 'entertainment';
    if (!['ask', 'entertainment', 'site'].includes(boundary)) throw new Error('Invalid permission boundary');
    if (!options.approved && policy.category !== 'read' && (boundary === 'ask' || (boundary === 'entertainment' && policy.category === 'sensitive'))) {
      return { ...policy, ok: false, needsConfirmation: true, detail: `Confirm ${policy.label}` };
    }
    return null;
  }

  // --- real input -----------------------------------------------------------
  // The worker can drive Chrome's own mouse and keyboard through chrome.debugger,
  // so a site sees trusted events, hover included, exactly as from a person. The
  // page still chooses where, and nothing is pressed until the approved target is
  // the topmost element under the real pointer: no own overlay is skipped here,
  // because a real press lands on whatever is on top.
  const NATIVE_PICKERS = /^(file|color|date|datetime-local|month|week|time)$/i;
  let gesture = null;

  function trackPointer(event) {
    if (event.isTrusted && gesture) gesture.seen = { x: event.clientX, y: event.clientY };
  }

  function endGesture() {
    if (gesture) globalThis.removeEventListener?.('mousemove', trackPointer, true);
    gesture = null;
  }

  function underPointer(el, x, y) {
    const top = document.elementsFromPoint?.(x, y)?.[0] ?? document.elementFromPoint?.(x, y);
    return !!top && (top === el || el.contains(top));
  }

  function aim(action, el, policy) {
    // Native pickers and the media API stay on the synthetic path: a real press
    // on a select or file input opens browser UI the page cannot see or close.
    if (el.tagName === 'VIDEO' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && NATIVE_PICKERS.test(el.type))) {
      return { ok: false, native: false, pageId };
    }
    if (action.action === 'click' && (el.disabled || attr(el, 'aria-disabled') === 'true')) throw new Error('Element is disabled');
    const points = samplePoints(el);
    // A cover that a real move would dismiss is fine to aim through; the press
    // still waits for `land` to see the target on top.
    const [x, y] = points.find(([px, py]) => underPointer(el, px, py)) ||
      points.find(([px, py]) => !ownOverlay(document.elementsFromPoint?.(px, py)?.[0])) || points[0];
    endGesture();
    gesture = { elementId: action.elementId, x, y, seen: null, retargets: 0 };
    globalThis.addEventListener?.('mousemove', trackPointer, true);
    return { ...policy, ok: true, x, y };
  }

  function land(action, el) {
    if (!gesture || gesture.elementId !== action.elementId) throw new Error('STALE_ELEMENT: aim at the target again');
    const { x, y, seen } = gesture;
    // Only a trusted move proves where the real pointer is.
    if (!seen) return { ok: false, unseen: true, pageId };
    if (Math.abs(seen.x - x) > 2 || Math.abs(seen.y - y) > 2) return { ok: false, misaligned: true, seen, x, y, pageId };
    if (underPointer(el, x, y)) return { ok: true, x, y, pageId };
    // Jester's own pill or cursor would take a real press; scripted events reach the target itself.
    if (hitTarget(el, x, y)) return { ok: false, native: false, pageId };
    // The move itself can open a hover panel over the aimed point while
    // another part of the target stays clear. Never scroll under the pointer.
    const points = samplePoints(el, false);
    const clear = gesture.retargets < 1 && points.find(([px, py]) => underPointer(el, px, py));
    if (clear) {
      Object.assign(gesture, { x: clear[0], y: clear[1], seen: null, retargets: gesture.retargets + 1 });
      return { ok: false, move: { x: clear[0], y: clear[1] }, pageId };
    }
    throw coveredTargetError(el, points);
  }

  function ready(action, el, policy) {
    if (action.action === 'type') {
      checkTextField(el);
      el.focus?.({ preventScroll: true });
      if (document.activeElement !== el) return { ok: false, native: false, pageId };
      // Real text replaces the selection, so select what is there unless appending.
      try {
        if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          if (action.append) range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges(); selection.addRange(range);
        } else if (action.append) el.setSelectionRange(el.value.length, el.value.length);
        else el.select();
      } catch { return { ok: false, native: false, pageId }; }
      return { ...policy, ok: true };
    }
    // Real keys go to whatever has focus.
    el.focus?.({ preventScroll: true });
    return { ...policy, ok: true };
  }

  /** One step of a real-input gesture: aim, land, ready or done. */
  function input(step, raw, options = {}) {
    try {
      if (step === 'done') { endGesture(); return { ok: true, pageId }; }
      const action = normalize(raw);
      let el = resolve(action);
      const policy = classification(action, el);
      if (!el && action.action === 'press_key' && policy.elementId) {
        el = resolve({ ...action, elementId: policy.elementId, pageId: policy.pageId });
      }
      const refused = refusal(policy, options);
      if (refused) return refused;
      const pointer = ['click', 'hover'].includes(action.action), keyboard = ['type', 'press_key'].includes(action.action);
      if (step === 'aim' && pointer) return aim(action, el, policy);
      if (step === 'land' && pointer) return land(action, el);
      if (step === 'ready' && keyboard) return ready(action, el, policy);
      return { ok: false, native: false, pageId };
    } catch (err) {
      endGesture();
      const errorClass = /STALE_(?:ELEMENT|PAGE)/.test(err.message) ? 'stale_target'
        : /covered by another page element/.test(err.message) ? 'covered_target'
          : /disabled/.test(err.message) ? 'disabled_target' : null;
      return { ok: false, detail: String(err.message || err), pageId,
        ...(errorClass ? { errorClass, notDispatched: true } : {}),
        ...(err.blockingElements?.length ? { blockingElements: err.blockingElements } : {}),
        ...(err.hitTest ? { hitTest: err.hitTest } : {}) };
    }
  }

  // --- screenshots ----------------------------------------------------------
  // When the page text is not enough, the worker captures one screenshot with a
  // numbered label on every control a person could click, unnamed icons included.
  // The model answers with an element ID from the legend, never pixel coordinates.
  const MARK_LIMIT = 40;
  let hiddenOverlays = [];

  function onScreen(el) {
    if (!el?.isConnected || !styleVisible(el)) return false;
    const r = rectOf(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /** marks('show') labels the viewport and returns the legend; marks('hide') takes the labels away. */
  function marks(step) {
    try {
      document.getElementById?.('jester-marks')?.remove();
      for (const [node, visibility] of hiddenOverlays) node.style.visibility = visibility;
      hiddenOverlays = [];
      if (step !== 'show') return { ok: true, pageId };
      return readSnapshot(() => {
        syncRoute();
        // A screenshot goes to the model provider: none while a password or payment field is visible.
        if (all(document, 'input,textarea,select,[contenteditable]').some((el) => secret(el) && onScreen(el))) {
          return { ok: false, detail: 'A password or payment field is on screen, so no screenshot was taken.', pageId };
        }
        const picked = [];
        for (const el of all(scopeRoot(), ACTIONABLE + ',video')) {
          if (picked.length >= MARK_LIMIT) break;
          if (!visible(el, true) || picked.some((other) => other.contains(el) || el.contains(other))) continue;
          const r = rectOf(el);
          // Only what a person could click right now: the control must be on top at its centre.
          if (!hitTarget(el, clamp(r.left + r.width / 2, 0, innerWidth - 1), clamp(r.top + r.height / 2, 0, innerHeight - 1))) continue;
          picked.push(el);
        }
        const host = document.createElement('div');
        host.id = 'jester-marks';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        // A closed shadow root keeps page styles from hiding or restyling the labels.
        const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
        const legend = picked.map((el, index) => {
          const r = rectOf(el), n = index + 1;
          const box = document.createElement('div');
          box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
            'outline:2px solid #ffd400;box-sizing:border-box;';
          const badge = document.createElement('div');
          badge.textContent = String(n);
          badge.style.cssText = `position:fixed;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top)}px;` +
            'font:bold 16px/1 system-ui,sans-serif;color:#000;background:#ffd400;padding:2px 5px;border-radius:3px;';
          root.append(box, badge);
          return { n, id: register(el), role: roleOf(el), name: (nameOf(el) || '(unnamed)').slice(0, 60) };
        });
        // Jester's own pill and cursor stay out of the picture. They are mounted
        // directly under <html> or <body>, so those children are all there is to check.
        const children = (node) => Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
        for (const node of [...children(document.documentElement), ...children(document.body)]) {
          if (!ownOverlay(node)) continue;
          hiddenOverlays.push([node, node.style.visibility]);
          node.style.visibility = 'hidden';
        }
        (document.body || document.documentElement).append(host);
        return { ok: true, pageId, legend };
      });
    } catch (err) { return { ok: false, detail: String(err.message || err), pageId }; }
  }

  async function execute(raw, options = {}) {
    try {
      const action = normalize(raw);
      let el = resolve(action);
      const policy = classification(action, el);
      if (!el && action.action === 'press_key' && policy.elementId) {
        el = resolve({ ...action, elementId: policy.elementId, pageId: policy.pageId });
      }
      const refused = refusal(policy, options);
      if (refused) return refused;
      switch (action.action) {
        case 'observe': return observe(action);
        case 'query': case 'find_text': case 'find_elements':
          return readSnapshot(() => compactResult(collect(scopeRoot(), { query: action.query ?? action.text, offscreen: true }), {}));
        case 'read_element': return readSnapshot(() => compactResult([{ el }]));
        case 'read_nearby':
          return readSnapshot(() => compactResult(collect(el.parentElement || el, { offscreen: true }), { maxElements: 30 }));
        case 'inspect_section':
          return readSnapshot(() => compactResult(collect(el, { query: action.query || '', offscreen: true }), { maxElements: 30 }));
        case 'get_form_fields': return readSnapshot(() => compactResult(collect(scopeRoot(), { offscreen: true, fields: true })));
        case 'get_table': {
          const table = el.matches('table,[role="table"],[role="grid"]') ? el : el.closest('table,[role="table"],[role="grid"]');
          if (!table) throw new Error('Element is not part of a table');
          return readSnapshot(() => compactResult(all(table, 'tr,[role="row"]').filter((row) => visible(row)).slice(0, 30).map((row) => ({ el: row }))));
        }
        case 'click':
          if (el.tagName === 'VIDEO') { await actionablePoint(el); if (el.paused) await el.play(); else el.pause(); }
          else await click(el, false, action);
          break;
        case 'hover': await click(el, true, action); break;
        case 'focus': el.scrollIntoView?.({ block: 'center', behavior: 'instant' }); el.focus?.({ preventScroll: true }); break;
        case 'type': setValue(el, (action.append ? el.value || '' : '') + (action.text ?? action.value)); break;
        case 'clear': setValue(el, ''); break;
        case 'select': {
          if (el.tagName !== 'SELECT' || el.disabled) throw new Error('Element is not an enabled select');
          const value = action.value ?? action.text;
          const match = Array.from(el.options || []).find((o) => !o.disabled && (o.value === value || tidy(o.textContent) === value));
          if (!match) throw new Error('No exact option matches that value');
          const setter = globalThis.HTMLSelectElement && Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(el, match.value); else el.value = match.value;
          emit(el, 'input'); emit(el, 'change'); break;
        }
        case 'scroll': scroll(action, el); break;
        case 'press_key': pressKey(el, action.key); break;
        case 'wait': await new Promise((done) => setTimeout(done, action.ms ?? 300)); break;
      }
      return { ...policy, ok: true, detail: `${action.action}: ${policy.label}` };
    } catch (err) {
      return { ok: false, detail: String(err.message || err), pageId,
        ...(err.errorClass ? { errorClass: err.errorClass, notDispatched: err.notDispatched, ...(err.uncertain ? { uncertain: true } : {}) } : {}),
        ...(err.blockingElements?.length ? { blockingElements: err.blockingElements } : {}),
        ...(err.hitTest ? { hitTest: err.hitTest } : {}) };
    }
  }

  /** The current page's ID, so a caller can tell whether the address changed since an observation. */
  function currentRoute() {
    syncRoute();
    return pageId;
  }

  globalThis.__jesterAgentPage = Object.freeze({ version: 1, limits: LIMITS, observe, classify, execute, input, marks, targetAtPoint,
    route: currentRoute });
})();
