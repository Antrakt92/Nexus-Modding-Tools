'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {_createChildForTests:create,_hashExecutableForTests:hashFile,_admitExecutableForTests:admitExecutable}=require('./file-proof-child-client.cjs');
const core=require('./file-proof-worker.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const outcome=r=>({exited:r.exited,forced:r.forced,uncertain:r.uncertain});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-proof-child-'));t.after(()=>fs.rmSync(root,{recursive:true}));
 const file=path.join(root,'owned.bin');fs.writeFileSync(file,Buffer.alloc(256*1024,7));
 const config=core.validateConfig({protocol:core.PROTOCOL,nonce:'a'.repeat(32),epoch:4,hostGeneration:'own-test',roots:[{id:'own',path:root,nodeId:core.identity(fs.lstatSync(root,{bigint:true}))}]});
 const s=fs.lstatSync(file,{bigint:true}),rows=[{rootId:'own',relativePath:'owned.bin',expected:{nodeId:core.identity(s),bytes:String(s.size),links:Number(s.nlink),sha256:sha(fs.readFileSync(file))}}];
 const request={protocol:core.PROTOCOL,nonce:config.nonce,epoch:config.epoch,hostGeneration:config.hostGeneration,rootsDigest:core.digest(config.roots),requestId:'b'.repeat(32),listDigest:core.digest(rows),fresh:false,rows};
 return {root,file,config,request};
}
function fake(f,{admit=async()=>()=>{},transform=v=>v,exit=true,prove=false,deadline,clock}={}){
 let spawned=0,options,child;const sent=[];
 const engine=core.createProofEngine(f.config);
 const adapter=create(f.config,{admit,deadline,clock,fork:(file,args,opts)=>{
  spawned++;options={file,args,opts};child=new EventEmitter();child.connected=true;child.kills=0;
  child.kill=()=>{child.kills++;return true;};
  child.disconnect=()=>{child.connected=false;child.emit('disconnect');if(exit)queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});};
  child.send=(value,done)=>{sent.push(value);done?.();if(value.kind==='initialize')queueMicrotask(()=>child.emit('message',transform({kind:'initialized',nonce:f.config.nonce,epoch:f.config.epoch,hostGeneration:f.config.hostGeneration,rootsDigest:core.digest(f.config.roots),runtime:{electron:'44.2.0',node:'24.20.0',processType:null,runAsNode:true,backend:'original-fs'}})));else if(prove)queueMicrotask(()=>child.emit('message',engine(value)));};
  return child;
 }});const errors=[];adapter.on('error',e=>errors.push(e.message));
 return {adapter,errors,sent,child:()=>child,options:()=>options,spawned:()=>spawned};
}
test('deferred transport queues only one bound request until admitted and initialized',async t=>{
 const f=fixture(t);let resolve;const h=fake(f,{admit:()=>new Promise(r=>resolve=r)});
 h.adapter.postMessage(f.request);assert.throws(()=>h.adapter.postMessage(f.request),/FILE_PROOF_CHILD_REQUEST/);
 await turn();assert.equal(h.spawned(),0);resolve(()=>{});await turn();
 assert.equal(h.spawned(),1);assert.equal(h.sent.length,2);assert.equal(h.sent[1].requestId,f.request.requestId);
 const o=h.options();assert.equal(path.basename(o.file),'file-proof-child.cjs');assert.deepEqual(o.args,[]);
 assert.equal(o.opts.execPath,process.execPath);assert.deepEqual(o.opts.env,{ELECTRON_RUN_AS_NODE:'1'});
 assert.deepEqual(o.opts.execArgv,['--max-old-space-size=96','--max-semi-space-size=16','--stack-size=4096']);
 assert.deepEqual(outcome(await h.adapter.terminate()),{exited:true,forced:false,uncertain:false});assert.equal(h.child().kills,0);
});
test('cancellation during executable admission prevents any late fork or automatic retry',async t=>{
 const f=fixture(t);let resolve;const h=fake(f,{admit:()=>new Promise(r=>resolve=r)});
 h.adapter.postMessage(f.request);await turn();const closed=h.adapter.terminate();resolve(()=>assert.fail('late final check'));
 assert.equal((await closed).exited,true);await turn();assert.equal(h.spawned(),0);assert.deepEqual(h.errors,[]);
 assert.throws(()=>h.adapter.postMessage(f.request),/FILE_PROOF_CHILD_REQUEST/);
});
test('wrong executable proof, final generation check or runtime handshake never dispatches proof work',async t=>{
 const f=fixture(t);
 for(const admit of [async()=>{throw Error('FILE_PROOF_EXECUTABLE_PIN');},async()=>()=>{throw Error('FILE_PROOF_EXECUTABLE_CHANGED');}]){
  const h=fake(f,{admit});h.adapter.postMessage(f.request);await turn();assert.equal(h.spawned(),0);assert.equal(h.errors.length,1);await h.adapter.terminate();
 }
 for(const transform of [v=>({...v,epoch:5}),v=>({...v,runtime:{...v.runtime,node:'24.20.1'}}),v=>({...v,extra:true})]){
  const h=fake(f,{transform});h.adapter.postMessage(f.request);await turn();assert.equal(h.sent.length,1);assert.deepEqual(h.errors,['FILE_PROOF_CHILD_PROTOCOL']);await h.adapter.terminate();
 }
});
test('late initialization after close cannot release a queued request',async t=>{
 const f=fixture(t),h=fake(f,{transform:v=>{void h.adapter.terminate();return v;}});
 h.adapter.postMessage(f.request);await turn();await h.adapter.terminate();assert.equal(h.spawned(),1);
 assert.equal(h.sent.length,1);assert.equal(h.child().kills,0);
});
test('disconnect or child error is sanitized and does not respawn',async t=>{
 const f=fixture(t),h=fake(f);h.adapter.postMessage(f.request);await turn();h.child().emit('error',Error('private path'));h.child().emit('disconnect');
 assert.deepEqual(h.errors,['FILE_PROOF_CHILD_FAILED']);assert.equal(h.spawned(),1);await h.adapter.terminate();
});
test('shutdown only kills its owned child after grace and reports unconfirmed exit by five seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),h=fake(f,{exit:false});await turn();
 const closed=h.adapter.terminate();assert.equal(h.child().kills,0);t.mock.timers.tick(2000);assert.equal(h.child().kills,1);
 t.mock.timers.tick(3000);assert.deepEqual(outcome(await closed),{exited:false,forced:true,uncertain:true});assert.equal(h.spawned(),1);
});
test('executable hashing streams bytes, rejects a bad pin and samples descriptor/path generations',async t=>{
 const f=fixture(t),pin=sha(fs.readFileSync(f.file)),signal=new AbortController().signal;
 const proof=await hashFile(fs,f.file,pin,signal);assert.equal(proof.sha256,pin);assert.match(proof.nodeId,/^\d+:\d+$/);
 await assert.rejects(hashFile(fs,f.file,'0'.repeat(64),signal),/FILE_PROOF_EXECUTABLE_PIN/);
 const open=fs.createReadStream;let changed=false;
 fs.createReadStream=(...args)=>{const s=open(...args);s.once('data',()=>{changed=true;fs.utimesSync(f.file,new Date(),new Date(Date.now()+5000));});return s;};
 try{await assert.rejects(hashFile(fs,f.file,pin,signal),/FILE_PROOF_EXECUTABLE_CHANGED/);}finally{fs.createReadStream=open;}
 assert(changed);
});
test('outer client timeout and abort cover deferred admission and prevent late fork',async t=>{
 const {_createFileProofClientForTests}=await import('./file-proof-client.mjs');
 for(const mode of ['timeout','abort']){
  const f=fixture(t);let h,resolve;const controller=new AbortController();
  const client=_createFileProofClientForTests({roots:f.config.roots,epoch:4,hostGeneration:'own-test',timeoutMs:10},(_file,opts)=>{
   h=fake({...f,config:opts.workerData},{admit:()=>new Promise(r=>resolve=r)});return h.adapter;
  });
  const promise=client.prove(f.request.rows,{signal:controller.signal});const rejected=assert.rejects(promise,/FILE_PROOF_TIMEOUT|FILE_PROOF_ABORTED/);
  await turn();if(mode==='abort')controller.abort();await rejected;resolve(()=>assert.fail('late admission'));await client.close();
  assert.equal(h.spawned(),0);await assert.rejects(client.prove(f.request.rows),/FILE_PROOF_POISONED/);
 }
});

test('synthetic child path preserves cold/warm/fresh results and returns observed cleanup outcome',async t=>{
 const {_createFileProofClientForTests}=await import('./file-proof-client.mjs');const f=fixture(t);let h;
 const client=_createFileProofClientForTests({roots:f.config.roots,epoch:4,hostGeneration:'own-test'},(_file,opts)=>{
  h=fake({...f,config:opts.workerData},{prove:true});return h.adapter;
 });
 const cold=await client.prove(f.request.rows);assert.equal(cold.metrics.hashes,1);
 assert.equal((await client.prove(f.request.rows)).metrics.cacheHits,1);
 assert.equal((await client.prove(f.request.rows,{fresh:true})).metrics.hashes,1);
 assert.deepEqual(outcome(await client.close()),{exited:true,forced:false,uncertain:false});assert.equal(h.spawned(),1);
});
test('aborted and oversized executable inputs never create a read stream',async t=>{
 const f=fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(hashFile(fs,f.file,'0'.repeat(64),controller.signal),/FILE_PROOF_EXECUTABLE_PATH/);
 const stat=fs.lstatSync,stream=fs.createReadStream;let opened=false;
 fs.lstatSync=(file,...args)=>{const s=stat(file,...args);return file===f.file?new Proxy(s,{get(target,key){if(key==='size')return 513n*1024n**2n;const v=target[key];return typeof v==='function'?v.bind(target):v;}}):s;};
 fs.createReadStream=()=>{opened=true;throw Error('must not read');};
 try{await assert.rejects(hashFile(fs,f.file,'0'.repeat(64),new AbortController().signal),/FILE_PROOF_EXECUTABLE_LIMIT/);}finally{fs.lstatSync=stat;fs.createReadStream=stream;}
 assert.equal(opened,false);
});

test('executable admission hashes once then reopens generation; mutation before fork is rejected',async t=>{
 const f=fixture(t),pin=sha(fs.readFileSync(f.file)),open=fs.createReadStream;let streams=0;
 fs.createReadStream=(...args)=>{streams++;return open(...args);};let check;
 try{check=await admitExecutable(fs,f.file,pin,new AbortController().signal);}finally{fs.createReadStream=open;}
 assert.equal(streams,1);check();fs.utimesSync(f.file,new Date(),new Date(Date.now()+5000));
 assert.throws(check,/FILE_PROOF_EXECUTABLE_CHANGED/);
 const fresh=await admitExecutable(fs,f.file,pin,new AbortController().signal);
 fs.renameSync(f.file,f.file+'.retained');fs.writeFileSync(f.file,Buffer.alloc(256*1024,7));assert.throws(fresh,/FILE_PROOF_EXECUTABLE_CHANGED/);
});
test('absolute deadline is checked after final synchronous admission before any fork',async t=>{
 const f=fixture(t);let now=0;const clock={now:()=>now};
 const h=fake(f,{deadline:100,clock,admit:async()=>()=>{now=101;}});h.adapter.postMessage(f.request);await turn();
 assert.equal(h.spawned(),0);assert.deepEqual(h.errors,['FILE_PROOF_TIMEOUT']);await h.adapter.terminate();
});

test('outer client preserves uncertain child cleanup and never calls a replacement factory',async t=>{
 const {_createFileProofClientForTests}=await import('./file-proof-client.mjs');const f=fixture(t);let count=0,adapter;
 const client=_createFileProofClientForTests({roots:f.config.roots,epoch:4,hostGeneration:'own-test'},()=>{
  count++;adapter=new EventEmitter();adapter.postMessage=()=>{};adapter.terminate=()=>Promise.resolve({exited:false,forced:true,uncertain:true});return adapter;
 });
 const promise=client.prove(f.request.rows);const checked=assert.rejects(promise,/FILE_PROOF_CLOSED/);
 assert.deepEqual(outcome(await client.close()),{exited:false,forced:true,uncertain:true});await checked;
 await assert.rejects(client.prove(f.request.rows),/FILE_PROOF_POISONED/);assert.equal(count,1);
});
test('aborting an active executable stream closes its descriptor without permitting a spawn',async t=>{
 const f=fixture(t),controller=new AbortController(),open=fs.createReadStream;let fd;
 fs.createReadStream=(...args)=>{fd=args[1].fd;const stream=open(...args);stream.once('data',()=>controller.abort());return stream;};
 try{await assert.rejects(hashFile(fs,f.file,sha(fs.readFileSync(f.file)),controller.signal));}finally{fs.createReadStream=open;}
 assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
});

test('deferred child deadlines ignore a browser global performance clock',async t=>{
 const f=fixture(t),descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now(){throw Error('WRONG_CHROMIUM_CLOCK');}}});
 try{const h=fake(f);h.adapter.postMessage(f.request);await turn();assert.equal(h.spawned(),1);await h.adapter.terminate();}
 finally{Object.defineProperty(globalThis,'performance',descriptor);}
});

test('changing process.execPath during admission cannot retarget the fork after proof',async t=>{
 const f=fixture(t),descriptor=Object.getOwnPropertyDescriptor(process,'execPath');
 try{
  const h=fake(f,{admit:async()=>{Object.defineProperty(process,'execPath',{...descriptor,value:path.join(f.root,'unadmitted.exe')});return ()=>{};}});
  h.adapter.postMessage(f.request);await turn();assert.equal(h.spawned(),0);assert.deepEqual(h.errors,['FILE_PROOF_EXECUTABLE_CHANGED']);await h.adapter.terminate();
 }finally{Object.defineProperty(process,'execPath',descriptor);}
});

test('observed child exit without ChildProcess close settles after releasing only owned parent pipes',async t=>{
 const f=fixture(t),h=fake(f,{exit:false});await turn();
 const pipes=[new EventEmitter(),new EventEmitter()];
 for(const pipe of pipes){pipe.destroyed=false;pipe.closed=false;pipe.destroy=()=>{pipe.destroyed=true;queueMicrotask(()=>{pipe.closed=true;pipe.emit('close');});};}
 [h.child().stdout,h.child().stderr]=pipes;
 const closed=h.adapter.terminate();h.child().emit('exit',0);
 const result=await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('EXIT_WITHOUT_CLOSE_HUNG')),250))]);
 assert.equal(result.exited,true);assert.equal(result.uncertain,false);assert.equal(result.forced,false);
 assert(pipes.every(p=>p.destroyed));assert.equal(result.parentPipesClosed,true);assert.equal(result.ipcDisconnected,true);
});

test('known process exit and pending parent-pipe closure are reported separately',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),h=fake(f,{exit:false});await turn();
 const pipe=new EventEmitter();pipe.destroyed=false;pipe.closed=false;pipe.destroy=()=>{pipe.destroyed=true;};h.child().stdout=pipe;
 const closed=h.adapter.terminate();h.child().emit('exit',0);t.mock.timers.tick(100);
 const r=await closed;assert.equal(r.exited,true);assert.equal(r.uncertain,false);assert.equal(r.childExitObserved,true);assert.equal(r.childCloseObserved,false);
 assert.equal(r.parentPipesDestroyed,true);assert.equal(r.parentPipesClosed,false);assert.equal(r.ipcDisconnected,true);assert.equal(h.child().kills,0);
});
test('forced owned-child exit settles even without a ChildProcess close event',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),h=fake(f,{exit:false});await turn();
 h.child().kill=()=>{h.child().kills++;h.child().emit('exit',1);return true;};
 const closed=h.adapter.terminate();t.mock.timers.tick(2000);const r=await closed;
 assert.deepEqual(outcome(r),{exited:true,forced:true,uncertain:false});assert.equal(r.childExitObserved,true);assert.equal(r.childCloseObserved,false);assert.equal(h.child().kills,1);
});

test('exit during disconnect cannot arm a later redundant kill timer',async t=>{
 const f=fixture(t),h=fake(f,{exit:false});await turn();
 h.child().disconnect=()=>{h.child().connected=false;h.child().emit('exit',0);};
 const timer=globalThis.setTimeout,delays=[];globalThis.setTimeout=(fn,ms,...args)=>{delays.push(ms);return timer(fn,ms,...args);};
 try{assert.equal((await h.adapter.terminate()).exited,true);}finally{globalThis.setTimeout=timer;}
 assert.deepEqual(delays,[5000]);assert.equal(h.child().kills,0);
});
