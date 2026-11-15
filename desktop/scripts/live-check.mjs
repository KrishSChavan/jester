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
 *   stale    a conversation summed up yesterday reaches the model as yesterday's, with the line that says what it
 *            called upcoming has likely happened, and the rule against calling a date gone by upcoming.
 *   self     what he's asked to remember is kept in the vault and "forget that" takes it back out; "what do you know
 *            about me?" reaches the model with all of About me; a named thing is forgotten by the model's pick from
 *            numbered lists; and someone in a hurry is said to be, in the brackets before their words.
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
  const { app, BrowserWindow, safeStorage, shell } = await import('electron');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-live-'));
  Object.assign(process.env, { JESTER_DATA_DIR: scratch, JESTER_FAKE_MEDIA: '1', JESTER_DRIVER_DRY: '1', JESTER_LOG: '1', JESTER_NO_LINK: '1', JESTER_OPEN_SETTINGS: '1' });
  // Sealed keys are kept as written: the keychain is never asked.
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = (text) => Buffer.from(String(text), 'utf8');
  safeStorage.decryptString = (sealed) => Buffer.from(sealed).toString('utf8');
  // A note he's asked to forget goes to the trash: here, nowhere near the user's own.
  const trashed = [];
  shell.trashItem = async (file) => {
    trashed.push(file);
    fs.rmSync(file);
  };
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

  /** The system prompt of the last request a model server took. */
  const lastSystem = (server) => server.requests.at(-1)?.messages?.[0]?.content || '';

  const vaultDir = path.join(scratch, 'vault');
  const inVault = (rel) => path.join(vaultDir, rel);
  const lastSaid = (server) => server.requests.at(-1)?.messages?.at(-1)?.content || '';

  const SCENARIOS = {
    /** Step 6: remembering and taking it back, what he knows, forgetting a named thing, and how they sound. */
    async self({ paid }) {
      const { createVault } = await import(path.join(desktop, 'src/main/vault.js'));
      await until('the vault opened', () => fs.existsSync(inVault('Jester/About me.md')), 20000);
      const kept = () => (fs.existsSync(inVault('Jester/Remembered')) ? fs.readdirSync(inVault('Jester/Remembered')) : []);
      paid.answer = () => ({ say: 'I’ll remember that.', do: '', new: false, remember: 'my locker combination is 12-34-56' });
      await type('my locker combination is 12-34-56, remember that');
      check('asked to remember, a note is made in the vault', kept().length === 1 && /12-34-56/.test(fs.readFileSync(inVault(`Jester/Remembered/${kept()[0]}`), 'utf8')), kept().join(', '));
      const asked = paid.requests.length;
      const back = await type('forget that');
      check('“forget that” takes it back out, to the trash, with no model asked', kept().length === 0 && trashed.length === 1 && paid.requests.length === asked && /^Done\. I’ve taken “.+” back out of your notes\.$/.test(back), `${JSON.stringify(back)} · kept ${kept().length} · trashed ${trashed.length} · model asked ${paid.requests.length - asked}`);

      createVault({ root: vaultDir }).updateAboutMe({ add: [{ section: 'School and work', fact: 'Studies computer science at Penn State' }, { section: 'People', fact: 'Roommate is Alex Chen' }, { section: 'Preferences', fact: 'Likes pineapple on pizza' }] });
      paid.answer = () => ({ say: 'You study computer science at Penn State.', do: '', new: false });
      await type('what do you know about me?');
      const given = lastSaid(paid);
      check('asked what he knows, the model is given all of About me by section', /Everything you’ve learned about the user \(the About me note in their vault\):\nSchool and work: Studies computer science at Penn State\nPeople: Roommate is Alex Chen\nPreferences: Likes pineapple on pizza/.test(given), given.slice(0, 400));
      check('and his prompt says how to answer it', /Asked what you know or remember about them, pick the three or four things that matter most/.test(lastSystem(paid)));

      // The forgetting model picks by number from what it's shown: here, whichever line says the roommate.
      paid.answer = (request) => {
        const shown = request?.messages?.at(-1)?.content || '';
        if (!/asked Jester to forget/.test(request?.messages?.[0]?.content || '')) return { say: 'This should not be said.', do: '', new: false };
        const at = Number(/^(\d+)\. Roommate is Alex Chen$/m.exec(shown.split('What they asked Jester to remember:')[0])?.[1]);
        return { what: 'that your roommate is Alex', facts: at ? [at] : [], notes: [], summaries: [], earlier: [] };
      };
      const forgot = await type('forget that my roommate is Alex');
      const about = fs.readFileSync(inVault('Jester/About me.md'), 'utf8');
      check('a named thing is forgotten: gone from About me, the rest kept, and he says what went', forgot === 'Done. I’ve forgotten “Roommate is Alex Chen”.' && !/Alex/.test(about) && /Penn State/.test(about) && /pineapple/.test(about), `${JSON.stringify(forgot)}\n${about}`);
      check('the log says how much was forgotten, never what', /memory: forgot 1 fact\(s\), 0 note\(s\)/.test(logLines()) && !/forgot.*Alex/.test(logLines()));
      const everything = await type('forget everything about me');
      check('everything at once isn’t done on one sentence', /^Everything is more than I’ll throw away on one sentence/.test(everything) && /Penn State/.test(fs.readFileSync(inVault('Jester/About me.md'), 'utf8')), everything);

      // Settings › Memory: how much he knows, counted when the page opens.
      await inPage(`document.querySelector('[data-go="settings/memory"]')?.click();`);
      const row = await until('the count of what he knows', () => inPage(`const hint = document.getElementById('known-hint'); return !document.getElementById('known-row').hidden && hint.textContent ? hint.textContent : '';`)).catch((err) => err.message);
      check('Settings › Memory says how much he knows', /^2 things learned from talking with you\. Ask him/.test(row), row);

      paid.answer = () => ({ say: 'Twelve.', do: '', new: false });
      await type('quick, what’s 15 percent of 80?');
      check('someone in a hurry is said to be, in the brackets before their words', /How they sound: in a hurry\.\]\n\[\w+day, /.test(lastSaid(paid)), lastSaid(paid).slice(0, 300));
      paid.answer = () => ({ say: 'Hello from paid.', do: '', new: false });
    },

    /** What was summed up yesterday is yesterday's when he's told it (2026-11-13: "a class starting in about an hour"). */
    async stale({ paid }) {
      await type('what’s up?');
      const system = lastSystem(paid);
      const line = /^- (?:Yesterday|2 days ago) \(\w+day\) at [^\n]*: Provided current weather, time, and advised attending the upcoming class\.$/m.exec(system)?.[0];
      check('yesterday’s summary reaches the model saying how old it is', !!line, system.split('Earlier conversations')[1]?.slice(0, 400) || 'no earlier conversations in the prompt');
      check('with the line that what it called upcoming has likely happened', /by now it has most likely happened\./.test(system));
      check('and the rule to check a date against the day', /Before you call anything upcoming, check its date against the date on the user's words/.test(system));
      check('the user’s words carry the date and time', /(?:^|\n)\[\w+day, \w+ \d+, \d{4} at \d+:\d\d.[AP]M\] what’s up\?$/.test(paid.requests.at(-1)?.messages?.at(-1)?.content || ''), paid.requests.at(-1)?.messages?.at(-1)?.content);
    },

    /** Paid before free, a failing one covered for and left alone, and Settings saying so. */
    async models({ paid, free }) {
      const was = { paid: paid.requests.length, free: free.requests.length };
      const counts = () => `paid ${paid.requests.length - was.paid}, free ${free.requests.length - was.free}`;
      const first = await type('hello there');
      check('a paid model answers first, though the free one was saved first', first === 'Hello from paid.' && counts() === 'paid 1, free 0', `he said ${JSON.stringify(first)}; ${counts()}`);
      check('the persona prompt reaches the model with what he can do', /What you can do, all of it/.test(lastSystem(paid)));
      paid.answer = () => ({ status: 500 });
      const second = await type('and again');
      check('a paid model that fails is covered for by the free one', second === 'Hello from free.' && counts() === 'paid 2, free 1', `he said ${JSON.stringify(second)}; ${counts()}`);
      check('the log says who failed and who took it', /talking: custom paid-model failed \(.*500.*\), so custom free-model takes it/.test(logLines()), logLines().split('\n').filter((line) => /talking:/.test(line)).join(' | '));
      const third = await type('once more');
      check('down, it’s left alone the next turn', third === 'Hello from free.' && counts() === 'paid 2, free 2', counts());
      const listed = await inPage(`return chrome.runtime.sendMessage({ type: 'jester/desktop-connections', op: 'list' });`);
      const spend = Object.fromEntries((listed.connections || []).map((connection) => [connection.model, connection.spend?.requests ?? 0]));
      check('Settings is told the order and what each has answered', listed.paidFirst === true && spend['paid-model'] === was.paid + 1 && spend['free-model'] === was.free + 2, JSON.stringify({ paidFirst: listed.paidFirst, spend }));
      check('no key is in what Settings is told', !JSON.stringify(listed).includes('scratch-key'));
      home.webContents.reload();
      await until('his window, loaded again', () => !home.webContents.isLoading());
      const page = await until('Settings › Models, drawn', () => inPage(`const jobs = document.getElementById('job-talk')?.textContent || ''; const rows = document.getElementById('connections')?.textContent || ''; return rows.includes('free-model') && jobs ? { jobs, rows } : null;`));
      check('Settings › Models names the paid model first for talking', /paid-model, then .*free-model/.test(page.jobs), page.jobs);
      check('and says what each has answered this month', /paid-model.*\d+ repl(?:y|ies) this month/.test(page.rows) && /free-model.*2 replies this month/.test(page.rows), page.rows);
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
        settings: { enabled: false, voiceEnabled: false, continuousAssistant: false, watchEnabled: false, localModelUses: [], cameraDeviceId: '', longRange: false, memoryVault: vaultDir },
        // The free one saved first: only its plan puts it second.
        modelConnections: [model('free', free, 'free'), model('paid', paid, 'paid')]
      })
    );
    // A conversation summed up 31 hours ago, as recollections.js keeps it: the sentence that became a class "in about an hour".
    fs.writeFileSync(path.join(scratch, 'recollections.json'), JSON.stringify({ conversations: [{ at: Date.now() - 31 * 3600000, summary: 'Provided current weather, time, and advised attending the upcoming class.', chat: 'earlier-chat' }] }));
    fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
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
