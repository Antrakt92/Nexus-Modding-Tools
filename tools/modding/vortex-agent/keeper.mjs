import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import strictJSON from './strict-json.cjs';
import { inspectOwnZip } from './own-helper-binder.mjs';

const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../local-state');
export const LIMITS = Object.freeze({ artifacts: 128, fileBytes: 64 * 1024 ** 2, totalBytes: 256 * 1024 ** 2, manifestBytes: 1024 * 1024, consumers: 128 });
const need = (ok, code) => { if (!ok) throw Error(code); };
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(k => {
  const d = Object.getOwnPropertyDescriptor(value, k); return d && Object.hasOwn(d, 'value') && d.enumerable;
});
const dense = (value, max) => Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, n) => Object.getOwnPropertyDescriptor(value, String(n))).every(d => d && Object.hasOwn(d, 'value') && d.enumerable);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const encode = value => Buffer.from(JSON.stringify(canonical(value)) + '\n');
const same = (a, b) => encode(a).equals(encode(b));
const node = s => `${s.dev}:${s.ino}`;
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
const within = (root, leaf) => { const rel = path.relative(root, leaf); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value), 'KEEPER_ABSOLUTE_PATH_REQUIRED');
  need(!value.startsWith('\\\\') && !value.startsWith('//'), 'KEEPER_UNSAFE_PATH');
  const rest = value.replace(/^[A-Za-z]:/, '');
  need(!/[<>:"|?*]/.test(rest) && rest.split(/[\\/]/).filter(Boolean).every(p => p.length <= 255 && p !== '.' && p !== '..'
    && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'KEEPER_UNSAFE_PATH');
  return path.resolve(value);
}
function ordinary(file, directory = false) {
  const s = fs.lstatSync(file, { bigint: true });
  need(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()) && s.ino > 0n && s.dev > 0n, 'KEEPER_UNSAFE_PATH'); return s;
}
function parents(dir) {
  const result = new Map();
  for (let p = dir; ; p = path.dirname(p)) { result.set(p, node(ordinary(p, true))); if (p === path.dirname(p)) break; }
  return result;
}
function checkParents(pins) { for (const [p, identity] of pins) need(node(ordinary(p, true)) === identity, 'KEEPER_PATH_CHANGED'); }
function read(file, max = LIMITS.fileBytes, observations) {
  file = absolute(file); const pins = parents(path.dirname(file)), initial = ordinary(file), fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.size >= 0n && before.size <= BigInt(max) && stamp(before) === stamp(initial), 'KEEPER_FILE_CHANGED');
    const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0, count;
    while (used < bytes.length && (count = fs.readSync(fd, bytes, used, bytes.length - used, null)) > 0) used += count;
    need(used === Number(before.size) && stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before)
      && stamp(ordinary(file)) === stamp(before), 'KEEPER_FILE_CHANGED');
    checkParents(pins); observations?.set(file, { stamp: stamp(before), node: node(before), pins }); return bytes.subarray(0, used);
  } finally { fs.closeSync(fd); }
}
function recheck(observations) { for (const [file, proof] of observations) { checkParents(proof.pins); need(stamp(ordinary(file)) === proof.stamp, 'KEEPER_FILE_CHANGED'); } }
function json(bytes) { try { return strictJSON.parseStrictJSON(bytes, { maxBytes: LIMITS.manifestBytes }); } catch { throw Error('KEEPER_INVALID_JSON'); } }
function payloadMap(value) {
  need(object(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 4096 && Object.values(value).every(digest), 'KEEPER_INVALID_PAYLOAD');
}
function contract(value) {
  need(exact(value, ['schema', 'artifacts', 'consumers', 'unknownConsumers']) && value.schema === 'keeper-plan/1'
    && dense(value.artifacts, LIMITS.artifacts) && value.artifacts.length > 0 && dense(value.consumers, LIMITS.consumers)
    && value.consumers.length > 0 && dense(value.unknownConsumers, LIMITS.consumers), 'KEEPER_INVALID_PLAN');
  const ids = new Map(), foldedIds = new Set(), paths = new Set(); let total = 0;
  for (const artifact of value.artifacts) {
    need(exact(artifact, ['id', 'kind', 'path', 'bytes', 'sha256', ...(artifact?.kind === 'own-zip' ? ['payload'] : [])])
      && id(artifact.id) && !foldedIds.has(artifact.id.toLowerCase()) && ['own-zip', 'build-receipt', 'source-manifest', 'own-source'].includes(artifact.kind)
      && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= LIMITS.fileBytes && digest(artifact.sha256), 'KEEPER_INVALID_ARTIFACT');
    foldedIds.add(artifact.id.toLowerCase());
    const file = absolute(artifact.path), folded = file.toLowerCase(); need(!paths.has(folded), 'KEEPER_DUPLICATE_PATH'); paths.add(folded);
    if (artifact.kind === 'own-zip') payloadMap(artifact.payload);
    total += artifact.bytes; need(total <= LIMITS.totalBytes, 'KEEPER_BYTE_LIMIT'); ids.set(artifact.id, artifact);
  }
  const consumers = new Set(), referenced = new Set();
  for (const consumer of value.consumers) {
    need(exact(consumer, ['id', 'evidenceArtifactId', 'inputs', 'currentOutputs', 'rollback']) && id(consumer.id)
      && !consumers.has(consumer.id) && ['build-receipt', 'source-manifest'].includes(ids.get(consumer.evidenceArtifactId)?.kind), 'KEEPER_INVALID_CONSUMER');
    consumers.add(consumer.id); referenced.add(consumer.evidenceArtifactId); let count = 0;
    for (const role of ['inputs', 'currentOutputs', 'rollback']) {
      const refs = consumer[role]; need(dense(refs, LIMITS.artifacts) && new Set(refs).size === refs.length && refs.every(ref => id(ref) && ids.has(ref)), 'KEEPER_INVALID_REFERENCE');
      for (const ref of refs) referenced.add(ref); count += refs.length;
    }
    need(count > 0, 'KEEPER_INVALID_CONSUMER');
  }
  need(referenced.size === ids.size, 'KEEPER_ORPHAN_ARTIFACT');
  need(value.unknownConsumers.every(id) && new Set(value.unknownConsumers).size === value.unknownConsumers.length, 'KEEPER_INVALID_UNKNOWN_CONSUMERS');
  return value;
}
function verifyArtifact(artifact, bytes) {
  need(bytes.length === artifact.bytes && sha(bytes) === artifact.sha256, 'KEEPER_ARTIFACT_MISMATCH');
  if (artifact.kind === 'own-zip') {
    let proof; try { proof = inspectOwnZip(bytes); } catch { throw Error('KEEPER_ARCHIVE_INVALID'); }
    need(proof.crcVerified === true && same(proof.payload, artifact.payload), 'KEEPER_PAYLOAD_MISMATCH'); return proof.expectedUncompressedBytes;
  }
  return 0;
}
function summary(plan) { return { artifactCount: plan.artifacts.length, unknownConsumers: [...plan.unknownConsumers],
  retirePlanBlocked: plan.unknownConsumers.length > 0, retirementRequiresOwnerReview: true, retireActions: [],
  provenanceIndependentlyVerified: false, nativeInstallVerified: false, settingsVerified: false, runtimeVerified: false }; }
function loadPlan(manifestFile, manifestSHA256) {
  need(digest(manifestSHA256), 'KEEPER_MANIFEST_PIN_REQUIRED'); const observations = new Map();
  manifestFile = absolute(manifestFile); const raw = read(manifestFile, LIMITS.manifestBytes, observations);
  need(sha(raw) === manifestSHA256, 'KEEPER_MANIFEST_CHANGED'); const plan = contract(json(raw));
  const physical = new Set([observations.get(manifestFile).node]); let uncompressed = 0;
  for (const artifact of plan.artifacts) {
    const bytes = read(artifact.path, LIMITS.fileBytes, observations), proof = observations.get(absolute(artifact.path));
    need(!physical.has(proof.node), 'KEEPER_PHYSICAL_ALIAS'); physical.add(proof.node); uncompressed += verifyArtifact(artifact, bytes); need(uncompressed <= LIMITS.totalBytes, 'KEEPER_BYTE_LIMIT');
  }
  recheck(observations); return { raw, plan, observations, manifestFile, manifestSHA256 };
}
function copyMap(plan, manifestSHA256) { return { schema: 'keeper-copy-map/1', manifestSHA256,
  artifacts: plan.artifacts.map(a => ({ id: a.id, relativePath: `artifacts/artifact-${a.id}.bin`, bytes: a.bytes, sha256: a.sha256, kind: a.kind })) }; }
function directoryNames(folder, maximum) {
  const dir = fs.opendirSync(folder), names = [];
  try { let entry; while ((entry = dir.readSync())) { names.push(entry.name); need(names.length <= maximum, 'KEEPER_EXTRA_FILE'); } }
  finally { dir.closeSync(); } return names.sort();
}
function newFile(file, bytes, pins) {
  const directParents = parents(path.dirname(file)); checkParents(pins); const fd = fs.openSync(file, 'wx', 0o600); let identity;
  try { identity = node(fs.fstatSync(fd, { bigint: true })); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const observations = new Map(), result = read(file, Math.max(LIMITS.fileBytes, bytes.length), observations);
  need(node(ordinary(file)) === identity && result.equals(bytes), 'KEEPER_WRITE_CHANGED'); checkParents(pins); checkParents(directParents); return observations.get(absolute(file));
}
function safeError(error) { return Error(/^KEEPER_[A-Z_]+$/.test(error?.message || '') ? error.message : 'KEEPER_IO_FAILED'); }
function createAPI(outputRoot, portableTest = false) {
  outputRoot = absolute(outputRoot);
  function outputPath(value) {
    const out = absolute(value); need(within(outputRoot, out) && out !== outputRoot, 'KEEPER_OUTPUT_SCOPE'); parents(path.dirname(out));
    need(!exists(out), 'KEEPER_OUTPUT_EXISTS'); return out;
  }
  function verifyKeeperPlan(options) {
    need(exact(options, ['manifestFile', 'manifestSHA256']), 'KEEPER_INVALID_OPTIONS'); const loaded = loadPlan(options.manifestFile, options.manifestSHA256);
    return { schema: 'keeper-verification/1', manifestSHA256: loaded.manifestSHA256, ...summary(loaded.plan), effectsPerformed: false };
  }
  function keeperInput(options) {
    need(exact(options, ['keeper', 'proofSHA256']) && digest(options.proofSHA256), 'KEEPER_PROOF_PIN_REQUIRED');
    const keeper = absolute(options.keeper); need(within(outputRoot, keeper) && keeper !== outputRoot, 'KEEPER_OUTPUT_SCOPE');
    const pins = parents(keeper), observations = new Map();
    const proofRaw = read(path.join(keeper, 'KEEPER-PROOF.json'), LIMITS.manifestBytes, observations);
    need(sha(proofRaw) === options.proofSHA256, 'KEEPER_PROOF_CHANGED'); const proof = json(proofRaw);
    need(exact(proof, ['schema', 'manifestSHA256', 'copyMapSHA256', 'attemptSHA256', 'summary']) && proof.schema === 'keeper-proof/1'
      && [proof.manifestSHA256, proof.copyMapSHA256, proof.attemptSHA256].every(digest), 'KEEPER_INVALID_PROOF');
    const raw = read(path.join(keeper, 'retained-manifest.json'), LIMITS.manifestBytes, observations);
    need(sha(raw) === proof.manifestSHA256, 'KEEPER_MANIFEST_CHANGED'); const plan = contract(json(raw));
    const mapRaw = read(path.join(keeper, 'copy-map.json'), LIMITS.manifestBytes, observations), map = json(mapRaw);
    need(sha(mapRaw) === proof.copyMapSHA256 && same(map, copyMap(plan, proof.manifestSHA256)) && same(proof.summary, summary(plan)), 'KEEPER_COPY_MAP_CHANGED');
    const attemptRaw = read(path.join(keeper, 'ATTEMPT.json'), LIMITS.manifestBytes, observations);
    need(sha(attemptRaw) === proof.attemptSHA256, 'KEEPER_ATTEMPT_CHANGED'); const attempt = json(attemptRaw);
    need(exact(attempt, ['schema', 'manifestSHA256', 'mode']) && attempt.schema === 'keeper-attempt/1'
      && attempt.manifestSHA256 === proof.manifestSHA256 && ['create', 'restore'].includes(attempt.mode), 'KEEPER_INVALID_ATTEMPT');
    need(same(directoryNames(keeper, 6), ['ATTEMPT.json', 'KEEPER-PROOF.json', 'artifacts', 'copy-map.json', 'retained-manifest.json'].sort()), 'KEEPER_EXTRA_FILE');
    const names = plan.artifacts.map(a => `artifact-${a.id}.bin`).sort(), artifactDir = path.join(keeper, 'artifacts');
    const artifactPins = parents(artifactDir);
    need(same(directoryNames(artifactDir, LIMITS.artifacts), names), 'KEEPER_EXTRA_FILE'); const physical = new Set(); let uncompressed = 0;
    for (const artifact of plan.artifacts) {
      const file = path.join(artifactDir, `artifact-${artifact.id}.bin`), bytes = read(file, LIMITS.fileBytes, observations);
      const identity = observations.get(file).node; need(!physical.has(identity), 'KEEPER_PHYSICAL_ALIAS'); physical.add(identity); uncompressed += verifyArtifact(artifact, bytes); need(uncompressed <= LIMITS.totalBytes, 'KEEPER_BYTE_LIMIT');
    }
    checkParents(pins); checkParents(artifactPins); recheck(observations); return { keeper, raw, plan, observations, manifestSHA256: proof.manifestSHA256, proofSHA256: options.proofSHA256 };
  }
  function writeKeeper(loaded, output, mode, sourcePath) {
    const out = outputPath(output), sourcePaths = [...loaded.observations.keys()];
    need(sourcePaths.every(file => !within(out, file) && out !== path.dirname(file))
      && (!sourcePath || (!within(sourcePath, out) && !within(out, sourcePath))), 'KEEPER_OUTPUT_OVERLAP');
    need(process.platform === 'win32' || portableTest, 'KEEPER_UNSUPPORTED_WRITE_PLATFORM');
    const reservation = path.join(path.dirname(out), `.keeper-reservation-${sha(Buffer.from(process.platform === 'win32' ? out.toLowerCase() : out))}.json`);
    need(!exists(reservation), 'KEEPER_ATTEMPT_ALREADY_RESERVED');
    recheck(loaded.observations); const parentPins = parents(path.dirname(out)), owned = new Map();
    const nonce = crypto.randomBytes(16).toString('hex'), mapRaw = encode(copyMap(loaded.plan, loaded.manifestSHA256));
    const reserved = encode({ schema: 'keeper-reservation/1', target: out, nonce,
      manifestSHA256: loaded.manifestSHA256, copyMapSHA256: sha(mapRaw) });
    owned.set(reservation, newFile(reservation, reserved, parentPins));
    // An unpredictable private directory is owned before any packet is published.
    // Failures retain both this directory and the permanent target reservation.
    const temp = fs.mkdtempSync(path.join(path.dirname(out), `.keeper-${nonce}-`)), pins = parents(temp);
    checkParents(parentPins); const tempIdentity = node(ordinary(temp, true));
    const write = (relative, bytes) => { const file = path.join(temp, relative); owned.set(file, newFile(file, bytes, pins)); };
    const attempt = encode({ schema: 'keeper-attempt/1', manifestSHA256: loaded.manifestSHA256, mode });
    write('ATTEMPT.json', attempt); fs.mkdirSync(path.join(temp, 'artifacts'), { mode: 0o700 });
    const directoryPins = new Map([...pins, ...parents(path.join(temp, 'artifacts'))]);
    write('retained-manifest.json', loaded.raw);
    for (const artifact of loaded.plan.artifacts) {
      const file = sourcePath ? path.join(sourcePath, 'artifacts', `artifact-${artifact.id}.bin`) : artifact.path;
      const bytes = read(file); recheck(loaded.observations); verifyArtifact(artifact, bytes);
      checkParents(directoryPins); write(`artifacts/artifact-${artifact.id}.bin`, bytes);
    }
    write('copy-map.json', mapRaw); recheck(loaded.observations); checkParents(directoryPins);
    const proofRaw = encode({ schema: 'keeper-proof/1', manifestSHA256: loaded.manifestSHA256,
      copyMapSHA256: sha(mapRaw), attemptSHA256: sha(attempt), summary: summary(loaded.plan) });
    write('KEEPER-PROOF.json', proofRaw);
    const proofSHA256 = sha(proofRaw); keeperInput({ keeper: temp, proofSHA256 });
    recheck(loaded.observations); recheck(owned); checkParents(directoryPins);
    need(!exists(out), 'KEEPER_OUTPUT_EXISTS'); checkParents(parentPins);
    // Windows rename refuses an existing directory. Production writes on other
    // platforms are refused; portableTest is an internal fixture-only seam.
    fs.renameSync(temp, out);
    need(node(ordinary(out, true)) === tempIdentity, 'KEEPER_PUBLICATION_CHANGED');
    const moved = value => within(temp, value) ? path.join(out, path.relative(temp, value)) : value;
    const published = new Map([...owned].map(([file, proof]) => [moved(file), {
      ...proof, pins: new Map([...proof.pins].map(([dir, identity]) => [moved(dir), identity])),
    }]));
    keeperInput({ keeper: out, proofSHA256 }); recheck(published); recheck(loaded.observations); checkParents(parentPins);
    return { schema: 'keeper-result/1', keeper: out, proofSHA256, ...summary(loaded.plan), effectsPerformed: true };
  }

  const api = {
    verifyKeeperPlan,
    createKeeper(options) {
      need(exact(options, ['manifestFile', 'manifestSHA256', 'output']), 'KEEPER_INVALID_OPTIONS');
      const loaded = loadPlan(options.manifestFile, options.manifestSHA256); return writeKeeper(loaded, options.output, 'create');
    },
    verifyKeeper(options) { const loaded = keeperInput(options); return { schema: 'keeper-verification/1', ...summary(loaded.plan), proofSHA256: loaded.proofSHA256, effectsPerformed: false }; },
    restoreKeeper(options) {
      need(exact(options, ['keeper', 'proofSHA256', 'output']), 'KEEPER_INVALID_OPTIONS'); const loaded = keeperInput({ keeper: options.keeper, proofSHA256: options.proofSHA256 });
      return writeKeeper(loaded, options.output, 'restore', loaded.keeper);
    },
  };
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => { try { return fn(...args); } catch (error) { throw safeError(error); } }])));
}
const api = createAPI(scratch);
export const verifyKeeperPlan = api.verifyKeeperPlan, createKeeper = api.createKeeper, verifyKeeper = api.verifyKeeper, restoreKeeper = api.restoreKeeper;
// Private fixture seam; no CLI or production option accepts an output-root override.
export const _keeperForTests = outputRoot => createAPI(outputRoot, true);
export function main(args = process.argv.slice(2)) {
  try {
    const opts = {}; for (let n = 0; n < args.length; n += 2) { need(['--manifest', '--manifest-sha256', '--keeper', '--proof-sha256', '--output', '--mode'].includes(args[n]) && args[n + 1] && !Object.hasOwn(opts, args[n]), 'KEEPER_INVALID_ARGUMENTS'); opts[args[n]] = args[n + 1]; }
    const mode = opts['--mode'] ?? 'verify', allowed = mode === 'verify' ? ['--mode', '--manifest', '--manifest-sha256'] : mode === 'create' ? ['--mode', '--manifest', '--manifest-sha256', '--output']
      : mode === 'inspect' ? ['--mode', '--keeper', '--proof-sha256'] : mode === 'restore' ? ['--mode', '--keeper', '--proof-sha256', '--output'] : [];
    need(Object.keys(opts).every(k => allowed.includes(k)), 'KEEPER_INVALID_ARGUMENTS');
    const value = mode === 'verify' ? verifyKeeperPlan({ manifestFile: opts['--manifest'], manifestSHA256: opts['--manifest-sha256'] })
      : mode === 'create' ? createKeeper({ manifestFile: opts['--manifest'], manifestSHA256: opts['--manifest-sha256'], output: opts['--output'] })
      : mode === 'inspect' ? verifyKeeper({ keeper: opts['--keeper'], proofSHA256: opts['--proof-sha256'] })
      : restoreKeeper({ keeper: opts['--keeper'], proofSHA256: opts['--proof-sha256'], output: opts['--output'] });
    process.stdout.write(JSON.stringify(value) + '\n'); return 0;
  } catch (error) { process.stdout.write(JSON.stringify({ code: safeError(error).message }) + '\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
