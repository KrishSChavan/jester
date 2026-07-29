/**
 * Netflix page bridge — runs in the page's MAIN world.
 *
 * Netflix's player ignores direct writes to `video.currentTime` (its own state
 * machine snaps the position straight back), so seeking has to go through the
 * player API, which only exists on the page's own `window`.
 *
 * Protocol: `jester:req` CustomEvent in, `jester:res` CustomEvent out.
 */

(() => {
  if (window.__jesterBridgeLoaded) return;
  window.__jesterBridgeLoaded = true;

  function getPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const videoPlayer = api?.videoPlayer;
      if (!videoPlayer?.getAllPlayerSessionIds) return null;
      const sessions = videoPlayer.getAllPlayerSessionIds() || [];
      const sessionId = sessions.find((s) => String(s).startsWith('watch-')) || sessions[0];
      return sessionId ? videoPlayer.getVideoPlayerBySessionId(sessionId) : null;
    } catch {
      return null;
    }
  }

  function handle(op, value, player) {
    switch (op) {
      case 'play':
        player.play();
        return null;
      case 'pause':
        player.pause();
        return null;
      case 'seekBy': {
        const current = player.getCurrentTime();
        const duration = player.getDuration?.() ?? Infinity;
        const next = Math.min(Math.max(0, current + value.seconds * 1000), duration);
        player.seek(next);
        return { time: next };
      }
      case 'getState':
        return { time: player.getCurrentTime(), paused: !!player.isPaused?.() };
      default:
        throw new Error(`unknown op ${op}`);
    }
  }

  document.addEventListener('jester:req', (event) => {
    const { id, op, value } = event.detail || {};
    let ok = false;
    let data = null;

    const player = getPlayer();
    if (player) {
      try {
        data = handle(op, value, player);
        ok = true;
      } catch (err) {
        data = String(err?.message || err);
      }
    } else {
      data = 'player-unavailable';
    }

    document.dispatchEvent(new CustomEvent('jester:res', { detail: { id, ok, data } }));
  });
})();
