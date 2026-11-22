import test from 'node:test';
import assert from 'node:assert/strict';
import { belongs, linkedBrowser, routeOf } from '../desktop/src/main/route.js';
import { parseSequence } from '../desktop/src/main/voice-commands.js';

const APPS = ['Messages', 'Notes', 'Spotify', 'Google Chrome', 'Safari', 'Slack', 'Home', 'TV', 'Visual Studio Code', 'Mail', 'FaceTime'];
const where = (text, said = '') => routeOf(text, { said, steps: parseSequence(text, { apps: APPS, platform: 'darwin', talking: true }), apps: APPS });

test('a command that opens an app by name is the computer’s, whatever else it says and whatever is in front', () => {
  // 2026-11-21, from the log: Chrome was in front, and this went to it whole. It opened messages.google.com.
  assert.deepEqual(where('open Messages and start a text to Dad saying: how are you doing?', 'text, dad, how are you doing?'), { where: 'computer', why: 'app' });
  assert.equal(where('open Notes and write down the link to this page').where, 'computer', 'a web word in it doesn’t make it the browser’s');
  assert.equal(where('open Safari and go to hulu.com').where, 'computer', 'a browser the extension isn’t in is an app like any other');
  assert.equal(where('open a new note').where, 'computer');
});

test('opening the linked browser is no sign of a task for an app: the words say', () => {
  assert.equal(linkedBrowser('Google Chrome'), true);
  assert.equal(linkedBrowser('Brave Browser'), true);
  assert.equal(linkedBrowser('Safari'), false);
  assert.deepEqual(where('open Chrome and open PSU Canvas bookmark'), { where: 'browser', why: 'web' });
});

test('texting and calling someone are the computer’s, though what’s said to them may hold any word', () => {
  for (const text of ['text Dad how are you doing', 'text, dad, how are you doing?', 'send a message to my dad', 'send my mom a quick text saying I’ll be late',
    'text Dad the link to that article', 'message Sam that the tabs are closed', 'can you text Trisha I’m on my way', 'shoot a text to Alex', 'call Mom', 'FaceTime my brother', 'iMessage Sam hello']) {
    assert.deepEqual(belongs(text, { apps: APPS }), { where: 'computer', why: 'kind' }, text);
  }
});

test('“text”, “message” and “call” on a page aren’t someone being texted', () => {
  for (const text of ['select the text on this page', 'make the text bigger', 'copy that text', 'open the message board', 'go to message settings', 'call it a day', 'call an Uber', 'click the message box', 'what does this text say']) {
    assert.notEqual(belongs(text, { apps: APPS }).why, 'kind', text);
  }
});

test('a message through a service that’s a site, with no app of its name here, isn’t Messages’', () => {
  assert.deepEqual(belongs('send a message to Sam on WhatsApp saying hi', { apps: APPS }), { where: '', why: '' });
  assert.deepEqual(belongs('send a message in the Canvas inbox to my professor', { apps: APPS }), { where: '', why: '' });
  assert.deepEqual(belongs('text dad on gmail', { apps: APPS }), { where: 'browser', why: 'web' });
  // With the app here, it's the app's.
  assert.deepEqual(belongs('send a message to Sam on Slack saying hi', { apps: APPS }), { where: 'computer', why: 'place' });
  assert.deepEqual(belongs('send a message to Sam on WhatsApp saying hi', { apps: [...APPS, 'WhatsApp'] }), { where: 'computer', why: 'place' });
});

test('an app named as the place to do it makes it the computer’s; an everyday word that’s also an app’s name doesn’t', () => {
  assert.deepEqual(belongs('add milk to my list in Notes', { apps: APPS }), { where: 'computer', why: 'place' });
  assert.deepEqual(belongs('play the new Gunna album on Spotify', { apps: APPS }), { where: 'computer', why: 'place' });
  assert.equal(belongs('find jobs I can work from home', { apps: APPS }).where, '');
  assert.equal(belongs('what’s on TV tonight', { apps: APPS }).where, '');
  assert.deepEqual(belongs('turn off the lamp in the Home app', { apps: APPS }), { where: 'computer', why: 'place' });
  assert.equal(belongs('search for it in Chrome', { apps: APPS }).where, 'browser', 'the linked browser named is the browser');
});

test('sites, tabs and bookmarks are the browser’s; the computer’s files and settings are its own; the rest doesn’t say', () => {
  assert.deepEqual(belongs('go to Hulu and start playing Modern Family', { apps: APPS }), { where: 'browser', why: 'web' });
  assert.deepEqual(belongs('close the other tabs', { apps: APPS }), { where: 'browser', why: 'web' });
  assert.deepEqual(belongs('open the second file in my Downloads', { apps: APPS }), { where: 'computer', why: 'kind' });
  assert.deepEqual(belongs('turn on dark mode', { apps: APPS }), { where: 'computer', why: 'kind' });
  assert.deepEqual(belongs('click the second result', { apps: APPS }), { where: '', why: '' });
  assert.deepEqual(belongs('', { apps: APPS }), { where: '', why: '' });
});

test('the user’s own words count before the conversation’s rewording of them, unless the command opens an app', () => {
  // A site they never named is the model's idea.
  assert.deepEqual(routeOf('open messages.google.com and text Dad hello', { said: 'text dad hello', apps: APPS }), { where: 'computer', why: 'kind' });
  // "Try now", "yes": their words say nothing, so the command does.
  assert.deepEqual(routeOf('open my PSU Canvas bookmark', { said: 'Try now', apps: APPS }), { where: 'browser', why: 'web' });
  assert.deepEqual(routeOf('click the next button', { said: 'keep going', apps: APPS }), { where: '', why: '' });
});
