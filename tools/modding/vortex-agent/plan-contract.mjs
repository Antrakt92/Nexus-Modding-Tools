import path from 'node:path';
import serialization from './serialization.cjs';

export const CONTEXT_KEYS = ['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'];
export const ROOTS = ['gamePath', 'stagingPath', 'downloadPath'];
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
function insist(value, code) { if (!value) throw new Error(code); }
function curated(value, code) {
  try {serialization.safe(value, null, 'parameters');}
  catch {throw Error(code);}
}

export function validateContext(value) {
  insist(keys(value, CONTEXT_KEYS) && id(value.gameId) && id(value.profileId), 'INVALID_PLAN_CONTEXT');
  insist(keys(value.filesystemIds, ROOTS), 'INVALID_PLAN_CONTEXT');
  for (const key of ROOTS) {
    insist(typeof value[key] === 'string' && value[key].length <= 200 && /^[a-z]:[\\/]/i.test(value[key])
      && !/[\x00-\x1f]/.test(value[key]) && typeof value.filesystemIds[key] === 'string'
      && /^\d+:\d+$/.test(value.filesystemIds[key]), 'INVALID_PLAN_CONTEXT');
  }
  // Match the adapter's pure URI/value policy before durable local persistence.
  // This does not access native state or establish credential-overlap admission.
  curated(value, 'INVALID_PLAN_CONTEXT');
  return value;
}

export function validatePlan(input) {
  insist(keys(input, ['version', 'context', 'steps', 'deploy']) && input.version === 1, 'INVALID_PLAN');
  validateContext(input.context);
  insist(Array.isArray(input.steps) && input.steps.length <= 100, 'INVALID_PLAN_STEPS');
  const ids = new Set();
  for (const step of input.steps) {
    if (step?.operation === 'download_nexus') {
      insist(keys(step, ['operation', 'requestId', 'nexusModId', 'nexusFileId', 'size', 'sha256', 'reuseOnly'])
        && requestId(step.requestId) && ['nexusModId', 'nexusFileId', 'size'].every(k => Number.isSafeInteger(step[k]) && step[k] > 0)
        && typeof step.sha256 === 'string' && /^[a-f0-9]{64}$/.test(step.sha256) && typeof step.reuseOnly === 'boolean', 'INVALID_PLAN_STEP');
    } else {
      insist(keys(step, ['operation', 'requestId', 'modIds', 'enabled']) && step.operation === 'set_mods_enabled'
        && requestId(step.requestId) && typeof step.enabled === 'boolean' && Array.isArray(step.modIds)
        && step.modIds.length > 0 && step.modIds.length <= 100 && step.modIds.every(id)
        && new Set(step.modIds).size === step.modIds.length, 'INVALID_PLAN_STEP');
      curated({modIds: step.modIds}, 'INVALID_PLAN_STEP');
    }
    insist(!ids.has(step.requestId), 'DUPLICATE_REQUEST_ID'); ids.add(step.requestId);
  }
  if (input.deploy !== null) {
    insist(keys(input.deploy, ['requestId']) && requestId(input.deploy.requestId), 'INVALID_DEPLOY_STEP');
    insist(!ids.has(input.deploy.requestId), 'DUPLICATE_REQUEST_ID');
  }
  insist(input.steps.length > 0 || input.deploy !== null, 'EMPTY_PLAN');
  // Detach the queue from caller changes while asynchronous checks are pending.
  return JSON.parse(JSON.stringify(input));
}

export function planQueue(input) {
  const plan = validatePlan(input);
  const queue = plan.steps.map(({operation, ...parameters}) => ({operation, args: {...plan.context, ...parameters}}));
  if (plan.deploy !== null) queue.push({operation: 'deploy_mods', args: {...plan.context, requestId: plan.deploy.requestId}});
  return queue;
}
