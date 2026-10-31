import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import strictJSON from './strict-json.cjs';
import {createRequire} from 'node:module';
import {admit, captureProcessSnapshotScript as capture, batchControlScript, parseSnapshot, parseBatch,
  summarize, main, _runProcessProbeBenchmarkForTests as run} from './process-probe-benchmark.mjs';
const source = fs.readFileSync(new URL('./guard.cjs', import.meta.url));
const bytes = value => Buffer.from(JSON.stringify(value));
const snapshot = () => ({schema: 1, complete: true, count: 2, names: ['Vortex.exe', 'private-fixture-name.exe']});
const batch = n => ({schema: 1, complete: true, initial: Array.from({length: 2}, (_, index) => ({index, enumerationMs: index + 1, processCount: 2})), samples: Array.from({length: n}, (_, index) => ({index, enumerationMs: index + 1, processCount: 2}))});
function fake(samples = 3, change = () => {}) {
  let now = 0, spawns = 0, verifies = 0; const calls = [];
  const dependencies = {source, executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', clock: {now: () => now},
    admission: () => {now += 7; return {sha256: 'a'.repeat(64), bytes: 100, admissionMs: 7, verify: () => {verifies++;}};},
    spawn: (file, args, opts) => {
      spawns++; calls.push({file, args, opts}); now += 10;
      const out = {status: 0, signal: null, stderr: Buffer.alloc(0), stdout: bytes(spawns <= samples + 2 ? snapshot() : batch(samples))};
      change(out, spawns); return out;
    }};
  return {dependencies, calls, verifyCount: () => verifies, run: () => run({samples}, dependencies)};
}

test('executable admission stops at its original byte bound when the file grows during hashing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-bench-grow-'));
  const file = path.join(directory, 'owned-fixture.exe');
  const originalRead = fs.readSync; let grew = false, bytesRead = 0;
  try {
    fs.writeFileSync(file, Buffer.alloc(8, 1));
    fs.readSync = (...args) => {
      const count = originalRead(...args); bytesRead += count;
      if (!grew) {grew = true; fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 2));}
      return count;
    };
    assert.throws(() => admit(file), /PROCESS_BENCH_EXECUTABLE_CHANGED/);
    assert(bytesRead <= 9, 'a growing executable must not be read to its new EOF');
  } finally {
    fs.readSync = originalRead;
    fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});
test('captured current PowerShell script is exactly the production encoded invocation, without eval', () => {
  let observed;
  const require = createRequire(new URL('./guard.cjs', import.meta.url)), module = {exports: {}};
  vm.runInNewContext('(function(require,module,exports){' + source.toString('utf8') + '\n})',
    {process: {env: {SystemRoot: 'C:\\Windows'}, platform: 'win32'}, Buffer, TextDecoder})(
    id => id === 'node:child_process' ? {spawnSync: (_, args) => {observed = Buffer.from(args.at(-1), 'base64').toString('utf16le'); return {status: 0, stdout: JSON.stringify(snapshot()), stderr: ''};}} : require(id), module, module.exports);
  module.exports.processNames(); assert.equal(capture(source).script, observed);
  const control = batchControlScript(observed, 3);
  assert(control.includes(observed.replace('  exit 0\n', '  return\n')));
  assert(control.includes('System.Diagnostics.Stopwatch')); assert(control.includes('$i -lt 5'));
  assert(!control.includes('Start-Process')); assert(!control.includes('Get-CimInstance'));
});
test('bounded decoder refuses interpolation, unsupported escapes, duplicate or changed source anchors', () => {
  for (const s of [source.toString().replace('PROCESS_SNAPSHOT_SCRIPT = `', 'CHANGED = `'),
    source.toString() + source.toString(), source.toString().replace('$ErrorActionPreference', '${arbitrary}'),
    source.toString().replace('$ErrorActionPreference', String.fromCharCode(92) + 'q')]) assert.throws(() => capture(Buffer.from(s)), /PROCESS_BENCH_SOURCE_CHANGED/);
  assert.throws(() => capture(Buffer.from([0xff])));
  assert.throws(() => capture(Buffer.alloc(256 * 1024 + 1)), /SOURCE_LIMIT/);
  assert.throws(() => batchControlScript(capture(source).script.replace('  exit 0', '  exit 2'), 3), /SOURCE_CHANGED/);
});
test('snapshot validation rejects partial, malformed, oversized and duplicate-key output', () => {
  for (const v of [{...snapshot(), complete: false}, {...snapshot(), count: 3}, {...snapshot(), count: 0},
    {...snapshot(), extra: true}, {...snapshot(), names: ['C:/private', 'ok']}, {...snapshot(), names: ['bad\nname', 'ok']},
    {...snapshot(), names: ['ok', null]}, {...snapshot(), schema: '1'}]) assert.throws(() => parseSnapshot(bytes(v)), /PROCESS_BENCH_/);
  for (const v of [Buffer.from('{broken'), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1), Buffer.from('{"schema":1,"schema":1}')]) assert.throws(() => parseSnapshot(v), /PROCESS_BENCH_/);
  assert.deepEqual(parseSnapshot(bytes(snapshot())), {processCount: 2});
});
test('batch validation requires exact ordered complete finite sample rows', () => {
  for (const change of [v => {v.complete = false;}, v => {v.samples.pop();}, v => {v.samples[1].index = 0;},
    v => {v.samples[0].enumerationMs = -1;}, v => {v.samples[0].enumerationMs = null;},
    v => {v.samples[0].processCount = 65537;}, v => {v.samples[0].names = ['private'];}]) {
    const v = batch(3); change(v); assert.throws(() => parseBatch(bytes(v), 3), /PROCESS_BENCH_/);
  }
});
test('statistics retain input, reject invalid samples and omit small-sample p95', () => {
  const values = [3, 1, 2, 4]; assert.deepEqual(summarize(values), {samples: 4, minMs: 1, medianMs: 2.5, maxMs: 4}); assert.deepEqual(values, [3, 1, 2, 4]);
  for (const v of [[], [NaN], [Infinity], [-1], new Array(1), Array(101).fill(1)]) assert.throws(() => summarize(v), /INVALID_SAMPLES/);
  assert.equal(summarize(Array.from({length: 40}, (_, i) => i + 1)).p95Ms, 38);
});
test('fake baseline and one batch separate admission, caller wall and enumeration without persisting names', () => {
  const f = fake(), report = f.run(); assert.equal(f.calls.length, 6); assert.equal(f.verifyCount(), 12);
  assert.equal(report.executableAdmissionMs, 7); assert.equal(report.oneShot.samples.length, 3);
  assert.equal(report.oneShot.summary.medianMs, 10); assert.equal(report.batch.callerWallMs, 10); assert.equal(report.batch.summary.medianMs, 2);
  assert.equal(report.totalBenchmarkMs, 67); assert.equal(report.oneShot.initial.length, 2); assert.equal(report.batch.initial.length, 2);
  assert.equal(report.oneShot.initial[0].label, 'first-observed-process'); assert.equal(report.batch.initial[0].label, 'first-observed-in-process');
  assert.equal(report.oneShot.iterationSummary.medianMs, 10); assert.equal(report.batch.iterationWallMs, 10); assert.equal(report.rawProcessNamesRecorded, false);
  assert(!JSON.stringify(report).includes('private-fixture-name')); assert(!JSON.stringify(report).includes('Vortex.exe'));
  assert.equal(report.vortexEffectsPerformed, false); assert.equal(report.processesSpawned, 6); assert.equal(report.coldDiskClaimed, false);
  for (const call of f.calls) {assert.equal(call.opts.timeout, 10000); assert.equal(call.opts.maxBuffer, 1048576); assert.equal(call.opts.windowsHide, true); assert(!Object.hasOwn(call.opts, 'env'));}
});
test('spawn failure, nonzero exit, stderr, timeout and malformed replies cannot become measurements', () => {
  for (const change of [v => {v.error = Error('private diagnostic');}, v => {v.status = 1;}, v => {v.signal = 'SIGTERM';},
    v => {v.stderr = Buffer.from('private stderr');}, v => {v.stdout = Buffer.from('partial');}]) {
    assert.throws(() => fake(3, change).run(), /PROCESS_BENCH_/);
  }
  const late = fake(); late.dependencies.spawn = () => {late.dependencies.clock.now = () => 60001; return {status: 0, stdout: bytes(snapshot()), stderr: Buffer.alloc(0)};};
  assert.throws(() => late.run(), /DEADLINE/);
});

test('slow executable verification cannot start a process after the observed benchmark deadline', () => {
  const f = fake();
  f.dependencies.admission = () => ({sha256: 'a'.repeat(64), bytes: 100, admissionMs: 0,
    verify: () => {f.dependencies.clock.now = () => 60001;}});
  assert.throws(() => f.run(), /PROCESS_BENCH_DEADLINE/);
  assert.equal(f.calls.length, 0);
});
test('argument and sample limits fail before admission/spawn; default CLI is plan-only', () => {
  for (const value of [{samples: 0}, {samples: 101}, {samples: 1.5}, {samples: '3'}, {samples: null}, {extra: true}, {samples: 1, executable: 'other'}]) {
    assert.throws(() => run(value, {}), /PROCESS_BENCH_/);
  }
  for (const args of [['--samples', '0'], ['--samples', '101'], ['--samples'], ['--run', '--run'], ['--unknown'], ['--samples', '1', '--samples', '2']]) assert.throws(() => main(args), /PROCESS_BENCH_/);
  const plan = main(['--samples', '20']); assert.equal(plan.executesProcesses, false); assert.equal(plan.samplesPerMode, 20); assert.equal(plan.explicitRunRequired, true);
});

test('encoded command cap fails before invoking a process', () => {
  const f = fake(); f.dependencies.source = Buffer.from(source.toString().replace('$ErrorActionPreference', ' '.repeat(20000) + '$ErrorActionPreference'));
  assert.throws(() => f.run(), /COMMAND_LIMIT/); assert.equal(f.calls.length, 0);
});

test('full iteration includes executable generation checks while spawn wall remains separate', () => {
  const f = fake(); const original = f.dependencies.admission; let extra = 0; const clock = f.dependencies.clock.now;
  f.dependencies.clock.now = () => clock() + extra;
  f.dependencies.admission = value => {const pin = original(value); return {...pin, verify() {pin.verify(); extra += 2;}};};
  const report = f.run(); assert.equal(report.oneShot.summary.medianMs, 10); assert.equal(report.oneShot.iterationSummary.medianMs, 14);
  assert.equal(report.oneShot.initial[0].iterationWallMs, 14); assert.equal(report.batch.iterationWallMs, 14);
});

test('full iteration includes envelope parsing cost instead of just subprocess elapsed time', t => {
  const original = strictJSON.parseStrictJSON; let parseTime = 0;
  t.after(() => {strictJSON.parseStrictJSON = original;});
  strictJSON.parseStrictJSON = (...args) => {parseTime += 3; return original(...args);};
  const f = fake(); const clock = f.dependencies.clock.now; f.dependencies.clock.now = () => clock() + parseTime;
  const report = f.run(); assert.equal(report.oneShot.summary.medianMs, 10); assert.equal(report.oneShot.iterationSummary.medianMs, 13);
  assert.equal(report.oneShot.initial[0].iterationWallMs, 13); assert.equal(report.batch.iterationWallMs, 13);
});
