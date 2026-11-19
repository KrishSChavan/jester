# Install Jester on Windows

You need Windows 10 or 11, 64-bit.

> **This is a preview.** See [what preview means](#what-preview-means) below
> before relying on it.

## 1. Download

[Download Jester for Windows](https://github.com/KrishSChavan/jester/releases/latest/download/Jester-windows-x64-setup.exe)
(about 135 MB).

## 2. Run the installer, and get past the warning

Jester isn't signed with a paid certificate, so Windows warns you the first
time.

1. Open `Jester-windows-x64-setup.exe`.
2. Windows shows **Windows protected your PC**. Click **More info**, then
   **Run anyway**.

The installer needs no administrator rights. It installs Jester for your
account, adds him to the Start menu and the desktop, and opens him.

## 3. First launch

Jester lives in the notification area (the small icons by the clock; he may be
behind the **^** arrow) and opens his window. **Getting started** walks you
through what's left: see [Getting started](first-run.md).

He downloads what he hears and speaks with by himself, about 500 MB. You can
type to him while it comes in.

If Windows hasn't let desktop apps use the microphone or camera, Jester says
so and names the page to change it on: **Settings › Privacy & security ›
Microphone** (or **Camera**), **Let desktop apps access your microphone**.

## What preview means

The Windows build is made and started automatically on a Windows machine each
time a version is published. That check confirms that it installs its files,
starts, downloads and unpacks its speech models, loads the speech recognizer
and the gesture engine, and that its helper for clicking and typing answers.

Nobody has used it day to day yet. Clicking, typing and reading windows on
Windows were written against Microsoft's documentation and have not been tried
by a person. Expect rough edges, and please
[report what you find](https://github.com/KrishSChavan/jester/issues).

Not on Windows yet:

- **Linking with the Chrome extension.** The extension works by itself in
  Chrome on Windows; it can't yet be linked to the desktop app there.
- **The Apple Watch**, and **Apple's Shortcuts**: Mac only.
- **This computer's location** hasn't been tried on Windows. Naming your town
  in Settings › Weather and calendars works everywhere.

## Updating and removing

To update, run the new installer: it replaces the old version and keeps your
settings. To remove Jester, use **Settings › Apps › Installed apps**. What he
kept (settings, chats, downloaded models) is in `%APPDATA%\Jester`; delete
that folder to remove it too.
