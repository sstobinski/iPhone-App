export function createMetricsId() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return null;
  return [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Local cumulative counters. No URLs, device fingerprints, images or track
 * metadata; foreground time begins only once a stream frame is visible. */
export class FrameStats {
  #id; #now; #last; #active = false; #sample = 0;
  #values = { foregroundMs: 0, frames: 0, skipped: 0, requestMs: 0, decodeMs: 0, renderWaitMs: 0, drawMs: 0 };
  constructor({ id = createMetricsId(), now = () => performance.now() } = {}) {
    this.#id = id; this.#now = now; this.#last = now();
  }
  #flush() {
    const now = Math.max(this.#last, this.#now());
    if (this.#active) this.#values.foregroundMs += now - this.#last;
    this.#last = now;
  }
  setActive(value) { this.#flush(); this.#active = value === true; }
  record(timing = {}, skipped = 0) {
    this.#flush(); this.#values.frames++;
    if (Number.isSafeInteger(skipped) && skipped > 0) this.#values.skipped += Math.min(1e6, skipped);
    for (const key of ['requestMs', 'decodeMs', 'renderWaitMs', 'drawMs']) {
      if (Number.isFinite(timing[key]) && timing[key] >= 0 && timing[key] <= 1e6) this.#values[key] += timing[key];
    }
  }
  snapshot() {
    this.#flush();
    if (!this.#id || this.#values.foregroundMs < 1000) return null;
    return { clientId: this.#id, sample: ++this.#sample, ...this.#values };
  }
}

/** Never resize a canvas whose pixel dimensions already match its image. */
export function paintFrame(canvas, context, bitmap, metadata) {
  if (canvas.width !== metadata.width) canvas.width = metadata.width;
  if (canvas.height !== metadata.height) canvas.height = metadata.height;
  context?.drawImage(bitmap, 0, 0, metadata.width, metadata.height);
}

export function nextPaint({ schedule = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : null,
  cancel = typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame.bind(globalThis) : null,
  timeoutMs = 250 } = {}) {
  if (typeof schedule !== 'function') return Promise.resolve(true);
  return new Promise(resolve => {
    let timer, token, finished = false;
    const finish = value => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (!value && typeof cancel === 'function') cancel(token);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    token = schedule(() => finish(true));
  });
}

/** Show regions from one decoded JPEG. All three canvases are updated in the
 * same paint callback; no extra captures or independent frame queues. */
export function paintPresentation(canvas, context, platters, bitmap, metadata, presentation) {
  if (!presentation) { paintFrame(canvas, context, bitmap, metadata); return false; }
  const valid = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001;
  if (presentation.kind !== 'platters-and-waveforms' || !valid(presentation.waveform) || presentation.platters?.length !== 2 || !presentation.platters.every(valid)) throw new Error('FRAME_PRESENTATION_INVALID');
  const regions = [presentation.waveform, ...presentation.platters];
  const targets = [{ canvas, context }, ...platters];
  const pixels = regions.map(r => {
    const x = Math.floor(r.x * metadata.width), y = Math.floor(r.y * metadata.height);
    const width = Math.min(metadata.width, Math.ceil((r.x + r.width) * metadata.width)) - x;
    const height = Math.min(metadata.height, Math.ceil((r.y + r.height) * metadata.height)) - y;
    if (width < 2 || height < 2) throw new Error('FRAME_PRESENTATION_INVALID');
    return { x, y, width, height };
  });
  for (let i = 0; i < pixels.length; i++) {
    const { x, y, width, height } = pixels[i], target = targets[i];
    if (target.canvas.width !== width) target.canvas.width = width;
    if (target.canvas.height !== height) target.canvas.height = height;
    target.context?.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  }
  return true;
}
