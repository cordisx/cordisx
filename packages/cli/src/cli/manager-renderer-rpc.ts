import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import {
  type ManagerRendererHandle,
  type ManagerRendererInvocation,
  ManagerRendererSessions,
} from './manager-renderer-sessions.js'

export type ManagerRendererOperation =
  | {
    readonly kind: 'manager-renderer'
    readonly action: 'open'
    readonly gateway: ManagerRendererGatewayProof
    readonly browserSessionId: string
  }
  | {
    readonly kind: 'manager-renderer'
    readonly action: 'revoke'
    readonly gateway: ManagerRendererGatewayProof
    readonly browserSessionId: string
  }
  | ({ readonly kind: 'manager-renderer'; readonly action: 'close' } & ManagerRendererInvocation)
  | (
    & {
      readonly kind: 'manager-renderer'
      readonly action: 'call'
      readonly channel: string
      readonly payload: unknown
    }
    & ManagerRendererInvocation
  )

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('MANAGER_RENDERER_INVALID')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('MANAGER_RENDERER_INVALID')
  }
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function gateway(value: unknown): ManagerRendererGatewayProof {
  const item = record(value)
  keys(item, ['pid', 'processStartedAt', 'instanceToken'])
  if (
    !Number.isSafeInteger(item.pid) || Number(item.pid) <= 0 || typeof item.processStartedAt !== 'string'
    || item.processStartedAt.length === 0 || item.processStartedAt.length > 256 || !secret(item.instanceToken)
  ) {
    throw new Error('MANAGER_RENDERER_INVALID')
  }
  return { pid: Number(item.pid), processStartedAt: item.processStartedAt, instanceToken: item.instanceToken }
}

function handle(value: unknown): ManagerRendererHandle {
  const item = record(value)
  keys(item, ['rendererId', 'ownerGeneration', 'grant'])
  if (
    !secret(item.rendererId) || !secret(item.grant) || typeof item.ownerGeneration !== 'string'
    || item.ownerGeneration.length === 0 || item.ownerGeneration.length > 256
  ) {
    throw new Error('MANAGER_RENDERER_INVALID')
  }
  return { rendererId: item.rendererId, ownerGeneration: item.ownerGeneration, grant: item.grant }
}

/** Parse only after the outer management RPC token and profile are checked. */
export function parseManagerRendererOperation(value: unknown): ManagerRendererOperation {
  const item = record(value)
  if (item.kind !== 'manager-renderer' || !secret(item.browserSessionId)) throw new Error('MANAGER_RENDERER_INVALID')
  const common = {
    kind: 'manager-renderer' as const,
    gateway: gateway(item.gateway),
    browserSessionId: item.browserSessionId,
  }
  if (item.action === 'open' || item.action === 'revoke') {
    keys(item, ['kind', 'action', 'gateway', 'browserSessionId'])
    return { ...common, action: item.action }
  }
  if (item.action === 'close') {
    keys(item, ['kind', 'action', 'gateway', 'browserSessionId', 'handle'])
    return { ...common, action: 'close', handle: handle(item.handle) }
  }
  if (item.action === 'call') {
    keys(item, ['kind', 'action', 'gateway', 'browserSessionId', 'handle', 'channel', 'payload'])
    if (typeof item.channel !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.channel)) {
      throw new Error('MANAGER_RENDERER_INVALID')
    }
    return { ...common, action: 'call', handle: handle(item.handle), channel: item.channel, payload: item.payload }
  }
  throw new Error('MANAGER_RENDERER_INVALID')
}

/** The returned handle is exclusively for the private manager-sidecar RPC. */
export async function dispatchManagerRendererOperation(
  authority: ManagerRendererSessions,
  input: unknown,
): Promise<unknown> {
  const operation = parseManagerRendererOperation(input)
  if (operation.action === 'open') {
    const result = await authority.open(operation.gateway, operation.browserSessionId)
    return result ? { status: 'ok', handle: result } : { status: 'unavailable' }
  }
  if (operation.action === 'revoke') {
    return await authority.revoke(operation.gateway, operation.browserSessionId)
      ? { status: 'ok' }
      : { status: 'unavailable' }
  }
  if (operation.action === 'close') {
    return await authority.close(operation)
      ? { status: 'ok' }
      : { status: 'unavailable' }
  }
  return await authority.call(operation, operation.channel, operation.payload)
}
