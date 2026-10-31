import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {applyExact,hunks,extractClassDeclaration} from './native-patch-test-fixture.mjs';
const base=new URL('./native-patches/vortex-2.9.1/',import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
const required=['VORTEX_NATIVE_INSTALL_MANAGER','VORTEX_NATIVE_MOD_INDEX','VORTEX_NATIVE_DEBOUNCER_SOURCE','VORTEX_NATIVE_MOD_ACTIVATION_SOURCE'];
const integration=(name,fn)=>test(name,{timeout:10000,skip:required.every(k=>process.env[k])?false:'Provide exact original manager/index/Debouncer/modActivation sources'},fn);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function patched(raw,name){const m=JSON.parse(readFileSync(new URL(name+'.json',base))),p=readFileSync(new URL(name+'.patch',base),'utf8');assert.equal(hash(raw),m.inputSHA256);assert.equal(hash(p),m.patchSHA256);const out=applyExact(raw,p,m.upstreamPath);assert.equal(hash(out),m.outputSHA256);return out;}
let cache;
function sources(){
 if(cache)return cache;
 let manager=readFileSync(process.env.VORTEX_NATIVE_INSTALL_MANAGER,'utf8');
 for(const name of ['ordinary-tracking','callback-order','native-activity','strict-selection','copy-error','transfer-join','manager-exclusion','lifecycle-owner-bridge','lifecycle-result-bridge'])manager=patched(manager,name);
 const original=readFileSync(process.env.VORTEX_NATIVE_MOD_INDEX,'utf8');
 const index=patched(patched(original,'deployment-lifecycle'),'deployment-error-types');
 const modOriginal=readFileSync(process.env.VORTEX_NATIVE_MOD_ACTIVATION_SOURCE,'utf8');
 const mod=patched(modOriginal,'deployment-cancel');
 const debouncer=readFileSync(process.env.VORTEX_NATIVE_DEBOUNCER_SOURCE,'utf8');
 assert.equal(hash(debouncer),'5a7177b965a9d546742ef590674624124d08cbc49619025d8c8c150adbdc6e88');
 return cache={manager,original,index,modOriginal,mod,debouncer};
}
function block(source,name){const found=new RegExp('function '+name+'(?:<[^\\n]+>)?\\(').exec(source);const start=found?.index??-1;assert(start>=0,name);const end=source.indexOf('\n}',start);assert(end>start);return source.slice(start,end+2);}
function clock(){let serial=0;const pending=new Map();return {set:fn=>{const id=++serial;pending.set(id,fn);return id;},clear:id=>pending.delete(id),fire:()=>{const entry=pending.entries().next().value;assert(entry,'missing timer');pending.delete(entry[0]);entry[1]();},get size(){return pending.size;}};}
function fixture({lock,bake,post,activate,cancel,executeCore=false,baseline=false,logFailure,onRead,notifyFailure}={}){
 const s=sources(),events=[];let reads=0;
 class ProcessCanceled extends Error{};class UserCanceled extends Error{};class TemporaryError extends Error{};class CycleError extends Error{};
 const errors={ProcessCanceled,UserCanceled,TemporaryError,CycleError};
 const Manager=vm.runInNewContext(extractClassDeclaration(s.manager)+'\nInstallManager;',{randomBytes,...errors},{timeout:1000});
 const manager=Object.assign(Object.create(Manager.prototype),{mNativeInstallScopeId:'manager-fixture-1',mActiveInstalls:new Map(),mPendingInstalls:new Map(),mNativeInstallActivities:new Map(),mNativeInstallTerminals:new Map(),mOptionalDownloadsInFlight:new Set(),mDependencyInstalls:{}});manager.registerNativeManager();
 const profile={id:'p',gameId:'own',modState:{}};
 const state={settings:{window:{useModernLayout:true},gameMode:{discovered:{own:{path:'F:/OwnGame'}}}},persistent:{profiles:{p:profile},mods:{own:{mod:{id:'mod',installationPath:'mod',type:'',fileOverrides:[]}}}}};
 const api={translate:x=>x,getState:()=>{onRead?.(++reads);return state;},store:{getState:()=>{onRead?.(++reads);return state;},dispatch:action=>events.push(['dispatch',action.type])},sendNotification:()=>{},dismissNotification:()=>{},showErrorNotification:(...args)=>{events.push(['error',...args]);if(notifyFailure)throw notifyFailure;},events:{emit:()=>{}},emitAndAwait:(name)=>{events.push(['hook',name]);return name==='did-deploy'?post?.promise??Promise.resolve():Promise.resolve();}};
 const activator={id:'act',name:'Own activator',userGate:async()=>{},prepare:async()=>{},activate:(...args)=>activate?.(...args)??Promise.resolve(),deactivate:async()=>{},finalize:async()=>[],cancel:()=>cancel?.promise??Promise.resolve()};
 const game={id:'own',getModPaths:()=>({'':'F:/OwnGame'})};
 const env={...errors,InstallManager:Manager,path:path.win32,appContext:{isProfileChanging:false},
  unknownToError:value=>value instanceof Error?value:Error(String(value)),log:(_level,message)=>{const error=typeof logFailure==='function'?logFailure(message):logFailure;if(error){events.push(['log-failed']);throw error;}},
  activeProfile:()=>profile,getGame:()=>game,installPathForGame:()=> 'F:/OwnStage',getCurrentActivator:()=>activator,getSelectedActivator:()=>activator,
  getSafe:(value,keys,fallback)=>keys.reduce((v,k)=>v?.[k],value)??fallback,enabledModCountForProfile:()=>1,
  withTrackedActivity:(_a,_b,_c,work)=>work(),withActivationLock:work=>{events.push(['lock']);return executeCore?work():lock?.()??Promise.resolve();},
  bakeSettings:()=>{events.push(['bake']);return bake?.promise??Promise.resolve();},reportRecordedFailures:()=>[],setDeploymentNecessary:()=>({type:'necessary'}),
  startActivity:()=>({type:'start'}),stopActivity:()=>({type:'stop'}),setProgress:()=>({type:'progress'}),updateNotification:()=>({type:'notification'}),
  emitModsDeployed:()=>events.push(['deployed']),emitModListSnapshot:async()=>{},
  getModType:()=>({}),genSubDirFunc:()=>()=>'',getNormalizeFunc:async()=>x=>x,loadActivation:async()=>[],resetDeploymentFailures:()=>{},doSaveActivation:async()=>{},BlacklistSet:class{},truthy:Boolean,
  fs:{ensureDirWritableAsync:async()=>{}},MERGED_PATH:'merged',renderModName:mod=>mod.id,
 };
 const code=[block(s.index,'ownDeploymentTimer'),block(baseline?s.original:s.index,'genUpdateModDeployment'),block(baseline?s.original:s.index,'onDeploySingleMod')].join('\n');
 const js=stripTypeScriptTypes(code,{mode:'transform'});
 const exports=vm.runInNewContext(js+'\n({ownDeploymentTimer,genUpdateModDeployment,onDeploySingleMod});',env,{timeout:1000});
 const rawCode=stripTypeScriptTypes(s.debouncer,{mode:'transform'}).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 const Generic=vm.runInNewContext(rawCode+'\nGenericDebouncer;',{unknownToError:env.unknownToError},{timeout:1000});
 const writer=exports.genUpdateModDeployment(manager);
 const timerClock=clock();const raw=new Generic(timerClock.set,timerClock.clear,(...args)=>writer(api,...args),2000);
 const timer=exports.ownDeploymentTimer(raw);
 const modCode=stripTypeScriptTypes(baseline?s.modOriginal:s.mod,{mode:'transform'}).replace(/^import[\s\S]*?;\n/gm,'').replace(/^export default deployMods;$/gm,'');
 const deployMods=vm.runInNewContext(modCode+'\ndeployMods;',env,{timeout:1000});
 const fromOnce = () => {
  const declaration = block(s.index,'once');
  const stop = declaration.indexOf('  api.events.on(');assert(stop>0);
  const prefix = declaration.slice(0,stop)+'  return deploymentTimer;\n}';
  class RendererDebouncer extends Generic {constructor(func,ms,reset,immediate){super(timerClock.set,timerClock.clear,func,ms,reset,immediate);}}
  const init = vm.runInNewContext(js+'\n'+stripTypeScriptTypes(prefix,{mode:'transform'})+'\nonce;',
    {...env,installManager:manager,Debouncer:RendererDebouncer},{timeout:1000});
  return init(api);
 };
 return {Manager,manager,api,state,events,writer,timer,raw,clock:timerClock,exports,activator,deployMods,fromOnce};
}

test('deployment patches remain pinned prepared source without installation or terminal permits',()=>{
 for(const name of ['deployment-lifecycle','deployment-cancel']){
  const m=JSON.parse(readFileSync(new URL(name+'.json',base))),p=readFileSync(new URL(name+'.patch',base),'utf8');
  assert.equal(hash(p),m.patchSHA256);assert.equal(m.preparedOnly,true);
  for(const key of ['installed','nativeAcceptanceVerified','globalIdleGuarantee','nativeTerminalGuarantee','installationPermit'])assert.equal(m[key],false);
  assert(!p.includes('\r'));for(const h of hunks(p,m.upstreamPath))for(const line of h.body)if(line.startsWith('+'))assert.doesNotMatch(line.slice(1),/[\t ]$/);
 }
});

integration('coalesced schedules own pending work and callbacks cannot claim idle before the full writer ends',async()=>{
 const lock=deferred(),post=deferred(),bake=deferred(),f=fixture({lock:()=>lock.promise,post,bake}),callbacks=[];
 for(let i=0;i<2;i++)f.timer.schedule(error=>{assert.equal(error,null);assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);callbacks.push(i);},false,'p');
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,2);assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 f.clock.fire();await tick();assert.equal(f.events.filter(e=>e[0]==='lock').length,1);
 lock.resolve();await tick();assert.deepEqual(callbacks,[]);assert(f.events.some(e=>e[1]==='did-deploy'));
 post.resolve();await tick();assert.deepEqual(callbacks,[]);assert(f.events.some(e=>e[0]==='bake'));
 bake.resolve();await tick();await tick();assert.deepEqual(callbacks,[0,1]);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('reentrant startup runNow is deferred until GenericDebouncer finishes its current writer',async()=>{
 const locks=[deferred(),deferred()];let f,started=0,requested=false,callbacks=0;
 f=fixture({lock:()=>locks[started++].promise,onRead:()=>{if(!requested){requested=true;f.timer.runNow(()=>callbacks++,false,'p');}}});
 f.timer.runNow(()=>callbacks++,false,'p');await tick();
 assert.equal(started,1);assert.equal(callbacks,0);assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 locks[0].resolve();await tick();await tick();assert.equal(started,2);assert.equal(callbacks,1);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 locks[1].resolve();await tick();await tick();assert.equal(callbacks,2);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('throwing producer callbacks cannot skip siblings or replay callbacks and keep their own uncertainty held',async()=>{
 const f=fixture(),calls=[];
 f.timer.schedule(()=>{calls.push('first');throw Error('own callback');},false,'p');
 f.timer.schedule(()=>calls.push('second'),false,'p');f.clock.fire();await tick();await tick();
 assert.deepEqual(calls,['first','second']);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('wait observers cannot break delivery or claim completion of a newly scheduled run',async()=>{
 const locks=[deferred(),deferred()];let started=0,produced=0,observed=0;
 const f=fixture({lock:()=>locks[started++].promise});
 f.timer.runNow(()=>produced++,false,'p');
 f.timer.wait(()=>{observed++;f.timer.runNow(()=>produced++,false,'p');throw Error('own observer');});
 await tick();locks[0].resolve();await tick();await tick();assert.equal(started,2);assert.equal(observed,1);assert.equal(produced,1);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 locks[1].resolve();await tick();await tick();assert.equal(produced,2);assert.equal(observed,1);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('clear and later reschedule preserve pending ownership rather than refunding canceled timers',async()=>{
 const f=fixture(),calls=[];f.timer.schedule(()=>calls.push(1),false,'p');f.timer.clear();
 assert.equal(f.clock.size,0);assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 f.timer.schedule(()=>calls.push(2),false,'p');f.clock.fire();await tick();await tick();
 assert.deepEqual(calls,[1,2]);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('a synchronous callback followed by enqueue failure cannot refund its pending owner',async()=>{
 const f=fixture(),first=Error('own startup after callback');let calls=0;
 const raw={schedule:cb=>{cb(null);throw first;},runNow:cb=>{cb(null);throw first;},wait:cb=>cb(null)};
 const timer=f.exports.ownDeploymentTimer(raw);
 timer.schedule(()=>calls++);await tick();assert.equal(calls,1);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
 timer.runNow(()=>calls++);await tick();assert.equal(calls,2);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,2);
});

integration('primitive enqueue rejection is normalized once and late callbacks cannot refund its owner',async()=>{
 for(const method of ['schedule','runNow']){
  const f=fixture(),callbacks=[],primitive='own primitive enqueue failure';let late;
  const enqueue=done=>{late=done;throw primitive;};
  const timer=f.exports.ownDeploymentTimer({schedule:enqueue,runNow:enqueue,wait:done=>done(null)});
  assert.equal(timer[method](error=>callbacks.push(error)),undefined);
  await tick();assert.equal(callbacks.length,1);
  assert(callbacks[0] instanceof Error);assert.equal(callbacks[0].message,primitive);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  late(null);late(Error('own late duplicate'));await tick();
  assert.equal(callbacks.length,1);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
  assert.deepEqual(f.events,[]);
 }
});

integration('capacity refusal happens before enqueue and exclusive admission before writer effects',async()=>{
 const f=fixture(),tokens=[];let callbackError;
 for(let i=0;i<4096;i++)tokens.push(f.manager.beginNativeLegacyCall());
 f.timer.schedule(error=>{callbackError=error;},false,'p');assert.match(callbackError.message,/exclusion held/);assert.equal(f.clock.size,0);
 for(const token of tokens)f.manager.endNativeLegacyCall(token);
 f.manager.reserveNativeInstallExclusion();await assert.rejects(f.writer(f.api,false,'p'),/exclusion held/);
 assert.deepEqual(f.events,[]);
});

integration('baseline deploy swallows a reported operation error; patched owner rejects and remains held',async()=>{
 for(const baseline of [true,false]){
  const first=Error('own writer failure'),f=fixture({baseline,lock:()=>Promise.reject(first)});
  if(baseline)await f.writer(f.api,false,'p');else await assert.rejects(f.writer(f.api,false,'p'),error=>error===first);
  assert(f.events.some(e=>e[0]==='error'));
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,baseline?0:1);
 }
});

integration('post-lock hook and reporting failures preserve the original error and never release writer ownership',async()=>{
 const post=deferred(),first=Error('own post hook'),f=fixture({post,notifyFailure:Error('own notification')});
 const observed=assert.rejects(f.writer(f.api,false,'p'),error=>error===first);
 await tick();post.reject(first);await observed;assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('single-mod cancel joins before rejection and cannot mask the operation error through failed logging',async()=>{
 const first=Error('own single activation'),cancel=deferred(),f=fixture({executeCore:true,activate:()=>Promise.reject(first),cancel,logFailure:Error('own log')});
 let settled=false;const run=f.exports.onDeploySingleMod(f.api)('own','mod',true);
 const observed=run.catch(error=>{settled=true;assert.equal(error,first);});
 await tick();assert.equal(settled,false);cancel.reject(Error('own cancel failure'));await observed;
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('lower deployMods also joins cancel and preserves its original error if cleanup logging fails',async()=>{
 const first=Error('own lower activation'),cancel=deferred(),f=fixture({cancel,logFailure:message=>message.includes('cancellation failed')?Error('own cancellation log'):undefined});let settled=false;
 f.activator.activate=()=>Promise.reject(first);
 const run=f.deployMods(f.api,'own','F:/OwnStage','F:/OwnGame',[{id:'mod',installationPath:'mod'}],f.activator,[],'',new Set(),()=> '');
 const observed=run.catch(error=>{settled=true;assert.equal(error,first);});
 await tick();assert.equal(settled,false);cancel.reject(Error('own cancel failure'));await observed;assert(f.events.some(e=>e[0]==='log-failed'));
});


integration('actual once timer factory connects guarded scheduling to the owned deployment writer',async()=>{
 const lock=deferred(),f=fixture({lock:()=>lock.promise}),timer=f.fromOnce();let calls=0;
 timer.schedule(error=>{assert.equal(error,null);calls++;},false,'p');
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
 f.clock.fire();await tick();assert.equal(f.events.filter(e=>e[0]==='lock').length,1);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,2);
 lock.resolve();await tick();await tick();assert.equal(calls,1);assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});
