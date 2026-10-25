import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { handler, remote as httpRemote } from './bridge.mjs';
const remote = (method, params, fetcher) => httpRemote(method, params, fetcher, async () => '7'.repeat(64));
const require = createRequire(import.meta.url);
const { createOperations, safe, exclusive, stopped, identity } = require('./guard.cjs');
const ROOT = paths.build + '/tests';
await fs.mkdir(ROOT, { recursive: true });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(ROOT, 'case-'));
  const state = { settings: {}, persistent: { profiles: { p: { gameId: 'cyberpunk2077', modState: {} } },
    mods: { cyberpunk2077: { m: { state: 'installed' } } }, downloads: { files: {} } }, session: { base: {} } };
  let profile = 'p';
  const selectors = { activeProfileId: () => profile, activeGameId: () => 'cyberpunk2077',
    installPathForGame: () => dir, downloadPathForGame: () => dir };
  state.settings.gameMode = { discovered: { cyberpunk2077: { path: dir } } };
  const api = { getState: () => state, ext: {}, events: {} };
  const calls = [];
  const actions = { setModsEnabled: async (...args) => { calls.push(args); for (const id of args[2]) state.persistent.profiles.p.modState[id] = { enabled: args[3] }; } };
  const args = { gameId: 'cyberpunk2077', profileId: 'p', gamePath: dir, stagingPath: dir, downloadPath: dir, requestId: crypto.randomUUID(), modIds: ['m'], enabled: true };
  args.filesystemIds = { gamePath: identity(dir), stagingPath: identity(dir), downloadPath: identity(dir) };
  const ops = createOperations(api, actions, selectors, { receipts: path.join(dir, 'receipts'), stopped: () => {} });
  return { dir, state, api, actions, selectors, calls, args, ops, change: () => { profile = 'other'; } };
}
test('enable disables auto-deploy, verifies flags and writes external receipts', async () => {
  const f = await fixture(); const result = await f.ops.set_mods_enabled(f.args);
  assert.deepEqual(f.calls[0].slice(1), ['p', ['m'], true, { allowAutoDeploy: false, reason: 'user_manual', installed: true }]);
  assert.equal(result.enabledFlagsVerified, true); assert.equal(result.diskDeploymentVerified, false);
  await fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.attempt.json'));
  await fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json'));
  await assert.rejects(f.ops.set_mods_enabled(f.args), /EEXIST/);
  assert.equal(f.calls.length, 1);
});
test('stale context and wrong path prevent writes', async () => {
  const f = await fixture(); await assert.rejects(f.ops.set_mods_enabled({ ...f.args, gamePath: f.dir + '-wrong' }), /PATH_PIN/);
  f.change(); await assert.rejects(f.ops.set_mods_enabled(f.args), /STALE/); assert.equal(f.calls.length, 0);
});
test('context change during wait records uncertainty, never success', async () => {
  const f = await fixture(); f.actions.setModsEnabled = async () => f.change();
  await assert.rejects(f.ops.set_mods_enabled(f.args), /STALE/);
  const failed = JSON.parse(await fs.readFile(path.join(f.dir, 'receipts', f.args.requestId + '.failed.json')));
  assert.equal(failed.effectsMayHaveOccurred, true);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
});
test('unretained enabled flag is rejected', async () => {
  const f = await fixture(); f.actions.setModsEnabled = async () => {};
  await assert.rejects(f.ops.set_mods_enabled(f.args), /FLAGS_UNVERIFIED/);
});
test('deploy uses only profileId and reports operation-level result', async () => {
  const f = await fixture(); let args;
  f.api.ext.awaitModsDeployment = async (...a) => { args = a; };
  const result = await f.ops.deploy_mods(f.args);
  assert.deepEqual(args, ['p']); assert.equal(result.deploymentPromiseResolved, true); assert.equal(result.diskDeploymentVerified, false);
});
async function downloadFixture() {
  const f = await fixture(); const data = Buffer.from('pinned archive fixture');
  await fs.writeFile(path.join(f.dir, 'archive.zip'), data);
  const record = { game: ['cyberpunk2077'], state: 'finished', localPath: 'archive.zip', modInfo: { nexus: { ids: { modId: 42, fileId: 43 } } } };
  f.state.persistent.downloads.files.d = record;
  f.args = { ...f.args, downloadId: 'd', nexusModId: 42, nexusFileId: 43, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  return f;
}
test('native install is disabled, including valid pinned fresh archives', async () => {
  const f = await downloadFixture(); let called = false;
  f.state.persistent.mods.cyberpunk2077 = {};
  f.api.events.emit = () => { called = true; };
  await assert.rejects(f.ops.install_download(f.args), /INSTALL_DISABLED/);
  assert.equal(called, false);
});
test('wrong package hash prevents install event', async () => {
  const f = await downloadFixture(); let called = false; f.api.events.emit = () => { called = true; };
  await assert.rejects(f.ops.install_download({ ...f.args, sha256: '0'.repeat(64) }), /PIN_MISMATCH/); assert.equal(called, false);
});
test('Nexus existing-download reuse and exact download-only arguments', async () => {
  const f = await downloadFixture(); let calls = 0;
  f.api.ext.nexusDownload = async (...args) => { calls++; assert.deepEqual(args, ['cyberpunk2077', 42, 43, undefined, false]);
    f.state.persistent.downloads.files.d = record; return 'd'; };
  const reused = await f.ops.download_nexus(f.args); assert.equal(reused.reused, true); assert.equal(calls, 0);
  const record = f.state.persistent.downloads.files.d; delete f.state.persistent.downloads.files.d;
  const fresh = await f.ops.download_nexus({ ...f.args, requestId: crypto.randomUUID() }); assert.equal(fresh.reused, false); assert.equal(calls, 1);
});
test('unsupported Windows game guard fails closed', () => {
  assert.throws(() => stopped({}, 'unknown'), /UNSUPPORTED|WINDOWS/);
});
test('Windows guard rejects game process and Vortex running-tool state', async () => {
  const module = { exports: {} };
  let tasks = ['Cyberpunk2077.exe'];
  const mockRequire = id => id === 'node:child_process' ? { spawnSync: () => ({status: 0, stderr: '', stdout: JSON.stringify({schema: 1, complete: true, count: tasks.length, names: tasks})}) } : require(id);
  vm.runInNewContext('(function(require,module,exports){' + await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8') + '\n})', { process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }, Buffer })(mockRequire, module, module.exports);
  assert.throws(() => module.exports.stopped({}, 'cyberpunk2077'), /GAME_RUNNING/);
  tasks = ['Vortex.exe'];
  assert.doesNotThrow(() => module.exports.stopped({}, 'cyberpunk2077'));
  assert.throws(() => module.exports.stopped({ session: { base: { toolsRunning: { any: true } } } }, 'cyberpunk2077'), /GAME_OR_TOOL/);
});
test('unexpected unrelated enabled changes during deployment are rejected', async () => {
  const f = await fixture(); f.api.ext.awaitModsDeployment = async () => { f.state.persistent.profiles.p.modState.unrelated = { enabled: true }; };
  await assert.rejects(f.ops.deploy_mods(f.args), /OTHER_ENABLED/);
});
test('cross-process mutation exclusion', async () => {
  const dir = await fs.mkdtemp(path.join(ROOT, 'lock-')); const module = fileURLToPath(new URL('./guard.cjs', import.meta.url));
  const code = `const {exclusive}=require(${JSON.stringify(module)});exclusive(${JSON.stringify(dir)},async()=>{process.stdout.write('entered\\n');await new Promise(r=>setTimeout(r,150));process.stdout.write('leaving\\n')});`;
  const events = [];
  const children = [0, 1, 2].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code]); child.stdout.on('data', data => { for (const s of data.toString().trim().split('\n')) events.push([id, s]); });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('child failed')));
  }));
  await Promise.all(children);
  for (let i = 0; i < events.length; i += 2) { assert.equal(events[i][1], 'entered'); assert.deepEqual(events[i + 1], [events[i][0], 'leaving']); }
});
test('legacy handshake is local; notifications silent; ids preserved; reads concurrent', async () => {
  const seen = []; const handle = handler(async (method, params) => { seen.push(method); return params.name === 'health'
    ? { content: [{ type: 'text', text: '{"protocol":"vortex-agent/1"}' }] } : { tools: [] }; });
  assert.equal((await handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05' } })).result.protocolVersion, '2024-11-05');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).id, 7);
  assert.deepEqual(seen, ['tools/call', 'tools/list']);
  assert.equal((await handle({ jsonrpc: '2.0', id: 8, method: 'vortex_dispatch' })).error.code, -32601);
});
test('HTTP JSON and chunked SSE wire decoding', async () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
  assert.deepEqual(await remote('tools/list', {}, async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })), { tools: [] });
  const encoded = new TextEncoder().encode('event: message\r\ndata: ' + JSON.stringify(payload) + '\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const byte of encoded) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await remote('tools/list', {}, async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), { tools: [] });
});
test('bridge hides unsupported installs and rejects calls before credentials or HTTP', async () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'health' }, { name: 'install_download' }] } };
  const listed = await remote('tools/list', {}, async () => new Response(JSON.stringify(payload)));
  assert.deepEqual(listed.tools.map(t => t.name), ['health']);
  await assert.rejects(httpRemote('tools/call', { name: 'install_download', arguments: {} },
    async () => assert.fail('HTTP must not be invoked'), async () => assert.fail('Credential must not be read')), /unsupported/);
});
test('wrong endpoint and unavailable Vortex yield actionable errors', async () => {
  const handle = handler(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  assert.match((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).error.message, /Wrong server/);
  await assert.rejects(remote('tools/list', {}, async () => { throw new Error('private-url'); }), /Start Vortex/);
});
test('output redacts credentials and URLs', () => {
  const result = safe({ apiKey: 'secret', message: 'see https://example.test/?token=secret', url: 'secret' });
  assert.ok(!JSON.stringify(result).includes('secret'));
  const hidden = safe({ text: 'credential-is-private embedded' }, { getState: () => ({ confidential: { key: 'credential-is-private' } }) });
  assert.ok(!hidden.text.includes('credential-is-private'));
});
