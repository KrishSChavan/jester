/**
 * A script folder's jester.json: what its block in Controls holds, and what
 * each button, slider or choice runs (the user, 2026-11-18: "attach a folder
 * for scripts for him to execute", "a block for lights and then turn them off
 * and control their brightness and white level"). Pure: text in, a checked
 * manifest and what was wrong with it out, or a step in and the arguments out.
 *
 *   {
 *     "jester": 1,
 *     "name": "Lights", "icon": "bulb", "about": "What it does, in a sentence.",
 *     "run": "lights",                       the program, inside the folder
 *     "timeout": 30,                         seconds a command may take
 *     "serve": ["serve"],                    optional: stays running and takes commands as JSON lines (script-runner.js)
 *     "status": ["status", "--json"],        optional: prints what's on now, as JSON (stateIn)
 *     "aim": {                               optional: chips that aim every control at a part of it
 *       "label": "Which lights",
 *       "all": "lights",                     what all of them are called when no chip is picked ("Lights off.")
 *       "choices": [{"label": "Bedside", "value": "Bedside", "said": "Bedside lights", "chip": true, "words": ["bed"]}]
 *     },
 *     "controls": [
 *       {"id": "off", "kind": "button", "label": "Off", "args": ["off", "{aim}"], "lit": {"power": false},
 *        "done": "{aim} off.", "words": ["turn off the {aim?} lights", "{aim?} lights off"]},
 *       {"id": "brightness", "kind": "slider", "label": "Brightness", "min": 1, "max": 100, "unit": "%",
 *        "track": "brightness", "args": ["brightness", "{value}", "{aim}"], "drag": ["--quick"],
 *        "done": "{aim} at {value}%.", "words": ["dim the {aim?} lights to {value}"]},
 *       {"id": "color", "kind": "choices", "label": "Color", "choices": [{"label": "Red", "value": "red", "color": "#ff453a"}],
 *        "args": ["color", "{value}", "{aim}"], "done": "{aim} {name}.", "words": ["make the {aim?} lights {value}"]},
 *       {"id": "status", "kind": "ask", "label": "What's on", "args": ["status", "--json"],
 *        "words": ["are the {aim?} lights on"]}
 *     ]
 *   }
 *
 * A step is only ever a control's id, a value and an aim: the arguments are the
 * manifest's own, with `{value}` and `{aim}` filled in from what the manifest
 * allows (a number in the slider's range, one of the choices, one of the aim's
 * values). Nothing a model or a page says becomes an argument of its own, and
 * the program is never run through a shell (script-runner.js). An `{aim}` with
 * nothing picked is left out, so "lights off" acts on all of them.
 */

export const MANIFEST_FILE = 'jester.json';
export const ICONS = Object.freeze(['script', 'bulb', 'plug', 'fan', 'speaker', 'tv', 'lock', 'blinds', 'thermostat', 'music', 'power', 'bolt', 'camera', 'desktop', 'sparkle', 'home']);
export const KINDS = Object.freeze(['button', 'slider', 'choices', 'ask']);
const TRACKS = new Set(['brightness', 'warmth', 'plain']);
const LIMITS = Object.freeze({ name: 40, about: 240, label: 32, args: 24, arg: 200, controls: 24, choices: 40, words: 30, word: 80, done: 120, timeout: 300 });
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const text = (value, most) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, most) : '');
const strings = (value, most, each) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, each)).slice(0, most) : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : NaN);
/** "Brightness" → "brightness": an id from a label, for controls the draft didn't give one. */
export const slug = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x';

/**
 * The program's path as the manifest gives it, if it stays inside the folder: relative, with no `..` out of it.
 * @returns {string} '' when it doesn't
 */
export function insidePath(run) {
  const rel = String(run ?? '').trim().replace(/^\.\/+/, '');
  if (!rel || rel.startsWith('/') || rel.startsWith('~') || /^[A-Za-z]:[\\/]/.test(rel) || rel.includes('\0')) return '';
  const parts = rel.split(/[\\/]+/);
  if (parts.some((part) => part === '..' || part === '')) return '';
  return parts.join('/');
}

/** Arguments with only `{value}` and `{aim}` in braces: anything else in braces would never be filled in. */
const goodArgs = (args) => !!args && args.length > 0 && args.every((arg) => !/\{(?!value\}|aim\})[^}]*\}/.test(arg));

/** A slider's or choice's spoken value names: [{at, name}], ascending. */
function namesIn(value, min, max) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({ at: finite(entry?.at), name: text(entry?.name, 24) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at >= min && entry.at <= max && entry.name)
    .sort((a, b) => a.at - b.at)
    .slice(0, 12);
}

/** Words that ask for a control: phrases, or {say, value} with the value fixed ("make the lights warm" → 0). */
function wordsIn(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? { say: text(entry, LIMITS.word) } : { say: text(entry?.say, LIMITS.word), ...(entry && 'value' in entry ? { value: entry.value } : {}) }))
    .filter((entry) => entry.say)
    .slice(0, LIMITS.words);
}

const lit = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key, want]) => /^[\w-]{1,32}$/.test(key) && ['boolean', 'number', 'string'].includes(typeof want)).slice(0, 4))
    : null;

/**
 * A checked manifest, with what was wrong: a control that can't be run is dropped with a reason, and a manifest
 * with no name, no program inside the folder or no control left is no manifest (null).
 * @param {object} raw  jester.json, parsed, or a model's draft of it
 * @returns {{manifest:object|null, problems:string[]}}
 */
export function checkManifest(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, problems: ['It isn’t a JSON object.'] };
  const name = text(raw.name, LIMITS.name);
  if (!name) problems.push('It has no name.');
  const run = insidePath(raw.run);
  if (!run) problems.push(raw.run ? `“${text(raw.run, 80)}” isn’t a program inside the folder.` : 'It doesn’t say which program to run.');
  const timeout = Math.min(Math.max(Math.round(finite(raw.timeout)) || 30, 1), LIMITS.timeout);
  const serve = strings(raw.serve, LIMITS.args, LIMITS.arg);
  const status = strings(raw.status, LIMITS.args, LIMITS.arg);
  let aim = null;
  if (raw.aim && typeof raw.aim === 'object') {
    const seen = new Set();
    const choices = (Array.isArray(raw.aim.choices) ? raw.aim.choices : [])
      .map((choice) => ({ label: text(choice?.label, LIMITS.label), value: typeof choice?.value === 'string' ? choice.value.trim().slice(0, 60) : '', said: text(choice?.said, 40), chip: choice?.chip !== false, words: strings(choice?.words, 8, 40)?.map((word) => word.trim()).filter(Boolean) || [] }))
      .filter((choice) => choice.label && !/^-/.test(choice.value) && !seen.has(choice.value.toLowerCase()) && seen.add(choice.value.toLowerCase()))
      .slice(0, LIMITS.choices);
    if (choices.length) {
      // "All" is the empty value: a manifest that doesn't list it gets it first.
      if (!choices.some((choice) => choice.value === '')) choices.unshift({ label: 'All', value: '', said: '', chip: true, words: [] });
      aim = { label: text(raw.aim.label, LIMITS.label) || 'Which', all: text(raw.aim.all, 40), choices };
    }
  }
  const ids = new Set();
  const controls = [];
  for (const [index, entry] of (Array.isArray(raw.controls) ? raw.controls : []).slice(0, LIMITS.controls).entries()) {
    const label = text(entry?.label, LIMITS.label);
    const kind = KINDS.includes(entry?.kind) ? entry.kind : '';
    const where = `Control ${index + 1}${label ? ` (“${label}”)` : ''}`;
    if (!label || !kind) {
      problems.push(`${where} has no ${label ? 'kind' : 'label'}, so it was left out.`);
      continue;
    }
    let id = ID.test(String(entry.id ?? '')) ? entry.id : slug(entry.id || label);
    while (ids.has(id)) id = `${id.slice(0, 29)}-${ids.size}`;
    const args = strings(entry.args, LIMITS.args, LIMITS.arg);
    if (!goodArgs(args)) {
      problems.push(`${where} has no command to run, so it was left out.`);
      continue;
    }
    const usesValue = args.some((arg) => arg.includes('{value}'));
    const control = { id, kind, label, args, askFirst: entry.askFirst === true, done: text(entry.done, LIMITS.done), words: wordsIn(entry.words) };
    if (kind === 'slider') {
      const min = finite(entry.min);
      const max = finite(entry.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || !usesValue) {
        problems.push(`${where} is a slider without a range or a {value} in its command, so it was left out.`);
        continue;
      }
      const step = finite(entry.step) > 0 ? finite(entry.step) : 1;
      Object.assign(control, { min, max, step, unit: text(entry.unit, 4), low: text(entry.low, 14), high: text(entry.high, 14), track: TRACKS.has(entry.track) ? entry.track : 'plain', drag: strings(entry.drag, 4, 40) || [], names: namesIn(entry.names, min, max) });
    } else if (kind === 'choices') {
      const seen = new Set();
      const choices = (Array.isArray(entry.choices) ? entry.choices : [])
        .map((choice) => ({ label: text(choice?.label, LIMITS.label), value: typeof choice?.value === 'string' ? choice.value.trim().slice(0, 60) : '', ...(/^#[0-9a-f]{6}$/i.test(String(choice?.color ?? '')) ? { color: choice.color.toLowerCase() } : {}) }))
        .filter((choice) => choice.label && choice.value && !/^-/.test(choice.value) && !seen.has(choice.value.toLowerCase()) && seen.add(choice.value.toLowerCase()))
        .slice(0, LIMITS.choices);
      if (!choices.length || !usesValue) {
        problems.push(`${where} has no choices or no {value} in its command, so it was left out.`);
        continue;
      }
      control.choices = choices;
    } else if (usesValue) {
      problems.push(`${where} is a ${kind} but its command needs a {value}, so it was left out.`);
      continue;
    }
    if (kind === 'button') {
      const shows = lit(entry.lit);
      if (shows && Object.keys(shows).length) control.lit = shows;
    }
    ids.add(id);
    controls.push(control);
  }
  if (!controls.length) problems.push('It has no controls Jester can run.');
  const manifest = name && run && controls.length
    ? { jester: 1, name, icon: ICONS.includes(raw.icon) ? raw.icon : 'script', about: text(raw.about, LIMITS.about), run, timeout, ...(serve?.length ? { serve } : {}), ...(status?.length ? { status } : {}), ...(aim ? { aim } : {}), controls }
    : null;
  return { manifest, problems };
}

/** jester.json's text, parsed and checked. */
export function readManifest(source) {
  try {
    return checkManifest(JSON.parse(String(source)));
  } catch (err) {
    return { manifest: null, problems: [`jester.json isn’t valid JSON (${String(err.message).slice(0, 120)}).`] };
  }
}

/** A manifest as it's written back to jester.json: two-space JSON, what's at its defaults left out. */
export function manifestText(manifest) {
  const control = ({ askFirst, done, words, drag, names, step, unit, low, high, track, lit: shows, ...rest }) => ({
    ...rest,
    ...(rest.kind === 'slider' ? { ...(step !== 1 ? { step } : {}), ...(unit ? { unit } : {}), ...(low ? { low } : {}), ...(high ? { high } : {}), ...(track && track !== 'plain' ? { track } : {}), ...(drag?.length ? { drag } : {}), ...(names?.length ? { names } : {}) } : {}),
    ...(shows ? { lit: shows } : {}),
    ...(done ? { done } : {}),
    ...(words?.length ? { words: words.map((word) => ('value' in word ? word : word.say)) } : {}),
    ...(askFirst ? { askFirst: true } : {})
  });
  const aim = manifest.aim && {
    label: manifest.aim.label,
    ...(manifest.aim.all ? { all: manifest.aim.all } : {}),
    choices: manifest.aim.choices.map(({ label, value, said, chip, words }) => ({ label, value, ...(said ? { said } : {}), ...(chip ? {} : { chip: false }), ...(words?.length ? { words } : {}) }))
  };
  const { controls, aim: _aim, ...rest } = manifest;
  return `${JSON.stringify({ ...rest, ...(aim ? { aim } : {}), controls: controls.map(control) }, null, 2)}\n`;
}

/** The aim choice a value names: by value or label, any case; '' and "all" are all of them. */
export function aimChoice(manifest, value) {
  if (!manifest.aim) return null;
  const want = String(value ?? '').trim().toLowerCase();
  if (!want || want === 'all' || want === 'everything') return manifest.aim.choices.find((choice) => choice.value === '') || null;
  return manifest.aim.choices.find((choice) => choice.value.toLowerCase() === want || choice.label.toLowerCase() === want || choice.words.some((word) => word.toLowerCase() === want)) || null;
}

/** A choice of a control's, by value or label, any case. */
export const choiceOf = (control, value) => {
  const want = String(value ?? '').trim().toLowerCase();
  return want ? control.choices?.find((choice) => choice.value.toLowerCase() === want || choice.label.toLowerCase() === want) || null : null;
};

/** A slider's value as a number in its range, on its steps, or NaN. */
export function sliderValue(control, value) {
  const number = finite(typeof value === 'string' ? value.replace(/%$/, '').trim() : value);
  if (!Number.isFinite(number) || number < control.min || number > control.max) return NaN;
  const stepped = control.min + Math.round((number - control.min) / control.step) * control.step;
  return Math.min(control.max, Math.max(control.min, Number(stepped.toFixed(6))));
}

/**
 * A step's command line, from the manifest alone, or why it can't be run.
 * @param {object} manifest
 * @param {{control:string, value?:any, aim?:string, drag?:boolean}} step
 * @returns {{ok:true, args:string[], control:object, value:any, name:string, aim:object|null} | {ok:false, why:string}}
 *   name: the value as it's said (a choice's label, a slider's named step)
 */
export function stepArgs(manifest, step) {
  const control = manifest.controls.find((item) => item.id === step?.control);
  if (!control) return { ok: false, why: `${manifest.name} has no control called “${String(step?.control ?? '').slice(0, 40)}”.` };
  let value = '';
  let name = '';
  if (control.kind === 'slider') {
    value = sliderValue(control, step.value);
    if (!Number.isFinite(value)) return { ok: false, why: `${control.label} goes from ${control.min} to ${control.max}${control.unit}.` };
    name = control.names.filter((entry) => entry.at <= value).at(-1)?.name || `${value}${control.unit}`;
  } else if (control.kind === 'choices') {
    const choice = choiceOf(control, step.value);
    if (!choice) return { ok: false, why: `${control.label} can be ${control.choices.map((item) => item.label).join(', ')}.` };
    value = choice.value;
    name = choice.label;
  }
  let aim = null;
  if (manifest.aim) {
    aim = aimChoice(manifest, step.aim);
    if (!aim) return { ok: false, why: `${manifest.name} has nothing called “${String(step.aim).slice(0, 40)}”: ${manifest.aim.choices.filter((choice) => choice.value).map((choice) => choice.label).slice(0, 8).join(', ')}.` };
  }
  const fill = (arg) => arg.replaceAll('{value}', String(value)).replaceAll('{aim}', aim?.value ?? '');
  const args = control.args.filter((arg) => !(arg === '{aim}' && !aim?.value)).map(fill);
  if (step.drag && control.kind === 'slider') args.push(...control.drag);
  return { ok: true, args, control, value, name, aim };
}

/** What all of a block, or the part an aim picks, is called aloud: "lights", "Bedside lights", "Black". */
export function aimSaid(manifest, aim) {
  if (aim?.value) return aim.said || aim.label;
  return manifest.aim?.all || manifest.name.toLowerCase();
}

/** "{aim} at {value}%." → "Bedside lights at 30%.", capitalised. */
export function doneLine(manifest, { control, value, name, aim }) {
  const template = control.done || (control.kind === 'button' ? `{aim}: ${control.label.toLowerCase()}.` : control.kind === 'ask' ? '' : `${control.label} {name}.`);
  if (!template) return '';
  const line = template.replaceAll('{aim}', aimSaid(manifest, aim)).replaceAll('{value}', String(value)).replaceAll('{name}', String(name || value)).replace(/\s+/g, ' ').trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}
