import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeCapture, NativePacketParser, MAX_NATIVE_HEADER_BYTES } from '../src/native-capture.mjs';
import { MAX_FRAME_BYTES } from '../src/jpeg.mjs';

function jpeg(width = 32, height = 24) {
  return Buffer.from([0xff,0xd8, 0xff,0xc0,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,
    0xff,0xda,0,8,1,1,0,0,63,0, 0x12,0xff,0,0x34,0xff,0xd0,0x56, 0xff,0xd9]);
}
function packet(header, body = Buffer.alloc(0)) {
  const json = Buffer.isBuffer(header) ? header : Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(12); prefix.write('SWC1'); prefix.writeUInt32BE(json.length, 4); prefix.writeUInt32BE(body.length, 8);
  return Buffer.concat([prefix, json, body]);
}

test('analysis packets preserve bounded backing dimensions separately from the preview JPEG', () => {
  const received = [];
  const header = { type: 'analysis', width: 32, height: 24, captureWidth: 128, captureHeight: 96,
    sequence: 1, geometryRevision: 1, cropRevision: 0 };
  new NativePacketParser({ onPacket: value => received.push(value) }).push(packet(header, jpeg()));
  assert.equal(received[0].header.captureWidth, 128);
  assert.equal(received[0].header.captureHeight, 96);
  for (const extra of [
    { captureHeight: undefined }, { captureWidth: null, captureHeight: null },
    { captureWidth: '128' }, { captureWidth: 16, captureHeight: 16 },
    { captureWidth: 4097 }, { captureWidth: 4096, captureHeight: 4096 },
    { captureWidth: 128, captureHeight: 64 },
  ]) {
    assert.throws(() => new NativePacketParser().push(packet({ ...header, ...extra }, jpeg())), { code: 'CAPTURE_PACKET_INVALID' });
  }
});
const status = extra => ({ type: 'status', status: 'capture-ready', geometryRevision: 1, cropRevision: 0, ...extra });
const image = extra => ({ type: 'analysis', width: 32, height: 24, sequence: 1,
  geometryRevision: 1, cropRevision: 0, sourceAgeMs: 13, encodeMs: 2.5, ...extra });
async function until(fn, message) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) { const value = fn(); if (value) return value; await delay(5); }
  assert.fail(message);
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); commands = ''; kills = [];
  stdin = new Writable({ write: (chunk, _, callback) => { this.commands += chunk.toString(); callback(); } });
  kill(signal) { this.kills.push(signal); this.emit('exit', 0, signal); return true; }
}
async function fixture(options = {}) {
  const child = new FakeChild(), calls = [];
  const native = new NativeCapture({ helperPath: '/private/App with spaces/Native helper', platform: 'darwin',
    spawnImpl: (...args) => { calls.push(args); queueMicrotask(() => child.emit('spawn')); return child; },
    stopGraceMs: 5, stopDeadlineMs: 30, ...options });
  const issues = [], packets = [];
  native.on('issue', value => issues.push(value)); native.on('packet', value => packets.push(value));
  await native.start();
  return { native, child, calls, issues, packets };
}

test('fragmented/coalesced native packets preserve image bytes but whitelist every public header', () => {
  const values = [], parser = new NativePacketParser({ onPacket: value => values.push(value) });
  const bytes = Buffer.concat([packet(status({ privatePath: '/Users/SECRET', title: 'PRIVATE_TITLE' })),
    packet(image({ privateName: 'PRIVATE_NAME' }), jpeg()),
    packet(image({ type: 'frame', sequence: 2, cropRevision: 2, requestId: 7 }), jpeg())]);
  for (let index = 0; index < bytes.length; index += 7) parser.push(bytes.subarray(index, index + 7));
  parser.finish();
  assert.equal(values.length, 3);
  assert.deepEqual(values[1].jpeg, jpeg());
  assert.deepEqual(values[2].header, image({ type: 'frame', sequence: 2, cropRevision: 2, requestId: 7 }));
  assert.doesNotMatch(JSON.stringify(values.map(value => value.header)), /SECRET|PRIVATE|privatePath|title/);
  assert.equal(parser.getStats().bufferedBytes, 0);
});

test('native packet lengths and magic are rejected before allocating or retaining an oversized body', () => {
  for (const update of [prefix => prefix.write('NOPE'), prefix => { prefix[0] |= 128; },
    prefix => prefix.writeUInt32BE(MAX_NATIVE_HEADER_BYTES + 1, 4),
    prefix => prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 8), prefix => prefix.writeUInt32BE(1, 4)]) {
    const prefix = packet(status()).subarray(0, 12); update(prefix);
    const parser = new NativePacketParser();
    assert.throws(() => parser.push(prefix), { code: 'CAPTURE_PACKET_INVALID' });
    assert.equal(parser.getStats().allocatedPayloadBytes, 0);
    assert.throws(() => parser.push(Buffer.alloc(0)), { code: 'CAPTURE_PACKET_INVALID' });
  }
  const parser = new NativePacketParser(), prefix = Buffer.alloc(12);
  prefix.write('SWC1'); prefix.writeUInt32BE(MAX_NATIVE_HEADER_BYTES, 4); prefix.writeUInt32BE(MAX_FRAME_BYTES, 8);
  parser.push(prefix);
  assert.equal(parser.getStats().allocatedPayloadBytes, MAX_NATIVE_HEADER_BYTES + MAX_FRAME_BYTES);
  parser.close(); assert.equal(parser.getStats().allocatedPayloadBytes, 0);
});

test('invalid UTF8, JSON, status payloads, dimensions, image metadata and JPEG framing fail with one static code', () => {
  const invalid = [packet(Buffer.from([0xc3,0x28])), packet(Buffer.from('[')), packet([]),
    packet(status({ status: '/private/ERROR' })), packet(status(), jpeg()),
    packet(image(), Buffer.from('not jpeg')), packet(image({ width: 33 }), jpeg()),
    packet(image({ width: 5000 }), jpeg()), packet(image({ geometryRevision: 0 }), jpeg()),
    packet(image({ cropRevision: -1 }), jpeg()), packet(image({ sequence: 1.5 }), jpeg()),
    packet(image({ sourceAgeMs: -1 }), jpeg()), packet(image({ encodeMs: null }), jpeg()),
    packet(image({ type: 'frame', requestId: 0 }), jpeg()),
    packet(status({ status: 'crop-applied', geometryRevision: 1, cropRevision: 1 })),
    packet(status({ errorCode: '/Users/SECRET' }))];
  for (const bytes of invalid) {
    const parser = new NativePacketParser();
    assert.throws(() => parser.push(bytes), { code: 'CAPTURE_PACKET_INVALID' });
    assert.equal(parser.getStats().bufferedBytes, 0);
  }
});

test('partial final packets fail while closing discards all later bytes and hostile callback text', () => {
  for (const bytes of [packet(status()).subarray(0, 5), packet(status()).subarray(0, 20)]) {
    const parser = new NativePacketParser(); parser.push(bytes);
    assert.throws(() => parser.finish(), { code: 'CAPTURE_PACKET_INVALID' });
    assert.equal(parser.getStats().bufferedBytes, 0);
  }
  const parser = new NativePacketParser({ onPacket: () => { throw new Error('/Users/PRIVATE'); } });
  assert.throws(() => parser.push(packet(status())), { code: 'CAPTURE_PACKET_INVALID', message: 'CAPTURE_PACKET_INVALID' });
  parser.close(); assert.equal(parser.push(Buffer.from('ignored')), 0);
});

test('native process uses argument-safe spawning and bounded, whitelisted crop commands', async () => {
  const f = await fixture();
  assert.deepEqual(f.calls[0], ['/private/App with spaces/Native helper', ['--fps', '60'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }]);
  const input = { geometryRevision: 3, requestId: 10, crop: { x: .1, y: .2, width: .5, height: .6, private: 'SECRET' }, private: 'SECRET' };
  assert.equal(f.native.sendCrop(input), true); assert.equal(f.native.clearCrop(), true);
  const commands = f.child.commands.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(commands, [{ command: 'setCrop', geometryRevision: 3, requestId: 10,
    crop: { x: .1, y: .2, width: .5, height: .6 } }, { command: 'clearCrop' }]);
  for (const extra of [{ geometryRevision: 0 }, { requestId: 0 }, { requestId: '10' },
    { crop: { x: -.1, y: 0, width: .5, height: .5 } }, { crop: { x: .9, y: 0, width: .2, height: .5 } },
    { crop: { x: 0, y: 0, width: NaN, height: .5 } }]) assert.equal(f.native.sendCrop({ ...input, ...extra }), false);
  f.child.stdout.write(packet(status()));
  assert.equal(f.packets.length, 1);
  await f.native.stop();
  assert.equal(f.native.sendCrop(input), false);
});

test('pending native start can be cancelled and no late spawn or frame revives it', async () => {
  const child = new FakeChild();
  child.stdin.on('finish', () => child.emit('exit', 0, null));
  const native = new NativeCapture({ helperPath: '/native', platform: 'darwin', spawnImpl: () => child,
    stopGraceMs: 5, stopDeadlineMs: 30 });
  let packets = 0; native.on('packet', () => packets++);
  const start = native.start(), rejected = assert.rejects(start, { code: 'CAPTURE_START_CANCELLED' });
  await native.stop(); await rejected;
  child.emit('spawn'); child.stdout.write(packet(image(), jpeg()));
  assert.equal(packets, 0); assert.equal(native.getStats().running, 0);
});

test('graceful stop is idempotent, preserves no image and needs no kill when EOF closes the helper', async () => {
  const f = await fixture();
  f.child.stdin.on('finish', () => f.child.emit('exit', 0, null));
  f.child.stdout.write(packet(image(), jpeg()));
  await Promise.all([f.native.stop(), f.native.stop()]);
  assert.match(f.child.commands, /"command":"stop"/);
  assert.deepEqual(f.child.kills, []);
  const count = f.packets.length; f.child.stdout.write(packet(image({ sequence: 2 }), jpeg()));
  assert.equal(f.packets.length, count); assert.equal(f.native.getStats().parserBufferedBytes, 0);
});

test('unresponsive helpers are terminated and finally killed within the configured stop bound', async () => {
  const f = await fixture();
  await f.native.stop(); assert.deepEqual(f.child.kills, ['SIGTERM']);
  const other = await fixture();
  other.child.kill = signal => { other.child.kills.push(signal); return true; };
  const began = performance.now(); await other.native.stop();
  assert.deepEqual(other.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(performance.now() - began < 500);
});

test('malformed output and unbounded stderr stop safely without retaining native private strings', async () => {
  const f = await fixture();
  f.child.stdout.write(Buffer.from('malformed stream'));
  await f.native.stop();
  assert.deepEqual(f.issues, ['CAPTURE_PACKET_INVALID']);
  const other = await fixture();
  other.child.stderr.write(Buffer.from('/Users/SECRET/private.swift\n'));
  other.child.stderr.write(Buffer.alloc(65537, 65));
  await other.native.stop();
  assert.deepEqual(other.issues, ['CAPTURE_STDERR_LIMIT']);
  assert.doesNotMatch(JSON.stringify(other.native.getStats()), /SECRET|private\.swift/);
});

test('native EOF and spawn failure expose only static diagnostics', async () => {
  const f = await fixture(); f.child.stdout.end();
  await until(() => f.issues.length > 0, 'native EOF was not observed'); await f.native.stop();
  assert.deepEqual(f.issues, ['CAPTURE_STREAM_ENDED']);
  const native = new NativeCapture({ helperPath: '/Users/SECRET/helper', platform: 'darwin',
    spawnImpl: () => { throw new Error('/Users/SECRET/path'); } });
  const issues = []; native.on('issue', code => issues.push(code));
  await assert.rejects(native.start(), { code: 'CAPTURE_START_FAILED', message: 'CAPTURE_START_FAILED' });
  await native.stop(); assert.deepEqual(issues, ['CAPTURE_START_FAILED']);
  assert.doesNotMatch(JSON.stringify(native.getStats()), /SECRET/);
});

test('unsupported platforms never launch native capture', async () => {
  let spawns = 0;
  const native = new NativeCapture({ helperPath: '/native', platform: 'linux', spawnImpl: () => { spawns++; } });
  await assert.rejects(native.start(), { code: 'CAPTURE_UNSUPPORTED_PLATFORM' });
  await native.stop(); assert.equal(spawns, 0);
});

test('a real subprocess roundtrip parses a native crop acknowledgement and its frame', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'window native ü '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'Capture helper');
  await writeFile(file, `#!/usr/bin/env node
const readline=require('node:readline');
const jpg=Buffer.from('${jpeg().toString('base64')}','base64');
function send(header,body=Buffer.alloc(0)){const h=Buffer.from(JSON.stringify(header)),p=Buffer.alloc(12);p.write('SWC1');p.writeUInt32BE(h.length,4);p.writeUInt32BE(body.length,8);process.stdout.write(Buffer.concat([p,h,body]));}
send({type:'status',status:'capture-ready',geometryRevision:1,cropRevision:0});
readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.command==='stop')process.exit(0);if(c.command==='setCrop'){send({type:'status',status:'crop-applied',geometryRevision:1,cropRevision:1,requestId:c.requestId});send({type:'frame',width:32,height:24,sequence:1,geometryRevision:1,cropRevision:1,requestId:c.requestId},jpg);}}).on('close',()=>process.exit(0));
`, { mode: 0o700 });
  const native = new NativeCapture({ helperPath: file, platform: 'darwin' }), values = [], issues = [];
  native.on('packet', value => values.push(value)); native.on('issue', code => issues.push(code));
  t.after(() => native.stop());
  await native.start(); await until(() => values.length > 0, 'native ready packet missing');
  assert.equal(native.sendCrop({ geometryRevision: 1, requestId: 4, crop: { x: .1, y: .1, width: .8, height: .8 } }), true);
  await until(() => values.some(value => value.header.type === 'frame'), 'native frame missing');
  assert.equal(values[1].header.status, 'crop-applied'); assert.equal(values[2].header.requestId, 4);
  assert.deepEqual(values[2].jpeg, jpeg()); await native.stop(); assert.deepEqual(issues, []);
});


test('native performance headers are bounded analysis metadata and 30 FPS is passed explicitly', async () => {
  const performance = { targetFps: 60, captureSamples: 120, busyDrops: 3, cropFrames: 100, previewFrames: 4, elapsedMs: 2000, captureFps: 60, encodeFps: 50, peakCaptureFps: 60, peakEncodeFps: 50 };
  const packets = [];
  new NativePacketParser({ onPacket: value => packets.push(value) }).push(packet(image({ performance }), jpeg()));
  assert.deepEqual(packets[0].header.performance, performance);
  for (const extra of [{ ...performance, targetFps: 120 }, { ...performance, private: 'value' }, { ...performance, captureFps: -1 }]) {
    assert.throws(() => new NativePacketParser().push(packet(image({ performance: extra }), jpeg())), { code: 'CAPTURE_PACKET_INVALID' });
  }
  const f = await fixture({ frameRate: 30 });
  try { await f.native.start(); assert.deepEqual(f.calls[0][1], ['--fps', '30']); }
  finally { await f.native.stop(); }
  assert.throws(() => new NativeCapture({ helperPath: '/tmp/helper', frameRate: 120 }), /CAPTURE_OPTIONS_INVALID/);
});
