import { readPreviousRegion } from './region-context.mjs';

function runs(mask, gap = 2) {
  const groups = []; let start = -1, last = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > gap) { groups.push({ start, end: last + 1 }); start = -1; }
  }
  if (start >= 0) groups.push({ start, end: last + 1 });
  return groups;
}

function verify(image, crop, requireBoth) {
  const { width, height, light, line, color } = image;
  const x0 = Math.max(1, Math.round(crop.x * width)), x1 = Math.min(width - 1, Math.round((crop.x + crop.width) * width));
  const y0 = Math.max(2, Math.round(crop.y * height)), y1 = Math.min(height - 2, Math.round((crop.y + crop.height) * height));
  const span = y1 - y0;
  if (x1 - x0 < 16 || span < 16 || (x1 - x0) / span < 1.2) return null;
  const separator = fraction => {
    const center = y0 + span * fraction, radius = Math.max(1, Math.round(span * .03));
    let best = null;
    for (let y = Math.round(center) - radius; y <= Math.round(center) + radius; y++) {
      if (y < 2 || y >= height - 2) continue;
      let count = 0, support = 0;
      for (let x = x0 + 1; x < x1 - 1; x++) {
        const at = y * width + x;
        const neighbor = Math.min(line[at - 2 * width], line[at + 2 * width]); count++;
        if (line[at] >= 12 && line[at] - neighbor >= 5) support++;
      }
      const coverage = support / Math.max(1, count);
      if (coverage >= .60 && (!best || coverage > best.coverage || coverage === best.coverage && Math.abs(y - center) < Math.abs(best.y - center))) best = { y, coverage };
    }
    return best?.y ?? null;
  };
  const upper = separator(.44), lower = separator(.56);
  if (upper === null || lower === null || lower - upper < span * .07 || lower - upper > span * .20) return null;
  const top = Math.round(y0 + span * .06), bottom = Math.round(y0 + span * .94);
  let playhead = false;
  for (let x = Math.round((x0 + x1) / 2) - 2; x <= Math.round((x0 + x1) / 2) + 2; x++) {
    let support = 0;
    for (let y = top; y < bottom; y++) if (line[y * width + x] >= 40) support++;
    if (support / Math.max(1, bottom - top) >= .70) playhead = true;
  }
  if (!playhead) return null;
  const panel = (from, to) => {
    let dark = 0, colored = 0, count = 0;
    for (let y = from + 1; y < to - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
      const at = y * width + x; count++; dark += light[at] <= 32 ? 1 : 0; colored += color[at];
    }
    return { dark: dark / Math.max(1, count), colored: colored / Math.max(1, count) };
  };
  const a = panel(top, upper), b = panel(lower, bottom);
  if (panel(upper, lower).dark < .20) return null;
  const overview = (from, to) => {
    for (let y = from; y < to; y++) {
      let support = 0;
      for (let x = x0 + 1; x < x1 - 1; x++) support += color[y * width + x];
      if (support / Math.max(1, x1 - x0 - 2) >= .55) return true;
    }
    return false;
  };
  const first = overview(y0, Math.min(upper, Math.ceil(y0 + span * .13)));
  const second = overview(Math.max(lower, Math.floor(y1 - span * .13)), y1);
  const empty = panel => panel.dark >= .92 && panel.colored <= .01;
  if (requireBoth ? !(first && second) : !(first && second || first && empty(b) || second && empty(a))) return null;
  return { single: !(first && second) };
}

/** A prior automatic crop is only a search bound. Every frame still needs
 * current overviews, two central separators and the fixed playhead. The
 * changing waveform envelope and its outer rail neighbors are not anchors. */
export function trackHorizontalRegion(image, previous) {
  const region = readPreviousRegion(previous);
  if (region?.layout !== 'horizontal-two-deck') return null;
  const evidence = verify(image, region.crop, false);
  return evidence ? { status: 'recognized', layout: region.layout, confidence: .92, crop: region.crop,
    reason: evidence.single ? 'TRACKED_HORIZONTAL_SINGLE_DECK' : 'TRACKED_HORIZONTAL_LAYOUT' } : null;
}

function overviewStrips(image) {
  const { width, height, color } = image, strips = [];
  for (let y = 2; y < Math.floor(height * .72); y++) {
    const row = color.subarray(y * width, (y + 1) * width);
    for (const group of runs(row, 3)) {
      const span = group.end - group.start;
      if (span < width * .25 || span > width * .98) continue;
      const coverage = row.subarray(group.start, group.end).reduce((sum, value) => sum + value, 0) / span;
      if (coverage < .70) continue;
      const prior = strips.at(-1);
      if (prior && y - prior.lastY <= 1 && Math.abs(group.start - prior.left) <= 3 && Math.abs(group.end - prior.right) <= 3) {
        prior.lastY = y; prior.left = Math.min(prior.left, group.start); prior.right = Math.max(prior.right, group.end);
      } else strips.push({ y, lastY: y, left: group.start, right: group.end });
    }
  }
  return strips.filter(strip => strip.lastY - strip.y + 1 <= Math.max(3, height * .045)).slice(0, 48);
}

/** Cold acquisition during playback uses two separate, thin overview bands
 * and verifies the stationary internal geometry between them. */
export function detectHorizontalOverviews(image) {
  const { width, height } = image, strips = overviewStrips(image), candidates = [];
  for (let i = 0; i < strips.length; i++) for (let j = i + 1; j < strips.length; j++) {
    const a = strips[i], b = strips[j], span = b.lastY + 1 - a.y;
    if (span < height * .18 || span > height * .55 || a.y > height * .45) continue;
    if (Math.abs(a.left - b.left) > 3 || Math.abs(a.right - b.right) > 3) continue;
    const left = Math.max(0, Math.min(a.left, b.left) - 1), right = Math.min(width, Math.max(a.right, b.right) + 1);
    const top = Math.max(0, a.y - 1), bottom = Math.min(height, b.lastY + 2);
    const crop = { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height };
    if (crop.width * crop.height > .60 || !verify(image, crop, true)) continue;
    const overlap = other => {
      const common = Math.max(0, Math.min(crop.x + crop.width, other.x + other.width) - Math.max(crop.x, other.x))
        * Math.max(0, Math.min(crop.y + crop.height, other.y + other.height) - Math.max(crop.y, other.y));
      return common / (crop.width * crop.height + other.width * other.height - common);
    };
    const same = candidates.findIndex(other => overlap(other) >= .75);
    if (same < 0) candidates.push(crop);
    else if (crop.width * crop.height > candidates[same].width * candidates[same].height) candidates[same] = crop;
  }
  return candidates.length === 1 ? { status: 'recognized', layout: 'horizontal-two-deck', confidence: .92,
    crop: candidates[0], reason: 'HORIZONTAL_OVERVIEW_LAYOUT' } : null;
}
