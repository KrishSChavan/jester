import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appChanges, build, BUNDLE_ID, helperChanges, helperName, USAGE } from '../desktop/scripts/jester-app.mjs';
import { art, COLOURS, icoFile } from '../desktop/scripts/make-icons.mjs';
import { listedAsFor } from '../desktop/src/main/permission-list.js';

test('Electron\'s helpers take Jester\'s name, kind and all; nothing else is a helper', () => {
  assert.equal(helperName('Electron Helper'), 'Jester Helper');
  assert.equal(helperName('Electron Helper (Renderer)'), 'Jester Helper (Renderer)');
  assert.equal(helperName('Electron Helper (GPU)'), 'Jester Helper (GPU)');
  assert.equal(helperName('Electron Framework'), null);
  assert.equal(helperName('Squirrel'), null);
  assert.deepEqual(Object.fromEntries(helperChanges('Jester Helper (GPU)')), {
    CFBundleName: 'Jester Helper (GPU)',
    CFBundleDisplayName: 'Jester Helper (GPU)',
    CFBundleExecutable: 'Jester Helper (GPU)',
    CFBundleIdentifier: `${BUNDLE_ID}.helper`
  });
});

test('the app is named Jester, with his icon and his reasons, and keeps Electron\'s executable', () => {
  const changes = Object.fromEntries(appChanges({ version: '0.1.0', made: 'recipe' }));
  assert.equal(changes.CFBundleName, 'Jester');
  assert.equal(changes.CFBundleDisplayName, 'Jester');
  assert.equal(changes.CFBundleIdentifier, 'com.jester.desktop');
  assert.equal(changes.CFBundleIconFile, 'Jester.icns');
  // Electron sets app.isPackaged by the executable's name: from source, he isn't.
  assert.equal(changes.CFBundleExecutable, undefined);
  for (const [key, why] of Object.entries(USAGE)) {
    assert.equal(changes[key], why);
    assert.match(why, /^Jester /);
  }
});

test('System Settings names the bundle that runs him, when it isn\'t Jester', () => {
  assert.equal(listedAsFor('/x/desktop/app.noindex/Jester.app/Contents/MacOS/Electron', 'darwin'), '');
  assert.equal(listedAsFor('/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'darwin'), 'Electron');
  assert.equal(listedAsFor('/Applications/Jester.app/Contents/MacOS/Jester', 'darwin'), '');
  assert.equal(listedAsFor('C:\\Jester\\electron.exe', 'win32'), '');
  assert.equal(listedAsFor('/usr/bin/node', 'darwin'), '');
});

test('the icon: macOS\'s grid with room for its shadow, Windows\' edge to edge, the small sizes without the dots', () => {
  const dots = (svg) => (svg.match(/<circle [^>]*fill-opacity=/g) || []).length;
  const mac = art({ inset: 100, lifted: true });
  assert.match(mac, /^<svg [^>]*viewBox="0 0 1024 1024"/);
  assert.match(mac, new RegExp(`^<path d="M[^"]*" fill="${COLOURS.ground}" filter="url\\(#lift\\)"/>$`, 'm'));
  // The rounded square starts on its top edge, 100 in.
  assert.match(mac, /<clipPath id="shape"><path d="M\d+\.\d+ 100\.00L/);
  assert.ok(dots(mac) > 300);
  // The head is lines, tipped 15° to the right, and the dots stop at its edge.
  assert.match(mac, new RegExp(`<g fill="none" stroke="${COLOURS.line}" stroke-width="22"`));
  assert.match(mac, /<g transform="translate\([\d ]+\) rotate\(15\) /);
  assert.match(mac, /<g fill="[^"]+" mask="url\(#head\)">/);
  const windows = art({ inset: 24, lifted: false });
  assert.doesNotMatch(windows, /filter="url\(#lift\)"/);
  assert.match(windows, /<clipPath id="shape"><path d="M\d+\.\d+ 24\.00L/);
  const small = art({ small: true });
  // No dots, and a heavier line.
  assert.equal(dots(small), 0);
  assert.doesNotMatch(small, /id="head"/);
  assert.match(small, new RegExp(`stroke="${COLOURS.line}" stroke-width="40"`));
});

test('a .ico is a directory of PNGs: 256 written as 0, offsets past the directory', () => {
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n)]);
  const file = icoFile([{ size: 16, png: png(10) }, { size: 256, png: png(20) }]);
  assert.deepEqual([file.readUInt16LE(0), file.readUInt16LE(2), file.readUInt16LE(4)], [0, 1, 2]);
  assert.deepEqual([file[6], file[7], file.readUInt16LE(12), file.readUInt32LE(14), file.readUInt32LE(18)], [16, 16, 32, 14, 38]);
  assert.deepEqual([file[22], file[23], file.readUInt32LE(30), file.readUInt32LE(34)], [0, 0, 24, 52]);
  assert.equal(file.length, 6 + 32 + 14 + 24);
  assert.equal(file.subarray(52, 56).toString('latin1'), '\x89PNG');
});

test('Jester.app is made from an Electron.app: renamed helpers, his plist, his icon', { skip: process.platform !== 'darwin' && 'plutil is macOS\'s' }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-app-test-'));
  try {
    const from = path.join(scratch, 'Electron.app');
    const plist = (file, entries) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>');
      for (const [key, value] of entries) execFileSync('plutil', ['-replace', key, '-string', value, file]);
    };
    plist(path.join(from, 'Contents/Info.plist'), [['CFBundleName', 'Electron'], ['CFBundleExecutable', 'Electron'], ['CFBundleIconFile', 'electron.icns']]);
    fs.mkdirSync(path.join(from, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(from, 'Contents/MacOS/Electron'), 'main');
    fs.mkdirSync(path.join(from, 'Contents/Resources'), { recursive: true });
    fs.writeFileSync(path.join(from, 'Contents/Resources/electron.icns'), 'old icon');
    for (const helper of ['Electron Helper', 'Electron Helper (Renderer)']) {
      plist(path.join(from, `Contents/Frameworks/${helper}.app/Contents/Info.plist`), [['CFBundleName', helper], ['CFBundleExecutable', helper], ['CFBundleIdentifier', 'com.github.Electron.helper']]);
      fs.mkdirSync(path.join(from, `Contents/Frameworks/${helper}.app/Contents/MacOS`), { recursive: true });
      fs.writeFileSync(path.join(from, `Contents/Frameworks/${helper}.app/Contents/MacOS/${helper}`), helper);
    }
    fs.mkdirSync(path.join(from, 'Contents/Frameworks/Electron Framework.framework'), { recursive: true });
    const icon = path.join(scratch, 'Jester.icns');
    fs.writeFileSync(icon, 'new icon');

    const target = path.join(scratch, 'out/Jester.app');
    build(target, { version: '9.9.9', made: 'the test', from, icon });
    const read = (file, key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(target, file)], { encoding: 'utf8' }).trim();
    assert.equal(read('Contents/Info.plist', 'CFBundleName'), 'Jester');
    assert.equal(read('Contents/Info.plist', 'CFBundleIdentifier'), 'com.jester.desktop');
    assert.equal(read('Contents/Info.plist', 'CFBundleExecutable'), 'Electron');
    assert.equal(read('Contents/Info.plist', 'CFBundleShortVersionString'), '9.9.9');
    assert.equal(read('Contents/Info.plist', 'JesterMadeFrom'), 'the test');
    assert.equal(fs.readFileSync(path.join(target, 'Contents/Resources/Jester.icns'), 'utf8'), 'new icon');
    assert.equal(fs.existsSync(path.join(target, 'Contents/Resources/electron.icns')), false);
    assert.deepEqual(fs.readdirSync(path.join(target, 'Contents/Frameworks')).sort(), ['Electron Framework.framework', 'Jester Helper (Renderer).app', 'Jester Helper.app']);
    const renderer = 'Contents/Frameworks/Jester Helper (Renderer).app';
    assert.equal(fs.readFileSync(path.join(target, renderer, 'Contents/MacOS/Jester Helper (Renderer)'), 'utf8'), 'Electron Helper (Renderer)');
    assert.equal(read(`${renderer}/Contents/Info.plist`, 'CFBundleExecutable'), 'Jester Helper (Renderer)');
    assert.equal(read(`${renderer}/Contents/Info.plist`, 'CFBundleIdentifier'), 'com.jester.desktop.helper');
    // The source is untouched, and nothing is left from the building.
    assert.ok(fs.existsSync(path.join(from, 'Contents/Frameworks/Electron Helper.app')));
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'out')), ['Jester.app']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
