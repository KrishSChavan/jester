/**
 * A folder dropped on Controls with no jester.json, drafted into one by the talking model (the user, 2026-11-18,
 * chose "he drafts, you approve"): the folder's file names, its README, the start of each script, and the --help of
 * one whose source shows it answers --help, go to the model with the manifest's shape; what comes back is checked
 * like any jester.json (script-manifest.js) and shown to the user to change and approve before anything is saved.
 *
 * Nothing in the folder is run but that --help, and only for the very script whose own source uses an argument
 * parser that answers it and leaves (argparse, click, typer, optparse, commander, yargs): not a wrapper that hands
 * its arguments on, and not a shell script's own `case "$1"` or getopts, which may well fall through to what the
 * script does. Hidden files, keys and .env files aren't read; what looks like a password, key or token (set by a
 * name like those, or a long hex or random string) goes to the model as <hidden>.
 *
 * A draft never says how to keep a script running ("serve") or how to ask what's on ("status"): the first stays
 * running, the second is run unasked whenever Controls opens, and neither should rest on a model's reading. A
 * folder's own jester.json can have both, and the review shows them.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import { ICONS, KINDS, checkManifest } from './script-manifest.js';
import { commandFor, scriptEnv } from './script-runner.js';

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', 'dist', 'build', '.idea', '.vscode']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.rb', '.applescript', '.ps1']);
const SECRET_FILE = /(?:^\.env|\.(?:key|pem|p12|pfx|keychain)$|secret|credential|token|passw)/i;
/** Parsers that answer --help and leave, before the script does anything. */
const PARSER = /\b(?:argparse|ArgumentParser|click\.(?:command|group)|typer\.(?:Typer|run)|optparse|OptionParser|require\(['"]commander['"]\)|from ['"]commander['"]|require\(['"]yargs['"]\)|from ['"]yargs['"])/;
/** A name that says its value is a secret, set to something: LOCAL_KEY = "…", "psk": "…", password=…; and Bearer … */
const SECRET_SET = /((?:[\w-]*(?:key|psk|pass(?:word|wd|phrase)?|pwd|secret|token|auth|credential|cookie|session|private)[\w-]*)["']?\s*[:=]\s*["']?)[^\s"',;)]{4,}/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
/** Quoted hex of 16 or more (device keys, passed by position), and long strings of letters and digits mixed. */
const QUOTED_HEX = /(["'])[0-9a-fA-F]{16,}\1/g;
const LONG_RANDOM = /\b(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{24,}\b/g;
const BUDGET = { readme: 8000, file: 6000, files: 24000, help: 6000, entries: 80 };

export const hide = (text) => String(text).replace(BEARER, '$1<hidden>').replace(SECRET_SET, '$1<hidden>').replace(QUOTED_HEX, '$1<hidden>$1').replace(LONG_RANDOM, '<hidden>');

/** What the model is shown of a folder. */
export function folderPicture(folder, { fs = nodeFs } = {}) {
  const names = [];
  const scripts = [];
  let readme = '';
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (names.length >= BUDGET.entries || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(folder, full);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        names.push(`${rel}/`);
        if (depth < 1) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      // eslint-disable-next-line no-bitwise
      const executable = !!(stat.mode & 0o111);
      names.push(`${rel}${executable ? ' (executable)' : ''}, ${stat.size} bytes`);
      if (SECRET_FILE.test(entry.name) || stat.size > 512 * 1024) continue;
      if (!readme && depth === 0 && /^readme(?:\.(?:md|txt|markdown))?$/i.test(entry.name)) readme = read(full, BUDGET.readme);
      else if (SCRIPT_EXT.has(path.extname(entry.name).toLowerCase()) || (executable && !path.extname(entry.name))) scripts.push({ rel, executable });
    }
  };
  const read = (file, most) => {
    try {
      return hide(fs.readFileSync(file, 'utf8').slice(0, most));
    } catch {
      return '';
    }
  };
  walk(folder, 0);
  let left = BUDGET.files;
  // Executables without an extension first (the command people type), then the rest.
  const ordered = scripts.sort((a, b) => Number(b.executable && !path.extname(b.rel)) - Number(a.executable && !path.extname(a.rel))).slice(0, 8);
  const heads = [];
  for (const script of ordered) {
    if (left <= 0) break;
    const head = read(path.join(folder, script.rel), Math.min(BUDGET.file, left));
    left -= head.length;
    heads.push({ rel: script.rel, head });
  }
  return { names, readme, heads };
}

/** The script to ask for --help: the one whose own source uses a parser that answers it and leaves, or none. */
export function helpTarget(picture) {
  return picture.heads.find((item) => PARSER.test(item.head))?.rel || '';
}

const SYSTEM = `You write jester.json for a folder of the user's own scripts, so Jester, their desktop assistant, can show them as a block of buttons, sliders and choices in its Controls window and run them when asked by voice. Use only what the folder shows: never invent a command, option or value the scripts don't have.
The JSON object:
{"jester":1, "name":"a short name for the block, like Lights or Backup", "icon":"one of ${ICONS.join(', ')}", "about":"one sentence: what these scripts control", "run":"the program to start, relative to the folder: the command people type, an executable, or a .py, .sh or .js file", "timeout":30,
 "aim":{"label":"what the targets are, like Which lights","all":"what all of them are called aloud, like lights","choices":[{"label":"All","value":""},{"label":"a target as people say it","value":"the exact argument the script takes","said":"how it's said aloud"}]},
 "controls":[{"id":"short-id","kind":"${KINDS.join('|')}","label":"one or two words","args":["arguments after the program, with {value} and {aim} where they go"],"done":"a few words said after it, using {aim}, {value} or {name}","words":["3 to 8 short phrases a person might say for it, using {aim?}, {aim} and {value}"],"askFirst":false}]}
Rules:
- controls are the useful everyday actions, at most 12. Never a setup, sign-in, install or interactive command, nor anything that asks questions or runs forever.
- kind: button takes no value; slider is a number in a range (add "min", "max" and "unit"; "low" and "high" name its ends); choices is one of a few values (add "choices":[{"label":"…","value":"…"}], and "color":"#rrggbb" when they're colours); ask prints something worth saying back, like a status.
- {value} goes where a slider's or choice's value goes. {aim} goes where the target goes, and only if the commands take one; leave "aim" out otherwise. "All" with value "" means leaving the target out acts on everything.
- askFirst is true for anything that deletes, sends, buys, unlocks, shuts down or can't be undone.
- Leave out "serve" and "status".
Reply with the JSON object only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    jester: { type: 'number' },
    name: { type: 'string' },
    icon: { type: 'string' },
    about: { type: 'string' },
    run: { type: 'string' },
    timeout: { type: 'number' },
    aim: { type: 'object' },
    controls: { type: 'array', items: { type: 'object' } }
  },
  required: ['name', 'run', 'controls']
};

/**
 * @param {string} folder
 * @param {object} deps
 * @param {(request:object) => Promise<{json:any}>} deps.request  the talking model
 * @returns {Promise<{manifest:object|null, problems:string[], why?:string}>}
 */
export async function draftManifest(folder, { request, fs = nodeFs, execFile = nodeExecFile, log = () => undefined, platform = process.platform }) {
  const picture = folderPicture(folder, { fs });
  if (!picture.heads.length && !picture.readme) return { manifest: null, problems: [], why: 'There are no scripts in that folder for Jester to run.' };
  let help = '';
  const target = helpTarget(picture);
  if (target) {
    const command = commandFor(folder, target, { fs, platform });
    if (!command.error) {
      help = await new Promise((resolve) => {
        execFile(command.file, [...command.pre, '--help'], { cwd: folder, env: scriptEnv(), timeout: 6000, maxBuffer: 256 * 1024, windowsHide: true }, (_err, stdout, stderr) => resolve(hide(`${stdout || ''}${stderr || ''}`).slice(0, BUDGET.help)));
      });
    }
  }
  const prompt = [
    `The folder: ${path.basename(folder)}`,
    `What's in it:\n${picture.names.join('\n')}`,
    picture.readme && `Its README:\n${picture.readme}`,
    ...picture.heads.map((item) => `The start of ${item.rel}:\n${item.head}`),
    help && `What \`${target} --help\` printed:\n${help}`
  ].filter(Boolean).join('\n\n');
  log(`scripts: drafting ${path.basename(folder)} (${picture.heads.length} scripts read${help ? ', --help asked' : ''})`);
  let json;
  try {
    ({ json } = await request({ system: SYSTEM, prompt, schema: SCHEMA, plain: true, maxOutputTokens: 3000 }));
  } catch (err) {
    return { manifest: null, problems: [], why: `Jester couldn’t ask his model to read it: ${String(err?.message || err).slice(0, 160)}` };
  }
  const raw = json?.controls ? json : json?.manifest || json?.jester || json;
  // Never a model's: what stays running, and what's run unasked when Controls opens (above).
  if (raw && typeof raw === 'object') {
    delete raw.serve;
    delete raw.status;
  }
  const { manifest, problems } = checkManifest(raw);
  return manifest ? { manifest, problems } : { manifest: null, problems, why: problems[0] ? `His draft didn’t work out: ${problems[0]}` : 'Jester couldn’t work out what those scripts do.' };
}
