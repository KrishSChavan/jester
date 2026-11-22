# What leaves your computer

This is for **Jester Desktop**. The Chrome extension's policy is
[PRIVACY.md](../PRIVACY.md).

## Stays on your computer

- **Your voice.** What you say is turned into text on your computer. The sound
  isn't kept, unless you turn on keeping the clips he wasn't sure of, which
  stay on your computer too. While someone is speaking, the last couple of
  seconds are read for his name, so he can show he's listening at once; that
  reading is thrown away. Once you've taught him your voice, a voice that
  isn't yours is never turned into text at all, with one exception: for up
  to a minute after he's asked you something, a word or two said then is
  read even when it's too short to tell whose voice it is, because a "yes"
  always is. In that minute someone else's "yes" would count as yours. The
  same goes for the 20 seconds after he asks you a question in conversation
  ("Want me to look it up?"): a yes or a no on its own then is taken as your
  answer without his name, whoever says it, and with or without a voiceprint.
  Anything longer, and anything that sounds nothing like you, is still left
  unread.
- **The camera.** Frames are read on your computer for gestures and the
  pointer, and never kept or sent.
- **Your face and training mode.** Scanning your face keeps the shape of it
  as 120 numbers (distances between points on it), sealed on your computer:
  never a picture, and never sent anywhere, your server included. While
  training mode is on, the camera stays on, and each frame is turned into
  those numbers and how open your mouth is, kept for a minute and a half to
  tell whether something just said was you talking. Each thing said while
  it's on has its voice's numbers worked out, someone else's too (their words
  are still never read); only those said with your face talking on camera are
  kept, the newest 60, sealed where your voiceprint is. On the cloud setup
  your server asks your computer "was that them?" about each line and is told
  yes or no; nothing of your face goes with the answer. Forgetting your voice
  forgets all of it; forgetting your face turns training off.
- **His voice** is made on your computer.
- **Your model keys** are stored encrypted with your system's keychain
  (macOS) or data protection (Windows), and never shown again.

## Goes out, and to whom

- **Your words, as text, go to the model you chose**, so it can answer. With
  them goes what he needs to answer well or do what you asked: the names and
  text of the buttons and fields in the app he's working in (and, if you
  allow Screen Recording, a picture of its window), the parts of your notes
  that bear on what you said, today's calendar, the town you're in, and how
  you've told him you like things done ("Hulu profile: Krish"). When you say
  his name, what you said in the half minute before goes too, as context:
  your voice only, held in memory until then, and never kept. With
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
- How you like things done: your answers when he's asked which one you mean
  (which profile, which Dad), until you remove them in Settings › Tools and
  choices.
- A log of what he did since he was last opened, and the run before. It
  includes what you asked him. Lines that look like a password or a card
  number are left out.

Where: `~/Library/Application Support/Jester` and `~/Library/Logs/Jester` on a
Mac; `%APPDATA%\Jester` on Windows.

## Other apps using his tools

Off unless you turn it on (Settings › Tools and choices). While it's on, other
programs running as you on this computer can ask Jester to work the computer,
Chrome, the web and your notes for them, and they see what those tools report
back. It's a socket file in his own folder: nothing on the network can reach
it. He still shows what he's doing and asks you before anything is sent,
bought or deleted. [More](tools.md#other-apps-using-his-tools).

## What he won't do without asking

He asks before he sends, buys, deletes or changes a system setting, and he
never types a password or a card number.
