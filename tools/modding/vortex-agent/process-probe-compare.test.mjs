import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import contract from './process-probe-contract.cjs';
import strictJSON from './strict-json.cjs';
import {validateComparisonOptions as validate, _runProcessProbeComparisonForTests as run, main} from './process-probe-compare.mjs';
const binary = path.resolve('vortex-native-process-probe.exe'), hash = 'a'.repeat(64);
const options = {binary, sha256: hash, samples: 3};
function fake(change = () => {}) {
  let now = 0, seq = 0, checks = 0; const calls = [], admissions = [];
  const dependencies = {clock: {now: () => now}, source: fs.readFileSync(new URL('./guard.cjs', import.meta.url)), powershell: path.resolve('powershell.exe'),
    requestId: () => (++seq).toString(16).padStart(32, '0'), admission: file => {
      admissions.push(file); now += 7; return {sha256: hash, bytes: 100, admissionMs: 7, verify() {checks++; now += 2;}};
    }, spawn(file, args, opts) {
      const native = file === binary; now += native ? 3 : 10; calls.push({native, file, args, opts});
      const request = native ? contract.parseRequest(opts.input) : null;
      const value = native ? {schema: contract.CONTRACT.schema, requestId: request.requestId, backend: 'toolhelp32w', nameKind: 'executable-basename',
        complete: true, count: 1, names: ['private-native.exe'], effectsAllowed: false}
        : {schema: 1, complete: true, count: 2, names: ['private-ps.exe', 'changing-process.exe']};
      const result = {status: 0, signal: null, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0)};
      change(result, {native, request, value, call: calls.at(-1)}); return result;
    }};
  return {dependencies, calls, admissions, checkCount: () => checks, run: () => run(options, dependencies)};
}
test('alternating AB/BA pairs retain initial observations, churn counts and no raw names', () => {
  const f = fake(), report = f.run(); assert.equal(f.calls.length, 10); assert.equal(f.checkCount(), 20); assert.equal(f.admissions.length, 2);
  assert.deepEqual(f.calls.map(x => x.native), [false, true, true, false, false, true, true, false, false, true]);
  assert.equal(report.initialPairs.length, 2); assert.equal(report.pairs.length, 3); assert.equal(report.processesSpawned, 10);
  assert.equal(report.summary.powershell.callerWall.medianMs, 10); assert.equal(report.summary.native.callerWall.medianMs, 3);
  assert.equal(report.summary.powershell.iterationWall.medianMs, 14); assert.equal(report.summary.native.iterationWall.medianMs, 7);
  assert.equal(report.pairs[0].observations.powershell.processCount, 2); assert.equal(report.pairs[0].observations.native.processCount, 1);
  assert.equal(report.claims.exactCensusEquality, false); assert.equal(report.claims.productionIntegrationVerified, false);
  assert.equal(Object.hasOwn(report.summary.native.iterationWall, 'p95Ms'), false);
  assert(!JSON.stringify(report).includes('private-native')); assert(!JSON.stringify(report).includes('private-ps'));
  for (const call of f.calls) {assert.equal(call.opts.timeout, 10000); assert.equal(call.opts.maxBuffer, 1048576); assert.equal(call.opts.windowsHide, true); assert.equal(call.opts.stdio[0], call.native ? 'pipe' : 'ignore');}
});
test('strict request IDs and replies bind every native call, never accepting malformed or partial output', () => {
  for (const change of [v => {v.requestId = 'b'.repeat(32);}, v => {v.requestId = 'bad';}, v => {v.complete = false;},
    v => {v.backend = 'unknown';}, v => {v.names = ['bad/name'];}, v => {v.count = 2;}, v => {v.effectsAllowed = true;}]) {
    const f = fake((r, c) => {if(c.native) {change(c.value);r.stdout = Buffer.from(JSON.stringify(c.value));}});
    assert.throws(() => f.run(), /PROCESS_PROBE_/);
  }
  const invalid = fake(); invalid.dependencies.requestId = () => 'invalid'; assert.throws(() => invalid.run(), /PROCESS_PROBE_INVALID_REQUEST/); assert.equal(invalid.calls.length, 1);
});
test('malformed UTF-8, duplicate keys, oversize, stderr and failed child cannot become samples', () => {
  for (const change of [r => {r.stdout = Buffer.from([255]);}, r => {r.stdout = Buffer.from('{"schema":1,"schema":1}');},
    r => {r.stdout = Buffer.alloc(1048577);}, r => {r.stderr = Buffer.from('private stderr');}, r => {r.status = 1;},
    r => {r.signal = 'SIGTERM';}, r => {r.error = Error('private error');}]) assert.throws(() => fake(change).run(), /PROCESS_(?:COMPARE|BENCH|PROBE)_/);
});
test('hash mismatch or generation drift stops before another subprocess; no fallback or retry', () => {
  const mismatch = fake(); const admit = mismatch.dependencies.admission;
  mismatch.dependencies.admission = file => ({...admit(file), sha256: file === binary ? 'b'.repeat(64) : hash});
  assert.throws(() => mismatch.run(), /BINARY_PIN/); assert.equal(mismatch.calls.length, 0);
  for (const failCheck of [1, 2, 3, 4]) {
    const f = fake(); const admit = f.dependencies.admission; let checks = 0;
    f.dependencies.admission = file => ({...admit(file), verify() {if (++checks === failCheck) throw Error('PROCESS_BENCH_EXECUTABLE_CHANGED');}});
    assert.throws(() => f.run(), /EXECUTABLE_CHANGED/); assert.equal(f.calls.length, Math.floor(failCheck / 2));
  }
});
test('wall deadline covers admission and generation validation before spawn', () => {
  const f = fake(); f.dependencies.admission = () => ({sha256: hash, bytes: 100, admissionMs: 0, verify() {f.dependencies.clock.now = () => 60001;}});
  assert.throws(() => f.run(), /DEADLINE/); assert.equal(f.calls.length, 0);
});
test('strict output parsing time belongs to full parent iteration only', t => {
  const parser = strictJSON.parseStrictJSON; let parsing = 0;
  strictJSON.parseStrictJSON = (...args) => {parsing += 3; return parser(...args);}; t.after(() => {strictJSON.parseStrictJSON = parser;});
  const f = fake(); const clock = f.dependencies.clock.now; f.dependencies.clock.now = () => clock() + parsing;
  const report = f.run(); assert.equal(report.summary.powershell.callerWall.medianMs, 10); assert.equal(report.summary.powershell.iterationWall.medianMs, 17);
});
test('invalid sample options, accessors, paths, names, hashes and CLI args fail without execution', () => {
  for (const o of [{...options, samples: 0}, {...options, samples: 101}, {...options, samples: 1.5}, {...options, samples: null},
    {...options, binary: 'relative/vortex-native-process-probe.exe'}, {...options, binary: path.resolve('other.exe')},
    {...options, sha256: 'A'.repeat(64)}, {...options, extra: true}]) assert.throws(() => validate(o));
  const accessor = {...options}; Object.defineProperty(accessor, 'binary', {get() {throw Error('GETTER_EXECUTED');}});
  assert.throws(() => validate(accessor), /INVALID_OPTIONS/);
  for (const args of [[], ['--run', '--run'], ['--samples', '0'], ['--binary'], ['--unknown']]) assert.throws(() => main(args));
  const plan = main(['--binary', binary, '--sha256', hash, '--samples', '20']); assert.equal(plan.executesProcesses, false); assert.equal(plan.samplesPerMode, 20);
});
test('jittered durations are retained as observations and large-N p95 remains diagnostic', () => {
  let drift = 0; const f = fake(); const spawn = f.dependencies.spawn; f.dependencies.spawn = (...args) => {const r = spawn(...args); drift += 1; return r;};
  const clock = f.dependencies.clock.now; f.dependencies.clock.now = () => clock() + drift;
  const report = run({...options, samples: 40}, f.dependencies); assert.equal(report.pairs.length, 40);
  assert.equal(Object.hasOwn(report.summary.native.iterationWall, 'p95Ms'), true); assert.equal(report.claims.installSpeedupVerified, false);
});

test('game/process churn is preserved as counts and never becomes a game-absence claim', () => {
  const f = fake((result, call) => {call.value.names = call.native ? ['Vortex.exe'] : ['Cyberpunk2077.exe', 'REDprelauncher.exe']; result.stdout = Buffer.from(JSON.stringify(call.value));});
  const report = f.run(); assert.equal(report.claims.processAbsenceIndependentlyVerified, false);
  assert.equal(report.pairs[0].observations.powershell.processCount, 2); assert.equal(report.pairs[0].observations.native.processCount, 1);
  assert(!JSON.stringify(report).includes('Cyberpunk2077')); assert(!JSON.stringify(report).includes('REDprelauncher'));
});
