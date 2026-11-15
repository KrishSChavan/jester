/**
 * How Jester hears: his own speech service (speech/service.js: the voice
 * detector, the speaker model, the recognizer and voiceprint.js's rules), run
 * on audio from files rather than the mic.
 *
 *   npm run hear-check                  a made-up voice (macOS `say`): taught up close, then heard across a room,
 *                                       before and after it learns from use; and another voice, to be turned away
 *   npm run hear-check -- kept          what he wasn't sure of and kept (Settings › Assistant and voice › Keep what
 *                                       he wasn't sure of), each scored against the user's own voiceprint, with
 *                                       what was said: for telling which of them were the user after all
 *   npm run hear-check -- kept <folder> the same, for recordings somewhere else
 *   npm run hear-check -- pauses        a sentence said at its own speed: read at its last pause (`early`), over 0.6 s
 *                                       after the last word; and one with a pause in the middle, heard whole
 *
 * `kept` reads the user's sealed voiceprint as Jester does (Electron's safeStorage; macOS may ask to let it use
 * "Jester Safe Storage"), prints scores and words, and never the voiceprint. It decodes voices the app itself
 * wouldn't have (it turns strangers away undecoded): they're the user's own recordings, kept by their choice.
 *
 * The made-up voice says nothing about a real one's numbers; it checks that the pipeline does what the rules say:
 * a voice the voiceprint half-knows becomes theirs outright once it's been heard that way, and one it doesn't
 * know stays out whatever was learned.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(here), '..');
const RATE = 16000;

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, safeStorage, utilityProcess } = await import('electron');
  const { averageVoice, judged, MATCH, MAYBE, TEACHING_LINES, withLearned } = await import('../src/main/voiceprint.js');
  const { addressed } = await import('../src/main/wake.js');
  app.setName('Jester');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-hear-'));
  app.setPath('userData', scratch);
  app.dock?.hide();
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A WAV file's samples, 16 kHz mono, as the service takes them: 16-bit or float, the first channel. */
  function readWav(file) {
    const data = fs.readFileSync(file);
    let at = 12;
    let format = null;
    while (at + 8 <= data.length) {
      const id = data.toString('ascii', at, at + 4);
      const size = data.readUInt32LE(at + 4);
      if (id === 'fmt ') format = { tag: data.readUInt16LE(at + 8), channels: data.readUInt16LE(at + 10), rate: data.readUInt32LE(at + 12), bits: data.readUInt16LE(at + 22) };
      if (id === 'data' && format) {
        const bytes = format.bits / 8;
        const frames = Math.floor(Math.min(size, data.length - at - 8) / (bytes * format.channels));
        const samples = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          const offset = at + 8 + i * bytes * format.channels;
          samples[i] = format.bits === 32 ? data.readFloatLE(offset) : data.readInt16LE(offset) / 32768;
        }
        if (format.rate !== RATE) throw new Error(`${path.basename(file)} is ${format.rate} Hz, not ${RATE}`);
        return samples;
      }
      at += 8 + size + (size % 2);
    }
    throw new Error(`${path.basename(file)} isn't a WAV file this reads`);
  }

  /** The speech service, as speech.js starts it, with each thing it says handed to whoever's waiting. */
  function startService() {
    const child = utilityProcess.fork(path.join(desktop, 'src/main/speech/service.js'), [], { serviceName: 'Jester speech (hear-check)', stdio: 'pipe' });
    const waiting = [];
    /** Everything it says while a recording is being gone through (hearWhole), or null. */
    let gathered = null;
    child.stderr?.on('data', (chunk) => String(chunk).trim() && console.log('   service:', String(chunk).trim()));
    child.on('message', (message) => {
      if (gathered && ['heard', 'stranger', 'error', 'early', 'resumed'].includes(message?.type)) return void gathered.push({ ...message, at: performance.now() });
      const at = waiting.findIndex((want) => want.types.includes(message?.type));
      if (at >= 0) waiting.splice(at, 1)[0].resolve(message);
    });
    const next = (types, ms = 30000) =>
      new Promise((resolve, reject) => {
        const want = { types, resolve };
        waiting.push(want);
        setTimeout(() => {
          const still = waiting.indexOf(want);
          if (still >= 0) {
            waiting.splice(still, 1);
            reject(new Error(`the speech service never said ${types.join(' or ')}`));
          }
        }, ms);
      });
    const post = (message) => child.postMessage(message);
    return {
      post,
      next,
      /** One utterance in, as the mic would bring it, and how he took it: heard {…} or stranger {…}. */
      async hear(samples) {
        const answer = next(['heard', 'stranger', 'error']);
        const quiet = new Float32Array(RATE * 1.5);
        const all = new Float32Array(samples.length + quiet.length);
        all.set(samples);
        for (let at = 0; at < all.length; at += 1600) post({ type: 'audio', samples: all.slice(at, at + 1600) });
        return answer;
      },
      /**
       * A real recording, which he may take as two utterances, or as one he says nothing of (speech he couldn't
       * read): how he took the longest part of it, or {type:'nothing'}. It's given `ms` after the last thing he says.
       */
      async hearWhole(samples, ms = 1500) {
        gathered = [];
        const all = new Float32Array(samples.length + RATE * 1.5);
        all.set(samples);
        for (let at = 0; at < all.length; at += 1600) post({ type: 'audio', samples: all.slice(at, at + 1600) });
        for (let seen = -1, quiet = 0; quiet < ms; quiet += 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (gathered.length !== seen) quiet = 0;
          seen = gathered.length;
        }
        const said = gathered.filter((message) => !['early', 'resumed'].includes(message.type));
        gathered = null;
        return said.sort((a, b) => (b.seconds || 0) - (a.seconds || 0))[0] || { type: 'nothing' };
      },
      /**
       * An utterance at the speed it was said, as the mic brings it, then quiet: everything he says of it, each with
       * `after`, the milliseconds since its last sample went in.
       */
      async live(samples) {
        gathered = [];
        const all = new Float32Array(samples.length + RATE * 2);
        all.set(samples);
        const started = performance.now();
        let ended = 0;
        for (let at = 0; at < all.length; at += 1600) {
          post({ type: 'audio', samples: all.slice(at, at + 1600) });
          if (!ended && at + 1600 >= samples.length) ended = performance.now();
          // Kept to the clock, not to a count of waits: a late timer is caught up, as a mic's audio is.
          const due = started + ((at + 1600) / RATE) * 1000;
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
        }
        const said = gathered.map((message) => ({ ...message, after: Math.round(message.at - ended) }));
        gathered = null;
        return said;
      },
      /** What was said, whoever said it. */
      async words(samples) {
        const answer = next(['final', 'error']);
        post({ type: 'transcribe', samples });
        return (await answer).text || '';
      },
      stop: () => child.kill()
    };
  }

  const verdict = (message) => (message.type === 'stranger' ? 'not theirs' : message.type === 'nothing' ? 'no speech' : message.type === 'error' ? `error: ${message.detail}` : message.unsure ? 'maybe theirs' : 'theirs');
  const two = (value) => (typeof value === 'number' ? value.toFixed(2) : ' -  ');

  // --- a made-up voice -------------------------------------------------------------------------------------------

  /** A fixed-seed generator, so every run degrades the same way. */
  let seed = 20261114;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const level = (x) => Math.sqrt(x.reduce((sum, value) => sum + value * value, 0) / x.length);
  const noisy = (x, snrDb) => {
    const noise = level(x) / 10 ** (snrDb / 20);
    return x.map((value) => value + gauss() * noise);
  };
  /** A room: noise dying away over `rt60` seconds as its echo, `wet` of it against the voice itself. */
  function room(x, rt60, wet) {
    const taps = Math.floor(rt60 * RATE);
    const echo = new Float32Array(taps);
    for (let i = 0; i < taps; i++) echo[i] = gauss() * Math.exp((-6.9 * i) / taps);
    const size = Math.sqrt(echo.reduce((sum, value) => sum + value * value, 0));
    const out = new Float32Array(x.length);
    const step = 4;
    for (let i = 0; i < x.length; i++) {
      let sum = 0;
      for (let k = step; k < taps && k <= i; k += step) sum += x[i - k] * echo[k];
      out[i] = x[i] * (1 - wet) + (sum / size) * wet * Math.sqrt(step);
    }
    return out;
  }
  const acrossTheRoom = (x) => noisy(room(x, 0.4, 0.5), 20);
  function say(voice, text) {
    const file = path.join(scratch, `${voice}-${createHash('sha1').update(text).digest('hex').slice(0, 16)}.wav`);
    if (!fs.existsSync(file)) execFileSync('say', ['-v', voice, '-o', file, `--data-format=LEI16@${RATE}`, text]);
    return readWav(file);
  }

  async function madeUp() {
    if (process.platform !== 'darwin') throw new Error('the made-up voice needs macOS’s `say`');
    const [theirs, other] = ['Daniel', 'Karen'];
    const USE = ['Jester, what is the weather like outside right now?', 'Jester, open my Canvas bookmark and tell me what is due.', 'Jester, remind me to call my mom after class.', 'Jester, turn the volume down a little bit.', 'Hey Jester, how long should I boil an egg?', 'Jester, play some music while I finish this.'];
    const LATER = ['Jester, what time does my lecture start tomorrow?', 'Jester, write down milk and eggs on my grocery list.', 'Jester, what did we talk about yesterday afternoon?', 'Jester, tell me a joke about the ocean.', 'Jester, how far is it to the library from here?', 'Jester, set the volume to thirty percent.'];
    const service = startService();
    const ready = service.next(['ready', 'error'], 60000);
    service.post({ type: 'start', model: 'parakeet-110m' });
    console.log(`speech service: ${(await ready).model} loaded`);

    // Taught up close: five lines, as Settings has the user read them.
    service.post({ type: 'teaching', on: true });
    service.post({ type: 'listen' });
    const takes = [];
    for (const line of TEACHING_LINES) {
      const heard = await service.hear(say(theirs, line));
      if (heard.voice) takes.push(heard.voice);
    }
    if (takes.length < TEACHING_LINES.length) throw new Error(`only ${takes.length} of ${TEACHING_LINES.length} lines gave a voice`);
    const print = averageVoice(takes);
    service.post({ type: 'teaching', on: false });

    /** A run of utterances, with what's been learned so far; `learn`: keep what he says is worth keeping, as main.js does. */
    async function run(label, lines, voice, degrade, learned, { learn = false } = {}) {
      service.post({ type: 'voiceprint', print, learned });
      service.post({ type: 'listen' });
      await pause(50);
      const out = [];
      for (const line of lines) {
        const heard = await service.hear(degrade(say(voice, line)));
        const took = heard.type === 'heard' && addressed(heard.text).woken;
        if (learn && took && heard.learn && heard.voice) {
          learned = withLearned(learned, heard.voice);
          service.post({ type: 'voiceprint', print, learned });
        }
        out.push(heard);
        console.log(`   ${verdict(heard).padEnd(12)} ${two(heard.score)}${typeof heard.enrolled === 'number' && heard.score - heard.enrolled > 0.005 ? ` (${two(heard.enrolled)} by the voiceprint alone)` : ''}  ${heard.text ? JSON.stringify(heard.text) : ''}`);
      }
      const count = (kind) => out.filter((heard) => verdict(heard) === kind).length;
      console.log(`${label}: ${count('theirs')} theirs, ${count('maybe theirs')} maybe, ${count('not theirs')} turned away, of ${out.length}`);
      return { out, learned, theirs: count('theirs'), maybe: count('maybe theirs') };
    }

    console.log(`\n${theirs}, across the room, before anything's learned:`);
    const before = await run('before', LATER, theirs, acrossTheRoom, []);
    console.log(`\n${theirs}, across the room, a day's use (what's worth keeping is kept):`);
    const used = await run('in use', USE, theirs, acrossTheRoom, [], { learn: true });
    console.log(`   ${used.learned.length} ways of sounding learned`);
    console.log(`\n${theirs}, across the room, other sentences, after:`);
    const after = await run('after', LATER, theirs, acrossTheRoom, used.learned);
    console.log(`\n${other}, another voice, up close and across the room, with what was learned:`);
    const strangerNear = await run('another voice, up close', LATER.slice(0, 3), other, (x) => x, used.learned);
    const strangerFar = await run('another voice, across the room', LATER.slice(3), other, acrossTheRoom, used.learned);
    service.stop();

    const checks = [
      ['the voice taught is heard as theirs at least as often once it’s learned from use', after.theirs >= before.theirs && after.theirs + after.maybe >= before.theirs + before.maybe, `before ${before.theirs}, after ${after.theirs}`],
      ['another voice is never taken as theirs, whatever was learned', strangerNear.theirs + strangerFar.theirs === 0, `${strangerNear.theirs + strangerFar.theirs} taken as theirs`],
      ['what’s said is still read right across the room', after.out.filter((heard) => heard.type === 'heard' && addressed(heard.text).woken).length >= Math.min(after.theirs + after.maybe, 4), 'his name was lost in what was heard']
    ];
    console.log('');
    for (const [name, ok, detail] of checks) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `: ${detail}`}`);
    console.log(`\nheard as theirs across the room: ${before.theirs}/${LATER.length} before, ${after.theirs}/${LATER.length} after learning ${used.learned.length} ways of sounding`);
    return checks.every(([, ok]) => ok);
  }

  // --- pauses ----------------------------------------------------------------------------------------------------

  /**
   * At a pause that may be the end of what's being said, he reads it and says so (`early`), so thinking can start;
   * it's only over (`heard`) once the pause has lasted, and if they go on instead he says that (`resumed`).
   */
  async function pauses() {
    if (process.platform !== 'darwin') throw new Error('this needs macOS’s `say`');
    const service = startService();
    const ready = service.next(['ready', 'error'], 60000);
    service.post({ type: 'start', model: 'parakeet-110m' });
    await ready;
    service.post({ type: 'listen' });
    await pause(50);
    const quiet = (seconds) => new Float32Array(Math.round(RATE * seconds));
    const join = (...parts) => {
      const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    /** `say` leaves quiet at each end of what it renders: the voice alone, so a pause here is the pause given. */
    const voiced = (x) => {
      const loud = (value) => Math.abs(value) > 0.01;
      let from = 0;
      let to = x.length;
      while (from < to && !loud(x[from])) from += 1;
      while (to > from && !loud(x[to - 1])) to -= 1;
      return x.slice(from, to);
    };
    const one = voiced(say('Daniel', 'Jester, what is the weather like outside right now?'));
    const first = voiced(say('Daniel', 'Jester, remind me to call my mom'));
    const second = voiced(say('Daniel', 'after my class ends tomorrow afternoon.'));
    const told = (events) => events.map((event) => `${event.type}${event.type === 'heard' && event.early ? ' (as read at the pause)' : ''} at ${event.after} ms${event.text ? ` ${JSON.stringify(event.text)}` : ''}`).join('\n      ');

    console.log('\nOne sentence, then quiet:');
    const plain = await service.live(one);
    console.log(`      ${told(plain)}`);
    console.log('\nA sentence with a 0.45 s pause in the middle of it:');
    const broken = await service.live(join(first, quiet(0.45), second));
    console.log(`      ${told(broken)}`);
    service.stop();

    const early = plain.find((event) => event.type === 'early');
    const heard = plain.find((event) => event.type === 'heard');
    const kinds = broken.map((event) => event.type);
    const whole = broken.findLast((event) => event.type === 'heard');
    const checks = [
      ['a sentence is read at its last pause, before it’s over', !!early && !!heard && early.after < heard.after, 'no `early` before `heard`'],
      ['and those are the words it’s heard as, with nothing read twice', !!early && heard?.early === true && heard.text === early.text, `early ${JSON.stringify(early?.text)}, heard ${JSON.stringify(heard?.text)}`],
      ['it’s over 0.6 s after the last word, with no reading left to wait for', !!heard && heard.after >= 500 && heard.after <= 800, `${heard?.after} ms`],
      ['a pause mid-sentence is read, and then they’re heard going on', kinds.indexOf('early') >= 0 && kinds.indexOf('resumed') > kinds.indexOf('early'), kinds.join(', ')],
      ['and the sentence is heard whole, once, both halves of it', broken.filter((event) => event.type === 'heard').length === 1 && /m[ou]m/i.test(whole?.text || '') && /tomorrow/i.test(whole?.text || ''), JSON.stringify(whole?.text)]
    ];
    console.log('');
    for (const [name, ok, detail] of checks) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `: ${detail}`}`);
    return checks.every(([, ok]) => ok);
  }

  // --- what was kept ---------------------------------------------------------------------------------------------

  async function kept(folder) {
    const dir = folder ? path.resolve(folder) : path.join(os.homedir(), 'Library/Application Support/Jester/heard');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.wav')).sort() : [];
    if (!files.length) {
      console.log(`Nothing kept in ${dir}. Turn on Settings › Assistant and voice › Keep what he wasn’t sure of, and talk to him for a while.`);
      return true;
    }
    const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Jester/storage-local.json'), 'utf8'));
    const unseal = (key) => (typeof stored[key]?.sealed === 'string' ? JSON.parse(safeStorage.decryptString(Buffer.from(stored[key].sealed, 'base64'))) : null);
    const print = unseal('voiceprint');
    if (!print) throw new Error('no voiceprint: teach him your voice in Settings › Assistant and voice first');
    const learned = unseal('voiceLearned') || [];
    const service = startService();
    const ready = service.next(['ready', 'error'], 60000);
    service.post({ type: 'start', model: 'parakeet-110m' });
    await ready;
    service.post({ type: 'voiceprint', print, learned });
    service.post({ type: 'listen' });
    console.log(`${files.length} kept in ${dir}; ${learned.length} ways of sounding learned so far. MATCH ${MATCH}, MAYBE ${MAYBE}.\n`);
    console.log('then          now           score  alone  secs  said (his name?)');
    const rows = [];
    for (const file of files) {
      const samples = readWav(path.join(dir, file));
      let then = {};
      try {
        then = JSON.parse(fs.readFileSync(path.join(dir, file.replace(/\.wav$/, '.json')), 'utf8'));
      } catch {
        /* no note beside it */
      }
      const heard = await service.hearWhole(samples);
      // Whoever it was: these are the user's own recordings, and whether it was them is the question.
      const text = heard.text || (await service.words(samples));
      const named = addressed(text).woken;
      rows.push({ score: heard.score ?? 0, named, now: verdict(heard) });
      console.log(`${String(then.who === 'maybe' ? 'maybe theirs' : then.who === 'stranger' ? 'not theirs' : then.who || '?').padEnd(13)} ${verdict(heard).padEnd(13)} ${two(heard.score)}   ${two(heard.enrolled)}   ${(samples.length / RATE).toFixed(1).padStart(4)}  ${named ? '★ ' : '  '}${JSON.stringify(text.slice(0, 90))}`);
    }
    service.stop();
    const withName = rows.filter((row) => row.named);
    const scores = (list) => (list.length ? `${Math.min(...list.map((row) => row.score)).toFixed(2)}–${Math.max(...list.map((row) => row.score)).toFixed(2)}` : 'none');
    console.log(`\n★ with his name (most likely the user, to him): ${withName.length} of ${rows.length}, scoring ${scores(withName)}; ${withName.filter((row) => row.now === 'not theirs').length} of them turned away as things stand.`);
    console.log(`Without his name: ${rows.length - withName.length}, scoring ${scores(rows.filter((row) => !row.named))}.`);
    return true;
  }

  app.whenReady().then(async () => {
    let ok = false;
    try {
      ok = args[0] === 'kept' ? await kept(args[1]) : args[0] === 'pauses' ? await pauses() : await madeUp();
    } catch (err) {
      console.log(`hear-check failed: ${err.message}`);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(ok ? 0 : 1);
  });
}
