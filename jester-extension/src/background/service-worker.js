/**
 * Service worker: owns the offscreen document's lifetime, decides which tab /
 * frame a recognised gesture should act on, and relays HUD updates.
 *
 * Deliberately *not* responsible for gesture logic — that lives in the
 * offscreen document, which is a long-lived page and therefore a much better
 * home for timers and per-frame state than an event-driven worker.
 */

import { ACTIONS, MSG, ENGINE, loadSettings, mergeSettings, post } from '../common/constants.js';
import { loadEnv } from '../common/env.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const TARGET_CACHE_MS = 1500;
const HISTORY_LIMIT = 20;

/** key `${tabId}:${frameId}` -> frame descriptor */
const videoFrames = new Map();

/** tabId -> the context its top frame last reported. */
const tabContext = new Map();

let engineStatus = { state: ENGINE.OFF, detail: '' };
let cachedTarget = null;
let cachedTargetAt = 0;
let lastHudSignature = '';
let offscreenLock = null;
let settingsCache = null;

/**
 * Telemetry arrives ~12×/second, so the settings read on that path has to be
 * cheap. Cached here and invalidated by the storage listener below.
 */
async function getSettings() {
  if (!settingsCache) settingsCache = await loadSettings();
  return settingsCache;
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (offscreenLock) return offscreenLock;
  offscreenLock = (async () => {
    if (await hasOffscreen()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification:
          'Runs the webcam for on-device MediaPipe hand gesture recognition, and the ' +
          'microphone for the voice pill while it is on screen.'
      });
    } catch (err) {
      // Two callers can race past hasOffscreen(); a duplicate is harmless.
      if (!String(err?.message || err).includes('Only a single offscreen')) throw err;
    }
  })().finally(() => {
    offscreenLock = null;
  });
  return offscreenLock;
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (err) {
    // Already gone — two sync passes can overlap. Anything else is real.
    if (!/No current offscreen document/i.test(String(err?.message || err))) throw err;
  }
  clearTimeout(watchdog);
  setStatus({ state: ENGINE.OFF, detail: '' });
}

/**
 * The engine can be re-synced from several directions at once (the popup
 * toggle, the storage listener that toggle triggers, worker startup). Run them
 * one at a time so two passes can't both try to create or close the document,
 * and swallow failures here rather than leaking unhandled rejections.
 */
let syncChain = Promise.resolve();

function syncEngine() {
  syncChain = syncChain.then(runSync).catch((err) => {
    console.error('[jester] engine sync failed', err);
    setStatus({ state: ENGINE.ERROR, detail: String(err?.message || err) });
  });
  return syncChain;
}

async function runSync() {
  const settings = await getSettings();
  if (!settings.enabled) {
    await closeOffscreen();
    return;
  }
  const alreadyRunning = await hasOffscreen();
  await ensureOffscreen();
  if (!alreadyRunning) armWatchdog();
}

/**
 * If the offscreen document fails to boot at all — a module that throws on
 * import, a blocked script — nothing ever reports back and the popup would sit
 * on "Starting…" forever. Say so instead.
 */
let watchdog = null;

function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (engineStatus.state !== ENGINE.STARTING) return;
    setStatus({
      state: ENGINE.ERROR,
      detail:
        'The engine never reported back. Open chrome://extensions, find Jester, ' +
        'and click "offscreen.html" under "Inspect views" to see the error.'
    });
  }, 12000);
}

// ---------------------------------------------------------------------------
// Status + badge
// ---------------------------------------------------------------------------

const BADGE = {
  [ENGINE.OFF]: { text: '', color: '#64748b' },
  [ENGINE.STARTING]: { text: '···', color: '#f59e0b' },
  [ENGINE.RUNNING]: { text: '●', color: '#22c55e' },
  [ENGINE.SUSPENDED]: { text: '❙❙', color: '#64748b' },
  [ENGINE.NO_PERMISSION]: { text: '!', color: '#ef4444' },
  [ENGINE.ERROR]: { text: '!', color: '#ef4444' }
};

function setStatus(status) {
  engineStatus = { ...engineStatus, ...status };
  const badge = BADGE[engineStatus.state] || BADGE[ENGINE.OFF];
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  post({ type: MSG.STATE, engine: engineStatus });
}

/**
 * The one path that flips the master switch, whether it came from the popup
 * toggle or from a gesture bound to `DISABLE`. Writing to storage is what
 * actually drives it: the change listener pushes the new settings to the
 * offscreen document and re-runs `syncEngine()`.
 */
async function setEnabled(enabled) {
  const settings = await getSettings();
  settingsCache = { ...settings, enabled };
  await chrome.storage.local.set({ settings: settingsCache });
  if (enabled) setStatus({ state: ENGINE.STARTING, detail: '' });
  await syncEngine();
  return { ok: true, detail: enabled ? 'Jester on' : 'Camera stopped' };
}

// ---------------------------------------------------------------------------
// Target resolution — which <video> should receive the action?
// ---------------------------------------------------------------------------

const injectable = (url) => !!url && /^https?:/.test(url);
const frameKey = (tabId, frameId) => `${tabId}:${frameId}`;

function rememberFrame(tabId, frameId, info) {
  const key = frameKey(tabId, frameId);
  if (!info?.hasVideo) {
    videoFrames.delete(key);
    return;
  }
  videoFrames.set(key, {
    tabId,
    frameId,
    hasVideo: true,
    playing: !!info.playing,
    area: info.area || 0,
    updatedAt: Date.now(),
    playingAt: info.playing ? Date.now() : videoFrames.get(key)?.playingAt || 0
  });
}

/** Best frame within one tab: prefer a playing video, then the biggest one. */
function bestFrameInTab(tabId) {
  let best = null;
  for (const frame of videoFrames.values()) {
    if (frame.tabId !== tabId) continue;
    const rank = (frame.playing ? 1e9 : 0) + frame.area;
    if (!best || rank > best.rank) best = { ...frame, rank };
  }
  return best;
}

/** Ask every frame in a tab whether it owns a usable video. */
async function probeTab(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const videos = Array.from(document.querySelectorAll('video'));
        let best = null;
        for (const v of videos) {
          if (!v.currentSrc && !v.src && v.readyState === 0) continue;
          const r = v.getBoundingClientRect();
          const area = Math.max(0, r.width) * Math.max(0, r.height);
          const rank = (v.paused ? 0 : 1e9) + area;
          if (!best || rank > best.rank) best = { rank, area, playing: !v.paused };
        }
        return best ? { hasVideo: true, area: best.area, playing: best.playing } : { hasVideo: false };
      }
    });
  } catch {
    return; // no host permission for this tab, or a restricted page
  }
  for (const entry of results || []) {
    rememberFrame(tabId, entry.frameId ?? 0, entry.result);
  }
}

async function resolveTarget({ allowProbe = true } = {}) {
  const now = Date.now();
  if (cachedTarget && now - cachedTargetAt < TARGET_CACHE_MS) return cachedTarget;

  let target = null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (tab && injectable(tab.url)) {
    target = bestFrameInTab(tab.id);
    if (!target && allowProbe) {
      await probeTab(tab.id);
      target = bestFrameInTab(tab.id);
    }
  }

  if (!target) {
    // Nothing in the focused tab — fall back to whatever played most recently.
    let best = null;
    for (const frame of videoFrames.values()) {
      const rank = frame.playingAt || frame.updatedAt;
      if (!best || rank > best.rank) best = { ...frame, rank };
    }
    target = best;
  }

  cachedTarget = target;
  cachedTargetAt = now;
  return target;
}

function invalidateTarget() {
  cachedTarget = null;
  cachedTargetAt = 0;
}

/**
 * The top frame of whatever tab is in front. Actions that aren't aimed at a
 * player — scrolling, and every toast that has no video to land on — go here
 * instead of to `resolveTarget()`.
 */
async function pageTarget() {
  const tabId = await activeTabId();
  return tabId === null ? null : { tabId, frameId: 0 };
}

// ---------------------------------------------------------------------------
// View context — which binding set the engine should be reading
//
// Assembled from two halves. The content script knows about the page's own
// fullscreen and about cinema mode; only this worker can see a window the user
// put fullscreen themselves on a page Jester doesn't run on. Either counts.
// ---------------------------------------------------------------------------

/**
 * `null` until the first read. A worker that has just been restarted has no
 * idea what it last told the engine, and starting from a guess would let the
 * two disagree silently — starting from nothing forces one push.
 */
let viewContext = null;

async function computeContext() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return 'windowed';
  if (tabContext.get(tab.id) === 'fullscreen') return 'fullscreen';
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return win?.state === 'fullscreen' ? 'fullscreen' : 'windowed';
}

/**
 * The engine resolves bindings itself — it owns the hold timers, and those are
 * per-binding — so the answer is pushed to it rather than applied here.
 *
 * Called from plain event listeners as well as from awaited paths, so it
 * swallows its own failures and keeps the last known answer.
 */
async function refreshContext() {
  let next;
  try {
    next = await computeContext();
  } catch {
    return viewContext;
  }
  if (next === viewContext) return viewContext;
  viewContext = next;
  post({ type: MSG.ENGINE_CONFIG, context: viewContext });
  return viewContext;
}

// ---------------------------------------------------------------------------
// Frame messaging
// ---------------------------------------------------------------------------

async function sendToFrame(target, message) {
  try {
    return await chrome.tabs.sendMessage(target.tabId, message, { frameId: target.frameId });
  } catch (err) {
    // Tab was open before the extension loaded — inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: target.tabId, frameIds: [target.frameId] },
        files: ['src/content/content.js']
      });
      return await chrome.tabs.sendMessage(target.tabId, message, { frameId: target.frameId });
    } catch (retryErr) {
      return { ok: false, detail: String(retryErr?.message || retryErr) };
    }
  }
}

// ---------------------------------------------------------------------------
// Fullscreen
//
// `requestFullscreen()` is gated on transient user activation, and a gesture
// recognised in the offscreen document has none — that is a Chrome invariant,
// not something a permission unlocks. Three ways around it, best result first:
//
//   1. native   — free whenever the user happens to have clicked in the last
//                 few seconds, and the only path that costs nothing.
//   2. debugger — Runtime.evaluate({userGesture:true}) forges real activation,
//                 so the site's own fullscreen engages. Opt-in permission.
//   3. cinema   — chrome.windows fullscreen (no activation required at all)
//                 plus a CSS layer pinning the player to it. Always available.
// ---------------------------------------------------------------------------

/** windowId -> the state the window was in before *we* made it fullscreen. */
const restoreWindowState = new Map();

function playerSelector(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return '#movie_player';
  if (/(^|\.)netflix\.com$/.test(host)) return '.watch-video';
  if (/(^|\.)disneyplus\.com$|(^|\.)hotstar\.com$/.test(host)) return '[data-testid="webAppRoot"]';
  if (/(^|\.)twitch\.tv$/.test(host)) return '[data-a-target="video-player"]';
  return '';
}

/** Goes through sendToFrame so it inherits the inject-and-retry fallback. */
function frameFullscreenOp(target, op) {
  return sendToFrame(target, { type: MSG.FULLSCREEN, op });
}

async function enterWindowFullscreen(windowId) {
  const win = await chrome.windows.get(windowId);
  if (win.state === 'fullscreen') return;
  restoreWindowState.set(windowId, win.state || 'normal');
  await chrome.windows.update(windowId, { state: 'fullscreen' });
}

async function exitWindowFullscreen(windowId) {
  const previous = restoreWindowState.get(windowId);
  // No entry means the window was already fullscreen when we got here — the
  // user's own F11. Leave it exactly as we found it.
  if (!previous) return;
  restoreWindowState.delete(windowId);
  await chrome.windows.update(windowId, { state: previous }).catch(() => undefined);
}

/** Runs in the page's main world, under a forged user gesture. */
function fullscreenExpression(selector) {
  const preferred = JSON.stringify(selector || '');
  return `(() => {
    if (document.fullscreenElement) return 'already';
    let el = ${preferred} && document.querySelector(${preferred});
    if (!el) {
      let best = null, rank = -1;
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        const score = (v.paused ? 0 : 1e9) + Math.max(0, r.width) * Math.max(0, r.height);
        if (score > rank) { rank = score; best = v; }
      }
      el = best && (best.parentElement || best);
    }
    if (!el) return 'No video on this page';
    return el.requestFullscreen().then(() => 'ok', (e) => String(e && e.message || e));
  })()`;
}

/**
 * Currently unreachable: Chrome refuses `debugger` in `optional_permissions`, so
 * the options page can't offer this mode and the check below always fails us
 * straight through to cinema. Kept whole — see FULLSCREEN_MODES.debugger for
 * what it would take to switch it back on.
 */
async function trueFullscreen(tabId, url) {
  if (!(await chrome.permissions.contains({ permissions: ['debugger'] }))) {
    return { ok: false, detail: 'Debugger permission not granted' };
  }
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (err) {
    // Most often: DevTools is already attached to this tab.
    return { ok: false, detail: String(err?.message || err) };
  }
  try {
    const response = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: fullscreenExpression(playerSelector(url)),
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    });
    const value = response?.result?.value;
    if (value === 'ok' || value === 'already') return { ok: true, detail: 'Fullscreen' };
    return { ok: false, detail: String(value ?? 'Evaluation failed') };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err) };
  } finally {
    // Let the transition settle before dropping the "being debugged" bar.
    setTimeout(() => chrome.debugger.detach(debuggee).catch(() => undefined), 400);
  }
}

/**
 * Fullscreen with no player to pin — the case the windowed bindings run into
 * constantly. There's nothing to do but put the window itself fullscreen, which
 * is exactly what F11 does, and all "fullscreen" can mean on a page with no
 * video on it.
 */
async function toggleWindowFullscreen(action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const win = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  if (!win) return { ok: false, detail: 'No window in front' };

  if (win.state === 'fullscreen') {
    if (restoreWindowState.has(win.id)) await exitWindowFullscreen(win.id);
    // No entry means the user put this window fullscreen themselves. They have
    // now asked to leave it, so honour that rather than the usual rule of
    // leaving a window we didn't touch exactly as we found it.
    else await chrome.windows.update(win.id, { state: 'normal' }).catch(() => undefined);
    return { ok: true, detail: 'Exited fullscreen' };
  }

  if (action === 'EXIT_FULLSCREEN') return { ok: true, detail: 'Already windowed' };
  await enterWindowFullscreen(win.id);
  return { ok: true, detail: 'Fullscreen' };
}

async function toggleFullscreen(action) {
  const settings = await getSettings();
  const target = await resolveTarget();
  if (!target) return toggleWindowFullscreen(action);

  let tab;
  try {
    tab = await chrome.tabs.get(target.tabId);
  } catch {
    invalidateTarget();
    return { ok: false, detail: 'That tab is gone' };
  }

  // The user may have dropped out of window fullscreen behind our back (F11),
  // in which case there is nothing left for us to restore.
  if (restoreWindowState.has(tab.windowId)) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win && win.state !== 'fullscreen') restoreWindowState.delete(tab.windowId);
  }

  const state = await frameFullscreenOp(target, 'state');
  const isFullscreen = !!(state?.native || state?.cinema);

  if (isFullscreen || action === 'EXIT_FULLSCREEN') {
    if (!isFullscreen && !restoreWindowState.has(tab.windowId)) {
      return { ok: true, detail: 'Already windowed' };
    }
    if (state?.native) await frameFullscreenOp(target, 'native-exit');
    // Always clear the overlay before restoring the window, so the content
    // script's own display-mode watcher sees nothing left to clean up.
    if (state?.cinema) await frameFullscreenOp(target, 'cinema-exit');
    await exitWindowFullscreen(tab.windowId);
    return { ok: true, detail: 'Exited fullscreen' };
  }

  // 1. Real fullscreen, for free, if the user clicked in the page recently.
  if (state?.canActivate) {
    const native = await frameFullscreenOp(target, 'native-enter');
    if (native?.ok) return native;
  }

  // 2. Real fullscreen via a forged gesture, if the user opted in.
  if (settings.fullscreenMode === 'debugger') {
    const forged = await trueFullscreen(tab.id, tab.url);
    if (forged.ok) return forged;
    console.warn('[jester] true fullscreen failed, falling back to cinema —', forged.detail);
  }

  // 3. Cinema mode. Window first: the overlay is sized in viewport units, so it
  //    should be applied against the final viewport.
  await enterWindowFullscreen(tab.windowId).catch((err) =>
    console.warn('[jester] window fullscreen failed', err)
  );
  const cinema = await frameFullscreenOp(target, 'cinema-enter');
  if (!cinema?.ok) {
    await exitWindowFullscreen(tab.windowId);
    return cinema?.detail ? cinema : { ok: false, detail: 'Could not enter fullscreen' };
  }
  return cinema;
}

// ---------------------------------------------------------------------------
// Browser actions — tabs, windows, history
//
// None of these belong to a page, so they run here rather than being handed to
// a content script. That's also what makes them work on the new tab page and
// on every site Jester has no permission for.
// ---------------------------------------------------------------------------

function tabName(tab) {
  const title = String(tab?.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, 40) : 'Tab';
}

/** Anything that changes which tab is in front invalidates both caches. */
function invalidateActiveTab() {
  invalidateTarget();
  invalidateTopFrame();
}

async function performBrowserAction(action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, detail: 'No active tab' };

  switch (action) {
    case 'TAB_NEXT':
    case 'TAB_PREV': {
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      if (tabs.length < 2) return { ok: false, detail: 'Only one tab' };
      tabs.sort((a, b) => a.index - b.index);
      const at = tabs.findIndex((t) => t.id === tab.id);
      const step = action === 'TAB_NEXT' ? 1 : -1;
      // Wraps, because cycling is the whole point of binding this to a swipe.
      const next = tabs[(at + step + tabs.length) % tabs.length];
      await chrome.tabs.update(next.id, { active: true });
      invalidateActiveTab();
      return { ok: true, detail: tabName(next) };
    }

    case 'TAB_MOVE_LEFT':
    case 'TAB_MOVE_RIGHT': {
      const step = action === 'TAB_MOVE_RIGHT' ? 1 : -1;
      const count = (await chrome.tabs.query({ windowId: tab.windowId })).length;
      const index = tab.index + step;
      // Clamped rather than wrapped: unlike switching, a tab that leaps from
      // one end of the strip to the other is hard to undo by eye.
      if (index < 0 || index >= count) {
        return { ok: false, detail: step > 0 ? 'Already last' : 'Already first' };
      }
      await chrome.tabs.move(tab.id, { index });
      return { ok: true, detail: `Position ${index + 1}` };
    }

    case 'TAB_NEW':
      await chrome.tabs.create({ windowId: tab.windowId });
      invalidateActiveTab();
      return { ok: true, detail: 'Opened' };

    case 'TAB_CLOSE': {
      const name = tabName(tab);
      await chrome.tabs.remove(tab.id);
      invalidateActiveTab();
      return { ok: true, detail: name };
    }

    case 'TAB_REOPEN':
      try {
        await chrome.sessions.restore();
        invalidateActiveTab();
        return { ok: true, detail: 'Reopened' };
      } catch {
        return { ok: false, detail: 'Nothing to reopen' };
      }

    case 'WINDOW_NEXT': {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (windows.length < 2) return { ok: false, detail: 'Only one window' };
      windows.sort((a, b) => a.id - b.id);
      const at = windows.findIndex((w) => w.id === tab.windowId);
      const next = windows[(at + 1) % windows.length];
      await chrome.windows.update(next.id, { focused: true });
      invalidateActiveTab();
      return { ok: true, detail: 'Switched window' };
    }

    case 'HISTORY_BACK':
    case 'HISTORY_FORWARD': {
      const back = action === 'HISTORY_BACK';
      try {
        await (back ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id));
        return { ok: true, detail: back ? 'Back' : 'Forward' };
      } catch {
        // Chrome rejects rather than no-ops at either end of the history.
        return { ok: false, detail: back ? 'Nothing behind' : 'Nothing ahead' };
      }
    }

    case 'RELOAD':
      await chrome.tabs.reload(tab.id);
      return { ok: true, detail: 'Reloading' };

    default:
      return { ok: false, detail: `Unknown action ${action}` };
  }
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function announce(action, result) {
  const settings = await getSettings();
  if (!settings.showToasts) return;
  // A browsing action has no player to toast onto, and after a tab switch the
  // tab worth telling is the one you just landed on. Either way, fall back to
  // the other rather than dropping the toast.
  const scope = ACTIONS[action]?.scope;
  const player = scope === 'video' || scope === 'window';
  const target = player
    ? (await resolveTarget({ allowProbe: false })) || (await pageTarget())
    : (await pageTarget()) || (await resolveTarget({ allowProbe: false }));
  if (!target) return;
  chrome.tabs
    .sendMessage(target.tabId, { type: MSG.TOAST, action, result }, { frameId: target.frameId })
    .catch(() => undefined);
}

async function dispatchAction(action, meta) {
  if (!action || action === 'NONE') return;
  const scope = ACTIONS[action]?.scope || 'video';

  if (scope === 'system') {
    // Toast first: once the engine is down this is the only thing that tells
    // you the gesture landed rather than the camera having simply dropped out.
    await announce(action, { ok: true, detail: 'Camera stopped' });
    const result = await setEnabled(false);
    await recordAction({ ...meta, action, ok: result.ok, detail: result.detail });
    return;
  }

  if (scope === 'window') {
    const result = await toggleFullscreen(action);
    await announce(action, result);
    // This *is* the thing that flips the context, and the content script's own
    // report only covers tabs Jester runs on.
    await refreshContext();
    await recordAction({ ...meta, action, ok: !!result.ok, detail: result.detail || '' });
    return;
  }

  if (scope === 'browser') {
    const result = await performBrowserAction(action);
    // The tab you landed on may be fullscreen when the one you left wasn't.
    await refreshContext();
    await announce(action, result);
    await recordAction({ ...meta, action, ok: !!result.ok, detail: result.detail || '' });
    return;
  }

  const settings = await getSettings();
  // `page` actions run against whatever is in front; `video` actions hunt down
  // a player, which may well be in an iframe or even in another tab.
  const target = scope === 'page' ? await pageTarget() : await resolveTarget();

  if (!target) {
    recordAction({
      ...meta,
      action,
      ok: false,
      detail: scope === 'page' ? 'No page to act on' : 'No video tab found'
    });
    return;
  }

  const result = await sendToFrame(target, {
    type: MSG.DO_ACTION,
    action,
    params: {
      seekSeconds: settings.seekSeconds,
      volumeStep: settings.volumeStep,
      speedStep: settings.speedStep,
      scrollStep: settings.scrollStep,
      showToasts: settings.showToasts
    }
  });

  if (result && result.ok === false && /Receiving end|No video/.test(result.detail || '')) {
    invalidateTarget();
  }
  recordAction({ ...meta, action, ok: !!result?.ok, detail: result?.detail || '' });
}

async function recordAction(entry) {
  const record = { ...entry, at: Date.now() };
  const { history = [] } = await chrome.storage.session.get('history');
  const next = [record, ...history].slice(0, HISTORY_LIMIT);
  await chrome.storage.session.set({ history: next });
  post({ type: MSG.ACTION_RESULT, entry: record });
}

// ---------------------------------------------------------------------------
// Top-frame relays — the virtual cursor and the voice pill
//
// Neither is aimed at a <video>: both belong to whatever the user is looking
// at, so they resolve their own target — the active tab's *top* frame — rather
// than going through resolveTarget(). Both arrive at the inference rate, so the
// lookup is cached hard and stale frames are dropped rather than queued.
// ---------------------------------------------------------------------------

const TOP_FRAME_CACHE_MS = 1000;

let topFrameTab = null;
let topFrameTabAt = 0;

/** The active tab, if Jester can reach it at all. Cached hard: see above. */
async function activeTabId() {
  const now = Date.now();
  if (topFrameTabAt && now - topFrameTabAt < TOP_FRAME_CACHE_MS) return topFrameTab;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  topFrameTab = tab && injectable(tab.url) ? tab.id : null;
  topFrameTabAt = now;
  return topFrameTab;
}

/**
 * One send channel to the active tab's top frame, with its own in-flight and
 * unreachable state so a blocked cursor can't stall the pill or vice versa.
 */
function topFrameChannel() {
  let inFlight = false;
  /** A tab we already failed to reach; retrying every frame would be a storm. */
  let unreachable = null;
  /** Did the last attempt land? Optimistic until something proves otherwise. */
  let delivered = true;

  return {
    /** False once the page in front has refused us. @see relayVoice */
    get reachable() {
      return delivered;
    },
    forget() {
      unreachable = null;
      delivered = true;
    },
    /** @param droppable frames the next one supersedes anyway. */
    async send(message, droppable) {
      if (inFlight && droppable) return;

      const tabId = await activeTabId();
      // A restricted page — chrome://, the Web Store — has no tab id we can use.
      if (tabId === null || tabId === unreachable) {
        delivered = false;
        return;
      }

      inFlight = true;
      try {
        await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
        delivered = true;
      } catch {
        // No content script in that frame yet — inject and retry once.
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files: ['src/content/content.js']
          });
          await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
          delivered = true;
        } catch {
          // Restricted page, or Jester has no host permission for this site.
          // Stop trying until the tab changes or the user switches away and back.
          unreachable = tabId;
          delivered = false;
        }
      } finally {
        inFlight = false;
      }
    }
  };
}

const cursorChannel = topFrameChannel();
const voiceChannel = topFrameChannel();

function invalidateTopFrame() {
  topFrameTab = null;
  topFrameTabAt = 0;
  cursorChannel.forget();
  voiceChannel.forget();
}

async function relayCursor(cursor) {
  // The .env kill switch. The engine already refuses to produce these, so this
  // is belt and braces against a stale offscreen document surviving a reload.
  if (!(await loadEnv()).cursor) return;
  // A click, or the cursor going away, must never be dropped. Plain motion can:
  // the next frame supersedes it anyway.
  return cursorChannel.send({ type: MSG.CURSOR, cursor }, cursor.active && !cursor.click);
}

/**
 * Whether the pill is wanted but has nowhere to go. Tracked because the failure
 * is otherwise completely silent: the popup happily reports "☝️ Listening" while
 * the page in front — one Jester has no content script on — draws nothing, and
 * there is no way to tell that from a broken gesture.
 */
let voiceBlocked = false;

async function relayVoice(voice) {
  // The pill going away, and anything carrying words, must never be dropped.
  // Level frames can: the next one supersedes them.
  await voiceChannel.send({ type: MSG.VOICE, voice }, voice.active && !voice.transcript);

  const blocked = !!voice.active && !voiceChannel.reachable;
  if (blocked === voiceBlocked) return;
  voiceBlocked = blocked;
  post({ type: MSG.VOICE_BLOCKED, blocked });
}

// ---------------------------------------------------------------------------
// HUD relay — forward only meaningful changes, not every inference frame
// ---------------------------------------------------------------------------

async function relayHud(telemetry) {
  // Both modes are their own feedback — the cursor, and the voice pill — so a
  // second pill hovering in the corner is just noise. Each collapses to one
  // signature that reads as "no hand".
  const owned = !!telemetry.pointer?.active || !!telemetry.pointing?.active;
  // Cheapest check first: most telemetry frames say the same thing as the last.
  const bucket = Math.round((telemetry.progress || 0) * 10);
  const signature = owned
    ? 'mode'
    : `${telemetry.gesture || ''}|${bucket}|${telemetry.handPresent ? 1 : 0}`;
  if (signature === lastHudSignature) return;
  lastHudSignature = signature;

  const settings = await getSettings();
  if (!settings.showHud) return;

  // Falls back to the page in front so the indicator still shows while you're
  // browsing — with the windowed bindings there may be no video at all.
  const target = (await resolveTarget({ allowProbe: false })) || (await pageTarget());
  if (!target) return;
  chrome.tabs
    .sendMessage(
      target.tabId,
      {
        type: MSG.HUD,
        hud: {
          gesture: telemetry.gesture || null,
          label: telemetry.label || null,
          score: telemetry.score || 0,
          progress: telemetry.progress || 0,
          handPresent: !owned && !!telemetry.handPresent
        }
      },
      { frameId: target.frameId }
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Power management
// ---------------------------------------------------------------------------

/**
 * `pauseWhenNoVideo` is opt-in: left off, Jester keeps watching on every tab, so
 * gestures and the pointer stay live while you browse.
 */
async function shouldSuspend() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.pauseWhenNoVideo) return false;
  return !(await resolveTarget({ allowProbe: false }));
}

async function updateSuspendState() {
  try {
    post({ type: MSG.ENGINE_CONFIG, suspend: await shouldSuspend() });
  } catch (err) {
    console.error('[jester] suspend check failed', err);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case MSG.TRIGGER:
      dispatchAction(message.action, {
        source: message.source,
        gesture: message.gesture,
        context: message.context
      }).catch((err) => console.error('[jester] dispatch failed', err));
      return false;

    case MSG.TELEMETRY:
      relayHud(message.telemetry || {}).catch(() => undefined);
      return false;

    case MSG.CURSOR:
      relayCursor(message.cursor || {}).catch(() => undefined);
      return false;

    case MSG.VOICE:
      relayVoice(message.voice || {}).catch(() => undefined);
      return false;

    case MSG.CURSOR_CLICK:
      // No cursor, no clicks to log — a stale frame must not put an entry in the
      // history for a feature the build says doesn't exist.
      loadEnv()
        .then((env) => {
          if (!env.cursor) return;
          return recordAction({
            source: 'pointer',
            action: 'POINTER_CLICK',
            label: 'Click',
            ok: !!message.ok,
            detail: message.detail || ''
          });
        })
        .catch(() => undefined);
      return false;

    case MSG.ENGINE_STATUS:
      clearTimeout(watchdog);
      setStatus({ state: message.state, detail: message.detail || '' });
      return false;

    case MSG.VIDEO_STATE:
      if (sender.tab) {
        rememberFrame(sender.tab.id, sender.frameId ?? 0, message.info);
        invalidateTarget();
        updateSuspendState();
      }
      return false;

    case MSG.FULLSCREEN_EXIT:
      // The user pressed Escape inside cinema mode.
      dispatchAction('EXIT_FULLSCREEN', { source: 'keyboard' }).catch((err) =>
        console.error('[jester] fullscreen exit failed', err)
      );
      return false;

    case MSG.FULLSCREEN_DETACHED:
      // The user took the window out of fullscreen themselves; the overlay has
      // already cleaned itself up, so just forget the restore entry.
      if (sender.tab) restoreWindowState.delete(sender.tab.windowId);
      return false;

    case MSG.VIEW_CONTEXT:
      if (sender.tab) {
        tabContext.set(sender.tab.id, message.context);
        refreshContext().catch(() => undefined);
      }
      return false;

    case MSG.GET_STATE:
      (async () => {
        const settings = await getSettings();
        const { history = [] } = await chrome.storage.session.get('history');
        const target = await resolveTarget();
        // This worker may have been evicted and restarted since the engine last
        // reported, in which case `engineStatus` is stale. Ask it to re-send.
        if (settings.enabled && (await hasOffscreen())) post({ type: MSG.ENGINE_QUERY });
        sendResponse({
          settings,
          engine: engineStatus,
          history,
          hasTarget: !!target,
          voiceBlocked,
          context: await refreshContext()
        });
      })();
      return true;

    case MSG.SETTINGS_REQUEST:
      // The offscreen document can't read storage itself; it asks us on boot.
      // The suspend flag and the context ride along, so a freshly booted engine
      // starts in the right state instead of running until the first tab switch.
      (async () =>
        sendResponse({
          settings: await getSettings(),
          suspend: await shouldSuspend(),
          context: await refreshContext()
        }))();
      return true;

    case MSG.SET_ENABLED:
      setEnabled(!!message.enabled)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, detail: String(err?.message || err) }));
      return true;

    case MSG.RESTART_ENGINE:
      (async () => {
        await closeOffscreen();
        await syncEngine();
        sendResponse({ ok: true });
      })();
      return true;

    default:
      return false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settingsCache = mergeSettings(changes.settings.newValue);
  // The offscreen document has no storage listener of its own — push to it.
  // If it isn't up yet, syncEngine() below starts it and it asks us directly.
  post({ type: MSG.ENGINE_SETTINGS, settings: settingsCache });
  const before = changes.settings.oldValue?.enabled;
  const after = changes.settings.newValue?.enabled;
  if (before !== after) syncEngine();
  // The engine owns the suspend flag and has no way to know the setting behind
  // it just changed. Without this, switching `pauseWhenNoVideo` off leaves an
  // already-suspended engine stuck until the next tab switch.
  updateSuspendState();
});

chrome.tabs.onActivated.addListener(() => {
  invalidateTarget();
  invalidateTopFrame();
  updateSuspendState();
  refreshContext();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  tabContext.delete(tabId);
  invalidateTarget();
  invalidateTopFrame();
  updateSuspendState();
  refreshContext();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  // A navigation drops any fullscreen the old page was in, and the new page
  // re-reports as soon as its content script comes up.
  tabContext.delete(tabId);
  invalidateTarget();
  updateSuspendState();
  refreshContext();
  // A reload can bring the content script with it, so give the tab another go.
  invalidateTopFrame();
});

chrome.windows.onFocusChanged.addListener(() => {
  invalidateTarget();
  invalidateTopFrame();
  updateSuspendState();
  refreshContext();
});

// Catches F11 on a page Jester doesn't run on, which has no content script to
// report for itself. Chrome commits a state change as a bounds change.
chrome.windows.onBoundsChanged.addListener(() => refreshContext());

chrome.windows.onRemoved.addListener((windowId) => restoreWindowState.delete(windowId));

chrome.runtime.onStartup.addListener(() => syncEngine());

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncEngine();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

// A cold worker start (e.g. after idle eviction) should re-assert the engine.
syncEngine();
refreshContext();
