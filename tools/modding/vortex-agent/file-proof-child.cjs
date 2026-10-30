'use strict';
// Fixed data-only child entrypoint, never an arbitrary script runner.
const core = require('./file-proof-worker.cjs');
const backend = require('./file-proof-backend.cjs');
let run, config;
function fatal() { try { process.disconnect(); } catch {} process.exitCode = 2; }
if (require.main === module) {
  if (backend.getBackend().name !== 'original-fs' || process.type !== undefined || process.env.ELECTRON_RUN_AS_NODE !== '1' || typeof process.send !== 'function') throw Error('FILE_PROOF_CHILD_RUNTIME_CHANGED');
  process.on('disconnect', () => { process.exitCode = 0; });
  process.on('message', message => {
    try {
      core.budget(message);
      if (!run) {
        if (!core.exact(message, ['kind', 'config']) || message.kind !== 'initialize') return fatal();
        config = core.validateConfig(message.config); run = core.createProofEngine(config);
        process.send({kind:'initialized', nonce:config.nonce, epoch:config.epoch, hostGeneration:config.hostGeneration,
          rootsDigest:core.digest(config.roots), runtime:{electron:process.versions.electron,node:process.versions.node,processType:null,runAsNode:true,backend:backend.getBackend().name}});
        return;
      }
      try { process.send(run(message)); }
      catch (error) { process.send({protocol:core.PROTOCOL,nonce:config.nonce,epoch:config.epoch,hostGeneration:config.hostGeneration,
        rootsDigest:core.digest(config.roots),requestId:message?.requestId,listDigest:message?.listDigest,fresh:message?.fresh,ok:false,error:core.safeCode(error)}); }
    } catch { fatal(); }
  });
}
