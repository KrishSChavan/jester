/**
 * His pill on the Mac, with his brain on a server (2026-11-22, the user: "when the on laptop app is not open (talk to
 * jester window not open/in view) the pill should be shown"). Before, the conversation's frames went only to the pages
 * showing its chat, so with his window closed the Mac showed nothing while he listened, thought and spoke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCloudLink, parseCloudLink } from '../desktop/src/main/cloud-link.js';
import { createWebGateway } from '../desktop/src/main/web-gateway.js';

const KEY = 'cloud-pill-test-key-0123456';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
};

test('a frame for one client reaches that Mac, over the real socket, as one more frame for it to take', async (t) => {
  const gateway = createWebGateway({ key: KEY, port: 0, onMessage: async () => null, onStorage: async () => null });
  const port = await gateway.ready;
  const frames = [];
  const link = createCloudLink({
    link: parseCloudLink(`http://127.0.0.1:${port}/?key=${KEY}`),
    onVoice: () => undefined,
    onPlay: () => undefined,
    onHands: async () => null,
    handsState: () => ({ running: false, asking: false, abilities: {} }),
    idleSeconds: () => 0,
    onFrame: (frame) => frames.push(frame)
  });
  t.after(() => {
    link.close();
    gateway.close();
  });
  link.claim();
  await until(() => gateway.voiceClient?.role === 'mac');
  gateway.tell(gateway.voiceClient, { t: 'pill', voice: { phase: 'thinking' } });
  gateway.tell(gateway.voiceClient, { t: 'pill', voice: { phase: 'speaking', done: true } });
  await until(() => frames.length === 2);
  assert.deepEqual(frames.map((frame) => [frame.t, frame.voice.phase]), [['pill', 'thinking'], ['pill', 'speaking']]);
  // Gone: nothing is sent, and nothing throws.
  const gone = gateway.voiceClient;
  link.close();
  await until(() => !gateway.voiceClient);
  assert.doesNotThrow(() => gateway.tell(gone, { t: 'pill', voice: { phase: 'thinking' } }));
});

test('the server sends the conversation to the Mac being talked through, and the Mac shows it unless his window’s in front', () => {
  const main = fs.readFileSync(new URL('../desktop/src/main/main.js', import.meta.url), 'utf8');
  // The chat these frames are of is the Mac's own: talked through it.
  assert.match(main, /const talked = webGateway\?\.voiceClient;\n\s+if \(talked\?\.role === 'mac' && viewingOf\(talked\) === key\) webGateway\.tell\(talked, \{ t: 'pill', voice: message\.voice \}\);/);
  // On the Mac: its pill, unless the server's page is in front of the user, where the orb shows it; endings always.
  assert.match(main, /if \(frame\?\.t === 'pill'\) return showCloudPill\(frame\.voice\);/);
  assert.match(main, /if \(cloudWindow\(\) && !ending\) return;/);
  const windows = fs.readFileSync(new URL('../desktop/src/main/windows.js', import.meta.url), 'utf8');
  assert.match(windows, /export function cloudWindow\(\) \{\n\s+return cloud && !cloud\.isDestroyed\(\) && cloud\.isVisible\(\) && !cloud\.isMinimized\(\) && cloud\.isFocused\(\) \? cloud : null;/);
});
