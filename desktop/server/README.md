# Jester in the cloud

His brain runs on a server: his conversation, memory, tasks, reminders, mail and briefs. You talk to him on his
website from any of your devices, and from the Jester app on your Mac. The Mac is his hands, eyes and ears there.
Gestures, the cursor, Chrome and your apps never leave it.

```
            Your server: his brain (this folder)
   conversation · memory (your vault) · tasks · reminders · mail · briefs · his voice · hearing
                 ▲                                     ▲
      his website, in any browser          Jester on your Mac ("Use Jester in the cloud")
      on your tailnet: type or talk        gestures, cursor, apps, Chrome, Apple Watch, lights
```

It's the same app as on the Mac, started with `JESTER_SERVER=1` (main.js). The server has no camera, cursor,
overlays, menu bar or driver, and his window is a website (`src/main/web-gateway.js`).

## What it costs

Nothing, on Oracle Cloud's Always Free tier: an **Ampere A1** server with 4 cores and 24 GB of memory, 200 GB of
disk and 10 TB of traffic a month.

- **Talking is done by a cloud model.** Use Groq's free `openai/gpt-oss-120b`, ticked for Talking, or Claude.
  The server has no GPU. On its CPU, Ollama's 9b model would take tens of seconds before each answer.
- **Ollama on the server does two cheap jobs.** It searches your notes by meaning with `nomic-embed-text`, and
  `qwen3.5:2b` answers when the cloud model can't (out of free requests, say).
- **Oracle can reclaim Always Free servers it finds idle** (low CPU, network and memory use over a week). To avoid
  that, upgrade the account to Pay As You Go: Always Free resources stay free, and reclaiming doesn't apply. That
  upgrade also helps when creating the server says "Out of capacity". Set a budget alert of $1 if you want to be sure
  nothing's ever charged.

## Setting it up

### 1. The server

In the Oracle Cloud console: **Compute › Instances › Create instance**.

- **Image:** Canonical Ubuntu **24.04** (not "Minimal").
- **Shape:** Ampere › **VM.Standard.A1.Flex**, 4 OCPUs, 24 GB memory.
- **Networking:** the defaults, with a public IP so you can SSH in. Don't open any other ports: Tailscale needs none.
- **SSH keys:** upload your Mac's `~/.ssh/id_ed25519.pub`, or let Oracle make a key and download it.
- **Boot volume:** 100 GB is plenty.

"Out of capacity"? Try another availability domain, or try again later. Pay As You Go (above) helps too.

### 2. Tailscale, on your devices

Install Tailscale (free) on your Mac and phone, and sign in to each with the same account: tailscale.com/download.
In the admin console (login.tailscale.com › DNS), turn on **MagicDNS** and **HTTPS Certificates**. His website
needs HTTPS: browsers only use the microphone on a secure page.

### 3. Run the setup

```sh
ssh ubuntu@<the server's public IP>
curl -fsSL https://raw.githubusercontent.com/KrishSChavan/jester/desktop-app/desktop/server/setup.sh | bash
```

It takes 10–15 minutes. It installs everything, signs the server in to Tailscale (open the link it prints), and
starts Jester. At the end it prints **his link**: `https://<server>.<tailnet>.ts.net/?key=…`. Keep it private, since
it's the key to him. If you lose it: `cat ~/.config/Jester/web-key`.

### 4. Your vault (Obsidian, via Syncthing)

Jester doesn't run Obsidian. He reads and writes your vault's Markdown files directly. Syncthing keeps the
server's copy (`~/vault`) the same as your Mac's, both ways. You keep using Obsidian on the Mac.

1. On the Mac: `brew install --cask syncthing-app` (or syncthing.net), and open it.
2. Reach the server's Syncthing from your Mac: `ssh -L 8385:127.0.0.1:8384 ubuntu@<server IP>`, then open
   http://localhost:8385.
3. In the Mac's Syncthing: **Add Remote Device**, using the server's device ID (Actions › Show ID, on the server's
   page). Accept the device on the server's page.
4. In the Mac's Syncthing: **Add Folder**, with the folder path set to your vault
   (`~/Documents/Jester-Obsidian-DB/Jester Desktop`), shared with the server. On the server's page, accept it with
   the folder path set to `/home/ubuntu/vault`.

macOS asks once whether Syncthing may use your Documents folder: allow it. Then restart Jester on the server so he
reads the whole vault: `sudo systemctl restart jester`.

Don't use iCloud for the vault here: it can't sync to a Linux server.

### 5. His website

On each device, open his link once (the one ending in `?key=…`). It's remembered after that, so bookmark
`https://<server>.<tailnet>.ts.net/`. A device that isn't signed in gets a page to paste the link into.

**As an app:** his website installs like one, with his icon, full screen, from the Home Screen. On an iPhone, in
Safari: **Share › Add to Home Screen** (his Settings has a card saying so for the browser you're in; Chrome on
Android or a computer gets an **Install** button there). An iPhone's Home Screen app keeps its own sign-in, apart
from Safari's: added from his signed-in site, it signs itself in the first time it opens, within a day; after that,
or on another device, **Settings › Copy a sign-in link** makes a link that works for a day (never the key itself).
With Tailscale off, the app says it can't reach him instead of showing an error.

Then, in his Settings on the website:

- **Models:** add your Groq key and tick **Talking**; add your Claude key and tick **Actions**. Your Mac's keys stay
  sealed in its keychain, so the server needs its own.
- **Assistant and voice:** his voice, and your voice (teach it again on the website, with your laptop's or phone's
  mic). Notifications are in Settings › Devices.
- **Weather and calendars:** **Where your device is** (the phone or computer you're using says where it is, after
  its browser asks you once), or **a place**. Add your calendars' links again.
- **Memory:** it reads `~/vault`. **Choose** uses that folder; there's no folder picker on a server.

To talk out loud on the website: click anywhere on his page (that browser becomes the one he hears and speaks
through), then turn on listening. Your browser asks for the microphone the first time. The last browser you click
in, or your Mac when you sit back down at it, is the one he uses.

### 6. Your Mac

In Jester on the Mac: **Settings › Jester in the cloud**, paste his link, and **Use it**. He restarts. After that:

- His window (the Dock icon, or Talk in the menu bar) is the server's website.
- Settings stays this Mac's own: gestures, permissions, Chrome, Apple Watch.
- What you ask him to do on the computer, by voice on any device or typed on the website, is done on the Mac.
- **Controls** (the sliders button) is on the website too, phone included, and runs your Mac's scripts (your
  lights) through the Mac's link. Adding a script folder is the Mac's: its + opens a folder dialog on the Mac, and
  a script that's new, or runs something new, is only added once you say yes in a dialog on the Mac. With the Mac
  away, Controls says so.
- The Mac's clock is off: reminders, timers, mail and briefs come from the server, once.

**Stop** on the same page goes back to Jester on the Mac alone.

**The first time a Mac links**, its Jester moves in (`src/main/move-in.js`): the models' keys, the Gmail sign-in,
calendars, tasks and reminders, taught phrases, your voiceprint, recent chats and settings go to the server over the
link, once, and the server starts again with them. Keys are sealed on the server's disk. After that the server's is
the one that counts: a Mac linking again moves nothing. What's the Mac's alone stays there (its scripts and scenes,
the watch's key, the pointer's calibration).

### 6b. Every device, linked

- **Devices** (Settings › Devices on the website): every phone, browser and computer he's been opened on, whether
  he's open there now and on what, and when it was last used. He's told the same with what you say, so "where are you
  open?" has an answer. Name this device there.
- **A chat per device.** The phone and the laptop each have their own chat going on, so both can be asked something
  at once. A banner on his screen offers the chat going on on another device (one with a running task first): tap it
  to see that chat and type into it; close it to keep it out of the way. Chats that are over are one list, each
  marked with its device.
- **Notifications from his own app**, in place of ntfy: on the phone, open Jester from the Home Screen, then
  Settings › Devices › **Notifications here › Turn on**. What he has to tell you while you're away from your
  devices, a task finishing, or a yes-or-no he needs, comes as a notification. It's encrypted to the device (Web
  Push): the push service that carries it can't read it.
- **The phone as a remote.** What you ask for on a computer is done on your Mac. The hand and the moon on his screen
  are the Mac's (gestures, sleep), Controls runs its scripts, and Settings › Devices has its Sleep, Gestures and
  Stop its task.
- **More than one computer.** Each Mac that links is listed. What's asked goes to the one you name ("on my
  MacBook", "on the desktop"), else the one the chat is on, else the one you touched last; a task's question comes
  back to the chat that started it.

### 7. Email (Gmail), optional

Copy the Google client file you used on the Mac to the server, and name it in `~/jester.env`:

```sh
scp ~/Downloads/client_secret_*.json ubuntu@<server IP>:~/google-client.json
ssh ubuntu@<server IP> "sed -i 's|^# JESTER_GOOGLE_CLIENT=|JESTER_GOOGLE_CLIENT=|' ~/jester.env && sudo systemctl restart jester"
```

Then, on the website: **Settings › Email**, choose the file (it uses that one), and **Sign in**. Google's page opens
in a new tab, and ends on a page that "can't be reached", because it's trying to go back to the server. Copy that
page's whole address from the address bar, paste it in the box on Jester's page, and **Finish signing in**.

## Bringing what's on your Mac along (optional)

Tasks, reminders and the past week's chats are files in `~/Library/Application Support/Jester/` on the Mac:

```sh
cd ~/Library/Application\ Support/Jester
scp tasks.json chats.json recollections.json ubuntu@<server IP>:~/.config/Jester/
ssh ubuntu@<server IP> sudo systemctl restart jester
```

## Looking after it

| | |
|---|---|
| Is he running? | `systemctl status jester` |
| What's he doing? | `tail -f ~/.config/Jester/logs/dev.log` |
| Why didn't he start? | `journalctl -u jester -n 80` |
| Update him | run the setup line again: it pulls the latest and restarts him |
| A new key (everyone signs in again) | `rm ~/.config/Jester/web-key && sudo systemctl restart jester` |

## What doesn't work on the server (yet)

- **Where you are, from the device.** Pick a place in Settings.
- **Scripts on your home network** (lights): they run on the Mac, so they work when you ask from any device. A
  script set for a time (“lights off at 11”) is the server's, and can't reach your lights.
- **Importing chats from Claude or ChatGPT.** Import them on the Mac before switching: they land in the vault,
  which syncs.
- **Web research on the server itself.** Briefs that research the web need `npm run scraping:setup` on the server;
  research you ask for is done by the Mac.
- **Always-on listening streams the microphone to the server** (about 30 KB a second) while it's on. Over Tailscale
  that's encrypted end to end.
