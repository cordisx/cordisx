import { Context, Service } from '@deepseek-ai/cordis'
import { ChannelRuntime } from './runtime.js'
import type {
  ChannelAdapterDefinition,
  ChannelAdapterHandle,
  ChannelDeliveryHandle,
  ChannelMessageListener,
  ChannelNotification,
  ChannelPluginIdentity,
  ChannelRuntimeAccountSnapshot,
  ChannelSubscriptionFilter,
} from './types.js'

const CORDISX_NODE_PLUGIN_ID = Symbol('cordisx.nodePluginId')
const CORDISX_NODE_PLUGIN_SOURCE = Symbol('cordisx.nodePluginSource')
const CORDISX_NODE_PLUGIN_GENERATION = Symbol('cordisx.nodePluginGeneration')
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

export interface CordisXChannelConnections {
  list(): Promise<readonly ChannelRuntimeAccountSnapshot[]>
}

export interface CordisXChannelAdapters {
  register(definition: ChannelAdapterDefinition): Promise<ChannelAdapterHandle>
}

export interface CordisXChannelMessages {
  send(notification: ChannelNotification): Promise<ChannelDeliveryHandle>
  subscribe(filter: ChannelSubscriptionFilter, listener: ChannelMessageListener): Promise<() => void>
}

export interface CordisXChannel {
  readonly connections: CordisXChannelConnections
  readonly adapters: CordisXChannelAdapters
  readonly messages: CordisXChannelMessages
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Source- and generation-bound launcher-side Channel service. */
    channel: CordisXChannel
  }
}

const runtimes = new WeakMap<object, ChannelRuntime>()

function runtimeFor(service: object): ChannelRuntime {
  const original = (service as { [CORDIS_ORIGINAL]?: unknown })[CORDIS_ORIGINAL]
  if (typeof original === 'object' && original !== null) {
    const runtime = runtimes.get(original)
    if (runtime !== undefined) return runtime
  }
  let candidate: object | null = service
  while (candidate !== null) {
    const runtime = runtimes.get(candidate)
    if (runtime !== undefined) return runtime
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Channel service is detached from its launcher runtime')
}

function identityFrom(ctx: Context): ChannelPluginIdentity {
  const bound = ctx as Context & {
    [CORDISX_NODE_PLUGIN_ID]?: string
    [CORDISX_NODE_PLUGIN_SOURCE]?: string
    [CORDISX_NODE_PLUGIN_GENERATION]?: string
  }
  const pluginId = bound[CORDISX_NODE_PLUGIN_ID]
  const source = bound[CORDISX_NODE_PLUGIN_SOURCE]
  const generation = bound[CORDISX_NODE_PLUGIN_GENERATION]
  if (pluginId === undefined || source === undefined || generation === undefined) {
    throw new Error('Channel calls require a launcher-bound Node plugin identity')
  }
  return Object.freeze({ source, pluginId, generation })
}

/** Launcher-only helper used while constructing a Node plugin child context. */
export function bindChannelPluginContext(ctx: Context, identity: ChannelPluginIdentity): Context {
  return ctx.extend({
    [CORDISX_NODE_PLUGIN_ID]: identity.pluginId,
    [CORDISX_NODE_PLUGIN_SOURCE]: identity.source,
    [CORDISX_NODE_PLUGIN_GENERATION]: identity.generation,
  })
}

/**
 * High-level Cordis service. Consumer plugins never receive the adapter
 * connection or the underlying runtime/store.
 */
export class CordisXChannelService extends Service implements CordisXChannel {
  constructor(ctx: Context, runtime: ChannelRuntime) {
    super(ctx, 'channel')
    runtimes.set(this, runtime)
  }

  get connections(): CordisXChannelConnections {
    return Object.freeze({
      list: async () => await runtimeFor(this).connections(identityFrom(this.ctx)),
    })
  }

  get adapters(): CordisXChannelAdapters {
    return Object.freeze({
      register: async (definition: ChannelAdapterDefinition) => {
        const handle = await runtimeFor(this).activate(definition, identityFrom(this.ctx))
        this.ctx.effect(
          () => async () => await handle.dispose(),
          `channel.adapters.register(${JSON.stringify(definition.descriptor.ref.adapterId)})`,
        )
        return handle
      },
    })
  }

  get messages(): CordisXChannelMessages {
    return Object.freeze({
      send: async (notification: ChannelNotification) => await runtimeFor(this).notify(notification, identityFrom(this.ctx)),
      subscribe: async (filter: ChannelSubscriptionFilter, listener: ChannelMessageListener) => {
        const dispose = await runtimeFor(this).subscribe(identityFrom(this.ctx), filter, listener)
        this.ctx.effect(
          () => dispose,
          `channel.messages.subscribe(${JSON.stringify(filter.account.adapterId)})`,
        )
        return dispose
      },
    })
  }
}
