/**
 * How long he takes to start answering, from his words being heard to the first sound of his voice: the app's own
 * conversation (conversation.js), the saved model he talks through, and Puter's real voice, with the sound thrown
 * away rather than played. Every line is said to him both ways, so the difference is this run's own:
 *
 *   before   as the app asked until 2026-11-14: the whole reply waited for, Claude held to the reply's schema
 *   now      the reply read as it's written, his first sentence said while the rest comes, Claude asked plainly
 *
 *   npm run speed-check                         the saved models ticked for talking
 *   npm run speed-check -- saved:anthropic      one provider's saved models
 *   npm run speed-check -- ollama:qwen3.5:9b    one Ollama model
 *   npm run speed-check -- --rounds 3           each line three times each way (once by default)
 *   npm run speed-check -- --voice              with Puter's real voice fetched for each line (see the cost below)
 *   npm run speed-check -- --spoken             said aloud instead (macOS `say`, into his real speech service at the
 *                                               speed it's said): from the last word to his voice, with and without
 *                                               starting on the reply at a pause that may be the end (thinkAhead)
 *
 * What it leaves out is the same either way: the 0.6 s pause that ends an utterance and reading it (the app's log
 * says "heard … after the last word" for each real turn), and what his memory and the weather take, which have no
 * vault or calendars here.
 *
 * Saved models' keys and the Puter sign-in are sealed with the Mac's keychain, so this runs in Electron, as Jester:
 * macOS may ask to let it use "Jester Safe Storage". Neither is ever printed. A run is 14 short requests to each
 * model.
 *
 * Puter's voice is left out unless asked for (--voice), and then a run fetches some 20 lines, 2,500–7,000 characters
 * of a free account's 31,000 a month: on 2026-11-15 a night of these runs used up what the user had left, and he
 * spoke in the Mac's own voice until the month turned. Without it the voice's part isn't in the times (it was
 * 0.35–0.45 s a line, whatever its length, when measured). With it, a refusal from Puter is said, never timed as
 * if it were the voice.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);

/** Said to him by gesture or watch tap, so with no name: things he answers himself, in a sentence or in three. */
const LINES = [
  'how are you doing today',
  'tell me a joke',
  'explain what dynamic programming is',
  'what’s a good way to study for an algorithms midterm',
  'what can you do',
  'what should I make for dinner tonight',
  'play some Gunna on Spotify'
];

if (!process.versions.electron) {
  // Plain Node: start Electron on this script, without VS Code's ELECTRON_RUN_AS_NODE.
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, safeStorage, utilityProcess } = await import('electron');
  const { askModel, createConversation, LOCAL_KEEP_ALIVE, ollamaModels, pickModel } = await import('../src/main/conversation.js');
  const { createModelJob } = await import('../src/main/model-jobs.js');
  const { createSpeaker } = await import('../src/main/speaker.js');
  const { synthesize } = await import('../src/main/puter.js');
  const { normaliseConnection, PROVIDERS } = await import('../../jester-extension/src/common/credentials.js');

  // Jester's keychain entry, but never its profile: the app may be running on that.
  app.setName('Jester');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jester-speed-check-')));
  const roundsAt = process.argv.indexOf('--rounds');
  const ROUNDS = roundsAt > 0 ? Math.max(1, Number(process.argv[roundsAt + 1]) || 1) : 1;
  const VOICE = process.argv.includes('--voice');
  /** Puter refusing (its allowance run out, signed out): said once, since the times after it have no voice in them. */
  let refused = '';
  const voiceTrouble = (trouble) => {
    if (!trouble || refused) return;
    refused = trouble;
    console.log(`   ! Puter’s voice refused (${trouble}): from here the voice’s part isn’t in the times.`);
  };
  const args = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && all[i - 1] !== '--rounds' && !arg.endsWith('.mjs'));
  const wanted = args.length ? args : ['saved'];

  const stored = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Jester/storage-local.json'), 'utf8'));
  const unsealed = (name) => {
    const sealed = stored()[name]?.sealed;
    return sealed ? JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))) : null;
  };
  const savedModels = () =>
    (unsealed('modelConnections') || []).flatMap((entry) => {
      try {
        return [{ id: entry.id, ...normaliseConnection(entry), cooldownUntil: 0 }];
      } catch {
        return [];
      }
    });

  async function targets() {
    const found = [];
    for (const arg of wanted) {
      if (arg === 'saved') found.push(...savedModels().filter((connection) => connection.uses.includes('talk')));
      else if (arg.startsWith('saved:')) found.push(...savedModels().filter((connection) => connection.provider === arg.slice('saved:'.length)));
      else if (arg === 'local') {
        const model = pickModel((await ollamaModels()).models);
        if (model) found.push({ id: 'ollama-local', ...normaliseConnection({ provider: 'ollama', model }) });
      } else if (arg.startsWith('ollama:')) found.push({ id: arg, ...normaliseConnection({ provider: 'ollama', model: arg.slice('ollama:'.length) }) });
      else console.log(`Not a model to check: ${arg}`);
    }
    return found;
  }

  const name = (connection) => `${PROVIDERS[connection.provider]?.label || connection.provider} · ${connection.model}`;
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[sorted.length >> 1] : NaN;
  };
  const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)}`.padStart(5) : '    -');

  // --- said aloud ------------------------------------------------------------------------------------------------

  const RATE = 16000;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-speed-said-'));
  /** A line in a Mac voice, as 16 kHz samples, with the quiet `say` leaves at each end taken off. */
  function said(text) {
    const file = path.join(scratch, `${createHash('sha1').update(text).digest('hex').slice(0, 16)}.wav`);
    if (!fs.existsSync(file)) execFileSync('say', ['-v', 'Daniel', '-o', file, `--data-format=LEI16@${RATE}`, text]);
    const data = fs.readFileSync(file);
    let at = 12;
    while (at + 8 <= data.length && data.toString('ascii', at, at + 4) !== 'data') at += 8 + data.readUInt32LE(at + 4) + (data.readUInt32LE(at + 4) % 2);
    const frames = Math.floor(Math.min(data.readUInt32LE(at + 4), data.length - at - 8) / 2);
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = data.readInt16LE(at + 8 + i * 2) / 32768;
    let from = 0;
    let to = samples.length;
    while (from < to && Math.abs(samples[from]) <= 0.01) from += 1;
    while (to > from && Math.abs(samples[to - 1]) <= 0.01) to -= 1;
    return samples.slice(from, to);
  }

  /**
   * Each line said aloud to his real speech service, at the speed it's said, and answered by the app's conversation
   * through the model and Puter's voice: how long after the last word his voice begins, thinking ahead and not.
   */
  async function spoken(connection, token) {
    if (process.platform !== 'darwin') throw new Error('--spoken needs macOS’s `say`');
    const local = connection.provider === 'ollama';
    const job = createModelJob({ job: 'talk', saved: async () => (local ? [] : [{ ...connection, uses: ['talk'] }]), local: async () => ({ model: local ? connection.model : '', uses: ['talk'] }), keepAlive: LOCAL_KEEP_ALIVE, markLimited: async () => undefined });
    const service = utilityProcess.fork(path.join(path.dirname(here), '../src/main/speech/service.js'), [], { serviceName: 'Jester speech (speed-check)', stdio: 'pipe' });
    let onMessage = () => undefined;
    service.on('message', (message) => onMessage(message));
    await new Promise((resolve, reject) => {
      onMessage = (message) => (message?.type === 'ready' ? resolve() : message?.type === 'error' ? reject(new Error(message.detail)) : undefined);
      service.postMessage({ type: 'start', model: 'parakeet-110m' });
    });

    async function turn(line, ahead) {
      const samples = said(`Jester, ${line}`);
      const at = { heard: NaN, sound: NaN };
      let ended = 0;
      let log = '';
      const sound = async () => {
        if (!Number.isFinite(at.sound)) at.sound = performance.now() - ended;
      };
      const conversation = createConversation({
        chat: (request) => askModel({ ...request, request: job }),
        speaker: createSpeaker({ token: async () => (refused ? null : token), onTrouble: voiceTrouble, synthesize, play: sound, stopPlaying: () => undefined, system: { say: sound, stop: () => undefined } }),
        memory: { add: () => undefined, current: () => [], idleFor: () => 0, startNew: () => [] },
        recollections: { keep: async () => undefined, relevant: () => [] },
        commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
        assistant: { asking: false, running: false },
        show: () => undefined,
        abilities: () => ({ voice: true, chrome: true }),
        thinkAhead: () => ahead,
        log: (...parts) => parts[0] === 'turn:' && (log = parts.slice(1).join(' '))
      });
      const answered = new Promise((resolve) => {
        const limit = setTimeout(resolve, 20000);
        onMessage = (message) => {
          if (message?.type === 'early') conversation.paused(message.text, { unsure: !!message.unsure });
          else if (message?.type === 'resumed') conversation.wentOn();
          else if (message?.type === 'heard') {
            at.heard = performance.now() - ended;
            Promise.resolve(conversation.heard(message.text, { lag: message.afterMs })).then(() => (clearTimeout(limit), resolve()));
          }
        };
      });
      service.postMessage({ type: 'listen' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // As a mic brings it: a tenth of a second at a time, kept to the clock, then quiet.
      const all = new Float32Array(samples.length + RATE * 2);
      all.set(samples);
      const started = performance.now();
      for (let from = 0; from < all.length; from += 1600) {
        service.postMessage({ type: 'audio', samples: all.slice(from, from + 1600) });
        if (!ended && from + 1600 >= samples.length) ended = performance.now();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + ((from + 1600) / RATE) * 1000 - performance.now())));
      }
      await answered;
      onMessage = () => undefined;
      return { ...at, log };
    }

    console.log(`\n=== ${name(connection)}, said aloud: ${LINES.length - 1} lines, each way ===`);
    console.log('   not ahead: heard  voice |  ahead: heard  voice | sooner');
    await turn(LINES[0], false).catch(() => undefined);
    const rows = [];
    // The last line is a command, which is never begun on at a pause.
    for (const [i, line] of LINES.slice(0, -1).entries()) {
      const got = {};
      for (const ahead of i % 2 ? [true, false] : [false, true]) got[ahead] = await turn(line, ahead);
      rows.push(got);
      console.log(`              ${ms(got.false.heard)}  ${ms(got.false.sound)} |         ${ms(got.true.heard)}  ${ms(got.true.sound)} | ${ms(got.false.sound - got.true.sound)} ms  ${line.slice(0, 40)}`);
      console.log(`                 ${got.true.log}`);
    }
    service.kill();
    const before = median(rows.map((row) => row.false.sound));
    const now = median(rows.map((row) => row.true.sound));
    const line = `${name(connection)}, said aloud: his voice starts ${Math.round(now)} ms after the last word thinking ahead (median of ${rows.length}), ${Math.round(before)} ms without: ${Math.round(before - now)} ms sooner`;
    console.log(`--- ${line}`);
    return line;
  }

  app.whenReady().then(async () => {
    const list = await targets().catch((err) => (console.log(`Couldn't read the saved models: ${err.message}`), []));
    if (!list.length) console.log('No model to check: tick Talking on one in Settings › Models, or name one (ollama:qwen3.5:9b).');
    const token = VOICE ? unsealed('puterToken') : null;
    console.log(token ? 'Voice: Puter’s, fetched for real and not played.' : `Voice: none (${VOICE ? 'Puter isn’t signed in' : 'add --voice for Puter’s, which spends its monthly allowance'}): only the model’s part is timed.`);
    const summary = [];
    if (process.argv.includes('--spoken')) {
      for (const connection of list) summary.push(await spoken(connection, token).catch((err) => `${name(connection)}: ${err.message}`));
      if (summary.length > 1 || summary.some((line) => !line.includes('said aloud:'))) console.log(`\n${summary.join('\n')}`);
      return app.quit();
    }
    for (const connection of list) {
      const local = connection.provider === 'ollama';
      const job = createModelJob({
        job: 'talk',
        saved: async () => (local ? [] : [{ ...connection, uses: ['talk'] }]),
        local: async () => ({ model: local ? connection.model : '', uses: ['talk'] }),
        keepAlive: LOCAL_KEEP_ALIVE,
        markLimited: async () => undefined
      });
      /** One turn, said by gesture: when his reply was in and when his voice began, from when the words were heard. */
      async function turn(line, mode) {
        const at = { first: NaN, reply: NaN, sound: NaN };
        let started = 0;
        let said = '';
        const speaker = createSpeaker({
          token: async () => (refused ? null : token),
          onTrouble: voiceTrouble,
          synthesize,
          play: async () => {
            if (!Number.isFinite(at.sound)) at.sound = performance.now() - started;
          },
          stopPlaying: () => undefined,
          system: {
            say: async () => {
              if (!Number.isFinite(at.sound)) at.sound = performance.now() - started;
            },
            stop: () => undefined
          }
        });
        const conversation = createConversation({
          chat: async (request) => {
            const before = mode === 'before';
            const reply = await askModel({
              ...request,
              request: before ? (options) => job({ ...options, plain: false }) : job,
              onFirst: before ? null : (sentence, whole) => ((at.first = performance.now() - started), request.onFirst?.(sentence, whole))
            });
            at.reply = performance.now() - started;
            said = reply.say;
            return reply;
          },
          speaker,
          memory: { add: () => undefined, current: () => [], idleFor: () => 0, startNew: () => [] },
          recollections: { keep: async () => undefined, relevant: () => [] },
          commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
          assistant: { asking: false, running: false },
          show: () => undefined,
          abilities: () => ({ voice: true, chrome: true })
        });
        started = performance.now();
        await conversation.told(line);
        return { ...at, said };
      }

      console.log(`\n=== ${name(connection)}: ${LINES.length} lines × ${ROUNDS}, each way ===`);
      console.log('        before: reply  voice |    now: first  reply  voice | sooner');
      // One turn first, uncounted: the prompt's cache, and a model on this computer loading.
      await turn(LINES[0], 'now').catch(() => undefined);
      const rows = [];
      for (let round = 0; round < ROUNDS; round++) {
        for (const line of LINES) {
          try {
            // Alternating which goes first, so neither way always gets the other's warmed cache.
            const order = (rows.length + round) % 2 ? ['now', 'before'] : ['before', 'now'];
            const got = {};
            for (const mode of order) got[mode] = await turn(line, mode);
            const { before, now } = got;
            rows.push({ before, now });
            console.log(`                ${ms(before.reply)}  ${ms(before.sound)} |         ${ms(now.first)}  ${ms(now.reply)}  ${ms(now.sound)} | ${ms(before.sound - now.sound)} ms  ${line.slice(0, 44)}`);
          } catch (err) {
            console.log(`                failed: ${String(err.message).slice(0, 120)}  (${line.slice(0, 40)})`);
          }
        }
      }
      const before = median(rows.map((row) => row.before.sound));
      const now = median(rows.map((row) => row.now.sound));
      const line = `${name(connection)}: his voice starts ${Math.round(now)} ms after he hears you (median of ${rows.length}), where it was ${Math.round(before)} ms: ${Math.round(before - now)} ms sooner · reply whole at ${Math.round(median(rows.map((row) => row.now.reply)))} ms, where it was ${Math.round(median(rows.map((row) => row.before.reply)))} ms`;
      console.log(`--- ${line}`);
      summary.push(line);
    }
    if (summary.length > 1) console.log(`\n${summary.join('\n')}`);
    app.quit();
  });
}
