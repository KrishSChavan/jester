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

async function dispatchAction(action, meta) {
  if (!action || action === 'NONE') return;
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
// HUD relay — forward only meaningful changes, not every inference frame
// ---------------------------------------------------------------------------

async function relayHud(telemetry) {
  // Cheapest check first: most telemetry frames say the same thing as the last.
  const bucket = Math.round((telemetry.progress || 0) * 10);
  const signature = `${telemetry.gesture || ''}|${bucket}|${telemetry.handPresent ? 1 : 0}`;
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
          handPresent: !!telemetry.handPresent
        }
      },
      { frameId: target.frameId }
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Power management
// ---------------------------------------------------------------------------

async function updateSuspendState() {
  try {
    const settings = await getSettings();
    if (!settings.enabled || !settings.pauseWhenNoVideo) {
      post({ type: MSG.ENGINE_CONFIG, suspend: false });
      return;
    }
    const target = await resolveTarget({ allowProbe: false });
    post({ type: MSG.ENGINE_CONFIG, suspend: !target });
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
      (async () => sendResponse({ settings: await getSettings() }))();
      return true;

    case MSG.SET_ENABLED:
      (async () => {
        const settings = await getSettings();
        settingsCache = { ...settings, enabled: !!message.enabled };
        await chrome.storage.local.set({ settings: settingsCache });
        if (message.enabled) setStatus({ state: ENGINE.STARTING, detail: '' });
        await syncEngine();
        sendResponse({ ok: true });
      })();
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
});

chrome.tabs.onActivated.addListener(() => {
  invalidateTarget();
  updateSuspendState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  invalidateTarget();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  for (const key of [...videoFrames.keys()]) {
    if (videoFrames.get(key).tabId === tabId) videoFrames.delete(key);
  }
  invalidateTarget();
});

chrome.windows.onFocusChanged.addListener(() => {
  invalidateTarget();
  updateSuspendState();
});

chrome.runtime.onStartup.addListener(() => syncEngine());

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncEngine();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

// A cold worker start (e.g. after idle eviction) should re-assert the engine.
syncEngine();
