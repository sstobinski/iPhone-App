import { Worker } from 'node:worker_threads';
import { inspectWindowJpeg } from './jpeg.mjs';
import { readPreviousRegion } from './region-context.mjs';

const failure = code => Object.assign(new Error(code), { code });
/** Decoding never blocks the HTTP thread. The session bounds its pending input. */
export class LayoutAnalyzer {
  #worker = null;
  #pending = null;
  #sequence = 0;
  #closed = false;
  #timeoutMs;
  #stats = { requests: 0, completed: 0, failures: 0, timeouts: 0 };
  constructor({ timeoutMs = 3000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) throw failure('CAPTURE_ANALYSIS_OPTIONS_INVALID');
    this.#timeoutMs = timeoutMs;
  }
  #ensureWorker() {
    if (this.#worker) return;
    const worker = new Worker(new URL('./analysis-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    });
    this.#worker = worker;
    worker.on('message', value => {
      const pending = this.#pending;
      if (worker !== this.#worker || !pending || value?.id !== pending.id) return;
      clearTimeout(pending.timer); this.#pending = null;
      if (value.errorCode || !value.result) {
        this.#stats.failures++; pending.reject(failure('CAPTURE_ANALYSIS_INVALID'));
      } else { this.#stats.completed++; pending.resolve(value.result); }
    });
    const fail = () => {
      if (worker !== this.#worker) return;
      this.#worker = null;
      const pending = this.#pending; this.#pending = null;
      if (pending) {
        clearTimeout(pending.timer); this.#stats.failures++;
        pending.reject(failure('CAPTURE_ANALYSIS_FAILED'));
      }
    };
    worker.once('error', fail); worker.once('exit', fail);
  }
  async analyze(bytes, previousRegion = null) {
    if (this.#closed) throw failure('CAPTURE_ANALYSIS_CLOSED');
    if (this.#pending) throw failure('CAPTURE_ANALYSIS_BUSY');
    inspectWindowJpeg(bytes);
    this.#ensureWorker(); this.#stats.requests++;
    const id = ++this.#sequence, copy = Uint8Array.from(bytes);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = null; this.#stats.timeouts++;
        const worker = this.#worker; this.#worker = null;
        void worker?.terminate(); reject(failure('CAPTURE_ANALYSIS_TIMEOUT'));
      }, this.#timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      try { this.#worker.postMessage({ id, bytes: copy, previousRegion: readPreviousRegion(previousRegion) }, [copy.buffer]); }
      catch {
        clearTimeout(timer); this.#pending = null; this.#stats.failures++;
        reject(failure('CAPTURE_ANALYSIS_FAILED'));
      }
    });
  }
  getStats() { return { ...this.#stats, busy: Number(this.#pending !== null) }; }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(failure('CAPTURE_ANALYSIS_CLOSED')); this.#pending = null;
    }
    const worker = this.#worker; this.#worker = null;
    await worker?.terminate();
  }
}
