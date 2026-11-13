import { SeratoProbe } from './serato-bridge.mjs';
import { DiagnosticState } from './metadata-state.mjs';

/** Motion is a short-lived observation of Serato's play-rate, not a Play-button
 * state. Reverse playback and scratching can also count as motion. Missing,
 * stale, unloaded or disconnected playheads never imply active playback. */
export function playbackMotion(decks, connected) {
  if (!connected) return { state: 'unknown', validForMs: 0 };
  const fresh = decks.filter(deck => deck.currentStream && Number.isFinite(deck.playRate)
    && Number.isFinite(deck.lastPositionAgeMs) && deck.lastPositionAgeMs >= 0 && deck.lastPositionAgeMs < 500);
  const moving = fresh.filter(deck => Math.abs(deck.playRate) > 0.01);
  if (moving.length) return { state: 'moving', validForMs: Math.max(...moving.map(deck => 500 - deck.lastPositionAgeMs)) };
  if (fresh.length === decks.length && decks.length) return { state: 'stationary', validForMs: Math.min(...fresh.map(deck => 500 - deck.lastPositionAgeMs)) };
  return { state: 'unknown', validForMs: 0 };
}

/** Independent receive-only metadata channel. It never controls image capture,
 * opens a MIDI port, reads music files or emits Serato /Control messages. */
export class TrackInfo {
  #state; #probe; #platform; #demo; #status = 'waiting'; #error = null;
  #active = null; #stopping = false; #startTask = null;
  constructor({ probe = null, platform = process.platform, demo = false, state = new DiagnosticState({ simulation: demo }) } = {}) {
    this.#platform = platform; this.#demo = demo; this.#state = state;
    this.#probe = demo ? null : probe ?? new SeratoProbe();
    if (!this.#probe) return;
    this.#probe.on('connected', id => { if (!this.#stopping) this.#state.peerConnected(id); });
    this.#probe.on('paired', id => {
      if (this.#stopping || this.#status === 'unavailable') return;
      this.#active = id; this.#state.peerPaired(id); this.#status = 'connected';
    });
    this.#probe.on('status', ({ id, message }) => { if (!this.#stopping && this.#status === 'connected') this.#state.handleStatus(id, message); });
    this.#probe.on('disconnected', id => {
      this.#state.peerClosed(id);
      if (id === this.#active) { this.#active = null; if (!this.#stopping && this.#status !== 'unavailable') this.#status = 'waiting'; }
    });
    this.#probe.on('issue', code => this.#state.recordError(code));
    this.#probe.on('fatal', code => { this.#fail(code); void this.#probe.stop().catch(() => {}); });
  }
  #fail(code) {
    this.#status = 'unavailable'; this.#error = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'METADATA_UNAVAILABLE';
    this.#state.recordError(this.#error);
    if (this.#active !== null) this.#state.peerClosed(this.#active);
    this.#active = null;
  }
  start() {
    if (this.#startTask) return this.#startTask;
    this.#startTask = (async () => {
      if (this.#stopping) return;
      if (this.#demo) { this.#status = 'demo'; return; }
      if (this.#platform !== 'darwin') { this.#fail('METADATA_UNSUPPORTED_PLATFORM'); return; }
      try { await this.#probe.start(); if (this.#stopping) await this.#probe.stop(); }
      catch (error) { if (!this.#stopping) this.#fail(error?.code); }
    })();
    return this.#startTask;
  }
  getDisplayState() {
    const status = this.#stopping ? 'stopped' : this.#status;
    if (this.#demo) return { status, motion: { state: 'unknown', validForMs: 0 }, decks: [
      { id: 1, title: 'Demo Track One', artist: 'Synthetische Demo', bpm: 123.4 },
      { id: 2, title: 'Demo Track Two', artist: 'Synthetische Demo', bpm: 124.0 },
    ] };
    const connected = status === 'connected', decks = this.#state.snapshot().decks.slice(0, 2);
    return { status, motion: playbackMotion(decks, connected), decks: decks.map(deck => ({ id: deck.id,
      title: connected ? deck.title : '', artist: connected ? deck.artist : '',
      bpm: connected && Number.isFinite(deck.bpm) && deck.bpm > 0 && deck.bpm <= 1000 ? deck.bpm : null })) };
  }
  getStats() {
    const report = this.#state.createReport();
    return { status: this.#status, errorCode: this.#error, connectionSnapshotBeforeShutdown: !this.#stopping,
      connections: report.connections, invalidStatusMessages: report.invalidStatusMessages,
      ignoredStatusMessages: report.ignoredStatusMessages, errors: report.errors,
      decks: report.decks.slice(0, 2).map(deck => ({ id: deck.id, titleSeen: deck.trackTitleSeen,
        artistSeen: deck.artistSeen, titleMessages: deck.titleMessages, artistMessages: deck.artistMessages,
        positionCount: deck.positionCount, validFalseMessages: deck.validFalseMessages })) };
  }
  async stop() {
    this.#stopping = true;
    await this.#probe?.stop(); await this.#startTask;
  }
}
