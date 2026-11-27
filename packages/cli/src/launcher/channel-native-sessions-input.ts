import type { AgentBridge } from './agent-bridge.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import type { ChannelMemoryModelConnection } from './channel-user-memory-model.js'
import type { ChannelNativeCliContext } from './channel-cli-context.js'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'

export interface ChannelNativeSessionsInput {
  readonly bridge: () => AgentBridge | undefined
  readonly nativeRequest: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly cwd: string
  readonly nativeVersion?: string
  readonly logicalHandoffWriteGuardReady?: () => boolean
  readonly logicalMigrationLease?: (
    source: string,
  ) => ReturnType<typeof import('./channel-logical-native-lease.js').acquireChannelLogicalNativeLease>
  readonly logicalOwnerIdentity?: () => Promise<string | undefined>
  readonly providerId?: string
  readonly model?: string
  readonly fallbackProviderId?: string
  readonly fallbackModel?: string
  readonly crossProviderForkReady?: (target: { providerId: string; model: string }) => Promise<boolean>
  readonly confirmedResumeTarget?: (threadId: string) => Promise<{ providerId: string; model: string } | undefined>
  readonly memoryConnect?: ChannelMemoryModelConnection | undefined
  readonly cli?: ChannelNativeCliContext
  readonly execution?: ChatExecutionPreferences
  readonly configuration?: import('./codex-chat-configuration.js').CodexChatConfiguration
  readonly contextObserver?: import('./native-context-observer.js').NativeContextObserver
  readonly confirmedWorkMode?: (threadId: string) => 'default' | 'plan' | undefined
  readonly models?: (operation: string, input: unknown, beforeEffect?: () => Promise<boolean>) => Promise<unknown>
  readonly sourceConfiguration?: (
    threadId: string,
  ) => Promise<import('./native-source-configuration.js').NativeSourceConfiguration | undefined>
  readonly name?: (event: import('@cordisx/channel-runtime').ChannelEventRef) => Promise<string | undefined>
  readonly sectionName?: () => string | undefined
  readonly report?: (code: string) => void
  readonly subscribeApprovals?: (listener: (event: Record<string, unknown>) => void) => () => void
  readonly subscribeContinuationEvents?: (listener: (method: string, params: unknown) => void) => () => void
  readonly respondApproval?: (input: Record<string, unknown>) => Promise<unknown>
}
