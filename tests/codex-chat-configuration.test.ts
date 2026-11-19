import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { codexCreationSelection } from '../packages/cli/src/launcher/codex-creation-selection.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const catalog = [
  {
    providerId: 'openai',
    pluginId: 'codex',
    defaultModelId: 'official',
    models: [{ id: 'official', label: 'Official', aliases: [], supportsFastMode: true }],
  },
  {
    providerId: 'custom',
    pluginId: 'test',
    defaultModelId: 'custom-model',
    models: [{ id: 'custom-model', label: 'Custom', aliases: [] }],
  },
]
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-config-')))
  roots.push(root)
  const directory = path.join(root, 'project')
  await mkdir(directory)
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const preferences = await ChatExecutionPreferences.open({
    file: path.join(root, 'execution.json'),
    configPath,
    appId: 'codex',
    profileId: 'default',
  })
  let native: Record<string, unknown> = {
    id: 'chat',
    modelProvider: 'openai',
    model: 'official',
    cwd: root,
    serviceTier: null,
    status: { type: 'idle' },
    sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
  }
  let service: CodexChatConfiguration
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/read') return { thread: native }
    if (method === 'thread/list') return { data: [{ id: native.id }] }
    if (method === 'thread/settings/update') {
      native = { ...native, ...params, ...(params.serviceTier === null ? { serviceTier: 'default' } : {}) }
      await preferences.observe('chat', native)
      return {}
    }
    if (method === 'thread/resume') {
      return { thread: native, model: native.model, sandbox: native.sandbox, serviceTier: native.serviceTier }
    }
    throw new Error('unexpected method')
  })
  const tool = vi.fn(async (input: { tool: string; arguments: Record<string, unknown> }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(
        input.tool === 'list_projects'
          ? {
            projects: [{ projectId: 'p', label: 'Repository', projectKind: 'local', hostId: 'local', path: directory }],
          }
          : input.tool === 'list_threads'
          ? { threads: [{ id: 'chat', hostId: 'local', projectId: 'p' }] }
          : { status: 'moved' },
      ),
    }],
  }))
  const authority = {
    preferences,
    file: path.join(root, 'configuration.json'),
    request,
    tool,
    catalog: async () => catalog,
  }
  service = await CodexChatConfiguration.open(authority)
  return {
    root,
    directory,
    preferences,
    service,
    authority,
    request,
    tool,
    native: () => native,
    setNative: (value: Record<string, unknown>) => {
      native = { ...native, ...value }
    },
  }
}

test('project creation uses actual native context and confirms the same project before dispatch', async () => {
  const f = await fixture()
  expect(await f.service.projects()).toEqual([{ projectId: 'p', name: 'Repository' }])
  expect(f.tool).toHaveBeenLastCalledWith({ tool: 'list_projects', sourceThreadId: 'chat', arguments: {} })
  expect(await f.service.prepareProject('p', true)).toMatchObject({
    cwd: f.directory,
    sandbox: 'read-only',
    permissions: null,
  })
  expect(await f.service.prepareProject('p')).toMatchObject({
    cwd: f.directory,
    sandbox: 'workspace-write',
    runtimeWorkspaceRoots: [f.directory],
  })
  expect(await f.service.bindCreatedProject('chat', 'p')).toBe(true)
  expect(await f.service.call('project', { sessionId: 'chat' })).toMatchObject({ effective: { projectId: 'p' } })
})

test('model defaults use the selected provider default and explicit false, without changing existing chats', async () => {
  const f = await fixture()
  expect(
    codexCreationSelection({ providerId: 'openai', model: 'official', fast: false }, { providerId: 'custom' }, catalog),
  ).toEqual({ providerId: 'custom', model: 'custom-model', fast: false })
  expect(
    await f.service.call('model-defaults-set', {
      settings: { providerId: 'openai', model: 'official', fast: true },
      expectedRevision: 0,
    }),
  ).toMatchObject({ status: 'ok', revision: 1 })
  const start = await f.preferences.prepare('thread/start', { cwd: f.root })
  expect(start.params).toMatchObject({ modelProvider: 'openai', model: 'official', serviceTier: 'priority' })
  expect(
    (await f.preferences.prepare('thread/start', { modelProvider: 'custom', model: 'custom-model', serviceTier: null }))
      .params,
  ).toMatchObject({ modelProvider: 'custom', model: 'custom-model', serviceTier: null })
  expect((await f.preferences.prepare('turn/start', { threadId: 'old' })).params).toEqual({ threadId: 'old' })
  expect(await f.service.call('model-defaults-set', { settings: {}, expectedRevision: 0 })).toMatchObject({
    code: 'REVISION_CONFLICT',
  })
})

test('Fast resolves the actual caller, preserves false and confirms the native settings event', async () => {
  const f = await fixture()
  expect(await f.service.call('fast-set', { fast: true, expectedRevision: 0 })).toMatchObject({
    code: 'SESSION_REQUIRED',
  })
  const metadata = { 'openai/threadId': 'chat' }
  expect(await f.service.call('fast-set', { fast: true, expectedRevision: 0 }, metadata)).toMatchObject({
    status: 'applied',
    fast: true,
    revision: 1,
  })
  expect((await f.preferences.prepare('turn/start', { threadId: 'chat', serviceTier: null })).params.serviceTier).toBe(
    'priority',
  )
  expect(await f.service.call('fast-set', { fast: false, expectedRevision: 1 }, metadata)).toMatchObject({
    status: 'applied',
    fast: false,
    revision: 2,
  })
  expect((await f.preferences.prepare('turn/start', { threadId: 'chat', serviceTier: 'priority' })).params.serviceTier)
    .toBeNull()
  f.setNative({ modelProvider: 'custom', model: 'custom-model' })
  await f.preferences.observe('chat', f.native())
  expect(await f.service.call('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 2 })).toMatchObject({
    code: 'FAST_NOT_SUPPORTED',
  })
})

test('project switching aligns membership, cwd and strict writable roots even against an old full-access override', async () => {
  const f = await fixture()
  await f.preferences.set('local', 'chat', { execution: 'full-access', approval: 'never' }, 0)
  expect(await f.service.call('project-set', { sessionId: 'chat', projectId: 'p', expectedRevision: 0 })).toMatchObject(
    { status: 'applied', revision: 1, project: { projectId: 'p', cwd: f.directory } },
  )
  expect(f.tool.mock.calls.some(([input]) => input.tool === 'move_thread_to_project')).toBe(true)
  const turn = await f.preferences.prepare('turn/start', {
    threadId: 'chat',
    cwd: f.root,
    permissions: 'old-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  expect(turn.params).toMatchObject({
    cwd: f.directory,
    approvalPolicy: 'never',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [f.directory],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  })
  const restored = await CodexChatConfiguration.open(f.authority)
  expect(await restored.call('project', { sessionId: 'chat' })).toMatchObject({
    project: { projectId: 'p' },
    application: 'unknown',
  })
  expect(await restored.call('project-set', { sessionId: 'chat', projectId: 'p', cwd: f.root, expectedRevision: 1 }))
    .toMatchObject({ code: 'CWD_OUTSIDE_PROJECT' })
})

test('busy, missing native authority and Channel-denied changes never produce an effect', async () => {
  const f = await fixture()
  f.setNative({ status: { type: 'active' } })
  expect(await f.service.call('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 })).toMatchObject({
    code: 'THREAD_NOT_IDLE',
  })
  const guarded = await CodexChatConfiguration.open({
    ...f.authority,
    guard: async () => ({ status: 'rejected', code: 'CHANNEL_DENIED' }),
  })
  expect(await guarded.call('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 })).toMatchObject({
    code: 'CHANNEL_DENIED',
  })
  expect(f.request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false)
})

test('the Host Channel effect callback is revalidated after native reads and before persistence or mutation', async () => {
  const f = await fixture()
  const before = vi.fn(async () => false)
  expect(await f.service.applyChannel('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 }, before))
    .toMatchObject({ status: 'rejected', code: 'CHANNEL_CHANGE_REVOKED' })
  expect(before).toHaveBeenCalledTimes(1)
  expect(f.request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false)
  expect(await f.service.call('fast', { sessionId: 'chat' })).toMatchObject({ revision: 0 })
  expect(
    await f.service.applyChannel('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 }, async () => true),
  )
    .toMatchObject({ status: 'applied', revision: 1 })
})

test('old loaded settings hydrate once through the real preference preparation chain', async () => {
  const f = await fixture()
  await f.service.call('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 })
  const authority = {
    ...f.authority,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: { id: 'chat', status: { type: 'idle' }, cwd: f.root } }
      if (method === 'thread/resume') {
        await f.preferences.prepare(method, params)
        return {
          thread: { id: 'chat' },
          model: 'official',
          modelProvider: 'openai',
          serviceTier: 'priority',
          sandbox: f.native().sandbox,
        }
      }
      throw new Error('unexpected')
    }),
  }
  const restored = await CodexChatConfiguration.open(authority)
  expect(await restored.call('fast', { sessionId: 'chat' })).toMatchObject({ effective: { fast: true } })
  expect(authority.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1)
})

test('normalized native roots are confirmed but a missing project membership is never applied', async () => {
  const f = await fixture()
  f.request.mockImplementation(async (method, params) => {
    if (method === 'thread/read' || method === 'thread/resume') return { thread: f.native() }
    if (method === 'thread/settings/update') {
      f.setNative({ ...params, sandboxPolicy: { ...(params.sandboxPolicy as object), writableRoots: [] } })
      await f.preferences.observe('chat', f.native())
      return {}
    }
    throw new Error('unexpected')
  })
  expect(await f.service.call('project-set', { sessionId: 'chat', projectId: 'p', expectedRevision: 0 })).toMatchObject(
    { status: 'applied' },
  )
  f.tool.mockImplementation(async input => ({
    content: [{
      type: 'text',
      text: JSON.stringify(
        input.tool === 'list_projects'
          ? { projects: [{ projectId: 'p', projectKind: 'local', hostId: 'local', path: f.directory }] }
          : input.tool === 'list_threads'
          ? { threads: [{ id: 'chat', hostId: 'local', projectId: 'old' }] }
          : { status: 'moved' },
      ),
    }],
  }))
  expect(await f.service.call('project-set', { sessionId: 'chat', projectId: 'p', expectedRevision: 1 })).toMatchObject(
    { status: 'pending', application: 'submitted' },
  )
  const resumed = await f.preferences.prepare('thread/resume', {
    threadId: 'chat',
    permissions: 'old-full-access',
    config: { private: 'unchanged' },
  })
  expect(resumed.params).toMatchObject({
    cwd: f.directory,
    runtimeWorkspaceRoots: [f.directory],
    permissions: null,
    sandbox: 'workspace-write',
    config: { private: 'unchanged', 'sandbox_workspace_write.writable_roots': [f.directory] },
  })
})

test('lost native acknowledgement retains the selection and returns explicit uncertainty', async () => {
  const f = await fixture()
  f.request.mockImplementation(async method => {
    if (method === 'thread/read') return { thread: f.native() }
    throw new Error('lost')
  })
  expect(await f.service.call('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 0 })).toMatchObject({
    status: 'reconciliation-required',
    fast: true,
    application: 'unknown',
    revision: 1,
  })
  expect(await f.service.call('fast', { sessionId: 'chat' })).toMatchObject({ fast: true, effective: { fast: false } })
})

test('a service without a native catalog can store defaults but defers selection validation', async () => {
  const f = await fixture()
  const service = await CodexChatConfiguration.open({ ...f.authority, catalog: undefined })
  expect(
    await service.call('model-defaults-set', {
      settings: { providerId: 'later', model: 'later-model', fast: false },
      expectedRevision: 0,
    }),
  ).toMatchObject({ status: 'ok', validation: 'deferred-until-creation' })
  expect(f.request).not.toHaveBeenCalled()
  expect(codexCreationSelection({ fast: true }, {}, catalog)).toEqual({
    providerId: 'openai',
    model: 'official',
    fast: true,
  })
})
