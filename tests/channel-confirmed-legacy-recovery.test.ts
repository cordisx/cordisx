import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { a, channel, fixture, message } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import {
  ChatExecutionPreferences,
  type ChatExecutionRecord,
} from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { recoverConfirmedChannelProvider } from '../packages/cli/src/launcher/channel-confirmed-provider-recovery.js'

const { continueSession } = vi.hoisted(() => ({
  continueSession: vi.fn(async (_input: unknown) => ({ state: 'applied' as const, navigationReady: true })),
}))
vi.mock('../packages/cli/src/launcher/channel-logical-continuation.js', () => ({
  startChannelLogicalContinuation: continueSession,
}))

async function scenario(kind: 'direct' | 'group', changes: Partial<ChatExecutionRecord> = {}, admin = true) {
  continueSession.mockClear()
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  const ref = channel('oc_one', kind), input = message('input', 'hello', ref)
  const target = { providerId: 'target', model: 'fixture-model' }
  const original = { providerId: 'source', model: 'fixture-model' }
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [{ id: 'commands', action: 'command', effect: 'allow', userIds: [admin ? 'alice' : 'other'] }],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [{ id: 'models', effect: 'allow', fields: ['providerId', 'model'], userIds: ['alice'] }],
    })
    state.bindings.b = {
      id: 'b',
      channel: ref,
      sessionId: a,
      hostId: 'local',
      profileId: 'fixture',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
    state.inputs.r = {
      recordId: 'r',
      input,
      accepted: true,
      routed: true,
      persisted: true,
      mentionedBot: kind === 'group',
      sequence: 1,
    }
    state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: a }
    state.taskSettings[a] = { revision: 1, application: 'applied', settings: target }
  })
  const file = path.join(path.dirname(f.file), 'execution.json')
  const record: ChatExecutionRecord = {
    hostId: 'local',
    threadId: a,
    capturedDefaults: {},
    defaultsRevision: 0,
    revision: 1,
    appliedRevision: 1,
    application: 'applied',
    effective: { modelProvider: target.providerId, model: target.model },
    ...changes,
  }
  await writeFile(
    file,
    JSON.stringify({
      schema: 'cordisx.chat-execution-preferences/v1',
      records: { [JSON.stringify(['local', a])]: record },
    }),
  )
  const execution = await ChatExecutionPreferences.open({
    file,
    configPath: path.join(path.dirname(f.file), 'config.json'),
    appId: 'codex',
    profileId: 'fixture',
  })
  let restored = false
  const restore = vi.fn(async () => {
    await execution.observe(a, { modelProvider: original.providerId, model: original.model })
    restored = true
    return original
  })
  const native = {
    supportsCrossProviderFork: async () => true,
    idle: async (_id: string, observed = false) => !observed || restored,
    executionPreferences: () => execution,
    taskSelection: async () => original,
    providerRecovery: {
      target: async () => target,
      probe: async () => ({ state: 'mismatch', sourceProvider: original.providerId }),
      restore,
    },
  }
  const fence = new ChannelNativeSourceFence(() => false)
  const run = () =>
    recoverConfirmedChannelProvider({
      store,
      native: native as never,
      fence,
      claims: new Set(),
      appId: 'codex',
      profileId: 'fixture',
      access: () => f.access,
      event: input.source.event,
      job: store.snapshot().jobs.j!,
    })
  return { store, execution, restore, fence, run, original, target }
}

it.each(['direct', 'group'] as const)(
  'preserves an applied legacy selection for %s recovery before source resume',
  async kind => {
    const f = await scenario(kind)
    try {
      expect(await f.run()).toBe(true)
      expect(f.restore).toHaveBeenCalledOnce()
      expect(continueSession).toHaveBeenCalledOnce()
      const request = (continueSession.mock.calls[0]![0] as { request: { mode: string; target: unknown } }).request
      expect(request).toMatchObject({ mode: kind === 'group' ? 'linked' : 'fork', target: f.target })
      expect(f.store.snapshot().jobs.j?.state).toBe('queued')
      expect(f.execution.read('local', a)?.modelSelection).toEqual({ status: 'confirmed', ...f.original })
    } finally {
      await f.execution.close()
    }
  },
)

it.each([
  { application: 'saved' as const },
  { appliedRevision: 0 },
  { effective: { modelProvider: 'other', model: 'fixture-model' } },
  { modelSelection: { status: 'unknown' as const } },
  { modelSelection: { status: 'confirmed' as const, providerId: 'other', model: 'fixture-model' } },
  {
    effective: { modelProvider: 'source', model: 'fixture-model' },
    modelSelection: { status: 'confirmed' as const, providerId: 'source', model: 'fixture-model' },
  },
])('does not restore or create when old evidence is stale or uncertain: %j', async changes => {
  const f = await scenario('direct', changes)
  try {
    expect(await f.run()).toBe(true)
    expect(f.restore).not.toHaveBeenCalled()
    expect(continueSession).not.toHaveBeenCalled()
    expect(f.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
  } finally {
    await f.execution.close()
  }
})

it('does not overwrite a selection changed between legacy read and preservation', async () => {
  const f = await scenario('direct')
  const record = f.execution.recordModelSelection.bind(f.execution)
  vi.spyOn(f.execution, 'recordModelSelection').mockImplementationOnce(async (...args) => {
    await f.execution.observe(a, { modelProvider: 'other', model: 'other-model' })
    return record(...args)
  })
  try {
    expect(await f.run()).toBe(true)
    expect(f.restore).not.toHaveBeenCalled()
    expect(continueSession).not.toHaveBeenCalled()
    expect(f.execution.read('local', a)?.effective).toMatchObject({ modelProvider: 'other', model: 'other-model' })
    expect(f.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
  } finally {
    await f.execution.close()
  }
})

it('does not continue if execution settings change while the source is restored', async () => {
  const f = await scenario('direct')
  const restore = f.restore.getMockImplementation()!
  f.restore.mockImplementationOnce(async () => {
    await f.execution.set('local', a, { effort: 'high' }, 1)
    return restore()
  })
  try {
    expect(await f.run()).toBe(true)
    expect(f.restore).toHaveBeenCalledOnce()
    expect(continueSession).not.toHaveBeenCalled()
    expect(f.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
  } finally {
    await f.execution.close()
  }
})

it('does not migrate a group without an eligible administrator', async () => {
  const f = await scenario('group', {}, false)
  try {
    expect(await f.run()).toBe(false)
    expect(f.restore).not.toHaveBeenCalled()
    expect(continueSession).not.toHaveBeenCalled()
    expect(f.execution.read('local', a)?.modelSelection).toBeUndefined()
  } finally {
    await f.execution.close()
  }
})
