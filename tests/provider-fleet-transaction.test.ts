import { fleetReconfigurationTransaction } from '../packages/cli/src/providers/fleet-reconfiguration-transaction.js'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import type { LocalCodexProviderConfig } from '../packages/cli/src/providers/contracts.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

function config(root: string): LocalCodexProviderConfig {
  return {
    id: 'alpha',
    kind: 'local-codex',
    sourceProviderId: 'alpha',
    displayName: 'Alpha',
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
  it('coalesces concurrent rollback, restores once, and retries only failed cleanup participants', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => {
      release = resolve
    })
    const dispose = vi.fn().mockRejectedValueOnce(new Error('registry failed')).mockResolvedValue(undefined)
    const success = vi.fn(() => {})
    const failure = vi.fn().mockImplementationOnce(() => {
      throw new Error('subscription failed')
    })
      .mockResolvedValue(undefined)
    const authority = vi.fn(async () => {
      await wait
      throw new Error('authority failed')
    })
    const restore = vi.fn()
    const previous = {
      registry: { dispose: async () => {} },
      failures: new Map(),
      names: new Map(),
      lifecycleDisposers: new Map(),
      providers: [],
    }
    const transaction = fleetReconfigurationTransaction({
      generation: 'g2',
      previous: previous as never,
      replacement: {
        ...previous,
        registry: { dispose },
        lifecycleDisposers: new Map([['ok', success], ['fail', failure]]),
        providers: [{ providerId: 'main', providerGeneration: 'g2' }],
      } as never,
      restore,
      closeProviderGeneration: authority,
    })
    const first = transaction.rollback(), second = transaction.rollback()
    const results = Promise.allSettled([first, second])
    release()
    expect((await results).map(item => item.status)).toEqual(['rejected', 'rejected'])
    expect(restore).toHaveBeenCalledOnce()
    expect(authority).toHaveBeenCalledOnce()
    authority.mockResolvedValue(undefined)
    await transaction.rollback()
    await transaction.rollback()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledTimes(2)
    expect(authority).toHaveBeenCalledTimes(2)
    await expect(transaction.finalize()).rejects.toThrow('rolling back')
  })
})
