import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCrop, selectionCrop, pixelCrop } from '../web/crop.js';
import { readFrameHeaders, frameMatchesState, manualCropRequest, nativeMessage,
  transferView, decodeCurrentFrame } from '../web/app.js';

const state = changes => ({ mode: 'live', admin: false, native: { status: 'capture-ready', errorCode: null },
  source: { available: true, width: 1280, height: 720, sequence: 8, geometryRevision: 4, ageMs: 10 },
  detection: { status: 'recognized', layout: 'horizontal-two-deck', confidence: .9,
    crop: { x: .1, y: .2, width: .8, height: .3 } },
  transfer: { enabled: true, status: 'live', sequence: 12, geometryRevision: 4,
    cropRevision: 3, width: 1024, height: 216, ageMs: 20 }, ...changes });
const metadata = changes => ({ sequence: 12, geometryRevision: 4, cropRevision: 3, ...changes });
const header = changes => new Headers({ 'Content-Type': 'image/jpeg', 'X-Frame-Sequence': '12',
  'X-Frame-Geometry': '4', 'X-Frame-Crop': '3', ...changes });
const jpegResponse = changes => new Response(new Uint8Array(24), { headers: header(changes) });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('manual selection is normalized within the window in either direction and across Retina scaling', () => {
  const bounds = { left: 100, top: 50, width: 800, height: 400 };
  const value = selectionCrop({ x: 300, y: 150 }, { x: 700, y: 350 }, bounds);
  assert.deepEqual(value, { x: .25, y: .25, width: .5, height: .5 });
  assert.deepEqual(selectionCrop({ x: 700, y: 350 }, { x: 300, y: 150 }, bounds), value);
  assert.deepEqual(pixelCrop(value, 1600, 800), { x: 400, y: 200, width: 800, height: 400 });
  assert.deepEqual(selectionCrop({ x: 0, y: 0 }, { x: 1000, y: 1000 }, bounds), { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(selectionCrop({ x: 200, y: 100 }, { x: 200, y: 200 }, bounds), null);
  assert.equal(selectionCrop({ x: NaN, y: 100 }, { x: 200, y: 200 }, bounds), null);
});

test('source crop geometry rejects coercions/outside areas and covers edge pixels without wrapping', () => {
  for (const value of [null, {}, { x: -.1, y: 0, width: .5, height: 1 },
    { x: 0, y: 0, width: 1.1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: '0', y: 0, width: 1, height: 1 }, { x: 0, y: Infinity, width: 1, height: 1 }]) assert.equal(normalizeCrop(value), null);
  assert.deepEqual(pixelCrop({ x: .99999, y: .99999, width: .00001, height: .00001 }, 1920, 1080),
    { x: 1919, y: 1079, width: 1, height: 1 });
  assert.equal(pixelCrop({ x: 0, y: 0, width: 1, height: 1 }, 0, 100), null);
});

test('JPEG metadata requires exact bounded integer revisions and no ambiguous sequence strings', () => {
  assert.deepEqual(readFrameHeaders(header()), metadata());
  assert.deepEqual(readFrameHeaders(header({ 'X-Frame-Sequence': '0', 'X-Frame-Crop': '0' }), { source: true }),
    metadata({ sequence: 0, cropRevision: 0 }));
  for (const fields of [{ 'X-Frame-Sequence': '0' }, { 'X-Frame-Sequence': '01' },
    { 'X-Frame-Sequence': '1e3' }, { 'X-Frame-Sequence': '-1' }, { 'X-Frame-Sequence': '9007199254740992' },
    { 'X-Frame-Geometry': '0' }, { 'X-Frame-Crop': '0' }, { 'X-Frame-Crop': '3.0' }]) assert.equal(readFrameHeaders(header(fields)), null);
});

test('frame ownership requires matching current geometry/crop and never exposes source preview to phone role', () => {
  assert.equal(frameMatchesState(state(), metadata(), { after: 11 }), true);
  for (const value of [state({ transfer: { ...state().transfer, enabled: false } }),
    state({ transfer: { ...state().transfer, status: 'stopped' } }),
    state({ transfer: { ...state().transfer, status: 'stale' } }),
    state({ transfer: { ...state().transfer, geometryRevision: 5 } }),
    state({ transfer: { ...state().transfer, cropRevision: 4 } })]) assert.equal(frameMatchesState(value, metadata(), { after: 11 }), false);
  assert.equal(frameMatchesState(state(), metadata(), { after: 12 }), false);
  assert.equal(frameMatchesState(state(), metadata({ cropRevision: 0 }), { source: true, after: -1 }), false);
  assert.equal(frameMatchesState(state({ admin: true }), metadata({ cropRevision: 0 }), { source: true, after: -1 }), true);
});

test('a manual crop is actionable only on the local Mac for the still-current source revision', () => {
  const crop = { x: .2, y: .3, width: .4, height: .5 }, local = state({ admin: true });
  assert.deepEqual(manualCropRequest(crop, local, 4), { geometryRevision: 4, crop });
  for (const [value, revision] of [[state(), 4], [local, 3], [local, '4'],
    [state({ admin: true, source: { ...state().source, available: false } }), 4]]) assert.equal(manualCropRequest(crop, value, revision), null);
});

test('status cannot label a stopped, stale, disconnected or paused image live', () => {
  const options = { now: 1000, stateAt: 900, hasFrame: true, lastPaintAt: 950 };
  assert.equal(transferView(state(), options).showFrame, true);
  assert.equal(transferView(state(), { ...options, linked: false }).showFrame, false);
  assert.equal(transferView(state(), { ...options, stateAt: -3000 }).status, 'disconnected');
  assert.equal(transferView(state(), { ...options, lastPaintAt: -2000 }).status, 'stale');
  assert.equal(transferView(state(), { ...options, hasFrame: false }).status, 'waiting');
  assert.equal(transferView(state({ transfer: { ...state().transfer, status: 'stopped', enabled: false } }), options).showFrame, false);
  assert.equal(transferView(state({ transfer: { ...state().transfer, ageMs: 2000 } }), options).showFrame, false);
  assert.equal(transferView(state({ native: { status: 'source-paused' } }), options).status, 'stale');
});

test('native help distinguishes permission, missing compiler and unsupported host without echoing raw error strings', () => {
  assert.match(nativeMessage({ errorCode: 'SCREEN_PERMISSION_REQUIRED' }).title, /freigeben/);
  assert.match(nativeMessage({ errorCode: 'CAPTURE_TOOLCHAIN_MISSING' }).copy, /Apple-Entwicklerwerkzeuge/);
  assert.match(nativeMessage({ errorCode: 'CAPTURE_BUILD_FAILED' }).title, /erstellt/);
  assert.match(nativeMessage({ errorCode: 'CAPTURE_UNSUPPORTED_PLATFORM' }).copy, /Mac/);
  assert.doesNotMatch(JSON.stringify(nativeMessage({ status: 'capture-error', errorCode: '/PRIVATE/path' })), /PRIVATE|path/);
});

test('a decoded valid image is painted once and its bitmap is released', async () => {
  let draws = 0, closed = 0;
  const result = await decodeCurrentFrame(jpegResponse(), { getState: () => state(), getAfter: () => 11,
    decode: async () => ({ width: 1024, height: 216, close() { closed++; } }),
    draw: (_image, value) => { draws++; assert.equal(value.sequence, 12); return false; } });
  assert.equal(result.sequence, 12); assert.equal(draws, 1); assert.equal(closed, 1);
});

test('crop change, stop and newer painted frames during decoding discard the delayed image', async () => {
  for (const changed of ['geometry', 'crop', 'stop', 'sequence']) {
    let current = state(), after = 11, release, draws = 0, closed = 0;
    const work = decodeCurrentFrame(jpegResponse(), { getState: () => current, getAfter: () => after,
      decode: () => new Promise(resolve => { release = () => resolve({ width: 100, height: 100, close() { closed++; } }); }),
      draw: () => { draws++; } });
    await settle();
    if (changed === 'geometry') current.transfer.geometryRevision++;
    if (changed === 'crop') current.transfer.cropRevision++;
    if (changed === 'stop') current.transfer.enabled = false;
    if (changed === 'sequence') after = 12;
    release(); assert.equal(await work, null); assert.equal(draws, 0); assert.equal(closed, 1);
  }
});

test('invalid response types, oversized bodies and invalid image dimensions never reach the canvas', async () => {
  let decoded = 0, drawn = 0, closed = 0;
  const options = { getState: () => state(), getAfter: () => 0,
    decode: async () => { decoded++; return { width: 100, height: 100 }; }, draw: () => { drawn++; } };
  assert.equal(await decodeCurrentFrame(new Response(null, { status: 204 }), options), null);
  assert.equal(await decodeCurrentFrame(Response.json({ image: true }), options), null);
  assert.equal(await decodeCurrentFrame(new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: header() }), options), null);
  assert.equal(decoded, 0); assert.equal(drawn, 0);
  assert.equal(await decodeCurrentFrame(jpegResponse(), { ...options,
    decode: async () => ({ width: 10000, height: 10000, close() { closed++; } }) }), null);
  assert.equal(drawn, 0); assert.equal(closed, 1);
});

async function browserFixture(admin = true) {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const nodes = new Map(), timers = [], intervals = [], listeners = new Map(), requests = [];
  let current = state({ admin, mode: 'demo', version: '0.2.0', transfer: { ...state().transfer, enabled: false, status: 'waiting', sequence: 0, cropRevision: 0 } });
  class Element {
    constructor(id) { this.id = id; this.hidden = false; this.dataset = {}; this.handlers = new Map(); this.attrs = {}; this.textContent = ''; this.value = ''; this.width = 960; this.height = 540; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    setAttribute(name, value) { this.attrs[name] = value; }
    getContext() { return { clearRect() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, rect() {}, fill() {}, setLineDash() {}, strokeRect() {} }; }
    getBoundingClientRect() { return { left: 100, top: 50, width: 800, height: 400 }; }
    querySelector() { return nodes.get('source-empty-p'); }
    replaceChildren() {} append() {} setPointerCapture() {} releasePointerCapture() {} focus() {} select() {}
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element(match[1]));
  nodes.set('source-empty-p', new Element('source-empty-p'));
  const globals = { document: { getElementById: id => nodes.get(id), body: { dataset: {} }, documentElement: {}, hidden: false,
      createElement: tag => new Element(tag), fullscreenEnabled: false },
    window: { addEventListener(name, handler) { listeners.set(name, handler); } },
    location: { hash: '#key=browser-test', reload() {} },
    createImageBitmap: async () => ({ width: 1600, height: 800, close() {} }),
    setTimeout: (resolve, ms) => { timers.push({ resolve, ms }); return timers.length; },
    setInterval: handler => { intervals.push(handler); return intervals.length; }, clearInterval() {},
    fetch: async (path, options = {}) => {
      requests.push({ path, options }); assert.equal(options.headers.Authorization, 'Bearer browser-test');
      assert.ok(!path.includes('key='));
      if (path === '/api/state') return Response.json(current);
      if (path === '/api/source') return jpegResponse({ 'X-Frame-Sequence': String(current.source.sequence),
        'X-Frame-Geometry': String(current.source.geometryRevision), 'X-Frame-Crop': '0' });
      if (path === '/api/connection') return Response.json({ urls: [], port: 1234 });
      if (path === '/api/crop') {
        current.detection = { status: 'manual', crop: JSON.parse(options.body).crop };
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fixture request ${path}`);
    } };
  const old = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  await import(`../web/app.js?window-ui-${Date.now()}-${admin}`); await settle();
  return { nodes, requests, get current() { return current; },
    async tick() { const batch = timers.splice(0); for (const timer of batch) timer.resolve(); await settle(); },
    restore() {
      listeners.get('pagehide')?.();
      for (const [name, value] of old) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; }
    } };
}

test('the actual Mac controller sends crop only after explicit apply and invalidates it on a new geometry', async () => {
  const f = await browserFixture();
  try {
    await f.tick();
    assert.equal(f.nodes.get('demo-banner').hidden, false);
    assert.equal(f.nodes.get('admin-view').hidden, false);
    f.nodes.get('manual-select').handlers.get('click')();
    const canvas = f.nodes.get('source-canvas'), event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
    canvas.handlers.get('pointerdown')(event(300, 150)); canvas.handlers.get('pointermove')(event(700, 350)); canvas.handlers.get('pointerup')(event(700, 350));
    assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 0);
    assert.equal(f.nodes.get('apply-crop').disabled, false);
    f.nodes.get('apply-crop').handlers.get('click')(); await settle();
    const post = f.requests.find(request => request.options.method === 'POST');
    assert.equal(post.path, '/api/crop');
    assert.equal(post.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(post.options.body), { geometryRevision: 4,
      crop: { x: .25, y: .25, width: .5, height: .5 } });
    assert.equal(f.nodes.get('apply-crop').disabled, true);
    f.nodes.get('manual-select').handlers.get('click')();
    canvas.handlers.get('pointerdown')(event(300, 150)); canvas.handlers.get('pointerup')(event(700, 350));
    f.current.source.geometryRevision++; f.current.source.sequence++;
    await f.tick();
    assert.equal(f.nodes.get('apply-crop').disabled, true);
    f.nodes.get('apply-crop').handlers.get('click')(); await settle();
    assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
  } finally { f.restore(); }
});

test('phone role never requests the full source window or Mac setup APIs', async () => {
  const f = await browserFixture(false);
  try {
    await f.tick(); await f.tick();
    assert.equal(f.nodes.get('admin-view').hidden, true);
    assert.equal(f.nodes.get('demo-banner').hidden, false);
    assert.ok(!f.requests.some(request => ['/api/source', '/api/connection', '/api/crop'].includes(request.path)));
  } finally { f.restore(); }
});

test('phone metadata is text-only, updates independently and clears on metadata disconnect', async () => {
  const f = await browserFixture(false);
  try {
    f.current.trackInfo = { status: 'connected', decks: [
      { id: 1, title: '<img src=x onerror=alert(1)>', artist: 'Artist One', bpm: 86.2 },
      { id: 2, title: 'Second Track', artist: 'Artist Two', bpm: 90 },
    ] };
    await f.tick();
    assert.equal(f.nodes.get('track-title-1').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(f.nodes.has('track-bpm-1'), false);
    assert.equal(f.nodes.has('track-bpm-2'), false);
    assert.equal(f.nodes.get('track-info-status').hidden, true);
    f.current.trackInfo.status = 'unavailable'; await f.tick();
    assert.equal(f.nodes.get('track-title-1').textContent, '—');
    assert.match(f.nodes.get('track-info-status').textContent, /Bildübertragung bleibt aktiv/);
    assert.ok(!f.requests.some(request => request.path === '/api/source'));
  } finally { f.restore(); }
});
