/**
 * Where `jester://` URLs point on disk. Kept apart from protocol.js, which
 * needs Electron, so the path rules can be tested in plain Node.
 *
 *   jester://ext/…      the extension folder, as it ships
 *   jester://app/…      the desktop app's own pages (desktop/src)
 *   jester://app/ext/…  the extension folder again, so an app page can
 *                       import the extension's modules from its own origin
 *   jester://ext/_desktop/worklets/…  desktop/src/worklets, so the engine page
 *                       can load the app's audio worklets as its own. Chrome
 *                       reserves names starting with "_" in extensions, so
 *                       this never hides an extension file.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOTS = {
  ext: path.resolve(here, '../../../jester-extension'),
  app: path.resolve(here, '..')
};

/** The file a `jester://` URL names, or null if it points outside its root. */
export function resolveFile(url, roots = ROOTS) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'jester:' || !Object.hasOwn(roots, parsed.hostname)) return null;
  let root = roots[parsed.hostname];
  let pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname === 'app' && (pathname === '/ext' || pathname.startsWith('/ext/'))) {
    root = roots.ext;
    pathname = pathname.slice('/ext'.length);
  } else if (parsed.hostname === 'ext' && pathname.startsWith('/_desktop/worklets/')) {
    root = path.join(roots.app, 'worklets');
    pathname = pathname.slice('/_desktop/worklets'.length);
  }
  const file = path.resolve(root, `.${pathname}`);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}
