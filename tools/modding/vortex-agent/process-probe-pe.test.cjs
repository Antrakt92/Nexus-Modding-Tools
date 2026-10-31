'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {inspectProcessProbePE: inspect} = require('./process-probe-pe.cjs');
const PE = 0x80, OPT = PE + 24, SECTION = OPT + 240, DIR = OPT + 112;
const raw = rva => 0x200 + rva - 0x1000;
function fixture(names = ['KERNEL32.dll', 'NTDLL.dll', 'kernel32.DLL', 'api-ms-win-core-synch-l1-2-0.dll']) {
  const bytes = Buffer.alloc(0xc00);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(PE, 0x3c);
  bytes.writeUInt32LE(0x4550, PE); bytes.writeUInt16LE(0x8664, PE + 4);
  bytes.writeUInt16LE(1, PE + 6); bytes.writeUInt16LE(240, PE + 20); bytes.writeUInt16LE(2, PE + 22);
  bytes.writeUInt16LE(0x20b, OPT); bytes.writeBigUInt64LE(0x140000000n, OPT + 24);
  bytes.writeUInt32LE(0x1000, OPT + 32); bytes.writeUInt32LE(0x200, OPT + 36);
  bytes.writeUInt32LE(0x3000, OPT + 56); bytes.writeUInt32LE(0x200, OPT + 60);
  bytes.writeUInt32LE(16, OPT + 108);
  bytes.write('.rdata', SECTION, 'ascii'); bytes.writeUInt32LE(0x1000, SECTION + 8);
  bytes.writeUInt32LE(0x1000, SECTION + 12); bytes.writeUInt32LE(0x800, SECTION + 16);
  bytes.writeUInt32LE(0x200, SECTION + 20);
  bytes.writeUInt32LE(0x1000, DIR + 8); bytes.writeUInt32LE((names.length + 1) * 20, DIR + 12);
  let stringRva = 0x1300;
  names.forEach((name, i) => {
    bytes.writeUInt32LE(0x1200 + i * 16, raw(0x1000) + i * 20);
    bytes.writeUInt32LE(stringRva, raw(0x1000) + i * 20 + 12);
    bytes.writeUInt32LE(0x1200 + i * 16, raw(0x1000) + i * 20 + 16);
    bytes.write(name + '\0', raw(stringRva), 'ascii'); stringRva += name.length + 1;
  });
  return bytes;
}
const invalid = value => assert.throws(() => inspect(value), /PROCESS_PROBE_PE_INVALID/);

test('shared mutable bytes cannot provide a stable import observation', () => {
  const value = fixture(), shared = Buffer.from(new SharedArrayBuffer(value.length));
  value.copy(shared); invalid(shared);
});

test('AMD64 PE32+ imports are normalized, unique, sorted and detached without a runtime claim', () => {
  const input = fixture(), value = inspect(input);
  assert.deepEqual(value, {machine: 'amd64', format: 'PE32+', imports: [
    'api-ms-win-core-synch-l1-2-0.dll', 'kernel32.dll', 'ntdll.dll'], delayImportsPresent: false, systemImportsOnly: true});
  assert(Object.isFrozen(value)); assert(Object.isFrozen(value.imports));
  input.fill(0); assert.equal(value.imports.length, 3);
  assert.deepEqual(Object.keys(value).sort(), ['delayImportsPresent', 'format', 'imports', 'machine', 'systemImportsOnly']);
  assert.throws(() => value.imports.push('other.dll'), TypeError);
});

test('policy is an exact nonempty OS allowlist, not a broad DLL regex or proof of static CRT linkage', () => {
  for (const name of ['VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'api-ms-win-core-file-l1-1-0.dll',
    'kernel32.dll.evil.dll', 'kernel32-extra.dll', 'msvcrt.dll']) {
    const value = inspect(fixture(['kernel32.dll', name]));
    assert(value.imports.includes(name.toLowerCase())); assert.equal(value.systemImportsOnly, false);
  }
  assert.equal(inspect(fixture(['kernel32.dll'])).systemImportsOnly, true);
  const none = fixture(); none.fill(0, DIR + 8, DIR + 16);
  assert.deepEqual(inspect(none).imports, []); assert.equal(inspect(none).systemImportsOnly, false);
});

test('DOS/PE architecture and complete optional/section headers are mandatory and bounded', () => {
  for (const change of [b => b.writeUInt16LE(0, 0), b => b.writeUInt32LE(0, PE),
    b => b.writeUInt32LE(0xfffffff0, 0x3c), b => b.writeUInt32LE(0x20, 0x3c),
    b => b.writeUInt16LE(0x14c, PE + 4), b => b.writeUInt16LE(0x10b, OPT),
    b => b.writeUInt16LE(0, PE + 6), b => b.writeUInt16LE(97, PE + 6),
    b => b.writeUInt16LE(0xffff, PE + 6), b => b.writeUInt16LE(100, PE + 20),
    b => b.writeUInt16LE(0xffff, PE + 20), b => b.writeUInt32LE(17, OPT + 108),
    b => b.writeUInt32LE(0xffffffff, OPT + 108), b => b.writeUInt16LE(112, PE + 20),
    b => b.writeUInt32LE(0x100, OPT + 60), b => b.writeUInt32LE(0x1000, OPT + 60),
    b => b.writeUInt32LE(0, OPT + 32), b => b.writeUInt32LE(3, OPT + 36)]) {
    const bytes = fixture(); change(bytes); invalid(bytes);
  }
  for (const length of [0, 63, PE + 23, OPT + 111, SECTION + 39]) invalid(fixture().subarray(0, length));
  invalid(Buffer.alloc(32 * 1024 * 1024 + 1));
});

test('RVA and raw-file ranges cannot overlap headers, alias another section, wrap or use virtual-only tails', () => {
  for (const change of [b => b.writeUInt32LE(0, SECTION + 12),
    b => b.writeUInt32LE(0x100, SECTION + 20), b => b.writeUInt32LE(0xfffffe00, SECTION + 20),
    b => b.writeUInt32LE(0xfffff000, SECTION + 12), b => b.writeUInt32LE(0xffffffff, SECTION + 8),
    b => b.writeUInt32LE(0xfffffe00, SECTION + 16), b => b.writeUInt32LE(0x1900, raw(0x1000) + 12),
    b => b.writeUInt32LE(0xffffffff, DIR + 8), b => b.writeUInt32LE(0xffffffff, DIR + 12),
    b => b.writeUInt32LE(0, DIR + 8), b => b.writeUInt32LE(0, DIR + 12)]) {
    const bytes = fixture(); change(bytes); invalid(bytes);
  }
  for (const virtualAlias of [true, false]) {
    const b = fixture(); b.writeUInt16LE(2, PE + 6);
    const second = SECTION + 40; b.writeUInt32LE(0x1000, second + 8);
    b.writeUInt32LE(virtualAlias ? 0x1000 : 0x2000, second + 12);
    b.writeUInt32LE(0x200, second + 16); b.writeUInt32LE(virtualAlias ? 0xa00 : 0x200, second + 20);
    invalid(b);
  }
});

test('64-bit image base is not truncated and image-end overflow is refused', () => {
  const valid = fixture(); valid.writeBigUInt64LE(0x1234567800000000n, OPT + 24);
  assert.equal(inspect(valid).machine, 'amd64');
  const overflow = fixture(); overflow.writeBigUInt64LE(0xfffffffffffff000n, OPT + 24);
  invalid(overflow);
});

test('import descriptor termination, Name and thunk pointers must be present and file-backed', () => {
  const missingTerminator = fixture(); missingTerminator.writeUInt32LE(80, DIR + 12); invalid(missingTerminator);
  for (const change of [b => b.writeUInt32LE(19, DIR + 12), b => b.writeUInt32LE(0, raw(0x1000) + 12),
    b => b.writeUInt32LE(0, raw(0x1000) + 16), b => b.writeUInt32LE(0x1900, raw(0x1000)),
    b => b.writeUInt32LE(0x1900, raw(0x1000) + 16)]) {
    const b = fixture(); change(b); invalid(b);
  }
  const fallbackIAT = fixture(); fallbackIAT.writeUInt32LE(0, raw(0x1000));
  assert.equal(inspect(fallbackIAT).systemImportsOnly, true);
});

test('DLL names must terminate inside one file-backed region and be plain bounded ASCII basenames', () => {
  for (const name of ['C:\\kernel32.dll', '../kernel32.dll', '/kernel32.dll', 'kernel32.dll ',
    'a:kernel32.dll', 'name.exe', '', 'bad\n.dll']) invalid(fixture([name]));
  const noTerminator = fixture(['x.dll']); noTerminator.fill(0x41, raw(0x1300), raw(0x1300) + 261); invalid(noTerminator);
  const end = fixture(); end.writeUInt32LE(0x17f8, raw(0x1000) + 12);
  end.write('other.dl', raw(0x17f8), 'ascii'); invalid(end);
  const nonAscii = fixture(); nonAscii[raw(0x1300)] = 0xff; invalid(nonAscii);
});

test('delay directory presence disqualifies policy without pretending to inspect its DLLs', () => {
  const value = fixture(); value.writeUInt32LE(0x1600, DIR + 13 * 8); value.writeUInt32LE(32, DIR + 13 * 8 + 4);
  const result = inspect(value); assert.equal(result.delayImportsPresent, true); assert.equal(result.systemImportsOnly, false);
  for (const [rva, size] of [[0x1900, 32], [0x1600, 31], [0, 32], [0x1600, 0], [0x1600, 0xffffffff]]) {
    const b = fixture(); b.writeUInt32LE(rva, DIR + 13 * 8); b.writeUInt32LE(size, DIR + 13 * 8 + 4); invalid(b);
  }
});

test('other directory ranges are checked and certificate address remains a file offset', () => {
  const cert = fixture(); cert.writeUInt32LE(0xa00, DIR + 4 * 8); cert.writeUInt32LE(0x100, DIR + 4 * 8 + 4);
  assert.equal(inspect(cert).systemImportsOnly, true);
  const bad = fixture(); bad.writeUInt32LE(0x1900, DIR + 6 * 8); bad.writeUInt32LE(28, DIR + 6 * 8 + 4); invalid(bad);
  const bss = fixture(); bss.writeUInt16LE(2, PE + 6); bss.writeUInt32LE(0x1000, SECTION + 40 + 8);
  bss.writeUInt32LE(0x2000, SECTION + 40 + 12);
  assert.equal(inspect(bss).systemImportsOnly, true);
});

test('input is an actual bounded Buffer and caller traps/accessors are not invoked', () => {
  let invoked = 0;
  for (const value of [null, undefined, {}, 'MZ', new Uint8Array(64), Object.create(Buffer.prototype)]) invalid(value);
  const proxy = new Proxy(fixture(), {get() {invoked++; throw Error('TRAP');}}); invalid(proxy);
  const input = fixture(); Object.defineProperty(input, 'length', {get() {invoked++; throw Error('GETTER');}}); invalid(input);
  const overridden = fixture(); Object.defineProperty(overridden, 'readUInt32LE', {get() {invoked++; throw Error('GETTER');}});
  assert.equal(inspect(overridden).systemImportsOnly, true); assert.equal(invoked, 0);
});
