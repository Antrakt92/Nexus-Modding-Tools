import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import strictJSON from './strict-json.cjs';

export const identity = stat => `${stat.dev}:${stat.ino}`;
export const generation = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');

// Internal synchronous record I/O shared by the two journal schemas. File flush
// and exact readback do not establish power-loss durability of directory entries.
export function createImmutableRecordIO({maxBytes, prefix}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024
      || typeof prefix !== 'string' || !/^[A-Z_]+_$/.test(prefix)) throw Error('IMMUTABLE_RECORD_INVALID_OPTIONS');
  const need = (ok, code) => {if (!ok) throw Error(prefix + code);};
  function ancestry(value, create = false) {
    const nodes = new Map(), chain = [];
    for (let p = value; ; p = path.dirname(p)) {chain.unshift(p); if (p === path.dirname(p)) break;}
    for (const dir of chain) {
      let stat;
      try {stat = fs.lstatSync(dir, {bigint: true});}
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        try {fs.mkdirSync(dir, {mode: 0o700});}
        catch (error) {if (error.code !== 'EEXIST') throw error;}
        stat = fs.lstatSync(dir, {bigint: true});
      }
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH'); nodes.set(dir, identity(stat));
    }
    return nodes;
  }
  function sameAncestry(value, pins) {
    const current = ancestry(value);
    need(current && current.size === pins.size && [...pins].every(([p, node]) => current.get(p) === node), 'PATH_CHANGED');
  }
  function readJSON(file, observations, expected) {
    const stat = fs.lstatSync(file, {bigint: true});
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BigInt(maxBytes), 'CORRUPT');
    const fd = fs.openSync(file, 'r');
    try {
      const before = fs.fstatSync(fd, {bigint: true});
      need(generation(before) === generation(stat), 'PATH_CHANGED');
      const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0, count;
      while (used < bytes.length && (count = fs.readSync(fd, bytes, used, bytes.length - used, null)) > 0) used += count;
      need(used === Number(before.size) && generation(fs.fstatSync(fd, {bigint: true})) === generation(before)
        && generation(fs.lstatSync(file, {bigint: true})) === generation(before), 'PATH_CHANGED');
      if (expected) need(bytes.subarray(0, used).equals(expected), 'CHANGED');
      observations?.set(file, generation(before));
      try {return strictJSON.parseStrictJSON(bytes.subarray(0, used), {maxBytes});}
      catch {throw Error(prefix + 'CORRUPT');}
    } finally {fs.closeSync(fd);}
  }
  function publish(dir, name, bytes, pins, guard) {
    need(typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)
      && Buffer.isBuffer(bytes) && bytes.length <= maxBytes, 'INVALID_RECORD');
    guard();
    const pending = path.join(dir, '.' + name + '.pending-' + crypto.randomUUID()), final = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(pending, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      const after = fs.fstatSync(fd, {bigint: true}), pendingStat = fs.lstatSync(pending, {bigint: true});
      sameAncestry(dir, pins);
      need(after.isFile() && after.size === BigInt(bytes.length) && generation(after) === generation(pendingStat), 'CHANGED');
      fs.linkSync(pending, final);
      need(identity(fs.lstatSync(final, {bigint: true})) === identity(after)
        && identity(fs.lstatSync(pending, {bigint: true})) === identity(after), 'CHANGED');
      fs.unlinkSync(pending);
      const complete = fs.lstatSync(final, {bigint: true});
      need(complete.isFile() && !complete.isSymbolicLink() && generation(complete) === generation(fs.fstatSync(fd, {bigint: true})), 'CHANGED');
      // Windows can finalize ChangeTime when the writer closes. Pin the final
      // reopened generation only after verifying all published bytes again.
      const closing = fd; fd = undefined; fs.closeSync(closing);
      const finalized = new Map(); readJSON(final, finalized, bytes);
      need(identity(fs.lstatSync(final, {bigint: true})) === identity(after), 'CHANGED');
      return finalized.get(final);
    } finally {if (fd !== undefined) fs.closeSync(fd);}
  }
  return Object.freeze({ancestry, sameAncestry, readJSON, publish});
}
