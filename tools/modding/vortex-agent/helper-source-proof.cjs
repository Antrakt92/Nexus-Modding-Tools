'use strict';
const core = require('./file-proof-worker.cjs');
const {createFileProofClient} = require('./file-proof-client.cjs');
const need = (value, code) => {if (!value) throw Error(code);};
const safe = error => /^FILE_PROOF_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FILE_PROOF_SOURCE_FAILED';

function create(options, factory) {
  const keys = ['roots', 'rows', 'epoch', 'hostGeneration', ...(Object.hasOwn(options ?? {}, 'timeoutMs') ? ['timeoutMs'] : [])];
  need(core.exact(options, keys), 'FILE_PROOF_INVALID_OPTIONS');
  const config = core.validateConfig({protocol: core.PROTOCOL, nonce: '0'.repeat(32),
    roots: options.roots, epoch: options.epoch, hostGeneration: options.hostGeneration});
  const rows = core.validateRows(options.rows, config.roots), roots = new Map(config.roots.map(root => [root.id, root]));
  const rootPins = core.observeRoots(config.roots);
  const observed = rows.map(row => core.observeLeaf(roots.get(row.rootId), row));
  observed.forEach((item, index) => need(core.matches(item.stat, rows[index].expected), 'FILE_PROOF_SOURCE_CHANGED'));
  const client = factory({roots: config.roots, epoch: config.epoch, hostGeneration: config.hostGeneration,
    ...(Object.hasOwn(options, 'timeoutMs') ? {timeoutMs: options.timeoutMs} : {})});
  need(client && ['prove', 'assertOpen', 'close'].every(key => typeof client[key] === 'function'), 'FILE_PROOF_INVALID_CLIENT');
  let pending, closed = false, failure, proved = false, lastFresh = false, finalSnapshot = false, cleanup;
  const stop = code => {failure ||= code; proved = false; finalSnapshot = false;};
  function sampleFiles() {
    core.assertDirectories(rootPins);
    rows.forEach((row, index) => {
      core.assertDirectories(observed[index].parents);
      const current = core.observeLeaf(roots.get(row.rootId), row);
      need(current.generation === observed[index].generation && core.matches(current.stat, row.expected), 'FILE_PROOF_SOURCE_CHANGED');
    });
    core.assertDirectories(rootPins);
  }
  function sample() {
    need(!closed && !failure, failure || 'FILE_PROOF_SOURCE_CLOSED');
    client.assertOpen(); sampleFiles();
  }
  function checkedSample() {
    try {sample();} catch (error) {stop(safe(error)); throw Error(failure);}
  }
  return Object.freeze({
    prove(options = {}) {
      try {
        need(core.exact(options, Object.hasOwn(options ?? {}, 'fresh') ? ['fresh'] : [])
          && (options.fresh === undefined || typeof options.fresh === 'boolean'), 'FILE_PROOF_INVALID_OPTIONS');
        checkedSample();
        const fresh = options.fresh ?? false;
        if (pending) {
          // Identical static source proofs may overlap; each guard must still
          // evaluate its own live scope after this shared Promise resolves.
          need(pending.fresh === fresh, 'FILE_PROOF_SOURCE_BUSY');
          return pending.promise;
        }
        const flight = {fresh};
        pending = flight;
        flight.promise = Promise.resolve().then(() => {
          checkedSample(); return client.prove(rows, {fresh});
        }).then(result => {
          checkedSample(); proved = true; lastFresh = fresh; return result;
        }).catch(error => {stop(safe(error)); throw Error(failure);})
          .finally(() => {if (pending === flight) pending = undefined;});
        return flight.promise;
      } catch (error) {return Promise.reject(Error(safe(error)));}
    },
    assertCurrent() {
      checkedSample();
      need(proved && !pending, 'FILE_PROOF_SOURCE_NOT_SETTLED');
    },
    assertFinalSnapshot() {
      try {
        // Final readback only. Effect barriers must use assertCurrent(), which
        // permanently rejects this closed client.
        need(finalSnapshot && closed && !failure, failure || 'FILE_PROOF_SOURCE_FINAL_REQUIRED');
        sampleFiles();
      } catch (error) {stop(safe(error)); throw Error(failure);}
    },
    close() {
      if (cleanup) return cleanup;
      try {sample();} catch (error) {stop(safe(error));}
      const finalCandidate = proved && lastFresh && !pending && !failure;
      closed = true; proved = false;
      const flight = pending?.promise;
      // Attach rejection handling before cancellation. Process cleanup may take
      // seconds after the request rejects, so waiting until then is too late.
      const joined = flight ? flight.then(() => {}, () => {}) : Promise.resolve();
      cleanup = Promise.resolve().then(() => client.close()).then(async outcome => {
        // Join the already owned flight; never start or retry another request.
        await joined;
        need(outcome?.exited === true && outcome.forced === false && outcome.uncertain === false
          && outcome.parentPipesClosed !== false && outcome.ipcDisconnected !== false, 'FILE_PROOF_SOURCE_CLEANUP_UNCERTAIN');
        if (finalCandidate && !failure) {sampleFiles(); finalSnapshot = true;}
        return outcome;
      }).catch(error => {const code = safe(error); stop(code); throw Error(code);});
      return cleanup;
    },
  });
}
function construct(options, factory) {
  try {return create(options, factory);} catch (error) {throw Error(safe(error));}
}
function createSourceProof(options) {return construct(options, createFileProofClient);}
module.exports = {createSourceProof, _createSourceProofForTests: construct};
