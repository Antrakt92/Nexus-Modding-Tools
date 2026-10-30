import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createFileProofClient, _createFileProofClientForTests } from './file-proof-client.mjs';
import core from './file-proof-worker.cjs';

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t, content = Buffer.from('payload')) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'file-proof-test-')), root = path.join(workspace, 'data'); fs.mkdirSync(root);
  const file = path.join(root, 'file.bin'); fs.writeFileSync(file, content);
  const rootStat = fs.lstatSync(root, { bigint: true });
  const roots = [{ id: 'stage', path: root, nodeId: core.identity(rootStat) }];
  t.after(() => fs.rmSync(workspace, { recursive: true }));
  const row = (relativePath = 'file.bin') => {
    const target = path.join(root, relativePath), stat = fs.lstatSync(target, { bigint: true });
    return { rootId: 'stage', relativePath, expected: { nodeId: core.identity(stat), bytes: String(stat.size), links: Number(stat.nlink), sha256: hash(fs.readFileSync(target)) } };
  };
  return { workspace, root, file, roots, row, options: { roots, epoch: 1, hostGeneration: 'node-test-generation' } };
}
function config(f) { return core.validateConfig({ protocol: core.PROTOCOL, nonce: 'a'.repeat(32), ...f.options }); }
function request(cfg, rows, fresh = false) {
  const checked = core.validateRows(rows, cfg.roots);
  return { protocol: core.PROTOCOL, nonce: cfg.nonce, epoch: cfg.epoch, hostGeneration: cfg.hostGeneration,
    rootsDigest: core.digest(cfg.roots), requestId: 'b'.repeat(32), listDigest: core.digest(checked), fresh, rows: checked };
}
function fake(options, transform = value => value, behavior) {
  let instance, captured;
  const client = _createFileProofClientForTests(options, (file, workerOptions) => {
    captured = { file, options: workerOptions }; const engine = core.createProofEngine(workerOptions.workerData);
    instance = new EventEmitter(); instance.terminated = 0;
    instance.terminate = () => { instance.terminated++; return Promise.resolve(0); };
    instance.postMessage = message => {
      if (behavior) { behavior(instance, message); return; }
      queueMicrotask(() => {
        let value;
        try { value = engine(message); }
        catch (error) { value = { protocol: message.protocol, nonce: message.nonce, epoch: message.epoch, hostGeneration: message.hostGeneration,
          rootsDigest: message.rootsDigest, requestId: message.requestId, listDigest: message.listDigest, fresh: message.fresh, ok: false, error: core.safeCode(error) }; }
        instance.last = value; instance.emit('message', transform(value, message));
      });
    };
    return instance;
  });
  return { client, instance: () => instance, captured: () => captured };
}

test('fixed real worker proves bytes and uses checkpoint-local cache, with explicit fresh bypass', async t => {
  const f = fixture(t), client = createFileProofClient(f.options); t.after(() => client.close());
  const rows = [f.row()], cold = await client.prove(rows), warm = await client.prove(rows), fresh = await client.prove(rows, { fresh: true });
  assert.deepEqual(cold.proofs.map(({ mtimeNs, ctimeNs, rootId, relativePath, ...p }) => p), rows.map(r => r.expected));
  assert.deepEqual(cold.metrics, { reads: 1, hashes: 1, cacheHits: 0, bytesHashed: 7 });
  assert.equal(warm.metrics.hashes, 0); assert.equal(warm.metrics.cacheHits, 1); assert.equal(fresh.metrics.hashes, 1);
  for (const value of [cold, warm, fresh]) {
    assert.equal(value.hostCompatibilityVerified, false); assert.equal(value.effectsAllowed, false);
    assert.equal(value.diskDeploymentVerified, false); assert.equal(value.directoryInventoryVerified, false);
  }
});
test('hardlink aliases share a hash within cold/fresh batches while all paths receive observations', async t => {
  const f = fixture(t); fs.linkSync(f.file, path.join(f.root, 'alias.bin'));
  const client = createFileProofClient(f.options); t.after(() => client.close()); const rows = [f.row(), f.row('alias.bin')];
  for (const fresh of [false, true]) {
    const result = await client.prove(rows, { fresh });
    assert.deepEqual(result.metrics, { reads: 2, hashes: 1, cacheHits: 1, bytesHashed: 7 });
  }
});
test('mtime-only changes, content changes and hardlink-count changes invalidate generations', async t => {
  const f = fixture(t), client = createFileProofClient(f.options); t.after(() => client.close());
  await client.prove([f.row()]); fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await client.prove([f.row()])).metrics.hashes, 1);
  fs.writeFileSync(f.file, 'changed'); assert.equal((await client.prove([f.row()])).metrics.hashes, 1);
  fs.linkSync(f.file, path.join(f.root, 'other.bin')); assert.equal((await client.prove([f.row()])).metrics.hashes, 1);
});
test('the worker streams descriptor bytes away from the main thread and keeps the event loop responsive', async t => {
  const f = fixture(t, Buffer.alloc(16 * 1024 * 1024, 3)), rows = [f.row()];
  const client = createFileProofClient(f.options); t.after(() => client.close());
  const read = fs.readSync; let ticks = 0; const timer = setInterval(() => ticks++, 2);
  fs.readSync = () => { throw Error('MAIN_THREAD_FILE_CONTENT_READ'); };
  let result;
  try { result = await client.prove(rows); }
  finally { fs.readSync = read; clearInterval(timer); }
  assert.equal(result.metrics.bytesHashed, 16 * 1024 * 1024); assert(ticks > 0);
});
test('dense arrays and fixed production options reject holes, accessors and arbitrary worker configuration', async t => {
  const f = fixture(t), cfg = config(f);
  assert.throws(() => createFileProofClient({ ...f.options, roots: Array(1) }), /FILE_PROOF_INVALID_CONFIG/);
  for (const extra of ['workerFactory', 'workerPath', 'eval', 'env', 'execArgv'])
    assert.throws(() => createFileProofClient({ ...f.options, [extra]: true }), /FILE_PROOF_INVALID_OPTIONS/);
  for (const rows of [Array(1), Object.assign([f.row()], { extra: true }), Object.defineProperty([f.row()], 0, { get: () => f.row() })])
    assert.throws(() => core.validateRows(rows, cfg.roots), /FILE_PROOF_ROW_LIMIT/);
  const client = createFileProofClient(f.options); t.after(() => client.close());
  await assert.rejects(client.prove(Array(1)), /FILE_PROOF_ROW_LIMIT/); await assert.rejects(client.prove([f.row()]), /FILE_PROOF_POISONED/);
});
test('fixed caps reject oversized declarations and unsafe paths before hashing or dispatch', () => {
  const root = { id: 'stage', path: path.resolve(os.tmpdir()), nodeId: '1:2' };
  const row = { rootId: 'stage', relativePath: 'file', expected: { nodeId: '1:3', bytes: '1', links: 1, sha256: 'a'.repeat(64) } };
  assert.throws(() => core.validateRows(Array.from({ length: core.LIMITS.rows + 1 }, () => row), [root]), /FILE_PROOF_ROW_LIMIT/);
  assert.throws(() => core.validateRows([{ ...row, expected: { ...row.expected, bytes: String(core.LIMITS.fileBytes + 1) } }], [root]), /FILE_PROOF_INVALID_EXPECTATION/);
  assert.throws(() => core.validateRows(Array.from({ length: 5 }, (_, n) => ({ ...row, relativePath: `f${n}`, expected: { ...row.expected, bytes: String(core.LIMITS.fileBytes) } })), [root]), /FILE_PROOF_BYTE_LIMIT/);
  for (const relativePath of ['../escape', '/absolute', 'NUL.txt', 'a:stream', 'a\\b', 'a//b', 'a/./b', 'a/' + 'x'.repeat(256)])
    assert.throws(() => core.validateRows([{ ...row, relativePath }], [root]), /FILE_PROOF_INVALID_PATH/);
  assert.throws(() => core.validateRows([row, row], [root]), /FILE_PROOF_DUPLICATE_PATH/);
  assert.throws(() => core.validateRows([{ ...row, expected: { ...row.expected, nodeId: '0:0' } }], [root]), /FILE_PROOF_INVALID_EXPECTATION/);
});
test('worker initialization receives no inherited environment/preloads or arbitrary entrypoint', async t => {
  const f = fixture(t), holder = fake(f.options); t.after(() => holder.client.close());
  await holder.client.prove([f.row()]); const captured = holder.captured();
  assert.equal(path.basename(captured.file), 'file-proof-worker.cjs'); assert.deepEqual(captured.options.env, {});
  assert.deepEqual(captured.options.execArgv, []); assert.equal(captured.options.trackUnmanagedFds, true);
  assert(captured.options.resourceLimits.maxOldGenerationSizeMb <= 96);
});
test('constructor errors are sanitized and Electron remains explicitly unsupported', t => {
  const f = fixture(t);
  assert.throws(() => createFileProofClient({ ...f.options, roots: [{ ...f.roots[0], path: path.join(f.workspace, 'private-missing-path') }] }),
    error => /^FILE_PROOF_[A-Z_]+$/.test(error.message) && !error.message.includes('private-missing-path'));
  const prior = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'unverified-fixture' });
  try { assert.throws(() => createFileProofClient(f.options), /FILE_PROOF_ELECTRON_UNVERIFIED/); }
  finally { if (prior) Object.defineProperty(process.versions, 'electron', prior); else delete process.versions.electron; }
});
test('during-stream mutation or replacement cannot seed an accepted physical proof', t => {
  for (const mode of ['bytes', 'leaf-replace', 'parent-replace', 'new-hardlink']) {
    const f = fixture(t, Buffer.alloc(128 * 1024, 1));
    const nested = path.join(f.root, 'nested'); fs.mkdirSync(nested); fs.renameSync(f.file, path.join(nested, 'file.bin'));
    const file = path.join(nested, 'file.bin'), cfg = config(f), rows = [f.row('nested/file.bin')], engine = core.createProofEngine(cfg);
    const read = fs.readSync, stat = fs.lstatSync; let changed = false;
    // Windows denies renaming an ancestor containing an opened file. Inject the
    // changed physical observation instead, exercising the exact rejection seam.
    if (mode === 'parent-replace') fs.lstatSync = (...args) => {
      const value = stat(...args);
      return changed && args[0] === nested ? new Proxy(value, { get(target, key) {
        if (key === 'ino') return target.ino + 1n;
        const field = target[key]; return typeof field === 'function' ? field.bind(target) : field;
      } }) : value;
    };
    fs.readSync = (...args) => {
      const count = read(...args);
      if (count > 0 && !changed) {
        changed = true;
        if (mode === 'bytes') { fs.writeFileSync(file, Buffer.alloc(128 * 1024, 2)); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); }
        if (mode === 'leaf-replace') { fs.renameSync(file, file + '-old'); fs.writeFileSync(file, Buffer.alloc(128 * 1024, 1)); }
        // parent-replace changes the observation after this read via lstat above.
        if (mode === 'new-hardlink') fs.linkSync(file, path.join(f.root, 'extra-link'));
      }
      return count;
    };
    try { assert.throws(() => engine(request(cfg, rows)), /FILE_PROOF_FILE_CHANGED|FILE_PROOF_ANCESTOR_CHANGED|PHYSICAL_PROOF_CHANGED/); }
    finally { fs.readSync = read; fs.lstatSync = stat; }
    assert.equal(changed, true);
  }
});
test('reparse roots and leaves never become accepted regular-file proofs', async t => {
  const f = fixture(t), alias = path.join(f.workspace, 'alias'); fs.symlinkSync(f.root, alias, 'junction');
  assert.throws(() => createFileProofClient({ ...f.options, roots: [{ ...f.roots[0], path: alias }] }), /FILE_PROOF_UNSAFE_ANCESTOR/);
  const old = f.row(); fs.symlinkSync(f.file, path.join(f.root, 'link.bin'));
  const client = createFileProofClient(f.options); t.after(() => client.close());
  await assert.rejects(client.prove([{ ...old, relativePath: 'link.bin' }]), /FILE_PROOF_NONREGULAR/);
});
test('parent resampling refuses metadata/root changes after worker completion and before acceptance', async t => {
  for (const mode of ['mtime', 'root']) {
    const f = fixture(t), rows = [f.row()], holder = fake(f.options, value => {
      if (mode === 'mtime') fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
      else { fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root); fs.writeFileSync(f.file, 'payload'); }
      return value;
    });
    t.after(() => holder.client.close());
    await assert.rejects(holder.client.prove(rows), /FILE_PROOF_STALE_RESULT|FILE_PROOF_ANCESTOR_CHANGED/);
    await assert.rejects(holder.client.prove(rows), /FILE_PROOF_POISONED/); assert.equal(holder.instance().terminated, 1);
  }
});
test('every stale binding, extra field, missing/extra/sparse row and changed proof poisons the checkpoint', async t => {
  const changes = [v => { v.nonce = '0'.repeat(32); }, v => { v.epoch++; }, v => { v.hostGeneration = 'other'; },
    v => { v.rootsDigest = '0'.repeat(64); }, v => { v.requestId = '0'.repeat(32); }, v => { v.listDigest = '0'.repeat(64); },
    v => { v.extra = true; }, v => { v.proofs = []; }, v => { v.proofs.push(v.proofs[0]); }, v => { v.proofs = Array(1); },
    v => { v.proofs[0].sha256 = '0'.repeat(64); }, v => { v.proofs[0].mtimeNs = 'bad'; },
    v => { v.metrics.hashes = 999; }, v => { v.effectsAllowed = true; }];
  for (const change of changes) {
    const f = fixture(t), rows = [f.row()], holder = fake(f.options, value => { change(value); return value; });
    t.after(() => holder.client.close());
    await assert.rejects(holder.client.prove(rows), /FILE_PROOF_STALE_REPLY|FILE_PROOF_MALFORMED_REPLY/);
    await assert.rejects(holder.client.prove(rows), /FILE_PROOF_POISONED/);
  }
});
test('one outstanding task rejects overlap without queueing or cancelling the owned proof', async t => {
  const f = fixture(t); let pending, actor;
  const holder = fake(f.options, undefined, (worker, message) => { pending = message; actor = worker; }); t.after(() => holder.client.close());
  const first = holder.client.prove([f.row()]); await assert.rejects(holder.client.prove([f.row()]), /FILE_PROOF_BUSY/);
  const reply = core.createProofEngine(holder.captured().options.workerData)(pending); actor.emit('message', reply);
  assert.equal((await first).ok, true);
});
test('abort, close, timeout, crash, deserialization failure and exit cannot authorize retry', async t => {
  for (const mode of ['abort', 'close', 'timeout', 'error', 'messageerror', 'exit']) {
    const f = fixture(t), controller = new AbortController(), holder = fake({ ...f.options, timeoutMs: mode === 'timeout' ? 10 : 5000 }, undefined,
      (worker) => { if (['error', 'messageerror'].includes(mode)) queueMicrotask(() => worker.emit(mode, Error('private source path')));
        else if (mode === 'exit') queueMicrotask(() => worker.emit('exit', 0)); });
    t.after(() => holder.client.close());
    const promise = holder.client.prove([f.row()], { signal: controller.signal });
    const rejected = assert.rejects(promise, /FILE_PROOF_ABORTED|FILE_PROOF_CLOSED|FILE_PROOF_TIMEOUT|FILE_PROOF_WORKER_FAILED|FILE_PROOF_MALFORMED_REPLY|FILE_PROOF_WORKER_EXITED/);
    if (mode === 'abort') controller.abort(); if (mode === 'close') holder.client.close(); await rejected;
    await assert.rejects(holder.client.prove([f.row()]), /FILE_PROOF_POISONED/);
  }
});
test('a late duplicate reply or unexpected exit after success poisons future requests', async t => {
  for (const mode of ['reply', 'exit']) {
    const f = fixture(t), holder = fake(f.options); t.after(() => holder.client.close());
    await holder.client.prove([f.row()]);
    if (mode === 'reply') holder.instance().emit('message', holder.instance().last); else holder.instance().emit('exit', 0);
    await assert.rejects(holder.client.prove([f.row()]), /FILE_PROOF_POISONED/);
  }
});
test('absolute monotonic deadline covers synchronous parent admission and reply checks', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance'); let now = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  try {
    const f = fixture(t), holder = fake({ ...f.options, timeoutMs: 100 }, value => { now = 101; return value; }); t.after(() => holder.client.close());
    await assert.rejects(holder.client.prove([f.row()]), /FILE_PROOF_TIMEOUT/);
    now = 0; let spawned = 0;
    const client = _createFileProofClientForTests({ ...f.options, timeoutMs: 100 }, () => { spawned++; throw Error('must not spawn'); }); t.after(() => client.close());
    const rows = [f.row()], stat = fs.lstatSync; fs.lstatSync = (...args) => { const value = stat(...args); now = 101; return value; };
    try { await assert.rejects(client.prove(rows), /FILE_PROOF_TIMEOUT/); }
    finally { fs.lstatSync = stat; }
    assert.equal(spawned, 0);
  } finally { Object.defineProperty(globalThis, 'performance', descriptor); }
});

 test('library imports inside an unrelated Node worker never arm its parent IPC', async () => {
  const entry = new URL('./file-proof-client.mjs', import.meta.url).href;
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(entry)}).then(()=>parentPort.postMessage('imported'));`, { eval: true, env: {}, execArgv: [] });
  try { await new Promise((resolve, reject) => { worker.once('message', value => { try { assert.equal(value, 'imported'); resolve(); } catch (error) { reject(error); } }); worker.once('error', reject); }); }
  finally { await worker.terminate(); }
});
