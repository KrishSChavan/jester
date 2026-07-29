/**
 * Content script: finds the video in this frame, executes actions on it, and
 * draws the on-page HUD.
 *
 * Runs in every frame of a matched site. Frames without a video simply never
 * register themselves, so the service worker only ever targets a real player.
 */

(() => {
  if (window.__jesterContentLoaded) return;
  window.__jesterContentLoaded = true;

  const MSG = {
    DO_ACTION: 'jester/do-action',
    PROBE: 'jester/probe',
    VIDEO_STATE: 'jester/video-state',
    HUD: 'jester/hud'
  };

  const HOST = location.hostname;
  const SITE = (() => {
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(HOST)) return 'youtube';
    if (/(^|\.)netflix\.com$/.test(HOST)) return 'netflix';
    if (/(^|\.)disneyplus\.com$|(^|\.)hotstar\.com$/.test(HOST)) return 'disneyplus';
    if (/(^|\.)hulu\.com$/.test(HOST)) return 'hulu';
    if (/(^|\.)primevideo\.com$|(^|\.)amazon\./.test(HOST)) return 'prime';
    if (/(^|\.)(hbo)?max\.com$/.test(HOST)) return 'max';
    if (/(^|\.)peacocktv\.com$/.test(HOST)) return 'peacock';
    if (/(^|\.)twitch\.tv$/.test(HOST)) return 'twitch';
    return 'generic';
  })();

  const ACTION_LABELS = {
    PLAY_PAUSE: 'Play / pause',
    PLAY: 'Play',
    PAUSE: 'Pause',
    SEEK_FORWARD: 'Skip forward',
    SEEK_BACK: 'Skip back',
    VOLUME_UP: 'Volume up',
    VOLUME_DOWN: 'Volume down',
    MUTE_TOGGLE: 'Mute',
    SPEED_UP: 'Speed up',
    SPEED_DOWN: 'Slow down',
    EXIT_FULLSCREEN: 'Exit fullscreen',
    FULLSCREEN_TOGGLE: 'Fullscreen',
    SKIP_AD: 'Skip ad',
    NEXT_VIDEO: 'Next'
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // -------------------------------------------------------------------------
  // Video discovery
  // -------------------------------------------------------------------------

  function videoArea(video) {
    const rect = video.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function findVideo() {
    if (SITE === 'youtube') {
      const main = document.querySelector('video.html5-main-video');
      if (main) return main;
    }
    let best = null;
    let bestRank = -1;
    for (const video of document.querySelectorAll('video')) {
      if (!video.currentSrc && !video.src && video.readyState === 0) continue;
      const rank = (video.paused ? 0 : 1e9) + videoArea(video);
      if (rank > bestRank) {
        bestRank = rank;
        best = video;
      }
    }
    return best;
  }

  function fullscreenTarget(video) {
    const selectors = {
      youtube: '#movie_player',
      netflix: '.watch-video',
      disneyplus: '[data-testid="webAppRoot"]',
      twitch: '[data-a-target="video-player"]'
    };
    return (selectors[SITE] && document.querySelector(selectors[SITE])) || video.parentElement || video;
  }

  // -------------------------------------------------------------------------
  // Netflix bridge (its player ignores direct currentTime writes)
  // -------------------------------------------------------------------------

  let bridgeSeq = 0;
  const bridgePending = new Map();

  document.addEventListener('jester:res', (event) => {
    const { id, ok, data } = event.detail || {};
    const resolve = bridgePending.get(id);
    if (!resolve) return;
    bridgePending.delete(id);
    resolve({ ok, data });
  });

  function bridge(op, value) {
    if (SITE !== 'netflix') return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      const id = ++bridgeSeq;
      bridgePending.set(id, resolve);
      document.dispatchEvent(new CustomEvent('jester:req', { detail: { id, op, value } }));
      setTimeout(() => {
        if (bridgePending.delete(id)) resolve({ ok: false, data: 'timeout' });
      }, 300);
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function clickFirst(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }
    return false;
  }

  async function seekBy(video, seconds) {
    const viaBridge = await bridge('seekBy', { seconds });
    if (viaBridge.ok) return `${seconds > 0 ? '+' : ''}${seconds}s`;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = clamp(video.currentTime + seconds, 0, duration);
    return `${seconds > 0 ? '+' : ''}${seconds}s`;
  }

  async function setPlaying(video, shouldPlay) {
    const viaBridge = await bridge(shouldPlay ? 'play' : 'pause');
    if (viaBridge.ok) return shouldPlay ? 'Playing' : 'Paused';
    if (shouldPlay) await video.play().catch(() => undefined);
    else video.pause();
    return shouldPlay ? 'Playing' : 'Paused';
  }

  async function perform(action, params = {}) {
    const video = findVideo();
    const needsVideo = !['SKIP_AD', 'NEXT_VIDEO', 'EXIT_FULLSCREEN'].includes(action);
    if (!video && needsVideo) return { ok: false, detail: 'No video in this frame' };

    switch (action) {
      case 'PLAY_PAUSE':
        return { ok: true, detail: await setPlaying(video, video.paused) };
      case 'PLAY':
        return { ok: true, detail: await setPlaying(video, true) };
      case 'PAUSE':
        return { ok: true, detail: await setPlaying(video, false) };

      case 'SEEK_FORWARD':
        return { ok: true, detail: await seekBy(video, params.seekSeconds ?? 10) };
      case 'SEEK_BACK':
        return { ok: true, detail: await seekBy(video, -(params.seekSeconds ?? 10)) };

      case 'VOLUME_UP':
      case 'VOLUME_DOWN': {
        const step = (params.volumeStep ?? 0.1) * (action === 'VOLUME_UP' ? 1 : -1);
        video.muted = false;
        video.volume = clamp(video.volume + step, 0, 1);
        return { ok: true, detail: `${Math.round(video.volume * 100)}%` };
      }

      case 'MUTE_TOGGLE':
        video.muted = !video.muted;
        return { ok: true, detail: video.muted ? 'Muted' : 'Unmuted' };

      case 'SPEED_UP':
      case 'SPEED_DOWN': {
        const step = (params.speedStep ?? 0.25) * (action === 'SPEED_UP' ? 1 : -1);
        video.playbackRate = clamp(Math.round((video.playbackRate + step) * 100) / 100, 0.25, 4);
        return { ok: true, detail: `${video.playbackRate}×` };
      }

      case 'EXIT_FULLSCREEN':
        if (!document.fullscreenElement) return { ok: true, detail: 'Already windowed' };
        await document.exitFullscreen().catch(() => undefined);
        return { ok: true, detail: 'Exited fullscreen' };

      case 'FULLSCREEN_TOGGLE':
        if (document.fullscreenElement) {
          await document.exitFullscreen().catch(() => undefined);
          return { ok: true, detail: 'Exited fullscreen' };
        }
        try {
          await fullscreenTarget(video).requestFullscreen();
          return { ok: true, detail: 'Fullscreen' };
        } catch {
          // Chrome only grants fullscreen off a real user gesture.
          return { ok: false, detail: 'Chrome blocked fullscreen (needs a click)' };
        }

      case 'SKIP_AD': {
        const skipped = clickFirst([
          '.ytp-skip-ad-button',
          '.ytp-ad-skip-button-modern',
          '.ytp-ad-skip-button',
          '.ytp-ad-overlay-close-button',
          '[data-uia="player-skip-intro"]',
          '[data-uia="player-skip-recap"]',
          '.skip-credits',
          'button[aria-label*="Skip" i]'
        ]);
        return skipped ? { ok: true, detail: 'Skipped' } : { ok: false, detail: 'Nothing to skip' };
      }

      case 'NEXT_VIDEO': {
        const advanced = clickFirst([
          '.ytp-next-button',
          '[data-uia="next-episode-seamless-button"]',
          '[data-uia="next-episode-seamless-button-draining"]',
          'button[aria-label*="Next episode" i]',
          'button[aria-label*="Next" i]'
        ]);
        return advanced ? { ok: true, detail: 'Next' } : { ok: false, detail: 'No next button' };
      }

      default:
        return { ok: false, detail: `Unknown action ${action}` };
    }
  }

  // -------------------------------------------------------------------------
  // HUD (shadow DOM so no site stylesheet can touch it)
  // -------------------------------------------------------------------------

  let hudHost = null;
  let hudRoot = null;
  let hudPill = null;
  let hudLabel = null;
  let hudBar = null;
  let hudToasts = null;
  let hudHideTimer = null;

  const HUD_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    .pill {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 12px; border-radius: 999px;
      background: rgba(17, 20, 28, .82); color: #f1f5f9;
      backdrop-filter: blur(8px);
      box-shadow: 0 6px 22px rgba(0,0,0,.35);
      opacity: 0; transform: translateY(-6px);
      transition: opacity .16s ease, transform .16s ease;
    }
    .pill.show { opacity: 1; transform: translateY(0); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; }
    .bar { width: 46px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.2); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0%; background: #7ee787; transition: width .08s linear; }
    .toast {
      padding: 9px 14px; border-radius: 10px;
      background: rgba(17, 20, 28, .9); color: #fff;
      box-shadow: 0 8px 26px rgba(0,0,0,.4);
      animation: pop .18s ease-out;
    }
    .toast .sub { opacity: .65; font-weight: 400; margin-left: 6px; }
    .toast.bad .sub { color: #fca5a5; opacity: .9; }
    @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.96); } }
  `;

  function ensureHud() {
    if (hudHost && hudHost.isConnected) return;
    hudHost = document.createElement('div');
    hudHost.id = 'jester-hud-host';
    // Inline so page stylesheets can't reach in and restyle the host itself.
    hudHost.style.cssText = 'all: initial;';
    hudRoot = hudHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = HUD_CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="pill"><span class="dot"></span><span class="label"></span>
        <span class="bar"><i></i></span></div>
      <div class="toasts"></div>`;

    hudRoot.append(style, wrap);
    hudPill = hudRoot.querySelector('.pill');
    hudLabel = hudRoot.querySelector('.label');
    hudBar = hudRoot.querySelector('.bar > i');
    hudToasts = hudRoot.querySelector('.toasts');
    mountHud();
  }

  /** Fixed-position elements are invisible while another element is fullscreen. */
  function mountHud() {
    if (!hudHost) return;
    const parent = document.fullscreenElement || document.documentElement;
    if (hudHost.parentNode !== parent) parent.appendChild(hudHost);
  }

  for (const evt of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(evt, mountHud, true);
  }

  function showHud(hud) {
    ensureHud();
    mountHud();
    clearTimeout(hudHideTimer);

    if (!hud.handPresent) {
      hudPill.classList.remove('show');
      return;
    }
    hudLabel.textContent = hud.label || 'Hand detected';
    hudBar.style.width = `${Math.round((hud.progress || 0) * 100)}%`;
    hudPill.classList.add('show');
    hudHideTimer = setTimeout(() => hudPill.classList.remove('show'), 1800);
  }

  function showToast(action, result) {
    ensureHud();
    mountHud();
    const toast = document.createElement('div');
    toast.className = `toast${result.ok ? '' : ' bad'}`;
    const label = ACTION_LABELS[action] || action;
    toast.innerHTML = `<span></span><span class="sub"></span>`;
    toast.firstChild.textContent = label;
    toast.lastChild.textContent = result.detail || '';
    hudToasts.appendChild(toast);
    setTimeout(() => toast.remove(), 1400);
  }

  // -------------------------------------------------------------------------
  // Video state reporting
  // -------------------------------------------------------------------------

  let reportTimer = null;
  let reportDueAt = 0;
  let lastReport = '';

  function describeVideo() {
    const video = findVideo();
    if (!video) return { hasVideo: false };
    return { hasVideo: true, playing: !video.paused, area: videoArea(video) };
  }

  function reportVideoState() {
    const info = describeVideo();
    const signature = `${info.hasVideo}|${info.playing}|${Math.round(info.area || 0)}`;
    if (signature === lastReport) return;
    lastReport = signature;
    chrome.runtime.sendMessage({ type: MSG.VIDEO_STATE, info }).catch(() => undefined);
  }

  /**
   * Sites like YouTube mutate the DOM continuously, so a plain reset-on-every-
   * call debounce would never fire. Only reschedule when the new deadline is
   * sooner than the pending one.
   */
  function scheduleReport(delay = 300) {
    const dueAt = Date.now() + delay;
    if (reportTimer && dueAt >= reportDueAt) return;
    clearTimeout(reportTimer);
    reportDueAt = dueAt;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      reportVideoState();
    }, delay);
  }

  for (const evt of ['play', 'pause', 'loadedmetadata', 'emptied']) {
    document.addEventListener(evt, () => scheduleReport(50), true);
  }
  document.addEventListener('visibilitychange', () => scheduleReport(100));
  new MutationObserver(() => scheduleReport(600)).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  scheduleReport(400);
  setInterval(reportVideoState, 5000);

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case MSG.DO_ACTION:
        perform(message.action, message.params).then((result) => {
          if (message.params?.showToasts !== false) showToast(message.action, result);
          scheduleReport(120);
          sendResponse(result);
        });
        return true;

      case MSG.PROBE:
        sendResponse(describeVideo());
        return false;

      case MSG.HUD:
        showHud(message.hud || {});
        return false;

      default:
        return false;
    }
  });
})();
