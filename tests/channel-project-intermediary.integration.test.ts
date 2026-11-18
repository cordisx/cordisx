import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'

test(
  'project first-turn configuration crosses the authenticated intermediary with native tool context and strict roots',
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-native-project-')))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    const preferences = await ChatExecutionPreferences.open({
      file: path.join(root, 'execution.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    const h = await harness(undefined, 'native-project-app-server.mjs', undefined, {
      CORDISX_PROJECT_FIXTURE_ROOT: root,
    })
    let configuration: CodexChatConfiguration | undefined
    try {
      h.server.bindChatExecution(preferences)
      h.send({ id: 'ready', method: 'initialize', params: { clientInfo: { name: 'project-fixture', version: '1' } } })
      await h.read()
      configuration = await CodexChatConfiguration.open({
        preferences,
        file: path.join(root, 'configuration.json'),
        request: (method, params) => h.server.nativeRequest(method, params),
        tool: input => h.server.invokeCodexTool(input),
        catalog: async () => [{
          providerId: 'openai',
          pluginId: 'codex',
          models: [{ id: 'fixture-model', label: 'Model', aliases: [], supportsFastMode: true }],
        }],
      })
      const bridge = createCodexBridgeHandler({
        catalog: () => configuration!.catalog(),
        nativeRequest: (method, params) => h.server.nativeRequest(method, params),
        prepareProject: (projectId, readonly) => configuration!.prepareProject(projectId, readonly),
        bindCreatedProject: (threadId, projectId) => configuration!.bindCreatedProject(threadId, projectId),
      }, '/outside')
      const result = await bridge('start_session', {
        operationId: 'project-first',
        projectId: 'repo',
        prompt: 'work',
        execution: { execution: 'full-access', approval: 'never' },
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'started', sessionId: 'project-chat' })
      const read = await h.server.nativeRequest('thread/read', { threadId: 'project-chat', includeTurns: false }) as {
        requests: { method: string; params: Record<string, any> }[]
      }
      const start = read.requests.find(row => row.method === 'thread/start')!
      const turn = read.requests.find(row => row.method === 'turn/start')!
      const move = read.requests.find(row => row.params.tool === 'move_thread_to_project')!
      expect(start.params).toMatchObject({
        cwd: root,
        sandbox: 'workspace-write',
        permissions: null,
        config: { 'sandbox_workspace_write.writable_roots': [root], 'sandbox_workspace_write.exclude_slash_tmp': true },
      })
      expect(turn.params).toMatchObject({
        cwd: root,
        permissions: null,
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [root],
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      })
      expect(move.params).toMatchObject({
        server: 'codex_app',
        threadId: 'project-chat',
        tool: 'move_thread_to_project',
        arguments: { threadId: 'project-chat', projectId: 'repo', hostId: 'local' },
        _meta: { 'openai/threadId': 'project-chat' },
      })
      expect(read.requests.indexOf(move)).toBeLessThan(read.requests.indexOf(turn))
      expect(await configuration.call('project', { sessionId: 'project-chat' })).toMatchObject({
        effective: { projectId: 'repo' },
      })
    } finally {
      await configuration?.close()
      await h.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)
