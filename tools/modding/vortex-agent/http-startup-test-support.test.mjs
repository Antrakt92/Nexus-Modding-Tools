import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {waitForServerListening, closeOwnedTestServer} from './http-startup-test-support.mjs';

const counts = server => ['listening', 'error', 'close'].map(name => server.listenerCount(name));
function owned(t, handler) {
  const server = http.createServer(handler);
  t.after(() => closeOwnedTestServer(server, {timeoutMs: 1000}));
  return server;
}
async function start(server) {
  server.listen(0, '127.0.0.1');
  return waitForServerListening(server, {timeoutMs: 1000});
}

test('start-before-wait succeeds on a real owned server and removes only its listeners', async t => {
  const server = owned(t), original = () => {};
  for (const name of ['listening', 'error', 'close']) server.on(name, original);
  const before = counts(server);
  server.listen(0, '127.0.0.1');
  assert.equal(await waitForServerListening(server, {timeoutMs: 1000}), server);
  assert.equal(server.listening, true); assert.deepEqual(counts(server), before);
});

test('already-listening success does not leak a deadline timer or event listeners', async t => {
  const server = owned(t); await start(server);
  const before = counts(server);
  const timers = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  assert.equal(await waitForServerListening(server), server);
  assert.deepEqual(counts(server), before);
  assert.equal(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length, timers);
});

test('real EADDRINUSE rejects with original cause; failed-server cleanup preserves the port owner', async t => {
  const first = owned(t); await start(first);
  const second = owned(t); let original;
  second.on('error', error => {original = error;});
  const before = counts(second);
  second.listen(first.address().port, '127.0.0.1');
  await assert.rejects(waitForServerListening(second, {timeoutMs: 1000}), error =>
    error.code === 'AUDIT_SERVER_START_FAILED' && error.cause === original && error.cause.code === 'EADDRINUSE');
  assert.deepEqual(counts(second), before);
  await closeOwnedTestServer(second, {timeoutMs: 1000});
  assert.equal(first.listening, true); assert(first.address().port > 0); assert.equal(second.listening, false);
});

test('never-started server has a bounded deadline and leaves original listeners untouched', async t => {
  const server = owned(t); server.on('error', () => {});
  const before = counts(server);
  await assert.rejects(waitForServerListening(server, {timeoutMs: 15}), {code: 'AUDIT_SERVER_START_TIMEOUT'});
  assert.deepEqual(counts(server), before);
  assert.equal(server.listening, false);
});

test('a bind error emitted before the waiter was attached becomes a deadline, not an invented cause', async t => {
  const first = owned(t); await start(first);
  const second = owned(t); const failed = once(second, 'error');
  second.listen(first.address().port, '127.0.0.1'); await failed;
  const before = counts(second);
  await assert.rejects(waitForServerListening(second, {timeoutMs: 15}), error =>
    error.code === 'AUDIT_SERVER_START_TIMEOUT' && error.cause === undefined);
  assert.deepEqual(counts(second), before); assert.equal(first.listening, true);
});

test('close before listening rejects immediately and removes readiness observers', async t => {
  const server = owned(t), before = counts(server);
  const ready = waitForServerListening(server, {timeoutMs: 1000});
  server.close();
  await assert.rejects(ready, {code: 'AUDIT_SERVER_START_CLOSED'});
  assert.deepEqual(counts(server), before);
});

test('invalid options and fake listeners fail without invoking caller accessors', async t => {
  const server = owned(t), before = counts(server); let called = 0;
  for (const options of [null, [], {extra: true}, {timeoutMs: 0}, {timeoutMs: 5001}, {timeoutMs: Infinity}, {timeoutMs: true}, {timeoutMs: 1.5}]) {
    assert.throws(() => waitForServerListening(server, options), {code: 'AUDIT_SERVER_INVALID_OPTIONS'});
    assert.throws(() => closeOwnedTestServer(server, options), {code: 'AUDIT_SERVER_INVALID_OPTIONS'});
  }
  const getter = {get timeoutMs() {called++; throw Error('not data');}};
  assert.throws(() => waitForServerListening(server, getter), {code: 'AUDIT_SERVER_INVALID_OPTIONS'});
  const proxy = new Proxy({}, {getPrototypeOf() {called++; throw Error('trap');}});
  assert.throws(() => waitForServerListening(proxy), {code: 'AUDIT_SERVER_INVALID_LISTENER'});
  assert.throws(() => waitForServerListening({}), {code: 'AUDIT_SERVER_INVALID_LISTENER'});
  assert.deepEqual(counts(server), before); assert.equal(called, 0);
});

test('cleanup closes an unfinished owned upload while leaving a sibling server listening', {timeout: 3000}, async t => {
  const server = owned(t), sibling = owned(t); await start(server); await start(sibling);
  const accepted = once(server, 'request', {signal: AbortSignal.timeout(1000)});
  const request = http.request({host: '127.0.0.1', port: server.address().port, method: 'POST', headers: {'transfer-encoding': 'chunked'}});
  request.on('error', () => {}); t.after(() => request.destroy());
  const closed = new Promise(resolve => request.once('close', resolve));
  request.flushHeaders(); request.write('{'); await accepted;
  await closeOwnedTestServer(server, {timeoutMs: 1000});
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('owned request failed to close')), 1000);
    closed.finally(() => clearTimeout(timer));
  })]);
  assert.equal(server.listening, false); assert.equal(request.destroyed, true); assert.equal(sibling.listening, true);
});
