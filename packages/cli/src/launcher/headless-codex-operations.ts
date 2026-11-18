import { callerThreadId } from './agent-bridge-context.js'
import type { ChannelConversationTools } from './channel-conversation-tools.js'
import type { ChatExecutionAuthority } from './chat-execution-operation.js'
import { createCodexChatSettings } from './codex-chat-settings.js'
import { createCodexModelServices } from './codex-model-services.js'
import { dispatchCodexSettings } from './codex-settings-dispatch.js'

/** Reuses the running headless backend and settings authorities; never opens another app-server. */
export function createHeadlessCodexOperations(input: {
  readonly configPath: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly native?: ChatExecutionAuthority
  readonly models?: (operation: string, input: unknown, beforeEffect?: () => Promise<boolean>) => Promise<unknown>
  readonly channelTools?: () => ChannelConversationTools | undefined
  readonly preparing?: (metadata: unknown) => boolean
  readonly closed: () => boolean
}) {
  const hasChannelContext = (metadata: unknown) =>
    !!metadata && typeof metadata === 'object'
    && (metadata as Record<string, unknown>)['cordisx/channelContext'] !== undefined
  const guard = async (operation: string, args: Record<string, unknown>, metadata?: unknown) => {
    const tools = input.channelTools?.()
    if (!tools && hasChannelContext(metadata)) return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
    return tools?.executionGuard(operation, args, metadata)
  }
  const authority = {
    ...(input.native ? { execution: createCodexChatSettings({ native: input.native, guard }) } : {}),
    modelServices: createCodexModelServices({
      configPath: input.configPath,
      ...(input.environment ? { environment: input.environment } : {}),
      guard,
    }),
  }
  return async (operation: string, args: unknown, metadata?: unknown): Promise<unknown> => {
    if (input.closed()) return { status: 'unavailable', code: 'CODEX_RUNTIME_UNAVAILABLE' }
    if (input.preparing?.(metadata)) return { status: 'rejected', reason: 'preparation-read-only' }
    const supplemental = await dispatchCodexSettings(authority, operation, args, metadata)
    if (supplemental !== undefined) return supplemental
    if (operation === 'capabilities') {
      return {
        status: 'ok',
        capabilities: {
          providerCatalog: input.models !== undefined,
          providerSelection: input.models !== undefined,
          providerCreation: false,
          executionSettings: input.native !== undefined,
          modelServices: true,
          projectSwitch: false,
          fastSettings: false,
        },
      }
    }
    if (operation === 'list' && input.models) {
      const result = await input.models('list', {}) as { status?: string }
      return { status: 'ok', ...result }
    }
    if (operation === 'select' && input.models) {
      const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
      const selection: Record<string, unknown> = {
        ...raw,
        threadId: raw.threadId === undefined ? callerThreadId(metadata) : raw.threadId,
      }
      if (
        Object.keys(selection).some(key => !['threadId', 'providerId', 'model'].includes(key))
        || !['threadId', 'providerId', 'model'].every(key =>
          typeof selection[key] === 'string'
          && String(selection[key]).length > 0 && String(selection[key]).length <= 512
          && !/[\0\r\n]/u.test(String(selection[key]))
        )
      ) {
        return { status: 'rejected', reason: 'invalid-selection' }
      }
      const tools = input.channelTools?.()
      if (!tools && hasChannelContext(metadata)) return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
      const channel = await tools?.call('task-model-select', selection, metadata)
      if (channel !== undefined) return channel
      return input.models('select', selection)
    }
    return { status: 'unavailable', code: 'CODEX_OPERATION_UNAVAILABLE' }
  }
}
