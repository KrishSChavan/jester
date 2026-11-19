# Getting started

The first five minutes with Jester Desktop. If you haven't installed him yet:
[Mac](install-mac.md) · [Windows](install-windows.md).

When Jester opens for the first time his window shows a line across the top
saying how much is left to set up. Press **Set up** on it for **Getting
started**: a list of everything, each item with a button that takes you to
where it's done. This page explains each item.

## Needed

### 1. Give him a model to think with

Jester turns what you say into text on your computer, then needs a language
model to understand it and answer. You choose which.

**With an API key** (the easiest way to start):

1. Get a key. Two services have free plans:
   - Groq: [console.groq.com/keys](https://console.groq.com/keys)
   - Google Gemini: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

   Paid ones work too: Claude ([console.anthropic.com](https://console.anthropic.com)),
   OpenAI, or any OpenAI-compatible service.
2. In Jester: **Settings › Models**. Choose the provider, type the model's ID
   (the box shows an example for each provider), paste the key, choose Free or
   Paid, and press **Add model**.
3. Leave **Talking** ticked. A model that isn't ticked for Talking can't
   answer you; **Actions** is what lets it work apps for you. One model can do
   both.

**Without a key, on your own computer:** install [Ollama](https://ollama.com)
and pull a model. Jester finds it by himself and lists it under **This
computer (Ollama)**. Nothing you say leaves your machine. This wants a recent
computer with 16 GB of memory or more.

You can add several models. Paid ones are asked first, and if one fails
another covers for it.

### 2. What he hears with

Nothing to do: he downloads it himself the first time he opens (about 500 MB
in all, of which the first 110 MB is what he needs to hear you). The line at
the top of his window and **Getting started** show how far it's got, and you
can type to him meanwhile. If the download stops, press **Try again** there or
in **Settings › General › Downloads**.

### 3. Let him hear you and work the computer

Jester asks your computer for each permission the moment something first needs
it, so you don't have to do anything here in advance. If you'd rather allow
things now, **Settings › Permissions** has an **Allow…** button for each. See
[Permissions](permissions.md).

## Then turn on listening

**Press the microphone under the orb.** Until you do, Jester hears nothing and
you can only type to him. The first time, your computer asks whether Jester
may use the microphone.

After that, say **“Jester”**, then what you want:

- “Jester, set a timer for ten minutes.”
- “Jester, open Notes and write down milk and eggs.”
- “Jester, what's the weather like?”
- “Jester, play some jazz on Spotify.”

The first time he has to click or type for you, macOS asks you to allow
**Accessibility**. He tells you so, and opens the right page of System
Settings.

## When you want them

Everything below is optional and off until you turn it on.

| | What it adds | Where |
|---|---|---|
| **Teach him your voice** | You read five sentences. After that he answers you and not anyone else in the room who says his name. | Settings › Assistant and voice |
| **His own voice** | Downloads with the rest. Until it arrives he speaks with your computer's voice. | Settings › Assistant and voice |
| **Hand gestures** | He watches for your hand through the camera: a raised finger opens the microphone, other poses do what you choose. Turning it on is when the camera is asked for. | Settings › General › Gestures |
| **A place for what he remembers** | Point him at an [Obsidian](https://obsidian.md) vault. He keeps notes there and learns what matters about you, in plain files you can read and change. | Settings › Memory |
| **Your day** | Tell him where you are and paste your calendars' links (Google's “secret address in iCal format”, or your school's). He can then give you a morning brief, an evening wrap-up and a word before each event. | Settings › Weather and calendars |
| **Your phone** | With the free [ntfy](https://ntfy.sh) app, reminders reach you when you're away from the computer. | Settings › Assistant and voice |
| **Your email** | He tells you when something important arrives in Gmail. Read-only. Takes a little more setting up: see below. | Settings › Email |
| **Chrome** | Add [his extension](chrome-extension.md) and link it, and he can work your tabs and pages. | Settings › Chrome |

### Email, if you want it

Google makes every app that reads Gmail sign in through a “client” registered
with Google, and Jester doesn't ship with one. Two ways to get one:

- **Borrow one.** Whoever gave you Jester can add your Gmail address as a test
  user of theirs (Google Cloud console › Google Auth Platform › Audience) and
  send you their client's JSON file. The file lets Jester ask to sign in and
  nothing else: your mail stays between your computer and Google.
- **Make your own**, free, in the [Google Cloud console](https://console.cloud.google.com):
  create a project, turn on the Gmail API, set up the Google Auth Platform
  (External, with yourself as a test user), and under Clients create one of
  type “Desktop app” and press Download JSON.

Then in Jester, **Settings › Email**: **Choose the file**, and **Sign in with
Google**. Google will say it hasn't verified the app; that's expected for a
client in its testing state. He asks only to read mail: he can't send, reply
or delete. While the client is in testing, Google signs him out every seven
days; he tells you when it happens.

## What he asks before doing

He asks before he sends, buys, deletes or changes a system setting, and he
never types a password or a card number: you enter those yourself. Answer
with 👍, the **Allow** on his pill, or by saying yes.

Something not working? See [Troubleshooting](troubleshooting.md).
