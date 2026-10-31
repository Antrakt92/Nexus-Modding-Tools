import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';
import {fixture, failure, SelfCopyCheckError} from './native-transfer-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('transfer-join.json', base)));
const patch = readFileSync(new URL('transfer-join.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: sourcePath ? false : 'Set VORTEX_NATIVE_INSTALL_MANAGER to the exact original InstallManager.ts'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function observed(promise) {
  const result = {state: 'pending'};
  const done = promise.then(() => {result.state = 'resolved';}, error => {result.state = 'rejected'; result.error = error;});
  return {result, done};
}
let cached;
function sources() {
  if (cached) return cached;
  const raw = readFileSync(sourcePath); assert.equal(hash(raw), manifest.originalSourceSHA256);
  let input = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  for (const name of ['ordinary-tracking', 'callback-order', 'native-activity', 'strict-selection', 'copy-error']) {
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
test('transfer join is pinned only to extractArchive and grants no native terminal permission', () => {
  const previous = JSON.parse(readFileSync(new URL('copy-error.json', base)));
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/Vortex');
  assert.equal(manifest.upstreamTag, 'v2.9.1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.prerequisitePatch, 'copy-error.patch');
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  assert.equal(manifest.inputSHA256, previous.outputSHA256); assert.equal(hash(patch), manifest.patchSHA256);
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee',
    'noReplacementGuarantee', 'importNoClobberGuarantee', 'ownerReservationGuarantee', 'installationPermit']) assert.equal(manifest[key], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r'));
});
integration('global dependency/cancellation helper and copy-error repair stay byte-identical', () => {
  const {input, patched} = sources();
  for (const [start, end] of [['async function mapWithConcurrency<', '/**\n * central class'],
    ['    const copyAsyncWrap =', '    const folderCopies:']]) {
    const part = text => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
    assert.equal(part(input), part(patched)); assert(part(input).length > 100);
  }
});
integration('baseline rejects before another copy ends; joined transfer delays caller cleanup', async () => {
  const {input, patched} = sources();
  for (const [name, source] of Object.entries({input, patched})) {
    const gate = deferred(), first = failure('ENOSPC'); let secondStarted = false, callerCleanup = false;
    const f = fixture(source, {linkError: failure('EXDEV'), copy: async src => {
      if (src.endsWith('a.txt')) throw first;
      secondStarted = true; await gate.promise;
    }});
    const run = observed(f.run([{source: 'a.txt', destination: 'a.txt'}, {source: 'b.txt', destination: 'b.txt'}])
      .finally(() => {callerCleanup = true;}));
    await tick(); assert.equal(secondStarted, true);
    assert.equal(run.result.state, name === 'input' ? 'rejected' : 'pending');
    assert.equal(callerCleanup, name === 'input');
    gate.resolve(); await run.done; assert.equal(run.result.error, first); assert.equal(callerCleanup, true);
  }
});
integration('mkdir failure joins the other mkdir and never starts file transfers', async () => {
  const gate = deferred(), first = failure('EACCES'); let otherStarted = false;
  const f = fixture(sources().patched, {mkdir: async name => {
    if (name.endsWith('\\a')) throw first;
    otherStarted = true; await gate.promise;
  }});
  const run = observed(f.run([{source: 'a.txt', destination: 'a/a.txt'}, {source: 'b.txt', destination: 'b/b.txt'}]));
  await tick(); assert(otherStarted); assert.equal(run.result.state, 'pending');
  assert(!f.calls.some(c => c[0] === 'link'));
  gate.resolve(); await run.done; assert.equal(run.result.error, first);
  assert(!f.calls.some(c => c[0] === 'link'));
});
integration('an observed error stops queued transfers while all running callbacks finish', async () => {
  const gate = deferred(), first = failure('ENOSPC');
  const f = fixture(sources().patched, {linkError: failure('EXDEV'), copy: async src => {
    if (src.endsWith('file-000.txt')) throw first;
    await gate.promise;
  }});
  const copies = Array.from({length: 64}, (_, n) => ({source: `file-${String(n).padStart(3, '0')}.txt`, destination: `file-${String(n).padStart(3, '0')}.txt`}));
  const run = observed(f.run(copies)); await tick();
  const started = f.calls.filter(c => c[0] === 'copy').length;
  assert(started > 1 && started <= 16); assert.equal(run.result.state, 'pending');
  gate.resolve(); await run.done; assert.equal(run.result.error, first);
  assert.equal(f.calls.filter(c => c[0] === 'copy').length, started);
  assert.equal(f.calls.filter(c => c[0] === 'link').length, started);
});
integration('first observed error survives later errors including null and undefined', async () => {
  for (const first of [undefined, null, 'COPY_FAILED', failure('ENOSPC')]) {
    const a = deferred(), b = deferred();
    const f = fixture(sources().patched, {linkError: failure('EXDEV'), copy: src => src.endsWith('a.txt') ? a.promise : b.promise});
    const run = observed(f.run([{source: 'a.txt', destination: 'a.txt'}, {source: 'b.txt', destination: 'b.txt'}]));
    await tick(); b.reject(first); await tick(); assert.equal(run.result.state, 'pending');
    a.reject(failure('LATER')); await run.done;
    assert.equal(run.result.state, 'rejected'); assert.equal(run.result.error, first);
  }
});
integration('synchronous mkdir failure stops further callbacks and retains non-Error rejection', async () => {
  let invoked = 0;
  const f = fixture(sources().patched, {mkdir: () => {invoked++; throw undefined;}});
  const run = observed(f.run(Array.from({length: 12}, (_, n) => ({source: 'x', destination: `d${n}/x`}))));
  await run.done; assert.equal(invoked, 1); assert.equal(run.result.state, 'rejected'); assert.equal(run.result.error, undefined);
  assert(!f.calls.some(c => c[0] === 'link'));
});
integration('successful queues preserve once-only processing, order and existing concurrency caps', async () => {
  let dirs = 0, maxDirs = 0, links = 0, maxLinks = 0;
  const f = fixture(sources().patched, {cpus: 1,
    mkdir: async () => {maxDirs = Math.max(maxDirs, ++dirs); await tick(); dirs--;},
    link: async () => {maxLinks = Math.max(maxLinks, ++links); await tick(); links--;}});
  const copies = Array.from({length: 24}, (_, n) => ({source: `f${n}.txt`, destination: `d${n}/f${n}.txt`}));
  await f.run(copies);
  const transfers = f.calls.filter(c => c[0] === 'link');
  assert.equal(transfers.length, 24); assert.equal(new Set(transfers.map(c => c[1])).size, 24);
  assert(maxDirs > 1 && maxDirs <= 4); assert(maxLinks > 1 && maxLinks <= 8);
  assert.equal(dirs, 0); assert.equal(links, 0);
  assert(!f.calls.some(c => c[0] === 'copy'));
  assert.equal(f.calls.filter(c => c[0] === 'mkdir').length, 24);
});
integration('empty transfers and successful/self-copy fallback behavior remain supported', async () => {
  const source = sources().patched, empty = fixture(source); await empty.run([]);
  assert(!empty.calls.some(c => ['mkdir', 'link', 'copy', 'remove'].includes(c[0])));
  for (const options of [{linkError: failure('EXDEV')},
    {linkError: failure('EXDEV'), copyError: new SelfCopyCheckError('same')},
    {linkError: failure('EXDEV'), copyError: failure('EINVAL', 'Source and destination must differ')}]) {
    const f = fixture(source, options); await f.run(); assert.equal(f.calls.filter(c => c[0] === 'copy').length, 1);
  }
});
