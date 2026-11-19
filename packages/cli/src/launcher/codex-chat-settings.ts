import { callerThreadId } from './agent-bridge-context.js'
import { type ChatExecutionAuthority, chatExecutionOperation } from './chat-execution-operation.js'

const operations = ['execution-defaults', 'execution-defaults-set', 'execution-settings', 'execution-settings-set']
export type CodexChatSettingsGuard = (
  operation: string,
  args: Record<string, unknown>,
  metadata?: unknown,
) => Promise<unknown | undefined>
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Shared settings authority for MCP and CLI; only Channel supplies Channel policy. */
export function createCodexChatSettings(input: {
  readonly native: ChatExecutionAuthority
  readonly guard?: CodexChatSettingsGuard
}) {
  return async (operation: string, value: unknown, metadata?: unknown): Promise<unknown> => {
    try {
      const args = object(value)
      if (!args || !operations.includes(operation)) return { status: 'rejected', code: 'INVALID_REQUEST' }
      const defaults = operation.includes('defaults')
      const sessionId = defaults ? undefined : args.sessionId === undefined ? callerThreadId(metadata) : args.sessionId
      if (!defaults && sessionId === undefined) return { status: 'rejected', code: 'SESSION_REQUIRED' }
      const resolved = { ...args, ...(defaults ? {} : { sessionId }) }
      const guarded = await input.guard?.(operation, resolved, metadata)
      if (guarded !== undefined) return guarded
      const result = await chatExecutionOperation(input.native, operation, resolved)
      return { ...result, scope: defaults ? 'creation-defaults' : 'chat', ...(defaults ? {} : { sessionId }) }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
        ? error.message
        : 'EXECUTION_SETTINGS_UNAVAILABLE'
      return { status: 'rejected', code }
    }
  }
}
