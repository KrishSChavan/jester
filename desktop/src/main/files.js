/**
 * Where `jester://` URLs point on disk. Kept apart from protocol.js, which
 * needs Electron, so the path rules can be tested in plain Node.
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
  const root = roots[parsed.hostname];
  if (parsed.protocol !== 'jester:' || !Object.hasOwn(roots, parsed.hostname)) return null;
  const file = path.resolve(root, `.${decodeURIComponent(parsed.pathname)}`);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}
