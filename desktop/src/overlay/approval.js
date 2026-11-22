/**
 * The assistant's question (src/main/approval.js). One that asks leave has
 * Allow and Don't. One only the user can settle ("Which profile should I
 * use?") has a button for each way to answer it, and one to leave it. Any
 * click goes to the main process, which tells the waiting assistant.
 */

const $ = (id) => document.getElementById(id);
const answer = (reply) => chrome.runtime.sendMessage({ type: 'jester/approval-answer', ...reply });

function button(label, reply, kind = '') {
  const made = document.createElement('button');
  made.type = 'button';
  made.textContent = label;
  if (kind) made.className = kind;
  made.addEventListener('click', () => answer(reply));
  return made;
}

/** Its buttons: the options and "Leave it", or Allow and Don't. */
function show({ text, options = [], open = false }) {
  $('question').textContent = text;
  const answers = $('answers');
  const which = open || options.length > 0;
  document.body.classList.toggle('which', which);
  document.body.classList.toggle('stacked', options.length > 0);
  $('hint').textContent = which ? (options.length ? 'or just say which' : 'say it, or type it to him') : 'or 👍, or say yes';
  answers.replaceChildren(
    ...(which
      ? [...options.map((option) => button(option, { choice: option })), button('Leave it', { choice: null }, 'quiet')]
      : [button('Allow', { approved: true }, 'primary'), button('Don’t', { approved: false })])
  );
}

show({ text: '' });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'jester/approval-text') show(message);
});
