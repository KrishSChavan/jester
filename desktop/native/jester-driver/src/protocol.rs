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
    /// Press or release without the other half, for drags, and for the second
    /// click of a pair whose first has already landed (`count` 2).
    Button {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        button: Button,
        down: bool,
        #[serde(default = "one")]
        count: u32,
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
    /// What the accessibility tree has at a point, and the nearest ancestor that
    /// can be pressed. `wait: false` never waits for a Chromium app's tree to be
    /// built (the cursor's aim-assist can't afford to); the default waits.
    ElementAt {
        x: f64,
        y: f64,
        #[serde(default = "yes")]
        wait: bool,
        /// Include how the answer was found (`trace`), for diagnosing aim-assist.
        #[serde(default)]
        debug: bool,
    },
    /// The app and window in front.
    Frontmost,
    /// Have an app build its accessibility tree ahead of the first query
    /// (Chromium and Electron apps take about two seconds).
    Wake {
        pid: i32,
    },
    /// The running apps the Dock (or the taskbar) shows.
    Apps,
    /// The front window's controls (or `pid`'s), numbered for `act`: what the
    /// assistant sees. At most `limit` are listed.
    Snapshot {
        pid: Option<i32>,
        /// Look past this app's windows (Jester's own: its Settings in front isn't the screen meant).
        exclude: Option<i32>,
        #[serde(default = "snapshot_limit")]
        limit: usize,
        /// Include every element looked at (`visited`: depth, role, children), for diagnosing.
        #[serde(default)]
        debug: bool,
    },
    /// Do something to `element` of snapshot `snapshot`: press, focus, read,
    /// setValue and appendValue (with `value`), showMenu, scrollTo,
    /// increment, decrement; scrollPage and scrollEnd (`value`: up, down,
    /// left or right), which without an `element` scroll the window's main
    /// area. Password fields are never focused, read or filled. (`element`,
    /// not `id`: `id` is the request's.)
    ///
    /// After agent-desktop (github.com/vercel-labs/agent-desktop): an
    /// element that has left the screen is refused (GONE) rather than acted
    /// on where it used to be; `press` tries each accessibility way of
    /// clicking in turn, and says which worked (`via`); and `point` answers
    /// where a real click would land on the element — its frame read live,
    /// scrolled into view, still, and hit-tested — or what covers it.
    Act {
        snapshot: u64,
        element: Option<usize>,
        action: String,
        value: Option<String>,
    },
    /// An app's menu-bar command by its titles, ["File", "New Note"], matched
    /// forgivingly ("new note" finds "New Note") unless `exact`. `press:
    /// false` only finds it: its real titles, and whether it can be chosen
    /// now; a level it can't read without opening comes back as asked, with
    /// `partial`. Pressing what was judged takes `exact`, so the command
    /// chosen is the one the titles name, word for word.
    Menu {
        pid: i32,
        path: Vec<String>,
        #[serde(default)]
        press: bool,
        #[serde(default)]
        exact: bool,
    },
    /// An app's window: where it is, and whether it's minimized or full screen.
    Window {
        pid: i32,
    },
    /// Move and size an app's window, bringing it out of the Dock (or the
    /// taskbar) and out of full screen first. `maximize` then maximizes it
    /// (Windows; on macOS the frame given already fills the screen);
    /// `fullscreen` makes it full screen (macOS) or maximized (Windows).
    PlaceWindow {
        pid: i32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default)]
        maximize: bool,
        #[serde(default)]
        fullscreen: bool,
    },
    /// What has the keyboard focus.
    Focused,
    /// Ask an app to quit, as its own Quit command would: unsaved work gets
    /// its usual prompt.
    QuitApp {
        pid: i32,
    },
    /// The window under a point: where it is, brought to the front, and from
    /// now on the one `MoveWindow` moves.
    WindowAt {
        x: f64,
        y: f64,
    },
    /// The window `WindowAt` found, to here. Quick enough to follow a hand.
    MoveWindow {
        x: f64,
        y: f64,
    },
    /// Hide an app (macOS) or minimize its windows (Windows).
    HideApp {
        pid: i32,
    },
    /// Bring a running app's window to the front (Windows; macOS opens apps
    /// with `open`, which LaunchServices always lets through).
    ActivateApp {
        pid: i32,
    },
    Quit,
}

impl Command {
    /// Accessibility queries can block on an app that has stopped responding,
    /// so they run on their own thread and never hold up the cursor.
    pub fn is_query(&self) -> bool {
        matches!(
            self,
            Command::ElementAt { .. }
                | Command::Frontmost
                | Command::Wake { .. }
                | Command::Apps
                | Command::Snapshot { .. }
                | Command::Act { .. }
                | Command::Focused
                | Command::Menu { .. }
                | Command::Window { .. }
                | Command::PlaceWindow { .. }
                | Command::WindowAt { .. }
                | Command::MoveWindow { .. }
        )
    }
}

/// A title as titles are compared: case, ellipses, dashes and spacing don't
/// count ("Save As…" is "save as", and macOS's "Wi‑Fi" is "wi-fi").
pub fn normalized(text: &str) -> String {
    let text: String = text
        .to_lowercase()
        .replace('…', " ")
        .replace("...", " ")
        .chars()
        .map(|c| if matches!(c, '\u{2010}'..='\u{2015}' | '\u{2212}') { '-' } else { c })
        .collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ").trim_end_matches(':').trim_end().to_string()
}

fn words(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).collect()
}

/// How well a title fits the words asked for: 4 the same, 3 it starts with
/// them, 2 it holds them as whole words, 1 somewhere inside, 0 not at all.
pub fn rank(title: &str, wanted: &str) -> u8 {
    let (title, wanted) = (normalized(title), normalized(wanted));
    if title.is_empty() || wanted.is_empty() {
        return 0;
    }
    if title == wanted {
        return 4;
    }
    if title.starts_with(&wanted) {
        return 3;
    }
    let (have, want) = (words(&title), words(&wanted));
    if !want.is_empty() && have.windows(want.len()).any(|run| run == want.as_slice()) {
        return 2;
    }
    u8::from(title.contains(&wanted))
}

/// The best of `titles` for `wanted` — never a mere fragment of a word — and
/// the first of equals, as a menu lists them.
pub fn best_match(titles: &[String], wanted: &str) -> Option<usize> {
    let mut best: Option<(u8, usize)> = None;
    for (i, title) in titles.iter().enumerate() {
        let score = rank(title, wanted);
        if score >= 2 && best.is_none_or(|(top, _)| score > top) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| i)
}

/// The title meant: the best match, or with `exact` only the same title.
pub fn title_match(titles: &[String], wanted: &str, exact: bool) -> Option<usize> {
    if exact {
        titles.iter().position(|title| rank(title, wanted) == 4)
    } else {
        best_match(titles, wanted)
    }
}

/// Text as typed text is compared: case and spacing don't count.
pub fn squashed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The last `chars` characters of some text.
pub fn tail(text: &str, chars: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(chars)).collect()
}

/// A field's text, read back: its start and end, how long it is, and (asked
/// about some) whether it holds those words anywhere — a check that
/// can't miss words typed past the start, however long the field.
pub fn read_reply(full: &str, expected: Option<&str>) -> Value {
    let mut reply = serde_json::json!({ "value": full.chars().take(2000).collect::<String>(), "tail": tail(full, 2000), "length": full.chars().count() });
    if let Some(expected) = expected {
        reply["contains"] = Value::Bool(squashed(full).contains(&squashed(expected)));
    }
    reply
}

/// What there is instead, for a message: the first dozen titles.
pub fn listing(titles: &[String]) -> String {
    let shown: Vec<&str> = titles.iter().map(|title| title.trim()).filter(|title| !title.is_empty()).collect();
    let mut text = shown.iter().take(12).copied().collect::<Vec<_>>().join(", ");
    if shown.len() > 12 {
        text.push_str(&format!(" and {} more", shown.len() - 12));
    }
    if text.is_empty() {
        "nothing".into()
    } else {
        text
    }
}

/// A menu path in words: File › New Note.
pub fn menu_words(path: &[String]) -> String {
    path.join(" › ")
}

/// A scroll direction; the value moves up (true) or down along its bar.
pub fn scroll_direction(value: Option<&str>) -> Result<(bool, bool), String> {
    match value {
        Some("up") => Ok((false, false)),
        Some("down") => Ok((false, true)),
        Some("left") => Ok((true, false)),
        Some("right") => Ok((true, true)),
        _ => Err("scroll up, down, left or right".into()),
    }
}

/// What `act` says of an element that has left the screen since it was
/// read: its row deleted, its sheet closed. Where it was drawn something else
/// may be now, so it is never clicked there.
pub const GONE: &str = "it's gone from the screen since it was read; read it again";

/// A frame: (x, y, w, h).
pub type Frame = (f64, f64, f64, f64);

/// What a hit test at a point found: the element meant (or something inside
/// it), something else on top of it (described), or no clear answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Hit {
    Reaches,
    Covered(String),
    Unknown,
}

/// Where a click on a frame may land, tried in turn: its middle, then the
/// middles of its four quarters, so a control half under a toolbar or a
/// banner can still be reached (agent-desktop's five-point sweep).
pub fn candidate_points((x, y, w, h): Frame) -> [(f64, f64); 5] {
    let at = |fx: f64, fy: f64| (x + w * fx, y + h * fy);
    [at(0.5, 0.5), at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)]
}

/// The first point whose hit test reaches the element. With none, what
/// covers it — unless some answer was unclear, when the middle is given
/// unchecked: a test that can't tell never stops a click (the step's effect
/// is read back afterwards); only something plainly on top does.
pub fn click_point(frame: Frame, mut hit: impl FnMut(f64, f64) -> Hit) -> Value {
    let points = candidate_points(frame);
    let mut covered = None;
    let mut unclear = false;
    for (x, y) in points {
        match hit(x, y) {
            Hit::Reaches => return serde_json::json!({ "x": x, "y": y, "checked": true }),
            Hit::Covered(what) => {
                covered.get_or_insert(what);
            }
            Hit::Unknown => unclear = true,
        }
    }
    match covered {
        Some(what) if !unclear => serde_json::json!({ "covered": what }),
        _ => serde_json::json!({ "x": points[0].0, "y": points[0].1, "checked": false }),
    }
}

/// Whether two reads of a frame are the same, to half a point.
pub fn same_frame(a: Frame, b: Frame) -> bool {
    [(a.0, b.0), (a.1, b.1), (a.2, b.2), (a.3, b.3)].iter().all(|(a, b)| (a - b).abs() <= 0.5)
}

/// Between reads of a moving frame, and how many reads at most.
pub const SETTLE_GAP_MS: u64 = 17;
pub const SETTLE_READS: usize = 12;

/// An element's frame once it has stopped moving (a sheet sliding in, a
/// list still laying out): three reads alike in a row, or the last read
/// once SETTLE_READS have been made. None when it has no frame at all.
pub fn settled_frame(mut read: impl FnMut() -> Option<Frame>, mut pause: impl FnMut()) -> Option<Frame> {
    let mut last: Option<Frame> = None;
    let mut alike = 0;
    for n in 0..SETTLE_READS {
        if n > 0 {
            pause();
        }
        let now = read();
        alike = match (last, now) {
            (Some(before), Some(now)) if same_frame(before, now) => alike + 1,
            (_, Some(_)) => 1,
            (_, None) => 0,
        };
        last = now;
        if alike >= 3 {
            break;
        }
    }
    last
}

/// Whether a point is inside a frame.
pub fn holds(frame: Frame, (x, y): (f64, f64)) -> bool {
    x >= frame.0 && y >= frame.1 && x <= frame.0 + frame.2 && y <= frame.1 + frame.3
}

/// Which child may be pressed for an element that can't be pressed itself
/// (a web list item wrapping its link): the only one of the first few that
/// can be, and only if it is the same thing under another role —
/// unnamed, or named as the element is. A row holding a Play and a Delete
/// button is never pressed through either: the user's OK, where one was
/// needed, was for the element's name, not a button inside it.
// Windows has no such step: UI Automation's patterns already sit on the item.
#[cfg_attr(windows, allow(dead_code))]
pub fn stand_in(label: Option<&str>, children: &[(bool, Option<String>)]) -> Option<usize> {
    let pressable: Vec<usize> = children.iter().enumerate().filter(|(_, (can, _))| *can).map(|(i, _)| i).collect();
    let [only] = pressable.as_slice() else { return None };
    let same = match (&children[*only].1, label) {
        (None, _) => true,
        (Some(name), Some(label)) => normalized(name) == normalized(label),
        (Some(name), None) => normalized(name).is_empty(),
    };
    same.then_some(*only)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_lands_where_the_element_is_not_covered() {
        let frame = (100.0, 200.0, 80.0, 40.0);
        assert_eq!(candidate_points(frame)[0], (140.0, 220.0), "its middle first");
        assert_eq!(candidate_points(frame)[4], (160.0, 230.0));
        // A banner over its middle: the next point that reaches it.
        let mut asked = Vec::new();
        let point = click_point(frame, |x, y| {
            asked.push((x, y));
            if asked.len() == 1 { Hit::Covered("banner".into()) } else { Hit::Reaches }
        });
        assert_eq!(point, serde_json::json!({ "x": 120.0, "y": 210.0, "checked": true }));
        // Covered everywhere: not clicked, and what covers it is said.
        assert_eq!(click_point(frame, |_, _| Hit::Covered("the sheet “Save”".into())), serde_json::json!({ "covered": "the sheet “Save”" }));
        // An answer that can't tell never stops a click: the middle, unchecked.
        let mut n = 0;
        let unclear = click_point(frame, |_, _| {
            n += 1;
            if n == 2 { Hit::Unknown } else { Hit::Covered("dialog".into()) }
        });
        assert_eq!(unclear, serde_json::json!({ "x": 140.0, "y": 220.0, "checked": false }));
    }

    #[test]
    fn a_moving_frame_is_read_until_it_stops() {
        let reads = [(0.0, 0.0, 10.0, 10.0), (0.0, 40.0, 10.0, 10.0), (0.0, 80.0, 10.0, 10.0), (0.0, 80.2, 10.0, 10.0), (0.0, 80.0, 10.0, 10.0), (0.0, 999.0, 1.0, 1.0)];
        let mut at = 0;
        let mut pauses = 0;
        let frame = settled_frame(
            || {
                at += 1;
                Some(reads[at - 1])
            },
            || pauses += 1,
        );
        assert_eq!(frame, Some((0.0, 80.0, 10.0, 10.0)));
        assert_eq!((at, pauses), (5, 4), "three alike in a row ends it");
        assert_eq!(settled_frame(|| None, || ()), None);
        let mut moving = 0.0;
        let last = settled_frame(
            || {
                moving += 5.0;
                Some((moving, 0.0, 10.0, 10.0))
            },
            || (),
        );
        assert_eq!(last, Some((5.0 * SETTLE_READS as f64, 0.0, 10.0, 10.0)), "never still: the last read");
    }

    #[test]
    fn only_a_child_that_is_the_same_thing_stands_in() {
        let unnamed = |can: bool| (can, None::<String>);
        let named = |can: bool, name: &str| (can, Some(name.to_string()));
        assert_eq!(stand_in(Some("Downloads"), &[unnamed(false), unnamed(true)]), Some(1), "Finder's row and the cell that opens it");
        assert_eq!(stand_in(Some("Downloads"), &[named(true, "downloads")]), Some(0));
        assert_eq!(stand_in(Some("Meeting notes"), &[named(true, "Delete")]), None, "a button inside is not the row");
        assert_eq!(stand_in(None, &[named(true, "Delete")]), None);
        assert_eq!(stand_in(Some("Song"), &[named(true, "Play"), unnamed(true)]), None, "two to choose from: neither");
        assert_eq!(stand_in(Some("Song"), &[unnamed(false)]), None);
    }

    #[test]
    fn titles_match_forgivingly_but_never_on_a_fragment() {
        assert_eq!(normalized("Save As…"), "save as");
        assert_eq!(normalized("Wi\u{2011}Fi"), "wi-fi");
        assert_eq!(rank("New Note", "new note"), 4);
        assert_eq!(rank("New Note", "new"), 3);
        assert_eq!(rank("Move to Trash", "trash"), 2);
        assert_eq!(rank("Notes", "ote"), 1);
        assert_eq!(rank("Notes", "folder"), 0);
        let titles: Vec<String> = ["Notes", "File", "Edit", "New Note", "New Folder"].map(String::from).to_vec();
        assert_eq!(best_match(&titles, "new note"), Some(3));
        assert_eq!(best_match(&titles, "new"), Some(3), "the first of equals");
        assert_eq!(best_match(&titles, "ote"), None, "a fragment is no match");
        assert_eq!(listing(&titles), "Notes, File, Edit, New Note, New Folder");
        let many: Vec<String> = (1..=14).map(|n| format!("Item {n}")).collect();
        assert!(listing(&many).ends_with("and 2 more"));
    }

    #[test]
    fn an_exact_press_takes_only_the_same_title() {
        let titles: Vec<String> = ["Move to Trash", "Empty Trash", "Trash"].map(String::from).to_vec();
        assert_eq!(title_match(&titles, "trash", false), Some(2), "the exact one ranks first");
        assert_eq!(title_match(&titles, "empty", false), Some(1));
        assert_eq!(title_match(&titles, "empty", true), None, "a prefix is not the title judged");
        assert_eq!(title_match(&titles, "Empty Trash", true), Some(1));
    }

    #[test]
    fn a_read_back_finds_words_typed_past_the_start() {
        let long = format!("{}LGTM", "x ".repeat(3000));
        let reply = read_reply(&long, Some("lgtm"));
        assert_eq!(reply["contains"], true);
        assert_eq!(reply["value"].as_str().unwrap().chars().count(), 2000);
        assert!(reply["tail"].as_str().unwrap().ends_with("LGTM"));
        assert_eq!(read_reply("hello", None).get("contains"), None);
    }

    #[test]
    fn directions_name_an_axis_and_a_way_along_it() {
        assert_eq!(scroll_direction(Some("down")), Ok((false, true)));
        assert_eq!(scroll_direction(Some("left")), Ok((true, false)));
        assert!(scroll_direction(Some("sideways")).is_err());
    }
}

fn one() -> u32 {
    1
}

fn snapshot_limit() -> usize {
    300
}

fn yes() -> bool {
    true
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
