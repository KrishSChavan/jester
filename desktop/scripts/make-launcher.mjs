/**
 * `npm run launcher`: a Jester app for the Applications folder (macOS), to
 * start Jester with a double-click — from Finder, Launchpad, Spotlight, the
 * Dock or Login Items — instead of the terminal.
 *
 * It's a launcher, not a packaged copy: it starts the same Electron that
 * `npm run dev:mac` does, on this checkout. So it always runs the current
 * code, needs no Node or terminal, and the permissions macOS gave "Electron"
 * (camera, microphone, Accessibility) still apply. With Jester already
 * running, it opens Settings. The log is ~/Library/Logs/Jester/dev.log.
 *
 *   npm run launcher                into /Applications (else ~/Applications)
 *   npm run launcher -- <folder>    somewhere else
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.resolve(desktop, '../jester-extension/icons');
const electronApp = path.join(desktop, 'node_modules/electron/dist/Electron.app');
const BUNDLE_ID = 'com.jester.launcher';

if (process.platform !== 'darwin') {
  console.error('The launcher is for macOS.');
  process.exit(1);
}
if (!fs.existsSync(electronApp)) {
  console.error('Electron is not downloaded yet; run: node node_modules/electron/install.js');
  process.exit(1);
}

function writable(folder) {
  try {
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : writable('/Applications')
    ? '/Applications'
    : path.join(os.homedir(), 'Applications');
fs.mkdirSync(target, { recursive: true });
const app = path.join(target, 'Jester.app');

// Never replace someone else's Jester.app: only one this script made.
if (fs.existsSync(app)) {
  const plist = path.join(app, 'Contents/Info.plist');
  const id = fs.existsSync(plist) ? execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim() : '';
  if (id !== BUNDLE_ID) {
    console.error(`${app} exists and isn't Jester's launcher (${id || 'no bundle ID'}); move it first.`);
    process.exit(1);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version || '0.0.0';
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

const script = `#!/bin/bash
# Starts Jester Desktop from ${desktop}.
# Made by desktop/scripts/make-launcher.mjs: run "npm run launcher" there to remake it.
DESKTOP=${quote(desktop)}
ELECTRON="$DESKTOP/node_modules/electron/dist/Electron.app"
LOG="$HOME/Library/Logs/Jester/dev.log"

if [ ! -d "$ELECTRON" ]; then
  osascript -e 'display alert "Jester can’t start" message "Its files aren’t where they were. In the jester-extension folder’s desktop folder, run: npm run launcher" as critical'
  exit 1
fi

# Running already: bring up its Settings (the app opens them when activated).
if pgrep -f "Electron.app/Contents/MacOS/Electron $DESKTOP\\$" > /dev/null; then
  exec /usr/bin/open -a "$ELECTRON"
fi

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
# A terminal inside VS Code would make Electron start as plain Node.
unset ELECTRON_RUN_AS_NODE
export JESTER_LOG=1
exec /usr/bin/open -a "$ELECTRON" --stdout "$LOG" --stderr "$LOG" --args "$DESKTOP"
`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jester</string>
  <key>CFBundleDisplayName</key><string>Jester</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>Jester</string>
  <key>CFBundleIconFile</key><string>Jester</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- It only starts Jester, which lives in the menu bar: no Dock icon of its own. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

/** The extension's icon at every size macOS asks for; the largest are scaled up from 128 px. */
function makeIcon(resources) {
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-icon-')) + '/Jester.iconset';
  fs.mkdirSync(iconset);
  const source = (size) => path.join(icons, size <= 16 ? 'icon16.png' : size <= 32 ? 'icon32.png' : 'icon128.png');
  for (const [name, size] of [
    ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
    ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
    ['icon_512x512', 512], ['icon_512x512@2x', 1024]
  ]) {
    execFileSync('sips', ['-z', String(size), String(size), source(size), '--out', path.join(iconset, `${name}.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Jester.icns')]);
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
}

// Built aside, then swapped in whole.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-launcher-'));
const built = path.join(staging, 'Jester.app');
fs.mkdirSync(path.join(built, 'Contents/MacOS'), { recursive: true });
fs.mkdirSync(path.join(built, 'Contents/Resources'), { recursive: true });
fs.writeFileSync(path.join(built, 'Contents/Info.plist'), plist);
fs.writeFileSync(path.join(built, 'Contents/MacOS/Jester'), script, { mode: 0o755 });
makeIcon(path.join(built, 'Contents/Resources'));
fs.rmSync(app, { recursive: true, force: true });
fs.cpSync(built, app, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
// Finder and Launchpad notice the new icon sooner.
execFileSync('touch', [app]);
console.log(`Made ${app}: double-click it, or find "Jester" in Launchpad or Spotlight.`);
