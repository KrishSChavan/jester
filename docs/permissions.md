# Permissions

Jester asks for nothing up front. He asks your computer for each permission at
the moment something first needs it. If you ask him for something he isn't
allowed to do, he says what's missing and where to allow it, and on a Mac he
opens that page of System Settings for you.

You can see where everything stands, and allow things ahead of time, in
**Settings › Permissions**.

## On a Mac

All of these are in **System Settings › Privacy & Security**. Jester is listed
there as **Jester**.

| Permission | He asks when | Without it | Page in Privacy & Security |
|---|---|---|---|
| **Microphone** | You press the microphone under the orb, start a voice command, or teach him your voice | He can't hear you. You can still type to him. | Microphone |
| **Accessibility** | He first has to click, type, press a key, use a menu or read a window | He can still open and quit apps, open sites and change the volume. Nothing else. | Accessibility |
| **Camera** | You turn on Gestures or the eye/head pointer | No gestures and no pointer. Voice is unaffected. | Camera |
| **Location Services** | You set Location to “This Mac's location” (Settings › Weather and calendars), or ask about the weather with it set | He doesn't know where you are. You can name a town instead. | Location Services |
| **Screen Recording** | A model that reads pictures is about to work an app for the first time | He works from the window's text instead, which is nearly always enough. | Screen & System Audio Recording (Screen Recording before macOS 15) |
| **Bluetooth** | You turn on the Apple Watch | The watch can't steer the pointer. | Bluetooth |
| **Files and Folders** | You choose an Obsidian vault in Documents, Desktop or Downloads | He can't read or keep notes there. | Files and Folders |
| **Automation** | A script you added to Controls tells another app what to do | That script fails; he says why. | Automation |

How each one is asked:

- **Microphone, Camera, Location, Bluetooth, Files:** macOS shows its own
  question with **Allow** and **Don't Allow**. It only ever asks once. If you
  chose Don't Allow, switch Jester on in the page named above.
- **Accessibility and Screen Recording:** macOS doesn't offer an Allow button.
  You switch Jester on in System Settings. He opens the page for you.

### If a permission looks on but doesn't work

This happens with **Accessibility** after installing a new version: the switch
is on, and he still says he can't click or type.

1. Open System Settings › Privacy & Security › Accessibility.
2. Select **Jester** and press the **−** button under the list to remove him.
3. Ask Jester to do something that types or clicks (or press **Allow…** in his
   Settings › Permissions). He's added back; switch him on.

### If macOS never asked about Location

Open Jester's window so he's in front, go to **Settings › Weather and
calendars**, and press **Locate again**. Asked from the menu bar, the question
didn't always appear, so Jester now brings his window forward before asking
and keeps asking until it's answered.

## On Windows

Windows has one switch per kind of access, shared by all desktop apps, and no
per-app question.

| Permission | Where |
|---|---|
| **Microphone** | Settings › Privacy & security › Microphone › **Let desktop apps access your microphone** |
| **Camera** | Settings › Privacy & security › Camera › **Let desktop apps access your camera** |
| **Location** | Settings › Privacy & security › Location › **Let desktop apps access your location** |

Jester needs no permission to click and type on Windows. He can't work an app
that's running as administrator unless he is too.

## On his website

If you run [Jester on a server](../desktop/server/README.md) and open him in a
browser, it's the browser that asks:

- **Microphone:** when you first talk to him there.
- **Location:** a bar at the bottom of the page says he'd like to know where
  the device is, with an **Allow location** button. Your browser only shows
  its own question after you press it.
- **Notifications:** when you turn them on in Settings › Devices.

To change an answer later, use the browser's settings for that site (on an
iPhone: Settings › Apps › Safari › Location, Microphone).

## The Chrome extension

Chrome asks for the camera and microphone the first time you allow them in the
extension's Settings. See [The Chrome extension](chrome-extension.md).
