import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import disk from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import paths from './paths.cjs';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8');
const root = path.join(paths.build, 'tests');
await fs.mkdir(root, { recursive: true });

async function fixture({ fresh = false, onProofEnd, onReceiptSync } = {}) {
  const dir = await fs.mkdtemp(path.join(root, 'native-audit-'));
  const bytes = Buffer.from('verified archive');
  await fs.writeFile(path.join(dir, 'good.zip'), bytes);
  await fs.writeFile(path.join(dir, 'bad.zip'), Buffer.alloc(bytes.length, 0x42));
  const download = { game: ['cyberpunk2077'], state: 'finished', localPath: 'good.zip',
    modInfo: { nexus: { ids: { modId: 42, fileId: 43 } } } };
  const state = { settings: { gameMode: { discovered: { cyberpunk2077: { path: dir } } } },
    persistent: { profiles: { p: { gameId: 'cyberpunk2077', modState: {} } },
      mods: { cyberpunk2077: {} }, downloads: { files: fresh ? {} : { d: download } } }, session: { base: {} } };
  const model = { dir, state, download, profile: 'p', calls: 0, opened: 0, closed: 0, proofEvents: 0, receiptEvents: 0 };
  const api = { getState: () => state, ext: { nexusDownload: async () => {
    model.calls++; state.persistent.downloads.files.d = download; return 'd';
  } } };
  const selectors = { activeGameId: () => 'cyberpunk2077', activeProfileId: () => model.profile,
    installPathForGame: () => dir, downloadPathForGame: () => dir };
  function monitor(stream) {
    stream.once('end', () => { model.proofEvents++; onProofEnd?.(model); });
    return stream;
  }
  const mockedDisk = { ...disk, createReadStream: (...args) => monitor(disk.createReadStream(...args)) };
  const mockedFs = { ...fs, open: async (file, mode) => {
    const handle = await fs.open(file, mode);
    if (path.basename(file) === 'good.zip' && mode === 'r') {
      model.opened++;
      return { stat: (...args) => handle.stat(...args),
        createReadStream: (...args) => monitor(handle.createReadStream(...args)),
        close: async () => { model.closed++; await handle.close(); } };
    }
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(),
      sync: async () => { await handle.sync();
        if (path.basename(file).includes('.completion.json.pending-')) {
          model.receiptEvents++; onReceiptSync?.(model);
        }
      } };
  } };
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})')(
    name => name === 'node:fs/promises' ? mockedFs : name === 'node:fs' ? mockedDisk : require(name), module, module.exports);
  const identity = module.exports.identity(dir);
  model.args = { gameId: 'cyberpunk2077', profileId: 'p', requestId: crypto.randomUUID(),
    gamePath: dir, stagingPath: dir, downloadPath: dir,
    filesystemIds: { gamePath: identity, stagingPath: identity, downloadPath: identity },
    nexusModId: 42, nexusFileId: 43, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), reuseOnly: !fresh };
  model.ops = module.exports.createOperations(api, {}, selectors, { receipts: path.join(dir, 'receipts'), stopped: () => {} });
  return model;
}

for (const fresh of [false, true]) {
  const mode = fresh ? 'fresh' : 'reuse';
  test(`${mode}: unchanged tracked archive succeeds and closes its proof handle`, async () => {
    const f = await fixture({ fresh });
    const result = await f.ops.download_nexus(f.args);
    assert.equal(result.archiveSha256Verified, true);
    assert.equal(result.reused, !fresh);
    assert.equal(f.calls, Number(fresh));
    assert.equal(f.opened, 1); assert.equal(f.closed, 1);
  });
  for (const change of ['path', 'state', 'removed', 'game', 'nexus', 'file', 'file_identity']) {
    test(`${mode}: ${change} changing during archive hashing cannot yield a verified receipt`, async () => {
      const f = await fixture({ fresh, onProofEnd: model => {
        if (change === 'path') model.download.localPath = 'bad.zip';
        if (change === 'state') model.download.state = 'paused';
        if (change === 'removed') delete model.state.persistent.downloads.files.d;
        if (change === 'game') model.download.game = ['skyrimse'];
        if (change === 'nexus') model.download.modInfo.nexus.ids.fileId = 99;
        if (change === 'file') disk.writeFileSync(path.join(model.dir, 'good.zip'), 'changed archive!');
        if (change === 'file_identity') {
          disk.renameSync(path.join(model.dir, 'good.zip'), path.join(model.dir, 'previous.zip'));
          disk.copyFileSync(path.join(model.dir, 'previous.zip'), path.join(model.dir, 'good.zip'));
        }
      } });
      await assert.rejects(f.ops.download_nexus(f.args), /DOWNLOAD_(?:RECORD|ARCHIVE)_CHANGED/);
      assert.equal(f.proofEvents, 1);
      assert.equal(f.opened, f.closed);
      await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
      if (fresh) await fs.access(path.join(f.dir, 'receipts', 'unresolved.json'));
      if (fresh) {
        await assert.rejects(f.ops.download_nexus({ ...f.args, requestId: crypto.randomUUID() }), /UNRESOLVED_OPERATION_INTERLOCK/);
        assert.equal(f.calls, 1);
      }
    });
  }
  for (const change of ['context', 'record', 'file']) {
    test(`${mode}: ${change} changing while completion is fsynced prevents publication`, async () => {
      const f = await fixture({ fresh, onReceiptSync: model => {
        if (change === 'context') model.profile = 'other';
        if (change === 'record') model.download.localPath = 'bad.zip';
        if (change === 'file') disk.writeFileSync(path.join(model.dir, 'good.zip'), 'changed archive!');
      } });
      await assert.rejects(f.ops.download_nexus(f.args), /STALE_ACTIVE_CONTEXT|DOWNLOAD_(?:RECORD|ARCHIVE)_CHANGED/);
      assert.equal(f.receiptEvents, 1);
      assert.equal(f.opened, f.closed);
      await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
      if (fresh) await fs.access(path.join(f.dir, 'receipts', 'unresolved.json'));
    });
  }
}

test('wrong SHA or size closes the opened proof handle and cannot publish success', async () => {
  for (const wrong of ['sha256', 'size']) {
    const f = await fixture();
    if (wrong === 'sha256') f.args.sha256 = '0'.repeat(64);
    else f.args.size++;
    await assert.rejects(f.ops.download_nexus(f.args), /PACKAGE_PIN_MISMATCH/);
    assert.equal(f.opened, 1); assert.equal(f.closed, 1);
    await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
  }
});
