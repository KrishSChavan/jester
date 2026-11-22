# Building from source

For working on Jester, or running him from a checkout instead of the download.

## What you need

- **Node.js 22.12 or newer.**
- **Rust** ([rustup.rs](https://rustup.rs)), for `jester-driver`, the helper
  that clicks, types and reads windows.
- **On a Mac:** Apple's command line tools (`xcode-select --install`), which
  give `git`, `clang` and `swiftc`.
- **On Windows:** the MSVC build tools that Rust's installer asks for.

## Jester Desktop

```sh
git clone https://github.com/KrishSChavan/jester.git
cd jester/desktop
npm install
npm run driver          # builds jester-driver
npm start               # runs him
```

The first run downloads the speech models into `desktop/models/` (about
500 MB), exactly as the installed app does. `npm run models` does the same
from the terminal.

On a Mac, the better way to run him day to day:

| Command | What it does |
|---|---|
| `npm run launcher` | Once: puts a **Jester** app in Applications that starts this checkout. Open it like any app. |
| `npm run dev:mac` | Starts him through `open`, so macOS asks for permissions on behalf of “Jester” rather than your terminal, and echoes his log. |
| `npm start` | Starts him from the terminal. macOS counts him as part of the terminal for permissions. |

Other scripts, all run from `desktop/`:

| Command | |
|---|---|
| `npm run models -- parakeet-0.6b` | Fetch a model by name (this one is the Accurate recognizer) |
| `npm run watch` | Build the Apple Watch's Bluetooth bridge (Mac) |
| `npm run location` | Build the Location Services module (Mac; `npm start` builds it too) |
| `npm run icons` | Redraw every copy of his icon from `scripts/make-icons.mjs` |
| `npm run scraping:setup -- --browser` | Set up the local page reader for background research (needs Python 3.10+) |
| `npm run live-check` | The real app on a scratch profile with scripted models, typed to and read back |
| `npm run brain-check` | Carries real requests through the conversation with your saved Claude model and pretend hands: which tool he chose, what he said, how soon. About a cent a run. See [his tools](tools.md). |
| `npm run talk-check`, `hear-check`, `speed-check`, `voice-check`, `task-check` | Measure how well and how fast he talks, hears, speaks and acts. `task-check` acts for real. |

Environment variables for tests and development are listed at the top of
[`desktop/src/main/main.js`](../desktop/src/main/main.js). The useful ones:
`JESTER_LOG=1` (log), `JESTER_DATA_DIR=<folder>` (a scratch profile),
`JESTER_FAKE_MEDIA=1` (no real camera or microphone), `JESTER_DRIVER_DRY=1`
(describe input instead of sending it).

How it's put together, file by file: [desktop/README.md](../desktop/README.md).

## The Chrome extension

There's no build step. In `chrome://extensions`, turn on **Developer mode**,
press **Load unpacked**, and choose the [`jester-extension/`](../jester-extension/)
folder. After changing code, press the reload arrow on its card and refresh
the page you're testing on.

Jester Desktop run from the same checkout recognizes an extension loaded from
that folder, so the two can be linked.

`npm run zip` (from the repository root) checks the extension against the Web
Store's limits and writes `dist/jester-extension-<version>.zip` for upload.
[`store/listing.md`](../store/listing.md) has the listing text and the
submission steps. Every upload needs a higher `version` in `manifest.json`.

## Tests

```sh
npm test            # from the repository root
```

About 1,600 tests for both the extension and the desktop app, in
[`tests/`](../tests/). They use scripted browsers, models and native modules:
no camera, microphone, account or paid model is needed, and nothing on your
computer is touched. They need `desktop/node_modules` (run `npm install` in
`desktop/` first).

`npm run live-check` (from `desktop/`) goes further: it runs the real app,
main process and windows, against model servers the script controls. Its
timing-sensitive scenarios (ringing timers, briefs) can fail on a busy
machine; run a failing one again by name (`npm run live-check -- ring`).

## Packaging the downloads

```sh
cd desktop
npm run dist                 # a .dmg and .zip on a Mac; a setup .exe on Windows, in dist/
npm run dist -- --dir        # just the unpacked app, quicker
npm run dist-check           # starts the packaged app on a scratch profile and reads his log
```

`npm run dist` ([`scripts/pack.mjs`](../desktop/scripts/pack.mjs)) builds the
native helpers for the platform it runs on, then runs electron-builder with
[`electron-builder.yml`](../desktop/electron-builder.yml). What goes where in
the installed app is described at the top of
[`src/main/boot.js`](../desktop/src/main/boot.js).

`npm run dist-check` is what tells a build that works from one that only
compiled: it launches the packaged app with pretend models served locally (or
`--real-models` to download the real ones, or `--models <folder>` to use ones
you have) and checks that he starts as an installed app, his helper answers,
the gesture engine loads, and he fetches and unpacks his models.

Neither build is signed with a paid certificate. On a Mac the app is signed
ad hoc, which Apple silicon requires; to sign properly, set `CSC_LINK` and
`CSC_KEY_PASSWORD` to a Developer ID certificate, remove `identity: "-"` from
`electron-builder.yml`, and add notarization.

## Making a release

1. Set the new version in `desktop/package.json`.
2. Write its notes in `docs/releases/v<version>.md`.
3. Commit, then tag and push:

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

The [Build Jester workflow](../.github/workflows/release.yml) then builds the
Mac and Windows downloads on GitHub's machines, runs the tests, starts each
build with the real speech models, and publishes them as a GitHub Release.
The README's download links point at the latest release, so they need no
editing.

To build without publishing, run the workflow by hand: **Actions › Build
Jester › Run workflow**. The downloads are kept with the run for a week.

## What Jester is built on

| | License |
|---|---|
| [Electron](https://www.electronjs.org) | MIT |
| [MediaPipe](https://developers.google.com/mediapipe) hand, gesture and face models (in `jester-extension/vendor` and `models`) | Apache-2.0 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), which runs the speech models | Apache-2.0 |
| NVIDIA Parakeet TDT (speech recognition; downloaded on first run) | CC-BY-4.0 |
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) v1.0 (his voice; downloaded on first run) | Apache-2.0 |
| Silero VAD, NeMo TitaNet (downloaded on first run) | MIT, CC-BY-4.0 |
| [ical.js](https://github.com/kewisch/ical.js), [ws](https://github.com/websockets/ws) | MPL-2.0, MIT |
| Thinking orbs (`desktop/src/vendor/thinking-orbs`) | MIT |

Jester's own code is [MIT](../LICENSE).
