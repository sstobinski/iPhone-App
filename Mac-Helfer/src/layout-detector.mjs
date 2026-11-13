import { trackHorizontalRegion, detectHorizontalOverviews } from './horizontal-tracking.mjs';
import { readPreviousRegion } from './region-context.mjs';
import { detectFramedHorizontalLayout } from './horizontal-layout.mjs';
import { detectEmptyVerticalLayout, structureImage } from './empty-vertical-layout.mjs';

const MAX_PIXELS = 8_000_000;
const MAX_SIDE = 8192;
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 240;

const rejected = reason => ({ status: 'unrecognized', layout: null, confidence: 0, crop: null, reason });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function runs(values, threshold, gap = 1) {
  const groups = [];
  let start = -1, last = -1;
  for (let index = 0; index < values.length; index++) {
    if (values[index] >= threshold) {
      if (start < 0) start = index;
      last = index;
    } else if (start >= 0 && index - last > gap) {
      groups.push({ start, end: last + 1 }); start = -1;
    }
  }
  if (start >= 0) groups.push({ start, end: last + 1 });
  return groups;
}

function sampledImage(width, height, data) {
  const scale = Math.min(1, ANALYSIS_WIDTH / width, ANALYSIS_HEIGHT / height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const ink = new Uint8Array(w * h), color = new Uint8Array(w * h), dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const target = y * w + x;
    let offset = -1, brightest = -1;
    // Four fixed probes preserve thin envelope cores without a full-image
    // scan or scale-dependent nearest-neighbor aliasing.
    for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
      const sx = Math.min(width - 1, Math.floor((x + dx) * width / w));
      const sy = Math.min(height - 1, Math.floor((y + dy) * height / h));
      const candidate = (sy * width + sx) * 4;
      const brightness = data[candidate + 3] >= 200 ? Math.max(data[candidate], data[candidate + 1], data[candidate + 2]) : -1;
      if (brightness > brightest) { brightest = brightness; offset = candidate; }
    }
    if (offset < 0) { dark[target] = 1; continue; }
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
    const chroma = maximum - minimum;
    const colored = maximum >= 68 && chroma >= 27 && chroma / Math.max(1, maximum) >= .24;
    color[target] = colored ? 1 : 0;
    ink[target] = colored || maximum >= 86 && minimum >= maximum * .68 ? 1 : 0;
    dark[target] = maximum <= 24 ? 1 : 0;
  }
  // A light macOS title bar is full-width neutral ink. Including it in the
  // vertical projection can merge every column into one huge false lane.
  // Remove only nearly uniform neutral rows from the derived evidence map.
  for (let y = 0; y < Math.ceil(h * .12); y++) {
    let rowInk = 0, rowColor = 0;
    for (let x = 0; x < w; x++) { rowInk += ink[y * w + x]; rowColor += color[y * w + x]; }
    if (rowInk / w > .90 && rowColor / w < .10) ink.fill(0, y * w, (y + 1) * w);
  }
  return { width: w, height: h, ink, color, dark };
}

function orientedProfiles(image, vertical) {
  const cross = vertical ? image.width : image.height;
  const along = vertical ? image.height : image.width;
  const at = (c, t) => vertical ? t * image.width + c : c * image.width + t;
  const thick = new Uint8Array(cross * along), projection = new Float64Array(cross);
  for (let c = 1; c < cross - 1; c++) for (let t = 0; t < along; t++) {
    // Filled waveforms have thickness across their axis. Thin beat lines and
    // sparse text are deliberately weaker evidence than a waveform envelope.
    if (image.ink[at(c - 1, t)] && image.ink[at(c, t)] && image.ink[at(c + 1, t)]) {
      thick[c * along + t] = 1;
      projection[c] += 1 / along;
    }
  }
  return { cross, along, at, thick, projection };
}

function candidates(image, vertical, padding = .025, dense = false) {
  const profile = orientedProfiles(image, vertical);
  const { cross, along, at, thick, projection } = profile;
  const minimumThickness = Math.max(vertical ? 7 : 6, Math.round(cross * (vertical ? .022 : .025)));
  const maximumThickness = cross * (vertical ? .25 : .22);
  const found = [];
  for (const group of runs(projection, .075, 1)) {
    const thickness = group.end - group.start;
    if (thickness < minimumThickness || thickness > maximumThickness) continue;
    let weight = 0, weightedCenter = 0;
    const counts = new Float64Array(along);
    for (let c = group.start; c < group.end; c++) {
      weight += projection[c]; weightedCenter += (c + .5) * projection[c];
      for (let t = 0; t < along; t++) counts[t] += thick[c * along + t];
    }
    if (weight === 0) continue;
    const supportProfile = new Uint8Array(along);
    for (let t = 0; t < along; t++) if (counts[t] >= (vertical ? Math.max(1, thickness * .12) : 1)) supportProfile[t] = 1;
    // Distant library text must not extend an otherwise valid vertical lane.
    // Waveform envelopes give one long, nearly continuous temporal run.
    const temporal = runs(supportProfile, 1, 3).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!temporal) continue;
    const support = [];
    for (let t = temporal.start; t < temporal.end; t++) if (supportProfile[t]) support.push(t);
    if (support.length < along * (vertical ? .30 : .52)) continue;
    const lowIndex = Math.floor(support.length * .015), highIndex = Math.ceil(support.length * .985) - 1;
    const start = Math.max(0, support[lowIndex] - Math.ceil(along * padding));
    const end = Math.min(along, support[highIndex] + 1 + Math.ceil(along * padding));
    const length = end - start;
    const active = support.filter(value => value >= start && value < end).length;
    const coverage = active / length;
    if (length < along * (vertical ? .35 : .55) || coverage < .70) continue;
    const values = [];
    for (let t = start; t < end; t++) values.push(counts[t]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / Math.max(1, mean);
    const activeValues = values.filter(value => value > 0);
    const activeMean = activeValues.reduce((sum, value) => sum + value, 0) / Math.max(1, activeValues.length);
    const activeVariation = Math.sqrt(activeValues.reduce((sum, value) => sum + (value - activeMean) ** 2, 0)
      / Math.max(1, activeValues.length)) / Math.max(1, activeMean);
    // A uniformly colored selected library row or meter is not an envelope.
    // Ignore gaps when measuring a filled signal as well: rows of equally
    // sized Cue buttons can otherwise resemble two varying envelopes.
    if (!dense && (variation < .13 || activeVariation < .12)) continue;
    let colors = 0, points = 0;
    for (let c = group.start; c < group.end; c++) for (let t = start; t < end; t++) {
      colors += image.color[at(c, t)]; points++;
    }
    found.push({ center: weightedCenter / weight, thickness, start, end, length,
      coverage, variation: activeVariation, colorFraction: colors / Math.max(1, points), weight });
  }
  return { found, profile };
}

function pairCandidates(image, vertical, compact = false, dense = false) {
  const { found, profile } = candidates(image, vertical, compact ? .01 : .025, dense);
  const { cross, along, at } = profile;
  const pairs = [];
  for (let one = 0; one < found.length; one++) for (let two = one + 1; two < found.length; two++) {
    const a = found[one], b = found[two];
    const separation = b.center - a.center;
    const averageThickness = (a.thickness + b.thickness) / 2;
    if (separation < averageThickness * .85 || separation > averageThickness * 4.8) continue;
    if (Math.min(a.thickness, b.thickness) / Math.max(a.thickness, b.thickness) < .38) continue;
    if (found.some((candidate, index) => index !== one && index !== two
      && candidate.center > a.center && candidate.center < b.center)) continue;
    const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (overlap / Math.min(a.length, b.length) < .86 || lengthRatio < (dense ? .45 : .82)) continue;
    const alignment = along * (dense ? .30 : .075);
    if (Math.abs(a.start - b.start) > alignment || Math.abs(a.end - b.end) > alignment) continue;
    let start = Math.min(a.start, b.start), end = Math.max(a.end, b.end);
    let length = end - start;
    // This prototype supports two equal adjacent lanes. Their shared spacing
    // estimates the lane boundaries better than amplitude-only outer pixels.
    const crossStart = Math.floor(a.center - separation * .55);
    const crossEnd = Math.ceil(b.center + separation * .55);
    if (crossStart < -2 || crossEnd > cross + 2) continue;
    if (separation < cross * (vertical ? .045 : .045)
      || separation > cross * (vertical ? .32 : .28)) continue;
    if (length / separation < (vertical ? compact ? 1.8 : 2.2 : 4.5)) continue;
    if (Math.max(a.colorFraction, b.colorFraction) < .055) continue;
    let c0 = clamp(crossStart, 0, cross), c1 = clamp(crossEnd, 0, cross);
    const overviews = vertical ? verticalOverviews(image, a, b, start, end) : null;
    if (dense && !overviews) continue;
    if (overviews) {
      c0 = Math.max(0, overviews.left - 1); c1 = Math.min(cross, overviews.right + 2);
      start = Math.max(0, overviews.start - 1); end = Math.min(along, overviews.end + 1);
      length = end - start;
      if (length / separation < 1.8) continue;
    }
    let dark = 0, total = 0;
    for (let c = c0; c < c1; c++) for (let t = start; t < end; t++) {
      dark += image.dark[at(c, t)]; total++;
    }
    if (dark / Math.max(1, total) < .18) continue;
    const area = (c1 - c0) * length / (cross * along);
    if (area < .035 || area > .58) continue;
    const confidence = Math.min(.96, .76 + Math.min(.06, (Math.min(a.coverage, b.coverage) - .70) * .20)
      + Math.min(.05, Math.min(a.variation, b.variation) * .10) + Math.min(.04, lengthRatio * .04));
    const crop = vertical
      ? { x: c0 / image.width, y: start / image.height, width: (c1 - c0) / image.width, height: length / image.height }
      : { x: start / image.width, y: c0 / image.height, width: length / image.width, height: (c1 - c0) / image.height };
    pairs.push({ layout: vertical ? 'vertical-two-deck' : 'horizontal-two-deck', confidence, crop,
      anchored: overviews !== null, score: confidence + area * .10 });
  }
  return pairs;
}

function verticalOverviewStrips(image, a, b, start, end) {
  const separation = b.center - a.center;
  // Dense, zoomed-out signals can be nearly rectangular. Only accept those
  // when each outer edge has a separate narrow colored overview strip, with
  // a dark gap separating it from the broad lane. Flat colored UI bars alone
  // therefore cannot satisfy this alternate profile.
  const strip = (center, direction) => {
    let best = null;
    for (let offset = Math.ceil(separation * .25); offset <= Math.floor(separation * .85); offset++) {
      const x = Math.round(center + direction * offset);
      if (x < 1 || x >= image.width - 1) continue;
      let colored = 0, separated = 0, outerGap = 0;
      const stripInk = new Uint8Array(image.height);
      for (let y = start; y < end; y++) {
        if (image.color[y * image.width + x]) colored++;
        stripInk[y] = image.ink[y * image.width + x];
        // Track the separator independently of overview amplitude. JPEG
        // interpolation can make a narrow black gap dim neutral gray.
        for (let gap = 2; gap <= Math.max(2, Math.floor(separation * .16)); gap++) {
          const gx = x - direction * gap;
          const index = y * image.width + gx;
          if (gx >= 0 && gx < image.width && (image.dark[index] || !image.ink[index] && !image.color[index])) { separated++; break; }
        }
        for (let gap = 2; gap <= 4; gap++) {
          const gx = x + direction * gap, index = y * image.width + gx;
          if (gx >= 0 && gx < image.width && (image.dark[index] || !image.ink[index] && !image.color[index])) { outerGap++; break; }
        }
      }
      const colorFraction = colored / (end - start), separatedFraction = separated / (end - start);
      const temporal = runs(stripInk, 1, 2).sort((one, two) => (two.end - two.start) - (one.end - one.start))[0];
      const outerFraction = outerGap / (end - start);
      // Small JPEG thumbnails can lose chroma while their isolated continuous
      // strip remains clear. Require stronger separators for that case.
      const chromatic = colorFraction >= .35 || colorFraction >= .25 && separatedFraction >= .75 && outerFraction >= .80;
      if (chromatic && separatedFraction >= .44 && outerFraction >= .60
        && temporal && temporal.end - temporal.start >= (end - start) * .75) {
        const score = separatedFraction + colorFraction * .15;
        if (!best || score > best.score) best = { x, score, ...temporal };
      }
    }
    return best;
  };
  const left = strip(a.center, -1), right = strip(b.center, 1);
  return { left, right };
}

function verticalOverviews(image, a, b, start, end) {
  const { left, right } = verticalOverviewStrips(image, a, b, start, end);
  if (!left || !right || Math.abs(left.start - right.start) > image.height * .06
    || Math.abs(left.end - right.end) > image.height * .06) return null;
  return { left: left.x, right: right.x, start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) };
}

function trackVerticalRegion(image, previous) {
  const region = readPreviousRegion(previous);
  if (region?.layout !== 'vertical-two-deck') return null;
  const crop = region.crop;
  const x0 = Math.round(crop.x * image.width), x1 = Math.round((crop.x + crop.width) * image.width);
  const y0 = Math.max(0, Math.floor(crop.y * image.height));
  const y1 = Math.min(image.height, Math.ceil((crop.y + crop.height) * image.height));
  const span = x1 - x0;
  if (span < 12 || y1 - y0 < 16) return null;
  const strips = verticalOverviewStrips(image, { center: x0 + span * .25 }, { center: x0 + span * .75 }, y0, y1);
  // Overview tails can contain quiet/neutral pixels; their last ink row is
  // not always exactly the panel boundary, especially after JPEG sampling.
  const temporalTolerance = Math.max(2, Math.ceil((y1 - y0) * .08));
  const matches = (strip, expectedX) => strip && Math.abs(strip.x - expectedX) <= 2
    && Math.abs(strip.start - (y0 + 1)) <= temporalTolerance && Math.abs(strip.end - (y1 - 1)) <= temporalTolerance;
  const left = matches(strips.left, x0 + 1), right = matches(strips.right, x1 - 2);
  const emptyPane = side => {
    const start = Math.ceil(x0 + span * (side === 'left' ? .07 : .57));
    const end = Math.floor(x0 + span * (side === 'left' ? .43 : .93));
    const top = Math.ceil(y0 + (y1 - y0) * .04), bottom = Math.floor(y1 - (y1 - y0) * .04);
    let count = 0, dark = 0, color = 0, ink = 0;
    for (let y = top; y < bottom; y++) for (let x = start; x < end; x++) {
      const index = y * image.width + x;
      count++; dark += image.dark[index]; color += image.color[index]; ink += image.ink[index];
    }
    return count > 0 && dark / count >= .80 && color / count <= .035 && ink / count <= .12;
  };
  const single = left && !right && emptyPane('right') || right && !left && emptyPane('left');
  if (!(left && right) && !single) return null;
  return { status: 'recognized', layout: 'vertical-two-deck', crop: { ...crop }, confidence: single ? .90 : .94,
    reason: single ? 'TRACKED_VERTICAL_SINGLE_DECK' : 'TRACKED_VERTICAL_LAYOUT' };
}

function compactVerticalPairs(image) {
  const pairs = [];
  // A tall library dilutes the full-window projection and can merge its text
  // with a short lane. Analyze bounded upper bands, still detecting envelopes
  // inside them rather than treating the band itself as the crop.
  for (const fraction of [.38, .46, .54]) {
    const height = Math.max(1, Math.round(image.height * fraction));
    const end = height * image.width;
    const band = { width: image.width, height, ink: image.ink.subarray(0, end),
      color: image.color.subarray(0, end), dark: image.dark.subarray(0, end) };
    const candidates = [...pairCandidates(band, true, true), ...pairCandidates(band, true, true, true)];
    for (const pair of candidates) {
      if (pair.crop.y + pair.crop.height >= .985) continue; // Do not cut a continuing waveform at the band edge.
      const crop = { ...pair.crop, y: pair.crop.y * height / image.height,
        height: pair.crop.height * height / image.height };
      // Require two narrow matching lanes, not large deck platters or a tiny
      // overview. All coordinates still derive from window-relative pixels.
      if (crop.width > .30 || crop.height < .20 || crop.y + crop.height > .62) continue;
      pairs.push({ ...pair, crop, score: pair.score - .005 });
    }
  }
  return pairs;
}

function intersectionOverUnion(a, b) {
  const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / (a.width * a.height + b.width * b.height - area);
}

/**
 * Conservative profile recognition for two neighboring Serato-style waveform
 * lanes. Input is an already-selected window image, not desktop coordinates.
 * No app identity is inferred here. Unknown layouts deliberately return null.
 * Shipping fixtures are synthetic; private real-JPEG regressions run separately.
 * Live Serato/OS capture still needs the Mac test.
 */
export function detectWaveformRegion(input, previousRegion = null) {
  try {
    const { width, height, data } = input ?? {};
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64
      || width > MAX_SIDE || height > MAX_SIDE) return rejected('IMAGE_INVALID');
    if (width * height > MAX_PIXELS) return rejected('IMAGE_TOO_LARGE');
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) return rejected('IMAGE_INVALID');
    const image = sampledImage(width, height, data);
    const tracked = trackVerticalRegion(image, previousRegion);
    if (tracked) return tracked;
    const structure = structureImage(input);
    const trackedHorizontal = trackHorizontalRegion(structure, previousRegion);
    if (trackedHorizontal) return trackedHorizontal;
    const horizontal = detectFramedHorizontalLayout(input, structure);
    if (horizontal) return horizontal;
    const overviewHorizontal = detectHorizontalOverviews(structure);
    if (overviewHorizontal) return overviewHorizontal;
    const empty = detectEmptyVerticalLayout(input, structure);
    if (empty) return empty;
    const regular = [...pairCandidates(image, false), ...pairCandidates(image, true)];
    const compact = compactVerticalPairs(image);
    const anchored = [...regular, ...compact].filter(pair => pair.anchored);
    const found = (anchored.length ? anchored : regular.length ? regular : compact).sort((a, b) => b.score - a.score);
    const pairs = [];
    for (const pair of found) {
      if (!pairs.some(other => other.layout === pair.layout && intersectionOverUnion(other.crop, pair.crop) >= .72)) pairs.push(pair);
    }
    if (!pairs.length) return rejected('NO_WAVEFORM_PAIR');
    if (pairs.length > 1 && pairs[0].score - pairs[1].score < .055) return rejected('AMBIGUOUS_LAYOUT');
    const best = pairs[0];
    return { status: 'recognized', layout: best.layout, confidence: Number(best.confidence.toFixed(3)),
      crop: best.crop, reason: 'SUPPORTED_TWO_DECK_PROFILE' };
  } catch { return rejected('IMAGE_INVALID'); }
}
