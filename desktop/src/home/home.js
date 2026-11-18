/**
 * Jester's one window. Its middle screen is him: the orb shows what he's doing,
 * from the same frames as the pill, so the two never disagree, and the chat
 * going on scrolls under it, from his conversation log (main.js sends it as it
 * changes). Type to him there, or let him listen. Chats, to the left, are the
 * conversations that are over, for a week, to read again or carry on; Settings,
 * to the right, is everything else. Each slides in from its button's side.
 */

import { ENGINE, MSG } from '../ext/src/common/constants.js';
import { chatElements, createChats, dividerElement, lineElement } from './chats.js';
import { createOrb, ORB_STATES } from './orb.js';
import { createScreens } from './screens.js';
import { createTasksPanel } from './tasks.js';
import { cardElement, refreshBriefingCards, refreshCards, shelfOf, watchCards } from './cards.js';
import { onRender, save, showing, startSettings, state } from './settings.js';
import { renderResearchState } from './research.js';

const $ = (id) => document.getElementById(id);
document.documentElement.dataset.platform = /^Win/i.test(navigator.platform) ? 'win' : 'mac';

/** He ends his own thinking; this only catches a task that died. */
const THINKING_MS = 90000;
/** How long the light says it was your voice. */
const MATCHED_MS = 2500;
/** Typing says so this often at most: his model, loading meanwhile, stays loaded a while (conversation.js). */
const TYPING_MS = 30000;
/** How long a word under the orb stays: the answer to a spoken command, or that a chat's in Chats now. */
const NOTE_MS = 6000;
/** The orb's size when the window has room for it. */
const ORB_PX = 220;
/** A dot of light, the orb spreading out of it, then everything else. */
const INTRO_MS = 1800;
/** main.js says when the window's on screen (jester/home-shown); should it never, the intro plays after this. */
const INTRO_WAIT_MS = 1500;
/**
 * The library's designs are tuned at 64 px; this big, they want about twice
 * the dots, and working's a little larger. Picked by eye from renders.
 */
const ORB_TUNE = {
  breathing: { dots: 2 },
  listening: { dots: 1.7 },
  working: { dots: 2, dotSize: 1.2 },
  composing: { dots: 2, dotSize: 1.08 }
};

let moodTimer = null;
let matchedTimer = null;
let matched = false;
let typedAt = -Infinity;
/** The chat going on, as drawn: its id and how many of its lines. */
let chat = { id: '', lines: [] };
let drawnId = '';
let drawnCount = 0;
/** What's being said, before it's done (push to talk). */
let heardNow = '';
/** A word under the orb for a while. */
let note = '';
let noteTimer = null;
let introTimer = null;
let research = null;

function drawResearch(next) {
  research = next || null;
  renderResearchState($('research-progress'), research);
  document.body.classList.toggle('researching', research?.active === true);
  if (research?.active) mood('thinking', THINKING_MS);
  else drawPending();
}

// ——— The orb ———

const orbSize = () => Math.max(120, Math.min(ORB_PX, Math.floor(innerHeight * 0.3)));
const orb = createOrb($('orb'), {
  size: orbSize(),
  color: getComputedStyle(document.documentElement).getPropertyValue('--orb'),
  tune: ORB_TUNE
});

function mood(next, ms = 0) {
  clearTimeout(moodTimer);
  document.body.dataset.state = next;
  orb.show(ORB_STATES[next]);
  if (ms) moodTimer = setTimeout(() => mood('resting'), ms);
  drawPending();
}

/**
 * The window opens on a dot of light that the orb spreads out of; what's around the orb comes in after. It plays
 * once the window's on screen: `now`, it's being shown already.
 */
function intro({ now = false } = {}) {
  document.body.classList.add('opening');
  orb.intro({ ms: INTRO_MS, onReveal: () => document.body.classList.remove('opening') });
  clearTimeout(introTimer);
  if (now) orb.play();
  else introTimer = setTimeout(() => orb.play(), INTRO_WAIT_MS);
}

// ——— The chat going on ———

const nearEnd = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 80;

/** He's thinking about what you said: three dots where his words will go. */
function drawPending() {
  const lines = $('live-lines');
  const waiting = !research?.active && document.body.dataset.state === 'thinking' && chat.lines.at(-1)?.who === 'you';
  const pending = lines.querySelector('.pending');
  if (waiting && !pending) {
    const dots = document.createElement('li');
    dots.className = 'line jester pending';
    dots.setAttribute('aria-label', 'Jester is thinking');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    lines.append(dots);
    // Right after what the user said, which they've just seen: however long that was, the dots are in view.
    $('live').scrollTo({ top: $('live').scrollHeight, behavior: 'smooth' });
  } else if (!waiting && pending) pending.remove();
}

/** What's being said, before it's done: a bubble of its own at the end. */
function drawNow() {
  const lines = $('live-lines');
  let now = lines.querySelector('.now');
  if (!heardNow || !chat.lines.length) {
    now?.remove();
    drawHint();
    return;
  }
  if (!now) {
    now = lineElement({ who: 'you', text: '' });
    now.classList.add('now');
    lines.append(now);
  }
  now.textContent = heardNow;
  $('live').scrollTop = $('live').scrollHeight;
}

/**
 * The chat going on, from main: lines are only ever added to one, so those new are added to what's drawn; another
 * chat (one over, a new one, one picked up) is drawn afresh.
 */
function drawChat(next, { forgotten = false } = {}) {
  const was = chat.lines.length;
  const lines = Array.isArray(next?.lines) ? next.lines : [];
  // A chat with something the user said is kept in Chats when it's over; one of only his lines isn't. Not counting
  // what a new subject carried into the next chat: the line that opened it.
  const carried = new Set(lines.map((line) => `${line.at}|${line.who}|${line.text}`));
  const kept = chat.lines.some((line) => line.who === 'you' && String(line.text ?? '').trim() && !carried.has(`${line.at}|${line.who}|${line.text}`));
  chat = { id: String(next?.id || ''), lines };
  const box = $('live');
  const end = nearEnd(box);
  if (chat.id !== drawnId || chat.lines.length < drawnCount) {
    // A new subject: what was going on is over, with this the next chat's first line. Not a chat picked up.
    const split = was && kept && !forgotten && chat.lines.length && !chat.lines[0].earlier;
    $('live-lines').classList.add('static');
    $('live-lines').replaceChildren(...(split ? [dividerElement('The chat before is in Chats now')] : []), ...chatElements(chat.lines));
    requestAnimationFrame(() => $('live-lines').classList.remove('static'));
    box.scrollTop = box.scrollHeight;
  } else {
    const fresh = chat.lines.slice(drawnCount);
    const lines = $('live-lines');
    lines.querySelector('.pending')?.remove();
    lines.querySelector('.now')?.remove();
    fresh.forEach((line, index) => {
      if (chat.lines[drawnCount + index - 1]?.earlier && !line.earlier) lines.append(dividerElement('Picked up'));
      lines.append(lineElement(line));
    });
    if (end || fresh.some((line) => line.who === 'you')) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }
  drawnId = chat.id;
  drawnCount = chat.lines.length;
  if (chat.lines.length) heardNow = '';
  // A chat that's just ended is in Chats now: the orb settles back, and says so. Forgotten, or never kept, it isn't.
  if (was && kept && !chat.lines.length && !forgotten) say('That chat is in Chats now.');
  document.body.classList.toggle('chatting', chat.lines.length > 0);
  drawPending();
  drawHint();
}

// ——— What he's listening for, and the words under the orb ———

/** A word at the end of the chat going on, for a moment: what a command said aloud did. */
function flash(text) {
  const note = dividerElement(text);
  note.classList.add('note');
  $('live-lines').append(note);
  $('live').scrollTo({ top: $('live').scrollHeight, behavior: 'smooth' });
  setTimeout(() => note.remove(), NOTE_MS);
}

function say(text) {
  note = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = '';
    drawHint();
  }, NOTE_MS);
  drawHint();
}

/** Under the orb with no chat going: what's being said, or a word from him, or how to start. */
function drawHint() {
  const { settings, desktop } = state();
  const { listening, problem, wanted } = desktop?.continuous || {};
  const asleep = settings?.enabled && desktop?.engine?.state === ENGINE.SLEEPING;
  $('hint').textContent =
    heardNow && !chat.lines.length
      ? heardNow
      : note ||
        (!settings
          ? ''
          : !settings.enabled
            ? 'Jester is off. You can still type to him.'
            : asleep
              ? 'Asleep. Wake him to talk, or type to him.'
              : listening
                ? 'Say “Jester”, or type to him.'
                : wanted && problem
                  ? problem
                  : 'Not listening. Type to him, or start listening.');
}

/** The light at the top: whose voice he's listening for, or why he isn't. A click opens where that's set. */
function drawLight() {
  const { settings, desktop } = state();
  if (!settings) return;
  const { listening, knowsYou, problem, wanted } = desktop?.continuous || {};
  const asleep = settings.enabled && desktop?.engine?.state === ENGINE.SLEEPING;
  const [text, tone, go] = !settings.enabled
    ? ['Jester is off', '', 'settings/general']
    : asleep
      ? ['Asleep', '', 'settings/general']
      : matched
        ? ['Your voice', 'on', 'settings/assistant']
        : listening
          ? [knowsYou ? 'Listening for you' : 'Listening for anyone', 'on', 'settings/assistant']
          : wanted && problem
            ? ['Can’t listen', 'warn', 'settings/assistant']
            : ['Not listening', '', 'settings/assistant'];
  $('light-text').textContent = text;
  $('light').dataset.tone = tone;
  $('light').dataset.go = go;
  $('light').title = wanted && problem && !listening ? problem : `${text}: its settings`;
}

/** Gestures, Sleep and listening, along the bottom. */
function drawControls() {
  const { settings, desktop } = state();
  if (!settings) return;
  const on = !!settings.enabled;
  const engine = desktop?.engine?.state;

  const gestures = on && settings.gesturesEnabled !== false;
  const hand = $('gestures');
  hand.disabled = !on;
  // The name stays; whether it's on is aria-pressed's to say.
  hand.setAttribute('aria-pressed', String(gestures));
  hand.querySelector('use').setAttribute('href', gestures ? '#i-hand' : '#i-hand-off');
  hand.title = !on ? 'Gestures: Jester is off' : gestures ? 'Gestures on: click to close the camera' : 'Gestures off: click to watch for them';

  const asleep = on && engine === ENGINE.SLEEPING;
  const canSleep = on && (engine === ENGINE.RUNNING || asleep);
  const moon = $('sleep');
  moon.disabled = !canSleep;
  moon.querySelector('use').setAttribute('href', asleep ? '#i-sun' : '#i-moon');
  moon.setAttribute('aria-label', asleep ? 'Wake Jester' : 'Put Jester to sleep');
  moon.title = asleep ? 'Wake Jester' : canSleep ? 'Sleep: camera and mic off until you wake him' : 'Sleep: needs Jester on and watching for gestures';

  const wanted = !!desktop?.continuous?.wanted;
  const mic = $('listen');
  mic.disabled = desktop?.voice === 'missing';
  mic.setAttribute('aria-pressed', String(wanted));
  mic.querySelector('use').setAttribute('href', wanted ? '#i-mic' : '#i-mic-off');
  mic.title = mic.disabled ? 'Listening needs the speech model: Settings › Controls' : wanted ? 'Stop listening' : 'Start listening for his name';
}

/** What's needed and not there yet (main.js `jester/setup`): as last told. */
let setup = null;

/**
 * What's still needed before he's any use, over the orb, a click from Getting started: a permission macOS hasn't
 * given says which; anything else, how many things are left.
 */
function drawBanner() {
  // As main.js counts them (permission-list.js): not the camera with gestures off, and the microphone with voice on.
  const desktop = state().desktop;
  const missing = (desktop?.permissions || []).filter((item) => (desktop?.missing || []).includes(item.id));
  const left = setup?.left || 0;
  $('banner').hidden = !missing.length && !left;
  if (missing.length && left <= 1) $('banner-text').textContent = `Jester needs ${missing.map((item) => item.label).join(' and ')} to work.`;
  else if (left) $('banner-text').textContent = `${left} thing${left === 1 ? '' : 's'} left to set up before Jester’s ready.`;
}

/** Getting started: each thing to set up, whether it's done, and the way to where it's done. */
function drawSetup() {
  if (!setup?.steps) return;
  const listening = setup.steps.find((step) => step.id === 'listening')?.done;
  $('setup-words').textContent = !setup.ready
    ? `${setup.left} thing${setup.left === 1 ? '' : 's'} left before he’s ready.`
    : !listening
      ? 'He’s ready, and not listening yet: turn on listening for his name below, or type to him.'
      : setup.more
        ? 'He’s ready: say “Jester”, then what you want. The rest is yours to add when you want it.'
        : 'Everything’s set up.';
  const row = (step) => {
    const item = document.createElement('div');
    item.className = `setup-step${step.done ? ' done' : ''}${step.required ? ' needed' : ''}`;
    const mark = document.createElement('span');
    mark.className = 'mark';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon-svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-tick');
    svg.append(use);
    mark.append(svg);
    const words = document.createElement('div');
    words.className = 'words';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = step.title;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = step.why;
    words.append(title, why);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.go = step.go;
    button.textContent = step.done ? 'Change' : 'Set up';
    button.setAttribute('aria-label', `${step.done ? 'Change' : 'Set up'}: ${step.title}`);
    item.append(mark, words, button);
    return item;
  };
  const heading = (text) => {
    const h2 = document.createElement('h2');
    h2.textContent = text;
    return h2;
  };
  const needed = setup.steps.filter((step) => step.required);
  const optional = setup.steps.filter((step) => !step.required);
  $('setup-list').replaceChildren(heading('Needed'), ...needed.map(row), heading('When you want them'), ...optional.map(row));
}

/** Asked again whenever something about the computer changes: a permission given, a model saved, a vault chosen. */
let setupAsked = null;
function askSetup() {
  clearTimeout(setupAsked);
  setupAsked = setTimeout(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'jester/setup' }).catch(() => null);
    if (!reply?.ok) return;
    setup = reply;
    drawBanner();
    drawSetup();
    const aside = $('sum-setup');
    aside.textContent = reply.ready ? (reply.more ? `${reply.more} to add` : 'All set') : `${reply.left} left`;
    if (reply.ready) delete aside.dataset.tone;
    else aside.dataset.tone = 'warn';
  }, 150);
}

function drawMain() {
  // Whatever changed may have been something he was waiting on to be set up.
  askSetup();
  drawLight();
  drawControls();
  drawBanner();
  drawHint();
}

/** Who was heard: the light says so, for a moment. */
function heard(voice) {
  heardNow = '';
  drawNow();
  if (!voice.matched) return;
  matched = true;
  drawLight();
  clearTimeout(matchedTimer);
  matchedTimer = setTimeout(() => {
    matched = false;
    drawLight();
  }, MATCHED_MS);
}

function drawVoice(voice) {
  if (voice.phase === 'heard') {
    heard(voice);
    mood('thinking', THINKING_MS);
  } else if (voice.phase === 'thinking') mood(voice.done ? 'resting' : 'thinking', voice.done ? 0 : THINKING_MS);
  else if (voice.phase === 'speaking') mood(voice.done ? 'resting' : 'speaking');
  else if (voice.phase === 'answer') {
    // What was being said is done with. A reply written to what was typed is in the chat already; a command said
    // aloud outside the conversation (`command`) isn't: under the orb, or at the end of a chat going on, for a moment.
    heardNow = '';
    drawNow();
    if (voice.command && voice.text) (chat.lines.length ? flash : say)(String(voice.text));
    mood('resting');
  } else if (voice.transcript?.text) {
    heardNow = String(voice.transcript.text);
    drawNow();
    mood('listening', voice.hold);
  } else if (voice.active === false) {
    heardNow = '';
    drawNow();
    mood('resting');
  } else if (voice.active) mood('listening', voice.hold);
}

// ——— Screens ———

// Picked up, the chat's under the orb, and the box to type in has the focus (screens.js data-autofocus).
const chats = createChats({ go: (screen) => screens.go(screen), onPickedUp: () => screens.go('main') });

// The to-do list, reminders and timers, to the left of the orb beside Chats.
const tasksPanel = createTasksPanel();

let briefingShelfKey = '';
/** Today, as the briefings' `day` is written (briefing-manager.js dayOf). */
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
function drawBriefings(cards = []) {
  refreshBriefingCards(cards, { replace: true });
  // Today's, waiting to be read: yesterday's offer left unanswered isn't news any more.
  const waiting = cards.filter((card) => ['offered', 'later', 'ready'].includes(card.status) && card.day === today()).slice(0, 3);
  const key = JSON.stringify(waiting);
  if (key === briefingShelfKey) return;
  briefingShelfKey = key;
  $('briefing-shelf').hidden = waiting.length === 0;
  $('briefing-shelf').replaceChildren(...waiting.map((card) => cardElement(card)));
}

// The shelf over the orb: what's in play right now, as cards. Timers running, reminders given and not ticked, and
// those coming up in the next few hours. Drawn again only when what's on it changes: a card keeps itself current.
let shelved = '';
watchCards((list) => {
  const { cards, more } = shelfOf(list, list.now);
  const key = `${cards.map((card) => card.id).join(',')}+${more}`;
  $('shelf').hidden = cards.length === 0;
  if (key === shelved) return;
  shelved = key;
  const parts = cards.map((card) => cardElement(card, { compact: true }));
  if (more) {
    const rest = document.createElement('button');
    rest.type = 'button';
    rest.className = 'chip more';
    rest.dataset.go = 'tasks';
    rest.textContent = `+${more} more`;
    parts.push(rest);
  }
  $('shelf').replaceChildren(...parts);
});
refreshCards();
// A reminder's time passing changes what it says ("overdue") with nothing else happening: looked at each minute.
setInterval(refreshCards, 60_000);

const screens = createScreens({
  root: $('screens'),
  onChange: (screen) => {
    // The orb is drawn only while its screen is showing.
    orb.pause(screen !== 'main');
    chrome.runtime.sendMessage({ type: 'jester/home-screen', screen }).catch(() => undefined);
    showing(screen);
    // Back from where something was set up, or come to see what's left: how things stand now, not when last told.
    if (screen === 'main' || screen === 'setup') askSetup();
    chats.shown(screen);
    tasksPanel.shown(screen);
    history.replaceState(null, '', `#${screen}`);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target.closest?.('[data-go]');
  if (target && !target.disabled) screens.go(target.dataset.go);
});

window.addEventListener('keydown', (event) => {
  const command = event.metaKey || event.ctrlKey;
  // ⌘, is Settings, as in any Mac app; ⌘[ and Esc go back.
  if (command && event.key === ',') {
    event.preventDefault();
    screens.go('settings');
  } else if (command && event.key === '[') {
    event.preventDefault();
    screens.back();
  } else if (event.key === 'Escape' && !event.defaultPrevented) {
    if (screens.current !== 'main') screens.back();
    else if (document.activeElement === $('text') && $('text').value) {
      $('text').value = '';
      $('type').classList.remove('filled');
    }
  } else if (screens.current === 'main' && !command && !event.altKey && event.key.length === 1 && event.key !== ' ' && !event.target.closest?.('input, select, textarea, [contenteditable]')) {
    // On his screen, typing anywhere is typing to him.
    $('text').focus();
  }
});

// ——— Talking to him ———

$('type').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  $('type').classList.remove('filled');
  chrome.runtime.sendMessage({ type: 'jester/talk-type', text });
});
// Typing to him, here or to carry a chat on: his model loads meanwhile, rather than after Return.
for (const form of document.querySelectorAll('.type')) {
  form.addEventListener('input', () => {
    form.classList.toggle('filled', !!form.querySelector('input').value.trim());
    if (Date.now() - typedAt < TYPING_MS) return;
    typedAt = Date.now();
    chrome.runtime.sendMessage({ type: 'jester/talk-typing' });
  });
}
$('listen').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/talk-listen', on: !state().desktop?.continuous?.wanted }));
// Controls is a window of its own: the user's scripts, beside whatever they're doing.
$('to-controls').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/scripts', op: 'open' }));
$('gestures').addEventListener('click', () => save({ gesturesEnabled: state().settings?.gesturesEnabled === false }));
$('sleep').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/desktop-sleep', on: state().desktop?.engine?.state !== ENGINE.SLEEPING }));
// The banner's button goes to Getting started (its data-go), where what's needed is listed.
askSetup();

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case MSG.VOICE:
      drawVoice(message.voice || {});
      break;
    case 'jester/chat':
      drawChat(message.chat, { forgotten: message.forgotten === true });
      break;
    case 'jester/research-state':
      drawResearch(message.research);
      break;
    case 'jester/chats-changed':
      chats.changed(screens.current);
      break;
    case 'jester/tasks-changed':
      refreshCards();
      break;
    case 'jester/briefings-changed':
      drawBriefings(message.cards);
      break;
    // Opened again from the menu bar or the Dock: to the screen asked for, with the intro if it wasn't on screen.
    case 'jester/home-go':
      screens.go(message.screen, { instant: !!message.intro });
      if (message.intro && message.screen === 'main') intro({ now: true });
      break;
    // On screen now: the intro can play.
    case 'jester/home-shown':
      clearTimeout(introTimer);
      orb.play();
      break;
    default:
      break;
  }
});

onRender(drawMain);
onRender(({ desktop }) => {
  if (desktop && Object.hasOwn(desktop, 'research')) drawResearch(desktop.research);
});
addEventListener('resize', () => orb.resize(orbSize()));

// Where it opens: the orb, with its intro, unless the menu bar asked for Settings. A chat needs picking from Chats.
const asked = decodeURIComponent(location.hash.slice(1)) || 'main';
const first = asked === 'chat' ? 'chats' : asked;
if (first === 'main') intro();
else {
  document.body.classList.remove('opening');
  screens.go(first, { instant: true });
}
showing(screens.current);
// Something done outside his window (the models downloaded in a terminal, Ollama started) shows when they come back.
window.addEventListener('focus', askSetup);

// The window may have been shown before this page was listening for jester/home-shown: if so, the intro plays now.
chrome.runtime
  .sendMessage({ type: 'jester/home-screen', screen: screens.current })
  .then((reply) => {
    if (!reply?.shown) return;
    clearTimeout(introTimer);
    orb.play();
  })
  .catch(() => undefined);
mood(document.body.dataset.state);
chrome.runtime.sendMessage({ type: 'jester/chats', op: 'current' }).then((reply) => reply?.chat && drawChat(reply.chat));
chrome.runtime.sendMessage({ type: 'jester/briefings', op: 'list' }).then((reply) => reply?.ok && drawBriefings(reply.cards));
document.addEventListener('jester/briefing-navigate', (event) => {
  if (event.detail === 'tasks') screens.go('tasks');
});
startSettings().then(drawMain);

// For main.js's self-test, and anyone checking the window from outside: go to a screen.
window.jesterHome = { go: (screen, options) => screens.go(screen, options) };
