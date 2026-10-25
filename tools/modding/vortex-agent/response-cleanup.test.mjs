import test from 'node:test';
import assert from 'node:assert/strict';
import { remote } from './bridge.mjs';

async function boundedOutcome(work) {
  let timer;
  try {
    return await Promise.race([work.then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 250); })]);
  } finally { clearTimeout(timer); }
}
const token = async () => 'synthetic-bearer';

for (const mode of ['length', 'json', 'sse', 'success']) {
  test(`remote cancellation cannot stall ${mode} response handling`, async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        if (mode === 'success') controller.enqueue(Buffer.from('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'));
        else if (mode !== 'length') controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const headers = mode === 'length' ? { 'content-length': String(8 * 1024 * 1024 + 1) }
      : { 'content-type': mode === 'json' ? 'application/json' : 'text/event-stream' };
    const outcome = await boundedOutcome(remote('tools/call', { name: 'health' }, async () => new Response(stream, { headers }), token));
    assert.equal(outcome.stalled, undefined);
    assert.equal(cancelled, true);
    if (mode === 'success') assert.deepEqual(outcome.value, { ok: true });
    else assert.match(outcome.error.message, /MCP response too large/);
  });
}

test('rejected HTTP response cancels its unread body without awaiting the producer', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(remote('tools/list', {}, async () => new Response(stream, { status: 401 }), token), /authentication/);
  assert.equal(cancelled, true);
});

test('missing or ambiguous JSON-RPC results and malformed UTF-8 are refused', async () => {
  for (const value of [
    Buffer.from('{"jsonrpc":"2.0","id":1}'),
    Buffer.from('{"jsonrpc":"2.0","id":1,"result":{},"error":null}'),
    Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"name":"'), Buffer.from([0xff]), Buffer.from('"}}')]),
  ]) {
    await assert.rejects(remote('tools/call', {}, async () => new Response(value), token), /Invalid Vortex MCP response/);
  }
});

test('stream-reader failures cannot expose underlying private error text', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('synthetic-bearer private transport detail')); } });
  await assert.rejects(remote('tools/list', {}, async () => new Response(stream), token), error =>
    error.message === 'Invalid Vortex MCP response' && !error.message.includes('synthetic-bearer'));
});
