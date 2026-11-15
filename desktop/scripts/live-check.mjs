/**
 * The real Jester, end to end, on a scratch profile: main.js and all it
 * starts, his window's own pages, and model servers that are this script's, so
 * what a model "says" and when it fails is scripted. What the unit tests take
 * on trust is checked here: that main.js wires the pieces together, and that
 * what's typed to him comes back through them.
 *
 *   npm run live-check              every scenario
 *   npm run live-check -- models    only the ones named
 *
 * Nothing of the user's is touched: no camera or mic (JESTER_FAKE_MEDIA), no
 * real input (JESTER_DRIVER_DRY), no keychain (safeStorage is stubbed, so the
 * scratch profile's models are kept as they're written), no link to Chrome, no
 * model of theirs (this computer's is unticked, or a run with Ollama up would
 * load it), and a data folder under the system's temp one that's removed after.
 * His window opens faint, unfocused and click-through, so it's in nobody's way.
 *
 * Scenarios:
 *   models   paid models are asked before free ones; a paid one that fails is covered for by the free one, and
 *            left alone for the next turn; Settings › Models says the order and what each has answered.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(here), '..');

if (!process.versions.electron) {
  // Plain Node: start Electron on this script, without VS Code's ELECTRON_RUN_AS_NODE.
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow, safeStorage } = await import('electron');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-live-'));
  Object.assign(process.env, { JESTER_DATA_DIR: scratch, JESTER_FAKE_MEDIA: '1', JESTER_DRIVER_DRY: '1', JESTER_LOG: '1', JESTER_NO_LINK: '1', JESTER_OPEN_SETTINGS: '1' });
  // Sealed keys are kept as written: the keychain is never asked.
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = (text) => Buffer.from(String(text), 'utf8');
  safeStorage.decryptString = (sealed) => Buffer.from(sealed).toString('utf8');
  // His window, where nobody will notice it.
  const quietly = function () {
    this.setOpacity(0.02);
    this.setIgnoreMouseEvents(true);
    this.showInactive();
  };
  BrowserWindow.prototype.show = quietly;
  BrowserWindow.prototype.focus = () => undefined;

  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  };

  /** Waits for `probe` to give something truthy, or throws saying what never came. */
  async function until(what, probe, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
      const found = await probe();
      if (found) return found;
      if (Date.now() > end) throw new Error(`never happened: ${what}`);
      await pause(100);
    }
  }

  /**
   * A model server, OpenAI-compatible: `answer(request)` gives the reply's JSON, or {status, body} to fail.
   * @returns {Promise<{url:string, requests:object[], answer:Function, close:Function}>}
   */
  function modelServer(name) {
    const server = { requests: [], answer: () => ({ say: `Hello from ${name}.`, do: '', new: false }) };
    const listener = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        let sent = null;
        try {
          sent = JSON.parse(body);
        } catch {
          /* not a model request */
        }
        server.requests.push(sent);
        const reply = server.answer(sent);
        if (reply?.status) {
          response.writeHead(reply.status, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(reply.body ?? { error: { message: `${name} is failing on purpose` } }));
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1800, completion_tokens: 40 } }));
      });
    });
    return new Promise((resolve) =>
      listener.listen(0, '127.0.0.1', () => resolve(Object.assign(server, { url: `http://127.0.0.1:${listener.address().port}/v1`, close: () => listener.close() })))
    );
  }

  const storageFile = path.join(scratch, 'storage-local.json');
  const logLines = () => {
    try {
      return fs.readFileSync(path.join(scratch, 'logs', 'dev.log'), 'utf8');
    } catch {
      return '';
    }
  };
  /** What's been said, as conversation-log.js keeps it. */
  const said = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(scratch, 'conversation.json'), 'utf8')).entries || [];
    } catch {
      return [];
    }
  };
  let home = null;
  /** Runs in his window's page, as its own script would. */
  const inPage = (code) => home.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  /** Types to him, and gives what he wrote back. */
  async function type(text) {
    const before = said().filter((entry) => entry.who === 'jester').length;
    await inPage(`await chrome.runtime.sendMessage({ type: 'jester/talk-type', text: ${JSON.stringify(text)} });`);
    const lines = await until(`his answer to "${text}"`, () => {
      const his = said().filter((entry) => entry.who === 'jester');
      return his.length > before ? his : null;
    });
    return lines.at(-1).text;
  }

  const SCENARIOS = {
    /** Paid before free, a failing one covered for and left alone, and Settings saying so. */
    async models({ paid, free }) {
      const first = await type('hello there');
      check('a paid model answers first, though the free one was saved first', first === 'Hello from paid.' && paid.requests.length === 1 && free.requests.length === 0, `he said ${JSON.stringify(first)}; paid ${paid.requests.length}, free ${free.requests.length}`);
      check('the persona prompt reaches the model with what he can do', /What you can do, all of it/.test(paid.requests[0]?.messages?.[0]?.content || ''));
      paid.answer = () => ({ status: 500 });
      const second = await type('and again');
      check('a paid model that fails is covered for by the free one', second === 'Hello from free.' && paid.requests.length === 2 && free.requests.length === 1, `he said ${JSON.stringify(second)}; paid ${paid.requests.length}, free ${free.requests.length}`);
      check('the log says who failed and who took it', /talking: custom paid-model failed \(.*500.*\), so custom free-model takes it/.test(logLines()), logLines().split('\n').filter((line) => /talking:/.test(line)).join(' | '));
      const third = await type('once more');
      check('down, it’s left alone the next turn', third === 'Hello from free.' && paid.requests.length === 2 && free.requests.length === 2, `paid ${paid.requests.length}, free ${free.requests.length}`);
      const listed = await inPage(`return chrome.runtime.sendMessage({ type: 'jester/desktop-connections', op: 'list' });`);
      const spend = Object.fromEntries((listed.connections || []).map((connection) => [connection.model, connection.spend?.requests ?? 0]));
      check('Settings is told the order and what each has answered', listed.paidFirst === true && spend['paid-model'] === 1 && spend['free-model'] === 2, JSON.stringify({ paidFirst: listed.paidFirst, spend }));
      check('no key is in what Settings is told', !JSON.stringify(listed).includes('scratch-key'));
      home.webContents.reload();
      await until('his window, loaded again', () => !home.webContents.isLoading());
      const page = await until('Settings › Models, drawn', () => inPage(`const jobs = document.getElementById('job-talk')?.textContent || ''; const rows = document.getElementById('connections')?.textContent || ''; return rows.includes('free-model') && jobs ? { jobs, rows } : null;`));
      check('Settings › Models names the paid model first for talking', /paid-model, then .*free-model/.test(page.jobs), page.jobs);
      check('and says what each has answered this month', /paid-model.*1 reply this month/.test(page.rows) && /free-model.*2 replies this month/.test(page.rows), page.rows);
    }
  };

  const run = async () => {
    const paid = await modelServer('paid');
    const free = await modelServer('free');
    const model = (id, server, plan) => ({ id, provider: 'custom', protocol: 'openai-compatible', baseUrl: server.url, model: `${id}-model`, key: 'scratch-key', plan, uses: ['talk', 'act'], cooldownUntil: 0 });
    fs.writeFileSync(
      storageFile,
      JSON.stringify({
        // This computer's model unticked: with Ollama running, a test would load the user's own.
        settings: { enabled: false, voiceEnabled: false, continuousAssistant: false, watchEnabled: false, localModelUses: [], cameraDeviceId: '', longRange: false },
        // The free one saved first: only its plan puts it second.
        modelConnections: [model('free', free, 'free'), model('paid', paid, 'paid')]
      })
    );
    await import(path.join(desktop, 'src/main/main.js'));
    await app.whenReady();
    home = await until('his window', () => BrowserWindow.getAllWindows().find((win) => /\/home\/home\.html/.test(win.webContents.getURL()) && !win.webContents.isLoading()), 30000);
    await until('his window’s script', () => inPage(`return typeof chrome?.runtime?.sendMessage === 'function';`).catch(() => false));
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (wanted.length && !wanted.includes(name)) continue;
      console.log(`\n=== ${name} ===`);
      try {
        await scenario({ paid, free });
      } catch (err) {
        check(`${name} ran to the end`, false, err.message);
      }
    }
    paid.close();
    free.close();
  };

  // Detached: Electron holds `ready` until this module's own awaits are done.
  run()
    .catch((err) => check('the app started', false, err.stack || err.message))
    .finally(() => {
      const failed = results.filter((result) => !result.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? '' : '.'}`);
      if (failed) console.log(`--- the app's log ---\n${logLines().split('\n').slice(-40).join('\n')}`);
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      fs.rmSync(scratch, { recursive: true, force: true });
      app.exit(failed ? 1 : 0);
    });
}
