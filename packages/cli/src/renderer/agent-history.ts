import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CordisXAgentHistory,
  CordisXAgentHistoryPage,
  CordisXAgentHistoryQuery,
  CordisXAgentHistoryTailQuery,
  CordisXPlatformResult,
  CordisXPluginIdentity,
} from '../contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { PermissionBroker, platformIdentityKey } from './platform.js'
import type { CordisXAgentHistoryAdapter } from './agent-history-binding.js'
import type { PluginConsoleAspect, PluginPrincipalToken } from './plugin-console.js'

interface AgentHistoryServiceOptions {
  readonly adapter: CordisXAgentHistoryAdapter
  readonly broker: PermissionBroker
  readonly generation: string
  readonly console?: PluginConsoleAspect
}

const options = new WeakMap<object, AgentHistoryServiceOptions>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const CURSOR = /^[A-Za-z0-9._~-]{16,2048}$/

function serviceOptions(service: object): AgentHistoryServiceOptions {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const found = options.get(candidate)
      if (found !== undefined) return found
    }
  }
  throw new Error('CordisX Agent history service is detached from its host binding')
}

function identity(ctx: Context): CordisXPluginIdentity | undefined {
  const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  return scoped[CORDISX_PLUGIN_ID] === undefined || scoped[CORDISX_PLUGIN_SOURCE] === undefined
    ? undefined
    : { id: scoped[CORDISX_PLUGIN_ID], source: scoped[CORDISX_PLUGIN_SOURCE] }
}

function failure(code: 'invalid-request' | 'permission-denied', message: string): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message } }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)
}

function validLimit(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 500)
}

function validPolicy(value: unknown): boolean {
  return value === undefined || ['referenced', 'summarized', 'inline'].includes(String(value))
}

function validQuery(input: CordisXAgentHistoryQuery): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.keys(input).every(key => ['sessionId', 'cursor', 'limit', 'payloadPolicy'].includes(key))
    && validSessionId(input.sessionId)
    && (input.cursor === undefined || CURSOR.test(input.cursor))
    && validLimit(input.limit)
    && validPolicy(input.payloadPolicy)
}

function validTail(input: CordisXAgentHistoryTailQuery): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.keys(input).every(key => ['sessionId', 'tailCursor', 'limit', 'payloadPolicy'].includes(key))
    && validSessionId(input.sessionId)
    && CURSOR.test(input.tailCursor)
    && validLimit(input.limit)
    && validPolicy(input.payloadPolicy)
}

/** Permission-brokered history projection. The adapter/path/cursor registry stay private. */
export class CordisXAgentHistoryService extends Service implements CordisXAgentHistory {
  constructor(ctx: Context, input: AgentHistoryServiceOptions) {
    super(ctx, 'agentHistory')
    options.set(this, input)
  }

  status(): ReturnType<CordisXAgentHistory['status']> {
    return structuredClone(serviceOptions(this).adapter.status())
  }

  async query(input: CordisXAgentHistoryQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const console = serviceOptions(this).console
    const token = console?.tokenFromContext(this.ctx)
    return token === undefined || console === undefined ? await this.queryBound(input) : await console.run(
      token, 'agentHistory.query', input, invocation => this.queryBound(input, token, invocation), { sessionId: input.sessionId },
    )
  }

  private async queryBound(input: CordisXAgentHistoryQuery, token?: PluginPrincipalToken, invocation?: { dispatch(message?: string): void }): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const caller = token === undefined ? identity(this.ctx) : serviceOptions(this).console?.owner(token)
    if (caller === undefined) return failure('permission-denied', 'Agent history requires a plugin context')
    if (!validQuery(input)) return failure('invalid-request', 'Agent history query is invalid')
    const grant = await serviceOptions(this).broker.authorize(caller, 'agent.history.read', { agentSessionId: input.sessionId })
    if (!grant.ok) return grant
    invocation?.dispatch('Dispatched to Host history store')
    return await serviceOptions(this).adapter.query(input, {
      ownerKey: platformIdentityKey(caller),
      generation: serviceOptions(this).generation,
    })
  }

  async tail(input: CordisXAgentHistoryTailQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const console = serviceOptions(this).console
    const token = console?.tokenFromContext(this.ctx)
    return token === undefined || console === undefined ? await this.tailBound(input) : await console.run(
      token, 'agentHistory.tail', input, invocation => this.tailBound(input, token, invocation), { sessionId: input.sessionId },
    )
  }

  private async tailBound(input: CordisXAgentHistoryTailQuery, token?: PluginPrincipalToken, invocation?: { dispatch(message?: string): void }): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const caller = token === undefined ? identity(this.ctx) : serviceOptions(this).console?.owner(token)
    if (caller === undefined) return failure('permission-denied', 'Agent history requires a plugin context')
    if (!validTail(input)) return failure('invalid-request', 'Agent history tail query is invalid')
    const grant = await serviceOptions(this).broker.authorize(caller, 'agent.history.read', { agentSessionId: input.sessionId })
    if (!grant.ok) return grant
    invocation?.dispatch('Dispatched to Host history store')
    return await serviceOptions(this).adapter.tail(input, {
      ownerKey: platformIdentityKey(caller),
      generation: serviceOptions(this).generation,
    })
  }
}
