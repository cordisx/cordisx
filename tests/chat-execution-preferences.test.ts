import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { nativeExecutionTurn } from '../packages/cli/src/chat-execution-settings.js'
const services: ChatExecutionPreferences[] = [], roots: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-execution-'))
  roots.push(root)
  const configPath = path.join(root, 'config.json'), file = path.join(root, 'chats.json')
  await ensureHomeConfig(configPath)
  const service = await ChatExecutionPreferences.open({ file, configPath, appId: 'codex', profileId: 'default' })
  services.push(service)
  return { service, root, file, configPath }
}
describe('user-owned chat execution preferences', () => {
  it('captures new-chat defaults without modifying older chats; never and scope remain independent', async () => {
    const { service } = await fixture()
    await service.setDefaults({ execution: 'workspace-write', approval: 'never', workMode: 'plan', effort: 'low' }, 0)
    const capture = await service.prepare('thread/start', { cwd: '/tmp', model: 'model' })
    expect(capture.params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' })
    await service.complete(capture.captureId!, true, {
      thread: { id: 'chat' },
      model: 'model',
      cwd: '/tmp',
      sandbox: { type: 'workspaceWrite', networkAccess: false },
      approvalPolicy: 'never',
      reasoningEffort: 'low',
    })
    expect(service.read('local', 'chat')?.application).toBe('submitted')
    await service.setDefaults({ execution: 'full-access' }, 1)
    expect(service.read('local', 'chat')?.capturedDefaults.execution).toBe('workspace-write')
    const turn = await service.prepare('turn/start', { threadId: 'chat' }, { model: 'model', cwd: '/tmp' })
    expect(turn.params).toMatchObject({ collaborationMode: { mode: 'plan' } })
    expect(turn.params).not.toHaveProperty('sandboxPolicy')
    await service.complete(turn.captureId!, true, { turn: { id: 'turn' } })
    await service.observe('chat', { collaborationMode: { mode: 'default' } })
    expect(service.read('local', 'chat')?.application).toBe('submitted')
    await service.observe('chat', {
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      approvalPolicy: 'never',
      effort: 'low',
      collaborationMode: { mode: 'plan' },
    })
    expect(service.read('local', 'chat')?.application).toBe('applied')
    const later = await service.prepare('turn/start', {
      threadId: 'chat',
      collaborationMode: { mode: 'default', settings: { model: 'model', reasoning_effort: 'high' } },
    })
    expect(later.params).toMatchObject({
      collaborationMode: { mode: 'default', settings: { reasoning_effort: 'high' } },
    })
  })
  it('ignores old acknowledgements after a newer override, persists exact host/chat keys and supports reset', async () => {
    const { service, file, configPath } = await fixture()
    await service.set('local', 'chat', { execution: 'read-only' }, 0)
    const capture = await service.prepare('turn/start', { threadId: 'chat' })
    await service.set('local', 'chat', { execution: 'full-access' }, 1)
    await service.complete(capture.captureId!, true, { turn: { id: 'old' } })
    expect(service.read('local', 'chat')).toMatchObject({
      revision: 2,
      application: 'saved',
      override: { execution: 'full-access' },
    })
    expect(service.read('remote', 'chat')).toBeUndefined()
    const reopened = await ChatExecutionPreferences.open({ file, configPath, appId: 'codex', profileId: 'default' })
    services.push(reopened)
    expect(reopened.read('local', 'chat')?.override?.execution).toBe('full-access')
    await reopened.set('local', 'chat', null, 2)
    expect(reopened.read('local', 'chat')?.override).toBeUndefined()
    await expect(reopened.set('local', 'chat', {}, 0)).rejects.toThrow('REVISION_CONFLICT')
    expect(await readFile(file, 'utf8')).not.toContain('auth')
  })
  it('keeps actual native selections above creation defaults but applies explicit chat overrides on the next turn', async () => {
    const { service } = await fixture()
    await service.setDefaults({ approval: 'never', execution: 'full-access' }, 0)
    const start = await service.prepare('thread/start', { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(start.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    await service.complete(start.captureId!, true, {
      thread: { id: 'new' },
      sandbox: { type: 'workspaceWrite', networkAccess: true },
      approvalPolicy: 'on-request',
    })
    const next = await service.prepare('turn/start', {
      threadId: 'new',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'untrusted',
    })
    expect(next.params).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } })
    await service.set('local', 'chat', { execution: 'full-access', approval: 'never' }, 0)
    const turn = await service.prepare('turn/start', {
      threadId: 'chat',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
    })
    expect(turn.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
  })
  it('does not invent a model or writable root; work mode preserves the captured developer instruction', () => {
    expect(() => nativeExecutionTurn({ workMode: 'plan' }, {}, {})).toThrow('WORK_MODE_MODEL_UNAVAILABLE')
    expect(() => nativeExecutionTurn({ execution: 'workspace-write' }, {}, {})).toThrow('EXECUTION_CONTEXT_UNAVAILABLE')
    expect(() => nativeExecutionTurn({ execution: 'full-access', networkAccess: false }, {}, {})).toThrow(
      'EXECUTION_NETWORK_SCOPE_UNAVAILABLE',
    )
    expect(() => nativeExecutionTurn({ networkAccess: false }, { sandbox: { type: 'dangerFullAccess' } }, {}))
      .toThrow('EXECUTION_NETWORK_SCOPE_UNAVAILABLE')
    expect(
      nativeExecutionTurn({ workMode: 'plan', effort: 'low' }, {}, {
        collaborationMode: { mode: 'default', settings: { model: 'model', developer_instructions: 'preserved' } },
      }),
    ).toMatchObject({
      collaborationMode: { mode: 'plan', settings: { developer_instructions: 'preserved', reasoning_effort: 'low' } },
    })
  })
})
