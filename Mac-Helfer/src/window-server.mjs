import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP as addressVersion } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWindowJpeg } from './jpeg.mjs';
import { ClientPerformanceCollector, readClientPerformance } from './performance.mjs';

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/crop.js', ['crop.js', 'text/javascript; charset=utf-8']],
  ['/frame-stats.js', ['frame-stats.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
};
const MAX_BODY_BYTES = 4096;
const MAX_STATE_BYTES = 128 * 1024;
const FAILURE = code => Object.assign(new Error(code), { code });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

/** Only the actual TCP peer controls access to full-window source pixels. */
export function isLoopbackAddress(value) {
  const address = String(value ?? '').replace(/^::ffff:/i, '').split('%')[0];
  return address === '::1' || addressVersion(address) === 4 && /^127\./.test(address);
}

function interfaceAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flatMap(records => records ?? [])
    .filter(record => !record.internal && addressVersion(record.address) === 4).map(record => record.address))];
}
function privateRank(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}
function phoneAddress(address) {
  return addressVersion(address) === 4 && !isLoopbackAddress(address)
    && address !== '0.0.0.0' && address !== '255.255.255.255';
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
export function validWindowCropRequest(value) {
  if (!exactKeys(value, ['geometryRevision', 'crop']) || !positive(value.geometryRevision)
    || !exactKeys(value.crop, ['x', 'y', 'width', 'height'])) return false;
  const { x, y, width, height } = value.crop;
  return [x, y, width, height].every(number => typeof number === 'number' && Number.isFinite(number))
    && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1;
}

/** Authenticated local read-only image transport. Only cropped phone frames are
 * remotely accessible. Source previews and crop/stop/auto actions are loopback-only.
 * getState must already return the public model; this class adds the genuine admin role. */
export class WindowServer {
  #callbacks; #token; #host; #requestedPort; #addresses; #webRoot;
  #server = null; #abort = null; #closing = false; #closePromise = null;
  #port = null; #urls = []; #localUrl = null; #allowedHosts = new Set(); #sockets = new Set();
  #clientPerformance = new ClientPerformanceCollector();
  #stats = { requests: 0, apiRequests: 0, stateResponses: 0, sourceFrames: 0, phoneFrames: 0,
    unchangedFrames: 0, invalidFrames: 0, cropRequests: 0, stopRequests: 0, autoRequests: 0,
    unauthorizedRequests: 0, rejectedHosts: 0, rejectedOrigins: 0, rejectedRemoteAdmin: 0,
    bodyRejections: 0, serverErrors: 0, longPollRequests: 0, clientMetricReports: 0 };

  constructor({ token, getState, getSourceFrame = () => null, getPhoneFrame = () => null,
    setCrop = () => ({ ok: false }), stopTransfer = () => ({ ok: false }), requestAuto = () => ({ ok: false }),
    getConnectionQr = null, waitForPhoneFrame = null, host = '0.0.0.0', port = 0, connectionAddresses = interfaceAddresses(),
    webRoot = new URL('../web/', import.meta.url) } = {}) {
    for (const callback of [getState, getSourceFrame, getPhoneFrame, setCrop, stopTransfer, requestAuto]) {
      if (typeof callback !== 'function') throw new TypeError('WINDOW_CALLBACK_REQUIRED');
    }
    if (getConnectionQr !== null && typeof getConnectionQr !== 'function') throw new TypeError('WINDOW_CALLBACK_REQUIRED');
    if (waitForPhoneFrame !== null && typeof waitForPhoneFrame !== 'function') throw new TypeError('WINDOW_CALLBACK_REQUIRED');
    if (typeof token !== 'string' || token.length < 1 || token.length > 4096) throw new TypeError('WINDOW_TOKEN_REQUIRED');
    if (!Array.isArray(connectionAddresses)) throw new TypeError('WINDOW_ADDRESSES_INVALID');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('WINDOW_PORT_INVALID');
    this.#callbacks = { getState, getSourceFrame, getPhoneFrame, setCrop, stopTransfer, requestAuto, getConnectionQr, waitForPhoneFrame };
    this.#token = Buffer.from(token, 'utf8'); this.#host = host; this.#requestedPort = port;
    this.#addresses = [...new Set(connectionAddresses.filter(address => typeof address === 'string' && addressVersion(address) === 4))];
    this.#webRoot = webRoot instanceof URL ? fileURLToPath(webRoot) : webRoot;
  }

  async start() {
    if (this.#server) throw FAILURE('WINDOW_SERVER_ALREADY_RUNNING');
    this.#closing = false; this.#closePromise = null; this.#abort = new AbortController();
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        this.#stats.serverErrors++;
        if (!response.headersSent) this.#json(response, 500, { error: 'WINDOW_REQUEST_FAILED' });
        else response.end();
      });
    });
    this.#server = server;
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
    server.on('connection', socket => {
      this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket));
    });
    server.on('error', () => { this.#stats.serverErrors++; });
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.removeListener('error', onError); this.#abort.signal.removeEventListener('abort', onAbort); };
        const onError = () => { cleanup(); reject(FAILURE('WINDOW_SERVER_LISTEN_FAILED')); };
        const onAbort = () => { cleanup(); reject(FAILURE('WINDOW_SERVER_START_CANCELLED')); };
        server.once('error', onError); this.#abort.signal.addEventListener('abort', onAbort, { once: true });
        server.listen({ host: this.#host, port: this.#requestedPort, signal: this.#abort.signal }, () => { cleanup(); resolve(); });
      });
      if (this.#closing) throw FAILURE('WINDOW_SERVER_START_CANCELLED');
      this.#port = server.address().port;
      this.#allowedHosts = new Set(['localhost', '127.0.0.1', ...this.#addresses]
        .flatMap(host => this.#port === 80 ? [host, `${host}:80`] : [`${host}:${this.#port}`]));
      const key = encodeURIComponent(this.#token.toString('utf8'));
      this.#urls = this.#addresses.filter(phoneAddress).sort((a, b) => privateRank(a) - privateRank(b))
        .map(address => `http://${address}:${this.#port}/#key=${key}`);
      this.#localUrl = `http://127.0.0.1:${this.#port}/?setup=1#key=${key}`;
      return { localUrl: this.#localUrl, urls: [...this.#urls], port: this.#port };
    } catch (error) {
      await this.close();
      throw error?.code ? error : FAILURE('WINDOW_SERVER_START_FAILED');
    }
  }

  getStats() { return { ...this.#stats, activeConnections: this.#sockets.size,
    clientPerformance: this.#clientPerformance.getStats() }; }
  #authorized(request) {
    const value = request.headers.authorization;
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
    const bytes = Buffer.from(value.slice(7), 'utf8');
    return bytes.length === this.#token.length && timingSafeEqual(bytes, this.#token);
  }
  #json(response, status, value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) {
      response.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"error":"WINDOW_STATE_TOO_LARGE"}'); return;
    }
    response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    response.end(data);
  }
  #empty(response, status = 204) { response.writeHead(status, SECURITY_HEADERS); response.end(); }
  #rejectRemote(request, response) {
    if (isLoopbackAddress(request.socket.remoteAddress)) return false;
    this.#stats.rejectedRemoteAdmin++;
    this.#json(response, 403, { error: 'WINDOW_LOCAL_ONLY' });
    return true;
  }
  #bodyless(request, response) {
    if (request.headers['transfer-encoding'] !== undefined
      || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') {
      this.#stats.bodyRejections++; response.setHeader('Connection', 'close');
      this.#json(response, 400, { error: 'WINDOW_BODY_NOT_ALLOWED' }); return false;
    }
    return true;
  }
  async #readObject(request, response, sanitize = null, invalidCode = 'WINDOW_CROP_INVALID') {
    if (request.headers['content-type'] !== 'application/json'
      && request.headers['content-type'] !== 'application/json; charset=utf-8') {
      response.setHeader('Connection', 'close'); this.#json(response, 415, { error: 'WINDOW_CONTENT_TYPE_INVALID' }); return null;
    }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      this.#stats.bodyRejections++; response.setHeader('Connection', 'close');
      this.#json(response, 413, { error: 'WINDOW_BODY_TOO_LARGE' }); return null;
    }
    return await new Promise(resolve => {
      const parts = []; let size = 0, settled = false;
      const cleanup = () => {
        clearTimeout(timer); request.removeListener('data', onData); request.removeListener('end', onEnd);
        request.removeListener('aborted', onAbort); request.removeListener('error', onAbort);
      };
      const finish = value => { if (settled) return; settled = true; cleanup(); resolve(value); };
      const fail = (status, error) => {
        this.#stats.bodyRejections++;
        if (!response.destroyed && !response.headersSent) {
          response.setHeader('Connection', 'close'); this.#json(response, status, { error });
        }
        request.pause(); finish(null);
      };
      const onData = part => {
        size += part.length;
        if (size > MAX_BODY_BYTES) fail(413, 'WINDOW_BODY_TOO_LARGE'); else parts.push(part);
      };
      const onEnd = () => {
        let value;
        try { value = JSON.parse(Buffer.concat(parts, size).toString('utf8')); }
        catch { fail(400, invalidCode); return; }
        if (sanitize) {
          const safe = sanitize(value);
          if (!safe) { fail(400, invalidCode); return; }
          finish(safe); return;
        }
        if (!validWindowCropRequest(value)) { fail(400, 'WINDOW_CROP_INVALID'); return; }
        finish({ geometryRevision: value.geometryRevision, crop: { ...value.crop } });
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => fail(408, 'WINDOW_BODY_TIMEOUT'), 5000);
      request.on('data', onData); request.once('end', onEnd); request.once('aborted', onAbort); request.once('error', onAbort);
    });
  }
  async #action(response, callback, input) {
    try {
      const result = await callback(input);
      if (result?.ok === true) this.#json(response, 200, { ok: true });
      else this.#json(response, 409, { error: 'WINDOW_ACTION_REJECTED' });
    } catch { this.#json(response, 503, { error: 'WINDOW_ACTION_FAILED' }); }
  }
  async #frame(response, frame, after, source) {
    if (!frame || !positive(frame.sequence) || frame.sequence <= after) {
      this.#stats.unchangedFrames++; this.#empty(response); return;
    }
    try {
      const dimensions = inspectWindowJpeg(frame.buffer);
      if (dimensions.width !== frame.width || dimensions.height !== frame.height
        || !positive(frame.geometryRevision) || !nonnegative(frame.cropRevision ?? 0)
        || !Number.isFinite(frame.ageMs) || frame.ageMs < 0) throw FAILURE('WINDOW_FRAME_INVALID');
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': frame.buffer.length,
        'X-Frame-Sequence': String(frame.sequence), 'X-Frame-Geometry': String(frame.geometryRevision),
        'X-Frame-Crop': String(frame.cropRevision ?? 0), 'X-Frame-Width': String(frame.width),
        'X-Frame-Height': String(frame.height), 'X-Frame-Age-Ms': String(Math.round(frame.ageMs)) });
      response.end(frame.buffer);
      if (source) this.#stats.sourceFrames++; else this.#stats.phoneFrames++;
    } catch {
      this.#stats.invalidFrames++; this.#json(response, 503, { error: 'WINDOW_FRAME_INVALID' });
    }
  }

  async #handle(request, response) {
    request.on('error', () => {});
    response.setTimeout(5000, () => response.destroy());
    this.#stats.requests++;
    const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
    if (!this.#allowedHosts.has(host)) { this.#stats.rejectedHosts++; this.#json(response, 403, { error: 'HOST_NOT_ALLOWED' }); return; }
    if (this.#closing) { this.#json(response, 503, { error: 'WINDOW_SERVER_CLOSING' }); return; }
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) {
      this.#json(response, 400, { error: 'INVALID_REQUEST_TARGET' }); return;
    }
    let url;
    try {
      const decoded = decodeURIComponent(request.url.split(/[?#]/, 1)[0]);
      if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) {
        this.#json(response, 404, { error: 'NOT_FOUND' }); return;
      }
      url = new URL(request.url, `http://${host}`);
    } catch { this.#json(response, 400, { error: 'INVALID_REQUEST_TARGET' }); return; }
    if (url.pathname.startsWith('/api/')) {
      this.#stats.apiRequests++;
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        this.#stats.rejectedOrigins++; this.#json(response, 403, { error: 'ORIGIN_NOT_ALLOWED' }); return;
      }
      const action = request.method === 'POST' && ['/api/crop', '/api/stop', '/api/auto'].includes(url.pathname);
      const diagnostics = request.method === 'POST' && url.pathname === '/api/client-metrics';
      if (request.method !== 'GET' && !action && !diagnostics) {
        response.setHeader('Allow', 'GET'); this.#json(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return;
      }
      if (!this.#authorized(request)) {
        this.#stats.unauthorizedRequests++; response.setHeader('WWW-Authenticate', 'Bearer');
        this.#json(response, 401, { error: 'UNAUTHORIZED' }); return;
      }
      if (diagnostics) {
        if (url.searchParams.size) { this.#json(response, 400, { error: 'WINDOW_QUERY_INVALID' }); return; }
        const value = await this.#readObject(request, response, readClientPerformance, 'WINDOW_METRICS_INVALID');
        if (!value) return;
        const role = isLoopbackAddress(request.socket.remoteAddress) ? 'mac-preview' : 'phone';
        if (!this.#clientPerformance.accept(value, role)) { this.#json(response, 409, { error: 'WINDOW_METRICS_REJECTED' }); return; }
        this.#stats.clientMetricReports++; this.#json(response, 200, { ok: true }); return;
      }
      if (action) {
        if (this.#rejectRemote(request, response)) return;
        if (url.searchParams.size) { this.#json(response, 400, { error: 'WINDOW_QUERY_INVALID' }); return; }
        if (url.pathname === '/api/crop') {
          const value = await this.#readObject(request, response); if (!value) return;
          this.#stats.cropRequests++; await this.#action(response, this.#callbacks.setCrop, value); return;
        }
        if (!this.#bodyless(request, response)) return;
        if (url.pathname === '/api/stop') { this.#stats.stopRequests++; await this.#action(response, this.#callbacks.stopTransfer); return; }
        this.#stats.autoRequests++; await this.#action(response, this.#callbacks.requestAuto); return;
      }
      if (url.pathname === '/api/state') {
        if (url.searchParams.size) { this.#json(response, 400, { error: 'WINDOW_QUERY_INVALID' }); return; }
        this.#stats.stateResponses++;
        this.#json(response, 200, { ...await this.#callbacks.getState(), admin: isLoopbackAddress(request.socket.remoteAddress) }); return;
      }
      if (url.pathname === '/api/frame' || url.pathname === '/api/source') {
        const source = url.pathname === '/api/source';
        if (source && this.#rejectRemote(request, response)) return;
        const afterText = url.searchParams.get('after') ?? '0';
        const after = /^(?:0|[1-9]\d{0,15})$/.test(afterText) ? Number(afterText) : NaN;
        const wait = url.searchParams.get('wait') ?? '0';
        const allowed = source ? ['after'] : ['after', 'wait'];
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
          || !nonnegative(after) || !['0', '1'].includes(wait)) {
          this.#json(response, 400, { error: 'WINDOW_QUERY_INVALID' }); return;
        }
        if (!source && wait === '1' && this.#callbacks.waitForPhoneFrame) {
          this.#stats.longPollRequests++;
          const controller = new AbortController(), closed = () => controller.abort();
          response.once('close', closed);
          let timer;
          const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 550); });
          try { await Promise.race([this.#callbacks.waitForPhoneFrame(after, { signal: controller.signal, timeoutMs: 500 }), deadline]); }
          finally { clearTimeout(timer); response.removeListener('close', closed); controller.abort(); }
          if (response.destroyed) return;
        }
        await this.#frame(response, await this.#callbacks[source ? 'getSourceFrame' : 'getPhoneFrame'](), after, source); return;
      }
      if (url.pathname === '/api/connection') {
        if (url.searchParams.size) { this.#json(response, 400, { error: 'WINDOW_QUERY_INVALID' }); return; }
        this.#json(response, 200, { urls: [...this.#urls], port: this.#port,
          ...(isLoopbackAddress(request.socket.remoteAddress) ? { localUrl: this.#localUrl } : {}) }); return;
      }
      if (url.pathname === '/api/qr') {
        const text = url.searchParams.get('index') ?? '0';
        const index = /^(?:0|[1-9]\d*)$/.test(text) ? Number(text) : -1;
        if (url.searchParams.size > 1 || url.searchParams.size === 1 && url.searchParams.getAll('index').length !== 1
          || !Number.isSafeInteger(index) || index < 0 || index >= this.#urls.length) {
          this.#json(response, 400, { error: 'WINDOW_QR_INDEX_INVALID' }); return;
        }
        if (!this.#callbacks.getConnectionQr) { this.#json(response, 503, { error: 'WINDOW_QR_UNAVAILABLE' }); return; }
        const svg = await this.#callbacks.getConnectionQr(this.#urls[index]);
        if (typeof svg !== 'string' || Buffer.byteLength(svg) > 512 * 1024) throw FAILURE('WINDOW_QR_INVALID');
        response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg) }); response.end(svg); return;
      }
      this.#json(response, 404, { error: 'NOT_FOUND' }); return;
    }
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); this.#json(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    const resource = STATIC_FILES.get(url.pathname);
    if (!resource) { this.#json(response, 404, { error: 'NOT_FOUND' }); return; }
    let data;
    try { data = await readFile(join(this.#webRoot, resource[0])); }
    catch { this.#json(response, 404, { error: 'NOT_FOUND' }); return; }
    response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': resource[1], 'Content-Length': data.length }); response.end(data);
  }

  async close() {
    if (this.#closePromise) return await this.#closePromise;
    this.#closing = true; this.#abort?.abort();
    const server = this.#server;
    this.#closePromise = (async () => {
      if (!server) return;
      await new Promise(resolve => {
        server.close(() => resolve());
        for (const socket of this.#sockets) socket.destroy();
      });
      this.#server = null; this.#sockets.clear();
    })();
    return await this.#closePromise;
  }
}
