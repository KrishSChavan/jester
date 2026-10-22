//! Windows: SendInput for input, UI Automation for what is on screen.
//!
//! No permission prompt exists on Windows, but one wall does: input sent to a
//! window of an elevated (administrator) process is dropped unless Jester runs
//! elevated too. `frontmost()` reports `elevated` so the app can say so.
//!
//! The process is per-monitor DPI aware, so every coordinate here is a
//! physical pixel on the virtual desktop.

use crate::protocol::{Button, MediaKey, Modifier, ScrollUnit};
use crate::{Poster, Result};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::mem::size_of;
use windows::core::{Interface, BOOL, BSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow, SwitchToThisWindow,
    GWL_EXSTYLE, GW_OWNER, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_MINIMIZE, SW_RESTORE, WM_CLOSE,
    WS_EX_TOOLWINDOW,
};

/// One wheel notch.
const WHEEL_DELTA: f64 = 120.0;
/// Windows has no pixel scrolling; this many pixels make one notch.
const PIXELS_PER_NOTCH: f64 = 40.0;

fn process_elevated(process: HANDLE) -> Option<bool> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0u32;
    let read = unsafe {
        GetTokenInformation(token, TokenElevation, Some(&mut elevation as *mut _ as *mut _), size_of::<TOKEN_ELEVATION>() as u32, &mut size)
    };
    let _ = unsafe { CloseHandle(token) };
    read.ok().map(|_| elevation.TokenIsElevated != 0)
}

pub fn permissions(_prompt: bool) -> Value {
    json!({
        "accessibility": true,
        "postEvents": true,
        "screenCapture": true,
        "elevated": process_elevated(unsafe { GetCurrentProcess() }),
    })
}

pub fn init_query_thread() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

fn send(inputs: &[INPUT]) -> Result<()> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows refused the input (another app may be elevated, or the desktop is locked)".into())
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn modifier_vk(modifier: Modifier) -> Option<u16> {
    match modifier {
        Modifier::Meta => Some(VK_LWIN.0),
        Modifier::Control => Some(VK_CONTROL.0),
        Modifier::Alt => Some(VK_MENU.0),
        Modifier::Shift => Some(VK_SHIFT.0),
        // The laptop Fn key never reaches Windows.
        Modifier::Fn => None,
    }
}

fn vk(key: &str) -> Option<u16> {
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        if c.is_ascii_lowercase() {
            return Some(c.to_ascii_uppercase() as u16);
        }
        if c.is_ascii_digit() {
            return Some(c as u16);
        }
    }
    if let Some(n) = key.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(VK_F1.0 + n - 1);
    }
    let code = match key {
        "enter" => VK_RETURN,
        "escape" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "backspace" => VK_BACK,
        "delete" => VK_DELETE,
        "insert" => VK_INSERT,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "minus" => VK_OEM_MINUS,
        "equal" => VK_OEM_PLUS,
        "comma" => VK_OEM_COMMA,
        "period" => VK_OEM_PERIOD,
        "slash" => VK_OEM_2,
        "grave" => VK_OEM_3,
        "leftbracket" => VK_OEM_4,
        "backslash" => VK_OEM_5,
        "rightbracket" => VK_OEM_6,
        "quote" => VK_OEM_7,
        "semicolon" => VK_OEM_1,
        _ => return None,
    };
    Some(code.0)
}

/// Keys that live on the extended block; without the flag, Windows reads
/// the arrows as the number pad's.
fn extended(vk: u16) -> bool {
    [
        VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_INSERT, VK_DELETE, VK_LWIN, VK_RWIN,
        VK_RCONTROL, VK_RMENU, VK_VOLUME_MUTE, VK_VOLUME_DOWN, VK_VOLUME_UP, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PREV_TRACK,
        VK_MEDIA_PLAY_PAUSE,
    ]
    .iter()
    .any(|key| key.0 == vk)
}

fn key_input(vk: u16, down: bool) -> INPUT {
    let mut flags = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    if extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    keyboard(vk, 0, flags)
}

pub struct Input {
    held: Vec<Button>,
}

impl Input {
    pub fn new() -> Self {
        // Physical pixels everywhere, whatever each monitor's scaling.
        let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        Input { held: Vec::new() }
    }

    pub fn cursor(&self) -> Result<(f64, f64)> {
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point) }.map_err(|err| err.to_string())?;
        Ok((point.x as f64, point.y as f64))
    }

    pub fn move_to(&mut self, poster: &mut Poster, x: f64, y: f64) -> Result<()> {
        poster.record(json!({ "event": if self.held.is_empty() { "move" } else { "drag" }, "x": x, "y": y }));
        if poster.dry_run {
            return Ok(());
        }
        // Absolute moves are in 0..65535 across the whole virtual desktop.
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
                GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2) as f64,
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2) as f64,
            )
        };
        let nx = (((x - left) * 65535.0) / (width - 1.0)).round() as i32;
        let ny = (((y - top) * 65535.0) / (height - 1.0)).round() as i32;
        send(&[mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)])
    }

    /// Windows decides what is a double-click from timing and distance, so
    /// `count` only matters to the dry-run log.
    pub fn button(&mut self, poster: &mut Poster, button: Button, down: bool, at: (f64, f64), count: u32) -> Result<()> {
        let name = match button {
            Button::Left => "left",
            Button::Right => "right",
            Button::Middle => "middle",
        };
        poster.record(json!({ "event": if down { "down" } else { "up" }, "button": name, "x": at.0, "y": at.1, "count": count }));
        if down {
            self.held.push(button);
        } else {
            self.held.retain(|held| *held != button);
        }
        if poster.dry_run {
            return Ok(());
        }
        let flags = match (button, down) {
            (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (Button::Left, false) => MOUSEEVENTF_LEFTUP,
            (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
            (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        send(&[mouse(flags, 0, 0, 0)])
    }

    /// Nothing to tune here yet: SendInput has one way in.
    pub fn configure(&mut self, _tap: Option<&str>, _source: Option<&str>, _delay_ms: Option<u64>) -> Result<Value> {
        Ok(json!({ "keyTap": "sendinput" }))
    }

    /// The wheel acts at the cursor, which `move_to` has already put at `at`.
    pub fn scroll(&mut self, poster: &mut Poster, dx: f64, dy: f64, unit: ScrollUnit, at: (f64, f64)) -> Result<()> {
        poster.record(json!({ "event": "scroll", "dx": dx, "dy": dy, "unit": if unit == ScrollUnit::Line { "line" } else { "pixel" }, "x": at.0, "y": at.1 }));
        if poster.dry_run {
            return Ok(());
        }
        // A notch is three lines by default.
        let notches = |amount: f64| if unit == ScrollUnit::Line { amount / 3.0 } else { amount / PIXELS_PER_NOTCH };
        let mut inputs = Vec::new();
        if dy != 0.0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, (notches(dy) * WHEEL_DELTA).round() as i32));
        }
        if dx != 0.0 {
            // Windows' horizontal wheel runs the other way: positive is right.
            inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, (-notches(dx) * WHEEL_DELTA).round() as i32));
        }
        if inputs.is_empty() {
            Ok(())
        } else {
            send(&inputs)
        }
    }

    pub fn modifier(&mut self, poster: &mut Poster, modifier: Modifier, down: bool, _held: &[Modifier]) -> Result<()> {
        poster.record(json!({ "event": if down { "keydown" } else { "keyup" }, "key": format!("{modifier:?}").to_lowercase() }));
        let Some(code) = modifier_vk(modifier) else { return Ok(()) };
        if poster.dry_run {
            return Ok(());
        }
        send(&[key_input(code, down)])
    }

    pub fn key(&mut self, poster: &mut Poster, key: &str, down: bool, _mods: &[Modifier]) -> Result<()> {
        let code = vk(key).ok_or_else(|| format!("unknown key \"{key}\""))?;
        poster.record(json!({ "event": if down { "keydown" } else { "keyup" }, "key": key }));
        if poster.dry_run {
            return Ok(());
        }
        send(&[key_input(code, down)])
    }

    /// Any text: each UTF-16 unit is sent as itself, whatever the keyboard
    /// layout. Line breaks and tabs are real key presses.
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
                if part.is_empty() {
                    continue;
                }
                poster.record(json!({ "event": "text", "text": part }));
                if poster.dry_run {
                    continue;
                }
                let inputs: Vec<INPUT> = part
                    .encode_utf16()
                    .flat_map(|unit| [keyboard(0, unit, KEYEVENTF_UNICODE), keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
                    .collect();
                send(&inputs)?;
            }
        }
        Ok(())
    }

    pub fn media(&mut self, poster: &mut Poster, key: MediaKey) -> Result<()> {
        let code = match key {
            MediaKey::Play => VK_MEDIA_PLAY_PAUSE,
            MediaKey::Next => VK_MEDIA_NEXT_TRACK,
            MediaKey::Previous => VK_MEDIA_PREV_TRACK,
            MediaKey::VolumeUp => VK_VOLUME_UP,
            MediaKey::VolumeDown => VK_VOLUME_DOWN,
            MediaKey::Mute => VK_VOLUME_MUTE,
            MediaKey::BrightnessUp | MediaKey::BrightnessDown => return Err("brightness keys don't exist on Windows; use the display API".into()),
        };
        poster.record(json!({ "event": "media", "key": format!("{key:?}") }));
        if poster.dry_run {
            return Ok(());
        }
        send(&[key_input(code.0, true), key_input(code.0, false)])
    }
}

// ---------------------------------------------------------------------------
// UI Automation
// ---------------------------------------------------------------------------

thread_local! {
    static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

fn automation() -> Result<IUIAutomation> {
    AUTOMATION.with(|cell| {
        if let Some(existing) = cell.borrow().as_ref() {
            return Ok(existing.clone());
        }
        let created: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|err| err.to_string())?;
        *cell.borrow_mut() = Some(created.clone());
        Ok(created)
    })
}

fn supports(element: &IUIAutomationElement, pattern: UIA_PATTERN_ID) -> bool {
    unsafe { element.GetCurrentPattern(pattern) }.is_ok_and(|found| !found.as_raw().is_null())
}

fn actions(element: &IUIAutomationElement) -> Vec<&'static str> {
    [
        (UIA_InvokePatternId, "invoke"),
        (UIA_TogglePatternId, "toggle"),
        (UIA_SelectionItemPatternId, "select"),
        (UIA_ExpandCollapsePatternId, "expand"),
        (UIA_ValuePatternId, "setValue"),
    ]
    .into_iter()
    .filter(|(pattern, _)| supports(element, *pattern))
    .map(|(_, name)| name)
    .collect()
}

fn describe(element: &IUIAutomationElement) -> Value {
    let rect: RECT = unsafe { element.CurrentBoundingRectangle() }.unwrap_or_default();
    let password = unsafe { element.CurrentIsPassword() }.map(|value| value.as_bool()).unwrap_or(false);
    json!({
        "role": unsafe { element.CurrentLocalizedControlType() }.ok().map(|name| name.to_string()),
        "controlType": unsafe { element.CurrentControlType() }.ok().map(|id| id.0),
        "title": unsafe { element.CurrentName() }.ok().map(|name| name.to_string()).filter(|name| !name.is_empty()),
        "className": unsafe { element.CurrentClassName() }.ok().map(|name| name.to_string()),
        "enabled": unsafe { element.CurrentIsEnabled() }.ok().map(|value| value.as_bool()),
        "secure": password,
        "frame": { "x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top },
        "actions": actions(element),
    })
}

const PRESSABLE_TYPES: &[UIA_CONTROLTYPE_ID] = &[
    UIA_ButtonControlTypeId, UIA_HyperlinkControlTypeId, UIA_MenuItemControlTypeId, UIA_CheckBoxControlTypeId,
    UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId, UIA_ListItemControlTypeId, UIA_SplitButtonControlTypeId,
    UIA_TreeItemControlTypeId, UIA_ComboBoxControlTypeId,
];

fn pressable(element: &IUIAutomationElement) -> bool {
    supports(element, UIA_InvokePatternId)
        || unsafe { element.CurrentControlType() }.is_ok_and(|kind| PRESSABLE_TYPES.contains(&kind))
}

fn exe_name(pid: u32) -> (Option<String>, Option<bool>) {
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return (None, None) };
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let path = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size) }
        .ok()
        .map(|_| String::from_utf16_lossy(&buffer[..size as usize]));
    // Reading an elevated process's token from an unelevated one fails: that
    // failure is itself the answer.
    let elevated = process_elevated(process).or(Some(true));
    let _ = unsafe { CloseHandle(process) };
    (path, elevated)
}

/// `wait` is for macOS's Chromium trees; UI Automation has nothing to wait for.
pub fn element_at(x: f64, y: f64, _wait: bool, _debug: bool) -> Result<Value> {
    let automation = automation()?;
    let element = unsafe { automation.ElementFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 }) }.map_err(|err| err.to_string())?;
    let walker = unsafe { automation.ControlViewWalker() }.map_err(|err| err.to_string())?;
    let mut actionable = None;
    let mut current = Some(element.clone());
    for _ in 0..10 {
        let Some(node) = current else { break };
        if pressable(&node) {
            actionable = Some(describe(&node));
            break;
        }
        current = unsafe { walker.GetParentElement(&node) }.ok();
    }
    let pid = unsafe { element.CurrentProcessId() }.unwrap_or(0) as u32;
    let (exe, elevated) = exe_name(pid);
    Ok(json!({
        "element": describe(&element),
        "actionable": actionable,
        "app": { "pid": pid, "exe": exe, "elevated": elevated },
    }))
}

/// Chromium on Windows builds its UI Automation tree when a client first asks;
/// nothing to do ahead of time yet.
pub fn wake(_pid: i32) -> Result<Value> {
    Ok(json!({ "woken": false }))
}

/// The windows Alt-Tab offers, with their process ids: visible, titled,
/// unowned, and not tool windows.
fn app_windows() -> Vec<(HWND, u32)> {
    unsafe extern "system" fn each(window: HWND, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<(HWND, u32)>) };
        let owned = unsafe { GetWindow(window, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid());
        let tool = unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 != 0;
        if unsafe { IsWindowVisible(window) }.as_bool() && !owned && !tool && unsafe { GetWindowTextLengthW(window) } > 0 {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
            list.push((window, pid));
        }
        BOOL(1)
    }
    let mut list: Vec<(HWND, u32)> = Vec::new();
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize)) };
    list
}

fn windows_of(pid: i32) -> Result<Vec<HWND>> {
    let windows: Vec<HWND> = app_windows().into_iter().filter(|(_, owner)| *owner as i32 == pid).map(|(window, _)| window).collect();
    if windows.is_empty() {
        Err(format!("process {pid} has no windows"))
    } else {
        Ok(windows)
    }
}

/// The apps with a window on the taskbar, named after their program files.
pub fn apps() -> Result<Value> {
    let mut front = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut front)) };
    let mut apps: Vec<Value> = Vec::new();
    for (window, pid) in app_windows() {
        if apps.iter().any(|app| app["pid"] == pid) {
            continue;
        }
        let (exe, _) = exe_name(pid);
        let name = exe.as_deref().and_then(|path| path.rsplit('\\').next()).map(|file| file.trim_end_matches(".exe").to_string());
        apps.push(json!({ "pid": pid, "name": name, "path": exe, "active": pid == front, "hidden": unsafe { IsIconic(window) }.as_bool() }));
    }
    Ok(Value::Array(apps))
}

/// Closes each of the app's windows, as their close buttons would.
pub fn quit_app(pid: i32) -> Result<()> {
    for window in windows_of(pid)? {
        unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn hide_app(pid: i32) -> Result<()> {
    for window in windows_of(pid)? {
        let _ = unsafe { ShowWindow(window, SW_MINIMIZE) };
    }
    Ok(())
}

pub fn activate_app(pid: i32) -> Result<()> {
    let window = windows_of(pid)?[0];
    if unsafe { IsIconic(window) }.as_bool() {
        let _ = unsafe { ShowWindow(window, SW_RESTORE) };
    }
    // Windows lets only the app in front hand over the front; when it won't,
    // switch as Alt-Tab does.
    if !unsafe { SetForegroundWindow(window) }.as_bool() {
        unsafe { SwitchToThisWindow(window, true) };
    }
    Ok(())
}

pub fn frontmost() -> Result<Value> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Err("no window is in front".into());
    }
    let mut title = [0u16; 512];
    let length = unsafe { GetWindowTextW(window, &mut title) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    let mut rect = RECT::default();
    let bounds = unsafe { GetWindowRect(window, &mut rect) }
        .ok()
        .map(|_| json!({ "x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top }));
    let (exe, elevated) = exe_name(pid);
    let name = exe.as_deref().and_then(|path| path.rsplit('\\').next()).map(|file| file.trim_end_matches(".exe").to_string());
    Ok(json!({
        "app": { "pid": pid, "name": name, "exe": exe, "elevated": elevated },
        "window": { "title": String::from_utf16_lossy(&title[..length.max(0) as usize]), "bounds": bounds },
    }))
}

// ---------------------------------------------------------------------------
// Snapshots: the front window's controls, read for the assistant and acted on
// by number (as in mac.rs, through UI Automation)
// ---------------------------------------------------------------------------

/// How many elements a snapshot looks at, at most.
const SNAPSHOT_VISITS: usize = 3000;

thread_local! {
    /// The last snapshot's number, and its elements by their numbers in it.
    static LISTED: RefCell<(u64, Vec<IUIAutomationElement>)> = const { RefCell::new((0, Vec::new())) };
}

/// A control type in the words both platforms share; None for what a snapshot leaves out.
// The constants are Windows' own names.
#[allow(non_upper_case_globals)]
fn role_name(kind: UIA_CONTROLTYPE_ID, password: bool) -> Option<&'static str> {
    Some(match kind {
        UIA_EditControlTypeId if password => "password",
        UIA_EditControlTypeId => "textfield",
        UIA_DocumentControlTypeId => "textarea",
        UIA_ComboBoxControlTypeId => "combobox",
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => "button",
        UIA_HyperlinkControlTypeId => "link",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_RadioButtonControlTypeId => "radio",
        UIA_TabItemControlTypeId => "tab",
        UIA_MenuItemControlTypeId => "menuitem",
        UIA_SliderControlTypeId => "slider",
        UIA_SpinnerControlTypeId => "stepper",
        UIA_ListItemControlTypeId | UIA_TreeItemControlTypeId | UIA_DataItemControlTypeId => "row",
        UIA_HeaderItemControlTypeId => "heading",
        UIA_TextControlTypeId => "text",
        _ => return None,
    })
}

/// Controls named by what's written inside them: that text isn't listed again.
const NAMED_BY_CONTENT: &[&str] = &["button", "link", "checkbox", "radio", "tab", "menuitem", "heading"];
const TEXT_INPUTS: &[&str] = &["textfield", "textarea", "combobox"];
/// Containers whose name tells the controls inside apart: a result's "Play" from the player's.
const CONTAINERS: &[UIA_CONTROLTYPE_ID] = &[
    UIA_GroupControlTypeId, UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_DataGridControlTypeId, UIA_DataItemControlTypeId,
    UIA_TableControlTypeId, UIA_TreeItemControlTypeId, UIA_ToolBarControlTypeId, UIA_PaneControlTypeId, UIA_CustomControlTypeId,
];

/// Notes the section a short-labelled control is in, unless its label says it already.
fn section(entry: &mut Value, context: &Option<String>) {
    let Some(context) = context else { return };
    let label = entry.get("label").and_then(Value::as_str).unwrap_or("").to_lowercase();
    if label.split_whitespace().count() <= 3 && !label.contains(&context.to_lowercase()) {
        entry["in"] = json!(clip(context, 60));
    }
}

fn pattern<T: Interface>(element: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    unsafe { element.GetCurrentPatternAs::<T>(id) }.ok()
}

fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// One listed element, as the assistant reads it.
fn entry(id: usize, role: &str, label: Option<String>, element: &IUIAutomationElement, depth: usize) -> Value {
    let mut entry = json!({ "id": id, "role": role, "depth": depth });
    if let Some(label) = label {
        entry["label"] = json!(clip(&label, 120));
    }
    // A password field's contents are never read.
    if role != "password" {
        if TEXT_INPUTS.contains(&role) {
            let value = pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId)
                .and_then(|found| unsafe { found.CurrentValue() }.ok())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty());
            if let Some(value) = value {
                entry["value"] = json!(clip(&value, 200));
            }
        } else if role == "checkbox" {
            if let Some(state) = pattern::<IUIAutomationTogglePattern>(element, UIA_TogglePatternId).and_then(|found| unsafe { found.CurrentToggleState() }.ok()) {
                entry["checked"] = json!(state == ToggleState_On);
            }
        }
    }
    if unsafe { element.CurrentIsEnabled() }.is_ok_and(|enabled| !enabled.as_bool()) {
        entry["disabled"] = json!(true);
    }
    if unsafe { element.CurrentHasKeyboardFocus() }.is_ok_and(|focused| focused.as_bool()) {
        entry["focused"] = json!(true);
    }
    let selected = pattern::<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId)
        .and_then(|found| unsafe { found.CurrentIsSelected() }.ok())
        .is_some_and(|selected| selected.as_bool());
    if selected {
        entry["selected"] = json!(true);
    }
    if let Ok(rect) = unsafe { element.CurrentBoundingRectangle() } {
        entry["frame"] = json!({ "x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top });
    }
    entry
}

/// The controls in the front window, numbered for `act`. (`pid` is for macOS,
/// where an app's windows can be read without it being in front.)
pub fn snapshot(_pid: Option<i32>, exclude: Option<i32>, limit: usize, _debug: bool) -> Result<Value> {
    let started = std::time::Instant::now();
    let automation = automation()?;
    let mut window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Err("no window is in front".into());
    }
    // Past an excluded app's windows (Jester's own) to the next one down, as Alt-Tab orders them.
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
    if exclude.is_some_and(|pid| pid == owner as i32) {
        window = app_windows().into_iter().find(|(_, pid)| Some(*pid as i32) != exclude).map(|(found, _)| found).ok_or("no other window is on screen")?;
    }
    let root = unsafe { automation.ElementFromHandle(window) }.map_err(|err| err.to_string())?;
    let walker = unsafe { automation.ControlViewWalker() }.map_err(|err| err.to_string())?;
    let mut elements: Vec<Value> = Vec::new();
    let mut handles = Vec::new();
    let mut truncated = false;
    // (element, depth, the listed control it's inside, the named section it's in)
    let mut stack = vec![(root, 0usize, None::<usize>, None::<String>)];
    let mut visits = 0;
    while let Some((element, depth, inside, context)) = stack.pop() {
        if visits >= SNAPSHOT_VISITS || elements.len() >= limit {
            truncated = true;
            break;
        }
        visits += 1;
        // Scrolled out of view, or on a hidden tab: neither it nor what's in it.
        if depth > 0 && unsafe { element.CurrentIsOffscreen() }.is_ok_and(|offscreen| offscreen.as_bool()) {
            continue;
        }
        let kind = unsafe { element.CurrentControlType() }.unwrap_or_default();
        let password = unsafe { element.CurrentIsPassword() }.is_ok_and(|password| password.as_bool());
        let name = unsafe { element.CurrentName() }
            .ok()
            .map(|name| name.to_string().split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|name| !name.is_empty());
        let mut owner = inside;
        // A named container names the section for everything inside it.
        let inner = if CONTAINERS.contains(&kind) && name.is_some() { name.clone() } else { context.clone() };
        if let Some(role) = role_name(kind, password) {
            if role == "text" {
                match (name, inside) {
                    // Text inside a control is its name, if it has none of its own.
                    (Some(text), Some(index)) => {
                        if elements[index].get("label").is_none() {
                            elements[index]["label"] = json!(clip(&text, 120));
                        }
                    }
                    (Some(text), None) => {
                        elements.push(entry(elements.len(), role, Some(text), &element, depth));
                        handles.push(element.clone());
                    }
                    (None, _) => {}
                }
            } else {
                if NAMED_BY_CONTENT.contains(&role) {
                    owner = Some(elements.len());
                }
                let mut listed = entry(elements.len(), role, name, &element, depth);
                // A row is a section itself; anything else may sit in one.
                if role != "row" {
                    section(&mut listed, &context);
                }
                elements.push(listed);
                handles.push(element.clone());
            }
        }
        let mut children = Vec::new();
        let mut child = unsafe { walker.GetFirstChildElement(&element) }.ok();
        while let Some(current) = child {
            child = unsafe { walker.GetNextSiblingElement(&current) }.ok();
            children.push(current);
        }
        // Reversed, so the stack hands them back in order.
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1, owner, inner.clone()));
        }
    }
    let number = LISTED.with(|listed| {
        let mut listed = listed.borrow_mut();
        listed.0 += 1;
        listed.1 = handles;
        listed.0
    });
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    let (exe, elevated) = exe_name(pid);
    let name = exe.as_deref().and_then(|path| path.rsplit('\\').next()).map(|file| file.trim_end_matches(".exe").to_string());
    let mut title = [0u16; 512];
    let length = unsafe { GetWindowTextW(window, &mut title) };
    let mut rect = RECT::default();
    let frame = unsafe { GetWindowRect(window, &mut rect) }
        .ok()
        .map(|_| json!({ "x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top }));
    Ok(json!({
        "snapshot": number,
        "app": { "pid": pid, "name": name, "exe": exe, "elevated": elevated },
        "window": { "title": String::from_utf16_lossy(&title[..length.max(0) as usize]), "frame": frame },
        "elements": elements,
        "truncated": truncated,
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
    let password = unsafe { element.CurrentIsPassword() }.is_ok_and(|password| password.as_bool());
    if password && matches!(action, "focus" | "setValue") {
        return Err("Jester never types into password fields".into());
    }
    let done = |result: windows::core::Result<()>| result.map_err(|err| format!("{action} didn't work on it ({err})"));
    match action {
        "press" => {
            if let Some(found) = pattern::<IUIAutomationInvokePattern>(&element, UIA_InvokePatternId) {
                done(unsafe { found.Invoke() })?
            } else if let Some(found) = pattern::<IUIAutomationTogglePattern>(&element, UIA_TogglePatternId) {
                done(unsafe { found.Toggle() })?
            } else if let Some(found) = pattern::<IUIAutomationSelectionItemPattern>(&element, UIA_SelectionItemPatternId) {
                done(unsafe { found.Select() })?
            } else if let Some(found) = pattern::<IUIAutomationExpandCollapsePattern>(&element, UIA_ExpandCollapsePatternId) {
                done(unsafe { found.Expand() })?
            } else {
                return Err("it can't be pressed this way; click it instead".into());
            }
        }
        "focus" => done(unsafe { element.SetFocus() })?,
        "setValue" => {
            let found = pattern::<IUIAutomationValuePattern>(&element, UIA_ValuePatternId).ok_or("it doesn't take text")?;
            done(unsafe { found.SetValue(&BSTR::from(value.unwrap_or(""))) })?
        }
        "showMenu" => {
            let found = pattern::<IUIAutomationExpandCollapsePattern>(&element, UIA_ExpandCollapsePatternId).ok_or("it has no menu")?;
            done(unsafe { found.Expand() })?
        }
        "scrollTo" => {
            let found = pattern::<IUIAutomationScrollItemPattern>(&element, UIA_ScrollItemPatternId).ok_or("it can't be scrolled to")?;
            done(unsafe { found.ScrollIntoView() })?
        }
        "increment" | "decrement" => return Err(format!("{action} isn't available on Windows yet")),
        other => return Err(format!("unknown action \"{other}\"")),
    }
    Ok(json!({ "element": describe(&element) }))
}

/// What has the keyboard focus, and whether it's a password field.
pub fn focused() -> Result<Value> {
    let element = unsafe { automation()?.GetFocusedElement() }.map_err(|err| err.to_string())?;
    let pid = unsafe { element.CurrentProcessId() }.unwrap_or(0) as u32;
    let (exe, elevated) = exe_name(pid);
    Ok(json!({ "element": describe(&element), "app": { "pid": pid, "exe": exe, "elevated": elevated } }))
}
