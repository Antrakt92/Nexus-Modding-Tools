import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installFetchGuard } from '../fetch-guard.mjs';
import { actionRoot } from './action-context.mjs';
import path from 'node:path';
// Use existing upstream locked dev tooling, never a new install or a production dependency.
const require = createRequire(path.join(actionRoot, 'package.json'));
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const nativeFetch = globalThis.fetch;
const key = 'synthetic-fetch-key';
const api = 'https://api.nexusmods.com/v3/uploads/multipart';
const headers = { apikey: key };
const s3 = 'https://fixture.s3.eu-west-1.amazonaws.com/object?partNumber=1&uploadId=fixture&X-Amz-Signature=synthetic';
const complete = 'https://fixture.s3.eu-west-1.amazonaws.com/object?uploadId=fixture&X-Amz-Signature=synthetic';
const plan = (part = s3, finish = complete) => ({ data: { id: '11111111-1111-1111-1111-111111111111',
  part_size_bytes: 4, part_presigned_urls: [part], complete_presigned_url: finish } });
const creation = { method: 'POST', headers, body: JSON.stringify({ size_bytes: '4' }) };
const transfer = { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) };
const completion = { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' };
const successXML = '<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>fixture-etag</ETag></CompleteMultipartUploadResult>';

for (const status of [302, 307]) {
  test(`native fetch ${status} forwarding reproduced; guard blocks before second-origin request`, async () => {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      const origin = agent.get('https://api.nexusmods.com');
      const attacker = agent.get('https://attacker.invalid');
      origin.intercept({ path: '/v3/uploads/multipart', method: 'POST' })
        .reply(status, '', { headers: { location: 'https://attacker.invalid/receive' } }).times(2);
      let forwarded = 0;
      attacker.intercept({ path: '/receive', method: status === 302 ? 'GET' : 'POST' }).reply((request) => {
        assert.equal(new Headers(request.headers).get('apikey'), key);
        forwarded++;
        return { statusCode: 200, data: '{}' };
      });
      // Baseline demonstrates the defect using actual Node native fetch, fully network-intercepted.
      await nativeFetch(api, { method: 'POST', headers, body: '{}' });
      assert.equal(forwarded, 1);
      const guarded = installFetchGuard(nativeFetch, key, { archiveBytes: 4 });
      await assert.rejects(guarded(api, creation));
      assert.equal(forwarded, 1); // guard caused NO further attacker request.
    } finally {
      globalThis.fetch = nativeFetch;
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });
}

test('API origin restriction handles Request, URL, Headers and init override semantics', async () => {
  let transports = 0;
  const guarded = installFetchGuard(async (_input, init) => {
    transports++;
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    return Response.json({ data: {} });
  }, key);
  for (const url of ['http://api.nexusmods.com/v3/a', 'https://api.nexusmods.com:444/v3/a',
                     'https://api.nexusmods.com.evil.invalid/v3/a', 'https://localhost/v3/a',
                     'https://user@api.nexusmods.com/v3/a', 'https://api.nexusmods.com/v3/a#fragment']) {
    await assert.rejects(guarded(url, { headers }), /Network boundary/);
  }
  await guarded(new URL('https://api.nexusmods.com/v3/a'), { headers: new Headers(headers), redirect: 'follow' });
  await guarded(new Request('https://api.nexusmods.com/v3/a', { headers }));
  await assert.rejects(guarded(new Request('https://api.nexusmods.com/v3/a', { headers }), { headers: {} }));
  assert.equal(transports, 2);
});

test('only approved API-issued exact S3 URL/method pairs may reach storage', async () => {
  const calls = [];
  const guarded = installFetchGuard(async (input, init) => {
    calls.push({ input, init });
    return input === api ? Response.json(plan()) : input === s3
      ? new Response('', { headers: { ETag: '"fixture-etag"' } }) : new Response(successXML);
  }, key, { archiveBytes: 4 });
  await assert.rejects(guarded(s3, { method: 'PUT' })); // provider alone does not authorize destination
  await guarded(api, creation);
  for (const badHeaders of [{ apikey: key }, new Headers({ APIKEY: key }), [['Cookie', 'value']],
                           { authorization: 'Bearer synthetic' }, { 'proxy-authorization': 'value' },
                           { api_key: 'value' }, { 'x-api-key': 'other-credential' }, { 'x-other': key }]) {
    await assert.rejects(guarded(s3, { method: 'PUT', headers: badHeaders }));
  }
  await assert.rejects(guarded(new Request(s3, { method: 'PUT', headers })));
  await assert.rejects(guarded(new Request(s3, { method: 'PUT', credentials: 'include' })));
  await assert.rejects(guarded(s3, { method: 'PUT', credentials: 'include' }));
  await assert.rejects(guarded(s3, { method: 'GET' }));
  await assert.rejects(guarded(s3 + '&changed=1', { method: 'PUT' }));
  await guarded(s3, transfer);
  await guarded(complete, completion);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit'));
});

test('unsafe API-issued storage plans fail before transport, including complete URL', async () => {
  const unsafe = ['http://fixture.s3.eu-west-1.amazonaws.com/object', 'https://localhost/object',
    'https://127.0.0.1/object', 'https://[::1]/object', 'https://169.254.169.254/object',
    'https://fixture.s3.eu-west-1.amazonaws.com.evil.invalid/object', 'https://evil.amazonaws.com/object',
    'https://fixture.s3.eu-west-1.amazonaws.com:8443/object', 'https://u:p@fixture.s3.eu-west-1.amazonaws.com/object',
    'https://fixture.s3.eu-west-1.amazonaws.com/object#fragment',
    'https://fixture.s3.eu-west-1.amazonaws.com/object?apikey=value',
    `https://fixture.s3.eu-west-1.amazonaws.com/object?token=${key}`];
  for (const url of unsafe) {
    for (const body of [plan(url), plan(s3, url)]) {
      let calls = 0;
      const guarded = installFetchGuard(async () => { calls++; return Response.json(body); }, key, { archiveBytes: 4 });
      await assert.rejects(guarded(api, creation));
      assert.equal(calls, 1);
    }
  }
});

test('documented AWS regional/global/path/legacy endpoints work only when returned in approved plan', async () => {
  for (const host of ['fixture.s3.eu-west-1.amazonaws.com', 's3.eu-west-1.amazonaws.com',
                     'fixture.s3.amazonaws.com', 's3.amazonaws.com', 'fixture.s3-us-west-2.amazonaws.com']) {
    const url = `https://${host}/object?partNumber=1&uploadId=fixture&X-Amz-Signature=synthetic`;
    const finish = `https://${host}/object?uploadId=fixture&X-Amz-Signature=synthetic`;
    const guarded = installFetchGuard(async input => input === api ? Response.json(plan(url, finish))
      : new Response('', { headers: { ETag: '"fixture-etag"' } }), key, { archiveBytes: 4 });
    await guarded(api, creation);
    await guarded(url, transfer);
  }
});

test('storage redirects are refused even if transport returns a 302/307 response', async () => {
  for (const status of [302, 307]) {
    let calls = 0;
    const guarded = installFetchGuard(async input => {
      calls++;
      return input === api ? Response.json(plan()) : new Response('', { status, headers: { location: 'https://localhost/receive' } });
    }, key, { archiveBytes: 4 });
    await guarded(api, creation);
    await assert.rejects(guarded(s3, transfer));
    assert.equal(calls, 2);
  }
});
