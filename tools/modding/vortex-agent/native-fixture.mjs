#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remote } from './bridge.mjs';
import paths from './paths.cjs';
import credential from './credential.cjs';
import { ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot } from './native-fixture-snapshot.mjs';
const base = path.join(paths.workspace, 'local-state/vortex-agent-native-fixture');
const here = path.dirname(fileURLToPath(import.meta.url));
const must = (ok, code) => { if (!ok) throw Error(code); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
async function tool(name, args = {}) {
  const ordinaryIndex = process.argv.indexOf('--ordinary-workspace');
  const ordinary = ordinaryIndex >= 0 ? paths.resolvePaths({ env: {
    NEXUS_WORKSPACE: paths.absolute(process.argv[ordinaryIndex + 1], 'ORDINARY_WORKSPACE'),
  } }) : paths;
  const result = await remote('tools/call', { name, arguments: args }, fetch,
    () => credential.readToken(ordinary.credentials));
  must(!result.isError, 'ORDINARY_READ_FAILED'); return JSON.parse(result.content[0].text);
}
function processes() {
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'Vortex.exe'" | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;exe=$_.ExecutablePath;type=([regex]::Match($_.CommandLine,'--type=([^ ]+)').Groups[1].Value)} } | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 }));
}
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(name, data) {
  const n = Buffer.from(name), crc = crc32(data), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  const first = Buffer.concat([local, n, data]), second = Buffer.concat([central, n]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(second.length, 12); end.writeUInt32LE(first.length, 16);
  return Buffer.concat([first, second, end]);
}
async function snapshot() {
  const health = await tool('health'), profiles = await tool('list_profiles', { gameId: 'cyberpunk2077' });
  const mods = await tool('list_mods', { gameId: 'cyberpunk2077', limit: ORDINARY_MOD_LIMIT });
  assertOrdinaryModSnapshot(mods);
  const manifestPath = path.join(health.gamePath, 'vortex.deployment.json');
  return { health, profiles, mods, manifestPath, manifestSha256: sha(fs.readFileSync(manifestPath)), processes: processes() };
}
async function main() {
  must(process.platform === 'win32' && process.argv[2] === '--run', 'USAGE_native-fixture.mjs_--run_--support-extension_PATH_--support-index-sha256_SHA');
  const supportIndex = process.argv.indexOf('--support-extension');
  const hashIndex = process.argv.indexOf('--support-index-sha256');
  must(supportIndex > 2 && hashIndex > 2 && process.argv[supportIndex + 1]
    && /^[a-f0-9]{64}$/.test(process.argv[hashIndex + 1] || ''), 'EXPLICIT_PINNED_SUPPORT_EXTENSION_REQUIRED');
  const support = paths.absolute(process.argv[supportIndex + 1], 'SUPPORT_EXTENSION');
  for (let p = support; p !== path.dirname(p); p = path.dirname(p)) must(!fs.lstatSync(p).isSymbolicLink(), 'SUPPORT_REPARSE_POINT');
  const supportInfo = JSON.parse(fs.readFileSync(path.join(support, 'info.json'), 'utf8'));
  must(typeof supportInfo.name === 'string' && /cyberpunk.*2077/i.test(supportInfo.name)
    && sha(fs.readFileSync(path.join(support, 'index.js'))) === process.argv[hashIndex + 1], 'SUPPORT_IDENTITY_OR_SOURCE_PIN_MISMATCH');
  must(fs.existsSync(path.dirname(base)), 'FIXTURE_PARENT_MISSING');
  for (let p = path.dirname(base); p !== path.dirname(p); p = path.dirname(p)) must(!fs.lstatSync(p).isSymbolicLink(), 'ANCESTOR_REPARSE_POINT');
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('PORT_3702_OCCUPIED'))); s.listen(3702, '127.0.0.1', () => s.close(resolve)); });
  const before = await snapshot();
  const runId = 'native_' + new Date().toISOString().replace(/[^0-9]/g, '');
  const root = path.join(base, runId);
  fs.mkdirSync(root, { recursive: true });
  write(path.join(root, 'ordinary-before.json'), before);
  const input = { root, runId, adapterReceipts: path.join(root, 'local-state/vortex-agent-build/receipts'), userData: path.join(root, 'userdata'), earlyData: path.join(root, 'early-userdata'), game: path.join(root, 'game'), stage: path.join(root, 'staging'), downloads: path.join(root, 'downloads/cyberpunk2077'), archive: path.join(root, 'inbox/native-agent-synthetic.zip'), payloadPath: 'archive/pc/mod/native_agent_fixture.archive' };
  for (const p of [input.userData, input.earlyData, input.game, input.stage, input.downloads, path.dirname(input.archive), path.join(root, 'appdata/Vortex'), path.join(root, 'localappdata'), path.join(root, 'temp'), path.join(root, 'programdata')]) fs.mkdirSync(p, { recursive: true });
  const payload = Buffer.from('OWN SYNTHETIC VORTEX AGENT PAYLOAD\n'), sentinel = Buffer.from('ORIGINAL SYNTHETIC SENTINEL\n');
  const archive = zip(input.payloadPath, payload);
  fs.writeFileSync(input.archive, archive, { flag: 'wx' });
  input.archiveSha256 = sha(archive); input.archiveSize = archive.length; input.payloadSha256 = sha(payload); input.sentinelSha256 = sha(sentinel); input.zipCRC32 = crc32(payload).toString(16);
  const target = path.join(input.game, input.payloadPath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, sentinel, { flag: 'wx' });
  const exe = path.join(input.game, 'bin/x64/Cyberpunk2077.exe'); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'Synthetic non-executable placeholder. Never launch.\n', { flag: 'wx' });
  const plugins = path.join(input.userData, 'plugins'), driver = path.join(plugins, 'native-agent-fixture'); fs.mkdirSync(driver, { recursive: true });
  const runtimePath = path.join(paths.build, 'plugin/vortex-agent/index.js');
  const original = fs.readFileSync(runtimePath, 'utf8');
  const provenance = JSON.parse(fs.readFileSync(path.join(path.dirname(runtimePath), 'provenance.json'), 'utf8'));
  must(provenance.version === '1.1.0' && provenance.pluginSha256 === sha(Buffer.from(original)), 'FIXTURE_SOURCE_PROVENANCE_MISMATCH');
  input.runtimeVersion = provenance.version; input.runtimeSourceSha256 = provenance.pluginSha256;
  must(provenance.sources?.['paths.cjs'] && original.includes('module.exports.start = start;'), 'UNEXPECTED_RUNTIME_BUNDLE');
  const runtime = original;
  fs.writeFileSync(path.join(driver, 'runtime.cjs'), runtime, { flag: 'wx' });
  fs.copyFileSync(path.join(here, 'native-fixture-worker.cjs'), path.join(driver, 'index.js'), fs.constants.COPYFILE_EXCL);
  write(path.join(driver, 'input.json'), input);
  write(path.join(driver, 'info.json'), { name: 'Private Native Agent Fixture', author: 'Local fixture', version: '1.0.0', description: 'Synthetic native lifecycle; never load in ordinary Vortex.' });
  const supportDest = path.join(plugins, 'fixture-cyberpunk-support'); fs.mkdirSync(supportDest);
  const supportHashes = {};
  for (const name of ['index.js', 'info.json', 'LICENSE', 'gameart.png', 'gameicon.jpg', 'REDdeploy.png', 'REDLauncher.png', 'SaveEditor.jpg']) { const src = path.join(support, name); must(!fs.lstatSync(src).isSymbolicLink(), 'SUPPORT_REPARSE_POINT'); fs.copyFileSync(src, path.join(supportDest, name), fs.constants.COPYFILE_EXCL); supportHashes[name] = sha(fs.readFileSync(src)); must(sha(fs.readFileSync(path.join(supportDest, name))) === supportHashes[name], 'SUPPORT_COPY_CHANGED'); }
  must(supportHashes['index.js'] === process.argv[hashIndex + 1], 'SUPPORT_SOURCE_CHANGED_DURING_COPY');
  write(path.join(root, 'prepared.json'), { ...input, runtimeSourceSha256: sha(Buffer.from(original)), fixtureRuntimeSha256: sha(Buffer.from(runtime)), runtimeModification: 'None; fixture-only NEXUS_WORKSPACE isolates receipts; public start(api,3702).', supportHashes, sourcePin: '41be6d4556568a605d6131b8c5ca90ff26dec6ac' });
  const env = { ...process.env, NEXUS_WORKSPACE: root, VORTEX_E2E: '1', VORTEX_E2E_HEADLESS: '1', VORTEX_ENABLE_LOGGING: '1', ELECTRON_USERDATA: input.earlyData, ELECTRON_APPDATA: path.join(root, 'appdata'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), ProgramData: path.join(root, 'programdata'), VORTEX_AGENT_NATIVE_FIXTURE: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data', input.userData, '--start-minimized'];
  const log = fs.openSync(path.join(root, 'process-output.log'), 'wx');
  const mains = before.processes.filter(p => !p.type);
  must(mains.length === 1 && mains[0].exe && path.isAbsolute(mains[0].exe), 'ORDINARY_VORTEX_EXECUTABLE_UNVERIFIABLE');
  const vortexExe = mains[0].exe;
  const child = spawn(vortexExe, args, { env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  write(path.join(root, 'process.json'), { pid: child.pid, executable: vortexExe, args, ordinaryPids: before.processes.map(p => p.pid), started: new Date().toISOString() });
  console.log(JSON.stringify({ root, fixturePid: child.pid, ordinaryMainPids: before.processes.filter(p => !p.type).map(p => p.pid) }));
  let exited = false; child.once('exit', () => { exited = true; }); child.once('error', () => { exited = true; });
  const deadline = Date.now() + 240000;
  while (!exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
  if (!exited) child.unref();
  const receiptPath = path.join(root, 'native-receipt.json');
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath)) : { status: 'missing' };
  const after = await snapshot(); write(path.join(root, 'ordinary-after.json'), after);
  const ordinaryUnchanged = JSON.stringify(before.health) === JSON.stringify(after.health) && JSON.stringify(before.profiles) === JSON.stringify(after.profiles) && JSON.stringify(before.mods) === JSON.stringify(after.mods) && before.manifestSha256 === after.manifestSha256 && before.processes.every(p => after.processes.some(a => a.pid === p.pid));
  const result = { root, nativeStatus: receipt.status, fixtureExited: exited, ordinaryUnchanged, ordinaryManifestSha256: after.manifestSha256, error: receipt.error, remainingFixturePids: after.processes.filter(p => p.pid === child.pid || p.parent === child.pid).map(p => p.pid) };
  write(path.join(root, 'runner-result.json'), result); console.log(JSON.stringify(result));
  // No forced termination: preserve failed evidence and identify the exact fixture PID.
  must(exited && receipt.status === 'passed' && ordinaryUnchanged, 'NATIVE_FIXTURE_INCOMPLETE_INSPECT_RECEIPTS');
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
