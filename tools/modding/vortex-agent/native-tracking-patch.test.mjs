import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { hunks, applyExact, extractClassDeclaration } from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('ordinary-tracking.json', base), 'utf8'));
const patch = readFileSync(new URL('ordinary-tracking.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const upstreamPath = 'src/renderer/src/extensions/mod_management/InstallManager.ts';

test('prepared patch pins exact upstream and grants no installed/native guarantees', () => {
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/Vortex');
  assert.equal(manifest.upstreamTag, 'v2.9.1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, upstreamPath);
  assert.equal(manifest.inputSHA256, '577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33');
  assert.match(manifest.outputSHA256, /^[a-f0-9]{64}$/);
  assert.equal(hash(patch), manifest.patchSHA256);
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'noReplacementGuarantee',
    'importNoClobberGuarantee', 'ownerReservationGuarantee']) assert.equal(manifest[key], false);
  assert.equal(manifest.testSourceEnvironment, 'VORTEX_NATIVE_INSTALL_MANAGER');
  const parsed = hunks(patch, upstreamPath);
  assert.equal(parsed.length, 4);
  // Empty context lines must contain the unified-diff marker space; added
  // source lines still have to pass whitespace checks of their own.
  for (const hunk of parsed) for (const line of hunk.body) {
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  }
});

test('in-memory patch reader refuses drift, malformed counts and overlapping hunks', () => {
  const diff = '--- a/own.txt\n+++ b/own.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n';
  assert.equal(applyExact('alpha\nbeta\n', diff, 'own.txt'), 'alpha\ngamma\n');
  assert.throws(() => applyExact('alpha\nchanged\n', diff, 'own.txt'), /exact hunk context/);
  assert.throws(() => hunks(diff.replace('-1,2', '-1,3'), 'own.txt'));
  assert.throws(() => hunks(diff, '../own.txt'));
  assert.throws(() => applyExact('alpha\nbeta\n', diff + '@@ -1,1 +1,1 @@\n alpha\n', 'own.txt'), /overlap/);
});

const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {
  skip: sourcePath ? false : 'Set VORTEX_NATIVE_INSTALL_MANAGER to the pinned upstream InstallManager.ts',
  timeout: 10000,
}, fn);

function sources() {
  const raw = readFileSync(sourcePath);
  assert.equal(hash(raw), manifest.inputSHA256, 'exact raw upstream bytes required');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const patched = applyExact(source, patch, upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256);
  return { source, patched };
}

function fixture(source, ids = []) {
  // Transform types only, then evaluate only the original class declaration.
  // Imports, module-level code, constructor and installer operations never run.
  let classSource = extractClassDeclaration(source);
  const callbackAnchor = 'this.mActiveInstalls.delete(installId);\n        };';
  assert.equal(classSource.split(callbackAnchor).length, 2, 'unique test observation anchor');
  classSource = classSource.replace(callbackAnchor,
    callbackAnchor + '\n        this.__testTrackedCallbacks.push(trackedCallback);');
  let allocated = 0;
  const operations = [];
  const state = { persistent: { downloads: { files: {} }, mods: { ownGame: {} } } };
  const api = { getState: () => state };
  class ProcessCanceled extends Error {}
  const InstallManager = vm.runInNewContext(classSource + '\nInstallManager;', {
    path, shortid: () => ids.shift() ?? `id${++allocated}`, ProcessCanceled,
    getBatchContext: () => undefined,
    activeProfile: () => ({ id: 'ownProfile', gameId: 'ownGame' }),
    profileById: () => ({ id: 'ownProfile', gameId: 'ownGame' }),
    activeGameId: () => 'ownGame', downloadToModRef: () => ({}),
    getCollectionActiveSession: () => undefined,
    renderModReference: () => 'ownDependency', log: () => {},
  }, { timeout: 1000 });
  const manager = Object.create(InstallManager.prototype);
  Object.assign(manager, {
    mApi: api, mActiveInstalls: new Map(), mPendingInstalls: new Map(),
    mDependencyRetryCount: new Map(), mRecentChangedPaths: new Set(), __testTrackedCallbacks: [],
    mInstallLimit: { do: operation => { operations.push(operation); return new Promise(() => {}); } },
  });
  const callbacks = [];
  function install(archiveId, sourceModId, callback = (...args) => callbacks.push(args)) {
    manager.install(archiveId, 'own-package.zip', ['ownGame'], api, {}, false, false,
      callback, 'ownGame', undefined, false, undefined, false, sourceModId);
  }
  return { manager, api, state, operations, install, callbacks, ProcessCanceled };
}

integration('source-derived baseline reproduces ordinary tracking overwrite; patch separates jobs', () => {
  const { source, patched } = sources();
  for (const archiveId of [undefined, null, 'same-finished-download']) {
    const before = fixture(source);
    before.install(archiveId); before.install(archiveId);
    assert.equal(before.manager.getActiveInstallationCount(), 1, 'baseline collision reproduced');
    const after = fixture(patched);
    after.install(archiveId); after.install(archiveId);
    assert.equal(after.manager.getActiveInstallationCount(), 2);
    const rows = after.manager.getActiveInstallations();
    assert.notEqual(rows[0].installId, rows[1].installId);
    assert.equal(after.operations.length, 2);
    assert.ok(rows.every(row => !row.installId.includes(':')));
    assert.equal(after.manager.getActiveInstallation(rows[1].installId), rows[1]);
    after.manager.__testTrackedCallbacks[0](null, 'own-completed-mod');
    assert.equal(after.manager.isInstallationActive(rows[0].installId), false);
    assert.equal(after.manager.getActiveInstallation(rows[1].installId), rows[1]);
    after.manager.__testTrackedCallbacks[1](new Error('own test cancellation'), undefined);
    assert.equal(after.manager.getActiveInstallationCount(), 0);
    assert.equal(after.callbacks.length, 2);
    assert.equal(after.callbacks[0][1], 'own-completed-mod');
    assert.equal(after.manager.mRecentChangedPaths.has('own-completed-mod'), true);
  }
});

integration('forced shortid collision refuses before map overwrite or limiter admission', () => {
  const f = fixture(sources().patched, ['collision']);
  const existing = { installId: 'ordinary-collision', modId: 'previous', gameId: 'ownGame' };
  f.manager.mActiveInstalls.set(existing.installId, existing);
  f.install('new-download');
  assert.equal(f.manager.mActiveInstalls.size, 1);
  assert.equal(f.manager.getActiveInstallation(existing.installId), existing);
  assert.equal(f.operations.length, 0);
  assert.equal(f.callbacks.length, 1);
  assert.ok(f.callbacks[0][0] instanceof f.ProcessCanceled);
  assert.equal(f.callbacks[0][1], undefined);
  assert.equal(f.manager.__testTrackedCallbacks.length, 0);
});

integration('null source and different archives remain independent; unfinished download removes only itself', () => {
  const f = fixture(sources().patched);
  f.install('download-a', null);
  f.install('download-b', undefined);
  const rows = f.manager.getActiveInstallations();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].installId, rows[1].installId);
  f.state.persistent.downloads.files.incomplete = { state: 'paused' };
  f.install('incomplete');
  assert.equal(f.manager.getActiveInstallationCount(), 2);
  assert.equal(f.operations.length, 2, 'unfinished download never reaches installer limiter');
  assert.match(f.callbacks[0][0].message, /download not finished/);
  assert.equal(f.manager.getActiveInstallation(rows[0].installId), rows[0]);
  assert.equal(f.manager.getActiveInstallation(rows[1].installId), rows[1]);
  f.manager.__testTrackedCallbacks[1](new Error('own test cancellation'), undefined);
  assert.equal(f.manager.getActiveInstallation(rows[0].installId), rows[0]);
  assert.equal(f.manager.isInstallationActive(rows[1].installId), false);
});

integration('dependency composite tracking is retained; active cleanup uses exact source metadata', () => {
  const f = fixture(sources().patched);
  f.install('download', 'collection');
  f.install('download', 'other-collection');
  f.install('collection');
  assert.equal(f.manager.getActiveInstallation('collection:download').sourceModId, 'collection');
  assert.equal(f.manager.getActiveInstallation('other-collection:download').sourceModId, 'other-collection');
  const ordinary = f.manager.getActiveInstallations().find(row => row.sourceModId === undefined);
  f.manager.cleanupPendingInstalls('collection');
  assert.equal(f.manager.isInstallationActive('collection:download'), false);
  assert.equal(f.manager.isInstallationActive('other-collection:download'), true);
  assert.equal(f.manager.getActiveInstallation(ordinary.installId), ordinary);
  assert.equal(f.manager.generateDependencyInstallKey('collection', 'download'), 'collection:download');
  assert.equal(f.operations.length, 3);
});

integration('dependency queue continues to deduplicate active and pending composite entries', () => {
  const f = fixture(sources().patched);
  let starts = 0;
  f.manager.mPhaseTracker = { ensure: () => {}, get: () => ({}) };
  f.manager.startQueuedInstallation = () => { starts++; };
  f.install('download', 'collection');
  f.manager.queueInstallation(f.api, {}, 'download', 'ownGame', 'collection', false, 0);
  assert.equal(starts, 0);
  assert.equal(f.manager.mPendingInstalls.size, 0);
  f.manager.mActiveInstalls.clear();
  const pending = { reference: {} };
  f.manager.mPendingInstalls.set('collection:download', pending);
  f.manager.queueInstallation(f.api, {}, 'download', 'ownGame', 'collection', false, 0);
  assert.equal(starts, 0);
  assert.equal(f.manager.mPendingInstalls.get('collection:download'), pending);
  assert.equal(f.operations.length, 1, 'only explicit initial registration reached limiter');
});

integration('queued dependency placeholder retains composite key and explicit source metadata', async () => {
  const f = fixture(sources().patched);
  const tasks = [];
  const seen = [];
  const originalSet = f.manager.mActiveInstalls.set.bind(f.manager.mActiveInstalls);
  f.manager.mActiveInstalls.set = (key, value) => { seen.push({ key, value }); return originalSet(key, value); };
  f.manager.mPhaseTracker = { get: () => ({ activeByPhase: new Map() }) };
  f.manager.mDependencyPipelineLimit = {
    do: operation => { tasks.push(operation); return new Promise(() => {}); },
  };
  f.manager.startQueuedInstallation(f.api, { reference: {} }, 'download', 'ownGame', 'collection', false, 0);
  assert.equal(tasks.length, 1);
  assert.equal(f.manager.mPendingInstalls.has('collection:download'), true);
  // Cancel before orchestration. Its real early exit records/removes placeholder,
  // then returns without starting any installer or touching filesystem APIs.
  f.manager.mPendingInstalls.clear();
  await tasks[0]();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'collection:download');
  assert.equal(seen[0].value.installId, 'collection:download');
  assert.equal(seen[0].value.sourceModId, 'collection');
  assert.equal(f.manager.mActiveInstalls.size, 0);
  assert.equal(f.operations.length, 0);
});
