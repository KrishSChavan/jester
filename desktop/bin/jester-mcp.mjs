#!/usr/bin/env node
/**
 * The bridge an MCP client runs to reach Jester's tools: its standard input
 * and output on one side, Jester's own socket on the other (src/main/mcp/).
 * It knows nothing of the protocol but one thing: with no Jester to pass a
 * request to, it answers the request itself, saying why, so the client has
 * something to show rather than a server that never speaks.
 *
 * In a client's settings (Jester's Settings › Tools shows these lines ready to copy):
 *
 *   { "mcpServers": { "jester": { "command": "node", "args": ["/path/to/jester-mcp.mjs"] } } }
 *
 * JESTER_MCP_SOCKET names the socket, when it isn't the usual one.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function socketPath() {
  if (process.env.JESTER_MCP_SOCKET) return process.env.JESTER_MCP_SOCKET;
  if (process.platform === 'win32') return `\\\\.\\pipe\\jester-mcp-${String(os.userInfo().username || 'user').replace(/[^\w.-]+/g, '_')}`;
  const data = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Jester') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Jester');
  return path.join(data, 'mcp.sock');
}

const WHY = 'Jester isn’t reachable. Open Jester, and turn on “Let other apps use Jester’s tools” in his Settings › Tools.';
let socket = null;
let up = false;
let waiting = '';

/** With no Jester there, each request is answered here: an error a person can act on. */
function refuse(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message && (typeof message.id === 'string' || typeof message.id === 'number')) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: WHY } })}\n`);
}

function pass(line) {
  if (!line.trim()) return;
  if (up) socket.write(`${line}\n`);
  else if (socket) waiting += `${line}\n`;
  else refuse(line);
}

socket = net.connect(socketPath());
socket.setEncoding('utf8');
socket.on('connect', () => {
  up = true;
  if (waiting) socket.write(waiting);
  waiting = '';
});
socket.on('data', (chunk) => process.stdout.write(chunk));
const lost = () => {
  const queued = waiting;
  up = false;
  socket = null;
  waiting = '';
  for (const line of queued.split('\n')) if (line.trim()) refuse(line);
};
socket.on('error', lost);
socket.on('close', () => {
  const was = up;
  lost();
  // Jester quit, or closed his tools: the client starts this again when it wants them.
  if (was) process.exit(0);
});

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) pass(line);
});
// The client closed its end: that's how it says goodbye.
process.stdin.on('end', () => {
  socket?.end();
  process.exit(0);
});
