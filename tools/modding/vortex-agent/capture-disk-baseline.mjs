import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import strictJSON from './strict-json.cjs';
import physicalProof from './physical-proof.cjs';

const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../local-state');
export const LIMITS = Object.freeze({inputBytes: 1024 * 1024, manifestBytes: 32 * 1024 * 1024,
  pairs: 50000, candidates: 4096, settings: 10000, directories: 20000, entries: 50000, depth: 32,
  fileBytes: 16 * 1024 ** 3, totalBytes: 128 * 1024 ** 3, chunkBytes: 1024 * 1024, freshnessMs: 120000});
const roots = ['gamePath', 'stagingPath', 'downloadPath'];
const extensions = Object.freeze(['.db', '.ini', '.json', '.sqlite3']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => {if (!value) throw Error(code);};
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const norm = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const node = stat => `${stat.dev}:${stat.ino}`;
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...keys].sort());
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value), 'DISK_BASELINE_INVALID_RELATIVE_PATH');
  const parts = value.split(/[\\/]/);
  need(parts.length <= 32 && parts.every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..'
    && !/[\x00-\x1f\x7f<>:"|?*]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)),
  'DISK_BASELINE_INVALID_RELATIVE_PATH');
  return parts;
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value), 'DISK_BASELINE_ABSOLUTE_PATH_REQUIRED');
  const root = path.parse(value).root;
  need(process.platform !== 'win32' || /^[a-z]:[\\/]$/i.test(root), 'DISK_BASELINE_LOCAL_DRIVE_REQUIRED');
  relative(value.slice(root.length).replace(/[\\/]$/, ''));
  return path.resolve(value);
}
const inside = (root, value) => norm(value).startsWith(norm(root) + '/');
function ancestry(file) {
  const list = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'DISK_BASELINE_REPARSE_OR_PARENT');
    list.push([dir, node(stat)]);
    if (dir === path.dirname(dir)) return list;
  }
}
function sampleFile(file, max = LIMITS.fileBytes) {
  const parents = ancestry(file), stat = fs.lstatSync(file, {bigint: true});
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size >= 0n && stat.size <= BigInt(max), 'DISK_BASELINE_FILE_REFUSED');
  return {file, stat, generation: stamp(stat), parents};
}
function checkParents(parents) {
  for (const [dir, id] of parents) {
    const stat = fs.lstatSync(dir, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink() && node(stat) === id, 'DISK_BASELINE_PARENT_CHANGED');
  }
}
function checkObservation(observation) {
  checkParents(observation.parents);
  need(stamp(fs.lstatSync(observation.file, {bigint: true})) === observation.generation, 'DISK_BASELINE_FILE_CHANGED');
}
function readStable(file, max) {
  const observation = sampleFile(file, max), fd = fs.openSync(file, 'r');
  try {
    need(stamp(fs.fstatSync(fd, {bigint: true})) === observation.generation, 'DISK_BASELINE_FD_CHANGED');
    const buffer = Buffer.alloc(Number(observation.stat.size) + 1); let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    need(length <= max && BigInt(length) === observation.stat.size
      && stamp(fs.fstatSync(fd, {bigint: true})) === observation.generation, 'DISK_BASELINE_FD_CHANGED');
    checkObservation(observation);
    return {bytes: Buffer.from(buffer.subarray(0, length)), observation};
  } finally {fs.closeSync(fd);}
}
function discoveryRoots(game) {
  return [path.join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods'), path.join(game, 'red4ext/plugins')];
}
const logLinkKeys = ['path','nodeId','bytes','links','mtimeNs','ctimeNs','linkTextSHA256','fileAttributes'];
function validateLogLinks(value, game) {
  need(Array.isArray(value) && value.length <= 3, 'DISK_BASELINE_INVALID_LOG_LINK');
  const allowed = ['ArchiveXL','Codeware','TweakXL'].map(name => norm(path.join(game, 'red4ext/plugins', name, name + '.log')));
  const seen = new Set();
  for (const row of value) {
    need(exact(row, logLinkKeys), 'DISK_BASELINE_INVALID_LOG_LINK');
    absolute(row.path); const key = norm(row.path);
    need(allowed.includes(key) && !seen.has(key), 'DISK_BASELINE_INVALID_LOG_LINK'); seen.add(key);
    need(typeof row.nodeId === 'string' && /^\d+:\d+$/.test(row.nodeId)
      && ['bytes','links','mtimeNs','ctimeNs'].every(k => typeof row[k] === 'string' && /^(?:0|[1-9]\d*)$/.test(row[k]))
      && row.links === '1' && digest(row.linkTextSHA256)
      && Number.isInteger(row.fileAttributes) && row.fileAttributes >= 0 && row.fileAttributes <= 0xffffffff
      && (row.fileAttributes & 0x400) !== 0 && (row.fileAttributes & 0x10) === 0, 'DISK_BASELINE_INVALID_LOG_LINK');
  }
  return [...value].sort((a,b) => norm(a.path) < norm(b.path) ? -1 : norm(a.path) > norm(b.path) ? 1 : 0);
}
function checkLogLink(row) {
  const parents = ancestry(row.path), before = fs.lstatSync(row.path, {bigint: true});
  need(before.isSymbolicLink() && !before.isDirectory() && node(before) === row.nodeId
    && String(before.size) === row.bytes && String(before.nlink) === row.links
    && String(before.mtimeNs) === row.mtimeNs && String(before.ctimeNs) === row.ctimeNs, 'DISK_BASELINE_LOG_LINK_CHANGED');
  const text = fs.readlinkSync(row.path, {encoding: 'buffer'});
  need(text.length <= 32768 && sha(text) === row.linkTextSHA256, 'DISK_BASELINE_LOG_LINK_CHANGED');
  checkParents(parents);
  need(stamp(fs.lstatSync(row.path, {bigint:true})) === stamp(before), 'DISK_BASELINE_LOG_LINK_CHANGED');
}
function discover(game, excludedLogLinks) {
  const directories = [], files = [], scanRoots = discoveryRoots(game), observedLinks = new Set(); let entries = 0;
  const admittedLinks = new Map(excludedLogLinks.map(row => [norm(row.path), row]));
  function walk(dir, depth) {
    need(depth <= LIMITS.depth && directories.length < LIMITS.directories, 'DISK_BASELINE_DISCOVERY_LIMIT');
    const parents = ancestry(path.join(dir, '__leaf__')), before = fs.lstatSync(dir, {bigint: true});
    need(before.isDirectory() && !before.isSymbolicLink(), 'DISK_BASELINE_REPARSE_OR_PARENT');
    const handle = fs.opendirSync(dir); const names = [], folded = new Set();
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        need(++entries <= LIMITS.entries, 'DISK_BASELINE_DISCOVERY_LIMIT');
        relative(entry.name); need(!folded.has(entry.name.toLowerCase()), 'DISK_BASELINE_DISCOVERY_ALIAS');
        folded.add(entry.name.toLowerCase()); names.push(entry.name);
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const row = admittedLinks.get(norm(full));
          need(row && !observedLinks.has(norm(full)), 'DISK_BASELINE_REPARSE_OR_PARENT');
          checkLogLink(row); observedLinks.add(norm(full)); continue;
        }
        need(!admittedLinks.has(norm(full)), 'DISK_BASELINE_LOG_LINK_CHANGED');
        if (entry.isDirectory()) walk(full, depth + 1);
        else {
          need(entry.isFile(), 'DISK_BASELINE_NONREGULAR_DISCOVERY');
          if (extensions.includes(path.extname(entry.name).toLowerCase())) files.push(full);
          need(files.length <= LIMITS.settings, 'DISK_BASELINE_SETTINGS_LIMIT');
        }
      }
    } finally {handle.closeSync();}
    checkParents(parents);
    need(stamp(fs.lstatSync(dir, {bigint: true})) === stamp(before), 'DISK_BASELINE_DISCOVERY_CHANGED');
    directories.push({dir, generation: stamp(before), parents, names: names.sort()});
  }
  for (const dir of scanRoots) walk(dir, 0);
  need(observedLinks.size === excludedLogLinks.length, 'DISK_BASELINE_LOG_LINK_CHANGED');
  for (const row of excludedLogLinks) checkLogLink(row);
  directories.sort((a, b) => norm(a.dir).localeCompare(norm(b.dir)));
  const normalized = files.map(norm).sort();
  need(new Set(normalized).size === normalized.length, 'DISK_BASELINE_DISCOVERY_ALIAS');
  return {files, directories, proof: {schema: 'read-capture-preference-discovery/1', roots: scanRoots, extensions: [...extensions], files: normalized, excludedLogLinks}};
}
function validateInput(value, at) {
  need(exact(value, ['schema','observedAtUTC','health','manifestSHA256','preferenceCandidates', ...(Object.hasOwn(value ?? {}, 'excludedLogLinks') ? ['excludedLogLinks'] : [])])
    && value.schema === 'read-capture-disk-input/1' && digest(value.manifestSHA256), 'DISK_BASELINE_INVALID_INPUT');
  const observed = typeof value.observedAtUTC === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value.observedAtUTC)
    ? Date.parse(value.observedAtUTC) : NaN;
  need(Number.isFinite(observed) && at - observed >= 0 && at - observed <= LIMITS.freshnessMs, 'DISK_BASELINE_INPUT_STALE');
  const h = value.health;
  need(exact(h, ['gameId','profileId',...roots,'filesystemIds']) && h.gameId === 'cyberpunk2077' && h.profileId === 'ptndev1016'
    && exact(h.filesystemIds, roots), 'DISK_BASELINE_INVALID_CONTEXT');
  for (const key of roots) {
    absolute(h[key]); need(typeof h.filesystemIds[key] === 'string' && /^\d+:\d+$/.test(h.filesystemIds[key]), 'DISK_BASELINE_INVALID_CONTEXT');
  }
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) {
    need(norm(h[roots[a]]) !== norm(h[roots[b]]) && !inside(h[roots[a]], h[roots[b]]) && !inside(h[roots[b]], h[roots[a]])
      && h.filesystemIds[roots[a]] !== h.filesystemIds[roots[b]], 'DISK_BASELINE_ROOT_ALIAS');
  }
  need(Array.isArray(value.preferenceCandidates) && value.preferenceCandidates.length > 0
    && value.preferenceCandidates.length <= LIMITS.candidates, 'DISK_BASELINE_INVALID_CANDIDATES');
  const local = process.env.LOCALAPPDATA;
  const known = typeof local === 'string' && path.isAbsolute(local) ? [
    path.join(local, 'CD Projekt Red/Cyberpunk 2077/UserSettings.json'), path.join(local, 'CleanInventory/sorting-v1.txt'),
  ].map(norm) : [];
  const seen = new Set();
  for (const candidate of value.preferenceCandidates) {
    absolute(candidate); const key = norm(candidate);
    need(!seen.has(key), 'DISK_BASELINE_DUPLICATE_CANDIDATE'); seen.add(key);
    need(inside(h.gamePath, candidate) || inside(h.stagingPath, candidate) || known.includes(key), 'DISK_BASELINE_PREFERENCE_SCOPE_REFUSED');
  }
  return h;
}
function rootPins(health) {
  return roots.map(key => {
    const file = path.resolve(health[key]), parents = ancestry(path.join(file, '__leaf__'));
    const stat = fs.lstatSync(file, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink() && node(stat) === health.filesystemIds[key], 'DISK_BASELINE_ROOT_CHANGED');
    return {file, generation: stamp(stat), parents};
  });
}
export function captureDiskBaseline({input, inputSHA256, output, apply = false}) {
  need(typeof apply === 'boolean' && digest(inputSHA256), 'DISK_BASELINE_INVALID_ARGUMENTS');
  input = absolute(input); const started = Date.now();
  if (output !== undefined) {
    output = absolute(output); need(inside(scratch, output), 'DISK_BASELINE_OUTPUT_SCOPE_REFUSED');
    ancestry(path.join(path.dirname(output), '__leaf__'));
    need(!fs.existsSync(output), 'DISK_BASELINE_NEW_OUTPUT_REQUIRED');
  }
  need(!apply || output !== undefined, 'DISK_BASELINE_OUTPUT_REQUIRED');
  const packet = readStable(input, LIMITS.inputBytes);
  need(sha(packet.bytes) === inputSHA256, 'DISK_BASELINE_INPUT_SHA_DIFFERS');
  const value = strictJSON.parseStrictJSON(packet.bytes), health = validateInput(value, started);
  if (output !== undefined) for (const key of roots) need(!inside(health[key], output) && !inside(output, health[key])
    && norm(output) !== norm(health[key]), 'DISK_BASELINE_OUTPUT_ROOT_OVERLAP');
  const observedRoots = rootPins(health), manifestPath = path.join(health.gamePath, 'vortex.deployment.json');
  const manifest = readStable(manifestPath, LIMITS.manifestBytes);
  need(sha(manifest.bytes) === value.manifestSHA256, 'DISK_BASELINE_MANIFEST_SHA_DIFFERS');
  const deployment = strictJSON.parseStrictJSON(manifest.bytes, {maxBytes: LIMITS.manifestBytes, maxTokens: 2000000});
  need(deployment.gameId === health.gameId && deployment.deploymentMethod === 'hardlink_activator' && typeof deployment.targetPath === 'string'
    && typeof deployment.stagingPath === 'string' && norm(deployment.targetPath) === norm(health.gamePath)
    && norm(deployment.stagingPath) === norm(health.stagingPath) && Array.isArray(deployment.files)
    && deployment.files.length > 0 && deployment.files.length <= LIMITS.pairs, 'DISK_BASELINE_MANIFEST_REFUSED');
  const observations = new Map([[input, packet.observation], [manifestPath, manifest.observation]]), unique = new Map();
  const register = file => {
    const current = sampleFile(file); const old = observations.get(file);
    if (old) need(old.generation === current.generation, 'DISK_BASELINE_FILE_CHANGED');
    observations.set(file, current);
    const key = node(current.stat), previous = unique.get(key);
    need(!previous || previous.generation === current.generation, 'DISK_BASELINE_FILE_CHANGED');
    if (!previous) unique.set(key, current);
    return current;
  };
  const pairs = [], destinations = new Set();
  for (const row of deployment.files) {
    need(row && (row.target === undefined || row.target === ''), 'DISK_BASELINE_CUSTOM_TARGET_REFUSED');
    const rel = relative(row.relPath), source = relative(row.source);
    const game = path.join(health.gamePath, ...rel), stage = path.join(health.stagingPath, ...source, ...rel);
    need(!destinations.has(norm(game)), 'DISK_BASELINE_DUPLICATE_MANIFEST_PATH'); destinations.add(norm(game));
    const a = register(game), b = register(stage);
    need(a.generation === b.generation && a.stat.nlink >= 2n, 'DISK_BASELINE_NOT_EXPECTED_HARDLINK');
    pairs.push({game, stage});
  }
  const excludedLogLinks = validateLogLinks(Object.hasOwn(value, 'excludedLogLinks') ? value.excludedLogLinks : [], health.gamePath);
  const initial = discover(health.gamePath, excludedLogLinks), settings = new Map();
  for (const file of [...value.preferenceCandidates, ...initial.files]) if (!settings.has(norm(file))) {
    need(settings.size < LIMITS.settings, 'DISK_BASELINE_SETTINGS_LIMIT'); settings.set(norm(file), path.resolve(file)); register(path.resolve(file));
  }
  const plannedBytes = [...unique.values()].reduce((sum, observation) => sum + Number(observation.stat.size), 0);
  need(plannedBytes <= LIMITS.totalBytes, 'DISK_BASELINE_TOTAL_LIMIT');
  const assertCurrent = () => {
    for (const root of observedRoots) checkObservation(root);
    for (const observation of observations.values()) checkObservation(observation);
    const final = discover(health.gamePath, excludedLogLinks);
    need(same(initial.proof, final.proof), 'DISK_BASELINE_DISCOVERY_CHANGED');
    need(same(initial.directories.map(d => [norm(d.dir), d.generation, d.names]), final.directories.map(d => [norm(d.dir), d.generation, d.names])), 'DISK_BASELINE_DISCOVERY_CHANGED');
    for (const observation of observations.values()) checkObservation(observation);
    for (const root of observedRoots) checkObservation(root);
  };
  const summary = {status: apply ? 'captured' : 'plan', manifestPairs: pairs.length, settings: settings.size,
    uniquePhysicalFiles: unique.size, plannedBytesHashed: plannedBytes, output: output ?? null,
    nativeContextVerified: false, sourceAdmissionVerified: false, effectsAllowed: false, noManagedWrites: true};
  if (!apply) {assertCurrent(); return summary;}
  const physical = physicalProof.createPhysicalReader({fs, hash: file => {
    const expected = sampleFile(file), fd = fs.openSync(file, 'r');
    try {
      need(stamp(fs.fstatSync(fd, {bigint: true})) === expected.generation, 'DISK_BASELINE_FD_CHANGED');
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(LIMITS.chunkBytes); let bytes = 0;
      for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0;) {
        bytes += n; need(bytes <= LIMITS.fileBytes && bytes <= Number(expected.stat.size), 'DISK_BASELINE_FD_CHANGED'); hash.update(buffer.subarray(0, n));
      }
      need(BigInt(bytes) === expected.stat.size && stamp(fs.fstatSync(fd, {bigint: true})) === expected.generation, 'DISK_BASELINE_FD_CHANGED');
      checkObservation(expected); return hash.digest('hex');
    } finally {fs.closeSync(fd);}
  }});
  const project = file => {const proof = physical(file); return {...proof, bytes: Number(proof.bytes)};};
  const records = pairs.map(({game, stage}) => {
    const a = project(game), b = project(stage);
    need(same(a, b) && a.links >= 2, 'DISK_BASELINE_NOT_EXPECTED_HARDLINK'); return {game, stage, ...a};
  });
  const preferences = [...settings.values()].sort((a, b) => norm(a).localeCompare(norm(b))).map(file => ({path: file, ...project(file)}));
  assertCurrent();
  const reread = readStable(manifestPath, LIMITS.manifestBytes);
  need(sha(reread.bytes) === value.manifestSHA256, 'DISK_BASELINE_MANIFEST_SHA_DIFFERS');
  const ledger = {schema: 'root-current-physical-ledger/1', atUTC: new Date().toISOString(), manifestSHA256: value.manifestSHA256,
    records, settings: preferences, preferenceDiscovery: initial.proof, physicalProofMetrics: physical.metrics(),
    sourceProof: input, sourceProofSHA256: inputSHA256, observedAtUTC: value.observedAtUTC,
    nativeContextVerified: false, sourceAdmissionVerified: false, effectsAllowed: false, noManagedWrites: true};
  const bytes = Buffer.from(canonical(ledger)); need(bytes.length <= 64 * 1024 * 1024, 'DISK_BASELINE_OUTPUT_LIMIT');
  assertCurrent();
  const parents = ancestry(path.join(path.dirname(output), '__leaf__'));
  fs.mkdirSync(output); const created = fs.lstatSync(output, {bigint: true}), outputNode = node(created);
  need(created.isDirectory() && !created.isSymbolicLink(), 'DISK_BASELINE_OUTPUT_CHANGED');
  checkParents(parents); const file = path.join(output, 'ROOT-DISK-BEFORE.json'), outputParents = ancestry(file);
  need(outputParents[0][1] === outputNode, 'DISK_BASELINE_OUTPUT_CHANGED');
  const fd = fs.openSync(file, 'wx'); let writtenNode;
  try {
    checkParents(outputParents);
    const first = fs.fstatSync(fd, {bigint: true});
    need(first.isFile() && first.nlink === 1n, 'DISK_BASELINE_OUTPUT_CHANGED');
    writtenNode = node(first);
    fs.writeFileSync(fd, bytes);
    const last = fs.fstatSync(fd, {bigint: true});
    need(last.nlink === 1n && node(last) === node(first) && last.size === BigInt(bytes.length), 'DISK_BASELINE_OUTPUT_CHANGED');
  } finally {fs.closeSync(fd);}
  checkParents(parents); checkParents(outputParents);
  const written = readStable(file, 64 * 1024 * 1024);
  need(written.bytes.equals(bytes) && node(written.observation.stat) === writtenNode
    && written.observation.stat.nlink === 1n, 'DISK_BASELINE_OUTPUT_CHANGED');
  assertCurrent();
  checkParents(outputParents); checkObservation(written.observation);
  return {...summary, file, sha256: sha(bytes), physicalProofMetrics: physical.metrics()};
}
export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--apply' && options.apply === undefined) options.apply = true;
    else if (['--input','--input-sha256','--output'].includes(name) && options[name] === undefined && args[index + 1]) options[name] = args[++index];
    else throw Error('DISK_BASELINE_INVALID_ARGUMENTS');
  }
  return captureDiskBaseline({input: options['--input'], inputSHA256: options['--input-sha256'], output: options['--output'], apply: options.apply === true});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(JSON.stringify(main()) + '\n');}
  catch (error) {process.stderr.write((/^DISK_BASELINE_[A-Z_]+$/.test(error.message) ? error.message : 'DISK_BASELINE_CAPTURE_FAILED') + '\n'); process.exitCode = 1;}
}
