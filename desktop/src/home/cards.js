/**
 * Cards: a timer, a reminder, a task or a note as a thing to look at and act
 * on, wherever it turns up in his window. With the line he said it in, in the
 * chat ("10 minutes, starting now." has its timer under it, counting down);
 * on the shelf over the orb, while it's in play; and in the Tasks screen.
 *
 * A card is a view of what's kept in main.js (tasks.js), not a copy: every
 * card of one task shows the same thing, and changes when it does. Ticking a
 * box, snoozing a reminder, cancelling a timer or opening a note here is the
 * user's own click, which is the only way but their saying so that a task is
 * ever ticked.
 *
 * What a card shows is worked out apart from the page (cardView, shelfOf), so
 * it can be tested without one.
 */

/** "3:20", "1:05:09": what's left of a timer. */
export function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
/** A reminder's time is soon, for the shelf, within this long. */
export const SOON_MS = 3 * 3600_000;
const SHELF_MOST = 4;

/**
 * What a card shows, from what it's of and the list as it stands.
 * @param {{kind:string, id?:string, type?:string, text?:string, title?:string, rel?:string, snippet?:string}} card
 * @param {{timers?:object[], open?:object[], done?:object[]}} state  the list (main.js `jester/tasks`)
 * @returns {{label:string, title:string, detail:string, icon:string, tick:null|boolean, tone:string, actions:string[], due?:number, span?:number, gone?:boolean}}
 *   tick: null for no box, else whether it's ticked; tone: '' | 'due' | 'done' | 'gone'; actions: of done, undo,
 *   snooze, remove, cancel, open; due and span: a running timer's end and length
 */
export function cardView(card, state = {}) {
  if (card?.kind === 'note' || card?.kind === 'remembered') {
    const kept = card.kind === 'remembered';
    return { label: kept ? 'Remembered' : 'Note', title: String(card.title || 'A note'), detail: kept ? '' : String(card.snippet || ''), icon: kept ? 'i-book' : 'i-note', tick: null, tone: '', actions: card.rel ? ['open'] : [] };
  }
  // A brief's card is its facts, a line each: nothing to do to it.
  if (card?.kind === 'brief') return { label: 'Brief', title: String(card.title || 'Today'), detail: '', lines: Array.isArray(card.lines) ? card.lines.map(String) : [], icon: /evening/i.test(card.title || '') ? 'i-moon' : 'i-sun', tick: null, tone: '', actions: [] };
  const id = String(card?.id ?? '');
  const timer = (state.timers || []).find((task) => task.id === id);
  if (timer) return { label: 'Timer', title: timer.text, detail: '', icon: 'i-timer', tick: null, tone: '', actions: ['cancel'], due: timer.due, span: timer.timer };
  const open = (state.open || []).find((task) => task.id === id);
  if (open) {
    const reminder = Number.isFinite(open.due) && !open.allDay;
    const late = !!open.told || !!open.overdue;
    const detail = [capital(open.when || ''), open.told ? 'reminded' : open.overdue ? 'overdue' : ''].filter(Boolean).join(' · ');
    return { label: reminder ? 'Reminder' : 'To do', title: open.text, detail, icon: reminder ? 'i-bell' : 'i-tasks', tick: false, tone: late ? 'due' : '', actions: ['done', ...(reminder && late ? ['snooze'] : []), 'remove'] };
  }
  const done = (state.done || []).find((task) => task.id === id);
  if (done) return { label: 'Done', title: done.text, detail: '', icon: 'i-tasks', tick: true, tone: 'done', actions: ['undo'] };
  // Gone from the list: a timer that's rung or been cancelled, a task removed. The card says what it was.
  const wasTimer = card?.type === 'timer';
  return { label: wasTimer ? 'Timer' : card?.type === 'reminder' ? 'Reminder' : 'To do', title: String(card?.text || ''), detail: wasTimer ? 'Finished' : 'No longer on your list', icon: wasTimer ? 'i-timer' : 'i-tasks', tick: null, tone: 'gone', actions: [], gone: true };
}

/**
 * What's in play, for the shelf over the orb: timers running, reminders given and not yet ticked, and reminders due
 * within the next few hours.
 * @returns {{cards:{kind:'task', id:string, type:string, text:string}[], more:number}}  more: how many didn't fit
 */
export function shelfOf(state = {}, now = Date.now()) {
  const card = (task, type) => ({ kind: 'task', id: task.id, type, text: task.text });
  const timed = (task) => Number.isFinite(task.due) && !task.allDay;
  const all = [
    ...(state.timers || []).map((task) => card(task, 'timer')),
    ...(state.open || []).filter((task) => timed(task) && (task.told || task.overdue)).map((task) => card(task, 'reminder')),
    ...(state.open || []).filter((task) => timed(task) && !task.told && !task.overdue && task.due - now <= SOON_MS).map((task) => card(task, 'reminder'))
  ];
  return { cards: all.slice(0, SHELF_MOST), more: Math.max(0, all.length - SHELF_MOST) };
}

const ACTIONS = {
  cancel: { label: 'Cancel', icon: 'i-close' },
  remove: { label: 'Remove', icon: 'i-trash' },
  snooze: { label: 'Snooze 10 min', icon: 'i-snooze', text: '10 min' },
  open: { label: 'Open in Obsidian', icon: 'i-open', text: 'Open' }
};

// ——— The page's half: one list, kept up to date, and every card drawn from it ———

let state = { ok: false, now: Date.now(), count: 0, timers: [], open: [], done: [] };
/** main.js's clock, less this page's: a timer counts down by the clock that will ring it. */
let skew = 0;
let ticker = null;
const watchers = new Set();

const ask = (message) => chrome.runtime.sendMessage({ type: 'jester/tasks', ...message }).catch(() => null);

const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon-svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
};

function tick() {
  const now = Date.now() + skew;
  for (const count of document.querySelectorAll('.card .count')) {
    const left = Number(count.dataset.due) - now;
    count.textContent = left > 0 ? `${countdown(left)} left` : 'Time’s up';
    const bar = count.closest('.card')?.querySelector('.bar > b');
    const span = Number(count.dataset.span);
    if (bar && span > 0) bar.style.width = `${Math.max(0, Math.min(100, (left / span) * 100))}%`;
  }
}

function took(list) {
  if (!list?.ok) return;
  state = list;
  skew = list.now - Date.now();
  for (const el of document.querySelectorAll('.card')) {
    if (!el.card) continue;
    // The list has been asked since this card was made: what it doesn't hold is gone, not merely not here yet.
    el.settled = true;
    fill(el);
  }
  for (const watcher of watchers) watcher(state);
  counting();
}

/** Counting down only while there's something on the page to count. */
function counting() {
  const running = !!document.querySelector('.card .count');
  if (running && !ticker) ticker = setInterval(tick, 500);
  else if (!running && ticker) ticker = void clearInterval(ticker);
  tick();
}

async function act(action, card) {
  if (action === 'open') return void chrome.runtime.sendMessage({ type: 'jester/notes', op: 'open', rel: card.rel }).catch(() => null);
  const op = { done: { op: 'done', on: true }, undo: { op: 'done', on: false }, remove: { op: 'remove' }, cancel: { op: 'remove' }, snooze: { op: 'snooze', minutes: 10 } }[action];
  if (op) took(await ask({ ...op, id: card.id }));
  return undefined;
}

function fill(el) {
  const card = el.card;
  let view = cardView(card, state);
  // His line can reach the page before the list that holds what it made: until the list's been asked again, a card
  // that isn't in it is shown as what it's of, and not as finished.
  if (view.gone && !el.settled) view = { ...view, detail: '', tone: '', gone: false };
  el.className = `card${el.dataset.compact ? ' compact' : ''}${view.tone ? ` ${view.tone}` : ''}${view.due ? ' timer' : ''}`;
  const parts = [];
  if (view.tick === null) {
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.append(icon(view.icon));
    parts.push(glyph);
  } else {
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'tick';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(view.tick));
    box.setAttribute('aria-label', view.tick ? `Put back: ${view.title}` : `Done: ${view.title}`);
    box.title = view.tick ? 'Put it back on the list' : 'Tick it off';
    box.append(icon('i-tick'));
    box.addEventListener('click', () => act(view.tick ? 'undo' : 'done', card));
    parts.push(box);
  }
  const words = document.createElement('div');
  words.className = 'words';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = view.label;
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = view.title;
  words.append(label, title);
  if (view.due) {
    const count = document.createElement('span');
    count.className = 'detail count';
    count.dataset.due = String(view.due);
    count.dataset.span = String(view.span || 0);
    const bar = document.createElement('i');
    bar.className = 'bar';
    bar.append(document.createElement('b'));
    words.append(count, bar);
  } else if (view.detail) {
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = view.detail;
    words.append(detail);
  }
  if (view.lines?.length) {
    const list = document.createElement('ul');
    list.className = 'facts';
    for (const line of view.lines) {
      const item = document.createElement('li');
      item.textContent = line;
      list.append(item);
    }
    words.append(list);
  }
  parts.push(words);
  const acts = document.createElement('div');
  acts.className = 'acts';
  for (const action of view.actions.filter((name) => ACTIONS[name])) {
    const { label: name, icon: glyph, text } = ACTIONS[action];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `act${text ? ' worded' : ''}${action === 'remove' || action === 'cancel' ? ' danger' : ''}`;
    button.title = name;
    button.setAttribute('aria-label', `${name}: ${view.title}`);
    button.append(icon(glyph));
    if (text) button.append(text);
    button.addEventListener('click', () => act(action, card));
    acts.append(button);
  }
  if (acts.childElementCount) parts.push(acts);
  el.replaceChildren(...parts);
}

/**
 * A card's element, drawn from the list as it stands and again whenever it changes.
 * @param {object} card  what it's of: {kind:'task', id, type, text}, or {kind:'note'|'remembered', title, rel, snippet}
 * @param {{compact?:boolean}} [options]  compact: one line, for the shelf
 */
export function cardElement(card, { compact = false } = {}) {
  const el = document.createElement('div');
  el.card = card;
  if (compact) el.dataset.compact = '1';
  fill(el);
  // Once it's on the page: a timer on it starts the count. One the list doesn't hold yet asks for the list.
  queueMicrotask(counting);
  if (card?.kind === 'task' && cardView(card, state).gone) settle();
  return el;
}

/** The list asked for once, for however many cards were made before it arrived. */
let settling = null;
function settle() {
  settling ||= refreshCards().finally(() => (settling = null));
}

/** The list as it stands, asked afresh: at the start, and whenever main.js says it changed. */
export async function refreshCards() {
  took(await ask({ op: 'list' }));
  return state;
}

/** Told the list each time it changes: the shelf, the Tasks screen, the count on its button. */
export function watchCards(watcher) {
  watchers.add(watcher);
  if (state.ok) watcher(state);
}

/** An action taken somewhere else in the page (the Tasks screen's box to add one): its answer is the new list. */
export const tookCards = took;
