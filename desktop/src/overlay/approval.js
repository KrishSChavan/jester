/**
 * The assistant's question (src/main/approval.js): Allow or Don't. Either
 * click goes to the main process, which tells the waiting assistant.
 */

const $ = (id) => document.getElementById(id);
const answer = (approved) => chrome.runtime.sendMessage({ type: 'jester/approval-answer', approved });

$('allow').addEventListener('click', () => answer(true));
$('deny').addEventListener('click', () => answer(false));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'jester/approval-text') $('question').textContent = message.text;
});
