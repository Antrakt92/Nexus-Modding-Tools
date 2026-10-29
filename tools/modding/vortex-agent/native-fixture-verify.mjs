#!/usr/bin/env node
// Independent, post-shutdown disk/receipt check. Does not contact or alter Vortex.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import paths from './paths.cjs';
import { assertOrdinaryModSnapshot } from './native-fixture-snapshot.mjs';
const base = path.join(paths.workspace, 'local-state/vortex-agent-native-fixture');
const root = path.resolve(process.argv[2] || '');
const rel = path.relative(base, root);
assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'Root outside fixture');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const input = read('prepared.json'), receipt = read('native-receipt.json'), result = read('runner-result.json');
if (input.runtimeVersion) {
  assert.equal(eventVersion(receipt), input.runtimeVersion);
  assert.equal(input.runtimeSourceSha256, hash(path.join(paths.build, 'plugin/vortex-agent/index.js')));
}
function eventVersion(value) { return value.events.find(item => item.phase === 'authenticated-native-health')?.health?.extensionVersion; }
assert.equal(receipt.status, 'passed'); assert.equal(result.fixtureExited, true); assert.equal(result.ordinaryUnchanged, true); assert.deepEqual(result.remainingFixturePids, []);
const event = phase => { const found = receipt.events.filter(e => e.phase === phase); assert.equal(found.length, 1, phase); return found[0]; };
const install = event('native-install-only'), deploy = event('independent-disk-deployment-proof'), rollback = event('independent-rollback-proof');
assert.equal(deploy.manifest.files.length, 1);
assert.equal(deploy.manifest.files[0].source, install.installationPath);
assert.equal(deploy.manifest.deploymentMethod, 'hardlink_activator');
assert.equal(deploy.game.filesystemId, deploy.staging.filesystemId); assert.ok(deploy.game.links >= 2);
assert.equal(deploy.game.sha256, input.payloadSha256); assert.equal(deploy.backup.sha256, input.sentinelSha256);
assert.equal(rollback.original.filesystemId, install.original.filesystemId, 'Original file identity restored');
assert.equal(hash(rollback.original.path), input.sentinelSha256); assert.equal(hash(rollback.staging.path), input.payloadSha256);
assert.equal(fs.existsSync(rollback.original.path + '.vortex_backup'), false); assert.equal(rollback.enabled, false);
assert.equal(rollback.manifest.files.length, 0);
for (const suffix of ['enable', 'deploy', 'disable', 'restore']) {
  const completion = read(`local-state/vortex-agent-build/receipts/${input.runId}_${suffix}.completion.json`);
  assert.equal(completion.operationCompleted, true);
  assert.equal(completion.diskDeploymentVerified, false);
  if (input.runtimeVersion === '1.0.4') { assert.equal(completion.receiptVersion, 2); assert.equal(completion.requestId, `${input.runId}_${suffix}`); }
}
assert.equal(fs.existsSync(path.join(root, 'local-state/vortex-agent-build/receipts/unresolved.json')), false);
assert.equal(fs.existsSync(path.join(root, 'local-state/vortex-agent-build/receipts/mutation.lock')), false);
assert.equal(hash(input.archive), input.archiveSha256);
const imported = event('native-import-finished').archive;
assert.equal(hash(imported.path), input.archiveSha256); assert.equal(fs.statSync(imported.path).size, input.archiveSize);
const zip = fs.readFileSync(imported.path);
assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt16LE(8), 0);
const size = zip.readUInt32LE(18), nameSize = zip.readUInt16LE(26), extraSize = zip.readUInt16LE(28);
assert.equal(zip.subarray(30, 30 + nameSize).toString(), input.payloadPath);
const bytes = zip.subarray(30 + nameSize + extraSize, 30 + nameSize + extraSize + size);
let crc = 0xffffffff;
for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
assert.equal((crc ^ 0xffffffff) >>> 0, zip.readUInt32LE(14), 'ZIP CRC');
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), input.payloadSha256);
assert.equal(rollback.trackedDownloads, 1); assert.equal(rollback.installedMods, 1);
const before = read('ordinary-before.json'), after = read('ordinary-after.json');
assertOrdinaryModSnapshot(before.mods); assertOrdinaryModSnapshot(after.mods);
assert.deepEqual(before.health, after.health); assert.deepEqual(before.profiles, after.profiles); assert.deepEqual(before.mods, after.mods);
assert.equal(before.manifestSha256, after.manifestSha256);
const log = fs.readFileSync(path.join(root, 'userdata/vortex.log'), 'utf8');
assert.match(log, /clean application end/);
const proof = { passed: true, root, checks: ['native import/install', 'authenticated compiled agent enable/deploy/disable/restore', 'manifest ownership', 'deployed hardlink identity', 'original hash and filesystem identity restored', 'post-shutdown game/staging hashes', 'ZIP size/SHA-256/CRC', 'four durable completions without unresolved marker', 'ordinary health/profile/mod inventory/manifest/process preservation', 'clean native shutdown'], nexusReuse: receipt.nexusReuse, at: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'independent-verification.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
