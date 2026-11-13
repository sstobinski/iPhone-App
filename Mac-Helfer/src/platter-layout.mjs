const finiteRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]))
  && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.00000001 && r.y + r.height <= 1.00000001;
const copy = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/** A single approved capture rectangle supplies all three views. Regions are
 * relative to that JPEG, never extra window requests or independently timed images. */
export function platterPresentation(waveform, platters) {
  if (!finiteRect(waveform) || !Array.isArray(platters) || platters.length !== 2 || !platters.every(finiteRect)) return null;
  if (platters[0].x + platters[0].width / 2 >= platters[1].x + platters[1].width / 2) return null;
  const regions = [waveform, ...platters];
  const x = Math.min(...regions.map(r => r.x)), y = Math.min(...regions.map(r => r.y));
  const right = Math.max(...regions.map(r => r.x + r.width)), bottom = Math.max(...regions.map(r => r.y + r.height));
  const capture = { x, y, width: right - x, height: bottom - y };
  // Never infer a whole-window/library view as a platter layout.
  if (capture.width * capture.height > .60 || bottom > .78) return null;
  const relative = r => ({ x: (r.x - x) / capture.width, y: (r.y - y) / capture.height,
    width: r.width / capture.width, height: r.height / capture.height });
  return { capture, presentation: { kind: 'platters-and-waveforms', waveform: relative(waveform), platters: platters.map(relative) } };
}

export function readPlatterRegions(value) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finiteRect)) return null;
  if (value.some(r => r.width < .02 || r.width > .3 || r.height > .55 || r.width * r.height > .1)) return null;
  return value.map(copy);
}

/** Finds paired circular display faces, including empty dark discs. This is
 * bounded image analysis, not OCR, audio analysis or a waveform renderer. */
export function detectPlatterRegions(image, waveform) {
  const { width, height, data } = image ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 160 || height < 100
    || width > 4096 || height > 4096 || width * height > 8_000_000 || !data || data.length !== width * height * 4 || !finiteRect(waveform)) return null;
  const step = Math.max(1, Math.ceil(width / 640));
  const w = Math.floor(width / step), h = Math.floor(Math.min(height * .68, Math.max((waveform.y + waveform.height) * height + height * .08, height * .40)) / step);
  const candidates = [], count = w * h;
  const minSide = Math.max(12, width * .045 / step), maxSide = width * .23 / step;
  for (const mode of ['bright', 'dark']) {
    const mask = new Uint8Array(count), seen = new Uint8Array(count), queue = new Int32Array(count);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = (x + .5) * step / width, ny = (y + .5) * step / height;
      if (nx < .08 || nx > .92 || ny < .06 || nx > waveform.x - .005 && nx < waveform.x + waveform.width + .005 && ny > waveform.y - .005 && ny < waveform.y + waveform.height + .005) continue;
      const p = ((y * step) * width + x * step) * 4;
      const lo = Math.min(data[p], data[p + 1], data[p + 2]), hi = Math.max(data[p], data[p + 1], data[p + 2]);
      mask[y * w + x] = mode === 'dark' ? Number(hi < 27) : Number(hi >= 105 && (hi - lo >= 30 || lo >= 90));
    }
    for (let start = 0; start < count; start++) {
      if (!mask[start] || seen[start]) continue;
      let head = 0, tail = 1, minX = start % w, maxX = minX, minY = Math.floor(start / w), maxY = minY;
      queue[0] = start; seen[start] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % w, y = Math.floor(i / w);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const n of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
          if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
        }
      }
      const cw = maxX - minX + 1, ch = maxY - minY + 1, aspect = cw / ch, fill = tail / (cw * ch);
      if (cw < minSide || ch < minSide || cw > maxSide || ch > maxSide || aspect < .82 || aspect > 1.22 || fill < .43 || fill > .86) continue;
      let cornerHits = 0, cornerSamples = 0;
      for (const dx of [0, .82]) for (const dy of [0, .82]) {
        for (let yy = 0; yy < Math.max(1, Math.floor(ch * .18)); yy++) for (let xx = 0; xx < Math.max(1, Math.floor(cw * .18)); xx++) {
          cornerSamples++; cornerHits += mask[(minY + Math.floor(dy * ch) + yy) * w + minX + Math.floor(dx * cw) + xx] ?? 0;
        }
      }
      if (cornerHits / cornerSamples > .35) continue;
      const size = Math.max(cw, ch) * step * (mode === 'bright' ? 1.18 : 1.10);
      const centerX = (minX + maxX + 1) * step / 2, centerY = (minY + maxY + 1) * step / 2;
      const rect = { x: (centerX - size / 2) / width, y: (centerY - size / 2) / height, width: size / width, height: size / height };
      if (!finiteRect(rect)) continue;
      candidates.push({ rect, centerX, centerY, size, score: fill - Math.abs(1 - aspect) + (mode === 'bright' ? .1 : 0) });
    }
  }
  const left = candidates.filter(c => c.centerX < width * .49), right = candidates.filter(c => c.centerX > width * .51);
  const pairs = [];
  for (const a of left) for (const b of right) {
    if (Math.abs(a.centerY - b.centerY) > Math.max(a.size, b.size) * .16 || Math.min(a.size, b.size) / Math.max(a.size, b.size) < .80) continue;
    const diameter = Math.max(a.size, b.size);
    const rects = [a, b].map(c => ({ x: (c.centerX - diameter / 2) / width, y: (c.centerY - diameter / 2) / height, width: diameter / width, height: diameter / height }));
    if (!platterPresentation(waveform, rects)) continue;
    pairs.push({ rects, score: a.score + b.score - Math.abs(a.size - b.size) / Math.max(a.size, b.size) });
  }
  pairs.sort((a, b) => b.score - a.score);
  if (!pairs.length || pairs[1] && pairs[0].score - pairs[1].score < .03 && Math.abs(pairs[0].rects[0].x - pairs[1].rects[0].x) > .03) return null;
  return pairs[0].rects;
}
