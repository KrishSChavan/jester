/**
 * His website, with a chat per device: the banner on his screen for a chat going on somewhere else (the user,
 * 2026-11-18: "a little banner that I can close that allows me to 'see current chat from:' and then the device",
 * one with a running task first, which main.js puts first).
 *
 * Tapped, this device shows that chat instead, live, and what's typed here goes into it; the banner then says whose
 * it is and takes it back to this device's own. Closed, it stays away until that device starts another chat, or a
 * task there begins.
 */

const $ = (id) => document.getElementById(id);

/** What the banner says and does, from what the server says is going on: null for none. */
export function bannerFor({ others = [], viewing = null } = {}, dismissed = new Set()) {
  if (viewing) return { text: `Showing the chat from ${viewing.name}`, action: 'Back to this device', key: '' };
  const other = others.find((chat) => !dismissed.has(`${chat.chat}|${chat.running ? 'task' : ''}`));
  if (!other) return null;
  return { text: `See current chat from: ${other.name}${other.running ? ' (a task is running)' : ''}`, action: '', key: other.key, mark: `${other.chat}|${other.running ? 'task' : ''}` };
}

/** @param {{onChat:(chat:object) => void}} options  the chat to show instead, once the server's switched */
export function createOthers({ onChat }) {
  const dismissed = new Set();
  let state = {};
  let shown = null;

  function draw(next = state) {
    state = { others: Array.isArray(next.others) ? next.others : [], viewing: next.viewing || null };
    shown = bannerFor(state, dismissed);
    $('others').hidden = !shown;
    if (!shown) return;
    $('others-text').textContent = shown.action ? `${shown.text} · ${shown.action}` : shown.text;
    // Its own chat can't be closed away from: only gone back to.
    $('others-close').hidden = !!shown.action;
  }

  $('others-see')?.addEventListener('click', async () => {
    if (!shown) return;
    const reply = await chrome.runtime.sendMessage({ type: 'jester/chats', op: 'view', key: shown.key }).catch(() => null);
    if (!reply?.ok) return;
    onChat(reply.chat);
    draw(reply);
  });
  $('others-close')?.addEventListener('click', () => {
    if (shown?.mark) dismissed.add(shown.mark);
    draw();
  });

  return { draw };
}
