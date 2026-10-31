import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { runtimeWorkspace } from './build.mjs';
const ROOT = paths.build;
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
test('packaged entrypoint and source/lockfile provenance match verified isolated build', async () => {
  const plugin = path.join(ROOT, 'plugin/vortex-agent');
  const provenance = JSON.parse(await fs.readFile(path.join(plugin, 'provenance.json'), 'utf8'));
  const compileReceipt = JSON.parse(await fs.readFile(path.join(ROOT, 'adapted-compile.json'), 'utf8'));
  assert.equal(provenance.workspaceRoot, runtimeWorkspace());
  assert.equal(compileReceipt.inputs.workspaceRoot, provenance.workspaceRoot);
  assert.equal(await sha(path.join(plugin, 'index.js')), provenance.pluginSha256);
  assert.equal(await sha(path.join(ROOT, 'upstream/adapted-dist/index.js')), provenance.pluginSha256);
  assert.equal(await sha(path.join(ROOT, 'upstream/pnpm-lock.yaml')), provenance.lockfileSha256);
  for (const [name, hash] of Object.entries(provenance.sources)) assert.equal(await sha(path.join(provenance.maintainedSource, name)), hash, name);
  assert.equal(provenance.installSupported, false);
  assert.equal(provenance.version, '1.1.0'); assert.equal(provenance.receiptVersion, 2);
  assert.equal(await sha(path.join(ROOT, 'upstream/src/vortexControl.ts')), provenance.upstreamControlSha256);
  for (const name of Object.keys(provenance.sources).filter(name => name.endsWith('.cjs'))) assert.equal(await sha(path.join(ROOT, 'upstream/src', name)), provenance.sources[name]);
  assert.equal(provenance.authentication, 'Windows-DPAPI-CurrentUser-bearer');
  assert.equal(provenance.vortexSourceCommit, '41be6d4556568a605d6131b8c5ca90ff26dec6ac');
  assert.equal(JSON.parse(await fs.readFile(path.join(plugin, 'info.json'), 'utf8')).version, provenance.version);
  assert.deepEqual((await fs.readdir(plugin)).sort(), ['LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'index.js', 'info.json', 'provenance.json'].sort());
  assert.equal(provenance.packageSchemaVersion, 2);
  assert.deepEqual(Object.keys(provenance.licenseFileSHA256).sort(), ['LICENSE.md', 'THIRD-PARTY-NOTICES.md']);
  for (const [name, hash] of Object.entries(provenance.licenseFileSHA256)) {
    assert.equal(await sha(path.join(plugin, name)), hash);
    assert.equal(await sha(path.join(ROOT, 'upstream', name)), hash);
  }
  assert.equal(provenance.sourceOffer.repository, 'https://github.com/Antrakt92/vortex-nexus-modding-mcp');
});
