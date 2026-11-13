import { TrackInfo } from './track-info.mjs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCapture } from './native-capture.mjs';
import { prepareNativeHelper } from './build-native.mjs';
import { WindowSession } from './window-session.mjs';
import { WindowServer } from './window-server.mjs';
import { LayoutAnalyzer } from './layout-analyzer.mjs';
import { DemoCapture } from './demo-capture.mjs';
import { createConnectionQr } from './qr.mjs';

export function parseArgs(args) {
  const value = { demo: false, noOpen: false, duration: null, fps: 60 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo') value.demo = true;
    else if (args[i] === '--no-open') value.noOpen = true;
    else if (args[i] === '--fps' && ['30', '60'].includes(args[i + 1])) value.fps = Number(args[++i]);
    else if (args[i] === '--duration' && /^[1-9]\d{0,4}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= 86400) value.duration = Number(args[++i]);
    else throw new Error('CAPTURE_ARGUMENT_INVALID');
  }
  return value;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch { process.stderr.write('Parameter: --demo, --no-open, --fps 30|60, --duration SEKUNDEN\n'); process.exitCode = 2; return; }
  const metadata = new TrackInfo({ demo: options.demo });
  const began = performance.now(), abort = new AbortController(), analyzer = new LayoutAnalyzer();
  let capture = null, stopping = false, deadline, buildTask, finishing, buildStatus = 'not-started', diagnostics = null;
  let resolveFinished;
  const finished = new Promise(resolveValue => { resolveFinished = resolveValue; });
  const session = new WindowSession({ native: {
    sendCrop: value => capture?.sendCrop(value) ?? false,
    clearCrop: () => capture?.clearCrop() ?? false,
  }, analyze: (bytes, previousRegion) => analyzer.analyze(bytes, previousRegion) });
  const server = new WindowServer({ token: randomBytes(24).toString('base64url'),
    getState: () => ({ ...session.getState(), trackInfo: metadata.getDisplayState(), mode: options.demo ? 'demo' : 'live', serverTimeMs: performance.now(),
      performance: { targetFps: options.fps, metricsVersion: 2, macPreviewTargetFps: 15, capture: capture?.getStats().performance ?? null } }),
    getSourceFrame: () => session.getSourceFrame(), getPhoneFrame: () => session.getPhoneFrame(),
    waitForPhoneFrame: (after, value) => session.waitForPhoneFrame(after, value),
    setCrop: value => session.setCrop(value), stopTransfer: () => session.stopTransfer(),
    requestAuto: () => session.requestAuto(), getConnectionQr: createConnectionQr });
  function finish(reason) {
    if (stopping) return finishing ?? finished;
    stopping = true; abort.abort(); clearTimeout(deadline);
    process.stdin.removeListener('data', onKey); process.stdin.pause();
    finishing = (async () => {
      const metadataSnapshot = metadata.getStats();
      session.close();
      const errors = [];
      for (const close of [() => server.close(), () => capture?.stop(), () => analyzer.close(), () => metadata.stop(), () => buildTask]) {
        try { await close(); } catch { errors.push('CAPTURE_CLEANUP_FAILED'); }
      }
      const report = { schemaVersion: 1, programVersion: '0.1.13', kind: 'native-window-test',
        mode: options.demo ? 'demo' : 'live', endedReason: reason,
        runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
        durationSeconds: (performance.now() - began) / 1000,
        performance: { targetFps: options.fps, macPreviewTargetFps: 15,
          browserCountersAreSelfReported: true, clientCountersAreSelfReported: true, physicalDisplayRefreshMeasured: false,
          movingPlaybackClassification: 'estimated-from-fresh-serato-play-rate', movingPlaybackIncludesScratching: true },
        verification: { nativeMacCaptureVerifiedHere: false, automaticLayoutAccuracyMeasured: false,
          endToEndDisplayLatencyMeasured: false },
        build: { status: buildStatus, ...(diagnostics ? { diagnostics } : {}) },
        session: session.getStats(), metadata: metadataSnapshot, analysis: analyzer.getStats(),
        native: capture?.getStats() ?? { started: false }, transport: server.getStats(), errors };
      const path = fileURLToPath(new URL(options.demo ? '../window-report-demo.json' : '../window-report.json', import.meta.url));
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
        process.stdout.write(`\nBericht gespeichert: ${options.demo ? 'window-report-demo.json' : 'window-report.json'}\n`);
      } catch { await unlink(temporary).catch(() => {}); process.stderr.write('Bericht konnte nicht gespeichert werden.\n'); process.exitCode = 1; }
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
      resolveFinished();
    })();
    return finishing;
  }
  function onSignal() { void finish('signal'); }
  function onKey(value) { if (/[qQ\u0003]/.test(String(value))) void finish('user'); }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  if (process.stdin.isTTY) { process.stdin.resume(); process.stdin.on('data', onKey); }
  process.stdout.write(`Serato Fenster-Test 0.1.13 · ${options.fps} FPS Ziel${options.demo ? ' — DEMO, synthetische Bilder' : ''}\n`);
  try {
    const connection = await server.start();
    if (stopping) return await finished;
    process.stdout.write('Mac-Einrichtung:\n' + connection.localUrl + '\n');
    process.stdout.write('Serato öffnen und die Wellenformansicht einrichten. Ausschnitt prüfen, dann iPhone-QR scannen.\nq und Enter oder Strg+C beendet.\n');
    void metadata.start();
    if (!options.noOpen && process.platform === 'darwin') execFile('/usr/bin/open', [connection.localUrl], () => {});
    if (options.duration) deadline = setTimeout(() => void finish('duration'), options.duration * 1000);
    buildTask = (async () => {
      try {
        if (options.demo) { capture = new DemoCapture(); buildStatus = 'demo-no-native-build'; }
        else {
          buildStatus = 'building';
          const built = await prepareNativeHelper({
            sourcePath: fileURLToPath(new URL('../native/SeratoWindowCapture.swift', import.meta.url)),
            cacheDirectory: join(homedir(), 'Library', 'Caches', 'Serato Window Test'), signal: abort.signal });
          if (stopping) return;
          buildStatus = built.buildStatus; diagnostics = built.diagnostics;
          capture = new NativeCapture({ helperPath: built.helperPath, frameRate: options.fps });
        }
        if (stopping) { await capture?.stop(); return; }
        capture.on('packet', packet => { if (!stopping) session.acceptPacket(packet); });
        capture.on('issue', code => { if (!stopping) session.setIssue(code); });
        await capture.start();
        if (stopping) await capture.stop();
      } catch (error) {
        if (stopping) return;
        const code = typeof error?.code === 'string' && /^CAPTURE_[A-Z_]+$/.test(error.code) ? error.code : 'CAPTURE_START_FAILED';
        buildStatus = code; diagnostics = error.diagnostics ?? null;
        session.setIssue(code); process.stderr.write(`Mac-Helfer: ${code}.\n`);
        for (const entry of diagnostics?.compilerMessages ?? []) process.stderr.write(`${entry.kind}: ${entry.message}\n`);
        process.stderr.write('Bitte q und Enter drücken und window-report.json aus diesem Testordner senden.\n');
      }
    })();
  } catch { session.setIssue('CAPTURE_SERVER_FAILED'); await finish('startup-error'); }
  await finished;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
