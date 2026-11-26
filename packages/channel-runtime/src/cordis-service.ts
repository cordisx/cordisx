import { Context, Service } from '@deepseek-ai/cordis'
import type { ChannelRuntimeV1 } from '@cordisx/protocol/channel-runtime/v1'
import type { ChannelAdapterDefinitionV2 } from '@cordisx/protocol/channel-runtime/v2'
import type { ChannelMediaPrepareRequestV1, ChannelMessageSendV1 } from '@cordisx/protocol/channel-outbound/v1'
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
  ChannelThreadRef,
} from './types.js'

const CORDISX_NODE_PLUGIN_ID = Symbol('cordisx.nodePluginId')
const CORDISX_NODE_PLUGIN_SOURCE = Symbol('cordisx.nodePluginSource')
const CORDISX_NODE_PLUGIN_GENERATION = Symbol('cordisx.nodePluginGeneration')
const CORDISX_NODE_CONFIGURATION_REVISION = Symbol('cordisx.nodeConfigurationRevision')
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

export type CordisXChannel = import('@cordisx/protocol/channel-runtime/v4').ChannelRuntimeV4

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Source- and generation-bound launcher-side Channel service. */
    channel: ChannelRuntimeV1
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

function configurationRevisionFrom(ctx: Context): number {
  const revision = (ctx as Context & { [CORDISX_NODE_CONFIGURATION_REVISION]?: number })[
    CORDISX_NODE_CONFIGURATION_REVISION
  ]
  if (!Number.isInteger(revision) || revision === undefined || revision < 1) {
    throw new Error('Channel calls require a launcher-stamped service configuration revision')
  }
  return revision
}

/** Launcher-only helper used while constructing a Node plugin child context. */
export function bindChannelPluginContext(
  ctx: Context,
  identity: ChannelPluginIdentity,
  configurationRevision: number,
): Context & { readonly channel: CordisXChannel } {
  if (!Number.isInteger(configurationRevision) || configurationRevision < 1) {
    throw new Error('Channel service configuration revision is invalid')
  }
  return ctx.extend({
    [CORDISX_NODE_PLUGIN_ID]: identity.pluginId,
    [CORDISX_NODE_PLUGIN_SOURCE]: identity.source,
    [CORDISX_NODE_PLUGIN_GENERATION]: identity.generation,
    [CORDISX_NODE_CONFIGURATION_REVISION]: configurationRevision,
  }) as Context & { readonly channel: CordisXChannel }
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

  get configuration(): CordisXChannel['configuration'] {
    return Object.freeze({ revision: configurationRevisionFrom(this.ctx) })
  }

  get connections(): CordisXChannelConnections {
    return Object.freeze({
      list: async () => await runtimeFor(this).connections(identityFrom(this.ctx)),
    })
  }

  get adapters(): CordisXChannelAdapters {
    return Object.freeze({
      register: async (definition: ChannelAdapterDefinition) => {
        const configurationRevision = configurationRevisionFrom(this.ctx)
        if (definition.descriptor.configurationRevision !== configurationRevision) {
          throw new Error('Channel adapter configuration revision does not match the Host stamp')
        }
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
      send: async (notification: ChannelNotification) => {
        if (notification.media !== undefined) throw new Error('CHANNEL_MEDIA_PROTOCOL_UNAVAILABLE')
        if (notification.content !== undefined || notification.fallback !== undefined) {
          throw new Error('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
        }
        return await runtimeFor(this).notify(notification, identityFrom(this.ctx))
      },
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

  get outbound(): CordisXChannel['outbound'] {
    return Object.freeze({
      capabilities: async (target: ChannelThreadRef) => {
        const caller = identityFrom(this.ctx)
        return await runtimeFor(this).outboundCapabilities(target, caller)
      },
      prepare: async (request: ChannelMediaPrepareRequestV1) => {
        const caller = identityFrom(this.ctx)
        return await runtimeFor(this).prepareOutbound(request, caller)
      },
      send: async (request: ChannelMessageSendV1) => {
        const caller = identityFrom(this.ctx)
        return await runtimeFor(this).sendTyped(request, caller)
      },
    })
  }

  get adaptersV2(): CordisXChannel['adaptersV2'] {
    return Object.freeze({
      register: async (definition: ChannelAdapterDefinitionV2) => {
        const caller = identityFrom(this.ctx)
        if (definition.descriptor.configurationRevision !== configurationRevisionFrom(this.ctx)) {
          throw new Error('Channel adapter configuration revision does not match the Host stamp')
        }
        const handle = await runtimeFor(this).activateV2(definition, caller)
        this.ctx.effect(
          () => async () => await handle.dispose(),
          `channel.adaptersV2.register(${JSON.stringify(definition.descriptor.ref.adapterId)})`,
        )
        return handle
      },
    })
  }

  get outboundV2(): CordisXChannel['outboundV2'] {
    return Object.freeze({
      capabilities: async (target: ChannelThreadRef) =>
        runtimeFor(this).outboundCapabilitiesV2(target, identityFrom(this.ctx)),
      prepare: async (request: ChannelMediaPrepareRequestV1) =>
        runtimeFor(this).prepareOutbound(request, identityFrom(this.ctx)),
      send: async (request: import('@cordisx/protocol/channel-outbound/v2').ChannelMessageSendV2) => {
        if (request.contract !== 'cordisx.channel-message-send/v2' || request.schemaVersion !== 2) {
          throw new Error('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
        }
        return runtimeFor(this).sendTypedV2(request, identityFrom(this.ctx))
      },
    })
  }

  get outboundV3(): CordisXChannel['outboundV3'] {
    return Object.freeze({
      capabilities: async (target: ChannelThreadRef) =>
        runtimeFor(this).outboundCapabilitiesV3(target, identityFrom(this.ctx)),
      prepare: async (request: ChannelMediaPrepareRequestV1) =>
        runtimeFor(this).prepareOutbound(request, identityFrom(this.ctx)),
      send: async (request: import('@cordisx/protocol/channel-outbound/v3').ChannelMessageSendV3) =>
        runtimeFor(this).sendTypedV3(request, identityFrom(this.ctx)),
    })
  }
}
