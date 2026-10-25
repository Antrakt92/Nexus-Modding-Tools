import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import disk from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { remote, MAX_RESPONSE_BYTES, boundedLines } from './bridge.mjs';
const require = createRequire(import.meta.url);
const baseline = process.env.VORTEX_AGENT_BASELINE === '1';
const guard = require(baseline ? paths.build + '/upstream/src/guard.cjs' : './guard.cjs');
const { dialogs, conflicts } = require('./inspection.cjs');
const credential = require('./credential.cjs');
const ROOT = paths.build + '/tests';
await fs.mkdir(ROOT, { recursive: true });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(ROOT, 'review-'));
  const stat = await fs.stat(dir, { bigint: true }); const id = `${stat.dev}:${stat.ino}`;
  const state = { settings: { gameMode: { discovered: { cyberpunk2077: { path: dir } } } },
    persistent: { profiles: { p: { gameId: 'cyberpunk2077', modState: {} } }, mods: { cyberpunk2077: { m: { state: 'installed', installationPath: 'm' } } }, downloads: { files: {} } }, session: { base: {} } };
  const api = { getState: () => state, ext: {}, events: {} };
  const selectors = { activeGameId: () => 'cyberpunk2077', activeProfileId: () => 'p', installPathForGame: () => dir, downloadPathForGame: () => dir };
  let effects = 0;
  const actions = { setModsEnabled: async () => { effects++; throw new Error('uncertain'); } };
  const options = { receipts: dir + '/receipts', stopped: () => {} };
  const args = { gameId: 'cyberpunk2077', profileId: 'p', requestId: crypto.randomUUID(),
    gamePath: dir, stagingPath: dir, downloadPath: dir, filesystemIds: { gamePath: id, stagingPath: id, downloadPath: id }, modIds: ['m'], enabled: true };
  return { dir, api, state, selectors, options, args, actions, ops: guard.createOperations(api, actions, selectors, options), effects: () => effects };
}
test('review: uncertain effect blocks alternate ID and separate operation instance', async () => {
  const f = await fixture(); await assert.rejects(f.ops.set_mods_enabled(f.args));
  const second = guard.createOperations(f.api, f.actions, f.selectors, f.options);
  await assert.rejects(second.set_mods_enabled({ ...f.args, requestId: crypto.randomUUID() }), /INTERLOCK/);
  assert.equal(f.effects(), 1);
  if (!baseline) {
    const status = await second.reconcile_operation({ requestId: f.args.requestId });
    assert.equal(status.terminalOperationVerified, false); assert.equal(status.interlockCleared, false);
    await fs.access(f.dir + '/receipts/unresolved.json');
    const code = `const g=require(${JSON.stringify(fileURLToPath(new URL('./guard.cjs', import.meta.url)))}); const api={getState:()=>({})}; g.createOperations(api,{}, {},{receipts:${JSON.stringify(f.dir + '/receipts')}}).set_mods_enabled({requestId:'different-process'}).then(()=>process.exit(2),e=>{if(e.message!=='UNRESOLVED_OPERATION_INTERLOCK')process.exit(3)});`;
    execFileSync(process.execPath, ['-e', code], { stdio: 'pipe' });
  }
});
test('review: preflight refusal records no effects and does not globally interlock', async () => {
  const f = await fixture(); f.args.modIds = ['missing'];
  await assert.rejects(f.ops.set_mods_enabled(f.args), /MOD_NOT_INSTALLED/);
  const failed = JSON.parse(await fs.readFile(f.dir + '/receipts/' + f.args.requestId + '.failed.json'));
  assert.equal(failed.effectsMayHaveOccurred, false);
  await assert.rejects(fs.access(f.dir + '/receipts/unresolved.json'));
  f.args.modIds = ['m']; await assert.rejects(f.ops.set_mods_enabled({ ...f.args, requestId: crypto.randomUUID() }), /uncertain/);
  assert.equal(f.effects(), 1);
});
test('review: sync immediately-before-effect recheck follows durable attempt and interlock', async () => {
  const f = await fixture(); let checks = 0;
  const operations = guard.createOperations(f.api, f.actions, f.selectors, { ...f.options, stopped: () => {
    checks++;
    if (checks === 2) {
      assert.ok(disk.existsSync(f.dir + '/receipts/' + f.args.requestId + '.attempt.json'));
      assert.ok(disk.existsSync(f.dir + '/receipts/unresolved.json'));
      throw new Error('STALE_ACTIVE_CONTEXT');
    }
  } });
  await assert.rejects(operations.set_mods_enabled(f.args), /STALE/);
  assert.equal(f.effects(), 0);
  await assert.rejects(fs.access(f.dir + '/receipts/unresolved.json'));
});
test('review: attempt and unresolved marker fsynced before effect invocation', async () => {
  const f = await fixture(); const synced = [];
  const monitoredFs = { ...fs, open: async (file, mode) => {
    const handle = await fs.open(file, mode);
    return { writeFile: (...a) => handle.writeFile(...a), close: () => handle.close(),
      sync: async () => { await handle.sync(); synced.push(path.basename(file)); } };
  } };
  const module = { exports: {} };
  const source = await fs.readFile(baseline ? paths.build + '/upstream/src/guard.cjs' : new URL('./guard.cjs', import.meta.url), 'utf8');
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})')(id => id === 'node:fs/promises' ? monitoredFs : require(id), module, module.exports);
  f.actions.setModsEnabled = async () => {
    assert.ok(synced.includes(f.args.requestId + '.attempt.json'));
    assert.ok(synced.includes('unresolved.json'));
    f.state.persistent.profiles.p.modState.m = { enabled: true };
  };
  await module.exports.createOperations(f.api, f.actions, f.selectors, f.options).set_mods_enabled(f.args);
  assert.ok(synced.some(name => name.startsWith(f.args.requestId + '.completion.json.pending-')));
  await fs.access(f.dir + '/receipts/' + f.args.requestId + '.completion.json');
});
test('review: ANY native install refused, including Nexus/name/logical collisions and empty inventory', async () => {
  for (const collision of ['nexus', 'name', 'logical', 'none']) {
    const f = await fixture(), bytes = Buffer.from('review archive');
    await fs.writeFile(f.dir + '/archive.zip', bytes);
    const record = { game: ['cyberpunk2077'], state: 'finished', localPath: 'archive.zip', modInfo: { name: 'Trusted Name', logicalFileName: 'logical', nexus: { ids: { modId: 42, fileId: 43 } } } };
    f.state.persistent.downloads.files.d = record;
    f.state.persistent.mods.cyberpunk2077 = collision === 'none' ? {} : { old: { state: 'installed', attributes: { modId: 42, fileId: 1, newestFileId: 43, name: 'Trusted Name', logicalFileName: 'logical' } } };
    let called = false;
    f.api.events.emit = (_event, id, _options, cb) => { called = true; f.state.persistent.mods.cyberpunk2077.old = { state: 'installed', archiveId: id }; cb(null, 'old'); };
    await assert.rejects(f.ops.install_download({ ...f.args, downloadId: 'd', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }), /INSTALL_DISABLED/);
    assert.equal(called, false);
  }
});
test('review: first-game download directory ambiguity refused', async () => {
  const f = await fixture(); f.state.persistent.downloads.files.d = { game: ['skyrimse', 'cyberpunk2077'], state: 'finished', localPath: 'archive.zip' };
  await assert.rejects(f.ops.install_download({ ...f.args, downloadId: 'd', size: 1, sha256: '0'.repeat(64) }), /SINGLE_GAME/);
});
test('review: wrong inode and relative path pins refused', async () => {
  const f = await fixture();
  await assert.rejects(f.ops.set_mods_enabled({ ...f.args, filesystemIds: { ...f.args.filesystemIds, stagingPath: '0:0' } }), /IDENTITY/);
  const rel = './explicit-relative-pin';
  await assert.rejects(f.ops.set_mods_enabled({ ...f.args, gamePath: rel }), /PATH_PIN/);
  assert.equal(f.effects(), 0);
});
test('review: short confidential strings and nxm/custom scheme credentials redacted', () => {
  const value = guard.safe({ text: 'key=xy nxm://game/mods/1/files/2?key=unrecognized&user_id=42 custom+auth://host?key=private opaque-auth:unknownsecret', short: 'xy', embedded: 'prefixxysuffix' },
    { getState: () => ({ confidential: { key: 'xy' } }) });
  assert.ok(!JSON.stringify(value).includes('xy')); assert.ok(!JSON.stringify(value).includes('unrecognized')); assert.ok(!JSON.stringify(value).includes('private'));
  assert.ok(!JSON.stringify(value).includes('unknownsecret'));
});
test('review: dialog input values omitted rather than redacted by spelling', () => {
  const value = dialogs({ getState: () => ({ session: { notifications: { dialogs: [{ id: 'd', content: { input: [{ id: 'ordinary', label: 'field', value: 'unknown-secret', defaultValue: 'other-secret' }] } }] } } }) });
  assert.deepEqual(value[0].input, [{ id: 'ordinary', label: 'field' }]);
});
test('review: bounded contained conflict scanner rejects traversal and junction escape', async () => {
  const f = await fixture(); f.state.persistent.profiles.p.modState.m = { enabled: true };
  f.state.persistent.mods.cyberpunk2077.m.installationPath = '../outside';
  await assert.rejects(conflicts(f.api, f.selectors, {}), /TRAVERSAL/);
  const outside = await fs.mkdtemp(ROOT + '/outside-'); await fs.writeFile(outside + '/secret', 'private');
  f.state.persistent.mods.cyberpunk2077.m.installationPath = 'm';
  await fs.symlink(outside, f.dir + '/m', 'junction');
  await assert.rejects(conflicts(f.api, f.selectors, {}), /REPARSE/);
});
test('review: real conflict scan returns bounded owner facts without winner claims', async () => {
  const f = await fixture();
  f.state.persistent.mods.cyberpunk2077 = { a: { installationPath: 'a' }, b: { installationPath: 'b' } };
  f.state.persistent.profiles.p.modState = { a: { enabled: true }, b: { enabled: true } };
  for (const name of ['a', 'b']) { await fs.mkdir(f.dir + '/' + name); await fs.writeFile(f.dir + '/' + name + '/same.reds', 'fixture'); }
  const result = await conflicts(f.api, f.selectors, { limit: 1 });
  assert.deepEqual(result.conflicts[0].modIds, ['a', 'b']); assert.equal(result.winnerVerified, false);
});
test('review: conflict scan depth budget prevents unbounded traversal', async () => {
  const f = await fixture(); f.state.persistent.profiles.p.modState.m = { enabled: true };
  const nested = f.dir + '/m/' + Array(34).fill('d').join('/'); await fs.mkdir(nested, { recursive: true });
  await assert.rejects(conflicts(f.api, f.selectors, {}), /SCAN_LIMIT/);
});
test('review: response JSON and complete one-chunk SSE bytes capped BEFORE parsing', async () => {
  for (const type of ['application/json', 'text/event-stream']) {
    const bytes = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 120);
    const payload = type === 'text/event-stream' ? Buffer.concat([Buffer.from('data: '), bytes, Buffer.from('\n\n')]) : bytes;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(payload); c.close(); } }), { headers: { 'content-type': type } });
    await assert.rejects(remote('tools/list', {}, async () => response, async () => '7'.repeat(64)), /too large/);
  }
});
test('review: bounded stdin discards oversized unterminated line and recovers', async () => {
  const lines = [];
  for await (const line of boundedLines(Readable.from([Buffer.alloc(100, 120), Buffer.from('\n{}\n')]), 32)) lines.push(line);
  assert.deepEqual(lines, [null, '{}']);
});
test('review: bearer exact match only, no credential text in errors', async () => {
  assert.equal(credential.authorized(undefined, 'test'), false);
  assert.equal(credential.authorized('Bearer wrong', 'test'), false);
  assert.equal(credential.authorized('Bearer test', 'test'), true);
  await assert.rejects(remote('tools/list', {}, async () => new Response('', { status: 401 }), async () => 'not-printed-secret'), error => /authentication/.test(error.message) && !error.message.includes('not-printed-secret'));
  await assert.rejects(remote('tools/list', {}, async () => { throw new Error('must-not-reach-http'); }, async () => { throw new Error('private-credential-error'); }), error => /credential\.cjs"? --initialize/.test(error.message) && !error.message.includes('private-credential-error'));
});
test('review: DPAPI protects/decrypts an ephemeral test value without initializing production credential', () => {
  const token = '8'.repeat(64); const blob = credential.protect(token);
  assert.ok(!blob.includes(token)); assert.equal(credential.unprotect(blob), token);
});
test('review: isolated DPAPI credential initialization and restricted ACL, no overwrite and corrupt-blob refusal', async () => {
  const root = await fs.mkdtemp(ROOT + '/credential-test-');
  try {
    await credential.initialize(root);
    const files = await fs.readdir(root); assert.equal(files.length, 1); assert.match(files[0], /^S-1-.*\.dpapi$/);
    const token = await credential.readToken(root); assert.match(token, /^[a-f0-9]{64}$/);
    assert.ok(!(await fs.readFile(path.join(root, files[0]), 'utf8')).includes(token));
    await assert.rejects(credential.initialize(root), /EEXIST/);
    const script = `$a=[IO.Directory]::GetAccessControl('${root.replaceAll("'", "''")}'); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(!$a.AreAccessRulesProtected){exit 1}; foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -ne $user){exit 1}}`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'pipe' });
    await fs.writeFile(path.join(root, files[0]), 'invalid-test-blob');
    await assert.rejects(credential.readToken(root), /NOT_INITIALIZED/);
  } finally { await fs.rm(root, { recursive: true }); }
});
