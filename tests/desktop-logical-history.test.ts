import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { LogicalContinuationControl } from '../packages/cli/src/launcher/logical-continuation-control.js'
import { createDesktopLogicalHistory } from '../packages/cli/src/launcher/desktop-logical-history.js'
import { DesktopLogicalTurnAuthority } from '../packages/cli/src/launcher/desktop-logical-turn-authority.js'
import { desktopLogicalTurnPreparation } from '../packages/cli/src/launcher/desktop-logical-turn-preparation.js'
import { createDesktopLogicalComposition } from '../packages/cli/src/launcher/desktop-logical-composition.js'

it('rechecks the Desktop turn and identity around the authorized history read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-history-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  try {
    await store.bindCommitBarrier(async () => {})
    const source = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'source' }
    const destination = { ...source, sessionId: 'destination' }
    const actor = { principal: 'desktop:fixture', scope: 'desktop:codex:fixture' }
    const engine = new LogicalContinuationControl(channelLogicalTransactionStore(store), {
      state: root => root.logicalContinuations!,
      admitted: () => true,
      bind: () => true,
      preflight: async () => ({
        sourceHistoryVersion: 'version',
        handoff: 'none' as const,
        sourceConfiguration: {
          providerId: 'old',
          model: 'old',
          cwd: '/workspace',
          serviceTier: null,
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly' },
          permissionProfile: null,
          execution: {
            workMode: 'default' as const,
            approval: 'on-request' as const,
            effort: 'low',
            execution: 'read-only' as const,
          },
        },
      }),
      create: async () => ({ state: 'created' as const, destination }),
      confirm: async () => true,
    })
    expect(
      (await engine.start(actor, {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'operation',
        logicalConversationId: 'conversation',
        source,
        expectedRevision: 0,
        target: { providerId: 'new', model: 'new' },
        mode: 'linked',
        historyConsent: 'on-demand',
        handoffConsent: 'none',
        historyCategories: ['user-text'],
      })).state,
    ).toBe('applied')
    const native = {
      logicalTurnActive: vi.fn(async () => true),
      logicalSourceVersion: vi.fn(async () => 'version'),
      logicalContextTokens: () => [],
      logicalHistoryPage: vi.fn(async () => ({
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'PAPERKITE' }] }],
      })),
    }
    const activeIdentity = vi.fn(async () => 'desktop:fixture')
    const handler = createDesktopLogicalHistory({
      owner: profileLogicalConversationOwner(store),
      native: native as never,
      appId: 'codex',
      profileId: 'fixture',
      activeIdentity,
    })
    const call = {
      threadId: 'destination',
      turnId: 'turn',
      callId: 'call',
      tool: 'cordisx_continuation_history',
      arguments: {},
    }
    const result = await handler(call)
    expect(result.success).toBe(true)
    expect(result.contentItems[0]!.text).toContain('PAPERKITE')
    const scope = {
      targetId: 'window',
      rendererGeneration: 'generation',
      navigationGeneration: 1,
      composerId: 'composer',
      threadId: destination.sessionId,
    }
    const turns = new DesktopLogicalTurnAuthority(async () => 'desktop:fixture')
    const preparation = desktopLogicalTurnPreparation({
      owner: profileLogicalConversationOwner(store),
      turns,
      identity: async () => 'desktop:fixture',
      appId: 'codex',
      profileId: 'fixture',
    })
    const ticket = await preparation.prepare(scope)
    expect(ticket.state).toBe('issued')
    if (ticket.state === 'issued') expect(preparation.cancel(scope, ticket.token)).toBe(true)
    const sourceScope = { ...scope, threadId: 'source' }
    const attached = 'provider-operation-ticket-0123456789'
    expect(await preparation.attach(sourceScope, 'destination', attached)).toBe(true)
    expect(turns.attached(attached)).toBe(true)
    expect(preparation.cancel(sourceScope, attached)).toBe(false)
    preparation.cancelAttached(attached)
    let boundTurns: DesktopLogicalTurnAuthority | undefined
    let boundHistory: ((params: unknown) => Promise<unknown>) | undefined
    const composition = createDesktopLogicalComposition({
      owner: profileLogicalConversationOwner(store),
      profileId: 'fixture',
      identity: async () => 'desktop:fixture',
      control: {
        bindLogicalTurns: (value: DesktopLogicalTurnAuthority) => {
          boundTurns = value
        },
        bindLogicalHistory: (value: (params: unknown) => Promise<unknown>) => {
          boundHistory = value
        },
      } as never,
    })
    composition.bindNative(native as never)
    const prepared = await composition.preparation!.prepare(scope)
    expect(prepared.state).toBe('issued')
    if (prepared.state !== 'issued') throw new Error('ticket unavailable')
    expect(await boundTurns!.begin(prepared.token, 'destination', 'request')).toBe(true)
    boundTurns!.observe('turn/started', { threadId: 'destination', turn: { id: 'turn' } })
    expect(boundTurns!.confirm(prepared.token, 'destination', 'turn', 'request')).toBe(true)
    expect(await boundHistory!(call)).toMatchObject({ success: true })
    store.pauseCommitBarrier()
    expect(await preparation.prepare(scope)).toEqual({ state: 'unavailable' })
    await store.resumeCommitBarrier()
    activeIdentity.mockResolvedValue('desktop:other')
    expect((await handler(call)).success).toBe(false)
    activeIdentity.mockResolvedValue('desktop:fixture')
    native.logicalSourceVersion.mockResolvedValue('changed')
    expect((await handler(call)).success).toBe(false)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
