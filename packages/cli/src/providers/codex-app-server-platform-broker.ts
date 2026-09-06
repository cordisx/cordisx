import { createHash, randomUUID } from 'node:crypto'
import type {
  PlatformProviderBrokerBindingV1,
  PlatformProviderBrokerPolicyV1,
  PlatformProviderJsonValue,
  PlatformProviderOperationV1,
} from '@cordisx/protocol/platform-provider/v1'
import type {
  HostPlatformProviderBrokerAuthorityV1,
  HostPlatformProviderBrokerCatalogV1,
  HostPlatformProviderBrokerTransportV1,
} from '../launcher/platform-provider-service.js'
import type { PlatformProviderWorkspaceAuthority } from '../launcher/platform-provider-authority.js'
import type { CodexAppServerRpc } from './codex-app-server.js'

const VALUE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const FORBIDDEN =
  /secret|password|token|credential|path|directory|datadir|executable|process|env|transport|client|fleet|endpoint|url|host|header|auth|cookie/i

const request = (operation: PlatformProviderOperationV1, method: string): PlatformProviderBrokerBindingV1 => ({
  operation,
  direction: 'request',
  method,
  requestSchema: VALUE_SCHEMA,
  resultSchema: VALUE_SCHEMA,
})
const event = (operation: PlatformProviderOperationV1, method: string): PlatformProviderBrokerBindingV1 => ({
  operation,
  direction: 'event',
  method,
  eventSchema: VALUE_SCHEMA,
  responseSchema: VALUE_SCHEMA,
})

export const CODEX_APP_SERVER_PLATFORM_BINDINGS_V1: readonly PlatformProviderBrokerBindingV1[] = Object.freeze([
  request('models.list', 'model/list'),
  request('sessions.list', 'thread/list'),
  request('sessions.read', 'thread/read'),
  request('sessions.create', 'thread/start'),
  request('sessions.control', 'thread/resume'),
  request('sessions.control', 'thread/fork'),
  request('sessions.control', 'thread/archive'),
  request('sessions.control', 'thread/unarchive'),
  request('sessions.control', 'thread/delete'),
  request('turns.submit', 'turn/start'),
  request('turns.control', 'turn/steer'),
  request('turns.control', 'turn/interrupt'),
  request('turns.introduce', 'turn/start'),
  event('turns.submit', 'turn/started'),
  event('turns.submit', 'turn/completed'),
  event('turns.submit', 'turn/failed'),
  event('turns.submit', 'item/agentMessage/delta'),
  event('turns.submit', 'item/completed'),
  event('approvals.decide', 'approval/requested'),
  event('approvals.decide', 'approval/resolved'),
  event('approvals.decide', 'item/commandExecution/requestApproval'),
  event('approvals.decide', 'item/fileChange/requestApproval'),
])

function tuple(binding: PlatformProviderBrokerBindingV1): readonly string[] {
  return binding.direction === 'request'
    ? [binding.direction, binding.operation, binding.method, binding.requestSchema, binding.resultSchema]
    : [binding.direction, binding.operation, binding.method, binding.eventSchema, binding.responseSchema]
}

function digest(bindings: readonly PlatformProviderBrokerBindingV1[]): `sha256:${string}` {
  const tuples = bindings.map(tuple).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return `sha256:${createHash('sha256').update(JSON.stringify(tuples)).digest('hex')}`
}

function outbound(value: PlatformProviderJsonValue, workspaces: PlatformProviderWorkspaceAuthority): unknown {
  if (Array.isArray(value)) return value.map(item => outbound(item, workspaces))
  if (value === null || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'workspace') {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('workspace handle is invalid')
      }
      const handle = (item as { workspaceHandle?: unknown }).workspaceHandle
      if (typeof handle !== 'string') throw new Error('workspace handle is invalid')
      output.cwd = workspaces.resolve({ workspaceHandle: handle as `ppw_${string}` })
      continue
    }
    if (FORBIDDEN.test(key)) throw new Error(`broker request field ${key} is Host-private`)
    output[key] = outbound(item, workspaces)
  }
  return output
}

function inbound(value: unknown, workspaces: PlatformProviderWorkspaceAuthority, depth = 0): PlatformProviderJsonValue {
  if (depth > 32) throw new Error('provider response is too deeply nested')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error('provider response exceeds the item limit')
    return value.map(item => inbound(item, workspaces, depth + 1))
  }
  if (typeof value !== 'object') throw new Error('provider response is not JSON')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 512) throw new Error('provider response exceeds the field limit')
  const output: Record<string, PlatformProviderJsonValue> = {}
  for (const [key, item] of entries) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey === 'cwd') {
      if (typeof item !== 'string') throw new Error('provider cwd is invalid')
      output.workspace = workspaces.issue(item) as unknown as PlatformProviderJsonValue
      continue
    }
    if (normalizedKey === 'workspace') throw new Error('provider response field workspace is Host-private')
    if (FORBIDDEN.test(key)) throw new Error(`provider response field ${key} is Host-private`)
    output[key] = inbound(item, workspaces, depth + 1)
  }
  return output
}

class CodexAppServerPlatformTransport implements HostPlatformProviderBrokerTransportV1 {
  private readonly listeners = new Set<Parameters<HostPlatformProviderBrokerTransportV1['subscribe']>[0]>()
  private readonly pending = new Map<string, {
    readonly method: string
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
  }>()
  private readonly unsubscribeNotifications: (() => void) | undefined
  private readonly unsubscribeRequests: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly rpc: CodexAppServerRpc,
    private readonly policy: PlatformProviderBrokerPolicyV1,
    private readonly workspaces: PlatformProviderWorkspaceAuthority,
  ) {
    this.unsubscribeNotifications = rpc.subscribeNotifications?.((method, params) => {
      void this.publish(method, params, false).catch(() => undefined)
    })
    this.unsubscribeRequests = rpc.subscribeRequests?.((method, params) => {
      if (this.disposed) throw new Error('Platform broker transport is disposed')
      if (!this.policy.bindings.some(item => item.direction === 'event' && item.method === method)) {
        throw new Error(`Unsupported App Server request: ${method}`)
      }
      const eventId = `ppe_${randomUUID()}`
      return new Promise((resolve, reject) => {
        this.pending.set(eventId, { method, resolve, reject })
        void this.publish(method, params, true, eventId).catch(error => {
          this.pending.delete(eventId)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      })
    })
  }

  async exchange(
    method: string,
    params: PlatformProviderJsonValue,
    signal?: AbortSignal,
  ): Promise<PlatformProviderJsonValue> {
    if (this.disposed) throw new Error('Platform broker transport is disposed')
    return inbound(await this.rpc.request(method, outbound(params, this.workspaces), signal), this.workspaces)
  }

  subscribe(listener: Parameters<HostPlatformProviderBrokerTransportV1['subscribe']>[0]): () => void {
    if (this.disposed) throw new Error('Platform broker transport is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async respond(eventId: string, method: string, value: PlatformProviderJsonValue): Promise<void> {
    const pending = this.pending.get(eventId)
    if (pending === undefined || pending.method !== method) throw new Error('Platform broker event is stale')
    this.pending.delete(eventId)
    pending.resolve(outbound(value, this.workspaces))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeNotifications?.()
    this.unsubscribeRequests?.()
    this.listeners.clear()
    for (const pending of this.pending.values()) pending.reject(new Error('Platform broker transport disposed'))
    this.pending.clear()
    await this.rpc.close()
  }

  private async publish(method: string, params: unknown, responseRequired: boolean, id?: string): Promise<void> {
    if (this.disposed) return
    const binding = this.policy.bindings.find(item => item.direction === 'event' && item.method === method)
    if (binding === undefined) {
      if (responseRequired) throw new Error(`Unsupported App Server request: ${method}`)
      return
    }
    if (responseRequired && this.listeners.size === 0) {
      throw new Error(`No Platform provider listener is available for ${method}`)
    }
    const eventId = id ?? `ppe_${randomUUID()}`
    const event = {
      eventId,
      operation: binding.operation,
      method,
      payload: inbound(params, this.workspaces),
      responseRequired,
    }
    await Promise.all([...this.listeners].map(async listener => await listener(event)))
  }
}

export interface CodexAppServerPlatformBrokerAuthorityOptions {
  readonly serviceSchemas: readonly string[]
  open(input: Parameters<HostPlatformProviderBrokerAuthorityV1['open']>[0]): Promise<CodexAppServerRpc>
}

/** Host-owned Codex App Server transport; plugin code receives only its bound broker capability. */
export class CodexAppServerPlatformBrokerAuthority implements HostPlatformProviderBrokerAuthorityV1 {
  readonly #catalog: HostPlatformProviderBrokerCatalogV1 = Object.freeze({
    catalogDigest: digest(CODEX_APP_SERVER_PLATFORM_BINDINGS_V1),
    bindings: CODEX_APP_SERVER_PLATFORM_BINDINGS_V1,
  })

  constructor(private readonly options: CodexAppServerPlatformBrokerAuthorityOptions) {}

  catalog(schema: string): HostPlatformProviderBrokerCatalogV1 {
    if (!this.options.serviceSchemas.includes(schema)) {
      throw new Error(`Platform provider schema ${schema} is unsupported`)
    }
    return this.#catalog
  }

  async open(input: Parameters<HostPlatformProviderBrokerAuthorityV1['open']>[0]) {
    const rpc = await this.options.open(input)
    return new CodexAppServerPlatformTransport(rpc, input.policy, input.workspaces)
  }
}
