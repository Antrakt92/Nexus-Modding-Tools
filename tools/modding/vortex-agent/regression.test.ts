// Copy into isolated upstream/src and run vitest. Expected to FAIL upstream:
// it exercises the real action call and real HTTP tools/list, not source matching.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
vi.mock('@nexusmods/vortex-api', () => ({
  actions: { setModsEnabled: vi.fn(async () => undefined) },
  selectors: { activeProfileId: () => 'p', activeGameId: () => 'cyberpunk2077' },
  util: {}, fs: {}, log: vi.fn(),
}));
import { actions } from '@nexusmods/vortex-api';
import { setModsEnabled } from './vortexControl';
import { startMcpServer } from './mcpServer';
const adapted = process.env.ADAPTED_REGRESSION === '1';
const localRequire = createRequire(import.meta.url);
const modelRoot = fileURLToPath(new URL('../../tests/', import.meta.url));
const modelDir = path.join(modelRoot, 'regression-paths');
mkdirSync(modelDir, { recursive: true });
const selectors = { activeProfileId: () => 'p', activeGameId: () => 'cyberpunk2077',
  installPathForGame: () => modelDir, downloadPathForGame: () => modelDir };
function adaptedServer(api: any): http.Server {
  let listener: http.Server;
  const mockedHttp = { ...http, createServer: (fn: any) => {
    listener = http.createServer(fn); const listen = listener.listen.bind(listener);
    listener.listen = (() => listen(0, '127.0.0.1')) as any; return listener;
  } };
  const module = { exports: {} as any };
  const artifact = readFileSync(fileURLToPath(new URL('../adapted-dist/index.js', import.meta.url)), 'utf8');
  const wrapped = vm.runInThisContext('(function(require,module,exports,__dirname,__filename){' + artifact + '\n})');
  wrapped((id: string) => id === '@nexusmods/vortex-api' ? { actions, selectors, log: () => {}, util: {}, fs: {} }
    : ['http', 'node:http'].includes(id) ? mockedHttp : localRequire(id), module, module.exports, path.dirname(fileURLToPath(new URL('../adapted-dist/index.js', import.meta.url))), fileURLToPath(new URL('../adapted-dist/index.js', import.meta.url)));
  module.exports.start(api, 0, { tokenProvider: async () => '7'.repeat(64) });
  return listener!;
}
describe('requested upstream safety regressions', () => {
  afterEach(() => vi.clearAllMocks());
  it('enable must explicitly disable automatic deployment', async () => {
    const state = { persistent: { profiles: { p: { gameId: 'cyberpunk2077', modState: {} as any } }, mods: { cyberpunk2077: { m: { state: 'installed' } } } },
      settings: { gameMode: { discovered: { cyberpunk2077: { path: modelDir } } } } };
    const api = { getState: () => state, store: { getState: () => state } } as any;
    // Published API types use Bluebird; this test's async stand-in is awaited
    // identically and does not attempt to model Bluebird-specific methods.
    vi.mocked(actions.setModsEnabled).mockImplementation((async () => { state.persistent.profiles.p.modState.m = { enabled: true }; }) as any);
    if (adapted) {
      const { createOperations, identity } = localRequire('./guard.cjs');
      await createOperations(api, actions, selectors, { stopped: () => {}, receipts: path.join(modelRoot, 'regression-receipts') }).set_mods_enabled({
        gameId: 'cyberpunk2077', profileId: 'p', gamePath: modelDir, stagingPath: modelDir, downloadPath: modelDir,
        filesystemIds: { gamePath: identity(modelDir), stagingPath: identity(modelDir), downloadPath: identity(modelDir) },
        requestId: crypto.randomUUID(), modIds: ['m'], enabled: true });
    } else await setModsEnabled(api, ['m'], true, 'p');
    expect(actions.setModsEnabled).toHaveBeenCalledWith(api, 'p', ['m'], true,
      { allowAutoDeploy: false, reason: 'user_manual', installed: true });
  });
  it('read tool list must not expose mutating Nexus update refresh', async () => {
    const api = { getState: () => ({}), store: { getState: () => ({}) } } as any;
    const server = adapted ? adaptedServer(api) : startMcpServer(api);
    try {
      await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + '7'.repeat(64) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const text = await response.text();
      expect(response.status).toBe(200);
      const payload = JSON.parse(text.startsWith('event:') ? text.split('data: ')[1].trim() : text);
      expect(payload.result.tools.some((tool: any) => tool.name === 'check_nexus_mod_updates')).toBe(false);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
