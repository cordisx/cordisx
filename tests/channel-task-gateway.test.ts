import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import { LauncherChannelTaskGateway, StaticChannelWorkspaceResolver, channelTaskScopeFingerprint } from '../packages/cli/src/launcher/channel-task-gateway.js'

const temporary = new Set<string>()
afterEach(async () => await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true }))))

function rpc(failTurn = false): CodexAppServerRpc {
  return {
    generation: 'provider-generation-1',
    async request<Result>(method: string): Promise<Result> {
      if (method === 'model/list') return { data: [{ id: 'model-1', model: 'model-1' }] } as Result
      if (method === 'thread/start') return { thread: { id: 'session-1', modelProvider: 'alpha', cwd: '/workspace', createdAt: 1, updatedAt: 1 } } as Result
      if (method === 'turn/start' && failTurn) throw new Error('turn start failed')
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as Result
      throw new Error(`unexpected ${method}`)
    },
    async close() {},
  }
}

describe('launcher Channel task gateway', () => {
  it('consumes one Host-private grant and preserves a created session when its initial turn fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-gateway-'))
    temporary.add(root)
    const fleet = await ProviderFleet.create([{
      id: 'alpha', kind: 'cli-proxy-api', displayName: 'Alpha', baseUrl: 'https://example.test', credentialRef: 'host-secret:test',
      codexExecutable: 'codex', codexHome: root, enabled: true, timeoutMs: 1,
    }], { startServer: async () => rpc(true) })
    const gateway = new LauncherChannelTaskGateway({
      fleet, profileId: 'work',
      workspaces: new StaticChannelWorkspaceResolver({ work: [{ alias: 'workspace', root, cwd: root }] }),
      permissions: {
        async authorize(input) {
          return { decision: 'allow' as const, scopeFingerprint: channelTaskScopeFingerprint(input) }
        },
      },
    })
    const input = {
      contract: 'cordisx.channel-user-input/v1' as const, schemaVersion: 1 as const, role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      source: { kind: 'channel' as const, event: { adapterId: 'simulator', accountId: 'local', tenantId: 'tenant', conversationId: 'one', kind: 'direct' as const, threadId: 'one', semantics: 'conversation' as const, eventId: 'event-1' } },
      receivedAt: '2026-08-26T00:00:00.000Z',
    }
    const result = await gateway.execute({ kind: 'create', provider: { id: 'alpha' }, model: { id: 'model-1' }, profile: { id: 'work' }, workspace: { alias: 'workspace' } }, {
      operationId: 'operation-1', routeId: 'route-1', input, serviceGeneration: 'channel-1', configurationRevision: 1,
    })
    expect(result).toMatchObject({ session: { providerId: 'alpha', remoteSessionId: 'session-1' }, dispatch: { status: 'created-initial-turn-failed', lifecycle: { afterSequence: 0 } } })
    expect(await gateway.execute({ kind: 'create', provider: { id: 'alpha' }, model: { id: 'model-1' }, profile: { id: 'work' }, workspace: { alias: 'workspace' } }, {
      operationId: 'operation-1', routeId: 'route-1', input, serviceGeneration: 'channel-1', configurationRevision: 1,
    })).toEqual(result)
    await fleet.close()
  })
})
