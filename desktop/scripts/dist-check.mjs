/**
 * `npm run dist-check`: the packaged Jester (npm run dist), started for real on a scratch profile, and what his log
 * says of it. It's what tells an installed copy from one that only built: that his code loads from the app's folder,
 * the extension's pages are served from beside it, the helper built for this platform answers, and that he fetches
 * and unpacks what he hears with into a folder with his settings. The GitHub workflow runs it on the Mac and the
 * Windows build before either is published, which is the only place the Windows one is ever started.
 *
 *   npm run dist-check                      pretend models from this script's own server: quick, and no download
 *   npm run dist-check -- --models <dir>    real models already on this computer: he must load them and listen
 *   npm run dist-check -- --real-models     fetch the real ones (about 500 MB) as a new user's would, then listen
 *   npm run dist-check -- --app <path>      another copy than dist/'s (the executable, or a .app)
 *
 * Nothing of the user's is touched: a data folder under the system's temp one, no camera or mic (JESTER_FAKE_MEDIA),
 * no real input (JESTER_DRIVER_DRY), no link to Chrome, and windows that open faint and unfocused (JESTER_QUIET).
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_SET, MODEL_FILES, modelPath } from '../src/main/speech/model-fetch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const real = args.includes('--real-models');
const given = option('--models') ? path.resolve(option('--models')) : '';
const mac = process.platform === 'darwin';

function findApp() {
  const asked = option('--app');
  if (asked) return asked.endsWith('.app') ? path.join(asked, 'Contents/MacOS/Jester') : path.resolve(asked);
  if (mac) return path.join(root, `dist/mac-${process.arch}/Jester.app/Contents/MacOS/Jester`);
  return path.join(root, 'dist/win-unpacked/Jester.exe');
}

const exe = findApp();
if (!fs.existsSync(exe)) {
  console.error(`No packaged Jester at ${exe}. Run: npm run dist -- --dir`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-dist-'));
const logFile = path.join(scratch, 'logs', 'jester.log');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pretend models, named and packed as the real ones are, served from here. */
async function pretendModels() {
  const folder = path.join(scratch, 'served');
  fs.mkdirSync(folder, { recursive: true });
  for (const key of FIRST_SET) {
    const model = MODEL_FILES[key];
    if (model.file) {
      fs.writeFileSync(path.join(folder, model.file), `pretend ${key}`);
      continue;
    }
    const name = model.archive.replace(/\.tar\.bz2$/, '');
    fs.mkdirSync(path.join(folder, name), { recursive: true });
    fs.writeFileSync(path.join(folder, name, 'tokens.txt'), `pretend ${key}`);
    execFileSync('tar', ['-cjf', model.archive, name], { cwd: folder });
    fs.rmSync(path.join(folder, name), { recursive: true });
  }
  const server = http.createServer((request, response) => {
    const file = path.join(folder, path.basename(decodeURIComponent(request.url.split('?')[0])));
    if (!fs.existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// He's set to listen, as someone who's pressed the microphone under the orb has him: with real models, that loads them.
const listens = real || !!given;
fs.writeFileSync(path.join(scratch, 'storage-local.json'), JSON.stringify({ settings: { enabled: true, voiceEnabled: true, continuousAssistant: listens, gesturesEnabled: true } }));

const served = real || given ? null : await pretendModels();
const env = {
  ...process.env,
  JESTER_DATA_DIR: scratch,
  JESTER_QUIET: '1',
  JESTER_FAKE_MEDIA: '1',
  JESTER_DRIVER_DRY: '1',
  JESTER_NO_LINK: '1',
  ...(given ? { JESTER_MODELS_DIR: given, JESTER_NO_MODEL_FETCH: '1' } : { JESTER_FETCH_MODELS: '1' }),
  ...(served ? { JESTER_MODELS_URL: served.url } : {})
};
delete env.ELECTRON_RUN_AS_NODE;
if (!given) delete env.JESTER_MODELS_DIR;

const models = given || path.join(scratch, 'models');
const fetched = given ? [] : FIRST_SET.map((key) => ({ name: `he fetched ${key}`, line: new RegExp(`models: fetched ${key}$`, 'm'), file: modelPath(key, models) }));
/** What his log has to say, and (`soft`) what's only noted: a build machine has no graphics card worth the name. */
const wanted = [
  { name: 'he started as an installed app', line: /Jester \d+\.\d+\.\d+, installed · / },
  { name: 'his helper answered (jester-driver)', line: /driver: \d+\.\d+\.\d+ on \w+, describing input/ },
  { name: 'the extension’s engine page loaded and reported', line: /^\[jester\] status \w+/m },
  ...fetched,
  ...(listens ? [{ name: 'he’s listening', line: /continuous assistant: listening/ }, { name: 'the recognizer loaded (sherpa-onnx)', line: /speech loaded: / }] : []),
  { name: 'the engine is running on the pretend camera', line: /^\[jester\] status running/m, soft: true },
  ...(listens ? [{ name: 'his own voice loaded (Kokoro)', line: /voice loaded: Kokoro/, soft: true }] : [])
];
/** What it must never say. */
const never = [/ERR_MODULE_NOT_FOUND/, /Cannot find module/, /is not built/, /speech service exited/, /voice service exited/];

const limit = Date.now() + (real ? 20 * 60 * 1000 : 90 * 1000);
console.log(`Starting ${path.relative(root, exe) || exe}\n  data in ${scratch}${served ? `\n  pretend models from ${served.url}` : given ? `\n  models in ${given}` : '\n  fetching the real models'}`);
let output = '';
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));
let exited = null;
child.on('exit', (code, signal) => (exited = signal || code));

const read = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
const met = (log) => wanted.filter((want) => !want.soft).every((want) => want.line.test(log) && (!want.file || fs.existsSync(want.file)));
let log = '';
let lastSaid = '';
while (Date.now() < limit && exited === null) {
  await pause(500);
  log = read();
  const progress = /models: fetch(?:ing|ed) [^\n]*/g.exec(log.split('\n').reverse().join('\n'))?.[0] || '';
  if (real && progress && progress !== lastSaid) console.log(`  ${(lastSaid = progress)}`);
  if (met(log)) {
    // A moment more, for what's only noted and for anything that falls over just after starting.
    await pause(listens ? 8000 : 3000);
    log = read();
    break;
  }
}

if (exited === null) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      child.kill();
    }
  } else child.kill('SIGTERM');
  for (let waited = 0; exited === null && waited < 5000; waited += 100) await pause(100);
  if (exited === null) child.kill('SIGKILL');
}
served?.close();

let failed = false;
console.log('');
for (const want of wanted) {
  const ok = want.line.test(log) && (!want.file || fs.existsSync(want.file));
  if (!ok && !want.soft) failed = true;
  console.log(`${ok ? '  ok  ' : want.soft ? ' note ' : ' FAIL '} ${want.name}${!ok && want.file && want.line.test(log) ? ` (but ${want.file} isn’t there)` : ''}`);
}
for (const bad of never) {
  const where = bad.exec(log) || bad.exec(output);
  if (!where) continue;
  failed = true;
  console.log(` FAIL  it said: ${where[0]}`);
}
if (failed || args.includes('--log')) {
  console.log(`\n— his log (${logFile}):\n${log.split('\n').slice(0, 120).join('\n') || '(nothing)'}`);
  if (output.trim()) console.log(`\n— what he printed:\n${output.trim().split('\n').slice(-40).join('\n')}`);
}
if (!args.includes('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
else console.log(`\nKept: ${scratch}`);
console.log(failed ? '\nThe packaged Jester did not start as it should.' : '\nThe packaged Jester starts.');
process.exit(failed ? 1 : 0);
