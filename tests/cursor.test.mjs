import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../jester-extension/src/content/content.js', import.meta.url), 'utf8');
// Execute the production geometry block with browser measurements supplied by
// each scenario. It intentionally stays inside the content script's closure.
const start = source.indexOf('  let pageZoom = 1;');
const end = source.indexOf('  /** Whether the pointer may put its own notices', start);
assert.ok(start > 0 && end > start);
function mapping({ window: overrides = {}, screen: display = {}, fullscreen = false, zoom = 1 } = {}) {
  const sandbox = {
    navigator: { platform: 'MacIntel' },
    document: { fullscreenElement: fullscreen ? {} : null, addEventListener() {} },
    window: {
      screenX: 100, screenY: 40, outerWidth: 1280, outerHeight: 900,
      innerWidth: 1264, innerHeight: 760, ...overrides
    },
    screen: { width: 1920, height: 1080, isExtended: false, availLeft: 0, availTop: 23, ...display },
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)), zoom
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + '\npageZoom = zoom; globalThis.geometry = { screenToPage, pageOrigin, displayOrigin, noteMouse };', sandbox);
  return sandbox;
}
const point = (value) => value && { x: value.x, y: value.y };

test('windowed screen coordinates account for toolbar and window position', () => {
  const { geometry } = mapping();
  assert.deepEqual(point(geometry.screenToPage({ x: .5, y: .5 }, true)), { x: 852, y: 368 });
});

test('fullscreen mapping honors browser zoom', () => {
  const { geometry } = mapping({ fullscreen: true, zoom: 2, window: { innerWidth: 960, innerHeight: 540 } });
  assert.deepEqual(point(geometry.screenToPage({ x: .5, y: .5 }, true)), { x: 480, y: 270 });
});

test('ambiguous panels refuse eye placement while head steering can use a measured guess', () => {
  const { geometry } = mapping({ window: { innerWidth: 900 } });
  assert.equal(geometry.screenToPage({ x: .5, y: .5 }, true), null);
  assert.deepEqual(point(geometry.screenToPage({ x: .5, y: .5 }, false)), { x: 860, y: 360 });
});

test('a trusted mouse reading resolves panel placement, synthetic readings cannot change it', () => {
  const { geometry, window } = mapping({ window: { innerWidth: 900 } });
  geometry.noteMouse({ isTrusted: false, screenX: 400, screenY: 300, clientX: 50, clientY: 50 });
  assert.equal(geometry.screenToPage({ x: .5, y: .5 }, true), null);
  geometry.noteMouse({ isTrusted: true, screenX: 400, screenY: 300, clientX: 50, clientY: 50 });
  assert.deepEqual(point(geometry.screenToPage({ x: .5, y: .5 }, true)), { x: 610, y: 290 });
  window.screenX += 30;
  assert.deepEqual(point(geometry.screenToPage({ x: .5, y: .5 }, true)), { x: 580, y: 290 });
});

test('extended displays apply the calibration menu-bar offset', () => {
  const { geometry } = mapping({
    window: { screenX: 1920, screenY: 23, outerWidth: 1920, outerHeight: 1057, innerWidth: 1920, innerHeight: 969 },
    screen: { isExtended: true, availLeft: 1920, availTop: 23 }
  });
  const cursor = { x: .5, y: .5, display: { insetX: 0, insetY: 23 } };
  assert.deepEqual(point(geometry.screenToPage(cursor, true)), { x: 960, y: 429 });
});
