import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import {applyExact,hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/',import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('download-transfer-cleanup-hold.json',base)));
const patch = fs.readFileSync(new URL('download-transfer-cleanup-hold.patch',base),'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const integration = (name,fn) => test(name,{timeout:10000,
  skip:process.env.VORTEX_NATIVE_DOWNLOAD_SETTINGS_SOURCE && process.env.VORTEX_BLUEBIRD_ROOT
    ? false : 'Provide exact original Downloads Settings and pinned Bluebird sources'},fn);
function ordinary(file) {
  for(let p=path.resolve(file);;p=path.dirname(p)) {
    assert(!fs.lstatSync(p).isSymbolicLink());if(p===path.dirname(p))break;
  }
}
function bluebird() {
  const root=process.env.VORTEX_BLUEBIRD_ROOT;ordinary(root);
  const pins=JSON.parse(fs.readFileSync(path.join(root,'SOURCE-PINS.json')));
  const rows=pins.files.map(({file,bytes,sha256})=>({file,bytes,sha256})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  assert.equal(rows.length,39);
  assert.equal(sha(JSON.stringify(rows)),'a1279d5bda68eae7063b8d282f9c4665f15039dbd20b66826d4eb9cb3f2ff1a8');
  for(const row of rows) {
    assert(/^(?:LICENSE|package\.json|js\/release\/[a-z0-9_]+\.js)$/.test(row.file));
    const file=path.join(root,row.file);ordinary(file);const bytes=fs.readFileSync(file);
    assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);
  }
  const BB=require(path.join(root,'js/release/bluebird.js')).getNewLibraryCopy();BB.config({warnings:false});return BB;
}
function fixture({baseline=false,outcome='collision',move}={}) {
  const original=fs.readFileSync(process.env.VORTEX_NATIVE_DOWNLOAD_SETTINGS_SOURCE,'utf8');
  assert.equal(sha(original),manifest.inputSHA256);
  const changed=applyExact(original,patch,manifest.upstreamPath);assert.equal(sha(changed),manifest.outputSHA256);
  const source=baseline?original:changed, start=source.indexOf('  private apply =');
  const end=source.indexOf('\n  };',start);assert(start>=0&&end>start);
  const code='class SettingsHarness {\n'+source.slice(start,end+6)+'\n}';
  const BB=bluebird(),calls=[],destination=new Map([['foreign','retained data']]);
  class UserCanceled extends Error {} class ProcessCanceled extends Error {}
  class CleanupFailedException extends Error {constructor(error){super('cleanup');this.errorObject=error;}}
  class InsufficientDiskSpace extends Error {} class UnsupportedOperatingSystem extends Error {} class NotFound extends Error {}
  const primary=outcome==='cancel'?new UserCanceled('own cancellation'):outcome==='cleanup'
    ?new CleanupFailedException(Error('own old cleanup')):Object.assign(Error('own collision'),{code:'EEXIST'});
  const state={persistent:{transactions:{transfer:{downloads:'F:/New'}}}};
  const api={store:{getState:()=>state},events:{emit:name=>calls.push(['event',name])},
    showErrorNotification:(...args)=>calls.push(['notification',...args])};
  const globals={PromiseBB:BB,path:path.win32,UserCanceled,ProcessCanceled,CleanupFailedException,
    InsufficientDiskSpace,UnsupportedOperatingSystem,NotFound,
    getDownloadPath:value=>value,getVortexPath:()=> 'F:/Vortex',isReservedDirectory:()=>false,isChildPath:()=>false,
    getSafe:(value,keys,fallback)=>keys.reduce((v,k)=>v?.[k],value)??fallback,
    testPathTransfer:()=>BB.resolve(),writeDownloadsTag:(_api,target)=>{calls.push(['tag',target]);return BB.resolve();},
    cleanFailedTransfer:target=>{calls.push(['unsafe-delete',target]);destination.clear();return BB.resolve();},
    withTrackedActivity:(_a,_b,_c,work)=>work(),
    fs:{statSync:()=>{throw Object.assign(Error('own new path'),{code:'ENOENT'});},
      ensureDirWritableAsync:target=>{calls.push(['ensure',target]);return BB.resolve();}},
  };
  const Harness=vm.runInNewContext(stripTypeScriptTypes(code,{mode:'transform'})+'\nSettingsHarness;',globals,{timeout:1000});
  const instance=new Harness();
  Object.assign(instance,{state:{downloadPath:'F:/New'},nextState:{},context:{api},
    props:{downloadPath:'F:/Old',t:value=>value,onSetTransfer:value=>{calls.push(['marker',value]);state.persistent.transactions.transfer.downloads=value;},
      onSetDownloadPath:value=>calls.push(['path',value]),onShowDialog:(...args)=>{calls.push(['dialog',...args]);return BB.resolve({});},
      onShowError:(...args)=>calls.push(['error',...args])},
    checkTargetEmpty:()=>BB.resolve(),transferPath:()=>{calls.push(['move']);return move?BB.resolve(move):outcome==='success'?BB.resolve():BB.reject(primary);}});
  return {instance,calls,destination,state,primary,run:()=>instance.apply(value=>value)};
}

test('Downloads cleanup patch pins exact original and grants no ownership or native permit',()=>{
  assert.equal(manifest.inputSHA256,'4a7d38409c276dc8f61f0a2a01e52de8bc47d7e9e1fadcc867812e2c417ee89d');
  assert.equal(sha(patch),manifest.patchSHA256);assert.equal(manifest.preparedOnly,true);
  for(const flag of ['installed','nativeAcceptanceVerified','globalIdleGuarantee','ownerReservationGuarantee','installationPermit'])assert.equal(manifest[flag],false);
  for(const h of hunks(patch,manifest.upstreamPath))for(const line of h.body)if(line.startsWith('+'))assert.doesNotMatch(line.slice(1),/[\t ]$/);
});

for(const outcome of ['collision','cancel'])integration(`${outcome}: original finally deletes foreign destination; patch retains data and pending marker`,async()=>{
  for(const baseline of [true,false]){
    const f=fixture({baseline,outcome});await f.run();
    assert.equal(f.destination.get('foreign'),baseline?undefined:'retained data');
    assert.equal(f.state.persistent.transactions.transfer.downloads,baseline?undefined:'F:/New');
    assert.equal(f.calls.filter(row=>row[0]==='unsafe-delete').length,baseline?1:0);
    assert.equal(f.calls.filter(row=>row[0]==='marker').length,baseline?1:0);
    assert.equal(f.instance.nextState.busy,undefined);assert(!f.calls.some(row=>row[0]==='path'));
  }
});

integration('ordinary successful transfer preserves path, marker, tag and completion event behavior',async()=>{
  for(const baseline of [true,false]){
    const f=fixture({baseline,outcome:'success'});await f.run();
    assert.equal(f.destination.get('foreign'),'retained data');
    assert.equal(f.state.persistent.transactions.transfer.downloads,undefined);
    assert.deepEqual(f.calls.filter(row=>['marker','path','tag','event'].includes(row[0])),
      [['tag','F:/New'],['marker',undefined],['path','F:/New'],['event','did-move-downloads']]);
    assert.equal(f.instance.nextState.busy,undefined);assert(!f.calls.some(row=>row[0]==='unsafe-delete'));
  }
});

integration('copy-complete source-cleanup failure keeps the original intentional success-path handling',async()=>{
  const f=fixture({outcome:'cleanup'});await f.run();
  assert.equal(f.destination.get('foreign'),'retained data');assert.equal(f.state.persistent.transactions.transfer.downloads,undefined);
  assert(f.calls.some(row=>row[0]==='path'));assert(f.calls.some(row=>row[1]==='did-move-downloads'));
  assert(!f.calls.some(row=>row[0]==='unsafe-delete'));assert.equal(f.instance.nextState.busy,undefined);
});

integration('pending returned transfer is awaited before busy resets; no destination deletion starts',async()=>{
  const pending=Promise.withResolvers(),f=fixture({move:pending.promise});let settled=false;
  const result=f.run().then(()=>{settled=true;});
  for(let i=0;i<100&&!f.calls.some(row=>row[0]==='move');i++)await new Promise(resolve=>setImmediate(resolve));
  assert(f.calls.some(row=>row[0]==='move'));assert(!settled);assert.equal(f.instance.nextState.busy,'Moving download folder');
  pending.reject(f.primary);await result;assert.equal(f.instance.nextState.busy,undefined);
  assert.equal(f.destination.get('foreign'),'retained data');assert.equal(f.state.persistent.transactions.transfer.downloads,'F:/New');
});
