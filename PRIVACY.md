# Jester privacy policy

_Last updated: November 21, 2026_

Jester is a Chrome extension that lets you control video and your browser with
hand gestures, an eye or head cursor, and voice commands. This policy explains
what Jester does with your data.

**In short:** your camera and microphone are processed on your device and never
leave it. Jester has no servers, no analytics and no ads. When carrying out a
request, it contacts the websites and search engine needed for that request
and the AI provider you choose in Settings. Research can include extracted
text from signed-in pages you ask it to read.

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

The extension's latest background research answer and source links are also
held in session storage so you can review them in the popup. Closing the
browser clears them. Desktop research answers are part of its conversation
history and follow the app's existing conversation retention settings.

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
- for background research: bounded extracted page text, search snippets,
  titles, source URLs, links and retrieval times. This includes signed-in
  pages such as Canvas when your request concerns them. Open-tab metadata is
  used to locate those pages; raw HTML and cookies are not sent to the model;
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
sent to an AI provider. Public searches and page requests still contact their
respective websites.

**API keys** you enter are stored in your browser profile on this device and
are sent only to the provider they belong to. Settings never shows a saved key
again, and **Remove** deletes it.

## Choices you make when Jester asks

When a task can't go on without knowing which one you mean (which profile on a
streaming site, which account), Jester asks you rather than guess. Your answer
("Hulu profile: Krish") is kept so you aren't asked again: in the extension's
own storage on your computer (the newest 30) when it runs by itself, or by
Jester Desktop when the two are linked. It's sent to your AI provider with
later tasks, as part of what the task needs to know. Removing the extension, or
clearing its data, deletes what it kept.

## Jester Desktop, if you link it

Jester Desktop is an app that brings Jester to your whole computer. If you link
the two (Settings › Jester Desktop › Link), Chrome lets the extension exchange
messages with the app through a small helper program the app installs on your
computer (Chrome's native messaging). The messages stay on your computer: nothing
goes over the network, and the developer receives nothing.

While they're linked:

- The extension's camera and microphone stay off. The app does the watching and
  listening, on your device, and the extension tells it what your gestures are set
  to do in Chrome.
- A command you give the app that is about your browser (your tabs, bookmarks or
  pages) is passed to the extension, which carries it out as if you had said it in
  Chrome, with the AI provider you chose in Chrome's Settings. Its progress, any
  question it needs you to answer, and its result go back to the app, with a short
  list of the steps it took (such as "Clicked “Videos”": the names of the controls
  it used, not the page's contents), which the app can keep in its own log on your
  computer to tell why a task stopped.
- When the app's cursor clicks in Chrome, the extension tells the app where the
  nearest link or button is on the page in front: its position, not its text.

Unlinking removes the permission, and the extension goes back to using its own
camera and microphone.

Desktop can create saved briefings from connected calendars, tasks, watched
important mail, retained conversations, and requested background research.
Briefing snapshots, source links, covered time ranges, and read/snooze/dismiss
state stay on your computer for up to seven days. Your chosen model may receive
the relevant facts to write a briefing; the Email setting that prevents model
judgment also prevents briefing wording from sending watched mail to a model.
Scheduled briefings announce availability and wait for an accepted reading.
They are not pushed to your phone. Opening an item requires your click or a
separate explicit request.

## Background web research

Jester tries background reading before using browser or desktop controls for
informational requests. If reading cannot finish, it asks before interacting.
The extension can search and fetch public pages without the desktop app. Its
current search source is DuckDuckGo's public HTML results, which receives the
search terms. Each requested website receives ordinary page requests.

When the desktop app is running and linked, the extension can use its local
Scrapling helper for public pages and isolated headless rendering. The helper
does not use your Chrome profile, sends no browser cookies, and keeps no page
cache. Python dependencies and its browser are installed explicitly on your
computer, not downloaded at every launch.

Signed-in research uses the extension's existing open tabs, and only when you
ask about Canvas or pages you have open; any other research reads pages
anonymously, without your cookies, even if you have the same site open. It
reads the current page or makes GET requests for same-origin documents in that
tab's isolated context, with Chrome's normal session cookies. Cookies, passwords,
and browser profiles are not exported to the desktop helper or model. Form
fields and known secret patterns are excluded from extracted content. The
requested page text and links can still contain personal information, and
that relevant extracted content is sent to your configured AI provider.

Reading does not focus, refresh or navigate your tabs. The reported retrieval
time for an open page is when its current DOM was read, not when the server
last updated it. Extraction is bounded and may omit content; login steps,
verification screens, and unsupported documents may require interaction.

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
  them for explicit browser searches. Background research searches use
  DuckDuckGo's HTML results. History and bookmarks are read only when a
  command asks for them.
- **Debugger**: during a voice task, to click and type with Chrome's real mouse
  and keyboard and to take the screenshot described above. Chrome shows a
  "Jester started debugging this browser" bar while it's in use; closing the
  bar stops it, and Settings can turn it off.
- **Notifications**: to ask for your OK and report results on pages where the
  voice pill can't appear.
- **Storage, offscreen document and scripting**: to save settings, run the
  camera engine, show Jester's controls on pages, and read permitted open
  pages in an isolated context for requested research.
- **Native messaging** (optional, asked for only when you click Link) and
  **alarms**: to talk to Jester Desktop as described above, and to try the link
  again every half minute while the app isn't running.

## What Jester doesn't do

- There are no Jester servers. The developer never receives your data.
- No analytics, tracking or advertising, and your data is never sold.
- Your data is used only to carry out your commands. Requested websites and
  search providers receive the requests needed to find the information, and
  your chosen AI provider receives the relevant extracted evidence. Your
  data is not used to determine creditworthiness or for lending.

## Your choices

- Turn Jester off with the switch in its toolbar popup to release the camera.
- Turn voice commands, the cursor, real mouse and keyboard input, or screenshots
  off in Settings.
- Remove a saved model and its key, or clear the eye calibration, in Settings.
- Unlink Jester Desktop in Settings.
- Uninstalling Jester deletes everything it stored, including saved keys and
  calibration.

## Children

Jester is not directed at children under 13.

## Changes

Changes to this policy are published here, with a new date at the top.

## Contact

Questions or requests: open an issue at
<https://github.com/KrishSChavan/jester/issues>.
