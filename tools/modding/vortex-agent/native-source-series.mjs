// Offline exact-source assembly only. No export, compiler, Vortex or dispatch effects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isProxy, isUint8Array, isSharedArrayBuffer} from 'node:util/types';
import strict from './strict-json.cjs';
import {applyExact} from './native-patch-test-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKET = path.join(HERE, 'native-patches/vortex-2.9.1');
const SERIES_SHA256 = 'c33c3269ded1e13c550ed851447092c2661ea55ad68f0fdba12e55d86829bcbe';
export const NATIVE_SOURCE_PATHS = Object.freeze([
  'src/renderer/src/extensions/mod_management/eventHandlers.ts',
  'src/renderer/src/extensions/mod_management/index.ts',
  'src/renderer/src/extensions/mod_management/InstallManager.ts',
  'src/renderer/src/extensions/mod_management/modActivation.ts',
  'src/renderer/src/extensions/mod_management/util/activationStore.ts',
  'src/renderer/src/extensions/mod_management/util/deploy.ts',
  'src/renderer/src/util/transferPath.ts',
  'src/renderer/src/extensions/mod_management/views/Settings.tsx',
  'src/renderer/src/extensions/download_management/index.ts',
  'src/renderer/src/extensions/download_management/views/Settings.tsx',
]);
export const NATIVE_SOURCE_LIMITS = Object.freeze({fileBytes: 2*1024*1024, totalBytes: 8*1024*1024});
const fail = code => {throw Error('NATIVE_SOURCE_SERIES_' + code);};
const need = (condition, code) => {if (!condition) fail(code);};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const frozen = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
};
const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);

function snapshot(input) {
  need(input && typeof input === 'object' && !isProxy(input), 'INPUT');
  need([Object.prototype, null].includes(Object.getPrototypeOf(input)), 'INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  need(exact(descriptors, NATIVE_SOURCE_PATHS), 'INPUT');
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
  const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
  const output = new Map();
  let total = 0;
  for (const file of NATIVE_SOURCE_PATHS) {
    const descriptor = descriptors[file];
    need(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'INPUT');
    const value = descriptor.value;
    need(!isProxy(value) && isUint8Array(value), 'INPUT');
    const length = lengthOf.call(value), backing = bufferOf.call(value);
    need(!isSharedArrayBuffer(backing) && !(resizable?.call(backing)), 'INPUT');
    need(length > 0 && length <= NATIVE_SOURCE_LIMITS.fileBytes, 'INPUT_LIMIT');
    total += length;
    need(total <= NATIVE_SOURCE_LIMITS.totalBytes, 'INPUT_LIMIT');
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, value);
    output.set(file, copy);
  }
  return output;
}

const generation = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => String(stat[key])).join(':');
function readPacket() {
  const pins = new Map();
  const root = fs.lstatSync(PACKET, {bigint: true});
  need(root.isDirectory() && !root.isSymbolicLink(), 'PACKET');
  const read = (file, maxBytes) => {
    const before = fs.lstatSync(file, {bigint: true});
    need(before.isFile() && !before.isSymbolicLink() && before.size > 0n
      && before.size <= BigInt(maxBytes), 'PACKET');
    const fd = fs.openSync(file, 'r');
    try {
      need(generation(fs.fstatSync(fd, {bigint: true})) === generation(before), 'PACKET');
      const bytes = Buffer.alloc(Number(before.size)+1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, Math.min(65536, bytes.length-used), used);
        if (count === 0) break;
        used += count;
      }
      need(used === Number(before.size)
        && generation(fs.fstatSync(fd, {bigint: true})) === generation(before)
        && generation(fs.lstatSync(file, {bigint: true})) === generation(before), 'PACKET');
      pins.set(file, generation(before));
      return bytes.subarray(0, used);
    } finally {fs.closeSync(fd);}
  };
  const raw = read(path.join(HERE, 'native-source-series.json'), 64*1024);
  need(sha(raw) === SERIES_SHA256, 'SERIES');
  const series = strict.parseStrictJSON(raw, {maxBytes: 64*1024, maxDepth: 8, maxTokens: 8000});
  need(series.schema === 'native-source-series/1' && series.files.length === 10
    && series.patches.length === 29 && exact(Object.fromEntries(series.files.map(row => [row.path, true])), NATIVE_SOURCE_PATHS), 'SERIES');
  const names = series.patches.flatMap(row => [row.name+'.json', row.name+'.patch']).sort();
  const inventory = () => {
    const directory = fs.opendirSync(PACKET), actual = [];
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        need(actual.length < names.length, 'PACKET');
        actual.push(entry.name);
      }
    } finally {directory.closeSync();}
    actual.sort();
    need(actual.length === names.length && actual.every((name, index) => name === names[index]), 'PACKET');
  };
  inventory();
  const records = series.patches.map(row => {
    need(/^[a-z][a-z-]{0,63}$/.test(row.name) && NATIVE_SOURCE_PATHS.includes(row.path), 'SERIES');
    const manifestBytes = read(path.join(PACKET, row.name+'.json'), 16*1024);
    const patchBytes = read(path.join(PACKET, row.name+'.patch'), 1024*1024);
    need(sha(manifestBytes) === row.manifestSHA256 && sha(patchBytes) === row.patchSHA256, 'PACKET');
    const manifest = strict.parseStrictJSON(manifestBytes, {maxBytes: 16*1024, maxDepth: 8, maxTokens: 2000});
    const original = series.files.find(file => file.path === row.path);
    need(manifest.schema === 'native-source-patch/1' && manifest.upstreamPath === row.path
      && ['upstreamRepository', 'upstreamTag', 'upstreamCommit'].every(key => manifest[key] === series[key])
      && (manifest.originalSourceSHA256 ?? original.originalSHA256) === original.originalSHA256 && manifest.preparedOnly === true
      && ['installed', 'nativeAcceptanceVerified'].every(key => manifest[key] === false)
      && ['nativeTerminalGuarantee', 'globalIdleGuarantee'].every(key => !Object.hasOwn(manifest, key) || manifest[key] === false)
      && ['inputSHA256', 'outputSHA256', 'patchSHA256', 'prerequisitePatch', 'prerequisitePatchSHA256', 'requiredManagerPatchSHA256']
        .every(key => (manifest[key] ?? null) === row[key]), 'GRAPH');
    return {row, patch: decode(patchBytes)};
  });
  const verify = () => {
    inventory();
    for (const [file, pin] of pins) need(generation(fs.lstatSync(file, {bigint: true})) === pin, 'PACKET');
    const after = fs.lstatSync(PACKET, {bigint: true});
    need(after.isDirectory() && !after.isSymbolicLink() && after.dev === root.dev && after.ino === root.ino, 'PACKET');
  };
  verify();
  return {series, records, verify};
}

/** Sources is a frozen map; each access returns fresh, detached Uint8Array bytes.
 * Typed arrays themselves are mutable in JS. No caller receives the retained bytes.
 * This proves exact source assembly only, never typecheck or native admission. */
export function assembleNativeSources(input) {
  try {
    // Finish detaching every caller-owned byte input before reading the fixed packet.
    const copied = snapshot(input);
    const {series, records, verify} = readPacket();
    const texts = new Map(), originals = new Map();
    for (const row of series.files) {
      const bytes = copied.get(row.path);
      need(sha(bytes) === row.originalSHA256, 'INPUT_SHA256');
      texts.set(row.path, decode(bytes)); originals.set(row.path, bytes.length);
    }
    const applied = new Map();
    for (const {row, patch} of records) {
      need(!applied.has(row.name), 'GRAPH');
      if (row.prerequisitePatch !== null) {
        const parent = applied.get(row.prerequisitePatch.replace(/\.patch$/, ''));
        need(parent && parent.patchSHA256 === row.prerequisitePatchSHA256, 'GRAPH');
      } else need(row.prerequisitePatchSHA256 === null, 'GRAPH');
      if (row.requiredManagerPatchSHA256 !== null) {
        need([...applied.values()].some(parent => parent.patchSHA256 === row.requiredManagerPatchSHA256
          && parent.path.endsWith('/InstallManager.ts')), 'GRAPH');
      }
      const source = texts.get(row.path);
      need(sha(source) === row.inputSHA256, 'PATCH');
      const output = applyExact(source, patch, row.path);
      need(sha(output) === row.outputSHA256 && Buffer.byteLength(output) <= NATIVE_SOURCE_LIMITS.fileBytes, 'OUTPUT');
      texts.set(row.path, output); applied.set(row.name, row);
    }
    const sources = Object.create(null), sourceReceipt = [];
    let total = 0;
    for (const row of series.files) {
      const bytes = new Uint8Array(Buffer.from(texts.get(row.path)));
      total += bytes.length;
      need(sha(bytes) === row.finalSHA256 && total <= NATIVE_SOURCE_LIMITS.totalBytes, 'OUTPUT');
      Object.defineProperty(sources, row.path, {enumerable: true, get: Object.freeze(() => new Uint8Array(bytes))});
      sourceReceipt.push({...row, originalBytes: originals.get(row.path), finalBytes: bytes.length});
    }
    verify();
    return Object.freeze({sources: Object.freeze(sources), receipt: frozen({
      schema: 'native-source-assembly-receipt/1', sourceSeriesSHA256: SERIES_SHA256,
      upstreamRepository: series.upstreamRepository, upstreamTag: series.upstreamTag, upstreamCommit: series.upstreamCommit,
      patches: series.patches.map(row => ({...row})), sources: sourceReceipt,
      preparedOnly: true, nativeAdmission: false, effectsAllowed: false,
      typecheckVerified: false, nativeAcceptanceVerified: false, installed: false,
    })});
  } catch (error) {
    if (/^NATIVE_SOURCE_SERIES_[A-Z0-9_]+$/.test(error?.message ?? '')) throw error;
    fail('INVALID');
  }
}
