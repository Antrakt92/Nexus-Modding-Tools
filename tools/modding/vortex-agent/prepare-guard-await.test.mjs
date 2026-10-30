import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHelperContents } from './prepare-native-helper.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = `const sequence=0;
function unusedProofAnchors(){
need(c.packages?.length===1&&c.packages[0].key==='own-fixture'&&c.packages[0].sha256==='${'b'.repeat(64)}'&&c.packages[0].bytes===100,'EXACT_ONE_DISABLED_FIXTURE');
return{record:s.persistent.mods[c.health.gameId][pkg.expectedModId],flags:{}};
}
 function physical(p){const prior=cache.get(p);return prior;}
 function tree(root){const out={};function visit(rel){for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){const r=path.join(rel,e.name),p=safe(root,r);if(e.isDirectory())visit(r);else{need(e.isFile(),'SPECIAL_STAGE_FILE');if(e.name!=='__folder_managed_by_vortex')out[r.replace(/\\\\/g,'/')]=physical(p);}}}visit('');return out;}
function unusedPayload(){cache.clear();const again=tree(root);need(canonical(again)===canonical(files),'OWN_PAYLOAD_CHANGED_DURING_SETTLE');record(pkg.key+'-payload-proof',{ownerId:pkg.expectedModId,downloadId:id,files:again,disabled:true});}
function unusedWait(){return {now:Date.now,pkg,expectedSize:size,pollMs:1000};}
function unusedSource(){need(hash(c.appAsar)===c.appAsarSHA256&&c.appAsarSHA256==='${'a'.repeat(64)}','APP_ASAR_CHANGED');for(const[p,h]of Object.entries(c.sourcePins))need(hash(p)===h,'SOURCE_CHANGED');record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics});}
async function startup(){try{guard();need(hash(c.admissionFile)===c.nativeSourceAdmissionSHA256,'SOURCE_ADMISSION_CHANGED');effects.push('startup');}catch(error){throw error;}}
async function settlement(){await settle({guard:()=>{const v=runner.current();guard({...v,accepted:acceptedSnapshot});}});effects.push('settlement');}
async function poll(){const opts={check:()=>{const current=runner.current();if(current.active)guard({...current,accepted:acceptedSnapshot});}};await opts.check();effects.push('poll');}
async function rootReady(){const file='ready',deadline=Date.now()+1000;while(!fs.existsSync(file)){need(Date.now()<deadline,'ROOT_READY_TIMEOUT_NO_EFFECTS');guard();await sleep();}effects.push('root-ready');}
async function finalReadback(){const accepted=[];const final=guard({phase:'verify',accepted});effects.push(final.persistent ? 'final' : 'unverified-final');}
globalThis.boundaries={startup,settlement,poll,rootReady,finalReadback};`;

function contents(input = Buffer.from(source)) {
  const engine = Buffer.from(`need(o.packages.length===1&&o.packages[0].key==='own-fixture'&&o.packages[0].sha256==='${'b'.repeat(64)}','EXACT_ONE_FIXTURE');`);
  const modules = new Map([['engine.cjs', engine], ['settlement.cjs', Buffer.from('module.exports={};')],
    ['local-import-readiness.cjs', Buffer.from('module.exports={};')]]);
  const config = { activationApproved: false, activationHold: true, freshActualBaselineBound: false, noEffects: true,
    health: { gameId: 'cyberpunk2077' }, packages: [{ key: 'own-fixture', sha256: 'b'.repeat(64), bytes: 100,
      expectedEnabled: false, oldEnabledModIds: [] }], modulePins: Object.fromEntries([...modules].map(([name, bytes]) => [name, sha(bytes)])) };
  return createHelperContents({ input, config, modules, sourceSha256: sha(input), output: path.join(os.tmpdir(), 'inert-await-kit') });
}

function sandbox(code, guard) {
  const effects = [], trace = []; let ready = false;
  const context = vm.createContext({ effects, guard, cache: new Map(),
    c: { admissionFile: 'admission', nativeSourceAdmissionSHA256: 'pin' }, hash: () => { trace.push('admission-read'); return 'pin'; },
    need: (ok, message) => { if (!ok) throw Error(message); },
    runner: { current: () => ({ active: true }) }, acceptedSnapshot: [],
    settle: async options => { await options.guard(); },
    fs: { existsSync: () => ready }, sleep: async () => { trace.push('sleep-start'); ready = true; },
    require: name => { assert.equal(name, './physical-proof.cjs'); return { createPhysicalReader: () => () => {} }; },
  });
  vm.runInContext(code, context);
  return { effects, trace, boundaries: context.boundaries };
}

test('all generated lifecycle boundaries wait for a guard before continuing', async () => {
  const code = contents().get('index.prepared.js').toString();
  for (const name of ['startup', 'settlement', 'poll', 'rootReady', 'finalReadback']) {
    let resolve, calls = 0;
    const pending = new Promise(done => { resolve = done; });
    const run = sandbox(code, () => { calls++; return pending; });
    const result = run.boundaries[name]();
    await new Promise(done => setImmediate(done));
    assert.equal(calls, 1, name); assert.deepEqual(run.effects, [], name);
    resolve({ persistent: {} }); await result;
    assert.equal(run.effects.length, 1, name); assert.notEqual(run.effects[0], 'unverified-final');
  }
});

test('async guard rejection propagates through generated callbacks and prevents later effects', async () => {
  const code = contents().get('index.prepared.js').toString();
  for (const name of ['startup', 'settlement', 'poll', 'rootReady', 'finalReadback']) {
    let reject;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    // Observe it independently too: a broken wrapper must fail this test through
    // its effect, rather than through an incidental unhandled rejection.
    pending.catch(() => {});
    const run = sandbox(code, () => pending), result = run.boundaries[name]();
    const checked = assert.rejects(result, /GUARD_REJECTED/);
    reject(Error('GUARD_REJECTED')); await checked;
    assert.deepEqual(run.effects, [], name);
  }
});

test('synchronous guard state and failures retain their original meaning', async () => {
  const code = contents().get('index.prepared.js').toString();
  for (const name of ['startup', 'settlement', 'poll', 'rootReady', 'finalReadback']) {
    const passing = sandbox(code, () => ({ persistent: {} })); await passing.boundaries[name]();
    assert.equal(passing.effects.length, 1, name);
    const failing = sandbox(code, () => { throw Error('SYNC_GUARD_FAILED'); });
    await assert.rejects(failing.boundaries[name](), /SYNC_GUARD_FAILED/); assert.deepEqual(failing.effects, []);
  }
});

test('synchronous guards preserve same-turn admission, sleep initiation and final receipt ordering', async () => {
  const code = contents().get('index.prepared.js').toString();
  for (const name of ['startup', 'rootReady', 'finalReadback']) {
    let observed;
    const state = { persistent: {} };
    const run = sandbox(code, () => {
      queueMicrotask(() => { state.persistent = null; observed = { trace: [...run.trace], effects: [...run.effects] }; });
      return state;
    });
    await run.boundaries[name]();
    assert(observed, name);
    if (name === 'startup') assert.deepEqual(observed.trace, ['admission-read'], name);
    if (name === 'rootReady') assert.deepEqual(observed.trace, ['sleep-start'], name);
    if (name === 'finalReadback') assert.deepEqual(observed.effects, ['final'], name);
  }
});

test('partial or duplicate lifecycle integration shapes are refused', () => {
  assert.throws(() => contents(Buffer.from(source.replace('const final=guard(', 'const final=otherGuard('))), /UNSUPPORTED_HELPER_TEMPLATE/);
  assert.throws(() => contents(Buffer.from(source + "\nasync function duplicate(){try{guard();need(hash(c.admissionFile));}catch(e){}}")), /UNSUPPORTED_HELPER_TEMPLATE/);
  assert.throws(() => contents(Buffer.from(source.replaceAll('guard(', 'otherGuard(') + '\nfunction guard(){}')), /UNSUPPORTED_HELPER_TEMPLATE/);
});

const reference = process.env.VORTEX_OWN_HELPER_REFERENCE;
test('the admitted real family template supports the complete awaited caller group', { skip: !reference }, () => {
  const input = fs.readFileSync(path.join(reference, 'index.prepared.js'));
  const config = JSON.parse(fs.readFileSync(path.join(reference, 'reviewed.prepared.json')));
  const modules = new Map(Object.keys(config.modulePins).map(name => [name, fs.readFileSync(path.join(reference, name))]));
  const generated = createHelperContents({ input, config, modules, sourceSha256: sha(input), output: path.join(os.tmpdir(), 'inert-real-await-kit') });
  new vm.Script(generated.get('index.prepared.js').toString());
  assert.equal(JSON.parse(generated.get('reviewed.prepared.json')).activationHold, true);
});
