import type {
  PlatformProviderAdapterV1,
  PlatformProviderDefinitionV1,
  PlatformProviderLifecycleEventV1,
  PlatformProviderOperationV1,
} from '@cordisx/protocol/platform-provider/v1'
import type { CordisXPlatformDiagnostic, CordisXPlatformResult } from '../contracts.js'
import type { ProviderConnection, ProviderLifecycleSignal } from '../providers/contracts.js'
import type { HostBoundPlatformProviderBrokerV1 } from './platform-provider-broker.js'
import type { PlatformProviderWorkspaceAuthority } from './platform-provider-authority.js'
import { PlatformProviderProjection } from './platform-provider-projection.js'
import {
  assertProviderApprovalResult,
  assertProviderCursor,
  assertProviderDeleted,
  assertProviderIntroductionResult,
  assertProviderModel,
  assertProviderModelPage,
  assertProviderResult,
  assertProviderSession,
  assertProviderSessionPage,
  assertProviderTurnId,
  assertProviderTurnResult,
} from './platform-provider-result-validation.js'
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

function boundaryFailure(error: unknown): CordisXPlatformResult<never> {
  return {
    ok: false,
    error: {
      code: 'adapter-failure',
      message: error instanceof Error ? error.message : 'Platform provider returned an invalid result',
    },
  }
}

function unsupported(operation: PlatformProviderOperationV1): CordisXPlatformResult<never> {
  return { ok: false, error: { code: 'adapter-read-only', message: `Provider does not declare ${operation}` } }
}

export function providerConnection(input: {
  readonly descriptor: PlatformProviderDefinitionV1['descriptor']
  readonly mapping: PlatformProviderDefinitionV1['mapping']
  readonly adapter: PlatformProviderAdapterV1
  readonly broker: HostBoundPlatformProviderBrokerV1
  readonly workspaces: PlatformProviderWorkspaceAuthority
}): ProviderConnection {
  const { adapter, broker, descriptor, mapping, workspaces } = input
  const projection = new PlatformProviderProjection(adapter.providerId, mapping, workspaces)
  const operations = new Set(descriptor.operations)
  const supports = (operation: PlatformProviderOperationV1): boolean => operations.has(operation)
  let closed = false
  let lifecycleSequence = 0
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
      if (!supports('models.list')) return unsupported('models.list')
      try {
        const result = await adapter.models.list({})
        assertProviderResult(result, value => assertProviderModelPage(value, adapter.providerId))
        if (!result.ok) return hostFailure(result)
        return {
          ok: true,
          value: result.value.models.flatMap(model => {
            const projected = projection.model(model)
            return projected === undefined ? [] : [projected]
          }),
        }
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    listSessions: async request => {
      if (!supports('sessions.list')) return unsupported('sessions.list')
      try {
        const result = await adapter.sessions.list({
          limit: request.limit ?? 50,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.cwd === undefined ? {} : { workspace: workspaces.issue(request.cwd) }),
          ...(request.searchTerm === undefined ? {} : { search: request.searchTerm }),
        })
        assertProviderResult(result, value => assertProviderSessionPage(value, adapter.providerId))
        if (!result.ok) return hostFailure(result)
        result.value.sessions.forEach(value => assertProviderSession(value, adapter.providerId))
        assertProviderCursor(result.value.nextCursor)
        return {
          ok: true,
          value: {
            sessions: result.value.sessions.map(value => projection.summary(value)),
            ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
          },
        }
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    readSession: async ref => {
      if (!supports('sessions.read')) return unsupported('sessions.read')
      try {
        const result = await adapter.sessions.read(projection.inputSession(ref))
        assertProviderResult(result, value => assertProviderSession(value, adapter.providerId, true))
        if (!result.ok) return hostFailure(result)
        assertProviderSession(result.value, adapter.providerId, true)
        return { ok: true, value: projection.detail(result.value) }
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    createSession: async request => {
      if (!supports('sessions.create')) return unsupported('sessions.create')
      if (
        request.developerInstructions !== undefined || request.effort !== undefined
        || request.approvalPolicy !== undefined
      ) {
        return {
          ok: false,
          error: { code: 'adapter-read-only', message: 'Provider does not support Host-private Agent setup.' },
        }
      }
      try {
        const result = await adapter.sessions.create({
          model: projection.inputModel(request.model),
          workspace: workspaces.issue(request.cwd),
        })
        assertProviderResult(result, value => assertProviderSession(value, adapter.providerId, true))
        if (!result.ok) return hostFailure(result)
        assertProviderSession(result.value, adapter.providerId, true)
        return { ok: true, value: projection.summary(result.value) }
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    controlSession: async request => {
      if (!supports('sessions.control')) return unsupported('sessions.control')
      try {
        const session = projection.inputSession(request.session)
        const result = await adapter.sessions.control({ ...request, session })
        assertProviderResult(result, value => {
          if (request.action === 'delete') assertProviderDeleted(value)
          else assertProviderSession(value, adapter.providerId)
        })
        if (!result.ok) return hostFailure(result)
        if (!('deleted' in result.value)) assertProviderSession(result.value, adapter.providerId)
        return 'deleted' in result.value
          ? { ok: true, value: { action: 'delete', session: request.session, deleted: true } }
          : {
            ok: true,
            value: {
              action: request.action as 'continue' | 'fork' | 'archive' | 'restore',
              session: projection.summary(result.value),
            },
          }
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    submitTurn: async request => {
      if (!supports('turns.submit')) return unsupported('turns.submit')
      try {
        const session = projection.inputSession(request.session)
        const result = await adapter.turns.submit({ session, message: request.message })
        assertProviderResult(result, assertProviderTurnResult)
        if (result.ok) assertProviderTurnId(result.value.turnId)
        return result.ok
          ? { ok: true, value: { session: request.session, turnId: result.value.turnId } }
          : hostFailure(result)
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    decideApproval: async request => {
      if (!supports('approvals.decide')) return unsupported('approvals.decide')
      try {
        const result = await adapter.approvals.decide({ ...request, session: projection.inputSession(request.session) })
        assertProviderResult(result, assertProviderApprovalResult)
        if (result.ok) {
          assertProviderApprovalResult(result.value)
          if (result.value.approvalId !== request.approvalId || result.value.decision !== request.decision) {
            throw new Error('Platform provider approval result drifted from the request')
          }
        }
        return result.ok
          ? { ok: true, value: { turnId: request.turnId, ...result.value } }
          : hostFailure(result)
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    requestMemberSelfIntroduction: async request => {
      if (!supports('turns.introduce')) return unsupported('turns.introduce')
      try {
        const result = await adapter.turns.introduce({ ...request, session: projection.inputSession(request.session) })
        assertProviderResult(result, assertProviderIntroductionResult)
        if (!result.ok) return hostFailure(result)
        assertProviderTurnId(result.value.turnId)
        if (
          typeof result.value.messageId !== 'string' || result.value.messageId.length < 1
          || result.value.messageId.length > 512
        ) {
          throw new Error('Platform provider introduction messageId is invalid')
        }
        return result
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    cancelMemberSelfIntroduction: async request => {
      if (!supports('turns.control')) return unsupported('turns.control')
      try {
        const result = await adapter.turns.control({
          action: 'interrupt',
          session: projection.inputSession(request.session),
          turnId: request.turnId,
        })
        assertProviderResult(result, assertProviderTurnResult)
        if (result.ok) assertProviderTurnId(result.value.turnId)
        return result.ok ? { ok: true, value: { turnId: result.value.turnId } } : hostFailure(result)
      } catch (error) {
        return boundaryFailure(error)
      }
    },
    controlTurn: async request => {
      if (!supports('turns.control')) return unsupported('turns.control')
      try {
        const result = await adapter.turns.control({
          action: request.action,
          session: projection.inputSession(request.session),
          turnId: request.turnId ?? '',
          ...(request.action === 'steer' ? { message: request.message } : {}),
        })
        assertProviderResult(result, assertProviderTurnResult)
        if (result.ok) assertProviderTurnId(result.value.turnId)
        return result.ok
          ? { ok: true, value: { action: request.action, session: request.session, turnId: result.value.turnId } }
          : hostFailure(result)
      } catch (error) {
        return boundaryFailure(error)
      }
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
      let failure: unknown
      try {
        await adapter.drain()
      } catch (error) {
        failure = error
      }
      try {
        await adapter.dispose('host-disposed')
      } catch (error) {
        failure ??= error
      }
      try {
        await broker.dispose()
      } catch (error) {
        failure ??= error
      }
      if (failure !== undefined) throw failure
    },
  }
}
