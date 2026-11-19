/**
 * `npm run dist`: the Jester people download. Builds the helpers for this computer's platform, puts them where
 * electron-builder.yml collects them (build/bin/<mac|win>), and runs electron-builder.
 *
 *   npm run dist                 the installers, in dist/ (a .dmg and a .zip on a Mac; a setup .exe on Windows)
 *   npm run dist -- --dir        only the app's folder, unpacked: quick, for trying it (dist/mac-arm64/Jester.app)
 *   npm run dist -- --skip-native   reuse the helpers built before
 *
 * A Mac build needs Rust and the Xcode command line tools (swiftc, clang); a Windows build needs Rust with the
 * MSVC tools. The GitHub workflow (.github/workflows/release.yml) runs this on a Mac and a Windows machine
 * whenever a version is tagged. Nothing is signed with a paid certificate: see electron-builder.yml.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipNative = args.includes('--skip-native');
const forBuilder = args.filter((arg) => arg !== '--skip-native');
const mac = process.platform === 'darwin';
const win = process.platform === 'win32';
if (!mac && !win) {
  console.error('Jester is packaged for macOS and Windows.');
  process.exit(1);
}

const env = { ...process.env };
// VS Code sets this for what it starts; electron-builder's own tools mustn't run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

function run(command, commandArgs, what) {
  console.log(`\n— ${what}`);
  const done = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env, shell: false });
  if (done.error || done.status !== 0) {
    console.error(`${what} failed${done.error ? `: ${done.error.message}` : ` (exit ${done.status})`}.`);
    process.exit(done.status || 1);
  }
}

const bin = path.join(root, 'build/bin', mac ? 'mac' : 'win');
/** A helper copied into build/bin, or the build stops: an app without it can't click, or can't be linked to Chrome. */
function collect(from, name, { optional = false } = {}) {
  if (!fs.existsSync(from)) {
    if (optional) return console.warn(`  (no ${name}: left out)`);
    console.error(`${from} wasn’t built.`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(bin, name));
  if (!win) fs.chmodSync(path.join(bin, name), 0o755);
  console.log(`  ${name}  ${(fs.statSync(from).size / 1048576).toFixed(1)} MB`);
}

if (!skipNative) {
  run(process.execPath, ['scripts/build-driver.mjs'], 'Building jester-driver (Rust)');
  if (mac) {
    run(process.execPath, ['scripts/build-watch.mjs'], 'Building the Apple Watch bridge (Swift)');
    run(process.execPath, ['scripts/build-location.mjs'], 'Building the Location Services module (clang)');
  }
}
fs.rmSync(bin, { recursive: true, force: true });
fs.mkdirSync(bin, { recursive: true });
console.log(`\n— Collecting the helpers into ${path.relative(root, bin)}`);
if (mac) {
  collect(path.join(root, 'native/jester-driver/target/release/jester-driver'), 'jester-driver');
  collect(path.join(root, 'native/jester-watch/build/jester-watch-bridge'), 'jester-watch-bridge', { optional: true });
  collect(path.join(root, 'native/jester-location/build/jester-location.node'), 'jester-location.node');
} else {
  collect(path.join(root, 'native/jester-driver/target/release/jester-driver.exe'), 'jester-driver.exe');
}

const require = createRequire(import.meta.url);
const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
run(process.execPath, [builder, mac ? '--mac' : '--win', '--publish', 'never', ...forBuilder], 'Packaging with electron-builder');
console.log('\nDone: see dist/.');
