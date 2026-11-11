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
Jester lets you control YouTube, Netflix and other streaming sites without touching your keyboard or mouse. Hold up a hand to pause or play from across the room, steer a cursor with your eyes or head, or just say what you want to watch. Camera tracking and speech recognition run on your device.

Main features:
• Hand gestures: a closed fist pauses, an open palm plays, a peace sign mutes, thumbs up or down change the volume, and swipes seek. You can rebind every gesture.
• Voice commands: point one finger up or press Alt+Shift+J, then say "play season 3 episode 1", "next episode" or "switch to the recipe tab". Jester works through the site step by step and asks before anything sensitive.
• Eye and head cursor: steer by turning your head, with no calibration, or with your eyes after a short calibration. Close your hand to click.
• Your choice of AI: voice tasks use the model you pick, with your own API key: Google Gemini (which has a free tier), OpenAI, Anthropic Claude, Groq or any OpenAI-compatible endpoint. Simple tab commands work without one.
• Private by design: video and audio never leave your computer, and there are no Jester servers, analytics or ads. Voice tasks share only what the task needs, such as your command and a summary of the page, and only with the AI provider you chose.

Works on YouTube, Netflix, Disney+, Hulu, Prime Video and other major streaming sites. Gestures and the cursor need a webcam, and voice needs Chrome's on-device speech recognition for your language. AI providers may charge for API use.

Jester is not affiliated with YouTube, Netflix or any other streaming service.
```

- **Category:** Accessibility (under Make Chrome Yours). Everything Jester adds
  is another way to control Chrome, and the category is far less crowded than
  Entertainment.
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

`alarms`

```text
Only while the user has linked Jester to the Jester Desktop app and the app isn't running: an alarm every half minute tries the link again, because an app can't reach an extension by itself. With the link off, or the app running, no alarm is set.
```

`nativeMessaging` (optional permission)

```text
Requested only when the user clicks "Link with Jester Desktop" in Settings, and removed by Unlink. It lets the extension exchange messages with the Jester Desktop app on the same computer through its native-messaging host, com.jester.desktop. While linked, the app watches the camera and listens, so the extension's own camera and microphone stay off; the extension tells the app what its gestures are set to do, carries out the browser commands the app hands it (tabs, bookmarks, pages) with the user's own AI provider, and when the app's cursor clicks in Chrome, gives it the position of the nearest link or button on the page in front. The messages stay on the computer.
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

Linking Jester Desktop (0.2.0) adds no category: its messages go to an app on the
user's own computer, not off the device.

**What's new in 0.2.0** (for the update's notes): Jester links to Jester Desktop,
the app for the whole computer. Linked, the app does the watching and listening,
your Chrome gestures still work with Chrome in front, what you ask the app about
your browser is done in Chrome, and the app's cursor clicks the link you aimed at.
Linking is off until you click Link in Settings.

**What's new in 0.2.2**: Link works the first time you click it (before, it said
Jester Desktop wasn't installed until Chrome was restarted). Jester Desktop's
requests reach Chrome with what the conversation meant, so "try again" works;
"open my … bookmark" opens it with no AI model; and a request from the app works
when you're typing to the app, or when Chrome has no window open.

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

Settings > Jester Desktop links the extension to Jester Desktop, a separate app; without the app installed, Link asks for the optional native messaging permission and then says the app isn't installed. Nothing else depends on it.
```

## Distribution

- Visibility: Public, or Unlisted while you try it out.
- Regions: All regions.
- Payment: Free.

## What review will look at

`debugger`, history, bookmarks and the streaming-site host permissions mean a
more thorough review, which can take longer than usual. The justifications
above explain each one.
