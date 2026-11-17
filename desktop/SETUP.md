# Setting up Jester on your Mac

Jester is a voice assistant that lives in your menu bar. You say his name and
talk to him; he answers aloud, works your Mac for you, keeps your reminders and
timers, and can tell you about your day. This gets him running from the source,
which takes about fifteen minutes, most of it downloads.

He hasn't been packaged as an app you can just download yet, so this needs a
terminal. Windows isn't supported yet.

## What you need

- A Mac with Apple silicon, on a recent macOS.
- Apple's command line tools, which `git` and Rust both need. If you've never
  installed them, run `xcode-select --install` in Terminal and say yes.
- [Node.js](https://nodejs.org) 22.12 or newer, and [Rust](https://rustup.rs)
  (one line to install; it builds the small helper that types and clicks).
- About 1.5 GB of free disk space for Jester himself. Apple's tools and Rust
  take a few GB more, if you don't have them already.
- Something for him to think with, either of:
  - an API key for Claude, Gemini, Groq or another model service (Groq and
    Gemini have free plans), or
  - [Ollama](https://ollama.com) running a model on your own Mac, which costs
    nothing and sends nothing anywhere. It wants a recent Mac with 16 GB of
    memory or more.

## Install

```sh
git clone https://github.com/KrishSChavan/jester.git
cd jester
git checkout desktop-app
cd desktop
npm install
node node_modules/electron/install.js
npm run driver      # builds the helper; needs Rust
npm run models      # what he hears and speaks with, about 500 MB
npm run launcher    # puts a Jester app in your Applications folder
```

Then open **Jester** from Applications or Spotlight. He appears in the menu bar
and opens his window.

## First launch

His window opens with a line across the top saying how much is left to set up.
Press **Set up** on it for **Getting started**, which lists everything, each
with a button to where it's done. Three things are needed before he's any use:

1. **Let him hear you and work the computer.** macOS has to allow the
   microphone, Accessibility, and the camera. The camera is for hand gestures,
   which are on to begin with: if you don't want them, click his icon in the
   menu bar and turn Gestures off, and he stops asking for it. He's listed as
   "Jester" in System Settings, with his raised-hand icon.
2. **Give him a model to think with.** In Settings › Models, choose the
   service, paste your key and press Add model, leaving **Talking** ticked: a
   model that isn't ticked for Talking can't answer you. With Ollama running,
   there's nothing to paste: he finds its model himself.
3. **Download what he hears with.** Already done if `npm run models` finished.

Then one more, which is off until you turn it on:

4. **Have him listen for his name.** Press the microphone under the orb (or
   Settings › Assistant and voice › Continuous assistant). Until you do, he
   hears nothing, and you can only type to him.

After that, say "Jester", then what you want. Try "Jester, set a timer for one
minute", or "Jester, open Notes and write down milk and eggs".

## Worth adding

Everything else on the Getting started screen is optional, and off until you
turn it on. In rough order of how much it adds:

- **Teach him your voice.** You read five sentences, and from then on he
  answers you and not anyone else in the room who says his name.
- **A place for what he remembers.** Point him at an
  [Obsidian](https://obsidian.md) vault and he keeps notes there and learns
  what matters about you, in plain files you can read and change.
- **Your day.** Tell him your town and paste your calendars' links (your
  school's or Google's "secret address in iCal format"), and he can give you a
  morning brief, an evening wrap-up, and a word before each class.
- **Your phone.** Install the free [ntfy](https://ntfy.sh) app, and reminders
  reach you when you're away from the Mac.
- **Chrome.** He can work your tabs and pages too. In `chrome://extensions`,
  turn on Developer mode, press Load unpacked, and choose the
  `jester-extension` folder inside the `jester` folder you downloaded (that
  one, not a copy of it somewhere else: he recognizes his extension by where
  it is). Then, in the extension's Settings, under Jester Desktop, press
  **Link with Jester Desktop**.
- **Your email.** He can tell you when something important arrives in Gmail.
  This one takes more setting up, below.

## Email, if you want it

Google makes every app that reads Gmail sign in through a "client" registered
with Google, and Jester doesn't ship with one. You have two ways to get one:

- **Borrow one.** Whoever gave you Jester can add your Gmail address as a test
  user of theirs (Google Cloud console › Google Auth Platform › Audience) and
  send you their client's JSON file. That's the quick way, and it's safe: the
  file lets Jester ask to sign in, and nothing else. Your mail stays between
  your Mac and Google.
- **Make your own**, free, in the [Google Cloud console](https://console.cloud.google.com):
  create a project, turn on the Gmail API, set up the Google Auth Platform
  (External, with yourself as a test user), and under Clients create one of
  type "Desktop app" and press Download JSON.

Then, in Jester, Settings › Email: **Choose the file**, and **Sign in with
Google**. Google will say it hasn't verified the app; that's expected for a
client in its testing state. He asks only to read mail: he can't send, reply or
delete.

While the client is in Google's testing state, Google signs him out every seven
days. He tells you when it happens, and signing in again takes ten seconds.

## What leaves your Mac

- **What you say** is turned into text on your Mac. The sound isn't kept.
- **Your words, as text,** go to the model you chose, so it can answer. So
  does what he needs to answer well or do what you asked: the names and text
  of the buttons and fields in the app he's working in (and, if you allow
  Screen Recording, a picture of its window), the bits of your notes that bear
  on what you said, today's calendar, and the town you're in. With Ollama, all
  of that goes to your own Mac and nowhere else.
- **His voice** is made on your Mac.
- **Weather**, if you set it up, sends your town or your coordinates to
  [Open-Meteo](https://open-meteo.com). If you let him use the Mac's location,
  your coordinates also go to OpenStreetMap, to be told the name of the place.
- **Calendars** are fetched from the links you paste, from whoever hosts them.
- **Reminders sent to your phone** pass through ntfy's server, to a topic only
  you know the name of.
- **Email** is read from Google by your Mac. Who a message is from, its subject
  and its first few words are shown to your model to judge what's worth
  telling you, unless you turn that off in Settings › Email.

What's kept, all on your Mac: your conversations with him for a week (Chats, in
his window), what he's learned about you (in your vault, if you gave him one),
and a log of what he did since he was last opened, which includes what you
asked him and is emptied each time he starts.

He asks before he sends, buys, deletes or changes a setting, and he never types
a password or a card number.

## If something's wrong

- **He doesn't hear his name.** Check that listening is on (the microphone
  under the orb), and that the microphone is allowed (Settings › Permissions).
  Teaching him your voice helps a lot.
- **He hears you and doesn't answer.** He has no model ticked for Talking, or
  its key is wrong: Settings › Models says which.
- **Chrome won't link.** The extension has to be loaded from the
  `jester-extension` folder next to the `desktop` folder Jester runs from.
- **He can't click or type.** Accessibility isn't allowed for "Jester":
  System Settings › Privacy & Security › Accessibility.
- **Anything else.** His log is at `~/Library/Logs/Jester/dev.log`.
