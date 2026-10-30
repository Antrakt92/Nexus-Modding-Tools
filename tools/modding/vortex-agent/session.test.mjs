import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {clientRemote as rawClientRemote, handler as rawHandler, runStdio} from './bridge.mjs';
import { createToolCaller, inspectSession, main as rawMain, runPlan as rawRunPlan, validatePlan } from './session.mjs';
import {createPlanJournal} from './plan-journal.mjs';

const privateRoots = [];
function privateJournal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-session-test-')); privateRoots.push(root);
  return createPlanJournal({root: path.join(root, 'plans')});
}
test.afterEach(() => {for (const root of privateRoots.splice(0)) fs.rmSync(root, {recursive: true});});
const runPlan = (plan, options = {}) => rawRunPlan(plan, {...options, journal: privateJournal()});
const main = (argv, options = {}) => rawMain(argv, {...options, journal: privateJournal()});
const clientRemote = (method, params, transport, options = {}) => rawClientRemote(method, params, transport, {...options, journal: privateJournal()});
const handler = call => rawHandler(call, {journal: privateJournal()});

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
const download = () => ({operation: 'download_nexus', requestId: 'session_download_0000', nexusModId: 42,
  nexusFileId: 43, size: 123, sha256: 'a'.repeat(64), reuseOnly: true});
const acquisitionPlan = () => {const p = plan(); p.steps.unshift(download()); return p;};
const reply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
function deferred() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}
function server({beforeCall = () => {}} = {}) {
  const calls = [], writes = [], receipts = new Map(); let activeWrites = 0, maxWrites = 0;
  async function call(name, args = {}) {
    calls.push({name, args: structuredClone(args)});
    const overridden = await beforeCall(name, args, {calls, writes, receipts});
    if (overridden !== undefined) return overridden;
    if (name === 'health') return health();
    if (name === 'reconcile_operation') return receipts.get(args.requestId) ?? unused();
    if (['list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes'].includes(name)) return [];
    assert.ok(['set_mods_enabled', 'deploy_mods', 'download_nexus'].includes(name), 'No arbitrary operation allowed: ' + name);
    maxWrites = Math.max(maxWrites, ++activeWrites);
    await new Promise(resolve => setTimeout(resolve, 2));
    const result = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false,
      ...(name === 'deploy_mods' ? {deploymentPromiseResolved: true} : name === 'download_nexus'
        ? {downloadId: 'tracked-download', reused: true, archiveSha256Verified: true, archiveCRCVerified: false, autoInstall: false, size: args.size}
        : {modIds: args.modIds, enabled: args.enabled, enabledFlagsVerified: true})};
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

test('a known failed preflight stops dispatching new receipt reads while settling the bounded in-flight pool', async () => {
  const p = plan();
  p.steps = Array.from({length: 100}, (_, n) => ({operation: 'set_mods_enabled',
    requestId: 'early_preflight_' + n, modIds: ['own-' + n], enabled: false}));
  const started = [], release = deferred(); let settled = 0;
  const s = server({beforeCall: async (name, args) => {
    if (name !== 'reconcile_operation') return;
    started.push(args.requestId);
    if (args.requestId === p.steps[0].requestId) {
      await release.promise;
      return {...unused(), attempt: {requestId: args.requestId}};
    }
    await release.promise;
    settled++;
    return unused();
  }});
  const work = runPlan(p, {apply: true, call: s.call});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 4, 'the initial pool remains bounded');
  release.resolve();
  const result = await work;
  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'REQUEST_ID_USED_OR_RECEIPT_UNCERTAIN');
  assert.equal(result.requestId, p.steps[0].requestId);
  assert.equal(result.invocationAttempted, false);
  assert.equal(started.length, 4, 'no remaining receipt calls after a failure already guarantees no effects');
  assert.equal(settled, 3, 'all already dispatched reads finish before returning');
  assert.equal(s.writes.length, 0);
  assert.equal(s.calls.some(c => c.name === 'health'), false);
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

test('pinned download steps validate offline and execute serially before enable/deploy with exact receipts', async () => {
  const offline = await runPlan(acquisitionPlan(), {call: async () => assert.fail('offline transport')});
  assert.equal(offline.operationCount, 4);
  for (const mutate of [d => {d.size = 0;}, d => {d.sha256 = 'bad';}, d => {d.nexusFileId = '43';},
    d => {delete d.reuseOnly;}, d => {d.install = true;}, d => {d.nexusModId = Number.MAX_SAFE_INTEGER + 1;}]) {
    const p = acquisitionPlan(); mutate(p.steps[0]); assert.throws(() => validatePlan(p), /INVALID_PLAN_STEP/);
  }
  const s = server(); const result = await runPlan(acquisitionPlan(), {apply: true, call: s.call});
  assert.equal(result.status, 'completed'); assert.equal(s.maxWrites, 1);
  assert.deepEqual(s.writes.map(w => w.name), ['download_nexus', 'set_mods_enabled', 'set_mods_enabled', 'deploy_mods']);
  assert.equal(result.completed[0].downloadId, 'tracked-download');
  assert.equal(result.completed[0].archiveCRCVerified, false);
  assert.deepEqual(s.writes[0].args, {...context(), ...Object.fromEntries(Object.entries(download()).filter(([k]) => k !== 'operation'))});
});

test('initial receipt reads overlap at most four; all finish before the first write', async () => {
  let active = 0, maximum = 0;
  const s = server({beforeCall: async (name, args, {receipts, writes}) => {
    if (name === 'reconcile_operation' && !receipts.has(args.requestId) && writes.length === 0) {
      maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 3)); --active;
    }
    if (name === 'set_mods_enabled') assert.equal(active, 0);
  }});
  const p = plan(); p.steps = Array.from({length: 8}, (_, i) => ({...p.steps[0], requestId: 'batch_request_' + i}));
  assert.equal((await runPlan(p, {apply: true, call: s.call})).status, 'completed');
  assert.equal(maximum, 4); assert.equal(s.maxWrites, 1);
  assert.deepEqual(s.calls.slice(0, 9).map(c => [c.name, c.args.requestId]),
    [...p.steps, p.deploy].map(step => ['reconcile_operation', step.requestId]));
});

test('inspection keeps collecting later read results after a failed read even with one worker', async () => {
  const calls = [];
  const result = await inspectSession({concurrency: 1, call: async name => {
    calls.push(name);
    if (name === 'health') return health();
    if (name === 'list_mods') throw Error('UNAVAILABLE');
    return [];
  }});
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['health', 'list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes', 'health']);
  assert.deepEqual(result.results.list_external_changes, []);
});

test('unsafe download acknowledgements and acknowledgement/receipt ID disagreement stop later changes', async () => {
  for (const change of [v => {v.autoInstall = true;}, v => {v.archiveSha256Verified = false;},
    v => {v.archiveCRCVerified = true;}, v => {v.size++;}, v => {v.reused = false;}, v => {v.downloadId = 'different';}]) {
    const s = server();
    const result = await runPlan(acquisitionPlan(), {apply: true, call: async (name, args) => {
      const value = await s.call(name, args); if (name === 'download_nexus') change(value); return value;
    }});
    assert.equal(result.status, 'stopped'); assert.equal(s.writes.length, 1);
    assert.ok(['WRITE_ACKNOWLEDGEMENT_UNCERTAIN', 'ACK_RECEIPT_MISMATCH'].includes(result.code));
    assert.equal(result.requestId, download().requestId);
  }
});

test('cancellation before dispatch prevents every effect; cancellation during a write still verifies that receipt', async () => {
  const prior = new AbortController(); prior.abort(); const noCalls = server();
  const stopped = await runPlan(plan(), {apply: true, call: noCalls.call, signal: prior.signal});
  assert.equal(stopped.code, 'PLAN_CANCELLED'); assert.equal(noCalls.calls.length, 0);
  const controller = new AbortController(), s = server();
  const result = await runPlan(acquisitionPlan(), {apply: true, signal: controller.signal, call: async (name, args) => {
    const value = await s.call(name, args); if (name === 'download_nexus') controller.abort('private cancellation detail'); return value;
  }});
  assert.equal(result.status, 'stopped'); assert.equal(result.code, 'PLAN_CANCELLED');
  assert.equal(s.writes.length, 1); assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].adapterReceiptVerified, true);
  assert.equal(s.calls.at(-1).name, 'reconcile_operation');
  assert.ok(!JSON.stringify(result).includes('private cancellation detail'));
  const duringRead = new AbortController(), r = server({beforeCall: name => {if (name === 'health') duringRead.abort();}});
  assert.equal((await runPlan(plan(), {apply: true, signal: duringRead.signal, call: r.call})).code, 'PLAN_CANCELLED');
  assert.equal(r.writes.length, 0);
});

test('MCP plan validation is offline by default, and malformed/failed plans return tool errors', async () => {
  const inventory = await clientRemote('tools/list', {}, async () => ({tools: []}));
  const definition = inventory.tools.find(tool => tool.name === 'run_mod_plan');
  assert.equal(definition.annotations.readOnlyHint, false); assert.equal(definition.annotations.idempotentHint, false);
  assert.equal(definition.inputSchema.properties.apply.default, false);
  const result = await clientRemote('tools/call', {name: 'run_mod_plan', arguments: {plan: acquisitionPlan()}}, async () => assert.fail('offline call'));
  assert.equal(result.structuredContent.status, 'validated'); assert.equal(result.isError, undefined);
  for (const args of [undefined, null, {}, {plan: plan(), apply: 'true'}, {plan: plan(), dispatch: true},
    {plan: {...plan(), steps: [{operation: 'install_download'}]}}]) {
    const invalid = await clientRemote('tools/call', {name: 'run_mod_plan', arguments: args}, async () => assert.fail('invalid call'));
    assert.equal(invalid.isError, true);
  }
  const s = server();
  const applied = await clientRemote('tools/call', {name: 'run_mod_plan', arguments: {plan: acquisitionPlan(), apply: true}},
    async (_method, params) => reply(await s.call(params.name, params.arguments)));
  assert.equal(applied.structuredContent.status, 'completed'); assert.equal(s.writes.length, 4);
  const replay = await clientRemote('tools/call', {name: 'run_mod_plan', arguments: {plan: acquisitionPlan(), apply: true}},
    async (_method, params) => reply(await s.call(params.name, params.arguments)));
  assert.equal(replay.isError, true); assert.equal(s.writes.length, 4);
});

test('batching ten disables and ten enables preserves requested IDs while reducing native mutations from 21 to three', async () => {
  const disables = Array.from({length: 10}, (_, i) => 'old-' + i), enables = Array.from({length: 10}, (_, i) => 'new-' + i);
  const individual = plan(); individual.steps = [...disables.map((modId, i) => ({operation: 'set_mods_enabled', modIds: [modId], enabled: false, requestId: 'disable_request_' + i})),
    ...enables.map((modId, i) => ({operation: 'set_mods_enabled', modIds: [modId], enabled: true, requestId: 'enable_request_' + i}))];
  const grouped = plan(); grouped.steps = [{...grouped.steps[1], modIds: disables}, {...grouped.steps[0], modIds: enables}];
  const a = server(), b = server();
  assert.equal((await runPlan(individual, {apply: true, call: a.call})).status, 'completed');
  assert.equal((await runPlan(grouped, {apply: true, call: b.call})).status, 'completed');
  assert.equal(a.writes.length, 21); assert.equal(b.writes.length, 3);
  assert.deepEqual(b.writes[0].args.modIds, disables); assert.deepEqual(b.writes[1].args.modIds, enables);
  assert.equal(a.calls.length, 105); assert.equal(b.calls.length, 15);
});

test('lost download acknowledgement is reconciled once and never followed by enable or deploy', async () => {
  const s = server();
  const result = await runPlan(acquisitionPlan(), {apply: true, call: async (name, args) => {
    const value = await s.call(name, args); if (name === 'download_nexus') throw Error('private lost response detail'); return value;
  }});
  assert.equal(result.status, 'stopped'); assert.equal(result.requestId, download().requestId);
  assert.equal(result.reconciliation.terminalOperationVerified, true); assert.equal(s.writes.length, 1);
  assert.equal(result.completed.length, 0); assert.ok(!JSON.stringify(result).includes('private lost response detail'));
});

test('an unrelated cancellation cannot stop another request', async () => {
  const entered = deferred(), release = deferred();
  const s = server({beforeCall: async name => {if (name === 'download_nexus') {entered.resolve(); await release.promise;}}});
  const handle = handler(async (_method, params) => reply(await s.call(params.name, params.arguments)));
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  const work = handle({jsonrpc: '2.0', id: 'actual', method: 'tools/call', params: {name: 'run_mod_plan', arguments: {plan: acquisitionPlan(), apply: true}}});
  await entered.promise;
  await handle({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'unrelated'}});
  release.resolve(); assert.equal((await work).result.structuredContent.status, 'completed');
});

test('MCP cancellation targets the original request; a duplicate active request is refused', async () => {
  const entered = deferred(), release = deferred();
  const s = server({beforeCall: async name => {if (name === 'download_nexus') {entered.resolve(); await release.promise;}}});
  const handle = handler(async (_method, params) => reply(await s.call(params.name, params.arguments)));
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  const request = {jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'run_mod_plan', arguments: {plan: acquisitionPlan(), apply: true}}};
  const work = handle(request); await entered.promise;
  assert.match((await handle(request)).error.message, /DUPLICATE_ACTIVE_PLAN_REQUEST/);
  assert.equal(await handle({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 7, reason: 'private'}}), undefined);
  release.resolve(); const result = (await work).result.structuredContent;
  assert.equal(result.code, 'PLAN_CANCELLED'); assert.equal(result.completed.length, 1); assert.equal(s.writes.length, 1);
});

test('invalid RPC IDs cannot start a plan whose cancellation identity cannot be tracked', async () => {
  let calls = 0;
  const handle = handler(async (_method, params) => {calls++; return reply(params.name === 'health' ? health() : []);});
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  for (const id of [null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await handle({jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'run_mod_plan', arguments: {plan: plan(), apply: true}}});
    assert.equal(result.error.code, -32600); assert.equal(result.id, null);
  }
  assert.equal(calls, 1);
});

test('stdio EOF or a closed output cancels future effects while settling the in-flight write', async () => {
  for (const closeOutput of [false, true]) {
    const entered = deferred(), release = deferred();
    const s = server({beforeCall: async name => {if (name === 'download_nexus') {entered.resolve(); await release.promise;}}});
    const handle = handler(async (_method, params) => reply(await s.call(params.name, params.arguments)));
    await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', b => {text += b;});
    const work = runStdio(input, output, handle);
    const settled = work.then(() => null, e => e);
    input.write(JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'run_mod_plan', arguments: {plan: acquisitionPlan(), apply: true}}}) + '\n');
    await entered.promise;
    if (closeOutput) output.destroy(); else input.end();
    await new Promise(r => setImmediate(r)); release.resolve();
    if (closeOutput) input.end();
    const error = await settled;
    assert.equal(s.writes.length, 1); assert.equal(s.calls.at(-1).name, 'reconcile_operation');
    if (!closeOutput) {assert.equal(error, null); assert.equal(JSON.parse(text).result.structuredContent.code, 'PLAN_CANCELLED');}
    else assert.ok(error);
  }
});
