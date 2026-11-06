/**
 * Saying something out loud: Puter's voice when it's connected, and the
 * computer's own otherwise, so Jester is never silent over a network or an
 * account. What it says is short, because a long answer isn't worth waiting
 * through, and Puter's allowance is by the character.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PuterError } from './puter.js';

/** Enough for three sentences or so. */
export const SPOKEN_CHARS = 400;
/** After Puter refuses for a reason that won't pass in a moment, how long before it's asked again. */
const REST_MS = 60 * 60 * 1000;
const MAC_VOICE = 'Daniel';

/** What a line for the pill should be, to the ear: no symbols, no "·", and not too long. */
export function spokenLine(text) {
  const line = String(text ?? '')
    .replace(/\s*\([^)]*[⌘⌥⌃⇧][^)]*\)/g, '')
    .replace(/\s+·\s+/g, '. ')
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= SPOKEN_CHARS) return line;
  const cut = line.slice(0, SPOKEN_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return sentence > 0 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * The OS's own voice. `muted` (tests) writes the speech to a file instead.
 * @returns {{say:(text:string) => Promise<void>, stop:() => void}}
 */
export function systemVoice({ platform = process.platform, spawnImpl = spawn, muted = false } = {}) {
  let child = null;
  const macArgs = (voice) => [...(voice ? ['-v', voice] : []), ...(muted ? ['-o', path.join(os.tmpdir(), 'jester-say.aiff')] : []), '-f', '-'];
  const WINDOWS_SPEECH = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())';

  /** Text goes in on stdin: it's what was said, and never an argument. */
  const run = (file, args, text) =>
    new Promise((resolve) => {
      const started = spawnImpl(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child = started;
      const over = (code) => {
        if (child === started) child = null;
        resolve(code);
      };
      started.on('error', () => over(1));
      started.on('exit', (code) => over(code));
      started.stdin?.on('error', () => undefined);
      started.stdin?.end(text);
    });

  return {
    async say(text) {
      if (platform === 'win32') return void (await run('powershell.exe', ['-NoProfile', '-Command', WINDOWS_SPEECH], text));
      if (platform !== 'darwin') return undefined;
      // A Mac may not have this voice: its default will do.
      if ((await run('say', macArgs(MAC_VOICE), text)) === 1) await run('say', macArgs(), text);
      return undefined;
    },
    stop() {
      child?.kill();
      child = null;
    }
  };
}

/**
 * @param {object} deps
 * @param {() => Promise<string|null>} deps.token  the Puter sign-in, if any
 * @param {(text:string, token:string, options:{signal:AbortSignal}) => Promise<{bytes:Uint8Array, type:string}>} deps.synthesize
 * @param {(bytes:Uint8Array, type:string) => Promise<void>} deps.play
 * @param {() => void} deps.stopPlaying
 * @param {{say:Function, stop:Function}} deps.system
 * @param {(trouble:string) => void} [deps.onTrouble]  Puter stopped working, or started: '' when fine
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createSpeaker({ token, synthesize, play, stopPlaying, system, onTrouble = () => undefined, log = () => undefined, now = Date.now }) {
  let controller = null;
  let restingUntil = 0;

  const puter = async (text, signal) => {
    const key = now() < restingUntil ? null : await token();
    if (!key) return false;
    try {
      const { bytes, type } = await synthesize(text, key, { signal });
      if (signal.aborted) return true;
      await play(bytes, type);
      onTrouble('');
      return true;
    } catch (err) {
      if (signal.aborted) return true;
      log('Puter’s voice:', err.message);
      if (err instanceof PuterError && ['signed_out', 'no_credits'].includes(err.code)) {
        restingUntil = now() + REST_MS;
        onTrouble(err.message);
      }
      return false;
    }
  };

  return {
    /** @returns {Promise<void>} once it's been said, or stopped */
    async say(text) {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      if (!(await puter(text, mine.signal)) && !mine.signal.aborted) await system.say(text);
    },
    stop() {
      controller?.abort();
      stopPlaying();
      system.stop();
    },
    /** A new sign-in: Puter is worth asking again. */
    connected() {
      restingUntil = 0;
      onTrouble('');
    }
  };
}
