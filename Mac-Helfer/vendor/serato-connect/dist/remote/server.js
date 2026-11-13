"use strict";
/**
 * @fileoverview Per-connection OSC session and the listening TCP server.
 *
 * Serato DJ Pro is the TCP **client** — it browses for our advert, then
 * opens (typically two) parallel TCP connections to us. Each connection
 * carries its own OSC stream. {@link RemoteSession} handles one such stream:
 * runs the handshake, sends subscription requests, replies to pings, and
 * emits parsed `/Status/...` messages outward via `onStatus`.
 *
 * {@link RemoteServer} owns the listening socket and instantiates a session
 * per accepted connection.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteServer = exports.RemoteSession = void 0;
const node_events_1 = __importDefault(require("node:events"));
const node_crypto_1 = require("node:crypto");
const node_net_1 = require("node:net");
const logger_js_1 = require("../types/logger.js");
const framing_js_1 = require("./framing.js");
const osc_js_1 = require("./osc.js");
/**
 * Shared secret Serato DJ Pro uses to authenticate Remote peers. The
 * `/StreamMgmt/Authorize/Response` must carry `MD5(nonce ‖ secret)` where
 * `nonce` is the 16-byte blob from `/StreamMgmt/Authorize/Request`. Two such
 * secrets are hardcoded in the Serato binary (either is accepted); this is
 * one of them. See ../../docs/protocol.md §3.1.1.
 */
const SERATO_REMOTE_SECRET = Buffer.from('d25db261a4411bc1f3788f57723b8977c541a4b619b94a9a8b45c46f8511c2f8', 'hex');
/**
 * Reasonably high default for the unverified frame max — large enough for
 * any plausible OSC payload (track strings, etc.) without being so large
 * that a malformed length prefix can DoS us.
 */
const DEFAULT_MAX_FRAME_BYTES = 1 << 20;
/**
 * One accepted TCP connection from Serato. Drives the handshake and
 * subscription, emits parsed status messages.
 */
class RemoteSession extends node_events_1.default {
    constructor(opts) {
        super();
        this.isPaired = false;
        this.isSubscribed = false;
        this.isClosed = false;
        this.socket = opts.socket;
        this.subscribeTopics = opts.subscribeTopics;
        this.peerName = opts.peerName;
        this.peerUuid = opts.peerUuid;
        this.logger = opts.logger ?? logger_js_1.noopLogger;
        this.reader = new framing_js_1.FrameReader(opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
        this.peer = {
            remoteAddress: opts.socket.remoteAddress ?? 'unknown',
            remotePort: opts.socket.remotePort ?? 0,
        };
        this.socket.on('data', (chunk) => this.handleData(chunk));
        this.socket.on('close', () => this.handleClose());
        this.socket.on('error', (err) => this.handleSocketError(err));
    }
    /** Address of the connected peer. */
    get remotePeer() {
        return this.peer;
    }
    /** Whether the Authorize/Pair handshake has completed. */
    get paired() {
        return this.isPaired;
    }
    /** Send an OSC message immediately (if the socket is still writable). */
    send(msg) {
        if (this.isClosed || this.socket.destroyed) {
            return;
        }
        try {
            this.socket.write((0, framing_js_1.frameOsc)(msg));
        }
        catch (err) {
            this.emit('error', toError(err), this.peer);
        }
    }
    /** Cleanly tear down the session: send unpair, end the socket. */
    close() {
        if (this.isClosed)
            return;
        if (this.isPaired) {
            this.send((0, osc_js_1.osc)('/StreamMgmt/Pairing/UnPair'));
        }
        this.isClosed = true;
        try {
            this.socket.end();
        }
        catch (err) {
            this.logger.warn('remote session: error ending socket', err);
        }
    }
    handleData(chunk) {
        if (this.isClosed)
            return;
        let messages;
        try {
            messages = this.reader.push(chunk);
        }
        catch (err) {
            this.emit('error', toError(err), this.peer);
            this.socket.destroy();
            return;
        }
        for (const msg of messages) {
            this.dispatch(msg);
        }
    }
    dispatch(msg) {
        const { address } = msg;
        if (address === '/StreamMgmt/Authorize/Request') {
            // Serato sends a 16-byte challenge nonce. Prove we know the shared
            // secret by replying with (peerName, peerUuid, MD5(nonce ‖ secret)) —
            // type tag `,ssb`. A wrong/absent digest makes Serato go silent.
            const nonce = msg.args.find((a) => a.type === 'b')?.value;
            if (!nonce) {
                this.logger.warn('remote session: Authorize/Request had no nonce blob');
                return;
            }
            const digest = (0, node_crypto_1.createHash)('md5').update(nonce).update(SERATO_REMOTE_SECRET).digest();
            this.send((0, osc_js_1.osc)('/StreamMgmt/Authorize/Response', osc_js_1.arg.s(this.peerName), osc_js_1.arg.s(this.peerUuid), osc_js_1.arg.b(digest)));
            return;
        }
        if (address === '/StreamMgmt/Pairing/Pair') {
            // After authorizing, Serato sends its own Pair (with isActive=0) —
            // `(peerName, peerUuid, isActive)`. Its peerName ("SDJ @ <host>") is the
            // only human-readable identity the protocol carries, so record it on the
            // peer before the `paired` event goes out.
            const theirName = stringArg(msg, 0);
            const theirUuid = stringArg(msg, 1);
            if (theirName)
                this.peer.name = theirName;
            if (theirUuid)
                this.peer.uuid = theirUuid;
            // Reply with our Pair marked active (isActive=1) to open the status
            // stream, then subscribe to the topics we care about.
            this.send((0, osc_js_1.osc)('/StreamMgmt/Pairing/Pair', osc_js_1.arg.s(this.peerName), osc_js_1.arg.s(this.peerUuid), osc_js_1.arg.i(1)));
            this.subscribe();
            if (!this.isPaired) {
                this.isPaired = true;
                this.emit('paired', this.peer);
            }
            return;
        }
        if (address === '/StreamMgmt/Pairing/StatusChanged') {
            // A pairing-state notification from Serato — ensure we've subscribed.
            this.subscribe();
            return;
        }
        if (address === '/StreamMgmt/Pairing/UnPair') {
            this.isPaired = false;
            try {
                this.socket.end();
            }
            catch {
                // best-effort
            }
            return;
        }
        if (address === '/Ping') {
            // Echo the ping back. Some implementations expect the echo, others
            // treat it as a one-way liveness indicator — echoing is safe.
            this.send((0, osc_js_1.osc)('/Ping'));
            this.emit('ping', this.peer);
            return;
        }
        if (address.startsWith('/Status/')) {
            this.emit('status', msg, this.peer);
            return;
        }
        // Unknown path — log at debug and keep the stream alive.
        this.logger.debug('remote session: ignoring unknown OSC path %s', address);
    }
    /** Send one `/Register/Status/<topic>` per subscribed topic, once. */
    subscribe() {
        if (this.isSubscribed)
            return;
        this.isSubscribed = true;
        for (const topic of this.subscribeTopics) {
            this.send((0, osc_js_1.osc)(topic));
        }
    }
    handleClose() {
        if (this.isClosed)
            return;
        this.isClosed = true;
        this.emit('closed', this.peer);
    }
    handleSocketError(err) {
        this.emit('error', err, this.peer);
    }
}
exports.RemoteSession = RemoteSession;
/**
 * TCP listener that accepts Serato's inbound connections (typically two in
 * parallel) and emits a {@link RemoteSession} for each.
 */
class RemoteServer extends node_events_1.default {
    constructor(opts) {
        super();
        this.sessions = new Set();
        this.boundPort = null;
        this.options = opts;
        // A stable UUID for the lifetime of the server, shared across the two
        // parallel connections Serato opens.
        this.peerUuid = opts.peerUuid ?? (0, node_crypto_1.randomUUID)();
        this.logger = opts.logger ?? logger_js_1.noopLogger;
        this.tcp = (0, node_net_1.createServer)((socket) => this.handleConnection(socket));
        this.tcp.on('error', (err) => this.emit('error', err));
    }
    /** Resolved port — meaningful only after `start()` resolves. */
    get port() {
        if (this.boundPort == null) {
            throw new Error('RemoteServer not started');
        }
        return this.boundPort;
    }
    /** Start listening; resolves with the actually-bound port. */
    async start() {
        return new Promise((resolve, reject) => {
            const onError = (err) => {
                this.tcp.removeListener('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                this.tcp.removeListener('error', onError);
                const addr = this.tcp.address();
                if (!addr || typeof addr === 'string') {
                    reject(new Error(`Unexpected listening address: ${String(addr)}`));
                    return;
                }
                this.boundPort = addr.port;
                this.emit('listening', { port: addr.port, host: this.options.host });
                resolve(addr.port);
            };
            this.tcp.once('error', onError);
            this.tcp.once('listening', onListening);
            this.tcp.listen(this.options.port, this.options.host);
        });
    }
    /** Stop accepting new connections and close all in-flight sessions. */
    async stop() {
        for (const session of this.sessions) {
            session.close();
        }
        this.sessions.clear();
        return new Promise((resolve) => {
            this.tcp.close(() => resolve());
            // close() only fires after every connection drains. Force-detach any
            // straggling connections after a short grace period.
            setTimeout(() => {
                this.tcp.unref?.();
                resolve();
            }, 250).unref?.();
        });
    }
    handleConnection(socket) {
        socket.setNoDelay(true);
        const session = new RemoteSession({
            socket,
            subscribeTopics: this.options.subscribeTopics,
            peerName: this.options.peerName,
            peerUuid: this.peerUuid,
            maxFrameBytes: this.options.maxFrameBytes,
            logger: this.logger,
        });
        this.sessions.add(session);
        session.on('closed', () => this.sessions.delete(session));
        this.emit('session', session);
    }
}
exports.RemoteServer = RemoteServer;
function toError(err) {
    return err instanceof Error ? err : new Error(String(err));
}
/** Read a string argument at `index`, or null if it is absent/another type. */
function stringArg(msg, index) {
    const a = msg.args[index];
    if (!a || a.type !== 's')
        return null;
    return a.value.length > 0 ? a.value : null;
}
//# sourceMappingURL=server.js.map