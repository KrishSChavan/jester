# The Chrome extension

Jester for Chrome controls video and web pages with hand gestures, an eye or
head cursor, and spoken commands. It works on its own, with no desktop app.

## Install

Add it from the [Chrome Web Store](https://chromewebstore.google.com/detail/jbfmeaijggbkkakdiinamgjjmcfblpab).
It works in Chrome and in browsers built on it (Edge, Brave, Arc, Vivaldi).

## Set up

1. Click Jester's icon in the toolbar and open **Settings**.
2. **Allow the camera**, for gestures and the eye/head cursor. Frames are
   processed in the browser and never leave your computer.
3. **Allow the microphone** and press **Set up on-device speech**, for voice
   commands. Chrome may download a language pack; recognition is local. A
   browser without local speech support can't use voice (there's no cloud
   fallback); gestures and the cursor still work.
4. Under **AI assistant**, choose a provider (OpenAI, Anthropic, Gemini, Groq,
   or a custom OpenAI-compatible endpoint), enter a model ID and your API key,
   and press **Add model**. Add more and order them: a rate-limited model
   hands over to the next. Groq and Gemini have free plans.
5. Turn Jester on and open a streaming site.

## Use

- **Gestures:** a closed fist pauses, thumbs change the volume, swipes seek.
  Every binding can be changed in Settings.
- **Voice:** hold ☝️ until it fires (or press **Alt+Shift+J**), lower your
  hand, and say the whole command: “play season 3 episode 1 of Rick and
  Morty”, “go to MrBeast's latest video”, “skip the ad”. A black pill at the
  bottom of the page shows it listening and working. Its × cancels.
- **Cursor:** raise an open palm to aim with your eyes or head; close it into
  a fist to click. Head aiming needs no calibration.

The popup and Settings have separate switches for **Watch for gestures**,
**Voice commands** and **Cursor control**.

Under **Permissions** in Settings you choose how much it may do without
asking: review every action, allow ordinary browsing while reviewing anything
sensitive, or allow supported actions on the site a task started on.

## Link it with Jester Desktop

With both installed (Mac only for now):

1. Open Jester Desktop.
2. In the extension's Settings, under **Jester Desktop**, press **Link with
   Jester Desktop**. Chrome asks for one more permission (to talk to an app on
   your computer); allow it.

Linked, they share one camera and microphone, the extension's gestures apply
while Chrome is in front, and what you ask Jester Desktop to do in a browser
is done by the extension, which reads pages far better than the desktop app
can from outside. Jester Desktop's **Settings › Chrome** shows whether they're
linked. Unlinking returns the extension to its own camera and microphone.

## Privacy

The extension's privacy policy is [PRIVACY.md](../PRIVACY.md): what stays on
your computer (camera frames and audio, always), and what your chosen AI
provider receives (the text of your command and a compact description of the
page).

## More

- [How the extension works](../jester-extension/README.md): every gesture and
  setting, the agent, token limits, latency.
- Loading it from this repository instead of the store, for development:
  [Building from source](building.md#the-chrome-extension).
