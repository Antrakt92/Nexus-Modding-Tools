import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import disk from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {waitForServerListening, closeOwnedTestServer} from './http-startup-test-support.mjs';
const require = createRequire(import.meta.url);
const guard = require('./guard.cjs');
const inspection = require('./inspection.cjs');
const ROOT = paths.build + '/tests';
await fs.mkdir(ROOT, { recursive: true });

test('audit: HTTP parser rejects malformed UTF-8 instead of altering tool arguments', async () => {
  const ingress = require('./http-ingress.cjs');
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3])]) {
    const input = new PassThrough();
    const parsed = ingress.body(input, new AbortController().signal);
    input.end(Buffer.concat([Buffer.from('{"modId":"'), bytes, Buffer.from('"}') ]));
    await assert.rejects(parsed, error => error.message === 'HTTP_BODY_INVALID' && error.status === 400);
  }
  const input = new PassThrough(), parsed = ingress.body(input, new AbortController().signal);
  for (const byte of Buffer.from('{"modId":"проверка"}')) input.write(Buffer.from([byte]));
  input.end();
  assert.deepEqual(await parsed, { modId: 'проверка' });
});
async function fixture(hook = async () => {}) {
  const dir = await fs.mkdtemp(path.join(ROOT, 'audit-'));
  const state = { settings: { gameMode: { discovered: { cyberpunk2077: { path: dir } } } }, persistent: {
    profiles: { p: { gameId: 'cyberpunk2077', modState: {} } },
    mods: { cyberpunk2077: { m: { id: 'm', state: 'installed', installationPath: 'm', archiveId: 'original' } } }, downloads: { files: {} } } };
  const api = { getState: () => state, store: { getState: () => state }, ext: {} };
  const selectors = { activeGameId: () => 'cyberpunk2077', activeProfileId: () => 'p',
    knownGames: () => [{ id: 'cyberpunk2077' }, { id: 'skyrimse', details: { nexusPageId: 'skyrimspecialedition' } }, { id: 'skyrimvr', details: { nexusPageId: 'skyrimspecialedition' } }],
    installPathForGame: () => dir, downloadPathForGame: () => dir };
  let calls = 0, abort = false;
  const actions = { setModsEnabled: async () => { calls++; state.persistent.profiles.p.modState.m = { enabled: true }; } };
  const monitored = { ...fs, open: async (...a) => { const h = await fs.open(...a); return {
    stat: (...args) => h.stat(...args), createReadStream: (...args) => h.createReadStream(...args),
    writeFile: (...args) => h.writeFile(...args), read: (...args) => h.read(...args), close: () => h.close(), sync: async () => { await hook(a[0], state); await h.sync(); } }; } };
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8') + '\n})')(
    id => id === 'node:fs/promises' ? monitored : require(id), module, module.exports);
  const options = { receipts: path.join(dir, 'receipts'), stopped: () => { if (abort) throw Error('PROBE_CLEANUP'); }, pollIntervalMs: 5, initializationGraceMs: 15,
    catalog: () => [{ id: 3333, domain_name: 'cyberpunk2077' }, { id: 1704, domain_name: 'skyrimspecialedition' }] };
  const ops = module.exports.createOperations(api, actions, selectors, options);
  const args = { gameId: 'cyberpunk2077', profileId: 'p', requestId: crypto.randomUUID(), gamePath: dir, stagingPath: dir, downloadPath: dir,
    filesystemIds: { gamePath: guard.identity(dir), stagingPath: guard.identity(dir), downloadPath: guard.identity(dir) } };
  return { dir, state, api, selectors, actions, options, ops, args, calls: () => calls, abort: () => { abort = true; } };
}
async function pinned(f, record = {}) {
  const bytes = Buffer.from('original synthetic archive'); await fs.writeFile(path.join(f.dir, 'a.zip'), bytes);
  f.state.persistent.downloads.files.d = { game: ['cyberpunk2077'], state: 'finished', localPath: 'a.zip',
    modInfo: { nexus: { ids: { gameId: 'cyberpunk2077', modId: 42, fileId: 43 } } }, ...record };
  return { ...f.args, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), nexusModId: 42, nexusFileId: 43 };
}
for (const terminal of ['missing', 'cancelled', 'canceled', 'removed', 'unknown', 'paused', 'failed', 'redirect']) {
  test(`audit: download ${terminal} settles and retains uncertain interlock`, { timeout: 5000 }, async t => {
    const f = await fixture(); const args = await pinned(f); delete f.state.persistent.downloads.files.d;
    f.api.ext.nexusDownload = async () => { if (terminal !== 'missing') f.state.persistent.downloads.files.d = { state: terminal }; return 'd'; };
    // The operation includes real fsynced receipts. Bound hangs with the test
    // runner, not a 150ms race that mistakes slow disk I/O for a guard failure.
    t.signal.addEventListener('abort', f.abort, { once: true });
    const pending = f.ops.download_nexus(args);
    try { await assert.rejects(pending, e => /DOWNLOAD/.test(e.message)); }
    finally { t.signal.removeEventListener('abort', f.abort); f.abort(); await pending.catch(() => {}); }
    const failed = JSON.parse(await fs.readFile(path.join(f.dir, 'receipts', args.requestId + '.failed.json')));
    assert.equal(failed.effectsMayHaveOccurred, true); await fs.access(path.join(f.dir, 'receipts/unresolved.json'));
    await assert.rejects(fs.access(path.join(f.dir, 'receipts/mutation.lock')));
  });
}
test('audit: target removed or replaced during durable await prevents enable', async () => {
  for (const replacement of [null, 'replacement']) {
    const f = await fixture(async (file, state) => { if (file.endsWith('unresolved.json')) {
      if (replacement === null) delete state.persistent.mods.cyberpunk2077.m; else state.persistent.mods.cyberpunk2077.m.archiveId = replacement;
    } });
    await assert.rejects(f.ops.set_mods_enabled({ ...f.args, modIds: ['m'], enabled: true }), /MOD_NOT_INSTALLED|MOD_RECORD_CHANGED/);
    assert.equal(f.calls(), 0);
  }
});
test('audit: target identity change during action cannot complete', async () => {
  const f = await fixture(); f.actions.setModsEnabled = async () => {
    f.state.persistent.profiles.p.modState.m = { enabled: true }; f.state.persistent.mods.cyberpunk2077.m.archiveId = 'replacement';
  };
  await assert.rejects(f.ops.set_mods_enabled({ ...f.args, modIds: ['m'], enabled: true }), /MOD_RECORD_CHANGED/);
  await fs.access(path.join(f.dir, 'receipts/unresolved.json'));
});
test('audit: nested domain identity without game is reused without network', async () => {
  const f = await fixture(); const args = await pinned(f, { game: undefined });
  f.api.ext.nexusDownload = async () => { throw Error('NETWORK_WOULD_BE_CALLED'); };
  const result = await f.ops.download_nexus({ ...args, reuseOnly: true }); assert.equal(result.reused, true);
});
test('audit: reuseOnly missing candidate never invokes acquisition', async () => {
  const f = await fixture(); const args = await pinned(f); delete f.state.persistent.downloads.files.d;
  let calls = 0; f.api.ext.nexusDownload = async () => { calls++; throw Error('NETWORK_WOULD_BE_CALLED'); };
  await assert.rejects(f.ops.download_nexus({ ...args, reuseOnly: true }), /REUSE_ONLY_DOWNLOAD_NOT_FOUND/); assert.equal(calls, 0);
});
test('audit: inconsistent nested/fallback IDs or numeric/domain game fail closed', async () => {
  for (const info of [ { nexus: { ids: { gameId: 'cyberpunk2077', modId: 42, fileId: 43 } }, modId: 99 },
    { nexus: { ids: { gameId: 'cyberpunk2077', modId: 42, fileId: 43 } }, meta: { gameId: 1704 } } ]) {
    const f = await fixture(); const args = await pinned(f, { modInfo: info }); let calls = 0;
    f.api.ext.nexusDownload = async () => { calls++; throw Error('NETWORK_WOULD_BE_CALLED'); };
    await assert.rejects(f.ops.download_nexus(args), /AMBIGUOUS_DOWNLOAD_IDENTITY/); assert.equal(calls, 0);
  }
});
test('audit: acquisition dedup is revalidated immediately before effect', async () => {
  let saved;
  const f = await fixture(async (file, state) => { if (file.endsWith('unresolved.json')) state.persistent.downloads.files.other = saved; });
  const args = await pinned(f); saved = f.state.persistent.downloads.files.d; delete f.state.persistent.downloads.files.d;
  let calls = 0; f.api.ext.nexusDownload = async () => { calls++; throw Error('NETWORK_WOULD_BE_CALLED'); };
  await assert.rejects(f.ops.download_nexus(args), /DOWNLOAD_PREFLIGHT_CHANGED/); assert.equal(calls, 0);
});
test('audit: reconcile uses fallback IDs and refuses wrong game attribution', async () => {
  const f = await fixture(); const args = await pinned(f, { modInfo: { modId: 42, fileId: 43 } });
  await f.ops.download_nexus(args);
  f.state.persistent.downloads.files.wrong = { game: ['skyrimse'], state: 'finished', modInfo: { nexus: { ids: { gameId: 'skyrimspecialedition', modId: 42, fileId: 43 } } } };
  const result = await f.ops.reconcile_operation({ requestId: args.requestId }); assert.deepEqual(result.download.map(d => d.id), ['d']);
});
test('audit: foreign, scalar, unsuccessful and conflicting receipts never verify completion', async () => {
  for (const corrupt of ['foreign', 'scalar', 'unsuccessful', 'conflict', 'truncated']) {
    const f = await fixture(); await f.ops.set_mods_enabled({ ...f.args, modIds: ['m'], enabled: true });
    const file = path.join(f.dir, 'receipts', f.args.requestId + '.completion.json'); const good = JSON.parse(await fs.readFile(file));
    if (corrupt === 'conflict') await fs.writeFile(path.join(f.dir, 'receipts', f.args.requestId + '.failed.json'), JSON.stringify({ ...good, operationCompleted: false }));
    else await fs.writeFile(file, corrupt === 'truncated' ? '{' : JSON.stringify(corrupt === 'scalar' ? true : { ...good,
      ...(corrupt === 'foreign' ? { requestId: 'different-request' } : { operationCompleted: false }) }));
    const result = await f.ops.reconcile_operation({ requestId: f.args.requestId }); assert.equal(result.terminalOperationVerified, false, corrupt);
  }
});
test('audit: failed completion fsync never publishes a completion', async () => {
  const f = await fixture(async file => { if (file.includes('.completion.json')) throw Error('SYNTHETIC_FSYNC_FAILURE'); });
  await assert.rejects(f.ops.set_mods_enabled({ ...f.args, modIds: ['m'], enabled: true }));
  await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
  const result = await f.ops.reconcile_operation({ requestId: f.args.requestId }); assert.equal(result.terminalOperationVerified, false);
});
test('audit: secret property names fail closed', () => {
  const api = { getState: () => ({ confidential: { apiKey: 'synthetic-secret' } }) };
  assert.throws(() => guard.safe({ nested: { 'synthetic-secret': 'display' } }, api), /PROPERTY_KEY_NOT_CURATED/);
});
test('audit: changed enabled/path scope invalidates conflict scan', async () => {
  const f = await fixture(); f.state.persistent.profiles.p.modState.m = { enabled: true }; await fs.mkdir(path.join(f.dir, 'm'));
  const monitored = { ...fs, opendir: async (...args) => { const h = await fs.opendir(...args); f.state.persistent.profiles.p.modState.new = { enabled: true };
    f.state.persistent.mods.cyberpunk2077.new = { state: 'installed', installationPath: 'new' }; return h; } };
  const module = { exports: {} }; vm.runInThisContext('(function(require,module,exports){' + await fs.readFile(new URL('./inspection.cjs', import.meta.url), 'utf8') + '\n})')(
    id => id === 'node:fs/promises' ? monitored : require(id), module, module.exports);
  await assert.rejects(module.exports.conflicts(f.api, f.selectors, {}), /STALE_SCAN_SCOPE/);
});
async function server(options = {}) {
  const upstream = createRequire(paths.build + '/upstream/package.json'); const f = await fixture();
  f.state.session = { mods: { changes: [{ filePath: path.join(f.dir, 'file'), source: 'm', extra: { private: 'not-curated' } }] } };
  const control = { listExternalChanges: () => f.state.session.mods.changes };
  const module = { exports: {} }; vm.runInThisContext('(function(require,module,exports){' + await fs.readFile(new URL('./extension.cjs', import.meta.url), 'utf8') + '\n})')(
    id => id === '@nexusmods/vortex-api' ? { actions: {}, selectors: f.selectors, util: {}, log: () => {} } : id === './vortexControl' ? control
      : id.startsWith('./') ? require(id) : upstream(id), module, module.exports);
  const listener = module.exports.start(f.api, 0, { tokenProvider: async () => '7'.repeat(64), ...options });
  try { await waitForServerListening(listener); }
  catch (error) {
    try { await closeOwnedTestServer(listener); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'AUDIT_SERVER_START_CLEANUP_FAILED', {cause: error}); }
    throw error;
  }
  const endpoint = `http://127.0.0.1:${listener.address().port}/mcp`, headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + '7'.repeat(64) };
  return { listener, endpoint, headers };
}
const HTTP_PHASE_MS = 5000;
async function closeServer(listener) {
  await closeOwnedTestServer(listener, {timeoutMs: HTTP_PHASE_MS});
}
async function fetchText(s, body, phase) {
  const signal = AbortSignal.timeout(HTTP_PHASE_MS);
  try {
    const response = await fetch(s.endpoint, { method: 'POST', headers: s.headers, body, signal });
    return { status: response.status, text: await response.text() };
  } catch (error) { throw new Error(`AUDIT_${phase}_${signal.aborted ? 'TIMEOUT' : 'FAILED'}`, { cause: error }); }
}
async function chunkedStatus(s, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, status) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { req.destroy(); reject(error); } else resolve(status);
    };
    const req = http.request(s.endpoint, { method: 'POST', headers: { ...s.headers, 'transfer-encoding': 'chunked' } }, res => {
      res.on('error', error => finish(new Error('AUDIT_CHUNKED_RESPONSE_FAILED', { cause: error })));
      res.on('aborted', () => finish(new Error('AUDIT_CHUNKED_RESPONSE_ABORTED')));
      res.on('close', () => { if (!res.complete) finish(new Error('AUDIT_CHUNKED_RESPONSE_INCOMPLETE')); });
      res.on('end', () => finish(null, res.statusCode)); res.resume();
    });
    const timer = setTimeout(() => finish(new Error('AUDIT_CHUNKED_RESPONSE_TIMEOUT')), HTTP_PHASE_MS);
    req.on('error', error => finish(new Error('AUDIT_CHUNKED_REQUEST_FAILED', { cause: error })));
    req.end(body);
  });
}
test('audit: HTTP preparse byte/batch limits and explicit external-change projection', async () => {
  const s = await server(); try {
    const big = await fetchText(s, ' '.repeat(1024 * 1024 + 1), 'OVERSIZED_BODY'); assert.equal(big.status, 413);
    const batch = await fetchText(s, JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/list' }))), 'OVERSIZED_BATCH'); assert.equal(batch.status, 413);
    const result = await fetchText(s, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_external_changes', arguments: {} } }), 'EXTERNAL_CHANGES');
    assert.ok(!result.text.includes('not-curated'));
  } finally { await closeServer(s.listener); }
});
test('audit: process-wide ingress concurrency and abort release', async () => {
  const a = await server(), b = await server(), requests = [];
  try {
    for (let i = 0; i < 16; i++) requests.push(http.request(a.endpoint, { method: 'POST', headers: { ...a.headers, 'transfer-encoding': 'chunked' } }));
    for (const req of requests) { req.on('error', () => {}); req.flushHeaders(); req.write('{'); }
    const until = Date.now() + 3000;
    while (require('./http-ingress.cjs').activity().requests < 16 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(require('./http-ingress.cjs').activity().requests, 16);
    const overloaded = await fetchText(b, '{}', 'CONCURRENCY_OVERLOAD'); assert.equal(overloaded.status, 503);
    for (const req of requests) req.destroy(); await new Promise(r => setTimeout(r, 100));
    const released = await fetchText(b, '{bad', 'CONCURRENCY_RELEASE'); assert.equal(released.status, 400);
  } finally { for (const req of requests) req.destroy(); for (const s of [a, b]) { await closeServer(s.listener); } }
});
test('audit: initialization grace allows a delayed record, then disappearance settles', async () => {
  const f = await fixture(); const args = await pinned(f); const record = f.state.persistent.downloads.files.d; delete f.state.persistent.downloads.files.d;
  f.api.ext.nexusDownload = async () => { setTimeout(() => { f.state.persistent.downloads.files.d = record; }, 5); return 'd'; };
  assert.equal((await f.ops.download_nexus(args)).reused, false);
  const g = await fixture(); const next = await pinned(g); delete g.state.persistent.downloads.files.d;
  g.api.ext.nexusDownload = async () => { g.state.persistent.downloads.files.d = { state: 'started' }; setTimeout(() => { delete g.state.persistent.downloads.files.d; }, 5); return 'd'; };
  await assert.rejects(g.ops.download_nexus(next), /DOWNLOAD_RECORD_MISSING/);
});
test('audit: numeric/domain consistency, unavailable catalogue and shared-domain ambiguity', () => {
  const { resolveDownload, matchingDownloads } = require('./download-identity.cjs');
  const selectors = { knownGames: () => [{ id: 'cyberpunk2077' }, { id: 'skyrimse' }, { id: 'skyrimvr' }] };
  const record = { modInfo: { nexus: { ids: { gameId: 'cyberpunk2077', modId: '42', fileId: '43' } }, meta: { gameId: '3333' } } };
  const catalog = () => [{ id: 3333, domain_name: 'cyberpunk2077' }];
  assert.equal(resolveDownload(record, {}, selectors, catalog).complete, true);
  assert.equal(resolveDownload(record, {}, selectors, () => []).ambiguous, true);
  assert.equal(resolveDownload({ modInfo: { nexus: { ids: { gameId: 'skyrimspecialedition', modId: 42, fileId: 43 } } } }, {}, selectors).complete, false);
  assert.throws(() => matchingDownloads({ old: { game: ['skyrimse'], modInfo: { nexus: { ids: { gameId: 'skyrimspecialedition', modId: 42, fileId: 43 } } } } },
    { gameId: 'skyrimvr', nexusModId: 42, nexusFileId: 43 }, {}, selectors), /AMBIGUOUS_DOWNLOAD_IDENTITY/);
});
test('audit: curated downloads tolerate missing game and expose only verified IDs', async () => {
  const f = await fixture(); await pinned(f, { game: undefined });
  const result = inspection.listDownloads(f.api, f.selectors, { states: ['finished'], limit: 100 }, f.options.catalog);
  assert.equal(result.length, 1); assert.equal(result[0].nexusModId, 42); assert.equal(result[0].nexusFileId, 43); assert.equal(result[0].identityVerified, true);
  assert.equal(Object.hasOwn(result[0], 'modInfo'), false);
});
test('audit: malformed Windows process output fails closed', async () => {
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8') + '\n})', { process: { platform: 'win32', env: {SystemRoot: 'C:\\Windows'} }, Buffer })(
    id => id === 'node:child_process' ? { spawnSync: () => ({status: 0, stderr: '', stdout: 'INFO: Unable to enumerate processes'}) } : require(id), module, module.exports);
  assert.throws(() => module.exports.stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
});
test('audit: chunked oversized body and invalid batch cannot bypass ingress limits', async () => {
  const s = await server(); try {
    const status = await chunkedStatus(s, Buffer.alloc(1024 * 1024 + 1, 32)); assert.equal(status, 413);
    const empty = await fetchText(s, '[]', 'EMPTY_BATCH'); assert.equal(empty.status, 413);
  } finally { await closeServer(s.listener); }
});
test('audit: receipt publication is no-overwrite and pending crash phases are inconclusive', async () => {
  const f = await fixture(); const args = { ...f.args, modIds: ['m'], enabled: true }; await f.ops.set_mods_enabled(args);
  const final = path.join(f.dir, 'receipts', args.requestId + '.completion.json'); const original = await fs.readFile(final);
  await assert.rejects(guard.commitCompletion(final, { bad: true }), /EEXIST/); assert.deepEqual(await fs.readFile(final), original);
  const reconciled = await f.ops.reconcile_operation({ requestId: args.requestId }); assert.equal(reconciled.terminalOperationVerified, false);
  assert.ok(reconciled.receiptIssues.includes('INCOMPLETE_COMPLETION_COMMIT'));
});
test('audit: stalled auth and ingress timeout release process-wide admission', async () => {
  const s = await server({ tokenProvider: () => new Promise(() => {}), bodyTimeoutMs: 50 });
  try {
    const res = await fetchText(s, '{}', 'AUTH_DEADLINE'); assert.equal(res.status, 408);
    await new Promise(r => setTimeout(r, 10)); assert.equal(require('./http-ingress.cjs').activity().requests, 0);
  } finally { await closeServer(s.listener); }
});

test('audit: server cleanup closes an admitted unfinished upload', { timeout: 10000 }, async () => {
  const s = await server(), req = http.request(s.endpoint, { method: 'POST', headers: { ...s.headers, 'transfer-encoding': 'chunked' } });
  req.on('error', () => {});
  const closed = new Promise(resolve => req.once('close', resolve));
  try {
    req.flushHeaders(); req.write('{');
    const until = Date.now() + 3000;
    while (require('./http-ingress.cjs').activity().requests === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(require('./http-ingress.cjs').activity().requests, 1, 'unfinished upload must reach admission');
    await closeServer(s.listener);
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AUDIT_UPLOAD_CLOSE_TIMEOUT')), 1000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(s.listener.listening, false); assert.equal(req.destroyed, true);
  } finally { req.destroy(); if (s.listener.listening) await closeServer(s.listener); }
});
