//! macOS: Core Graphics events for input, the Accessibility API for what is on
//! screen, AppKit for media keys.
//!
//! Posting events needs the app to be allowed under System Settings › Privacy
//! & Security › Accessibility; so does reading other apps' elements. Without
//! it, CGEventPost drops events silently, so `permissions()` is checked first.

use crate::protocol::{Button, MediaKey, Modifier, ScrollUnit};
use crate::{Poster, Result};
use objc2::rc::Retained;
use objc2_app_kit::{NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType, NSRunningApplication};
use objc2_application_services::{
    AXCopyMultipleAttributeOptions, AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGSize};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType, CGMouseButton,
    CGPreflightPostEventAccess, CGPreflightScreenCaptureAccess, CGScrollEventUnit, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_foundation::NSPoint;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an accessibility call may wait on an app before giving up.
const AX_TIMEOUT_S: f32 = 0.5;
/// CGEventKeyboardSetUnicodeString takes at most this many UTF-16 units per event.
const UNICODE_CHUNK: usize = 20;

pub fn permissions(prompt: bool) -> Value {
    let accessibility = if prompt {
        let key = unsafe { objc2_application_services::kAXTrustedCheckOptionPrompt };
        let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
        unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) }
    } else {
        unsafe { AXIsProcessTrusted() }
    };
    json!({
        "accessibility": accessibility,
        "postEvents": CGPreflightPostEventAccess(),
        "screenCapture": CGPreflightScreenCaptureAccess(),
    })
}

pub fn init_query_thread() {}

pub struct Input {
    source: Option<CFRetained<CGEventSource>>,
    held: HashSet<Button>,
    /// How keyboard events are made and posted. Mouse events at the HID tap
    /// are proven; for shortcuts, which tap and source keep the modifier
    /// flags intact is what `configure` lets a test find out.
    key_source: Option<CFRetained<CGEventSource>>,
    key_source_name: &'static str,
    key_tap: CGEventTapLocation,
    key_delay: Duration,
}

fn key_source(name: &str) -> Option<(Option<CFRetained<CGEventSource>>, &'static str)> {
    let (state, name) = match name {
        "none" => return Some((None, "none")),
        "hid" => (CGEventSourceStateID::HIDSystemState, "hid"),
        "combined" => (CGEventSourceStateID::CombinedSessionState, "combined"),
        "private" => (CGEventSourceStateID::Private, "private"),
        _ => return None,
    };
    Some((CGEventSource::new(state), name))
}

fn mouse_type(button: Button, down: bool) -> CGEventType {
    match (button, down) {
        (Button::Left, true) => CGEventType::LeftMouseDown,
        (Button::Left, false) => CGEventType::LeftMouseUp,
        (Button::Right, true) => CGEventType::RightMouseDown,
        (Button::Right, false) => CGEventType::RightMouseUp,
        (Button::Middle, true) => CGEventType::OtherMouseDown,
        (Button::Middle, false) => CGEventType::OtherMouseUp,
    }
}

fn cg_button(button: Button) -> CGMouseButton {
    match button {
        Button::Left => CGMouseButton::Left,
        Button::Right => CGMouseButton::Right,
        Button::Middle => CGMouseButton::Center,
    }
}

fn post(event: Option<CFRetained<CGEvent>>) -> Result<()> {
    let event = event.ok_or("could not create the event")?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn modifier_flag(modifier: Modifier) -> CGEventFlags {
    match modifier {
        Modifier::Meta => CGEventFlags::MaskCommand,
        Modifier::Control => CGEventFlags::MaskControl,
        Modifier::Alt => CGEventFlags::MaskAlternate,
        Modifier::Shift => CGEventFlags::MaskShift,
        Modifier::Fn => CGEventFlags::MaskSecondaryFn,
    }
}

fn modifier_keycode(modifier: Modifier) -> u16 {
    match modifier {
        Modifier::Meta => 0x37,
        Modifier::Shift => 0x38,
        Modifier::Alt => 0x3A,
        Modifier::Control => 0x3B,
        Modifier::Fn => 0x3F,
    }
}

/// Which physical key a modifier came from (NX_DEVICE*KEYMASK, IOKit's
/// IOLLEvent.h). Ours are always the left-hand keys.
fn device_bit(modifier: Modifier) -> u64 {
    match modifier {
        Modifier::Control => 0x01,
        Modifier::Shift => 0x02,
        Modifier::Meta => 0x08,
        Modifier::Alt => 0x20,
        Modifier::Fn => 0,
    }
}

/// Every bit that says a modifier is down: the five masks, the number-pad
/// marker the arrows carry, and the left/right device bits.
const MODIFIER_BITS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000 | 0x0080_0000 | 0x0020_0000 | 0x207F;

/// Virtual key codes (kVK_*). Letters and punctuation are ANSI positions, so
/// on another layout "z" is the key where Z sits on a US keyboard.
fn keycode(key: &str) -> Option<u16> {
    let code = match key {
        "a" => 0x00, "s" => 0x01, "d" => 0x02, "f" => 0x03, "h" => 0x04, "g" => 0x05, "z" => 0x06, "x" => 0x07,
        "c" => 0x08, "v" => 0x09, "b" => 0x0B, "q" => 0x0C, "w" => 0x0D, "e" => 0x0E, "r" => 0x0F, "y" => 0x10,
        "t" => 0x11, "1" => 0x12, "2" => 0x13, "3" => 0x14, "4" => 0x15, "6" => 0x16, "5" => 0x17, "equal" => 0x18,
        "9" => 0x19, "7" => 0x1A, "minus" => 0x1B, "8" => 0x1C, "0" => 0x1D, "rightbracket" => 0x1E, "o" => 0x1F,
        "u" => 0x20, "leftbracket" => 0x21, "i" => 0x22, "p" => 0x23, "enter" => 0x24, "l" => 0x25, "j" => 0x26,
        "quote" => 0x27, "k" => 0x28, "semicolon" => 0x29, "backslash" => 0x2A, "comma" => 0x2B, "slash" => 0x2C,
        "n" => 0x2D, "m" => 0x2E, "period" => 0x2F, "tab" => 0x30, "space" => 0x31, "grave" => 0x32,
        "backspace" => 0x33, "escape" => 0x35,
        "f17" => 0x40, "f18" => 0x4F, "f19" => 0x50, "f20" => 0x5A,
        "f5" => 0x60, "f6" => 0x61, "f7" => 0x62, "f3" => 0x63, "f8" => 0x64, "f9" => 0x65, "f11" => 0x67,
        "f13" => 0x69, "f16" => 0x6A, "f14" => 0x6B, "f10" => 0x6D, "f12" => 0x6F, "f15" => 0x71,
        "home" => 0x73, "pageup" => 0x74, "delete" => 0x75, "f4" => 0x76, "end" => 0x77, "f2" => 0x78,
        "pagedown" => 0x79, "f1" => 0x7A, "left" => 0x7B, "right" => 0x7C, "down" => 0x7D, "up" => 0x7E,
        _ => return None,
    };
    Some(code)
}

/// A real keyboard sets these on the navigation keys; some apps look for them.
fn implied_flags(key: &str) -> CGEventFlags {
    match key {
        "left" | "right" | "up" | "down" => CGEventFlags::MaskNumericPad | CGEventFlags::MaskSecondaryFn,
        "home" | "end" | "pageup" | "pagedown" | "delete" => CGEventFlags::MaskSecondaryFn,
        key if key.len() > 1 && key.starts_with('f') && key[1..].parse::<u8>().is_ok() => CGEventFlags::MaskSecondaryFn,
        _ => CGEventFlags(0),
    }
}

fn button_name(button: Button) -> &'static str {
    match button {
        Button::Left => "left",
        Button::Right => "right",
        Button::Middle => "middle",
    }
}

impl Input {
    pub fn new() -> Self {
        Input {
            source: CGEventSource::new(CGEventSourceStateID::HIDSystemState),
            held: HashSet::new(),
            // What robotjs has long used for shortcuts: no source, session tap.
            key_source: None,
            key_source_name: "none",
            key_tap: CGEventTapLocation::SessionEventTap,
            key_delay: Duration::from_millis(4),
        }
    }

    fn source(&self) -> Option<&CGEventSource> {
        self.source.as_deref()
    }

    /// Changes how keyboard events are posted: `tap` "hid"|"session",
    /// `source` "hid"|"combined"|"private"|"none", `delay_ms` between events.
    pub fn configure(&mut self, tap: Option<&str>, source: Option<&str>, delay_ms: Option<u64>) -> Result<Value> {
        if let Some(tap) = tap {
            self.key_tap = match tap {
                "hid" => CGEventTapLocation::HIDEventTap,
                "session" => CGEventTapLocation::SessionEventTap,
                other => return Err(format!("unknown tap \"{other}\"")),
            };
        }
        if let Some(name) = source {
            let (source, name) = key_source(name).ok_or_else(|| format!("unknown source \"{name}\""))?;
            self.key_source = source;
            self.key_source_name = name;
        }
        if let Some(ms) = delay_ms {
            self.key_delay = Duration::from_millis(ms.min(100));
        }
        let tap = if self.key_tap == CGEventTapLocation::HIDEventTap { "hid" } else { "session" };
        Ok(json!({ "keyTap": tap, "keySource": self.key_source_name, "keyDelayMs": self.key_delay.as_millis() as u64 }))
    }

    /// Posts a keyboard event the configured way. Its modifier bits are
    /// exactly `held` — never whatever macOS believes is down, or a release
    /// could carry ⌘ and leave it stuck — plus the left-key device bits a
    /// real keyboard sends; any other bits macOS set are kept.
    fn post_key(&self, keycode: u16, down: bool, held: &[Modifier], extra: CGEventFlags) -> Result<()> {
        let event = CGEvent::new_keyboard_event(self.key_source.as_deref(), keycode, down).ok_or("could not create the key")?;
        let base = CGEvent::flags(Some(&event)).0 & !MODIFIER_BITS;
        let ours = held.iter().fold(extra.0, |flags, modifier| flags | modifier_flag(*modifier).0 | device_bit(*modifier));
        CGEvent::set_flags(Some(&event), CGEventFlags(base | ours));
        CGEvent::post(self.key_tap, Some(&event));
        // Real keys arrive milliseconds apart; back-to-back synthetic ones can
        // outrun the window server's idea of which modifiers are down.
        std::thread::sleep(self.key_delay);
        Ok(())
    }

    pub fn cursor(&self) -> Result<(f64, f64)> {
        let event = CGEvent::new(None).ok_or("could not read the cursor")?;
        let point = CGEvent::location(Some(&event));
        Ok((point.x, point.y))
    }

    pub fn move_to(&mut self, poster: &mut Poster, x: f64, y: f64) -> Result<()> {
        // With a button down, macOS expects a drag, not a move.
        let (kind, button, name) = if self.held.contains(&Button::Left) {
            (CGEventType::LeftMouseDragged, CGMouseButton::Left, "drag")
        } else if self.held.contains(&Button::Right) {
            (CGEventType::RightMouseDragged, CGMouseButton::Right, "drag")
        } else if self.held.contains(&Button::Middle) {
            (CGEventType::OtherMouseDragged, CGMouseButton::Center, "drag")
        } else {
            (CGEventType::MouseMoved, CGMouseButton::Left, "move")
        };
        poster.record(json!({ "event": name, "x": x, "y": y }));
        if poster.dry_run {
            return Ok(());
        }
        post(CGEvent::new_mouse_event(self.source(), kind, CGPoint { x, y }, button))
    }

    pub fn button(&mut self, poster: &mut Poster, button: Button, down: bool, at: (f64, f64), count: u32) -> Result<()> {
        poster.record(json!({ "event": if down { "down" } else { "up" }, "button": button_name(button), "x": at.0, "y": at.1, "count": count }));
        if down {
            self.held.insert(button);
        } else {
            self.held.remove(&button);
        }
        if poster.dry_run {
            return Ok(());
        }
        let event = CGEvent::new_mouse_event(self.source(), mouse_type(button, down), CGPoint { x: at.0, y: at.1 }, cg_button(button))
            .ok_or("could not create the click")?;
        // The click count is what makes the second click of a pair a double-click.
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventClickState, count as i64);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }

    /// Scrolls whatever is under `at`. A scroll event otherwise takes the
    /// cursor position from when it was made, which can be from before the
    /// move that preceded it has landed.
    pub fn scroll(&mut self, poster: &mut Poster, dx: f64, dy: f64, unit: ScrollUnit, at: (f64, f64)) -> Result<()> {
        poster.record(json!({ "event": "scroll", "dx": dx, "dy": dy, "unit": if unit == ScrollUnit::Line { "line" } else { "pixel" }, "x": at.0, "y": at.1 }));
        if poster.dry_run {
            return Ok(());
        }
        let units = if unit == ScrollUnit::Line { CGScrollEventUnit::Line } else { CGScrollEventUnit::Pixel };
        let event = CGEvent::new_scroll_wheel_event2(self.source(), units, 2, dy.round() as i32, dx.round() as i32, 0).ok_or("could not create the scroll")?;
        CGEvent::set_location(Some(&event), CGPoint { x: at.0, y: at.1 });
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }

    pub fn modifier(&mut self, poster: &mut Poster, modifier: Modifier, down: bool, held: &[Modifier]) -> Result<()> {
        poster.record(json!({ "event": if down { "keydown" } else { "keyup" }, "key": format!("{modifier:?}").to_lowercase() }));
        if poster.dry_run {
            return Ok(());
        }
        self.post_key(modifier_keycode(modifier), down, held, CGEventFlags(0))
    }

    pub fn key(&mut self, poster: &mut Poster, key: &str, down: bool, mods: &[Modifier]) -> Result<()> {
        let code = keycode(key).ok_or_else(|| format!("unknown key \"{key}\""))?;
        poster.record(json!({ "event": if down { "keydown" } else { "keyup" }, "key": key }));
        if poster.dry_run {
            return Ok(());
        }
        self.post_key(code, down, mods, implied_flags(key))
    }

    /// Any text, in any script: each event carries the characters themselves
    /// rather than key codes, so the keyboard layout doesn't matter. Line
    /// breaks and tabs are real key presses, which is what editors expect.
    pub fn text(&mut self, poster: &mut Poster, text: &str) -> Result<()> {
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                self.key(poster, "enter", true, &[])?;
                self.key(poster, "enter", false, &[])?;
            }
            for (j, part) in line.split('\t').enumerate() {
                if j > 0 {
                    self.key(poster, "tab", true, &[])?;
                    self.key(poster, "tab", false, &[])?;
                }
                let units: Vec<u16> = part.encode_utf16().collect();
                for chunk in units.chunks(UNICODE_CHUNK) {
                    poster.record(json!({ "event": "text", "text": String::from_utf16_lossy(chunk) }));
                    if poster.dry_run {
                        continue;
                    }
                    for down in [true, false] {
                        let event = CGEvent::new_keyboard_event(self.source(), 0, down).ok_or("could not create the text")?;
                        unsafe { CGEvent::keyboard_set_unicode_string(Some(&event), chunk.len() as _, chunk.as_ptr()) };
                        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
                    }
                }
            }
        }
        Ok(())
    }

    /// The keys above the number row, posted as the keyboard posts them: as
    /// system-defined events, which the OS routes to whatever is playing.
    pub fn media(&mut self, poster: &mut Poster, key: MediaKey) -> Result<()> {
        // NX_KEYTYPE_* from IOKit's ev_keymap.h.
        let code: isize = match key {
            MediaKey::VolumeUp => 0,
            MediaKey::VolumeDown => 1,
            MediaKey::BrightnessUp => 2,
            MediaKey::BrightnessDown => 3,
            MediaKey::Mute => 7,
            MediaKey::Play => 16,
            MediaKey::Next => 17,
            MediaKey::Previous => 18,
        };
        poster.record(json!({ "event": "media", "key": format!("{key:?}") }));
        if poster.dry_run {
            return Ok(());
        }
        for down in [true, false] {
            let state: isize = if down { 0xA } else { 0xB };
            let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::SystemDefined,
                NSPoint::new(0.0, 0.0),
                NSEventModifierFlags((state << 8) as usize),
                0.0,
                0,
                None,
                8,
                (code << 16) | (state << 8),
                -1,
            )
            .ok_or("could not create the media key")?;
            let cg = event.CGEvent().ok_or("could not convert the media key")?;
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&cg));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let key = CFString::from_str(name);
    let mut value: *const CFType = std::ptr::null();
    let error = unsafe { element.copy_attribute_value(&key, NonNull::from(&mut value)) };
    if error != AXError::Success || value.is_null() {
        return None;
    }
    Some(unsafe { CFRetained::from_raw(NonNull::new_unchecked(value as *mut CFType)) })
}

fn string_attribute(element: &AXUIElement, name: &str) -> Option<String> {
    let value = attribute(element, name)?.downcast::<CFString>().ok()?;
    let text = value.to_string();
    (!text.is_empty()).then_some(text)
}

fn bool_attribute(element: &AXUIElement, name: &str) -> Option<bool> {
    attribute(element, name)?.downcast::<CFBoolean>().ok().map(|value| value.as_bool())
}

/// An element's frame as (x, y, w, h), in screen points.
fn frame_rect(element: &AXUIElement) -> Option<(f64, f64, f64, f64)> {
    let position = attribute(element, "AXPosition")?.downcast::<AXValue>().ok()?;
    let size = attribute(element, "AXSize")?.downcast::<AXValue>().ok()?;
    let mut point = CGPoint { x: 0.0, y: 0.0 };
    let mut extent = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe {
        position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast())
            && size.value(AXValueType::CGSize, NonNull::from(&mut extent).cast())
    };
    ok.then_some((point.x, point.y, extent.width, extent.height))
}

fn frame(element: &AXUIElement) -> Option<Value> {
    let position = attribute(element, "AXPosition")?.downcast::<AXValue>().ok()?;
    let size = attribute(element, "AXSize")?.downcast::<AXValue>().ok()?;
    let mut point = CGPoint { x: 0.0, y: 0.0 };
    let mut extent = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe {
        position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast())
            && size.value(AXValueType::CGSize, NonNull::from(&mut extent).cast())
    };
    ok.then(|| json!({ "x": point.x, "y": point.y, "w": extent.width, "h": extent.height }))
}

fn actions(element: &AXUIElement) -> Vec<String> {
    let mut names: *const CFArray = std::ptr::null();
    let error = unsafe { element.copy_action_names(NonNull::from(&mut names)) };
    if error != AXError::Success || names.is_null() {
        return Vec::new();
    }
    let names: CFRetained<CFArray<CFString>> = unsafe { CFRetained::from_raw(NonNull::new_unchecked(names as *mut CFArray<CFString>)) };
    names.iter().map(|name| name.to_string()).collect()
}

/// The title of the window an element is in.
fn window_title(element: &AXUIElement) -> Option<String> {
    let window = attribute(element, "AXWindow")?.downcast::<AXUIElement>().ok()?;
    string_attribute(&window, "AXTitle")
}

fn pid(element: &AXUIElement) -> Option<i32> {
    let mut pid: i32 = 0;
    let error = unsafe { element.pid(NonNull::from(&mut pid)) };
    (error == AXError::Success).then_some(pid)
}

fn is_secure(element: &AXUIElement) -> bool {
    string_attribute(element, "AXSubrole").as_deref() == Some("AXSecureTextField")
}

fn describe(element: &AXUIElement) -> Value {
    let secure = is_secure(element);
    // A password field's value is never read, let alone sent anywhere.
    let value = if secure {
        None
    } else {
        string_attribute(element, "AXValue").map(|text| text.chars().take(200).collect::<String>())
    };
    json!({
        "role": string_attribute(element, "AXRole"),
        "subrole": string_attribute(element, "AXSubrole"),
        "roleDescription": string_attribute(element, "AXRoleDescription"),
        "title": string_attribute(element, "AXTitle"),
        "description": string_attribute(element, "AXDescription"),
        "value": value,
        "enabled": bool_attribute(element, "AXEnabled"),
        "secure": secure,
        "frame": frame(element),
        "actions": actions(element),
    })
}

/// Roles a click means something to, even when the element doesn't list AXPress.
const PRESSABLE_ROLES: &[&str] = &[
    "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXMenuButton", "AXTab", "AXDisclosureTriangle", "AXCell", "AXRow",
];

fn pressable(element: &AXUIElement) -> bool {
    actions(element).iter().any(|action| action == "AXPress")
        || string_attribute(element, "AXRole").is_some_and(|role| PRESSABLE_ROLES.contains(&role.as_str()))
}

fn app_info(pid: i32) -> Value {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid);
    json!({
        "pid": pid,
        "name": app.as_ref().and_then(|app| app.localizedName()).map(|name| name.to_string()),
        "bundleId": app.as_ref().and_then(|app| app.bundleIdentifier()).map(|id| id.to_string()),
    })
}

/// Browsers built on Chromium, which wake their tree for AXEnhancedUserInterface.
const CHROMIUM_BROWSERS: &[&str] = &[
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium",
    "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser",
];
/// Apps already asked to build their tree.
static WOKEN: Mutex<Vec<(i32, Instant)>> = Mutex::new(Vec::new());
/// A Chromium app builds its tree about two seconds after being asked
/// (measured: 20 looks, 100 ms apart, for a small Electron page). A query
/// that finds it still building looks again this often, until this long has
/// passed since the app was asked. The app calls `wake` as each app comes to
/// the front, so normally nothing waits.
const WAKE_POLL: Duration = Duration::from_millis(100);
const WAKE_TIME: Duration = Duration::from_secs(3);

/// Ask an app to build its tree now, before anything is pointed at.
pub fn wake(pid: i32) -> Result<Value> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission has not been granted".into());
    }
    let (_, first) = wake_tree(pid);
    Ok(json!({ "woken": first }))
}

/// What Chromium's web content looks like while its tree is still being
/// built: the scroll area that hosts the page, or its empty web area. A real
/// scroll area under the pointer costs one wait, on that app's first query.
fn asleep(element: &AXUIElement) -> bool {
    matches!(string_attribute(element, "AXRole").as_deref(), Some("AXScrollArea" | "AXWebArea"))
}

/// Chromium-based apps build their accessibility tree only when something
/// asks for it; until then a whole web page is one "scroll area". Electron
/// apps answer to AXManualAccessibility; Chromium itself (Chrome and its kin,
/// CEF apps like Spotify) to AXEnhancedUserInterface — which is kept to them,
/// as it makes some other apps animate their windows differently. Returns
/// when the app was first asked, and whether that is now.
fn wake_tree(pid: i32) -> (Instant, bool) {
    {
        let mut woken = WOKEN.lock().unwrap();
        if let Some(&(_, asked)) = woken.iter().find(|(woken_pid, _)| *woken_pid == pid) {
            return (asked, false);
        }
        woken.push((pid, Instant::now()));
    }
    let app = unsafe { AXUIElement::new_application(pid) };
    let yes: &CFType = CFBoolean::new(true);
    unsafe { app.set_attribute_value(&CFString::from_static_str("AXManualAccessibility"), yes) };
    if app_info(pid)["bundleId"].as_str().is_some_and(|id| CHROMIUM_BROWSERS.contains(&id)) || chromium_based(pid) {
        unsafe { app.set_attribute_value(&CFString::from_static_str("AXEnhancedUserInterface"), yes) };
    }
    (Instant::now(), true)
}

/// Chromium-based apps — Electron's, Chrome and its kin, CEF apps like
/// Spotify — known by the framework they carry: they build their
/// accessibility tree only when asked, and a moment later.
fn chromium_based(pid: i32) -> bool {
    let Some(path) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid).and_then(|app| app.bundleURL()).and_then(|url| url.path()) else {
        return false;
    };
    std::fs::read_dir(format!("{path}/Contents/Frameworks"))
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.ends_with("Framework.framework") && ["Electron", "Chrom", "Edge", "Brave", "Opera", "Vivaldi"].iter().any(|kind| name.contains(kind))
            })
        })
        .unwrap_or(false)
}

fn hit(system: &AXUIElement, x: f64, y: f64) -> Result<CFRetained<AXUIElement>> {
    let mut found: *const AXUIElement = std::ptr::null();
    let error = unsafe { system.copy_element_at_position(x as f32, y as f32, NonNull::from(&mut found)) };
    if error != AXError::Success || found.is_null() {
        return Err(format!("nothing readable at {x},{y} (AXError {})", error.0));
    }
    Ok(unsafe { CFRetained::from_raw(NonNull::new_unchecked(found as *mut AXUIElement)) })
}

pub fn element_at(x: f64, y: f64, wait: bool, debug: bool) -> Result<Value> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission has not been granted".into());
    }
    let mut trace = debug.then(Vec::new);
    let mut element = match element_under(x, y, &mut trace) {
        Ok(element) => element,
        Err(error) if debug => return Err(format!("{error}; trace: {}", Value::Array(trace.unwrap_or_default()))),
        Err(error) => return Err(error),
    };
    let mut polls = None;
    if let Some(pid) = pid(&element) {
        // Woken just now, or by `wake` a moment ago: either way, give the
        // tree until WAKE_TIME after the ask to appear.
        let (asked, _) = wake_tree(pid);
        let mut count = 0;
        while wait && asleep(&element) && asked.elapsed() < WAKE_TIME {
            std::thread::sleep(WAKE_POLL);
            element = element_under(x, y, &mut None)?;
            count += 1;
        }
        polls = (count > 0).then_some(count);
    }

    // The leaf under the pointer is often a label inside the button; climb to
    // the thing a click would press.
    let mut actionable = None;
    let mut current = Some(element.clone());
    for _ in 0..10 {
        let Some(node) = current else { break };
        if pressable(&node) {
            actionable = Some(describe(&node));
            break;
        }
        current = attribute(&node, "AXParent").and_then(|parent| parent.downcast::<AXUIElement>().ok());
    }
    Ok(json!({
        "element": describe(&element),
        "actionable": actionable,
        "app": pid(&element).map(app_info),
        "window": window_title(&element),
        // Set on an app's first query: how many 100 ms looks its tree took to appear.
        "wakePolls": polls,
        "trace": trace,
    }))
}

/// Smaller than this, a window is a tooltip, a popover or a badge (Messages
/// shows a 66 × 22 one after sending), not what anyone is working in.
const MIN_WINDOW: (f64, f64) = (120.0, 80.0);

fn substantial(window: &WindowInfo) -> bool {
    window.bounds.is_some_and(|(_, _, w, h)| w >= MIN_WINDOW.0 && h >= MIN_WINDOW.1)
}

/// One on-screen window, as the window server lists it.
struct WindowInfo {
    pid: i32,
    layer: i64,
    bounds: Option<(f64, f64, f64, f64)>,
    owner: Option<String>,
    title: Option<String>,
}

/// Every on-screen window, front to back. No permission needed for owners and
/// bounds; titles need Screen Recording and are None without it.
fn on_screen_windows() -> Result<Vec<WindowInfo>> {
    let list = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0)
        .ok_or("the window server returned no windows")?;
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> = unsafe { CFRetained::cast_unchecked(list) };
    let number = |dict: &CFDictionary<CFString, CFType>, key: &CFString| dict.get(key)?.downcast::<CFNumber>().ok()?.as_f64();
    let text = |dict: &CFDictionary<CFString, CFType>, key: &CFString| dict.get(key)?.downcast::<CFString>().ok().map(|s| s.to_string());
    let (layer_key, pid_key, owner_key, name_key, bounds_key) = unsafe {
        use objc2_core_graphics::{kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowOwnerName, kCGWindowOwnerPID};
        (kCGWindowLayer, kCGWindowOwnerPID, kCGWindowOwnerName, kCGWindowName, kCGWindowBounds)
    };
    let mut windows = Vec::new();
    for window in list.iter() {
        let Some(pid) = number(&window, pid_key) else { continue };
        let bounds = window.get(bounds_key).and_then(|value| value.downcast::<CFDictionary>().ok()).and_then(|bounds| {
            let bounds: CFRetained<CFDictionary<CFString, CFType>> = unsafe { CFRetained::cast_unchecked(bounds) };
            let field = |name: &'static str| number(&bounds, &CFString::from_static_str(name));
            Some((field("X")?, field("Y")?, field("Width")?, field("Height")?))
        });
        windows.push(WindowInfo {
            pid: pid as i32,
            layer: number(&window, layer_key).unwrap_or(0.0) as i64,
            bounds,
            owner: text(&window, owner_key),
            title: text(&window, name_key),
        });
    }
    Ok(windows)
}

/// The front window: the first ordinary one (layer 0 — menus, the Dock and
/// overlays sit above it).
pub fn frontmost() -> Result<Value> {
    let window = on_screen_windows()?.into_iter().find(|window| window.layer == 0 && substantial(window)).ok_or("no ordinary window is on screen")?;
    let mut app = app_info(window.pid);
    if app["name"].is_null() {
        app["name"] = json!(window.owner);
    }
    let bounds = window.bounds.map(|(x, y, w, h)| json!({ "x": x, "y": y, "w": w, "h": h }));
    Ok(json!({ "app": app, "window": { "title": window.title, "bounds": bounds } }))
}

// ---------------------------------------------------------------------------
// Snapshots: the front window's controls, read for the assistant and acted on
// by number
// ---------------------------------------------------------------------------

/// Read in one call per element (AXUIElementCopyMultipleAttributeValues).
const SNAPSHOT_ATTRIBUTES: [&str; 13] = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp", "AXEnabled", "AXFocused",
    "AXSelected", "AXPosition", "AXSize", "AXChildren",
];
/// How many elements a snapshot looks at, at most: a mail app's message list
/// alone can hold thousands.
const SNAPSHOT_VISITS: usize = 3000;

thread_local! {
    /// The last snapshot's number, and its elements by their numbers in it.
    static LISTED: std::cell::RefCell<(u64, Vec<CFRetained<AXUIElement>>)> = const { std::cell::RefCell::new((0, Vec::new())) };
}

/// A role in the words both platforms share; None for what a snapshot leaves out.
fn role_name(role: &str, subrole: Option<&str>) -> Option<&'static str> {
    Some(match (role, subrole) {
        ("AXTextField", Some("AXSecureTextField")) => "password",
        ("AXTextField", Some("AXSearchField")) => "searchfield",
        ("AXTextField", _) => "textfield",
        ("AXTextArea", _) => "textarea",
        ("AXComboBox", _) => "combobox",
        ("AXButton", _) => "button",
        ("AXLink", _) => "link",
        ("AXCheckBox", Some("AXSwitch")) => "switch",
        ("AXCheckBox", _) => "checkbox",
        ("AXRadioButton", Some("AXTabButton")) | ("AXTab", _) => "tab",
        ("AXRadioButton", _) => "radio",
        ("AXPopUpButton" | "AXMenuButton", _) => "popup",
        ("AXMenuItem" | "AXMenuBarItem", _) => "menuitem",
        ("AXDisclosureTriangle", _) => "disclosure",
        ("AXSlider", _) => "slider",
        ("AXIncrementor", _) => "stepper",
        ("AXRow", _) => "row",
        ("AXHeading", _) => "heading",
        ("AXStaticText", _) => "text",
        _ => return None,
    })
}

/// Controls named by what's written inside them: that text isn't listed again.
const NAMED_BY_CONTENT: &[&str] = &["button", "link", "checkbox", "switch", "radio", "tab", "popup", "menuitem", "disclosure", "heading"];
const TEXT_INPUTS: &[&str] = &["textfield", "searchfield", "textarea", "combobox"];
/// Containers whose name tells the controls inside apart: a result's "Play" from the player's.
const CONTAINERS: &[&str] = &["AXGroup", "AXRow", "AXCell", "AXList", "AXTable", "AXOutline", "AXTabGroup", "AXToolbar", "AXSheet", "AXScrollArea"];

/// One element's attributes, from a single round trip to its app.
struct Read {
    role: Option<String>,
    subrole: Option<String>,
    title: Option<String>,
    description: Option<String>,
    value: Option<CFRetained<CFType>>,
    placeholder: Option<String>,
    help: Option<String>,
    enabled: Option<bool>,
    focused: Option<bool>,
    selected: Option<bool>,
    frame: Option<(f64, f64, f64, f64)>,
    children: Vec<CFRetained<AXUIElement>>,
}

fn read_all(element: &AXUIElement, names: &CFArray<CFString>) -> Option<Read> {
    let mut values: *const CFArray = std::ptr::null();
    let error = unsafe {
        element.copy_multiple_attribute_values(names.as_opaque(), AXCopyMultipleAttributeOptions::empty(), NonNull::from(&mut values))
    };
    if error != AXError::Success || values.is_null() {
        return None;
    }
    let values: CFRetained<CFArray<CFType>> = unsafe { CFRetained::from_raw(NonNull::new_unchecked(values as *mut CFArray<CFType>)) };
    // An attribute the element doesn't have comes back as an AXValue holding the error.
    let at = |i: usize| values.get(i).filter(|value| value.downcast_ref::<AXValue>().is_none_or(|v| unsafe { v.r#type() } != AXValueType::AXError));
    let text = |i: usize| at(i).and_then(|value| text_value(&value));
    let flag = |i: usize| at(i).and_then(|value| value.downcast::<CFBoolean>().ok()).map(|value| value.as_bool());
    let point = at(10).and_then(|value| value.downcast::<AXValue>().ok()).and_then(|value| {
        let mut point = CGPoint { x: 0.0, y: 0.0 };
        unsafe { value.value(AXValueType::CGPoint, NonNull::from(&mut point).cast()) }.then_some(point)
    });
    let size = at(11).and_then(|value| value.downcast::<AXValue>().ok()).and_then(|value| {
        let mut size = CGSize { width: 0.0, height: 0.0 };
        unsafe { value.value(AXValueType::CGSize, NonNull::from(&mut size).cast()) }.then_some(size)
    });
    let children = at(12)
        .and_then(|value| value.downcast::<CFArray>().ok())
        .map(|array| {
            let array: CFRetained<CFArray<AXUIElement>> = unsafe { CFRetained::cast_unchecked(array) };
            (0..array.len()).filter_map(|i| array.get(i)).collect()
        })
        .unwrap_or_default();
    Some(Read {
        role: text(0),
        subrole: text(1),
        title: text(2),
        description: text(3),
        value: at(4),
        placeholder: text(5),
        help: text(6),
        enabled: flag(7),
        focused: flag(8),
        selected: flag(9),
        frame: point.zip(size).map(|(point, size)| (point.x, point.y, size.width, size.height)),
        children,
    })
}

fn text_value(value: &CFType) -> Option<String> {
    let text = value.downcast_ref::<CFString>()?.to_string();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

fn number_value(value: &CFType) -> Option<f64> {
    value.downcast_ref::<CFNumber>().and_then(|number| number.as_f64()).or_else(|| value.downcast_ref::<CFBoolean>().map(|flag| if flag.as_bool() { 1.0 } else { 0.0 }))
}

fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// One listed element, as the assistant reads it.
fn entry(id: usize, role: &str, label: Option<String>, node: &Read, depth: usize) -> Value {
    let mut entry = json!({ "id": id, "role": role, "depth": depth });
    if let Some(label) = label {
        entry["label"] = json!(clip(&label, 120));
    }
    // A password field's contents are never read.
    if role != "password" {
        if let Some(value) = node.value.as_deref() {
            if TEXT_INPUTS.contains(&role) {
                if let Some(text) = text_value(value) {
                    entry["value"] = json!(clip(&text, 200));
                }
            } else if ["checkbox", "switch", "radio"].contains(&role) {
                if let Some(number) = number_value(value) {
                    entry["checked"] = json!(number != 0.0);
                }
            } else if ["slider", "stepper"].contains(&role) {
                if let Some(number) = number_value(value) {
                    entry["value"] = json!(number);
                }
            }
        }
    }
    if let Some(placeholder) = &node.placeholder {
        entry["placeholder"] = json!(clip(placeholder, 80));
    }
    if node.enabled == Some(false) {
        entry["disabled"] = json!(true);
    }
    if node.focused == Some(true) {
        entry["focused"] = json!(true);
    }
    if node.selected == Some(true) {
        entry["selected"] = json!(true);
    }
    if let Some((x, y, w, h)) = node.frame {
        entry["frame"] = json!({ "x": x.round(), "y": y.round(), "w": w.round(), "h": h.round() });
    }
    entry
}

/// Notes the section a short-labelled control is in, unless its label says it already.
fn section(entry: &mut Value, context: &Option<String>) {
    let Some(context) = context else { return };
    let label = entry.get("label").and_then(Value::as_str).unwrap_or("").to_lowercase();
    if label.split_whitespace().count() <= 3 && !label.contains(&context.to_lowercase()) {
        entry["in"] = json!(clip(context, 60));
    }
}

struct Walked {
    elements: Vec<Value>,
    handles: Vec<CFRetained<AXUIElement>>,
    truncated: bool,
    /// A Chromium page whose tree isn't built yet: an empty web area.
    unbuilt: bool,
    /// A web area with something in it: a Chromium window's page, built.
    web_content: bool,
    visits: usize,
    /// With `debug`: (depth, role, children) for every element looked at.
    visited: Option<Vec<Value>>,
}

/// Whether an accessibility frame and a window-server frame are the same
/// window, allowing for a window just shown, which the server lists at 90%.
fn same_window(frame: Option<(f64, f64, f64, f64)>, bounds: (f64, f64, f64, f64)) -> bool {
    let Some((x, y, w, h)) = frame else { return false };
    let (bx, by, bw, bh) = bounds;
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh && (w - bw).abs() <= bw * 0.15 && (h - bh).abs() <= bh * 0.15
}

/// The app's window the user sees: its front-most one on screen. An app in
/// the background has no focused window, and its first one may be hidden.
/// The error says what was compared, for a window that can't be found.
fn visible_window(app: &AXUIElement, pid: i32) -> Result<CFRetained<AXUIElement>> {
    let windows: Vec<CFRetained<AXUIElement>> = attribute(app, "AXWindows")
        .and_then(|value| value.downcast::<CFArray>().ok())
        .map(|array| {
            let array: CFRetained<CFArray<AXUIElement>> = unsafe { CFRetained::cast_unchecked(array) };
            (0..array.len()).filter_map(|i| array.get(i)).collect()
        })
        .unwrap_or_default();
    // Its windows on screen, front to back, tooltips and popovers left out.
    let shown: Vec<(f64, f64, f64, f64)> = on_screen_windows()?
        .into_iter()
        .filter(|window| window.pid == pid && window.layer == 0 && substantial(window))
        .filter_map(|window| window.bounds)
        .collect();
    let focused = ["AXFocusedWindow", "AXMainWindow"].iter().find_map(|name| attribute(app, name)?.downcast::<AXUIElement>().ok());
    let frames: Vec<_> = windows
        .iter()
        .map(|window| (string_attribute(window, "AXRole"), string_attribute(window, "AXSubrole"), string_attribute(window, "AXTitle"), frame_rect(window)))
        .collect();
    let showing = |window: &CFRetained<AXUIElement>| shown.iter().any(|&bounds| same_window(frame_rect(window), bounds));
    // The focused window if it's on screen; else the front-most one that is;
    // else (nothing matches what's drawn, say mid-animation) the focused one
    // anyway, or whatever the app lists first.
    let found = focused
        .clone()
        .filter(|window| shown.is_empty() || showing(window))
        .or_else(|| shown.iter().find_map(|&bounds| windows.iter().find(|window| same_window(frame_rect(window), bounds)).cloned()))
        .or(focused)
        .or_else(|| windows.first().cloned());
    found.ok_or_else(|| format!("the app has no window to read (on screen: {shown:?}; its windows: {frames:?})"))
}

/// An element's identity (CFHash, as CFEqual compares them), to visit each once.
fn identity(element: &AXUIElement) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let cf: &CFType = element;
    cf.hash(&mut hasher);
    hasher.finish()
}

/// The window's elements in reading order, depth first.
fn walk(window: &CFRetained<AXUIElement>, names: &CFArray<CFString>, limit: usize, debug: bool) -> Walked {
    let mut walked = Walked {
        elements: Vec::new(),
        handles: Vec::new(),
        truncated: false,
        unbuilt: false,
        web_content: false,
        visits: 0,
        visited: debug.then(Vec::new),
    };
    let bounds = frame_rect(window);
    // (element, depth, the listed control it's inside, the named section it's in)
    let mut stack = vec![(window.clone(), 0usize, None::<usize>, None::<String>)];
    // Some apps' trees list an element under two parents; each is read once.
    let mut seen = HashSet::new();
    while let Some((element, depth, inside, context)) = stack.pop() {
        if walked.visits >= SNAPSHOT_VISITS || walked.elements.len() >= limit {
            walked.truncated = true;
            break;
        }
        if !seen.insert(identity(&element)) {
            continue;
        }
        walked.visits += 1;
        let Some(node) = read_all(&element, names) else { continue };
        // Scrolled out of view, or on a hidden tab: neither it nor what's in it.
        if let (Some((x, y, w, h)), Some((bx, by, bw, bh))) = (node.frame, bounds) {
            if w > 0.0 && h > 0.0 && (x + w < bx || y + h < by || x > bx + bw || y > by + bh) {
                continue;
            }
        }
        let role = node.role.as_deref().unwrap_or("");
        if let Some(visited) = walked.visited.as_mut() {
            visited.push(json!([depth, role, node.children.len()]));
        }
        if role == "AXWebArea" {
            if node.children.is_empty() {
                walked.unbuilt = true;
            } else {
                walked.web_content = true;
            }
        }
        let mut owner = inside;
        let label = node.title.clone().or_else(|| node.description.clone());
        // A named container names the section for everything inside it.
        let inner = if CONTAINERS.contains(&role) && label.is_some() { label.clone() } else { context.clone() };
        if let Some(name) = role_name(role, node.subrole.as_deref()) {
            if name == "text" {
                let text = label.or_else(|| node.value.as_deref().and_then(text_value));
                match (text, inside) {
                    // Text inside a control is its name, if it has none of its own.
                    (Some(text), Some(index)) => {
                        if walked.elements[index].get("label").is_none() {
                            walked.elements[index]["label"] = json!(clip(&text, 120));
                        }
                    }
                    (Some(text), None) => {
                        walked.elements.push(entry(walked.elements.len(), name, Some(text), &node, depth));
                        walked.handles.push(element.clone());
                    }
                    (None, _) => {}
                }
            } else {
                if NAMED_BY_CONTENT.contains(&name) {
                    owner = Some(walked.elements.len());
                }
                let mut listed = entry(walked.elements.len(), name, label.or_else(|| node.help.clone()), &node, depth);
                // A row is a section itself; anything else may sit in one.
                if role != "AXRow" {
                    section(&mut listed, &context);
                }
                walked.elements.push(listed);
                walked.handles.push(element.clone());
            }
        }
        // Reversed, so the stack hands them back in order.
        for child in node.children.into_iter().rev() {
            stack.push((child, depth + 1, owner, inner.clone()));
        }
    }
    walked
}

/// The controls in the front window (or `pid`'s), numbered for `act`.
pub fn snapshot(pid: Option<i32>, exclude: Option<i32>, limit: usize, debug: bool) -> Result<Value> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission has not been granted".into());
    }
    let started = Instant::now();
    let pid = match pid {
        Some(pid) => pid,
        None => on_screen_windows()?
            .into_iter()
            .find(|window| window.layer == 0 && substantial(window) && Some(window.pid) != exclude)
            .map(|window| window.pid)
            .ok_or("no ordinary window is on screen")?,
    };
    // Set on the system-wide element, this bounds every app's replies.
    unsafe { AXUIElement::new_system_wide().set_messaging_timeout(AX_TIMEOUT_S) };
    let (asked, _) = wake_tree(pid);
    let app = unsafe { AXUIElement::new_application(pid) };
    let window = visible_window(&app, pid)?;
    let names = CFArray::from_retained_objects(&SNAPSHOT_ATTRIBUTES.map(CFString::from_static_str));
    let chromium = chromium_based(pid);
    let mut walked = walk(&window, &names, limit, debug);
    // A Chromium app builds its tree a moment after first being asked: until
    // then its page is missing from the window, or an empty web area.
    while (walked.unbuilt || (chromium && !walked.web_content)) && asked.elapsed() < WAKE_TIME {
        std::thread::sleep(WAKE_POLL);
        walked = walk(&window, &names, limit, debug);
    }
    let number = LISTED.with(|listed| {
        let mut listed = listed.borrow_mut();
        listed.0 += 1;
        listed.1 = walked.handles;
        listed.0
    });
    Ok(json!({
        "snapshot": number,
        "app": app_info(pid),
        "window": { "title": string_attribute(&window, "AXTitle"), "frame": frame(&window) },
        "elements": walked.elements,
        "truncated": walked.truncated,
        "visits": walked.visits,
        "visited": walked.visited,
        "ms": started.elapsed().as_millis() as u64,
    }))
}

/// Does something to an element of the last snapshot.
pub fn act(snapshot: u64, id: usize, action: &str, value: Option<&str>) -> Result<Value> {
    let element = LISTED.with(|listed| {
        let listed = listed.borrow();
        if listed.0 != snapshot {
            return Err("the screen has been read again since; use the newest numbers".to_string());
        }
        listed.1.get(id).cloned().ok_or_else(|| format!("there is no element {id}"))
    })?;
    if is_secure(&element) && matches!(action, "focus" | "setValue") {
        return Err("Jester never types into password fields".into());
    }
    let perform = |name: &'static str| {
        let error = unsafe { element.perform_action(&CFString::from_static_str(name)) };
        if error == AXError::Success {
            Ok(())
        } else {
            Err(format!("{name} didn't work on it (AXError {})", error.0))
        }
    };
    let set = |name: &'static str, to: &CFType| {
        let error = unsafe { element.set_attribute_value(&CFString::from_static_str(name), to) };
        if error == AXError::Success {
            Ok(())
        } else {
            Err(format!("couldn't set {name} (AXError {})", error.0))
        }
    };
    match action {
        "press" => perform("AXPress"),
        "showMenu" => perform("AXShowMenu"),
        "increment" => perform("AXIncrement"),
        "decrement" => perform("AXDecrement"),
        "scrollTo" => perform("AXScrollToVisible"),
        "focus" => set("AXFocused", CFBoolean::new(true)),
        "setValue" => set("AXValue", &CFString::from_str(value.unwrap_or(""))),
        other => Err(format!("unknown action \"{other}\"")),
    }?;
    Ok(json!({ "element": describe(&element) }))
}

/// What has the keyboard focus, and whether it's a password field.
pub fn focused() -> Result<Value> {
    let system = unsafe { AXUIElement::new_system_wide() };
    let element = attribute(&system, "AXFocusedUIElement")
        .and_then(|value| value.downcast::<AXUIElement>().ok())
        .ok_or("nothing has the keyboard focus")?;
    Ok(json!({ "element": describe(&element), "app": pid(&element).map(app_info) }))
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

extern "C" {
    /// libproc: every process id into `buffer`; returns how many.
    fn proc_listallpids(buffer: *mut std::ffi::c_void, buffer_size: std::ffi::c_int) -> std::ffi::c_int;
}

fn running(pid: i32) -> Result<Retained<NSRunningApplication>> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| format!("no app is running as process {pid}"))
}

/// The apps in the Dock, looked up one process at a time: AppKit's own list
/// only updates while a main run loop turns, and this process doesn't run one.
pub fn apps() -> Result<Value> {
    let mut pids = vec![0i32; 8192];
    let size = (pids.len() * std::mem::size_of::<i32>()) as std::ffi::c_int;
    let count = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), size) };
    if count <= 0 {
        return Err("could not list processes".into());
    }
    pids.truncate(count as usize);
    let mut apps = Vec::new();
    for pid in pids {
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else { continue };
        if app.activationPolicy() != NSApplicationActivationPolicy::Regular || app.isTerminated() {
            continue;
        }
        apps.push(json!({
            "pid": pid,
            "name": app.localizedName().map(|name| name.to_string()),
            "bundleId": app.bundleIdentifier().map(|id| id.to_string()),
            "path": app.bundleURL().and_then(|url| url.path()).map(|path| path.to_string()),
            "active": app.isActive(),
            "hidden": app.isHidden(),
        }));
    }
    Ok(Value::Array(apps))
}

pub fn quit_app(pid: i32) -> Result<()> {
    if running(pid)?.terminate() {
        Ok(())
    } else {
        Err("the app didn't take the request to quit".into())
    }
}

pub fn hide_app(pid: i32) -> Result<()> {
    if running(pid)?.hide() {
        Ok(())
    } else {
        Err("the app can't be hidden".into())
    }
}

/// Since macOS 14 an app can't simply take the front for another; the app
/// asks LaunchServices instead (`open -a`), which always may.
pub fn activate_app(_pid: i32) -> Result<()> {
    Err("on macOS, apps are brought forward with open -a".into())
}

/// Whether an element's frame holds the point: an answer that doesn't is about
/// something else (an app's menu bar, given for a point it doesn't own).
fn frame_contains(element: &AXUIElement, x: f64, y: f64) -> bool {
    frame_rect(element).is_some_and(|(fx, fy, fw, fh)| x >= fx - 2.0 && y >= fy - 2.0 && x <= fx + fw + 2.0 && y <= fy + fh + 2.0)
}

fn with_timeout(element: CFRetained<AXUIElement>) -> CFRetained<AXUIElement> {
    unsafe { element.set_messaging_timeout(AX_TIMEOUT_S) };
    element
}

/// Jester's overlay page's title (src/overlay/overlay.html): its windows lie
/// over every display and are never what is meant.
const JESTER_OVERLAY: &str = "Jester overlay";

/// An answer worth keeping: its frame holds the point, and it isn't Jester's overlay.
fn real_target(element: &AXUIElement, x: f64, y: f64) -> bool {
    frame_contains(element, x, y) && window_title(element).as_deref() != Some(JESTER_OVERLAY)
}

/// One line of `trace`: what an answer was, and why it was or wasn't kept.
fn trace_entry(source: Value, answer: &std::result::Result<CFRetained<AXUIElement>, String>, kept: bool) -> Value {
    match answer {
        Ok(element) => json!({ "asked": source, "role": string_attribute(element, "AXRole"), "window": window_title(element), "frame": frame(element), "kept": kept }),
        Err(error) => json!({ "asked": source, "error": error }),
    }
}

/// What is under a point, as macOS answers it, checked: an answer whose
/// frame doesn't hold the point (another app's menu bar) or that is Jester's
/// own overlay is no answer. Jester hides its overlay while it asks, as an
/// Electron window over everything makes macOS's answer fail outright; other
/// apps' click-through overlays don't. `trace` records what came back.
fn element_under(x: f64, y: f64, trace: &mut Option<Vec<Value>>) -> Result<CFRetained<AXUIElement>> {
    let system = with_timeout(unsafe { AXUIElement::new_system_wide() });
    let answer = hit(&system, x, y);
    let kept = answer.as_ref().is_ok_and(|element| real_target(element, x, y));
    if let Some(trace) = trace {
        trace.push(trace_entry(json!("system"), &answer, kept));
    }
    match answer {
        Ok(element) if kept => Ok(element),
        Ok(_) => Err(format!("nothing to aim at under {x},{y}")),
        Err(error) => Err(error),
    }
}
