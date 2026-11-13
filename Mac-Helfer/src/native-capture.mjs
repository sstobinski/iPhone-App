import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { inspectWindowJpeg, MAX_FRAME_BYTES } from './jpeg.mjs';
import { readCaptureDimensions } from './capture-geometry.mjs';
import { readCapturePerformance } from './performance.mjs';

export const MAX_NATIVE_HEADER_BYTES = 4096;
const PREFIX_BYTES = 12;
const MAGIC = Buffer.from('SWC1');
const MAX_COMMAND_BUFFER = 8192;
const MAX_STDERR_BYTES = 64 * 1024;
const STATUS_NAMES = new Set(['permission-required', 'waiting-for-serato', 'multiple-windows',
  'window-found', 'capture-ready', 'geometry-changed', 'crop-applied', 'crop-cleared',
  'crop-rejected', 'source-idle', 'source-paused', 'capture-error', 'stopped']);
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const safeMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
const failure = code => Object.assign(new Error(code), { code });
const safeCode = value => typeof value === 'string' && /^CAPTURE_[A-Z0-9_]{1,60}$/.test(value);
const increment = (value, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);

function publicHeader(value, jpeg) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['status', 'analysis', 'frame'].includes(value.type)) throw failure('CAPTURE_PACKET_INVALID');
  const result = { type: value.type };
  if (value.type === 'status') {
    if (jpeg.length !== 0 || !STATUS_NAMES.has(value.status)) throw failure('CAPTURE_PACKET_INVALID');
    result.status = value.status;
    for (const name of ['geometryRevision', 'cropRevision', 'requestId']) {
      if (value[name] !== undefined) {
        if (!safeInteger(value[name])) throw failure('CAPTURE_PACKET_INVALID');
        result[name] = value[name];
      }
    }
    if (value.status === 'crop-applied' && (!safeInteger(value.geometryRevision, 1)
      || !safeInteger(value.cropRevision, 1) || !safeInteger(value.requestId, 1))) throw failure('CAPTURE_PACKET_INVALID');
    if (value.errorCode !== undefined && value.errorCode !== null) {
      if (!safeCode(value.errorCode)) throw failure('CAPTURE_PACKET_INVALID');
      result.errorCode = value.errorCode;
    }
  } else {
    if (!safeInteger(value.width, 1) || !safeInteger(value.height, 1)
      || value.width > 4096 || value.height > 4096 || value.width * value.height > 8_000_000
      || !safeInteger(value.sequence) || !safeInteger(value.geometryRevision, 1)
      || !safeInteger(value.cropRevision) || jpeg.length === 0
      || value.type === 'frame' && !safeInteger(value.requestId, 1)) throw failure('CAPTURE_PACKET_INVALID');
    let dimensions;
    try { dimensions = inspectWindowJpeg(jpeg); }
    catch { throw failure('CAPTURE_PACKET_INVALID'); }
    if (dimensions.width !== value.width || dimensions.height !== value.height) throw failure('CAPTURE_PACKET_INVALID');
    Object.assign(result, { width: value.width, height: value.height, sequence: value.sequence,
      geometryRevision: value.geometryRevision, cropRevision: value.cropRevision });
    if (value.type === 'analysis') {
      const capture = readCaptureDimensions(value);
      if (!capture) throw failure('CAPTURE_PACKET_INVALID');
      if (value.captureWidth !== undefined) Object.assign(result, capture);
    }
    if (value.requestId !== undefined) {
      if (!safeInteger(value.requestId) || value.type === 'frame' && value.requestId < 1) throw failure('CAPTURE_PACKET_INVALID');
      result.requestId = value.requestId;
    }
  }
  for (const name of ['encodeMs', 'sourceAgeMs']) {
    if (value[name] !== undefined) {
      if (!safeMetric(value[name])) throw failure('CAPTURE_PACKET_INVALID');
      result[name] = value[name];
    }
  }
  if (value.performance !== undefined) {
    const metrics = readCapturePerformance(value.performance);
    if (!metrics || value.type !== 'analysis') throw failure('CAPTURE_PACKET_INVALID');
    result.performance = metrics;
  }
  return result;
}

/** Bounded incremental SWC1 parser. A single allocation contains at most one
 * header and JPEG; an arbitrarily large input chunk is never concatenated. */
export class NativePacketParser {
  #onPacket;
  #prefix = Buffer.alloc(PREFIX_BYTES);
  #prefixUsed = 0;
  #payload = null;
  #payloadUsed = 0;
  #headerLength = 0;
  #jpegLength = 0;
  #closed = false;
  #failed = false;
  #packets = 0;

  constructor({ onPacket = () => {} } = {}) {
    if (typeof onPacket !== 'function') throw failure('CAPTURE_OPTIONS_INVALID');
    this.#onPacket = onPacket;
  }

  #clear() {
    this.#prefixUsed = 0; this.#payload = null; this.#payloadUsed = 0;
    this.#headerLength = 0; this.#jpegLength = 0;
  }

  push(chunk) {
    if (this.#closed) return 0;
    if (this.#failed) throw failure('CAPTURE_PACKET_INVALID');
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
      this.#failed = true; this.#clear(); throw failure('CAPTURE_PACKET_INVALID');
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0, completed = 0;
    try {
      while (offset < bytes.length) {
        if (this.#prefixUsed < PREFIX_BYTES) {
          const length = Math.min(PREFIX_BYTES - this.#prefixUsed, bytes.length - offset);
          bytes.copy(this.#prefix, this.#prefixUsed, offset, offset + length);
          this.#prefixUsed += length; offset += length;
          if (this.#prefixUsed < PREFIX_BYTES) continue;
          if (!this.#prefix.subarray(0, 4).equals(MAGIC)) throw failure('CAPTURE_PACKET_INVALID');
          this.#headerLength = this.#prefix.readUInt32BE(4);
          this.#jpegLength = this.#prefix.readUInt32BE(8);
          if (this.#headerLength < 2 || this.#headerLength > MAX_NATIVE_HEADER_BYTES
            || this.#jpegLength > MAX_FRAME_BYTES) throw failure('CAPTURE_PACKET_INVALID');
          this.#payload = Buffer.alloc(this.#headerLength + this.#jpegLength);
        }
        const length = Math.min(this.#payload.length - this.#payloadUsed, bytes.length - offset);
        bytes.copy(this.#payload, this.#payloadUsed, offset, offset + length);
        this.#payloadUsed += length; offset += length;
        if (this.#payloadUsed < this.#payload.length) continue;
        let raw;
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.#payload.subarray(0, this.#headerLength))); }
        catch { throw failure('CAPTURE_PACKET_INVALID'); }
        const jpeg = this.#payload.subarray(this.#headerLength);
        const header = publicHeader(raw, jpeg);
        // Clear before calling consumers; no parser-owned image survives a
        // callback and a callback may deliberately close the parser.
        this.#clear(); this.#packets = increment(this.#packets); completed++;
        this.#onPacket({ header, jpeg });
        if (this.#closed) break;
      }
    } catch {
      this.#failed = true; this.#clear(); throw failure('CAPTURE_PACKET_INVALID');
    }
    return completed;
  }

  finish() {
    if (this.#closed) return;
    if (this.#failed || this.#prefixUsed !== 0 || this.#payload !== null) {
      this.#failed = true; this.#clear(); throw failure('CAPTURE_PACKET_INVALID');
    }
  }
  close() { this.#closed = true; this.#clear(); }
  getStats() { return { packetsParsed: this.#packets, bufferedBytes: this.#prefixUsed + this.#payloadUsed,
    allocatedPayloadBytes: this.#payload?.length ?? 0, closed: Number(this.#closed), failed: Number(this.#failed) }; }
}

function validCrop(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(name => typeof value[name] === 'number' && Number.isFinite(value[name]))) return false;
  return value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= 1 && value.y + value.height <= 1;
}

/** Owns one native subprocess. Native stdout is a binary packet stream and
 * never reaches a terminal or diagnostic file. */
export class NativeCapture extends EventEmitter {
  #helperPath;
  #spawn;
  #platform;
  #frameRate;
  #graceMs;
  #deadlineMs;
  #child = null;
  #parser = null;
  #startPromise = null;
  #resolveStart = null;
  #rejectStart = null;
  #started = false;
  #running = false;
  #stopping = false;
  #stopPromise = null;
  #exitPromise = null;
  #resolveExit = null;
  #exited = false;
  #stats = { packetsReceived: 0, analysisFrames: 0, croppedFrames: 0,
    statusPackets: 0, stdoutBytes: 0, stderrBytes: 0, commandsSent: 0,
    issues: 0, lastErrorCode: null };

  constructor({ helperPath, spawnImpl = spawn, platform = process.platform, frameRate = 60,
    stopGraceMs = 400, stopDeadlineMs = 1800 } = {}) {
    super();
    if (![30, 60].includes(frameRate) || typeof helperPath !== 'string' || !isAbsolute(helperPath) || helperPath.includes('\0')
      || helperPath.length > 16384 || typeof spawnImpl !== 'function'
      || !Number.isInteger(stopGraceMs) || stopGraceMs < 0 || stopGraceMs > 1000
      || !Number.isInteger(stopDeadlineMs) || stopDeadlineMs <= stopGraceMs || stopDeadlineMs > 2000) throw failure('CAPTURE_OPTIONS_INVALID');
    this.#helperPath = helperPath; this.#spawn = spawnImpl; this.#platform = platform;
    this.#frameRate = frameRate;
    this.#graceMs = stopGraceMs; this.#deadlineMs = stopDeadlineMs;
  }

  #issue(code) {
    const safe = safeCode(code) ? code : 'CAPTURE_NATIVE_FAILED';
    this.#stats.lastErrorCode = safe; this.#stats.issues = increment(this.#stats.issues);
    this.emit('issue', safe);
  }

  #startFailed(code) {
    if (this.#rejectStart) { this.#rejectStart(failure(code)); this.#resolveStart = null; this.#rejectStart = null; }
  }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopping) return Promise.reject(failure('CAPTURE_START_CANCELLED'));
    if (this.#platform !== 'darwin') return Promise.reject(failure('CAPTURE_UNSUPPORTED_PLATFORM'));
    this.#started = true;
    this.#startPromise = new Promise((resolve, reject) => { this.#resolveStart = resolve; this.#rejectStart = reject; });
    // A cancellation may precede the caller's await continuation.
    this.#startPromise.catch(() => {});
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    this.#parser = new NativePacketParser({ onPacket: packet => {
      if (this.#stopping) return;
      this.#stats.packetsReceived = increment(this.#stats.packetsReceived);
      const key = packet.header.type === 'frame' ? 'croppedFrames' : packet.header.type === 'analysis' ? 'analysisFrames' : 'statusPackets';
      this.#stats[key] = increment(this.#stats[key]);
      if (packet.header.performance) this.#stats.performance = packet.header.performance;
      this.emit('packet', packet);
    } });
    let child;
    try {
      child = this.#spawn(this.#helperPath, ['--fps', String(this.#frameRate)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr || !child.stdin) throw failure('CAPTURE_START_FAILED');
      this.#child = child;
    } catch {
      this.#exited = true; this.#resolveExit(); this.#startFailed('CAPTURE_START_FAILED');
      this.#issue('CAPTURE_START_FAILED'); this.#parser.close();
      return this.#startPromise;
    }
    child.once('spawn', () => {
      if (this.#stopping) { this.#startFailed('CAPTURE_START_CANCELLED'); return; }
      this.#running = true;
      this.#resolveStart?.({ running: true }); this.#resolveStart = null; this.#rejectStart = null;
    });
    child.on('error', () => {
      if (!this.#stopping) { this.#startFailed('CAPTURE_START_FAILED'); this.#issue('CAPTURE_NATIVE_FAILED'); }
      this.#running = false; this.#exited = true; this.#resolveExit?.();
      void this.stop();
    });
    const ended = () => {
      if (this.#exited) return;
      this.#exited = true; this.#running = false; this.#resolveExit?.();
      if (!this.#stopping) {
        this.#startFailed('CAPTURE_START_FAILED'); this.#issue('CAPTURE_PROCESS_EXITED');
        void this.stop();
      }
    };
    child.once('exit', ended); child.once('close', ended);
    child.stdout.on('data', chunk => {
      if (this.#stopping) return;
      this.#stats.stdoutBytes = increment(this.#stats.stdoutBytes, chunk.length);
      try { this.#parser.push(chunk); }
      catch { this.#issue('CAPTURE_PACKET_INVALID'); void this.stop(); }
    });
    child.stdout.on('end', () => {
      if (this.#stopping) return;
      try { this.#parser.finish(); }
      catch { this.#issue('CAPTURE_PACKET_INVALID'); void this.stop(); return; }
      this.#issue('CAPTURE_STREAM_ENDED'); void this.stop();
    });
    child.stderr.on('data', chunk => {
      // Retain only a byte count. Swift errors may contain local source paths.
      this.#stats.stderrBytes = increment(this.#stats.stderrBytes, chunk.length);
      if (!this.#stopping && this.#stats.stderrBytes > MAX_STDERR_BYTES) {
        this.#issue('CAPTURE_STDERR_LIMIT'); void this.stop();
      }
    });
    child.stdin.on('error', () => {
      if (!this.#stopping) { this.#issue('CAPTURE_COMMAND_FAILED'); void this.stop(); }
    });
    return this.#startPromise;
  }

  #writeCommand(command) {
    const input = this.#child?.stdin;
    if (!this.#running || this.#stopping || !input || input.destroyed || input.writableEnded
      || input.writableLength > MAX_COMMAND_BUFFER) return false;
    try {
      input.write(JSON.stringify(command) + '\n', error => {
        if (error && !this.#stopping) { this.#issue('CAPTURE_COMMAND_FAILED'); void this.stop(); }
      });
      this.#stats.commandsSent = increment(this.#stats.commandsSent);
      return true; // write(false) still queued this bounded command successfully.
    } catch { this.#issue('CAPTURE_COMMAND_FAILED'); void this.stop(); return false; }
  }

  sendCrop(value) {
    try {
      if (!safeInteger(value?.geometryRevision, 1) || !safeInteger(value?.requestId, 1) || !validCrop(value?.crop)) return false;
      const { x, y, width, height } = value.crop;
      return this.#writeCommand({ command: 'setCrop', geometryRevision: value.geometryRevision,
        requestId: value.requestId, crop: { x, y, width, height } });
    } catch { return false; }
  }
  clearCrop() { return this.#writeCommand({ command: 'clearCrop' }); }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true; this.#running = false;
    this.#startFailed('CAPTURE_START_CANCELLED'); this.#parser?.close();
    this.#stopPromise = (async () => {
      const child = this.#child;
      if (!child || this.#exited) return;
      try {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
          if (child.stdin.writableLength <= MAX_COMMAND_BUFFER) child.stdin.write('{"command":"stop"}\n');
          child.stdin.end();
        }
      } catch { /* Signals below are the bounded fallback. */ }
      let terminateTimer, killTimer;
      const deadline = new Promise(resolve => {
        terminateTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, this.#graceMs);
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, this.#deadlineMs);
      });
      await Promise.race([this.#exitPromise, deadline]);
      clearTimeout(terminateTimer); clearTimeout(killTimer);
      this.#child = null;
    })();
    return this.#stopPromise;
  }

  getStats() { return { ...this.#stats, started: Number(this.#started), running: Number(this.#running),
    stopped: Number(this.#stopping), parserBufferedBytes: this.#parser?.getStats().bufferedBytes ?? 0 }; }
}
