import test from 'node:test';
import assert from 'node:assert/strict';
import {remote} from './bridge.mjs';

const token = async () => 'synthetic-bearer';
function response(bytes, chunkBytes = 1) {
  let next = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (next === bytes.length) {controller.close(); return;}
      controller.enqueue(bytes.subarray(next, next + chunkBytes));
      next = Math.min(next + chunkBytes, bytes.length);
    },
  }), {headers: {'content-type': 'text/event-stream'}});
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
  test(`SSE accepts split ${name} lines and UTF-8 with comments, multiline data and preceding events`, async () => {
    const wire = [': keepalive', '', 'data: {"jsonrpc":"2.0","method":"notification"}', '',
      'event: message', 'data: {"jsonrpc":"2.0",', 'data: "id":1,"result":{"name":"проверка"}}', '', ''].join(ending);
    const result = await remote('tools/call', {}, async () => response(Buffer.from(wire)), token);
    assert.deepEqual(result, {name: 'проверка'});
  });
}

test('SSE joins a large event fragmented into small chunks without changing payload', async () => {
  const expected = {text: 'x'.repeat(2 * 1024 * 1024)};
  const bytes = Buffer.from('data: ' + JSON.stringify({jsonrpc: '2.0', id: 1, result: expected}) + '\n\n');
  assert.deepEqual(await remote('tools/call', {}, async () => response(bytes, 512), token), expected);
});

test('SSE handles mixed line endings with empty chunks inside CRLF and Unicode sequences', async () => {
  const bytes = Buffer.from(': keepalive\r\ndata: {"jsonrpc":"2.0",\rdata: "id":1,"result":{"name":"🔧"}}\n\r\n');
  const stream = new ReadableStream({start(controller) {
    for (const byte of bytes) {controller.enqueue(Buffer.from([byte])); controller.enqueue(new Uint8Array());}
    controller.close();
  }});
  assert.deepEqual(await remote('tools/call', {}, async () => new Response(stream,
    {headers: {'content-type': 'text/event-stream'}}), token), {name: '🔧'});
});

test('SSE still requires an event boundary and the matching response ID', async () => {
  for (const wire of [
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    'data: {"jsonrpc":"2.0","id":1,"result":{}}\n',
    'data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n',
  ]) await assert.rejects(remote('tools/call', {}, async () => response(Buffer.from(wire)), token), /Invalid Vortex MCP response/);
});

test('SSE refuses malformed UTF-8 even when split between data fragments', async () => {
  const bytes = Buffer.concat([Buffer.from('data: {"jsonrpc":"2.0","id":1,"result":{"name":"'),
    Buffer.from([0xc3, 0x28]), Buffer.from('"}}\r\r')]);
  await assert.rejects(remote('tools/call', {}, async () => response(bytes), token), /Invalid Vortex MCP response/);
});
