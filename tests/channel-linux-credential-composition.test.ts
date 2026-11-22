import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createChannelLaunchBridges } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { CHANNEL_SERVICE_CONFIG_INITIAL } from '../packages/cli/src/launcher/channel-service.js'
import { resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'

describe.skipIf(process.platform === 'win32')('Linux credential production bridge assembly', () => {
  it('uses the selected config home and persists a resolver-ready credential through the real service config API', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'channel-linux-composition-'))
    const configPath = path.join(homeDir, 'config.json')
    const plugin = { id: 'channel', entry: '/fixture/channel/index.js', source: 'file:///fixture/channel' }
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        apps: { codex: { defaultProfile: 'work', profiles: { work: { displayName: 'Work', dataMode: 'shared' } } } },
        plugins: [{
          id: plugin.id,
          entry: plugin.entry,
          services: {
            runtime: {
              profiles: {
                work: { revision: 0, lastGoodRevision: 0, config: CHANNEL_SERVICE_CONFIG_INITIAL },
              },
            },
          },
        }],
      }),
    )
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    let bridges: ReturnType<typeof createChannelLaunchBridges> | undefined
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
      bridges = createChannelLaunchBridges({
        channel: {
          plugin,
          service: {
            restart: async () => ({ generation: 'next', rollback: async () => {}, finalize: async () => {} }),
          } as never,
          credentialBridgeToken: 'c'.repeat(64),
          loadManagerProjection: async () => undefined,
        },
        token: 'a'.repeat(64),
        profileId: 'work',
        generation: 'test',
        configPath,
        consumer: undefined,
      })
      Object.defineProperty(process, 'platform', platform)
      const descriptor = await bridges.configApi!.descriptor()
      const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' }
      const result = await bridges.credentials!.handle({
        version: 1,
        token: bridges.credentials!.token,
        requestId: 'save-linux',
        account,
        secret: 'production-test-secret',
        mutation: {
          contract: 'cordisx.service-config-mutation/v1',
          schemaVersion: 1,
          identity: descriptor.identity,
          scope: descriptor.scope,
          expectedRevision: descriptor.revision,
          configuration: {
            ...descriptor.configuration as object,
            connections: [{ ref: account, adapterKind: 'feishu', enabled: false, transport: { mode: 'websocket' } }],
          },
        },
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' })
      expect(JSON.stringify(result)).not.toMatch(/production-test-secret|host-secret/)
      const stored = JSON.parse(await readFile(configPath, 'utf8'))
      const reference = stored.plugins[0].services.runtime.profiles.work.config.connections[0].secretRef
      expect(reference).toMatch(/^host-secret:channel\/work\//)
      expect(await readFile(configPath, 'utf8')).not.toContain('production-test-secret')
      await expect(resolveLauncherSecret(reference, { homeDir, platform: 'linux' }))
        .resolves.toBe('production-test-secret')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      await bridges?.credentials?.dispose?.()
      await bridges?.configApi?.dispose?.()
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
