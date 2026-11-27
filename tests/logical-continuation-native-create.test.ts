import { describe, expect, it, vi } from 'vitest'
import { createLogicalNativeDestination } from '../packages/cli/src/launcher/logical-continuation-native-create.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import type {
  LogicalContinuationEvidence,
  LogicalContinuationRequest,
} from '../packages/cli/src/launcher/logical-continuation-control.js'

const request: LogicalContinuationRequest = {
  contract: 'cordisx.conversation-continuation-request/v1',
  operationId: 'op',
  logicalConversationId: 'logical',
  source: { hostId: 'local', appId: 'codex', profileId: 'test', sessionId: 'source' },
  expectedRevision: 0,
  target: { providerId: 'target', model: 'new' },
  mode: 'linked',
  historyConsent: 'on-demand',
  handoffConsent: 'none',
  historyCategories: ['user-text'],
}
const evidence: LogicalContinuationEvidence = {
  sourceHistoryVersion: 'version',
  handoff: 'none',
  sourceConfiguration: {
    providerId: 'old',
    model: 'old',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
  },
}
describe('native logical destination creation', () => {
  it('requires a live owner-observed turn and stops admitting it after completion', async () => {
    let notify!: (method: string, params: unknown) => void
    const native = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/workspace',
      subscribeContinuationEvents: listener => {
        notify = listener
        return () => {}
      },
      nativeRequest: async () => ({ thread: { id: 'target', status: { type: 'active' } } }),
    })
    expect(await native.logicalTurnActive('target', 'turn')).toBe(false)
    notify('turn/started', { threadId: 'target', turn: { id: 'turn' } })
    expect(await native.logicalTurnActive('target', 'turn')).toBe(true)
    notify('turn/completed', { threadId: 'target', turn: { id: 'turn' } })
    expect(await native.logicalTurnActive('target', 'turn')).toBe(false)
  })
  it('persists source execution choices before accepting the target', async () => {
    const execution = {
      read: () => ({ revision: 0 }),
      set: vi.fn(async (_host, _id, override) => ({ override })),
      recordModelSelection: vi.fn(async () => {}),
    }
    const fence = new ChannelNativeSourceFence(() => false)
    const releaseSource = fence.beginMigration('source')!
    const target = { id: 'new-thread', name: null as string | null, projectId: null, section: null }
    const native = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/workspace',
      execution: execution as never,
      nativeRequest: async (method, params) => {
        if (method === 'thread/name/set') target.name = String(params.name)
        if (method === 'thread/read') {
          return {
            thread: params.threadId === 'source'
              ? { id: 'source', name: 'Original', projectId: null, section: null }
              : { ...target },
          }
        }
        return {
          thread: { id: 'new-thread' },
          modelProvider: 'target',
          model: 'new',
          cwd: '/workspace',
          serviceTier: 'default',
          approvalsReviewer: 'user',
          approvalPolicy: 'on-request',
          reasoningEffort: 'low',
          sandbox: { type: 'readOnly' },
          activePermissionProfile: null,
        }
      },
    })
    const created = await native.createLogicalDestination(request, evidence, fence, () => true)
    expect(created).toMatchObject({
      state: 'created',
      confirmed: true,
    })
    expect(fence.isMigrating('new-thread')).toBe(true)
    expect(() => fence.enterNative('thread/settings/update', { threadId: 'new-thread' })).toThrow(
      'CONTINUATION_PENDING',
    )
    if ('releaseTarget' in created) created.releaseTarget()
    expect(fence.isMigrating('new-thread')).toBe(false)
    expect(execution.set).toHaveBeenCalledWith('local', 'new-thread', evidence.sourceConfiguration.execution, 0)
    expect(execution.recordModelSelection).toHaveBeenCalledWith('new-thread', request.target)
    execution.set.mockRejectedValueOnce(new Error('unavailable'))
    expect(await native.createLogicalDestination(request, evidence, fence, () => true)).toMatchObject({
      state: 'created',
      confirmed: false,
      destination: { sessionId: 'new-thread' },
    })
    releaseSource()
  })
  it('keeps an uncertain destination fenced if native persistence fails', async () => {
    const fence = new ChannelNativeSourceFence(() => false)
    const releaseSource = fence.beginMigration('source')!
    const native = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/workspace',
      execution: { read: () => undefined, set: async () => ({}) } as never,
      nativeRequest: async (method, params) => {
        if (method === 'thread/name/set') throw new Error('write failed')
        if (method === 'thread/read') {
          return {
            thread: { id: params.threadId, name: null, projectId: null, section: null },
          }
        }
        return {
          thread: { id: 'new-thread' },
          modelProvider: 'target',
          model: 'new',
          cwd: '/workspace',
          serviceTier: null,
          approvalsReviewer: 'user',
          approvalPolicy: 'on-request',
          reasoningEffort: 'low',
          sandbox: { type: 'readOnly' },
          activePermissionProfile: null,
        }
      },
    })
    expect(await native.createLogicalDestination(request, evidence, fence, () => true)).toMatchObject({
      state: 'created',
      confirmed: false,
      destination: { sessionId: 'new-thread' },
    })
    releaseSource()
  })
  it('starts only a fresh thread with target model, source security and a scoped history tool', async () => {
    const native = {
      nativeRequest: vi.fn(async () => ({
        thread: { id: 'new-thread' },
        modelProvider: 'target',
        model: 'new',
        cwd: '/workspace',
        serviceTier: 'default',
        approvalsReviewer: 'user',
        approvalPolicy: 'on-request',
        reasoningEffort: 'low',
        sandbox: { type: 'readOnly' },
        activePermissionProfile: null,
      })),
    }
    expect(await createLogicalNativeDestination(native, request, evidence, undefined, 'project')).toEqual({
      state: 'created',
      destination: { ...request.source, sessionId: 'new-thread' },
      confirmed: true,
    })
    expect(native.nativeRequest).toHaveBeenCalledOnce()
    expect(native.nativeRequest).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        modelProvider: 'target',
        model: 'new',
        projectId: 'project',
        sandbox: 'read-only',
        dynamicTools: [expect.objectContaining({ name: 'cordisx_continuation_history' })],
      }),
    )
    expect(native.nativeRequest).toHaveBeenCalledWith(
      'thread/start',
      expect.not.objectContaining({ serviceTier: null }),
    )
  })
  it('refuses unsupported plan mode before a native effect and flags mismatched readback', async () => {
    const native = { nativeRequest: vi.fn(async () => ({ thread: { id: 'new-thread' } })) }
    const plan = {
      ...evidence,
      sourceConfiguration: {
        ...evidence.sourceConfiguration,
        execution: { ...evidence.sourceConfiguration.execution, workMode: 'plan' as const },
      },
    }
    expect(await createLogicalNativeDestination(native, request, plan)).toMatchObject({ state: 'rejected' })
    expect(native.nativeRequest).not.toHaveBeenCalled()
    expect(await createLogicalNativeDestination(native, request, evidence)).toMatchObject({
      state: 'created',
      confirmed: false,
      destination: { sessionId: 'new-thread' },
    })
  })
  it('refuses an empty continuation before a native effect', async () => {
    const native = { nativeRequest: vi.fn(async () => ({ thread: { id: 'new-thread' } })) }
    const { historyCategories: _categories, handoffConsent: _handoff, ...base } = request
    expect(await createLogicalNativeDestination(native, { ...base, mode: 'fresh', historyConsent: 'none' }, evidence))
      .toMatchObject({ state: 'rejected' })
    expect(native.nativeRequest).not.toHaveBeenCalled()
  })
  it('passes the exact verified project sandbox to native fork', async () => {
    const sandbox = {
      type: 'workspaceWrite',
      writableRoots: ['/mailbox'],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    }
    const sourceConfiguration = {
      ...evidence.sourceConfiguration,
      sandbox,
      execution: {
        ...evidence.sourceConfiguration.execution,
        execution: 'workspace-write' as const,
        networkAccess: false,
      },
    }
    const native = {
      nativeRequest: vi.fn(async () => ({
        thread: { id: 'fork', forkedFromId: 'source', ephemeral: false, status: { type: 'idle' } },
        modelProvider: 'old',
        model: 'old',
        cwd: '/workspace',
        serviceTier: 'default',
        approvalsReviewer: 'user',
        approvalPolicy: 'on-request',
        reasoningEffort: 'low',
        sandbox,
        activePermissionProfile: null,
      })),
    }
    const fork: LogicalContinuationRequest = {
      contract: request.contract,
      operationId: request.operationId,
      logicalConversationId: request.logicalConversationId,
      source: request.source,
      expectedRevision: request.expectedRevision,
      target: { providerId: 'old', model: 'old' },
      mode: 'fork',
      historyConsent: 'inherit',
    }
    expect(
      await createLogicalNativeDestination(native, fork, { ...evidence, sourceConfiguration }, (_id, params) => params),
    ).toMatchObject({ state: 'created', confirmed: true })
    expect(native.nativeRequest).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        config: expect.objectContaining({
          'sandbox_workspace_write.writable_roots': ['/mailbox'],
          'sandbox_workspace_write.network_access': false,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true,
        }),
      }),
    )
  })
  it('permits only an explicitly fenced same-model full fork and verifies its ancestry', async () => {
    const native = {
      nativeRequest: vi.fn(async () => ({
        thread: { id: 'fork', forkedFromId: 'source', ephemeral: false, status: { type: 'idle' } },
        modelProvider: 'old',
        model: 'old',
        cwd: '/workspace',
        serviceTier: 'default',
        approvalsReviewer: 'user',
        approvalPolicy: 'on-request',
        reasoningEffort: 'low',
        sandbox: { type: 'readOnly' },
        activePermissionProfile: null,
      })),
    }
    const fork = {
      contract: request.contract,
      operationId: request.operationId,
      logicalConversationId: request.logicalConversationId,
      source: request.source,
      expectedRevision: 0,
      target: { providerId: 'old', model: 'old' },
      mode: 'fork' as const,
      historyConsent: 'inherit' as const,
    }
    expect(await createLogicalNativeDestination(native, fork, evidence)).toMatchObject({ state: 'rejected' })
    expect(
      await createLogicalNativeDestination(
        native,
        { ...fork, target: { providerId: 'other', model: 'new' } },
        evidence,
        (_id, params) => params,
      ),
    ).toMatchObject({ state: 'rejected' })
    expect(native.nativeRequest).not.toHaveBeenCalled()
    expect(await createLogicalNativeDestination(native, fork, evidence, (_id, params) => params)).toMatchObject({
      state: 'created',
      confirmed: true,
      destination: { sessionId: 'fork' },
    })
    expect(native.nativeRequest).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({ threadId: 'source', excludeTurns: true }),
    )
  })
})
