import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import core from './file-proof-worker.cjs';
import * as esm from './file-proof-client.mjs';
const cjs = createRequire(import.meta.url)('./file-proof-client.cjs');

test('ESM and CommonJS expose the exact same client factories', () => {
  assert.equal(esm.createFileProofClient, cjs.createFileProofClient);
  assert.equal(esm._createFileProofClientForTests, cjs._createFileProofClientForTests);
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
});

for (const [name, entry] of [['CommonJS', cjs], ['ESM', esm]]) {
  test(`${name} entry runs the fixed real Node worker with cold, cached and fresh proof`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-proof-parity-'));
    const file = path.join(root, 'fixture.bin'), bytes = Buffer.from('owned parity fixture');
    fs.writeFileSync(file, bytes);
    t.after(() => { fs.unlinkSync(file); fs.rmdirSync(root); });
    const id = stat => `${stat.dev}:${stat.ino}`;
    const stat = fs.lstatSync(file, { bigint: true });
    const client = entry.createFileProofClient({ epoch: 1, hostGeneration: 'parity-fixture',
      roots: [{ id: 'own', path: root, nodeId: id(fs.lstatSync(root, { bigint: true })) }] });
    const rows = [{ rootId: 'own', relativePath: 'fixture.bin', expected: { nodeId: id(stat),
      bytes: String(stat.size), links: Number(stat.nlink), sha256: crypto.createHash('sha256').update(bytes).digest('hex') } }];
    try {
      const cold = await client.prove(rows), warm = await client.prove(rows), fresh = await client.prove(rows, { fresh: true });
      assert.deepEqual(cold.proofs, warm.proofs); assert.deepEqual(cold.proofs, fresh.proofs);
      assert.equal(cold.metrics.hashes, 1); assert.equal(warm.metrics.cacheHits, 1); assert.equal(fresh.metrics.hashes, 1);
      for (const result of [cold, warm, fresh]) {
        assert.equal(result.backend, 'node:fs'); assert.equal(result.effectsAllowed, false);
        assert.equal(result.hostCompatibilityVerified, false); assert.equal(result.diskDeploymentVerified, false);
      }
    } finally { assert.deepEqual(await client.close(), { exited: true, forced: false, uncertain: false }); }
    assert.throws(() => client.assertOpen(), /FILE_PROOF_CLOSED/);
    await assert.rejects(client.prove(rows), /FILE_PROOF_POISONED/);
  });
}

for (const event of ['error', 'exit']) {
  test(`idle worker ${event} permanently invalidates synchronous client liveness`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-proof-liveness-'));
    const file = path.join(root, 'fixture.bin'), bytes = Buffer.from('owned idle crash fixture');
    fs.writeFileSync(file, bytes); t.after(() => { fs.unlinkSync(file); fs.rmdirSync(root); });
    const id = stat => `${stat.dev}:${stat.ino}`, stat = fs.lstatSync(file, { bigint: true });
    const options = { epoch: 1, hostGeneration: 'idle-crash-fixture',
      roots: [{ id: 'own', path: root, nodeId: id(fs.lstatSync(root, { bigint: true })) }] };
    let worker, starts = 0, terminated = 0;
    const client = cjs._createFileProofClientForTests(options, (_, workerOptions) => {
      starts++; worker = new EventEmitter(); const run = core.createProofEngine(workerOptions.workerData);
      worker.postMessage = message => queueMicrotask(() => worker.emit('message', run(message)));
      worker.terminate = () => { terminated++; return Promise.resolve(0); }; return worker;
    });
    const rows = [{ rootId: 'own', relativePath: 'fixture.bin', expected: { nodeId: id(stat),
      bytes: String(stat.size), links: Number(stat.nlink), sha256: crypto.createHash('sha256').update(bytes).digest('hex') } }];
    try {
      await client.prove(rows); client.assertOpen();
      worker.emit(event, event === 'error' ? Error('untrusted private failure detail') : 0);
      const code = event === 'error' ? 'FILE_PROOF_WORKER_FAILED' : 'FILE_PROOF_WORKER_EXITED';
      assert.throws(() => client.assertOpen(), error => error.message === code);
      await assert.rejects(client.prove(rows), /FILE_PROOF_POISONED/);
      assert.equal(starts, 1); assert.equal(terminated, 1);
    } finally { await client.close(); }
    assert.throws(() => client.assertOpen(), /FILE_PROOF_WORKER_(?:FAILED|EXITED)/);
    assert.equal(terminated, 1);
  });
}
