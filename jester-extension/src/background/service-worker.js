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
import { runAssistant } from './assistant.js';
import { loadConnection, loadConnections, connectionSummary, saveConnection, clearConnection, listConnectionModels, reorderConnections } from '../common/credentials.js';
import { createPooledModelClient, nextModelCooldown } from './model-pool.js';
import { createRealInput } from './real-input.js';
import { abortableDelay, supportsImages } from './model-client.js';
import { webPage, requiresConfirmation } from '../common/agent-permissions.js';
import { BROWSER_READS } from '../common/agent-actions.js';
import { createBrowserTools, publicAddress } from './browser-tools.js';
import { approvalAnswer } from './browser-intent.js';
import { siteOf } from '../common/sites.js';
import { loadCalibration, clearCalibration } from '../common/gaze-store.js';
import { fromJester, fromEngine, fromPage } from '../common/senders.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const TARGET_CACHE_MS = 1500;
const HISTORY_LIMIT = 20;

/** key `${tabId}:${frameId}` -> frame descriptor */
const videoFrames = new Map();

/** tabId -> the context its top frame last reported. */
const tabContext = new Map();
const tabScreen = new Map();
let calibratingUntil = 0;

let engineStatus = { state: ENGINE.OFF, detail: '' };
/** A voice reply shown on the toolbar badge, where the pill can't be drawn; null when the badge shows engine state. */
let badgeHeld = null;
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
    cancelAssistant();
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
  // A voice reply shown on the badge (where the pill can't be) keeps it until released.
  if (!badgeHeld) {
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  }
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
//
// That rule is the default rather than the law, because the case it gets wrong
// is a real one: a film playing on the other monitor that you only want to
// pause. `actWhenOutOfView` hands those gestures back, and the split is drawn
// between the two readers below — `frontTab()` obeys the setting, `visibleTab()`
// never does. Anything you aim by eye reads the second one, so a cursor is never
// steered across a page you can't see and a pinch never clicks it blind.
// ---------------------------------------------------------------------------

/** Long enough to keep the ~20/s cursor path cheap, short enough to feel instant. */
const FRONT_CACHE_MS = 300;
/** The last `{ tab, outOfView }` reading. Only ever read when the stamp is set. */
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

/** Whether there was last a visible tab in front, so the log stays quiet. */
let hadFront = null;

/** One read in flight, shared by everything that asks while it lands. */
let frontViewPending = null;

/**
 * The active tab of the last-focused window, and whether the user can see it.
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
 * The reading is kept whole and the *decision* left to the two callers below,
 * so that flipping `actWhenOutOfView` takes effect on the next gesture rather
 * than whenever the cache happens to lapse.
 */
async function frontView() {
  const now = Date.now();
  if (frontTabCacheAt && now - frontTabCacheAt < FRONT_CACHE_MS) return frontTabCache;

  // Callers arrive in bursts — the cursor relay, a toast and the HUD can all ask
  // inside the same tick. Share one read, or the first to arrive hands the rest
  // the very answer it is in the middle of replacing.
  if (!frontViewPending) {
    frontViewPending = readFrontView().then((view) => {
      frontViewPending = null;
      frontTabCache = view;
      frontTabCacheAt = Date.now();
      const has = !!view.tab && !view.outOfView;
      if (has !== hadFront) {
        hadFront = has;
        console.log(`[jester] in front: ${has ? view.tab.title?.slice(0, 40) || 'a tab' : 'nothing'}`);
      }
      return view;
    });
  }
  return frontViewPending;
}

/**
 * Never rejects: "couldn't tell" and "nothing there" are the same answer here.
 *
 * @returns `{ tab, outOfView }`. A null `tab` is the case no setting can rescue —
 *          there is no page there to act on at all. `outOfView` is the judgement
 *          `actWhenOutOfView` overrides: a tab that exists, behind something.
 */
async function readFrontView() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win) return { tab: null, outOfView: true };

  // A devtools window is excluded whatever the setting says — it isn't a page
  // that happens to be out of view, it's no page at all.
  if (win.type === 'devtools') return { tab: null, outOfView: true };

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
  if (!tab) return { tab: null, outOfView: true };

  // The whole rule, in three readings. `getLastFocused` answers with the window
  // the user was last in whether or not Chrome has the focus now, and `focused`
  // is the only part of its answer that says which of the two it is; `hiddenTabs`
  // is the page's own account of itself, and catches the window that is covered
  // over while still holding the focus on paper.
  const outOfView = !win.focused || win.state === 'minimized' || hiddenTabs.has(tab.id);
  return { tab, outOfView };
}

/**
 * The tab a gesture should act on.
 *
 * @returns null whenever Jester should be keeping its hands to itself: there is
 *          no page in the last-focused window, or — unless the user has asked
 *          otherwise — that window is behind another application, minimized or
 *          covered over.
 */
async function frontTab() {
  const { tab, outOfView } = await frontView();
  if (!tab) return null;
  if (!outOfView) return tab;
  return (await getSettings()).actWhenOutOfView ? tab : null;
}

/**
 * The tab the user is actually looking at, whatever the settings say.
 *
 * What the cursor and the voice pill draw onto. Both are instruments you aim by
 * eye rather than actions that land somewhere and announce themselves, so
 * neither has any business on a page you can't see — a cursor there can't be
 * steered, and a pinch would click whatever it happened to be resting on.
 */
async function visibleTab() {
  const { tab, outOfView } = await frontView();
  return outOfView ? null : tab;
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
  // `frontTab()` rather than `visibleTab()`: with `actWhenOutOfView` on, the tab
  // a pose is about to land on is the one whose binding set the engine must be
  // reading, whether or not the user can see it.
  const tab = await frontTab();
  // Nothing to act on means nothing is going to fire, so leave the engine
  // reading the set it already has rather than churning it to a guess and back.
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
        files: ['src/content/agent-page.js', 'src/content/content.js']
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

async function toggleFullscreen(action, forcedTarget = null) {
  const settings = await getSettings();
  const target = forcedTarget || await resolveTarget();
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
    if (action === 'VOICE_CAPTURE_TOGGLE') {
      // Any page you're looking at, Chrome's own included: tab commands work everywhere.
      if (!(await visibleTab())) return {ok:false,detail:'Bring a Chrome window to the front to use voice.'};
      const settings = await getSettings();
      if (!settings.enabled || !settings.voiceEnabled) {
        notify('Voice commands are off. Turn Jester and voice on from its toolbar button.');
        return {ok:false,detail:'Voice commands are off'};
      }
      post({type:MSG.VOICE_CONTROL,action:'toggle'});
      return {ok:true,detail:'Voice capture toggled'};
    }
    if (action === 'CALIBRATE_POINTER') return openCalibration();
    if (action === 'DISABLE') return setEnabled(false);
    if (action === 'SLEEP' || action === 'STANDBY_TOGGLE') cancelAssistant();
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

  // Everything below lands on a page, a tab or a window, and by default Jester
  // only acts on the one the user is actually looking at. Nothing in front,
  // nothing to do — and deliberately no history entry either: a repeatable pose
  // held at a backgrounded Chrome would fill the whole list with the same
  // non-event. `actWhenOutOfView` is what turns that case back into an action.
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

/** The tab a gesture should act on, if Jester can reach it at all. @see frontTab */
async function activeTabId() {
  const tab = await frontTab();
  return tab && injectable(tab.url) ? tab.id : null;
}

/**
 * The tab the cursor and the pill may draw on. @see visibleTab
 *
 * Deliberately not `activeTabId()`: this is the one pair of consumers that must
 * not follow `actWhenOutOfView`, so they ask a question that setting can't
 * answer rather than passing a flag down through the relay.
 */
async function visibleTabId() {
  const tab = await visibleTab();
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

      const tabId = await visibleTabId();
      // Includes the case that matters most: a tab id of null, because Chrome
      // has gone behind something. Whatever we drew goes with the focus — and
      // still does when `actWhenOutOfView` is letting actions through, which is
      // why this asks `visibleTabId()` rather than `activeTabId()`.
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
            files: ['src/content/agent-page.js', 'src/content/content.js']
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
 *
 * Unconditional, and stays that way under `actWhenOutOfView`: that setting is
 * about where an action lands, and these two are not actions. @see visibleTab
 */
function retireOverlays() {
  cursorChannel.retire();
  voiceChannel.retire();
}

async function relayCursor(cursor) {
  // The .env kill switch. The engine already refuses to produce these, so this
  // is belt and braces against a stale offscreen document surviving a reload.
  if (cursor.active && !(await getSettings()).pointerEnabled) return;
  // A click, or the cursor going away, must never be dropped. Plain motion can:
  // the next frame supersedes it anyway.
  const tabId = await visibleTabId();
  const zoom = tabId === null ? 1 : await chrome.tabs.getZoom(tabId).catch(() => 1);
  return cursorChannel.send({ type: MSG.CURSOR, cursor:{...cursor,zoom} }, cursor.active && !cursor.click);
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
  if (!settings.voiceEnabled) return;

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
  // While a step waits for "yes" or "no", the microphone is open for that answer:
  // the pill keeps the question, and nothing is paused or cancelled.
  if (approval) return;
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
  // Listening on a page the pill can't reach: the badge says so instead.
  if (blocked) holdBadge('●', '#3b82f6');
  else if (!assistantRun) releaseBadge();
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
/**
 * A paused task is forgotten this long after its last step. "Keep going" is for
 * carrying on straight away; by a minute later the user has moved on, and an
 * old goal left lying around is one a later command can be confused with.
 */
const RESUME_TTL_MS = 60000;
let resumeExpiry = null;

/** Said to carry on, rather than to ask for something new. */
const CONTINUE = /^(keep (going|at it)|carry on|continu\w*|go on|finish (it|that|up)|resume|and then)\b[\s.!?]*$/i;

/**
 * The last few voice commands and how they ended, so a follow-up such as "next
 * episode" or "not that one" can be understood. Context only: the newest command
 * is always the goal. Kept in session storage, because the worker often sleeps
 * between two sentences.
 */
const FOLLOW_UP_KEY = 'recentCommands';
const FOLLOW_UP_TTL_MS = 120000;
const FOLLOW_UP_LIMIT = 3;

async function recentCommands() {
  const saved = (await chrome.storage.session.get(FOLLOW_UP_KEY).catch(() => ({})))?.[FOLLOW_UP_KEY];
  return (Array.isArray(saved) ? saved : []).filter(entry => Date.now() - entry?.at < FOLLOW_UP_TTL_MS).slice(-FOLLOW_UP_LIMIT);
}

async function rememberCommand(said, result) {
  const entry = {said:String(said).slice(0,200),result:String(result.say || (result.ok ? 'Done.' : 'Stopped.')).slice(0,160),at:Date.now()};
  await chrome.storage.session.set({[FOLLOW_UP_KEY]:[...await recentCommands(),entry].slice(-FOLLOW_UP_LIMIT)}).catch(() => undefined);
}

/** Forgets the paused task, in session storage too, or a worker restart would bring it back. */
function dropTask() {
  pendingResume = null;
  clearTimeout(resumeExpiry);
  return chrome.storage.session.remove(TASK_KEY).catch(() => undefined);
}

/** The paused task while it is fresh; one that has gone stale is dropped as it is found. */
function pausedTask() {
  if (pendingResume && !(Date.now() < pendingResume.expiresAt)) dropTask();
  return pendingResume;
}

/** Drops the paused task when it goes stale, if the worker is still awake then; `pausedTask` covers it if not. */
function expireTaskLater() {
  clearTimeout(resumeExpiry);
  if (!pendingResume) return;
  // A "keep going" run in progress owns the task; its end stores or drops it afresh.
  resumeExpiry = setTimeout(() => { if (!assistantRun) pausedTask(); }, pendingResume.expiresAt - Date.now() + 100);
}

/**
 * @returns the state to resume from, or null if this is a new request.
 *          Same tab only: "keep going" said at a different page means something
 *          the stored plan has no bearing on.
 */
function continuation(command, tabId) {
  if (!pausedTask()) return null;
  if (!CONTINUE.test(command)) return null;
  if (pendingResume.tabId !== tabId) {
    dropTask();
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

async function showModelCooldown(tabId, cooldown) {
  if (tabId === null || tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId,{type:'jester/model-cooldown',cooldown},{frameId:0});
  } catch { /* A tab without Jester cannot show a badge. */ }
}
async function refreshModelCooldown(tabId) {
  const connections = await loadConnections();
  await showModelCooldown(tabId,nextModelCooldown(connections));
}

function cancelAssistant() {
  pillHeldUntil = 0;
  releaseBadge();
  if (!assistantRun) return;
  const run = assistantRun;
  assistantRun = null;
  run.abort();
  clearApproval(false);
  realInput.release(run.tabId);
}

/**
 * A task acts on one tab at a time and follows the tabs it opens or switches to
 * ("open YouTube and …"), on any web page. Chrome's own pages can't be read, but
 * a task there still takes browser actions.
 */
const TASK_KEY = 'agentTask';
let approval = null;
const taskReady = chrome.storage.session.get(TASK_KEY).then(saved => {
  const task = saved[TASK_KEY];
  if (!task?.snapshot) return;
  // The task keeps its own clock: waking the worker must not make an old goal new again.
  pendingResume = {...task.snapshot,tabId:task.tabId,expiresAt:Number(task.expiresAt) || 0};
  if (pausedTask()) expireTaskLater();
}).catch(() => undefined);
async function guardAgentTab(tabId) {
  const settings = await getSettings();
  if (!settings.enabled) throw new Error('Jester is off.');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('The task’s tab was closed.');
  return tab;
}

/** Why Jester can't read or act on a tab's page, or '' when it can. */
async function pageAccess(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!webPage(url)) return 'it is one of Chrome’s own pages';
  if (/^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//.test(url)) return 'Chrome protects the Web Store';
  const allowed = await chrome.permissions.contains({origins:[`${new URL(url).origin}/*`]}).catch(() => false);
  return allowed ? '' : 'Jester has no access to this site (turn on “Also run on every other site” in Settings)';
}

/** A page described rather than read, so the model still knows where it is and what still works there. */
function unreadablePage(tab, reason) {
  const url = publicAddress(tab.url || tab.pendingUrl || '');
  const title = String(tab.title || '').slice(0, 160);
  let hash = 0;
  for (const char of url) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return {ok:true,restricted:true,pageId:`tab${tab.id}-${hash.toString(36)}`,revision:0,url,title,elements:[],count:0,truncated:false,
    text:`Page: ${title}\nURL: ${url}\nJester cannot read or control this page: ${reason}. Browser actions still work here.`};
}

function publishApproval() {
  post({type:'jester/approval-state',approval:approval ? {id:approval.id,label:approval.label} : null});
}
function clearApproval(approved = false) {
  if (!approval) return;
  const current = approval; approval = null;
  clearTimeout(current.timer); current.resolve(approved); publishApproval();
}

async function requestApproval(run, label) {
  if (run.signal.aborted) return false;
  const action = String(label).replace(/\s+/g, ' ').trim().slice(0, 80);
  await showPill(run,{phase:'thinking',step:`Allow “${action}”? Say yes or no.`},{notify:true});
  if (run.signal.aborted || assistantRun !== run) return false;
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    approval = {id,label:String(label).slice(0,400),resolve,timer:setTimeout(() => clearApproval(false),60000)};
    run.signal.addEventListener('abort',() => clearApproval(false),{once:true});
    publishApproval();
    // The microphone opens for the answer; the toolbar popup can still approve.
    post({type:MSG.VOICE_CONTROL,action:'start'});
  });
}

async function observeAgent(run, options = {}) {
  const tab = await guardAgentTab(run.tabId);
  const {tabs,...pageOptions} = options;
  const reason = await pageAccess(tab);
  let page = reason ? unreadablePage(tab,reason)
    : await sendToFrame({tabId:tab.id,frameId:0},{type:'jester/agent-observe',options:pageOptions});
  // A page just opened can still be loading its content script.
  if (!page?.ok && !reason) {
    await abortableDelay(400,run.signal);
    page = await sendToFrame({tabId:tab.id,frameId:0},{type:'jester/agent-observe',options:pageOptions});
  }
  // Tab titles and addresses for the local planner only; the model's page never carries them.
  if (page?.ok && tabs) page.tabs = await browserTools.listTabs(tab.id);
  if (page?.ok) noteHosts(run,[page.url,...(page.elements || []).map(entry => entry?.url),...(page.tabs || []).map(entry => entry?.url)]);
  return page;
}

const hostOf = (address) => { try { return new URL(address).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** Sites the task has seen linked or listed: following them needs no extra say-so. */
function noteHosts(run, addresses) {
  run.seenHosts ||= new Set();
  for (const address of addresses) {
    const host = typeof address === 'string' && /^https?:/.test(address) && hostOf(address);
    if (host && run.seenHosts.size < 500) run.seenHosts.add(host);
  }
}
/**
 * A destination the task may open without asking: a listed site, a site the
 * request names ("the Anthropic docs" → docs.anthropic.com), or one the task has
 * seen linked, open or listed. Anything else a model came up with could be a
 * page's text steering it, possibly with data in the address: that is sensitive.
 */
function knownDestination(run, address) {
  const host = hostOf(address);
  if (!host || siteOf(address) || run.seenHosts?.has(host)) return !!host;
  const said = new Set(String(run.goal || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  return host.split('.').slice(0, -1).some(label => label.length > 2 && said.has(label));
}

/** The task moves to another tab: its pill and the debugging session go with it. */
async function retarget(run, tabId) {
  const previous = run.tabId;
  if (tabId === previous) return;
  run.tabId = tabId;
  await chrome.tabs.sendMessage(previous,{type:MSG.VOICE,voice:{active:false}},{frameId:0}).catch(() => undefined);
  await realInput.release(previous);
}

/**
 * The player a spoken playback command means: this tab's, else the one playing
 * in another tab ("pause" while reading Gmail). Gestures never reach a tab out of
 * view; a spoken command names what it wants, and its answer says where it acted.
 */
async function playerFor(tabId) {
  await probeTab(tabId);
  const own = bestFrameInTab(tabId);
  if (own) return {target:own};
  const elsewhere = (frames) => frames.filter(frame => frame.tabId !== tabId).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  let target = elsewhere([...videoFrames.values()].filter(frame => frame.playing));
  if (!target) {
    for (const tab of await chrome.tabs.query({audible:true}).catch(() => [])) {
      if (tab.id === tabId) continue;
      await probeTab(tab.id);
      target = bestFrameInTab(tab.id);
      if (target) break;
    }
  }
  target ||= elsewhere([...videoFrames.values()]);
  const tab = target && await chrome.tabs.get(target.tabId).catch(() => null);
  return tab ? {target,tab} : {target:null};
}

const AGENT_COMMANDS = new Set(['PLAY','PAUSE','PLAY_PAUSE','SEEK_FORWARD','SEEK_BACK','VOLUME_UP','VOLUME_DOWN','MUTE_TOGGLE','SPEED_UP','SPEED_DOWN','SKIP_AD','NEXT_VIDEO','FULLSCREEN_TOGGLE','EXIT_FULLSCREEN']);
async function executeAgent(run, action) {
  if (run.signal.aborted || assistantRun !== run) return {ok:false,detail:'cancelled'};
  const tab = await guardAgentTab(run.tabId);
  const settings = await getSettings();
  const name = action.action;
  let classification;
  if (name === 'command') {
    if (!AGENT_COMMANDS.has(action.actionId)) return {ok:false,detail:'This browser command is not available to the agent.'};
    classification = {ok:true,category:'browse',label:ACTIONS[action.actionId].label};
  } else if (name === 'browser') {
    const destinations = [action.url,...(action.urls || [])].filter(Boolean);
    classification = {ok:true,label:browserApprovalLabel(action),category:BROWSER_READS.has(action.op) ? 'read'
      : destinations.every(url => knownDestination(run,url)) ? 'browse' : 'sensitive'};
  } else if (['navigate','go_back','go_forward'].includes(name)) {
    if (name !== 'navigate') return {ok:false,detail:'Use a visible page control for navigation so the destination can be checked.'};
    if (!webPage(action.url)) return {ok:false,detail:'Only web pages can be opened.'};
    classification = {ok:true,category:knownDestination(run,action.url) ? 'browse' : 'sensitive',label:`Open ${hostOf(action.url)}`};
  } else {
    const reason = await pageAccess(tab);
    if (reason) return {ok:false,detail:`Jester cannot act on this page: ${reason}. Browser actions still work.`};
    classification = await sendToFrame({tabId:run.tabId,frameId:0},{type:'jester/agent-classify',action});
    if (!classification?.ok) return classification || {ok:false,detail:'Could not inspect the target.'};
    if (name === 'press_key' && !action.elementId) {
      if (!classification.elementId || !classification.pageId) return {ok:false,detail:'Choose an explicit target before pressing a key.'};
      action = {...action,elementId:classification.elementId,pageId:classification.pageId};
    }
    if (classification.url && !webPage(classification.url)) return {ok:false,detail:'This link does not lead to a web page.'};
  }
  let approved = false;
  if (requiresConfirmation(settings.agentPermissionBoundary,classification.category)) {
    approved = await requestApproval(run,classification.label);
    if (!approved) { run.abort(); return {ok:false,detail:'Action was not approved.'}; }
  }
  if (run.signal.aborted || assistantRun !== run) return {ok:false,detail:'cancelled'};
  await guardAgentTab(run.tabId);
  if (name === 'browser') {
    if (action.op === 'close') run.closing = new Set(action.tabIds || [action.tabId ?? run.tabId]);
    try {
      const result = await browserTools.run(action,{tabId:run.tabId,signal:run.signal});
      noteHosts(run,[...(result?.tabs || []),...(result?.items || [])].flatMap(entry => [entry?.url,...(entry?.urls || [])]));
      if (result?.ok && Number.isInteger(result.tabId)) await retarget(run,result.tabId);
      return result;
    } finally { run.closing = null; }
  }
  if (name === 'command') {
    if (ACTIONS[action.actionId].scope === 'window') {
      // Fullscreen is for the window in front: the task's tab must be what you're looking at.
      if ((await visibleTab())?.id !== run.tabId) return {ok:false,detail:'Bring the task’s tab to the front for fullscreen.'};
      await probeTab(run.tabId);
      const target = bestFrameInTab(run.tabId);
      return target ? toggleFullscreen(action.actionId,target) : {ok:false,detail:'No player is available in this tab.'};
    }
    const {target,tab:playerTab} = await playerFor(run.tabId);
    if (!target) return {ok:false,detail:'No video is playing in any tab.'};
    try {
      const result = await chrome.tabs.sendMessage(target.tabId,{type:MSG.DO_ACTION,action:action.actionId,params:{seekSeconds:settings.seekSeconds,volumeStep:settings.volumeStep,speedStep:settings.speedStep,showToasts:false}},{frameId:target.frameId});
      return target.tabId !== run.tabId && result?.ok
        ? {...result,detail:`${PLAYED_ELSEWHERE[action.actionId] || ACTIONS[action.actionId].label} ${playerTitle(playerTab)} in another tab.`} : result;
    } catch { return {ok:false,uncertain:true,detail:'The player changed before replying. Inspect playback before repeating.'}; }
  }
  if (name === 'navigate') {
    // Until the new document loads, the old one still answers the next look.
    const loads = browserTools.watchLoads(run.signal);
    try {
      await chrome.tabs.update(run.tabId,{url:action.url});
      return {ok:true,detail:(await loads.until(run.tabId)) ? 'Opened the page.' : 'Navigation started; inspect the new page.'};
    } finally { loads.stop(); }
  }
  const options = {boundary:settings.agentPermissionBoundary,approved};
  if (settings.agentRealInput !== false && !run.syntheticOnly && REAL_INPUT.has(name) && realInput.supported()) {
    const outcome = await executeReal(run,action,options);
    if (outcome) return outcome;
  }
  try {
    // Never retry a mutation: navigation can destroy its reply after the click landed.
    return await chrome.tabs.sendMessage(run.tabId,{type:'jester/agent-execute',action,options},{frameId:0});
  } catch { return {ok:false,uncertain:true,detail:'The document changed before replying. Inspect the current page before deciding what remains.'}; }
}

/** What a playback command did, said of a player in another tab. */
const PLAYED_ELSEWHERE = {PLAY:'Playing',PAUSE:'Paused',PLAY_PAUSE:'Toggled playback of',VOLUME_UP:'Turned up',
  VOLUME_DOWN:'Turned down',MUTE_TOGGLE:'Toggled the sound of',SEEK_FORWARD:'Skipped ahead in',SEEK_BACK:'Skipped back in',
  SPEED_UP:'Sped up',SPEED_DOWN:'Slowed down',SKIP_AD:'Skipped the ad in',NEXT_VIDEO:'Moved to the next video in'};
function playerTitle(tab) {
  const title = String(tab?.title || '').replace(/\s+-\s+YouTube$/i, '').replace(/\s+/g, ' ').trim();
  return title ? `“${title.length > 50 ? `${title.slice(0, 49)}…` : title}”` : 'the video';
}

/** What an approval asks about a browser action, in words. */
function browserApprovalLabel(action) {
  const site = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };
  switch (action.op) {
    case 'open': return action.urls ? `Open ${action.urls.length} tabs` : `Open ${site(action.url)}`;
    case 'search': return `Search the web for “${String(action.query).slice(0, 60)}”`;
    case 'close': return action.tabIds?.length > 1 ? `Close ${action.tabIds.length} tabs` : 'Close the tab';
    case 'bookmark': return 'Bookmark this page';
    default: return `${action.op[0].toUpperCase()}${action.op.slice(1)} tab`;
  }
}

// ---------------------------------------------------------------------------
// Real input — Chrome's own mouse and keyboard, as Claude in Chrome uses them
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screenshots when stuck — one labelled picture for the next model step
// ---------------------------------------------------------------------------

/** Wide enough for the numbered labels to stay legible; a Retina capture is often twice this. */
const SHOT_MAX_WIDTH = 1280;

async function visionAvailable(env) {
  const connections = await loadConnections().catch(() => []);
  return connections.length ? connections.some(supportsImages) : supportsImages(env || {});
}

/** Scales a JPEG capture down to `maxWidth` pixels; unchanged where the worker cannot draw. */
async function shrinkJpeg(base64, maxWidth) {
  const image = {mimeType:'image/jpeg',data:base64};
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return image;
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64),char => char.charCodeAt(0))],{type:'image/jpeg'}));
  try {
    if (bitmap.width <= maxWidth) return image;
    const canvas = new OffscreenCanvas(maxWidth,Math.round(bitmap.height*maxWidth/bitmap.width));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg',quality:0.75})).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return {mimeType:'image/jpeg',data:btoa(binary)};
  } finally { bitmap.close?.(); }
}

/**
 * One screenshot of the task tab with every clickable control numbered, for the
 * model's next step. Never while a password or payment field is visible, and only
 * when a saved model can read images.
 */
async function lookAgent(run,env) {
  const settings = await getSettings();
  if (settings.agentScreenshots === false) return {ok:false,detail:'Screenshots are off in Settings.'};
  if (!(await visionAvailable(env))) return {ok:false,detail:'None of your saved models can read screenshots. Add one that can, such as Gemini, in Settings.'};
  if (run.signal.aborted || assistantRun !== run) return {ok:false,detail:'cancelled'};
  await guardAgentTab(run.tabId);
  // Attach first: Chrome's debugging bar must not shift the page after the labels are drawn.
  const viaDebugger = settings.agentRealInput !== false && !run.syntheticOnly && realInput.supported() && await realInput.attach(run.tabId);
  const tab = viaDebugger ? null : await chrome.tabs.get(run.tabId);
  if (tab && !tab.active) return {ok:false,detail:'Bring the task tab to the front so Jester can take a screenshot.'};
  const frame = {tabId:run.tabId,frameId:0};
  const marked = await sendToFrame(frame,{type:'jester/agent-marks',step:'show'});
  if (!marked?.ok) return marked || {ok:false,detail:'The page could not be labelled.'};
  try {
    const base64 = viaDebugger ? await realInput.screenshot(run.tabId)
      : (await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:70})).split(',')[1];
    return {ok:true,image:await shrinkJpeg(base64,SHOT_MAX_WIDTH),legend:marked.legend};
  } catch (error) {
    return {ok:false,detail:`The screenshot could not be taken: ${String(error?.message || error).slice(0,120)}`};
  } finally {
    await sendToFrame(frame,{type:'jester/agent-marks',step:'hide'}).catch(() => undefined);
  }
}

/** Actions that go through the debugger mouse and keyboard when they can. */
const REAL_INPUT = new Set(['click','hover','type','press_key']);
/** Long enough for hover reveals and mouse-move-dismissed layers to react. */
const REAL_MOVE_SETTLE_MS = 100;
const browserTools = createBrowserTools();
const realInput = createRealInput({
  // Dismissing Chrome's debugging bar means "stop debugging": the run carries on with synthetic events.
  onUserCancel:tabId => { if (assistantRun?.tabId === tabId) assistantRun.syntheticOnly = true; }
});

/**
 * One action through real input. The page aims and confirms; the worker only
 * moves and presses. Returns null to fall back to synthetic events — before
 * anything was pressed — whenever real input cannot be used safely.
 */
async function executeReal(run,action,options) {
  const {tabId} = run;
  const page = step => sendToFrame({tabId,frameId:0},{type:'jester/agent-input',step,action,options});
  const live = () => !run.signal.aborted && assistantRun === run && !run.syntheticOnly;
  const done = () => page('done').catch(() => undefined);
  const fallBack = async () => { await done(); return null; };
  const succeeded = (policy) => {
    const {x,y,...result} = policy;
    return {...result,ok:true,detail:`${action.action}: ${policy.label || action.action}`};
  };
  try {
    if (action.action === 'type' || action.action === 'press_key') {
      const ready = await page('ready');
      if (!ready?.ok) return ready?.native === false ? fallBack() : ready;
      if (!(await realInput.attach(tabId)) || !live()) return fallBack();
      try {
        if (action.action === 'type') await realInput.insertText(tabId,action.text);
        else await realInput.key(tabId,action.key);
      } catch { return {ok:false,uncertain:true,detail:'Typing was interrupted. Inspect the field before repeating.'}; }
      await done();
      return succeeded(ready);
    }
    let aimed = await page('aim');
    if (!aimed?.ok) return aimed?.native === false ? fallBack() : aimed;
    if (!realInput.attached(tabId)) {
      if (!(await realInput.attach(tabId))) return fallBack();
      // Chrome's debugging bar can resize the page as it appears: aim again on the settled layout.
      await abortableDelay(150,run.signal);
      aimed = await page('aim');
      if (!aimed?.ok) return aimed?.native === false ? fallBack() : aimed;
    }
    let target = {x:aimed.x,y:aimed.y};
    let landed = null;
    for (let attempt = 0; attempt < 3 && live(); attempt++) {
      await realInput.move(tabId,target.x,target.y);
      await abortableDelay(REAL_MOVE_SETTLE_MS,run.signal);
      landed = await page('land');
      if (landed?.move) { target = landed.move; continue; }
      // Zoom can make debugger units differ from CSS pixels; correct once from where the pointer was seen.
      if (landed?.misaligned && attempt === 0 && realInput.calibrate(tabId,target,landed.seen)) continue;
      break;
    }
    if (!live()) return run.signal.aborted || assistantRun !== run ? {ok:false,detail:'cancelled'} : fallBack();
    // Unproven pointer position, or Jester's own overlay on top: nothing is pressed through the debugger.
    if (landed?.unseen || landed?.misaligned || landed?.move || landed?.native === false) return fallBack();
    if (!landed?.ok) return landed || {ok:false,notDispatched:true,detail:'The page changed before the press.'};
    if (action.action === 'click') {
      try { await realInput.press(tabId,landed.x,landed.y); }
      catch { return {ok:false,uncertain:true,detail:'The click was interrupted. Inspect the page before repeating.'}; }
    }
    await done();
    return succeeded(aimed);
  } catch (error) {
    if (run.signal.aborted || assistantRun !== run) return {ok:false,detail:'cancelled'};
    // Nothing reached the page through the debugger: the synthetic path may still try.
    console.info('[jester] real input unavailable',String(error?.message || error).slice(0,120));
    return fallBack();
  }
}
async function handleVoiceCommand(text, explicitResume = false) {
  const command = String(text || '').trim().slice(0,2000);
  if (!command && !explicitResume) return;
  // The answer to "Allow …? Say yes or no." Anything else is a new request, and not a yes.
  if (approval && !explicitResume) {
    const answer = approvalAnswer(command);
    if (assistantRun && answer !== 'yes') assistantRun.declined = true;
    clearApproval(answer === 'yes');
    if (answer) return;
  }
  await taskReady;
  const settings = await getSettings();
  if (!settings.enabled || !settings.voiceEnabled) return;
  cancelAssistant();
  // Whatever tab you're looking at, Chrome's own pages included: browser commands work there.
  const tab = await visibleTab();
  const tabId = tab?.id ?? null;
  const resume = explicitResume ? pausedTask() : continuation(command,tabId);
  if ((explicitResume || CONTINUE.test(command)) && (!resume || resume.tabId !== tabId)) {
    await reply(tabId,{phase:'answer',text:'There is no task to resume on this tab.',ok:false}); return;
  }
  // A new request replaces whatever was paused; its goal is the only one now.
  if (!resume) await dropTask();
  if (!tab) return;
  const controller = new AbortController();
  // `tabId` changes as the task opens and switches tabs.
  const run = {tabId,goal:resume?.goal || command,signal:controller.signal,abort:() => controller.abort()};
  assistantRun = run;
  // `resumableAt` is when the task can next make progress; its minute starts then.
  const persist = async (snapshot, resumableAt = 0) => {
    if (assistantRun !== run) return;
    if (!snapshot) return dropTask();
    const expiresAt = Math.max(Date.now(), resumableAt) + RESUME_TTL_MS;
    pendingResume = {...snapshot,tabId:run.tabId,expiresAt};
    await chrome.storage.session.set({[TASK_KEY]:{snapshot,tabId:run.tabId,expiresAt}});
  };
  await showPill(run,{phase:'thinking'});
  let result;
  try {
    // "click" in combined mode is deterministic and uses the current gaze target.
    if (/^(click|click (here|that)|select that)[.!]?$/i.test(command) && settings.pointerEnabled && settings.pointerInput === 'both') {
      const target = await sendToFrame({tabId,frameId:0},{type:'jester/cursor-target'});
      if (!target?.ok) result = {ok:false,say:target?.detail || 'Show the eye/head cursor first.'};
      else {
        const action = {action:'click',elementId:target.elementId,pageId:target.pageId};
        const outcome = await executeAgent(run,action);
        result = {ok:outcome?.ok,say:outcome?.detail || 'Clicked.'};
      }
    } else {
      const config = await loadConnection();
      // Preserve existing .env Groq connections during migration, without broadcasting secrets.
      const migrated = (await chrome.storage.local.get('modelConnectionConfigured')).modelConnectionConfigured;
      const legacy = config || migrated ? null : await loadEnv();
      const env = config || (legacy?.aiOk ? {provider:'groq',protocol:'openai-compatible',baseUrl:'https://api.groq.com/openai/v1',model:legacy.aiModel || 'llama-3.3-70b-versatile',key:legacy.aiKey} : null);
      const pooledModel = config ? createPooledModelClient({
        // The pill keeps saying what the task is doing; which model answers is only logged.
        onSelected:async (selected,requestSignal) => {
          if (assistantRun !== run || run.signal.aborted || requestSignal.aborted) return;
          await showModelCooldown(run.tabId,null);
          console.info('[jester] model selected',JSON.stringify(selected));
        },
        onLimited:limited => console.info('[jester] model cooldown',JSON.stringify(limited)),
        // Waiting a few seconds for a per-minute window is cheaper than tripping the provider's limit.
        onPacing:async ({provider,waitMs}) => {
          if (assistantRun !== run || run.signal.aborted) return;
          console.info('[jester] model pacing',JSON.stringify({provider,waitMs}));
          await showPill(run,{phase:'thinking',step:`Waiting ${Math.ceil(waitMs/1000)}s for ${provider}'s per-minute limit`});
        },
        onUnavailable:cooldown => assistantRun === run && !run.signal.aborted ? showModelCooldown(run.tabId,cooldown) : undefined
      }) : undefined;
      // A continuation's goal is the paused one, so it carries no follow-up context.
      const previous = resume ? [] : await recentCommands();
      result = await runAssistant({text:command,resume,previous,env:env||{},signal:controller.signal,
        ...(pooledModel ? {modelClient:pooledModel} : {}),host:{
        observe:options => observeAgent(run,options), execute:action => executeAgent(run,action), checkpoint:persist,
        look:() => lookAgent(run,env),
        thinking:step => assistantRun === run ? showPill(run,{phase:'thinking',step:typeof step === 'string' ? step : step?.status || ''}) : Promise.resolve()
      }});
    }
  } catch (err) { result = {ok:false,say:String(err?.message || err).slice(0,350)}; }
  if (assistantRun !== run) return;
  // The debugging bar is only for the length of a task.
  await realInput.release(run.tabId);
  await rememberCommand(resume?.goal || command,result);
  // Waiting out a provider cooldown is not inactivity: "keep going" cannot work until it ends.
  if (result.resume) {
    await persist(result.resume,Math.max(result.retryAt || 0,
      nextModelCooldown(await loadConnections().catch(() => []))?.readyAt || 0));
    expireTaskLater();
  } else if (result.ok) await persist(null);
  assistantRun = null;
  clearApproval(false);
  const said = result.say || (run.declined ? 'Okay, I didn’t do that.' : result.ok ? 'Done.' : 'The task stopped.');
  await reply(run.tabId,{phase:'answer',text:said,ok:!!result.ok});
  await recordAction({source:'voice',action:'ASSISTANT',label:`Voice: ${(resume?.goal || command).slice(0,70)}`,ok:!!result.ok,detail:said});
}

// ---------------------------------------------------------------------------
// Replies where the pill can't be drawn — Chrome's own pages, the Web Store,
// sites Jester has no access to: the toolbar badge, and a notification for
// questions and answers. The popup's list keeps the full reply either way.
// ---------------------------------------------------------------------------

/** Shows the pill on the task's tab, or says it another way where it can't be drawn. */
async function showPill(run, voice, {notify: ask = false} = {}) {
  const delivered = await setPill(run.tabId,voice);
  if (delivered?.ok !== false) return true;
  holdBadge('…','#64748b');
  if (ask && voice.step) notify(voice.step,run.tabId);
  return false;
}

/** The final answer: on the pill, else as a badge and a notification. */
async function reply(tabId, voice) {
  const delivered = await setPill(tabId,voice);
  if (delivered?.ok !== false) { releaseBadge(); return; }
  flashBadge(voice.ok === false ? '!' : '✓',voice.ok === false ? '#ef4444' : '#22c55e');
  notify(voice.text,tabId);
}

/** Shows a badge until released, over the engine's own state badge. */
function holdBadge(text, color) {
  clearTimeout(badgeHeld?.timer);
  badgeHeld = {timer:null};
  chrome.action.setBadgeText({text});
  chrome.action.setBadgeBackgroundColor({color});
}
function flashBadge(text, color, ms = 6000) {
  holdBadge(text,color);
  badgeHeld.timer = setTimeout(releaseBadge,ms);
}
function releaseBadge() {
  if (!badgeHeld) return;
  clearTimeout(badgeHeld.timer);
  badgeHeld = null;
  setStatus({});
}

const NOTIFICATION_TABS = new Map();
function notify(message, tabId = null) {
  const text = String(message || '').trim().slice(0,300);
  if (!text || !chrome.notifications?.create) return;
  const id = `jester-${Date.now()}`;
  if (tabId !== null) NOTIFICATION_TABS.set(id,tabId);
  Promise.resolve(chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),
    title:'Jester',message:text,priority:0,silent:true})).catch(() => undefined);
}
// Clicking a reply goes back to the tab it is about.
chrome.notifications?.onClicked?.addListener(id => {
  const tabId = NOTIFICATION_TABS.get(id);
  NOTIFICATION_TABS.delete(id);
  chrome.notifications.clear(id);
  if (tabId !== undefined) chrome.tabs.get(tabId).then(tab => {
    chrome.tabs.update(tab.id,{active:true});
    chrome.windows.update(tab.windowId,{focused:true});
  }).catch(() => undefined);
});
chrome.notifications?.onClosed?.addListener(id => NOTIFICATION_TABS.delete(id));

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
  if (!settings.enabled || !settings.pauseWhenNoVideo || Date.now() < calibratingUntil) return false;
  return !(await resolveTarget({ allowProbe: false }));
}

async function updateSuspendState() {
  try {
    post({ type: MSG.ENGINE_CONFIG, suspend: await shouldSuspend() });
  } catch (err) {
    console.error('[jester] suspend check failed', err);
  }
}

// Calibration and message access remain local to extension-owned pages.
async function openCalibration() {
  const url = chrome.runtime.getURL('src/calibration/calibration.html');
  const [existing] = await chrome.tabs.query({url});
  const tab = existing || await chrome.tabs.create({url});
  if (existing) await chrome.tabs.update(existing.id,{active:true});
  await chrome.windows.update(tab.windowId,{focused:true}).catch(() => undefined);
  await chrome.tabs.setZoomSettings(tab.id,{mode:'automatic',scope:'per-tab'}).catch(() => undefined);
  await chrome.tabs.setZoom(tab.id,1).catch(() => undefined);
  return {ok:true,detail:'Calibration opened'};
}
async function currentScreen() {
  const tab = await visibleTab();
  return tab ? tabScreen.get(tab.id) || null : null;
}
function respond(sendResponse, callback) {
  Promise.resolve().then(callback).then(sendResponse).catch(err => sendResponse({ok:false,detail:String(err?.message || err).slice(0,400)}));
  return true;
}
const ENGINE_MESSAGES = new Set([MSG.TRIGGER,MSG.TELEMETRY,MSG.CURSOR,MSG.VOICE,MSG.VOICE_COMMAND,MSG.ENGINE_STATUS,MSG.SETTINGS_REQUEST]);
const PAGE_MESSAGES = new Set([MSG.VIDEO_STATE,MSG.VIEW_CONTEXT,MSG.VIEW_VISIBILITY,MSG.FULLSCREEN_EXIT,MSG.FULLSCREEN_DETACHED]);
function allowed(type,sender) {
  if (ENGINE_MESSAGES.has(type)) return fromEngine(sender);
  if (PAGE_MESSAGES.has(type)) return fromPage(sender);
  if (type === MSG.CURSOR_CLICK || type === 'jester/cancel-task') return fromPage(sender) || fromEngine(sender) || fromJester(sender);
  return fromJester(sender);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!allowed(message?.type,sender)) return false;
  switch (message?.type) {
    case 'jester/model-get':
      return respond(sendResponse,async () => ({ok:true,connection:await connectionSummary()}));
    case 'jester/model-save':
      return respond(sendResponse,async () => { cancelAssistant(); return {ok:true,connection:await saveConnection(message.connection)}; });
    case 'jester/model-clear':
      return respond(sendResponse,async () => { cancelAssistant(); return {ok:true,connection:await clearConnection(message.id)}; });
    case 'jester/model-reorder':
      return respond(sendResponse,async () => { cancelAssistant(); return {ok:true,connection:await reorderConnections(message.ids)}; });
    case 'jester/model-list':
      return respond(sendResponse,async () => ({ok:true,models:await listConnectionModels(message.id)}));
    case 'jester/agent-approval':
      if (approval?.id === message.id) clearApproval(message.approved === true);
      sendResponse({ok:true}); return false;
    case 'jester/cancel-task':
      cancelAssistant();
      post({type:MSG.VOICE_CONTROL,action:'cancel'});
      voiceChannel.retire();
      sendResponse({ok:true}); return false;
    case 'jester/resume-task':
      handleVoiceCommand('keep going',true).catch(err => console.warn('[jester] resume failed',err));
      sendResponse({ok:true}); return false;
    case MSG.VOICE_CONTROL:
      // Offscreen receives extension messages directly; never relay twice.
      sendResponse({ok:true}); return false;
    case MSG.OPEN_CALIBRATION:
      return respond(sendResponse,openCalibration);
    case MSG.GET_CALIBRATION:
      return respond(sendResponse,async () => ({calibration:await loadCalibration()}));
    case MSG.CLEAR_CALIBRATION:
      return respond(sendResponse,async () => { await clearCalibration(); post({type:MSG.CALIBRATION_MODEL,calibration:null}); return {ok:true}; });
    case MSG.CALIBRATION_SAVED:
      loadCalibration().then(calibration => post({type:MSG.CALIBRATION_MODEL,calibration})); return false;
    case MSG.CALIBRATION_MODE:
      calibratingUntil = message.on ? Date.now()+2500 : 0;
      updateSuspendState(); return false;
    case MSG.TRIGGER:
      dispatchAction(message.action, {
        source: message.source,
        gesture: message.gesture,
        context: message.context,
        // Only on SLEEP, which the engine has already applied to itself.
        sleeping: message.sleeping ?? message.standby,
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
      if ((message.surface === 'video' || message.surface === 'frame-video') && sender.tab) {
        const frame = message.surface === 'frame-video' ? bestFrameInTab(sender.tab.id) : {tabId:sender.tab.id,frameId:sender.frameId || 0};
        if (frame) sendToFrame(frame,{type:MSG.DO_ACTION,action:'PLAY_PAUSE',params:{showToasts:false}}).catch(() => undefined);
      } else recordAction({source:'pointer',action:'POINTER_CLICK',label:'Click',ok:!!message.ok,detail:String(message.detail || '').slice(0,200)});
      return false;

    case MSG.ENGINE_STATUS:
      clearTimeout(watchdog);
      setStatus({ state: message.state, detail: message.detail || '',cameraId:message.cameraId || null,mic:message.mic });
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
        if ((sender.frameId ?? 0) === 0) refreshModelCooldown(sender.tab.id).catch(() => undefined);
        tabContext.set(sender.tab.id, message.context);
        if (message.screen?.w > 0 && message.screen?.h > 0) tabScreen.set(sender.tab.id,{w:message.screen.w,h:message.screen.h});
        currentScreen().then(screen => post({type:MSG.ENGINE_CONFIG,screen}));
        refreshContext().catch(() => undefined);
      }
      return false;

    case MSG.VIEW_VISIBILITY:
      if (sender.tab) {
        if (message.visible && (sender.frameId ?? 0) === 0) refreshModelCooldown(sender.tab.id).catch(() => undefined);
        if (message.visible) hiddenTabs.delete(sender.tab.id);
        else hiddenTabs.add(sender.tab.id);
        // This is a page going behind or coming back, which is precisely what
        // the cached answer is about — never let it ride out its 300ms.
        invalidateActiveTab();
        // The overlays come down whichever way `actWhenOutOfView` is set. The
        // pill and the cursor belong to the tab you can see. @see retireOverlays
        if (!message.visible) retireOverlays();
        // Every other invalidating listener does this, and leaving it out here
        // is why an engine suspended under `pauseWhenNoVideo` could stay stuck
        // that way after the tab came back into view — the one event that says
        // so is this one.
        updateSuspendState();
        refreshContext().catch(() => undefined);
      }
      return false;

    case MSG.GET_STATE:
      (async () => {
        await taskReady;
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
          approval:approval ? {id:approval.id,label:approval.label} : null,
          resumeAvailable:!assistantRun && !!pausedTask(),
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
          context: await refreshContext(),
          screen: await currentScreen(),
          calibration: await loadCalibration()
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
  if (area !== 'local') return;
  if (changes.modelConnections) {
    const cooldown = nextModelCooldown(changes.modelConnections.newValue || []);
    chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.map(tab => showModelCooldown(tab.id,cooldown)))).catch(() => undefined);
  }
  if (changes.gazeCalibration) loadCalibration().then(calibration => post({type:MSG.CALIBRATION_MODEL,calibration}));
  if (!changes.settings) return;
  settingsCache = mergeSettings(changes.settings.newValue);
  if (changes.settings.oldValue?.agentPermissionBoundary !== settingsCache.agentPermissionBoundary || !settingsCache.voiceEnabled) cancelAssistant();
  // The offscreen document has no storage listener of its own — push to it.
  // If it isn't up yet, syncEngine() below starts it and it asks us directly.
  post({ type: MSG.ENGINE_SETTINGS, settings: settingsCache });
  const before = changes.settings.oldValue?.enabled;
  const after = changes.settings.newValue?.enabled;
  if (before !== after) syncEngine();
  // `actWhenOutOfView` decides what the caches below hold, so a flip has to take
  // the answers computed under the old rule with it — otherwise ticking the box
  // and immediately holding a pose gets judged by the setting you just left.
  invalidateActiveTab();
  // The engine owns the suspend flag and has no way to know the setting behind
  // it just changed. Without this, switching `pauseWhenNoVideo` off leaves an
  // already-suspended engine stuck until the next tab switch.
  updateSuspendState();
  refreshContext();
});

chrome.tabs.onActivated.addListener(() => {
  invalidateActiveTab();
  currentScreen().then(screen => post({type:MSG.ENGINE_CONFIG,screen}));
  retireOverlays();
  updateSuspendState();
  refreshContext();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Closing the task's tab ends the task, unless the task is the one closing it.
  if (assistantRun?.tabId === tabId && !assistantRun.closing?.has(tabId)) cancelAssistant();
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  tabContext.delete(tabId);
  tabScreen.delete(tabId);
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

// Only drops the cached answer — `frontView()` goes and asks Chrome rather than
// believing what this reports, because it is missed often enough that trusting
// it is what let a backgrounded window keep taking gestures against the user's
// wishes, back when there was no setting that made that a choice.
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

// The keyboard shortcut (Alt+Shift+J by default; chrome://extensions/shortcuts changes it).
chrome.commands?.onCommand?.addListener((command) => {
  if (command !== 'toggle-voice') return;
  dispatchAction('VOICE_CAPTURE_TOGGLE', { source: 'keyboard' }).catch((err) => console.error('[jester] shortcut failed', err));
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncEngine();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

// Keep keys out of content-script storage access where Chrome supports it.
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}).catch(() => undefined);
chrome.storage.session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}).catch(() => undefined);

// A cold worker start (e.g. after idle eviction) should re-assert the engine.
syncEngine();
refreshContext();
