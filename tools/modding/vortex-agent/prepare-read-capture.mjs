import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import strictJSON from './strict-json.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../local-state');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (value, code) => {if (!value) throw Error(code);};
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const referencePins = Object.freeze({
  'index.prepared.js': '0337ce5330d8ae094e52b821bfd8e26440b168ed4ae7c76468020bfca2681417',
  'capture.cjs': '034c81da4efb7d56815192fb9029a1e2e1b2c3e4f557d08bb611f84e66b5dffd',
  'scope.cjs': '0e0afb9685f199f2b1bf292c5911e38cea89cf180bc7805cae9c7d018862abaa',
  'native-selectors.cjs': '2078f202b8b7aed52172dcde7362d95b177a18db761dde8a098e7623c52285cb',
  'nexus-identity.cjs': '0f5677a95e62fce5613f7f2594b50a86b98ef7144c23f179887e1cb25428ba2a',
  'extractor-admission.cjs': '7d7da582e58f7af2ae492421617cdd168a4476b524287848b2805e7c201a2e93',
});
const timestampPin = 'a50d4f9f8da135e214542ef89dd970c3c38c569dd2a4ae7b12c4cac43cb7b0a7';
export const SUPPORTED_READ_CAPTURE = Object.freeze({family: 'menu-zero-package-read-capture/1',
  purpose: 'own-read-capture/1', hostVersion: '2.9.1', gameId: 'cyberpunk2077', profileId: 'ptndev1016',
  referencePins, timestampPin});
export const MISSING_CAPTURE_BINDINGS = Object.freeze(['health/context/root identities', 'current source admission and source pins',
  'independent root disk/deployment/preferences baseline', 'independently reviewed native deployment target map', 'native temp identity', 'current process guard',
  'fresh plugin identity and reviewed host/materializer', 'reviewed peers/interlocks and exclusive native window']);
const runtime = Object.freeze(['capture.cjs', 'extractor-admission.cjs', 'native-selectors.cjs',
  'nexus-identity.cjs', 'scope.cjs', 'tool-timestamps.cjs']);
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
const node = stat => `${stat.dev}:${stat.ino}`;

function ordinary(value) {
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current, {bigint: true});
      need(!stat.isSymbolicLink(), 'READ_CAPTURE_REPARSE_PATH');
      if (current !== path.resolve(value)) need(stat.isDirectory(), 'READ_CAPTURE_ORDINARY_PARENT_REQUIRED');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (current === path.dirname(current)) return;
  }
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value), 'READ_CAPTURE_ABSOLUTE_PATH_REQUIRED');
  const result = path.resolve(value); ordinary(result);
  need(!/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(result), 'READ_CAPTURE_ACTIVE_PLUGIN_PATH_REFUSED');
  return result;
}
function ancestry(value) {
  ordinary(value); const result = [];
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'READ_CAPTURE_ORDINARY_PARENT_REQUIRED');
    result.push([current, node(stat)]);
    if (current === path.dirname(current)) return result;
  }
}
function sameAncestry(pins) {
  for (const [file, identity] of pins) {
    const stat = fs.lstatSync(file, {bigint: true});
    need(stat.isDirectory() && !stat.isSymbolicLink() && node(stat) === identity, 'READ_CAPTURE_PATH_CHANGED');
  }
}
function read(file, maxBytes = 1024 * 1024) {
  const parents = ancestry(path.dirname(file)); ordinary(file);
  const before = fs.lstatSync(file, {bigint: true});
  need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes), 'READ_CAPTURE_BOUNDED_FILE_REQUIRED');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, {bigint: true});
    need(stamp(opened) === stamp(before), 'READ_CAPTURE_INPUT_CHANGED');
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    const after = fs.fstatSync(fd, {bigint: true});
    need(bytes.length <= maxBytes && BigInt(bytes.length) === after.size && stamp(after) === stamp(opened)
      && stamp(fs.lstatSync(file, {bigint: true})) === stamp(after), 'READ_CAPTURE_INPUT_CHANGED');
    sameAncestry(parents); return {bytes, file, generation: stamp(after), parents};
  } finally {fs.closeSync(fd);}
}
function unchanged(observations) {
  for (const old of observations) {
    sameAncestry(old.parents); const current = read(old.file);
    need(current.generation === old.generation && current.bytes.equals(old.bytes), 'READ_CAPTURE_INPUT_CHANGED');
  }
}
function directoryNames(dir) {
  const handle = fs.opendirSync(dir); const names = [];
  try {
    for (let entry; (entry = handle.readSync()) !== null;) {
      need(entry.isFile(), 'READ_CAPTURE_KIT_FILES_DIFFER');
      names.push(entry.name);
      need(names.length <= runtime.length + 6, 'READ_CAPTURE_KIT_FILES_DIFFER');
    }
    return names.sort();
  } finally {handle.closeSync();}
}
function replaceOnce(value, old, replacement) {
  need(value.split(old).length === 2, 'READ_CAPTURE_UNSUPPORTED_TEMPLATE');
  return value.replace(old, replacement);
}
// Applied only to the independently hash-pinned Menu capture body.
const captureProofHelpers = String.raw`function captureOrdinary(p){const rows=[];for(let a=path.resolve(p);;a=path.dirname(a)){const s=fs.lstatSync(a,{bigint:true});need(!s.isSymbolicLink(),'CAPTURE_REPARSE');if(a!==path.resolve(p))need(s.isDirectory(),'CAPTURE_PARENT_NOT_DIRECTORY');rows.push([a,String(s.dev)+':'+String(s.ino)]);if(a===path.dirname(a))return rows;}}
function captureParentsCurrent(rows){for(const [p,id]of rows){const s=fs.lstatSync(p,{bigint:true});need(!s.isSymbolicLink()&&String(s.dev)+':'+String(s.ino)===id,'CAPTURE_PATH_CHANGED');}}
function physicalReader(){const cache=new Map(),stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');return function physical(p){const parents=captureOrdinary(p),st=fs.lstatSync(p,{bigint:true});need(st.isFile()&&!st.isSymbolicLink()&&st.size>=0n&&st.size<=BigInt(Number.MAX_SAFE_INTEGER),'REGULAR_FILE_REQUIRED');const key=stamp(st);let sha256=cache.get(key);if(sha256===undefined){const fd=fs.openSync(p,'r'),h=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024);try{const opened=fs.fstatSync(fd,{bigint:true});need(stamp(opened)===key,'FILE_DESCRIPTOR_CHANGED');let total=0;for(;;){const count=fs.readSync(fd,buf,0,Math.min(buf.length,Number(st.size)-total+1),null);if(count===0)break;total+=count;need(total<=Number(st.size),'FILE_GREW_DURING_CAPTURE');h.update(buf.subarray(0,count));}need(total===Number(st.size)&&stamp(fs.fstatSync(fd,{bigint:true}))===key,'FILE_CHANGED_DURING_CAPTURE');sha256=h.digest('hex');}finally{fs.closeSync(fd);}}need(stamp(fs.lstatSync(p,{bigint:true}))===key,'FILE_CHANGED_DURING_CAPTURE');captureParentsCurrent(parents);cache.set(key,sha256);return {nodeId:String(st.dev)+':'+String(st.ino),bytes:Number(st.size),links:Number(st.nlink),sha256};};}
function reviewCaptureTargets(actual,cfg){const game=norm(cfg.health.gamePath),id=k=>typeof k==='string'&&/^[A-Za-z0-9_-]{0,128}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k);function inspect(value){const rows=[],map=Object.create(null);let valid=!!value&&typeof value==='object'&&!Array.isArray(value),keys=[];if(valid){keys=Reflect.ownKeys(value);valid=keys.length>0&&keys.length<=32&&keys.every(id);for(const k of keys.slice(0,32)){const d=Object.getOwnPropertyDescriptor(value,k),v=d&&Object.hasOwn(d,'value')?d.value:undefined;const absolute=typeof v==='string'&&v.length<=4096&&/^[a-z]:[\\/]/i.test(v)&&!/[\x00-\x1f\x7f]/.test(v)&&path.isAbsolute(v),sameRoot=absolute&&norm(v)===game;rows.push({id:id(k)?k:null,valueKind:!d?'missing':!Object.hasOwn(d,'value')?'accessor':typeof v,pathKind:absolute?'absolute-drive':'unsupported',equalsGameRoot:!!sameRoot});if(!id(k)||!sameRoot||!d.enumerable)valid=false;else map[k]=game;}}return {valid:valid&&Object.hasOwn(map,''),map,rows,keyCount:keys.length};}const observed=inspect(actual),reviewed=inspect(cfg.expectedDeploymentTargets);let code;if(!reviewed.valid)code='DEPLOYMENT_TARGET_REVIEW_REQUIRED';else if(!observed.valid)code='UNSUPPORTED_DEPLOYMENT_TARGETS';else if(stable(Object.keys(observed.map).sort())!==stable(Object.keys(reviewed.map).sort()))code='DEPLOYMENT_TARGET_MAP_MISMATCH';if(code){captureOrdinary(cfg.control);const diagnostic={schema:'read-capture-target-map-diagnostic/1',code,actualKeyCount:observed.keyCount,actualRows:observed.rows,expectedReviewValid:reviewed.valid,readOnly:true,noReplay:true,noNativeEffects:true};fs.writeFileSync(path.join(cfg.control,'TARGET-MAP-DIAGNOSTIC.json'),JSON.stringify(diagnostic,null,2)+'\n',{flag:'wx'});throw Error(code);}return Object.fromEntries(Object.keys(observed.map).sort().map(k=>[k,game]));}
function captureRoots(s,cfg,selectors,util){const h=cfg.health,roots={gamePath:s.settings.gameMode.discovered[h.gameId].path,stagingPath:selectors.installPathForGame(s,h.gameId),downloadPath:selectors.downloadPathForGame(s,h.gameId)},ids={};for(const [k,p]of Object.entries(roots)){captureOrdinary(p);const st=fs.lstatSync(p,{bigint:true});need(st.isDirectory()&&norm(p)===norm(h[k])&&String(st.dev)+':'+String(st.ino)===h.filesystemIds[k],'ACTUAL_ROOT_IDENTITY_CHANGED');ids[k]=String(st.dev)+':'+String(st.ino);}need(typeof util.getGame==='function','ACTUAL_GAME_TARGET_SELECTOR_REQUIRED');const game=util.getGame(h.gameId);need(game&&typeof game.getModPaths==='function','ACTUAL_GAME_TARGET_SELECTOR_REQUIRED');const targets=game.getModPaths(roots.gamePath);const deploymentTargets=reviewCaptureTargets(targets,cfg);need(typeof util.getVortexPath==='function','NATIVE_TEMP_SELECTOR_REQUIRED');const temp=util.getVortexPath('temp');captureOrdinary(temp);const st=fs.lstatSync(temp,{bigint:true});need(st.isDirectory()&&norm(temp)===norm(cfg.nativeTempPath)&&typeof cfg.expectedNativeTempId==='string'&&String(st.dev)+':'+String(st.ino)===cfg.expectedNativeTempId,'NATIVE_TEMP_PATH_CHANGED');return {roots:ids,nativeTemp:{path:temp,nodeId:String(st.dev)+':'+String(st.ino)},deploymentTargets};}
function verifyPreferenceDiscovery(cfg){const old=JSON.parse(fs.readFileSync(cfg.diskBaseline.path,'utf8')),d=old.preferenceDiscovery,h=cfg.health,roots=[path.join(h.gamePath,'bin/x64/plugins/cyber_engine_tweaks/mods'),path.join(h.gamePath,'red4ext/plugins')],extensions=['.db','.ini','.json','.sqlite3'];need(d&&d.schema==='read-capture-preference-discovery/1'&&Array.isArray(d.roots)&&stable(d.roots.map(norm))===stable(roots.map(norm))&&stable(d.extensions)===stable(extensions)&&Array.isArray(d.files)&&d.files.length<=10000&&Array.isArray(old.settings)&&old.settings.length<=10000,'PREFERENCE_DISCOVERY_REQUIRED');const settings=new Set();for(const row of old.settings){need(row&&typeof row==='object'&&!Array.isArray(row)&&stable(Object.keys(row).sort())===stable(['bytes','links','nodeId','path','sha256'])&&typeof row.path==='string'&&row.path.length<=4096&&path.isAbsolute(row.path)&&!/[\x00-\x1f\x7f]/.test(row.path)&&typeof row.nodeId==='string'&&/^\d+:\d+$/.test(row.nodeId)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&Number.isSafeInteger(row.links)&&row.links>=1&&typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256),'PREFERENCE_SETTINGS_INVALID');const key=norm(row.path);need(!settings.has(key),'PREFERENCE_SETTINGS_DUPLICATE');settings.add(key);}need(d.files.every(p=>typeof p==='string'&&settings.has(p)),'PREFERENCE_SETTINGS_MISSING');const excluded=d.excludedLogLinks,allowed=new Set(['ArchiveXL','Codeware','TweakXL'].map(name=>norm(path.join(h.gamePath,'red4ext/plugins',name,name+'.log')))),excludedMap=new Map(),seenLinks=new Set();need(Array.isArray(excluded)&&excluded.length<=3,'PREFERENCE_LOG_LINK_PINS_INVALID');for(const r of excluded){need(r&&typeof r==='object'&&!Array.isArray(r)&&stable(Object.keys(r).sort())===stable(['bytes','ctimeNs','fileAttributes','linkTextSHA256','links','mtimeNs','nodeId','path'])&&typeof r.path==='string'&&path.isAbsolute(r.path)&&r.path.replace(/\\/g,'/').toLowerCase()===norm(r.path)&&allowed.has(norm(r.path))&&typeof r.nodeId==='string'&&/^\d+:\d+$/.test(r.nodeId)&&['bytes','links','mtimeNs','ctimeNs'].every(k=>typeof r[k]==='string'&&/^\d+$/.test(r[k]))&&r.links==='1'&&typeof r.linkTextSHA256==='string'&&/^[a-f0-9]{64}$/.test(r.linkTextSHA256)&&Number.isInteger(r.fileAttributes)&&r.fileAttributes>=0&&r.fileAttributes<=0xffffffff&&(r.fileAttributes&0x400)!==0&&(r.fileAttributes&0x10)===0,'PREFERENCE_LOG_LINK_PINS_INVALID');const key=norm(r.path);need(!excludedMap.has(key)&&!settings.has(key),'PREFERENCE_LOG_LINK_PINS_INVALID');excludedMap.set(key,r);}function checkLink(p,r){const s=fs.lstatSync(p,{bigint:true});need(s.isSymbolicLink()&&!s.isDirectory()&&String(s.dev)+':'+String(s.ino)===r.nodeId&&String(s.size)===r.bytes&&String(s.nlink)===r.links&&String(s.mtimeNs)===r.mtimeNs&&String(s.ctimeNs)===r.ctimeNs&&hashBytes(fs.readlinkSync(p,{encoding:'buffer'}))===r.linkTextSHA256,'PREFERENCE_LOG_LINK_CHANGED');const after=fs.lstatSync(p,{bigint:true});need(after.isSymbolicLink()&&!after.isDirectory()&&String(after.dev)+':'+String(after.ino)===r.nodeId&&String(after.size)===r.bytes&&String(after.nlink)===r.links&&String(after.mtimeNs)===r.mtimeNs&&String(after.ctimeNs)===r.ctimeNs,'PREFERENCE_LOG_LINK_CHANGED');}const files=[],dirs=[],leaves=[],stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');let entries=0,directoryCount=0;function walk(dir,depth=0){need(depth<=32&&++directoryCount<=20000,'PREFERENCE_DISCOVERY_LIMIT');captureOrdinary(dir);const before=fs.lstatSync(dir,{bigint:true});need(before.isDirectory(),'PREFERENCE_DIRECTORY_REQUIRED');const opened=fs.opendirSync(dir);try{let e;while((e=opened.readSync())!==null){need(++entries<=50000,'PREFERENCE_DISCOVERY_LIMIT');const p=path.join(dir,e.name),s=fs.lstatSync(p,{bigint:true});if(e.isSymbolicLink()||s.isSymbolicLink()){const key=norm(p),pin=excludedMap.get(key);need(pin&&!seenLinks.has(key),'PREFERENCE_REPARSE');checkLink(p,pin);seenLinks.add(key);continue;}if(s.isDirectory())walk(p,depth+1);else{need(s.isFile(),'PREFERENCE_NONREGULAR');if(extensions.includes(path.extname(e.name).toLowerCase())){need(files.length<10000,'PREFERENCE_DISCOVERY_LIMIT');files.push(norm(p));leaves.push([p,stamp(s)]);}}}}finally{opened.closeSync();}need(stamp(fs.lstatSync(dir,{bigint:true}))===stamp(before),'PREFERENCE_DIRECTORY_CHANGED');dirs.push([dir,stamp(before)]);}for(const root of roots)walk(root);need(seenLinks.size===excludedMap.size,'PREFERENCE_LOG_LINK_MISSING');for(const [key,pin]of excludedMap)checkLink(pin.path,pin);for(const [p,pin]of [...dirs,...leaves])need(stamp(fs.lstatSync(p,{bigint:true}))===pin,'PREFERENCE_DISCOVERY_CHANGED');files.sort();need(new Set(files).size===files.length&&stable(files)===stable(d.files),'PREFERENCE_FILE_SET_CHANGED');return files;}
`;
function hardenCapture(original) {
  const begin = original.indexOf('function physicalReader(){');
  const end = original.indexOf('\nfunction under(', begin);
  need(begin >= 0 && end > begin, 'READ_CAPTURE_UNSUPPORTED_TEMPLATE');
  let value = replaceOnce(original, original.slice(begin, end), captureProofHelpers.trimEnd());
  const oldRoots = " const roots={gamePath:before.settings.gameMode.discovered[h.gameId].path,stagingPath:selectors.installPathForGame(before,h.gameId),downloadPath:selectors.downloadPathForGame(before,h.gameId)};\n"
    + " for(const [k,p]of Object.entries(roots)){const st=fs.statSync(p,{bigint:true});need(norm(p)===norm(h[k])&&!fs.lstatSync(p).isSymbolicLink()&&`${st.dev}:${st.ino}`===h.filesystemIds[k],'ACTUAL_ROOT_IDENTITY_CHANGED');}";
  value = replaceOnce(value, oldRoots, ' const rootCheckpoint=captureRoots(before,cfg,selectors,util);verifyPreferenceDiscovery(cfg);');
  const oldTemp = " need(typeof util.getVortexPath==='function','NATIVE_TEMP_SELECTOR_REQUIRED');const tempPath=util.getVortexPath('temp'),tempStat=fs.statSync(tempPath,{bigint:true});need(norm(tempPath)===norm(cfg.nativeTempPath)&&tempStat.isDirectory()&&!fs.lstatSync(tempPath).isSymbolicLink(),'NATIVE_TEMP_PATH_CHANGED');const nativeTemp={path:tempPath,nodeId:`${tempStat.dev}:${tempStat.ino}`};";
  value = replaceOnce(value, oldTemp, ' const nativeTemp=rootCheckpoint.nativeTemp;');
  value = replaceOnce(value,
    ";pins(cfg);need(stable(admission(api,cfg))===stable(admitted),'SOURCE_ADMISSION_CHANGED_DURING_CAPTURE');verifyDisk(cfg,physical);",
    ';verifyDisk(cfg,physical);');
  value = replaceOnce(value, ' const records=Object.fromEntries(Object.entries(before.persistent.mods).map',
    " verifyPreferenceDiscovery(cfg);verifyDisk(cfg,physical);pins(cfg);need(stable(admission(api,cfg))===stable(admitted),'SOURCE_ADMISSION_CHANGED_DURING_CAPTURE');const finalState=api.getState();quiet(finalState,cfg,selectors);require(cfg.guard).stopped(finalState,h.gameId);need(stable(rawDigests(finalState))===stable(initial),'RAW_NATIVE_STATE_CHANGED_DURING_READ_CAPTURE');need(stable(captureRoots(finalState,cfg,selectors,util))===stable(rootCheckpoint),'ROOT_OR_TEMP_CHANGED_DURING_CAPTURE');\n const records=Object.fromEntries(Object.entries(before.persistent.mods).map");
  return value;
}

function contentsFor({output, originalIndex, originalCapture, modules, timestamp}) {
  let index = originalIndex.toString('utf8').replaceAll('\r\n', '\n');
  index = replaceOnce(index, "'read-only-clean-capture-reuse-dev-native-capture/1'", "'own-read-capture/1'");
  index = replaceOnce(index, "   save('CP-SETTLEMENT-DIAGNOSTIC',require('./own-diagnostic.cjs').project(context.api.getState(),cfg.health.profileId));\n", '');
  index = replaceOnce(index, "['capture','failed','BASELINE','STAGE-INVENTORY']", "['capture','failed','BASELINE','STAGE-INVENTORY','TARGET-MAP-DIAGNOSTIC']");
  let capture = originalCapture.toString('utf8').replaceAll('\r\n', '\n');
  capture = hardenCapture(capture);
  capture = replaceOnce(capture, 'readOnly:true,health:h,hostVersion:', 'readOnly:true,reviewedDeploymentTargets:rootCheckpoint.deploymentTargets,health:h,hostVersion:');
  const oldTimestamp = 'const timestampModule="D:/Modding/Nexus/local-state/collection-hardening-20261028/native-state-diagnostic-v2/tool-timestamps.cjs";\n'
    + 'if(crypto.createHash(\'sha256\').update(fs.readFileSync(timestampModule)).digest(\'hex\')!=="' + timestampPin
    + '")throw Error(\'TOOL_TIMESTAMP_POLICY_SOURCE_CHANGED\');\nconst toolTimestamps=require(timestampModule);';
  capture = replaceOnce(capture, oldTimestamp, "const toolTimestamps=require('./tool-timestamps.cjs');");
  const contents = new Map([...modules].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  contents.set('capture.cjs', Buffer.from(capture)); contents.set('tool-timestamps.cjs', Buffer.from(timestamp));
  contents.set('index.prepared.js', Buffer.from(index));
  contents.set('reference-index.js', Buffer.from(originalIndex)); contents.set('reference-capture.cjs', Buffer.from(originalCapture));
  const config = {purpose: 'own-read-capture/1', activationApproved: false, allActivationHold: true, noEffects: true,
    sourceOnlyNoCapturePerformed: true, freshStaticAdmissionRequired: true, freshRootDiskBaselineFinalized: false,
    control: output, pluginPath: null, health: null, expectedHostVersion: null, guard: null, sourcePins: null,
    packages: [], diskBaseline: null, manifestPath: null, admissionFile: null, admissionSHA256: null,
    reviewedPeerExtensions: null, nativeTempPath: null, expectedNativeTempId: null, expectedDeploymentTargets: null, helperSHA256: sha(contents.get('index.prepared.js')),
    modulePins: Object.fromEntries(runtime.map(name => [name, sha(contents.get(name))]))};
  contents.set('reviewed.prepared.json', Buffer.from(canonical(config)));
  contents.set('COPY-MAP.prepared.json', Buffer.from(canonical([
    {source: 'index.prepared.js', destination: 'index.js', sha256: sha(contents.get('index.prepared.js'))},
    {source: 'info.json', destination: 'info.json', sha256: null},
    {source: 'reviewed.json', destination: 'reviewed.json', sha256: null},
    ...runtime.map(name => ({source: name, destination: name, sha256: sha(contents.get(name))})),
  ])));
  contents.set('READ-CAPTURE-KIT.json', Buffer.from(canonical({schema: 'own-read-capture-kit/1',
    family: SUPPORTED_READ_CAPTURE.family, purpose: config.purpose, supportedHostVersion: '2.9.1',
    gameId: 'cyberpunk2077', profileId: 'ptndev1016', runtime, referencePins, timestampPin,
    files: Object.fromEntries([...contents].map(([name, bytes]) => [name, sha(bytes)])),
    packages: [], activationGranted: false, installReady: false, nativeEffects: false, capturePerformed: false,
    materializationSupported: false, missingBindings: MISSING_CAPTURE_BINDINGS})));
  return contents;
}
function result(output, files, applied = false) {
  return {status: applied ? 'read-capture-held' : 'plan', output, files, runtimeModules: runtime.length,
    packages: 0, installReady: false, activationGranted: false, nativeEffects: false, capturePerformed: false,
    materializationSupported: false, missingBindings: [...MISSING_CAPTURE_BINDINGS]};
}
export function prepareReadCapture({reference, timestampPolicy, output, apply = false}) {
  need(typeof apply === 'boolean', 'READ_CAPTURE_INVALID_ARGUMENTS');
  reference = absolute(reference); output = absolute(output);
  const relative = path.relative(scratch, output);
  need(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'READ_CAPTURE_OUTPUT_SCOPE_REFUSED');
  const fromReference = path.relative(reference, output);
  need(fromReference.startsWith('..' + path.sep) || fromReference === '..' || path.isAbsolute(fromReference), 'READ_CAPTURE_REFERENCE_OUTPUT_OVERLAP');
  need(!fs.existsSync(output), 'READ_CAPTURE_NEW_OUTPUT_REQUIRED');
  const parentPins = ancestry(path.dirname(output));
  timestampPolicy = absolute(timestampPolicy ?? path.join(reference, 'tool-timestamps.cjs'));
  const observations = [], inputs = new Map();
  for (const [name, pin] of Object.entries(referencePins)) {
    const item = read(path.join(reference, name)); observations.push(item);
    need(sha(item.bytes) === pin, 'READ_CAPTURE_REFERENCE_DRIFT'); inputs.set(name, item.bytes);
  }
  const timestamp = read(timestampPolicy); observations.push(timestamp);
  need(sha(timestamp.bytes) === timestampPin, 'READ_CAPTURE_TIMESTAMP_POLICY_DRIFT');
  const modules = new Map([...inputs].filter(([name]) => !['index.prepared.js', 'capture.cjs'].includes(name)));
  const contents = contentsFor({output, originalIndex: inputs.get('index.prepared.js'),
    originalCapture: inputs.get('capture.cjs'), modules, timestamp: timestamp.bytes});
  unchanged(observations); sameAncestry(parentPins);
  if (apply) {
    fs.mkdirSync(output); // Exclusive. An incomplete output remains held; never clean up or retry.
    const outputNode = node(fs.lstatSync(output, {bigint: true}));
    const ownOutput = () => {sameAncestry(parentPins); ordinary(output);
      const stat = fs.lstatSync(output, {bigint: true});
      need(stat.isDirectory() && node(stat) === outputNode, 'READ_CAPTURE_OUTPUT_CHANGED');};
    for (const [name, bytes] of contents) {
      ownOutput(); const fd = fs.openSync(path.join(output, name), 'wx');
      try {fs.writeFileSync(fd, bytes);} finally {fs.closeSync(fd);}
    }
    ownOutput(); verifyReadCapture(output); unchanged(observations); ownOutput();
  }
  return result(output, contents.size, apply);
}
export function verifyReadCapture(value) {
  const dir = absolute(value), observations = [];
  const directoryPins = ancestry(dir), directoryGeneration = stamp(fs.lstatSync(dir, {bigint: true}));
  const initialNames = directoryNames(dir);
  const take = name => {const item = read(path.join(dir, name)); observations.push(item); return item.bytes;};
  need(fs.existsSync(path.join(dir, 'READ-CAPTURE-KIT.json')), 'READ_CAPTURE_INCOMPLETE_KIT');
  const contractBytes = take('READ-CAPTURE-KIT.json');
  const contract = strictJSON.parseStrictJSON(contractBytes);
  need(contract?.schema === 'own-read-capture-kit/1', 'READ_CAPTURE_INVALID_KIT');
  const originalIndex = take('reference-index.js'), originalCapture = take('reference-capture.cjs');
  need(sha(originalIndex) === referencePins['index.prepared.js'] && sha(originalCapture) === referencePins['capture.cjs'], 'READ_CAPTURE_REFERENCE_DRIFT');
  const modules = new Map();
  for (const [name, pin] of Object.entries(referencePins)) {
    if (['index.prepared.js', 'capture.cjs'].includes(name)) continue;
    const bytes = take(name); need(sha(bytes) === pin, 'READ_CAPTURE_REFERENCE_DRIFT'); modules.set(name, bytes);
  }
  const timestamp = take('tool-timestamps.cjs'); need(sha(timestamp) === timestampPin, 'READ_CAPTURE_TIMESTAMP_POLICY_DRIFT');
  const expected = contentsFor({output: dir, originalIndex, originalCapture, modules, timestamp});
  const expectedNames = [...expected.keys()].sort();
  need(same(initialNames, expectedNames), 'READ_CAPTURE_KIT_FILES_DIFFER');
  for (const [name, bytes] of expected) {
    const actual = name === 'READ-CAPTURE-KIT.json' ? contractBytes : take(name);
    need(actual.equals(bytes), 'READ_CAPTURE_KIT_DRIFT');
  }
  unchanged(observations);
  sameAncestry(directoryPins);
  need(same(directoryNames(dir), expectedNames), 'READ_CAPTURE_KIT_FILES_DIFFER');
  sameAncestry(directoryPins);
  need(stamp(fs.lstatSync(dir, {bigint: true})) === directoryGeneration, 'READ_CAPTURE_OUTPUT_CHANGED');
  for (const observation of observations) {
    sameAncestry(observation.parents);
    need(stamp(fs.lstatSync(observation.file, {bigint: true})) === observation.generation, 'READ_CAPTURE_INPUT_CHANGED');
  }
  sameAncestry(directoryPins);
  need(stamp(fs.lstatSync(dir, {bigint: true})) === directoryGeneration, 'READ_CAPTURE_OUTPUT_CHANGED');
  return {...result(dir, expected.size), status: 'read-capture-code-verified', codeVerified: true};
}
export function main(args = process.argv.slice(2)) {
  if (args[0] === 'verify' && args.length === 2) return verifyReadCapture(args[1]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--apply' && options.apply === undefined) options.apply = true;
    else if (['--reference', '--timestamp-policy', '--output'].includes(name) && options[name] === undefined && args[i + 1]) options[name] = args[++i];
    else throw Error('READ_CAPTURE_INVALID_ARGUMENTS');
  }
  return prepareReadCapture({reference: options['--reference'], timestampPolicy: options['--timestamp-policy'], output: options['--output'], apply: options.apply === true});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(JSON.stringify(main()) + '\n');}
  catch (error) {
    process.stderr.write((/^READ_CAPTURE_[A-Z_]+$/.test(error.message) ? error.message : 'READ_CAPTURE_PREPARATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
