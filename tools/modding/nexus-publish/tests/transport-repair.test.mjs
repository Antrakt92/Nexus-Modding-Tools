import test from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from '../fetch-guard.mjs';

const key = 'synthetic-fetch-key';
const api = 'https://api.nexusmods.com/v3/uploads/multipart';
const part = 'https://fixture.s3.eu-west-1.amazonaws.com/object?partNumber=1&uploadId=fixture';
const complete = 'https://fixture.s3.eu-west-1.amazonaws.com/object?uploadId=fixture';
const headers = { apikey: key };
const create = { method: 'POST', headers, body: JSON.stringify({ filename: 'fixture.zip', size_bytes: '4' }) };
const plan = (size = 4, urls = [part]) => ({ data: { id: '11111111-1111-1111-1111-111111111111',
  part_size_bytes: size, part_presigned_urls: urls, complete_presigned_url: complete } });

test('Nexus-issued canonical Cloudflare R2 plan transfers without the Nexus key', async () => {
  const origin = 'https://test-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  const r2part = part.replace('https://fixture.s3.eu-west-1.amazonaws.com', origin);
  const r2complete = complete.replace('https://fixture.s3.eu-west-1.amazonaws.com', origin);
  let storage = 0;
  const guard = installFetchGuard(async (url, init) => {
    if (url === api) return Response.json({ data: { ...plan().data,
      part_presigned_urls: [r2part], complete_presigned_url: r2complete } });
    storage++;
    assert.equal(new Headers(init.headers).get('apikey'), null);
    assert.equal(init.redirect, 'error');
    if (url === r2part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    assert.equal(url, r2complete);
    return new Response('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>fixture-etag</ETag></CompleteMultipartUploadResult>');
  }, key, { archiveBytes: 4 });
  await guard(api, create);
  await guard(r2part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  await guard(r2complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' });
  assert.equal(storage, 2);
});

test('R2 suffix tricks, custom domains and noncanonical account IDs stay forbidden', async () => {
  for (const host of ['r2.cloudflarestorage.com', 'bad.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.attacker.invalid',
    'nested.bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    '-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.r2.dev']) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json({ data: {
      ...plan().data, part_presigned_urls: [part.replace('fixture.s3.eu-west-1.amazonaws.com', host)],
      complete_presigned_url: complete.replace('fixture.s3.eu-west-1.amazonaws.com', host),
    } }); }, key, { archiveBytes: 4 });
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('an oversized streaming multipart response is cancelled and refused promptly', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
    cancel() { cancelled = true; },
  });
  const guard = installFetchGuard(async () => new Response(body), key, { archiveBytes: 4 });
  let timer;
  try {
    const outcome = await Promise.race([
      guard(api, create).then(() => 'accepted', () => 'refused'),
      new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 250); }),
    ]);
    assert.equal(outcome, 'refused');
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('refusal does not wait for an uncooperative cancellation; valid plan remains readable by the action', async () => {
  const guard = installFetchGuard(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
    cancel() { return new Promise(() => {}); },
  })), key, { archiveBytes: 4 });
  let timer;
  try {
    assert.equal(await Promise.race([
      guard(api, create).then(() => 'accepted', () => 'refused'),
      new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 250); }),
    ]), 'refused');
  } finally { clearTimeout(timer); }
  const valid = installFetchGuard(async () => Response.json(plan()), key, { archiveBytes: 4 });
  assert.deepEqual(await (await valid(api, create)).json(), plan());
});

test('inconsistent, unbounded and duplicate multipart plans are refused before storage', async () => {
  for (const body of [plan(1), plan(0), plan(-1), plan(1.5), plan('4'), plan(2, [part, part]), plan(2 ** 40)]) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json(body); }, key, { archiveBytes: 4 });
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('a short body never reaches storage, and completion requires all uploaded bytes', async () => {
  let storageCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    storageCalls++;
    return new Response('');
  }, key, { archiveBytes: 4 });
  await guard(api, create);
  await assert.rejects(guard(part, { method: 'PUT', headers: { 'content-length': '1' }, body: Buffer.alloc(1) }));
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload/>' }));
  assert.equal(storageCalls, 0);
});

test('S3 HTTP-200 Error is refused before Nexus finalise', async () => {
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    if (url === part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    return new Response('<Error><Code>InternalError</Code></Error>', { status: 200 });
  }, key, { archiveBytes: 4 });
  await guard(api, create);
  await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' }));
});

test('concurrent duplicate part, gap and early completion are denied; full coverage completes once', async () => {
  const second = part.replace('partNumber=1', 'partNumber=2');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let storageCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan(2, [part, second]));
    storageCalls++;
    if (url === part) await pending;
    if (url === complete) return new Response('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>result</ETag></CompleteMultipartUploadResult>');
    return new Response('', { headers: { ETag: '"fixture-etag"' } });
  }, key, { archiveBytes: 4 });
  await guard(api, create);
  const transfer = { method: 'PUT', headers: { 'content-length': '2' }, body: Buffer.alloc(2) };
  const first = guard(part, transfer);
  await assert.rejects(guard(part, transfer));
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload/>' }));
  assert.equal(storageCalls, 1);
  release();
  await first;
  await guard(second, transfer);
  const request = '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part><Part><PartNumber>2</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>';
  await guard(complete, { method: 'POST', body: request });
  await assert.rejects(guard(complete, { method: 'POST', body: request }));
  assert.equal(storageCalls, 3);
});

test('part-number gaps, reordered plan and mismatched object/upload ID never reach storage', async () => {
  for (const urls of [[part.replace('partNumber=1', 'partNumber=2')],
                     [part.replace('uploadId=fixture', 'uploadId=other')],
                     [part.replace('/object?', '/other?')]]) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json(plan(4, urls)); }, key, { archiveBytes: 4 });
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('bounded XML rejects empty, malformed, entity, wrong namespace, oversize and embedded errors', async () => {
  for (const xml of ['', '<broken>', '<!DOCTYPE x [<!ENTITY bomb "value">]><CompleteMultipartUploadResult/>',
    '<CompleteMultipartUploadResult xmlns="https://wrong.invalid"><Bucket>fixture</Bucket><Key>object</Key><ETag>ok</ETag></CompleteMultipartUploadResult>',
    'x'.repeat(65537), '<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>ok</ETag><Error/></CompleteMultipartUploadResult>',
    '<CompleteMultipartUploadResult/>']) {
    const guard = installFetchGuard(async url => url === api ? Response.json(plan()) : url === part
      ? new Response('', { headers: { ETag: '"fixture-etag"' } }) : new Response(xml), key, { archiveBytes: 4 });
    await guard(api, create);
    await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
    await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' }));
    await assert.rejects(guard('https://api.nexusmods.com/v3/uploads/11111111-1111-1111-1111-111111111111/finalise', { method: 'POST', headers }));
  }
});

test('completion request must list exactly all confirmed ETags before storage sees it', async () => {
  let completeCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    if (url === part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    completeCalls++;
    return new Response('');
  }, key, { archiveBytes: 4 });
  await guard(api, create);
  await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  for (const xml of ['<CompleteMultipartUpload/>', '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>wrong</ETag></Part></CompleteMultipartUpload>',
    '<!DOCTYPE x><CompleteMultipartUpload/>']) {
    await assert.rejects(guard(complete, { method: 'POST', body: xml }));
  }
  assert.equal(completeCalls, 0);
});
