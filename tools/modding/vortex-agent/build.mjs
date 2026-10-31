import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import paths from './paths.cjs';
export const PIN = 'd10277b8858ad6d411765aa93131219f4a24533e';
const CACHE = paths.cache;
const BUILD = paths.build;
const source = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(source, '../../../dependencies/vortex-mcp');
const modules = ['paths.cjs', 'guard.cjs', 'extension.cjs', 'credential.cjs', 'inspection.cjs', 'lifecycle-inspection.cjs', 'native-preflight.cjs', 'serialization.cjs', 'download-identity.cjs', 'receipts.cjs', 'http-ingress.cjs'];
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function noReparsePaths(...files) {
  for (const file of files) {
    for (let entry = path.resolve(file); ; entry = path.dirname(entry)) {
      try {
        if ((await fs.lstat(entry)).isSymbolicLink()) throw Error('Build reparse path refused');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry === path.dirname(entry)) break;
    }
  }
}

async function noReparseTree(directory) {
  await noReparsePaths(directory);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    await noReparsePaths(file);
    if (entry.isDirectory()) await noReparseTree(file);
  }
}

export async function verifyPinnedSnapshot(tree) {
  await noReparsePaths(path.join(tree, 'UPSTREAM-PROVENANCE.json'));
  const provenance = JSON.parse(await fs.readFile(path.join(tree, 'UPSTREAM-PROVENANCE.json'), 'utf8'));
  if (provenance.upstream !== 'https://github.com/alandtse/vortex-mcp' || provenance.commit !== PIN
      || provenance.license !== 'GPL-3.0-only' || !provenance.currentFileSHA256
      || !provenance.originalFileSHA256 || !Array.isArray(provenance.localChanges))
    throw Error('Pinned upstream snapshot provenance is incomplete');
  const pins = provenance.currentFileSHA256;
  if (!Object.keys(pins).length) throw Error('Pinned upstream snapshot is empty');
  const changes = provenance.localChanges.map(change => typeof change === 'string' ? change : change?.path);
  const expected = [...Object.keys(pins), 'UPSTREAM-PROVENANCE.json'].sort();
  if (!Array.isArray(provenance.expectedPublicFiles)
      || JSON.stringify([...provenance.expectedPublicFiles].sort()) !== JSON.stringify(expected))
    throw Error('Pinned upstream public fileset differs');
  for (const [name, original] of Object.entries(provenance.originalFileSHA256)) {
    if (!Object.hasOwn(pins, name) || (pins[name] !== original && !changes.includes(name)))
      throw Error('Upstream original/accepted pins are inconsistent: ' + name);
  }
  for (const [name, pin] of Object.entries(pins)) {
    const parts = name.split('/');
    if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some(p => !p || ['.', '..', '.git', 'node_modules', '.tooling'].includes(p))
        || !/^[a-f0-9]{64}$/.test(pin)) throw Error('Unsafe pinned upstream path');
    const file = path.join(tree, ...parts);
    for (let entry = file; entry !== path.dirname(entry); entry = path.dirname(entry)) {
      if ((await fs.lstat(entry)).isSymbolicLink()) throw Error('Pinned upstream reparse path refused');
      if (entry === path.resolve(tree)) break;
    }
    if (!(await fs.stat(file)).isFile() || await sha(file) !== pin) throw Error('Pinned upstream content differs: ' + name);
  }
  const accepted = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.keys(pins).sort().map(name => [name, pins[name]])))).digest('hex');
  if (accepted !== provenance.acceptedSourceTreeSHA256) throw Error('Accepted upstream source-tree pin differs');
  return provenance;
}

async function checkBuildTree(tree) {
  let snapshot = false;
  try { await fs.access(path.join(tree, 'UPSTREAM-PROVENANCE.json')); snapshot = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (snapshot) return verifyPinnedSnapshot(tree);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim();
  if (head !== PIN) throw Error('Upstream pin differs');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'], { cwd: tree, stdio: 'pipe' });
  return { commit: PIN, sourceMethod: 'pinned local Git clone' };
}

export function runtimeWorkspace(env = process.env) {
  return paths.absolute(env.NEXUS_RUNTIME_WORKSPACE === undefined ? paths.workspace
    : env.NEXUS_RUNTIME_WORKSPACE, 'NEXUS_RUNTIME_WORKSPACE');
}

export function adaptedConfig(config, workspace = runtimeWorkspace()) {
  if (!config.includes('entry: { index: "src/index.ts" }') || !config.includes('outDir: "dist"'))
    throw Error('Unexpected upstream build config');
  const root = paths.absolute(workspace, 'NEXUS_WORKSPACE');
  return config.replace('src/index.ts', 'src/adapted.cjs').replace('outDir: "dist"', 'outDir: "adapted-dist"')
    .replace('export default defineConfig({', 'export default defineConfig({\n  define: { __NEXUS_WORKSPACE__: '
      + JSON.stringify(JSON.stringify(root)) + ' },');
}

export async function compileInputs(tree, workspace = runtimeWorkspace()) {
  const runtime = paths.absolute(workspace, 'NEXUS_RUNTIME_WORKSPACE');
  const names = [...modules.map(n => 'src/' + n), 'src/adapted.cjs', 'tsup.adapted.config.ts',
    'tsup.config.ts', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'];
  await noReparsePaths(...names.map(name => path.join(tree, name)));
  const config = await fs.readFile(path.join(tree, 'tsup.config.ts'), 'utf8');
  if (await fs.readFile(path.join(tree, 'tsup.adapted.config.ts'), 'utf8') !== adaptedConfig(config, runtime))
    throw Error('Workspace or generated build configuration changed; patch again');
  const inputs = {};
  for (const name of names) inputs[name] = await sha(path.join(tree, name));
  return { workspaceRoot: runtime, inputs };
}

export function assertCompileReceipt(receipt, current, bundleSha256) {
  if (!receipt || receipt.bundleSha256 !== bundleSha256 || JSON.stringify(receipt.inputs) !== JSON.stringify(current))
    throw Error('Compiled bundle/source/workspace proof differs; rebuild before packaging');
}
async function preservePreviousBuild() {
  const plugin = path.join(BUILD, 'plugin/vortex-agent');
  let previous;
  try { previous = JSON.parse(await fs.readFile(path.join(plugin, 'provenance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (previous.version === '1.1.0') return;
  const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(plugin, 'index.js'))).digest('hex');
  if (digest !== previous.pluginSha256) throw Error('Previous package provenance mismatch');
  const archive = path.join(BUILD, 'archives', previous.version + '-' + digest);
  await noReparsePaths(archive);
  try {
    await fs.access(archive);
    const archived = crypto.createHash('sha256').update(await fs.readFile(path.join(archive, 'plugin/index.js'))).digest('hex');
    if (archived !== digest) throw Error('Previous archive incomplete or mismatched; inspect before rebuilding');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(archive, { recursive: true });
  await fs.cp(plugin, path.join(archive, 'plugin'), { recursive: true, errorOnExist: true, force: false });
  await fs.cp(path.join(BUILD, 'upstream/adapted-dist'), path.join(archive, 'adapted-dist'), { recursive: true, errorOnExist: true, force: false });
  await fs.mkdir(path.join(archive, 'src'));
  for (const name of Object.keys(previous.sources).filter(name => name.endsWith('.cjs'))) await fs.copyFile(path.join(BUILD, 'upstream/src', name), path.join(archive, 'src', name));
}
const run = (cmd, args, cwd = BUILD) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
export async function main(argv = process.argv.slice(2)) {
  // COPYFILE_EXCL protects new files only. Existing adapted inputs and outputs
  // also need ancestry checks before any write can follow a planted link.
  const buildTree = path.join(BUILD, 'upstream');
  await noReparsePaths(BUILD, path.join(BUILD, 'adapted-compile.json'),
    ...[...modules, 'adapted.cjs', 'regression.test.ts'].map(name => path.join(buildTree, 'src', name)),
    path.join(buildTree, 'tsup.adapted.config.ts'));
  await noReparseTree(path.join(buildTree, 'adapted-dist'));
  await noReparseTree(path.join(BUILD, 'plugin/vortex-agent'));
if (argv.includes('--prepare')) {
  await fs.mkdir(BUILD, { recursive: true });
  const tree = path.join(BUILD, 'upstream');
  try { await fs.access(tree); throw new Error('Build tree already exists; inspect it rather than overwrite'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let snapshot, hasVendor = false;
  try { await fs.access(vendor); hasVendor = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasVendor) snapshot = await verifyPinnedSnapshot(vendor);
  if (snapshot) {
    await fs.mkdir(tree);
    for (const name of Object.keys(snapshot.currentFileSHA256)) {
      const destination = path.join(tree, ...name.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(vendor, ...name.split('/')), destination, fs.constants.COPYFILE_EXCL);
    }
    await fs.copyFile(path.join(vendor, 'UPSTREAM-PROVENANCE.json'), path.join(tree, 'UPSTREAM-PROVENANCE.json'), fs.constants.COPYFILE_EXCL);
    await verifyPinnedSnapshot(tree);
  } else {
    run('git', ['clone', '--no-hardlinks', CACHE, tree]);
    run('git', ['checkout', '--detach', PIN], tree);
    await checkBuildTree(tree);
  }
} else if (argv.includes('--regression')) {
  await fs.copyFile(path.join(source, 'regression.test.ts'), path.join(BUILD, 'upstream', 'src', 'regression.test.ts'));
} else if (argv.includes('--patch')) {
  await preservePreviousBuild();
  const tree = path.join(BUILD, 'upstream');
  await checkBuildTree(tree);
  for (const name of modules) await fs.copyFile(path.join(source, name), path.join(tree, 'src', name));
  await fs.writeFile(path.join(tree, 'src', 'adapted.cjs'), "const { start } = require('./extension.cjs');\nmodule.exports = function(context) { context.once(() => start(context.api)); return true; };\nmodule.exports.start = start;\n");
  const config = await fs.readFile(path.join(tree, 'tsup.config.ts'), 'utf8');
  await fs.writeFile(path.join(tree, 'tsup.adapted.config.ts'), adaptedConfig(config));
} else if (argv.includes('--compile')) {
  const tree = path.join(BUILD, 'upstream');
  await checkBuildTree(tree);
  const inputs = await compileInputs(tree);
  run(process.execPath, [path.join(tree, 'node_modules/tsup/dist/cli-default.js'), '--config', 'tsup.adapted.config.ts'], tree);
  if (JSON.stringify(await compileInputs(tree)) !== JSON.stringify(inputs)) throw Error('Build inputs changed while compiling');
  await fs.writeFile(path.join(BUILD, 'adapted-compile.json'), JSON.stringify({ inputs,
    bundleSha256: await sha(path.join(tree, 'adapted-dist/index.js')) }, null, 2));
} else if (argv.includes('--package')) {
  await preservePreviousBuild();
  const tree = path.join(BUILD, 'upstream');
  await checkBuildTree(tree);
  assertCompileReceipt(JSON.parse(await fs.readFile(path.join(BUILD, 'adapted-compile.json'), 'utf8')),
    await compileInputs(tree), await sha(path.join(tree, 'adapted-dist/index.js')));
  const plugin = path.join(BUILD, 'plugin', 'vortex-agent');
  await fs.mkdir(plugin, { recursive: true });
  await fs.copyFile(path.join(BUILD, 'upstream', 'adapted-dist', 'index.js'), path.join(plugin, 'index.js'));
  await fs.copyFile(path.join(BUILD, 'upstream', 'LICENSE.md'), path.join(plugin, 'LICENSE.md'));
  await fs.copyFile(path.join(tree, 'THIRD-PARTY-NOTICES.md'), path.join(plugin, 'THIRD-PARTY-NOTICES.md'));
  await fs.writeFile(path.join(plugin, 'info.json'), JSON.stringify({ id: 'vortex-agent', name: 'Vortex Agent (guarded MCP)', author: 'Alan Tse; local adapted fork', version: '1.1.0', description: 'DPAPI-authenticated curated MCP adapter; native install refused; external disk verification required', type: 'extension' }, null, 2));
  const sources = {};
  for (const name of [...modules, 'build.mjs', 'bridge.mjs', 'manage-install.py']) sources[name] = await sha(path.join(source, name));
  for (const name of modules) if (await sha(path.join(BUILD, 'upstream/src', name)) !== sources[name]) throw Error('Build copy differs: ' + name);
  await checkBuildTree(path.join(BUILD, 'upstream'));
  await fs.writeFile(path.join(plugin, 'provenance.json'), JSON.stringify({ upstream: 'https://github.com/alandtse/vortex-mcp', commit: PIN,
    maintainedSource: source, workspaceRoot: runtimeWorkspace(), protocol: 'vortex-agent/1', version: '1.1.0', installSupported: false, receiptVersion: 2,
    packageSchemaVersion: 2,
    licenseFileSHA256: { 'LICENSE.md': await sha(path.join(plugin, 'LICENSE.md')),
      'THIRD-PARTY-NOTICES.md': await sha(path.join(plugin, 'THIRD-PARTY-NOTICES.md')) },
    sourceOffer: { repository: 'https://github.com/Antrakt92/vortex-nexus-modding-mcp',
      description: 'Corresponding adapter source, build scripts, upstream source pins and dependency lockfile.' },
    authentication: 'Windows-DPAPI-CurrentUser-bearer', vortexSourceCommit: '41be6d4556568a605d6131b8c5ca90ff26dec6ac',
    pluginSha256: await sha(path.join(plugin, 'index.js')),
    lockfileSha256: await sha(path.join(BUILD, 'upstream', 'pnpm-lock.yaml')), upstreamControlSha256: await sha(path.join(BUILD, 'upstream/src/vortexControl.ts')), sources }, null, 2));
  console.log(plugin);
} else throw new Error('Usage: build.mjs --prepare | --regression | --patch | --compile | --package');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
