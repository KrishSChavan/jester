/** Explicit local setup; app startup never downloads or installs packages. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const environment = path.join(root, '.scrapling');
const python = path.join(environment, windows ? 'Scripts/python.exe' : 'bin/python');

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(environment, 'browsers') } });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

try {
  try { await fs.access(python); }
  catch {
    const command = process.env.JESTER_PYTHON || (windows ? 'py' : 'python3');
    await run(command, [...(windows && !process.env.JESTER_PYTHON ? ['-3'] : []), '-m', 'venv', environment]);
  }
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '-r', path.join(root, 'scraping/requirements.txt')]);
  if (process.argv.includes('--browser')) {
    // Install only the browser used by StealthyFetcher. Scrapling's general
    // installer also runs OS-level install-deps, which is outside local setup.
    await run(python, ['-m', 'patchright', 'install', 'chromium']);
  }
  process.stdout.write(`Scrapling is ready for public web research.${process.argv.includes('--browser') ? ' Isolated browser rendering is installed.' : ' Add --browser to install isolated JavaScript rendering.'}\n`);
} catch (error) {
  process.stderr.write(`Scraping setup failed: ${error.message}. Python 3.10 or newer is required; set JESTER_PYTHON to a Python executable if needed.\n`);
  process.exitCode = 1;
}
