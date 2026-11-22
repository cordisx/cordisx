import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type EventMap, normalize, normalizeCardAction } from '@larksuiteoapi/node-sdk'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { createConfiguredChannelConsumer } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'
import type { LogicalContinuationRequest } from '../packages/cli/src/launcher/logical-continuation-control.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'

const { sdkFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<typeof import('@larksuiteoapi/node-sdk')>(),
  createLarkChannel: sdkFactory,
}))

describe('production Channel command composition with SDK transport fixtures', () => {
  it('routes an authorized continuation command from the SDK into the committed binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-logical-composition-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const send = vi.fn(async () => ({ messageId: 'om_reply' }))
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      send,
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
    })
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(bundledPluginEntry('channel')),
      dataDir: path.join(root, 'transport'),
      source: 'fixture:channel',
      environment: { CHANNEL_LOGICAL_FIXTURE: 'fixture-only' },
    })
    let owner: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_LOGICAL_FIXTURE',
        }],
      })
      const config = {
        providerId: 'old',
        model: 'old',
        cwd: '/workspace',
        serviceTier: null,
        approvalsReviewer: 'user',
        execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
        sandbox: { type: 'readOnly' },
        permissionProfile: null,
      }
      const native = {
        contextObservations: () => undefined,
        exists: vi.fn(async () => true),
        hasPreparation: () => false,
        isPreparing: () => false,
        modelOperation: async () => ({ providers: [{ providerId: 'new', models: [{ id: 'model' }] }] }),
        taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
        continuationConfiguration: async () => config,
        logicalSourceVersion: async () => 'sha256:fixture',
        createLogicalDestination: vi.fn(async (request: LogicalContinuationRequest) => ({
          state: 'created',
          confirmed: true,
          destination: { ...request.source, sessionId: '01a10000-0000-7000-8000-000000000002' },
        })),
      }
      owner = await createConfiguredChannelConsumer({
        service,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        logicalRuntime: true,
        native: () => native as never,
        report: vi.fn(),
      })
      const consumer = owner.consumer!
      const release = owner.logicalOwner!.fence.beginMigration('fixture-source')!
      expect(() => consumer.enterNativeSourceOperation('turn/start', { threadId: 'fixture-source' }))
        .toThrow('CONTINUATION_PENDING')
      release()
      await consumer.policySet({
        enabled: true,
        rules: [{ id: 'commands', action: 'command', effect: 'allow', userIds: ['ou_actor'] }, {
          id: 'dispatch',
          action: 'dispatch',
          effect: 'allow',
          userIds: ['ou_actor'],
        }],
      }, 0)
      await consumer.taskSettings.call('task-config-set', {
        config: {
          permissions: [{ id: 'grant', effect: 'allow', userIds: ['ou_actor'], fields: ['providerId', 'model'] }],
        },
        expectedRevision: 0,
      })
      await consumer.bind({
        channel: {
          ...ref,
          conversationId: 'oc_direct',
          threadId: 'oc_direct',
          kind: 'direct',
          semantics: 'conversation',
        },
        mode: 'deliver',
        autoReply: false,
      }, '01a10000-0000-7000-8000-000000000001')
      const messageFor = (user: string, messageId: string) =>
        normalize({
          sender: { sender_id: { open_id: user }, sender_type: 'user', tenant_key: 'fixture' },
          message: {
            message_id: messageId,
            chat_id: 'oc_direct',
            chat_type: 'p2p',
            create_time: String(Date.now()),
            message_type: 'text',
            content: JSON.stringify({
              text: '/continue-provider linked new model --history=user,assistant --no-checkpoint',
            }),
          },
        } as never, { includeRaw: true })
      await handlers.message!(await messageFor('ou_other', 'om_denied'))
      await consumer.pump()
      expect(native.createLogicalDestination).not.toHaveBeenCalled()
      expect(consumer.bindings()).toEqual([expect.objectContaining({
        sessionId: '01a10000-0000-7000-8000-000000000001',
        state: 'active',
      })])
      await handlers.message!(await messageFor('ou_actor', 'om_migrate'))
      await consumer.pump()
      await consumer.pump()
      expect(native.createLogicalDestination).toHaveBeenCalledOnce()
      expect(consumer.bindings()).toEqual([expect.objectContaining({
        sessionId: '01a10000-0000-7000-8000-000000000002',
        state: 'active',
      })])
      expect(send).toHaveBeenCalled()
    } finally {
      await owner?.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  })
  it.each(['linked'] as const)(
    'routes a direct actor grant into a Desktop %s migration through the shared owner',
    async mode => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'channel-desktop-composition-'))
      const sourceId = '01a10000-0000-7000-8000-000000000001'
      const destinationId = '01a10000-0000-7000-8000-000000000002'
      const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
      const handlers: Partial<EventMap> = {}
      const replies: string[] = []
      sdkFactory.mockReturnValue({
        connect: async () => {},
        disconnect: async () => {},
        send: async (_target: unknown, value: { text?: string }) => {
          replies.push(value.text ?? '')
          return { messageId: 'reply' }
        },
        on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
          Object.assign(handlers, { [name]: handler })
          return () => {
            delete handlers[name]
          }
        },
      })
      const service = createLocalChannelService({
        artifactDirectory: path.dirname(bundledPluginEntry('channel')),
        dataDir: path.join(root, 'transport'),
        source: 'fixture:channel',
        environment: { CHANNEL_GRANT_FIXTURE: 'fixture' },
      })
      let configured: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
      try {
        await service.start({
          contract: 'cordisx.channel-service-config/v1',
          schemaVersion: 1,
          connections: [{
            ref,
            adapterKind: 'feishu',
            enabled: true,
            transport: { mode: 'websocket' },
            secretRef: 'host-secret:env/CHANNEL_GRANT_FIXTURE',
          }],
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
        }
        const native = {
          exists: async () => true,
          contextObservations: () => undefined,
          hasPreparation: () => false,
          isPreparing: () => false,
          taskSelection: async () => ({ providerId: 'old', model: 'old', effort: 'low' }),
          continuationConfiguration: async () => config,
          logicalSourceVersion: async () => 'version',
          logicalOwnerIdentity: async () => 'desktop:fixture',
          logicalJointSourceRoot: async () => true,
          logicalTurnActive: async () => true,
          logicalContextTokens: () => [],
          logicalHistoryPage: async () => ({ items: [{ type: 'agentMessage', text: 'fixture-source' }] }),
          sourceFor: () => ({
            ...ref,
            conversationId: 'oc_direct',
            threadId: 'oc_direct',
            kind: 'direct',
            semantics: 'conversation',
            eventId: 'turn-event',
            actor: { ...ref, userId: 'ou_actor' },
          }),
          sourceForLogicalTurn: async () => ({
            ...ref,
            conversationId: 'oc_direct',
            threadId: 'oc_direct',
            kind: 'direct',
            semantics: 'conversation',
            eventId: 'turn-event',
            actor: { ...ref, userId: 'ou_actor' },
          }),
          supportsLogicalFork: () => true,
          createLogicalDestination: vi.fn(
            async (
              request: LogicalContinuationRequest,
              _evidence: unknown,
              fence: any,
              _available: unknown,
              send: (method: 'thread/start', params: {}) => Promise<unknown>,
            ) => {
              await send('thread/start', {})
              return {
                state: 'created' as const,
                confirmed: true,
                destination: { ...request.source, sessionId: destinationId },
                releaseTarget: fence.beginMigration(destinationId),
              }
            },
          ),
        }
        configured = await createConfiguredChannelConsumer({
          service,
          homeDir: root,
          appId: 'codex',
          profileId: 'fixture',
          logicalOwnerOnly: true,
          native: () => native as never,
          report: vi.fn(),
        })
        const owner = configured.logicalOwner!, consumer = configured.consumer!
        await owner.store.bindCommitBarrier(async () => {})
        await consumer.policySet({
          enabled: true,
          rules: [
            { id: 'command', action: 'command', effect: 'allow', userIds: ['ou_actor'] },
            { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['ou_actor'] },
          ],
        }, 0)
        await consumer.taskSettings.call('task-config-set', {
          config: {
            permissions: [
              { id: 'grant', effect: 'allow', userIds: ['ou_actor'], fields: ['providerId', 'model'] },
            ],
          },
          expectedRevision: 0,
        })
        await consumer.bind({
          channel: {
            ...ref,
            conversationId: 'oc_direct',
            threadId: 'oc_direct',
            kind: 'direct',
            semantics: 'conversation',
          },
          mode: 'deliver',
          autoReply: false,
        }, sourceId)
        const code = owner.desktopChannelGrants.begin(sourceId, { providerId: 'new', model: 'model' })
        const message = async (userId: string, id: string) =>
          await normalize({
            sender: { sender_id: { open_id: userId }, sender_type: 'user', tenant_key: 'fixture' },
            message: {
              message_id: id,
              chat_id: 'oc_direct',
              chat_type: 'p2p',
              create_time: String(Date.now()),
              message_type: 'text',
              content: JSON.stringify({
                text:
                  '/continue-provider authorize-desktop linked new model --history=user-assistant --no-checkpoint --challenge='
                  + code,
              }),
            },
          } as never, { includeRaw: true })
        await handlers.message!(await message('ou_other', 'denied'))
        await consumer.pump()
        expect(replies.some(text => text.includes('已授权'))).toBe(false)
        await handlers.message!(await message('ou_actor', 'allowed'))
        await vi.waitFor(async () => {
          await consumer.pump()
          expect(replies.some(text => text.includes('已授权'))).toBe(true)
        })
        expect(replies.every(text => !text.includes(code))).toBe(true)
        const control = {
          acquireLogicalFence: async () => 'source-lease',
          releaseLogicalFence: async () => true,
          createFencedLogicalDestination: async () => ({
            result: { thread: { id: destinationId } },
            destinationLease: 'target-lease',
          }),
          nativeRequest: async () => ({}),
        }
        const migration = desktopLogicalMigration({
          owner,
          control: control as never,
          native: () => native as never,
          profileId: 'fixture',
          identity: async () => 'desktop:fixture',
          targetAllowed: async () => true,
          historyReady: () => true,
        })
        const result = await migration.continue({
          scope: { targetId: 'window', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: sourceId },
          operationId: 'desktop-operation',
          target: { providerId: 'new', model: 'model' },
          mode,
          channelCode: code,
          current: () => true,
          configOverrides: {},
        })
        expect(result).toMatchObject({ state: 'applied', destination: { sessionId: destinationId } })
        expect(consumer.bindings()).toEqual([expect.objectContaining({ sessionId: destinationId })])
        if (mode === 'linked') {
          const history = await consumer.logicalHistoryCall({
            threadId: destinationId,
            turnId: 'turn',
            callId: 'call',
            tool: 'cordisx_continuation_history',
            arguments: {},
          })
          expect(JSON.stringify(history)).toContain('fixture-source')
        }
        expect(JSON.stringify(owner.store.snapshot().logicalContinuations)).not.toContain(code)
      } finally {
        await configured?.dispose()
        await service.dispose()
        await rm(root, { recursive: true, force: true })
        sdkFactory.mockReset()
      }
    },
  )

  it('keeps pairing codes out of the inbox and requires explicit local confirmation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-pair-composition-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const send = vi.fn(async () => ({ messageId: 'om_reply' }))
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      send,
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
    })
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(bundledPluginEntry('channel')),
      dataDir: path.join(root, 'transport'),
      source: 'fixture:channel',
      environment: { CHANNEL_PAIR_FIXTURE: 'fixture-only' },
    })
    let owner: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_PAIR_FIXTURE',
        }],
      })
      owner = await createConfiguredChannelConsumer({
        service,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        native: () => undefined,
        report: vi.fn(),
      })
      await owner.consumer!.policySet({ enabled: true }, 0)
      const start = await owner.tools.callLocal('admin-pair-begin', { account: ref }) as {
        status: string
        code: string
        pairingId: string
      }
      expect(start.status).toBe('ok')
      const message = await normalize({
        sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'fixture' },
        message: {
          message_id: 'om_pair',
          chat_id: 'oc_direct',
          chat_type: 'p2p',
          create_time: String(Date.now()),
          message_type: 'text',
          content: JSON.stringify({ text: `/pair ${start.code}` }),
        },
      } as never, { includeRaw: true })
      await handlers.message!(message)
      expect(send).toHaveBeenCalledOnce()
      expect(await owner.tools.callLocal('admin-pair-status', { pairingId: start.pairingId })).toMatchObject({
        state: 'confirmation-required',
        candidate: { userId: 'ou_alice', conversationId: 'oc_direct' },
      })
      expect(owner.consumer!.policy().policy.rules).toEqual([])
      expect(await owner.tools.callLocal('admin-pair-confirm', { pairingId: start.pairingId })).toMatchObject({
        state: 'paired',
      })
      expect(owner.consumer!.policy().policy.rules).toEqual([expect.objectContaining({
        action: 'command',
        ...ref,
        conversationId: 'oc_direct',
        userIds: ['ou_alice'],
      })])
      const transport = await readFile(path.join(root, 'transport', 'transport.json'), 'utf8')
      const consumer = await readFile(
        path.join(root, 'apps', 'codex', 'profiles', 'fixture', 'channel-conversations.json'),
        'utf8',
      )
      expect(transport).not.toContain(start.code)
      expect(consumer).not.toContain(start.code)
      const existing = owner.consumer!.policy()
      await owner.consumer!.policySet({
        ...existing.policy,
        rules: [...existing.policy.rules, {
          id: 'deny-group',
          ...ref,
          action: 'dispatch',
          effect: 'deny',
          kinds: ['group'],
        }],
      }, existing.revision)
      const group = {
        ...message,
        messageId: 'om_group_1',
        chatId: 'oc_group',
        chatType: 'group' as const,
        content: 'Please start a task',
        mentionedBot: true,
      }
      await handlers.message!(group)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]?.[1].text).toContain('没有任务投递权限')
      await handlers.message!({ ...group, messageId: 'om_group_2' })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      await owner?.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  })
  it('routes a question card click through the SDK queue, configured service and consumer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-question-composition-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_card' } }))
    const members = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{ member_id_type: 'open_id', member_id: 'ou_alice', name: 'Alice' }, {
          member_id_type: 'open_id',
          member_id: 'ou_bob',
          name: 'Bob',
        }],
        has_more: false,
      },
    }))
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
      send: vi.fn(),
      rawClient: { im: { v1: { chatMembers: { get: members }, message: { create } } } },
    })
    const entry = bundledPluginEntry('channel')
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(entry),
      dataDir: path.join(root, 'transport'),
      source: 'fixture:channel',
      environment: { CHANNEL_QUESTION_FIXTURE: 'fixture-only' },
    })
    let owner: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_QUESTION_FIXTURE',
        }],
      })
      const native = {
        contextObservations: () => undefined,
        hasPreparation: () => false,
        isPreparing: () => false,
        exists: vi.fn(async () => true),
        start: vi.fn(async (_id, _message, sessionId) => ({ state: 'running', sessionId, turnId: 'turn' })),
        completion: vi.fn(async () => ({ state: 'completed' })),
        reconcile: vi.fn(),
      }
      owner = await createConfiguredChannelConsumer({
        service,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        native: () => native as never,
        report: vi.fn(),
      })
      const consumer = owner.consumer!
      await consumer.policySet({ enabled: true }, 0)
      const channel = {
        ...ref,
        conversationId: 'oc_group',
        kind: 'group',
        threadId: 'oc_group',
        semantics: 'conversation',
      }
      await consumer.bind({ channel, mode: 'deliver', autoReply: false }, '01a10000-0000-7000-8000-000000000001')
      expect(
        await owner.tools.call('ask', {
          account: ref,
          target: { id: 'oc_group', kind: 'group' },
          question: 'Choose?',
          options: [{ label: 'Yes', value: 'Yes please' }],
          operationId: 'compose-question',
        }),
      ).toMatchObject({ status: 'ok', deliveryState: 'sent' })
      const card = JSON.parse(create.mock.calls[0]![0].data.content)
      const value = card.elements[1].actions[0].value
      handlers.cardAction!({
        chatId: 'oc_group',
        messageId: 'om_card',
        operator: { openId: 'ou_alice' },
        action: { tag: 'button', value },
      })
      await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1))
      expect(native.start.mock.calls[0]![1]).toMatchObject({
        content: [{ text: expect.stringContaining('Yes please') }],
        source: { event: { actor: { userId: 'ou_alice' } } },
      })
      expect(native.start.mock.calls[0]![5]).toMatchObject({ sender: { userId: 'ou_alice', name: 'Alice' } })
      expect(sdkFactory.mock.calls[0]![0]).toMatchObject({
        includeRawEvent: true,
        safety: { batch: { text: { delayMs: 0, longDelayMs: 0, maxMessages: 1 } } },
      })
      const form = card.elements.find((element: { tag: string }) => element.tag === 'form')
      expect(form.elements[0]).toMatchObject({ tag: 'input', name: 'answer' })
      const submit = normalizeCardAction({
        context: { open_message_id: 'om_card', open_chat_id: 'oc_group' },
        operator: { open_id: 'ou_bob' },
        action: { tag: 'button', name: 'channel_question_submit', form_value: { answer: 'A custom answer' } },
      } as never, { includeRaw: true })!
      handlers.cardAction!(submit)
      await vi.waitFor(async () => {
        await consumer.pump()
        expect(native.start).toHaveBeenCalledTimes(2)
      }, { timeout: 5000 })
      expect(native.start.mock.calls[1]![1]).toMatchObject({
        content: [{ text: expect.stringContaining('A custom answer') }],
        source: { event: { actor: { userId: 'ou_bob' } } },
      })
      expect(native.start.mock.calls[1]![5]).toMatchObject({ sender: { userId: 'ou_bob', name: 'Bob' } })
    } finally {
      await owner?.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  })

  it('carries native mention identity and live member lookup through the configured launcher and sends command topics once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-command-composition-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const members = vi.fn(async () => ({
      code: 0,
      data: { items: [{ member_id_type: 'open_id', member_id: 'ou_bob', name: 'Bob Smith' }], has_more: false },
    }))
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_result' } }))
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_main' } }))
    const disconnect = vi.fn(async () => {})
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect,
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
      send: vi.fn(),
      rawClient: { im: { v1: { chatMembers: { get: members }, message: { reply, create } } } },
    })
    const entry = bundledPluginEntry('channel')
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(entry),
      dataDir: path.join(root, 'transport'),
      source: 'fixture:channel',
      environment: { CHANNEL_COMMAND_FIXTURE: 'fixture-only' },
    })
    let owner: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_COMMAND_FIXTURE',
        }],
      })
      const native = {
        contextObservations: () => undefined,
        hasPreparation: () => false,
        isPreparing: () => false,
        exists: vi.fn(async () => true),
        start: vi.fn(),
        completion: vi.fn(),
        reconcile: vi.fn(),
      }
      owner = await createConfiguredChannelConsumer({
        service,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        native: () => native as never,
        report: vi.fn(),
      })
      const consumer = owner.consumer!
      await consumer.policySet({
        enabled: true,
        replyMode: 'none',
        rules: [{ id: 'commands', action: 'command', effect: 'allow', userIds: ['ou_actor'] }],
      }, 0)
      const input = async (id: string, text: string, targetMention: boolean) => {
        const message = await normalize({
          sender: { sender_id: { open_id: 'ou_actor' }, sender_type: 'user', tenant_key: 'fixture' },
          message: {
            message_id: id,
            chat_id: 'oc_group',
            chat_type: 'group',
            create_time: String(Date.now()),
            message_type: 'text',
            content: JSON.stringify({ text }),
            mentions: [
              { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' },
              ...(targetMention ? [{ key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob Smith' }] : []),
            ],
          },
        } as never, { includeRaw: false, botIdentity: { openId: 'ou_bot', name: 'Bot' } })
        await handlers.message!(message)
        await consumer.pump()
        await consumer.pump()
      }
      await input('om_deny', '@_user_1 /deny-user @_user_2', true)
      expect(consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toMatchObject([{
        userIds: ['ou_bob'],
        effect: 'deny',
      }])
      expect(members).not.toHaveBeenCalled()
      await input('om_reset', '@_user_1 /reset-user Bob Smith', false)
      expect(consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toEqual([])
      expect(members).toHaveBeenCalledWith({
        path: { chat_id: 'oc_group' },
        params: { member_id_type: 'open_id', page_size: 100 },
      })
      expect(reply).toHaveBeenCalledTimes(2)
      expect(reply.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          path: { message_id: 'om_deny' },
          data: expect.objectContaining({ reply_in_thread: true }),
        }),
        expect.objectContaining({
          path: { message_id: 'om_reset' },
          data: expect.objectContaining({ reply_in_thread: true }),
        }),
      ])
      expect(create).not.toHaveBeenCalled()
      expect(native.start).not.toHaveBeenCalled()
      await owner.dispose()
      owner = undefined
      expect(Object.keys(handlers)).toEqual([])
      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      await owner?.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  })
})
