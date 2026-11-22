import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { startChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-continuation.js'
import { ChannelLogicalHandoffPermits } from '../packages/cli/src/launcher/channel-logical-handoff-permits.js'
import { claimChannelDispatch } from '../packages/cli/src/launcher/channel-conversation-dispatch.js'
import {
  channelLogicalHandoffForJob,
  confirmChannelLogicalHandoff,
} from '../packages/cli/src/launcher/channel-logical-handoff.js'

it('guards the first Channel checkpoint write through the Desktop intermediary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-channel-handoff-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  const owner = profileLogicalConversationOwner(store)
  const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true })
  try {
    h.server.bindLogicalFenceOwner(owner)
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const create = async () =>
      (await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as { thread: { id: string } }).thread
        .id
    const source = await create(), destination = await create()
    const channel = {
      adapterId: 'test',
      accountId: 'account',
      tenantId: 'tenant',
      conversationId: 'chat',
      threadId: 'chat',
      kind: 'direct' as const,
      semantics: 'conversation' as const,
    }
    const event = {
      ...channel,
      eventId: 'event',
      actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'user' },
    }
    await store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        enabled: true,
        rules: [
          { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
          { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
        ],
      })
      state.taskConfig = parseChannelTaskConfig({
        permissions: [{ id: 'grant', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] }],
      })
      state.bindings.b = {
        id: 'b',
        channel,
        sessionId: source,
        hostId: 'local',
        profileId: 'fixture',
        createdAt: '',
        fromSequence: 0,
        mode: 'deliver',
        autoReply: false,
        state: 'active',
      }
      state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
      state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: source }
      state.continuations[source] = {
        checkpoint: {
          threadId: source,
          revision: 1,
          goal: 'synthetic checkpoint',
          constraints: 'constraints',
          completed: 'done',
          remaining: 'next',
          history: 'background',
          continueAtIdle: false,
        },
      }
    })
    const config = {
      providerId: 'old',
      model: 'old',
      cwd: '/workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
      permissionProfile: null,
      execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
    } as const
    const native = {
      supportsLogicalHandoff: () => true,
      modelOperation: async () => ({ providers: [{ providerId: 'new', models: [{ id: 'model' }] }] }),
      taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
      continuationConfiguration: async () => config,
      logicalSourceVersion: async () => 'version',
      createLogicalDestination: async () => ({
        state: 'created',
        confirmed: true,
        destination: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: destination },
      }),
    }
    const result = await startChannelLogicalContinuation({
      store,
      native: native as never,
      fence: owner.fence,
      claims: new Set(),
      appId: 'codex',
      profileId: 'fixture',
      event,
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'operation',
        logicalConversationId: 'conversation',
        source: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: source },
        expectedRevision: 0,
        target: { providerId: 'new', model: 'model' },
        mode: 'linked',
        historyConsent: 'on-demand',
        handoffConsent: 'checkpoint',
        historyCategories: ['user-text', 'assistant-text'],
      },
    })
    expect(result).toMatchObject({ state: 'applied' })
    await store.mutate(state => expect(claimChannelDispatch(state, state.jobs.j!, event, undefined)).toBe(true))
    const handoff = channelLogicalHandoffForJob(store.snapshot(), 'j', event) as string
    const permits = new ChannelLogicalHandoffPermits(), marker = permits.issue('j', destination)!
    h.server.bindLogicalHandoffPermits(permits)
    expect(h.server.logicalHandoffReady()).toBe(true)

    h.send({ id: 'unrelated', method: 'turn/start', params: { threadId: destination, input: [{ text: handoff }] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'unrelated', error: { code: -32000 } })
    const params = {
      threadId: destination,
      input: [{ type: 'text', text: `${marker}\n${handoff}`, text_elements: [] }],
    }
    const sent = await h.server.nativeRequest('turn/start', params) as { turn: { id: string } }
    expect(sent.turn.id).toBeTruthy()
    await expect(h.server.nativeRequest('turn/start', params)).rejects.toThrow()
    await store.mutate(state => {
      confirmChannelLogicalHandoff(state, 'j', destination, sent.turn.id)
      state.jobs.j!.turnId = sent.turn.id
    })
    h.send({ id: 'later', method: 'turn/start', params: { threadId: destination, input: [{ text: 'next' }] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'later', result: { current: 'openai' } })
  } finally {
    await h.close()
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
