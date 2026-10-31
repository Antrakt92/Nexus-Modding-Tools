import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import disk from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const baseline = process.env.VORTEX_AGENT_REREVIEW_BASELINE === '1';
const buildSource = paths.build + '/upstream/src/';
const guard = require(baseline ? buildSource + 'guard.cjs' : './guard.cjs');
const { publicErrorCode } = require('./serialization.cjs');
const ROOT = paths.build + '/tests';
await fs.mkdir(ROOT, { recursive: true });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(ROOT, 'synthetic-user-'));
  const state = { confidential: { apiKey: 'actual-private-key' },
    settings: { gameMode: { discovered: { cyberpunk2077: { path: dir } } } },
    persistent: { nexus: { userInfo: { username: 'synthetic-user', accountLabel: 'vortex-agent', displayVersion: baseline ? '1.0.2' : '1.1.0', firstName: 'mod', lastName: 'request', country: 'cyberpunk', extra: 'profile', number: ':' } },
      profiles: { 'profile-id': { gameId: 'cyberpunk2077', modState: {} } },
      mods: { cyberpunk2077: { 'mod-id': { state: 'installed', installationPath: 'mod-id' } } }, downloads: { files: {} } }, session: { base: {} } };
  const api = { getState: () => state, ext: {}, events: {} };
  const selectors = { activeGameId: () => 'cyberpunk2077', activeProfileId: () => 'profile-id', installPathForGame: () => dir, downloadPathForGame: () => dir };
  const args = { gameId: 'cyberpunk2077', profileId: 'profile-id', requestId: 'request-' + crypto.randomUUID(),
    modIds: ['mod-id'], enabled: true, gamePath: dir, stagingPath: dir, downloadPath: dir,
    filesystemIds: { gamePath: guard.identity(dir), stagingPath: guard.identity(dir), downloadPath: guard.identity(dir) } };
  const actions = { setModsEnabled: async () => { state.persistent.profiles['profile-id'].modState['mod-id'] = { enabled: args.enabled }; } };
  const options = { receipts: dir + '/receipts', stopped: () => {} };
  return { dir, state, api, selectors, args, actions, options, ops: guard.createOperations(api, actions, selectors, options) };
}
test('re-review: userInfo overlap cannot corrupt health operational values or expose account records', async () => {
  const f = await fixture();
  const health = guard.safe(f.ops.health(), f.api, 'health');
  assert.equal(health.protocol, 'vortex-agent/1');
  assert.equal(health.extensionVersion, baseline ? '1.0.2' : '1.1.0');
  assert.equal(health.gameId, f.args.gameId); assert.equal(health.profileId, f.args.profileId);
  assert.equal(health.gamePath, disk.realpathSync(f.dir)); assert.deepEqual(health.filesystemIds, f.args.filesystemIds);
  assert.throws(() => guard.safe({ account: f.state.persistent.nexus.userInfo }, f.api, 'health'), /ACCOUNT_DATA_NOT_CURATED/);
  assert.equal(guard.safe({ arbitrary: { gameId: 'synthetic-user', requestId: 'synthetic-user' }, text: 'synthetic-user display' }, f.api, 'health').arbitrary.gameId, '[redacted]');
});
test('re-review: receipts and reconciliation keep exact original IDs and canonical path pins', async () => {
  const f = await fixture();
  await f.ops.set_mods_enabled(f.args);
  const attempt = JSON.parse(await fs.readFile(f.dir + '/receipts/' + f.args.requestId + '.attempt.json', 'utf8'));
  assert.equal(attempt.requestId, f.args.requestId); assert.deepEqual(attempt.parameters, f.args);
  const result = guard.safe(await f.ops.reconcile_operation({ requestId: f.args.requestId }), f.api, 'reconcile_operation');
  assert.equal(result.attempt.requestId, f.args.requestId);
  assert.equal(result.completion.requestId, f.args.requestId);
  assert.deepEqual(result.completion.modIds, f.args.modIds);
  assert.equal(result.enabledFlags[0].modId, 'mod-id'); assert.equal(result.enabledFlags[0].requestedFlagObserved, true);
});
test('re-review: real credential overlap in operational value fails explicitly before any effect or receipt', async () => {
  const f = await fixture();
  f.state.confidential.apiKey = 'synthetic-user';
  assert.throws(() => guard.safe(f.ops.health(), f.api, 'health'), /OPERATIONAL_SECRET_OVERLAP/);
  let called = false; f.actions.setModsEnabled = async () => { called = true; };
  await assert.rejects(f.ops.set_mods_enabled(f.args), /OPERATIONAL_SECRET_OVERLAP/);
  assert.equal(called, false);
  await assert.rejects(fs.access(f.dir + '/receipts/' + f.args.requestId + '.attempt.json'));
  assert.throws(() => guard.safe({ protocol: 'vortex-agent/1', arbitrary: { gameId: 'actual-private-key' } },
    { getState: () => ({ confidential: { apiKey: 'vortex-agent' } }) }, 'health'), /OPERATIONAL_SECRET_OVERLAP/);
  f.state.confidential.apiKey = 'actual-private-key';
  f.state.persistent.nexus.userInfo.accessToken = 'mod-id';
  assert.throws(() => guard.safe({ modIds: ['mod-id'] }, f.api, 'operation_status'), /OPERATIONAL_SECRET_OVERLAP/);
  assert.equal(guard.safe({ arbitrary: { gameId: 'actual-private-key' } }, f.api, 'health').arbitrary.gameId, '[redacted]');
});
test('re-review: named inventory IDs and versions remain lossless while display/account fields are redacted', async () => {
  const f = await fixture();
  const mods = guard.safe([{ id: 'mod-id', name: 'synthetic-user display', version: '1.0.3' }], f.api, 'list_mods');
  assert.equal(mods[0].id, 'mod-id'); assert.equal(mods[0].version, '1.0.3'); assert.equal(mods[0].name, '[redacted] display');
  const generic = guard.safe({ modIds: ['mod-id'], credential: { value: 'not-known-in-state' } }, f.api);
  assert.equal(generic.modIds[0], '[redacted]-id'); assert.equal(generic.credential, '[redacted]');
  assert.equal(guard.safe([{ id: 'mod-id', version: 'DEV beta' }], f.api, 'list_mods')[0].version, 'DEV beta');
});

test('re-review: empty native versions stay unknown without weakening operational validation', async () => {
  const f = await fixture();
  for (const kind of ['list_mods', 'list_profiles', 'list_downloads']) {
    assert.equal(guard.safe([{ id: 'mod-id', version: '' }], f.api, kind)[0].version, '');
    for (const version of ['x'.repeat(201), '1\n2', '\0', 'https://private.example/file'])
      assert.throws(() => guard.safe([{ id: 'mod-id', version }], f.api, kind), /OPERATIONAL_VALUE_NOT_CURATED/);
    assert.throws(() => guard.safe([{ id: '', version: '' }], f.api, kind), /OPERATIONAL_VALUE_NOT_CURATED/);
    assert.throws(() => guard.safe([{ id: 'mod-id', version: 'actual-private-key' }], f.api, kind), /OPERATIONAL_SECRET_OVERLAP/);
  }
});
test('re-review: internal bearer overlap fails before receipt persistence and error messages cannot echo credentials', async () => {
  const f = await fixture(); const token = 'b'.repeat(64); f.args.requestId = token;
  const ops = guard.createOperations(f.api, f.actions, f.selectors, { ...f.options, credentials: [token] });
  await assert.rejects(ops.set_mods_enabled(f.args), /OPERATIONAL_SECRET_OVERLAP/);
  await assert.rejects(fs.access(f.dir + '/receipts/' + token + '.attempt.json'));
  f.state.confidential.apiKey = 'ACTUAL_CREDENTIAL_ERROR';
  assert.equal(publicErrorCode(new Error('ACTUAL_CREDENTIAL_ERROR'), f.api), 'VORTEX_OPERATION_FAILED');
  assert.equal(publicErrorCode(new Error('OPERATIONAL_SECRET_OVERLAP'), f.api), 'OPERATIONAL_SECRET_OVERLAP');
});
test('re-review: absent=false, explicit false=false and true=true no-ops complete without interlock', async () => {
  for (const enabled of [undefined, false, true]) {
    const f = await fixture();
    if (enabled !== undefined) f.state.persistent.profiles['profile-id'].modState['mod-id'] = { enabled };
    f.args.enabled = enabled === true;
    let called = false;
    f.actions.setModsEnabled = async () => { called = true; }; // Already effective: skip the effect entirely.
    const result = await f.ops.set_mods_enabled(f.args);
    assert.equal(result.enabledFlagsVerified, true);
    assert.equal(called, false);
    await assert.rejects(fs.access(f.dir + '/receipts/unresolved.json'));
    const reconciled = await f.ops.reconcile_operation({ requestId: f.args.requestId });
    assert.equal(reconciled.enabledFlags[0].enabled, enabled === true);
    assert.equal(reconciled.enabledFlags[0].requestedFlagObserved, true);
  }
});
test('re-review: conflict scanner rejects live staging selector change even though old root still exists', async () => {
  const f = await fixture(); const other = await fs.mkdtemp(ROOT + '/other-staging-');
  f.state.persistent.profiles['profile-id'].modState['mod-id'] = { enabled: true };
  await fs.mkdir(f.dir + '/mod-id'); await fs.writeFile(f.dir + '/mod-id/file.reds', 'fixture');
  let configured = f.dir;
  const selectors = { ...f.selectors, installPathForGame: () => configured };
  const monitoredFs = { ...fs, opendir: async (...args) => { const handle = await fs.opendir(...args); configured = other; return handle; } };
  const module = { exports: {} };
  const source = await fs.readFile(baseline ? buildSource + 'inspection.cjs' : new URL('./inspection.cjs', import.meta.url), 'utf8');
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})')(id => id === 'node:fs/promises' ? monitoredFs : id === './guard.cjs' ? guard : require(id), module, module.exports);
  await assert.rejects(module.exports.conflicts(f.api, selectors, {}), /STALE_SCAN_CONTEXT/);
  assert.ok(disk.existsSync(f.dir));
});
test('re-review: mixed no-op/change targets mutate only effective changes and verify absent=false', async () => {
  const f = await fixture();
  f.state.persistent.mods.cyberpunk2077['other-mod'] = { state: 'installed' };
  f.state.persistent.profiles['profile-id'].modState['other-mod'] = { enabled: true };
  f.args.modIds = ['mod-id', 'other-mod']; f.args.enabled = false;
  let call;
  f.actions.setModsEnabled = async (...args) => { call = args; f.state.persistent.profiles['profile-id'].modState['other-mod'].enabled = false; };
  const result = await f.ops.set_mods_enabled(f.args);
  assert.deepEqual(call.slice(1), ['profile-id', ['other-mod'], false, { allowAutoDeploy: false, reason: 'user_manual', installed: true }]);
  assert.deepEqual(result.modIds, f.args.modIds);
  const reconciled = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.ok(reconciled.enabledFlags.every(flag => flag.enabled === false && flag.requestedFlagObserved));
  await assert.rejects(fs.access(f.dir + '/receipts/unresolved.json'));
});
