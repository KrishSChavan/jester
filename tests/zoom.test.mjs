import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACE_CROP_SPANS,
  PERSON_LOST_MS,
  SEARCH_FRAMES,
  faceCropFor,
  fromCrop,
  handCropFor,
  makeZoom,
  personFromFace,
  searchPlan,
  squareCrop
} from '../jester-extension/src/offscreen/zoom.js';

const W = 1920;
const H = 1080;

/** A face's 478 landmarks, all at the eyes' midpoint except the four eye corners that set the spacing. */
function face(cx, cy, span) {
  const p = Array.from({ length: 478 }, () => ({ x: cx / W, y: cy / H, z: 0 }));
  const put = (i, x, y) => (p[i] = { x: x / W, y: y / H, z: 0 });
  // The subject's right eye is on the picture's left.
  put(33, cx - span / 2 - 10, cy);
  put(133, cx - span / 2 + 10, cy);
  put(362, cx + span / 2 - 10, cy);
  put(263, cx + span / 2 + 10, cy);
  return p;
}

/** A hand's 21 landmarks with the wrist at (x, y) px and the palm `palm` px tall. */
function hand(x, y, palm) {
  const p = Array.from({ length: 21 }, () => ({ x: x / W, y: y / H, z: 0 }));
  p[9] = { x: x / W, y: (y - palm) / H, z: 0 };
  return p;
}

test('a crop is a square inside the frame, or the whole frame when it would be most of it', () => {
  assert.deepEqual(squareCrop(960, 540, 400, W, H), { x: 760, y: 340, w: 400, h: 400 });
  // Slid back inside at the corners.
  assert.deepEqual(squareCrop(10, 10, 400, W, H), { x: 0, y: 0, w: 400, h: 400 });
  assert.deepEqual(squareCrop(1915, 1075, 400, W, H), { x: 1520, y: 680, w: 400, h: 400 });
  assert.equal(squareCrop(960, 540, 1000, W, H), null);
  // Never smaller than the floor.
  assert.equal(squareCrop(960, 540, 20, W, H).w, 160);
});

test('points map from a crop back to the whole frame, z included', () => {
  const crop = { x: 760, y: 340, w: 400, h: 400 };
  const p = fromCrop({ x: 0.5, y: 0.25, z: -0.1 }, crop, W, H);
  assert.ok(Math.abs(p.x - 960 / W) < 1e-12);
  assert.ok(Math.abs(p.y - 440 / H) < 1e-12);
  assert.ok(Math.abs(p.z - (-0.1 * 400) / W) < 1e-12);
  assert.equal(fromCrop({ x: 0.3, y: 0.4 }, null, W, H).x, 0.3);
});

test('up close the whole frame is used; across a room the crops zoom in on the person', () => {
  const near = personFromFace(face(960, 400, 130), W, H);
  assert.ok(Math.abs(near.span - 130) < 1e-9);
  assert.equal(faceCropFor(near, W, H), null);
  // At a desk the hands' view is all but the whole frame: its full height, most of its width.
  const deskHands = handCropFor(near, W, H);
  assert.ok(deskHands === null || (deskHands.h === H && deskHands.w >= 0.85 * W), JSON.stringify(deskHands));
  // Closer still, the whole frame.
  assert.equal(handCropFor(personFromFace(face(960, 400, 150), W, H), W, H), null);

  const far = personFromFace(face(1000, 450, 25), W, H);
  const fc = faceCropFor(far, W, H);
  const hc = handCropFor(far, W, H);
  assert.equal(fc.w, FACE_CROP_SPANS * 25);
  assert.ok(hc.w > fc.w, 'the hands get the wider view');
  // Both contain the eyes.
  for (const c of [fc, hc]) assert.ok(c.x < 1000 && c.x + c.w > 1000 && c.y < 450 && c.y + c.h > 450);
});

test('between the whole frame and a crop there is a margin either way, set by what the detector finds', () => {
  // Measured with the bundled model on a 1080p frame: the whole frame finds a
  // face from scratch only with its eyes 86 px apart or more.
  const at = (span) => personFromFace(face(960, 420, span), W, H);
  const someCrop = { x: 0, y: 0, w: 900, h: 900 };
  // From the whole frame, a face goes to a crop only below 81 px...
  assert.equal(faceCropFor(at(85), W, H, null), null);
  assert.ok(faceCropFor(at(79), W, H, null));
  // ...and from a crop back to the whole frame only from about 92 px, square and as tall as the frame meanwhile.
  const kept = faceCropFor(at(88), W, H, someCrop);
  assert.ok(kept && kept.w === kept.h && kept.h === Math.round(12 * 88), JSON.stringify(kept));
  const tallest = faceCropFor(at(91), W, H, someCrop);
  assert.ok(tallest && tallest.w === H && tallest.h === H, JSON.stringify(tallest));
  assert.equal(faceCropFor(at(93), W, H, someCrop), null);
  // The hands' view the same way round its own line (13 spacings against 95% of the width).
  assert.equal(handCropFor(at(135), W, H, null), null);
  assert.ok(handCropFor(at(135), W, H, someCrop));
  assert.equal(handCropFor(at(141), W, H, someCrop), null);

  // A face the search finds in a crop, inside that margin, stays in one: the
  // whole frame couldn't find it again.
  const zoom = makeZoom({ width: W, height: H });
  let t = 0;
  for (let i = 0; i < 40; i += 1) {
    t += 50;
    const c = zoom.crops(t);
    if (c.face) {
      zoom.observe(t, { facePoints: face(960, 420, 84) });
      break;
    }
    zoom.observe(t, {});
  }
  assert.ok(zoom.crops(t + 50).face, 'still zoomed in on the face');
  // Seen across the room the whole time with jitter, it never flips.
  let flips = 0;
  let last = JSON.stringify(zoom.crops(t).face);
  for (let i = 0; i < 300; i += 1) {
    t += 50;
    const now = JSON.stringify(zoom.crops(t).face);
    if (now !== last) flips += 1;
    last = now;
    if (i % 3 === 0) zoom.observe(t, { facePoints: face(960, 420, 84 + (i % 7) * 0.2 - 0.6) });
  }
  assert.equal(flips, 0);
});

test('the search starts with the whole frame and then zooms into the middle', () => {
  const plan = searchPlan(W, H);
  assert.equal(plan[0], null);
  assert.ok(plan.length >= 4);
  for (const crop of plan.slice(1)) assert.ok(crop.w < H && crop.x >= 0 && crop.x + crop.w <= W);
});

test('the zoom searches when nobody is seen, then follows the person with slack', () => {
  const zoom = makeZoom({ width: W, height: H });
  let now = 0;
  // Nobody yet: searching, one place for SEARCH_FRAMES frames, then the next.
  const first = zoom.crops((now += 50));
  assert.equal(first.searching, true);
  assert.equal(first.face, null);
  for (let i = 1; i < SEARCH_FRAMES; i += 1) zoom.crops((now += 50));
  const second = zoom.crops((now += 50));
  assert.notEqual(second.face, null);

  // Found, far away: crops around the person.
  zoom.observe(now, { facePoints: face(1000, 450, 25) });
  const tracked = zoom.crops((now += 50));
  assert.equal(tracked.searching, false);
  assert.ok(tracked.face && tracked.hands);

  // A small shift keeps the crops exactly where they were.
  zoom.observe(now, { facePoints: face(1006, 452, 25.5) });
  const still = zoom.crops((now += 50));
  assert.deepEqual(still.face, tracked.face);

  // A real move takes them along.
  zoom.observe(now, { facePoints: face(1300, 450, 25) });
  const moved = zoom.crops((now += 50));
  assert.notDeepEqual(moved.face, tracked.face);

  // Held, nothing moves however far the person goes.
  zoom.hold(true);
  zoom.observe(now, { facePoints: face(600, 450, 25) });
  assert.deepEqual(zoom.crops((now += 50)).face, moved.face);
  zoom.hold(false);

  // Lost for long enough: back to searching.
  now += PERSON_LOST_MS + 100;
  assert.equal(zoom.crops(now).searching, true);
});

test('a hand resting in view never stops the search for a face (measured: it parked the crops on a lap)', () => {
  const zoom = makeZoom({ width: W, height: H });
  let now = 0;
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const c = zoom.crops((now += 50));
    assert.equal(c.searching, true);
    seen.add(JSON.stringify(c.face));
    zoom.observe(now, { handLandmarks: [hand(980, 590, 12)] });
  }
  assert.ok(seen.size >= 5, 'the search moved on through its plan');
});

test('a hand raised across a recently seen face keeps that face’s crops alive', () => {
  const zoom = makeZoom({ width: W, height: H });
  let now = 0;
  zoom.observe((now += 50), { facePoints: face(1000, 450, 25) });
  const before = zoom.crops((now += 50));
  // No face for a second, but a hand right beside where it was.
  for (let i = 0; i < 20; i += 1) zoom.observe((now += 50), { handLandmarks: [hand(1040, 520, 37)] });
  const after = zoom.crops((now += 50));
  assert.equal(after.searching, false);
  assert.deepEqual(after.face, before.face);
});

test('while the face is being searched for, the hands stay where an active hand was seen', () => {
  const zoom = makeZoom({ width: W, height: H });
  let now = 0;
  const first = zoom.crops((now += 50));
  for (let i = 0; i < SEARCH_FRAMES * 2; i += 1) zoom.crops((now += 50));
  const place = zoom.crops((now += 50));
  zoom.observe(now, { handLandmarks: [hand(980, 590, 40)], handsActive: true, handCrop: place.hands });
  for (let i = 0; i < 12; i += 1) {
    const c = zoom.crops((now += 50));
    assert.equal(c.searching, true);
    assert.deepEqual(c.hands, place.hands, 'the hands stay put');
    zoom.observe(now, { handLandmarks: [hand(980, 590, 40)], handsActive: true, handCrop: c.hands });
  }
  // A resting hand ("None") doesn't lock anything.
  const z2 = makeZoom({ width: W, height: H });
  z2.crops(0);
  z2.observe(0, { handLandmarks: [hand(980, 590, 40)], handsActive: false, handCrop: first.hands });
  let moved = false;
  for (let i = 1; i < 12; i += 1) moved ||= JSON.stringify(z2.crops(i * 50).hands) !== JSON.stringify(first.hands);
  assert.ok(moved);
});

test('a hand resting well below a lost face does not keep it "seen" (measured: the search never began)', () => {
  const zoom = makeZoom({ width: W, height: H });
  let now = 0;
  zoom.observe((now += 50), { facePoints: face(960, 400, 110) });
  // The person moved off; only a hand in their lap, eight spacings below, remains.
  for (let i = 0; i < 50; i += 1) zoom.observe((now += 50), { handLandmarks: [hand(960, 400 + 8 * 110, 120)] });
  assert.equal(zoom.crops((now += 50)).searching, true);
});
