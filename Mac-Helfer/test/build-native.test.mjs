import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, lstat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeHelper, compilerLocations, compilerMessages } from '../src/build-native.mjs';

const SOURCE = '@main struct SeratoWindowCapture { static func main() {} }\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'window-native-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'Capture helper # ü.swift'), cacheDirectory = join(root, 'cache');
  await writeFile(sourcePath, SOURCE);
  return { root, sourcePath, cacheDirectory, platform: 'darwin', arch: 'arm64' };
}
function mockCompiler({ compile, selected = '/Library/Developer/CommandLineTools\n', compiler = '/Apple Tools/usr/bin/swiftc\n' } = {}) {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args: [...args], options });
    const child = { kill() {} };
    void Promise.resolve().then(async () => {
      if (command === '/usr/bin/xcode-select') callback(selected === null ? new Error('/PRIVATE/TOOLCHAIN') : null, selected ?? '', '');
      else if (args.includes('--show-sdk-path')) callback(null, '/Apple SDK/MacOSX.sdk\n', '');
      else if (args.includes('--show-sdk-version')) callback(null, '26.1\n', '');
      else if (args.includes('--version')) callback(null, 'Apple Swift version 6.2.1 (swiftlang-PRIVATE)\nTarget: arm64-apple-macosx26.0\n', '');
      else if (command === '/usr/bin/xcrun') callback(compiler === null ? new Error('/PRIVATE/TOOLCHAIN') : null, compiler ?? '', '');
      else if (compile) await compile(command, args, options, callback);
      else { await writeFile(args[args.indexOf('-o') + 1], Buffer.from('FAKE MACH-O')); callback(null, '', ''); }
    }).catch(error => callback(error, '', ''));
    return child;
  };
  return { execFileImpl, calls };
}

test('native builder uses only explicit Apple tool arguments and a private validated source snapshot', async t => {
  const f = await fixture(t);
  let snapshot, compilerArgs;
  const m = mockCompiler({ compile: async (_command, args, options, callback) => {
    compilerArgs = args;
    snapshot = args.find(value => value.endsWith('.swift'));
    assert.equal(await readFile(snapshot, 'utf8'), SOURCE);
    assert.ok(snapshot.startsWith(f.cacheDirectory));
    assert.ok(!args.includes(f.sourcePath));
    assert.equal(options.cwd, snapshot.slice(0, snapshot.lastIndexOf('/')));
    await writeFile(args[args.indexOf('-o') + 1], 'FAKE MACH-O');
    callback(null, '', `${snapshot}:8:2: warning: developer diagnostic\n`);
  } });
  const result = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  assert.equal(result.buildStatus, 'compiled');
  assert.deepEqual(result.diagnostics.compilerLocations, [{ line: 8, column: 2, kind: 'warning' }]);
  assert.equal((await lstat(f.cacheDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(result.helperPath)).mode & 0o777, 0o700);
  assert.equal(await readFile(result.helperPath, 'utf8'), 'FAKE MACH-O');
  assert.deepEqual(m.calls.slice(0, 2).map(call => [call.command, call.args]), [
    ['/usr/bin/xcode-select', ['-p']], ['/usr/bin/xcrun', ['--find', 'swiftc']] ]);
  assert.ok(compilerArgs.includes('-parse-as-library'));
  assert.ok(compilerArgs.includes('arm64-apple-macosx13.0'));
  assert.equal(compilerArgs[compilerArgs.indexOf('-swift-version') + 1], '5');
  const frameworks = compilerArgs.flatMap((value, index) => value === '-framework' ? [compilerArgs[index + 1]] : []);
  assert.deepEqual(frameworks, ['ScreenCaptureKit', 'AppKit', 'CoreImage', 'ImageIO', 'CoreMedia', 'CoreGraphics', 'CoreVideo', 'UniformTypeIdentifiers']);
  assert.equal(compilerArgs[compilerArgs.indexOf('-sdk') + 1], '/Apple SDK/MacOSX.sdk');
  assert.deepEqual(result.diagnostics.versions, { swift: '6.2.1', sdk: '26.1' });
  assert.equal((await readdir(f.cacheDirectory)).some(name => name.startsWith('.build-')), false);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /PRIVATE|Apple Tools|Capture helper/);
});

test('a matching executable cache avoids developer tool probes entirely', async t => {
  const f = await fixture(t), m = mockCompiler();
  const first = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  const result = await prepareNativeHelper({ ...f, execFileImpl: () => assert.fail('cache hit invoked a tool') });
  assert.equal(result.buildStatus, 'cached'); assert.equal(result.helperPath, first.helperPath);
  await writeFile(f.sourcePath, SOURCE + '// newer\n');
  const next = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  assert.notEqual(next.helperPath, first.helperPath);
  assert.equal(next.buildStatus, 'compiled');
});

test('Intel target has an independent cache and explicit x86_64 target', async t => {
  const f = await fixture(t), m = mockCompiler();
  const arm = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  const intel = await prepareNativeHelper({ ...f, arch: 'x64', execFileImpl: m.execFileImpl });
  assert.notEqual(arm.helperPath, intel.helperPath);
  assert.ok(m.calls.filter(call => call.args.includes('-target'))[1].args.includes('x86_64-apple-macosx13.0'));
});

test('missing installed developer tools never invokes xcrun or an installer', async t => {
  const f = await fixture(t), m = mockCompiler({ selected: null });
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), error => {
    assert.equal(error.code, 'CAPTURE_TOOLCHAIN_MISSING');
    assert.equal(error.message, error.code); assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true;
  });
  assert.deepEqual(m.calls.map(call => call.command), ['/usr/bin/xcode-select']);
  assert.deepEqual(await readdir(f.cacheDirectory), []);
});

test('unknown or invalid Swift compiler location fails without running arbitrary output', async t => {
  const f = await fixture(t);
  for (const compiler of [null, 'swiftc', '/bin/other', '/bin/swiftc\n/private/another']) {
    const m = mockCompiler({ compiler });
    await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), { code: 'CAPTURE_TOOLCHAIN_MISSING' });
    assert.equal(m.calls.length, 2);
  }
});

test('failed compilation emits only bounded static locations and removes only its private build directory', async t => {
  const f = await fixture(t);
  const m = mockCompiler({ compile: async (_command, args, _options, callback) => {
    await writeFile(args[args.indexOf('-o') + 1], 'PARTIAL');
    callback(new Error('/PRIVATE/USER/MUSIC'), '', `${f.sourcePath}:10:4: error: /PRIVATE/USER/MUSIC\n${f.sourcePath}:10:4: error: duplicate\n`);
  } });
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), error => {
    assert.equal(error.code, 'CAPTURE_BUILD_FAILED');
    assert.deepEqual(error.diagnostics.compilerLocations, [{ line: 10, column: 4, kind: 'error' }]);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE|MUSIC|\.swift/); return true;
  });
  assert.deepEqual(await readdir(f.cacheDirectory), []);
  assert.equal(await readFile(f.sourcePath, 'utf8'), SOURCE);
});

test('unsupported platform, malformed options and source symlinks fail before tool execution', async t => {
  const f = await fixture(t), invoke = () => assert.fail('unexpected tool execution');
  await assert.rejects(prepareNativeHelper({ ...f, platform: 'linux', execFileImpl: invoke }), { code: 'CAPTURE_UNSUPPORTED_PLATFORM' });
  for (const extra of [{ sourcePath: '../source' }, { cacheDirectory: 'cache' }, { arch: 'mips' }, { signal: {} }]) {
    await assert.rejects(prepareNativeHelper({ ...f, ...extra, execFileImpl: invoke }), { code: 'CAPTURE_BUILD_OPTIONS_INVALID' });
  }
  const linked = join(f.root, 'linked.swift'); await symlink(f.sourcePath, linked);
  await assert.rejects(prepareNativeHelper({ ...f, sourcePath: linked, execFileImpl: invoke }), { code: 'CAPTURE_BUILD_SOURCE_INVALID' });
  await writeFile(f.sourcePath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: invoke }), { code: 'CAPTURE_BUILD_SOURCE_INVALID' });
});

test('unsafe cache directory or replacement binary is preserved and not followed', async t => {
  const f = await fixture(t), m = mockCompiler();
  const result = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  const external = join(f.root, 'external'); await writeFile(external, 'EXTERNAL');
  await rm(result.helperPath); await symlink(external, result.helperPath);
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), { code: 'CAPTURE_BUILD_CACHE_INVALID' });
  assert.equal(await readFile(external, 'utf8'), 'EXTERNAL');
  const dirLink = join(f.root, 'cache-link'); await symlink(f.cacheDirectory, dirLink);
  await assert.rejects(prepareNativeHelper({ ...f, cacheDirectory: dirLink, execFileImpl: m.execFileImpl }), { code: 'CAPTURE_BUILD_CACHE_INVALID' });
  assert.equal(m.calls.length, 6);
});

test('a nonexecutable cached binary is refused rather than overwritten', async t => {
  const f = await fixture(t), m = mockCompiler();
  const result = await prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl });
  await chmod(result.helperPath, 0o600);
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), { code: 'CAPTURE_BUILD_CACHE_INVALID' });
  assert.equal(await readFile(result.helperPath, 'utf8'), 'FAKE MACH-O');
});

test('cancellation before or during compilation returns safely and cleans private partial output', async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareNativeHelper({ ...f, signal: aborted.signal }), { code: 'CAPTURE_BUILD_CANCELLED' });
  const controller = new AbortController();
  let killed = false;
  const execFileImpl = (command, args, _options, callback) => {
    if (command === '/usr/bin/xcode-select') queueMicrotask(() => callback(null, '/Apple/Developer', ''));
    else if (args.includes('--show-sdk-path')) queueMicrotask(() => callback(null, '/Apple/MacOSX.sdk', ''));
    else if (args.includes('--show-sdk-version')) queueMicrotask(() => callback(null, '26.1', ''));
    else if (args.includes('--version')) queueMicrotask(() => callback(null, 'Apple Swift version 6.2', ''));
    else if (command === '/usr/bin/xcrun') queueMicrotask(() => callback(null, '/Apple/swiftc', ''));
    else void writeFile(args[args.indexOf('-o') + 1], 'PARTIAL').then(() => controller.abort());
    return { kill() { killed = true; } };
  };
  await assert.rejects(prepareNativeHelper({ ...f, signal: controller.signal, execFileImpl }), { code: 'CAPTURE_BUILD_CANCELLED' });
  assert.equal(killed, true);
  assert.deepEqual(await readdir(f.cacheDirectory), []);
});

test('compiler locations are whitelisted and bounded independently of arbitrary diagnostic text', () => {
  assert.deepEqual(compilerLocations('/Users/PRIVATE/SeratoWindowCapture.swift:9:3: error: secret\n'), [{ line: 9, column: 3, kind: 'error' }]);
  assert.equal(compilerLocations(Array.from({ length: 100 }, (_, i) => `X.swift:${i + 1}:2: warning: x`).join('\n')).length, 32);
  assert.deepEqual(compilerLocations('/Users/PRIVATE no location'), []);
  assert.deepEqual(compilerLocations(null), []);
});

test('global SDK errors survive without Swift line numbers and private paths are removed', async t => {
  const f = await fixture(t);
  const m = mockCompiler({ compile: (_command, _args, _options, callback) => callback(
    Object.assign(new Error('compiler failed'), { code: 1 }), '',
    "<unknown>:0: error: failed to build module 'Foundation'; this SDK is not supported by the compiler\n" +
    "error: unable to load standard library for target 'arm64-apple-macosx13.0'\n" +
    "error: module at '/Users/PRIVATE/My Music/Cache.swift' failed\n") });
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), error => {
    assert.equal(error.code, 'CAPTURE_BUILD_FAILED');
    assert.deepEqual(error.diagnostics.compilerLocations, []);
    assert.equal(error.diagnostics.compilerMessages.length, 3);
    assert.match(error.diagnostics.compilerMessages[0].message, /SDK is not supported/);
    assert.deepEqual(error.diagnostics.process, { exitCode: 1, signal: null, reason: 'compiler-error' });
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /PRIVATE|My Music|Cache.swift/);
    return true;
  });
});

test('SDK lookup failure is distinct and does not invoke compilation', async t => {
  const f = await fixture(t), m = mockCompiler();
  const execFileImpl = (command, args, options, callback) => args.includes('--show-sdk-path')
    ? (queueMicrotask(() => callback(Object.assign(new Error(), { code: 1 }), '', 'xcrun: error: SDK macosx cannot be located')), { kill() {} })
    : m.execFileImpl(command, args, options, callback);
  await assert.rejects(prepareNativeHelper({ ...f, execFileImpl }), error => {
    assert.equal(error.code, 'CAPTURE_SDK_MISSING');
    assert.equal(error.diagnostics.phase, 'sdk');
    assert.match(error.diagnostics.compilerMessages[0].message, /cannot be located/);
    return true;
  });
  assert.equal(m.calls.some(call => call.args.includes('-target')), false);
});

test('compiler termination and output overflow remain diagnosable even without stderr', async t => {
  const f = await fixture(t);
  for (const [detail, reason] of [
    [{ killed: true, signal: 'SIGTERM' }, 'terminated'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output-limit'],
    [{ code: 'ENOENT' }, 'launch-failed'],
  ]) {
    const m = mockCompiler({ compile: (_command, _args, _options, callback) => callback(Object.assign(new Error(), detail), '', '') });
    await assert.rejects(prepareNativeHelper({ ...f, execFileImpl: m.execFileImpl }), error => {
      assert.equal(error.diagnostics.process.reason, reason);
      assert.deepEqual(error.diagnostics.compilerMessages, []);
      return true;
    });
  }
});

test('diagnostic headers omit source excerpts, redact paths and remain bounded', () => {
  const input = "error: cannot open /Users/PRIVATE/Music/a.swift\n" +
    "1 | let secret = \"PRIVATE\"\n" +
    "warning: build at /Users/PRIVATE/User Cache/module failed\n" +
    Array.from({ length: 100 }, (_, i) => `note: ${i} ${'x'.repeat(500)}`).join('\n');
  const messages = compilerMessages(input, ['/Users/PRIVATE/User Cache']);
  assert.equal(messages.length, 12);
  assert.ok(messages.every(item => item.message.length <= 360));
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|secret|module\/|a.swift/);
  assert.deepEqual(compilerMessages(null), []);
});
