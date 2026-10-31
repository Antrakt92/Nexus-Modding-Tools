import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';
import {assembleNativeSources, NATIVE_SOURCE_PATHS, NATIVE_SOURCE_LIMITS} from './native-source-series.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKET = path.join(HERE, 'native-patches/vortex-2.9.1');
const series = JSON.parse(fs.readFileSync(path.join(HERE, 'native-source-series.json'), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dummy = () => Object.fromEntries(NATIVE_SOURCE_PATHS.map(file => [file, Buffer.from('x\n')]));
const reject = (input, code = 'INPUT') => assert.throws(() => assembleNativeSources(input),
  error => error.message === 'NATIVE_SOURCE_SERIES_'+code);
const integration = (name, action) => test(name, {
  skip: process.env.VORTEX_NATIVE_SOURCE_ROOT ? false : 'Set VORTEX_NATIVE_SOURCE_ROOT to the exact original ten-file source root',
}, action);
const originals = () => Object.fromEntries(NATIVE_SOURCE_PATHS.map(file => [file,
  fs.readFileSync(path.join(process.env.VORTEX_NATIVE_SOURCE_ROOT, file))]));

function clonePacket(t) {
  const parent = path.resolve(HERE, '../../../local-state/vortex-agent-build/tests');
  fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'native-source-series-'));
  // Only this test's fresh, resolved child is eligible for cleanup.
  assert(path.resolve(root).startsWith(parent+path.sep));
  t.after(() => {
    assert(path.resolve(root).startsWith(parent+path.sep));
    fs.rmSync(root, {recursive: true, force: true});
  });
  for (const name of ['native-source-series.mjs', 'native-source-series.json',
    'native-patch-test-fixture.mjs', 'strict-json.cjs']) fs.copyFileSync(path.join(HERE, name), path.join(root, name));
  const packet = path.join(root, 'native-patches/vortex-2.9.1');
  fs.mkdirSync(packet, {recursive: true});
  for (const name of fs.readdirSync(PACKET)) fs.copyFileSync(path.join(PACKET, name), path.join(packet, name));
  return {root, packet, load: async () => (await import(pathToFileURL(path.join(root, 'native-source-series.mjs')).href)).assembleNativeSources};
}

test('closed input rejects accessors, proxies, symbols and inherited maps without executing caller code', () => {
  for (const input of [null, undefined, [], '', 0, Object.create(dummy())]) reject(input);
  const input = dummy(); let called = 0;
  Object.defineProperty(input, NATIVE_SOURCE_PATHS[0], {enumerable: true, get() {called++; throw Error('getter');}});
  reject(input); assert.equal(called, 0);
  reject(new Proxy(dummy(), {ownKeys() {called++; throw Error('proxy');}})); assert.equal(called, 0);
  const bytesProxy = dummy(); bytesProxy[NATIVE_SOURCE_PATHS[0]] = new Proxy(Buffer.from('x'), {
    get() {called++; throw Error('byte proxy');},
  });
  reject(bytesProxy); assert.equal(called, 0);
  const symbol = dummy(); symbol[Symbol('extra')] = 1; reject(symbol);
  const extra = dummy(); extra['../escape.ts'] = Buffer.from('x'); reject(extra);
  const missing = dummy(); delete missing[NATIVE_SOURCE_PATHS[0]]; reject(missing);
  const hidden = dummy(); Object.defineProperty(hidden, NATIVE_SOURCE_PATHS[0], {enumerable: false}); reject(hidden);
});

test('byte inputs reject strings, other views, shared, detached and resizable storage', () => {
  const detached = new Uint8Array(2); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  for (const value of ['x', [120], new Uint16Array(1), new DataView(new ArrayBuffer(2)),
    new Uint8Array(new SharedArrayBuffer(2)), new Uint8Array(new ArrayBuffer(2, {maxByteLength: 4}))]) {
    const input = dummy(); input[NATIVE_SOURCE_PATHS[0]] = value; reject(input);
  }
  const input = dummy(); input[NATIVE_SOURCE_PATHS[0]] = detached; reject(input, 'INPUT_LIMIT');
});

test('per-file and aggregate limits are enforced before packet reads', () => {
  const large = dummy(); large[NATIVE_SOURCE_PATHS[0]] = new Uint8Array(NATIVE_SOURCE_LIMITS.fileBytes+1);
  reject(large, 'INPUT_LIMIT');
  const total = Object.fromEntries(NATIVE_SOURCE_PATHS.map(file => [file, new Uint8Array(NATIVE_SOURCE_LIMITS.fileBytes)]));
  reject(total, 'INPUT_LIMIT');
  const empty = dummy(); empty[NATIVE_SOURCE_PATHS[0]] = new Uint8Array(); reject(empty, 'INPUT_LIMIT');
});

test('genuine byte views cannot execute shadowed storage or size accessors', () => {
  const input = dummy(); let calls = 0;
  for (const value of Object.values(input)) {
    for (const name of ['buffer', 'byteLength', 'length']) Object.defineProperty(value, name, {
      get() {calls++; throw Error('shadowed accessor');},
    });
  }
  reject(input, 'INPUT_SHA256');
  assert.equal(calls, 0);
});

test('fixed packet is checked, but an unpinned original can never assemble', () => {
  reject(dummy(), 'INPUT_SHA256');
  reject(Object.assign(Object.create(null), dummy()), 'INPUT_SHA256');
});

test('pinned series closes all fixed nodes, exact source chains and cross-file manager dependencies', () => {
  assert.equal(series.patches.length, 28); assert.equal(series.files.length, 10);
  assert.deepEqual([...series.files.map(row => row.path)].sort(), [...NATIVE_SOURCE_PATHS].sort());
  const done = new Map(), current = new Map(series.files.map(row => [row.path, row.originalSHA256]));
  for (const row of series.patches) {
    const raw = fs.readFileSync(path.join(PACKET, row.name+'.json'));
    assert.equal(sha(raw), row.manifestSHA256);
    const manifest = JSON.parse(raw);
    assert.equal(sha(fs.readFileSync(path.join(PACKET, row.name+'.patch'))), row.patchSHA256);
    assert.equal(current.get(row.path), row.inputSHA256, row.name);
    if (row.prerequisitePatch) assert.equal(done.get(row.prerequisitePatch.slice(0, -6))?.patchSHA256, row.prerequisitePatchSHA256);
    if (row.requiredManagerPatchSHA256) assert([...done.values()].some(parent =>
      parent.patchSHA256 === row.requiredManagerPatchSHA256 && parent.path.endsWith('/InstallManager.ts')));
    assert.equal(manifest.upstreamPath, row.path); current.set(row.path, row.outputSHA256); done.set(row.name, row);
  }
  for (const row of series.files) assert.equal(current.get(row.path), row.finalSHA256);
});

test('an extra packet file or missing fixed patch fails closed before examining original pins', async t => {
  const extra = clonePacket(t); fs.writeFileSync(path.join(extra.packet, 'extra.patch'), 'unexpected');
  const first = await extra.load(); assert.throws(() => first(dummy()), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);
  const missing = clonePacket(t); fs.unlinkSync(path.join(missing.packet, series.patches[0].name+'.patch'));
  const second = await missing.load(); assert.throws(() => second(dummy()), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);
});

test('both download safeguards are mandatory and test-only patches stay outside the runtime packet', async t => {
  const names = ['download-pending-transfer-hold', 'download-transfer-cleanup-hold'];
  for (const name of names) {
    assert.equal(series.patches.filter(row => row.name === name).length, 1);
    for (const suffix of ['.json', '.patch']) {
      const fixture = clonePacket(t);
      fs.unlinkSync(path.join(fixture.packet, name+suffix));
      const assemble = await fixture.load();
      assert.throws(() => assemble(dummy()), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);
    }
  }
  const fixture = clonePacket(t);
  const testsPacket = path.join(HERE, 'native-patches/vortex-tests-2.9.1');
  for (const suffix of ['.json', '.patch']) fs.copyFileSync(
    path.join(testsPacket, 'staging-transfer-vitest'+suffix),
    path.join(fixture.packet, 'staging-transfer-vitest'+suffix));
  const assemble = await fixture.load();
  assert.throws(() => assemble(dummy()), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);
});

test('altered source context, redirected manifest and rewritten series cannot relax fixed pins', async t => {
  for (const mode of ['patch', 'manifest', 'series']) {
    const fixture = clonePacket(t);
    const target = mode === 'series' ? path.join(fixture.root, 'native-source-series.json')
      : path.join(fixture.packet, series.patches[0].name+(mode === 'patch' ? '.patch' : '.json'));
    if (mode === 'patch') fs.appendFileSync(target, '--- a/other.ts\n+++ b/other.ts\n');
    else {
      const json = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (mode === 'series') json.files[0].originalSHA256 = sha(Buffer.from('x\n'));
      else json.upstreamPath = '../other.ts';
      fs.writeFileSync(target, JSON.stringify(json));
    }
    const assemble = await fixture.load();
    assert.throws(() => assemble(dummy()), error => error.message === 'NATIVE_SOURCE_SERIES_'+(mode === 'series' ? 'SERIES' : 'PACKET'));
  }
});

test('a previously read packet changing before read verification is refused', async t => {
  const fixture = clonePacket(t), assemble = await fixture.load();
  const last = path.join(fixture.packet, series.patches.at(-1).name+'.patch');
  const first = path.join(fixture.packet, series.patches[0].name+'.patch');
  const open = fs.openSync, close = fs.closeSync;
  let lastFd, mutated = false;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (file === last) lastFd = fd;
    return fd;
  };
  fs.closeSync = fd => {
    close(fd);
    if (fd === lastFd && !mutated) {
      mutated = true;
      fs.appendFileSync(first, '\n');
    }
  };
  try {assert.throws(() => assemble(dummy()), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);}
  finally {fs.openSync = open; fs.closeSync = close;}
  assert(mutated);
});

integration('all ten final sources equal independent exact application and return detached immutable observations', () => {
  const input = originals(), result = assembleNativeSources(input);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.sources)); assert(Object.isFrozen(result.receipt));
  const expected = Object.fromEntries(Object.entries(input).map(([file, bytes]) => [file, bytes.toString('utf8')]));
  for (const row of series.patches) expected[row.path] = applyExact(expected[row.path],
    fs.readFileSync(path.join(PACKET, row.name+'.patch'), 'utf8'), row.path);
  assert.deepEqual(Object.keys(result.sources).sort(), [...NATIVE_SOURCE_PATHS].sort());
  for (const row of series.files) {
    assert.equal(sha(result.sources[row.path]), row.finalSHA256);
    assert.equal(Buffer.from(result.sources[row.path]).toString(), expected[row.path]);
    const returned = result.sources[row.path]; returned.fill(0); input[row.path].fill(0);
    assert.equal(sha(result.sources[row.path]), row.finalSHA256);
  }
  assert(Object.isFrozen(result.receipt.sources)); assert(Object.isFrozen(result.receipt.sources[0]));
  assert(Object.isFrozen(result.receipt.patches[0])); assert.equal(result.receipt.patches.length, 28);
  assert.equal(result.receipt.preparedOnly, true);
  for (const flag of ['nativeAdmission', 'effectsAllowed', 'typecheckVerified', 'nativeAcceptanceVerified', 'installed'])
    assert.equal(result.receipt[flag], false);
});

integration('all caller bytes are copied before the first fixed-packet read and source drift is refused', () => {
  const input = originals(), open = fs.openSync; let mutated = false;
  fs.openSync = (file, ...args) => {
    if (!mutated) {mutated = true; for (const bytes of Object.values(input)) bytes.fill(0);}
    return open(file, ...args);
  };
  let result;
  try {result = assembleNativeSources(input);} finally {fs.openSync = open;}
  assert(mutated);
  for (const row of series.files) assert.equal(sha(result.sources[row.path]), row.finalSHA256);
  const changed = originals(); changed[NATIVE_SOURCE_PATHS[0]][0] ^= 1; reject(changed, 'INPUT_SHA256');
});

integration('packet drift after assembly cannot produce a receipt for otherwise valid sources', async t => {
  const input = originals(), fixture = clonePacket(t), assemble = await fixture.load();
  const open = fs.opendirSync; let inventories = 0, mutated = false;
  fs.opendirSync = (directory, ...args) => {
    if (directory === fixture.packet && ++inventories === 3) {
      mutated = true;
      fs.appendFileSync(path.join(fixture.packet, series.patches[0].name+'.patch'), '\n');
    }
    return open(directory, ...args);
  };
  try {assert.throws(() => assemble(input), /^Error: NATIVE_SOURCE_SERIES_PACKET$/);}
  finally {fs.opendirSync = open;}
  assert(mutated);
});

integration('both added download originals require their independently pinned bytes', () => {
  for (const file of NATIVE_SOURCE_PATHS.filter(file => file.includes('/download_management/'))) {
    const changed = originals(); changed[file][0] ^= 1;
    reject(changed, 'INPUT_SHA256');
  }
});
