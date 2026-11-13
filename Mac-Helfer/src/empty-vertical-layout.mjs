function runs(values, threshold, gap = 2) {
  const groups = []; let start = -1, last = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= threshold) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > gap) { groups.push({ start, end: last + 1 }); start = -1; }
  }
  if (start >= 0) groups.push({ start, end: last + 1 });
  return groups;
}

/** Thin neutral dividers need all pixels in each analysis cell. The usual
 * sparse waveform probes can miss a 1px rail between two probe locations. */
export function structureImage(input) {
  const scale = Math.min(1, 320 / input.width, 240 / input.height);
  const width = Math.round(input.width * scale), height = Math.round(input.height * scale);
  const line = new Uint8Array(width * height);
  const light = new Uint8Array(width * height), color = new Uint8Array(width * height), neutral = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let maximum = -1, offset = -1, neutralPeak = 0;
    const x0 = Math.floor(x * input.width / width), x1 = Math.ceil((x + 1) * input.width / width);
    const y0 = Math.floor(y * input.height / height), y1 = Math.ceil((y + 1) * input.height / height);
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const i = (sy * input.width + sx) * 4;
      if (input.data[i + 3] < 200) continue;
      const value = Math.max(input.data[i], input.data[i + 1], input.data[i + 2]);
      const chroma = value - Math.min(input.data[i], input.data[i + 1], input.data[i + 2]);
      if (value >= 12 && chroma <= Math.max(12, value * .20)) neutralPeak = Math.max(neutralPeak, value);
      if (value > maximum) { maximum = value; offset = i; }
    }
    line[y * width + x] = neutralPeak;
    if (offset < 0) { light[y * width + x] = 255; continue; }
    const minimum = Math.min(input.data[offset], input.data[offset + 1], input.data[offset + 2]);
    const chroma = maximum - minimum, at = y * width + x;
    light[at] = maximum;
    color[at] = maximum >= 68 && chroma >= 27 && chroma / maximum >= .24 ? 1 : 0;
    neutral[at] = maximum >= 12 && maximum <= 230 && chroma <= Math.max(12, maximum * .20) ? 1 : 0;
  }
  return { width, height, light, color, neutral, line };
}

function verticalRails(image) {
  const { width, height, light, neutral } = image, rails = [];
  for (let x = 2; x < width - 2; x++) {
    const support = new Uint8Array(height);
    for (let y = 0; y < Math.floor(height * .70); y++) {
      const at = y * width + x, neighbor = Math.max(light[at - 2], light[at + 2]);
      support[y] = neutral[at] && neighbor <= 24 && light[at] - neighbor >= 8 ? 1 : 0;
    }
    for (const group of runs(support, 1)) {
      if (group.start > height * .40 || group.end - group.start < height * .20) continue;
      const coverage = support.slice(group.start, group.end).reduce((sum, value) => sum + value, 0) / (group.end - group.start);
      if (coverage < .85) continue;
      const previous = rails.at(-1);
      if (previous && x - previous.lastX <= 1 && Math.abs(group.start - previous.start) <= 2 && Math.abs(group.end - previous.end) <= 2) {
        previous.lastX = x; previous.x = (previous.firstX + x) / 2;
        previous.start = Math.min(previous.start, group.start); previous.end = Math.max(previous.end, group.end);
      } else rails.push({ x, firstX: x, lastX: x, ...group });
    }
  }
  return rails.filter(rail => rail.lastX - rail.firstX <= 2).slice(0, 48);
}

function emptyPanel(image, x0, x1, y0, y1) {
  let count = 0, dark = 0, colored = 0;
  for (let y = y0 + 1; y < y1 - 1; y++) for (let x = Math.ceil(x0 + 1); x < Math.floor(x1 - 1); x++) {
    const at = y * image.width + x;
    count++; if (image.light[at] <= 24) dark++; colored += image.color[at];
  }
  return count > 0 && dark / count >= .92 && colored / count <= .01;
}

export function detectEmptyVerticalLayout(input, image = structureImage(input)) {
  const { width, height, light, neutral } = image;
  const rails = verticalRails(image), candidates = [];
  for (let i = 0; i < rails.length; i++) for (let j = i + 1; j < rails.length; j++) {
    const a = rails[j].x - rails[i].x;
    if (a < Math.max(6, width * .025) || a > width * .13) continue;
    for (let k = j + 1; k < rails.length; k++) {
      const middle = rails[k].x - rails[j].x;
      if (middle < a * .30 || middle > a * .75) continue;
      for (let l = k + 1; l < rails.length; l++) {
        const b = rails[l].x - rails[k].x;
        if (Math.min(a, b) / Math.max(a, b) < .82) continue;
        const family = [rails[i], rails[j], rails[k], rails[l]];
        const y0 = Math.min(...family.map(rail => rail.start)), y1 = Math.max(...family.map(rail => rail.end));
        if (family.some(rail => Math.abs(rail.start - y0) > 2 || Math.abs(rail.end - y1) > 2)) continue;
        const innerWidth = rails[l].x - rails[i].x;
        if ((y1 - y0) / innerWidth < 1.05 || innerWidth > width * .32) continue;
        if (!emptyPanel(image, rails[i].x, rails[j].x, y0, y1)
          || !emptyPanel(image, rails[j].x, rails[k].x, y0, y1)
          || !emptyPanel(image, rails[k].x, rails[l].x, y0, y1)) continue;
        let playhead = false;
        for (let y = Math.max(y0, Math.floor((y0 + y1) / 2) - 2); y <= Math.min(y1 - 1, Math.ceil((y0 + y1) / 2) + 2); y++) {
          let count = 0, line = 0;
          for (let x = Math.ceil(rails[i].x); x <= Math.floor(rails[l].x); x++) {
            const at = y * width + x; count++;
            if (neutral[at] && light[at] >= 40) line++;
          }
          if (count > 0 && line / count >= .78) playhead = true;
        }
        if (!playhead) continue;
        const darkColumns = new Float64Array(width);
        for (let x = 0; x < width; x++) for (let y = y0 + 1; y < y1 - 1; y++) {
          if (light[y * width + x] <= 24) darkColumns[x] += 1 / (y1 - y0 - 2);
        }
        const region = runs(darkColumns, .80).find(group => group.start < rails[i].x && group.end > rails[l].x);
        if (!region || rails[i].x - region.start < 1 || region.end - rails[l].x < 1
          || rails[i].x - region.start > a * .50 || region.end - rails[l].x > b * .50) continue;
        const crop = { x: region.start / width, y: y0 / height,
          width: (region.end - region.start) / width, height: (y1 - y0) / height };
        if (crop.width > .40 || crop.height > .70 || crop.y + crop.height > 1) continue;
        if (!candidates.some(other => Math.abs(other.crop.x - crop.x) < .015 && Math.abs(other.crop.y - crop.y) < .015)) candidates.push({ crop });
      }
    }
  }
  if (candidates.length !== 1) return null;
  return { status: 'recognized', layout: 'vertical-two-deck', confidence: .92,
    crop: candidates[0].crop, reason: 'EMPTY_VERTICAL_LAYOUT' };
}
