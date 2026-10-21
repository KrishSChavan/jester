/**
 * The app's end of the link to the Chrome extension.
 *
 * When the extension calls `chrome.runtime.connectNative`, Chrome starts
 * jester-driver as a relay (native/jester-driver/src/relay.rs), which
 * connects here. JSON lines, both ways. The socket sits in a folder only this
 * user can open; the relay's first line names the calling extension, and one
 * not in `allowedOrigins` is turned away. One extension at a time: a new
 * connection replaces the old one.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const HOST_NAME = 'com.jester.desktop';

export function defaultSocketPath(platform = process.platform) {
  // Windows: phase 5, a named pipe.
  if (platform === 'win32') return '\\\\.\\pipe\\jester-link';
  return path.join(os.homedir(), 'Library/Application Support/Jester/link.sock');
}

/** The manifest Chrome reads to find the relay. `origins`: chrome-extension://<id>/ */
export function hostManifest({ relayPath, origins }) {
  return {
    name: HOST_NAME,
    description: 'Jester Desktop link',
    path: relayPath,
    type: 'stdio',
    allowed_origins: origins
  };
}

/**
 * @param {object} options
 * @param {string} [options.socketPath]
 * @param {string[]|null} [options.allowedOrigins]  null: any extension (tests only)
 * @param {(message:object, origin:string) => void} [options.onMessage]
 * @param {(origin:string) => void} [options.onConnect]
 * @param {() => void} [options.onDisconnect]
 */
export function startLink({ socketPath = defaultSocketPath(), allowedOrigins = null, onMessage, onConnect, onDisconnect } = {}) {
  const unix = !socketPath.startsWith('\\\\.\\pipe\\');
  if (unix) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    // A socket file left behind by a crash would make listen() fail.
    fs.rmSync(socketPath, { force: true });
  }
  let current = null;

  const server = net.createServer((socket) => {
    let origin = null;
    readline.createInterface({ input: socket }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (origin === null) {
        if (message?.type !== 'jester/relay-hello' || (allowedOrigins && !allowedOrigins.includes(String(message.origin)))) {
          socket.destroy();
          return;
        }
        origin = String(message.origin);
        current?.destroy();
        current = socket;
        onConnect?.(origin);
        return;
      }
      if (socket === current) onMessage?.(message, origin);
    });
    socket.on('close', () => {
      if (socket !== current) return;
      current = null;
      onDisconnect?.();
    });
    socket.on('error', () => undefined);
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (unix) fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  return {
    ready,
    /** False when no extension is connected. */
    send(message) {
      if (!current) return false;
      current.write(`${JSON.stringify(message)}\n`);
      return true;
    },
    get connected() {
      return !!current;
    },
    close() {
      current?.destroy();
      server.close();
      if (unix) fs.rmSync(socketPath, { force: true });
    }
  };
}
