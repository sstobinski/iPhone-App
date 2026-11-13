export const linkedMetadata = (value, fresh = true) => fresh && ['connected', 'demo'].includes(value?.status);
import { normalizeCrop, selectionCrop } from './crop.js';
import { FrameStats, paintFrame, nextPaint } from './frame-stats.js';

const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const FRESH_STATE_MS = 2500;
const FRESH_FRAME_MS = 1800;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const dimension = value => integer(value, 1) && value <= 4096;
const finiteAge = value => Number.isFinite(value) && value >= 0;

export function readFrameHeaders(headers, { source = false } = {}) {
  const get = name => {
    const text = headers?.get?.(name);
    return /^(?:0|[1-9]\d{0,15})$/.test(text ?? '') && Number.isSafeInteger(Number(text)) ? Number(text) : NaN;
  };
  const sequence = get('X-Frame-Sequence'), geometryRevision = get('X-Frame-Geometry');
  const cropRevision = get('X-Frame-Crop');
  if (!integer(sequence, source ? 0 : 1) || !integer(geometryRevision, 1)
    || !integer(cropRevision, source ? 0 : 1)) return null;
  return { sequence, geometryRevision, cropRevision };
}

export function nativeMessage(native = {}) {
  const status = String(native.status ?? '');
  const code = typeof native.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(native.errorCode) ? native.errorCode : '';
  if (/permission/.test(status) || /PERMISSION|SCREEN_RECORDING/.test(code)) return {
    title: 'Bildschirmaufnahme freigeben',
    copy: 'Am Mac unter Systemeinstellungen → Datenschutz & Sicherheit die Bildschirmaufnahme für den Mac-Helfer erlauben. Danach den Test neu starten.',
  };
  if (/TOOLCHAIN|SWIFT|COMPILER/.test(code) || /toolchain/.test(status)) return {
    title: 'Mac-Helfer noch nicht bereit', copy: 'Für diesen Prototyp fehlen die Apple-Entwicklerwerkzeuge. Die Schritte stehen im Terminal und in der Anleitung.',
  };
  if (code === 'CAPTURE_SDK_MISSING') return {
    title: 'macOS-SDK nicht verfügbar', copy: 'Die Apple-Werkzeuge liefern kein verwendbares macOS-SDK. Am Mac q und Enter drücken und window-report.json aus dem Testordner senden.',
  };
  if (code === 'CAPTURE_BUILD_FAILED') return {
    title: 'Mac-Helfer konnte nicht erstellt werden', copy: 'Der Build ist fehlgeschlagen. Am Mac q und Enter drücken und window-report.json aus diesem Testordner senden. Der Bericht enthält jetzt die bereinigte Compiler-Diagnose.',
  };
  if (code === 'CAPTURE_UNSUPPORTED_PLATFORM') return {
    title: 'Fensteraufnahme am Mac starten', copy: 'Die echte Fensteraufnahme funktioniert auf einem Mac. Die Demo verwendet ausschließlich synthetische Testbilder.',
  };
  if (['source-paused', 'capture-paused', 'window-minimized', 'paused', 'suspended'].includes(status)) return {
    title: 'Fensteraufnahme pausiert', copy: 'Serato wiederherstellen, falls das Fenster minimiert ist. Auf ein neues Bild vom Mac warten.',
  };
  if (/error|failed|unavailable/.test(status) || code) return {
    title: 'Fensteraufnahme nicht bereit', copy: 'Den Hinweis im Mac-Terminal prüfen. Es wird kein alter Bildstand als live angezeigt.',
  };
  if (['waiting-for-serato', 'window-missing', 'serato-not-found', 'searching', 'starting', 'waiting'].includes(status) || !status) return {
    title: 'Warte auf Serato', copy: 'Serato am Mac öffnen und die Wellenformansicht sichtbar im Fenster einrichten.',
  };
  return { title: 'Serato-Fenster gefunden', copy: 'Der Mac sucht die Wellenformbereiche. Den Ausschnitt in der lokalen Vorschau prüfen.' };
}

export function transferView(state, { now = 0, stateAt = 0, hasFrame = false, lastPaintAt = 0, linked = true } = {}) {
  if (!linked) return { status: 'waiting', title: 'Verbindungslink vom Mac öffnen',
    copy: 'Den QR-Code auf der Mac-Seite mit der iPhone-Kamera scannen.', showFrame: false };
  if (!state || !Number.isFinite(stateAt) || !Number.isFinite(now) || now - stateAt > FRESH_STATE_MS) return {
    status: 'disconnected', title: 'Mac-Verbindung unterbrochen', copy: 'Mac und iPhone im selben WLAN lassen. Der Mac-Helfer muss geöffnet bleiben.', showFrame: false,
  };
  const value = state.transfer;
  if (!value || value.status === 'stopped' || value.enabled !== true) return {
    status: value?.status === 'stopped' ? 'stopped' : 'waiting',
    title: value?.status === 'stopped' ? 'Übertragung gestoppt' : nativeMessage(state.native).title,
    copy: value?.status === 'stopped' ? 'Auf dem Mac automatisch erkennen oder einen Ausschnitt wählen.' : nativeMessage(state.native).copy,
    showFrame: false,
  };
  if (['source-paused', 'capture-paused', 'window-minimized', 'paused', 'suspended'].includes(state.native?.status)) {
    return { status: 'stale', ...nativeMessage(state.native), showFrame: false };
  }
  if ((state.native?.status === 'source-idle' || value.unchanged === true) && value.status === 'live' && hasFrame) return { status: 'live', title: 'Bild unverändert', copy: '', showFrame: true };
  if (value.status === 'stale' || finiteAge(value.ageMs) && value.ageMs > FRESH_FRAME_MS
    || hasFrame && now - lastPaintAt > FRESH_FRAME_MS) return {
    status: 'stale', title: 'Kein aktuelles Bild', copy: 'Die Bildfolge vom Mac ist ausgeblieben. Serato und den Mac-Helfer prüfen.', showFrame: false,
  };
  if (value.status !== 'live' || !hasFrame) return {
    status: 'waiting', title: 'Bild wird geladen', copy: 'Warte auf den ausgewählten Serato-Ausschnitt.', showFrame: false,
  };
  return { status: 'live', title: 'Live-Bild', copy: '', showFrame: true };
}

/** A decoded response may become stale while decoding or while the crop changes. */
export function frameMatchesState(state, metadata, { after = 0, source = false } = {}) {
  if (!metadata || !integer(metadata.sequence, source ? 0 : 1) || metadata.sequence <= after
    || !integer(metadata.geometryRevision, 1) || !integer(metadata.cropRevision, source ? 0 : 1)) return false;
  if (source) return state?.admin === true && state.source?.available === true
    && state.source.geometryRevision === metadata.geometryRevision;
  const value = state?.transfer;
  return value?.enabled === true && ['live', 'waiting'].includes(value.status)
    && value.geometryRevision === metadata.geometryRevision && value.cropRevision === metadata.cropRevision;
}

export function manualCropRequest(selection, state, sourceGeometry) {
  const crop = normalizeCrop(selection);
  return crop && state?.admin === true && state.source?.available === true
    && integer(sourceGeometry, 1) && sourceGeometry === state.source.geometryRevision
    ? { geometryRevision: sourceGeometry, crop } : null;
}

export async function decodeJpeg(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* Safari can fall back to an image element. */ }
  }
  return await new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(blob);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('JPEG_DECODE_FAILED')); };
    image.src = url;
  });
}

/** Decode one image, then recheck current state before permitting paint. */
export async function decodeCurrentFrame(response, { getState, getAfter, source = false, decode = decodeJpeg, draw,
  requestStartedAt = null } = {}) {
  if (response?.status === 204) return null;
  if (!response?.ok || !String(response.headers?.get?.('Content-Type') ?? '').toLowerCase().startsWith('image/jpeg')) return null;
  const metadata = readFrameHeaders(response.headers, { source });
  if (!metadata || !frameMatchesState(getState(), metadata, { after: getAfter(), source })) return null;
  const blob = await response.blob();
  if (blob.size < 16 || blob.size > MAX_JPEG_BYTES) return null;
  const decodeBegan = performance.now();
  const bitmap = await decode(blob);
  const timing = { requestMs: Number.isFinite(requestStartedAt) ? Math.max(0, decodeBegan - requestStartedAt) : 0,
    decodeMs: Math.max(0, performance.now() - decodeBegan) };
  let retained = false;
  try {
    const width = bitmap.width ?? bitmap.naturalWidth, height = bitmap.height ?? bitmap.naturalHeight;
    if (!dimension(width) || !dimension(height) || width * height > 8_000_000
      || !frameMatchesState(getState(), metadata, { after: getAfter(), source })) return null;
    retained = await draw(bitmap, { ...metadata, width, height }, timing) === true;
    return { ...metadata, width, height };
  } finally { if (!retained) bitmap.close?.(); }
}

function bootstrap() {
  const byId = id => document.getElementById(id);
  const key = new URLSearchParams(location.hash.slice(1)).get('key') || '';
  const authorization = { Authorization: `Bearer ${key}` };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const client = { state: null, stateAt: -Infinity, closed: false, expired: false,
    phoneSequence: 0, phoneGeometry: null, phoneCrop: null, hasFrame: false, lastPaintAt: 0,
    sourceBitmap: null, sourceSequence: -1, sourceGeometry: null,
    selection: null, selectionGeometry: null, selecting: false, drag: null,
    actionPending: false, actionNotice: '', actionError: false,
    stateRequest: 0, acceptedStateRequest: 0,
    urls: [], qrUrl: null, qrVersion: 0, paintTimes: [] };
  const sourceCanvas = byId('source-canvas'), sourceContext = sourceCanvas.getContext('2d');
  const phoneCanvas = byId('phone-canvas'), phoneContext = phoneCanvas.getContext('2d');
  const previewDownloads = new Set();
  const frameStats = new FrameStats();
  let metricsPending = false, reportedForeground = 0;
  const adminView = byId('admin-view'), startup = byId('startup-note');

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, cache: 'no-store', headers: { ...authorization, ...options.headers } });
    if (response.status === 401 || response.status === 403) {
      if (response.status === 401) client.expired = true;
      throw Object.assign(new Error('REQUEST_DENIED'), { status: response.status });
    }
    if (!response.ok) throw Object.assign(new Error('REQUEST_FAILED'), { status: response.status });
    return response;
  }

  function clearPhone() {
    frameStats.setActive(false);
    client.hasFrame = false; client.paintTimes = [];
    phoneContext?.clearRect(0, 0, phoneCanvas.width, phoneCanvas.height);
  }

  function clearSource() {
    client.sourceBitmap?.close?.(); client.sourceBitmap = null;
    client.sourceSequence = -1; client.sourceGeometry = null;
    client.selection = null; client.selectionGeometry = null; client.drag = null;
    sourceContext?.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  }

  function drawSource() {
    if (!sourceContext || !client.sourceBitmap) return;
    const width = client.sourceBitmap.width ?? client.sourceBitmap.naturalWidth;
    const height = client.sourceBitmap.height ?? client.sourceBitmap.naturalHeight;
    if (sourceCanvas.width !== width || sourceCanvas.height !== height) {
      sourceCanvas.width = width; sourceCanvas.height = height;
    }
    sourceContext.clearRect(0, 0, width, height);
    sourceContext.drawImage(client.sourceBitmap, 0, 0, width, height);
    const chosen = client.selection ?? normalizeCrop(client.state?.detection?.crop);
    if (!chosen) return;
    const x = chosen.x * width, y = chosen.y * height, w = chosen.width * width, h = chosen.height * height;
    sourceContext.save();
    sourceContext.fillStyle = '#02070c8a';
    sourceContext.beginPath(); sourceContext.rect(0, 0, width, height); sourceContext.rect(x, y, w, h);
    sourceContext.fill('evenodd');
    sourceContext.strokeStyle = client.selection ? '#f1c58a' : '#62e2ef';
    sourceContext.lineWidth = Math.max(2, width / 450);
    sourceContext.setLineDash(client.selection ? [width / 90, width / 150] : []);
    sourceContext.strokeRect(x, y, w, h);
    sourceContext.restore();
  }

  function detectionLabel() {
    if (client.selecting) return client.selection ? 'Auswahl prüfen und „Ausschnitt übernehmen“ drücken.' : 'Mit der Maus einen Rahmen um die gewünschten Wellenformen ziehen.';
    const detection = client.state?.detection;
    if (detection?.status === 'recognized' && ['EMPTY_VERTICAL_LAYOUT', 'EMPTY_HORIZONTAL_LAYOUT'].includes(detection.reason)) return 'Leere Wellenformbereiche erkannt. Der Ausschnitt bleibt sichtbar.';
    if (detection?.status === 'recognized' && detection.reason === 'TRACKED_VERTICAL_SINGLE_DECK') return 'Deck-Ansicht bestätigt: Ein Deck ist leer, der Ausschnitt bleibt aktiv.';
    if (detection?.status === 'recognized') return `Automatisch erkannt: ${detection.layout === 'vertical-two-deck' ? 'vertikale Deck-Ansicht' : 'zwei Wellenformen übereinander'}. Den markierten Bereich prüfen.`;
    if (detection?.status === 'manual') return 'Manueller Ausschnitt aktiv. „Automatisch erkennen“ startet einen neuen Erkennungsversuch.';
    if (detection?.status === 'unrecognized') return 'Noch kein automatischer Wellenform-Ausschnitt erkannt. Bei Bedarf vorerst manuell auswählen.';
    return 'Bereichserkennung wartet auf eine unterstützte Zwei-Deck-Ansicht.';
  }

  function refresh() {
    const now = performance.now();
    const view = transferView(client.state, { now, stateAt: client.stateAt, hasFrame: client.hasFrame,
      lastPaintAt: client.lastPaintAt, linked: Boolean(key) });
    const admin = client.state?.admin === true;
    document.body.dataset.role = client.state ? admin ? 'admin' : 'phone' : 'waiting';
    const demo = client.state?.mode === 'demo';
    byId('demo-banner').hidden = !demo;
    adminView.hidden = !admin;
    byId('page-title').textContent = admin ? 'Serato Fenster-Test' : 'Serato Live';
    byId('phone-view-label').textContent = demo ? 'Demo · synthetischer Ausschnitt'
      : admin ? 'Ausschnitt-Vorschau · maximal 15 Bilder/s' : 'Wellenformübertragung';
    byId('phone-stage').dataset.state = view.status;
    byId('phone-status-title').textContent = view.title;
    byId('phone-status-copy').textContent = view.copy;
    byId('phone-overlay').hidden = view.showFrame;
    phoneCanvas.hidden = !view.showFrame;
    const connectionState = byId('connection-state');
    connectionState.dataset.state = view.status === 'live' ? 'live' : ['stale', 'disconnected'].includes(view.status) ? 'error' : 'waiting';
    byId('connection-label').textContent = view.status === 'live' ? demo ? 'Demo-Bild' : client.state?.native?.status === 'source-idle' || client.state?.transfer?.unchanged === true ? 'Bild unverändert' : 'Live-Bild'
      : view.status === 'stopped' ? 'Gestoppt' : view.status === 'disconnected' ? 'Nicht verbunden' : 'Warte auf Bild';
    startup.hidden = Boolean(key) && !client.expired;
    startup.textContent = !key ? 'Den Verbindungslink oder QR-Code von der Mac-Seite öffnen.'
      : 'Der Verbindungslink ist nicht mehr gültig. Den neuen QR-Code vom Mac öffnen.';
    client.paintTimes = client.paintTimes.filter(time => now - time < 1000);
    byId('frame-rate').textContent = view.showFrame ? `${client.paintTimes.length} gezeichnet/s` : '— gezeichnet/s';
    byId('frame-size').textContent = view.showFrame ? `${phoneCanvas.width} × ${phoneCanvas.height}` : '—';
    if (client.state?.version) byId('version').textContent = `FENSTER-TEST ${String(client.state.version).slice(0, 24)} · ${client.state.performance?.targetFps ?? 30} FPS ZIEL`;
    const trackInfo = client.state?.trackInfo;
    const trackLinked = linkedMetadata(trackInfo, now - client.stateAt <= FRESH_STATE_MS);
    byId('track-info').hidden = !trackInfo;
    byId('track-info-status').hidden = !trackInfo || trackLinked;
    byId('track-info-status').textContent = !trackInfo ? '' : trackInfo.status === 'unavailable'
      ? 'Trackdaten nicht verfügbar · Bildübertragung bleibt aktiv' : 'Warte auf Serato-Trackdaten …';
    for (const id of [1, 2]) {
      const deck = trackLinked ? trackInfo.decks?.find(deck => deck.id === id) : null;
      byId(`track-title-${id}`).textContent = deck?.title || (trackLinked ? Number.isFinite(deck?.bpm) && deck.bpm > 0 ? 'Trackdaten werden geladen …' : 'Kein Track geladen' : '—');
      byId(`track-artist-${id}`).textContent = deck?.artist || '';
      byId(`track-bpm-${id}`).textContent = Number.isFinite(deck?.bpm) && deck.bpm > 0 && deck.bpm <= 1000 ? deck.bpm.toFixed(1) : '—';
    }
    if (!admin) return;
    const native = nativeMessage(client.state.native);
    byId('capture-state').textContent = native.title;
    byId('capture-help').textContent = native.copy;
    byId('source-empty').hidden = Boolean(client.sourceBitmap);
    byId('source-empty').querySelector('p').textContent = native.title;
    byId('detection-label').textContent = detectionLabel();
    byId('source-stage').dataset.selecting = String(client.selecting);
    byId('manual-select').setAttribute('aria-pressed', String(client.selecting));
    const connected = now - client.stateAt <= FRESH_STATE_MS && !client.expired;
    byId('auto-detect').disabled = client.actionPending || !connected;
    byId('manual-select').disabled = client.actionPending || !client.sourceBitmap || !connected;
    byId('save-preview').disabled = client.actionPending || !client.sourceBitmap || !connected;
    byId('apply-crop').disabled = client.actionPending || !manualCropRequest(client.selection, client.state, client.selectionGeometry);
    byId('stop-transfer').disabled = client.actionPending || client.state.transfer?.enabled !== true || !connected;
    byId('action-status').textContent = client.actionPending ? 'Wird übernommen …' : client.actionNotice;
    byId('action-status').dataset.state = client.actionError ? 'error' : client.actionNotice ? 'success' : 'idle';
  }

  function acceptState(value, request = 0) {
    if (client.closed || !value || typeof value.admin !== 'boolean' || !value.source || !value.transfer
      || request < client.acceptedStateRequest
      || Number.isFinite(value.serverTimeMs) && Number.isFinite(client.state?.serverTimeMs)
        && value.serverTimeMs < client.state.serverTimeMs) return;
    client.acceptedStateRequest = request;
    const previous = client.state;
    client.state = value; client.stateAt = performance.now();
    if (client.sourceGeometry !== null && client.sourceGeometry !== value.source.geometryRevision) clearSource();
    if (client.phoneGeometry !== value.transfer.geometryRevision || client.phoneCrop !== value.transfer.cropRevision
      || integer(value.transfer.sequence) && value.transfer.sequence < client.phoneSequence) {
      client.phoneSequence = 0; client.phoneGeometry = value.transfer.geometryRevision;
      client.phoneCrop = value.transfer.cropRevision; clearPhone();
    }
    if (value.transfer.enabled !== true || value.transfer.status === 'stopped') clearPhone();
    if (!value.admin && previous?.admin) clearSource();
    drawSource(); refresh();
  }

  async function fetchState() {
    const request = ++client.stateRequest;
    acceptState(await (await api('/api/state')).json(), request);
  }

  async function action(path, body) {
    if (client.actionPending || client.state?.admin !== true) return;
    client.actionPending = true; client.actionNotice = ''; client.actionError = false; refresh();
    try {
      await api(path, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      client.actionNotice = path === '/api/crop' ? 'Ausschnitt übernommen.' : path === '/api/stop' ? 'Übertragung gestoppt.' : 'Automatische Erkennung angefordert.';
      client.selection = null; client.selectionGeometry = null; client.selecting = false;
      await fetchState();
    } catch (error) {
      client.actionError = true;
      client.actionNotice = error.status === 409 ? 'Das Fenster hat sich geändert. Neue Vorschau prüfen und erneut wählen.'
        : 'Aktion nicht übernommen. Mac-Verbindung und den Hinweis im Terminal prüfen.';
      try { await fetchState(); } catch { /* Connection status reports the interruption. */ }
    } finally { client.actionPending = false; drawSource(); refresh(); }
  }

  byId('auto-detect').addEventListener('click', () => { void action('/api/auto'); });
  byId('save-preview').addEventListener('click', async () => {
    if (client.closed || client.actionPending || client.state?.admin !== true || !client.sourceBitmap) return;
    client.actionPending = true; client.actionError = false; refresh();
    try {
      const response = await api('/api/source');
      const metadata = readFrameHeaders(response.headers, { source: true });
      if (!response.ok || !String(response.headers.get('Content-Type') ?? '').startsWith('image/jpeg')
        || !metadata || !frameMatchesState(client.state, metadata, { source: true, after: -1 })) throw new Error();
      const blob = await response.blob();
      if (blob.size < 16 || blob.size > MAX_JPEG_BYTES || client.closed
        || !frameMatchesState(client.state, metadata, { source: true, after: -1 })) throw new Error();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      previewDownloads.add(url); link.href = url; link.download = 'serato-window-preview.jpg'; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); previewDownloads.delete(url); }, 30000);
      client.actionNotice = 'Vorschaubild lokal gespeichert. Es enthält die sichtbaren Serato-Inhalte.';
    } catch {
      client.actionError = true; client.actionNotice = 'Vorschaubild nicht gespeichert. Aktuelle Mac-Vorschau prüfen und erneut versuchen.';
    } finally { client.actionPending = false; refresh(); }
  });
  byId('stop-transfer').addEventListener('click', () => { void action('/api/stop'); });
  byId('apply-crop').addEventListener('click', () => {
    const value = manualCropRequest(client.selection, client.state, client.selectionGeometry);
    if (value) void action('/api/crop', value);
  });
  byId('manual-select').addEventListener('click', () => {
    if (!client.sourceBitmap || client.actionPending) return;
    client.selecting = !client.selecting; client.selection = null; client.selectionGeometry = null;
    client.drag = null; client.actionNotice = ''; drawSource(); refresh();
  });
  sourceCanvas.addEventListener('pointerdown', event => {
    if (!client.selecting || !client.sourceBitmap || client.state?.admin !== true || client.actionPending) return;
    event.preventDefault();
    client.drag = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY },
      bounds: sourceCanvas.getBoundingClientRect(), geometryRevision: client.sourceGeometry };
    client.selection = null; client.selectionGeometry = client.sourceGeometry;
    sourceCanvas.setPointerCapture?.(event.pointerId); refresh();
  });
  const updateSelection = event => {
    const drag = client.drag;
    if (!drag || drag.pointerId !== event.pointerId || drag.geometryRevision !== client.state?.source?.geometryRevision) return;
    client.selection = selectionCrop(drag.start, { x: event.clientX, y: event.clientY }, drag.bounds);
    client.selectionGeometry = drag.geometryRevision; drawSource(); refresh();
  };
  sourceCanvas.addEventListener('pointermove', event => { if (client.drag) { event.preventDefault(); updateSelection(event); } });
  sourceCanvas.addEventListener('pointerup', event => {
    if (!client.drag) return;
    updateSelection(event); client.drag = null;
    sourceCanvas.releasePointerCapture?.(event.pointerId); refresh();
  });
  sourceCanvas.addEventListener('pointercancel', () => { client.drag = null; client.selection = null; client.selectionGeometry = null; drawSource(); refresh(); });

  async function loadConnection() {
    if (client.state?.admin !== true) return;
    try {
      const value = await (await api('/api/connection')).json();
      client.urls = Array.isArray(value.urls) ? value.urls.filter(url => {
        try { const parsed = new URL(url); return parsed.protocol === 'http:' && Boolean(parsed.host); } catch { return false; }
      }).slice(0, 16) : [];
      const select = byId('network-choice'); select.replaceChildren();
      client.urls.forEach((url, index) => {
        const option = document.createElement('option'); option.value = String(index); option.textContent = new URL(url).host; select.append(option);
      });
      select.hidden = client.urls.length < 2;
      if (client.urls.length) await selectConnection(0);
      else {
        byId('qr-message').textContent = 'Keine lokale Netzwerkadresse. Mac und iPhone mit demselben WLAN verbinden.';
        byId('connection-url').value = ''; byId('copy-link').disabled = true;
      }
    } catch { byId('qr-message').textContent = 'Verbindungslink konnte nicht geladen werden.'; }
  }
  async function selectConnection(index) {
    const selected = client.urls[index], version = ++client.qrVersion;
    if (!selected) return;
    byId('connection-url').value = selected; byId('copy-link').disabled = false;
    try {
      const response = await api(`/api/qr?index=${index}`);
      const blob = await response.blob();
      if (version !== client.qrVersion || client.closed) return;
      const url = URL.createObjectURL(blob);
      if (client.qrUrl) URL.revokeObjectURL(client.qrUrl);
      client.qrUrl = url; byId('connection-qr').src = url;
      byId('connection-qr').hidden = false; byId('qr-message').hidden = true;
    } catch { byId('qr-message').textContent = 'QR-Code konnte nicht geladen werden. Den Link kopieren.'; }
  }
  byId('network-choice').addEventListener('change', event => { void selectConnection(Number(event.target.value)); });
  byId('copy-link').addEventListener('click', async () => {
    try {
      if (!byId('connection-url').value) return;
      await navigator.clipboard.writeText(byId('connection-url').value);
      byId('connection-help').textContent = 'Verbindungslink kopiert.';
    } catch {
      byId('connection-url').focus(); byId('connection-url').select();
      byId('connection-help').textContent = 'Den markierten Link mit ⌘C kopieren.';
    }
  });
  const fullscreen = byId('fullscreen');
  fullscreen.hidden = !document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function';
  fullscreen.addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { /* Safari may reject fullscreen. */ }
  });

  async function stateLoop() {
    let connectionLoaded = false;
    while (!client.closed && !client.expired && key) {
      try {
        await fetchState();
        if (client.state?.admin && !connectionLoaded) { connectionLoaded = true; void loadConnection(); }
      } catch { refresh(); }
      await delay(500);
    }
  }
  async function sourceLoop() {
    while (!client.closed && !client.expired && key) {
      if (client.state?.admin && client.state.source?.available && !document.hidden) {
        try {
          const response = await api('/api/source');
          await decodeCurrentFrame(response, { source: true, getState: () => client.closed ? null : client.state, getAfter: () => client.sourceSequence,
            draw: (bitmap, metadata) => {
              client.sourceBitmap?.close?.(); client.sourceBitmap = bitmap;
              client.sourceSequence = metadata.sequence; client.sourceGeometry = metadata.geometryRevision;
              drawSource(); refresh(); return true;
            } });
        } catch { /* Permission and native source states are shown by stateLoop. */ }
      }
      await delay(500);
    }
  }
  async function phoneLoop() {
    while (!client.closed && !client.expired && key) {
      const started = performance.now();
      if (!document.hidden && client.state?.transfer?.enabled === true && ['live', 'waiting'].includes(client.state.transfer.status)
        && started - client.stateAt <= FRESH_STATE_MS) {
        try {
          const response = await api(`/api/frame?after=${client.phoneSequence}&wait=1`);
          await decodeCurrentFrame(response, { getState: () => client.closed ? null : client.state, getAfter: () => client.phoneSequence,
            requestStartedAt: started,
            draw: async (bitmap, metadata, timing) => {
              const waiting = performance.now();
              if (!await nextPaint() || document.hidden || client.closed
                || !frameMatchesState(client.state, metadata, { after: client.phoneSequence })) return false;
              const drawing = performance.now();
              const skipped = client.phoneSequence > 0 && drawing - client.lastPaintAt < 2000
                ? Math.max(0, metadata.sequence - client.phoneSequence - 1) : 0;
              const first = !client.hasFrame;
              paintFrame(phoneCanvas, phoneContext, bitmap, metadata);
              frameStats.setActive(true);
              frameStats.record({ ...timing, renderWaitMs: drawing - waiting, drawMs: Math.max(0, performance.now() - drawing) }, skipped);
              client.phoneSequence = metadata.sequence; client.phoneGeometry = metadata.geometryRevision;
              client.phoneCrop = metadata.cropRevision; client.hasFrame = true;
              client.lastPaintAt = performance.now(); client.paintTimes.push(client.lastPaintAt);
              if (first) refresh();
              return false;
            } });
        } catch { /* The next latest frame may recover; stale output is covered. */ }
      }
      const target = client.state?.admin ? 15 : client.state?.performance?.targetFps === 60 ? 60 : 30;
      await delay(document.hidden ? 250 : Math.max(1, 1000 / target - (performance.now() - started)));
    }
  }
  async function reportMetrics(final = false) {
    if (!key || client.expired || metricsPending || document.hidden && !final) return;
    const value = frameStats.snapshot();
    if (!value || value.foregroundMs - reportedForeground < 500) return;
    metricsPending = true;
    try {
      await api('/api/client-metrics', { method: 'POST', keepalive: final,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      reportedForeground = value.foregroundMs;
    } catch { /* Diagnostics never interrupt the picture. */ }
    finally { metricsPending = false; }
  }
  document.addEventListener?.('visibilitychange', () => {
    frameStats.setActive(!document.hidden && client.hasFrame && client.state?.transfer?.enabled === true);
  });
  window.addEventListener('pagehide', () => {
    frameStats.setActive(false); void reportMetrics(true);
    client.closed = true; clearSource(); clearPhone();
    for (const url of previewDownloads) URL.revokeObjectURL(url);
    previewDownloads.clear();
    if (client.qrUrl) URL.revokeObjectURL(client.qrUrl);
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  const refreshTimer = setInterval(() => { if (client.closed) clearInterval(refreshTimer); else refresh(); }, 250);
  const metricsTimer = setInterval(() => { if (client.closed) clearInterval(metricsTimer); else void reportMetrics(); }, 2000);
  refresh(); void stateLoop(); void sourceLoop(); void phoneLoop();
}

if (typeof document !== 'undefined') bootstrap();
