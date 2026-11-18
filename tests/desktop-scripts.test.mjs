import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aimSaid, checkManifest, doneLine, insidePath, manifestText, readManifest, stepArgs } from '../desktop/src/main/script-manifest.js';
import { matchWords, mentions, blockWords, plainWords, sceneAsked } from '../desktop/src/main/script-words.js';
import { commandFor, createScriptRunner, scriptEnv } from '../desktop/src/main/script-runner.js';
import { createScripts, failureLine, outcomeOf, resultLines, sliderPresets, stateFor, stateIn } from '../desktop/src/main/scripts.js';
import { draftManifest, folderPicture, helpTarget } from '../desktop/src/main/script-draft.js';
import { askModel, createConversation, personaPrompt } from '../desktop/src/main/conversation.js';
import { createTasks } from '../desktop/src/main/tasks.js';
import { parseCommand } from '../desktop/src/main/voice-commands.js';
import { createVoiceRunner } from '../desktop/src/main/voice-runner.js';
import { trayModel } from '../desktop/src/main/tray-menu.js';
import { abilitiesPart } from '../desktop/src/main/abilities.js';

/** A manifest like the lights' (the user's ~/bluetooth lights/jester.json), cut down. */
const LIGHTS = {
  jester: 1,
  name: 'Lights',
  icon: 'bulb',
  about: 'Cync bulbs at home and at college.',
  run: 'lights',
  serve: ['serve', '--idle', '60'],
  status: ['status', '--json'],
  aim: {
    label: 'Which lights',
    all: 'lights',
    choices: [
      { label: 'All', value: '' },
      { label: 'Bedside', value: 'Bedside', said: 'Bedside lights', words: ['bed'] },
      { label: 'Brown', value: 'Brown', said: 'Brown lights' },
      { label: 'Brown Main', value: 'Brown Main', chip: false },
      { label: 'Krish’s Bedroom', value: 'Krish’s Bedroom', said: 'bedroom lights', chip: false, words: ['bedroom'] }
    ]
  },
  controls: [
    { id: 'on', kind: 'button', label: 'On', args: ['on', '{aim}'], lit: { power: true }, done: '{aim} on.', words: ['turn on the {aim?} lights', 'turn the {aim?} lights on', '{aim?} lights on', 'turn on {aim}'] },
    { id: 'off', kind: 'button', label: 'Off', args: ['off', '{aim}'], lit: { power: false }, done: '{aim} off.', words: ['turn off the {aim?} lights', 'turn the {aim?} lights off', '{aim?} lights off', 'lights out', 'turn off {aim}'] },
    { id: 'brightness', kind: 'slider', label: 'Brightness', min: 1, max: 100, unit: '%', track: 'brightness', args: ['brightness', '{value}', '{aim}'], drag: ['--quick'], done: '{aim} at {value}%.', words: ['dim the {aim?} lights to {value}', 'set the {aim?} lights to {value}', 'set {aim} to {value}'] },
    { id: 'temp', kind: 'slider', label: 'White', min: 0, max: 100, low: 'Warm', high: 'Cool', track: 'warmth', args: ['temp', '{value}', '{aim}'], names: [{ at: 0, name: 'warm white' }, { at: 34, name: 'neutral white' }, { at: 67, name: 'cool white' }], done: '{aim} set to {name}.', words: [{ say: 'make the {aim?} lights warm', value: 0 }, { say: 'make the {aim?} lights cool', value: 100 }] },
    { id: 'color', kind: 'choices', label: 'Color', choices: [{ label: 'Red', value: 'red', color: '#ff453a' }, { label: 'Pink', value: 'pink', color: '#ff5fa2' }], args: ['color', '{value}', '{aim}'], done: '{aim} set to {value}.', words: ['make the {aim?} lights {value}', 'set the {aim?} lights to {value}'] },
    { id: 'status', kind: 'ask', label: 'What’s on', args: ['status', '--json'], words: ['are the {aim?} lights on', 'which lights are on'] }
  ]
};
const lights = () => checkManifest(structuredClone(LIGHTS)).manifest;

// ——— jester.json ———

test('a jester.json is checked: what can run is kept, and what can’t is left out with a reason', () => {
  const { manifest, problems } = checkManifest(structuredClone(LIGHTS));
  assert.deepEqual(problems, []);
  assert.equal(manifest.name, 'Lights');
  assert.deepEqual(manifest.controls.map((control) => control.id), ['on', 'off', 'brightness', 'temp', 'color', 'status']);
  assert.equal(manifest.aim.choices[0].value, '', 'All comes first');
  const broken = checkManifest({
    name: 'Broken',
    run: 'go.sh',
    controls: [
      { kind: 'button', label: 'Fine', args: ['go'] },
      { kind: 'button', label: 'No command', args: [] },
      { kind: 'slider', label: 'No range', args: ['set', '{value}'] },
      { kind: 'button', label: 'Odd slot', args: ['go', '{room}'] },
      { kind: 'choices', label: 'No choices', args: ['pick', '{value}'] },
      { kind: 'button', label: 'Wants a value', args: ['set', '{value}'] },
      { kind: 'teleport', label: 'Unknown kind', args: ['x'] }
    ]
  });
  assert.deepEqual(broken.manifest.controls.map((control) => control.label), ['Fine']);
  assert.equal(broken.problems.length, 6);
  // An "All" the manifest didn't list is added, so leaving the aim out is always a choice.
  const noAll = checkManifest({ name: 'Fans', run: 'fan', aim: { choices: [{ label: 'Desk', value: 'desk' }] }, controls: [{ kind: 'button', label: 'On', args: ['on', '{aim}'] }] }).manifest;
  assert.deepEqual(noAll.aim.choices.map((choice) => choice.label), ['All', 'Desk']);
});

test('the program has to be inside the folder: never an absolute path, a home path or a way out of it', () => {
  for (const run of ['lights', './lights', 'bin/lights', 'scripts/go.sh']) assert.ok(insidePath(run), run);
  for (const run of ['/bin/rm', '~/x', '../outside', 'bin/../../x', 'C:\\Windows\\cmd.exe', '']) assert.equal(insidePath(run), '', run);
  assert.equal(insidePath('a//b'), 'a/b', 'the same place');
  const { manifest, problems } = checkManifest({ name: 'Evil', run: '/bin/rm', controls: [{ kind: 'button', label: 'Go', args: ['-rf', '/'] }] });
  assert.equal(manifest, null);
  assert.match(problems[0], /isn’t a program inside the folder/);
  assert.equal(readManifest('{ not json').manifest, null);
});

test('written back, a manifest reads the same, with what’s at its defaults left out', () => {
  const manifest = lights();
  const again = readManifest(manifestText(manifest)).manifest;
  assert.deepEqual(again, manifest);
  const text = manifestText(manifest);
  assert.doesNotMatch(text, /"askFirst": false/);
  assert.match(text, /"chip": false/);
});

test('a step’s arguments come from the manifest alone, with its value and aim checked', () => {
  const manifest = lights();
  assert.deepEqual(stepArgs(manifest, { control: 'off' }).args, ['off'], 'all of them: the aim is left out');
  assert.deepEqual(stepArgs(manifest, { control: 'off', aim: 'bedside' }).args, ['off', 'Bedside'], 'by any case');
  assert.deepEqual(stepArgs(manifest, { control: 'off', aim: 'bed' }).args, ['off', 'Bedside'], 'by its words');
  assert.deepEqual(stepArgs(manifest, { control: 'off', aim: 'Brown Main' }).args, ['off', 'Brown Main'], 'a voice-only name');
  assert.deepEqual(stepArgs(manifest, { control: 'brightness', value: '30%' }).args, ['brightness', '30']);
  assert.deepEqual(stepArgs(manifest, { control: 'brightness', value: 30.4, drag: true }).args, ['brightness', '30', '--quick']);
  assert.deepEqual(stepArgs(manifest, { control: 'color', value: 'Pink' }).args, ['color', 'pink']);
  assert.equal(stepArgs(manifest, { control: 'temp', value: 20 }).name, 'warm white');
  assert.equal(stepArgs(manifest, { control: 'temp', value: 50 }).name, 'neutral white');
  for (const step of [{ control: 'brightness', value: 500 }, { control: 'brightness', value: 'bright' }, { control: 'brightness' }, { control: 'color', value: 'chartreuse' }, { control: 'off', aim: 'Kitchen' }, { control: 'off', aim: '$(rm -rf ~)' }, { control: 'nope' }]) {
    assert.equal(stepArgs(manifest, step).ok, false, JSON.stringify(step));
  }
});

test('what he says after: the control’s line, with the aim as it’s said', () => {
  const manifest = lights();
  const said = (step) => doneLine(manifest, stepArgs(manifest, step));
  assert.equal(said({ control: 'off' }), 'Lights off.');
  assert.equal(said({ control: 'on', aim: 'Bedside' }), 'Bedside lights on.');
  assert.equal(said({ control: 'brightness', value: 30, aim: 'Krish’s Bedroom' }), 'Bedroom lights at 30%.');
  assert.equal(said({ control: 'temp', value: 0 }), 'Lights set to warm white.');
  assert.equal(aimSaid(manifest, null), 'lights');
});

// ——— Their words ———

test('their words run a control with no model: phrases with an aim, a number or a choice, and only whole sentences', () => {
  const blocks = [{ id: 'lights', manifest: lights() }];
  const cases = [
    ['Turn off the lights.', { control: 'off' }],
    ['Jester, turn the bedside lights on please', { control: 'on', aim: 'Bedside' }],
    ['dim the lights to thirty percent', { control: 'brightness', value: 30 }],
    ['Set the lights to 45%', { control: 'brightness', value: 45 }],
    ['set the lights to red', { control: 'color', value: 'red' }],
    ['make the bedroom lights warm', { control: 'temp', value: 0, aim: 'Krish’s Bedroom' }],
    ['set brown main to a hundred', { control: 'brightness', value: 100, aim: 'Brown Main' }],
    ['lights out', { control: 'off' }],
    ['are the brown lights on?', { control: 'status', aim: 'Brown' }],
    ['which lights are on', { control: 'status' }],
    // One or many, as people say it (2026-11-18: "turn off the black light" went to the model).
    ['turn off the brown light', { control: 'off', aim: 'Brown' }],
    ['turn the bedside light on', { control: 'on', aim: 'Bedside' }],
    ['turn off the light', { control: 'off' }]
  ];
  for (const [said, want] of cases) {
    const found = matchWords(said, blocks);
    assert.ok(found, said);
    const { words, script, ...step } = found;
    assert.equal(script, 'lights');
    assert.deepEqual(step, want, said);
  }
  for (const said of ['turn off the TV', 'brightness 150', 'set the lights to 150', 'I left the lights on at home', 'turn off', 'what are lights made of', 'dim the kitchen lights to 30', '']) {
    assert.equal(matchWords(said, blocks), null, said);
  }
});

test('his name, please and “the” don’t change what’s asked; scenes are asked for by name', () => {
  assert.deepEqual(plainWords('Hey Jester, could you turn off ALL the lights, please?'), ['turn', 'off', 'lights']);
  for (const said of ['goodnight', 'Goodnight.', 'run goodnight', 'the goodnight scene', 'start goodnight mode']) assert.equal(sceneAsked(said, 'Goodnight'), true, said);
  for (const said of ['goodnight everyone', 'say goodnight', 'what is goodnight']) assert.equal(sceneAsked(said, 'Goodnight'), false, said);
  assert.equal(sceneAsked('movie time', 'Movie'), true);
  const vocabulary = blockWords(lights());
  assert.equal(mentions('dim the lights a bit and make them cozy', [vocabulary]), true);
  assert.equal(mentions('open Spotify', [vocabulary]), false);
});

// ——— Running a program ———

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jester-scripts-'));

test('a script is run in its folder with no shell: its arguments are only arguments', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'echo-args'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\npwd\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'canary'), 'still here');
  const runner = createScriptRunner({ folder: dir, manifest: { name: 'Echo', run: 'echo-args', timeout: 10 } });
  const result = await runner.run(['off', '$(rm canary)', 'a b; rm canary', '`rm canary`']);
  assert.equal(result.code, 0);
  assert.equal(result.out.trim().split('\n').slice(0, 4).join('|'), '[off]|[$(rm canary)]|[a b; rm canary]|[`rm canary`]');
  assert.equal(fs.realpathSync(result.out.trim().split('\n').at(-1)), fs.realpathSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'canary')));
  fs.rmSync(dir, { recursive: true });
});

test('what runs a script: itself when it’s executable, else its kind’s program, a Python script by its folder’s .venv', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'go.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'plain'), 'echo hi\n', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'job.sh'), 'echo hi\n', { mode: 0o644 });
  assert.deepEqual(commandFor(dir, 'go.py', { platform: 'darwin' }), { file: '/usr/bin/env', pre: ['python3', path.join(dir, 'go.py')] });
  fs.mkdirSync(path.join(dir, '.venv/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv/bin/python'), '');
  assert.deepEqual(commandFor(dir, 'go.py', { platform: 'darwin' }), { file: path.join(dir, '.venv/bin/python'), pre: [path.join(dir, 'go.py')] });
  assert.deepEqual(commandFor(dir, 'tool', { platform: 'darwin' }), { file: path.join(dir, 'tool'), pre: [] });
  assert.deepEqual(commandFor(dir, 'job.sh', { platform: 'darwin' }), { file: '/bin/bash', pre: [path.join(dir, 'job.sh')] });
  assert.match(commandFor(dir, 'plain', { platform: 'darwin' }).error, /isn’t executable/);
  assert.match(commandFor(dir, 'missing', { platform: 'darwin' }).error, /isn’t in the folder/);
  const env = scriptEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/x' }, 'darwin');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.match(env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(env.HOME, '/Users/x');
  fs.rmSync(dir, { recursive: true });
});

/** A served program in Node: says it's ready, answers each command with its args, reports a state unasked, leaves when idle. */
const SERVED = `
const readline = require('node:readline');
const idle = Number(process.argv[3] || 5000);
let timer = setTimeout(() => process.exit(0), idle);
console.log(JSON.stringify({ serve: 1 }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  clearTimeout(timer);
  timer = setTimeout(() => process.exit(0), idle);
  const { id, args } = JSON.parse(line);
  if (args[0] === 'hang') return;
  if (args[0] === 'tell') console.log(JSON.stringify({ event: 'state', state: { summary: 'Told unasked' } }));
  console.log(JSON.stringify({ id, code: args[0] === 'fail' ? 1 : 0, out: '✓ ' + args.join(' ') + ': done', err: args[0] === 'fail' ? 'serve: it broke. More detail.' : '', state: { summary: 'pid ' + process.pid } }));
});
`;

test('served, a program stays: one start for many commands, a state told unasked, and started again after it leaves', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'served.cjs'), SERVED);
  const told = [];
  const runner = createScriptRunner({ folder: dir, manifest: { name: 'Served', run: 'served.cjs', serve: ['serve', '300'], timeout: 5 }, onState: (state) => told.push(state.summary) });
  const first = await runner.run(['on', 'Bedside']);
  assert.equal(first.code, 0);
  assert.equal(first.out, '✓ on Bedside: done');
  const second = await runner.run(['tell']);
  assert.equal(second.state.summary, first.state.summary, 'the same process answered');
  assert.deepEqual(told, ['Told unasked']);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(runner.serving, false, 'it left when idle');
  const third = await runner.run(['off']);
  assert.notEqual(third.state.summary, first.state.summary, 'started again');
  const failed = await runner.run(['fail']);
  assert.equal(failed.code, 1);
  assert.equal(failed.err, 'serve: it broke. More detail.');
  runner.close();
  fs.rmSync(dir, { recursive: true });
});

test('a served program that never says it’s ready is run plainly instead; one stuck on a command is stopped', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'quiet.cjs'), 'if (process.argv[2] === "serve") setInterval(() => {}, 1000); else console.log("✓ plain: " + process.argv.slice(2).join(" "));\n');
  const logs = [];
  const runner = createScriptRunner({ folder: dir, manifest: { name: 'Quiet', run: 'quiet.cjs', serve: ['serve'], timeout: 20 }, log: (line) => logs.push(line) });
  const started = Date.now();
  const result = await runner.run(['off']);
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), '✓ plain: off');
  assert.ok(Date.now() - started >= 7000, 'it waited for the ready line first');
  assert.ok(logs.some((line) => /runs plainly/.test(line)));
  // Now it's known not to serve: the next is plain at once.
  const again = Date.now();
  await runner.run(['on']);
  assert.ok(Date.now() - again < 3000);
  runner.close();

  fs.writeFileSync(path.join(dir, 'served.cjs'), SERVED);
  const stuck = createScriptRunner({ folder: dir, manifest: { name: 'Stuck', run: 'served.cjs', serve: ['serve', '30000'], timeout: 1 } });
  const hung = await stuck.run(['hang']);
  assert.equal(hung.code, 124);
  assert.match(hung.err, /took longer than 1 seconds/);
  stuck.close();
  fs.rmSync(dir, { recursive: true });
});

// ——— Outcomes ———

test('a run’s outcome: the done line, what didn’t answer, or the error’s first sentence without the program’s name', () => {
  const manifest = lights();
  const built = stepArgs(manifest, { control: 'off' });
  assert.deepEqual(outcomeOf(manifest, built, { code: 0, out: '✓ Brown: off\n✓ Black: off', err: '' }), { ok: true, text: 'Lights off.' });
  assert.deepEqual(outcomeOf(manifest, built, { code: 0, out: '✓ Brown: off\n✗ Black: offline (switched off at the wall?)\n? Brown Main: sent "off" but the bulb didn\'t confirm', err: '' }), { ok: true, text: 'Lights off, but Black and Brown Main didn’t answer.' });
  assert.deepEqual(outcomeOf(manifest, built, { code: 1, out: '', err: 'lights: Couldn\'t hear any bulbs from "141 Groton Rd". Check they have power (wall switch on).' }), { ok: false, text: 'Couldn\'t hear any bulbs from "141 Groton Rd".' });
  assert.equal(failureLine(manifest, { code: 124, out: '', err: '' }), 'Lights didn’t work: it took too long.');
  assert.deepEqual(resultLines('✓ A: on\nplain line\n→ B: sent "on"').map((line) => line.mark + line.name), ['✓A', '→B']);
  const asked = stepArgs(manifest, { control: 'status', aim: 'Brown' });
  const out = JSON.stringify({ summary: 'All 3 on', say: 'They are all on.', by: { Brown: { summary: 'Both on', say: 'The Brown lights are both on.', values: { power: true } } } });
  assert.deepEqual(outcomeOf(manifest, asked, { code: 0, out, err: '' }), { ok: true, text: 'The Brown lights are both on.' });
});

test('what’s on is kept as shown: summary, sentence, values, and the same by aim, any case', () => {
  const state = stateIn('noise first {"where":"The Brexx","summary":"All 3 on · 20% · pink","say":"x","values":{"power":true,"brightness":20,"color":"pink","bad key!":1,"nested":{"a":1}},"by":{"Brown":{"summary":"Both on","values":{"power":true}}}} noise after');
  assert.equal(state.where, 'The Brexx');
  assert.deepEqual(state.values, { power: true, brightness: 20, color: 'pink' });
  assert.equal(stateFor(state, { value: 'Brown', label: 'Brown' }).summary, 'Both on');
  assert.equal(stateFor(state, null).summary, 'All 3 on · 20% · pink');
  assert.equal(stateIn('not json'), null);
});

test('the menu bar’s presets: round numbers, or a slider’s named steps', () => {
  const manifest = lights();
  assert.deepEqual(sliderPresets(manifest.controls.find((control) => control.id === 'brightness')).map((preset) => preset.value), [25, 50, 75, 100]);
  assert.deepEqual(sliderPresets(manifest.controls.find((control) => control.id === 'temp')).map((preset) => [preset.label, preset.value]), [['Warm white', 0], ['Neutral white', 51], ['Cool white', 100]]);
});

// ——— The scripts, together ———

/** scripts.js with its folder and storage in memory, and a runner that records what it was asked. */
function harness({ manifest = LIGHTS, slow = 0, answer } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'jester.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'lights'), '#!/bin/sh\n', { mode: 0o755 });
  const store = { scripts: [{ id: 'lights', folder: dir, menu: true }] };
  const ran = [];
  const changes = [];
  const scripts = createScripts({
    storage: { get: async () => structuredClone(store), set: async (items) => Object.assign(store, structuredClone(items)) },
    onChange: (change) => changes.push(change),
    makeRunner: () => ({
      serving: true,
      async run(args) {
        ran.push(args.join(' '));
        if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
        return answer ? answer(args) : { code: 0, out: `✓ Lights: ${args[0]}`, err: '', state: { summary: `after ${args.join(' ')}`, values: { power: args[0] !== 'off' } } };
      },
      close() {}
    })
  });
  return { scripts, ran, store, changes, dir, done: () => fs.rmSync(dir, { recursive: true }) };
}

test('one command at a time for a script, in the order asked; a drag sends only its newest value, then the one let go at', async () => {
  const h = harness({ slow: 40 });
  const runs = [h.scripts.run({ script: 'lights', control: 'off' }), h.scripts.run({ script: 'lights', control: 'on', aim: 'Brown' })];
  for (const value of [20, 30, 40, 50, 60]) h.scripts.run({ script: 'lights', control: 'brightness', value, drag: true });
  runs.push(h.scripts.run({ script: 'lights', control: 'brightness', value: 65 }));
  const outcomes = await Promise.all(runs);
  assert.deepEqual(outcomes.map((outcome) => outcome.text), ['Lights off.', 'Brown lights on.', 'Lights at 65%.']);
  // The drag's values all came while the others ran: only its newest went, then the one it was let go at.
  assert.deepEqual(h.ran, ['off', 'on Brown', 'brightness 60 --quick', 'brightness 65']);
  for (const value of [70, 80]) h.scripts.run({ script: 'lights', control: 'brightness', value, drag: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const value of [85, 90]) h.scripts.run({ script: 'lights', control: 'brightness', value, drag: true });
  await h.scripts.run({ script: 'lights', control: 'brightness', value: 90 });
  assert.deepEqual(h.ran.slice(4), ['brightness 80 --quick', 'brightness 90 --quick', 'brightness 90'], 'the newest when it starts, the newest again once that’s sent, then the one let go at');
  const { blocks } = await h.scripts.list();
  assert.equal(blocks[0].state.summary, 'after brightness 90');
  assert.equal(blocks[0].last.text, 'Lights at 90%.');
  assert.equal(blocks[0].example, 'turn on the lights');
  assert.equal(blocks[0].controls.find((control) => control.id === 'brightness').args, undefined, 'the window never sees a command line');
  h.done();
});

test('what can’t run isn’t: a value out of range, an aim it doesn’t have, a script gone', async () => {
  const h = harness();
  assert.deepEqual(await h.scripts.run({ script: 'lights', control: 'brightness', value: 900 }), { ok: false, text: 'Brightness goes from 1 to 100%.' });
  assert.equal((await h.scripts.run({ script: 'lights', control: 'off', aim: 'Kitchen' })).ok, false);
  assert.equal((await h.scripts.run({ script: 'fans', control: 'off' })).ok, false);
  assert.deepEqual(h.ran, []);
  h.done();
});

test('a model’s steps are checked against the scripts, scenes by id; asking first follows the controls', async () => {
  const manifest = structuredClone(LIGHTS);
  manifest.controls.find((control) => control.id === 'off').askFirst = true;
  const h = harness({ manifest });
  await h.scripts.ready();
  const { steps, problems } = h.scripts.fromModel([{ id: 'lights.brightness', value: '30', aim: 'bedside' }, { id: 'lights.color', value: 'mauve' }, { id: 'fans.on' }, { id: 'LIGHTS.ON' }]);
  assert.deepEqual(steps, [{ script: 'lights', control: 'brightness', value: 30, aim: 'Bedside' }, { script: 'lights', control: 'on' }]);
  assert.equal(problems.length, 2);
  assert.equal(h.scripts.asksFirst(steps), false);
  assert.equal(h.scripts.asksFirst([{ script: 'lights', control: 'off' }]), true);
  assert.equal(h.scripts.label([{ script: 'lights', control: 'brightness', value: 30, aim: 'Bedside' }]), 'Lights: Brightness 30% (Bedside)');
  const saved = await h.scripts.saveScene({ name: 'Goodnight', steps: [{ script: 'lights', control: 'off' }] });
  assert.equal(saved.ok, true);
  assert.equal(h.scripts.asksFirst([{ scene: 'goodnight' }]), true, 'a scene asks when a step of it does');
  assert.deepEqual(h.scripts.fromModel([{ id: 'scene.goodnight' }]).steps, [{ scene: 'goodnight' }]);
  assert.deepEqual(h.scripts.match('goodnight'), { steps: [{ scene: 'goodnight' }] });
  assert.deepEqual(await h.scripts.runScene('goodnight'), { ok: true, text: 'Goodnight, done.' });
  assert.deepEqual(h.ran, ['off']);
  h.done();
});

test('scenes need a name and steps that run, and don’t share a name', async () => {
  const h = harness();
  assert.equal((await h.scripts.saveScene({ name: '', steps: [{ script: 'lights', control: 'off' }] })).ok, false);
  assert.equal((await h.scripts.saveScene({ name: 'Movie', steps: [{ script: 'lights', control: 'brightness', value: 900 }] })).ok, false);
  const movie = await h.scripts.saveScene({ name: 'Movie', steps: [{ script: 'lights', control: 'brightness', value: 20, aim: 'Bedside' }, { script: 'lights', control: 'temp', value: 0 }] });
  assert.equal(movie.ok, true);
  assert.equal((await h.scripts.saveScene({ name: 'movie', steps: [{ script: 'lights', control: 'off' }] })).ok, false);
  assert.deepEqual(h.store.scenes[0].steps, [{ script: 'lights', control: 'brightness', value: 20, aim: 'Bedside' }, { script: 'lights', control: 'temp', value: 0 }]);
  // Taking the script out takes its steps out of scenes, and a scene left empty goes.
  await h.scripts.remove('lights');
  assert.deepEqual(h.store.scenes, []);
  assert.deepEqual(h.store.scripts, []);
  h.done();
});

test('a folder dropped in: its own jester.json, or a draft; saving writes jester.json and adds it', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fan'), '#!/bin/sh\n', { mode: 0o755 });
  const store = {};
  const drafted = [];
  const scripts = createScripts({
    storage: { get: async () => structuredClone(store), set: async (items) => Object.assign(store, structuredClone(items)) },
    draft: async (folder) => (drafted.push(folder), { manifest: checkManifest({ name: 'Fan', run: 'fan', controls: [{ kind: 'button', label: 'On', args: ['on'] }] }).manifest, problems: [] }),
    makeRunner: () => ({ serving: false, run: async () => ({ code: 0, out: '', err: '' }), close() {} })
  });
  const read = await scripts.inspect(dir);
  assert.equal(read.ok, true);
  assert.equal(read.found, false);
  assert.deepEqual(drafted, [dir]);
  const saved = await scripts.save(dir, { ...read.manifest, name: 'Desk fan' });
  assert.equal(saved.ok, true);
  assert.equal(saved.script, 'desk-fan');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jester.json'), 'utf8')).name, 'Desk fan');
  assert.deepEqual(store.scripts, [{ id: 'desk-fan', folder: dir, menu: true }]);
  // Now it has one: dropped again, it's that, for editing.
  const again = await scripts.inspect(dir);
  assert.equal(again.found, true);
  assert.equal(again.script, 'desk-fan');
  assert.equal(drafted.length, 1);
  assert.equal((await scripts.inspect(path.join(dir, 'fan'))).why, 'That’s a file: drop the folder it’s in.');
  // A jester.json changed on disk is read again.
  fs.writeFileSync(path.join(dir, 'jester.json'), JSON.stringify({ name: 'Ceiling fan', run: 'fan', controls: [{ kind: 'button', label: 'Off', args: ['off'] }] }));
  fs.utimesSync(path.join(dir, 'jester.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal((await scripts.list()).blocks[0].name, 'Ceiling fan');
  fs.rmSync(dir, { recursive: true });
});

test('his prompt is told the scripts, with an example from them, and what they said is on', async () => {
  const h = harness();
  await h.scripts.refresh('lights').catch(() => undefined);
  await h.scripts.run({ script: 'lights', control: 'on' });
  const prompt = h.scripts.prompt();
  assert.match(prompt.catalog, /- lights\.brightness: Lights, Brightness, value 1 to 100%/);
  assert.match(prompt.catalog, /aim \(leave it out for all of them\): Bedside, Brown, Brown Main, Krish’s Bedroom/);
  assert.equal(prompt.example.said, 'dim the Bedside lights to 51');
  assert.equal(prompt.example.reply, '{"say":"Okay","do":"","new":false,"run":[{"id":"lights.brightness","value":"51","aim":"Bedside"}]}');
  assert.match(h.scripts.stateLines(), /^What the user's scripts said is on:\nLights: after on, just now\.$/);
  const system = personaPrompt(new Date(2026, 10, 18), [], { scripts: prompt, tasks: true });
  assert.match(system, /You run the user's own scripts yourself, not the laptop/);
  assert.match(system, /For example, to "dim the Bedside lights to 51" you reply \{"say":"Okay"/);
  assert.match(system, /Leave out "run" unless they ask for something their scripts do\./);
  assert.doesNotMatch(personaPrompt(new Date(2026, 10, 18), []), /"run"/);
  assert.match(abilitiesPart({ scripts: true }), /Run the user’s own scripts/);
  assert.match(abilitiesPart({}), /none added yet \(the Controls window/);
  h.done();
});

test('the model’s "run" comes back as steps; with no scripts it isn’t asked for', async () => {
  let asked = null;
  const request = async (options) => ((asked = options), { json: { say: 'Okay', do: '', new: false, run: [{ id: 'lights.off', aim: 'Brown' }, { id: 'lights.brightness', value: 30 }, { nope: 1 }] } });
  const reply = await askModel({ request, text: 'brown lights off', history: [], scripts: { catalog: '- lights.off: Lights, Off' } });
  assert.deepEqual(reply.run, [{ id: 'lights.off', aim: 'Brown' }, { id: 'lights.brightness', value: '30' }]);
  assert.ok(asked.schema.properties.run);
  const plain = await askModel({ request, text: 'hello', history: [] });
  assert.equal(plain.run, undefined);
  assert.equal(asked.schema.properties.run, undefined);
});

// ——— In conversation ———

function talk({ reply, allow = true, scriptsFake, tasksFake = null } = {}) {
  const said = [];
  const questions = [];
  const ran = [];
  const conversation = createConversation({
    chat: async () => reply,
    speaker: { async say(text) { said.push(text); }, stop() {} },
    memory: { add: () => undefined, current: () => [], idleFor: () => null, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async (text) => (ran.push(text), { outcome: { ok: true, text: `Did ${text}` } }) },
    assistant: { asking: false, running: false, answer() {}, cancel() {}, async confirm(label) { questions.push(label); return allow; } },
    show: () => undefined,
    scripts: scriptsFake,
    tasks: tasksFake
  });
  return { conversation, said, questions, ran };
}

function scriptsFake({ asks = false } = {}) {
  const runs = [];
  return {
    runs,
    prompt: () => ({ catalog: '- lights.off: Lights, Off', example: null }),
    stateLines: () => '',
    mentions: (text) => /light/i.test(text),
    match: (text) => (/^turn off the lights$/i.test(text) ? { steps: [{ script: 'lights', control: 'off' }] } : null),
    fromModel: (list) => ({ steps: list.map((item) => ({ script: item.id.split('.')[0], control: item.id.split('.')[1], ...(item.aim ? { aim: item.aim } : {}) })), problems: [] }),
    asksFirst: () => asks,
    label: () => 'Lights: Off',
    runAll: async (steps) => (runs.push(steps), { ok: true, text: 'Lights off.' })
  };
}

test('asked in conversation, he runs the scripts himself and says how it went, not the model’s line', async () => {
  const scripts = scriptsFake();
  const t = talk({ reply: { say: 'Okay', do: 'turn off the lights', new: false, run: [{ id: 'lights.off' }] }, scriptsFake: scripts });
  await t.conversation.told('could you make it dark in here, the lights');
  assert.deepEqual(scripts.runs, [[{ script: 'lights', control: 'off' }]]);
  assert.deepEqual(t.said, ['Lights off.']);
  assert.deepEqual(t.ran, [], 'the same thing isn’t handed to the laptop as well');
});

test('“Ask first”: said aloud he asks before running; typed, or refused, as it should be', async () => {
  const asked = scriptsFake({ asks: true });
  const spoken = talk({ reply: { say: 'Okay', do: '', new: false, run: [{ id: 'lights.off' }] }, scriptsFake: asked, allow: false });
  await spoken.conversation.told('kill the lights');
  assert.deepEqual(spoken.questions, ['Run Lights: Off']);
  assert.deepEqual(asked.runs, []);
  assert.deepEqual(spoken.said, ['Okay, I won’t.']);
  const typed = talk({ reply: { say: 'Okay', do: '', new: false, run: [{ id: 'lights.off' }] }, scriptsFake: scriptsFake({ asks: true }) });
  await typed.conversation.told('kill the lights', { typed: true });
  assert.deepEqual(typed.questions, []);
});

test('for later: with a task, kept with it to run then; at a time with no task, not run now', async () => {
  const applied = [];
  const tasks = { touched: () => null, apply: async (request) => (applied.push(request), 'Okay, at 11:00 PM: turn off the lights.'), asked: () => true, wanted: () => false, direct: async () => '' };
  const scripts = scriptsFake();
  const later = talk({ reply: { say: 'Okay', do: '', new: false, task: { op: 'add', text: 'turn off the lights', at: '2026-11-18 23:00' }, run: [{ id: 'lights.off' }] }, scriptsFake: scripts, tasksFake: tasks });
  await later.conversation.told('turn off the lights at 11');
  assert.deepEqual(scripts.runs, []);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].run, [{ script: 'lights', control: 'off' }]);
  assert.deepEqual(later.said, ['Okay, at 11:00 PM: turn off the lights.']);
  const forgot = scriptsFake();
  const noTask = talk({ reply: { say: 'Okay', do: '', new: false, run: [{ id: 'lights.off' }] }, scriptsFake: forgot, tasksFake: tasks });
  await noTask.conversation.told('turn off the lights in 20 minutes');
  assert.deepEqual(forgot.runs, []);
  assert.match(noTask.said[0], /^When should I do that\?/);
});

test('a task with scripts runs at its time: kept with its steps, done when they worked, and why not when they didn’t', () => {
  const dir = tmp();
  const jobs = new Map();
  const clock = { add: (job) => (jobs.set(job.id, job), job), remove: (id) => jobs.delete(id) };
  let time = new Date(2026, 10, 18, 22, 0).getTime();
  const tasks = createTasks({ file: path.join(dir, 'tasks.json'), clock, now: () => time });
  const said = tasks.apply({ op: 'timer', text: 'turn off the lights', in: 20, run: [{ script: 'lights', control: 'off' }] }, { said: 'turn off the lights in 20 minutes' });
  assert.match(said, /^Okay, at 10:20 PM: turn off the lights\.$/);
  const [task] = tasks.list().open;
  assert.deepEqual(task.run, [{ script: 'lights', control: 'off' }]);
  assert.equal(jobs.size, 1, 'on the clock');
  assert.equal(tasks.apply({ op: 'add', text: 'turn off the lights', run: [{ script: 'lights', control: 'off' }] }, { said: 'turn off the lights later' }), 'When should I do that? Tell me a time.');
  tasks.ran(task.id, false, 'Couldn’t hear any bulbs.');
  assert.equal(tasks.get(task.id).failed, 'Couldn’t hear any bulbs.');
  assert.equal(tasks.get(task.id).done, undefined);
  tasks.ran(task.id, true);
  assert.ok(tasks.get(task.id).done);
  assert.equal(jobs.size, 0);
  fs.rmSync(dir, { recursive: true });
});

// ——— The voice runner, the menu bar, his own command ———

test('the voice runner runs the scripts’ words first, and knows them; words naming them that fit no phrase are resolved', async () => {
  const runs = [];
  const scripts = {
    match: (text) => (/^lights off$/i.test(text) ? { steps: [{ script: 'lights', control: 'off' }] } : null),
    mentions: (text) => /lights/i.test(text),
    resolve: async (text) => (/cozy/.test(text) ? { steps: [{ script: 'lights', control: 'brightness', value: 20 }] } : null),
    runAll: async (steps) => (runs.push(steps), { ok: true, text: 'Done with the lights.' }),
    asksFirst: (steps) => steps.some((step) => step.control === 'off')
  };
  const runner = createVoiceRunner({ driver: { call: async () => ({}) }, dispatch: async () => ({ ok: true }), canPost: () => true, onJester: () => undefined, run: async () => '', installed: () => [], scripts });
  assert.equal(await runner.knows('lights off'), true);
  assert.deepEqual((await runner.run('lights off')).outcome, { ok: true, text: 'Done with the lights.' });
  assert.deepEqual((await runner.run('make the lights cozy')).outcome, { ok: true, text: 'Done with the lights.' });
  assert.deepEqual(runs, [[{ script: 'lights', control: 'off' }], [{ script: 'lights', control: 'brightness', value: 20 }]]);
  assert.deepEqual(await runner.scriptsAsk('lights off'), [{ script: 'lights', control: 'off' }]);
  assert.equal(await runner.scriptsAsk('make the lights cozy'), null);
});

test('“open controls” is his own command, and the menu bar has each script’s buttons and presets, scenes, and Controls…', () => {
  for (const said of ['open controls', 'Open my controls.', 'show the controls window', 'open Jester’s controls']) assert.deepEqual(parseCommand(said), { kind: 'jester', op: 'controls' }, said);
  assert.notDeepEqual(parseCommand('open control center'), { kind: 'jester', op: 'controls' });
  const model = trayModel({
    engine: { state: 'running' },
    settings: { enabled: true, voiceEnabled: false },
    voice: 'ready',
    scripts: { scripts: [{ id: 'lights', name: 'Lights', summary: 'All 3 on · 20%', items: [{ label: 'On', step: { script: 'lights', control: 'on' } }, { label: 'Brightness', items: [{ label: '25%', step: { script: 'lights', control: 'brightness', value: 25 } }] }] }], scenes: [{ id: 'goodnight', name: 'Goodnight' }] }
  });
  const lightsMenu = model.items.find((item) => item.id === 'script:lights');
  assert.deepEqual(lightsMenu.submenu.map((item) => item.label || item.type), ['All 3 on · 20%', 'separator', 'On', 'Brightness']);
  assert.deepEqual(lightsMenu.submenu[3].submenu[0].step, { script: 'lights', control: 'brightness', value: 25 });
  assert.equal(model.items.find((item) => item.id === 'scenes').submenu[0].scene, 'goodnight');
  const ids = model.items.map((item) => item.id).filter(Boolean);
  assert.ok(ids.indexOf('controls') < ids.indexOf('talk'));
});

// ——— Drafting ———

test('drafting reads names, the README and scripts’ starts, never hidden or secret files, with secrets taken out', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fan\nRun `fan on` or `fan off`.\n');
  fs.writeFileSync(path.join(dir, 'fan'), '#!/usr/bin/env python3\nimport argparse\nAPI_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"\npassword = "hunter22hunter"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret');
  fs.writeFileSync(path.join(dir, 'token.txt'), 'abc');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const picture = folderPicture(dir);
  assert.match(picture.readme, /fan on/);
  assert.deepEqual(picture.heads.map((item) => item.rel), ['fan']);
  assert.doesNotMatch(picture.heads[0].head, /sk-abc|hunter22/);
  assert.ok(picture.names.some((name) => name.startsWith('token.txt')), 'its name is listed');
  assert.ok(!picture.names.some((name) => name.startsWith('.env') || name.startsWith('node_modules')));
  assert.equal(helpTarget(picture), 'fan', 'it parses arguments, so --help is safe to ask');
  assert.equal(helpTarget({ heads: [{ rel: 'go.sh', head: 'say hello\n' }] }), '', 'no parser: never run');
  fs.rmSync(dir, { recursive: true });
});

test('a draft is the model’s jester.json, checked like any other; one with nothing in it is no draft', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'go.sh'), 'echo go\n');
  const asked = [];
  const draft = await draftManifest(dir, { request: async (options) => (asked.push(options), { json: { name: 'Go', run: 'go.sh', controls: [{ kind: 'button', label: 'Go', args: [] }, { kind: 'button', label: 'Go now', args: ['now'] }] } }) });
  assert.equal(draft.manifest.name, 'Go');
  assert.deepEqual(draft.manifest.controls.map((control) => control.label), ['Go now']);
  assert.equal(draft.problems.length, 1);
  assert.match(asked[0].prompt, /The start of go\.sh:\necho go/);
  assert.doesNotMatch(asked[0].prompt, /--help/, 'no parser, so it was never run');
  const empty = tmp();
  assert.match((await draftManifest(empty, { request: async () => ({ json: {} }) })).why, /no scripts/);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(empty, { recursive: true });
});

// ——— Found in review, 2026-11-18 ———

test('--help is asked only of a script whose own source parses arguments: never a wrapper or a shell case', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'deploy'), '#!/bin/bash\nrsync -a --delete ./site/ host:/var/www/\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'notify.py'), 'import argparse\nparser = argparse.ArgumentParser()\n');
  assert.equal(helpTarget(folderPicture(dir)), 'notify.py');
  fs.rmSync(path.join(dir, 'notify.py'));
  fs.writeFileSync(path.join(dir, 'go.sh'), '#!/bin/bash\ncase "$1" in\n  on) echo on ;;\n  *) rm -rf ./cache ;;\nesac\ngetopts ab opt\n');
  assert.equal(helpTarget(folderPicture(dir)), '', 'a shell case or getopts may fall through to what it does');
  fs.rmSync(dir, { recursive: true });
});

test('a draft never says what stays running or what’s run when Controls opens', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'go.sh'), 'echo go\n');
  const draft = await draftManifest(dir, { request: async () => ({ json: { name: 'Go', run: 'go.sh', serve: ['serve'], status: ['wipe'], controls: [{ kind: 'button', label: 'Go', args: ['go'] }] } }) });
  assert.equal(draft.manifest.serve, undefined);
  assert.equal(draft.manifest.status, undefined);
  fs.rmSync(dir, { recursive: true });
});

test('what looks like a key is hidden from the model: set by name, passed by position, or long and random', async () => {
  const { hide } = await import('../desktop/src/main/script-draft.js');
  assert.equal(hide('LOCAL_KEY = "0123456789abcdef"'), 'LOCAL_KEY = "<hidden>"');
  assert.equal(hide('d = tinytuya.BulbDevice("bf123", "192.168.1.5", "0123456789abcdef")'), 'd = tinytuya.BulbDevice("bf123", "192.168.1.5", "<hidden>")');
  assert.equal(hide('WIFI_PSK=hunter2hunter2'), 'WIFI_PSK=<hidden>');
  assert.doesNotMatch(hide('{"Authorization": "Bearer abcDEF123456789xyz"}'), /abcDEF/);
  assert.equal(hide('This saves your bulbs’ Bluetooth key from the Cync cloud.'), 'This saves your bulbs’ Bluetooth key from the Cync cloud.', 'prose is left alone');
});

test('a served program’s stray line is passed over; a command after one that timed out goes to a new program', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'served.cjs'), SERVED.replace("console.log(JSON.stringify({ serve: 1 }));", "console.log('42'); console.log('\"ok\"'); console.log('[1]'); console.log('not json'); console.log(JSON.stringify({ serve: 1 }));"));
  const runner = createScriptRunner({ folder: dir, manifest: { name: 'Stray', run: 'served.cjs', serve: ['serve', '30000'], timeout: 1 } });
  assert.equal((await runner.run(['on'])).code, 0, 'stray lines before the ready one change nothing');
  const [hung, next] = await Promise.all([runner.run(['hang']), new Promise((resolve) => setTimeout(resolve, 10)).then(() => runner.run(['off']))]);
  assert.equal(hung.code, 124);
  assert.equal(next.code, 0, 'answered by a new program, not lost with the old');
  assert.equal(next.out, '✓ off: done');
  runner.close();
  fs.rmSync(dir, { recursive: true });
});

test('a scene with a step that can’t run isn’t saved, and says which step', async () => {
  const h = harness();
  const saved = await h.scripts.saveScene({ name: 'Movie', steps: [{ script: 'lights', control: 'off' }, { script: 'lights', control: 'brightness', value: 0 }] });
  assert.deepEqual(saved, { ok: false, why: 'Step 2 can’t run: Brightness goes from 1 to 100%.' });
  assert.equal(h.store.scenes, undefined);
  h.done();
});

test('a command waiting its turn is made from jester.json as it is then; one gone bad fails, and nothing throws', async () => {
  const h = harness({ slow: 60 });
  const first = h.scripts.run({ script: 'lights', control: 'off' });
  const waiting = h.scripts.run({ script: 'lights', control: 'on' });
  h.scripts.run({ script: 'lights', control: 'brightness', value: 30, drag: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.writeFileSync(path.join(h.dir, 'jester.json'), '{ broken');
  fs.utimesSync(path.join(h.dir, 'jester.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal((await first).ok, true);
  const later = await waiting;
  assert.equal(later.ok, false);
  assert.match(later.text, /jester\.json isn’t valid JSON/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(h.ran, ['off']);
  h.done();
});

test('times are times and levels are levels: "at 11" is for later, "at 50" and "at 30 percent" aren’t', async () => {
  const { timedWords } = await import('../desktop/src/main/script-words.js');
  for (const said of ['turn off the lights at 11', 'at 11:30', 'at 5 pm', 'in 20 minutes', 'tonight', 'at noon', 'turn them off at five', 'tomorrow morning']) assert.equal(timedWords(said), true, said);
  for (const said of ['set the lights at 50', 'put the bedroom lights at 30 percent', 'lights at one hundred', 'lights at 7%', 'set them at five percent', 'dim the lights to 20']) assert.equal(timedWords(said), false, said);
});

test('“turn off the lights and remind me to call Mom at 5”: the lights now, the reminder kept, both said', async () => {
  const applied = [];
  const tasks = { touched: () => null, apply: async (request) => (applied.push(request), 'Okay, I’ll remind you at 5:00 PM: Call Mom.'), asked: () => true, wanted: () => false, direct: async () => '' };
  const scripts = scriptsFake();
  scripts.mentions = (text) => /light/i.test(text);
  const t = talk({ reply: { say: 'Okay', do: '', new: false, task: { op: 'add', text: 'call Mom', at: '2026-11-18 17:00' }, run: [{ id: 'lights.off' }] }, scriptsFake: scripts, tasksFake: tasks });
  await t.conversation.told('turn off the lights and remind me to call Mom at 5');
  assert.deepEqual(scripts.runs, [[{ script: 'lights', control: 'off' }]], 'the lights, now');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].run, undefined, 'the reminder is its own, with no scripts in it');
  assert.deepEqual(t.said, ['Lights off. Okay, I’ll remind you at 5:00 PM: Call Mom.']);
});

test('“Ask first”, set for later by voice, is asked when it’s set; “at 50” is run now', async () => {
  const applied = [];
  const tasks = { touched: () => null, apply: async (request) => (applied.push(request), 'Okay, at 11:00 PM: unlock the door.'), asked: () => true, wanted: () => false, direct: async () => '' };
  const asks = scriptsFake({ asks: true });
  asks.mentions = () => true;
  const t = talk({ reply: { say: 'Okay', do: '', new: false, task: { op: 'add', text: 'unlock the door', at: '2026-11-18 23:00' }, run: [{ id: 'lock.unlock' }] }, scriptsFake: asks, tasksFake: tasks, allow: false });
  await t.conversation.told('unlock the front door at 11');
  assert.deepEqual(t.questions, ['Set Lights: Off for later']);
  assert.deepEqual(applied, [], 'refused: nothing set');
  assert.deepEqual(t.said, ['Okay, I won’t.']);
  const now = scriptsFake();
  const level = talk({ reply: { say: 'Okay', do: '', new: false, run: [{ id: 'lights.brightness' }] }, scriptsFake: now });
  await level.conversation.told('set the lights at 50');
  assert.equal(now.runs.length, 1);
});

test('the runner asks first for words only the model could resolve, and never runs them early when they name a time', async () => {
  const runs = [];
  const scripts = {
    match: () => null,
    mentions: (text) => /door|lights/i.test(text),
    resolve: async (text) => (/door/.test(text) ? { steps: [{ script: 'lock', control: 'unlock' }] } : /lights/.test(text) ? { steps: [{ script: 'lights', control: 'off' }] } : null),
    runAll: async (steps) => (runs.push(steps), { ok: true, text: 'Done.' }),
    asksFirst: (steps) => steps.some((step) => step.control === 'unlock')
  };
  const runner = createVoiceRunner({ driver: { call: async () => ({}) }, dispatch: async () => ({ ok: true }), canPost: () => true, onJester: () => undefined, run: async () => '', installed: () => [], scripts });
  assert.deepEqual(await runner.scriptsAsk('let me in the front door please'), [{ script: 'lock', control: 'unlock' }]);
  const timed = await runner.run('turn off the lights in 10 minutes');
  assert.equal(timed.outcome.ok, false);
  assert.match(timed.outcome.text, /I haven’t done that yet/);
  assert.deepEqual(runs, []);
});

test('scripts that failed at their time, moved, are tried again then', () => {
  const dir = tmp();
  const jobs = new Map();
  const clock = { add: (job) => (jobs.set(job.id, job), job), remove: (id) => jobs.delete(id) };
  const time = new Date(2026, 10, 18, 22, 0).getTime();
  const tasks = createTasks({ file: path.join(dir, 'tasks.json'), clock, now: () => time });
  tasks.apply({ op: 'add', text: 'turn off the lights', in: 20, run: [{ script: 'lights', control: 'off' }] }, { said: 'turn off the lights in 20 minutes' });
  const [task] = tasks.list().open;
  tasks.ran(task.id, false, 'Couldn’t hear any bulbs.');
  tasks.snooze(task.id, 10);
  assert.equal(tasks.get(task.id).failed, undefined);
  assert.ok(jobs.has(`task-${task.id}`));
  fs.rmSync(dir, { recursive: true });
});
