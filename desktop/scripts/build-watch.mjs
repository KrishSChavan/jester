/**
 * `npm run watch`: build the Mac's end of the Apple Watch's Bluetooth link.
 * The watch's own app is an Xcode project: native/jester-watch/JesterWatch.xcodeproj.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/jester-watch');
if (process.platform !== 'darwin') {
  console.error('The Apple Watch link is for macOS.');
  process.exit(1);
}
const swift = (folder) => fs.readdirSync(path.join(root, folder)).filter((file) => file.endsWith('.swift')).map((file) => path.join(root, folder, file));
const output = path.join(root, 'build/jester-watch-bridge');
fs.mkdirSync(path.dirname(output), { recursive: true });
const build = spawnSync('swiftc', ['-swift-version', '5', '-O', ...swift('Core'), ...swift('Bridge'), '-o', output], { stdio: 'inherit' });
if (build.error?.code === 'ENOENT') console.error('swiftc not found. Install Xcode or its command line tools.');
process.exit(build.status ?? 1);
