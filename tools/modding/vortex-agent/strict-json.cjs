'use strict';

// Detect duplicate decoded keys before JSON.parse discards them. This accepts
// ordinary JSON formatting; callers still pin the original bytes separately.
function parseStrictJSON(bytes, options = {}) {
  const fail = code => {throw Error(code);};
  if (!(bytes instanceof Uint8Array) || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['maxBytes', 'maxDepth', 'maxTokens'].includes(key)))
    fail('STRICT_JSON_INVALID');
  const {maxBytes = 8 * 1024 * 1024, maxDepth = 32, maxTokens = 200000} = options;
  if (![maxBytes, maxDepth, maxTokens].every(n => Number.isSafeInteger(n) && n > 0)
      || maxBytes > 64 * 1024 * 1024 || maxDepth > 128 || maxTokens > 2000000
      || bytes.byteLength > maxBytes) fail('STRICT_JSON_LIMIT');
  let text;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);}
  catch {fail('STRICT_JSON_INVALID');}
  const token = /[\x20\x09\x0a\x0d]+|"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const stack = []; let at = 0, count = 0;
  while (at < text.length) {
    token.lastIndex = at;
    const found = token.exec(text);
    if (!found) fail('STRICT_JSON_INVALID');
    const value = found[0]; at = token.lastIndex;
    if (/^[\x20\x09\x0a\x0d]/.test(value)) continue;
    if (++count > maxTokens) fail('STRICT_JSON_LIMIT');
    if (value === '{' || value === '[') {
      if (stack.length >= maxDepth) fail('STRICT_JSON_LIMIT');
      stack.push({kind: value, keys: value === '{' ? new Set() : null, wantsKey: true});
    } else if (value === '}' || value === ']') {
      if (stack.pop()?.kind !== (value === '}' ? '{' : '[')) fail('STRICT_JSON_INVALID');
    } else {
      const parent = stack.at(-1);
      if (value === ',' && parent?.kind === '{') parent.wantsKey = true;
      else if (value.startsWith('"') && parent?.kind === '{' && parent.wantsKey) {
        let key;
        try {key = JSON.parse(value);} catch {fail('STRICT_JSON_INVALID');}
        if (parent.keys.has(key)) fail('STRICT_JSON_DUPLICATE_KEY');
        parent.keys.add(key); parent.wantsKey = false;
      } else if (/^[-0-9]/.test(value) && !Number.isFinite(Number(value))) fail('STRICT_JSON_INVALID');
    }
  }
  if (stack.length) fail('STRICT_JSON_INVALID');
  try {return JSON.parse(text);} catch {fail('STRICT_JSON_INVALID');}
}

module.exports = {parseStrictJSON};
