import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'

it('real CLI recovers rejected memory writes in the same turn and reads only an explicitly granted source in another chat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-cli-recovery-'))
  const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
  const sessionA = '01a10000-0000-7000-8000-000000000001', sessionB = '01a10000-0000-7000-8000-000000000002'
  const cli = {
    node: process.execPath,
    entry: fileURLToPath(new URL('../packages/cli/dist/src/cli.js', import.meta.url)),
    home: root,
    profile: 'default',
  }
  let phase = 0, active = false, session = sessionA, context = '', storedId = '', grantId = ''
  const turns = new Map<string, { id: string; status: string }[]>()
  const failures: unknown[] = []
  let notify: (method: string, params: unknown) => void = () => {}
  const valid = {
    kind: 'fact',
    title: 'Cedar deployment',
    summary: 'Cedar deployment finished; validation pending',
    tags: ['Cedar'],
    entityRefs: ['cedar'],
    evidenceType: 'verified',
    confidence: 1,
  }
  const command = async (action: string, value: unknown, token = context) => {
    let output: string
    try {
      output = (await promisify(execFile)(cli.node, [
        cli.entry,
        'channel',
        'memory',
        action,
        '--profile',
        'default',
        '--context',
        token,
        '--input',
        JSON.stringify(value),
      ], { env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: session }, timeout: 10000 })).stdout
    } catch (error) {
      output = (error as { stdout: string }).stdout
    }
    return JSON.parse(output)
  }
  const native = new ChannelNativeSessions({
    cli,
    cwd: root,
    subscribeContinuationEvents: listener => {
      notify = listener
      return () => {}
    },
    nativeRequest: async (method, params) =>
      method === 'thread/read'
        ? { thread: { id: params.threadId, status: { type: active ? 'active' : 'idle' } } }
        : { data: turns.get(String(params.threadId)) ?? [] },
    bridge: () =>
      ({
        call: async (_app: string, _operation: string, request: { operationId: string; prompt: string }) => {
          if (!['start_session', 'send_message'].includes(_operation)) return {}
          phase++
          active = true
          session = phase === 2 || phase === 4 || phase === 6 ? sessionB : sessionA
          const turn = 'turn-' + phase
          const currentTurn = { id: turn, status: 'inProgress' }
          turns.set(session, [...(turns.get(session) ?? []), currentTurn])
          try {
            context = /--context '([a-f0-9]{48})'/u.exec(request.prompt)![1]!
            native.observedDispatch(request.operationId, session, turn)
            expect(request.prompt).toContain('confidence is a JSON number')
            expect(request.prompt).toContain('input-ack')
            if (phase === 1) {
              const failed = await command('remember', { record: { ...valid, kind: 'task', confidence: 'high' } })
              expect(failed).toMatchObject({ status: 'rejected', code: 'MEMORY_INVALID_RECORD', retrySafe: true })
              expect(failed.issues.map((issue: { field: string }) => issue.field)).toEqual(['kind', 'confidence'])
              expect(await command('search', { query: 'Cedar' })).toMatchObject({ status: 'ok', result: [] })
              expect(await command('remember', valid)).toMatchObject({
                status: 'rejected',
                retrySafe: true,
                issues: [{ field: 'record' }],
              })
              const saved = await command('remember', { record: valid })
              expect(saved.status).toBe('ok')
              storedId = saved.result.id
              const badUpdate = await command('update', {
                id: storedId,
                revision: 1,
                record: { ...valid, kind: 'decision' },
              })
              expect(badUpdate).toMatchObject({ status: 'rejected', retrySafe: true })
              expect((await command('get', { id: storedId })).result.revision).toBe(1)
              expect(
                await command('update', {
                  id: storedId,
                  revision: 1,
                  record: { ...valid, summary: 'Cedar validation passed: SYNTH-27' },
                }),
              )
                .toMatchObject({ status: 'ok', result: { revision: 2 } })
              expect(await command('update', { id: storedId, revision: 1, record: valid }))
                .toMatchObject({ status: 'rejected', code: 'MEMORY_REVISION_CONFLICT' })
            } else if (phase === 2 || phase === 6) {
              expect(await command('search', { query: 'Cedar' })).toMatchObject({ status: 'ok', result: [] })
              expect(await command('get', { id: storedId })).toMatchObject({
                status: 'rejected',
                code: 'MEMORY_NOT_FOUND',
              })
            } else if (phase === 3) {
              const granted = await command('grant', { grant: { target: { kind: 'conversation', id: 'oc_B' } } })
              expect(granted.status).toBe('ok')
              grantId = granted.result.id
            } else if (phase === 4) {
              const hits = await command('search', { query: 'Cedar' })
              expect(hits.result[0].id).toBe(storedId)
              const read = await command('get', { id: storedId })
              expect(read.result.summary).toContain('SYNTH-27')
              // Deterministic consumer fixture uses the returned fact; this does not establish a real model's reasoning.
              const answer = `According to stored evidence: ${read.result.summary}`
              expect(answer).toContain('validation passed: SYNTH-27')
            } else if (phase === 5) expect(await command('revoke', { id: grantId })).toMatchObject({ status: 'ok' })
          } catch (error) {
            failures.push(error)
          }
          currentTurn.status = 'completed'
          active = false
          notify('turn/completed', { threadId: session, turn: { id: turn } })
          return { status: 'started', sessionId: session, turnId: turn }
        },
      }) as never,
  })
  const access: any = {
    generation: 'fixture',
    accounts: () => [{ ref, state: 'ready' }],
    runtime: { inputsSince: async (_caller: unknown, _filter: unknown, cursor: string) => ({ cursor, messages: [] }) },
  }
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'default',
    access: () => access,
    native: () => native,
  })
  consumer.setNativeExtras(() => native)
  const tools = new ChannelConversationTools(() => access, consumer),
    handler = configuredChannelManagementToolHandler(tools)
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'fixture',
    processStartedAt: (await processStartIdentity(process.pid))!,
    service: {} as never,
    channel: handler.channel,
  })
  try {
    await consumer.policySet({ enabled: true, autoReply: false }, 0)
    await consumer.memoryAuthority.configure({ ...ref, userId: 'admin' }, [{ ...ref, conversationId: 'oc_A' }], 0)
    const inputs = [
      ['oc_A', 'admin', 'save useful progress'],
      ['oc_B', 'member', 'what is Cedar progress?'],
      ['oc_A', 'admin', 'Share source memory with B'],
      ['oc_B', 'member', 'what is Cedar progress?'],
      ['oc_A', 'admin', 'Revoke sharing'],
      ['oc_B', 'member', 'what is Cedar progress?'],
    ]
    for (const [conversationId, userId, text] of inputs) {
      const id = 'om_' + (phase + 1)
      await consumer.receive(id, {
        contract: 'cordisx.channel-user-input/v1',
        schemaVersion: 1,
        role: 'user',
        receivedAt: new Date().toISOString(),
        source: {
          kind: 'channel',
          event: {
            ...ref,
            conversationId: conversationId!,
            threadId: conversationId!,
            kind: 'group',
            semantics: 'conversation',
            eventId: id,
            messageId: id,
            actor: { ...ref, userId: userId! },
          },
        },
        content: [{ type: 'text', text: text! }],
      }, true)
      await consumer.pump()
      await consumer.pump()
      await consumer.pump()
    }
    expect(phase).toBe(6)
    expect(failures).toEqual([])
  } finally {
    await server.close()
    tools.dispose()
    await consumer.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
