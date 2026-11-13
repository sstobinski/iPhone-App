import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWaveformRegion } from '../src/layout-detector.mjs';
import jpeg from '../vendor/jpeg-js/index.js';
import { readPreviousRegion } from '../src/region-context.mjs';

function screen(width = 1280, height = 900) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 28; data[i + 1] = 29; data[i + 2] = 31; data[i + 3] = 255; }
  return { width, height, data };
}
function rect(image, x, y, width, height, rgb) {
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(image.height, Math.ceil(y + height)); py++) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(image.width, Math.ceil(x + width)); px++) {
      const offset = (py * image.width + px) * 4;
      image.data.set([...rgb, 255], offset);
    }
  }
}
const palette = [[210, 50, 35], [220, 150, 45], [60, 180, 80], [70, 130, 210], [190, 65, 170]];
function wave(image, box, vertical, gray = false) {
  rect(image, box.x, box.y, box.width, box.height, [4, 5, 7]);
  const length = vertical ? box.height : box.width, thickness = vertical ? box.width : box.height;
  for (let t = 0; t < length; t++) {
    const pulse = Math.exp(-((t / Math.max(8, length / 13)) % 1) * 4.4);
    const amplitude = .12 + .77 * pulse + .04 * Math.sin(t * .27) ** 2;
    const half = thickness * .45 * amplitude;
    const color = gray ? [125, 125, 125] : palette[Math.floor(t / (length / palette.length)) % palette.length];
    if (vertical) rect(image, box.x + thickness / 2 - half, box.y + t, half * 2, 1, color);
    else rect(image, box.x + t, box.y + thickness / 2 - half, 1, half * 2, color);
  }
}
function library(image) {
  const y0 = image.height * .69;
  for (let row = 0; row < 9; row++) {
    const y = y0 + row * image.height * .029;
    if (row === 3) rect(image, 0, y - 3, image.width, image.height * .025, [8, 91, 140]);
    for (let column = 0; column < 4; column++) {
      for (let glyph = 0; glyph < 11; glyph++) rect(image, image.width * (.08 + column * .23) + glyph * image.width * .008,
        y, image.width * .004, image.height * .010, [20, 145, 190]);
    }
  }
}
function horizontal({ width = 1280, height = 900, x = .025, y = .35, gray = false, single = false } = {}) {
  const image = screen(width, height); library(image);
  wave(image, { x: width * .03, y: height * .07, width: width * .43, height: height * .020 }, false);
  wave(image, { x: width * .54, y: height * .07, width: width * .43, height: height * .020 }, false);
  const box = { x: width * x, y: height * y, width: width * .95, height: height * .105 };
  wave(image, box, false, gray);
  if (!single) wave(image, { ...box, y: box.y + box.height + height * .005 }, false);
  return { image, expected: { x, y, width: .95, height: .215 } };
}
function vertical({ width = 1280, height = 900, x = .40, y = .17, gray = false, single = false } = {}) {
  const image = screen(width, height); library(image);
  const box = { x: width * x, y: height * y, width: width * .09, height: height * .48 };
  wave(image, box, true, gray);
  if (!single) wave(image, { ...box, x: box.x + box.width + width * .007 }, true);
  wave(image, { x: width * .615, y: height * y, width: width * .012, height: height * .48 }, true);
  return { image, expected: { x, y, width: .187, height: .48 } };
}
function compactVertical({ width = 2048, height = 1154, x = .425, y = .045, single = false, dense = false, overviews = true } = {}) {
  const image = screen(width, height);
  // A tall library, two deck panels, and narrow overview strips flank the
  // short vertical waveforms, like the user's supplied Serato Vertical view.
  for (let row = 0; row < 17; row++) for (let col = 0; col < 4; col++) {
    for (let glyph = 0; glyph < 15; glyph++) rect(image, width * (.04 + col * .24 + glyph * .006),
      height * (.43 + row * .03), width * .003, height * .012, [20, 145, 190]);
  }
  for (const c of [.325, .665]) {
    for (let dy = -75; dy <= 75; dy++) {
      const half = Math.sqrt(75 * 75 - dy * dy) * width / 2048;
      rect(image, width * c - half, height * .25 + dy * height / 1154, half * 2, height / 1154 + 1, [240, 135, 250]);
    }
  }
  const box = { x: width * x, y: height * y, width: width * .06, height: height * .315 };
  rect(image, width * (x - .017), box.y, width * .184, box.height, [4, 5, 7]);
  const draw = (target, overview = false) => {
    if (!dense) { wave(image, target, true); return; }
    rect(image, target.x, target.y, target.width, target.height, [4, 5, 7]);
    for (let t = 0; t < target.height; t++) {
      const amplitude = overview ? .85 : .80 + .025 * Math.sin(t * .27);
      const w = target.width * amplitude;
      const color = palette[Math.floor(t / (target.height / 12)) % palette.length];
      rect(image, target.x + (target.width - w) / 2, target.y + t, w, 1, color);
    }
  };
  draw(box);
  if (!single) draw({ ...box, x: width * (x + .09) });
  if (overviews) for (const dx of [-.012, .153]) draw({ x: width * (x + dx), y: box.y,
    width: width * .007, height: box.height }, true);
  return { image, expected: { x: x - .017, y, width: .184, height: .315 } };
}

function emptyVertical({ width = 1280, height = 742, x = .41, y = .08, playhead = true, missingRail = false } = {}) {
  const image = screen(width, height); library(image);
  rect(image, 0, 0, width, height * .036, [245, 245, 245]);
  const box = { x: x * width, y: y * height, width: width * .18, height: height * .31 };
  rect(image, box.x, box.y, box.width, box.height, [0, 0, 0]);
  const rails = [.065, .405, .585, .925];
  rails.forEach((at, index) => {
    if (!missingRail || index !== 1) rect(image, box.x + at * box.width, box.y,
      Math.max(1, width / 1280), box.height, [60, 60, 60]);
  });
  if (playhead) rect(image, box.x + rails[0] * box.width, box.y + box.height * .5,
    (rails[3] - rails[0]) * box.width, Math.max(1, height / 742), [124, 124, 124]);
  return { image, box, expected: { x, y, width: .18, height: .31 } };
}
const closeCrop = (actual, expected, tolerance = .055) => {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < tolerance,
    `${key}: ${actual[key]} expected near ${expected[key]}`);
};

test('horizontal neighboring waveform lanes exclude overview strips and library rows', () => {
  const { image, expected } = horizontal();
  const found = detectWaveformRegion(image);
  assert.equal(found.status, 'recognized', JSON.stringify(found));
  assert.equal(found.layout, 'horizontal-two-deck');
  assert.ok(found.confidence >= .80); closeCrop(found.crop, expected);
  assert.ok(found.crop.y > .2 && found.crop.y + found.crop.height < .69);
});

test('vertical neighboring waveform lanes exclude a narrow whole-track overview', () => {
  const { image, expected } = vertical();
  const found = detectWaveformRegion(image);
  assert.equal(found.status, 'recognized', JSON.stringify(found));
  assert.equal(found.layout, 'vertical-two-deck'); closeCrop(found.crop, expected);
  assert.ok(found.crop.x + found.crop.width < .615);
});

test('compact vertical decks above a tall library are detected without including deck platters', () => {
  for (const options of [{}, { width: 1280, height: 721 }, { width: 1024, height: 577, x: .36, y: .10 }]) {
    const { image, expected } = compactVertical(options);
    const found = detectWaveformRegion(image);
    assert.equal(found.status, 'recognized', JSON.stringify(found));
    assert.equal(found.layout, 'vertical-two-deck');
    closeCrop(found.crop, expected, .045);
    assert.ok(found.crop.y + found.crop.height < .43);
  }
  assert.equal(detectWaveformRegion(compactVertical({ single: true }).image).status, 'unrecognized');
});

test('dense vertical waveforms use flanking overview evidence instead of requiring large amplitude changes', () => {
  for (const options of [{}, { width: 1280, height: 742 }, { width: 1024, height: 577, x: .36, y: .10 }]) {
    const { image, expected } = compactVertical({ ...options, dense: true });
    const found = detectWaveformRegion(image);
    assert.equal(found.status, 'recognized', JSON.stringify(found));
    assert.equal(found.layout, 'vertical-two-deck'); closeCrop(found.crop, expected, .045);
    assert.ok(found.crop.y + found.crop.height < .43);
  }
  for (const extra of [{ overviews: false }, { single: true }]) {
    assert.equal(detectWaveformRegion(compactVertical({ dense: true, ...extra }).image).status, 'unrecognized');
  }
});

test('dense vertical layout survives the actual analysis JPEG quality levels', () => {
  const { image, expected } = compactVertical({ width: 1280, height: 742, dense: true });
  for (const quality of [70, 50]) {
    const bytes = jpeg.encode(image, quality).data;
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false });
    const found = detectWaveformRegion(decoded);
    assert.equal(found.status, 'recognized', `${quality}: ${JSON.stringify(found)}`);
    closeCrop(found.crop, expected, .045);
  }
});

test('a neutral light macOS title bar cannot merge all waveform columns', () => {
  for (const fixture of [compactVertical({ dense: true }), vertical(), horizontal({ gray: true })]) {
    rect(fixture.image, 0, 0, fixture.image.width, fixture.image.height * .036, [245, 245, 245]);
    const found = detectWaveformRegion(fixture.image);
    assert.equal(found.status, 'recognized', JSON.stringify(found));
    closeCrop(found.crop, fixture.expected, .055);
  }
});

test('outer overviews align a sparse deck with a dense deck even when their strong signal spans differ', () => {
  const { image, expected } = compactVertical({ width: 1280, height: 742, dense: true });
  const box = { x: image.width * .425, y: image.height * .045, width: image.width * .06, height: image.height * .315 };
  rect(image, box.x, box.y, box.width, box.height, [4, 5, 7]);
  wave(image, { ...box, y: box.y + box.height * .40, height: box.height * .60 }, true);
  rect(image, 0, 0, image.width, image.height * .036, [245, 245, 245]);
  const found = detectWaveformRegion(image);
  assert.equal(found.status, 'recognized', JSON.stringify(found));
  closeCrop(found.crop, expected, .04);
});

test('a confirmed vertical region survives unloading either deck while its remaining overview and empty pane stay visible', () => {
  const fixture = compactVertical({ width: 1280, height: 742, dense: true });
  const initial = detectWaveformRegion(fixture.image);
  assert.equal(initial.status, 'recognized');
  const previous = { layout: initial.layout, crop: initial.crop };
  const tracked = detectWaveformRegion(fixture.image, previous);
  assert.equal(tracked.reason, 'TRACKED_VERTICAL_LAYOUT');
  assert.deepEqual(tracked.crop, previous.crop);
  for (const side of ['left', 'right']) {
    const image = { ...fixture.image, data: fixture.image.data.slice() };
    const { crop } = previous;
    rect(image, (crop.x + crop.width * (side === 'left' ? 0 : .55)) * image.width, crop.y * image.height,
      crop.width * image.width * .45, crop.height * image.height, [4, 5, 7]);
    const found = detectWaveformRegion(image, previous);
    assert.equal(found.status, 'recognized', `${side}: ${JSON.stringify(found)}`);
    assert.equal(found.reason, 'TRACKED_VERTICAL_SINGLE_DECK');
    assert.deepEqual(found.crop, previous.crop);
  }
});

test('tracking ends when both overview anchors disappear or an unrelated pane replaces the missing deck', () => {
  const fixture = compactVertical({ width: 1280, height: 742, dense: true });
  const initial = detectWaveformRegion(fixture.image), previous = { layout: initial.layout, crop: initial.crop };
  const { crop } = previous;
  const clear = (image, x, width, rgb) => rect(image, (crop.x + crop.width * x) * image.width,
    crop.y * image.height, crop.width * image.width * width, crop.height * image.height, rgb);
  const empty = { ...fixture.image, data: fixture.image.data.slice() };
  clear(empty, 0, 1, [4, 5, 7]);
  assert.equal(detectWaveformRegion(empty, previous).status, 'unrecognized');
  const replacement = { ...fixture.image, data: fixture.image.data.slice() };
  clear(replacement, 0, .45, [160, 160, 160]);
  assert.notEqual(detectWaveformRegion(replacement, previous).reason, 'TRACKED_VERTICAL_SINGLE_DECK');
  assert.notEqual(detectWaveformRegion(fixture.image, { ...previous, crop: { ...crop, x: crop.x - .08 } }).reason, 'TRACKED_VERTICAL_LAYOUT');
});

test('previous-region context accepts only bounded numeric vertical crops and copies its fields', () => {
  const valid = { layout: 'vertical-two-deck', crop: { x: .4, y: .1, width: .2, height: .4 }, privateText: 'PRIVATE' };
  const copied = readPreviousRegion(valid);
  assert.deepEqual(copied, { layout: valid.layout, crop: valid.crop });
  valid.crop.x = .1;
  assert.equal(copied.crop.x, .4);
  for (const value of [null, {}, { ...valid, layout: 'horizontal-two-deck' },
    { ...valid, crop: { ...valid.crop, width: 1 } }, { ...valid, crop: { ...valid.crop, y: -.1 } },
    { ...valid, crop: { ...valid.crop, height: '0.4' } }]) assert.equal(readPreviousRegion(value), null);
  assert.doesNotMatch(JSON.stringify(copied), /PRIVATE/);
});

test('empty vertical panes can be acquired without tracks or a previous crop at different sizes and positions', () => {
  for (const options of [{}, { width: 640, height: 371 }, { width: 1600, height: 928, x: .31, y: .16 }]) {
    const { image, expected } = emptyVertical(options);
    const found = detectWaveformRegion(image);
    assert.equal(found.status, 'recognized', JSON.stringify(found));
    assert.equal(found.reason, 'EMPTY_VERTICAL_LAYOUT');
    closeCrop(found.crop, expected, .025);
  }
});

test('a dark rectangle or incomplete pane grid cannot stand in for the empty Serato layout', () => {
  const blank = screen(); rect(blank, 400, 70, 300, 350, [0, 0, 0]);
  for (const image of [blank, emptyVertical({ playhead: false }).image, emptyVertical({ missingRail: true }).image]) {
    assert.equal(detectWaveformRegion(image).status, 'unrecognized');
  }
  const { image, box } = emptyVertical();
  rect(image, box.x + box.width * .16, box.y + 5, box.width * .16, box.height - 10, [220, 70, 80]);
  assert.notEqual(detectWaveformRegion(image).reason, 'EMPTY_VERTICAL_LAYOUT');
});

test('one neutral waveform can pair with another colored waveform', () => {
  for (const fixture of [horizontal({ gray: true }), vertical({ gray: true })]) {
    const found = detectWaveformRegion(fixture.image);
    assert.equal(found.status, 'recognized', JSON.stringify(found));
    closeCrop(found.crop, fixture.expected);
  }
});

test('normalized profiles survive uniform resizing and supported region translation', () => {
  for (const [width, height] of [[640, 450], [1600, 1125], [2560, 1800]]) {
    for (const fixture of [horizontal({ width, height, y: .27 }), vertical({ width, height, x: .28, y: .13 })]) {
      const found = detectWaveformRegion(fixture.image);
      assert.equal(found.status, 'recognized', `${width} ${height} ${JSON.stringify(found)}`);
      closeCrop(found.crop, fixture.expected, .06);
    }
  }
});

test('single waveform, blank panes, library-only text and selected rows are not a two-deck profile', () => {
  const libraryOnly = screen(); library(libraryOnly);
  const meters = screen();
  for (let x = 100; x < 1100; x += 200) rect(meters, x, 180, 15, 380, [45, 180, 70]);
  for (const image of [screen(), libraryOnly, meters, horizontal({ single: true }).image, vertical({ single: true }).image]) {
    const found = detectWaveformRegion(image);
    assert.equal(found.status, 'unrecognized', JSON.stringify(found));
    assert.equal(found.crop, null);
  }
});

test('two uniformly colored rows and monochrome repeated text do not count as wave envelopes', () => {
  const image = screen();
  for (const y of [280, 390]) rect(image, 15, y, 1250, 80, [20, 145, 190]);
  assert.equal(detectWaveformRegion(image).status, 'unrecognized');
  const text = screen();
  for (let y = 100; y < 800; y += 36) for (let x = 40; x < 1200; x += 18) rect(text, x, y, 6, 18, [125, 125, 125]);
  assert.equal(detectWaveformRegion(text).status, 'unrecognized');
});

test('two rows of colored cue buttons on a black panel are not waveform lanes', () => {
  const image = screen(); rect(image, 0, 200, image.width, 330, [4, 5, 7]);
  for (const y of [260, 380]) for (let button = 0; button < 8; button++) {
    rect(image, 20 + button * 155, y, 140, 85, palette[button % palette.length]);
  }
  assert.equal(detectWaveformRegion(image).status, 'unrecognized');
});

test('four equal waveform lanes are ambiguous instead of silently selecting two decks', () => {
  const image = screen();
  for (let lane = 0; lane < 4; lane++) wave(image, {
    x: 25, y: 170 + lane * 125, width: 1230, height: 120,
  }, false);
  const found = detectWaveformRegion(image);
  assert.equal(found.status, 'unrecognized');
  assert.equal(found.reason, 'AMBIGUOUS_LAYOUT');
  assert.equal(found.crop, null);
});

test('analysis leaves the input pixels untouched and returns only bounded numeric crop metadata', () => {
  const { image } = vertical(); const original = image.data.slice();
  const found = detectWaveformRegion(image);
  assert.deepEqual(image.data, original);
  assert.deepEqual(Object.keys(found).sort(), ['confidence', 'crop', 'layout', 'reason', 'status']);
  assert.ok(found.crop.x >= 0 && found.crop.y >= 0 && found.crop.width > 0 && found.crop.height > 0);
  assert.ok(found.crop.x + found.crop.width <= 1 && found.crop.y + found.crop.height <= 1);
  found.crop.x = 100;
  assert.ok(detectWaveformRegion(image).crop.x < 1);
});

test('transparent RGB pixels cannot create hidden waveform evidence', () => {
  const { image } = horizontal();
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 0;
  assert.equal(detectWaveformRegion(image).status, 'unrecognized');
});

test('input limits and malformed or hostile data fail closed without leaking metadata', () => {
  for (const input of [null, {}, { width: 40, height: 40, data: new Uint8Array(6400) },
    { width: 1280, height: 900, data: [] }, { width: 1280, height: 900, data: new Uint8Array(12) },
    { width: Infinity, height: 100, data: new Uint8Array() }, { width: 9000, height: 9000 },
    { width: 4000, height: 3000, data: new Uint8Array() },
    { get width() { throw new Error('/PRIVATE/track.mp3'); } }]) {
    const result = detectWaveformRegion(input);
    assert.equal(result.status, 'unrecognized'); assert.equal(result.crop, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|track|mp3/);
  }
});

function framedHorizontal({ width = 1280, height = 742, x = .33, y = .08, w = .34, h = .31,
  playhead = true, missingRail = false, loaded = 0, gray = false, aligned = true, overviews = 0 } = {}) {
  const image = screen(width, height); library(image);
  const box = { x: x * width, y: y * height, width: w * width, height: h * height };
  rect(image, box.x, box.y, box.width, box.height, [0, 0, 0]);
  const positions = [.055, .44, .56, .945];
  const lane = index => ({ x: box.x + 2, y: box.y + box.height * positions[index ? 2 : 0] + 2,
    width: box.width - 4, height: box.height * .385 - 4 });
  if (loaded > 0) wave(image, lane(0), false, gray);
  if (loaded > 1) wave(image, lane(1), false, gray);
  // A real overview reaches the outside of its rail. This deliberately
  // removes the black neighbor required by the former empty-only profile.
  for (let which = 0; which < overviews; which++) {
    const y0 = which === 0 ? box.y : box.y + box.height * positions[3];
    const h = box.height * positions[0];
    for (let x = 0; x < box.width; x++) rect(image, box.x + x, y0, 1, h,
      palette[Math.floor(x / Math.max(1, box.width / palette.length)) % palette.length]);
  }
  positions.forEach((p, index) => {
    if (!missingRail || index !== 1) rect(image, box.x + (!aligned && index === 2 ? box.width * .15 : 0),
      box.y + p * box.height, box.width, Math.max(1, height / 742), [65, 65, 65]);
  });
  if (playhead) rect(image, box.x + box.width / 2, box.y + box.height * positions[0],
    Math.max(1, width / 1280), box.height * (positions[3] - positions[0]), [150, 150, 150]);
  return { image, expected: { x, y, width: w, height: h } };
}

test('framed Horizontal recognizes both empty lanes without a previous crop at varying sizes and positions', () => {
  for (const options of [{}, { width: 960, height: 557 }, { width: 1600, height: 928 },
    { x: .1, y: .14, w: .65, h: .36 }]) {
    const { image, expected } = framedHorizontal(options), result = detectWaveformRegion(image);
    assert.equal(result.reason, 'EMPTY_HORIZONTAL_LAYOUT', JSON.stringify({ options, result }));
    assert.equal(result.layout, 'horizontal-two-deck'); closeCrop(result.crop, expected, .025);
  }
});

test('the framed Horizontal crop survives loading either lane, both lanes and neutral waveforms', () => {
  const initial = detectWaveformRegion(framedHorizontal().image);
  for (const options of [{ loaded: 1 }, { loaded: 2 }, { loaded: 2, gray: true }]) {
    const result = detectWaveformRegion(framedHorizontal(options).image);
    assert.equal(result.reason, 'FRAMED_HORIZONTAL_LAYOUT', JSON.stringify({ options, result }));
    closeCrop(result.crop, initial.crop, .02);
  }
});

test('Horizontal framing rejects a plain dark rectangle, incomplete/misaligned rails and a missing shared playhead', () => {
  for (const options of [{ playhead: false }, { missingRail: true }, { aligned: false }]) {
    const result = detectWaveformRegion(framedHorizontal(options).image);
    assert.equal(result.status, 'unrecognized', JSON.stringify({ options, result }));
  }
  const image = screen(); library(image); rect(image, 400, 60, 450, 240, [0, 0, 0]);
  assert.equal(detectWaveformRegion(image).status, 'unrecognized');
});

test('a current framed Horizontal view replaces obsolete vertical tracking context', () => {
  const result = detectWaveformRegion(framedHorizontal().image, { layout: 'vertical-two-deck',
    crop: { x: .4125, y: .08, width: .175, height: .31 } });
  assert.equal(result.reason, 'EMPTY_HORIZONTAL_LAYOUT'); assert.equal(result.layout, 'horizontal-two-deck');
});


test('colored overview strips touching the outer rails confirm a loaded compact Horizontal view', () => {
  const { image, expected } = framedHorizontal({ loaded: 2, overviews: 2 });
  const found = detectWaveformRegion(image);
  assert.equal(found.reason, 'ANCHORED_HORIZONTAL_LAYOUT', JSON.stringify(found));
  closeCrop(found.crop, expected, .025);
});

test('one colored overview can anchor its loaded lane alongside a structurally empty counterpart', () => {
  const { image, expected } = framedHorizontal({ loaded: 1, overviews: 1 });
  const found = detectWaveformRegion(image);
  assert.equal(found.reason, 'ANCHORED_HORIZONTAL_LAYOUT', JSON.stringify(found));
  closeCrop(found.crop, expected, .025);
});

test('relaxed Horizontal rail evidence still needs two overviews or one overview plus an empty lane, and a playhead', () => {
  for (const options of [{ loaded: 2, overviews: 1 }, { loaded: 2, overviews: 2, playhead: false }]) {
    const result = detectWaveformRegion(framedHorizontal(options).image);
    assert.equal(result.status, 'unrecognized', JSON.stringify({ options, result }));
  }
});

test('horizontal context is copied with orientation-specific limits and cannot enter vertical tracking', () => {
  const value = { layout: 'horizontal-two-deck', crop: { x: .3, y: .08, width: .4, height: .32 } };
  const copy = readPreviousRegion(value); assert.deepEqual(copy, value);
  value.crop.x = .2; assert.equal(copy.crop.x, .3);
  for (const crop of [{ ...copy.crop, width: .2 }, { ...copy.crop, height: .8 }, { ...copy.crop, x: .9 },
    { ...copy.crop, width: '0.4' }, { ...copy.crop, height: NaN }]) assert.equal(readPreviousRegion({ ...copy, crop }), null);
  assert.equal(detectWaveformRegion(emptyVertical().image, copy).layout, 'vertical-two-deck');
});

test('confirmed Horizontal geometry is retained as lane contents and occupancy change', () => {
  const initial = detectWaveformRegion(framedHorizontal({ loaded: 2, overviews: 2 }).image);
  const previous = { layout: initial.layout, crop: initial.crop };
  for (const options of [{ loaded: 2, overviews: 2 }, { loaded: 2, overviews: 2, gray: true }, { loaded: 1, overviews: 1 }]) {
    const result = detectWaveformRegion(framedHorizontal(options).image, previous);
    assert.equal(result.reason, options.loaded === 1 ? 'TRACKED_HORIZONTAL_SINGLE_DECK' : 'TRACKED_HORIZONTAL_LAYOUT', JSON.stringify(result));
    assert.deepEqual(result.crop, previous.crop);
  }
});

test('horizontal tracking requires current overview, separator and playhead evidence', async () => {
  const { structureImage } = await import('../src/empty-vertical-layout.mjs');
  const { trackHorizontalRegion } = await import('../src/horizontal-tracking.mjs');
  const initial = detectWaveformRegion(framedHorizontal({ loaded: 2, overviews: 2 }).image);
  const previous = { layout: initial.layout, crop: initial.crop };
  for (const options of [{ loaded: 2 }, { loaded: 2, overviews: 2, playhead: false }, { loaded: 2, overviews: 2, missingRail: true }]) {
    assert.equal(trackHorizontalRegion(structureImage(framedHorizontal(options).image), previous), null, JSON.stringify(options));
  }
  assert.equal(trackHorizontalRegion(structureImage(framedHorizontal({ loaded: 2, overviews: 2 }).image),
    { ...previous, crop: { ...previous.crop, x: previous.crop.x + .15 } }), null);
});

test('separate colored bars alone do not acquire a Horizontal playback layout', () => {
  const image = screen(1280, 742);
  rect(image, 420, 60, 440, 240, [0, 0, 0]);
  rect(image, 420, 60, 440, 10, [40, 160, 80]); rect(image, 420, 280, 440, 10, [180, 40, 80]);
  assert.equal(detectWaveformRegion(image).status, 'unrecognized');
});

test('confirmed horizontal tracking does not depend on the amplitude or dark background of its waveforms', () => {
  const initial = detectWaveformRegion(framedHorizontal({ loaded: 2, overviews: 2 }).image);
  const { image } = framedHorizontal({ loaded: 2, overviews: 2 });
  const x = image.width * .33, y = image.height * .08, w = image.width * .34, h = image.height * .31;
  for (const [from, to] of [[.065, .43], [.57, .935]]) rect(image, x + 2, y + h * from, w - 4, h * (to - from), [12, 45, 85]);
  rect(image, x + w / 2, y + h * .055, 1, h * .89, [150, 150, 150]);
  const found = detectWaveformRegion(image, initial);
  assert.equal(found.reason, 'TRACKED_HORIZONTAL_LAYOUT', JSON.stringify(found));
  assert.deepEqual(found.crop, initial.crop);
});
