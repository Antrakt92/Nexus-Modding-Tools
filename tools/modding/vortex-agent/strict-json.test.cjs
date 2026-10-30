'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {parseStrictJSON} = require('./strict-json.cjs');
const parse = (text, options) => parseStrictJSON(Buffer.from(text), options);

test('strict JSON accepts ordinary whitespace, CRLF, escapes and independent nested keys', () => {
  const input = ' {\r\n "key": {"x":1}, "rows":[{"x":2},{"x":3}], "text":"colon:,\\\"", "unicode":"\\u0430" } \n';
  assert.deepEqual(parse(input), JSON.parse(input));
  assert.deepEqual(parse('{"value":null,"false":false,"true":true,"n":-1.25e2}'),
    {value: null, false: false, true: true, n: -125});
});

test('strict JSON rejects decoded duplicate keys at every object depth', () => {
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}',
    '{"rows":[{"archive":"one","archive":"two"}]}', '{"x":{},"x":[]}',
    '{"__proto__":1,"__proto__":2}'])
    assert.throws(() => parse(input), /STRICT_JSON_DUPLICATE_KEY/);
});

test('prototype-looking keys remain data without prototype mutation', () => {
  const value = parse('{"__proto__":{"own":1},"constructor":"data"}');
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal({}.own, undefined);
});

test('malformed grammar, controls, nonfinite numbers and trailing JSON are rejected', () => {
  for (const input of ['', '{', '[}', '{"x" 1}', '{x:1}', '{"x":1,}', '[1,]',
    '{"x":01}', '[1][2]', 'NaN', '1e9999', '"raw\nline"', '{"x":"\\q"}', '\u00a0{}'])
    assert.throws(() => parse(input), /STRICT_JSON_INVALID/);
  assert.throws(() => parseStrictJSON(Buffer.from([0xc3, 0x28])), /STRICT_JSON_INVALID/);
});

test('byte, nesting and token budgets fail before accepting oversized documents', () => {
  assert.deepEqual(parse('{}', {maxBytes: 2, maxDepth: 1, maxTokens: 2}), {});
  assert.throws(() => parse('{} ', {maxBytes: 2}), /STRICT_JSON_LIMIT/);
  assert.throws(() => parse('[[[]]]', {maxDepth: 2}), /STRICT_JSON_LIMIT/);
  assert.throws(() => parse('[1,2]', {maxTokens: 4}), /STRICT_JSON_LIMIT/);
  for (const options of [{maxBytes: Infinity}, {maxDepth: 0}, {unknown: true}])
    assert.throws(() => parse('{}', options), /STRICT_JSON_/);
});
