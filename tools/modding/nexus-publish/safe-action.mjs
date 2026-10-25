// Execute the official bundle unchanged. Discard ALL upstream logs, including debug/error bodies.
import { pathToFileURL } from 'node:url';
import { installFetchGuard } from './fetch-guard.mjs';
import { primeNativeDispatcher } from './native-transport.mjs';

const originalWrite = process.stdout.write.bind(process.stdout);
let versionId = null;
let failed = false;
let stage = 'initialization';
let failure = null;
function classify(chunk) {
  const value = String(chunk);
  for (const [text, code] of [['Starting NexusMods', 'inputs'], ['Requesting multipart', 'reservation'],
    ['Uploading part', 'storage'], ['Completing multipart', 'completion'], ['Finalising upload', 'finalise'],
    ['Polling upload', 'processing'], ['Creating mod file version', 'version'], ['Adding a changelog', 'changelog']]) {
    if (value.includes(text)) stage = code;
  }
  for (const [text, code] of [['Network boundary refused', 'boundary'], ['Failed to upload part', 'storage-http'],
    ['Failed to complete multipart', 'completion-http'], ['Failed to finalise', 'finalise-http'],
    ['Failed to create mod file version', 'version-http'], ['Failed to add changelog', 'changelog-http'],
    ['fetch failed', 'transport']]) if (value.includes(text)) failure = code;
}
const idPattern = /^(?:[1-9][0-9]{0,19}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
process.stdout.write = (chunk, encoding, callback) => {
  classify(chunk);
  const match = String(chunk).match(/^::set-output name=version_id::([^\r\n]+)\r?\n?$/);
  if (match && idPattern.test(match[1])) versionId = match[1];
  if (typeof encoding === 'function') encoding();
  if (typeof callback === 'function') callback();
  return true;
};
process.stderr.write = (chunk, encoding, callback) => {
  classify(chunk);
  if (typeof encoding === 'function') encoding();
  if (typeof callback === 'function') callback();
  return true;
};
for (const name of ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE',
                    'GITHUB_STEP_SUMMARY', 'NEXUSMODS_API_BASE', 'ACTIONS_STEP_DEBUG', 'RUNNER_DEBUG']) {
  delete process.env[name];
}
process.on('uncaughtException', () => { failed = true; process.exitCode = 1; });
process.on('unhandledRejection', () => { failed = true; process.exitCode = 1; });
process.on('exit', (code) => {
  originalWrite(JSON.stringify({ ok: code === 0 && !failed && versionId !== null, version_id: versionId, stage, failure }));
});
try {
  const nativeFetch = globalThis.fetch;
  const dispatcher = await primeNativeDispatcher(nativeFetch);
  installFetchGuard(nativeFetch, process.env.INPUT_API_KEY?.trim(), { dispatcher });
  await import(pathToFileURL(process.argv[2]).href);
} catch {
  failed = true;
  process.exitCode = 1;
}
