'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {TIMEOUT_MS,readNativePreflight}=require('./native-preflight.cjs');
const scratch=path.resolve(__dirname,'../../../local-state');
function fixture() {
  for(let p=scratch;;p=path.dirname(p)) {if(fs.existsSync(p))assert.equal(fs.lstatSync(p).isSymbolicLink(),false);if(p===path.dirname(p))break;}
  fs.mkdirSync(scratch,{recursive:true});const root=fs.mkdtempSync(path.join(scratch,'native-preflight-test-'));
  const roots=Object.fromEntries(['gamePath','stagingPath','downloadPath'].map(k=>{const p=path.join(root,k);fs.mkdirSync(p);return[k,p];}));
  const state={settings:{gameMode:{discovered:{game:{path:roots.gamePath}}}},persistent:{profiles:{profile:{gameId:'game'}}}};
  const api={getState:()=>state},selectors={activeGameId:()=> 'game',activeProfileId:()=> 'profile',installPathForGame:()=>roots.stagingPath,downloadPathForGame:()=>roots.downloadPath};
  let table={'':roots.gamePath,enb:roots.gamePath,dinput:roots.gamePath};
  const util={getGame:id=>{assert.equal(id,'game');return{getModPaths:p=>{assert.equal(p,roots.gamePath);return table;}};}};
  const native={app:{getVersion(){assert.equal(this,native.app);assert.equal(arguments.length,0);return Promise.resolve('2.9.1');}},
    updater:{getStatus(){assert.equal(this,native.updater);assert.equal(arguments.length,0);return Promise.resolve({seq:7,snapshot:{state:{type:'idle'}}});}}};
  const live=new Map();let id=0;const timers={setTimeout(fn,ms){assert.equal(ms,TIMEOUT_MS);live.set(++id,fn);return id;},clearTimeout(id){live.delete(id);}};
  return{root,roots,state,api,selectors,util,native,live,timers,options:{getWindow:()=>({api:native}),timers},setTable:v=>{table=v;},run(options){return readNativePreflight(api,selectors,util,options??this.options);}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('active native projection retains aliases, actual version and detached context without authority',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,'ok');assert.deepEqual(r.appVersion,{available:true,value:'2.9.1'});
 assert.deepEqual(r.updater,{available:true,state:'idle',sequence:7});assert.deepEqual(r.deploymentTargets.map(x=>x.typeId),['','dinput','enb']);
 assert.ok(r.deploymentTargets.every(x=>x.sameAsDefault));assert.equal(r.context.profileId,'profile');assert.match(r.context.filesystemIds.gamePath,/^\d+:\d+$/);
 assert.equal(f.live.size,0);for(const k of ['snapshotAtomic','nativeEffects','shutdownPermit','sourceAdmissionVerified'])assert.equal(r[k],false);
 r.context.filesystemIds.gamePath='changed';assert.notEqual((await f.run()).context.filesystemIds.gamePath,'changed');
});
test('all eight updater states are whitelisted while private fields and getters are never traversed',async()=>{
 for(const state of ['disabled','idle','checking','available','downgrade-offered','downloading','staged','error']){
 const f=fixture();f.native.updater.getStatus=()=>({seq:0,snapshot:{state:{type:state,get message(){assert.fail('raw private getter');},releaseNotes:'https://private.invalid/token'},justUpdatedFrom:'secret'},changes:[{url:'secret'}]});
 const r=await f.run();assert.deepEqual(r.updater,{available:true,state,sequence:0});assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(JSON.stringify(r).includes('private.invalid'),false);assert.equal(f.live.size,0);}
});
test('distinct native targets are observed without filesystem access or admission',async()=>{
 const f=fixture(),other=path.join(f.root,'nonexistent-target');f.setTable({'':f.roots.gamePath,other});
 const r=await f.run();assert.equal(r.deploymentTargets[1].path,other);assert.equal(r.deploymentTargets[1].sameAsDefault,false);assert.equal(fs.existsSync(other),false);
});
test('missing window/getters and thrown/rejected native errors are explicit partial without raw details',async()=>{
 for(const mode of ['window','app','updater','throw','reject']){
 const f=fixture();if(mode==='window')f.options.getWindow=()=>{throw Error('secret/path');};
 if(mode==='app')delete f.native.app;if(mode==='updater')delete f.native.updater;
 if(mode==='throw')f.native.app.getVersion=()=>{throw Error('secret/path');};
 if(mode==='reject')f.native.updater.getStatus=()=>Promise.reject(Error('secret/path'));
 const r=await f.run();assert.equal(r.status,'partial');assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(f.live.size,0);
 assert.ok(!r.appVersion.available||!r.updater.available);}
});
test('hung getters timeout independently, clear timers, and observe late rejection without retry',async()=>{
 const f=fixture();let reject,calls=0;f.native.updater.getStatus=()=>{calls++;return new Promise((_,r)=>{reject=r;});};
 const flight=f.run();await tick();assert.equal(f.live.size,1);for(const cb of [...f.live.values()])cb();
 const r=await flight;assert.equal(r.appVersion.available,true);assert.deepEqual(r.updater,{available:false,code:'NATIVE_PREFLIGHT_UPDATER_TIMEOUT'});assert.equal(f.live.size,0);
 reject(Error('late private failure'));await tick();assert.equal(calls,1);
});
test('both hanging getters have finite projection with no static version or idle fallback',async()=>{
 const f=fixture();f.native.app.getVersion=f.native.updater.getStatus=()=>new Promise(()=>{});
 const flight=f.run();await tick();assert.equal(f.live.size,2);for(const cb of [...f.live.values()])cb();const r=await flight;
 assert.equal(r.status,'partial');assert.equal(r.appVersion.available,false);assert.equal(r.updater.available,false);assert.equal(f.live.size,0);
});
test('invalid native versions and updater descriptors/sequence/state refuse only affected projection',async()=>{
 for(const value of ['secret/url','2.9.1\n',undefined,42,'x'.repeat(200)]){const f=fixture();f.native.app.getVersion=()=>value;const r=await f.run();assert.equal(r.appVersion.available,false);assert.equal(r.updater.available,true);}
 for(const value of [{seq:-1,snapshot:{state:{type:'idle'}}},{seq:1.5,snapshot:{state:{type:'idle'}}},{seq:0,snapshot:{state:{type:'installing'}}},Object.defineProperty({},'seq',{enumerable:true,get(){assert.fail('accessor');}}),new Proxy({},{get(){assert.fail('proxy');}})]){
 const f=fixture();f.native.updater.getStatus=()=>value;const r=await f.run();assert.equal(r.updater.available,false);assert.equal(f.live.size,0);}
});
test('context/profile/physical root drift during IPC refuses the whole snapshot',async()=>{
 for(const mode of ['profile','game','root']){const f=fixture();f.native.updater.getStatus=()=>{if(mode==='profile')f.selectors.activeProfileId=()=> 'new';if(mode==='game')f.state.persistent.profiles.profile.gameId='other';if(mode==='root'){const old=f.roots.gamePath;fs.renameSync(old,old+'-old');fs.mkdirSync(old);}return{seq:0,snapshot:{state:{type:'idle'}}};};
 await assert.rejects(f.run(),/NATIVE_PREFLIGHT_CONTEXT_(?:INVALID|CHANGED)/);assert.equal(f.live.size,0);}
});
test('canonical target table is sampled after await, aliases cannot appear or retarget silently',async()=>{
 for(const table of [f=>({'':f.roots.gamePath}),f=>({'':f.roots.gamePath,enb:f.root,dinput:f.roots.gamePath})]){
 const f=fixture();f.native.updater.getStatus=()=>{f.setTable(table(f));return{seq:0,snapshot:{state:{type:'idle'}}};};await assert.rejects(f.run(),/NATIVE_PREFLIGHT_TARGETS_CHANGED/);assert.equal(f.live.size,0);}
});
test('table limits, unsafe paths/IDs, symbols, accessors, proxies and inherited data reject before IPC',async()=>{
 const fns=[f=>({enb:f.roots.gamePath}),f=>({'':'relative'}),f=>({'':'https://private.invalid'}),f=>({'':f.roots.gamePath,'bad\n':f.root}),f=>({'':f.root,'https://secret':f.root}),f=>({'':f.root,constructor:f.root}),f=>Object.assign(Object.create(null),{'':f.root},JSON.parse('{"__proto__":"x"}')),f=>Object.fromEntries(Array.from({length:33},(_,i)=>[i?String(i):'',f.root])),
 f=>Object.assign(Object.create({enb:f.root}),{'':f.root}),f=>Object.defineProperty({},'',{enumerable:true,get(){assert.fail('getter');}}),f=>Object.assign({'':f.root},{[Symbol('x')]:f.root}),f=>new Proxy({},{ownKeys(){assert.fail('proxy');}})];
 for(const make of fns){const f=fixture();f.setTable(make(f));f.native.app.getVersion=()=>assert.fail('IPC called');await assert.rejects(f.run(),/NATIVE_PREFLIGHT_TARGETS_INVALID/);assert.equal(f.live.size,0);}
});

test('monotonic deadline rejects overdue resolution even before timer callback runs',async()=>{
 const f=fixture();let now=0;f.timers.now=()=>now;
 f.native.updater.getStatus=()=>{now=TIMEOUT_MS+1;return {seq:0,snapshot:{state:{type:'idle'}}};};
 const r=await f.run();assert.equal(r.status,'partial');assert.equal(r.updater.code,'NATIVE_PREFLIGHT_UPDATER_TIMEOUT');assert.equal(f.live.size,0);
});

test('ordinary cross-realm target maps remain data-only and preserve native aliases',async()=>{
 const f=fixture(),vm=require('node:vm');
 const table=vm.runInNewContext('('+JSON.stringify({'':f.roots.gamePath,enb:f.roots.gamePath})+')');
 assert.notEqual(Object.getPrototypeOf(table),Object.prototype);f.setTable(table);
 const r=await f.run();assert.equal(r.status,'ok');assert.deepEqual(r.deploymentTargets.map(row=>row.typeId),['','enb']);
});
test('ordinary cross-realm updater IPC records project the actual state without exposing payload',async()=>{
 const f=fixture(),vm=require('node:vm');
 f.native.updater.getStatus=()=>vm.runInNewContext('({seq:9,snapshot:{state:{type:"staged",releaseNotes:"secret"}},changes:[]})');
 const r=await f.run();assert.deepEqual(r.updater,{available:true,state:'staged',sequence:9});assert.equal(JSON.stringify(r).includes('secret'),false);
});

test('cross-realm custom classes, forged prototypes, proxy prototypes and constructor accessors remain refused',async()=>{
 const vm=require('node:vm');
 const hostile=[
  f=>vm.runInNewContext('new (class Table {constructor(){this[" "]="x";}})()'),
  f=>Object.assign(Object.create(Object.assign(Object.create(null),{constructor:Object})),{'':f.root}),
  f=>Object.assign(Object.create(new Proxy({}, {getPrototypeOf(){assert.fail('proxy prototype trap');}})),{'':f.root}),
  f=>Object.assign(Object.create(Object.defineProperty(Object.create(null),'constructor',{get(){assert.fail('constructor accessor');}})),{'':f.root}),
  f=>Object.assign(Object.create({get [Symbol.toStringTag](){assert.fail('toStringTag getter');}}),{'':f.root}),
 ];
 for(const make of hostile){const f=fixture();f.setTable(make(f));await assert.rejects(f.run(),/NATIVE_PREFLIGHT_TARGETS_INVALID/);}
 const f=fixture();f.native.updater.getStatus=()=>vm.runInNewContext('new (class Reply {constructor(){this.seq=1;this.snapshot={state:{type:"idle"}};}})()');
 assert.equal((await f.run()).updater.available,false);
});
