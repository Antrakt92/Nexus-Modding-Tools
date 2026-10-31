import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('download-pending-transfer-hold.json', base)));
const patch = readFileSync(new URL('download-pending-transfer-hold.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integration = (name, action) => test(name, {timeout: 10000,
  skip: process.env.VORTEX_NATIVE_DOWNLOAD_INDEX ? false : 'Provide exact original download-management index source'}, action);
let cached;
function sources() {
  if (cached) return cached;
  const original = readFileSync(process.env.VORTEX_NATIVE_DOWNLOAD_INDEX, 'utf8');
  assert.equal(hash(original), manifest.inputSHA256);
  const changed = applyExact(original, patch, manifest.upstreamPath);
  assert.equal(hash(changed), manifest.outputSHA256);
  return cached = {original, changed};
}
function fixture({baseline = false, destination = 'F:/ExistingTarget', transactions} = {}) {
  const calls = [], files = new Map([[destination, 'pre-existing download']]);
  const state = {activeGame: 'own', settings: {downloads: {
    path: destination === 'F:/CurrentDownloads' ? destination : 'F:/OriginalDownloads',
  }}, persistent: {transactions: transactions ?? {transfer: {downloads: destination}}}};
  const source = baseline ? sources().original : sources().changed;
  const start = source.indexOf('function checkPendingTransfer(');
  const end = source.indexOf('\nlet shutdownPending:', start);
  assert(start >= 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end), {mode: 'transform'});
  // Only this diagnostic's PromiseBB constructor/resolve are used. Native Promise
  // models the deletion capability; no Bluebird lifecycle timing is claimed.
  const check = vm.runInNewContext(code+'\ncheckPendingTransfer;', {
    PromiseBB: Promise,
    selectors: {activeGameId: value => value.activeGame},
    getSafe: (value, keys, fallback) => keys.reduce((item, key) => item?.[key], value) ?? fallback,
    fs: {removeAsync: target => {calls.push(['remove', target]); files.delete(target); return Promise.resolve();}},
    setTransferDownloads: destination => ({destination}),
  }, {timeout: 1000});
  const api = {
    store: {getState: () => state, dispatch: action => {
      calls.push(['dispatch', action]); delete state.persistent.transactions.transfer.downloads;
    }},
    sendNotification: value => calls.push(['send', value]),
    dismissNotification: value => calls.push(['dismiss', value]),
  };
  return {check: () => check(api), calls, files, state};
}

test('download warning patch pins the original source and grants no lifecycle authority', () => {
  assert.equal(manifest.inputSHA256, '846c3160f7b4b7bba6d5277dffa3730b566de75fb91def275989d18f2983095f');
  assert.equal(manifest.originalSourceSHA256, manifest.inputSHA256);
  assert.equal(hash(patch), manifest.patchSHA256); assert.equal(manifest.preparedOnly, true);
  for (const flag of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','installationPermit'])
    assert.equal(manifest[flag], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
});

integration('baseline fix deletes a pre-existing or current download root; new warning has no fix', async () => {
  for (const destination of ['F:/ExistingTarget', 'F:/CurrentDownloads']) for (const baseline of [true, false]) {
    const f = fixture({baseline, destination}), result = await f.check();
    assert.equal(result.severity, 'warning');
    if (baseline) {
      assert.equal(typeof result.automaticFix, 'function'); await result.automaticFix();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.files.size, 0);
      assert.deepEqual(f.calls.map(row => row[0]), ['send','remove','dispatch','dismiss']);
      assert(!Object.hasOwn(f.state.persistent.transactions.transfer, 'downloads'));
    } else {
      assert(!Object.hasOwn(result, 'automaticFix'));
      assert(!Object.hasOwn(result, 'onRecheck'));
      assert.equal(f.files.get(destination), 'pre-existing download');
      assert.equal(f.state.persistent.transactions.transfer.downloads, destination);
      assert.deepEqual(f.calls, []);
    }
  }
});

integration('repeated warnings preserve persisted state and make no filesystem, notification or dispatch calls', async () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const first = await f.check(), second = await f.check();
  assert.equal(first.description.long, second.description.long);
  assert.match(first.description.long, /Review the source and destination/);
  assert.match(first.description.long, /does not automatically clean up/);
  assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
  assert.equal(f.files.size, 1);
});

integration('missing active game or download marker keeps the original undefined diagnostic', async () => {
  for (const baseline of [true, false]) for (const options of [
    {noActiveGame: true}, {transactions: {}}, {transactions: {transfer: {}}},
    {transactions: {transfer: {own: 'F:/StagingTarget'}}},
  ]) {
    const f = fixture({baseline, ...options});
    if (options.noActiveGame) f.state.activeGame = undefined;
    assert.equal(await f.check(), undefined); assert.deepEqual(f.calls, []);
  }
});

integration('download marker remains global across active games without leaking its path or a reset callback', async () => {
  const destination = 'F:/PrivateTarget/KeepThis', f = fixture({destination});
  for (const game of ['own', 'another']) {
    f.state.activeGame = game;
    const result = await f.check();
    assert.deepEqual(Object.keys(result).sort(), ['description','severity']);
    assert(!JSON.stringify(result).includes(destination));
  }
  assert.deepEqual(f.calls, []); assert.equal(f.files.size, 1);
  assert.equal(f.state.persistent.transactions.transfer.downloads, destination);
});
