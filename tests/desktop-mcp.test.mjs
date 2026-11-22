/**
 * Jester's tools as an MCP server (2026-11-21): the protocol spoken by hand in both its eras, over a socket of the
 * user's own, through the bridge a client runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, LEGACY_VERSIONS, MODERN_VERSIONS } from '../desktop/src/main/mcp/server.js';
import { createMcpSocket, mcpSocketPath } from '../desktop/src/main/mcp/socket.js';
import { createTools } from '../desktop/src/main/mcp/tools.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/bin/jester-mcp.mjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'TestClient', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} };

/** A server over pretend hands, and a client's side of one connection: what it's sent back, parsed. */
function rig({ outcome = { ok: true, text: 'Playing Modern Family.' }, state = { computer: true, mac: true, web: true, notes: true }, hold = null } = {}) {
  const ran = [];
  const called = [];
  const tools = createTools({
    run: async (text, more) => {
      ran.push({ text, more });
      if (hold) await hold;
      return { outcome: typeof outcome === 'function' ? outcome(text) : outcome };
    },
    inquire: async () => 'Krish',
    recall: async () => ({ block: '[Notes/Lease.md: renews in June]' }),
    note: async ({ title, add }) => ({ ok: true, text: `Added “${add}” to ${title}.` }),
    remember: async () => ({ ok: true })
  });
  const server = createMcpServer({ tools, state: () => state, version: '0.1.0', onCall: (call) => called.push(call) });
  const got = [];
  const client = server.connect((line) => got.push(JSON.parse(line)));
  const ask = async (message) => {
    const before = got.length;
    await client.receive(JSON.stringify({ jsonrpc: '2.0', ...message }));
    await tick();
    return got[before];
  };
  return { server, client, got, ask, ran, called };
}

test('a client of today needs no handshake: it finds what’s here, lists the tools and calls one, each request on its own', async () => {
  const j = rig();
  const found = await j.ask({ id: 'd1', method: 'server/discover', params: { _meta: META } });
  assert.equal(found.result.resultType, 'complete');
  assert.deepEqual(found.result.supportedVersions, [...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
  assert.deepEqual(found.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(found.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'jester', title: 'Jester', version: '0.1.0' });
  assert.match(found.result.instructions, /send_message for a text/);
  const list = await j.ask({ id: 1, method: 'tools/list', params: { _meta: META } });
  assert.equal(list.result.resultType, 'complete');
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['ask_user', 'send_message', 'use_computer', 'use_browser', 'search_web', 'search_notes', 'write_note', 'remember', 'remember_choice', 'forget_choice'], 'the ones anyone may call: not his own list, nor "stay quiet"');
  const browser = list.result.tools.find((tool) => tool.name === 'use_browser');
  assert.deepEqual(browser.inputSchema.required, ['task']);
  assert.equal(browser.title, 'Work a website in Chrome');
  assert.equal('input_schema' in browser, false);
  const done = await j.ask({ id: 2, method: 'tools/call', params: { name: 'use_browser', arguments: { task: 'play Modern Family on Hulu' }, _meta: META } });
  assert.equal(done.result.resultType, 'complete');
  assert.equal(done.result.isError, false);
  assert.match(done.result.content[0].text, /^It worked\. Its report: “Playing Modern Family\.”/);
  assert.deepEqual(j.ran.map((run) => [run.text, run.more.where]), [['play Modern Family on Hulu', 'browser']]);
  assert.deepEqual(j.called, [{ name: 'use_browser', client: 'TestClient' }]);
  // A tool that failed says so in its result, for the model to act on; that's not the protocol failing.
  const failed = rig({ outcome: { ok: false, text: 'Hulu is showing two profiles.' } });
  const result = (await failed.ask({ id: 3, method: 'tools/call', params: { name: 'use_browser', arguments: { task: 'x' }, _meta: META } })).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^It didn’t work\. Its report: “Hulu is showing two profiles\.”/);
});

test('what can’t be answered is refused the way the protocol says', async () => {
  const j = rig();
  const old = await j.ask({ id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
  assert.deepEqual(old.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: '1900-01-01' } });
  const bare = await j.ask({ id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
  assert.equal(bare.error.code, -32602);
  assert.equal((await j.ask({ id: 3, method: 'tools/call', params: { name: 'format_disk', arguments: {}, _meta: META } })).error.code, -32602);
  assert.match((await j.ask({ id: 3, method: 'tools/call', params: { name: 'format_disk', arguments: {}, _meta: META } })).error.message, /^Unknown tool: format_disk/);
  assert.equal((await j.ask({ id: 4, method: 'sampling/createMessage', params: { _meta: META } })).error.code, -32601);
  assert.equal((await j.ask({ id: 5, method: 'server/discover', params: {} })).error.code, -32602);
  // His own tools aren't anyone else's to call, and one that isn't there to use isn't either.
  assert.equal((await j.ask({ id: 6, method: 'tools/call', params: { name: 'set_task', arguments: { op: 'timer', in: 5 }, _meta: META } })).error.code, -32602);
  const noWeb = rig({ state: { computer: true, mac: true } });
  assert.equal((await noWeb.ask({ id: 7, method: 'tools/call', params: { name: 'search_web', arguments: { question: 'x' }, _meta: META } })).error.code, -32602);
  // Bad input to a real tool is the tool's to say, so a model can put it right.
  const empty = await j.ask({ id: 8, method: 'tools/call', params: { name: 'use_browser', arguments: {}, _meta: META } });
  assert.equal(empty.result.isError, true);
  assert.match(empty.result.content[0].text, /“task” is needed|"task" is needed/);
  // Not JSON, not JSON-RPC, and a message with no id asks for no answer.
  j.got.length = 0;
  j.client.receive('{not json');
  j.client.receive(JSON.stringify({ id: 9, method: 'ping' }));
  j.client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await tick();
  assert.deepEqual(j.got.map((message) => message.error?.code), [-32700, -32600]);
});

test('a client of the handshake era is answered as it expects: initialize, then the rest with no metadata', async () => {
  const j = rig();
  const hello = await j.ask({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OlderClient', version: '2.0' } } });
  assert.equal(hello.result.protocolVersion, '2025-06-18');
  assert.deepEqual(hello.result.serverInfo, { name: 'jester', title: 'Jester', version: '0.1.0' });
  assert.deepEqual(hello.result.capabilities, { tools: { listChanged: false } });
  assert.equal('resultType' in hello.result, false);
  j.client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.deepEqual((await j.ask({ id: 1, method: 'ping' })).result, {});
  const list = await j.ask({ id: 2, method: 'tools/list' });
  assert.equal('resultType' in list.result, false);
  assert.equal(list.result.tools.length, 10);
  const done = await j.ask({ id: 3, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'lease' } } });
  assert.deepEqual(Object.keys(done.result).sort(), ['content', 'isError']);
  assert.match(done.result.content[0].text, /renews in June/);
  assert.deepEqual(j.called.at(-1), { name: 'search_notes', client: 'OlderClient' });
  // A version nobody speaks here gets the newest of its era that is.
  const other = rig();
  assert.equal((await other.ask({ id: 0, method: 'initialize', params: { protocolVersion: '2023-01-01', capabilities: {} } })).result.protocolVersion, LEGACY_VERSIONS[0]);
  // Lists a client may ask for, with nothing in them here.
  assert.deepEqual((await j.ask({ id: 4, method: 'resources/list' })).result, { resources: [] });
  assert.deepEqual((await j.ask({ id: 5, method: 'prompts/list' })).result, { prompts: [] });
});

test('a call that’s cancelled, or whose pipe closes, is stopped and nothing more is said of it', async () => {
  let release;
  const hold = new Promise((resolve) => (release = resolve));
  const j = rig({ hold });
  let stopped = null;
  const first = j.client.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'use_computer', arguments: { task: 'tidy my desktop' }, _meta: META } }));
  await tick();
  j.ran[0].more.signal.addEventListener('abort', () => (stopped = 'told to stop'));
  j.client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }));
  await first;
  release();
  await tick();
  assert.equal(stopped, 'told to stop');
  assert.deepEqual(j.got, [], 'no result for a call that was cancelled');
  // The pipe closing does the same for whatever's running.
  let again = null;
  const k = rig({ hold: new Promise(() => undefined) });
  k.client.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_computer', arguments: { task: 'x' }, _meta: META } }));
  await tick();
  k.ran[0].more.signal.addEventListener('abort', () => (again = 'stopped'));
  k.client.close();
  assert.equal(again, 'stopped');
});

test('over his own socket, through the bridge a client runs: the same answers; with no Jester there, the bridge says why', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-mcp-'));
  const file = mcpSocketPath(dir);
  const j = rig();
  const socket = createMcpSocket({ file, server: j.server });
  t.after(async () => {
    await socket.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await socket.start(), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the user’s own, and nobody else’s');
  /** The bridge, run as a client would run it: lines in, lines out. */
  const talk = (env, lines, expected) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => (child.kill(), reject(new Error(`the bridge said only: ${out}`))), 8000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const got = out.split('\n').filter(Boolean);
      if (got.length < expected) return;
      clearTimeout(timer);
      child.stdin.end();
      resolve(got.map((line) => JSON.parse(line)));
    });
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
  });
  const answers = await talk({ JESTER_MCP_SOCKET: file }, [
    { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_browser', arguments: { task: 'play Modern Family on Hulu' }, _meta: META } }
  ], 2);
  assert.deepEqual(answers.map((answer) => answer.id), ['d', 1]);
  assert.match(answers[1].result.content[0].text, /Playing Modern Family/);
  // Closed, a second Jester couldn't have opened it; and the bridge, finding nothing there, answers for itself.
  await socket.stop();
  assert.equal(fs.existsSync(file), false);
  const refused = await talk({ JESTER_MCP_SOCKET: file }, [{ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: META } }], 1);
  assert.equal(refused[0].id, 9);
  assert.match(refused[0].error.message, /Open Jester, and turn on “Let other apps use Jester’s tools”/);
  // A socket file left behind by a Jester that didn't close it is cleared, and his tools open again.
  fs.writeFileSync(file, '');
  assert.equal(await socket.start(), true);
});
