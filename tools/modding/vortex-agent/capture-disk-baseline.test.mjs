import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {captureDiskBaseline, LIMITS} from './capture-disk-baseline.mjs';

const scratch = fileURLToPath(new URL('../../../local-state/', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const node = file => {const s = fs.statSync(file, {bigint: true}); return `${s.dev}:${s.ino}`;};
const norm = file => path.resolve(file).replace(/\\/g, '/').toLowerCase();
function parents(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
    if (current === path.dirname(current)) return;
  }
}
function write(file, value) {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value);}
function fixture() {
  parents(scratch); fs.mkdirSync(scratch, {recursive: true});
  const root = fs.mkdtempSync(path.join(scratch, 'disk-baseline-test-'));
  const game = path.join(root, 'game'), stage = path.join(root, 'stage'), downloads = path.join(root, 'downloads');
  for (const dir of [game, stage, downloads]) fs.mkdirSync(dir);
  const relative = 'archive/pc/mod/own.archive', staged = path.join(stage, 'Owner', relative), deployed = path.join(game, relative);
  const payload = Buffer.from('own payload '.repeat(500)); write(staged, payload); fs.mkdirSync(path.dirname(deployed), {recursive: true}); fs.linkSync(staged, deployed);
  const cet = path.join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/Own/config.json');
  const red = path.join(game, 'red4ext/plugins/Own/settings.ini'), explicit = path.join(stage, 'Owner/sorting.txt');
  write(cet, '{"own":true}'); write(red, 'own=1'); write(explicit, 'sorting=1');
  const manifestPath = path.join(game, 'vortex.deployment.json');
  const manifest = {gameId: 'cyberpunk2077', deploymentMethod: 'hardlink_activator', targetPath: game, stagingPath: stage,
    files: [{relPath: relative, source: 'Owner', target: ''}]};
  const input = path.join(root, 'INPUT.json');
  const value = {schema: 'read-capture-disk-input/1', observedAtUTC: new Date().toISOString(),
    health: {gameId: 'cyberpunk2077', profileId: 'ptndev1016', gamePath: game, stagingPath: stage, downloadPath: downloads,
      filesystemIds: {gamePath: node(game), stagingPath: node(stage), downloadPath: node(downloads)}},
    manifestSHA256: '', preferenceCandidates: [explicit]};
  const output = path.join(root, 'out');
  const refresh = () => {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest)); value.manifestSHA256 = hash(fs.readFileSync(manifestPath));
    fs.writeFileSync(input, JSON.stringify(value));
    return {input, inputSHA256: hash(fs.readFileSync(input)), output};
  };
  return {root, game, stage, downloads, staged, deployed, payload, cet, red, explicit, manifestPath, manifest,
    value, input, output, refresh, options: refresh()};
}
function duringRead(f, effect, fn) {
  const originalOpen = fs.openSync, originalRead = fs.readSync; const owned = new Set(); let done = false;
  try {
    fs.openSync = (file, ...args) => {const fd = originalOpen(file, ...args); if (norm(file) === norm(f.deployed)) owned.add(fd); return fd;};
    fs.readSync = (fd, ...args) => {const n = originalRead(fd, ...args); if (owned.has(fd) && n > 0 && !done) {done = true; effect();} return n;};
    fn(); assert.equal(done, true, 'must reach the actual payload FD');
  } finally {fs.openSync = originalOpen; fs.readSync = originalRead;}
}

test('dry plan performs metadata validation without payload reads or output', () => {
  const f = fixture(), original = fs.openSync;
  try {
    fs.openSync = (file, ...args) => {assert.notEqual(norm(file), norm(f.deployed)); assert.notEqual(norm(file), norm(f.staged)); return original(file, ...args);};
    const result = captureDiskBaseline(f.options);
    assert.equal(result.status, 'plan'); assert.equal(result.manifestPairs, 1); assert.equal(result.settings, 3);
    assert.equal(result.effectsAllowed, false); assert.equal(result.nativeContextVerified, false);
    assert.equal(fs.existsSync(f.output), false);
  } finally {fs.openSync = original;}
});

test('apply hashes bounded FDs, shares hardlink hashes and emits the exact consumer schema', () => {
  const f = fixture(), result = captureDiskBaseline({...f.options, apply: true});
  const ledger = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(hash(fs.readFileSync(result.file)), result.sha256);
  assert.equal(ledger.schema, 'root-current-physical-ledger/1');
  assert.equal(ledger.records[0].sha256, hash(f.payload)); assert.equal(ledger.records[0].nodeId, node(f.deployed));
  assert.equal(ledger.records[0].bytes, f.payload.length); assert.ok(ledger.records[0].links >= 2);
  assert.equal(ledger.settings.length, 3); assert.equal(ledger.settings.every(r => typeof r.bytes === 'number'), true);
  assert.equal(ledger.physicalProofMetrics.hashes, result.uniquePhysicalFiles);
  assert.ok(ledger.physicalProofMetrics.cacheHits >= 1);
  assert.equal(ledger.physicalProofMetrics.bytesHashed, result.plannedBytesHashed);
  assert.deepEqual(ledger.preferenceDiscovery, {schema: 'read-capture-preference-discovery/1',
    roots: [path.join(f.game, 'bin/x64/plugins/cyber_engine_tweaks/mods'), path.join(f.game, 'red4ext/plugins')],
    extensions: ['.db','.ini','.json','.sqlite3'], files: [norm(f.cet), norm(f.red)].sort(), excludedLogLinks: []});
  assert.equal(ledger.sourceProofSHA256, f.options.inputSHA256); assert.equal(ledger.noManagedWrites, true);
  assert.equal(ledger.sourceAdmissionVerified, false); assert.equal(ledger.effectsAllowed, false);
  assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_NEW_OUTPUT_REQUIRED/);
});

test('required explicit prefs include stage configs and only two closed LocalAppData settings', () => {
  const f = fixture(), old = process.env.LOCALAPPDATA;
  const local = path.join(f.root, 'local');
  try {
    process.env.LOCALAPPDATA = local;
    const a = path.join(local, 'CD Projekt Red/Cyberpunk 2077/UserSettings.json'), b = path.join(local, 'CleanInventory/sorting-v1.txt');
    write(a, '{}'); write(b, 'own sorting'); f.value.preferenceCandidates.push(a, b);
    const result = captureDiskBaseline({...f.refresh(), apply: true});
    const ledger = JSON.parse(fs.readFileSync(result.file));
    assert.equal(ledger.settings.length, 5);
    assert.ok(ledger.settings.some(row => row.path === b));
  } finally {if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old;}
});

test('stale, unknown, wrong profile, wrong root ID and duplicate inputs refuse before output', () => {
  for (const kind of ['stale','unknown','profile','root','duplicate']) {
    const f = fixture();
    if (kind === 'stale') f.value.observedAtUTC = new Date(Date.now() - LIMITS.freshnessMs - 1000).toISOString();
    if (kind === 'unknown') f.value.approved = true;
    if (kind === 'profile') f.value.health.profileId = 'other';
    if (kind === 'root') f.value.health.filesystemIds.stagingPath = '1:2';
    if (kind === 'duplicate') f.value.preferenceCandidates.push(f.explicit);
    assert.throws(() => captureDiskBaseline({...f.refresh(), apply: true}), /DISK_BASELINE_/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('duplicate JSON keys, wrong raw SHA and unbounded preference scope cannot admit a ledger', () => {
  const f = fixture();
  assert.throws(() => captureDiskBaseline({...f.options, inputSHA256: '0'.repeat(64)}), /DISK_BASELINE_INPUT_SHA_DIFFERS/);
  const foreign = path.join(f.root, 'unrelated.json'); write(foreign, '{}'); f.value.preferenceCandidates.push(foreign);
  assert.throws(() => captureDiskBaseline(f.refresh()), /DISK_BASELINE_PREFERENCE_SCOPE_REFUSED/);
  fs.writeFileSync(f.input, fs.readFileSync(f.input, 'utf8').replace('{', '{"schema":"read-capture-disk-input/1",'));
  assert.throws(() => captureDiskBaseline({...f.options, inputSHA256: hash(fs.readFileSync(f.input))}));
});

test('missing required preference is a refusal rather than silently reduced coverage', () => {
  const f = fixture(); fs.unlinkSync(f.explicit);
  assert.throws(() => captureDiskBaseline({...f.options, apply: true}));
  assert.equal(fs.existsSync(f.output), false);
});

test('custom targets, traversal, Windows aliases, duplicate paths and non-hardlinks refuse', () => {
  for (const kind of ['target','traversal','dot','device','duplicate','copy']) {
    const f = fixture();
    if (kind === 'target') f.manifest.files[0].target = 'elsewhere';
    if (kind === 'traversal') f.manifest.files[0].relPath = '../outside';
    if (kind === 'dot') f.manifest.files[0].relPath = 'trailing./x';
    if (kind === 'device') f.manifest.files[0].relPath = 'CONIN$/x';
    if (kind === 'duplicate') f.manifest.files.push({...f.manifest.files[0]});
    if (kind === 'copy') {fs.unlinkSync(f.deployed); fs.writeFileSync(f.deployed, f.payload);}
    assert.throws(() => captureDiskBaseline({...f.refresh(), apply: true}), /DISK_BASELINE_/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('default target permits only absent or empty string, never malformed falsy or object values', () => {
  for (const target of [false, 0, null, {}, []]) {
    const f = fixture(); f.manifest.files[0].target = target;
    assert.throws(() => captureDiskBaseline(f.refresh()), /DISK_BASELINE_CUSTOM_TARGET_REFUSED/);
    assert.equal(fs.existsSync(f.output), false);
  }
  const omitted = fixture(); delete omitted.manifest.files[0].target;
  assert.equal(captureDiskBaseline(omitted.refresh()).status, 'plan');
});

test('current supported manifest must explicitly name the expected game even with identical root paths', () => {
  for (const gameId of ['other-game', undefined, null, 0]) {
    const f = fixture(); f.manifest.gameId = gameId;
    assert.throws(() => captureDiskBaseline(f.refresh()), /DISK_BASELINE_MANIFEST_REFUSED/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('new preference during hashing is found by final discovery', () => {
  const f = fixture();
  duringRead(f, () => write(path.join(path.dirname(f.cet), 'new.json'), '{}'), () => {
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_DISCOVERY_CHANGED/);
  });
  assert.equal(fs.existsSync(f.output), false);
});

test('manifest or explicit preference changes during hashing cannot publish the baseline', () => {
  for (const kind of ['manifest','preference']) {
    const f = fixture();
    duringRead(f, () => fs.appendFileSync(kind === 'manifest' ? f.manifestPath : f.explicit, '\n'), () => {
      assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_FILE_CHANGED/);
    });
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('actual source swap between path observation and FD open is refused before hashing replacement', () => {
  const f = fixture(), original = fs.openSync; let swapped = false;
  try {
    fs.openSync = (file, ...args) => {
      if (!swapped && norm(file) === norm(f.deployed)) {
        swapped = true; fs.unlinkSync(f.deployed); fs.writeFileSync(f.deployed, f.payload);
      }
      return original(file, ...args);
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_FD_CHANGED/);
  } finally {fs.openSync = original;}
  assert.equal(swapped, true); assert.equal(fs.existsSync(f.output), false);
  assert.equal(hash(fs.readFileSync(f.staged)), hash(f.payload));
});

test('actual writes and new hardlink aliases during FD hashing invalidate the checkpoint', () => {
  for (const kind of ['write','link']) {
    const f = fixture();
    duringRead(f, () => kind === 'write' ? fs.appendFileSync(f.staged, 'changed') : fs.linkSync(f.staged, path.join(f.stage, 'alias.bin')), () => {
      assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_|PHYSICAL_PROOF_CHANGED/);
    });
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('context root replacement while hashing is not accepted as the original filesystem context', () => {
  const f = fixture();
  duringRead(f, () => {fs.renameSync(f.downloads, f.downloads + '-old'); fs.mkdirSync(f.downloads);}, () => {
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_PARENT_CHANGED|DISK_BASELINE_FILE_CHANGED/);
  });
  assert.equal(fs.existsSync(f.output), false);
});

test('reparse discovery and reparse output ancestors are refused without traversing them', () => {
  const f = fixture(), foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  const link = path.join(path.dirname(f.cet), 'linked'); fs.symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureDiskBaseline(f.options), /DISK_BASELINE_REPARSE_OR_PARENT/);
  const clean = fixture(), outLink = path.join(clean.root, 'linked'); fs.symlinkSync(foreign, outLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureDiskBaseline({...clean.options, output: path.join(outLink, 'out'), apply: true}), /DISK_BASELINE_REPARSE_OR_PARENT/);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('fixed candidate and manifest budgets refuse oversized metadata without huge disk files', () => {
  const a = fixture(); a.value.preferenceCandidates = Array(LIMITS.candidates + 1).fill(a.explicit);
  assert.throws(() => captureDiskBaseline(a.refresh()), /DISK_BASELINE_INVALID_CANDIDATES/);
  const b = fixture(); b.manifest.files = Array(LIMITS.pairs + 1).fill(b.manifest.files[0]);
  assert.throws(() => captureDiskBaseline(b.refresh()), /DISK_BASELINE_MANIFEST_REFUSED/);
});

test('a destination appearing immediately before mkdir is preserved, never overwritten or adopted', () => {
  const f = fixture(), original = fs.mkdirSync; let appeared = false;
  try {
    fs.mkdirSync = (dir, ...args) => {
      if (path.resolve(dir) === f.output && !appeared) {appeared = true; original(dir); fs.writeFileSync(path.join(dir, 'foreign'), 'keep');}
      return original(dir, ...args);
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), error => error.code === 'EEXIST');
  } finally {fs.mkdirSync = original;}
  assert.equal(appeared, true); assert.deepEqual(fs.readdirSync(f.output), ['foreign']);
});

test('partial write is retained and cannot be overwritten or automatically retried', () => {
  const f = fixture(), original = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, bytes, ...args) => {
      if (typeof file === 'number') {original(file, bytes.subarray(0, 10), ...args); throw Error('OWN_WRITE_FAILED');}
      return original(file, bytes, ...args);
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /OWN_WRITE_FAILED/);
  } finally {fs.writeFileSync = original;}
  assert.equal(fs.readFileSync(path.join(f.output, 'ROOT-DISK-BEFORE.json')).length, 10);
  assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_NEW_OUTPUT_REQUIRED/);
});

test('an identical-byte hardlink replacement of the output after close is not adopted', () => {
  const f = fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync;
  const file = path.join(f.output, 'ROOT-DISK-BEFORE.json'); let outputFD, changed = false;
  try {
    fs.openSync = (name, flags, ...args) => {
      const fd = originalOpen(name, flags, ...args);
      if (norm(name) === norm(file) && flags === 'wx') outputFD = fd;
      return fd;
    };
    fs.closeSync = fd => {
      const result = originalClose(fd);
      if (fd === outputFD && !changed) {
        changed = true; const alias = path.join(f.root, 'foreign-identical-ledger.json');
        fs.copyFileSync(file, alias); fs.unlinkSync(file); fs.linkSync(alias, file);
      }
      return result;
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_OUTPUT_CHANGED/);
  } finally {fs.openSync = originalOpen; fs.closeSync = originalClose;}
  assert.equal(changed, true); assert.ok(fs.statSync(file).nlink >= 2);
});

test('late output mutation during the final scan cannot receive a stale success SHA', () => {
  const f = fixture(), original = fs.opendirSync;
  const file = path.join(f.output, 'ROOT-DISK-BEFORE.json'); let changed = false;
  try {
    fs.opendirSync = (...args) => {
      if (fs.existsSync(file) && !changed) {changed = true; fs.appendFileSync(file, ' ');}
      return original(...args);
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_FILE_CHANGED/);
  } finally {fs.opendirSync = original;}
  assert.equal(changed, true); assert.equal(fs.readFileSync(file, 'utf8').endsWith(' '), true);
});

test('a reparse replacement immediately after output mkdir does not receive any baseline write', () => {
  const f = fixture(), original = fs.mkdirSync, foreign = path.join(f.root, 'foreign'); original(foreign);
  let changed = false;
  try {
    fs.mkdirSync = (name, ...args) => {
      const result = original(name, ...args);
      if (path.resolve(name) === f.output && !changed) {
        changed = true; fs.renameSync(name, name + '-owned');
        fs.symlinkSync(foreign, name, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return result;
    };
    assert.throws(() => captureDiskBaseline({...f.options, apply: true}), /DISK_BASELINE_OUTPUT_CHANGED/);
  } finally {fs.mkdirSync = original;}
  assert.equal(changed, true); assert.deepEqual(fs.readdirSync(foreign), []);
});

test('CLI errors are bounded fixed codes and do not expose paths or stack traces', () => {
  const f = fixture();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./capture-disk-baseline.mjs', import.meta.url)),
    '--input', path.join(f.root, 'missing-private-input.json'), '--input-sha256', '0'.repeat(64)], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /^DISK_BASELINE_[A-Z_]+\r?\n$/);
  assert.equal(child.stderr.includes(f.root), false);
});

function logLink(f, name = 'ArchiveXL', suffix = '.log') {
  const file = path.join(f.game, 'red4ext/plugins', name, name + suffix);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.symlinkSync(path.join(f.root, 'never-read-target'), file, 'file');
  const st = fs.lstatSync(file, {bigint:true});
  const pin = {path:file,nodeId:`${st.dev}:${st.ino}`,bytes:String(st.size),links:String(st.nlink),
    mtimeNs:String(st.mtimeNs),ctimeNs:String(st.ctimeNs),linkTextSHA256:hash(fs.readlinkSync(file,{encoding:'buffer'})),fileAttributes:1056};
  return {file,pin};
}
test('only exact independently pinned log links are excluded without following targets', () => {
  const f=fixture(), a=logLink(f), b=logLink(f,'Codeware'), c=logLink(f,'TweakXL');
  f.value.excludedLogLinks=[c.pin,a.pin,b.pin]; const opts=f.refresh(), original=fs.openSync;
  try {
    fs.openSync=(file,...args)=>{assert.ok(![a.file,b.file,c.file,path.join(f.root,'never-read-target')].map(norm).includes(norm(file)));return original(file,...args);};
    const result=captureDiskBaseline({...opts,apply:true}), ledger=JSON.parse(fs.readFileSync(result.file));
    assert.deepEqual(ledger.preferenceDiscovery.excludedLogLinks,[a.pin,b.pin,c.pin]);
    assert.equal(ledger.settings.length,3); assert.equal(ledger.nativeContextVerified,false);
  } finally {fs.openSync=original;}
});
test('unadmitted and JSON links remain held and do not create output', () => {
  for (const [name,suffix,pinned] of [['Unknown','.log',false],['ArchiveXL','.log',false],['ArchiveXL','.json',true]]) {
    const f=fixture(), link=logLink(f,name,suffix); if(pinned)f.value.excludedLogLinks=[link.pin];
    assert.throws(()=>captureDiskBaseline({...f.refresh(),apply:true}),/DISK_BASELINE_/); assert.equal(fs.existsSync(f.output),false);
  }
});
test('closed link pin types, attributes, duplicate and unused pins refuse', () => {
  for(const mutate of [p=>p.fileAttributes|=0x10,p=>p.fileAttributes=32,p=>p.links='2',p=>p.bytes=0,p=>p.extra=true,p=>p.nodeId='1:2',p=>p.linkTextSHA256='0'.repeat(64)]) {
    const f=fixture(), a=logLink(f); mutate(a.pin);f.value.excludedLogLinks=[a.pin];
    assert.throws(()=>captureDiskBaseline(f.refresh()),/DISK_BASELINE_/);
  }
  for(const mode of ['duplicate','missing','null']) {
    const f=fixture(), a=logLink(f);f.value.excludedLogLinks=mode==='duplicate'?[a.pin,a.pin]:mode==='null'?null:[a.pin];
    if(mode==='missing')fs.unlinkSync(a.file);
    assert.throws(()=>captureDiskBaseline(f.refresh()),/DISK_BASELINE_/);
  }
});
test('pinned log link retarget, disappearance and generation drift during payload reads hold', () => {
  for(const mode of ['retarget','missing','generation']) {
    const f=fixture(), a=logLink(f);f.value.excludedLogLinks=[a.pin];const opts=f.refresh();
    duringRead(f,()=>{
      if(mode==='generation')fs.lutimesSync(a.file,new Date(1000),new Date(1000));
      else {fs.unlinkSync(a.file);if(mode==='retarget')fs.symlinkSync(path.join(f.root,'another-never-read-target'),a.file,'file');}
    },()=>assert.throws(()=>captureDiskBaseline({...opts,apply:true}),/DISK_BASELINE_/));
    assert.equal(fs.existsSync(f.output),false);
  }
});
