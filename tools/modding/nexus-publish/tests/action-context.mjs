import path from 'node:path';
import { fileURLToPath } from 'node:url';

function absolute(value) {
  if (!path.isAbsolute(value)) throw new Error('Upstream context must be an absolute path');
  return path.resolve(value);
}
export const workspace = absolute(process.env.NEXUS_WORKSPACE || fileURLToPath(new URL('../../../../', import.meta.url)));
export const context = absolute(process.env.NEXUS_CONTEXT_ROOT || path.join(workspace, 'local-state/upstream-sources'));
export const actionRoot = absolute(process.env.NEXUS_UPLOAD_ACTION_ROOT || path.join(context, 'nexus-upload-action'));
