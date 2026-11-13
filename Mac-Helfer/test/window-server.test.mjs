import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowServer, isLoopbackAddress, validWindowCropRequest } from '../src/window-server.mjs';
import { inspectWindowJpeg, MAX_FRAME_BYTES } from '../src/jpeg.mjs';

const TOKEN = 'window-http-test-0123456789abcdef';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCKiiivmz8yP//Z', 'base64');
const FRAME = () => ({ buffer: Buffer.from(JPEG), width: 16, height: 16, sequence: 3,
  geometryRevision: 2, cropRevision: 1, ageMs: 12.25 });
const CROP = { geometryRevision: 2, crop: { x: .1, y: .2, width: .7, height: .5 } };

async function fixture(t, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'window-http-'));
  for (const name of ['index.html', 'app.js', 'crop.js', 'frame-stats.js', 'style.css']) await writeFile(join(folder, name), `fixture ${name}`);
  await writeFile(join(folder, 'private.jpg'), JPEG);
  const calls = { source: 0, phone: 0, crop: [], stop: 0, auto: 0, qr: [] };
  let source = FRAME(), phone = FRAME();
  const server = new WindowServer({ token: TOKEN, webRoot: folder, host: '127.0.0.1',
    connectionAddresses: ['192.168.2.10', '10.0.0.4', '127.0.0.1'],
    getState: () => ({ status: 'ready', admin: 'untrusted-provider-value' }),
    getSourceFrame: () => { calls.source++; return source; },
    getPhoneFrame: () => { calls.phone++; return phone; },
    setCrop: value => { calls.crop.push(value); return { ok: true, privateField: '/private/SECRET' }; },
    stopTransfer: () => { calls.stop++; return { ok: true }; },
    requestAuto: () => { calls.auto++; return { ok: true }; },
    getConnectionQr: url => { calls.qr.push(url); return '<svg xmlns="http://www.w3.org/2000/svg"/>'; },
    ...overrides,
  });
  const started = await server.start();
  t.after(async () => { await server.close(); await rm(folder, { recursive: true, force: true }); });
  return { server, started, calls, setPhone: value => { phone = value; }, setSource: value => { source = value; } };
}
function request(port, path, { method = 'GET', headers = AUTH, body, hostname = '127.0.0.1', chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method, headers, agent: false }, response => {
      const parts = [];
      response.on('data', data => parts.push(data)); response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(parts);
        resolve({ status: response.statusCode, headers: response.headers, bytes,
          json: () => JSON.parse(bytes.toString('utf8')) });
      });
    });
    req.on('error', reject); req.setTimeout(7000, () => req.destroy(new Error('window fixture timeout')));
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}
const jsonPost = (port, value, extra = {}) => request(port, '/api/crop', {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value),
});

test('loopback classification and crop validation do not trust names, headers or out-of-image geometry', () => {
  for (const address of ['127.0.0.1', '127.42.1.2', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  for (const address of ['localhost', '127.evil.example', '192.168.0.1', '::ffff:192.168.0.1', '', null]) assert.equal(isLoopbackAddress(address), false);
  assert.equal(validWindowCropRequest(CROP), true);
  for (const value of [null, [], { ...CROP, extra: 1 }, { ...CROP, geometryRevision: 0 },
    { ...CROP, geometryRevision: '2' }, { ...CROP, crop: { ...CROP.crop, x: -.1 } },
    { ...CROP, crop: { ...CROP.crop, width: 0 } }, { ...CROP, crop: { ...CROP.crop, y: Infinity } },
    { ...CROP, crop: { ...CROP.crop, x: .9 } }, { ...CROP, crop: { ...CROP.crop, extra: 0 } }]) assert.equal(validWindowCropRequest(value), false);
});

test('fixed assets can load without a key while paths never select private files', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/index.html', '/app.js', '/crop.js', '/frame-stats.js', '/style.css']) {
    const response = await request(f.started.port, path, { headers: {} });
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  for (const path of ['/private.jpg', '/src/window-server.mjs', '/%2e%2e/private.jpg', '/app.js%00', '/a%5cb']) {
    assert.equal((await request(f.started.port, path)).status, 404, path);
  }
});

test('API authentication, exact Host and same-Origin checks run before callback access', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/api/state', 'GET'], ['/api/source', 'GET'], ['/api/frame', 'GET'],
    ['/api/connection', 'GET'], ['/api/qr', 'GET'], ['/api/crop', 'POST'], ['/api/stop', 'POST'], ['/api/auto', 'POST']]) {
    const response = await request(f.started.port, path, { method, headers: {} });
    assert.equal(response.status, 401, path); assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
  assert.equal((await request(f.started.port, `/api/state?key=${TOKEN}`, { headers: {} })).status, 401);
  assert.equal((await request(f.started.port, '/api/state', { headers: { ...AUTH, Host: `evil.example:${f.started.port}` } })).status, 403);
  for (const origin of ['null', 'https://foreign.example', 'http://localhost:1']) {
    const response = await request(f.started.port, '/api/source', { headers: { ...AUTH, Origin: origin } });
    assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(f.calls.source, 0); assert.equal(f.calls.phone, 0);
  assert.equal((await request(f.started.port, '/api/state')).json().admin, true);
});

test('source preview and admin actions remain inaccessible through an actual nonloopback connection even with a forged loopback Host', async t => {
  const address = Object.values(networkInterfaces()).flatMap(values => values ?? [])
    .find(value => !value.internal && value.family === 'IPv4')?.address;
  if (!address) { t.skip('No nonloopback IPv4 interface in this execution environment'); return; }
  const f = await fixture(t, { host: '0.0.0.0', connectionAddresses: [address] });
  const remote = (path, extra = {}) => request(f.started.port, path, { hostname: address,
    ...extra, headers: { ...AUTH, Host: `127.0.0.1:${f.started.port}`, ...extra.headers } });
  assert.equal((await remote('/api/state')).json().admin, false);
  assert.equal((await remote('/api/source')).status, 403);
  for (const path of ['/api/crop', '/api/stop', '/api/auto']) assert.equal((await remote(path, { method: 'POST' })).status, 403, path);
  const connections = (await remote('/api/connection')).json();
  assert.equal(connections.localUrl, undefined); assert.equal(connections.urls.length, 1);
  assert.equal((await remote('/api/frame')).status, 200);
  assert.equal(f.calls.source, 0); assert.deepEqual(f.calls.crop, []);
});

test('latest phone frames are served once per sequence, bounded and JPEG-dimension verified without cache', async t => {
  const f = await fixture(t);
  assert.deepEqual(inspectWindowJpeg(JPEG), { width: 16, height: 16 });
  const response = await request(f.started.port, '/api/frame?after=2');
  assert.equal(response.status, 200); assert.deepEqual(response.bytes, JPEG);
  assert.equal(response.headers['x-frame-sequence'], '3'); assert.equal(response.headers['x-frame-geometry'], '2');
  assert.equal(response.headers['x-frame-crop'], '1'); assert.equal(response.headers['x-frame-age-ms'], '12');
  assert.equal(response.headers['content-type'], 'image/jpeg'); assert.equal(response.headers['cache-control'], 'no-store');
  for (const after of [3, 4]) assert.equal((await request(f.started.port, `/api/frame?after=${after}`)).status, 204);
  f.setPhone(null); assert.equal((await request(f.started.port, '/api/frame')).status, 204);
  for (const frame of [{ ...FRAME(), width: 17 }, { ...FRAME(), buffer: Buffer.from('private-not-jpeg') },
    { ...FRAME(), buffer: Buffer.alloc(MAX_FRAME_BYTES + 1) }, { ...FRAME(), geometryRevision: 0 },
    { ...FRAME(), cropRevision: -1 }, { ...FRAME(), ageMs: -1 }]) {
    f.setPhone(frame); assert.deepEqual((await request(f.started.port, '/api/frame')).json(), { error: 'WINDOW_FRAME_INVALID' });
  }
  const source = await request(f.started.port, '/api/source?after=2'); assert.equal(source.status, 200);
  f.setSource(null); assert.equal((await request(f.started.port, '/api/source')).status, 204);
  const stats = JSON.stringify(f.server.getStats());
  assert.ok(!stats.includes(TOKEN)); assert.ok(!stats.includes(JPEG.toString('base64')));
  assert.ok(!stats.includes('private-not-jpeg'));
});

test('frame/state/connection/QR routes accept only their documented bounded queries', async t => {
  const f = await fixture(t);
  for (const path of ['/api/frame?after=00', '/api/frame?after=-1', '/api/frame?after=1.5', '/api/frame?after=9007199254740992',
    '/api/frame?after=1&after=2', '/api/frame?path=/private', '/api/source?x=0', '/api/state?x=1', '/api/connection?x=1']) {
    assert.equal((await request(f.started.port, path)).status, 400, path);
  }
  const connection = (await request(f.started.port, '/api/connection')).json();
  assert.ok(connection.urls[0].startsWith(`http://192.168.2.10:${f.started.port}/#key=`));
  assert.ok(connection.localUrl.startsWith(`http://127.0.0.1:${f.started.port}/?setup=1#key=`));
  const qr = await request(f.started.port, '/api/qr?index=0');
  assert.equal(qr.status, 200); assert.equal(qr.headers['content-type'], 'image/svg+xml');
  assert.equal(f.calls.qr[0], connection.urls[0]);
  for (const path of ['/api/qr?index=999', '/api/qr?index=0&index=1', '/api/qr?index=01', '/api/qr?path=/private']) assert.equal((await request(f.started.port, path)).status, 400);
});

test('crop POST is a bounded exact JSON object and exports no callback-private metadata', async t => {
  const f = await fixture(t);
  const response = await jsonPost(f.started.port, CROP);
  assert.equal(response.status, 200); assert.deepEqual(response.json(), { ok: true });
  assert.deepEqual(f.calls.crop, [CROP]);
  for (const value of [{ ...CROP, extra: '/private' }, { ...CROP, crop: { ...CROP.crop, x: 2 } },
    { ...CROP, geometryRevision: 0 }, { ...CROP, geometryRevision: null }, {}, null]) {
    assert.equal((await jsonPost(f.started.port, value)).status, 400);
  }
  assert.equal((await jsonPost(f.started.port, CROP, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(f.started.port, '/api/crop', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await jsonPost(f.started.port, { ...CROP, padding: 'x'.repeat(5000) })).status, 413);
  assert.equal((await request(f.started.port, '/api/crop', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, chunks: ['x'.repeat(3000), 'x'.repeat(3000)] })).status, 413);
  assert.equal(f.calls.crop.length, 1);
});

test('stop and automatic-region requests are bodyless, invoke only their matching callback and sanitize failures', async t => {
  const f = await fixture(t);
  for (const path of ['/api/stop', '/api/auto']) {
    assert.deepEqual((await request(f.started.port, path, { method: 'POST' })).json(), { ok: true });
    assert.equal((await request(f.started.port, path, { method: 'POST', body: 'x' })).status, 400);
    assert.equal((await request(f.started.port, path, { method: 'POST', chunks: ['x'] })).status, 400);
    assert.equal((await request(f.started.port, `${path}?secret=x`, { method: 'POST' })).status, 400);
  }
  assert.equal(f.calls.stop, 1); assert.equal(f.calls.auto, 1);
  const rejected = await fixture(t, { requestAuto: () => ({ ok: false, errorCode: '/private/SECRET' }) });
  assert.deepEqual((await request(rejected.started.port, '/api/auto', { method: 'POST' })).json(), { error: 'WINDOW_ACTION_REJECTED' });
  const throwing = await fixture(t, { stopTransfer: () => { throw new Error('/private/SECRET'); } });
  const result = await request(throwing.started.port, '/api/stop', { method: 'POST' });
  assert.equal(result.status, 503); assert.deepEqual(result.json(), { error: 'WINDOW_ACTION_FAILED' });
});

test('unrelated API methods and file paths do not gain side effects', async t => {
  const f = await fixture(t);
  for (const path of ['/api/state', '/api/frame', '/api/source', '/api/connection', '/api/qr', '/api/not-a-route']) {
    assert.equal((await request(f.started.port, path, { method: 'POST' })).status, 405);
  }
  for (const path of ['/api/crop', '/api/stop', '/api/auto']) assert.equal((await request(f.started.port, path)).status, 404);
  assert.equal((await request(f.started.port, '/api/frame', { method: 'PUT' })).status, 405);
  assert.deepEqual(f.calls.crop, []); assert.equal(f.calls.stop + f.calls.auto, 0);
});

test('oversized callback state and failed state callbacks do not expose private errors', async t => {
  const large = await fixture(t, { getState: () => ({ value: 'x'.repeat(128 * 1024) }) });
  assert.deepEqual((await request(large.started.port, '/api/state')).json(), { error: 'WINDOW_STATE_TOO_LARGE' });
  const broken = await fixture(t, { getState: () => { throw new Error('/private/SECRET'); } });
  assert.deepEqual((await request(broken.started.port, '/api/state')).json(), { error: 'WINDOW_REQUEST_FAILED' });
});

test('close is idempotent and immediate startup cancellation settles', async t => {
  const f = await fixture(t);
  await Promise.all([f.server.close(), f.server.close()]);
  assert.equal(f.server.getStats().activeConnections, 0);
  const server = new WindowServer({ token: TOKEN, getState: () => ({}) });
  const starting = server.start(); const closed = server.close();
  await assert.rejects(starting, error => error.code === 'WINDOW_SERVER_START_CANCELLED'); await closed;
});

test('JPEG framing rejects truncated images, oversized SOFs and source payload strings', () => {
  for (const bytes of [Buffer.from('/private/SECRET'), JPEG.subarray(0, JPEG.length - 1),
    Buffer.concat([JPEG, Buffer.from([0])]), Buffer.alloc(MAX_FRAME_BYTES + 1)]) {
    assert.throws(() => inspectWindowJpeg(bytes), error => error.code === 'WINDOW_JPEG_INVALID');
  }
  const changed = Buffer.from(JPEG), sof = changed.indexOf(Buffer.from([0xff, 0xc0]));
  changed.writeUInt16BE(5000, sof + 5);
  assert.throws(() => inspectWindowJpeg(changed), error => error.code === 'WINDOW_JPEG_INVALID');
});


test('long polling authenticates before waiting and serves the latest frame after notification', async t => {
  let waited = 0, signal;
  const f = await fixture(t, { waitForPhoneFrame: async (after, options) => {
    waited++; signal = options.signal; assert.equal(after, 3); assert.equal(options.timeoutMs, 500);
    await new Promise(resolve => setTimeout(resolve, 15));
    f.setPhone({ ...FRAME(), sequence: 4 });
  } });
  assert.equal((await request(f.started.port, '/api/frame?after=3&wait=1', { headers: {} })).status, 401);
  for (const path of ['/api/source?wait=1', '/api/frame?wait=2', '/api/frame?wait=1&wait=0', '/api/frame?after=-1&wait=1']) {
    assert.equal((await request(f.started.port, path)).status, 400);
  }
  assert.equal(waited, 0);
  const response = await request(f.started.port, '/api/frame?after=3&wait=1');
  assert.equal(response.status, 200); assert.equal(response.headers['x-frame-sequence'], '4');
  assert.equal(waited, 1); assert.equal(signal.aborted, true);
});

test('client diagnostics use actual socket roles, reject arbitrary fields and omit identifying IDs', async t => {
  const address = Object.values(networkInterfaces()).flatMap(values => values ?? []).find(value => !value.internal && value.family === 'IPv4')?.address;
  const f = await fixture(t, { host: '0.0.0.0', connectionAddresses: address ? [address] : [] });
  const data = { clientId: '0123456789abcdef', sample: 1, foregroundMs: 2000, frames: 120, skipped: 2, requestMs: 240, decodeMs: 120, renderWaitMs: 240, drawMs: 12 };
  const send = (value, extra = {}) => request(f.started.port, '/api/client-metrics', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(value), ...extra });
  assert.equal((await send(data, { headers: {} })).status, 401);
  assert.equal((await send({ ...data, title: 'private' })).status, 400);
  assert.equal((await send({ ...data, foregroundMs: 0 })).status, 400);
  assert.equal((await send(data)).status, 200);
  assert.equal((await send(data)).status, 409);
  if (address) assert.equal((await send({ ...data, clientId: 'fedcba9876543210' }, { hostname: address, headers: { ...AUTH, Host: `127.0.0.1:${f.started.port}`, 'Content-Type': 'application/json' } })).status, 200);
  const stats = f.server.getStats().clientPerformance;
  assert.equal(stats[0].role, 'mac-preview'); assert.equal(stats[0].meanDrawFps, 60);
  if (address) assert.equal(stats[1].role, 'phone');
  assert.doesNotMatch(JSON.stringify(stats), /0123456789abcdef|fedcba9876543210|private|127\.0\.0/);
});

test('extended native playback counters cross HTTP without exposing client IDs', async t => {
  const f = await fixture(t);
  const value = { clientId: '0123456789abcdef', sample: 1, foregroundMs: 10000, frames: 120, skipped: 2,
    requestMs: 240, decodeMs: 120, renderWaitMs: 0, drawMs: 12, movingMs: 2000, movingFrames: 120 };
  const send = data => request(f.started.port, '/api/client-metrics', { method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await send({ ...value, movingMs: 0 })).status, 400);
  assert.equal((await send(value)).status, 200);
  const stats = f.server.getStats().clientPerformance[0];
  assert.equal(stats.movingPlayback.meanSubmissionFps, 60);
  assert.equal(stats.meanDrawFps, 12);
  assert.doesNotMatch(JSON.stringify(stats), /0123456789abcdef|192\.168|title|artist/);
});
