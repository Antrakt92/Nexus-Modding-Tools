import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import strictJSON from './strict-json.cjs';

const GUARD = new URL('./guard.cjs', import.meta.url);
const MAX_BYTES = 1024 * 1024, MAX_WALL_MS = 60000, SPAWN_MS = 10000, WARMUPS = 2;
const need = (ok, code) => {if (!ok) throw Error(code);};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === names.length && names.every(k => {const d = Object.getOwnPropertyDescriptor(value, k); return d && Object.hasOwn(d, 'value') && d.enumerable;});
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isInteger(value) && value > 0 && value <= 65536;
function options(value) {
  need(exact(value, Object.hasOwn(value ?? {}, 'samples') ? ['samples'] : []), 'PROCESS_BENCH_INVALID_OPTIONS');
  const samples = Object.hasOwn(value, 'samples') ? value.samples : 10;
  need(Number.isInteger(samples) && samples >= 1 && samples <= 100, 'PROCESS_BENCH_SAMPLE_LIMIT'); return {samples};
}
export function captureProcessSnapshotScript(bytes) {
  need(bytes instanceof Uint8Array && bytes.byteLength <= 256 * 1024, 'PROCESS_BENCH_SOURCE_LIMIT');
  const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const anchor = 'const PROCESS_SNAPSHOT_SCRIPT = `';
  need(source.split(anchor).length === 2, 'PROCESS_BENCH_SOURCE_CHANGED');
  let at = source.indexOf(anchor) + anchor.length, script = '';
  for (; at < source.length; at++) {
    const ch = source[at];
    if (ch === '`') break;
    if (ch.charCodeAt(0) === 92) {
      const next = source[++at], escapes = {[String.fromCharCode(92)]: String.fromCharCode(92), n: String.fromCharCode(10), r: String.fromCharCode(13), t: String.fromCharCode(9), '`': '`'};
      need(Object.hasOwn(escapes, next), 'PROCESS_BENCH_SOURCE_CHANGED'); script += escapes[next];
    } else {need(!(ch === '$' && source[at + 1] === '{'), 'PROCESS_BENCH_SOURCE_CHANGED'); script += ch;}
  }
  need(source.slice(at, at + 2) === '`;' && script.includes('[System.Diagnostics.Process]::GetProcesses()'), 'PROCESS_BENCH_SOURCE_CHANGED');
  return {script: script.replace(/\r\n/g, '\n'), guardSHA256: sha(bytes)};
}
export function batchControlScript(script, samples) {
  options({samples});
  const before = '  exit 0' + String.fromCharCode(10);
  need(script.split(before).length === 2, 'PROCESS_BENCH_SOURCE_CHANGED');
  const body = script.replace(before, '  return' + String.fromCharCode(10));
  const utility = 'Microsoft.PowerShell.Utility' + String.fromCharCode(92);
  // Only exit 0 changes inside the captured body. The wrapper validates and
  // discards names before emitting bounded per-iteration timing/count rows.
  return `function InvokeCurrentSnapshot {
${body}
}
$measurements = @()
$initial = @()
for ($i=0; $i -lt ${samples + WARMUPS}; $i++) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $raw = InvokeCurrentSnapshot
  $elapsed = $clock.Elapsed.TotalMilliseconds
  $snapshot = ${utility}ConvertFrom-Json -InputObject ($raw -join [Environment]::NewLine) -ErrorAction Stop
  if ($snapshot.schema -ne 1 -or $snapshot.complete -ne $true -or $snapshot.count -le 0 -or $snapshot.count -gt 65536 -or @($snapshot.names).Count -ne $snapshot.count) { throw 'PROCESS_BENCH_PARTIAL' }
  foreach ($name in $snapshot.names) {
    if ($name -isnot [string] -or $name.Length -eq 0 -or $name.Length -gt 260) { throw 'PROCESS_BENCH_PARTIAL' }
    foreach ($c in $name.ToCharArray()) { if ([int]$c -lt 32 -or [int]$c -eq 127 -or [int]$c -eq 92 -or $c -eq '/') { throw 'PROCESS_BENCH_PARTIAL' } }
  }
  if ($i -lt ${WARMUPS}) { $initial += @{index=$i;enumerationMs=$elapsed;processCount=$snapshot.count} }
  else { $measurements += @{index=$i-${WARMUPS};enumerationMs=$elapsed;processCount=$snapshot.count} }
}
@{schema=1;complete=$true;initial=$initial;samples=$measurements} | ${utility}ConvertTo-Json -Compress -Depth 4
`;
}

function parse(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'PROCESS_BENCH_OUTPUT_LIMIT');
  try {return strictJSON.parseStrictJSON(bytes, {maxBytes: MAX_BYTES, maxDepth: 5, maxTokens: 150000});}
  catch {throw Error('PROCESS_BENCH_INVALID_OUTPUT');}
}
export function parseSnapshot(bytes) {
  const value = parse(bytes);
  need(exact(value, ['schema', 'complete', 'count', 'names']) && value.schema === 1 && value.complete === true
    && count(value.count) && Array.isArray(value.names) && value.names.length === value.count
    && value.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 260 && !/[\\/\x00-\x1f\x7f]/.test(name)), 'PROCESS_BENCH_PARTIAL');
  return {processCount: value.count}; // Names never leave this parser.
}
export function parseBatch(bytes, samples) {
  options({samples}); const value = parse(bytes);
  need(exact(value, ['schema', 'complete', 'initial', 'samples']) && value.schema === 1 && value.complete === true,
    'PROCESS_BENCH_PARTIAL');
  const rows = (values, length) => {
    need(Array.isArray(values) && values.length === length, 'PROCESS_BENCH_PARTIAL');
    return values.map((row, index) => {
      need(exact(row, ['index', 'enumerationMs', 'processCount']) && row.index === index
        && duration(row.enumerationMs) && count(row.processCount), 'PROCESS_BENCH_PARTIAL');
      return {index, enumerationMs: row.enumerationMs, processCount: row.processCount};
    });
  };
  return {initial: rows(value.initial, WARMUPS), samples: rows(value.samples, samples)};
}

export function summarize(values) {
  need(Array.isArray(values) && values.length > 0 && values.length <= 100 && Reflect.ownKeys(values).length === values.length + 1 && Array.from({length: values.length}, (_, i) => values[i]).every(duration), 'PROCESS_BENCH_INVALID_SAMPLES');
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return {samples: n, minMs: sorted[0], medianMs: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    maxMs: sorted[n - 1], ...(n >= 40 ? {p95Ms: sorted[Math.ceil(n * 0.95) - 1]} : {})};
}
export function interpreter() {
  need(process.platform === 'win32' && process.versions.electron === undefined, 'PROCESS_BENCH_WINDOWS_NODE_REQUIRED');
  const root = process.env.SystemRoot;
  need(typeof root === 'string' && /^[a-z]:\\[^<>:"|?*\x00-\x1f]+$/i.test(root) && path.win32.normalize(root) === root, 'PROCESS_BENCH_SYSTEMROOT');
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
const generation = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
export function admit(file) {
  const started = performance.now(), parents = [];
  for (let p = path.dirname(file);; p = path.dirname(p)) {
    const s = fs.lstatSync(p, {bigint: true}); need(s.isDirectory() && !s.isSymbolicLink(), 'PROCESS_BENCH_EXECUTABLE_CHANGED');
    parents.push([p, `${s.dev}:${s.ino}`]); if (p === path.dirname(p)) break;
  }
  const fd = fs.openSync(file, 'r'); let before, digest;
  try {
    before = fs.fstatSync(fd, {bigint: true}); need(before.isFile() && before.size > 0n && before.size <= 32n * 1024n * 1024n, 'PROCESS_BENCH_EXECUTABLE_CHANGED');
    const h = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let n, bytes = 0;
    while ((n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - bytes + 1), null)) > 0) {
      bytes += n;
      need(bytes <= Number(before.size), 'PROCESS_BENCH_EXECUTABLE_CHANGED');
      h.update(buffer.subarray(0, n));
    }
    need(bytes === Number(before.size) && generation(fs.fstatSync(fd, {bigint: true})) === generation(before), 'PROCESS_BENCH_EXECUTABLE_CHANGED'); digest = h.digest('hex');
  } finally {fs.closeSync(fd);}
  const verify = () => {
    for (const [dir, id] of parents) {const s = fs.lstatSync(dir, {bigint: true}); need(s.isDirectory() && !s.isSymbolicLink() && `${s.dev}:${s.ino}` === id, 'PROCESS_BENCH_EXECUTABLE_CHANGED');}
    const s = fs.lstatSync(file, {bigint: true}); need(s.isFile() && !s.isSymbolicLink() && generation(s) === generation(before), 'PROCESS_BENCH_EXECUTABLE_CHANGED');
  };
  verify(); return {sha256: digest, bytes: Number(before.size), admissionMs: performance.now() - started, verify};
}
function run(value, dependencies) {
  const {samples} = options(value), {spawn, clock, executable, admission, source} = dependencies;
  const started = clock.now(), captured = captureProcessSnapshotScript(source), control = batchControlScript(captured.script, samples);
  const binary = admission(executable); const measurements = [], initial = [];
  const invoke = script => {
    need(MAX_WALL_MS - (clock.now() - started) > 0, 'PROCESS_BENCH_DEADLINE'); binary.verify();
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    need(encoded.length <= 30000, 'PROCESS_BENCH_COMMAND_LIMIT');
    const remaining = MAX_WALL_MS - (clock.now() - started);
    need(remaining > 0, 'PROCESS_BENCH_DEADLINE');
    const begin = clock.now();
    const result = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {encoding: 'buffer', timeout: Math.max(1, Math.min(SPAWN_MS, Math.floor(remaining))), maxBuffer: MAX_BYTES, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const callerWallMs = clock.now() - begin;
    need(duration(callerWallMs) && clock.now() - started <= MAX_WALL_MS, 'PROCESS_BENCH_DEADLINE'); binary.verify();
    need(result && !result.error && result.status === 0 && !result.signal && Buffer.isBuffer(result.stderr)
      && result.stderr.length === 0, 'PROCESS_BENCH_SPAWN_FAILED');
    return {bytes: result.stdout, callerWallMs};
  };
  const iteration = (script, validate) => {
    const begin = clock.now(), call = invoke(script), value = validate(call.bytes), iterationWallMs = clock.now() - begin;
    need(duration(iterationWallMs) && clock.now() - started <= MAX_WALL_MS, 'PROCESS_BENCH_DEADLINE');
    return {callerWallMs: call.callerWallMs, iterationWallMs, value};
  };
  for (let i = 0; i < samples + WARMUPS; i++) {
    const row = iteration(captured.script, parseSnapshot);
    const observation = {index: i < WARMUPS ? i : i - WARMUPS, callerWallMs: row.callerWallMs,
      iterationWallMs: row.iterationWallMs, ...row.value};
    if (i < WARMUPS) initial.push({...observation, label: i === 0 ? 'first-observed-process' : 'second-initial-process'});
    else measurements.push(observation);
  }
  const batch = iteration(control, bytes => parseBatch(bytes, samples)), batchRows = batch.value;
  return {schema: 'process-probe-benchmark/1', samplesPerMode: samples, warmupsPerMode: WARMUPS,
    guardSHA256: captured.guardSHA256, snapshotScriptSHA256: sha(Buffer.from(captured.script, 'utf16le')), batchScriptSHA256: sha(Buffer.from(control, 'utf16le')),
    executable: {path: executable, sha256: binary.sha256, bytes: binary.bytes}, executableAdmissionMs: binary.admissionMs,
    oneShot: {initial, samples: measurements, summary: summarize(measurements.map(row => row.callerWallMs)),
      iterationSummary: summarize(measurements.map(row => row.iterationWallMs))},
    batch: {callerWallMs: batch.callerWallMs, iterationWallMs: batch.iterationWallMs,
      initial: batchRows.initial.map((row, index) => ({...row, label: index === 0 ? 'first-observed-in-process' : 'second-initial-in-process'})),
      samples: batchRows.samples, summary: summarize(batchRows.samples.map(row => row.enumerationMs))},
    totalBenchmarkMs: clock.now() - started,
    measurementScope: {oneShot: 'Caller spawnSync wall; includes interpreter startup and execution, excludes base64 construction, separate binary admission, envelope parsing and generation checks.',
      iterationWall: 'Full caller iteration including pre/post executable generation checks, base64 construction, spawn and strict output parsing/validation; excludes initial executable SHA admission and report construction.',
      initial: 'Both initial observations retained separately, not in measured summaries. Initial executable hashing already warms its file cache; these are not cold-disk observations.',
      batchEnumeration: 'Same interpreter; current import/enumeration/JSON body with only exit 0 changed to return; includes serialization, excludes outer parsing/validation.',
      batchWall: 'Whole process wall including startup, two warmups, all measured invocations and batch parsing/validation/serialization.',
      total: 'Includes captured-source decoding/hashing, executable admission and orchestration; excludes initial source-file read and final report JSON serialization.',
      admission: 'Benchmark-only initial executable hash plus metadata checks; production guard does not hash PowerShell per check.',
      order: 'All one-shot observations precede one shared-process batch; ordering and changing process populations are not controlled.',
      interpretation: 'Differences include interpreter startup, module/JIT reuse and cohort drift; they do not isolate OS spawn cost, language performance or installation latency.',
      stdout: 'Buffers decoded with fatal UTF-8 and strict JSON; production currently uses utf8 strings and JSON.parse.',
      environment: 'Same inherited environment as production guard; values are never recorded.',
      percentilePolicy: 'p95 omitted below 40 samples; above that it is an empirical diagnostic, not a latency bound.'},
    rawProcessNamesRecorded: false, vortexEffectsPerformed: false, processesSpawned: samples + WARMUPS + 1, coldDiskClaimed: false};
}
export function runProcessProbeBenchmark(value = {}) {
  return run(value, {spawn: spawnSync, clock: performance, executable: interpreter(), admission: admit, source: fs.readFileSync(GUARD)});
}
export function _runProcessProbeBenchmarkForTests(value, dependencies) {return run(value, dependencies);}
export function main(args = process.argv.slice(2)) {
  let samples = 10, execute = false, seenSamples = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' && !execute) execute = true;
    else if (args[i] === '--samples' && !seenSamples && /^(?:[1-9]\d?)$|^100$/.test(args[i + 1] ?? '')) {samples = Number(args[++i]); seenSamples = true;}
    else throw Error('PROCESS_BENCH_INVALID_ARGUMENTS');
  }
  options({samples});
  if (execute) return runProcessProbeBenchmark({samples});
  const captured = captureProcessSnapshotScript(fs.readFileSync(GUARD));
  return {schema: 'process-probe-benchmark-plan/1', samplesPerMode: samples, warmupsPerMode: WARMUPS,
    guardSHA256: captured.guardSHA256, snapshotScriptSHA256: sha(Buffer.from(captured.script, 'utf16le')),
    cooperativeWallBudgetMs: MAX_WALL_MS, maximumSpawnMs: SPAWN_MS, maximumOutputBytes: MAX_BYTES,
    executesProcesses: false, explicitRunRequired: true};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(JSON.stringify(main()) + '\n');}
  catch (error) {process.stderr.write((/^PROCESS_BENCH_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'PROCESS_BENCH_FAILED') + '\n'); process.exitCode = 1;}
}
