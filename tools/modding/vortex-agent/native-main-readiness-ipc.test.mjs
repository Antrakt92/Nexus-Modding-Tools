import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {applyExact} from './native-patch-test-fixture.mjs';

const base=new URL('./native-patches/vortex-persistence-2.9.1/',import.meta.url);
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO;
const sha=x=>createHash('sha256').update(x).digest('hex');
const pairs=[['native-main-readiness-ipc','ack-main-ipc'],['native-main-readiness-preload','ack-preload'],['native-main-readiness-shared-ipc','ack-shared-ipc'],['native-main-readiness-shared-preload','ack-shared-preload']];
const stage=name=>({m:JSON.parse(fs.readFileSync(new URL(name+'.json',base))),patch:fs.readFileSync(new URL(name+'.patch',base),'utf8')});
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO for exact original sources'},fn);
function original(file){return execFileSync('git',['-C',repo,'show','c80326367cbe6d96621ad6cf4a5488ef49bac110:'+file],{maxBuffer:2e6}).toString();}
function prepared(name){const prior=pairs.find(p=>p[0]===name)[1],a=stage(prior),b=stage(name);let text=original(a.m.upstreamPath);for(const row of [a,b]){assert.equal(sha(text),row.m.inputSHA256);assert.equal(sha(row.patch),row.m.patchSHA256);text=applyExact(text,row.patch,row.m.upstreamPath);assert.equal(sha(text),row.m.outputSHA256);}return text;}
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture({watchFailure=false,readyFailure=false,identity}={}){
 const handlers=new Map(),timers=new Map(),d=deferred(),token=Object.freeze({}),state={now:0,waits:0,checks:0,flushes:0};let timerSeq=0;
 const persistor={async flushPersistenceAcknowledged(){state.flushes++;}},main={current:persistor};
 const owner=new EventEmitter();Object.assign(owner,{id:91,mainFrame:{processId:17,routingId:22},dead:false,isDestroyed(){return this.dead;},getOSProcessId(){identity?.(state,owner);return 8123;}});
 if(watchFailure)owner.on=()=>{throw Error('own watcher unavailable');};
 // Execute the actual upstream wire-envelope implementation. No Electron import.
 const support=stripTypeScriptTypes(original('src/main/src/ipc.ts'),{mode:'transform'}),a=support.indexOf('function mainHandle('),b=support.indexOf('function mainSend(',a);
 assert.ok(a>=0&&b>a);
 const handle=vm.runInNewContext(support.slice(a,b)+'\nmainHandle;',{ipcMain:{handle(n,fn){assert.equal(handlers.has(n),false);handlers.set(n,fn);}},ipcLogger(){},assertTrustedSender(){},toWireError:e=>e});
 const text=stripTypeScriptTypes(prepared('native-main-readiness-ipc'),{mode:'transform'}).replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
 const api=vm.runInNewContext(text+'\n({setupPersistenceIPC,bindPersistenceAcknowledgementSender});',{
  betterIpcMain:{handle,on(){},send(){}},ipcMain:{on(){}},log(){},registerAllPersistedHives:async()=>({}),
  getMainPersistor:()=>main.current,waitForNativeMainPersistenceReady(){state.waits++;return readyFailure?Promise.reject(Error('own readiness unavailable')):d.promise;},
  checkNativeMainPersistenceReady(o){state.checks++;assert.equal(o,token);state.onCheck?.();if(main.current!==persistor)throw Error('own stale');},
  process:{pid:4321},performance:{now:()=>state.now},setTimeout(fn,ms){const id=++timerSeq;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
 });api.setupPersistenceIPC(persistor);api.bindPersistenceAcknowledgementSender(owner);
 let event={sender:owner,senderFrame:owner.mainFrame};
 const invoke=async(channel,...args)=>{const reply=await handlers.get(channel)(event,...args);if(reply.error)throw reply.error;return reply.data;};
 const preload=stripTypeScriptTypes(prepared('native-main-readiness-preload'),{mode:'transform'}),p=preload.indexOf('persist: {'),q=preload.indexOf('extensions: {',p);assert.ok(p>=0&&q>p);
 const persist=vm.runInNewContext('({'+preload.slice(p,q)+'}).persist;',{betterIpcRenderer:{invoke}});
 return{api,state,owner,main,timers,token,resolve:()=>d.resolve(token),reject:e=>d.reject(e),setEvent:e=>{event=e;},event:()=>event,
  read:(id='request_001')=>persist.observeMainReadiness(id),raw:(...args)=>invoke('persist:native-main-readiness',...args),ack:()=>invoke('persist:diffs-acknowledged',[]),
  timeout(){state.now+=5001;for(const {fn}of [...timers.values()])fn();}};
}
const rejects=(p,code)=>assert.rejects(p,e=>e.message==='NATIVE_MAIN_READINESS_'+code);

test('four closed artifacts retain exact predecessors and no effect authority',()=>{for(const [n,prior]of pairs){const {m,patch}=stage(n),p=stage(prior).m;assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,p.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.patchSHA256);assert.equal(patch.includes('\r'),false);for(const k of ['installed','nativeAcceptanceVerified','installationPermit','nativeAdmission','effectsAllowed'])assert.equal(m[k],false);}});
integration('exact shared/preload source and real setup handler return only main-derived twelve fields',async()=>{for(const [n]of pairs)prepared(n);const f=fixture(),pending=f.read();assert.equal(f.state.waits,1);f.resolve();const r=await pending;assert.deepEqual(JSON.parse(JSON.stringify(r)),{schema:'native-main-readiness/1',requestId:'request_001',mainProcessId:4321,webContentsId:91,rendererProcessId:8123,frameProcessId:17,frameRoutingId:22,frameEpoch:0,mainReadinessObserved:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false});assert.equal(f.timers.size,0);assert.match(prepared('native-main-readiness-shared-ipc'),/"persist:native-main-readiness": \(requestId: string\) => Promise<NativeMainReadinessObservation>/);assert.match(prepared('native-main-readiness-shared-preload'),/observeMainReadiness\(requestId: string\): Promise<NativeMainReadinessObservation>/);});
integration('request is one scalar ID; malformed IDs and additional caller authority fields refuse',async()=>{const f=fixture();for(const id of [undefined,null,{},[],1,'short','has space','a'.repeat(97),'abcdefgh\n','abcdefgh\r','abcdefgh\u2028','abcdefgh\u2029'])await rejects(f.raw(id),'REQUEST');await rejects(f.raw('request_001',{mainProcessId:4321,ready:true}),'REQUEST');assert.equal(f.state.waits,0);assert.equal(f.timers.size,0);});
integration('unknown sender, absent frame and subframe refuse before observing main readiness',async()=>{for(const kind of ['sender','missing','subframe']){const f=fixture();f.setEvent({sender:kind==='sender'?{}:f.owner,senderFrame:kind==='missing'?null:kind==='subframe'?{}:f.owner.mainFrame});await rejects(f.read(),'CONTEXT');assert.equal(f.state.waits,0);assert.equal(f.timers.size,0);}});
integration('one active read refuses BUSY and uses one retained underlying observation',async()=>{const f=fixture(),p=f.read();await rejects(f.read('request_002'),'BUSY');assert.equal(f.state.waits,1);assert.equal(f.timers.size,1);f.resolve();await p;for(let n=0;n<5;n++)await f.read('request_00'+n);assert.equal(f.state.waits,1);assert.equal(f.timers.size,0);});
integration('same-frame navigation rejects immediately; fresh read uses new main-generated epoch',async()=>{const f=fixture(),p=f.read();f.owner.emit('did-start-navigation',{isMainFrame:true});await rejects(p,'CONTEXT');assert.equal(f.timers.size,0);f.resolve();const r=await f.read('request_002');assert.equal(r.frameEpoch,1);assert.equal(f.state.waits,1);});
integration('subframe navigation does not invalidate main frame while destruction/process loss does',async()=>{const f=fixture(),p=f.read();f.owner.emit('did-start-navigation',{isMainFrame:false});f.resolve();assert.equal((await p).frameEpoch,0);for(const event of ['destroyed','render-process-gone']){const g=fixture(),q=g.read();if(event==='destroyed')g.owner.dead=true;g.owner.emit(event,{},{});await rejects(q,'CONTEXT');assert.equal(g.timers.size,0);g.resolve();}});
integration('watch registration is idempotent; watcher failure disables read without breaking old ACK',async()=>{const f=fixture();for(let n=0;n<8;n++)f.api.bindPersistenceAcknowledgementSender(f.owner);for(const n of ['did-start-navigation','destroyed','render-process-gone'])assert.equal(f.owner.listenerCount(n),1);const g=fixture({watchFailure:true});await rejects(g.read(),'CONTEXT');await g.ack();assert.equal(g.state.flushes,1);assert.equal(g.state.waits,0);});
integration('captured persistor mismatch before or after await never certifies a newer main',async()=>{for(const late of [false,true]){const f=fixture();if(!late)f.main.current={};const p=f.read();if(late){f.main.current={};f.resolve();}await rejects(p,'CONTEXT');assert.equal(f.state.waits,late?1:0);}});
integration('readiness failure and close during await return unavailable without replay or new waiters',async()=>{const f=fixture({readyFailure:true});await rejects(f.read(),'UNAVAILABLE');await rejects(f.read('request_002'),'UNAVAILABLE');assert.equal(f.state.waits,1);const g=fixture(),p=g.read();g.reject(Error('own main closed'));await rejects(p,'UNAVAILABLE');assert.equal(g.timers.size,0);});
integration('timeout abandons only this read; repeated reads do not attach more underlying observers',async()=>{const f=fixture();for(let n=0;n<3;n++){const p=f.read();f.timeout();await rejects(p,'PENDING');assert.equal(f.timers.size,0);}assert.equal(f.state.waits,1);f.resolve();await tick();assert.equal((await f.read()).mainReadinessObserved,true);assert.equal(f.state.waits,1);});
integration('main source getter failure or invalid integer cannot produce partial success',async()=>{for(const kind of ['throw','zero','fraction']){const f=fixture();if(kind==='throw')Object.defineProperty(f.owner.mainFrame,'routingId',{get(){throw Error('private path must not escape');}});else f.owner.getOSProcessId=()=>kind==='zero'?0:1.5;await rejects(f.read(),kind==='throw'?'UNAVAILABLE':'CONTEXT');assert.equal(f.state.waits,0);}});
integration('epoch/getter reentry and post-ready identity drift are rechecked before replying',async()=>{const f=fixture();let once=true;f.owner.getOSProcessId=()=>{if(once){once=false;f.owner.emit('did-start-navigation',{isMainFrame:true});}return 8123;};await rejects(f.read(),'CONTEXT');const g=fixture(),p=g.read();g.state.onCheck=()=>{g.owner.mainFrame.routingId++;};g.resolve();await rejects(p,'CONTEXT');});
integration('elapsed deadline is checked after source getters and before observing main',async()=>{const f=fixture({identity:s=>{s.now+=5001;}});await rejects(f.read(),'PENDING');assert.equal(f.state.waits,0);assert.equal(f.timers.size,0);});
integration('last identity sample cannot return earlier IDs after a getter changes process metadata',async()=>{const f=fixture();let samples=0;f.owner.getOSProcessId=()=>++samples>=4?9000:8123;const p=f.read();f.resolve();await rejects(p,'CONTEXT');assert.equal(samples,4);assert.equal(f.timers.size,0);});
integration('malformed navigation metadata disables observations without escaping ordinary events or ACK',async()=>{for(const details of [undefined,null,{},Object.defineProperty({},'isMainFrame',{get(){throw Error('own metadata');}})]){const f=fixture(),p=f.read();assert.doesNotThrow(()=>f.owner.emit('did-start-navigation',details));await rejects(p,'CONTEXT');await rejects(f.read('request_002'),'CONTEXT');await f.ack();assert.equal(f.state.flushes,1);assert.equal(f.timers.size,0);f.resolve();}});
integration('unknown throwing message getter is never read during normalization or asynchronous notify',async()=>{for(const late of [false,true]){const f=fixture();let touched=0;const error=Object.defineProperty(Error('private'), 'message',{get(){touched++;throw Error('do not format');}});let p;if(late){p=f.read();f.owner.getOSProcessId=()=>{throw error;};f.resolve();}else{f.owner.getOSProcessId=()=>{throw error;};p=f.read();}await rejects(p,'UNAVAILABLE');assert.equal(touched,0);assert.equal(f.timers.size,0);}});
