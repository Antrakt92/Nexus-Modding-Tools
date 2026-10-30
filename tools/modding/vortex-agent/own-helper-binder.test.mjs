import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectOwnZip, prepareOwnHelper, SUPPORTED_FAMILY, LIMITS } from './own-helper-binder.mjs';
import { verifyHelper, createHelperContents } from './prepare-native-helper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), scratch = path.resolve(here, '../../../local-state');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = value => JSON.stringify(value, null, 2) + '\n';
function zip(entries) {
  const locals = [], centers = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content ?? 'payload'), method = entry.method ?? 8;
    const compressed = method === 0 ? content : deflateRawSync(content);
    const packed = entry.tail ? Buffer.concat([compressed, Buffer.from(entry.tail)]) : compressed, flags = entry.flags ?? 0;
    const localExtra = entry.localExtra ?? Buffer.alloc(0), centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30), center = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    center.writeUInt32LE(0x02014b50); center.writeUInt16LE(20, 4); center.writeUInt16LE(20, 6); center.writeUInt16LE(flags, 8); center.writeUInt16LE(method, 10);
    center.writeUInt32LE(crc32(content), 16); center.writeUInt32LE(packed.length, 20); center.writeUInt32LE(content.length, 24);
    center.writeUInt16LE(name.length, 28); center.writeUInt32LE(entry.attributes ?? 0, 38); center.writeUInt32LE(offset, 42);
    center.writeUInt16LE(centralExtra.length, 30);
    locals.push(local, name, localExtra, packed); centers.push(center, name, centralExtra); offset += local.length + name.length + localExtra.length + packed.length;
  }
  const central = Buffer.concat(centers), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'own-binder-test-'));
  t.after(() => { assert(root.startsWith(scratch + path.sep)); fs.rmSync(root, { recursive: true }); });
  const archive = path.join(root, 'Own-Example-LOCAL.zip'); fs.writeFileSync(archive, zip([{ name: 'r6/scripts/Own/Example.reds' }]));
  const proof = inspectOwnZip(fs.readFileSync(archive));
  const pkg = { key: 'own-Example', archive, fileName: path.basename(archive), expectedModId: 'Own-Example-LOCAL',
    bytes: proof.bytes, sha256: proof.sha256, md5: proof.md5, expectedUncompressedBytes: proof.expectedUncompressedBytes, payload: { ...proof.payload } };
  const source = path.join(root, 'variant.json');
  fs.writeFileSync(source, text({ schemaVersion: 1, variantKind: 'script-core', payloadSHA256: proof.payload }));
  const original = path.join(root, 'build-result.json'); fs.writeFileSync(original, text({ fixtureOnly: true }));
  const receipt = path.join(root, 'build-evidence.json'), receiptPackage = { ...pkg }; delete receiptPackage.archive;
  fs.writeFileSync(receipt, text({ schema: 'own-local-build-evidence/1', projectId: 'example/own', sourceCommit: 'a'.repeat(40),
    sourceManifestSHA256: sha(fs.readFileSync(source)), package: receiptPackage, retainedPayload: [],
    evidence: [{ path: original, sha256: sha(fs.readFileSync(original)) }] }));
  const plan = { schema: 'own-local-helper-plan/1', family: SUPPORTED_FAMILY.id, gameId: SUPPORTED_FAMILY.gameId,
    targetProfileId: SUPPORTED_FAMILY.profileId, expectedHostVersion: SUPPORTED_FAMILY.hostVersion,
    sourceHostSHA256: SUPPORTED_FAMILY.appAsarSHA256, package: pkg,
    provenance: { projectId: 'example/own', sourceCommit: 'a'.repeat(40), sourceManifest: { path: source, sha256: sha(fs.readFileSync(source)) },
      buildReceipt: { path: receipt, sha256: sha(fs.readFileSync(receipt)) } } };
  const planFile = path.join(root, 'plan.json'), output = path.join(root, 'held');
  const save = () => { const bytes = Buffer.from(text(plan)); fs.writeFileSync(planFile, bytes); return sha(bytes); };
  return { root, plan, planFile, output, save, original, receipt, source,
    args: () => ({ reference: process.env.VORTEX_OWN_HELPER_REFERENCE ?? path.join(root, 'no-reference'),
      planFile, output, planSHA256: save() }) };
}

test('bounded ZIP proof checks actual bytes, hashes, CRC and the complete payload without extraction', () => {
  const bytes = zip([{ name: 'r6/scripts/Own/a.reds', content: 'first' }, { name: 'bin/x64/Own.dll', content: 'second', method: 0 }]);
  const result = inspectOwnZip(bytes);
  assert.equal(result.sha256, sha(bytes)); assert.equal(result.bytes, bytes.length);
  assert.equal(result.expectedUncompressedBytes, 11); assert.equal(result.payloadFiles, 2); assert.equal(result.crcVerified, true);
  assert.deepEqual({ ...result.payload }, { 'r6/scripts/Own/a.reds': sha('first'), 'bin/x64/Own.dll': sha('second') });
  const reserved = inspectOwnZip(zip([{ name: '__proto__', content: 'retained' }]));
  assert.equal(Object.hasOwn(reserved.payload, '__proto__'), true); assert.equal(reserved.payload.__proto__, sha('retained'));
});
test('ZIP paths reject traversal, Windows aliases/devices, Unicode, FOMOD and override instructions', () => {
  for (const name of ['../escape', '/absolute', 'C:/absolute', 'r6/a:stream', 'r6/a\\b', 'r6/NUL.txt', 'r6/file.',
    'r6/file ', 'r6//a', 'r6/./a', 'r6/' + 'a'.repeat(256), 'r6/путь', 'fomod/ModuleConfig.xml', 'r6/vortex_override_instructions.json'])
    assert.throws(() => inspectOwnZip(zip([{ name }])), /OWN_BINDER_UNSAFE_PAYLOAD_PATH|OWN_BINDER_UNSUPPORTED_INSTALLER/);
  for (const names of [['r6/a', 'R6/A'], ['r6/a', 'r6/a/b'], ['r6/a', 'r6/a']])
    assert.throws(() => inspectOwnZip(zip(names.map(name => ({ name })))), /OWN_BINDER_DUPLICATE_ZIP_PATH/);
  assert.throws(() => inspectOwnZip(zip([{ name: 'R6/a' }, { name: 'r6/b' }])), /OWN_BINDER_CASE_COLLISION/);
});
test('ZIP proof refuses encrypted/described/special/unsupported/corrupt or oversized archives', () => {
  for (const entry of [{ flags: 1 }, { flags: 8 }, { method: 12 }, { attributes: (0xa000 << 16) >>> 0 }])
    assert.throws(() => inspectOwnZip(zip([{ name: 'r6/file', ...entry }])), /OWN_BINDER_UNSUPPORTED_ZIP/);
  assert.throws(() => inspectOwnZip(zip([{ name: 'r6/file', attributes: 0x10 }])), /OWN_BINDER_UNSUPPORTED_ZIP/);
  const corrupt = zip([{ name: 'r6/file', method: 0 }]); corrupt[30 + 'r6/file'.length] ^= 1;
  assert.throws(() => inspectOwnZip(corrupt), /OWN_BINDER_ZIP_CONTENT_INVALID/);
  assert.throws(() => inspectOwnZip(zip([{ name: 'r6/file', tail: 'trailing data' }])), /OWN_BINDER_ZIP_CONTENT_INVALID/);
  const over = zip([{ name: 'r6/file' }]); const central = over.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  over.writeUInt32LE(LIMITS.entryBytes + 1, central + 24);
  assert.throws(() => inspectOwnZip(over), /OWN_BINDER_UNSUPPORTED_ZIP/);
  assert.throws(() => inspectOwnZip(Buffer.alloc(LIMITS.archiveBytes + 1)), /OWN_BINDER_ARCHIVE_LIMIT/);
});
test('ZIP alternate-name/Unix and unreviewed timestamp extras cannot change the verified path projection', () => {
  for (const kind of [0x7075, 0x554e, 0x756e, 0x0001, 0x5455]) {
    const data = Buffer.from('fomod/ModuleConfig.xml'), extra = Buffer.alloc(4 + data.length);
    extra.writeUInt16LE(kind); extra.writeUInt16LE(data.length, 2); data.copy(extra, 4);
    for (const field of ['localExtra', 'centralExtra'])
      assert.throws(() => inspectOwnZip(zip([{ name: 'r6/visible.reds', [field]: extra }])), /OWN_BINDER_UNSUPPORTED_ZIP/);
  }
});
test('unknown plan fields, host/profile/family and duplicate JSON keys fail before reference preparation', t => {
  for (const patch of [{ targetProfileId: 'another' }, { expectedHostVersion: '2.9.2' }, { family: 'generic' }, { activationApproved: true }]) {
    const f = fixture(t); Object.assign(f.plan, patch);
    assert.throws(() => prepareOwnHelper(f.args()), /OWN_BINDER_PLAN_REQUIRED|OWN_BINDER_UNSUPPORTED_FAMILY/);
    assert(!fs.existsSync(f.output));
  }
  const f = fixture(t), args = f.args();
  const bytes = Buffer.from(text(f.plan).replace('"schema":', '"schema":"duplicate",\n  "schema":'));
  fs.writeFileSync(f.planFile, bytes); args.planSHA256 = sha(bytes);
  assert.throws(() => prepareOwnHelper(args), /OWN_BINDER_INVALID_JSON/);
});
test('plan pin, new output and ordinary path checks reject before any output write', t => {
  const f = fixture(t), args = f.args();
  assert.throws(() => prepareOwnHelper({ ...args, planSHA256: '0'.repeat(64) }), /OWN_BINDER_PLAN_PIN_MISMATCH/);
  fs.mkdirSync(f.output); assert.throws(() => prepareOwnHelper(args), /OWN_BINDER_NEW_OUTPUT_REQUIRED/);
  assert.deepEqual(fs.readdirSync(f.output), []);
});
test('binder rejects root proto payload unsupported by the pinned runtime tree', t => {
  const f = fixture(t); f.plan.package.payload = JSON.parse('{"__proto__":"' + 'a'.repeat(64) + '"}');
  assert.throws(() => prepareOwnHelper(f.args()), /OWN_BINDER_UNSUPPORTED_PAYLOAD/); assert(!fs.existsSync(f.output));
  f.plan.package.payload = { 'r6/__folder_managed_by_vortex': 'a'.repeat(64) };
  assert.throws(() => prepareOwnHelper(f.args()), /OWN_BINDER_UNSUPPORTED_PAYLOAD/); assert(!fs.existsSync(f.output));
});
test('even a coherent receipt cannot assign an owner different from pinned native archive-name derivation', t => {
  const f = fixture(t), receipt = JSON.parse(fs.readFileSync(f.receipt));
  f.plan.package.expectedModId = 'Different-owner'; receipt.package.expectedModId = 'Different-owner';
  fs.writeFileSync(f.receipt, text(receipt)); f.plan.provenance.buildReceipt.sha256 = sha(fs.readFileSync(f.receipt));
  assert.throws(() => prepareOwnHelper(f.args()), /OWN_BINDER_NATIVE_OWNER_DIFFERS/); assert(!fs.existsSync(f.output));
});

test('actual pinned own-local family retargets the whole verified package into an inert complete code kit',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    const f = fixture(t), args = f.args(), before = fs.readdirSync(f.root).sort();
    const plan = prepareOwnHelper(args); assert.equal(plan.status, 'plan'); assert.equal(plan.installReady, false);
    assert.deepEqual(fs.readdirSync(f.root).sort(), before); assert(!fs.existsSync(f.output));
    if (process.platform !== 'win32') return;
    const result = prepareOwnHelper({ ...args, apply: true }); assert.equal(result.status, 'own-helper-held');
    assert.equal(verifyHelper(f.output).status, 'code-contract-verified');
    const cfg = JSON.parse(fs.readFileSync(path.join(f.output, 'reviewed.prepared.json')));
    assert.deepEqual(cfg.packages, [{ ...f.plan.package, expectedEnabled: false, oldEnabledModIds: [], expectedType: '' }]);
    assert.equal(cfg.health, null); assert.equal(cfg.pluginPath, null);
    for (const name of ['baselineFile', 'sourcePins', 'processGuard', 'interlocks', 'nativeTempPath', 'sourceParityPins', 'reviewedPeerExtensions'])
      assert.equal(cfg[name], null, name);
    for (const name of ['reviewed.json', 'READY.prepared.json', 'frozen.json', 'root-ready.json', 'host.prepared.ps1', 'test-engine.cjs'])
      assert(!fs.existsSync(path.join(f.output, name)), name);
    const map = JSON.parse(fs.readFileSync(path.join(f.output, 'COPY-MAP.prepared.json')));
    assert.equal(map.length, Object.keys(cfg.modulePins).length + 3);
    assert(map.some(r => r.source === 'info.prepared.json' && r.sha256 === null));
    const proof = JSON.parse(fs.readFileSync(path.join(f.output, 'BINDER-PROOF.json')));
    assert.equal(proof.sourceReferenceSHA256, SUPPORTED_FAMILY.entrySHA256); assert.equal(proof.planSHA256, args.planSHA256);
    assert.equal(proof.sourceBuildAcceptanceRequiresReview, true); assert.equal(proof.sourceBuildAcceptanceVerified, false);
    const scope = execFileSync(process.execPath, [path.join(f.output, 'test-package-scope.cjs')], { encoding: 'utf8' });
    assert.equal(JSON.parse(scope).actualPreparedPackageScopeVerified, true);
  });
test('reference drift, prior controls and old hidden bindings cannot be adopted',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    const f = fixture(t), args = f.args(), reference = path.join(f.root, 'reference'); fs.mkdirSync(reference);
    for (const name of ['index.prepared.js', ...Object.keys(SUPPORTED_FAMILY.modules)])
      fs.copyFileSync(path.join(args.reference, name), path.join(reference, name));
    const local = { ...args, reference };
    for (const name of ['reviewed.json', 'READY.prepared.json', 'frozen.json', 'root-ready.json', 'capture-ready.json',
      'attempt.json.pending', 'preflight-failed.json', 'completed.json', 'HOST-start.json']) {
      const file = path.join(reference, name); fs.writeFileSync(file, '{}');
      assert.throws(() => prepareOwnHelper(local), /OWN_BINDER_ATTEMPTED_REFERENCE_REFUSED/); fs.unlinkSync(file);
    }
    fs.writeFileSync(path.join(reference, 'reviewed.prepared.json'), text({ oldLiveSentinel: 'must never be copied' }));
    if (process.platform === 'win32') {
      prepareOwnHelper({ ...local, apply: true });
      const config = JSON.parse(fs.readFileSync(path.join(f.output, 'reviewed.prepared.json')));
      assert(!Object.hasOwn(config, 'oldLiveSentinel'));
    }
    fs.appendFileSync(path.join(reference, 'engine.cjs'), '// changed');
    assert.throws(() => prepareOwnHelper({ ...local, output: path.join(f.root, 'drift') }), /OWN_BINDER_REFERENCE_DRIFT/);
  });
test('changed package/evidence/provenance are rejected before creating a kit',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    for (const mode of ['md5', 'uncompressed', 'payload', 'receipt', 'original', 'archive']) {
      const f = fixture(t), args = f.args();
      if (mode === 'md5') f.plan.package.md5 = '0'.repeat(32);
      if (mode === 'uncompressed') f.plan.package.expectedUncompressedBytes++;
      if (mode === 'payload') f.plan.package.payload['r6/scripts/Own/Example.reds'] = '0'.repeat(64);
      if (mode === 'receipt') fs.appendFileSync(f.receipt, ' ');
      if (mode === 'original') fs.appendFileSync(f.original, ' ');
      if (mode === 'archive') fs.appendFileSync(f.plan.package.archive, ' ');
      args.planSHA256 = f.save();
      assert.throws(() => prepareOwnHelper(args), /OWN_BINDER_BUILD_RECEIPT_DIFFERS|OWN_BINDER_SOURCE_MANIFEST_DIFFERS|OWN_BINDER_EVIDENCE_CHANGED|OWN_BINDER_UNSUPPORTED_ZIP/);
      assert(!fs.existsSync(f.output));
    }
  });
test('ordinary JSON formatting and reordered receipt package fields preserve raw-pin validation',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    const f = fixture(t), args = f.args(), receipt = JSON.parse(fs.readFileSync(f.receipt));
    receipt.package = Object.fromEntries(Object.entries(receipt.package).reverse());
    fs.writeFileSync(f.receipt, JSON.stringify(receipt).replace('example/own', 'ex\\u0061mple/own'));
    f.plan.provenance.buildReceipt.sha256 = sha(fs.readFileSync(f.receipt));
    fs.writeFileSync(f.planFile, text(f.plan).replaceAll('\n', '\r\n')); args.planSHA256 = sha(fs.readFileSync(f.planFile));
    assert.equal(prepareOwnHelper(args).status, 'plan'); assert(!fs.existsSync(f.output));
  });
test('explicit retained components must cover exactly the payload missing from the primary source manifest',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    for (const mode of ['valid', 'missing', 'overlap', 'extra', 'changed', 'unused', 'duplicate']) {
      const f = fixture(t), args = f.args(), primary = JSON.parse(fs.readFileSync(f.source));
      const name = 'r6/scripts/Own/Example.reds';
      // Keep one primary source entry and add one independently retained file.
      fs.writeFileSync(f.plan.package.archive, zip([{ name }, { name: 'bin/x64/Keep.dll', content: 'native' }]));
      const proof = inspectOwnZip(fs.readFileSync(f.plan.package.archive));
      Object.assign(f.plan.package, { bytes: proof.bytes, sha256: proof.sha256, md5: proof.md5,
        expectedUncompressedBytes: proof.expectedUncompressedBytes, payload: { ...proof.payload } });
      const retainedFile = path.join(f.root, 'retained.json');
      fs.writeFileSync(retainedFile, text({ payloadSHA256: { 'bin/x64/Keep.dll': proof.payload['bin/x64/Keep.dll'] } }));
      const receipt = JSON.parse(fs.readFileSync(f.receipt)), receiptPackage = { ...f.plan.package }; delete receiptPackage.archive;
      receipt.package = receiptPackage;
      const component = { manifest: { path: retainedFile, sha256: sha(fs.readFileSync(retainedFile)) }, paths: ['bin/x64/Keep.dll'] };
      receipt.retainedPayload = [component];
      if (mode === 'missing') receipt.retainedPayload = [];
      if (mode === 'overlap') component.paths = [name];
      if (mode === 'extra') component.paths.push('bin/x64/Extra.dll');
      if (mode === 'changed') {
        fs.writeFileSync(retainedFile, text({ payloadSHA256: { 'bin/x64/Keep.dll': '0'.repeat(64) } }));
        component.manifest.sha256 = sha(fs.readFileSync(retainedFile));
      }
      if (mode === 'unused') component.paths = [];
      if (mode === 'duplicate') receipt.retainedPayload.push(structuredClone(component));
      fs.writeFileSync(f.receipt, text(receipt)); f.plan.provenance.buildReceipt.sha256 = sha(fs.readFileSync(f.receipt)); args.planSHA256 = f.save();
      assert.deepEqual(primary.payloadSHA256, { [name]: proof.payload[name] });
      if (mode === 'valid') assert.equal(prepareOwnHelper(args).status, 'plan');
      else assert.throws(() => prepareOwnHelper(args), /OWN_BINDER_RETAINED_PAYLOAD_DIFFERS|OWN_BINDER_SOURCE_COVERAGE_INCOMPLETE/);
      assert(!fs.existsSync(f.output));
    }
  });
test('shared content constructor has no filesystem reads and cannot mutate trusted maintained buffers',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE }, t => {
    const f = fixture(t), reference = process.env.VORTEX_OWN_HELPER_REFERENCE;
    const input = fs.readFileSync(path.join(reference, 'index.prepared.js'));
    const config = JSON.parse(fs.readFileSync(path.join(reference, 'reviewed.prepared.json')));
    const modules = new Map(Object.keys(config.modulePins).map(n => [n, fs.readFileSync(path.join(reference, n))]));
    const args = { input, config, modules, output: f.output, sourceSha256: sha(input) }, read = fs.readFileSync;
    let first, second;
    fs.readFileSync = () => { throw Error('CONSTRUCTOR_READ_FS'); };
    try {
      first = createHelperContents(args); first.get('physical-proof.cjs').fill(0); first.get('settlement.cjs').fill(0);
      second = createHelperContents(args);
    } finally { fs.readFileSync = read; }
    assert(!first.get('physical-proof.cjs').equals(second.get('physical-proof.cjs')));
    assert.equal(second.get('settlement.cjs').toString(), "'use strict';\nmodule.exports = require('./native-install-wait.cjs');\n");
    assert.equal(sha(second.get('physical-proof.cjs')), sha(fs.readFileSync(path.join(here, 'physical-proof.cjs'))));
  });
test('import-time maintained owner drift fails final verification before publication without refreshing pins',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE || process.platform !== 'win32' }, t => {
    const f = fixture(t), args = f.args(), read = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => path.resolve(file) === path.join(here, 'physical-proof.cjs')
      ? Buffer.from('simulated changed maintained source') : read(file, ...rest);
    try { assert.throws(() => prepareOwnHelper({ ...args, apply: true }), /STALE_HELPER_KIT/); }
    finally { fs.readFileSync = read; }
    assert(!fs.existsSync(f.output)); assert(!fs.readdirSync(f.root).some(n => n.startsWith('.own-helper-')));
  });
test('atomic publication preserves existing or concurrently created destinations and changed inputs',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE || process.platform !== 'win32' }, t => {
    const f = fixture(t), args = f.args(), rename = fs.renameSync;
    let racedIdentity;
    fs.renameSync = (source, target) => { fs.mkdirSync(target); racedIdentity = fs.statSync(target, { bigint: true }).ino; return rename(source, target); };
    try { assert.throws(() => prepareOwnHelper({ ...args, apply: true })); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.statSync(f.output, { bigint: true }).ino, racedIdentity); assert.deepEqual(fs.readdirSync(f.output), []);
    assert(!fs.readdirSync(f.root).some(n => n.startsWith('.own-helper-')));
    const changed = fixture(t), input = changed.args(), mkdtemp = fs.mkdtempSync;
    fs.mkdtempSync = (...values) => { const temp = mkdtemp(...values); fs.appendFileSync(changed.plan.package.archive, 'changed'); return temp; };
    try { assert.throws(() => prepareOwnHelper({ ...input, apply: true }), /OWN_BINDER_INPUT_CHANGED/); }
    finally { fs.mkdtempSync = mkdtemp; }
    assert(!fs.existsSync(changed.output)); assert(!fs.readdirSync(changed.root).some(n => n.startsWith('.own-helper-')));
  });
test('partial owned writes can be cleaned but foreign replacements and packet additions are held',
  { skip: !process.env.VORTEX_OWN_HELPER_REFERENCE || process.platform !== 'win32' }, t => {
    const partial = fixture(t), write = fs.writeFileSync; let injected = false;
    fs.writeFileSync = (file, data, ...rest) => {
      if (typeof file === 'number' && !injected) {
        injected = true; write(file, data.subarray(0, 3)); throw Object.assign(Error('full fixture disk'), { code: 'ENOSPC' });
      }
      return write(file, data, ...rest);
    };
    try { assert.throws(() => prepareOwnHelper({ ...partial.args(), apply: true }), /full fixture disk/); }
    finally { fs.writeFileSync = write; }
    assert(!fs.existsSync(partial.output)); assert(!fs.readdirSync(partial.root).some(n => n.startsWith('.own-helper-')));
    for (const mode of ['replace-directory', 'replace-file', 'modify-file', 'add-file']) {
      const f = fixture(t), args = f.args(), read = fs.readFileSync; let temp;
      fs.readFileSync = (file, ...rest) => {
        if (!temp && path.basename(String(file)) === 'HELPER-KIT.json' && path.dirname(String(file)).includes('.own-helper-')) {
          temp = path.dirname(String(file));
          if (mode === 'replace-directory') {
            fs.renameSync(temp, temp + '-displaced'); fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, 'engine.cjs'), 'foreign');
          } else if (mode === 'replace-file') {
            fs.unlinkSync(path.join(temp, 'engine.cjs')); fs.writeFileSync(path.join(temp, 'engine.cjs'), 'foreign');
          } else if (mode === 'modify-file') fs.appendFileSync(path.join(temp, 'engine.cjs'), 'foreign');
          else fs.writeFileSync(path.join(temp, 'foreign.txt'), 'foreign');
        }
        return read(file, ...rest);
      };
      try { assert.throws(() => prepareOwnHelper({ ...args, apply: true }), /OWN_BINDER_TEMP_CLEANUP_HELD/); }
      finally { fs.readFileSync = read; }
      assert(!fs.existsSync(f.output)); assert(temp && fs.existsSync(temp));
      if (mode === 'add-file') assert.equal(fs.readFileSync(path.join(temp, 'foreign.txt'), 'utf8'), 'foreign');
      else assert(fs.readFileSync(path.join(temp, 'engine.cjs'), 'utf8').includes('foreign'));
    }
  });
test('public CLI sanitizes filesystem failures without exposing local paths', t => {
  const f = fixture(t), args = f.args();
  assert.throws(() => execFileSync(process.execPath, [path.join(here, 'own-helper-binder.mjs'), '--reference', path.join(f.root, 'missing-reference'),
    '--plan', args.planFile, '--plan-sha256', args.planSHA256, '--output', args.output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  error => { assert.equal(error.stderr, 'OWN_BINDER_PREPARATION_FAILED\n'); return true; });
});
