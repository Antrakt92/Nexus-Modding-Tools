'use strict';
const LIMITS = Object.freeze({ bytes: 1024 * 1024, batch: 16, requests: 16, tools: 32, bodyTimeoutMs: 10000 });
// Shared by every start()/renderer server in this Node process, not by a client.
const key = Symbol.for('vortex-agent/ingress-v1');
const activity = globalThis[key] ||= { requests: 0, tools: 0 };
function acquire(kind) {
  if (kind === 'request') { if (activity.requests >= LIMITS.requests) return null; activity.requests++; }
  else { if (activity.tools >= LIMITS.tools) return null; activity.tools++; }
  let held = true;
  return () => { if (held) { held = false; if (kind === 'request') activity.requests--; else activity.tools--; } };
}
function body(req, signal) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const finish = (error, value) => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const fail = () => finish(Object.assign(Error('HTTP_BODY_ABORTED'), { status: 400 }));
    const aborted = () => fail();
    const data = chunk => { bytes += chunk.length; if (bytes > LIMITS.bytes) { req.pause(); finish(Object.assign(Error('HTTP_BODY_LIMIT'), { status: 413 })); }
      else chunks.push(chunk); };
    const end = () => { try { const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (Array.isArray(parsed) && (parsed.length === 0 || parsed.length > LIMITS.batch)) finish(Object.assign(Error('HTTP_BATCH_LIMIT'), { status: 413 }));
      else finish(null, parsed);
    } catch { finish(Object.assign(Error('HTTP_BODY_INVALID'), { status: 400 })); } };
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || req.aborted || req.destroyed) aborted();
  });
}
async function abortable(promise, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(Object.assign(Error('HTTP_REQUEST_ABORTED'), { status: 408 }));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  try { return await Promise.race([promise, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
async function rejectRequest(req, res, status, signal) {
  if (res.destroyed) return;
  // Flush a zero-length rejection before discarding the rest of a finite upload.
  // Closing a socket with unread upload bytes can lose the 413 to an ECONNRESET.
  res.writeHead(status, { 'Content-Length': '0', Connection: 'close' }); res.flushHeaders();
  if (!req.complete && !req.destroyed && !signal.aborted) {
    await new Promise(resolve => {
      const done = () => { req.off('end', done); req.off('aborted', done); req.off('error', done); signal.removeEventListener('abort', done); resolve(); };
      req.once('end', done); req.once('aborted', done); req.once('error', done); signal.addEventListener('abort', done, { once: true });
      req.resume(); if (req.complete || req.destroyed || signal.aborted) done();
    });
  }
  if (!res.destroyed) res.end();
}
module.exports = { LIMITS, acquire, body, abortable, rejectRequest, activity: () => ({ ...activity }) };
