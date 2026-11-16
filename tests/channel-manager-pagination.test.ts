import { describe, expect, it } from 'vitest'
import { PublicChannelManagerController } from '../packages/cli/src/renderer/channel-manager-public.js'
import type { ChannelManagerProjectionV1 } from '../packages/cli/src/renderer/channel-manager.js'

describe('Channel binding read windows', () => {
  it('keeps frozen snapshots bounded while paging all persisted bindings and rejecting stale cursors', () => {
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
    let projection: ChannelManagerProjectionV1 = {
      contract: 'cordisx.channel-manager-projection/v1',
      schemaVersion: 1,
      status: 'implemented',
      service: {
        configurationKind: 'host',
        configApplies: 'service-restart',
        revision: 1,
        lastGoodRevision: 1,
        writable: true,
      },
      connections: [{ ref, adapterKind: 'feishu', enabled: true, transportMode: 'websocket', secretState: 'ready' }],
      accounts: [],
      routes: [],
      diagnostics: [],
      bindings: Array.from(
        { length: 10_002 },
        (_, index) => ({
          bindingId: 'b' + index,
          channel: { ...ref, conversationId: 'oc_' + index, threadId: 'oc_' + index },
          session: { providerId: 'codex', remoteSessionId: 'chat' + index },
          routeId: 'r',
          state: 'active',
        }),
      ),
    }
    const controller = new PublicChannelManagerController({
      profileId: 'test',
      hostGeneration: 'one',
      projection: () => projection,
      actionsAvailable: () => true,
      runAction: async () => ({ status: 'applied' }),
    })
    const snapshot = controller.snapshot()
    expect(snapshot.bindings).toHaveLength(10_000)
    const connectionToken = snapshot.accounts[0]!.connectionToken
    const first = controller.bindingPage({ connectionToken, limit: 100 })
    expect(first.total).toBe(10_002)
    expect(first.bindings).toHaveLength(100)
    const second = controller.bindingPage({ connectionToken, afterCursor: first.nextCursor!, limit: 100 })
    expect(second.bindings[0]?.bindingToken).not.toBe(first.bindings[0]?.bindingToken)
    expect(second.snapshotRevision).toBe(first.snapshotRevision)
    const beyondOldSnapshot = snapshot.bindings.at(-1)!.bindingToken
    let page = second
    let seen = 200
    while (page.nextCursor) {
      page = controller.bindingPage({ connectionToken, afterCursor: page.nextCursor, limit: 100 })
      seen += page.bindings.length
    }
    expect(seen).toBe(10_002)
    expect(page.bindings).toHaveLength(2)
    expect(page.bindings.some(binding => binding.bindingToken === beyondOldSnapshot)).toBe(false)
    projection = { ...projection, bindings: projection.bindings.slice(1) }
    expect(() => controller.bindingPage({ connectionToken, afterCursor: first.nextCursor! })).toThrow('STALE_CURSOR')
  })
})
