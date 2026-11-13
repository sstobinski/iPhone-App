import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatterRegions, platterPresentation, readPlatterRegions } from '../src/platter-layout.mjs';
import { paintPresentation } from '../web/frame-stats.js';
const waveform = { x: .43, y: .08, width: .14, height: .6 };
const rectangles = [{ x: .18, y: .2, width: .2, height: 1 / 3 }, { x: .62, y: .2, width: .2, height: 1 / 3 }];
function scene(empty = false, squares = false, centers = [190, 450]) {
  const width = 640, height = 380, data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([40, 40, 40, 255], i);
  for (const [cx, color] of [[centers[0], [245, 100, 180]], [centers[1], [150, 140, 245]]]) {
    for (let y = 75; y <= 155; y++) for (let x = cx - 40; x <= cx + 40; x++) {
      const r = Math.hypot(x - cx, y - 115); if (!squares && r > 40) continue;
      const value = empty || !squares && r > 34 ? [18, 18, 18] : color;
      data.set([...value, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
test('paired round faces are found for colored and empty decks; square pads are rejected', () => {
  for (const empty of [false, true]) {
    const result = detectPlatterRegions(scene(empty), waveform);
    assert.equal(result?.length, 2); assert.ok(result[0].x < .4 && result[1].x > .6);
    assert.ok(platterPresentation(waveform, result));
  }
  assert.equal(detectPlatterRegions(scene(false, true), waveform), null);
});
test('missing or one-sided platter evidence cannot produce a false two-deck layout', () => {
  const image = scene();
  for (let y = 0; y < image.height; y++) for (let x = image.width / 2; x < image.width; x++) image.data.set([40, 40, 40, 255], (y * image.width + x) * 4);
  assert.equal(detectPlatterRegions(image, waveform), null);
  assert.equal(detectPlatterRegions({ ...image, data: new Uint8Array(4) }, waveform), null);
});
test('the approved union contains only the three selected regions and uses relative coordinates', () => {
  const plan = platterPresentation(waveform, rectangles);
  assert.ok(plan); assert.ok(plan.capture.x > 0 && plan.capture.y > 0);
  for (const r of [plan.presentation.waveform, ...plan.presentation.platters]) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);
  }
  assert.equal(platterPresentation(waveform, rectangles.slice().reverse()), null);
  assert.equal(platterPresentation({ x: 0, y: 0, width: 1, height: 1 }, rectangles), null);
  assert.equal(readPlatterRegions([{ ...rectangles[0], x: -1 }, rectangles[1]]), null);
});
test('all displayed regions come from the same bitmap and retain their backing-pixel dimensions', () => {
  const bitmap = {}, calls = [];
  const target = () => ({ canvas: { width: 0, height: 0 }, context: { drawImage(...args) { calls.push(args); } } });
  const wave = target(), platters = [target(), target()];
  const plan = platterPresentation(waveform, rectangles);
  assert.equal(paintPresentation(wave.canvas, wave.context, platters, bitmap, { width: 1280, height: 720 }, plan.presentation), true);
  assert.equal(calls.length, 3); assert.ok(calls.every(args => args[0] === bitmap && args.length === 9));
  assert.ok(wave.canvas.width < 1280 && platters[0].canvas.width < 1280);
  assert.throws(() => paintPresentation(wave.canvas, wave.context, platters, bitmap, { width: 1280, height: 720 }, { ...plan.presentation, platters: [] }));
});

test('the horizontal center-wave arrangement locates both outer platter faces', () => {
  const image = scene(false, false, [160, 480]);
  const result = detectPlatterRegions(image, { x: .33, y: .08, width: .34, height: .6 });
  assert.equal(result?.length, 2);
  assert.ok(result[0].x + result[0].width < .33 && result[1].x > .67);
});

test('an invalid subimage cannot partially replace the last complete presentation', () => {
  const draws = [], target = () => ({ canvas: { width: 100, height: 100 }, context: { drawImage() { draws.push(1); } } });
  const wave = target(), platters = [target(), target()];
  const presentation = { kind: 'platters-and-waveforms', waveform: { x: 0, y: 0, width: 1, height: 1 },
    platters: [{ x: 0, y: 0, width: .5, height: .5 }, { x: 0, y: 0, width: .00001, height: .00001 }] };
  assert.throws(() => paintPresentation(wave.canvas, wave.context, platters, {}, { width: 100, height: 100 }, presentation));
  assert.equal(draws.length, 0);
});
