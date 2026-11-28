import type { CordisXPersistedPermissionPolicyRecord } from './permission-persistence.js'

/** A service-projected decision; a missing receipt is an unconfirmed outcome. */
export interface PermissionDecisionHistoryItem {
  readonly record: CordisXPersistedPermissionPolicyRecord
  readonly decision: CordisXPersistedPermissionPolicyRecord['policy'] | 'allow-once' | 'deny-once'
  readonly client: 'web' | 'codex'
  readonly requestedAt: string
  readonly committedAt?: string
}

/** A reviewed lifecycle decision attributed to its authenticated client transport. */
export interface PluginAuthorizationHistoryItem {
  readonly operation: 'install' | 'update' | 'enable' | 'runtime'
  readonly client: 'web' | 'codex'
  readonly requestedAt: string
  readonly committedAt?: string
  readonly decisions: readonly {
    readonly capability: string
    readonly decision: PermissionDecisionHistoryItem['decision']
  }[]
}
