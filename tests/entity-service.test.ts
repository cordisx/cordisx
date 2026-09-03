import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { CordisXEntityRegistryServiceV1 } from '../packages/cli/src/renderer/entities.js'
import type { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'

describe('entity registry renderer service', () => {
  it('keeps proxy methods bound and closes subscriptions once on generation disposal', async () => {
    const binding = { profileId: 'profile-a', installationId: 'cx-installation.test', pluginId: 'chatroom', pluginGeneration: 1 }
    const requests: string[] = []
    const bridge = {
      request: async (_token: string, value: Record<string, unknown>) => {
        requests.push(String(value.operation))
        if (value.operation === 'entity-snapshot') return {
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-snapshot.v1.schema.json',
          contract: 'cordisx.entity-registry-snapshot/v1', schemaVersion: 1, binding, registryRevision: 3, entities: [],
        }
        if (value.operation === 'entity-subscribe') return {
          subscriptionId: 'cx-entity-subscription.test', binding, afterRevision: value.afterRevision, replayThrough: 3,
        }
        if (value.operation === 'entity-unsubscribe') return { status: 'closed', code: 'unsubscribed' }
        throw new Error('unexpected operation')
      },
    } as unknown as BrowserOwnerDocumentBridge
    let active = true
    const ctx = new Context()
    const fiber = ctx.plugin(CordisXEntityRegistryServiceV1, {
      bridge,
      principal: { source: 'file:///chatroom.js', pluginId: 'chatroom', moduleGeneration: 'module-one', installationId: binding.installationId, pluginGeneration: binding.pluginGeneration, token: 'secret' },
      profileId: binding.profileId, pluginGeneration: binding.pluginGeneration, active: () => active,
    })
    await fiber
    const registry = (ctx as Context & { readonly entities: InstanceType<typeof CordisXEntityRegistryServiceV1> }).entities
    const { snapshot, subscribe } = registry
    expect(await snapshot()).toMatchObject({ registryRevision: 3, binding })
    const result = await subscribe(1)
    expect(result.status).toBe('subscribed')
    if (result.status !== 'subscribed') throw new Error('subscription unavailable')
    active = false
    await fiber.dispose()
    await expect(result.subscription.closed).resolves.toMatchObject({
      status: 'closed', code: 'plugin-generation-replaced', subscriptionId: 'cx-entity-subscription.test', binding,
    })
    await expect(result.subscription.unsubscribe()).resolves.toMatchObject({ code: 'plugin-generation-replaced' })
    expect(requests).toEqual(['entity-snapshot', 'entity-subscribe', 'entity-unsubscribe'])
  })
})
