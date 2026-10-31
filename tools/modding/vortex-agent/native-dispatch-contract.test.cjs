'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {installPlanId} = require('./install-job-contract.cjs');
const {CONTRACT_ID, LIMITS, parseDispatchRequest, dispatchRequestDigest, createConsumedRegistry} = require('./native-dispatch-contract.cjs');
const h = 'a'.repeat(64);
const encode = value => Buffer.from(JSON.stringify(value));
const hex = n => n.toString(16).padStart(32, '0');
const lifetime = () => ({managerScope: 'manager-fixture_nonce-1', rendererGeneration: 'renderer_' + hex(1)});
function request(n = 1) {
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: 'own-install-job-model/1',
    context: {gameId: 'cyberpunk2077', profileId: 'fixture-profile', gamePath: 'F:/Fixture/Game',
      stagingPath: 'F:/Fixture/Stage', downloadPath: 'D:/Fixture/Downloads',
      filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked_1', fileName: 'Own Fixture.zip', expectedModId: 'Own Fixture', expectedType: '',
      bytes: 200, sha256: h, md5: 'b'.repeat(32), expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
  return {schema: 'native-dispatch-request/1', contractId: CONTRACT_ID, operationId: 'op_' + hex(n),
    nativeJobId: 'exec_' + hex(n), planId: installPlanId(plan), ...lifetime(), admissionSHA256: 'c'.repeat(64), plan};
}
const registry = () => createConsumedRegistry(encode(lifetime()));
test('closed request binds complete plan and is detached, frozen and semantic', () => {
  const input = request(), bytes = encode(input), checked = parseDispatchRequest(bytes);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.plan.package = Object.fromEntries(Object.entries(input.plan.package).reverse());
  assert.equal(dispatchRequestDigest(bytes), dispatchRequestDigest(encode(reordered)));
  bytes.fill(0); assert.equal(checked.plan.package.sha256, h);
  assert(Object.isFrozen(checked.plan.package.payload)); assert(Object.isFrozen(checked));
  assert.throws(() => {checked.plan.options.enabled = true;}, TypeError);
});
test('every envelope binding and full plan contents contribute to request digest', () => {
  const first = dispatchRequestDigest(encode(request()));
  for (const mutate of [r => {r.operationId = 'op_' + hex(2);}, r => {r.nativeJobId = 'exec_' + hex(2);},
    r => {r.managerScope = 'manager-other-2';}, r => {r.rendererGeneration = 'renderer_' + hex(2);},
    r => {r.admissionSHA256 = 'd'.repeat(64);}, r => {r.plan.context.profileId = 'another';},
    r => {r.plan.package.payload['r6/scripts/own.reds'] = 'e'.repeat(64);},
    r => {r.plan.evidence.nativeAdmissionSHA256 = 'f'.repeat(64);}]) {
    const r = request(); mutate(r); r.planId = installPlanId(r.plan);
    assert.notEqual(dispatchRequestDigest(encode(r)), first);
  }
});
test('reject unsupported schemas, fields, IDs and mismatched plans before consumption', () => {
  const reg = registry();
  for (const mutate of [r => {r.schema = 'legacy';}, r => {r.contractId = 'other';}, r => {r.extra = true;},
    r => {r.operationId = 'arbitrary';}, r => {r.nativeJobId = 'manager-legacy-native-1';},
    r => {r.rendererGeneration = 'pid_123';}, r => {r.managerScope = 'manager-a-0';},
    r => {r.managerScope = 'manager-a-01';}, r => {r.managerScope = 'manager-a-9007199254740992';},
    r => {r.admissionSHA256 = '';}, r => {r.planId = '0'.repeat(64);},
    r => {r.plan.package.downloadId = 'changed';}, r => {r.plan.options.deploy = true;}]) {
    const r = request(); mutate(r); assert.throws(() => reg.consume(encode(r)), /NATIVE_DISPATCH_|INSTALL_JOB_/);
  }
  assert.equal(reg.inspect(encode(request())).modelConsumed, false);
  assert.equal(reg.consume(encode(request())).modelConsumed, true);
});
test('only bounded strict JSON bytes are accepted; decoded duplicate keys and malformed UTF8 refuse', () => {
  for (const bytes of [Buffer.from('{"x":1,"\\u0078":2}'), Buffer.from([255]), Buffer.from('{'),
    Buffer.from('[]'), Buffer.from('null'), Buffer.alloc(LIMITS.bytes + 1, 32), request(), 'text']) {
    assert.throws(() => parseDispatchRequest(bytes), /NATIVE_DISPATCH_/);
  }
  const bytes = encode(request());
  const padded = Buffer.concat([bytes, Buffer.alloc(LIMITS.bytes - bytes.length, 32)]);
  assert.equal(parseDispatchRequest(padded).nativeJobId, request().nativeJobId);
  assert.throws(() => parseDispatchRequest(Buffer.concat([padded, Buffer.from(' ')])), /INVALID_JSON/);
  assert.throws(() => parseDispatchRequest(Buffer.from('['.repeat(LIMITS.depth + 1) + ']'.repeat(LIMITS.depth + 1))), /INVALID_JSON/);
  assert.throws(() => parseDispatchRequest(Buffer.from('[' + '0,'.repeat(LIMITS.tokens) + '0]')), /INVALID_JSON/);
});
test('byte boundary invokes no accessors or proxy traps and refuses shared buffers', () => {
  let called = 0;
  const bytes = encode(request());
  Object.defineProperty(bytes, 'byteLength', {get() {called++; throw Error('getter');}});
  Object.defineProperty(bytes, 'buffer', {get() {called++; throw Error('getter');}});
  assert.equal(parseDispatchRequest(bytes).nativeJobId, request().nativeJobId);
  const proxy = new Proxy(bytes, {getPrototypeOf() {called++; throw Error('trap');}, get() {called++; throw Error('trap');}});
  assert.throws(() => parseDispatchRequest(proxy), /INVALID_JSON/);
  assert.throws(() => parseDispatchRequest(new Uint8Array(new SharedArrayBuffer(20))), /INVALID_JSON/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => parseDispatchRequest(cyclic), /INVALID_JSON/);
  assert.equal(called, 0);
});
test('lifetime constructor is closed and wrong generation or manager consumes nothing', () => {
  for (const value of [{}, {...lifetime(), extra: true}, {...lifetime(), rendererGeneration: '123'},
    {...lifetime(), managerScope: 'manager-a-9007199254740992'}]) {
    assert.throws(() => createConsumedRegistry(encode(value)), /INVALID_LIFETIME/);
  }
  const reg = registry();
  for (const mutate of [r => {r.managerScope = 'manager-other-2';}, r => {r.rendererGeneration = 'renderer_' + hex(2);}]) {
    const r = request(); mutate(r); assert.throws(() => reg.consume(encode(r)), /LIFETIME_MISMATCH/);
    assert.throws(() => reg.inspect(encode(r)), /LIFETIME_MISMATCH/);
  }
  assert.equal(reg.inspect(encode(request())).modelConsumed, false);
});
test('lifetime bytes are copied and scope bounds preserve the diagnostic format', () => {
  const life = {...lifetime(), managerScope: 'manager-' + 'x'.repeat(64) + '-9007199254740991'};
  const bytes = encode(life), reg = createConsumedRegistry(bytes); bytes.fill(0);
  const r = {...request(), ...life};
  assert.equal(reg.consume(encode(r)).modelConsumed, true);
  const tooLong = {...r, managerScope: 'manager-' + 'x'.repeat(65) + '-1'};
  assert.throws(() => parseDispatchRequest(encode(tooLong)), /INVALID_REQUEST/);
  assert.throws(() => createConsumedRegistry(Buffer.alloc(1025, 32)), /INVALID_JSON/);
});
test('nonzero byte offsets and typed-array subclasses cannot redirect snapshot reads', () => {
  let called = 0;
  class Bytes extends Uint8Array {
    get byteLength() {called++; throw Error('getter');}
    get buffer() {called++; throw Error('getter');}
    get length() {called++; throw Error('getter');}
  }
  const raw = encode(request()), storage = new Uint8Array(raw.length + 20);
  storage.set(raw, 10);
  const view = new Bytes(storage.buffer, 10, raw.length);
  assert.equal(parseDispatchRequest(view).nativeJobId, request().nativeJobId);
  assert.equal(called, 0);
});
test('maximum payload count remains bound to the complete envelope and plan budgets', () => {
  const r = request(); r.plan.package.payload = {};
  for (let n = 0; n < 4096; n++) r.plan.package.payload['r6/scripts/' + 'x'.repeat(150) + n + '.reds'] = h;
  r.planId = installPlanId(r.plan);
  assert.equal(Object.keys(parseDispatchRequest(encode(r)).plan.package.payload).length, 4096);
  const extra = structuredClone(r); extra.plan.package.payload['r6/scripts/extra.reds'] = h;
  assert.throws(() => parseDispatchRequest(encode(extra)), /INSTALL_JOB_PAYLOAD_LIMIT/);
  const huge = request(); huge.plan.package.payload = {};
  for (let n = 0; n < 4096; n++) huge.plan.package.payload['r6/scripts/' + 'x'.repeat(450) + n + '.reds'] = h;
  assert.throws(() => parseDispatchRequest(encode(huge)), /INVALID_JSON/);
});
test('consume is synchronous, one-shot and never becomes a permit', async () => {
  const reg = registry(), bytes = encode(request());
  const before = reg.inspect(bytes); assert.equal(before.modelConsumed, false);
  const first = reg.consume(bytes);
  assert.equal(first.effectsAllowed, false); assert.equal(first.modelConsumed, true);
  assert.equal(first.then, undefined); assert(Object.isFrozen(first));
  assert.equal(reg.inspect(bytes).modelConsumed, true);
  assert.equal(before.modelConsumed, false);
  assert.throws(() => reg.consume(bytes), /ALREADY_CONSUMED/);
  const results = await Promise.allSettled([Promise.resolve().then(() => reg.consume(encode(request(2)))),
    Promise.resolve().then(() => reg.consume(encode(request(2))))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /ALREADY_CONSUMED/);
});
test('both operation and job IDs exclude changed bindings, without disclosing status', () => {
  const reg = registry(); reg.consume(encode(request()));
  for (const mutate of [r => {r.operationId = 'op_' + hex(2);}, r => {r.admissionSHA256 = 'e'.repeat(64);},
    r => {r.plan.context.profileId = 'changed'; r.planId = installPlanId(r.plan);}]) {
    const r = request(); mutate(r);
    assert.throws(() => reg.consume(encode(r)), /DESCRIPTOR_MISMATCH/);
    assert.throws(() => reg.inspect(encode(r)), /DESCRIPTOR_MISMATCH/);
  }
  const changedJob = request(); changedJob.nativeJobId = 'exec_' + hex(2);
  assert.throws(() => reg.consume(encode(changedJob)), /OPERATION_REUSED/);
  assert.throws(() => reg.inspect(encode(changedJob)), /OPERATION_REUSED/);
  assert.equal(reg.consume(encode(request(2))).modelConsumed, true);
});
test('hard capacity never evicts, preserves exact status and distinguishes replay', () => {
  const reg = registry();
  for (let n = 1; n <= LIMITS.consumed; n++) reg.consume(encode(request(n)));
  assert.throws(() => reg.consume(encode(request(LIMITS.consumed + 1))), /CAPACITY/);
  assert.equal(reg.inspect(encode(request(1))).modelConsumed, true);
  assert.equal(reg.inspect(encode(request(LIMITS.consumed))).modelConsumed, true);
  assert.equal(reg.inspect(encode(request(LIMITS.consumed + 1))).modelConsumed, false);
  assert.throws(() => reg.consume(encode(request(1))), /ALREADY_CONSUMED/);
  const altered = request(); altered.admissionSHA256 = 'e'.repeat(64);
  assert.throws(() => reg.consume(encode(altered)), /DESCRIPTOR_MISMATCH/);
});
test('lost reply and caller cancellation cannot clear consumption; generations remain separate models', () => {
  const reg = registry(), bytes = encode(request());
  // Simulate a lost acknowledgement after insertion. No response can authorize replay.
  reg.consume(bytes);
  assert.deepEqual(Object.keys(reg).sort(), ['consume', 'inspect']);
  assert(Object.isFrozen(reg));
  assert.throws(() => reg.consume(bytes), /ALREADY_CONSUMED/);
  assert.equal(reg.inspect(bytes).effectsAllowed, false);
  const nextLife = {...lifetime(), rendererGeneration: 'renderer_' + hex(2)};
  const next = createConsumedRegistry(encode(nextLife));
  assert.throws(() => next.consume(bytes), /LIFETIME_MISMATCH/);
  const changed = {...request(), ...nextLife};
  // A fresh model has no durable history. Its result still grants no effects.
  assert.equal(next.consume(encode(changed)).effectsAllowed, false);
});
