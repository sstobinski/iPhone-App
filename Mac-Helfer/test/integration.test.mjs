import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from '../vendor/jpeg-js/index.js';
import { WindowSession } from '../src/window-session.mjs';
import { LayoutAnalyzer } from '../src/layout-analyzer.mjs';
import { createDemoSource } from '../src/demo-capture.mjs';
import { transferView } from '../web/app.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('worker decodes the packaged JPEG and detects the synthetic two-deck source', async () => {
  const analyzer = new LayoutAnalyzer();
  try {
    const result = await analyzer.analyze(jpeg.encode(createDemoSource(), 82).data);
    assert.equal(result.status, 'recognized'); assert.equal(result.layout, 'vertical-two-deck');
    assert.equal(analyzer.getStats().completed, 1);
  } finally { await analyzer.close(); }
  await assert.rejects(analyzer.analyze(Buffer.alloc(0)), { code: 'CAPTURE_ANALYSIS_CLOSED' });
});

test('session waits for stable detection and the exact crop acknowledgement before publishing', async () => {
  const requests = [], bytes = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 140) }, 70).data;
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true },
    analyze: async () => ({ status: 'recognized', layout: 'vertical-two-deck', confidence: .9,
      crop: { x: .2, y: .2, width: .6, height: .6 }, reason: 'SUPPORTED_TWO_DECK_PROFILE' }) });
  session.acceptPacket({ header: { type: 'status', status: 'capture-ready', geometryRevision: 1, cropRevision: 0 }, jpeg: Buffer.alloc(0) });
  for (let sequence = 1; sequence <= 2; sequence++) {
    session.acceptPacket({ header: { type: 'analysis', sequence, geometryRevision: 1, cropRevision: 0, width: 100, height: 100 }, jpeg: bytes });
    await tick(); await tick();
  }
  assert.equal(requests.length, 1); assert.equal(session.getPhoneFrame(), null);
  const request = requests[0];
  session.acceptPacket({ header: { type: 'status', status: 'crop-applied', geometryRevision: 1, cropRevision: 1, requestId: request.requestId + 1 }, jpeg: Buffer.alloc(0) });
  assert.equal(session.getPhoneFrame(), null);
  session.acceptPacket({ header: { type: 'status', status: 'crop-applied', geometryRevision: 1, cropRevision: 2, requestId: request.requestId }, jpeg: Buffer.alloc(0) });
  const cropped = jpeg.encode({ width: 60, height: 60, data: Buffer.alloc(14400, 140) }, 70).data;
  session.acceptPacket({ header: { type: 'frame', sequence: 3, geometryRevision: 1, cropRevision: 2, requestId: request.requestId, width: 60, height: 60 }, jpeg: cropped });
  assert.ok(session.getPhoneFrame());
  session.stopTransfer(); assert.equal(session.getPhoneFrame(), null);
  session.acceptPacket({ header: { type: 'frame', sequence: 4, geometryRevision: 1, cropRevision: 2, requestId: request.requestId, width: 100, height: 100 }, jpeg: bytes });
  assert.equal(session.getPhoneFrame(), null);
  assert.doesNotMatch(JSON.stringify(session.getStats()), /buffer|requestId|crop.*x|imageData/);
  session.close(); assert.equal(session.getSourceFrame(), null);
});

test('unchanged live source retains a still image but suspension or lost connection hides it', () => {
  const state = { native: { status: 'source-idle' }, transfer: { enabled: true, status: 'live', ageMs: 10000 } };
  const options = { now: 10000, stateAt: 10000, hasFrame: true, lastPaintAt: 0, linked: true };
  assert.equal(transferView(state, options).showFrame, true);
  assert.equal(transferView({ ...state, native: { status: 'source-paused' } }, options).showFrame, false);
  assert.equal(transferView(state, { ...options, stateAt: 0 }).showFrame, false);
});

test('full-resolution phone crops use backing pixels while the preview stays small', () => {
  const requests = [];
  const image = size => jpeg.encode({ width: size, height: size, data: Buffer.alloc(size * size * 4, 140) }, 80).data;
  const preview = image(100), crop = { x: .25, y: .25, width: .5, height: .5 };
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true },
    analyze: async () => ({ status: 'unrecognized' }) });
  const header = { type: 'analysis', width: 100, height: 100, captureWidth: 300, captureHeight: 300,
    sequence: 1, geometryRevision: 1, cropRevision: 0 };
  assert.equal(session.acceptPacket({ header, jpeg: preview }), true);
  session.setCrop({ geometryRevision: 1, crop });
  const requestId = requests[0].requestId;
  session.acceptPacket({ header: { type: 'status', status: 'crop-applied', geometryRevision: 1, cropRevision: 1, requestId }, jpeg: Buffer.alloc(0) });
  const frame = { type: 'frame', width: 150, height: 150, sequence: 2, geometryRevision: 1, cropRevision: 1, requestId };
  assert.equal(session.acceptPacket({ header: frame, jpeg: image(150) }), true);
  assert.equal(session.getSourceFrame().width, 100);
  assert.equal(session.getPhoneFrame().width, 150);
  // A low-res crop or an accidental whole-window frame cannot pass as the
  // approved high-resolution crop, even with matching request/revision IDs.
  for (const size of [50, 300]) {
    assert.equal(session.acceptPacket({ header: { ...frame, width: size, height: size, sequence: 3 }, jpeg: image(size) }), false);
  }
  // Switching backing resolution needs a geometry revision, even if the
  // preview dimensions happen to remain exactly the same.
  assert.equal(session.acceptPacket({ header: { ...header, sequence: 4, captureWidth: 200, captureHeight: 200 }, jpeg: preview }), false);
  assert.equal(session.getPhoneFrame(), null);
  session.close();
  assert.equal(session.getStats().lastCaptureWidth, 300);
  assert.equal(session.getStats().lastFrameWidth, 150);
});

test('automatic failure diagnostics survive manual selection and closing without exporting arbitrary detector text', async () => {
  const bytes = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 140) }, 70).data;
  let result = { status: 'unrecognized', reason: 'NO_WAVEFORM_PAIR' };
  const session = new WindowSession({ native: { sendCrop: () => true, clearCrop: () => true }, analyze: async () => result });
  const send = sequence => session.acceptPacket({ header: { type: 'analysis', width: 100, height: 100,
    sequence, geometryRevision: 1, cropRevision: 0 }, jpeg: bytes });
  send(1); await tick();
  assert.equal(session.getStats().noPairAnalyses, 1);
  result = { status: 'unrecognized', reason: 'AMBIGUOUS_LAYOUT' };
  send(2); await tick();
  assert.equal(session.getStats().ambiguousAnalyses, 1);
  session.setCrop({ geometryRevision: 1, crop: { x: .2, y: .2, width: .6, height: .6 } });
  session.close();
  assert.equal(session.getStats().lastAutoReason, 'AMBIGUOUS_LAYOUT');
  assert.equal(session.getStats().lastAutoLayout, null);
  assert.equal(session.getStats().lastAutoConfidence, 0);
});

test('an automatic detector result cannot publish the whole window or leak an arbitrary reason', async () => {
  const requests = [];
  const bytes = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 140) }, 70).data;
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true },
    analyze: async () => ({ status: 'recognized', reason: '/PRIVATE/FILE', layout: 'vertical-two-deck', confidence: .95,
      crop: { x: 0, y: 0, width: 1, height: 1 } }) });
  for (let sequence = 1; sequence <= 3; sequence++) {
    session.acceptPacket({ header: { type: 'analysis', width: 100, height: 100, sequence, geometryRevision: 1, cropRevision: 0 }, jpeg: bytes });
    await tick();
  }
  assert.equal(requests.length, 0);
  assert.equal(session.getPhoneFrame(), null);
  assert.equal(session.getStats().lastAutoReason, 'LAYOUT_NOT_CONFIRMED');
  assert.doesNotMatch(JSON.stringify(session.getStats()), /PRIVATE/);
  session.close();
});

test('session forwards only a current automatic region and keeps a structurally tracked single-deck crop without restarting it', async () => {
  const requests = [], contexts = []; let clears = 0;
  const crop = { x: .4, y: .1, width: .2, height: .6 };
  const bytes = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 140) }, 70).data;
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => { clears++; return true; } },
    analyze: async (_bytes, previous) => {
      contexts.push(previous);
      return { status: 'recognized', layout: 'vertical-two-deck', crop: { ...crop }, confidence: .9,
        reason: previous ? 'TRACKED_VERTICAL_SINGLE_DECK' : 'SUPPORTED_TWO_DECK_PROFILE' };
    } });
  const source = (sequence, geometryRevision = 1) => session.acceptPacket({ header: { type: 'analysis', sequence,
    geometryRevision, cropRevision: 0, width: 100, height: 100 }, jpeg: bytes });
  source(1); await tick(); source(2); await tick();
  assert.equal(requests.length, 1); assert.deepEqual(contexts, [null, null]);
  const requestId = requests[0].requestId;
  session.acceptPacket({ header: { type: 'status', status: 'crop-applied', requestId, geometryRevision: 1, cropRevision: 1 }, jpeg: Buffer.alloc(0) });
  session.acceptPacket({ header: { type: 'frame', sequence: 3, requestId, geometryRevision: 1, cropRevision: 1, width: 20, height: 60 },
    jpeg: jpeg.encode({ width: 20, height: 60, data: Buffer.alloc(4800, 140) }, 70).data });
  source(4); await tick();
  assert.deepEqual(contexts[2], { layout: 'vertical-two-deck', crop: requests[0].crop });
  assert.equal(session.getPhoneFrame().width, 20);
  assert.equal(requests.length, 1); assert.equal(clears, 0);
  assert.equal(session.getStats().singleDeckTrackedAnalyses, 1);
  assert.equal(session.getStats().lastAutoReason, 'TRACKED_VERTICAL_SINGLE_DECK');
  source(5, 2); await tick();
  assert.equal(contexts[3], null);
  assert.equal(session.getPhoneFrame(), null);
  assert.equal(requests.length, 1);
  session.close();
});


test('frame waiters skip identical JPEGs and clean up on new frame, abort, timeout and transfer stop', async () => {
  const requests = [], image = (size, shade) => jpeg.encode({ width: size, height: size, data: Buffer.alloc(size * size * 4, shade) }, 70).data;
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true }, analyze: async () => ({ status: 'unrecognized' }) });
  try {
    session.acceptPacket({ header: { type: 'analysis', width: 100, height: 100, sequence: 1, geometryRevision: 1, cropRevision: 0 }, jpeg: image(100, 140) });
    session.setCrop({ geometryRevision: 1, crop: { x: .2, y: .2, width: .6, height: .6 } });
    const requestId = requests[0].requestId;
    session.acceptPacket({ header: { type: 'status', status: 'crop-applied', geometryRevision: 1, cropRevision: 1, requestId }, jpeg: Buffer.alloc(0) });
    const send = (sequence, shade) => session.acceptPacket({ header: { type: 'frame', sequence, width: 60, height: 60, geometryRevision: 1, cropRevision: 1, requestId }, jpeg: image(60, shade) });
    send(2, 100); const first = session.getPhoneFrame().sequence;
    const waiting = session.waitForPhoneFrame(first);
    send(3, 100); assert.equal(session.getStats().waitingFrameRequests, 1);
    assert.equal(session.getStats().identicalFramesSkipped, 1);
    assert.equal(session.getState().transfer.unchanged, true);
    assert.equal(transferView({ ...session.getState(), native: { status: 'capture-ready' } }, { now: 10000, stateAt: 10000, hasFrame: true, lastPaintAt: 0, linked: true }).showFrame, true);
    send(4, 180); assert.equal((await waiting).sequence, first + 1);
    const abort = new AbortController(); const cancelled = session.waitForPhoneFrame(first + 1, { signal: abort.signal }); abort.abort();
    assert.equal(await cancelled, null);
    assert.equal(await session.waitForPhoneFrame(first + 1, { timeoutMs: 5 }), null);
    const waits = Array.from({ length: 16 }, () => session.waitForPhoneFrame(first + 1));
    assert.equal(await session.waitForPhoneFrame(first + 1), null);
    assert.equal(session.getStats().waitingFrameRequests, 16);
    session.stopTransfer(); assert.deepEqual(await Promise.all(waits), Array(16).fill(null));
    assert.equal(session.getStats().waitingFrameRequests, 0);
    assert.equal(session.getPhoneFrame(), null);
  } finally { session.close(); }
});

test('an orientation change in the same window hides the old crop before confirming its replacement', async () => {
  const requests = [], preview = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 100) }, 70).data;
  let result = { status: 'recognized', layout: 'vertical-two-deck', confidence: .92,
    crop: { x: .4, y: .1, width: .2, height: .6 }, reason: 'EMPTY_VERTICAL_LAYOUT' };
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true }, analyze: async () => result });
  let sequence = 0;
  const send = async () => {
    session.acceptPacket({ header: { type: 'analysis', width: 100, height: 100, sequence: ++sequence, geometryRevision: 1, cropRevision: requests.length }, jpeg: preview });
    await tick(); await tick();
  };
  try {
    await send(); await send();
    session.acceptPacket({ header: { type: 'status', status: 'crop-applied', geometryRevision: 1, cropRevision: 1, requestId: requests[0].requestId }, jpeg: Buffer.alloc(0) });
    const frame = { header: { type: 'frame', width: 20, height: 60, sequence: ++sequence, geometryRevision: 1, cropRevision: 1, requestId: requests[0].requestId },
      jpeg: jpeg.encode({ width: 20, height: 60, data: Buffer.alloc(4800, 100) }, 70).data };
    assert.equal(session.acceptPacket(frame), true); assert.ok(session.getPhoneFrame());
    result = { status: 'recognized', layout: 'horizontal-two-deck', confidence: .92,
      crop: { x: .1, y: .2, width: .8, height: .4 }, reason: 'EMPTY_HORIZONTAL_LAYOUT' };
    await send(); assert.equal(session.getPhoneFrame(), null); assert.equal(requests.length, 1);
    assert.equal(session.acceptPacket({ ...frame, header: { ...frame.header, sequence: ++sequence } }), false);
    await send(); assert.equal(requests.length, 2);
    assert.equal(session.getState().detection.layout, 'horizontal-two-deck');
    assert.equal(session.getState().detection.reason, 'EMPTY_HORIZONTAL_LAYOUT');
    assert.equal(session.getStats().emptyHorizontalAnalyses, 2);
    assert.equal(session.getStats().framedHorizontalAnalyses, 0);
  } finally { session.close(); }
});

test('horizontal tracking context is forwarded only within the same source geometry', async () => {
  const contexts = [], requests = [], crop = { x: .1, y: .1, width: .8, height: .4 };
  const bytes = jpeg.encode({ width: 100, height: 100, data: Buffer.alloc(40000, 100) }, 70).data;
  const session = new WindowSession({ native: { sendCrop: value => { requests.push(value); return true; }, clearCrop: () => true },
    analyze: async (_value, previous) => { contexts.push(previous); return { status: 'recognized', layout: 'horizontal-two-deck', confidence: .92, crop,
      reason: previous ? 'TRACKED_HORIZONTAL_LAYOUT' : 'HORIZONTAL_OVERVIEW_LAYOUT' }; } });
  let sequence = 0;
  const send = async geometryRevision => {
    session.acceptPacket({ header: { type: 'analysis', width: 100, height: 100, sequence: ++sequence, geometryRevision, cropRevision: 0 }, jpeg: bytes });
    await tick(); await tick();
  };
  try {
    await send(1); await send(1); await send(1);
    assert.deepEqual(contexts.slice(0, 2), [null, null]);
    assert.deepEqual(contexts[2], { layout: 'horizontal-two-deck', crop: requests[0].crop });
    assert.equal(session.getStats().trackedHorizontalAnalyses, 1); assert.equal(requests.length, 1);
    await send(2); assert.equal(contexts[3], null); assert.equal(session.getPhoneFrame(), null);
  } finally { session.close(); }
});
