//! The wire format: one JSON object per line on stdin, one per line on stdout.
//!
//! Request:  {"id": 7, "cmd": "click", "x": 640, "y": 400}
//! Response: {"id": 7, "ok": true, ...} or {"id": 7, "ok": false, "error": "..."}
//!
//! Coordinates are the OS's own global ones: points from the top-left of the
//! primary display on macOS (what Electron's `screen` reports there), physical
//! pixels on Windows (driver.js converts from Electron's DIPs).

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Command {
    Hello,
    /// Ask the OS for the permissions input needs; `prompt` shows its dialog.
    Trust {
        #[serde(default)]
        prompt: bool,
    },
    /// How keyboard events are posted (macOS): tap "hid"|"session",
    /// source "hid"|"combined"|"private"|"none", delay between events.
    Configure {
        key_tap: Option<String>,
        key_source: Option<String>,
        key_delay_ms: Option<u64>,
    },
    Cursor,
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        button: Button,
        #[serde(default = "one")]
        count: u32,
    },
    /// Press or release without the other half, for drags.
    Button {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        button: Button,
        down: bool,
    },
    /// Positive `dy` scrolls up (content moves down), as a wheel turned away from you.
    Scroll {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        unit: ScrollUnit,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default)]
        action: KeyAction,
    },
    Text {
        text: String,
    },
    Media {
        key: MediaKey,
    },
    /// What the accessibility tree has at a point, and the nearest ancestor that can be pressed.
    ElementAt {
        x: f64,
        y: f64,
    },
    /// The app and window in front.
    Frontmost,
    /// Have an app build its accessibility tree ahead of the first query
    /// (Chromium and Electron apps take about two seconds).
    Wake {
        pid: i32,
    },
    Quit,
}

impl Command {
    /// Accessibility queries can block on an app that has stopped responding,
    /// so they run on their own thread and never hold up the cursor.
    pub fn is_query(&self) -> bool {
        matches!(self, Command::ElementAt { .. } | Command::Frontmost | Command::Wake { .. })
    }
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScrollUnit {
    #[default]
    Pixel,
    Line,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    #[default]
    Tap,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaKey {
    Play,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    Mute,
    BrightnessUp,
    BrightnessDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    /// ⌘ on macOS, the Windows key on Windows.
    Meta,
    Control,
    Alt,
    Shift,
    Fn,
}

pub fn modifier(name: &str) -> Option<Modifier> {
    match name.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Some(Modifier::Meta),
        "ctrl" | "control" => Some(Modifier::Control),
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "fn" | "function" => Some(Modifier::Fn),
        _ => None,
    }
}

/// One spelling per key, so each platform's table has a single entry for it.
pub fn canonical_key(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "return" => "enter",
        "esc" => "escape",
        "del" | "forwarddelete" => "delete",
        "back" => "backspace",
        "pgup" => "pageup",
        "pgdn" => "pagedown",
        "arrowleft" => "left",
        "arrowright" => "right",
        "arrowup" => "up",
        "arrowdown" => "down",
        "-" => "minus",
        "=" => "equal",
        "," => "comma",
        "." => "period",
        "/" => "slash",
        "\\" => "backslash",
        ";" => "semicolon",
        "'" => "quote",
        "`" => "grave",
        "[" => "leftbracket",
        "]" => "rightbracket",
        " " => "space",
        other => other,
    }
    .to_string()
}

pub fn ok(id: &Value, mut body: serde_json::Map<String, Value>) -> Value {
    body.insert("id".into(), id.clone());
    body.insert("ok".into(), Value::Bool(true));
    Value::Object(body)
}

pub fn fail(id: &Value, error: impl Into<String>) -> Value {
    serde_json::json!({ "id": id, "ok": false, "error": error.into() })
}
