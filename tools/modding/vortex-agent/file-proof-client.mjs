import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import core from './file-proof-worker.cjs';

const workerFile = fileURLToPath(new URL('./file-proof-worker.cjs', import.meta.url));
const need = (ok, code) => { if (!ok) throw Error(code); };
const safeError = error => Error(/^FILE_PROOF_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FILE_PROOF_CLIENT_FAILED');
const optionsFor = config => ({ workerData: config, env: {}, execArgv: [], trackUnmanagedFds: true, stdout: true, stderr: true,
  resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
const timely = deadline => need(performance.now() < deadline, 'FILE_PROOF_TIMEOUT');

function createClient(options, factory) {
  need(!process.versions.electron, 'FILE_PROOF_ELECTRON_UNVERIFIED');
  const fields = ['roots', 'epoch', 'hostGeneration', ...(Object.hasOwn(options ?? {}, 'timeoutMs') ? ['timeoutMs'] : [])];
  need(core.exact(options, fields), 'FILE_PROOF_INVALID_OPTIONS');
  const timeoutMs = options.timeoutMs ?? 30000;
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'FILE_PROOF_INVALID_TIMEOUT');
  const config = core.validateConfig({ protocol: core.PROTOCOL, nonce: crypto.randomBytes(16).toString('hex'),
    epoch: options.epoch, hostGeneration: options.hostGeneration, roots: options.roots });
  const roots = new Map(config.roots.map(r => [r.id, r])), rootPins = core.observeRoots(config.roots);
  const rootsDigest = core.digest(config.roots); let worker, active, closed;
  function poison(code) {
    if (closed) return;
    closed = code;
    const pending = active; active = undefined;
    if (pending) { clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.aborted); pending.reject(Error(code)); }
    if (worker) {
      try { Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* The checkpoint remains poisoned. */ }
    }
  }
  function receive(value) {
    try {
      need(active && !closed, 'FILE_PROOF_STALE_REPLY');
      timely(active.deadline);
      const request = active.request, shared = ['protocol', 'nonce', 'epoch', 'hostGeneration', 'rootsDigest', 'requestId', 'listDigest', 'fresh', 'ok'];
      const successful = value?.ok === true;
      need(core.exact(value, successful ? [...shared, 'proofs', 'metrics', 'backend', 'hostCompatibilityVerified', 'effectsAllowed', 'diskDeploymentVerified', 'directoryInventoryVerified']
        : [...shared, 'error']), 'FILE_PROOF_MALFORMED_REPLY'); core.budget(value);
      need(value.protocol === core.PROTOCOL && value.nonce === config.nonce && value.epoch === config.epoch
        && value.hostGeneration === config.hostGeneration && value.rootsDigest === rootsDigest && value.requestId === request.requestId
        && value.listDigest === request.listDigest && value.fresh === request.fresh, 'FILE_PROOF_STALE_REPLY');
      if (!successful) {
        need(value.ok === false && /^FILE_PROOF_[A-Z_]+$/.test(value.error), 'FILE_PROOF_MALFORMED_REPLY'); poison(value.error); return;
      }
      need(value.backend === 'node:fs' && value.hostCompatibilityVerified === false && value.effectsAllowed === false
        && value.diskDeploymentVerified === false && value.directoryInventoryVerified === false
        && Array.isArray(value.proofs) && value.proofs.length === request.rows.length && core.dense(value.proofs), 'FILE_PROOF_MALFORMED_REPLY');
      const metrics = value.metrics;
      need(core.exact(metrics, ['reads', 'hashes', 'cacheHits', 'bytesHashed'])
        && Object.values(metrics).every(n => Number.isSafeInteger(n) && n >= 0) && metrics.reads === request.rows.length
        && metrics.hashes + metrics.cacheHits === metrics.reads
        && (!request.fresh || metrics.hashes > 0)
        && BigInt(metrics.bytesHashed) <= request.rows.reduce((n, row) => n + BigInt(row.expected.bytes), 0n), 'FILE_PROOF_MALFORMED_REPLY');
      core.assertDirectories(rootPins);
      for (const [index, proof] of value.proofs.entries()) {
        timely(active.deadline);
        const row = request.rows[index], before = active.before[index];
        need(core.exact(proof, ['rootId', 'relativePath', 'nodeId', 'bytes', 'links', 'sha256', 'mtimeNs', 'ctimeNs'])
          && proof.rootId === row.rootId && proof.relativePath === row.relativePath && proof.nodeId === row.expected.nodeId
          && proof.bytes === row.expected.bytes && proof.links === row.expected.links && proof.sha256 === row.expected.sha256
          && core.signed(proof.mtimeNs) && core.signed(proof.ctimeNs), 'FILE_PROOF_MALFORMED_REPLY');
        core.assertDirectories(before.parents);
        const current = core.observeLeaf(roots.get(row.rootId), row);
        const generation = `${proof.nodeId}:${proof.bytes}:${proof.mtimeNs}:${proof.ctimeNs}:${proof.links}`;
        need(current.generation === before.generation && current.generation === generation && core.matches(current.stat, row.expected), 'FILE_PROOF_STALE_RESULT');
      }
      core.assertDirectories(rootPins); timely(active.deadline);
      const complete = active; active = undefined; clearTimeout(complete.timer);
      complete.signal?.removeEventListener('abort', complete.aborted); complete.resolve(value);
    } catch (error) { poison(safeError(error).message); }
  }
  function start() {
    if (worker) return;
    worker = factory(workerFile, optionsFor(config));
    need(worker && ['on', 'postMessage', 'terminate'].every(k => typeof worker[k] === 'function'), 'FILE_PROOF_INVALID_WORKER');
    worker.on('message', receive); worker.on('error', () => poison('FILE_PROOF_WORKER_FAILED'));
    worker.on('messageerror', () => poison('FILE_PROOF_MALFORMED_REPLY'));
    worker.on('exit', () => { if (!closed) poison('FILE_PROOF_WORKER_EXITED'); });
    // Never forward worker stdout/stderr (including filesystem exception paths).
    worker.stdout?.resume(); worker.stderr?.resume();
  }
  return Object.freeze({
    prove(value, opts = {}) {
      if (closed) return Promise.reject(Error('FILE_PROOF_POISONED'));
      if (active) return Promise.reject(Error('FILE_PROOF_BUSY'));
      const deadline = performance.now() + timeoutMs;
      let request, before;
      try {
        const fields = [...(Object.hasOwn(opts ?? {}, 'fresh') ? ['fresh'] : []), ...(Object.hasOwn(opts ?? {}, 'signal') ? ['signal'] : [])];
        need(core.exact(opts, fields) && (opts.fresh === undefined || typeof opts.fresh === 'boolean')
          && (opts.signal === undefined || opts.signal instanceof AbortSignal), 'FILE_PROOF_INVALID_OPTIONS');
        need(!opts.signal?.aborted, 'FILE_PROOF_ABORTED');
        const rows = core.validateRows(value, config.roots); core.assertDirectories(rootPins);
        before = rows.map(row => {
          const snapshot = core.observeLeaf(roots.get(row.rootId), row);
          need(core.matches(snapshot.stat, row.expected), 'FILE_PROOF_EXPECTATION_CHANGED'); return snapshot;
        });
        request = { protocol: core.PROTOCOL, nonce: config.nonce, epoch: config.epoch, hostGeneration: config.hostGeneration,
          rootsDigest, requestId: crypto.randomBytes(16).toString('hex'), listDigest: core.digest(rows), fresh: opts.fresh ?? false, rows };
        core.budget(request); timely(deadline);
      } catch (error) { poison(safeError(error).message); return Promise.reject(safeError(error)); }
      return new Promise((resolve, reject) => {
        const aborted = () => poison('FILE_PROOF_ABORTED');
        active = { request, before, resolve, reject, signal: opts.signal, aborted, deadline,
          timer: setTimeout(() => poison('FILE_PROOF_TIMEOUT'), Math.max(1, Math.ceil(deadline - performance.now()))) };
        opts.signal?.addEventListener('abort', aborted, { once: true });
        if (opts.signal?.aborted) { aborted(); return; }
        try { start(); timely(deadline); if (!closed) worker.postMessage(request); }
        catch (error) { poison(safeError(error).message); }
      });
    },
    close() { poison('FILE_PROOF_CLOSED'); },
  });
}
export function createFileProofClient(options) {
  try { return createClient(options, (file, workerOptions) => new Worker(file, workerOptions)); }
  catch (error) { throw safeError(error); }
}
// Internal deterministic test seam; never accepted as a production option or RPC argument.
export function _createFileProofClientForTests(options, factory) {
  try { need(typeof factory === 'function', 'FILE_PROOF_INVALID_WORKER'); return createClient(options, factory); }
  catch (error) { throw safeError(error); }
}
