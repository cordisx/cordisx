import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createHeadlessNativeAuthority } from '../packages/cli/src/launcher/headless-native-authority.js'
import { headlessModelSelection } from '../packages/cli/src/launcher/headless-model-selection.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'

it('reopens the real profile store and restores only its confirmed Channel selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-resume-integration-'))
  const configPath = path.join(root, 'config.json'), profile = path.join(root, 'apps/codex/profiles/default')
  await ensureHomeConfig(configPath)
  await mkdir(profile, { recursive: true })
  const create = () =>
    createHeadlessNativeAuthority({
      homeDir: root,
      configPath,
      appId: 'codex',
      profileId: 'default',
      report: () => {},
    })
  const selection = { providerId: 'fixture-provider', model: 'fixture/model' }
  const persistChannel = () =>
    writeFile(
      path.join(profile, 'channel-conversations.json'),
      JSON.stringify({
        bindings: { group: { state: 'active', sessionId: 'thread' } },
        taskSettings: { thread: { application: 'applied', settings: selection } },
      }),
    )
  const next = vi.fn(async (params: Readonly<Record<string, unknown>>) => ({
    thread: { id: params.threadId },
    modelProvider: params.modelProvider,
    model: params.model,
  }))
  let native = await create()
  try {
    await native.authority.execution!.recordModelSelection('thread', selection)
    await persistChannel()
    await native.close()
    native = await create()
    await native.authority.nativeRequest!('thread/resume', { threadId: 'thread', excludeTurns: true }, next)
    expect(next).toHaveBeenLastCalledWith({
      threadId: 'thread',
      excludeTurns: true,
      modelProvider: selection.providerId,
      model: selection.model,
    })
    await native.authority.execution!.recordModelSelection('thread')
    await native.close()
    native = await create()
    await expect(native.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, next))
      .rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    expect(next).toHaveBeenCalledOnce()
  } finally {
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('revalidates the Channel selection before persisting the native effect fence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-selection-'))
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const execution = await ChatExecutionPreferences.open({
    file: path.join(root, 'execution.json'),
    configPath,
    appId: 'codex',
    profileId: 'default',
  })
  let model = 'old'
  await execution.recordModelSelection('thread', { providerId: 'provider', model })
  const backend = headlessModelSelection(
    async (_operation: string, value: unknown, before?: () => Promise<boolean>) => {
      if (!await before?.()) return { status: 'rejected', reason: 'selection-changed' }
      model = (value as { model: string }).model
      await execution.observe('thread', { modelProvider: 'provider', model })
      return { status: 'selected' }
    },
    () => execution,
  )
  const native = new ChannelNativeSessions({
    bridge: () => undefined,
    cwd: root,
    execution,
    models: backend,
    nativeRequest: async () => ({
      thread: { id: 'thread', status: { type: 'idle' }, modelProvider: 'provider', model },
    }),
  })
  try {
    const result = await native.applyTaskSelection(
      'thread',
      { providerId: 'provider', model: 'new' },
      async () => (await native.taskSelection('thread')).model === 'old',
    )
    expect(result).toMatchObject({ status: 'selected' })
    expect(execution.read('local', 'thread')?.modelSelection)
      .toEqual({ status: 'confirmed', providerId: 'provider', model: 'new' })
  } finally {
    await execution.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reads the applied project after restoring the original provider without a second implicit resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-project-provider-recovery-'))
  const configPath = path.join(root, 'config.json'), profile = path.join(root, 'apps/codex/profiles/default')
  await ensureHomeConfig(configPath)
  await mkdir(profile, { recursive: true })
  const original = { providerId: 'source', model: 'source-model' }
  const target = { providerId: 'target', model: 'target-model' }
  const project = { projectId: 'project', cwd: root, roots: [root] }
  await writeFile(
    path.join(profile, 'channel-conversations.json'),
    JSON.stringify({
      bindings: { binding: { state: 'active', sessionId: 'thread' } },
      taskSettings: { thread: { application: 'applied', settings: target } },
    }),
  )
  await writeFile(
    path.join(profile, 'codex-chat-configuration.json'),
    JSON.stringify({
      schema: 'cordisx.codex-chat-configuration/v1',
      records: { thread: { revision: 1, project, application: 'applied' } },
    }),
  )
  const owner = await createHeadlessNativeAuthority({
    homeDir: root,
    configPath,
    appId: 'codex',
    profileId: 'default',
    report: () => {},
  })
  const execution = owner.authority.execution!
  const mailbox = path.join(root, 'mailbox')
  const sandbox = {
    type: 'workspaceWrite',
    writableRoots: [mailbox],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  }
  const settings = {
    modelProvider: original.providerId,
    model: original.model,
    cwd: root,
    sandbox,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    activePermissionProfile: null,
    serviceTier: null,
    reasoningEffort: 'medium',
    collaborationMode: { mode: 'default' },
  }
  await execution.recordModelSelection('thread', target)
  await execution.observe('thread', { ...settings, modelProvider: target.providerId, model: target.model })
  let loaded = false
  const requests: string[] = []
  const raw = vi.fn(async (method: string, params: Readonly<Record<string, unknown>>) => {
    requests.push(method)
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread',
          cwd: root,
          modelProvider: original.providerId,
          status: { type: loaded ? 'idle' : 'notLoaded' },
        },
      }
    }
    if (method === 'thread/resume') {
      if (params.modelProvider !== original.providerId) throw new Error('unexpected provider')
      loaded = true
      return { ...settings, thread: { id: 'thread', cwd: root, status: { type: 'idle' } } }
    }
    throw new Error('unexpected request')
  })
  const request = (
    method: Parameters<NonNullable<typeof owner.authority.nativeRequest>>[0],
    params: Readonly<Record<string, unknown>>,
  ) => owner.authority.nativeRequest!(method, params, value => raw(method, value))
  owner.setReader(request)
  const configuration = await CodexChatConfiguration.open({
    preferences: execution,
    file: path.join(profile, 'codex-chat-configuration.json'),
    request: request as never,
    headlessProjects: { project: async () => project } as never,
    sandboxAuxiliaryRoot: mailbox,
  })
  const sessions = new ChannelNativeSessions({
    bridge: () => undefined,
    cwd: root,
    nativeRequest: request,
    execution,
    configuration,
  })
  const fence = new ChannelNativeSourceFence(() => false), release = fence.beginMigration('thread')!
  try {
    expect(await sessions.providerRecovery.restore('thread', original.providerId, fence)).toEqual(original)
    await execution.recordModelSelection('thread', original)
    await expect(sessions.taskSelection('thread')).resolves.toMatchObject({
      ...original,
      projectId: project.projectId,
      effort: 'medium',
      fast: false,
    })
    expect(execution.read('local', 'thread')?.modelSelection).toEqual({ status: 'confirmed', ...original })
    expect(execution.read('local', 'thread')?.submittedSettings).toEqual({})
    expect((await sessions.continuationConfiguration('thread'))?.sandbox).toEqual(sandbox)
    expect(requests.filter(method => method === 'thread/resume')).toHaveLength(1)
    expect(raw).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        config: expect.objectContaining({
          'sandbox_workspace_write.writable_roots': [mailbox],
          'sandbox_workspace_write.network_access': false,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true,
        }),
      }),
    )
  } finally {
    release()
    await configuration.close()
    await owner.close()
    await rm(root, { recursive: true, force: true })
  }
})
