import { Context, Service } from '@deepseek-ai/cordis'
import type {
  EntityChangePage,
  EntityGetResult,
  EntityRegistry,
  EntityRegistryBinding,
  EntityRegistrySnapshot,
  EntitySaveRequest,
  EntitySaveResult,
  EntitySubscribeResult,
  EntitySubscription,
  EntitySubscriptionClosed,
} from '@cordisx/protocol/entities/v1'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'

import type { BrowserOwnerDocumentBridge } from './owner-documents.js'

const CLOSE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-subscription-close.v1.schema.json' as const
const PAGE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-change-page.v1.schema.json' as const
const POLL_MS = 200

export interface EntityPrincipalBinding {
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly installationId: string
  readonly pluginGeneration: number
  readonly token: string
}

interface EntityReadProjection {
  readonly revision: number
  readonly changes: EntityChangePage['changes']
}

const wait = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, POLL_MS))
const clone = <Value>(value: Value): Value => structuredClone(value)

class BrowserEntitySubscription {
  readonly descriptor: EntitySubscription['descriptor']
  readonly closed: Promise<EntitySubscriptionClosed>
  readonly pages: AsyncIterable<EntityChangePage>
  #resolveClosed!: (value: EntitySubscriptionClosed) => void
  #terminal?: EntitySubscriptionClosed
  #cursor: number

  constructor(
    private readonly bridge: BrowserOwnerDocumentBridge,
    private readonly token: string,
    descriptor: EntitySubscription['descriptor'],
    private readonly active: () => boolean,
  ) {
    this.descriptor = Object.freeze(clone(descriptor))
    this.#cursor = descriptor.afterRevision
    this.closed = new Promise(resolve => {
      this.#resolveClosed = resolve
    })
    this.pages = Object.freeze({ [Symbol.asyncIterator]: () => this.iterate() })
  }

  private async *iterate(): AsyncGenerator<EntityChangePage> {
    while (this.#terminal === undefined) {
      if (!this.active()) {
        await this.close('plugin-generation-replaced')
        return
      }
      let result: EntityReadProjection
      try {
        result = await this.bridge.request(this.token, {
          operation: 'entity-read',
          subscriptionId: this.descriptor.subscriptionId,
          afterRevision: this.#cursor,
          replayThrough: this.descriptor.replayThrough,
        }) as EntityReadProjection
      } catch {
        await this.close('connection-replaced')
        return
      }
      if (result.changes.length === 0) {
        await wait()
        continue
      }
      const replay = this.#cursor < this.descriptor.replayThrough
      const limit = replay ? this.descriptor.replayThrough : result.revision
      const changes = result.changes.filter(change => change.sequence <= limit)
      if (changes.length === 0) {
        await wait()
        continue
      }
      this.#cursor = changes[changes.length - 1]!.sequence
      yield Object.freeze({
        $schema: PAGE_SCHEMA,
        contract: 'cordisx.entity-registry-change-page/v1',
        schemaVersion: 1,
        subscription: this.descriptor,
        phase: replay ? 'replay' : 'live',
        changes: clone(changes),
        nextRevision: this.#cursor,
        hasMore: this.#cursor < limit,
      })
    }
  }

  async unsubscribe(): Promise<EntitySubscriptionClosed> {
    return await this.close('unsubscribed')
  }

  async close(code: EntitySubscriptionClosed['code']): Promise<EntitySubscriptionClosed> {
    if (this.#terminal !== undefined) return this.#terminal
    const terminal = Object.freeze({
      $schema: CLOSE_SCHEMA,
      contract: 'cordisx.entity-registry-subscription-close/v1',
      schemaVersion: 1,
      subscriptionId: this.descriptor.subscriptionId,
      binding: clone(this.descriptor.binding),
      status: 'closed' as const,
      code,
    })
    this.#terminal = terminal
    this.#resolveClosed(terminal)
    try {
      await this.bridge.request(this.token, {
        operation: 'entity-unsubscribe',
        subscriptionId: this.descriptor.subscriptionId,
      })
    } catch { /* first terminal wins */ }
    return terminal
  }
}

export class CordisXEntityRegistryServiceV1 extends Service {
  readonly binding: EntityRegistryBinding
  readonly #subscriptions = new Set<BrowserEntitySubscription>()
  readonly #active: () => boolean
  readonly #token: string
  readonly bridge: BrowserOwnerDocumentBridge | undefined

  constructor(
    ctx: Context,
    options: {
      readonly bridge: BrowserOwnerDocumentBridge | undefined
      readonly principal: EntityPrincipalBinding | undefined
      readonly profileId: string
      readonly pluginGeneration: number
      readonly active: () => boolean
    },
  ) {
    super(ctx, 'entities')
    this.bridge = options.bridge
    this.#active = options.active
    this.#token = options.principal?.token ?? ''
    this.binding = Object.freeze({
      profileId: options.profileId,
      installationId: options.principal?.installationId ?? 'unavailable',
      pluginId: options.principal?.pluginId ?? 'unavailable',
      pluginGeneration: options.pluginGeneration,
    })
    ctx.effect(() => () => {
      for (const subscription of this.#subscriptions) void subscription.close('plugin-generation-replaced')
      this.#subscriptions.clear()
    })
  }

  snapshot = async (): Promise<EntityRegistrySnapshot> => {
    if (this.bridge === undefined || !this.#active()) throw new Error('entity registry is unavailable')
    return clone(
      await this.bridge.request(this.#token, {
        operation: 'entity-snapshot',
        binding: this.binding,
      }) as EntityRegistrySnapshot,
    )
  }

  get = async (identity: AgentDefinitionIdentity): Promise<EntityGetResult> => {
    if (this.bridge === undefined || !this.#active()) {
      return { status: 'unavailable', code: 'plugin-generation-replaced' }
    }
    try {
      return clone(
        await this.bridge.request(this.#token, {
          operation: 'entity-get',
          binding: this.binding,
          identity,
        }) as EntityGetResult,
      )
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }

  save = async (request: EntitySaveRequest): Promise<EntitySaveResult> => {
    if (this.bridge === undefined || !this.#active()) {
      return { status: 'unavailable', code: 'plugin-generation-replaced' }
    }
    try {
      structuredClone(request)
      return clone(
        await this.bridge.request(this.#token, {
          operation: 'entity-save',
          binding: this.binding,
          request,
        }) as EntitySaveResult,
      )
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }

  subscribe = async (afterRevision: number): Promise<EntitySubscribeResult> => {
    if (this.bridge === undefined || !this.#active()) {
      return { status: 'unavailable', code: 'plugin-generation-replaced' }
    }
    try {
      const descriptor = await this.bridge.request(this.#token, {
        operation: 'entity-subscribe',
        binding: this.binding,
        afterRevision,
      }) as EntitySubscription['descriptor']
      const subscription = new BrowserEntitySubscription(this.bridge, this.#token, descriptor, this.#active)
      this.#subscriptions.add(subscription)
      void subscription.closed.then(() => this.#subscriptions.delete(subscription))
      return { status: 'subscribed', subscription: subscription as unknown as EntitySubscription }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }
}
