import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalPlanId, createPlanJournal } from './plan-journal.mjs';
import { planQueue } from './plan-contract.mjs';

function plan() {
  return { version: 1, context: { gameId: 'cyberpunk2077', profileId: 'profile', gamePath: 'F:/Game', stagingPath: 'F:/Stage', downloadPath: 'D:/Downloads',
    filesystemIds: { gamePath: '1:2', stagingPath: '1:3', downloadPath: '4:5' } },
  steps: [{ operation: 'set_mods_enabled', requestId: 'journal_enable_01', modIds: ['first', 'second'], enabled: true }],
  deploy: { requestId: 'journal_deploy_01' } };
}
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-journal-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true }));
  const root = path.join(workspace, 'private', 'plans'), store = createPlanJournal({ root });
  return { workspace, root, store };
}
function eventPath(root, planId, number = 1) { return path.join(root, planId, String(number).padStart(6, '0') + '.json'); }
function changedJSON(file, mutate) { const value = JSON.parse(fs.readFileSync(file)); mutate(value); fs.writeFileSync(file, JSON.stringify(value)); }
function allObserved(writer, value) {
  for (const [index, item] of planQueue(value).entries()) { writer.intent(index, item.operation, item.args); writer.observed(index); }
}

test('semantic ID sorts object keys, preserves exact arrays/context, and rejects invalid or oversized plans', () => {
  const value = plan(), reordered = JSON.parse(JSON.stringify(value));
  reordered.context = Object.fromEntries(Object.entries(reordered.context).reverse());
  reordered.context.filesystemIds = Object.fromEntries(Object.entries(reordered.context.filesystemIds).reverse());
  assert.equal(canonicalPlanId(value), canonicalPlanId(reordered));
  reordered.steps[0].modIds.reverse(); assert.notEqual(canonicalPlanId(value), canonicalPlanId(reordered));
  reordered.steps[0].modIds.reverse(); reordered.context.gamePath = 'f:/Game';
  assert.notEqual(canonicalPlanId(value), canonicalPlanId(reordered));
  assert.throws(() => canonicalPlanId({ ...value, unknown: true }), /PLAN_JOURNAL_INVALID_PLAN/);
  const oversized = plan(); oversized.steps = Array.from({ length: 100 }, (_, n) => ({ operation: 'set_mods_enabled',
    requestId: `journal_large_${n}`, modIds: Array.from({ length: 100 }, (_, m) => 'x'.repeat(195) + String(m).padStart(3, '0')), enabled: false }));
  assert.throws(() => canonicalPlanId(oversized), /PLAN_JOURNAL_LIMIT/);
});
test('missing journal reads create no directory and invalid IDs never select arbitrary paths', t => {
  const { root, store } = fixture(t);
  assert.equal(store.read(canonicalPlanId(plan())), null); assert(!fs.existsSync(root));
  for (const value of ['../anything', 'A'.repeat(64), '', 'f'.repeat(65)])
    assert.throws(() => store.read(value), /PLAN_JOURNAL_INVALID_ID/);
  assert(!fs.existsSync(root));
});
test('begin durably freezes semantic data, uses immutable events, and never resumes even completed plans', t => {
  const { root, store } = fixture(t), value = plan(), frozen = structuredClone(value), writer = store.begin(value);
  value.context.profileId = 'changed'; value.steps[0].modIds.push('extra');
  assert.deepEqual(store.read(writer.planId).plan, frozen);
  assert.equal(store.read(writer.planId).state, 'prepared');
  const first = planQueue(frozen)[0]; writer.intent(0, first.operation, first.args);
  assert.equal(store.read(writer.planId).state, 'inflight'); writer.observed(0);
  assert.equal(store.read(writer.planId).state, 'running');
  const deploy = planQueue(frozen)[1]; writer.intent(1, deploy.operation, deploy.args); writer.observed(1); writer.finish('completed');
  const read = createPlanJournal({ root }).read(writer.planId);
  assert.equal(read.state, 'completed'); assert.equal(read.events.length, 5); assert.equal(read.observed, 2);
  assert.throws(() => store.begin(frozen), /PLAN_JOURNAL_EXISTS_HOLD/);
  assert.throws(() => writer.finish('stopped', 'LATE_RETRY'), /PLAN_JOURNAL_CORRUPT/);
  assert.equal(fs.readdirSync(path.join(root, writer.planId)).filter(n => n.includes('pending')).length, 0);
});
test('only exact frozen queue arguments and legal intent/observation order can be appended', t => {
  for (const mode of ['args', 'operation', 'index', 'observed-before-intent', 'completed-early']) {
    const { store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0];
    assert.throws(() => {
      if (mode === 'args') writer.intent(0, first.operation, { ...first.args, enabled: false });
      if (mode === 'operation') writer.intent(0, 'install_download', first.args);
      if (mode === 'index') writer.intent(1, first.operation, first.args);
      if (mode === 'observed-before-intent') writer.observed(0);
      if (mode === 'completed-early') writer.finish('completed');
    }, /PLAN_JOURNAL_CORRUPT/);
    assert.throws(() => writer.finish('stopped', 'RETRY'), /PLAN_JOURNAL_HELD/);
    assert.equal(store.read(writer.planId).events.length, 0);
  }
});
test('stopped terminals preserve an unobserved original intent and never manufacture completion', t => {
  const { store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0];
  writer.intent(0, first.operation, first.args); writer.finish('stopped', 'CALLBACK_LOST');
  const read = store.read(writer.planId); assert.equal(read.state, 'stopped'); assert.equal(read.pending, 0);
  assert.equal(read.observed, 0); assert.equal(read.terminal.code, 'CALLBACK_LOST');
  assert.throws(() => store.begin(value), /PLAN_JOURNAL_EXISTS_HOLD/);
});
test('maximum queue writes at most 203 immutable events and preserves exact final deployment', t => {
  const { store } = fixture(t), value = plan();
  value.steps = Array.from({ length: 100 }, (_, n) => ({ operation: 'set_mods_enabled', requestId: `journal_max_${n}`, modIds: ['own'], enabled: false }));
  const writer = store.begin(value); allObserved(writer, value); writer.finish('completed');
  const read = store.read(writer.planId); assert.equal(read.events.length, 203); assert.equal(read.observed, 101);
  assert.equal(read.events.at(-3).operation, 'deploy_mods'); assert.equal(read.state, 'completed');
});
test('an exclusive reservation race preserves the other directory and never writes into it', t => {
  const { root, store } = fixture(t), value = plan(), id = canonicalPlanId(value), mkdir = fs.mkdirSync;
  fs.mkdirSync = (dir, ...args) => {
    if (dir === path.join(root, id)) { mkdir(dir, ...args); fs.writeFileSync(path.join(dir, 'foreign.txt'), 'keep'); }
    return mkdir(dir, ...args);
  };
  try { assert.throws(() => store.begin(value), /PLAN_JOURNAL_EXISTS_HOLD/); }
  finally { fs.mkdirSync = mkdir; }
  assert.equal(fs.readFileSync(path.join(root, id, 'foreign.txt'), 'utf8'), 'keep');
  assert.throws(() => store.read(id), /PLAN_JOURNAL_CORRUPT/);
});
test('fsync failure before an intent returns poisons the writer and retains partial evidence', t => {
  const { root, store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0], sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('synthetic private failure detail'); };
  try { assert.throws(() => writer.intent(0, first.operation, first.args), /^Error: PLAN_JOURNAL_IO_FAILED$/); }
  finally { fs.fsyncSync = sync; }
  assert.throws(() => writer.finish('stopped', 'JOURNAL_WRITE_FAILED'), /PLAN_JOURNAL_HELD/);
  assert(fs.readdirSync(path.join(root, writer.planId)).some(n => n.includes('pending')));
  assert.throws(() => createPlanJournal({ root }).read(writer.planId), /PLAN_JOURNAL_CORRUPT/);
  assert.throws(() => store.begin(value), /PLAN_JOURNAL_EXISTS_HOLD/);
});
test('same-size mutation during fsync cannot become a successful durable intent', t => {
  const { root, store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0], sync = fs.fsyncSync;
  let mutated = false;
  fs.fsyncSync = fd => {
    sync(fd); const dir = path.join(root, writer.planId), name = fs.readdirSync(dir).find(n => n.includes('pending'));
    const bytes = fs.readFileSync(path.join(dir, name)), from = bytes.indexOf('first');
    assert(from >= 0); fs.writeSync(fd, Buffer.from('other'), 0, 5, from); mutated = true;
  };
  try { assert.throws(() => writer.intent(0, first.operation, first.args), /PLAN_JOURNAL_CHANGED/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(mutated, true);
  assert.throws(() => writer.finish('stopped', 'RETRY'), /PLAN_JOURNAL_HELD/);
});
test('write failure after a published intent retains it and blocks all later appends', t => {
  const { root, store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0];
  writer.intent(0, first.operation, first.args);
  const open = fs.openSync;
  fs.openSync = (file, ...args) => { if (String(file).includes('000002.json.pending')) throw Error('full disk'); return open(file, ...args); };
  try { assert.throws(() => writer.observed(0), /PLAN_JOURNAL_IO_FAILED/); }
  finally { fs.openSync = open; }
  const read = createPlanJournal({ root }).read(writer.planId); assert.equal(read.state, 'inflight'); assert.equal(read.events.length, 1);
  assert.throws(() => writer.finish('stopped', 'RETRY'), /PLAN_JOURNAL_HELD/);
});
test('duplicate keys, malformed JSON, changed queue and unknown/missing event files are held read-only', t => {
  for (const mode of ['duplicate', 'truncated', 'changed-args', 'extra', 'gap', 'too-large']) {
    const { root, store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0];
    writer.intent(0, first.operation, first.args); const file = eventPath(root, writer.planId);
    if (mode === 'duplicate') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"kind":', '"kind":"observed","kind":'));
    if (mode === 'truncated') fs.writeFileSync(file, '{');
    if (mode === 'changed-args') changedJSON(file, e => { e.args.enabled = false; });
    if (mode === 'extra') fs.writeFileSync(path.join(root, writer.planId, 'unexpected.json'), '{}');
    if (mode === 'gap') fs.renameSync(file, eventPath(root, writer.planId, 2));
    if (mode === 'too-large') fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => createPlanJournal({ root }).read(writer.planId), /PLAN_JOURNAL_CORRUPT/);
  }
});
test('existing empty journals and missing plan files are corrupt rather than absent', t => {
  const { root, store } = fixture(t), value = plan(), id = canonicalPlanId(value);
  fs.mkdirSync(path.join(root, id), { recursive: true });
  assert.throws(() => store.read(id), /PLAN_JOURNAL_CORRUPT/);
  assert.throws(() => store.begin(value), /PLAN_JOURNAL_EXISTS_HOLD/);
});
test('reparse ancestors and replaced plan directories stop writers without deleting foreign files', t => {
  const f = fixture(t), target = path.join(f.workspace, 'target'), alias = path.join(f.workspace, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  const unsafe = createPlanJournal({ root: path.join(alias, 'plans') });
  assert.throws(() => unsafe.begin(plan()), /PLAN_JOURNAL_UNSAFE_PATH/); assert.deepEqual(fs.readdirSync(target), []);
  const writer = f.store.begin(plan()), dir = path.join(f.root, writer.planId);
  fs.renameSync(dir, dir + '-old'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'foreign.txt'), 'keep');
  assert.throws(() => writer.finish('stopped', 'RETRY'), /PLAN_JOURNAL_PATH_CHANGED/);
  assert.equal(fs.readFileSync(path.join(dir, 'foreign.txt'), 'utf8'), 'keep');
});
test('an externally modified immutable event halts later appends and cannot be overwritten', t => {
  const { root, store } = fixture(t), value = plan(), writer = store.begin(value), first = planQueue(value)[0];
  writer.intent(0, first.operation, first.args); const file = eventPath(root, writer.planId); fs.appendFileSync(file, ' ');
  assert.throws(() => writer.observed(0), /PLAN_JOURNAL_CHANGED/); assert(fs.readFileSync(file, 'utf8').endsWith(' '));
  assert(!fs.existsSync(eventPath(root, writer.planId, 2)));
});
test('root replacement during reservation cannot redirect a write into the foreign directory', t => {
  const {root, store} = fixture(t), value = plan(), id = canonicalPlanId(value);
  const mkdir = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = (file, ...args) => {
    const result = mkdir(file, ...args);
    if (!swapped && String(file) === path.join(root, id)) {
      swapped = true; fs.renameSync(root, root + '-original'); mkdir(root);
      mkdir(path.join(root, id));
    }
    return result;
  };
  try {assert.throws(() => store.begin(value), /PLAN_JOURNAL_PATH_CHANGED/);}
  finally {fs.mkdirSync = mkdir;}
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(path.join(root, id)), []);
  assert.deepEqual(fs.readdirSync(path.join(root + '-original', id)), []);
});

test('reading cannot adopt a replacement root even if the original child directory is moved into it', t => {
  const {root, store} = fixture(t), writer = store.begin(plan()), dir = path.join(root, writer.planId);
  const original = fs.lstatSync; let swapped = false;
  fs.lstatSync = (file, ...args) => {
    const result = original(file, ...args);
    if (!swapped && String(file) === dir) {
      swapped = true; fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
      fs.renameSync(path.join(root + '-old', writer.planId), dir);
    }
    return result;
  };
  try {assert.throws(() => store.read(writer.planId), /PLAN_JOURNAL_PATH_CHANGED/);}
  finally {fs.lstatSync = original;}
  assert.equal(swapped, true); assert(fs.existsSync(path.join(dir, 'plan.json')));
});

test('default journal root follows the configured runtime workspace rather than current/source directory', t => {
  const { workspace } = fixture(t), prior = process.env.NEXUS_WORKSPACE; process.env.NEXUS_WORKSPACE = workspace;
  try {
    const writer = createPlanJournal().begin(plan());
    assert(fs.existsSync(path.join(workspace, 'local-state/vortex-agent-build/plan-journals', writer.planId, 'plan.json')));
    const receipts = path.join(workspace, 'local-state/vortex-agent-build/receipts'); fs.mkdirSync(receipts);
    fs.writeFileSync(path.join(receipts, 'original.json'), '{}');
    const installer = fileURLToPath(new URL('./manage-install.py', import.meta.url));
    const result = execFileSync('python', ['-B', '-c',
      "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('journal_receipt_test',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); p=m.receipt_pins(); print(json.dumps({'receiptNames':list(p)}))", installer],
    { encoding: 'utf8', env: { ...process.env, NEXUS_WORKSPACE: workspace } });
    assert.deepEqual(JSON.parse(result), { receiptNames: ['original.json'] });
    assert.deepEqual(fs.readdirSync(receipts), ['original.json']);
  } finally { if (prior === undefined) delete process.env.NEXUS_WORKSPACE; else process.env.NEXUS_WORKSPACE = prior; }
});
