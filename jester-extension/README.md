# Jester — hand gesture video control

A Chrome (Manifest V3) extension that watches your webcam with **MediaPipe's
Gesture Recognizer** and turns hand poses and swipes into playback commands on
YouTube, Netflix, Hulu, Disney+, Prime Video and friends.

Everything runs on-device. The extension makes no network requests at all — the
WASM runtime and the `.task` model are bundled in this folder.

---

## Install and test locally

1. Unzip this folder somewhere permanent (Chrome reads the files from disk every
   time it starts, so don't leave it in a temp directory).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `jester-extension` folder — the one
   containing `manifest.json`.
5. The options page opens automatically. Click **Allow camera access** and
   accept Chrome's prompt. **Don't skip this** — the engine runs in an offscreen
   document that has no UI, so it can't raise the prompt itself. It has to happen
   in a real tab.
6. Flip **Enabled** on (in the options page header, or in the toolbar popup).
7. Open a YouTube video and hold an open palm ✋ steady at your camera for about
   half a second.

Pin the extension to the toolbar to get the popup: it shows a live camera
preview with the hand skeleton, the gesture being recognised, the hold progress
bar, the achieved frame rate, and a log of recent actions. That popup is the
fastest way to tell whether a gesture isn't registering versus registering but
not firing.

## Default gestures

| Gesture | Action |
| --- | --- |
| ✋ Open palm (hold) | Play / pause |
| ✌️ Victory (hold) | Mute / unmute |
| 👍 Thumb up (hold) | Volume up — repeats while held |
| 👎 Thumb down (hold) | Volume down — repeats while held |
| ☝️ Pointing up (hold) | Skip ad / skip intro |
| ➡️ Swipe right | Skip forward 10s |
| ⬅️ Swipe left | Skip back 10s |
| ⬆️ / ⬇️ Swipe up / down | Volume up / down |

✊ Closed fist and 🤟 ILoveYou are unbound by default — free slots for you.

Every binding, and every threshold below, is editable in the options page.

## How recognition works

Two channels run over the same landmark stream:

**Held poses.** A pose has to stay above the confidence floor *and* stay
reasonably still for `holdMs` before it fires. Once fired it won't fire again
until you drop the pose (or, for actions marked *repeat while held*, it re-fires
every `repeatMs`). The stillness requirement is what keeps you from triggering
play/pause every time you raise an open hand to swipe.

**Swipes.** The palm centre is tracked over a short rolling window. If it
crosses `swipeMinDistance` of the frame within `swipeMaxDurationMs`, and the
dominant axis beats the other by `swipeAxisRatio`, that's a swipe. Swipes win
over poses and reset the pose state machine. Directions are mirrored, so moving
your hand to *your* right is "swipe right".

A global `cooldownMs` sits after every action so one gesture can't machine-gun.

### Tuning notes

- Gestures firing by accident → raise **Confidence floor** or **Hold time**.
- Gestures not firing → lower **Confidence floor**, and check the popup's fps
  readout; below ~8 fps the swipe window gets too few samples.
- Swipes not registering → lower **Swipe distance** or raise **Swipe window**.
- Laptop fan spinning up → drop **Inference rate** to 12–15 fps. Gesture
  recognition doesn't need 30.

## Supported sites

Enabled out of the box: YouTube, Netflix, Hulu, Disney+ / Hotstar, Prime Video,
Max, Peacock, Paramount+, Crunchyroll, Twitch, Vimeo, Apple TV.

For anything else, tick **"Also run on every other site with a video"** in the
options page. That asks for a broad host permission at the moment you click it,
and registers the content script dynamically — reload open tabs afterwards.

Play/pause, seeking, volume, speed and mute go straight to the `<video>` element
on most sites. Netflix is the exception: its player snaps `currentTime` back, so
seeking and play/pause route through `src/content/page-bridge.js`, which runs in
the page's main world and drives Netflix's own player API.

## Fullscreen

`Element.requestFullscreen()` is gated on *transient user activation*, and a
gesture recognised in the offscreen document has none. No extension permission
lifts that — so `FULLSCREEN_TOGGLE` routes through the service worker
(`toggleFullscreen()`), which tries three things in order:

1. **Native.** If the user happens to have clicked in the page in the last few
   seconds, `navigator.userActivation.isActive` is still true and the content
   script can just call `requestFullscreen()`. Free, and the best result.
2. **True fullscreen** (opt-in, **Settings → Fullscreen**). Attaches
   `chrome.debugger` and runs `Runtime.evaluate` with `userGesture: true`, which
   forges real activation, so the site's own fullscreen engages. Costs the
   optional `debugger` permission and a brief "being debugged" bar, and cannot
   attach while DevTools is open on that tab.
3. **Cinema mode** (default). `chrome.windows.update(id, {state:'fullscreen'})`
   needs no activation at all, so the *window* goes fullscreen; the content
   script then pins the player to the viewport with a stylesheet. Visually the
   same as the real thing, with no extra permission.

Cinema mode ends on Escape (the content script forwards it, since nothing is
natively fullscreen for Chrome to handle) or when the user leaves window
fullscreen themselves, watched via `(display-mode: fullscreen)`.

The overlay neutralises `transform` / `filter` / `contain` on every ancestor of
the player, because any of those would trap a `position: fixed` element.

## Known limitations

- **Cinema mode is CSS over a site's own layout.** It works on the built-in
  sites; a player with an unusual structure may need its selector added to
  `fullscreenTarget()` in `src/content/content.js`.
- **Skip ad / next episode rely on site-specific selectors** (in
  `src/content/content.js`). Streaming sites reshuffle their DOM regularly; if
  one stops working, that selector list is the place to fix it.
- **One camera at a time.** If Zoom or Teams has the camera, the engine reports
  "camera is already in use".
- **Seven poses only.** These are MediaPipe's canned gestures. Adding your own
  (e.g. a flat "L" for chapters) means training a custom classifier and pointing
  `MODEL_PATH` at it.
- The camera runs in an offscreen document. If the frame rate shown in the popup
  is far below your **Inference rate** setting, that's Chrome throttling the
  background page — lower the target rate rather than fighting it.

## Layout

```
manifest.json
models/gesture_recognizer.task        MediaPipe canned-gesture model (8 MB)
vendor/tasks-vision/                  MediaPipe Tasks Vision 1.0.0 + WASM runtime
src/
  common/constants.js                 settings schema, action list, message types
  background/service-worker.js        offscreen lifecycle, target tab resolution,
                                      action dispatch, HUD relay
  offscreen/offscreen.js              camera + inference + gesture state machine
  content/content.js                  video discovery, action execution, on-page HUD
  content/page-bridge.js              Netflix player API bridge (main world)
  popup/                              toolbar popup: preview, status, history
  options/                            all settings, gesture bindings, camera setup
  ui/ui.css                           shared styles
```

Repack with `..\build-zip.ps1` from the parent folder — it validates the
manifest, the HTML references, the runtime assets and the JavaScript before
writing anything. `-Flat` produces the layout the Chrome Web Store expects.

The division of labour worth knowing: **all gesture logic lives in the offscreen
document**, not the service worker. A service worker gets evicted while idle,
which would wreck any per-frame state machine; the offscreen document is a
long-lived page, so it owns the camera, the inference loop, the hold timers and
the swipe buffer. The worker only decides *which tab* should receive an
already-made decision.

## Privacy

Camera frames stay inside the offscreen document. Nothing is recorded, stored or
uploaded. The only data that leaves that document is the name of a recognised
gesture and a downscaled preview image — and the preview is only produced while
the popup is actually open. There are no network permissions and no remote code;
MV3 forbids it and nothing here needs it.

## Updating the bundled MediaPipe assets

```bash
npm install @mediapipe/tasks-vision@latest
cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs vendor/tasks-vision/
cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.* vendor/tasks-vision/wasm/
```

Only the SIMD build is bundled (every Chrome that supports MV3 supports WASM
SIMD). If you ever need the fallback, also copy `vision_wasm_nosimd_internal.*`
— `FilesetResolver` picks it automatically when SIMD is missing.

The model came from:
`https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task`

## Troubleshooting

**Debugging tool you'll want first:** open `chrome://extensions`, find Jester, and
under **Inspect views** click `offscreen.html`. That's the engine's console —
camera and model errors show up there. `service worker` next to it is the other
half.

| Symptom | Cause |
| --- | --- |
| Stuck on "Starting…", no preview | Camera access was never granted. The engine runs in an offscreen document, which has no UI, so Chrome has nowhere to show the prompt — `getUserMedia` just never returns. Grant access from the **options page** (a real tab), then hit **Restart** in the popup. The engine now checks the permission up front and says so instead of hanging. |
| Popup says "Camera access needed" | Same fix: grant it from the options page. If you previously *blocked* it, use the padlock icon in the address bar of that options tab to re-allow, then Restart. |
| Preview is black, status "Running" | Another app holds the camera, or you picked a device that's gone. Try **Restart** in the popup. |
| Gesture recognised but nothing happens | No target video was found. The popup footer says "no video tab" when that's the case. Reload the video tab. |
| Nothing works after installing | Tabs opened *before* the extension loaded have no content script. The worker re-injects on demand, but reloading the tab is the reliable fix. |
| Actions fire twice | Cooldown is too short for your hold time, or two frames both claim a video. Raise **Cooldown**. |
