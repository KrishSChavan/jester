/**
 * `npm start`: Electron, minus ELECTRON_RUN_AS_NODE.
 *
 * VS Code sets that variable for the processes it starts, and Electron then
 * runs as plain Node, where `import { app } from 'electron'` fails. A terminal
 * or task inside VS Code passes it on, so clear it here.
 */

import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
