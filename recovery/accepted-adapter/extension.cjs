'use strict';
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/server');
const { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } = require('@modelcontextprotocol/node');
const { z } = require('zod');
const { actions, selectors, util, log } = require('@nexusmods/vortex-api');
const control = require('./vortexControl');
const { createOperations, safe } = require('./guard.cjs');
const { dialogs, conflicts, externalChanges, listDownloads } = require('./inspection.cjs');
const { catalogFromDisk } = require('./download-identity.cjs');
const ingress = require('./http-ingress.cjs');
const { VERIFICATION } = require('./receipts.cjs');
const credential = require('./credential.cjs');
const { publicErrorCode } = require('./serialization.cjs');
function register(server, api, options = {}) {
  const credentials = options.credentials || [];
  const catalog = catalogFromDisk(util);
  const operations = createOperations(api, actions, selectors, { credentials, catalog });
  const id = z.string().min(1).max(200);
  const read = { gameId: id.optional(), limit: z.number().int().min(1).max(500).default(100) };
  const write = { gameId: id, profileId: id, requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
    gamePath: id, stagingPath: id, downloadPath: id,
    filesystemIds: z.strictObject({ gamePath: id, stagingPath: id, downloadPath: id }) };
  const pins = { size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) };
  const status = z.strictObject({ protocol: z.literal('vortex-agent/1'), requestId: id,
    operation: z.enum(['install_download', 'set_mods_enabled', 'deploy_mods', 'download_nexus']),
    operationCompleted: z.literal(true), diskDeploymentVerified: z.literal(false), verificationRequired: z.literal(VERIFICATION),
    modId: id.optional(), installedRecordVerified: z.boolean().optional(), enabled: z.boolean().optional(),
    modIds: z.array(id).optional(), enabledFlagsVerified: z.boolean().optional(), deploymentPromiseResolved: z.boolean().optional(),
    downloadId: id.optional(), reused: z.boolean().optional(), archiveSha256Verified: z.boolean().optional(),
    size: z.number().int().positive().optional(), autoInstall: z.literal(false).optional(), archiveCRCVerified: z.literal(false).optional(),
  });
  const add = (name, fields, fn, writes = false) => server.registerTool(name, {
    description: writes ? 'Guarded active-context mutation; unique requestId and live path pins required. Result is NOT disk deployment proof.' : 'Curated read-only Vortex inspection.',
    inputSchema: z.strictObject(fields), annotations: { readOnlyHint: !writes, destructiveHint: writes },
    ...(writes ? { outputSchema: status } : {}),
  }, async args => {
    const release = ingress.acquire('tool');
    if (!release) return { isError: true, content: [{ type: 'text', text: '{"error":"TOOL_CONCURRENCY_LIMIT"}' }] };
    try {
      const result = safe(await fn(args), api, name, credentials);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(writes ? { structuredContent: result } : {}) };
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: publicErrorCode(error, api, credentials), action: 'Re-read health/context, inspect external receipts and Vortex UI/log privately. Never blindly retry a mutation.',
    }) }] }; }
    finally { release(); }
  });
  add('health', {}, operations.health);
  add('reconcile_operation', { requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) }, operations.reconcile_operation);
  add('list_profiles', { gameId: id.optional() }, a => control.listProfiles(api, a.gameId));
  add('list_mods', { ...read, enabledOnly: z.boolean().optional(), nameFilter: id.optional() }, a => {
    const gameId = a.gameId ?? selectors.activeGameId(api.getState());
    return control.listMods(api, gameId, a).map(mod => ({ ...mod, installationState: typeof api.getState().persistent?.mods?.[gameId]?.[mod.id]?.state === 'string'
      ? api.getState().persistent.mods[gameId][mod.id].state : 'unknown', installed: api.getState().persistent?.mods?.[gameId]?.[mod.id]?.state === 'installed' }));
  });
  add('list_downloads', { ...read, states: z.array(id).max(10).default(['finished', 'started', 'paused', 'failed', 'init', 'finalizing']) }, a => listDownloads(api, selectors, a, catalog));
  add('list_mod_rules', { gameId: id.optional(), modId: id }, a => control.listModRules(api, a.modId, a.gameId));
  add('find_mod_dependents', { gameId: id.optional(), modId: id }, a => control.findModDependents(api, a.modId, a.gameId));
  add('list_file_conflicts', { ...read, nameFilter: id.optional() }, a => conflicts(api, selectors, a));
  add('list_known_mod_conflicts', { gameId: id.optional() }, a => control.listKnownModConflicts(api, a.gameId));
  add('list_unsolved_conflicts', {}, () => control.listUnsolvedConflicts(api));
  add('list_dialogs', {}, () => dialogs(api));
  add('list_external_changes', {}, () => externalChanges(api));
  add('install_download', { ...write, ...pins, downloadId: id }, operations.install_download, true);
  add('set_mods_enabled', { ...write, modIds: z.array(id).min(1).max(100), enabled: z.boolean() }, operations.set_mods_enabled, true);
  add('deploy_mods', write, operations.deploy_mods, true);
  add('download_nexus', { ...write, ...pins, nexusModId: z.number().int().positive(), nexusFileId: z.number().int().positive(), reuseOnly: z.boolean().default(false) }, operations.download_nexus, true);
}
function start(api, port = 3701, options = {}) {
  const host = localhostHostValidation(), origin = localhostOriginValidation();
  const listener = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (!host(req, res) || !origin(req, res)) return;
    // Shell/stdio clients never have an Origin. Reject browser-origin requests,
    // including localhost pages, rather than exposing writes to web applications.
    if (req.headers.origin) return res.writeHead(403).end();
    const release = ingress.acquire('request');
    if (!release) return res.writeHead(503, { Connection: 'close' }).end();
    const abort = new AbortController(); let server, timer;
    const closed = () => { abort.abort(); release(); };
    res.once('close', closed);
    timer = setTimeout(() => { abort.abort(); if (!res.headersSent) res.writeHead(408, { Connection: 'close' }).end(); else res.destroy(); }, options.bodyTimeoutMs ?? ingress.LIMITS.bodyTimeoutMs);
    try {
      let token;
      token = await ingress.abortable((options.tokenProvider || credential.readToken)(), abort.signal);
      if (!credential.authorized(req.headers.authorization, token)) return await ingress.rejectRequest(req, res, 401, abort.signal);
      if (abort.signal.aborted) return;
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return await ingress.rejectRequest(req, res, 405, abort.signal); }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return await ingress.rejectRequest(req, res, 415, abort.signal);
      if (Number(req.headers['content-length']) > ingress.LIMITS.bytes) return await ingress.rejectRequest(req, res, 413, abort.signal);
      const parsed = await ingress.body(req, abort.signal);
      clearTimeout(timer); // This bounds ingress, not the lifetime of Vortex work.
      if (abort.signal.aborted) return;
      server = new McpServer({ name: 'vortex-agent', version: '1.0.4' });
      register(server, api, { credentials: [token] });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.once('close', () => { void server.close().catch(() => {}); });
      await server.connect(transport); await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) await ingress.rejectRequest(req, res, error.status || (server ? 500 : 401), abort.signal);
      else if (!res.destroyed) res.end();
    } finally { clearTimeout(timer); release(); res.off('close', closed); }
  });
  listener.on('error', () => log('error', '[vortex-agent] bind failed; verify port 3701 ownership, do not assume an existing server is this extension'));
  listener.listen(port, '127.0.0.1');
  return listener;
}
module.exports = { register, start };
