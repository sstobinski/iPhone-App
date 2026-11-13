const CAPTURE_KEYS = ['targetFps', 'captureSamples', 'busyDrops', 'cropFrames', 'previewFrames', 'elapsedMs',
  'captureFps', 'encodeFps', 'peakCaptureFps', 'peakEncodeFps'];
export function readCapturePerformance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...CAPTURE_KEYS].sort().join(',')) return null;
  if (![30, 60].includes(value.targetFps)) return null;
  for (const key of ['captureSamples', 'busyDrops', 'cropFrames', 'previewFrames']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1e12) return null;
  }
  if (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 1e12) return null;
  for (const key of ['captureFps', 'encodeFps', 'peakCaptureFps', 'peakEncodeFps']) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 240) return null;
  }
  return Object.fromEntries(CAPTURE_KEYS.map(key => [key, value[key]]));
}

/** Counts unique stream frames in >=1s windows; idle periods are real zeros. */
export class FrameRateMeter {
  #at = null; #count = 0; #rate = 0; #peak = 0;
  mark(now) { this.read(now); this.#count++; }
  read(now) {
    if (this.#at === null) this.#at = now;
    const elapsed = now - this.#at;
    if (elapsed >= 1000) {
      this.#rate = this.#count * 1000 / elapsed;
      this.#peak = Math.max(this.#peak, this.#rate); this.#count = 0; this.#at = now;
    }
    return { uniqueFrameFps: this.#rate, peakUniqueFrameFps: this.#peak };
  }
}

const CLIENT_KEYS = ['clientId', 'sample', 'foregroundMs', 'frames', 'skipped', 'requestMs', 'decodeMs', 'renderWaitMs', 'drawMs'];
const MOVING_KEYS = ['movingMs', 'movingFrames'];
export function readClientPerformance(value) {
  const keys = value && Object.hasOwn(value, 'movingMs') ? [...CLIENT_KEYS, ...MOVING_KEYS] : CLIENT_KEYS;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
    || !/^[a-f0-9]{16}$/.test(value.clientId ?? '')) return null;
  for (const key of ['sample', 'frames', 'skipped']) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1e9) return null;
  if (value.sample < 1) return null;
  for (const key of ['foregroundMs', 'requestMs', 'decodeMs', 'renderWaitMs', 'drawMs']) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1e12) return null;
  }
  if (value.foregroundMs <= 0 || value.foregroundMs > 86_400_000 || value.frames > value.foregroundMs * .240 + 2) return null;
  if (keys.length !== CLIENT_KEYS.length) {
    if (!Number.isFinite(value.movingMs) || value.movingMs < 0 || value.movingMs > value.foregroundMs
      || !Number.isSafeInteger(value.movingFrames) || value.movingFrames < 0 || value.movingFrames > value.frames
      || value.movingFrames > value.movingMs * .240 + 2 || value.movingMs === 0 && value.movingFrames !== 0) return null;
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

/** Per-page diagnostics; roles come from the TCP peer, never a client claim.
 * IDs stay internal; reports contain bounded numeric entries without IP/UA. */
export class ClientPerformanceCollector {
  #clients = new Map();
  accept(value, role, now = performance.now()) {
    const safe = readClientPerformance(value);
    if (!safe || !['phone', 'mac-preview'].includes(role)) return false;
    const previous = this.#clients.get(safe.clientId);
    if (!previous && this.#clients.size >= 16) return false;
    if (previous && (previous.role !== role || safe.sample <= previous.value.sample
      || now - previous.at < 500 || safe.foregroundMs <= previous.value.foregroundMs)) return false;
    if (previous && Object.hasOwn(safe, 'movingMs') !== Object.hasOwn(previous.value, 'movingMs')) return false;
    if (previous) for (const key of [...CLIENT_KEYS.slice(2), ...(Object.hasOwn(safe, 'movingMs') ? MOVING_KEYS : [])]) {
      if (safe[key] < previous.value[key]) return false;
    }
    const elapsed = safe.foregroundMs - (previous?.value.foregroundMs ?? 0);
    const frames = safe.frames - (previous?.value.frames ?? 0), rate = frames * 1000 / elapsed;
    if (rate > 240) return false;
    const movingElapsed = Object.hasOwn(safe, 'movingMs') ? safe.movingMs - (previous?.value.movingMs ?? 0) : 0;
    const movingFrames = Object.hasOwn(safe, 'movingFrames') ? safe.movingFrames - (previous?.value.movingFrames ?? 0) : 0;
    if (movingElapsed > elapsed + .001 || movingFrames > frames || movingElapsed === 0 && movingFrames !== 0
      || movingFrames > movingElapsed * .240 + 2) return false;
    const movingRate = movingElapsed >= 1000 ? movingFrames * 1000 / movingElapsed : null;
    this.#clients.set(safe.clientId, { index: previous?.index ?? this.#clients.size + 1, role, value: safe, at: now,
      movingWindows: (previous?.movingWindows ?? 0) + Number(movingRate !== null),
      lastMovingFps: movingRate, peakMovingFps: movingRate === null ? previous?.peakMovingFps ?? null : Math.max(previous?.peakMovingFps ?? 0, movingRate),
      reports: (previous?.reports ?? 0) + 1, lastFps: rate, peakFps: Math.max(previous?.peakFps ?? 0, rate) });
    return true;
  }
  getStats() {
    return [...this.#clients.values()].map(({ index, role, value, reports, lastFps, peakFps, movingWindows, lastMovingFps, peakMovingFps }) => ({
      index, role, reports, framesDrawn: value.frames, uniqueFramesSkipped: value.skipped,
      foregroundMs: value.foregroundMs, meanDrawFps: value.frames * 1000 / value.foregroundMs,
      lastDrawFps: lastFps, peakDrawFps: peakFps,
      movingPlayback: Object.hasOwn(value, 'movingMs') ? {
        classification: 'estimated-from-fresh-serato-play-rate', milliseconds: value.movingMs,
        framesSubmitted: value.movingFrames, meanSubmissionFps: value.movingMs > 0 ? value.movingFrames * 1000 / value.movingMs : null,
        lastWindowSubmissionFps: lastMovingFps, peakWindowSubmissionFps: peakMovingFps, windowsAtLeastOneSecond: movingWindows,
      } : null,
      meanRequestAndBodyMs: value.frames ? value.requestMs / value.frames : 0,
      meanDecodeMs: value.frames ? value.decodeMs / value.frames : 0,
      meanRenderWaitMs: value.frames ? value.renderWaitMs / value.frames : 0,
      meanDrawCallMs: value.frames ? value.drawMs / value.frames : 0,
    }));
  }
}
