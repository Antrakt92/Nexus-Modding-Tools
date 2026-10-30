import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {handler, runStdio} from './bridge.mjs';
import {createPlanJournal} from './plan-journal.mjs';

const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const reply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const context = {gameId: 'cyberpunk2077', profileId: 'test-profile', gamePath: 'F:/Game',
  stagingPath: 'F:/Stage', downloadPath: 'D:/Downloads',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}};
const unused = () => ({protocol: 'vortex-agent/1', attempt: null, completion: null, failure: null, interlock: null,
  receiptIssues: [], incompleteCompletionObserved: false, adapterTerminalReceiptObserved: false, terminalOperationVerified: false});

test('invalid RPC IDs cannot dispatch direct mutations, reads or initialization', async () => {
  let calls = 0;
  const handle = handler(async (_method, params) => {
    calls++; return reply(params.name === 'health' ? {protocol: 'vortex-agent/1'} : {});
  });
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  for (const id of [null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const result = await handle({jsonrpc: '2.0', id, method,
        params: {name: 'set_mods_enabled', arguments: {...context, requestId: 'invalid_rpc_request', modIds: ['own'], enabled: true}}});
      assert.equal(result.error?.code, -32600);
      assert.equal(result.id, null);
    }
  }
  assert.equal(calls, 1);
});

test('a cancellation at pending capacity stops later plan steps after settling its invoked write', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-test-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  const entered = deferred(), release = deferred(), answered = deferred();
  const receipts = new Map(), writes = [];
  const handle = handler(async (_method, params) => {
    const {name, arguments: args} = params;
    if (name === 'health') return reply({protocol: 'vortex-agent/1', ...context});
    if (name === 'reconcile_operation') return reply(receipts.get(args.requestId) || unused());
    assert.equal(name, 'set_mods_enabled');
    writes.push(args.requestId);
    if (writes.length === 1) {entered.resolve(); await release.promise;}
    const result = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false, modIds: args.modIds,
      enabled: args.enabled, enabledFlagsVerified: true};
    receipts.set(args.requestId, {...unused(), adapterTerminalReceiptObserved: true, terminalOperationVerified: true,
      attempt: {operation: name, requestId: args.requestId, gameId: args.gameId, profileId: args.profileId, parameters: args},
      completion: {...result, gameId: args.gameId, profileId: args.profileId}});
    return reply(result);
  }, {journal: createPlanJournal({root: path.join(root, 'plans')})});
  await handle({jsonrpc: '2.0', id: 'init', method: 'initialize'});
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => {text += chunk; if (text.includes('\n')) answered.resolve();});
  const work = runStdio(input, output, handle, 1);
  const plan = {version: 1, context, steps: [0, 1].map(i => ({operation: 'set_mods_enabled',
    requestId: 'capacity_plan_step_' + i, modIds: ['own'], enabled: true})), deploy: null};
  input.write(JSON.stringify({jsonrpc: '2.0', id: 'plan', method: 'tools/call',
    params: {name: 'run_mod_plan', arguments: {plan, apply: true}}}) + '\n');
  await entered.promise;
  input.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'plan'}}) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await answered.promise;
  input.end();
  await work;
  assert.deepEqual(writes, ['capacity_plan_step_0']);
  const result = JSON.parse(text).result.structuredContent;
  assert.equal(result.code, 'PLAN_CANCELLED');
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].adapterReceiptVerified, true);
});

test('ordinary overload is bounded, cancels pending plans and never dispatches the excess request', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0, cancelled = false;
  const handle = async request => {
    calls++; entered.resolve(); await release.promise;
    return {jsonrpc: '2.0', id: request.id, result: {}};
  };
  handle.cancelPendingPlans = () => {cancelled = true;};
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const work = runStdio(input, output, handle, 1).then(() => null, error => error);
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await entered.promise;
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n');
  await new Promise(resolve => setImmediate(resolve));
  const cancelledBeforeSettlement = cancelled;
  release.resolve(); input.end();
  const error = await work;
  assert.equal(cancelledBeforeSettlement, true);
  assert.equal(calls, 1);
  assert.match(error?.message || '', /MCP request capacity exceeded/);
});
