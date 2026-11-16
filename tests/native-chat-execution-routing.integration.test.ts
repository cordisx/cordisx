import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'

describe('native execution and provider routing composition', () => {
  it('applies creation preferences without losing the exact managed provider, token, effort or input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-execution-routing-'))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    const preferences = await ChatExecutionPreferences.open({
      file: path.join(root, 'execution.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    await preferences.setDefaults(
      { execution: 'workspace-write', approval: 'never', effort: 'low', workMode: 'plan' },
      0,
    )
    const h = await harness()
    h.server.bindChatExecution(preferences)
    try {
      h.send({
        id: 'create',
        method: 'thread/start',
        params: {
          cwd: root,
          config: { keep: 'native-config', 'cordisx.operation_token': 'allowed-with-effort-token' },
        },
      })
      const created = JSON.parse(await h.read()).result
      expect(created.received).toMatchObject({
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        modelProvider: 'provider-b',
        model: 'model-b',
        config: { keep: 'native-config', model_provider: 'provider-b', model_reasoning_effort: 'xhigh' },
      })
      expect(created.received.config).not.toHaveProperty('cordisx.operation_token')
      h.send({
        id: 'send',
        method: 'turn/start',
        params: {
          threadId: 'created-thread',
          cwd: root,
          model: 'previous-model',
          input: [{ type: 'text', text: 'private draft' }],
          config: { 'cordisx.operation_token': 'allowed-with-effort-token' },
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
        },
      })
      const completed = JSON.parse(await h.read()).result
      expect(completed.received).toMatchObject({
        threadId: 'created-thread',
        model: 'model-b',
        effort: 'xhigh',
        input: [{ type: 'text', text: 'private draft' }],
        collaborationMode: { mode: 'plan', settings: { model: 'model-b', reasoning_effort: 'xhigh' } },
      })
      expect(completed.received).not.toHaveProperty('config')
      expect(h.consume).toHaveBeenCalledTimes(2)
      expect(h.complete).toHaveBeenCalledTimes(2)
    } finally {
      await h.close()
      await preferences.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
