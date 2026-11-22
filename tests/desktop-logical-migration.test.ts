import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'
import { setLogicalContinuationPreference } from '../packages/cli/src/launcher/logical-continuation-preferences.js'
import { channelLogicalConversationPreference } from '../packages/cli/src/launcher/channel-logical-preferences.js'

it('recommends fork only when compatible and applies the saved profile mode without granting history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-preference-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  await store.bindCommitBarrier(async () => {})
  const owner = profileLogicalConversationOwner(store)
  const scope = { targetId: 'target', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: 'source' }
  const native = {
    continuationConfiguration: async () => ({ providerId: 'old', model: 'model' }),
    supportsLogicalFork: () => true,
  }
  const identity = vi.fn(async () => 'account')
  const migration = desktopLogicalMigration({
    owner,
    control: {} as never,
    native: () => native as never,
    profileId: 'profile',
    identity,
    targetAllowed: async () => true,
    historyReady: () => true,
  })
  try {
    expect(await migration.suggest(scope, { providerId: 'old', model: 'model' })).toMatchObject({
      recommended: 'fork',
      forkAvailable: true,
      linkedAvailable: true,
    })
    expect(await migration.suggest(scope, { providerId: 'new', model: 'model' })).toMatchObject({
      recommended: 'linked',
      forkAvailable: false,
    })
    await channelLogicalTransactionStore(store).mutate(state => {
      const logical = state.logicalContinuations!, savedScope = { kind: 'profile' as const, id: 'profile' }
      const key = JSON.stringify([savedScope.kind, savedScope.id])
      logical.preferences = {
        [key]: {
          contract: 'cordisx.conversation-continuation-preference/v1',
          revision: 1,
          scope: savedScope,
          mode: 'fresh',
        },
      }
      logical.preferenceRevisions = { [key]: 1 }
    })
    expect(await migration.suggest(scope, { providerId: 'old', model: 'model' })).toMatchObject({
      recommended: 'linked',
      legacyFreshPreference: true,
    })
    const choice = await channelLogicalConversationPreference(store, 'codex', 'profile', 'logical-mode-conversation', {
      sessionId: 'source',
    })
    expect(choice).toMatchObject({ legacyFreshRequiresReselection: true, preference: { mode: 'fresh' } })
    await channelLogicalConversationPreference(store, 'codex', 'profile', 'logical-mode-conversation-set', {
      sessionId: 'source',
      mode: 'linked',
      expectedRevision: 0,
      expectedConversationId: choice.conversationId,
    })
    expect(await migration.suggest(scope, { providerId: 'old', model: 'model' })).toMatchObject({
      recommended: 'linked',
    })
    identity.mockResolvedValueOnce('account').mockResolvedValueOnce('another-account')
    expect(await migration.suggest(scope, { providerId: 'old', model: 'model' })).toBeUndefined()
    identity.mockResolvedValueOnce('account').mockImplementationOnce(async () => {
      await channelLogicalTransactionStore(store).mutate(state => {
        setLogicalContinuationPreference(state.logicalContinuations!, { kind: 'profile', id: 'profile' }, 'linked', 1)
      })
      return 'account'
    })
    expect(await migration.suggest(scope, { providerId: 'old', model: 'model' })).toBeUndefined()
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('does not save an override if the logical identity changes after it was read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-revision-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  try {
    const source = { hostId: 'local', appId: 'codex', profileId: 'profile', sessionId: 'source' }
    const choice = await channelLogicalConversationPreference(store, 'codex', 'profile', 'logical-mode-conversation', {
      sessionId: 'source',
    })
    const legacy = 'desktop:' + createHash('sha256').update(JSON.stringify(source)).digest('hex')
    await channelLogicalTransactionStore(store).mutate(state => {
      setLogicalContinuationPreference(state.logicalContinuations!, { kind: 'conversation', id: legacy }, 'linked', 0)
    })
    await expect(channelLogicalConversationPreference(store, 'codex', 'profile', 'logical-mode-conversation-set', {
      sessionId: 'source',
      mode: 'linked',
      expectedRevision: 0,
      expectedConversationId: choice.conversationId,
    })).rejects.toThrow('CONVERSATION_IDENTITY_CHANGED')
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
