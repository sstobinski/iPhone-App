import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TrackInfo } from '../src/track-info.mjs';
import { linkedMetadata } from '../web/app.js';
class Probe extends EventEmitter { starts = 0; stops = 0; async start() { this.starts++; } async stop() { this.stops++; } }
const i = value => ({ type: 'i', value }), f = value => ({ type: 'f', value }), s = value => ({ type: 's', value });
const message = (address, ...args) => ({ address, args });
async function fixture(t) {
  const probe = new Probe(), info = new TrackInfo({ platform: 'darwin', probe });
  t.after(() => info.stop()); await info.start();
  probe.emit('connected', 1); probe.emit('paired', 1);
  const send = (address, ...args) => probe.emit('status', { id: 1, message: message(address, ...args) });
  return { probe, info, send };
}
test('the established status channel supplies sanitized titles/artists and text metadata for both decks without a second BPM display', async t => {
  const { info, send } = await fixture(t);
  for (const deck of [0, 1]) {
    send('/Status/Deck/Song/Title', i(deck), s(`<Track ${deck}>\u001b[31m\u202e`));
    send('/Status/Deck/Song/Artist', i(deck), s('PRIVATE_ARTIST'));
    send('/Status/Deck/Playhead', i(deck), f(12), f(1.1), f(120.5 + deck));
  }
  const state = info.getDisplayState(); assert.equal(state.status, 'connected');
  assert.deepEqual(state.decks.map(value => [value.title, value.artist]), [['<Track 0>', 'PRIVATE_ARTIST'], ['<Track 1>', 'PRIVATE_ARTIST']]);
  assert.doesNotMatch(JSON.stringify(info.getStats()), /PRIVATE_ARTIST|<Track|120\.5|Filepath/);
  assert.equal(info.getStats().decks[0].artistSeen, true);
});
test('unloading, losing the control peer and changing peer epochs clear current metadata', async t => {
  const { info, send, probe } = await fixture(t);
  send('/Status/Deck/Song/Title', i(0), s('PRIVATE_TITLE')); send('/Status/Deck/Song/Artist', i(0), s('PRIVATE_ARTIST'));
  send('/Status/Deck/Playhead', i(0), f(2), f(1), f(99)); send('/Status/Deck/Song/Valid', i(0), f(0));
  assert.deepEqual(info.getDisplayState().decks[0], { id: 1, title: '', artist: '' });
  send('/Status/Deck/Song/Title', i(0), s('PRIVATE_TITLE'));
  probe.emit('connected', 2); probe.emit('disconnected', 2); assert.equal(info.getDisplayState().status, 'connected');
  probe.emit('disconnected', 1); assert.equal(info.getDisplayState().status, 'waiting'); assert.equal(info.getDisplayState().decks[0].title, '');
  probe.emit('connected', 3); probe.emit('paired', 3); assert.equal(info.getDisplayState().status, 'connected');
  assert.equal(info.getDisplayState().decks[0].artist, '');
});
test('metadata failure and unsupported hosts settle independently and export bounded codes only', async t => {
  const { info, probe, send } = await fixture(t);
  send('/Status/Deck/Song/Title', i(0), s('PRIVATE_TITLE'));
  probe.emit('fatal', 'BONJOUR_PROCESS_EXITED');
  assert.equal(info.getDisplayState().status, 'unavailable'); assert.equal(info.getDisplayState().decks[0].title, '');
  assert.equal(info.getStats().errorCode, 'BONJOUR_PROCESS_EXITED');
  const unsupportedProbe = new Probe(), unsupported = new TrackInfo({ platform: 'linux', probe: unsupportedProbe });
  await unsupported.start(); assert.equal(unsupportedProbe.starts, 0); assert.equal(unsupported.getDisplayState().status, 'unavailable'); await unsupported.stop();
});
test('demo metadata is explicitly marked and starts no real Serato probe', async () => {
  const probe = new Probe(), info = new TrackInfo({ demo: true, probe });
  await info.start(); assert.equal(probe.starts, 0); assert.equal(info.getDisplayState().status, 'demo');
  assert.equal(info.getDisplayState().decks[0].title, 'Demo Track One'); assert.equal(Object.hasOwn(info.getDisplayState().decks[0], 'bpm'), false); await info.stop();
});
test('UI freshness applies to metadata without making paused, connected streams expire', () => {
  assert.equal(linkedMetadata({ status: 'connected' }), true);
  assert.equal(linkedMetadata({ status: 'connected' }, false), false);
  for (const status of ['unavailable', 'waiting', 'stopped']) assert.equal(linkedMetadata({ status }), false);
});

test('playback motion expires, excludes old peers and accepts reverse motion', async t => {
  const { playbackMotion } = await import('../src/track-info.mjs');
  const deck = extra => ({ currentStream: true, playRate: 1, lastPositionAgeMs: 100, ...extra });
  assert.deepEqual(playbackMotion([deck()], true), { state: 'moving', validForMs: 400 });
  assert.equal(playbackMotion([deck({ playRate: -1 })], true).state, 'moving');
  assert.equal(playbackMotion([deck({ playRate: 0 })], true).state, 'stationary');
  for (const extra of [{ currentStream: false }, { lastPositionAgeMs: 500 }, { lastPositionAgeMs: null }, { playRate: null }]) {
    assert.equal(playbackMotion([deck(extra)], true).state, 'unknown');
  }
  assert.equal(playbackMotion([deck()], false).state, 'unknown');
  assert.equal(playbackMotion([], true).state, 'unknown');
  const { info, send, probe } = await fixture(t);
  send('/Status/Deck/Playhead', i(0), f(12), f(1), f(120));
  assert.equal(info.getDisplayState().motion.state, 'moving');
  send('/Status/Deck/Song/Valid', i(0), f(0));
  assert.equal(info.getDisplayState().motion.state, 'unknown');
  send('/Status/Deck/Playhead', i(0), f(12), f(1), f(120));
  probe.emit('disconnected', 1);
  assert.equal(info.getDisplayState().motion.state, 'unknown');
});

test('a fresh moving deck qualifies without extending stale stationary evidence', async () => {
  const { playbackMotion } = await import('../src/track-info.mjs');
  const stationary = { currentStream: true, playRate: 0, lastPositionAgeMs: 100 };
  const moving = { currentStream: true, playRate: 1, lastPositionAgeMs: 450 };
  assert.deepEqual(playbackMotion([stationary, moving], true), { state: 'moving', validForMs: 50 });
  assert.deepEqual(playbackMotion([stationary, { ...moving, playRate: 0 }], true), { state: 'stationary', validForMs: 50 });
  assert.deepEqual(playbackMotion([stationary, { ...moving, lastPositionAgeMs: 501 }], true), { state: 'unknown', validForMs: 0 });
});
