/**
 * Where a runtime message came from.
 *
 * A content script's `chrome.runtime.sendMessage` reaches every one of
 * Jester's pages, not only the worker, and content scripts run inside web
 * pages' own renderer processes: Chrome's advice is to treat what they send
 * as possibly coming from a compromised page. So each context honours a
 * message only from where it has a reason to come from. `sender.url` is
 * filled in by the browser, not by the sender, which is what makes it worth
 * checking — the worker's messages carry its script's URL, a page's its own.
 */

/** The offscreen document the engine runs in. */
export const ENGINE_PAGE_PATH = 'src/offscreen/offscreen.html';

const EXTENSION_ROOT = chrome.runtime.getURL('');
const ENGINE_PAGE = chrome.runtime.getURL(ENGINE_PAGE_PATH);

/** Jester itself: the worker, the popup, Settings, the calibration screen, the engine. */
export function fromJester(sender) {
  return sender?.id === chrome.runtime.id && String(sender.url || '').startsWith(EXTENSION_ROOT);
}

/** The offscreen document — the only thing that can say a gesture was made. */
export function fromEngine(sender) {
  return fromJester(sender) && sender.url.startsWith(ENGINE_PAGE);
}

/** A content script: in a tab, on a web page. */
export function fromPage(sender) {
  return sender?.id === chrome.runtime.id && !!sender.tab && !fromJester(sender);
}
