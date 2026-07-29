# Jester

Control video playback with your hands. Jester is a Chrome extension that watches
your webcam, recognises hand poses and swipes with **MediaPipe's Gesture
Recognizer**, and turns them into play/pause, seek, volume and mute commands on
YouTube, Netflix, Hulu, Disney+, Prime Video and a dozen other streaming sites.

Everything runs on-device. The WASM runtime and the `.task` model are bundled in
the repo, the extension declares no network permissions, and no frame ever leaves
your machine.

```
✋ hold  →  play                  ➡️ swipe  →  skip forward 10s
✊ hold  →  pause                 ⬅️ swipe  →  skip back 10s
✌️ hold  →  mute / unmute         ⬆️ ⬇️ swipe →  volume up / down
👍 hold  →  volume up             🤟 hold   →  fullscreen
☝️ hold  →  skip ad               🖐 half-open hand → move the cursor, 👌 pinch to click
```

## Quick start

1. Clone this repo (or unzip `jester-extension.zip`) somewhere permanent —
   Chrome re-reads these files from disk on every launch, so a temp folder will
   break the extension later.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select the [jester-extension/](jester-extension/) folder,
   the one containing `manifest.json`.
4. The options page opens automatically. Click **Allow camera access** and accept
   Chrome's prompt. **Don't skip this step** — the engine lives in an offscreen
   document with no UI, so it can't raise the prompt itself; it has to happen in
   a real tab.
5. Flip **Enabled** on, open a YouTube video, and hold a closed fist ✊ steady at
   the camera for about half a second — it should pause. Open palm ✋ starts it
   again.

Pin Jester to the toolbar for the popup: a live preview with the hand skeleton
drawn on it, the gesture currently recognised, hold progress, achieved frame
rate, and a log of recent actions. It's the fastest way to tell "the gesture
isn't being recognised" apart from "it's recognised but nothing fired".

Requires Chrome 116+ (Manifest V3, offscreen documents).

## How it works

Three contexts, one deliberate split:

```
┌─ offscreen document ─────────┐   gesture decisions   ┌─ service worker ──┐
│  camera → MediaPipe → state  │ ────────────────────► │  which tab wins?  │
│  machine (holds + swipes)    │                       └─────────┬─────────┘
└──────────────────────────────┘                                 │ action
        frames never leave here                                  ▼
                                                    ┌─ content script ─────┐
                                                    │  drive the <video>   │
                                                    └──────────────────────┘
```

**All gesture logic lives in the offscreen document**, not the service worker.
A worker gets evicted while idle, which would wreck any per-frame state machine;
the offscreen document is a long-lived page, so it owns the camera, the inference
loop, the hold timers and the swipe buffer. The worker only decides *which tab*
receives an already-made decision, and relays the on-page HUD.

Three recognition channels run over the same landmark stream:

- **Held poses** — a pose must stay above the confidence floor *and* stay
  reasonably still for `holdMs` before it fires, then won't re-fire until you
  drop it (or re-fires every `repeatMs` for volume/seek). The stillness
  requirement is what stops you triggering play/pause every time you raise a
  hand to swipe.
- **Swipes** — the palm centre is tracked over a rolling window. Cross
  `swipeMinDistance` of the frame within `swipeMaxDurationMs` with one axis
  beating the other by `swipeAxisRatio`, and that's a swipe. Swipes win over
  poses and reset the pose state machine.
- **Pointer** — a half-open hand raises a cursor, and a thumb-to-index pinch
  clicks it. It outranks both of the above: while you are steering, nothing else
  can fire. See below.

A global `cooldownMs` sits after every action so one gesture can't machine-gun.
Every threshold, and every gesture binding, is editable in the options page —
including **Turn Jester off**, unbound by default, which stops the camera on a
gesture. That one is one-way: with the camera down nothing can recognise a
gesture to switch it back, so switching on stays with the popup.

## Pointer

```
🖐  hand half open — relaxed, neither flat nor a fist  →  cursor appears, follows your hand
👌  touch thumb and index fingertip together           →  click
    flatten or close your hand                         →  cursor goes away
```

An extension cannot move your *operating system's* cursor — nothing in the
Chrome API surface reaches outside the browser, so that stays on the roadmap for
the desktop app. What Jester can do is draw a cursor on the page and synthesise
the pointer and mouse events the page would otherwise have seen: links, buttons,
menus and player controls all respond, and hover-driven UI (YouTube's control
bar, dropdowns) comes alive as it passes.

Both shapes are measured off the raw landmarks rather than classified by the
model — MediaPipe's canned set has neither. Each finger is scored on how far its
tip reaches from the wrist relative to its own knuckle, which puts a flat palm
at 1, a fist at 0 and a relaxed hand near the middle. Two tests then have to
agree: the average sits near half open, *and* the fingers are curled to similar
degrees. The second is what rules out ✌️, ☝️ and 🤟 — they average out to half
open while being nothing of the sort. Pinching is the thumb-to-index gap
measured in palm widths, with separate close and release points so a hand
hovering on the threshold can't machine-gun clicks.

Because a pinch curls the index finger, clicking would otherwise deform the hand
out of the steering shape — so once the cursor is up, a held pinch keeps it up
on its own. Position runs through a one-euro filter: still when your hand is,
and no lag when it isn't.

**Settings → Pointer** has hand tolerance, pinch distance, reach and smoothing.
Open the popup while steering — it draws the active area and hot spot on the
camera preview, and the ring around the cursor fills as your fingers close,
which is the quickest way to tune both.

## Layout

```
jester-extension/               the extension — load this unpacked
  manifest.json
  models/gesture_recognizer.task   MediaPipe canned-gesture model (8 MB)
  vendor/tasks-vision/             MediaPipe Tasks Vision 1.0.0 + WASM runtime
  src/
    common/constants.js            settings schema, action list, message types
    background/service-worker.js   offscreen lifecycle, target tab, dispatch
    offscreen/offscreen.js         camera + inference + gesture state machine
    content/content.js             video discovery, action execution, on-page HUD
    content/page-bridge.js         Netflix player API bridge (main world)
    popup/  options/  ui/          toolbar popup, settings, shared styles
build-zip.ps1                   validates the extension, then repacks the zip
jester-extension.zip            packaged build of the same folder
```

## Rebuilding the zip

```powershell
.\build-zip.ps1
```

It validates before packing — the manifest parses and every path it names
exists, the HTML pages' `src`/`href` references resolve, the model and WASM
assets are present, and every first-party `.js` parses. A failure exits non-zero
and leaves the existing zip alone.

| flag | |
| --- | --- |
| `-Flat` | put `manifest.json` at the zip root, which the Chrome Web Store requires |
| `-Versioned` | name it after the manifest version, e.g. `jester-extension-0.1.0.zip` |
| `-IncludeDevFiles` | keep the source map and `.d.ts` (excluded by default, ~0.5 MB) |
| `-Output <path>` | write somewhere other than `jester-extension.zip` |
| `-SkipChecks` | pack without validating |

## Privacy

Camera frames stay inside the offscreen document — nothing is recorded, stored or
uploaded. The only things that leave it are the *name* of a recognised gesture
and a downscaled preview image, and the preview is only produced while the popup
is actually open. There are no network permissions and no remote code; MV3
forbids it and nothing here needs it.

## Fullscreen

Chrome only grants `requestFullscreen()` off a real user gesture, and a webcam
gesture isn't one. Jester goes around it: by default it puts the *browser window*
into fullscreen — an API with no gesture requirement — and pins the player to
fill it, which looks the same and costs no extra permission. **Settings →
Fullscreen** can switch to true fullscreen, which borrows Chrome's debugger to
hand the page a real gesture. Either way, Escape gets you out.

## Known limitations

- **Cinema mode is CSS layered over the site's own player.** It works on the
  built-in sites; an unusual player may need its selector added.
- **Skip ad / next episode rely on site-specific selectors.** Streaming sites
  reshuffle their DOM regularly; the selector list in `src/content/content.js` is
  where to fix it.
- **One camera at a time.** If Zoom or Teams holds the camera, the engine reports
  "camera is already in use".
- **Seven poses only** — MediaPipe's canned set, plus the pointer shapes, which
  are measured geometrically. Adding more means training a custom classifier and
  repointing `MODEL_PATH`.
- **The pointer is a page cursor, not the system cursor.** It can't leave the
  tab, reach Chrome's own UI, or click through into a cross-origin iframe — the
  click lands on the iframe element, not inside it. Its events are synthetic and
  therefore untrusted, so they can't unlock anything gated on real user
  activation (the site's own fullscreen button, clipboard, sound-on autoplay).

## More

[jester-extension/README.md](jester-extension/README.md) has the full reference:
every default binding, tuning notes for when gestures misfire or don't register,
the supported-site list and how to enable Jester everywhere else, the Netflix
seeking workaround, instructions for updating the bundled MediaPipe assets, and a
troubleshooting table.
