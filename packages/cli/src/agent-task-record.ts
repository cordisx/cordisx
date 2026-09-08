import type {
  AgentTaskCreateRequest,
  AgentTaskCreateResult,
  AgentTaskResolvedContext,
} from '@cordisx/protocol/agent-task/v1'

/** Host-only correlation in the existing native Session owner store. */
export interface AgentTaskRecord {
  readonly operationId: string
  readonly fingerprint: string
  readonly sessionId: string
  readonly messageId: string
  readonly context: AgentTaskResolvedContext
  readonly bindingPolicy?: 'none' | 'required'
  readonly phase:
    | 'intent'
    | 'creating'
    | 'created'
    | 'binding'
    | 'approval-installing'
    | 'approval-install-failed'
    | 'submitting'
    | 'finished'
  readonly result?: AgentTaskCreateResult
}

export function canonicalTaskJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || seen.has(item)) throw new Error('Task input must be JSON')
    seen.add(item)
    try {
      if (Array.isArray(item)) return item.map(normalize)
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error('Task input must be plain JSON')
      }
      return Object.fromEntries(
        Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key])]),
      )
    } finally {
      seen.delete(item)
    }
  }
  return JSON.stringify(normalize(value))
}

export function validTaskRequest(value: AgentTaskCreateRequest): boolean {
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
  const keys = (value: object, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
  return !!value && keys(value, ['operationId', 'definition', 'context', 'text', 'options', 'tool'])
    && id(value.operationId) && !!value.definition && id(value.definition.agentId) && id(value.definition.revision)
    && keys(value.definition, ['agentId', 'revision'])
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 500_000
    && !!value.tool && id(value.tool.commandId) && value.tool.scope !== undefined
    && keys(value.tool, ['commandId', 'scope'])
    && (value.options === undefined
      || (!!value.options && keys(value.options, ['provider', 'model', 'reasoningEffort', 'maxTokens'])
        && [value.options.provider, value.options.model, value.options.reasoningEffort].every(item =>
          item === undefined || id(item)
        )
        && (value.options.maxTokens === undefined
          || (Number.isSafeInteger(value.options.maxTokens) && value.options.maxTokens > 0))))
}

export class AgentTaskContextMismatch extends Error {
  constructor(readonly sessionId: string) {
    super('Native task execution directory did not match the resolved context')
  }
}

export class AgentTaskApprovalCleanupError extends Error {
  constructor() {
    super('Task approval cleanup could not be established')
  }
}
