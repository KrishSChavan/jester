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
    HUD: 'jester/hud',
    FULLSCREEN: 'jester/fullscreen',
    TOAST: 'jester/toast',
    FULLSCREEN_EXIT: 'jester/fullscreen-exit',
    FULLSCREEN_DETACHED: 'jester/fullscreen-detached',
    VIEW_CONTEXT: 'jester/view-context',
    CURSOR: 'jester/cursor',
    CURSOR_CLICK: 'jester/cursor-click',
    VOICE: 'jester/voice'
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
    NEXT_VIDEO: 'Next',
    SCROLL_UP: 'Scroll up',
    SCROLL_DOWN: 'Scroll down',
    PAGE_TOP: 'Top',
    PAGE_BOTTOM: 'Bottom',
    HISTORY_BACK: 'Back',
    HISTORY_FORWARD: 'Forward',
    RELOAD: 'Reload',
    TAB_NEXT: 'Next tab',
    TAB_PREV: 'Previous tab',
    TAB_MOVE_RIGHT: 'Move tab right',
    TAB_MOVE_LEFT: 'Move tab left',
    TAB_NEW: 'New tab',
    TAB_CLOSE: 'Close tab',
    TAB_REOPEN: 'Reopen tab',
    WINDOW_NEXT: 'Next window',
    DISABLE: 'Jester off'
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
  // Scrolling
  //
  // `window.scrollBy` is right for an ordinary page and wrong for the many
  // sites that scroll an inner pane instead and leave the document itself
  // fixed at 100vh, so the container has to be found rather than assumed.
  // -------------------------------------------------------------------------

  function canScrollY(el) {
    if (!el || el.scrollHeight <= el.clientHeight + 4) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  }

  function scrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    // The document scrolls: the common case, and the cheap one.
    if (root && root.scrollHeight > root.clientHeight + 4) return root;

    // Otherwise take the biggest thing on screen that can scroll. Biggest,
    // rather than first, because sidebars and menus are scrollable too.
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, main, section, article, ul, ol')) {
      if (!canScrollY(el)) continue;
      const rect = el.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best || root;
  }

  function scrollPage(direction, fraction) {
    const el = scrollTarget();
    if (!el) return { ok: false, detail: 'Nothing to scroll' };

    const room = el.scrollHeight - el.clientHeight;
    if (room <= 4) return { ok: false, detail: 'Nothing to scroll' };
    const at = el.scrollTop;
    if (direction < 0 && at <= 1) return { ok: false, detail: 'At the top' };
    if (direction > 0 && at >= room - 1) return { ok: false, detail: 'At the bottom' };

    el.scrollBy({ top: direction * clamp(fraction, 0.1, 1) * el.clientHeight, behavior: 'smooth' });
    return { ok: true, detail: direction < 0 ? 'Up' : 'Down' };
  }

  function scrollToEnd(direction) {
    const el = scrollTarget();
    if (!el) return { ok: false, detail: 'Nothing to scroll' };
    el.scrollTo({ top: direction < 0 ? 0 : el.scrollHeight, behavior: 'smooth' });
    return { ok: true, detail: direction < 0 ? 'Top' : 'Bottom' };
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

  /** Actions that act on the page rather than on a player. */
  const WITHOUT_VIDEO = new Set([
    'SKIP_AD',
    'NEXT_VIDEO',
    'SCROLL_UP',
    'SCROLL_DOWN',
    'PAGE_TOP',
    'PAGE_BOTTOM'
  ]);

  async function perform(action, params = {}) {
    const video = findVideo();
    if (!video && !WITHOUT_VIDEO.has(action)) return { ok: false, detail: 'No video in this frame' };

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

      // FULLSCREEN_TOGGLE / EXIT_FULLSCREEN are not handled here: they need
      // chrome.windows, which only exists in the service worker. It drives them
      // through MSG.FULLSCREEN instead.

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

      case 'SCROLL_UP':
        return scrollPage(-1, params.scrollStep ?? 0.6);
      case 'SCROLL_DOWN':
        return scrollPage(1, params.scrollStep ?? 0.6);
      case 'PAGE_TOP':
        return scrollToEnd(-1);
      case 'PAGE_BOTTOM':
        return scrollToEnd(1);

      default:
        return { ok: false, detail: `Unknown action ${action}` };
    }
  }

  // -------------------------------------------------------------------------
  // Cinema mode
  //
  // `requestFullscreen()` needs transient user activation, and a gesture
  // recognised off-screen has none. So instead of asking the page to go
  // fullscreen we pin the player to the viewport ourselves; the service worker
  // pairs this with chrome.windows fullscreen, which needs no activation, and
  // the two together are indistinguishable from the real thing.
  // -------------------------------------------------------------------------

  const CINEMA_STYLE_ID = 'jester-cinema-style';

  /**
   * A `position: fixed` element is trapped by any ancestor with a transform,
   * filter, perspective or paint containment — all of which real players use —
   * so every ancestor gets neutralised as well as the target itself.
   */
  const CINEMA_CSS = `
    html.jester-cinema, html.jester-cinema body {
      overflow: hidden !important;
    }
    [data-jester-cinema-anc] {
      transform: none !important;
      filter: none !important;
      backdrop-filter: none !important;
      perspective: none !important;
      will-change: auto !important;
      contain: none !important;
      overflow: visible !important;
      clip-path: none !important;
      mask: none !important;
      opacity: 1 !important;
    }
    [data-jester-cinema] {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      transform: none !important;
      z-index: 2147483000 !important;
      background: #000 !important;
    }
    /* Wrappers between the player and the <video>, which players size in JS. */
    [data-jester-cinema-fill] {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      transform: none !important;
    }
    [data-jester-cinema] video {
      width: 100% !important;
      height: 100% !important;
      left: 0 !important;
      top: 0 !important;
      margin: 0 !important;
      object-fit: contain !important;
      transform: none !important;
    }
  `;

  const CINEMA_ATTRS = ['data-jester-cinema', 'data-jester-cinema-anc', 'data-jester-cinema-fill'];

  let cinemaTarget = null;

  /**
   * Players size their own control bars in JS off a resize event. Fire a few,
   * spread out, because some of them re-layout asynchronously.
   */
  function nudgeLayout() {
    for (const delay of [0, 120, 400]) {
      setTimeout(() => window.dispatchEvent(new Event('resize')), delay);
    }
  }

  function cinemaOn() {
    if (cinemaTarget?.isConnected) return { ok: true, detail: 'Fullscreen' };
    const video = findVideo();
    if (!video) return { ok: false, detail: 'No video in this frame' };

    if (!document.getElementById(CINEMA_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = CINEMA_STYLE_ID;
      style.textContent = CINEMA_CSS;
      (document.head || document.documentElement).append(style);
    }

    const target = fullscreenTarget(video);
    target.setAttribute('data-jester-cinema', '');
    for (let node = target.parentElement; node; node = node.parentElement) {
      node.setAttribute('data-jester-cinema-anc', '');
    }
    // `target` may sit several wrappers above the <video>; each of those is
    // usually sized in JS to the old player box, so make them fill instead.
    for (let node = video.parentElement; node && node !== target; node = node.parentElement) {
      node.setAttribute('data-jester-cinema-fill', '');
    }
    document.documentElement.classList.add('jester-cinema');
    cinemaTarget = target;
    nudgeLayout();
    reportContext();
    return { ok: true, detail: 'Fullscreen' };
  }

  function cinemaOff() {
    if (!cinemaTarget) return;
    cinemaTarget = null;
    document.documentElement.classList.remove('jester-cinema');
    for (const node of document.querySelectorAll(CINEMA_ATTRS.map((a) => `[${a}]`).join(','))) {
      for (const attr of CINEMA_ATTRS) node.removeAttribute(attr);
    }
    document.getElementById(CINEMA_STYLE_ID)?.remove();
    nudgeLayout();
    reportContext();
  }

  function fullscreenState() {
    // An SPA navigation can tear the player out from under us.
    if (cinemaTarget && !cinemaTarget.isConnected) cinemaOff();
    return {
      ok: true,
      native: !!document.fullscreenElement,
      cinema: !!cinemaTarget,
      // True for ~5s after a real click or keypress, and the one window in which
      // the page is allowed to ask for genuine fullscreen.
      canActivate: !!navigator.userActivation?.isActive
    };
  }

  async function fullscreenOp(op) {
    switch (op) {
      case 'state':
        return fullscreenState();

      case 'native-enter': {
        const video = findVideo();
        if (!video) return { ok: false, detail: 'No video in this frame' };
        if (!navigator.userActivation?.isActive) return { ok: false, detail: 'No user activation' };
        try {
          await fullscreenTarget(video).requestFullscreen();
          return { ok: true, detail: 'Fullscreen' };
        } catch (err) {
          return { ok: false, detail: String(err?.message || err) };
        }
      }

      case 'native-exit':
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        return { ok: true };

      case 'cinema-enter':
        return cinemaOn();

      case 'cinema-exit':
        cinemaOff();
        return { ok: true };

      default:
        return { ok: false, detail: `Unknown fullscreen op ${op}` };
    }
  }

  // Escape is the reflex for leaving fullscreen, but nothing is natively
  // fullscreen in cinema mode, so Chrome would ignore it. Hand it to the worker,
  // which also has to put the window back.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!cinemaTarget || document.fullscreenElement) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      chrome.runtime.sendMessage({ type: MSG.FULLSCREEN_EXIT }).catch(() => undefined);
    },
    true
  );

  // If the user takes the window out of fullscreen themselves (F11), drop the
  // overlay too rather than leaving a fake-fullscreen page in a normal window.
  const windowFullscreen = window.matchMedia('(display-mode: fullscreen)');
  windowFullscreen.addEventListener('change', () => {
    reportContext();
    if (!cinemaTarget || windowFullscreen.matches) return;
    cinemaOff();
    chrome.runtime.sendMessage({ type: MSG.FULLSCREEN_DETACHED }).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // View context
  //
  // Which of the two binding sets is live depends on whether this tab is
  // filling the screen. The worker can see the *window* state but not the
  // page's own fullscreen, so the answer is assembled here and pushed up.
  // -------------------------------------------------------------------------

  let lastContext = null;

  function viewContext() {
    // All three read the same to a user: a video with nothing else on screen.
    // `display-mode` covers F11 and, in Chrome, element fullscreen too — the
    // other two are belt and braces for the moments it lags a frame behind.
    const full = !!document.fullscreenElement || !!cinemaTarget || windowFullscreen.matches;
    return full ? 'fullscreen' : 'windowed';
  }

  function reportContext() {
    // One answer per tab: an iframe is never fullscreen on its own terms.
    if (window.top !== window) return;
    const context = viewContext();
    if (context === lastContext) return;
    lastContext = context;
    chrome.runtime.sendMessage({ type: MSG.VIEW_CONTEXT, context }).catch(() => undefined);
  }

  for (const evt of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(evt, reportContext, true);
  }
  // The worker forgets everything when it's evicted, so re-assert on the way
  // back into view rather than waiting for the next fullscreen change.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastContext = null;
      reportContext();
    }
  });
  reportContext();

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
    document.addEventListener(evt, mountCursor, true);
    document.addEventListener(evt, mountVoicePill, true);
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
  // Virtual pointer
  //
  // An extension can't move the operating system's cursor — nothing in the
  // Chrome API surface reaches outside the browser — so Jester draws its own
  // and synthesises the pointer/mouse events the page would otherwise have
  // seen. Those events are untrusted, which ordinary click and hover handlers
  // don't care about, but it does mean a hand click can't unlock anything gated
  // on real user activation (fullscreen, clipboard, sound-on autoplay).
  //
  // Rendered in the top frame only: the worker addresses frameId 0, and hit
  // testing runs against the top document.
  // -------------------------------------------------------------------------

  const POINTER_IDLE_MS = 1200; // no update for this long and the cursor goes
  const RING_CIRCUMFERENCE = 2 * Math.PI * 20;

  /** What counts as "clickable" for the halo. Missing one costs only the halo. */
  const INTERACTIVE = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'label',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const CURSOR_CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .halo {
      position: absolute; left: 0; top: 0; width: 0; height: 0;
      border: 2px solid rgba(125, 211, 252, .95); border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(125, 211, 252, .15);
      opacity: 0; transition: opacity .12s ease;
    }
    .halo.show { opacity: 1; }
    .cursor {
      position: absolute; left: 0; top: 0; width: 48px; height: 48px;
      margin: -24px 0 0 -24px;
      opacity: 0; transform: translate3d(-300px, -300px, 0);
      /* Frames arrive at the inference rate; the transition fills the gaps. */
      transition: opacity .16s ease, transform .07s linear;
      will-change: transform;
    }
    .cursor.show { opacity: 1; }
    .cursor svg {
      position: absolute; inset: 0; width: 100%; height: 100%;
      transform: rotate(-90deg) scale(1);
      transition: transform .08s ease;
    }
    /* The pinch has landed: the ring snaps in, the way a button depresses. */
    .cursor.down svg { transform: rotate(-90deg) scale(.78); }
    .track { fill: rgba(15, 18, 24, .32); stroke: rgba(255, 255, 255, .6); stroke-width: 2.5; }
    .cursor.over .track { stroke: #7dd3fc; }
    .cursor.down .track { fill: rgba(125, 211, 252, .3); }
    .ring {
      fill: none; stroke: #7dd3fc; stroke-width: 4; stroke-linecap: round;
      stroke-dasharray: ${RING_CIRCUMFERENCE};
      stroke-dashoffset: ${RING_CIRCUMFERENCE};
    }
    .dot {
      position: absolute; left: 50%; top: 50%; width: 8px; height: 8px;
      margin: -4px 0 0 -4px; border-radius: 50%;
      background: #fff; box-shadow: 0 0 6px rgba(0, 0, 0, .55);
      transition: transform .08s ease;
    }
    .cursor.down .dot { transform: scale(1.5); background: #7dd3fc; }
    .ripple {
      position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
      border-radius: 50%; border: 2px solid #7dd3fc;
      animation: ripple .45s ease-out forwards;
    }
    @keyframes ripple { to { transform: scale(3); opacity: 0; } }
  `;

  let cursorHost = null;
  let cursorLayer = null;
  let cursorEl = null;
  let cursorHalo = null;
  let cursorRing = null;
  let cursorIdleTimer = null;
  let cursorVisible = false;
  let haloTarget = null;
  let hoverEl = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  function ensureCursor() {
    if (cursorHost && cursorHost.isConnected) return;
    cursorHost = document.createElement('div');
    cursorHost.id = 'jester-cursor-host';
    // `all: initial` resets pointer-events to auto, so re-clear it after.
    cursorHost.style.cssText = 'all: initial; pointer-events: none;';
    const root = cursorHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CURSOR_CSS;

    cursorLayer = document.createElement('div');
    cursorLayer.className = 'layer';
    cursorLayer.innerHTML = `
      <div class="halo"></div>
      <div class="cursor">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle class="track" cx="24" cy="24" r="20"></circle>
          <circle class="ring" cx="24" cy="24" r="20"></circle>
        </svg>
        <i class="dot"></i>
      </div>`;

    root.append(style, cursorLayer);
    cursorEl = cursorLayer.querySelector('.cursor');
    cursorHalo = cursorLayer.querySelector('.halo');
    cursorRing = cursorLayer.querySelector('.ring');
    mountCursor();
  }

  /** Fixed-position elements are invisible while another element is fullscreen. */
  function mountCursor() {
    if (!cursorHost) return;
    const parent = document.fullscreenElement || document.documentElement;
    if (cursorHost.parentNode !== parent) parent.appendChild(cursorHost);
  }

  function interactiveTarget(el) {
    try {
      return el?.closest?.(INTERACTIVE) || null;
    } catch {
      return null; // element in a shadow tree without closest(), or detached
    }
  }

  function mouseInit(px, py, extra) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: px,
      clientY: py,
      screenX: px + (window.screenX || 0),
      screenY: py + (window.screenY || 0),
      button: 0,
      buttons: 0,
      detail: 0,
      ...extra
    };
  }

  function dispatchPointer(el, types, px, py, extra) {
    if (!el?.isConnected) return;
    const init = mouseInit(px, py, extra);
    const pointerInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    for (const type of types) {
      const usePointer = type.startsWith('pointer');
      el.dispatchEvent(
        usePointer ? new PointerEvent(type, pointerInit) : new MouseEvent(type, init)
      );
    }
  }

  function setHalo(target) {
    if (!cursorHalo) return;
    const rect = target?.getBoundingClientRect?.();
    const useless =
      !rect ||
      rect.width < 4 ||
      rect.height < 4 ||
      // A page-sized wrapper that happens to be focusable — outlining it is noise.
      (rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9);

    if (useless) {
      if (!haloTarget) return;
      haloTarget = null;
      cursorHalo.classList.remove('show');
      cursorEl.classList.remove('over');
      return;
    }

    haloTarget = target;
    cursorHalo.style.left = `${rect.left - 3}px`;
    cursorHalo.style.top = `${rect.top - 3}px`;
    cursorHalo.style.width = `${rect.width + 6}px`;
    cursorHalo.style.height = `${rect.height + 6}px`;
    cursorHalo.classList.add('show');
    cursorEl.classList.add('over');
  }

  function syncHover(px, py) {
    const el = document.elementFromPoint(px, py);
    if (el !== hoverEl) {
      if (hoverEl) dispatchPointer(hoverEl, ['pointerout', 'mouseout'], px, py);
      hoverEl = el;
      if (el) dispatchPointer(el, ['pointerover', 'mouseover'], px, py);
    }
    // Players reveal their controls on mousemove, not on hover state alone.
    if (hoverEl) dispatchPointer(hoverEl, ['pointermove', 'mousemove'], px, py);
    setHalo(interactiveTarget(hoverEl));
  }

  /**
   * Names the clicked element for the popup's history list. Deliberately never
   * reads `value` — that would put whatever is typed in a field, password
   * included, into stored history.
   */
  function describeTarget(el) {
    const name = el.tagName ? el.tagName.toLowerCase() : 'element';
    const label = String(
      el.getAttribute?.('aria-label') ||
        el.title ||
        el.getAttribute?.('placeholder') ||
        el.textContent ||
        ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    return label ? `${name} · ${label.slice(0, 40)}` : name;
  }

  function ripple(px, py) {
    if (!cursorLayer) return;
    const dot = document.createElement('div');
    dot.className = 'ripple';
    dot.style.left = `${px}px`;
    dot.style.top = `${py}px`;
    cursorLayer.append(dot);
    setTimeout(() => dot.remove(), 500);
  }

  function clickAt(px, py) {
    const el = document.elementFromPoint(px, py);
    if (!el) return { ok: false, detail: 'Nothing under the cursor' };
    const target = interactiveTarget(el) || el;

    // Dispatch on the deepest element so the event path matches a real click;
    // it bubbles to whatever handler actually cares.
    dispatchPointer(el, ['pointerdown', 'mousedown'], px, py, { buttons: 1, detail: 1 });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    dispatchPointer(el, ['pointerup', 'mouseup', 'click'], px, py, { detail: 1 });

    ripple(px, py);
    return { ok: true, detail: describeTarget(target) };
  }

  function hideCursor() {
    clearTimeout(cursorIdleTimer);
    if (!cursorHost) return;
    cursorVisible = false;
    cursorEl.classList.remove('show', 'down');
    setHalo(null);
    if (hoverEl) {
      dispatchPointer(hoverEl, ['pointerout', 'mouseout'], lastPointerX, lastPointerY);
      hoverEl = null;
    }
  }

  function applyCursor(cursor) {
    if (!cursor.active) {
      hideCursor();
      return;
    }

    ensureCursor();
    mountCursor();
    // If the engine dies mid-gesture nothing sends the closing frame, so the
    // cursor times itself out rather than hanging on screen forever.
    clearTimeout(cursorIdleTimer);
    cursorIdleTimer = setTimeout(hideCursor, POINTER_IDLE_MS);

    // Stay a pixel inside the viewport: elementFromPoint returns null on the edge.
    lastPointerX = clamp((cursor.x ?? 0.5) * window.innerWidth, 0, window.innerWidth - 1);
    lastPointerY = clamp((cursor.y ?? 0.5) * window.innerHeight, 0, window.innerHeight - 1);

    // The transition that smooths motion between frames would otherwise fly the
    // cursor in from wherever it was parked, so the first frame jumps instead.
    const appearing = !cursorVisible;
    if (appearing) cursorEl.style.transition = 'none';
    cursorEl.style.transform = `translate3d(${lastPointerX}px, ${lastPointerY}px, 0)`;
    if (appearing) {
      void cursorEl.offsetWidth; // flush the jump before re-enabling the fade
      cursorEl.style.transition = '';
      cursorVisible = true;
      cursorEl.classList.add('show');
    }
    cursorRing.style.strokeDashoffset = String(
      RING_CIRCUMFERENCE * (1 - clamp(cursor.pinch || 0, 0, 1))
    );
    cursorEl.classList.toggle('down', !!cursor.down);

    syncHover(lastPointerX, lastPointerY);

    if (cursor.click) {
      const result = clickAt(lastPointerX, lastPointerY);
      chrome.runtime
        .sendMessage({ type: MSG.CURSOR_CLICK, ok: result.ok, detail: result.detail })
        .catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Voice pill
  //
  // A black lozenge that slides in when the engine says the microphone is live
  // — by default, when you raise your index finger. Five vertical bars sit as
  // dots in the middle of it and grow with the corresponding frequency band, so
  // it reads as your voice rather than as a level meter.
  //
  // The levels are computed in the offscreen document (that's where the
  // microphone is) and arrive at ~25/s. The bars carry a 70 ms transition,
  // which interpolates between frames the same way the cursor's does.
  //
  // Top frame only, like the cursor: the worker addresses frameId 0.
  // -------------------------------------------------------------------------

  const VOICE_BARS = 5;
  /** No frame for this long and the pill leaves — the engine died mid-sentence. */
  const VOICE_IDLE_MS = 1600;
  const VOICE_BAR_MIN = 6; // the resting dot, in px
  const VOICE_BAR_MAX = 28;

  const VOICE_POSITIONS = ['bottom-center', 'top-center', 'bottom-left', 'bottom-right'];

  const VOICE_CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    /* Positioning lives on the anchor so the pill keeps its own transform for
       the entrance, which would otherwise fight translateX(-50%). */
    .anchor { position: absolute; }
    .anchor.bottom-center { left: 50%; bottom: 34px; transform: translateX(-50%); }
    .anchor.top-center { left: 50%; top: 28px; transform: translateX(-50%); }
    .anchor.bottom-left { left: 28px; bottom: 34px; }
    .anchor.bottom-right { right: 28px; bottom: 34px; }
    .pill {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      box-sizing: border-box;
      height: 46px; min-width: 152px; padding: 0 22px;
      border-radius: 999px;
      background: #0a0c11;
      border: 2px solid rgba(255, 255, 255, .92);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .5);
      opacity: 0; transform: translateY(10px) scale(.94);
      transition: opacity .18s ease, transform .18s cubic-bezier(.2, .8, .3, 1);
    }
    .pill.show { opacity: 1; transform: translateY(0) scale(1); }
    .bar {
      flex: none;
      width: 6px; height: ${VOICE_BAR_MIN}px;
      border-radius: 999px;
      background: #e8ecf2;
      /* Frames arrive at ~25/s; the transition fills the gaps. */
      transition: height .07s linear;
    }
  `;

  let voiceHost = null;
  let voiceAnchor = null;
  let voicePill = null;
  let voiceBars = [];
  let voiceIdleTimer = null;
  let voicePosition = '';

  function ensureVoicePill() {
    if (voiceHost && voiceHost.isConnected) return;
    voiceHost = document.createElement('div');
    voiceHost.id = 'jester-voice-host';
    // `all: initial` resets pointer-events to auto, so re-clear it after.
    voiceHost.style.cssText = 'all: initial; pointer-events: none;';
    const root = voiceHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = VOICE_CSS;

    const layer = document.createElement('div');
    layer.className = 'layer';
    voiceAnchor = document.createElement('div');
    voiceAnchor.className = 'anchor bottom-center';
    voicePill = document.createElement('div');
    voicePill.className = 'pill';

    voiceBars = [];
    for (let i = 0; i < VOICE_BARS; i += 1) {
      const bar = document.createElement('i');
      bar.className = 'bar';
      voicePill.append(bar);
      voiceBars.push(bar);
    }

    voiceAnchor.append(voicePill);
    layer.append(voiceAnchor);
    root.append(style, layer);
    voicePosition = 'bottom-center';
    mountVoicePill();
    // The caller adds `show` in this same task. Flush the hidden state to the
    // layout first, or there's nothing to transition *from* and the pill snaps
    // in instead of sliding.
    void voicePill.offsetWidth;
  }

  /** Fixed-position elements are invisible while another element is fullscreen. */
  function mountVoicePill() {
    if (!voiceHost) return;
    const parent = document.fullscreenElement || document.documentElement;
    if (voiceHost.parentNode !== parent) parent.appendChild(voiceHost);
  }

  function hideVoicePill() {
    clearTimeout(voiceIdleTimer);
    if (!voicePill) return;
    voicePill.classList.remove('show');
    for (const bar of voiceBars) bar.style.height = `${VOICE_BAR_MIN}px`;
  }

  function applyVoice(voice) {
    if (voice.transcript?.text) {
      const { text, final } = voice.transcript;
      // Nothing consumes this yet. It's also logged in the offscreen document's
      // own console; this copy is here because it's the console you're actually
      // looking at while you talk to a page.
      console.log(`[jester] voice${final ? '' : ' (interim)'}: ${text}`);
    }

    // A transcript-only frame carries no `active` field: it says nothing about
    // whether the pill should be up, so it must not answer that question.
    if (voice.active === undefined) return;
    if (!voice.active) {
      hideVoicePill();
      return;
    }

    ensureVoicePill();
    mountVoicePill();
    // If the engine dies while the pill is up nothing sends the closing frame,
    // so it times itself out rather than hanging on screen forever.
    clearTimeout(voiceIdleTimer);
    voiceIdleTimer = setTimeout(hideVoicePill, VOICE_IDLE_MS);

    if (voice.position && voice.position !== voicePosition && VOICE_POSITIONS.includes(voice.position)) {
      voicePosition = voice.position;
      voiceAnchor.className = `anchor ${voice.position}`;
    }

    voicePill.classList.add('show');

    if (!Array.isArray(voice.levels)) return;
    for (let i = 0; i < voiceBars.length; i += 1) {
      const level = clamp(Number(voice.levels[i]) || 0, 0, 1);
      voiceBars[i].style.height = `${VOICE_BAR_MIN + level * (VOICE_BAR_MAX - VOICE_BAR_MIN)}px`;
    }
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

      case MSG.FULLSCREEN:
        fullscreenOp(message.op).then(sendResponse);
        return true;

      case MSG.TOAST:
        showToast(message.action, message.result || {});
        return false;

      case MSG.PROBE:
        sendResponse(describeVideo());
        return false;

      case MSG.HUD:
        showHud(message.hud || {});
        return false;

      case MSG.CURSOR:
        // The worker addresses frameId 0, but a stray broadcast must not paint
        // a second cursor inside an iframe.
        if (window.top === window) applyCursor(message.cursor || {});
        return false;

      case MSG.VOICE:
        if (window.top === window) applyVoice(message.voice || {});
        return false;

      default:
        return false;
    }
  });
})();
