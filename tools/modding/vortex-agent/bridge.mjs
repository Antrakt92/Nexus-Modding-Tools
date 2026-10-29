#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import credential from './credential.cjs';
export const ENDPOINT = 'http://127.0.0.1:3701/mcp';
function parse(text) { try { return JSON.parse(text); } catch { throw new Error('Invalid MCP JSON payload'); } }
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function cancelBody(body) { if (body) void body.cancel().catch(() => {}); }
function releaseReader(reader) { cancelBody(reader); reader.releaseLock(); }
export async function* boundedLines(input, max = 1024 * 1024) {
  let pieces = [], bytes = 0, dropping = false;
  const decode = data => { try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; } };
  for await (const chunk of input) {
    const data = Buffer.from(chunk); let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline;
      const fragment = data.subarray(start, end);
      if (!dropping) {
        bytes += fragment.length;
        if (bytes > max) { pieces = []; bytes = 0; dropping = true; }
        else pieces.push(fragment);
      }
      if (newline < 0) break;
      yield dropping ? null : decode(Buffer.concat(pieces, bytes))?.replace(/\r$/, '') ?? null;
      pieces = []; bytes = 0; dropping = false; start = newline + 1;
    }
  }
  if (dropping) yield null;
  else if (bytes) yield decode(Buffer.concat(pieces, bytes));
}
export async function remote(method, params = {}, fetcher = fetch, tokenProvider = credential.readToken) {
  if (method === 'tools/call' && params.name === 'install_download') {
    throw new Error('Native installation is unsupported by this adapter. Use the inspected native workflow in vortex-mod-lifecycle; do not retry install_download.');
  }
  let response;
  let token;
  try { token = await tokenProvider(); }
  catch { throw new Error('Vortex Agent credential unavailable. Run node "' + fileURLToPath(new URL('./credential.cjs', import.meta.url)) + '" --initialize once as the Windows user running Vortex.'); }
  try { response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(300000) }); }
  catch { throw new Error('Vortex MCP unavailable or timed out. Start Vortex with the audited vortex-agent extension, verify port 3701 ownership; inspect receipts before retrying a write.'); }
  if (!response.ok) {
    cancelBody(response.body);
    throw new Error(response.status === 401 ? 'Vortex MCP authentication failed. Run credential.cjs --initialize once as the same Windows user as Vortex, then verify extension and credential ownership.' : `Vortex MCP HTTP ${response.status}; verify the adapted extension and port ownership.`);
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { cancelBody(response.body); throw new Error('MCP response too large'); }
  if (!response.body) throw new Error('Invalid Vortex MCP response');
  let message;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', bytes = 0;
    try {
      while (!message) {
        const { value, done } = await reader.read();
        bytes += value?.byteLength || 0;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('MCP response too large');
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { const candidate = parse(data); if (candidate.id === 1) message = candidate; }
        }
        if (done) break;
      }
    } catch (error) {
      throw new Error(error.message === 'MCP response too large' ? 'MCP response too large' : 'Invalid Vortex MCP response');
    } finally { releaseReader(reader); }
  } else {
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > MAX_RESPONSE_BYTES) throw new Error('MCP response too large');
        chunks.push(value);
      }
      message = parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch (error) {
      throw new Error(error.message === 'MCP response too large' ? 'MCP response too large' : 'Invalid Vortex MCP response');
    } finally { releaseReader(reader); }
  }
  if (!message || message.jsonrpc !== '2.0' || message.id !== 1) throw new Error('Invalid Vortex MCP response');
  if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('Invalid Vortex MCP response');
  if (Object.hasOwn(message, 'error') && (!message.error || typeof message.error !== 'object')) throw new Error('Invalid Vortex MCP response');
  if (message.error) throw new Error('Vortex MCP rejected the request; verify tool arguments and adapted protocol.');
  if (method === 'tools/list' && Array.isArray(message.result?.tools)) {
    return { ...message.result, tools: message.result.tools.filter(tool => tool.name !== 'install_download') };
  }
  return message.result;
}
const INSPECT_TOOL = {
  name: 'inspect_session',
  description: 'Read the active Vortex context, mods, downloads, dialogs and external changes in one bounded call. Optional diagnostics add native conflicts and collection observations. Partial results expose errors and limits; this is not deployment or gameplay proof.',
  inputSchema: {type: 'object', properties: {diagnostics: {type: 'boolean', default: false}}, additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};
const COLLECTION_DOWNLOADS_TOOL = {
  name: 'find_collection_downloads',
  description: 'Match up to 100 Nexus mod/file pairs against tracked downloads for the expected active game in one compact read. Reports finished/active/paused/failed candidates, duplicates, unknown identities and capped/partial observations. Metadata only: does not verify archive bytes or authorize downloading/installing.',
  inputSchema: {type: 'object', required: ['gameId', 'files'], additionalProperties: false, properties: {
    gameId: {type: 'string', pattern: '^[a-z0-9_-]{1,200}$'},
    files: {type: 'array', minItems: 1, maxItems: 100, items: {type: 'object', additionalProperties: false,
      required: ['nexusModId', 'nexusFileId'], properties: {
        nexusModId: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
        nexusFileId: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
      }}},
  }},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};
const LOCAL_TOOLS = [INSPECT_TOOL, COLLECTION_DOWNLOADS_TOOL];
function localToolResult(result) {
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, ...(result.status === 'partial' ? {isError: true} : {})};
}

// Compose existing curated reads in the client; no host upgrade or native API is needed.
export async function clientRemote(method, params = {}, transport = remote) {
  if (method === 'tools/list') {
    const result = await transport(method, params);
    if (!Array.isArray(result?.tools)) throw new Error('Invalid Vortex tool inventory');
    return {...result, tools: [...result.tools.filter(tool => tool.name !== 'install_download' && !LOCAL_TOOLS.some(local => local.name === tool.name)), ...structuredClone(LOCAL_TOOLS)]};
  }
  if (method === 'tools/call' && params.name === 'inspect_session') {
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => key !== 'diagnostics')
      || args.diagnostics !== undefined && typeof args.diagnostics !== 'boolean')
      return {isError: true, content: [{type: 'text', text: '{"error":"INVALID_INSPECTION_OPTIONS"}'}]};
    // Dynamic import avoids initializing session.mjs through its bridge import.
    const {inspectSession, createToolCaller} = await import('./session.mjs');
    const result = await inspectSession({call: createToolCaller(transport), diagnostics: args.diagnostics ?? false});
    return localToolResult(result);
  }
  if (method === 'tools/call' && params.name === 'find_collection_downloads') {
    const {findCollectionDownloads} = await import('./collection-downloads.mjs');
    const {createToolCaller} = await import('./session.mjs');
    try { return localToolResult(await findCollectionDownloads(params.arguments, {call: createToolCaller(transport)})); }
    catch (error) {
      if (error.message !== 'INVALID_COLLECTION_REQUEST') throw error;
      return {isError: true, content: [{type: 'text', text: '{"error":"INVALID_COLLECTION_REQUEST"}'}]};
    }
  }
  return transport(method, params);
}

export function handler(call = remote) {
  let initialized = false;
  return async request => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const hasId = Object.hasOwn(request, 'id');
    if (!hasId) return undefined;
    try {
      let result;
      if (request.method === 'initialize') {
        const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
        // SDK2 stateless upstream has no initialize; terminate the legacy handshake
        // here and speak only tools/list and tools/call to HTTP.
        const health = await call('tools/call', { name: 'health', arguments: {} });
        const info = parse(health.content?.find(c => c.type === 'text')?.text || '{}');
        if (health.isError || info.protocol !== 'vortex-agent/1') throw new Error('Wrong server on port 3701: vortex-agent/1 health required');
        initialized = true;
        result = { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'vortex-agent-bridge', version: '1.0.4' } };
      } else if (request.method === 'ping') result = {};
      else if (['tools/list', 'tools/call'].includes(request.method)) {
        if (!initialized) throw new Error('Initialize the bridge first');
        result = await clientRemote(request.method, request.params || {}, call);
      } else return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) { return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }; }
  };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length) {
    if (argv[0] !== '--health' && argv[0] !== '--call') throw new Error('Usage: bridge.mjs [--health | --call TOOL JSON_ARGUMENTS]');
    if (argv[0] === '--call' && !argv[1]) throw new Error('--call requires a tool name and optional JSON arguments');
    const health = await remote('tools/call', { name: 'health', arguments: {} });
    const info = parse(health.content?.[0]?.text || '{}');
    if (health.isError || info.protocol !== 'vortex-agent/1') throw new Error('Wrong server on port 3701');
    const result = argv[0] === '--health' ? health : await clientRemote('tools/call', { name: argv[1], arguments: parse(argv[2] || '{}') });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.isError) process.exitCode = 1;
    return;
  }
  await runStdio(process.stdin, process.stdout, handler());
}
export async function runStdio(input, output, handle, maxPending = 100) {
  let writing = Promise.resolve();
  const write = response => {
    const next = writing.then(() => new Promise((resolve, reject) => {
      const failed = error => { output.off('close', closed); reject(error); };
      const closed = () => { output.off('error', failed); reject(new Error('MCP output closed')); };
      output.once('error', failed); output.once('close', closed);
      output.write(JSON.stringify(response) + '\n', error => {
        if (error) { output.off('close', closed); reject(error); }
        else { output.off('error', failed); output.off('close', closed); resolve(); }
      });
    }));
    writing = next;
    return next;
  };
  // Concurrent requests preserve IDs; long writes must not block dialog reads.
  const pending = new Set();
  for await (const line of boundedLines(input)) {
    if (line !== null && !line.trim()) continue;
    let request;
    try { if (line === null) throw new Error(); request = JSON.parse(line); }
    catch { await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    const work = handle(request).then(response => response ? write(response) : undefined);
    pending.add(work);
    work.then(() => pending.delete(work), () => {});
    if (pending.size >= maxPending) await Promise.race(pending);
  }
  await Promise.all(pending);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
