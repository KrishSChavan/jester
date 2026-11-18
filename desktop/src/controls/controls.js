/**
 * The Controls window: a card for each of the user's scripts, with its buttons, sliders and choices; scenes above
 * them; and the way to add a folder (+, drop it on the window, or the card at the end), which shows what its block
 * will be before it's added (the user, 2026-11-18: "he drafts, you approve").
 *
 * The page never sees a command line: it asks main.js to run a control of a script with a value and an aim
 * (scripts.js builds the arguments from the folder's jester.json). A card is built once for its shape and then only
 * its live parts change (what's on, which button's lit, where a slider sits, the last result), so a slider being
 * dragged is never moved under the pointer by an answer coming back.
 */

const ICONS = ['script', 'bulb', 'plug', 'fan', 'speaker', 'tv', 'lock', 'blinds', 'thermostat', 'music', 'power', 'bolt', 'camera', 'desktop', 'sparkle', 'home'];
/** A slider being dragged sends at most this often; the last value goes when it's let go. */
const DRAG_MS = 140;
/** Moved by the arrow keys, its value is run once they've stopped for this long. */
const KEYS_MS = 400;
/** A result line is coloured this long, then settles to grey. */
const RESULT_MS = 5000;
const AIMS_KEY = 'controlsAims';

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage({ type: 'jester/scripts', ...message }).catch((err) => ({ ok: false, why: err?.message || 'Jester didn’t answer.' }));

/** An element, with attributes and children. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

function icon(name, extra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon-svg ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${ICONS.includes(name) || ['plus', 'more', 'refresh', 'folder', 'close', 'back', 'trash', 'tick', 'alert', 'mic', 'edit', 'menu-bar', 'sparkle'].includes(name) ? name : 'script'}`);
  svg.append(use);
  return svg;
}

document.documentElement.dataset.platform = /Win/.test(navigator.platform) ? 'win' : 'mac';

let data = { blocks: [], scenes: [] };
/** The chip picked on each card, kept across openings. */
let aims = {};
try {
  aims = JSON.parse(localStorage.getItem(AIMS_KEY) || '{}') || {};
} catch {
  aims = {};
}
const keepAims = () => {
  try {
    localStorage.setItem(AIMS_KEY, JSON.stringify(aims));
  } catch {
    /* only a convenience */
  }
};
/** Sliders the user has hold of: what comes back doesn't move them. */
const held = new Set();
const cards = new Map();
let screen = 'main';
let editingScenes = false;
let justAdded = '';

// ——— Screens ———

function show(name) {
  screen = name;
  for (const section of document.querySelectorAll('.screen')) {
    const on = section.id === name;
    section.classList.toggle('shown', on);
    section.inert = !on;
  }
  closeMenu();
  if (name === 'main') $('add').focus({ preventScroll: true });
}

for (const back of document.querySelectorAll('[data-back]')) back.addEventListener('click', () => show('main'));
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('confirm').hidden) return answerConfirm(false);
  if (!$('menu').hidden) return closeMenu();
  if (screen === 'reading') return cancelReading();
  if (screen !== 'main') show('main');
});

function toast(text, bad = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3500);
}

// ——— The cards ———

/** What's on for the part of a card its chip picks. */
function stateFor(view, aim) {
  const state = view.state;
  if (!state) return null;
  if (!aim) return state;
  return state.by?.[aim.toLowerCase()] || null;
}

const aimOf = (view) => {
  const choices = view.aim?.choices || [];
  const picked = aims[view.id];
  return choices.some((choice) => choice.value === picked) ? picked : '';
};

/** A slider's value as it's shown: its named step ("Warm white"), or the number and unit. */
function sliderText(control, value) {
  if (!Number.isFinite(value)) return '—';
  const named = (control.names || []).filter((entry) => entry.at <= value).at(-1)?.name;
  return named ? named.charAt(0).toUpperCase() + named.slice(1) : `${value}${control.unit || ''}`;
}

/** The colour under a slider's thumb, on its track. */
function thumbColor(control, value) {
  const share = (value - control.min) / (control.max - control.min || 1);
  const stops = control.track === 'warmth' ? [[0, [255, 167, 77]], [0.45, [255, 233, 199]], [0.6, [244, 247, 255]], [1, [185, 214, 255]]] : control.track === 'brightness' ? [[0, [58, 47, 42]], [1, [255, 241, 207]]] : null;
  if (!stops) return '';
  const after = stops.findIndex(([at]) => at >= share);
  const [a, b] = after <= 0 ? [stops[0], stops[0]] : [stops[after - 1], stops[after]];
  const t = b[0] === a[0] ? 0 : (share - a[0]) / (b[0] - a[0]);
  const mix = a[1].map((channel, i) => Math.round(channel + (b[1][i] - channel) * t));
  return `rgb(${mix.join(',')})`;
}

/** The shape of a card: when it changes, the card is built again; otherwise only its live parts are. */
const shapeOf = (view) => JSON.stringify([view.name, view.icon, view.aim, view.controls, view.problems.length && !view.controls]);

function buildCard(view, { preview = false } = {}) {
  const parts = { buttons: new Map(), sliders: new Map(), choices: new Map(), chips: new Map() };
  const card = h('article', { class: 'block', 'data-id': view.id, 'aria-label': view.name });
  const title = h('div', { class: 'block-title' }, h('strong', { text: view.name }), (parts.summary = h('small', { text: view.about || '' })));
  const head = h('div', { class: 'block-head' }, h('div', { class: 'tile' }, icon(view.icon)), title);
  if (!preview) head.append(h('button', { class: 'icon small', type: 'button', 'aria-label': `${view.name}: more`, title: 'More', 'aria-haspopup': 'menu', onclick: (event) => openMenu(view.id, event.currentTarget) }, icon('more')));
  card.append(head);
  if (!view.controls) {
    card.append(h('div', { class: 'problem' }, h('div', { text: view.problems[0] || 'Its jester.json can’t be used.' }), h('div', { class: 'buttons' }, h('button', { class: 'secondary', type: 'button', onclick: () => send({ op: 'reveal', script: view.id }) }, 'Show in Finder'), h('button', { class: 'secondary', type: 'button', onclick: () => askRemove(view) }, 'Remove'))));
    card._parts = parts;
    return card;
  }
  const body = h('div', { class: 'block-body' });
  const choices = view.aim?.choices || [];
  if (choices.length > 1) {
    const row = h('div', { class: 'aim', role: 'radiogroup', 'aria-label': view.aim.label });
    for (const choice of choices) {
      const chip = h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': 'false', text: choice.label, onclick: () => {
        aims[view.id] = choice.value;
        keepAims();
        update(card, currentView(view.id) || view);
      } });
      parts.chips.set(choice.value, chip);
      row.append(chip);
    }
    body.append(row);
  }
  const buttons = view.controls.filter((control) => control.kind === 'button');
  if (buttons.length) {
    const row = h('div', { class: 'buttons' });
    for (const control of buttons) {
      const button = h('button', { class: 'act', type: 'button', text: control.label, ...(control.lit ? { 'aria-pressed': 'false' } : {}), onclick: () => press(card, view.id, control) });
      parts.buttons.set(control.id, button);
      row.append(button);
    }
    body.append(row);
  }
  for (const control of view.controls.filter((item) => item.kind === 'slider')) {
    const key = `${view.id}:${control.id}`;
    const output = h('output', { text: '—' });
    const input = h('input', { type: 'range', min: control.min, max: control.max, step: control.step || 1, value: Math.round((control.min + control.max) / 2), class: `${control.track || 'plain'} unknown`, 'aria-label': control.label });
    let last = 0;
    let pending = null;
    const showValue = () => {
      const value = Number(input.value);
      output.textContent = sliderText(control, value);
      input.style.setProperty('--fill', `${((value - control.min) / (control.max - control.min || 1)) * 100}%`);
      const color = thumbColor(control, value);
      if (color) input.style.setProperty('--thumb', color);
      input.classList.remove('unknown');
    };
    input.addEventListener('input', () => {
      held.add(key);
      showValue();
      if (preview) return;
      const go = () => {
        last = Date.now();
        pending = null;
        send({ op: 'run', script: view.id, control: control.id, value: Number(input.value), aim: aimOf(currentView(view.id) || view), drag: true });
      };
      clearTimeout(pending);
      if (Date.now() - last >= DRAG_MS) go();
      else pending = setTimeout(go, DRAG_MS - (Date.now() - last));
    });
    // Let go of with the pointer, the value's run at once. By the arrow keys, every press is a "change": only the
    // last is run, once they've stopped (each was sent on the way, as a drag's are), or a held key would queue dozens.
    let pointing = false;
    let pointerUp = 0;
    let settle = null;
    input.addEventListener('pointerdown', () => (pointing = true));
    for (const type of ['pointerup', 'pointercancel']) input.addEventListener(type, () => ((pointing = false), (pointerUp = Date.now())));
    input.addEventListener('change', () => {
      clearTimeout(pending);
      clearTimeout(settle);
      const finish = () => {
        held.delete(key);
        if (!preview) runControl(card, view.id, control, Number(input.value));
      };
      if (pointing || Date.now() - pointerUp < 300) finish();
      else settle = setTimeout(finish, KEYS_MS);
    });
    parts.sliders.set(control.id, { input, output, showValue, key });
    body.append(h('div', { class: 'slider' }, h('div', { class: 'slider-head' }, h('span', { text: control.label }), output), input, control.low || control.high ? h('div', { class: 'slider-ends' }, h('span', { text: control.low || '' }), h('span', { text: control.high || '' })) : null));
  }
  for (const control of view.controls.filter((item) => item.kind === 'choices')) {
    const colored = control.choices.every((choice) => choice.color);
    const row = h('div', { class: colored ? 'swatches' : 'options', role: 'radiogroup', 'aria-label': control.label });
    const map = new Map();
    for (const choice of control.choices) {
      const button = colored
        ? h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': choice.label, title: choice.label, style: `--color:${choice.color}`, onclick: () => runControl(card, view.id, control, choice.value) })
        : h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': 'false', text: choice.label, onclick: () => runControl(card, view.id, control, choice.value) });
      map.set(choice.value, button);
      row.append(button);
    }
    parts.choices.set(control.id, map);
    body.append(h('div', {}, h('div', { class: 'choices-head', text: control.label }), row));
  }
  parts.result = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
  if (!preview) body.append(parts.result);
  card.append(body);
  card._parts = parts;
  return card;
}

/** Whether a button's "lit" holds for what's on: On while they're on. */
const litBy = (control, values) => !!control.lit && !!values && Object.entries(control.lit).every(([key, want]) => values[key] === want);

function update(card, view) {
  const parts = card._parts;
  if (!parts || !view.controls) return;
  const aim = aimOf(view);
  const part = stateFor(view, aim);
  const values = part?.values || null;
  for (const [value, chip] of parts.chips) chip.setAttribute('aria-checked', String(value === aim));
  // What's on, and where: "All 3 on · 20% · pink · The Brexx".
  let summary = view.about || '';
  if (view.state) summary = part ? [part.summary, !aim ? view.state.where : ''].filter(Boolean).join(' · ') : 'Not reported';
  else if (view.hasStatus) summary = view.busy ? 'Checking…' : 'Not checked yet';
  parts.summary.textContent = summary;
  parts.summary.classList.toggle('away', /out of range|offline|no reply/i.test(summary));
  card.classList.toggle('lit', values?.power === true);
  card.classList.toggle('busy', !!view.busy);
  for (const control of view.controls) {
    if (control.kind === 'button' && control.lit) parts.buttons.get(control.id)?.setAttribute('aria-pressed', String(litBy(control, values)));
    if (control.kind === 'slider') {
      const slider = parts.sliders.get(control.id);
      const value = values?.[control.id];
      if (slider && !held.has(slider.key) && typeof value === 'number' && Number.isFinite(value)) {
        slider.input.value = String(value);
        slider.showValue();
      } else if (slider && !held.has(slider.key) && values && values.power !== false) {
        // On, and saying nothing of this one (White, while they're a colour): it isn't shown as if it were set.
        slider.input.classList.add('unknown');
        slider.output.textContent = '—';
      }
    }
    if (control.kind === 'choices') {
      for (const [value, button] of parts.choices.get(control.id) || []) button.setAttribute('aria-checked', String(values?.[control.id] === value));
    }
  }
  showResult(card, view.last);
}

function showResult(card, last) {
  const line = card._parts?.result;
  if (!line) return;
  if (!last?.text) {
    line.replaceChildren(h('span', { class: 'faint', text: card.dataset.example || '' }));
    line.className = 'result';
    return;
  }
  const age = Date.now() - (last.at || 0);
  line.replaceChildren(icon(last.ok ? 'tick' : 'alert'), h('span', { text: last.text }));
  line.className = `result ${last.ok ? 'ok' : 'bad'}${last.ok && age > RESULT_MS ? ' settled' : ''}`;
  clearTimeout(line._settle);
  if (last.ok && age <= RESULT_MS) line._settle = setTimeout(() => line.classList.add('settled'), RESULT_MS - age);
}

const currentView = (id) => data.blocks.find((block) => block.id === id) || null;

async function runControl(card, id, control, value) {
  const view = currentView(id);
  if (!view) return;
  const reply = await send({ op: 'run', script: id, control: control.id, value, aim: aimOf(view) });
  // The window's told the new state too; this is for the line under the card, at once.
  showResult(card, { ok: reply.ok !== false, text: reply.text || reply.why || '', at: Date.now() });
}

function press(card, id, control) {
  // Lit at once, as the light will be: the answer puts it right if it isn't.
  if (control.lit) for (const [, button] of card._parts.buttons) if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(button === card._parts.buttons.get(control.id)));
  runControl(card, id, control);
}

function renderBlocks() {
  const list = $('blocks');
  const seen = new Set();
  for (const view of data.blocks) {
    seen.add(view.id);
    let card = cards.get(view.id);
    const shape = shapeOf(view);
    if (!card || card._shape !== shape) {
      const next = buildCard(view);
      next._shape = shape;
      if (card) card.replaceWith(next);
      card = next;
      cards.set(view.id, card);
    }
    card.dataset.example = view.example ? `Say “Jester, ${view.example}”` : '';
    list.append(card);
    update(card, view);
    if (justAdded === view.id) {
      card.classList.add('fresh');
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      justAdded = '';
    }
  }
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    card.remove();
    cards.delete(id);
  }
  const none = !data.blocks.length;
  $('welcome').hidden = !none;
  $('drop-card').hidden = none;
  renderScenes();
}

// ——— Scenes ———

function renderScenes() {
  const section = $('scenes');
  section.hidden = !data.blocks.length && !data.scenes.length;
  section.classList.toggle('editing', editingScenes);
  $('scenes-edit').hidden = !data.scenes.length;
  $('scenes-edit').setAttribute('aria-pressed', String(editingScenes));
  $('scenes-edit').textContent = editingScenes ? 'Done' : 'Edit';
  $('scenes-empty').hidden = !!data.scenes.length;
  const list = $('scene-list');
  list.replaceChildren(
    ...data.scenes.map((scene) =>
      h('button', { class: 'scene', type: 'button', role: 'listitem', title: editingScenes ? `Edit ${scene.name}` : scene.label, onclick: (event) => (editingScenes ? openScene(scene) : runScene(scene, event.currentTarget)) }, icon('sparkle'), scene.name)
    )
  );
}

async function runScene(scene, button) {
  button.classList.remove('done', 'failed');
  button.classList.add('running');
  const reply = await send({ op: 'scene-run', id: scene.id });
  button.classList.remove('running');
  button.classList.add(reply.ok ? 'done' : 'failed');
  setTimeout(() => button.classList.remove('done', 'failed'), 2500);
  toast(reply.text || reply.why || (reply.ok ? 'Done.' : 'That didn’t work.'), !reply.ok);
}

$('scenes-edit').addEventListener('click', () => {
  editingScenes = !editingScenes;
  renderScenes();
});
$('scene-new').addEventListener('click', () => openScene(null));

/** The scene being made or changed: its name, steps and whether it asks first. */
let scene = null;

function openScene(existing) {
  if (!data.blocks.some((block) => block.controls?.length)) return toast('Add a script first: a scene runs its controls.', true);
  scene = existing ? { id: existing.id, name: existing.name, askFirst: !!existing.askFirst, steps: existing.steps.map((step) => ({ ...step })) } : { id: '', name: '', askFirst: false, steps: [] };
  if (!scene.steps.length) scene.steps.push(defaultStep());
  $('scene-title').textContent = existing ? `Edit ${existing.name}` : 'New scene';
  $('scene-name').value = scene.name;
  $('scene-ask').checked = scene.askFirst;
  $('scene-delete').hidden = !existing;
  $('scene-error').hidden = true;
  sayName();
  renderSteps();
  show('scene');
  $('scene-name').focus();
}

const runnable = (view) => (view.controls || []).filter((control) => control.kind !== 'ask');

function defaultStep(script) {
  const view = data.blocks.find((block) => block.id === script && runnable(block).length) || data.blocks.find((block) => runnable(block).length);
  const control = runnable(view)[0];
  return { script: view.id, control: control.id, ...valueDefault(control) };
}

const valueDefault = (control) => (control.kind === 'slider' ? { value: Math.round((control.min + control.max) / 2) } : control.kind === 'choices' ? { value: control.choices[0].value } : {});

function renderSteps() {
  const list = $('scene-steps');
  list.replaceChildren(
    ...scene.steps.map((step, index) => {
      const view = currentView(step.script);
      const control = view?.controls?.find((item) => item.id === step.control);
      const row = h('li', { class: 'step' }, h('span', { class: 'step-num', text: String(index + 1) }));
      const scripts = h('select', { 'aria-label': 'Script', onchange: (event) => {
        scene.steps[index] = defaultStep(event.target.value);
        renderSteps();
      } }, ...data.blocks.filter((block) => runnable(block).length).map((block) => h('option', { value: block.id, text: block.name, selected: block.id === step.script })));
      row.append(scripts);
      if (view && control) {
        row.append(h('select', { 'aria-label': 'Control', onchange: (event) => {
          const next = runnable(view).find((item) => item.id === event.target.value);
          scene.steps[index] = { script: view.id, control: next.id, ...valueDefault(next), ...(step.aim ? { aim: step.aim } : {}) };
          renderSteps();
        } }, ...runnable(view).map((item) => h('option', { value: item.id, text: item.label, selected: item.id === control.id }))));
        if (control.kind === 'slider') {
          row.append(h('input', { class: 'value-input', type: 'number', min: control.min, max: control.max, step: control.step || 1, value: step.value, 'aria-label': `${control.label}${control.unit ? ` (${control.unit})` : ''}`, oninput: (event) => (step.value = Number(event.target.value)) }));
          if (control.unit) row.append(h('span', { class: 'faint', text: control.unit }));
        }
        if (control.kind === 'choices') row.append(h('select', { 'aria-label': control.label, onchange: (event) => (step.value = event.target.value) }, ...control.choices.map((choice) => h('option', { value: choice.value, text: choice.label, selected: choice.value === step.value }))));
        if (view.aim?.choices?.length > 1) row.append(h('select', { 'aria-label': view.aim.label, onchange: (event) => (event.target.value ? (step.aim = event.target.value) : delete step.aim) }, ...view.aim.choices.map((choice) => h('option', { value: choice.value, text: choice.label, selected: (step.aim || '') === choice.value }))));
      }
      row.append(h('span', { class: 'grow' }), h('button', { class: 'icon small', type: 'button', 'aria-label': `Remove step ${index + 1}`, title: 'Remove this step', onclick: () => {
        scene.steps.splice(index, 1);
        renderSteps();
      } }, icon('close')));
      return row;
    })
  );
}

function sayName() {
  $('scene-say').textContent = ($('scene-name').value.trim() || 'goodnight').toLowerCase();
}
$('scene-name').addEventListener('input', sayName);
$('scene-add-step').addEventListener('click', () => {
  scene.steps.push(defaultStep(scene.steps.at(-1)?.script));
  renderSteps();
});

$('scene-save').addEventListener('click', async () => {
  const reply = await send({ op: 'scene-save', scene: { id: scene.id || undefined, name: $('scene-name').value, askFirst: $('scene-ask').checked, steps: scene.steps } });
  if (!reply.ok) {
    $('scene-error').textContent = reply.why || 'That scene can’t be saved.';
    $('scene-error').hidden = false;
    return;
  }
  editingScenes = false;
  show('main');
  toast(scene.id ? 'Scene saved.' : `Scene saved. Say “Jester, ${$('scene-name').value.trim().toLowerCase()}” to run it.`);
});

$('scene-delete').addEventListener('click', async () => {
  if (!(await confirmIt(`Delete the ${scene.name} scene?`, 'Delete'))) return;
  await send({ op: 'scene-remove', id: scene.id });
  show('main');
});

// ——— The ⋯ menu ———

let menuFor = '';

function openMenu(id, anchor) {
  const view = currentView(id);
  if (!view) return;
  menuFor = id;
  const menu = $('menu');
  menu.querySelector('[data-op="refresh"]').hidden = !view.hasStatus;
  menu.querySelector('[data-op="menu"]').setAttribute('aria-checked', String(!!view.menu));
  menu.querySelector('[data-op="edit"]').hidden = !view.controls;
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.min(box.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('button:not([hidden])').focus();
}

function closeMenu() {
  $('menu').hidden = true;
}

addEventListener('mousedown', (event) => {
  if (!$('menu').hidden && !$('menu').contains(event.target)) closeMenu();
});

$('menu').addEventListener('click', async (event) => {
  const op = event.target.closest('button')?.dataset.op;
  if (!op) return;
  const view = currentView(menuFor);
  closeMenu();
  if (!view) return;
  if (op === 'refresh') return void send({ op: 'refresh', script: view.id });
  if (op === 'menu') return void send({ op: 'menu', script: view.id, on: !view.menu });
  if (op === 'reveal') return void send({ op: 'reveal', script: view.id });
  if (op === 'remove') return askRemove(view);
  if (op === 'edit') {
    const reply = await send({ op: 'edit', script: view.id });
    if (!reply.ok) return toast(reply.why || 'That can’t be edited here.', true);
    openReview(reply);
  }
});

async function askRemove(view) {
  if (!(await confirmIt(`Remove ${view.name} from Controls? Its folder and jester.json stay as they are, and you can add it again.`, 'Remove'))) return;
  const reply = await send({ op: 'remove', script: view.id });
  if (reply.ok) toast(`${view.name} removed.`);
}

let confirming = null;
function confirmIt(text, yes) {
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yes;
  $('confirm').hidden = false;
  $('confirm-no').focus();
  return new Promise((resolve) => (confirming = resolve));
}
function answerConfirm(yes) {
  $('confirm').hidden = true;
  confirming?.(yes);
  confirming = null;
}
$('confirm-yes').addEventListener('click', () => answerConfirm(true));
$('confirm-no').addEventListener('click', () => answerConfirm(false));

// ——— Adding a folder ———

let reading = 0;

async function inspect(folder) {
  const mine = ++reading;
  const name = folder.split(/[\\/]/).filter(Boolean).at(-1) || folder;
  $('reading-text').textContent = `Reading “${name}”…`;
  $('reading-detail').textContent = '';
  show('reading');
  // A jester.json is read at once; a draft is the model's, and takes a few seconds.
  const slow = setTimeout(() => {
    if (mine === reading) $('reading-detail').textContent = 'It has no jester.json yet, so Jester is reading its README and scripts with your talking model to set up its controls. This takes a few seconds.';
  }, 700);
  const reply = await send({ op: 'inspect', folder });
  clearTimeout(slow);
  if (mine !== reading) return;
  if (!reply.ok) {
    show('main');
    return toast(reply.why || 'Jester couldn’t use that folder.', true);
  }
  openReview(reply);
}

function cancelReading() {
  reading += 1;
  show('main');
}
$('reading-cancel').addEventListener('click', cancelReading);

async function choose() {
  const reply = await send({ op: 'choose' });
  if (reply?.folder) inspect(reply.folder);
}
$('add').addEventListener('click', choose);
$('welcome-choose').addEventListener('click', choose);
$('drop-card').addEventListener('click', choose);

let depth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (event) => {
  if (!carriesFiles(event) || screen !== 'main') return;
  event.preventDefault();
  depth += 1;
  $('drop').hidden = false;
});
addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = screen === 'main' ? 'copy' : 'none';
});
addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (!depth) $('drop').hidden = true;
});
addEventListener('drop', (event) => {
  event.preventDefault();
  depth = 0;
  $('drop').hidden = true;
  if (screen !== 'main') return;
  const file = event.dataTransfer?.files?.[0];
  const folder = file && globalThis.jesterFiles?.pathOf(file);
  if (folder) inspect(folder);
  else toast('Jester couldn’t tell where that folder is. Use + to choose it.', true);
});

// ——— Checking a folder's block before it's added ———

let review = null;

function openReview(reply) {
  review = { folder: reply.folder, script: reply.script || '', found: !!reply.found, manifest: reply.manifest, removed: new Set(), labels: {}, ask: {}, name: reply.manifest.name, icon: reply.manifest.icon };
  const editing = !!reply.script;
  $('review-title').textContent = editing ? `Edit ${reply.manifest.name}` : `Add ${reply.manifest.name}`;
  $('review-intro').textContent = editing
    ? 'Changes are saved to the folder’s jester.json.'
    : reply.found
      ? 'This folder comes with its own controls (its jester.json). Check them, then add it.'
      : 'Jester read the folder and drafted these controls. Check them, rename or remove any, then add it. They’re saved as jester.json in the folder, so you can change them later.';
  const problems = $('review-problems');
  problems.replaceChildren(...(reply.problems || []).map((problem) => h('li', { text: problem })));
  problems.hidden = !reply.problems?.length;
  $('review-name').value = review.name;
  $('review-folder').replaceChildren(icon('folder'), h('span', { text: reply.folder.replace(/^\/Users\/[^/]+/, '~') }));
  $('review-save').textContent = editing ? 'Save' : 'Add to Controls';
  renderIcons();
  renderReviewControls();
  renderPreview();
  show('review');
}

function renderIcons() {
  $('review-icons').replaceChildren(...ICONS.map((name) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(name === review.icon), 'aria-label': name, title: name, onclick: () => {
    review.icon = name;
    renderIcons();
    renderPreview();
  } }, icon(name))));
}

/** The command a control runs, as it would be typed, with its slots shown. */
const commandLine = (manifest, control) => [manifest.run.replace(/^\.\//, ''), ...control.args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
const KIND_WORDS = { button: 'Button', slider: 'Slider', choices: 'Choices', ask: 'Answers' };

function renderReviewControls() {
  const manifest = review.manifest;
  $('review-controls').replaceChildren(
    ...manifest.controls.map((control) => {
      const removed = review.removed.has(control.id);
      const first = control.words?.[0]?.say?.replace(/\{aim\??\}\s*/g, '').replace(/\{value\??\}/g, control.kind === 'slider' ? String(Math.round((control.min + control.max) / 2)) : control.choices?.[0]?.value || '…');
      const label = h('input', { type: 'text', value: review.labels[control.id] ?? control.label, maxlength: 32, 'aria-label': `Name of ${control.label}`, disabled: removed, oninput: (event) => {
        review.labels[control.id] = event.target.value;
        renderPreview();
      } });
      const ask = h('input', { type: 'checkbox', disabled: removed, onchange: (event) => (review.ask[control.id] = event.target.checked) });
      ask.checked = review.ask[control.id] ?? control.askFirst;
      return h('li', { class: `control-row${removed ? ' removed' : ''}` },
        label,
        h('label', { class: 'ask-toggle', title: 'Check with you first when someone asks out loud' }, 'Ask first', ask),
        h('button', { class: 'icon small', type: 'button', 'aria-label': removed ? `Keep ${control.label}` : `Remove ${control.label}`, title: removed ? 'Keep it' : 'Remove it', onclick: () => {
          if (removed) review.removed.delete(control.id);
          else review.removed.add(control.id);
          renderReviewControls();
          renderPreview();
        } }, icon(removed ? 'refresh' : 'trash')),
        h('div', { class: 'meta' },
          h('span', { class: 'kind', text: KIND_WORDS[control.kind] || control.kind }),
          h('code', { text: commandLine(manifest, control), title: commandLine(manifest, control) }),
          first ? h('span', { class: 'voice-note', title: (control.words || []).map((word) => word.say).join('\n') }, icon('mic'), `“${first.trim()}”${control.words.length > 1 ? ` +${control.words.length - 1}` : ''}`) : h('span', { text: 'No spoken phrases' })
        )
      );
    })
  );
  $('review-save').disabled = manifest.controls.every((control) => review.removed.has(control.id));
  // What runs without a button of its own, and what fills in {aim}: shown, since adding it allows them all.
  const also = [];
  const aims = manifest.aim?.choices.filter((choice) => choice.value) || [];
  if (aims.length) {
    const chips = aims.filter((choice) => choice.chip !== false).map((choice) => choice.label);
    const spoken = aims.filter((choice) => choice.chip === false).map((choice) => choice.label);
    also.push([manifest.aim.label || 'Which', [chips.join(', '), spoken.length ? `by voice also: ${spoken.join(', ')}` : ''].filter(Boolean).join('; ')]);
  }
  if (manifest.status) also.push(['Checks what’s on, whenever Controls opens', commandLine(manifest, { args: manifest.status }), true]);
  if (manifest.serve) also.push(['Stays running while it’s in use, then stops', commandLine(manifest, { args: manifest.serve }), true]);
  for (const control of manifest.controls) if (control.drag?.length) also.push([`While ${control.label} is dragged, each value adds`, control.drag.join(' '), true]);
  $('review-also').replaceChildren(...also.map(([what, value, code]) => h('div', {}, h('span', { text: what }), code ? h('code', { text: value, title: value }) : h('strong', { text: value }))));
  $('review-also').hidden = $('review-also-title').hidden = !also.length;
}

function reviewed() {
  const manifest = review.manifest;
  return {
    ...manifest,
    name: $('review-name').value.trim() || manifest.name,
    icon: review.icon,
    controls: manifest.controls.filter((control) => !review.removed.has(control.id)).map((control) => ({ ...control, label: (review.labels[control.id] ?? control.label).trim() || control.label, askFirst: review.ask[control.id] ?? control.askFirst }))
  };
}

function renderPreview() {
  const manifest = reviewed();
  const view = { id: 'preview', name: manifest.name, icon: manifest.icon, about: manifest.about, problems: [], hasStatus: false, state: null, aim: manifest.aim ? { label: manifest.aim.label, choices: manifest.aim.choices.filter((choice) => choice.chip !== false).map(({ label, value }) => ({ label, value })) } : null, controls: manifest.controls };
  const card = buildCard(view, { preview: true });
  update(card, view);
  card._parts.summary.textContent = manifest.about || '';
  $('review-preview').replaceChildren(card);
}
$('review-name').addEventListener('input', renderPreview);

$('review-save').addEventListener('click', async () => {
  const button = $('review-save');
  button.disabled = true;
  const reply = await send({ op: 'save', folder: review.folder, manifest: reviewed() });
  button.disabled = false;
  if (!reply.ok) return toast(reply.why || 'That couldn’t be saved.', true);
  justAdded = reply.script;
  show('main');
  toast(review.script ? 'Saved.' : `${reviewed().name} added. Jester can run it when you ask, too.`);
});

// ——— Keeping up with Jester ———

let reloading = null;
async function reload() {
  const reply = await send({ op: 'list' });
  if (reply?.ok === false && !reply.blocks) return;
  data = { blocks: reply.blocks || [], scenes: reply.scenes || [] };
  renderBlocks();
}
function reloadSoon() {
  if (reloading) return;
  reloading = setTimeout(() => {
    reloading = null;
    reload();
  }, 60);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'jester/scripts-changed') reloadSoon();
});

reload();
