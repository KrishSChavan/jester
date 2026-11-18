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
 *   snooze, remove, cancel, open, quiet (a ringing timer's Stop); due and span: a running timer's end and length
 */
export function cardView(card, state = {}) {
  if (card?.kind === 'note' || card?.kind === 'remembered') {
    const kept = card.kind === 'remembered';
    return { label: kept ? 'Remembered' : 'Note', title: String(card.title || 'A note'), detail: kept ? '' : String(card.snippet || ''), icon: kept ? 'i-book' : 'i-note', tick: null, tone: '', actions: card.rel ? ['open'] : [] };
  }
  if (card?.kind === 'brief') {
    const status = ['ready', 'offered', 'reading', 'read', 'later', 'dismissed', 'replaced', 'unavailable'].includes(card.status) ? card.status : '';
    const offer = card.offer === true && !['reading', 'read', 'dismissed', 'replaced'].includes(status);
    const detail = { reading: 'Reading…', read: 'Saved briefing', later: 'I’ll ask again in 10 minutes.', dismissed: 'Dismissed', replaced: 'Updated since', unavailable: 'No longer saved' }[status] || '';
    return { label: 'Briefing', title: String(card.title || 'Today'), detail, lines: Array.isArray(card.lines) ? card.lines.map(String) : [],
      ...(Array.isArray(card.items) && card.items.length ? { items: card.items.slice(0, 40) } : {}),
      icon: /evening/i.test(card.title || '') ? 'i-moon' : 'i-sun', tick: null, tone: '',
      actions: card.id && status !== 'unavailable' ? ['brief-read', ...(offer ? ['brief-later', 'brief-dismiss'] : [])] : [] };
  }
  // Work he's offered to do (offers.js): one, as itself; several, a row each, with what's said of how it's going.
  if (card?.kind === 'offers') {
    const rows = offerRows(Array.isArray(card.ids) ? card.ids.map(String) : [], state.offers || new Map());
    if (rows.length === 1) return { label: { doing: 'Doing it', done: 'Done', failed: 'Didn’t work', declined: 'Offered', expired: 'Offered', gone: 'Offered' }[rows[0].status] || 'Want me to?', title: rows[0].title, detail: rows[0].detail, icon: 'i-pulse', tick: null, tone: rows[0].tone, actions: rows[0].actions, offerIds: rows[0].actions.length ? [rows[0].id] : [] };
    const waiting = rows.some((row) => row.actions.length);
    return { label: waiting ? 'Want me to?' : 'Offered', title: `${['', 'One', 'Two', 'Three'][rows.length] || rows.length} things I could do`, detail: '', icon: 'i-pulse', tick: null, tone: '', actions: [], rows };
  }
  // New mail: who and what, and the conversation to open in Gmail when it's just the one.
  if (card?.kind === 'mail') return { label: 'Email', title: String(card.title || 'New mail'), detail: '', lines: Array.isArray(card.lines) ? card.lines.map(String) : [], icon: 'i-mail', tick: null, tone: '', actions: ['mail'] };
  const id = String(card?.id ?? '');
  // A timer that's up and ringing (ring.js): off the list, and still to be turned off. Its card is one way.
  if (state.ringing && state.ringing.id === id) return { label: 'Timer', title: String(state.ringing.label || card?.text || 'Timer'), detail: 'Ringing', icon: 'i-timer', tick: null, tone: 'due', actions: ['quiet'] };
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
    // What's ringing first: it's the one thing here that wants something of them now.
    ...(state.ringing ? [card({ id: state.ringing.id, text: state.ringing.label }, 'timer')] : []),
    ...(state.timers || []).map((task) => card(task, 'timer')),
    ...(state.open || []).filter((task) => timed(task) && (task.told || task.overdue)).map((task) => card(task, 'reminder')),
    ...(state.open || []).filter((task) => timed(task) && !task.told && !task.overdue && task.due - now <= SOON_MS).map((task) => card(task, 'reminder'))
  ];
  return { cards: all.slice(0, SHELF_MOST), more: Math.max(0, all.length - SHELF_MOST) };
}

/**
 * What each offer shows: its title, why it's offered or how it went, and the buttons while it waits on an answer.
 * @param {string[]} ids
 * @param {Map<string, {label:string, why?:string, status:string, result?:string}>} known  offers.js list, by id
 */
export function offerRows(ids, known) {
  return ids.map((id) => {
    const offer = known.get(id);
    if (!offer) return { id, title: 'Something I offered', detail: 'No longer on offer', status: 'gone', tone: 'gone', actions: [] };
    const waiting = ['open', 'asked', 'later'].includes(offer.status);
    const detail = { doing: 'Doing it…', done: offer.result || 'Done', failed: offer.result || 'Couldn’t do it', declined: 'Not doing it', expired: 'No longer on offer', later: offer.why ? `${offer.why} · I’ll ask again later` : 'I’ll ask again later' }[offer.status] || offer.why || '';
    const tone = offer.status === 'done' ? 'done-offer' : ['declined', 'expired', 'failed'].includes(offer.status) ? 'gone' : '';
    return { id, title: String(offer.label || ''), detail, status: String(offer.status || ''), tone, actions: waiting ? ['offer-yes', 'offer-later', 'offer-no'] : [] };
  });
}

const ACTIONS = {
  quiet: { label: 'Stop the ringing', icon: 'i-close', text: 'Stop' },
  cancel: { label: 'Cancel', icon: 'i-close' },
  remove: { label: 'Remove', icon: 'i-trash' },
  snooze: { label: 'Snooze 10 min', icon: 'i-snooze', text: '10 min' },
  open: { label: 'Open in Obsidian', icon: 'i-open', text: 'Open' },
  mail: { label: 'Open in Gmail', icon: 'i-open', text: 'Open' },
  'brief-read': { label: 'Read briefing', icon: 'i-voice', text: 'Read' },
  'brief-later': { label: 'Remind me in 10 minutes', icon: 'i-snooze', text: 'Later' },
  'brief-dismiss': { label: 'Dismiss briefing', icon: 'i-close', text: 'Dismiss' },
  'offer-yes': { label: 'Yes, do it', icon: 'i-tick', text: 'Yes' },
  'offer-later': { label: 'Not now: ask again later', icon: 'i-snooze', text: 'Not now' },
  'offer-no': { label: 'No: don’t offer it again', icon: 'i-close', text: 'No' }
};

// ——— The page's half: one list, kept up to date, and every card drawn from it ———

let state = { ok: false, now: Date.now(), count: 0, timers: [], open: [], done: [] };
/** main.js's clock, less this page's: a timer counts down by the clock that will ring it. */
let skew = 0;
let ticker = null;
const watchers = new Set();
const briefingCards = new Map();
let briefingSnapshotKnown = false;
/** What he's offered to do, by id (offers.js), as main last said. */
const offersKnown = new Map();

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
  if (action === 'mail') return void chrome.runtime.sendMessage({ type: 'jester/mail', op: 'open', id: card.id || '' }).catch(() => null);
  const op = { done: { op: 'done', on: true }, undo: { op: 'done', on: false }, remove: { op: 'remove' }, cancel: { op: 'remove' }, snooze: { op: 'snooze', minutes: 10 }, quiet: { op: 'quiet' } }[action];
  if (op) took(await ask({ ...op, id: card.id }));
  return undefined;
}

/** What he's offered, as it stands now: every card that shows one is drawn again. */
export function tookOffers(list) {
  if (!Array.isArray(list)) return;
  for (const offer of list) if (offer?.id) offersKnown.set(String(offer.id), offer);
  for (const el of document.querySelectorAll('.card')) if (el.card?.kind === 'offers' || el.card?.offerIds?.length) fill(el);
}

/** Their click on an offer's Yes, Not now or No: main does it, and says how it went. */
async function offerAction(el, op, ids) {
  if (el.offerPending) return;
  el.offerPending = true;
  el.offerError = '';
  fill(el);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'jester/offers', op, ids });
    if (Array.isArray(result?.offers)) tookOffers(result.offers);
    if (!result?.ok) el.offerError = String(result?.error || 'That didn’t go through. Try again.');
  } catch {
    el.offerError = 'That didn’t go through. Try again.';
  } finally {
    el.offerPending = false;
    fill(el);
  }
}

/** An offer's three buttons. */
function offerButtons(el, row) {
  return row.actions.filter((name) => ACTIONS[name]).map((action) => {
    const { label: name, icon: glyph, text } = ACTIONS[action];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `act worded${action === 'offer-yes' ? ' yes' : ''}`;
    button.title = name;
    button.setAttribute('aria-label', `${name}: ${row.title}`);
    button.disabled = !!el.offerPending;
    button.append(icon(glyph), text);
    button.addEventListener('click', () => offerAction(el, action.slice('offer-'.length), [row.id]));
    return button;
  });
}

/** Offers under a card (new mail's reply to draft), or the rows of several: a line each, with its buttons. */
function offerList(el, rows) {
  if (!rows.length) return null;
  const list = document.createElement('ul');
  list.className = 'offer-rows';
  for (const row of rows) {
    const item = document.createElement('li');
    if (row.tone) item.className = row.tone;
    const words = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = row.title;
    words.append(title);
    if (row.detail) {
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = row.detail;
      words.append(detail);
    }
    item.append(words);
    const buttons = offerButtons(el, row);
    if (buttons.length) {
      const acts = document.createElement('div');
      acts.className = 'acts';
      acts.append(...buttons);
      item.append(acts);
    }
    list.append(item);
  }
  return list;
}

/** Voice answers and card buttons share the same stored briefing. Refresh all
 * copies, including a card in an older chat, from the authoritative state. */
export function refreshBriefingCards(cards = [], { replace = false } = {}) {
  const updated = new Map(cards.filter((card) => card?.kind === 'brief' && card.id).map((card) => [String(card.id), card]));
  if (replace) {
    briefingCards.clear();
    briefingSnapshotKnown = true;
  }
  for (const [id, card] of updated) briefingCards.set(id, card);
  for (const el of document.querySelectorAll('.card')) {
    if (el.card?.kind !== 'brief' || (!replace && !updated.has(String(el.card.id)))) continue;
    const next = currentBriefingCard(el.card);
    if (JSON.stringify(el.card) === JSON.stringify(next)) continue;
    el.card = next;
    fill(el);
  }
}

function currentBriefingCard(card) {
  if (card?.kind !== 'brief' || !card.id) return card;
  return briefingCards.get(String(card.id)) || (briefingSnapshotKnown
    ? { ...card, offer: false, status: 'unavailable' } : card);
}

function responseCard(result, previous) {
  if (result?.card?.kind === 'brief') return result.card;
  const record = result?.record;
  if (!record || String(record.id) !== String(previous.id)) return null;
  return { ...previous, ...record.card, kind: 'brief', id: record.id, title: record.title || previous.title,
    lines: record.lines || record.card?.lines || previous.lines, items: record.items || record.card?.items || previous.items,
    status: record.status, offer: record.status === 'offered' };
}

async function briefingAction(el, op, itemId = '') {
  if (el.briefingPending) return;
  el.briefingPending = true;
  fill(el);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'jester/briefings', op, id: el.card.id, ...(itemId ? { itemId } : {}) });
    if (result?.ok) {
      const card = responseCard(result, el.card);
      if (card) {
        el.card = card;
        refreshBriefingCards([card]);
      }
      if (result.navigate) document.dispatchEvent(new CustomEvent('jester/briefing-navigate', { detail: result.navigate }));
      if (result.view) showBriefingView(result.view);
      el.briefingError = '';
    } else el.briefingError = String(result?.error || 'That action could not finish. Please try again.');
  } catch { el.briefingError = 'That action could not finish. Please try again.'; }
  finally { el.briefingPending = false; fill(el); }
}

/** Calendar feeds often have no original event page. Keep those event details
 * in Jester instead of opening a subscription address or guessing a provider. */
export function showBriefingView(view, document = globalThis.document) {
  if (view?.kind !== 'calendar' || !Array.isArray(view.items)) return null;
  const priorFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'briefing-dialog';
  dialog.setAttribute('aria-label', String(view.title || 'Calendar'));
  const heading = document.createElement('h2');
  heading.textContent = String(view.title || 'Calendar');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'briefing-dialog-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close calendar');
  const finish = () => { dialog.remove(); priorFocus?.focus?.(); };
  close.addEventListener('click', () => typeof dialog.close === 'function' ? dialog.close() : finish());
  dialog.addEventListener('close', finish);
  const list = document.createElement('ul');
  list.className = 'briefing-items';
  for (const item of view.items.slice(0, 100)) {
    if (!item || typeof item.title !== 'string') continue;
    const row = document.createElement('li');
    const words = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title;
    words.append(title);
    if (item.detail) {
      const detail = document.createElement('p');
      detail.textContent = String(item.detail);
      words.append(detail);
    }
    if (item.source) {
      const source = document.createElement('span');
      source.className = 'briefing-item-source';
      source.textContent = String(item.source);
      words.append(source);
    }
    row.append(words); list.append(row);
  }
  dialog.append(heading, close, list);
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  close.focus?.();
  return dialog;
}

function briefingDetails(el, view) {
  if (el.card.kind !== 'brief' || !view.items?.length) return null;
  const details = document.createElement('details');
  details.className = 'briefing-details';
  details.open = el.briefDetails?.open === true;
  el.briefDetails = details;
  const summary = document.createElement('summary');
  summary.textContent = 'See more';
  summary.setAttribute('aria-label', `See more: ${view.title}`);
  details.append(summary);
  if (view.lines?.length) {
    const facts = document.createElement('ul');
    facts.className = 'facts';
    for (const line of view.lines) {
      const fact = document.createElement('li');
      fact.textContent = line;
      facts.append(fact);
    }
    details.append(facts);
  }
  const list = document.createElement('ul');
  list.className = 'briefing-items';
  for (const item of view.items) {
    if (!item || typeof item.title !== 'string' || !['event', 'task', 'mail', 'page', 'activity'].includes(item.kind)) continue;
    const row = document.createElement('li');
    const words = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = item.title;
    words.append(heading);
    if (item.detail) {
      const detail = document.createElement('p');
      detail.textContent = String(item.detail);
      words.append(detail);
    }
    if (item.source) {
      const source = document.createElement('span');
      source.className = 'briefing-item-source';
      source.textContent = String(item.source);
      words.append(source);
    }
    row.append(words);
    if (el.card.status !== 'unavailable' && item.id && ['event', 'task', 'mail', 'page'].includes(item.kind) && (item.kind !== 'page' || item.url)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'act worded';
      open.textContent = 'Open';
      open.disabled = !!el.briefingPending;
      open.setAttribute('aria-label', `Open ${item.title}`);
      open.addEventListener('click', () => briefingAction(el, 'open', item.id));
      row.append(open);
    }
    list.append(row);
  }
  details.append(list);
  return details;
}

function fill(el) {
  const card = el.card;
  let view = cardView(card, { ...state, offers: offersKnown });
  // His line can reach the page before the list that holds what it made: until the list's been asked again, a card
  // that isn't in it is shown as what it's of, and not as finished.
  if (view.gone && !el.settled) view = { ...view, detail: '', tone: '', gone: false };
  const offered = view.rows || (card.offerIds?.length ? offerRows(card.offerIds.map(String), offersKnown) : null);
  el.className = `card${card.kind === 'brief' ? ' briefing-card' : ''}${offered || card.kind === 'offers' ? ' offer-card' : ''}${el.dataset.compact ? ' compact' : ''}${view.tone ? ` ${view.tone}` : ''}${view.due ? ' timer' : ''}`;
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
  if (view.lines?.length && !(card.kind === 'brief' && view.items?.length)) {
    const list = document.createElement('ul');
    list.className = 'facts';
    for (const line of view.lines) {
      const item = document.createElement('li');
      item.textContent = line;
      list.append(item);
    }
    words.append(list);
  }
  const details = briefingDetails(el, view);
  if (details) words.append(details);
  const rows = offered ? offerList(el, offered) : null;
  if (rows) words.append(rows);
  if (el.offerError) {
    const error = document.createElement('span');
    error.className = 'briefing-error';
    error.setAttribute('role', 'status');
    error.textContent = el.offerError;
    words.append(error);
  }
  if (el.briefingError) {
    const error = document.createElement('span');
    error.className = 'briefing-error';
    error.setAttribute('role', 'status');
    error.textContent = el.briefingError;
    words.append(error);
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
    if (action.startsWith('brief-')) {
      button.disabled = !!el.briefingPending || card.status === 'reading';
      button.addEventListener('click', () => briefingAction(el, action.slice('brief-'.length)));
    } else if (action.startsWith('offer-')) {
      if (action === 'offer-yes') button.classList.add('yes');
      button.disabled = !!el.offerPending;
      button.addEventListener('click', () => offerAction(el, action.slice('offer-'.length), view.offerIds || []));
    } else button.addEventListener('click', () => act(action, card));
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
  el.card = currentBriefingCard(card);
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
