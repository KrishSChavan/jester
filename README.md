# Jester

A Chrome extension for streaming sites: control playback with gestures, point
with your eyes or head, and give multi-step voice commands such as “Play season
3 episode 1 of Rick and Morty.”

Camera tracking and speech recognition run on-device. Your chosen AI provider
receives command text and compact semantic page context, and a screenshot of the
tab only when a task needs one and Settings allow it; never audio, camera frames
or raw HTML. See the [privacy policy](PRIVACY.md).

## Run locally

1. In `chrome://extensions`, enable Developer mode and load the
   [`jester-extension/`](jester-extension/) folder unpacked.
2. Open Jester Settings. Allow camera and microphone access. Use **Set up
   on-device speech** to install the chosen language pack if Chrome needs it.
3. Under **AI assistant**, choose OpenAI, Anthropic, Gemini, Groq, or a custom
   OpenAI-compatible endpoint. Enter its model ID and API key, then **Add model**.
   Repeat for additional models; use **Move up/down** to set the fallback order.
4. Enable Jester and open a supported streaming site. Hold ☝️ once, lower your
   hand, and speak a full command. The bottom-center black pill shows live voice
   bars. Pause after speaking to execute; repeat the gesture to finish sooner.
5. Bind another pose or swipe to **Start / stop voice commands** if preferred.
   Use the pill’s × or the popup’s Cancel button to stop capture or an active task.

The popup and Settings have separate **Voice commands** and **Cursor control**
switches. Cursor input can be **Voice**, **Eyes / head**, or **Both**. Head-only
pointing needs no calibration. Eye modes have a calibration screen. Raise an
open palm to point and close it into a fist to click; in Both mode, “click” uses
the current eye/head target too. The old finger-steering implementation remains
in the source but is not loaded or shown in Settings.

Choose the permission boundary in Settings: review every action, allow normal
entertainment browsing while reviewing sensitive actions, or allow supported
actions on the task’s original site. Reviews appear in the toolbar popup.

A browser without local speech support cannot use voice; there is no cloud
speech fallback. Gesture and cursor controls continue to work. AI providers
require compatible text-generating models and may charge API usage fees.

The agent now handles exact show/season/episode flows locally when controls are
clear, and groups existing controls in AI responses to reduce round trips.
Groq GPT-OSS uses low reasoning effort. A rate-limited model moves to the end of
your saved queue and Jester tries the next ready model. If all are limited, a
small top-right countdown shows the closest next retry and hides at expiry.
Voice tasks now work the way Claude in Chrome does: Chrome's real mouse and keyboard
through `chrome.debugger` (Chrome shows a debugging bar during a task), requests paced
per saved model so free tiers aren't tripped (set each model's **Plan** in Settings),
the last few commands as context for follow-ups, and a numbered screenshot only when
the page text isn't enough. See the full guide's "Claude in Chrome-style control".
Say **keep going** to resume; Jester never resumes automatically. A paused task is
forgotten a minute after its last step (or after the cooldown), and a finished one at
once, so the next command always starts fresh. Reload the extension and
refresh the streaming tab after updating. See the full guide’s latency section
for timing logs and limits.

Settings also suggests Google's free-tier `gemini-3.5-flash-lite` and links to
API-key setup and your project's active quotas. Select **Google (Gemini)**,
enter the model ID and your Google AI Studio key, then **Add model**. Free-tier
availability and limits depend on the provider and project; changing provider
does not replace the local shortcuts that reduce request usage.

## Background web research

If you say “search something” without a topic, Jester asks what to search for.
Your next reply supplies the topic. The model scores whether background reading
can complete the request from 0 to 100. At 70 or above it can try scraping;
below 70, or when interaction is needed, it asks before using computer controls.
The pending question clears after two minutes, cancellation, or a new task.

Ask Jester to search, look something up, or research your Canvas assignments or
open pages. It reads in the background first and returns sources and retrieval
times. If reading cannot finish, it asks before using browser or desktop
controls. Explicit commands such as opening a site or playing music still work
as before. Full research answers and clickable sources appear in the
extension popup's **Research results** card.

The extension works with the desktop app closed. In Jester Settings, allow
**Also run on every other site** for public searches and the sites you want it
to read, or grant those sites individually through Chrome. Keep Canvas open
and signed in for coursework research. Jester can read its current page and
follow same-origin document links using that session, without exporting
cookies or changing your tabs. A snapshot of an open page reflects what that
page has loaded; it is not an automatic page refresh.

For Scrapling's public-page parsing and isolated JavaScript rendering, install
the local helper and run the desktop app:

```sh
npm --prefix desktop run scraping:setup -- --browser
```

This needs Python 3.10 or newer and installs
[Scrapling 0.5.1](https://github.com/D4Vinci/Scrapling/releases/tag/v0.5.1)
and its browser under `desktop/.scrapling/`. Link the extension to Jester
Desktop to share it. Without the helper, the extension uses background web
requests and its existing signed-in pages; pages that need fresh JavaScript
rendering or a login step may require the interaction approval. No paid
scraping service is needed. Your configured AI model still plans research and
reads the extracted text; its normal usage charges apply.

## Development

Run `npm test` from this repository root. Tests use mocked browser/model APIs;
no microphone, account credentials, paid inference, or live streaming account
is required.

`npm run zip` checks the extension and writes the Chrome Web Store upload,
`dist/jester-extension-<version>.zip`, on any platform. On Windows,
`build-zip.cmd -Flat` builds the same zip. [store/listing.md](store/listing.md)
has the listing text, the Privacy practices answers and the submission steps.

[Full setup, architecture, token limits and before/after example](jester-extension/README.md).
