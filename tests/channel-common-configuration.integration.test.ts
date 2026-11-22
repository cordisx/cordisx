import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { configuredChannelToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { nativeCodexOperations } from '../packages/cli/src/cli/production-plugin-management.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import { startNativeAgentModelsServer } from '../packages/cli/src/launcher/native-agent-models.js'

test(
  'compiled common CLI retains the Channel actor, persists approvals and applies Fast/project only after approval',
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-common-config-')))
    const project = path.join(root, 'repository'), configPath = path.join(root, 'config.json')
    await mkdir(project)
    await ensureHomeConfig(configPath)
    const id = '01a10000-0000-7000-8000-000000000001'
    const account = { adapterId: 'feishu', accountId: 'test', tenantId: 'test' }
    const source = {
      ...account,
      conversationId: 'oc_test',
      threadId: 'oc_test',
      kind: 'group' as const,
      semantics: 'conversation' as const,
      eventId: 'om_test',
      actor: { ...account, userId: 'alice' },
    }
    const { eventId: _event, actor: _actor, ...channel } = source
    const preferences = await ChatExecutionPreferences.open({
      file: path.join(root, 'execution.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    let actual: Record<string, unknown> = {
      id,
      modelProvider: 'openai',
      model: 'm',
      serviceTier: null,
      approvalsReviewer: 'user',
      cwd: root,
      status: { type: 'idle' },
      sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
    }
    let membership: string | undefined, updates = 0, turns = 0
    const catalog = [{
      providerId: 'openai',
      pluginId: 'codex',
      defaultModelId: 'm',
      models: [{ id: 'm', label: 'Model', aliases: [], supportsFastMode: true }],
    }]
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/read') return { thread: { ...actual } }
      if (method === 'thread/settings/update') {
        updates++
        actual = { ...actual, ...params, ...(params.sandboxPolicy ? { sandbox: params.sandboxPolicy } : {}) }
        await preferences.observe(id, actual)
        return {}
      }
      if (method === 'turn/start') turns++
      throw new Error(`Unexpected native request: ${method}`)
    }
    let consumer: ChannelConversationConsumer, configuration: CodexChatConfiguration
    let contextToken = ''
    const native = new ChannelNativeSessions({
      bridge: () =>
        ({
          call: async (_app: string, _op: string, args: { prompt: string }) => {
            contextToken = /--context '([a-f0-9]{48})'/u.exec(args.prompt)![1]!
            return { status: 'started', sessionId: id, turnId: 'turn' }
          },
        }) as never,
      cwd: root,
      nativeRequest: request,
      cli: {
        node: process.execPath,
        entry: path.resolve('packages/cli/dist/src/cli.js'),
        home: root,
        profile: 'default',
      },
      execution: preferences,
      models: async () => ({ providers: catalog }),
      get configuration() {
        return configuration
      },
    })
    const access = {
      generation: 'test',
      accounts: () => [{ ref: account, state: 'ready' }],
      sendCard: async () => 'om_card',
      updateCard: async () => {},
    } as never
    consumer = await ChannelConversationConsumer.open({
      file: path.join(root, 'consumer.json'),
      profileId: 'default',
      access: () => access,
      native: () => native,
    })
    consumer.setNativeExtras(() => native)
    const tools = new ChannelConversationTools(() => access, consumer)
    const handlers = configuredChannelToolHandler(tools)
    configuration = await CodexChatConfiguration.open({
      preferences,
      file: path.join(root, 'configuration.json'),
      request,
      catalog: async () => catalog,
      guard: handlers.chatSettingsGuard,
      tool: async input => {
        let value: object
        if (input.tool === 'list_projects') {
          value = {
            projects: [{
              projectId: 'repo',
              label: 'Repository',
              path: project,
              projectKind: 'local',
              hostId: 'local',
            }],
          }
        } else if (input.tool === 'move_thread_to_project') {
          membership = String(input.arguments.projectId)
          value = { status: 'moved' }
        } else value = { threads: [{ id, hostId: 'local', projectId: membership }] }
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      },
    })
    const endpoint = await startNativeAgentModelsServer()
    endpoint.bind({
      catalog: async () => catalog,
      configuration: (op, args, meta) => configuration.call(op, args, meta),
      controller: {} as never,
      switchThread: async () => {},
      reserve: () => true,
      commit: () => {},
      release: () => {},
    })
    const server = await startPluginManagementRpcServer({
      homeDir: root,
      configPath,
      appId: 'codex',
      profileId: 'default',
      generation: 'test',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as never,
      codex: nativeCodexOperations(() => ({ codex: endpoint.call }) as never),
    })
    const command = async (args: string[], context = contextToken) => {
      const env = { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: id }
      delete env.CODEX_TURN_ID
      const result = await promisify(execFile)(process.execPath, [
        path.resolve('packages/cli/dist/src/cli.js'),
        'codex',
        'chats',
        ...args,
        '--context',
        context,
      ], { env, timeout: 10_000, maxBuffer: 131_072 })
        .catch(error => ({ stdout: error.stdout || error.stderr }))
      return JSON.parse(result.stdout.trim())
    }
    try {
      await consumer.bind({ channel }, id)
      expect(
        await native.start('fixture-input', {
          contract: 'cordisx.channel-user-input/v1',
          schemaVersion: 1,
          role: 'user',
          content: [{ type: 'text', text: 'Configure this task.' }],
          receivedAt: new Date().toISOString(),
          source: { kind: 'channel', event: source },
        }, id),
      ).toMatchObject({ state: 'running' })
      await consumer.taskSettings.call('task-config-set', {
        expectedRevision: 0,
        config: {
          permissions: [{
            id: 'owner',
            userIds: ['owner'],
            effect: 'allow',
            fields: ['fast'],
            fastModes: [true, false],
          }, {
            id: 'owner-project',
            userIds: ['owner'],
            effect: 'allow',
            fields: ['projectId'],
            projectIds: ['repo'],
          }],
        },
      })
      expect(await command(['fast', 'set', '--fast', 'true', '--revision', '0'], '0'.repeat(48)))
        .toMatchObject({ code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
      expect(await command(['fast', 'set', '--fast', 'true', '--revision', '0']))
        .toMatchObject({ application: 'approval-required' })
      expect(updates).toBe(0)
      let pending = consumer.taskSettings.requests(source)[0]!
      const persisted = JSON.parse(await readFile(path.join(root, 'consumer.json'), 'utf8')).taskRequests[pending.id]
      expect(persisted).toMatchObject({
        state: 'pending',
        patch: { fast: true },
        source: { actor: { userId: 'alice' } },
      })
      const owner = { ...source, actor: { ...source.actor, userId: 'owner' } }
      await consumer.taskSettings.answer(owner, pending.id, 'accept')
      await consumer.taskSettings.pump()
      expect(await consumer.taskSettings.read(id)).toMatchObject({ application: 'applied', settings: { fast: true } })
      expect(updates).toBe(1)
      expect(await command(['project', 'set', '--project', 'repo', '--revision', '1']))
        .toMatchObject({ application: 'approval-required' })
      pending = consumer.taskSettings.requests(source)[0]!
      expect(pending.patch).toEqual({ projectId: 'repo' })
      await consumer.taskSettings.answer(owner, pending.id, 'accept')
      await consumer.taskSettings.pump()
      expect(await consumer.taskSettings.read(id)).toMatchObject({
        application: 'applied',
        settings: { projectId: 'repo', fast: true },
      })
      expect(actual).toMatchObject({
        cwd: project,
        sandbox: { type: 'workspaceWrite', writableRoots: [project], excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      })
      expect(membership).toBe('repo')
      expect(updates).toBe(2)
      expect(turns).toBe(0)
      expect(await command(['reviewer', 'set', '--session', id, '--reviewer', 'auto_review', '--revision', '2']))
        .toMatchObject({ code: 'LOCAL_USER_REQUIRED' })
      expect(updates).toBe(2)
      const env = { ...process.env, CORDISX_HOME: root }
      delete env.CODEX_THREAD_ID
      delete env.CODEX_TURN_ID
      const local = await promisify(execFile)(process.execPath, [
        path.resolve('packages/cli/dist/src/cli.js'),
        'codex',
        'chats',
        'reviewer',
        'set',
        '--session',
        id,
        '--reviewer',
        'auto_review',
        '--revision',
        '2',
      ], { env, timeout: 10_000, maxBuffer: 131_072 })
      expect(JSON.parse(local.stdout)).toMatchObject({ status: 'applied', revision: 3 })
      expect(actual).toMatchObject({ approvalsReviewer: 'auto_review', cwd: project })
      expect(updates).toBe(3)
    } finally {
      await server.close()
      await endpoint.close()
      tools.dispose()
      await consumer.dispose()
      await configuration.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
