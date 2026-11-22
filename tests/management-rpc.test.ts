import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import type { PluginManagementSnapshot } from '../packages/cli/src/management/contracts.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'

describe('plugin management RPC', () => {
  it('still times out a stalled installation request', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-timeout-rpc-'))
    let started!: () => void
    const executionStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const service = {
      execute: async () => {
        started()
        return await new Promise(() => {})
      },
      close: () => {},
    } as unknown as PluginManagementService
    const processStartedAt = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'generation-1',
      processStartedAt: processStartedAt!,
      service,
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = await readPluginManagementRpcEndpoint(paths)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = requestPluginManagementRpc(paths, endpoint!, {
        kind: 'execute',
        request: { kind: 'plugin-execute-plan', executionToken: 'token' },
      })
      const rejected = expect(pending).rejects.toThrow('plugin management request timed out')
      await executionStarted
      await vi.advanceTimersByTimeAsync(180_000)
      await rejected
    } finally {
      vi.useRealTimers()
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps an executing installation open beyond the old 60-second deadline', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-slow-rpc-'))
    let started!: () => void
    const executionStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const service = {
      execute: async () => {
        started()
        await new Promise(resolve => setTimeout(resolve, 61_000))
        return { status: 'applied' }
      },
      close: () => {},
    } as unknown as PluginManagementService
    const processStartedAt = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'generation-1',
      processStartedAt: processStartedAt!,
      service,
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = await readPluginManagementRpcEndpoint(paths)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = requestPluginManagementRpc(paths, endpoint!, {
        kind: 'execute',
        request: { kind: 'plugin-execute-plan', executionToken: 'token' },
      })
      await executionStarted
      await vi.advanceTimersByTimeAsync(61_000)
      await expect(pending).resolves.toEqual({ status: 'applied' })
    } finally {
      vi.useRealTimers()
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('allows observation and interactive login to outlive ordinary mutation deadlines', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-observation-rpc-'))
    let started!: () => void
    const bothStarted = new Promise<void>(resolve => {
      started = resolve
    })
    let count = 0
    const processStartedAt = (await processStartIdentity(process.pid))!
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'generation-1',
      processStartedAt,
      service: {} as PluginManagementService,
      managerRenderer: async () => {
        if (++count === 3) started()
        await new Promise(resolve => setTimeout(resolve, 61_000))
        return { status: 'ok' }
      },
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(paths))!
      const common = {
        kind: 'manager-renderer' as const,
        action: 'call' as const,
        gateway: { pid: process.pid, processStartedAt, instanceToken: 'a'.repeat(64) },
        browserSessionId: 'b'.repeat(64),
        handle: { rendererId: 'c'.repeat(64), ownerGeneration: 'generation-1', grant: 'd'.repeat(64) },
        channel: 'managed-service-ui',
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const observation = requestPluginManagementRpc(paths, endpoint, {
        ...common,
        payload: JSON.stringify({ operation: 'closed' }),
      })
      const mutation = requestPluginManagementRpc(paths, endpoint, {
        ...common,
        payload: JSON.stringify({ operation: 'logout' }),
      })
      const authentication = requestPluginManagementRpc(paths, endpoint, {
        ...common,
        payload: JSON.stringify({ operation: 'authenticate' }),
      })
      const rejected = expect(mutation).rejects.toThrow('plugin management request timed out')
      await bothStarted
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(observation).resolves.toEqual({ status: 'ok' })
      await expect(authentication).resolves.toEqual({ status: 'ok' })
    } finally {
      vi.useRealTimers()
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('awaits async responses over a bounded Unix socket path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-rpc-'))
    const homeDir = path.join(root, 'a'.repeat(140))
    const snapshot: PluginManagementSnapshot = {
      profileId: 'default',
      revision: 3,
      sources: [],
      hiddenCatalogEntries: [],
      migrations: { legacyBrowserSourcesV2: true },
      runtime: { kind: 'active', runtimeGeneration: 'generation-1' },
      activationRevision: 2,
      plugins: [],
    }
    const service = {
      query: async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return snapshot
      },
      close: () => {},
    } as unknown as PluginManagementService
    const processStartedAt = await processStartIdentity(process.pid)
    expect(processStartedAt).toBeDefined()
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      generation: 'generation-1',
      processStartedAt: processStartedAt!,
      service,
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      expect(Buffer.byteLength(paths.socket)).toBeLessThan(100)
      const endpoint = await readPluginManagementRpcEndpoint(paths)
      expect(endpoint).toBeDefined()
      await expect(requestPluginManagementRpc(paths, endpoint!, { kind: 'query' })).resolves.toEqual(snapshot)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
