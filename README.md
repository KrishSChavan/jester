# Jester

Control video playback with your hands. Jester is a Chrome extension that watches
your webcam, recognises hand poses and swipes with **MediaPipe's Gesture
Recognizer**, and turns them into play/pause, seek, volume and mute commands on
YouTube, Netflix, Hulu, Disney+, Prime Video and a dozen other streaming sites.

Everything runs on-device. The WASM runtime and the `.task` model are bundled in
the repo, the extension declares no network permissions, and no frame ever leaves
your machine.

```
✋ hold  →  play / pause          ➡️ swipe  →  skip forward 10s
✌️ hold  →  mute / unmute         ⬅️ swipe  →  skip back 10s
👍 hold  →  volume up             ⬆️ ⬇️ swipe →  volume up / down
☝️ hold  →  skip ad
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
5. Flip **Enabled** on, open a YouTube video, and hold an open palm ✋ steady at
   the camera for about half a second.

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

Two recognition channels run over the same landmark stream:

- **Held poses** — a pose must stay above the confidence floor *and* stay
  reasonably still for `holdMs` before it fires, then won't re-fire until you
  drop it (or re-fires every `repeatMs` for volume/seek). The stillness
  requirement is what stops you triggering play/pause every time you raise a
  hand to swipe.
- **Swipes** — the palm centre is tracked over a rolling window. Cross
  `swipeMinDistance` of the frame within `swipeMaxDurationMs` with one axis
  beating the other by `swipeAxisRatio`, and that's a swipe. Swipes win over
  poses and reset the pose state machine.

A global `cooldownMs` sits after every action so one gesture can't machine-gun.
Every threshold, and every gesture binding, is editable in the options page.

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
jester-extension.zip            packaged build of the same folder
```

## Privacy

Camera frames stay inside the offscreen document — nothing is recorded, stored or
uploaded. The only things that leave it are the *name* of a recognised gesture
and a downscaled preview image, and the preview is only produced while the popup
is actually open. There are no network permissions and no remote code; MV3
forbids it and nothing here needs it.

## Known limitations

- **Entering fullscreen doesn't work.** Chrome only grants fullscreen off a real
  user gesture, and a webcam gesture isn't one. *Exiting* works fine.
- **Skip ad / next episode rely on site-specific selectors.** Streaming sites
  reshuffle their DOM regularly; the selector list in `src/content/content.js` is
  where to fix it.
- **One camera at a time.** If Zoom or Teams holds the camera, the engine reports
  "camera is already in use".
- **Seven poses only** — MediaPipe's canned set. Adding your own means training a
  custom classifier and repointing `MODEL_PATH`.

## More

[jester-extension/README.md](jester-extension/README.md) has the full reference:
every default binding, tuning notes for when gestures misfire or don't register,
the supported-site list and how to enable Jester everywhere else, the Netflix
seeking workaround, instructions for updating the bundled MediaPipe assets, and a
troubleshooting table.
