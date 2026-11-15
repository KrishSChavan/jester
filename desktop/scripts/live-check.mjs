/**
 * The real Jester, end to end, on a scratch profile: main.js and all it
 * starts, his window's own pages, and model servers that are this script's, so
 * what a model "says" and when it fails is scripted. What the unit tests take
 * on trust is checked here: that main.js wires the pieces together, and that
 * what's typed to him comes back through them.
 *
 *   npm run live-check              every scenario
 *   npm run live-check -- models    only the ones named
 *   npm run live-check -- tasks --shots <folder>    with pictures of his window saved there
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
 *   clock    a line due while he wasn't running is told when he starts, saying when it was for; one due while the
 *            screen's locked is held, and told a moment after it's unlocked; unlocking is the day's first sit-down
 *            once; and asked how long they've been at it, the model is given when they sat down.
 *   tasks    a timer set, asked after and cancelled on the user's own words with no model asked; a reminder the
 *            model asks for said back from what was kept, told when it's due, and ticked off by "done"; a wrong
 *            pick ticking nothing; a task nobody asked for not made; the list reaching the model when asked; and
 *            cards: a timer's under his line and on the shelf, a reminder's with Snooze, a note's with Open; and the
 *            Tasks screen: its cards, a box ticked by a click, and the count on its button.
 *   brief    a word before something on a calendar, by the clock's sum; the morning brief on sitting down, once, in
 *            the model's words when they keep to the facts and plainly when they don't; the evening's when asked;
 *            each with its card, and marked as holding a calendar's words.
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
  const { app, BrowserWindow, powerMonitor, safeStorage, shell } = await import('electron');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-live-'));
  // Presence looks every quarter second, and what's held is told half a second after they're back.
  Object.assign(process.env, { JESTER_DATA_DIR: scratch, JESTER_FAKE_MEDIA: '1', JESTER_DRIVER_DRY: '1', JESTER_LOG: '1', JESTER_NO_LINK: '1', JESTER_OPEN_SETTINGS: '1', JESTER_TICK_MS: '250', JESTER_SETTLE_MS: '500', JESTER_MORNING_ENDS: '24' });
  // A calendar this script serves, at an address nothing else answers: read through the app's own fetch.
  const feed = { url: 'https://calendar.jester.test/feed.ics', text: '' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input?.url ?? input).startsWith(feed.url) ? new Response(feed.text, { status: 200, headers: { 'content-type': 'text/calendar' } }) : realFetch(input, init));
  // Whether anyone's at the keys is this script's to say, not the real computer's: seconds since the last one.
  const keys = { idle: 1 };
  powerMonitor.getSystemIdleTime = () => keys.idle;
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

  const shotsAt = process.argv.indexOf('--shots');
  const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1] || '') : '';
  const wanted = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('-') && all[i - 1] !== '--shots');
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

  /** What he's said, as the conversation keeps it. */
  const his = () => said().filter((entry) => entry.who === 'jester').map((entry) => entry.text);
  const jobs = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(scratch, 'jobs.json'), 'utf8')).jobs;
    } catch {
      return null;
    }
  };

  /** A picture of his window as it stands, for looking at (--shots). Drawn opaque for the moment it takes. */
  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    home.setOpacity(1);
    await pause(700);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await home.webContents.capturePage()).toPNG());
    home.setOpacity(0.02);
  }
  const taskFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(scratch, 'tasks.json'), 'utf8')).tasks;
    } catch {
      return [];
    }
  };

  const SCENARIOS = {
    /** Step 8: timers on their own words, reminders through the model, only the user ticking off, and the panel. */
    async tasks({ paid }) {
      paid.answer = () => ({ say: 'This should not be said.', do: '', new: false });
      const asked = paid.requests.length;
      const set = await type('set a timer for ten minutes');
      const left = await type('how long is left on the timer?');
      check('a timer is set and asked after on their own words, with no model asked', set === '10 minutes, starting now.' && /^(?:10 minutes|9 minutes \d+ seconds) left on your 10 minute timer\.$/.test(left) && paid.requests.length === asked, `${set} · ${left} · model asked ${paid.requests.length - asked}`);
      check('and it’s on his clock', jobs()?.some((job) => job.kind === 'task') && taskFile().length === 1, JSON.stringify(jobs()));
      const cancelled = await type('cancel the timer');
      check('cancelled, it’s off the clock', /^Cancelled, with .+ left\.$/.test(cancelled) && !jobs()?.some((job) => job.kind === 'task') && taskFile().length === 0, `${cancelled} · ${JSON.stringify(jobs())}`);

      // A reminder: the model gives the task, and what he says is what was kept, not the model's own line.
      paid.answer = () => ({ say: 'Sure, I’ll remind you in an hour.', do: '', new: false, task: { op: 'add', text: 'call your mom', in: 5 } });
      const before = his().length;
      const kept = await type('remind me in two seconds to call my mom');
      check('a reminder is said back from what was kept, and its time from what they said, not the model’s five minutes', /^Okay, I’ll remind you at \d+:\d\d [AP]M: Call your mom\.$/.test(kept), kept);
      check('his prompt says how to ask for one, and that only they tick things off', /set "task" in your reply, leave "do" empty/.test(lastSystem(paid)) && /only they tick things off/.test(lastSystem(paid)));
      const rang = await until('the reminder', () => his().slice(before).find((line) => /^Reminder:/.test(line)), 10000).catch((err) => err.message);
      check('when it’s due he says so', rang === 'Reminder: call your mom.', rang);
      check('and it stays on the list, marked as given', taskFile().length === 1 && Number.isFinite(taskFile()[0].told) && !taskFile()[0].done, JSON.stringify(taskFile()));
      paid.answer = () => ({ say: 'Okay', do: '', new: false, task: { op: 'done' } });
      const done = await type('done');
      check('“done” right after it ticks it off', done === 'Ticked off: Call your mom.' && Number.isFinite(taskFile()[0]?.done), `${done} · ${JSON.stringify(taskFile())}`);
      check('and the model was shown the list for it', /The user’s to-do list, reminders and timers, which you keep/.test(lastSaid(paid)), lastSaid(paid).slice(0, 200));

      // Two by hand, in the panel's own way; then the model picks the wrong one to tick.
      await inPage(`await chrome.runtime.sendMessage({ type: 'jester/tasks', op: 'add', text: 'Buy stamps' }); await chrome.runtime.sendMessage({ type: 'jester/tasks', op: 'add', text: 'Email Sarah' });`);
      paid.answer = () => ({ say: 'Okay', do: '', new: false, task: { op: 'done', text: 'stamps' } });
      const wrong = await type('I finished the laundry');
      check('a wrong pick ticks nothing, and he asks', wrong === 'Do you mean “Buy stamps”? Say which one and I’ll tick it off.' && taskFile().filter((task) => task.done).length === 1, `${wrong}`);
      paid.answer = () => ({ say: 'Paris.', do: '', new: false, task: { op: 'add', text: 'learn capitals' } });
      const paris = await type('what’s the capital of France?');
      check('a task nobody asked for isn’t made', paris === 'Paris.' && taskFile().length === 3 && /a task nobody asked for wasn’t made/.test(logLines()), `${paris} · ${taskFile().length} tasks`);
      paid.answer = () => ({ say: 'I’ll remind you at six to water the plants.', do: '', new: false });
      const claimed = await type('remind me to water the plants at 6');
      check('saying it’s set with nothing set is owned up to', claimed === 'Sorry, that didn’t get set. Tell me again: what, and when?', claimed);
      check('the log says what was done to the list, never what’s on it', /tasks: added one with a time/.test(logLines()) && /tasks: one ticked off, by their saying so/.test(logLines()) && !/stamps|Sarah|your mom/.test(logLines().split('\n').filter((line) => /tasks:|"task"/.test(line)).join('\n')));

      // Cards: what he made, to look at and act on, on his line in the chat, on the shelf, and in the Tasks screen.
      await inPage(`window.jesterHome.go('main', { instant: true });`);
      await type('set a pasta timer for 8 minutes');
      const cardsIn = (where) => inPage(`return [...document.querySelectorAll('${where} .card')].map((el) => [el.querySelector('.label').textContent, el.querySelector('.title').textContent, el.querySelector('.detail')?.textContent || '', [...el.querySelectorAll('.act')].map((b) => b.title).join('+')].join(' | '));`);
      const onLine = await until('a card on his line', async () => (await cardsIn('#live-lines li:last-child')).find((card) => /^Timer.*left/.test(card))).catch(async () => (await cardsIn('#live-lines li:last-child')).join(' / '));
      check('what he set is a card under his line, counting down, with a way to cancel it', /^Timer \| Pasta timer \| \d:\d\d left \| Cancel$/.test(onLine), onLine);
      const shelf = await until('the shelf', async () => (await cardsIn('#shelf')).find((card) => /Pasta/.test(card)));
      check('and on the shelf over the orb while it runs', /^Timer \| Pasta timer \| \d:\d\d left \| Cancel$/.test(shelf) && !(await inPage(`return document.getElementById('shelf').hidden;`)), shelf);
      paid.answer = () => ({ say: 'Okay', do: '', new: false, task: { op: 'add', text: 'submit homework 5', at: new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA') } });
      await type('add submitting homework 5 to my list for three days from now');
      paid.answer = () => ({ say: 'Okay', do: '', new: false, task: { op: 'add', text: 'stretch', in: 1 } });
      const beforeRing = his().length;
      await type('remind me in two seconds to stretch');
      const ring = await until('the reminder', () => his().slice(beforeRing).find((line) => /^Reminder:/.test(line)), 10000).catch((err) => err.message);
      const given = await until('the reminder’s card', async () => (await cardsIn('#live-lines li:last-child')).find((card) => /^Reminder.*reminded/.test(card))).catch(async () => (await cardsIn('#live-lines li:last-child')).join(' / '));
      check('a reminder told comes with its card: tick it, snooze it or remove it', ring === 'Reminder: stretch.' && /^Reminder \| Stretch \| At \d+:\d\d [AP]M · reminded \| Snooze 10 min\+Remove$/.test(given), `${ring} · ${given}`);
      await shot('main');
      check('told once, not twice', his().filter((line) => line === 'Reminder: stretch.').length === 1, his().slice(beforeRing).join(' | '));
      await until('Snooze on its card', () => inPage(`const button = [...document.querySelectorAll('#live-lines .card')].filter((el) => el.querySelector('.title').textContent === 'Stretch').flatMap((el) => [...el.querySelectorAll('.act')]).find((b) => b.title === 'Snooze 10 min'); if (button) button.click(); return !!button;`));
      const snoozed = await until('the snooze kept', () => {
        const task = taskFile().find((item) => item.text === 'Stretch');
        return task && !task.told && task.due > Date.now() + 9 * 60000 ? task : null;
      }).catch((err) => err.message);
      check('Snooze on the card puts it off ten minutes, back on his clock', typeof snoozed === 'object' && jobs()?.some((job) => job.payload?.id === snoozed.id), JSON.stringify(snoozed));
      // A note he's asked to make: a card that opens it in Obsidian.
      const opened = [];
      shell.openExternal = async (url) => void opened.push(url);
      paid.answer = () => ({ say: 'Noted.', do: '', new: false, note: { title: 'Trip ideas', add: 'the coast road in spring' } });
      const noted = await type('make a note called trip ideas: the coast road in spring');
      const noteCard = await until('the note’s card', async () => (await cardsIn('#live-lines li:last-child')).find((card) => /^Note/.test(card))).catch((err) => err.message);
      check('a note he makes is a card with what was added, and Open', /^Made a note called Trip ideas/.test(noted) && noteCard === 'Note | Trip ideas | the coast road in spring | Open in Obsidian', `${noted} · ${noteCard}`);
      await inPage(`document.querySelector('#live-lines li:last-child .card .act').click();`);
      await until('Obsidian asked for it', () => opened.length).catch(() => undefined);
      check('Open opens that note in Obsidian', opened.length === 1 && /^obsidian:\/\/open\?vault=vault&file=Notes%2FTrip%20ideas$/.test(opened[0]), opened.join(' '));

      const badge = await inPage(`const b = document.getElementById('tasks-count'); return b.hidden ? '' : b.textContent;`);
      check('the button says how many are open', badge === '4', badge);
      await inPage(`window.jesterHome.go('tasks', { instant: true });`);
      const rows = await until('the Tasks screen’s cards', () => inPage(`const rows = [...document.querySelectorAll('#task-list > *')].map((el) => el.tagName === 'H2' ? '# ' + el.textContent : el.querySelector('.title').textContent + (el.querySelector('.detail') ? ' | ' + el.querySelector('.detail').textContent : '')); return rows.length > 8 ? rows : null;`));
      check('the Tasks screen shows the timer counting down, what’s open by when, what’s ticked off, and the note', rows[0] === '# Timers' && /^Pasta timer \| \d:\d\d left$/.test(rows[1]) && rows.includes('# Today') && rows.some((row) => /^Stretch \| At /.test(row)) && rows.includes('# Later') && rows.some((row) => /^Submit homework 5 \| On \w+/.test(row)) && rows.includes('# No date') && rows.includes('Buy stamps') && rows.includes('# Ticked off') && rows.includes('Call your mom') && rows.at(-2) === '# Notes, lately' && rows.at(-1) === 'Trip ideas | the coast road in spring', JSON.stringify(rows));
      await shot('tasks');
      await inPage(`[...document.querySelectorAll('#task-list .card')].find((row) => row.querySelector('.title').textContent === 'Buy stamps').querySelector('.tick').click();`);
      await until('the tick kept', () => taskFile().find((task) => task.text === 'Buy stamps')?.done);
      const after = await until('the card drawn again', () => inPage(`const row = [...document.querySelectorAll('#task-list .card')].find((el) => el.querySelector('.title').textContent === 'Buy stamps'); return row?.classList.contains('done') ? document.getElementById('tasks-count').textContent : null;`));
      check('a box ticked by a click is ticked, and the count drops', after === '3', after);
      // The timer's card in the chat, cancelled from there: every card of it says so.
      await inPage(`window.jesterHome.go('main', { instant: true });`);
      await inPage(`[...document.querySelectorAll('#live-lines .card')].find((el) => el.querySelector('.title').textContent === 'Pasta timer').querySelector('.act').click();`);
      const gone = await until('the timer gone', async () => (taskFile().some((task) => task.timer) ? null : await cardsIn('#live-lines'))).catch((err) => [err.message]);
      check('Cancel on a timer’s card cancels it, and its cards say it’s over', gone.some((card) => /^Timer \| Pasta timer \| Finished \| $/.test(card)) && (await cardsIn('#shelf')).every((card) => !/Pasta/.test(card)), JSON.stringify(gone));
      paid.answer = () => ({ say: 'Hello from paid.', do: '', new: false });
    },

    /** Step 9: a word before a class, the morning brief on sitting down, and the evening's when asked. */
    async brief({ paid }) {
      const setting = (patch) => inPage(`const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } });`);
      const entries = () => said().filter((entry) => entry.who === 'jester');
      const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      // A seminar that starts fifteen minutes and a few seconds from now: the word before it is due in those seconds.
      const start = Math.ceil((Date.now() + 15 * 60000 + 6000) / 1000) * 1000;
      feed.text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//jester//live-check//EN', 'BEGIN:VEVENT', 'UID:seminar-1', `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3600000)}`, 'SUMMARY:Seminar', 'LOCATION:Room 1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      const added = await inPage(`return chrome.runtime.sendMessage({ type: 'jester/desktop-day', op: 'calendar-add', url: ${JSON.stringify(feed.url)}, name: 'School' });`);
      check('a calendar is connected', added?.ok === true, JSON.stringify(added?.error || added));
      const before = entries().length;
      await setting({ checkIns: true });
      await until('the check-in on his clock', () => jobs()?.some((job) => job.kind === 'checkin'), 8000).catch(() => undefined);
      const due = jobs()?.find((job) => job.kind === 'checkin');
      check('a word before it is put on his clock, fifteen minutes ahead', due?.at === start - 15 * 60000 && due.keepFor === 15 * 60000, JSON.stringify(due));
      const word = await until('the check-in', () => entries().slice(before).find((entry) => /starts in/.test(entry.text)), 15000).catch((err) => ({ text: err.message }));
      check('and said when it comes, by the clock’s own sum, marked as holding a calendar’s words', /^Seminar starts in 1[45] minutes, at Room 1\.$/.test(word.text) && word.untrusted === true, JSON.stringify(word));

      // Said, it isn't put back on his clock for being still to come: whatever makes him look at the calendar again.
      await setting({ checkInMinutes: 15 });
      await inPage(`return chrome.runtime.sendMessage({ type: 'jester/desktop-day', op: 'calendar-refresh' });`);
      await pause(2500);
      check('and said once: it isn’t put back on the clock for the class being still to come', entries().filter((entry) => /starts in/.test(entry.text)).length === 1 && !jobs()?.some((job) => job.kind === 'checkin'), `${entries().filter((entry) => /starts in/.test(entry.text)).length} said · ${JSON.stringify(jobs()?.filter((job) => job.kind === 'checkin'))}`);
      // The morning brief: on sitting down, once, in the model's words when they keep to the facts.
      const clockOf = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
      const asked = [];
      paid.answer = (request) => {
        const system = request?.messages?.[0]?.content || '';
        if (!/morning brief|wrap-up of the day/.test(system)) return { say: 'Hello from paid.', do: '', new: false };
        asked.push({ system, facts: request.messages.at(-1).content });
        return { say: `Morning. Seminar is at ${clockOf(start)} in Room 1.` };
      };
      await setting({ briefMorning: true });
      const beforeBrief = entries().length;
      powerMonitor.emit('lock-screen');
      keys.idle = 600;
      await until('away', () => /presence: away \(locked\)/.test(logLines().split('\n').slice(-6).join('\n')));
      powerMonitor.emit('unlock-screen');
      keys.idle = 0;
      const brief = await until('the morning brief', () => entries().slice(beforeBrief).find((entry) => /^Morning\./.test(entry.text)), 15000).catch((err) => ({ text: err.message }));
      check('sat down, he gives the morning brief, in the model’s words', brief.text === `Morning. Seminar is at ${clockOf(start)} in Room 1.` && brief.untrusted === true, JSON.stringify(brief));
      check('from the facts alone, which the model is told are information', asked.length === 1 && new RegExp(`On their calendar today: Seminar at ${clockOf(start).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, at Room 1\\.`).test(asked[0].facts) && /Use only the facts below/.test(asked[0].system), asked[0]?.facts);
      check('with its card: the day’s facts, a line each', brief.card?.kind === 'brief' && /^Today, /.test(brief.card.title) && brief.card.lines?.some((line) => /Seminar/.test(line)), JSON.stringify(brief.card));
      const drawn = await until('the brief’s card in his window', () => inPage(`const card = [...document.querySelectorAll('#live-lines .card')].find((el) => el.querySelector('.label')?.textContent === 'Brief'); return card ? [...card.querySelectorAll('.facts li')].map((li) => li.textContent) : null;`)).catch((err) => [err.message]);
      check('drawn in his window', drawn.some((line) => /^On their calendar today: Seminar at /.test(line)), JSON.stringify(drawn));
      await shot('brief');
      powerMonitor.emit('lock-screen');
      keys.idle = 600;
      await pause(600);
      powerMonitor.emit('unlock-screen');
      keys.idle = 0;
      await pause(4000);
      check('and only once a day', entries().filter((entry) => /^Morning\./.test(entry.text)).length === 1 && /brief: the morning one given/.test(logLines()), `${entries().filter((entry) => /^Morning\./.test(entry.text)).length} briefs`);

      // Asked for, with a model that makes a time up: the facts are said plainly instead.
      paid.answer = (request) => (/morning brief/.test(request?.messages?.[0]?.content || '') ? { say: 'Morning. Seminar is at 3:07 AM, and it’s 99 degrees.' } : { say: 'Hello from paid.', do: '', new: false });
      const plainly = await type('brief me');
      check('a model that makes a time up isn’t said: the facts are, plainly', new RegExp(`^(?:Morning|Afternoon)\\. You’ve got Seminar at ${clockOf(start).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, at Room 1\\.`).test(plainly) && /said something the facts don’t/.test(logLines()), plainly);
      paid.answer = (request) => (/wrap-up of the day/.test(request?.messages?.[0]?.content || '') ? { say: 'That’s the day done.' } : { say: 'Hello from paid.', do: '', new: false });
      const wrap = await type('wrap up my day');
      check('the evening’s, when asked', wrap === 'That’s the day done.' || /^Nothing to wrap up/.test(wrap), wrap);
      await inPage(`window.jesterHome.go('settings/assistant', { instant: true });`);
      const switches = await until('the switches', () => inPage(`const on = (id) => document.getElementById(id)?.checked; return document.getElementById('eveningAt')?.value ? [on('briefMorning'), on('briefEvening'), on('checkIns'), document.getElementById('eveningAt').value] : null;`));
      check('Settings has their switches, as they stand, and the evening’s hour', JSON.stringify(switches) === JSON.stringify([true, false, true, '21:00']), JSON.stringify(switches));
      await inPage(`window.jesterHome.go('main', { instant: true });`);
      // Off again, and the calendar gone: the scenarios after this are left alone.
      await setting({ briefMorning: false, checkIns: false });
      paid.answer = () => ({ say: 'Hello from paid.', do: '', new: false });
    },

    /** Step 7: the clock catching up, a line held while they're away, the first sit-down, and how long they've sat. */
    async clock({ paid }) {
      const late = await until('the line due before he started', () => his().find((line) => /stand up and stretch/.test(line)), 20000).catch((err) => err.message);
      check('a line due an hour before he started is told once he has, saying when it was for', /^This was for (?:yesterday at )?\d+:\d\d [AP]M: Time to stand up and stretch\.$/.test(late), late);
      check('the log says they’re here, and that it’s the day’s first sit-down', /presence: here \(keys or mouse\), the day’s first sit-down/.test(logLines()), logLines().split('\n').filter((line) => /presence:|clock:|telling:/.test(line)).join(' | '));
      check('and that a line was told and how late, never what it said', /telling: a line, 6\d min late/.test(logLines()) && !/stretch/.test(logLines()));
      await until('the job gone from the clock', () => jobs()?.filter((job) => job.kind === 'say').length === 0).catch(() => undefined);
      check('told, it’s off the clock', jobs()?.filter((job) => job.kind === 'say').length === 0, JSON.stringify(jobs()));

      // The screen locks; a line comes due behind it.
      powerMonitor.emit('lock-screen');
      keys.idle = 600;
      await until('away', () => /presence: away \(locked\)/.test(logLines()));
      // Put on his clock the way anything of his would: there's no asking him for one by voice until reminders.
      const before = his().length;
      await inPage(`return chrome.runtime.sendMessage({ type: 'jester/desktop-clock', op: 'add', job: { kind: 'say', inMs: 300, payload: { text: 'Your laundry is done.' } } });`);
      await until('the line held', () => /telling: they’re away, so a line is held until they’re back/.test(logLines()));
      await pause(1500);
      check('due behind a locked screen, a line is held, not said', his().length === before && jobs()?.find((job) => job.kind === 'say')?.held === true, `${his().length - before} said · ${JSON.stringify(jobs())}`);
      powerMonitor.emit('unlock-screen');
      keys.idle = 0;
      const told = await until('the held line told', () => (his().length > before ? his().at(-1) : null), 8000).catch((err) => err.message);
      check('unlocked, it’s told a moment later', told === 'Your laundry is done.', told);
      check('unlocking is them, back, and not the day’s first sit-down again', /presence: here \(unlocked\), after /.test(logLines()) && logLines().match(/the day’s first sit-down/g)?.length === 1);

      paid.answer = () => ({ say: 'Since a moment ago.', do: '', new: false });
      await type('how long have I been at this?');
      check('asked how long they’ve been at it, the model is given when they sat down', /\[How long the user has been at this computer [^\n]*\n- This sitting: since \d+:\d\d [AP]M, which is under a minute\.\n- Before this sitting they were away from it for /.test(lastSaid(paid)), lastSaid(paid).slice(0, 300));
      await type('what should I have for lunch?');
      check('and not when they ask something else', !/at this computer/.test(lastSaid(paid)), lastSaid(paid).slice(0, 300));
      paid.answer = () => ({ say: 'Hello from paid.', do: '', new: false });
    },

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
        // His briefs and check-ins are off until their own scenario: nothing he says unasked lands in another's.
        settings: { enabled: false, voiceEnabled: false, continuousAssistant: false, watchEnabled: false, localModelUses: [], cameraDeviceId: '', longRange: false, memoryVault: vaultDir, briefMorning: false, briefEvening: false, checkIns: false },
        // The free one saved first: only its plan puts it second.
        modelConnections: [model('free', free, 'free'), model('paid', paid, 'paid')]
      })
    );
    // A conversation summed up 31 hours ago, as recollections.js keeps it: the sentence that became a class "in about an hour".
    fs.writeFileSync(path.join(scratch, 'recollections.json'), JSON.stringify({ conversations: [{ at: Date.now() - 31 * 3600000, summary: 'Provided current weather, time, and advised attending the upcoming class.', chat: 'earlier-chat' }] }));
    fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
    // A line that came due an hour ago, while he wasn't running.
    if (!wanted.length || wanted.includes('clock')) fs.writeFileSync(path.join(scratch, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'stretch', kind: 'say', made: Date.now() - 2 * 3600000, at: Date.now() - 3600000, payload: { text: 'Time to stand up and stretch.' } }] }));
    await import(path.join(desktop, 'src/main/main.js'));
    await app.whenReady();
    home = await until('his window', () => BrowserWindow.getAllWindows().find((win) => /\/home\/home\.html/.test(win.webContents.getURL()) && !win.webContents.isLoading()), 30000);
    await until('his window’s script', () => inPage(`return typeof chrome?.runtime?.sendMessage === 'function';`).catch(() => false));
    // The clock's first: the line due before he started is told as soon as he's free, which mustn't be in the
    // middle of another scenario's talk.
    const order = ['clock', ...Object.keys(SCENARIOS).filter((name) => name !== 'clock')];
    for (const [name, scenario] of order.map((name) => [name, SCENARIOS[name]])) {
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
