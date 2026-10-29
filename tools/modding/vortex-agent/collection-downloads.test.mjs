import test from 'node:test';
import assert from 'node:assert/strict';
import {findCollectionDownloads, validateCollectionRequest} from './collection-downloads.mjs';
import {clientRemote, handler} from './bridge.mjs';

const health = () => ({protocol: 'vortex-agent/1', gameId: 'cyberpunk2077', profileId: 'p',
  gamePath: 'F:/Game', stagingPath: 'F:/Stage', downloadPath: 'D:/Downloads',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}});
const ref = (file = 43, mod = 42) => ({nexusModId: mod, nexusFileId: file});
const input = files => ({gameId: 'cyberpunk2077', files: files || [ref()]});
const row = (id = 'd', overrides = {}) => ({id, gameId: 'cyberpunk2077', nexusModId: 42, nexusFileId: 43,
  identityVerified: true, identityAmbiguous: false, state: 'finished', size: 12, ...overrides});
const reply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
function fixture(rows = [], before = () => {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({name, args}); const override = await before(name, args, calls);
    if (override !== undefined) return override;
    assert.ok(['health', 'list_downloads'].includes(name), 'No unrelated read or mutation');
    return name === 'health' ? health() : rows;
  };
  return {calls, call};
}

test('100 requested pairs use exactly one download read and two context checks, with compact output', async () => {
  const f = fixture([row('matched', {installedModId: 'associated', name: 'private display value', url: 'https://example.invalid/?token=private'}),
    row('unrelated', {nexusFileId: 5000})]);
  const result = await findCollectionDownloads(input(Array.from({length: 100}, (_, i) => ref(i + 43))), f);
  assert.deepEqual(f.calls.map(c => c.name), ['health', 'list_downloads', 'health']);
  assert.deepEqual(f.calls[1].args, {gameId: 'cyberpunk2077', limit: 500});
  assert.equal(result.status, 'ok'); assert.equal(result.uniqueCount, 100);
  assert.equal(result.files[0].availability, 'finished'); assert.equal(result.files[1].availability, 'not_observed');
  assert.deepEqual(result.files[0].candidates, [{downloadId: 'matched', state: 'finished', size: 12, installedModId: 'associated'}]);
  assert.equal(result.archiveIntegrityVerified, false); assert.equal(result.metadataOnly, true);
  assert.ok(!JSON.stringify(result).includes('private display value'));
  assert.ok(!JSON.stringify(result.files).includes('unrelated'));
});

test('duplicate requests collapse and duplicate tracked files remain visible without choosing or deleting one', async () => {
  const f = fixture([row('a'), row('b')]);
  const result = await findCollectionDownloads(input([ref(), ref()]), f);
  assert.equal(result.requestedCount, 2); assert.equal(result.uniqueCount, 1);
  assert.equal(result.files[0].duplicateCandidates, true);
  assert.deepEqual(result.files[0].candidates.map(c => c.downloadId), ['a', 'b']);
});

test('availability reflects observed native states and never equates installed association with enabled state', async () => {
  for (const [state, availability] of [['init', 'active'], ['started', 'active'], ['finalizing', 'active'], ['paused', 'paused'], ['failed', 'failed']]) {
    const result = await findCollectionDownloads(input(), fixture([row('d', {state})]));
    assert.equal(result.files[0].availability, availability);
    assert.equal(result.files[0].candidates[0].enabled, undefined);
  }
});

test('ambiguous Nexus identities are counted and never assigned to a requested file', async () => {
  const result = await findCollectionDownloads(input(), fixture([row('ambiguous', {identityVerified: false, identityAmbiguous: true, nexusModId: null, nexusFileId: null})]));
  assert.equal(result.unverifiedIdentityCount, 1); assert.equal(result.files[0].availability, 'not_observed');
  assert.deepEqual(result.files[0].candidates, []);
});

test('caps preserve positive observations but unseen files and uniqueness remain unknown', async () => {
  const rows = Array.from({length: 500}, (_, i) => row('d' + i, {nexusFileId: i + 43}));
  const result = await findCollectionDownloads(input([ref(), ref(9999)]), fixture(rows));
  assert.equal(result.status, 'partial'); assert.equal(result.observationComplete, false);
  assert.equal(result.files[0].availability, 'finished'); assert.equal(result.files[0].duplicateCandidates, null);
  assert.equal(result.files[1].availability, 'unknown');
  assert.deepEqual(result.errors, [{tool: 'list_downloads', code: 'INVENTORY_LIMIT_REACHED'}]);
});

test('wrong active game stops before inventory; later profile/path/inode drift discards candidate associations', async () => {
  const wrong = fixture([], name => name === 'health' ? {...health(), gameId: 'skyrimse'} : undefined);
  const result = await findCollectionDownloads(input(), wrong);
  assert.deepEqual(wrong.calls.map(c => c.name), ['health']); assert.equal(result.status, 'partial');
  assert.equal(result.files[0].availability, 'unknown'); assert.equal(result.context, undefined);
  for (const mutate of [v => {v.profileId = 'other';}, v => {v.downloadPath = 'D:/Other';}, v => {v.filesystemIds.downloadPath = '3:4';}]) {
    let checks = 0;
    const drift = fixture([row()], name => {if (name === 'health' && ++checks === 2) {const h = health(); mutate(h); return h;}});
    const changed = await findCollectionDownloads(input(), drift);
    assert.equal(changed.status, 'partial'); assert.equal(changed.files[0].availability, 'unknown');
    assert.deepEqual(changed.files[0].candidates, []); assert.equal(changed.context, undefined);
  }
});

test('failed or malformed inventories cannot produce an empty successful match', async () => {
  const cases = [null, [row('d', {size: -1})], [row('d', {nexusFileId: '43'})],
    [row('d', {identityAmbiguous: true})], [row('d', {gameId: 'skyrimse'})], [row(), row()],
    Array.from({length: 501}, (_, i) => row('d' + i))];
  for (const rows of cases) {
    const result = await findCollectionDownloads(input(), fixture(rows));
    assert.equal(result.status, 'partial'); assert.equal(result.files[0].availability, 'unknown');
  }
  const f = fixture([], name => {if (name === 'list_downloads') throw Error('private transport detail');});
  const result = await findCollectionDownloads(input(), f);
  assert.equal(result.status, 'partial'); assert.ok(!JSON.stringify(result).includes('private transport detail'));
});

test('invalid requests fail before transport and caller mutation cannot alter an in-flight batch', async () => {
  for (const value of [undefined, null, {}, {gameId: 'game', files: []}, input(Array.from({length: 101}, () => ref())),
    input([ref(0)]), input([ref(1.2)]), input([ref(Number.MAX_SAFE_INTEGER + 1)]), input([ref('43')]),
    {...input(), extra: true}, input([{...ref(), sha256: 'not a matching input'}]), {gameId: 'relative/path', files: [ref()]}]) {
    assert.throws(() => validateCollectionRequest(value), /INVALID_COLLECTION_REQUEST/);
    await assert.rejects(findCollectionDownloads(value, {call: async () => assert.fail('called')}), /INVALID_COLLECTION_REQUEST/);
  }
  const request = input();
  const f = fixture([row()], name => {if (name === 'health') request.files[0].nexusFileId = 999;});
  assert.equal((await findCollectionDownloads(request, f)).files[0].nexusFileId, 43);
});

test('MCP discovery, initialize gate and compact error/partial envelopes work through the local bridge', async () => {
  const f = fixture([row()]);
  const transport = async (method, params) => method === 'tools/list' ? {tools: [{name: 'find_collection_downloads'}, {name: 'install_download'}]}
    : reply(await f.call(params.name, params.arguments));
  const list = await clientRemote('tools/list', {}, transport);
  assert.equal(list.tools.filter(t => t.name === 'find_collection_downloads').length, 1);
  const tool = list.tools.find(t => t.name === 'find_collection_downloads'); assert.equal(tool.annotations.readOnlyHint, true);
  const handle = handler(transport);
  const request = {jsonrpc: '2.0', id: 22, method: 'tools/call', params: {name: tool.name, arguments: input()}};
  assert.ok((await handle(request)).error); assert.equal(f.calls.length, 0);
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  const response = await handle(request);
  assert.equal(response.id, 22); assert.equal(response.result.structuredContent.status, 'ok');
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  const invalid = await clientRemote('tools/call', {name: tool.name, arguments: {}}, async () => assert.fail('called'));
  assert.equal(invalid.isError, true);
  const partial = await clientRemote('tools/call', {name: tool.name, arguments: input()}, async () => {throw Error('private');});
  assert.equal(partial.isError, true); assert.equal(partial.structuredContent.status, 'partial');
});
