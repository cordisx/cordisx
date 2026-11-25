import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { a, account, b, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { channelMemoryServiceConnection } from '../packages/cli/src/launcher/channel-user-memory-connection.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { configuredChannelCliContext } from '../packages/cli/src/launcher/channel-cli-context.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'

it(
  'production consumer and native prompt use actual tool-free HTTP inference and existing memory CLI read/update',
  async () => {
    const f = await fixture(), root = path.dirname(f.file), requests: any[] = [], prompts: string[] = []
    const mock = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push(JSON.parse(body))
      const request = requests.at(-1), text = request.input[0].content[0].text
      if (!request.prompt_cache_key) {
        res.writeHead(460).end()
        return
      }
      const assertions = text.includes('青杉')
        ? [{ key: 'name', category: 'name', title: '称呼', value: '青杉', evidence: '我叫青杉' }]
        : text.includes('搭档')
        ? [{ key: 'relationship', category: 'relationship', title: '关系', value: '搭档', evidence: '我是你的搭档' }]
        : []
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ assertions }) }] }],
        }),
      )
    })
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
    const port = (mock.address() as { port: number }).port
    const cli = configuredChannelCliContext(root, 'default')
    // Test process invokes the emitted package; source test paths are not a deployed CLI.
    const entry = path.resolve('packages/cli/dist/src/cli.js')
    let session = a, turn = 0
    const failures: unknown[] = []
    const execute = async (action: string, args: unknown, token: string) => {
      const options = { env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: session }, timeout: 10000 }
      const argv = [
        entry,
        'channel',
        'memory',
        action,
        '--profile',
        'default',
        '--context',
        token,
        '--input',
        JSON.stringify(args),
      ]
      let output: string
      try {
        output = (await promisify(execFile)(process.execPath, argv, options)).stdout
      } catch (error) {
        output = (error as { stdout: string }).stdout
        if (!output) throw new Error((error as { stderr?: string }).stderr ?? 'CLI failed without output')
      }
      return JSON.parse(output)
    }
    const native = new ChannelNativeSessions({
      cwd: root,
      cli: { ...cli, entry },
      models: async () => ({ providers: [{ providerId: 'synthetic', models: [{ id: 'fixture' }] }] }),
      sourceConfiguration: async () => ({
        providerId: 'synthetic',
        model: 'fixture',
        reasoningEffort: 'low',
        serviceTier: null,
      }),
      memoryConnect: channelMemoryServiceConnection({
        providers: [{
          kind: 'model-service',
          id: 'synthetic',
          displayName: 'Synthetic',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'SYNTHETIC_KEY',
          protocols: ['openai-responses'],
          models: { codex: ['fixture'] },
        }],
        environmentVariables: [],
      }, { SYNTHETIC_KEY: 'synthetic-not-a-secret' }),
      nativeRequest: async (_method, params) => ({
        thread: { id: params.threadId, modelProvider: 'synthetic', model: 'fixture', status: { type: 'idle' } },
      }),
      bridge: () =>
        ({
          call: async (_app: string, _operation: string, args: any) => {
            prompts.push(args.prompt)
            turn++
            native.observedDispatch(args.operationId, session, `turn-${turn}`)
            if (turn === 3) {
              try {
                const token = /--context '([a-f0-9]{48})'/u.exec(args.prompt)![1]!
                const found = await execute('search-page', { query: '' }, token)
                expect(found.status).toBe('ok')
                expect(found.result.cards).toHaveLength(2)
                const record = await execute('get', { id: found.result.cards[0].id }, token)
                expect(record.result.owner).toMatch(/^[a-f0-9]{64}$/u)
                expect(record.result.summary).toMatch(/青杉|搭档/u)
                expect(args.prompt).toContain(record.result.summary)
                const { kind, title, summary, tags, entityRefs, evidenceType, confidence } = record.result
                const updated = await execute('update', {
                  id: record.result.id,
                  revision: record.result.revision,
                  record: {
                    kind,
                    title,
                    summary: summary + ' (user correction)',
                    tags,
                    entityRefs,
                    evidenceType,
                    confidence,
                  },
                }, token)
                expect(updated).toMatchObject({ status: 'ok', result: { id: record.result.id, revision: 2 } })
                expect((await execute('get', { id: record.result.id }, token)).result.userMemory.key).toBe(
                  record.result.userMemory.key,
                )
                expect(await execute('get', { id: found.result.cards[0].id }, 'a'.repeat(48))).toMatchObject({
                  status: 'rejected',
                })
              } catch (error) {
                failures.push(error)
              }
            }
            return { status: 'sent', sessionId: session, turnId: `turn-${turn}` }
          },
        }) as never,
    })
    Object.assign(f.native, {
      start: vi.fn(native.start.bind(native)),
      analyzeUserMemory: native.analyzeUserMemory.bind(native),
      taskSelection: native.taskSelection.bind(native),
      creationSelection: async () => ({ providerId: 'synthetic', model: 'fixture' }),
    })
    f.consumer.setNativeExtras(() => native)
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    const tools = new ChannelConversationTools(() => f.access, f.consumer),
      handler = configuredChannelManagementToolHandler(tools)
    const rpc = await startPluginManagementRpcServer({
      homeDir: root,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'fixture',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as never,
      channel: async (operation, value, metadata) => {
        try {
          return await handler.channel!(operation, value, metadata)
        } catch (error) {
          failures.push(error)
          return { status: 'rejected', code: String(error) }
        }
      },
    })
    try {
      await f.consumer.policySet({ enabled: true }, 0)
      await f.consumer.bind({ channel: channel(), mode: 'deliver' }, a)
      await f.consumer.bind({ channel: channel('oc_group', 'group'), mode: 'deliver' }, b)
      await f.consumer.receive('intro', message('intro', '我叫青杉'))
      await settle(f.consumer)
      await f.consumer.receive('relationship', message('relationship', '我是你的搭档'))
      await settle(f.consumer)
      session = b
      await f.consumer.receive('recall', message('recall', '认识我是谁吗？', channel('oc_group', 'group')), true)
      await settle(f.consumer)
      expect(prompts).toHaveLength(3)
      expect(prompts[2]).toContain('"status":"found"')
      expect(prompts[2]).toContain('我叫青杉')
      expect(prompts[2]).toContain('我是你的搭档')
      expect(requests).toHaveLength(2)
      expect(requests[0].prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/u)
      expect(requests[1].prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/u)
      expect(requests[0].prompt_cache_key).not.toBe(requests[1].prompt_cache_key)
      expect(requests[0].prompt_cache_key).not.toContain(account.userId)
      for (const request of requests) {
        expect(request).toMatchObject({
          model: 'fixture',
          tools: [],
          tool_choice: 'none',
          store: false,
          stream: false,
          text: { format: { type: 'json_schema', strict: true } },
        })
        expect(request.input).toHaveLength(1)
        expect(JSON.stringify(request.input)).not.toContain(account.userId)
      }
      expect(failures).toEqual([])
    } finally {
      await rpc.close()
      await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()))
    }
  },
  20000,
)
