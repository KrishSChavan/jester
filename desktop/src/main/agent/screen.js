/**
 * What the assistant sees of the screen: jester-driver's snapshot of the
 * front window, as numbered lines —
 *
 *   App: Spotify — "Spotify Premium"
 *   [12] button "Play Gunna"
 *   [14] searchfield "What do you want to play?" value: "gunna"
 *   [15] checkbox "Shuffle" (checked)
 *
 * — within a character budget. When not everything fits, the elements that
 * share words with the goal (and the focused one, and controls before plain
 * text) are kept, shown in their order on screen.
 *
 * Pure: snapshots in, text out.
 */

export const SCREEN_LIMITS = Object.freeze({ chars: 6000, found: 40 });

const quote = (text) => `"${String(text).replace(/\s+/g, ' ').replace(/"/g, "'")}"`;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'open', 'please', 'app']);

/** The words worth matching against labels. */
export function goalWords(goal) {
  return [...new Set(String(goal).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((word) => !STOP_WORDS.has(word));
}

const searchable = (element) => [element.label, typeof element.value === 'string' ? element.value : '', element.placeholder, element.in].filter(Boolean).join(' ').toLowerCase();
/** Whole words only: "play" is in "Play Gunna", not in "Playlist". */
const hasWord = (text, word) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);

/** One element's line. */
export function elementLine(element) {
  const parts = [`[${element.id}]`, element.role];
  if (element.label) parts.push(quote(element.label));
  if (typeof element.value === 'number') parts.push(`value: ${element.value}`);
  else if (element.value) parts.push(`value: ${quote(element.value)}`);
  if (element.placeholder && element.placeholder !== element.label) parts.push(`placeholder: ${quote(element.placeholder)}`);
  // A short label ("Play") says where it is: the top result's, not the player's.
  if (element.in) parts.push(`— in ${quote(element.in)}`);
  const flags = [];
  if (element.checked !== undefined) flags.push(element.checked ? 'checked' : 'unchecked');
  if (element.selected) flags.push('selected');
  if (element.focused) flags.push('focused');
  if (element.disabled) flags.push('disabled');
  if (flags.length) parts.push(`(${flags.join(', ')})`);
  return parts.join(' ');
}

function score(element, words) {
  const text = searchable(element);
  let points = words.reduce((sum, word) => sum + (hasWord(text, word) ? 3 : 0), 0);
  if (element.role !== 'text') points += 1;
  if (element.focused) points += 2;
  return points;
}

/**
 * The screen as the model reads it.
 * @param {object} snapshot  jester-driver's `snapshot` reply
 * @param {object} [options]
 * @param {string} [options.goal]  ranks elements when they don't all fit
 * @param {number} [options.chars]
 */
export function screenText(snapshot, { goal = '', chars = SCREEN_LIMITS.chars } = {}) {
  const title = snapshot?.window?.title;
  const header = `App: ${snapshot?.app?.name || 'unknown'}${title ? ` — ${quote(title)}` : ''}`;
  const elements = snapshot?.elements || [];
  const lines = elements.map(elementLine);
  const room = chars - header.length - 120;
  let shown = elements.map((_, i) => i);
  if (lines.reduce((sum, line) => sum + line.length + 1, 0) > room) {
    const words = goalWords(goal);
    const ranked = shown.slice().sort((a, b) => score(elements[b], words) - score(elements[a], words) || a - b);
    const kept = [];
    let used = 0;
    for (const i of ranked) {
      if (used + lines[i].length + 1 > room) continue;
      kept.push(i);
      used += lines[i].length + 1;
    }
    shown = kept.sort((a, b) => a - b);
  }
  const hidden = elements.length - shown.length;
  const notes = [];
  if (hidden > 0) notes.push(`(${hidden} more on screen not shown: use find to look for one)`);
  if (snapshot?.truncated) notes.push('(the window holds more than was read)');
  if (!elements.length) notes.push('(no controls could be read in this window)');
  return [header, ...shown.map((i) => lines[i]), ...notes].join('\n');
}

/** The lines for elements matching every word of `query`, for the `find` action. */
export function findElements(snapshot, query, max = SCREEN_LIMITS.found) {
  const words = goalWords(query);
  if (!words.length) return [];
  return (snapshot?.elements || [])
    .filter((element) => words.every((word) => hasWord(searchable(element), word)))
    .slice(0, max)
    .map(elementLine);
}

/** An element by its number in the snapshot. */
export function elementById(snapshot, id) {
  return (snapshot?.elements || []).find((element) => element.id === id) || null;
}
