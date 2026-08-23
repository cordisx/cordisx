import type { ProviderFleet } from '../providers/fleet.js'

export const PROVIDER_BINDING = '__cordisxProviderRequestV1'
export const PROVIDER_RECEIVER = '__cordisxProviderReceiveV1'
export const MAX_PROVIDER_REQUEST_BYTES = 128 * 1024
export const MAX_PROVIDER_REQUESTS = 8

export type ProviderRpcOperation =
  | 'status'
  | 'models.list'
  | 'tasks.list'
  | 'tasks.read'
  | 'tasks.create'
  | 'tasks.control'
  | 'turns.submit'
  | 'turns.control'

export interface ProviderBindingRequest {
  readonly requestId: string
  readonly token: string
  readonly operation: ProviderRpcOperation
  readonly input: unknown
}

const OPERATIONS: readonly ProviderRpcOperation[] = [
  'status', 'models.list', 'tasks.list', 'tasks.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control',
]

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = object(value, label)
  const unknown = Object.keys(result).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
  return result
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

function providerIds(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 128)) {
    throw new Error('providerIds is invalid')
  }
  if (new Set(value).size !== value.length) throw new Error('providerIds contains duplicates')
}

function sessionRef(value: unknown): void {
  const ref = exact(value, ['providerId', 'remoteSessionId'], 'session')
  text(ref.providerId, 'session.providerId', 128)
  text(ref.remoteSessionId, 'session.remoteSessionId', 512)
}

function modelRef(value: unknown): void {
  const ref = exact(value, ['providerId', 'modelId'], 'model')
  text(ref.providerId, 'model.providerId', 128)
  text(ref.modelId, 'model.modelId', 512)
}

function validateInput(operation: ProviderRpcOperation, value: unknown): void {
  if (operation === 'status') {
    exact(value, [], 'input')
    return
  }
  if (operation === 'models.list') {
    const input = exact(value, ['providerIds'], 'input')
    providerIds(input.providerIds)
    return
  }
  if (operation === 'tasks.list') {
    const input = exact(value, ['providerIds', 'cwd', 'searchTerm', 'cursor', 'limit'], 'input')
    providerIds(input.providerIds)
    if (input.cwd !== undefined) text(input.cwd, 'input.cwd')
    if (input.searchTerm !== undefined) text(input.searchTerm, 'input.searchTerm', 1024)
    if (input.cursor !== undefined) text(input.cursor, 'input.cursor', 512)
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 500)) throw new Error('input.limit is invalid')
    return
  }
  if (operation === 'tasks.read') {
    const input = exact(value, ['session'], 'input')
    sessionRef(input.session)
    return
  }
  if (operation === 'tasks.create') {
    const input = exact(value, ['model', 'cwd'], 'input')
    modelRef(input.model)
    text(input.cwd, 'input.cwd')
    return
  }
  if (operation === 'tasks.control') {
    const input = exact(value, ['action', 'session'], 'input')
    if (!['continue', 'fork', 'archive', 'restore', 'delete'].includes(String(input.action))) throw new Error('input.action is invalid')
    sessionRef(input.session)
    return
  }
  if (operation === 'turns.submit') {
    const input = exact(value, ['session', 'message'], 'input')
    sessionRef(input.session)
    text(input.message, 'input.message', 1_000_000)
    return
  }
  const input = exact(value, ['action', 'session', 'turnId', 'message'], 'input')
  if (input.action !== 'steer' && input.action !== 'interrupt') throw new Error('input.action is invalid')
  sessionRef(input.session)
  if (input.turnId !== undefined) text(input.turnId, 'input.turnId', 512)
  if (input.action === 'steer') text(input.message, 'input.message', 1_000_000)
  else if (input.message !== undefined) throw new Error('input.message is not valid for interrupt')
}

export function parseProviderBindingRequest(value: unknown, expectedToken: string): ProviderBindingRequest {
  const request = exact(value, ['requestId', 'token', 'operation', 'input'], 'provider request')
  const requestId = text(request.requestId, 'provider request id', 96)
  if (!/^[a-zA-Z0-9-]+$/.test(requestId)) throw new Error('provider request id is invalid')
  if (request.token !== expectedToken) throw new Error('provider request is not authorized')
  if (typeof request.operation !== 'string' || !(OPERATIONS as readonly string[]).includes(request.operation)) {
    throw new Error('provider request operation is invalid')
  }
  const operation = request.operation as ProviderRpcOperation
  validateInput(operation, request.input)
  return { requestId, token: expectedToken, operation, input: request.input }
}

/** Dispatch only public Platform operations. App-server methods and raw payloads are never accepted. */
export async function handleProviderBindingRequest(fleet: ProviderFleet, request: ProviderBindingRequest): Promise<unknown> {
  switch (request.operation) {
    case 'status': return fleet.status()
    case 'models.list': return await fleet.listModels(request.input as Parameters<ProviderFleet['listModels']>[0])
    case 'tasks.list': return await fleet.listTasks(request.input as Parameters<ProviderFleet['listTasks']>[0])
    case 'tasks.read': return await fleet.readTask(request.input as Parameters<ProviderFleet['readTask']>[0])
    case 'tasks.create': return await fleet.createTask(request.input as Parameters<ProviderFleet['createTask']>[0])
    case 'tasks.control': return await fleet.controlTask(request.input as Parameters<ProviderFleet['controlTask']>[0])
    case 'turns.submit': return await fleet.submitTurn(request.input as Parameters<ProviderFleet['submitTurn']>[0])
    case 'turns.control': return await fleet.controlTurn(request.input as Parameters<ProviderFleet['controlTurn']>[0])
  }
}
