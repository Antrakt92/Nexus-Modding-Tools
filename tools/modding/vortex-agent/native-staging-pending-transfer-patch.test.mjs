import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('staging-pending-transfer-hold.json', base)));
const patch = readFileSync(new URL('staging-pending-transfer-hold.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integration = (name, action) => test(name, {timeout: 10000,
  skip: process.env.VORTEX_NATIVE_MOD_INDEX ? false : 'Provide exact original mod-management index source'}, action);
let cached;
function sources() {
  if (cached) return cached;
  let prior = readFileSync(process.env.VORTEX_NATIVE_MOD_INDEX, 'utf8');
  assert.equal(hash(prior), manifest.originalSourceSHA256);
  for (const name of ['deployment-lifecycle', 'deployment-error-types', 'startup-cleanup-ownership']) {
    const m = JSON.parse(readFileSync(new URL(name+'.json', base)));
    const p = readFileSync(new URL(name+'.patch', base), 'utf8');
    assert.equal(hash(prior), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
    prior = applyExact(prior, p, m.upstreamPath); assert.equal(hash(prior), m.outputSHA256);
  }
  assert.equal(hash(prior), manifest.inputSHA256);
  const changed = applyExact(prior, patch, manifest.upstreamPath);
  assert.equal(hash(changed), manifest.outputSHA256);
  return cached = {prior, changed};
}
function fixture({baseline = false, activeGame = 'own', destination = 'F:/OwnDestination', transactions} = {}) {
  const calls = [], files = new Map([[destination, 'pre-existing payload']]);
  const state = {activeGame, settings: {mods: {installPath: {
    own: destination === 'F:/ActiveStaging' ? destination : 'F:/OriginalStaging',
  }}}, persistent: {
    transactions: transactions ?? {transfer: {own: destination}},
  }};
  const source = baseline ? sources().prior : sources().changed;
  const start = source.indexOf('function checkPendingTransfer(');
  const end = source.indexOf('\nfunction openDuplicateLocation(', start);
  assert(start >= 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end), {mode: 'transform'});
  const check = vm.runInNewContext(code+'\ncheckPendingTransfer;', {
    activeGameId: value => value.activeGame,
    getSafe: (value, keys, fallback) => keys.reduce((item, key) => item?.[key], value) ?? fallback,
    fs: {removeAsync: target => {calls.push(['remove', target]); files.delete(target); return Promise.resolve();}},
    setTransferMods: (gameId, destination) => ({gameId, destination}),
  }, {timeout: 1000});
  const api = {store: {
    getState: () => state,
    dispatch: action => {calls.push(['dispatch', action]); delete state.persistent.transactions.transfer[action.gameId];},
  }};
  return {check: () => check(api), calls, files, state};
}

test('report-only patch binds startup cleanup output and does not grant lifecycle authority', () => {
  const previous = JSON.parse(readFileSync(new URL('startup-cleanup-ownership.json', base)));
  assert.equal(manifest.inputSHA256, previous.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  assert.equal(hash(patch), manifest.patchSHA256); assert.equal(manifest.preparedOnly, true);
  for (const flag of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','installationPermit'])
    assert.equal(manifest[flag], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
});

integration('baseline fix deletes pre-existing or active staging content; warning has no destructive fix', async () => {
  for (const destination of ['F:/ExistingMergeTarget', 'F:/ActiveStaging']) for (const baseline of [true, false]) {
    const f = fixture({baseline, destination});
    const result = await f.check(); assert.equal(result.severity, 'warning');
    if (baseline) {
      assert.equal(typeof result.automaticFix, 'function'); await result.automaticFix();
      assert.equal(f.files.size, 0); assert.equal(f.calls.length, 2);
      assert(!Object.hasOwn(f.state.persistent.transactions.transfer, 'own'));
    } else {
      assert(!Object.hasOwn(result, 'automaticFix'));
      assert(!Object.hasOwn(result, 'onRecheck'));
      assert.equal(f.files.get(destination), 'pre-existing payload');
      assert.equal(f.state.persistent.transactions.transfer.own, destination);
      assert.deepEqual(f.calls, []);
    }
  }
});

integration('repeated warnings preserve the marker and neither adopt nor reset the destination', async () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const first = await f.check(), second = await f.check();
  assert.equal(first.description.long, second.description.long);
  assert.match(first.description.long, /Review the source and destination/);
  assert.match(first.description.long, /does not automatically clean up/);
  assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
  assert.equal(f.files.size, 1);
});

integration('no active game and no marker retain the original undefined result without effects', async () => {
  for (const baseline of [true, false]) for (const options of [
    {activeGame: undefined}, {transactions: {}}, {transactions: {transfer: {}}},
    {transactions: {transfer: {another: 'F:/AnotherGame'}}},
  ]) {
    // Explicit undefined bypasses the fixture default only for this API branch.
    const f = fixture({baseline, ...options});
    if (Object.hasOwn(options, 'activeGame')) f.state.activeGame = undefined;
    assert.equal(await f.check(), undefined); assert.deepEqual(f.calls, []);
  }
});

integration('warning does not embed the persisted target or expose a callable reset capability', async () => {
  const destination = 'F:/PrivateTarget/KeepThis';
  const f = fixture({destination}), result = await f.check();
  assert.deepEqual(Object.keys(result).sort(), ['description','severity']);
  assert(!JSON.stringify(result).includes(destination));
  assert.deepEqual(f.calls, []); assert.equal(f.files.size, 1);
});
