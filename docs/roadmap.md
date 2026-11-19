# Roadmap

## Done

- **Jester for Chrome.** Gestures for video and tabs, an eye/head cursor with
  calibration, voice commands handled by a model you choose, separate bindings
  for full screen and windowed, sleep and wake. On the Chrome Web Store.
- **Jester Desktop for Mac.** The same gestures and pointer for the whole
  computer; a voice assistant that listens for his name, answers aloud in his
  own voice, and works any app; reminders, timers and a to-do list; weather
  and calendars; memory in an Obsidian vault; morning and evening briefs;
  Gmail watching; your own scripts as voice commands and controls; steering
  the pointer with an Apple Watch; linking with the extension.
- **A local model option.** Ollama, for talking and for actions, with nothing
  leaving the computer.
- **Jester on a server.** His brain on a small cloud machine, reachable as a
  website from a phone or any browser, with a Mac as his hands; notifications
  to the phone; a chat per device.
- **Downloads.** A Mac app and a Windows installer, built and started
  automatically for each release. He fetches his own speech models and asks
  for each permission when it's first needed.

## Next

- **Windows, properly.** The Windows build starts and passes its automated
  check, but hasn't been used day to day. To do: try clicking, typing and
  reading windows in real apps; link it with the Chrome extension (it needs a
  named pipe and a registry entry); this computer's location.
- **Signed downloads.** An Apple Developer ID and a Windows certificate would
  remove the “can't verify” warnings and let macOS keep permissions across
  updates.
- **Updating himself.** Today an update is a fresh download.
- **On his server:** falling back to the Mac's own Jester when the server
  can't be reached; live progress of a task on the phone; a passkey instead of
  a password.
- **Setting up the page reader from inside the app.** Background web research
  can use a local helper that today is only set up from a terminal.
- **Intel Macs.** Not built or tried yet.

## Ideas

- Several computers controlled together as one.
- Scrolling with the pointer pose itself, not only with gestures bound to it.
