import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('new-mod-conflict-query.json', folder)));
const patch = fs.readFileSync(new URL('new-mod-conflict-query.patch', folder), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = process.env.VORTEX_NATIVE_LEVEL_PERSIST_SOURCE;
const duck = process.env.VORTEX_NATIVE_DUCKDB_NODE_API;
const integration = (name, fn) => test(name, {timeout: 15000,
  skip: source && duck ? false : 'Provide pinned LevelPersist.ts and existing DuckDB node-api via VORTEX_NATIVE_LEVEL_PERSIST_SOURCE/VORTEX_NATIVE_DUCKDB_NODE_API'}, fn);
function actualClass(raw, name, context = {}) {
  const js = stripTypeScriptTypes(raw, {mode: 'transform'});
  const start = js.indexOf(`class ${name} {`), end = js.lastIndexOf(`export default ${name};`);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(js.slice(start, end) + `\n${name};`, {
    SEPARATOR: '###', structuredClone, process, log() {},
    traceWritesEnabled: () => false, SLOW_WRITE_THRESHOLD_MS: 5000,
    unknownToError: value => value instanceof Error ? value : Error(String(value)),
    ...context,
  }, {timeout: 1000});
}
function levelClass() {
  const raw = fs.readFileSync(source, 'utf8');
  assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex'), manifest.upstreamGitBlob);
  assert.equal(sha(raw), manifest.originalSourceSHA256);
  assert.equal(sha(raw), manifest.inputSHA256);
  const next = applyExact(raw, patch, manifest.upstreamPath);
  assert.equal(sha(next), manifest.outputSHA256);
  return actualClass(next, 'LevelPersist');
}
async function database(fn) {
  const require = createRequire(import.meta.url);
  assert.equal(require(duck + '/package.json').version, '1.5.1-r.1');
  const {DuckDBInstance} = require(duck);
  const instance = await DuckDBInstance.create(':memory:');
  let connection;
  try {
    connection = await instance.connect();
    await connection.run('CREATE TABLE kv(key VARCHAR, value VARCHAR)');
    await fn(connection);
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

test('conflict query artifact is pinned preparation with no atomic absence or native permit', () => {
  assert.equal(sha(patch), manifest.patchSHA256);
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/main/src/store/LevelPersist.ts');
  assert.equal(manifest.preparedOnly, true);
  for (const name of ['installed', 'nativeAcceptanceVerified', 'installationPermit',
    'atomicAbsenceVerified', 'powerLossPersistenceVerified']) assert.equal(manifest[name], false);
});

integration('real DuckDB detects each ancestor/blob/target leaf, including false all-profile tombstones', async () => {
  const Level = levelClass();
  await database(async db => {
    const owner = new Level(db, 'main');
    const keys = ['', null, 'persistent', 'persistent###mods', 'persistent###mods###game-x',
      'persistent###mods###game-x###owner.mod_1',
      'persistent###mods###game-x###owner.mod_1###attributes###name',
      'persistent###profiles', 'persistent###profiles###other-game-profile',
      'persistent###profiles###other-game-profile###modState',
      'persistent###profiles###p1###modState###owner.mod_1',
      'persistent###profiles###p2###modState###owner.mod_1###enabled',
      'persistent###profiles###p3###modState###owner.mod_1###disabledTime'];
    for (const key of keys) {
      await db.run('DELETE FROM kv');
      await db.run('INSERT INTO kv VALUES ($1,$2)', [key, 'false']);
      assert.equal(await owner.hasNewModRegistrationConflict('game-x', 'owner.mod_1'), true, String(key));
    }
    // Exact getItem is insufficient for the same actual flattened leaf.
    await db.run('DELETE FROM kv');
    await db.run('INSERT INTO kv VALUES ($1,$2)', ['persistent###mods###game-x###owner.mod_1###state', '"installed"']);
    await assert.rejects(owner.getItem(['persistent', 'mods', 'game-x', 'owner.mod_1']));
    assert.equal(await owner.hasNewModRegistrationConflict('game-x', 'owner.mod_1'), true);
  });
});

integration('real query ignores ordinary profile fields, unrelated games and literal similar IDs', async () => {
  const Level = levelClass();
  await database(async db => {
    const owner = new Level(db, 'main');
    assert.equal(await owner.hasNewModRegistrationConflict('game-x', 'owner.mod_1'), false);
    const keys = ['persistent###mods###game-x2', 'persistent###mods###game-x2###owner.mod_1',
      'persistent###mods###game-x###owner.mod_10', 'persistent###mods###game-x###ownerXmodA1###state',
      'persistent###profiles###p###name', 'persistent###profiles###p###gameId',
      'persistent###profiles###p###features###local',
      'persistent###profiles###p###modState###owner.mod_10###enabled',
      'persistent###profiles###p###modState###ownerXmodA1', 'settings###mods###game-x'];
    for (const key of keys) await db.run('INSERT INTO kv VALUES ($1,$2)', [key, '{invalid JSON deliberately unread}']);
    assert.equal(await owner.hasNewModRegistrationConflict('game-x', 'owner.mod_1'), false);
  });
});

integration('only one bound key-only SQL query and at most one constant row cross the backend boundary', async () => {
  const Level = levelClass();
  await database(async db => {
    await db.run("INSERT INTO kv SELECT 'persistent###profiles###p' || i || '###modState###owner.mod_1###enabled', 'false' FROM range(256) t(i)");
    const calls = [];
    const owner = new Level({async runAndReadAll(sql, parameters) {
      calls.push([sql, parameters]);
      const reader = await db.runAndReadAll(sql, parameters);
      assert.deepEqual(reader.getRows(), [[1]]);
      return reader;
    }}, 'main');
    assert.equal(await owner.hasNewModRegistrationConflict('game-x', 'owner.mod_1'), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(Array.from(calls[0][1]), ['persistent###mods###game-x', 'persistent###mods###game-x###owner.mod_1', 'owner.mod_1']);
    assert.match(calls[0][0], /SELECT 1 FROM keys/);
    assert.doesNotMatch(calls[0][0], /\bvalue\b/i);
  });
});

integration('malformed identity rejects before reads; backend failures preserve original rejection', async () => {
  const Level = levelClass(); let reads = 0;
  const failure = Error('own backend read failure');
  const owner = new Level({async runAndReadAll() {reads++; throw failure;}}, 'main');
  for (const id of ['', 'a'.repeat(201), null, undefined, 1, {}, 'a\n', 'a###b', 'a/b', 'a\\b', "a'b", ' a', 'é', '__proto__', 'constructor', 'Prototype']) {
    await assert.rejects(owner.hasNewModRegistrationConflict(id, 'valid'), /Invalid/);
    await assert.rejects(owner.hasNewModRegistrationConflict('valid', id), /Invalid/);
  }
  assert.equal(reads, 0);
  await assert.rejects(owner.hasNewModRegistrationConflict('valid', 'a'.repeat(200)), error => error === failure);
  assert.equal(reads, 1);
});

integration('actual queued persistor drains older real DuckDB write before conflict query and retains failed reservation', async t => {
  const persistorSource = process.env.VORTEX_NATIVE_PERSISTOR_SOURCE;
  if (!persistorSource) return t.skip('Provide pinned original ReduxPersistorIPC.ts for combined queue check');
  let raw = fs.readFileSync(persistorSource, 'utf8');
  for (const name of ['batch-acknowledgement', 'target-reservation']) {
    const metadata = JSON.parse(fs.readFileSync(new URL(name + '.json', folder)));
    const diff = fs.readFileSync(new URL(name + '.patch', folder), 'utf8');
    assert.equal(sha(raw), metadata.inputSHA256); assert.equal(sha(diff), metadata.patchSHA256);
    raw = applyExact(raw, diff, metadata.upstreamPath);
    assert.equal(sha(raw), metadata.outputSHA256);
  }
  const Persistor = actualClass(raw, 'ReduxPersistorIPC', {terminate(error) {throw error;}});
  const Level = levelClass();
  await database(async db => {
    const level = new Level(db, 'main');
    // level_pivot dirty-table extension/ABI is deliberately outside this memory-table test.
    level.getDirtyTables = async () => [];
    const owner = new Persistor();
    let release; const gate = new Promise(resolve => {release = resolve;});
    let written = false, queried = false;
    const query = level.hasNewModRegistrationConflict.bind(level);
    level.hasNewModRegistrationConflict = async (...args) => {queried = true; assert.equal(written, true); return query(...args);};
    owner.mPersistors.persistent = {async setItem(parts, value) {
      await gate; await level.setItem(['persistent', ...parts], value); written = true;
    }};
    owner.setQueryInvalidator(level, {notifyDirtyTables() {assert.fail('no dirty-table extension here');}});
    owner.applyDiffOperations('persistent', [{type: 'set', path: ['mods', 'game-x', 'owner.mod_1', 'state'], value: 'installed'}]);
    const reservation = owner.reserveNativeModPersistence('game-x', 'owner.mod_1');
    const refused = assert.rejects(reservation, /target already exists or has profile state/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queried, false); assert.equal(owner.getNativeModPersistenceReservation().phase, 'pending');
    release(); await refused;
    assert.equal(queried, true); assert.equal(owner.getNativeModPersistenceReservation().phase, 'held');
    assert.equal(await query('game-x', 'owner.mod_1'), true);
    await owner.finalizeWrite();
  });
});
