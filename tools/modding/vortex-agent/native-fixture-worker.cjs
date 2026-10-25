'use strict';
// Private native driver: synthetic paths only. Never load into ordinary Vortex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const input = require('./input.json');
const { actions, selectors, util } = require('@nexusmods/vortex-api');
const root = input.root, G = 'cyberpunk2077', P = 'native-agent-fixture';
const must = (ok, code) => { if (!ok) throw Error(code); };
const norm = p => path.resolve(p).toLowerCase();
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function contained(p) {
  const rel = path.relative(root, p);
  must(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'FIXTURE_PATH_ESCAPE');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) must(!fs.lstatSync(current).isSymbolicLink(), 'FIXTURE_REPARSE_POINT');
  }
  return p;
}
const diskProof = p => {
  contained(p); const s = fs.statSync(p, { bigint: true });
  return { path: p, size: Number(s.size), sha256: sha(p), filesystemId: `${s.dev}:${s.ino}`, links: Number(s.nlink) };
};
const wait = async (fn, code) => {
  const deadline = Date.now() + 45000;
  while (!fn()) { must(Date.now() < deadline, code); await new Promise(r => setTimeout(r, 200)); }
};
const bounded = (promise, code, ms = 90000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]).finally(() => clearTimeout(timer));
};
function native(api, name, args) {
  return bounded(new Promise((resolve, reject) => {
    const cb = (err, value) => err ? reject(Error('NATIVE_EVENT_FAILED_' + name)) : resolve(value);
    try { must(api.events.emit(name, ...args(cb)), 'NO_NATIVE_LISTENER_' + name); } catch (err) { reject(err); }
  }), 'NATIVE_EVENT_TIMEOUT_' + name);
}
function rpc(token, name, args = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request('http://127.0.0.1:3702/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token,
    } }, res => {
      let text = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(Error('HTTP_TOO_LARGE')); else text += chunk; });
      res.on('end', () => {
        try {
          must(res.statusCode === 200, 'FIXTURE_HTTP_STATUS_' + res.statusCode);
          const payload = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'));
          must(!payload.error && !payload.result?.isError, 'FIXTURE_TOOL_ERROR_' + name + '_' + (payload.result?.content?.[0]?.text || 'RPC'));
          resolve(JSON.parse(payload.result.content[0].text));
        } catch (err) { reject(err); }
      });
    });
    req.setTimeout(90000, () => req.destroy(Error('FIXTURE_HTTP_TIMEOUT')));
    req.on('error', reject); req.end(body);
  });
}
module.exports = context => {
  must(process.env.VORTEX_AGENT_NATIVE_FIXTURE === root, 'NOT_FIXTURE_PROCESS');
  context.once(() => { setTimeout(() => { void run(context.api); }, 3000); });
  return true;
};
async function run(api) {
  const receiptPath = contained(path.join(root, 'native-receipt.json'));
  must(!fs.existsSync(receiptPath), 'FIXTURE_ALREADY_ATTEMPTED');
  const receipt = { status: 'running', rendererPid: process.pid, started: new Date().toISOString(), events: [], nexusReuse: { status: 'skipped', reason: 'Local import has no legitimate Nexus IDs; no synthetic IDs fabricated.' } };
  function save() { const h = fs.openSync(receiptPath, 'w'); try { fs.writeFileSync(h, JSON.stringify(receipt, null, 2)); fs.fsyncSync(h); } finally { fs.closeSync(h); } }
  function note(phase, data = {}) { receipt.events.push({ phase, at: new Date().toISOString(), ...data }); save(); }
  function boundary(active = true) {
    must(norm(process.env.NEXUS_WORKSPACE) === norm(root), 'FIXTURE_WORKSPACE_MISMATCH');
    must(process.env.VORTEX_E2E === '1' && process.env.VORTEX_E2E_HEADLESS === '1', 'E2E_REQUIRED');
    must(norm(util.getVortexPath('userData')) === norm(input.userData), 'ACTUAL_USERDATA_MISMATCH');
    must(norm(process.env.ELECTRON_USERDATA) === norm(input.earlyData), 'EARLY_USERDATA_MISMATCH');
    must(norm(process.env.ELECTRON_APPDATA) === norm(path.join(root, 'appdata')), 'APPDATA_MISMATCH');
    const s = api.getState();
    for (const [id, d] of Object.entries(s.settings.gameMode.discovered || {})) if (d.path) must(id === G && norm(d.path) === norm(input.game), 'EXTERNAL_DISCOVERY');
    if (active) {
      must(selectors.activeProfileId(s) === P && selectors.activeGameId(s) === G, 'ACTIVE_CONTEXT_MISMATCH');
      must(norm(selectors.installPathForGame(s, G)) === norm(input.stage), 'STAGING_MISMATCH');
      must(norm(selectors.downloadPathForGame(s, G)) === norm(input.downloads), 'DOWNLOADS_MISMATCH');
    }
    for (const p of [input.userData, input.earlyData, input.game, input.stage, input.downloads]) contained(p);
  }
  let listener;
  try {
    boundary(false); save();
    await wait(() => util.getGames().filter(g => g.id === G).length === 1 && typeof api.ext.awaitModsDeployment === 'function', 'PROVIDER_TIMEOUT');
    must(Object.keys(api.getState().persistent.profiles || {}).length === 0, 'NONEMPTY_FIXTURE_PROFILES');
    must(Object.keys(api.getState().persistent.mods?.[G] || {}).length === 0, 'NONEMPTY_FIXTURE_MODS');
    for (const name of ['setAutoDeployment', 'setAutoInstall', 'setAutoEnable', 'setAutoStart', 'setConfirmPurge']) api.store.dispatch(actions[name](false));
    api.store.dispatch(actions.addDiscoveredGame(G, { path: input.game, pathSetManually: true, store: 'steam', executable: 'bin/x64/Cyberpunk2077.exe' }));
    api.store.dispatch(actions.setInstallPath(G, input.stage));
    api.store.dispatch(actions.setDownloadPath(path.join(root, 'downloads')));
    api.store.dispatch(actions.setActivator(G, 'hardlink_activator'));
    api.store.dispatch(actions.setProfile({ id: P, gameId: G, name: 'PRIVATE Synthetic Agent Fixture', modState: {}, lastActivated: 0, features: {} }));
    api.store.dispatch(actions.setNextProfile(P));
    await wait(() => selectors.activeProfileId(api.getState()) === P, 'PROFILE_ACTIVATION_TIMEOUT');
    boundary();
    const bundle = require('./runtime.cjs');
    const token = crypto.randomBytes(32).toString('hex');
    listener = bundle.start(api, 3702, { tokenProvider: async () => token });
    await bounded(new Promise((resolve, reject) => { if (listener.listening) resolve(); else { listener.once('listening', resolve); listener.once('error', () => reject(Error('FIXTURE_BIND_FAILED'))); } }), 'BIND_TIMEOUT', 10000);
    const health = await rpc(token, 'health');
    must(health.extensionVersion === input.runtimeVersion, 'FIXTURE_RUNTIME_VERSION_MISMATCH');
    note('authenticated-native-health', { health, listenerPort: 3702 });
    const target = contained(path.join(input.game, input.payloadPath));
    must(sha(target) === input.sentinelSha256, 'SENTINEL_BASELINE_MISMATCH');
    const ids = await native(api, 'import-downloads', cb => [[input.archive], values => cb(null, values), true]);
    boundary(); must(Array.isArray(ids) && ids.length === 1, 'IMPORT_COUNT_MISMATCH');
    const downloadId = ids[0];
    await wait(() => api.getState().persistent.downloads.files[downloadId]?.state === 'finished', 'DOWNLOAD_FINISHED_TIMEOUT');
    const record = api.getState().persistent.downloads.files[downloadId];
    must(record.game?.length === 1 && record.game[0] === G, 'IMPORTED_GAME_MISMATCH');
    const archive = contained(path.join(input.downloads, record.localPath));
    must(path.dirname(norm(archive)) === norm(input.downloads) && sha(archive) === input.archiveSha256 && fs.statSync(archive).size === input.archiveSize, 'IMPORTED_ARCHIVE_MISMATCH');
    note('native-import-finished', { downloadId, archive: diskProof(archive), trackedDownloadCount: Object.keys(api.getState().persistent.downloads.files).length });
    boundary(); must(Object.keys(api.getState().persistent.mods?.[G] || {}).length === 0, 'INSTALL_COLLISION');
    const modId = await native(api, 'start-install-download', cb => [downloadId, { allowAutoEnable: false, profileId: P }, cb]);
    boundary();
    const mod = api.getState().persistent.mods[G][modId];
    must(mod?.state === 'installed' && mod.archiveId === downloadId, 'INSTALLED_RECORD_MISMATCH');
    must(api.getState().persistent.profiles[P].modState[modId]?.enabled !== true, 'INSTALL_AUTO_ENABLED');
    const staged = contained(path.join(input.stage, mod.installationPath, input.payloadPath));
    must(sha(staged) === input.payloadSha256 && sha(target) === input.sentinelSha256, 'INSTALL_ONLY_BYTES_MISMATCH');
    note('native-install-only', { modId, installationPath: mod.installationPath, downloadId, staged: diskProof(staged), original: diskProof(target) });
    async function operation(name, suffix, extra = {}) {
      boundary(); const h = await rpc(token, 'health');
      for (const [key, expected] of Object.entries({ gameId: G, profileId: P, gamePath: input.game, stagingPath: input.stage, downloadPath: input.downloads })) must(key.endsWith('Path') ? norm(h[key]) === norm(expected) : h[key] === expected, 'HTTP_HEALTH_PIN_DRIFT');
      const pins = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, h[k]]));
      const result = await rpc(token, name, { ...pins, requestId: input.runId + '_' + suffix, ...extra });
      boundary(); must(result.operationCompleted === true, 'OPERATION_NOT_COMPLETED'); note(name + '_' + suffix, { result, pins });
    }
    await operation('set_mods_enabled', 'enable', { modIds: [modId], enabled: true });
    await operation('deploy_mods', 'deploy');
    const manifestPath = contained(path.join(input.game, 'vortex.deployment.json'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    must(manifest.gameId === G && norm(manifest.targetPath) === norm(input.game) && norm(manifest.stagingPath) === norm(input.stage), 'MANIFEST_PATH_MISMATCH');
    const entry = manifest.files.find(f => f.relPath.replace(/\\/g, '/') === input.payloadPath);
    must(entry?.source === mod.installationPath && manifest.files.length === 1, 'MANIFEST_OWNER_MISMATCH');
    const a = diskProof(target), b = diskProof(staged), backup = diskProof(target + '.vortex_backup');
    must(a.sha256 === input.payloadSha256 && b.sha256 === a.sha256 && a.filesystemId === b.filesystemId && a.links >= 2, 'HARDLINK_DEPLOYMENT_UNPROVEN');
    must(backup.sha256 === input.sentinelSha256, 'ORIGINAL_BACKUP_MISMATCH');
    note('independent-disk-deployment-proof', { manifest, manifestSha256: sha(manifestPath), game: a, staging: b, backup });
    await operation('set_mods_enabled', 'disable', { modIds: [modId], enabled: false });
    await operation('deploy_mods', 'restore');
    must(sha(target) === input.sentinelSha256 && !fs.existsSync(target + '.vortex_backup'), 'ORIGINAL_NOT_RESTORED');
    // Native activationStore removes the deployment manifest when no files remain.
    const restored = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [], manifestAbsent: true };
    must(restored.files.length === 0 && sha(staged) === input.payloadSha256, 'RESTORED_MANIFEST_MISMATCH');
    must(Object.keys(api.getState().persistent.downloads.files).length === 1 && Object.keys(api.getState().persistent.mods[G]).length === 1, 'DUPLICATE_RECORDS');
    note('independent-rollback-proof', { original: diskProof(target), staging: diskProof(staged), manifest: restored, enabled: api.getState().persistent.profiles[P].modState[modId].enabled, trackedDownloads: 1, installedMods: 1 });
    receipt.status = 'passed';
  } catch (err) {
    receipt.status = 'failed'; receipt.error = String(err.message).slice(0, 1000);
  } finally {
    receipt.finished = new Date().toISOString(); save();
    if (listener) listener.close();
    // Window close follows the host's normal persistence/finalization path.
    try {
      const ipc = require('electron').ipcRenderer;
      const response = await ipc.invoke('window:getId');
      const id = typeof response === 'number' ? response : response.data;
      must(Number.isInteger(id) && id > 0, 'WINDOW_ID_INVALID');
      note('graceful-fixture-window-close-request', { windowId: id });
      await ipc.invoke('window:close', id);
    } catch { note('graceful-close-unavailable'); }
  }
}
