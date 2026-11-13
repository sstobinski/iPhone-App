import test from 'node:test';
import assert from 'node:assert/strict';
import { readCapturePerformance, readClientPerformance, ClientPerformanceCollector, FrameRateMeter } from '../src/performance.mjs';
import { FrameStats, paintFrame, nextPaint } from '../web/frame-stats.js';
import { parseArgs } from '../src/app.mjs';

test('60 FPS is the default and the comparison starter can select exactly 30 FPS', () => {
  assert.equal(parseArgs([]).fps, 60);
  assert.equal(parseArgs(['--fps', '30']).fps, 30);
  for (const args of [['--fps'], ['--fps', '120'], ['--fps', '60.0'], ['--fps', '$(private)']]) assert.throws(() => parseArgs(args));
});

const capture = { targetFps: 60, captureSamples: 120, busyDrops: 3, cropFrames: 110, previewFrames: 4,
  elapsedMs: 2000, captureFps: 60, encodeFps: 55, peakCaptureFps: 60, peakEncodeFps: 57 };
test('native performance fields are numeric, bounded and copied without private extension fields', () => {
  assert.deepEqual(readCapturePerformance(capture), capture);
  assert.notEqual(readCapturePerformance(capture), capture);
  for (const extra of [{ targetFps: 120 }, { captureSamples: -1 }, { encodeFps: Infinity }, { peakCaptureFps: 10000 },
    { captureSamples: '120' }, { privatePath: '/PRIVATE' }]) assert.equal(readCapturePerformance({ ...capture, ...extra }), null);
});

test('stream frame-rate windows count unique events and show idle periods as zero', () => {
  const meter = new FrameRateMeter();
  for (let i = 0; i < 60; i++) meter.mark(i * 1000 / 60);
  assert.equal(meter.read(1000).uniqueFrameFps, 60);
  assert.equal(meter.read(2000).uniqueFrameFps, 0);
  assert.equal(meter.read(2000).peakUniqueFrameFps, 60);
});

const client = extra => ({ clientId: 'aabbccddeeff0011', sample: 1, foregroundMs: 1000, frames: 60, skipped: 2,
  requestMs: 300, decodeMs: 120, renderWaitMs: 60, drawMs: 12, ...extra });
test('display measurements are per client and their role comes from the server', () => {
  const collector = new ClientPerformanceCollector();
  assert.equal(collector.accept(client(), 'phone', 0), true);
  assert.equal(collector.accept(client({ sample: 2, foregroundMs: 2000, frames: 120, skipped: 4,
    requestMs: 600, decodeMs: 240, renderWaitMs: 120, drawMs: 24 }), 'phone', 2000), true);
  assert.equal(collector.accept(client({ clientId: '1122334455667788', frames: 15 }), 'mac-preview', 2000), true);
  const stats = collector.getStats();
  assert.equal(stats[0].meanDrawFps, 60); assert.equal(stats[1].meanDrawFps, 15);
  assert.equal(stats[0].meanDecodeMs, 2);
  assert.doesNotMatch(JSON.stringify(stats), /clientId|aabb|112233|userAgent|address/);
  assert.equal(collector.accept(client({ sample: 3, foregroundMs: 3000, frames: 180 }), 'mac-preview', 4000), false);
});

test('metrics reject excessive rates, stale/reversed counters, unknown fields and excess clients', () => {
  const collector = new ClientPerformanceCollector();
  for (const extra of [{ frames: 10000 }, { foregroundMs: 0 }, { clientId: '/PRIVATE' }, { role: 'admin' }, { drawMs: NaN }]) {
    assert.equal(readClientPerformance(client(extra)), null);
  }
  assert.equal(collector.accept(client(), 'phone', 0), true);
  assert.equal(collector.accept(client(), 'phone', 2000), false);
  assert.equal(collector.accept(client({ sample: 2, foregroundMs: 2000, frames: 30 }), 'phone', 2000), false);
  for (let i = 1; i < 16; i++) assert.equal(collector.accept(client({ clientId: i.toString(16).padStart(16, '0') }), 'phone', 2000), true);
  assert.equal(collector.accept(client({ clientId: 'ffffffffffffffff' }), 'phone', 2000), false);
  assert.equal(collector.getStats().length, 16);
});

test('browser counters exclude hidden time and carry only cumulative numeric timings', () => {
  let now = 0;
  const stats = new FrameStats({ id: 'aabbccddeeff0011', now: () => now });
  now = 10000; stats.setActive(true);
  for (let i = 0; i < 60; i++) { now += 1000 / 60; stats.record({ decodeMs: 2, requestMs: 5 }, 1); }
  now = 11001;
  const first = stats.snapshot(); assert.equal(first.frames, 60); assert.ok(Math.abs(first.foregroundMs - 1001) < .01);
  assert.equal(first.skipped, 60); assert.equal(first.decodeMs, 120); assert.ok(readClientPerformance(first));
  stats.setActive(false); now += 50000;
  assert.equal(stats.snapshot().foregroundMs, first.foregroundMs);
});

test('painting consecutive frames reuses the canvas allocation and resizes only for new dimensions', () => {
  let writes = 0, width = 530, height = 538, draws = 0;
  const canvas = { get width() { return width; }, set width(value) { writes++; width = value; },
    get height() { return height; }, set height(value) { writes++; height = value; } };
  const context = { drawImage() { draws++; } };
  paintFrame(canvas, context, {}, { width: 530, height: 538 });
  paintFrame(canvas, context, {}, { width: 530, height: 538 });
  assert.equal(writes, 0);
  paintFrame(canvas, context, {}, { width: 600, height: 500 });
  assert.equal(writes, 2); assert.equal(draws, 3);
});

test('frame scheduling waits for a screen callback and releases a frame if rendering is suspended', async () => {
  let callback, cancelled = false;
  const scheduled = nextPaint({ schedule: value => { callback = value; return 1; }, cancel: () => { cancelled = true; }, timeoutMs: 100 });
  callback(); assert.equal(await scheduled, true); assert.equal(cancelled, false);
  assert.equal(await nextPaint({ schedule: () => 2, cancel: id => { assert.equal(id, 2); cancelled = true; }, timeoutMs: 1 }), false);
  assert.equal(cancelled, true);
});

test('moving-playback FPS remains separate from whole-session idle time', () => {
  const collector = new ClientPerformanceCollector();
  assert.equal(collector.accept(client({ foregroundMs: 10000, frames: 120, movingMs: 2000, movingFrames: 120 }), 'phone', 10000), true);
  assert.equal(collector.accept(client({ sample: 2, foregroundMs: 20000, frames: 240, movingMs: 4000, movingFrames: 240,
    requestMs: 600, decodeMs: 240, renderWaitMs: 120, drawMs: 24 }), 'phone', 20000), true);
  const stats = collector.getStats()[0];
  assert.equal(stats.meanDrawFps, 12);
  assert.equal(stats.movingPlayback.meanSubmissionFps, 60);
  assert.equal(stats.movingPlayback.peakWindowSubmissionFps, 60);
  assert.equal(stats.movingPlayback.windowsAtLeastOneSecond, 2);
  assert.doesNotMatch(JSON.stringify(stats), /clientId|aabb|address|title|artist/);
});

test('moving counters reject partial fields, impossible time/frame subsets and counter regression', () => {
  for (const extra of [{ movingMs: 10 }, { movingFrames: 1 }, { movingMs: NaN, movingFrames: 0 },
    { movingMs: -1, movingFrames: 0 }, { movingMs: 1100, movingFrames: 1 }, { movingMs: 100, movingFrames: 61 },
    { movingMs: 1, movingFrames: 60 }, { movingMs: 0, movingFrames: 1 }, { movingMs: 100, movingFrames: 1.2 }]) {
    assert.equal(readClientPerformance(client(extra)), null, JSON.stringify(extra));
  }
  const collector = new ClientPerformanceCollector();
  assert.equal(collector.accept(client({ movingMs: 500, movingFrames: 30 }), 'phone', 0), true);
  for (const extra of [{ movingMs: 400, movingFrames: 31 }, { movingMs: 700, movingFrames: 29 },
    { movingMs: 500, movingFrames: 31 }, { movingMs: 1600, movingFrames: 60 }]) {
    assert.equal(collector.accept(client({ sample: 2, foregroundMs: 2000, frames: 120, ...extra }), 'phone', 2000), false);
  }
  assert.equal(collector.accept(client({ sample: 2, foregroundMs: 2000, frames: 120 }), 'phone', 2000), false);
});

test('old clients still report normally and unmeasured motion never reports zero FPS', () => {
  const collector = new ClientPerformanceCollector();
  assert.equal(collector.accept(client(), 'phone', 0), true);
  assert.equal(collector.getStats()[0].movingPlayback, null);
  assert.equal(collector.accept(client({ clientId: '1122334455667788', movingMs: 0, movingFrames: 0 }), 'phone', 0), true);
  assert.equal(collector.getStats()[1].movingPlayback.meanSubmissionFps, null);
  assert.equal(collector.accept(client({ sample: 2, foregroundMs: 2000, frames: 120, movingMs: 1000, movingFrames: 60 }), 'phone', 2000), false);
});
