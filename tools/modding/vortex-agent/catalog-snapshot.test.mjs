import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {matchingDownloads} = require('./download-identity.cjs');
const {listDownloads} = require('./inspection.cjs');

const item = (fileId = 43) => ({game: ['cyberpunk2077'], state: 'finished', size: 4,
  modInfo: {nexus: {ids: {gameId: 'cyberpunk2077', modId: 42, fileId}}, meta: {gameId: 3333}}});
const selectors = {activeGameId: () => 'cyberpunk2077', knownGames: () => [{id: 'cyberpunk2077'}]};
const args = {gameId: 'cyberpunk2077', nexusModId: 42, nexusFileId: 43};

test('inventory reads a numeric game catalogue once per projection, never across projections', () => {
  const state = {persistent: {downloads: {files: Object.fromEntries(Array.from({length: 100}, (_, i) => ['d' + i, item(i + 1)]))}}};
  let reads = 0;
  const catalog = () => {reads++; return [{id: 3333, domain_name: 'cyberpunk2077'}];};
  const api = {getState: () => state};
  const result = listDownloads(api, selectors, {gameId: 'cyberpunk2077', limit: 500}, catalog);
  assert.equal(result.length, 100); assert.ok(result.every(row => row.identityVerified)); assert.equal(reads, 1);
  listDownloads(api, selectors, {gameId: 'cyberpunk2077', limit: 500}, catalog);
  assert.equal(reads, 2);
});

test('matching uses one fresh catalogue per scan and observes drift on the next scan', () => {
  const files = {unrelated: item(99), exact: item()}; let reads = 0, domain = 'cyberpunk2077';
  const catalog = () => {reads++; return [{id: 3333, domain_name: domain}];};
  assert.deepEqual(matchingDownloads(files, args, {}, selectors, catalog).map(([id]) => id), ['exact']);
  assert.equal(reads, 1);
  domain = 'other-game';
  assert.throws(() => matchingDownloads(files, args, {}, selectors, catalog), /AMBIGUOUS_DOWNLOAD_IDENTITY/);
  assert.equal(reads, 2);
});

test('a failed catalogue read is not retried for every record or remembered by the next operation', () => {
  const state = {persistent: {downloads: {files: {a: item(), b: item(99)}}}}; let reads = 0, fail = true;
  const catalog = () => {reads++; if (fail) throw Error('private disk detail'); return [{id: 3333, domain_name: 'cyberpunk2077'}];};
  const api = {getState: () => state};
  assert.ok(listDownloads(api, selectors, args, catalog).every(row => row.identityAmbiguous)); assert.equal(reads, 1);
  fail = false;
  assert.ok(listDownloads(api, selectors, args, catalog).every(row => row.identityVerified)); assert.equal(reads, 2);
});

test('domain-only records need no disk catalogue', () => {
  const record = item(); delete record.modInfo.meta;
  const result = matchingDownloads({d: record}, args, {}, selectors, () => assert.fail('unnecessary catalogue read'));
  assert.equal(result.length, 1);
});

test('unrelated numeric-game records are filtered before catalogue resolution; duplicate matches remain refused', () => {
  assert.deepEqual(matchingDownloads({unrelated: item(999)}, args, {}, selectors, () => assert.fail('unrelated catalogue read')), []);
  let reads = 0;
  assert.throws(() => matchingDownloads({a: item(), b: item()}, args, {}, selectors, () => {
    reads++; return [{id: 3333, domain_name: 'cyberpunk2077'}];
  }), /AMBIGUOUS_EXISTING_DOWNLOAD/);
  assert.equal(reads, 1);
});
