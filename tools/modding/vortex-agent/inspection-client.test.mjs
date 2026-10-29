import test from 'node:test';
import assert from 'node:assert/strict';
import {clientRemote, handler} from './bridge.mjs';
import {inspectSession, main} from './session.mjs';

const health = () => ({protocol: 'vortex-agent/1', gameId: 'cyberpunk2077', profileId: 'profile',
  gamePath: 'F:/Game', stagingPath: 'F:/Staging', downloadPath: 'D:/Downloads',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}});
const collection = completeCollection;
const content = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});

test('bridge advertises each local read tool once and keeps unsupported installation hidden', async () => {
  const calls = [];
  const transport = async (method, params) => {
    calls.push({method, params});
    return {tools: [{name: 'health'}, {name: 'install_download'}, {name: 'inspect_session'}]};
  };
  const result = await clientRemote('tools/list', {}, transport);
  assert.deepEqual(result.tools.map(t => t.name), ['health', 'inspect_session', 'find_collection_downloads']);
  assert.equal(result.tools[1].annotations.readOnlyHint, true);
  assert.equal(result.tools[1].inputSchema.additionalProperties, false);
  assert.equal(calls.length, 1);
  await assert.rejects(clientRemote('tools/list', {}, async () => ({})), /Invalid Vortex tool inventory/);
});

test('one bridge call composes only existing reads with bounded concurrency and full diagnostics', async () => {
  const calls = []; let active = 0, maximum = 0;
  const transport = async (method, params) => {
    assert.equal(method, 'tools/call'); calls.push(params);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 3)); --active;
    if (params.name === 'health') return content(health());
    if (params.name === 'read_collection_health') return content(collection());
    assert.ok(['list_mods', 'list_downloads', 'list_dialogs', 'list_external_changes', 'list_unsolved_conflicts'].includes(params.name));
    return content([]);
  };
  const result = await clientRemote('tools/call', {name: 'inspect_session', arguments: {diagnostics: true}}, transport);
  assert.equal(result.structuredContent.status, 'ok'); assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.snapshotAtomic, false);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(calls.length, 8); assert.equal(maximum, 4);
  assert.equal(calls[0].name, 'health'); assert.equal(calls.at(-1).name, 'health');
  assert.equal(result.structuredContent.results.read_collection_health.nativeConflicts.count, null);
  for (const call of calls.filter(c => ['list_mods', 'list_downloads'].includes(c.name)))
    assert.deepEqual(call.arguments, {gameId: 'cyberpunk2077', limit: 500});
});

test('invalid local arguments cause no credential or transport calls', async () => {
  for (const args of [null, [], 'anything', {diagnostics: 'true'}, {dispatch: 'install'}, {diagnostics: true, extra: false}]) {
    const result = await clientRemote('tools/call', {name: 'inspect_session', arguments: args}, async () => assert.fail('transport invoked'));
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'INVALID_INSPECTION_OPTIONS');
  }
});

test('missing diagnostics, limits and malformed collections remain explicit partial results', async () => {
  for (const failure of ['missing', 'malformed', 'limit', 'drift']) {
    let checks = 0;
    const result = await clientRemote('tools/call', {name: 'inspect_session', arguments: {diagnostics: true}}, async (_method, params) => {
      if (params.name === 'health') return content({...health(), profileId: failure === 'drift' && ++checks === 2 ? 'changed' : 'profile'});
      if (params.name === 'read_collection_health') {
        if (failure === 'missing') return {isError: true, content: [{type: 'text', text: 'private transport details'}]};
        return content(failure === 'malformed' ? {} : collection());
      }
      return content(failure === 'limit' && params.name === 'list_mods' ? Array.from({length: 500}, () => ({})) : []);
    });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.status, 'partial');
    assert.equal(result.structuredContent.errors.length, 1);
    assert.ok(!JSON.stringify(result).includes('private transport details'));
    assert.ok(result.structuredContent.results.list_downloads);
    if (failure === 'missing' || failure === 'malformed') assert.equal(result.structuredContent.results.read_collection_health, undefined);
  }
});

test('MCP initialize gate applies to the local tool and preserves request IDs', async () => {
  let calls = 0;
  const handle = handler(async (_method, params) => {calls++; return content(params.name === 'health' ? health() : []);});
  const request = {jsonrpc: '2.0', id: 42, method: 'tools/call', params: {name: 'inspect_session'}};
  assert.equal((await handle(request)).error.code, -32000); assert.equal(calls, 0);
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  const result = await handle(request);
  assert.equal(result.id, 42); assert.equal(result.result.structuredContent.status, 'ok'); assert.equal(calls, 7);
});

test('diagnostic CLI opts in, returns nonzero for partial and rejects unrelated flags', async () => {
  const names = [], output = [];
  const code = await main(['inspect', '--diagnostics'], {call: async name => {
    names.push(name); if (name === 'list_unsolved_conflicts') throw Error('NATIVE_CONFLICT_STATE_UNAVAILABLE');
    return name === 'health' ? health() : name === 'read_collection_health' ? collection() : [];
  }, output: value => output.push(value)});
  assert.equal(code, 1); assert.equal(output[0].status, 'partial'); assert.equal(names.length, 8);
  assert.equal(await main(['inspect', '--apply'], {call: async () => assert.fail('called'), output: () => {}}), 1);
  await assert.rejects(inspectSession({diagnostics: 'yes', call: async () => assert.fail('called')}), /INVALID_INSPECTION_OPTIONS/);
});

test('diagnostic schema rejects missing, mistyped and negative observations', async () => {
  for (const mutate of [v => {delete v.nativeConflicts.count;}, v => {v.nativeConflicts.count = -1;},
    v => {v.nativeConflicts.hasUnsolvedConflicts = 'false';}, v => {delete v.collectionSession.counters;},
    v => {v.collectionSession.present = 0;}, v => {v.collectionSession.counters.failedCount = -1;}]) {
    const value = completeCollection(); mutate(value);
    const result = await inspectSession({diagnostics: true, call: async name =>
      name === 'health' ? health() : name === 'read_collection_health' ? value : []});
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.errors, [{tool: 'read_collection_health', code: 'INVALID_COLLECTION_HEALTH_RESPONSE'}]);
    assert.equal(result.results.read_collection_health, undefined);
  }
});

function completeCollection() {
  return {nativeConflicts: {count: null, hasUnsolvedConflicts: null, available: false, consistent: false, conflictsCalculated: false},
    collectionSession: {available: false, present: null, stalled: null,
      counters: {totalRequired: null, totalOptional: null, downloadedCount: null, installedCount: null, failedCount: null, ignoredCount: null}},
    recalculationVerified: false, diskDeploymentVerified: false};
}
