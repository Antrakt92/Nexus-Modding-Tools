import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actionRoot } from './action-context.mjs';
import path from 'node:path';

test('builtin dispatcher survives unchanged official bundle import and services native fetch', () => {
  const transport = fileURLToPath(new URL('../native-transport.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const symbol = Symbol.for('undici.globalDispatcher.1');
    assert.equal(globalThis[symbol], undefined);
    const native = globalThis.fetch;
    const { primeNativeDispatcher } = await import(pathToFileURL(${JSON.stringify(transport)}));
    const dispatcher = await primeNativeDispatcher(native);
    let calls = 0;
    dispatcher.dispatch = (_options, handler) => {
      calls++; queueMicrotask(() => handler.onError(new Error('Modeled transport has no socket fallback'))); return true;
    };
    process.stdout.write = () => true; process.stderr.write = () => true;
    Object.assign(process.env, { INPUT_API_KEY: 'synthetic', INPUT_FILE_ID: '123', INPUT_VERSION: '1.0',
      INPUT_FILENAME: 'synthetic-absent-fixture.zip', INPUT_ARCHIVE_EXISTING_VERSION: 'false' });
    await import(pathToFileURL(${JSON.stringify(path.join(actionRoot, 'dist/index.js'))}));
    assert.equal(globalThis[symbol], dispatcher);
    try { await native('https://fixture.invalid/model'); } catch {}
    assert.equal(calls, 1);
    assert.throws(() => { globalThis[symbol] = {}; });
    process.exitCode = 0; // Modeled bundle deliberately failed before any upload.
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('a preloaded unknown dispatcher is rejected before any fetch', () => {
  const transport = new URL('../native-transport.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis[Symbol.for('undici.globalDispatcher.1')] = { dispatch() {} };
    const { primeNativeDispatcher } = await import(${JSON.stringify(transport)});
    let calls = 0;
    await assert.rejects(primeNativeDispatcher(() => { calls++; throw new Error('unexpected'); }));
    assert.equal(calls, 0);
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0);
});
