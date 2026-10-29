import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
function contains(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
const files = ['install-settlement.cjs', 'native-install-wait.cjs', 'physical-proof.cjs', 'local-import-readiness.cjs'];
const alias = Buffer.from("'use strict';\nmodule.exports = require('./native-install-wait.cjs');\n");

export function prepareHelper({ source, output, sourceSha256, apply = false }) {
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
  for (const [name, pin] of Object.entries(config.modulePins)) {
    if (!/^[a-z0-9-]+\.cjs$/.test(name) || !/^[a-f0-9]{64}$/.test(pin)) throw Error('INVALID_HELPER_MODULE_PINS');
    const bytes = read(name);
    if (sha(bytes) !== pin) throw Error('HELPER_MODULE_PIN_MISMATCH');
    content.set(name, bytes);
  }
  if (!['engine.cjs', 'settlement.cjs', 'local-import-readiness.cjs'].every(n => content.has(n)))
    throw Error('HELPER_REQUIRED_MODULE_MISSING');
  let index = input.toString('utf8');
  // Deliberately support the known reviewed template, not arbitrary task code.
  index = replaceOnce(index, "now:Date.now,pkg,expectedSize:size,pollMs:1000",
    "now:Date.now,pkg,expectedSize:size,expectedDownloadId:id,expectedType:'',record:event=>record(pkg.key+'-settlement-'+(++sequence),event),pollMs:1000");
  const physical = / function physical\(p\)\{[^\r\n]+\}/g;
  const matches = [...index.matchAll(physical)];
  if (matches.length !== 1 || !matches[0][0].includes('prior=cache.get(p)') || !index.includes('sequence=0'))
    throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  index = index.replace(physical, " const physical=require('./physical-proof.cjs').createPhysicalReader({fs,hash,cache});");
  const asar = /need\(hash\(c\.appAsar\)===c\.appAsarSHA256&&c\.appAsarSHA256==='([a-f0-9]{64})','APP_ASAR_CHANGED'\);/g;
  const asars = [...index.matchAll(asar)];
  if (asars.length !== 1) throw Error('UNSUPPORTED_HELPER_TEMPLATE');
  index = index.replace(asar, `need(c.sourcePins?.[c.appAsar]===c.appAsarSHA256&&c.appAsarSHA256==='${asars[0][1]}','APP_ASAR_PIN_REQUIRED');`);
  if (!index.includes("for(const[p,h]of Object.entries(c.sourcePins))need(hash(p)===h,'SOURCE_CHANGED')"))
    throw Error('SOURCE_PIN_VERIFIER_REQUIRED');
  index = replaceOnce(index, "record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics})",
    "record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics,physicalProof:physical.metrics()})");
  content.set('index.prepared.js', Buffer.from(index));
  for (const name of files) content.set(name, fs.readFileSync(path.join(here, name)));
  content.set('settlement.cjs', alias);
  const held = { ...config, control: output, pluginPath: null, health: null,
    packages: [{ ...config.packages[0], expectedType: '' }],
    modulePins: Object.fromEntries([...content].filter(([n]) => n.endsWith('.cjs')).map(([n, b]) => [n, sha(b)])),
    activationApproved: false, activationHold: true, freshActualBaselineBound: false, noEffects: true,
    requiredFreshInputs: ['package/source review', 'health/context/filesystem pins', 'baseline',
      'source admission', 'source/module pins', 'root effect approval'],
  };
  content.set('reviewed.prepared.json', Buffer.from(JSON.stringify(held, null, 2) + '\n'));
  // Keep task-specific regressions as review inputs; never execute copied code.
  for (const name of names.filter(n => /^test-[a-z0-9-]+\.cjs$/.test(n))) content.set(name, read(name));
  for (const [target, owner] of Object.entries({ 'test-settlement.cjs': 'native-install-wait.test.cjs',
    'test-install-settlement.cjs': 'install-settlement.test.cjs', 'test-physical-proof.cjs': 'physical-proof.test.cjs' }))
    content.set(target, fs.readFileSync(path.join(here, owner)));
  if (names.includes('info.prepared.json')) content.set('info.prepared.json', read('info.prepared.json'));
  const contract = { schema: 'native-helper-kit/1', sourceSha256,
    files: Object.fromEntries([...content].map(([n, b]) => [n, sha(b)])),
    reviewRequired: true, activationGranted: false, nativeEffects: false };
  content.set('HELPER-KIT.json', Buffer.from(JSON.stringify(contract, null, 2) + '\n'));
  if (apply) {
    ordinary(output);
    fs.mkdirSync(output);
    for (const [name, bytes] of content) {
      const file = path.join(output, name); ordinary(file);
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
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
  for (const [name, pin] of Object.entries(contract.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || ['.', '..'].includes(name)
      || !/^[a-f0-9]{64}$/.test(pin)) throw Error('INVALID_HELPER_KIT');
    const file = path.join(dir, name); ordinary(file);
    const bytes = fs.readFileSync(file);
    // Binding legitimately changes the held config. Runtime code may not drift.
    if (name !== 'reviewed.prepared.json' && sha(bytes) !== pin) throw Error('HELPER_KIT_DRIFT');
  }
  for (const name of files) {
    if (contract.files[name] !== sha(fs.readFileSync(path.join(here, name)))) throw Error('STALE_HELPER_KIT');
  }
  if (contract.files['settlement.cjs'] !== sha(alias))
    throw Error('STALE_HELPER_KIT');
  const runtime = Object.entries(contract.files).filter(([n]) => n.endsWith('.cjs') && !n.startsWith('test-'));
  for (const name of ['reviewed.prepared.json', 'reviewed.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    ordinary(file);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config.modulePins || JSON.stringify(Object.keys(config.modulePins).sort()) !== JSON.stringify(runtime.map(([n]) => n).sort())
      || runtime.some(([n, h]) => config.modulePins[n] !== h)) throw Error('HELPER_BINDING_MODULE_PINS_DIFFER');
    if (name === 'reviewed.json' && config.helperSHA256 !== contract.files['index.prepared.js'])
      throw Error('HELPER_BINDING_ENTRY_PIN_DIFFERS');
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
    else if (['--source', '--output', '--source-sha256'].includes(name) && !values[name] && args[i + 1]) values[name] = args[++i];
    else throw Error('INVALID_HELPER_PREPARATION_ARGUMENTS');
  }
  return prepareHelper({ source: values['--source'], output: values['--output'],
    sourceSha256: values['--source-sha256'], apply: values.apply === true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main()) + '\n'); }
  catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : 'HELPER_PREPARATION_FAILED') + '\n'); process.exitCode = 1; }
}
