import type { CordisXAgentHistoryQuery, CordisXAgentHistoryTailQuery } from '../agent-contracts.js'
import type { AgentHistoryCaller, CodexAgentHistoryHost } from './agent-history.js'

export const AGENT_HISTORY_BINDING = '__cordisxAgentHistoryRequestV1'
export const AGENT_HISTORY_RECEIVER = '__cordisxAgentHistoryReceiveV1'
export const MAX_AGENT_HISTORY_REQUEST_BYTES = 8 * 1024
export const MAX_AGENT_HISTORY_REQUESTS = 4

export interface AgentHistoryBindingRequest {
  readonly requestId: string
  readonly operation: 'status' | 'query' | 'tail'
  readonly caller?: AgentHistoryCaller
  readonly input: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Agent history request')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some(key => !keys.has(key))) throw new Error('invalid Agent history request fields')
}

function optionalString(value: unknown, max: number): string | undefined {
  return value === undefined
    ? undefined
    : typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined
}

function parseInput(operation: AgentHistoryBindingRequest['operation'], value: unknown): Record<string, unknown> {
  const input = object(value)
  exactKeys(
    input,
    operation === 'tail'
      ? ['sessionId', 'tailCursor', 'limit', 'payloadPolicy']
      : operation === 'query'
      ? ['sessionId', 'cursor', 'limit', 'payloadPolicy']
      : [],
  )
  if (operation === 'status') return {}
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.length > 128) {
    throw new Error('invalid Agent history session')
  }
  if (
    operation === 'tail'
    && (typeof input.tailCursor !== 'string' || input.tailCursor.length < 16 || input.tailCursor.length > 2048)
  ) {
    throw new Error('invalid Agent history tail cursor')
  }
  if (
    operation === 'query' && input.cursor !== undefined
    && (typeof input.cursor !== 'string' || input.cursor.length < 16 || input.cursor.length > 2048)
  ) {
    throw new Error('invalid Agent history cursor')
  }
  if (
    input.limit !== undefined
    && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 500)
  ) {
    throw new Error('invalid Agent history limit')
  }
  if (
    input.payloadPolicy !== undefined && !['referenced', 'summarized', 'inline'].includes(String(input.payloadPolicy))
  ) {
    throw new Error('invalid Agent history payload policy')
  }
  return input
}

/** Parse one token-bound renderer request without accepting path or profile input. */
export function parseAgentHistoryBindingRequest(value: unknown, token: string): AgentHistoryBindingRequest {
  const request = object(value)
  exactKeys(request, ['requestId', 'token', 'operation', 'caller', 'input'])
  if (request.token !== token) throw new Error('invalid Agent history bridge token')
  if (typeof request.requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(request.requestId)) {
    throw new Error('invalid Agent history request id')
  }
  if (!['status', 'query', 'tail'].includes(String(request.operation))) {
    throw new Error('invalid Agent history operation')
  }
  const operation = request.operation as AgentHistoryBindingRequest['operation']
  const input = parseInput(operation, request.input)
  if (operation === 'status') return { requestId: request.requestId, operation, input }
  const caller = object(request.caller)
  exactKeys(caller, ['ownerKey', 'generation'])
  const ownerKey = optionalString(caller.ownerKey, 4096)
  const generation = optionalString(caller.generation, 512)
  if (ownerKey === undefined || generation === undefined) throw new Error('invalid Agent history caller binding')
  return { requestId: request.requestId, operation, caller: { ownerKey, generation }, input }
}

export async function handleAgentHistoryBindingRequest(
  host: CodexAgentHistoryHost,
  request: AgentHistoryBindingRequest,
): Promise<unknown> {
  if (request.operation === 'status') return await host.status()
  if (request.caller === undefined) throw new Error('Agent history caller is missing')
  if (request.operation === 'query') {
    return await host.query(request.input as unknown as CordisXAgentHistoryQuery, request.caller)
  }
  return await host.tail(request.input as unknown as CordisXAgentHistoryTailQuery, request.caller)
}
