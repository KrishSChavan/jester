import test from 'node:test';
import assert from 'node:assert/strict';
import { abilitiesPart } from '../desktop/src/main/abilities.js';
import { createCloudLink, parseCloudLink } from '../desktop/src/main/cloud-link.js';
import { createRemoteHands, NO_MAC } from '../desktop/src/main/remote-hands.js';
import { createWebGateway } from '../desktop/src/main/web-gateway.js';

const KEY = 'cloud-hands-test-key-0123';
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A server (gateway + hands) and a Mac (cloud link), talking over a real socket. */
async function rig(t, mac = {}) {
  const asked = [];
  const told = [];
  const hands = createRemoteHands({ onAsk: (label) => asked.push(label), onTold: (text) => told.push(text) });
  const gateway = createWebGateway({
    key: KEY,
    port: 0,
    onMessage: async () => null,
    onStorage: async () => null,
    onConnect: (client) => client.role === 'mac' && hands.join(client),
    onClose: (client) => hands.leave(client),
    onOther: (client, frame) => hands.frame(client, frame)
  });
  const port = await gateway.ready;
  const state = { running: false, asking: false, abilities: { computer: 'Mac', chrome: true } };
  const did = [];
  const voice = [];
  const link = createCloudLink({
    link: parseCloudLink(`http://127.0.0.1:${port}/?key=${KEY}`),
    onVoice: (op) => voice.push(op),
    onPlay: () => undefined,
    handsState: () => state,
    idleSeconds: () => 42,
    onHands: async (frame) => {
      did.push(frame);
      if (mac[frame.op]) return mac[frame.op](frame);
      return null;
    }
  });
  t.after(() => {
    link.close();
    gateway.close();
  });
  await until(() => hands.connected);
  return { hands, gateway, link, state, did, voice, asked, told };
}

test('the link the server printed is the only kind taken', () => {
  const link = parseCloudLink('https://jester.tail1234.ts.net/?key=abcdefghijklmnopqrstuvwx');
  assert.equal(link.socket, 'wss://jester.tail1234.ts.net/socket');
  assert.equal(link.key, 'abcdefghijklmnopqrstuvwx');
  assert.equal(link.origin, 'https://jester.tail1234.ts.net');
  // No key, a short one, plain http to another machine (the key in the clear), or not a link.
  for (const bad of ['https://jester.tail1234.ts.net/', 'https://x.ts.net/?key=short', 'http://jester.tail1234.ts.net/?key=abcdefghijklmnopqrstuvwx', 'jester', '', 'ftp://x/?key=abcdefghijklmnopqrstuvwx']) assert.equal(parseCloudLink(bad), null, bad);
  assert.ok(parseCloudLink('http://127.0.0.1:8770/?key=abcdefghijklmnopqrstuvwx'));
});

test('with no Mac, nothing is known, a command says why, and a question is asked here', async () => {
  const asked = [];
  const hands = createRemoteHands({ onAsk: (label) => asked.push(label) });
  assert.equal(await hands.commands.knows('open safari'), false);
  assert.equal(await hands.commands.risky('delete it'), false);
  assert.deepEqual(await hands.commands.run('open safari'), { outcome: { ok: false, text: NO_MAC } });
  assert.equal(hands.abilities, null);
  assert.equal(hands.idleSeconds(), Infinity);
  const answer = hands.assistant.confirm('Run the lights script');
  assert.deepEqual(asked, ['Run the lights script']);
  assert.equal(hands.assistant.asking, true);
  hands.assistant.answer(true);
  assert.equal(await answer, true);
  assert.equal(hands.assistant.asking, false);
});

test('the server\'s conversation asks the Mac, and the Mac\'s answers come back', async (t) => {
  const { hands, did } = await rig(t, {
    knows: ({ text }) => text === 'open safari',
    run: ({ text }) => ({ outcome: { ok: true, text: `Did “${text}”`, sources: [{ url: 'https://example.com' }] } })
  });
  assert.equal(await hands.commands.knows('open safari'), true);
  assert.equal(await hands.commands.knows('fly to the moon'), false);
  const { outcome } = await hands.commands.run('open safari', 'open safari please', { meant: 'x' });
  assert.deepEqual(outcome, { ok: true, text: 'Did “open safari”', sources: [{ url: 'https://example.com' }] });
  const run = did.find((frame) => frame.op === 'run');
  assert.equal(run.said, 'open safari please');
  assert.deepEqual(run.context, { meant: 'x' });
});

test('what the Mac is doing and can do reaches the server as it changes', async (t) => {
  const { hands, state } = await rig(t);
  await until(() => hands.abilities?.chrome === true);
  assert.equal(hands.assistant.running, false);
  state.running = true;
  state.asking = true;
  state.abilities = { ...state.abilities, chrome: false };
  await until(() => hands.assistant.running && hands.assistant.asking && hands.abilities.chrome === false);
  await until(() => hands.idleSeconds() < 50);
});

test('the Mac\'s question is asked in the server\'s conversation; the answer goes back to the Mac', async (t) => {
  const { hands, link, did, asked } = await rig(t);
  link.ask('Send the email to Sam');
  await until(() => asked.length === 1);
  assert.equal(asked[0], 'Send the email to Sam');
  hands.assistant.answer(true);
  await until(() => did.some((frame) => frame.op === 'answer'));
  assert.equal(did.find((frame) => frame.op === 'answer').yes, true);
});

test('typed in the Mac\'s own window, it\'s said to him on the server', async (t) => {
  const { link, told } = await rig(t);
  assert.equal(link.told('  what time is it  '), true);
  await until(() => told.length === 1);
  assert.equal(told[0], 'what time is it');
});

test('the Mac claims him when it connects: the server opens its mic to listen', async (t) => {
  const { gateway, voice } = await rig(t);
  await until(() => gateway.voiceClient?.role === 'mac');
  gateway.openVoice();
  await until(() => voice.includes('open'));
  gateway.closeVoice();
  await until(() => voice.at(-1) === 'close');
});

test('a Mac that goes away leaves no hands, and a command waiting on it is told why', async (t) => {
  let release;
  const { hands, link } = await rig(t, { run: () => new Promise((resolve) => (release = resolve)) });
  const running = hands.commands.run('a long task');
  await until(() => release);
  link.close();
  assert.deepEqual(await running, { outcome: { ok: false, text: NO_MAC } });
  await until(() => !hands.connected);
  assert.equal(hands.abilities, null);
});

test('on a server with no Mac, he says he can\'t work a computer instead of claiming to', () => {
  const none = abilitiesPart({ computer: false });
  assert.doesNotMatch(none, /the laptop works any app/);
  assert.match(none, /Mac isn’t connected/);
  assert.match(abilitiesPart({ computer: 'Mac' }), /the laptop works any app/);
  assert.match(abilitiesPart({}), /the laptop works any app/, 'unchanged on the Mac itself');
});
