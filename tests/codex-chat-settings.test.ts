import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { createCodexChatSettings } from '../packages/cli/src/launcher/codex-chat-settings.js'
import { createNativeAgentModelsHandler } from '../packages/cli/src/launcher/native-agent-models.js'

test('generic settings resolve only the explicit/current chat, retain revisions and never infer defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-settings-'))
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const preferences = await ChatExecutionPreferences.open({
    file: path.join(root, 'chats.json'),
    configPath,
    appId: 'codex',
    profileId: 'default',
  })
  const exists = vi.fn(async (id: string) => ['current', 'other'].includes(id))
  const execution = createCodexChatSettings({ native: { executionPreferences: () => preferences, exists } })
  try {
    expect(await execution('execution-settings-set', { settings: { effort: 'high' }, expectedRevision: 0 }))
      .toMatchObject({ status: 'rejected', code: 'SESSION_REQUIRED' })
    expect(exists).not.toHaveBeenCalled()
    const metadata = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'current' }) }
    expect(await execution('execution-settings-set', { settings: { effort: 'high' }, expectedRevision: 0 }, metadata))
      .toMatchObject({
        status: 'ok',
        sessionId: 'current',
        scope: 'chat',
        settings: { application: 'saved', revision: 1 },
      })
    expect(await execution('execution-settings', { sessionId: 'other' }, metadata)).toMatchObject({
      settings: null,
      sessionId: 'other',
    })
    expect(await execution('execution-settings', { sessionId: null }, metadata)).toMatchObject({ status: 'rejected' })
    expect(await execution('execution-settings-set', { settings: {}, expectedRevision: 0 }, metadata)).toMatchObject({
      code: 'REVISION_CONFLICT',
    })
    expect(await execution('execution-defaults', {}, metadata)).toMatchObject({
      revision: 0,
      settings: {},
      scope: 'creation-defaults',
    })
    await execution('execution-defaults-set', { settings: { execution: 'read-only' }, expectedRevision: 0 })
    expect(preferences.read('local', 'current')?.override).toEqual({ effort: 'high' })
    const turn = await preferences.prepare('turn/start', { threadId: 'current', model: 'native-model' })
    expect(turn.params.effort).toBe('high')
    await execution('execution-settings-set', { settings: null, expectedRevision: 1 }, metadata)
    expect(preferences.read('local', 'current')?.override).toBeUndefined()
  } finally {
    await preferences.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP and generic settings retain Channel authorization before touching preferences', async () => {
  const set = vi.fn(), exists = vi.fn(async () => true)
  const guard = vi.fn(async () => ({ status: 'rejected', code: 'CHANNEL_PERMISSION_REQUIRED' }))
  const execution = createCodexChatSettings({
    native: { executionPreferences: () => ({ set }) as never, exists },
    guard,
  })
  const catalog = vi.fn(async () => [])
  const authority = {
    catalog,
    controller: {},
    switchThread: vi.fn(),
    reserve: vi.fn(),
    commit: vi.fn(),
    release: vi.fn(),
    execution,
  } as any
  const handler = createNativeAgentModelsHandler(authority)
  const metadata = { 'openai/threadId': 'channel-chat', 'cordisx/channelContext': 'c'.repeat(48) }
  expect(
    await handler(
      'execution:execution-settings-set',
      { settings: { execution: 'full-access' }, expectedRevision: 0 },
      metadata,
    ),
  )
    .toMatchObject({ status: 'rejected', code: 'CHANNEL_PERMISSION_REQUIRED' })
  expect(guard).toHaveBeenCalledWith(
    'execution-settings-set',
    expect.objectContaining({ sessionId: 'channel-chat' }),
    metadata,
  )
  expect(set).not.toHaveBeenCalled()
  expect(catalog).not.toHaveBeenCalled()
  expect(
    await createNativeAgentModelsHandler({ ...authority, preparing: () => true })(
      'execution:execution-defaults',
      {},
      metadata,
    ),
  )
    .toEqual({ status: 'rejected', reason: 'preparation-read-only' })
})
