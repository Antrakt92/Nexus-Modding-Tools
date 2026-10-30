'use strict';
// One owned check; stop prevents future ticks and drain joins that check.
function create({check, onError, delayMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now}) {
  if (typeof check !== 'function' || typeof onError !== 'function' || !Number.isFinite(delayMs) || delayMs < 1
      || ![setTimer, clearTimer, now].every(value => typeof value === 'function')) throw Error('INVALID_SERIAL_POLLER');
  let handle = null, started = false, stopped = false, running = false, failure;
  let flight = Promise.resolve();
  const metrics = {checks: 0, maxCheckMs: 0, totalCheckMs: 0, maxConcurrent: 0, delayAfterCompletionMs: delayMs};
  function stop() {
    stopped = true;
    if (handle !== null) {const owned = handle; handle = null; clearTimer(owned);}
  }
  async function fail(error) {
    stopped = true;
    if (failure) return;
    failure = error instanceof Error ? error : Error('SERIAL_POLLER_CHECK_FAILED');
    // A callback must not await its own poller flight. Its work remains owned
    // and bounded by the caller, just like check().
    try {await onError(failure);}
    catch (handlerError) {failure = new AggregateError([failure, handlerError], 'SERIAL_POLLER_ERROR_HANDLER_FAILED');}
  }
  function schedule() {if (!stopped) handle = setTimer(tick, delayMs);}
  function tick() {
    handle = null;
    if (stopped) return flight;
    // A queued timer callback cannot start a second in-flight check.
    if (running) return flight;
    running = true; metrics.checks++; metrics.maxConcurrent = Math.max(metrics.maxConcurrent, 1);
    let resolve;
    flight = new Promise(done => {resolve = done;});
    // execute catches check, callback and timer failures; flight itself never
    // rejects before a caller has had a chance to stop and drain it.
    async function execute() {
      let begin;
      try {begin = now(); await check();}
      catch (error) {await fail(error);}
      finally {
        try {
          const duration = now() - begin;
          if (Number.isFinite(duration) && duration >= 0) {
            metrics.totalCheckMs += duration; metrics.maxCheckMs = Math.max(metrics.maxCheckMs, duration);
          }
        } catch (error) {await fail(error);}
        running = false;
        try {schedule();} catch (error) {await fail(error);}
        resolve();
      }
    }
    void execute();
    return flight;
  }
  return {
    start() {if (started || stopped) throw Error('POLLER_NO_REENTRY'); started = true; schedule();},
    stop,
    async drain() {
      if (!stopped) throw Error('POLLER_DRAIN_REQUIRES_STOP');
      await flight;
      if (failure) throw failure;
    },
    metrics() {return {...metrics, running, stopped};},
  };
}
module.exports = {create};
