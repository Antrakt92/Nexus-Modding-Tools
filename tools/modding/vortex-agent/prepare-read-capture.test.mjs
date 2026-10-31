import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareReadCapture, verifyReadCapture, main, SUPPORTED_READ_CAPTURE} from './prepare-read-capture.mjs';

const reference = process.env.VORTEX_OWN_READ_CAPTURE_REFERENCE;
const timestampPolicy = process.env.VORTEX_READ_CAPTURE_TIMESTAMP_POLICY;
const scratch = fileURLToPath(new URL('../../../local-state/', import.meta.url));
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: reference && timestampPolicy ? false : 'Provide the pinned Menu code reference and timestamp policy via VORTEX_OWN_READ_CAPTURE_REFERENCE / VORTEX_READ_CAPTURE_TIMESTAMP_POLICY'}, fn);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function generatedCapture(model, {legacy = false} = {}) {
  let code;
  if (legacy) {
    const original = fs.readFileSync(path.join(reference, 'capture.cjs'), 'utf8');
    const start = original.indexOf('function physicalReader(){'), end = original.indexOf('\nfunction under(', start);
    assert(start >= 0 && end > start);
    code = "const fs=require('original-fs'),crypto=require('crypto');const need=(v,c)=>{if(!v)throw Error(c);};\n"
      + original.slice(start,end);
  }
  else {
    const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
    code = fs.readFileSync(path.join(f.output, 'capture.cjs'), 'utf8');
  }
  const module = {exports: {}};
  vm.runInNewContext(code + '\nmodule.exports.testReader=physicalReader;', {
    module, Buffer, process: {pid: 1}, setTimeout, clearTimeout,
    require(name) {
      if (name === 'original-fs') return model.fs;
      if (name === 'path') return path.win32;
      if (name === 'crypto') return crypto;
      if (name === './extractor-admission.cjs') return {admission: () => ({status: 'source-admitted', allLoadedDynamicPathsKnown: true})};
      if (name === './scope.cjs') return {validate: packages => assert.equal(packages.length, 0)};
      if (name === 'own-guard') return {stopped() {}};
      if (name.includes('tool-timestamps.cjs')) return {comparable: () => 'own-settings-digest'};
      if (name === './native-selectors.cjs' || name === './nexus-identity.cjs') return {};
      assert.fail('Unexpected capture dependency: ' + name);
    },
  }, {timeout: 1000});
  return module.exports;
}
function captureModel() {
  const key = p => path.win32.resolve(p).toLowerCase();
  const nodes = new Map(), directories = new Map(), texts = new Map(), descriptors = new Map(), diagnostics = new Map();
  let nextFD = 1, opens = 0, stageReads = 0, dirOpens = 0, dirCloses = 0;
  const node = (ino, file = false) => ({dev: 1n, ino: BigInt(ino), size: 0n, mtimeNs: 1n,
    ctimeNs: 1n, nlink: 1n, reparse: false, isSymbolicLink() {return this.reparse;},
    isFile() {return file;}, isDirectory() {return !file;}});
  function stat(p) {return {...(nodes.get(key(p)) ?? node(1))};}
  for (const [p, id] of [['F:/game',10],['F:/stage',20],['F:/downloads',30],['F:/temp',40]]) nodes.set(key(p),node(id));
  const roots = ['F:/game/bin/x64/plugins/cyber_engine_tweaks/mods','F:/game/red4ext/plugins'].map(p => path.win32.resolve(p));
  for (const root of roots) directories.set(key(root), []);
  const preferenceDiscovery = {schema:'read-capture-preference-discovery/1',roots,
    extensions:['.db','.ini','.json','.sqlite3'],files:[],excludedLogLinks:[]};
  const baseline = {manifestSHA256: hash('own manifest'),records:[],settings:[],preferenceDiscovery};
  const admission = JSON.stringify({newChangedSourceReviewComplete:true});
  texts.set(key('F:/baseline.json'), () => JSON.stringify(baseline));
  texts.set(key('F:/manifest.json'), () => 'own manifest');
  texts.set(key('F:/admission.json'), () => admission);
  const state = {app:{appVersion:'2.9.1'},settings:{gameMode:{discovered:{cyberpunk2077:{path:'F:/game'}}},
    automation:{install:false,enable:false}},session:{},persistent:{mods:{cyberpunk2077:{}},
    profiles:{ptndev1016:{gameId:'cyberpunk2077',modState:{}}},downloads:{files:{}}}};
  const cfg = {control:'F:/control',expectedDeploymentTargets:{'':'F:/game'},health:{gameId:'cyberpunk2077',profileId:'ptndev1016',gamePath:'F:/game',stagingPath:'F:/stage',downloadPath:'F:/downloads',
    filesystemIds:{gamePath:'1:10',stagingPath:'1:20',downloadPath:'1:30'}},packages:[],sourcePins:{},guard:'own-guard',
    expectedHostVersion:'2.9.1',nativeTempPath:'F:/temp',expectedNativeTempId:'1:40',manifestPath:'F:/manifest.json',
    diskBaseline:{path:'F:/baseline.json',sha256:hash(JSON.stringify(baseline))},
    admissionFile:'F:/admission.json',admissionSHA256:hash(admission)};
  const selectors = {activeGameId: () => 'cyberpunk2077',activeProfileId: () => 'ptndev1016',
    installPathForGame: () => 'F:/stage',downloadPathForGame: () => 'F:/downloads'};
  const util = {getGame: () => ({getModPaths: () => model.targets}),getVortexPath: () => 'F:/temp'};
  const model = {nodes,directories,texts,diagnostics,roots,baseline,state,cfg,selectors,util,targets:{'':'F:/game'},
    get opens() {return opens;},get dirOpens() {return dirOpens;},get dirCloses() {return dirCloses;},
    afterStageInventory:undefined,beforeRead:undefined,descriptorSwap:false,
    file(p, content) {const value=node(70,true);value.data=Buffer.from(content);value.size=BigInt(value.data.length);nodes.set(key(p),value);return value;},
    fs:{lstatSync:stat,statSync:stat,
      writeFileSync(p,bytes,options) {assert.equal(key(p),key('F:/control/TARGET-MAP-DIAGNOSTIC.json'));assert.equal(options.flag,'wx');assert(!diagnostics.has(key(p)),'diagnostic cannot overwrite/replay');assert(Buffer.byteLength(bytes)<32768);diagnostics.set(key(p),JSON.parse(bytes));},
      opendirSync(p) {const entries=model.fs.readdirSync(p,{withFileTypes:true});let next=0,closed=false;dirOpens++;return {
        readSync() {assert(!closed);return entries[next++]??null;},closeSync() {assert(!closed);closed=true;dirCloses++;},
      };},
      readFileSync(p) {const value=texts.get(key(p))?.();assert.notEqual(value,undefined,'Only own fixture metadata may be read');return value;},
      readdirSync(p, options) {
        if (key(p)===key('F:/stage') && ++stageReads===2) model.afterStageInventory?.();
        const names=directories.get(key(p)) ?? [];
        return options?.withFileTypes ? names.map(name=>({name,isSymbolicLink:()=>stat(path.win32.join(p,name)).isSymbolicLink(),
          isDirectory:()=>stat(path.win32.join(p,name)).isDirectory(),isFile:()=>stat(path.win32.join(p,name)).isFile()})) : names;
      },
      openSync(p) {opens++;const fd=nextFD++;descriptors.set(fd,{node:nodes.get(key(p)),position:0});return fd;},
      fstatSync(fd) {const value={...descriptors.get(fd).node};if(model.descriptorSwap)value.ino=999n;return value;},
      readSync(fd, buffer, offset, length) {
        const value=descriptors.get(fd);model.beforeRead?.(value.node,length);
        const count=Math.min(length,value.node.data.length-value.position);
        value.node.data.copy(buffer,offset,value.position,value.position+count);value.position+=count;return count;
      },closeSync(fd) {assert(descriptors.delete(fd));},
    },run(C) {return C.capture({getState:()=>state},selectors,util,cfg);},
  };
  return model;
}

integration('actual generated reader rejects an opened foreign FD that the historical path-only reader accepted', () => {
  for (const legacy of [true,false]) {
    const model=captureModel();model.file('F:/own.bin','own bytes');model.descriptorSwap=true;
    const C=generatedCapture(model,{legacy}),read=C.testReader();
    if (legacy) assert.equal(read('F:/own.bin').sha256,hash('own bytes'));
    else assert.throws(()=>read('F:/own.bin'),/FILE_DESCRIPTOR_CHANGED/);
  }
});

integration('generated reader checks FD link count during reads and includes links in its cache key', () => {
  const racing=captureModel(),file=racing.file('F:/own.bin','own bytes');
  racing.beforeRead=()=>{file.nlink=2n;};
  assert.throws(()=>generatedCapture(racing).testReader()('F:/own.bin'),/FILE_CHANGED_DURING_CAPTURE/);
  const model=captureModel(),node=model.file('F:/own.bin','own bytes'),read=generatedCapture(model).testReader();
  assert.equal(read('F:/own.bin').links,1);read('F:/own.bin');assert.equal(model.opens,1);
  node.nlink=2n;assert.equal(read('F:/own.bin').links,2);assert.equal(model.opens,2);
});

integration('generated reader reads at most initial bytes plus one and refuses ancestor reparse paths', () => {
  const model=captureModel(),file=model.file('F:/own.bin','abc');file.data=Buffer.from('abcdefgh');
  const lengths=[];model.beforeRead=(_node,length)=>lengths.push(length);
  assert.throws(()=>generatedCapture(model).testReader()('F:/own.bin'),/FILE_GREW_DURING_CAPTURE/);
  assert.deepEqual(lengths,[4]);
  const unsafe=captureModel();unsafe.file('F:/own.bin','abc');
  unsafe.nodes.set(path.win32.resolve('F:/').toLowerCase(),{dev:1n,ino:1n,isSymbolicLink:()=>true});
  assert.throws(()=>generatedCapture(unsafe).testReader()('F:/own.bin'),/CAPTURE_REPARSE/);
});

integration('actual zero-package capture accepts only the supported native default deployment target', async () => {
  const good=captureModel();const result=await good.run(generatedCapture(good));
  assert.equal(result.readOnly,true);assert.equal(result.rows.length,0);
  for (const targets of [{'':'F:/game',custom:'F:/Other'},{'':'F:/Different'},{custom:'F:/game'}]) {
    const model=captureModel();model.targets=targets;
    await assert.rejects(model.run(generatedCapture(model)),/DEPLOYMENT_TARGET/);
  }
  const missing=captureModel();missing.util.getGame=undefined;
  await assert.rejects(missing.run(generatedCapture(missing)),/ACTUAL_GAME_TARGET_SELECTOR_REQUIRED/);
  for (const expected of [null,undefined,'1:999']) {
    const wrong=captureModel();wrong.cfg.expectedNativeTempId=expected;
    await assert.rejects(wrong.run(generatedCapture(wrong)),/NATIVE_TEMP_PATH_CHANGED/);
  }
});

integration('final capture checkpoint refuses root, native-temp and deployment-map drift after stage readback', async () => {
  for (const kind of ['game','stage','downloads','temp','targets']) {
    const model=captureModel();model.afterStageInventory=()=>{
      if(kind==='targets')model.targets={'':'F:/game',extra:'F:/Other'};
      else model.nodes.get(path.win32.resolve('F:/'+kind).toLowerCase()).ino+=1n;
    };
    await assert.rejects(model.run(generatedCapture(model)),/ROOT|TEMP|DEPLOYMENT_TARGET/);
  }
});

integration('fresh baseline preference discovery is required and final file-set drift cannot become a capture', async () => {
  for (const kind of ['missing','wrong-roots','added-final','removed-final','reparse-final','depth']) {
    const model=captureModel();
    if(kind==='missing')delete model.baseline.preferenceDiscovery;
    if(kind==='wrong-roots')model.baseline.preferenceDiscovery.roots=['F:/Unrelated',model.roots[1]];
    // Keep the independently bound baseline hash coherent: the regression is the
    // generated runtime's contract, not rejection caused by changed baseline bytes.
    if(kind==='removed-final'){
      const root=model.roots[0],p=path.win32.join(root,'old.json');model.file(p,'{}');
      model.directories.set(path.win32.resolve(root).toLowerCase(),['old.json']);
      model.baseline.preferenceDiscovery.files=[path.win32.resolve(p).replaceAll('\\','/').toLowerCase()];
      model.baseline.settings=[{path:p,nodeId:'1:70',bytes:2,links:1,sha256:hash('{}')}];
    }
    if(kind==='depth'){
      let dir=model.roots[0];for(let depth=0;depth<34;depth++){
        model.directories.set(path.win32.resolve(dir).toLowerCase(),['nested']);dir=path.win32.join(dir,'nested');
      }
    }
    model.cfg.diskBaseline.sha256=hash(JSON.stringify(model.baseline));
    if(kind.endsWith('final'))model.afterStageInventory=()=>{
      const root=model.roots[0],p=path.win32.join(root,'new.json');
      const file=model.file(p,'{}');if(kind==='reparse-final')file.reparse=true;
      model.directories.set(path.win32.resolve(root).toLowerCase(),kind==='removed-final'?[]:['new.json']);
    };
    await assert.rejects(model.run(generatedCapture(model)),/PREFERENCE_/);
    assert.equal(model.dirOpens,model.dirCloses,'preference refusal must close every directory iterator');
  }
});
integration('every discovered preference requires a unique valid independently hashed settings row', async () => {
  for (const kind of ['valid','missing','duplicate','digest','identity','bytes','links','path']) {
    const model=captureModel(),root=model.roots[0],p=path.win32.join(root,'own.json');
    const file=model.file(p,'{}');
    model.directories.set(path.win32.resolve(root).toLowerCase(),['own.json']);
    model.baseline.preferenceDiscovery.files=[path.win32.resolve(p).replaceAll('\\','/').toLowerCase()];
    const row={path:p,nodeId:'1:70',bytes:Number(file.size),links:1,sha256:hash('{}')};
    model.baseline.settings=kind==='missing'?[]:[row];
    if(kind==='duplicate')model.baseline.settings.push({...row,path:p.toUpperCase()});
    if(kind==='digest')row.sha256='not-a-hash';
    if(kind==='identity')row.nodeId='unknown';
    if(kind==='bytes')row.bytes=-1;
    if(kind==='links')row.links=0;
    if(kind==='path')row.path='relative.json';
    model.cfg.diskBaseline.sha256=hash(JSON.stringify(model.baseline));
    if(kind==='valid')assert.equal((await model.run(generatedCapture(model))).readOnly,true);
    else await assert.rejects(model.run(generatedCapture(model)),/PREFERENCE_SETTINGS_(?:INVALID|DUPLICATE|MISSING)/);
  }
});

integration('only exact independently pinned log symlinks may be excluded without following their target', async () => {
  const own=fs.mkdtempSync(path.join(scratch,'read-capture-log-link-'));
  const link=path.join(own,'own.log');fs.symlinkSync(path.join(own,'absent-target.log'),link,'file');
  const actual=fs.lstatSync(link,{bigint:true}),text=fs.readlinkSync(link,{encoding:'buffer'});
  for(const kind of ['valid','unpinned','unknown','json','missing','duplicate','target','identity','bytes','links','mtime','ctime','directory','attributes','final-drift']){
    const model=captureModel(),folder=path.win32.join(model.roots[1],'ArchiveXL');
    const p=path.win32.join(folder,kind==='unknown'?'Other.log':kind==='json'?'ArchiveXL.json':'ArchiveXL.log');
    const key=p=>path.win32.resolve(p).toLowerCase();
    model.directories.set(key(model.roots[1]),['ArchiveXL']);
    model.directories.set(key(folder),kind==='missing'?[]:[path.win32.basename(p)]);
    const original=model.fs.lstatSync;let final=false,linkReads=0;
    model.fs.lstatSync=p2=>key(p2)===key(p)?Object.assign(Object.create(Object.getPrototypeOf(actual)),actual,
      final?{ino:actual.ino+1n}:{}):original(p2);
    model.fs.statSync=()=>assert.fail('excluded link target must not be statted');
    model.fs.readlinkSync=(p2,options)=>{assert.equal(key(p2),key(p));assert.equal(options.encoding,'buffer');linkReads++;return text;};
    const pin={path:p,nodeId:`${actual.dev}:${actual.ino}`,bytes:String(actual.size),links:String(actual.nlink),
      mtimeNs:String(actual.mtimeNs),ctimeNs:String(actual.ctimeNs),linkTextSHA256:hash(text),fileAttributes:0x400};
    model.baseline.preferenceDiscovery.excludedLogLinks=kind==='unpinned'?[]:[pin];
    if(kind==='duplicate')model.baseline.preferenceDiscovery.excludedLogLinks.push({...pin});
    if(kind==='target')pin.linkTextSHA256=hash('changed');
    if(kind==='identity')pin.nodeId='1:999';
    if(kind==='bytes')pin.bytes=String(actual.size+1n);
    if(kind==='links')pin.links='2';
    if(kind==='mtime')pin.mtimeNs=String(actual.mtimeNs+1n);
    if(kind==='ctime')pin.ctimeNs=String(actual.ctimeNs+1n);
    if(kind==='directory')pin.fileAttributes=0x410;
    if(kind==='attributes')pin.fileAttributes=0;
    if(kind==='final-drift')model.afterStageInventory=()=>{final=true;};
    model.cfg.diskBaseline.sha256=hash(JSON.stringify(model.baseline));
    if(kind==='valid'){assert.equal((await model.run(generatedCapture(model))).readOnly,true);assert(linkReads>=4);}
    else await assert.rejects(model.run(generatedCapture(model)),/PREFERENCE_(?:REPARSE|LOG_LINK)/,kind);
    assert.equal(model.dirOpens,model.dirCloses,kind);
  }
});

integration('reviewed exact root aliases are admitted while map failures write bounded immutable diagnostics', async () => {
  const good=captureModel();good.targets={'':'F:/game',dinput:'f:\\game',enb:'F:/game/.'};
  good.cfg.expectedDeploymentTargets={enb:'F:/game',dinput:'F:/game','':'F:/game'};
  const result=await good.run(generatedCapture(good));assert.equal(good.diagnostics.size,0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.reviewedDeploymentTargets)),{'':'f:/game',dinput:'f:/game',enb:'f:/game'});
  for(const kind of ['missing-review','missing-id','extra-id','other-root','final','nonstring','uri','unsafe-id','accessor','limit']){
    const model=captureModel();model.targets={'':'F:/game',enb:'F:/game'};
    model.cfg.expectedDeploymentTargets={'':'F:/game',enb:'F:/game'};
    if(kind==='missing-review')model.cfg.expectedDeploymentTargets=null;
    if(kind==='missing-id')delete model.targets.enb;
    if(kind==='extra-id')model.targets.newtype='F:/game';
    if(kind==='other-root')model.targets.enb='Z:/private-root';
    if(kind==='final')model.afterStageInventory=()=>{model.targets.newtype='F:/game';};
    if(kind==='nonstring')model.targets.enb={secret:'NEVER-LEAK'};
    if(kind==='uri')model.targets.enb='https://example.invalid/NEVER-LEAK';
    if(kind==='unsafe-id')model.targets['NEVER-LEAK@']= 'F:/game';
    if(kind==='accessor')Object.defineProperty(model.targets,'enb',{enumerable:true,get(){assert.fail('getter must not execute');}});
    if(kind==='limit')for(let n=0;n<33;n++)model.targets['type'+n]='F:/game';
    await assert.rejects(model.run(generatedCapture(model)),/DEPLOYMENT_TARGET/);
    assert.equal(model.diagnostics.size,1,kind);const diagnostic=[...model.diagnostics.values()][0];
    assert.equal(diagnostic.noReplay,true);assert(diagnostic.actualRows.length<=32);
    const serialized=JSON.stringify(diagnostic);assert(!serialized.includes('NEVER-LEAK'));assert(!serialized.includes('private-root'));
  }
});

integration('a target-map diagnostic marker stops the generated entry before UI waits or capture replay', async () => {
  const f=fixture();prepareReadCapture({...f.options(f.output),apply:true});
  const filename=path.join(f.output,'index.prepared.js'),code=fs.readFileSync(filename,'utf8');
  const cfg={activationApproved:true,allActivationHold:false,purpose:'own-read-capture/1',pluginPath:f.output,
    control:f.parent,freshRootDiskBaselineFinalized:true,helperSHA256:hash(code),modulePins:{}};
  let timer,markerChecks=0;const module={exports:{}};
  vm.runInNewContext(code,{module,__filename:filename,__dirname:f.output,setTimeout(fn){timer=fn;},clearTimeout(){},
    require(name){
      if(name==='original-fs')return {readFileSync(p){assert.equal(p,filename);return code;},existsSync(p){markerChecks++;return p===path.join(f.parent,'TARGET-MAP-DIAGNOSTIC.json');}};
      if(name==='path')return path;
      if(name==='@nexusmods/vortex-api')return {selectors:{},util:{}};
      if(name==='./reviewed.json')return cfg;
      if(name==='./capture.cjs')return {hashBytes:hash,capture(){assert.fail('marker cannot replay capture');}};
      assert.fail(name);
    }},{timeout:1000});
  module.exports({once(fn){fn();},api:{awaitUI(){assert.fail('marker must stop before awaitUI');}}});
  assert.equal(typeof timer,'function');await timer();assert(markerChecks>=1);
});

function ordinaryParents(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const st = fs.lstatSync(current); assert.equal(st.isSymbolicLink(), false); assert.equal(st.isDirectory(), true);
    }
    if (current === path.dirname(current)) return;
  }
}
function fixture() {
  ordinaryParents(scratch); fs.mkdirSync(scratch, {recursive: true}); ordinaryParents(scratch);
  const parent = fs.mkdtempSync(path.join(scratch, 'read-capture-preparer-test-'));
  return {parent, output: path.join(parent, 'kit'), options: output => ({reference, timestampPolicy, output})};
}
function cloneReference(parent) {
  const dir = path.join(parent, 'reference'); fs.mkdirSync(dir);
  for (const name of Object.keys(SUPPORTED_READ_CAPTURE.referencePins)) fs.copyFileSync(path.join(reference, name), path.join(dir, name));
  return dir;
}

test('catalog is fixed to the zero-package read-only family and invalid CLI arguments do not become paths', () => {
  assert.ok(Object.isFrozen(SUPPORTED_READ_CAPTURE)); assert.ok(Object.isFrozen(SUPPORTED_READ_CAPTURE.referencePins));
  assert.equal(SUPPORTED_READ_CAPTURE.purpose, 'own-read-capture/1');
  assert.equal(SUPPORTED_READ_CAPTURE.profileId, 'ptndev1016');
  assert.throws(() => main(['--eval', 'anything']), /READ_CAPTURE_INVALID_ARGUMENTS/);
  assert.throws(() => main(['verify', 'relative']), /READ_CAPTURE_ABSOLUTE_PATH_REQUIRED/);
});

integration('dry-run writes nothing; apply creates one complete held code kit with every runtime pin', () => {
  const f = fixture();
  const plan = prepareReadCapture(f.options(f.output));
  assert.equal(plan.status, 'plan'); assert.equal(fs.existsSync(f.output), false);
  const made = prepareReadCapture({...f.options(f.output), apply: true});
  assert.equal(made.status, 'read-capture-held'); assert.equal(made.packages, 0);
  assert.equal(verifyReadCapture(f.output).codeVerified, true);
  const config = json(path.join(f.output, 'reviewed.prepared.json'));
  assert.deepEqual(config.packages, []);
  for (const key of ['pluginPath','health','expectedHostVersion','guard','sourcePins','diskBaseline','manifestPath',
    'admissionFile','admissionSHA256','reviewedPeerExtensions','nativeTempPath','expectedNativeTempId','expectedDeploymentTargets']) assert.equal(config[key], null, key);
  assert.equal(config.activationApproved, false); assert.equal(config.allActivationHold, true);
  assert.equal(config.freshRootDiskBaselineFinalized, false);
  assert.equal(made.activationGranted, false); assert.equal(made.capturePerformed, false);
  assert.equal(made.materializationSupported, false);
  const map = json(path.join(f.output, 'COPY-MAP.prepared.json'));
  assert.deepEqual(map.filter(row => row.sha256 === null).map(row => row.source), ['info.json','reviewed.json']);
  for (const [name, pin] of Object.entries(config.modulePins)) {
    assert.equal(hash(fs.readFileSync(path.join(f.output, name))), pin);
    assert.equal(map.find(row => row.destination === name).sha256, pin);
  }
  for (const name of ['reviewed.json','READY.json','host.prepared.ps1','completed.json','own-diagnostic.cjs']) {
    assert.equal(fs.existsSync(path.join(f.output, name)), false, name);
  }
});

integration('completed reference controls are neither read nor copied; only fixed hash-pinned code is consumed', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  fs.writeFileSync(path.join(ownReference, 'reviewed.json'), 'STALE_CONTROL_NOT_JSON');
  fs.writeFileSync(path.join(ownReference, 'completed.json'), 'STALE_RECEIPT');
  fs.writeFileSync(path.join(ownReference, 'READY.json'), 'STALE_APPROVAL');
  prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true});
  assert.equal(verifyReadCapture(f.output).codeVerified, true);
  assert.equal(fs.readFileSync(path.join(ownReference, 'reviewed.json'), 'utf8'), 'STALE_CONTROL_NOT_JSON');
  for (const name of fs.readdirSync(f.output)) assert.equal(fs.readFileSync(path.join(f.output, name), 'utf8').includes('STALE_'), false);
});

integration('unsupported code or timestamp policy refuses before output creation', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  fs.appendFileSync(path.join(ownReference, 'scope.cjs'), '\n');
  assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_REFERENCE_DRIFT/);
  assert.equal(fs.existsSync(f.output), false);
  const policy = path.join(f.parent, 'wrong-policy.cjs'); fs.writeFileSync(policy, 'module.exports={}');
  assert.throws(() => prepareReadCapture({reference, timestampPolicy: policy, output: f.output, apply: true}), /READ_CAPTURE_TIMESTAMP_POLICY_DRIFT/);
  assert.equal(fs.existsSync(f.output), false);
});

integration('actual generated entry and complete local module graph stay inert with no native API/events or reads', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const config = json(path.join(f.output, 'reviewed.prepared.json'));
  const modules = new Map(); let calls = 0;
  const forbidden = () => {calls++; throw Error('UNEXPECTED_NATIVE_OR_FILESYSTEM_CALL');};
  const physical = new Proxy({}, {get: () => forbidden});
  function load(name) {
    if (name === './reviewed.json') return config;
    if (name === 'original-fs') return physical;
    if (name === 'path') return path;
    if (name === 'crypto') return crypto;
    if (name === '@nexusmods/vortex-api') return {selectors: {}, util: {}};
    assert.match(name, /^\.\/[a-z-]+\.cjs$/);
    const leaf = name.slice(2); assert.ok(Object.hasOwn(config.modulePins, leaf));
    if (modules.has(leaf)) return modules.get(leaf).exports;
    const module = {exports: {}}; modules.set(leaf, module);
    const code = fs.readFileSync(path.join(f.output, leaf), 'utf8');
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {setTimeout: forbidden, clearTimeout: forbidden},
      {timeout: 1000})(load, module, module.exports);
    return module.exports;
  }
  const module = {exports: {}};
  vm.runInNewContext('(function(require,module,exports,__dirname,__filename){'
    + fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8') + '\n})', {setTimeout: forbidden},
  {timeout: 1000})(load, module, module.exports, f.output, path.join(f.output, 'index.prepared.js'));
  assert.equal(module.exports({once: forbidden, api: new Proxy({}, {get: forbidden})}), true);
  assert.equal(calls, 0);
  assert.equal(load('./scope.cjs').validate([]), true);
  assert.throws(() => load('./scope.cjs').validate([{}]), /NO_PACKAGE_LOOKUP/);
  assert.equal(fs.readFileSync(path.join(f.output, 'capture.cjs'), 'utf8').includes('const timestampModule='), false);
  assert.equal(fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8').includes('CP-SETTLEMENT-DIAGNOSTIC'), false);
  assert.equal(modules.has('tool-timestamps.cjs'), true);
});

integration('self-consistent manifest edits cannot bless packages, module drift or an incomplete copy map', () => {
  for (const kind of ['packages','map','module','extra','json-duplicate']) {
    const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
    const manifestFile = path.join(f.output, 'READ-CAPTURE-KIT.json');
    const contract = json(manifestFile);
    let name;
    if (kind === 'packages') {
      name = 'reviewed.prepared.json'; const cfg = json(path.join(f.output, name)); cfg.packages = [{}];
      fs.writeFileSync(path.join(f.output, name), JSON.stringify(cfg));
    } else if (kind === 'map') {
      name = 'COPY-MAP.prepared.json'; fs.writeFileSync(path.join(f.output, name), '[]');
    } else if (kind === 'module') {
      name = 'scope.cjs'; fs.appendFileSync(path.join(f.output, name), '\n');
    } else if (kind === 'extra') fs.writeFileSync(path.join(f.output, 'attempt.json'), '{}');
    else fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('{', '{"schema":"own-read-capture-kit/1",'));
    if (name) {
      contract.files[name] = hash(fs.readFileSync(path.join(f.output, name)));
      fs.writeFileSync(manifestFile, JSON.stringify(contract, null, 2) + '\n');
    }
    assert.throws(() => verifyReadCapture(f.output));
  }
});

integration('partial output remains held with no manifest, overwrite, retry or cleanup', () => {
  const f = fixture(); const original = fs.writeFileSync; let count = 0;
  try {
    fs.writeFileSync = (...args) => {if (++count === 3) throw Error('OWN_PARTIAL_WRITE'); return original(...args);};
    assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /OWN_PARTIAL_WRITE/);
  } finally {fs.writeFileSync = original;}
  assert.ok(fs.readdirSync(f.output).length > 0);
  assert.equal(fs.existsSync(path.join(f.output, 'READ-CAPTURE-KIT.json')), false);
  assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_INCOMPLETE_KIT/);
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
});

integration('source mutation during an FD read refuses before creating output', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  const original = fs.readSync; let changed = false;
  try {
    fs.readSync = (...args) => {
      const count = original(...args);
      if (count === 0 && !changed) {
        changed = true; fs.appendFileSync(path.join(ownReference, 'index.prepared.js'), '\n');
      }
      return count;
    };
    assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.readSync = original;}
  assert.equal(changed, true); assert.equal(fs.existsSync(f.output), false);
});

integration('extra file appearing after the initial clean inventory cannot receive codeVerified success', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const original = fs.opendirSync; let injected = false;
  try {
    fs.opendirSync = (...args) => {
      const directory = original(...args), read = directory.readSync.bind(directory);
      directory.readSync = () => {
        const entry = read();
        if (entry === null && !injected && path.resolve(args[0]) === f.output) {
          injected = true; fs.writeFileSync(path.join(f.output, 'unexpected-after-inventory.js'), 'preserve');
        }
        return entry;
      };
      return directory;
    };
    assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_(KIT_FILES_DIFFER|OUTPUT_CHANGED)/);
  } finally {fs.opendirSync = original;}
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(f.output, 'unexpected-after-inventory.js'), 'utf8'), 'preserve');
});

integration('leaf mutation after all content reads is caught by terminal generation checks', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const original = fs.opendirSync; let inventories = 0, changed = false;
  try {
    fs.opendirSync = (...args) => {
      const directory = original(...args), read = directory.readSync.bind(directory);
      const selected = path.resolve(args[0]) === f.output && ++inventories === 2;
      directory.readSync = () => {
        const entry = read();
        if (entry === null && selected && !changed) {
          changed = true; fs.appendFileSync(path.join(f.output, 'scope.cjs'), '\n');
        }
        return entry;
      };
      return directory;
    };
    assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.opendirSync = original;}
  assert.equal(changed, true);
});

integration('source drift during output writing is reported and the held output is preserved without retry', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  const original = fs.writeFileSync; let changed = false;
  try {
    fs.writeFileSync = (...args) => {
      const result = original(...args);
      if (!changed) {changed = true; fs.appendFileSync(path.join(ownReference, 'scope.cjs'), '\n');}
      return result;
    };
    assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.writeFileSync = original;}
  assert.equal(changed, true); assert.ok(fs.readdirSync(f.output).length > 0);
  assert.equal(json(path.join(f.output, 'reviewed.prepared.json')).activationApproved, false);
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
});

integration('a destination appearing after plan validation is preserved and never adopted', () => {
  const f = fixture(), original = fs.mkdirSync; let raced = false;
  try {
    fs.mkdirSync = (name, ...args) => {
      if (path.resolve(name) === f.output && !raced) {
        raced = true; original(name); fs.writeFileSync(path.join(name, 'foreign'), 'preserve');
      }
      return original(name, ...args);
    };
    assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), error => error.code === 'EEXIST');
  } finally {fs.mkdirSync = original;}
  assert.equal(raced, true); assert.deepEqual(fs.readdirSync(f.output), ['foreign']);
  assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'preserve');
});

integration('existing output, active paths, scope escape and reparse ancestors refuse without overwriting', () => {
  const f = fixture(); fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'foreign'), 'keep');
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'keep');
  assert.throws(() => prepareReadCapture(f.options(path.resolve(scratch, '..', 'outside-read-capture'))), /READ_CAPTURE_OUTPUT_SCOPE_REFUSED/);
  assert.throws(() => prepareReadCapture(f.options(path.join(f.parent, 'Vortex', 'plugins', 'inactive'))), /READ_CAPTURE_ACTIVE_PLUGIN_PATH_REFUSED/);
  const ownReference = cloneReference(f.parent);
  assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: path.join(ownReference, 'kit')}), /READ_CAPTURE_REFERENCE_OUTPUT_OVERLAP/);
  const target = path.join(f.parent, 'ordinary'); fs.mkdirSync(target);
  const link = path.join(f.parent, 'link'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareReadCapture(f.options(path.join(link, 'kit'))), /READ_CAPTURE_REPARSE_PATH/);
  assert.deepEqual(fs.readdirSync(target), []);
});

integration('CLI errors contain only a fixed reason code, not private paths or stack traces', () => {
  const f = fixture();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-read-capture.mjs', import.meta.url)),
    '--reference', path.join(f.parent, 'private-missing-reference'), '--timestamp-policy', timestampPolicy, '--output', f.output],
  {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.match(child.stderr, /^READ_CAPTURE_[A-Z_]+\r?\n$/);
  assert.equal(child.stderr.includes(f.parent), false); assert.equal(fs.existsSync(f.output), false);
});
