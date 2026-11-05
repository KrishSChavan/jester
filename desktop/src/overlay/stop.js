/**
 * The × beside the voice pill and its question (src/main/stop-button.js).
 * Every click goes to the main process, which says when to show the question.
 */

const $ = (id) => document.getElementById(id);
const clicked = (op) => chrome.runtime.sendMessage({ type: 'jester/stop', op });

$('stop').addEventListener('click', () => clicked('ask'));
$('yes').addEventListener('click', () => clicked('yes'));
$('no').addEventListener('click', () => clicked('no'));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'jester/stop-asking') document.body.classList.toggle('asking', message.asking === true);
});
