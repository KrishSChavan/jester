# Jester Desktop

The Electron app that takes Jester beyond Chrome: the real cursor, the
keyboard, media keys and other apps, driven by the same gestures, eye/head
pointing and voice. The extension stays, and links to the app.

**Status: phase 0 (spikes).** The four unknowns are answered below; nothing is
wired to the OS yet beyond the test harnesses.

## Layout

| Path | What it is |
|---|---|
| `src/main/main.js` | App entry. Runs the extension's engine page unchanged in a hidden window. |
| `src/preload/chrome-shim.cjs`, `src/main/chrome-bridge.js` | The slice of `chrome.runtime` / `chrome.storage` the extension's pages use, over IPC. |
| `src/main/engine-host.js` | The service worker's half of the engine: settings, gestures, cursor, voice. |
| `src/main/protocol.js`, `files.js` | `jester://ext/…` serves the extension folder, `jester://app/…` this app's pages. |
| `src/main/speech/` | Offline speech (sherpa-onnx) in a `utilityProcess`. |
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
- `JESTER_FAKE_MEDIA=1` — Chromium's synthetic camera and mic; no prompts.

## Phase 0 results (MacBook Pro, Apple silicon, macOS 26)

| Question | Answer |
|---|---|
| Does the extension's engine run in Electron unchanged? | Yes. GPU delegate, 19–20 fps in a hidden window, ~3% CPU and ~660 MB across processes with the synthetic camera. A real camera still to measure. |
| Can speech run offline in the app? | Yes: Parakeet 110M (CC-BY-4.0) + Silero VAD in a utilityProcess. Loads in 0.5 s; text arrives a median 0.71 s after you stop talking (0.6 s of that is the end-of-speech pause). 37/44 synthetic commands exact; the misses are short words and brand names ("mute", "Spotify"). |
| Can the app move the cursor, click, type? | On the Mac, yes, all checked on real input: 9/9 clicks on target (~7 ms per request), Unicode text intact, ⌘A + Backspace, double-click, wheel scrolling under the cursor, and the accessibility tree naming a button and a field (once Chromium has built it, ~2 s after being asked). Windows: type-checks only. |
| Can the extension and the app talk? | Yes, through native messaging: 5 ms round trips, pushes both ways, a clear message when the app isn't running, and the open port keeps the extension's service worker alive. |

Model comparison (`node scripts/speech-bench.mjs <folder>`), 44 synthetic commands:
Parakeet 110M 39/44, WER 7.1%; Kroko streaming 39/44, WER 7.3% (licence
CC-BY-SA, marketed for hobby use); Moonshine tiny 35/44, WER 14.8%. All decode
in under 35 ms.

## Checks that need you at the Mac

1. **Input**: `npm run dev:mac -- spikes/input-in-electron.mjs`. Allow
   "Electron" under Privacy & Security › Accessibility when asked; the check
   clicks only inside its own window and stops if anything else comes to the
   front. Results: the window, the terminal, `spikes/input-report.json`.
2. **Camera**: `npm run dev:mac`, allow the camera, then raise an open palm,
   make a fist, and try a few bound gestures; triggers appear in the log.

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
