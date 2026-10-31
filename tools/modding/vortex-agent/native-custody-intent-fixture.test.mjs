import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {beginFixtureIntent, readFixtureIntent} from './native-custody-intent-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = path.resolve(HERE, '../../../local-state/native-custody-process-tests');
const sources = ['native-intent-journal.mjs', 'immutable-records.mjs', 'strict-json.cjs',
  'paths.cjs', 'native-dispatch-contract.cjs', 'install-job-contract.cjs'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pinned = file => sha(fs.readFileSync(path.join(HERE, file)));
function fixture() {
  for (let node = TASK;; node = path.dirname(node)) {
    if (fs.existsSync(node)) assert(!fs.lstatSync(node).isSymbolicLink());
    if (node === path.dirname(node)) break;
  }
  fs.mkdirSync(TASK, {recursive: true});
  const run = path.join(TASK, 'custody-run-' + crypto.randomBytes(12).toString('hex'));
  fs.mkdirSync(run);
  for (const name of ['archives', 'temps', 'final']) fs.mkdirSync(path.join(run, name));
  // The journal validates a data model, not ZIP format or native admission.
  const own = Buffer.from('own metadata fixture; no native execution');
  fs.writeFileSync(path.join(run, 'archives', 'own.zip'), own, {flag: 'wx'});
  const plan = {schema: 'own-custody-process-fixture/1', guardianCustody: true,
    crashStage: 'suspended', archiveBytes: own.length, archiveSHA256: sha(own),
    scriptSHA256: pinned('native-custody-process.test.py'),
    moduleSHA256: pinned('owned-file-transfer.py'),
    intentHelperSHA256: pinned('native-custody-intent-fixture.mjs'),
    intentSourceSHA256: Object.fromEntries(sources.map(name => [name, pinned(name)])),
    unpackedBytes: 1, payloadManifest: {'payload.bin': sha(Buffer.from('x'))}};
  const file = path.join(run, 'PLAN.json');
  fs.writeFileSync(file, JSON.stringify(plan), {flag: 'wx'});
  return {run, plan, file};
}
const native = {skip: process.platform !== 'win32'};
test('fixture rejects stale journal closure before creating any intent', native, () => {
  const {run, plan, file} = fixture();
  plan.intentSourceSHA256['native-intent-journal.mjs'] = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.throws(() => beginFixtureIntent(run), /INTENT_SOURCE_DRIFT/);
  assert(!fs.existsSync(path.join(run, 'EXPECTED-BINDING.json')));
  assert(!fs.existsSync(path.join(run, 'native-intents')));
});
test('fresh fixture recovery uses held independent binding and refuses source drift', native, () => {
  const {run, plan, file} = fixture(), binding = beginFixtureIntent(run);
  const intent = path.join(run, 'native-intents', binding.operationId, 'intent.json');
  const before = fs.readFileSync(intent);
  const status = readFixtureIntent(run, binding.operationId, binding.requestSHA256);
  assert.equal(status.dispatchState, 'unknown'); assert.equal(status.canReplay, false);
  assert.equal(status.effectsAllowed, false); assert.equal(status.reconcileRequired, true);
  assert.throws(() => readFixtureIntent(run, binding.operationId, '0'.repeat(64)), /BINDING_MISMATCH/);
  assert.throws(() => beginFixtureIntent(run), /EEXIST/);
  plan.intentSourceSHA256['strict-json.cjs'] = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.throws(() => readFixtureIntent(run, binding.operationId, binding.requestSHA256), /INTENT_SOURCE_DRIFT/);
  assert.deepEqual(fs.readFileSync(intent), before);
});
