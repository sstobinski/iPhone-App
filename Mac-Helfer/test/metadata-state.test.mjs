import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticState } from '../src/metadata-state.mjs';
import { VERSION } from '../src/version.mjs';

const i = (value) => ({ type: 'i', value });
const f = (value) => ({ type: 'f', value });
const s = (value) => ({ type: 's', value });
const msg = (address, ...args) => ({ address, args });
const playhead = (deck, position, rate = 1, bpm = 120) => msg('/Status/Deck/Playhead', i(deck), f(position), f(rate), f(bpm));
const title = (deck, value) => msg('/Status/Deck/Song/Title', i(deck), s(value));
const path = (deck, value) => msg('/Status/Deck/Song/Filepath', i(deck), s(value));

function fixture(options = {}) {
  let time = 100;
  const state = new DiagnosticState({ now: () => time, ...options });
  state.peerConnected('control');
  state.peerPaired('control');
  return { state, tick: (amount) => { time += amount; } };
}

test('requires pairing and maps only zero-based deck indices 0..3', () => {
  const state = new DiagnosticState();
  state.peerConnected('peer');
  assert.equal(state.handleStatus('peer', playhead(0, 4)), false);
  assert.equal(state.snapshot().decks[0].positionCount, 0);
  state.peerPaired('peer');
  for (let deck = 0; deck < 4; deck += 1) state.handleStatus('peer', playhead(deck, deck + 10));
  assert.deepEqual(state.snapshot().decks.map((deck) => deck.positionSeconds), [10, 11, 12, 13]);
  for (const deck of [-1, 4, 0.5]) assert.equal(state.handleStatus('peer', playhead(deck, 999)), false);
  assert.equal(state.createReport().invalidStatusMessages, 3);
});

test('rejects malformed, nonfinite, and wrongly typed playheads', () => {
  const { state } = fixture();
  for (const message of [
    playhead(0, NaN), playhead(0, Infinity), playhead(0, 1, -Infinity),
    msg('/Status/Deck/Playhead', f(0), f(3), f(1), f(120)),
    msg('/Status/Deck/Playhead', i(0), s('3'), f(1), f(120)),
    msg('/Status/Deck/Playhead', i(0), f(3), f(1)),
    msg('/Status/Deck/Playhead', i(0), f(3), f(1), f(120), f(4)),
  ]) assert.equal(state.handleStatus('control', message), false);
  assert.equal(state.snapshot().decks[0].positionCount, 0);
  assert.equal(state.createReport().invalidStatusMessages, 7);
});

test('tracks observed changes and received intervals with monotonic sample times', () => {
  const { state, tick } = fixture();
  state.handleStatus('control', playhead(0, 10, 1));
  tick(100);
  state.handleStatus('control', playhead(0, 10.1, 1.1));
  tick(100);
  state.handleStatus('control', playhead(0, 4, -1));
  tick(50);
  const deck = state.snapshot().decks[0];
  assert.equal(deck.positionCount, 3);
  assert.equal(deck.lastPositionAgeMs, 50);
  assert.equal(deck.backwardSteps, 1);
  assert.equal(deck.discontinuities, 1);
  assert.equal(deck.rateChanges, 2);
  assert.ok(Math.abs(deck.positionRangeSeconds - 6.1) < 1e-9);
  const reportDeck = state.createReport().decks[0];
  assert.equal(reportDeck.receivedIntervals.meanMs, 100);
  assert.equal(reportDeck.receivedIntervals.isDisplayLatency, false);
});

test('heartbeat close preserves current values; control close clears current values but retains statistics', () => {
  const { state } = fixture();
  state.peerConnected('heartbeat');
  state.handleStatus('control', title(0, 'Track A'));
  state.handleStatus('control', playhead(0, 17));
  state.peerClosed('heartbeat');
  assert.equal(state.snapshot().decks[0].positionSeconds, 17);
  state.peerClosed('control');
  const deck = state.snapshot().decks[0];
  assert.equal(deck.positionSeconds, null);
  assert.equal(deck.title, '');
  assert.equal(deck.currentStream, false);
  assert.equal(deck.positionCount, 1);
  assert.equal(state.snapshot().connections.active, 0);
});

test('new paired epoch drops old display and ignores remaining old control data', () => {
  const { state } = fixture();
  state.handleStatus('control', title(0, 'Old track'));
  state.handleStatus('control', playhead(0, 30));
  state.peerConnected('next');
  state.peerPaired('next');
  assert.equal(state.snapshot().decks[0].positionSeconds, null);
  assert.equal(state.handleStatus('control', playhead(0, 31)), false);
  state.handleStatus('next', playhead(0, 2));
  state.peerClosed('control');
  assert.equal(state.snapshot().decks[0].positionSeconds, 2);
  assert.equal(state.snapshot().decks[0].positionCount, 2);
});

test('track replacement and eject clear position without inventing movement across tracks', () => {
  const { state } = fixture();
  state.handleStatus('control', title(0, 'Track A'));
  state.handleStatus('control', path(0, '/Users/dj/Music/A.mp3'));
  state.handleStatus('control', playhead(0, 100));
  state.handleStatus('control', title(0, 'Track B'));
  assert.equal(state.snapshot().decks[0].positionSeconds, null);
  state.handleStatus('control', path(0, '/Users/dj/Music/B.mp3'));
  state.handleStatus('control', playhead(0, 0));
  assert.equal(state.snapshot().decks[0].positionRangeSeconds, 0);
  assert.equal(state.snapshot().decks[0].backwardSteps, 0);
  state.handleStatus('control', msg('/Status/Deck/Song/Valid', i(0), f(0)));
  assert.equal(state.snapshot().decks[0].positionSeconds, null);
  assert.equal(state.snapshot().decks[0].title, '');
  assert.equal(state.snapshot().decks[0].positionCount, 2);
});

test('late track metadata invalidates a value until the next playhead arrives', () => {
  const { state } = fixture();
  state.handleStatus('control', playhead(0, 5));
  state.handleStatus('control', title(0, 'New track'));
  assert.equal(state.snapshot().decks[0].positionSeconds, null);
  state.handleStatus('control', playhead(0, 5.1));
  assert.equal(state.snapshot().decks[0].positionSeconds, 5.1);
});

test('file change alone invalidates a same-title track; exact same path does not', () => {
  const { state } = fixture();
  state.handleStatus('control', path(0, '/one.mp3'));
  state.handleStatus('control', playhead(0, 1));
  state.handleStatus('control', path(0, '/one.mp3'));
  assert.equal(state.snapshot().decks[0].positionSeconds, 1);
  state.handleStatus('control', path(0, '/two.mp3'));
  assert.equal(state.snapshot().decks[0].positionSeconds, null);
});

test('validates loop states independently and does not expose mutable internals', () => {
  const { state } = fixture();
  state.handleStatus('control', msg('/Status/Deck/Loop/AutoLoopOn', i(0), f(1)));
  state.handleStatus('control', msg('/Status/Deck/Loop/BeatLength', i(0), f(4)));
  state.handleStatus('control', msg('/Status/Deck/Loop/LoopRollOn', i(0), f(0)));
  assert.equal(state.handleStatus('control', msg('/Status/Deck/Loop/AutoLoopOn', i(0), f(2))), false);
  assert.equal(state.handleStatus('control', msg('/Status/Deck/Loop/BeatLength', i(0), f(-1))), false);
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.decks[0].loop, { autoLoopOn: true, beatLength: 4, loopRollOn: false,
    manualLoopOn: null, manualLoopSetting: null, startSeconds: null, endSeconds: null });
  assert.equal(snapshot.decks[0].loopMessages, 3);
  snapshot.decks[0].loop.autoLoopOn = false;
  assert.equal(state.snapshot().decks[0].loop.autoLoopOn, true);
});

test('live loop bounds convert source-track milliseconds independently for both decks and update at resize', () => {
  const { state } = fixture();
  const bounds = (deck, start, end) => msg('/Status/Deck/Loop/LoopInOutPoint', i(deck), f(start), f(end));
  assert.equal(state.handleStatus('control', bounds(0, 53656.828125, 56446.23046875)), true);
  assert.equal(state.handleStatus('control', bounds(1, 24604.904296875, 29938.236328125)), true);
  let decks = state.snapshot().decks;
  assert.equal(decks[0].loop.startSeconds, 53.656828125);
  assert.equal(decks[0].loop.endSeconds, 56.44623046875);
  assert.equal(decks[1].loop.startSeconds, 24.604904296875);
  assert.equal(decks[1].loop.endSeconds, 29.938236328125);
  state.handleStatus('control', bounds(1, 24604.904296875, 27271.5703125));
  decks = state.snapshot().decks;
  assert.equal(decks[1].loop.endSeconds, 27.2715703125);
  assert.equal(decks[0].loop.endSeconds, 56.44623046875);
  decks[1].loop.endSeconds = 999;
  assert.equal(state.snapshot().decks[1].loop.endSeconds, 27.2715703125);
  const report = state.createReport();
  assert.equal(report.decks[1].loopBoundaryMessages, 2);
  assert.equal(report.decks[1].drawableLoopBoundaryMessages, 2);
  assert.doesNotMatch(JSON.stringify(report), /startSeconds|endSeconds|53656\.828|53\.656828/);
});

test('unset, incomplete manual and malformed loop points remove the previous range without sorting or guessing', () => {
  const { state } = fixture();
  const bounds = (...args) => msg('/Status/Deck/Loop/LoopInOutPoint', i(0), ...args);
  for (const [message, accepted] of [
    [bounds(f(-1), f(-1)), true],
    [bounds(f(-1), f(2000)), true],
    [bounds(f(3000), f(2000)), true],
    [bounds(f(0), f(0)), true],
    [bounds(f(NaN), f(4000)), false],
    [bounds(f(1000), f(Infinity)), false],
    [bounds(f(-2), f(4000)), false],
    [bounds(f(-0.5), f(4000)), false],
    [bounds(f(1000), f(86400001)), false],
    [bounds(i(1000), f(4000)), false],
    [bounds(f(1000)), false],
    [bounds(f(1000), f(4000), f(5000)), false],
  ]) {
    state.handleStatus('control', bounds(f(1000), f(4000)));
    assert.equal(state.handleStatus('control', message), accepted);
    assert.equal(state.snapshot().decks[0].loop.startSeconds, null);
    assert.equal(state.snapshot().decks[0].loop.endSeconds, null);
  }
  assert.equal(state.handleStatus('control', bounds(f(0), f(86400000))), true);
  assert.equal(state.snapshot().decks[0].loop.startSeconds, 0);
  assert.equal(state.snapshot().decks[0].loop.endSeconds, 86400);
});

test('manual loop setting clears old geometry until fresh valid points arrive', () => {
  const { state } = fixture();
  const status = (topic, value) => msg(`/Status/Deck/Loop/${topic}`, i(0), f(value));
  const bounds = (start, end) => msg('/Status/Deck/Loop/LoopInOutPoint', i(0), f(start), f(end));
  state.handleStatus('control', bounds(53656.828125, 53700.4140625));
  state.handleStatus('control', status('ManualLoopOn', 1));
  state.handleStatus('control', status('ManualLoopSetting', 1));
  assert.equal(state.snapshot().decks[0].loop.startSeconds, null);
  state.handleStatus('control', bounds(55882.71875, 53700.4140625));
  assert.equal(state.snapshot().decks[0].loop.endSeconds, null);
  state.handleStatus('control', bounds(55882.71875, 58189.3828125));
  state.handleStatus('control', status('ManualLoopSetting', 0));
  assert.equal(state.snapshot().decks[0].loop.startSeconds, 55.88271875);
  assert.equal(state.snapshot().decks[0].loop.endSeconds, 58.1893828125);
  assert.equal(state.handleStatus('control', status('ManualLoopOn', 2)), false);
  assert.equal(state.snapshot().decks[0].loop.startSeconds, null);
});

test('all loop fields clear on track change, eject and control epoch, while heartbeat close preserves them', () => {
  for (const reset of ['title', 'path', 'eject', 'disconnect', 'pair']) {
    const { state } = fixture();
    state.handleStatus('control', title(0, 'Track A'));
    state.handleStatus('control', path(0, '/one.mp3'));
    for (const topic of ['AutoLoopOn', 'ManualLoopOn', 'LoopRollOn', 'ManualLoopSetting']) {
      state.handleStatus('control', msg(`/Status/Deck/Loop/${topic}`, i(0), f(1)));
    }
    state.handleStatus('control', msg('/Status/Deck/Loop/BeatLength', i(0), f(4)));
    state.handleStatus('control', msg('/Status/Deck/Loop/LoopInOutPoint', i(0), f(1000), f(3000)));
    state.peerConnected('heartbeat'); state.peerClosed('heartbeat');
    assert.equal(state.snapshot().decks[0].loop.endSeconds, 3);
    if (reset === 'title') state.handleStatus('control', title(0, 'Track B'));
    if (reset === 'path') state.handleStatus('control', path(0, '/two.mp3'));
    if (reset === 'eject') state.handleStatus('control', msg('/Status/Deck/Song/Valid', i(0), f(0)));
    if (reset === 'disconnect') state.peerClosed('control');
    if (reset === 'pair') { state.peerConnected('next'); state.peerPaired('next'); }
    assert.ok(Object.values(state.snapshot().decks[0].loop).every(value => value === null), reset);
    assert.equal(state.snapshot().decks[0].loopBoundaryMessages, 1, 'lifetime counters persist');
  }
});

test('report is allowlisted and does not contain song, path, peer, or raw error data', () => {
  const { state, tick } = fixture();
  state.handleStatus('control', title(0, 'SECRET SONG \x1b[2J\n\u202eTEST'));
  state.handleStatus('control', path(0, '/Users/private-dj/Secret/collection.mp3'));
  state.handleStatus('control', playhead(0, 2));
  tick(100);
  state.handleStatus('control', playhead(0, 2.1));
  state.recordError('BAD_FRAME');
  state.recordError('/Users/private-dj 192.168.1.4 PERSONAL-MAC');
  const report = state.createReport({
    runtime: { platform: 'darwin', arch: 'arm64', node: '24.1.0', macos: '26.7.2', hostname: 'PERSONAL-MAC', path: '/Users/private-dj' },
    endedReason: '/Users/private-dj',
  });
  const json = JSON.stringify(report);
  for (const forbidden of ['SECRET SONG', 'private-dj', 'collection.mp3', 'PERSONAL-MAC', '192.168.1.4', 'fingerprint']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.equal(report.compatibility.status, 'unverified');
  assert.equal(report.endedReason, 'other');
  assert.deepEqual(report.errors, ['BAD_FRAME', 'UNSPECIFIED_ERROR']);
  assert.equal(state.snapshot().decks[0].title, 'SECRET SONG TEST');
});

test('title display removes bidirectional and line-control characters and limits length', () => {
  const { state } = fixture();
  state.handleStatus('control', title(0, '\u061c\u200e\u200f\u2028\u2029' + '🎧'.repeat(150)));
  assert.equal(state.snapshot().decks[0].title, '🎧'.repeat(120));
});

test('simulation can never claim observed live data or verified compatibility', () => {
  const { state, tick } = fixture({ simulation: true });
  for (const deck of [0, 1]) state.handleStatus('control', playhead(deck, 1));
  tick(100);
  for (const deck of [0, 1]) state.handleStatus('control', playhead(deck, 2));
  const report = state.createReport();
  assert.equal(report.mode, 'simulation');
  assert.equal(report.observations.classification, 'simulation_only');
  assert.equal(report.observations.liveDataObserved, false);
  assert.equal(report.observations.bothMainDecksMoved, false);
  assert.equal(report.compatibility.status, 'unverified');
});

test('both-deck movement is an observation, not automatic compatibility verification', () => {
  const { state, tick } = fixture();
  for (const deck of [0, 1]) state.handleStatus('control', playhead(deck, 1));
  tick(100);
  for (const deck of [0, 1]) state.handleStatus('control', playhead(deck, 1.1));
  const report = state.createReport();
  assert.equal(report.observations.classification, 'both_decks_moved');
  assert.equal(report.observations.bothMainDecksMoved, true);
  assert.equal(report.observations.scratchOrCueSupportVerified, false);
  assert.equal(report.compatibility.status, 'unverified');
});

test('metadata counters include only validated messages and persist through clear and reconnect', () => {
  const { state } = fixture();
  for (const message of [
    title(0, 'Track A'), title(0, ''),
    path(0, '/Users/private/track.mp3'), path(0, ''),
    msg('/Status/Deck/Song/Valid', i(0), f(1)),
    msg('/Status/Deck/Song/Valid', i(0), f(1)),
    msg('/Status/Deck/Song/Valid', i(0), f(0)),
  ]) assert.equal(state.handleStatus('control', message), true);
  for (const message of [
    msg('/Status/Deck/Song/Title', i(0), f(1)),
    msg('/Status/Deck/Song/Title', i(0), s('extra'), s('argument')),
    msg('/Status/Deck/Song/Filepath', i(0), s(123)),
    msg('/Status/Deck/Song/Filepath', i(4), s('/outside-deck')),
    msg('/Status/Deck/Song/Valid', i(0), i(1)),
    msg('/Status/Deck/Song/Valid', i(0), f(2)),
    msg('/Status/Deck/Song/Valid', i(0), f(NaN)),
    msg('/Status/Deck/Song/Valid', i(0), f(0), f(0)),
  ]) assert.equal(state.handleStatus('control', message), false);
  const counts = ({ titleMessages, filePathMessages, validTrueMessages, validFalseMessages }) => ({
    titleMessages, filePathMessages, validTrueMessages, validFalseMessages,
  });
  const expected = { titleMessages: 2, filePathMessages: 2, validTrueMessages: 2, validFalseMessages: 1 };
  assert.deepEqual(counts(state.snapshot().decks[0]), expected);
  assert.deepEqual(counts(state.createReport().decks[0]), expected);
  assert.deepEqual(counts(state.snapshot().decks[1]), {
    titleMessages: 0, filePathMessages: 0, validTrueMessages: 0, validFalseMessages: 0,
  });
  state.peerClosed('control');
  state.peerConnected('next');
  state.peerPaired('next');
  assert.deepEqual(counts(state.snapshot().decks[0]), expected);
  assert.equal(state.handleStatus('control', title(0, 'Ignored old stream')), false);
  assert.deepEqual(counts(state.snapshot().decks[0]), expected);
  assert.equal(state.createReport().invalidStatusMessages, 8);
});

test('lifetime pairing and control disconnect counters exclude duplicate and heartbeat events', () => {
  const { state } = fixture();
  state.peerPaired('control');
  state.peerPaired('not-connected');
  state.peerConnected('heartbeat');
  state.peerClosed('heartbeat');
  assert.deepEqual(state.snapshot().connections, {
    total: 2, active: 1, pairedActive: 1, pairedTotal: 1, controlDisconnects: 0,
  });
  state.peerConnected('next');
  state.peerPaired('next');
  // The replaced control connection is no longer the current control.
  state.peerClosed('control');
  assert.equal(state.snapshot().connections.controlDisconnects, 0);
  state.peerClosed('next');
  state.peerClosed('next');
  state.peerClosed(null);
  assert.deepEqual(state.createReport().connections, {
    total: 3, active: 0, pairedActive: 0, pairedTotal: 2, controlDisconnects: 1,
  });
});

test('last accepted position age survives track clears and control loss but changes only on accepted positions', () => {
  const { state, tick } = fixture();
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, null);
  state.handleStatus('control', playhead(0, 42));
  tick(100);
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 100);
  state.peerConnected('heartbeat');
  state.peerClosed('heartbeat');
  assert.equal(state.snapshot().decks[0].lastPositionAgeMs, 100);
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 100);
  state.handleStatus('control', title(0, 'A different track'));
  assert.equal(state.snapshot().decks[0].lastPositionAgeMs, null);
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 100);
  tick(50);
  state.handleStatus('control', playhead(0, NaN));
  state.peerClosed('control');
  tick(50);
  assert.equal(state.snapshot().decks[0].lastPositionAgeMs, null);
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 200);
  assert.equal(state.createReport().decks[0].lastAcceptedPositionAgeMs, 200);
  state.peerConnected('next');
  state.peerPaired('next');
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 200);
  state.handleStatus('control', playhead(0, 44));
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 200);
  state.handleStatus('next', playhead(0, 3));
  assert.equal(state.snapshot().decks[0].lastAcceptedPositionAgeMs, 0);
  tick(25);
  assert.equal(state.createReport().decks[0].lastAcceptedPositionAgeMs, 25);
  assert.equal(state.createReport().decks[1].lastAcceptedPositionAgeMs, null);
});

test('report identifies the program version while leaving compatibility unverified', () => {
  const { state } = fixture();
  const report = state.createReport();
  assert.equal(report.programVersion, VERSION);
  assert.equal(report.compatibility.status, 'unverified');
});
