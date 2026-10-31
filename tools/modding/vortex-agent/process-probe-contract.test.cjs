'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('./process-probe-contract.cjs');
const {validateRequest, parseRequest, validateReply, parseReply, CONTRACT, LIMITS} = contract;
const id = '0123456789abcdef'.repeat(2);
const request = () => ({version: 1, requestId: id});
const reply = names => ({schema: CONTRACT.schema, requestId: id, backend: 'toolhelp32w',
  nameKind: 'executable-basename', complete: true, count: names.length, names, effectsAllowed: false});
const bytes = value => Buffer.from(JSON.stringify(value));

test('request is closed synchronous data, detached and frozen without arbitrary capabilities', () => {
  const input = request(), checked = validateRequest(input);
  assert.equal(checked.version, 1); assert.equal(checked.requestId, id);
  assert.equal(Object.getPrototypeOf(checked), null); assert(Object.isFrozen(checked));
  assert.equal(Object.hasOwn(checked, 'then'), false);
  input.requestId = 'f'.repeat(32); assert.equal(checked.requestId, id);
  assert.equal(parseRequest(bytes(request())).requestId, id);
  for (const extra of ['args', 'paths', 'env', 'pid', 'operation', 'schema', 'metrics', 'then', '__proto__']) {
    const value = request(); Object.defineProperty(value, extra, {enumerable: true, value: null});
    assert.throws(() => validateRequest(value), /PROCESS_PROBE_INVALID_REQUEST/);
  }
  for (const value of [undefined, null, [], true, Promise.resolve(request()), {version: '1', requestId: id},
    {version: 2, requestId: id}, {Version: 1, requestId: id}, {version: 1, requestID: id}])
    assert.throws(() => validateRequest(value), /PROCESS_PROBE_INVALID_REQUEST/);
});

test('IDs have one exact spelling and replies are bound to the caller request', () => {
  for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), id + '\n', 'g'.repeat(32), 123, null]) {
    assert.throws(() => validateRequest({version: 1, requestId: value}), /PROCESS_PROBE_INVALID_REQUEST/);
    assert.throws(() => validateReply(reply(['Own.exe']), value), /PROCESS_PROBE_INVALID_REQUEST_ID/);
    const input = reply(['Own.exe']); input.requestId = value;
    assert.throws(() => validateReply(input, id), /PROCESS_PROBE_INVALID_REPLY/);
  }
  const wrong = reply(['Own.exe']); wrong.requestId = 'f'.repeat(32);
  assert.throws(() => validateReply(wrong, id), /PROCESS_PROBE_REQUEST_MISMATCH/);
  assert.throws(() => parseReply(bytes(wrong), id), /PROCESS_PROBE_REQUEST_MISMATCH/);
});

test('reply preserves basename spelling, extension, duplicates and Unicode without inferring stopped', () => {
  const names = ['Own.exe', 'Own.exe', 'OWN.EXE', 'Own.exe.exe', 'Own', '[System Process]',
    'more-than-fifteen-characters.exe', '\u0418\u0433\u0440\u0430.exe', '\ud83d\ude00.exe'];
  const input = reply(names), checked = parseReply(bytes(input), id);
  assert.deepEqual([...checked.names], names);
  assert.equal(checked.count, names.length); assert.equal(checked.effectsAllowed, false);
  assert.equal(Object.hasOwn(checked, 'gameStopped'), false);
  assert.equal(Object.hasOwn(checked, 'lease'), false);
  assert.equal(Object.getPrototypeOf(checked), null);
  assert(Object.isFrozen(checked)); assert(Object.isFrozen(checked.names));
  names[0] = 'changed.exe'; input.complete = false;
  assert.equal(checked.names[0], 'Own.exe'); assert.equal(checked.complete, true);
  assert.throws(() => {checked.names.push('extra.exe');}, TypeError);
  assert.equal(validateReply(reply(['x'.repeat(260)]), id).names[0].length, 260);
  assert.equal(validateReply(reply(['\ud83d\ude00'.repeat(130)]), id).names[0].length, 260);
});

test('every producer claim and field is exact; partial and extra-capability envelopes are rejected', () => {
  for (const [field, values] of Object.entries({schema: [1, 'native-process-snapshot/2'], backend: ['powershell', 'Toolhelp32W'],
    nameKind: ['processname', 'path'], complete: [false, 1, 'true'], effectsAllowed: [true, 0, null],
    count: [0, -1, 1.5, '1', true, LIMITS.count + 1, NaN, Infinity]})) {
    for (const value of values) {
      const input = reply(['Own.exe']); input[field] = value;
      assert.throws(() => validateReply(input, id), /PROCESS_PROBE_INVALID_REPLY/);
    }
  }
  for (const key of Object.keys(reply(['Own.exe']))) {
    const missing = reply(['Own.exe']); delete missing[key];
    assert.throws(() => validateReply(missing, id), /PROCESS_PROBE_INVALID_REPLY/);
  }
  for (const key of ['timing', 'pid', 'exitCode', 'stderr', 'eof', 'gameStopped', 'leaseId', 'then']) {
    const input = reply(['Own.exe']); input[key] = key === 'then' ? () => {} : false;
    assert.throws(() => validateReply(input, id), /PROCESS_PROBE_INVALID_REPLY/);
  }
});

test('names reject controls, path separators, empty or oversized strings and unpaired UTF-16', () => {
  for (const value of ['', 'a'.repeat(261), 'C:\\Own.exe', 'root/Own.exe', 'nul\x00.exe', 'line\n.exe',
    'del\x7f.exe', 'c1\x85.exe', '\ud800', '\udc00', 'x\ud800z', '\ud800\ud800', '\udc00\ud800',
    '\ud83d\ude00\udc00', 1, {}, null])
    assert.throws(() => validateReply(reply([value]), id), /PROCESS_PROBE_INVALID_NAME/);
});

test('array count, density and ownership are checked without invoking caller code', () => {
  let invoked = 0;
  const sparse = reply(Array(1));
  assert.throws(() => validateReply(sparse, id), /PROCESS_PROBE_INVALID_NAMES/);
  const count = reply(['Own.exe']); count.count = 2;
  assert.throws(() => validateReply(count, id), /PROCESS_PROBE_INVALID_NAMES/);
  for (const decorate of [names => {names.extra = true;}, names => {names[Symbol('hidden')] = 1;},
    names => {Object.defineProperty(names, '0', {get() {invoked++; throw Error('GETTER');}});},
    names => {Object.defineProperty(names, '0', {value: 'Own.exe', enumerable: false});},
    names => {Object.setPrototypeOf(names, null);}]) {
    const input = reply(['Own.exe']); decorate(input.names);
    assert.throws(() => validateReply(input, id), /PROCESS_PROBE_INVALID_NAMES/);
  }
  const proxy = new Proxy(['Own.exe'], {get() {invoked++; throw Error('TRAP');}, ownKeys() {invoked++; throw Error('TRAP');}});
  const proxied = reply(['Own.exe']); proxied.names = proxy;
  assert.throws(() => validateReply(proxied, id), /PROCESS_PROBE_INVALID_NAMES/);
  const revocable = Proxy.revocable([], {}); revocable.revoke();
  const revoked = reply(['Own.exe']); revoked.names = revocable.proxy;
  assert.throws(() => validateReply(revoked, id), /PROCESS_PROBE_INVALID_NAMES/);
  assert.equal(invoked, 0);
});

test('object accessors, proxies, custom prototypes, symbols and hidden fields never execute', () => {
  let invoked = 0;
  for (const [validate, factory] of [[validateRequest, request], [value => validateReply(value, id), () => reply(['Own.exe'])]]) {
    const accessor = factory(), key = Object.keys(accessor)[0];
    Object.defineProperty(accessor, key, {enumerable: true, get() {invoked++; throw Error('GETTER');}});
    assert.throws(() => validate(accessor), /PROCESS_PROBE_INVALID_/);
    const proxy = new Proxy(factory(), {getPrototypeOf() {invoked++; throw Error('TRAP');}});
    assert.throws(() => validate(proxy), /PROCESS_PROBE_INVALID_/);
    const custom = Object.assign(Object.create({then() {invoked++;}}), factory());
    assert.throws(() => validate(custom), /PROCESS_PROBE_INVALID_/);
    for (const decorate of [v => {v[Symbol('hidden')] = 1;}, v => {Object.defineProperty(v, 'hidden', {value: 1});}]) {
      const input = factory(); decorate(input); assert.throws(() => validate(input), /PROCESS_PROBE_INVALID_/);
    }
  }
  assert.equal(invoked, 0);
  const input = Object.assign(Object.create(null), request());
  assert.equal(validateRequest(input).requestId, id);
});

test('byte parsing rejects duplicate decoded keys, malformed UTF-8, truncation and extra documents', () => {
  const valid = JSON.stringify(reply(['Own.exe']));
  const bad = [valid.slice(0, -1), valid + '{}', valid + 'LOG',
    valid.replace('"count":1', '"count":1,"count":1'),
    valid.replace('"count":1', '"count":1,"\\u0063ount":1'),
    valid.replace('"names":[', '"names":[],"names":[')];
  for (const value of bad) assert.throws(() => parseReply(Buffer.from(value), id), /PROCESS_PROBE_INVALID_JSON/);
  assert.throws(() => parseRequest(Buffer.from('{"version":1,"\\u0076ersion":1,"requestId":"' + id + '"}')),
    /PROCESS_PROBE_INVALID_JSON/);
  for (const data of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
    assert.throws(() => parseReply(data, id), /PROCESS_PROBE_INVALID_JSON/);
    assert.throws(() => parseRequest(data), /PROCESS_PROBE_INVALID_JSON/);
  }
  assert.throws(() => parseReply(Buffer.from(valid.replace('Own.exe', '\\ud800')), id), /PROCESS_PROBE_INVALID_NAME/);
  assert.equal(parseReply(new Uint8Array(Buffer.from(valid)), id).count, 1);
});

test('message budgets include actual escaped UTF-8 bytes and refuse huge arrays before traversal', () => {
  assert.throws(() => parseRequest(Buffer.alloc(LIMITS.requestBytes + 1)), /PROCESS_PROBE_MESSAGE_LIMIT/);
  assert.throws(() => parseReply(Buffer.alloc(LIMITS.responseBytes + 1), id), /PROCESS_PROBE_MESSAGE_LIMIT/);
  assert.throws(() => validateReply(reply(Array(LIMITS.count + 1)), id), /PROCESS_PROBE_INVALID_REPLY/);
  const max = validateReply(reply(Array(LIMITS.count).fill('x')), id);
  assert.equal(max.count, LIMITS.count); assert.equal(max.names.length, LIMITS.count);
  assert.equal(parseReply(bytes(max), id).count, LIMITS.count);
  const tooLarge = reply(Array(2100).fill('\ud83d\ude00'.repeat(130)));
  assert.throws(() => validateReply(tooLarge, id), /PROCESS_PROBE_MESSAGE_LIMIT/);
  const manyEscapes = reply(Array(5000).fill('"'.repeat(260)));
  assert.throws(() => validateReply(manyEscapes, id), /PROCESS_PROBE_MESSAGE_LIMIT/);
});

test('process wire format rejects a UTF-8 BOM for requests and replies without changing name data', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.throws(() => parseRequest(Buffer.concat([bom, bytes(request())])), /PROCESS_PROBE_INVALID_JSON/);
  assert.throws(() => parseReply(Buffer.concat([bom, bytes(reply(['Own.exe']))]), id), /PROCESS_PROBE_INVALID_JSON/);
  const name = 'Own\ufeff.exe';
  assert.equal(parseReply(bytes(reply([name])), id).names[0], name);
});

test('buffer-like objects and byte accessors are rejected without invoking getters', () => {
  let invoked = 0;
  const raw = bytes(request());
  Object.defineProperty(raw, 'byteLength', {get() {invoked++; throw Error('GETTER');}});
  assert.throws(() => parseRequest(raw), /PROCESS_PROBE_INVALID_JSON/);
  const proxy = new Proxy(bytes(request()), {get() {invoked++; throw Error('TRAP');}});
  assert.throws(() => parseRequest(proxy), /PROCESS_PROBE_INVALID_JSON/);
  assert.throws(() => parseRequest({byteLength: 0}), /PROCESS_PROBE_INVALID_JSON/);
  assert.throws(() => parseRequest(Object.create(Uint8Array.prototype)), /PROCESS_PROBE_INVALID_JSON/);
  assert.throws(() => parseRequest(JSON.stringify(request())), /PROCESS_PROBE_INVALID_JSON/);
  assert.equal(invoked, 0);
});
