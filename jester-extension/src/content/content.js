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
    VIEW_VISIBILITY: 'jester/view-visibility',
    CURSOR: 'jester/cursor',
    CURSOR_CLICK: 'jester/cursor-click',
    VOICE: 'jester/voice',
    PAGE_DIGEST: 'jester/page-digest',
    RUN_STEPS: 'jester/run-steps'
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
    // The detail line carries the rest — "Asleep — ✊ Closed fist to wake".
    SLEEP: 'Jester'
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

  /**
   * @param behavior `smooth` for a gesture, which is someone watching the page
   *        move. The assistant passes `instant`: it looks at the page again the
   *        moment this returns, and a scroll still gliding would have it read
   *        positions that are about to be wrong.
   */
  function scrollPage(direction, fraction, behavior = 'smooth') {
    const el = scrollTarget();
    if (!el) return { ok: false, detail: 'Nothing to scroll' };

    const room = el.scrollHeight - el.clientHeight;
    if (room <= 4) return { ok: false, detail: 'Nothing to scroll' };
    const at = el.scrollTop;
    if (direction < 0 && at <= 1) return { ok: false, detail: 'At the top' };
    if (direction > 0 && at >= room - 1) return { ok: false, detail: 'At the bottom' };

    el.scrollBy({ top: direction * clamp(fraction, 0.1, 1) * el.clientHeight, behavior });
    return { ok: true, detail: direction < 0 ? 'Up' : 'Down' };
  }

  /** @see scrollPage for `behavior`. */
  function scrollToEnd(direction, behavior = 'smooth') {
    const el = scrollTarget();
    if (!el) return { ok: false, detail: 'Nothing to scroll' };
    el.scrollTo({ top: direction < 0 ? 0 : el.scrollHeight, behavior });
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
  /**
   * Whether this tab is actually being shown.
   *
   * Not the same question as which window has the focus, and the worker can't
   * answer it for itself: a window that is fully covered by another one still
   * reports itself focused to `chrome.windows`, while Chrome's occlusion
   * tracking flips this to `hidden`. Backgrounded tabs and minimized windows
   * land here too, which makes it a useful second opinion on both.
   */
  let lastVisible = null;

  function reportVisibility() {
    // One answer per tab: an iframe has no visibility of its own.
    if (window.top !== window) return;
    const visible = document.visibilityState === 'visible';
    if (visible === lastVisible) return;
    lastVisible = visible;
    chrome.runtime.sendMessage({ type: MSG.VIEW_VISIBILITY, visible }).catch(() => undefined);
  }

  // The worker forgets everything when it's evicted, so re-assert on the way
  // back into view rather than waiting for the next fullscreen change.
  document.addEventListener('visibilitychange', () => {
    reportVisibility();
    if (document.visibilityState === 'visible') {
      lastContext = null;
      reportContext();
    }
  });
  reportContext();
  reportVisibility();

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
  // It has three faces, and one shape carries you between them:
  //
  //   listening — the bars, riding your voice.
  //   thinking  — the same lozenge squeezed down to a ball with a spinner in
  //               it, while the assistant reads the page and works.
  //   answer    — opened back out around whatever there is to say, then gone.
  //
  // Which one is up is the *worker's* call once you stop talking, not the
  // engine's. @see relayVoice.
  //
  // Top frame only, like the cursor: the worker addresses frameId 0.
  // -------------------------------------------------------------------------

  const VOICE_BARS = 5;
  /** No frame for this long and the pill leaves — the engine died mid-sentence. */
  const VOICE_IDLE_MS = 1600;
  /**
   * The same safety net for the spinner, and far slacker on purpose: a run makes
   * no frames of its own between turns, and a slow one is usually a page still
   * loading. The worker ends this phase explicitly — this only catches a worker
   * that was evicted mid-run, which would otherwise leave a ball spinning on
   * the page forever.
   */
  const VOICE_THINKING_MS = 90000;
  /** How long an answer stays up. Kept in step with ANSWER_MS in the worker. */
  const VOICE_ANSWER_MS = 4500;
  /**
   * What a red one gets on top of that. A failure is nearly always a sentence
   * you have to do something about — which model ran out, what to say instead,
   * that "keep going" will carry on — and it is gone before you have read it
   * twice. Kept in step with ANSWER_ERROR_EXTRA_MS in the worker.
   */
  const VOICE_ERROR_EXTRA_MS = 3000;
  /** Long enough for the fade-out, so the shape doesn't snap back on the way. */
  const VOICE_RESET_MS = 260;
  const VOICE_BAR_MIN = 6; // the resting dot, in px
  const VOICE_BAR_MAX = 28;

  const VOICE_POSITIONS = ['bottom-center', 'top-center', 'bottom-left', 'bottom-right'];
  const VOICE_PHASES = ['listening', 'thinking', 'answer'];

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
      display: flex; align-items: center; justify-content: center;
      box-sizing: border-box;
      height: 46px; min-width: 152px; padding: 0 22px;
      border-radius: 999px;
      background: #0a0c11;
      border: 2px solid rgba(255, 255, 255, .92);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .5);
      opacity: 0; transform: translateY(10px) scale(.94);
      transition:
        opacity .18s ease,
        transform .18s cubic-bezier(.2, .8, .3, 1),
        min-width .26s cubic-bezier(.2, .8, .3, 1),
        max-width .26s cubic-bezier(.2, .8, .3, 1),
        width .26s cubic-bezier(.2, .8, .3, 1),
        height .26s cubic-bezier(.2, .8, .3, 1),
        padding .26s cubic-bezier(.2, .8, .3, 1);
    }
    .pill.show { opacity: 1; transform: translateY(0) scale(1); }

    /* --- listening --- */
    .bars {
      display: flex; align-items: center; gap: 7px;
      max-width: 200px; overflow: hidden;
      transition: max-width .26s cubic-bezier(.2, .8, .3, 1), opacity .14s ease;
    }
    .bar {
      flex: none;
      width: 6px; height: ${VOICE_BAR_MIN}px;
      border-radius: 999px;
      background: #e8ecf2;
      /* Frames arrive at ~25/s; the transition fills the gaps. */
      transition: height .07s linear;
    }

    /* --- thinking: the lozenge squeezes into a ball around a spinner --- */
    .spin {
      flex: none; box-sizing: border-box;
      width: 0; height: 20px; opacity: 0;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, .22);
      border-top-color: #fff;
      transition: width .26s cubic-bezier(.2, .8, .3, 1), opacity .14s ease .08s;
    }
    .pill.thinking { min-width: 46px; width: 46px; padding: 0; }
    .pill.thinking .bars { max-width: 0; opacity: 0; }
    .pill.thinking .spin {
      width: 20px; opacity: 1;
      animation: jester-spin .7s linear infinite;
    }
    @keyframes jester-spin { to { transform: rotate(360deg); } }

    /* --- thinking, with something to say about it: the ball opens back out
       around the step being attempted, and closes again when it runs out --- */
    .step {
      flex: none;
      color: #cbd3e1;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      /* max-width rather than display, for the same reason the answer phase
         can't animate: "auto" is not a width you can transition from. The label
         opens itself and the pill grows to follow. */
      max-width: 0; opacity: 0; margin-left: 0;
      transition:
        max-width .26s cubic-bezier(.2, .8, .3, 1),
        margin-left .26s cubic-bezier(.2, .8, .3, 1),
        opacity .14s ease .08s;
    }
    .pill.thinking.stepped { width: auto; min-width: 46px; padding: 0 20px 0 15px; }
    .pill.thinking.stepped .step { max-width: min(240px, 46vw); opacity: 1; margin-left: 11px; }
    .pill.answer .step { display: none; }

    /* --- answer --- */
    .say {
      display: none;
      color: #e8ecf2;
      font: 500 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-align: center;
      /* Six lines is a paragraph nobody reads off a floating pill. */
      max-height: 8.7em; overflow: hidden;
      overflow-wrap: anywhere;
    }
    .pill.answer {
      min-width: 0; width: auto; max-width: min(460px, 80vw);
      height: auto; min-height: 46px; padding: 12px 22px;
    }
    .pill.answer .bars, .pill.answer .spin { display: none; }
    .pill.answer .say { display: block; }
    .pill.answer.bad { border-color: rgba(252, 165, 165, .92); }
    .pill.answer.bad .say { color: #fca5a5; }
  `;

  let voiceHost = null;
  let voiceAnchor = null;
  let voicePill = null;
  let voiceStep = null;
  let voiceSay = null;
  let voiceBars = [];
  let voiceIdleTimer = null;
  let voiceResetTimer = null;
  let voicePosition = '';
  let voicePhase = '';

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

    const bars = document.createElement('div');
    bars.className = 'bars';
    voiceBars = [];
    for (let i = 0; i < VOICE_BARS; i += 1) {
      const bar = document.createElement('i');
      bar.className = 'bar';
      bars.append(bar);
      voiceBars.push(bar);
    }

    const spin = document.createElement('i');
    spin.className = 'spin';
    voiceStep = document.createElement('div');
    voiceStep.className = 'step';
    voiceSay = document.createElement('div');
    voiceSay.className = 'say';

    voicePill.append(bars, spin, voiceStep, voiceSay);
    voiceAnchor.append(voicePill);
    layer.append(voiceAnchor);
    root.append(style, layer);
    voicePosition = 'bottom-center';
    voicePhase = '';
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

    // Back to the plain lozenge, but only once it's actually gone: resetting the
    // shape now would play the ball-to-pill animation on the way out. Skipped
    // outright if something has put the pill back up in the meantime.
    clearTimeout(voiceResetTimer);
    voiceResetTimer = setTimeout(() => {
      if (!voicePill || voicePill.classList.contains('show')) return;
      voicePill.classList.remove('thinking', 'stepped', 'answer', 'bad');
      voiceStep.textContent = '';
      voiceSay.textContent = '';
      voicePhase = '';
    }, VOICE_RESET_MS);
  }

  const PHASE_TIMEOUT = {
    listening: VOICE_IDLE_MS,
    thinking: VOICE_THINKING_MS,
    answer: VOICE_ANSWER_MS
  };

  /** The one phase whose length depends on what it says. @see VOICE_ERROR_EXTRA_MS */
  const phaseTimeout = (phase, voice) =>
    phase === 'answer' && voice.ok === false
      ? VOICE_ANSWER_MS + VOICE_ERROR_EXTRA_MS
      : PHASE_TIMEOUT[phase];

  /**
   * Puts the pill into one of its three faces and re-arms its timeout. Every
   * frame that wants the pill on screen goes through here, so there is one
   * place that decides what it looks like.
   */
  function showVoicePhase(phase, voice) {
    if (!VOICE_PHASES.includes(phase)) return;
    ensureVoicePill();
    mountVoicePill();
    clearTimeout(voiceResetTimer);

    if (
      voice.position &&
      voice.position !== voicePosition &&
      VOICE_POSITIONS.includes(voice.position)
    ) {
      voicePosition = voice.position;
      voiceAnchor.className = `anchor ${voice.position}`;
    }

    const changed = phase !== voicePhase;
    if (changed) {
      voicePhase = phase;
      voicePill.classList.toggle('thinking', phase === 'thinking');
      voicePill.classList.toggle('answer', phase === 'answer');
    }

    // Deliberately outside the `changed` guard: the phase stays `thinking` for a
    // whole run while this line changes once a turn, which is the point of it.
    if (phase === 'thinking') {
      const step = String(voice.step || '').replace(/\s+/g, ' ').trim();
      voiceStep.textContent = step;
      voicePill.classList.toggle('stepped', !!step);
    } else if (changed) {
      // Cleared before the answer flushes its geometry below, or the pill opens
      // out from a width that includes a label it is no longer showing.
      voicePill.classList.remove('stepped');
      voiceStep.textContent = '';
    }

    if (phase === 'answer') {
      voicePill.classList.toggle('bad', voice.ok === false);
      voiceSay.textContent = String(voice.text || '');
      // The ball's collapse animates because its width is a number; opening
      // back out around a sentence can't, since that width is `auto`. So the
      // answer plays the pill's own entrance instead of snapping into place —
      // drop `show`, flush the new geometry to the layout as the starting
      // point, and let the re-add fade and lift it in.
      if (changed) {
        voicePill.classList.remove('show');
        void voicePill.offsetWidth;
      }
    }

    voicePill.classList.add('show');

    // If whoever owns the pill dies mid-phase nothing sends the closing frame,
    // so it times itself out rather than hanging on screen forever.
    clearTimeout(voiceIdleTimer);
    voiceIdleTimer = setTimeout(hideVoicePill, phaseTimeout(phase, voice));
  }

  function applyVoice(voice) {
    if (voice.transcript?.text) {
      const { text, final } = voice.transcript;
      // Also logged in the offscreen document's own console; this copy is here
      // because it's the console you're actually looking at while you talk.
      console.log(`[jester] voice${final ? '' : ' (interim)'}: ${text}`);
    }

    // The assistant's frames say which face they want outright.
    if (voice.phase) {
      showVoicePhase(voice.phase, voice);
      return;
    }

    // A transcript-only frame carries no `active` field: it says nothing about
    // whether the pill should be up, so it must not answer that question.
    if (voice.active === undefined) return;
    if (!voice.active) {
      hideVoicePill();
      return;
    }

    showVoicePhase('listening', voice);

    if (!Array.isArray(voice.levels)) return;
    for (let i = 0; i < voiceBars.length; i += 1) {
      const level = clamp(Number(voice.levels[i]) || 0, 0, 1);
      voiceBars[i].style.height = `${VOICE_BAR_MIN + level * (VOICE_BAR_MAX - VOICE_BAR_MIN)}px`;
    }
  }

  // -------------------------------------------------------------------------
  // The assistant's eyes: finding the one element it asked for
  //
  // The obvious design is to describe the whole page and let the model pick.
  // It doesn't survive a real site: the description of a streaming front page
  // is most of a Groq minute on its own, and a command spends two or three of
  // them, so the thing that reads the page is also the thing that stops it
  // working.
  //
  // So the model doesn't get the page. It gets a handful of names — enough to
  // know roughly where it is — and it asks for things by description:
  //
  //     {"type":"click","target":"the search button"}
  //
  // and this is what turns "the search button" into an element. That inverts
  // the cost: instead of sending everything on the chance some of it matters,
  // we send the request and look for what it names.
  //
  // Which puts the weight on looking things up well. `findElement()` is a
  // ladder of increasingly forgiving ways to search, tried in order, because a
  // spoken description almost never matches a page's own wording: you say "the
  // search bar", the page calls it "Titles, people, genres". When one rung
  // comes up empty the next is tried, and when the whole ladder does, what
  // comes back is the nearest few names so the next turn can aim again.
  // -------------------------------------------------------------------------

  /** Elements that are markup, not page. */
  const SKIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'head',
    'link',
    'meta',
    'title',
    'br',
    'hr'
  ]);

  /** Jester's own overlays. Offering the assistant its own pill would be absurd. */
  const JESTER_HOSTS = new Set(['jester-hud-host', 'jester-cursor-host', 'jester-voice-host']);

  /**
   * What the assistant is allowed to aim at. Wider than INTERACTIVE above,
   * which only decides whether the pointer draws a halo — a miss there costs a
   * halo, a miss here costs the assistant the only handle it had on the thing
   * you asked for.
   */
  const ACTIONABLE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="treeitem"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  /** Never read, whatever is asked for. */
  const SECRET_INPUT = /password|current-password|new-password|cc-number|cc-csc|one-time-code/i;

  /** Attributes worth searching besides the name. The `data-` ones are how streaming sites label their own controls. */
  const SEARCHABLE_ATTRS = [
    'aria-label',
    'placeholder',
    'title',
    'alt',
    'name',
    'data-uia',
    'data-testid',
    'data-test-id',
    'data-a-target',
    'aria-describedby'
  ];

  const LABEL_MAX = 90;
  /** How many names the digest offers before it stops. */
  const DIGEST_NAMES = 40;
  const DIGEST_CHARS = 700;
  /** Returned when nothing matched, so the next turn has something to aim at. */
  const NEAR_MISSES = 6;

  /**
   * Words that describe *what kind of thing* rather than which one. Dropped
   * from both sides before comparing, so "the search box" and "Search" are the
   * same request.
   */
  const NOISE_WORDS = new Set([
    'the', 'a', 'an', 'that', 'this', 'my',
    'button', 'link', 'field', 'box', 'bar', 'input', 'icon', 'menu', 'item', 'option', 'element',
    'dropdown', 'list', 'toggle', 'checkbox', 'entry', 'control',
    'click', 'press', 'tap', 'select', 'choose', 'open', 'go', 'to', 'on', 'in', 'at', 'for', 'of',
    'and', 'please'
  ]);

  /**
   * The last rung of the ladder, and the one that earns its keep most often:
   * what a person calls a control and what the page calls it are rarely the
   * same string, but they are reliably the same *idea*.
   */
  const SYNONYMS = [
    {
      words: ['search', 'find', 'lookup', 'query'],
      selectors: [
        'input[type="search"]',
        '[role="searchbox"]',
        '[role="search"] input',
        'input[name*="search" i]',
        'input[placeholder*="search" i]',
        '[aria-label*="search" i]',
        '[data-uia*="search" i]',
        '[class*="search" i]'
      ]
    },
    {
      words: ['play', 'watch', 'resume', 'start'],
      selectors: ['[aria-label*="play" i]', '[data-uia*="play" i]', '[title*="play" i]', '[class*="play" i]']
    },
    {
      words: ['pause', 'stop'],
      selectors: ['[aria-label*="pause" i]', '[data-uia*="pause" i]', '[title*="pause" i]']
    },
    {
      words: ['season'],
      selectors: ['select', '[data-uia*="season" i]', '[aria-label*="season" i]', '[class*="season" i]']
    },
    {
      words: ['episode'],
      selectors: ['[data-uia*="episode" i]', '[aria-label*="episode" i]', '[class*="episode" i]']
    },
    {
      words: ['close', 'dismiss', 'cancel', 'exit'],
      selectors: ['[aria-label*="close" i]', '[title*="close" i]', '[class*="close" i]', '[aria-label*="dismiss" i]']
    },
    {
      words: ['next', 'forward'],
      selectors: ['[aria-label*="next" i]', '[title*="next" i]', '[class*="next" i]']
    },
    {
      words: ['previous', 'back', 'prev'],
      selectors: ['[aria-label*="previous" i]', '[aria-label*="back" i]', '[class*="prev" i]']
    },
    {
      words: ['skip'],
      selectors: ['[class*="skip" i]', '[aria-label*="skip" i]', '[data-uia*="skip" i]']
    },
    {
      words: ['submit', 'enter', 'confirm', 'ok', 'done'],
      selectors: ['button[type="submit"]', 'input[type="submit"]', '[aria-label*="submit" i]']
    },
    {
      words: ['fullscreen', 'full'],
      selectors: ['[aria-label*="full screen" i]', '[aria-label*="fullscreen" i]', '[class*="fullscreen" i]']
    },
    {
      words: ['mute', 'volume', 'sound', 'audio'],
      selectors: ['[aria-label*="mute" i]', '[aria-label*="volume" i]', '[class*="volume" i]']
    },
    {
      words: ['profile', 'account', 'avatar', 'user'],
      selectors: ['[aria-label*="profile" i]', '[aria-label*="account" i]', '[class*="avatar" i]']
    },
    {
      words: ['home'],
      selectors: ['[aria-label*="home" i]', 'a[href="/"]', 'a[href$="/browse"]']
    }
  ];

  const tidy = (value, max) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);

  const normalize = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const meaningfulWords = (value) =>
    normalize(value)
      .split(' ')
      .filter((word) => word && !NOISE_WORDS.has(word));

  /**
   * `null` means "skip this element and everything under it". A zero-sized box
   * doesn't, on its own: `display: contents` is a real layout mode with real
   * children, and so is a wrapper that has collapsed around visible content.
   */
  function boxState(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none') return null;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return null;
    if (style.opacity === '0') return null;

    const rect = el.getBoundingClientRect();
    return {
      rect,
      painted: rect.width >= 2 && rect.height >= 2,
      inViewport:
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
    };
  }

  /**
   * One walk of everything visible, used by both the digest and the finder.
   * Descends open shadow trees — most of YouTube is one — and into same-origin
   * iframes, which are just more page.
   */
  function walkVisible(root, visit) {
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag) || JESTER_HOSTS.has(el.id)) continue;
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) continue;

      const box = boxState(el);
      if (!box) continue;

      visit(el, box, tag);

      if (tag === 'iframe') {
        let inner = null;
        try {
          inner = el.contentDocument?.body || null;
        } catch {
          inner = null; // cross-origin: opaque from here, and nothing to be done
        }
        if (inner) stack.push(inner);
        continue;
      }
      if (tag === 'select') continue; // its options are its own business

      // Pushed in reverse so they *pop* in document order. That ordering is
      // not cosmetic: it's what makes "the third episode" the third one down
      // the page rather than the third one this loop happened to reach.
      const kids = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : [...el.children];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }

  /** The name a person would use for this element, in the order a screen reader would take it. */
  function elementName(el) {
    const aria = tidy(el.getAttribute('aria-label'), LABEL_MAX);
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const named = labelledBy
        .split(/\s+/)
        .map((id) => root.getElementById?.(id)?.textContent || '')
        .join(' ');
      const resolved = tidy(named, LABEL_MAX);
      if (resolved) return resolved;
    }

    // `innerText` is the honest one — it respects layout, so it skips what is
    // clipped or hidden — but it also *forces* layout, and on a focusable
    // wrapper holding half the page it would build that whole string to throw
    // most of it away. Past a paragraph, this isn't a control with a name.
    const raw = el.textContent || '';
    if (raw.length && raw.length <= 2000) {
      const own = tidy(el.innerText || raw, LABEL_MAX);
      if (own) return own;
    }

    // A card that is nothing but artwork — most of a streaming front page —
    // carries its title on the image inside it.
    const inner = el.querySelector?.('img[alt], [aria-label], [title]');
    const borrowed = inner
      ? tidy(inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.title, LABEL_MAX)
      : '';
    if (borrowed) return borrowed;

    return tidy(el.title || el.getAttribute('placeholder') || el.name, LABEL_MAX);
  }

  /** Everything else worth matching against, so a nameless icon is still findable. */
  function elementHints(el) {
    const hints = [];
    for (const attr of SEARCHABLE_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (value) hints.push(value);
    }
    // Class names are noise on most pages and the only label on some. Kept, but
    // only the words in them, so `.player-skip-btn` reads as "player skip btn".
    const className = typeof el.className === 'string' ? el.className : '';
    if (className) hints.push(className.replace(/[-_]+/g, ' '));
    if (el.tagName === 'INPUT' && el.type && el.type !== 'text') hints.push(el.type);
    return hints.join(' ').slice(0, 300);
  }

  const isTypable = (el) =>
    el.isContentEditable ||
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type || 'text'));

  function candidates({ typable = false, selectable = false } = {}) {
    const found = [];
    walkVisible(document.body || document.documentElement, (el, box, tag) => {
      if (!box.painted) return;
      if (typable) {
        if (!isTypable(el)) return;
      } else if (selectable) {
        if (tag !== 'select') return;
      } else if (!el.matches(ACTIONABLE)) {
        return;
      }
      found.push({ el, box, name: elementName(el) });
    });
    return found;
  }

  /**
   * How much of the request turns up in an element's attributes.
   *
   * Whole words, not substrings: `class="ytp-mute-button"` should answer "mute"
   * — that's the only handle an icon with no text has — while "ute" and "on"
   * should answer nothing. Splitting on the punctuation these names are built
   * from is what makes the difference.
   */
  function hintScore(el, words, base) {
    if (!words.length) return 0;
    const hintWords = meaningfulWords(elementHints(el));
    if (!hintWords.length) return 0;
    const hit = words.filter((word) =>
      hintWords.some((other) => other === word || (word.length >= 4 && other.startsWith(word)))
    ).length;
    return hit ? base * (hit / words.length) : 0;
  }

  /**
   * How well one candidate answers the request, and by which rung of the ladder.
   *
   * The rungs are ordered by how much they assume. An exact name is a fact; a
   * shared word is a guess. Only the best rung counts — adding them up would
   * let a long, vague name out-score a short exact one.
   */
  function scoreCandidate(candidate, query, words, synonymHits) {
    const name = normalize(candidate.name);
    const target = normalize(query);
    if (!name && !synonymHits.has(candidate.el)) {
      // Nameless, and no selector reached it either. Its attributes are all
      // there is — but for a thing with no name they are also the *only* thing
      // there is, so they count for more here than they would on an element
      // whose name was right there and didn't match.
      const score = hintScore(candidate.el, words, 36);
      return score ? { score, how: 'what it is called in the markup' } : null;
    }

    if (name && target && name === target) return { score: 100, how: 'its exact name' };

    if (name && target) {
      if (name.startsWith(target) || target.startsWith(name)) {
        return { score: 82, how: 'its name, near enough' };
      }
      if (name.includes(target)) return { score: 74, how: 'its name containing that' };
      if (target.length > 3 && target.includes(name) && name.length > 2) {
        return { score: 66, how: 'that containing its name' };
      }
    }

    const nameWords = meaningfulWords(candidate.name);
    const synonym = synonymHits.has(candidate.el);

    if (words.length && nameWords.length) {
      const matched = words.filter((word) =>
        nameWords.some((other) => other === word || other.startsWith(word) || word.startsWith(other))
      );
      if (matched.length === words.length) return { score: 60, how: 'every word of that in its name' };
      if (matched.length) {
        // Built on top of the synonym floor rather than scaled against it, so
        // sharing a word always beats sharing none. That is the whole of what
        // separates "episode 3" from "episode 1": both are episodes, only one
        // of them says 3.
        const share = matched.length / words.length;
        return synonym
          ? { score: 34 + 26 * share, how: 'what that means, and some of those words' }
          : { score: 30 * share, how: 'some of those words' };
      }
    }

    if (synonym) return { score: 34, how: 'what that usually means on a page' };

    // It has a name, and the name said no. Its attributes are the last word,
    // and worth less than they would be on something with nothing else to go on.
    const score = hintScore(candidate.el, words, 24);
    return score ? { score, how: 'a matching attribute' } : null;
  }

  /** Elements any of the synonym selectors reach. One pass, so the scorer can just ask. */
  function synonymMatches(words) {
    const hits = new Set();
    const selectors = SYNONYMS.filter((entry) => entry.words.some((word) => words.includes(word)))
      .flatMap((entry) => entry.selectors);
    if (!selectors.length) return hits;

    for (const selector of selectors) {
      let matched;
      try {
        matched = document.querySelectorAll(selector);
      } catch {
        continue; // a selector some browser doesn't like; the others still stand
      }
      for (const el of matched) hits.add(el);
    }
    return hits;
  }

  /**
   * The whole point of the file.
   *
   * @returns `{ ok, el, how }` when it is confident, and `{ ok: false, near }`
   *          — the nearest few names — when it is not. Never a wrong element
   *          quietly: a bad click is far more expensive to recover from than
   *          being told to look again.
   */
  function findElement(query, { typable = false, selectable = false, index = 0 } = {}) {
    const target = String(query || '').trim();
    if (!target) return { ok: false, near: [], detail: 'no target given' };

    const words = meaningfulWords(target);
    const synonymHits = synonymMatches(words);
    const pool = candidates({ typable, selectable });

    const scored = [];
    for (const candidate of pool) {
      const verdict = scoreCandidate(candidate, target, words, synonymHits);
      if (!verdict) continue;
      let score = verdict.score;
      // What you are looking at beats what you would have to scroll to, and a
      // real control beats a div someone made focusable.
      if (candidate.box.inViewport) score += 9;
      if (/^(button|a|input|select|textarea)$/i.test(candidate.el.tagName)) score += 4;
      if (candidate.el.disabled || candidate.el.getAttribute('aria-disabled') === 'true') score -= 25;
      scored.push({ ...candidate, score, how: verdict.how });
    }

    // Document order within a score band, so "episode 3" and "the third one"
    // count down the page rather than by whatever the walk happened to hit.
    scored.sort((a, b) => b.score - a.score);

    const usable = scored.filter((entry) => entry.score >= 40);
    const wanted = usable[index];
    if (wanted) {
      return {
        ok: true,
        el: wanted.el,
        how: wanted.how,
        name: wanted.name || '(unnamed)',
        alternatives: usable.length - 1
      };
    }

    return {
      ok: false,
      near: scored.slice(0, NEAR_MISSES).map((entry) => tidy(entry.name, 50)).filter(Boolean),
      detail: index > 0 && usable.length ? `only ${usable.length} of those on the page` : ''
    };
  }

  /** Names only, for when the assistant wants to look before it aims. */
  function listElements(match, limit = 25) {
    const words = meaningfulWords(match || '');
    const seen = new Set();
    const names = [];

    for (const candidate of candidates()) {
      const name = tidy(candidate.name, 60);
      if (!name || seen.has(name.toLowerCase())) continue;
      if (words.length) {
        const haystack = normalize(`${name} ${elementHints(candidate.el)}`);
        if (!words.some((word) => haystack.includes(word))) continue;
      }
      seen.add(name.toLowerCase());
      names.push(candidate.box.inViewport ? name : `${name} (off)`);
      if (names.length >= limit) break;
    }
    return names;
  }

  /**
   * Where the assistant is, in about a hundred tokens.
   *
   * Not a description of the page — a description of *roughly* the page, which
   * is all that's needed to choose what to ask for next. The names are the
   * useful part: they are what tell it there is a "Season 2" to aim at without
   * anyone having to send the season list.
   */
  function pageDigest() {
    const scroller = scrollTarget();
    const room = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;

    const seen = new Set();
    const onScreen = [];
    const below = [];
    for (const candidate of candidates()) {
      const name = tidy(candidate.name, 40);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      (candidate.box.inViewport ? onScreen : below).push(name);
    }

    // On screen first: it is what the user is looking at and talking about.
    const names = [...onScreen, ...below].slice(0, DIGEST_NAMES);
    let list = names.join(' · ');
    if (list.length > DIGEST_CHARS) list = `${list.slice(0, DIGEST_CHARS)}…`;

    const lines = [
      `url: ${location.href.slice(0, 200)}`,
      `title: ${tidy(document.title, 120)}`,
      room > 4
        ? `scroll: ${Math.round(scroller.scrollTop)} of ${Math.round(room)}px, so there is more page than this`
        : 'scroll: the whole page fits on screen',
      `you can see: ${list || '(nothing you can click)'}`
    ];
    if (below.length && onScreen.length) {
      lines.push(`(${below.length} more further down the page — scroll, or just ask for one by name)`);
    }

    return {
      ok: true,
      url: location.href,
      title: document.title,
      count: seen.size,
      text: lines.join('\n')
    };
  }

  /**
   * Waits for the page to stop rearranging itself, so a look taken after a
   * click sees the search results rather than the spinner.
   *
   * Counts mutations instead of demanding silence: a playing video repaints its
   * scrubber several times a second forever, and a rule that waited for a still
   * DOM would simply always wait the maximum.
   */
  const QUIET_MS = 280;
  const QUIET_MUTATIONS = 6;
  const QUIET_TIMEOUT_MS = 2600;

  function waitForQuiet(maxMs = QUIET_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let seen = 0;
      const observer = new MutationObserver((records) => {
        seen += records.length;
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      const startedAt = Date.now();
      const tick = () => {
        const busy = seen;
        seen = 0;
        if (busy <= QUIET_MUTATIONS || Date.now() - startedAt >= maxMs) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, QUIET_MS);
      };
      setTimeout(tick, QUIET_MS);
    });
  }

  // -------------------------------------------------------------------------
  // The assistant's hands: running a step against the page
  //
  // Every step names what it wants and `findElement` goes and gets it. The
  // events are synthesised, exactly as the virtual pointer's are, with the same
  // limit: an untrusted click can't unlock anything gated on real user
  // activation. That covers the site's own fullscreen button — which is why
  // FULLSCREEN_TOGGLE stays a `command` step, handled by the worker.
  // -------------------------------------------------------------------------

  const MAX_STEPS_PER_TURN = 8;
  /** Between steps: long enough for a menu to open under the next click. */
  const STEP_GAP_MS = 220;
  const MAX_WAIT_MS = 4000;

  const KEY_CODES = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    ' ': 32
  };

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function pressKey(el, key) {
    const target = el?.isConnected ? el : document.activeElement || document.body;
    const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const init = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    const live = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key.length === 1 || key === 'Enter') {
      target.dispatchEvent(new KeyboardEvent('keypress', init));
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));

    // A form that only listens for `submit` needs the nudge the browser would
    // have given it. Only when nothing cancelled the keydown, which is the rule
    // the browser itself follows — otherwise a page that handles Enter its own
    // way would run the search twice.
    if (key === 'Enter' && live && typeof target.form?.requestSubmit === 'function') {
      target.form.requestSubmit();
    }
    return live;
  }

  /**
   * Frameworks that own their inputs (React, and most of what streaming sites
   * are built on) keep their own copy of the value and ignore a plain
   * assignment. Going through the *prototype's* setter is what makes them
   * notice, because it's the one their own property definition wraps.
   */
  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })
      );
      return;
    }
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  async function clickElement(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const px = clamp(rect.left + rect.width / 2, 0, window.innerWidth - 1);
    const py = clamp(rect.top + rect.height / 2, 0, window.innerHeight - 1);

    // The full sequence, not el.click(): plenty of sites open menus on
    // mousedown and never see a bare click event at all.
    dispatchPointer(el, ['pointerover', 'mouseover', 'pointermove', 'mousemove'], px, py);
    dispatchPointer(el, ['pointerdown', 'mousedown'], px, py, { buttons: 1, detail: 1 });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    dispatchPointer(el, ['pointerup', 'mouseup', 'click'], px, py, { detail: 1 });
    return describeTarget(el);
  }

  function selectOption(el, wanted) {
    const target = String(wanted ?? '');
    const lower = target.toLowerCase();
    const options = Array.from(el.options || []);
    const match =
      options.find((option) => option.value === target) ||
      options.find((option) => tidy(option.textContent) === target) ||
      options.find((option) => tidy(option.textContent).toLowerCase().includes(lower));
    if (!match) return null;

    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return tidy(match.textContent, 60) || match.value;
  }

  function describeStep(step) {
    const type = String(step?.type || '?');
    const target = step?.target ? ` "${String(step.target).slice(0, 40)}"` : '';
    const extra =
      step?.text !== undefined
        ? ` ${JSON.stringify(String(step.text).slice(0, 60))}`
        : step?.value !== undefined
          ? ` ${JSON.stringify(String(step.value).slice(0, 40))}`
          : step?.key
            ? ` ${step.key}`
            : step?.direction
              ? ` ${step.direction}`
              : '';
    return `${type}${target}${extra}`;
  }

  /**
   * A miss is reported with the nearest names attached, which is the only
   * useful thing to say: the next turn can aim at one of them instead of
   * guessing again at the same wording that just failed.
   */
  function missed(step, found) {
    const near = found.near?.length ? ` Nearest on the page: ${found.near.join(', ')}.` : '';
    const note = found.detail ? ` (${found.detail})` : '';
    return {
      ok: false,
      detail: `nothing on this page matches "${step.target}"${note}.${near}`
    };
  }

  async function runStep(step) {
    const type = String(step?.type || '').toLowerCase();
    const needsTarget = type === 'click' || type === 'type' || type === 'select' || type === 'focus';

    let found = null;
    if (needsTarget) {
      found = findElement(step.target, {
        // What the step is about narrows the field enormously: "the search box"
        // is ambiguous across a page, and obvious among the things you can type
        // into.
        typable: type === 'type',
        selectable: type === 'select',
        index: Math.max(0, (Number(step.index) || 1) - 1)
      });
      if (!found.ok) return missed(step, found);
    }

    const el = found?.el;
    /** So the model learns which wording worked, and can reuse it. */
    const via = found ? ` (matched "${found.name}" by ${found.how})` : '';

    switch (type) {
      case 'click':
        return { ok: true, detail: `${await clickElement(el)}${via}` };

      case 'focus':
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus?.({ preventScroll: true });
        return { ok: true, detail: `${describeTarget(el)}${via}` };

      case 'type': {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus?.({ preventScroll: true });
        const text = String(step.text ?? '');
        setNativeValue(el, text);
        // Some suggestion boxes only wake on a key event, not on `input`. Not
        // for a contenteditable, though: those are the one place where a page
        // is likely to insert the character itself and end up with it twice.
        if (text && !el.isContentEditable) pressKey(el, text.slice(-1));
        if (step.submit) {
          await pause(120);
          pressKey(el, 'Enter');
          return { ok: true, detail: `typed ${JSON.stringify(text)} and pressed Enter${via}` };
        }
        return { ok: true, detail: `typed ${JSON.stringify(text)}${via}` };
      }

      case 'select': {
        const chosen = selectOption(el, step.value ?? step.text);
        return chosen
          ? { ok: true, detail: `chose ${JSON.stringify(chosen)}${via}` }
          : {
              ok: false,
              detail:
                `that dropdown${via} has no option matching ` +
                `${JSON.stringify(String(step.value ?? ''))}. It offers: ` +
                Array.from(el.options || [])
                  .slice(0, 15)
                  .map((option) => tidy(option.textContent, 30))
                  .join(', ')
            };
      }

      case 'press': {
        const key = String(step.key || 'Enter');
        // Whatever has focus, which after a click or a `type` is the thing the
        // assistant was just working on.
        pressKey(null, key);
        return { ok: true, detail: `pressed ${key}` };
      }

      // Looking, rather than doing. The escape hatch for when the digest didn't
      // carry enough to aim with — and much cheaper than describing the page,
      // because it only answers the question that was actually asked.
      case 'find': {
        const names = listElements(step.target, 25);
        return names.length
          ? { ok: true, detail: `matching "${step.target}": ${names.join(', ')}` }
          : { ok: false, detail: `nothing on this page matches "${step.target}"` };
      }

      case 'scroll': {
        if (step.target) {
          const to = findElement(step.target);
          if (!to.ok) return missed(step, to);
          to.el.scrollIntoView({ block: 'center', behavior: 'instant' });
          return { ok: true, detail: `scrolled "${to.name}" into view` };
        }
        const direction = String(step.direction || 'down').toLowerCase();
        if (direction === 'top') return scrollToEnd(-1, 'instant');
        if (direction === 'bottom') return scrollToEnd(1, 'instant');
        return scrollPage(direction === 'up' ? -1 : 1, 0.8, 'instant');
      }

      case 'wait':
        await pause(clamp(Number(step.ms) || 600, 0, MAX_WAIT_MS));
        return { ok: true, detail: 'waited' };

      default:
        return { ok: false, detail: `Jester has no step called "${type}"` };
    }
  }

  /**
   * Stops at the first failure on purpose: everything after it was planned
   * against a page that didn't happen, and the assistant is about to be handed a
   * fresh look at the page anyway.
   */
  async function runSteps(steps) {
    const list = Array.isArray(steps) ? steps.slice(0, MAX_STEPS_PER_TURN) : [];
    const results = [];

    for (const step of list) {
      let result;
      try {
        result = await runStep(step);
      } catch (err) {
        result = { ok: false, detail: String(err?.message || err) };
      }
      results.push({ step: describeStep(step), ok: !!result.ok, detail: result.detail || '' });
      if (!result.ok) break;
      await pause(STEP_GAP_MS);
    }

    // Said out loud rather than dropped quietly: a plan that looks like it all
    // ran, and didn't, is the worst thing to hand back.
    const dropped = (Array.isArray(steps) ? steps.length : 0) - list.length;
    if (dropped > 0) {
      results.push({
        step: 'the rest',
        ok: false,
        detail: `${dropped} more step(s) were not run — ${MAX_STEPS_PER_TURN} is the most in one go`
      });
    }

    return { ok: results.every((entry) => entry.ok), results };
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

      case MSG.PAGE_DIGEST:
        (async () => {
          // The worker asks for this straight after acting on the page, so by
          // default we let the page finish reacting before looking at it.
          if (message.settle !== false) await waitForQuiet();
          sendResponse(pageDigest());
        })();
        return true;

      case MSG.RUN_STEPS:
        runSteps(message.steps).then(sendResponse);
        return true;

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
