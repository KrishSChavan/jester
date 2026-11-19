# Install Jester on a Mac

You need a Mac with Apple silicon (M1 or later) and macOS 13 or later.

## 1. Download

[Download Jester for Mac](https://github.com/KrishSChavan/jester/releases/latest/download/Jester-mac-arm64.dmg)
(about 145 MB).

Open the downloaded `Jester-mac-arm64.dmg` and drag **Jester** onto the
**Applications** folder beside it.

## 2. Open him, and get past the warning

Jester isn't signed with a paid Apple developer certificate, so the first time
you open him macOS says it can't check him. This happens once.

**macOS 15 (Sequoia) and later**

1. Open **Jester** from Applications. macOS says *“Jester” Not Opened: Apple
   could not verify “Jester” is free of malware…* Press **Done**.
2. Open **System Settings › Privacy & Security** and scroll down to
   **Security**. It says *“Jester” was blocked to protect your Mac.* Press
   **Open Anyway**, then **Open Anyway** again, and confirm with your password
   or Touch ID.

**macOS 13 and 14**

1. In Applications, hold Control and click **Jester**, then choose **Open**.
2. Press **Open** in the dialog.

**If you'd rather use Terminal**, this does the same on any version:

```sh
xattr -dr com.apple.quarantine /Applications/Jester.app
```

If you opened Jester straight from the disk image or your Downloads folder, he
offers to move himself to Applications. Say yes: macOS remembers what you've
allowed him only when he stays in one place.

## 3. First launch

Jester appears in the menu bar (a small jester's head) and opens his window.
Across the top it says what's left to set up; **Getting started** walks you
through it. See [Getting started](first-run.md).

He downloads what he hears and speaks with by himself, about 500 MB. You can
type to him while it comes in.

## Updating

Download the new version and drag it over the old one in Applications. Quit
Jester first (his menu-bar icon › Quit).

Because he isn't signed by Apple, macOS treats each new version as a new app:

- You'll go through **Open Anyway** again.
- macOS may ask again for the microphone and camera.
- **Accessibility** can look switched on and not work. In System Settings ›
  Privacy & Security › Accessibility, select Jester, remove him with the **−**
  button, then ask Jester to do something that clicks or types: he'll ask for
  it again.
- macOS may ask for your password so Jester can read his own saved model keys
  (*“Jester” wants to use your confidential information stored in “Jester Safe
  Storage”*). Choose **Always Allow**.

Your settings, chats and downloaded models are kept: they live in
`~/Library/Application Support/Jester`, not in the app.

## Removing him

Quit Jester and drag him from Applications to the Trash. To remove everything
he kept as well, delete `~/Library/Application Support/Jester` and
`~/Library/Logs/Jester`.
