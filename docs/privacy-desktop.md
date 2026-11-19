# What leaves your computer

This is for **Jester Desktop**. The Chrome extension's policy is
[PRIVACY.md](../PRIVACY.md).

## Stays on your computer

- **Your voice.** What you say is turned into text on your computer. The sound
  isn't kept, unless you turn on keeping the clips he wasn't sure of, which
  stay on your computer too.
- **The camera.** Frames are read on your computer for gestures and the
  pointer, and never kept or sent.
- **His voice** is made on your computer.
- **Your model keys** are stored encrypted with your system's keychain
  (macOS) or data protection (Windows), and never shown again.

## Goes out, and to whom

- **Your words, as text, go to the model you chose**, so it can answer. With
  them goes what he needs to answer well or do what you asked: the names and
  text of the buttons and fields in the app he's working in (and, if you
  allow Screen Recording, a picture of its window), the parts of your notes
  that bear on what you said, today's calendar, and the town you're in. With
  [Ollama](https://ollama.com), all of that goes to your own computer and
  nowhere else.
- **Speech models, once.** The first time he opens, he downloads what he
  hears and speaks with from the [sherpa-onnx project's release
  page](https://github.com/k2-fsa/sherpa-onnx/releases) on GitHub. Nothing
  about you is sent beyond what any download reveals (your internet address).
- **Weather**, if you set it up, sends your town or your coordinates to
  [Open-Meteo](https://open-meteo.com). If you let him use this computer's
  location, your coordinates also go to OpenStreetMap, to be told the name of
  the place.
- **Calendars** are fetched from the links you paste, from whoever hosts them.
- **Reminders sent to your phone** pass through [ntfy](https://ntfy.sh)'s
  server, to a topic only you know the name of.
- **Email**, if you connect it, is read from Google by your computer. Who a
  message is from, its subject and its first few words are shown to your model
  to judge what's worth telling you, unless you turn that off in Settings ›
  Email.
- **Web research** fetches the pages it reads, from the sites that host them,
  and its search terms go to the search engine.

Jester has no account, no analytics and no server of his own that he reports
to.

## What he keeps, all on your computer

- Your conversations with him, for a week (Chats, in his window).
- What he's learned about you, in your Obsidian vault if you gave him one, as
  plain files you can read, change or delete.
- Your to-do list, reminders and timers.
- A log of what he did since he was last opened, and the run before. It
  includes what you asked him. Lines that look like a password or a card
  number are left out.

Where: `~/Library/Application Support/Jester` and `~/Library/Logs/Jester` on a
Mac; `%APPDATA%\Jester` on Windows.

## What he won't do without asking

He asks before he sends, buys, deletes or changes a system setting, and he
never types a password or a card number.
