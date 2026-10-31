import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {applyExact,hunks,extractClassDeclaration} from './native-patch-test-fixture.mjs';
const base=new URL('./native-patches/vortex-2.9.1/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('lifecycle-handler-ownership.json',base)));
const bridge=JSON.parse(readFileSync(new URL('lifecycle-owner-bridge.json',base)));
const managerPath=process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const handlersPath=process.env.VORTEX_NATIVE_EVENT_HANDLERS;
const integration=(name,fn)=>test(name,{timeout:10000,skip:managerPath&&handlersPath ? false : 'Provide exact original manager and eventHandlers source'},fn);
const hash=x=>createHash('sha256').update(x).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n;});return {promise,resolve,reject};}
let cached;
function sources(){
 if(cached)return cached;
 let manager=readFileSync(managerPath,'utf8');assert.equal(hash(manager),bridge.originalSourceSHA256);
 for(const name of ['ordinary-tracking','callback-order','native-activity','strict-selection','copy-error','transfer-join','manager-exclusion','lifecycle-owner-bridge']){
  const m=JSON.parse(readFileSync(new URL(name+'.json',base))),p=readFileSync(new URL(name+'.patch',base),'utf8');
  assert.equal(hash(manager),m.inputSHA256);assert.equal(hash(p),m.patchSHA256);
  manager=applyExact(manager,p,m.upstreamPath);assert.equal(hash(manager),m.outputSHA256);
 }
 const original=readFileSync(handlersPath,'utf8');assert.equal(hash(original),manifest.originalSourceSHA256);
 const patch=readFileSync(new URL('lifecycle-handler-ownership.patch',base),'utf8');assert.equal(hash(patch),manifest.patchSHA256);
 const handlers=applyExact(original,patch,manifest.upstreamPath);assert.equal(hash(handlers),manifest.outputSHA256);
 return cached={manager,original,handlers};
}
function fixture({ensure,remove,finalHook,willHook,types,activator,baseline=false,batchFault}={}){
 const calls=[],callbacks=[];
 class ProcessCanceled extends Error{};class UserCanceled extends Error{};class TemporaryError extends Error{};
 const globals={randomBytes,ProcessCanceled,UserCanceled,TemporaryError};
 const Manager=vm.runInNewContext(extractClassDeclaration(sources().manager)+'\nInstallManager;',globals,{timeout:1000});
 const manager=Object.assign(Object.create(Manager.prototype),{mNativeInstallScopeId:'manager-fixture-1',mPendingInstalls:new Map(),mActiveInstalls:new Map(),mNativeInstallActivities:new Map(),mNativeInstallTerminals:new Map(),mOptionalDownloadsInFlight:new Set(),mDependencyInstalls:{},mRecentChangedPaths:new Set()});
 manager.registerNativeManager();
 const mods={a:{id:'a',state:'installed',installationPath:'a',type:'first'},b:{id:'b',state:'installed',installationPath:'b',type:'second'}};
 const state={app:{instanceId:'own'},settings:{profiles:{lastActiveProfile:{own:'profile'}},gameMode:{discovered:{own:{path:'F:/OwnGame'}}},mods:{activator:{own:'own-act'}}},persistent:{mods:{own:mods}}};
 const api={store:{getState:()=>state,dispatch:action=>calls.push(['dispatch',action])},
  showErrorNotification:(...args)=>calls.push(['notification',...args]),
  emitAndAwait:(name,...args)=>{calls.push(['event',name]);return name==='did-remove-mods' ? finalHook?.promise??Promise.resolve() : name==='will-remove-mods' ? willHook?.promise??Promise.resolve() : Promise.resolve();}};
 const environment={...globals,InstallManager:Manager,path:path.win32,log:()=>{},
  truthy:Boolean,getSafe:(v,keys,fallback)=>keys.reduce((v,k)=>v?.[k],v)??fallback,
  getErrorCode:e=>e?.code,unknownToError:e=>e instanceof Error?e:Error(String(e)),getErrorMessageOrDefault:e=>String(e?.message??e),
  installPathForGame:()=> 'F:/OwnStage',setModsEnabled:()=>calls.push(['disable']),
  addMod:(_game,mod)=>({type:'add',id:mod.id}),removeMod:(_game,id)=>({type:'remove',id}),
  startActivity:()=>({type:'start'}),stopActivity:()=>({type:'stop'}),batchDispatch:(_store,actions)=>{calls.push(['batch',...actions]);if(batchFault)throw batchFault;},
  emitModRemoved:()=>calls.push(['removed']),modName:mod=>mod.id,
  fs:{ensureDirAsync:target=>{calls.push(['ensure',target]);return ensure?.promise??Promise.resolve();},removeAsync:target=>{calls.push(['remove',target]);return remove?.(target)??Promise.resolve();}},
  getGame:()=>types?{getModPaths:()=>types}:undefined,
  getModType:()=>({}),genSubDirFunc:()=>()=>'',allTypesSupported:()=>({errors:[]}),
  getNormalizeFunc:async()=>value=>value,loadActivation:async()=>[],saveActivation:async(...args)=>calls.push(['save',args[1]]),
  resetDeploymentFailures:()=>{},reportRecordedFailures:()=>calls.push(['report']),
 };
 const js=stripTypeScriptTypes(baseline?sources().original:sources().handlers,{mode:'transform'}).replace(/^import[\s\S]*?;\n/gm,'').replace(/^export /gm,'');
 const h=vm.runInNewContext(js+'\n({onRemoveMods,onRemoveMod,onAddMod,undeploy,joinNativeLifecycle:typeof joinNativeLifecycle===\"function\"?joinNativeLifecycle:undefined});',environment,{timeout:1000});
 return {Manager,manager,state,mods,api,calls,callbacks,h,activator,callback:error=>callbacks.push(error)};
}

test('lifecycle patches pin original files and preserve prepared-only boundaries',()=>{
 for(const [name,m] of [['lifecycle-owner-bridge',bridge],['lifecycle-handler-ownership',manifest]]){
  const p=readFileSync(new URL(name+'.patch',base),'utf8');assert.equal(hash(p),m.patchSHA256);
  assert.equal(m.preparedOnly,true);for(const key of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','installationPermit'])assert.equal(m[key],false);
  assert(!p.includes('\r'));for(const h of hunks(p,m.upstreamPath))for(const line of h.body)if(line.startsWith('+'))assert.doesNotMatch(line.slice(1),/[\t ]$/);
 }
 assert.equal(manifest.prerequisitePatchSHA256,bridge.patchSHA256);
});

integration('exclusive owner refuses create and remove before Redux, flags, hooks or filesystem work',async()=>{
 const f=fixture();f.manager.reserveNativeInstallExclusion();
 assert.equal(f.h.onAddMod(f.api,'own',{id:'new',installationPath:'new'},f.callback),undefined);
 assert.equal(f.h.onRemoveMods(f.api,[],f.manager,'own',['a'],f.callback),undefined);
 await tick();assert.equal(f.callbacks.length,2);for(const e of f.callbacks)assert.match(e.message,/exclusion held/);
 assert.deepEqual(f.calls,[]);
});

integration('create callback cannot release directory ownership before its actual promise tail',async()=>{
 const ensure=deferred(),f=fixture({ensure});
 assert.equal(f.h.onAddMod(f.api,'own',{id:'new',installationPath:'new'},f.callback),undefined);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);assert.equal(f.callbacks.length,0);
 ensure.resolve();await tick();await tick();assert.deepEqual(f.callbacks,[null]);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);f.manager.reserveNativeInstallExclusion();
});

integration('remove ownership survives its callback through the final did-remove-mods hook',async()=>{
 const finalHook=deferred(),f=fixture({finalHook});
 assert.equal(f.h.onRemoveMod(f.api,[],f.manager,'own','a',f.callback),undefined);
 await tick();assert.deepEqual(f.callbacks,[null]);assert(f.calls.some(c=>c[1]==='did-remove-mods'));
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 finalHook.resolve();await tick();await tick();assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('partial removal joins a pending sibling before reporting failure and retains uncertain ownership',async()=>{
 const sibling=deferred(),first=Error('own removal failure');
 const f=fixture({remove:target=>target.endsWith('a')?Promise.reject(first):sibling.promise});
 f.h.onRemoveMods(f.api,[],f.manager,'own',['a','b'],f.callback);
 await tick();assert.equal(f.callbacks.length,0);assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 sibling.resolve();await tick();await tick();assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0],first);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('create errors and throwing callbacks are observed once without an unhandled tail',async()=>{
 const ensure=deferred(),f=fixture({ensure}),first=Error('own create failure');let notices=0;
 f.h.onAddMod(f.api,'own',{id:'new',installationPath:'new'},()=>{notices++;throw Error('own callback failure');});
 ensure.reject(first);await tick();await tick();assert.equal(notices,1);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
 assert(f.calls.some(c=>c[0]==='notification'&&c[2]===first));
});

integration('join helper retains already-started siblings and the first error including undefined',async()=>{
 for(const error of [Error('own first'),undefined]){
  const f=fixture(),sibling=deferred();let settled=false;
  const run=f.h.joinNativeLifecycle([0,1],i=>i===0?Promise.reject(error):sibling.promise);
  const observed=run.then(()=>{settled=true;throw Error('Unexpected success');},e=>{settled=true;assert.equal(e,error);});
  await tick();assert.equal(settled,false);sibling.resolve();await observed;
 }
 const f=fixture(),sibling=deferred();let calls=0,settled=false;
 const first=Error('own synchronous failure');
 const run=f.h.joinNativeLifecycle([0,1,2],i=>{calls++;if(i===1)throw first;return sibling.promise;});
 const observed=run.catch(e=>{settled=true;assert.equal(e,first);});
 await tick();assert.equal(calls,2);assert.equal(settled,false);sibling.resolve();await observed;
});

integration('actual undeploy waits for sibling types and asynchronous cancellation before propagating primary error',async()=>{
 const first=Error('own deactivate failure'),sibling=deferred(),cancel=deferred();
 const activator={id:'own-act',prepare:async()=>{},deactivate:target=>target.endsWith('a')?Promise.reject(first):sibling.promise,
  cancel:()=>cancel.promise,finalize:async()=>[]};
 const f=fixture({types:{first:'F:/OwnFirst',second:'F:/OwnSecond'}});let settled=false;
 const run=f.h.undeploy(f.api,[activator],'own',[f.mods.a,f.mods.b]);
 const observed=run.catch(e=>{settled=true;assert.equal(e,first);});
 await tick();assert.equal(settled,false);cancel.reject(Error('own cleanup error'));await tick();assert.equal(settled,false);
 sibling.resolve();await observed;assert(f.calls.some(c=>c[0]==='save'&&c[1]==='second'));
});

integration('static lifecycle tracking shares the manager capacity and retains rejected or unknown work',async()=>{
 const f=fixture(),run=deferred();const tail=f.Manager.trackNativeLifecycleCall(()=>run.promise);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);run.resolve();await tail;
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
 const error=Error('own unknown startup');await assert.rejects(f.Manager.trackNativeLifecycleCall(()=>{throw error;}),e=>e===error);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
});


integration('baseline undeploy rejects while another type is still writing; patched source joins it',async()=>{
 for(const baseline of [true,false]){
  const first=Error('own type failure'),sibling=deferred();let settled=false;
  const activator={id:'own-act',prepare:async()=>{},deactivate:target=>target.endsWith('a')?Promise.reject(first):sibling.promise,
    cancel:async()=>{},finalize:async()=>[]};
  const f=fixture({baseline,types:{first:'F:/OwnFirst',second:'F:/OwnSecond'}});
  const observed=f.h.undeploy(f.api,[activator],'own',[f.mods.a,f.mods.b]).catch(error=>{settled=true;assert.equal(error,first);});
  await tick();assert.equal(settled,baseline);
  assert(!f.calls.some(c=>c[0]==='save'&&c[1]==='second'));
  sibling.resolve();await observed;await tick();
  assert(f.calls.some(c=>c[0]==='save'&&c[1]==='second'));
 }
});

integration('baseline partial removal reports success; patched source reports the original failed removal',async()=>{
 for(const baseline of [true,false]){
  const first=Error('own partial failure'),sibling=deferred();
  const f=fixture({baseline,remove:target=>target.endsWith('a')?Promise.reject(first):sibling.promise});
  f.h.onRemoveMods(f.api,[],f.manager,'own',['a','b'],f.callback);
  await tick();assert.equal(f.callbacks.length,0);
  sibling.resolve();await tick();await tick();
  assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0],baseline?null:first);
  const published=f.calls.filter(c=>c[0]==='batch').flatMap(c=>c.slice(1)).map(a=>a.id);
  assert.deepEqual(published,baseline?[]:['b']);
 }
});


integration('a throwing removal error callback cannot replace the primary failure or be called twice',async()=>{
 const first=Error('own primary removal failure'),f=fixture({remove:()=>Promise.reject(first)});let calls=0;
 f.h.onRemoveMods(f.api,[],f.manager,'own',['a'],()=>{calls++;throw Error('own callback failure');});
 await tick();await tick();assert.equal(calls,1);
 assert(f.calls.some(c=>c[0]==='notification'&&c[2]===first));
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});


integration('final-hook failure preserves an earlier removal error and does not repeat its error callback',async()=>{
 const first=Error('own original failure'),finalHook=deferred();
 const f=fixture({remove:()=>Promise.reject(first),finalHook});
 f.h.onRemoveMods(f.api,[],f.manager,'own',['a'],f.callback);
 await tick();assert.deepEqual(f.callbacks,[first]);
 finalHook.reject(Error('own final hook failure'));await tick();await tick();
 assert.deepEqual(f.callbacks,[first]);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
 assert.equal(f.calls.filter(c=>c[0]==='notification').length,0);
});


integration('an uncertain removal-state batch is not automatically dispatched a second time',async()=>{
 const first=Error('own uncertain batch failure'),f=fixture({batchFault:first});
 f.h.onRemoveMods(f.api,[],f.manager,'own',['a','b'],f.callback);
 await tick();await tick();
 assert.equal(f.calls.filter(c=>c[0]==='batch').length,1);
 assert.deepEqual(f.callbacks,[first]);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('static lifecycle producers share the existing finite legacy ownership budget',()=>{
 const f=fixture(),tokens=[];let invoked=false;
 for(let i=0;i<4096;i++)tokens.push(f.manager.beginNativeLegacyCall());
 assert.throws(()=>f.Manager.trackNativeLifecycleCall(()=>{invoked=true;}),/exclusion held/);
 assert.equal(invoked,false);
 for(const token of tokens)f.manager.endNativeLegacyCall(token);
});
