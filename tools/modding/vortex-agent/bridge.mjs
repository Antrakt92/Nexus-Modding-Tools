#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import credential from './credential.cjs';
import {RUN_PLAN_TOOL, INSPECT_PLAN_TOOL} from './plan-tool.mjs';
export const ENDPOINT = 'http://127.0.0.1:3701/mcp';
const RESTART_GUIDANCE = 'Authorized close/restart: read docs/AUTHORIZED-RESTART.md in the maintained Vortex Nexus Modding MCP checkout. MainWindowHandle=0 does not rule out hidden windows. Use the reviewed native WM_CLOSE route scoped to the exact main PID/generation, executable/source pins, stopped game, pending-operation and updater guards; verify all Vortex processes exit. Never force-kill. A missing MCP shutdown tool alone does not require manual closure.';
function maintainedToolMetadata(tool) {
  if (tool.name !== 'health') return tool;
  const description = typeof tool.description === 'string' ? tool.description : '';
  return description.includes(RESTART_GUIDANCE) ? tool : {...tool,
    description: [description, RESTART_GUIDANCE].filter(Boolean).join(' ')};
}

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
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pieces = [], dataLines = [], skipLF = false, bytes = 0;
    try {
      while (!message) {
        const { value, done } = await reader.read();
        bytes += value?.byteLength || 0;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('MCP response too large');
        const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
        let start = skipLF && chunk.startsWith('\n') ? 1 : 0;
        if (chunk.length) skipLF = false;
        // Scan each new chunk once; rescanning a growing event for every read
        // makes large, fragmented inventory replies quadratic.
        const endings = /[\r\n]/g; endings.lastIndex = start;
        let ending;
        while ((ending = endings.exec(chunk)) !== null) {
          pieces.push(chunk.slice(start, ending.index));
          const line = pieces.join(''); pieces = [];
          start = endings.lastIndex;
          if (ending[0] === '\r') {
            if (chunk[start] === '\n') {start++; endings.lastIndex = start;}
            else if (start === chunk.length) skipLF = true;
          }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          else if (!line && dataLines.length) {
            const data = dataLines.join('\n'); dataLines = [];
            if (data) {const candidate = parse(data); if (candidate.id === 1) message = candidate;}
          }
        }
        if (start < chunk.length) pieces.push(chunk.slice(start));
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
    return { ...message.result, tools: message.result.tools.filter(tool => tool.name !== 'install_download').map(maintainedToolMetadata) };
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
const LOCAL_TOOLS = [INSPECT_TOOL, COLLECTION_DOWNLOADS_TOOL, RUN_PLAN_TOOL, INSPECT_PLAN_TOOL];
function localToolResult(result) {
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, ...(['partial', 'stopped'].includes(result.status) ? {isError: true} : {})};
}

// Compose existing guarded operations; their native eligibility/receipt guards remain authoritative.
export async function clientRemote(method, params = {}, transport = remote, {signal, journal} = {}) {
  if (method === 'tools/list') {
    const result = await transport(method, params);
    if (!Array.isArray(result?.tools)) throw new Error('Invalid Vortex tool inventory');
    return {...result, tools: [...result.tools.filter(tool => tool.name !== 'install_download' && !LOCAL_TOOLS.some(local => local.name === tool.name)).map(maintainedToolMetadata), ...structuredClone(LOCAL_TOOLS)]};
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
  if (method === 'tools/call' && params.name === 'run_mod_plan') {
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'plan')
      || Object.keys(args).some(key => !['plan', 'apply'].includes(key))
      || args.apply !== undefined && typeof args.apply !== 'boolean')
      return localToolResult({status: 'stopped', code: 'INVALID_PLAN_REQUEST', diskDeploymentVerified: false});
    const {runPlan, createToolCaller} = await import('./session.mjs');
    try {return localToolResult(await runPlan(args.plan, {apply: args.apply ?? false, call: createToolCaller(transport), signal, journal}));}
    catch (error) {
      const code = /^(?:INVALID_PLAN(?:_CONTEXT|_STEPS|_STEP|_SIGNAL)?|INVALID_DEPLOY_STEP|INVALID_APPLY_FLAG|DUPLICATE_REQUEST_ID|EMPTY_PLAN)$/.test(error.message)
        ? error.message : 'PLAN_VALIDATION_FAILED';
      return localToolResult({status: 'stopped', code, diskDeploymentVerified: false});
    }
  }
  if (method === 'tools/call' && params.name === 'inspect_mod_plan') {
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
      || !Object.hasOwn(args, 'planId') || typeof args.planId !== 'string' || !/^[a-f0-9]{64}$/.test(args.planId))
      return localToolResult({status: 'stopped', code: 'INVALID_PLAN_ID', diskDeploymentVerified: false});
    const {inspectPlan, createToolCaller} = await import('./session.mjs');
    return localToolResult(await inspectPlan(args.planId, {call: createToolCaller(transport), journal}));
  }
  return transport(method, params);
}

export function handler(call = remote, {journal} = {}) {
  let initialized = false;
  const plans = new Map();
  const handle = async request => {
    const hasId = request !== null && typeof request === 'object' && Object.hasOwn(request, 'id');
    const validId = hasId && (typeof request.id === 'string' || Number.isSafeInteger(request.id));
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || hasId && !validId)
      return { jsonrpc: '2.0', id: validId ? request.id : null, error: { code: -32600, message: 'Invalid Request' } };
    if (!hasId) {
      if (request.method === 'notifications/cancelled') plans.get(request.params?.requestId)?.abort();
      return undefined;
    }
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
        if (request.method === 'tools/call' && request.params?.name === 'run_mod_plan') {
          if (plans.has(request.id)) throw Error('DUPLICATE_ACTIVE_PLAN_REQUEST');
          const controller = new AbortController(); plans.set(request.id, controller);
          try {result = await clientRemote(request.method, request.params, call, {signal: controller.signal, journal});}
          finally {plans.delete(request.id);}
        } else result = await clientRemote(request.method, request.params || {}, call, {journal});
      } else return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) { return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }; }
  };
  handle.cancelPendingPlans = () => {for (const controller of plans.values()) controller.abort();};
  return handle;
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
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid MCP pending limit');
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
  let activeDispatches = 0;
  const cancelPlans = () => handle.cancelPendingPlans?.();
  output.on('close', cancelPlans); output.on('error', cancelPlans);
  try {
    for await (const line of boundedLines(input)) {
      if (line !== null && !line.trim()) continue;
      let request;
      try { if (line === null) throw new Error(); request = JSON.parse(line); }
      catch { await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const notification = request?.jsonrpc === '2.0' && typeof request.method === 'string'
        && !Object.hasOwn(request, 'id');
      // A full active queue must still receive cancellation. Do not grow a
      // second ordinary-request queue: overload closes fail-closed, cancelling
      // later plan steps while finally waits for already invoked settlement.
      if (!notification && pending.size >= maxPending && activeDispatches > 0)
        throw new Error('MCP request capacity exceeded');
      activeDispatches++;
      const dispatch = Promise.resolve(handle(request)).then(
        response => {activeDispatches--; return response;},
        error => {activeDispatches--; throw error;});
      const work = dispatch.then(response => response ? write(response) : undefined);
      pending.add(work);
      work.then(() => pending.delete(work), () => {});
      if (pending.size >= maxPending) {
        // Let already-resolved handlers leave activeDispatches before deciding
        // whether this is native work or merely stdout backpressure.
        await Promise.resolve();
        if (pending.size >= maxPending && activeDispatches === 0) await Promise.race(pending);
      }
    }
  } finally {
    cancelPlans();
    await Promise.allSettled(pending);
    output.off('close', cancelPlans); output.off('error', cancelPlans);
  }
  await Promise.all(pending);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
