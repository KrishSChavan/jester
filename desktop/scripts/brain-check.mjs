/**
 * How a model carries a turn with Jester's tools (mcp/tools.js, brain.js): given what people say to him, does it
 * choose the right place to do it (a text is Messages', a show is the browser's), say a few words of its own
 * before it starts, ask at a fork instead of guessing, keep the answer, and say what happened in its own words
 * rather than read out what the task wrote? The first cases are the user's own from 2026-11-21: a text to Dad that
 * went to a website, and a Hulu profile picked by a guess.
 *
 * The conversation is the app's own (conversation.js), with a real model and pretend hands: nothing is opened,
 * typed, sent or searched. Each case scripts what the hands "did" and what the user "answered".
 *
 *   npm run brain-check                       the saved Claude models ticked for talking
 *   npm run brain-check -- saved:anthropic    every saved Claude model
 *   npm run brain-check -- --match hulu       only the cases whose name matches
 *   npm run brain-check -- --trials 3         each case three times (once by default)
 *   npm run brain-check -- --show             what he said and called each time, not only when it was wrong
 *
 * Saved models' keys are sealed with the Mac's keychain, so this runs in Electron, as Jester (see talk-check.mjs).
 * Keys are never printed. A run of every case once costs about a cent on Claude Haiku.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, safeStorage } = await import('electron');
  const { createConversation } = await import('../src/main/conversation.js');
  const { createModelJob } = await import('../src/main/model-jobs.js');
  const { createWays } = await import('../src/main/ways.js');
  const { costOf, dollars } = await import('../src/main/spend.js');
  const { normaliseConnection, PROVIDERS } = await import('../../jester-extension/src/common/credentials.js');
  const { supportsTools } = await import('../../jester-extension/src/background/model-client.js');

  app.setName('Jester');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jester-brain-check-')));
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : '');
  const TRIALS = Math.max(1, Number(value('--trials')) || 1);
  const MATCH = value('--match') ? new RegExp(value('--match'), 'i') : null;
  const SHOW = flag('--show');
  const wanted = args.filter((arg, i) => !arg.startsWith('--') && !['--trials', '--match'].includes(args[i - 1]));

  /** Lines no person would say: what a task or a tool wrote, read out. */
  const MACHINE = /A control is not responding|say [“"]?keep going|Waiting for your OK|Typed “|Switched to |· |STALE_|unsupported actions|\bDone\. |Not done\.|tool_result|use_browser|use_computer|send_message|ask_user|\b(?:the|a|my) tools?\b/i;
  const STOCK = /^(?:on it|okay|ok|sure|done)[.!]?$/i;

  /**
   * @typedef {object} Case
   * @property {string} name
   * @property {string} said
   * @property {string[]} [ways]  how they like things done, kept before this
   * @property {{who:string, text:string}[]} [history]
   * @property {(object|null)[]} [outcomes]  what the hands come to, in order
   * @property {(string|null)[]} [answers]  what the user answers him, in order
   * @property {boolean} [unnamed]  overheard, without his name
   * @property {(seen:object) => string[]} check  what's wrong with how it went, or []
   */
  const first = (seen) => seen.calls[0]?.name || '';
  const called = (seen, name) => seen.calls.filter((call) => call.name === name);
  const usual = (seen) => [
    ...seen.said.filter((line) => MACHINE.test(line)).map((line) => `read out what a tool wrote: ${JSON.stringify(line)}`),
    ...seen.said.filter((line) => STOCK.test(line.trim())).map((line) => `a stock line: ${JSON.stringify(line)}`),
    ...(seen.said.some((line) => /[*#`]|^\s*[-•]\s/m.test(line)) ? ['markdown or a list in what he says'] : [])
  ];
  /** @type {Case[]} */
  const CASES = [
    {
      name: 'text Dad (the 2026-11-21 failure)',
      said: 'text Dad: how are you doing?',
      outcomes: [{ ok: true, text: 'Typed “how are you doing?” in “Message” · Waiting for your OK' }],
      check: (seen) => [
        ...(first(seen) === 'send_message' ? [] : [`first tool was ${first(seen) || 'none'}, not send_message`]),
        ...(/dad/i.test(called(seen, 'send_message')[0]?.input.to || '') ? [] : ['send_message not addressed to Dad']),
        ...(/how are you doing/i.test(called(seen, 'send_message')[0]?.input.text || '') ? [] : ['the words to send were lost']),
        ...(called(seen, 'use_browser').length ? ['took a text to the browser'] : []),
        ...(seen.said.length >= 2 ? [] : ['nothing was said before it started']),
        ...(seen.said.length >= 2 && /^(?:texting|starting|sending)/i.test(seen.said[1]) ? ['said he’d started twice'] : [])
      ]
    },
    {
      name: 'Hulu, two profiles (the 2026-11-21 failure)',
      said: 'go to Hulu and start playing Modern Family',
      outcomes: [{ ok: false, text: 'I couldn’t get past the profile screen on Hulu. It shows two profiles: Krish and Sandeep Chavan.' }, { ok: true, text: 'Playing Modern Family, season 5 episode 17.' }],
      answers: ['Krish'],
      check: (seen) => [
        ...(first(seen) === 'use_browser' ? [] : [`first tool was ${first(seen) || 'none'}, not use_browser`]),
        ...(called(seen, 'ask_user').length === 1 ? [] : [`asked ${called(seen, 'ask_user').length} questions, not one`]),
        ...((called(seen, 'ask_user')[0]?.input.options || []).some((option) => /krish/i.test(option)) && (called(seen, 'ask_user')[0]?.input.options || []).some((option) => /sandeep/i.test(option)) ? [] : ['the question didn’t offer both profiles']),
        ...(seen.ways.some((line) => /hulu/i.test(line) && /krish/i.test(line)) ? [] : ['the choice wasn’t kept']),
        ...(called(seen, 'use_browser').length === 2 && /krish/i.test(called(seen, 'use_browser')[1].input.task) ? [] : ['didn’t go on with the Krish profile']),
        ...(seen.ran.length === 2 ? [] : [`the hands were used ${seen.ran.length} times, not twice`])
      ]
    },
    {
      name: 'Hulu, with the profile already chosen',
      said: 'put Modern Family on Hulu',
      ways: ['Hulu profile: Krish'],
      outcomes: [{ ok: true, text: 'Playing Modern Family.' }],
      check: (seen) => [...(first(seen) === 'use_browser' ? [] : [`first tool was ${first(seen) || 'none'}`]), ...(called(seen, 'ask_user').length ? ['asked, though they’d already said'] : [])]
    },
    {
      name: 'a machine’s failure isn’t read out',
      said: 'open my Canvas and tell me what’s due this week',
      outcomes: [{ ok: false, text: 'A control is not responding. Adjust the page and say “keep going”.' }],
      check: (seen) => [...(first(seen) === 'use_browser' ? [] : [`first tool was ${first(seen) || 'none'}, not use_browser`]), ...(seen.said.length >= 2 ? [] : ['said nothing of how it went'])]
    },
    {
      name: 'they put him right after a failure',
      said: 'use my account, the Krish one',
      history: [{ who: 'you', text: 'go to Hulu and start playing Modern Family' }, { who: 'jester', text: 'Let me pull up Hulu.' }, { who: 'jester', text: 'Hulu stopped at the profile screen, and I wasn’t sure which one is yours. Whose should I use?' }],
      outcomes: [{ ok: true, text: 'Playing Modern Family.' }],
      check: (seen) => [
        ...(called(seen, 'use_browser').length === 1 && /krish/i.test(called(seen, 'use_browser')[0].input.task) && /modern family/i.test(called(seen, 'use_browser')[0].input.task) ? [] : ['didn’t take the task up again with the Krish profile']),
        ...(seen.ways.some((line) => /krish/i.test(line)) ? [] : ['the choice wasn’t kept']),
        ...(called(seen, 'ask_user').length ? ['asked again'] : [])
      ]
    },
    { name: 'a message with nothing to say yet', said: 'message Trisha', outcomes: [{ ok: true, text: 'A new message to Trisha Patel is open in Messages, with nothing written.' }], check: (seen) => [...(['send_message', 'ask_user'].includes(first(seen)) || (!seen.calls.length && /\?/.test(seen.said.join(' '))) ? [] : [`first tool was ${first(seen) || 'none'}`])] },
    {
      name: 'a message on a service that isn’t Messages',
      said: 'send Sam a message on WhatsApp saying I’m running late',
      check: (seen) => [...(called(seen, 'send_message').length ? ['took WhatsApp to Messages'] : []), ...(seen.calls.some((call) => ['use_computer', 'use_browser', 'ask_user'].includes(call.name)) ? [] : ['did nothing with it'])]
    },
    { name: 'an app by name', said: 'open Spotify and play some Gunna', outcomes: [{ ok: true, text: 'Playing Gunna on Spotify' }], check: (seen) => [...(first(seen) === 'use_computer' ? [] : [`first tool was ${first(seen) || 'none'}, not use_computer`])] },
    { name: 'loose isn’t unclear', said: 'play some music', outcomes: [{ ok: true, text: 'Playing your Daily Mix on Spotify' }], check: (seen) => [...(called(seen, 'ask_user').length ? ['asked what music'] : []), ...(first(seen) === 'use_computer' ? [] : [`first tool was ${first(seen) || 'none'}`])] },
    { name: 'the computer’s own files', said: 'open the second file in my Downloads', outcomes: [{ ok: true, text: 'Opened “Lab 4.pdf”.' }], check: (seen) => [...(first(seen) === 'use_computer' ? [] : [`first tool was ${first(seen) || 'none'}`])] },
    { name: 'something recent', said: 'who won the Penn State game last night?', outcomes: [{ ok: true, text: 'Penn State beat Rutgers 31 to 17.', answer: 'Penn State beat Rutgers 31 to 17 on Saturday night.', sources: [{ title: 'ESPN', url: 'https://www.espn.com/x' }] }], check: (seen) => [...(first(seen) === 'search_web' ? [] : [`first tool was ${first(seen) || 'none'}, not search_web`]), ...(/31|rutgers/i.test(seen.said.join(' ')) ? [] : ['didn’t give the answer'])] },
    { name: 'their own notes', said: 'what did I write down about the DS 320 exam?', check: (seen) => [...(['search_notes', ''].includes(first(seen)) ? [] : [`first tool was ${first(seen)}`]), ...(/lab 2|8:15|practice/i.test(seen.said.join(' ')) ? [] : ['didn’t answer from the note'])] },
    { name: 'their notes, searched for', said: 'look in my notes for what the landlord said about the lease', check: (seen) => [...(first(seen) === 'search_notes' ? [] : [`first tool was ${first(seen) || 'none'}, not search_notes`]), ...(/june|renew/i.test(seen.said.join(' ')) ? [] : ['didn’t answer from the note'])] },
    { name: 'a reminder', said: 'remind me to call my mom tomorrow at 3 pm', check: (seen) => [...(first(seen) === 'set_task' && called(seen, 'set_task')[0].input.op === 'add' ? [] : [`first tool was ${first(seen) || 'none'}, not set_task add`]), ...(seen.said.some((line) => /I’ll remind you/.test(line)) ? [] : ['what was set wasn’t said'])] },
    { name: 'a list is a note', said: 'add eggs and milk to my grocery list', check: (seen) => [...(first(seen) === 'write_note' ? [] : [`first tool was ${first(seen) || 'none'}, not write_note`])] },
    { name: 'just talk', said: 'ugh, long day. I bombed my stats quiz.', check: (seen) => [...(seen.calls.length ? [`called ${seen.calls.map((call) => call.name).join(', ')}`] : []), ...(seen.said.join(' ').split(/\s+/).length <= 60 ? [] : ['too long to say aloud'])] },
    { name: 'a question about what he can do', said: 'can you text people for me?', check: (seen) => [...(seen.calls.length ? [`called ${seen.calls.map((call) => call.name).join(', ')}`] : []), ...(/yes|can|sure|absolutely/i.test(seen.said.join(' ')) ? [] : ['didn’t say he can'])] },
    { name: 'a sum', said: 'what’s 12 times 14?', check: (seen) => [...(seen.calls.length ? [`called ${seen.calls.map((call) => call.name).join(', ')}`] : []), ...(/168/.test(seen.said.join(' ')) ? [] : ['wrong'])] },
    { name: 'overheard, to someone else', said: 'dude pass me the controller, it’s my turn', unnamed: true, history: [{ who: 'you', text: 'what time is it' }, { who: 'jester', text: 'Just after nine.' }], check: (seen) => [...(seen.said.length ? [`answered: ${JSON.stringify(seen.said[0])}`] : [])] },
    { name: 'overheard, a follow-up', said: 'and what about tomorrow?', unnamed: true, history: [{ who: 'you', text: 'what’s the weather today' }, { who: 'jester', text: 'Clear and 38, warming to 63 this afternoon.' }], check: (seen) => [...(seen.said.length || seen.calls.length ? [] : ['stayed quiet at a follow-up'])] }
  ];

  function savedModels() {
    const file = path.join(os.homedir(), 'Library/Application Support/Jester/storage-local.json');
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')).modelConnections?.sealed;
    if (!sealed) return [];
    return JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))).flatMap((entry) => {
      try {
        return [{ id: entry.id, ...normaliseConnection(entry), cooldownUntil: 0 }];
      } catch {
        return [];
      }
    });
  }

  /** One case, carried through the app's own conversation with a real model and pretend hands. */
  async function carry(job, test, spent) {
    const outcomes = [...(test.outcomes || [])];
    const answers = [...(test.answers || [])];
    const seen = { said: [], calls: [], ran: [], asked: [], before: false, firstMs: null, ms: 0, error: '' };
    const entries = (test.history || []).map((entry) => ({ ...entry }));
    const data = {};
    const ways = createWays({ storage: { get: async (key) => (key in data ? { [key]: data[key] } : {}), set: async (values) => void Object.assign(data, values) } });
    for (const line of test.ways || []) await ways.set(line.split(': ')[0], line.split(': ').slice(1).join(': '));
    const started = performance.now();
    const conversation = createConversation({
      chat: async () => ({ say: '(asked the old way: tools weren’t used)', do: '' }),
      speaker: { say: async (line) => void seen.said.push(line), stop: () => undefined },
      memory: { add: (who, text) => entries.push({ who, text }), take: (who, text) => entries.at(-1)?.who === who && entries.at(-1).text === text && (entries.pop(), true), current: () => entries.map((entry) => ({ ...entry })), idleFor: () => null, startNew: () => [] },
      recollections: { keep: async () => undefined, relevant: () => [] },
      knowsYou: () => true,
      commands: {
        knows: async () => false,
        risky: async () => false,
        run: async (text, said, context, more) => {
          if (!seen.ran.length) seen.before = seen.said.length > 0;
          seen.ran.push({ text, more });
          return { outcome: outcomes.length ? outcomes.shift() : { ok: true, text: 'Done.' } };
        }
      },
      assistant: { asking: false, running: false, asked: null, answer: () => undefined, cancel: () => undefined, confirm: async () => true, inquire: async (asked) => (seen.asked.push(asked), answers.length ? answers.shift() : null) },
      vaultMemory: {
        ready: () => true,
        // What a turn recalls by itself, before their words; and what only a search of the notes finds.
        recall: async (query, history) => (/ds ?320|exam/i.test(query) ? { block: '[Notes/DS 320.md (4 days ago): Exam tonight at 8:15 PM. It leans on Lab 2, HW1 and HW2. Do the practice exam first.]', used: [{ rel: 'Notes/DS 320.md' }] }
          : /landlord|lease/i.test(query) && Array.isArray(history) && !history.length && !/look in my notes/i.test(query) ? { block: '[Notes/Apartment.md (2 weeks ago): The landlord said the lease renews in June unless we give notice by April 1.]', used: [{ rel: 'Notes/Apartment.md' }] }
          : { block: '', used: [] }),
        remember: async () => ({ ok: true, title: 'Kept' }),
        note: async ({ title, add }) => ({ ok: true, text: `Added “${add}” to ${title}.`, rel: `Notes/${title}.md`, title }),
        forget: async () => ({ text: 'Forgotten.', count: 1 })
      },
      tasks: { wanted: () => true, direct: async () => '', touched: () => null, asked: (said) => /remind|timer|to-?do|list/i.test(said), apply: async (task) => `I’ll remind you ${task.at ? `on ${task.at}` : 'then'}: ${task.text}.`, undone: () => '' },
      abilities: () => ({ computer: 'Mac', chrome: true, web: true, os: 'macOS' }),
      show: () => undefined,
      brain: {
        ready: async () => true,
        ask: async (request) => {
          const got = await job({ ...request, onText: (raw) => { seen.firstMs ??= performance.now() - started; request.onText?.(raw); } });
          for (const call of got.calls || []) seen.calls.push(call);
          const cost = costOf({ provider: got.provider, model: got.model, usage: got.usage });
          if (cost !== null) spent.usd += cost;
          spent.calls += 1;
          return got;
        }
      },
      ways,
      log: (...parts) => /couldn’t be used/.test(parts.join(' ')) && (seen.error = parts.join(' '))
    });
    try {
      if (test.unnamed) {
        // As a voice sure to be theirs, seconds after he spoke: open to a follow-up without his name.
        await conversation.announce((test.history || []).at(-1)?.text || 'Yes?');
        entries.pop();
        // That line was the scene being set, not his answer.
        seen.said.length = 0;
        await conversation.heard(test.said, { startedAt: Date.now() });
      } else await conversation.told(test.said);
    } catch (err) {
      seen.error = err.message;
    }
    seen.ms = performance.now() - started;
    seen.ways = ways.lines();
    return seen;
  }

  app.whenReady().then(async () => {
    const all = savedModels();
    const list = (wanted.includes('saved:anthropic') ? all.filter((connection) => connection.provider === 'anthropic') : all.filter((connection) => connection.uses?.includes('talk'))).filter(supportsTools);
    if (!list.length) console.log('No saved model that takes tools is ticked for talking (Settings › Models): Claude does.');
    const cases = CASES.filter((test) => !MATCH || MATCH.test(test.name) || MATCH.test(test.said));
    for (const connection of list) {
      const spent = { usd: 0, calls: 0 };
      const job = createModelJob({ job: 'talk', saved: async () => [{ ...connection, uses: ['talk'] }], local: async () => ({ model: '', uses: [] }), keepAlive: '2m', markLimited: async () => undefined });
      console.log(`\n${PROVIDERS[connection.provider]?.label || connection.provider} · ${connection.model}`);
      let right = 0;
      let total = 0;
      const firsts = [];
      for (const test of cases) {
        for (let trial = 0; trial < TRIALS; trial += 1) {
          const seen = await carry(job, test, spent);
          const wrong = [...(seen.error ? [seen.error] : []), ...usual(seen), ...test.check(seen)];
          total += 1;
          if (!wrong.length) right += 1;
          if (seen.firstMs !== null) firsts.push(seen.firstMs);
          console.log(`  ${wrong.length ? '✗' : '✓'} ${test.name}  (${Math.round(seen.ms)} ms${seen.firstMs !== null ? `, first words ${Math.round(seen.firstMs)} ms` : ''})`);
          for (const why of wrong) console.log(`      ${why}`);
          if (SHOW || wrong.length) {
            console.log(`      said: ${JSON.stringify(seen.said)}`);
            if (seen.calls.length) console.log(`      called: ${seen.calls.map((call) => `${call.name}${JSON.stringify(call.input)}`).join(' · ')}`);
            if (seen.asked.length) console.log(`      asked: ${JSON.stringify(seen.asked)}`);
            if (seen.ways?.length) console.log(`      kept: ${JSON.stringify(seen.ways)}`);
          }
        }
      }
      firsts.sort((a, b) => a - b);
      console.log(`  ${right}/${total} right · ${spent.calls} requests · ${spent.usd ? dollars(spent.usd) : 'cost unknown'}${firsts.length ? ` · first words: median ${Math.round(firsts[Math.floor(firsts.length / 2)])} ms` : ''}`);
    }
    app.quit();
  });
}
