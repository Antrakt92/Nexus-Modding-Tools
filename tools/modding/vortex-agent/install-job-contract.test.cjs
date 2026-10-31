'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('./install-job-contract.cjs');
const {validateInstallPlan, parseInstallPlan, installPlanId, installPayloadDigest,
  initialInstallState, advanceInstallState, inspectInstallState, parseInstallState} = contract;
const h = 'a'.repeat(64), m = 'b'.repeat(32);
function plan() {
  return {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: contract.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture-profile', gamePath: 'F:/Fixture/Game',
      stagingPath: 'F:/Fixture/Stage', downloadPath: 'D:/Fixture/Downloads',
      filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked_1', fileName: 'Own Fixture.zip', expectedModId: 'Own Fixture', expectedType: '',
      bytes: 200, sha256: h, md5: m, expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
}
const append = (state, kind, values = {}) => advanceInstallState(state, {sequence: state.events.length + 1, kind, ...values});
function intended() {
  let state = initialInstallState(plan());
  state = append(state, 'admission_observed', {snapshotSHA256: h, nativeAdmissionSHA256: h});
  return append(state, 'install_intent', {admissionSHA256: h, nativeJobId: 'native-job-1'});
}
function callback(state = intended(), nativeJobId = 'native-job-1') {
  return append(state, 'native_callback', {outcome: 'resolved', modId: 'Own Fixture', code: null, nativeJobId});
}
function terminal(state = callback(), nativeJobId = 'native-job-1') {
  return append(state, 'native_terminal_observed', {nativeJobId, outcome: 'resolved', code: null});
}
function settled() {
  const state = terminal(); return append(state, 'settlement_observed', {payloadSHA256: installPayloadDigest(state.plan), disabled: true});
}
test('plan identity is semantic, bounded, detached and never a native permit', () => {
  const input = plan(), checked = validateInstallPlan(input), first = installPlanId(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.package = Object.fromEntries(Object.entries(input.package).reverse());
  assert.equal(installPlanId(reordered), first);
  const parsed = parseInstallPlan(Buffer.from(JSON.stringify(reordered, null, 2).replace(/\n/g, '\r\n')));
  assert.equal(installPlanId(parsed), first);
  input.package.payload['r6/scripts/own.reds'] = 'c'.repeat(64); input.context.profileId = 'changed';
  assert.equal(checked.package.payload['r6/scripts/own.reds'], h); assert.equal(checked.context.profileId, 'fixture-profile');
  assert(Object.isFrozen(checked.package.payload));
  assert.notEqual(installPlanId(input), first);
  const status = inspectInstallState(initialInstallState(checked));
  assert.equal(status.effectsAllowed, false); assert.equal(status.nativeAdmissionVerified, false);
  assert.equal(status.archiveVerified, false); assert.equal(status.payloadVerified, false);
});
test('parse boundary refuses decoded duplicate keys, malformed UTF8 and excessive input', () => {
  assert.throws(() => parseInstallPlan(Buffer.from('{"schema":1,"\\u0073chema":2}')), /INSTALL_JOB_INVALID_JSON/);
  assert.throws(() => parseInstallPlan(Buffer.from([0xff])), /INSTALL_JOB_INVALID_JSON/);
  assert.throws(() => parseInstallPlan(Buffer.alloc(contract.LIMITS.bytes + 1)), /INSTALL_JOB_INVALID_JSON/);
});
test('closed family, options, source claims and exact package identity reject extra capabilities', () => {
  for (const mutate of [p => {p.family = 'direct-local';}, p => {p.family = 'import';},
    p => {p.options.enabled = true;}, p => {p.options.deploy = true;}, p => {p.options.choices = {};},
    p => {p.package.forceInstaller = 'anything';}, p => {p.package.expectedType = 'redmod';},
    p => {p.package.expectedModId = 'Other';}, p => {p.evidence.nativeAdmissionVerified = true;},
    p => {p.package.downloadId = 'https://secret';}, p => {p.package.bytes = true;},
    p => {p.package.expectedUncompressedBytes = contract.LIMITS.unpackedBytes + 1;},
    p => {p.package.bytes = contract.LIMITS.archiveBytes + 1;}]) {
    const input = plan(); mutate(input); assert.throws(() => validateInstallPlan(input), /INSTALL_JOB_/);
  }
});
test('Windows roots and payloads reject aliases, collisions and unsupported installer files', () => {
  for (const name of ['../escape', 'r6\\escape', 'r6/CON.txt', 'r6/a. /x', 'fomod/ModuleConfig.xml',
    'r6/vortex_override_instructions.json', 'r6/__folder_managed_by_vortex', 'r6/' + 'x'.repeat(256)]) {
    const p = plan(); p.package.payload = {[name]: h}; assert.throws(() => validateInstallPlan(p), /INSTALL_JOB_/);
  }
  for (const payload of [{'r6/a': h, 'R6/b': h}, {'r6/a': h, 'r6/A': h}, {'r6/a': h, 'r6/a/b': h},
    {'r6/a/b': h, 'r6/a': h}]) {
    const p = plan(); p.package.payload = payload; assert.throws(() => validateInstallPlan(p), /INSTALL_JOB_PAYLOAD_COLLISION/);
  }
  for (const name of ['C:relative', '\\\\host\\share', 'C:/x/../y', 'C:/x./y', 'C:/NUL', 'C:/x//y']) {
    const p = plan(); p.context.gamePath = name; assert.throws(() => validateInstallPlan(p), /INSTALL_JOB_INVALID_CONTEXT/);
  }
  const nested = plan(); nested.context.stagingPath = 'f:/fixture/game/staging';
  assert.throws(() => validateInstallPlan(nested), /INSTALL_JOB_ROOT_OVERLAP/);
});
test('physical root aliases and Windows console-device components cannot enter a plan', () => {
  for (const [first, second] of [['gamePath', 'stagingPath'], ['gamePath', 'downloadPath'], ['stagingPath', 'downloadPath']]) {
    const input = plan(); input.context.filesystemIds[second] = input.context.filesystemIds[first];
    assert.throws(() => validateInstallPlan(input), /INSTALL_JOB_ROOT_ALIAS/);
  }
  for (const device of ['CONIN$', 'conout$', 'ConIn$.txt', 'CONOUT$.zip']) {
    const payload = plan(); payload.package.payload = {['r6/' + device]: h};
    assert.throws(() => validateInstallPlan(payload), /INSTALL_JOB_INVALID_PAYLOAD/);
    const root = plan(); root.context.gamePath = 'F:/Fixture/' + device;
    assert.throws(() => validateInstallPlan(root), /INSTALL_JOB_INVALID_CONTEXT/);
    const archive = plan(); archive.package.fileName = device + '.zip'; archive.package.expectedModId = device;
    assert.throws(() => validateInstallPlan(archive), /INSTALL_JOB_INVALID_PACKAGE/);
  }
});
test('programmatic accessors, custom prototypes, symbols, cycles and sparse arrays fail without invoking getters', () => {
  let invoked = 0;
  const p = plan(); Object.defineProperty(p, 'options', {enumerable: true, get() {invoked++; throw Error('GETTER');}});
  assert.throws(() => validateInstallPlan(p), /INSTALL_JOB_JSON_REQUIRED/); assert.equal(invoked, 0);
  const proxy = new Proxy(plan(), {getPrototypeOf() {invoked++; throw Error('TRAP');}});
  assert.throws(() => validateInstallPlan(proxy), /INSTALL_JOB_JSON_REQUIRED/); assert.equal(invoked, 0);
  for (const mutate of [s => {s.events = Array(1);}, s => {s.events.extra = 1;}, s => {s.events.push(s);},
    s => {Object.setPrototypeOf(s.plan.package, {inherited: true});}, s => {s.plan[Symbol('hidden')] = 1;},
    s => {Object.defineProperty(s.plan, 'hidden', {value: true});}]) {
    const state = {schema: 'install-job-state/1', plan: plan(), events: []}; mutate(state);
    assert.throws(() => inspectInstallState(state), /INSTALL_JOB_/);
  }
});
test('strict state parsing retains ordered observations and rejects duplicate keys before replay', () => {
  const state = callback();
  const parsed = parseInstallState(Buffer.from(JSON.stringify(state)));
  assert.equal(inspectInstallState(parsed).callbackObserved, true); assert(Object.isFrozen(parsed.events));
  const text = JSON.stringify(state).replace('"sequence":1', '"sequence":1,"sequence":1');
  assert.throws(() => parseInstallState(Buffer.from(text)), /INSTALL_JOB_INVALID_JSON/);
  assert.throws(() => advanceInstallState(state, null), /INSTALL_JOB_EVENT_ORDER/);
  const extra = structuredClone(state); extra.events[0].arbitraryArguments = {};
  assert.throws(() => inspectInstallState(extra), /INSTALL_JOB_EVENT_ORDER/);
});
test('model completion requires callback, distinct native terminal, settlement and verified-cleanup claims', () => {
  let state = intended(); let status = inspectInstallState(state);
  assert.equal(status.phase, 'dispatch_unknown'); assert.equal(status.nativeActivity, 'unknown');
  assert.equal(status.reconcileRequired, true);
  assert.throws(() => append(state, 'completion_observed', {readbackSHA256: h}), /INSTALL_JOB_INVALID_COMPLETION/);
  assert.throws(() => terminal(state), /INSTALL_JOB_INVALID_NATIVE_TERMINAL/);
  state = callback(state); status = inspectInstallState(state);
  assert.equal(status.callbackObserved, true); assert.equal(status.nativeTerminalObserved, false);
  assert.throws(() => append(state, 'settlement_observed', {payloadSHA256: installPayloadDigest(state.plan), disabled: true}), /INSTALL_JOB_INVALID_SETTLEMENT/);
  state = terminal(state);
  state = append(state, 'settlement_observed', {payloadSHA256: installPayloadDigest(state.plan), disabled: true});
  assert.throws(() => append(state, 'completion_observed', {readbackSHA256: h}), /INSTALL_JOB_INVALID_COMPLETION/);
  state = append(state, 'cleanup_observed', {exited: true, forced: false, uncertain: false});
  state = append(state, 'completion_observed', {readbackSHA256: h}); status = inspectInstallState(state);
  assert.equal(status.modelCompleted, true); assert.equal(status.completionObserved, true);
  assert.equal(status.phase, 'completion_observed'); assert.equal(status.effectsAllowed, false);
  assert.equal(status.nativeAdmissionVerified, false); assert.equal(status.payloadVerified, false);
  assert.equal(status.reconcileRequired, false);
  assert.throws(() => append(state, 'cancellation_requested'), /INSTALL_JOB_EVENT_ORDER/);
});
test('wrong IDs, fake evidence and forced or uncertain cleanup cannot advance the model', () => {
  assert.throws(() => callback(initialInstallState(plan())), /INSTALL_JOB_INVALID_CALLBACK/);
  assert.throws(() => append(intended(), 'native_callback', {outcome: 'resolved', modId: 'Wrong', code: null, nativeJobId: null}), /INSTALL_JOB_INVALID_CALLBACK/);
  assert.throws(() => terminal(callback(), 'other-job'), /INSTALL_JOB_INVALID_NATIVE_TERMINAL/);
  assert.doesNotThrow(() => terminal(callback(intended(), null), 'native-job-1'));
  assert.throws(() => terminal(callback(intended(), null), 'unbound-job'), /INSTALL_JOB_INVALID_NATIVE_TERMINAL/);
  assert.throws(() => callback(intended(), 'wrong-job'), /INSTALL_JOB_INVALID_CALLBACK/);
  for (const values of [{exited: false, forced: false, uncertain: false}, {exited: true, forced: true, uncertain: false},
    {exited: true, forced: false, uncertain: true}]) assert.throws(() => append(settled(), 'cleanup_observed', values), /INSTALL_JOB_INVALID_CLEANUP/);
  assert.throws(() => append(terminal(), 'settlement_observed', {payloadSHA256: 'c'.repeat(64), disabled: true}), /INSTALL_JOB_INVALID_SETTLEMENT/);
  const state = initialInstallState(plan());
  assert.throws(() => advanceInstallState(state, {sequence: 2, kind: 'admission_observed', snapshotSHA256: h, nativeAdmissionSHA256: h}), /INSTALL_JOB_EVENT_ORDER/);
  assert.throws(() => append(append(state, 'admission_observed', {snapshotSHA256: h, nativeAdmissionSHA256: h}), 'install_intent', {admissionSHA256: 'c'.repeat(64),nativeJobId:'native-job-1'}), /INSTALL_JOB_EVENT_ORDER/);
});
test('cancellation before intent refuses dispatch; cancellation after intent retains only late observations', () => {
  let state = append(initialInstallState(plan()), 'cancellation_requested');
  assert.equal(inspectInstallState(state).phase, 'stopped_before_intent');
  assert.equal(inspectInstallState(state).reconcileRequired, false);
  assert.throws(() => append(state, 'admission_observed', {snapshotSHA256: h, nativeAdmissionSHA256: h}), /INSTALL_JOB_EVENT_ORDER/);
  state = append(intended(), 'cancellation_requested'); state = callback(state); state = terminal(state);
  state = append(state, 'cleanup_observed', {exited: true, forced: false, uncertain: false});
  const status = inspectInstallState(state); assert.equal(status.phase, 'held'); assert.equal(status.nativeActivity, 'terminal-claim');
  assert.equal(status.modelCompleted, false); assert.equal(status.reconcileRequired, true);
  assert.throws(() => append(state, 'settlement_observed', {payloadSHA256: installPayloadDigest(state.plan), disabled: true}), /INSTALL_JOB_INVALID_SETTLEMENT/);
});
test('failure never resumes; late callback and terminal claims cannot erase an earlier failure', () => {
  let state = append(intended(), 'failure_observed', {code: 'CLIENT_DISCONNECTED'});
  state = callback(state); state = terminal(state);
  assert.equal(inspectInstallState(state).failureObserved, true); assert.equal(inspectInstallState(state).modelCompleted, false);
  assert.throws(() => append(state, 'completion_observed', {readbackSHA256: h}), /INSTALL_JOB_INVALID_COMPLETION/);
  assert.throws(() => callback(state), /INSTALL_JOB_INVALID_CALLBACK/);
  const failed = append(intended(), 'native_callback', {outcome: 'failed', modId: null, code: 'NATIVE_ERROR', nativeJobId: 'native-job-1'});
  assert.equal(inspectInstallState(failed).phase, 'held');
  const done = append(failed, 'native_terminal_observed', {nativeJobId: 'native-job-1', outcome: 'failed', code: 'NATIVE_ERROR'});
  assert.equal(inspectInstallState(done).nativeTerminalObserved, true);
});
test('state replays history rather than trusting injected phase or completion fields', () => {
  const state = structuredClone(initialInstallState(plan()));
  state.phase = 'completed'; assert.throws(() => inspectInstallState(state), /INSTALL_JOB_INVALID_STATE/); delete state.phase;
  state.events = [{sequence: 1, kind: 'completion_observed', readbackSHA256: h}];
  assert.throws(() => inspectInstallState(state), /INSTALL_JOB_INVALID_COMPLETION/);
  state.events = [{sequence: 1, kind: 'admission_observed', snapshotSHA256: h, nativeAdmissionSHA256: h, effectsAllowed: true}];
  assert.throws(() => inspectInstallState(state), /INSTALL_JOB_EVENT_ORDER/);
});
test('inputs and event objects cannot mutate accepted state; budgets fail before unbounded replay', () => {
  const input = plan(), state = initialInstallState(input), event = {sequence: 1, kind: 'admission_observed', snapshotSHA256: h, nativeAdmissionSHA256: h};
  const next = advanceInstallState(state, event); event.snapshotSHA256 = 'c'.repeat(64); input.package.bytes = 1;
  assert.equal(next.events[0].snapshotSHA256, h); assert.equal(next.plan.package.bytes, 200); assert.equal(state.events.length, 0);
  assert(Object.isFrozen(next.events[0]));
  const tooMany = structuredClone(state); tooMany.events = Array.from({length: contract.LIMITS.events + 1}, (_, index) => ({sequence: index + 1, kind: 'cancellation_requested'}));
  assert.throws(() => inspectInstallState(tooMany), /INSTALL_JOB_INVALID_STATE/);
  const oversized = plan(); oversized.package.payload = Object.fromEntries(Array.from({length: contract.LIMITS.files + 1}, (_, i) => ['r6/' + i, h]));
  assert.throws(() => validateInstallPlan(oversized), /INSTALL_JOB_PAYLOAD_LIMIT/);
  const deep = plan(); let cursor = deep; for (let i = 0; i < 20; i++) {cursor.extra = {}; cursor = cursor.extra;}
  assert.throws(() => validateInstallPlan(deep), /INSTALL_JOB_LIMIT/);
});

test('failed callbacks may retain the exact partial mod ID without authorizing completion', () => {
  for (const modId of [null, 'Own Fixture']) {
    const state = append(intended(), 'native_callback', {outcome:'failed',modId,code:'NATIVE_ERROR',nativeJobId:null});
    const done = append(state,'native_terminal_observed',{nativeJobId:'native-job-1',outcome:'failed',code:'NATIVE_ERROR'});
    const status=inspectInstallState(done);assert.equal(status.phase,'held');assert.equal(status.modelCompleted,false);
    assert.throws(()=>append(done,'completion_observed',{readbackSHA256:h}),/INSTALL_JOB_INVALID_COMPLETION/);
  }
  assert.throws(()=>append(intended(),'native_callback',{outcome:'failed',modId:'Other',code:'NATIVE_ERROR',nativeJobId:null}),/INSTALL_JOB_INVALID_CALLBACK/);
  const admitted=append(initialInstallState(plan()),'admission_observed',{snapshotSHA256:h,nativeAdmissionSHA256:h});
  assert.throws(()=>append(admitted,'install_intent',{admissionSHA256:h}),/INSTALL_JOB_EVENT_ORDER/);
});
test('initial state also budgets its wrapper rather than returning an unreadable boundary plan', {timeout: 15000}, () => {
  const input = (length, extra = 0) => {
    const value = plan();
    value.package.payload = Object.fromEntries(Array.from({length: contract.LIMITS.files}, (_, i) =>
      ['r6/' + String(i).padStart(4, '0') + '-' + 'x'.repeat(length + (i < extra ? 1 : 0)), h]));
    return value;
  };
  const accepted = value => {try {validateInstallPlan(value); return true;} catch (error) {
    assert.equal(error.message, 'INSTALL_JOB_LIMIT'); return false;
  }};
  let low = 0, high = 240;
  while (low < high) {const mid = Math.ceil((low + high) / 2); if (accepted(input(mid))) low = mid; else high = mid - 1;}
  const length = low; low = 0; high = contract.LIMITS.files;
  while (low < high) {const mid = Math.ceil((low + high) / 2); if (accepted(input(length, mid))) low = mid; else high = mid - 1;}
  const boundary = input(length, low); assert(accepted(boundary));
  assert.throws(() => initialInstallState(boundary), /INSTALL_JOB_LIMIT/);
});

test('source capability admission digest and fresh snapshot are separate exact bindings', () => {
  const input=plan();input.evidence.nativeAdmissionSHA256='c'.repeat(64);
  const initial=initialInstallState(input);
  assert.throws(()=>append(initial,'admission_observed',{snapshotSHA256:h,nativeAdmissionSHA256:h}),/INSTALL_JOB_EVENT_ORDER/);
  assert.throws(()=>append(initial,'admission_observed',{snapshotSHA256:h}),/INSTALL_JOB_EVENT_ORDER/);
  const state=append(initial,'admission_observed',{snapshotSHA256:h,nativeAdmissionSHA256:'c'.repeat(64)});
  assert.throws(()=>append(state,'install_intent',{admissionSHA256:'c'.repeat(64),nativeJobId:'job-1'}),/INSTALL_JOB_EVENT_ORDER/);
  assert.doesNotThrow(()=>append(state,'install_intent',{admissionSHA256:h,nativeJobId:'job-1'}));
  assert.equal(inspectInstallState(state).nativeAdmissionVerified,false);
});
