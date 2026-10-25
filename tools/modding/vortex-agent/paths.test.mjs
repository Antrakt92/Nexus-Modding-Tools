import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import paths from './paths.cjs';
import { adaptedConfig, assertCompileReceipt, compileInputs, runtimeWorkspace, verifyPinnedSnapshot, PIN } from './build.mjs';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const absoluteFixture = name => path.resolve(os.tmpdir(), name);

test('source defaults derive shared workspace-local state and cache paths', () => {
  const p = paths.resolvePaths({ env: {}, sourceDir: path.join(root, 'tools/modding/vortex-agent'), compiledWorkspace: undefined });
  assert.equal(p.workspace, root);
  assert.equal(p.contextRoot, path.join(root, 'local-state/upstream-sources'));
  assert.equal(p.receipts, path.join(root, 'local-state/vortex-agent-build/receipts'));
  assert.equal(p.credentials, path.join(root, 'local-state/vortex-agent-build/credentials'));
});

test('explicit absolute workspace/context override compiled and source roots', () => {
  const workspace = absoluteFixture('selected-workspace');
  const context = absoluteFixture('selected-context');
  const p = paths.resolvePaths({ env: { NEXUS_WORKSPACE: workspace, NEXUS_CONTEXT_ROOT: context }, compiledWorkspace: root });
  assert.equal(p.workspace, workspace);
  assert.equal(p.cache, path.join(context, 'vortex-mcp'));
});

test('relative, empty and control-containing overrides are refused', () => {
  for (const key of ['NEXUS_WORKSPACE', 'NEXUS_CONTEXT_ROOT']) {
    for (const value of ['relative/path', '', 'x\0y'])
      assert.throws(() => paths.resolvePaths({ env: { [key]: value } }), /ABSOLUTE_PATH_REQUIRED/);
  }
  if (process.platform === 'win32')
    assert.throws(() => paths.resolvePaths({ env: { NEXUS_WORKSPACE: '\\root-without-drive' } }), /ABSOLUTE_PATH_REQUIRED/);
});

test('installed bundle uses injected workspace instead of AppData dirname', async () => {
  const code = await fs.readFile(new URL('./paths.cjs', import.meta.url), 'utf8');
  const compiled = absoluteFixture('compiled-workspace');
  const module = { exports: {} };
  vm.runInNewContext(code, { module, require, process: { platform: process.platform, env: {} },
    __dirname: absoluteFixture('Roaming/Vortex/plugins/vortex-agent'), __NEXUS_WORKSPACE__: compiled });
  assert.equal(module.exports.workspace, compiled);
  assert.equal(module.exports.credentials, path.join(compiled, 'local-state/vortex-agent-build/credentials'));
});

test('restored credential and receipt consumers share the resolved workspace', () => {
  const workspace = absoluteFixture('relocated-tools-workspace');
  const script = 'const c=require(' + JSON.stringify(path.join(directory, 'credential.cjs')) + ');'
    + 'const g=require(' + JSON.stringify(path.join(directory, 'guard.cjs')) + ');'
    + 'process.stdout.write(JSON.stringify({credentials:c.ROOT,receipts:g.RECEIPTS}));';
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, NEXUS_WORKSPACE: workspace }, encoding: 'utf8', windowsHide: true,
  }));
  assert.equal(result.credentials, path.join(workspace, 'local-state/vortex-agent-build/credentials'));
  assert.equal(result.receipts, path.join(workspace, 'local-state/vortex-agent-build/receipts'));
});

test('generated esbuild define follows relocated workspace and rejects unexpected config', () => {
  const config = 'export default defineConfig({ entry: { index: "src/index.ts" }, outDir: "dist" });';
  const relocated = absoluteFixture('build-in-another-workspace');
  const generated = adaptedConfig(config, relocated);
  assert(generated.includes('__NEXUS_WORKSPACE__: ' + JSON.stringify(JSON.stringify(relocated))));
  assert(generated.includes('src/adapted.cjs'));
  assert(generated.includes('outDir: "adapted-dist"'));
  assert.throws(() => adaptedConfig('unknown config', relocated), /Unexpected upstream/);
});

test('bundle packaging refuses changed source, workspace or bundle pins', () => {
  const current = { workspaceRoot: root, inputs: { 'src/paths.cjs': 'a'.repeat(64) } };
  const receipt = { inputs: current, bundleSha256: 'b'.repeat(64) };
  assert.doesNotThrow(() => assertCompileReceipt(receipt, current, 'b'.repeat(64)));
  assert.throws(() => assertCompileReceipt(receipt, { ...current, workspaceRoot: absoluteFixture('other') }, 'b'.repeat(64)), /proof differs/);
  assert.throws(() => assertCompileReceipt(receipt, { ...current, inputs: {} }, 'b'.repeat(64)), /proof differs/);
  assert.throws(() => assertCompileReceipt(receipt, current, 'c'.repeat(64)), /proof differs/);
});

test('runtime workspace override separates packaged state from the artifact workspace', () => {
  const runtime = absoluteFixture('existing-vortex-runtime');
  assert.equal(runtimeWorkspace({}), paths.workspace);
  assert.equal(runtimeWorkspace({ NEXUS_RUNTIME_WORKSPACE: runtime }), runtime);
  for (const value of ['', 'relative/path', 'x\0y'])
    assert.throws(() => runtimeWorkspace({ NEXUS_RUNTIME_WORKSPACE: value }), /NEXUS_RUNTIME_WORKSPACE_ABSOLUTE_PATH_REQUIRED/);
  assert.equal(paths.build, path.join(paths.workspace, 'local-state/vortex-agent-build'));
});

test('compile proof binds the selected runtime and refuses an override changed after patch or compilation', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-runtime-pins-'));
  t.after(async () => {
    assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'vortex-runtime-pins-'));
    assert(!(await fs.lstat(temp)).isSymbolicLink());
    await fs.rm(temp, { recursive: true, force: true });
  });
  const runtime = absoluteFixture('existing-vortex-runtime'), other = absoluteFixture('different-vortex-runtime');
  const config = 'export default defineConfig({ entry: { index: "src/index.ts" }, outDir: "dist" });';
  await fs.mkdir(path.join(temp, 'src'));
  const modules = ['paths.cjs', 'guard.cjs', 'extension.cjs', 'credential.cjs', 'inspection.cjs',
    'serialization.cjs', 'download-identity.cjs', 'receipts.cjs', 'http-ingress.cjs', 'adapted.cjs', 'vortexControl.ts'];
  for (const name of modules) await fs.writeFile(path.join(temp, 'src', name), 'fixture input');
  for (const name of ['package.json', 'pnpm-lock.yaml']) await fs.writeFile(path.join(temp, name), 'fixture input');
  await fs.writeFile(path.join(temp, 'tsup.config.ts'), config);
  await fs.writeFile(path.join(temp, 'tsup.adapted.config.ts'), adaptedConfig(config, runtime));
  const inputs = await compileInputs(temp, runtime);
  assert.equal(inputs.workspaceRoot, runtime);
  const receipt = { inputs, bundleSha256: 'a'.repeat(64) };
  await assert.rejects(compileInputs(temp, other), /configuration changed; patch again/);
  await fs.writeFile(path.join(temp, 'tsup.adapted.config.ts'), adaptedConfig(config, other));
  const changed = await compileInputs(temp, other);
  assert.throws(() => assertCompileReceipt(receipt, changed, 'a'.repeat(64)), /proof differs/);
});

test('vendored restore validates original and accepted content pins before using files', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-source-pins-'));
  t.after(async () => {
    assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'vortex-source-pins-'));
    assert(!(await fs.lstat(temp)).isSymbolicLink());
    await fs.rm(temp, { recursive: true, force: true });
  });
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(temp, 'package.json'), 'accepted manifest');
  const provenance = { upstream: 'https://github.com/alandtse/vortex-mcp', commit: PIN,
    license: 'GPL-3.0-only', localChanges: ['package.json'],
    expectedPublicFiles: ['package.json', 'UPSTREAM-PROVENANCE.json'],
    originalFileSHA256: { 'package.json': sha('original manifest') },
    currentFileSHA256: { 'package.json': sha('accepted manifest') } };
  provenance.acceptedSourceTreeSHA256 = sha(JSON.stringify(provenance.currentFileSHA256));
  await fs.writeFile(path.join(temp, 'UPSTREAM-PROVENANCE.json'), JSON.stringify(provenance));
  await verifyPinnedSnapshot(temp);
  await fs.writeFile(path.join(temp, 'package.json'), 'unreviewed edit');
  await assert.rejects(verifyPinnedSnapshot(temp), /content differs/);
  provenance.currentFileSHA256 = { '../escape': sha('x') };
  provenance.originalFileSHA256 = {};
  provenance.expectedPublicFiles = ['../escape', 'UPSTREAM-PROVENANCE.json'];
  await fs.writeFile(path.join(temp, 'UPSTREAM-PROVENANCE.json'), JSON.stringify(provenance));
  await assert.rejects(verifyPinnedSnapshot(temp), /Unsafe pinned upstream path/);
});

test('Python installer derives current workspace and AppData without side effects', () => {
  const workspace = absoluteFixture('python-restored-workspace');
  const roaming = absoluteFixture('different-user-roaming');
  const script = 'import importlib.util,json; s=importlib.util.spec_from_file_location("restore_installer",'
    + JSON.stringify(path.join(directory, 'manage-install.py')) + ');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
    + 'print(json.dumps({"root":str(m.ROOT),"plugins":str(m.PLUGINS),"receipts":str(m.RECEIPTS)}))';
  const result = JSON.parse(execFileSync('python', ['-B', '-c', script], {
    env: { ...process.env, NEXUS_WORKSPACE: workspace, APPDATA: roaming }, encoding: 'utf8', windowsHide: true,
  }));
  assert.equal(result.root, workspace);
  assert.equal(result.plugins, path.join(roaming, 'Vortex/plugins'));
  assert.equal(result.receipts, path.join(workspace, 'local-state/vortex-agent-build/receipts'));
  const invalid = spawnSync('python', ['-B', '-c', script], {
    env: { ...process.env, NEXUS_WORKSPACE: 'relative-root', APPDATA: roaming }, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /requires an absolute path/);
});
