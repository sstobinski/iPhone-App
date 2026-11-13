import { structureImage } from './empty-vertical-layout.mjs';

function runs(values, gap = 2) {
  const groups = []; let start = -1, last = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i]) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > gap) { groups.push({ start, end: last + 1 }); start = -1; }
  }
  if (start >= 0) groups.push({ start, end: last + 1 });
  return groups;
}

function horizontalRails(image, edge = false, gap = 2) {
  const { width, height, light } = image, rails = [];
  for (let y = 2; y < Math.floor(height * .72); y++) {
    const support = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      // A loaded overview touches one side of an outer rail. Requiring
      // black on BOTH sides erases that rail from real Serato captures.
      const neighbor = (edge ? Math.min : Math.max)(light[at - 2 * width], light[at + 2 * width]);
      support[x] = image.line[at] >= 12 && neighbor <= (edge ? 32 : 24) && image.line[at] - neighbor >= 8 ? 1 : 0;
    }
    for (const group of runs(support, gap)) {
      const length = group.end - group.start;
      if (length < width * .25 || group.start > width * .65) continue;
      const coverage = support.slice(group.start, group.end).reduce((sum, value) => sum + value, 0) / length;
      if (coverage < .78) continue;
      const previous = rails.at(-1);
      if (previous && y - previous.lastY <= 1 && Math.abs(group.start - previous.start) <= 2 && Math.abs(group.end - previous.end) <= 2) {
        previous.lastY = y; previous.y = (previous.firstY + y) / 2;
        previous.start = Math.min(previous.start, group.start); previous.end = Math.max(previous.end, group.end);
      } else rails.push({ y, firstY: y, lastY: y, ...group });
    }
  }
  return rails.filter(rail => rail.lastY - rail.firstY <= 2).slice(0, 48);
}

function panel(image, x0, x1, y0, y1) {
  let points = 0, dark = 0, colored = 0;
  for (let y = Math.ceil(y0 + 1); y < Math.floor(y1 - 1); y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const at = y * image.width + x; points++;
    if (image.light[at] <= 24) dark++;
    colored += image.color[at];
  }
  return { dark: dark / Math.max(1, points), colored: colored / Math.max(1, points) };
}

/** A window-relative framed Horizontal profile: four aligned thin rails,
 * equal-height outer lanes, a smaller middle band, and a shared central
 * vertical playhead. No track color or remembered vertical crop is required.
 * This is deliberately a specific structural profile, not a black-box match. */
function detectFrame(image, edge, gap = 2) {
  const { width, height, light } = image;
  const rails = horizontalRails(image, edge, gap), candidates = [];
  for (let i = 0; i < rails.length; i++) for (let j = i + 1; j < rails.length; j++) {
    const a = rails[j].y - rails[i].y;
    if (a < Math.max(6, height * .04) || a > height * .22) continue;
    for (let k = j + 1; k < rails.length; k++) {
      const middle = rails[k].y - rails[j].y;
      if (middle < a * .20 || middle > a * .75) continue;
      for (let l = k + 1; l < rails.length; l++) {
        const b = rails[l].y - rails[k].y;
        if (Math.min(a, b) / Math.max(a, b) < .82) continue;
        const family = [rails[i], rails[j], rails[k], rails[l]];
        const starts = family.map(rail => rail.start).sort((a, b) => a - b);
        const ends = family.map(rail => rail.end).sort((a, b) => a - b);
        // In the overview-anchored pass small Cue/peak occlusions may shorten
        // one edge. The middle endpoints prevent outside UI fragments from
        // expanding the approved crop.
        const x0 = edge ? Math.round((starts[1] + starts[2]) / 2) : starts[0];
        const x1 = edge ? Math.round((ends[1] + ends[2]) / 2) : ends[3];
        const tolerance = edge ? Math.max(2, (x1 - x0) * .07) : 2;
        const aligned = rail => Math.abs(rail.start - x0) <= tolerance && Math.abs(rail.end - x1) <= tolerance;
        if (!edge && family.some(rail => !aligned(rail))) continue;
        if (edge) {
          if (family.filter(aligned).length < 3) continue;
          // Compression can join one rail to adjacent deck text. Three
          // matching endpoints establish the span; verify the fourth inside
          // that span rather than expanding the crop to include the text.
          const extended = family.filter(rail => !aligned(rail));
          if (extended.some(rail => rail.start > x0 + tolerance || rail.end < x1 - tolerance
            || x0 - rail.start > (x1 - x0) * .50 || rail.end - x1 > (x1 - x0) * .50)) continue;
          let unsupported = false;
          for (const rail of extended) {
            let support = 0, count = 0;
            for (let x = x0; x < x1; x++) {
              const at = Math.round(rail.y) * width + x;
              const neighbor = Math.min(light[at - 2 * width], light[at + 2 * width]);
              count++;
              if (image.line[at] >= 12 && neighbor <= (edge ? 32 : 24) && image.line[at] - neighbor >= 8) support++;
            }
            if (support / Math.max(1, count) < .78) unsupported = true;
          }
          if (unsupported) continue;
        }
        const y0 = rails[i].y, y1 = rails[l].y;
        if ((x1 - x0) / (y1 - y0) < 1.25 || y0 > height * .45 || y1 > height * .72) continue;
        const lanes = [panel(image, x0, x1, y0, rails[j].y), panel(image, x0, x1, rails[k].y, y1)];
        if (lanes.some(lane => lane.dark < .20)) continue;
        if (panel(image, x0, x1, rails[j].y, rails[k].y).dark < .70) continue;
        let playhead = false;
        for (let x = Math.floor((x0 + x1) / 2) - 2; x <= Math.ceil((x0 + x1) / 2) + 2; x++) {
          let count = 0, line = 0;
          for (let y = Math.ceil(y0); y < Math.floor(y1); y++) {
            const at = y * width + x; count++;
            if (image.line[at] >= 40) line++;
          }
          if (count > 0 && line / count >= .78) playhead = true;
        }
        if (!playhead) continue;
        if (edge) {
          const overview = (from, to) => {
            for (let y = Math.max(0, Math.floor(from)); y <= Math.min(height - 1, Math.ceil(to)); y++) {
              let colored = 0;
              for (let x = x0 + 1; x < x1 - 1; x++) colored += image.color[y * width + x];
              if (colored / Math.max(1, x1 - x0 - 2) >= .55) return true;
            }
            return false;
          };
          const topOverview = overview(y0 - middle * .85, y0 - 1);
          const bottomOverview = overview(y1 + 1, y1 + middle * .85);
          const empty = lane => lane.dark >= .92 && lane.colored <= .01;
          if (!(topOverview && bottomOverview || topOverview && empty(lanes[1]) || bottomOverview && empty(lanes[0]))) continue;
        }
        // Narrow whole-track strips sit outside the large lanes. Estimate
        // their extent from the measured middle-band height, then trim only
        // obvious nonblack exterior rows. This retains a stable crop as a
        // strip gains/loses a colored waveform.
        const padding = Math.ceil(middle / 2);
        let top = Math.max(0, Math.floor(y0) - padding), bottom = Math.min(height, Math.ceil(y1) + padding + 1);
        const exterior = y => {
          let blackOrColored = 0;
          for (let x = x0 + 1; x < x1 - 1; x++) {
            const at = y * width + x;
            if (light[at] <= 24 || image.color[at] || edge && image.line[at] >= 68) blackOrColored++;
          }
          return blackOrColored / Math.max(1, x1 - x0 - 2) < (edge ? .55 : .70);
        };
        while (top < y0 - 1 && exterior(top)) top++;
        while (bottom > y1 + 2 && exterior(bottom - 1)) bottom--;
        // Include one analysis cell at the anchored side borders so a
        // Cue triangle/shortened rail cannot shave off the overview edge.
        const left = edge ? Math.max(0, x0 - 1) : x0, right = edge ? Math.min(width, x1 + 1) : x1;
        const crop = { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height };
        if (crop.width * crop.height > .60) continue;
        const empty = lanes.every(lane => lane.dark >= .92 && lane.colored <= .01);
        const result = { status: 'recognized', layout: 'horizontal-two-deck', confidence: .92, crop,
          reason: edge ? 'ANCHORED_HORIZONTAL_LAYOUT' : empty ? 'EMPTY_HORIZONTAL_LAYOUT' : 'FRAMED_HORIZONTAL_LAYOUT' };
        if (!candidates.some(other => Math.abs(other.crop.x - crop.x) < .015 && Math.abs(other.crop.y - crop.y) < .015)) candidates.push(result);
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}


export function detectFramedHorizontalLayout(input, image = structureImage(input)) {
  // Preserve the verified empty profile. An alternate pass must supply
  // separate overview evidence before tolerating a colored rail neighbor.
  return detectFrame(image, false)
    ?? detectFrame(image, true, 4)
    ?? detectFrame(image, true, Math.max(4, Math.round(image.width * .02)));
}
