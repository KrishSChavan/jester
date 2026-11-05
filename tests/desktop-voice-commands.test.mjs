import test from 'node:test';
import assert from 'node:assert/strict';
import { jaroWinkler, matchApp, normalize, numberFrom, parseCommand, parseSequence, spokenKeys } from '../desktop/src/main/voice-commands.js';

const APPS = ['Spotify', 'Slack', 'Safari', 'Visual Studio Code', 'Finder', 'Messages', 'Music', 'Notes', 'System Settings', 'Google Chrome'];
const parse = (text, platform = 'darwin') => parseCommand(text, { apps: APPS, platform });

test('what the recognizer actually wrote becomes the command meant (phase 0 transcripts)', () => {
  assert.deepEqual(parse('Set the volume to thirty percent.'), { kind: 'volume', level: 30 });
  assert.deepEqual(parse('Next song.'), { kind: 'action', action: 'MEDIA_NEXT' });
  assert.deepEqual(parse('Open Spotify.'), { kind: 'open', app: 'Spotify', heard: 'spotify' });
  assert.deepEqual(parse('Open spot of fire.'), { kind: 'open', app: 'Spotify', heard: 'spot of fire' });
  assert.deepEqual(parse('Switch to slack.'), { kind: 'open', app: 'Slack', heard: 'slack' });
  assert.deepEqual(parse('Close this window.'), { kind: 'press', key: 'w', modifiers: ['cmd'], label: 'Close window' });
  assert.deepEqual(parse('Go to the next desktop.'), { kind: 'action', action: 'DESKTOP_RIGHT' });
  assert.deepEqual(parse('Take a screenshot.'), { kind: 'action', action: 'SCREENSHOT' });
  assert.deepEqual(parse('Lock the screen.'), { kind: 'action', action: 'LOCK_SCREEN' });
  assert.deepEqual(parse('Press command shift four.'), { kind: 'press', key: '4', modifiers: ['cmd', 'shift'] });
  assert.deepEqual(parse('Press Cmd shift four'), { kind: 'press', key: '4', modifiers: ['cmd', 'shift'] });
  assert.deepEqual(parse('Open Visual Studio Code.'), { kind: 'open', app: 'Visual Studio Code', heard: 'visual studio code' });
  assert.deepEqual(parse('Scroll down.'), { kind: 'action', action: 'SCROLL_DOWN' });
  assert.deepEqual(parse('Minimize safari.'), { kind: 'minimize', app: 'Safari', heard: 'safari' });
  assert.deepEqual(parse('Mute.'), { kind: 'action', action: 'MUTE_TOGGLE' });
  assert.deepEqual(parse('Pause the music.'), { kind: 'action', action: 'PLAY_PAUSE' });
});

test('"go to sleep" is Jester\'s own sleep, never an app to go to, and never the computer\'s', () => {
  const sleep = { kind: 'jester', op: 'sleep' };
  const apps = [...APPS, 'Sleep Cycle'];
  for (const said of ['Go to sleep.', 'go to sleep', 'Jester, go to sleep.', 'Hey Jester, go to sleep.', 'Please go back to sleep.', 'Sleep.', 'Sleep now.', 'Go to bed.', 'Take a nap.', 'Put Jester to sleep.', 'Put yourself to sleep.']) {
    assert.deepEqual(parseCommand(said, { apps, platform: 'darwin' }), sleep, said);
    assert.deepEqual(parseCommand(said, { apps: [], platform: 'win32' }), sleep, `${said} on Windows`);
  }
  assert.deepEqual(parse('Put the computer to sleep.').kind, 'unknown');
  assert.deepEqual(parse('Sleep the computer.').kind, 'unknown');
  assert.deepEqual(parseCommand('Open Sleep Cycle.', { apps, platform: 'darwin' }).app, 'Sleep Cycle');
});

test('typing keeps exactly what was said, in its own case', () => {
  assert.deepEqual(parse("Type Hello, I'll be there in five minutes."), { kind: 'type', text: "Hello, I'll be there in five minutes." });
  assert.deepEqual(parse('type: ok'), { kind: 'type', text: 'ok' });
});

test('polite padding is ignored', () => {
  assert.equal(normalize('Hey Jester, please mute.'), 'mute');
  assert.deepEqual(parse('Could you please take a screenshot?'), { kind: 'action', action: 'SCREENSHOT' });
  assert.deepEqual(parse('Volume up, please.'), { kind: 'action', action: 'VOLUME_UP' });
});

test('tabs, pages and the pointer', () => {
  assert.deepEqual(parse('Open a new tab.'), { kind: 'action', action: 'TAB_NEW' });
  assert.deepEqual(parse('Reopen the closed tab'), { kind: 'action', action: 'TAB_REOPEN' });
  assert.deepEqual(parse('Go back.'), { kind: 'action', action: 'HISTORY_BACK' });
  assert.deepEqual(parse('Refresh the page'), { kind: 'action', action: 'RELOAD' });
  assert.deepEqual(parse('Go to the top'), { kind: 'action', action: 'PAGE_TOP' });
  assert.deepEqual(parse('Double click'), { kind: 'click', button: 'left', count: 2 });
  assert.deepEqual(parse('Right-click that'), { kind: 'click', button: 'right', count: 1 });
  assert.deepEqual(parse('Show all windows'), { kind: 'action', action: 'SHOW_ALL_WINDOWS' });
  assert.deepEqual(parse('Calibrate my eyes'), { kind: 'jester', op: 'calibrate' });
});

test('apps that aren\'t installed, and Windows, where the Start menu finds them', () => {
  assert.deepEqual(parse('Open Photoshop'), { kind: 'unknown', text: 'Open Photoshop' });
  assert.deepEqual(parse('Open Photoshop', 'win32'), { kind: 'open', app: 'photoshop', heard: 'photoshop' });
  assert.deepEqual(parse('Close this window', 'win32'), { kind: 'press', key: 'f4', modifiers: ['alt'], label: 'Close window' });
  assert.deepEqual(parse('Quit Spotify'), { kind: 'quit', app: 'Spotify', heard: 'spotify' });
  assert.deepEqual(parse('Run shortcut Morning'), { kind: 'shortcut', name: 'morning' });
  assert.deepEqual(parse('Turn on, do not disturb.'), { kind: 'unknown', text: 'Turn on, do not disturb.' });
});

test('numbers, keys and names as speech writes them', () => {
  assert.equal(numberFrom('thirty five'), 35);
  assert.equal(numberFrom('100%'), 100);
  assert.equal(numberFrom('a hundred'), 100);
  assert.equal(numberFrom('loud'), null);
  assert.deepEqual(spokenKeys('control c'), { key: 'c', modifiers: ['ctrl'] });
  assert.deepEqual(spokenKeys('page down'), { key: 'pagedown', modifiers: [] });
  assert.deepEqual(spokenKeys('f five'), { key: 'f5', modifiers: [] });
  assert.deepEqual(spokenKeys('option left arrow'), { key: 'left', modifiers: ['alt'] });
  assert.equal(spokenKeys('command banana'), null);
  assert.ok(jaroWinkler('spotofire', 'spotify') > 0.82);
  assert.ok(jaroWinkler('slack', 'safari') < 0.82);
  assert.equal(matchApp('music', APPS), 'Music');
  assert.equal(matchApp('google chrome', APPS), 'Google Chrome');
  // An app's last words are its everyday name.
  assert.equal(matchApp('chrome', APPS), 'Google Chrome');
  assert.equal(matchApp('settings', APPS), 'System Settings');
  assert.equal(matchApp('code', APPS), 'Visual Studio Code');
  assert.equal(matchApp('studio', APPS), null, 'a word from the middle isn\'t a name');
  assert.equal(matchApp('notes', [...APPS, 'Sticky Notes']), 'Notes', 'the whole name beats the end of another');
  assert.equal(matchApp('weather', APPS), null);
});

test('everyday edits, keys and phrasings', () => {
  assert.deepEqual(parse('Undo.'), { kind: 'press', key: 'z', modifiers: ['cmd'], label: 'Undo' });
  assert.deepEqual(parse('Redo', 'win32'), { kind: 'press', key: 'y', modifiers: ['ctrl'], label: 'Redo' });
  assert.deepEqual(parse('Copy that.'), { kind: 'press', key: 'c', modifiers: ['cmd'], label: 'Copy' });
  assert.deepEqual(parse('Paste.', 'win32'), { kind: 'press', key: 'v', modifiers: ['ctrl'], label: 'Paste' });
  assert.deepEqual(parse('Select all.'), { kind: 'press', key: 'a', modifiers: ['cmd'], label: 'Select all' });
  assert.deepEqual(parse('Enter.'), { kind: 'press', key: 'enter', modifiers: [] });
  assert.deepEqual(parse('Page down.'), { kind: 'press', key: 'pagedown', modifiers: [], label: 'Page down' });
  assert.deepEqual(parse('Turn up the volume.'), { kind: 'action', action: 'VOLUME_UP' });
  assert.deepEqual(parse('Turn it down'), { kind: 'action', action: 'VOLUME_DOWN' });
  assert.deepEqual(parse('Volume max'), { kind: 'volume', level: 100 });
  assert.deepEqual(parse('Volume to 50%.'), { kind: 'volume', level: 50 });
  assert.deepEqual(parse('Switch to the next tab.'), { kind: 'action', action: 'TAB_NEXT' });
  assert.deepEqual(parse('Go to the previous app.'), { kind: 'action', action: 'APP_PREV' });
  assert.deepEqual(parse('Go to desktop.'), { kind: 'action', action: 'SHOW_DESKTOP' });
  assert.deepEqual(parse('Open a new window.'), { kind: 'press', key: 'n', modifiers: ['cmd'], label: 'New window' });
  assert.deepEqual(parse('Open Chrome.'), { kind: 'open', app: 'Google Chrome', heard: 'chrome' });
  assert.deepEqual(parse('Open settings.'), { kind: 'open', app: 'System Settings', heard: 'settings' });
  assert.deepEqual(parse('Jester settings.'), { kind: 'jester', op: 'settings' });
  assert.deepEqual(parse('Open Jester settings'), { kind: 'jester', op: 'settings' });
  assert.deepEqual(parse('Hey Jester, open settings.'), { kind: 'open', app: 'System Settings', heard: 'settings' });
});

test('a sentence of several steps is cut where every piece is a command (the phrasings people used)', () => {
  const steps = (text, platform = 'darwin') => parseSequence(text, { apps: APPS, platform });
  assert.deepEqual(steps('Open Spotify and play a Gunna song'), [
    { kind: 'open', app: 'Spotify', heard: 'spotify' },
    { kind: 'play', query: 'gunna', service: null }
  ]);
  assert.deepEqual(steps('Open a new note and say hello world.'), [{ kind: 'new', item: 'note' }, { kind: 'type', text: 'hello world.' }]);
  assert.deepEqual(steps('Open a new note and write hello world.'), [{ kind: 'new', item: 'note' }, { kind: 'type', text: 'hello world.' }]);
  assert.deepEqual(steps('Open Notes, then type Hello and goodbye'), [
    { kind: 'open', app: 'Notes', heard: 'notes' },
    { kind: 'type', text: 'Hello and goodbye' }
  ]);
  assert.deepEqual(steps('Copy and paste.').map((step) => step.label), ['Copy', 'Paste']);
  // Dictation and searches keep their "and".
  assert.deepEqual(steps('Type salt and pepper.'), [{ kind: 'type', text: 'salt and pepper.' }]);
  assert.deepEqual(steps('Search for salt and pepper on YouTube.'), [{ kind: 'search', query: 'salt and pepper', site: 'youtube' }]);
  // Half understood is reported, not half done.
  assert.deepEqual(steps('Open Spotify and do a little dance'), [
    { kind: 'open', app: 'Spotify', heard: 'spotify' },
    { kind: 'unknown', text: 'do a little dance' }
  ]);
  assert.deepEqual(steps('Volume up'), [{ kind: 'action', action: 'VOLUME_UP' }]);
});

test('new things, music and searches', () => {
  assert.deepEqual(parse('Take a note.'), { kind: 'new', item: 'note' });
  assert.deepEqual(parse('Write a new email.'), { kind: 'new', item: 'email' });
  assert.deepEqual(parse('Create a new calendar event'), { kind: 'new', item: 'event' });
  assert.deepEqual(parse('Type a new note.'), { kind: 'type', text: 'a new note.' }, '"type" is always typing');
  assert.deepEqual(parse('Write hello.'), { kind: 'type', text: 'hello.' });
  assert.deepEqual(parse('Play Gunna.'), { kind: 'play', query: 'gunna', service: null });
  assert.deepEqual(parse('Play some songs by Drake on Spotify.'), { kind: 'play', query: 'drake', service: 'spotify' });
  assert.deepEqual(parse('Play lo-fi beats on YouTube.'), { kind: 'play', query: 'lo fi beats', service: 'youtube' });
  assert.deepEqual(parse('Play some music.'), { kind: 'action', action: 'PLAY_PAUSE' });
  assert.deepEqual(parse('Google the weather in Austin.'), { kind: 'search', query: 'the weather in austin', site: 'web' });
  assert.deepEqual(parse('Search YouTube for cat videos.'), { kind: 'search', query: 'cat videos', site: 'youtube' });
});

test('windows go where they\'re told: a half, all of it, the middle, another screen', () => {
  const place = (app, where, screen = 'current', heard = app && app.toLowerCase()) => ({ kind: 'place', where, screen, app, heard });
  assert.deepEqual(parse('Put Safari on the left.'), place('Safari', 'left'));
  assert.deepEqual(parse('Snap slack to the right half'), place('Slack', 'right'));
  assert.deepEqual(parse('Maximize notes.'), place('Notes', 'full'));
  assert.deepEqual(parse('Make chrome full screen.'), place('Google Chrome', 'fullscreen', 'current', 'chrome'));
  assert.deepEqual(parse('Move Safari to my other screen.'), place('Safari', 'center', 'other'));
  assert.deepEqual(parse('Open Chrome on my monitor.'), place('Google Chrome', 'center', 'monitor', 'chrome'), 'opened there');
  assert.deepEqual(parse('Put messages on the left of the laptop screen'), place('Messages', 'left', 'laptop'));
  // The window in front, when the sentence plainly moves one.
  assert.deepEqual(parse('Snap it right.'), { kind: 'place', where: 'right', screen: 'current', app: null, heard: null });
  assert.deepEqual(parse('Center this window.'), { kind: 'place', where: 'center', screen: 'current', app: null, heard: null });
  assert.deepEqual(parse('Maximize.'), { kind: 'place', where: 'full', screen: 'current', app: null, heard: null });
  // Not a placement: no window named or meant, or a word that isn't filler.
  assert.equal(parse('Left.').kind, 'unknown');
  assert.equal(parse("What's on my monitor?").kind, 'unknown');
  assert.equal(parse('Turn left.').kind, 'unknown');
  assert.deepEqual(parse('Full screen.'), { kind: 'action', action: 'FULLSCREEN_TOGGLE' }, 'the key, as before');
  // An app named in full is the app, place words in its name and all; leftovers must be an app's name, not a guess.
  const withMonitor = (text) => parseCommand(text, { apps: [...APPS, 'Activity Monitor', 'Clock', 'TextEdit', 'Pages', 'Screenshot'], platform: 'darwin' });
  assert.deepEqual(withMonitor('Open Activity Monitor.'), { kind: 'open', app: 'Activity Monitor', heard: 'activity monitor' });
  assert.equal(withMonitor('Move Activity Monitor to the left.').app, 'Activity Monitor');
  for (const text of ['Middle click.', 'Click on the right.', 'Center the text.', 'Take a screenshot of the other screen.', 'Page left.', 'Open a new tab on the left.']) {
    assert.notEqual(withMonitor(text).kind, 'place', text);
  }
  // Windows knows only running apps: one placed in so many words is still meant.
  assert.deepEqual(parseCommand('Put Notepad on the left.', { apps: [], platform: 'win32' }), { kind: 'place', where: 'left', screen: 'current', app: 'notepad', heard: 'notepad' });
  assert.deepEqual(parseSequence('Notepad left, Code right', { apps: ['Code'], platform: 'win32' }).map((step) => step.app), ['notepad', 'Code']);
  // …and only then: a thing moved, or an email sent, is no app (the assistant takes those).
  for (const text of ['Send an email to Sam on my laptop.', 'Move the meeting to the right.', 'Move this email to the other screen.']) {
    assert.equal(parseCommand(text, { apps: [], platform: 'win32' }).kind, 'unknown', text);
  }

  const steps = (text) => parseSequence(text, { apps: APPS, platform: 'darwin' });
  assert.deepEqual(steps('Chrome left, Slack right.'), [place('Google Chrome', 'left', 'current', 'chrome'), place('Slack', 'right')]);
  assert.deepEqual(steps('Safari on the left and Notes on the right'), [place('Safari', 'left'), place('Notes', 'right')]);
});

test('"when I say …" teaches a command; "forget the shortcut …" unteaches it', () => {
  assert.deepEqual(parse('When I say focus mode, open Notes and put it on the left.'), { kind: 'teach', phrase: 'focus mode', then: 'open Notes and put it on the left' });
  assert.deepEqual(parse('Whenever I say "bedtime", then set the volume to ten.'), { kind: 'teach', phrase: 'bedtime', then: 'set the volume to ten' });
  // No comma: the phrase ends where the rest is a command.
  assert.deepEqual(parse('when I say study time open notes'), { kind: 'teach', phrase: 'study time', then: 'open notes' });
  assert.equal(parse('when I say nothing in particular').kind, 'unknown');
  // A taught command keeps its "and": it isn't cut into steps.
  assert.deepEqual(parseSequence('When I say focus mode, open Notes and put it on the left', { apps: APPS }), [
    { kind: 'teach', phrase: 'focus mode', then: 'open Notes and put it on the left' }
  ]);
  assert.deepEqual(parse('Forget the shortcut focus mode.'), { kind: 'forget', phrase: 'focus mode' });
  assert.deepEqual(parse('Forget how to open my notes'), { kind: 'forget', phrase: 'open my notes' });
  assert.deepEqual(parse('Forget it.'), { kind: 'cancel' }, 'as before');
});
