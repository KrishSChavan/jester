/**
 * Controls on his website (the user, 2026-11-18: Controls as "part of the website too", so their scripts run from
 * their phone): what the server asks of this Mac's scripts, and what it may.
 *
 * His website's Controls is the server's page, so what it asks reaches this Mac from the server (remote-hands.js,
 * cloud-link.js). Running what's in Controls, checking what's on, scenes, the menu-bar switch and taking a script out
 * go through as from his own window. Making something run that the user hasn't seen doesn't: a folder's jester.json
 * says what runs, so a server that was no longer only theirs could otherwise write one into any folder it could
 * name (Homebrew's bin, a script's own Python) and run anything at all. So:
 *
 *   - a folder is read (inspect) only if the user picked it in this Mac's own dialog (choose) in the last hour, or
 *     it's in Controls already;
 *   - a jester.json is written (save) only to such a folder, and when the script is new to Controls, or what it runs
 *     changes, only once the user has said yes in a dialog on this Mac, which a page can't answer for them.
 *
 * Renaming, a new icon, other words for it, "Ask first", or taking controls out change nothing that runs, and are
 * saved without asking.
 */

import path from 'node:path';
import { checkManifest } from './script-manifest.js';

/** A folder picked in this Mac's dialog can be read and added for this long. */
export const PICKED_MS = 60 * 60 * 1000;

/** What only names, words or shows a manifest's parts: none of it changes what runs, or with what. */
const COSMETIC = new Set(['jester', 'name', 'icon', 'about', 'label', 'askFirst', 'done', 'words', 'unit', 'low', 'high', 'track', 'names', 'color', 'said', 'chip', 'all', 'lit', 'timeout']);

/** A manifest's parts that decide what runs: its program, every list of arguments, and the values filled into them. */
function runtime(value) {
  if (Array.isArray(value)) return value.map(runtime);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !COSMETIC.has(key))
      .sort()
      .map((key) => [key, runtime(value[key])])
  );
}

/**
 * Whether `next` would run something `before` doesn't: a program, an argument, or a value put into one. A control
 * taken out runs less, and isn't. Both are checked manifests (checkManifest); `before` null for a script that's new.
 */
export function runsMore(next, before) {
  if (!before) return true;
  const top = (manifest) => JSON.stringify(runtime({ ...manifest, controls: [] }));
  if (top(next) !== top(before)) return true;
  const had = new Map(before.controls.map((control) => [control.id, JSON.stringify(runtime(control))]));
  return next.controls.some((control) => had.get(control.id) !== JSON.stringify(runtime(control)));
}

/** Each command a manifest can run, as it would be typed, for the dialog that asks before it's allowed. */
export function commandLines(manifest) {
  const program = `./${manifest.run}`;
  const line = (args) => [program, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
  const lines = manifest.controls.map((control) => `${control.label}: ${line(control.args)}${control.drag?.length ? ` (dragged: ${control.drag.join(' ')})` : ''}`);
  if (manifest.status?.length) lines.push(`Checking what’s on: ${line(manifest.status)}`);
  if (manifest.serve?.length) lines.push(`Kept running while in use: ${line(manifest.serve)}`);
  const aims = (manifest.aim?.choices || []).map((choice) => choice.value).filter(Boolean);
  if (aims.length) lines.push(`{aim} is one of: ${aims.join(', ')}`);
  return lines;
}

const PICK_FIRST = 'Choose that folder on your Mac first: Controls’ + opens a folder dialog there.';

/**
 * @param {object} deps
 * @param {{list:Function, inspect:Function}} deps.scripts   scripts.js's, for which folders are in Controls and what they run now
 * @param {(message:object) => Promise<object>} deps.ask      the Mac's own Controls handler (main.js scriptsAsked)
 * @param {() => Promise<string>} deps.choose                 the Mac's folder dialog: the folder picked, or ''
 * @param {(ask:{adding:boolean, name:string, folder:string, lines:string[]}) => Promise<boolean>} deps.confirm
 *   the Mac's own yes-or-no, before what runs is new
 */
export function createScriptsRemote({ scripts, ask, choose, confirm, now = Date.now, log = () => undefined }) {
  /** Folders the user picked in this Mac's dialog, and when. */
  const picked = new Map();

  async function inControls(folder) {
    const { blocks } = await scripts.list();
    return blocks.some((block) => block.folder === folder);
  }

  async function mayRead(folder) {
    for (const [where, at] of picked) if (now() - at > PICKED_MS) picked.delete(where);
    return picked.has(folder) || (await inControls(folder));
  }

  return {
    /** What the server asked, as main.js's scriptsAsked would take it from his own window, within the rules above. */
    async handle(message = {}) {
      const op = String(message.op ?? '');
      switch (op) {
        case 'list':
        case 'opened':
        case 'run':
        case 'refresh':
        case 'scene-run':
        case 'scene-save':
        case 'scene-remove':
        case 'menu':
        case 'remove':
        case 'reveal':
        case 'edit':
          return ask(message);
        case 'choose': {
          const folder = await choose();
          if (!folder) return { ok: false, folder: '' };
          picked.set(path.resolve(folder), now());
          return { ok: true, folder };
        }
        case 'inspect': {
          const folder = path.resolve(String(message.folder ?? ''));
          if (!(await mayRead(folder))) {
            log('scripts: the server asked to read a folder that wasn’t picked here:', folder);
            return { ok: false, folder, problems: [], why: PICK_FIRST };
          }
          return ask({ op: 'inspect', folder });
        }
        case 'save': {
          const folder = path.resolve(String(message.folder ?? ''));
          if (!(await mayRead(folder))) {
            log('scripts: the server asked to save to a folder that wasn’t picked here:', folder);
            return { ok: false, why: PICK_FIRST };
          }
          const { manifest } = checkManifest(message.manifest);
          // Not a manifest at all: the Mac's own handler says why, and writes nothing.
          if (!manifest) return ask({ op: 'save', folder, manifest: message.manifest });
          const adding = !(await inControls(folder));
          const current = adding ? null : await scripts.inspect(folder);
          const before = !adding && current?.found ? current.manifest : null;
          if (runsMore(manifest, before)) {
            const yes = await confirm({ adding, name: manifest.name, folder, lines: commandLines(manifest) });
            if (!yes) return { ok: false, why: adding ? 'Not added: it wasn’t allowed on your Mac.' : 'Not saved: it wasn’t allowed on your Mac.' };
          }
          return ask({ op: 'save', folder, manifest: message.manifest });
        }
        default:
          return { ok: false, why: 'Not something Controls does from here.' };
      }
    }
  };
}
