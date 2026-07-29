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
7. Open a YouTube video and hold a closed fist ✊ steady at your camera for about
   half a second — it should pause. An open palm ✋ starts it again.

Pin the extension to the toolbar to get the popup: it shows a live camera
preview with the hand skeleton, the gesture being recognised, the hold progress
bar, the achieved frame rate, and a log of recent actions. That popup is the
fastest way to tell whether a gesture isn't registering versus registering but
not firing.

## Default gestures

| Gesture | Action |
| --- | --- |
| ✋ Open palm (hold) | Play |
| ✊ Closed fist (hold) | Pause |
| 🤟 ILoveYou (hold) | Fullscreen toggle |
| ✌️ Victory (hold) | Mute / unmute |
| 👍 Thumb up (hold) | Volume up — repeats while held |
| 👎 Thumb down (hold) | Volume down — repeats while held |
| ☝️ Pointing up (hold) | Skip ad / skip intro |
| ➡️ Swipe right | Skip forward 10s |
| ⬅️ Swipe left | Skip back 10s |
| ⬆️ / ⬇️ Swipe up / down | Volume up / down |
| 🖐 Hand held half open | Move the cursor — see [Pointer](#pointer) |
| 👌 Thumb and index touching | Click, while the cursor is up |

Play and pause are separate poses rather than one toggle, so a missed hold can
never leave you fighting the video — repeat the pose and you still get what you
asked for.

All seven canned poses are bound out of the box; set any of them to **Do
nothing** to free the slot. Every binding, and every threshold below, is
editable in the options page.

One action worth knowing about is unbound by default: **Turn Jester off** stops
the camera on a gesture. It is one-way — with the camera down nothing can
recognise a gesture to switch it back — so switching on stays with the toolbar
popup and the options page. The
two pointer shapes are the exception: they drive a mode rather than firing an
action, so they aren't in the bindings table.

## How recognition works

Three channels run over the same landmark stream:

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

**Pointer.** A half-open hand raises a cursor; a thumb-to-index pinch clicks it.
It outranks the other two: while you steer, no pose may fire and no swipe may
register, so sweeping across the screen can't seek the video. Details below.

A global `cooldownMs` sits after every action so one gesture can't machine-gun.

### Tuning notes

- Gestures firing by accident → raise **Confidence floor** or **Hold time**.
- Gestures not firing → lower **Confidence floor**, and check the popup's fps
  readout; below ~8 fps the swipe window gets too few samples.
- Swipes not registering → lower **Swipe distance** or raise **Swipe window**.
- Laptop fan spinning up → drop **Inference rate** to 12–15 fps. Gesture
  recognition doesn't need 30. The pointer is the exception — it's the one
  feature that visibly benefits from 20+.

## Pointer

Hold your hand half open — fingers relaxed and curled, neither a flat palm nor a
fist — for `pointerArmMs`, and a cursor appears. Move your hand to steer it.
Touch your thumb and index fingertip together to click. Flatten or close your
hand and it fades.

**An extension cannot move the operating system's cursor.** Nothing in the
Chrome API surface reaches outside the browser, and no permission changes that —
it's the reason a desktop app is on the roadmap. So the content script draws its
own cursor in a shadow root and synthesises the events the page would have seen:
`pointerover` / `mouseover` on entering an element, `pointermove` / `mousemove`
every frame (which is what makes YouTube's control bar appear), and a full
`pointerdown → mousedown → focus → pointerup → mouseup → click` sequence on a
click. Ordinary handlers can't tell the difference, but the events are untrusted,
so they can't unlock anything gated on real user activation — the site's own
fullscreen button, clipboard writes, sound-on autoplay.

### Detecting the shapes

MediaPipe's canned set has neither shape, and adding them would mean training a
classifier, so `pointerReading()` in `src/offscreen/offscreen.js` measures both
off the raw landmarks.

Each finger is first scored by `reach()`: the tip's distance from the wrist over
its own knuckle's distance from the wrist. Roughly 1.9 straight out, 0.95 folded
into the palm; `REACH_FLAT` and `REACH_FIST` scale that onto 0…1. Measuring from
the *wrist* rather than along the finger's own bones is the point — most of what
changes between a flat palm and a relaxed hand is flexion at the knuckle, which
leaves the finger itself straight, and a curl measured within the finger can't
see it at all. Both distances share an origin, so hand size and in-plane rotation
cancel.

Two tests on those four scores, each a `[strict, loose]` pair interpolated by the
**Hand tolerance** slider:

| test | what it measures | what it rejects |
| --- | --- | --- |
| `POINTER_BAND` | how far the four-finger average sits from half open | a flat palm, a fist |
| `POINTER_SPREAD` | the gap between the most and least extended finger | ✌️, ☝️ and 🤟 — they average out to half open while being nothing of the sort |

They're deliberately separate. A relaxed hand curls unevenly — the pinky more
than the index — so a per-finger band tight enough to reject ✌️ would also reject
a perfectly good steering hand. ✌️ in particular lands at almost exactly 0.5
average and is caught *only* by the spread test.

Pinching is `dist(thumb tip, index tip) / palmWidth`, against
`pointerPinchDistance` with `POINTER_PINCH_HYSTERESIS` between the closing and
releasing points, so a hand hovering on the threshold can't machine-gun clicks.
The click fires on the closing edge only; holding the pinch does nothing further.

Two details that keep clicking from fighting steering:

- Pinching curls the index finger, which can push the hand out of the steering
  shape. So once the cursor is up, a held pinch keeps it up on its own —
  `POINTER_HOLD_MARGIN` also loosens both tests while engaged, since it should
  take less to keep the cursor than to raise it.
- Raising a hand that is *already* pinched doesn't engage, and `startPointer()`
  adopts the pinch as it stands rather than counting it as a fresh click.

### Steering

The hot spot is the palm centre — the same landmark average the swipe detector
uses, chosen because the fingers move when you pinch and the palm doesn't. It's
mapped through an active area (`pointerRangeX` / `pointerRangeY`, centred on the
frame) onto the viewport, so a fraction of the frame covers the whole page and
you don't have to reach. X is mirrored, so moving your hand to *your* right
moves the cursor right.

Position runs through a one-euro filter, which widens its own cutoff with speed:
still hand, still cursor; fast hand, no lag. **Smoothing** sets both ends of that
(4 Hz → 0.6 Hz minimum cutoff). The cursor element also carries a 70 ms linear
`transform` transition, which interpolates between inference frames — at 20 fps
that's the difference between smooth and visibly stepped.

Open the popup while steering: it draws the active area and the hot spot on the
camera preview, which is by far the quickest way to tune the reach sliders. The
ring around the cursor itself fills as your fingers close and snaps in when the
pinch lands — tune **Pinch distance** against that.

### Routing

Unlike playback actions, the cursor isn't aimed at a `<video>` — it belongs to
whatever you're looking at. `relayCursor()` in the service worker resolves its
own target (the active tab's **top** frame, cached for a second because these
arrive at the inference rate) rather than going through `resolveTarget()`. Plain
motion frames are dropped while a send is in flight; clicks and the closing frame
never are. A tab that can't be reached is remembered and skipped until it
reloads or you switch away and back.

Two consequences worth knowing:

- The cursor only exists where the content script runs, so tick **"Also run on
  every other site"** if you want it everywhere.
- If you turned on **"Pause gesture detection when no video tab is in focus"**,
  the engine suspends on ordinary pages and the pointer goes with it. It ships
  off, so out of the box Jester keeps watching everywhere; untick it again and
  the engine resumes immediately rather than waiting for the next tab switch.

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
  `MODEL_PATH` at it — or, if the pose is geometrically distinctive, measuring it
  off the landmarks the way `pointerPose()` does.
- **The pointer is a page cursor.** It can't leave the tab or reach Chrome's own
  UI, and it can't click *into* a cross-origin iframe: `elementFromPoint` returns
  the `<iframe>` element and the event lands there, not on what's inside it. Its
  events are untrusted, so anything gated on real user activation stays locked.
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
  offscreen/offscreen.js              camera + inference + gesture state machine,
                                      pointer shapes + cursor smoothing
  content/content.js                  video discovery, action execution, on-page HUD,
                                      the virtual cursor and its synthetic events
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
| Cursor never appears | Watch the popup while making the shape — it says "Pointer" the moment it registers. If it never does, raise **Hand tolerance**, and check you're neither flattening your hand nor closing it far enough to read as a fist. If the popup *does* say it, the tab can't be reached: Jester has no content script there, so tick **"Also run on every other site"** and reload. |
| Cursor appears when you didn't mean it | Lower **Hand tolerance**, or raise **Time to engage**. A resting hand often sits close to half open. |
| Pinch doesn't click | Raise **Pinch distance** — the threshold is measured against your palm width, so a large hand on a distant camera needs more slack. The popup's bar fills as your fingers close; if it never reaches full, the threshold is too tight. |
| One pinch clicks twice | Shouldn't happen — release and click use separate thresholds. If it does, raise **Pinch distance** so the release point clears your resting finger gap. |
| Cursor vanishes when you pinch | Raise **Hand tolerance**. A held pinch is supposed to keep the cursor alive on its own, so this means the hand left the shape before the pinch registered. |
| Cursor can't reach the screen edges | Lower **Horizontal / Vertical reach** — you're running out of camera frame before you run out of page. The popup preview draws the active area. |
| Cursor jitters, or lags behind | **Smoothing** trades one for the other. Below ~15 fps in the popup readout, raise **Inference rate** instead. |
| Clicks land on the wrong thing | The halo shows what will be clicked. If it's highlighting a big wrapper rather than the button, the site nests its click handler oddly — the click still goes to the deepest element under the cursor, so it usually works anyway. |
