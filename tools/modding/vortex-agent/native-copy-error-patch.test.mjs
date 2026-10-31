import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

import {fixture, failure, SelfCopyCheckError} from './native-transfer-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('copy-error.json', base)));
const patch = readFileSync(new URL('copy-error.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: sourcePath ? false : 'Set VORTEX_NATIVE_INSTALL_MANAGER to the exact original InstallManager.ts'}, fn);
let cached;
function sources() {
  if (cached) return cached;
  const raw = readFileSync(sourcePath); assert.equal(hash(raw), manifest.originalSourceSHA256);
  let input = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  for (const name of ['ordinary-tracking', 'callback-order', 'native-activity', 'strict-selection']) {
    const m = JSON.parse(readFileSync(new URL(name + '.json', base)));
    const p = readFileSync(new URL(name + '.patch', base), 'utf8');
    assert.equal(hash(input), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
    input = applyExact(input, p, manifest.upstreamPath); assert.equal(hash(input), m.outputSHA256);
  }
  assert.equal(hash(input), manifest.inputSHA256);
  const patched = applyExact(input, patch, manifest.upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256);
  cached = {input, patched}; return cached;
}
test('copy-error patch pins the ordered source and makes no native safety claim', () => {
  const previous = JSON.parse(readFileSync(new URL('strict-selection.json', base)));
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/Vortex');
  assert.equal(manifest.upstreamTag, 'v2.9.1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.prerequisitePatch, 'strict-selection.patch');
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  assert.equal(manifest.inputSHA256, previous.outputSHA256);
  assert.equal(hash(patch), manifest.patchSHA256); assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee',
    'noReplacementGuarantee', 'importNoClobberGuarantee', 'ownerReservationGuarantee', 'installationPermit']) assert.equal(manifest[key], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r'));
});
integration('baseline silently resolves a failed copy while repaired transfer rejects the exact error', async () => {
  const {input, patched} = sources(), error = failure('ENOSPC');
  const before = fixture(input, {linkError: failure('EXDEV'), copyError: error});
  await before.run(); assert.equal(before.calls.filter(c => c[0] === 'copy').length, 1);
  const after = fixture(patched, {linkError: failure('EXDEV'), copyError: error});
  await assert.rejects(after.run(), value => value === error);
});
integration('every ordinary copy failure propagates through every recognized fallback branch', async () => {
  const source = sources().patched;
  for (const linkCode of ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EEXIST', 'EISDIR']) {
    for (const copyCode of ['ENOSPC', 'EACCES', 'EIO', 'ENOENT']) {
      const error = failure(copyCode), f = fixture(source, {linkError: failure(linkCode), copyError: error});
      await assert.rejects(f.run(), value => value === error);
      assert.equal(f.calls.filter(c => c[0] === 'copy').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'remove').length, ['EEXIST', 'EISDIR'].includes(linkCode) ? 1 : 0);
    }
  }
});
integration('successful hardlinks, fallback copies and legacy self-copy exceptions remain unchanged', async () => {
  const {input, patched} = sources();
  for (const source of [input, patched]) {
    const linked = fixture(source); await linked.run(); assert(!linked.calls.some(c => c[0] === 'copy'));
    const copied = fixture(source, {linkError: failure('EXDEV')}); await copied.run();
    assert.equal(copied.calls.filter(c => c[0] === 'copy').length, 1);
    for (const error of [new SelfCopyCheckError('same'), failure('EINVAL', 'Source and destination must not be the same')]) {
      const self = fixture(source, {linkError: failure('EXDEV'), copyError: error}); await self.run();
      assert.equal(self.calls.filter(c => c[0] === 'copy').length, 1);
    }
  }
});
integration('non-Error copy rejections retain their identity instead of turning into success', async () => {
  for (const error of [null, undefined, 'COPY_FAILED', {code: 'EIO'}]) {
    const f = fixture(sources().patched, {linkError: failure('EXDEV'), copy: async () => {throw error;}});
    let resolved = false, observed = Symbol('not observed');
    await f.run().then(() => {resolved = true;}, value => {observed = value;});
    assert.equal(resolved, false); assert.equal(observed, error);
  }
});
integration('directory, unknown-link and removal errors still propagate without a second transfer', async () => {
  for (const options of [{mkdirError: failure('ENOSPC')}, {linkError: failure('EIO')},
    {linkError: failure('EEXIST'), removeError: failure('EPERM')}]) {
    const f = fixture(sources().patched, options);
    await assert.rejects(f.run(), value => value === (options.mkdirError ?? options.removeError ?? options.linkError));
    assert(!f.calls.some(c => c[0] === 'copy'));
  }
});
integration('missing-source warning behavior stays explicit and does not acquire an ownership guarantee', async () => {
  for (const source of Object.values(sources())) {
    const f = fixture(source, {linkError: failure('ENOENT')}); await f.run();
    assert.equal(f.notifications.length, 1); assert(!f.calls.some(c => c[0] === 'copy'));
  }
});
integration('rejection is not termination of other in-flight transfer workers', async () => {
  let release, entered = false, ended = false;
  const waiting = new Promise(resolve => {release = resolve;});
  const error = failure('ENOSPC');
  const f = fixture(sources().patched, {linkError: failure('EXDEV'), copy: async src => {
    if (src.endsWith('a.txt')) throw error;
    entered = true; await waiting; ended = true;
  }});
  await assert.rejects(f.run([{source: 'a.txt', destination: 'a.txt'}, {source: 'b.txt', destination: 'b.txt'}]), value => value === error);
  assert.equal(entered, true); assert.equal(ended, false);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, true);
});
