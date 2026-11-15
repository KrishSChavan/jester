/**
 * Jester doing real tasks on this computer, one after another, and how each
 * went: the real driver (real clicks and keys), the user's own saved models,
 * and their linked Chrome, with what's typed to him coming from a list.
 *
 *   npm run task-check                       the tasks below
 *   npm run task-check -- "open Calculator and work out 15 percent of 80" "pause the music"
 *   npm run task-check -- --act claude-sonnet-5-5   actions on another model of the saved Claude key's (talking
 *                                            stays as saved), to see what a stronger one is worth
 *   npm run task-check -- --pictures         let him take pictures of the window (macOS may ask about it)
 *   npm run task-check -- --screens          print the screens the model was shown (the user's own content)
 *
 * THIS ACTS FOR REAL: apps open, music plays, text is typed into what's in
 * front. Run it when nobody else is using the computer, and quit Jester first:
 * only one Jester can hold the link to Chrome. It still asks before anything
 * that sends, buys, deletes or changes settings, and nobody is there to say
 * yes, so those steps are refused after a minute.
 *
 * What's the user's and used: their saved models (the sealed entry is copied as
 * it is, and read through the same keychain item), their Accessibility
 * permission (it's the same app), and the Chrome link's socket. What isn't: the
 * profile is a scratch one, so nothing typed here lands in their chats, their
 * memory or their Obsidian vault; no camera or mic (JESTER_FAKE_MEDIA); this
 * computer's own model is unticked, so a failing saved model shows as failing.
 *
 * Started through `open`, as dev-mac.mjs does, so macOS counts it as the app
 * itself: started from a terminal, its Accessibility would be the terminal's.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(here), '..');
const REAL = path.join(os.homedir(), 'Library/Application Support/Jester');

const TASKS = [
  'open Calculator and work out 15 percent of 80',
  'open TextEdit, make a new document and type hello from Jester',
  'put TextEdit on the left half of the screen',
  'open System Settings and tell me the name of the Wi-Fi network I am on',
  'open Finder and tell me how many items are in my Downloads folder',
  'play Gunna on Spotify',
  'pause the music'
];

/** `--act <model>`: the model actions go to, or ''. */
const actModel = () => {
  const at = process.argv.indexOf('--act');
  return at > 0 ? String(process.argv[at + 1] || '') : '';
};

if (process.versions.electron && process.env.JESTER_TASK_SEAL) {
  // A first, short run: the saved models with actions moved to another model of the same key, sealed again for the
  // run proper to read. Here because the keychain is only to be had once Electron is ready, and main.js must be
  // loaded before that.
  const { app, safeStorage } = await import('electron');
  app.setName('Jester');
  app.dock?.hide();
  app.whenReady().then(() => {
    let code = 0;
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(REAL, 'storage-local.json'), 'utf8'));
      const list = JSON.parse(safeStorage.decryptString(Buffer.from(stored.modelConnections.sealed, 'base64')));
      const claude = list.find((entry) => entry.provider === 'anthropic');
      if (!claude) throw new Error('no saved Claude model to take the key of');
      const moved = [
        ...list.map((entry) => ({ ...entry, uses: (entry.uses || ['act']).filter((use) => use !== 'act') })).filter((entry) => entry.uses.length),
        { ...claude, id: 'task-check-act', model: process.env.JESTER_TASK_SEAL, uses: ['act'] }
      ];
      fs.writeFileSync(path.join(process.env.JESTER_TASK_CHECK, 'connections.sealed'), safeStorage.encryptString(JSON.stringify(moved)).toString('base64'));
    } catch (err) {
      console.error('task-check: could not set the model for actions:', err.message);
      code = 1;
    }
    app.exit(code);
  });
} else if (!process.versions.electron) {
  if (process.platform !== 'darwin') {
    console.error('task-check is for macOS.');
    process.exit(1);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-tasks-'));
  const logFile = path.join(scratch, 'run.log');
  fs.writeFileSync(logFile, '');
  const env = { ...process.env, JESTER_TASK_CHECK: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronApp = path.join(desktop, 'node_modules/electron/dist/Electron.app');
  if (actModel()) {
    const sealed = spawnSync(path.join(electronApp, 'Contents/MacOS/Electron'), [here], { stdio: 'inherit', env: { ...env, JESTER_TASK_SEAL: actModel() } });
    if (sealed.status !== 0) process.exit(1);
    console.log(`Actions on ${actModel()} for this run.`);
  }
  const child = spawn('open', ['-n', '-W', '-a', electronApp, '--stdout', logFile, '--stderr', logFile, '--args', here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  let offset = 0;
  const printNew = () => {
    const text = fs.readFileSync(logFile, 'utf8');
    const fresh = text.slice(offset);
    const cut = fresh.lastIndexOf('\n') + 1;
    offset += cut;
    for (const line of fresh.slice(0, cut).split('\n')) if (line.startsWith('task-check')) console.log(line.replace(/^task-check: ?/, ''));
  };
  const timer = setInterval(printNew, 500);
  child.on('exit', () => {
    clearInterval(timer);
    printNew();
    console.log(`\nThe whole log of the run: ${logFile}`);
    process.exit(0);
  });
} else {
  const { app, BrowserWindow } = await import('electron');
  // Started on a script, Electron calls itself "Electron", and the keychain item the models are sealed with is Jester's.
  app.setName('Jester');
  const scratch = process.env.JESTER_TASK_CHECK;
  const say = (...parts) => console.log('task-check:', ...parts);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tasks = process.argv.slice(2).filter((arg, at, all) => !arg.startsWith('-') && all[at - 1] !== '--act' && !/\.[cm]?js$/.test(arg) && arg !== desktop);
  const list = tasks.length ? tasks : TASKS;

  // His window is never shown: its page runs all the same, and what's in front stays what a task works on. (Shown
  // without the focus it still lies over the other windows, and the driver takes the top window for the one in front.)
  const overlayShow = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.show = () => undefined;
  BrowserWindow.prototype.focus = () => undefined;
  BrowserWindow.prototype.showInactive = function () {
    // The overlays (the pill, the stop button) float above the windows and are shown this way; his own window isn't.
    if (!/\/home\/home\.html/.test(this.webContents.getURL())) overlayShow.call(this);
  };

  const stored = JSON.parse(fs.readFileSync(path.join(REAL, 'storage-local.json'), 'utf8'));
  fs.writeFileSync(
    path.join(scratch, 'storage-local.json'),
    JSON.stringify({
      // No vault, no mic, no camera, no watch, and this computer's model unticked: a saved model that fails shows.
      // No pictures of the window unless asked for (--pictures): taking one can bring up macOS's own "…is requesting
      // to bypass the system private window picker" dialog, which nobody is here to answer (2026-11-14: it did, and
      // every step after it failed).
      settings: { enabled: true, voiceEnabled: false, continuousAssistant: false, watchEnabled: false, gesturesEnabled: false, pointerEnabled: false, localModelUses: [], cameraDeviceId: '', longRange: false, agentScreenshots: process.argv.includes('--pictures') },
      // Sealed, as it is on disk (or as --act had it sealed again): the same keychain item opens it here.
      modelConnections: fs.existsSync(path.join(scratch, 'connections.sealed')) ? { sealed: fs.readFileSync(path.join(scratch, 'connections.sealed'), 'utf8') } : stored.modelConnections
    })
  );
  Object.assign(process.env, { JESTER_DATA_DIR: scratch, JESTER_FAKE_MEDIA: '1', JESTER_LOG: '1', JESTER_OPEN_SETTINGS: '1', JESTER_LINK_SOCKET: path.join(REAL, 'link.sock') });

  const SCREENS = process.argv.includes('--screens');
  if (SCREENS) process.env.JESTER_LOG_SCREENS = '1';
  const logFile = path.join(scratch, 'run.log');
  const logText = () => fs.readFileSync(logFile, 'utf8');
  const said = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(scratch, 'conversation.json'), 'utf8')).entries || [];
    } catch {
      return [];
    }
  };
  let home = null;
  const inPage = (code) => home.webContents.executeJavaScript(`(async () => { ${code} })()`, true);

  /** Types a task to him and waits for how it went: what he wrote back, and the app's own account of it. */
  async function run(task, limitMs = 240000) {
    const before = { lines: said().length, log: logText().length };
    const started = Date.now();
    await inPage(`await chrome.runtime.sendMessage({ type: 'jester/talk-type', text: ${JSON.stringify(task)} });`);
    let lines = [];
    let over = false;
    while (!over && Date.now() - started < limitMs) {
      await pause(500);
      lines = said().slice(before.lines).filter((entry) => entry.who === 'jester').map((entry) => entry.text);
      const log = logText().slice(before.log);
      // He hands a command on when his reply has a "do": then the first thing written is only "On it".
      const handed = /\[jester\] jester: \{[^\n]*"do":"[^"]/.test(log);
      over = lines.length >= (handed ? 2 : 1);
      // An answer that's a question (an approval, or not knowing what's meant) ends it too: nobody's here to answer.
      if (lines.at(-1)?.trim().endsWith('?') && Date.now() - started > 4000) over = true;
    }
    const log = logText().slice(before.log);
    // With --screens, the screens the model was shown come too (the app's JESTER_LOG_SCREENS): the user's own content.
    const trace = log.split('\n').filter((line) => /\[jester\] (?:assistant|voice:|jester:|talking|actions|learned|chrome link)/.test(line) || (SCREENS && /^\s*(?:\[\d+\]|#|-|\w+:)/.test(line) && !line.startsWith('['))).map((line) => line.replace('[jester] ', ''));
    const outcome = /assistant: .* → (done|not done|cancelled)/.exec(log)?.[1] || (/voice: Chrome (did it|didn’t|stopped)/.exec(log)?.[1] ?? '');
    return { task, lines, seconds: Math.round((Date.now() - started) / 100) / 10, timedOut: !over, outcome, trace };
  }

  const go = async () => {
    await import(path.join(desktop, 'src/main/main.js'));
    await app.whenReady();
    const end = Date.now() + 40000;
    while (!home && Date.now() < end) {
      home = BrowserWindow.getAllWindows().find((win) => /\/home\/home\.html/.test(win.webContents.getURL()) && !win.webContents.isLoading()) || null;
      if (!home) await pause(200);
    }
    if (!home) throw new Error('his window never opened');
    // The extension looks for the app every 30 seconds: a browser task needs it linked.
    const linkBy = Date.now() + 40000;
    let linked = false;
    while (!linked && Date.now() < linkBy) {
      linked = !!(await inPage(`return (await chrome.runtime.sendMessage({ type: 'jester/desktop-state' }))?.chrome?.linked;`).catch(() => false));
      if (!linked) await pause(1000);
    }
    say(`Chrome ${linked ? 'is linked' : 'did not link within 40 s: browser tasks will go to the desktop assistant'}`);
    const results = [];
    for (const task of list) {
      say(`\n=== ${task}`);
      const result = await run(task).catch((err) => ({ task, lines: [], seconds: 0, timedOut: false, outcome: `error: ${err.message}`, trace: [] }));
      results.push(result);
      // A question left waiting (an approval, "which one?") would take the next task for its answer: nobody's here
      // to say yes, so it's no, as it would be after a minute anyway.
      if (result.lines.at(-1)?.trim().endsWith('?')) {
        result.outcome = result.outcome || 'asked';
        const refused = await run('no', 20000).catch(() => null);
        result.trace.push(`(answered "no": ${JSON.stringify(refused?.lines.at(-1) ?? '')})`);
      }
      for (const line of result.trace) say(`   ${line.slice(0, 300)}`);
      say(`→ ${result.timedOut ? 'TIMED OUT' : result.outcome || 'answered'} in ${result.seconds} s: ${JSON.stringify(result.lines.at(-1) ?? '')}`);
      await pause(2500);
    }
    say('\n--- summary ---');
    for (const result of results) say(`${(result.timedOut ? 'timed out' : result.outcome || 'answered').padEnd(10)} ${String(result.seconds).padStart(6)} s  ${result.task}  →  ${JSON.stringify((result.lines.at(-1) ?? '').slice(0, 140))}`);
  };

  go()
    .catch((err) => say('failed:', err.stack || err.message))
    .finally(async () => {
      await pause(500);
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      app.exit(0);
    });
}
