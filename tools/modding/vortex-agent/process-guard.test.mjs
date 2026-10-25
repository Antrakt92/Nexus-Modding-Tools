import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8');
const good = names => ({status: 0, signal: null, stderr: '', stdout: JSON.stringify({schema: 1, complete: true, count: names.length, names})});
function fixture(run, env = {SystemRoot: 'C:\\Windows'}) {
  const module = {exports: {}};
  const calls = [];
  const invoke = (exe, args, options) => { calls.push({exe, args, options}); return run(exe, args, options); };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {process: {platform: 'win32', env}, Buffer})(
    id => id === 'node:child_process' ? {spawnSync: invoke} : require(id), module, module.exports);
  return {stopped: module.exports.stopped, calls};
}

test('process snapshot rejects every protected executable case-insensitively', () => {
  for (const [game, names] of Object.entries({cyberpunk2077: ['Cyberpunk2077.exe', 'REDprelauncher.exe'], assassinscreedunity: ['ACU.exe'],
    skyrimse: ['SkyrimSE.exe', 'skse64_loader.exe'], skyrimvr: ['SkyrimVR.exe', 'sksevr_loader.exe'], fallout4: ['Fallout4.exe', 'f4se_loader.exe']})) {
    for (const name of names) assert.throws(() => fixture(() => good(['Vortex.exe', name.toUpperCase()])).stopped({}, game), /GAME_RUNNING/);
  }
});

test('fresh process snapshot catches a game that starts between checks', () => {
  let calls = 0;
  const f = fixture(() => good(++calls === 1 ? ['Vortex.exe'] : ['Cyberpunk2077.exe']));
  assert.doesNotThrow(() => f.stopped({}, 'cyberpunk2077'));
  assert.throws(() => f.stopped({}, 'cyberpunk2077'), /GAME_RUNNING/);
  assert.equal(calls, 2);
});

test('errors, stderr, truncation and invalid envelopes never report stopped', () => {
  const outputs = [undefined, {error: Error('timeout')}, {...good(['Vortex.exe']), status: 1}, {...good(['Vortex.exe']), signal: 'SIGTERM'},
    {...good(['Vortex.exe']), stderr: 'error'}, {...good(['Vortex.exe']), stdout: ''}, {...good(['Vortex.exe']), stdout: '{"complete":true'},
    ...[null, [], {}, {schema: 1, complete: true, count: 0, names: []}, {schema: 1, complete: true, count: 2, names: ['Vortex.exe']},
      {schema: 1, complete: false, count: 1, names: ['Vortex.exe']}, {schema: 2, complete: true, count: 1, names: ['Vortex.exe']},
      {schema: 1, complete: true, count: 1, names: [12]}, {schema: 1, complete: true, count: 1, names: ['']},
      {schema: 1, complete: true, count: 1, names: ['bad\nname']}, {schema: 1, complete: true, count: 1, names: ['C:\\bad.exe']}]
      .map(value => ({...good(['Vortex.exe']), stdout: JSON.stringify(value)}))];
  for (const output of outputs) assert.throws(() => fixture(() => output).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
  assert.throws(() => fixture(() => { throw Error('spawn failed'); }).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
});

test('trusted absolute PowerShell route, bounded process and script do not use PATH or Get-Process autoload', () => {
  const f = fixture(() => good(['Vortex.exe']));
  f.stopped({}, 'cyberpunk2077');
  const {exe, args, options} = f.calls[0];
  assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
  assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 1024 * 1024); assert.equal(options.windowsHide, true);
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /System\.Diagnostics\.Process\]::GetProcesses\(\)/);
  assert.doesNotMatch(script, /Get-Process|Join-Path|Select-Object/);
  assert.throws(() => fixture(() => good(['Vortex.exe']), {}).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
  assert.throws(() => fixture(() => good(['Vortex.exe']), {SystemRoot: 'Windows'}).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
  assert.throws(() => fixture(() => good(['Vortex.exe']), {SystemRoot: 'C:\\Windows\\..\\Temp'}).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
  assert.throws(() => fixture(() => good(['Vortex.exe']), {SystemRoot: 'C:\\Windows:stream'}).stopped({}, 'cyberpunk2077'), /PROCESS_LIST_UNVERIFIABLE/);
});

test('running tool and unsupported game reject before launching a probe', () => {
  const f = fixture(() => { throw Error('must not probe'); });
  assert.throws(() => f.stopped({session: {base: {toolsRunning: {game: true}}}}, 'cyberpunk2077'), /GAME_OR_TOOL_RUNNING/);
  assert.throws(() => f.stopped({}, 'unknown'), /UNSUPPORTED_GAME_PROCESS_GUARD/);
  assert.equal(f.calls.length, 0);
});

test('Windows snapshot runs with inherited PowerShell 7 module path', {skip: process.platform !== 'win32'}, () => {
  let elapsed;
  const f = fixture((exe, args, options) => {
    const start = performance.now();
    const result = spawnSync(exe, args, {...options, env: {...process.env, PSModulePath: 'C:\\unavailable\\PowerShell\\7\\Modules'}});
    elapsed = performance.now() - start;
    return result;
  }, process.env);
  assert.doesNotThrow(() => f.stopped({}, 'assassinscreedunity'));
  assert.ok(elapsed < 10000);
  console.log('read-only built-in process snapshot latency_ms=' + Math.round(elapsed));
});
