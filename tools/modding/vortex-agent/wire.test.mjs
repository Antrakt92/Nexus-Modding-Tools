import paths from './paths.cjs';
// Execute the actual built CommonJS artifact with a modeled Vortex API and an
// ephemeral HTTP port. No live Vortex endpoint or active plugin is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire, isBuiltin } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { handler, remote } from './bridge.mjs';
const artifact = process.env.VORTEX_ADAPTER_TEST_ARTIFACT || paths.build + '/upstream/adapted-dist/index.js';
const realRequire = createRequire(artifact);
test('built extension wire: allowlist, SDK2 HTTP, legacy bridge, schemas and browser protection', async () => {
  let listener;
  const token = '7'.repeat(64);
  const root = paths.build + '/tests';
  await fs.mkdir(root, { recursive: true });
  const modelDir = await fs.mkdtemp(root + '/wire-');
  const fakeHttp = { ...http, createServer: fn => {
    listener = http.createServer(fn); const listen = listener.listen.bind(listener);
    listener.listen = () => listen(0, '127.0.0.1'); return listener;
  } };
  const state = { confidential: { apiKey: 'unit-private-credential' }, settings: { profiles: { activeProfileId: 'p' }, gameMode: { discovered: { cyberpunk2077: { path: modelDir } } } },
    persistent: { nexus: { userInfo: { username: 'wire', accountLabel: 'vortex-agent', accountVersion: '1.0.4', displayName: 'cyberpunk' } },
      profiles: { p: { id: 'p', name: 'modeled', gameId: 'cyberpunk2077', modState: {} } }, mods: { cyberpunk2077: {} }, downloads: { files: {} } },
    session: { base: {}, notifications: { dialogs: [{ id: 'dialog', title: 'Modeled dialog', content: { message: 'nxm://game/files/1?key=private-nxm-value', input: [{ id: 'ordinary', label: 'field', value: 'unknown-sensitive-value', defaultValue: 'unknown-default' }] } }] } } };
  const api = { getState: () => state, store: { getState: () => state }, ext: {} };
  const vortex = { actions: {}, selectors: { activeProfileId: () => 'p', activeGameId: () => 'cyberpunk2077',
    knownGames: () => [{ id: 'cyberpunk2077' }], activeProfile: () => state.persistent.profiles.p,
    installPathForGame: () => modelDir, downloadPathForGame: () => modelDir }, util: {}, fs: {}, log: () => {} };
  const module = { exports: {} };
  const sandboxRequire = id => {
    if (id === '@nexusmods/vortex-api') return vortex;
    if (['http', 'node:http'].includes(id)) return fakeHttp;
    assert.ok(isBuiltin(id), 'Packaged extension unexpectedly needs unbundled dependency: ' + id);
    return realRequire(id);
  };
  vm.runInThisContext('(function(require,module,exports,__dirname,__filename){' + await fs.readFile(artifact, 'utf8') + '\n})')(sandboxRequire, module, module.exports, new URL('.', 'file:///' + artifact).pathname, artifact);
  assert.equal(typeof module.exports, 'function', 'Vortex entrypoint must be directly callable');
  if (module.exports.start) module.exports.start(api, 0, { tokenProvider: async () => token });
  else module.exports({ api, once: callback => callback() }); // baseline regression against old package
  await new Promise(resolve => listener.listening ? resolve() : listener.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${listener.address().port}/mcp`;
  const localFetch = (_url, options) => fetch(endpoint, options);
  const call = (method, params) => remote(method, params, localFetch, async () => token);
  try {
    for (const authorization of [undefined, 'Bearer wrong-user-token']) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authorization ? { authorization } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      assert.equal(response.status, 401, 'All endpoints require valid bearer authentication');
    }
    const handle = handler(call);
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.ok(init.result, JSON.stringify(init));
    const list = await call('tools/list', {});
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'health', 'reconcile_operation', 'list_profiles', 'list_mods', 'list_downloads',
      'list_mod_rules', 'find_mod_dependents', 'list_file_conflicts', 'list_known_mod_conflicts',
      'list_unsolved_conflicts', 'read_collection_health', 'list_dialogs', 'list_external_changes',
      'set_mods_enabled', 'deploy_mods', 'download_nexus',
    ].sort());
    assert.equal(list.tools.some(tool => tool.name === 'install_download'), false);
    const writeSchema = list.tools.find(tool => tool.name === 'deploy_mods').outputSchema;
    assert.equal(writeSchema.properties.diskDeploymentVerified.const, false);
    assert.equal(writeSchema.properties.operationCompleted.const, true);
    const downloadSchema = list.tools.find(tool => tool.name === 'download_nexus').inputSchema;
    assert.equal(downloadSchema.properties.reuseOnly.default, false);
    for (const name of ['vortex_dispatch', 'vortex_query', 'launch_game', 'switch_profile', 'clone_profile', 'check_nexus_mod_updates', 'restart_vortex']) {
      assert.ok(!list.tools.some(tool => tool.name === name));
      const result = await call('tools/call', { name, arguments: {} }).catch(() => ({ isError: true }));
      assert.equal(result.isError, true);
    }
    const health = await call('tools/call', { name: 'health', arguments: {} });
    const healthInfo = JSON.parse(health.content[0].text);
    assert.equal(healthInfo.protocol, 'vortex-agent/1'); assert.equal(healthInfo.extensionVersion, '1.0.4');
    assert.equal(healthInfo.gameId, 'cyberpunk2077'); assert.equal(healthInfo.gamePath, await fs.realpath(modelDir));
    assert.ok(!Object.hasOwn(healthInfo, 'userInfo'));
    state.confidential.apiKey = (await fs.realpath(modelDir)).split(/[\\/]/).at(-1);
    const blockedHealth = await call('tools/call', { name: 'health', arguments: {} });
    assert.equal(blockedHealth.isError, true);
    assert.equal(JSON.parse(blockedHealth.content[0].text).error, 'OPERATIONAL_SECRET_OVERLAP');
    assert.ok(!blockedHealth.content[0].text.includes(state.confidential.apiKey));
    state.confidential.apiKey = 'unit-private-credential';
    state.persistent.mods.cyberpunk2077.m = { id: 'm', state: 'downloaded', type: '', attributes: {} };
    vortex.util.renderModName = mod => mod.id;
    const inventory = await call('tools/call', { name: 'list_mods', arguments: { gameId: 'cyberpunk2077' } });
    assert.equal(JSON.parse(inventory.content[0].text)[0].installed, false);
    assert.equal(JSON.parse(inventory.content[0].text)[0].installationState, 'downloaded');
    state.persistent.downloads.files.d = { state: 'finished', localPath: 'synthetic.zip', size: 12, modInfo: { nexus: { ids: { gameId: 'cyberpunk2077', modId: 42, fileId: 43 } } } };
    const downloads = await call('tools/call', { name: 'list_downloads', arguments: {} });
    const projected = JSON.parse(downloads.content[0].text)[0]; assert.equal(projected.nexusModId, 42); assert.equal(projected.identityVerified, true);
    const dialogResult = await call('tools/call', { name: 'list_dialogs', arguments: {} });
    assert.ok(!JSON.stringify(dialogResult).includes('unknown-sensitive-value'));
    assert.ok(!JSON.stringify(dialogResult).includes('unknown-default'));
    assert.ok(!JSON.stringify(dialogResult).includes('private-nxm-value'));
    const badWrite = await call('tools/call', { name: 'set_mods_enabled', arguments: { modIds: ['m'], enabled: 'true' } });
    assert.equal(badWrite.isError, true);
    const extra = await call('tools/call', { name: 'health', arguments: { path: ['confidential'] } });
    assert.equal(extra.isError, true);
    const [one, two] = await Promise.all([call('tools/call', { name: 'health', arguments: {} }), call('tools/list', {})]);
    assert.ok(one.content); assert.ok(two.tools);
    for (const headers of [{ origin: 'http://localhost' }, { origin: 'https://attacker.test' }, { host: 'attacker.test' }]) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request(endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
        request.on('error', reject); request.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
    // Exercise real newline stdin/stdout using a preload that redirects ONLY the
    // test child's fetch to this ephemeral modeled extension.
    const preload = modelDir + '/redirect-fetch.mjs';
    const authModule = new URL('./credential.cjs', import.meta.url).href;
    await fs.writeFile(preload, `import credential from ${JSON.stringify(authModule)}; credential.readToken=async()=>${JSON.stringify(token)}; const original = globalThis.fetch; globalThis.fetch = (_url, options) => original(${JSON.stringify(endpoint)}, options);`);
    const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, bridge]);
    let output = '', error = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    child.stdin.write('{bad-json}\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { clearInterval(poll); child.kill(); reject(new Error('stdio init timeout: ' + output + ' STDERR ' + error)); }, 10000);
      const poll = setInterval(() => { if (output.includes('"id":"init"')) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 10); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) + '\n');
    const exit = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(exit, 0, error);
    const messages = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(messages.length, 3); assert.equal(messages[0].error.code, -32700);
    assert.ok(messages.find(item => item.id === 5).result.tools);
    for (const args of [['--health'], ['--call', 'list_dialogs', '{}']]) {
      const cli = spawn(process.execPath, ['--import', pathToFileURL(preload).href, bridge, ...args]);
      let stdout = '', stderr = ''; cli.stdout.on('data', data => stdout += data); cli.stderr.on('data', data => stderr += data);
      assert.equal(await new Promise(resolve => cli.on('exit', resolve)), 0, stderr);
      assert.ok(JSON.parse(stdout).content);
    }
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
