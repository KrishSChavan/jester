/**
 * Service worker: owns the offscreen document's lifetime, decides which tab /
 * frame a recognised gesture should act on, and relays HUD updates.
 *
 * Deliberately *not* responsible for gesture logic — that lives in the
 * offscreen document, which is a long-lived page and therefore a much better
 * home for timers and per-frame state than an event-driven worker.
 */

import { MSG, ENGINE, loadSettings, mergeSettings, post } from '../common/constants.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const TARGET_CACHE_MS = 1500;
const HISTORY_LIMIT = 20;

/** key `${tabId}:${frameId}` -> frame descriptor */
const videoFrames = new Map();

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
        justification: 'Runs the webcam and on-device MediaPipe hand gesture recognition.'
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

// ---------------------------------------------------------------------------
// Action dispatch
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

async function toggleFullscreen(action) {
  const settings = await getSettings();
  const target = await resolveTarget();
  if (!target) return { ok: false, detail: 'No video tab found' };

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

async function announce(action, result) {
  const settings = await getSettings();
  if (!settings.showToasts) return;
  const target = await resolveTarget({ allowProbe: false });
  if (!target) return;
  chrome.tabs
    .sendMessage(target.tabId, { type: MSG.TOAST, action, result }, { frameId: target.frameId })
    .catch(() => undefined);
}

async function dispatchAction(action, meta) {
  if (!action || action === 'NONE') return;

  if (action === 'DISABLE') {
    // Toast first: once the engine is down this is the only thing that tells
    // you the gesture landed rather than the camera having simply dropped out.
    await announce(action, { ok: true, detail: 'Camera stopped' });
    const result = await setEnabled(false);
    await recordAction({ ...meta, action, ok: result.ok, detail: result.detail });
    return;
  }

  if (action === 'FULLSCREEN_TOGGLE' || action === 'EXIT_FULLSCREEN') {
    const result = await toggleFullscreen(action);
    await announce(action, result);
    await recordAction({ ...meta, action, ok: !!result.ok, detail: result.detail || '' });
    return;
  }

  const settings = await getSettings();
  const target = await resolveTarget();

  if (!target) {
    recordAction({ ...meta, action, ok: false, detail: 'No video tab found' });
    return;
  }

  const result = await sendToFrame(target, {
    type: MSG.DO_ACTION,
    action,
    params: {
      seekSeconds: settings.seekSeconds,
      volumeStep: settings.volumeStep,
      speedStep: settings.speedStep,
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
// Virtual pointer relay
//
// The cursor isn't aimed at a <video> — it belongs to whatever the user is
// looking at — so it resolves its own target: the active tab's *top* frame.
// These arrive at the inference rate, so the lookup is cached hard and stale
// motion is dropped rather than queued.
// ---------------------------------------------------------------------------

const CURSOR_TAB_CACHE_MS = 1000;

let cursorTab = null;
let cursorTabAt = 0;
let cursorInFlight = false;
/** A tab we already failed to reach; retrying every frame would be a storm. */
let cursorUnreachable = null;

async function cursorTarget() {
  const now = Date.now();
  if (cursorTabAt && now - cursorTabAt < CURSOR_TAB_CACHE_MS) return cursorTab;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  cursorTab = tab && injectable(tab.url) ? tab.id : null;
  cursorTabAt = now;
  return cursorTab;
}

function invalidateCursorTab() {
  cursorTab = null;
  cursorTabAt = 0;
  cursorUnreachable = null;
}

async function relayCursor(cursor) {
  // A click, or the cursor going away, must never be dropped. Plain motion can:
  // the next frame supersedes it anyway.
  if (cursorInFlight && cursor.active && !cursor.click) return;

  const tabId = await cursorTarget();
  if (tabId === null || tabId === cursorUnreachable) return;

  const message = { type: MSG.CURSOR, cursor };
  cursorInFlight = true;
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // No content script in that frame yet — inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['src/content/content.js']
      });
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      // Restricted page, or Jester has no host permission for this site. Stop
      // trying until the tab changes or the user switches away and back.
      cursorUnreachable = tabId;
    }
  } finally {
    cursorInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// HUD relay — forward only meaningful changes, not every inference frame
// ---------------------------------------------------------------------------

async function relayHud(telemetry) {
  // The cursor is its own feedback — a pill hovering over it is just noise, so
  // the pointer collapses to one signature that reads as "no hand".
  const pointing = !!telemetry.pointer?.active;
  // Cheapest check first: most telemetry frames say the same thing as the last.
  const bucket = Math.round((telemetry.progress || 0) * 10);
  const signature = pointing
    ? 'pointer'
    : `${telemetry.gesture || ''}|${bucket}|${telemetry.handPresent ? 1 : 0}`;
  if (signature === lastHudSignature) return;
  lastHudSignature = signature;

  const settings = await getSettings();
  if (!settings.showHud) return;

  const target = await resolveTarget({ allowProbe: false });
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
          handPresent: !pointing && !!telemetry.handPresent
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
        gesture: message.gesture
      }).catch((err) => console.error('[jester] dispatch failed', err));
      return false;

    case MSG.TELEMETRY:
      relayHud(message.telemetry || {}).catch(() => undefined);
      return false;

    case MSG.CURSOR:
      relayCursor(message.cursor || {}).catch(() => undefined);
      return false;

    case MSG.CURSOR_CLICK:
      recordAction({
        source: 'pointer',
        action: 'POINTER_CLICK',
        label: 'Click',
        ok: !!message.ok,
        detail: message.detail || ''
      }).catch(() => undefined);
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
          hasTarget: !!target
        });
      })();
      return true;

    case MSG.SETTINGS_REQUEST:
      // The offscreen document can't read storage itself; it asks us on boot.
      // The suspend flag rides along, so a freshly booted engine starts in the
      // right state instead of running until the first tab switch.
      (async () =>
        sendResponse({ settings: await getSettings(), suspend: await shouldSuspend() }))();
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
  invalidateCursorTab();
  updateSuspendState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  invalidateTarget();
  invalidateCursorTab();
  updateSuspendState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  invalidateTarget();
  updateSuspendState();
  // A reload can bring the content script with it, so give the tab another go.
  if (tabId === cursorTab || tabId === cursorUnreachable) invalidateCursorTab();
});

chrome.windows.onFocusChanged.addListener(() => {
  invalidateTarget();
  invalidateCursorTab();
  updateSuspendState();
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
