import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { remote } from './bridge.mjs';

const PROTOCOL = 'vortex-agent/1';
const CONTEXT_KEYS = ['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'];
const ROOTS = ['gamePath', 'stagingPath', 'downloadPath'];
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const normalized = value => path.win32.normalize(value).toLowerCase();
function insist(value, code) { if (!value) throw new Error(code); }
function errorCode(error) { return /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SESSION_CALL_FAILED'; }

export function validateContext(value) {
  insist(keys(value, CONTEXT_KEYS) && id(value.gameId) && id(value.profileId), 'INVALID_PLAN_CONTEXT');
  insist(keys(value.filesystemIds, ROOTS), 'INVALID_PLAN_CONTEXT');
  for (const key of ROOTS) {
    insist(typeof value[key] === 'string' && value[key].length <= 200 && /^[a-z]:[\\/]/i.test(value[key])
      && !/[\x00-\x1f]/.test(value[key]) && typeof value.filesystemIds[key] === 'string'
      && /^\d+:\d+$/.test(value.filesystemIds[key]), 'INVALID_PLAN_CONTEXT');
  }
  return value;
}

export function validatePlan(input) {
  insist(keys(input, ['version', 'context', 'steps', 'deploy']) && input.version === 1, 'INVALID_PLAN');
  validateContext(input.context);
  insist(Array.isArray(input.steps) && input.steps.length <= 100, 'INVALID_PLAN_STEPS');
  const ids = new Set();
  for (const step of input.steps) {
    insist(keys(step, ['operation', 'requestId', 'modIds', 'enabled']) && step.operation === 'set_mods_enabled'
      && requestId(step.requestId) && typeof step.enabled === 'boolean' && Array.isArray(step.modIds)
      && step.modIds.length > 0 && step.modIds.length <= 100 && step.modIds.every(id)
      && new Set(step.modIds).size === step.modIds.length, 'INVALID_PLAN_STEP');
    insist(!ids.has(step.requestId), 'DUPLICATE_REQUEST_ID'); ids.add(step.requestId);
  }
  if (input.deploy !== null) {
    insist(keys(input.deploy, ['requestId']) && requestId(input.deploy.requestId), 'INVALID_DEPLOY_STEP');
    insist(!ids.has(input.deploy.requestId), 'DUPLICATE_REQUEST_ID');
  }
  insist(input.steps.length > 0 || input.deploy !== null, 'EMPTY_PLAN');
  // Detach the queue from caller changes while asynchronous checks are pending.
  return JSON.parse(JSON.stringify(input));
}

export function createToolCaller(transport = remote) {
  return async (name, args = {}) => {
    const response = await transport('tools/call', { name, arguments: args });
    insist(object(response), 'INVALID_TOOL_RESPONSE');
    if (response.isError === true) {
      let code = 'REMOTE_TOOL_FAILED';
      try {
        const texts = response.content?.filter(item => item?.type === 'text');
        const value = texts?.length === 1 ? JSON.parse(texts[0].text) : null;
        if (typeof value?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value.error)) code = value.error;
      } catch { /* Never echo unstructured upstream errors or private transport text. */ }
      throw new Error(code);
    }
    if (object(response.structuredContent)) return response.structuredContent;
    const texts = response.content?.filter(item => item?.type === 'text');
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

async function readPool(tasks, concurrency) {
  insist(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'INVALID_READ_CONCURRENCY');
  const result = new Array(tasks.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(tasks.length, concurrency)}, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      try { result[index] = {value: await tasks[index]()}; }
      catch (error) { result[index] = {error: errorCode(error)}; }
    }
  }));
  return result;
}

export async function inspectSession({call = createToolCaller(), concurrency = 4} = {}) {
  const results = {}, errors = [];
  try {
    results.health = await call('health', {});
    insist(results.health?.protocol === PROTOCOL, 'WRONG_ADAPTER_PROTOCOL');
  } catch (error) { return {status: 'partial', snapshotAtomic: false, results, errors: [{tool: 'health', code: errorCode(error)}]}; }
  const game = id(results.health.gameId) ? {gameId: results.health.gameId} : {};
  const names = ['list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes'];
  const reads = await readPool(names.map(name => async () => {
    const value = await call(name, ['list_mods', 'list_downloads'].includes(name) ? {...game, limit: 500} : {});
    insist(Array.isArray(value), 'INVALID_INVENTORY_RESPONSE'); return value;
  }), concurrency);
  for (let i = 0; i < names.length; ++i) {
    if (reads[i].error) errors.push({tool: names[i], code: reads[i].error});
    else {
      results[names[i]] = reads[i].value;
      if (i < 2 && reads[i].value.length >= 500) errors.push({tool: names[i], code: 'INVENTORY_LIMIT_REACHED'});
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
  else insist(value.enabledFlagsVerified === true && value.enabled === args.enabled && same(value.modIds, args.modIds), 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
}
function verifiedReceipt(value, operation, args) {
  insist(object(value) && value.protocol === PROTOCOL && value.terminalOperationVerified === true
    && value.adapterTerminalReceiptObserved === true && value.incompleteCompletionObserved === false
    && Array.isArray(value.receiptIssues) && value.receiptIssues.length === 0 && value.failure === null && value.interlock === null
    && value.attempt?.operation === operation && value.attempt?.requestId === args.requestId
    && value.attempt?.gameId === args.gameId && value.attempt?.profileId === args.profileId
    && value.completion?.gameId === args.gameId && value.completion?.profileId === args.profileId
    && same(value.attempt?.parameters, args), 'TERMINAL_RECEIPT_UNCERTAIN');
  verifiedAcknowledgement(value.completion, operation, args);
}
function receiptSummary(value) {
  return {attemptObserved: object(value?.attempt), completionObserved: object(value?.completion), failureObserved: object(value?.failure),
    interlockObserved: object(value?.interlock), terminalOperationVerified: value?.terminalOperationVerified === true,
    receiptIssues: Array.isArray(value?.receiptIssues) ? value.receiptIssues.filter(item => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item)) : ['UNVERIFIABLE_RESPONSE']};
}

export async function runPlan(input, {apply = false, call = createToolCaller()} = {}) {
  const plan = validatePlan(input);
  insist(typeof apply === 'boolean', 'INVALID_APPLY_FLAG');
  const queue = plan.steps.map(step => ({operation: step.operation,
    args: {...plan.context, requestId: step.requestId, modIds: step.modIds, enabled: step.enabled}}));
  if (plan.deploy !== null) queue.push({operation: 'deploy_mods', args: {...plan.context, requestId: plan.deploy.requestId}});
  if (!apply) return {status: 'validated', applied: false, operationCount: queue.length, requestIds: queue.map(item => item.args.requestId),
    diskDeploymentVerified: false, message: 'Offline validation only. Use --apply for the reviewed plan; no Vortex calls were made.'};
  const completed = []; let current;
  try {
    // Check the entire queue before any effect: a used later ID must not cause a partial replay.
    for (const item of queue) {
      current = {...item, invoked: false};
      cleanUnusedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}));
    }
    current = undefined;
    for (const item of queue) {
      current = {...item, invoked: false};
      cleanUnusedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}));
      freshContext(await call('health', {}), plan.context);
      current.invoked = true;
      const acknowledgement = await call(item.operation, item.args);
      verifiedAcknowledgement(acknowledgement, item.operation, item.args);
      verifiedReceipt(await call('reconcile_operation', {requestId: item.args.requestId}), item.operation, item.args);
      completed.push({operation: item.operation, requestId: item.args.requestId, adapterReceiptVerified: true});
      current = undefined;
    }
    return {status: 'completed', completed, diskDeploymentVerified: false,
      verificationRequired: 'Independently verify deployment manifest, owners, hashes and hardlinks. Adapter receipts do not prove disk or gameplay acceptance.'};
  } catch (error) {
    let reconciliation;
    if (current?.invoked) {
      try { reconciliation = receiptSummary(await call('reconcile_operation', {requestId: current.args.requestId})); }
      catch { reconciliation = {receiptIssues: ['RECONCILIATION_UNAVAILABLE']}; }
    }
    return {status: 'stopped', completed, diskDeploymentVerified: false, code: errorCode(error),
      ...(current ? {requestId: current.args.requestId, operation: current.operation, invocationAttempted: current.invoked} : {}),
      ...(reconciliation ? {reconciliation} : {}),
      instruction: 'Stop and inspect the exact existing request receipts. Do not generate new request IDs or retry an uncertain write.'};
  }
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
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, bytesRead))); }
    catch { throw new Error('INVALID_PLAN_FILE'); }
  } finally { await file.close(); }
}

export async function main(argv = process.argv.slice(2), {call = createToolCaller(), read = readPlan, output = value => process.stdout.write(JSON.stringify(value) + '\n')} = {}) {
  let result;
  try {
    if (argv.length === 1 && argv[0] === 'inspect') result = await inspectSession({call});
    else if ((argv.length === 2 || argv.length === 3 && argv[2] === '--apply') && argv[0] === 'plan')
      result = await runPlan(await read(argv[1]), {apply: argv[2] === '--apply', call});
    else throw new Error('USAGE_INSPECT_OR_PLAN_FILE_OPTIONAL_APPLY');
  } catch (error) { result = {status: 'stopped', code: errorCode(error), diskDeploymentVerified: false}; }
  output(result);
  return ['ok', 'validated', 'completed'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
