//! macOS: Core Graphics events for input, the Accessibility API for what is on
//! screen, AppKit for media keys.
//!
//! Posting events needs the app to be allowed under System Settings › Privacy
//! & Security › Accessibility; so does reading other apps' elements. Without
//! it, CGEventPost drops events silently, so `permissions()` is checked first.

use crate::protocol::{Button, MediaKey, Modifier, ScrollUnit};
use crate::{Poster, Result};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSRunningApplication};
use objc2_application_services::{AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType};
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
/// apps answer to AXManualAccessibility, Chrome-family browsers to
/// AXEnhancedUserInterface — which is kept to them, as it makes some other
/// apps animate their windows differently. Returns when the app was first
/// asked, and whether that is now.
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
    if app_info(pid)["bundleId"].as_str().is_some_and(|id| CHROMIUM_BROWSERS.contains(&id)) {
        unsafe { app.set_attribute_value(&CFString::from_static_str("AXEnhancedUserInterface"), yes) };
    }
    (Instant::now(), true)
}

fn hit(system: &AXUIElement, x: f64, y: f64) -> Result<CFRetained<AXUIElement>> {
    let mut found: *const AXUIElement = std::ptr::null();
    let error = unsafe { system.copy_element_at_position(x as f32, y as f32, NonNull::from(&mut found)) };
    if error != AXError::Success || found.is_null() {
        return Err(format!("nothing readable at {x},{y} (AXError {})", error.0));
    }
    Ok(unsafe { CFRetained::from_raw(NonNull::new_unchecked(found as *mut AXUIElement)) })
}

pub fn element_at(x: f64, y: f64) -> Result<Value> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission has not been granted".into());
    }
    let system = unsafe { AXUIElement::new_system_wide() };
    unsafe { system.set_messaging_timeout(AX_TIMEOUT_S) };
    let mut element = hit(&system, x, y)?;
    let mut polls = None;
    if let Some(pid) = pid(&element) {
        // Woken just now, or by `wake` a moment ago: either way, give the
        // tree until WAKE_TIME after the ask to appear.
        let (asked, _) = wake_tree(pid);
        let mut count = 0;
        while asleep(&element) && asked.elapsed() < WAKE_TIME {
            std::thread::sleep(WAKE_POLL);
            element = hit(&system, x, y)?;
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
        // Set on an app's first query: how many 100 ms looks its tree took to appear.
        "wakePolls": polls,
    }))
}

/// The front window, from the window server: no permission needed for the
/// owner and bounds (titles need Screen Recording, and are omitted without it).
pub fn frontmost() -> Result<Value> {
    let list = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0)
        .ok_or("the window server returned no windows")?;
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> = unsafe { CFRetained::cast_unchecked(list) };
    let number = |dict: &CFDictionary<CFString, CFType>, key: &CFString| dict.get(key)?.downcast::<CFNumber>().ok()?.as_f64();
    let text = |dict: &CFDictionary<CFString, CFType>, key: &CFString| dict.get(key)?.downcast::<CFString>().ok().map(|s| s.to_string());
    for window in list.iter() {
        let (layer_key, pid_key, owner_key, name_key, bounds_key) = unsafe {
            use objc2_core_graphics::{kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowOwnerName, kCGWindowOwnerPID};
            (kCGWindowLayer, kCGWindowOwnerPID, kCGWindowOwnerName, kCGWindowName, kCGWindowBounds)
        };
        // Layer 0 is ordinary app windows; menus, the Dock and overlays sit above it.
        if number(&window, layer_key) != Some(0.0) {
            continue;
        }
        let Some(pid) = number(&window, pid_key) else { continue };
        let bounds = window.get(bounds_key).and_then(|value| value.downcast::<CFDictionary>().ok()).map(|bounds| {
            let bounds: CFRetained<CFDictionary<CFString, CFType>> = unsafe { CFRetained::cast_unchecked(bounds) };
            let field = |name: &'static str| number(&bounds, &CFString::from_static_str(name));
            json!({ "x": field("X"), "y": field("Y"), "w": field("Width"), "h": field("Height") })
        });
        let mut app = app_info(pid as i32);
        if app["name"].is_null() {
            app["name"] = json!(text(&window, owner_key));
        }
        return Ok(json!({ "app": app, "window": { "title": text(&window, name_key), "bounds": bounds } }));
    }
    Err("no ordinary window is on screen".into())
}
