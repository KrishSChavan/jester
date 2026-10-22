# Jester Desktop

The Electron app that takes Jester beyond Chrome: the real cursor, the
keyboard, media keys and other apps, driven by the same gestures, eye/head
pointing and voice. The extension stays, and links to the app.

**Status: phase 4 (voice).** Jester runs from the menu bar;
gestures press the OS's own keys, an overlay shows what they did, and with
Cursor control on, an open palm raises the real cursor: your eyes or head aim
it, closing the hand clicks. ☝️ (or ⌥⇧J, or the menu) opens the mic for one
spoken command, recognized on this computer. Linking the extension (phase 5)
is next. Phase 0's answers are below.

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
| `src/main/overlay.js`, `src/overlay/` | Click-through windows over every display: hold progress, toasts, the cursor ring. |
| `src/main/pointer.js`, `pointer-math.js` | The real cursor: placing, easing, freezing the aim, clicking with aim assist. |
| `src/preload/chrome-shim.cjs`, `src/main/chrome-bridge.js` | The slice of `chrome.runtime` / `chrome.storage` the extension's pages use, over IPC. |
| `src/main/engine-host.js` | The service worker's half of the engine: settings, gestures, cursor, voice. |
| `src/main/protocol.js`, `files.js` | `jester://ext/…` serves the extension folder, `jester://app/…` this app's pages. |
| `src/main/speech.js`, `src/main/speech/` | Offline speech (sherpa-onnx) in a `utilityProcess`, fed by the engine page's stand-in `SpeechRecognition` (in the preload). |
| `src/main/voice-commands.js`, `voice-runner.js`, `apps.js` | What a sentence means, and doing it: actions, apps, volume, keys, typing, clicks, Shortcuts. |
| `src/worklets/` | The mic for speech, captured on the audio thread; served to the engine page as `jester://ext/_desktop/worklets/…`. |
| `src/main/driver.js`, `native/jester-driver/` | Rust helper for OS input and the accessibility tree, JSON lines over stdio. Also Chrome's native-messaging relay. |
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
event, document), "play Gunna" (Spotify's search, else YouTube's: picking the
song is left to you until the assistant), "search for …" / "search YouTube
for …", and "run shortcut …" (macOS Shortcuts). App names are matched
forgivingly against what is installed and running, so "spot of fire" still
opens Spotify.

A sentence can hold several steps — "open a new note and write hello
world" — cut at "and" / "then" only where every piece is a command
(dictation keeps its "and": "type salt and pepper"). Steps run in order;
after one brings an app forward, the next waits until it's in front, and
nothing is typed if it never gets there. A sentence understood only in part
does nothing and says which part. Anything else says it isn't a command yet;
phase 6's assistant will take those.

Apps open through LaunchServices (`open -a`) on macOS and quit or hide
through `NSRunningApplication` (jester-driver's `quitApp`/`hideApp`), so no
Automation permission is asked for. On Windows, running apps are brought
forward by the driver and others are found by typing into the Start menu.

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
- sherpa-onnx hotwords (contextual biasing) don't work with this package:
  without the model's `bpe.vocab`, phrases must be written as the model's
  pieces, and sherpa-onnx splits a piece like `▁St` into `▁` + `St`, which
  aren't pieces; one bad phrase and it skips them all.
