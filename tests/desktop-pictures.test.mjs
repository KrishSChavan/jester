import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsImages } from '../jester-extension/src/background/model-client.js';
import { createDesktopHost } from '../desktop/src/main/agent/host.js';
import { runDesktopAgent } from '../desktop/src/main/agent/loop.js';
import { chooseMarks, drawMarks, labelWidth, MAX_MARKS, pictureRefusal } from '../desktop/src/main/agent/marks.js';
import { ollamaModels } from '../desktop/src/main/conversation.js';
import { createModelJob } from '../desktop/src/main/model-jobs.js';
import { cropFor, createWindowShot, SHOT_MAX_WIDTH } from '../desktop/src/main/window-shot.js';

const box = (x, y, w = 40, h = 30) => ({ x, y, w, h });
const item = (id, role, label, at, extra = {}) => ({ element: { id, role, ...(label ? { label } : {}), ...extra }, box: at });

test('the unnamed controls get their numbers first, then what the goal names; words and headings get none', () => {
  const items = [
    item(0, 'heading', 'Now playing', box(10, 10, 200, 20)),
    item(1, 'text', 'Gunna', box(10, 40, 100, 20)),
    item(2, 'button', 'Shuffle', box(300, 300)),
    item(3, 'button', '', box(400, 300)),
    item(4, 'button', 'Play Gunna', box(500, 300)),
    item(5, 'button', 'Gone', box(2000, 300)),
    item(6, 'button', 'Tiny', box(600, 300, 2, 2)),
    item(7, 'link', 'No frame', null)
  ];
  const marks = chooseMarks(items, { width: 1000, height: 800, goal: 'play gunna', max: 2 });
  assert.deepEqual(marks.map((mark) => mark.id), [3, 4], 'the unnamed icon, then the goal’s control, shown in id order');
  assert.deepEqual(chooseMarks(items, { width: 1000, height: 800 }).map((mark) => mark.id), [2, 3, 4], 'off the picture, too small or with no frame: no number');
  assert.equal(MAX_MARKS, 60);
});

test('no number is drawn over another: a crowded control finds room beside it, or goes without', () => {
  // Three controls on top of each other: the second number goes above, the third inside the top right.
  const marks = chooseMarks([item(10, 'button', 'A', box(100, 100, 80, 40)), item(11, 'button', 'B', box(100, 100, 80, 40)), item(12, 'button', 'C', box(100, 100, 80, 40))], { width: 400, height: 400 });
  assert.equal(marks.length, 3);
  for (const [i, a] of marks.entries()) {
    for (const b of marks.slice(i + 1)) {
      const apart = a.label.x + a.label.w <= b.label.x || b.label.x + b.label.w <= a.label.x || a.label.y + a.label.h <= b.label.y || b.label.y + b.label.h <= a.label.y;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }
  }
  // A number at the picture's edge stays inside it.
  const [edge] = chooseMarks([item(123, 'button', 'Edge', box(395, 395, 5, 5))], { width: 400, height: 400 });
  assert.ok(!edge || (edge.label.x + edge.label.w <= 400 && edge.label.y + edge.label.h <= 400));
  assert.equal(labelWidth(7), 14);
  assert.equal(labelWidth(123), 38);
});

test('the numbers are painted black on yellow, with a yellow outline round each control', () => {
  const width = 60;
  const height = 40;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  const [mark] = chooseMarks([item(1, 'button', 'Go', box(10, 10, 40, 25))], { width, height });
  drawMarks(pixels, width, height, [mark]);
  const at = (x, y) => [...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  // BGRA: yellow is blue 0, green 212, red 255.
  assert.deepEqual(at(49, 30), [0, 212, 255, 255], 'the outline’s bottom right');
  assert.deepEqual(at(10, 10), [0, 0, 0, 255], 'the number’s box has a black edge');
  assert.deepEqual(at(11, 11), [0, 212, 255, 255], 'and a yellow inside');
  // "1" is drawn from the font: its top stroke is the third of five columns.
  assert.deepEqual(at(10 + 2 + 2 * 2, 10 + 2), [0, 0, 0, 255]);
  assert.deepEqual(at(30, 20), [255, 255, 255, 255], 'inside the control, the picture is left alone');
});

test('no picture with a password or card field on screen', () => {
  assert.match(pictureRefusal({ elements: [{ id: 0, role: 'password', label: 'Apple ID password' }] }), /password field/);
  assert.match(pictureRefusal({ elements: [{ id: 0, role: 'textfield', label: 'Card number' }] }), /card field/);
  assert.match(pictureRefusal({ elements: [{ id: 0, role: 'textfield', placeholder: 'CVC' }] }), /card field/);
  assert.equal(pictureRefusal({ elements: [{ id: 0, role: 'text', label: 'We take every credit card' }, { id: 1, role: 'button', label: 'Play' }] }), '');
});

test('the window is cut from its display’s capture in the capture’s own pixels', () => {
  // A Retina display at (0,0), 1512 by 982 points, captured at twice that.
  assert.deepEqual(cropFor({ x: 100, y: 50, w: 800, h: 600 }, { x: 0, y: 0, width: 1512, height: 982 }, { width: 3024, height: 1964 }), { x: 200, y: 100, width: 1600, height: 1200 });
  // A second display to the right: its own origin is taken off.
  assert.deepEqual(cropFor({ x: 1600, y: 0, w: 400, h: 300 }, { x: 1512, y: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }), { x: 88, y: 0, width: 400, height: 300 });
});

/** Electron's nativeImage, as far as the picture uses it. */
function fakeImage(width, height, log) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: (rect) => (log.push(['crop', rect]), fakeImage(rect.width, rect.height, log)),
    resize: ({ width: to }) => (log.push(['resize', to]), fakeImage(to, Math.round((height * to) / width), log)),
    toBitmap: () => Buffer.alloc(width * height * 4, 255)
  };
}

function shooter({ allowed = true, windows = [] } = {}) {
  const log = [];
  const shoot = createWindowShot({
    capturer: {
      getSources: async (options) => {
        log.push(['capture', options.types, options.thumbnailSize]);
        log.push(['hidden', windows.filter((win) => !win.shown).length]);
        return [
          { display_id: '1', thumbnail: fakeImage(3024, 1964, log) },
          { display_id: '2', thumbnail: fakeImage(1920, 1080, log) }
        ];
      }
    },
    screen: { getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, size: { width: 1512, height: 982 }, scaleFactor: 2 }) },
    images: {
      createFromBitmap: (bitmap, size) => {
        log.push(['bitmap', size, bitmap.length]);
        return { toJPEG: (quality) => (log.push(['jpeg', quality]), Buffer.from('jpeg bytes')) };
      }
    },
    allowed: () => allowed,
    ownWindows: () => windows,
    wait: async () => undefined
  });
  return { shoot, log };
}
const ownWindow = (bounds) => ({ shown: true, bounds, isDestroyed: () => false, isVisible() { return this.shown; }, getBounds() { return this.bounds; }, hide() { this.shown = false; }, showInactive() { this.shown = true; } });

const SPOTIFY = {
  snapshot: 7,
  app: { name: 'Spotify', pid: 42 },
  window: { title: 'Spotify Premium', frame: { x: 0, y: 0, w: 1512, h: 982 } },
  elements: [
    { id: 0, role: 'searchfield', label: 'What do you want to play?', frame: { x: 300, y: 20, w: 300, h: 30 } },
    { id: 1, role: 'text', label: 'Top result', frame: { x: 300, y: 100, w: 100, h: 20 } },
    { id: 2, role: 'button', frame: { x: 700, y: 900, w: 32, h: 32 } }
  ]
};

test('a picture of the window: Jester’s windows over it step aside, the display is cut to it, no wider than a model needs', async () => {
  const pill = ownWindow({ x: 600, y: 900, width: 300, height: 60 });
  const elsewhere = ownWindow({ x: 3000, y: 0, width: 300, height: 60 });
  const { shoot, log } = shooter({ windows: [pill, elsewhere] });
  const shot = await shoot(SPOTIFY, { goal: 'play' });
  assert.equal(shot.ok, true);
  assert.deepEqual(shot.image, { mimeType: 'image/jpeg', data: Buffer.from('jpeg bytes').toString('base64') });
  assert.deepEqual(log.slice(0, 2), [['capture', ['screen'], { width: 3024, height: 1964 }], ['hidden', 1]], 'only the window over it was hidden');
  assert.ok(pill.shown, 'and it came back');
  assert.deepEqual(log[2], ['crop', { x: 0, y: 0, width: 3024, height: 1964 }]);
  assert.deepEqual(log[3], ['resize', SHOT_MAX_WIDTH]);
  assert.deepEqual([shot.width, shot.height], [1280, 831]);
  assert.deepEqual(shot.marked, [0, 2], 'the controls are numbered by their own ids; the words aren’t');
  assert.deepEqual(log.at(-1), ['jpeg', 75]);
});

test('no picture is taken without the OS’s leave, or of a window with no place on screen', async () => {
  const { shoot, log } = shooter({ allowed: false });
  assert.equal((await shoot(SPOTIFY)).ok, false);
  assert.equal((await shooter().shoot({ ...SPOTIFY, window: { title: 'Nowhere' } })).ok, false);
  assert.deepEqual(log, [], 'macOS’s prompt never comes up mid-task');
});

/** A driver whose every read is a new snapshot. */
function readingDriver(screen) {
  let reads = 0;
  return { call: async (cmd) => (cmd === 'snapshot' ? { ...screen, snapshot: (reads += 1) + 100 } : {}) };
}
const hostWith = (screen, picture) =>
  createDesktopHost({ driver: readingDriver(screen), activate: async () => undefined, openApp: async () => ({ ok: true }), openUrl: async () => undefined, dispatch: async () => ({ ok: true }), picture, wait: async () => undefined });

test('the host takes the picture from a fresh read, and that read is the next step’s screen', async () => {
  const asked = [];
  const picture = Object.assign(async (snapshot, options) => (asked.push([snapshot.snapshot, options.goal]), { ok: true, image: { mimeType: 'image/jpeg', data: 'x' }, marked: [2] }), { allowed: () => true });
  const host = hostWith(SPOTIFY, picture);
  assert.equal(host.canPicture(), true);
  const result = await host.execute({ action: 'screenshot' }, SPOTIFY, { goal: 'play Gunna' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.snapshot, 101);
  assert.deepEqual(asked, [[101, 'play Gunna']]);
  assert.deepEqual(result.marked, [2]);
  assert.match(result.detail, /1 control numbered/);

  const locked = hostWith({ ...SPOTIFY, elements: [...SPOTIFY.elements, { id: 3, role: 'password', label: 'Password' }] }, picture);
  const refused = await locked.execute({ action: 'screenshot' }, SPOTIFY);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /password field/);
  assert.equal(refused.snapshot.snapshot, 101, 'the fresh read still replaces the stale one');
  assert.equal(asked.length, 1, 'no picture was taken');

  assert.equal(hostWith(SPOTIFY, Object.assign(async () => ({ ok: true }), { allowed: () => false })).canPicture(), false);
  assert.equal(hostWith(SPOTIFY, null).canPicture(), false);
});

/** A model that answers from a script, and remembers what it was sent. */
function scripted(...replies) {
  const calls = [];
  const model = async ({ system, prompt, images }) => {
    calls.push({ system, prompt: JSON.parse(prompt), images });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { json: next };
  };
  return { model, calls };
}
const FRESH = { ...SPOTIFY, snapshot: 8, elements: [...SPOTIFY.elements, { id: 3, role: 'button', label: 'Like', frame: { x: 760, y: 900, w: 32, h: 32 } }] };
const IMAGE = { mimeType: 'image/jpeg', data: 'cGljdHVyZQ==' };
/** A host whose pictures come from fresh reads: with `changing`, each read shows a new song. */
function pictureHost({ changing = false } = {}) {
  const done = [];
  let pictures = 0;
  const fresh = () => (changing ? { ...FRESH, elements: [...FRESH.elements, { id: 4, role: 'text', label: `Song ${pictures}` }] } : FRESH);
  return {
    done,
    host: {
      observe: async () => ({ ok: true, snapshot: SPOTIFY }),
      execute: async (action, snapshot) => {
        done.push([action.action, snapshot.snapshot]);
        if (action.action !== 'screenshot') return { ok: true };
        pictures += 1;
        return { ok: true, detail: 'a picture', image: IMAGE, marked: [2, 3], snapshot: fresh() };
      }
    }
  };
}

test('the model is offered a picture only when one can be taken and read, and it goes with the next step only', async () => {
  const { model, calls } = scripted({ action: { action: 'screenshot' } }, { action: { action: 'click', id: 3 } }, { action: { action: 'finish', say: 'Liked.', success: true } });
  const { host, done } = pictureHost();
  const result = await runDesktopAgent({ goal: 'like this song', host, model, confirm: async () => true, platform: 'darwin', see: true });
  assert.equal(result.ok, true);
  assert.match(calls[0].system, /screenshot: only when the screen lines aren't enough/);
  assert.equal(calls[0].images, undefined);
  assert.deepEqual(calls[1].images, [IMAGE], 'the picture goes with the step after it');
  assert.match(calls[1].prompt.picture, /yellow box is the id of the control/);
  assert.match(calls[1].prompt.screen, /\[3\] button "Like"/, 'and the screen is the read its numbers are from');
  assert.equal(calls[2].images, undefined, 'then it’s dropped');
  assert.deepEqual(done, [['screenshot', 7], ['click', 8]]);

  const blind = scripted({ action: { action: 'screenshot' } }, { action: { action: 'finish', say: 'Can’t tell.', success: false } });
  const plain = pictureHost();
  await runDesktopAgent({ goal: 'like this song', host: plain.host, model: blind.model, confirm: async () => true, platform: 'darwin' });
  assert.doesNotMatch(blind.calls[0].system, /screenshot/);
  assert.deepEqual(plain.done, [], 'nothing was asked of the host');
  assert.match(blind.calls[1].prompt.lastResult.detail, /aren’t available/);
});

test('three pictures a task at most; one sent with a reply that couldn’t be read goes again', async () => {
  const notJson = Object.assign(new Error('The model did not return valid JSON.'), { code: 'invalid_json' });
  const { model, calls } = scripted(
    { action: { action: 'screenshot' } },
    notJson,
    { action: { action: 'screenshot' } },
    { action: { action: 'screenshot' } },
    { action: { action: 'screenshot' } },
    { action: { action: 'finish', say: 'Done looking.', success: false } }
  );
  // The same picture of the same screen a third time is the repeat guard's to stop: these differ.
  const { host, done } = pictureHost({ changing: true });
  await runDesktopAgent({ goal: 'like this song', host, model, confirm: async () => true, platform: 'darwin', see: true, limits: { maxActions: 30, maxModelCalls: 16, runBudgetMs: 60000, failures: 3, invalidReplies: 2, invalidTotal: 3, idleSteps: 9, stepCalls: 6, replans: 2, pictures: 3 } });
  assert.deepEqual(calls[2].images, [IMAGE], 'the retry carries the unused picture');
  assert.match(calls[2].prompt.screen, /\[3\] button "Like"/, 'on the same read');
  assert.equal(done.filter(([action]) => action === 'screenshot').length, 3);
  assert.match(calls[5].prompt.lastResult.detail, /had its 3 pictures/);
});

const connection = (overrides) => ({ id: 'groq-1', provider: 'groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: 'k', plan: 'paid', uses: ['act'], cooldownUntil: 0, ...overrides });
function actions({ models = [], local = { model: 'qwen3.5:9b', uses: ['act'], vision: true } } = {}) {
  const asked = [];
  const ask = createModelJob({
    job: 'act',
    saved: async () => models,
    local: async () => local,
    keepAlive: '2m',
    markLimited: async () => undefined,
    request: async (options) => (asked.push(`${options.config.provider} ${options.config.model}`), { json: {} })
  });
  return { ask, asked };
}

test('a picture goes only to a model that reads pictures: a saved one, else this computer’s', async () => {
  const text = connection();
  const gemini = connection({ id: 'gemini', provider: 'google', protocol: 'gemini', model: 'gemini-2.5-flash' });
  const both = actions({ models: [text, gemini] });
  await both.ask({ system: 'S', prompt: 'p', images: [IMAGE] });
  await both.ask({ system: 'S', prompt: 'p' });
  assert.deepEqual(both.asked, ['google gemini-2.5-flash', 'groq llama-3.3-70b-versatile']);
  assert.equal(await both.ask.canSee(), true);

  const local = actions({ models: [text] });
  await local.ask({ system: 'S', prompt: 'p', images: [IMAGE] });
  assert.deepEqual(local.asked, ['ollama qwen3.5:9b'], 'Ollama said it reads pictures');

  const none = actions({ models: [text], local: { model: 'qwen3.5:9b', uses: ['act'], vision: false } });
  assert.equal(await none.ask.canSee(), false);
  await assert.rejects(none.ask({ system: 'S', prompt: 'p', images: [IMAGE] }), (err) => err.code === 'no_vision_model');
  assert.deepEqual(none.asked, []);
});

test('a model that says whether it reads pictures is taken at its word', () => {
  assert.equal(supportsImages({ provider: 'ollama', model: 'qwen3.5:9b' }), false, 'by name alone, it isn’t known to');
  assert.equal(supportsImages({ provider: 'ollama', model: 'qwen3.5:9b', vision: true }), true);
  assert.equal(supportsImages({ provider: 'ollama', model: 'llava:7b', vision: false }), false);
  assert.equal(supportsImages({ provider: 'google', model: 'gemini-2.5-flash' }), true);
});

test('Ollama’s list says which of its models read pictures', async () => {
  const reply = { models: [{ name: 'qwen3.5:9b', size: 6, capabilities: ['completion', 'vision'] }, { name: 'llama3.2:3b', size: 2, capabilities: ['completion'] }, { name: 'old:1b', size: 1 }, { name: 'nomic-embed', size: 1, capabilities: ['embedding'] }] };
  const listed = await ollamaModels(async () => ({ json: async () => reply }));
  assert.deepEqual(listed, { running: true, models: [{ name: 'qwen3.5:9b', size: 6, vision: true }, { name: 'llama3.2:3b', size: 2, vision: false }, { name: 'old:1b', size: 1 }] });
});
