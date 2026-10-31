import http from 'node:http';
import {types} from 'node:util';

const MAX_TIMEOUT_MS = 5000;
const failure = (code, cause) => Object.assign(new Error(code, cause === undefined ? undefined : {cause}), {code});
function check(listener, options) {
  if (types.isProxy(listener) || !(listener instanceof http.Server)) throw failure('AUDIT_SERVER_INVALID_LISTENER');
  if (!options || typeof options !== 'object' || types.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw failure('AUDIT_SERVER_INVALID_OPTIONS');
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => key !== 'timeoutMs')) throw failure('AUDIT_SERVER_INVALID_OPTIONS');
  const field = Object.getOwnPropertyDescriptor(options, 'timeoutMs');
  if (field && (!field.enumerable || !Object.hasOwn(field, 'value'))) throw failure('AUDIT_SERVER_INVALID_OPTIONS');
  const timeoutMs = field ? field.value : MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw failure('AUDIT_SERVER_INVALID_OPTIONS');
  return timeoutMs;
}

// Readiness observer only. The caller owns this exact server and must clean it
// up after failure. A missed early event is bounded by the deadline; no retry or
// inference about the original bind error is made after that event was missed.
export function waitForServerListening(listener, options = {}) {
  const timeoutMs = check(listener, options);
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listener.off('listening', listening);
      listener.off('error', failed);
      listener.off('close', closed);
      if (error) reject(error); else resolve(listener);
    };
    const listening = () => finish();
    const failed = cause => finish(failure('AUDIT_SERVER_START_FAILED', cause));
    const closed = () => finish(failure('AUDIT_SERVER_START_CLOSED'));
    listener.on('listening', listening);
    listener.on('error', failed);
    listener.on('close', closed);
    timer = setTimeout(() => finish(failure('AUDIT_SERVER_START_TIMEOUT')), timeoutMs);
    if (listener.listening) finish();
  });
}

// Test-only lifecycle cleanup, scoped to the passed caller-owned HTTP server.
// Stop accepting before destroying connections. No process/global server action.
export function closeOwnedTestServer(listener, options = {}) {
  const timeoutMs = check(listener, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(failure('AUDIT_SERVER_CLOSE_TIMEOUT')), timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    try {
      listener.close(error => finish(error && error.code !== 'ERR_SERVER_NOT_RUNNING'
        ? failure('AUDIT_SERVER_CLOSE_FAILED', error) : undefined));
      listener.closeAllConnections();
    } catch (cause) {finish(failure('AUDIT_SERVER_CLOSE_FAILED', cause));}
  });
}
