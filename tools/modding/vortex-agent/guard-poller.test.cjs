'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {create} = require('./guard-poller.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function timers() {
  let next = 0; const active = new Map(), callbacks = [], delays = [];
  return {active, callbacks, delays,
    setTimer(fn, ms) {const id = ++next; active.set(id, fn); callbacks.push(fn); delays.push(ms); return id;},
    clearTimer(id) {active.delete(id);},
    fire() {const [id, fn] = active.entries().next().value; active.delete(id); return fn();},
  };
}
const options = clock => ({setTimer: clock.setTimer, clearTimer: clock.clearTimer});
test('synchronous check completes before scheduling the next delayed tick; metrics stay compatible', async () => {
  const clock = timers(); let calls = 0, time = 10;
  const poll = create({...options(clock), check() {calls++; time += 7;}, onError() {assert.fail('error');}, delayMs: 20, now: () => time});
  poll.start(); assert.equal(calls, 0); const first = clock.fire(); assert.equal(calls, 1); assert.equal(clock.active.size, 0);
  await first; assert.equal(clock.active.size, 1); assert.deepEqual(clock.delays, [20, 20]);
  poll.stop(); await poll.drain(); assert.deepEqual(poll.metrics(), {checks: 1, maxCheckMs: 7, totalCheckMs: 7, maxConcurrent: 1, delayAfterCompletionMs: 20, running: false, stopped: true});
});
test('stop cancels pending timer; an already queued late callback never invokes check', async () => {
  const clock = timers(); let calls = 0;
  const poll = create({...options(clock), check: () => calls++, onError() {}}); poll.start(); const queued = clock.callbacks[0];
  poll.stop(); poll.stop(); assert.equal(clock.active.size, 0); await queued(); await poll.drain(); assert.equal(calls, 0);
});
test('drain requires stopped and waits for the one owned asynchronous check', async () => {
  const clock = timers(); let finish, calls = 0, drained = false;
  const poll = create({...options(clock), check: () => {calls++; return new Promise(resolve => {finish = resolve;});}, onError() {}});
  await assert.rejects(poll.drain(), /POLLER_DRAIN_REQUIRES_STOP/); poll.start(); const check = clock.fire();
  const overlap = clock.callbacks[0](); // do not queue overlapping work
  poll.stop(); const drain = poll.drain().then(() => {drained = true;}); await turn();
  assert.equal(drained, false); assert.equal(calls, 1); assert.equal(poll.metrics().running, true);
  finish(); await check; await overlap; await drain; assert.equal(clock.active.size, 0); assert.equal(poll.metrics().running, false);
});
test('stopping while check runs prevents reschedule and new ticks after settlement', async () => {
  const clock = timers(); let finish, calls = 0;
  const poll = create({...options(clock), check: () => {calls++; return new Promise(resolve => {finish = resolve;});}, onError() {}});
  poll.start(); const first = clock.fire(); poll.stop(); const drain = poll.drain(); finish(); await first; await drain;
  await clock.callbacks[0](); assert.equal(calls, 1); assert.equal(clock.active.size, 0); assert.equal(clock.delays.length, 1);
});
test('check rejection stops permanently, notifies once, and drain surfaces the original failure', async () => {
  const clock = timers(), error = Error('SOURCE_CHANGED'); let reported;
  const poll = create({...options(clock), check: async () => {throw error;}, onError: e => {reported = e;}});
  poll.start(); await clock.fire(); assert.equal(reported, error); assert.equal(clock.active.size, 0);
  await assert.rejects(poll.drain(), e => e === error); await assert.rejects(poll.drain(), e => e === error);
  assert.throws(() => poll.start(), /POLLER_NO_REENTRY/);
});
test('onError throw or async rejection remains joined with primary failure and never unhandled', async () => {
  for (const asynchronous of [false, true]) {
    const clock = timers(), primary = Error('CHECK_FAILED'), secondary = Error('HANDLER_FAILED'), unhandled = [];
    const listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
    try {
      const poll = create({...options(clock), check() {throw primary;}, onError() {if (asynchronous) return Promise.reject(secondary); throw secondary;}});
      poll.start(); void clock.fire(); await turn(); await turn();
      await assert.rejects(poll.drain(), e => e instanceof AggregateError && e.errors[0] === primary && e.errors[1] === secondary);
      assert.deepEqual(unhandled, []); assert.equal(clock.active.size, 0);
    } finally {process.removeListener('unhandledRejection', listener);}
  }
});
test('drain joins a bounded asynchronous onError callback without starting another check', async () => {
  const clock = timers(); let handlerFinish, entered = false;
  const poll = create({...options(clock), check() {throw Error('PRIMARY');}, onError() {entered = true; return new Promise(resolve => {handlerFinish = resolve;});}});
  poll.start(); const first = clock.fire(); assert.equal(entered, true); poll.stop();
  let joined = false; const drain = poll.drain().then(() => {joined = true;}, error => {assert.match(error.message, /PRIMARY/); joined = true;});
  await turn(); assert.equal(joined, false); handlerFinish(); await first; await drain; assert.equal(joined, true);
});
test('start has no reentry, including after an explicit stop before start', async () => {
  const clock = timers(), poll = create({...options(clock), check() {}, onError() {}}); poll.start(); assert.throws(() => poll.start(), /NO_REENTRY/);
  poll.stop(); await poll.drain(); assert.throws(() => poll.start(), /NO_REENTRY/);
  const inert = create({...options(timers()), check() {}, onError() {}}); inert.stop(); assert.throws(() => inert.start(), /NO_REENTRY/); await inert.drain();
});
