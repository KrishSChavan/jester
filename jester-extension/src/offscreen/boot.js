/**
 * Classic script, loaded before offscreen.js so it runs first.
 *
 * If the engine module throws while importing — a bad path, a blocked script, a
 * CSP violation — none of its own reporting code ever runs, and the popup would
 * sit on "Starting…" with no explanation. These handlers make that visible.
 */

(() => {
  const say = (detail) => {
    try {
      chrome.runtime.sendMessage({ type: 'jester/engine-status', state: 'error', detail });
    } catch {
      /* the worker may be gone; the console still has the original error */
    }
  };

  window.addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename.split('/').pop()}:${event.lineno})` : '';
    say(`Engine failed to load: ${event.message}${where}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    say(`Engine error: ${event.reason?.message || event.reason}`);
  });
})();
