# Jester Desktop

The Electron app that takes Jester beyond Chrome: the real cursor, the
keyboard, media keys and other apps, driven by the same gestures, eye/head
pointing and voice. The extension stays, and links to the app.

**Status: phase 6 (the assistant), being tried out.** Jester runs from the
menu bar; gestures press the OS's own keys, an overlay shows what they did,
and with Cursor control on, an open palm raises the real cursor: your eyes or
head aim it, closing the hand clicks. ☝️ (or ⌥⇧J, or the menu) opens the mic
for one spoken command, recognized on this computer; what the local matcher
can't do goes to an AI model of the user's, which works the app in front.
Linking the extension (phase 5) comes next. Phase 0's answers are below.

What an action means outside a browser is in `src/main/os-actions.js`: one
play/pause key for Play, Pause and Play/pause; arrows for seeking; each OS's
shortcuts for apps, desktops, tabs and history. Actions only Chrome can do
(speed, skip ad, moving tabs) say so instead. As in the extension, a second
set of bindings can apply outside full screen; here "full screen" means the
front window fills its display.

## Layout

| Path | What it is |
|---|---|
| `src/main/main.js` | App entry: one instance, menu-bar only, engine in a hidden window, permissions polled. |
| `src/main/tray.js`, `tray-menu.js` | The menu-bar menu (`tray-menu.js` decides what it says). |
| `src/main/permissions.js`, `permission-list.js` | Reading and asking for Camera, Accessibility, Microphone, Screen Recording. |
| `src/main/windows.js`, `src/settings/` | The engine's hidden window and the Settings window. |
| `src/main/os-actions.js`, `dispatch.js` | What each action does on each OS, and doing it through the driver. |
| `src/main/overlay.js`, `src/overlay/` | Click-through windows over every display: hold progress, toasts, the cursor ring, the voice pill. |
| `src/main/approval.js`, `stop-button.js`, `pill-math.js` | The small windows that do take clicks: the assistant's question, and the × beside the pill. |
| `src/main/pointer.js`, `pointer-math.js` | The real cursor: placing, easing, freezing the aim, clicking with aim assist. |
| `src/preload/chrome-shim.cjs`, `src/main/chrome-bridge.js` | The slice of `chrome.runtime` / `chrome.storage` the extension's pages use, over IPC. |
| `src/main/engine-host.js` | The service worker's half of the engine: settings, gestures, cursor, voice. |
| `src/main/protocol.js`, `files.js` | `jester://ext/…` serves the extension folder, `jester://app/…` this app's pages. |
| `src/main/speech.js`, `src/main/speech/` | Offline speech (sherpa-onnx) in a `utilityProcess`, fed by the engine page's stand-in `SpeechRecognition` (in the preload). |
| `src/main/voice-commands.js`, `voice-runner.js`, `apps.js` | What a sentence means, and doing it: actions, apps, volume, keys, typing, clicks, windows, Spotify, Shortcuts. |
| `src/main/learned.js` | What's taught ("when I say …") and learned (a task the assistant got done, kept to be done again without it). |
| `src/worklets/` | The mic for speech, captured on the audio thread; served to the engine page as `jester://ext/_desktop/worklets/…`. |
| `src/main/assistant.js`, `src/main/agent/` | The assistant: the screen as the model reads it, and what a step changed (`screen.js`), its actions and how careful each is (`actions.js`), its prompt (`prompt.js`), the loop (`loop.js`), the hands (`host.js`) and learned tasks done again (`replay.js`). |
| `src/main/driver.js`, `native/jester-driver/` | Rust helper for OS input and the accessibility tree, JSON lines over stdio. Also Chrome's native-messaging relay. |
| `src/main/watch.js`, `watch-status.js`, `native/jester-watch/` | The Apple Watch: its app, the Mac's Swift Bluetooth helper, and steering the cursor with them (Mac only). |
| `src/main/link.js` | The app's end of the link to the extension. |
| `spikes/` | Phase 0 experiments. |

Tests live with the extension's, in `../tests/desktop-*.test.mjs`, and run with
`npm test` from the repository root.

## Setup

```sh
cd desktop
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary on first use
npm run driver                           # needs Rust: https://rustup.rs
npm run models                           # speech models, ~135 MB, into models/
```

## Running

- `npm run launcher` (macOS, once) — puts a **Jester** app in /Applications
  (or ~/Applications): double-click it, or open it from Launchpad, Spotlight,
  the Dock or Login Items. It starts the same Electron as `dev:mac` on this
  checkout — the current code, and the permissions already given to
  "Electron" — logging to `~/Library/Logs/Jester/dev.log`; with Jester
  running, it opens Settings. Its large icon sizes are scaled up from the
  extension's 128 px one.
- `npm start` — the app. Add `JESTER_LOG=1` to see gestures, cursor frames and CPU.
- `npm run dev:mac` — the same, launched through `open` so macOS asks for the
  camera and Accessibility on behalf of "Electron" rather than the terminal or
  VS Code. Output: `~/Library/Logs/Jester/dev.log`, echoed to the terminal.

The app lives in the menu bar. Settings opens by itself while Camera or
Accessibility is missing, and from the menu otherwise; closing it leaves
Jester running. The engine only gets the camera once macOS has granted it, so
no prompt ever comes from the hidden window.

For tests and development (see the top of `src/main/main.js`):
`JESTER_FAKE_MEDIA=1` (synthetic camera and mic), `JESTER_DATA_DIR`,
`JESTER_SPIKE_SECONDS`, `JESTER_OPEN_SETTINGS`, `JESTER_THEME=light|dark`,
`JESTER_DRIVER_DRY=1` (the driver describes input instead of sending it, and
`open`, `osascript` and `shortcuts` are logged instead of run), and
`JESTER_SELFTEST=1` (opens Settings unfocused, checks it shows the engine and
that its switch stops and restarts it; with `JESTER_DRIVER_DRY=1` it also
dispatches a few actions; `JESTER_CAPTURE=file.png` adds pictures of the page
and the overlay's toast). `JESTER_SELFTEST_VOICE=1` with
`JESTER_FAKE_AUDIO=command.wav` speaks one command into the synthetic mic and
logs what was heard and done; make one with
`say -o command.wav --data-format=LEI16@16000 "[[slnc 200]] Open Spotify. [[slnc 3000]]"`.

## Voice

☝️ Pointing up (the extension's voice gesture), ⌥⇧J (Alt+Shift+J), or
Speak a command in the menu opens the mic; the pill at the bottom of the
screen shows it listening, then what was done. A pause ends the command, or
make the gesture again. `voice-commands.js` matches the sentence locally, with
no model: volume ("volume 30", "mute"), media ("next song"), apps ("open
Spotify", "switch to Slack", "quit Notes", "minimize Safari"), windows and
tabs, desktops, "screenshot", "lock the screen", edits ("undo", "copy",
"select all"), "type …", "press command shift four", "click" / "double click"
/ "right click" at the cursor, "new note" (or email, message, reminder,
event, document), "play Gunna" (below), "search for …" / "search YouTube
for …", "run shortcut …" (macOS Shortcuts), and "go to sleep" or "pause
Jester". App names are matched forgivingly against what is installed and
running, so "spot of fire" still opens Spotify.

Asleep, Jester ignores everything but the gesture bound to Sleep / wake
Jester, and a task running ends. A gesture bound to it, "go to sleep", or the
menu put it to sleep; that gesture or the menu wake it (the mic is off while it
sleeps, so voice can't). A toast says which way it went, and the menu bar shows
Zz. Sleep is a toggle, so the pose that did it must be gone for a full second
before it can fire again: a held pose drops out for longer than the usual
`releaseMs` whenever the hand shifts, which used to flip it straight back.

Windows go where they're told, as in Atticus: "put Chrome on the left",
"Safari on my monitor", "maximize Notes", "make Chrome full screen", "move
this to the other screen", "Chrome left, Slack right". Everything but the
app, one place (left, right, full, center, full screen) and one screen
(laptop, monitor, other) must be filler, so "what's on my monitor" never
moves anything; an app named in full is the app, place words in its name and
all ("open Activity Monitor" opens it). The app is brought forward (opened
first if it isn't running), so "put Notes on the left and type hello" types
into Notes. The driver brings a window out of the Dock, out of hiding and out
of full screen, sets its size, its place and its size again, and the runner
checks where it landed: a window that stayed put (in its own full-screen
space, say) is said to have, never claimed moved, as is one that couldn't go
full screen or keeps a size of its own. On macOS the Chromium apps' enhanced
accessibility, which animates window moves, is off while one moves. On
Windows a window is put back to its ordinary state first (one minimized while
maximized would come back maximized), placed again if a display of another
scale resized it, and maximized for full screen.

"Play Gunna" opens Spotify's search for it, waits for the search box to show
those words (an earlier search's page may still be up), then presses the top
result's Play (or the result named by what was said) through accessibility,
and checks Spotify shows it playing — no model, about a second. No Automation
permission is needed, and it's the same on Windows. If the result can't be
found, picking one goes to the assistant; if Play was pressed but it can't be
seen playing, the pill says so and nothing presses it again (a second press
would pause it).

"When I say focus mode, open Notes and put it on the left" does that, and
keeps it: "focus mode" does it again. "Forget the shortcut focus mode" drops
it. A task the assistant gets done is learned too (`learned.js`, Atticus's
idea): next time the same words — politeness and filler aside — do it again
step by step, without the model (`agent/replay.js`), each control found
afresh by its kind and name. Only what can be found again is kept (never a
screen number or a spot), and never a task that needed your OK, typed words
you didn't say, was about "this", or asked something (its answer was that
day's screen; "Can you make a new note?" is a request, not a question). Nothing the model said is kept: a replay answers "Done, the
way it worked before." A replay that finds something not as it was stops
there, and the assistant takes over, told where; what it then does is kept
after the steps the replay had done. Learned tasks unused for 30 days are
dropped. They're kept sealed, as API keys are (`chrome-bridge.js`
`PRIVATE_KEYS`): they hold what was typed.

A sentence can hold several steps — "open a new note and write hello
world" — cut at "and" / "then" only where every piece is a command
(dictation keeps its "and": "type salt and pepper"). Steps run in order;
after one brings an app forward, the next waits until it's in front, and
nothing is typed if it never gets there, if a password field has the focus,
or if what has the focus can't be read (macOS's secure input on, with the
focus on something that isn't plainly a text field, counts as a password
field: a web page's not yet read looks like that). A sentence understood only in part goes, whole, to a learned way of
doing it, then to the assistant; without one, it does nothing and says which
part. A new command ends an assistant task still running.

Apps open through LaunchServices (`open -a`) on macOS and quit or hide
through `NSRunningApplication` (jester-driver's `quitApp`/`hideApp`), so no
Automation permission is asked for. On Windows, running apps are brought
forward by the driver and others are found by typing into the Start menu;
one counts as in front by its program's name (a few that don't say the
app's are known: PowerPoint is POWERPNT) or by its window's title in whole
words, never by a name inside another's ("word" in 1Password).

Two recognizers, chosen in Settings › Speech model: **Accurate** (Parakeet
TDT 0.6B v2, ~650 MB download: `npm run models -- parakeet-0.6b`) and
**Light** (Parakeet 110M). Without a choice, the most accurate one downloaded
is used. In the app, Accurate peaks near 800 MB while decoding and loads in
~1.4 s; Light about half that, in ~0.5 s. Either loads when a command begins
and is let go after 10 idle minutes or when voice is switched off; the audio
waits in the speech service's queue while it loads, so nothing said is lost.

The mic is captured raw (no echo cancellation, noise suppression or
auto-gain: each command opens a fresh stream, and those spend their first
moments adapting, just as the first word arrives) by an audio worklet
(`src/worklets/`), off the engine page's busy main thread. The log line for
each command says what the mic was doing and how much audio arrived:
`speech heard "…" in 81 ms · 1.5 s of audio over 1.6 s`.

To compare models on a real voice, `JESTER_SAVE_SPEECH=~/jester-voice` keeps
each command as a WAV with what was heard beside it; `node
scripts/speech-bench.mjs` runs a folder of them through any model.

## The assistant

A command the matcher doesn't know ("reply to Sam on Slack", "play Gunna" —
where the matcher only gets as far as Spotify's search) goes to an AI model
from Settings › Assistant: the user's own Gemini, Groq, OpenAI, Anthropic or
OpenAI-compatible key, saved through the extension's `credentials.js` and paced
through its model pool, as in Chrome. Keys are sealed on disk with the OS
keychain (macOS) or DPAPI (Windows) via `safeStorage`, and pages never see them
(`chrome-bridge.js` keeps `modelConnections` out of their storage).

Ollama is the free choice, and nothing leaves the computer: install it, `ollama
pull` a model, and pick "Ollama (on this computer)" with the model's name, no
key. Thinking is turned off for it (left on, it spends the whole output budget
and returns no reply), replies are held to the schema (plain JSON mode had half
the plans refused), the model stays loaded for 30 minutes after each request,
and it gets 30 s where cloud models get 10, since a first request loads it into
memory. On an M4 Pro `qwen3.5:9b` planned in about 2 to 4 s, 13 s from cold;
`qwen3.5:2b` is quicker but chose the wrong app or step too often to use. Ollama
refuses extension origins, so Chrome's settings don't offer it.

### The continuous assistant

Settings › Assistant › Continuous assistant keeps a mic open (`src/voice/`, a
hidden page opened with the setting and closed without it) and turns Jester into
something to talk to. Speech is still recognized here: `speech/service.js`'s
`listen` mode hands over every utterance, keeps about a second between them, and
restarts the voice detector every 6 hours, because its 32-bit sample counter stops
it finding anything after 37 hours. The detector takes about 0.2% of a core.

`wake.js` decides what was said to him. The word lists come from 18,000
transcripts of twelve synthetic voices: American ones get "Jester", but British,
Indian and Australian ones mostly get "Just a…", so "just" counts with a request
after it, and Jay and Jess with a sign they're being called. Across all twelve,
Parakeet catches about 78% in the clear and 63% in a room (Moonshine 56%), and 17
of 140,000 ordinary sentences set it off, some of them really about Jester. That's
synthetic, not a real voice: saying his name alone and then the rest is the other way.

What was said to him (`conversation.js`) goes to the matcher if it's a known
command, and otherwise to an Ollama model chosen in Settings, which answers and
can hand back a command. Results are said aloud. Commands that could do harm ask
first when overheard (`asksFirst`, fail closed: anything not listed asks), since
anything saying his name can reach them; tasks ask for themselves.

He'd otherwise hear himself, and did: through a Mac's speakers, his replies came
back garbled as if the user had said them, and he answered them. So while he
talks and for 1.2 s after, only "stop" gets through; when he stops, whatever was
mid-utterance is thrown away (`listenAfresh`), since it began with him in it; and
anything heard that's mostly words he said in the last 30 s is dropped as an echo.

Teaching him a voice (Settings › Assistant › Your voice) keeps everyone else out
at the door. Five sentences make a voiceprint (`voiceprint.js`, sealed with the API
keys), and `service.js` compares each utterance to it before decoding it, in about
8 ms, so nothing anyone else says becomes text at all. TitaNet small was chosen on
twelve synthetic voices: same voice 0.75-0.9, others 0.2, 2-3% equal error on clips
up to 1.6 s and 5% on longer ones, against 21% for CAM++ and 6% for ResNet34. The
thresholds (`MATCH`) are untested on real voices: each refusal logs its score.
Only with a voiceprint does he take what's said after an answer without his name;
his name alone opens the next 8 seconds either way.

`conversation.json` in the app's data folder holds what was said to him and what
he said, for the model's context, and is emptied every hour. What's overheard
isn't kept.

Conversations are told apart: one ends after 5 minutes of quiet, or when the model
says a new subject has begun (`new` in its reply). What's over stops being sent as
the conversation so far, and `recollections.js` keeps it as a sentence for a week.
Up to six of those, the ones sharing words with what's being said and then the
latest, reach the model marked as over and separate, to use only if they matter.

Menu bar › Talk to Jester opens `src/talk/`, his window: a flat disc that pulses
with what he's doing, live captions, a light for whose voice he's listening to,
what he remembers, a box to type to him (a typed command is on purpose, so it
doesn't ask first), and a way to stop him listening. It draws from the same frames
as the pill, so the two can't disagree. The palette is the tokens atop `talk.css`.

His voice (`speaker.js`) is the computer's own until Puter is connected, and again
whenever Puter fails. `puter.js` makes the call Puter's script makes, from the main
process, so no remote code runs in the app; signing in goes through the browser,
as Puter's Node package does. It isn't unlimited: Puter's source gives a free
account $0.50 a month, or about 31,000 characters at this voice's price, and it
answers 402 past that. Only what he says goes to Puter.

Before anything is done, one model call plans the command (`agent/plan.js`):
up to eight steps — open an app or a link, a menu command, a key, a media key,
place a window, write some text, or look, for anything that needs eyes. The
planner never sees the screen: it gets what was said, the platform, the name of
the app in front and how the last few commands ended, so nothing a window says
can reach the plan. There's no field in a plan for approving anything.

`agent/executor.js` then does the steps with no model, each one checked — a key
or menu command by what it changed on screen (one read again after a moment for
a slow app), written text by reading it back — and the run ends the moment the
last one passes, with no call to ask whether it's finished. A write goes only
into the field with the focus, or the only text area on screen, and only if it's
empty (unless the plan says to add to the end): when ⌘N fails, the list isn't
added to whatever document was open. After an app is opened, keys wait for it
to be in front. Every action, planned or not, goes through the same checks as
the model's, on the user's words and the screen as it is then.

A `look` step, and a step that failed, go to the model as below, told which
step it's on and what failed: at most six calls, and a step that's looking for
a control that appears (`until`, like Pause) or text that lands ends the moment
it does. Still stuck, the rest is planned again, at most twice and never the
same way, told why in words with anything quoted from the screen taken out;
then the run stops and says how far it got ("I did 2 of 3 steps (Open TextEdit,
New document), then stopped: …"). There's no replan after a no, a cancel or a
model that says it can't.

A command about what's on screen ("this", a question, "click…"), a saved way
that stopped part way, and pressing Play on a search's results skip the planner
and go straight to the model; so does a plan that comes back unusable. A task takes at most 30 actions and 16 model calls. A run that's
stuck can't hide it: the same actions on the same screen stop at the third
time, and text that's read back isn't typed again. The pill shows `Planning…`,
the plan, then `2 of 3 · New document`; the log has each plan's step labels
(never the text it writes) and why a reply was unusable.

Each step the model gets the goal, a short memory and the front window, read
by jester-driver's `snapshot` — its controls in reading order, numbered, with
their roles, names, values and states, in the same vocabulary on both OSes:

```
App: Spotify — "Spotify Premium"
[12] button "Play Gunna"
[14] searchfield "What do you want to play?" value: "gunna"
```

The snapshot squashes a value's whitespace, so a text area's value is read
again in full for its line breaks, which the model sees as `⏎`.

It answers with one action (or up to three on controls already on screen):
click (or double- or right-click), type (replacing a one-line field's text,
adding to a longer one's, or at the cursor; optionally then Enter), press a
key or shortcut (some times over), scroll (sideways too, or to the end),
scroll to some words, choose a menu-bar command ("File > New Note"), drag
one control onto another, place a window, open an app, open a link, a media
key, find, wait, finish.

The hands are accessibility first, as Atticus's are: a control's own press, a
field's value set outright and read back, a scroll area's own scrolling and a
menu command reach the app wherever it is, without the pointer or the
keyboard. A real click, typed keys or the wheel are the fallback.

Typing replaces a one-line field's text and adds to a longer one's: on
macOS by putting the caret at the end and inserting there, which keeps the
field's styles, lists and attachments (a whole-value write would flatten a
note to plain text); on Windows, and in web pages (which don't notice a value
set from outside), by typing. A field holding more than the screen showed is
never replaced: that would wipe text the model never saw. With Enter to
come, the app and its focus are checked before anything is written; what was
typed is read back (the whole value, however long, a few times while a web
page catches up) before Enter, so a search or a message with the wrong words
in it isn't sent. Text added through accessibility that can't be confirmed
is said to maybe be there, never typed again.

A press (or a context menu) that gets no answer may have opened a dialog or
a menu that holds the app, and counts as done — clicking it again could do it
twice; on Windows an Invoke gets a second, on another thread, so a dialog
can't hold the driver. A step whose screen was read again in between is
refused, never clicked where it used to be. A menu command is looked up
first (no press), so its real titles are what's judged and shown, then
pressed by those titles word for word: what's chosen is what was approved,
judged on every title of the path ("Message › Move to › Bin" deletes). A
level that can't be read without opening it (Open Recent; most of a Windows
UI Automation menu) comes back as asked, and the press takes it exactly; a
path that goes on past a command names no command, and nothing is pressed. A
wrong title comes back with the titles there are; Windows' classic menus are
brought up to date first, as Windows does before showing one. No menu
command is chosen while a password field has the focus (Paste would fill it).

Scrolling pages through the scroll area itself and says whether it moved; a
scroll bar set directly moves one page, measured from the content. Where the
area can't scroll itself (Chromium pages), the wheel does it. On Windows the
area chosen is one that scrolls that way. `scroll_to` pages until the words
are on screen, turning back once at an end or where nothing moves.

The last step of each reply is checked: the screen is read again and
compared, by each control's kind and name (numbers change every read; a
clock's digits don't count), and the model hears what changed — "New: button
"Save"", "Now in Mail", "Focus is on …" — or "Nothing on screen changed",
which it's told means it may not have worked (to look, and never to redo a
toggle or formatting for it). A menu command or key whose effect a read
can't show (bold text, a copy) is "no visible change", not a failure. That
read is the next step's screen, so checking costs no extra reads, and a step
that changed nothing isn't progress (three in a row end the task).

Each action of a group is judged on the focus the ones before it left, and on
the screen from before the group, the more careful of the two (a press
through accessibility doesn't always move the focus): after typing into the
message box, an Enter is an Enter there (and asks); after a key that may have
moved the focus (Tab, say), an action that depends on where the focus is
waits for a fresh look at the screen. A step whose effect can't be seen isn't
progress either.

The user's rules (2026-10-21): it acts by itself, except before anything that
sends or posts, buys, deletes, or changes system settings, where the pill asks
— 👍, the pill's Allow, or "yes" (👎, Don't, "no", or a minute's silence is a
no). It never types into, or reads, a password field: the driver refuses too.
A link to a site the user didn't name counts as sensitive. Within those same
rules: a menu command or a drop that deletes (the Trash, the Bin, the Recycle
Bin, "Recently Deleted", "Deleted Items"), a plain "OK" in a dialog asking
whether to delete, send or buy (clicked, or pressed with Enter or Space, or
Enter from anywhere in it that isn't a text field or a button — its default
button may be the delete — or text typed into it with Enter), Enter or Space
on a focused Send or Buy button, Delete or Backspace outside a
text field (a selected file or message), a line break typed into a message
(it's an Enter), and anything in Windows' Settings, Control Panel or its
tools all ask first. A Windows Store app is named after the app its frame
holds (SystemSettings, Calculator), not ApplicationFrameHost. A menu command,
a drop or Paste into a password field never happens.

"Stop", any new command, going to sleep, or the × beside the pill ends a task.
The × asks first ("Stop automation?", Yes or No); the task carries on until
Yes, which cuts off a model call in flight, lets a step already being done
finish and closes a mic opened for a spoken yes. Like the question, the × has a
small window of its own, since the overlay lets every click through. The pill
says where it ends, and only grows during a task, so the × stays put to aim at.

While it works, the pill shows the task in a few words ("Texting Trisha
hello", the model's caption from its first reply; until then, what you said,
cut at 32 characters) and, smaller under it, the step it's on.

Reading the screen hides Jester's overlays for the moment it takes (see
below), so the pill blinks out while the assistant looks. The × doesn't: a click
meant for it must never land in the app below.

Keys go to whichever app is in front when they're sent, and that can change
while a step waits for an OK — on 2026-10-22 a click that fell through the
overlay brought VS Code forward, and an approved "hello, Enter" meant for
Messages was typed into its chat box instead. So before any key, typed text,
scroll or click at a point, the host brings the app the screen was read from
back to the front and checks it (and, for typing, that the keyboard focus is
in it); otherwise nothing is typed. Jester's own windows are never read as
"the screen". A send, purchase or deletion that was approved and done is
never repeated in the same task: the model couldn't see the sent message and
asked to send it again, twice. The question has its own small window (Allow /
Don't), which takes clicks without making Jester the active app.

"The window you're working in" skips anything smaller than 120 × 80: after
sending, Messages put a 66 × 22 window in front of the conversation, and the
next read failed looking for it. A read that fails is tried once more after
0.4 s; if it fails again the pill says so, and what it had already done, and
the log has why.

## The cursor

The engine's cursor frames are fractions of the screen the cursor aims at (the
main display, which has the camera on a laptop). `pointer.js` eases the real
cursor between the engine's 20 frames a second at 60, holds the aim still once
the hand is a quarter closed, and clicks there. Moving the mouse yourself
hands it back for 1.5 s. A click looks at the point and up to 16 around it
(the extension's aim assist) for something pressable through the
accessibility tree, and clicks that. Eye aiming needs the extension's own
calibration screen, opened from Settings or a gesture bound to "Calibrate the
eye pointer"; head aiming doesn't.

## The Apple Watch

The cursor can follow your wrist: turn your hand to move it, tap thumb to finger
to click. It's Jester's own app on the watch, talking only to Jester on the Mac,
and it works with the camera off or the hand out of view. Mac only.

**Setting it up** (once):

1. `npm run watch`, which builds the Mac's Bluetooth helper.
2. With Xcode open, connect your iPhone to the Mac with a cable that carries
   data, unlock it and tap Trust. Developer Mode stays hidden until Xcode has
   seen the device; it then appears at the bottom of Settings › Privacy &
   Security. Turn it on and let the phone restart. The watch works the same way,
   through the phone: keep it unlocked with its screen on when you plug the phone
   in, tap Trust on it, and only then does its Developer Mode appear. If that
   prompt doesn't come, restart the watch and plug the phone in again. On
   watchOS 27, pair it from Device Hub instead (File › Pair Nearby Device…).
3. Open `native/jester-watch/JesterWatch.xcodeproj`, pick your watch as the run
   destination and press Run. It's signed with the Personal Team, so the app
   stops opening after 7 days; press Run again to renew it. A paid team (Signing
   & Capabilities) makes that a year.
4. Start Jester from the Dock or with `npm run dev:mac`, so that macOS asks
   Electron about Bluetooth rather than your terminal. In Settings › Apple Watch,
   turn on "Steer with your watch" and allow Bluetooth. Click Pair, tap Pair on
   the watch, and click They match if both show the same number.
5. On the watch, tap Teach my pinch, pinching as you would to click. Until then,
   click with the watch's button. If pinches then feel too hard or too easy, the
   Pinch button on the watch goes between Light, Normal and Firm, from the next
   Start.

Moving windows has to be taught first: Teach window move on the watch has you
take turns holding each pinch for about two minutes, and turns it on only if it
then gets at least 11 in 12 fresh ones right.

**Using it:** open Jester on the watch and tap Start, then lower your arm and
point. A slow turn aims and a quick one travels, as with a mouse, and the cursor
crosses from screen to screen as a mouse does. Tap Stop when done. Moving the
real mouse or typing takes over at once, as does putting Jester to sleep.
Steering stops after an hour, a limit of watchOS; tap Start to go on.

| To | Pinch | Or on the watch's Click button |
|---|---|---|
| Click | Pinch | Tap |
| Double-click | Pinch twice, and keep still | Tap twice |
| Drag | Pinch and hold, move, let go | Hold, and move |
| Move a whole window | All fingers: pinch and hold, move, let go | |

Holding a pinch ticks on the wrist when it takes, and the ring around the cursor
fills in while the mouse button is down. You can let go on the move, but it's
surest with the arm still; if it's missed, the drag ends by itself once the arm
has been still for a moment. Two pinches and a move also picks something up, and
the next pinch puts it down. Stopping, losing the connection, typing or taking
the real mouse all let go of a drag.

How it works, and why:

- **Bluetooth, with the Mac as the peripheral.** A watch can only be a Bluetooth
  central (`CBPeripheralManager` isn't available on watchOS), and Apple keeps
  sockets and WebSockets on a watch for audio and calls (TN3135), so Wi-Fi is out
  and the Mac advertises instead. That needs a helper: `jester-watch-bridge`, in
  Swift, separate from `jester-driver` so that a Bluetooth problem can never take
  the mouse and keyboard down with it. It runs only while the switch is on,
  because its first run is what makes macOS ask about Bluetooth.
- **Nothing on the radio is believed unproven.** Anyone in range can connect to
  a Bluetooth service, and this one clicks. Pairing is a key exchange (X25519)
  with a number you compare, after the watch commits to its key; every motion
  frame is then signed (HMAC-SHA256) over a challenge fresh to the connection,
  with a counter that only rises. The key lives in the watch's Keychain and
  sealed on the Mac. See `Core/Wire.swift`.
- **A click can't be lost or doubled.** Frames can be dropped, so each carries a
  running count of clicks rather than a "clicked" flag.
- **Steering reads the arm, not the watch.** `Core/Steering.swift` uses gravity
  to turn the gyroscope's spin into a turn and a tilt, so how you hold your hand
  doesn't matter and rolling your wrist moves nothing.
- **Pinches are learned.** A tap is a sharp jolt in the acceleration, which is
  all there is to go on at 100 Hz, and how hard it is varies by person, so
  `Core/Pinch.swift` learns the threshold from yours. It is a heuristic, not a
  trained model like Doublepoint's: expect the odd miss, and tune it there. Its
  tests for a shake and a swinging arm mustn't catch a firm tap, which rings for
  longer and jolts the wrist, so they're judged on the tap's own peak and on what
  the arm was doing just before. To tune on real pinches, each Stop saves what the
  watch felt to `Documents/pinches.csv`, and Test pinch and hold saves raw motion to
  `Documents/lab.csv`. They stay on the watch until read with
  `xcrun devicectl device copy from --domain-type appDataContainer`.
  Double Tap (Series 9, Ultra 2 and later) also presses the Click button, but
  only with the screen on.
- **A click lands where you aimed.** Fingers coming together turn the wrist from
  well before they touch, and the watch only knows it was a pinch after they have,
  so a press goes where the cursor was 180 ms earlier, or 90 ms if it had come
  more than 40 px since, which is a hand travelling and not a pinch. Replaying
  `Tests/pinch-recording-fingers.csv` through the steering, that's 4 px off where
  20 pinches started, against 10 with 90 ms alone. None of those were aiming at
  anything, so it's worth checking against the `watch click` lines in the log.
  Letting go is felt the moment it happens, so a drop only looks back 40 ms. The
  cursor waits out the jolt before steering goes on. Aim assist reaches 16 px, for
  near misses: the watch aims well enough that any further would pull clicks onto
  things it wasn't pointed at.
- **A swipe isn't a swipe while you steer.** The camera sees the arm wearing the
  watch, and a scroll or a tab change would move what it's aiming at, so swipes
  are ignored until the arm has been still for 800 ms. Poses still count: ✌️ has
  to work, and 👍 answers the assistant.
- **Steadying has to add up.** `createSteady` is a 1€ filter on the turning
  rates: heavy near stillness, which takes out a hand's 8 to 12 Hz tremor, and out
  of the way at speed. Filtering rates keeps every deliberate turn. The trap is
  anything that treats a tremor's two halves differently, which turns shaking into
  a slow creep: its cutoff falls slowly, so it holds steady through a shake, and
  the gain follows how fast the hand is really going, not each frame's speed.
- **Which fingers.** All fingers and one look alike in strength, but differ in
  direction and twist in the first 100 ms. That only holds within a style of
  pinching: a recording told them apart 18 times in 20 taking turns, and little
  better than chance going from firm pinches to light ones, so `PinchKinds` is taught
  in one sitting and scored on pinches it hasn't seen. It's only ever consulted on
  a pinch that's held, so a click can't move a window. A window is carried with
  accessibility rather than a drag, by `windowAt` and `moveWindow`, Mac only.
- **A pinch is a real press.** Nothing can be felt while fingers stay together,
  but both ends can, which was found by recording a wrist: fingers parting after
  a quick pinch are a burst 120 to 200 ms later, where a held pinch is silent, and
  letting go of a hold is a jolt about as strong as the pinch. Mid-drag it's
  weaker and the arm makes jolts as big, but the arm's are broad humps and letting
  go is a spike standing clear of the moment before, so that's what's looked for:
  it catches about three in five mid-drag, on two recordings, so that's evidence
  and not a guarantee (`Tests/pinch-recording-moving.csv`). So `PinchDetector`
  says when fingers meet and part, and the Mac treats that just as it treats a
  finger on the watch's button: quick is a click, and held past 300 ms is the mouse
  button down at the spot aimed at. The recording is `Tests/pinch-recording.csv`,
  replayed by the tests, and the watch's Test pinch and hold makes another. Whatever
  ends steering lets go, and the driver lets go of anything still down when it exits.

`tests/desktop-watch.test.mjs` runs the pairing, frames, steering and pinch logic
(`Tests/main.swift`) and steers the real pointer code with a stand-in helper. No
test reaches a real radio or a real wrist; see check 5 below.

## Phase 0 results (MacBook Pro, Apple silicon, macOS 26)

| Question | Answer |
|---|---|
| Does the extension's engine run in Electron unchanged? | Yes. GPU delegate, 19–20 fps in a hidden window, ~3% CPU and ~660 MB across processes with the synthetic camera. A real camera still to measure. |
| Can speech run offline in the app? | Yes: Parakeet 110M (CC-BY-4.0) + Silero VAD in a utilityProcess. Loads in 0.5 s; text arrives a median 0.71 s after you stop talking (0.6 s of that is the end-of-speech pause). 37/44 synthetic commands exact; the misses are short words and brand names ("mute", "Spotify"). |
| Can the app move the cursor, click, type? | On the Mac, yes, all checked on real input: 9/9 clicks on target (~7 ms per request), Unicode text intact, ⌘A + Backspace, double-click, wheel scrolling under the cursor, and the accessibility tree naming a button and a field (once Chromium has built it, ~2 s after being asked). Windows: type-checks only. |
| Can the extension and the app talk? | Yes, through native messaging: 5 ms round trips, pushes both ways, a clear message when the app isn't running, and the open port keeps the extension's service worker alive. |

Model comparison (`node scripts/speech-bench.mjs <folder>`), 44 synthetic commands:
Parakeet 0.6B v2 41/44, WER 5.0%, decode median 67 ms, load 1.1 s;
Parakeet 110M 39/44, WER 7.1%; Kroko streaming 39/44, WER 7.3% (licence
CC-BY-SA, marketed for hobby use); Moonshine tiny 35/44, WER 14.8%. The small
models decode in under 35 ms.

## Checks that need you at the Mac

1. **Input**: `npm run dev:mac -- spikes/input-in-electron.mjs`. Allow
   "Electron" under Privacy & Security › Accessibility when asked; the check
   clicks only inside its own window and stops if anything else comes to the
   front. Results: the window, the terminal, `spikes/input-report.json`.
2. **Camera**: `npm run dev:mac`. Settings opens asking for the camera; click
   Allow…, and the engine starts. Raise an open palm, make a fist, try a few
   bound gestures: each shows under Activity › Last gesture and in the log.
3. **Hands** (the Atticus-style actions; the tests cover their logic, not real
   apps): with Spotify installed, say "play Gunna" — it should play with no
   model, and the log's `voice:` line shows the steps. "Put Notes on the
   left", "Notes on my monitor" (with one), "maximize Notes". With a model
   saved: "open a new note and write hello world" through the assistant (it
   may choose File › New Note), then say it again — the pill should say it's
   doing it the way that worked before. `JESTER_LOG_SCREENS=1` shows what the
   model read and what each step changed (without it, screen text in the log
   is masked as “…”). On Windows: the same, with Notepad
   (a classic menu bar) and the new Notepad (a UI Automation one).

4. **Sleep and the ×** (the tests script the hand and press the × from inside
   its page; these want a real camera and a real click): bind a gesture to
   Sleep / wake Jester in Settings › Gestures, in both sets if "Different
   gestures outside full screen" is on, and hold it. Jester says it's asleep,
   the menu bar shows Zz, and only that gesture does anything until it's made
   again after letting go. With a model saved, give the assistant a long job,
   click the × beside the pill, No, then × and Yes: the app it's working in
   should stay in front throughout, and the click should never reach that app.

5. **Apple Watch** (the tests have no radio, sensors or wrist): set it up as in
   [The Apple Watch](#the-apple-watch). Check that the watch finds the Mac; that
   the cursor keeps moving, smoothly, with your wrist down and the screen off;
   that a turn right is right and tipping up is up (if not, "Reverse up and
   down"); that a pinch clicks and ordinary movement, typing included, doesn't;
   and that Stop, the real mouse and sleep each take the cursor back.

## Things learned the hard way

- VS Code sets `ELECTRON_RUN_AS_NODE=1` for its terminals, and `open` passes it
  on: Electron then starts as plain Node. `scripts/start.mjs` and
  `scripts/dev-mac.mjs` clear it.
- Electron pages already have a `window.chrome`, so the shim attaches
  `runtime` and `storage` to it with `contextBridge.executeInMainWorld`.
- Electron forbids external buffers: sherpa-onnx needs `readWave(file, false)`
  and `vad.front(false)`.
- The voice-activity detector fires a syllable into the first word; decoding
  starts 1 s before it fired, or "lock the screen" becomes "the screen".
- This repository is in ~/Downloads, which macOS guards: an app launched with
  `open` must be allowed into Downloads (one prompt), and `open --stdout`
  can't write there at all.
- npm's Electron.app is ad-hoc signed; macOS ties the permissions it grants to
  that exact build, so they reset when Electron is upgraded.
- macOS's accessibility hit test (`AXUIElementCopyElementAtPosition` on the
  system-wide element) fails outright under an Electron window drawn over the
  display, click-through or not — Jester's own overlay. Other apps' overlays
  (Sapphire's full-screen window at layer 28) don't stop it. Asking an app
  element at a point returns the app itself, and `AXWindows` returned app
  elements for every app tried, so there is no way around it from the
  driver: Jester hides its overlays for the moment a click looks.
- Windows just shown are listed by the window server at 90% scale for a
  moment (an appearance animation): compare their bounds with care.
- Electron treats a page asking for full screen as a permission request:
  refuse it and the page's request never settles. The calibration screen
  waits on it, so Start did nothing until Jester's pages were allowed it.
- A page leaving full screen waits for the window to change size; if it
  never does (an unfocused window isn't allowed full screen), the page
  freezes. Electron's "simple" full screen never tells the page it has left
  at all. So the calibration window opens already in full screen, which
  makes the page's own requests instant, and a page's `window.close()` goes
  through the main process, which leaves full screen before closing — a
  window closed mid-animation is lost.
- Chromium and Electron apps have no accessibility tree until asked
  (`AXManualAccessibility`, or `AXEnhancedUserInterface` for Chrome-family
  browsers), and the tree takes about two seconds to appear. The app should
  `wake` each app as it comes to the front, not when it is pointed at.
- A scroll event takes the cursor position from when it was made, which can
  predate a move posted just before it; the driver sets it explicitly.
- ⌘A then Backspace failed with keys posted at the HID tap from a HID-state
  source and macOS's modifier bits overwritten. Posted at the session tap
  with no source, modifier bits set exactly (left-key device bits included)
  and 4 ms between keys, the page sees ⌘, ⌘A, Backspace and the field clears.
  The input check still tries other tap/source combinations if the first
  fails, and records what the page received.
- Chrome reads a throwaway profile's native-messaging hosts from
  `<user-data-dir>/NativeMessagingHosts`, so the link spike never touches your
  Chrome. A host manifest can't add arguments; the relay recognises the
  `chrome-extension://` origin Chrome passes instead.
- Electron has no on-device Web Speech recognizer, so the preload gives the
  engine page a `SpeechRecognition` of the same shape, and `voice.js` runs
  unchanged. A function passed through `contextBridge` twice needn't arrive
  as the same function, so it registers one listener and routes by session.
- `--use-file-for-fake-audio-capture` fails in Chromium's sandboxed audio
  process ("Failed to read … as input to the fake device"); the self-test
  runs audio in the browser process (`AudioServiceOutOfProcess` off).
- AppKit's list of running apps only updates while a main run loop turns, and
  jester-driver doesn't run one: it looks each process up instead
  (`proc_listallpids` + `runningApplicationWithProcessIdentifier`, 9 ms warm).
- "Volume 30" runs `set volume output volume 30 without output muted`: a
  muted Mac comes back at the level asked for.
- macOS slides a display-sized window down below the menu bar, so the
  overlay's bottom ~34 px are off screen: anything placed from its bottom
  edge must add that back. The overlay page measures it against
  `screen.availTop + availHeight`, which also keeps pills above the Dock.
- Commands a real mic got garbled ("Lake's part of five full screen") came
  out exactly right from synthetic speech ("Make Spotify full screen"), so
  the 44-command synthetic set ranks models but doesn't predict real use.
- That overlay effect reaches beyond hit tests and beyond one instance: with
  a running Jester's overlays up, a test copy's own `AXWindows` came back as
  its app element; with that Jester quit, the same read found its Settings
  window and 144 controls in 38 ms. So the assistant reads with overlays
  hidden, and `JESTER_SELFTEST_AGENT` needs no other Jester running.
- None of that reproduced on 2026-11-04 (macOS 26, Darwin 25.6): with Jester's
  real overlays up, reads and hit tests of a separate Electron app worked, with
  or without Jester's own tree switched on, and 40 of 40 reads of Calculator
  worked with the × and its question up. What changed isn't known, so the
  overlays still hide. The × stays up, at `pop-up-menu` level rather than the
  overlay's `screen-saver`, as the failures were only ever seen at that level.
  Should reads ever fail while a task runs, look there first.
- Electron holds `ready` until the entry module's top-level `await`s finish, so
  a test entry that imports `main.js` and then waits for the app at top level
  never starts: run the waiting in a detached async function.
- A Chromium window's page isn't in its tree at all until about a second
  after the app is first asked (not even as an empty web area), so the driver
  knows Chromium apps by the framework in their bundle (Electron, Chrome,
  Spotify's CEF) and waits for a web area with content.
- Apps that embed Chromium without Electron (Spotify's CEF) answer only
  `AXEnhancedUserInterface`, not Electron's `AXManualAccessibility`: without
  it, both models saw Spotify's window as next to empty and gave up; with it,
  a search for Gunna reads as 285 controls, each result's Play among them.
- Short labels need their place: Spotify's top result and its player bar both
  have a button named just "Play" (the second resumes whatever played last).
  The snapshot names the nearest named container for labels of three words or
  fewer: `[118] button "Play" — in "Gunna"`, `[82] button "Play" — in "Player
  controls"`. The goal ranks lines by whole words, so "play" no longer pulls
  in every "Playlist".
- driver.js sent `{ id, cmd, ...params }`: a command with its own `id` field
  took over the request's, so its reply never matched. The request's id now
  goes last, and `act` names its target `element`.
- sherpa-onnx hotwords (contextual biasing) don't work with this package:
  without the model's `bpe.vocab`, phrases must be written as the model's
  pieces, and sherpa-onnx splits a piece like `▁St` into `▁` + `St`, which
  aren't pieces; one bad phrase and it skips them all.
