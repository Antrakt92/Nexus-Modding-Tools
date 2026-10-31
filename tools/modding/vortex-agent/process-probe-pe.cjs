'use strict';
const {types} = require('node:util');
const MAX_BYTES = 32 * 1024 * 1024, MAX_IMPORTS = 4096;
const allowed = new Set(['kernel32.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll']);
const need = ok => {if (!ok) throw Error('PROCESS_PROBE_PE_INVALID');};

/**
 * Bounded AMD64 PE32+ declared-import inspection, not a loader, signature check,
 * CRT-linkage proof or runtime DLL-resolution/OS-compatibility qualification.
 * Delay imports are only range-checked and always disqualify systemImportsOnly.
 */
function inspectProcessProbePE(bytes) {
  need(!types.isProxy(bytes) && types.isUint8Array(bytes) && Buffer.isBuffer(bytes)
    && Object.getPrototypeOf(bytes) === Buffer.prototype);
  for (const key of ['length', 'byteLength', 'buffer', 'byteOffset']) need(!Object.hasOwn(bytes, key));
  // Concurrent writers could otherwise change header/range claims mid-parse.
  need(!types.isSharedArrayBuffer(bytes.buffer));
  const size = bytes.length;
  need(size >= 64 && size <= MAX_BYTES);
  const range = (offset, length) => need(Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length >= 0 && offset + length <= size);
  const u16 = offset => {range(offset, 2); return Buffer.prototype.readUInt16LE.call(bytes, offset);};
  const u32 = offset => {range(offset, 4); return Buffer.prototype.readUInt32LE.call(bytes, offset);};
  need(u16(0) === 0x5a4d);
  const pe = u32(0x3c); range(pe, 24);
  need(pe >= 64 && pe % 4 === 0 && u32(pe) === 0x4550 && u16(pe + 4) === 0x8664);
  const count = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24;
  need(count > 0 && count <= 96 && optionalSize >= 112); range(optional, optionalSize);
  need(u16(optional) === 0x20b);
  const directories = u32(optional + 108), table = optional + optionalSize;
  need(directories <= 16 && 112 + directories * 8 <= optionalSize); range(table, count * 40);
  const imageSize = u32(optional + 56), headers = u32(optional + 60);
  const sectionAlign = u32(optional + 32), fileAlign = u32(optional + 36);
  const power = value => value > 0 && (value & (value - 1)) === 0;
  need(power(sectionAlign) && power(fileAlign) && fileAlign >= 512 && fileAlign <= 65536
    && sectionAlign >= fileAlign && imageSize > 0 && imageSize % sectionAlign === 0
    && headers >= table + count * 40 && headers <= size && headers % fileAlign === 0 && imageSize >= headers);
  const imageBase = Buffer.prototype.readBigUInt64LE.call(bytes, optional + 24);
  need(imageBase + BigInt(imageSize) <= (1n << 64n));
  const sections = [];
  for (let i = 0; i < count; i++) {
    const entry = table + i * 40, virtual = u32(entry + 8), rva = u32(entry + 12);
    const raw = u32(entry + 16), offset = u32(entry + 20), span = Math.max(virtual, raw);
    need(span > 0 && rva >= headers && rva % sectionAlign === 0 && rva + span <= imageSize);
    if (raw) {range(offset, raw); need(offset >= headers && offset % fileAlign === 0 && raw % fileAlign === 0);}
    else need(offset === 0);
    const section = {rva, span, raw, offset};
    for (const prior of sections) {
      need(rva + span <= prior.rva || prior.rva + prior.span <= rva);
      if (raw && prior.raw) need(offset + raw <= prior.offset || prior.offset + prior.raw <= offset);
    }
    sections.push(section);
  }
  const map = (rva, length) => {
    need(Number.isSafeInteger(rva) && rva >= 0 && length > 0 && rva + length <= 0x100000000);
    const candidates = sections.filter(s => rva >= s.rva && rva + length <= s.rva + s.raw)
      .map(s => ({offset: s.offset + rva - s.rva, end: s.offset + s.raw}));
    if (rva + length <= headers) candidates.push({offset: rva, end: headers});
    need(candidates.length === 1); range(candidates[0].offset, length); return candidates[0];
  };
  const directory = index => index < directories
    ? {rva: u32(optional + 112 + index * 8), size: u32(optional + 116 + index * 8)} : {rva: 0, size: 0};
  // Check declared directory ranges, not their internal semantic structures.
  // Certificate-table addresses are file offsets, unlike the other directories.
  for (let i = 0; i < directories; i++) {
    const entry = directory(i);
    if (!entry.rva && !entry.size) continue;
    need(entry.rva > 0 && (entry.size > 0 || i === 8));
    if (i === 4) range(entry.rva, entry.size);
    else map(entry.rva, entry.size || 1);
  }
  const dll = rva => {
    const location = map(rva, 1); let name = '';
    for (let at = location.offset; at < Math.min(location.end, location.offset + 261); at++) {
      const unit = bytes[at];
      if (unit === 0) {
        need(/^[A-Za-z0-9][A-Za-z0-9._-]*\.dll$/i.test(name)); return name.toLowerCase();
      }
      need(unit >= 0x21 && unit <= 0x7e); name += String.fromCharCode(unit);
    }
    need(false);
  };
  const imports = new Set(), ordinary = directory(1), delay = directory(13);
  if (ordinary.rva) {
    need(ordinary.size >= 20); const start = map(ordinary.rva, ordinary.size).offset;
    let terminated = false;
    for (let i = 0, at = start; i <= MAX_IMPORTS && at + 20 <= start + ordinary.size; i++, at += 20) {
      const row = [u32(at), u32(at + 4), u32(at + 8), u32(at + 12), u32(at + 16)];
      if (row.every(value => value === 0)) {terminated = true; break;}
      need(i < MAX_IMPORTS && row[3] > 0 && row[4] > 0);
      if (row[0]) map(row[0], 8);
      map(row[4], 8); imports.add(dll(row[3]));
    }
    need(terminated);
  }
  const delayImportsPresent = delay.rva !== 0;
  if (delayImportsPresent) need(delay.size >= 32);
  const names = Object.freeze([...imports].sort());
  return Object.freeze({machine: 'amd64', format: 'PE32+', imports: names, delayImportsPresent,
    systemImportsOnly: names.length > 0 && !delayImportsPresent && names.every(name => allowed.has(name))});
}

module.exports = Object.freeze({inspectProcessProbePE});
