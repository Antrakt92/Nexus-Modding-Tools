import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {extractClassDeclaration} from './native-patch-test-fixture.mjs';

export class SelfCopyCheckError extends Error {}
export function failure(code, message = code) {return Object.assign(Error(message), {code});}
export function fixture(source, {linkError, copyError, removeError, copy, link, mkdirError, mkdir, cpus = 2} = {}) {
  const calls = [], notifications = [];
  const start = source.indexOf('async function mapWithConcurrency<');
  const end = source.indexOf('/**\n * central class', start);
  assert(start > 0 && end > start);
  // Execute the real transfer method and its real concurrency helper. Only the
  // filesystem/API imports are owned stubs; no constructor or native I/O runs.
  const concurrency = stripTypeScriptTypes(source.slice(start, end), {mode: 'transform'});
  const globals = {path: path.win32, os: {cpus: () => Array.from({length: cpus}, () => ({}))}, SelfCopyCheckError,
    getErrorCode: e => e?.code, getErrorMessage: e => e?.message,
    log: (...args) => calls.push(['log', ...args]),
    fs: {
      ensureDirAsync: name => {calls.push(['mkdir', name]); if (mkdir) return mkdir(name); if (mkdirError) throw mkdirError; return Promise.resolve();},
      linkAsync: async (src, dst) => {calls.push(['link', src, dst]); if (link) return link(src, dst); if (linkError) throw linkError;},
      copyAsync: async (src, dst) => {calls.push(['copy', src, dst]); if (copy) return copy(src, dst); if (copyError) throw copyError;},
      removeAsync: async name => {calls.push(['remove', name]); if (removeError) throw removeError;},
    }};
  const Manager = vm.runInNewContext(concurrency + '\n' + extractClassDeclaration(source) + '\nInstallManager;', globals, {timeout: 1000});
  const manager = Object.create(Manager.prototype);
  const api = {translate: value => value, showErrorNotification: (...args) => notifications.push(args)};
  const run = (copies = [{source: 'a.txt', destination: 'a.txt'}]) =>
    manager.extractArchive(api, 'F:/Downloads/Own.zip', 'F:/Stage/Own.installing', 'F:/Stage/Own', copies, 'cyberpunk2077');
  return {calls, notifications, run};
}
