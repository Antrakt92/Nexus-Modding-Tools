import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash,randomBytes} from 'node:crypto';import {stripTypeScriptTypes} from 'node:module';import vm from 'node:vm';import path from 'node:path';import {applyExact,hunks,extractClassDeclaration} from './native-patch-test-fixture.mjs';
const base=new URL('./native-patches/vortex-2.9.1/',import.meta.url),sha=x=>createHash('sha256').update(x).digest('hex');
const required=['VORTEX_NATIVE_INSTALL_MANAGER','VORTEX_NATIVE_DEPLOY_SOURCE','VORTEX_NATIVE_ACTIVATION_SOURCE'];
const integration=(name,fn)=>test(name,{timeout:10000,skip:required.every(k=>process.env[k])?false:'Provide exact manager, deploy and activation sources'},fn);
const tick=()=>new Promise(resolve=>setImmediate(resolve));const deferred=()=>Promise.withResolvers();
function patch(input,name){const m=JSON.parse(readFileSync(new URL(name+'.json',base))),p=readFileSync(new URL(name+'.patch',base),'utf8');assert.equal(sha(input),m.inputSHA256);assert.equal(sha(p),m.patchSHA256);const output=applyExact(input,p,m.upstreamPath);assert.equal(sha(output),m.outputSHA256);return output;}
function declaration(source,name){const js=stripTypeScriptTypes(source,{mode:'transform'}).replace(/^export /gm,'');let start=js.indexOf('function '+name+'(');assert(start>=0,name);if(js.slice(start-6,start)==='async ')start-=6;const end=js.indexOf('\n}',start);assert(end>start);return js.slice(start,end+2);}
function fixture({queue,stat,remove,manifest,purge}={}){
 let managerSource=readFileSync(process.env.VORTEX_NATIVE_INSTALL_MANAGER,'utf8');for(const name of ['ordinary-tracking','callback-order','native-activity','strict-selection','copy-error','transfer-join','manager-exclusion','lifecycle-owner-bridge','lifecycle-result-bridge'])managerSource=patch(managerSource,name);
 class ProcessCanceled extends Error{};class UserCanceled extends Error{};class TemporaryError extends Error{};class NoDeployment extends Error{};
 const Manager=vm.runInNewContext(extractClassDeclaration(managerSource)+'\nInstallManager;',{randomBytes,ProcessCanceled},{timeout:1000});
 const manager=Object.assign(Object.create(Manager.prototype),{mNativeInstallScopeId:'manager-fixture-1',mActiveInstalls:new Map(),mPendingInstalls:new Map(),mNativeInstallActivities:new Map(),mNativeInstallTerminals:new Map(),mOptionalDownloadsInFlight:new Set(),mDependencyInstalls:{}});manager.registerNativeManager();
 const calls=[],profile={id:'p',gameId:'own'},state={app:{instanceId:'own'},persistent:{profiles:{p:profile}}};
 const api={translate:x=>x,store:{getState:()=>{calls.push('state');return state;},dispatch:()=>calls.push('dispatch')},sendNotification:()=>{},showErrorNotification:()=>{}};
 const common={InstallManager:Manager,ProcessCanceled,UserCanceled,TemporaryError,NoDeployment,path:path.win32,
  log:()=>{},getErrorCode:e=>e?.code,getErrorMessageOrDefault:e=>e?.message,truthy:Boolean,getSafe:(v,keys,otherwise)=>keys.reduce((v,k)=>v?.[k],v)??otherwise,
  profileById:()=>profile,lastActiveProfileForGame:()=> 'p',activeProfile:()=>profile,activeGameId:()=> 'own',discoveryByGame:()=>({path:'F:/OwnGame'}),
  installPathForGame:()=> 'F:/OwnStage',installPath:()=> 'F:/OwnStage',getGame:()=>({getModPaths:()=>({'':'F:/OwnGame'})}),getCurrentActivator:()=>({id:'act'}),getActivator:()=>({id:'act'}),
  withTrackedActivity:(_a,_b,_c,work)=>work(),CURRENT_VERSION:1,Date,
 };
 const activationSource=patch(patch(readFileSync(process.env.VORTEX_NATIVE_ACTIVATION_SOURCE,'utf8'),'activation-join'),'activation-ownership');
 const activationNames=['joinPurgeOperations','purgeDeployedFiles','purgeDeployedFilesTracked','fallbackPurgeType','fallbackPurgeTypeTracked','fallbackPurge','fallbackPurgeTracked','withActivationLock','withActivationLockTracked','saveActivation','saveActivationTracked'];
 const env={...common,getManifestImpl:()=>{calls.push('manifest');return manifest?.()??Promise.resolve({files:[]});},activationQueue:(work,tryOnly)=>{calls.push('queued');return queue?queue(work,tryOnly):work();},
  fs:{statAsync:file=>{calls.push('stat');return stat?.(file)??Promise.resolve({mtime:new Date(0)});},unlinkAsync:async()=>calls.push('unlink'),removeSync:()=>calls.push('remove-sync'),removeAsync:()=>{calls.push('remove');return remove?.promise??Promise.resolve();}}};
 const activation=vm.runInNewContext(activationNames.map(name=>declaration(activationSource,name)).join('\n')+'\n({purgeDeployedFiles,fallbackPurgeType,fallbackPurge,withActivationLock,saveActivation});',env,{timeout:1000});
 const deploySource=patch(patch(readFileSync(process.env.VORTEX_NATIVE_DEPLOY_SOURCE,'utf8'),'purge-join'),'purge-ownership');
 const deployNames=['purgeMods','purgeModsTracked','purgeModsInPath','purgeModsInPathTracked'];
 const deploy=vm.runInNewContext(deployNames.map(name=>declaration(deploySource,name)).join('\n')+'\n({purgeMods,purgeModsInPath});',{...common,...activation,getManifest:async()=>({deploymentMethod:'act'}),purgeModsImpl:()=>{calls.push('purge');return purge?.promise??Promise.resolve();}}, {timeout:1000});
 return {Manager,manager,api,calls,activation,deploy};
}

test('ownership patches are bound to joined prerequisites and shared result bridge',()=>{
 const bridge=JSON.parse(readFileSync(new URL('lifecycle-result-bridge.json',base)));
 for(const name of ['lifecycle-result-bridge','purge-ownership','activation-ownership']){
  const m=JSON.parse(readFileSync(new URL(name+'.json',base))),p=readFileSync(new URL(name+'.patch',base),'utf8');assert.equal(sha(p),m.patchSHA256);assert.equal(m.preparedOnly,true);
  for(const flag of ['installed','nativeAcceptanceVerified','globalIdleGuarantee','nativeTerminalGuarantee','installationPermit'])assert.equal(m[flag],false);
  if(name!=='lifecycle-result-bridge')assert.equal(m.requiredManagerPatchSHA256,bridge.patchSHA256);
  for(const h of hunks(p,m.upstreamPath))for(const line of h.body)if(line.startsWith('+'))assert.doesNotMatch(line.slice(1),/[\t ]$/);
 }
});

integration('all low-level purge/manifest/activation roots refuse before state or filesystem access',async()=>{
 const f=fixture();f.manager.reserveNativeInstallExclusion();
 const entries=[()=>f.deploy.purgeMods(f.api,'own',false),()=>f.deploy.purgeModsInPath(f.api,'own','','F:/OwnGame'),
  ()=>f.activation.purgeDeployedFiles('F:/OwnGame',[]),()=>f.activation.fallbackPurge(f.api,'own'),
  ()=>f.activation.fallbackPurgeType(f.api,{},'own','','F:/OwnGame','F:/OwnStage'),
  ()=>f.activation.saveActivation('own','','instance','F:/OwnGame','F:/OwnStage',[]),()=>f.activation.withActivationLock(async()=>{})];
 for(const call of entries)await assert.rejects(call(),/exclusion held/);
 assert.deepEqual(f.calls,[]);
});

integration('queued activation work remains owned and its result is preserved exactly',async()=>{
 const queue=deferred(),result={own:'identity'},f=fixture({queue:()=>queue.promise});
 const run=f.activation.withActivationLock(async()=>result,true);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);queue.resolve(result);assert.equal(await run,result);
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('manifest save and undeploy calls own their true asynchronous tails',async()=>{
 const remove=deferred(),f=fixture({remove});
 const run=f.activation.saveActivation('own','','instance','F:/OwnGame','F:/OwnStage',[]);
 assert(f.calls.includes('remove-sync'));assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 remove.resolve();await run;assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
 const stat=deferred(),g=fixture({stat:()=>stat.promise});
 const undeploy=g.activation.purgeDeployedFiles('F:/OwnGame',[{relPath:'own',time:0}]);
 assert.throws(()=>g.manager.reserveNativeInstallExclusion(),/busy/);stat.resolve({mtime:new Date(0)});await undeploy;
 assert(g.calls.includes('unlink'));assert.equal(g.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('exported purge and fallback roots retain ownership across their inner work',async()=>{
 const purge=deferred(),f=fixture({purge});const run=f.deploy.purgeMods(f.api,'own',false);await tick();
 assert(f.calls.includes('purge'));assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);purge.resolve();await run;
 assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
 const manifest=deferred(),g=fixture({manifest:()=>manifest.promise});const fallback=g.activation.fallbackPurge(g.api,'own');
 assert.throws(()=>g.manager.reserveNativeInstallExclusion(),/busy/);manifest.resolve({files:[]});await fallback;
 assert.equal(g.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('rejected underlying activation or purge does not refund shared exclusion ownership',async()=>{
 const first=Error('own queued activation failure'),f=fixture({queue:()=>Promise.reject(first)});
 await assert.rejects(f.activation.withActivationLock(async()=>{}),error=>error===first);
 assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
 const purge=deferred(),g=fixture({purge});const run=g.deploy.purgeMods(g.api,'own',false);
 const rejected=assert.rejects(run,error=>error===first);purge.reject(first);await rejected;
 assert.throws(()=>g.manager.reserveNativeInstallExclusion(),/busy/);
});
