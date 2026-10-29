const requestId = {type: 'string', pattern: '^[a-zA-Z0-9_-]{8,80}$'};
const id = {type: 'string', minLength: 1, maxLength: 200};
const positive = {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER};
const strict = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
const context = strict({gameId: id, profileId: id, gamePath: id, stagingPath: id, downloadPath: id,
  filesystemIds: strict(Object.fromEntries(['gamePath', 'stagingPath', 'downloadPath'].map(key => [key, {type: 'string', pattern: '^\\d+:\\d+$'}])))});

export const RUN_PLAN_TOOL = {
  name: 'run_mod_plan',
  description: 'Validate or apply an authorized reviewed plan of pinned Nexus downloads, batched enable/disable changes and one optional final deploy. Default apply=false is offline validation. Batch up to 100 mod IDs per enable/disable step. Stable request IDs, full context pins and exact receipts are required. No installation/replacement or generic dispatch. Cancellation stops later steps; it does not undo an in-flight effect. Receipts are not disk deployment proof.',
  inputSchema: {type: 'object', required: ['plan'], additionalProperties: false, properties: {
    apply: {type: 'boolean', default: false},
    plan: strict({version: {const: 1}, context, steps: {type: 'array', maxItems: 100, items: {oneOf: [
      strict({operation: {const: 'set_mods_enabled'}, requestId, modIds: {type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id}, enabled: {type: 'boolean'}}),
      strict({operation: {const: 'download_nexus'}, requestId, nexusModId: positive, nexusFileId: positive,
        size: positive, sha256: {type: 'string', pattern: '^[a-f0-9]{64}$'}, reuseOnly: {type: 'boolean'}}),
    ]}}, deploy: {oneOf: [{type: 'null'}, strict({requestId})]}}),
  }},
  annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
};
