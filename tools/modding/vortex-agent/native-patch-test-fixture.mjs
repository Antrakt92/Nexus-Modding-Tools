import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// Deliberately strict, single-file unified diff reader. No subprocess, fuzz,
// filesystem output or relaxed input fingerprint is involved in applying it.
export function hunks(diff, file) {
  const lines = diff.split('\n');
  assert.equal(lines.pop(), '', 'patch must end with LF');
  assert.equal(lines.shift(), `--- a/${file}`);
  assert.equal(lines.shift(), `+++ b/${file}`);
  const result = [];
  while (lines.length) {
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines.shift());
    assert.ok(match, 'exact unified hunk header required');
    const [oldStart, oldCount, newStart, newCount] = match.slice(1).map(Number);
    const body = [];
    while (lines.length && !lines[0].startsWith('@@ ')) {
      const line = lines.shift();
      assert.ok(/^[ +\-]/.test(line), 'invalid hunk line');
      body.push(line);
    }
    assert.equal(body.filter(line => line[0] !== '+').length, oldCount);
    assert.equal(body.filter(line => line[0] !== '-').length, newCount);
    result.push({ oldStart, oldCount, newStart, newCount, body });
  }
  assert.ok(result.length);
  return result;
}

export function applyExact(source, diff, file) {
  const input = source.split('\n');
  assert.equal(input.pop(), '', 'input must end with LF');
  const output = [];
  let cursor = 0;
  for (const hunk of hunks(diff, file)) {
    const start = hunk.oldStart - 1;
    assert.ok(start >= cursor && start <= input.length, 'overlap or range');
    output.push(...input.slice(cursor, start));
    cursor = start;
    assert.equal(output.length, hunk.newStart - 1, 'new offset');
    for (const line of hunk.body) {
      if (line[0] !== '+') assert.equal(input[cursor++], line.slice(1), 'exact hunk context');
      if (line[0] !== '-') output.push(line.slice(1));
    }
  }
  output.push(...input.slice(cursor));
  return output.join('\n') + '\n';
}

export function extractClassDeclaration(source) {
  const stripped = stripTypeScriptTypes(source, { mode: 'transform' });
  const start = stripped.indexOf('class InstallManager {');
  const end = stripped.lastIndexOf('export default InstallManager;');
  assert.ok(start >= 0 && end > start);
  return stripped.slice(start, end);
}
