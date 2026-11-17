/**
 * `npm start`: Electron, minus ELECTRON_RUN_AS_NODE.
 *
 * VS Code sets that variable for the processes it starts, and Electron then
 * runs as plain Node, where `import { app } from 'electron'` fails. A terminal
 * or task inside VS Code passes it on, so clear it here.
 *
 * On a Mac it's Jester.app's Electron (jester-app.mjs), so the Dock and the
 * menu bar say Jester, with his icon. Started from a terminal, macOS still
 * counts it as part of the terminal for permissions; `npm run dev:mac` doesn't.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';
import { jesterApp } from './jester-app.mjs';

const electron = process.platform === 'darwin' ? path.join(jesterApp(), 'Contents/MacOS/Electron') : electronPath;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
