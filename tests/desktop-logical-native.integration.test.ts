import { createServer } from 'node:http'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { desktopLogicalMigration } from '../packages/cli/src/launcher/desktop-logical-migration.js'
import { createDesktopLogicalComposition } from '../packages/cli/src/launcher/desktop-logical-composition.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { channelLogicalCommand } from '../packages/cli/src/launcher/channel-logical-command.js'
import { createChannelLogicalHistory } from '../packages/cli/src/launcher/channel-logical-history.js'
import { startHeadlessCodexBackend } from '../packages/cli/src/launcher/headless-codex-backend.js'
import { startChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-continuation.js'
import { acquireChannelLogicalNativeLease } from '../packages/cli/src/launcher/channel-logical-native-lease.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { claimChannelDispatch } from '../packages/cli/src/launcher/channel-conversation-dispatch.js'
import {
  channelLogicalHandoffForJob,
  confirmChannelLogicalHandoff,
} from '../packages/cli/src/launcher/channel-logical-handoff.js'

const executable = process.env.CORDISX_LOGICAL_NATIVE_TEST_EXECUTABLE
const realTarget = process.env.CORDISX_LOGICAL_NATIVE_DESKTOP_REAL_TARGET === '1'
const placementMode = process.env.CORDISX_LOGICAL_NATIVE_DESKTOP_PLACEMENT === '1'
const explicitEffort = process.env.CORDISX_LOGICAL_NATIVE_DESKTOP_EFFORT === '1'
describe.skipIf(!executable)('isolated Desktop intermediary with native Codex', () => {
  it.each(
    realTarget ? ['linked', 'bound-linked'] : ['linked', 'bound-linked', 'fork', 'channel-checkpoint', 'channel-fork'],
  )(
    'creates and dispatches a %s destination through the real native intermediary',
    async mode => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-native-'))
      let cleanupStore: ChannelConversationStore | undefined
      let cleanupHarness: Awaited<ReturnType<typeof harness>> | undefined
      let calls = 0,
        historySeen = false,
        historyCalls = 0,
        historySuccess = false,
        handoffSeen = false,
        projectedContextLeak = false,
        historyArguments: unknown
      const historySources: string[] = []
      const modelEfforts: unknown[] = []
      const model = createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += chunk
        modelEfforts.push(JSON.parse(body).reasoning?.effort)
        calls++
        if (body.includes('SYNTHETIC_CHECKPOINT')) handoffSeen = true
        if ((calls > 2 || ['fork', 'channel-fork'].includes(mode) && calls > 1) && body.includes('PAPERKITE')) {
          historySeen = true
        }
        let nextCursor: string | undefined
        const findCursor = (value: unknown): void => {
          if (typeof value === 'string') {
            try {
              findCursor(JSON.parse(value))
            } catch {}
          } else if (Array.isArray(value)) value.forEach(findCursor)
          else if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>
            if (typeof record.nextCursor === 'string' && /^[a-f0-9]{48}$/u.test(record.nextCursor)) {
              nextCursor = record.nextCursor
            }
            Object.values(record).forEach(findCursor)
          }
        }
        findCursor(JSON.parse(body))
        const item = (!['fork', 'channel-fork'].includes(mode) && calls === 2
            || mode === 'bound-linked' && [4, 6, 7, 9].includes(calls))
          ? {
            type: 'function_call',
            id: 'fc_fixture_' + calls,
            call_id: 'call_fixture_' + calls,
            name: 'cordisx_continuation_history',
            arguments: JSON.stringify(calls === 7 ? { cursor: nextCursor } : {}),
            status: 'completed',
          }
          : {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: calls === 1
                ? 'SOURCE_ACK'
                : historySeen
                ? 'PAPERKITE'
                : 'NO_MARKER',
              annotations: [],
            }],
          }
        const complete = {
          id: 'resp_fixture',
          object: 'response',
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }
        const events = [
          { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: complete },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
      })
      try {
        if (realTarget) {
          await copyFile(path.join(os.homedir(), '.codex', 'auth.json'), path.join(root, 'auth.json'))
          await chmod(path.join(root, 'auth.json'), 0o600)
        }
        await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
        const address = model.address()
        if (!address || typeof address === 'string') throw new Error('FIXTURE_UNAVAILABLE')
        const provider = (id: string) =>
          '[model_providers.' + id + ']\nname="fixture"\nbase_url="http://127.0.0.1:'
          + address.port + '/v1"\nenv_key="FIXTURE_API_KEY"\nwire_api="responses"\n'
        await writeFile(
          path.join(root, 'config.toml'),
          'model_provider="source"\nmodel="fixture-model"\nmodel_reasoning_effort="low"\n' + provider('source')
            + provider('target'),
        )
        const store = await ChannelConversationStore.open(path.join(root, 'state.json'))
        cleanupStore = store
        const owner = profileLogicalConversationOwner(store)
        const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true }, {
          HOME: root,
          CODEX_HOME: root,
          FIXTURE_API_KEY: 'fixture',
          NO_PROXY: '127.0.0.1,localhost',
          HTTP_PROXY: realTarget ? process.env.HTTP_PROXY : 'http://127.0.0.1:9',
          HTTPS_PROXY: realTarget ? process.env.HTTPS_PROXY : 'http://127.0.0.1:9',
          ALL_PROXY: realTarget ? process.env.ALL_PROXY : undefined,
        }, { executable: executable!, args: ['app-server'] })
        cleanupHarness = h
        h.server.bindLogicalFenceOwner(owner)
        h.send({
          id: 'initialize',
          method: 'initialize',
          params: { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } },
        })
        expect(JSON.parse(await h.read(15000)).id).toBe('initialize')
        if (realTarget) {
          expect(await h.server.nativeOwnerIdentity()).toMatch(/^desktop:[a-f0-9]{64}$/u)
        }
        const started = await h.server.nativeRequest('thread/start', {
          modelProvider: 'source',
          model: 'fixture-model',
          cwd: root,
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
        }) as any
        const source = started.thread.id as string
        const recorded = new Map<string, unknown>()
        const fixtureExecution = {
          settled: async () => {},
          creationDefaults: async () => ({ settings: {} }),
          read: (_host: string, threadId: string) =>
            threadId === source ? { application: 'applied', effective: started } : recorded.get(threadId),
          observationConfirmed: () => true,
          set: async (_host: string, threadId: string, settings: unknown) => {
            recorded.set(threadId, {
              application: 'applied',
              override: settings,
              effective: {
                ...started,
                reasoningEffort: (settings as { effort?: string }).effort ?? started.reasoningEffort,
                modelProvider: ['fork', 'channel-fork'].includes(mode) ? 'source' : 'target',
                model: 'fixture-model',
              },
            })
            return { override: settings }
          },
        }
        let persistedExecution: ChatExecutionPreferences | undefined
        if (explicitEffort && mode === 'linked') {
          const configPath = path.join(root, 'cordisx.json')
          await writeFile(
            configPath,
            JSON.stringify({
              ...createDefaultHomeConfig(),
              apps: {
                codex: {
                  defaultProfile: 'fixture',
                  profiles: { fixture: { displayName: 'Fixture', dataMode: 'shared' } },
                },
              },
            }),
          )
          persistedExecution = await ChatExecutionPreferences.open({
            file: path.join(root, 'execution.json'),
            configPath,
            appId: 'codex',
            profileId: 'fixture',
          })
          const capture = await persistedExecution.prepare('thread/start', {
            modelProvider: 'source',
            model: 'fixture-model',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            config: { model_reasoning_effort: 'low' },
          })
          if (!capture.captureId) throw new Error('SOURCE_CAPTURE_UNAVAILABLE')
          await persistedExecution.complete(capture.captureId, true, started)
          expect(persistedExecution.read('local', source)?.application).toBe('applied')
        }
        const execution = persistedExecution ?? fixtureExecution
        const expectWriteBlocked = async (id: string, threadId: string) => {
          h.send({
            id,
            method: 'turn/start',
            params: { threadId, input: [{ type: 'text', text: 'blocked', text_elements: [] }] },
          })
          for (let count = 0; count < 100; count++) {
            const message = JSON.parse(await h.read(15000))
            if (message.id === id) {
              expect(message).toMatchObject({ error: { code: -32000 } })
              return
            }
          }
          throw new Error('FENCE_RESPONSE_UNAVAILABLE')
        }
        const native = new ChannelNativeSessions({
          bridge: () =>
            ({
              call: async (_app: string, _operation: string, args: any) => {
                const response = await h.server.nativeRequest('turn/start', {
                  threadId: args.sessionId,
                  input: [{ type: 'text', text: args.prompt, text_elements: [] }],
                }) as any
                return { status: 'sent', sessionId: args.sessionId, turnId: response.turn?.id }
              },
            }) as never,
          nativeRequest: (method, params) => h.server.nativeRequest(method, params),
          cwd: root,
          nativeVersion: 'codex-cli 0.171.0-alpha.13',
          logicalOwnerIdentity: async () => 'desktop:fixture',
          logicalHandoffWriteGuardReady: () => h.server.logicalHandoffReady(),
          logicalMigrationLease: async sourceId => {
            const lease = await acquireChannelLogicalNativeLease(h.server, sourceId)
            if (lease.state !== 'acquired' || !['channel-checkpoint', 'channel-fork'].includes(mode)) return lease
            await expectWriteBlocked('blocked-source', sourceId)
            return {
              ...lease,
              nativeRequest: async (method, params) => {
                const result = await lease.nativeRequest(method, params)
                if (method === 'thread/start' || method === 'thread/fork') {
                  await expectWriteBlocked('blocked-destination', (result as any).thread.id)
                }
                return result
              },
            }
          },
          models: async () => ({
            providers: ['source', 'target'].map(providerId => ({
              providerId,
              models: [{ id: 'fixture-model' }],
            })),
          }),
          execution: execution as never,
          confirmedWorkMode: () => 'default',
          subscribeContinuationEvents: listener => h.server.subscribeContinuationEvents(listener),
        })
        h.server.bindLogicalHandoffPermits(native.logicalHandoffPermits)
        const control = {
          ...h.server,
          bindLogicalHistory(handler: (params: unknown) => Promise<unknown>) {
            h.server.bindLogicalHistory(async params => {
              historyCalls++
              historyArguments = (params as { arguments?: unknown }).arguments
              const result = await handler(params)
              if (result && typeof result === 'object' && 'success' in result && result.success === true) {
                historySuccess = true
                const body = (result as any).contentItems?.[0]?.text
                if (typeof body === 'string') {
                  const page = JSON.parse(body)
                  if (typeof page.source?.sessionId === 'string') historySources.push(page.source.sessionId)
                  const entries = JSON.stringify(page.entries ?? [])
                  if (
                    entries.includes('This is a message received through the configured CordisX Channel connection.')
                    || /\b[a-f0-9]{48}\b/iu.test(entries)
                  ) projectedContextLeak = true
                }
              }
              if (realTarget && JSON.stringify(result).includes('PAPERKITE')) historySeen = true
              return result
            })
          },
        }
        const composition = createDesktopLogicalComposition({
          control,
          owner,
          profileId: 'fixture',
          identity: async () => 'desktop:fixture',
          channelHistory: createChannelLogicalHistory({
            store,
            native: () => native,
            appId: 'codex',
            profileId: 'fixture',
          }),
        })
        composition.bindNative(native)
        const waitTurn = async (threadId: string, stage: string) => {
          for (let count = 0; count < 100; count++) {
            let line: string
            try {
              line = await h.read(realTarget ? 90000 : 10000)
            } catch (error) {
              throw new Error(`Native turn output unavailable at ${stage}; model calls: ${calls}`, { cause: error })
            }
            const message = JSON.parse(line)
            if (message.method === 'turn/completed' && message.params?.threadId === threadId) {
              expect(message.params.turn.status).toBe('completed')
              return
            }
            if (message.error) throw new Error('NATIVE_TURN_FAILED')
          }
          throw new Error('NATIVE_TURN_UNCONFIRMED')
        }
        h.send({
          id: 'source-turn',
          method: 'turn/start',
          params: { threadId: source, input: [{ type: 'text', text: 'Remember PAPERKITE', text_elements: [] }] },
        })
        await waitTurn(source, 'source')
        let projectId: string | undefined, sectionId: string | undefined
        if (placementMode) {
          // This fixture request uses the same public client connection as Desktop;
          // the Host's private bridge does not need project-creation authority.
          h.send({
            id: 'fixture-project',
            method: 'project/create',
            params: { name: 'Synthetic project', roots: [{ path: root }], idempotencyKey: 'fixture-project' },
          })
          for (let count = 0; count < 100 && !projectId; count++) {
            const message = JSON.parse(await h.read(10000))
            if (message.id !== 'fixture-project') continue
            if (message.error) throw new Error('FIXTURE_PROJECT_CREATION_FAILED')
            projectId = message.result?.project?.id
          }
          expect(projectId).toBeTruthy()
          await h.server.nativeRequest('thread/name/set', { threadId: source, name: 'Synthetic title' })
          await h.server.nativeRequest('thread/metadata/update', { threadId: source, projectId })
          const section = await h.server.nativeRequest('threadSection/create', { name: 'Synthetic section' }) as any
          sectionId = section.section.id
          await h.server.nativeRequest('thread/section/move', { threadId: source, sectionId, beforeThreadId: null })
        }
        const sourceConfig = await native.continuationConfiguration(source)
        expect(sourceConfig, 'Source execution configuration unavailable').toBeDefined()
        const migration = desktopLogicalMigration({
          owner,
          control: h.server,
          native: () => native,
          profileId: 'fixture',
          identity: async () => 'desktop:fixture',
          targetAllowed: async () => true,
          historyReady: () => composition.historyReady(),
        })
        const scope = {
          targetId: 'window',
          rendererGeneration: 'renderer',
          navigationGeneration: 1,
          composerId: 'composer',
          threadId: source,
        }
        const target = ['fork', 'channel-fork'].includes(mode)
          ? { providerId: 'source', model: 'fixture-model' }
          : realTarget
          ? { providerId: 'openai', model: 'gpt-6.1-terra' }
          : { providerId: 'target', model: 'fixture-model' }
        if (mode === 'channel-checkpoint' || mode === 'channel-fork') {
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
          const message = {
            contract: 'cordisx.channel-user-input/v1',
            schemaVersion: 1,
            role: 'user',
            content: [{ type: 'text', text: 'What was the codeword?' }],
            source: { kind: 'channel', event },
            receivedAt: new Date().toISOString(),
          } as const
          await store.mutate(state => {
            state.policy = parseChannelConversationPolicy({
              enabled: true,
              rules: [
                { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
                { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
              ],
            })
            state.taskConfig = parseChannelTaskConfig({
              permissions: [
                { id: 'target', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] },
              ],
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
            state.inputs.r = { recordId: 'r', input: message, accepted: true } as never
            state.jobs.j = {
              id: 'j',
              recordId: 'r',
              bindingId: 'b',
              autoCreate: false,
              state: 'queued',
              sessionId: source,
            }
            state.continuations[source] = {
              checkpoint: {
                threadId: source,
                revision: 1,
                goal: 'SYNTHETIC_CHECKPOINT',
                constraints: 'fixture constraints',
                completed: 'fixture done',
                remaining: 'fixture remaining',
                history: 'fixture history',
                continueAtIdle: false,
              },
            }
          })
          const result = await startChannelLogicalContinuation({
            store,
            native,
            fence: owner.fence,
            claims: new Set(),
            appId: 'codex',
            profileId: 'fixture',
            event,
            request: {
              contract: 'cordisx.conversation-continuation-request/v1',
              operationId: 'channel-operation',
              logicalConversationId: 'conversation',
              source: { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: source },
              expectedRevision: 0,
              target,
              ...(mode === 'channel-fork'
                ? { mode: 'fork' as const, historyConsent: 'inherit' as const }
                : {
                  mode: 'linked' as const,
                  historyConsent: 'on-demand' as const,
                  handoffConsent: 'checkpoint' as const,
                  historyCategories: ['user-text', 'assistant-text'] as const,
                }),
            },
          })
          expect(result).toMatchObject({ state: 'applied' })
          if (result.state !== 'applied') throw new Error('CHANNEL_MIGRATION_UNAVAILABLE')
          await store.mutate(state => expect(claimChannelDispatch(state, state.jobs.j!, event, undefined)).toBe(true))
          const handoff = channelLogicalHandoffForJob(store.snapshot(), 'j', event)
          if (mode === 'channel-checkpoint') expect(typeof handoff).toBe('string')
          const turn = await native.start(
            'j',
            message as never,
            result.destination.sessionId,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            mode === 'channel-checkpoint',
            typeof handoff === 'string' ? handoff : undefined,
          )
          expect(turn.state).toBe('running')
          expect(turn.turnId).toBeTruthy()
          await store.mutate(state => {
            if (mode === 'channel-checkpoint') {
              confirmChannelLogicalHandoff(state, 'j', result.destination.sessionId, turn.turnId!)
            }
            state.jobs.j!.turnId = turn.turnId
          })
          await waitTurn(result.destination.sessionId, 'channel checkpoint')
          if (mode === 'channel-checkpoint') {
            expect(handoffSeen).toBe(true)
            expect(historySuccess).toBe(true)
            expect(store.snapshot().logicalContinuations?.intents['channel-operation']?.handoffTurnId).toBe(turn.turnId)
          } else expect(historySeen).toBe(true)
          return
        }
        let channelCode: string | undefined
        if (mode === 'bound-linked') {
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
              permissions: [
                { id: 'target', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] },
              ],
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
            state.jobs.j = {
              id: 'j',
              recordId: 'r',
              bindingId: 'b',
              autoCreate: false,
              state: 'queued',
              sessionId: source,
            }
          })
          channelCode = (await migration.suggest(scope, target))?.channelChallenge
          expect(channelCode).toBeDefined()
          expect(
            await channelLogicalCommand({
              store,
              native,
              fence: owner.fence,
              claims: new Set(),
              appId: 'codex',
              profileId: 'fixture',
              event,
              recordId: 'grant',
              desktopGrants: owner.desktopChannelGrants,
              argument: 'authorize-desktop linked ' + target.providerId + ' ' + target.model
                + ' --history=user-assistant'
                + ' --no-checkpoint --challenge=' + channelCode,
            }),
          ).toContain('已授权')
        }
        const result = await migration.continue({
          scope,
          operationId: 'operation',
          target,
          mode: mode === 'fork' ? 'fork' : 'linked',
          ...(channelCode ? { channelCode } : {}),
          current: () => true,
          ...(explicitEffort && mode === 'linked' ? { targetReasoningEffort: 'high' as const } : {}),
          configOverrides: explicitEffort && mode === 'linked' ? { model_reasoning_effort: 'high' } : {},
        })
        expect(result, JSON.stringify(result)).toMatchObject({ state: 'applied', navigationReady: true })
        if (result?.state !== 'applied') throw new Error('MIGRATION_UNAVAILABLE')
        const destination = result.destination.sessionId
        if (explicitEffort && mode === 'linked') {
          expect(sourceConfig?.execution.effort).toBe('low')
          expect(store.snapshot().logicalContinuations?.intents.operation?.evidence).toMatchObject({
            sourceConfiguration: { execution: { effort: 'low' } },
            targetReasoningEffort: 'high',
          })
          expect(persistedExecution?.read('local', destination)).toMatchObject({ override: { effort: 'high' } })
          const reopened = await ChatExecutionPreferences.open({
            file: path.join(root, 'execution.json'),
            configPath: path.join(root, 'cordisx.json'),
            appId: 'codex',
            profileId: 'fixture',
          })
          expect(reopened.read('local', destination)).toMatchObject({ override: { effort: 'high' } })
          h.server.bindChatExecution(persistedExecution!)
        }
        if (placementMode) {
          const targetRead = await h.server.nativeRequest('thread/read', {
            threadId: destination,
            includeTurns: false,
          }) as any
          expect(targetRead.thread).toMatchObject({ name: 'Synthetic title', projectId, section: { id: sectionId } })
          const page = await h.server.nativeRequest('thread/list', {
            sectionId,
            includedThreadIds: [destination, source],
            sortKey: 'section_position',
            sortDirection: 'asc',
            limit: 2,
            modelProviders: [...new Set(['source', target.providerId])],
          }) as any
          expect(page.data.map((thread: any) => thread.id)).toEqual([destination, source])
        }
        if (mode === 'fork') {
          const inherited = await h.server.nativeRequest('thread/read', {
            threadId: destination,
            includeTurns: true,
          }) as any
          expect(JSON.stringify(inherited.thread.turns)).toContain('Remember PAPERKITE')
        }
        if (mode === 'bound-linked') {
          expect(store.snapshot().bindings.b?.sessionId).toBe(destination)
          expect(store.snapshot().jobs.j?.sessionId).toBe(destination)
        }
        expect(await migration.canNavigate({ ...scope, threadId: destination }, source)).toBe(true)
        expect(await migration.previous({ ...scope, threadId: destination })).toBe(source)
        const ticket = 'desktop-first-send-fixture-token'
        if (mode !== 'fork') expect(await composition.preparation!.attach(scope, destination, ticket)).toBe(true)
        h.consume.mockResolvedValueOnce({
          kind: 'dispatch',
          providerId: target.providerId,
          model: target.model,
          serviceGeneration: 'fixture',
          ...(explicitEffort && mode === 'linked' ? { reasoningEffort: 'high' } : {}),
          configOverrides: explicitEffort && mode === 'linked' ? { model_reasoning_effort: 'high' } : {},
        })
        h.send({
          id: 'target-turn',
          method: 'turn/start',
          params: {
            threadId: destination,
            input: [{ type: 'text', text: 'What was the codeword?', text_elements: [] }],
            config: { 'cordisx.operation_token': ticket },
          },
        })
        await waitTurn(destination, 'desktop')
        if (explicitEffort && mode === 'linked') expect(modelEfforts[1]).toBe('high')
        expect(historySeen, JSON.stringify({ calls, historyCalls, historySuccess, historyArguments })).toBe(true)
        if (realTarget) expect(calls).toBe(1)
        const read = await h.server.nativeRequest('thread/read', { threadId: destination, includeTurns: true }) as any
        expect(
          read.thread.turns.flatMap((turn: any) => turn.items).some((item: any) =>
            item.type === 'agentMessage' && item.text.includes('PAPERKITE')
          ),
        ).toBe(true)
        if (explicitEffort && mode === 'linked') {
          const next = await composition.preparation!.prepare({ ...scope, threadId: destination })
          if (next.state !== 'issued') throw new Error('NEXT_TURN_AUTHORITY_UNAVAILABLE')
          h.consume.mockResolvedValueOnce({
            kind: 'dispatch',
            providerId: target.providerId,
            model: target.model,
            serviceGeneration: 'fixture',
            configOverrides: {},
          })
          h.send({
            id: 'target-next-turn',
            method: 'turn/start',
            params: {
              threadId: destination,
              input: [{ type: 'text', text: 'Continue', text_elements: [] }],
              config: { 'cordisx.operation_token': next.token },
            },
          })
          await waitTurn(destination, 'later desktop turn')
          expect(modelEfforts[3]).toBe('high')
        }
        if (mode === 'bound-linked') {
          if (realTarget) return
          const event = store.snapshot().inputs.r!.input.source.event
          const historyBefore = historyCalls
          historySuccess = false
          const channelTurn = await native.start(
            'channel-turn',
            {
              contract: 'cordisx.channel-user-input/v1',
              schemaVersion: 1,
              role: 'user',
              content: [{ type: 'text', text: 'What was the codeword?' }],
              source: { kind: 'channel', event },
              receivedAt: new Date().toISOString(),
            },
            destination,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          )
          expect(channelTurn.state).toBe('running')
          await waitTurn(destination, 'channel')
          expect(historyCalls).toBeGreaterThan(historyBefore)
          expect(historySuccess).toBe(true)
          await store.mutate(state => {
            state.inputs.r!.input = {
              contract: 'cordisx.channel-user-input/v1',
              schemaVersion: 1,
              role: 'user',
              content: [{ type: 'text', text: 'What was the codeword?' }],
              source: { kind: 'channel', event },
              receivedAt: new Date().toISOString(),
            }
            state.jobs.j!.state = 'completed'
            state.jobs.j!.turnId = channelTurn.turnId
          })
          const nextScope = { ...scope, threadId: destination }
          const nextTarget = { providerId: 'source', model: 'fixture-model' }
          const suggestion = await migration.suggest(nextScope, nextTarget)
          expect(suggestion?.linkedAvailable).toBe(true)
          const challenge = suggestion?.channelChallenge
          expect(
            await channelLogicalCommand({
              store,
              native,
              fence: owner.fence,
              claims: new Set(),
              appId: 'codex',
              profileId: 'fixture',
              event,
              recordId: 'second-grant',
              desktopGrants: owner.desktopChannelGrants,
              argument:
                'authorize-desktop linked source fixture-model --history=user-assistant --no-checkpoint --challenge='
                + challenge,
            }),
          ).toContain('已授权')
          const second = await migration.continue({
            scope: nextScope,
            operationId: 'second-operation',
            target: nextTarget,
            mode: 'linked',
            channelCode: challenge,
            current: () => true,
            configOverrides: {},
          })
          expect(second).toMatchObject({ state: 'applied', navigationReady: true })
          if (second?.state !== 'applied') throw new Error('SECOND_MIGRATION_UNAVAILABLE')
          const secondTicket = 'desktop-second-send-fixture-token'
          expect(await composition.preparation!.attach(nextScope, second.destination.sessionId, secondTicket)).toBe(
            true,
          )
          h.consume.mockResolvedValueOnce({
            kind: 'dispatch',
            providerId: nextTarget.providerId,
            model: nextTarget.model,
            serviceGeneration: 'fixture',
            configOverrides: {},
          })
          historySources.length = 0
          h.send({
            id: 'second-target-turn',
            method: 'turn/start',
            params: {
              threadId: second.destination.sessionId,
              input: [{ type: 'text', text: 'Continue the conversation', text_elements: [] }],
              config: { 'cordisx.operation_token': secondTicket },
            },
          })
          await waitTurn(second.destination.sessionId, 'second desktop')
          expect(historySources).toEqual([destination, source])
          expect(projectedContextLeak).toBe(false)
          await h.close()
          cleanupHarness = undefined
          await store.close()
          cleanupStore = undefined
          const reopened = await ChannelConversationStore.open(path.join(root, 'state.json'))
          cleanupStore = reopened
          let headlessNative: ChannelNativeSessions | undefined
          let headlessHistory: ReturnType<typeof createChannelLogicalHistory> | undefined
          const listeners = new Set<(method: string, params: unknown) => void>()
          let finish!: () => void
          const completed = new Promise<void>(resolve => {
            finish = resolve
          })
          const backend = await startHeadlessCodexBackend({
            codexExecutable: executable!,
            codexHome: root,
            home: root,
            environment: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              FIXTURE_API_KEY: 'fixture',
              NO_PROXY: '127.0.0.1,localhost',
              HTTP_PROXY: 'http://127.0.0.1:9',
              HTTPS_PROXY: 'http://127.0.0.1:9',
            },
            onRequest: async (method, params) => {
              if (method !== 'item/tool/call' || !headlessHistory) throw new Error('UNEXPECTED_NATIVE_REQUEST')
              const response = await headlessHistory(params)
              if (response.success) historySuccess = true
              return response
            },
            onNotification: (method, params) => {
              listeners.forEach(listener => listener(method, params))
              if (method === 'turn/completed' && (params as any)?.threadId === second.destination.sessionId) finish()
            },
            onDispatch: (operationId, threadId, turnId) =>
              headlessNative?.observedDispatch(operationId, threadId, turnId),
          })
          try {
            headlessNative = new ChannelNativeSessions({
              bridge: () => backend as never,
              nativeRequest: backend.nativeRequest,
              cwd: root,
              logicalOwnerIdentity: async () => 'desktop:fixture',
              execution: { creationDefaults: async () => ({ settings: {} }) } as never,
              subscribeContinuationEvents: listener => {
                listeners.add(listener)
                return () => listeners.delete(listener)
              },
            })
            headlessHistory = createChannelLogicalHistory({
              store: reopened,
              native: () => headlessNative,
              appId: 'codex',
              profileId: 'fixture',
            })
            historySuccess = false
            const afterRestart = await headlessNative.start(
              'after-restart',
              {
                contract: 'cordisx.channel-user-input/v1',
                schemaVersion: 1,
                role: 'user',
                content: [{ type: 'text', text: 'Continue after restart' }],
                source: { kind: 'channel', event },
                receivedAt: new Date().toISOString(),
              },
              second.destination.sessionId,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            )
            expect(afterRestart.state).toBe('running')
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                completed,
                new Promise((_, reject) => {
                  timeout = setTimeout(() => reject(new Error('TURN_TIMEOUT')), 30000)
                }),
              ])
            } finally {
              clearTimeout(timeout)
            }
            expect(historySuccess).toBe(true)
          } finally {
            await backend.close()
            await reopened.close()
            cleanupStore = undefined
          }
        }
      } finally {
        const results = await Promise.allSettled([
          cleanupStore?.close(),
          cleanupHarness?.close(),
          model.listening ? new Promise<void>(resolve => model.close(() => resolve())) : undefined,
        ])
        await rm(root, { recursive: true, force: true })
        const failures = results.filter(result => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
      }
    },
    120000,
  )
})
