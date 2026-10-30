import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { evaluateOwnInstall, CONTRACT, LIMITS } from './own-install-preflight.mjs';
import { inspectOwnZip } from './own-helper-binder.mjs';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
function zip() {
 const name=Buffer.from('r6/scripts/Own/Example.reds'),data=Buffer.from('own synthetic payload');
 const l=Buffer.alloc(30),c=Buffer.alloc(46),e=Buffer.alloc(22);
 l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc32(data),14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(name.length,26);
 c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);
 e.writeUInt32LE(0x06054b50);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(c.length+name.length,12);e.writeUInt32LE(l.length+name.length+data.length,16);
 return Buffer.concat([l,name,data,c,name,e]);
}
function fixture() {
 const archive=zip(),proof=inspectOwnZip(archive),payload=proof.payload;
 const snapshot={host:{version:CONTRACT.version,appAsarSHA256:CONTRACT.appAsarSHA256,sourcePins:{...CONTRACT.sourcePins}},
 context:{gameId:'cyberpunk2077',profileId:'profile',rootIds:{game:'1:1',staging:'1:2',downloads:'1:3'},automationInstall:false,automationEnable:false,collectionActive:false,dialogs:0,tools:0,installing:0,deploying:false,interlocks:0},declaredComplete:true,
 package:{fileName:'Own-LOCAL.zip',ownerId:'Own-LOCAL',bytes:proof.bytes,sha256:proof.sha256,md5:proof.md5,expectedUncompressedBytes:proof.expectedUncompressedBytes,payload},
 evidence:{source:{sha256:'a'.repeat(64),payload},build:{sha256:'b'.repeat(64),archiveSHA256:proof.sha256,archiveBytes:proof.bytes,expectedUncompressedBytes:proof.expectedUncompressedBytes,payload}},downloadId:'download',mods:[],
 downloads:[{id:'download',state:'finished',localPath:'Own-LOCAL.zip',gameIds:['cyberpunk2077'],bytes:proof.bytes,md5:proof.md5}],
 profiles:[{id:'profile',gameId:'cyberpunk2077',pendingRemove:false,modState:{}}],stagingNames:[],incomingRules:[],
 metadata:{contractId:CONTRACT.id,contractSHA256:CONTRACT.extractorContractSHA256,quickProjectionKind:'defined-native-provider-ids/1',quickIdProjection:{},lookupRows:[],lookupQuery:{gameId:'cyberpunk2077',fileMD5:proof.md5,fileSize:proof.bytes},choices:[],rules:[],previousProviderIds:[],variantIds:[]},options:{allowAutoEnable:false,profileId:'profile'}};
 return {archive,snapshot};
}
function mod(s,change={}) {
 const record={id:'existing',state:'installed',rulesSHA256:sha('[]'),...change};
 s.mods.push({gameId:'cyberpunk2077',mapId:record.id,record});
 s.incomingRules.push({gameId:'cyberpunk2077',ownerId:record.id,rulesSHA256:record.rulesSHA256,requiresCount:1,ignoredRequiresCount:1});
}
function reject(mutator,code) {const f=fixture();mutator(f.snapshot,f.archive);const r=evaluateOwnInstall(f.archive,f.snapshot);assert.equal(r.modelAccepted,false);if(code)assert.deepEqual(r.reasons,[code]);assert.equal(r.effectsAllowed,false);return r;}
test('byte-verified own archive plus declared complete model grants no native admission or effects',()=>{
 const f=fixture();mod(f.snapshot);const before=JSON.stringify(f.snapshot),r=evaluateOwnInstall(f.archive,f.snapshot);
 assert.equal(r.modelAccepted,true);assert.equal(r.archiveBytesVerified,true);assert.equal(r.payloadFiles,1);
 for(const k of ['nativeQuickProjectionVerified','sourceAdmissionVerified','inventoryCompletenessVerified','dependencyClosureVerified','contextFreshnessVerified','effectsSupported','installationSupported','removalSupported','effectsAllowed'])assert.equal(r[k],false);
 assert.equal(r.nativeAdmissionRequired,true);assert(!('permit' in r));assert(!('installReady' in r));assert.equal(JSON.stringify(f.snapshot),before);
});
test('all native quick IDs must be truly absent, including zero/null and undefined properties',()=>{
 for(const key of ['modId','fileId','revisionId'])for(const value of [0,1,'0',null])reject(s=>{s.metadata.quickIdProjection[key]=value;},'PREFLIGHT_NATIVE_ID_DEFINED');
 for(const key of ['modId','fileId','revisionId'])reject(s=>{s.metadata.quickIdProjection[key]=undefined;},'PREFLIGHT_JSON_REQUIRED');
 reject(s=>{s.metadata.quickIdProjection.logicalFileName='old-provider';},'PREFLIGHT_NATIVE_METADATA');
});
test('new filename does not bypass same-download, same-MD5 or native previous-provider branches',()=>{
 reject(s=>mod(s,{archiveId:s.downloadId}),'PREFLIGHT_ARCHIVE_ALREADY_REFERENCED');
 reject(s=>mod(s,{fileMD5:s.package.md5}),'PREFLIGHT_ARCHIVE_ALREADY_INSTALLED');
 reject(s=>{mod(s);s.metadata.quickIdProjection.fileId=32;},'PREFLIGHT_NATIVE_ID_DEFINED');
 for(const key of ['previousProviderIds','variantIds','choices','rules'])reject(s=>{s.metadata[key]=['remembered'];},'PREFLIGHT_NATIVE_BRANCH');
 reject(s=>{s.metadata.lookupRows=[{value:{fileId:32,newestFileId:32}}];},'PREFLIGHT_NATIVE_METADATA');
});
test('case owner/path/installing aliases and pending records are never free',()=>{
 for(const state of ['installed','installing','pending-remove','incomplete'])reject(s=>mod(s,{id:'own-local',state}),'PREFLIGHT_OWNER_COLLISION');
 reject(s=>mod(s,{installationPath:'OWN-LOCAL'}),'PREFLIGHT_OWNER_COLLISION');
 for(const name of ['OWN-local','own-LOCAL.installing'])reject(s=>{s.stagingNames=[name];},'PREFLIGHT_STAGE_COLLISION');
 reject(s=>{mod(s);s.mods[0].mapId='another';},'PREFLIGHT_MOD_IDENTITY');
 reject(s=>mod(s,{installationPath:'other/OWN-LOCAL'}),'PREFLIGHT_MOD_IDENTITY');
});
test('tracked download must be unique, finished, exact and not marked installed even false',()=>{
 for(const installed of [true,false])reject(s=>{s.downloads[0].installed=installed;},'PREFLIGHT_DOWNLOAD');
 reject(s=>{s.downloads[0].gameIds.push('another-game');},'PREFLIGHT_DOWNLOAD');
 reject(s=>{s.downloads.push({...s.downloads[0],id:'duplicate'});},'PREFLIGHT_AMBIGUOUS_DOWNLOAD');
 reject(s=>{s.downloads[0].state='started';},'PREFLIGHT_DOWNLOAD');
 reject(s=>{s.downloads[0].bytes++;},'PREFLIGHT_DOWNLOAD');
});
test('all profiles and ignored requires inventories are retained; unknown flags hold',()=>{
 const f=fixture();mod(f.snapshot);f.snapshot.profiles.push({id:'pending',gameId:'cyberpunk2077',pendingRemove:true,modState:{existing:{enabled:false}}});
 assert.equal(evaluateOwnInstall(f.archive,f.snapshot).modelAccepted,true);
 reject(s=>{s.profiles[0].modState.existing={enabled:null};},'PREFLIGHT_PROFILE_UNKNOWN_FLAG');
 reject(s=>{s.profiles[0].modState['OWN-local']={enabled:false};},'PREFLIGHT_PROFILE_OWNER_REFERENCE');
 reject(s=>{mod(s);s.incomingRules=[];},'PREFLIGHT_RULE_INVENTORY');
 reject(s=>{mod(s);s.incomingRules[0].ignoredRequiresCount=2;},'PREFLIGHT_FIELDS');
});
test('archive/source/build drift, unsupported host and incomplete context fail without effects',()=>{
 reject(s=>{s.package.sha256='0'.repeat(64);},'PREFLIGHT_ARCHIVE_PROOF');
 reject(s=>{s.evidence.build.archiveBytes++;},'PREFLIGHT_EVIDENCE_PROJECTION');
 reject(s=>{s.evidence.source.payload={};},'PREFLIGHT_EVIDENCE_PROJECTION');
 reject(s=>{s.host.sourcePins['575']='0'.repeat(64);},'PREFLIGHT_UNSUPPORTED_HOST');
 reject(s=>{s.declaredComplete=false;},'PREFLIGHT_INCOMPLETE_INVENTORY');
 for(const key of ['collectionActive','deploying','automationInstall','automationEnable'])reject(s=>{s.context[key]=true;},'PREFLIGHT_NATIVE_BUSY');
 reject(s=>{s.options.allowAutoEnable=true;},'PREFLIGHT_NATIVE_OPTIONS');
 reject(s=>{s.metadata.contractSHA256='0'.repeat(64);},'PREFLIGHT_NATIVE_METADATA');
});
test('sparse arrays, prototypes, accessors and unknown field/limit escapes fail before evaluation',()=>{
 reject(s=>{s.mods=Array(1);},'PREFLIGHT_JSON_REQUIRED');
 reject(s=>{Object.setPrototypeOf(s.context,{gameId:'cyberpunk2077'});},'PREFLIGHT_JSON_REQUIRED');
 reject(s=>{Object.defineProperty(s.context,'gameId',{get(){throw Error('must not run');},enumerable:true});},'PREFLIGHT_JSON_REQUIRED');
 reject(s=>{s.metadata.collectionRevision=2;},'PREFLIGHT_FIELDS');
 reject(s=>{s.downloads=Array.from({length:LIMITS.downloads+1},()=>s.downloads[0]);});
 reject(s=>{s.profiles[0].modState={x:{enabled:undefined}};},'PREFLIGHT_JSON_REQUIRED');
 const f=fixture(),bad=Buffer.from(f.archive);bad[35]^=1;assert.equal(evaluateOwnInstall(bad,f.snapshot).modelAccepted,false);
});

test('bounds fail closed before coercion or unbounded JSON materialization',()=>{
 reject(s=>{Object.setPrototypeOf(s.context,Array.prototype);},'PREFLIGHT_JSON_REQUIRED');
 reject(s=>{s.mods=Array.from({length:LIMITS.mods+1},()=>({gameId:'other'}));},'PREFLIGHT_LIMIT');
 reject(s=>{s.profiles=Array.from({length:LIMITS.profiles+1},()=>({id:'other'}));},'PREFLIGHT_LIMIT');
 reject(s=>{s.stagingNames=Array.from({length:LIMITS.stagingNames+1},(_,i)=>'name'+i);},'PREFLIGHT_LIMIT');
 reject(s=>{mod(s);s.incomingRules[0].requiresCount=LIMITS.rules+1;},'PREFLIGHT_FIELDS');
 reject(s=>{s.stagingNames=Array.from({length:9000},()=> '\u4e00'.repeat(1024));},'PREFLIGHT_LIMIT');
 reject(s=>{s.host.nativeAdmitted=true;},'PREFLIGHT_FIELDS');
});

test('reserved native owner spellings never qualify as a new own provider',()=>{
 for(const ownerId of ['__proto__','constructor','prototype','__folder_managed_by_vortex','fomod','vortex_override_instructions.json'])
  reject(s=>{s.package.ownerId=ownerId;s.package.fileName=ownerId+'.zip';s.downloads[0].localPath=s.package.fileName;},'PREFLIGHT_OWNER_DERIVATION');
});

test('raw installed association is preserved for unrelated downloads; full quick output is not ID projection',()=>{
 const f=fixture();f.snapshot.downloads.push({id:'old-download',state:'finished',localPath:'Other.zip',gameIds:['cyberpunk2077'],bytes:1,md5:'0'.repeat(32),installed:{gameId:'cyberpunk2077',modId:'old-mod'}});
 assert.equal(evaluateOwnInstall(f.archive,f.snapshot).modelAccepted,true);
 reject(s=>{s.downloads[0].installed={gameId:'cyberpunk2077',modId:'old-mod'};},'PREFLIGHT_DOWNLOAD');
 reject(s=>{s.metadata.quick={fileName:s.package.fileName};},'PREFLIGHT_FIELDS');
 reject(s=>{s.metadata.quickProjectionKind='full-native-quick';},'PREFLIGHT_NATIVE_METADATA');
});
