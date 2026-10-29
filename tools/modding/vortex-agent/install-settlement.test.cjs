'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForInstallSettlement: wait } = require('./install-settlement.cjs');

function fixture() {
  const expected = { record: { id: 'own', archiveId: 'download_1', installationPath: 'own', type: '' },
    bytes: 9, enabled: false, disabledModIds: ['old'] };
  const state = { clock: 0, reads: 0, guards: 0, events: [],
    record: { ...expected.record, state: 'installed', attributes: { modSize: 9 } },
    flags: { own: { enabled: false }, old: { enabled: false } } };
  const options = { expected, now: () => state.clock,
    sleep: async ms => { state.clock += ms; },
    read: () => { ++state.reads; return structuredClone({ record: state.record, flags: state.flags }); },
    assertOperationalState: () => { ++state.guards; },
    record: event => { state.events.push(structuredClone(event)); },
    timeoutMs: 10000, quietMs: 3000, pollMs: 1000 };
  return { state, options };
}

test('unrelated record metadata and flag timestamps do not prolong settlement', async () => {
  const f = fixture();
  const read = f.options.read;
  f.options.read = () => {
    f.state.record.attributes.lastUpdateTime = f.state.reads;
    f.state.record.privateMetadata = 'never log this';
    f.state.flags.own.enabledTime = f.state.reads;
    return read();
  };
  const result = await wait(f.options);
  assert.equal(result.elapsedMs, 3000);
  assert.equal(f.state.reads, 5); // Four polls, plus the post-guard re-read.
  assert.equal(f.state.guards, 5);
  assert.equal(result.ready, true);
  assert(!JSON.stringify(f.state.events).includes('never log this'));
});

test('native mod IDs retain spaces, punctuation and Unicode while archive IDs stay opaque', async () => {
  const ids = ['ArchiveXL 4198 1.28.4 2026-10-29T11-02Z aI50IAsDC',
    'Fast Travel (2.5) - native', 'Мод — été 1.0', 'x'.repeat(255)];
  for (const id of ids) {
    const f = fixture();
    f.options.expected.record.id = id; f.options.expected.record.installationPath = id;
    f.state.record.id = id; f.state.record.installationPath = id;
    f.options.expected.disabledModIds = ['Previous version (1.0)'];
    f.state.flags = { [id]: { enabled: false }, 'Previous version (1.0)': { enabled: false } };
    assert.equal((await wait(f.options)).ready, true, id);
  }
});

test('unsafe native keys and malformed archive IDs fail before adapters run', async () => {
  const invalid = ['', ' ', '.', '..', '../mod', 'dir/mod', 'dir\\mod', 'C:mod',
    'mod\nname', 'mod\0name', 'mod\tname', 'mod\x7fname', ' trailing ', 'trailing.',
    'mod*', 'mod?', 'mod|', 'mod<', 'mod>', 'mod"', 'x'.repeat(256),
    '__proto__', 'constructor', 'prototype'];
  for (const id of invalid) {
    for (const field of ['id', 'disabled']) {
      const f = fixture();
      if (field === 'id') f.options.expected.record.id = id;
      else f.options.expected.disabledModIds = [id];
      await assert.rejects(wait(f.options), { code: 'INVALID_INSTALL_SETTLEMENT_OPTIONS' });
      assert.equal(f.state.guards, 0); assert.equal(f.state.reads, 0); assert.equal(f.state.events.length, 0);
    }
  }
  const f = fixture(); f.options.expected.record.archiveId = 'download with spaces';
  await assert.rejects(wait(f.options), { code: 'INVALID_INSTALL_SETTLEMENT_OPTIONS' });
  assert.equal(f.state.guards, 0);
});

test('native IDs are compared exactly without trimming or case folding', async () => {
  for (const changed of ['ArchiveXL native', 'archivexl Native', 'ArchiveXL Native ']) {
    const f = fixture(); f.options.expected.record.id = 'ArchiveXL Native';
    f.options.expected.record.installationPath = 'ArchiveXL Native';
    f.state.record.id = changed; f.state.record.installationPath = 'ArchiveXL Native';
    await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_IDENTITY_CHANGED' });
  }
});

test('wrong size times out with an exact diagnostic, without accepting installed state alone', async () => {
  const f = fixture(); f.state.record.attributes.modSize = 8;
  await assert.rejects(wait(f.options), error => {
    assert.equal(error.code, 'INSTALL_SETTLEMENT_TIMEOUT_RECONCILE');
    assert.deepEqual(error.observation.waiting, ['mod_size']);
    assert.equal(error.reconcileRequired, true);
    return true;
  });
  assert.equal(f.state.events.at(-1).noReplay, true);
});

test('each required state or flag transition restarts the quiet span', async () => {
  for (const kind of ['state', 'size', 'own', 'old', 'missing']) {
    const f = fixture(), read = f.options.read;
    f.options.read = () => {
      const snapshot = read();
      if (f.state.clock === 2000) {
        if (kind === 'state') snapshot.record.state = 'installing';
        if (kind === 'size') snapshot.record.attributes.modSize = 8;
        if (kind === 'own') snapshot.flags.own.enabled = true;
        if (kind === 'old') delete snapshot.flags.old;
        if (kind === 'missing') snapshot.record = undefined;
      }
      return snapshot;
    };
    assert.equal((await wait(f.options)).elapsedMs, 6000, kind);
  }
});

test('conflicting target, archive, staging path or type is never treated as ready', async () => {
  for (const field of ['id', 'archiveId', 'installationPath', 'type']) {
    const f = fixture(); f.state.record[field] = 'different';
    await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_IDENTITY_CHANGED' });
  }
});

test('enabled=true requires an explicit true flag', async () => {
  const f = fixture(); f.options.expected.enabled = true; delete f.state.flags.own;
  await assert.rejects(wait(f.options), error => {
    assert.deepEqual(error.observation.waiting, ['enabled_flags']); return true;
  });
});

test('a guard failure is sanitized and stops observation without more reads', async () => {
  const f = fixture();
  f.options.assertOperationalState = async () => { throw Error('private source path and account'); };
  await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_OBSERVATION_FAILED' });
  assert.equal(f.state.reads, 0);
  assert(!JSON.stringify(f.state.events).includes('private source'));
});

test('re-read after final async guard prevents accepting changed flags', async () => {
  const f = fixture();
  f.options.assertOperationalState = async () => {
    if (++f.state.guards === 5) f.state.flags.own.enabled = true;
  };
  await assert.rejects(wait(f.options), error => {
    assert.deepEqual(error.observation.waiting, ['enabled_flags']); return true;
  });
});

test('caller cannot change the pinned identity or size during an await', async () => {
  const f = fixture();
  f.options.sleep = async ms => {
    f.state.clock += ms;
    f.options.expected.bytes = 8;
    f.options.expected.record.archiveId = 'other';
    f.state.record.attributes.modSize = 8;
  };
  await assert.rejects(wait(f.options), error => {
    assert.deepEqual(error.observation.waiting, ['mod_size']); return true;
  });
});

test('missing record and identity produce distinct bounded diagnostics', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing) f.state.record = undefined;
    else delete f.state.record.archiveId;
    await assert.rejects(wait(f.options), error => {
      assert(error.observation.waiting.includes(missing ? 'record_missing' : 'identity_missing'));
      return true;
    });
  }
});

test('malformed flags and snapshots fail closed', async () => {
  for (const value of [null, [], {}, { enabled: 0 }]) {
    const f = fixture(); f.state.flags.own = value;
    await assert.rejects(wait(f.options), { code: 'INVALID_INSTALL_SETTLEMENT_FLAGS' });
  }
  const f = fixture(); f.options.read = () => ({ record: [], flags: {} });
  await assert.rejects(wait(f.options), { code: 'INVALID_INSTALL_SETTLEMENT_PROJECTION' });
});

test('receipt throws and asynchronous writers cannot produce a success', async () => {
  for (const record of [() => { throw Error('disk full'); }, async () => {}]) {
    const f = fixture(); f.options.record = record;
    await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_RECEIPT_FAILED' });
  }
});

test('backwards clock and invalid bounds are rejected', async () => {
  const f = fixture(); f.options.sleep = async () => { f.state.clock = -1; };
  await assert.rejects(wait(f.options), { code: 'NONMONOTONIC_INSTALL_SETTLEMENT_CLOCK' });
  for (const patch of [{ timeoutMs: NaN }, { quietMs: 0 }, { quietMs: 10000 }, { pollMs: 0 }]) {
    await assert.rejects(wait({ ...fixture().options, ...patch }), { code: 'INVALID_INSTALL_SETTLEMENT_OPTIONS' });
  }
});

test('an adapter that crosses the deadline cannot return success', async () => {
  const f = fixture(); f.options.read = () => {
    f.state.clock = 10001; return { record: f.state.record, flags: f.state.flags };
  };
  await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_TIMEOUT_RECONCILE' });
});

test('diagnostics separate guard/read/sleep costs and retain the operation that timed out', async () => {
  const f = fixture(), read = f.options.read;
  f.options.assertOperationalState = () => { f.state.clock += 200; };
  f.options.read = () => { f.state.clock += 50; return read(); };
  const result = await wait(f.options);
  assert.deepEqual(result.timing.guard, { calls: 5, totalMs: 1000, maxMs: 200 });
  assert.deepEqual(result.timing.read, { calls: 5, totalMs: 250, maxMs: 50 });
  assert.equal(result.lastOperation, 'read');
  const stalled = fixture();
  stalled.options.assertOperationalState = () => { stalled.state.clock = 11000; };
  await assert.rejects(wait(stalled.options), error => {
    assert.equal(error.diagnostics.lastOperation, 'guard');
    assert.equal(error.diagnostics.timing.guard.totalMs, 11000); return true;
  });
});

test('a never-resolving reader has a wall-clock deadline', async () => {
  const f = fixture(); f.options.now = Date.now;
  f.options.timeoutMs = 40; f.options.quietMs = 1; f.options.pollMs = 1;
  f.options.read = () => new Promise(() => {});
  await assert.rejects(wait(f.options), { code: 'INSTALL_SETTLEMENT_TIMEOUT_RECONCILE' });
});
