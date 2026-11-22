import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { startDesktopLogicalContinuation } from '../packages/cli/src/launcher/desktop-logical-continuation.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'
import { abandonDesktopLogicalContinuation } from '../packages/cli/src/launcher/desktop-logical-abandon.js'
import { logicalContinuationStatus } from '../packages/cli/src/launcher/logical-continuation-status.js'
import type { LogicalContinuationRequest } from '../packages/cli/src/launcher/logical-continuation-control.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import {
  resolveLogicalContinuationPreference,
  setLogicalContinuationPreference,
} from '../packages/cli/src/launcher/logical-continuation-preferences.js'

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  await store.bindCommitBarrier(async () => {})
  const owner = profileLogicalConversationOwner(store)
  const source = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'source' }
  const request: LogicalContinuationRequest = {
    contract: 'cordisx.conversation-continuation-request/v1',
    operationId: 'operation',
    logicalConversationId: 'conversation',
    source,
    expectedRevision: 0,
    target: { providerId: 'new', model: 'model' },
    mode: 'linked',
    historyConsent: 'on-demand',
    handoffConsent: 'none',
    historyCategories: ['user-text'],
  }
  const config = {
    providerId: 'old',
    model: 'old',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
    execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
  }
  const control = {
    acquireLogicalFence: vi.fn(async () => 'source-lease'),
    releaseLogicalFence: vi.fn(async () => true),
    createFencedLogicalDestination: vi.fn(async () => ({
      result: { thread: { id: 'destination' } },
      destinationLease: 'target-lease',
    })),
    nativeRequest: vi.fn(async () => ({})),
  }
  const native = {
    continuationConfiguration: vi.fn(async () => config),
    logicalSourceVersion: vi.fn(async () => 'version'),
    supportsLogicalFork: () => true,
    createLogicalDestination: vi.fn(
      async (
        current: LogicalContinuationRequest,
        _evidence: unknown,
        fence: typeof owner.fence,
        _available: unknown,
        nativeRequest: (method: 'thread/start', params: {}) => Promise<unknown>,
      ) => {
        await nativeRequest('thread/start', {})
        return {
          state: 'created' as const,
          confirmed: true,
          destination: { ...current.source, sessionId: 'destination' },
          releaseTarget: fence.beginMigration('destination')!,
        }
      },
    ),
  }
  const authority = {
    identity: vi.fn(async () => 'desktop:fixture'),
    current: vi.fn(() => true),
    targetAllowed: vi.fn(async () => true),
    linkedHistoryReady: true,
  }
  const input = {
    owner,
    request,
    appId: 'codex',
    profileId: 'fixture',
    authority,
    control: control as never,
    native: native as never,
  }
  return {
    dir,
    store,
    owner,
    request,
    native,
    authority,
    control,
    input,
    async close() {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

it('commits an authorized Desktop continuation through the shared Host transaction', async () => {
  const f = await fixture()
  try {
    const result = await startDesktopLogicalContinuation(f.input)
    expect(result).toMatchObject({ state: 'applied', navigationReady: true, destination: { sessionId: 'destination' } })
    const state = f.store.snapshot().logicalContinuations!
    expect(state.relations.operation).toMatchObject({ mode: 'linked', source: { sessionId: 'source' } })
    expect(f.control.createFencedLogicalDestination).toHaveBeenCalledOnce()
    expect(f.owner.fence.isMigrating('source')).toBe(false)
    expect(f.owner.fence.isMigrating('destination')).toBe(false)
  } finally {
    await f.close()
  }
})

it('preserves source settings while recording and applying the selected target effort', async () => {
  const f = await fixture()
  try {
    const authority = {
      ...f.authority,
      targetReasoningEffort: 'high' as const,
      configuredProviderOverrides: { model_reasoning_effort: 'high' },
    }
    const input = { ...f.input, authority }
    expect(await startDesktopLogicalContinuation(input)).toMatchObject({ state: 'applied' })
    expect(f.store.snapshot().logicalContinuations?.intents.operation?.evidence).toMatchObject({
      sourceConfiguration: { execution: { effort: 'low' } },
      targetReasoningEffort: 'high',
    })
    expect(f.native.createLogicalDestination.mock.calls[0]?.[1]).toMatchObject({
      sourceConfiguration: { execution: { effort: 'high' } },
      targetReasoningEffort: 'high',
    })
    expect(f.authority.targetAllowed).toHaveBeenCalledWith('new', 'model', 'high')
    expect(await startDesktopLogicalContinuation(input)).toMatchObject({ state: 'applied', navigationReady: false })
    expect(
      await startDesktopLogicalContinuation({
        ...input,
        authority: {
          ...authority,
          targetReasoningEffort: 'medium',
          configuredProviderOverrides: { model_reasoning_effort: 'medium' },
        },
      }),
    ).toMatchObject({ state: 'rejected', code: 'OPERATION_ID_CONFLICT' })
    expect(f.control.createFencedLogicalDestination).toHaveBeenCalledOnce()
    await f.store.close()
    const reopened = await ChannelConversationStore.open(path.join(f.dir, 'state.json'))
    try {
      expect(reopened.snapshot().logicalContinuations?.intents.operation?.evidence).toMatchObject({
        sourceConfiguration: { execution: { effort: 'low' } },
        targetReasoningEffort: 'high',
      })
    } finally {
      await reopened.close()
    }
  } finally {
    await f.close()
  }
})

it('does not create a target when its selected effort becomes unavailable during preflight', async () => {
  const f = await fixture()
  try {
    f.authority.targetAllowed.mockResolvedValueOnce(true).mockResolvedValue(false)
    expect(
      await startDesktopLogicalContinuation({
        ...f.input,
        authority: { ...f.authority, targetReasoningEffort: 'high' },
      }),
    ).toMatchObject({ state: 'rejected', code: 'PREFLIGHT_UNAVAILABLE' })
    expect(f.control.createFencedLogicalDestination).not.toHaveBeenCalled()
    expect(f.store.snapshot().logicalContinuations?.intents.operation).toBeUndefined()
  } finally {
    await f.close()
  }
})

it.each(['profile', 'conversation'] as const)(
  'commits the %s mode with the destination, without saving consent',
  async scope => {
    const f = await fixture()
    try {
      const result = await startDesktopLogicalContinuation({ ...f.input, preference: { scope, expectedRevision: 0 } })
      expect(result.state).toBe('applied')
      const logical = f.store.snapshot().logicalContinuations!
      expect(resolveLogicalContinuationPreference(logical, { profileId: 'fixture', conversationId: 'conversation' }))
        .toMatchObject({ mode: 'linked', scope: { kind: scope } })
      expect(logical.relations.operation).toMatchObject({ mode: 'linked', historyAccess: 'on-demand' })
    } finally {
      await f.close()
    }
  },
)

it('does not overwrite a preference changed while the destination is being created', async () => {
  const f = await fixture()
  try {
    const create = f.native.createLogicalDestination.getMockImplementation()!
    f.native.createLogicalDestination.mockImplementationOnce(async (...args) => {
      const result = await create(...args)
      await channelLogicalTransactionStore(f.store).mutate(state => {
        setLogicalContinuationPreference(state.logicalContinuations!, { kind: 'profile', id: 'fixture' }, 'fork', 0)
      })
      return result
    })
    expect(await startDesktopLogicalContinuation({ ...f.input, preference: { scope: 'profile', expectedRevision: 0 } }))
      .toMatchObject({ state: 'unknown' })
    const logical = f.store.snapshot().logicalContinuations!
    expect(resolveLogicalContinuationPreference(logical, { profileId: 'fixture' })?.mode).toBe('fork')
    expect(logical.relations.operation).toBeUndefined()
  } finally {
    await f.close()
  }
})

it('clears a conversation override atomically so future choices inherit the profile default', async () => {
  const f = await fixture()
  try {
    await channelLogicalTransactionStore(f.store).mutate(state => {
      setLogicalContinuationPreference(state.logicalContinuations!, { kind: 'profile', id: 'fixture' }, 'fork', 0)
      setLogicalContinuationPreference(
        state.logicalContinuations!,
        { kind: 'conversation', id: 'conversation' },
        'linked',
        0,
      )
    })
    expect(
      await startDesktopLogicalContinuation({
        ...f.input,
        preference: { scope: 'conversation', expectedRevision: 1, clear: true },
      }),
    ).toMatchObject({ state: 'applied' })
    expect(resolveLogicalContinuationPreference(f.store.snapshot().logicalContinuations!, {
      profileId: 'fixture',
      conversationId: 'conversation',
    })).toMatchObject({ mode: 'fork', scope: { kind: 'profile' } })
  } finally {
    await f.close()
  }
})

it('persists a conversation choice from an empty store and suggests it on the destination', async () => {
  const f = await fixture()
  try {
    const identity = vi.fn(async () => 'desktop:fixture')
    const migration = desktopLogicalMigration({
      owner: f.owner,
      control: f.control as never,
      native: () => f.native as never,
      profileId: 'fixture',
      identity,
      targetAllowed: async () => true,
      historyReady: () => true,
    })
    const scope = { targetId: 'window', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: 'source' }
    const target = { providerId: 'new', model: 'model' }
    const result = await migration.continue({
      scope,
      target,
      operationId: 'operation',
      mode: 'linked',
      remember: 'conversation',
      current: () => true,
      configOverrides: {},
    })
    expect(result).toMatchObject({ state: 'applied', navigationReady: true })
    expect(await migration.suggest({ ...scope, threadId: 'destination' }, target)).toMatchObject({
      recommended: 'linked',
      chain: { links: [{ source: 'source', destination: 'destination', mode: 'linked' }], truncated: false },
    })
    expect(await migration.canNavigate({ ...scope, threadId: 'destination' }, 'source')).toBe(true)
    expect(await migration.canNavigate({ ...scope, threadId: 'destination' }, 'unrelated')).toBe(false)
    identity.mockResolvedValueOnce('desktop:fixture').mockResolvedValueOnce('other')
    expect(await migration.canNavigate({ ...scope, threadId: 'destination' }, 'source')).toBe(false)
  } finally {
    await f.close()
  }
})

it('fails closed on account change or an unavailable linked history authority', async () => {
  const f = await fixture()
  try {
    f.authority.identity.mockResolvedValueOnce('desktop:fixture').mockResolvedValue('desktop:other')
    expect(await startDesktopLogicalContinuation(f.input)).toMatchObject({ state: 'rejected' })
    expect(f.control.createFencedLogicalDestination).not.toHaveBeenCalled()
    const linked = {
      ...f.request,
      mode: 'linked',
      historyConsent: 'on-demand',
      handoffConsent: 'none',
      historyCategories: ['user-text'],
    } as LogicalContinuationRequest
    expect(
      await startDesktopLogicalContinuation({
        ...f.input,
        request: linked,
        authority: { ...f.authority, linkedHistoryReady: false },
      }),
    ).toMatchObject({
      state: 'rejected',
      code: 'DESKTOP_AUTHORITY_UNAVAILABLE',
    })
  } finally {
    await f.close()
  }
})

it('persists an uncertain creation and retains both source protections', async () => {
  const f = await fixture()
  try {
    f.control.createFencedLogicalDestination.mockRejectedValueOnce(new Error('timeout'))
    expect(await startDesktopLogicalContinuation(f.input)).toMatchObject({ state: 'unknown' })
    expect(f.store.snapshot().logicalContinuations?.intents.operation?.state).toBe('unknown')
    const status = logicalContinuationStatus(f.store, 'codex', 'fixture', { sessionId: 'source' })
    expect(status).toMatchObject({ status: 'ok', operations: [{ operationId: 'operation', state: 'unknown' }] })
    expect(JSON.stringify(status)).not.toContain('desktop:fixture')
    expect(logicalContinuationStatus(f.store, 'codex', 'other', { sessionId: 'source' }).operations).toEqual([])
    expect(
      logicalContinuationStatus(f.store, 'codex', 'fixture', {
        sessionId: 'source',
        operationId: 'another',
      }).operations,
    ).toEqual([])
    expect(() =>
      logicalContinuationStatus(f.store, 'codex', 'fixture', {
        sessionId: 'source',
        history: true,
      })
    ).toThrow('INVALID_REQUEST')
    expect(f.owner.fence.isMigrating('source')).toBe(true)
    expect(f.control.releaseLogicalFence).not.toHaveBeenCalled()
    await expect(abandonDesktopLogicalContinuation(f.owner, 'codex', 'fixture', {
      sessionId: 'source',
      operationId: 'operation',
      confirmOrphanPossible: true,
    })).rejects.toThrow('LOGICAL_RECOVERY_BUSY')
  } finally {
    await f.close()
  }
})

it('does not abandon an intent that changes while the native owner is checked', async () => {
  const f = await fixture()
  try {
    f.control.createFencedLogicalDestination.mockRejectedValueOnce(new Error('timeout'))
    expect((await startDesktopLogicalContinuation(f.input)).state).toBe('unknown')
    await f.store.close()
    const store = await ChannelConversationStore.open(path.join(f.dir, 'state.json'))
    await store.bindCommitBarrier(async () => {})
    const owner = profileLogicalConversationOwner(store)
    owner.bindRecoveryProbe(async () => {
      await channelLogicalTransactionStore(store).mutate(state => {
        state.logicalContinuations!.intents.operation!.code = 'CHANGED'
      })
      return true
    })
    try {
      await expect(abandonDesktopLogicalContinuation(owner, 'codex', 'fixture', {
        sessionId: 'source',
        operationId: 'operation',
        confirmOrphanPossible: true,
      })).rejects.toThrow('OPERATION_CHANGED')
      expect(store.snapshot().logicalContinuations?.intents.operation).toMatchObject({
        state: 'unknown',
        code: 'CHANGED',
      })
    } finally {
      await store.close()
    }
  } finally {
    await f.close()
  }
})
