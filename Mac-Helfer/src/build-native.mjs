import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, mkdir, mkdtemp, chmod, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, normalize } from 'node:path';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const FRAMEWORKS = ['ScreenCaptureKit', 'AppKit', 'CoreImage', 'ImageIO', 'CoreMedia', 'CoreGraphics', 'CoreVideo', 'UniformTypeIdentifiers'];
const failure = (code, diagnostics) => Object.assign(new Error(code), { code,
  ...(diagnostics ? { diagnostics } : {}) });
const cancelled = signal => { if (signal?.aborted) throw failure('CAPTURE_BUILD_CANCELLED'); };
const absolutePath = value => typeof value === 'string' && isAbsolute(value)
  && value.length <= 16384 && !/[\u0000\r\n]/.test(value);

/** Only static compiler locations survive. Compiler text and filesystem paths do not. */
export function compilerLocations(stderr) {
  if (typeof stderr !== 'string') return [];
  const results = [];
  for (const line of stderr.slice(0, 65536).split(/\r?\n/)) {
    const match = /(?:^|[\/ ])[^\/\r\n]*\.swift:(\d{1,7}):(\d{1,7}): (error|warning):/.exec(line);
    if (!match) continue;
    const value = { line: Number(match[1]), column: Number(match[2]), kind: match[3] };
    if (value.line < 1 || value.column < 1) continue;
    if (!results.some(item => item.line === value.line && item.column === value.column && item.kind === value.kind)) results.push(value);
    if (results.length >= 32) break;
  }
  return results;
}

/** Diagnostic headers only: no source excerpts, command lines, or local paths. */
export function compilerMessages(stderr, privatePaths = []) {
  if (typeof stderr !== 'string') return [];
  const results = [];
  for (const line of stderr.slice(0, 262144).split(/\r?\n/)) {
    const match = /(?:^|: )(error|warning|note):\s*(.*)/.exec(line);
    if (!match) continue;
    let message = match[2].replace(/\x1b\[[0-9;]*m/g, '');
    for (const path of [...privatePaths].filter(Boolean).sort((a, b) => b.length - a.length)) {
      message = message.split(path).join('[path]');
    }
    message = message.replace(/(['"])[^'"\r\n]*\/[^'"\r\n]*\1/g, '[path]')
      .replace(/(?:https?:\/\/|\/)[^\s,'"<>\[\]()]+/g, '[path]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 360);
    const value = { kind: match[1], message };
    if (!results.some(item => item.kind === value.kind && item.message === value.message)) results.push(value);
    if (results.length >= 12) break;
  }
  return results;
}

function processResult(error) {
  return { exitCode: Number.isInteger(error?.code) ? error.code : error ? null : 0,
    signal: /^SIG[A-Z0-9]{1,12}$/.test(error?.signal ?? '') ? error.signal : null,
    reason: !error ? 'success' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
      : error.killed ? 'terminated' : typeof error.code === 'string' ? 'launch-failed' : 'compiler-error' };
}

function toolVersions(compiler, sdk) {
  return { swift: /Swift version (\d+(?:\.\d+){0,3})/.exec(compiler)?.[1] ?? null,
    sdk: /^(\d+(?:\.\d+){0,3})$/.exec(sdk.trim())?.[1] ?? null };
}

async function sourceBytes(path) {
  let file;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MAX_SOURCE_BYTES)) {
      throw failure('CAPTURE_BUILD_SOURCE_INVALID');
    }
    file = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw failure('CAPTURE_BUILD_SOURCE_INVALID');
    }
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const value = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!value.bytesRead) break;
      offset += value.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (offset !== Number(opened.size) || offset > MAX_SOURCE_BYTES || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw failure('CAPTURE_BUILD_SOURCE_INVALID');
    return buffer.subarray(0, offset);
  } catch { throw failure('CAPTURE_BUILD_SOURCE_INVALID'); }
  finally { await file?.close().catch(() => {}); }
}

async function safeDirectory(path) {
  let directory;
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new Error();
    directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
    const opened = await directory.stat({ bigint: true });
    if (!opened.isDirectory() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error();
    await directory.chmod(0o700);
    const after = await lstat(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new Error();
  } catch { throw failure('CAPTURE_BUILD_CACHE_INVALID'); }
  finally { await directory?.close().catch(() => {}); }
}

async function cachedBinary(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BINARY_BYTES
      || (info.mode & 0o100) === 0 || (info.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw failure('CAPTURE_BUILD_CACHE_INVALID');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw failure('CAPTURE_BUILD_CACHE_INVALID');
  }
}

function runFile(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(failure('CAPTURE_BUILD_CANCELLED')); return; }
    let child, settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted || error?.name === 'AbortError') reject(failure('CAPTURE_BUILD_CANCELLED'));
      else resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '', process: processResult(error) });
    };
    const abort = () => {
      try { child?.kill('SIGTERM'); } catch { /* The command may already have exited. */ }
      finish(Object.assign(new Error(), { name: 'AbortError' }), '', '');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try { child = execFileImpl(command, args, options, finish); }
    catch (error) { finish(error, '', ''); }
  });
}

/** Build on the user's Mac using already installed Apple tools. Never installs or downloads tools. */
export async function prepareNativeHelper({ sourcePath, cacheDirectory, platform = process.platform,
  arch = process.arch, execFileImpl = execFile, signal } = {}) {
  if (platform !== 'darwin') throw failure('CAPTURE_UNSUPPORTED_PLATFORM');
  if (!absolutePath(sourcePath) || !absolutePath(cacheDirectory) || !['arm64', 'x64'].includes(arch)
    || typeof execFileImpl !== 'function' || signal !== undefined &&
      (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) throw failure('CAPTURE_BUILD_OPTIONS_INVALID');
  cancelled(signal);
  const source = await sourceBytes(sourcePath);
  cancelled(signal);
  const directory = normalize(cacheDirectory);
  await safeDirectory(directory);
  const key = createHash('sha256').update(source).update(`\0${arch}\0swift5-macos13-sdk-v2`).digest('hex').slice(0, 24);
  const helperPath = join(directory, `SeratoWindowCapture-${arch}-${key}`);
  if (await cachedBinary(helperPath)) {
    cancelled(signal);
    return { helperPath, buildStatus: 'cached', diagnostics: { sourceBytes: source.length, compilerLocations: [] } };
  }
  const common = { encoding: 'utf8', maxBuffer: 262144, timeout: 10000, ...(signal ? { signal } : {}) };
  // xcode-select fails without triggering the developer-tools installer.
  const selected = await runFile(execFileImpl, '/usr/bin/xcode-select', ['-p'], common);
  if (!selected.ok || !absolutePath(selected.stdout.trim())) throw failure('CAPTURE_TOOLCHAIN_MISSING');
  const compiler = await runFile(execFileImpl, '/usr/bin/xcrun', ['--find', 'swiftc'], common);
  const compilerPath = compiler.stdout.trim();
  if (!compiler.ok || !absolutePath(compilerPath) || basename(compilerPath) !== 'swiftc') throw failure('CAPTURE_TOOLCHAIN_MISSING');
  const sdk = await runFile(execFileImpl, '/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], common);
  const sdkPath = sdk.stdout.trim();
  if (!sdk.ok || !absolutePath(sdkPath)) throw failure('CAPTURE_SDK_MISSING', {
    phase: 'sdk', process: sdk.process, compilerLocations: [],
    compilerMessages: compilerMessages(sdk.stderr, [process.env.HOME, selected.stdout.trim()]) });
  const version = await runFile(execFileImpl, compilerPath, ['--version'], common);
  const sdkVersion = await runFile(execFileImpl, '/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], common);
  const versions = toolVersions(version.stdout, sdkVersion.stdout);
  cancelled(signal);
  let buildDirectory, diagnostics = { phase: 'prepare', versions, compilerLocations: [], compilerMessages: [] };
  try {
    buildDirectory = await mkdtemp(join(directory, '.build-'));
    await chmod(buildDirectory, 0o700);
    const temporary = join(buildDirectory, 'SeratoWindowCapture');
    const sourceSnapshot = join(buildDirectory, 'SeratoWindowCapture.swift');
    await writeFile(sourceSnapshot, source, { flag: 'wx', mode: 0o600 });
    const moduleCache = join(buildDirectory, 'modules');
    const args = ['-swift-version', '5', '-parse-as-library', '-O', '-sdk', sdkPath, '-target',
      `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', moduleCache,
      sourceSnapshot, '-o', temporary, ...FRAMEWORKS.flatMap(name => ['-framework', name])];
    const result = await runFile(execFileImpl, compilerPath, args, { ...common, timeout: 120000,
      cwd: buildDirectory, env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULECACHE_PATH: moduleCache } });
    const locations = compilerLocations(result.stderr);
    diagnostics = { phase: 'compile', sourceBytes: source.length, versions, process: result.process,
      compilerLocations: locations, compilerMessages: compilerMessages(result.stderr,
        [process.env.HOME, directory, buildDirectory, compilerPath, sdkPath, selected.stdout.trim(), sourcePath]) };
    cancelled(signal);
    if (!result.ok) throw failure('CAPTURE_BUILD_FAILED', diagnostics);
    diagnostics.phase = 'output';
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BINARY_BYTES) throw failure('CAPTURE_BUILD_FAILED');
    await chmod(temporary, 0o700);
    cancelled(signal);
    await rename(temporary, helperPath);
    if (!await cachedBinary(helperPath)) throw failure('CAPTURE_BUILD_FAILED');
    return { helperPath, buildStatus: 'compiled', diagnostics: { ...diagnostics, phase: 'complete' } };
  } catch (error) {
    if (signal?.aborted || error?.code === 'CAPTURE_BUILD_CANCELLED') throw failure('CAPTURE_BUILD_CANCELLED');
    if (error?.code === 'CAPTURE_BUILD_FAILED') throw failure(error.code, error.diagnostics ?? diagnostics);
    const filesystemCode = ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EROFS', 'EEXIST'].includes(error?.code) ? error.code : null;
    throw failure('CAPTURE_BUILD_FAILED', { ...diagnostics, filesystemCode });
  } finally { if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true }).catch(() => {}); }
}
