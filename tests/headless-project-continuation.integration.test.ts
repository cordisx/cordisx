import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { HeadlessProjectCatalog } from '../packages/cli/src/launcher/headless-project-catalog.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'

it('preserves a verified headless project and its exact sandbox through a fork and later resume', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cx-project-continuation-')))
  const workspace = path.join(root, 'workspace'), project = path.join(workspace, 'repo')
  const mailbox = path.join(root, 'mailbox'), configPath = path.join(root, 'config.json')
  await mkdir(path.join(project, '.git'), { recursive: true })
  await mkdir(mailbox)
  await ensureHomeConfig(configPath)
  let execution = await ChatExecutionPreferences.open({
    file: path.join(root, 'execution.json'),
    configPath,
    appId: 'codex',
    profileId: 'default',
  })
  const source: Record<string, unknown> = {
    id: 'source',
    name: 'Source',
    projectId: null,
    section: null,
    cwd: root,
    modelProvider: 'source-provider',
    model: 'source-model',
    serviceTier: null,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    activePermissionProfile: null,
    reasoningEffort: 'medium',
    collaborationMode: { mode: 'default' },
    status: { type: 'idle' },
    sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
  }
  let destination: Record<string, unknown> | undefined, configuration!: CodexChatConfiguration
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const thread = params.threadId === 'source' ? source : destination
    if (method === 'thread/read') return { thread: { ...thread } }
    if (method === 'thread/settings/update') {
      Object.assign(source, params, { sandbox: params.sandboxPolicy })
      await execution.observe('source', source)
      return {}
    }
    if (method === 'thread/fork') {
      destination = {
        ...source,
        id: 'destination',
        name: null,
        modelProvider: 'target-provider',
        model: 'target-model',
        forkedFromId: 'source',
        ephemeral: false,
      }
      return { ...destination, thread: { ...destination } }
    }
    if (method === 'thread/name/set') {
      destination!.name = params.name
      return {}
    }
    if (method === 'thread/resume') {
      const result = { ...destination, thread: { ...destination } }
      const captured = await execution.prepare('thread/resume', params)
      if (captured.captureId) await execution.complete(captured.captureId, true, result)
      return result
    }
    if (method === 'thread/items/list') return { data: [], nextCursor: null }
    throw new Error(`unexpected ${method}`)
  })
  try {
    const projects = await HeadlessProjectCatalog.open(workspace)
    configuration = await CodexChatConfiguration.open({
      preferences: execution,
      file: path.join(root, 'configuration.json'),
      request: request as never,
      headlessProjects: projects,
      sandboxAuxiliaryRoot: mailbox,
    })
    await execution.recordModelSelection('source', { providerId: 'source-provider', model: 'source-model' })
    const [{ projectId }] = await configuration.projects()
    expect(
      await configuration.applyChannel(
        'project-set',
        { sessionId: 'source', projectId, expectedRevision: 0 },
        async () => true,
      ),
    ).toMatchObject({ status: 'applied' })
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: root,
      nativeRequest: request as never,
      execution,
      configuration,
      nativeVersion: 'codex-cli 0.172.0',
      crossProviderForkReady: async () => true,
    })
    const settings = await sessions.continuationConfiguration('source')
    expect(settings?.sandbox).toEqual(source.sandbox)
    const fence = new ChannelNativeSourceFence(() => false), release = fence.beginMigration('source')!
    try {
      const created = await sessions.createLogicalDestination(
        {
          contract: 'cordisx.conversation-continuation-request/v1',
          operationId: 'operation',
          logicalConversationId: 'logical',
          source: { hostId: 'local', appId: 'codex', profileId: 'default', sessionId: 'source' },
          expectedRevision: 0,
          target: { providerId: 'target-provider', model: 'target-model' },
          mode: 'fork',
          historyConsent: 'inherit',
        },
        { sourceConfiguration: settings!, sourceHistoryVersion: 'sha256:fixture', handoff: 'none' },
        fence,
        () => true,
      )
      expect(created).toMatchObject({ state: 'created', confirmed: true, destination: { sessionId: 'destination' } })
      if ('releaseTarget' in created) created.releaseTarget()
    } finally {
      release()
    }
    expect(await sessions.taskSelection('destination')).toMatchObject({
      providerId: 'target-provider',
      model: 'target-model',
      projectId,
    })
    expect(request).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        config: expect.objectContaining({
          'sandbox_workspace_write.writable_roots': [project, mailbox],
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true,
          'sandbox_workspace_write.network_access': false,
        }),
      }),
    )
    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        threadId: 'destination',
        sandbox: 'workspace-write',
        config: expect.objectContaining({
          'sandbox_workspace_write.writable_roots': [project, mailbox],
          'sandbox_workspace_write.network_access': false,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true,
        }),
      }),
    )
    await configuration.close()
    await execution.close()
    execution = await ChatExecutionPreferences.open({
      file: path.join(root, 'execution.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    configuration = await CodexChatConfiguration.open({
      preferences: execution,
      file: path.join(root, 'configuration.json'),
      request: request as never,
      headlessProjects: projects,
      sandboxAuxiliaryRoot: mailbox,
    })
    const resumed = await execution.prepare('thread/resume', { threadId: 'destination' })
    expect(resumed.params).toMatchObject({
      cwd: project,
      sandbox: 'workspace-write',
      config: {
        'sandbox_workspace_write.writable_roots': [project, mailbox],
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true,
      },
    })
    const turn = await execution.prepare('turn/start', { threadId: 'destination', model: 'target-model' })
    expect(turn.params).toMatchObject({ cwd: project, sandboxPolicy: source.sandbox })
  } finally {
    await configuration?.close()
    await execution.close()
    await rm(root, { recursive: true, force: true })
  }
})
