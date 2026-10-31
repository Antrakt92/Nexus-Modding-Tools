import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import strictJSON from './strict-json.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../local-state');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (value, code) => {if (!value) throw Error(code);};
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const referencePins = Object.freeze({
  'index.prepared.js': '0337ce5330d8ae094e52b821bfd8e26440b168ed4ae7c76468020bfca2681417',
  'capture.cjs': '034c81da4efb7d56815192fb9029a1e2e1b2c3e4f557d08bb611f84e66b5dffd',
  'scope.cjs': '0e0afb9685f199f2b1bf292c5911e38cea89cf180bc7805cae9c7d018862abaa',
  'native-selectors.cjs': '2078f202b8b7aed52172dcde7362d95b177a18db761dde8a098e7623c52285cb',
  'nexus-identity.cjs': '0f5677a95e62fce5613f7f2594b50a86b98ef7144c23f179887e1cb25428ba2a',
  'extractor-admission.cjs': '7d7da582e58f7af2ae492421617cdd168a4476b524287848b2805e7c201a2e93',
});
const timestampPin = 'a50d4f9f8da135e214542ef89dd970c3c38c569dd2a4ae7b12c4cac43cb7b0a7';
export const SUPPORTED_READ_CAPTURE = Object.freeze({family: 'menu-zero-package-read-capture/1',
  purpose: 'own-read-capture/1', hostVersion: '2.9.1', gameId: 'cyberpunk2077', profileId: 'ptndev1016',
  referencePins, timestampPin});
export const MISSING_CAPTURE_BINDINGS = Object.freeze(['health/context/root identities', 'current source admission and source pins',
  'independent root disk/deployment/preferences baseline', 'native temp identity', 'current process guard',
  'fresh plugin identity and reviewed host/materializer', 'reviewed peers/interlocks and exclusive native window']);
const runtime = Object.freeze(['capture.cjs', 'extractor-admission.cjs', 'native-selectors.cjs',
  'nexus-identity.cjs', 'scope.cjs', 'tool-timestamps.cjs']);
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
const node = stat => `${stat.dev}:${stat.ino}`;

function ordinary(value) {
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current, {bigint: true});
      need(!stat.isSymbolicLink(), 'READ_CAPTURE_REPARSE_PATH');
      if (current !== path.resolve(value)) need(stat.isDirectory(), 'READ_CAPTURE_ORDINARY_PARENT_REQUIRED');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (current === path.dirname(current)) return;
  }
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value), 'READ_CAPTURE_ABSOLUTE_PATH_REQUIRED');
  const result = path.resolve(value); ordinary(result);
  need(!/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(result), 'READ_CAPTURE_ACTIVE_PLUGIN_PATH_REFUSED');
  return result;
}
function ancestry(value) {
  ordinary(value); const result = [];
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'READ_CAPTURE_ORDINARY_PARENT_REQUIRED');
    result.push([current, node(stat)]);
    if (current === path.dirname(current)) return result;
  }
}
function sameAncestry(pins) {
  for (const [file, identity] of pins) {
    const stat = fs.lstatSync(file, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink() && node(stat) === identity, 'READ_CAPTURE_PATH_CHANGED');
  }
}
function read(file, maxBytes = 1024 * 1024) {
  const parents = ancestry(path.dirname(file)); ordinary(file);
  const before = fs.lstatSync(file, {bigint: true});
  need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes), 'READ_CAPTURE_BOUNDED_FILE_REQUIRED');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, {bigint: true});
    need(stamp(opened) === stamp(before), 'READ_CAPTURE_INPUT_CHANGED');
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    const after = fs.fstatSync(fd, {bigint: true});
    need(bytes.length <= maxBytes && BigInt(bytes.length) === after.size && stamp(after) === stamp(opened)
      && stamp(fs.lstatSync(file, {bigint: true})) === stamp(after), 'READ_CAPTURE_INPUT_CHANGED');
    sameAncestry(parents); return {bytes, file, generation: stamp(after), parents};
  } finally {fs.closeSync(fd);}
}
function unchanged(observations) {
  for (const old of observations) {
    sameAncestry(old.parents); const current = read(old.file);
    need(current.generation === old.generation && current.bytes.equals(old.bytes), 'READ_CAPTURE_INPUT_CHANGED');
  }
}
function directoryNames(dir) {
  const handle = fs.opendirSync(dir); const names = [];
  try {
    for (let entry; (entry = handle.readSync()) !== null;) {
      need(entry.isFile(), 'READ_CAPTURE_KIT_FILES_DIFFER');
      names.push(entry.name);
      need(names.length <= runtime.length + 6, 'READ_CAPTURE_KIT_FILES_DIFFER');
    }
    return names.sort();
  } finally {handle.closeSync();}
}
function replaceOnce(value, old, replacement) {
  need(value.split(old).length === 2, 'READ_CAPTURE_UNSUPPORTED_TEMPLATE');
  return value.replace(old, replacement);
}
function contentsFor({output, originalIndex, originalCapture, modules, timestamp}) {
  let index = originalIndex.toString('utf8').replaceAll('\r\n', '\n');
  index = replaceOnce(index, "'read-only-clean-capture-reuse-dev-native-capture/1'", "'own-read-capture/1'");
  index = replaceOnce(index, "   save('CP-SETTLEMENT-DIAGNOSTIC',require('./own-diagnostic.cjs').project(context.api.getState(),cfg.health.profileId));\n", '');
  let capture = originalCapture.toString('utf8').replaceAll('\r\n', '\n');
  const oldTimestamp = 'const timestampModule="D:/Modding/Nexus/local-state/collection-hardening-20261028/native-state-diagnostic-v2/tool-timestamps.cjs";\n'
    + 'if(crypto.createHash(\'sha256\').update(fs.readFileSync(timestampModule)).digest(\'hex\')!=="' + timestampPin
    + '")throw Error(\'TOOL_TIMESTAMP_POLICY_SOURCE_CHANGED\');\nconst toolTimestamps=require(timestampModule);';
  capture = replaceOnce(capture, oldTimestamp, "const toolTimestamps=require('./tool-timestamps.cjs');");
  const contents = new Map([...modules].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  contents.set('capture.cjs', Buffer.from(capture)); contents.set('tool-timestamps.cjs', Buffer.from(timestamp));
  contents.set('index.prepared.js', Buffer.from(index));
  contents.set('reference-index.js', Buffer.from(originalIndex)); contents.set('reference-capture.cjs', Buffer.from(originalCapture));
  const config = {purpose: 'own-read-capture/1', activationApproved: false, allActivationHold: true, noEffects: true,
    sourceOnlyNoCapturePerformed: true, freshStaticAdmissionRequired: true, freshRootDiskBaselineFinalized: false,
    control: output, pluginPath: null, health: null, expectedHostVersion: null, guard: null, sourcePins: null,
    packages: [], diskBaseline: null, manifestPath: null, admissionFile: null, admissionSHA256: null,
    reviewedPeerExtensions: null, nativeTempPath: null, helperSHA256: sha(contents.get('index.prepared.js')),
    modulePins: Object.fromEntries(runtime.map(name => [name, sha(contents.get(name))]))};
  contents.set('reviewed.prepared.json', Buffer.from(canonical(config)));
  contents.set('COPY-MAP.prepared.json', Buffer.from(canonical([
    {source: 'index.prepared.js', destination: 'index.js', sha256: sha(contents.get('index.prepared.js'))},
    {source: 'info.json', destination: 'info.json', sha256: null},
    {source: 'reviewed.json', destination: 'reviewed.json', sha256: null},
    ...runtime.map(name => ({source: name, destination: name, sha256: sha(contents.get(name))})),
  ])));
  contents.set('READ-CAPTURE-KIT.json', Buffer.from(canonical({schema: 'own-read-capture-kit/1',
    family: SUPPORTED_READ_CAPTURE.family, purpose: config.purpose, supportedHostVersion: '2.9.1',
    gameId: 'cyberpunk2077', profileId: 'ptndev1016', runtime, referencePins, timestampPin,
    files: Object.fromEntries([...contents].map(([name, bytes]) => [name, sha(bytes)])),
    packages: [], activationGranted: false, installReady: false, nativeEffects: false, capturePerformed: false,
    materializationSupported: false, missingBindings: MISSING_CAPTURE_BINDINGS})));
  return contents;
}
function result(output, files, applied = false) {
  return {status: applied ? 'read-capture-held' : 'plan', output, files, runtimeModules: runtime.length,
    packages: 0, installReady: false, activationGranted: false, nativeEffects: false, capturePerformed: false,
    materializationSupported: false, missingBindings: [...MISSING_CAPTURE_BINDINGS]};
}
export function prepareReadCapture({reference, timestampPolicy, output, apply = false}) {
  need(typeof apply === 'boolean', 'READ_CAPTURE_INVALID_ARGUMENTS');
  reference = absolute(reference); output = absolute(output);
  const relative = path.relative(scratch, output);
  need(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'READ_CAPTURE_OUTPUT_SCOPE_REFUSED');
  const fromReference = path.relative(reference, output);
  need(fromReference.startsWith('..' + path.sep) || fromReference === '..' || path.isAbsolute(fromReference), 'READ_CAPTURE_REFERENCE_OUTPUT_OVERLAP');
  need(!fs.existsSync(output), 'READ_CAPTURE_NEW_OUTPUT_REQUIRED');
  const parentPins = ancestry(path.dirname(output));
  timestampPolicy = absolute(timestampPolicy ?? path.join(reference, 'tool-timestamps.cjs'));
  const observations = [], inputs = new Map();
  for (const [name, pin] of Object.entries(referencePins)) {
    const item = read(path.join(reference, name)); observations.push(item);
    need(sha(item.bytes) === pin, 'READ_CAPTURE_REFERENCE_DRIFT'); inputs.set(name, item.bytes);
  }
  const timestamp = read(timestampPolicy); observations.push(timestamp);
  need(sha(timestamp.bytes) === timestampPin, 'READ_CAPTURE_TIMESTAMP_POLICY_DRIFT');
  const modules = new Map([...inputs].filter(([name]) => !['index.prepared.js', 'capture.cjs'].includes(name)));
  const contents = contentsFor({output, originalIndex: inputs.get('index.prepared.js'),
    originalCapture: inputs.get('capture.cjs'), modules, timestamp: timestamp.bytes});
  unchanged(observations); sameAncestry(parentPins);
  if (apply) {
    fs.mkdirSync(output); // Exclusive. An incomplete output remains held; never clean up or retry.
    const outputNode = node(fs.lstatSync(output, {bigint: true}));
    const ownOutput = () => {sameAncestry(parentPins); ordinary(output);
      const stat = fs.lstatSync(output, {bigint: true});
      need(stat.isDirectory() && node(stat) === outputNode, 'READ_CAPTURE_OUTPUT_CHANGED');};
    for (const [name, bytes] of contents) {
      ownOutput(); const fd = fs.openSync(path.join(output, name), 'wx');
      try {fs.writeFileSync(fd, bytes);} finally {fs.closeSync(fd);}
    }
    ownOutput(); verifyReadCapture(output); unchanged(observations); ownOutput();
  }
  return result(output, contents.size, apply);
}
export function verifyReadCapture(value) {
  const dir = absolute(value), observations = [];
  const directoryPins = ancestry(dir), directoryGeneration = stamp(fs.lstatSync(dir, {bigint: true}));
  const initialNames = directoryNames(dir);
  const take = name => {const item = read(path.join(dir, name)); observations.push(item); return item.bytes;};
  need(fs.existsSync(path.join(dir, 'READ-CAPTURE-KIT.json')), 'READ_CAPTURE_INCOMPLETE_KIT');
  const contractBytes = take('READ-CAPTURE-KIT.json');
  const contract = strictJSON.parseStrictJSON(contractBytes);
  need(contract?.schema === 'own-read-capture-kit/1', 'READ_CAPTURE_INVALID_KIT');
  const originalIndex = take('reference-index.js'), originalCapture = take('reference-capture.cjs');
  need(sha(originalIndex) === referencePins['index.prepared.js'] && sha(originalCapture) === referencePins['capture.cjs'], 'READ_CAPTURE_REFERENCE_DRIFT');
  const modules = new Map();
  for (const [name, pin] of Object.entries(referencePins)) {
    if (['index.prepared.js', 'capture.cjs'].includes(name)) continue;
    const bytes = take(name); need(sha(bytes) === pin, 'READ_CAPTURE_REFERENCE_DRIFT'); modules.set(name, bytes);
  }
  const timestamp = take('tool-timestamps.cjs'); need(sha(timestamp) === timestampPin, 'READ_CAPTURE_TIMESTAMP_POLICY_DRIFT');
  const expected = contentsFor({output: dir, originalIndex, originalCapture, modules, timestamp});
  const expectedNames = [...expected.keys()].sort();
  need(same(initialNames, expectedNames), 'READ_CAPTURE_KIT_FILES_DIFFER');
  for (const [name, bytes] of expected) {
    const actual = name === 'READ-CAPTURE-KIT.json' ? contractBytes : take(name);
    need(actual.equals(bytes), 'READ_CAPTURE_KIT_DRIFT');
  }
  unchanged(observations);
  sameAncestry(directoryPins);
  need(same(directoryNames(dir), expectedNames), 'READ_CAPTURE_KIT_FILES_DIFFER');
  sameAncestry(directoryPins);
  need(stamp(fs.lstatSync(dir, {bigint: true})) === directoryGeneration, 'READ_CAPTURE_OUTPUT_CHANGED');
  for (const observation of observations) {
    sameAncestry(observation.parents);
    need(stamp(fs.lstatSync(observation.file, {bigint: true})) === observation.generation, 'READ_CAPTURE_INPUT_CHANGED');
  }
  sameAncestry(directoryPins);
  need(stamp(fs.lstatSync(dir, {bigint: true})) === directoryGeneration, 'READ_CAPTURE_OUTPUT_CHANGED');
  return {...result(dir, expected.size), status: 'read-capture-code-verified', codeVerified: true};
}
export function main(args = process.argv.slice(2)) {
  if (args[0] === 'verify' && args.length === 2) return verifyReadCapture(args[1]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--apply' && options.apply === undefined) options.apply = true;
    else if (['--reference', '--timestamp-policy', '--output'].includes(name) && options[name] === undefined && args[i + 1]) options[name] = args[++i];
    else throw Error('READ_CAPTURE_INVALID_ARGUMENTS');
  }
  return prepareReadCapture({reference: options['--reference'], timestampPolicy: options['--timestamp-policy'], output: options['--output'], apply: options.apply === true});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(JSON.stringify(main()) + '\n');}
  catch (error) {
    process.stderr.write((/^READ_CAPTURE_[A-Z_]+$/.test(error.message) ? error.message : 'READ_CAPTURE_PREPARATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
