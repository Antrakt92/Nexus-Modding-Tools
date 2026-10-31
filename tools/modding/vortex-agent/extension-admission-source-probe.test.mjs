import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

// Source-execution experiment, not a host integration or a registration permit.
// No Electron, database, filesystem mutation, download or install is executed.
// Provide a read-only official Git cache and the already qualified node_modules.
const repo = process.env.VORTEX_EXTENSION_ADMISSION_REPO;
const deps = process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const commit = 'c80326367cbe6d96621ad6cf4a5488ef49bac110';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = {
  'ExtensionManager.ts': '5d0de2194cf413938e61a398494196af07677dc6d0d014216ba3b25b5a211b95',
  'reducers/index.ts': 'e59a69384003bade4d1216ee28a8347b38d27291f9b3688c82dc488c168a4e22',
  'store/reduxSanity.ts': '53022626fc3d70a1974e6dde0e0ca3f43b4ffdc5122b776b6c96c1befd22b813',
  'util/util.ts': '0575d63c0b43f67c0f050852ebf536f675d8b85b8ac0e59a03076007a34f03be',
  'util/storeHelper.ts': 'f54ab78f17df20db0e53f071fc727364d5a66c3380af271933d7203be3d31a28',
  'util/deepMerge.ts': 'bb84a5c120c392a9fbd082ac318f59e6a031a88f3351d4eaa0390413ce517cf2',
  'extensions/mod_management/reducers/mods.ts': 'e1c1619bebb86756fec840d0a36ed6b7100dc7c4bae2f2c54e7a5110ea838378',
  'extensions/mod_management/eventHandlers.ts': 'c45773ac110808acb3a3bf79bdcb1b3cab1ef498c6ddfdf7c29f11abb60733eb',
  'renderer.tsx': 'e7554a3ca81d3d540e15661ccacb839b3b3f0bfdac95cc764abce6e9f76bde40',
  '@main/store/mainPersistence.ts': '7d3e28cb829914fb092774eca3fc357645fa7ef508177d1a0e3b32eed58f05fe',
};
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: repo && deps ? false : 'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'}, fn);
let loaded;
function inputs() {
  if (loaded) return loaded;
  const require = createRequire(import.meta.url);
  function packageLib(relative, digest, entry = 'index.js') {
    const folder = path.join(deps, '.pnpm', relative, 'lib');
    const rows = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) rows.push({
          file: path.relative(folder, full).split(path.sep).join('/'), sha256: hash(readFileSync(full)),
        });
        else assert.ok(entry.isFile(), 'dependency tree must not contain links or special entries');
      }
    }
    walk(folder);
    assert.equal(hash(JSON.stringify(rows)), digest, `dependency lib tree: ${relative}`);
    return require(path.join(folder, entry));
  }
  const tsFile = path.join(deps, '.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js');
  assert.equal(hash(readFileSync(tsFile)), '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39');
  const ts = require(tsFile);
  const redux = packageLib('redux@4.2.1/node_modules/redux', '6bdb7c6337de0a11e1291b3ac3cf34c63468cd845dd98cccd320b44238969b6e', 'redux.js');
  const act = packageLib('redux-act@1.8.0/node_modules/redux-act', '39ac092d7638d1ea5a7d3d8f3ad52d1aa96b7e2e042fb7431e919cd8bcd82b6d');
  const batching = packageLib('redux-batched-actions@0.5.0_redux@4.2.1/node_modules/redux-batched-actions', 'e12ecbaa555ba0f4cc8590f9adadf5b26858aa8b02b739fcd896c91f83af8fc8');
  const sources = {};
  for (const [file, digest] of Object.entries(pins)) {
    const upstream = file.startsWith('@main/') ? 'src/main/src/' + file.slice(6) : 'src/renderer/src/' + file;
    const raw = execFileSync('git', ['-C', repo, 'show', `${commit}:${upstream}`], {maxBuffer: 2 * 1024 * 1024});
    assert.equal(hash(raw), digest, upstream);
    sources[file] = ts.createSourceFile(upstream, raw.toString('utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  }
  function find(file, predicate) {
    const found = [];
    function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
    visit(sources[file]);
    assert.equal(found.length, 1, `unique AST selection in ${file}`);
    return found[0];
  }
  function named(file, name) {
    return find(file, n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
      || ts.isVariableDeclaration(n)) && n.name?.getText() === name).getText(sources[file]);
  }
  const run = (text, context = {}) => vm.runInNewContext(stripTypeScriptTypes(text.replace(/^export /gm, ''),
    {mode: 'transform'}), context, {timeout: 1000});
  loaded = {ts, sources, find, named, run, redux, act, batching};
  return loaded;
}

function fixture() {
  const i = inputs();
  const {named, run, find, ts, sources, act, redux, batching} = i;
  const setSafe = run(named('util/storeHelper.ts', 'setSafe') + '\nsetSafe;');
  const deepMerge = run(named('util/deepMerge.ts', 'pick') + '\n' + named('util/deepMerge.ts', 'deepMerge') + '\ndeepMerge;');
  const addToTree = run(named('reducers/index.ts', 'addToTree') + '\naddToTree;', {deepMerge});
  const addProperty = find('extensions/mod_management/reducers/mods.ts', n => ts.isPropertyAssignment(n)
    && n.name.getText().includes('actions.addMod as any'));
  const addModReducer = run('(' + addProperty.initializer.getText() + ');', {setSafe});
  const sanity = run(named('store/reduxSanity.ts', 'StateError') + '\nconst '
    + named('store/reduxSanity.ts', 'sanityChecks') + ';\n'
    + named('util/util.ts', 'setdefault') + '\n'
    + named('store/reduxSanity.ts', 'reduxSanity') + '\n'
    + named('store/reduxSanity.ts', 'registerSanityCheck') + '\n({reduxSanity, registerSanityCheck});');
  const context = {createReducer: act.createReducer, setSafe,
    deleteOrNop: run(named('util/storeHelper.ts', 'clone') + '\n'
      + named('util/storeHelper.ts', 'deleteOrNop') + '\ndeleteOrNop;'),
    hydrateRed: () => assert.fail('hydration not simulated by this experiment'),
    safeCombineReducers: () => assert.fail('only actual persistent.mods leaf is instantiated'),
  };
  const derive = run(named('reducers/index.ts', 'pushRed') + '\n'
    + named('reducers/index.ts', 'deriveReducer') + '\nderiveReducer;', context);
  const tree = {};
  addToTree(tree, ['persistent', 'mods'], {reducers: {ADD_MOD: addModReducer}, defaults: {}});
  const root = () => batching.enableBatching(derive('.persistent.mods', tree.persistent.mods));
  const store = () => redux.createStore(root(), redux.applyMiddleware(sanity.reduxSanity(() => {})));
  return {...i, ...sanity, tree, addToTree, root, store};
}

integration('extension getReducers registers a unique CAS action without overriding legacy ADD_MOD', () => {
  const f = fixture();
  // This is the proposed extension-owned action, NOT an upstream install capability.
  const strict = {reducers: {OWN_STRICT_ADD: (state, {id, record}) =>
    Object.hasOwn(state.fixture ?? {}, id) ? state : {...state, fixture: {...state.fixture, [id]: record}}}, defaults: {}};
  const method = f.find('ExtensionManager.ts', n => f.ts.isMethodDeclaration(n) && n.name.getText() === 'getReducers');
  const getReducers = f.run('class Probe {' + method.getText() + '}\nProbe.prototype.getReducers;',
    {registerSanityCheck: f.registerSanityCheck});
  const registrations = getReducers.call({mStartHooks: [], apply(kind, callback) {
    if (kind === 'registerReducer') callback(['persistent', 'mods'], strict);
    if (kind === 'registerActionCheck') callback('OWN_STRICT_ADD', () => undefined);
  }});
  for (const {path: statePath, reducer} of registrations) f.addToTree(f.tree, statePath, reducer);
  const s = f.store();
  const first = {id: 'new', state: 'installed', marker: 'first'};
  s.dispatch({type: 'OWN_STRICT_ADD', payload: {id: 'new', record: first}});
  s.dispatch({type: 'OWN_STRICT_ADD', payload: {id: 'new', record: {marker: 'replacement'}}});
  assert.equal(s.getState().fixture.new, first);
  const legacy = {id: 'new', marker: 'legacy-overwrite'};
  s.dispatch({type: 'ADD_MOD', payload: {gameId: 'fixture', mod: legacy}});
  assert.equal(s.getState().fixture.new, legacy, 'unique CAS does not alter legacy overwrite semantics');
});

integration('reduxSanity refusal returns the exact original action without calling the reducer', () => {
  for (const refusal of [false, 'target reserved']) {
    const f = fixture();
    const errors = [];
    f.registerSanityCheck('ADD_MOD', () => refusal);
    const s = f.redux.createStore(f.root(), f.redux.applyMiddleware(f.reduxSanity(e => errors.push(e))));
    const a = {type: 'ADD_MOD', payload: {gameId: 'fixture', mod: {id: 'new'}}};
    assert.equal(s.dispatch(a), a);
    assert.equal(s.getState().fixture, undefined);
    assert.equal(errors.length, refusal === false ? 0 : 1);
  }
});

integration('actual onAddMod still ensures its directory and acknowledges success after rejected ADD_MOD', async () => {
  const f = fixture();
  f.registerSanityCheck('ADD_MOD', () => false);
  const s = f.store();
  const calls = [];
  const done = [];
  const onAddMod = f.run(f.named('extensions/mod_management/eventHandlers.ts', 'onAddMod') + '\nonAddMod;', {
    installPathForGame: () => '/virtual-staging', path: path.posix,
    addMod: (gameId, mod) => ({type: 'ADD_MOD', payload: {gameId, mod}}),
    fs: {ensureDirAsync: value => {calls.push(value); return Promise.resolve();}},
  });
  onAddMod({store: s}, 'fixture', {id: 'new', installationPath: 'new'}, err => done.push(err));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['/virtual-staging/new']);
  assert.deepEqual(done, [null]);
  assert.equal(s.getState().fixture, undefined);
});

integration('actual redux-act and reducer-level batches bypass a per-ADD_MOD sanity check', () => {
  for (const container of ['redux-act', 'reducer-batch', 'nested']) {
    const f = fixture();
    let checked = 0;
    f.registerSanityCheck('ADD_MOD', () => {checked++; return false;});
    const s = f.store();
    const a = {type: 'ADD_MOD', payload: {gameId: 'fixture', mod: {id: 'new'}}};
    s.dispatch(a);
    assert.equal(checked, 1);
    const wrapped = container === 'redux-act' ? f.act.batch([a])
      : f.batching.batchActions(container === 'nested' ? [f.act.batch([a])] : [a]);
    s.dispatch(wrapped);
    assert.equal(checked, 1, 'middleware did not see inner action');
    assert.equal(s.getState().fixture.new.id, 'new', container);
  }
});

integration('renderer rejects a main persistence push only after the actual main write/finalize tail', async () => {
  const f = fixture();
  const order = [];
  const s = f.store();
  f.registerSanityCheck('__persist_push', () => {order.push('renderer-veto'); return false;});
  let finish;
  const drain = new Promise(resolve => {finish = resolve;});
  let persisted;
  const push = f.run(f.named('@main/store/mainPersistence.ts', 'pushStateToRenderer') + '\npushStateToRenderer;', {
    mainPersistor: {applyDiffOperations(hive, operations) {persisted = {hive, operations}; order.push('main-write');},
      finalizeWrite() {order.push('main-finalize-start'); return drain.then(() => order.push('main-finalize-done'));}},
    levelPersist: {}, log: () => assert.fail('unexpected early return'),
    BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false, webContents: {}}]},
    betterIpcMain: {send(_target, channel, hive, operations) {
      assert.equal(channel, 'persist:push'); order.push('main-send');
      s.dispatch({type: '__persist_push', payload: {hive, operations}});
    }},
  });
  const operations = [{type: 'set', path: ['mods', 'fixture', 'new'], value: {id: 'new'}}];
  const pending = push('persistent', operations);
  assert.deepEqual(order, ['main-write', 'main-finalize-start']);
  assert.equal(persisted.operations, operations);
  finish(); await pending;
  assert.deepEqual(order, ['main-write', 'main-finalize-start', 'main-finalize-done', 'main-send', 'renderer-veto']);
  assert.equal(s.getState().fixture, undefined, 'veto did not undo the already accepted main write');
});

integration('actual pushRed changes the mod leaf without invoking ADD_MOD checks', () => {
  const f = fixture();
  let checked = 0;
  f.registerSanityCheck('ADD_MOD', () => {checked++; return false;});
  const s = f.store();
  s.dispatch({type: '__persist_push', payload: {hive: 'persistent', operations: [
    {type: 'set', path: ['mods', 'fixture', 'new'], value: {id: 'new', marker: 'main-push'}},
  ]}});
  assert.equal(checked, 0);
  assert.equal(s.getState().fixture.new.marker, 'main-push');
});

integration('official renderer has sanity outside batching, not an inner-action interception middleware', () => {
  const f = inputs();
  const declaration = f.find('renderer.tsx', n => f.ts.isVariableDeclaration(n) && n.name.getText() === 'middleware');
  assert.ok(f.ts.isArrayLiteralExpression(declaration.initializer));
  assert.deepEqual(declaration.initializer.elements.map(e => e.getText()), [
    'thunkMiddleware', 'reduxSanity(sanityCheckCB)', 'persistDiffMiddleware', 'reduxLogger()',
  ]);
  const reducer = f.find('reducers/index.ts', n => f.ts.isFunctionDeclaration(n) && n.name?.getText() === 'reducers');
  const returns = reducer.body.statements.filter(f.ts.isReturnStatement);
  assert.equal(returns.length, 1);
  assert.equal(returns[0].expression.expression.getText(), 'enableBatching');
  // AST linkage is supplementary; executable counterexamples above use these actual packages/functions.
});
