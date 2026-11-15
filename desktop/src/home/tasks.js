/**
 * Tasks: the user's to-do list, reminders and timers (main.js keeps them,
 * tasks.js), in a screen to the left of the orb beside Chats, each one a card
 * (cards.js). Timers count down; what's open is grouped by when it's for; what
 * was ticked off lately is below, and can be put back; and the notes he's made
 * or been asked to remember lately are at the foot, each opening in Obsidian.
 * Ticking a box is the user's own doing, which is the point: he never ticks
 * one for them.
 */

import { cardElement, countdown, refreshCards, tookCards, watchCards } from './cards.js';

export { countdown };

const $ = (id) => document.getElementById(id);

const dayStart = (ms, days = 0) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/** Which heading an open task goes under. */
export function groupOf(task, now) {
  if (!Number.isFinite(task.due)) return 'No date';
  if (task.overdue) return 'Overdue';
  return task.due < dayStart(now, 1) ? 'Today' : task.due < dayStart(now, 2) ? 'Tomorrow' : 'Later';
}

const heading = (text, late = false) => {
  const h2 = document.createElement('h2');
  h2.textContent = text;
  if (late) h2.className = 'late';
  return h2;
};

const card = (task, type) => cardElement({ kind: 'task', id: task.id, type, text: task.text });
const typeOf = (task) => (Number.isFinite(task.due) && !task.allDay ? 'reminder' : 'task');

export function createTasksPanel() {
  let showing = false;
  let notes = [];
  /** What's drawn, by its ids: the list changing a card's own state (a tick) is the card's to show, not a redraw. */
  let drawn = '';

  function badge(count) {
    const el = $('tasks-count');
    el.hidden = !(count > 0);
    el.textContent = count > 99 ? '99+' : String(count || '');
    $('to-tasks').setAttribute('aria-label', count > 0 ? `Tasks, ${count} open` : 'Tasks');
  }

  function draw(list) {
    if (!list?.ok) return;
    badge(list.count);
    if (!showing) return;
    const groups = [];
    if (list.timers.length) groups.push(['Timers', list.timers.map((task) => card(task, 'timer'))]);
    for (const name of ['Overdue', 'Today', 'Tomorrow', 'Later', 'No date']) {
      const group = list.open.filter((task) => groupOf(task, list.now) === name);
      if (group.length) groups.push([name, group.map((task) => card(task, typeOf(task)))]);
    }
    if (list.done.length) groups.push(['Ticked off', list.done.map((task) => card(task, typeOf(task)))]);
    if (notes.length) groups.push(['Notes, lately', notes.map((note) => cardElement(note))]);
    const key = JSON.stringify([list.timers.map((task) => task.id), list.open.map((task) => [task.id, groupOf(task, list.now)]), list.done.map((task) => task.id), notes.map((note) => note.rel)]);
    $('tasks-none').hidden = groups.length > 0;
    if (key === drawn) return;
    drawn = key;
    $('task-list').replaceChildren(...groups.flatMap(([name, cards]) => [heading(name, name === 'Overdue'), ...cards]));
  }

  $('task-add').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('task-text').value.trim();
    if (!text) return;
    $('task-text').value = '';
    $('task-add').classList.remove('filled');
    tookCards(await chrome.runtime.sendMessage({ type: 'jester/tasks', op: 'add', text }).catch(() => null));
  });
  $('task-text').addEventListener('input', () => $('task-add').classList.toggle('filled', !!$('task-text').value.trim()));

  watchCards(draw);

  return {
    /** A screen is showing: this one's drawn afresh, with the notes he's made lately. */
    async shown(screen) {
      showing = screen === 'tasks';
      if (!showing) return;
      drawn = '';
      notes = (await chrome.runtime.sendMessage({ type: 'jester/notes', op: 'list' }).catch(() => null))?.notes || [];
      draw(await refreshCards());
    }
  };
}
