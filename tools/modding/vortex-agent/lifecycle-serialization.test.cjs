'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {safe} = require('./serialization.cjs');

function fixture() {
  const value = {protocol: 'vortex-agent/1', gameId: 'cyberpunk2077', profileId: 'profile-owner', mods: [{
    id: 'owner', archiveId: 'archive-owner', label: 'owner',
    profiles: [{id: 'profile-owner', gameId: 'cyberpunk2077'}],
    incomingRequires: [{ownerId: 'requires-owner'}],
    archiveReferences: [{gameId: 'cyberpunk2077', modId: 'archive-consumer-owner'}],
  }]};
  const api = {getState: () => ({confidential: {token: 'private-test-secret'},
    persistent: {nexus: {userInfo: {username: 'owner', displayName: 'cyberpunk'}}}})};
  return {value, api};
}

test('lifecycle operational IDs retain exact identities without exempting display fields', () => {
  const {value, api} = fixture(), result = safe(value, api, 'read_mod_lifecycle');
  assert.equal(result.gameId, value.gameId); assert.equal(result.profileId, value.profileId);
  assert.equal(result.mods[0].id, 'owner'); assert.equal(result.mods[0].archiveId, 'archive-owner');
  assert.deepEqual(result.mods[0].profiles, value.mods[0].profiles);
  assert.deepEqual(result.mods[0].incomingRequires, value.mods[0].incomingRequires);
  assert.deepEqual(result.mods[0].archiveReferences, value.mods[0].archiveReferences);
  assert.equal(result.mods[0].label, '[redacted]');
});

test('lifecycle ID slots still reject credential overlap and embedded URIs', () => {
  for (const id of ['private-test-secret', 'https://example.test/private']) {
    const {value, api} = fixture(); value.mods[0].incomingRequires[0].ownerId = id;
    assert.throws(() => safe(value, api, 'read_mod_lifecycle'), /OPERATIONAL_/);
  }
});
