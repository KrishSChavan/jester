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
import { runAssistant, rateLimits, spentModels } from './assistant.js';

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
  [ENGINE.SLEEPING]: { text: 'Zz', color: '#64748b' },
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
 * The one path that flips the master switch. Only the popup and the options page
 * reach it — no gesture does, because the gesture people want for "stop" is
 * `SLEEP`, which the engine handles itself and can undo. Writing to storage is
 * what actually drives it: the change listener pushes the new settings to the
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
// What's in front
//
// Every gesture is aimed at whatever the user is actually looking at, so all of
// it funnels through `frontTab()`. `chrome.tabs.query({ lastFocusedWindow })` is
// deliberately not that question: "last focused" still answers with a window
// while the user is away in another application, or has minimized the very
// window it names. A window Jester can't see is a window Jester doesn't touch,
// so every caller reads `null` as "there is nothing to act on" and stops there.
// ---------------------------------------------------------------------------

/** Long enough to keep the ~20/s cursor path cheap, short enough to feel instant. */
const FRONT_CACHE_MS = 300;
let frontTabCache = null;
let frontTabCacheAt = 0;

/**
 * Tabs whose top frame has told us it isn't being shown.
 *
 * The second of the two signals, and the one that catches what the windows API
 * can't see: a window that still holds the focus on paper while being entirely
 * covered by another one. Chrome's own occlusion tracking flips
 * `document.visibilityState` for exactly that case, and the page is the only
 * place that reading exists. Absence means visible — a tab that has never
 * reported is a tab Jester has no reason to doubt.
 */
const hiddenTabs = new Set();

/** Whether the front tab last flipped to nothing, so the log stays quiet. */
let hadFront = null;

/**
 * The active tab of the focused, on-screen window.
 *
 * Chrome is asked outright every time this refreshes rather than the answer
 * being kept up to date from `chrome.windows.onFocusChanged`. That event is not
 * dependable enough to be the only thing standing between a backgrounded window
 * and a gesture: it can be missed entirely when focus leaves for another
 * application, and it fires a spurious re-focus for Chrome's own native widgets,
 * either of which leaves a cached answer confidently wrong. `getLastFocused()`
 * reports the live state of the window, so it can only be wrong for as long as
 * the cache above.
 *
 * @returns null whenever Jester should be keeping its hands to itself: Chrome is
 *          behind another application, the focused window is minimized or
 *          covered over, or what's focused is a devtools window with no page.
 */
let frontTabPending = null;

async function frontTab() {
  const now = Date.now();
  if (frontTabCacheAt && now - frontTabCacheAt < FRONT_CACHE_MS) return frontTabCache;

  // Callers arrive in bursts — the cursor relay, a toast and the HUD can all ask
  // inside the same tick. Share one read, or the first to arrive hands the rest
  // the very answer it is in the middle of replacing.
  if (!frontTabPending) {
    frontTabPending = readFrontTab().then((tab) => {
      frontTabPending = null;
      frontTabCache = tab;
      frontTabCacheAt = Date.now();
      const has = !!tab;
      if (has !== hadFront) {
        hadFront = has;
        console.log(`[jester] in front: ${has ? tab.title?.slice(0, 40) || 'a tab' : 'nothing'}`);
      }
      return tab;
    });
  }
  return frontTabPending;
}

/** Never rejects: "couldn't tell" and "nothing there" are the same answer here. */
async function readFrontTab() {
  const win = await chrome.windows.getLastFocused().catch(() => null);

  // The whole rule, in one flag. `getLastFocused` answers with the window the
  // user was last in whether or not Chrome has the focus now, and this is the
  // only part of its answer that says which of the two it is.
  if (!win?.focused) return null;
  if (win.state === 'minimized' || win.type === 'devtools') return null;

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
  if (!tab || hiddenTabs.has(tab.id)) return null;
  return tab;
}

function invalidateFront() {
  frontTabCacheAt = 0;
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
    updatedAt: Date.now()
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

/**
 * Frames within the tab in front, and nowhere else.
 *
 * There used to be a fallback here to whatever video played most recently in
 * any tab, so a gesture could pause a film two tabs over. That is exactly the
 * case the front-window rule exists to stop: a background tab is as out of view
 * as a background window, and an action landing somewhere the user can't see it
 * is indistinguishable from one that didn't work.
 */
async function resolveTarget({ allowProbe = true } = {}) {
  const now = Date.now();
  // The timestamp, not the target — a *miss* is worth caching too, or a page
  // with no player would be re-probed on every call.
  if (cachedTargetAt && now - cachedTargetAt < TARGET_CACHE_MS) return cachedTarget;

  let target = null;
  const tab = await frontTab();

  if (tab && injectable(tab.url)) {
    target = bestFrameInTab(tab.id);
    if (!target && allowProbe) {
      await probeTab(tab.id);
      target = bestFrameInTab(tab.id);
    }
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
  const tab = await frontTab();
  // Nothing in front means nothing is going to fire, so leave the engine reading
  // the set it already has rather than churning it to a guess and back.
  if (!tab) return viewContext || 'windowed';
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
  const tab = await frontTab();
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

/** Anything that changes what's in front invalidates every cache below it. */
function invalidateActiveTab() {
  invalidateFront();
  invalidateTarget();
  invalidateTopFrame();
}

async function performBrowserAction(action) {
  const tab = await frontTab();
  if (!tab) return { ok: false, detail: 'Nothing in front' };

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

/** @returns the `{ ok, detail }` the action produced — the assistant reads it. */
async function dispatchAction(action, meta) {
  if (!action || action === 'NONE') return { ok: false, detail: 'No action' };
  const scope = ACTIONS[action]?.scope || 'video';

  if (scope === 'system') {
    // Sleep is about Jester, not about a window, so it is the one thing that
    // still works with Chrome in the background — and the engine has already
    // flipped by the time this arrives. All that's left here is to say so.
    const { sleeping, hint, ...entry } = meta || {};
    const result = {
      ok: true,
      detail: sleeping ? `Asleep — ${hint || 'the same gesture'} to wake` : 'Awake'
    };
    await announce(action, result);
    await recordAction({ ...entry, action, ...result });
    return result;
  }

  // Everything below lands on a page, a tab or a window, and Jester only ever
  // acts on the one the user is actually looking at. Nothing in front, nothing
  // to do — and deliberately no history entry either: a repeatable pose held at
  // a backgrounded Chrome would fill the whole list with the same non-event.
  if (!(await frontTab())) return { ok: false, detail: 'Nothing in front' };

  if (scope === 'window') {
    const result = await toggleFullscreen(action);
    await announce(action, result);
    // This *is* the thing that flips the context, and the content script's own
    // report only covers tabs Jester runs on.
    await refreshContext();
    await recordAction({ ...meta, action, ok: !!result.ok, detail: result.detail || '' });
    return result;
  }

  if (scope === 'browser') {
    const result = await performBrowserAction(action);
    // The tab you landed on may be fullscreen when the one you left wasn't.
    await refreshContext();
    await announce(action, result);
    await recordAction({ ...meta, action, ok: !!result.ok, detail: result.detail || '' });
    return result;
  }

  const settings = await getSettings();
  // `page` actions run against whatever is in front; `video` actions hunt down
  // a player, which may well be in an iframe or even in another tab.
  const target = scope === 'page' ? await pageTarget() : await resolveTarget();

  if (!target) {
    const result = {
      ok: false,
      detail: scope === 'page' ? 'No page to act on' : 'No video tab found'
    };
    recordAction({ ...meta, action, ...result });
    return result;
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
  return result || { ok: false, detail: 'No response from the page' };
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

/** The tab in front, if Jester can reach it at all. @see frontTab */
async function activeTabId() {
  const tab = await frontTab();
  return tab && injectable(tab.url) ? tab.id : null;
}

/**
 * One send channel to the front tab's top frame, with its own in-flight and
 * unreachable state so a blocked cursor can't stall the pill or vice versa.
 *
 * @param clearMessage what wipes whatever this channel draws. Both of these
 *        leave something on the page that outlives the message that put it
 *        there, so moving to a different tab — or to no tab at all — has to take
 *        it down explicitly, or a cursor stays painted over the window you just
 *        walked away from.
 */
function topFrameChannel(clearMessage) {
  let inFlight = false;
  /** A tab we already failed to reach; retrying every frame would be a storm. */
  let unreachable = null;
  /** Did the last attempt land? Optimistic until something proves otherwise. */
  let delivered = true;
  /** The tab this channel has something drawn on, or null. */
  let owner = null;

  function retire() {
    const tabId = owner;
    owner = null;
    if (tabId === null) return;
    chrome.tabs.sendMessage(tabId, clearMessage, { frameId: 0 }).catch(() => undefined);
  }

  return {
    /** False once the page in front has refused us. @see relayVoice */
    get reachable() {
      return delivered;
    },
    forget() {
      unreachable = null;
      delivered = true;
    },
    retire,
    /** @param droppable frames the next one supersedes anyway. */
    async send(message, droppable) {
      if (inFlight && droppable) return;

      const tabId = await activeTabId();
      // Includes the case that matters most: a tab id of null, because Chrome
      // has gone behind something. Whatever we drew goes with the focus.
      if (tabId !== owner) retire();

      // A restricted page — chrome://, the Web Store — has no tab id we can use.
      if (tabId === null || tabId === unreachable) {
        delivered = false;
        return;
      }

      inFlight = true;
      try {
        await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
        delivered = true;
        owner = tabId;
      } catch {
        // No content script in that frame yet — inject and retry once.
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files: ['src/content/content.js']
          });
          await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
          delivered = true;
          owner = tabId;
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

const cursorChannel = topFrameChannel({ type: MSG.CURSOR, cursor: { active: false } });
const voiceChannel = topFrameChannel({ type: MSG.VOICE, voice: { active: false } });

function invalidateTopFrame() {
  cursorChannel.forget();
  voiceChannel.forget();
}

/**
 * Take the cursor and the pill down wherever they are.
 *
 * `send()` already retires a tab it has moved off, but only while frames are
 * still arriving. Losing the focus mid-gesture is exactly when they might not
 * be — the hand drops on the way to the other application — so the two events
 * that mean "you're looking at something else now" clear it outright.
 */
function retireOverlays() {
  cursorChannel.retire();
  voiceChannel.retire();
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

/**
 * Gets a playing video out of the way of the microphone.
 *
 * Raising a finger to talk over a film means competing with it: the dialogue is
 * what the recogniser hears, and the answer arrives over the top of a scene you
 * are still watching. So the pill going up pauses what's playing.
 *
 * Only what is actually playing, and checked rather than assumed — `videoFrames`
 * is fed by debounced reports and can be a beat behind, and pausing a video that
 * the user had already paused is a change they didn't ask for. Deliberately not
 * un-paused afterwards: what happens next is usually the whole point of having
 * spoken, and second-guessing that is how you end up fighting the user's own
 * hands.
 */
async function pauseForListening() {
  // Only when the pill is a gesture. In `always` mode it goes up because Jester
  // started, not because anybody asked for it, and pausing the film someone had
  // running would be Jester acting entirely on its own.
  const settings = await getSettings();
  if (settings.voicePillMode !== 'pointer-finger') return;

  const target = await resolveTarget();
  if (!target) return;

  let info;
  try {
    info = await chrome.tabs.sendMessage(target.tabId, { type: MSG.PROBE }, { frameId: target.frameId });
  } catch {
    return; // the frame went away between the probe and now
  }
  if (!info?.hasVideo || !info.playing) return;

  await dispatchAction('PAUSE', { source: 'voice' });
}

async function relayVoice(voice) {
  // The opening frame of a session is the index finger going up. @see offscreen.
  if (voice.start) pauseForListening().catch(() => undefined);

  // While the assistant has the pill the engine's frames are not just
  // unwelcome, they're wrong: in `always` mode the microphone never stops, and
  // a level frame arriving mid-run would paint the bars back over the spinner
  // 25 times a second. The one exception is the opening frame of a *new*
  // sentence, which is the user interrupting — that ends the run.
  if (assistantRun || Date.now() < pillHeldUntil) {
    if (!voice.start) return;
    cancelAssistant();
  }

  // The pill going away, and anything carrying words, must never be dropped.
  // Level frames can: the next one supersedes them.
  await voiceChannel.send({ type: MSG.VOICE, voice }, voice.active && !voice.transcript);

  const blocked = !!voice.active && !voiceChannel.reachable;
  if (blocked === voiceBlocked) return;
  voiceBlocked = blocked;
  post({ type: MSG.VOICE_BLOCKED, blocked });
}

// ---------------------------------------------------------------------------
// The assistant
//
// The pill changes hands here. Up to the moment you stop talking it belongs to
// the engine, which drives the bars off the microphone; from then until the run
// finishes it belongs to this, which turns it into a spinner and finally into
// whatever there is to say. `relayVoice` above is the seam.
//
// The loop itself is in assistant.js, which knows nothing about Chrome. This is
// the half that does: reading the page in front, running steps on it, and
// keeping the pill honest across a navigation that destroys it.
// ---------------------------------------------------------------------------

/** How long an answer sits on screen. Kept in step with VOICE_ANSWER_MS in the content script. */
const ANSWER_MS = 4500;
/**
 * What a failure gets on top of that. Enough for a second read: a red pill is
 * usually a sentence about what to do next — which model ran out, what to say
 * instead, that "keep going" will carry on — and four seconds is comfortable
 * for "Done." and short for anything you have to act on.
 *
 * Kept in step with VOICE_ERROR_EXTRA_MS in the content script.
 */
const ANSWER_ERROR_EXTRA_MS = 3000;

/** The run in flight, or null. Holds the pill, and can be cancelled. */
let assistantRun = null;
/** Engine frames are ignored until this passes, so an answer isn't painted over. */
let pillHeldUntil = 0;

/**
 * The last run that stopped with work still in it, so "keep going" can pick it
 * up rather than making the user say the whole sentence again.
 *
 * Held here rather than in the assistant because it is a fact about this
 * browser — which tab, how long ago — and the assistant is deliberately the
 * half that knows nothing about Chrome.
 */
let pendingResume = null;
/** A plan older than this is about a page that has since moved on. */
const RESUME_TTL_MS = 300000;

/** Said to carry on, rather than to ask for something new. */
const CONTINUE = /^(keep (going|at it)|carry on|continu\w*|go on|finish (it|that|up)|resume|and then)\b[\s.!?]*$/i;

/**
 * @returns the state to resume from, or null if this is a new request.
 *          Same tab only: "keep going" said at a different page means something
 *          the stored plan has no bearing on.
 */
function continuation(command, tabId) {
  if (!pendingResume) return null;
  if (!CONTINUE.test(command)) return null;
  if (pendingResume.tabId !== tabId || Date.now() - pendingResume.at > RESUME_TTL_MS) {
    pendingResume = null;
    return null;
  }
  return pendingResume;
}

/**
 * Addressed at a tab rather than going through `voiceChannel`, which always
 * aims at whatever is in front. A run is pinned to the page it was spoken to,
 * and if the user wanders off to another tab while it works, the spinner and
 * the answer belong back where the work is — not floating over something else.
 */
function setPill(tabId, voice) {
  // Held for exactly as long as the content script will show it, or an engine
  // frame lands in the gap and paints the bars over an answer still on screen.
  pillHeldUntil =
    voice.phase === 'answer'
      ? Date.now() + ANSWER_MS + (voice.ok === false ? ANSWER_ERROR_EXTRA_MS : 0)
      : 0;
  if (tabId === null) return Promise.resolve();
  return sendToFrame({ tabId, frameId: 0 }, { type: MSG.VOICE, voice });
}

function cancelAssistant() {
  pillHeldUntil = 0;
  if (!assistantRun) return;
  const run = assistantRun;
  assistantRun = null;
  run.abort();
}

/**
 * Deliberately *not* through `sendToFrame`: its inject-and-retry is exactly
 * wrong here. A click that navigates tears down the content script with the
 * reply still in it, and retrying would run the whole batch a second time
 * against the page that replaced it. A lost reply means the page turned, which
 * is the step having worked — the next look at the page says what it did.
 */
async function assistantAct(tabId, steps) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: MSG.RUN_STEPS, steps }, { frameId: 0 });
    if (result?.results) return result;
    return { results: [{ step: 'run', ok: false, detail: 'the page did not answer' }] };
  } catch {
    return { results: [], navigated: true };
  }
}

/**
 * Roughly where the assistant is — a few dozen names, not the page. The finding
 * happens in the content script, where the elements are.
 */
async function assistantDigest(tabId) {
  const digest = await sendToFrame({ tabId, frameId: 0 }, { type: MSG.PAGE_DIGEST });
  if (digest?.ok) {
    const { tokens, remaining } = rateLimits();
    const out = spentModels();
    console.log(
      `[jester] where: ${digest.count} things to aim at, ${digest.text.length} chars sent` +
        (tokens ? ` · ${remaining}/${tokens} tokens left this minute` : '') +
        (out.length ? ` · out for the day: ${out.join(', ')}` : '')
    );
    return digest;
  }
  return {
    ok: false,
    detail:
      'Jester can’t read this page. It runs on the streaming sites listed in its manifest — ' +
      'tick “Also run on every other site” in Settings to use it anywhere.'
  };
}

async function handleVoiceCommand(text) {
  const command = String(text || '').trim();
  if (!command) return;

  // A second sentence supersedes the first: whatever the last one was doing,
  // the user has moved on and is talking about something else.
  cancelAssistant();

  const tabId = await activeTabId();

  // "keep going" is the previous sentence continued, not a new one. Anything
  // else is a new one, and retires whatever was left over.
  const resume = continuation(command, tabId);

  // Asked to carry on with nothing to carry on with. Worth its own answer: run
  // as a request it would send Jester hunting the page for a button called
  // "keep going", which is a strange thing to watch happen.
  if (!resume && CONTINUE.test(command)) {
    const say = 'There’s nothing to carry on with — say what you’d like.';
    await setPill(tabId, { phase: 'answer', text: say, ok: false });
    await recordAction({ source: 'voice', action: 'ASSISTANT', label: `🗣 “${command.slice(0, 48)}”`, ok: false, detail: say });
    return;
  }

  if (!resume) pendingResume = null;

  const controller = new AbortController();
  const run = { abort: () => controller.abort() };
  assistantRun = run;

  await setPill(tabId, { phase: 'thinking' });

  let result;
  try {
    const env = await loadEnv();
    if (!env.aiOk) {
      result = { ok: false, say: env.aiMessage };
    } else if (tabId === null) {
      result = { ok: false, say: 'Jester can’t reach the page in front — try a normal web page.' };
    } else {
      result = await runAssistant({
        text: command,
        resume,
        env,
        signal: controller.signal,
        host: {
          digest: () => assistantDigest(tabId),
          act: (steps) => assistantAct(tabId, steps),
          // Both of these reach out and change something the user can see, and
          // an abort does not unpark the await a cancelled run is sitting in —
          // `assistantAct` is a plain sendMessage that runs to completion, and a
          // batch carrying a `wait` step can hold a dead run for seconds. By the
          // time it comes back the pill belongs to the sentence that replaced
          // it, so the seam is where ownership has to be checked: `signal` says
          // the run was cancelled, `assistantRun` says who the pill is for now.
          command: (action) =>
            assistantRun === run
              ? dispatchAction(action, { source: 'voice' })
              : Promise.resolve({ ok: false, detail: 'cancelled' }),
          thinking: (step) => {
            if (assistantRun !== run) return Promise.resolve();
            return setPill(tabId, { phase: 'thinking', step: step || '' });
          }
        }
      });
    }
  } catch (err) {
    console.error('[jester] assistant failed', err);
    result = { ok: false, say: String(err?.message || err) };
  }

  // Cancelled, or overtaken by a newer sentence — either way the pill is
  // somebody else's now and this run has nothing left to say on it.
  if (assistantRun !== run) return;
  assistantRun = null;

  // Stopped with work left in it: keep the plan and the trail where "keep going"
  // can find them. Only a run that *finished* clears the slot — a failure that
  // produced no handle of its own (the page wasn't readable, the key was
  // rejected) has said nothing about the plan, and clearing on it would mean a
  // "keep going" that arrived a second too early threw away what it came for.
  pendingResume = result.resume
    ? { ...result.resume, tabId, at: Date.now() }
    : result.ok
      ? null
      : pendingResume;

  const say = result.say || (result.ok ? 'Done.' : 'Sorry — that didn’t work.');
  await setPill(tabId, { phase: 'answer', text: say, ok: result.ok });
  await recordAction({
    source: 'voice',
    action: 'ASSISTANT',
    label: `🗣 “${(resume ? resume.goal : command).slice(0, 48)}”${resume ? ' (continued)' : ''}`,
    ok: !!result.ok,
    detail: say
  });
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
        context: message.context,
        // Only on SLEEP, which the engine has already applied to itself.
        sleeping: message.sleeping,
        hint: message.hint
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

    case MSG.VOICE_COMMAND:
      handleVoiceCommand(message.text).catch((err) =>
        console.error('[jester] voice command failed', err)
      );
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

    case MSG.VIEW_VISIBILITY:
      if (sender.tab) {
        if (message.visible) hiddenTabs.delete(sender.tab.id);
        else hiddenTabs.add(sender.tab.id);
        // This is a page going behind or coming back, which is precisely what
        // the cached answer is about — never let it ride out its 300ms.
        invalidateActiveTab();
        if (!message.visible) retireOverlays();
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
  invalidateActiveTab();
  retireOverlays();
  updateSuspendState();
  refreshContext();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  tabContext.delete(tabId);
  hiddenTabs.delete(tabId);
  invalidateActiveTab();
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
  // The new page reports for itself as soon as its content script comes up, and
  // until then a stale "hidden" would leave the tab unusable.
  hiddenTabs.delete(tabId);
  // A reload can bring the content script with it, so give the tab another go.
  invalidateActiveTab();
  updateSuspendState();
  refreshContext();
});

// Only drops the cached answer — `frontTab()` goes and asks Chrome rather than
// believing what this reports, because it is missed often enough that trusting
// it is what let a backgrounded window keep taking gestures.
chrome.windows.onFocusChanged.addListener(() => {
  invalidateActiveTab();
  retireOverlays();
  updateSuspendState();
  refreshContext();
});

// Catches F11 on a page Jester doesn't run on, which has no content script to
// report for itself, and a window being minimized out from under us. Chrome
// commits a state change as a bounds change.
chrome.windows.onBoundsChanged.addListener(() => {
  invalidateActiveTab();
  refreshContext();
});

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
