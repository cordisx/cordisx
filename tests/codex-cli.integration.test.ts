import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { createCodexChatSettings } from '../packages/cli/src/launcher/codex-chat-settings.js'
import { nativeCodexSettings } from '../packages/cli/src/launcher/native-codex-settings-composition.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import {
  pluginManagementRpcPaths,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import { startNativeAgentModelsServer } from '../packages/cli/src/launcher/native-agent-models.js'
import { nativeCodexOperations } from '../packages/cli/src/cli/production-plugin-management.js'
import { configuredChannelToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'

test(
  'compiled CLI uses the guarded live owner, persists exact settings and keeps model credentials private',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-'))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(config => ({
      ...config,
      defaultApp: 'claude',
      apps: { ...config.apps, claude: config.apps.codex! },
      providers: [{
        id: 'gateway',
        kind: 'cli-proxy-api',
        displayName: 'Gateway',
        baseUrl: 'http://127.0.0.1:8317/v1',
        apiKeyEnv: 'GATEWAY_KEY',
      }],
    }), configPath)
    const preferences = await ChatExecutionPreferences.open({
      file: path.join(root, 'chats.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    const settings = createCodexChatSettings({
      native: {
        executionPreferences: () => preferences,
        exists: async id => ['current', 'other', 'channel-chat'].includes(id),
      },
    })
    const agent = new ChannelAgentAccess(() => ({ jobs: {}, bindings: {}, inputs: {} }) as never, () => undefined)
    const consumer = {
      agentAccess: agent,
      taskSettings: { isBound: (id: string) => id === 'channel-chat' },
      executionOperation: settings,
    }
    const tools = new ChannelConversationTools(() => undefined, consumer as never)
    const nativeRead = vi.fn(async (method: string, input: Record<string, unknown>) => {
      if (method === 'thread/settings/update') {
        await preferences.observe(String(input.threadId), input)
        return {}
      }
      return {
        thread: {
          id: ['current', 'other', 'channel-chat'].includes(String(input.threadId)) ? input.threadId : undefined,
          modelProvider: 'configured',
          model: 'model',
          cwd: root,
          status: { type: 'idle' },
          sandbox: { type: 'workspaceWrite' },
        },
      }
    })
    const configuration = await CodexChatConfiguration.open({
      preferences,
      file: path.join(root, 'configuration.json'),
      request: nativeRead,
      catalog: async () => [{
        providerId: 'configured',
        pluginId: 'host',
        defaultModelId: 'model',
        models: [{ id: 'model', label: 'Model', aliases: [], supportsFastMode: true }],
      }],
      guard: configuredChannelToolHandler(tools).chatSettingsGuard,
      tool: async input => ({
        content: [{
          type: 'text',
          text: JSON.stringify(
            input.tool === 'list_projects'
              ? { projects: [{ projectId: 'p', projectKind: 'local', hostId: 'local', path: root }] }
              : input.tool === 'list_threads'
              ? { threads: [{ id: 'other', hostId: 'local', projectId: 'p' }] }
              : { status: 'moved' },
          ),
        }],
      }),
    })
    const { execution, modelServices: models, configuration: configured } = nativeCodexSettings({
      execution: preferences,
      configuration,
      configPath,
      options: configuredChannelToolHandler(tools),
      control: { nativeRequest: nativeRead } as never,
    })
    const selected = vi.fn(async () => {})
    const endpoint = await startNativeAgentModelsServer()
    endpoint.bind({
      catalog: async () => [{
        providerId: 'configured',
        pluginId: 'host',
        models: [{ id: 'model', label: 'Model', aliases: [] }],
      }],
      controller: {
        prepareThreadResume: async () => ({ kind: 'resume', resumeToken: 'lease', configOverrides: {} }) as never,
        completeThreadResume: async () => true,
      },
      switchThread: selected,
      reserve: () => true,
      commit: () => {},
      release: () => {},
      execution,
      configuration: configured,
      modelServices: models,
    })
    let current: { codex: typeof endpoint.call } | undefined = { codex: endpoint.call }
    const server = await startPluginManagementRpcServer({
      homeDir: root,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'test',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as never,
      codex: nativeCodexOperations(() => current as never),
    })
    const command = async (args: string[], session?: string) => {
      const env = { ...process.env, CORDISX_HOME: root }
      delete env.CODEX_THREAD_ID
      delete env.CODEX_TURN_ID
      if (session) env.CODEX_THREAD_ID = session
      const result = await promisify(execFile)(process.execPath, [
        path.resolve('packages/cli/dist/src/cli.js'),
        ...args,
      ], {
        env,
        timeout: 10_000,
        maxBuffer: 131_072,
      }).then(value => ({ ...value, code: 0 })).catch(error => ({
        stdout: error.stdout,
        stderr: error.stderr,
        code: error.code,
      }))
      return { code: result.code, result: JSON.parse((result.stdout || result.stderr).trim()) }
    }
    try {
      expect(await command(['codex', 'chats', 'settings', 'set', '--revision', '0', '--effort', 'high']))
        .toMatchObject({ code: 1, result: { code: 'SESSION_REQUIRED' } })
      expect((await command(['codex', 'defaults', 'get'])).result).toMatchObject({ revision: 0, settings: {} })
      expect(await command(['codex', 'providers', 'list'])).toMatchObject({
        code: 0,
        result: { providers: [{ providerId: 'configured' }] },
      })
      expect(
        await command([
          'codex',
          'defaults',
          'model',
          'set',
          '--revision',
          '0',
          '--provider',
          'configured',
          '--model',
          'model',
          '--fast',
          'false',
        ]),
      )
        .toMatchObject({
          code: 0,
          result: { status: 'ok', revision: 1, settings: { providerId: 'configured', model: 'model', fast: false } },
        })
      expect(await command(['codex', 'chats', 'fast', 'set', '--revision', '0', '--fast', 'true'], 'current'))
        .toMatchObject({ code: 0, result: { status: 'applied', fast: true, revision: 1 } })
      expect(await command(['codex', 'chats', 'fast', 'set', '--revision', '1', '--fast', 'false'], 'current'))
        .toMatchObject({ code: 0, result: { status: 'applied', fast: false, revision: 2 } })
      expect(
        await command(['codex', 'chats', 'project', 'set', '--revision', '0', '--session', 'other', '--project', 'p']),
      )
        .toMatchObject({ code: 0, result: { status: 'applied', project: { projectId: 'p' }, revision: 1 } })
      expect(await command(['codex', 'chats', 'fast', 'set', '--revision', '0', '--fast', 'true'], 'channel-chat'))
        .toMatchObject({ code: 1, result: { code: 'CHANNEL_CONTEXT_UNAVAILABLE' } })
      expect(
        await command(['codex', 'chats', 'provider', 'set', '--provider', 'configured', '--model', 'model'], 'current'),
      )
        .toMatchObject({ code: 0, result: { status: 'selected', threadId: 'current' } })
      expect(selected).toHaveBeenCalledOnce()
      expect(
        await command([
          'codex',
          'chats',
          'settings',
          'set',
          '--revision',
          '0',
          '--effort',
          'high',
          '--work-mode',
          'plan',
        ], 'current'),
      )
        .toMatchObject({ code: 0, result: { settings: { revision: 1, application: 'saved' } } })
      const turn = await preferences.prepare('turn/start', {
        threadId: 'current',
        model: 'native-model',
        input: [{ type: 'text', text: 'continue' }],
      })
      expect(turn.params).toMatchObject({
        model: 'native-model',
        effort: 'high',
        collaborationMode: { mode: 'plan' },
        input: [{ text: 'continue' }],
      })
      expect(await command(['codex', 'chats', 'settings', 'get', '--session', 'other'], 'current'))
        .toMatchObject({ code: 0, result: { sessionId: 'other', settings: null } })
      expect(nativeRead).toHaveBeenCalledWith('thread/read', { threadId: 'other', includeTurns: false })
      expect(await command(['codex', 'chats', 'settings', 'get', '--session', 'missing']))
        .toMatchObject({ code: 1, result: { code: 'SESSION_NOT_FOUND' } })
      expect(await command(['codex', 'chats', 'settings', 'set', '--revision', '0', '--effort', 'low'], 'current'))
        .toMatchObject({ code: 1, result: { code: 'REVISION_CONFLICT' } })
      expect(
        await command(
          ['codex', 'chats', 'settings', 'set', '--revision', '0', '--execution', 'full-access'],
          'channel-chat',
        ),
      )
        .toMatchObject({ code: 1, result: { code: 'CHANNEL_CONTEXT_UNAVAILABLE' } })
      expect(
        await command([
          'codex',
          'defaults',
          'set',
          '--revision',
          '0',
          '--approval',
          'never',
          '--context',
          '0'.repeat(48),
        ], 'current'),
      )
        .toMatchObject({ code: 1, result: { code: 'CHANNEL_CONTEXT_UNAVAILABLE' } })
      expect(preferences.read('local', 'channel-chat')).toBeUndefined()
      const list = (await command(['models', 'services', 'list'])).result
      const privateFile = path.join(root, 'private.json')
      await writeFile(
        privateFile,
        JSON.stringify({
          expectedRevision: list.revision,
          services: [{
            id: 'test',
            displayName: 'Test',
            baseUrl: 'https://test.invalid',
            protocols: ['openai-responses'],
            codexModels: ['model'],
            claudeModels: [],
            enabled: true,
            apiKey: 'sk-private-test',
            httpHeadersPatch: { 'X-Private': 'header-secret' },
          }],
        }),
        { mode: 0o600 },
      )
      expect(await command(['models', 'services', 'save', '--input-file', privateFile], 'channel-chat'))
        .toMatchObject({ code: 1, result: { code: 'CHANNEL_CONTEXT_UNAVAILABLE' } })
      expect(await command(['models', 'services', 'save', '--input-file', privateFile]))
        .toMatchObject({ code: 0, result: { status: 'applied', applies: 'app-restart' } })
      const readback = await command(['models', 'services', 'list'])
      expect(readback.result.services).toMatchObject([{
        id: 'test',
        keyConfigured: true,
        httpHeaderNames: ['X-Private'],
      }])
      expect(JSON.stringify(readback)).not.toMatch(/sk-private-test|header-secret/u)
      expect(JSON.parse(await readFile(configPath, 'utf8')).providers.map((item: any) => item.id)).toEqual([
        'gateway',
        'test',
      ])
      await command(['codex', 'chats', 'settings', 'reset', '--revision', '1'], 'current')
      expect(preferences.read('local', 'current')?.override).toBeUndefined()
      const statePath = pluginManagementRpcPaths(root, 'codex', 'default').state
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      await writeFile(statePath, JSON.stringify({ ...state, processStartedAt: 'stale' }))
      expect(await command(['codex', 'capabilities'])).toMatchObject({
        code: 1,
        result: { code: 'CODEX_RUNTIME_OWNER_UNVERIFIABLE' },
      })
      await writeFile(statePath, JSON.stringify(state))
      current = undefined
      expect(await command(['codex', 'capabilities'])).toMatchObject({
        code: 1,
        result: { code: 'CODEX_RUNTIME_UNAVAILABLE' },
      })
      current = { codex: endpoint.call }
      await endpoint.close()
      expect(await command(['codex', 'capabilities'])).toMatchObject({
        code: 1,
        result: { code: 'CODEX_RUNTIME_UNAVAILABLE' },
      })
    } finally {
      tools.dispose()
      await server.close()
      await endpoint.close()
      await preferences.close()
      await configuration.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
