/** During preparation, only read-only Channel operations and the fenced ready signal are admitted. */
const READ_ONLY = new Set([
  'thread-forward-receipt',
  'connections',
  'conversations',
  'bind-status',
  'local-bindings',
  'history',
  'remote-history',
  'thread-history',
  'message-search',
  'message-get',
  'message-capabilities',
  'message-operation-receipt',
  'pin-list',
  'read-users',
  'reaction-list',
  'listen',
  'receipt',
  'policy',
  'execution-defaults',
  'execution-settings',
  'docs',
  'help',
  'model-list',
  'task-settings',
  'task-config',
  'task-requests',
  'continuation-policy',
  'continuation-live-policy',
  'continuation-defaults',
  'continuation-checkpoint',
  'continuation-history',
  'continuation-takeover-ready',
])

export function channelOperationDuringPreparation(operation: string): boolean {
  return READ_ONLY.has(operation)
}
