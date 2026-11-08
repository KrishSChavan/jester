/**
 * How a model talks as Jester: given nineteen things people say to him (a
 * question, a joke, "open my Canvas and tell me what's due"), does it hand the
 * laptop a command when it should and only then, and how long does a turn take?
 * The persona prompt and request are the app's own (conversation.js).
 *
 *   npm run talk-check                         the saved models ticked for talking, and this computer's
 *   npm run talk-check -- saved-all            every saved model, ticked or not
 *   npm run talk-check -- ollama:qwen3.5:9b    one Ollama model
 *   npm run talk-check -- --trials 1 ...       each case once (3 by default)
 *
 * Saved models' keys are sealed with the Mac's keychain, so this runs in
 * Electron, as Jester: macOS may ask to let it use "Jester Safe Storage". Keys
 * are never printed. Each saved model gets 57 short requests (19 × 3), and a free
 * plan's per-minute pacing is waited out as in the app.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);

// Plain Node: start Electron with this script (minus VS Code's ELECTRON_RUN_AS_NODE).
if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, safeStorage } = await import('electron');
  const { askModel, LOCAL_KEEP_ALIVE, ollamaModels, pickModel } = await import('../src/main/conversation.js');
  const { createModelJob } = await import('../src/main/model-jobs.js');
  const { normaliseConnection } = await import('../../jester-extension/src/common/credentials.js');
  const { PROVIDERS } = await import('../../jester-extension/src/common/credentials.js');

  // Jester's keychain entry, but never its profile: the app may be running on that.
  app.setName('Jester');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jester-talk-check-')));
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));
  const trialsAt = process.argv.indexOf('--trials');
  const TRIALS = trialsAt > 0 ? Math.max(1, Number(process.argv[trialsAt + 1]) || 3) : 3;
  const wanted = args.length ? args : ['saved', 'local'];

  /** [what the user says, whether it should hand over a command, the conversation before it] */
  const CASES = [
    ["what's up?", false],
    ['what time is it?', false],
    ['Can you open up my canvas and tell me what assignments I have due by tomorrow night', true],
    ['Can you open up my canvas (bookmark) and tell me what assignments I have due by tomorrow night', true],
    ['open my Canvas bookmark and go to calendar and tell me what is due by tomorrow night', true],
    ['open my Canvas bookmark', true],
    ['check my email and tell me if Sarah replied', true],
    ["what's on my calendar today?", true],
    ["what's the weather here?", false],
    ['yes please', true, [['you', "what's the weather here?"], ['jester', "I can't check live weather, but I can search for today's forecast if you like."]]],
    ['play Gunna on Spotify', true],
    ['open Notes and write down milk and eggs', true],
    ['how do I boil an egg?', false],
    ['what can you do?', false],
    ['tell me a joke', false],
    ["what's 15 percent of 80?", false],
    ['thanks, that is all', false],
    ['play some music', true],
    ['write down that I need to call mom', true]
  ];

  /** The saved models, unsealed as the app does it. */
  function savedModels() {
    const file = path.join(os.homedir(), 'Library/Application Support/Jester/storage-local.json');
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')).modelConnections?.sealed;
    if (!sealed) return [];
    const list = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')));
    return list.flatMap((entry) => {
      try {
        return [{ id: entry.id, ...normaliseConnection(entry), cooldownUntil: 0 }];
      } catch {
        return [];
      }
    });
  }

  async function targets() {
    const found = [];
    for (const arg of wanted) {
      if (arg === 'saved' || arg === 'saved-all') {
        for (const connection of savedModels()) if (arg === 'saved-all' || connection.uses.includes('talk')) found.push(connection);
      } else if (arg === 'local') {
        const model = pickModel((await ollamaModels()).models);
        if (model) found.push({ id: 'ollama-local', ...normaliseConnection({ provider: 'ollama', model }) });
      } else if (arg.startsWith('ollama:')) {
        found.push({ id: arg, ...normaliseConnection({ provider: 'ollama', model: arg.slice('ollama:'.length) }) });
      } else console.log(`Not a model to check: ${arg}`);
    }
    return found;
  }

  const name = (connection) => `${PROVIDERS[connection.provider]?.label || connection.provider} · ${connection.model}`;
  const date = new Date();

  app.whenReady().then(async () => {
    const list = await targets().catch((err) => (console.log(`Couldn't read the saved models: ${err.message}`), []));
    if (!list.length) console.log('No model to check: tick Talking on one in Settings › Models, or name one (ollama:qwen3.5:9b).');
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
      console.log(`\n=== ${name(connection)}: ${CASES.length} cases × ${TRIALS} ===`);
      let right = 0;
      const times = [];
      let failed = 0;
      for (const [text, wantDo, history = []] of CASES) {
        const outs = [];
        for (let i = 0; i < TRIALS; i++) {
          const started = Date.now();
          try {
            const reply = await askModel({ request: job, text, history: history.map(([who, said]) => ({ who, text: said })), date });
            times.push(Date.now() - started);
            outs.push({ ...reply, ok: !!reply.do === wantDo });
          } catch (err) {
            failed += 1;
            outs.push({ error: err.message, ok: false });
          }
        }
        right += outs.filter((out) => out.ok).length;
        console.log(`${outs.filter((out) => out.ok).length}/${TRIALS} ${wantDo ? 'DO  ' : 'TALK'} ${text.slice(0, 72)}`);
        for (const out of outs.filter((out) => !out.ok)) console.log(`        ${out.error ? `error: ${out.error}` : `say ${JSON.stringify(out.say)}  do ${JSON.stringify(out.do)}`}`);
      }
      times.sort((a, b) => a - b);
      const line = `${name(connection)}: ${right}/${CASES.length * TRIALS} right · turn median ${times[times.length >> 1] ?? '-'} ms, slowest ${times.at(-1) ?? '-'} ms${failed ? ` · ${failed} failed` : ''}`;
      console.log(`--- ${line}`);
      summary.push(line);
    }
    if (summary.length > 1) console.log(`\n${summary.join('\n')}`);
    app.quit();
  });
}
