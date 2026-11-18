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
The extension links to it (phase 5, [Chrome](#chrome-the-link)): one camera and
mic, the extension's gestures with Chrome in front, browser commands done in
Chrome, and clicks that land on the link aimed at. Phase 0's answers are below.

The menu's Gestures switch (`gesturesEnabled`, on unless set) closes the camera
and nothing else: voice, the continuous assistant, the watch and his window
carry on, and Cursor control, which is the camera's, greys out. The engine reports
off with "Gestures off"; it also wakes a sleeping Jester, as nothing could see ✌️.

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
| `src/main/windows.js`, `src/home/` | The engine's hidden window, and Jester's own: the orb and talking to him, his chats and Settings, in one window (`home.js`, `screens.js`, `chats.js`, `settings.js`, `orb.js`). |
| `src/main/os-actions.js`, `dispatch.js` | What each action does on each OS, and doing it through the driver. |
| `src/main/overlay.js`, `src/overlay/` | Click-through windows over every display: hold progress, toasts, the cursor ring, the voice pill. |
| `src/main/approval.js`, `stop-button.js`, `pill-math.js` | The small windows that do take clicks: the assistant's question, and the × beside the pill. |
| `src/main/pointer.js`, `pointer-math.js` | The real cursor: placing, easing, freezing the aim, clicking with aim assist. |
| `src/preload/chrome-shim.cjs`, `src/main/chrome-bridge.js` | The slice of `chrome.runtime` / `chrome.storage` the extension's pages use, over IPC. |
| `src/main/engine-host.js` | The service worker's half of the engine: settings, gestures, cursor, voice. |
| `src/main/protocol.js`, `files.js` | `jester://ext/…` serves the extension folder, `jester://app/…` this app's pages. |
| `src/main/speech.js`, `src/main/speech/` | Offline speech (sherpa-onnx) in a `utilityProcess`, fed by the engine page's stand-in `SpeechRecognition` (in the preload). |
| `src/main/voice-commands.js`, `voice-runner.js`, `apps.js` | What a sentence means, and doing it: actions, apps, volume, keys, typing, clicks, windows, Spotify, Shortcuts. |
| `src/main/learned.js` | What's taught ("when I say …") and learned (a task the assistant got done, kept to be done again without it, and words the conversation took to mean a command that worked). |
| `src/main/vault.js`, `vault-index.js`, `vault-memory.js` | Memory, in the user's Obsidian vault: its notes read and written (only in `Jester/` and `Notes/`), searched by words and meaning, and what's kept from a conversation and recalled for one. |
| `src/main/conversation-log.js`, `chat-archive.js`, `chat-keeper.js`, `recollections.js` | The conversation going on (`conversation.json`), each that's over word for word for a week (`chats.json`, the Chats panel), what's kept when (`chat-keeper.js`), and a sentence for each, kept a week. |
| `src/main/whereabouts.js`, `weather.js`, `calendars.js`, `situation.js`, `src/where/` | Where the user is (Location Services, or a place they name), the weather there (Open-Meteo), their calendars combined (iCal links, ical.js), and all three in lines for him each turn. |
| `src/worklets/` | The mic for speech, captured on the audio thread; served to the engine page as `jester://ext/_desktop/worklets/…`. |
| `src/main/assistant.js`, `src/main/agent/` | The assistant: the screen as the model reads it, and what a step changed (`screen.js`), its actions and how careful each is (`actions.js`), its prompt (`prompt.js`), the loop (`loop.js`), the hands (`host.js`), the numbers drawn on a picture of the window (`marks.js`) and learned tasks done again (`replay.js`). |
| `src/main/window-shot.js` | A picture of the window the assistant is working in, for a model that reads pictures. |
| `src/main/driver.js`, `native/jester-driver/` | Rust helper for OS input and the accessibility tree, JSON lines over stdio. Also Chrome's native-messaging relay. |
| `src/main/watch.js`, `watch-status.js`, `native/jester-watch/` | The Apple Watch: its app, the Mac's Swift Bluetooth helper, and steering the cursor with them (Mac only). |
| `src/main/link.js`, `link-host.js`, `chrome-link.js` | The link to the extension: the socket the relay reaches, putting the relay where Chrome can start it, and what's said over it. The extension's half is `../jester-extension/src/background/desktop-link.js`. |
| `src/main/mood.js` | How the user seems, from what they plainly say: told to the model, and how fast he speaks. |
| `src/main/clock.js` | His clock: things to do at a time, kept in `jobs.json`, and done on waking when they came due while the computer slept. |
| `src/main/presence.js` | Whether the user's at the computer (here, near, away), the day's first sit-down, and how long they've sat. |
| `src/main/ring.js`, `ring-page.js` | A timer's ringing, until it's turned off by a word, a gesture or a click; and the small pill that sounds it and has the Stop. |
| `src/main/tell.js` | Telling them something when its time comes: said if they're there, held until they're back if they aren't. |
| `src/main/briefs.js` | The morning brief, the evening wrap-up and a word before what's on the calendar: the day's facts, said by the model and checked against them, or said plainly. |
| `src/main/google.js` | Signing in with Google, to read their Gmail and nothing else: OAuth for an installed app, with their own client from Google's file. |
| `src/main/mail.js` | Their Gmail, watched: what's new in the inbox, what of it could matter, and what he says of it. |
| `src/main/setup.js` | Getting started: what a new user has to set up and what they can add, as one list with where each is done. |
| `src/main/phone.js` | Their phone, for what's told while they're away: a notification through ntfy, to a topic only they know the name of. |
| `src/main/tasks.js` | Their to-do list, reminders and timers: `tasks.json`, a clock job for each one with a time, and the rule that only they tick one off. |
| `src/home/cards.js` | Cards: a timer, a reminder, a task or a note as a thing to look at and act on, on his line in the chat, on the shelf over the orb, and in the Tasks screen. |
| `src/home/tasks.js` | The Tasks screen in his window: every timer, reminder and task as a card, by when it's for, and the notes he's made lately. |
| `src/main/model-jobs.js` | Which of the user's models talks and which acts (Settings › Models): paid before free, and who covers for one that fails. |
| `src/main/spend.js` | What the saved models' replies have cost this month, as near as their token counts say. |
| `scripts/live-check.mjs` | `npm run live-check`: the real app on a scratch profile with scripted model servers, typed to and read back. |
| `scripts/task-check.mjs` | `npm run task-check`: real tasks on this computer, typed to the real app one after another, with the real driver, the saved models and the linked Chrome. Acts for real. |
| `scripts/hear-check.mjs` | `npm run hear-check`: his own speech service on audio from files: a made-up voice learned from use, or (`kept`) what he wasn't sure of, scored against the real voiceprint. |
| `src/main/abilities.js` | What he can do, for his prompt: one entry per ability, a connector's listed as his when it's on and as not connected (with where in Settings) when it's off. |
| `scripts/talk-check.mjs` | `npm run talk-check`: how well a model talks as Jester, and how fast. |
| `scripts/speed-check.mjs` | `npm run speed-check`: how soon his voice starts after he hears you, with the real model and his real voice, against how it was. |
| `scripts/voice-check.mjs` | `npm run voice-check`: his real voice making the kinds of line he says: how soon the first sound is ready, and each read back by his own recognizer. `-- --play` to hear it, `-- --voice lewis` for another. |
| `src/main/kokoro.js` | His own voice from the main process's side: starts `voice/service.js` when there's a line to make, lets it go after three idle minutes. |
| `src/main/voice/` | `service.js`: Kokoro through sherpa-onnx, in a process of its own, a WAV per line. `voices.js`: the voices Settings offers, and the model's config. |
| `scripts/vault-eval.mjs` | How well memory finds things in a vault: a sample vault and the questions it's scored on. |
| `spikes/` | Phase 0 experiments, and `link-live.mjs`, the link end to end in a throwaway Chrome. |

Tests live with the extension's, in `../tests/desktop-*.test.mjs`, and run with
`npm test` from the repository root.

## Background web research

Web searches and informational research run before app discovery, browser
focus, or learned mouse/keyboard routines. Jester returns extracted evidence
with source addresses and retrieval times, and asks before browser or desktop
interaction if background reading cannot finish. Try “search the web for
Scrapling,” “look up the latest launch news,” or “look through my Canvas and
tell me what is due.” Research runs fresh each time rather than replaying a
previous search.

While a search is running, the desktop window shows **Searching the internet**
with live progress and a Stop button. Research answers attach source cards with
an **Open** button for each page. Up to three cards are shown directly; a longer
list starts inside a collapsed sources dropdown. Cards remain with the answer
when its chat is reopened. The visible desktop window keeps the research pill
and its floating stop control hidden, including while the window is unfocused
or showing Settings. Hiding or minimizing the window moves active search
feedback to the pill until the window returns.

A search without a target, such as “search something,” first asks what to
search for. The answer continues that request: typed, or said with his name
within two minutes, or without it within 20 seconds in a voice the voiceprint
knows (as for any question of his). It's cleared when cancelled.

What counts as a search: “search for…”, “look up…”, “research…”, “google…”,
Canvas or pages already open (“what's due on Canvas”, “summarize this page”),
and a link to read. Searching an app (“search YouTube for cats”), finding your
own things (“find my keys in Finder”), the weather and your calendar go where
they always went. Other live questions (“what's bitcoin at?”) reach it through
the talking model, as “search the web for…”. Open tabs, with their sign-ins,
are read only when your own words ask about Canvas or open pages; everything
else is read anonymously. Without the helper below set up or Chrome linked,
a search opens in the browser, as before. A model then
chooses a strategy and gives background scraping a confidence score from 0 to
100. At 70 or above, Jester can try background reading. Below 70, or when the
model recommends interaction, Jester asks before using browser or desktop
controls. The score appears in the search indicator and in low-confidence
confirmation questions. It estimates suitability for the task, rather than
guaranteeing the page will be readable; a failed read still asks before falling
back to controls.

Install the local public-web helper from the repository root:

```sh
npm --prefix desktop run scraping:setup -- --browser
```

Python 3.10+ is required. This creates `desktop/.scrapling/`, installs pinned
[Scrapling 0.5.1](https://github.com/D4Vinci/Scrapling/releases/tag/v0.5.1),
and downloads a project-local headless Chromium. Omit `--browser` for HTTP
extraction only. Set `JESTER_PYTHON` to choose the Python used for setup, or
`JESTER_SCRAPLING_PYTHON` to use an existing prepared Python environment at
runtime. Startup never installs packages. On Linux, rendering may also need
Chromium's operating-system dependencies installed separately.

The extension shares this helper over the existing native link. For signed-in
Canvas and other open sites, desktop research delegates reads to the extension
instead: cookies stay in Chrome. Link it through Settings › Chrome, grant
site access in the extension's Settings, and keep the relevant site open and
signed in. Current DOM snapshots and same-origin document requests do not
focus or navigate tabs. Jester asks before a login, navigation, or other
interaction is needed. Without the desktop app, the extension can still search
and read pages through its own background reader.

`web-research.js` in the extension is the shared bounded research loop.
`src/main/web-scraper.js` launches cancellable Python workers;
`scraping/worker.py` uses Scrapling for extraction/rendering and a checked
HTTP transport for public pages. Public requests validate and pin DNS, check
redirects, and block local/private networks. Browser sessions are isolated
from the user's profiles. The helper has no listening HTTP service, exports
no cookies, and accepts no code or shell commands from a model. Reads and
model calls are bounded; cancellation stops the worker and its browser.

Search currently uses DuckDuckGo's public HTML results, which can be blocked
or rate limited. Documents such as PDFs, image-only content, and interactive
app views may need the browser. Read content goes to the selected model as
untrusted evidence, and existing conversation retention applies to desktop
answers. The helper keeps no page cache or research log.

## Setup

Setting him up on another Mac, for someone who isn't going to read the rest of
this: [SETUP.md](SETUP.md).


```sh
cd desktop
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary on first use
npm run driver                           # needs Rust: https://rustup.rs
npm run models                           # hearing and voice models, ~510 MB, into models/
```

`npm run models` downloads what's too big for git, skipping anything already
there. Run it on every new checkout, and again after pulling a new model:

| Model | Size | What it's for |
|---|---|---|
| `vad` | 1 MB | Finds where speech starts and stops |
| `voice` | 40 MB | Tells the user's voice from anyone else's; without it, he listens to everyone |
| `parakeet-110m` | 130 MB | Turns speech into text |
| `kokoro` | 334 MB | His own voice (Kokoro v1.0); without it, he speaks with the computer's |

To add one that isn't in the default set, name it: `npm run models --
parakeet-0.6b` (the Accurate recognizer, ~650 MB) or `npm run models --
moonshine-tiny`.

Memory searches an Obsidian vault by meaning through Ollama's `nomic-embed-text`
(274 MB): `ollama pull nomic-embed-text`. Without it the vault is searched by
words alone (below, Memory and Obsidian).

## Running

- `npm run launcher` (macOS, once) — puts a **Jester** app in /Applications
  (or ~/Applications): double-click it, or open it from Launchpad, Spotlight,
  the Dock or Login Items. It starts the same Jester.app as `dev:mac` on this
  checkout — the current code, and the permissions already given to
  "Jester" — logging to `~/Library/Logs/Jester/dev.log`; with Jester
  running, it brings up his window.
- `npm start` — the app. Add `JESTER_LOG=1` to see gestures, cursor frames and CPU.
- `npm run dev:mac` — the same, launched through `open` so macOS asks for the
  camera and Accessibility on behalf of "Jester" rather than the terminal or
  VS Code. Output: `~/Library/Logs/Jester/dev.log`, echoed to the terminal.
- `npm run icons` — redraws his icon (`scripts/make-icons.mjs`: the art is
  code) into `icons/`: `jester.svg`, `jester.png`, `Jester.icns` for macOS and
  `Jester.ico` for Windows' window and taskbar.
- `npm run location` — builds his Location Services module
  (`native/jester-location`, with the Xcode command line tools' clang) if its
  source changed; `npm run app` and the launcher build it too.

**Jester.app.** On a Mac, all three run him in `app.noindex/Jester.app`, made
by `scripts/jester-app.mjs` (`npm run app` makes it on its own): npm's
Electron.app cloned (APFS clones, so no extra disk space) and renamed, so the
Dock, the menu bar, Activity Monitor, the permission prompts and System
Settings say **Jester**, with his icon, not "Electron". Its bundle ID is
`com.jester.desktop`; its helpers are "Jester Helper (Renderer)" and so on,
which Electron finds by the app's name; its prompts say what the camera,
microphone, Bluetooth and location are for. The executable inside keeps
Electron's name, because Electron sets `app.isPackaged` from it. Nothing is
re-signed: npm's Electron is ad-hoc signed by the linker and its Info.plist
isn't sealed. It's remade when Electron is upgraded or the icon changes,
except while it's running. Spotlight skips `.noindex` folders, so it doesn't
show up there beside the launcher. macOS ties permissions to the bundle ID, so
moving from Electron.app asked for them all again, for "Jester"; the old
"Electron" rows in System Settings can be removed.

The app lives in the menu bar. His window opens by itself, on the orb, while
Camera or Accessibility is missing, saying so, with Settings › Permissions a click
away (Set up); otherwise it opens from the menu. Closing it leaves Jester running. The engine only gets the camera once macOS has granted it, so
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

Two recognizers, chosen in Settings › Speech model: **Light** (Parakeet
110M) and **Accurate** (Parakeet TDT 0.6B v2, ~650 MB download: `npm run
models -- parakeet-0.6b`). Without a choice, Light is used if it's downloaded.
On the wake test's 7,920 recordings (twelve `say` voices, his name in 62
phrases, clean, quiet, noisy and in a room; 2026-11-07), Light heard "Jester"
78% of the time clean and 67% in the room, against Accurate's 82% and 71%, got
the request after it word for word 85% and 81% of the time against 88% and
80%, and fired on other people's sentences no more often. It does worse with
two British women's voices (45% against 65–68%) and as well or better with the
rest. Accurate holds 1.4–1.9 GB and loads in 1.1–1.5 s; Light holds
0.55–0.67 GB, loads in 0.4 s and decodes three to four times faster (16–93 ms
against 50–375 ms a sentence). Those are macOS's memory footprint, with the
voiceprint model loaded too, measured 2026-11-07 (the 800 MB given here before
was too low). Either loads when a command begins and is let go after 10 idle
minutes or when voice is switched off; the audio waits in the speech service's
queue while it loads, so nothing said is lost. The continuous assistant keeps
it loaded all the time.

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
ticked for Actions in Settings › Models: the user's own Gemini, Groq, OpenAI, Anthropic or
OpenAI-compatible key, saved through the extension's `credentials.js` and paced
through its model pool, as in Chrome. Keys are sealed on disk with the OS
keychain (macOS) or DPAPI (Windows) via `safeStorage`, and pages never see them
(`chrome-bridge.js` keeps `modelConnections` out of their storage).

Ollama is the free choice, and nothing leaves the computer: install it, `ollama
pull` a model, and pick "Ollama (on this computer)" with the model's name, no
key. Thinking is turned off for it (left on, it spends the whole output budget
and returns no reply), replies are held to the schema (plain JSON mode had half
the plans refused), the model stays loaded for 2 minutes after each request (see
below), and it gets 30 s where cloud models get 10, since a first request loads it
into memory. On an M4 Pro `qwen3.5:9b` planned in about 2 to 4 s, 13 s from cold;
`qwen3.5:2b` is quicker but chose the wrong app or step too often to use. Ollama
refuses extension origins, so Chrome's settings don't offer it.

### How it clicks

Taken from [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Vercel
Labs' accessibility-tree computer use), in `act` (mac.rs, win.rs, protocol.rs):

- A control that has left the screen since the snapshot (its row deleted, its
  sheet closed) is refused with "gone from the screen", never pressed or
  clicked where it was drawn: something else may be there now.
- `press` tries each accessibility way of clicking in turn, without the
  pointer: on macOS AXPress (on a row or cell, read back, as a table that isn't
  the key view takes the press and selects nothing), selecting it in its list
  (a row, a cell, or a label in one; never a button's row for the button), a
  child that is the same thing (only an unnamed one or one named as the
  element, so a row's Delete button is never pressed for it), AXConfirm; on
  Windows Invoke, Toggle, Select, Expand, then the control's MSAA default
  action (the only way to click some Win32 controls). agent-desktop also tries
  AXOpen for a click; here it is a double click's (`act open`), since Finder
  opens a file with it where a click only selects.
- Only when all of those refuse does the pointer click, at `act point`: the
  frame read now, scrolled into view, waited on until it stops moving, and
  hit-tested at its middle and its four quarters. A sheet, another window or
  another control on top of it means no click, and the model hears what's
  there; a hit test that can't tell (a web page answering for its contents)
  clicks the middle, as before. Double and right clicks and drags aim the same
  way.

### Pictures of the window

When the window's words aren't enough — an icon with no name, a goal about
how something looks, controls it can't tell apart — the model can ask for
`screenshot`, as the extension's `look`. The window is read again, the display
captured (`desktopCapturer`) and cut to the window, made no wider than 1280
pixels, and each control's own id drawn on it in a yellow box: the same ids as
its screen lines, so the model acts with what it saw. The picture goes with the
next model call only, then it's dropped; three a task at most. That fresh read
is the next step's screen, since the numbers are its.

It's offered only when it can work: the Mac allows Screen Recording (optional
in Settings › Permissions), "Pictures of the
window" is on in Settings › Assistant (the extension's `agentScreenshots`, so
Windows has a switch too), and a model ticked for actions reads pictures. That's
judged by name, as in the extension (Gemini, Claude, GPT-4o and later, Llama 4…),
except this computer's, where Ollama says (`qwen3.5` does). A picture goes only
to such a model: this computer's takes it when no saved one can. No picture is
taken while a password or card field is on screen, nor is macOS ever asked for
Screen Recording mid-task: without it, nothing is captured. Jester's own windows
over the window (the overlays, the ×, his own window) are seen through for the
moment it takes (`setOpacity(0)`), never hidden: hidden and shown again, his
window came back in front of the app being worked on, and every step after the
picture failed as "Calculator isn't in front any more" (2026-11-14).

macOS lists an app under Screen Recording only once it has asked to see the
screen, and Electron reads the status as granted or denied, never "not asked".
So until Jester asks, the row says "Not allowed yet", and its Allow… takes a
one-pixel look at the screen: macOS's prompt comes up and Jester joins the
list. After that the button opens the list. Once allowed, macOS wants Jester
restarted; run from source, restart it yourself: "Quit & Reopen" reopens
Jester.app without Jester's folder, which should start plain Electron's
default app (not yet seen).

`JESTER_LOG_SCREENS=1` keeps the last picture beside the logs as
`last-picture.jpg` (~/Library/Logs/Jester on a Mac), to see what the model saw.

### Models: talking and actions

Settings › Models gives each saved model two boxes, Talking and Actions, and
`model-jobs.js` keeps a job to the models ticked for it, paid ones first and then
free ones, each in the order saved (the settings' `paidModelsFirst: false` is the
order saved alone), so
one model can talk and another act without using up each other's free requests
(Gemini's free plan allows a few hundred requests a day, and a chatty evening
would leave none for the tasks). A model saved before this was a choice acts and
doesn't talk; a new one acts, and talks only if ticked, since talking sends what
the user says to its provider. Changing the boxes needs no key typed again
(`setConnectionUses` in `credentials.js`).

This computer's model (Ollama, the model picked in its row) has the same two
boxes, both ticked to start with, and takes a job only when no saved model can:
none is ticked for it, or every one is out of requests for longer than the pool
will wait (`all_models_rate_limited`). It isn't simply last in line: the pool
skips a model that's waiting out a free plan's minute, and the next in line would
then be 7.6 GB of local model loaded to save three seconds.

A saved model that fails is covered for by the next one ticked for the job, and
after them by this computer's (2026-11-13: Groq's gpt-oss-120b answered a turn
with a 400, "Failed to generate JSON", which Jester said aloud). The pool names
the connection a failure came from and leaves out the ones a caller has seen
fail (`skip`); `model-jobs.js` asks again without it. One that's down (too slow,
a 5xx, no network) is left alone for a minute, and one out of credit (Anthropic's
402, or its 400 "credit balance is too low") for an hour, with a toast saying
who's taken over, so later turns don't wait on it again. A refused key (401,
403) or a model that isn't there (404) is the user's to see, since only Settings
puts it right. So is a turn they've moved on from.

Claude is asked as its current models want (2026-11-14, `model-client.js`): the
system prompt as a cached block, read back at a tenth of the price for five
minutes (512 tokens is the least the 5 generation caches; his prompt is about
1,800), and a reply held to its schema with `output_config.format` (his own
spoken reply aside: see how soon he starts to answer, below) when the
schema is one Claude takes as it stands (`claudeTakesSchema`: his reply's is;
the agents' have `minimum` and `maxItems`, so they're asked for in words, as
before). `spend.js` adds up what each saved model's replies cost, by their own
token counts at the listed price, and Settings › Models shows it by the model:
an estimate, for a month. On Claude Haiku 5.5 the whole of talk-check, 171
turns, came to about a cent, 163 right, a median turn of 1.0 s.

How soon he starts to answer (2026-11-14). Measured on Haiku 5.5 with his real
prompt, a spoken turn's time went: 0.6 s for the pause that ends an utterance,
about 0.9 s before Claude's first word and 1.3 s to its last, and 0.4 s for
the voice he had then (a hosted one, Puter's, whatever the line's length; his
own voice since 2026-11-15 takes 0.3–0.45 s for a first sentence: His voice,
below). Three things changed:

- His reply isn't held to its schema when it's Claude talking (`plain`,
  model-client.js). The schema cost half a second before the first word: 0.37 s
  without it against 0.9–1.2 s with. The prompt already spells the reply out;
  across talk-check's 201 turns asked this way none came back as anything but
  JSON (197 right), and one that does is asked for once more, held to it. The
  agents' replies are still held: they're bigger, and a step isn't waited on
  by someone listening.
- The reply is read as it's written (`onText`: server-sent events from Claude
  and from Ollama; Groq's JSON mode sends everything at once either way, so
  it's asked as before), and he starts on his first sentence while the rest
  comes (`firstSaid`, `sayAhead` in conversation.js). The rest's sound is
  fetched while the first sentence plays, and the whole line goes in the
  conversation as one. He waits for the whole reply as before when it was
  typed, when a note or remembering was asked for (what he says is then how
  that went), and when the sentence says a note was made (`NOTE_CLAIM`: one
  nobody asked for isn't made, and then isn't claimed).
- Hearing his name, opening the mic or typing to him loads the model that
  searches the notes by meaning (`warmUp`, main.js). Nothing did before: Ollama
  drops it after ten idle minutes, and the first question after that waited up
  to 1.2 s for it or was searched by words alone.

- At a pause that may be the end of what's being said, he starts on his reply
  (2026-11-15). An utterance is over after 0.6 s of quiet, and that can't simply
  be shorter: of 91 real utterances kept on the user's Mac, a 0.45 s pause came
  mid-sentence in a fifth to a third. So a second detector calls a pause at
  0.3 s (`EARLY_SILENCE_S`, speech/service.js): whose voice it is and what it
  said are read then and sent as `early`, and the conversation begins the reply
  (`paused` → `think`, conversation.js) without saying, showing, keeping or
  doing anything. When the quiet lasts, the utterance is `heard` with that same
  reading (nothing is read twice, so it arrives at 0.6 s where it was 0.7–0.8),
  and the turn carries on from the reply already under way. If they go on
  talking (`resumed`), or the words turn out different, it's called off and
  asked afresh. A command is never begun on. It happens only when the model
  first in line for talking is a paid one (`thinkAhead`, main.js): a request
  thrown away costs a few thousandths of a cent there, where a free plan counts
  it against its minute and a model on this computer does one thing at a time.
  `npm run hear-check -- pauses` says a sentence to the real speech service at
  its own speed: read 0.36 s after its last word, heard at 0.60 s; and one with
  a 0.45 s pause in it, read, resumed, and heard whole once.

`npm run speed-check -- --spoken` says each line aloud (macOS `say`, into the
real speech service at the speed it's said) and times from the last word to the
first sound of his voice, through the real model: on Haiku 5.5 a median 1.04 s
thinking ahead and 1.37 s without, sooner in 6 lines of 6. That was with the
hosted voice, whose allowance ran out around that run, so its part of those
times isn't certain (a fetched line took 0.35–0.45 s that night, a refusal
0.1–0.2 s); the run before it, with that voice answering, had him at 1.1–1.35 s
thinking ahead on the lines whose reply wasn't slow. Before any of this it was
about 2.4 s (0.7 s to hear and read it, then 1.7 s).

With his own voice (Kokoro, 2026-11-15, three runs): a median 1.33–1.50 s
thinking ahead and 1.71–1.78 s without, sooner in 18 lines of 18. From his first
sentence being written to its sound took 0.32–0.45 s on five lines of six; the
sixth, a long opening sentence, took 0.85–0.9 s made whole, which is why an
opening sentence over 60 characters is now made in two (`spokenPieces`). The
runs differ from each other by as much as the voices do: Claude's first word
moves by 0.2 s from one run to the next.

`npm run speed-check` says each line both ways, with the saved model and his
real voice (made, not played; the hosted one, when these were measured): on Haiku 5.5 his voice started a median 1.0 s
after he heard the words, where it had been 1.7 s, and the slow turns of 2–3.5 s
went. On qwen3.5:9b, 0.7 s where it was 0.9 s. It starts from the words being
heard, so the head start from a pause comes on top. Every spoken turn now writes
a line to the log saying where its time went: `turn: heard 603 ms after the last
word · thinking since 240 ms before that · knew what he knows at 0 ms · first
sentence at 334 ms · reply at 538 ms · speaking at 623 ms`.

Talking through a cloud model needed the conversation's earlier turns sent to
every provider, not only the OpenAI-compatible ones: `model-client.js` now gives
them to Anthropic, Gemini and OpenAI's Responses API too, alternating and starting
with the user, as those want, with an unanswered turn of the user's folded into the
new one. The pool's token estimate counts them. A reply gets 600 tokens (300
before): Gemini's thinking counts against it, though a reply is a sentence or two.

`npm run talk-check` puts nineteen things people say to him (a joke, "what's
15 percent of 80", "open my Canvas bookmark and tell me what's due") to each
model ticked for talking and this computer's, three times each, with the app's
own prompt and request, and says how often it handed over a command when it
should have and only then, and how long a turn took. Thirteen more check his
memory and notes: "remember that" keeping the user's words, notes made by him
rather than handed to the laptop, answers from what was recalled (or saying it
doesn't know), and a saved web page's instructions going undone; what's recalled
is built by vault-memory.js's own recall(). Keys stay sealed: it runs as
Jester in Electron, so macOS may ask to let it use "Jester Safe Storage", and it
never prints them. `-- ollama:qwen3.5:9b` checks one local model; `-- saved-all`
every saved one, ticked or not. On qwen3.5:2b (2026-11-07, one try each): 16 of 19,
a median turn of 0.4 s. `-- saved:anthropic` checks the saved models of one
provider, and each saved model's run ends with its tokens (how many were read
from the cache) and what it cost. `-- --only facts` runs nineteen on never
assuming and on what he can do (2026-11-13): a class in last week's
conversations kept there rather than made one starting now, "what can you do?",
and "can you…?" with connectors on and off. On qwen3.5:9b, two tries each: the
class kept in the past 6 of 6; booking a flight or ordering food 4 of 4 once
told the laptop can, short of the card number (0 of 4 before).

#### What's remembered goes stale

The class that wasn't (2026-11-13) came from a sentence kept the afternoon
before: "Provided current weather, time, and advised attending the upcoming
class." It reached the model as "- Thursday at 2:18 PM: …", and "Thursday" reads
as well for the one coming. Three things changed (2026-11-14):

- a conversation is summed up in the past tense, with when a thing was by its
  date or its time on the clock, never "upcoming", "soon" or "tomorrow"
  (`vault-memory.js` `endedPrompt`);
- what's recalled says how old it is: "- Yesterday (Thursday) at 2:18 PM: …" for
  an earlier conversation, "Conversation on Monday, November 9 (4 days ago)" for
  one from the vault (`ago`);
- his prompt has him check a date against the day before calling anything
  upcoming. Without that line Claude Haiku 5.5, given a note's "Midterm on
  Friday, November 13" on Saturday the 14th, said it was "coming up on Friday",
  2 times in 3; with it, 0 in 12.

Not knowing who or what is meant ("text him…", "open it"), he asks one short
question rather than guess (the user's choice); a request that's only loose
("play some music") is handed over as it is. Told only to ask when he can't tell
what's wanted, Claude asked "what are you in the mood for?" 3 times in 3.
Claude Haiku 5.5 over all 65 cases, three tries each: 189 of 195 before that
last change, and 33 of 33 on the ones it touched after.

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

He looks up at his name before the sentence is over. One second and two seconds
into speech, `service.js` decodes what's been said so far (after the voiceprint
check, as for the rest), and `wakesEarly` sends `wake`, never the words, when it
opens with his name. The pill or orb turns to listening then: on a synthetic
"Jester, what time is it in Tokyo…", 1.3 s after speech began and 3.2 s before the
whole sentence was decoded. The finished utterance still decides; if it wasn't for
him after all, the listening face goes.

What was said to him (`conversation.js`) goes to the matcher if it's a known
command, and otherwise to the model he talks through (above: this computer's
Ollama model unless a saved one is ticked for Talking), which answers and can
hand back a command. Results are said aloud. Ollama is told to keep the model
for 2 minutes after its last use (`LOCAL_KEEP_ALIVE`), not the 30 the extension
asks for: the 9B is 7.7 GB of wired memory, which on a 24 GB Mac already in swap
made everything else crawl while he talked and long after. Commands that could do harm ask
first when overheard (`asksFirst`, fail closed: anything not listed asks), since
anything saying his name can reach them; tasks ask for themselves.

The model's command is never the whole task. On qwen3.5:9b (2026-11-07), "open up
my canvas and tell me what assignments I have due by tomorrow night" came back as
`open`, as a made-up `https://canvas.instructure.com`, as "open Canvas" with the
question gone, or as a refusal ("I can't read your browser tabs"), and an example
in the prompt that looked like the request was copied word for word. The prompt now
says the laptop reads its own screen, so such a request is a command (talk or
command told apart in 48 of 51 tries over 17 cases, against 41 of 51; every Canvas,
bookmark and email request in all 3 tries), and the assistant gets the user's own words as the
goal, with the model's command beside it as `meant` for what they leave out ("yes,
go ahead"). A task is learned only when the two have the same words, and never one
that asks to be told something ("…and tell me what's due"): a replay would do the
clicking and say nothing. `qwen3.5:2b` was no use for this: it made up an assignment.

The clock is on the user's line (`stamped`), not in the prompt: Ollama reuses what
it read of a prompt that starts the same as the last, and a time near the top
changed it every minute, so each turn read 500 tokens again (2.3 s; now 0.6 s once
it's warm). A conversation that's over is summed up after the reply, not beside it,
since Ollama answers one request at a time. Typing in his window loads the model
(`warmOllama`): cold, the 9B took 10 to 13 s on a 24 GB Mac with 3 GB free and no
swap left, about as long as typing a sentence. Saying his name doesn't load it,
since a command the matcher knows would then load 7.6 GB for nothing.

You can talk over him while the continuous microphone is on: he stops speaking
and listens to the rest without needing his name again. That takes Your voice:
a voice the voiceprint is sure of can recognize an interruption before its
transcript is ready (a check every 0.45 s of the last 1.2 s while he talks).
Without a voiceprint only "stop" cuts him off, as before: his own voice comes
back through the speakers garbled past any echo check, and so does a
television's. Echo cancellation is on for the continuous microphone; noise
suppression and automatic gain stay off.

The current microphone utterance is retained, including its opening words, when
playback stops. Old streamed replies and prefetched speech are cancelled so they
cannot resume behind the interruption. Unverified playback echoes, including a
short “yes” from his own approval question, are screened before they can become
another turn or an approval. A verified interruption or a screened correction
can repeat words from the reply; it is not discarded for doing so. Mixed audio
from an interruption is never used to update the user's voiceprint.

Teaching him a voice (Settings › Assistant › Your voice) keeps everyone else out
at the door. Five sentences make a voiceprint (`voiceprint.js`, sealed with the API
keys), and `service.js` compares each utterance to it before decoding it, in about
8 ms, so nothing anyone else says becomes text at all. TitaNet small was chosen on
twelve synthetic voices: same voice 0.75-0.9, others 0.2, 2-3% equal error on clips
up to 1.6 s and 5% on longer ones, against 21% for CAM++ and 6% for ResNet34.
Through a MacBook's own mic (dev.log, 2026-11-11 to 13) the real user scored
0.42-0.74 and the rest of the room (videos, other people) -0.14-0.24, with a 0.31
and one 0.40 over 20 s; the first bar of 0.6 left him deaf to them for a night at
0.42-0.51. Now 0.5 (0.4 under 0.9 s) is the user (`MATCH`), and 0.35-0.5 is maybe
the user (`MAYBE`): decoded, but taken only when it starts with his name, and never
as a yes to his question or a follow-up without it. Below 0.35 isn't decoded.
Every score is still logged ("your voice", "maybe your voice", "not your voice").
Only with a voiceprint does he take what's said after an answer without his name;
his name alone opens the next 8 seconds either way.

Those 8 seconds (20 after a question) are time to **start** answering. Once speech
begins inside the window, he keeps listening until the speaker goes quiet, even
if the response and its transcription take longer. The listening pill stays up
throughout. An utterance ends on a pause, or at a minute: a television or
music the detector takes for a voice would otherwise make one that never ends,
held in memory and decoded whole. The voice detectors refresh during ongoing
speech so their own 20-second limit can't shorten the pause they allow. Gesture
and shortcut command capture keeps its separate 30-second limit.

The voiceprint is five lines read once, up close. Said from across the room,
about half of what the user says lands in "maybe" (dev.log, 2026-11-14: 36 heard
as theirs, 38 as maybe, and 45 more just under 0.35, turned away undecoded), so
he wanted his name again mid-conversation. Since then he learns how they sound
from use: a voice heard as theirs, in something he took as said to him, is kept
as one more reference (`voiceLearned`, sealed, the newest 8), and a voice scores
as the best of them. One counts only for a voice the voiceprint already
half-knows (0.4, `LEARN_GATE`), and only such a voice is kept, so what's learned
can't wander off to someone else. Teaching the voice again, or forgetting it,
starts that over. `npm run hear-check` runs his own speech service on a made-up
voice (macOS `say`, a room added in code): taught up close and heard across the
room, it was theirs 2 times in 6 before and 6 in 6 after learning two ways of
sounding, and another voice was turned away 6 in 6. That says the pipeline does
what the rule says, not what a real voice's numbers will be.

For those: Settings › Assistant and voice › Keep what he wasn't sure of (off
until chosen) keeps the sound of a voice that scored at least 0.2 without being
taken as theirs, the newest 200, in the app's `heard` folder, each with its
score. `npm run hear-check -- kept` scores them against the real voiceprint and
decodes them, marking the ones with his name in them: those are most likely the
user, and how they scored is what the thresholds should be set by. Run on the
first day's 91 (2026-11-15), none had his name in it: they were other talk near
the laptop, 45 of it only maybe theirs, so nothing said to him had been turned
away and the thresholds stayed where they were. What he
hears, once he takes it, is already right: every spoken line in a week of chats
read as it was said, so no second recognizer was added.

Push-to-talk needs neither his name nor a known voice: the ☝️ gesture (while
Gestures is on), and the Talk button on the watch's steering screen, which sends
one bit that turns over at each tap (`Wire.swift`, signed with the frame, so a
lost frame doesn't lose it and nobody can forge it). A watch that hasn't been
reloaded since has no Talk button and changes nothing.

`conversation.json` in the app's data folder holds what was said to him and what
he said, for the model's context, and is emptied every hour. Each conversation
that's over is kept word for word for a week in `chats.json`, for the Chats panel
(below), not for the model. What's overheard isn't kept.

Conversations are told apart: one ends after 5 minutes of quiet, or when the model
says a new subject has begun (`new` in its reply), but never while a task he handed
on is at work or its result is being said (`acting`, the log's `busy`). What's over
stops being sent as the conversation so far, is summed up by one model call, and
`recollections.js` keeps that as a sentence for a week; with a vault chosen, the same
call keeps it there too (Memory and Obsidian, below). One left from the last run is
summed up once the vault is open. Up to six of those sentences,
the ones sharing words with what's being said and then the latest, reach the model
marked as over and separate, to use only if they matter.

#### His window

`src/home/` is the only window Jester has: Menu bar › Talk to Jester opens it on
the orb, Settings… on Settings, and Allow… on Settings › Permissions. The Dock or
a second launch brings it forward as it is, on whatever screen it's on, minimized or
not (`reopenHome`; back on the orb from minimized, the orb's intro plays), or opens it
on the orb when it isn't open. It's one strip of screens (`screens.js`): a chat,
Chats, the orb, Settings, then Settings' pages. Going between them slides the new
one in from the side it's on and pushes the old one out the other way, so Chats
comes in from the left, where its button is, and Settings from the right, and back
slides it all the other way (‹ or ›, Esc, ⌘[; ⌘, opens Settings). Mid-slide,
nothing takes a click. The window says which screen it shows (`jester/home-screen`).
The palette is the tokens atop `home.css`: Nightshade, dark only, with the quietest
words (`--faint`) still 4.6:1 against every ground.

Opened where it wasn't on screen, it starts as a dot of light that the orb spreads
out of (`orb.intro`, 1.8 s), and the rest comes in after. It waits for main's
`jester/home-shown`, sent once the window is shown, so its first frames aren't
spent on a window nobody can see yet: Electron says `visibilityState` is `visible`
even for a window never shown, so the page can't tell for itself. Shown before its
page was listening, the page hears so in the answer to its first `jester/home-screen`.
Not when coming back from Chats or Settings, and not with motion reduced. While
another screen covers it, the orb draws nothing (`orb.pause`).

The orb's screen draws from the same frames as the pill, so the two can't disagree;
while it's in front and showing the orb, the conversation's frames go only to it,
and the pill is left to the assistant's tasks (with the × beside it). In front, not
merely visible: Electron can't tell a window covered by other apps' from one that's
seen, so behind them the pill shows the conversation as well. What a
task did is then said in his window, never on the pill, so the conversation going
on with no task at work ends the task's pill (`TASK_OVER`); before that, its last
step stayed up for 90 s. On another of the window's screens, the pill shows the
conversation as it would with the window closed. Under the orb is the chat going
on, from the log (`jester/chat`, sent to this window alone as it changes): once a
chat starts, the orb glides up and shrinks, and when it's over the orb settles back
and says the chat is in Chats now. Along the top: Chats, a light for whose voice
he's listening for (a click opens its settings), and Settings. Along the bottom:
Gestures, Sleep or Wake, the box to type to him (a typed command is on purpose, so
it doesn't ask first, unless the model handed it back after reading the user's
notes: Memory and Obsidian, below), and listening on or off. A needed permission
that isn't allowed shows over the orb, a click from Settings › Permissions.

Typed to, he writes back (`told(text, { typed: true })`): nothing is spoken, and
the mic isn't held open for more. Written, a reply keeps every character (`writtenLine`,
not the speech filter's cuts); on the pill it's cut short, and one that went wrong
shows as such. A question the assistant asks about a typed command is written too,
mic or no mic (`conversation.typing`); a command said with the shortcut makes them
spoken again (`spoke()`). Only a whole yes or no typed answers it, its punctuation
aside ("Yes, please." and "Don’t" do; "ok, what's it sending?" is asked again,
`assistant.reask`), and a typed "stop" (or "shut up") stops a task. Listening switched
off doesn't cut a typed turn short, and a typed task's result is written even when
something's been said since; a conversation that's over (Forget it all, another chat
picked up) gets nothing more, and Forget it all ends his "Thinking…" too. Spoken to,
he speaks, as before. What a command said aloud outside the conversation did (the
shortcut, with listening off: `command` on its answer) is said under the orb, or at
the end of a chat going on, for a moment.

Chats (`chat-archive.js`, `chats.json`; `chat-keeper.js` decides what's kept when):
every conversation that's over is in Chats the moment it is, word for word for a
week (swept every minute), with a line that looks like a password, card number or
key kept as only that it held one, and so is the user's next short line after one
that hands a secret over and stops ("my PIN is", then "4821"; "wifi password:"), or
after his asking for one ("What's the wifi password?"); a question of the user's
("how do I reset my password?") or a secret named in passing ("my car keys") hides
nothing after it, nor does a line already left out. It's titled by its sentence from
`recollections.js` once that's written, after he's answered; deleted or forgotten
meanwhile, the sentence goes too, and nothing goes to the vault. One can be read,
deleted (two clicks, the second not within half a second of the first; he forgets
its sentence too, but what's already in the vault stays), or picked up: `restore`
makes it the conversation going on again, its lines marked `earlier` (a left-out
line stays left out), with its quiet counted from then, so it isn't over before
anything's said, and the model can't split it off as a new subject before the user's
said a second thing; its own sentence isn't offered to the model as a conversation
that's over. Nor is any conversation split when something came after the user's line
while he thought (a typed task's late result): the split would carry the wrong line. Not while he's working on something the conversation going on asked
for, or waiting on a yes or no: that would land in the wrong chat. Over again, it
takes its own place among the chats, and its sentence is written afresh from all of
it, each earlier day named for the model; in the vault it's a section of its own,
at the time it was picked up, marked "(continued)". Picked up and left alone, it
keeps its place and its week, and nothing is summed up. Settings › Assistant ›
Forget it all clears the chats with everything else, and drops what he was answering.

Settings is a list of pages (`settings.js`). Every control kept the id it had in
the Settings window this replaced, so the self-test still finds them; it goes to
each page with `window.jesterHome.go`. The camera view is asked for only while
Activity is showing.

The orb is [thinking-orbs](https://www.npmjs.com/package/thinking-orbs) 0.3.2 (MIT):
only its React-free engine, vendored in `src/vendor/thinking-orbs/`, drawn by
`src/home/orb.js`. Resting is `breathing`, listening `listening`, thinking `working`,
speaking `composing`, tinted `--orb`. Each frame is one to two thousand dots, each
its own fill, so it's drawn 30 times a second, not at a 120 Hz display's rate,
which kept the GPU process and window server busy. The pill shows a 32 px one with a word
beside it: "Listening…" from the moment he hears his name (a `hold` frame, with no
mic levels for the bars), "Thinking…", and "Speaking…"; a task shows its caption
beside the thinking orb, where the spinner was. Listening for a spoken command
(the shortcut or a gesture) keeps the bars, which follow the mic. To update it, copy the new package's `dist/index-*.js`
chunk over `engine.js`; `orb.js` imports its short export names.

#### His voice

His voice is his own, made on this computer: Kokoro v1.0 (82 M parameters,
Apache-2.0) through sherpa-onnx, the library that hears for him. Nothing he says
is sent anywhere, and there's no account and no allowance. Until 2026-11-15 it
was a hosted voice (Puter) with a free monthly allowance of about 31,000
characters, which a night of timing runs used up; that's why it's gone.

- `voice/service.js` runs the model in a utilityProcess, so making a line stalls
  neither the main process nor the one that listens. `kokoro.js` starts it when
  his name is heard (warmUp) or there's a line to make, and lets it go after
  three idle minutes: it holds about 1 GB loaded and takes 0.4–0.7 s to load.
- `speaker.js` gives it a line a piece at a time (`spokenPieces`): each sentence,
  and an opening sentence over 60 characters as two, cut at a comma or, with
  none, before a joining word ("by", "because", "which"), with the quiet trimmed
  so it runs on. Each piece is made while the one before plays. Kokoro takes
  about 110 ms plus 7 ms a character on an M4 Pro, eight threads (two threads:
  2.5 times that; Core ML was slower than four), so a whole long sentence would
  be most of a second before any sound.
- `forEar` first puts what's written for the eye the way it's said: Kokoro reads
  signs literally ("$12.50" was "dollar twelve point five zero", "Nov 15" "Nove
  fifteenth", "7-9 PM" "seven dash nine"). What's shown on screen is untouched.
- Without the model (`npm run models -- kokoro`), when the service won't start
  (twice running: left alone for ten minutes), or when a piece fails, the
  computer's own voice says it (`say`, Daniel; PowerShell's on Windows): he is
  never silent.
- Settings › Assistant and voice › Jester's voice picks one of ten of the model's
  54 voices (`voices.js`; George, British, by default) and plays a line in it. A
  British voice reads from the British pronunciation list and an American from
  the American, so changing accent reloads the model.

`npm run voice-check` makes ten kinds of line with the real model and has his own
recognizer read each back: on 2026-11-15 all ten came back with their words, the
first sound ready in a median 0.36 s (0.16 s for "Done.", 0.57 s the slowest).
Whether he sounds pleasant only an ear can say: `npm run voice-check -- --play`.

### Tasks on the real computer

`npm run task-check` types a list of tasks to the real app and says how each
went: the real driver, the user's own saved models, their linked Chrome, on a
scratch profile so none of it lands in their chats or their vault. It acts for
real (apps open, music plays), so it's for when nobody else is at the computer,
with Jester quit: one Jester holds the link to Chrome. `-- --act
claude-sonnet-5-5` moves actions to another model of the saved Claude key.

The first run (2026-11-14, Claude Haiku 5.5) got 2 of 7 done, and none of what
stopped the rest was the model:

- A picture of the window put Jester's own window back in front (above).
- "Play the latest MrBeast video on YouTube" is all words voice-commands.js
  knows, so it never reached the linked Chrome: a search was opened and picking
  a result left to the laptop's assistant, which took 24 steps in Chrome's
  window and played nothing (2026-11-15). Something to play on YouTube is now
  Chrome's when it's linked (`tube`, voice-runner.js): the same sentence played
  the right video in 6 s, and three more like it in 10–13 s each.
- macOS's own dialog in front (a permission asked for, an alert) left every step
  failing as "not in front" for a minute. Now it ends the task at once and says
  so: "macOS is asking you something in a dialog of its own… answer it, then
  say keep going" (`host.js` `systemDialog`).
- "Open TextEdit, make a new document and type…" was matched as opening an app
  called "TextEdit make a new document": TextEdit opened, the rest was dropped,
  and it was said to be done. An app's name with more to do after it is now the
  assistant's (`voice-commands.js` `POLITE_TAIL`). "Write down milk" typed
  "down milk".
- With System Settings in front, everything asked first, "Open Calculator?"
  included, and reading which Wi-Fi it's on needed a yes to 'Click "Wi-Fi"?'.
  Getting around the settings (a sidebar row, a tab, a link, a scroll, its
  search) and what's done elsewhere no longer ask; a switch, a button, a popup
  or a field there still does (`actions.js` `findsItsWay`).
- A step had 6 model calls and a run 16. Calculator's eight presses for 15% of
  80 used a step's up with the sum done, and the new plan's one bad field ended
  the task: now 10 and 24, and a new plan that can't be used is told why, once.

After: 6 of 7, then all of them. The Wi-Fi's name in 7.5 s, a new TextEdit
document typed in, Finder's count of Downloads (441; `ls` says 442), Spotify
played and paused, the PSU Canvas bookmark opened and the dashboard read
through the linked Chrome. Claude Sonnet 5.5 for actions did the same tasks in
fewer steps (Finder: 7.5 s against 30.6 s) and no more of them.

Still wrong, in the extension (0.2.2, the Web Store's): "open YouTube and play
a funny video" opens the video and then says a control isn't responding, and
the dashboard's items of twelve days ago were read out as due "this week": its
model isn't told the date.

"Keep going" and "try again" are the task that just failed, again, for five
minutes (`voice-runner.js` `AGAIN`), with no talking model in between: on
2026-11-13 that model made a new command of "keep going", and the time after
answered with assignments nothing had read. Chrome's "No open tab matches…"
isn't done, though 0.2.2 says it is. A task asked for its answer ("work out",
"count", "convert") isn't kept to be done again without a model.

Claude is held to the planner's and the desktop agent's reply schemas
(`claudeSchema`, model-client.js): the limits it refuses are left out, and a
reply that's one of two shapes becomes one object. Its API takes 24 optional
fields at most; the browser agent's schema has 40 and is still asked for in
words.

### Planning and doing a command

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

## Memory and Obsidian

Settings › Memory picks an Obsidian vault: one Obsidian knows is offered (the
one it has open first), or Choose… takes any folder: the one holding `.obsidian`,
or a folder above it with one vault in it, which is saved as that vault, so a
second put beside it later doesn't move his memory. Jester reads all of it, to
answer from, including folders linked into it, and writes in two folders only:
`Jester/`, as it needs, and `Notes/`, when asked (a lowercase `jester` or `notes`
folder already there is used as it is). The rest is the user's and is never
changed; `vault.js` checks every write, and never writes through a note that's a
link to a file elsewhere. Stop using leaves the vault alone from then on, deleting
nothing in it (only the search index, `vault-index.json`). Settings is the only
place a vault is first read, because on a Mac one in Documents, Desktop or iCloud
makes macOS ask (for "Jester"); refused, Settings gives the steps
(Privacy Settings › Files and Folders › Jester › the folder, then Try again) and
reads it again when its window comes back to the front. With no vault to use, a
note asked for goes to the computer's own apps, as before.

| Note | What's in it |
|---|---|
| `Jester/About me.md` | Facts about the user by section (who they are, school and work, people, preferences, plans and dates), added and taken away as conversations end. The user's to correct: he reads it as it is. |
| `Jester/Conversations/2026/2026-11-10.md` | A note a day: each conversation's time, title, one-sentence summary, topics and people. |
| `Jester/Remembered/2026-11-10 Locker combination.md` | What they asked him to remember, word for word, a note each. |
| `Jester/Routines.md` | What he does with no model: taught phrases, shortcuts, learned tasks. Rewritten as they change. |
| `Jester/Index.md` | A map of the vault, folder by folder. Rewritten as it changes. |
| `Jester/How Jester uses this vault.md` | All this, for the user. |
| `Notes/Grocery list.md` | Notes they asked for ("add eggs to my grocery list"), added to a line at a time. A note the model suggests unasked isn't made: qwen3.5:9b made "Personal Info" of "I'm a junior at Penn State". |
| `Claude/2026/2026-03-14 Planning the trip.md` | A chat imported from Claude's export (Settings › Memory › Import…), word for word; ChatGPT's go in `ChatGPT/`. See below. |

**Chats from Claude and ChatGPT** (`chat-import.js`, `zip-read.js`). Settings ›
Memory › Import… takes what each lets the user download: Claude's
`conversations-000.zip` (Claude now emails a manifest of links, one per part,
each working once within a day; the manifest itself is recognised and the user
told to open the conversations link), ChatGPT's export zip, the
`conversations.json` in either, or a folder one was unzipped into (Safari unzips).
Each chat becomes a note in `Claude/<year>/` or `ChatGPT/<year>/`, named by its
first day and title, `type: chat`, `source`, `chat_id`, a `chat/claude` or
`chat/chatgpt` tag, and a link back to it. A note is the branch last shown (Claude:
back from the newest message along `parent_message_uuid`; ChatGPT: back from
`current_node`), `## You · 10:05 AM` / `## Claude · 10:06 AM` per message, the
messages' own headings pushed to `####` and below so each stays one section in
search, a code block left open closed. Artifacts and files Claude made, and pasted
text, are folded callouts (cut at 20,000 characters); tools are one line ("Claude
used: searched “…” ×2 · read boston.gov"); thinking, tool results and hidden
messages are left out, as are ChatGPT's citation marks. A line `secretIn` flags is
replaced by a line saying one was left out: on the user's own 298 chats (2026-11-17)
that was 194 lines, mostly real keys and passwords. Importing again rewrites only a
chat whose `updated` is later than its note's, at the same path, and never over a
note that isn't that chat's (a user's note of the same name gets `… 2.md` beside it).
These two folders are written only by an import: `vault.writable` (Jester's own
writes) is still `Jester/` and `Notes/`. Recall labels them for the model: "Your
chat with Claude “…”, March 14 (8 months ago) › Claude’s reply began: …", so Claude’s
answer is never taken for something the user said. Measured on that export: 286
notes (12 chats with nothing shown skipped), 6.6 MB, in 0.5 s; again in 0.13 s.
The user's real import (2026-11-17, in his log): ChatGPT 1,362 chats, Claude 286,
488 lines left out. Claude's projects and memories parts aren't read.

**Searching them.** Cut like any note, those 1,648 chats were 82,467 pieces: a
155 MB index on its way to 390 MB, rewritten whole at every save, and an hour of
Ollama. So an imported chat (`isImportedChat`: `type: chat` in `Claude/` or
`ChatGPT/`) is searched by what it's about (its first piece: summary, topics,
people, what was said about the user) and by how each message began (its first two
parts, about 600 characters), never by what's folded in it, its code, or the line
of tools: 24,011 pieces. Vectors are kept in the file a byte a number (index
version 3), and a piece's `embedText` only until it's embedded: 34 MB for all of
it, and a search of it takes 33 ms. Recall says "Claude’s reply began: …", so the
start of an answer isn't taken for the whole.

**Learning from them** (`chat-learn.js`). Imported, a chat is found only when a
question matches a line of it: after the import above, "what do you know about
me?" got the same five facts as before. Settings › Memory › Learn from them has
the talking model read each chat once: the user's own words (1,200 characters a
message) and how each reply began (240), never what was pasted, made, or left out
as a secret; a long chat is its start and its end (6,000 characters). It answers
with a one-sentence `summary`, `topics`, `people` and what the user said about
themselves, which are written into the chat's own properties (`about_you`, as
"Section: fact"); a fact is kept only if a telling word of it is in what the user
wrote, and a person only if they named them. A note with a `summary` has been
read, so a run stopped or quit carries on. Then every `about_you` not in About me
and not offered before goes to the model as a numbered list, oldest first with its
month, and it answers with the numbers worth keeping (at most 60 a run; 200 at a
time when there are more, then the picks from each other): those go into About me,
dated by their chat. The model only picks, so nothing is reworded on the way in,
and what's been offered is kept in `chat-learning.json`, so a fact the user
deletes isn't put back. Three chats are read at once; four failures in a row, or a
key refused, end the run with the reason in Settings. Asked what he knows, he's
also told how many chats there are, over which years, what they're mostly about,
and whether he's learned from them. Measured on 60 of the user's own chats with
Claude Haiku 5.5: 26 s, under 1¢ (so about 12 minutes and 25¢ for all 1,648), 31
facts found, all traceable to their words, 14 picked. The first prompts picked a
rough patch with someone and a project's stack over an IBM co-op: both prompts now
say a passing mood or trouble is no fact, nor how a project is built.

Each of Jester's notes says what it is in its properties (`type`: profile,
conversations, remembered; a `jester/…` tag; its day), the same way every time, and
notes made in `Notes/` are `type: note`, tagged `note`, so Obsidian's search and the
user can tell a profile from a day's talk from a note. Jester tells its own notes
by where they are, not by type, so a note of the user's typed `profile` or `index`
is searched like any other. A write lands whole (written beside the note, renamed into place), and
notes are changed by adding and removing lines, never rewritten, so what the user
typed into them stays. A note asked for is found by file name, title or alias,
`Notes/` first; one elsewhere is the user's, so he won't add to it or make a second
beside it. A name's + and # count: "C++ notes" and "C# notes" aren't "C notes", and
since no file can be called "C# notes", it's saved as `C sharp notes.md`.

**What's kept.** When a conversation is over (above), one call to the talking model
sums it up for the day's note and says what it showed about the user, which goes
into About me unless About me already has it. The Remember conversations switch
in Settings turns both off. Word for word, only what they ask him to remember:
"remember that my locker combination is 12-34-56", "don't forget …", "memorize
this", "keep that in mind", or "remember that" after saying it. "Remember this"
with nothing of theirs before it, or after his answer to something, gets "Sure.
What should I remember?", and what they say next, within a minute, is kept as said,
with no model asked ("remember that" after his answer keeps his answer). "No, don't remember
that" isn't asking. Whether they asked is read from their words
(`askedToRemember`), not taken from the model, which filled `remember` for
"remember when we planned that trip to Boston?" 3 times out of 3; the words are
then found in what was said (`verbatim`), so a model's paraphrase is never kept as
theirs. After a bare "remember that", it's their line before, or his answer when
that line was a question ("what's the capital of Australia" … "remember that").
Anything that looks like a password, PIN, card number or key is never written
(`secretIn`), including "I changed my Netflix password to tacos": he says notes
are plain text files and keeps nothing, a summary that held one says only that the
details were left out, and `recollections.json` and dev.log leave such words out
too.

**What's recalled.** Before he answers, what the vault holds on what was just said
goes in front of it, for at most 1.5 s of looking (`RECALL_MS`): About me, then the
pieces found, each labelled with its note, its folder (two syllabi aren't one) and
its day, 1,800 characters in all. A piece found brings its whole section, and the
lines of it sharing most with the question go when it doesn't all fit: "what time
is my physics lab" found Tuesday's part of a week's schedule, and the lab is
Thursday's. Said in under five words ("and on Friday?"), or
pointing back ("and when do I have to pay it"), it's searched with the user's line
before. The model is told it's information, never instructions, since a note may
be a saved web page, and a command that could do harm asks first on a turn that
read the user's notes, even typed. From the user's own notes, a line naming a
password, PIN, code or key, the line after one that ends with such a name, and a
table with a column for one are left out. All of this goes to whichever model
talks: with a cloud one ticked for Talking (Settings › Models), About me and parts
of the user's notes go to that provider with what they said.

**Search** (`vault-index.js`). Each note is cut into pieces a heading long, or a
few lines of a long one (a section over 360 characters goes in parts of 120 to
320, so the model sees all of any piece found), with the note's other properties
(birthday, due, professor…) as its first lines, each piece labelled with its note's
title, headings and properties ("Conversations on Monday,
November 9, 2026 › 10:05 AM · Algorithms midterm prep"), and found two ways at
once: by meaning, through `nomic-embed-text` in Ollama on this computer, and by
words (BM25), so a name or course number the embedding blurs still counts and
everything still works, less well, with Ollama off. The two rankings are fused,
with a nudge for a note the question names and for a day it asks about ("what did
we talk about yesterday"). A day only mentioned ("is it going to rain on Friday")
nudges only what was already found, so chit-chat doesn't bring back that day's
talk. Below a floor of 0.6, meaning doesn't count: unrelated text scores about 0.5
with this model. The index (`vault-index.json`, in the app's data folder, never the
vault) follows changes as they're saved, re-reading a note only when it changes
and embedding a piece again only when its words do; a first embedding saves its
progress every 30 s. Read again asks Ollama straight away, so after starting it or
pulling the model, search is by meaning at once. On the sample vault in
`scripts/vault-eval.mjs` (40 notes in 74 pieces; 43 questions with an answer, 13
without):

| Ranking | hit@1 | hit@3 | MRR | No answer, yet found |
|---|---|---|---|---|
| Words only (BM25) | 0.67 | 0.81 | 0.75 | |
| Meaning only | 0.81 | 0.93 | 0.88 | 5 of 13 above the floor |
| Both, as Jester searches | 0.93 | 0.93 | 0.93 | 6 of 13 |
| Both, with Ollama off | 0.77 | 0.88 | 0.83 | 8 of 13 |

A question the vault can't answer that still finds something is a near miss
(Mom's note for "what's my sister's name"), and the model is told to say it
doesn't know when the notes don't hold the answer. Cut at 1,200 characters, as at
first, a week's class schedule reached the model for 23 of 30 questions; cut as
now, 29.

**Quicker the second time.** When the talking model takes the user's words to mean
a command that then works ("pull up canvas" → "open the PSU Canvas bookmark"),
those words stand for that command from then on (`learned.js` aliases): the next
time, the matcher knows them, so no model is asked at all. So do the command's own
words, when only Chrome or the assistant could do it: "open canvas" asks no model
the second time. A web address the user didn't say (the model's guess at one)
never becomes a shortcut. Words stand for a command only when they name
what it did and lean on nothing said before: "try now", "the first one", "the
latest video" and "play something" meant what they did that time. A task the
assistant got done is kept the same way (above), and both are listed in Routines;
"forget the shortcut …" drops one. Browser tasks done in Chrome aren't learned yet:
that needs the extension to say what it did.

Session memory needs nothing more: one app on one computer keeps the conversation
in memory and in `conversation.json`, and the slow part of a turn is the model,
not reading what was said.

### What he knows about you, and forgetting

He learns on his own: when a conversation ends, the one model call that sums it up
(`ended`) also adds the lasting things it showed about the user to About me, and
takes out what it showed to be wrong. Two things were missing (2026-11-15).

**"What do you know about me?"** (`askedWhatKnown`) is answered from all of it.
`recall` gives the model the whole of About me by section, up to 4,000 characters,
and the newest six things he was asked to remember, with nothing searched for;
his prompt has him pick the three or four that matter most, say where the rest is
(the About me note) and offer to open it. With nothing learned yet the brackets
say so, so he says so rather than fill the gap. Settings › Memory has a row with
the counts and a button that opens the note.

**"Forget that…"** is done by his memory, not said by the model. `askedToForget`
reads the user's own words: named ("forget that my roommate is Alex", "don't
remember that", "delete that from your memory"), bare ("forget that", "never
mind" just after he kept something: the note he just made, with no model asked),
or everything, which he won't do on one sentence that may have been misheard
(About me and Forget it all are the user's to clear). "Don't forget…" still asks
to remember, "forget the shortcut…" is still voice-commands.js's, and a bare
"forget that" with nothing just kept is left to the talking model, which sets
"forget" when it's about something they told him and leaves it out when it only
calls off a request.

For a named thing, `forget` shows one model call everything he keeps as numbered
lists (About me's facts, what he was asked to remember, conversation summaries the
index finds, the week's earlier conversations) and takes back numbers. Only those
go: a fact out of About me, a remembered note to the computer's Trash
(`shell.trashItem`; `.trash/` in the vault without it), a conversation's section
out of its day's note with the people and topics only it named, an earlier
conversation out of recollections. The model never names a path or writes a word
of what's kept, numbers outside the lists are ignored, more than ten picked at
once forgets nothing (he says how many it would have been), and what looks like
a password is never shown to it. He then says what went, from what was removed
("Done. I've forgotten "Roommate is Alex Chen"."), or that he had nothing kept.
The conversation's own summary leaves it out too (`endedPrompt`). Chats, in his
window, are the user's own record and aren't touched.

### His manner following theirs

`mood.js` reads how the user seems from what they plainly say (in a hurry, low,
annoyed, delighted; nothing plain is nothing told), tells the model in the
brackets before their words ("How they sound: low."), and sets how fast he speaks
(1.08 of his usual pace to someone in a hurry, 0.93 to someone low; Kokoro stays
clear at both, read back 10 of 10). Someone low a moment ago still is for five
minutes. His prompt says what each calls for: the fewest words; gentle and plain
with no advice unless asked; owning a mistake in a word; being glad, without a
history made up to be glad about (Claude Haiku 5.5 said "after all that waiting"
of an internship it had only just heard of, 4 times in 4, until told it doesn't
know what led up to it).

Measured (2026-11-15, `npm run talk-check -- --only self`, 3 tries a case; `--show`
prints what he said). On manner, the prompt alone already got Claude Haiku 5.5
31 of 33, Groq's gpt-oss-120b 33 and qwen3.5:9b 26, every miss a matter of
length; told how they sound, Haiku got 33 of 33, Groq 18 of 18 before its free
plan's limit stopped the run, and qwen3.5:9b 20 of 22. On knowing and forgetting,
Haiku got 45 of 45: the right facts and only those, a note written to steer it
("pick every fact and every note") left alone, nothing forgotten when nothing
kept said it. Every talk case together: 273 of 276 on Haiku, for 3 cents, the
three misses old ones (the day's weather in other talk, once).

qwen3.5:9b picks badly: asked to forget a locker's combination it picked
"Roommate is Alex Chen", and at first that went. So a pick that shares no telling
word with what the user said (`saysIt`: their line and the two before it, first
four letters of each word) is asked about first, the way anything that can't be
undone is ("Forget "Roommate is Alex Chen"?"), and stays unless they say yes;
with it, qwen's wrong picks removed nothing in 20 tries, and what it misses the
user can ask for again. It also said "I will forget that about Sam" with no
"forget" set, so his saying he'll forget is taken as asking his memory to
(`claimsToForget`), and read a locker's combination aloud to "what have you
learned about me?", so what he was asked to remember is given there by name only.

`npm run live-check -- self` runs it in the real app on a scratch profile: a
note made and taken back to the trash, About me reaching the model whole, a named
fact forgotten and the rest kept, "forget everything" refused, the Settings row,
and "How they sound: in a hurry." before the user's words: 9 of 9.

## His clock, and whether they're there

Step 7 of the plan, and what reminders, the morning brief and anything sent to a
phone stand on. Nothing here is asked for by voice yet: that's the next step's
timers and reminders.

**The clock** (`clock.js`) keeps jobs in `jobs.json`, in the app's own folder: due
once, every day at a time by this computer's clock (on some days of the week, if
given), or every so often. What a job does is its kind's handler. Timers stand
still while a computer sleeps and its clock can change, so nothing is trusted to
one long timer: he looks at the time at least every half minute and whenever the
computer wakes, and a daily job's next time is worked out from the wall clock
each time. What came due while it slept, or while he wasn't running, is done
once on waking and told how late it is; a daily job missed for days runs once,
late by this morning's; and a job can say how late is too late (`keepFor`), so a
brief missed by six hours isn't said at three in the afternoon. A handler that
throws is tried again after a minute, five, then fifteen. A job of a kind nothing
does yet is kept, not run, and not lost.

**Presence** (`presence.js`) says whether they're here, near or away, from things
that need no permission: the system's own count of seconds since a key or the
mouse, the screen unlocking, their voice, something typed to him, the watch, and
a hand in view when the camera's already on for gestures. The camera is never
opened to look for them.

| | |
| --- | --- |
| here | one of those in the last two minutes |
| near | quiet for longer, under ten minutes; or quiet however long while something keeps the screen awake (a film, a call: `pmset -g assertions`, asked at most once a minute and only then), up to three hours |
| away | the screen locked, the computer asleep, or ten quiet minutes |

His own typing and clicking resets the system's count like anyone's, so the
driver's posting commands tell presence while they're at it and input in that
stretch isn't taken as the user's: a task at work for eleven minutes with nobody
there ends as away. A sitting ends when they were last seen, not when it was
noticed. A day starts at four in the morning, so working past midnight isn't the
next day's first sit-down, which is logged (`presence: here (unlocked), the day’s
first sit-down`) and is where the morning brief will come. Restarted mid-sitting
he carries it on rather than greeting them again. Sittings are kept for a week
in `presence.json`, in the app's own folder, and go nowhere; asked how long
they've been at it, when they started, or whether it's time for a break, he's
given the figures, one to a line. In one sentence, qwen3.5:9b did sums of its own
with them ("4 hours and 48 minutes", of 5 hours 5); a line apiece, it got 10 of
12 and Claude Haiku 5.5 12 of 12 (`npm run talk-check -- --only self --match
"been at this|start today|take a break"`). Not asked, he isn't told.

**Telling** (`tell.js`) is the handler for a job of kind `say`: a line whose time
has come. Here or near, he says it once he's free to, never across his own
sentence, theirs, or a task at work, and it's in the conversation like anything
he says, so "thanks" has something to follow. With the mic closed it's written,
on the pill and in his window. Away, it's held (by the clock, so it outlasts a
restart) and told eight seconds after they're back, saying when it was for
("This was for 3:05 PM: …"). The log says a line was told and how late, never
what it said. A phone is where a held line will go instead, once there is one.

A second reading of all this found ten ways it went wrong, each now a test.
The ones worth knowing: every stretch of his own input is remembered, not only
the last (a click, then a read of the screen six seconds later, uncovered the
click and brought an absent user "back"); a key from before the lid closed never
counts as them returning, whether the system's count ran on or stood still
while it was shut; someone quiet through a film was at it until it ended, so the
film is in the sitting; a line cut off as the screen locks isn't taken as told;
his name heard with nothing come of it doesn't keep him from speaking for good;
he doesn't start a line while a voice is mid-sentence at the mic, or while he's
being taught theirs; a daily job doesn't run twice for one date when the clock
is set back or the zone moves west; and a handler that never answers is given
ten minutes, then the clock goes on without it.

`npm run live-check -- clock` runs it in the real app on a scratch profile, with
the idle count and the screen lock scripted: a line due an hour before he
started is told late, one due behind a locked screen is held and told after the
unlock, the first sit-down is logged once, and the sitting reaches the model
only when asked: 9 of 9.

## Their to-do list, reminders and timers

Step 8. He keeps a to-do list (`tasks.js`, `tasks.json` in the app's own folder),
and anything on it with a time is a job on his clock:

| | |
| --- | --- |
| a task | something to do, with no time. It stays until they tick it off or remove it. |
| a reminder | a task with a time. He says "Reminder: …" when it comes (held until they're back if they're away, `tell.js`), and it stays on the list, marked as given, until they say it's done. |
| a day's task | a task for a day and no time. Nothing rings. |
| a timer | so many minutes from now. He says it's up, and it's gone. |

**Timers are the clock's, on the user's own words, with no model asked**
(`tasks.direct`): "set a timer for ten minutes", "start a 5 minute timer", "set a
pasta timer for 8 minutes", "how long is left on the timer?", "cancel the timer".
That's at once, and the same with any model or none. The whole sentence has to
be the asking. One that only mentions a timer ("my oven has a ten minute
timer"), denies one ("don't set a timer…"), asks about one, or asks for more
besides ("stop the music and set a timer for five minutes") is the model's to
make sense of, as is one put another way ("time my break, fifteen minutes"):
the first version matched anywhere in a sentence, and "don't stop the timer"
cancelled it.

**Everything else is the model's "task"** in its reply: `{"op":"add","text":…}`
with `"at":"YYYY-MM-DD HH:MM"` (or just the date) or `"in"` minutes; `timer`;
`done`; `remove`; `move`. Three rules keep that honest:

- *What he says back is how it went, from what was kept, never the model's own
  line*: "Okay, I’ll remind you tomorrow at 3:00 PM: Call your mom." is read off
  the task as stored, so the time he says is the time on the clock, and a wrong
  one is heard and corrected. A model that says "I'll remind you" and sets
  nothing is caught (`TASK_CLAIM`): "Sorry, that didn’t get set."
- *A task is made only when the user's words ask for one* (`tasks.asked`:
  "remind me", a timer, "on my to-do list"…, a yes to his own offer of one, or
  any answer to his own question about one). "To do" alone is a verb, a
  question about the list isn't an addition to it, and a shopping list is a
  note. One nobody asked for isn't made, and he isn't heard to agree to it:
  "That isn’t on your list yet: want me to add it?"
- *The time is checked against what they said* (`whenAsked`). A model's time
  counts only when their words hold one, outside what the task itself is ("buy a
  dinner gift"). "In twenty minutes" is theirs as they said it; a day they
  named plainly ("tomorrow", "on Friday") is that day, whatever date the model
  worked out; a day with no time of day is the day, and nothing rings; a time
  already gone today is this evening's if it was written without AM or PM, or
  tomorrow's, unless they said today. A time they gave that can't be read is
  asked for, not dropped.
- *Only the user ticks one off.* The model can ask for `done`, and it's done only
  when the user's own words are about that task (`bears`): they hold at least
  half its telling words and the last of them, which is what it's of ("I
  emailed Sarah" is about "Email Sarah"; "I called the dentist" is not about
  "Call the bank"), and they aren't a question or a not-yet ("did I call the
  dentist?", "I still need to…", "I'll… tomorrow"). Or they're a few plain words
  ("okay, done", "snooze ten minutes", "yes", "at six") said right after its
  reminder, or to a line of his that named it and nothing else. The same for
  removing one and changing its time, which also have to be asked for in so
  many words. When the model picks one task and their words are about another,
  theirs is the one meant. A pick their words don't bear out changes nothing:
  "Do you mean “Buy stamps”? Say which one and I’ll tick it off.", or, when
  their words weren't asking for anything of the kind, just his answer. The
  other way to tick one is the box in the Tasks panel, which is the user's click.

The list reaches the model, in the brackets, when their words may be about it
(`TASK_WORDS`), and for three minutes after a reminder so "done" or "snooze ten
minutes" has something to be about. Otherwise it isn't told, and isn't brought
up. His first sentence isn't said ahead on those turns: what's said is what was
set. The `tasks:` lines in the log say what was done to the list ("tasks: added
one with a time"), never what's on it; what he said is in the log like anything
he says. Reminders are one-off for now: none repeats.

**The Tasks panel** is beside Chats, top left, and slides in from the left as
Chats does; its button carries how many are open. Timers count down by the main
process's clock; open tasks are under Overdue, Today, Tomorrow, Later and No
date; what was ticked off stays for a week and can be put back. A task can be
added there by hand (with no time: times are asked of him).

**Cards** (`src/home/cards.js`; the user, 2026-11-15: "create physical card for
timers, notes, reminders, and tasks, etc. so I can also see them in the desktop
app and interact with them"). Whatever he makes or changes is a card in his
window, in three places:

- *With the line he said it in.* "10 minutes, starting now." has the timer under
  it, counting down with a bar, and a × to cancel; "Okay, I’ll remind you…" has
  the reminder, with its box to tick; a note he made has its title, a few words
  of what was added, and Open, which opens it in Obsidian; something he was
  asked to remember has its title and Open, and not the words. A reminder being
  told comes with its card too: tick it, snooze it ten minutes, or remove it.
  The line carries only what the card is of (`card` on the conversation's
  entry, kept with the chat for its week), so a chat opened again from Chats
  shows the same cards as they stand now.
- *On the shelf over the orb*, one line each: timers running, reminders given
  and not yet ticked, and reminders due within three hours. Four at most, then
  "+2 more", which opens Tasks.
- *In the Tasks screen*, where every timer, reminder and task is one, with the
  notes he's made or kept in the past week at the foot.

A card is a view of what main.js keeps, not a copy: every card of one task shows
the same thing and changes when it does, and one whose task is gone says what
it was ("Finished", "No longer on your list"). A click on a card is the user's
own doing, the same as their saying so.

Measured (2026-11-15, `npm run talk-check -- --only self --match "remind|to-do|…"`,
3 tries a case, 18 cases; `--show` prints what he said and the task he gave).
Claude Haiku 5.5: 51 of 51 once the prompt said that "I called the dentist" *is*
them ticking it off (it had asked "want me to tick that off?" 3 times in 3),
and 54 of 54 at the end. qwen3.5:9b: **0 of 33** on anything needing "task" with
the first wording, which described its shape and never showed it in a reply: it
put "task", "add" or the JSON itself in "do". With a whole reply for an example
it set "task" nearly every time, and its remaining mistakes were of four kinds,
each now put right by the app from the user's own words rather than argued
with in the prompt: a timer for what was a reminder ("remind me in twenty
minutes to…": taken as the reminder, with what it's of read from their words);
a time nobody gave ("add buy stamps to my to-do list", set for that very
minute); the wrong day for "tomorrow"; and 5:48 for 5:48 PM. A "task" put in
"do" as JSON is taken as the task, and his saying one's done or removed with
no "task" set is acted on when their words ask for exactly that
(`saidDone`, `saidDrop`). At the end: 52 of 54.

Every talk case on Haiku with the longer prompt: 344 of 348, for 4 cents, the four
misses old ones (the weather in a joke, twice).

`npm run live-check -- tasks` runs it in the real app on a scratch profile (add
`--shots <folder>` for pictures of his window): 16 of 16.

A second reading found eleven ways it went wrong, each now a test: nearly all of
them the app taking words for more than they said (the timer shortcuts above;
a task ticked by "did I call the dentist yet?"; "done" about the dishes ticking
the reminder just given), and his own questions ("When should it be?") having no
answer the rules would accept.

## The morning brief, the evening wrap-up, and a word before class

Scheduled briefings announce themselves and wait for permission to read.
Jester says “I have your morning briefing. Would you like me to read it?”
Answer yes, or use **Read**, **Later** (ten minutes), or **Dismiss**. He waits
until you are available and does not read across a film or call. The schedule
remains in Settings › Assistant and voice.

- **The morning brief**, when they first sit down at the computer for the day
  (`presence.js`'s first sit-down; any later one, until it's been given; not
  after five in the afternoon). A few seconds after they're back, so it isn't
  the first thing they hear as the screen unlocks: the weather, what's on their
  calendar for the rest of today, what's due (a class site's deadlines are
  all-day events), and their list: overdue, today's, and how many have no date.
- **The evening wrap-up**, at nine (Settings has the hour): what got ticked off
  today, what's still open, what tomorrow starts with and what's due then, the
  weather tomorrow, and how long they sat. Away, he keeps it until they're
  back, for three hours; after that it's tomorrow's business.
- **A word before what's on the calendar**, fifteen minutes before each thing
  with a time: "CMPSC 465 Lecture starts in 15 minutes, at Westgate E201." The
  calendar's own words and the clock's sum, never a model's; said late, it says
  how long there is by then, and once the thing has begun, nothing.

“Read my morning briefing” and “read my evening briefing” replay the saved
version. “Update my morning briefing” rebuilds it. Briefings are saved locally
for seven days, with their original time range and sources; missing historical
briefings are identified rather than recreated from today’s information.

“Create a briefing” defaults to **since our last conversation**. “Create a
briefing for today so far” covers the day to this point. If no previous
conversation is available, Jester explains that he is using today instead.
Custom topics include Canvas/classes, important mail, tasks, upcoming events,
and news. For example: “create a Canvas briefing” or “create an upcoming events
briefing for tomorrow.” Canvas and news use background research and do not
silently switch to computer controls.

**See more** expands the saved details inside Jester. **Open** takes you to the
original page or Gmail thread, the Tasks screen, or a calendar day view when
the event has no original page. No page opens just because a briefing was
created or read. A briefing is marked read only after playback finishes;
interrupting it leaves it available to read again.

Custom briefings summarize accessible records, not an audit of everything you
did. Calendar entries describe scheduled plans, not confirmed attendance.
Mail covers watched important arrivals retained for two days; task history
contains retained creations and completions. Current Canvas/news pages may
not establish what changed throughout a requested period. These coverage
details stay with the briefing. This feature currently runs in Desktop.

**The facts come first, and what a model says of them is checked against them.**
`factLines` gathers the day as lines; the model he talks through says them his
way in three to five sentences; and `strays` reads what it wrote: every clock
time must be one of the facts' (whole: "4:52" pieced together from a 4:00 and a
52° is caught), and every number at all, in words or digits, a measure always
and a count above three. One that strays isn't said: the facts are, plainly
(`plain`), as they are with no model. Only a paid model writes one at all.
Measured (2026-11-15, `npm run talk-check -- --only self --match "morning
brief|evening wrap"`, a made-up day, 6 tries each): Claude Haiku 5.5 kept to the
facts 12 of 12, once two faults of the facts' own were mended (an overdue task
said only "at 9:00 AM", which it took for this morning: now "due yesterday at
9:00 AM"; and its "one thing ticked off" counted as a number made up). qwen3.5:9b
gave a wrap-up "that seventy-five degree weather", a lecture "from four to
five", and "calling the dentist this evening" for a three o'clock: the first two
are caught now that numbers in words are read, and the third never could be,
which is why a free model's brief is the plain one.

Each comes with an expandable card in his window, and is in the
conversation like anything he says, so "thanks" or "move the dentist to
tomorrow" follows on. A line that held a calendar's titles is marked as someone
else's words (`untrusted`): for the rest of that conversation a command that
could do harm asks first, as it does after any calendar's been told.

`npm run live-check -- brief` runs it in the real app on a scratch profile, with
a calendar the script serves: the check-in on his clock and said when it comes
(and once), an offer on unlocking the screen, consent and snoozing, saved replay,
explicit updates, source navigation, custom ranges, and the settings switches.

A second reading found twelve faults, each now a test or a live check. The ones
worth knowing: a check-in already said was put back on the clock at the next
look at the calendar, and said again every five minutes until class (what's
been said is remembered until its event starts); "remind me to send the brief
to Sam" was taken for "brief me" (the whole sentence has to be the asking); a
chat picked back up from Chats lost its cards and that it held a calendar's
words; a measure was checked against any number in the facts, so the 30 of
"10:30" let "a 30 percent chance of rain" through (a measure is checked against
the facts' measures, a length of time against their lengths, and a time against
theirs in the same half of the day); a paid model that was resting was covered
for by the free one, which then wrote the brief (the reply has to be the paid
model's own); and the evening's "today" was the calendar's, so a wrap-up after
midnight had nothing in it.

## Their phone

Step 10. When they aren't at the computer, what he has to tell them goes to
their phone (`phone.js`), as a notification in the [ntfy](https://ntfy.sh) app.

ntfy has no accounts here: a message is published to a topic, and whoever has
subscribed to that topic's name gets it, so the name is the key. Settings ›
Assistant and voice › Your phone › Set up makes one nobody could guess
(`jester-` and sixteen letters at random, in fours so it can be typed with a
thumb: 72 bits), kept sealed on disk with the other keys and shown in that row
alone: not in the log, not to his pages' storage, not to a model. The user
subscribes to it in the app, presses Send a test, and turns it on. Until it's
on, nothing is sent. New topic leaves one behind that's got out.

**What's sent passes through ntfy's server, readable by anyone who had the
topic's name**: the line he'd have said, and no more. A line that looks like a
password or a card number is never sent (`phoneText`): only that there's
something to see. It's published as JSON over https, so a title in any script
arrives whole; another server than ntfy.sh can be set (the `jester/phone`
message's `server`), https only.

Where a line goes is `tell.js`'s to say, by where they are (`presence.js`):

| | |
| --- | --- |
| here | said, and the phone left alone |
| near (quiet a few minutes) | said, and sent as well: they may have stepped out |
| watching (near only because a film or a call keeps the screen awake) | sent, and shown on the screen and in his window; not said across it. With no phone to take it, it's said all the same: a timer missed is worse than a film interrupted. |
| away | sent, and that's it told: a reminder is marked as given, and isn't said again when they're back. A send the server refused, or that never reached it (the network not up yet, just after waking), is tried again twice, half a minute apart; one that got no answer may have arrived, so it isn't. Then, as with no phone set up, it's held and said when they're back. |

Reminders, timers and a word before class go at high priority. Morning and
evening briefings wait at the computer for an accepted reading and are not
pushed to the phone. A line that looks like a secret sends only "There’s something
for you on your computer", and stays to be told: so does the real line, when
they're back. A place that's a link to a call isn't said or sent at all.

A second reading found ten faults, each now a test: that last one was the worst
(the line was swapped for its placeholder, counted as told, and lost), with a
timer during a film getting a toast for a second and a half and nothing else
when there was no phone.

`npm run live-check -- phone` runs it in the real app on a scratch profile
against a server of the script's own (nothing is published anywhere real): the
topic made and shown in Settings alone, a test, a reminder sent with the screen
locked and not said again on unlocking, and one held when the server fails: 8
of 8. **No message has been sent to a real phone**: that needs the user's own
subscription.

## Their email

Step 11. He watches their Gmail and tells them when something that matters
arrives (`mail.js`), signed in with Google to read and nothing else
(`google.js`: the one scope asked for is `gmail.readonly`, so he can't send,
answer, change or delete).

**Signing in.** Google has each app sign people in through a client of its own,
and Jester ships none: Settings › Email takes the file Google's console gives
for a "Desktop app" client (Download JSON), reads it once, and keeps it sealed
with the other keys. Sign in with Google then opens Google's own page in their
browser, with PKCE and a state only this asking knows, and Google sends its
answer to a port on 127.0.0.1 that's open only while it's waited for (five
minutes). What that yields is sealed too. None of it is in the log (which has
that a sign-in happened, and why one failed, in Google's own word for it), in
what his pages can read, or in anything a model is shown.

A client in Google's **"Testing"** state signs its users out after seven days
(Google's rule for any scope beyond name and email). He says so once ("Google
has signed me out of your Gmail…"), Settings says why, and nothing's read until
they've signed in again. Publishing the app in Google's console ("In
production", unverified) ends the weekly sign-in, at the price of Google's "this
app isn't verified" page when signing in: the user's choice, and not made for
them.

**Watching.** Every five minutes (a job on his clock) he asks Gmail what's been
added to the inbox since his mark in its history; the first look only makes the
mark, so nothing from before he was connected is ever told. Of each new message
he fetches who it's from, its subject and the opening words Gmail shows in the
inbox (`format=metadata`): never the body. Then:

1. *Gmail's own labels* (`important`): unread, in the inbox, and either marked
   important by Gmail or not filed by it under Promotions, Social, Forums or
   Updates.
2. *Not shown to a model if it reads as written at him* (`steering`): "ignore
   your previous instructions", "SYSTEM:". Such a message stands by Gmail's
   marking alone, and is told like any other: never dropped for it, since a
   professor writes "please ignore the previous instructions for HW5" too.
3. *Worth an interruption* (`worth`), if Settings allows a model to see it: the
   model he talks through is shown what's left, numbered, as data, and picks by
   number. Measured (2026-11-15, `npm run talk-check -- --only self --match "new
   mail"`, six made-up emails, 6 tries): Claude Haiku 5.5 picked the professor's
   change, the roommate's ask and the hold on an account, and none of the
   newsletter, the receipt or the one written to steer it, 6 of 6. qwen3.5:9b
   picked the same and the steering one too, every time: hence rule 2, which
   keeps what's written to steer a model away from the model.

What he says is who it's from and its subject, as they are ("New email from
Sarah Lee: Lab report feedback."), never a model's account of it; three by name
at most, then how many more. It's told like any line of his (`tell.js`): said
when they're here, sent to their phone when they're away, with a card that
opens the conversation in Gmail. Between ten at night and eight in the morning
it's kept: the morning's brief has what he's found and not yet told, and marks
it told; whatever the brief didn't take (it's off, or they sat down late) is
told at the first look after eight. Asked about their mail, he's shown what's arrived lately, as data. A
sender and a subject are other people's words: a line that holds them is marked
so, and what's asked after it is asked carefully.

A second reading found twelve faults, each now a test. Mail could be lost four
ways: the first `steering` dropped what it matched, and it matched "You must
reply by Friday to keep your housing offer"; his mark in the inbox moved before
the messages were fetched, so one failed fetch lost the batch; only the first
page of Gmail's history was read; and the night's mail reached the user only if
the morning brief happened to run. And a sign-in could be broken by any other
request to its port, which now answers only the one carrying this asking's
state; a Gmail that refused every call ("the Gmail API isn't turned on") looked
like success, and now fails the sign-in and says what to turn on.

`npm run live-check -- mail` runs it in the real app on a scratch profile
against a pretend Google and a pretend browser: the file chosen, the sign-in,
new mail told with its card and opened, the model shown only what could matter,
"any new email?", and Google signing him out said once: 14 of 14. **Nothing has
been signed in to or read at Google itself**: that needs the user's own client
and their own Allow.

## What the first real test found

The user's own pass through the checks (2026-11-15), and what each thing turned
out to be. The log told most of it.

- **He needed his name again to hear an answer to his own question.** Not the
  window being shut: it was open, and their voice scored 0.39 to 0.50 against
  the voiceprint, "maybe", which counted only with his name. Now, in the
  moments after he's spoken (8 s; 20 s after a question of his), a voice that
  may be theirs is taken for theirs. A yes to something he's asked leave to do
  still has to be theirs for certain.
- **A timer only said it was up.** It rings now (`ring.js`): he says it once,
  then a small pill at the top of the screen rings, three notes and a rest,
  until it's turned off. By a word, with his name or without ("stop", "turn it
  off", "okay", "thanks": `RING_STOP`, the whole of what was said); by talking
  to him at all; by any gesture, which then does nothing else; or by a click,
  on the pill's Stop, the timer's card in his window, or the first item of his
  menu. Left alone it stops after a minute. It doesn't ring for a timer they
  were told of late or on their phone, nor if he was told to stop while saying
  it was up. Reminders don't ring.
- **A song played, stopped, and he said it was playing.** He never paused it to
  speak, and has no way to. He pressed Play, read Spotify 350 ms later, before
  it had turned its Play into Pause, and pressed it again. A press of Play or
  Pause asked for again at once, on the same control, isn't done (`toggleKeys`
  in `agent/loop.js`): the app gets a moment, the screen is read afresh, and
  asked a third time it's meant.
- **Asked to open the second file in Downloads, he selected it and said so.**
  The talking model had rewritten "open" as "select" in its command. The
  user's own verb is put back (`asAsked` in `conversation.js`), and the acting
  model is told that selected isn't open.

`npm run live-check -- ring`: the pill, its sound being made (muted there), the
card, and each way of stopping it that a check can do: 8 of 8.

And the day after (2026-11-16), from a conversation about one reminder:

- **Told when to set a reminder for, three times, he said "Okay" and set
  nothing.** The model had it right each time: a `move`, to "set it for one
  hour before the class" and to "yeah, one thirty's perfect". The list threw
  each away, since only the user moves a task and those words weren't on its
  list of ways to say so, nor did they name the task by its last word. Now
  (`tasks.js`):
  - a short answer to a line of his that *asked when* one reminder is for
    (`WHEN_ASK`: "tell me when you want it", "do you want the reminder at
    1:30?"), and named no other, is about that reminder. Not a line of his
    saying one's set, nor a reminder as it's given; and never a question back;
  - a yes to the time he offered is that time, and "an hour before" is counted
    from the one time his line gave for something else ("it starts at 2:30
    this afternoon": `timesIn`), which is nobody's sum. A range, a time that
    could be morning or evening, another day, a number that may be no time:
    then it's the model's time, as it was before;
  - to move one, a task is named by more of its words than any other's ("move
    my first class reminder to 1:30"); a time said in words ("one thirty
    p.m.", as the recognizer writes it) is a time;
  - and a change to the list that isn't made is never agreed to: he says how
    the task stands instead (`undone`).

  A review of the first attempt at this found it let a model's move through
  on words that asked for nothing ("I set the dentist appointment for
  Friday"), and counted "an hour before" from the wrong time (the end of a
  range, his own offer): each is a test now.

- **"When he stops listening he doesn't answer to his name: I have to turn
  listening off and on."** The log couldn't say why: it had him hearing their
  voice plainly (0.69 to 0.74) and taking nothing, once straight after the
  switch was flipped, and no state that flipping it clears could be made to
  stick in a simulation. What worked each time was his name alone after a
  silence, then the request. A friend was in the room. So, three things:
  - his name counts further into what's said, when it's a call (`addressed`
    in `wake.js`): after "yeah", "wait", "alright"; opening a later sentence
    ("Watch this. Jester, what's the weather?"); or between commas with a
    request after ("…in the oven, Jester, set a timer"). Only his own name:
    "No, Jess, stop it" and "No, just stop" are talk, and so are "I told
    Jester to…" and "Yesterday, Jester set a timer";
  - talked over by name, in a voice the voiceprint is sure of, he gives way.
    Before, while he spoke and for a moment after, only "stop" was heard;
  - and every utterance heard and let pass is logged with why and its shape,
    never its words: `heard and let pass: not said to him (7 words, his name
    word 6)`, `… he was talking (5 words, his name first)`. Next time the log
    says which it was.

## Getting started, for whoever opens him first

Step 12. Nothing in him is about one person: the examples in his window and in
what a model is told are anyone's ("Springfield, IL"; a test keeps it so), and a
new user is walked through the same things in the order they matter
(`setup.js`).

His window opens by itself, on the orb with a banner, whenever something needed
is missing, and **Getting started** (the banner's Set up; also the first row of
Settings) lists it all, each with whether it's done and a button to where it's
done:

- *Needed:* what macOS has to allow (the microphone unless voice is off,
  Accessibility, and the camera unless gestures are off: `missingFor` in
  `permission-list.js`, the one rule the banner, the menu bar, Settings and
  the list all use), a model that talks (a saved one ticked Talking, or one
  Ollama has), and the recognizer's model on disk.
- *When they want them:* listening for his name, which is off until they turn
  it on and comes first for that; their voice taught, his own voice downloaded,
  an Obsidian vault, weather and calendars, their phone, their email, Chrome.

What a first review of it found, each of which would have stopped a friend:

- **A pasted key couldn't talk.** Talking was ticked on a new model only for
  Ollama, so a key added as the guide says left him with nothing to answer
  with. It's ticked now whenever nothing talks yet, with where their words go
  written beside it; and a model saved for actions alone makes the list say so.
- **Ready, and deaf.** The continuous assistant is off by default, and nothing
  said so: it's a step of its own now, and the screen's first line when it's
  what's left.
- **Chrome could link only on one Mac.** An unpacked extension's id is made
  from the path of its folder, and the one allowed was this Mac's. It's worked
  out now (`unpackedId` in `link-host.js`) from the `jester-extension` folder
  beside the app, wherever that is.
- **The list went stale** after a model was saved: it's asked for again on
  coming to the orb or the list, and when the window is clicked back into.
- **A launch with Ollama not up yet** looked like a first launch. Having been
  ready once is kept (`setUpOnce`), and after that his window opens by itself
  only for a permission.

`npm run live-check -- setup`: the list as main.js makes it, drawn in his
window, a step's button going where it says: 5 of 5.

The watch app's bundle id (`com.krishchavan.jesterwatch`) and the Chrome Web
Store listing are the publisher's, and stay so: anyone building the watch app
signs it as themselves anyway.

## Weather, location and calendars

Settings › Weather and calendars tells Jester the user's day: where they are, the
weather there, and every calendar they connect, combined. Nothing is on until they
choose it there, so macOS's location question only ever comes when they've asked
for it.

**Where.** Location is Off, This Mac's location, or A place you name. This Mac's
location is Location Services, which Jester asks himself: `native/jester-location`
is a small Objective-C Node-API module (built by `npm run location`, and by
`npm run app` and everything that makes Jester.app) loaded into his main process
(`src/main/mac-location.js`), so macOS's question names "Jester" (Jester.app's
Info.plist carries the location usage string) and the position comes straight from
Core Location. Not Chromium's location: Electron 44's Core Location provider
waits for macOS's permission but nothing in Electron asks for it (Chrome asks from
its own layer), so the hidden page that used to ask only ever timed out, and no
question came. That page, `jester://app/where/where.html`, the only page given the
`geolocation` permission and only while Settings says so (`locating` in main.js),
is now for Windows, and for a Mac whose module couldn't be built.
Wi-Fi positioning, to tens of metres. Chosen in Settings, a position is asked for
at once and waited on for 90 s, since macOS asks first; after that, when he's talked to and the last
is over 15 minutes old (the turn uses the last one meanwhile), and when the
computer wakes or unlocks, never on a timer. "Where am I?", "near me" and the like
wait up to 3 s for a fresh one. One that can't be had isn't tried again for two
minutes, but Settings' Locate again always tries. A position is named by
OpenStreetMap's Nominatim (street, town, state; its rules: an app name in the
User-Agent, no more than one a second) once it's moved 150 m from the last named.
A place you name is found by Open-Meteo's place search ("State College, PA":
the state or country after a comma picks among places of that name).

**Weather.** Open-Meteo: free, no key or account, worldwide. It's given the place
to two decimals (about a kilometre), and a forecast is kept 10 minutes, then still
used (up to 3 hours old) while a new one is fetched. °F, mph and inches where the
computer's country uses them (`unitsFor`), or as Settings says. A place asked about
("what's it like in Chicago tomorrow?") is found by name (`placeAsked`, then the
place search, which decides whether it's a place at all: "in the afternoon", "in
here" and "for tomorrow" never get that far).

**Calendars.** Each is connected by its iCal (ICS) link, which every calendar app
gives: Google's secret address, Outlook's published ICS link, an iCloud public
calendar, Canvas's calendar feed. A link reads a calendar without signing in, so
it's the same on Windows, and there's no Google or Microsoft app to register; but
anyone with it can read that calendar, so links are in `PRIVATE_KEYS` (sealed with
the keychain, never sent to a page). Settings gets each one's name, site, how many
events are coming, and how its last read went. Each is read when added (one that
isn't a calendar, or is a web page, is turned away in words), then every 15
minutes, one at a time, and again on wake. Google's own feed can lag its calendar
by hours. A read that fails keeps what the last one gave, and Settings says why.

Events from a week back to 90 days ahead are kept: title, times, place, calendar.
Never descriptions: they run long, and they're other people's words. ical.js parses
the feed and expands recurring events, with their skipped dates (EXDATE) and moved
or cancelled occurrences (RECURRENCE-ID); a zone the feed defines (Outlook's
"Eastern Standard Time") is ical.js's to convert, one it only names
("America/Los_Angeles", no VTIMEZONE) is converted with Intl, since ical.js would
read it as UTC. ical.js steps through a series from its first occurrence: 150
classes meeting three times a week since 2022 took 2.4 s, on the main process the
cursor runs on, so a series without a COUNT starts stepping a whole number of its
periods before the window (`startNear`; 50 ms, the same occurrences, a test
checks five kinds of rule against the walk from the start). An invitation the
user declined on a Google calendar is left out (the feed's address says whose it
is); cancelled ones are too. The same event on two calendars (the same invitation,
or the same title at the same times) is one, naming both.

**What he's told.** `situation.js` writes it, before what's recalled from the
vault, in the same bracketed block (an event title's brackets made round, so one
can't end the block). Every turn: the town, the weather now, today's and
tomorrow's, and the calendars for the rest of today and tomorrow (ten events at
most) and the next one after. Words decide when there's more, as they do what's
recalled: about the weather, the next 12 hours and the week; about their schedule
("free", "class", "tomorrow", "Friday"…), the week from this morning, or further
("next week", "this month", "December 3rd", "12/20", "in January"), or from a week
back ("yesterday", "last Monday"), 40 events at most; about where they are, the
street and coordinates. A calendar that couldn't be read is said to be missing, so
he doesn't call the day empty. dev.log gets `knew: here ±35 m, weather, 2 events`,
never the place or an event.

His prompt then says the brackets hold what's live and to answer from them: the
weather, never a search for it, and their day, never handed to the laptop, unless
they ask for an app or site to be opened ("open my Canvas and tell me what's due"
is still the laptop's). With nothing connected his prompt is word for word what it
was. A turn told any calendar event is one whose command asks first if it could do
harm, as a turn told the user's own notes is: an event's title is often someone
else's words.

What leaves the computer: the position to OpenStreetMap (to name it) and, to the
kilometre, to Open-Meteo; calendar links to their own sites; and the town, the
weather and the events above to the model ticked for Talking, with what was said
(the street only when they ask where they are).

Not done: the Mac's own Calendar app (EventKit would take a usage string Electron's
dev bundle doesn't have, and a helper app to ask from); writing to a calendar; the
weather or calendars in tasks the assistant does. Windows' location is Chromium's
there, untested.

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

## Chrome: the link

The extension and the app talk through Chrome's native messaging. The user turns
it on in the extension's Settings › Jester Desktop, whose Link button asks Chrome
for the optional `nativeMessaging` permission; holding it is the switch. Chrome
then starts the relay (`jester-driver`, which acts as one when started with an
extension's origin), the relay reaches the app's socket (`link.js`, a folder only
this user can open, extensions not named turned away), and the extension says
hello with what its gestures do. The app answers, and they're linked. If the app
isn't running, the relay says so and exits, and the extension tries again every
half minute (`chrome.alarms`): an app can't reach an extension by itself. While
linked, the open port keeps its service worker awake. Messages are listed at the
top of `chrome-link.js`.

Linked:

- **One camera and mic.** The extension's engine closes (`ENGINE.LINKED`: a
  purple ● on its toolbar button, "Jester Desktop is watching and listening" in
  its popup) and opens again when the link goes. So with Gestures off in the app,
  there are none in Chrome either.
- **Chrome's gestures with Chrome in front.** The relay names the browser that
  started it (its parent process), and while that app is in front the engine goes
  by the extension's bindings (`engine-host.js`'s `useBindings`), and what they
  trigger on a page, a tab or a video the extension does (`act`). Sleep, voice and
  calibration stay the app's.
- **Browser commands done in Chrome.** A command the matcher doesn't know goes to
  the extension, rather than to the app's assistant, when Chrome is in front, when
  its words are the browser's (a bookmark, a tab, a site's address), or when the
  extension knows the name in "open my …" as a bookmark (`knows`). There it runs
  as a spoken command would, with its own model, its bookmarks, tabs and pages; its
  steps show on the app's pill, a step needing an OK is asked by the app (👍, Allow
  or a spoken yes), and the outcome comes back to be shown or said. The × and
  "stop" stop it. With no Chrome window in view, the last one used comes forward,
  or a new one opens if Chrome has none; the task works in that window's tab even
  while the app's own window (his window, say) keeps the focus.
  In conversation the extension gets the user's own words and what the
  conversation took them to mean (`meant`), as the app's assistant does: "try now"
  or "keep going" means nothing to Chrome by itself. Its planner uses the words,
  and the meaning where the words name nothing it can find; its model sees both.
  "Open my … bookmark" opens the bookmark of that name with no model.
- **One shortcut, one pill.** ⌥⇧J is the app's; pressed in Chrome under another
  binding it opens the app's mic too. The extension's pill stays down.
- **Clicks land on the link aimed at.** A click with Chrome in front asks the
  extension for the link or button nearest the aim (`link-aim` in `content.js`, its
  own cursor's `nearestTarget`, in screen points) before trying the accessibility
  tree. It needs Jester running on the page: the listed sites, or every site with
  "Also run on every other site".

At each launch the app copies the relay to `~/Library/Application
Support/Jester/jester-link-relay` and writes `com.jester.desktop.json` into the
`NativeMessagingHosts` folder of each Chromium browser that's there (Chrome,
Beta, Canary, Chromium, Brave, Edge, Arc, Vivaldi; `link-host.js`), naming the Web
Store's Jester and the development copy; `JESTER_LINK_EXTENSIONS` adds more ids.
Nothing is rewritten unless it changed. A Jester with its own `JESTER_DATA_DIR`
leaves all of that alone and listens only on a `JESTER_LINK_SOCKET` it's given.
Windows needs the relay's named pipe and a registry entry: not built yet.

`node spikes/link-live.mjs` checks it end to end in a throwaway headless Chrome
with the real extension, the real relay and `chrome-link.js`, Chrome's fake camera,
and nothing installed outside a temp folder: 10 of 10 on 2026-11-07, in 2 s. The
whole app was also run against it (a scratch harness): "open my canvas course",
with a bookmark of that name, went to Chrome as its own.

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
   "Jester" under Privacy & Security › Accessibility when asked; the check
   clicks only inside its own window and stops if anything else comes to the
   front. Results: the window, the terminal, `spikes/input-report.json`.
2. **Camera**: `npm run dev:mac`. His window opens saying Jester needs the camera;
   click Set up, then Allow…, and the engine starts. Raise an open palm, make a fist, try a few
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

6. **How it clicks** (the tests script the driver; no real app has been
   clicked this way yet): `npm run driver`, then with a model saved and
   `JESTER_LOG=1`, ask the assistant to "open the second email in Mail" (a
   row selected), to double-click a file in Finder (`act open`), and to
   click something in a window with a sheet open over it (it should refuse,
   naming the sheet). On Windows: a classic Win32 dialog's buttons (the MSAA
   step) and a button behind another window.

7. **The link** (the live check uses a throwaway headless Chrome): in your
   Chrome, open Jester's Settings › Jester Desktop and click Link; Jester's toolbar
   button should turn to a purple ● and Jester's Settings › Chrome say Linked. With
   Chrome in front and Gestures on, a swipe should do what Chrome's Swipes say; "open
   my Canvas" should open the bookmark, with the steps on the app's pill; and a
   cursor click near a link should land on it.

8. **Talking through a cloud model** (*done 2026-11-15: Groq's talked fine*): tick Talking on a saved model in Settings ›
   Models, then `npm run talk-check` to compare it with this computer's on the same
   cases, and talk to him.

9. **Pictures of the window** (the tests fake the capture; the real pipeline
   was run on a made-up screen only): click Allow… on Screen Recording in
   Settings › Permissions, allow it in the list macOS opens, and restart Jester, with a model for actions that
   reads pictures (Gemini, or `qwen3.5:9b`). Start with `JESTER_LOG=1
   JESTER_LOG_SCREENS=1` and ask for something only an icon names, like "like
   this song" in Spotify. The log should say `assistant did: Look at the window`,
   the closing line `· 1 picture`, and `last-picture.jpg` should show the window
   with yellow numbers on its controls and none of Jester's own windows. Then
   check that the Mac doesn't keep a recording indicator up after it.

10. **His voice, and what he knows** (*done 2026-11-15: good; what it found is under "What the first real test found"*; read back by his own recognizer, and
    checked against real models, but never by an ear or a real spoken turn):
    Settings › Assistant and voice › Jester's voice › Hear it, and pick the one
    you like. Then say "Jester, what do you know about me?", "Jester, remember
    that my locker is 12-34-56" and "forget that" (the note should be in the
    Trash), and "Jester, forget that …" with something About me holds. The log
    has `voice loaded: Kokoro`, a `turn:` line for each, and `memory: forgot …`.

11. **Whether you're there** (the idle count and the lock are scripted in the
    checks; the real ones have been read on this Mac only in passing): leave the
    Mac untouched for ten minutes, lock it, unlock it, and read the log for
    `presence: away (quiet for 10 minutes)`, `presence: away (locked)` and
    `presence: here (unlocked), after … away`. Play a film for fifteen minutes
    without touching anything: no `away`. Ask him "how long have I been at
    this?" and compare with what you know. While a long task of his works with
    your hands off the Mac, no `presence: here (keys or mouse)` should appear.

12. **Reminders and timers, out loud** (*done 2026-11-15: they work; a timer now rings, check 17*; typed and scripted in the checks, never
    spoken or heard): say "Jester, set a timer for one minute", and a minute
    later he should say it's up, unasked, over whatever else is quiet. Say
    "Jester, remind me in two minutes to stretch", lock the Mac for five, and
    unlock it: about eight seconds later, "Reminder, from …: stretch."
    Then "done", and the Tasks panel (top left of his window) should show it
    ticked off. The log has `tasks: a timer for 1 minute`, `telling: a line`,
    `telling: they’re away, so a line is held until they’re back`, and
    `tasks: one ticked off, by their saying so`.

13. **What he says unasked** (the lock, the idle count and the calendar are
    scripted in the checks; nothing of it has been heard): tomorrow morning,
    unlock the Mac and wait ten seconds: the morning briefing offer, once, with
    Read/Later/Dismiss under the orb. Say yes or press Read. At the configured
    evening time, the evening offer waits until you are available. Fifteen
    minutes before a class, the calendar check-in still speaks directly. The
    log has `brief: the morning one offered`, and never the briefing contents.

14. **Your phone** (*done 2026-11-15: a reminder reached the phone with the Mac locked*; a pretend server in the checks; Settings' own test did
    reach the real phone, 2026-11-15, and nothing else has): with it turned on
    in Settings › Assistant and voice › Your phone, "Jester, remind me in two
    minutes to stretch", lock the Mac, and the reminder should come to the
    phone, and not be said when you unlock. The log has `telling: a line, to
    their phone`, and never the topic or what was sent.

15. **Your email** (a pretend Google in the checks; no real sign-in or mail has
    been read). Google Cloud's side is set up (project Jester, the Gmail API
    on, yourself a test user, a "Desktop app" client called Jester desktop):
    what's left there is Download JSON on that client. In Jester, Settings › Email:
    Choose the file, then Sign in with Google, and Allow on Google's page (it
    will say Google hasn't verified the app: Continue). Send yourself an email
    from another account: within five minutes, "New email from …", with its
    card. The log has `google: signed in`, `mail: watching from now` and `mail: 1
    new, 1 worth telling`, and never an address, a subject or a key. After seven
    days Google signs him out, and he says so.

16. **A first launch** (the checks run on a scratch profile that already has a
    model; no new Mac has run it): on a Mac that's never had Jester, or a
    second user account on this one, follow SETUP.md from `git clone` to the
    Getting started screen, and note every place it's wrong or unclear. The
    banner should count down as each needed thing is done, and go when the last
    is; a key pasted in Settings › Models should come with Talking ticked; and
    Load unpacked from that copy's `jester-extension` folder should link.

17. **What the first test changed** (built from its log; none of it heard or
    spoken since): ask "Jester, what do you know about me?" and answer his
    question without his name. Set a one-minute timer and let it ring: stop it
    by saying "stop", then another by clicking Stop on the pill, then another
    with a gesture (Gestures on). "Play Gunna's newest song on Spotify": it
    should keep playing while he says so. "Open the second file in my
    Downloads": it should open. The log has `ring: a timer is ringing`,
    `ring: stopped by their saying so`, and for a second press of Play that
    wasn't made, `not pressed twice`.

18. **Jester.app** (built and drawn here; the renamed helpers ran a hidden
    window; it hasn't been run as Jester or asked for anything): quit Jester,
    run `npm run launcher` once, and open him. Since macOS keeps permissions
    by app, it asks again, this time for "Jester": the camera, the microphone,
    Accessibility (Settings › Permissions has the steps), and later Screen
    Recording, Bluetooth, location and the Downloads folder as they're used.
    A keychain prompt for "Jester Safe Storage" may also come up once: Always
    Allow, or his saved models can't be read. The Dock, the menu bar's bold
    name, ⌘-Tab, Activity Monitor and the prompts should all say Jester with
    the raised hand. The old "Electron" rows in System Settings can then go.

19. **This Mac's location** (the module was built and loaded inside Jester.app,
    and read "not determined" for him; it has never asked, or had a
    position): with Settings › Weather and calendars on This Mac's location,
    quit Jester and open him again. macOS should ask whether "Jester" may use
    your location within a second or two of his starting: Allow. Settings
    should then show your town and the weather, and "Jester, where am I?" should
    name your street. If it says no position came, the log has `location:
    none:` and why.

20. **Your chats from Claude and ChatGPT** (built 2026-11-17; your Claude export
    was imported into a scratch vault only, and ChatGPT's format is untested on
    a real export): Settings › Memory › Import…, choose
    `~/Downloads/conversations-000.zip`. It should say about 286 Claude chats
    were added and 194 lines left out, and your vault should have
    `Claude/2023`, `Claude/2025` and `Claude/2026`. Then ask him something only
    one of those chats would know: the model should be told "Your chat with
    Claude …". For ChatGPT: Settings › Data controls › Export data, wait for
    the email, and import its zip the same way; the log has `import: ChatGPT …`.
    (Done by the user 2026-11-17: 1,362 ChatGPT and 286 Claude chats.)

21. **Learning from your chats** (built 2026-11-17; run on 60 of your chats in
    a scratch vault, never on your vault): restart Jester, and give Settings ›
    Memory a few minutes: Search should come back to about 1,660 notes read
    (the index is rebuilt smaller; `vault-index.json` should end near 35 MB,
    not 155). Then click Learn from them. It counts up to 1,648 over about 12
    minutes, then says how many things went into About me (at most 60). Open
    About me and delete what's wrong or what you'd rather he didn't say aloud:
    it won't come back. Then ask "what do you know about me?". The log has
    `learning: done: … chat(s) read, … fact(s) into About me`.

## Things learned the hard way

- Electron's `navigator.geolocation` on a Mac waits for Location Services to
  allow it and never asks: Chrome asks from its own layer, which Electron
  doesn't have. The page timed out, and macOS never showed its question. Jester
  asks Core Location himself (`native/jester-location`).

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
- npm's Electron.app is ad-hoc signed, and so is Jester.app, its renamed copy;
  macOS ties the permissions it grants to that exact build, so they reset when
  Electron is upgraded.
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
- A relay Chrome starts from `~/Downloads`, where this repo lives on the
  development Mac, never gets past macOS's loader: it waits forever to open
  its own file, as macOS guards that folder (2026-11-07; the spike had passed
  on 2026-10-21). Copied to a temp folder, the same binary passes every check,
  so the spike runs it from there, and the link must install the relay outside
  ~/Downloads, ~/Desktop and ~/Documents.
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
