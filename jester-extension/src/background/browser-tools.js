/**
 * Chrome's tabs, windows, history, bookmarks and tab groups, for spoken commands.
 * Nothing here touches a page, so these work from any tab, Chrome's own pages
 * included. The chrome API is read when used, so a test can supply its own.
 *
 * Every operation answers { ok, detail } — detail is a sentence fit for the pill —
 * plus `tabId` when the task should continue on another tab, and `tabs`/`items`
 * for the reads.
 */
import { showsAddress } from '../common/sites.js';

const LIST_LIMIT = 40;
const READ_LIMIT = 10;
const DAY_MS = 86400000;
const LOAD_MS = 8000;
const BLANK = /^(?:chrome:\/\/(?:newtab|new-tab-page)\/?|about:blank|chrome-search:\/\/local-ntp\/.*)$/i;

/** A tab showing nothing yet: the New Tab page, or one still being created. */
export function blankTab(tab) {
  const url = tab?.pendingUrl || tab?.url || '';
  return !url || BLANK.test(url);
}

/** An address fit to show a model: no credentials or secret-looking query values, and bounded. */
export function publicAddress(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|password|auth|code|session|secret|sig/i.test(key)) url.searchParams.delete(key);
    }
    if (/token|key|password|auth|secret/i.test(url.hash)) url.hash = '';
    return url.href.slice(0, 300);
  } catch { return String(raw || '').slice(0, 100); }
}

const quote = (title) => `“${String(title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 60)}”`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
function hostLabel(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    return url.pathname === '/' ? host : `${host}${url.pathname}`.slice(0, 60);
  } catch { return 'the page'; }
}
const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/** Every word of the query appears in the tab's title or address. */
export function tabMatches(tab, query) {
  const wanted = words(query);
  if (!wanted.length) return true;
  const hay = `${tab.title || ''} ${tab.url || ''}`.toLowerCase();
  return wanted.every((word) => hay.includes(word));
}

function ago(time, now) {
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function createBrowserTools({ api = () => globalThis.chrome, now = () => Date.now() } = {}) {
  const chrome = () => api();

  /**
   * Load completions, collected from before the step that starts a load, so a
   * page that loads quickly cannot complete unseen between the step and the wait.
   */
  function watchLoads(signal) {
    const done = new Set();
    const waiting = new Map();
    let stopped = false;
    const listener = (tabId, change) => {
      if (change?.status !== 'complete') return;
      done.add(tabId);
      waiting.get(tabId)?.(true);
    };
    chrome().tabs.onUpdated.addListener(listener);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      chrome().tabs.onUpdated.removeListener?.(listener);
      for (const finish of [...waiting.values()]) finish(false);
    };
    signal?.addEventListener?.('abort', stop, { once: true });
    return {
      until(tabId, ms = LOAD_MS) {
        if (done.has(tabId)) return Promise.resolve(true);
        if (stopped || !Number.isInteger(tabId)) return Promise.resolve(false);
        return new Promise((resolve) => {
          const finish = (value) => { clearTimeout(timer); waiting.delete(tabId); resolve(value); };
          const timer = setTimeout(() => finish(false), ms);
          waiting.set(tabId, finish);
        });
      },
      stop
    };
  }

  /** The first tab Chrome creates from now on, or null. */
  function nextCreated(ms = 2000) {
    let finish;
    const listener = (tab) => finish(tab?.id ?? null);
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), ms);
      finish = (value) => { clearTimeout(timer); chrome().tabs.onCreated?.removeListener?.(listener); resolve(value); };
    });
    chrome().tabs.onCreated?.addListener(listener);
    return result;
  }

  async function get(tabId) {
    return Number.isInteger(tabId) ? chrome().tabs.get(tabId).catch(() => null) : null;
  }

  async function activeTab(windowId) {
    const [inWindow] = Number.isInteger(windowId)
      ? await chrome().tabs.query({ active: true, windowId }).catch(() => []) : [];
    if (inWindow) return inWindow;
    const focused = await chrome().windows?.getLastFocused?.().catch(() => null);
    const [front] = focused ? await chrome().tabs.query({ active: true, windowId: focused.id }).catch(() => []) : [];
    return front || null;
  }

  async function focus(tab) {
    await chrome().tabs.update(tab.id, { active: true });
    await chrome().windows?.update?.(tab.windowId, { focused: true }).catch(() => undefined);
  }

  /** Open tabs, the task's window first, as the model may see them. */
  async function listTabs(from, query) {
    const tabs = await chrome().tabs.query({ windowType: 'normal' }).catch(() => []);
    const groups = new Map((await chrome().tabGroups?.query?.({}).catch(() => []) || []).map((group) => [group.id, group.title || 'Unnamed group']));
    tabs.sort((a, b) => (a.windowId === from?.windowId ? -1 : 0) - (b.windowId === from?.windowId ? -1 : 0) ||
      a.windowId - b.windowId || a.index - b.index);
    return tabs.filter((tab) => tabMatches(tab, query)).slice(0, LIST_LIMIT).map((tab) => ({
      tabId: tab.id,
      title: String(tab.title || '').slice(0, 120),
      url: publicAddress(tab.url || tab.pendingUrl || ''),
      ...(tab.id === from?.id ? { current: true } : {}),
      ...(tab.windowId !== from?.windowId ? { otherWindow: true } : {}),
      ...(tab.audible ? { audible: true } : {}),
      ...(tab.mutedInfo?.muted ? { muted: true } : {}),
      ...(tab.pinned ? { pinned: true } : {}),
      ...(groups.has(tab.groupId) ? { group: groups.get(tab.groupId) } : {}),
      ...(Number.isFinite(tab.lastAccessed) ? { lastAccessed: tab.lastAccessed } : {})
    }));
  }

  /** A tab already showing an address: the task's own, then its window's, then the most recent. */
  async function showing(url, from) {
    const tabs = (await chrome().tabs.query({ windowType: 'normal' }).catch(() => []))
      .filter((tab) => showsAddress(tab.url || tab.pendingUrl, url));
    tabs.sort((a, b) => (b.id === from?.id) - (a.id === from?.id) ||
      (b.windowId === from?.windowId) - (a.windowId === from?.windowId) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0] || null;
  }

  async function open(url, from, signal) {
    const existing = await showing(url, from);
    if (existing) {
      await focus(existing);
      return { ok: true, tabId: existing.id, detail: existing.id === from?.id
        ? `Already on ${quote(existing.title)}.` : `Switched to ${quote(existing.title)}.` };
    }
    const loads = watchLoads(signal);
    try {
      let tabId;
      if (from && blankTab(from)) {
        await chrome().tabs.update(from.id, { url, active: true });
        tabId = from.id;
      } else {
        const created = await chrome().tabs.create({ url, active: true,
          ...(from ? { windowId: from.windowId, index: from.index + 1, openerTabId: from.id } : {}) });
        tabId = created.id;
      }
      await loads.until(tabId);
      return { ok: true, tabId, detail: `Opened ${hostLabel(url)}.` };
    } finally { loads.stop(); }
  }

  async function openMany(urls, group, from, signal) {
    const loads = watchLoads(signal);
    try {
      const ids = [];
      for (const [index, url] of urls.entries()) {
        const created = await chrome().tabs.create({ url, active: index === 0,
          ...(from ? { windowId: from.windowId, index: from.index + 1 + index } : {}) });
        ids.push(created.id);
      }
      if (group && chrome().tabs.group) {
        const groupId = await chrome().tabs.group({ tabIds: ids });
        await chrome().tabGroups?.update?.(groupId, { title: group });
      }
      await loads.until(ids[0]);
      return { ok: true, tabId: ids[0], detail: `Opened ${plural(ids.length, 'tab')}${group ? ` in ${quote(group)}` : ''}.` };
    } finally { loads.stop(); }
  }

  async function search(query, from, signal) {
    if (!chrome().search?.query) {
      return open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, from, signal);
    }
    const loads = watchLoads(signal);
    try {
      let tabId;
      if (from && blankTab(from)) {
        await chrome().search.query({ text: query, tabId: from.id });
        tabId = from.id;
      } else {
        const created = nextCreated();
        await chrome().search.query({ text: query, disposition: 'NEW_TAB' });
        tabId = (await created) ?? (await activeTab(from?.windowId))?.id;
      }
      await loads.until(tabId);
      return { ok: true, ...(Number.isInteger(tabId) ? { tabId } : {}), detail: `Searched the web for ${quote(query)}.` };
    } finally { loads.stop(); }
  }

  async function findGroup(name) {
    const groups = await chrome().tabGroups?.query?.({}).catch(() => []) || [];
    const wanted = name.trim().toLowerCase();
    return groups.find((group) => (group.title || '').trim().toLowerCase() === wanted) || null;
  }

  /** Runs one validated `browser` action for the task whose tab is `tabId`. */
  async function run(action, { tabId, signal } = {}) {
    const from = await get(tabId);
    const target = action.tabId !== undefined ? await get(action.tabId) : from;
    if (action.tabId !== undefined && !target) return { ok: false, detail: 'That tab is no longer open.' };
    if (!target && ['back', 'forward', 'reload', 'pin', 'unpin', 'mute', 'unmute', 'duplicate', 'move', 'bookmark'].includes(action.op)) {
      return { ok: false, detail: 'The task’s tab is no longer open.' };
    }
    const loads = () => watchLoads(signal);
    switch (action.op) {
      case 'tabs': {
        const tabs = await listTabs(from, action.query);
        return { ok: true, detail: `${plural(tabs.length, 'open tab')}${action.query ? ` match ${quote(action.query)}` : ''}.`, tabs };
      }
      case 'new': {
        const created = await chrome().tabs.create({ active: true, ...(from ? { windowId: from.windowId, index: from.index + 1 } : {}) });
        return { ok: true, tabId: created.id, detail: 'Opened a new tab.' };
      }
      case 'next':
      case 'previous': {
        const tabs = (await chrome().tabs.query({ windowId: from?.windowId }).catch(() => [])).sort((a, b) => a.index - b.index);
        if (!from || tabs.length < 2) return { ok: false, detail: 'This is the only tab in the window.' };
        const at = tabs.findIndex((tab) => tab.id === from.id);
        const next = tabs[(at + (action.op === 'next' ? 1 : -1) + tabs.length) % tabs.length];
        await focus(next);
        return { ok: true, tabId: next.id, detail: `Switched to ${quote(next.title)}.` };
      }
      case 'open':
        return action.urls ? openMany(action.urls, action.group, from, signal) : open(action.url, from, signal);
      case 'search':
        return search(action.query, from, signal);
      case 'switch':
        await focus(target);
        return { ok: true, tabId: target.id, detail: `Switched to ${quote(target.title)}.` };
      case 'close': {
        const tabs = (await Promise.all((action.tabIds || [target?.id]).map(get))).filter(Boolean);
        if (!tabs.length) return { ok: false, detail: 'Those tabs are already closed.' };
        await chrome().tabs.remove(tabs.map((tab) => tab.id));
        // Its own tab gone, the task carries on with whatever Chrome shows now.
        const next = tabs.some((tab) => tab.id === from?.id) ? await activeTab(from.windowId) : null;
        return { ok: true, ...(next ? { tabId: next.id } : {}),
          detail: tabs.length === 1 ? `Closed ${quote(tabs[0].title)}.` : `Closed ${plural(tabs.length, 'tab')}.` };
      }
      case 'reopen': {
        const watch = loads();
        try {
          let session;
          try { session = await chrome().sessions.restore(); } catch { return { ok: false, detail: 'There is no closed tab to reopen.' }; }
          const tab = session?.tab || session?.window?.tabs?.find((entry) => entry.active) || session?.window?.tabs?.[0];
          if (!tab) return { ok: false, detail: 'There is no closed tab to reopen.' };
          await watch.until(tab.id);
          return { ok: true, tabId: tab.id, detail: `Reopened ${quote(tab.title)}.` };
        } finally { watch.stop(); }
      }
      case 'window': {
        const watch = loads();
        try {
          const created = await chrome().windows.create({ focused: true, ...(action.url ? { url: action.url } : {}) });
          const tabId = created?.tabs?.[0]?.id;
          if (action.url) await watch.until(tabId);
          return { ok: true, ...(Number.isInteger(tabId) ? { tabId } : {}),
            detail: action.url ? `Opened ${hostLabel(action.url)} in a new window.` : 'Opened a new window.' };
        } finally { watch.stop(); }
      }
      case 'back':
      case 'forward': {
        const back = action.op === 'back';
        const watch = loads();
        try {
          try { await (back ? chrome().tabs.goBack(target.id) : chrome().tabs.goForward(target.id)); }
          catch { return { ok: false, detail: back ? 'There is no page to go back to.' : 'There is no page to go forward to.' }; }
          // An in-page route change never completes a load; the next look waits for it instead.
          await watch.until(target.id, 1500);
          return { ok: true, detail: back ? 'Went back.' : 'Went forward.' };
        } finally { watch.stop(); }
      }
      case 'reload': {
        const watch = loads();
        try {
          await chrome().tabs.reload(target.id);
          await watch.until(target.id);
          return { ok: true, detail: 'Reloaded the page.' };
        } finally { watch.stop(); }
      }
      case 'pin':
      case 'unpin':
        await chrome().tabs.update(target.id, { pinned: action.op === 'pin' });
        return { ok: true, detail: `${action.op === 'pin' ? 'Pinned' : 'Unpinned'} ${quote(target.title)}.` };
      case 'mute':
      case 'unmute':
        await chrome().tabs.update(target.id, { muted: action.op === 'mute' });
        return { ok: true, detail: `${action.op === 'mute' ? 'Muted' : 'Unmuted'} ${quote(target.title)}.` };
      case 'duplicate': {
        const watch = loads();
        try {
          const copy = await chrome().tabs.duplicate(target.id);
          if (copy?.id !== undefined) await watch.until(copy.id);
          return { ok: true, ...(copy?.id !== undefined ? { tabId: copy.id } : {}), detail: `Duplicated ${quote(target.title)}.` };
        } finally { watch.stop(); }
      }
      case 'move':
        await chrome().tabs.move(target.id, { index: action.index });
        return { ok: true, detail: `Moved ${quote(target.title)} to position ${action.index + 1}.` };
      case 'group': {
        if (!chrome().tabs.group) return { ok: false, detail: 'Tab groups are not available.' };
        const existing = action.group ? await findGroup(action.group) : null;
        const groupId = await chrome().tabs.group({ tabIds: action.tabIds, ...(existing ? { groupId: existing.id } : {}) });
        const patch = { ...(action.group && !existing ? { title: action.group } : {}), ...(action.color ? { color: action.color } : {}) };
        if (Object.keys(patch).length) await chrome().tabGroups?.update?.(groupId, patch);
        return { ok: true, detail: `Grouped ${plural(action.tabIds.length, 'tab')}${action.group ? ` in ${quote(action.group)}` : ''}.` };
      }
      case 'ungroup':
        if (!chrome().tabs.ungroup) return { ok: false, detail: 'Tab groups are not available.' };
        await chrome().tabs.ungroup(action.tabIds);
        return { ok: true, detail: `Ungrouped ${plural(action.tabIds.length, 'tab')}.` };
      case 'collapse':
      case 'expand': {
        const group = await findGroup(action.group);
        if (!group) return { ok: false, detail: `There is no tab group named ${quote(action.group)}.` };
        await chrome().tabGroups.update(group.id, { collapsed: action.op === 'collapse' });
        return { ok: true, detail: `${action.op === 'collapse' ? 'Collapsed' : 'Expanded'} ${quote(group.title)}.` };
      }
      case 'history': {
        if (!chrome().history?.search) return { ok: false, detail: 'Browsing history is not available.' };
        const found = await chrome().history.search({ text: action.query || '', maxResults: 25,
          startTime: now() - (action.days || 30) * DAY_MS });
        const items = found.filter((entry) => /^https?:/.test(entry.url || '')).slice(0, READ_LIMIT).map((entry) => ({
          title: String(entry.title || '').slice(0, 120), url: publicAddress(entry.url),
          ...(Number.isFinite(entry.lastVisitTime) ? { visited: ago(entry.lastVisitTime, now()) } : {})
        }));
        return { ok: true, detail: items.length ? `${plural(items.length, 'page')} from history.` : 'No matching pages in history.', items };
      }
      case 'bookmarks': {
        if (!chrome().bookmarks?.search) return { ok: false, detail: 'Bookmarks are not available.' };
        const items = [];
        for (const node of (await chrome().bookmarks.search(action.query)).slice(0, READ_LIMIT)) {
          if (node.url) {
            if (/^https?:/.test(node.url)) items.push({ title: String(node.title || '').slice(0, 120), url: publicAddress(node.url) });
            continue;
          }
          const children = await chrome().bookmarks.getChildren(node.id).catch(() => []);
          items.push({ title: String(node.title || '').slice(0, 120), folder: true,
            urls: children.filter((child) => /^https?:/.test(child.url || '')).slice(0, 8).map((child) => publicAddress(child.url)) });
        }
        return { ok: true, detail: items.length ? `${plural(items.length, 'bookmark')} found.` : 'No matching bookmarks.', items };
      }
      case 'bookmark': {
        if (!chrome().bookmarks?.create) return { ok: false, detail: 'Bookmarks are not available.' };
        if (!/^https?:/.test(target?.url || '')) return { ok: false, detail: 'Only web pages can be bookmarked.' };
        const already = await chrome().bookmarks.search({ url: target.url }).catch(() => []);
        if (already.length) return { ok: true, detail: `${quote(target.title)} is already bookmarked.` };
        const title = action.title || target.title;
        await chrome().bookmarks.create({ title, url: target.url });
        return { ok: true, detail: `Bookmarked ${quote(title)}.` };
      }
      default:
        return { ok: false, detail: 'That browser operation is not supported.' };
    }
  }

  return { run, listTabs: async (tabId, query) => listTabs(await get(tabId), query), watchLoads };
}
