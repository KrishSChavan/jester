//! `--relay`: Chrome's native-messaging host.
//!
//! Chrome starts this when the extension calls `chrome.runtime.connectNative`,
//! and talks to it in its own framing: a 4-byte native-endian length, then
//! that many bytes of JSON. The app listens on a local socket and talks JSON
//! lines. This just carries messages across, both ways, until either side
//! goes away.
//!
//! The first line the app sees is `{"type":"jester/relay-hello","origin":...}`,
//! with the calling extension's origin as Chrome gave it, so the app can
//! refuse an extension it doesn't know. If the app isn't running, the
//! extension gets one `jester/link-error` message and the port closes.

use serde_json::json;
use std::io::Write;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Read};

/// Chrome refuses messages from a host larger than this.
const MAX_TO_CHROME: usize = 1024 * 1024;

fn write_frame(out: &mut impl Write, json: &str) -> std::io::Result<()> {
    if json.len() > MAX_TO_CHROME {
        return Ok(());
    }
    out.write_all(&(json.len() as u32).to_ne_bytes())?;
    out.write_all(json.as_bytes())?;
    out.flush()
}

#[cfg(unix)]
fn read_frame(input: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let mut body = vec![0u8; u32::from_ne_bytes(length) as usize];
    input.read_exact(&mut body)?;
    Ok(Some(body))
}

#[cfg(unix)]
fn socket_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("JESTER_LINK_SOCKET") {
        return path.into();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join("Library/Application Support/Jester/link.sock")
}

#[cfg(unix)]
pub fn run(origin: Option<String>) -> i32 {
    use std::os::unix::net::UnixStream;

    let mut chrome_out = std::io::stdout();
    let socket = match UnixStream::connect(socket_path()) {
        Ok(socket) => socket,
        Err(_) => {
            let _ = write_frame(&mut chrome_out, &json!({ "type": "jester/link-error", "detail": "Jester Desktop isn't running." }).to_string());
            return 0;
        }
    };
    let mut to_app = match socket.try_clone() {
        Ok(stream) => stream,
        Err(_) => return 1,
    };
    if writeln!(to_app, "{}", json!({ "type": "jester/relay-hello", "origin": origin })).is_err() {
        return 1;
    }

    // App → Chrome on its own thread; Chrome → app here. Either side closing ends both.
    std::thread::spawn(move || {
        let mut chrome_out = std::io::stdout();
        for line in BufReader::new(socket).lines() {
            let Ok(line) = line else { break };
            if write_frame(&mut chrome_out, &line).is_err() {
                break;
            }
        }
        std::process::exit(0);
    });
    let mut chrome_in = std::io::stdin().lock();
    while let Ok(Some(body)) = read_frame(&mut chrome_in) {
        // One message per line: compact JSON never contains a raw newline.
        let Ok(text) = String::from_utf8(body) else { continue };
        if writeln!(to_app, "{}", text.trim()).is_err() {
            break;
        }
    }
    0
}

#[cfg(windows)]
pub fn run(_origin: Option<String>) -> i32 {
    // Named pipe transport: phase 5, tested on a Windows PC.
    let _ = write_frame(&mut std::io::stdout(), &json!({ "type": "jester/link-error", "detail": "The Windows relay isn't built yet." }).to_string());
    0
}
