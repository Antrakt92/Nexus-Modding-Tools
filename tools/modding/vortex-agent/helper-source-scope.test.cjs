'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {validateSourceScope: validate} = require('./helper-source-scope.cjs');
function fixture() {
  const root = path.resolve('scope-own-source'), file = path.join(root, 'source.cjs'), sha = 'a'.repeat(64);
  return {sourcePins: {[file]: sha}, sourceProof: {roots: [{id: 'source', path: root, nodeId: '1:1'}],
    rows: [{rootId: 'source', relativePath: 'source.cjs', expected: {nodeId: '1:2', bytes: '10', links: 1, sha256: sha}}],
    epoch: 1, hostGeneration: 'fixed-host'}, excludedPaths: [path.resolve('scope-own-control', 'reviewed.json')]};
}
test('exact approved source scope returns detached coordinator options without accessing files', () => {
  const value = fixture(), output = validate(value); assert.deepEqual(output, value.sourceProof);
  value.sourceProof.rows[0].expected.sha256 = 'b'.repeat(64); value.sourceProof.roots[0].path = 'changed';
  assert.equal(output.rows[0].expected.sha256, 'a'.repeat(64)); assert.notEqual(output.roots[0].path, 'changed');
});
test('missing, extra and wrong-hash source rows cannot replace the approved complete set', () => {
  for (const change of [v => {v.sourcePins[path.join(v.sourceProof.roots[0].path, 'extra.cjs')] = 'a'.repeat(64);},
    v => {v.sourceProof.rows[0].relativePath = 'unknown.cjs';},
    v => {v.sourceProof.rows[0].expected.sha256 = 'b'.repeat(64);}]) {
    const v = fixture(); change(v); assert.throws(() => validate(v), /SCOPE_PIN_MISMATCH/);
  }
});
test('all roots are used, disjoint and unambiguous including filesystem root', () => {
  for (const extra of [v => path.join(v.sourceProof.roots[0].path, 'nested'), v => path.parse(v.sourceProof.roots[0].path).root,
    v => v.sourceProof.roots[0].path]) {
    const v = fixture(); v.sourceProof.roots.push({id: 'second', path: extra(v), nodeId: '1:3'});
    assert.throws(() => validate(v), /SCOPE_OVERLAPPING_ROOTS/);
  }
  const v = fixture(); v.sourceProof.roots.push({id: 'unused', path: path.resolve('other-scope'), nodeId: '1:3'});
  assert.throws(() => validate(v), /SCOPE_UNUSED_ROOT/);
});
test('current mutable outputs are excluded exactly; immutable baseline remains permitted', () => {
  const v = fixture(); v.excludedPaths.push(Object.keys(v.sourcePins)[0]); assert.throws(() => validate(v), /SCOPE_MUTABLE_SOURCE/);
  const b = fixture(), baseline = path.join(b.sourceProof.roots[0].path, 'BASELINE.json');
  b.sourcePins = {[baseline]: 'a'.repeat(64)}; b.sourceProof.rows[0].relativePath = 'BASELINE.json';
  assert.equal(validate(b).rows[0].relativePath, 'BASELINE.json');
});
test('sparse, accessor, prototype and extra-field inputs fail without invoking accessors', () => {
  for (const change of [v => {delete v.sourceProof.rows[0];}, v => {v.sourceProof.rows.push(v.sourceProof.rows[0]);},
    v => {v.sourcePins = Object.create({inherited: 'a'.repeat(64)});}, v => {v.extra = true;},
    v => {v.sourceProof.override = true;}, v => {v.excludedPaths = new Array(1);},
    v => {Object.defineProperty(v.sourcePins, Object.keys(v.sourcePins)[0], {get() {throw Error('ACCESSOR_INVOKED');}, enumerable: true});}]) {
    const v = fixture(); change(v); assert.throws(() => validate(v), error => /^FILE_PROOF_/.test(error.message));
  }
});
test('fixed count and underlying row, byte, epoch and timeout caps are retained', () => {
  for (const change of [v => {v.sourcePins = Object.fromEntries(Array.from({length: 4097}, (_, i) => [path.resolve(`source-${i}.cjs`), 'a'.repeat(64)]));},
    v => {v.excludedPaths = Array.from({length: 257}, (_, i) => path.resolve(`excluded-${i}`));},
    v => {v.sourceProof.rows[0].expected.bytes = String(8 * 1024 ** 3 + 1);}, v => {v.sourceProof.epoch = 0;},
    v => {v.sourceProof.timeoutMs = 120001;}, v => {v.sourceProof.hostGeneration = 'invalid host';}]) {
    const v = fixture(); change(v); assert.throws(() => validate(v), /^Error: FILE_PROOF_/);
  }
  const v = fixture(); v.sourceProof.timeoutMs = 1234; assert.equal(validate(v).timeoutMs, 1234);
});
test('dot segments, relative or malformed source paths and duplicate exclusions are rejected', () => {
  for (const name of ['relative.cjs', path.join(fixture().sourceProof.roots[0].path, 'nested') + path.sep + '..' + path.sep + 'source.cjs', path.resolve('bad') + '\n']) {
    const v = fixture(); v.sourcePins = {[name]: 'a'.repeat(64)}; assert.throws(() => validate(v), /SCOPE_INVALID_PATH/);
  }
  const v = fixture(); v.excludedPaths.push(v.excludedPaths[0]); assert.throws(() => validate(v), /DUPLICATE_EXCLUSION/);
});
test('Windows aliases collapse exactly, conflicting aliases and case-aliased controls fail', {skip: process.platform !== 'win32'}, () => {
  const v = fixture(), file = Object.keys(v.sourcePins)[0];
  v.sourcePins[file.toUpperCase().replaceAll('\\', '/')] = 'a'.repeat(64);
  assert.equal(validate(v).rows.length, 1);
  v.sourcePins[file.toUpperCase().replaceAll('\\', '/')] = 'b'.repeat(64); assert.throws(() => validate(v), /ALIAS_CONFLICT/);
  const excluded = fixture(); excluded.excludedPaths.push(file.toUpperCase().replaceAll('\\', '/'));
  assert.throws(() => validate(excluded), /MUTABLE_SOURCE/);
});

test('Family-shaped 55 raw aliases resolve to exactly54 independently described source rows', {skip: process.platform !== 'win32'}, () => {
  const v = fixture(), root = v.sourceProof.roots[0].path;
  v.sourcePins = {}; v.sourceProof.rows = [];
  for (let i = 0; i < 54; i++) {
    const name = `source-${i}.cjs`; v.sourcePins[path.join(root, name)] = 'a'.repeat(64);
    v.sourceProof.rows.push({rootId: 'source', relativePath: name,
      expected: {nodeId: `1:${i + 2}`, bytes: '10', links: 1, sha256: 'a'.repeat(64)}});
  }
  v.sourcePins[path.join(root, 'source-0.cjs').toUpperCase().replaceAll('\\', '/')] = 'a'.repeat(64);
  assert.equal(Object.keys(v.sourcePins).length, 55); assert.equal(validate(v).rows.length, 54);
  v.sourceProof.rows.pop(); assert.throws(() => validate(v), /PIN_MISMATCH/);
});

for (const suffix of ['.', ' ', ':stream']) {
  test(`Windows mutable exclusion rejects ambiguous component suffix ${JSON.stringify(suffix)}`, {skip: process.platform !== 'win32'}, () => {
    const v = fixture(); v.excludedPaths.push(Object.keys(v.sourcePins)[0] + suffix);
    assert.throws(() => validate(v), /SCOPE_INVALID_PATH/);
  });
}
test('Windows rejects aliased ancestors, DOS devices and rooted-current-drive descriptors before normalization', {skip: process.platform !== 'win32'}, () => {
  for (const bad of ['C:/own-source./source.cjs', 'C:/own-source /source.cjs', 'C:/CON/source.cjs',
    'C:/own/NUL.txt', 'C:/own/com1', 'C:/own/LPT9.log', 'C:/own/aux', 'C:/own/PRN',
    'C:/own/COM\u00b9.txt', 'C:/own/LPT\u00b2', '//server/share./source.cjs', '//server/CON/source.cjs']) {
    const v = fixture(); v.excludedPaths.push(bad); assert.throws(() => validate(v), /SCOPE_INVALID_PATH/, bad);
  }
  const v = fixture(); v.sourceProof.roots[0].path = path.sep + path.basename(v.sourceProof.roots[0].path);
  assert.throws(() => validate(v), /SCOPE_INVALID_PATH/);
});
test('more than eight roots and public platform override are refused', () => {
  const v = fixture(); v.sourceProof.roots = Array.from({length: 9}, (_, i) => ({id: `r${i}`, path: path.resolve(`root${i}`), nodeId: `1:${i + 1}`}));
  assert.throws(() => validate(v), /^Error: FILE_PROOF_/);
  const override = fixture(); override.platform = 'linux'; assert.throws(() => validate(override), /SCOPE_INVALID_OPTIONS/);
});

test('oversized exclusion list is rejected before enumerating its properties', () => {
  const v = fixture(); let enumerated = false;
  v.excludedPaths = new Proxy(new Array(257), {ownKeys() {enumerated = true; throw Error('UNEXPECTED_ENUMERATION');}});
  assert.throws(() => validate(v), /SCOPE_EXCLUSION_LIMIT/); assert.equal(enumerated, false);
});
test('fully qualified UNC descriptors retain exact source membership without discovery', {skip: process.platform !== 'win32'}, () => {
  const v = fixture(); v.sourceProof.roots[0].path = '//server/share/own-source';
  v.sourcePins = {'\\\\SERVER\\SHARE\\own-source\\source.cjs': 'a'.repeat(64)};
  assert.equal(validate(v).rows.length, 1);
  v.sourceProof.roots[0].path = '//server'; assert.throws(() => validate(v), /SCOPE_INVALID_PATH/);
});

test('owned scope sources decode as strict UTF-8', () => {
  const fs = require('node:fs'), {TextDecoder} = require('node:util');
  for (const name of ['helper-source-scope.cjs', 'helper-source-scope.test.cjs']) {
    assert.doesNotThrow(() => new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(path.join(__dirname, name))));
  }
});
test('actual runtime superscript DOS device spellings are rejected', {skip: process.platform !== 'win32'}, () => {
  for (const name of ['COM\u00b9.log', 'COM\u00b2.log', 'COM\u00b3.log', 'LPT\u00b9', 'LPT\u00b2', 'LPT\u00b3']) {
    const v = fixture(); v.excludedPaths.push('C:/own/' + name);
    assert.throws(() => validate(v), /SCOPE_INVALID_PATH/, name);
  }
});
