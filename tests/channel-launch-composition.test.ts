import { describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRendererChannelComposition } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { createConfiguredChannelConsumer } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { configuredLaunchCleanup } from '../packages/cli/src/cli/channel-consumer-composition.js'

describe('configured Channel launch cleanup', () => {
  it('attempts all owned cleanups once even when credential cleanup fails', async () => {
    const order: string[] = []
    const dispose = configuredLaunchCleanup({
      documents: {
        walletSpend: {
          dispose: () => {
            order.push('wallet')
          },
        },
        http: {
          dispose: async () => {
            order.push('http')
          },
        },
        agentTools: {
          close: async () => {
            order.push('tools')
          },
        },
      } as never,
      credentials: {
        token: 'test',
        handle: vi.fn(),
        dispose: async () => {
          order.push('credentials')
          throw new Error('cleanup')
        },
      },
      channel: async () => {
        order.push('channel')
      },
      providers: async () => {
        order.push('providers')
      },
    })
    await expect(dispose()).rejects.toThrow('Configured launch cleanup failed')
    await expect(dispose()).rejects.toThrow('Configured launch cleanup failed')
    expect(order).toEqual(['wallet', 'http', 'tools', 'credentials', 'channel', 'providers'])
  })
})

describe('Channel dry-run boundary', () => {
  it('does not create a profile runtime or start a configured transport while planning', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'channel-dry-run-'))
    try {
      const composition = await createRendererChannelComposition({
        composition: {
          plugins: [{ id: 'channel', enabled: true, entry: path.join(homeDir, 'unopened-channel.js') }],
        } as never,
        homeDir,
        configPath: path.join(homeDir, 'unopened-config.json'),
        appId: 'codex',
        profileId: 'work',
        environment: {},
        dryRun: true,
      })
      const configured = await createConfiguredChannelConsumer({
        service: composition.service,
        homeDir,
        appId: 'codex',
        profileId: 'work',
        native: () => undefined,
        report: vi.fn(),
      })
      expect(composition.service).toBeUndefined()
      expect(configured.consumer).toBeUndefined()
      expect(await composition.loadManagerProjection()).toBeUndefined()
      await configured.dispose()
      await expect(access(path.join(homeDir, 'apps', 'codex', 'profiles', 'work'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
