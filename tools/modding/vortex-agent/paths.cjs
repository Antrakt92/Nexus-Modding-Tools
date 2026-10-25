'use strict';
const path = require('node:path');

function absolute(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)
      || !path.isAbsolute(value)
      || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value)))
    throw new Error(name + '_ABSOLUTE_PATH_REQUIRED');
  return path.resolve(value);
}

function resolvePaths({ env = process.env, sourceDir = __dirname,
  compiledWorkspace = typeof __NEXUS_WORKSPACE__ === 'undefined' ? undefined : __NEXUS_WORKSPACE__ } = {}) {
  const sourceWorkspace = path.resolve(sourceDir, '../../..');
  const workspace = absolute(env.NEXUS_WORKSPACE !== undefined ? env.NEXUS_WORKSPACE
    : compiledWorkspace !== undefined ? compiledWorkspace : sourceWorkspace, 'NEXUS_WORKSPACE');
  const contextRoot = absolute(env.NEXUS_CONTEXT_ROOT !== undefined ? env.NEXUS_CONTEXT_ROOT
    : path.join(workspace, 'local-state/upstream-sources'), 'NEXUS_CONTEXT_ROOT');
  const build = path.join(workspace, 'local-state/vortex-agent-build');
  return Object.freeze({
    workspace, sourceWorkspace, contextRoot, build,
    cache: path.join(contextRoot, 'vortex-mcp'),
    receipts: path.join(build, 'receipts'), credentials: path.join(build, 'credentials'),
    state: path.join(workspace, 'local-state/agent-tooling-setup'),
  });
}

module.exports = { absolute, resolvePaths, ...resolvePaths() };
