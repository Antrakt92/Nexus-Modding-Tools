import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { remote } from './bridge.mjs';
import {CONTEXT_KEYS, ROOTS, validateContext, validatePlan, planQueue} from './plan-contract.mjs';
import {canonicalPlanId, createPlanJournal} from './plan-journal.mjs';
import strictJSON from './strict-json.cjs';
export {validateContext, validatePlan} from './plan-contract.mjs';

const PROTOCOL = 'vortex-agent/1';
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const normalized = value => path.win32.normalize(value).toLowerCase();
function insist(value, code) { if (!value) throw new Error(code); }
function errorCode(error) { return /^[A-Z][A-Z0-9_]{1,99}$/.test(error?.message || '') ? error.message : 'SESSION_CALL_FAILED'; }
function synchronousJournal(value) {
  if (value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw Error('PLAN_JOURNAL_ASYNC_UNSUPPORTED');
  }
  return value;
}
function recorded(value) {insist(synchronousJournal(value) === undefined, 'PLAN_JOURNAL_INVALID_WRITER');}

export function createToolCaller(transport = remote) {
  return async (name, args = {}) => {
    const response = await transport('tools/call', { name, arguments: args });
    insist(object(response), 'INVALID_TOOL_RESPONSE');
    if (response.isError === true) {
      let code = 'REMOTE_TOOL_FAILED';
      try {
        const texts = response.content?.filter(item => item?.type === 'text');
        const value = texts?.length === 1 ? JSON.parse(texts[0].text) : null;
        if (typeof value?.error === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(value.error)) code = value.error;
      } catch { /* Never echo unstructured upstream errors or private transport text. */ }
      throw new Error(code);
    }
    const texts = response.content?.filter(item => item?.type === 'text');
    if (Object.hasOwn(response, 'structuredContent')) {
      insist(object(response.structuredContent), 'INVALID_TOOL_RESPONSE');
      if (texts?.length) {
        insist(texts.length === 1 && typeof texts[0].text === 'string', 'INVALID_TOOL_RESPONSE');
        let fallback;
        try { fallback = JSON.parse(texts[0].text); } catch { throw new Error('INVALID_TOOL_RESPONSE'); }
        insist(same(response.structuredContent, fallback), 'CONTRADICTORY_TOOL_RESPONSE');
      }
      return response.structuredContent;
    }
    insist(Array.isArray(texts) && texts.length === 1 && typeof texts[0].text === 'string', 'INVALID_TOOL_RESPONSE');
    try { return JSON.parse(texts[0].text); } catch { throw new Error('INVALID_TOOL_RESPONSE'); }
  };
}

function freshContext(health, expected) {
  insist(object(health) && health.protocol === PROTOCOL, 'WRONG_ADAPTER_PROTOCOL');
  const actual = Object.fromEntries(CONTEXT_KEYS.map(key => [key, health[key]]));
  validateContext(actual);
  insist(actual.gameId === expected.gameId && actual.profileId === expected.profileId
    && ROOTS.every(key => normalized(actual[key]) === normalized(expected[key])
      && actual.filesystemIds[key] === expected.filesystemIds[key]), 'PLAN_CONTEXT_DRIFT');
}

async function readPool(tasks, concurrency, {stopOnError = false} = {}) {
  insist(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'INVALID_READ_CONCURRENCY');
  const result = new Array(tasks.length); let next = 0, failed = false;
  await Promise.all(Array.from({length: Math.min(tasks.length, concurrency)}, async () => {
    for (;;) {
      if (stopOnError && failed) return;
      const index = next++;
      if (index >= tasks.length) return;
      try { result[index] = {value: await tasks[index]()}; }
      catch (error) { result[index] = {error: errorCode(error)}; failed = true; }
    }
  }));
  return result;
}

function validCollectionHealth(value) {
  const count = n => n === null || Number.isSafeInteger(n) && n >= 0;
  const flag = v => v === null || typeof v === 'boolean';
  if (!object(value) || !object(value.nativeConflicts) || !object(value.collectionSession)) return false;
  const native = value.nativeConflicts, session = value.collectionSession;
  return count(native.count) && flag(native.hasUnsolvedConflicts)
    && ['available', 'consistent', 'conflictsCalculated'].every(k => typeof native[k] === 'boolean')
    && typeof session.available === 'boolean' && flag(session.present) && flag(session.stalled)
    && object(session.counters) && ['totalRequired', 'totalOptional', 'downloadedCount', 'installedCount', 'failedCount', 'ignoredCount'].every(k => count(session.counters[k]))
    && value.recalculationVerified === false && value.diskDeploymentVerified === false;
}

export async function inspectSession({call = createToolCaller(), concurrency = 4, diagnostics = false} = {}) {
  insist(typeof diagnostics === 'boolean', 'INVALID_INSPECTION_OPTIONS');
  const names = ['list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes'];
  if (diagnostics) names.push('list_unsolved_conflicts', 'read_collection_health');
  return inspectReads({call, concurrency, names});
}

export async function inspectDownloadSession({call = createToolCaller(), gameId} = {}) {
  insist(typeof gameId === 'string' && /^[a-z0-9_-]{1,200}$/.test(gameId), 'INVALID_COLLECTION_REQUEST');
  return inspectReads({call, concurrency: 1, names: ['list_downloads'], expectedGameId: gameId});
}

async function inspectReads({call, concurrency, names, expectedGameId}) {
  const results = {}, errors = [];
  try {
    results.health = await call('health', {});
    insist(results.health?.protocol === PROTOCOL, 'WRONG_ADAPTER_PROTOCOL');
    validateContext(Object.fromEntries(CONTEXT_KEYS.map(key => [key, results.health[key]])));
    if (expectedGameId !== undefined) insist(results.health.gameId === expectedGameId, 'REQUESTED_GAME_NOT_ACTIVE');
  } catch (error) { return {status: 'partial', snapshotAtomic: false, results, errors: [{tool: 'health', code: errorCode(error)}]}; }
  const game = {gameId: results.health.gameId};
  const reads = await readPool(names.map(name => async () => {
    const value = await call(name, ['list_mods', 'list_downloads'].includes(name) ? {...game, limit: 500} : {});
    if (name === 'read_collection_health') {
      insist(validCollectionHealth(value), 'INVALID_COLLECTION_HEALTH_RESPONSE');
    } else insist(Array.isArray(value), 'INVALID_INVENTORY_RESPONSE');
    return value;
  }), concurrency);
  for (let i = 0; i < names.length; ++i) {
    if (reads[i].error) errors.push({tool: names[i], code: reads[i].error});
    else {
      results[names[i]] = reads[i].value;
      if (['list_mods', 'list_downloads'].includes(names[i]) && reads[i].value.length >= 500) errors.push({tool: names[i], code: 'INVENTORY_LIMIT_REACHED'});
    }
  }
  try {
    const after = await call('health', {});
    insist(after?.protocol === PROTOCOL && same(CONTEXT_KEYS.map(key => after[key]), CONTEXT_KEYS.map(key => results.health[key])), 'INSPECTION_CONTEXT_DRIFT');
  } catch (error) { errors.push({tool: 'health', code: errorCode(error)}); }
  return {status: errors.length ? 'partial' : 'ok', snapshotAtomic: false, inventoryLimit: 500, results, errors};
}

function cleanUnusedReceipt(value) {
  insist(object(value) && value.protocol === PROTOCOL && Array.isArray(value.receiptIssues)
    && value.receiptIssues.length === 0 && value.incompleteCompletionObserved === false
    && value.adapterTerminalReceiptObserved === false && value.terminalOperationVerified === false
    && value.attempt === null && value.completion === null && value.failure === null && value.interlock === null,
  'REQUEST_ID_USED_OR_RECEIPT_UNCERTAIN');
}
function verifiedAcknowledgement(value, operation, args) {
  insist(object(value) && value.protocol === PROTOCOL && value.operation === operation && value.requestId === args.requestId
    && value.operationCompleted === true && value.diskDeploymentVerified === false, 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
  if (operation === 'deploy_mods') insist(value.deploymentPromiseResolved === true, 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
  else if (operation === 'download_nexus') insist(id(value.downloadId) && typeof value.reused === 'boolean'
    && (!args.reuseOnly || value.reused) && value.autoInstall === false && value.archiveSha256Verified === true
    && value.archiveCRCVerified === false && value.size === args.size, 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
  else insist(value.enabledFlagsVerified === true && value.enabled === args.enabled && same(value.modIds, args.modIds), 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
}
function verifiedReceipt(value, operation, args, acknowledgement) {
  insist(object(value) && value.protocol === PROTOCOL && value.terminalOperationVerified === true
    && value.adapterTerminalReceiptObserved === true && value.incompleteCompletionObserved === false
    && Array.isArray(value.receiptIssues) && value.receiptIssues.length === 0 && value.failure === null && value.interlock === null
    && value.attempt?.operation === operation && value.attempt?.requestId === args.requestId
    && value.attempt?.gameId === args.gameId && value.attempt?.profileId === args.profileId
    && value.completion?.gameId === args.gameId && value.completion?.profileId === args.profileId
    && same(value.attempt?.parameters, args), 'TERMINAL_RECEIPT_UNCERTAIN');
  verifiedAcknowledgement(value.completion, operation, args);
  insist(same(acknowledgement, Object.fromEntries(Object.keys(acknowledgement).map(key => [key, value.completion[key]]))), 'ACK_RECEIPT_MISMATCH');
}
function receiptSummary(value) {
  return {attemptObserved: object(value?.attempt), completionObserved: object(value?.completion), failureObserved: object(value?.failure),
    interlockObserved: object(value?.interlock), terminalOperationVerified: value?.terminalOperationVerified === true,
    receiptIssues: Array.isArray(value?.receiptIssues) ? value.receiptIssues.filter(item => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item)) : ['UNVERIFIABLE_RESPONSE']};
}

export async function runPlan(input, {apply = false, call = createToolCaller(), signal, journal} = {}) {
  const plan = validatePlan(input);
  insist(typeof apply === 'boolean', 'INVALID_APPLY_FLAG');
  insist(signal === undefined || signal instanceof AbortSignal, 'INVALID_PLAN_SIGNAL');
  const queue = planQueue(plan), planId = canonicalPlanId(plan);
  if (!apply) return {status: 'validated', planId, applied: false, operationCount: queue.length, requestIds: queue.map(item => item.args.requestId),
    diskDeploymentVerified: false, message: 'Offline validation only. Apply the exact reviewed plan explicitly; no Vortex calls were made.'};
  const completed = []; let current, execution;
  const checkCancellation = () => insist(!signal?.aborted, 'PLAN_CANCELLED');
  try {
    execution = synchronousJournal((journal ?? createPlanJournal()).begin(plan));
    insist(object(execution) && execution.planId === planId
      && ['intent', 'observed', 'finish'].every(key => typeof execution[key] === 'function'), 'PLAN_JOURNAL_INVALID_WRITER');
    // Check the entire queue before any effect: a used later ID must not cause a partial replay.
    checkCancellation();
    const preflight = await readPool(queue.map(item => async () => {
      checkCancellation();
      cleanUnusedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}));
    }), 4, {stopOnError: true});
    const failed = preflight.findIndex(result => result?.error);
    if (failed !== -1) {
      current = {...queue[failed], invoked: false};
      throw Error(preflight[failed].error);
    }
    for (const [index, item] of queue.entries()) {
      checkCancellation();
      current = {...item, invoked: false};
      cleanUnusedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}));
      checkCancellation();
      freshContext(await call('health', {}), plan.context);
      checkCancellation();
      // Persist uncertainty before sending. A failed durable write must never
      // become permission to dispatch without an inspectable original intent.
      recorded(execution.intent(index, item.operation, item.args));
      checkCancellation();
      current.invoked = true;
      const acknowledgement = await call(item.operation, item.args);
      verifiedAcknowledgement(acknowledgement, item.operation, item.args);
      // An in-flight mutation is not abandoned on cancellation: establish its
      // exact receipt first, then stop before invoking any later step.
      verifiedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}), item.operation, item.args, acknowledgement);
      completed.push({operation: item.operation, requestId: item.args.requestId, adapterReceiptVerified: true,
        ...(item.operation === 'download_nexus' ? {downloadId: acknowledgement.downloadId, reused: acknowledgement.reused,
          size: acknowledgement.size, archiveSha256Verified: true, archiveCRCVerified: false} : {})});
      recorded(execution.observed(index));
      current = undefined;
      checkCancellation();
    }
    recorded(execution.finish('completed'));
    return {status: 'completed', planId, completed, diskDeploymentVerified: false,
      verificationRequired: 'Independently verify archive CRC, preserved state, deployment manifest, owners, hashes and hardlinks. Adapter receipts do not prove installation, disk deployment or gameplay acceptance.'};
  } catch (error) {
    let reconciliation;
    if (current?.invoked) {
      try { reconciliation = receiptSummary(await call('reconcile_operation', {requestId: current.args.requestId})); }
      catch { reconciliation = {receiptIssues: ['RECONCILIATION_UNAVAILABLE']}; }
    }
    let journalIssue;
    if (execution) {
      try {recorded(execution.finish('stopped', errorCode(error)));}
      catch (failure) {journalIssue = errorCode(failure);}
    }
    return {status: 'stopped', planId, completed, diskDeploymentVerified: false, code: errorCode(error),
      ...(current ? {requestId: current.args.requestId, operation: current.operation, invocationAttempted: current.invoked} : {}),
      ...(reconciliation ? {reconciliation} : {}),
      ...(journalIssue ? {journalIssue} : {}),
      instruction: 'Stop and inspect the exact existing request receipts. Do not generate new request IDs or retry an uncertain write.'};
  }
}

export async function inspectPlan(planId, {call = createToolCaller(), journal} = {}) {
  const base = {...(typeof planId === 'string' && /^[a-f0-9]{64}$/.test(planId) ? {planId} : {}), diskDeploymentVerified: false, currentStateVerified: false,
    retryAllowed: false, resumeSupported: false, snapshotAtomic: false, executionLiveness: 'unknown'};
  try {
    insist(typeof planId === 'string' && /^[a-f0-9]{64}$/.test(planId), 'INVALID_PLAN_ID');
    const store = journal ?? createPlanJournal(), stored = synchronousJournal(store.read(planId));
    if (stored === null) return {...base, status: 'not_observed', journalObserved: false,
      instruction: 'No journal was observed in this configured workspace. This does not establish that another client or workspace performed no effects.'};
    const plan = validatePlan(stored.plan);
    insist(canonicalPlanId(plan) === planId, 'PLAN_JOURNAL_ID_MISMATCH');
    const queue = planQueue(plan), intents = stored.events.filter(event => event.kind === 'intent');
    const reads = await readPool(intents.map(event => async () => {
      const item = queue[event.index];
      const value = await call('reconcile_operation', {requestId: item.args.requestId});
      // Status is deliberately conservative about a current global interlock.
      // It never relaxes the execution gate or infers current flags from history.
      insist(!object(value?.interlock), 'CURRENT_INTERLOCK_OBSERVED');
      verifiedReceipt(value, item.operation, item.args, value.completion);
      return {adapterReceiptVerified: true};
    }), 4);
    const byIndex = new Map(intents.map((event, n) => [event.index, reads[n]]));
    const steps = queue.map((item, index) => {
      const observed = byIndex.get(index);
      return {index, operation: item.operation, requestId: item.args.requestId,
        state: !observed ? 'intent_not_recorded' : observed.error ? 'uncertain' : 'adapter_completed',
        remoteChecked: !!observed, ...(observed?.error ? {code: observed.error} : {})};
    });
    let journalAdvanced = false, journalIssue;
    try {
      const after = synchronousJournal(store.read(planId));
      insist(after !== null && same(after.plan, stored.plan), 'PLAN_JOURNAL_CHANGED');
      journalAdvanced = !same(after.events, stored.events);
    } catch (error) {journalIssue = errorCode(error);}
    return {...base, journalObserved: true, journalState: stored.state,
      journalAdvanced, ...(journalIssue ? {journalIssue} : {}),
      status: !journalAdvanced && !journalIssue && steps.every(step => step.state === 'adapter_completed') ? 'completed' : 'partial',
      steps, instruction: 'Historical exact receipts only. An intent without verified completion remains uncertain. Do not resubmit this plan, clear locks or generate replacement request IDs. Independently verify current state and disk deployment.'};
  } catch (error) {return {...base, status: 'partial', code: errorCode(error), journalUsable: false};}
}

async function readPlan(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    insist(bytesRead <= 1024 * 1024, 'PLAN_FILE_TOO_LARGE');
    try { return strictJSON.parseStrictJSON(buffer.subarray(0, bytesRead), {maxBytes: 1024 * 1024}); }
    catch { throw new Error('INVALID_PLAN_FILE'); }
  } finally { await file.close(); }
}

export async function main(argv = process.argv.slice(2), {call = createToolCaller(), read = readPlan, journal, output = value => process.stdout.write(JSON.stringify(value) + '\n')} = {}) {
  let result;
  try {
    if (argv[0] === 'inspect' && (argv.length === 1 || argv.length === 2 && argv[1] === '--diagnostics'))
      result = await inspectSession({call, diagnostics: argv[1] === '--diagnostics'});
    else if ((argv.length === 2 || argv.length === 3 && argv[2] === '--apply') && argv[0] === 'plan')
      result = await runPlan(await read(argv[1]), {apply: argv[2] === '--apply', call, journal});
    else if (argv.length === 2 && argv[0] === 'plan-status') result = await inspectPlan(argv[1], {call, journal});
    else throw new Error('USAGE_INSPECT_OR_PLAN_FILE_OPTIONAL_APPLY');
  } catch (error) { result = {status: 'stopped', code: errorCode(error), diskDeploymentVerified: false}; }
  output(result);
  return ['ok', 'validated', 'completed'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
