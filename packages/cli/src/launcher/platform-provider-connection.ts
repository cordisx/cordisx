import type {
  PlatformProviderAdapterV1,
  PlatformProviderDefinitionV1,
  PlatformProviderLifecycleEventV1,
  PlatformProviderSessionDetailV1,
  PlatformProviderSessionV1,
} from '@cordisx/protocol/platform-provider/v1'
import type {
  CordisXModelDescriptor,
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXSessionProjection,
  CordisXSessionSummary,
} from '../contracts.js'
import type { ProviderConnection, ProviderLifecycleSignal } from '../providers/contracts.js'
import type { HostBoundPlatformProviderBrokerV1 } from './platform-provider-broker.js'
import type { PlatformProviderWorkspaceAuthority } from './platform-provider-authority.js'
import { validLifecycleEvent } from './platform-provider-validation.js'

function hostFailure<Value>(result: PlatformProviderResultLike<Value>): CordisXPlatformResult<Value> {
  if (result.ok) return result
  const codes: Record<string, CordisXPlatformDiagnostic['code']> = {
    'session-not-found': 'task-not-found',
    'provider-unavailable': 'adapter-unavailable',
    'stale-generation': 'adapter-unavailable',
    disposed: 'adapter-unavailable',
    unsupported: 'adapter-read-only',
    rejected: 'invalid-request',
    timeout: 'timeout',
    'adapter-failure': 'adapter-failure',
  }
  return {
    ok: false,
    error: {
      code: codes[result.error.code] ?? 'adapter-failure',
      message: result.error.message,
      ...(result.error.retryable === true ? { retryable: true } : {}),
    },
  }
}

type PlatformProviderResultLike<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly retryable?: boolean }
  }

export function providerConnection(input: {
  readonly descriptor: PlatformProviderDefinitionV1['descriptor']
  readonly adapter: PlatformProviderAdapterV1
  readonly broker: HostBoundPlatformProviderBrokerV1
  readonly workspaces: PlatformProviderWorkspaceAuthority
}): ProviderConnection {
  const { adapter, broker, descriptor, workspaces } = input
  let closed = false
  let lifecycleSequence = 0
  const projectSession = (session: PlatformProviderSessionDetailV1): CordisXSessionProjection => ({
    contract: 'cordisx.platform-session/v1',
    schemaVersion: 1,
    ref: session.ref,
    hostId: `${session.ref.providerId}:${session.ref.remoteSessionId}`,
    model: session.model,
    cwd: workspaces.resolve(session.workspace),
    state: session.state,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    turns: session.turns.map(turn => ({
      id: turn.turnId,
      state: turn.state,
      items: turn.items.map(item => ({
        id: item.itemId,
        kind: item.kind,
        ...(item.text === undefined ? {} : { text: item.text }),
      })),
    })),
  })
  const projectSummary = (session: PlatformProviderSessionV1): CordisXSessionSummary => ({
    contract: 'cordisx.platform-session/v1',
    schemaVersion: 1,
    ref: session.ref,
    hostId: `${session.ref.providerId}:${session.ref.remoteSessionId}`,
    model: session.model,
    cwd: workspaces.resolve(session.workspace),
    state: session.state,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
  })
  return {
    providerId: adapter.providerId,
    generation: adapter.providerGeneration,
    status: () => ({
      providerId: adapter.providerId,
      displayName: descriptor.displayName,
      generation: adapter.providerGeneration,
      state: closed ? 'closed' : 'ready',
      external: true,
      nativeCurrentConnection: false,
      rawBridgeExposed: false,
    }),
    listModels: async () => {
      const result = await adapter.models.list({})
      if (!result.ok) return hostFailure(result)
      return {
        ok: true,
        value: result.value.models.map((model): CordisXModelDescriptor => ({
          contract: 'cordisx.platform-model/v1',
          schemaVersion: 1,
          ref: model.ref,
          hostId: `${model.ref.providerId}:${model.ref.modelId}`,
          label: model.label,
          ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
          ...(model.capabilities === undefined ? {} : { features: model.capabilities }),
        })),
      }
    },
    listSessions: async request => {
      const result = await adapter.sessions.list({
        limit: request.limit ?? 50,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.cwd === undefined ? {} : { workspace: workspaces.issue(request.cwd) }),
        ...(request.searchTerm === undefined ? {} : { search: request.searchTerm }),
      })
      if (!result.ok) return hostFailure(result)
      return {
        ok: true,
        value: {
          sessions: result.value.sessions.map(projectSummary),
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        },
      }
    },
    readSession: async ref => {
      const result = await adapter.sessions.read(ref)
      return result.ok ? { ok: true, value: projectSession(result.value) } : hostFailure(result)
    },
    createSession: async request => {
      if (
        request.developerInstructions !== undefined || request.effort !== undefined
        || request.approvalPolicy !== undefined
      ) {
        return {
          ok: false,
          error: { code: 'adapter-read-only', message: 'Provider does not support Host-private Agent setup.' },
        }
      }
      const result = await adapter.sessions.create({ model: request.model, workspace: workspaces.issue(request.cwd) })
      return result.ok ? { ok: true, value: projectSummary(result.value) } : hostFailure(result)
    },
    controlSession: async request => {
      const result = await adapter.sessions.control(request)
      if (!result.ok) return hostFailure(result)
      return 'deleted' in result.value
        ? { ok: true, value: { action: 'delete', session: request.session, deleted: true } }
        : {
          ok: true,
          value: {
            action: request.action as 'continue' | 'fork' | 'archive' | 'restore',
            session: projectSummary(result.value),
          },
        }
    },
    submitTurn: async request => {
      const result = await adapter.turns.submit({ session: request.session, message: request.message })
      return result.ok
        ? { ok: true, value: { session: request.session, turnId: result.value.turnId } }
        : hostFailure(result)
    },
    decideApproval: async request => {
      const result = await adapter.approvals.decide(request)
      return result.ok
        ? { ok: true, value: { turnId: request.turnId, ...result.value } }
        : hostFailure(result)
    },
    requestMemberSelfIntroduction: async request => {
      const result = await adapter.turns.introduce(request)
      return result.ok ? result : hostFailure(result)
    },
    cancelMemberSelfIntroduction: async request => {
      const result = await adapter.turns.control({
        action: 'interrupt',
        session: request.session,
        turnId: request.turnId,
      })
      return result.ok ? { ok: true, value: { turnId: result.value.turnId } } : hostFailure(result)
    },
    controlTurn: async request => {
      const result = await adapter.turns.control({
        action: request.action,
        session: request.session,
        turnId: request.turnId ?? '',
        ...(request.action === 'steer' ? { message: request.message } : {}),
      })
      return result.ok
        ? { ok: true, value: { action: request.action, session: request.session, turnId: result.value.turnId } }
        : hostFailure(result)
    },
    subscribeLifecycle: listener => {
      const subscription = adapter.subscribeLifecycle((event: PlatformProviderLifecycleEventV1) => {
        if (!validLifecycleEvent(event, adapter.providerId, adapter.providerGeneration)) return
        if (event.sequence <= lifecycleSequence) return
        lifecycleSequence = event.sequence
        const projected: ProviderLifecycleSignal = {
          session: event.session,
          turnId: event.turnId,
          type: event.type,
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(event.failure === undefined ? {} : { failure: event.failure }),
          ...(event.approval === undefined ? {} : { approval: event.approval }),
        }
        listener(projected)
      })
      return () => subscription.unsubscribe()
    },
    close: async () => {
      if (closed) return
      closed = true
      await adapter.drain()
      await adapter.dispose('host-disposed')
      await broker.dispose()
    },
  }
}
