/**
 * `npm run dev:mac`: the app, launched the way macOS expects an app to be.
 *
 *   npm run dev:mac                                   the app
 *   npm run dev:mac -- spikes/input-in-electron.mjs   a spike instead
 *
 * Started from a terminal, Electron counts as part of that terminal (or of VS
 * Code), and macOS would ask whether *VS Code* may use the camera and control
 * the computer. Started through `open`, Electron is its own app, the prompts
 * name "Electron", and the permissions stay with it.
 *
 * Its output goes to ~/Library/Logs/Jester/dev.log (or JESTER_DEV_LOG), which
 * this prints as it grows: `open` can't write into ~/Downloads on the app's behalf, as macOS
 * guards that folder. Ctrl-C quits both.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronApp = path.join(root, 'node_modules/electron/dist/Electron.app');
// JESTER_DEV_LOG: somewhere else, so a test run leaves a running Jester's log alone.
const logFile = process.env.JESTER_DEV_LOG ? path.resolve(process.env.JESTER_DEV_LOG) : path.join(os.homedir(), 'Library/Logs/Jester/dev.log');

if (process.platform !== 'darwin') {
  console.error('dev:mac is for macOS; use npm start elsewhere.');
  process.exit(1);
}
if (!fs.existsSync(electronApp)) {
  console.error('Electron is not downloaded yet; run: node node_modules/electron/install.js');
  process.exit(1);
}

const [first, ...rest] = process.argv.slice(2);
const entry = first && /\.[cm]?js$/.test(first) ? path.resolve(first) : root;
const extra = entry === root ? process.argv.slice(2) : rest;

fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, '');
// `open` passes this process's environment on. VS Code's ELECTRON_RUN_AS_NODE
// would make Electron start as plain Node, so it goes.
const env = { ...process.env, JESTER_LOG: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn('open', ['-n', '-W', '-a', electronApp, '--stdout', logFile, '--stderr', logFile, '--args', entry, ...extra], { stdio: 'inherit', env });

let offset = 0;
function printNew() {
  const size = fs.statSync(logFile).size;
  if (size <= offset) return;
  const chunk = Buffer.alloc(size - offset);
  const fd = fs.openSync(logFile, 'r');
  fs.readSync(fd, chunk, 0, chunk.length, offset);
  fs.closeSync(fd);
  offset = size;
  // Electron's own noise about code signing in a dev build.
  process.stdout.write(chunk.toString('utf8').split('\n').filter((line) => !line.includes('codesign_util')).join('\n'));
}
const timer = setInterval(printNew, 250);

child.on('exit', (code) => {
  clearInterval(timer);
  printNew();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => {
  // Quit the Electron that `open` started: the one whose arguments name this entry.
  spawnSync('pkill', ['-f', `Electron.app/Contents/MacOS/Electron ${entry}`]);
});
