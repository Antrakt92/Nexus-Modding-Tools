'use strict';
const need = (ok, code) => { if (!ok) throw Error(code); };
function kind(runtime) {
  if (runtime.electron === undefined) return 'node:fs';
  need(runtime.platform === 'win32' && runtime.electron === '44.2.0' && runtime.node === '24.20.0', 'FILE_PROOF_ELECTRON_UNVERIFIED');
  return 'original-fs';
}
function getBackend() {
  const name = kind({platform: process.platform, electron: process.versions.electron, node: process.versions.node});
  let fs;
  try { fs = name === 'original-fs' ? require('original-fs') : require('node:fs'); }
  catch { throw Error('FILE_PROOF_PHYSICAL_BACKEND_UNAVAILABLE'); }
  need(['lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync', 'createReadStream'].every(k => typeof fs[k] === 'function'), 'FILE_PROOF_PHYSICAL_BACKEND_UNAVAILABLE');
  return { name, fs };
}
module.exports = { getBackend, _kindForTests: kind };
