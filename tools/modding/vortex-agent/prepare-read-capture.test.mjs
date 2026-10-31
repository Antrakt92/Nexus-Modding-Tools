import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareReadCapture, verifyReadCapture, main, SUPPORTED_READ_CAPTURE} from './prepare-read-capture.mjs';

const reference = process.env.VORTEX_OWN_READ_CAPTURE_REFERENCE;
const timestampPolicy = process.env.VORTEX_READ_CAPTURE_TIMESTAMP_POLICY;
const scratch = fileURLToPath(new URL('../../../local-state/', import.meta.url));
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: reference && timestampPolicy ? false : 'Provide the pinned Menu code reference and timestamp policy via VORTEX_OWN_READ_CAPTURE_REFERENCE / VORTEX_READ_CAPTURE_TIMESTAMP_POLICY'}, fn);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function ordinaryParents(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const st = fs.lstatSync(current); assert.equal(st.isSymbolicLink(), false); assert.equal(st.isDirectory(), true);
    }
    if (current === path.dirname(current)) return;
  }
}
function fixture() {
  ordinaryParents(scratch); fs.mkdirSync(scratch, {recursive: true}); ordinaryParents(scratch);
  const parent = fs.mkdtempSync(path.join(scratch, 'read-capture-preparer-test-'));
  return {parent, output: path.join(parent, 'kit'), options: output => ({reference, timestampPolicy, output})};
}
function cloneReference(parent) {
  const dir = path.join(parent, 'reference'); fs.mkdirSync(dir);
  for (const name of Object.keys(SUPPORTED_READ_CAPTURE.referencePins)) fs.copyFileSync(path.join(reference, name), path.join(dir, name));
  return dir;
}

test('catalog is fixed to the zero-package read-only family and invalid CLI arguments do not become paths', () => {
  assert.ok(Object.isFrozen(SUPPORTED_READ_CAPTURE)); assert.ok(Object.isFrozen(SUPPORTED_READ_CAPTURE.referencePins));
  assert.equal(SUPPORTED_READ_CAPTURE.purpose, 'own-read-capture/1');
  assert.equal(SUPPORTED_READ_CAPTURE.profileId, 'ptndev1016');
  assert.throws(() => main(['--eval', 'anything']), /READ_CAPTURE_INVALID_ARGUMENTS/);
  assert.throws(() => main(['verify', 'relative']), /READ_CAPTURE_ABSOLUTE_PATH_REQUIRED/);
});

integration('dry-run writes nothing; apply creates one complete held code kit with every runtime pin', () => {
  const f = fixture();
  const plan = prepareReadCapture(f.options(f.output));
  assert.equal(plan.status, 'plan'); assert.equal(fs.existsSync(f.output), false);
  const made = prepareReadCapture({...f.options(f.output), apply: true});
  assert.equal(made.status, 'read-capture-held'); assert.equal(made.packages, 0);
  assert.equal(verifyReadCapture(f.output).codeVerified, true);
  const config = json(path.join(f.output, 'reviewed.prepared.json'));
  assert.deepEqual(config.packages, []);
  for (const key of ['pluginPath','health','expectedHostVersion','guard','sourcePins','diskBaseline','manifestPath',
    'admissionFile','admissionSHA256','reviewedPeerExtensions','nativeTempPath']) assert.equal(config[key], null, key);
  assert.equal(config.activationApproved, false); assert.equal(config.allActivationHold, true);
  assert.equal(config.freshRootDiskBaselineFinalized, false);
  assert.equal(made.activationGranted, false); assert.equal(made.capturePerformed, false);
  assert.equal(made.materializationSupported, false);
  const map = json(path.join(f.output, 'COPY-MAP.prepared.json'));
  assert.deepEqual(map.filter(row => row.sha256 === null).map(row => row.source), ['info.json','reviewed.json']);
  for (const [name, pin] of Object.entries(config.modulePins)) {
    assert.equal(hash(fs.readFileSync(path.join(f.output, name))), pin);
    assert.equal(map.find(row => row.destination === name).sha256, pin);
  }
  for (const name of ['reviewed.json','READY.json','host.prepared.ps1','completed.json','own-diagnostic.cjs']) {
    assert.equal(fs.existsSync(path.join(f.output, name)), false, name);
  }
});

integration('completed reference controls are neither read nor copied; only fixed hash-pinned code is consumed', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  fs.writeFileSync(path.join(ownReference, 'reviewed.json'), 'STALE_CONTROL_NOT_JSON');
  fs.writeFileSync(path.join(ownReference, 'completed.json'), 'STALE_RECEIPT');
  fs.writeFileSync(path.join(ownReference, 'READY.json'), 'STALE_APPROVAL');
  prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true});
  assert.equal(verifyReadCapture(f.output).codeVerified, true);
  assert.equal(fs.readFileSync(path.join(ownReference, 'reviewed.json'), 'utf8'), 'STALE_CONTROL_NOT_JSON');
  for (const name of fs.readdirSync(f.output)) assert.equal(fs.readFileSync(path.join(f.output, name), 'utf8').includes('STALE_'), false);
});

integration('unsupported code or timestamp policy refuses before output creation', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  fs.appendFileSync(path.join(ownReference, 'scope.cjs'), '\n');
  assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_REFERENCE_DRIFT/);
  assert.equal(fs.existsSync(f.output), false);
  const policy = path.join(f.parent, 'wrong-policy.cjs'); fs.writeFileSync(policy, 'module.exports={}');
  assert.throws(() => prepareReadCapture({reference, timestampPolicy: policy, output: f.output, apply: true}), /READ_CAPTURE_TIMESTAMP_POLICY_DRIFT/);
  assert.equal(fs.existsSync(f.output), false);
});

integration('actual generated entry and complete local module graph stay inert with no native API/events or reads', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const config = json(path.join(f.output, 'reviewed.prepared.json'));
  const modules = new Map(); let calls = 0;
  const forbidden = () => {calls++; throw Error('UNEXPECTED_NATIVE_OR_FILESYSTEM_CALL');};
  const physical = new Proxy({}, {get: () => forbidden});
  function load(name) {
    if (name === './reviewed.json') return config;
    if (name === 'original-fs') return physical;
    if (name === 'path') return path;
    if (name === 'crypto') return crypto;
    if (name === '@nexusmods/vortex-api') return {selectors: {}, util: {}};
    assert.match(name, /^\.\/[a-z-]+\.cjs$/);
    const leaf = name.slice(2); assert.ok(Object.hasOwn(config.modulePins, leaf));
    if (modules.has(leaf)) return modules.get(leaf).exports;
    const module = {exports: {}}; modules.set(leaf, module);
    const code = fs.readFileSync(path.join(f.output, leaf), 'utf8');
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {setTimeout: forbidden, clearTimeout: forbidden},
      {timeout: 1000})(load, module, module.exports);
    return module.exports;
  }
  const module = {exports: {}};
  vm.runInNewContext('(function(require,module,exports,__dirname,__filename){'
    + fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8') + '\n})', {setTimeout: forbidden},
  {timeout: 1000})(load, module, module.exports, f.output, path.join(f.output, 'index.prepared.js'));
  assert.equal(module.exports({once: forbidden, api: new Proxy({}, {get: forbidden})}), true);
  assert.equal(calls, 0);
  assert.equal(load('./scope.cjs').validate([]), true);
  assert.throws(() => load('./scope.cjs').validate([{}]), /NO_PACKAGE_LOOKUP/);
  assert.equal(fs.readFileSync(path.join(f.output, 'capture.cjs'), 'utf8').includes('const timestampModule='), false);
  assert.equal(fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8').includes('CP-SETTLEMENT-DIAGNOSTIC'), false);
  assert.equal(modules.has('tool-timestamps.cjs'), true);
});

integration('self-consistent manifest edits cannot bless packages, module drift or an incomplete copy map', () => {
  for (const kind of ['packages','map','module','extra','json-duplicate']) {
    const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
    const manifestFile = path.join(f.output, 'READ-CAPTURE-KIT.json');
    const contract = json(manifestFile);
    let name;
    if (kind === 'packages') {
      name = 'reviewed.prepared.json'; const cfg = json(path.join(f.output, name)); cfg.packages = [{}];
      fs.writeFileSync(path.join(f.output, name), JSON.stringify(cfg));
    } else if (kind === 'map') {
      name = 'COPY-MAP.prepared.json'; fs.writeFileSync(path.join(f.output, name), '[]');
    } else if (kind === 'module') {
      name = 'scope.cjs'; fs.appendFileSync(path.join(f.output, name), '\n');
    } else if (kind === 'extra') fs.writeFileSync(path.join(f.output, 'attempt.json'), '{}');
    else fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('{', '{"schema":"own-read-capture-kit/1",'));
    if (name) {
      contract.files[name] = hash(fs.readFileSync(path.join(f.output, name)));
      fs.writeFileSync(manifestFile, JSON.stringify(contract, null, 2) + '\n');
    }
    assert.throws(() => verifyReadCapture(f.output));
  }
});

integration('partial output remains held with no manifest, overwrite, retry or cleanup', () => {
  const f = fixture(); const original = fs.writeFileSync; let count = 0;
  try {
    fs.writeFileSync = (...args) => {if (++count === 3) throw Error('OWN_PARTIAL_WRITE'); return original(...args);};
    assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /OWN_PARTIAL_WRITE/);
  } finally {fs.writeFileSync = original;}
  assert.ok(fs.readdirSync(f.output).length > 0);
  assert.equal(fs.existsSync(path.join(f.output, 'READ-CAPTURE-KIT.json')), false);
  assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_INCOMPLETE_KIT/);
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
});

integration('source mutation during an FD read refuses before creating output', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  const original = fs.readSync; let changed = false;
  try {
    fs.readSync = (...args) => {
      const count = original(...args);
      if (count === 0 && !changed) {
        changed = true; fs.appendFileSync(path.join(ownReference, 'index.prepared.js'), '\n');
      }
      return count;
    };
    assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.readSync = original;}
  assert.equal(changed, true); assert.equal(fs.existsSync(f.output), false);
});

integration('extra file appearing after the initial clean inventory cannot receive codeVerified success', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const original = fs.opendirSync; let injected = false;
  try {
    fs.opendirSync = (...args) => {
      const directory = original(...args), read = directory.readSync.bind(directory);
      directory.readSync = () => {
        const entry = read();
        if (entry === null && !injected && path.resolve(args[0]) === f.output) {
          injected = true; fs.writeFileSync(path.join(f.output, 'unexpected-after-inventory.js'), 'preserve');
        }
        return entry;
      };
      return directory;
    };
    assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_(KIT_FILES_DIFFER|OUTPUT_CHANGED)/);
  } finally {fs.opendirSync = original;}
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(f.output, 'unexpected-after-inventory.js'), 'utf8'), 'preserve');
});

integration('leaf mutation after all content reads is caught by terminal generation checks', () => {
  const f = fixture(); prepareReadCapture({...f.options(f.output), apply: true});
  const original = fs.opendirSync; let inventories = 0, changed = false;
  try {
    fs.opendirSync = (...args) => {
      const directory = original(...args), read = directory.readSync.bind(directory);
      const selected = path.resolve(args[0]) === f.output && ++inventories === 2;
      directory.readSync = () => {
        const entry = read();
        if (entry === null && selected && !changed) {
          changed = true; fs.appendFileSync(path.join(f.output, 'scope.cjs'), '\n');
        }
        return entry;
      };
      return directory;
    };
    assert.throws(() => verifyReadCapture(f.output), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.opendirSync = original;}
  assert.equal(changed, true);
});

integration('source drift during output writing is reported and the held output is preserved without retry', () => {
  const f = fixture(), ownReference = cloneReference(f.parent);
  const original = fs.writeFileSync; let changed = false;
  try {
    fs.writeFileSync = (...args) => {
      const result = original(...args);
      if (!changed) {changed = true; fs.appendFileSync(path.join(ownReference, 'scope.cjs'), '\n');}
      return result;
    };
    assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: f.output, apply: true}), /READ_CAPTURE_INPUT_CHANGED/);
  } finally {fs.writeFileSync = original;}
  assert.equal(changed, true); assert.ok(fs.readdirSync(f.output).length > 0);
  assert.equal(json(path.join(f.output, 'reviewed.prepared.json')).activationApproved, false);
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
});

integration('a destination appearing after plan validation is preserved and never adopted', () => {
  const f = fixture(), original = fs.mkdirSync; let raced = false;
  try {
    fs.mkdirSync = (name, ...args) => {
      if (path.resolve(name) === f.output && !raced) {
        raced = true; original(name); fs.writeFileSync(path.join(name, 'foreign'), 'preserve');
      }
      return original(name, ...args);
    };
    assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), error => error.code === 'EEXIST');
  } finally {fs.mkdirSync = original;}
  assert.equal(raced, true); assert.deepEqual(fs.readdirSync(f.output), ['foreign']);
  assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'preserve');
});

integration('existing output, active paths, scope escape and reparse ancestors refuse without overwriting', () => {
  const f = fixture(); fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'foreign'), 'keep');
  assert.throws(() => prepareReadCapture({...f.options(f.output), apply: true}), /READ_CAPTURE_NEW_OUTPUT_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'keep');
  assert.throws(() => prepareReadCapture(f.options(path.resolve(scratch, '..', 'outside-read-capture'))), /READ_CAPTURE_OUTPUT_SCOPE_REFUSED/);
  assert.throws(() => prepareReadCapture(f.options(path.join(f.parent, 'Vortex', 'plugins', 'inactive'))), /READ_CAPTURE_ACTIVE_PLUGIN_PATH_REFUSED/);
  const ownReference = cloneReference(f.parent);
  assert.throws(() => prepareReadCapture({reference: ownReference, timestampPolicy, output: path.join(ownReference, 'kit')}), /READ_CAPTURE_REFERENCE_OUTPUT_OVERLAP/);
  const target = path.join(f.parent, 'ordinary'); fs.mkdirSync(target);
  const link = path.join(f.parent, 'link'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareReadCapture(f.options(path.join(link, 'kit'))), /READ_CAPTURE_REPARSE_PATH/);
  assert.deepEqual(fs.readdirSync(target), []);
});

integration('CLI errors contain only a fixed reason code, not private paths or stack traces', () => {
  const f = fixture();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-read-capture.mjs', import.meta.url)),
    '--reference', path.join(f.parent, 'private-missing-reference'), '--timestamp-policy', timestampPolicy, '--output', f.output],
  {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.match(child.stderr, /^READ_CAPTURE_[A-Z_]+\r?\n$/);
  assert.equal(child.stderr.includes(f.parent), false); assert.equal(fs.existsSync(f.output), false);
});
