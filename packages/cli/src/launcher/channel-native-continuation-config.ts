import { isDeepStrictEqual } from 'node:util'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'
import type { NativeSourceConfiguration } from './native-source-configuration.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ChannelTaskPatch } from './channel-task-config.js'
import { continuationConfiguration } from './channel-continuation-config.js'

type NativeInput = {
  readonly nativeRequest: (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly execution?: ChatExecutionPreferences
  readonly sourceConfiguration?: (threadId: string) => Promise<NativeSourceConfiguration | undefined>
  readonly confirmedWorkMode?: (threadId: string) => 'default' | 'plan' | undefined
  readonly configuration?: Pick<
    import('./codex-chat-configuration.js').CodexChatConfiguration,
    'hasHeadlessProject' | 'verifiedProjectSandbox'
  >
}
type Sessions = {
  idle(threadId: string, requireObservedIdle?: boolean): Promise<boolean>
  taskSelection(threadId: string): Promise<ChannelTaskPatch>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export async function readChannelContinuationConfiguration(
  input: NativeInput,
  sessions: Sessions,
  threadId: string,
  allowActive = false,
) {
  if (!allowActive && !await sessions.idle(threadId)) return undefined
  await input.execution?.settled()
  const live = await input.sourceConfiguration?.(threadId).catch(() => undefined)
  const record = input.execution?.read('local', threadId)
  if (!live && record?.modelSelection?.status === 'unknown') return undefined
  if (!record || record.application !== 'applied' || !input.execution?.observationConfirmed(threadId)) return undefined
  const confirmedMode = input.confirmedWorkMode?.(threadId)
  if (input.confirmedWorkMode && confirmedMode === undefined) return undefined
  const ordinary = continuationConfiguration(record.effective, live, confirmedMode)
  // Headless project preparation currently clears named native profiles. Never
  // create a continuation whose later project resume could discard one.
  if (ordinary?.permissions && input.configuration?.hasHeadlessProject(threadId)) return undefined
  if (ordinary || !record.effective || !input.configuration) return ordinary
  if (!await input.configuration.verifiedProjectSandbox(threadId, record.effective)) return undefined
  await input.execution.settled()
  if (
    !input.execution.observationConfirmed(threadId)
    || !isDeepStrictEqual(input.execution.read('local', threadId), record)
  ) return undefined
  return continuationConfiguration(record.effective, live, confirmedMode, true)
}

/** Reload only the same idle source and verify its provider and work mode. */
export async function restoreChannelLogicalSource(
  input: NativeInput,
  sessions: Sessions,
  threadId: string,
  selection: ChannelTaskPatch,
  fence: ChannelNativeSourceFence,
): Promise<boolean> {
  if (!selection.providerId || !selection.model || !await sessions.idle(threadId)) return false
  if (!isDeepStrictEqual(await sessions.taskSelection(threadId), selection)) return false
  const resumed = object(
    await input.nativeRequest(
      'thread/resume',
      fence.allowOwned('thread/resume', threadId, {
        threadId,
        excludeTurns: true,
        modelProvider: selection.providerId,
        model: selection.model,
        ...(selection.effort && selection.effort !== 'inherit'
          ? { config: { model_reasoning_effort: selection.effort } }
          : {}),
        ...(selection.fast === undefined ? {} : { serviceTier: selection.fast ? 'priority' : null }),
      }),
    ),
  )
  return object(resumed.thread).id === threadId && resumed.modelProvider === selection.providerId
    && resumed.model === selection.model && await sessions.idle(threadId, true)
    && (!input.confirmedWorkMode || input.confirmedWorkMode(threadId) !== undefined)
    && isDeepStrictEqual(await sessions.taskSelection(threadId), selection)
}
