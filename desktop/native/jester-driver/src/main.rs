//! jester-driver: Jester's hands on the computer.
//!
//! The Electron app spawns this and talks to it in JSON lines (see
//! protocol.rs). Input — moving, clicking, keys, text, media keys — runs on
//! the main thread as it arrives. Accessibility queries run on a second
//! thread: an app that has stopped responding can stall them for the length
//! of their timeout, and the cursor must never wait on that.
//!
//! Flags:
//!   --dry-run  describe every input event instead of posting it (tests, CI)
//!   --relay    act as Chrome's native-messaging host instead (relay.rs)

mod protocol;
mod relay;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as platform;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

use protocol::{fail, ok, Command, KeyAction};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

pub type Result<T> = std::result::Result<T, String>;

/// Every input event goes through here, so a dry run can list them instead.
pub struct Poster {
    pub dry_run: bool,
    pub log: Vec<Value>,
}

impl Poster {
    pub fn record(&mut self, event: Value) {
        if self.dry_run {
            self.log.push(event);
        }
    }
}

fn write_line(out: &Arc<Mutex<std::io::Stdout>>, value: &Value) {
    let mut out = out.lock().unwrap();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn run_input(input: &mut platform::Input, poster: &mut Poster, command: Command) -> Result<Map<String, Value>> {
    poster.log.clear();
    let result = match command {
        Command::Hello => Ok(object(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "dryRun": poster.dry_run,
            "permissions": platform::permissions(false),
        }))),
        Command::Trust { prompt } => Ok(object(json!({ "permissions": platform::permissions(prompt) }))),
        Command::Configure { key_tap, key_source, key_delay_ms } => input
            .configure(key_tap.as_deref(), key_source.as_deref(), key_delay_ms)
            .map(|style| object(json!({ "style": style }))),
        Command::Cursor => input.cursor().map(|(x, y)| object(json!({ "x": x, "y": y }))),
        Command::Move { x, y } => input.move_to(poster, x, y).map(|_| Map::new()),
        Command::Click { x, y, button, count } => {
            let at = match (x, y) {
                (Some(x), Some(y)) => (x, y),
                _ => input.cursor()?,
            };
            input.move_to(poster, at.0, at.1)?;
            for n in 1..=count.clamp(1, 3) {
                input.button(poster, button, true, at, n)?;
                input.button(poster, button, false, at, n)?;
            }
            Ok(Map::new())
        }
        Command::Button { x, y, button, down } => {
            let at = match (x, y) {
                (Some(x), Some(y)) => (x, y),
                _ => input.cursor()?,
            };
            input.button(poster, button, down, at, 1).map(|_| Map::new())
        }
        Command::Scroll { x, y, dx, dy, unit } => {
            let at = match (x, y) {
                (Some(x), Some(y)) => {
                    input.move_to(poster, x, y)?;
                    (x, y)
                }
                _ => input.cursor()?,
            };
            input.scroll(poster, dx, dy, unit, at).map(|_| Map::new())
        }
        Command::Key { key, modifiers, action } => {
            let mut mods = Vec::new();
            for name in &modifiers {
                mods.push(protocol::modifier(name).ok_or_else(|| format!("unknown modifier \"{name}\""))?);
            }
            let key = protocol::canonical_key(&key);
            // Modifiers go down first and come up last, as fingers would:
            // some shortcuts (⌘-Tab, Alt-Tab) watch the modifier keys
            // themselves, not just the flags on the key event.
            if action != KeyAction::Up {
                for (i, modifier) in mods.iter().enumerate() {
                    input.modifier(poster, *modifier, true, &mods[..=i])?;
                }
                input.key(poster, &key, true, &mods)?;
            }
            if action != KeyAction::Down {
                input.key(poster, &key, false, &mods)?;
                for (i, modifier) in mods.iter().enumerate().rev() {
                    input.modifier(poster, *modifier, false, &mods[..i])?;
                }
            }
            Ok(Map::new())
        }
        Command::Text { text } => input.text(poster, &text).map(|_| Map::new()),
        Command::Media { key } => input.media(poster, key).map(|_| Map::new()),
        Command::ElementAt { .. } | Command::Frontmost | Command::Wake { .. } | Command::Quit => unreachable!(),
    };
    result.map(|mut body| {
        if poster.dry_run && !poster.log.is_empty() {
            body.insert("events".into(), Value::Array(std::mem::take(&mut poster.log)));
        }
        body
    })
}

fn run_query(command: Command) -> Result<Map<String, Value>> {
    match command {
        Command::ElementAt { x, y } => platform::element_at(x, y).map(object),
        Command::Frontmost => platform::frontmost().map(object),
        Command::Wake { pid } => platform::wake(pid).map(object),
        _ => unreachable!(),
    }
}

fn main() {
    // Chrome starts a native-messaging host with the caller's origin as its
    // first argument, and a host manifest can't add flags of its own: that
    // origin is how the relay knows it is one.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--relay" || arg.starts_with("chrome-extension://")) {
        let origin = args.iter().find(|arg| arg.starts_with("chrome-extension://")).cloned();
        std::process::exit(relay::run(origin));
    }
    let dry_run = args.iter().any(|arg| arg == "--dry-run");
    let out = Arc::new(Mutex::new(std::io::stdout()));

    let (queries, query_rx) = mpsc::channel::<(Value, Command)>();
    let query_out = out.clone();
    let query_thread = std::thread::spawn(move || {
        platform::init_query_thread();
        for (id, command) in query_rx {
            let reply = match run_query(command) {
                Ok(body) => ok(&id, body),
                Err(error) => fail(&id, error),
            };
            write_line(&query_out, &reply);
        }
    });

    let mut input = platform::Input::new();
    let mut poster = Poster { dry_run, log: Vec::new() };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(err) => {
                write_line(&out, &fail(&Value::Null, format!("bad JSON: {err}")));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let command: Command = match serde_json::from_value(request) {
            Ok(command) => command,
            Err(err) => {
                write_line(&out, &fail(&id, format!("bad request: {err}")));
                continue;
            }
        };
        if matches!(command, Command::Quit) {
            drop(queries);
            let _ = query_thread.join();
            write_line(&out, &ok(&id, Map::new()));
            return;
        }
        if command.is_query() {
            let _ = queries.send((id, command));
            continue;
        }
        let reply = match run_input(&mut input, &mut poster, command) {
            Ok(body) => ok(&id, body),
            Err(error) => fail(&id, error),
        };
        write_line(&out, &reply);
    }
    // stdin closed: the app is gone. Let queries in flight answer first.
    drop(queries);
    let _ = query_thread.join();
}
