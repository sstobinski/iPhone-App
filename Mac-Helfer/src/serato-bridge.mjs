import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { networkInterfaces, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import serverModule from '../vendor/serato-connect/dist/remote/server.js';

const { RemoteSession } = serverModule;

// Status subscriptions only: the probe never sends /Control messages.
export const SUBSCRIPTIONS = Object.freeze([
  '/Register/Status/Deck/Song/Title',
  '/Register/Status/Deck/Song/Artist',
  '/Register/Status/Deck/Song/Filepath',
  '/Register/Status/Deck/Song/Valid',
  '/Register/Status/Deck/Playhead',
  '/Register/Status/Deck/Loop/AutoLoopOn',
  '/Register/Status/Deck/Loop/BeatLength',
  '/Register/Status/Deck/Loop/LoopRollOn',
  '/Register/Status/Deck/Loop/LoopInOutPoint',
  '/Register/Status/Deck/Loop/ManualLoopOn',
  '/Register/Status/Deck/Loop/ManualLoopSetting',
]);
const SEND_ALLOWLIST = new Set([
  ...SUBSCRIPTIONS,
  '/Ping',
  '/StreamMgmt/Authorize/Response',
  '/StreamMgmt/Pairing/Pair',
  '/StreamMgmt/Pairing/UnPair',
]);

export class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeError';
    this.code = code;
  }
}

export function localAddresses() {
  const result = new Set(['127.0.0.1', '::1']);
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records ?? []) result.add(normalizeAddress(record.address));
  }
  return result;
}

function normalizeAddress(value) {
  return String(value ?? '').replace(/^::ffff:/, '').split('%')[0];
}

// macOS supplies dns-sd. No npm package or native build is needed on the Mac.
// Apple confirms successful registration in reg_reply with this exact text.
export function createBonjourRegistration({ port, onFailure = () => {},
  spawnProcess = spawn, timeoutMs = 8000 }) {
  let child;
  let ready = false;
  let settled = false;
  let stopping = false;
  let closed = false;
  let output = '';
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Consumers may cancel a startup before they get to await it.
  readyPromise.catch(() => {});
  const fail = (code) => {
    if (stopping) return;
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      rejectReady(new ProbeError(code));
    } else if (ready) {
      ready = false;
      onFailure(code);
    }
  };
  const timer = setTimeout(() => fail('BONJOUR_START_TIMEOUT'), timeoutMs);
  try {
    child = spawnProcess('/usr/bin/dns-sd', [
      '-R', `Serato Link Test @ ${hostname()}`,
      '_SeratoIOSRemote._tcp', 'local', String(port),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const inspect = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-8192);
      if (/Name in use|Name registration removed|\bError\s+-?\d+/i.test(output)) {
        fail('BONJOUR_REGISTRATION_ERROR');
      } else if (!settled && output.includes('Name now registered and active')) {
        ready = true;
        settled = true;
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.on('error', () => fail('BONJOUR_PROCESS_ERROR'));
    child.once('close', () => {
      closed = true;
      fail('BONJOUR_PROCESS_EXITED');
    });
  } catch {
    fail('BONJOUR_PROCESS_ERROR');
  }
  return {
    ready: readyPromise,
    async stop() {
      stopping = true;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectReady(new ProbeError('START_CANCELLED'));
      }
      if (!child || closed) return;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(force); resolve(); };
        const force = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 800);
        child.once('close', done);
        child.kill('SIGTERM');
      });
    },
  };
}

export class SeratoProbe extends EventEmitter {
  constructor({ host = '0.0.0.0', port = 0, advertise = true,
    addresses = localAddresses(), registrar = createBonjourRegistration,
    handshakeTimeoutMs = 30000 } = {}) {
    super();
    this.options = { host, port, advertise, addresses, registrar, handshakeTimeoutMs };
    this.sessions = new Map();
    this.counter = 0;
    this.peerUuid = randomUUID();
    this.server = null;
    this.registration = null;
    this.stopping = false;
    this.stopPromise = null;
    this.abortController = null;
  }

  async start() {
    if (this.server) throw new ProbeError('ALREADY_RUNNING');
    this.stopping = false;
    this.stopPromise = null;
    this.abortController = new AbortController();
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    server.on('error', () => {
      if (!this.stopping) this.emit('fatal', 'TCP_LISTENER_ERROR');
    });
    try {
      await new Promise((resolve, reject) => {
        const signal = this.abortController.signal;
        const onError = () => {
          signal.removeEventListener('abort', onAbort);
          reject(new ProbeError('TCP_LISTENER_ERROR'));
        };
        const onAbort = () => {
          server.removeListener('error', onError);
          reject(new ProbeError('START_CANCELLED'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        server.once('error', onError);
        server.listen({ port: this.options.port, host: this.options.host, signal }, () => {
          server.removeListener('error', onError);
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      if (this.stopping) throw new ProbeError('START_CANCELLED');
      this.port = server.address().port;
      if (this.options.advertise) {
        this.registration = this.options.registrar({
          port: this.port,
          onFailure: (code) => {
            if (!this.stopping) this.emit('fatal', code);
          },
        });
        await this.registration.ready;
      }
      if (this.stopping) throw new ProbeError('START_CANCELLED');
      this.emit('ready');
      return this.port;
    } catch (error) {
      await this.stop();
      throw error instanceof ProbeError ? error : new ProbeError('START_FAILED');
    }
  }

  accept(socket) {
    if (this.stopping || !this.options.addresses.has(normalizeAddress(socket.remoteAddress))) {
      socket.destroy();
      this.emit('issue', 'NONLOCAL_PEER_IGNORED');
      return;
    }
    if (this.sessions.size >= 8) {
      socket.destroy();
      this.emit('issue', 'TOO_MANY_CONNECTIONS');
      return;
    }
    const id = ++this.counter;
    socket.setNoDelay(true);
    const session = new RemoteSession({
      socket, peerName: 'Serato Link Test', peerUuid: this.peerUuid,
      subscribeTopics: SUBSCRIPTIONS, maxFrameBytes: 256 * 1024,
    });
    let heartbeatSeen = false;
    // Status is change-driven. A paired control stream can legitimately be
    // silent while paused: Serato's heartbeat uses a separate TCP connection.
    // Only an unrecognized, inactive connection should time out here.
    socket.setTimeout(this.options.handshakeTimeoutMs, () => {
      // Also ignore a timeout already queued just before pairing or a ping.
      if (session.paired || heartbeatSeen || this.stopping) return;
      this.emit('issue', 'PEER_HANDSHAKE_TIMEOUT');
      socket.destroy();
    });
    this.sessions.set(id, { session, socket });
    const send = session.send.bind(session);
    session.send = (message) => {
      if (!SEND_ALLOWLIST.has(message.address)) {
        this.emit('issue', 'OUTBOUND_MESSAGE_BLOCKED');
        socket.destroy();
        return;
      }
      this.emit('outbound', message.address);
      send(message);
    };
    session.on('paired', () => {
      socket.setTimeout(0);
      this.emit('paired', id);
    });
    session.on('ping', () => {
      heartbeatSeen = true;
      socket.setTimeout(0);
    });
    session.on('status', (message) => {
      if (session.paired) this.emit('status', { id, message });
    });
    session.on('error', () => {
      this.emit('issue', 'PEER_PROTOCOL_ERROR');
      socket.destroy();
    });
    // Upstream close() can suppress its own 'closed' event. Own the socket lifecycle.
    socket.once('close', () => {
      this.sessions.delete(id);
      this.emit('disconnected', id);
    });
    this.emit('connected', id);
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.abortController?.abort();
      const registration = this.registration;
      this.registration = null;
      const stopRegistration = registration?.stop();
      const server = this.server;
      this.server = null;
      const closeServer = server ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve();
      for (const { session, socket } of this.sessions.values()) {
        session.close();
        socket.destroy();
      }
      this.sessions.clear();
      await Promise.all([stopRegistration, closeServer]);
    })();
    return this.stopPromise;
  }
}
