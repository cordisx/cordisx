import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { connectExistingTerminalProvider } from '../packages/cli/src/launcher/existing-terminal-provider-rpc.js'
import {
  pluginManagementRpcPaths,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

describe('terminal owner discovery', () => {
  it('refuses multiple owners even with an explicit namespace, and pins the surviving exact owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-terminal-discovery-'))
    const start = async (appId: string) =>
      await startPluginManagementRpcServer({
        homeDir: root,
        appId,
        profileId: 'default',
        configPath: path.join(root, 'config.json'),
        generation: `generation-${appId}`,
        processStartedAt: (await processStartIdentity(process.pid))!,
        service: {} as PluginManagementService,
        terminalProvider: async () => ({ kind: 'list', providers: [] }),
      })
    const first = await start('codex')
    const second = await start('future-adapter')
    const source = { homeDir: root, profileId: 'default', appIds: ['codex', 'future-adapter'] }
    try {
      await expect(connectExistingTerminalProvider(source)).rejects.toThrow('More than one CordisX owner')
      await expect(connectExistingTerminalProvider({ ...source, selectedAppId: 'codex' })).rejects.toThrow(
        'More than one CordisX owner',
      )
      await first.close()
      const request = await connectExistingTerminalProvider({ ...source, selectedAppId: 'future-adapter' })
      expect(await request({ kind: 'list' })).toEqual({ kind: 'list', providers: [] })
      await expect(connectExistingTerminalProvider({ ...source, selectedAppId: 'codex' })).rejects.toThrow(
        'unavailable',
      )
      await expect(connectExistingTerminalProvider({ ...source, profileId: 'other' })).rejects.toThrow('unavailable')
      const paths = pluginManagementRpcPaths(root, 'future-adapter', 'default')
      await writeFile(paths.state, '{"invalid":true}', { mode: 0o600 })
      await expect(request({ kind: 'list' })).rejects.toThrow('could not be verified')
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
