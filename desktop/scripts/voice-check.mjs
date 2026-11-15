/**
 * How Jester sounds, and how soon: his real voice (kokoro.js and voice/service.js,
 * Kokoro on this computer) making the kinds of line he says, as the speaker
 * makes them (a sentence at a time: speaker.js), each then read back by his own
 * recognizer to see that the words are there.
 *
 *   npm run voice-check                    every line: how long until its first sound, and what the recognizer heard
 *   npm run voice-check -- --voice lewis   another of the voices (voice/voices.js)
 *   npm run voice-check -- --play          played aloud as well (macOS), for a person's ear
 *   npm run voice-check -- "Any line."     a line of your own
 *
 * Nothing is sent anywhere and it costs nothing: both models run here. Reading it
 * back catches words dropped, figures left unsaid and a voice that makes no sound;
 * whether he sounds pleasant only an ear can say (`--play`).
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(here), '..');

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, utilityProcess } = await import('electron');
  const { startKokoro } = await import('../src/main/kokoro.js');
  const { runsOn, spokenLine, spokenPieces } = await import('../src/main/speaker.js');
  const { kokoroInstalled, kokoroThreads, voiceNamed } = await import('../src/main/voice/voices.js');
  const { pickModel } = await import('../src/main/speech/models.js');
  app.setName('Jester');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-voice-'));
  app.setPath('userData', scratch);
  app.dock?.hide();

  const flags = process.argv.slice(2);
  const flag = (name) => flags.includes(name);
  const named = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
  const own = flags.filter((arg, index) => !arg.startsWith('--') && flags[index - 1] !== '--voice');

  /** The kinds of thing he says: short, long, with figures, names and a list. `hear`: what must be heard back. */
  const LINES = own.length
    ? own.map((say) => ({ say, hear: [] }))
    : [
        { say: 'Done.', hear: ['done'] },
        { say: 'Good evening, sir.', hear: ['good', 'evening'] },
        { say: 'It’s ten past four.', hear: ['ten', 'past', 'four'] },
        { say: 'It’s 4:10 PM, and 72 degrees outside.', hear: ['four', 'ten', 'seventy', 'degrees'] },
        { say: 'You have 3 things on your to-do list: the lab report, laundry, and calling Dr. Patel.', hear: ['three', 'list', 'lab', 'report', 'laundry', 'patel'] },
        { say: 'I’ve put milk and eggs on your shopping list, and the weather looks clear until this evening. Anything else?', hear: ['milk', 'eggs', 'shopping', 'weather', 'clear', 'evening', 'anything', 'else'] },
        { say: 'Your exam is tomorrow morning at nine. You asked me to remind you to bring your calculator, and the bus leaves at ten past eight from the usual stop.', hear: ['exam', 'tomorrow', 'nine', 'calculator', 'bus', 'eight', 'stop'] },
        { say: 'Dynamic programming is a way of solving a big problem by breaking it into smaller ones that overlap.', hear: ['dynamic', 'programming', 'solving', 'problem', 'breaking', 'smaller', 'overlap'] },
        { say: 'That costs $12.50, about 15% less than last week.', hear: ['twelve', 'dollars', 'fifty', 'fifteen', 'percent', 'less', 'week'] },
        { say: 'I couldn’t find that in your notes. Shall I look on YouTube instead?', hear: ['find', 'notes', 'shall', 'look', 'youtube', 'instead'] }
      ];

  /** 24 kHz to the recognizer's 16 kHz: every third pair of samples becomes two, each the mean of its neighbours' share. */
  function to16k(samples, rate) {
    const out = new Float32Array(Math.floor((samples.length * 16000) / rate));
    for (let index = 0; index < out.length; index++) {
      const at = (index * rate) / 16000;
      const low = Math.floor(at);
      const part = at - low;
      out[index] = samples[low] * (1 - part) + (samples[Math.min(low + 1, samples.length - 1)] || 0) * part;
    }
    return out;
  }

  const fromWav = (bytes) => {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array((data.length - 44) / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(44 + index * 2) / 32768;
    return { samples, rate: data.readUInt32LE(24) };
  };

  /** Words as the recognizer writes them and as figures are said, for comparing: "4" and "four" are one word. */
  const FIGURES = { 3: 'three', 4: 'four', 8: 'eight', 9: 'nine', 10: 'ten', 12: 'twelve', 15: 'fifteen', 50: 'fifty', 72: 'seventy' };
  const words = (text) =>
    String(text)
      .toLowerCase()
      .replace(/(\d+)/g, (all) => ` ${FIGURES[all] || all} `)
      .replace(/%/g, ' percent ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

  app.whenReady().then(async () => {
    let failed = 0;
    try {
      if (!kokoroInstalled()) throw new Error('Kokoro isn’t downloaded. In desktop/ run: npm run models -- kokoro');
      const chosen = voiceNamed(named('--voice'));
      const kokoro = startKokoro({ fork: (file) => utilityProcess.fork(file, [], { serviceName: 'Jester voice (voice-check)', stdio: 'pipe' }), voice: () => chosen.id, log: (...parts) => console.log('  ', ...parts) });
      const model = pickModel(undefined);
      const hearing = model ? utilityProcess.fork(path.join(desktop, 'src/main/speech/service.js'), [], { serviceName: 'Jester speech (voice-check)', stdio: 'pipe' }) : null;
      let heardNext = null;
      hearing?.on('message', (message) => ['final', 'error'].includes(message?.type) && heardNext?.(message));
      hearing?.postMessage({ type: 'start', model });
      const readBack = (samples) =>
        new Promise((resolve) => {
          heardNext = resolve;
          hearing.postMessage({ type: 'transcribe', samples });
        });

      console.log(`Jester’s voice: Kokoro, ${chosen.name} (${chosen.about}), ${kokoroThreads()} threads${hearing ? `; read back by ${model}` : '; no recognizer to read it back'}`);
      const began = performance.now();
      await kokoro.sound('Hello.');
      console.log(`   loaded, and a first word made, in ${Math.round(performance.now() - began)} ms\n`);

      const firsts = [];
      for (const line of LINES) {
        const pieces = spokenPieces(spokenLine(line.say));
        const started = performance.now();
        let first = 0;
        let seconds = 0;
        const sounds = [];
        for (const piece of pieces) {
          const sound = await kokoro.sound(piece, { tight: runsOn(piece) });
          if (!first) first = performance.now() - started;
          seconds += sound.seconds;
          sounds.push(sound);
        }
        const took = performance.now() - started;
        firsts.push(first);
        let report = '';
        if (hearing) {
          const all = sounds.map((sound) => fromWav(sound.bytes));
          const joined = new Float32Array(all.reduce((sum, one) => sum + one.samples.length, 0));
          let at = 0;
          for (const one of all) {
            joined.set(one.samples, at);
            at += one.samples.length;
          }
          const back = await readBack(to16k(joined, all[0].rate));
          const got = new Set(words(back.text || ''));
          const missing = line.hear.filter((word) => !got.has(word));
          if (missing.length) failed += 1;
          report = `\n      heard back: “${back.text || back.detail}”${missing.length ? `\n      ✗ not heard: ${missing.join(', ')}` : line.hear.length ? '  ✓' : ''}`;
        }
        console.log(`   “${line.say}”\n      ${pieces.length} piece${pieces.length === 1 ? '' : 's'} · first sound ready in ${Math.round(first)} ms · ${seconds.toFixed(1)} s of sound made in ${Math.round(took)} ms${report}`);
        if (flag('--play') && process.platform === 'darwin') {
          for (const [index, sound] of sounds.entries()) {
            const file = path.join(scratch, `line-${index}.wav`);
            fs.writeFileSync(file, sound.bytes);
            execFileSync('afplay', [file]);
          }
        }
      }
      const sorted = [...firsts].sort((a, b) => a - b);
      console.log(`\n   first sound ready: median ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms, slowest ${Math.round(sorted.at(-1))} ms, over ${firsts.length} lines`);
      if (hearing) console.log(failed ? `   ✗ ${failed} of ${LINES.length} lines lost a word on the way back` : `   ✓ every line was heard back with its words`);
      kokoro.stop();
      hearing?.kill();
    } catch (err) {
      failed += 1;
      console.log('failed:', err.message);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  });
}
