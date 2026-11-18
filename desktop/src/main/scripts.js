/**
 * The user's own scripts (the user, 2026-11-18: "attach a folder for scripts for him to execute and he will be
 * able to take them and execute through the chat"): folders added in Controls with +, each with a jester.json
 * (script-manifest.js) saying what its block holds, run by script-runner.js. Their blocks are in the Controls
 * window; he runs them by voice too, from their words with no model (script-words.js) or from his model's "run";
 * a scene runs several at once; a task can run one at a time (tasks.js).
 *
 * One command at a time for each script, in the order asked: two programs logging in to the same bulb at once
 * would both fail. A slider being dragged sends only its newest value, as soon as the one before is done, and
 * its last when let go.
 *
 * What a run says is a word or two (the user's choice): the control's own "done" line ("Bedside lights at 30%."),
 * and what didn't work, from the lines a script marks ✗ or ? ("…, but Black didn't answer."), or its error. What's
 * on (the "status" command's JSON) is kept for the block, for the menu, and for his model, as information.
 *
 * Kept: the folders and whether each is in the menu bar (`scripts`), and the scenes (`scenes`), in the app's
 * settings storage; the manifests stay in their folders, read again whenever one changes.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, aimChoice, checkManifest, doneLine, manifestText, readManifest, slug, stepArgs } from './script-manifest.js';
import { createScriptRunner } from './script-runner.js';
import { blockWords, matchWords, mentions, sceneAsked } from './script-words.js';

export const SCRIPTS_KEY = 'scripts';
export const SCENES_KEY = 'scenes';
const MOST_SCRIPTS = 24;
const MOST_SCENES = 24;
const MOST_STEPS = 12;
/** What's on is told to his model for this long after it was read. */
const STATE_FRESH_MS = 10 * 60 * 1000;
/** Marks a script puts before a line about one thing: done, failed, not confirmed, sent. */
const LINE = /^([✓✔✗✘?→])\s*([^:]{1,60}?):\s*(.*)$/u;
const FAILED = new Set(['✗', '✘', '?']);

/** What a script printed, as marked lines: [{mark, name, text}], for "…, but Black didn't answer". */
export function resultLines(out) {
  return String(out ?? '')
    .split('\n')
    .map((line) => LINE.exec(line.trim()))
    .filter(Boolean)
    .map(([, mark, name, text]) => ({ mark, name: name.trim(), text: text.trim() }));
}

const listed = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * A failed command's reason, in a sentence: its error's first, without the program's name before it ("lights:
 * Couldn't hear any bulbs from "141 Groton Rd". Check they have power…" → "Couldn't hear any bulbs from "141
 * Groton Rd".").
 */
export function failureLine(manifest, result) {
  const lines = `${result.err || ''}\n${result.out || ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^usage:/i.test(line) && !/^Traceback/.test(line));
  const base = path.basename(manifest.run).replace(/\.[a-z]+$/i, '');
  let line = (lines.find((item) => !/^\s*File "/.test(item)) || '').replace(new RegExp(`^(?:${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|error)(?::\\s*(?:error:)?)\\s*`, 'i'), '');
  line = line.split(/(?<=[.!?])\s+(?=[A-Z])/)[0].slice(0, 180).trim();
  return line ? (/[.!?]$/.test(line) ? line : `${line}.`) : `${manifest.name} didn’t work${result.code === 124 ? ': it took too long' : ''}.`;
}

/** A script's "what's on", as it printed it, kept to what's shown: summary, say, where, values, and the same by aim. */
export function stateIn(source) {
  let raw = source;
  if (typeof source === 'string') {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      raw = JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const words = (value, most) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, most) : '');
  const values = (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[\w-]{1,32}$/.test(key) && (item === null || ['boolean', 'number', 'string'].includes(typeof item))).slice(0, 12).map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 40) : item]))
      : {};
  const part = (value) => ({ summary: words(value?.summary, 60), say: words(value?.say, 300), values: values(value?.values) });
  const by = raw.by && typeof raw.by === 'object' && !Array.isArray(raw.by)
    ? Object.fromEntries(Object.entries(raw.by).slice(0, 80).map(([key, value]) => [key.toLowerCase().slice(0, 60), part(value)]))
    : {};
  return { ...part(raw), where: words(raw.where, 60), by };
}

/** The part of what's on that an aim picks: all of it, or `by` that aim. */
export function stateFor(state, aim) {
  if (!state) return null;
  if (!aim?.value) return state;
  return state.by?.[aim.value.toLowerCase()] || state.by?.[aim.label.toLowerCase()] || null;
}

/**
 * What he says after a step ran: its done line and what didn't work, or why it failed; for an "ask", what's on.
 * @returns {{ok:boolean, text:string}}
 */
export function outcomeOf(manifest, built, result) {
  if (result.code !== 0) return { ok: false, text: failureLine(manifest, result) };
  if (built.control.kind === 'ask') {
    const state = stateIn(result.state ?? result.out);
    const part = stateFor(state, built.aim);
    const first = String(result.out || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
    return { ok: true, text: part?.say || part?.summary || (state ? '' : first.slice(0, 200)) || `${manifest.name} said nothing.` };
  }
  const done = doneLine(manifest, built) || 'Done.';
  const failed = resultLines(result.out).filter((line) => FAILED.has(line.mark)).map((line) => line.name);
  if (!failed.length) return { ok: true, text: done };
  return { ok: true, text: `${done.replace(/[.!]+$/, '')}, but ${listed([...new Set(failed)])} didn’t answer.` };
}

/** A tray menu's presets for a slider: its named steps, or a quarter of its range apart. */
export function sliderPresets(control) {
  if (control.names?.length) {
    return control.names.map((entry, i, all) => {
      const next = all[i + 1]?.at ?? control.max;
      const at = i === 0 ? control.min : i === all.length - 1 ? control.max : Math.round((entry.at + next) / 2);
      return { value: at, label: entry.name.charAt(0).toUpperCase() + entry.name.slice(1) };
    });
  }
  // Round numbers where the range allows: 25, 50, 75, 100 of 1–100, not 26 and 51.
  const span = control.max - control.min;
  const nice = span >= 20 && control.step <= 5 ? 5 : control.step;
  return [0.25, 0.5, 0.75, 1].map((share) => {
    const value = Math.min(control.max, Math.max(control.min, Math.round((control.min + span * share) / nice) * nice));
    return { value, label: `${value}${control.unit}` };
  });
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage  chrome.storage-shaped (the app's settings storage)
 * @param {(change:{script?:string, scenes?:boolean}) => void} [deps.onChange]  a block or the scenes changed
 * @param {(folder:string) => Promise<{manifest:object|null, problems:string[]}>} [deps.draft]  a folder with no
 *   jester.json, read and drafted by the talking model (script-draft.js)
 * @param {(request:object) => Promise<{json:any}>} [deps.request]  the talking model, for words no phrase fits
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createScripts({ storage, onChange = () => undefined, draft = null, request = null, log = () => undefined, fs = nodeFs, now = Date.now, makeRunner = createScriptRunner }) {
  /** @type {Map<string, object>} */
  const blocks = new Map();
  let scenes = [];
  let loaded = null;
  /** Words the talking model worked out (resolve), by the catalog they were worked out against. */
  const resolved = new Map();

  function readFolder(folder) {
    const file = path.join(folder, MANIFEST_FILE);
    let mtime = 0;
    let source = '';
    try {
      mtime = fs.statSync(file).mtimeMs;
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { manifest: null, problems: [err.code === 'ENOENT' ? `There’s no ${MANIFEST_FILE} in ${folder}.` : `Jester can’t read ${MANIFEST_FILE} (${err.code || err.message}).`], mtime: 0 };
    }
    return { ...readManifest(source), mtime };
  }

  /** A block's manifest, read again if jester.json changed since. */
  function fresh(block) {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(block.folder, MANIFEST_FILE)).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (mtime === block.mtime && (block.manifest || mtime === -1)) return block;
    const read = readFolder(block.folder);
    if (block.runner) block.runner.close();
    block.manifest = read.manifest;
    block.problems = read.problems;
    block.mtime = mtime;
    block.vocabulary = read.manifest ? blockWords(read.manifest) : new Set();
    block.runner = read.manifest
      ? makeRunner({ folder: block.folder, manifest: read.manifest, log, onState: (state) => told(block, state) })
      : null;
    return block;
  }

  function told(block, state) {
    const kept = stateIn(state);
    if (!kept) return;
    block.state = { ...kept, at: now() };
    onChange({ script: block.id });
  }

  async function load() {
    const stored = await storage.get([SCRIPTS_KEY, SCENES_KEY]);
    const entries = Array.isArray(stored?.[SCRIPTS_KEY]) ? stored[SCRIPTS_KEY] : [];
    for (const entry of entries.slice(0, MOST_SCRIPTS)) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.folder !== 'string' || blocks.has(entry.id)) continue;
      blocks.set(entry.id, fresh({ id: entry.id, folder: entry.folder, menu: entry.menu !== false, mtime: null, state: null, last: null, queue: Promise.resolve(), busy: 0 }));
    }
    scenes = (Array.isArray(stored?.[SCENES_KEY]) ? stored[SCENES_KEY] : []).filter((scene) => scene && typeof scene.id === 'string' && typeof scene.name === 'string' && Array.isArray(scene.steps)).slice(0, MOST_SCENES);
  }
  const ready = () => (loaded ||= load().catch((err) => log('scripts: couldn’t load:', err.message)));

  const keepList = () => storage.set({ [SCRIPTS_KEY]: [...blocks.values()].map(({ id, folder, menu }) => ({ id, folder, menu })) });
  const keepScenes = () => storage.set({ [SCENES_KEY]: scenes });

  /** Runs `job` after everything asked of this script before it. */
  function enqueue(block, job) {
    block.busy += 1;
    onChange({ script: block.id });
    const done = block.queue.then(job, job);
    block.queue = done.catch(() => undefined).finally(() => {
      block.busy -= 1;
      onChange({ script: block.id });
    });
    return done;
  }

  /** A command's answer, kept for the block: what's on, if it said, and what happened. */
  function settle(block, built, result) {
    const state = stateIn(result.state ?? (built.control.kind === 'ask' ? result.out : null));
    if (state) block.state = { ...state, at: now() };
    const outcome = outcomeOf(block.manifest, built, result);
    // The card's line is what the last press did: a question of what's on, answered, isn't one unless it failed.
    if (built.control.kind !== 'ask' || !outcome.ok) block.last = { ok: outcome.ok, text: outcome.text, at: now() };
    log(`scripts: ${block.manifest.name} ${built.control.id}: exit ${result.code}${outcome.ok ? '' : ` (${outcome.text.slice(0, 120)})`}`);
    return outcome;
  }

  /** After a change with no "what's on" in its answer (run plainly), what's on is read again, if it can be. */
  function lookAgain(block) {
    if (!block.manifest?.status || block.runner?.serving) return;
    refresh(block.id).catch(() => undefined);
  }

  /**
   * One step: a control, with its value and aim. A slider's drag sends only the newest value.
   * @param {{script:string, control:string, value?:any, aim?:string, drag?:boolean}} step
   * @returns {Promise<{ok:boolean, text:string, script?:string, lines?:object[]}>}
   */
  async function run(step) {
    await ready();
    const block = blocks.get(String(step?.script ?? ''));
    if (!block) return { ok: false, text: 'That script isn’t in Controls any more.' };
    fresh(block);
    if (!block.manifest) return { ok: false, text: `${path.basename(block.folder)}: ${block.problems[0] || 'its jester.json can’t be used.'}` };
    const built = stepArgs(block.manifest, step);
    if (!built.ok) return { ok: false, text: built.why };
    if (step.drag) {
      block.nextDrag = step;
      if (!block.dragging) {
        // Cleared in the same moment the last value's found missing: a value that comes after starts another round.
        block.dragging = true;
        enqueue(block, async () => {
          try {
            while (block.nextDrag) {
              const next = block.nextDrag;
              block.nextDrag = null;
              const turn = current(block, next);
              if (!turn.ok) continue;
              const result = await turn.runner.run(turn.built.args);
              const state = result.state && stateIn(result.state);
              if (state) block.state = { ...state, at: now() };
            }
          } finally {
            block.dragging = false;
          }
        }).catch((err) => log(`scripts: ${block.id}: a drag went wrong (${err.message})`));
      }
      return { ok: true, text: '', script: block.id };
    }
    return enqueue(block, async () => {
      const turn = current(block, step);
      if (!turn.ok) return { ok: false, text: turn.why, script: block.id };
      const result = await turn.runner.run(turn.built.args);
      const outcome = settle(block, turn.built, result);
      if (result.code === 0 && turn.built.control.kind !== 'ask' && !result.state) lookAgain(block);
      return { ...outcome, script: block.id, lines: resultLines(result.out) };
    });
  }

  /**
   * A step as it runs now, when its turn has come: from jester.json as it is then (changed meanwhile, the command is
   * the new one's, or none), on the program that goes with it.
   */
  function current(block, step) {
    fresh(block);
    if (!block.manifest || !block.runner) return { ok: false, why: `${path.basename(block.folder)}: ${block.problems?.[0] || 'its jester.json can’t be used.'}` };
    const built = stepArgs(block.manifest, step);
    return built.ok ? { ok: true, built, runner: block.runner } : { ok: false, why: built.why };
  }

  /** What's on, read again (the window opening, or after a change run plainly). Several asks at once share one read. */
  async function refresh(id) {
    await ready();
    const block = blocks.get(id);
    if (!block) return null;
    fresh(block);
    if (!block.manifest?.status) return block.state;
    if (block.refreshing) return block.refreshing;
    block.refreshing = enqueue(block, async () => {
      fresh(block);
      if (!block.manifest?.status || !block.runner) return block.state;
      const result = await block.runner.run(block.manifest.status);
      const state = result.code === 0 ? stateIn(result.state ?? result.out) : null;
      if (state) block.state = { ...state, at: now() };
      else block.last = { ok: false, text: failureLine(block.manifest, result.code === 0 ? { ...result, err: `${block.manifest.name} didn’t say what’s on.` } : result), at: now() };
      return block.state;
    }).finally(() => (block.refreshing = null));
    return block.refreshing;
  }

  /** A model's or a scene's steps, checked: [{script, control, value?, aim?}] that can run, and what couldn't. */
  function checkSteps(steps) {
    const good = [];
    const problems = [];
    for (const step of (Array.isArray(steps) ? steps : []).slice(0, MOST_STEPS)) {
      const block = blocks.get(String(step?.script ?? ''));
      if (!block?.manifest) {
        problems.push(`no script called “${String(step?.script ?? '').slice(0, 40)}”`);
        continue;
      }
      const built = stepArgs(block.manifest, step);
      if (!built.ok) {
        problems.push(built.why);
        continue;
      }
      good.push({ script: block.id, control: built.control.id, ...(built.control.kind === 'slider' || built.control.kind === 'choices' ? { value: built.value } : {}), ...(built.aim?.value ? { aim: built.aim.value } : {}) });
    }
    return { steps: good, problems };
  }

  /** Several steps, one after another; scenes by id. What's said is each one's, failures first. */
  async function runAll(steps) {
    const outcomes = [];
    for (const step of steps) outcomes.push(step.scene ? await runScene(step.scene) : await run(step));
    const failed = outcomes.filter((outcome) => !outcome.ok);
    const said = (failed.length ? failed : outcomes).map((outcome) => outcome.text).filter(Boolean);
    return { ok: !failed.length, text: [...new Set(said)].join(' ') || 'Done.' };
  }

  async function runScene(id) {
    await ready();
    const scene = scenes.find((item) => item.id === id);
    if (!scene) return { ok: false, text: 'That scene isn’t there any more.' };
    const outcomes = [];
    for (const step of scene.steps) outcomes.push(await run(step));
    const failed = outcomes.filter((outcome) => !outcome.ok);
    return failed.length ? { ok: false, text: `${scene.name}: ${failed.map((outcome) => outcome.text).join(' ')}` } : { ok: true, text: `${scene.name}, done.` };
  }

  /** A phrase of the block's, to show under it as what can be said: "turn off the lights". */
  function example(manifest) {
    const control = manifest.controls.find((item) => item.kind === 'button' && item.words.length) || manifest.controls.find((item) => item.words.length);
    const say = control?.words.find((word) => !/\{aim\}/.test(word.say))?.say;
    if (!say) return '';
    const middle = control.kind === 'slider' ? `${Math.round((control.min + control.max) / 2)}${control.unit === '%' ? ' percent' : ''}` : control.choices?.[0]?.value || '';
    return say.replace(/\{aim\?\}\s*/g, '').replace(/\{value\??\}/g, middle).replace(/\s+/g, ' ').trim();
  }

  /** The block a window shows: everything but the program and its arguments' plumbing. */
  function view(block) {
    const manifest = block.manifest;
    return {
      id: block.id,
      folder: block.folder,
      menu: block.menu,
      busy: block.busy > 0,
      problems: block.problems || [],
      last: block.last,
      state: block.state,
      ...(manifest
        ? {
            name: manifest.name,
            icon: manifest.icon,
            about: manifest.about,
            aim: manifest.aim ? { label: manifest.aim.label, choices: manifest.aim.choices.filter((choice) => choice.chip).map(({ label, value }) => ({ label, value })) } : null,
            controls: manifest.controls.map(({ args, words, drag, done, ...control }) => ({ ...control, voice: words.length > 0 })),
            hasStatus: !!manifest.status,
            example: example(manifest)
          }
        : { name: path.basename(block.folder) })
    };
  }

  /** The catalog his model is shown: each control as "script.control", with what it takes. */
  function catalog() {
    const lines = [];
    for (const block of blocks.values()) {
      fresh(block);
      const manifest = block.manifest;
      if (!manifest) continue;
      const aims = manifest.aim ? manifest.aim.choices.filter((choice) => choice.value).map((choice) => choice.label) : [];
      if (manifest.about) lines.push(`${manifest.name}: ${manifest.about}`);
      if (aims.length) lines.push(`  aim (leave it out for all of them): ${aims.join(', ')}`);
      for (const control of manifest.controls) {
        const takes =
          control.kind === 'slider' ? `, value ${control.min} to ${control.max}${control.unit}${control.low && control.high ? ` (${control.min} ${control.low.toLowerCase()}, ${control.max} ${control.high.toLowerCase()})` : ''}`
          : control.kind === 'choices' ? `, value one of ${control.choices.map((choice) => choice.value).join(', ')}`
          : control.kind === 'ask' ? ': says what’s on; use it to answer questions about them'
          : '';
        lines.push(`- ${block.id}.${control.id}: ${manifest.name}, ${control.label}${takes}${control.askFirst ? ' (asks the user first)' : ''}`);
      }
    }
    for (const scene of scenes) lines.push(`- scene.${scene.id}: the ${scene.name} scene (${scene.steps.length} step${scene.steps.length === 1 ? '' : 's'})`);
    return lines.join('\n');
  }

  /**
   * A whole reply that runs one of them, for his prompt: what's said and the JSON back, from the scripts themselves,
   * so it's never a control that isn't there. A slider with an aim shows the most ("dim the Bedside lights to 50").
   */
  function promptExample() {
    const usable = [...blocks.values()].filter((block) => block.manifest);
    for (const pick of [(control, manifest) => control.kind === 'slider' && manifest.aim, (control) => control.kind === 'slider' || control.kind === 'choices', (control) => control.kind === 'button']) {
      for (const block of usable) {
        const manifest = block.manifest;
        const control = manifest.controls.find((item) => pick(item, manifest) && item.words.some((word) => !('value' in word)));
        if (!control) continue;
        const aim = manifest.aim?.choices.find((choice) => choice.value && choice.chip) || null;
        const phrase = control.words.find((word) => !('value' in word) && (!aim || /\{aim\??\}/.test(word.say))) || control.words.find((word) => !('value' in word));
        const value = control.kind === 'slider' ? String(Math.round((control.min + control.max) / 2)) : control.kind === 'choices' ? control.choices[0].value : '';
        const said = phrase.say.replace(/\{aim\??\}/g, /\{aim\??\}/.test(phrase.say) && aim ? aim.label : '').replace(/\{value\??\}/g, value).replace(/\s+/g, ' ').trim();
        const usedAim = aim && /\{aim\??\}/.test(phrase.say);
        const step = { id: `${block.id}.${control.id}`, ...(value ? { value } : {}), ...(usedAim ? { aim: aim.value } : {}) };
        return { said, reply: JSON.stringify({ say: 'Okay', do: '', new: false, run: [step] }) };
      }
    }
    return null;
  }

  /** A model's "run": [{id:"lights.off", value, aim}], as steps that can run. */
  function fromModel(list) {
    const steps = [];
    const problems = [];
    for (const item of (Array.isArray(list) ? list : []).slice(0, MOST_STEPS)) {
      const id = String(item?.id ?? '').trim().toLowerCase();
      if (id.startsWith('scene.')) {
        const scene = scenes.find((entry) => entry.id === id.slice(6));
        if (scene) steps.push({ scene: scene.id });
        else problems.push(`no scene ${id.slice(6)}`);
        continue;
      }
      const [script, control] = [id.slice(0, id.lastIndexOf('.')), id.slice(id.lastIndexOf('.') + 1)];
      const checked = checkSteps([{ script, control, ...(item?.value !== undefined && item.value !== null && item.value !== '' ? { value: item.value } : {}), ...(item?.aim ? { aim: String(item.aim) } : {}) }]);
      steps.push(...checked.steps);
      problems.push(...checked.problems);
    }
    return { steps, problems };
  }

  /** Whether any of these steps asks before it's run by voice. */
  function asksFirst(steps) {
    return steps.some((step) => {
      if (step.scene) {
        const scene = scenes.find((item) => item.id === step.scene);
        return !!scene && (scene.askFirst || asksFirst(scene.steps));
      }
      return !!blocks.get(step.script)?.manifest?.controls.find((control) => control.id === step.control)?.askFirst;
    });
  }

  /** "Turn off the lights?" — what's asked first, in a few words. */
  function label(steps) {
    return steps
      .map((step) => {
        if (step.scene) return `the ${scenes.find((item) => item.id === step.scene)?.name || 'scene'} scene`;
        const manifest = blocks.get(step.script)?.manifest;
        const built = manifest && stepArgs(manifest, step);
        return built?.ok ? `${manifest.name}: ${built.control.label}${built.name ? ` ${built.name}` : ''}${built.aim?.value ? ` (${built.aim.label})` : ''}` : '';
      })
      .filter(Boolean)
      .join(', ');
  }

  return {
    ready,
    get count() {
      return blocks.size;
    },
    /** Everything the Controls window shows. */
    async list() {
      await ready();
      return { blocks: [...blocks.values()].map((block) => view(fresh(block))), scenes: scenes.map((scene) => ({ ...scene, label: label(scene.steps) })) };
    },
    view: (id) => (blocks.has(id) ? view(fresh(blocks.get(id))) : null),
    run,
    runAll,
    runScene,
    refresh,
    checkSteps,
    fromModel,
    asksFirst,
    label,
    catalog,
    /** The scripts for his prompt (conversation.js personaPrompt): the catalog and an example, or null with none. */
    prompt() {
      const text = catalog();
      return text ? { catalog: text, example: promptExample() } : null;
    },
    /**
     * A folder dropped on Controls: its jester.json if it has one, else a draft of one from what's in it.
     * @returns {Promise<{ok:boolean, folder:string, manifest?:object, problems:string[], found?:boolean, script?:string, why?:string}>}
     */
    async inspect(folder) {
      await ready();
      const where = path.resolve(String(folder ?? ''));
      let stat;
      try {
        stat = fs.statSync(where);
      } catch {
        return { ok: false, folder: where, problems: [], why: 'Jester can’t find that folder.' };
      }
      if (!stat.isDirectory()) return { ok: false, folder: where, problems: [], why: 'That’s a file: drop the folder it’s in.' };
      const there = [...blocks.values()].find((block) => block.folder === where);
      const read = readFolder(where);
      if (read.manifest || read.mtime) return { ok: !!read.manifest, folder: where, manifest: read.manifest, problems: read.problems, found: true, ...(there ? { script: there.id } : {}), ...(read.manifest ? {} : { why: read.problems[0] }) };
      if (!draft) return { ok: false, folder: where, problems: [], why: `There’s no ${MANIFEST_FILE} in that folder.` };
      const drafted = await draft(where);
      return { ok: !!drafted.manifest, folder: where, manifest: drafted.manifest, problems: drafted.problems || [], found: false, ...(drafted.manifest ? {} : { why: drafted.why || drafted.problems?.[0] || 'Jester couldn’t work out what that folder’s scripts do.' }) };
    },
    /**
     * A manifest the user approved, written to the folder's jester.json, and the folder added if it's new.
     * @returns {Promise<{ok:boolean, script?:string, why?:string, problems?:string[]}>}
     */
    async save(folder, manifest) {
      await ready();
      const where = path.resolve(String(folder ?? ''));
      const { manifest: checked, problems } = checkManifest(manifest);
      if (!checked) return { ok: false, why: problems[0] || 'That can’t be saved.', problems };
      const existing = [...blocks.values()].find((block) => block.folder === where);
      if (!existing && blocks.size >= MOST_SCRIPTS) return { ok: false, why: `Controls holds ${MOST_SCRIPTS} scripts at most.` };
      const file = path.join(where, MANIFEST_FILE);
      try {
        const next = `${file}.jester-tmp`;
        fs.writeFileSync(next, manifestText(checked));
        fs.renameSync(next, file);
      } catch (err) {
        return { ok: false, why: `Jester couldn’t write ${MANIFEST_FILE} in that folder (${err.code || err.message}).` };
      }
      let block = existing;
      if (!block) {
        const taken = new Set(blocks.keys());
        let id = slug(checked.name);
        for (let n = 2; taken.has(id) || id === 'scene'; n++) id = `${slug(checked.name).slice(0, 28)}-${n}`;
        block = { id, folder: where, menu: true, mtime: null, state: null, last: null, queue: Promise.resolve(), busy: 0 };
        blocks.set(id, block);
      }
      block.mtime = null;
      fresh(block);
      await keepList();
      log(`scripts: ${existing ? 'saved' : 'added'} ${checked.name} (${checked.controls.length} controls)`);
      onChange({ script: block.id });
      return { ok: true, script: block.id, problems };
    },
    /** Taken out of Controls: its folder and jester.json are left as they are. Scenes lose its steps. */
    async remove(id) {
      await ready();
      const block = blocks.get(id);
      if (!block) return { ok: false };
      block.runner?.close();
      blocks.delete(id);
      scenes = scenes.map((scene) => ({ ...scene, steps: scene.steps.filter((step) => step.script !== id) })).filter((scene) => scene.steps.length);
      await keepList();
      await keepScenes();
      onChange({ script: id, scenes: true });
      return { ok: true };
    },
    async setMenu(id, on) {
      await ready();
      const block = blocks.get(id);
      if (!block) return { ok: false };
      block.menu = !!on;
      await keepList();
      onChange({ script: id });
      return { ok: true };
    },
    /** A scene saved: a name and its steps, checked. A new one gets an id from its name. */
    async saveScene(input) {
      await ready();
      const name = String(input?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
      if (!name) return { ok: false, why: 'A scene needs a name.' };
      const asked = Array.isArray(input?.steps) ? input.steps : [];
      if (!asked.length) return { ok: false, why: 'A scene needs at least one step.' };
      if (asked.length > MOST_STEPS) return { ok: false, why: `A scene has ${MOST_STEPS} steps at most.` };
      // Every step as it was set, or none: a step that can't run isn't quietly dropped.
      const steps = [];
      for (const [index, step] of asked.entries()) {
        const checked = checkSteps([step]);
        if (!checked.steps.length) return { ok: false, why: `Step ${index + 1} can’t run: ${checked.problems[0] || 'its script isn’t there.'}` };
        steps.push(...checked.steps);
      }
      const clash = scenes.find((scene) => scene.name.toLowerCase() === name.toLowerCase() && scene.id !== input?.id);
      if (clash) return { ok: false, why: `There’s already a scene called ${clash.name}.` };
      let scene = scenes.find((item) => item.id === input?.id);
      if (!scene) {
        if (scenes.length >= MOST_SCENES) return { ok: false, why: `Controls holds ${MOST_SCENES} scenes at most.` };
        let id = slug(name);
        for (let n = 2; scenes.some((item) => item.id === id); n++) id = `${slug(name).slice(0, 28)}-${n}`;
        scene = { id };
        scenes.push(scene);
      }
      Object.assign(scene, { name, steps, askFirst: input?.askFirst === true });
      await keepScenes();
      onChange({ scenes: true });
      return { ok: true, id: scene.id };
    },
    async removeScene(id) {
      await ready();
      const before = scenes.length;
      scenes = scenes.filter((scene) => scene.id !== id);
      if (scenes.length === before) return { ok: false };
      await keepScenes();
      onChange({ scenes: true });
      return { ok: true };
    },
    /**
     * What a sentence asks of the scripts, from their words alone (no model): a scene by its name, or a control by
     * one of its phrases. null when it asks for neither.
     * @returns {{steps:object[]}|null}
     */
    match(said) {
      for (const scene of scenes) if (sceneAsked(said, scene.name)) return { steps: [{ scene: scene.id }] };
      const usable = [...blocks.values()].map(fresh).filter((block) => block.manifest).map((block) => ({ id: block.id, manifest: block.manifest }));
      const found = matchWords(said, usable);
      if (!found) return null;
      const { words, ...step } = found;
      return { steps: [step] };
    },
    /** Whether a sentence names a script's things: then it may be one the talking model can resolve. */
    mentions(said) {
      const vocabularies = [...blocks.values()].filter((block) => block.manifest).map((block) => block.vocabulary);
      return mentions(said, vocabularies) || scenes.some((scene) => sceneAsked(said, scene.name));
    },
    /**
     * Words no phrase fits, worked out by the talking model against the catalog: a taught phrase's sentence ("dim the
     * lights to 20 and make them warm"), or a command for the laptop that was really the scripts'.
     * @returns {Promise<{steps:object[]}|null>}
     */
    async resolve(said, { signal } = {}) {
      if (!request || !blocks.size) return null;
      const key = `${catalog()}\n${String(said).trim().toLowerCase()}`;
      if (resolved.has(key)) return resolved.get(key);
      const { json } = await request({
        system: `You turn a request into steps for the user's own scripts, or none. The scripts:\n${catalog()}\nReply with JSON: {"run":[{"id":"script.control","value":"...","aim":"..."}]}, value and aim only where that control takes them, or {"run":[]} when the request isn't for these scripts.`,
        prompt: String(said).slice(0, 400),
        schema: { type: 'object', properties: { run: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' }, aim: { type: 'string' } }, required: ['id'] } } }, required: ['run'] },
        maxOutputTokens: 300,
        ...(signal ? { signal } : {})
      });
      const { steps } = fromModel(json?.run);
      const answer = steps.length ? { steps } : null;
      resolved.set(key, answer);
      if (resolved.size > 50) resolved.delete(resolved.keys().next().value);
      return answer;
    },
    /** What's on, for his model's brackets: each script read lately, as a line. */
    stateLines() {
      const lines = [];
      for (const block of blocks.values()) {
        if (!block.manifest || !block.state || now() - block.state.at > STATE_FRESH_MS) continue;
        const minutes = Math.round((now() - block.state.at) / 60000);
        lines.push(`${block.manifest.name}${block.state.where ? ` (${block.state.where})` : ''}: ${block.state.summary || block.state.say}, ${minutes < 1 ? 'just now' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`}.`);
      }
      return lines.length ? `What the user's scripts said is on:\n${lines.join('\n')}` : '';
    },
    /** The menu bar's part: each script shown there, with its buttons, a slider's presets and a choice's choices; and the scenes. */
    menu() {
      const scripts = [...blocks.values()].filter((block) => block.menu && block.manifest).map((block) => ({
        id: block.id,
        name: block.manifest.name,
        summary: block.state?.summary || '',
        items: block.manifest.controls.filter((control) => control.kind !== 'ask').map((control) => {
          if (control.kind === 'button') return { label: control.label, step: { script: block.id, control: control.id } };
          const options = control.kind === 'slider' ? sliderPresets(control) : control.choices.map((choice) => ({ value: choice.value, label: choice.label }));
          return { label: control.label, items: options.map((option) => ({ label: option.label, step: { script: block.id, control: control.id, value: option.value } })) };
        })
      }));
      return { scripts, scenes: scenes.map((scene) => ({ id: scene.id, name: scene.name })) };
    },
    aimChoice: (id, value) => {
      const manifest = blocks.get(id)?.manifest;
      return manifest ? aimChoice(manifest, value) : null;
    },
    /** Stops every served program: Jester's quitting. */
    close() {
      for (const block of blocks.values()) block.runner?.close();
    }
  };
}
