import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import type { CliProxyProviderConfig } from '../packages/cli/src/providers/contracts.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

function config(root: string): CliProxyProviderConfig {
  return {
    id: 'alpha',
    kind: 'cli-proxy-api',
    displayName: 'Alpha',
    baseUrl: 'https://alpha.test/v1',
    apiKeyEnv: 'ALPHA_KEY',
    codexExecutable: 'codex',
    codexHome: path.join(root, 'alpha'),
    enabled: true,
    timeoutMs: 1_000,
  }
}

function server(generation: string): CodexAppServerRpc {
  return {
    generation,
    request: async () => ({ data: [], nextCursor: null }) as never,
    close: async () => undefined,
  }
}

describe('Provider Fleet external preparation transaction', () => {
  it('carries a prepared publication through swap and closes it on persistence rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-external-prepare-'))
    let generation = 0
    let subscriptions = 0
    let externalClosed = 0
    const fleet = await ProviderFleet.create([config(root)], {
      startServer: async () => server(`generation-alpha-${++generation}`),
    })
    const transaction = await fleet.reconfigure([config(root)], async replacement => {
      await replacement.publishConnections([{
        displayName: 'External',
        connection: {
          providerId: 'external',
          generation: 'external-generation-1',
          subscribeLifecycle: () => {
            subscriptions++
            return () => undefined
          },
          close: async () => {
            externalClosed++
          },
        } as never,
      }])
    })
    expect(fleet.providerStatuses().map(item => [item.providerId, item.generation])).toEqual([
      ['alpha', 'generation-alpha-2'],
      ['external', 'external-generation-1'],
    ])
    expect(subscriptions).toBe(2)
    await transaction.rollback()
    expect(fleet.providerStatuses().map(item => [item.providerId, item.generation])).toEqual([
      ['alpha', 'generation-alpha-1'],
    ])
    expect(externalClosed).toBe(1)
    await fleet.close()
  })

  it('restores the previous Fleet even when rollback authority cleanup rejects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-rollback-cleanup-'))
    let generation = 0
    const closeProviderGeneration = vi.fn(async () => {
      throw new Error('authority cleanup failed')
    })
    const fleet = await ProviderFleet.create([config(root)], {
      startServer: async () => server(`generation-alpha-${++generation}`),
      agentLoopAuthority: { closeProviderGeneration } as never,
    })
    const transaction = await fleet.reconfigure([config(root)])
    await expect(transaction.rollback()).rejects.toThrow('rollback cleanup failed')
    expect(fleet.providerStatuses()[0]?.generation).toBe('generation-alpha-1')
    await expect(fleet.listModels({ providerIds: ['alpha'] })).resolves.toMatchObject({ ok: true })
    await fleet.close()
  })

  it('retries incomplete finalize authority cleanup instead of treating the second call as settled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-finalize-cleanup-'))
    let generation = 0
    const closeProviderGeneration = vi.fn()
      .mockRejectedValueOnce(new Error('authority cleanup failed'))
      .mockResolvedValue(undefined)
    const fleet = await ProviderFleet.create([config(root)], {
      startServer: async () => server(`generation-alpha-${++generation}`),
      agentLoopAuthority: { closeProviderGeneration } as never,
    })
    const transaction = await fleet.reconfigure([config(root)])
    await expect(transaction.finalize()).rejects.toThrow('finalize cleanup failed')
    await expect(transaction.finalize()).resolves.toBeUndefined()
    expect(closeProviderGeneration).toHaveBeenCalledTimes(2)
    expect(fleet.providerStatuses()[0]?.generation).toBe('generation-alpha-2')
    await fleet.close()
  })
})
