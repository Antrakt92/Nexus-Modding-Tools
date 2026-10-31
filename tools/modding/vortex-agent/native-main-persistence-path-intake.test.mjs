import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-tests-2.9.1/', import.meta.url);
const manifestBytes = fs.readFileSync(new URL('main-persistence-path-intake.json', base));
const manifest = JSON.parse(manifestBytes);
const patch = fs.readFileSync(new URL('main-persistence-path-intake.patch', base), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const additions = hunks(patch, manifest.upstreamPath).flatMap(h => h.body)
  .filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';

test('closed test-only packet adds one fail-closed path mock and removes no upstream bytes', () => {
  assert.equal(sha(patch), manifest.patchSHA256);
  assert.equal(manifest.upstreamGitBlob, '790a785de77cc13f6180ee5c3dd9107468f6b58c');
  assert.equal(manifest.inputSHA256, 'c0dde906e1cf4693c77d9478933e881a2f439909aa0e77eed5a0901c3a0f3e76');
  assert.equal(manifest.testOnly, true);
  assert.equal(manifest.testBodiesAndExpectationsUnchanged, true);
  for (const field of ['installed', 'nativeAcceptanceVerified', 'installationPermit']) assert.equal(manifest[field], false);
  assert.equal(hunks(patch, manifest.upstreamPath).flatMap(h => h.body).some(line => line.startsWith('-')), false);
  assert.equal(sha(additions), manifest.insertionSHA256);
  assert.equal((additions.match(/vi\.mock\(/g) ?? []).length, 1);
});

test('actual inserted mock is lazy, exposes only path lookup and throws on every unexpected use', () => {
  const registrations = [];
  vm.runInNewContext(additions, {vi: {mock: (name, factory) => registrations.push({name, factory})}}, {timeout: 1000});
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, '../getVortexPath');
  const exports = registrations[0].factory();
  assert.deepEqual(Object.keys(exports), ['getVortexPath']);
  for (const args of [[], ['base'], ['arbitrary']]) {
    assert.throws(() => exports.getVortexPath(...args), {message: 'Native path lookup is outside this unit suite'});
  }
});

test('exact official test prefix and entire test suffix remain byte-identical', {
  skip: process.env.VORTEX_EXTENSION_ADMISSION_REPO ? false : 'Set VORTEX_EXTENSION_ADMISSION_REPO to pinned official cache',
}, () => {
  const original = execFileSync('git', ['-C', process.env.VORTEX_EXTENSION_ADMISSION_REPO,
    'show', `${manifest.upstreamCommit}:${manifest.upstreamPath}`], {maxBuffer: 2 * 1024 * 1024});
  assert.equal(sha(original), manifest.inputSHA256);
  const output = Buffer.from(applyExact(original.toString(), patch, manifest.upstreamPath));
  assert.equal(sha(output), manifest.outputSHA256);
  const offset = manifest.insertionByteOffset;
  assert.equal(sha(original.subarray(0, offset)), manifest.preservedPrefixSHA256);
  assert.equal(sha(original.subarray(offset)), manifest.preservedSuffixSHA256);
  assert.deepEqual(output.subarray(0, offset), original.subarray(0, offset));
  assert.deepEqual(output.subarray(offset, offset + Buffer.byteLength(additions)), Buffer.from(additions));
  assert.deepEqual(output.subarray(offset + Buffer.byteLength(additions)), original.subarray(offset));
  assert.equal(output.toString().indexOf('vi.mock("../getVortexPath"'), offset + additions.indexOf('vi.mock'));
});
