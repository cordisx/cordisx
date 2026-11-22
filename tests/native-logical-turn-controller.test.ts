import { expect, it, vi } from 'vitest'
import { harness, pendingThread, threadAction, threadScope } from './fixtures/native-submission-controller-harness.js'

it('rechecks the live scope and source authority before allowing navigation', async () => {
  let live = true
  const migration = { canNavigate: vi.fn(async () => true) }
  const f = harness({ scope: threadScope, logicalMigration: migration as never, runtimeValid: () => live })
  expect(await f.controller.logicalSourceNavigation(threadScope, 'source')).toBe(true)
  expect(migration.canNavigate).toHaveBeenCalledTimes(2)
  migration.canNavigate.mockImplementationOnce(async () => {
    live = false
    return true
  })
  expect(await f.controller.logicalSourceNavigation(threadScope, 'source')).toBe(false)
  await f.controller.dispose()
})

it('issues a scoped logical turn ticket only for an unchanged, valid Desktop selection', async () => {
  const logicalTurns = {
    prepare: vi.fn(async () => ({ state: 'issued' as const, token: 'logical-ticket-0123456789' })),
    cancel: vi.fn(() => true),
    attach: vi.fn(async () => true),
    cancelAttached: vi.fn(),
    releaseScope: vi.fn(),
    dispose: vi.fn(),
  }
  const f = harness({ scope: threadScope, logicalTurns })
  expect(await f.controller.prepareSubmission(threadScope, threadAction)).toEqual({
    kind: 'allow-logical-turn',
    operationToken: 'logical-ticket-0123456789',
  })
  expect(await f.controller.cancel({ scope: threadScope, id: 'logical-ticket-0123456789' })).toBe(true)
  expect(logicalTurns.cancel).toHaveBeenCalledWith(threadScope, 'logical-ticket-0123456789')
  await f.controller.dispose()
})

it('requires the selected history consent before creating a logical destination', async () => {
  const logicalTurns = {
    prepare: vi.fn(async () => ({ state: 'not-needed' as const })),
    cancel: vi.fn(() => false),
    attach: vi.fn(async () => true),
    cancelAttached: vi.fn(),
    releaseScope: vi.fn(),
    dispose: vi.fn(),
  }
  const migration = {
    suggest: vi.fn(async () => ({ recommended: 'linked' as const, forkAvailable: false, linkedAvailable: true })),
    continue: vi.fn(async () => ({
      state: 'applied' as const,
      operationId: 'operation-thread',
      destination: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'destination' },
      navigationReady: true,
    })),
  }
  const f = harness({
    scope: threadScope,
    pending: pendingThread,
    logicalTurns,
    logicalMigration: migration,
    enableContinuation: true,
  })
  const action = { ...threadAction, continuationAvailable: true }
  const prepared = await f.controller.prepareSubmission(threadScope, action)
  expect(prepared).toMatchObject({ kind: 'confirm-logical', recommended: 'linked' })
  expect(migration.continue).not.toHaveBeenCalled()
  if (prepared.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  const result = await f.controller.confirmLogicalSubmission({
    scope: threadScope,
    confirmationId: prepared.confirmationId,
    expectedSelectionRevision: prepared.selectionRevision,
    mode: 'linked',
    historyConsent: 'on-demand',
    remember: 'conversation',
  })
  expect(result).toMatchObject({ kind: 'allow-logical-continuation', continuation: { threadId: 'destination' } })
  expect(migration.continue).toHaveBeenCalledOnce()
  expect(migration.continue).toHaveBeenCalledWith(expect.objectContaining({ remember: 'conversation' }))
  expect(logicalTurns.attach).toHaveBeenCalledOnce()
  await f.controller.dispose()
})

it('rejects mismatched consent without starting or falling back to a native migration', async () => {
  const logicalTurns = {
    prepare: vi.fn(async () => ({ state: 'not-needed' as const })),
    cancel: vi.fn(() => false),
    attach: vi.fn(async () => true),
    cancelAttached: vi.fn(),
    releaseScope: vi.fn(),
    dispose: vi.fn(),
  }
  const migration = {
    suggest: vi.fn(async () => ({ recommended: 'linked' as const, forkAvailable: false, linkedAvailable: true })),
    continue: vi.fn(),
  }
  const f = harness({
    scope: threadScope,
    pending: pendingThread,
    logicalTurns,
    logicalMigration: migration as never,
    enableContinuation: true,
  })
  const prepared = await f.controller.prepareSubmission(threadScope, { ...threadAction, continuationAvailable: true })
  if (prepared.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  expect(
    await f.controller.confirmLogicalSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
      mode: 'linked',
      historyConsent: 'none',
    }),
  ).toMatchObject({ kind: 'reject' })
  expect(migration.continue).not.toHaveBeenCalled()
  await f.controller.dispose()
})

it('requires the one-time Channel grant before starting a bound linked migration', async () => {
  const logicalTurns = {
    prepare: vi.fn(async () => ({ state: 'not-needed' as const })),
    cancel: vi.fn(() => false),
    attach: vi.fn(async () => true),
    cancelAttached: vi.fn(),
    releaseScope: vi.fn(),
    dispose: vi.fn(),
  }
  const migration = {
    suggest: vi.fn(async () => ({
      recommended: 'linked' as const,
      forkAvailable: false,
      linkedAvailable: true,
      channelBound: true,
      channelChallenge: 'A'.repeat(32),
    })),
    continue: vi.fn(async () => ({
      state: 'applied' as const,
      operationId: 'operation-thread',
      destination: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'destination' },
      navigationReady: true,
    })),
  }
  const f = harness({
    scope: threadScope,
    pending: pendingThread,
    logicalTurns,
    logicalMigration: migration as never,
    enableContinuation: true,
  })
  const prepare = () => f.controller.prepareSubmission(threadScope, { ...threadAction, continuationAvailable: true })
  const first = await prepare()
  if (first.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  expect(
    await f.controller.confirmLogicalSubmission({
      scope: threadScope,
      confirmationId: first.confirmationId,
      expectedSelectionRevision: first.selectionRevision,
      mode: 'linked',
      historyConsent: 'on-demand',
    }),
  ).toMatchObject({ kind: 'reject' })
  expect(migration.continue).not.toHaveBeenCalled()
  const second = await prepare()
  if (second.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  expect(
    await f.controller.confirmLogicalSubmission({
      scope: threadScope,
      confirmationId: second.confirmationId,
      expectedSelectionRevision: second.selectionRevision,
      mode: 'linked',
      historyConsent: 'on-demand',
      channelCode: 'B'.repeat(32),
    }),
  ).toMatchObject({ kind: 'reject' })
  expect(migration.continue).not.toHaveBeenCalled()
  const third = await prepare()
  if (third.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  expect(
    await f.controller.confirmLogicalSubmission({
      scope: threadScope,
      confirmationId: third.confirmationId,
      expectedSelectionRevision: third.selectionRevision,
      mode: 'linked',
      historyConsent: 'on-demand',
      channelCode: 'A'.repeat(32),
    }),
  )
    .toMatchObject({ kind: 'allow-logical-continuation' })
  expect(migration.continue).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'linked', channelCode: 'A'.repeat(32) }),
  )
  await f.controller.dispose()
})

it('requires reconciliation when the source changes after the destination commits', async () => {
  let current = true
  const logicalTurns = {
    prepare: vi.fn(async () => ({ state: 'not-needed' as const })),
    cancel: vi.fn(() => false),
    attach: vi.fn(async () => true),
    cancelAttached: vi.fn(),
    releaseScope: vi.fn(),
    dispose: vi.fn(),
  }
  const migration = {
    suggest: vi.fn(async () => ({ recommended: 'linked' as const, forkAvailable: false, linkedAvailable: true })),
    continue: vi.fn(async () => {
      current = false
      return {
        state: 'applied' as const,
        operationId: 'operation-thread',
        destination: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'destination' },
        navigationReady: true,
      }
    }),
  }
  const f = harness({
    scope: threadScope,
    pending: pendingThread,
    logicalTurns,
    logicalMigration: migration,
    enableContinuation: true,
    runtimeValid: () => current,
  })
  const prepared = await f.controller.prepareSubmission(threadScope, { ...threadAction, continuationAvailable: true })
  if (prepared.kind !== 'confirm-logical') throw new Error('confirmation unavailable')
  expect(
    await f.controller.confirmLogicalSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
      mode: 'linked',
      historyConsent: 'on-demand',
    }),
  ).toEqual({ kind: 'reject', reason: 'provider-switch-reconciliation-required' })
  expect(migration.continue).toHaveBeenCalledOnce()
  expect(logicalTurns.attach).not.toHaveBeenCalled()
  await f.controller.dispose()
})
