import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import contract from './process-probe-contract.cjs';
import pe from './process-probe-pe.cjs';

const binary = process.env.VORTEX_PROCESS_PROBE_BINARY;
const pin = process.env.VORTEX_PROCESS_PROBE_SHA256;
const native = (name, fn) => test(name, {timeout: 15000, skip: binary && pin ? false :
  'Set VORTEX_PROCESS_PROBE_BINARY and VORTEX_PROCESS_PROBE_SHA256 to the reviewed local build'}, fn);
function invoke(input, args = []) {
  assert.equal(process.platform, 'win32');
  assert(path.isAbsolute(binary)); assert.match(pin, /^[a-f0-9]{64}$/);
  const before = fs.lstatSync(binary, {bigint: true});
  assert(before.isFile() && !before.isSymbolicLink() && before.size <= 32n * 1024n * 1024n);
  const bytes = fs.readFileSync(binary);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin);
  const imports = pe.inspectProcessProbePE(bytes);
  assert.equal(imports.machine, 'amd64'); assert.equal(imports.format, 'PE32+');
  if (process.env.VORTEX_PROCESS_PROBE_EXPECT_STATIC_CRT === '1') {
    assert.equal(imports.delayImportsPresent, false);
    assert.equal(imports.systemImportsOnly, true, 'static recipe must retain only reviewed declared OS imports');
  }
  const result = spawnSync(binary, args, {input, encoding: 'buffer', timeout: 10000,
    maxBuffer: contract.LIMITS.responseBytes, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  assert.ifError(result.error); assert.equal(result.signal, null);
  const after = fs.lstatSync(binary, {bigint: true});
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) assert.equal(after[key], before[key]);
  return result;
}

native('reviewed native executable returns a bound complete snapshot accepted by the independent JS contract', () => {
  for (let i = 0; i < 3; i++) {
    const requestId = randomBytes(16).toString('hex');
    const result = invoke(Buffer.from(JSON.stringify({version: 1, requestId})));
    assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
    const reply = contract.parseReply(result.stdout, requestId);
    assert.equal(reply.effectsAllowed, false);
    assert(reply.names.some(name => name.toLowerCase() === path.basename(binary).toLowerCase()), 'snapshot includes its own helper');
    assert(reply.names.some(name => name.toLowerCase() === path.basename(process.execPath).toLowerCase()), 'snapshot includes caller');
    assert.throws(() => contract.parseReply(result.stdout, 'f'.repeat(32)), /MISMATCH/);
  }
});

native('native request failures emit no partial success or private diagnostic data', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const inputs = [Buffer.from('{}'), Buffer.from('[]'), Buffer.from([255]),
    Buffer.from(`{"version":1,"version":1,"requestId":"${id}"}`),
    Buffer.from(`{"version":1,"requestId":"${id}","private":"DO_NOT_ECHO_THIS"}`),
    Buffer.from(`{"version":1,"requestId":"${id}"} {}`),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({version: 1, requestId: id}))]),
    Buffer.alloc(contract.LIMITS.requestBytes + 1, 32)];
  for (const input of inputs) {
    const result = invoke(input);
    assert.equal(result.status, 1); assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.toString('utf8'), /^NATIVE_PROCESS_PROBE_[A-Z_]+\r?\n$/);
    assert(!result.stderr.includes(Buffer.from('DO_NOT_ECHO_THIS')));
  }
  const result = invoke(Buffer.from(JSON.stringify({version: 1, requestId: id})), ['--command']);
  assert.equal(result.status, 1); assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.toString('utf8'), /^NATIVE_PROCESS_PROBE_ARGUMENTS_REFUSED\r?\n$/);
});
