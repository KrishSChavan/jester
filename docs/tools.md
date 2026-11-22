# His tools, and the choices he keeps

When the model Jester talks through is a Claude model (Settings › Models, ticked
for Talking), he's given **tools**: one for each place a thing can be done.
He chooses the tool, hears how it went, and tells you in his own words.

| Tool | What it's for |
| --- | --- |
| `send_message` | A text from Messages on your Mac. Never a website. |
| `use_computer` | Anything in an app on the computer: open, type, click, read what's on screen |
| `use_browser` | A website in your Chrome, through the extension: Hulu, Canvas, tabs, bookmarks |
| `search_web` | Looking something up in the background, with its sources |
| `search_notes` | Your Obsidian vault and what he remembers about you |
| `write_note`, `remember`, `forget`, `set_task`, `run_scripts` | His own: notes, memory, reminders and timers, your scripts |
| `ask_user` | One short question to you, with the ways to answer it |
| `remember_choice`, `forget_choice` | How you like things done |

He tries them in that spirit: what he can do himself first, then the computer's
own apps, then a website. A text goes to Messages even when Chrome is in front.

With any other model (Groq, Gemini, Ollama), or with **Let him choose his own
tools** off in Settings › Tools and choices, he works the older way: his model
writes one command and Jester decides where it goes from the command's own
words.

## When he asks

He asks when only you can say: two profiles on a streaming site, two people
called Dad, an account chooser. The question shows above his pill with a button
for each answer, and he says it aloud. Answer by voice ("Krish", "the second
one"), by typing, or with a click. "Never mind" leaves it, and he does nothing
on a guess.

He still asks before anything is sent, posted, bought or deleted. Choosing a
profile is never leave to do one of those.

## How you like things done

Your answer is kept, so he asks each thing once. Settings › Tools and choices
lists what he's kept ("Hulu profile: Krish") with a button to forget each. You
can also just tell him: "use the other profile on Hulu from now on", or "stop
using my dad's profile".

In Chrome this needs the extension at 0.3.0 or later.

## Other apps using his tools

Jester can lend his tools to other apps that speak the
[Model Context Protocol](https://modelcontextprotocol.io) (Claude's apps, an
editor). It's off until you turn on **Let other apps use Jester's tools** in
Settings › Tools and choices. The page then shows the lines to paste into the
other app's MCP settings.

- Only programs running as you, on this computer, can reach it. It's a socket
  file in Jester's own folder, not a network port.
- What another app has him do shows on his pill like anything else, and he
  still asks you before anything is sent, bought or deleted.
- The other app sees what his tools report back, which can include what's on
  a page or in a note it asked about.

## Checking a model

`npm run brain-check` (in `desktop/`) carries nineteen things people say to him
through the real conversation with your saved Claude model and pretend hands:
nothing is opened, sent or searched. It says which tool was chosen, what he
said, and how long his first words took. A run costs about a cent.
