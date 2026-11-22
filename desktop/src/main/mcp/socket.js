/**
 * Where Jester's MCP server (server.js) is reached: a socket of the user's
 * own, in Jester's data folder, open only while they've said other apps may
 * use his tools (Settings › Tools). A client doesn't open it itself: it runs
 * the little bridge beside this file (desktop/bin/jester-mcp.mjs), as MCP
 * clients run any server, and the bridge passes its lines here.
 *
 * A socket file, not a network port: nothing off this computer can reach it,
 * and macOS keeps other users out of it (mode 600). Whatever of the user's
 * own can open it is using Jester's hands with Jester's permissions, which is
 * why it's off until they turn it on, and why what's done through it shows on
 * his pill and still asks before anything is sent, bought or deleted.
 *
 * On Windows the same thing is a named pipe.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Where the socket is, for a data folder: a named pipe on Windows, where a socket can't be a file. */
export function mcpSocketPath(dataDir, { platform = process.platform, user = '' } = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\jester-mcp-${String(user || 'user').replace(/[^\w.-]+/g, '_')}`;
  return path.join(dataDir, 'mcp.sock');
}

/**
 * @param {object} deps
 * @param {string} deps.file  mcpSocketPath's
 * @param {{connect:(send:(line:string) => void) => {receive:Function, close:Function}}} deps.server  server.js
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createMcpSocket({ file, server, log = () => undefined }) {
  let listening = null;
  const open = new Set();

  function serve(socket) {
    open.add(socket);
    socket.setEncoding('utf8');
    const client = server.connect((line) => {
      if (!socket.destroyed) socket.write(`${line}\n`);
    });
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      // A line that never ends isn't a message.
      if (pending.length > 2_000_000) return void socket.destroy();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) client.receive(line);
    });
    const gone = () => {
      if (!open.delete(socket)) return;
      client.close();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  return {
    get listening() {
      return !!listening;
    },
    /** Opens it. A socket file left by a Jester that quit without closing it is cleared first. */
    start() {
      if (listening) return Promise.resolve(true);
      return new Promise((resolve) => {
        const made = net.createServer(serve);
        const failed = (err) => {
          log('mcp: couldn’t open his tools to other apps:', err.message);
          resolve(false);
        };
        made.once('error', (err) => {
          if (err.code !== 'EADDRINUSE' || process.platform === 'win32') return failed(err);
          // In use, or only left behind: if nothing answers there, it's ours to clear.
          const probe = net.connect(file);
          probe.once('connect', () => {
            probe.destroy();
            failed(new Error('another Jester already has them open'));
          });
          probe.once('error', () => {
            try {
              fs.rmSync(file, { force: true });
            } catch (rmErr) {
              return failed(rmErr);
            }
            made.once('error', failed);
            made.listen(file, ready);
          });
        });
        const ready = () => {
          // Only the user's own programs.
          if (process.platform !== 'win32') {
            try {
              fs.chmodSync(file, 0o600);
            } catch (err) {
              log('mcp: couldn’t close the socket to other users:', err.message);
            }
          }
          listening = made;
          log('mcp: his tools are open to other apps on this computer');
          resolve(true);
        };
        made.listen(file, ready);
      });
    },
    /** Closes it, and whoever's connected. */
    stop() {
      const was = listening;
      listening = null;
      for (const socket of open) socket.destroy();
      if (!was) return Promise.resolve();
      return new Promise((resolve) => {
        was.close(() => {
          if (process.platform !== 'win32') fs.rmSync(file, { force: true });
          log('mcp: his tools are closed to other apps');
          resolve();
        });
      });
    }
  };
}
