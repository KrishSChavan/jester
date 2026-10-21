/**
 * Packs jester-extension/ for the Chrome Web Store: checks it, then writes
 * dist/jester-extension-<version>.zip with manifest.json at the root of the
 * zip, which is where the Web Store looks for it.
 *
 * The cross-platform counterpart of build-zip.ps1, with the same checks and the
 * same files left out. It adds the Web Store's own limits on the manifest, which
 * an upload otherwise reports only after it fails, and it refuses to pack
 * anything shaped like an API key: keys belong in Settings, never in the zip.
 *
 *   npm run zip
 *   node build-zip.mjs --out path/to/jester.zip
 *
 * Nothing to install: zlib compresses, and the zip container is written here.
 */

import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateRawSync, crc32 } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const SOURCE = resolve(ROOT, 'jester-extension');

/** Matched against each file's path inside the extension. None of these ship. */
const LEFT_OUT = [
  // Dotfiles and dot-folders: .env (legacy flag files that once carried an API
  // key), .env.example, .DS_Store, .git, editor settings.
  /(?:^|\/)\./,
  // The mirror build-zip.ps1 kept of .env, for the same reason.
  /(?:^|\/)env\.txt$/,
  // Documentation, source maps and type declarations: nothing loads them.
  /(?:^|\/)README\.md$/,
  /\.map$/,
  /\.d\.ts$/,
  // The old finger-steering engine stays in the source, but nothing loads it.
  /^src\/offscreen\/legacy-finger-pointer\.js$/,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)(?:Thumbs\.db|desktop\.ini)$/,
  /\.(?:zip|orig|rej)$/,
  /~$/
];

/**
 * Fetched by MediaPipe from the folder offscreen.js hands it, so nothing else
 * names these files.
 */
const MEDIAPIPE_RUNTIME = [
  'vendor/tasks-vision/wasm/vision_wasm_internal.js',
  'vendor/tasks-vision/wasm/vision_wasm_internal.wasm'
];

/** The API keys Jester's providers issue. A build that finds one stops, and never prints it. */
const KEY_SHAPES = [
  ['a Groq key', /\bgsk_[A-Za-z0-9]{20,}/],
  ['an OpenAI or Anthropic key', /(?<![\w-])sk-[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['an xAI key', /\bxai-[A-Za-z0-9]{20,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
];

const TEXT = /\.(?:js|mjs|json|html|css|txt|md|svg)$/;

/** Every problem with the manifest that the Web Store would refuse the upload for. */
export function storeProblems(manifest) {
  const problems = [];
  const length = (text) => [...String(text)].length;
  // A __MSG_name__ placeholder is measured in _locales, not here.
  const localized = (text) => /^__MSG_\w+__$/.test(String(text));

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version is ${manifest.manifest_version}; the Web Store only accepts 3`);
  }
  if (!manifest.name) {
    problems.push('name is missing');
  } else if (!localized(manifest.name) && length(manifest.name) > 75) {
    problems.push(`name is ${length(manifest.name)} characters; the Web Store allows 75`);
  }
  if (!manifest.description) {
    problems.push('description is missing; the Web Store shows it as the listing summary');
  } else if (!localized(manifest.description) && length(manifest.description) > 132) {
    problems.push(`description is ${length(manifest.description)} characters; the Web Store allows 132`);
  }
  const version = String(manifest.version ?? '');
  if (!/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(version) ||
      version.split('.').some((part) => Number(part) > 65535)) {
    problems.push(`version "${version}" must be one to four dot-separated numbers from 0 to 65535, without leading zeros`);
  }
  if (!manifest.icons?.['128']) problems.push('icons has no 128 entry; the Web Store needs a 128x128 icon');
  return problems;
}

/** Names of the key shapes found in `text`, never the keys themselves. */
export function keyShapes(text) {
  return KEY_SHAPES.filter(([, shape]) => shape.test(text)).map(([name]) => name);
}

/** Paths inside the extension, with forward slashes, of every file that ships. */
async function collect(folder = SOURCE, found = { shipped: [], leftOut: [] }) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = resolve(folder, entry.name);
    const path = relative(SOURCE, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (LEFT_OUT.some((rule) => rule.test(`${path}/`))) found.leftOut.push(`${path}/`);
      else await collect(full, found);
    } else if (entry.isFile()) {
      (LEFT_OUT.some((rule) => rule.test(path)) ? found.leftOut : found.shipped).push(path);
    }
  }
  return found;
}

/** Every path the manifest names, as [path, which field names it]. */
function manifestPaths(manifest) {
  const paths = [];
  const add = (path, field) => { if (typeof path === 'string' && path) paths.push([path, field]); };
  const addAll = (map, field) => {
    if (typeof map === 'string') add(map, field);
    else for (const [key, path] of Object.entries(map ?? {})) add(path, `${field} ${key}`);
  };

  add(manifest.background?.service_worker, 'background.service_worker');
  add(manifest.action?.default_popup, 'action.default_popup');
  addAll(manifest.action?.default_icon, 'action.default_icon');
  addAll(manifest.icons, 'icons');
  add(manifest.options_ui?.page, 'options_ui.page');
  add(manifest.options_page, 'options_page');
  add(manifest.side_panel?.default_path, 'side_panel.default_path');
  add(manifest.devtools_page, 'devtools_page');
  addAll(manifest.chrome_url_overrides, 'chrome_url_overrides');
  (manifest.content_scripts ?? []).forEach((script, index) => {
    for (const path of script.js ?? []) add(path, `content_scripts[${index}].js`);
    for (const path of script.css ?? []) add(path, `content_scripts[${index}].css`);
  });
  for (const entry of manifest.web_accessible_resources ?? []) {
    // Globs can't be checked one file at a time; literal entries can.
    for (const path of entry.resources ?? []) if (!/[*?]/.test(path)) add(path, 'web_accessible_resources');
  }
  return paths;
}

/** Width and height from a PNG's header, or null when the file isn't a PNG. */
function pngSize(data) {
  if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a' || data.toString('latin1', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

async function check(manifest, shipped, leftOut) {
  const problems = storeProblems(manifest).map((problem) => `manifest: ${problem}`);
  const files = new Set(shipped);
  const folders = new Set(shipped.flatMap((path) =>
    path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
  const text = new Map();
  for (const path of shipped.filter((path) => TEXT.test(path))) text.set(path, await readFile(resolve(SOURCE, path), 'utf8'));
  let references = 0;

  /** A path inside the extension: may start with "/" and carry a ?query or #hash. */
  const clean = (path) => posix.normalize(path.split(/[?#]/)[0].replace(/^\//, ''));
  const need = (path, where, { folder = false } = {}) => {
    references += 1;
    const file = clean(path);
    if (files.has(file) || (folder && folders.has(file))) return;
    problems.push(`${where} names '${path}', which ${leftOut.includes(file) ? 'the zip leaves out' : 'does not exist'}`);
  };

  for (const [path, field] of manifestPaths(manifest)) need(path, `manifest ${field}`);

  // Icons: the Web Store and Chrome both expect each to be the size its key says.
  const declared = typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : {};
  const icons = [...Object.entries(manifest.icons ?? {}), ...Object.entries(declared)];
  for (const [size, path] of icons) {
    if (!files.has(clean(path))) continue;
    const found = pngSize(await readFile(resolve(SOURCE, clean(path))));
    if (!found) problems.push(`icon ${size} ('${path}') is not a PNG`);
    else if (found.width !== Number(size) || found.height !== Number(size)) {
      problems.push(`icon ${size} ('${path}') is ${found.width}x${found.height}`);
    }
  }

  // Every local src= and href= in the extension's pages.
  for (const [page, html] of text) {
    if (!page.endsWith('.html')) continue;
    for (const [, ref] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
      need(ref.startsWith('/') ? ref : posix.join(posix.dirname(page), ref), page);
    }
  }

  const imports = /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  const loaded = /["'`]((?:src|icons|models|vendor)\/[\w./-]+?)(?:[?#][^"'`]*)?["'`]/g;
  for (const [script, source] of text) {
    if (!/\.m?js$/.test(script)) continue;
    // Relative imports, re-exports and dynamic imports.
    for (const [, from, dynamic] of source.matchAll(imports)) {
      need(posix.join(posix.dirname(script), from || dynamic), `${script} (import)`);
    }
    // Files the code loads by path at runtime: getURL(), executeScript(), the offscreen page.
    if (!script.startsWith('src/')) continue;
    for (const [, path] of source.matchAll(loaded)) need(path, script, { folder: true });
  }
  for (const path of MEDIAPIPE_RUNTIME) need(path, 'MediaPipe at runtime');

  // Every first-party script parses. Vendor code is MediaPipe's own build.
  const node = promisify(execFile);
  const scripts = shipped.filter((path) => path.startsWith('src/') && path.endsWith('.js'));
  await Promise.all(scripts.map(async (path) => {
    try {
      await node(process.execPath, ['--check', resolve(SOURCE, path)]);
    } catch (error) {
      const detail = String(error.stderr || error.message).trim().split('\n').slice(0, 4).join(' ');
      problems.push(`${path} does not parse: ${detail}`);
    }
  }));

  for (const [path, contents] of text) {
    for (const shape of keyShapes(contents)) problems.push(`${path} contains what looks like ${shape}. Keys go in Settings, never in the package`);
  }

  return { problems, references, scripts: scripts.length, icons: icons.length };
}

/** The DOS date and time a zip records, in local time. */
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * A zip of `entries` ({ name, data, modified }): deflated where that helps,
 * stored where it doesn't (PNGs, the .task models), UTF-8 names, no zip64.
 */
export function zip(entries) {
  if (entries.length > 0xffff) throw new Error('Too many files for a zip without zip64.');
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const { name, data, modified } of entries) {
    const path = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const { time, date } = dosTime(modified);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, path, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    // Extra field, comment, disk and internal attributes stay zero.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);

    offset += local.length + path.length + body.length;
    if (offset > 0xffffffff) throw new Error('Too large for a zip without zip64.');
  }

  const size = directory.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

/**
 * Checks the extension and writes the zip. Throws, with every problem listed
 * and nothing written, when a check fails.
 */
export async function build({ out } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(SOURCE, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`manifest.json could not be read: ${error.message}`);
  }

  const { shipped, leftOut } = await collect();
  shipped.sort();
  const checked = await check(manifest, shipped, leftOut);
  if (checked.problems.length) {
    const error = new Error(`Nothing was written. Fix these first:\n${checked.problems.map((problem) => `  x ${problem}`).join('\n')}`);
    error.problems = checked.problems;
    throw error;
  }

  const entries = [];
  for (const name of shipped) {
    const full = resolve(SOURCE, name);
    entries.push({ name, data: await readFile(full), modified: (await stat(full)).mtime });
  }
  const archive = zip(entries);

  const target = out ? resolve(out) : resolve(ROOT, 'dist', `jester-extension-${manifest.version}.zip`);
  await mkdir(dirname(target), { recursive: true });
  // Written beside the target and swapped in, so a failure leaves the last zip whole.
  await writeFile(`${target}.building`, archive);
  await rename(`${target}.building`, target);

  return {
    out: target,
    manifest,
    files: shipped,
    leftOut: leftOut.sort(),
    bytes: entries.reduce((total, entry) => total + entry.data.length, 0),
    size: archive.length,
    ...checked
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  if (args.length && !(args.length === 2 && outAt === 0)) {
    console.error('Usage: node build-zip.mjs [--out path/to/file.zip]');
    process.exit(2);
  }
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  try {
    const report = await build({ out: outAt === 0 ? args[1] : undefined });
    const { manifest } = report;
    console.log(`Jester ${manifest.version}`);
    console.log('  checks passed');
    console.log(`    - manifest within the Web Store's limits (description ${[...manifest.description].length}/132 characters)`);
    console.log(`    - ${report.references} paths named by the manifest, pages and scripts are all in the zip`);
    console.log(`    - ${report.icons} icons are PNGs of their declared sizes; ${report.scripts} scripts parse`);
    console.log('    - nothing shaped like an API key');
    console.log(`Wrote ${relative(process.cwd(), report.out) || report.out}`);
    console.log("  layout:  manifest.json at the root, as the Web Store needs");
    console.log(`  files:   ${report.files.length} (${mb(report.bytes)} -> ${mb(report.size)} compressed)`);
    console.log(`  left out ${report.leftOut.length}:`);
    for (const path of report.leftOut) console.log(`    - ${path}`);
    console.log('Upload it at https://chrome.google.com/webstore/devconsole');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
