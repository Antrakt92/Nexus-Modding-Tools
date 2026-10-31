import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

// Exact source execution with real computeStateDiff; only timers and transport
// are facades. No Electron, persistence DB, native installation or filesystem writes.
const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('renderer-acknowledged-flush.json', folder)));
const patch = readFileSync(new URL('renderer-acknowledged-flush.patch', folder), 'utf8');
const holdManifest=JSON.parse(readFileSync(new URL('renderer-acknowledged-hold.json',folder)));
const holdPatch=readFileSync(new URL('renderer-acknowledged-hold.patch',folder),'utf8');
const source = process.env.VORTEX_NATIVE_PERSIST_DIFF_SOURCE;
const diffSource = process.env.VORTEX_NATIVE_STATE_DIFF_SOURCE;
const sha = data => createHash('sha256').update(data).digest('hex');
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: source && diffSource ? false : 'Provide VORTEX_NATIVE_PERSIST_DIFF_SOURCE and VORTEX_NATIVE_STATE_DIFF_SOURCE'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject};
}
function javascript(source) {
  return stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), {mode: 'transform'});
}
function fixture({getApi, send, baseline = false, storeWrap, onState} = {}) {
  const raw = readFileSync(source, 'utf8');
  assert.equal(sha(raw), manifest.inputSHA256);
  const acknowledgedSource = applyExact(raw, patch, manifest.upstreamPath);
  assert.equal(sha(acknowledgedSource), manifest.outputSHA256);
  const patched=applyExact(acknowledgedSource,holdPatch,manifest.upstreamPath);assert.equal(sha(patched),holdManifest.outputSHA256);
  const diff = readFileSync(diffSource, 'utf8');
  assert.equal(sha(diff), '3f7a243baa908f0fc1143d50df4ba1352dde33d445f19c24675bbdf4df6dd7e9');
  const computeStateDiff = new Function(javascript(diff) + '\nreturn computeStateDiff;')();
  const timers = new Map(), callbacks = [], acknowledged = [], legacy = [], sync = [], logs = [];
  let nextTimer = 1;
  const api = {
    sendDiff: (hive, operations) => legacy.push({hive, operations}),
    sendDiffSync: (hive, operations) => sync.push({hive, operations}),
    sendDiffAcknowledged: batches => {acknowledged.push(structuredClone(batches)); return send?.(batches) ?? Promise.resolve();},
  };
  const module = new Function('computeStateDiff', 'getErrorMessageOrDefault', 'log', 'setTimeout', 'clearTimeout',
    javascript(baseline ? acknowledgedSource : patched) + '\nreturn {createPersistDiffMiddleware, addPersistedHives, flushPendingDiffsSync'
    + ', flushPendingDiffsAcknowledged' + (baseline?'':',acquireNativePersistenceFlushHold,checkNativePersistenceFlushHold,releaseNativePersistenceFlushHold') + '};')(
    computeStateDiff, () => 'own fixture error', (...args) => logs.push(args),
    callback => {const id = nextTimer++; timers.set(id, callback); callbacks.push(callback); return id;},
    id => timers.delete(id));
  let state = {persistent: {}, settings: {}};
  const middleware = module.createPersistDiffMiddleware(() => getApi ? getApi(api) : api);
  const storeApi=storeWrap?storeWrap({getState:()=>{onState?.();return state;}}):{getState:()=>{onState?.();return state;}};
  const dispatch = middleware(storeApi)(action => {
    if (Object.hasOwn(action, 'state')) state = action.state;
    return action;
  });
  dispatch({type: 'INITIALIZE'});
  const update = (hive, value) => dispatch({type: 'OWN_CHANGE', state: {...state, [hive]: value}});
  const fire = () => {for (const [id, callback] of [...timers]) {timers.delete(id); callback();}};
  return {module, api, update, dispatch, timers, callbacks, acknowledged, legacy, sync, logs, fire,
    flush: () => module.flushPendingDiffsAcknowledged(), acquire:()=>module.acquireNativePersistenceFlushHold(),check:o=>module.checkNativePersistenceFlushHold(o),release:o=>module.releaseNativePersistenceFlushHold(o),storeApi,state: () => state};
}


test('hold artifact pins exact acknowledged predecessor and has no native authority',()=>{assert.equal(sha(holdPatch),holdManifest.patchSHA256);assert.equal(holdManifest.inputSHA256,manifest.outputSHA256);assert.equal(holdManifest.prerequisitePatchSHA256,manifest.patchSHA256);for(const k of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified'])assert.equal(holdManifest[k],false);});
integration('RED predecessor ACK success immediately resumes fresh fire-and-forget sends',async()=>{const gate=deferred(),f=fixture({baseline:true,send:()=>gate.promise});f.update('persistent',{before:1});const ack=f.flush();f.update('persistent',{after:2});gate.resolve();await ack;assert.equal(f.timers.size,1);f.fire();assert.equal(f.legacy.length,1);assert.equal(f.legacy[0].operations.find(o=>o.path[0]==='after').value,2);});
integration('hold preserves ordinary state updates during and after ACK and releases only fresh buffered writes',async()=>{const gate=deferred(),f=fixture({send:()=>gate.promise});f.update('persistent',{own:1});const acquire=f.acquire();f.update('persistent',{own:2});f.update('settings',{later:true});assert.equal(f.state().persistent.own,2);gate.resolve();const owner=await acquire;assert.ok(Object.isFrozen(owner));f.check(owner);f.update('persistent',{own:3});f.fire();assert.equal(f.legacy.length,0);assert.equal(f.timers.size,0);await assert.rejects(f.flush(),/HOLD_ACTIVE/);f.check(owner);f.release(owner);assert.throws(()=>f.check(owner));assert.equal(f.timers.size,1);f.fire();assert.equal(f.legacy.length,2);assert.deepEqual(f.legacy[0].operations,[{type:'set',path:['own'],value:3}]);assert.deepEqual(f.legacy[1].operations,[{type:'set',path:['later'],value:true}]);assert.equal(f.acknowledged.length,1);});
integration('empty hold still awaits real barrier; release permits another independently owned hold',async()=>{const f=fixture(),owner=await f.acquire();assert.deepEqual(f.acknowledged,[[]]);f.release(owner);const next=await f.acquire();assert.notEqual(next,owner);assert.throws(()=>f.check(owner));f.check(next);f.release(next);});
integration('acquire refuses older ACK flight rather than missing already fresh pending writes',async()=>{const gate=deferred(),f=fixture({send:()=>gate.promise});f.update('persistent',{own:1});const ack=f.flush();f.update('persistent',{own:2});await assert.rejects(f.acquire(),/UNAVAILABLE/);gate.resolve();await ack;const owner=await f.acquire();assert.equal(f.acknowledged.length,2);assert.equal(f.acknowledged[1][0].operations[0].value,2);f.release(owner);});
integration('lookup/send failures retain primary and never allow fallback or release',async()=>{for(const mode of ['lookup','send']){const primary=Error(mode);let armed=false;const f=fixture({getApi:api=>{if(armed&&mode==='lookup')throw primary;return api;},send:()=>{if(mode==='send')throw primary;}});f.update('persistent',{own:1});armed=true;await assert.rejects(f.acquire(),e=>e===primary);f.fire();assert.equal(f.legacy.length,0);assert.equal(f.sync.length,0);await assert.rejects(f.acquire());assert.throws(()=>f.release({}));}});
integration('reentrant acquire from API lookup is visible before callback and cannot be swallowed',async()=>{let f,armed=false,nested;f=fixture({getApi:api=>{if(armed){armed=false;nested=f.acquire();}return api;}});f.update('persistent',{own:1});armed=true;const first=f.acquire();await assert.rejects(first,/REENTRY/);await assert.rejects(nested,/REENTRY/);assert.equal(f.acknowledged.length,0);f.fire();assert.equal(f.legacy.length,0);});
integration('ordinary nested dispatch during held getApi cannot rewind pending previous-state baseline',async()=>{let f,armed=false;f=fixture({getApi:api=>{if(armed){armed=false;f.update('persistent',{nested:2});}return api;}});const o=await f.acquire();armed=true;assert.doesNotThrow(()=>f.update('persistent',{outer:1}));assert.equal(f.state().persistent.nested,2);assert.throws(()=>f.check(o));assert.throws(()=>f.release(o));f.fire();assert.equal(f.legacy.length,0);});
integration('held serialization reentry or oversized replacement remains held without sending',async()=>{let f,armed=false;const p=new Proxy({v:1},{ownKeys(t){if(armed){armed=false;f.update('settings',{nested:true});}return Reflect.ownKeys(t);}});f=fixture();const o=await f.acquire();armed=true;f.update('persistent',{own:[p]});assert.throws(()=>f.check(o));f.fire();assert.equal(f.legacy.length,0);const g=fixture(),owner=await g.acquire();g.update('persistent',{own:'small'});g.update('persistent',{own:'x'.repeat(32*1024*1024+1)});assert.throws(()=>g.check(owner));assert.throws(()=>g.release(owner));assert.equal(g.state().persistent.own.length,32*1024*1024+1);g.fire();assert.equal(g.legacy.length,0);});
integration('fresh payload snapshots detach caller aliases and replacement accounting subtracts old bytes',async()=>{const f=fixture(),owner=await f.acquire(),value={text:'kept'};f.update('persistent',{own:[value]});value.text='mutated behind Redux';f.check(owner);f.release(owner);f.fire();assert.equal(f.legacy[0].operations[0].value[0].text,'kept');const g=fixture(),o=await g.acquire();for(let n=0;n<24;n++)g.update('persistent',{own:'x'.repeat(1024*1024)+n});g.check(o);g.release(o);g.fire();assert.ok(g.legacy[0].operations[0].value.endsWith('23'));});
integration('quit/hydration/push invalidation retains writes and cannot be released or replayed',async()=>{for(const kind of ['quit','__hydrate','__hydrate_replace','__persist_push']){const f=fixture(),o=await f.acquire();f.update('persistent',{own:1});if(kind==='quit')f.module.flushPendingDiffsSync();else f.dispatch({type:kind,state:{persistent:{replacement:true},settings:{}}});assert.throws(()=>f.check(o));assert.throws(()=>f.release(o));f.fire();assert.equal(f.legacy.length,0);assert.equal(f.sync.length,0);assert.equal(f.acknowledged.length,1);}});
integration('factory replacement during issued hold blocks both old and new writers',async()=>{const f=fixture(),o=await f.acquire();let state={persistent:{},settings:{}};const second=f.module.createPersistDiffMiddleware(()=>f.api)({getState:()=>state})(a=>{if(a.state)state=a.state;return a;});second({type:'INIT'});second({type:'CHANGE',state:{persistent:{other:1},settings:{}}});assert.throws(()=>f.check(o));assert.throws(()=>f.release(o));f.fire();assert.equal(f.legacy.length,0);await assert.rejects(f.acquire());});
integration('two attached writers before hold refuse admission while preserving ordinary flushing',async()=>{const f=fixture();f.update('persistent',{oldWriter:1});let state={persistent:{},settings:{}};const second=f.module.createPersistDiffMiddleware(()=>f.api)({getState:()=>state})(a=>{if(a.state)state=a.state;return a;});second({type:'INIT'});await assert.rejects(f.acquire(),/UNAVAILABLE/);f.fire();assert.equal(f.legacy.length,1);});
integration('descriptor callbacks cannot nested-acquire or swallow owner-check reentry',async()=>{let f,armed=false,nested,owner,mode='acquire';const wrap=target=>new Proxy(target,{getOwnPropertyDescriptor(t,k){if(k==='getState'&&armed){armed=false;if(mode==='acquire')nested=f.acquire();else{try{f.check(owner);}catch{}}}return Reflect.getOwnPropertyDescriptor(t,k);}});f=fixture({storeWrap:wrap});armed=true;await assert.rejects(f.acquire());await assert.rejects(nested);assert.equal(f.acknowledged.length,0);const g=fixture({storeWrap:wrap});f=g;mode='check';owner=await g.acquire();armed=true;assert.throws(()=>g.check(owner));assert.throws(()=>g.release(owner));});

integration('late captured legacy timer cannot send after healthy ACK while native hold remains',async()=>{const f=fixture();f.update('persistent',{before:1});const old=f.callbacks[0];const o=await f.acquire();f.update('persistent',{after:2});old();f.module.flushPendingDiffsSync();assert.throws(()=>f.check(o));assert.equal(f.legacy.length,0);assert.equal(f.sync.length,0);assert.equal(f.acknowledged.length,1);});
integration('nested getState dispatch invalidates before stale outer state can rebase pending diffs',async()=>{let f,armed=false;f=fixture({onState(){if(armed){armed=false;f.update('persistent',{nested:2});}}});const o=await f.acquire();armed=true;f.update('persistent',{outer:1});assert.equal(f.state().persistent.nested,2);assert.throws(()=>f.check(o));assert.throws(()=>f.release(o));f.fire();assert.equal(f.legacy.length,0);});
integration('aggregate coalesced key and hive limits hold before unbounded buffered growth',async()=>{const f=fixture(),o=await f.acquire();f.update('persistent',Object.fromEntries(Array.from({length:32769},(_,n)=>['key'+n,n])));assert.throws(()=>f.check(o));f.fire();assert.equal(f.legacy.length,0);const g=fixture();g.module.addPersistedHives(Array.from({length:33},(_,n)=>'ownHive'+n));const owner=await g.acquire();for(let n=0;n<33;n++)g.update('ownHive'+n,{v:n});assert.throws(()=>g.check(owner));g.fire();assert.equal(g.legacy.length,0);});
integration('aggregate payload budget counts distinct retained values and keeps overflow state for reconciliation',async()=>{const f=fixture(),o=await f.acquire(),values={};for(let n=0;n<17;n++){values['value'+n]='x'.repeat(2*1024*1024);f.update('persistent',{...values});}assert.throws(()=>f.check(o));assert.throws(()=>f.release(o));assert.equal(f.state().persistent.value16.length,2*1024*1024);f.fire();assert.equal(f.legacy.length,0);});
integration('wrong opaque owner refuses without damaging healthy owner; release requires caller-restored main writes',async()=>{const f=fixture(),o=await f.acquire();assert.throws(()=>f.check({}));assert.throws(()=>f.release({}));f.check(o);let mainAvailable=false;const send=f.api.sendDiff;f.api.sendDiff=(...args)=>{assert.equal(mainAvailable,true);send(...args);};f.update('settings',{held:true});mainAvailable=true;f.release(o);f.fire();assert.equal(f.legacy.length,1);assert.throws(()=>f.release(o));});

integration('release then immediate reacquire drains fresh pending exactly once and rejects captured old timer',async()=>{const f=fixture(),first=await f.acquire();f.update('persistent',{own:1});f.release(first);const captured=f.callbacks.at(-1);const second=await f.acquire();assert.notEqual(first,second);assert.deepEqual(f.acknowledged,[[],[{hive:'persistent',operations:[{type:'set',path:['own'],value:1}]}]]);f.update('persistent',{own:2});captured();f.fire();assert.equal(f.legacy.length,0);f.check(second);f.release(second);f.fire();assert.deepEqual(f.legacy,[{hive:'persistent',operations:[{type:'set',path:['own'],value:2}]}]);});
