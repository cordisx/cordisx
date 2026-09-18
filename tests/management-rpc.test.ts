import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
