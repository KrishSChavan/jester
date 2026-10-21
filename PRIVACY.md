# Jester privacy policy

_Last updated: October 20, 2026_

Jester is a Chrome extension that lets you control video and your browser with
hand gestures, an eye or head cursor, and voice commands. This policy explains
what Jester does with your data.

**In short:** your camera and microphone are processed on your device and never
leave it. Jester has no servers, no analytics and no ads. The only data that
leaves your device goes to the AI provider you choose in Settings, and only
while Jester carries out a voice command you gave it.

## Processed only on your device

**Camera.** Jester uses your webcam to recognize hand gestures and to follow
your eyes and head for the cursor. Frames are analysed inside the extension by
Google's MediaPipe library, running locally. They are never recorded, stored or
sent anywhere. Jester also blocks MediaPipe's built-in usage statistics, so not
even anonymous reports about the tracking leave your device.

**Microphone.** Voice commands are transcribed by Chrome's on-device speech
recognition. If Chrome can't recognize speech locally, Jester turns voice off
rather than fall back to a cloud service. Audio is never sent anywhere, and
Jester never records or stores it. Chrome may download a speech language pack
once.

**Eye calibration.** If you calibrate the eye cursor, Jester saves a small set
of numbers fitted to your eye and head measurements (no images) in your browser
profile. **Clear calibration** in Settings deletes it.

**Settings and short-lived state.** Your settings are saved in your browser
profile. The popup's list of recent actions, your last three voice commands
(kept for two minutes so that follow-ups like "next episode" work) and a paused
task are held in Chrome's session storage, which is cleared when you close the
browser.

## Sent to the AI provider you choose

Simple commands such as "next tab", "open Gmail" or "reopen the closed tab" are
handled on your device. A command that needs reasoning is sent to the AI model
you set up in Settings: OpenAI, Anthropic, Google Gemini, Groq, or an
OpenAI-compatible endpoint you enter. Jester sends each request directly from
your browser to that provider, using your API key, encrypted with HTTPS (plain
HTTP is allowed only for a model running on your own computer). A request can
contain:

- the text of your command, and of your last few commands from the past two
  minutes;
- a compact description of the page you're on: its title and address, and the
  names, roles and state of its visible controls and headings. Never the page's
  raw HTML, and never the contents of password, payment, one-time-code or other
  secret fields;
- the task's progress so far: its goal, short notes and the last few actions;
- only when the command needs them: the titles and addresses of your open tabs,
  or up to ten matching history entries or bookmarks. Address parameters that
  look like tokens, keys or passwords are removed first;
- only when the page text isn't enough, and only if the screenshot setting is
  on: a screenshot of the tab with its controls numbered. It goes only to a
  model that can read images, at most three times per task, never while a
  password or payment field is on screen, and Jester doesn't keep it.

Camera images and audio are never sent. The provider processes what it
receives under its own terms and privacy policy:
[OpenAI](https://openai.com/policies/privacy-policy),
[Anthropic](https://www.anthropic.com/legal/privacy),
[Google](https://policies.google.com/privacy),
[Groq](https://groq.com/privacy-policy/). If you don't add a model, nothing is
sent anywhere.

**API keys** you enter are stored in your browser profile on this device and
are sent only to the provider they belong to. Settings never shows a saved key
again, and **Remove** deletes it.

## How Jester uses its browser permissions

Jester uses each permission only to carry out what you ask:

- **Supported streaming sites** (YouTube, Netflix, Hulu, Disney+, Prime Video,
  Max, Peacock, Paramount+, Crunchyroll, Twitch, Vimeo, Apple TV): to control
  their video players and show the voice pill, cursor and gesture feedback.
  Jester runs on other sites only if you allow it in Settings.
- **Tabs, tab groups, recently closed tabs, history, bookmarks and search**: to
  carry out commands such as "switch to the recipe tab", "reopen the closed
  tab", "find the page I visited about bread", "bookmark this page" or "search
  for a USB hub". Searches go to your default search engine, as if you had typed
  them. History and bookmarks are read only when a command asks for them.
- **Debugger**: during a voice task, to click and type with Chrome's real mouse
  and keyboard and to take the screenshot described above. Chrome shows a
  "Jester started debugging this browser" bar while it's in use; closing the
  bar stops it, and Settings can turn it off.
- **Notifications**: to ask for your OK and report results on pages where the
  voice pill can't appear.
- **Storage, offscreen document and scripting**: to save settings, run the
  camera engine, and show Jester's controls on pages.

## What Jester doesn't do

- There are no Jester servers. The developer never receives your data.
- No analytics, tracking or advertising, and your data is never sold.
- Your data is used only to carry out your commands. It is not transferred to
  anyone except the AI provider you choose, and it is not used to determine
  creditworthiness or for lending.

## Your choices

- Turn Jester off with the switch in its toolbar popup to release the camera.
- Turn voice commands, the cursor, real mouse and keyboard input, or screenshots
  off in Settings.
- Remove a saved model and its key, or clear the eye calibration, in Settings.
- Uninstalling Jester deletes everything it stored, including saved keys and
  calibration.

## Children

Jester is not directed at children under 13.

## Changes

Changes to this policy are published here, with a new date at the top.

## Contact

Questions or requests: open an issue at
<https://github.com/KrishSChavan/jester/issues>.
