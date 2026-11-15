/**
 * Tasks: the user's to-do list, reminders and timers (main.js keeps them,
 * tasks.js), in a screen to the left of the orb beside Chats. Timers count
 * down; what's open is grouped by when it's for; what was ticked off lately is
 * at the bottom, and can be put back. Ticking a box is the user's own doing,
 * which is the point: he never ticks one for them.
 */

const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage({ type: 'jester/tasks', ...message }).catch(() => null);

const dayStart = (ms, days = 0) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/** "3:20", "1:05:09": what's left of a timer. */
export function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Which heading an open task goes under. */
export function groupOf(task, now) {
  if (!Number.isFinite(task.due)) return 'No date';
  if (task.overdue) return 'Overdue';
  return task.due < dayStart(now, 1) ? 'Today' : task.due < dayStart(now, 2) ? 'Tomorrow' : 'Later';
}

const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon-svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
};

const heading = (text, late = false) => {
  const h2 = document.createElement('h2');
  h2.textContent = text;
  if (late) h2.className = 'late';
  return h2;
};

export function createTasksPanel() {
  let showing = false;
  let ticker = null;
  /** The clock in main.js and this page's may differ by the time a message takes: timers count from main's. */
  let skew = 0;

  function removeButton(task, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon danger';
    button.title = label;
    button.setAttribute('aria-label', `${label}: ${task.text}`);
    button.append(icon('i-trash'));
    button.addEventListener('click', async () => draw(await ask({ op: 'remove', id: task.id })));
    return button;
  }

  function timerRow(task) {
    const row = document.createElement('div');
    row.className = 'task-item timer';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.append(icon('i-timer'));
    const words = document.createElement('div');
    words.className = 'words';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = task.text;
    const left = document.createElement('span');
    left.className = 'when left';
    left.dataset.due = String(task.due);
    words.append(title, left);
    row.append(glyph, words, removeButton(task, 'Cancel'));
    return row;
  }

  function taskRow(task) {
    const done = !!task.done;
    const row = document.createElement('div');
    row.className = `task-item${done ? ' done' : ''}${task.overdue && !done ? ' late' : ''}`;
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick';
    tick.setAttribute('role', 'checkbox');
    tick.setAttribute('aria-checked', String(done));
    tick.setAttribute('aria-label', done ? `Put back: ${task.text}` : `Done: ${task.text}`);
    tick.title = done ? 'Put it back on the list' : 'Tick it off';
    tick.append(icon('i-tick'));
    tick.addEventListener('click', async () => draw(await ask({ op: 'done', id: task.id, on: !done })));
    const words = document.createElement('div');
    words.className = 'words';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = task.text;
    words.append(title);
    const when = done ? '' : [task.when, task.told ? 'reminded' : ''].filter(Boolean).join(' · ');
    if (when) {
      const line = document.createElement('span');
      line.className = 'when';
      line.textContent = when.charAt(0).toUpperCase() + when.slice(1);
      words.append(line);
    }
    row.append(tick, words, removeButton(task, 'Remove'));
    return row;
  }

  function tickTimers() {
    for (const left of document.querySelectorAll('#task-list .left')) {
      const ms = Number(left.dataset.due) - (Date.now() + skew);
      left.textContent = ms > 0 ? `${countdown(ms)} left` : 'Up';
    }
  }

  function badge(count) {
    const el = $('tasks-count');
    el.hidden = !(count > 0);
    el.textContent = count > 99 ? '99+' : String(count || '');
    $('to-tasks').setAttribute('aria-label', count > 0 ? `Tasks, ${count} open` : 'Tasks');
  }

  function draw(list) {
    if (!list?.ok) return;
    skew = list.now - Date.now();
    badge(list.count);
    const parts = [];
    if (list.timers.length) parts.push(heading('Timers'), ...list.timers.map(timerRow));
    for (const name of ['Overdue', 'Today', 'Tomorrow', 'Later', 'No date']) {
      const group = list.open.filter((task) => groupOf(task, list.now) === name);
      if (group.length) parts.push(heading(name, name === 'Overdue'), ...group.map(taskRow));
    }
    if (list.done.length) parts.push(heading('Ticked off'), ...list.done.map(taskRow));
    $('task-list').replaceChildren(...parts);
    $('tasks-none').hidden = parts.length > 0;
    tickTimers();
  }

  $('task-add').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('task-text').value.trim();
    if (!text) return;
    $('task-text').value = '';
    $('task-add').classList.remove('filled');
    draw(await ask({ op: 'add', text }));
  });
  $('task-text').addEventListener('input', () => $('task-add').classList.toggle('filled', !!$('task-text').value.trim()));

  // How many are open, on the button, from the start.
  ask({ op: 'list' }).then((list) => list?.ok && badge(list.count));

  return {
    /** A screen is showing: this one's drawn afresh, and its timers count down only while it is. */
    async shown(screen) {
      showing = screen === 'tasks';
      clearInterval(ticker);
      ticker = null;
      if (!showing) return;
      draw(await ask({ op: 'list' }));
      ticker = setInterval(tickTimers, 500);
    },
    /** The list changed in main (he added one, a timer rang): the button's count, and the screen if it's showing. */
    async changed(screen, count) {
      badge(count);
      if (screen === 'tasks') draw(await ask({ op: 'list' }));
    }
  };
}
