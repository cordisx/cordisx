import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { a, channel, fixture, message } from './helpers/channel-conversation-fixture.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { recoverConfirmedChannelProvider } from '../packages/cli/src/launcher/channel-confirmed-provider-recovery.js'

async function scenario(
  options: {
    deny?: 'value' | 'command' | 'continue' | 'other-model' | 'other-user'
    differentActor?: boolean
    uncertain?: boolean
    revoke?: boolean
  } = {},
) {
  const f = await fixture(), store = f.consumer.profileLogicalOwner().store
  const ref = channel(), input = message('input', 'hello', ref)
  const target = { providerId: 'target', model: 'model' }, original = { providerId: 'source', model: 'model' }
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['alice'] },
        { id: 'commands', action: 'command', effect: 'allow', userIds: ['alice'] },
        ...(options.deny === 'command' || options.deny === 'continue'
          ? [{
            id: 'deny-provider',
            action: 'command',
            effect: 'deny',
            commands: [options.deny === 'command' ? 'provider' : 'continue-provider'],
            userIds: ['alice'],
          }]
          : []),
      ],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: options.deny === 'value'
        ? [{ id: 'deny-model', effect: 'deny', userIds: ['alice'], fields: ['model'], models: [target] }]
        : options.deny === 'other-model'
        ? [{
          id: 'other-model',
          effect: 'allow',
          userIds: ['alice'],
          fields: ['model'],
          models: [{ providerId: 'other', model: 'model' }],
        }]
        : options.deny === 'other-user'
        ? [{ id: 'other-user', effect: 'allow', userIds: ['other'], fields: ['model'] }]
        : [],
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
      mentionedBot: false,
      sequence: 1,
    }
    state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: a }
    state.taskSettings[a] = { revision: 1, application: 'applied', settings: target }
  })
  const file = path.join(path.dirname(f.file), 'execution.json')
  await writeFile(
    file,
    JSON.stringify({
      schema: 'cordisx.chat-execution-preferences/v1',
      records: {
        [JSON.stringify(['local', a])]: {
          hostId: 'local',
          threadId: a,
          capturedDefaults: {},
          defaultsRevision: 0,
          revision: 1,
          appliedRevision: 1,
          application: 'applied',
          effective: { modelProvider: target.providerId, model: target.model },
        },
      },
    }),
  )
  const execution = await ChatExecutionPreferences.open({
    file,
    configPath: path.join(path.dirname(f.file), 'config.json'),
    appId: 'codex',
    profileId: 'fixture',
  })
  let restored = false
  const create = vi.fn(async (request: { source: Record<string, string> }) => {
    if (options.uncertain) throw new Error('lost acknowledgement')
    if (options.revoke) {
      await store.mutate(state => {
        state.policyRevision++
      })
    }
    return { state: 'created' as const, confirmed: true, destination: { ...request.source, sessionId: 'destination' } }
  })
  const native = {
    supportsCrossProviderFork: async () => true,
    idle: async (_id: string, observed = false) => !observed || restored,
    executionPreferences: () => execution,
    taskSelection: async (id: string) => ({ ...(id === a ? original : target), effort: 'low', fast: false }),
    continuationConfiguration: async () => ({
      ...original,
      cwd: '/workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      permissionProfile: null,
      sandbox: { type: 'readOnly' },
      execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
    }),
    modelOperation: async () => ({ providers: [{ providerId: target.providerId, models: [{ id: target.model }] }] }),
    logicalSourceVersion: async () => 'sha256:synthetic',
    createLogicalDestination: create,
    providerRecovery: {
      target: async () => target,
      probe: async () => ({ state: 'mismatch' as const, sourceProvider: original.providerId }),
      restore: async () => {
        await execution.observe(a, { modelProvider: original.providerId, model: original.model })
        restored = true
        return original
      },
    },
  }
  const event = options.differentActor
    ? { ...input.source.event, actor: { ...input.source.event.actor!, userId: 'other' } }
    : input.source.event
  const run = () =>
    recoverConfirmedChannelProvider({
      store,
      native: native as never,
      fence: new ChannelNativeSourceFence(() => false),
      claims: new Set(),
      appId: 'codex',
      profileId: 'fixture',
      access: () => f.access,
      event,
      job: store.snapshot().jobs.j!,
      report: f.report,
    })
  return { store, execution, create, run, target, report: f.report }
}

it('restores the exact previously applied private-chat model without requiring a new grant', async () => {
  const f = await scenario()
  try {
    expect(await f.run()).toBe(true)
    expect(f.report).not.toHaveBeenCalledWith('CHANNEL_PROVIDER_RECOVERY_PREFLIGHT_TASK_CHANGE_NOT_ALLOWED')
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.store.snapshot().bindings.b?.sessionId).toBe('destination')
    expect(f.store.snapshot().jobs.j?.sessionId).toBe('destination')
    expect(f.store.snapshot().taskSettings.destination?.settings).toMatchObject(f.target)
  } finally {
    await f.execution.close()
  }
})

it.each(['value', 'command', 'continue', 'other-model', 'other-user'] as const)(
  'keeps the %s restriction in force',
  async deny => {
    const f = await scenario({ deny })
    try {
      await f.run()
      expect(f.create).not.toHaveBeenCalled()
      expect(f.store.snapshot().bindings.b?.sessionId).toBe(a)
    } finally {
      await f.execution.close()
    }
  },
)

it('does not move the binding or retry when policy changes during destination creation', async () => {
  const f = await scenario({ revoke: true })
  try {
    await f.run()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.store.snapshot().bindings.b?.sessionId).toBe(a)
    expect(f.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
    await f.run()
    expect(f.create).toHaveBeenCalledOnce()
  } finally {
    await f.execution.close()
  }
})

it('does not restore a different sender or repeat an uncertain creation', async () => {
  const other = await scenario({ differentActor: true })
  const uncertain = await scenario({ uncertain: true })
  try {
    expect(await other.run()).toBe(false)
    expect(other.create).not.toHaveBeenCalled()
    await uncertain.run()
    expect(uncertain.create).toHaveBeenCalledOnce()
    expect(uncertain.store.snapshot().jobs.j?.state).toBe('reconciliation-required')
    await uncertain.run()
    expect(uncertain.create).toHaveBeenCalledOnce()
  } finally {
    await other.execution.close()
    await uncertain.execution.close()
  }
})
