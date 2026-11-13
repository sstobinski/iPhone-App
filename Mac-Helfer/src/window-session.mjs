import { inspectWindowJpeg } from './jpeg.mjs';
import { readCaptureDimensions } from './capture-geometry.mjs';
import { FrameRateMeter } from './performance.mjs';

const LAYOUTS = new Set(['horizontal-two-deck', 'vertical-two-deck']);
const DETECTOR_REASONS = new Set(['IMAGE_INVALID', 'IMAGE_TOO_LARGE', 'NO_WAVEFORM_PAIR',
  'AMBIGUOUS_LAYOUT', 'SUPPORTED_TWO_DECK_PROFILE', 'TRACKED_VERTICAL_LAYOUT', 'TRACKED_VERTICAL_SINGLE_DECK', 'EMPTY_VERTICAL_LAYOUT', 'EMPTY_HORIZONTAL_LAYOUT', 'FRAMED_HORIZONTAL_LAYOUT', 'ANCHORED_HORIZONTAL_LAYOUT', 'HORIZONTAL_OVERVIEW_LAYOUT', 'TRACKED_HORIZONTAL_LAYOUT', 'TRACKED_HORIZONTAL_SINGLE_DECK']);
const STATUS_NAMES = new Set(['permission-required', 'waiting-for-serato', 'multiple-windows',
  'window-found', 'capture-ready', 'geometry-changed', 'crop-applied', 'crop-cleared',
  'crop-rejected', 'source-idle', 'source-paused', 'capture-error', 'stopped']);
const HARD_BLOCKS = new Set(['permission-required', 'waiting-for-serato', 'multiple-windows', 'capture-error', 'stopped']);
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const safeCode = value => typeof value === 'string' && /^CAPTURE_[A-Z_]{1,60}$/.test(value) ? value : null;
const copyCrop = value => value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
const rejected = errorCode => ({ ok: false, errorCode });

function validCrop(crop, source = null) {
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)
    || Object.keys(crop).sort().join(',') !== 'height,width,x,y'
    || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 || crop.y + crop.height > 1) return false;
  return source === null || crop.width * source.width >= 16 && crop.height * source.height >= 16;
}

function cropIou(one, two) {
  const width = Math.max(0, Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x));
  const height = Math.max(0, Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y));
  const intersection = width * height;
  return intersection / (one.width * one.height + two.width * two.height - intersection);
}

function cropUnion(one, two) {
  const x = Math.min(one.x, two.x), y = Math.min(one.y, two.y);
  return { x, y, width: Math.min(1, Math.max(one.x + one.width, two.x + two.width)) - x,
    height: Math.min(1, Math.max(one.y + one.height, two.y + two.height)) - y };
}

/** Coordinates native capture, local-only analysis and approved cropped frames.
 * It owns no files, sockets or image decoder. Public statistics contain only
 * numeric counters/static states, never captured bytes or window identifiers. */
export class WindowSession {
  #native;
  #analyze;
  #now;
  #lastNow = 0;
  #minConfidence;
  #stableFrames;
  #freshForMs;
  #closed = false;
  #mode = 'auto';
  #geometry = 0;
  #nativeState = { status: 'waiting-for-serato', errorCode: null };
  #source = null;
  #phone = null;
  #phoneUnchanged = false;
  #frameWaiters = new Set();
  #frameRate = new FrameRateMeter();
  #sourceSequence = 0;
  #phoneSequence = 0;
  #nativeAnalysisSequence = -1;
  #nativeFrameSequence = -1;
  #lastActivity = null;
  #blocked = true;
  #paused = false;
  #pending = null;
  #active = null;
  #requestId = 0;
  #lastCropRevision = 0;
  #candidate = null;
  #analysisBusy = false;
  #queuedAnalysis = null;
  #analysisEpoch = 0;
  #detection = { status: 'searching', layout: null, confidence: 0, crop: null, reason: 'WAITING_FOR_SOURCE' };
  #stats = { analysisFramesReceived: 0, framesReceived: 0, framesPublished: 0,
    framesRejected: 0, identicalFramesSkipped: 0, frameWaits: 0, frameWaitTimeouts: 0, frameWaitsCancelled: 0,
    analysesStarted: 0, analysesCompleted: 0, analysesDiscarded: 0,
    analysisFailures: 0, analysisFramesSkipped: 0, autoRecognitions: 0,
    autoCropsApplied: 0, manualCropsApplied: 0, geometryChanges: 0,
    cropRequests: 0, cropAcksIgnored: 0, stops: 0, autoRestarts: 0,
    sourcePauses: 0, invalidPackets: 0, lastEncodeMs: 0,
    lastPreviewWidth: 0, lastPreviewHeight: 0, lastCaptureWidth: 0, lastCaptureHeight: 0,
    lastFrameWidth: 0, lastFrameHeight: 0, lastFrameBytes: 0,
    lastAutoReason: 'WAITING_FOR_SOURCE', lastAutoLayout: null, lastAutoConfidence: 0,
    noPairAnalyses: 0, ambiguousAnalyses: 0, trackedAnalyses: 0, singleDeckTrackedAnalyses: 0, emptyLayoutAnalyses: 0, emptyHorizontalAnalyses: 0, framedHorizontalAnalyses: 0, anchoredHorizontalAnalyses: 0, overviewHorizontalAnalyses: 0, trackedHorizontalAnalyses: 0, singleDeckHorizontalAnalyses: 0 };

  constructor({ native, analyze, now = () => performance.now(), minConfidence = .75,
    stableFrames = 2, freshForMs = 2000 } = {}) {
    if (!native || typeof native.sendCrop !== 'function' || typeof native.clearCrop !== 'function'
      || typeof analyze !== 'function' || typeof now !== 'function'
      || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1
      || !Number.isInteger(stableFrames) || stableFrames < 2 || stableFrames > 10
      || !Number.isFinite(freshForMs) || freshForMs < 1 || freshForMs > 30000) {
      throw new TypeError('WINDOW_SESSION_OPTIONS_INVALID');
    }
    this.#native = native; this.#analyze = analyze; this.#now = now;
    this.#minConfidence = minConfidence; this.#stableFrames = stableFrames; this.#freshForMs = freshForMs;
  }

  #time() {
    let value;
    try { value = this.#now(); } catch { value = NaN; }
    if (Number.isFinite(value)) this.#lastNow = Math.max(this.#lastNow, value, 0);
    return this.#lastNow;
  }
  #age(at) { return Math.max(0, this.#time() - at); }
  #clearNative() { try { return this.#native.clearCrop() === true; } catch { return false; } }
  #clearTransfer() {
    this.#phone = null; this.#phoneUnchanged = false; this.#active = null; this.#pending = null; this.#nativeFrameSequence = -1;
    this.#wakeFrameWaiters(true);
  }
  #invalidateAnalysis() {
    this.#analysisEpoch = increment(this.#analysisEpoch);
    this.#queuedAnalysis = null; this.#candidate = null;
  }
  #changeGeometry(geometry) {
    this.#geometry = geometry; this.#stats.geometryChanges++;
    this.#source = null; this.#clearTransfer(); this.#invalidateAnalysis();
    this.#nativeAnalysisSequence = -1; this.#lastCropRevision = 0;
    this.#blocked = true; this.#paused = false;
    this.#detection = { status: this.#mode === 'manual' ? 'manual' : 'searching',
      layout: null, confidence: 0, crop: null, reason: 'WINDOW_GEOMETRY_CHANGED' };
  }

  setIssue(code) {
    if (this.#closed) return;
    this.#nativeState = { status: 'capture-error', errorCode: safeCode(code) ?? 'CAPTURE_FAILED' };
    this.#blocked = true; this.#paused = false; this.#source = null;
    this.#clearTransfer(); this.#invalidateAnalysis();
    this.#detection = { status: 'unrecognized', layout: null, confidence: 0, crop: null, reason: 'CAPTURE_UNAVAILABLE' };
  }

  acceptPacket(packet) {
    if (this.#closed) return false;
    try {
      const { header, jpeg } = packet ?? {};
      if (!header || !['status', 'analysis', 'frame'].includes(header.type)) return this.#invalid();
      const geometry = header.geometryRevision;
      if (!safeInteger(geometry) || header.type !== 'status' && geometry < 1) return this.#invalid();
      if (geometry < this.#geometry) return false;
      if (geometry > this.#geometry) this.#changeGeometry(geometry);
      if (header.type === 'status') return this.#acceptStatus(header);
      if (!safeInteger(header.sequence) || !safeInteger(header.cropRevision)) return this.#invalid();
      if (header.sourceAgeMs !== undefined && (!Number.isFinite(header.sourceAgeMs) || header.sourceAgeMs < 0)) return this.#invalid();
      if (header.encodeMs !== undefined && (!Number.isFinite(header.encodeMs) || header.encodeMs < 0)) return this.#invalid();
      const dimensions = inspectWindowJpeg(jpeg);
      if (dimensions.width !== header.width || dimensions.height !== header.height) return this.#invalid();
      const now = this.#time(); this.#lastActivity = now;
      if (header.encodeMs !== undefined) this.#stats.lastEncodeMs = header.encodeMs;
      if (header.type === 'analysis') {
        if (header.sequence <= this.#nativeAnalysisSequence) return false;
        const capture = readCaptureDimensions(header);
        if (!capture) return this.#invalid();
        if (this.#source && (this.#source.width !== header.width || this.#source.height !== header.height
          || this.#source.captureWidth !== capture.captureWidth || this.#source.captureHeight !== capture.captureHeight)) {
          this.setIssue('CAPTURE_GEOMETRY_CHANGED'); return this.#invalid();
        }
        this.#nativeAnalysisSequence = header.sequence;
        this.#source = { buffer: Buffer.from(jpeg), ...dimensions, ...capture,
          sequence: ++this.#sourceSequence, geometryRevision: geometry, cropRevision: header.cropRevision,
          at: now - (header.sourceAgeMs ?? 0) };
        this.#blocked = false; this.#paused = false;
        this.#stats.analysisFramesReceived++;
        this.#stats.lastPreviewWidth = header.width; this.#stats.lastPreviewHeight = header.height;
        this.#stats.lastCaptureWidth = capture.captureWidth; this.#stats.lastCaptureHeight = capture.captureHeight;
        if (this.#mode === 'auto') this.#queueAnalysis(this.#source);
        return true;
      }
      this.#stats.framesReceived++;
      const active = this.#active;
      if (!active || this.#mode === 'stopped' || header.requestId !== active.requestId
        || header.cropRevision !== active.cropRevision || geometry !== active.geometryRevision
        || header.sequence <= this.#nativeFrameSequence) {
        this.#stats.framesRejected++; return false;
      }
      // Reject an accidental whole-window image labelled as a cropped frame.
      // Compare against capture pixels, never the smaller analysis JPEG.
      if (Math.abs(header.width - active.crop.width * active.sourceWidth) > 2
        || Math.abs(header.height - active.crop.height * active.sourceHeight) > 2) {
        this.#stats.framesRejected++; return false;
      }
      this.#nativeFrameSequence = header.sequence;
      if (this.#phone && this.#phone.buffer.equals(jpeg)) {
        this.#phoneUnchanged = true; this.#blocked = false; this.#paused = false;
        this.#stats.identicalFramesSkipped++; return true;
      }
      this.#phoneUnchanged = false;
      this.#phone = { buffer: Buffer.from(jpeg), ...dimensions,
        sequence: ++this.#phoneSequence, geometryRevision: geometry,
        cropRevision: header.cropRevision, at: now - (header.sourceAgeMs ?? 0) };
      this.#blocked = false; this.#paused = false;
      this.#stats.framesPublished++;
      this.#frameRate.mark(now);
      this.#stats.lastFrameWidth = header.width; this.#stats.lastFrameHeight = header.height;
      this.#stats.lastFrameBytes = jpeg.length;
      this.#wakeFrameWaiters();
      return true;
    } catch { return this.#invalid(); }
  }

  #invalid() { this.#stats.invalidPackets++; return false; }
  #acceptStatus(header) {
    if (!STATUS_NAMES.has(header.status) || header.cropRevision !== undefined && !safeInteger(header.cropRevision)) return this.#invalid();
    this.#lastActivity = this.#time();
    if (header.status === 'crop-applied') {
      const pending = this.#pending;
      if (!pending || header.requestId !== pending.requestId || header.geometryRevision !== pending.geometryRevision
        || !safeInteger(header.cropRevision) || header.cropRevision < 1 || header.cropRevision <= this.#lastCropRevision) {
        this.#stats.cropAcksIgnored++; return false;
      }
      this.#active = { ...pending, cropRevision: header.cropRevision };
      this.#pending = null; this.#lastCropRevision = header.cropRevision; this.#nativeFrameSequence = -1;
    } else if (header.status === 'crop-cleared') {
      this.#active = null; this.#phone = null;
      this.#lastCropRevision = Math.max(this.#lastCropRevision, header.cropRevision ?? 0);
    } else if (header.status === 'crop-rejected') {
      if (this.#pending && header.requestId === this.#pending.requestId) {
        this.#pending = null; this.#phone = null;
      }
    } else if (HARD_BLOCKS.has(header.status)) {
      this.#blocked = true; this.#paused = false; this.#source = null;
      this.#clearTransfer(); this.#invalidateAnalysis();
    } else if (header.status === 'source-paused') {
      this.#paused = true; this.#phone = null; this.#stats.sourcePauses++;
      this.#invalidateAnalysis();
    } else if (header.status === 'capture-ready') {
      this.#blocked = false; this.#paused = false;
    } else if (header.status === 'geometry-changed') {
      // The geometry transition was already processed before this dispatch.
      this.#blocked = true;
    }
    this.#nativeState = { status: header.status, errorCode: safeCode(header.errorCode) };
    return true;
  }

  #queueAnalysis(source) {
    if (this.#queuedAnalysis) this.#stats.analysisFramesSkipped++;
    this.#queuedAnalysis = { source, epoch: this.#analysisEpoch };
    if (!this.#analysisBusy) void this.#drainAnalysis();
  }

  async #drainAnalysis() {
    this.#analysisBusy = true;
    try {
      while (!this.#closed && this.#queuedAnalysis) {
        const { source, epoch } = this.#queuedAnalysis; this.#queuedAnalysis = null;
        this.#stats.analysesStarted++;
        let result;
        const previous = this.#active ?? this.#pending;
        const previousRegion = previous && previous.geometryRevision === source.geometryRevision
          ? { layout: previous.layout, crop: copyCrop(previous.crop) } : null;
        try { result = await this.#analyze(Buffer.from(source.buffer), previousRegion); }
        catch { result = null; this.#stats.analysisFailures++; }
        if (this.#closed || this.#mode !== 'auto' || epoch !== this.#analysisEpoch
          || source.geometryRevision !== this.#geometry || source.sequence !== this.#source?.sequence) {
          this.#stats.analysesDiscarded++; continue;
        }
        this.#stats.analysesCompleted++;
        this.#applyDetection(result);
      }
    } finally { this.#analysisBusy = false; }
  }

  #applyDetection(result) {
    this.#stats.lastAutoLayout = LAYOUTS.has(result?.layout) ? result.layout : null;
    this.#stats.lastAutoConfidence = Number.isFinite(result?.confidence) && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : 0;
    if (result?.reason === 'NO_WAVEFORM_PAIR') this.#stats.noPairAnalyses++;
    if (result?.reason === 'AMBIGUOUS_LAYOUT') this.#stats.ambiguousAnalyses++;
    const recognized = result?.status === 'recognized' && LAYOUTS.has(result.layout)
      && Number.isFinite(result.confidence) && result.confidence >= this.#minConfidence
      && result.confidence <= 1 && validCrop(result.crop, this.#source)
      && result.crop.width * result.crop.height <= .60;
    this.#stats.lastAutoReason = recognized ? DETECTOR_REASONS.has(result.reason) ? result.reason : 'SUPPORTED_TWO_DECK_PROFILE'
      : result?.status !== 'recognized' && DETECTOR_REASONS.has(result?.reason) ? result.reason : 'LAYOUT_NOT_CONFIRMED';
    if (recognized && result.reason === 'TRACKED_VERTICAL_LAYOUT') this.#stats.trackedAnalyses++;
    if (recognized && result.reason === 'TRACKED_VERTICAL_SINGLE_DECK') this.#stats.singleDeckTrackedAnalyses++;
    if (recognized && result.reason === 'EMPTY_VERTICAL_LAYOUT') this.#stats.emptyLayoutAnalyses++;
    if (recognized && result.reason === 'EMPTY_HORIZONTAL_LAYOUT') this.#stats.emptyHorizontalAnalyses++;
    if (recognized && result.reason === 'FRAMED_HORIZONTAL_LAYOUT') this.#stats.framedHorizontalAnalyses++;
    if (recognized && result.reason === 'ANCHORED_HORIZONTAL_LAYOUT') this.#stats.anchoredHorizontalAnalyses++;
    if (recognized && result.reason === 'HORIZONTAL_OVERVIEW_LAYOUT') this.#stats.overviewHorizontalAnalyses++;
    if (recognized && result.reason === 'TRACKED_HORIZONTAL_LAYOUT') this.#stats.trackedHorizontalAnalyses++;
    if (recognized && result.reason === 'TRACKED_HORIZONTAL_SINGLE_DECK') this.#stats.singleDeckHorizontalAnalyses++;
    if (!recognized) {
      const hadTransfer = this.#active !== null || this.#pending !== null;
      this.#clearTransfer(); this.#candidate = null;
      if (hadTransfer) this.#clearNative();
      this.#detection = { status: 'unrecognized', layout: null, confidence: 0, crop: null,
        reason: this.#stats.lastAutoReason };
      return;
    }
    // The same window can change orientation without a geometry revision.
    // Hide the old region immediately while confirming the replacement.
    if (this.#active && this.#active.layout !== result.layout) {
      this.#clearTransfer(); this.#clearNative();
    }
    const crop = copyCrop(result.crop);
    if (this.#active && this.#active.layout === result.layout && cropIou(this.#active.crop, crop) >= .9) {
      this.#detection = { status: 'recognized', layout: result.layout, confidence: result.confidence,
        crop: copyCrop(this.#active.crop), reason: this.#stats.lastAutoReason };
      return;
    }
    if (this.#candidate?.layout === result.layout && cropIou(this.#candidate.crop, crop) >= .85) {
      this.#candidate = { layout: result.layout, crop: cropUnion(this.#candidate.crop, crop),
        count: this.#candidate.count + 1, confidence: Math.min(this.#candidate.confidence, result.confidence) };
    } else {
      this.#candidate = { layout: result.layout, crop, count: 1, confidence: result.confidence };
    }
    this.#detection = { status: 'searching', layout: result.layout, confidence: result.confidence,
      crop: copyCrop(this.#candidate.crop), reason: 'WAITING_FOR_STABLE_LAYOUT' };
    if (this.#candidate.count < this.#stableFrames) return;
    const candidate = this.#candidate;
    this.#detection = { status: 'recognized', layout: candidate.layout, confidence: candidate.confidence,
      crop: copyCrop(candidate.crop), reason: this.#stats.lastAutoReason };
    if (this.#pending && this.#pending.layout === candidate.layout && cropIou(this.#pending.crop, candidate.crop) >= .9) return;
    this.#stats.autoRecognitions++;
    this.#requestCrop(candidate.crop, candidate.layout, 'auto');
  }

  #requestCrop(crop, layout, requestedMode) {
    const source = this.#source;
    if (this.#closed || this.#blocked || this.#paused || !source || !validCrop(crop, source)
      || this.#requestId === Number.MAX_SAFE_INTEGER) return rejected('WINDOW_CROP_UNAVAILABLE');
    const pending = { requestId: ++this.#requestId, geometryRevision: this.#geometry,
      crop: copyCrop(crop), layout, sourceWidth: source.captureWidth, sourceHeight: source.captureHeight };
    this.#mode = requestedMode; this.#clearTransfer(); this.#pending = pending;
    this.#stats.cropRequests++;
    let accepted = false;
    try { accepted = this.#native.sendCrop({ requestId: pending.requestId,
      geometryRevision: pending.geometryRevision, crop: copyCrop(pending.crop) }) === true; }
    catch { /* No provider details escape. */ }
    if (!accepted) {
      this.#pending = null; this.#active = null;
      return rejected('WINDOW_CROP_UNAVAILABLE');
    }
    if (requestedMode === 'manual') this.#stats.manualCropsApplied++;
    else this.#stats.autoCropsApplied++;
    return { ok: true };
  }

  setCrop(value) {
    if (!value || !safeInteger(value.geometryRevision) || value.geometryRevision < 1
      || !validCrop(value.crop, this.#source)) return rejected('WINDOW_CROP_INVALID');
    if (value.geometryRevision !== this.#geometry) return rejected('WINDOW_CROP_STALE_GEOMETRY');
    if (this.#closed || !this.#source || this.#blocked || this.#paused) return rejected('WINDOW_CROP_UNAVAILABLE');
    this.#invalidateAnalysis();
    const result = this.#requestCrop(value.crop, null, 'manual');
    if (result.ok) this.#detection = { status: 'manual', layout: null, confidence: 1,
      crop: copyCrop(value.crop), reason: 'MANUAL_SELECTION' };
    return result;
  }

  stopTransfer() {
    if (this.#closed) return rejected('WINDOW_SESSION_CLOSED');
    this.#mode = 'stopped'; this.#clearTransfer(); this.#invalidateAnalysis(); this.#clearNative();
    this.#stats.stops++; return { ok: true };
  }
  requestAuto() {
    if (this.#closed) return rejected('WINDOW_SESSION_CLOSED');
    this.#mode = 'auto'; this.#clearTransfer(); this.#invalidateAnalysis(); this.#clearNative();
    this.#detection = { status: 'searching', layout: null, confidence: 0, crop: null, reason: 'WAITING_FOR_STABLE_LAYOUT' };
    this.#stats.autoRestarts++; return { ok: true };
  }

  #frame(value) {
    if (!value) return null;
    return { buffer: Buffer.from(value.buffer), width: value.width, height: value.height,
      sequence: value.sequence, geometryRevision: value.geometryRevision,
      cropRevision: value.cropRevision, ageMs: this.#age(value.at) };
  }
  getSourceFrame() { return this.#closed || this.#blocked ? null : this.#frame(this.#source); }
  getPhoneFrame() {
    return this.#closed || this.#blocked || this.#paused || !this.#active || this.#mode === 'stopped'
      || this.#lastActivity === null || this.#age(this.#lastActivity) > this.#freshForMs ? null : this.#frame(this.#phone);
  }
  #wakeFrameWaiters(force = false) {
    const frame = force ? null : this.getPhoneFrame();
    for (const waiter of [...this.#frameWaiters]) {
      if (force || frame && frame.sequence > waiter.after) waiter.finish(frame);
    }
  }
  waitForPhoneFrame(after, { signal, timeoutMs = 500 } = {}) {
    if (!safeInteger(after) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000
      || signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('WINDOW_WAIT_INVALID');
    const current = this.getPhoneFrame();
    if (current && current.sequence > after) return Promise.resolve(current);
    if (this.#closed || this.#mode === 'stopped' || !this.#active && !this.#pending || signal?.aborted
      || this.#frameWaiters.size >= 16) return Promise.resolve(null);
    this.#stats.frameWaits++;
    return new Promise(resolve => {
      let timer;
      const waiter = { after, finish: frame => {
        if (!this.#frameWaiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(frame);
      } };
      const aborted = () => { this.#stats.frameWaitsCancelled++; waiter.finish(null); };
      this.#frameWaiters.add(waiter);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => { this.#stats.frameWaitTimeouts++; waiter.finish(null); }, timeoutMs);
      if (signal?.aborted) aborted();
    });
  }
  getState() {
    const source = this.getSourceFrame(), frame = this.getPhoneFrame();
    const enabled = !this.#closed && this.#mode !== 'stopped' && (this.#active !== null || this.#pending !== null);
    const stale = this.#paused || this.#blocked || enabled && this.#lastActivity !== null && this.#age(this.#lastActivity) > this.#freshForMs;
    return { version: '0.1.13', native: { ...this.#nativeState },
      source: { available: source !== null, width: source?.width ?? 0, height: source?.height ?? 0,
        sequence: this.#sourceSequence, geometryRevision: this.#geometry, ageMs: source?.ageMs ?? null },
      detection: { ...this.#detection, crop: copyCrop(this.#detection.crop) },
      transfer: { enabled, status: this.#mode === 'stopped' || this.#closed ? 'stopped'
        : stale && enabled ? 'stale' : frame ? 'live' : 'waiting', sequence: this.#phoneSequence,
        width: frame?.width ?? 0, height: frame?.height ?? 0, geometryRevision: this.#geometry,
        cropRevision: this.#active?.cropRevision ?? 0, ageMs: frame?.ageMs ?? null, unchanged: this.#phoneUnchanged },
      metrics: { ...this.#stats, ...this.#frameRate.read(this.#time()) } };
  }
  getStats() {
    return { ...this.#stats, ...this.#frameRate.read(this.#time()), waitingFrameRequests: this.#frameWaiters.size,
      mode: this.#mode, nativeStatus: this.#nativeState.status,
      errorCode: this.#nativeState.errorCode, geometryRevision: this.#geometry,
      sourceWidth: this.#source?.width ?? 0, sourceHeight: this.#source?.height ?? 0,
      sourceRetainedBytes: this.#source?.buffer.length ?? 0, phoneRetainedBytes: this.#phone?.buffer.length ?? 0,
      activeCrop: Number(this.#active !== null), pendingCrop: Number(this.#pending !== null),
      analysisBusy: Number(this.#analysisBusy), queuedAnalyses: Number(this.#queuedAnalysis !== null),
      layout: this.#detection.layout, detectionStatus: this.#detection.status, closed: Number(this.#closed),
      endToEndLatencyMeasured: false };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#mode = 'stopped'; this.#source = null;
    this.#clearTransfer(); this.#invalidateAnalysis(); this.#clearNative();
  }
}
