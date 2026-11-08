/**
 * Puts the link where Chrome can find it: the relay (jester-driver, which
 * becomes the relay when Chrome starts it) copied into Jester's own folder,
 * and a host manifest naming it in each Chromium browser's folder for them.
 *
 * Copied, because a relay Chrome starts from ~/Downloads, ~/Desktop or
 * ~/Documents never gets past macOS's loader: it waits forever to open its own
 * file, as macOS guards those folders (README). Jester's folder in
 * ~/Library/Application Support isn't guarded, wherever the app itself is.
 *
 * Only for browsers that are there: a manifest is written into a browser's
 * own folder, never one made for it. Nothing changes on disk when nothing has.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_NAME, hostManifest } from './link.js';

/** The Web Store's Jester, and the repo's own copy as Chrome names it when loaded unpacked on the development Mac. */
export const EXTENSION_IDS = Object.freeze(['jbfmeaijggbkkakdiinamgjjmcfblpab', 'fepkikohkficncoppffmemobjogdfdip']);

/** Where each Chromium browser keeps a user's native-messaging hosts, under ~/Library/Application Support. */
const MAC_BROWSERS = Object.freeze({
  'Google Chrome': 'Google/Chrome',
  'Google Chrome Beta': 'Google/Chrome Beta',
  'Google Chrome Canary': 'Google/Chrome Canary',
  Chromium: 'Chromium',
  Brave: 'BraveSoftware/Brave-Browser',
  'Microsoft Edge': 'Microsoft Edge',
  Arc: 'Arc/User Data',
  Vivaldi: 'Vivaldi'
});

/** Which extensions may link: the known two, and any a developer names in JESTER_LINK_EXTENSIONS (ids, comma-separated). */
export function linkOrigins(extra = process.env.JESTER_LINK_EXTENSIONS || '') {
  const ids = [...EXTENSION_IDS, ...String(extra).split(',').map((id) => id.trim()).filter((id) => /^[a-p]{32}$/.test(id))];
  return [...new Set(ids)].map((id) => `chrome-extension://${id}/`);
}

/** Writes `contents` unless the file already holds exactly that. @returns whether it wrote */
function writeIfChanged(file, contents, mode) {
  const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (current && Buffer.compare(current, Buffer.from(contents)) === 0) return false;
  fs.writeFileSync(file, contents, { mode });
  return true;
}

/**
 * @param {object} options
 * @param {string} options.relaySource  the built jester-driver
 * @param {string} [options.home]
 * @param {string[]} [options.origins]
 * @param {string} [options.platform]
 * @returns {{relay:string|null, browsers:string[], changed:boolean, why?:string}}
 */
export function installLinkHost({ relaySource, home = os.homedir(), origins = linkOrigins(), platform = process.platform }) {
  if (platform !== 'darwin') return { relay: null, browsers: [], changed: false, why: 'The link is built for macOS so far.' };
  const support = path.join(home, 'Library/Application Support');
  const folder = path.join(support, 'Jester');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const relay = path.join(folder, 'jester-link-relay');
  let changed = writeIfChanged(relay, fs.readFileSync(relaySource), 0o755);
  fs.chmodSync(relay, 0o755);
  const manifest = `${JSON.stringify(hostManifest({ relayPath: relay, origins }), null, 2)}\n`;
  const browsers = [];
  for (const [name, dir] of Object.entries(MAC_BROWSERS)) {
    const profile = path.join(support, dir);
    if (!fs.existsSync(profile)) continue;
    const hosts = path.join(profile, 'NativeMessagingHosts');
    fs.mkdirSync(hosts, { recursive: true });
    changed = writeIfChanged(path.join(hosts, `${HOST_NAME}.json`), manifest, 0o644) || changed;
    browsers.push(name);
  }
  return { relay, browsers, changed };
}
