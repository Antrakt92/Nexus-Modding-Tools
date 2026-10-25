// Imported ONLY by tests. All requests are modeled in-process; no socket/network fallback exists.
import assert from 'node:assert/strict';
const calls = [];
let versionBody;
const secret = 'mock-secret-never-log';
let leaked = false;
let storageRequests = 0;
const nativeFetch = globalThis.fetch;
let builtinDispatcher;
const uploadId = '11111111-1111-1111-1111-111111111111';
const storage = process.env.MOCK_STORAGE_URL || 'https://fixture.s3.eu-west-1.amazonaws.com/object?partNumber=1&uploadId=fixture&signature=private';
const complete = 'https://fixture.s3.eu-west-1.amazonaws.com/object?uploadId=fixture&signature=private';
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === 'data:text/plain,nexus-native-transport-prime') {
    const response = await nativeFetch(url);
    builtinDispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
    return response;
  }
  assert.equal(init.dispatcher, builtinDispatcher);
  assert.equal(new Headers(init.headers).get('connection'), 'close');
  const headers = new Headers(init.headers);
  calls.push(String(url));
  const target = String(url);
  if (process.env.MOCK_CASE?.startsWith('redirect-')) {
    // Model native fetch's redirect behavior: custom apikey survives cross-origin 302/307.
    if (init.redirect !== 'error') {
      leaked = true;
      calls.push('https://attacker.invalid/received-key');
    }
    return new Response('redirect refused', { status: Number(process.env.MOCK_CASE.split('-')[1]),
      headers: { Location: 'https://attacker.invalid/received-key' } });
  }
  if (process.env.MOCK_CASE === 'upload-failure') {
    return new Response(`${secret} https://storage.invalid/part?signature=private`, { status: 403 });
  }
  if (target.startsWith('https://api.nexusmods.com/v3')) {
    assert.equal(headers.get('apikey'), secret);
    assert.equal(headers.get('Application-Name'), 'Nexus-Agent-Publication');
    assert.equal(headers.get('Application-Version'), '1.0');
  }
  if (target === 'https://api.nexusmods.com/v3/uploads/multipart') {
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.filename, 'fixture.zip');
    assert.ok(Number(body.size_bytes) > 0);
    return Response.json({ data: { id: uploadId, part_presigned_urls: [storage],
      part_size_bytes: process.env.MOCK_CASE === 'bad-geometry' ? 1 : Number(body.size_bytes), complete_presigned_url: complete } });
  }
  if (target === storage) {
    storageRequests++;
    assert.equal(init.method, 'PUT');
    assert.equal(headers.get('apikey'), null);
    assert.equal(headers.get('Application-Name'), null);
    assert.equal(init.body.length, Number(headers.get('Content-Length')));
    return new Response('', { headers: { ETag: '"modeled-etag"' } });
  }
  if (target === complete) {
    storageRequests++;
    assert.equal(init.method, 'POST');
    assert.equal(headers.get('apikey'), null);
    assert.equal(headers.get('Application-Name'), null);
    assert.match(init.body, /<PartNumber>1<\/PartNumber>/);
    return new Response(process.env.MOCK_CASE === 'completion-error' ? '<Error><Code>InternalError</Code></Error>'
      : '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>fixture</Bucket><Key>object</Key><ETag>modeled-etag</ETag></CompleteMultipartUploadResult>');
  }
  if (target.endsWith(`/uploads/${uploadId}/finalise`)) return Response.json({ data: { id: uploadId, state: 'available' } });
  if (target.endsWith(`/uploads/${uploadId}`)) return Response.json({ data: { state: 'available' } });
  if (target.endsWith('/mod-files/123/versions')) {
    versionBody = JSON.parse(init.body);
    assert.equal(versionBody.version, '1.2.3');
    assert.equal(versionBody.upload_id, uploadId);
    assert.equal(versionBody.archive_existing_file, false);
    assert.equal(versionBody.update_mod_version, false);
    assert.equal(versionBody.file_category, 'main');
    if (process.env.MOCK_EXPECTED_NAME) assert.equal(versionBody.name, process.env.MOCK_EXPECTED_NAME);
    if (process.env.MOCK_METADATA) {
      const expected = JSON.parse(process.env.MOCK_METADATA);
      for (const [field, value] of Object.entries(expected)) assert.deepEqual(versionBody[field], value);
      if (process.env.INPUT_DESCRIPTION === '') assert.equal('description' in versionBody, false);
    }
    return Response.json({ data: { version: { id: '987' } } }, { status: 201 });
  }
  if (target.endsWith('/mods/456/changelogs')) {
    assert.equal(JSON.parse(init.body).version, '1.2.3');
    if (process.env.MOCK_CASE === 'changelog-failure') return new Response(secret, { status: 500 });
    return Response.json({ data: {} }, { status: 201 });
  }
  throw new Error('Unexpected network route; test has no real fetch fallback');
};
process.on('beforeExit', () => {
  assert.equal(globalThis[Symbol.for('undici.globalDispatcher.1')], builtinDispatcher);
  if (!['upload-failure', 'storage-denied', 'bad-geometry', 'completion-error'].includes(process.env.MOCK_CASE) && !process.env.MOCK_CASE?.startsWith('redirect-')) {
    assert.ok(versionBody);
    assert.equal(calls.length, process.env.INPUT_CHANGELOG ? 7 : 6);
  }
});
process.on('exit', () => {
  // Fixed sentinel exit status proves the mock observed leakage/unsafe storage; never prints a key.
  if (leaked || (process.env.MOCK_CASE === 'storage-denied' && storageRequests > 0)) process.exitCode = 73;
  if (process.env.MOCK_CASE === 'bad-geometry' && storageRequests > 0) process.exitCode = 73;
  if (process.env.MOCK_CASE === 'completion-error' && calls.some(url => url.endsWith('/finalise'))) process.exitCode = 73;
});
