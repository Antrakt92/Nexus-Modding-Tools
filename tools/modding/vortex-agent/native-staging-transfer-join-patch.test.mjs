import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('staging-transfer-join.json', base)));
const patch = fs.readFileSync(new URL('staging-transfer-join.patch', base), 'utf8');
const collisionManifest = JSON.parse(fs.readFileSync(new URL('staging-transfer-collision.json', base)));
const collisionPatch = fs.readFileSync(new URL('staging-transfer-collision.patch', base), 'utf8');
const cleanupManifest = JSON.parse(fs.readFileSync(new URL('staging-cleanup-error.json', base)));
const cleanupPatch = fs.readFileSync(new URL('staging-cleanup-error.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: ['VORTEX_NATIVE_TRANSFER_PATH','VORTEX_BLUEBIRD_ROOT','VORTEX_NATIVE_TURBOWALK_ROOT'].every(k => process.env[k])
    ? false : 'Provide independently pinned transferPath, Bluebird and turbowalk sources'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
async function until(predicate) {
  for (let n = 0; n < 100; n++) {if (predicate()) return; await tick();}
  assert.fail('Owned fixture did not reach bounded phase');
}
function observe(promise) {
  const state = {settled: false, failed: false, error: undefined};
  state.done = promise.then(() => {state.settled = true;}, error => {
    state.settled = state.failed = true; state.error = error;
  }); return state;
}
function ordinary(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    assert(!fs.lstatSync(p).isSymbolicLink()); if (p === path.dirname(p)) break;
  }
}
function bluebird() {
  const root = process.env.VORTEX_BLUEBIRD_ROOT; ordinary(root);
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE-PINS.json')));
  const rows = pins.files.map(({file,bytes,sha256}) => ({file,bytes,sha256})).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert.equal(rows.length, 39);
  assert.equal(hash(JSON.stringify(rows)), 'a1279d5bda68eae7063b8d282f9c4665f15039dbd20b66826d4eb9cb3f2ff1a8');
  for (const row of rows) {
    assert(/^(?:LICENSE|package\.json|js\/release\/[a-z0-9_]+\.js)$/.test(row.file));
    const target = path.join(root,row.file); ordinary(target);
    const bytes = fs.readFileSync(target); assert.equal(bytes.length,row.bytes); assert.equal(hash(bytes),row.sha256);
  }
  return require(path.join(root,'js/release/bluebird.js')).getNewLibraryCopy();
}
function fixture({baseline = false, collision = false, cleanup = false, copy, link, ensure, stat, remove, progress,
  nodeCopy, logFailure, nested = false, sameVolume = false} = {}) {
  const original = fs.readFileSync(process.env.VORTEX_NATIVE_TRANSFER_PATH, 'utf8');
  assert.equal(hash(original), manifest.inputSHA256);
  const changed = applyExact(original, patch, manifest.upstreamPath); assert.equal(hash(changed),manifest.outputSHA256);
  assert.equal(hash(changed),collisionManifest.inputSHA256);
  const protectedSource = applyExact(changed,collisionPatch,collisionManifest.upstreamPath);
  assert.equal(hash(protectedSource),collisionManifest.outputSHA256);
  const cleanupSource = applyExact(protectedSource,cleanupPatch,cleanupManifest.upstreamPath);
  assert.equal(hash(cleanupSource),cleanupManifest.outputSHA256);
  const BB = bluebird(), calls = []; BB.config({warnings: false});
  class UserCanceled extends Error {}
  class ProcessCanceled extends Error {}
  class CleanupFailedException extends Error {
    constructor(error) {super('Cleanup process has failed'); this.name = 'CleanupFailedException'; this.errorObject = error;}
  }
  let nativeProgress, nativeFinish;
  const walkRoot = process.env.VORTEX_NATIVE_TURBOWALK_ROOT; ordinary(walkRoot);
  const walkCode = fs.readFileSync(path.join(walkRoot,'index.js'),'utf8');
  assert.equal(hash(walkCode),'af122d4220b525f727a6e20cffd777f48dc5089f29d37812db086b354e56789b');
  const mod = {exports: {}};
  // Execute the exact installed JS walker; only its native WalkDir binding is
  // an owned facade. No filesystem traversal or native addon is invoked.
  vm.runInNewContext(walkCode, {module: mod, process: {platform: 'win32'}, Error,
    require: name => name === 'bluebird' ? BB : name === 'path' ? path.win32 : name === 'winapi-bindings'
      ? {WalkDir: (_root, onProgress, _options, onFinish) => {calls.push(['walk']); nativeProgress = onProgress; nativeFinish = onFinish;}}
      : assert.fail('Unexpected walker import')}, {timeout: 1000});
  const source = 'F:\\own-source', dest = nested ? source+'\\new' : 'F:\\own-dest';
  const environment = {PromiseBB: BB, path: path.win32, turbowalk: mod.exports.default,
    nodeFs: {constants: {COPYFILE_EXCL: 1}, copyFile: (from,to,flags,callback) => {
      calls.push(['copy',from,to,{exclusive:flags}]);
      if (nodeCopy) return nodeCopy(from,to,flags,callback);
      BB.resolve(copy?.(from,to)).then(() => callback(null),callback);
    }},
    UserCanceled, ProcessCanceled, CleanupFailedException, log: () => {if (logFailure) throw logFailure;},
    getErrorCode: error => error?.code, unknownToError: error => error instanceof Error ? error : Error(String(error)),
    getNormalizeFunc: () => BB.resolve(value => value.toLowerCase()),
    isChildPath: (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase()+'\\'),
    STAGING_DIR_TAG: 'staging.tag', DOWNLOADS_DIR_TAG: 'downloads.tag',
    fs: {
      statAsync: target => {calls.push(['stat',target]); return BB.resolve(stat ? stat(target) : {dev: sameVolume || target === source ? 1 : 2});},
      copyAsync: (...args) => {calls.push(['copy',...args]); return BB.resolve(copy?.(...args));},
      linkAsync: (...args) => {calls.push(['link',...args]); return BB.resolve(link?.(...args));},
      ensureDirAsync: target => {calls.push(['ensure',target]); return BB.resolve(ensure?.(target));},
      ensureDirWritableAsync: target => {calls.push(['directory',target]); return BB.resolve(ensure?.(target));},
      removeAsync: target => {calls.push(['remove',target]); return BB.resolve(remove?.(target));},
    },
  };
  const code = stripTypeScriptTypes(baseline ? original : cleanup ? cleanupSource : collision ? protectedSource : changed,{mode:'transform'})
    .replace(/^import[\s\S]*?;\n/gm,'').replace(/^export /gm,'');
  const h = vm.runInNewContext(code+'\n({transferPath});',environment,{timeout:1000});
  const run = () => observe(h.transferPath(source,dest,(...args) => {calls.push(['progress',...args]); progress?.(...args);}));
  const file = name => ({filePath: source+'\\'+name,isDirectory:false});
  return {calls,run,file,source,dest,UserCanceled,emit: entries => nativeProgress(entries),finish: error => nativeFinish(error ?? null)};
}

test('staging transfer patch pins original source and keeps native guarantees disabled', () => {
  assert.equal(manifest.originalSourceSHA256,'ee41c5b132fa207d00f746133e35d74f9a5811e0aa36a1ec86857b20a7a50513');
  assert.equal(hash(patch),manifest.patchSHA256); assert.equal(manifest.preparedOnly,true);
  for (const key of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','noReplacementGuarantee','installationPermit']) assert.equal(manifest[key],false);
  for (const h of hunks(patch,manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1),/[ \t]$/);
});

integration('baseline copy failure settles early; patched transfer joins sibling and walker before rejecting', async () => {
  for (const baseline of [true,false]) {
    const a = deferred(), b = deferred(), primary = Error('own copy failure');
    const f = fixture({baseline,copy: from => from.endsWith('a') ? a.promise : b.promise});
    const state = f.run(); await until(() => f.calls.some(row => row[0] === 'walk'));
    f.emit([f.file('a'),f.file('b')]); await until(() => f.calls.filter(row => row[0] === 'copy').length === 2);
    a.reject(primary); await tick(); f.finish(); await tick(); await tick();
    assert.equal(state.settled,baseline); assert(!f.calls.some(row => row[0] === 'remove'));
    b.resolve(); await state.done; assert(state.failed); assert.equal(state.error,primary);
  }
});

integration('cancellation never replaces the pending chain or permits a later batch/source cleanup', async () => {
  const a = deferred(), b = deferred();
  const f = fixture({copy: from => from.endsWith('a') ? a.promise : b.promise}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a'),f.file('b')]);
  await until(() => f.calls.filter(row => row[0] === 'copy').length === 2);
  const primary = new f.UserCanceled('own cancellation'); a.reject(primary); await tick();
  f.emit([f.file('later')]); await tick(); assert(!state.settled);
  b.resolve(); await tick(); assert(!state.settled,'native walker completion remains necessary');
  f.finish(); await state.done; assert.equal(state.error,primary);
  assert.equal(f.calls.filter(row => row[0] === 'copy').length,2);
  assert(!f.calls.some(row => ['remove','progress'].includes(row[0])));
});

integration('walker rejection waits for every already-started copy and blocks cleanup', async () => {
  const copy = deferred(),primary = Error('own walk failure'),f = fixture({copy: () => copy.promise}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]);
  await until(() => f.calls.some(row => row[0] === 'copy')); f.finish(primary); await tick(); assert(!state.settled);
  copy.resolve(); await state.done; assert.equal(state.error,primary); assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('progress failure is latched while other copies and native traversal remain observed', async () => {
  const a = deferred(),b = deferred(),primary = Error('own progress failure');
  const f = fixture({copy: from => from.endsWith('a') ? a.promise : b.promise,progress: () => {throw primary;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a'),f.file('b')]);
  await until(() => f.calls.filter(row => row[0] === 'copy').length === 2); a.resolve(); await tick();
  assert(!state.settled); f.emit([f.file('later')]); b.resolve(); await tick(); assert(!state.settled);
  f.finish(); await state.done; assert.equal(state.error,primary); assert.equal(f.calls.filter(row => row[0] === 'progress').length,1);
  assert.equal(f.calls.filter(row => row[0] === 'copy').length,2);
});

integration('a nonthrowing progress adapter preserves observation of native onFinish on malformed batches', async () => {
  const f = fixture(),state = f.run(); await until(() => f.calls.some(row => row[0] === 'walk'));
  assert.doesNotThrow(() => f.emit(null)); await tick(); assert(!state.settled);
  f.finish(); await state.done; assert(state.failed); assert(!f.calls.some(row => row[0] === 'copy'));
});

integration('fallback copy is not newly launched after another operation has failed', async () => {
  const a = deferred(),b = deferred(),primary = Error('own link failure');
  const f = fixture({sameVolume:true,link: from => from.endsWith('a') ? a.promise : b.promise}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a'),f.file('b')]);
  await until(() => f.calls.filter(row => row[0] === 'link').length === 2); a.reject(primary); await tick();
  b.reject(Object.assign(Error('unsupported'),{code:'ENOTSUP'})); f.finish(); await state.done;
  assert.equal(state.error,primary); assert(!f.calls.some(row => row[0] === 'copy'));
});

integration('ordinary success and cross-volume fallback keep source cleanup after the complete walk', async () => {
  for (const sameVolume of [false,true]) {
    const f = fixture({sameVolume,link: () => Promise.reject(Object.assign(Error('unsupported'),{code:'EXDEV'}))}),state = f.run();
    await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]);
    await until(() => f.calls.some(row => row[0] === 'progress')); assert(!f.calls.some(row => row[0] === 'remove'));
    f.finish(); await state.done; assert(!state.failed); assert(f.calls.some(row => row[0] === 'copy'));
    assert.equal(f.calls.filter(row => row[0] === 'remove').length,1);
  }
});

integration('initial stat failure joins its sibling and never launches the walker', async () => {
  const a = deferred(),b = deferred(),primary = Error('own stat failure');
  const f = fixture({stat: target => target.endsWith('own-source') ? a.promise : b.promise}),state = f.run();
  await until(() => f.calls.filter(row => row[0] === 'stat').length === 2); a.reject(primary); await tick(); assert(!state.settled);
  b.resolve({dev:2}); await state.done; assert.equal(state.error,primary); assert(!f.calls.some(row => row[0] === 'walk'));
});

integration('directory failure refuses file copies and cleanup while preserving the first raw failure', async () => {
  const f = fixture({ensure: () => Promise.reject(undefined)}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk'));
  f.emit([{filePath:f.source+'\\dir',isDirectory:true},f.file('a')]); await tick(); f.finish(); await state.done;
  assert(state.failed); assert.equal(state.error,undefined);
  assert(!f.calls.some(row => ['copy','remove'].includes(row[0])));
});

integration('nested tag cleanup waits for both removals before reporting its original cleanup failure', async () => {
  const a = deferred(),b = deferred(),primary = Error('own tag failure');
  const f = fixture({nested:true,remove: target => target.endsWith('staging.tag') ? a.promise : b.promise}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.finish();
  await until(() => f.calls.filter(row => row[0] === 'remove').length === 2);
  a.reject(primary); await tick(); assert(!state.settled);
  b.resolve(); await state.done; assert(state.failed); assert.equal(state.error.errorObject,primary);
});

integration('same-volume existing links and missing files preserve the original merge semantics', async () => {
  const f = fixture({sameVolume:true,link: from => Promise.reject(Object.assign(Error('own existing or absent'),
    {code:from.endsWith('a') ? 'EEXIST' : 'ENOENT'}))}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a'),f.file('b')]); f.finish();
  await state.done; assert(!state.failed); assert(!f.calls.some(row => row[0] === 'copy'));
  assert.equal(f.calls.filter(row => row[0] === 'remove').length,1);
});

integration('synchronous copy startup failure remains held until the native walker finishes', async () => {
  const primary = Error('own sync startup'), f = fixture({copy: () => {throw primary;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]);
  await until(() => f.calls.some(row => row[0] === 'copy')); await tick(); assert(!state.settled);
  f.emit([f.file('later')]); f.finish(); await state.done; assert.equal(state.error,primary);
  assert.equal(f.calls.filter(row => row[0] === 'copy').length,1);
  assert(!f.calls.some(row => row[0] === 'remove'));
});

test('collision policy is a separate sequential patch and leaves the joined artifact immutable', () => {
  assert.equal(hash(patch),'76d9dc361b4a063a3a915dea5e0d0a0669675770fa0594fcf8006d2efc47c45e');
  assert.equal(collisionManifest.prerequisitePatchSHA256,manifest.patchSHA256);
  assert.equal(hash(collisionPatch),collisionManifest.patchSHA256);
  assert.equal(collisionManifest.preparedOnly,true);
  assert.equal(collisionManifest.ownerReservationGuarantee,false);
});

integration('joined baseline silently loses a colliding source; collision patch preserves both contents', async () => {
  for (const collision of [false,true]) {
    let sourceBytes = 'own original',destBytes = 'foreign destination';
    const primary = Object.assign(Error('own collision'),{code:'EEXIST'});
    const f = fixture({collision,sameVolume:true,link: () => Promise.reject(primary),
      remove: () => {sourceBytes = null;}}),state = f.run();
    await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]); f.finish();
    await state.done; assert.equal(state.failed,collision);
    assert.equal(sourceBytes,collision ? 'own original' : null);
    assert.equal(destBytes,'foreign destination');
    if (collision) {assert.equal(state.error,primary);assert(!f.calls.some(row => ['copy','remove'].includes(row[0])));}
  }
});

integration('initial cross-volume copy rejects existing destination with actual COPYFILE_EXCL mode', async () => {
  let sourceBytes = 'own original',destBytes = 'foreign destination';
  const primary = Object.assign(Error('own native collision'),{code:'EEXIST'});
  const f = fixture({collision:true,nodeCopy: (_from,_to,flags,callback) => {
    assert.equal(flags,1); callback(primary);
  },remove: () => {sourceBytes = null;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]); f.finish(); await state.done;
  assert.equal(state.error,primary);assert.equal(sourceBytes,'own original');assert.equal(destBytes,'foreign destination');
  assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('fallback and subsequent copies use EXCL and join their native callback before cleanup', async () => {
  const callbacks = [], f = fixture({collision:true,sameVolume:true,
    link: () => Promise.reject(Object.assign(Error('own fallback'),{code:'EXDEV'})),
    nodeCopy: (_from,_to,flags,callback) => {assert.equal(flags,1);callbacks.push(callback);}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]);
  await until(() => callbacks.length === 1); assert(!state.settled);callbacks[0](null);
  await until(() => f.calls.some(row => row[0] === 'progress'));f.emit([f.file('b')]);f.finish();
  await until(() => callbacks.length === 2);assert(!state.settled);assert(!f.calls.some(row => row[0] === 'remove'));
  callbacks[1](null);await state.done;assert(!state.failed);
  assert.equal(f.calls.filter(row => row[0] === 'copy').length,2);
  assert.equal(f.calls.filter(row => row[0] === 'link').length,1);
});

integration('a latched sibling failure stops a pending parent-ensure from starting exclusive copy', async () => {
  const a = deferred(),b = deferred(),callbacks = [],primary = Error('own copy failure');
  let ensures = 0;
  const f = fixture({collision:true,ensure: () => (++ensures === 1 ? a.promise : b.promise),
    nodeCopy: (_from,_to,_flags,callback) => callbacks.push(callback)}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk'));f.emit([f.file('a'),f.file('b')]);
  await until(() => ensures === 2);a.resolve();await until(() => callbacks.length === 1);
  callbacks[0](primary);b.resolve();f.finish();await state.done;
  assert.equal(state.error,primary);assert.equal(callbacks.length,1);assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('fallback collision rejects instead of overwriting and preserves every source', async () => {
  const primary = Object.assign(Error('own fallback collision'),{code:'EEXIST'});
  let sourcePresent = true, destination = 'foreign data';
  const f = fixture({collision:true,sameVolume:true,
    link: () => Promise.reject(Object.assign(Error('unsupported'),{code:'EXDEV'})),
    nodeCopy: (_from,_to,flags,callback) => {assert.equal(flags,1);callback(primary);},
    remove: () => {sourcePresent = false;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk'));f.emit([f.file('a')]);f.finish();await state.done;
  assert.equal(state.error,primary);assert(sourcePresent);assert.equal(destination,'foreign data');
  assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('a later colliding copy does not remove the source after an earlier successful copy', async () => {
  const primary = Object.assign(Error('own later collision'),{code:'EEXIST'});
  const outputs = new Map([['b','foreign data']]);let sourcePresent = true;
  const f = fixture({collision:true,nodeCopy: (from,_to,flags,callback) => {
    assert.equal(flags,1);const name = path.win32.basename(from);
    if (outputs.has(name)) callback(primary);
    else {outputs.set(name,'own copied data');callback(null);}
  },remove: () => {sourcePresent = false;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk'));f.emit([f.file('a')]);
  await until(() => f.calls.some(row => row[0] === 'progress'));f.emit([f.file('b')]);f.finish();await state.done;
  assert.equal(state.error,primary);assert(sourcePresent);assert.equal(outputs.get('b'),'foreign data');
  assert.equal(outputs.get('a'),'own copied data');assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('synchronous Node copy startup throws preserve failure and still join native traversal', async () => {
  const primary = Error('own native startup');
  const f = fixture({collision:true,nodeCopy: () => {throw primary;}}),state = f.run();
  await until(() => f.calls.some(row => row[0] === 'walk'));f.emit([f.file('a')]);
  await until(() => f.calls.some(row => row[0] === 'copy'));await tick();assert(!state.settled);
  f.finish();await state.done;assert.equal(state.error,primary);
  assert(!f.calls.some(row => row[0] === 'remove'));
});

integration('failed sibling prevents a hardlink after its already-started parent ensure settles', async () => {
  for (const collision of [false,true]) {
    const first = deferred(),parent = deferred(),primary = Error('own first hardlink failure');
    const f = fixture({collision,sameVolume:true,
      ensure: target => target.endsWith('second') ? parent.promise : undefined,
      link: () => first.promise}),state = f.run();
    await until(() => f.calls.some(row => row[0] === 'walk'));
    f.emit([f.file('first/a'),f.file('second/b')]);
    await until(() => f.calls.filter(row => row[0] === 'ensure').length === 2
      && f.calls.filter(row => row[0] === 'link').length === 1);
    first.reject(primary);
    await until(() => f.calls.find(row => row[0] === 'link')[3].showDialogCallback() === false);
    f.finish();await tick();assert(!state.settled,'already-started parent ensure must still be joined');
    parent.resolve();await state.done;assert.equal(state.error,primary);
    assert.equal(f.calls.filter(row => row[0] === 'link').length,collision ? 1 : 2);
    assert(!f.calls.some(row => ['copy','remove'].includes(row[0])));
  }
});

test('cleanup diagnostic repair is a separate patch after the unchanged collision packet', () => {
  assert.equal(collisionManifest.patchSHA256,'f506444715fc503fb7d3cb6faa44b4bdb6bdc5517982966ae26f4a9069f35cca');
  assert.equal(cleanupManifest.prerequisitePatchSHA256,collisionManifest.patchSHA256);
  assert.equal(cleanupManifest.inputSHA256,collisionManifest.outputSHA256);
  assert.equal(hash(cleanupPatch),cleanupManifest.patchSHA256);
  assert.equal(cleanupManifest.preparedOnly,true); assert.equal(cleanupManifest.nativeAcceptanceVerified,false);
  for (const h of hunks(cleanupPatch,cleanupManifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1),/[ \t]$/);
});

integration('baseline logger masks source-cleanup failure; repair preserves CleanupFailedException.errorObject', async () => {
  for (const cleanup of [false,true]) {
    const primary = Error('own source cleanup failure'),diagnostic = Error('own logger failure');
    const f = fixture({collision:true,cleanup,remove: () => Promise.reject(primary),logFailure:diagnostic}),state = f.run();
    await until(() => f.calls.some(row => row[0] === 'walk')); f.emit([f.file('a')]); f.finish();await state.done;
    assert(state.failed); assert.equal(f.calls.filter(row => row[0] === 'copy').length,1);
    assert.equal(f.calls.filter(row => row[0] === 'remove').length,1);
    if (cleanup) {assert.equal(state.error.name,'CleanupFailedException');assert.equal(state.error.errorObject,primary);}
    else assert.equal(state.error,diagnostic);
  }
});
