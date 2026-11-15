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
 *   npm run speed-check -- --no-voice           without Puter: only the model's part
 *
 * What it leaves out is the same either way: the 0.6 s pause that ends an utterance and reading it (the app's log
 * says "heard … after the last word" for each real turn), and what his memory and the weather take, which have no
 * vault or calendars here.
 *
 * Saved models' keys and the Puter sign-in are sealed with the Mac's keychain, so this runs in Electron, as Jester:
 * macOS may ask to let it use "Jester Safe Storage". Neither is ever printed. A run is 14 short requests to each
 * model and about 20 lines to Puter's voice (some 2,500 characters of its monthly allowance).
 */

import { spawn } from 'node:child_process';
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
  const { app, safeStorage } = await import('electron');
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
  const VOICE = !process.argv.includes('--no-voice');
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

  app.whenReady().then(async () => {
    const list = await targets().catch((err) => (console.log(`Couldn't read the saved models: ${err.message}`), []));
    if (!list.length) console.log('No model to check: tick Talking on one in Settings › Models, or name one (ollama:qwen3.5:9b).');
    const token = VOICE ? unsealed('puterToken') : null;
    console.log(token ? 'Voice: Puter’s, fetched for real and not played.' : 'Voice: none (Puter isn’t signed in, or --no-voice): only the model’s part is timed.');
    const summary = [];
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
          token: async () => token,
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
