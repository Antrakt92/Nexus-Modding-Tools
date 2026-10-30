import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {runPlan, inspectPlan, main} from './session.mjs';
import {canonicalPlanId, createPlanJournal} from './plan-journal.mjs';
import {clientRemote} from './bridge.mjs';

const context = {gameId: 'cyberpunk2077', profileId: 'test-profile', gamePath: 'F:/Game',
  stagingPath: 'F:/Stage', downloadPath: 'D:/Downloads',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}};
const plan = (count = 2) => ({version: 1, context: structuredClone(context), steps: Array.from({length: count}, (_, n) => ({
  operation: 'set_mods_enabled', requestId: 'durable_step_' + n, modIds: ['own-' + n], enabled: true})), deploy: null});
const unused = () => ({protocol: 'vortex-agent/1', attempt: null, completion: null, failure: null, interlock: null,
  receiptIssues: [], incompleteCompletionObserved: false, adapterTerminalReceiptObserved: false, terminalOperationVerified: false});
function storage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-test-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  return {root, journal: createPlanJournal({root: path.join(root, 'plans')})};
}
function server({lostAck = false, interlock = false} = {}) {
  const receipts = new Map(), writes = [], reads = [];
  const call = async (name, args) => {
    if (name === 'health') return {protocol: 'vortex-agent/1', ...context};
    if (name === 'reconcile_operation') {
      reads.push(args.requestId); const result = receipts.get(args.requestId) ?? unused();
      return interlock ? {...result, interlock: {requestId: 'unrelated_current_operation'}} : result;
    }
    assert.equal(name, 'set_mods_enabled'); writes.push(args.requestId);
    const ack = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false, modIds: args.modIds,
      enabled: args.enabled, enabledFlagsVerified: true};
    receipts.set(args.requestId, {...unused(), adapterTerminalReceiptObserved: true, terminalOperationVerified: true,
      attempt: {operation: name, requestId: args.requestId, gameId: args.gameId, profileId: args.profileId, parameters: structuredClone(args)},
      completion: {...ack, gameId: args.gameId, profileId: args.profileId}});
    if (lostAck) throw Error('LOST_ACK');
    return ack;
  };
  return {call, receipts, writes, reads};
}

test('offline plan identity is stable without creating a journal or making calls', async t => {
  const {root, journal} = storage(t), p = plan();
  const result = await runPlan(p, {journal, call: () => assert.fail('offline transport')});
  assert.match(result.planId, /^[a-f0-9]{64}$/); assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(result.planId, canonicalPlanId(Object.fromEntries(Object.entries(p).reverse())));
  const reordered = plan(); reordered.steps.reverse(); assert.notEqual(result.planId, canonicalPlanId(reordered));
});

test('lost acknowledgement is reconciled historically without running the uninvoked tail', async t => {
  const {journal} = storage(t), s = server({lostAck: true}), p = plan();
  const result = await runPlan(p, {apply: true, call: s.call, journal});
  assert.equal(result.status, 'stopped'); assert.equal(s.writes.length, 1);
  s.reads.length = 0;
  const status = await inspectPlan(result.planId, {call: s.call, journal});
  assert.equal(status.status, 'partial'); assert.equal(status.steps[0].state, 'adapter_completed');
  assert.equal(status.steps[1].state, 'intent_not_recorded'); assert.equal(status.steps[1].remoteChecked, false);
  assert.deepEqual(s.reads, [p.steps[0].requestId]); assert.equal(s.writes.length, 1);
  assert.equal(status.currentStateVerified, false); assert.equal(status.retryAllowed, false);
  assert.equal((await runPlan(p, {apply: true, call: s.call, journal})).status, 'stopped');
  assert.equal(s.writes.length, 1);
});

test('an intent persisted before a crash remains uncertain even with no server receipt', async t => {
  const {journal} = storage(t), p = plan(), s = server(), token = journal.begin(p);
  token.intent(0, p.steps[0].operation, {...p.context, ...Object.fromEntries(Object.entries(p.steps[0]).filter(([k]) => k !== 'operation'))});
  const status = await inspectPlan(token.planId, {call: s.call, journal});
  assert.equal(status.status, 'partial'); assert.equal(status.steps[0].state, 'uncertain');
  assert.equal(status.resumeSupported, false); assert.equal(s.writes.length, 0);
});

test('all original steps must have exact receipts for historical completion after a lost final response', async t => {
  const {root, journal} = storage(t), p = plan(), s = server();
  const result = await runPlan(p, {apply: true, call: s.call, journal}); assert.equal(result.status, 'completed');
  const reopened = createPlanJournal({root: path.join(root, 'plans')}); s.reads.length = 0;
  const status = await inspectPlan(result.planId, {call: s.call, journal: reopened});
  assert.equal(status.status, 'completed'); assert.equal(status.diskDeploymentVerified, false);
  assert.equal(status.currentStateVerified, false); assert.equal(status.steps.length, 2);
  assert.deepEqual(s.reads.sort(), p.steps.map(step => step.requestId).sort()); assert.equal(s.writes.length, 2);
});

test('receipt parameter drift or a current unrelated interlock is conservatively uncertain', async t => {
  for (const mode of ['parameters', 'interlock']) {
    const {journal} = storage(t), p = plan(1), s = server();
    const result = await runPlan(p, {apply: true, call: s.call, journal});
    if (mode === 'parameters') s.receipts.get(p.steps[0].requestId).attempt.parameters.enabled = false;
    else s.receipts.get(p.steps[0].requestId).interlock = {requestId: 'unrelated'};
    const status = await inspectPlan(result.planId, {call: s.call, journal});
    assert.equal(status.status, 'partial'); assert.equal(status.steps[0].state, 'uncertain');
  }
});

test('journal failures before send and after receipt stop new effects, including cancellation during intent', async t => {
  for (const mode of ['begin', 'intent', 'observed', 'cancel-intent']) {
    const {journal} = storage(t), controller = new AbortController(), p = plan(), s = server();
    const wrapped = {begin(value) {
      if (mode === 'begin') throw Error('PLAN_JOURNAL_WRITE_FAILED');
      const token = journal.begin(value);
      return {...token, intent(...args) {
        if (mode === 'intent') throw Error('PLAN_JOURNAL_WRITE_FAILED');
        token.intent(...args); if (mode === 'cancel-intent') controller.abort();
      }, observed(...args) {if (mode === 'observed') throw Error('PLAN_JOURNAL_WRITE_FAILED'); return token.observed(...args);}};
    }};
    const result = await runPlan(p, {apply: true, call: s.call, journal: wrapped, signal: controller.signal});
    assert.equal(result.status, 'stopped'); assert.equal(s.writes.length, mode === 'observed' ? 1 : 0);
  }
});

test('missing history is not observed while corrupt history is partial; both avoid remote calls', async t => {
  const {root, journal} = storage(t), p = plan(), id = canonicalPlanId(p);
  const absent = await inspectPlan(id, {journal, call: () => assert.fail('missing remote')});
  assert.equal(absent.status, 'not_observed'); assert.equal(absent.journalObserved, false);
  fs.mkdirSync(path.join(root, 'plans', id), {recursive: true});
  const partial = await inspectPlan(id, {journal, call: () => assert.fail('corrupt remote')});
  assert.equal(partial.status, 'partial'); assert.equal(partial.journalUsable, false);
});

test('asynchronous storage cannot authorize dispatch or silently continue later steps', async t => {
  for (const method of ['begin', 'intent', 'observed', 'finish']) {
    const {journal} = storage(t), s = server(), p = plan();
    const asyncFailure = () => Promise.reject(Error('ASYNC_STORAGE_FAILED'));
    const wrapped = {begin(value) {
      if (method === 'begin') return asyncFailure();
      return {...journal.begin(value), [method]: asyncFailure};
    }};
    const result = await runPlan(p, {apply: true, call: s.call, journal: wrapped});
    assert.equal(result.status, 'stopped'); assert.equal(result.code, 'PLAN_JOURNAL_ASYNC_UNSUPPORTED');
    assert.equal(s.writes.length, method === 'observed' ? 1 : method === 'finish' ? 2 : 0);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('prepared journals do not claim the executor stopped or prove request IDs unused', async t => {
  const {journal} = storage(t), p = plan(), token = journal.begin(p);
  const status = await inspectPlan(token.planId, {journal, call: () => assert.fail('no intent remote')});
  assert.equal(status.status, 'partial'); assert.equal(status.journalState, 'prepared');
  assert.equal(status.executionLiveness, 'unknown'); assert.equal(status.retryAllowed, false);
  assert(status.steps.every(step => step.state === 'intent_not_recorded' && !step.remoteChecked));
});

test('asynchronous journal reads are rejected without an unhandled rejection or remote call', async () => {
  const status = await inspectPlan(canonicalPlanId(plan()), {
    journal: {read: () => Promise.reject(Error('ASYNC_READ_FAILED'))}, call: () => assert.fail('async read transport')});
  assert.equal(status.status, 'partial'); assert.equal(status.code, 'PLAN_JOURNAL_ASYNC_UNSUPPORTED');
  await new Promise(resolve => setImmediate(resolve));
});

test('URI-shaped operational values are refused before any durable file or transport call', async t => {
  for (const field of ['modId', 'gameId', 'profileId', 'gamePath']) {
    const {root, journal} = storage(t), p = plan();
    if (field === 'modId') p.steps[0].modIds = ['nxm://example/private?token=fixture'];
    else p.context[field] = field === 'gamePath' ? 'F:/Game/nxm://private' : 'https://example/private';
    await assert.rejects(runPlan(p, {apply: true, journal, call: () => assert.fail('unsafe transport')}), /INVALID_PLAN_CONTEXT|INVALID_PLAN_STEP/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('CLI refuses duplicate JSON plan keys before creating a journal', async t => {
  const {root, journal} = storage(t), file = path.join(root, 'ambiguous.json');
  fs.writeFileSync(file, JSON.stringify(plan()).replace('"version":1', '"version":2,"version":1'));
  const output = [];
  const result = await main(['plan', file, '--apply'], {journal, call: () => assert.fail('ambiguous transport'), output: value => output.push(value)});
  assert.equal(result, 1); assert.equal(output[0].code, 'INVALID_PLAN_FILE');
  assert(!fs.existsSync(path.join(root, 'plans')));
});

test('unbounded or one-character upstream error codes do not prevent a terminal stopped journal', async t => {
  for (const message of ['A', 'A'.repeat(101)]) {
    const {journal} = storage(t), p = plan();
    const result = await runPlan(p, {apply: true, journal, call: () => {throw Error(message);}});
    assert.equal(result.code, 'SESSION_CALL_FAILED'); assert.equal(result.journalIssue, undefined);
    assert.equal(journal.read(result.planId).state, 'stopped');
  }
});

test('status bounds exact receipt reads to four in flight and notices journal advancement', async t => {
  const {journal} = storage(t), p = plan(8), s = server();
  const result = await runPlan(p, {apply: true, journal, call: s.call});
  let active = 0, maximum = 0;
  const status = await inspectPlan(result.planId, {journal, call: async (name, args) => {
    assert.equal(name, 'reconcile_operation'); maximum = Math.max(maximum, ++active);
    try {await new Promise(resolve => setTimeout(resolve, 2)); return await s.call(name, args);}
    finally {active--;}
  }});
  assert.equal(status.status, 'completed'); assert.equal(maximum, 4);
  const second = storage(t), one = plan(1), token = second.journal.begin(one), remote = server();
  const {operation, ...parameters} = one.steps[0], args = {...one.context, ...parameters};
  token.intent(0, operation, args); await remote.call(operation, args); token.observed(0);
  const advancing = await inspectPlan(token.planId, {journal: second.journal, call: async (name, params) => {
    token.finish('completed'); return remote.call(name, params);
  }});
  assert.equal(advancing.journalAdvanced, true); assert.equal(advancing.status, 'partial');
  assert.equal(advancing.steps[0].state, 'adapter_completed');
});

test('MCP status is a strict read tool and CLI can inspect the same journal', async t => {
  const {journal} = storage(t), p = plan(1), s = server();
  const result = await runPlan(p, {apply: true, call: s.call, journal});
  const transport = async (_method, params) => ({structuredContent: await s.call(params.name, params.arguments)});
  const response = await clientRemote('tools/call', {name: 'inspect_mod_plan', arguments: {planId: result.planId}}, transport, {journal});
  assert.equal(response.structuredContent.status, 'completed'); assert.equal(s.writes.length, 1);
  for (const args of [undefined, {}, {planId: result.planId, apply: true}, {planId: '../escape'}]) {
    const invalid = await clientRemote('tools/call', {name: 'inspect_mod_plan', arguments: args}, () => assert.fail('invalid remote'), {journal});
    assert.equal(invalid.isError, true);
  }
  const out = []; assert.equal(await main(['plan-status', result.planId], {call: s.call, journal, output: value => out.push(value)}), 0);
  assert.equal(out[0].status, 'completed');
});

test('a fresh process uses default durable storage and cannot replay the same plan', t => {
  const {root} = storage(t), here = path.dirname(fileURLToPath(import.meta.url));
  const script = `import {runPlan} from ${JSON.stringify(pathToFileURL(path.join(here, 'session.mjs')).href)};
const result=await runPlan(${JSON.stringify(plan(1))},{apply:true,call:async()=>{throw Error('NO_REMOTE');}});
process.stdout.write(JSON.stringify(result));`;
  const env = {...process.env, NEXUS_WORKSPACE: root};
  const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env, encoding: 'utf8'}));
  const first = run(), second = run(); assert.equal(first.code, 'NO_REMOTE');
  assert.match(second.code, /^PLAN_JOURNAL_/); assert.equal(first.planId, second.planId);
  assert(fs.existsSync(path.join(root, 'local-state', 'vortex-agent-build', 'plan-journals', first.planId, 'plan.json')));
  assert(!fs.existsSync(path.join(root, 'local-state', 'vortex-agent-build', 'receipts')));
});
