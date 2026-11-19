/** Scrapling runs in isolated, bounded Python workers, never in a renderer. */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * Where the helper's Python and its browser are: .scrapling beside src/ in a checkout (npm run scraping:setup);
 * for an installed Jester, a folder with his settings (boot.js), since his own folder can't be written to.
 */
const scraplingHome = (env = process.env, root = desktop) => (env.JESTER_SCRAPLING_DIR ? path.resolve(env.JESTER_SCRAPLING_DIR) : path.join(root, '.scrapling'));
const SETUP = process.env.JESTER_SCRAPLING_DIR
  ? 'The local page reader isn’t set up on this computer. Link Jester’s Chrome extension (Settings › Chrome) and pages are read through it.'
  : 'Install local scraping with npm --prefix desktop run scraping:setup.';
const failure = (code, detail) => ({ ok: false, code, detail });

function killWorker(child) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    // A detached process group includes Chromium's children too.
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
  } else if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, shell: false });
      killer.on('error', () => { try { child.kill(); } catch {} });
      killer.unref();
      return;
    } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

export function scrapingPython({ env = process.env, platform = process.platform, root = desktop } = {}) {
  return env.JESTER_SCRAPLING_PYTHON || path.join(scraplingHome(env, root), platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

export function createWebScraper({ python = scrapingPython(), worker = path.join(desktop, 'scraping/worker.py'), spawn = nodeSpawn,
  timeoutMs = 45000, maxOutput = 128 * 1024, maxConcurrent = 2 } = {}) {
  const active = new Set();
  let closed = false;

  function request(input, { signal } = {}) {
    if (closed || signal?.aborted) return Promise.resolve(failure('aborted', 'Background research stopped.'));
    if (active.size >= maxConcurrent) return Promise.resolve(failure('busy', 'Two background reads are already running. Try again shortly.'));
    if (!input || !['search', 'scrape'].includes(input.op)) return Promise.resolve(failure('invalid_request', 'Choose a search or scrape request.'));
    const payload = { op: input.op, ...(input.op === 'search' ? { query: input.query } : { url: input.url, mode: input.mode || 'auto', ...(input.selector ? { selector: input.selector } : {}) }) };
    let serialized;
    try { serialized = JSON.stringify(payload); } catch { return Promise.resolve(failure('invalid_request', 'The web request could not be read.')); }
    if (Buffer.byteLength(serialized) > 12000) return Promise.resolve(failure('invalid_request', 'The web request was too large.'));

    return new Promise((resolve) => {
      let child;
      try { child = spawn(python, ['-u', worker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(scraplingHome(), 'browsers') } }); }
      catch { resolve(failure('setup_required', SETUP)); return; }
      let bytes = 0;
      const chunks = [];
      let done = false;
      let timer;
      const job = { stop: () => finish(failure('aborted', 'Background research stopped.'), true) };
      active.add(job);
      const onAbort = () => job.stop();
      function finish(result, kill = false) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        active.delete(job);
        if (kill) killWorker(child);
        resolve(result);
      }
      child.on('error', (error) => finish(failure(error.code === 'ENOENT' ? 'setup_required' : 'worker_failed', error.code === 'ENOENT' ? SETUP : 'The local web reader could not start.'), true));
      child.stdin.on('error', () => undefined);
      child.stderr.on('data', () => undefined); // No page text, URLs, or library logs go into app logs.
      child.stdout.on('data', (chunk) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutput) return finish(failure('too_large', 'The web reader returned too much content.'), true);
        chunks.push(Buffer.from(chunk));
      });
      child.on('close', () => {
        if (done) return;
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('protocol');
          finish(result);
        } catch { finish(failure('worker_failed', 'The local web reader returned an unreadable response. ' + SETUP)); }
      });
      timer = setTimeout(() => finish(failure('timeout', 'Background research timed out. Try a specific page or use the browser.'), true), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      child.stdin.end(serialized);
    });
  }

  return {
    request,
    /** Set up (npm run scraping:setup): its Python is there. */
    ready: () => !closed && fs.existsSync(python),
    close() { closed = true; for (const job of [...active]) job.stop(); }
  };
}
