/**
 * Classic script, loaded before offscreen.js so it runs first.
 *
 * If the engine module throws while importing — a bad path, a blocked script, a
 * CSP violation — none of its own reporting code ever runs, and the popup would
 * sit on "Starting…" with no explanation. These handlers make that visible.
 *
 * It also keeps MediaPipe's usage reports from leaving the machine; see below.
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

// Every MediaPipe task posts usage statistics to Google once a minute: which
// task ran, how long its frames took, the operating system. Never a camera
// frame, but Jester says the camera work stays on this machine, and so does its
// Web Store listing, so those posts are refused here. The library's logger
// gives up for good after one refused send. Its model and WASM loads also go
// through fetch(), but they are extension files and pass straight through.
(() => {
  const LOGGING_HOST = 'odml.pa.googleapis.com';
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    let host = '';
    try {
      host = new URL(input?.url ?? input, location.href).hostname;
    } catch {
      /* not a URL: fetch() itself rejects it */
    }
    if (host === LOGGING_HOST) return Promise.reject(new TypeError('Jester does not send MediaPipe usage logs.'));
    return nativeFetch(input, init);
  };
})();
