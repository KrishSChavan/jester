# Chrome Web Store submission kit

Everything the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
asks for, in the order it asks. Text in the boxes is ready to paste.

## Before you start

1. **Revoke the old Groq key.** The `jester-extension.zip` committed to this
   public repository in `cf14d44` contains `.env` with an `AI=` key. Deleting
   the file doesn't remove it from history, so treat that key as public: revoke
   it at <https://console.groq.com/keys>. If Jester should use Groq, add a new
   key in Settings, never in a file.
2. **Publish the privacy policy.** The dashboard needs a public URL. Merge
   `PRIVACY.md` into `main` and use
   `https://github.com/KrishSChavan/jester/blob/main/PRIVACY.md`.
3. **Build the upload.** Run `npm run zip`. It checks the extension against the
   Web Store's limits and writes `dist/jester-extension-<version>.zip` with
   `manifest.json` at the root. Upload that file, not a zip made by Finder.
4. **Register as a developer** if you haven't: a one-time US$5 fee, and a
   verified contact email under **Account**.

## Package

**Items → New item →** upload `dist/jester-extension-0.1.0.zip`.

For later updates, raise `version` in `jester-extension/manifest.json` (for
example `0.1.1`), run `npm run zip` again, and upload under **Package →
Upload new package**. The store rejects a version it has already seen.

## Store listing

**Title and summary** come from the manifest:

- Title: `Jester — Hand Gesture Video Control`
- Summary (126 of 132 characters): `Control YouTube, Netflix and more with hand gestures, an eye/head cursor and your voice. Camera and audio stay on your device.`

**Description**

```text
Jester lets you control video and your browser without reaching for the keyboard or mouse: hand gestures from across the room, a cursor you aim with your eyes or head, and voice commands that carry out whole tasks.

HAND GESTURES
• Closed fist to pause, open palm to play. Peace sign to mute, thumbs up or down for volume.
• Swipe left or right to seek, up or down for volume.
• Rebind any pose or swipe in Settings, with a second set for when you're not in fullscreen.
• Works on YouTube, Netflix, Disney+, Hulu, Prime Video and other major streaming sites.

VOICE COMMANDS
• Point one finger up, or press Alt+Shift+J, and say what you want: "Play season 3 episode 1", "next episode", "switch to the recipe tab", "search Amazon for a USB hub".
• Jester works through the site step by step, from search to the show, season and episode, and asks before anything sensitive.
• Uses the AI model you choose, with your own API key: Google Gemini (which has a free tier), OpenAI, Anthropic Claude, Groq, or any OpenAI-compatible endpoint. Simple tab commands work without one.

EYE AND HEAD CURSOR
• Steer a cursor by turning your head, with no calibration, or with your eyes after a short calibration.
• Raise an open palm to show it and close your hand into a fist to click.

PRIVATE BY DESIGN
• Camera tracking runs on your computer with MediaPipe. Video never leaves your device.
• Speech is recognized on-device by Chrome. Audio is never uploaded.
• No Jester servers, no analytics, no ads. A voice task sends your command and a compact description of the page to the AI provider you picked, and nothing else.

GETTING STARTED
1. Click the Jester toolbar button, turn it on, and allow camera access.
2. For voice, open Settings, allow the microphone and choose "Set up on-device speech".
3. For AI voice tasks, add a model and its API key under "AI assistant".

Needs a webcam. Voice needs Chrome's on-device speech recognition for your language. AI providers may charge for API use.

Jester is not affiliated with YouTube, Netflix or any other streaming service.
```

- **Category:** Make Chrome Yours › Accessibility. Lifestyle › Entertainment also
  fits if you'd rather lead with streaming.
- **Language:** English (United States)

**Graphic assets** (all in this folder):

| Field | File |
| --- | --- |
| Store icon, 128×128 | `icon-128.png` |
| Screenshots, 1280×800 (up to 5) | `screenshot-1-voice.png` to `screenshot-4-settings.png` |
| Small promo tile, 440×280 | `promo-small-440x280.png` |
| Marquee promo tile, 1400×560 (optional) | `promo-marquee-1400x560.png` |
| Global promo video | a YouTube link: record yourself using Jester |

The dashboard documentation lists the promo video as required. If the form
won't submit without one, a 30-second screen recording uploaded to YouTube
(public or unlisted) is enough.

**Additional fields**

- Homepage URL: `https://github.com/KrishSChavan/jester`
- Support URL: `https://github.com/KrishSChavan/jester/issues`
- Mature content: off

## Privacy practices

**Single purpose description**

```text
Jester lets people control video playback and their browser hands-free, using hand gestures and an eye or head cursor read from the webcam on-device, and voice commands that an AI model of the user's choosing carries out in the browser.
```

**Permission justifications**

`offscreen`

```text
Runs the webcam with on-device MediaPipe hand, face and eye tracking, and Chrome's on-device speech recognition, in an offscreen document. A service worker can't hold a camera or microphone stream or run a per-frame loop. Frames and audio never leave the device.
```

`storage`

```text
Saves the user's settings, gesture bindings, eye calibration and the AI model connections they add (provider, model ID, API key) in chrome.storage.local. Keeps short-lived task state in chrome.storage.session: the recent-actions list, the last three voice commands for two minutes, and a paused task.
```

`tabs`

```text
Gesture and voice commands act on tabs and windows: next and previous tab, switching to a named tab ("switch to the recipe tab"), opening, closing, moving, muting, pinning and reloading tabs, and back and forward. Tab titles and URLs are read to carry out these commands and to find the tab that is playing video so gestures reach it.
```

`scripting`

```text
Injects Jester's own packaged content scripts (video controls, voice pill, cursor) into tabs that were already open when it was installed or updated, runs a small packaged function that finds which frame of a tab holds the video, and registers the content scripts on additional sites only when the user turns on "Also run on every other site" in Settings. Only code packaged with the extension is injected.
```

`sessions`

```text
Reopens the most recently closed tab when the user says "reopen the closed tab" or uses a gesture bound to that action (chrome.sessions.restore).
```

`debugger`

```text
Only during a voice task the user started, and only on that task's tab: Jester attaches to send real mouse and keyboard input (Input.dispatchMouseEvent, Input.dispatchKeyEvent, Input.insertText), because many sites ignore scripted clicks and hover, and to take a screenshot of the tab (Page.captureScreenshot) when the page text isn't enough. Chrome shows its "started debugging this browser" bar throughout, and dismissing it stops debugger use for the rest of the task. Jester detaches when the task ends, never types into password or payment fields, and the user can turn this off in Settings. Debugger can't be an optional permission, so it is requested at install.
```

`tabGroups`

```text
Carries out voice commands that group, name, collapse and expand tabs ("group my cooking tabs"), and includes group names when it lists tabs for a command.
```

`history`

```text
Finds a page the user visited when they ask for it, e.g. "open the bread article I read yesterday". History is searched only for that request: at most 10 matches, from the last 30 days unless the command asks for longer (90 at most), with token-like URL parameters removed.
```

`bookmarks`

```text
Finds and opens the user's bookmarks on request ("open my recipes bookmark"), and bookmarks the current page when the user says "bookmark this page".
```

`notifications`

```text
On pages where Jester can't show its on-page voice pill, such as Chrome's own pages, its confirmation questions and the results of voice commands appear as notifications.
```

`search`

```text
Runs the web searches the user asks for ("search for a USB hub") with their default search engine through chrome.search.query, as if they had typed the query in the address bar.
```

Host permissions

```text
Content scripts on the supported streaming sites (YouTube, Netflix, Hulu, Disney+, Hotstar, Prime Video, Max, Peacock, Paramount+, Crunchyroll, Twitch, Vimeo, Apple TV) control their video players (play, pause, seek, volume, fullscreen) and show the voice pill, cursor and gesture feedback. api.groq.com is one of the AI providers the user can choose: the service worker calls it directly and reads its rate-limit headers to pace free-tier requests. Access to any other site is an optional permission, requested only when the user turns it on in Settings.
```

**Remote code:** No, I am not using remote code. (Every script is in the
package, including MediaPipe and its WASM. The CSP's `wasm-unsafe-eval` is
only for that bundled WASM.)

**Data usage.** Tick these:

- [x] **Authentication information:** the API keys users enter for their own AI
  provider, stored locally and sent only to that provider.
- [x] **Web history:** titles and addresses of open tabs, and history or
  bookmark matches, sent to the user's AI provider only when a voice command
  needs them.
- [x] **User activity:** the text of voice commands. Gestures, gaze and audio are
  processed on-device and never transmitted.
- [x] **Website content:** a compact description of the current page, and a
  screenshot of the tab when needed, sent to the user's AI provider during a
  voice task.

Leave the rest unticked: personally identifiable, health, financial and
payment information, personal communications, location.

Tick all three certifications. Each is true: data goes only to the AI provider
the user configures, solely to carry out their commands. It is never sold,
never used for anything else, and never used for credit or lending.

**Privacy policy URL:** `https://github.com/KrishSChavan/jester/blob/main/PRIVACY.md`

## Test instructions (for the reviewer)

```text
No account is needed for the core features.

Gestures: click the Jester toolbar button, switch it on and allow the camera. Open a YouTube video and hold a closed fist toward the camera to pause it; an open palm plays it again.

Voice: open Settings (toolbar button > "Settings & gestures"), allow the microphone and click "Set up on-device speech". Tab commands run on-device with no AI key: press Alt+Shift+J and say "next tab" or "open YouTube".

AI voice tasks need the reviewer's own API key: under "AI assistant" choose Google (Gemini), enter gemini-3.5-flash-lite, paste a free key from https://aistudio.google.com/apikey and click "Add model". Then, on YouTube, press Alt+Shift+J and say "search for lofi music and play the first video".

During a voice task Chrome shows a "started debugging this browser" bar. That's Jester's real mouse and keyboard input, described in the debugger justification.
```

## Distribution

- Visibility: Public, or Unlisted while you try it out.
- Regions: All regions.
- Payment: Free.

## What review will look at

`debugger`, history, bookmarks and the streaming-site host permissions mean a
more thorough review, which can take longer than usual. The justifications
above explain each one.
