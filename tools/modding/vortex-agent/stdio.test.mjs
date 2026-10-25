import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import * as bridge from './bridge.mjs';

test('stdio stops consuming requests while the client is not reading answers', async () => {
  const output = new PassThrough({ highWaterMark: 32 });
  let consumed = 0;
  async function* input() {
    for (let id = 0; id < 40; id++) {
      consumed++;
      yield Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
    }
  }
  const work = bridge.runStdio(input(), output, async request => ({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(4096) }), 4);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(consumed <= 4, `consumed ${consumed} requests with a blocked output`);
  let text = '';
  output.on('data', chunk => { text += chunk; });
  await work;
  assert.equal(text.trim().split('\n').map(JSON.parse).length, 40);
});

test('stdio parse errors also wait for output and a broken output rejects cleanly', async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  let consumed = 0;
  async function* input() { for (let i = 0; i < 20; i++) { consumed++; yield Buffer.from('bad-json\n'); } }
  const work = bridge.runStdio(input(), output, async () => assert.fail('invalid input dispatched'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(consumed, 1);
  output.resume();
  await work;
  const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('synthetic pipe failure')); } });
  await assert.rejects(bridge.runStdio([Buffer.from('bad-json\n')], broken, async () => ({})), /synthetic pipe failure/);
});
