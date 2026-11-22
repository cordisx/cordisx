import { describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRendererChannelComposition } from '../packages/cli/src/cli/renderer-channel-composition.js'
import {
  createConfiguredChannelConsumer,
  createDesktopChannelConsumer,
} from '../packages/cli/src/cli/channel-consumer-composition.js'
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
        generation: 'runtime-owner',
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

  it('opens the profile logical owner without starting a Channel consumer when explicitly requested', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'logical-owner-'))
    const native = vi.fn()
    const input = {
      service: undefined,
      homeDir,
      appId: 'codex',
      profileId: 'work',
      logicalRuntime: true,
      native,
      report: vi.fn(),
    }
    try {
      const first = await createConfiguredChannelConsumer(input)
      expect(first.consumer).toBeUndefined()
      const owner = first.logicalOwner!
      expect(await first.tools.callLocal('logical-mode-default-set', { mode: 'fresh', expectedRevision: 0 }, {}))
        .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
      expect(await first.tools.callLocal('logical-mode-default-set', { mode: 'fresh', expectedRevision: 0 }))
        .toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
      expect(await first.tools.callLocal('logical-mode-default-set', { mode: 'fork', expectedRevision: 0 }))
        .toMatchObject({ status: 'ok', preference: { mode: 'fork' } })
      const choice = await first.tools.callLocal('logical-mode-conversation', { sessionId: 'source' }) as {
        conversationId: string
      }
      expect(
        await first.tools.callLocal('logical-mode-conversation-set', {
          sessionId: 'source',
          mode: 'linked',
          expectedRevision: 0,
          expectedConversationId: 'changed',
        }),
      ).toMatchObject({ status: 'rejected', code: 'CONVERSATION_IDENTITY_CHANGED' })
      expect(
        await first.tools.callLocal('logical-mode-conversation-set', {
          sessionId: 'source',
          mode: 'linked',
          expectedRevision: 0,
          expectedConversationId: choice.conversationId,
        }),
      ).toMatchObject({ status: 'ok', revision: 1, preference: { mode: 'linked' } })
      expect(
        await first.tools.callLocal('logical-mode-conversation-set', {
          sessionId: 'source',
          mode: 'fork',
          expectedRevision: 0,
          expectedConversationId: choice.conversationId,
        }),
      ).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' })
      expect(await first.tools.callLocal('logical-mode-conversation', { sessionId: 'source' }, {}))
        .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
      await owner.store.mutate(state => {
        state.inputCursor = 'fixture-cursor'
      })
      const release = owner.fence.beginMigration('source')!
      expect(() => owner.fence.enterNative('turn/start', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
      release()
      await first.dispose()
      const reopened = await createConfiguredChannelConsumer(input)
      expect(reopened.logicalOwner!.store.snapshot().inputCursor).toBe('fixture-cursor')
      expect(await reopened.tools.callLocal('logical-mode-default', {}))
        .toMatchObject({ status: 'ok', preference: { mode: 'fork' } })
      expect(await reopened.tools.callLocal('logical-mode-conversation', { sessionId: 'source' }))
        .toMatchObject({ status: 'ok', revision: 1, preference: { mode: 'linked' } })
      expect(
        await reopened.tools.callLocal('logical-mode-conversation-set', {
          sessionId: 'source',
          mode: null,
          expectedRevision: 1,
          expectedConversationId: choice.conversationId,
        }),
      ).toMatchObject({ status: 'ok', revision: 2, preference: null })
      expect(await reopened.tools.callLocal('logical-mode-conversation', { sessionId: 'source' }))
        .toMatchObject({ status: 'ok', revision: 2, preference: { mode: 'fork' } })
      expect(native).not.toHaveBeenCalled()
      await reopened.dispose()
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
  it('passes the same optional profile owner to the Desktop bootstrap', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-owner-'))
    const bind = vi.fn()
    try {
      const configured = await createDesktopChannelConsumer({
        service: undefined,
        homeDir,
        appId: 'codex',
        profileId: 'work',
        logicalRecovery: true,
        nativeBootstrap: { bindLogicalFenceOwner: bind } as never,
        native: () => undefined,
        report: vi.fn(),
      })
      expect(bind).toHaveBeenCalledOnce()
      expect(bind).toHaveBeenCalledWith(configured.logicalOwner)
      expect(configured.consumer).toBeUndefined()
      expect(await configured.tools.callLocal('logical-mode-default', {}))
        .toMatchObject({ status: 'rejected', code: 'LOGICAL_RECOVERY_UNAVAILABLE' })
      await configured.logicalOwner!.store.bindCommitBarrier(async () => {})
      expect(await configured.tools.callLocal('logical-mode-default-set', { mode: 'linked', expectedRevision: 0 }))
        .toMatchObject({ status: 'ok', preference: { mode: 'linked' } })
      await configured.dispose()
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
