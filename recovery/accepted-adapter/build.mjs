import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
export const PIN = 'd10277b8858ad6d411765aa93131219f4a24533e';
const CACHE = 'C:/Users/Dima/.codex/agent-context/repos/vortex-mcp';
const BUILD = 'D:/Modding/Nexus/local-state/vortex-agent-build';
const source = path.dirname(fileURLToPath(import.meta.url));
const modules = ['guard.cjs', 'extension.cjs', 'credential.cjs', 'inspection.cjs', 'serialization.cjs', 'download-identity.cjs', 'receipts.cjs', 'http-ingress.cjs'];
async function preservePreviousBuild() {
  const plugin = path.join(BUILD, 'plugin/vortex-agent');
  let previous;
  try { previous = JSON.parse(await fs.readFile(path.join(plugin, 'provenance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (previous.version === '1.0.4') return;
  const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(plugin, 'index.js'))).digest('hex');
  if (digest !== previous.pluginSha256) throw Error('Previous package provenance mismatch');
  const archive = path.join(BUILD, 'archives', previous.version + '-' + digest);
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
if (process.argv.includes('--prepare')) {
  await fs.access(path.dirname(BUILD));
  await fs.mkdir(BUILD, { recursive: true });
  const tree = path.join(BUILD, 'upstream');
  try { await fs.access(tree); throw new Error('Build tree already exists; inspect it rather than overwrite'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  run('git', ['clone', '--no-hardlinks', CACHE, tree]);
  run('git', ['checkout', '--detach', PIN], tree);
} else if (process.argv.includes('--regression')) {
  await fs.copyFile(path.join(source, 'regression.test.ts'), path.join(BUILD, 'upstream', 'src', 'regression.test.ts'));
} else if (process.argv.includes('--patch')) {
  await preservePreviousBuild();
  const tree = path.join(BUILD, 'upstream');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim();
  if (head !== PIN) throw new Error('Upstream pin differs');
  for (const name of modules) await fs.copyFile(path.join(source, name), path.join(tree, 'src', name));
  await fs.writeFile(path.join(tree, 'src', 'adapted.cjs'), "const { start } = require('./extension.cjs');\nmodule.exports = function(context) { context.once(() => start(context.api)); return true; };\nmodule.exports.start = start;\n");
  const config = await fs.readFile(path.join(tree, 'tsup.config.ts'), 'utf8');
  if (!config.includes('entry: { index: "src/index.ts" }')) throw new Error('Unexpected upstream build config');
  await fs.writeFile(path.join(tree, 'tsup.adapted.config.ts'), config.replace('src/index.ts', 'src/adapted.cjs').replace('outDir: "dist"', 'outDir: "adapted-dist"'));
} else if (process.argv.includes('--compile')) {
  const tree = path.join(BUILD, 'upstream');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim() !== PIN) throw Error('Upstream pin differs');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'], { cwd: tree, stdio: 'pipe' });
  run(process.execPath, [path.join(tree, 'node_modules/tsup/dist/cli-default.js'), '--config', 'tsup.adapted.config.ts'], tree);
} else if (process.argv.includes('--package')) {
  await preservePreviousBuild();
  const plugin = path.join(BUILD, 'plugin', 'vortex-agent');
  await fs.mkdir(plugin, { recursive: true });
  await fs.copyFile(path.join(BUILD, 'upstream', 'adapted-dist', 'index.js'), path.join(plugin, 'index.js'));
  await fs.copyFile(path.join(BUILD, 'upstream', 'LICENSE.md'), path.join(plugin, 'LICENSE.md'));
  await fs.writeFile(path.join(plugin, 'info.json'), JSON.stringify({ id: 'vortex-agent', name: 'Vortex Agent (guarded MCP)', author: 'Alan Tse; local adapted fork', version: '1.0.4', description: 'DPAPI-authenticated curated MCP adapter; native install refused; external disk verification required', type: 'extension' }, null, 2));
  const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const sources = {};
  for (const name of [...modules, 'build.mjs', 'bridge.mjs', 'manage-install.py']) sources[name] = await sha(path.join(source, name));
  for (const name of modules) if (await sha(path.join(BUILD, 'upstream/src', name)) !== sources[name]) throw Error('Build copy differs: ' + name);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(BUILD, 'upstream'), encoding: 'utf8' }).trim();
  if (head !== PIN) throw Error('Upstream pin differs');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'], { cwd: path.join(BUILD, 'upstream'), stdio: 'pipe' });
  await fs.writeFile(path.join(plugin, 'provenance.json'), JSON.stringify({ upstream: 'https://github.com/alandtse/vortex-mcp', commit: PIN,
    maintainedSource: source, protocol: 'vortex-agent/1', version: '1.0.4', installSupported: false, receiptVersion: 2,
    authentication: 'Windows-DPAPI-CurrentUser-bearer', vortexSourceCommit: '41be6d4556568a605d6131b8c5ca90ff26dec6ac',
    pluginSha256: await sha(path.join(plugin, 'index.js')),
    lockfileSha256: await sha(path.join(BUILD, 'upstream', 'pnpm-lock.yaml')), upstreamControlSha256: await sha(path.join(BUILD, 'upstream/src/vortexControl.ts')), sources }, null, 2));
  console.log(plugin);
} else throw new Error('Usage: build.mjs --prepare | --regression | --patch | --compile | --package');
