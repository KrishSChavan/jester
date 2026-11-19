# Troubleshooting

Start with what Jester says himself. His window's top line, **Getting
started**, and **Settings › Permissions** each say what's missing, and he
tells you when you ask for something he isn't allowed to do.

## Installing

**“Jester” Not Opened / Apple could not verify… (Mac).** Expected, once:
System Settings › Privacy & Security › **Open Anyway**. Steps in
[Install on a Mac](install-mac.md#2-open-him-and-get-past-the-warning).

**“Jester is damaged and can't be opened” (Mac).** The download was changed on
the way, or unpacked by something that broke it. Delete it, download the
`.dmg` again, and drag Jester to Applications from the disk image itself.

**Windows protected your PC.** Expected: **More info**, then **Run anyway**.

**I can't find him after installing.** He has no Dock or taskbar icon while
his window is closed. Look in the menu bar (Mac) or the notification area by
the clock, possibly behind the **^** arrow (Windows). Opening Jester again
brings up his window.

## Hearing and answering

**He doesn't react to his name.**
1. Is listening on? The microphone button under the orb should be lit.
2. Is the microphone allowed? Settings › Permissions.
3. Has what he hears with finished downloading? Getting started says.
4. Teach him your voice (Settings › Assistant and voice): it helps a lot in a
   room with other sound. If he's been taught and ignores you, your voice may
   be scoring too low: teach him again in the room you use him in.

**He hears me and doesn't answer.** No model is ticked for **Talking**, or its
key is wrong or out of credit. Settings › Models says which.

**He answers slowly.** A free plan paces requests to stay under its limits.
A paid model, or a smaller one, is quicker. With Ollama, the first reply after
a pause waits for the model to load.

**The download of what he hears with stopped.** Settings › General ›
Downloads › **Try again**. It carries on from where it stopped.

**He speaks with a robotic voice.** His own voice is the last thing to
download (about 350 MB). Until then he uses your computer's.

## Doing things

**“I can't click, type or read what's on the screen.”** Accessibility isn't
allowed (Mac). He opens the page for you: switch Jester on. If it's already
on and he still says so, see [If a permission looks on but doesn't
work](permissions.md#if-a-permission-looks-on-but-doesnt-work).

**He says a command needs a model for actions.** Tick **Actions** on a model
in Settings › Models.

**He does the wrong thing in a browser.** Link the
[Chrome extension](chrome-extension.md): it reads pages from inside, which the
desktop app can't.

**He can't work one particular app on Windows.** If that app runs as
administrator, Jester has to as well.

## Location and weather

**He doesn't know where I am.** Settings › Weather and calendars: set
Location to this computer, or name a town. If it's set to this computer and
he still doesn't know, press **Locate again** with his window in front, and
allow it when your computer asks. See
[Permissions](permissions.md#if-macos-never-asked-about-location).

## Chrome

**The extension won't link.** Jester Desktop has to be running, and the
extension has to be the one from the Chrome Web Store (or, for developers, the
one loaded from the `jester-extension` folder beside the `desktop` folder he's
running from). Jester's Settings › Chrome says what it found. Linking is Mac
only for now.

## Still stuck

His log says what he did and what went wrong since he was last opened:

| | This run | The run before |
|---|---|---|
| Mac | `~/Library/Logs/Jester/jester.log` | `jester.previous.log`, beside it |
| Windows | `%APPDATA%\Jester\logs\jester.log` | `jester.previous.log`, beside it |

(Run from source with the launcher or `npm run dev:mac`, it's `dev.log` in the
same folder.)

The log includes what you asked him, so read it before sharing it. Then
[open an issue](https://github.com/KrishSChavan/jester/issues) with what you
did, what you expected, and the lines from around when it went wrong.

**Restarting him** fixes a surprising amount: his menu-bar icon › Restart, or
Settings › General › Restart Jester.
