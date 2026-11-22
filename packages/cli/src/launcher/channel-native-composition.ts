import path from 'node:path'
import type { AgentBridge } from './agent-bridge.js'
import type { NativeSubmissionCatalogOptions } from './native-submission-composition.js'
import type { startNativeSubmissionControlServer } from './native-submission-control-server.js'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'
import { ChannelNativeSessions } from './channel-native-sessions.js'
import { configuredChannelCliContext } from './channel-cli-context.js'
import { acquireChannelLogicalNativeLease } from './channel-logical-native-lease.js'

/** Compose the Channel native seam from the same authority as ordinary model tools. */
export function createChannelNativeSession(input: {
  options: NativeSubmissionCatalogOptions
  codexHome: string
  nativeVersion?: string
  selection: (
    threadId: string,
  ) => Promise<import('./native-source-configuration.js').NativeSourceConfiguration | undefined>
  bridge: () => AgentBridge | undefined
  control: Awaited<ReturnType<typeof startNativeSubmissionControlServer>>
  execution: ChatExecutionPreferences | undefined
  configuration?: import('./codex-chat-configuration.js').CodexChatConfiguration | undefined
  models: (
    operation: string,
    value: unknown,
    metadata?: unknown,
    beforeEffect?: () => Promise<boolean>,
  ) => Promise<unknown>
}) {
  const { options, bridge, control, execution, models } = input
  return new ChannelNativeSessions({
    bridge,
    models: (operation, value, beforeEffect) => models(operation, value, undefined, beforeEffect),
    sourceConfiguration: input.selection,
    nativeRequest: (method, params) => control.nativeRequest(method, params),
    logicalOwnerIdentity: () => control.nativeOwnerIdentity(),
    logicalHandoffWriteGuardReady: () => control.logicalHandoffReady(),
    ...(options.logicalOwner
      ? { logicalMigrationLease: (source: string) => acquireChannelLogicalNativeLease(control, source) }
      : {}),
    ...(input.nativeVersion ? { nativeVersion: input.nativeVersion } : {}),
    ...(execution ? { execution } : {}),
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(options.contextObserver ? { contextObserver: options.contextObserver } : {}),
    ...(options.channelName ? { name: options.channelName } : {}),
    ...(options.channelSectionName ? { sectionName: options.channelSectionName } : {}),
    subscribeApprovals: listener => control.subscribeNativeApprovals(listener),
    subscribeContinuationEvents: listener => control.subscribeContinuationEvents(listener),
    respondApproval: value => control.respondNativeApproval(value),
    cwd: options.managedCatalog?.homeDir ?? path.dirname(input.codexHome),
    ...(options.managedCatalog
      ? { cli: configuredChannelCliContext(options.managedCatalog.homeDir, options.managedCatalog.profileId) }
      : {}),
    ...(options.defaultProviderId ? { providerId: options.defaultProviderId } : {}),
    ...(options.defaultModelId ? { model: options.defaultModelId } : {}),
  })
}
