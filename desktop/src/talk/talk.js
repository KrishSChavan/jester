/**
 * The window for talking to Jester. Its state comes from the frames the pill
 * gets, so the two never disagree; it only adds what he can't show in a pill:
 * the whole of what's been said, and somewhere to type.
 */

import { MSG } from '../ext/src/common/constants.js';

const $ = (id) => document.getElementById(id);
/** He ends his own thinking; this only catches a task that died. */
const THINKING_MS = 90000;
/** How long the light says it was your voice. */
const MATCHED_MS = 2500;

/** What the main process says of listening. */
let continuous = {};
let moodTimer = null;
let matchedTimer = null;
let matched = false;

function mood(state, ms = 0) {
  clearTimeout(moodTimer);
  document.body.dataset.state = state;
  if (ms) moodTimer = setTimeout(() => mood('resting'), ms);
}

function drawLight() {
  const { listening, knowsYou, problem } = continuous;
  $('light').classList.toggle('on', !!listening || matched);
  $('light-text').textContent = matched ? 'Your voice' : listening ? (knowsYou ? 'Listening for you' : 'Listening for anyone') : problem ? 'Can’t listen' : 'Not listening';
}

function drawHint() {
  if ($('heard').textContent || $('said').textContent) return;
  const { listening, problem, wanted } = continuous;
  $('said').dataset.hint = '1';
  $('said').textContent = listening ? 'Say “Jester”' : problem || (wanted ? '' : 'Not listening. You can still type to him.');
}

function caption(heard, said) {
  delete $('said').dataset.hint;
  $('heard').textContent = heard;
  $('said').textContent = said;
  drawHint();
}

const clearHint = () => $('said').dataset.hint && ($('said').textContent = '');

function drawContinuous(state) {
  continuous = state || {};
  $('listen').textContent = continuous.wanted ? 'Stop listening' : 'Start listening';
  drawLight();
  clearHint();
  delete $('said').dataset.hint;
  drawHint();
}

/** Who was heard: the light says so, for a moment. */
function heard(voice) {
  caption(voice.text, '');
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
  } else if (voice.phase === 'thinking') mood('thinking', THINKING_MS);
  else if (voice.phase === 'speaking') {
    if (voice.done) return mood('resting');
    caption($('heard').textContent, voice.text);
    mood('speaking');
  } else if (voice.phase === 'answer') {
    caption($('heard').textContent, voice.text);
    mood('resting');
  } else if (voice.transcript?.text) {
    caption(voice.transcript.text, '');
    mood('listening', voice.hold);
  } else if (voice.active === false) mood('resting');
  else if (voice.active) mood('listening', voice.hold);
  return undefined;
}

async function drawEarlier() {
  const { conversations = [] } = (await chrome.runtime.sendMessage({ type: 'jester/talk-earlier' })) || {};
  $('earlier').textContent = conversations.length ? `Earlier (${conversations.length})` : 'Earlier';
  $('none').hidden = conversations.length > 0;
  $('conversations').replaceChildren(
    ...conversations.map(({ at, summary }) => {
      const item = document.createElement('li');
      const when = document.createElement('time');
      when.textContent = new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      item.append(when, summary);
      return item;
    })
  );
}

function openDrawer(open) {
  $('drawer').hidden = !open;
  if (open) {
    drawEarlier();
    $('close').focus();
  } else $('earlier').focus();
}

$('type').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  chrome.runtime.sendMessage({ type: 'jester/talk-type', text });
});
$('listen').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/talk-listen', on: !continuous.wanted }));
$('earlier').addEventListener('click', () => openDrawer(true));
$('close').addEventListener('click', () => openDrawer(false));
window.addEventListener('keydown', (event) => event.key === 'Escape' && !$('drawer').hidden && openDrawer(false));
window.addEventListener('focus', drawEarlier);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.VOICE) drawVoice(message.voice || {});
  else if (message?.type === 'jester/desktop-state') drawContinuous(message.continuous);
});

chrome.runtime.sendMessage({ type: 'jester/desktop-state' }).then((state) => drawContinuous(state?.continuous));
drawEarlier();
