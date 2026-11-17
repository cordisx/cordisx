import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { continuationDefaultsOperation } from '../packages/cli/src/launcher/channel-continuation-defaults.js'

describe('Channel continuation profile defaults', () => {
  it('starts disabled at 90%, validates the 95% cap and uses a revision fence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-cont-defaults-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      expect(await continuationDefaultsOperation(store, 'continuation-defaults', {})).toEqual({
        status: 'ok',
        revision: 0,
        policy: { enabled: false, thresholdRatio: 0.9 },
      })
      await expect(continuationDefaultsOperation(store, 'continuation-defaults-set', {
        expectedRevision: 0,
        policy: { enabled: true, thresholdRatio: 0.99 },
      })).rejects.toThrow('INVALID_CONTINUATION_DEFAULTS')
      expect(
        await continuationDefaultsOperation(store, 'continuation-defaults-set', {
          expectedRevision: 0,
          policy: { enabled: true, thresholdRatio: 0.0001 },
        }),
      ).toMatchObject({ status: 'ok', revision: 1 })
      await expect(continuationDefaultsOperation(store, 'continuation-defaults-set', {
        expectedRevision: 0,
        policy: { enabled: true, thresholdRatio: 0.95 },
      })).rejects.toThrow('REVISION_CONFLICT')
      const reopened = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      expect((await continuationDefaultsOperation(reopened, 'continuation-defaults', {})).policy)
        .toEqual({ enabled: true, thresholdRatio: 0.0001 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
