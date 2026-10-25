'use strict';
const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { safe } = require('./serialization.cjs');
const downloads = require('./download-identity.cjs');
const receipts = require('./receipts.cjs');
const RECEIPTS = require('./paths.cjs').receipts;
const PROTOCOL = 'vortex-agent/1';
const processes = Object.freeze({
  cyberpunk2077: ['Cyberpunk2077.exe', 'REDprelauncher.exe'],
  assassinscreedunity: ['ACU.exe'],
  skyrimse: ['SkyrimSE.exe', 'skse64_loader.exe'],
  skyrimvr: ['SkyrimVR.exe', 'sksevr_loader.exe'],
  fallout4: ['Fallout4.exe', 'f4se_loader.exe'],
});
function insist(ok, code) { if (!ok) throw new Error(code); }
function effectiveEnabled(state, profileId, modId) { return state.persistent?.profiles?.[profileId]?.modState?.[modId]?.enabled === true; }
const PROCESS_SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  # Absolute built-in module path avoids inherited PowerShell 7 PSModulePath.
  Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  $items = [System.Diagnostics.Process]::GetProcesses()
  try {
    [string[]] $names = @(foreach ($item in $items) { $item.ProcessName + '.exe' })
  } finally { foreach ($item in $items) { $item.Dispose() } }
  @{schema=1; complete=$true; count=$names.Length; names=$names} | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -Depth 3
  exit 0
} catch {
  [Console]::Error.WriteLine('PROCESS_ENUMERATION_FAILED')
  exit 1
}`;
function processNames() {
  try {
    const windows = process.env.SystemRoot;
    insist(typeof windows === 'string' && /^[a-z]:\\[^<>:"|?*\x00-\x1f]+$/i.test(windows)
      && path.win32.normalize(windows) === windows, 'PROCESS_LIST_UNVERIFIABLE');
    const exe = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROCESS_SNAPSHOT_SCRIPT, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    insist(!result.error && result.status === 0 && !result.signal && typeof result.stdout === 'string'
      && typeof result.stderr === 'string' && result.stderr.trim() === '', 'PROCESS_LIST_UNVERIFIABLE');
    const snapshot = JSON.parse(result.stdout);
    insist(snapshot && !Array.isArray(snapshot) && Object.keys(snapshot).sort().join(',') === 'complete,count,names,schema'
      && snapshot.schema === 1 && snapshot.complete === true && Array.isArray(snapshot.names)
      && Number.isInteger(snapshot.count) && snapshot.count > 0 && snapshot.count <= 65536
      && snapshot.names.length === snapshot.count
      && snapshot.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 260
        && !/[\\/\x00-\x1f\x7f]/.test(name)), 'PROCESS_LIST_UNVERIFIABLE');
    return snapshot.names.map(name => name.toLowerCase());
  } catch { throw new Error('PROCESS_LIST_UNVERIFIABLE'); }
}
function stopped(state, gameId) {
  insist(process.platform === 'win32', 'WINDOWS_PROCESS_CHECK_REQUIRED');
  insist(processes[gameId], 'UNSUPPORTED_GAME_PROCESS_GUARD');
  insist(Object.keys(state.session?.base?.toolsRunning || {}).length === 0, 'GAME_OR_TOOL_RUNNING');
  const names = processNames();
  insist(!processes[gameId].some(name => names.includes(name.toLowerCase())), 'GAME_RUNNING');
}
function context(api, selectors) {
  const state = api.getState();
  const profileId = selectors.activeProfileId(state);
  const gameId = selectors.activeGameId(state);
  const result = { gameId, profileId, gamePath: state.settings?.gameMode?.discovered?.[gameId]?.path,
    stagingPath: gameId ? selectors.installPathForGame(state, gameId) : undefined,
    downloadPath: gameId ? selectors.downloadPathForGame(state, gameId) : undefined };
  result.filesystemIds = {};
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) {
    if (result[key] !== undefined) {
      insist(path.isAbsolute(result[key]), 'ABSOLUTE_PATH_REQUIRED');
      result[key] = disk.realpathSync(result[key]);
      result.filesystemIds[key] = identity(result[key]);
    }
  }
  return result;
}
function identity(file) { const stat = disk.statSync(file, { bigint: true }); insist(stat.isDirectory(), 'PATH_NOT_DIRECTORY'); return `${stat.dev}:${stat.ino}`; }
function normalized(p) { return path.resolve(p).toLowerCase(); }
function assertContext(api, selectors, args, stop = stopped) {
  const live = context(api, selectors);
  insist(live.gameId === args.gameId && live.profileId === args.profileId
    && api.getState().persistent?.profiles?.[args.profileId]?.gameId === args.gameId, 'STALE_ACTIVE_CONTEXT');
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) {
    insist(typeof live[key] === 'string' && typeof args[key] === 'string' && path.isAbsolute(args[key])
      && normalized(live[key]) === normalized(args[key])
      && normalized(disk.realpathSync(args[key])) === normalized(args[key]), 'PATH_PIN_MISMATCH');
    insist(args.filesystemIds?.[key] === live.filesystemIds[key], 'FILESYSTEM_IDENTITY_MISMATCH');
  }
  stop(api.getState(), args.gameId);
  return live;
}
async function digest(file) {
  const { createReadStream } = require('node:fs');
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function archive(api, args, id, selectors = {}, catalog) {
  const record = api.getState().persistent?.downloads?.files?.[id];
  const resolved = downloads.resolveDownload(record, api.getState(), selectors, catalog);
  insist(record?.state === 'finished' && !resolved.ambiguous && resolved.gameId === args.gameId, 'DOWNLOAD_NOT_SINGLE_GAME');
  insist(typeof record.localPath === 'string', 'DOWNLOAD_PATH_MISSING');
  const file = path.resolve(args.downloadPath, record.localPath);
  const real = await fs.realpath(file), root = await fs.realpath(args.downloadPath);
  insist(path.dirname(normalized(real)) === normalized(root), 'DOWNLOAD_PATH_ESCAPE');
  const stat = await fs.stat(real);
  insist(stat.isFile() && stat.size === args.size && await digest(real) === args.sha256, 'PACKAGE_PIN_MISMATCH');
  return record;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function durable(file, value) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}
async function commitCompletion(file, value) {
  // A final name is never visible before the bytes are fsynced. link() is an
  // atomic no-overwrite publication (rename() could overwrite an old request).
  const pending = file + '.pending-' + crypto.randomUUID();
  await durable(pending, value);
  await fs.link(pending, file);
  await fs.unlink(pending);
}
function modIdentity(state, gameId, id) {
  const mod = state.persistent?.mods?.[gameId]?.[id];
  insist(mod?.state === 'installed', 'MOD_NOT_INSTALLED');
  return JSON.stringify([mod.id ?? id, mod.state, mod.installationPath ?? null, mod.archiveId ?? null, mod.type ?? null,
    mod.attributes?.modId ?? null, mod.attributes?.fileId ?? null, mod.attributes?.version ?? null, mod.attributes?.installTime ?? null]);
}
// Atomic filesystem exclusion spans renderer processes and all bridge clients. Never
// steal a stale lock: a missing callback may still represent an in-flight mutation.
async function exclusive(dir, fn) {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'mutation.lock');
  let handle;
  const deadline = Date.now() + 30000;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; insist(Date.now() < deadline, 'MUTATION_BUSY_INSPECT_RECEIPTS'); await sleep(50); }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
function createOperations(api, actions, selectors, options = {}) {
  const dir = options.receipts || RECEIPTS;
  const sanitize = (value, kind) => safe(value, api, kind, options.credentials || []);
  const check = args => assertContext(api, selectors, args, options.stopped || stopped);
  const catalog = options.catalog;
  const flags = args => Object.fromEntries(Object.entries(api.getState().persistent?.profiles?.[args.profileId]?.modState || {})
    .map(([id, item]) => [id, item.enabled === true]));
  const unchangedFlags = (args, before, allowed = []) => {
    const after = flags(args);
    insist([...new Set([...Object.keys(before), ...Object.keys(after)])].every(id => allowed.includes(id)
      || (before[id] === true) === (after[id] === true)), 'OTHER_ENABLED_FLAGS_CHANGED');
  };
  async function mutate(name, args, run) {
    return exclusive(dir, async () => {
      try { await fs.access(path.join(dir, 'unresolved.json')); throw new Error('UNRESOLVED_OPERATION_INTERLOCK'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      check(args);
      insist(/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId || ''), 'INVALID_REQUEST_ID');
      const attempt = path.join(dir, args.requestId + '.attempt.json');
      const receipt = sanitize({ protocol: PROTOCOL, receiptVersion: receipts.VERSION, operation: name,
        requestId: args.requestId, gameId: args.gameId, profileId: args.profileId,
        parameters: args, at: new Date().toISOString() }, 'receipt');
      insist(receipts.validAttempt(receipt), 'INVALID_ATTEMPT_RECEIPT');
      await durable(attempt, receipt);
      let effects = false, armed = false;
      const effect = async (fn, eligible = () => {}) => {
        await durable(path.join(dir, 'unresolved.json'), receipt); armed = true;
        // Synchronous realpath/identity + active context + Windows process checks,
        // immediately followed by invocation: no further awaits before the effect.
        check(args); eligible(); effects = true;
        return fn();
      };
      try {
        const result = await run(effect);
        check(args);
        const status = { protocol: PROTOCOL, requestId: args.requestId, operation: name,
          operationCompleted: true, diskDeploymentVerified: false,
          verificationRequired: receipts.VERIFICATION, ...result };
        const publicStatus = sanitize(status, 'operation_status');
        const completion = sanitize({ ...status, receiptVersion: receipts.VERSION, gameId: args.gameId, profileId: args.profileId, at: new Date().toISOString() }, 'receipt');
        insist(receipts.validCompletion(completion, receipt), 'INVALID_COMPLETION_RECEIPT');
        await commitCompletion(path.join(dir, args.requestId + '.completion.json'), completion);
        if (armed) await fs.unlink(path.join(dir, 'unresolved.json'));
        return publicStatus;
      } catch (error) {
        // Deliberately exclude upstream exception text (may contain authenticated URLs).
        await durable(path.join(dir, args.requestId + '.failed.json'), sanitize({
          protocol: PROTOCOL, receiptVersion: receipts.VERSION, requestId: args.requestId, operation: name, gameId: args.gameId, profileId: args.profileId,
          operationCompleted: false, effectsMayHaveOccurred: effects, inspectBeforeRetry: effects,
          errorCode: /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UPSTREAM_FAILURE',
          at: new Date().toISOString(),
        }, 'receipt'));
        if (armed && !effects) await fs.unlink(path.join(dir, 'unresolved.json'));
        throw error;
      }
    });
  }
  return {
    health: () => ({ protocol: PROTOCOL, extensionVersion: '1.0.4', targetVortexVersion: '2.7.2.0', ...context(api, selectors),
      security: 'per-user-DPAPI-bearer', installSupported: false, diskDeploymentVerified: false }),
    install_download: args => mutate('install_download', args, async () => {
      await archive(api, args, args.downloadId, selectors, catalog); check(args);
      // v2.7.2 InstallManager can silently replace by newestFileId/Nexus identity,
      // archive-derived ID, remembered choice, or one-profile auto-replace. There
      // is no verified nonreplacement install contract. Refuse ALL native installs
      // (including an empty inventory) instead of claiming preflight guarantees.
      insist(false, 'INSTALL_DISABLED_NONREPLACEMENT_NOT_PROVABLE');
    }),
    set_mods_enabled: args => mutate('set_mods_enabled', args, async effect => {
      const before = flags(args);
      const identities = args.modIds.map(id => modIdentity(api.getState(), args.gameId, id));
      const eligible = () => insist(args.modIds.every((id, index) => modIdentity(api.getState(), args.gameId, id) === identities[index]), 'MOD_RECORD_CHANGED');
      const changed = args.modIds.filter(id => effectiveEnabled(api.getState(), args.profileId, id) !== args.enabled);
      if (changed.length) await effect(() => actions.setModsEnabled(api, args.profileId, changed, args.enabled,
        { allowAutoDeploy: false, reason: 'user_manual', installed: true }), eligible);
      check(args);
      eligible();
      insist(args.modIds.every(id => effectiveEnabled(api.getState(), args.profileId, id) === args.enabled), 'ENABLED_FLAGS_UNVERIFIED');
      unchangedFlags(args, before, args.modIds);
      return { modIds: args.modIds, enabled: args.enabled, enabledFlagsVerified: true };
    }),
    deploy_mods: args => mutate('deploy_mods', args, async effect => {
      const before = flags(args);
      insist(typeof api.ext.awaitModsDeployment === 'function', 'DEPLOY_API_UNAVAILABLE');
      await effect(() => api.ext.awaitModsDeployment(args.profileId));
      check(args);
      unchangedFlags(args, before);
      return { deploymentPromiseResolved: true };
    }),
    download_nexus: args => mutate('download_nexus', args, async effect => {
      const before = flags(args);
      const installedBefore = JSON.stringify(Object.entries(api.getState().persistent?.mods?.[args.gameId] || {})
        .map(([id, mod]) => [id, mod.state, mod.archiveId]).sort());
      const matchesNow = () => { const state = api.getState(); return downloads.matchingDownloads(state.persistent?.downloads?.files || {}, args, state, selectors, catalog); };
      const matches = matchesNow();
      let id = matches[0]?.[0];
      const reused = !!id;
      if (!id) {
        insist(args.reuseOnly !== true, 'REUSE_ONLY_DOWNLOAD_NOT_FOUND');
        insist(typeof api.ext.nexusDownload === 'function', 'NEXUS_API_UNAVAILABLE');
        id = await effect(() => api.ext.nexusDownload(args.gameId, args.nexusModId, args.nexusFileId, undefined, false),
          () => insist(matchesNow().length === 0, 'DOWNLOAD_PREFLIGHT_CHANGED'));
        check(args);
      }
      insist(typeof id === 'string' && id.length > 0, 'DOWNLOAD_ID_MISSING');
      const initializedBy = Date.now() + (options.initializationGraceMs ?? 5000);
      let observed = false;
      // No timeout releases the mutation lock while a download is still in progress.
      while (true) {
        check(args);
        const item = api.getState().persistent?.downloads?.files?.[id];
        if (!item) {
          insist(!observed && Date.now() < initializedBy, 'DOWNLOAD_RECORD_MISSING');
          await sleep(options.pollIntervalMs ?? 500); continue;
        }
        observed = true;
        insist(downloads.ACTIVE.has(item.state) || downloads.TERMINAL.has(item.state), 'DOWNLOAD_STATE_UNRECOGNIZED');
        insist(!downloads.TERMINAL.has(item.state) || item.state === 'finished', 'DOWNLOAD_REQUIRES_USER_ATTENTION');
        if (item?.state === 'finished') break;
        await sleep(options.pollIntervalMs ?? 500);
      }
      await archive(api, args, id, selectors, catalog); check(args);
      insist(matchesNow()[0]?.[0] === id, 'NEXUS_IDS_MISMATCH');
      unchangedFlags(args, before);
      insist(installedBefore === JSON.stringify(Object.entries(api.getState().persistent?.mods?.[args.gameId] || {})
        .map(([id, mod]) => [id, mod.state, mod.archiveId]).sort()), 'DOWNLOAD_INSTALLED_RECORDS_CHANGED');
      return { downloadId: id, reused, archiveSha256Verified: true, size: args.size, autoInstall: false,
        archiveCRCVerified: false };
    }),
    reconcile_operation: async args => {
      insist(/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId || ''), 'INVALID_REQUEST_ID');
      const issues = [];
      const read = async name => {
        let handle;
        try { handle = await fs.open(path.join(dir, name), 'r'); const bytes = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          insist(bytesRead <= 1024 * 1024, 'RECEIPT_LIMIT'); return { observed: true, value: JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) }; }
        catch (error) { if (error.code === 'ENOENT') return { observed: false, value: null }; issues.push('INVALID_RECEIPT'); return { observed: true, value: null }; }
        finally { if (handle) await handle.close(); }
      };
      const a = await read(args.requestId + '.attempt.json'), c = await read(args.requestId + '.completion.json'), f = await read(args.requestId + '.failed.json'), u = await read('unresolved.json');
      const attempt = receipts.validAttempt(a.value) && a.value.requestId === args.requestId ? a.value : null;
      const completion = receipts.validCompletion(c.value, attempt) ? c.value : null;
      const failure = attempt && receipts.validFailure(f.value, attempt) ? f.value : null;
      const interlock = receipts.validAttempt(u.value) ? u.value : null;
      if (a.observed && !attempt || c.observed && !completion || f.observed && !failure || u.observed && !interlock) issues.push('RECEIPT_SCHEMA_OR_IDENTITY_INVALID');
      if (c.observed && f.observed) issues.push('CONFLICTING_TERMINAL_RECEIPTS');
      let incomplete = false, entries = 0;
      try { for await (const entry of await fs.opendir(dir)) { insist(++entries <= 10000, 'RECEIPT_DIRECTORY_LIMIT');
        if (entry.name.startsWith(args.requestId + '.completion.json.pending-')) incomplete = true; } }
      catch (error) { if (error.code !== 'ENOENT') issues.push('RECEIPT_DIRECTORY_UNVERIFIABLE'); }
      if (incomplete) issues.push('INCOMPLETE_COMPLETION_COMMIT');
      const state = api.getState();
      const enabledFlags = attempt?.operation === 'set_mods_enabled' ? (attempt.parameters.modIds || []).map(modId => ({
        modId, installed: state.persistent?.mods?.[attempt.gameId]?.[modId]?.state === 'installed',
        enabled: effectiveEnabled(state, attempt.profileId, modId),
        requested: attempt.parameters.enabled,
        requestedFlagObserved: effectiveEnabled(state, attempt.profileId, modId) === attempt.parameters.enabled,
      })) : [];
      const deployment = attempt?.operation === 'deploy_mods' ? {
        needToDeploy: state.persistent?.deployment?.needToDeploy?.[attempt.gameId] ?? null,
        diskDeploymentVerified: false,
      } : null;
      let download = [];
      if (attempt?.operation === 'download_nexus') {
        try { download = downloads.matchingDownloads(state.persistent?.downloads?.files || {}, attempt.parameters, state, selectors, catalog)
          .map(([id, d]) => ({ id, state: d.state, terminalObserved: downloads.TERMINAL.has(d.state) })); }
        catch { issues.push('DOWNLOAD_IDENTITY_UNVERIFIABLE'); }
      }
      return { protocol: PROTOCOL, attempt, completion, failure, interlock, download, enabledFlags, deployment,
        receiptIssues: [...new Set(issues)], incompleteCompletionObserved: incomplete,
        adapterTerminalReceiptObserved: c.observed || f.observed,
        terminalOperationVerified: !!completion && issues.length === 0 && !f.observed, interlockCleared: false,
        instruction: 'Read-only reconciliation. An unresolved effect is never auto-cleared; primary must reconcile Vortex UI/log and disk evidence, stop Vortex, then explicitly archive the exact interlock with its receipts.' };
    },
  };
}
module.exports = { PROTOCOL, RECEIPTS, safe, processNames, stopped, context, assertContext, exclusive, createOperations, insist, normalized, identity, durable, commitCompletion, effectiveEnabled };
