import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { SeratoProbe, SUBSCRIPTIONS, createBonjourRegistration } from '../src/serato-bridge.mjs';
import { DiagnosticState } from '../src/metadata-state.mjs';
import oscModule from '../vendor/serato-connect/dist/remote/osc.js';
import framingModule from '../vendor/serato-connect/dist/remote/framing.js';

const { osc, arg, encodeOsc } = oscModule;
const { frameOsc, FrameReader, FRAME_SENTINEL } = framingModule;

async function until(predicate, description = 'expected event', timeout = 1500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(`Timed out: ${description}`);
    await delay(3);
  }
}

async function makeProbe(t, options = {}) {
  const probe = new SeratoProbe({ host: '127.0.0.1', advertise: false, ...options });
  const seen = { connected: [], paired: [], status: [], disconnected: [], issue: [], fatal: [], outbound: [] };
  for (const [event, list] of Object.entries(seen)) probe.on(event, value => list.push(value));
  t.after(() => probe.stop());
  await probe.start();
  return { probe, seen };
}

async function fakePeer(probe) {
  const socket = createConnection({ host: '127.0.0.1', port: probe.port });
  const received = [];
  const errors = [];
  const reader = new FrameReader();
  socket.on('error', error => errors.push(error.code));
  socket.on('data', chunk => received.push(...reader.push(chunk)));
  await once(socket, 'connect');
  return { socket, received, errors };
}

async function pair(peer) {
  peer.socket.write(frameOsc(osc('/StreamMgmt/Pairing/Pair', arg.s('Fake Serato'), arg.s('Serato DJ'), arg.i(0))));
  await until(() => peer.received.some(message => message.address === '/StreamMgmt/Pairing/Pair'), 'pair reply');
}

function bundle(messages) {
  const header = Buffer.alloc(16);
  header.write('#bundle\0', 'ascii');
  // The immediate OSC time-tag is 1.
  header.writeUInt32BE(1, 12);
  const elements = messages.map(message => {
    const encoded = encodeOsc(message);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(encoded.length);
    return Buffer.concat([size, encoded]);
  });
  return Buffer.concat([header, ...elements, FRAME_SENTINEL]);
}

test('fragmented auth, status-only subscriptions and bundled positions from both decks', async t => {
  const { probe, seen } = await makeProbe(t);
  const peer = await fakePeer(probe);
  t.after(() => peer.socket.destroy());

  peer.socket.write(frameOsc(osc('/Status/Deck/Playhead', arg.i(0), arg.f(99), arg.f(1), arg.f(120))));
  await delay(15);
  assert.equal(seen.status.length, 0, 'status received before pairing must be ignored');

  const auth = frameOsc(osc('/StreamMgmt/Authorize/Request', arg.b(Buffer.from([...Array(16).keys()])), arg.i(1), arg.i(1)));
  for (const chunk of [auth.subarray(0, 3), auth.subarray(3, auth.length - 7), auth.subarray(auth.length - 7)]) {
    peer.socket.write(chunk);
    await delay(4);
  }
  await until(() => peer.received.some(message => message.address === '/StreamMgmt/Authorize/Response'), 'auth reply');
  const authReply = peer.received.find(message => message.address === '/StreamMgmt/Authorize/Response');
  assert.equal(authReply.args.map(value => value.type).join(''), 'ssb');
  assert.equal(authReply.args[0].value, 'Serato Link Test');
  assert.equal(authReply.args[2].value.toString('hex'), '07c8fc80992980464e408fdc4a715b2c');

  await pair(peer);
  await until(() => peer.received.filter(message => message.address.startsWith('/Register/')).length === SUBSCRIPTIONS.length, 'all status subscriptions');
  const registrations = peer.received.filter(message => message.address.startsWith('/Register/')).map(message => message.address);
  assert.deepEqual(new Set(registrations), new Set(SUBSCRIPTIONS));
  assert.equal(seen.paired.length, 1);
  assert.ok(seen.outbound.every(address => !address.startsWith('/Control')));

  peer.socket.write(bundle([
    osc('/Status/Deck/Song/Title', arg.i(0), arg.s('First local track')),
    osc('/Status/Deck/Playhead', arg.i(0), arg.f(12.5), arg.f(1.04), arg.f(124.8)),
    osc('/Status/Deck/Song/Title', arg.i(1), arg.s('Second local track')),
    osc('/Status/Deck/Playhead', arg.i(1), arg.f(100.25), arg.f(0.96), arg.f(115.2)),
  ]));
  await until(() => seen.status.length === 4, 'both decks from an OSC bundle');
  const positions = seen.status.filter(value => value.message.address === '/Status/Deck/Playhead');
  assert.deepEqual(positions.map(value => value.message.args[0].value), [0, 1]);
  assert.deepEqual(positions.map(value => value.message.args[1].value), [12.5, 100.25]);
  assert.ok(Math.abs(positions[0].message.args[2].value - 1.04) < 1e-6);
  assert.ok(Math.abs(positions[1].message.args[3].value - 115.2) < 1e-4);
});

test('live loop subscriptions deliver both deck intervals through the real OSC transport without control commands', async t => {
  const { probe, seen } = await makeProbe(t);
  const state = new DiagnosticState();
  probe.on('connected', id => state.peerConnected(id));
  probe.on('paired', id => state.peerPaired(id));
  probe.on('status', ({ id, message }) => state.handleStatus(id, message));
  const peer = await fakePeer(probe);
  t.after(() => peer.socket.destroy());
  await pair(peer);
  await until(() => peer.received.filter(message => message.address.startsWith('/Register/')).length === SUBSCRIPTIONS.length);
  const registrations = peer.received.filter(message => message.address.startsWith('/Register/')).map(message => message.address);
  for (const name of ['LoopInOutPoint', 'ManualLoopOn', 'ManualLoopSetting']) {
    assert.ok(registrations.includes(`/Register/Status/Deck/Loop/${name}`));
  }
  assert.ok(!registrations.includes('/Register/Status/Deck/Loop/ManualLoopIn'));
  peer.socket.write(bundle([
    osc('/Status/Deck/Loop/LoopInOutPoint', arg.i(0), arg.f(10000), arg.f(12000)),
    osc('/Status/Deck/Loop/AutoLoopOn', arg.i(0), arg.f(1)),
    osc('/Status/Deck/Loop/ManualLoopOn', arg.i(1), arg.f(1)),
    osc('/Status/Deck/Loop/ManualLoopSetting', arg.i(1), arg.f(0)),
    osc('/Status/Deck/Loop/LoopInOutPoint', arg.i(1), arg.f(20000), arg.f(23000)),
  ]));
  await until(() => seen.status.length === 5);
  const decks = state.snapshot().decks;
  assert.equal(decks[0].loop.startSeconds, 10);
  assert.equal(decks[0].loop.endSeconds, 12);
  assert.equal(decks[0].loop.autoLoopOn, true);
  assert.equal(decks[1].loop.startSeconds, 20);
  assert.equal(decks[1].loop.endSeconds, 23);
  assert.equal(decks[1].loop.manualLoopOn, true);
  assert.equal(decks[1].loop.manualLoopSetting, false);
  assert.ok(seen.outbound.every(address => address.startsWith('/Register/Status/')
    || ['/StreamMgmt/Authorize/Response', '/StreamMgmt/Pairing/Pair', '/Ping'].includes(address)));
});

test('closing a heartbeat stream preserves the control stream; a new peer can reconnect', async t => {
  const { probe, seen } = await makeProbe(t);
  const control = await fakePeer(probe);
  await pair(control);
  const controlId = seen.paired[0];
  const heartbeat = await fakePeer(probe);
  heartbeat.socket.write(frameOsc(osc('/Ping')));
  await until(() => heartbeat.received.some(message => message.address === '/Ping'), 'heartbeat reply');
  const heartbeatId = seen.connected.find(id => id !== controlId);
  heartbeat.socket.end();
  await until(() => seen.disconnected.includes(heartbeatId), 'heartbeat disconnection');
  assert.ok(!seen.disconnected.includes(controlId));
  control.socket.write(frameOsc(osc('/Status/Deck/Playhead', arg.i(0), arg.f(5), arg.f(1), arg.f(120))));
  await until(() => seen.status.length === 1, 'control still sends status');
  assert.equal(seen.status[0].id, controlId);

  control.socket.end();
  await until(() => seen.disconnected.includes(controlId), 'control disconnection');
  assert.equal(probe.sessions.size, 0);
  const replacement = await fakePeer(probe);
  await pair(replacement);
  assert.equal(seen.paired.length, 2);
  assert.notEqual(seen.paired[1], controlId);
  replacement.socket.write(frameOsc(osc('/Status/Deck/Playhead', arg.i(1), arg.f(1), arg.f(0), arg.f(120))));
  await until(() => seen.status.length === 2, 'replacement stream status');
  assert.equal(seen.status[1].id, seen.paired[1]);
});

test('malformed and oversized frames close their peer without stopping the listener', async t => {
  const { probe, seen } = await makeProbe(t);
  for (const bytes of [
    Buffer.concat([Buffer.from('/not-terminated', 'ascii'), FRAME_SENTINEL]),
    Buffer.alloc(256 * 1024 + 1, 65),
  ]) {
    const peer = await fakePeer(probe);
    const previousIssues = seen.issue.length;
    const close = new Promise(resolve => peer.socket.once('close', resolve));
    peer.socket.write(bytes);
    await close;
    assert.ok(seen.issue.slice(previousIssues).includes('PEER_PROTOCOL_ERROR'));
    assert.equal(seen.fatal.length, 0);
  }
  const healthy = await fakePeer(probe);
  await pair(healthy);
  assert.equal(seen.paired.length, 1);
});

test('address allowlist rejects nonlocal peers before protocol setup', async t => {
  const { probe, seen } = await makeProbe(t, { addresses: new Set(['198.51.100.10']) });
  const socket = createConnection({ host: '127.0.0.1', port: probe.port });
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('close', resolve));
  assert.deepEqual(seen.issue, ['NONLOCAL_PEER_IGNORED']);
  assert.equal(seen.connected.length, 0);
  assert.equal(seen.outbound.length, 0);
});

function childStub() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

test('Bonjour waits for actual registration, parses split output, and treats exit 0 as a failure', async () => {
  const child = childStub();
  const failures = [];
  let invocation;
  const registration = createBonjourRegistration({
    port: 12345, timeoutMs: 500,
    onFailure: code => failures.push(code),
    spawnProcess: (...args) => { invocation = args; return child; },
  });
  let ready = false;
  registration.ready.then(() => { ready = true; });
  child.stdout.write('Registering Service Serato Link Test._SeratoIOSRemote._tcp.local port 12345\n');
  await delay(15);
  assert.equal(ready, false);
  child.stdout.write('Got a reply for service example: Name now reg');
  child.stdout.write('istered and active\n');
  await registration.ready;
  assert.equal(invocation[0], '/usr/bin/dns-sd');
  assert.equal(invocation[1][0], '-R');
  assert.deepEqual(invocation[1].slice(2), ['_SeratoIOSRemote._tcp', 'local', '12345']);
  assert.ok(!invocation[2].shell, 'no shell must parse advertised names');
  child.emit('close', 0, null);
  assert.deepEqual(failures, ['BONJOUR_PROCESS_EXITED']);
  await registration.stop();
  assert.deepEqual(child.signals, [], 'do not signal an already closed child');
});

test('Bonjour registration removal is fatal after readiness', async () => {
  const child = childStub();
  const failures = [];
  const registration = createBonjourRegistration({ port: 12345, spawnProcess: () => child, onFailure: code => failures.push(code) });
  child.stdout.write('Name now registered and active\n');
  await registration.ready;
  child.stdout.write('Name registration removed\n');
  assert.deepEqual(failures, ['BONJOUR_REGISTRATION_ERROR']);
  await registration.stop();
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Bonjour startup timeout propagates and the probe cleans up its child and listener', async () => {
  const child = childStub();
  const probe = new SeratoProbe({ host: '127.0.0.1', advertise: true,
    registrar: options => createBonjourRegistration({ ...options, spawnProcess: () => child, timeoutMs: 15 }),
  });
  await assert.rejects(probe.start(), { code: 'BONJOUR_START_TIMEOUT' });
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(probe.server, null);
  assert.equal(probe.registration, null);
});

test('stopping during Bonjour startup rejects readiness and closes the child', async () => {
  const child = childStub();
  let spawned = false;
  const probe = new SeratoProbe({ host: '127.0.0.1', advertise: true,
    registrar: options => createBonjourRegistration({ ...options, spawnProcess: () => { spawned = true; return child; } }),
  });
  const startup = probe.start();
  const rejected = assert.rejects(startup, { code: 'START_CANCELLED' });
  await until(() => spawned, 'Bonjour child startup');
  await probe.stop();
  await rejected;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('cancellation between advertisement readiness and startup continuation cannot emit ready', async () => {
  let resolveAdvertisement;
  let registered = false;
  let stopCalls = 0;
  let readyEvents = 0;
  const advertisementReady = new Promise(resolve => { resolveAdvertisement = resolve; });
  const probe = new SeratoProbe({ host: '127.0.0.1', advertise: true,
    registrar: () => {
      registered = true;
      return { ready: advertisementReady, async stop() { stopCalls++; } };
    },
  });
  probe.on('ready', () => { readyEvents++; });
  const startup = probe.start();
  await until(() => registered, 'registration constructed');
  resolveAdvertisement();
  const shutdown = probe.stop();
  const result = await Promise.allSettled([startup, shutdown]);
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.code, 'START_CANCELLED');
  assert.equal(readyEvents, 0);
  assert.equal(stopCalls, 1);
});

test('stop immediately after start settles rather than hanging or crashing', () => {
  const moduleURL = new URL('../src/serato-bridge.mjs', import.meta.url).href;
  const code = `
    import { SeratoProbe } from ${JSON.stringify(moduleURL)};
    process.on('uncaughtException', () => process.exit(7));
    const probe = new SeratoProbe({host:'127.0.0.1',advertise:false});
    const start = probe.start();
    const pending = Promise.allSettled([start, probe.stop()]);
    const watchdog = setTimeout(() => process.exit(8), 250);
    await pending;
    clearTimeout(watchdog);
    await probe.stop();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 1500, encoding: 'utf8' });
  assert.equal(result.status, 0, `start/stop race subprocess: status=${result.status}, signal=${result.signal}, error=${result.error?.code}`);
});
