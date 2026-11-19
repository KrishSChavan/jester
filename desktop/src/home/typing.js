/**
 * The boxes to type to him in: under the orb (#type), and to carry a chat on (#chat-type). Each is a textarea in a
 * .type form; the tasks box is a .type too, with an input, and none of this is its.
 *
 * Return sends. A new line makes it a tall box, for a passage and what to do with it as one message: Shift-Return, a
 * phone's return key (it has no Shift-Return: its arrow sends there), pasted lines, and Return after words that lead
 * into a paste ("now this:"). Words past one line grow it a line at a time. Sent or emptied, it's one line again.
 */

/**
 * Typed words that only lead into what's still to be pasted: a short line ending in a colon, or one of these.
 * 2026-11-18, asking for Google Docs comments on an essay, the user typed "now this:" and pressed Return to paste the
 * next passage under it; sent alone, it was answered "the text didn't come through" 1.4 s later, 13 ms before the
 * passage, pasted and sent straight after it, came.
 * Return on them starts the next line instead, and Return again sends whatever's there, so one that wasn't a lead-in
 * costs a key. Bare "next" and "another one" aren't here: typed, those ask for the next song or another joke.
 */
const LEAD_IN = /^(?:(?:ok(?:ay)?|alright|so)[,\s]+)?(?:(?:and|now|also)\s+this(?:\s+one)?(?:\s+too)?|here(?:'s|\s+is)\s+(?:another(?:\s+one)?|one\s+more|the\s+next(?:\s+one)?|the\s+(?:passage|paragraph|text|essay|email))|next\s+(?:passage|paragraph|part|section))[\s.…]*$/i;
const LEAD_WORDS = 8;

export function leadsIn(text) {
  const raw = String(text ?? '');
  // A new line's there already (this Return's own, the last time): Return now sends.
  if (raw.includes('\n')) return false;
  const line = raw.replace(/[‘’]/g, "'").trim();
  if (!line) return false;
  return (/:$/.test(line) && line.split(/\s+/).length <= LEAD_WORDS) || LEAD_IN.test(line);
}

/** A phone or tablet with no mouse: no Shift-Return, so return is a new line, and the arrow sends. */
const touchTyping = () => globalThis.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;

/** The box's size for what's in it: one line, grown a line at a time, or tall. */
export function fitBox(form) {
  const box = form?.querySelector('textarea');
  if (!box) return;
  if (!box.value) form.classList.remove('tall');
  else if (box.value.includes('\n')) form.classList.add('tall');
  form.classList.remove('grown');
  box.style.height = '';
  if (!form.classList.contains('tall') && box.scrollHeight > box.clientHeight + 2) form.classList.add('grown');
  if (form.classList.contains('tall') || form.classList.contains('grown')) box.style.height = `${box.scrollHeight}px`;
}

/** Return, Shift-Return and the rest, for one .type form with a textarea. */
export function typingBox(form) {
  const box = form.querySelector('textarea');
  if (!box) return;
  box.addEventListener('keydown', (event) => {
    // Return that ends a word being composed (an input method's) is the method's, not a send.
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return;
    const atEnd = box.selectionStart === box.selectionEnd && box.selectionEnd === box.value.length;
    if (event.shiftKey || touchTyping() || (atEnd && leadsIn(box.value))) {
      // The new line is the box's own to make; it's tall first, so the line is seen going in.
      form.classList.add('tall');
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', () => requestAnimationFrame(() => fitBox(form)));
}

/** Words put in the box from elsewhere (pasted on his screen, or given back), as if typed there. */
export function putInBox(form, text) {
  const box = form?.querySelector('textarea');
  if (!box || !text) return;
  box.focus();
  box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
