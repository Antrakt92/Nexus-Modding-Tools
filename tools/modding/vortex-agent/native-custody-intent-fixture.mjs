// Own native-test fixture only. No Vortex context, dispatch or recovery permit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = path.resolve(HERE, '../../../local-state/native-custody-process-tests');
const INTENT_SOURCES = ['native-intent-journal.mjs', 'immutable-records.mjs', 'strict-json.cjs',
  'paths.cjs', 'native-dispatch-contract.cjs', 'install-job-contract.cjs'];
const need = (ok, code) => {if (!ok) throw Error('CUSTODY_INTENT_FIXTURE_' + code);};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ordinary(file) {
  for (let node = file;; node = path.dirname(node)) {
    const stat = fs.lstatSync(node);
    need(!stat.isSymbolicLink(), 'UNSAFE_PATH');
    if (node === path.dirname(node)) break;
  }
}
function context(candidate) {
  need(process.platform === 'win32' && typeof candidate === 'string' && path.isAbsolute(candidate), 'WINDOWS_SCOPE');
  const run = path.resolve(candidate);
  need(path.dirname(run) === TASK && /^custody-run-[a-z0-9_]+$/.test(path.basename(run)), 'RUN_SCOPE');
  ordinary(run);
  const planPath = path.join(run, 'PLAN.json'); ordinary(planPath);
  need(fs.statSync(planPath).size <= 1024 * 1024, 'PLAN_LIMIT');
  const planBytes = fs.readFileSync(planPath), plan = JSON.parse(planBytes.toString('utf8'));
  need(plan.schema === 'own-custody-process-fixture/1'
    && ['suspended', 'running'].includes(plan.crashStage) && plan.guardianCustody === true, 'PLAN_SCOPE');
  const pins = plan.intentSourceSHA256;
  need(pins && Object.keys(pins).sort().join('|') === [...INTENT_SOURCES].sort().join('|')
    && INTENT_SOURCES.every(name => typeof pins[name] === 'string'
      && /^[a-f0-9]{64}$/.test(pins[name]) && hash(fs.readFileSync(path.join(HERE, name))) === pins[name])
    && hash(fs.readFileSync(fileURLToPath(import.meta.url))) === plan.intentHelperSHA256, 'INTENT_SOURCE_DRIFT');
  need(hash(fs.readFileSync(path.join(HERE, 'native-custody-process.test.py'))) === plan.scriptSHA256
    && hash(fs.readFileSync(path.join(HERE, 'owned-file-transfer.py'))) === plan.moduleSHA256, 'SOURCE_DRIFT');
  const archive = path.join(run, 'archives', 'own.zip'); ordinary(archive);
  need(fs.statSync(archive).size === plan.archiveBytes && plan.archiveBytes <= 64 * 1024 * 1024, 'ARCHIVE_LIMIT');
  const archiveBytes = fs.readFileSync(archive);
  need(hash(archiveBytes) === plan.archiveSHA256, 'ARCHIVE_DRIFT');
  return {run, plan, planBytes, archiveBytes};
}
function writeNew(file, value) {
  const fd = fs.openSync(file, 'wx');
  try {fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
}
function compact(status) {
  need(status.state === 'intent_observed' && status.dispatchState === 'unknown'
    && status.reconcileRequired === true && status.canReplay === false
    && status.effectsAllowed === false && status.powerLossPersistenceVerified === false, 'STATUS_NOT_HELD');
  return {state: status.state, dispatchState: status.dispatchState,
    reconcileRequired: true, canReplay: false, effectsAllowed: false,
    powerLossPersistenceVerified: false, operationId: status.operationId,
    requestSHA256: status.requestSHA256};
}
export function beginFixtureIntent(candidate) {
  const {run, plan, planBytes, archiveBytes} = context(candidate);
  const nonce = () => crypto.randomBytes(16).toString('hex');
  const roots = {gamePath: path.join(run, 'final'), stagingPath: path.join(run, 'temps'),
    downloadPath: path.join(run, 'archives')};
  const filesystemIds = Object.fromEntries(Object.entries(roots).map(([key, file]) => {
    ordinary(file); const stat = fs.statSync(file, {bigint: true}); return [key, `${stat.dev}:${stat.ino}`];
  }));
  // These are own fixture directories and modeled metadata, never admitted game roots.
  const model = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture-own', ...roots, filesystemIds},
    package: {downloadId: 'fixture-own', fileName: 'own.zip', expectedModId: 'own', expectedType: '',
      bytes: plan.archiveBytes, sha256: plan.archiveSHA256,
      md5: crypto.createHash('md5').update(archiveBytes).digest('hex'),
      expectedUncompressedBytes: plan.unpackedBytes, payload: plan.payloadManifest},
    evidence: {buildSHA256: plan.scriptSHA256, sourceSHA256: plan.moduleSHA256,
      nativeAdmissionSHA256: hash(Buffer.from('own fixture only; native admission unproved'))},
    options: {enabled: false, deploy: false}};
  const request = {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID,
    operationId: 'op_' + nonce(), nativeJobId: 'exec_' + nonce(), planId: job.installPlanId(model),
    managerScope: 'manager-fixture-1', rendererGeneration: 'renderer_' + nonce(),
    admissionSHA256: hash(planBytes), plan: model};
  const bytes = Buffer.from(JSON.stringify(request)), requestSHA256 = dispatch.dispatchRequestDigest(bytes);
  const binding = {operationId: request.operationId, nativeJobId: request.nativeJobId,
    requestSHA256, rendererGeneration: request.rendererGeneration};
  // The parent retains this separately before launching the guardian. Recovery
  // receives its expected digest explicitly; it never derives binding from intent.
  writeNew(path.join(run, 'EXPECTED-BINDING.json'), binding);
  const journal = createNativeIntentJournal({root: path.join(run, 'native-intents')});
  const status = compact(journal.begin(bytes));
  context(candidate);
  writeNew(path.join(run, 'JOURNAL-BEFORE.json'), status);
  return binding;
}
export function readFixtureIntent(candidate, operationId, expectedRequestSHA256) {
  const {run} = context(candidate);
  need(/^op_[a-f0-9]{32}$/.test(operationId) && /^[a-f0-9]{64}$/.test(expectedRequestSHA256), 'EXPECTED_BINDING');
  const journal = createNativeIntentJournal({root: path.join(run, 'native-intents')});
  const status = compact(journal.read(operationId, expectedRequestSHA256));
  context(candidate);
  writeNew(path.join(run, 'JOURNAL-AFTER.json'), status);
  return status;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, run, operationId, digest, ...extra] = process.argv.slice(2);
    need(extra.length === 0 && ((mode === 'begin' && operationId === undefined && digest === undefined)
      || (mode === 'read' && operationId !== undefined && digest !== undefined)), 'ARGUMENTS');
    const result = mode === 'begin' ? beginFixtureIntent(run) : readFixtureIntent(run, operationId, digest);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {process.stderr.write('Custody intent fixture refused; preserve its original attempt.\n'); process.exitCode = 1;}
}
