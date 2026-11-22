import { createServer } from 'node:http'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type EventMap, normalize } from '@larksuiteoapi/node-sdk'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'
import { startHeadlessService } from '../packages/cli/src/cli/headless-service.js'
import { logicalContinuationChain } from '../packages/cli/src/launcher/logical-continuation-chain.js'

const { sdkFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<typeof import('@larksuiteoapi/node-sdk')>(),
  createLarkChannel: sdkFactory,
}))

const executable = process.env.CORDISX_LOGICAL_NATIVE_TEST_EXECUTABLE
const realTarget = process.env.CORDISX_LOGICAL_NATIVE_REAL_TARGET === '1'
const forkMode = process.env.CORDISX_LOGICAL_NATIVE_FORK === '1'
const checkpointMode = process.env.CORDISX_LOGICAL_NATIVE_CHECKPOINT === '1'
const sectionMode = process.env.CORDISX_LOGICAL_NATIVE_SECTION === '1'
const projectMode = process.env.CORDISX_LOGICAL_NATIVE_PROJECT === '1'
const chainMode = process.env.CORDISX_LOGICAL_NATIVE_CHAIN === '1'
const initialModeUnset = process.env.CORDISX_LOGICAL_NATIVE_UNSET_MODE === '1'
const longSource = process.env.CORDISX_LOGICAL_NATIVE_LONG_SOURCE === '1'
describe.skipIf(!executable)('isolated native Channel continuation', () => {
  it('moves a real owned native session and retrieves authorized synthetic history', async () => {
    if (
      forkMode && (realTarget || initialModeUnset || checkpointMode || chainMode) || checkpointMode && realTarget
      || chainMode && (realTarget || initialModeUnset || checkpointMode || longSource)
    ) {
      throw new Error('FIXTURE_CONFIGURATION_INVALID')
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-logical-service-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const replies: string[] = []
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect: async () => {},
      send: async (_target: unknown, value: { text?: string }) => {
        replies.push(value.text ?? '')
        return { messageId: 'om_reply' }
      },
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
    })
    let modelCalls = 0, markerReturned = false, checkpointObserved = false, chainPromptContainedMarker = false
    const reports: string[] = []
    const historyDiagnostics: Array<
      { success: boolean; marker: boolean; next: boolean; entries?: unknown; truncated?: unknown }
    > = []
    const modelDiagnostics: unknown[] = []
    const model = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      modelCalls++
      if (chainMode && modelCalls === 3) chainPromptContainedMarker = body.includes('PAPERKITE')
      const toolCallNumber = chainMode || initialModeUnset ? 3 : 2
      if (modelCalls === toolCallNumber && body.includes('SYNTHETIC_CHECKPOINT')) checkpointObserved = true
      let nextCursor: string | undefined
      const visit = (value: unknown): void => {
        if (typeof value === 'string') {
          try {
            visit(JSON.parse(value))
          } catch { /* Text need not be JSON. */ }
        } else if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>
          if (typeof record.nextCursor === 'string' && /^[a-f0-9]{48}$/u.test(record.nextCursor)) {
            nextCursor = record.nextCursor
          }
          Object.values(record).forEach(visit)
        }
      }
      visit(JSON.parse(body))
      const parsed = JSON.parse(body) as { input?: Array<{ type?: string; role?: string; output?: unknown }> }
      modelDiagnostics.push({
        number: modelCalls,
        marker: body.includes('PAPERKITE'),
        cursor: !!nextCursor,
        input: parsed.input?.map(item => item.type),
        outputs: parsed.input?.filter(item => item.type === 'function_call_output')
          .map(item => ({
            type: typeof item.output,
            bytes: JSON.stringify(item.output).length,
            text: JSON.stringify(item.output).slice(0, 240),
          })),
      })
      const requestPage = !forkMode && (modelCalls === toolCallNumber
        || modelCalls > toolCallNumber && !body.includes('PAPERKITE') && !!nextCursor)
      const item = requestPage
        ? {
          type: 'function_call',
          id: 'fc_fixture_' + modelCalls,
          call_id: 'call_fixture_' + modelCalls,
          name: 'cordisx_continuation_history',
          arguments: JSON.stringify(nextCursor ? { cursor: nextCursor } : {}),
          status: 'completed',
        }
        : {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{
            type: 'output_text',
            text: modelCalls < toolCallNumber ? 'SOURCE_ACK' : body.includes('PAPERKITE') ? 'PAPERKITE' : 'NO_MARKER',
            annotations: [],
          }],
        }
      if ((forkMode ? modelCalls > 1 : modelCalls > toolCallNumber) && body.includes('PAPERKITE')) markerReturned = true
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
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    let service: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    try {
      const address = model.address()
      if (!address || typeof address === 'string') throw new Error('FIXTURE_UNAVAILABLE')
      if (realTarget) {
        await copyFile(path.join(os.homedir(), '.codex', 'auth.json'), path.join(root, 'auth.json'))
        await chmod(path.join(root, 'auth.json'), 0o600)
      }
      const provider = (id: string) =>
        '[model_providers.' + id + ']\nname="fixture"\nbase_url="http://127.0.0.1:'
        + address.port + '/v1"\nenv_key="FIXTURE_API_KEY"\nwire_api="responses"\n'
      await writeFile(
        path.join(root, 'config.toml'),
        'model_provider="source"\nmodel="fixture-model"\n'
          + provider('source') + provider('target'),
      )
      const configPath = path.join(root, 'config.json')
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          apps: {
            codex: { defaultProfile: 'fixture', profiles: { fixture: { displayName: 'Fixture', dataMode: 'shared' } } },
          },
          plugins: [{
            id: 'channel',
            entry: bundledPluginEntry('channel'),
            services: {
              runtime: {
                profiles: {
                  fixture: {
                    revision: 1,
                    lastGoodRevision: 1,
                    config: {
                      contract: 'cordisx.channel-service-config/v1',
                      schemaVersion: 1,
                      connections: [{
                        ref,
                        adapterKind: 'feishu',
                        enabled: true,
                        transport: { mode: 'websocket' },
                        secretRef: 'host-secret:env/CHANNEL_KEY',
                      }],
                    },
                  },
                },
              },
            },
          }],
        }),
      )
      service = await startHeadlessService({
        configPath,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        userHome: root,
        codexHome: root,
        codexExecutable: executable!,
        cwd: root,
        generation: 'fixture',
        report: code => {
          reports.push(code)
        },
        environment: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          NO_PROXY: '127.0.0.1,localhost',
          HTTP_PROXY: realTarget ? process.env.HTTP_PROXY : 'http://127.0.0.1:9',
          HTTPS_PROXY: realTarget ? process.env.HTTPS_PROXY : 'http://127.0.0.1:9',
          ALL_PROXY: realTarget ? process.env.ALL_PROXY : undefined,
          HOME: root,
          CODEX_HOME: root,
          FIXTURE_API_KEY: 'fixture',
          CHANNEL_KEY: 'fixture',
          CORDISX_HEADLESS_PROVIDER_ID: 'source',
          CORDISX_HEADLESS_MODEL_ID: 'fixture-model',
          CORDISX_HEADLESS_EXTRA_PROVIDER: realTarget ? 'openai' : 'target',
          CORDISX_HEADLESS_EXTRA_MODELS: realTarget ? 'gpt-6.1-terra' : 'fixture-model',
        },
      })
      const consumer = service.channel!.consumer!
      await consumer.policySet({
        enabled: true,
        autoCreate: true,
        autoReply: false,
        rules: [
          { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['ou_actor'] },
          { id: 'commands', action: 'command', effect: 'allow', userIds: ['ou_actor'] },
        ],
      }, 0)
      await consumer.taskSettings.call('task-config-set', {
        config: {
          defaults: { providerId: 'source', model: 'fixture-model' },
          permissions: [{ id: 'grant', effect: 'allow', userIds: ['ou_actor'], fields: ['providerId', 'model'] }],
        },
        expectedRevision: 0,
      })
      await consumer.executionOperation('channel-execution-defaults-set', {
        expectedRevision: 0,
        settings: {
          ...(initialModeUnset ? {} : { workMode: 'default' }),
          execution: 'read-only',
          approval: 'on-request',
          effort: 'low',
        },
      })
      const emit = async (id: string, text: string) =>
        handlers.message!(
          await normalize({
            sender: { sender_id: { open_id: 'ou_actor' }, sender_type: 'user', tenant_key: 'fixture' },
            message: {
              message_id: id,
              chat_id: 'oc_direct',
              chat_type: 'p2p',
              create_time: String(Date.now()),
              message_type: 'text',
              content: JSON.stringify({ text }),
            },
          } as never, { includeRaw: true }),
        )
      await emit('om_source', longSource ? 'Remember PAPERKITE ' + 'x'.repeat(10000) : 'Remember PAPERKITE')
      await vi.waitFor(async () => {
        await consumer.pump()
        expect(consumer.bindings()).toHaveLength(1)
        expect(modelCalls).toBeGreaterThanOrEqual(1)
      }, { timeout: 30000 })
      const source = consumer.bindings()[0]!.sessionId
      let sectionId: string | undefined
      let projectId: string | undefined
      if (projectMode) {
        const native = (consumer as any).extraNative()
        const project = await native.input.nativeRequest('project/create', {
          name: 'Synthetic continuation project',
          roots: [{ path: root }],
          idempotencyKey: 'fixture-project',
        })
        projectId = project.project.id
        await native.input.nativeRequest('thread/metadata/update', { threadId: source, projectId })
      }
      if (sectionMode) {
        const native = (consumer as any).extraNative()
        const section = await native.input.nativeRequest('threadSection/create', {
          name: 'Synthetic continuation section',
        })
        sectionId = section.section.id
        await native.input.nativeRequest('thread/section/move', { threadId: source, sectionId, beforeThreadId: null })
      }
      const statePath = path.join(root, 'apps', 'codex', 'profiles', 'fixture', 'channel-conversations.json')
      await vi.waitFor(async () => {
        await consumer.pump()
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        expect(Object.values(state.jobs).some((job: any) => job.sessionId === source && job.state === 'completed'))
          .toBe(true)
      }, { timeout: 30000 })
      if (initialModeUnset) {
        await emit(
          'om_unconfirmed',
          '/continue-provider linked target fixture-model --history=user,assistant --no-checkpoint',
        )
        await vi.waitFor(async () => {
          await consumer.pump()
          expect(replies.some(text => text.includes('/work-mode default'))).toBe(true)
        }, { timeout: 30000 })
        expect(consumer.bindings()[0]!.sessionId).toBe(source)
        await emit('om_mode', '/work-mode default')
        await vi.waitFor(async () => {
          await consumer.pump()
          expect(replies.some(text => text.includes('下一 turn 应用'))).toBe(true)
        }, { timeout: 30000 })
        await emit('om_apply_mode', 'Apply the selected work mode.')
        await vi.waitFor(async () => {
          await consumer.pump()
          const state = JSON.parse(await readFile(statePath, 'utf8'))
          expect(Object.values(state.jobs).filter((job: any) => job.sessionId === source && job.state === 'completed'))
            .toHaveLength(2)
        }, { timeout: 30000 })
      }
      if (checkpointMode) {
        await consumer.continuation.setCheckpoint(source, {
          goal: 'SYNTHETIC_CHECKPOINT',
          constraints: 'fixture constraints',
          completed: 'fixture done',
          remaining: 'fixture remaining',
          history: 'fixture background',
          continueAtIdle: false,
        }, 0)
      }
      await emit(
        'om_migrate',
        forkMode
          ? '/continue-provider fork source fixture-model --history=inherit --no-checkpoint'
          : realTarget
          ? '/continue-provider linked openai gpt-6.1-terra --history=user,assistant --no-checkpoint'
          : '/continue-provider linked target fixture-model --history=user,assistant '
            + (checkpointMode ? '--checkpoint' : '--no-checkpoint'),
      )
      await vi.waitFor(async () => {
        await consumer.pump()
        expect(consumer.bindings()[0]!.sessionId !== source || replies.some(text => text.includes('结果尚未确认')))
          .toBe(true)
      }, { timeout: 30000 })
      expect(consumer.bindings()[0]!.sessionId).not.toBe(source)
      const target = consumer.bindings()[0]!.sessionId
      if (projectMode) {
        const native = (consumer as any).extraNative()
        const targetRead = await native.input.nativeRequest('thread/read', { threadId: target, includeTurns: false })
        expect(targetRead.thread.projectId).toBe(projectId)
      }
      let authorizedPages = 0, leakedContext = false
      const historyCall = consumer.logicalHistoryCall.bind(consumer)
      consumer.logicalHistoryCall = async params => {
        const result = await historyCall(params)
        const page = JSON.parse(result.contentItems[0]?.text ?? '{}')
        const visibleEntries = JSON.stringify(page.entries ?? [])
        if (
          /This is a message received through the configured CordisX Channel connection\.|--context\s|\b[a-f0-9]{48}\b/iu
            .test(visibleEntries)
        ) {
          leakedContext = true
        }
        historyDiagnostics.push({
          success: result.success,
          marker: JSON.stringify(result).includes('PAPERKITE'),
          next: typeof page.nextCursor === 'string',
          entries: page.entries?.map((entry: any) => ({
            size: entry.text?.length,
            marker: entry.text?.includes('PAPERKITE'),
          })),
          truncated: page.truncated,
        })
        if (result.success && JSON.stringify(result).includes('PAPERKITE')) authorizedPages++
        return result
      }
      await emit(
        'om_followup',
        'What codeword did I ask you to remember? Reply only with the codeword.',
      )
      await vi.waitFor(async () => {
        await consumer.pump()
        if (!realTarget && !chainMode) expect(markerReturned).toBe(true)
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        expect(Object.values(state.jobs).some((job: any) => job.sessionId === target && job.state === 'completed'))
          .toBe(true)
      }, { timeout: realTarget ? 90000 : 10000 })
      if (sectionMode) {
        const native = (consumer as any).extraNative()
        const list = () =>
          native.input.nativeRequest('thread/list', {
            sectionId,
            includedThreadIds: [target, source],
            sortKey: 'section_position',
            sortDirection: 'asc',
            limit: 2,
            modelProviders: forkMode ? ['source'] : ['source', 'target'],
            sourceKinds: [
              'cli',
              'vscode',
              'exec',
              'appServer',
              'subAgent',
              'subAgentReview',
              'subAgentCompact',
              'subAgentThreadSpawn',
              'subAgentOther',
              'unknown',
            ],
          })
        await vi.waitFor(async () => {
          const result = await list()
          expect(result.data.map((thread: any) => thread.id)).toEqual([target, source])
        }, { timeout: 5000, interval: 250 })
      }
      let finalTarget = target
      if (chainMode) {
        await emit(
          'om_migrate_again',
          '/continue-provider linked source fixture-model --history=user,assistant --no-checkpoint',
        )
        await vi.waitFor(async () => {
          await consumer.pump()
          expect(consumer.bindings()[0]!.sessionId).not.toBe(target)
        }, { timeout: 30000 })
        finalTarget = consumer.bindings()[0]!.sessionId
        expect(finalTarget).not.toBe(source)
        await emit('om_final', 'What codeword did I ask you to remember? Reply only with the codeword.')
        await vi.waitFor(async () => {
          await consumer.pump()
          expect(markerReturned).toBe(true)
          const state = JSON.parse(await readFile(statePath, 'utf8'))
          expect(
            Object.values(state.jobs).some((job: any) => job.sessionId === finalTarget && job.state === 'completed'),
          )
            .toBe(true)
        }, { timeout: 30000 })
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        expect(Object.values(state.logicalContinuations.relations)).toHaveLength(2)
        const chain = logicalContinuationChain({ snapshot: () => state } as never, 'codex', 'fixture', {
          sessionId: finalTarget,
        })
        expect(chain.links.map(link => [link.source, link.destination])).toEqual([[source, target], [
          target,
          finalTarget,
        ]])
        expect(chainPromptContainedMarker).toBe(false)
        expect(historyDiagnostics.some(page => page.success && page.next && !page.marker)).toBe(true)
        expect(historyDiagnostics.some(page => page.success && page.marker)).toBe(true)
      }
      const native = (consumer as any).extraNative()
      if (realTarget) expect(await native.logicalOwnerIdentity()).toMatch(/^desktop:[a-f0-9]{64}$/u)
      const read = await native.input.nativeRequest('thread/read', { threadId: finalTarget, includeTurns: true })
      const messages = read.thread.turns.flatMap((turn: any) => turn.items)
      expect(messages.some((item: any) => item.type === 'agentMessage' && item.text.includes('PAPERKITE'))).toBe(true)
      if (checkpointMode) {
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        const intents = Object.values(state.logicalContinuations.intents) as any[]
        const committed = intents.find(intent => intent.destination?.sessionId === target)
        expect(committed?.evidence.handoff).toBe('checkpoint')
        expect(state.jobs[committed.handoffJobId]).toMatchObject({ sessionId: target, state: 'completed' })
        expect(committed.handoffTurnId).toBe(state.jobs[committed.handoffJobId].turnId)
        expect(committed.handoffTurnId).toEqual(expect.any(String))
      }
      if (forkMode) expect(authorizedPages).toBe(0)
      else expect(authorizedPages).toBeGreaterThan(0)
      expect(checkpointObserved).toBe(checkpointMode)
      expect(leakedContext).toBe(false)
      if (longSource) {
        expect(historyDiagnostics.some(page => page.success && page.next && page.truncated)).toBe(true)
        expect(historyDiagnostics.length).toBeGreaterThan(1)
      }
      if (realTarget) expect(modelCalls).toBe(initialModeUnset ? 2 : 1)
    } catch (error) {
      const state = await readFile(
        path.join(root, 'apps', 'codex', 'profiles', 'fixture', 'channel-conversations.json'),
        'utf8',
      )
        .then(text => JSON.parse(text)).catch(() => ({}))
      console.error(
        'Fixture state:',
        JSON.stringify({
          modelCalls,
          reports,
          replies,
          historyDiagnostics,
          modelDiagnostics,
          jobs: Object.values(state.jobs ?? {}).map((job: any) => ({ state: job.state, code: job.code })),
          intents: Object.values(state.logicalContinuations?.intents ?? {}).map((intent: any) => ({
            state: intent.state,
            code: intent.code,
            hasDestination: !!intent.destination,
          })),
        }),
      )
      throw error
    } finally {
      await service?.close()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  }, 180000)
})
