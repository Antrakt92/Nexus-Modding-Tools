import crypto from 'node:crypto';

export const WORKER_MODULES = Object.freeze(['helper-source-proof.cjs', 'helper-source-scope.cjs', 'guard-poller.cjs',
  'file-proof-client.cjs', 'file-proof-worker.cjs', 'file-proof-backend.cjs', 'file-proof-child-client.cjs', 'file-proof-child.cjs']);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const once = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('UNSUPPORTED_SOURCE_GUARD_TEMPLATE');
  return source.replace(before, after);
};
// Full reviewed Family source, allowing only the existing binder's data pins and
// purpose substitution. A fragment match must never admit an unreviewed caller.
export function assertWorkerTemplate(input, engine) {
  let source = input.toString('utf8').replace(/\r\n/g, '\n');
  let runner = engine.toString('utf8').replace(/\r\n/g, '\n');
  source = source.replace(/c\.purpose==='(?:one-own-ci-stash-family-disabled-only|one-own-local-disabled-only)'/g, "c.purpose==='PURPOSE'");
  source = source.replace(/c\.packages\[0\]\.key==='[A-Za-z0-9_.-]{1,200}'&&c\.packages\[0\]\.sha256==='[a-f0-9]{64}'&&c\.packages\[0\]\.bytes===\d+/g, 'PACKAGE');
  runner = runner.replace(/o\.packages\[0\]\.key==='[A-Za-z0-9_.-]{1,200}'&&o\.packages\[0\]\.sha256==='[a-f0-9]{64}'/g, 'PACKAGE');
  if (sha(source) !== '2e44288d854a5ff57c02e4426d016171bf70931a27313484417f97171e787d68'
      || sha(runner) !== 'c79a0eb984e8929fd3bfb4824c369493c33cd27b20b5c30ef8b3e83833be559e')
    throw Error('UNSUPPORTED_SOURCE_GUARD_TEMPLATE');
}

export function workerGuardSource(value) {
  let source = value.replace(/\r\n/g, '\n');
  source = once(source, 'let pollMetrics=null;', 'let pollMetrics=null;let sourceProof=null,poll=null,finalizing=false;');
  source = once(source, " function guard(scope={phase:'unarmed',accepted:[]})", " function liveBarrier(scope={phase:'unarmed',accepted:[]})");
  source = once(source, "for(const[p,h]of Object.entries(c.sourcePins))need(physical(p).sha256===h,'SOURCE_CHANGED');", '');
  const helpers = `
 const sourceCode=e=>/^[A-Z][A-Z0-9_]{1,99}$/.test(e?.message||'')?e.message:'SOURCE_GUARD_FAILED';
 function cheapSourceContext(){need(!fatal,fatal||'PERMANENT_HOLD');need(hash(configFile)===configPin,'CONFIG_CHANGED');const s=api.getState();need(selectors.activeGameId(s)===c.health.gameId&&selectors.activeProfileId(s)===c.health.profileId&&s.settings.profiles.lastActiveProfile[c.health.gameId]===c.health.profileId,'ACTIVE_CONTEXT_CHANGED');}
 function startSourceProof(){
  need(c.sourceProofMode==='worker'&&c.sourceProof,'SOURCE_PROOF_BINDINGS_REQUIRED');
  need(hash(configFile)===configPin&&hash(__filename)===c.helperSHA256,'OWN_ENTRY_OR_CONFIG_CHANGED');
  need(${JSON.stringify([...WORKER_MODULES, 'physical-proof.cjs'])}.every(name=>/^[a-f0-9]{64}$/.test(c.modulePins?.[name]||'')),'SOURCE_PROOF_MODULE_PINS_REQUIRED');
  for(const[name,pin]of Object.entries(c.modulePins))need(hash(safe(__dirname,name))===pin,'OWN_MODULE_CHANGED');
  need(hash(c.processGuard.path)===c.processGuard.sha256,'PROCESS_GUARD_CHANGED');
  const names=['attempt','failed','completed','preflight-failed','root-ready','capture-ready','own-metadata-preflight','after-raw-digests','guard-timing-terminal'];
  const excludedPaths=[configFile,...names.flatMap(n=>[safe(c.control,n+'.json'),safe(c.control,n+'.json.pending')])];
  for(const p of Object.keys(c.sourcePins)){const rel=path.relative(c.control,p),leaf=rel.toLowerCase();need(!(rel&&!path.isAbsolute(rel)&&!rel.includes(path.sep)&&(leaf.startsWith('early-deploy-held-')||c.packages.some(pkg=>leaf.startsWith(pkg.key.toLowerCase()+'-')))&&/\\.json(?:\\.pending)?$/.test(leaf)),'FILE_PROOF_SCOPE_MUTABLE_SOURCE');}
  const options=require('./helper-source-scope.cjs').validateSourceScope({sourcePins:c.sourcePins,sourceProof:c.sourceProof,excludedPaths});
  sourceProof=require('./helper-source-proof.cjs').createSourceProof(options);
 }
 async function guard(scope={phase:'unarmed',accepted:[]}){cheapSourceContext();need(sourceProof,'SOURCE_PROOF_NOT_BOUND');await sourceProof.prove();sourceProof.assertCurrent();const s=liveBarrier(scope);sourceProof.assertCurrent();return s;}
 function effectBarrier(phase,pkg,id){need(!finalizing&&sourceProof,'SOURCE_EFFECTS_HELD');const current=runner.current();need(current.active&&current.phase===phase&&current.pkg===pkg&&current.downloadId===id,'SOURCE_EFFECT_SCOPE_CHANGED');sourceProof.assertCurrent();liveBarrier({...current,accepted:acceptedSnapshot});sourceProof.assertCurrent();}
 async function stopSourceProof(){const codes=[];if(poll){try{poll.stop();await poll.drain();pollMetrics=poll.metrics();}catch(e){codes.push(sourceCode(e));}}if(sourceProof){try{await sourceProof.close();}catch(e){codes.push(sourceCode(e));}}return codes;}
`;
  source = once(source, ' async function getFileProof(pkg,p)', helpers + ' async function getFileProof(pkg,p)');
  source = once(source, "importOnce:pkg=>new Promise(resolve=>api.events.emit('import-downloads',[pkg.archive],resolve,true))",
    "importOnce:pkg=>new Promise(resolve=>{effectBarrier('import',pkg,null);api.events.emit('import-downloads',[pkg.archive],resolve,true);})");
  source = once(source, "()=>new Promise((resolve,reject)=>api.events.emit('start-install-download',id,{allowAutoEnable:false,allowAutoDeploy:false,profileId:c.health.profileId},(error,owner)=>error?reject(Error('NATIVE_INSTALL_CALLBACK_FAILED')):resolve(owner)))",
    "()=>new Promise((resolve,reject)=>{effectBarrier('install',pkg,id);api.events.emit('start-install-download',id,{allowAutoEnable:false,allowAutoDeploy:false,profileId:c.health.profileId},(error,owner)=>error?reject(Error('NATIVE_INSTALL_CALLBACK_FAILED')):resolve(owner));})");
  source = once(source, 'try{const guardResult=guard();', 'try{startSourceProof();const guardResult=guard();');
  source = once(source, "const poll=require('./poller.cjs').create(", "poll=require('./guard-poller.cjs').create(");
  source = once(source, 'onError:e=>{fatal=e.message;runner.poison(fatal);}', 'onError:e=>{fatal=sourceCode(e);runner.poison(fatal);}');
  source = once(source, "const finalGuard=guard({phase:'verify',accepted});const final=finalGuard&&typeof finalGuard.then==='function'?await finalGuard:finalGuard;",
    "finalizing=true;poll.stop();await poll.drain();need(!fatal,fatal||'PERMANENT_HOLD');await sourceProof.prove({fresh:true});sourceProof.assertCurrent();const sourceCleanup=await sourceProof.close();sourceProof.assertFinalSnapshot();const final=liveBarrier({phase:'verify',accepted});sourceProof.assertFinalSnapshot();");
  source = once(source, "record('completed',{atUTC:", "record('guard-timing-terminal',{guardTiming,serialPoller:poll.metrics(),physicalProof:physical.metrics(),sourceProofMode:'worker',sourceCleanup});record('completed',{atUTC:");
  source = once(source, 'try{poll.start();', 'poll.start();');
  source = once(source, "}finally{poll.stop();pollMetrics=poll.metrics();record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics,physicalProof:physical.metrics()});}", '');
  source = once(source, "}catch(e){fatal=e.message;try{record('preflight-failed',{code:e.message,noReplay:true,reconcileRequired:true});}catch(_){} }",
    "}catch(e){const primaryCode=sourceCode(e);fatal=primaryCode;finalizing=true;const cleanupCodes=await stopSourceProof();try{record('preflight-failed',{code:primaryCode,cleanupCodes,noReplay:true,reconcileRequired:true});}catch(_){} }");
  return source;
}
