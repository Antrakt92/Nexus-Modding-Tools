import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCaller, inspectSession, main, runPlan, validatePlan } from './session.mjs';

const context = () => ({gameId: 'cyberpunk2077', profileId: 'test-profile', gamePath: 'F:/Games/Cyberpunk',
  stagingPath: 'F:/VortexMods/cyberpunk2077', downloadPath: 'D:/Downloads/cyberpunk2077',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}});
const plan = () => ({version: 1, context: context(), steps: [
  {operation: 'set_mods_enabled', requestId: 'session_enable_0001', modIds: ['mod-one'], enabled: true},
  {operation: 'set_mods_enabled', requestId: 'session_disable_0002', modIds: ['mod-two'], enabled: false},
], deploy: {requestId: 'session_deploy_0003'}});
const unused = () => ({protocol: 'vortex-agent/1', attempt: null, completion: null, failure: null, interlock: null,
  receiptIssues: [], incompleteCompletionObserved: false, adapterTerminalReceiptObserved: false, terminalOperationVerified: false});
const health = () => ({protocol: 'vortex-agent/1', ...context()});
function server({beforeCall = () => {}} = {}) {
  const calls = [], writes = [], receipts = new Map(); let activeWrites = 0, maxWrites = 0;
  async function call(name, args = {}) {
    calls.push({name, args: structuredClone(args)});
    const overridden = await beforeCall(name, args, {calls, writes, receipts});
    if (overridden !== undefined) return overridden;
    if (name === 'health') return health();
    if (name === 'reconcile_operation') return receipts.get(args.requestId) ?? unused();
    if (['list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes'].includes(name)) return [];
    assert.ok(['set_mods_enabled', 'deploy_mods'].includes(name), 'No arbitrary operation allowed: ' + name);
    maxWrites = Math.max(maxWrites, ++activeWrites);
    await new Promise(resolve => setTimeout(resolve, 2));
    const result = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false,
      ...(name === 'deploy_mods' ? {deploymentPromiseResolved: true} : {modIds: args.modIds, enabled: args.enabled, enabledFlagsVerified: true})};
    writes.push({name, args: structuredClone(args)});
    // Actual Zod/serializer output need not preserve the caller's object key order.
    const reversed = Object.fromEntries(Object.entries(args).reverse());
    receipts.set(args.requestId, {...unused(), adapterTerminalReceiptObserved: true, terminalOperationVerified: true,
      attempt: {operation: name, requestId: args.requestId, gameId: args.gameId, profileId: args.profileId, parameters: reversed},
      completion: {...result, gameId: args.gameId, profileId: args.profileId}});
    --activeWrites;
    return result;
  }
  return {call, calls, writes, receipts, get maxWrites() {return maxWrites;}};
}

test('offline validation is the default and makes zero transport calls', async () => {
  let calls = 0;
  const result = await runPlan(plan(), {call: async () => {++calls; throw Error('must not call');}});
  assert.equal(result.status, 'validated'); assert.equal(result.applied, false); assert.equal(calls, 0);
  assert.deepEqual(result.requestIds, ['session_enable_0001', 'session_disable_0002', 'session_deploy_0003']);
});

test('malformed plans, duplicate IDs and generic/install operations are refused offline', () => {
  for (const mutate of [p => {p.extra = true;}, p => {p.steps[0].operation = 'install_download';},
    p => {p.steps[0].operation = 'deploy_mods';}, p => {p.steps[0].modIds = [];},
    p => {p.steps[0].modIds = ['mod-one', 'mod-one'];}, p => {p.steps[0].enabled = 'true';},
    p => {p.deploy.requestId = p.steps[0].requestId;}, p => {p.steps[1].requestId = p.steps[0].requestId;},
    p => {p.steps[0].requestId = 'new';}, p => {p.context.gamePath = 'relative';},
    p => {p.context.filesystemIds.stagingPath = 'unknown';}, p => {p.context.filesystemIds.extra = '1:2';},
    p => {p.steps = []; p.deploy = null;}]) {
    const p = plan(); mutate(p); assert.throws(() => validatePlan(p));
  }
});

test('applied writes are serial, use stable IDs/full pins, and deploy once at the end', async () => {
  const s = server(); const result = await runPlan(plan(), {apply: true, call: s.call});
  assert.equal(result.status, 'completed'); assert.equal(result.diskDeploymentVerified, false);
  assert.deepEqual(s.writes.map(item => item.name), ['set_mods_enabled', 'set_mods_enabled', 'deploy_mods']);
  assert.equal(s.maxWrites, 1); assert.equal(s.calls.filter(item => item.name === 'health').length, 3);
  assert.deepEqual(s.writes.map(item => item.args.requestId), ['session_enable_0001', 'session_disable_0002', 'session_deploy_0003']);
  for (const {args} of s.writes) for (const [key, value] of Object.entries(context())) assert.deepEqual(args[key], value);
  assert.ok(s.calls.slice(0, 3).every(item => item.name === 'reconcile_operation'));
});

test('deployment is optional and is not inferred from enabling a mod', async () => {
  const s = server(); const p = plan(); p.deploy = null;
  const result = await runPlan(p, {apply: true, call: s.call});
  assert.equal(result.status, 'completed'); assert.equal(s.writes.filter(item => item.name === 'deploy_mods').length, 0);
});

test('replay and a used later request ID stop before the first new write', async () => {
  const s = server(); assert.equal((await runPlan(plan(), {apply: true, call: s.call})).status, 'completed');
  const count = s.writes.length;
  assert.equal((await runPlan(plan(), {apply: true, call: s.call})).status, 'stopped'); assert.equal(s.writes.length, count);
  const other = server(); other.receipts.set(plan().deploy.requestId, {...unused(), attempt: {requestId: plan().deploy.requestId}});
  const result = await runPlan(plan(), {apply: true, call: other.call});
  assert.equal(result.status, 'stopped'); assert.equal(result.requestId, plan().deploy.requestId); assert.equal(other.writes.length, 0);
});

test('context and inode drift before every write stop remaining operations', async () => {
  for (const mutate of [h => {h.profileId = 'different';}, h => {h.gamePath = 'F:/Other';}, h => {h.filesystemIds.gamePath = '9:9';}]) {
    let checks = 0;
    const s = server({beforeCall: name => {if (name === 'health' && ++checks === 2) {const h = health(); mutate(h); return h;}}});
    const result = await runPlan(plan(), {apply: true, call: s.call});
    assert.equal(result.status, 'stopped'); assert.equal(result.code, 'PLAN_CONTEXT_DRIFT');
    assert.equal(result.completed.length, 1); assert.equal(s.writes.length, 1); assert.equal(result.invocationAttempted, false);
  }
});

test('uncertain write acknowledgement stops and reconciles the same ID without retrying', async () => {
  let attempted = 0;
  const s = server({beforeCall: name => {if (name === 'set_mods_enabled') {++attempted; throw Error('network response lost');}}});
  const result = await runPlan(plan(), {apply: true, call: s.call});
  assert.equal(result.status, 'stopped'); assert.equal(result.invocationAttempted, true); assert.equal(attempted, 1);
  assert.equal(result.requestId, plan().steps[0].requestId); assert.ok(result.reconciliation);
  assert.equal(s.calls.at(-1).name, 'reconcile_operation'); assert.equal(s.calls.at(-1).args.requestId, result.requestId);
  assert.equal(s.calls.filter(item => item.name === 'deploy_mods').length, 0);
});

test('missing or contradictory terminal receipts never become completed', async () => {
  for (const field of ['terminalOperationVerified', 'interlock', 'receiptIssues']) {
    const s = server({beforeCall: (name, args, {receipts}) => {
      if (name === 'reconcile_operation' && receipts.has(args.requestId)) {
        const value = structuredClone(receipts.get(args.requestId));
        value[field] = field === 'terminalOperationVerified' ? false : field === 'interlock' ? {} : ['UNVERIFIABLE']; return value;
      }
    }});
    const result = await runPlan(plan(), {apply: true, call: s.call});
    assert.equal(result.status, 'stopped'); assert.equal(result.code, 'TERMINAL_RECEIPT_UNCERTAIN'); assert.equal(s.writes.length, 1);
  }
});

test('a pre-existing unknown receipt or global interlock prevents every write', async () => {
  for (const change of [value => {value.receiptIssues = ['INCOMPLETE_COMPLETION_COMMIT'];},
    value => {value.interlock = {requestId: 'another_request'};}, value => {delete value.attempt;},
    value => {value.incompleteCompletionObserved = true;}]) {
    const s = server({beforeCall: name => {if (name === 'reconcile_operation') {const value = unused(); change(value); return value;}}});
    const result = await runPlan(plan(), {apply: true, call: s.call});
    assert.equal(result.status, 'stopped'); assert.equal(s.writes.length, 0);
    assert.equal(result.code, 'REQUEST_ID_USED_OR_RECEIPT_UNCERTAIN');
  }
});

test('curated inspect reads overlap with a maximum of four and do not write', async () => {
  let active = 0, max = 0;
  const names = [];
  const result = await inspectSession({call: async name => {
    names.push(name); max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, 3)); --active;
    assert.ok(['health', 'list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes'].includes(name));
    return name === 'health' ? health() : [];
  }});
  assert.equal(result.status, 'ok'); assert.equal(result.snapshotAtomic, false); assert.equal(max, 4);
  assert.equal(names.length, 6);
});

test('inspection refuses missing or malformed initial context before reading inventory', async () => {
  for (const mutate of [value => {delete value.gameId;}, value => {delete value.profileId;},
    value => {value.gamePath = 'relative';}, value => {value.filesystemIds = {};},
    value => {value.filesystemIds.stagingPath = 'unknown';}]) {
    const initial = health(); mutate(initial);
    const calls = [];
    const result = await inspectSession({call: async name => {
      calls.push(name); return name === 'health' ? initial : [];
    }});
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.errors, [{tool: 'health', code: 'INVALID_PLAN_CONTEXT'}]);
    assert.deepEqual(calls, ['health']);
  }
});

test('partial, capped and context-drift inspections never report all healthy', async () => {
  const failed = await inspectSession({call: async name => {if (name === 'list_downloads') throw Error('not available'); return name === 'health' ? health() : [];}});
  assert.equal(failed.status, 'partial'); assert.equal(failed.errors[0].tool, 'list_downloads'); assert.ok(failed.results.list_mods);
  const capped = await inspectSession({call: async name => name === 'health' ? health() : name === 'list_mods' ? new Array(500).fill({}) : []});
  assert.equal(capped.status, 'partial'); assert.equal(capped.errors[0].code, 'INVENTORY_LIMIT_REACHED');
  let checks = 0;
  const drift = await inspectSession({call: async name => name === 'health' ? {...health(), profileId: ++checks === 1 ? 'a' : 'b'} : []});
  assert.equal(drift.status, 'partial'); assert.equal(drift.errors[0].code, 'INSPECTION_CONTEXT_DRIFT');
  await assert.rejects(inspectSession({concurrency: 5, call: async () => health()}), /INVALID_READ_CONCURRENCY/);
});

test('one caller reuses the same transport and rejects MCP errors/malformed responses', async () => {
  const requests = [];
  const call = createToolCaller(async (method, value) => {requests.push({method, value}); return {content: [{type: 'text', text: '[]'}]};});
  await call('list_mods'); await call('list_downloads'); assert.equal(requests.length, 2);
  for (const response of [{isError: true, content: [{type: 'text', text: '{"error":"secret detail"}'}]}, {}, {content: [{type: 'text', text: 'bad'}]}])
    await assert.rejects(createToolCaller(async () => response)('health'), /REMOTE_TOOL_FAILED|INVALID_TOOL_RESPONSE/);
  await assert.rejects(createToolCaller(async () => ({isError: true, content: [{type: 'text', text: '{"error":"GAME_RUNNING"}'}]}))('set_mods_enabled'), /GAME_RUNNING/);
});

test('contradictory structured and text tool results are refused before being trusted', async () => {
  const response = {structuredContent: {operationCompleted: true}, content: [{type: 'text', text: '{"operationCompleted":false}'}]};
  await assert.rejects(createToolCaller(async () => response)('set_mods_enabled'), /CONTRADICTORY_TOOL_RESPONSE/);
  for (const structuredContent of [null, [], 'invalid']) {
    await assert.rejects(createToolCaller(async () => ({structuredContent, content: [{type: 'text', text: '{}'}]}))('health'), /INVALID_TOOL_RESPONSE/);
  }
  const structuredContent = {a: 1, b: 2};
  assert.deepEqual(await createToolCaller(async () => ({structuredContent, content: [{type: 'text', text: '{"b":2,"a":1}'}]}))('health'), structuredContent);
  assert.deepEqual(await createToolCaller(async () => ({structuredContent, content: []}))('health'), structuredContent);
});

test('CLI never applies without explicit --apply, has no restart/install/dispatch command', async () => {
  const s = server(); const outputs = [];
  const code = await main(['plan', 'reviewed.json'], {read: async () => plan(), call: s.call, output: value => outputs.push(value)});
  assert.equal(code, 0); assert.equal(s.calls.length, 0); assert.equal(outputs[0].status, 'validated');
  for (const argv of [[], ['restart'], ['install_download'], ['dispatch', 'anything'], ['plan', 'p', '--apply', '--apply']]) {
    assert.equal(await main(argv, {call: s.call, output: () => {}}), 1);
  }
  assert.equal(s.calls.length, 0);
  assert.equal(await main(['plan', 'p', '--apply'], {read: async () => plan(), call: s.call, output: () => {}}), 0);
  assert.equal(s.writes.length, 3);
});
