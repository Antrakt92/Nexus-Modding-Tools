'use strict';
const {performance} = require('node:perf_hooks');
const path = require('node:path'), crypto = require('node:crypto');
const {EventEmitter} = require('node:events'), {fork} = require('node:child_process');
const backend = require('./file-proof-backend.cjs'), core = require('./file-proof-worker.cjs');
const EXECUTABLE_SHA256 = 'd93fbf17b44afd6b9ae721b95deb7372e0cab59e19d60f7f64d7b41d3251adbe';
const MAX_EXECUTABLE_BYTES = 512 * 1024 ** 2;
const BOOTSTRAP = path.join(__dirname, 'file-proof-child.cjs');
const FLAGS = Object.freeze(['--max-old-space-size=96','--max-semi-space-size=16','--stack-size=4096']);
const need = (ok, code) => { if (!ok) throw Error(code); };
function directories(fs, dir) {
  const pins = new Map();
  for (let p = dir;;p = path.dirname(p)) {
    const s = fs.lstatSync(p,{bigint:true});
    need(s.isDirectory() && !s.isSymbolicLink() && s.ino > 0n, 'FILE_PROOF_EXECUTABLE_PATH');
    pins.set(p,core.identity(s)); if (p === path.dirname(p)) break;
  }
  return pins;
}
function checkExecutable(fs, file, proof) {
  for (const [dir,id] of proof.parents) { const s = fs.lstatSync(dir,{bigint:true}); need(s.isDirectory() && !s.isSymbolicLink() && core.identity(s) === id, 'FILE_PROOF_EXECUTABLE_CHANGED'); }
  const s = fs.lstatSync(file,{bigint:true});
  need(s.isFile() && !s.isSymbolicLink() && core.generation(s) === proof.generation, 'FILE_PROOF_EXECUTABLE_CHANGED');
}
async function hashExecutable(fs, file, expected, signal) {
  need(typeof file === 'string' && path.isAbsolute(file) && !signal.aborted, 'FILE_PROOF_EXECUTABLE_PATH');
  const parents = directories(fs,path.dirname(file)), initial = fs.lstatSync(file,{bigint:true});
  need(initial.isFile() && !initial.isSymbolicLink() && core.nodeId(core.identity(initial)) && initial.nlink > 0n && initial.size > 0n && initial.size <= BigInt(MAX_EXECUTABLE_BYTES), 'FILE_PROOF_EXECUTABLE_LIMIT');
  const fd = fs.openSync(file,'r'); let stream;
  try {
    const before = fs.fstatSync(fd,{bigint:true}), generation = core.generation(before);
    need(generation === core.generation(initial), 'FILE_PROOF_EXECUTABLE_CHANGED');
    const hash = crypto.createHash('sha256'); let bytes = 0;
    stream = fs.createReadStream(file,{fd,autoClose:false,emitClose:true,highWaterMark:64*1024,signal});
    for await (const chunk of stream) { bytes += chunk.length; need(!signal.aborted && bytes <= Number(before.size), 'FILE_PROOF_EXECUTABLE_CHANGED'); hash.update(chunk); }
    need(!signal.aborted && bytes === Number(before.size) && core.generation(fs.fstatSync(fd,{bigint:true})) === generation, 'FILE_PROOF_EXECUTABLE_CHANGED');
    const proof = {parents,generation,nodeId:core.identity(before),sha256:hash.digest('hex')};
    checkExecutable(fs,file,proof); need(proof.sha256 === expected, 'FILE_PROOF_EXECUTABLE_PIN'); return proof;
  } finally {
    // Once constructed, the stream owns descriptor closure. Never close it a
    // second time while its destroy callback may still be using that fd.
    if (stream) { if (!stream.closed) await new Promise(resolve => {stream.once('close',resolve);stream.destroy();}); }
    else fs.closeSync(fd);
  }
}
function reopenExecutable(fs, file, proof) {
  checkExecutable(fs,file,proof); const fd = fs.openSync(file,'r');
  try { need(core.generation(fs.fstatSync(fd,{bigint:true})) === proof.generation, 'FILE_PROOF_EXECUTABLE_CHANGED'); checkExecutable(fs,file,proof); }
  finally {fs.closeSync(fd);}
}
async function admit(fs, file, pin, signal) {
  const proof = await hashExecutable(fs,file,pin,signal);
  reopenExecutable(fs,file,proof);
  return () => reopenExecutable(fs,file,proof);
}
function admitExecutable(signal, executable) {
  need(process.execPath === executable, 'FILE_PROOF_EXECUTABLE_CHANGED');
  return admit(backend.getBackend().fs,executable,EXECUTABLE_SHA256,signal);
}

function create(config, dependencies) {
  config = core.validateConfig(config);
  const executable = process.execPath;
  const clock = dependencies.clock ?? performance;
  const deadline = dependencies.deadline ?? clock.now() + 120000;
  const timely = () => need(clock.now() < deadline, 'FILE_PROOF_TIMEOUT');
  const adapter = new EventEmitter(), abort = new AbortController();
  let child, startupFinished = false, ready = false, pending, inflight = false, closing = false, exited = false, exitObserved = false, closeObserved = false, forced = false, killTimer, finalTimer, exitTimer, cleanup, settled = false, exitSettling = false;
  let joinedResolve; const joined = new Promise(resolve => {joinedResolve = resolve;});
  const pipes = () => [child?.stdout,child?.stderr].filter(Boolean);
  const finish = verified => {
    if (settled) return; settled = true;
    clearTimeout(killTimer); clearTimeout(finalTimer); clearTimeout(exitTimer);
    joinedResolve({exited:verified,forced,uncertain:!verified,childExitObserved:exitObserved,childCloseObserved:closeObserved,
      parentPipesDestroyed:pipes().every(p=>p.destroyed === true),
      parentPipesClosed:pipes().every(p=>p.closed === true),ipcDisconnected:!child?.connected});
  };
  function releaseParent() {
    try {if(child?.connected) child.disconnect();} catch {}
    for(const pipe of pipes()) {try {pipe.destroy();} catch {}}
  }
  function settleExit() {
    if (settled || exitSettling) return; exitSettling = true;
    // Process exit proves death; ChildProcess 'close' additionally waits for
    // pipes and is not a reliable completion barrier in the admitted Electron.
    releaseParent();
    const check = () => {if(pipes().every(p=>p.closed === true)) finish(true);};
    for(const pipe of pipes()) pipe.once('close',check);
    check();
    if(!settled) exitTimer = setTimeout(()=>finish(true),100);
  }
  const error = code => { if (!closing) { try {adapter.emit('error',Error(code));} finally {void terminate();} } };
  const send = value => { try { child.send(value,e => {if(e) error('FILE_PROOF_CHILD_SEND_FAILED');}); } catch {error('FILE_PROOF_CHILD_SEND_FAILED');} };
  function terminate() {
    if (cleanup) return cleanup;
    cleanup = joined; closing = true; pending = undefined; abort.abort();
    if (settled) return cleanup;
    finalTimer = setTimeout(() => finish(false),5000);
    if (child && !exited) {
      try { if (child.connected) child.disconnect(); } catch {}
      if (!exited && !settled) killTimer = setTimeout(() => { if (!exited) {forced = true; try {child.kill();} catch {} } },2000);
    } else if (exited) settleExit();
    else if (startupFinished) finish(true);
    return cleanup;
  }
  adapter.terminate = terminate;
  adapter.postMessage = value => {
    core.budget(value);
    need(!closing && !exited && !pending && !inflight && core.exact(value,['protocol','nonce','epoch','hostGeneration','rootsDigest','requestId','listDigest','fresh','rows'])
      && value.protocol === core.PROTOCOL && value.nonce === config.nonce && value.epoch === config.epoch
      && value.hostGeneration === config.hostGeneration && value.rootsDigest === core.digest(config.roots), 'FILE_PROOF_CHILD_REQUEST');
    inflight = true; const message = structuredClone(value);
    if (ready) send(message); else pending = message;
  };
  // Start after the parent attaches listeners. Cancellation owns this admission,
  // including the full asynchronous executable read and initialization.
  Promise.resolve().then(async () => {
    try {
      const finalCheck = await dependencies.admit(abort.signal, executable);
      if (closing) return;
      need(process.execPath === executable, 'FILE_PROOF_EXECUTABLE_CHANGED');
      timely(); finalCheck(); timely(); if (closing) return;
      need(process.execPath === executable, 'FILE_PROOF_EXECUTABLE_CHANGED');
      child = dependencies.fork(BOOTSTRAP,[],{execPath:executable,execArgv:[...FLAGS],env:{ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,
        cwd:__dirname,stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
      for(const pipe of pipes()) {pipe.on('error',()=>error('FILE_PROOF_CHILD_PIPE_FAILED'));pipe.resume();}
      child.on('error',()=>error('FILE_PROOF_CHILD_FAILED'));
      child.on('disconnect',()=>{if(!exited) error('FILE_PROOF_CHILD_DISCONNECTED');});
      child.on('message',value=>{
        try {
          core.budget(value);
          if (!ready) {
            need(core.exact(value,['kind','nonce','epoch','hostGeneration','rootsDigest','runtime']) && value.kind === 'initialized'
              && value.nonce === config.nonce && value.epoch === config.epoch && value.hostGeneration === config.hostGeneration && value.rootsDigest === core.digest(config.roots), 'FILE_PROOF_CHILD_INITIALIZATION');
            const r = value.runtime;
            need(core.exact(r,['electron','node','processType','runAsNode','backend']) && r.electron === '44.2.0' && r.node === '24.20.0'
              && r.processType === null && r.runAsNode === true && r.backend === 'original-fs', 'FILE_PROOF_CHILD_RUNTIME_CHANGED');
            need(!closing,'FILE_PROOF_CHILD_CLOSED'); ready = true;
            if (pending) {const message=pending;pending=undefined;send(message);} return;
          }
          need(inflight,'FILE_PROOF_CHILD_UNSOLICITED_REPLY'); inflight = false;
          if (!closing) adapter.emit('message',value);
        } catch {error('FILE_PROOF_CHILD_PROTOCOL');}
      });
      child.once('exit',code=>{exited=true;exitObserved=true;settleExit();adapter.emit('exit',code);});
      child.once('close',()=>{exited=true;closeObserved=true;releaseParent();finish(true);});
      send({kind:'initialize',config});
    } catch (e) {error(/^FILE_PROOF_[A-Z_]+$/.test(e?.message || '') ? e.message : 'FILE_PROOF_EXECUTABLE_REJECTED');}
    finally {startupFinished = true; if(closing && !child) finish(true);}
  });
  return adapter;
}
function createChildAdapter(config, deadline) {
  need(Number.isFinite(deadline) && deadline > performance.now() && deadline <= performance.now() + 120000, 'FILE_PROOF_TIMEOUT');
  need(backend.getBackend().name === 'original-fs','FILE_PROOF_CHILD_RUNTIME_CHANGED');
  return create(config,{fork,admit:admitExecutable,deadline});
}
module.exports = {createChildAdapter,
  _createChildForTests:create, _hashExecutableForTests:hashExecutable, _admitExecutableForTests:admit};
