import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot } from './native-fixture-snapshot.mjs';

function runnerSnapshot(count) {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function snapshot()'), source.indexOf('async function main()'));
  const mods = Array.from({ length: count }, (_, index) => ({ id: 'mod_' + index }));
  const context = {
    tool: async name => name === 'health' ? { gamePath: 'C:/synthetic-game' }
      : name === 'list_mods' ? mods : [],
    fs: { readFileSync: () => Buffer.from('synthetic manifest') }, path,
    sha: () => 'synthetic hash', processes: () => [],
    ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot,
  };
  return vm.runInNewContext(body + '; snapshot()', context);
}

test('native fixture refuses capped ordinary inventories before claiming preservation', async () => {
  for (const count of [500, 501]) {
    await assert.rejects(runnerSnapshot(count), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});

test('empty and under-limit inventories remain usable for modeled preservation checks', async () => {
  for (const count of [0, 1, 499]) {
    const snapshot = await runnerSnapshot(count);
    assert.equal(snapshot.mods.length, count);
  }
});

test('malformed and duplicate identities cannot masquerade as a complete snapshot', () => {
  for (const mods of [undefined, null, {}, [null], [[]], [{}], [{ id: '' }],
    [{ id: 1 }], [{ id: 'same' }, { id: 'same' }]]) {
    assert.throws(() => assertOrdinaryModSnapshot(mods), /ORDINARY_MOD_INVENTORY_INVALID/);
  }
});

test('a capped legacy receipt is also refused by the independent verifier', () => {
  const source = fs.readFileSync(new URL('./native-fixture-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("const before = read('ordinary-before.json')");
  const end = source.indexOf('const log =', start);
  const code = source.slice(start, end);
  const complete = { mods: [{ id: 'own' }], health: {}, profiles: [], manifestSha256: 'same' };
  for (const cappedSide of ['ordinary-before.json', 'ordinary-after.json']) {
    const context = { assert, assertOrdinaryModSnapshot,
      read: name => name === cappedSide ? { ...complete,
        mods: Array.from({ length: ORDINARY_MOD_LIMIT }, (_, index) => ({ id: 'mod_' + index })) } : complete };
    assert.throws(() => vm.runInNewContext(code, context), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});
