'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {safe} = require('./serialization.cjs');
function sample() {
  return {protocol:'vortex-agent/1',schema:'native-preflight/1',observedAtUTC:'2026-10-31T14:00:00.000Z',
    context:{gameId:'cyberpunk2077',profileId:'profile-a',gamePath:path.resolve('own-game'),stagingPath:path.resolve('own-stage'),
      downloadPath:path.resolve('own-downloads'),filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'1:4'}},
    appVersion:{available:true,value:'2.9.1'},deploymentTargets:[{typeId:'',path:path.resolve('own-game'),sameAsDefault:true},
      {typeId:'own_alias',path:path.resolve('own-game'),sameAsDefault:true}],
    updater:{available:true,state:'idle',sequence:7},status:'ok',snapshotAtomic:false,nativeEffects:false,
    shutdownPermit:false,sourceAdmissionVerified:false};
}
const api = (credential = 'own-private-credential', userInfo = {}) => ({getState:() => ({confidential:{apiKey:credential},persistent:{nexus:{userInfo}}})});

test('preflight exact operational fields and empty default target survive account-name collisions', () => {
  const value=sample();
  const account={name:'own',version:'2.9.1',profile:'profile-a',label:'native-preflight/1',id:'idle'};
  assert.deepEqual(safe(value,api(undefined,account),'read_native_preflight'),value);
  assert.equal(safe(value,api(),'read_native_preflight').deploymentTargets[0].typeId,'');
});

test('partial native version/updater observations preserve finite codes without adding raw status', () => {
  const value=sample();value.status='partial';value.appVersion={available:false,code:'NATIVE_PREFLIGHT_APP_VERSION_UNAVAILABLE'};
  value.updater={available:false,code:'NATIVE_PREFLIGHT_UPDATER_UNAVAILABLE'};
  assert.deepEqual(safe(value,api(),'read_native_preflight'),value);
  assert.throws(()=>safe({...sample(),updater:{available:true,state:'idle https://private.invalid',sequence:1}},api(),'read_native_preflight'),/OPERATIONAL_VALUE_NOT_CURATED/);
});

test('credential overlap rejects operational values instead of truncating them', () => {
  for(const credential of ['2.9.1','own_alias','profile-a','own-game','NATIVE_PREFLIGHT_UPDATER_UNAVAILABLE']){
    const value=sample();if(credential==='NATIVE_PREFLIGHT_UPDATER_UNAVAILABLE')value.updater={available:false,code:credential};
    assert.throws(()=>safe(value,api(credential),'read_native_preflight'),/OPERATIONAL_SECRET_OVERLAP/);
  }
});

test('preflight empty-ID exception does not weaken other fields or ordinary tools', () => {
  const bad=sample();bad.context.profileId='';
  assert.throws(()=>safe(bad,api(),'read_native_preflight'),/OPERATIONAL_VALUE_NOT_CURATED/);
  assert.throws(()=>safe([{id:'',version:''}],api(),'list_mods'),/OPERATIONAL_VALUE_NOT_CURATED/);
  for(const typeId of ['bad/type','alias\n','__proto__','constructor','x'.repeat(129)]){
    const value=sample();value.deploymentTargets[0].typeId=typeId;
    assert.throws(()=>safe(value,api(),'read_native_preflight'),/OPERATIONAL_VALUE_NOT_CURATED/);
  }
});
