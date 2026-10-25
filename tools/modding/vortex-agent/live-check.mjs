// Bounded live acceptance: inspection, rejected stale request and effective no-ops.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { remote } from './bridge.mjs';
import paths from './paths.cjs';
import { fileURLToPath } from 'node:url';

const state = paths.state;
const unpack = result => {
  if (result.isError) throw new Error('Live tool returned error: ' + result.content?.[0]?.text);
  return JSON.parse(result.content.find(c => c.type === 'text').text);
};
const call = async (name, args = {}) => unpack(await remote('tools/call', { name, arguments: args }));
const pin = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const health = await call('health');
if (health.protocol !== 'vortex-agent/1' || health.security !== 'per-user-DPAPI-bearer') throw new Error('Unexpected live server');
const context = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, health[k]]));
const profilesBefore = await call('list_profiles', { gameId: health.gameId });
const modsBefore = await call('list_mods', { gameId: health.gameId, limit: 500 });
const downloadsBefore = await call('list_downloads', { gameId: health.gameId, limit: 500 });
const dialogs = await call('list_dialogs');
const external = await call('list_external_changes');
if (dialogs.length || external.length) throw new Error('Pending dialog/external changes; defer no-op validation');
const tools = (await remote('tools/list')).tools.map(t => t.name);
if (['vortex_dispatch', 'vortex_query', 'launch_game', 'switch_profile', 'check_nexus_mod_updates'].some(t => tools.includes(t))) throw new Error('Unexpected unsafe tool');
const requestPrefix = 'acceptance-' + Date.now();
const candidate = modsBefore.find(m => !m.enabled);
const enabled = modsBefore.find(m => m.enabled);
if (!candidate || !enabled) throw new Error('Expected installed disabled/enabled no-op candidates');
const stale = await remote('tools/call', { name: 'set_mods_enabled', arguments: {
  ...context, profileId: 'nonexistent-acceptance-profile', requestId: requestPrefix + '-stale', modIds: [candidate.id], enabled: false,
} });
if (!stale.isError || !stale.content[0].text.includes('STALE_ACTIVE_CONTEXT')) throw new Error('Stale context did not fail closed');
const disabledNoop = await call('set_mods_enabled', { ...context, requestId: requestPrefix + '-disabled', modIds: [candidate.id], enabled: false });
const enabledNoop = await call('set_mods_enabled', { ...context, requestId: requestPrefix + '-enabled', modIds: [enabled.id], enabled: true });
if (!disabledNoop.enabledFlagsVerified || !enabledNoop.enabledFlagsVerified || disabledNoop.diskDeploymentVerified || enabledNoop.diskDeploymentVerified) throw new Error('Invalid operation status');
const profilesAfter = await call('list_profiles', { gameId: health.gameId });
const modsAfter = await call('list_mods', { gameId: health.gameId, limit: 500 });
const downloadsAfter = await call('list_downloads', { gameId: health.gameId, limit: 500 });
if (pin(profilesBefore) !== pin(profilesAfter) || pin(modsBefore) !== pin(modsAfter) || pin(downloadsBefore) !== pin(downloadsAfter)) throw new Error('Inventory/profile/downloads changed during no-op check');

const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', c => { stdout += c; });
child.stderr.on('data', c => { stderr += c; });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-acceptance', version: '1' } } }) + '\n');
await new Promise(resolve => setTimeout(resolve, 4000));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }) + '\n');
child.stdin.end();
const [exit] = await once(child, 'close');
const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
if (exit || stderr || responses.length !== 2 || !responses.find(r => r.id === 10)?.result?.serverInfo || !responses.find(r => r.id === 11)?.result?.tools?.length) throw new Error('Live stdio MCP acceptance failed');
const result = { at: new Date().toISOString(), health, toolNames: tools, inventoryCount: modsBefore.length,
  enabledCount: modsBefore.filter(m => m.enabled).length, profileUnchanged: true, inventoryUnchanged: true,
  downloadsUnchanged: true, inventorySha256: pin(modsAfter), staleContextRejected: true,
  disabledNoop, enabledNoop, liveLegacyInitializeAndToolDiscovery: true, gameLaunched: false,
  actualDeployTested: false, actualInstallTested: false, actualDownloadTested: false };
await fs.mkdir(state, { recursive: true });
await fs.writeFile(state + '/live-check.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
