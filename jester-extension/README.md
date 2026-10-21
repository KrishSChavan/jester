# Jester: gestures, local voice, and a compact browser agent

Load this folder unpacked in Chrome. Settings opens from the toolbar popup.
Camera frames and microphone audio stay on-device. AI reasoning uses the
provider and exact model you configure in Settings.

## Setup and controls

Allow camera access and enable Jester. A closed fist pauses video, thumbs change
volume, swipes seek or adjust volume, and the ILoveYou pose toggles fullscreen.
All gesture bindings remain editable, with optional separate fullscreen and
windowed bindings. **Sleep / wake Jester** keeps the camera watching only for
its resume gesture and stops the microphone and pointer.

For voice, allow microphone access and click **Set up on-device speech**.
Chrome may download a language pack; recognition itself is local. If the local
API or language is unavailable, Jester reports the problem and keeps the
microphone closed. It never silently sends audio to a cloud recognizer.

Pointing up defaults to **Start / stop voice commands**, which can be assigned
to any supported pose or swipe. Hold the gesture until it fires, then lower
your hand and speak the complete request. The black pill at the bottom center
shows five frequency-band levels computed locally. The first finalized
utterance starts one task. Repeat the gesture to request finalization sooner;
interim recognition text is never executed. Capture has a 30-second deadline.
The pill’s × and popup’s Cancel button discard capture and stop active work.

Example: “Play season 3 episode 1 of Rick and Morty.” The model must locate the
requested show, choose the requested season, locate the episode, play it, and
verify the available playback state. It can use recent/Continue Watching cards
when those are visible, or use the site’s search controls. There are no baked-in
assumptions that the show or season dropdown already exists on the first page.

On YouTube, “Go to MrBeast’s latest video” (or “play the newest video from Mark
Rober”, “the latest Veritasium video”) searches the name, opens the channel whose
name or handle matches it, its Videos tab (newest first), plays the first video
and confirms that video’s own page is playing; an ad first still counts. This
runs without a model call. If no channel matches the heard name exactly, the
model continues from the search results. “Next video” and “skip the ad” go
straight to the player.

**Cursor control** offers Voice, Eyes / head, and Both. The eye/head pointer
uses an open palm to engage and closing that hand into a fist to click. Choose
Head only for use without calibration, or calibrate for Eyes only / automatic
eyes and head. In Both mode, “click” targets the visible eye/head cursor through
the same permission checks as other voice actions. Cursor coordinates account
for browser zoom, toolbars, window position and the calibrated display. It is a
webpage cursor and cannot operate the OS cursor, Chrome’s toolbar, or controls
inside cross-origin frames. Legacy finger/pinch code is retained unloaded in
`src/offscreen/legacy-finger-pointer.js`; its old settings are commented out.

## Provider and permissions

Settings supports OpenAI (Responses), Anthropic (Messages), Google Gemini,
Groq, and custom OpenAI-compatible APIs, including localhost endpoints. Add up
to 20 saved connections, each with its exact model ID and key. **Add model**
appends a connection; **Move up/down**, **Edit**, and **Remove** manage the
fallback order. Editing requires the key again. Existing single-model settings
migrate automatically. **List models** uses the chosen saved connection and
is optional. The first model request establishes whether the key/model can
run inference. The browser requests access only to each configured API origin.
ChatGPT account subscriptions are separate from provider API keys.

Jester uses the first ready connection in this order. An HTTP 429 stores that
model's cooldown, moves it to the bottom, and tries the next ready model with
the same pending request. It continues the current task without replaying any
page actions. Only saved connections participate; each provider receives only
its own key. Authentication, malformed responses and other errors pause normally.
Cooldowns and order persist across worker restarts. Exact duplicate connections
are not added twice.

If every connection is cooling down, the task pauses and a small top-right
badge names the model with the earliest retry time and counts down live. It
hides at expiry. Say **keep going** to resume; expiry never resumes the task or
polls a provider automatically. The stored task and original goal remain intact
until one minute after the cooldown ends.
Provider retry hints are honored. Without a hint, the next attempt is held for
60 seconds, or 24 hours for an explicitly reported daily quota; these fallback
times are conservative retry checks, not guaranteed provider reset times.

For a free-tier alternative, choose **Google (Gemini)** and enter
`gemini-3.5-flash-lite`. Create a key in
[Google AI Studio](https://aistudio.google.com/apikey), paste it into Settings,
then Add model. Settings provides this model as a suggestion. Google's
[pricing page](https://ai.google.dev/gemini-api/docs/pricing) currently lists
free input/output for this model. Check your project's
[active quotas](https://aistudio.google.com/rate-limit): Google
[does not promise one universal free-tier rate limit](https://ai.google.dev/gemini-api/docs/rate-limits).
Gemini model discovery filters out entries explicitly lacking text generation.
A smaller model on Groq does not by itself raise your organization's quota;
check the [Groq limits page](https://console.groq.com/settings/limits).

Keys live outside broadcast settings in this profile’s `chrome.storage.local`.
The worker returns only masked key summaries. Content scripts cannot read the
credential store or change a connection. Changing a provider or endpoint
requires a newly supplied key. Model requests reject redirects so a redirect
cannot forward the key to another host. No key is written to task checkpoints
or prompts. Existing local `.env` / `env.txt` Groq keys remain a migration
fallback when no Settings connection exists; new connections use Settings.
`CURSOR` in `.env` no longer overrides the user-facing cursor toggle.

The **Permission boundary** dropdown controls actual execution:

| Choice | Behavior |
| --- | --- |
| Ask before every action | Approve each mutation: say yes or no, or use the toolbar popup. Reads do not require approval. |
| Ask before sensitive actions (default) | Allow browsing, search, tabs and playback on any site; ask before locally identified account, sign-in, purchase, payment, sending, posting or destructive targets, typing outside search boxes, and opening a site the task has no reason to know. |
| Never ask | Allow every supported action on any site, subject to Chrome permissions. |

A task starts on the tab you are looking at — Chrome's own pages included — and
follows the tabs it opens or switches to, on any web page; Chrome's pages, files,
`data:` and `javascript:` addresses are never opened or followed. When a step
needs approval the pill asks “Allow …? Say yes or no.” and the microphone opens
for the answer; anything other than a yes declines it, and the toolbar popup can
approve too. A permission review is bound to one action and live element
identity; a stale or replaced element is rejected after approval. Reviews expire
after 60 seconds. Sensitive-action classification is a local heuristic, so use
**Ask before every action** if every mutation should be reviewed.

A destination the model proposes (`open`, `navigate`) runs without asking only
when it is a listed well-known site, a site the request names (“the Anthropic
docs” → docs.anthropic.com), an open tab, or a link or listing the task has
already seen. Anything else could be a page's text steering the model, perhaps
with your data in the address, so it is treated as sensitive. Links on the page
are followed by clicking them, as before.

Jester ships with host access for YouTube, Netflix, Hulu, Disney+, Hotstar,
Prime Video, Max, Peacock, Paramount+, Crunchyroll, Twitch, Vimeo and Apple TV.
**Also run on every other site** is what lets voice read and act on any other
site's page; tab, window, search and playback commands work everywhere without
it. Site permissions must be granted using Settings; a camera gesture cannot
display a Chrome grant prompt. The extension also holds `tabGroups`, `history`,
`bookmarks`, `notifications` and `search` for the browser commands below.

## Voice control of the browser

Say a request on any tab; the gesture, the popup's button, or **Alt+Shift+J**
(⌥⇧J on a Mac, changeable at `chrome://extensions/shortcuts`) starts listening.

| Kind | Examples | Handled |
| --- | --- | --- |
| Tabs and windows | “new tab”, “close this tab”, “next/previous tab”, “switch to tab 3”, “reopen the closed tab”, “mute/pin/duplicate this tab”, “new window”, “go back”, “reload”, “bookmark this page”, “scroll down” | On the device, one step |
| Tabs by name | “switch to Gmail”, “go to my lasagna recipe tab”, “close all the cooking tabs”, “close all other tabs”, “mute the YouTube tab” | On the device when one site or every matching tab is meant; otherwise the model sees the tab list |
| Sites | “open Gmail”, “go to github dot com”, “open YouTube and play MrBeast’s latest video” | A listed site or spoken domain switches to its open tab, else opens a new one (in place on a blank New Tab page); the rest of “… and …” continues there |
| Search | “search for lofi beats”, “search Amazon for a USB hub”, “google weather in Tokyo” | The current site's own search box first; a named site's search; else the default search engine |
| Anything else | “open my latest email”, “group these tabs as Work”, “find that recipe I read yesterday” | The model, with `browser` operations: tabs, open, search, switch, close, groups, history, bookmarks |

Playback commands said with no player in the tab reach the tab that is playing
(“Paused “Song” in another tab.”); gestures still act only on what is in view.
Open tabs' titles and addresses, and a few matching history or bookmark entries,
reach the model only when it asks for them. Where the pill cannot be drawn —
Chrome's own pages, the Web Store, sites Jester has no access to — the badge
shows ● while listening, … while working and ✓ or ! with the answer, which also
arrives as a notification; the popup's list keeps every reply.

## Audit of the fetched implementation

The fetched `origin/main` (`11c9b09`) already avoided full DOM/screenshot
prompts. Its `content.js::pageDigest()` sent the URL, title, scroll information
and up to 40 names, with the name list capped at 700 characters.
`assistant.js::turnPrompt()` rebuilt a prompt each turn with a plan and up to
14 trail entries. It did not persist a growing model conversation or send
screenshots. `RUN_STEPS` actions used fuzzy text descriptions such as “season
dropdown”; matching happened locally.

Consequently, this checkout did not support the pasted diagnosis that raw HTML
was repeatedly sent. Remaining costs came from repeated instructions, the
current digest and trail on every call, plus retries after ambiguous targeting.
It was limited to Groq and a 14-turn loop with provider fallback models. Speech
recognition used Chrome’s default network service.

The new design keeps the compact approach while replacing fuzzy targeting with
page-scoped stable IDs, preserving enough show/episode context to distinguish
similar buttons, validating each action locally, and keeping durable bounded
task memory. A semantic observation may be larger than the old names-only
digest. No measured token reduction against that already-small digest is
claimed; the per-step logs expose the actual tradeoff.

## Claude in Chrome-style control

Voice tasks follow the same approach as Claude in Chrome: read the page as a
compact list of controls with stable IDs, act through Chrome's own input, and
look at a screenshot only when the text is not enough. Each model step is
rebuilt from the command, a small memory and a fresh page, so a step costs
about 2,000 input tokens however long the task runs and the context window
cannot overflow.

- **Real mouse and keyboard.** Clicks, hovers, typing and key presses go
  through `chrome.debugger` (`Input.dispatchMouseEvent`, `Input.insertText`,
  `Input.dispatchKeyEvent`), so sites receive trusted input, hover included.
  The page aims and confirms; the worker only moves and presses. Nothing is
  pressed until a trusted move proves the approved target is the topmost
  element under the real pointer, including at page zoom levels where debugger
  units differ from CSS pixels. Chrome shows “Jester started debugging this
  browser” for the length of a task. Dismissing that bar, a page Chrome will
  not attach to, or turning off **Click and type with Chrome’s real mouse and
  keyboard** falls back to synthetic events. Selects, file inputs, date pickers
  and video elements stay on the synthetic path.
- **Rate pacing.** Each saved model keeps a one-minute window of its requests
  and input tokens in session storage. Before a request, Jester waits for the
  window (up to 20 seconds, shown on the pill) instead of tripping the limit;
  longer waits pause with the countdown badge. Exact limits come from Groq,
  OpenAI and Anthropic headers on every response and from the quota a Gemini
  429 names. A connection's **Plan** sets the defaults until then: Free tier
  paces Gemini at 15 requests and 250,000 tokens a minute and Groq at 30
  requests and 6,000 tokens; Paid uses only what the provider reports. A model
  with a small token ceiling is sent a smaller page (never under 1,500
  characters) so a task fits more steps per minute.
- **Follow-ups.** The last three commands and how they ended stay available
  for two minutes, so “next episode”, “go back” or “not that one” can be
  understood. They are context only; the newest command is always the goal.
- **Screenshots when stuck.** The model may ask to `look` when the text list
  lacks a control, such as an unlabeled player icon. The page draws a numbered
  label on every control a person could click, unnamed icons included, and the
  model answers with an element ID from the legend rather than coordinates. One
  image goes to the next step only, at most three per task, only to a saved
  model that can read images (Gemini, Claude, GPT-4o/5, Llama 4), and never
  while a password or payment field is on screen. Turn it off with **Let a task
  look at a screenshot when the page text isn’t enough**.

## Implementation and limits

| File / function | Responsibility |
| --- | --- |
| `content/agent-page.js::observe` | Compact semantic state, visible/modal focus, bounded registry and local IDs. |
| `content/agent-page.js::execute`, `classify` | Live element validation, retrieval and browser operations; local permission classification. |
| `content/content.js` | Trusted worker message bridge, player actions, cursor and voice overlays. |
| `background/assistant.js::runAssistant` | Local entertainment flow, compact model fallback and groups of up to three live-validated actions. |
| `background/entertainment.js` | Exact show/season/episode shortcuts with observed season and playback verification; ambiguous pages use AI. |
| `background/youtube.js` | A creator’s latest YouTube video: search, exact channel, Videos tab, first video in document order, verified playback. |
| `background/browser-intent.js` | Spoken tab, site and search commands planned on the device; spoken yes/no answers. |
| `background/browser-tools.js` | Chrome tabs, windows, search, history, bookmarks and tab groups for the agent's `browser` action. |
| `common/sites.js` | Well-known sites by spoken name, their search addresses, and which open tab already shows one. |
| `common/agent-actions.js::validateAction` | Strict supported-action fields and parameter bounds; no selectors or executable code. |
| `common/task-memory.js` | Immutable goal, bounded facts/constraints/milestones and latest five results. |
| `background/model-client.js::requestModel` | Provider adapters, selected-model enforcement, timeouts, bounded responses and rate-limit backoff. |
| `background/service-worker.js::executeAgent` | Task tab/origin enforcement, approval, single execution and session checkpoints. |
| `background/model-pool.js` | Saved-model selection, pacing, 429 rotation, screenshot routing, shared deadline and next retry state. |
| `background/rate-governor.js` | Per-connection request/token windows, provider-reported limits and free-tier defaults. |
| `background/real-input.js` | `chrome.debugger` sessions for trusted mouse, keyboard and screenshot capture. |
| `content/agent-page.js::input`, `marks` | Real-input aim/land/ready steps and numbered screenshot labels. |
| `common/credentials.js` | Ordered model connections, cooldown persistence and worker-only key storage. |
| `common/agent-permissions.js` | Permission choices and origin checks. |
| `offscreen/voice.js::createVoice` | Local recognition, microphone levels and cancellation-safe single utterance capture. |
| `offscreen/offscreen.js` | Gesture state machines, eye/head tracking and voice capture controls. |
| `options/`, `popup/` | Model connection, speech setup, input modes, permissions and action review. |

The extractor supports at most **12,000 serialized characters**, **100 elements**,
and **300 characters per element text**. Normal agent observations now request
6,000 characters and 50 elements, with task-relevant actions ranked first. Controls
in the site’s own navigation, banner or footer rank below the page’s content unless
the goal names them; search controls keep their rank. (On a wide window YouTube’s
sidebar otherwise filled the budget ahead of the results.) A control nested in a
same-named link is listed once, and short words such as “to” or “go” never count as
goal matches. A planner can ask for each control’s document order. The local registry holds at most 1,000
live handles. Secret fields, drafts, hidden elements, SVG internals, scripts,
styles and Jester’s own overlays are excluded. Repeated content is deduplicated;
long lists/tables are bounded. Card context and image descriptions preserve
show names beside repeated Play buttons. No raw HTML is used; a screenshot only
when the model asks to look (see above).

On-demand actions include `find_text`, `find_elements`, `read_element`,
`read_nearby`, `inspect_section`, `get_form_fields`, and `get_table`, alongside
click/type/clear/select/hover/scroll/press_key/wait and supported playback
commands. A route change or a changed/disconnected target invalidates old IDs.
Browser cookies, tabs, form values, full DOM and session state stay in Chrome.

Task state persists in `chrome.storage.session` before and after execution.
After worker restart a task is paused; **Resume task** or “keep going” obtains
a fresh observation. A paused task is forgotten one minute after its last step
(or after the provider cooldown it is waiting on), and a worker restart does
not reset that clock. A finished task is forgotten at once, and any new command
replaces a paused one, so a later request never carries an old goal. An action interrupted after dispatch is marked uncertain,
never blindly replayed. Each invocation allows 100 actions and 15 minutes;
resuming grants a fresh invocation budget while keeping the same goal and
bounded memory, so hundreds of actions do not require a growing prompt.
Repeated failures/no-progress pause the task. Model requests have bounded
responses, request/body deadlines and cancellable bounded 429 backoff.

The worker console logs `[jester] assistant step` with `pageChars`,
`requestChars`, `approximateInputTokens`, selected model and step number.
The token estimate is characters divided by four; provider-reported usage is
logged separately when returned. It is an estimate, not a billing measurement.

## Latency improvements

The “Waiting 10 seconds for the model” message was emitted during API retry
backoff (429 rate limiting or 502/503 service errors), not ordinary token
generation. Previously one request could retry twice with up to ten seconds
between attempts, then the outer agent loop could restart that request budget.
Separately, every observation waited at least 280 ms and sometimes 2.6 seconds
for unrelated page mutations to quiet down. One model request per click, field
fill, and Enter key multiplied both costs.

The current interactive path:

- Handles explicit named-show/season/episode requests and basic playback
  commands locally when the available semantic controls are unambiguous. Each
  action still passes the same permissions, live-target and checkpoint checks.
  An observed active season is required before selecting its episode; a click
  dispatch alone never proves the season changed. Actual requested playback
  must be observed before reporting success.
  Dictation commas, polite requests such as “Can you please…”, and explicit
  ordinal forms such as “the first episode of the third season” are accepted
  without a model call. “Go to Rick and Morty season 3 episode 2” also uses this
  local flow.
- Keeps the search-first route local when a title is absent from Home. It
  recognizes semantic searchboxes and descriptive catalog search labels, and
  can identify a poster-only link from one unambiguous visible image title.
  Multiple distinct poster titles never become one inferred control name.
  Exact show names followed only by recognized year/rating/episode-count
  metadata are eligible; title suffixes such as “The Anime” are not.
  If an exact show link is covered, the planner can use the actual covering
  link only when the browser verifies both links have the identical complete
  destination and the covering link is freshly observed. This recovery requires
  that no press was dispatched. It does not click through an overlay.
  A covering link omitted from the compact page is read directly once before
  any click is proposed. The original poster can disappear after hover; the
  covering link must still retain its observed identity and destination.
  Custom season comboboxes and shorthand episode labels such as `S3 E1` use
  the same current-page verification as native selectors. Named pickers such
  as “Select a season” and “Season selector” work on a generic Series page
  when the exact show heading is present. Season labels can append a known
  episode count, such as “Season 3 (10 Episodes)”; unrelated suffixes are refused.
- Falls back to the selected model for ambiguity or unfamiliar layouts, without
  changing the original task. Search entry and submission can be grouped into
  one response, as can other already-present controls (maximum three actions).
  Each target is checked immediately before execution. Navigation, uncertain
  results, failures and denied permission discard the remaining group.
- Constrains native Gemini fallback responses with the
  [documented action JSON Schema](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)
  using `responseJsonSchema`. Single actions, existing-control groups and
  bounded memory have explicit shapes; selectors, scripts and extra fields
  are excluded. Runtime validation still enforces IDs, string limits, URLs,
  permissions and live targets. A truncated Gemini response pauses once with
  its actual reason. The schema adds request tokens only to Gemini fallback
  calls; actual provider usage logs include them.
- Waits for a navigation to finish before reading the page it led to. Each
  observation names the page the agent last saw; if the address has changed, or
  YouTube’s top progress bar is up, the content script waits for the bar and
  then a 120 ms window with almost no DOM change, at most four seconds. YouTube
  changes the address at once but shows search results about 1.2 seconds later,
  with the page unchanged for ~600 ms in between, so DOM quiet alone is no
  signal. A `navigate` action also waits for the new document to load.
- Plays a YouTube creator’s latest video locally (see above). It recognizes the
  channel only by an exact name or handle match, waits until the Videos tab
  shows as selected, and picks the first video by document order; if the
  observation left out any control between the sort chips and that video, the
  model decides instead. Once the model has acted, the planner never starts a
  new search over its work.
- Sends a playback goal back to the model once if it reports success while no
  video on the page is playing.
- Replaces the blanket quiet-page delay with a single render opportunity,
  bounded at 60 ms. A successful known transition can poll for missing state
  for up to two seconds, with at most four seconds of polling across a task.
  This also applies when the model supplies the exact-show typing/Enter step,
  allowing the local planner to take over as results arrive. Failed or
  uncertain actions never start this wait. Page loading time is real and
  cannot be removed by the controller. A successful model-assisted season
  change can also wait for the next pane locally. Uncertain dispatches never
  commit shortcut progress or count as completed actions.
- Sends a shorter instruction prompt, smaller current observations, and compact
  prompt memory without duplicating the original goal. Durable memory stays
  outside the prompt and retains its previous bounds.
- Uses a 600-token default output budget and sets Groq GPT-OSS models to
  `reasoning_effort: "low"` with `include_reasoning: false`, using the
  [documented Groq GPT-OSS controls](https://console.groq.com/docs/reasoning).
  `reasoning_format` is not supported for those models and is not sent. The
  exact saved model ID and key are used for each connection.
- Saved-model requests switch immediately on a 429 instead of retrying the
  limited connection. At most one request per eligible connection is attempted
  in a turn, and all connections share a ten-second deadline including storage,
  UI callbacks and response bodies. If all are limited, the task pauses with
  the closest retry countdown. The adapter's bounded short retry remains for
  legacy direct requests. Retry-After is never truncated to retry early.
- Caches semantic/layout reads only inside one observation, with fresh reads
  before actions and subsequent observations. Video clock ticks do not count
  as meaningful page progress; playback/selection changes still do.
  Hover and press events also recheck the target before continuing a click.
  A replacement or new overlay stops the gesture; interruptions after a press
  are marked uncertain and require observation before any further action.
  Click points come from actual client rectangles, clipped visible areas and
  bounded descendant surfaces, with at most 48 tested points. This avoids
  reporting wrapped links as covered just because their bounding box contains
  empty space. Every accepted point must still hit the original target or its
  descendant; a real covering overlay is never bypassed.
  A real pointer reaches its target by moving there, so an empty layer that
  paints nothing (no content, a transparent fixed/absolute box, not a control)
  first gets one mouse move. Hulu's instant search covers its results with such
  a layer while the keyboard drives the list and removes it on that move. The
  layer never receives a press, and the target must then pass the hit test
  again; a layer that stays is reported as covered.

`[jester] task timing` prints copyable JSON with total time, model-call count,
local-action count, intent-recognition status, observation/execution time,
storage checkpoints and readiness polling. A zero local-action count points
to a command/layout that did not use the local path. `[jester] local intent`
and `[jester] local fallback` distinguish parser recognition from unavailable
or ambiguous controls without logging the transcript. Model
results also include attempts, request time, retry wait and actual token usage
where the provider supplies it. These logs distinguish site-loading latency,
model latency and quota waits without printing prompts or keys.
`[jester] model selected` and `[jester] model cooldown` identify queue changes
without including credentials. Request timings aggregate attempts across the
saved models tried for that turn.
`[jester] action result` now records the operation, opaque target ID, source,
confirmation/outcome flags and a bounded redacted failure reason.
Failed clicks also report their error class and whether a press was dispatched.
Covered failures include up to two redacted blocking controls and `hitTest`
geometry for the top surfaces, including non-actionable covers. Geometry omits
page text, selectors, classes, IDs and URLs. This distinguishes a real overlay
from empty bounding-box space without adding a screenshot or raw DOM dump.
`[jester] invalid reply` records rejected action kinds and field names, without
the proposed field values or raw response. Task timing includes an invalid
reply count and stop reason. A previous local failure does not label every
later fallback as that same failure.

The isolated Chrome smoke test uses the production controller and semantic
extractor against a local streaming fixture with an 80 ms delayed season
transition. It completed the requested Season 3 episode in **226 ms**, with
**zero model calls**, three actions and six observations. The trace verifies
that the new season was ready before the episode click. This demonstrates the
local flow and race checks; it is not a live Netflix or Groq measurement.
The separate Hulu-style search fixture starts with Rick and Morty absent from
Home, loads search results after 1,200 ms, and delays the custom season pane by
80 ms. It completed in **1,505 ms**, with **zero model calls**, seven actions and
fifteen observations. The command includes polite phrasing and a dictation
comma; the result title includes year/rating/count metadata. Its trace verifies the exact poster was chosen over an
Anime decoy, and the requested season pane was ready before `S3 E1` was clicked.
This is a representative local DOM fixture, not a captured or live Hulu page;
Hulu network loading, ads and actual playback startup are not measured.
The covered-card variant uses the exact “go to” command for season 3, episode 2.
It completed in **1,524 ms** with **zero model calls**, rejecting the covered
poster before pressing and opening its live Details link instead. The trace
checks that neither the covered poster nor the Anime decoy receives a click.
The fragmented-link variant measures actual Chrome layout: all five former
bounding-box sample points miss the link, while its real line fragments receive
hits. The exact season 3, episode 2 request completed in **1,496 ms** with
**zero model calls** and no false covered-target failure.
The mouse-blocker variant lays a transparent full-page layer over the search
results, as live Hulu does after typing, and removes it on the next mouse move.
The same request completed in **1,510 ms** with **zero model calls** and no
covered-target failure; the trace shows the layer leaving before the exact
result opened.
The real-input check drives the same fixture with trusted DevTools-protocol
events, exactly as the worker does through `chrome.debugger`: a real click
opens Search, real text reaches the field, and the real move removes the
blocker before the press on the exact result. The screenshot check captures
the search results with every clickable control numbered, including the
image-only Anime poster, and confirms the labels come off afterwards.
A second entry point starts directly on the generic Series page, with the
requested show heading and a closed “Select a season” button. It selected
“Season 3 (10 Episodes)”, waited for the delayed episode pane, and verified
Episode 1 playback in **225 ms**, with **zero model calls** and three actions.
Run `node tests/browser-smoke.mjs` to repeat it with a fresh temporary profile
and fake extension/media APIs. `JESTER_SMOKE_CHROME` can select a Chrome binary.
The smoke run also replays YouTube’s in-app navigation timing: the observation
after the address changes waits for the results behind the progress bar.

`node tests/voice-browser-live.mjs` loads the real unpacked extension into a
temporary headless Chrome over a debugging pipe (branded Chrome ignores
`--load-extension` since version 137), turns it on, and speaks tab, site, search,
background-playback and approval commands with no model connected; each must
complete on the device.

`node tests/youtube-live.mjs ["go to MrBeast's latest video"]` runs the same
production assistant against live youtube.com in a signed-out temporary profile,
with trusted input and the content script’s own settle code, and fails if a
model is asked. On 2026-10-20 it searched, opened the channel, its Videos tab and
the newest video, and confirmed playback (behind an ad) in about six seconds, at
1280 and 1500 px wide (YouTube’s full sidebar shows at the latter). Run it when
YouTube’s markup changes; the unit fixtures cannot follow it.

The target for the example command is under ten seconds. That is a target for
an available page and responsive service, not a guarantee across site loading,
account content restrictions, manual approvals or provider quotas. No live
streaming account or paid provider inference is used by the regression tests.

## Before / after example

Previously, a names-only digest might contain:

```text
url: https://www.netflix.com/browse
title: Netflix
you can see: Continue Watching · Rick and Morty · Play · Episodes · Season 2
```

The model could request `{"type":"click","target":"season dropdown"}`;
local fuzzy matching chose a candidate, and a batch could contain more actions.

Now the relevant observation is explicit (illustrative IDs):

```text
Page: Rick and Morty | Netflix
Page ID: p8e74a221b0
[8e74a221b0.12] heading "Rick and Morty"
[8e74a221b0.18] select "Season" options: Season 1=1; Season 2=2; Season 3=3
[8e74a221b0.24] button "Play" — Season 3, Episode 1: The Rickshank Rickdemption
[8e74a221b0.30] video "Player" (paused)
```

```json
{"action":{"action":"select","elementId":"8e74a221b0.18","value":"3"},"memory":{"subgoal":"Play episode 1 of season 3","facts":["Rick and Morty is open"]}}
```

If AI is needed, the next call contains the original goal, bounded memory, a fresh semantic
observation and only the recent results. It does not contain any earlier DOM
snapshots or images. This example documents the representation, not a live
Netflix capture.

## Validation and limitations

Run `npm test` from the repository root. The suite covers semantic extraction,
secret exclusion, repeated show-card labels, stale IDs, limits, permission
checks, multi-step agent execution, long runs, restart uncertainty, provider
requests, cancellation, local recognition and gaze/cursor math.

Live camera/microphone recognition, language-pack setup, provider authentication
and actual streaming-site playback require a manual Chrome check. Synthetic
events cannot bypass user-activation requirements, protected media, CAPTCHAs,
logins, or cross-origin frames. The agent reports blocked content rather than
solving those restrictions. DOM layouts and content availability vary by site,
account and region; the generic semantic agent is not a guarantee that every
streaming flow will complete without user intervention.
