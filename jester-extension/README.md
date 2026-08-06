# Jester — hand gesture video control

A Chrome (Manifest V3) extension that watches your webcam with **MediaPipe's
Gesture Recognizer** and turns hand poses and swipes into playback commands on
YouTube, Netflix, Hulu, Disney+, Prime Video and friends.

Hand tracking runs entirely on-device: the WASM runtime and the `.task` model
are bundled in this folder, and camera frames never leave it.

The one exception is the [voice pill](#voice), which is off unless you raise
your index finger. Chrome's speech recognition is a network service, so while
the pill is on screen your audio does go to Google. Nothing else here makes a
network request.

---

## Build flags — `.env`

Two switches live in `.env`, beside `manifest.json`. It's read at runtime by
`src/common/env.js`, so there's no build step: edit it and hit **Reload** on
`chrome://extensions`.

| Flag | Effect |
| --- | --- |
| `CURSOR=true` \| `false` | `false` switches the [virtual cursor](#pointer) off end to end and removes it from the UI — no card in the popup, no section in the options page. The code stays in the tree; only whether it runs changes. |
| `AI=` | API key for the assistant. Nothing is sent anywhere yet: Jester only checks it looks like a key at all and says so in the popup and the options page when it doesn't. |

`.env` is gitignored — `.env.example` is the committed template. If no flag file
can be read at all, every flag falls back to leaving things as they are
(`CURSOR=true`, no key) and the popup says why.

### Why there is also an `env.txt`

It isn't settled whether Chrome will serve a *dotfile* out of an extension
folder, and it can't be checked from a script any more — Chrome 137 dropped
`--load-extension`. So `src/common/env.js` tries `.env` first and falls back to
`env.txt`, a byte-for-byte mirror that `build-zip.ps1` refreshes on every build.

Edit `.env`. The mirror is generated, and gitignored for the same reason.

The options page says which file actually answered, under **AI assistant**. If
it says `env.txt`, Chrome is refusing the dotfile on your machine, and edits to
`.env` won't reach the extension until you re-run `build-zip.ps1`.

It ships **inside** the zip, because it's fetched at runtime rather than
compiled in. So a published build carries whatever key is in it, where anyone
who downloads the extension can read it; `build-zip.ps1 -Flat` warns when that's
about to happen.

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
| ☝️ Index finger raised | Voice pill + microphone — see [Voice](#voice) |

Play and pause are separate poses rather than one toggle, so a missed hold can
never leave you fighting the video — repeat the pose and you still get what you
asked for.

All seven canned poses are bound out of the box; set any of them to **Do
nothing** to free the slot. Every binding, and every threshold below, is
editable in the options page.

One action worth knowing about is unbound by default: **Turn Jester off** stops
the camera on a gesture. It is one-way — with the camera down nothing can
recognise a gesture to switch it back — so switching on stays with the toolbar
popup and the options page. The three shapes at the bottom of the table are the
exception in the other direction: they drive a mode rather than firing an
action, so they aren't in the bindings table at all.

Note the collision on ☝️. A raised index finger is measured off the landmarks
and takes over the hand, so while the voice pill is up the model's
`Pointing_Up` pose does **not** fire whatever it's bound to.

That only applies on the default setting, where the finger is what summons the
pill. Set **Settings → Voice → Show the pill** to **Never** or **Always** and
the finger stops being a trigger, so ☝️ goes back to skipping ads.

## Fullscreen vs. windowed

The table above is what a gesture does when a video is filling your screen. Turn
on **Use a different set of bindings when I'm not in fullscreen** in the options
page and you get a second column: the same poses and swipes, bound to whatever
you want for the rest of the time.

The starting point for that second set keeps play/pause, mute and fullscreen on
the same poses — a windowed player is still a player, and a sign that means two
different things depending on the window is exactly what's worth avoiding. What
changes is everything that only made sense against a video:

| Gesture | Not in fullscreen |
| --- | --- |
| ➡️ / ⬅️ Swipe right / left | Next / previous tab |
| ⬆️ / ⬇️ Swipe up / down | Scroll up / down |
| 👍 / 👎 Thumb up / down (hold) | Scroll up / down — repeats while held |
| ☝️ Pointing up (hold) | Jump to the top of the page |

Alongside the playback actions, the full list now covers scrolling, jumping to
the top or bottom of a page, back / forward / reload, switching, moving, opening,
closing and reopening tabs, and cycling browser windows. Tab and window actions
run in the service worker, so they work on pages Jester itself can't touch —
including the new tab page.

"Fullscreen" means all three ways a video can fill the screen: cinema mode, the
site's own fullscreen, and a window you put fullscreen yourself with F11. From
where you're sitting they're the same thing, so Jester treats them the same.

Switching contexts drops any pose you were part-way through holding, so a hold
that started under one set can't fire the other set's action.

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

Two of those channels are *modes* rather than actions — the pointer, and the
raised index finger behind the voice pill. Both own the hand outright while
they're engaged, and both are measured off the landmarks rather than coming
from the model. The pointer wins if a frame somehow reads as both.

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

## Voice

Raise your index finger, other fingers curled, and a black pill slides in at the
bottom of the page. Five vertical bars sit as dots in the middle of it and move
with your voice. While it's up Jester is listening; drop your hand and both the
pill and the microphone go.

Two things are configurable in **Settings → Voice**: when the pill appears (on
the finger, always while Jester is on, or never) and where it sits (bottom
centre, top centre, or either bottom corner).

**It only appears where Jester runs.** The pill is an element drawn into the
page by the content script, exactly like the cursor, so on a site outside the
built-in list you need **"Also run on every other site"** ticked — otherwise the
gesture registers in the popup with nothing to show for it. The popup says so
when that happens rather than failing silently.

**Grant microphone access from the options page**, the same way as the camera
and for the same reason — the engine lives in an offscreen document with no UI,
so Chrome has nowhere to show the prompt and `getUserMedia` simply never
returns. Jester checks the permission up front and says so rather than hanging.

### Detecting the shape

`indexPointReading()` scores the four fingers with the same `reach()` the
pointer uses, then applies three tests, each a `[raise, hold]` pair — it takes
less to keep the pill up than to raise it, because a finger held out for a
sentence drifts:

| test | what it measures |
| --- | --- |
| `POINT_INDEX_MIN` | the index reaches far enough to count as out |
| `POINT_OTHERS_MAX` | the other three stay curled |
| `POINT_SEPARATION` | and those two readings sit far enough apart |

The third is what earns its keep. ✌️ and 🤟 both have the index fully out and
*some* fingers curled, and only the gap between the index and the most extended
of the other three separates them cleanly from a real point.

This is deliberately not the model's `Pointing_Up` class: that one insists the
finger points upward, and this drives a mode rather than firing an action, so it
has to hold whichever way your hand is turned and be readable every frame.
`POINT_ARM_MS` debounces the way in and `POINT_RELEASE_MS` the way out, so one
dropped frame can't cut you off mid-sentence.

### Levels and words

Both come off the microphone in the offscreen document (`src/offscreen/voice.js`),
which is where the stream can live.

**Levels** are an `AnalyserNode` sampled on a 40 ms timer — 25 Hz, the same
order as the inference loop — reduced to five roughly logarithmic bands between
85 Hz and 4 kHz, stopped there because speech carries almost nothing above it.
Each band gets a noise floor, a gain, and an asymmetric attack/decay so the bars
jump to a sound and fall away from it. The bars carry a 70 ms CSS transition,
which interpolates between frames exactly as the cursor's transform does.

**Words** come from Chrome's `webkitSpeechRecognition`. It's set `continuous`,
but Chrome ends a session on its own after a pause, so `onend` re-opens it —
with a flood guard, because a session that dies the instant it starts is failing
rather than finishing. Interim results are throttled and de-duplicated.

Nothing consumes the transcript yet. It's printed to two consoles: the offscreen
document's (`chrome://extensions` → Jester → **Inspect views** → `offscreen.html`),
which is where recognition actually happens, and the page's, which is the one
you're looking at while you talk.

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
.env                                  build flags — see above. Read at runtime.
env.txt                               generated mirror of it; build-zip.ps1 owns this
.env.example                          committed template for both
models/gesture_recognizer.task        MediaPipe canned-gesture model (8 MB)
vendor/tasks-vision/                  MediaPipe Tasks Vision 1.0.0 + WASM runtime
src/
  common/constants.js                 settings schema, action list, message types
  common/env.js                       .env reader, flag + API-key validation
  background/service-worker.js        offscreen lifecycle, target tab resolution,
                                      action dispatch, HUD / cursor / voice relays
  offscreen/offscreen.js              camera + inference + gesture state machine,
                                      pointer shapes + cursor smoothing,
                                      the index-finger shape behind the pill
  offscreen/voice.js                  microphone: band levels + speech recognition
  content/content.js                  video discovery, action execution, on-page HUD,
                                      the virtual cursor and its synthetic events,
                                      the voice pill
  content/page-bridge.js              Netflix player API bridge (main world)
  popup/                              toolbar popup: preview, status, history
  options/                            all settings, gesture bindings, camera setup
  ui/ui.css                           shared styles
```

Repack from the parent folder with:

```
..\build-zip.cmd            # nested layout, for "unzip, then Load unpacked"
..\build-zip.cmd -Flat      # manifest.json at the root, for the Web Store
..\build-zip.cmd -Versioned # names it after the manifest version
```

It validates the manifest, the HTML references, the runtime assets, `.env` and
every first-party `.js` before writing anything, and refreshes `env.txt` from
`.env` on the way through. Nothing is written if a check fails.

**Use the `.cmd`, not the `.ps1` directly.** Windows ships PowerShell as
`Restricted`, so `.\build-zip.ps1` fails with *"running scripts is disabled on
this system"* unless you've changed that. The wrapper passes
`-ExecutionPolicy Bypass` for its own process only, which leaves your machine's
setting alone, and works from cmd, PowerShell and Git Bash alike. Run it from a
terminal — it deliberately doesn't `pause`, so a double-click closes the window
before you can read the output.

The `.ps1` is still the thing doing the work; call it directly if your policy
already allows scripts.

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
the popup is actually open. There is no remote code; MV3 forbids it and nothing
here needs it.

**Audio is the exception, and it's worth being clear about.** While the voice
pill is on screen, Jester runs Chrome's `webkitSpeechRecognition`, which is a
*network* service — the audio goes to Google's servers to be transcribed, the
same as dictation in any Chrome text field. Band levels for the bars are
computed locally and never leave, but the speech itself does.

The microphone is only ever open while the pill is up, so with the default
setting it tracks your index finger exactly: finger up, OS microphone indicator
on; hand down, released. Set **Settings → Voice → Show the pill** to **Never**
and the microphone is never opened at all. Choosing **Always** means it stays
live for as long as Jester is running.

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
| Pill never appears, popup says "☝️ Listening" | The gesture is fine — the page is the problem. The pill is drawn by the content script, which only runs on the sites in the manifest, so on an ordinary page there is nothing there to draw it. Tick **"Also run on every other site"** and reload the tab. The popup now says so outright rather than leaving you guessing. |
| Pill never appears, popup says something else | The shape isn't reading. Open the popup (which switches on the shape log) and read the offscreen document's console: it prints which of the three tests is failing and by how much. Usually it's the other three fingers not being curled far enough in. |
| Pill appears, bars never move | The popup shows the microphone problem under the status line. Most often access was never granted: **Settings → Voice → Allow microphone access**, then **Restart** in the popup. |
| No transcript in the console | Two consoles carry it — the page's, and the offscreen document's under **Inspect views**. If neither shows anything, check the popup for a microphone error; recognition is a network service, so it also needs a working connection. |
| ☝️ stopped skipping ads | Expected: a raised index finger now takes over the hand for the voice pill. Set **Settings → Voice → Show the pill** to **Never** to get the pose back. |
| No Pointer section in Settings | `CURSOR=false` in `.env`. That's the flag doing its job — set it to `true` and reload the extension. |
| Editing `.env` changes nothing | Check the line under **Settings → AI assistant**. If it says the flags came from `env.txt`, Chrome won't serve the dotfile here, so re-run `build-zip.ps1` to refresh the mirror before reloading. |
| Cursor never appears | Watch the popup while making the shape — it says "Pointer" the moment it registers. If it never does, raise **Hand tolerance**, and check you're neither flattening your hand nor closing it far enough to read as a fist. If the popup *does* say it, the tab can't be reached: Jester has no content script there, so tick **"Also run on every other site"** and reload. |
| Cursor appears when you didn't mean it | Lower **Hand tolerance**, or raise **Time to engage**. A resting hand often sits close to half open. |
| Pinch doesn't click | Raise **Pinch distance** — the threshold is measured against your palm width, so a large hand on a distant camera needs more slack. The popup's bar fills as your fingers close; if it never reaches full, the threshold is too tight. |
| One pinch clicks twice | Shouldn't happen — release and click use separate thresholds. If it does, raise **Pinch distance** so the release point clears your resting finger gap. |
| Cursor vanishes when you pinch | Raise **Hand tolerance**. A held pinch is supposed to keep the cursor alive on its own, so this means the hand left the shape before the pinch registered. |
| Cursor can't reach the screen edges | Lower **Horizontal / Vertical reach** — you're running out of camera frame before you run out of page. The popup preview draws the active area. |
| Cursor jitters, or lags behind | **Smoothing** trades one for the other. Below ~15 fps in the popup readout, raise **Inference rate** instead. |
| Clicks land on the wrong thing | The halo shows what will be clicked. If it's highlighting a big wrapper rather than the button, the site nests its click handler oddly — the click still goes to the deepest element under the cursor, so it usually works anyway. |
