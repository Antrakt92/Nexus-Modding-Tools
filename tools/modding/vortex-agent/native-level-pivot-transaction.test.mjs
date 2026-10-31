// Explicit opt-in real extension/own-LevelDB fixture. Never INSTALL or download.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(fs.readFileSync(path.join(directory, 'native-level-pivot-inputs.json'), 'utf8'));
const apiInput = process.env.VORTEX_NATIVE_DUCKDB_NODE_API;
const extensionInput = process.env.VORTEX_NATIVE_LEVEL_PIVOT_EXTENSION;
const skip = process.platform !== 'win32' || process.arch !== 'x64'
  ? 'Requires Windows AMD64' : !apiInput || !extensionInput
    ? 'Set VORTEX_NATIVE_DUCKDB_NODE_API and VORTEX_NATIVE_LEVEL_PIVOT_EXTENSION' : false;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const keySort = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
function extensionFooter(raw) {
  assert(raw.length >= 512);
  // Eight metadata slots precede the final 256-byte signature area.
  return Array.from({ length: 8 }, (_, i) => raw.subarray(raw.length - 512 + i * 32, raw.length - 480 + i * 32)
    .toString('utf8').replace(/\0+$/, ''));
}

test('fixed official level_pivot provenance and qualification limits', () => {
  assert.equal(inputs.schema, 'native-level-pivot-transaction-inputs/1');
  assert.equal(inputs.repository, 'https://github.com/Nexus-Mods/duckdb-level-pivot');
  assert.equal(inputs.sourceCommit, '329121d729dc40d303db304f945ca789754a0d06');
  assert.equal(inputs.pagesCommit, 'e00cbc4fef52e877c843d6186b558bdd0300483e');
  assert.equal(inputs.compressedGitBlob, '6a6fde6e19de2f390e5c985c610ec3a1cef71c54');
  assert.equal(inputs.rawSHA256, '61769a589fb9277fd70816816b6aa580ee4dde6d55f951c2423c14d72ae45fb7');
  assert.equal(inputs.rawBytes, 22611478);
  assert.deepEqual(inputs.footer, ['', '', '', 'CPP', '329121d', 'v1.5.1', 'windows_amd64', '4']);
  const synthetic = Buffer.alloc(512);
  inputs.footer.forEach((value, i) => synthetic.write(value, i * 32, 'ascii'));
  assert.deepEqual(extensionFooter(synthetic), inputs.footer);
  assert.throws(() => extensionFooter(Buffer.alloc(511)));
  assert.equal(inputs.nodeAPIVersion, '1.5.1-r.1');
  assert.equal(inputs.duckdbVersion, 'v1.5.1');
  assert.equal(inputs.license, 'MIT');
  for (const name of ['signatureAuthenticated', 'nativeCommitIOErrorInjected',
    'powerLossPersistenceVerified', 'installationPermit']) assert.equal(inputs[name], false);
});

function ordinary(target, file = false) {
  let cursor = path.resolve(target), leaf = true;
  for (;;) {
    const s = fs.lstatSync(cursor);
    assert(!s.isSymbolicLink());
    assert(leaf && file ? s.isFile() : s.isDirectory());
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next; leaf = false;
  }
}
function absent(target) {
  try { fs.lstatSync(target); assert.fail('Expected absent own DB child'); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
}
function pinnedFile(file) {
  const actual = fs.realpathSync(file);
  ordinary(actual, true);
  const s = fs.statSync(actual);
  runtimeFileSize(s.size);
  return { path: actual, bytes: s.size, sha256: sha(fs.readFileSync(actual)) };
}
function runtimeFileSize(bytes) {
  // Includes the existing 93,381,448-byte Windows Node executable.
  assert(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 128 * 1024 * 1024);
}
test('runtime input size guard admits Node.exe and rejects oversized inputs', () => {
  assert.doesNotThrow(() => runtimeFileSize(93381448));
  assert.doesNotThrow(() => runtimeFileSize(128 * 1024 * 1024));
  assert.throws(() => runtimeFileSize(128 * 1024 * 1024 + 1));
  for (const bytes of [-1, NaN, Infinity, 1.5]) assert.throws(() => runtimeFileSize(bytes));
});
function checkPins(rows) {
  for (const row of rows) assert.deepEqual(pinnedFile(row.path), row);
}
function write(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
async function closeResources(instance, c, failed = false, primary) {
  const capture = e => { if (!failed) { failed = true; primary = e; } };
  try { if (c) await c.run('DETACH fixture'); }
  catch (e) { capture(e); }
  finally {
    try { c?.closeSync(); }
    catch (e) { capture(e); }
    finally { try { instance.closeSync(); } catch (e) { capture(e); } }
  }
  if (failed) throw primary;
}
async function using(session, fn) {
  let failed = false, primary, result;
  try { result = await fn(session.c); }
  catch (e) { failed = true; primary = e; }
  finally { await session.close(failed, primary); }
  return result;
}

function prepare(t) {
  const apiRoot = fs.realpathSync(apiInput);
  assert(fs.statSync(apiRoot).isDirectory(), 'API input is a package directory');
  const pkg = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@duckdb/node-api'); assert.equal(pkg.version, inputs.nodeAPIVersion);
  const apiEntry = path.join(apiRoot, 'lib', 'index.js');
  const bindingEntry = createRequire(apiEntry).resolve('@duckdb/node-bindings');
  const nativeEntry = createRequire(bindingEntry).resolve('@duckdb/node-bindings-win32-x64/duckdb.node');
  const extension = fs.realpathSync(extensionInput);
  const ext = pinnedFile(extension);
  assert.equal(ext.bytes, inputs.rawBytes); assert.equal(ext.sha256, inputs.rawSHA256);
  assert.deepEqual(extensionFooter(fs.readFileSync(extension)), inputs.footer);
  const pins = [ext, pinnedFile(process.execPath)];
  for (const root of [apiRoot, path.dirname(bindingEntry), path.dirname(nativeEntry)]) {
    const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(p.version, inputs.nodeAPIVersion);
    const walk = dir => {
      ordinary(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        assert(!entry.isSymbolicLink());
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:js|json|node|dll)$/.test(entry.name)) pins.push(pinnedFile(full));
        assert(pins.length < 512);
      }
    };
    walk(root);
  }
  const project = path.resolve(directory, '../../..');
  ordinary(project);
  const base = path.join(project, 'local-state');
  if (!fs.existsSync(base)) fs.mkdirSync(base);
  ordinary(base);
  const run = fs.mkdtempSync(path.join(base, 'native-level-pivot-transaction-'));
  ordinary(run); t.diagnostic(`Retained own fixture: ${run}`);
  const meta = { schema: 'native-level-pivot-transaction-evidence/1', case: t.name,
    sourceCommit: inputs.sourceCommit, extension: ext, pins, node: process.version,
    testSHA256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    nativeAdmission: false, installationPermit: false, powerLossPersistenceVerified: false,
    nativeCommitIOErrorInjected: false, processCrashVerified: false };
  write(path.join(run, 'INTENT.json'), meta);
  checkPins(pins);
  const { DuckDBInstance } = createRequire(import.meta.url)(apiEntry);
  async function open(db, create) {
    ordinary(run); assert.equal(path.dirname(db), run);
    if (create) absent(db); else ordinary(db);
    const extDir = fs.mkdtempSync(path.join(run, 'empty-extension-directory-'));
    const instance = await DuckDBInstance.create(':memory:', {
      allow_unsigned_extensions: 'true', autoload_known_extensions: 'false',
      autoinstall_known_extensions: 'false', extension_directory: extDir, threads: '1', memory_limit: '256MB',
    });
    let c;
    try {
      c = await instance.connect();
      assert.deepEqual((await c.runAndReadAll("SELECT current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions'), version()" )).getRows()[0], [false, false, inputs.duckdbVersion]);
      checkPins(pins);
      await c.run(`LOAD ${quote(extension)}`);
      ordinary(run); if (create) absent(db); else ordinary(db);
      await c.run(`ATTACH ${quote(db.replaceAll('\\', '/'))} AS fixture (TYPE level_pivot, CREATE_IF_MISSING ${create ? 'true' : 'false'})`);
      ordinary(db);
      await c.run("CALL level_pivot_create_table('fixture', 'kv', NULL, ['key', 'value'], table_mode := 'raw')");
      return { c, close: (failed, primary) => closeResources(instance, c, failed, primary) };
    } catch (e) { await closeResources(instance, c, true, e); }
  }
  return { run, pins, meta, open };
}
function rows(count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const id = `own_fixture_${i}`;
    for (const [key, value] of Object.entries({ id, state: 'installed', type: '', installationPath: id }))
      result.push([`persistent###mods###own_fixture_game###${id}###${key}`, JSON.stringify(value)]);
  }
  result.push(['own_fixture###transaction_marker', JSON.stringify({ schema: 'own-transaction-marker/1', mods: count })]);
  return result.sort(keySort);
}
async function insert(c, values) {
  await c.run(`INSERT INTO fixture.kv VALUES ${values.map((_, i) => `($${2 * i + 1},$${2 * i + 2})`).join(',')}`, values.flat());
}
const read = async c => (await c.runAndReadAll('SELECT key,value FROM fixture.kv ORDER BY key')).getRows();
for (const [name, mode, count] of [ ['real LevelDB rollback/reopen has no mod or marker', 'rollback', 1],
  ['real LevelDB commit/reopen has exact mod and marker', 'commit', 1],
  ['real LevelDB commit/reopen joins three 256-row chunks', 'commit', 130],
  ['real SQL failure after first chunk rolls back all rows', 'query-error', 130],
  ['real commit remains recoverable after an injected lost acknowledgement', 'lost-ack', 1] ]) {
  test(name, { skip, timeout: 60000, concurrency: false }, async t => {
    const f = prepare(t), expected = rows(count), db = path.join(f.run, 'own-leveldb');
    let committed = false, commits = 0, chunks = 0, held = false;
    try {
      await using(await f.open(db, true), async c => {
        assert.deepEqual(await read(c), []); await c.run('BEGIN TRANSACTION');
        for (let i = 0; i < expected.length; i += 256) {
          await insert(c, expected.slice(i, i + 256)); chunks++;
          if (mode === 'query-error') {
            await assert.rejects(() => c.run('INSERT INTO fixture.own_missing_table VALUES (1)')); break;
          }
        }
        if (mode === 'rollback' || mode === 'query-error') await c.run('ROLLBACK');
        else {
          commits++; await c.run('COMMIT'); committed = true;
          if (mode === 'lost-ack') {
            try { throw new Error('OWN_FIXTURE_ACK_LOST_AFTER_ACTUAL_COMMIT'); } catch { held = true; }
          }
        }
      });
      const observed = await using(await f.open(db, false), async c => {
        const actual = await read(c); assert.deepEqual(actual, committed ? expected : []); return actual;
      });
      assert.equal(chunks, count === 130 && mode === 'commit' ? 3 : 1);
      assert.equal(commits, committed ? 1 : 0); assert.equal(held, mode === 'lost-ack');
      checkPins(f.pins);
      write(path.join(f.run, 'RESULT.json'), { ...f.meta, status: 'passed', committed, chunks, commits,
        held, replayAllowed: false, acknowledgementLossInjected: mode === 'lost-ack',
        reopenedRows: observed.length, exactReadback: true, rowDigest: sha(JSON.stringify(observed)) });
    } catch (e) {
      write(path.join(f.run, 'FAILED.json'), { ...f.meta, status: 'held', replayAllowed: false }); throw e;
    }
  });
}
