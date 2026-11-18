const sessionId = { type: 'string', minLength: 1, maxLength: 128 }
const settings = {
  type: 'object',
  additionalProperties: false,
  properties: {
    execution: { enum: ['inherit', 'read-only', 'workspace-write', 'full-access'] },
    approval: { enum: ['inherit', 'untrusted', 'on-request', 'never'] },
    workMode: { enum: ['inherit', 'default', 'plan'] },
    effort: { type: 'string', minLength: 1, maxLength: 32 },
    networkAccess: { type: 'boolean' },
  },
}
const expectedRevision = { type: 'integer', minimum: 0 }
function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } }
}
export const codexAgentTools = [
  tool(
    'codex_capabilities',
    'Read which CordisX supplemental Codex operations are available. Does not create or change a chat.',
    {},
  ),
  tool(
    'codex_chat_settings',
    'Read saved and observed execution settings for a Codex chat. Omit sessionId for the calling chat; no caller means a target is required. Missing session never means global settings.',
    { sessionId },
  ),
  tool(
    'codex_chat_settings_set',
    'Save the user-requested execution, approval, reasoning effort, work mode or network settings for a Codex chat. Read codex_chat_settings first and pass its revision (0 for no record). Omit sessionId for the calling chat. Changes apply on the next turn; saved is not confirmed applied. null clears the override. Channel caller permissions remain enforced; do not approve for a user.',
    { sessionId, settings: { anyOf: [settings, { type: 'null' }] }, expectedRevision },
    ['settings', 'expectedRevision'],
  ),
  tool(
    'codex_chat_defaults',
    'Read creation defaults of the selected CordisX profile, independently of Channel. Does not modify existing chats.',
    {},
  ),
  tool(
    'codex_chat_defaults_set',
    'Set profile creation defaults only when the user explicitly requests it. Read codex_chat_defaults first and pass its revision. Replaces the defaults; existing chats are unchanged. Channel-originated tasks cannot change global defaults.',
    { settings, expectedRevision },
    ['settings', 'expectedRevision'],
  ),
  tool(
    'model_services_read',
    'Read shared CordisX model-service declarations and their revision. Reports credential presence and header names, never secret values. Used by Codex and Claude.',
    {},
  ),
  tool(
    'model_services_save',
    'Replace shared CordisX model-service declarations only on the user request. Read model_services_read and preserve unrelated services; pass its exact revision. Credentials are write-only. Changes apply after app restart. Channel-originated tasks cannot edit these shared settings.',
    {
      expectedRevision: { type: 'string', minLength: 1, maxLength: 128 },
      services: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 96 },
            displayName: { type: 'string', minLength: 1, maxLength: 200 },
            baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
            protocols: { type: 'array', items: { enum: ['openai-responses', 'anthropic-messages'] } },
            codexModels: { type: 'array', items: { type: 'string' } },
            claudeModels: { type: 'array', items: { type: 'string' } },
            enabled: { type: 'boolean' },
            apiKey: { type: 'string', minLength: 1, maxLength: 16384 },
            runtimeOptions: { anyOf: [{ type: 'object' }, { type: 'null' }] },
            httpHeadersPatch: {
              type: 'object',
              additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          required: ['id', 'displayName', 'baseUrl', 'protocols', 'codexModels', 'claudeModels', 'enabled'],
        },
      },
    },
    ['expectedRevision', 'services'],
  ),
]
const operations = {
  codex_capabilities: 'capabilities',
  codex_chat_settings: 'execution:execution-settings',
  codex_chat_settings_set: 'execution:execution-settings-set',
  codex_chat_defaults: 'execution:execution-defaults',
  codex_chat_defaults_set: 'execution:execution-defaults-set',
  model_services_read: 'model-services:read',
  model_services_save: 'model-services:save',
}
export const codexAgentOperation = name => Object.hasOwn(operations, name) ? operations[name] : undefined
export const codexAgentInstructions =
  'Use native Codex tools for ordinary chat creation, sending, reading and project organization. Use CordisX supplemental tools for provider-aware creation/selection, execution settings and shared model services. Prefer codex_chat_settings over channel_task_settings for an ordinary Codex chat. Missing sessionId means the calling chat, never global defaults. Read revisions before writes. Channel source permissions also apply to generic tools. Saved settings take effect on the next turn and need native observation before being described as applied.'
