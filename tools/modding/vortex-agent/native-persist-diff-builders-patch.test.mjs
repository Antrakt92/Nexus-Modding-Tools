import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {applyExact} from './native-patch-test-fixture.mjs';

const folder = new URL('./native-patches/vortex-tests-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('persist-diff-builders.json', folder)));
const patch = readFileSync(new URL('persist-diff-builders.patch', folder), 'utf8');
const testFile = process.env.VORTEX_NATIVE_PERSIST_DIFF_TEST_SOURCE;
const buildersFile = process.env.VORTEX_NATIVE_TEST_BUILDERS_SOURCE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['makeReference', 'makeRule', 'makeMod', 'makeDownload'];
const marker = 'type S = Record<string, unknown>;';
const integration = (name, fn) => test(name, {timeout: 5000,
  skip: testFile && buildersFile ? false : 'Provide exact original test/builders through VORTEX_NATIVE_PERSIST_DIFF_TEST_SOURCE and VORTEX_NATIVE_TEST_BUILDERS_SOURCE'}, fn);
function declaration(source, name, exported) {
  const startToken = `${exported ? 'export ' : ''}function ${name}(`;
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, name);
  assert.equal(source.indexOf(startToken, start + 1), -1, `${name} must be unique`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start);
  return source.slice(start, end + 3);
}
function inputs() {
  const original = readFileSync(testFile, 'utf8');
  const builders = readFileSync(buildersFile, 'utf8');
  // Independent official source pins, not only a self-consistent patch manifest.
  assert.equal(sha(original), 'f55a95cd5af7ae0c61a37a8c41dadfb96e5241e12953882015a6e9c3ced571ab');
  assert.equal(sha(builders), '44728402d6c7e3a203e450f509db4afbd067b88de2cb653dc33c820cdbc5a13a');
  assert.equal(sha(original), manifest.inputSHA256);
  assert.equal(sha(builders), manifest.buildersSource.sha256);
  assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(original)}\0`).update(original).digest('hex'), manifest.upstreamGitBlob);
  const output = applyExact(original, patch, manifest.upstreamPath);
  assert.equal(sha(output), manifest.outputSHA256);
  return {original, builders, output};
}

test('builders adapter is pinned test-only source with no runtime or native authority', () => {
  assert.equal(sha(patch), manifest.patchSHA256);
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/renderer/src/store/persistDiffMiddleware.test.ts');
  assert.equal(manifest.buildersSource.upstreamPath, 'src/renderer/src/test-utils/builders.ts');
  assert.equal(manifest.testOnly, true); assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'installationPermit']) assert.equal(manifest[key], false);
  assert.deepEqual(Object.keys(manifest.factoryPins), names);
});

integration('every test body, assertion and fixture after the imports is byte-identical', () => {
  const {original, output} = inputs();
  const before = original.slice(original.indexOf(marker));
  const after = output.slice(output.indexOf(marker));
  assert.equal(sha(before), manifest.preservedTestSuffixSHA256);
  assert.ok(Buffer.from(before).equals(Buffer.from(after)), 'all original test code must remain byte-identical');
});

integration('four complete local factory declarations preserve exact official bodies, removing export only', () => {
  const {builders, output} = inputs();
  for (const name of names) {
    const original = declaration(builders, name, true);
    const local = declaration(output, name, false);
    const body = original.slice(original.indexOf(' {\n') + 1);
    assert.equal(sha(original), manifest.factoryPins[name].declarationSHA256);
    assert.equal(sha(body), manifest.factoryPins[name].bodySHA256);
    assert.equal(sha(local), manifest.factoryPins[name].localDeclarationSHA256);
    assert.ok(Buffer.from(local).equals(Buffer.from(original.slice('export '.length))), name);
  }
});

integration('adapter changes only the builder import, necessary type imports and four exact declarations', () => {
  const {original, builders, output} = inputs();
  const oldImport = 'import { makeDownload, makeMod, makeReference, makeRule } from "../test-utils/builders";\n';
  assert.equal(original.split(oldImport).length, 2);
  let expected = original.replace(oldImport, '').replace(
    'import type { IModRule } from "../extensions/mod_management/types/IMod";',
    'import type { IMod, IModReference, IModRule } from "../extensions/mod_management/types/IMod";\n'
    + 'import type { IDownload } from "../extensions/download_management/types/IDownload";');
  expected = expected.replace(marker, names.map(name => declaration(builders, name, true).slice('export '.length)).join('\n\n') + '\n\n' + marker);
  assert.ok(Buffer.from(output).equals(Buffer.from(expected)), 'no other source changes are allowed');
  assert.equal(output.includes('from "../test-utils/builders"'), false);
});

integration('copied actual factories retain default allocation and override behavior without importing the native barrel', () => {
  const {builders, output} = inputs();
  for (const name of names) {
    const compile = source => vm.runInNewContext(stripTypeScriptTypes(
      source.replace(/^export /, '') + '\n' + name + ';', {mode: 'transform'}), {}, {timeout: 1000});
    const upstream = compile(declaration(builders, name, true));
    const local = compile(declaration(output, name, false));
    assert.equal(JSON.stringify(local()), JSON.stringify(upstream()), name);
    const attributes = {own: true};
    const overrides = {id: 'own-fixture', attributes, marker: ['own']};
    const a = local(overrides), b = upstream(overrides);
    assert.equal(JSON.stringify(a), JSON.stringify(b), name);
    assert.equal(a.attributes, attributes);
    assert.notEqual(a, overrides); assert.notEqual(local(), local());
    assert.deepEqual(Object.keys(overrides), ['id', 'attributes', 'marker']);
  }
});
