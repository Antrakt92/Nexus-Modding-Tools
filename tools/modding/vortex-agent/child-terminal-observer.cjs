'use strict';
// Passive I/O observer, not an operation outcome or release permit. Adding error
// listeners changes otherwise-unhandled EventEmitter errors into diagnostics.
// The trusted owner must attach synchronously immediately after spawn returns.
// In-process event forgery/monkeypatching, descendants and persistence are outside
// this boundary. No wrapper promise, PID, kill result or abort proves closure.
const {ChildProcess} = require('node:child_process');
const {Socket} = require('node:net');
const {EventEmitter} = require('node:events');
const {isProxy} = require('node:util').types;
const observed = new WeakMap();
const on = EventEmitter.prototype.on;
const fields = ['operationId', 'nativeJobId', 'requestSHA256', 'rendererGeneration'];
const patterns = [/^op_[a-f0-9]{32}$/, /^exec_[a-f0-9]{32}$/, /^[a-f0-9]{64}$/, /^renderer_[a-f0-9]{32}$/];
const fail = code => {throw Error('CHILD_TERMINAL_' + code);};
const full = (expression, value) => {
  const matched = expression.exec(value);
  return !!matched && matched[0] === value;
};
function bindingCopy(value) {
  if (!value || typeof value !== 'object' || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_BINDING');
  const keys = Reflect.ownKeys(value), copy = {};
  if (keys.length !== fields.length) fail('INVALID_BINDING');
  for (let n = 0; n < fields.length; n++) {
    const key = fields[n], field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')
        || typeof field.value !== 'string' || !full(patterns[n], field.value)) fail('INVALID_BINDING');
    copy[key] = field.value;
  }
  return Object.freeze(copy);
}
function diagnostic(error, fallback) {
  if (error && (typeof error === 'object' || typeof error === 'function') && !isProxy(error)) {
    const field = Object.getOwnPropertyDescriptor(error, 'code');
    if (field && Object.hasOwn(field, 'value') && typeof field.value === 'string'
        && full(/^[A-Z][A-Z0-9_]{1,63}$/, field.value)) return field.value;
  }
  return fallback;
}
function pair(code, signal) {
  return Number.isSafeInteger(code) && code >= -2147483648 && code <= 4294967295 && signal === null
    || code === null && typeof signal === 'string' && full(/^SIG[A-Z0-9]{1,29}$/, signal);
}
function observeChildTerminal(child, inputBinding) {
  const binding = bindingCopy(inputBinding);
  if (!child || isProxy(child) || !(child instanceof ChildProcess)) fail('INVALID_CHILD');
  const previous = observed.get(child);
  if (previous) {
    if (!fields.every(key => previous[key] === binding[key])) fail('BINDING_MISMATCH');
    fail('ALREADY_OBSERVED');
  }
  const streams = [child.stdin, child.stdout, child.stderr];
  if (!Array.isArray(child.stdio) || child.stdio.length !== 3 || child.channel != null
      || child.connected === true || new Set(streams).size !== 3
      || streams.some((stream, n) => !stream || isProxy(stream) || !(stream instanceof Socket) || child.stdio[n] !== stream)) fail('INVALID_PIPES');
  // Retain the exact objects in the returned observer's closure. The WeakMap is
  // per loaded module/child, not a cross-renderer or durable job registry.
  const tracked = {child, streams};
  observed.set(child, binding);
  const state = {spawn: false, exit: false, close: false, childError: false,
    childErrorCode: null, exitCode: null, exitSignal: null, closeCode: null, closeSignal: null,
    held: false, reason: null, attaching: true, preSpawnError: false,
    pipes: streams.map(() => ({close: false, error: false, errorCode: null}))};
  const initiallyHasPid = Number.isSafeInteger(child.pid) && child.pid > 0;
  const hold = reason => {state.held = true; state.reason ??= reason;};
  if (child.exitCode !== null || child.signalCode !== null || child.killed !== false
      || streams.some(stream => stream.closed !== false || stream.destroyed !== false)) hold('LATE_ADOPTION');
  function event() {if (state.attaching) hold('EVENT_DURING_ATTACHMENT');}
  function childError(error) {
    event();
    if (!state.childError) state.childErrorCode = diagnostic(error, 'CHILD_ERROR');
    state.childError = true;
    if (!state.spawn && !state.close) state.preSpawnError = true;
  }
  try {
    on.call(child, 'error', childError);
    streams.forEach((stream, n) => {
      on.call(stream, 'error', error => {
        event();
        if (!state.pipes[n].error) state.pipes[n].errorCode = diagnostic(error, 'STREAM_ERROR');
        state.pipes[n].error = true;
      });
    });
    on.call(child, 'spawn', () => {
      event();
      if (state.spawn || state.exit || state.close || state.preSpawnError) hold('CONTRADICTORY_SPAWN');
      state.spawn = true;
    });
    on.call(child, 'exit', (code, signal) => {
      event();
      if (state.exit || state.close || !state.spawn) hold('CONTRADICTORY_EXIT');
      state.exit = true;
      if (!pair(code, signal)) hold('INVALID_EXIT');
      else {state.exitCode = code; state.exitSignal = signal;}
    });
    on.call(child, 'close', (code, signal) => {
      event();
      if (state.close) hold('DUPLICATE_CLOSE');
      state.close = true;
      if (!pair(code, signal)) hold('INVALID_CLOSE');
      else {state.closeCode = code; state.closeSignal = signal;}
      if (state.spawn) {
        if (!state.exit || code !== state.exitCode || signal !== state.exitSignal) hold('EXIT_CLOSE_MISMATCH');
      } else if (initiallyHasPid || !state.childError || state.exit) hold('UNKNOWN_SPAWN');
      // Node may emit child.close from its internal pipe-close listener BEFORE
      // this observer's final pipe.close callback. read() waits for both facts.
    });
    streams.forEach((stream, n) => {
      on.call(stream, 'close', () => {
        event();
        if (state.pipes[n].close) hold('DUPLICATE_PIPE_CLOSE');
        state.pipes[n].close = true;
      });
    });
  } catch {hold('ATTACHMENT_FAILED');}
  state.attaching = false;
  return Object.freeze({read() {
    // Reading the tracked objects retains them; it performs no stream reads,
    // resume, cancellation, listener detachment or child cleanup.
    if (tracked.child !== child || tracked.streams.length !== 3) hold('IDENTITY_CHANGED');
    const pipesClosed = state.pipes.every(pipe => pipe.close);
    const exited = state.spawn && state.exit && state.close
      && state.exitCode === state.closeCode && state.exitSignal === state.closeSignal;
    const spawnFailed = !state.spawn && !initiallyHasPid && state.childError && !state.exit && state.close;
    const childResourcesClosed = !state.held && pipesClosed && (exited || spawnFailed);
    const pipe = item => Object.freeze({closeObserved: item.close, errorObserved: item.error, errorCode: item.errorCode});
    return Object.freeze({schema: 'child-terminal-observation/1', binding,
      spawnObserved: state.spawn, exitObserved: state.exit, closeObserved: state.close,
      childErrorObserved: state.childError, childErrorCode: state.childErrorCode,
      exitCode: state.exitCode, exitSignal: state.exitSignal, closeCode: state.closeCode, closeSignal: state.closeSignal,
      pipes: Object.freeze({stdin: pipe(state.pipes[0]), stdout: pipe(state.pipes[1]), stderr: pipe(state.pipes[2])}),
      childResourcesClosed, held: state.held, reasonCode: state.reason,
      outcome: state.held ? 'held' : childResourcesClosed ? (spawnFailed ? 'spawnFailed' : 'exited') : 'pending',
      exitSucceeded: state.exit && state.exitCode === 0 && state.exitSignal === null,
      nativeInstallAccepted: false, persistenceVerified: false, descendantsVerified: false});
  }});
}
module.exports = {observeChildTerminal};
