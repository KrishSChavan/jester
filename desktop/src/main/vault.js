/**
 * Jester's Obsidian vault: the user's notes, which Jester reads to answer from,
 * and the few Jester keeps there itself. What it has learned about the user
 * (About me), a note a day of conversations, as summaries; what it was asked
 * to remember, word for word; and the notes the user asks it to make or add to.
 *
 * It reads the whole vault and writes only in Jester/, any time, and Notes/,
 * when asked. Everything else is the user's. Every write is checked against
 * that, and lands whole: written beside the note and renamed into place, so
 * neither Obsidian nor a sync ever sees half a note. Notes are changed by
 * adding and removing lines, never rewritten, so what the user typed into them
 * stays. Only Routines, Index and the readme are views, rewritten whole.
 *
 * Each note says what it is in its properties: its `type`, and a tag, which
 * is `jester/…` on Jester's own (About me, Conversations, Remembered and the
 * views) and `note` on those made in Notes/, the same way every time, so
 * search (vault-index.js) and the user can tell a profile from a day's
 * conversations from a note of their own.
 */

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SECTIONS = Object.freeze(['Who you are', 'School and work', 'People', 'Preferences', 'Plans and dates', 'Other']);
export const SYSTEM_TYPES = Object.freeze(['routines', 'index', 'readme']);

/** Where Jester's own notes are, from the vault's root. */
export const PATHS = Object.freeze({
  aboutMe: 'Jester/About me.md',
  conversations: 'Jester/Conversations',
  remembered: 'Jester/Remembered',
  routines: 'Jester/Routines.md',
  index: 'Jester/Index.md',
  readme: 'Jester/How Jester uses this vault.md',
  notes: 'Notes'
});

/** The only folders Jester writes in. */
const WRITES_IN = ['Jester', 'Notes'];
/** How deep a vault is walked: far past any real one, short of a loop. */
const MAX_DEPTH = 24;

const ABOUT_ME_INTRO = 'What Jester has learned about you from your conversations. Edit or delete anything here: Jester reads this note as it is.';

const README = [
  '# How Jester uses this vault',
  '',
  'Jester reads every note in this vault, so it can answer from what you’ve written. It writes in only two folders, Jester and Notes. ' +
    'Everything else is yours, and Jester leaves it as it is.',
  '',
  '## What’s where',
  '- [[Jester/About me|About me]]: what Jester has learned about you, by section. Correct anything that’s wrong.',
  '- Jester/Conversations: a note a day, with a short summary of each conversation, its topics and the people in it.',
  '- Jester/Remembered: what you asked Jester to remember (“remember this”, “don’t forget …”), word for word, a note each.',
  '- [[Jester/Routines|Routines]]: what Jester does straight away, with no AI model, because you taught it or it learned it.',
  '- [[Jester/Index|Index]]: a map of this vault, folder by folder.',
  '- Notes: notes you asked Jester to make or add to (“add eggs to my grocery list”). Jester changes these only when you ask.',
  '',
  '## What Jester keeps',
  '- Conversations are kept as summaries and facts, not word for word. Your exact words are kept only when you ask Jester to remember something.',
  '- Jester never keeps passwords, PINs or card numbers here: notes are plain text files.',
  '- Whenever what you say goes to the AI model Jester talks through, what’s in About me and the parts of your notes that look related to it ' +
    'go too: to a cloud provider, if you chose one in Jester’s Settings › Models.',
  '- Edit or delete anything you like, whole notes and folders too: Jester reads what’s here as it is. ' +
    'Keeping conversations can be turned off in Jester’s Settings.',
  '',
  'Jester rewrites Routines, Index and this note, so changes to those three won’t last.',
  ''
].join('\n');

const ROUTINES_INTRO =
  'What Jester does straight away, with no AI model: say one of these and it’s done in a moment. ' +
  'Jester rewrites this note as it learns, so edits here won’t last. To drop one, say “forget the shortcut” and its words.';
const ROUTINE_KINDS = [
  ['phrase', 'You taught', 'What you taught Jester with “when I say …”.'],
  ['alias', 'Shortcuts', 'Requests Jester learned to know in your own words.'],
  ['task', 'Learned tasks', 'What the assistant got done once, kept as the steps that did it.']
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
/** 2026-11-10, in local time. */
const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** 2026-11-10T13:05:00-05:00: local time and its offset, as Obsidian's date-and-time properties hold it. */
function isoTime(date) {
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${isoDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}
/** Tuesday, November 10, 2026 */
const longDate = (date) => `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
/** 1:05 PM, spelled out here: the space Intl puts before "PM" differs between versions. */
const clock = (date) => `${date.getHours() % 12 || 12}:${pad(date.getMinutes())} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
/** 2026-11-10 from a time, a Date or a date property; '' from anything else. A bare date is that day, not UTC's midnight. */
function dayOf(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(time) ? isoDate(new Date(time)) : '';
}

const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;

/** Cut to `max`, never through a character. */
const clip = (text, max) => (text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd());
/** Text as one line of a note: no breaks, and no comment marks that would hide what follows. */
const inline = (text, max = 300) => clip(String(text ?? '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim(), max);
/** Text for a heading: one line, without heading marks of its own. */
const headingText = (text) => inline(text, 80).replace(/^#+\s*/, '');
/**
 * How facts and titles are compared: case, spacing and punctuation don't count, but + and # do, as C, C++ and C# are
 * three things and an A+ isn't an A. Without a letter or a digit it's '': marks alone name nothing.
 */
function normal(text) {
  const key = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(key) ? key : '';
}
/** A property's value as a list of strings, whichever shape it was written in. */
const listOf = (value) =>
  (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).filter((item) => item !== null && item !== '').map(String);
/** The line ending a note already uses, so what's added matches it. */
function eolOf(text) {
  const at = text.indexOf('\n');
  return at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
}
/** Words shown in Jester's views, kept from turning into tags there. */
const untag = (text) => text.replace(/(^|\s)#(?=[^\s#])/g, '$1\\#');

/** A vault-relative path in the one form notes are named by ("Notes/Grocery list.md"), or null: absolute, climbing out, or untidy. */
function relPath(rel) {
  if (typeof rel !== 'string' || !rel || /[\0\\]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return null;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..') ? rel : null;
}

/** Whether Jester may write there: a file inside Jester/ or Notes/, plainly named (no "..", nothing hidden). */
function writablePath(rel) {
  const parts = relPath(rel)?.split('/');
  return !!parts && parts.length > 1 && WRITES_IN.includes(parts[0]) && parts.every((part) => !part.startsWith('.'));
}

const inNotes = (rel) => writablePath(rel) && rel.startsWith(`${PATHS.notes}/`);

const isFolder = (fs, dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The vault in a folder the user chose: the folder itself when it holds `.obsidian`; else the one folder in it that
 * does ("Jester-Obsidian-DB" holds "Jester Desktop/.obsidian"); else the folder as it is, since a plain folder of
 * notes works too. Null when it isn't a folder.
 * @param {string} dir
 * @param {{fs?: typeof nodeFs}} [options]
 * @returns {string|null}
 */
export function findVaultRoot(dir, { fs = nodeFs } = {}) {
  if (typeof dir !== 'string' || !dir) return null;
  const root = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!isFolder(fs, root)) return null;
  if (isFolder(fs, path.join(root, '.obsidian'))) return root;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    /* unreadable inside: taken as it is */
  }
  const vaults = entries.filter(
    (entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()) && isFolder(fs, path.join(root, entry.name, '.obsidian'))
  );
  return vaults.length === 1 ? path.join(root, vaults[0].name) : root;
}

/**
 * The vaults Obsidian knows on this computer, from its own list of them: the open one first, then the most recently
 * opened. It never looks inside them: on a Mac, a vault in Documents would ask for permission.
 * @param {{home?: string, platform?: string, fs?: typeof nodeFs, appData?: string}} [options]  appData: Windows' %APPDATA%
 * @returns {{path:string, name:string, open:boolean}[]}
 */
export function detectObsidianVaults({ home, platform = process.platform, fs = nodeFs, appData } = {}) {
  const user = home || os.homedir();
  // A home given is a home to look in, so %APPDATA% is taken from the environment only for the real one.
  const roaming = appData || (home ? '' : process.env.APPDATA) || path.join(user, 'AppData', 'Roaming');
  const config =
    platform === 'darwin'
      ? path.join(user, 'Library', 'Application Support', 'obsidian')
      : platform === 'win32'
        ? path.join(roaming, 'obsidian')
        : path.join(user, '.config', 'obsidian');
  let vaults;
  try {
    vaults = Object.values(JSON.parse(fs.readFileSync(path.join(config, 'obsidian.json'), 'utf8'))?.vaults || {});
  } catch {
    return [];
  }
  const named = platform === 'win32' ? path.win32.basename : path.basename;
  const seen = new Set();
  return vaults
    .filter((vault) => typeof vault?.path === 'string' && vault.path && !seen.has(vault.path) && seen.add(vault.path))
    .sort((a, b) => Number(!!b.open) - Number(!!a.open) || (Number(b.ts) || 0) - (Number(a.ts) || 0))
    .map((vault) => ({ path: vault.path, name: named(vault.path), open: !!vault.open }));
}

/** A note's frontmatter, found: its YAML lines, and what follows them. Null without one. */
function splitNote(text) {
  const source = String(text ?? '');
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = source.slice(bom.length).split('\n');
  const bare = (line) => line.replace(/\r$/, '');
  if (lines.length < 2 || !/^---[ \t]*$/.test(bare(lines[0]))) return null;
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(bare(line)));
  if (end < 0) return null;
  return { bom, open: lines[0], yaml: lines.slice(1, end), close: lines[end], body: lines.slice(end + 1).join('\n'), rest: end + 1 < lines.length };
}

/** The note's text from its parts, its YAML lines perhaps changed. */
const joinNote = (note, yaml = note.yaml, body = note.body) =>
  `${note.bom}${[note.open, ...yaml, note.close].join('\n')}${note.rest || body ? `\n${body}` : ''}`;

/**
 * A note's properties and the rest of it. Reads the YAML Obsidian writes: plain, quoted and typed values, and lists
 * in either style. Anything else (a nested map, say) is kept as its text.
 * @param {string} text
 * @returns {{data:object, body:string}}
 */
export function parseFrontmatter(text) {
  const note = splitNote(text);
  if (!note) return { data: {}, body: String(text ?? '').replace(/^\uFEFF/, '') };
  return { data: parseYaml(note.yaml.map((line) => line.replace(/\r$/, ''))), body: note.body };
}

/** A list item, at the margin or indented. */
const ITEM = /^\s*-(?:\s|$)/;

function parseYaml(lines) {
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    // Blank, indented, a comment, or a stray list item: no property starts here.
    if (!lines[i] || /^(?:\s|#|-(?:\s|$))/.test(lines[i])) continue;
    const property = keyOf(lines[i]);
    if (!property) continue;
    // What's under it: indented lines, and list items, which YAML lets start at the margin.
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]) || /^-(?:\s|$)/.test(lines[end]))) end++;
    data[property.key] = valueOf(property.rest, lines.slice(i + 1, end));
    i = end - 1;
  }
  return data;
}

/** The property a line starts, {key, rest}, or null. Its key ends at the first colon followed by a space. */
function keyOf(line) {
  const quoted = line.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/);
  if (quoted) return { key: String(scalar(quoted[1])), rest: quoted[2] ?? '' };
  const plain = line.match(/^(.+?)\s*:(?:\s+(.*))?$/);
  return plain ? { key: plain[1], rest: plain[2] ?? '' } : null;
}

/** Indentation: YAML's is spaces only. */
const spaces = (line) => line.match(/^ */)[0].length;

/** A value from the rest of its line and the lines under it; `parent` is where the line holding it is indented. */
function valueOf(rest, under, parent = 0) {
  const text = rest.trim();
  const block = text.match(/^([|>])([-+]?)(\d?)([-+]?)(?:\s+#.*)?$/);
  if (block) return blockScalar(block[1], block[2] || block[4], block[3] ? parent + Number(block[3]) : null, under);
  // A value wrapped onto indented lines is one line again, as YAML folds it.
  const wrapped = under.filter((line) => /^\s+[^\s#]/.test(line)).map((line) => line.trim());
  if (text && !text.startsWith('#')) return scalar([text, ...wrapped].join(' '));
  const lines = under.filter((line) => line.trim() && !/^\s*#/.test(line));
  if (!lines.length) return null;
  return (ITEM.test(lines[0]) && listItems(under)) || dedent(under).join('\n').replace(/\n+$/, '');
}

/** A block list's values. Lines under an item are its own: a value can be wrapped, a block, or a list itself. */
function listItems(under) {
  const indent = spaces(under.find((line) => line.trim() && !/^\s*#/.test(line)));
  const items = [];
  for (const line of under) {
    const depth = spaces(line);
    if (!line.trim() || (depth > indent && items.length)) items.at(-1)?.under.push(line);
    else if (depth === indent && ITEM.test(line)) items.push({ line, rest: line.replace(ITEM, ''), under: [] });
    else if (!/^\s*#/.test(line)) return null;
  }
  return items.map(({ line, rest, under: lines }) => {
    // "- - a" is a list in the list, its first item where the second dash is.
    if (ITEM.test(rest)) return valueOf('', [line.replace(/^( *)-/, '$1 '), ...lines], indent);
    // An item that's a map ("- a: b") is a shape this doesn't read: kept as its text.
    if (/^[^\s"'[{#|>][^]*?:(?:\s|$)/.test(rest.trim())) return [rest.trim(), ...dedent(lines)].join('\n').trim();
    return valueOf(rest, lines, indent);
  });
}

/**
 * A `|` or `>` block, indented `at` (else as its first lines are): kept line by line, or folded. Its end as YAML
 * chomps it: one line break (clip), none (`-`), or every one, blank lines too (`+`).
 */
function blockScalar(style, chomp, at, under) {
  const lines = dedent(under, false, at);
  let blank = 0;
  while (blank < lines.length && !lines[lines.length - 1 - blank]) blank++;
  const kept = lines.slice(0, lines.length - blank);
  let text = kept[0] ?? '';
  for (let i = 1; i < kept.length; i++) {
    const [line, before] = [kept[i], kept[i - 1]];
    if (style === '|' || !line) text += `\n${line}`;
    else if (!before) text += line;
    else text += `${/^\s/.test(line) || /^\s/.test(before) ? '\n' : ' '}${line}`;
  }
  if (chomp === '-' || (!kept.length && chomp !== '+')) return text;
  return `${text}${kept.length ? '\n' : ''}${chomp === '+' ? '\n'.repeat(blank) : ''}`;
}

/** Lines without the indentation they share (or `at`), never cutting into what's written. */
function dedent(lines, trim = true, at = null) {
  const indent = at ?? Math.min(...lines.filter((line) => line.trim()).map(spaces));
  return lines.map((line) => {
    const cut = line.slice(Math.min(indent, spaces(line)));
    return trim ? cut.trimEnd() : cut;
  });
}

/** One value: quoted, a flow list, or plain (null, true/false, a number, else a string). */
function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) return doubleQuoted(text);
  if (text.startsWith("'")) return singleQuoted(text);
  if (text.startsWith('[')) return flowList(text);
  const plain = text.replace(/(?:^|\s+)#.*$/, '');
  if (/^(?:null|Null|NULL|~|)$/.test(plain)) return null;
  if (/^(?:true|True|TRUE)$/.test(plain)) return true;
  if (/^(?:false|False|FALSE)$/.test(plain)) return false;
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };

function doubleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"') return out;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[++i] ?? '';
    const digits = { x: 2, u: 4, U: 8 }[next];
    const hex = digits ? text.slice(i + 1, i + 1 + digits) : '';
    const code = hex.length === digits && /^[\da-f]+$/i.test(hex) ? parseInt(hex, 16) : -1;
    if (code >= 0 && code <= 0x10ffff) {
      out += String.fromCodePoint(code);
      i += digits;
    } else out += ESCAPES[next] ?? next;
  }
  return text; // never closed: kept as written
}

function singleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") out += text[i];
    else if (text[i + 1] === "'") out += text[i++];
    else return out;
  }
  return text;
}

function flowList(text) {
  const items = [];
  let item = '';
  let quote = '';
  let depth = 0;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\' && quote === '"') item += char + (text[++i] ?? '');
      else {
        item += char;
        if (char === quote) quote = '';
      }
      continue;
    }
    if (char === ']' && !depth) {
      const all = [...items, item];
      if (!all.at(-1).trim()) all.pop(); // [a, b,] and []
      return all.map(scalar);
    }
    if (char === ',' && !depth) {
      items.push(item);
      item = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    item += char;
  }
  return text;
}

/** Whether a string can go into YAML as it is and be read back the same string. */
function plainOk(text) {
  return (
    text !== '' &&
    text === text.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
    !/:(?:\s|$)|\s#|[\0-\x1f\x7f\x85\u2028\u2029\uFEFF]/.test(text) &&
    !/^(?:true|false|yes|no|on|off|y|n|null|~)$/i.test(text) &&
    !/^[-+]?(?:\.?\d[\d_]*(?:\.[\d_]*)?(?:e[-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|\.inf|\.nan|\d+(?::[0-5]?\d)+(?:\.\d*)?)$/i.test(text)
  );
}

const quoted = (text) =>
  `"${text
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f\x85\u2028\u2029\uFEFF]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

function yamlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoted(String(value));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'null' : isoTime(value);
  if (Array.isArray(value)) return `[${value.map((item) => (typeof item === 'string' ? quoted(item) : yamlValue(item))).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return plainOk(text) ? text : quoted(text);
}

const yamlKey = (key) => (/^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*$/u.test(key) && !/\s$/.test(key) ? key : quoted(String(key)));

/** A property as YAML lines: lists in block style, as Obsidian writes them; an empty one as []. */
function propertyLines(key, value) {
  const name = yamlKey(key);
  if (Array.isArray(value)) return value.length ? [`${name}:`, ...value.map((item) => `  - ${yamlValue(item)}`)] : [`${name}: []`];
  return [value === null ? `${name}:` : `${name}: ${yamlValue(value)}`];
}

/**
 * A note from its properties and body: parseFrontmatter's inverse. Strings are quoted only when YAML needs it.
 * @param {object} data
 * @param {string} body
 * @returns {string}
 */
export function writeFrontmatter(data, body = '') {
  const lines = Object.entries(data || {})
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => propertyLines(key, value));
  const text = String(body ?? '');
  // A body that itself starts like frontmatter gets an empty one, so it isn't read as one.
  if (!lines.length) return splitNote(text) ? `---\n---\n${text}` : text;
  return `---\n${lines.join('\n')}\n---\n${text}`;
}

/** The note's text with these properties set, every other line as it was. Without frontmatter it's left alone. */
function withProperties(text, props) {
  const note = splitNote(text);
  if (!note) return text;
  const cr = eolOf(text) === '\r\n' ? '\r' : '';
  const yaml = [...note.yaml];
  for (const [key, value] of Object.entries(props)) {
    const lines = propertyLines(key, value).map((line) => line + cr);
    const at = yaml.findIndex((line) => !/^[\s#-]/.test(line) && keyOf(line.replace(/\r$/, ''))?.key === key);
    if (at < 0) {
      yaml.push(...lines);
      continue;
    }
    let end = at + 1;
    while (end < yaml.length && (/^\s+\S/.test(yaml[end]) || /^-(?:\s|$)/.test(yaml[end]))) end++;
    yaml.splice(at, end - at, ...lines);
  }
  return joinNote(note, yaml);
}

/** The note with a new body under the same frontmatter. */
function withBody(text, body) {
  const note = splitNote(text);
  return note ? joinNote(note, note.yaml, body) : body;
}

/** The text with a block of lines added at its end, after a blank line. */
function appendBlock(text, lines) {
  const eol = eolOf(text);
  const head = text.replace(/(?:\r?\n)+$/, '');
  return `${head}${head ? eol + eol : ''}${lines.join(eol)}${eol}`;
}

/** A note with words added at its end: a line as an item of the list it ends with (or a new list), more as a paragraph. */
function appendTo(text, addition) {
  const eol = eolOf(text);
  const head = text.replace(/(?:\r?\n)+$/, '');
  const lines = addition.split('\n');
  if (lines.length > 1) return `${head}${head ? eol + eol : ''}${lines.join(eol)}${eol}`;
  const item = inline(addition, 2000).replace(/^(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, '');
  const last = head.slice(head.lastIndexOf('\n') + 1).replace(/\r$/, '');
  const list = last.match(/^\s*(?:([-*+])|(\d+)([.)]))[ \t]+(\[.\][ \t]+)?/);
  if (!list) return `${head}${head ? eol + eol : ''}- ${item}${eol}`;
  return `${head}${eol}${list[1] || `${Number(list[2]) + 1}${list[3]}`} ${list[4] ? '[ ] ' : ''}${item}${eol}`;
}

/**
 * A title as a file name: no / \ : * ? " < > | # ^ [ ] or control characters, single spaces, nothing hidden, at most
 * 80 characters. The # that ends a name (C#, F#) is spelled out, so "C# notes" isn't saved as "C notes".
 * @param {string} title
 * @returns {string}
 */
export function safeTitle(title) {
  let name = String(title ?? '')
    .normalize('NFC')
    .replace(/(?<=(?:^|[^\p{L}\p{N}])\p{L})#(?![\p{L}\p{N}])/gu, ' sharp')
    .replace(/[/\\:*?"<>|#^[\]\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '');
  name = clip(name, 80).replace(/[\s.]+$/, '');
  // Names Windows keeps for devices.
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `${name} note`;
  return name || 'Untitled';
}

/** What a note is called: its `title` property, else its first top heading, else its file's name. */
function titleOf(rel, data, body) {
  const property = typeof data.title === 'string' || typeof data.title === 'number' ? String(data.title).trim() : '';
  if (property) return property;
  // A "# comment" in a block of code isn't a heading: a note of commands with none of its own is named by its file.
  let fenced = false;
  for (const raw of String(body).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const heading = line.match(HEADING);
      if (heading?.[1].length === 1 && heading[2].trim()) return heading[2].trim();
    }
  }
  return path.posix.basename(rel).replace(/\.md$/i, '');
}

/** A title asked for: one line, without a ".md" of its own. */
const noteTitle = (title) => inline(title, 200).replace(/\.md$/i, '').trim();

/** One of About me's sections: SECTIONS' own name for it, or Other. */
const sectionFor = (name) => SECTIONS.find((section) => normal(section) === normal(name)) || 'Other';

/** A fact as it's written: one line, without list or heading marks of its own. */
const cleanFact = (text) => inline(text, 300).replace(/^(?:[-*+>]\s+|#+\s+|\[.\]\s+)+/, '').trim();

/** The fact bullets of About me's lines: {index, section, fact}. Bullets above the first section are Other's. */
function factLines(lines) {
  const facts = [];
  let section = 'Other';
  let fenced = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line)) return;
    const heading = line.match(HEADING);
    if (heading) {
      // A section the user added keeps the name they gave it.
      if (heading[1].length <= 2) section = heading[1].length === 2 ? SECTIONS.find((name) => normal(name) === normal(heading[2])) || heading[2] : 'Other';
      return;
    }
    const fact = line.match(BULLET)?.[1].replace(COMMENT, '').trim();
    if (fact) facts.push({ index, section, fact });
  });
  return facts;
}

/** About me as it's told to a model: the user's words and the facts, without Jester's line, the noted dates or empty sections. */
function aboutText(body) {
  const lines = body
    .replace(/\r/g, '')
    .replace(COMMENT, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== ABOUT_ME_INTRO);
  const empty = (i) => {
    const level = lines[i].match(HEADING)[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const heading = lines[j].match(HEADING);
      if (heading && heading[1].length <= level) return true;
      if (!heading && lines[j].trim()) return false;
    }
    return true;
  };
  return lines
    .filter((line, i) => !HEADING.test(line) || !empty(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** About me's lines with a fact at the end of its section. A section the user took out comes back at the end. */
function withFact(lines, section, bullet, eol) {
  const cr = eol === '\r\n' ? '\r' : '';
  const plain = lines.map((line) => line.replace(/\r$/, ''));
  const start = plain.findIndex((line) => {
    const heading = line.match(HEADING);
    return heading?.[1].length === 2 && normal(heading[2]) === normal(section);
  });
  if (start < 0) {
    let end = lines.length;
    while (end > 0 && !plain[end - 1].trim()) end--;
    return [...lines.slice(0, end), ...(end ? [cr] : []), `## ${section}${cr}`, `${bullet}${cr}`, ''];
  }
  let end = start + 1;
  while (end < plain.length && !/^#{1,2}[ \t]/.test(plain[end])) end++;
  let last = end - 1;
  while (last > start && !plain[last].trim()) last--;
  // Under a paragraph of the user's, the list starts after a blank line.
  const added = last > start && !BULLET.test(plain[last]) ? [cr, `${bullet}${cr}`] : [`${bullet}${cr}`];
  return [...lines.slice(0, last + 1), ...added, ...lines.slice(last + 1)];
}

const aboutMeTemplate = (day) =>
  writeFrontmatter(
    { type: 'profile', tags: ['jester/profile'], aliases: ['About me', 'What Jester knows about me'], updated: day },
    `# About me\n\n${ABOUT_ME_INTRO}\n\n${SECTIONS.map((section) => `## ${section}\n`).join('\n')}`
  );

/** Topics or people: short, one of each whatever their case, at most 12. */
function labels(list, lower = false) {
  const seen = new Set();
  const out = [];
  for (const item of typeof list === 'string' ? list.split(',') : listOf(list)) {
    const label = inline(lower ? item.toLowerCase() : item, 60)
      .replace(/^#+/, '')
      .replace(/,/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = normal(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.slice(0, 12);
}

/** The labels a note had, as they were, then the new ones it didn't. */
function union(had, more) {
  const keys = new Set(had.map(normal));
  return [...had, ...more.filter((item) => !keys.has(normal(item)) && keys.add(normal(item)))];
}

/** A name for words kept with none given: their first few. */
function firstWords(text) {
  const words = inline(text, 200).split(' ').slice(0, 6).join(' ').replace(/[\s.,;:!?…]+$/, '');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const routineLine = ({ said, does, used }) => {
  const day = dayOf(used);
  return `- “${untag(inline(said, 120))}” → ${untag(inline(does, 200)) || '…'}${day ? ` · last used ${day}` : ''}`;
};

/** An Index line: a link by file name, or by path where two notes share a name, shown by the note's title. */
function indexLine({ rel, title, type, updated }, shared) {
  const name = path.posix.basename(rel).replace(/\.md$/i, '');
  const target = shared ? rel.replace(/\.md$/i, '') : name;
  const shown = inline(title, 120).replace(/[[\]|]/g, '');
  const link = shown && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`;
  const day = dayOf(updated);
  return `- ${link}${typeof type === 'string' && type ? ` · ${inline(type, 40)}` : ''}${day ? ` · updated ${day}` : ''}`;
}

/** Whether score `a` beats `b`, compared in order. */
function better(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The vault at `root` (findVaultRoot's answer). Everything is synchronous: notes are small, and a write reads,
 * changes and writes a note in one go, so two can't interleave.
 * @param {object} options
 * @param {string} options.root  the folder holding `.obsidian`
 * @param {typeof nodeFs} [options.fs]
 * @param {() => number} [options.now]
 */
export function createVault({ root, fs = nodeFs, now = Date.now }) {
  if (typeof root !== 'string' || !root) throw new Error('A vault needs a folder.');
  const base = path.resolve(root);
  const name = path.basename(base);
  /**
   * Jester/ and Notes/ as the disk spells them, read when first needed and again by ensureLayout. A vault whose
   * notes folder was "notes" keeps Jester's notes in it (a Mac's disk doesn't tell Notes from notes), and they're
   * named Notes/… all the same, as everything that reads the vault names them.
   */
  let spelled = null;
  function spelling() {
    if (spelled) return spelled;
    let folders;
    try {
      folders = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
    } catch {
      // Not there, or not readable yet: as Jester spells them, until it is.
      return new Map(WRITES_IN.map((folder) => [folder, folder]));
    }
    const onDisk = (folder) => (folders.includes(folder) ? folder : folders.find((entry) => entry.toLowerCase() === folder.toLowerCase()) || folder);
    spelled = new Map(WRITES_IN.map((folder) => [folder, onDisk(folder)]));
    return spelled;
  }
  /** A note's path from the vault's root as the disk has it: its parts, Jester/ or Notes/ spelled the disk's way. */
  const diskParts = (rel) => {
    const [top, ...rest] = rel.split('/');
    return [spelling().get(top) ?? top, ...rest];
  };
  const abs = (rel) => path.join(base, ...diskParts(rel));
  const exists = (rel) => fs.existsSync(abs(rel));
  /** A time as a Date: ms, an ISO string or a Date; now without one. */
  const dateAt = (at) => {
    const date = new Date(at ?? now());
    return Number.isNaN(date.getTime()) ? new Date(now()) : date;
  };

  /** A note's text, or null when there's none. */
  function textOf(rel) {
    try {
      return fs.readFileSync(abs(rel), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** The vault's own folder, which a write never makes: a vault moved or deleted isn't brought back empty where it was. */
  function present() {
    if (!fs.statSync(base).isDirectory()) throw Object.assign(new Error(`“${base}” isn’t a folder.`), { code: 'ENOTDIR' });
  }

  /**
   * Writes a note whole, only in Jester/ or Notes/: beside it first, then renamed into place. A note that's a link
   * isn't written: renamed over, it would be a copy, and the file it links to would never change again.
   */
  function put(rel, text) {
    if (!writablePath(rel)) throw Object.assign(new Error(`Jester writes only in its Jester and Notes folders, not “${rel}”.`), { code: 'not_writable' });
    present();
    const file = abs(rel);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw Object.assign(new Error(`“${rel}” is a link to a file elsewhere, so Jester won’t change it.`), { code: 'read_only', rel, linked: true });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Under a name of its own, made new: never through a file or link already there.
    const next = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(next, text, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(next, file);
    } catch (err) {
      // What this write made goes, if it can (a .tmp left is no note); a name already taken (EEXIST) was never its.
      if (err.code !== 'EEXIST') {
        try {
          fs.rmSync(next, { force: true });
        } catch {
          /* left behind */
        }
      }
      throw err;
    }
  }

  /** Writes a view Jester keeps whole, when it would say something new: a new `updated` alone isn't. */
  function rewrite(rel, data, body) {
    const old = textOf(rel);
    if (old !== null) {
      const was = parseFrontmatter(old);
      const same = (props) => JSON.stringify({ ...props, updated: null });
      if (was.body === body && same(was.data) === same(data)) return false;
    }
    put(rel, writeFrontmatter(data, body));
    return true;
  }

  /** `<base>.md`, or `<base> 2.md`, `<base> 3.md`…: the first not taken. */
  function unique(rel) {
    for (let n = 1; n < 1000; n++) {
      const next = `${rel}${n > 1 ? ` ${n}` : ''}.md`;
      if (!exists(next)) return next;
    }
    throw new Error(`Too many notes called “${path.posix.basename(rel)}”.`);
  }

  /**
   * Every note: each .md file, in any folder but hidden ones (.obsidian, .trash, .git), and in folders linked into
   * the vault, as Obsidian shows them. Jester/ and Notes/ are named so, however the disk spells them.
   */
  function listNotes() {
    const notes = [];
    const named = new Map([...spelling()].map(([folder, disk]) => [disk, folder]));
    // Where the folders reached through links really are, the vault first. A link is followed to each once, never into
    // the vault or a folder walked already (its notes would be listed twice), nor to one the vault is in (a loop).
    let walked = null;
    const within = (dir, parent) => dir === parent || dir.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
    const linkedFolder = (file) => {
      try {
        if (!fs.statSync(file).isDirectory()) return false;
        walked ??= [fs.realpathSync(base)];
        const real = fs.realpathSync(file);
        if (within(walked[0], real) || walked.some((done) => within(real, done))) return false;
        walked.push(real);
        return true;
      } catch {
        return false; // a link to nothing
      }
    };
    const walk = (dir, rel, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // The vault itself unreadable is said, so it can be told apart from empty; a folder in it is skipped.
        if (!rel) throw err;
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        const at = rel ? `${rel}/${entry.name}` : named.get(entry.name) ?? entry.name;
        if (entry.isDirectory() || (entry.isSymbolicLink() && linkedFolder(file))) {
          if (depth < MAX_DEPTH) walk(file, at, depth + 1);
        } else if (/\.md$/i.test(entry.name)) {
          try {
            const stat = fs.statSync(file);
            if (stat.isFile()) notes.push({ rel: at, abs: file, mtimeMs: stat.mtimeMs, size: stat.size });
          } catch {
            /* gone since it was listed */
          }
        }
      }
    };
    walk(base, '', 0);
    return notes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /** A note, anywhere in the vault: {rel, title, data, body}. Throws as reading a file does. */
  function read(rel) {
    const clean = relPath(rel);
    if (!clean) throw Object.assign(new Error(`“${rel}” isn’t a note in the vault.`), { code: 'bad_path' });
    const { data, body } = parseFrontmatter(fs.readFileSync(abs(clean), 'utf8'));
    return { rel: clean, title: titleOf(clean, data, body), data, body };
  }

  /** Every note as the Index lists it. */
  function catalog() {
    return listNotes().flatMap((note) => {
      try {
        const { title, data } = read(note.rel);
        return [{ rel: note.rel, title, type: typeof data.type === 'string' ? data.type : '', updated: data.updated ?? note.mtimeMs }];
      } catch {
        return [];
      }
    });
  }

  /** The note called `title` (findNote, below), leaving out any whose path `skip` picks. */
  function findNote(title, skip = () => false) {
    const asked = noteTitle(title);
    const said = normal(asked);
    if (!said) return null;
    // As said, and as a file name would have it: "Plan: week 1" is "Plan week 1.md", "Lab #3" "Lab 3.md", "C# notes" "C sharp notes.md".
    const wanted = new Set([said, normal(safeTitle(asked))]);
    let best = null;
    for (const note of listNotes()) {
      if (skip(note.rel)) continue;
      let rank = wanted.has(normal(path.posix.basename(note.rel).replace(/\.md$/i, ''))) ? 3 : 0;
      if (!rank) {
        let found;
        try {
          found = read(note.rel);
        } catch {
          continue;
        }
        rank = wanted.has(normal(found.title)) ? 2 : listOf(found.data.aliases).some((alias) => wanted.has(normal(alias))) ? 1 : 0;
      }
      if (!rank) continue;
      // Notes/ first, then a file name over a title over an alias, then nearer the top, then the latest.
      const score = [inNotes(note.rel) ? 1 : 0, rank, -note.rel.split('/').length, note.mtimeMs];
      if (!best || better(score, best.score)) best = { rel: note.rel, score };
    }
    return best && { rel: best.rel, writable: inNotes(best.rel) };
  }

  return {
    root: base,
    name,
    listNotes,
    read,
    /** Whether Jester may write `rel`: a normalized relative path inside Jester/ or Notes/. */
    writable: writablePath,

    /** Jester/ and Notes/, About me and the readme: made when missing, so it's idempotent. Says which notes it wrote. */
    ensureLayout() {
      present();
      spelled = null;
      for (const folder of WRITES_IN) fs.mkdirSync(abs(folder), { recursive: true });
      const wrote = [];
      if (!exists(PATHS.aboutMe)) {
        put(PATHS.aboutMe, aboutMeTemplate(isoDate(dateAt())));
        wrote.push(PATHS.aboutMe);
      }
      if (rewrite(PATHS.readme, { type: 'readme', tags: ['jester/system'] }, README)) wrote.push(PATHS.readme);
      return wrote;
    },

    /** What About me says: its facts by section (comments left out), and its text for a model. */
    aboutMe() {
      const text = textOf(PATHS.aboutMe);
      if (text === null) return { facts: [], text: '' };
      const { body } = parseFrontmatter(text);
      return { facts: factLines(body.split('\n')).map(({ section, fact }) => ({ section, fact })), text: aboutText(body) };
    },

    /**
     * Adds facts to About me's sections and removes facts, matched as normal() has them, so a fact already there
     * isn't added twice. Nothing else in the note changes but `updated`. Made from the template when missing.
     * @param {{add?:{section:string, fact:string}[], remove?:string[]}} changes
     * @param {number|string|Date} [at]
     * @returns {{added:number, removed:number}}
     */
    updateAboutMe({ add = [], remove = [] } = {}, at) {
      const day = isoDate(dateAt(at));
      const old = textOf(PATHS.aboutMe);
      const text = old ?? aboutMeTemplate(day);
      const eol = eolOf(text);
      const note = splitNote(text);
      let lines = (note ? note.body : text).split('\n');
      const gone = new Set(listOf(remove).map((fact) => normal(fact.replace(COMMENT, ''))).filter(Boolean));
      const drop = new Set(factLines(lines).filter(({ fact }) => gone.has(normal(fact))).map(({ index }) => index));
      lines = lines.filter((line, index) => !drop.has(index));
      const have = new Set(factLines(lines).map(({ fact }) => normal(fact)));
      let added = 0;
      for (const item of Array.isArray(add) ? add : []) {
        const fact = cleanFact(item?.fact);
        if (!normal(fact) || have.has(normal(fact))) continue;
        have.add(normal(fact));
        lines = withFact(lines, sectionFor(item.section), `- ${fact} <!-- noted ${day} -->`, eol);
        added++;
      }
      if (old !== null && !added && !drop.size) return { added: 0, removed: 0 };
      const changed = added || drop.size ? withProperties(withBody(text, lines.join('\n')), { updated: day }) : text;
      put(PATHS.aboutMe, changed);
      return { added, removed: drop.size };
    },

    /**
     * A conversation's section in its day's note (made when missing), whose topics and people are the day's together.
     * @param {{at?:number|string|Date, title?:string, summary?:string, topics?:string[], people?:string[]}} conversation
     * @returns {string} the day's note
     */
    addConversation({ at, title, summary, topics = [], people = [] } = {}) {
      const date = dateAt(at);
      const day = isoDate(date);
      const rel = `${PATHS.conversations}/${date.getFullYear()}/${day}.md`;
      const topicList = labels(topics, true);
      const peopleList = labels(people);
      const section = [
        `## ${clock(date)} · ${headingText(title) || 'A conversation'}`,
        ...(inline(summary, 600) ? [`Summary: ${inline(summary, 600)}`] : []),
        `Topics: ${topicList.join(', ') || 'none'}`,
        `People: ${peopleList.join(', ') || 'none'}`
      ];
      const old = textOf(rel);
      if (old === null) {
        const data = { type: 'conversations', date: day, tags: ['jester/conversation'], topics: topicList, people: peopleList };
        put(rel, writeFrontmatter(data, `# Conversations on ${longDate(date)}\n\n${section.join('\n')}\n`));
        return rel;
      }
      const { data } = parseFrontmatter(old);
      const props = {};
      for (const [key, list] of [['topics', topicList], ['people', peopleList]]) {
        const had = listOf(data[key]);
        const both = union(had, list);
        if (both.length > had.length) props[key] = both;
      }
      put(rel, withProperties(appendBlock(old, section), props));
      return rel;
    },

    /**
     * Words the user asked Jester to remember, kept as they were said, in a note of their own.
     * @param {{at?:number|string|Date, title?:string, text:string, topics?:string[]}} kept
     * @returns {string} the new note
     */
    remember({ at, title, text, topics = [] } = {}) {
      const words = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .trim();
      if (!words) throw new Error('There’s nothing to remember.');
      const date = dateAt(at);
      const named = headingText(title) || firstWords(words);
      const rel = unique(`${PATHS.remembered}/${isoDate(date)} ${safeTitle(named)}`);
      const quote = words
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');
      const data = { type: 'remembered', created: isoTime(date), tags: ['jester/remembered'], topics: labels(topics, true) };
      put(rel, writeFrontmatter(data, `# ${named}\n\n${quote}\n\nSaid to Jester on ${longDate(date)} at ${clock(date)}.\n`));
      return rel;
    },

    /**
     * The note called `title`, anywhere in the vault: by file name, title or alias, case and punctuation aside (but not
     * + and #: "C++ notes" aren't "C notes"). writable is whether Jester may add to it when asked: whether it's in Notes/.
     * @returns {{rel:string, writable:boolean}|null}
     */
    findNote: (title) => findNote(title),

    /**
     * Adds to the user's note in Notes/ called `title`, or makes it when there's none anywhere. One line is added as a
     * list item, more as a paragraph. A note of that name outside Notes/ is the user's, and so is About me: throws, code
     * 'read_only', as it does for a note that's a link (put), with `linked` set. Jester's other notes don't count.
     * @param {{title:string, text?:string, at?:number|string|Date}} request
     * @returns {{rel:string, created:boolean}}
     */
    addToNote({ title, text, at } = {}) {
      const asked = noteTitle(title);
      if (!normal(asked)) throw Object.assign(new Error('A note needs a name.'), { code: 'no_title' });
      const time = isoTime(dateAt(at));
      // Jester's records and views aren't notes the user keeps, so they don't stop one being made: what it remembered as
      // "Grocery list" isn't their grocery list, and Routines is rewritten whole. About me still counts: Jester reads facts
      // only from its own, so a second one in Notes/ would mislead.
      const found = findNote(asked, (rel) => rel.startsWith('Jester/') && rel !== PATHS.aboutMe);
      if (found && !found.writable) {
        throw Object.assign(new Error(`“${asked}” isn’t in your Notes folder, so Jester can’t change it.`), { code: 'read_only', rel: found.rel });
      }
      const addition = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .trim();
      if (found) {
        if (addition) put(found.rel, withProperties(appendTo(textOf(found.rel) ?? '', addition), { updated: time }));
        return { rel: found.rel, created: false };
      }
      const rel = unique(`${PATHS.notes}/${safeTitle(asked)}`);
      const heading = `# ${headingText(asked)}\n`;
      put(rel, writeFrontmatter({ type: 'note', tags: ['note'], created: time, updated: time }, addition ? appendTo(heading, addition) : heading));
      return { rel, created: true };
    },

    /** The link that opens a note in Obsidian, by its path as the disk spells it. */
    openUrl(rel) {
      return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(diskParts(String(rel ?? '')).join('/').replace(/\.md$/i, ''))}`;
    },

    /**
     * Routines.md, rewritten: what Jester does with no model, by kind (learned.js list()).
     * @param {{kind:'task'|'alias'|'phrase', said:string, does:string, used?:number}[]} items
     * @returns {string} the note
     */
    writeRoutines(items = []) {
      const known = new Set(ROUTINE_KINDS.map(([kind]) => kind));
      const lines = ['# Routines', '', ROUTINES_INTRO];
      for (const [kind, heading, about] of ROUTINE_KINDS) {
        const mine = (Array.isArray(items) ? items : [])
          .filter((item) => inline(item?.said) && (item.kind === kind || (kind === 'task' && !known.has(item.kind))))
          .sort((a, b) => (Number(b.used) || 0) - (Number(a.used) || 0) || inline(a.said).localeCompare(inline(b.said)));
        lines.push('', `## ${heading}`, about, ...(mine.length ? mine.map(routineLine) : ['None yet.']));
      }
      rewrite(PATHS.routines, { type: 'routines', tags: ['jester/system'], updated: isoDate(dateAt()) }, `${lines.join('\n')}\n`);
      return PATHS.routines;
    },

    /**
     * Index.md, rewritten: a map of the vault by top folder, with links. Without `notes`, the vault is read for them.
     * @param {{rel:string, title?:string, type?:string, updated?:string|number}[]} [notes]
     * @returns {string} the note
     */
    writeIndex(notes) {
      const all = (Array.isArray(notes) ? notes : catalog()).filter((note) => relPath(note?.rel) && note.rel !== PATHS.index);
      const nameOf = (rel) => path.posix.basename(rel).replace(/\.md$/i, '').toLowerCase();
      // The Index isn't listed, but it is a note: one of the user's called Index is linked by its path, not to the Index.
      const names = new Map([[nameOf(PATHS.index), 1]]);
      for (const note of all) names.set(nameOf(note.rel), (names.get(nameOf(note.rel)) || 0) + 1);
      const groups = new Map();
      for (const note of [...all].sort((a, b) => a.rel.localeCompare(b.rel))) {
        const top = note.rel.includes('/') ? note.rel.split('/')[0] : '';
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top).push(indexLine(note, names.get(nameOf(note.rel)) > 1));
      }
      const order = [...groups.keys()].sort((a, b) => (!a ? -1 : !b ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' })));
      const count = `${all.length} note${all.length === 1 ? '' : 's'}`;
      const lines = ['# Index', '', `A map of this vault, folder by folder: ${count}. Jester rewrites it as the vault changes.`];
      for (const top of order) lines.push('', `## ${top || 'Top level'}`, ...groups.get(top));
      rewrite(PATHS.index, { type: 'index', tags: ['jester/system'], updated: isoDate(dateAt()) }, `${lines.join('\n')}\n`);
      return PATHS.index;
    }
  };
}
