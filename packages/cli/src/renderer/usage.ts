import { Context, Service } from '@deepseek-ai/cordis'
import type { CordisXPluginIdentity, UsageSnapshotV1, UsageV1 } from '../contracts.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { BindingAgentHistoryAdapter } from './agent-history-binding.js'
import type { PermissionBroker } from './platform.js'
interface UsageOptions {
  readonly broker: PermissionBroker
  readonly adapter: { readUsage(caller: { ownerKey: string; generation: string }): Promise<UsageSnapshotV1> }
}
const options = new WeakMap<object, UsageOptions>()
const ORIGINAL = Symbol.for('cordis.original')
function bound(service: object): UsageOptions {
  const original = (service as { [ORIGINAL]?: object })[ORIGINAL]
  const value = original ? options.get(original) : options.get(service)
  if (!value) throw new Error('Usage requires a Host-bound plugin context')
  return value
}
function caller(ctx: Context): { identity: CordisXPluginIdentity; generation: string } | undefined {
  const scoped = ctx as Context & {
    [CORDISX_PLUGIN_ID]?: string
    [CORDISX_PLUGIN_SOURCE]?: string
    [CORDISX_PLUGIN_GENERATION]?: string
  }
  const id = scoped[CORDISX_PLUGIN_ID],
    source = scoped[CORDISX_PLUGIN_SOURCE],
    generation = scoped[CORDISX_PLUGIN_GENERATION]
  return id && source && generation ? { identity: { id, source }, generation } : undefined
}
const unavailable = (reason: 'permission-denied' | 'generation-retired' | 'host-unavailable'): UsageSnapshotV1 => ({
  schemaVersion: 1,
  status: 'unavailable',
  reason,
  diagnostics: [],
})
/** Plugins receive aggregate metadata only; identity, bridge credentials and lifecycle remain Host-owned. */
export class CordisXUsageService extends Service implements UsageV1 {
  constructor(ctx: Context, input: UsageOptions) {
    super(ctx, 'usage')
    options.set(this, input)
  }
  async read(): Promise<UsageSnapshotV1> {
    const owner = caller(this.ctx), input = bound(this)
    if (!owner) return unavailable('permission-denied')
    const fence = input.broker.usageFence(owner.identity, owner.generation)
    if (!fence()) return unavailable('generation-retired')
    if (!await input.broker.authorizeUsage(owner.identity)) return unavailable('permission-denied')
    if (!fence()) return unavailable('generation-retired')
    const result = await input.adapter.readUsage({
      ownerKey: `${owner.identity.source}:${owner.identity.id}`,
      generation: owner.generation,
    })
    if (!fence()) return unavailable('generation-retired')
    if (!input.broker.usageAllowed(owner.identity)) return unavailable('permission-denied')
    return structuredClone(result)
  }
  subscribe(listener: () => void): () => void {
    const owner = caller(this.ctx), input = bound(this)
    if (!owner || typeof listener !== 'function') return () => {}
    const fence = input.broker.usageFence(owner.identity, owner.generation)
    return this.ctx.effect(() => {
      const notify = () => {
        if (!fence()) return
        try {
          listener()
        } catch { /* One consumer cannot break Host invalidation. */ }
      }
      const dispose = input.broker.subscribe(notify)
      const timer = setInterval(() => {
        if (input.broker.usageAllowed(owner.identity)) notify()
      }, 5_000)
      return () => {
        clearInterval(timer)
        dispose()
      }
    }, 'usage.subscribe')
  }
}
export async function installUsageService(
  ctx: Context,
  broker: PermissionBroker,
  token: string | undefined,
): Promise<void> {
  const adapter = token ? await BindingAgentHistoryAdapter.connect(token).catch(() => undefined) : undefined
  ctx.effect(() => () => adapter?.dispose(), 'usage bridge')
  await ctx.plugin(CordisXUsageService, {
    broker,
    adapter: adapter ?? { readUsage: async () => unavailable('host-unavailable') },
  })
}
