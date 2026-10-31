import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {pathToFileURL} from 'node:url';
import paths from './paths.cjs';
import contract from './process-probe-contract.cjs';
import {captureProcessSnapshotScript, parseSnapshot, summarize, interpreter, admit} from './process-probe-benchmark.mjs';
const MAX_WALL = 60000, MAX_PROCESS = 10000, MAX_BYTES = 1024 * 1024, INITIAL = 2;
const need = (ok, code) => {if (!ok) throw Error(code);};
const source = () => fs.readFileSync(new URL('./guard.cjs', import.meta.url));
const exact = (v, keys) => v && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => {const d = Object.getOwnPropertyDescriptor(v, k); return d && Object.hasOwn(d, 'value') && d.enumerable;});
export function validateComparisonOptions(value) {
  const fields = ['binary', 'sha256', ...(value && !types.isProxy(value) && Object.hasOwn(value, 'samples') ? ['samples'] : [])];
  need(exact(value, fields), 'PROCESS_COMPARE_INVALID_OPTIONS');
  const binary = paths.absolute(value.binary, 'PROCESS_COMPARE_BINARY');
  need(binary.length <= 1024 && path.basename(binary).toLowerCase() === 'vortex-native-process-probe.exe', 'PROCESS_COMPARE_BINARY_NAME');
  need(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'PROCESS_COMPARE_INVALID_SHA256');
  const samples = Object.hasOwn(value, 'samples') ? value.samples : 10;
  need(Number.isInteger(samples) && samples >= 1 && samples <= 100, 'PROCESS_COMPARE_SAMPLE_LIMIT');
  return {binary, sha256: value.sha256, samples};
}
function run(input, dependencies) {
  const options = validateComparisonOptions(input), {spawn, clock, admission, powershell, requestId} = dependencies;
  const started = clock.now(), captured = captureProcessSnapshotScript(dependencies.source);
  const pins = {powershell: admission(powershell), native: admission(options.binary)};
  need(pins.native.sha256 === options.sha256, 'PROCESS_COMPARE_BINARY_PIN');
  const executable = {powershell, native: options.binary};
  const timed = () => {const remaining = MAX_WALL - (clock.now() - started); need(Number.isFinite(remaining) && remaining > 0, 'PROCESS_COMPARE_DEADLINE'); return remaining;};
  const invoke = kind => {
    const begin = clock.now(); timed(); pins[kind].verify();
    let args, stdin, request;
    if (kind === 'powershell') {
      const encoded = Buffer.from(captured.script, 'utf16le').toString('base64');
      need(encoded.length <= 30000, 'PROCESS_COMPARE_COMMAND_LIMIT'); args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    } else {
      request = contract.validateRequest({version: 1, requestId: requestId()});
      stdin = Buffer.from(JSON.stringify(request) + String.fromCharCode(10)); need(stdin.length <= contract.LIMITS.requestBytes, 'PROCESS_COMPARE_REQUEST_LIMIT'); args = [];
    }
    const remaining = timed(), spawnBegin = clock.now();
    const result = spawn(executable[kind], args, {encoding: 'buffer', input: stdin, timeout: Math.max(1, Math.min(MAX_PROCESS, Math.floor(remaining))),
      maxBuffer: MAX_BYTES, windowsHide: true, stdio: [kind === 'native' ? 'pipe' : 'ignore', 'pipe', 'pipe']});
    const callerWallMs = clock.now() - spawnBegin;
    need(result && !result.error && result.status === 0 && !result.signal && Buffer.isBuffer(result.stdout)
      && Buffer.isBuffer(result.stderr) && result.stderr.length === 0 && result.stdout.length <= MAX_BYTES, 'PROCESS_COMPARE_PROCESS_FAILED');
    timed(); pins[kind].verify();
    const processCount = kind === 'powershell' ? parseSnapshot(result.stdout).processCount : contract.parseReply(result.stdout, request.requestId).count;
    const iterationWallMs = clock.now() - begin; timed();
    need(Number.isFinite(callerWallMs) && callerWallMs >= 0 && Number.isFinite(iterationWallMs) && iterationWallMs >= callerWallMs, 'PROCESS_COMPARE_INVALID_TIMING');
    return {processCount, callerWallMs, iterationWallMs, exitObserved: true, stdoutEOFObserved: true};
  };
  const initial = [], pairs = [];
  for (let i = 0; i < options.samples + INITIAL; i++) {
    const order = i % 2 === 0 ? ['powershell', 'native'] : ['native', 'powershell'];
    const row = {index: i < INITIAL ? i : i - INITIAL, order, observations: {}};
    for (const kind of order) row.observations[kind] = invoke(kind);
    if (i < INITIAL) initial.push({...row, label: i === 0 ? 'first-observed-pair' : 'second-initial-pair'}); else pairs.push(row);
  }
  const summary = Object.fromEntries(['powershell', 'native'].map(kind => [kind, {
    callerWall: summarize(pairs.map(p => p.observations[kind].callerWallMs)), iterationWall: summarize(pairs.map(p => p.observations[kind].iterationWallMs)),
  }]));
  return {schema: 'process-probe-comparison/1', samplesPerMode: options.samples, initialPairs: initial, pairs, summary,
    guardSHA256: captured.guardSHA256, snapshotScriptSHA256: crypto.createHash('sha256').update(Buffer.from(captured.script, 'utf16le')).digest('hex'),
    executables: Object.fromEntries(Object.keys(pins).map(kind => [kind, {path: executable[kind], sha256: pins[kind].sha256, bytes: pins[kind].bytes, admissionMs: pins[kind].admissionMs}])),
    totalComparisonMs: clock.now() - started, cooperativeWallBudgetMs: MAX_WALL, processesSpawned: 2 * (options.samples + INITIAL), rawProcessNamesRecorded: false, vortexEffectsPerformed: false,
    measurements: {callerWall: 'spawnSync wall only, including child startup/enumeration/serialization and complete stdout/stderr collection.',
      iterationWall: 'Includes fresh executable generation checks, request/base64 construction, spawn, strict reply parsing and binding; excludes initial executable SHA admission.',
      total: 'Includes captured source decoding, both executable admissions and all initial/measured calls; excludes initial guard-file read and final report serialization.',
      wallBudget: 'Cooperative checks before/after synchronous stages; filesystem admission/verification cannot be interrupted by this budget. Fresh remaining time sets each child timeout.',
      admission: 'Both executable SHA/metadata admissions are benchmark-only setup, not current per-check production guard costs; hashing warms executable file cache.',
      ordering: 'Alternating AB/BA adjacent pairs; initial two calls per executable retained separately and excluded from summaries.',
      interpretation: 'Different .NET/PowerShell versus Toolhelp backends: not isolated Rust-language performance, exact census equality, current game absence or native-guard permission.',
      percentilePolicy: 'Empirical p95 omitted below 40 observations; no percentile is a latency bound or total-install speedup estimator.',
      environment: 'Same inherited environment for both executables; no environment values or process names recorded.'},
    claims: {coldDisk: false, exactCensusEquality: false, processAbsenceIndependentlyVerified: false, productionIntegrationVerified: false, installSpeedupVerified: false}};
}
export function runProcessProbeComparison(options) {
  return run(options, {spawn: spawnSync, clock: performance, admission: admit, powershell: interpreter(), source: source(), requestId: () => crypto.randomBytes(16).toString('hex')});
}
export function _runProcessProbeComparisonForTests(options, dependencies) {return run(options, dependencies);}
export function main(args = process.argv.slice(2)) {
  const options = {}; let execute = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--run' && !execute) execute = true;
    else if (['--binary', '--sha256', '--samples'].includes(name) && !Object.hasOwn(options, name.slice(2)) && args[i + 1] !== undefined) {
      const key = name.slice(2), value = args[++i];
      if (key === 'samples') {need(/^(?:[1-9][0-9]?|100)$/.test(value), 'PROCESS_COMPARE_INVALID_ARGUMENTS'); options[key] = Number(value);} else options[key] = value;
    } else throw Error('PROCESS_COMPARE_INVALID_ARGUMENTS');
  }
  const checked = validateComparisonOptions(options);
  if (execute) return runProcessProbeComparison(checked);
  return {schema: 'process-probe-comparison-plan/1', ...checked, explicitRunRequired: true, executesProcesses: false,
    samplesPerMode: checked.samples, initialCallsPerMode: INITIAL, cooperativeWallBudgetMs: MAX_WALL, maximumProcessMs: MAX_PROCESS,
    maximumOutputBytes: MAX_BYTES, guardSHA256: captureProcessSnapshotScript(source()).guardSHA256};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(JSON.stringify(main()) + String.fromCharCode(10));}
  catch (error) {process.stderr.write((/^PROCESS_(?:COMPARE|PROBE|BENCH)_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'PROCESS_COMPARE_FAILED') + String.fromCharCode(10)); process.exitCode = 1;}
}
