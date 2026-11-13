import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { VERSION } from './version.mjs';

const TOPICS = new Set([
  '/Status/Deck/Song/Title',
  '/Status/Deck/Song/Artist',
  '/Status/Deck/Song/Filepath',
  '/Status/Deck/Song/Valid',
  '/Status/Deck/Playhead',
  '/Status/Deck/Loop/AutoLoopOn',
  '/Status/Deck/Loop/BeatLength',
  '/Status/Deck/Loop/LoopRollOn',
  '/Status/Deck/Loop/LoopInOutPoint',
  '/Status/Deck/Loop/ManualLoopOn',
  '/Status/Deck/Loop/ManualLoopSetting',
]);

const LOOP_BOOLEAN_FIELDS = new Map([
  ['/Status/Deck/Loop/AutoLoopOn', 'autoLoopOn'],
  ['/Status/Deck/Loop/LoopRollOn', 'loopRollOn'],
  ['/Status/Deck/Loop/ManualLoopOn', 'manualLoopOn'],
  ['/Status/Deck/Loop/ManualLoopSetting', 'manualLoopSetting'],
]);

function emptyLoop() {
  return { autoLoopOn: null, beatLength: null, loopRollOn: null,
    manualLoopOn: null, manualLoopSetting: null, startSeconds: null, endSeconds: null };
}

function clearLoopBounds(deck) {
  deck.loop.startSeconds = null;
  deck.loop.endSeconds = null;
}

function terminalText(value) {
  const clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .trim();
  return [...clean].slice(0, 120).join('');
}

function deckState(id) {
  return {
    id,
    title: '', artist: '', artistSeen: false, artistMessages: 0,
    titleSeen: false,
    filePathSeen: false,
    titleMessages: 0,
    filePathMessages: 0,
    validTrueMessages: 0,
    validFalseMessages: 0,
    fileFingerprint: null,
    positionSeconds: null,
    playRate: null,
    bpm: null,
    receivedAt: null,
    lastAcceptedPositionAt: null,
    source: null,
    positionCount: 0,
    positionRangeSeconds: 0,
    segmentMin: null,
    segmentMax: null,
    backwardSteps: 0,
    discontinuities: 0,
    rateChanges: 0,
    intervalCount: 0,
    intervalTotalMs: 0,
    intervalMaxMs: 0,
    loop: emptyLoop(),
    loopMessages: 0,
    loopBoundaryMessages: 0,
    drawableLoopBoundaryMessages: 0,
  };
}

function clearPosition(deck) {
  deck.positionSeconds = null;
  deck.playRate = null;
  deck.bpm = null;
  deck.receivedAt = null;
  deck.segmentMin = null;
  deck.segmentMax = null;
}

function clearCurrent(deck) {
  clearPosition(deck);
  deck.title = ''; deck.artist = '';
  deck.fileFingerprint = null;
  deck.source = null;
  deck.loop = emptyLoop();
}

function finiteArg(arg, type) {
  return arg?.type === type && typeof arg.value === 'number' && Number.isFinite(arg.value);
}

function safeRuntime(runtime) {
  const platforms = new Set(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos', 'android']);
  const arches = new Set(['arm', 'arm64', 'ia32', 'x64', 'ppc', 'ppc64', 's390', 's390x', 'riscv64', 'loong64']);
  const version = (value) => typeof value === 'string' && /^v?\d+(?:\.\d+){0,3}$/.test(value) ? value : null;
  return {
    platform: platforms.has(runtime.platform) ? runtime.platform : 'unknown',
    arch: arches.has(runtime.arch) ? runtime.arch : 'unknown',
    node: version(runtime.node),
    macos: version(runtime.macos),
  };
}

/** In-memory diagnostic state. Incoming titles never enter the saved report. */
export class DiagnosticState {
  #now;
  #start;
  #peers = new Map();
  #controlId = null;
  #connectionsTotal = 0;
  #pairedTotal = 0;
  #controlDisconnects = 0;
  #errors = new Set();
  #invalidStatusMessages = 0;
  #ignoredStatusMessages = 0;
  #decks = Array.from({ length: 4 }, (_, index) => deckState(index + 1));
  #fingerprintSalt = randomBytes(16);

  constructor({ simulation = false, now = () => performance.now() } = {}) {
    this.simulation = simulation === true;
    this.#now = now;
    this.#start = now();
  }

  peerConnected(id) {
    if (this.#peers.has(id)) return;
    this.#peers.set(id, { paired: false });
    this.#connectionsTotal += 1;
  }

  peerPaired(id) {
    const peer = this.#peers.get(id);
    if (!peer || peer.paired) return;
    peer.paired = true;
    this.#pairedTotal += 1;
    this.#controlId = id;
    // A new control epoch never inherits a previous connection's display.
    for (const deck of this.#decks) clearCurrent(deck);
  }

  peerClosed(id) {
    this.#peers.delete(id);
    if (this.#controlId === null || id !== this.#controlId) return;
    this.#controlDisconnects += 1;
    this.#controlId = null;
    for (const deck of this.#decks) {
      if (deck.source === id) clearCurrent(deck);
    }
  }

  recordError(code) {
    const safe = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? code : 'UNSPECIFIED_ERROR';
    if (this.#errors.size < 32) this.#errors.add(safe);
  }

  handleStatus(id, message) {
    if (!this.#peers.get(id)?.paired || id !== this.#controlId) {
      this.#ignoredStatusMessages += 1;
      return false;
    }
    if (!message || !TOPICS.has(message.address)) return false;
    const args = message.args;
    if (!Array.isArray(args) || !finiteArg(args[0], 'i') || !Number.isInteger(args[0].value)
      || args[0].value < 0 || args[0].value > 3) return this.#invalid();

    const deck = this.#decks[args[0].value];
    const { address } = message;
    if (address === '/Status/Deck/Playhead') {
      if (args.length !== 4 || !args.slice(1).every((arg) => finiteArg(arg, 'f'))) return this.#invalid();
      const [, { value: position }, { value: rate }, { value: bpm }] = args;
      const now = this.#now();
      if (deck.receivedAt !== null) {
        const interval = Math.max(0, now - deck.receivedAt);
        const delta = position - deck.positionSeconds;
        if (delta < -0.01) deck.backwardSteps += 1;
        if (Math.abs(delta - deck.playRate * interval / 1000) > 0.5) deck.discontinuities += 1;
        if (Math.abs(rate - deck.playRate) > 0.001) deck.rateChanges += 1;
        deck.intervalCount += 1;
        deck.intervalTotalMs += interval;
        deck.intervalMaxMs = Math.max(deck.intervalMaxMs, interval);
      }
      deck.source = id;
      deck.positionSeconds = position;
      deck.playRate = rate;
      deck.bpm = bpm;
      deck.receivedAt = now;
      deck.lastAcceptedPositionAt = now;
      deck.positionCount += 1;
      deck.segmentMin = deck.segmentMin === null ? position : Math.min(deck.segmentMin, position);
      deck.segmentMax = deck.segmentMax === null ? position : Math.max(deck.segmentMax, position);
      deck.positionRangeSeconds = Math.max(deck.positionRangeSeconds, deck.segmentMax - deck.segmentMin);
      return true;
    }

    if (address === '/Status/Deck/Loop/LoopInOutPoint') {
      // Real Serato 5.0 captures on both decks confirm iff, source-track ms.
      // Clear first: a partial manual edit or malformed update must not leave
      // the previous loop's geometry visible. Never reorder inverted points.
      clearLoopBounds(deck);
      if (args.length !== 3 || !args.slice(1).every((arg) => finiteArg(arg, 'f'))) return this.#invalid();
      const startMs = args[1].value, endMs = args[2].value;
      if (startMs < -1 || endMs < -1 || startMs > 86400000 || endMs > 86400000
        || startMs > -1 && startMs < 0 || endMs > -1 && endMs < 0) return this.#invalid();
      // -1 is Serato's unset sentinel. Equal/reversed points are transiently
      // sent while setting a manual loop; they carry no drawable interval.
      if (startMs >= 0 && endMs > startMs) {
        deck.loop.startSeconds = startMs / 1000;
        deck.loop.endSeconds = endMs / 1000;
        deck.drawableLoopBoundaryMessages += 1;
      }
      deck.source = id;
      deck.loopMessages += 1;
      deck.loopBoundaryMessages += 1;
      return true;
    }
    if (args.length !== 2) {
      if (address.startsWith('/Status/Deck/Loop/')) clearLoopBounds(deck);
      return this.#invalid();
    }
    if (address === '/Status/Deck/Song/Artist') {
      if (args[1]?.type !== 's' || typeof args[1].value !== 'string') return this.#invalid();
      deck.artist = terminalText(args[1].value); deck.artistSeen ||= deck.artist.length > 0;
      deck.artistMessages++; deck.source = id; return true;
    }
    if (address === '/Status/Deck/Song/Title') {
      if (args[1]?.type !== 's' || typeof args[1].value !== 'string') return this.#invalid();
      deck.titleMessages += 1;
      const title = terminalText(args[1].value);
      if (title !== deck.title) {
        // Metadata and position arrive separately. If a new title follows a
        // new position, prefer an empty display until its next position update
        // over temporarily pairing metadata with the previous track's value.
        clearPosition(deck);
        deck.loop = emptyLoop();
      }
      deck.source = id;
      deck.title = title;
      deck.titleSeen ||= title.length > 0;
      return true;
    }
    if (address === '/Status/Deck/Song/Filepath') {
      if (args[1]?.type !== 's' || typeof args[1].value !== 'string') return this.#invalid();
      deck.filePathMessages += 1;
      const pathPresent = args[1].value.length > 0;
      const fingerprint = pathPresent
        ? createHash('sha256').update(this.#fingerprintSalt).update(args[1].value).digest('hex')
        : null;
      if (fingerprint !== deck.fileFingerprint) {
        clearPosition(deck);
        deck.loop = emptyLoop();
      }
      deck.source = id;
      deck.fileFingerprint = fingerprint;
      deck.filePathSeen ||= pathPresent;
      return true;
    }
    if (!finiteArg(args[1], 'f')) {
      if (address.startsWith('/Status/Deck/Loop/')) clearLoopBounds(deck);
      return this.#invalid();
    }
    const value = args[1].value;
    if (address === '/Status/Deck/Song/Valid') {
      if (value !== 0 && value !== 1) return this.#invalid();
      if (value === 0) {
        deck.validFalseMessages += 1;
        clearCurrent(deck);
      } else {
        deck.validTrueMessages += 1;
        deck.source = id;
      }
      return true;
    }
    if (address === '/Status/Deck/Loop/BeatLength') {
      if (value < 0) { clearLoopBounds(deck); return this.#invalid(); }
      deck.loop.beatLength = value;
    } else {
      if (value !== 0 && value !== 1) { clearLoopBounds(deck); return this.#invalid(); }
      const field = LOOP_BOOLEAN_FIELDS.get(address);
      deck.loop[field] = value === 1;
      if (field === 'manualLoopSetting' && value === 1) clearLoopBounds(deck);
    }
    deck.source = id;
    deck.loopMessages += 1;
    return true;
  }

  #invalid() {
    this.#invalidStatusMessages += 1;
    return false;
  }

  snapshot() {
    const now = this.#now();
    return {
      simulation: this.simulation,
      elapsedSeconds: Math.max(0, now - this.#start) / 1000,
      connections: {
        total: this.#connectionsTotal,
        active: this.#peers.size,
        pairedActive: [...this.#peers.values()].filter((peer) => peer.paired).length,
        pairedTotal: this.#pairedTotal,
        controlDisconnects: this.#controlDisconnects,
      },
      errors: [...this.#errors],
      decks: this.#decks.map((deck) => ({
        id: deck.id,
        title: deck.title, artist: deck.artist, artistSeen: deck.artistSeen, artistMessages: deck.artistMessages,
        titleSeen: deck.titleSeen,
        filePathSeen: deck.filePathSeen,
        titleMessages: deck.titleMessages,
        filePathMessages: deck.filePathMessages,
        validTrueMessages: deck.validTrueMessages,
        validFalseMessages: deck.validFalseMessages,
        positionSeconds: deck.positionSeconds,
        playRate: deck.playRate,
        bpm: deck.bpm,
        lastPositionAgeMs: deck.receivedAt === null ? null : Math.max(0, now - deck.receivedAt),
        lastAcceptedPositionAgeMs: deck.lastAcceptedPositionAt === null
          ? null : Math.max(0, now - deck.lastAcceptedPositionAt),
        positionCount: deck.positionCount,
        positionRangeSeconds: deck.positionRangeSeconds,
        backwardSteps: deck.backwardSteps,
        discontinuities: deck.discontinuities,
        rateChanges: deck.rateChanges,
        loop: { ...deck.loop },
        loopMessages: deck.loopMessages,
        loopBoundaryMessages: deck.loopBoundaryMessages,
        drawableLoopBoundaryMessages: deck.drawableLoopBoundaryMessages,
        currentStream: deck.source !== null && deck.source === this.#controlId
          && this.#peers.get(deck.source)?.paired === true,
      })),
    };
  }

  createReport({ runtime = {}, endedReason = 'user' } = {}) {
    const snapshot = this.snapshot();
    const main = snapshot.decks.slice(0, 2);
    const bothMoved = main.every((deck) => deck.positionCount >= 2 && deck.positionRangeSeconds > 0.01);
    const anyPositions = main.some((deck) => deck.positionCount > 0);
    const allowedReasons = new Set(['user', 'duration', 'startup_error', 'runtime_error', 'signal']);
    return {
      schemaVersion: 1,
      programVersion: VERSION,
      mode: this.simulation ? 'simulation' : 'live',
      userTarget: {
        source: 'userProvided',
        macOS: '26.7.2',
        serato: '5.0',
        mixer: 'DJM-S7',
        display: 'iPhone15Pro',
      },
      runtime: safeRuntime(runtime),
      durationSeconds: Number(snapshot.elapsedSeconds.toFixed(3)),
      endedReason: allowedReasons.has(endedReason) ? endedReason : 'other',
      compatibility: { status: 'unverified', manualComparisonWithSeratoRequired: true },
      observations: {
        classification: this.simulation ? 'simulation_only'
          : bothMoved ? 'both_decks_moved' : anyPositions ? 'partial_data' : 'no_position_data',
        liveDataObserved: !this.simulation && anyPositions,
        bothMainDecksMoved: !this.simulation && bothMoved,
        displayLatencyMeasured: false,
        scratchOrCueSupportVerified: false,
      },
      connections: { ...snapshot.connections },
      invalidStatusMessages: this.#invalidStatusMessages,
      ignoredStatusMessages: this.#ignoredStatusMessages,
      errors: [...this.#errors],
      decks: this.#decks.map((deck) => ({
        id: deck.id,
        trackTitleSeen: deck.titleSeen, artistSeen: deck.artistSeen, artistMessages: deck.artistMessages,
        filePathSeen: deck.filePathSeen,
        titleMessages: deck.titleMessages,
        filePathMessages: deck.filePathMessages,
        validTrueMessages: deck.validTrueMessages,
        validFalseMessages: deck.validFalseMessages,
        lastAcceptedPositionAgeMs: snapshot.decks[deck.id - 1].lastAcceptedPositionAgeMs,
        positionCount: deck.positionCount,
        positionRangeSeconds: deck.positionRangeSeconds,
        backwardPositionSteps: deck.backwardSteps,
        positionDiscontinuities: deck.discontinuities,
        playRateChanges: deck.rateChanges,
        loopStatusMessages: deck.loopMessages,
        loopBoundaryMessages: deck.loopBoundaryMessages,
        drawableLoopBoundaryMessages: deck.drawableLoopBoundaryMessages,
        receivedIntervals: {
          count: deck.intervalCount,
          meanMs: deck.intervalCount === 0 ? null : deck.intervalTotalMs / deck.intervalCount,
          maxMs: deck.intervalCount === 0 ? null : deck.intervalMaxMs,
          includesPauseGaps: true,
          isDisplayLatency: false,
        },
      })),
    };
  }
}
