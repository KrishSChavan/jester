/**
 * Chats: every conversation that's over, word for word, for a week (main.js
 * keeps them, chat-archive.js), in the screens to the left of the orb. One
 * opened can be read, deleted, or carried on: picked up, it's the chat going
 * on again, under the orb, and he has all of it to go on.
 */

import { cardElement } from './cards.js';
import { sourceCardsElement } from './research.js';
import { fitBox } from './typing.js';

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Delete is clicked twice: the second click counts up to this long after the first. */
const CONFIRM_MS = 4000;
/** …but not sooner than this, or a double-click would delete before "Delete" was ever seen. */
const CONFIRM_AFTER_MS = 450;

const ask = (message) => chrome.runtime.sendMessage({ type: 'jester/chats', ...message }).catch(() => null);

const dayStart = (ms) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "Today", "Yesterday", or the day's name and date. */
export function dayLabel(ms, now = Date.now()) {
  const days = Math.round((dayStart(now) - dayStart(ms)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A line of a chat: yours in a bubble, his as words. */
export function lineElement(line) {
  const item = document.createElement('li');
  const classes = ['line', line.who === 'jester' ? 'jester' : 'you'];
  if (line.hidden) classes.push('hidden-text');
  if (line.earlier) classes.push('earlier');
  if (line.card) classes.push('carded');
  item.className = classes.join(' ');
  item.textContent = line.text;
  // What the line was about, to look at and act on: the timer it set, the reminder, the note (cards.js).
  if (line.card && !line.hidden) item.append(cardElement(line.card));
  if (line.who === 'jester' && !line.hidden) {
    const sources = sourceCardsElement(line.sources);
    if (sources) item.append(sources);
  }
  return item;
}

/** A line across the chat, with a few words on it: when it was, or where it was picked up. */
export function dividerElement(text) {
  const item = document.createElement('li');
  item.className = 'divider';
  item.setAttribute('role', 'separator');
  item.setAttribute('aria-label', text);
  item.textContent = text;
  return item;
}

/**
 * A chat's lines: those said before it was picked up again, then a line, then what's been said since.
 * @param {{who:string, text:string, at:string, earlier?:boolean, hidden?:boolean}[]} lines
 */
export function chatElements(lines) {
  const items = [];
  const first = Date.parse(lines[0]?.at);
  if (lines[0]?.earlier && Number.isFinite(first)) items.push(dividerElement(`${dayLabel(first)}, ${clock(first)}`));
  lines.forEach((line, index) => {
    if (index > 0 && lines[index - 1].earlier && !line.earlier) items.push(dividerElement('Picked up'));
    items.push(lineElement(line));
  });
  return items;
}

/**
 * @param {object} options
 * @param {(screen:string) => void} options.go
 * @param {() => void} options.onPickedUp  a chat is the one going on again: the orb's screen shows it
 */
export function createChats({ go, onPickedUp }) {
  let openId = '';
  let confirmTimer = null;
  let confirmAt = 0;

  async function drawList() {
    const chats = (await ask({ op: 'list' }))?.chats || [];
    $('chats-none').hidden = chats.length > 0;
    const parts = [];
    let day = '';
    for (const chat of chats) {
      const label = dayLabel(chat.lastAt);
      if (label !== day) {
        day = label;
        const heading = document.createElement('h2');
        heading.textContent = label;
        parts.push(heading);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-item';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = chat.title;
      const when = document.createElement('time');
      when.dateTime = new Date(chat.lastAt).toISOString();
      // On his website, a chat per device: which one it was on.
      when.textContent = `${clock(chat.lastAt)} · ${chat.lines} line${chat.lines === 1 ? '' : 's'}${chat.device ? ` · ${chat.device}` : ''}`;
      button.append(title, when);
      button.addEventListener('click', () => open(chat.id));
      parts.push(button);
    }
    $('chat-list').replaceChildren(...parts);
  }

  function resetDelete() {
    clearTimeout(confirmTimer);
    const button = $('chat-delete');
    button.classList.remove('confirming');
    // An SVG has no `hidden` property, only the attribute.
    button.querySelector('svg').removeAttribute('hidden');
    button.querySelector('span').hidden = true;
    button.setAttribute('aria-label', 'Delete this chat');
  }

  async function open(id) {
    const chat = (await ask({ op: 'get', id }))?.chat;
    if (!chat) return drawList();
    openId = id;
    resetDelete();
    $('chat-title').textContent = `${dayLabel(chat.startedAt)}, ${clock(chat.startedAt)}`;
    $('chat-lines').replaceChildren(...chatElements(chat.lines));
    $('chat-text').value = '';
    $('chat-type').classList.remove('filled');
    // One line again, whatever was left in it for the chat before.
    fitBox($('chat-type'));
    go('chat');
    // Read from the end, as a chat is: what was said last is nearest the box to carry on in.
    $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
    return undefined;
  }

  /**
   * Carried on: with what was typed, said to him; without, it's there under the orb to talk or type in. Refused
   * (he's busy, or it's gone), the words typed are given back, and why is said once at the end of the chat.
   */
  async function pickUp(text = '') {
    if (!openId) return;
    const reply = await ask({ op: 'resume', id: openId, text });
    if (!reply?.ok) {
      if (text && !$('chat-text').value) {
        $('chat-text').value = text;
        $('chat-type').classList.add('filled');
        // Given back as it was typed, lines and all: the box is the size for it again.
        fitBox($('chat-type'));
      }
      $('chat-lines').querySelector('.divider.refused')?.remove();
      const why = dividerElement(reply?.error || 'Jester couldn’t pick that chat up.');
      why.classList.add('refused');
      $('chat-lines').append(why);
      $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
      return;
    }
    openId = '';
    onPickedUp(text);
  }

  $('chat-delete').addEventListener('click', async () => {
    const button = $('chat-delete');
    if (!button.classList.contains('confirming')) {
      confirmAt = Date.now();
      button.classList.add('confirming');
      button.querySelector('svg').setAttribute('hidden', '');
      button.querySelector('span').hidden = false;
      button.setAttribute('aria-label', 'Click again to delete this chat');
      confirmTimer = setTimeout(resetDelete, CONFIRM_MS);
      return;
    }
    if (Date.now() - confirmAt < CONFIRM_AFTER_MS) return;
    resetDelete();
    const id = openId;
    openId = '';
    await ask({ op: 'remove', id });
    go('chats');
  });
  $('chat-resume').addEventListener('click', () => pickUp());
  $('chat-type').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('chat-text').value.trim();
    if (!text) return;
    $('chat-text').value = '';
    $('chat-type').classList.remove('filled');
    pickUp(text);
  });

  return {
    /** A screen's coming in: Chats is listed afresh as it does. */
    shown(screen) {
      if (screen === 'chats') drawList();
      if (screen !== 'chat') resetDelete();
    },
    /** What's kept has changed (main.js says so): the list, if it's showing, is drawn again. */
    changed(screen) {
      if (screen === 'chats') drawList();
    }
  };
}
