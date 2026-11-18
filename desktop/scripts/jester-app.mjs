/**
 * Jester.app: the Electron that runs Jester from source on a Mac, under his
 * own name and icon.
 *
 * npm's Electron.app calls itself "Electron", so the Dock, the menu bar,
 * Activity Monitor, the permission prompts and System Settings' lists all
 * said "Electron". This makes a copy that says Jester: bundle ID
 * com.jester.desktop, Jester's icon (icons/Jester.icns, from make-icons.mjs),
 * prompts that say what he wants the camera, microphone, Bluetooth and
 * location for, and helpers renamed to match ("Jester Helper (Renderer)"),
 * which Electron finds by the app's name. The executable inside keeps
 * Electron's name: Electron decides app.isPackaged by it, and from source he
 * isn't packaged.
 *
 * The copy is made of APFS clones of npm's files, so it takes no room, and
 * it's remade when Electron is upgraded or the icon changes. It lives in
 * desktop/app.noindex, a folder Spotlight skips, so "Jester" in Spotlight
 * finds only the launcher. Nothing is re-signed: npm's Electron is ad-hoc
 * signed by the linker, its Info.plist isn't sealed, and renaming files
 * changes no code. macOS ties permissions to the bundle ID, so the copy's
 * first run asks for them afresh, this time for "Jester".
 *
 *   npm run app                                       make it if needed, and print where
 *   import { jesterApp } from './jester-app.mjs'      the same, from another script
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocation } from './build-location.mjs';

const here = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(here), '..');
export const ELECTRON_APP = path.join(desktop, 'node_modules/electron/dist/Electron.app');
export const JESTER_APP = path.join(desktop, 'app.noindex/Jester.app');
export const BUNDLE_ID = 'com.jester.desktop';
const ICON = path.join(desktop, 'icons/Jester.icns');
/** Raise when what's done below changes, so every copy is remade. */
const RECIPE = 1;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** What macOS's prompts say he wants each thing for. */
export const USAGE = {
  NSCameraUsageDescription: 'Jester watches for your hand gestures through the camera, and your eyes or head if you steer the pointer with them.',
  NSMicrophoneUsageDescription: 'Jester listens for his name and for what you ask him.',
  NSBluetoothAlwaysUsageDescription: 'Jester talks to your Apple Watch over Bluetooth, so you can move the pointer with it.',
  NSBluetoothPeripheralUsageDescription: 'Jester talks to your Apple Watch over Bluetooth, so you can move the pointer with it.',
  NSLocationUsageDescription: 'Jester uses where this Mac is for the weather and what’s near you, once you turn it on in Settings.',
  NSLocationWhenInUseUsageDescription: 'Jester uses where this Mac is for the weather and what’s near you, once you turn it on in Settings.'
};

/**
 * The main app's Info.plist changes: [key, value] pairs.
 * @param {{version:string, made:string}} options  Jester's version; what the copy was made from
 */
export function appChanges({ version, made }) {
  return [
    ['CFBundleName', 'Jester'],
    ['CFBundleDisplayName', 'Jester'],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleIconFile', 'Jester.icns'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['LSApplicationCategoryType', 'public.app-category.productivity'],
    ...Object.entries(USAGE),
    ['JesterMadeFrom', made]
  ];
}

/** "Electron Helper (GPU)" → "Jester Helper (GPU)"; null for anything that isn't a helper. */
export function helperName(name) {
  const match = /^Electron Helper( \([^)]+\))?$/.exec(name);
  return match ? `Jester Helper${match[1] || ''}` : null;
}

/** A helper's Info.plist changes, given its new name. */
export function helperChanges(name) {
  return [
    ['CFBundleName', name],
    ['CFBundleDisplayName', name],
    ['CFBundleExecutable', name],
    ['CFBundleIdentifier', `${BUNDLE_ID}.helper`]
  ];
}

function plistValue(file, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();
}

function setPlist(file, changes) {
  for (const [key, value] of changes) execFileSync('plutil', ['-replace', key, '-string', value, file]);
}

/** What a copy made now would be made from: when it differs from a copy's, the copy is remade. */
function recipe() {
  const electron = plistValue(path.join(ELECTRON_APP, 'Contents/Info.plist'), 'CFBundleShortVersionString');
  const icon = crypto.createHash('sha256').update(fs.readFileSync(ICON)).digest('hex').slice(0, 12);
  const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version || '0.0.0';
  return { version, made: `recipe ${RECIPE}, Electron ${electron}, icon ${icon}, Jester ${version}` };
}

function madeFrom(app) {
  try {
    return plistValue(path.join(app, 'Contents/Info.plist'), 'JesterMadeFrom');
  } catch {
    return null;
  }
}

function running(app) {
  return spawnSync('pgrep', ['-f', `${app}/Contents/MacOS/`]).status === 0;
}

/** Copies a bundle as APFS clones (no room taken); a plain copy where cloning can't be done. */
function cloneBundle(from, to) {
  if (spawnSync('cp', ['-cR', from, to]).status === 0) return;
  fs.rmSync(to, { recursive: true, force: true });
  execFileSync('ditto', [from, to]);
}

/**
 * Makes `target` from the Electron.app at `from`: built aside, then swapped in whole.
 * @param {string} target
 * @param {{version:string, made:string, from?:string, icon?:string}} options
 */
export function build(target, { version, made, from = ELECTRON_APP, icon = ICON }) {
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.building`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  cloneBundle(from, staging);

  const resources = path.join(staging, 'Contents/Resources');
  fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
  fs.copyFileSync(icon, path.join(resources, 'Jester.icns'));
  setPlist(path.join(staging, 'Contents/Info.plist'), appChanges({ version, made }));

  const frameworks = path.join(staging, 'Contents/Frameworks');
  for (const entry of fs.readdirSync(frameworks)) {
    const name = helperName(entry.replace(/\.app$/, ''));
    if (!entry.endsWith('.app') || !name) continue;
    const helper = path.join(frameworks, `${name}.app`);
    fs.renameSync(path.join(frameworks, entry), helper);
    fs.renameSync(path.join(helper, 'Contents/MacOS', entry.replace(/\.app$/, '')), path.join(helper, 'Contents/MacOS', name));
    setPlist(path.join(helper, 'Contents/Info.plist'), helperChanges(name));
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
}

/**
 * Jester.app, made or remade if it's missing or out of date, and its path; and his Location Services module
 * (build-location.mjs), built if it isn't. A Jester.app that's running is left as it is (its files can't be swapped
 * under it).
 * @param {{log?: (line:string) => void}} [options]
 */
export function jesterApp({ log = (line) => console.log(line) } = {}) {
  if (process.platform !== 'darwin') throw new Error('Jester.app is for macOS.');
  if (!fs.existsSync(ELECTRON_APP)) throw new Error('Electron is not downloaded yet; in desktop/, run: node node_modules/electron/install.js');
  // His way of asking Location Services (Electron's own location never asks macOS): built here, so whatever starts
  // Jester.app finds it ready.
  try {
    buildLocation({ log });
  } catch (err) {
    log(`${err.message}\nUntil it's built, Jester can't use this Mac's location.`);
  }
  const wanted = recipe();
  const have = fs.existsSync(JESTER_APP) ? madeFrom(JESTER_APP) : null;
  if (have === wanted.made) return JESTER_APP;
  if (have && running(JESTER_APP)) {
    log('Jester.app is out of date but running; quit Jester to have it remade.');
    return JESTER_APP;
  }
  build(JESTER_APP, wanted);
  // So Finder, the Dock and the permission prompts know the new name and icon now, not after a while.
  spawnSync(LSREGISTER, ['-f', JESTER_APP]);
  log(`${have ? 'Remade' : 'Made'} ${JESTER_APP} (${wanted.made}).`);
  return JESTER_APP;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  try {
    let said = false;
    const app = jesterApp({ log: (line) => ((said = true), console.log(line)) });
    if (!said) console.log(`${app} is up to date.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
