/**
 * `npm run driver`: build jester-driver (release) with whichever cargo is
 * installed — on the PATH, or where rustup puts it when told to leave shell
 * profiles alone (~/.cargo/bin).
 *
 *   npm run driver -- [extra cargo arguments, e.g. --target x86_64-apple-darwin]
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const candidates = [process.env.CARGO, 'cargo', path.join(os.homedir(), '.cargo', 'bin', exe)].filter(Boolean);
const cargo = candidates.find((candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
if (!cargo) {
  console.error('cargo not found. Install Rust from https://rustup.rs, then run this again.');
  process.exit(1);
}
const build = spawnSync(cargo, ['build', '--release', '--manifest-path', path.join(root, 'native/jester-driver/Cargo.toml'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(build.status ?? 1);
