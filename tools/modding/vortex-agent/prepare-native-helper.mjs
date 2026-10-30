import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWorkerTemplate, workerGuardSource, WORKER_MODULES } from './prepare-source-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinary = file => {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw Error('HELPER_REPARSE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (p === path.dirname(p)) break;
  }
};
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('HELPER_ABSOLUTE_PATH_REQUIRED');
  const p = path.resolve(value); ordinary(p);
  if (/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(p)) throw Error('ACTIVE_HELPER_PATH_REFUSED');
  return p;
}
function replaceOnce(source, old, replacement) {
  if (source.split(old).length !== 2) throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  return source.replace(old, replacement);
}
function awaitedGuardCallers(source) {
  const changes = [
    ["guard:()=>{const v=runner.current();guard({...v,accepted:acceptedSnapshot});}",
      "guard:()=>{const v=runner.current();return guard({...v,accepted:acceptedSnapshot});}"],
    ["check:()=>{const current=runner.current();if(current.active)guard({...current,accepted:acceptedSnapshot});}",
      "check:()=>{const current=runner.current();if(current.active)return guard({...current,accepted:acceptedSnapshot});}"],
    ["try{guard();need(hash(c.admissionFile)", "try{const guardResult=guard();if(guardResult&&typeof guardResult.then==='function')await guardResult;need(hash(c.admissionFile)"],
    ["'ROOT_READY_TIMEOUT_NO_EFFECTS');guard();await", "'ROOT_READY_TIMEOUT_NO_EFFECTS');const guardResult=guard();if(guardResult&&typeof guardResult.then==='function')await guardResult;await"],
    ["const final=guard({phase:'verify',accepted});", "const finalGuard=guard({phase:'verify',accepted});const final=finalGuard&&typeof finalGuard.then==='function'?await finalGuard:finalGuard;"],
  ];
  // Conditional awaits retain the current synchronous guard-to-consumer boundary.
  // Awaiting an ordinary value would add an otherwise absent microtask gap.
  // Non-lifecycle test inputs have none of these callers. Real lifecycle inputs
  // must match the entire reviewed group; a partial adaptation is refused.
  if (!changes.some(([before]) => source.includes(before)) && !/function guard\s*\(/.test(source)) return source;
  for (const [before, after] of changes) source = replaceOnce(source, before, after);
  return source;
}
function contains(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
const files = ['install-settlement.cjs', 'native-install-wait.cjs', 'physical-proof.cjs', 'local-import-readiness.cjs', 'payload-size-proof.cjs'];
const workerFiles = WORKER_MODULES;
const mode = value => {if (!['cached-sync', 'worker'].includes(value)) throw Error('INVALID_SOURCE_PROOF_MODE'); return value;};
const workerMaintained = new Map(workerFiles.map(name => [name, fs.readFileSync(path.join(here, name))]));
const alias = Buffer.from("'use strict';\nmodule.exports = require('./native-install-wait.cjs');\n");
// Trusted repository inputs are captured once; the content constructor performs
// no filesystem access and accepts no runtime-module overrides.
const maintained = new Map(files.map(name => [name, fs.readFileSync(path.join(here, name))]));
const maintainedTests = new Map(Object.entries({ 'test-settlement.cjs': 'native-install-wait.test.cjs',
  'test-install-settlement.cjs': 'install-settlement.test.cjs', 'test-physical-proof.cjs': 'physical-proof.test.cjs' })
  .map(([target, owner]) => [target, fs.readFileSync(path.join(here, owner))]));
function packageScope(index, engine, config) {
  const entry = [...index.toString('utf8').matchAll(/c\.packages\[0\]\.key==='([A-Za-z0-9_.-]{1,200})'&&c\.packages\[0\]\.sha256==='([a-f0-9]{64})'&&c\.packages\[0\]\.bytes===(\d+)/g)];
  const runner = [...engine.toString('utf8').matchAll(/o\.packages\[0\]\.key==='([A-Za-z0-9_.-]{1,200})'&&o\.packages\[0\]\.sha256==='([a-f0-9]{64})'/g)];
  if (entry.length !== 1 || runner.length !== 1) throw Error('UNSUPPORTED_HELPER_SCOPE_TEMPLATE');
  const pkg = Array.isArray(config.packages) && config.packages.length === 1 ? config.packages[0] : null;
  if (!pkg || pkg.key !== entry[0][1] || pkg.sha256 !== entry[0][2]
      || !Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0 || pkg.bytes !== Number(entry[0][3])
      || pkg.key !== runner[0][1] || pkg.sha256 !== runner[0][2])
    throw Error('HELPER_PACKAGE_SCOPE_DIFFERS');
}

export function createHelperContents({ input, config, modules, tests = new Map(), info, output, sourceSha256, sourceProofMode = 'cached-sync' }) {
  mode(sourceProofMode);
  if (sourceProofMode === 'cached-sync' && config?.sourceProofMode === 'worker') throw Error('HELPER_SOURCE_PROOF_MODE_DIFFERS');
  if (!Buffer.isBuffer(input) || !config || typeof config !== 'object'
      || !(modules instanceof Map) || !(tests instanceof Map)
      || typeof output !== 'string' || !path.isAbsolute(output))
    throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
  if (/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(output)) throw Error('ACTIVE_HELPER_PATH_REFUSED');
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '') || sha(input) !== sourceSha256) throw Error('HELPER_SOURCE_PIN_MISMATCH');
  for (const root of ['gamePath', 'stagingPath', 'downloadPath'].map(key => config.health?.[key]))
    if (typeof root === 'string' && path.isAbsolute(root) && contains(root, output)) throw Error('MANAGED_OUTPUT_PATH_REFUSED');
  if (config.activationApproved !== false || config.activationHold !== true
      || config.freshActualBaselineBound !== false || config.noEffects !== true
      || config.health?.gameId !== 'cyberpunk2077' || config.packages?.length !== 1
      || config.packages[0].expectedEnabled !== false || config.packages[0].oldEnabledModIds?.length !== 0
      || config.packages[0].expectedType !== undefined && config.packages[0].expectedType !== '')
    throw Error('HELD_SINGLE_DISABLED_CYBERPUNK_TEMPLATE_REQUIRED');
  const content = new Map();
  if (!config.modulePins || !Object.keys(config.modulePins).length || Object.keys(config.modulePins).length > 64)
    throw Error('INVALID_HELPER_MODULE_PINS');
  if (JSON.stringify([...modules.keys()].sort()) !== JSON.stringify(Object.keys(config.modulePins).sort()))
    throw Error('HELPER_MODULE_PIN_MISMATCH');
  for (const [name, pin] of Object.entries(config.modulePins)) {
    if (!/^[a-z0-9-]+\.cjs$/.test(name) || !/^[a-f0-9]{64}$/.test(pin)) throw Error('INVALID_HELPER_MODULE_PINS');
    const bytes = modules.get(name);
    if (!Buffer.isBuffer(bytes) || sha(bytes) !== pin) throw Error('HELPER_MODULE_PIN_MISMATCH');
    content.set(name, bytes);
  }
  if (!['engine.cjs', 'settlement.cjs', 'local-import-readiness.cjs'].every(n => content.has(n)))
    throw Error('HELPER_REQUIRED_MODULE_MISSING');
  packageScope(input, content.get('engine.cjs'), config);
  if (sourceProofMode === 'worker') assertWorkerTemplate(input, content.get('engine.cjs'));
  let index = input.toString('utf8');
  // Deliberately support the known reviewed template, not arbitrary task code.
  index = replaceOnce(index, "now:Date.now,pkg,expectedSize:size,pollMs:1000",
    "now:Date.now,pkg,expectedSize:size,sizeSource:'verified-payload',expectedDownloadId:id,expectedType:'',record:event=>record(pkg.key+'-settlement-'+(++sequence),event),pollMs:1000");
  index = replaceOnce(index, 'return{record:s.persistent.mods[c.health.gameId][pkg.expectedModId],flags:',
    "return{verifiedPayloadBytes:require('./payload-size-proof.cjs').verifiedPayloadBytes(tree(root),pkg.payload),record:s.persistent.mods[c.health.gameId][pkg.expectedModId],flags:");
  const physical = / function physical\(p\)\{[^\r\n]+\}/g;
  const matches = [...index.matchAll(physical)];
  if (matches.length !== 1 || !matches[0][0].includes('prior=cache.get(p)') || !index.includes('sequence=0'))
    throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  index = index.replace(physical, " const physical=require('./physical-proof.cjs').createPhysicalReader({fs,hash,cache});");
  const tree = / function tree\(root\)\{[^\r\n]+\}/g;
  if ([...index.matchAll(tree)].length !== 1) throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  index = index.replace(tree, match => replaceOnce(replaceOnce(match,
    'function tree(root)', 'function tree(root,reader=physical)'), ']=physical(p);', ']=reader(p);'));
  index = replaceOnce(index,
    "cache.clear();const again=tree(root);need(canonical(again)===canonical(files),'OWN_PAYLOAD_CHANGED_DURING_SETTLE');record(pkg.key+'-payload-proof',{ownerId:pkg.expectedModId,downloadId:id,files:again,disabled:true});",
    "const freshPayloadProof=require('./physical-proof.cjs').createPhysicalReader({fs,hash});const again=tree(root,freshPayloadProof);need(canonical(again)===canonical(files),'OWN_PAYLOAD_CHANGED_DURING_SETTLE');record(pkg.key+'-payload-proof',{ownerId:pkg.expectedModId,downloadId:id,files:again,disabled:true,freshPayloadProof:freshPayloadProof.metrics()});");
  const asar = /need\(hash\(c\.appAsar\)===c\.appAsarSHA256&&c\.appAsarSHA256==='([a-f0-9]{64})','APP_ASAR_CHANGED'\);/g;
  const asars = [...index.matchAll(asar)];
  if (asars.length !== 1) throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  index = index.replace(asar, `need(c.sourcePins?.[c.appAsar]===c.appAsarSHA256&&c.appAsarSHA256==='${asars[0][1]}','APP_ASAR_PIN_REQUIRED');`);
  index = replaceOnce(index, "for(const[p,h]of Object.entries(c.sourcePins))need(hash(p)===h,'SOURCE_CHANGED')",
    "for(const[p,h]of Object.entries(c.sourcePins))need(physical(p).sha256===h,'SOURCE_CHANGED')");
  index = replaceOnce(index, "record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics})",
    "record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics,physicalProof:physical.metrics()})");
  index = awaitedGuardCallers(index);
  if (sourceProofMode === 'worker') {
    index = workerGuardSource(index);
    for (const [name, bytes] of workerMaintained) content.set(name, Buffer.from(bytes));
  }
  content.set('index.prepared.js', Buffer.from(index));
  for (const [name, bytes] of maintained) content.set(name, Buffer.from(bytes));
  content.set('settlement.cjs', Buffer.from(alias));
  const held = { ...config, control: output, pluginPath: null, health: null,
    packages: [{ ...config.packages[0], expectedType: '' }],
    modulePins: Object.fromEntries([...content].filter(([n]) => n.endsWith('.cjs')).map(([n, b]) => [n, sha(b)])),
    activationApproved: false, activationHold: true, freshActualBaselineBound: false, noEffects: true,
    requiredFreshInputs: ['package/source review', 'health/context/filesystem pins', 'baseline',
      'source admission', 'source/module pins', 'root effect approval'],
  };
  if (sourceProofMode === 'worker') {
    held.sourceProofMode = 'worker'; held.sourceProof = null;
    held.requiredFreshInputs.push('exact source-proof roots/rows/epoch/host generation');
  }
  content.set('reviewed.prepared.json', Buffer.from(JSON.stringify(held, null, 2) + '\n'));
  // Keep task-specific regressions as review inputs; never execute copied code.
  for (const [name, bytes] of tests) {
    if (!/^test-[a-z0-9-]+\.cjs$/.test(name) || !Buffer.isBuffer(bytes)) throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
    content.set(name, bytes);
  }
  for (const [name, bytes] of maintainedTests) content.set(name, Buffer.from(bytes));
  if (info !== undefined) {
    if (!Buffer.isBuffer(info)) throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
    content.set('info.prepared.json', info);
  }
  const contract = { schema: 'native-helper-kit/1', sourceSha256,
    files: Object.fromEntries([...content].map(([n, b]) => [n, sha(b)])),
    reviewRequired: true, activationGranted: false, nativeEffects: false };
  if (sourceProofMode === 'worker') contract.sourceProofMode = 'worker';
  content.set('HELPER-KIT.json', Buffer.from(JSON.stringify(contract, null, 2) + '\n'));
  return content;
}

export function prepareHelper({ source, output, sourceSha256, apply = false, sourceProofMode = 'cached-sync' }) {
  mode(sourceProofMode);
  if (typeof apply !== 'boolean') throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
  source = directory(source); output = directory(output);
  if (contains(source, output)) throw Error('HELPER_OUTPUT_INSIDE_SOURCE');
  if (fs.existsSync(output)) throw Error('HELPER_OUTPUT_EXISTS');
  const names = fs.readdirSync(source);
  if (names.some(n => /^(?:reviewed\.json|attempt\.json|failed\.json|completed\.json|HOST-)/.test(n)))
    throw Error('MATERIALIZED_OR_ATTEMPTED_HELPER_REFUSED');
  const read = name => { const p = path.join(source, name); ordinary(p); return fs.readFileSync(p); };
  const input = read('index.prepared.js');
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '') || sha(input) !== sourceSha256) throw Error('HELPER_SOURCE_PIN_MISMATCH');
  const config = JSON.parse(read('reviewed.prepared.json'));
  if (!config.modulePins || !Object.keys(config.modulePins).length || Object.keys(config.modulePins).length > 64)
    throw Error('INVALID_HELPER_MODULE_PINS');
  const modules = new Map();
  for (const [name, pin] of Object.entries(config.modulePins)) {
    if (!/^[a-z0-9-]+\.cjs$/.test(name) || !/^[a-f0-9]{64}$/.test(pin)) throw Error('INVALID_HELPER_MODULE_PINS');
    modules.set(name, read(name));
  }
  const tests = new Map(names.filter(n => /^test-[a-z0-9-]+\.cjs$/.test(n)).map(name => [name, read(name)]));
  const content = createHelperContents({ input, config, modules, tests,
    info: names.includes('info.prepared.json') ? read('info.prepared.json') : undefined, output, sourceSha256, sourceProofMode });
  if (apply) {
    if (sourceProofMode === 'worker') {
      // Constructor buffers are import-time snapshots. A worker kit must never
      // silently publish those snapshots after the maintained owners drift.
      for (const name of [...files, ...workerFiles]) {
        const owner = path.join(here, name); ordinary(owner);
        if (!fs.lstatSync(owner).isFile() || sha(fs.readFileSync(owner)) !== sha(content.get(name)))
          throw Error('STALE_HELPER_KIT');
      }
    }
    ordinary(output);
    fs.mkdirSync(output);
    for (const [name, bytes] of content) {
      const file = path.join(output, name); ordinary(file);
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
    // A failed final readback deliberately leaves this new held output for
    // inspection. It is never overwritten, retried or activated here.
    if (sourceProofMode === 'worker') verifyHelper(output);
  }
  return { status: apply ? 'prepared-held' : 'plan', output, fileCount: content.size,
    reviewRequired: true, activationGranted: false, nativeEffects: false };
}

export function verifyHelper(value, { materialization = false } = {}) {
  const dir = directory(value), manifestPath = path.join(dir, 'HELPER-KIT.json'); ordinary(manifestPath);
  if (!fs.existsSync(manifestPath)) throw Error('HELPER_KIT_REQUIRED');
  const contract = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (contract.schema !== 'native-helper-kit/1' || contract.activationGranted !== false
      || contract.nativeEffects !== false || contract.reviewRequired !== true
      || !/^[a-f0-9]{64}$/.test(contract.sourceSha256 || '')
      || !contract.files || Array.isArray(contract.files) || Object.keys(contract.files).length > 128
      || ![...files, 'settlement.cjs', 'engine.cjs', 'index.prepared.js', 'reviewed.prepared.json']
        .every(name => Object.hasOwn(contract.files, name)))
    throw Error('INVALID_HELPER_KIT');
  const workerMode = contract.sourceProofMode === 'worker';
  if (contract.sourceProofMode !== undefined && !workerMode) throw Error('INVALID_SOURCE_PROOF_MODE');
  if (workerMode && !workerFiles.every(name => Object.hasOwn(contract.files, name))) throw Error('INVALID_HELPER_KIT');
  const checkedFiles = new Map();
  for (const [name, pin] of Object.entries(contract.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || ['.', '..'].includes(name)
      || !/^[a-f0-9]{64}$/.test(pin)) throw Error('INVALID_HELPER_KIT');
    const file = path.join(dir, name); ordinary(file);
    const bytes = fs.readFileSync(file);
    // Binding legitimately changes the held config. Runtime code may not drift.
    if (name !== 'reviewed.prepared.json' && sha(bytes) !== pin) throw Error('HELPER_KIT_DRIFT');
    checkedFiles.set(name, bytes);
  }
  for (const name of [...files, ...(workerMode ? workerFiles : [])]) {
    if (contract.files[name] !== sha(fs.readFileSync(path.join(here, name)))) throw Error('STALE_HELPER_KIT');
  }
  if (contract.files['settlement.cjs'] !== sha(alias))
    throw Error('STALE_HELPER_KIT');
  const runtime = Object.entries(contract.files).filter(([n]) => n.endsWith('.cjs') && !n.startsWith('test-'));
  const index = checkedFiles.get('index.prepared.js'), engine = checkedFiles.get('engine.cjs');
  for (const name of ['reviewed.prepared.json', 'reviewed.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    ordinary(file);
    const config = JSON.parse(checkedFiles.get(name) ?? fs.readFileSync(file));
    if (!config.modulePins || JSON.stringify(Object.keys(config.modulePins).sort()) !== JSON.stringify(runtime.map(([n]) => n).sort())
      || runtime.some(([n, h]) => config.modulePins[n] !== h)) throw Error('HELPER_BINDING_MODULE_PINS_DIFFER');
    if (name === 'reviewed.json' && config.helperSHA256 !== contract.files['index.prepared.js'])
      throw Error('HELPER_BINDING_ENTRY_PIN_DIFFERS');
    if (workerMode !== (config.sourceProofMode === 'worker')
        || !workerMode && config.sourceProofMode !== undefined && config.sourceProofMode !== 'cached-sync')
      throw Error('HELPER_SOURCE_PROOF_MODE_DIFFERS');
    if (workerMode && name === 'reviewed.prepared.json' && config.sourceProof !== null)
      throw Error('HELD_SOURCE_PROOF_BINDINGS_REQUIRED');
    if (workerMode !== index.toString('utf8').includes("function startSourceProof()")) throw Error('HELPER_SOURCE_PROOF_MODE_DIFFERS');
    packageScope(index, engine, config);
  }
  if (materialization) {
    const readyFile = path.join(dir, 'READY.prepared.json'); ordinary(readyFile);
    const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    const expected = new Map([['index.js', 'index.prepared.js'], ['info.json', 'info.prepared.json'],
      ['reviewed.json', 'reviewed.json'], ...runtime.map(([n]) => [n, n])]);
    const rows = ready.filesToCopy;
    if (!Array.isArray(rows) || rows.length !== expected.size || ready.runtimeModules !== runtime.length)
      throw Error('HELPER_COPY_MAP_INCOMPLETE');
    const seen = new Set();
    for (const row of rows) {
      if (!row || seen.has(row.destination) || expected.get(row.destination) !== row.source)
        throw Error('HELPER_COPY_MAP_DIFFERS');
      seen.add(row.destination);
      if (row.source === 'reviewed.json' && row.sha256 === null) continue; // The root materializer creates/pins it.
      const file = path.join(dir, row.source); ordinary(file);
      if (sha(fs.readFileSync(file)) !== row.sha256) throw Error('HELPER_COPY_MAP_PIN_DIFFERS');
    }
  }
  return { status: 'code-contract-verified', materializationMappingVerified: materialization,
    activationGranted: false, nativeEffects: false };
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === 'verify' && (args.length === 2 || args.length === 3 && args[2] === '--materialization'))
    return verifyHelper(args[1], { materialization: args.length === 3 });
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--apply' && !values.apply) values.apply = true;
    else if (['--source', '--output', '--source-sha256', '--source-proof-mode'].includes(name) && !values[name] && args[i + 1]) values[name] = args[++i];
    else throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
  }
  return prepareHelper({ source: values['--source'], output: values['--output'],
    sourceSha256: values['--source-sha256'], sourceProofMode: values['--source-proof-mode'] ?? 'cached-sync', apply: values.apply === true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main()) + '\n'); }
  catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : 'HELPER_PREPARATION_FAILED') + '\n'); process.exitCode = 1; }
}
