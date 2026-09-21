import { randomUUID } from 'node:crypto'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { CdpSession, CdpTarget } from './cdp-session.js'
import type {
  NativeSubmissionController,
  NativeSubmissionRuntimeAuthority,
  NativeSubmissionScope,
  NativeSubmissionSelectionAuthority,
} from './native-submission-controller.js'
import type {
  NativeProviderSelection,
  NormalizedNativeSubmissionAction,
  PendingNativeProviderChange,
} from '../renderer/native-provider-submission-policy.js'

const BINDING = '__cordisxNativeSubmissionCommand'
const RECEIVER = '__cordisxNativeSubmissionReceive'
const key = (scope: NativeSubmissionScope): string =>
  JSON.stringify([scope.targetId, scope.rendererGeneration, scope.navigationGeneration, scope.threadId ?? null])
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
function scopeOf(value: unknown): NativeSubmissionScope {
  const scope = record(value)
  if (
    !scope || !text(scope.targetId) || !text(scope.rendererGeneration, 256)
    || !Number.isSafeInteger(scope.navigationGeneration) || (scope.navigationGeneration as number) < 0
    || (scope.threadId !== undefined && !text(scope.threadId))
  ) throw new Error('Invalid native scope')
  return {
    targetId: scope.targetId,
    rendererGeneration: scope.rendererGeneration,
    navigationGeneration: scope.navigationGeneration as number,
    ...(typeof scope.threadId === 'string' ? { threadId: scope.threadId } : {}),
  }
}
function selectionOf(value: unknown): NativeProviderSelection {
  const selection = record(value)
  if (!selection || !text(selection.providerId, 128) || !text(selection.model)) {
    throw new Error('Invalid native selection')
  }
  return { providerId: selection.providerId, model: selection.model }
}
function actionOf(value: unknown): NormalizedNativeSubmissionAction {
  const action = record(value)
  if (
    !action || !text(action.operationId, 256) || !Number.isSafeInteger(action.operationGeneration)
    || (action.operationGeneration as number) < 1 || (action.threadId !== undefined && !text(action.threadId))
    || !['ordinary-send', 'steer', 'queue', 'edit-retry', 'unknown-submission', 'non-submission'].includes(
      String(action.intent),
    )
  ) throw new Error('Invalid native action')
  return action as unknown as NormalizedNativeSubmissionAction
}
interface State {
  scope: NativeSubmissionScope
  revision: number
  nextGeneration: number
  effective: NativeProviderSelection
  pending?: PendingNativeProviderChange
}
const projection = (state: State) => ({
  available: true,
  revision: state.revision,
  effective: state.effective,
  ...(state.pending === undefined
    ? {}
    : {
      pending: {
        providerId: state.pending.providerId,
        model: state.pending.model,
        generation: state.pending.selectionGeneration,
      },
    }),
})
interface DocumentOwner {
  generation: string
  session: CdpSession
  disposed: boolean
}
export interface NativeSubmissionCdpAuthority {
  readonly selection: NativeSubmissionSelectionAuthority
  readonly runtime: NativeSubmissionRuntimeAuthority
  bindController(controller: NativeSubmissionController): void
  install(session: CdpSession, target: CdpTarget): Promise<{ dispose(): Promise<void> }>
}

/** Each binding belongs to one native renderer generation, never a shared global request queue. */
export function createNativeSubmissionCdpAuthority(options: {
  catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
  isThreadIdle(threadId: string): Promise<boolean>
}): NativeSubmissionCdpAuthority {
  const states = new Map<string, State>()
  const threadSelections = new Map<string, NativeProviderSelection>()
  const documents = new Map<string, DocumentOwner>()
  let controller: NativeSubmissionController | undefined
  const selection: NativeSubmissionSelectionAuthority = {
    adoptScope(source, target) {
      if (key(source) === key(target)) return states.has(key(source))
      if (
        source.targetId !== target.targetId || source.rendererGeneration !== target.rendererGeneration
        || source.threadId === undefined || source.threadId !== target.threadId
        || target.navigationGeneration !== source.navigationGeneration + 1
      ) return false
      const prior = states.get(key(source))
      const next = states.get(key(target))
      if (
        !prior || prior.pending || (next && (next.pending
          || next.revision !== 1 || next.nextGeneration !== 1
          || next.effective.providerId !== prior.effective.providerId
          || next.effective.model !== prior.effective.model))
      ) return false
      states.set(key(target), { ...prior, scope: target })
      states.delete(key(source))
      return true
    },
    snapshot(scope) {
      const state = states.get(key(scope))
      if (!state) throw new Error('Native selection scope unavailable')
      return {
        revision: state.revision,
        effective: state.effective,
        ...(state.pending === undefined ? {} : { pending: state.pending }),
      }
    },
    commitEffective(input) {
      const state = states.get(key(input.sourceScope ?? input.scope))
      if (
        !state || state.revision !== input.expectedRevision
        || state.pending?.selectionGeneration !== input.pendingGeneration
      ) return false
      state.effective = { providerId: input.selection.providerId, model: input.selection.model }
      delete state.pending
      state.revision++
      if (input.scope.threadId !== undefined) threadSelections.set(input.scope.threadId, state.effective)
      if (key(input.scope) !== key(state.scope)) {
        states.set(key(input.scope), { ...state, scope: input.scope })
        states.delete(key(state.scope))
      }
      return true
    },
    clearPending(input) {
      const state = states.get(key(input.scope))
      if (
        !state || state.revision !== input.expectedRevision
        || state.pending?.selectionGeneration !== input.pendingGeneration
      ) return false
      delete state.pending
      state.revision++
      return true
    },
  }
  const liveScope = async (scope: NativeSubmissionScope): Promise<NativeSubmissionScope | undefined> => {
    const owner = documents.get(scope.targetId)
    if (!owner || owner.disposed || owner.generation !== scope.rendererGeneration || owner.session.isClosed()) {
      return undefined
    }
    const response = await owner.session.send('Runtime.evaluate', {
      expression: 'globalThis.__cordisxNativeSubmissionAuthority?.snapshot?.()',
      returnByValue: true,
    })
    if (response.exceptionDetails) return undefined
    try {
      return scopeOf(record(record(response.result)?.value)?.scope)
    } catch {
      return undefined
    }
  }
  const runtime: NativeSubmissionRuntimeAuthority = {
    async resolveCreatedScope(draft, threadId) {
      if (draft.threadId !== undefined || !text(threadId)) return undefined
      const live = await liveScope(draft)
      if (!live || live.targetId !== draft.targetId || live.rendererGeneration !== draft.rendererGeneration) {
        return undefined
      }
      if (key(live) === key(draft)) return { ...draft, threadId }
      return live.threadId === threadId && live.navigationGeneration === draft.navigationGeneration + 1
        ? live
        : undefined
    },
    async revalidate(scope, requireIdle, createdFrom) {
      try {
        const live = await liveScope(scope)
        const matches = (value: NativeSubmissionScope | undefined) =>
          value !== undefined && (key(value) === key(scope)
            || (createdFrom?.threadId === undefined && createdFrom !== undefined && scope.threadId !== undefined
              && key(value) === key(createdFrom) && scope.targetId === createdFrom.targetId
              && scope.rendererGeneration === createdFrom.rendererGeneration
              && scope.navigationGeneration === createdFrom.navigationGeneration))
        if (!matches(live)) return false
        if (!requireIdle || scope.threadId === undefined) return true
        if (!await options.isThreadIdle(scope.threadId)) return false
        return matches(await liveScope(scope))
      } catch {
        return false
      }
    },
  }
  return {
    selection,
    runtime,
    bindController(value) {
      if (controller) throw new Error('Native controller already bound')
      controller = value
    },
    async install(session, target) {
      if (target.url !== 'app://-/index.html' || !controller || documents.has(target.id)) {
        throw new Error('Invalid native channel owner')
      }
      const generation = randomUUID()
      const owner: DocumentOwner = { generation, session, disposed: false }
      documents.set(target.id, owner)
      const active = new Set<string>()
      const respond = async (requestId: string, value: unknown, ok = true): Promise<void> => {
        if (owner.disposed) return
        await session.send('Runtime.evaluate', {
          expression: `globalThis.${RECEIVER}?.(${JSON.stringify(generation)},${
            JSON.stringify({ requestId, ok, value })
          })`,
        })
      }
      const dispatch = async (payload: string): Promise<void> => {
        let requestId = 'invalid'
        let admitted = false
        try {
          if (Buffer.byteLength(payload) > 65_536 || owner.disposed || active.size >= 16) {
            throw new Error('Native channel unavailable')
          }
          const envelope = record(JSON.parse(payload))
          if (!text(envelope?.requestId, 256)) throw new Error('Invalid request id')
          requestId = envelope.requestId
          if (active.has(requestId)) throw new Error('Duplicate native command')
          const input = record(envelope.input)
          if (envelope.operation === 'catalogRead') {
            active.add(requestId)
            admitted = true
            await respond(requestId, await options.catalog())
            return
          }
          const scope = scopeOf(input?.scope)
          if (scope.targetId !== target.id || scope.rendererGeneration !== generation) {
            throw new Error('Wrong native owner')
          }
          active.add(requestId)
          admitted = true
          const live = await liveScope(scope)
          if (!live || key(live) !== key(scope) || owner.disposed) throw new Error('Stale native document')
          let state = states.get(key(scope))
          if (envelope.operation === 'selectionRead') {
            const supplied = selectionOf(input?.effective)
            if (!state) {
              state = {
                scope,
                revision: 1,
                nextGeneration: 1,
                effective: scope.threadId ? threadSelections.get(scope.threadId) ?? supplied : supplied,
              }
              states.set(key(scope), state)
            }
            await respond(requestId, projection(state))
          } else if (envelope.operation === 'selectionSelect') {
            if (!state) throw new Error('Native selection not initialized')
            const selected = selectionOf(input)
            const catalog = await options.catalog()
            const liveAfter = await liveScope(scope)
            if (!liveAfter || key(liveAfter) !== key(scope) || owner.disposed) throw new Error('Stale native selection')
            if (
              selected.providerId !== state.effective.providerId
              && selected.providerId !== 'openai'
              && !catalog.some(provider =>
                provider.providerId === selected.providerId
                && provider.models.some(model => model.id === selected.model)
              )
            ) throw new Error('Selection is outside provider catalog')
            state.revision++
            if (selected.providerId === state.effective.providerId) {
              delete state.pending
              state.effective = selected
              if (scope.threadId) threadSelections.set(scope.threadId, selected)
            } else {state.pending = {
                ...selected,
                ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
                selectionGeneration: state.nextGeneration++,
              }}
            if (selected.providerId !== state.effective.providerId && scope.threadId !== undefined) {
              const committed = await controller!.commitSelection(scope)
              if (committed.kind !== 'accepted') throw new Error('Native provider switch failed')
              await respond(requestId, { status: 'accepted', ...committed.projection })
            } else await respond(requestId, { status: 'accepted', ...projection(state) })
          } else if (envelope.operation === 'submissionPrepare') {
            const result = await controller!.prepareSubmission(scope, actionOf(input?.action))
            await respond(
              requestId,
              result.kind === 'confirm'
                ? {
                  status: result.kind,
                  confirmationId: result.confirmationId,
                  expectedSelectionRevision: result.selectionRevision,
                }
                : { ...result, status: result.kind },
            )
          } else if (envelope.operation === 'submissionConfirm') {
            if (!text(input?.confirmationId, 256) || !Number.isSafeInteger(input?.expectedSelectionRevision)) {
              throw new Error('Invalid confirmation')
            }
            const result = await controller!.confirmSubmission({
              scope,
              confirmationId: input.confirmationId,
              expectedSelectionRevision: input.expectedSelectionRevision as number,
            })
            await respond(requestId, { ...result, status: result.kind })
          } else if (envelope.operation === 'submissionCancel') {
            if (!text(input?.id, 256)) throw new Error('Invalid cancellation')
            await respond(requestId, await controller!.cancel({ scope, id: input.id }))
          } else throw new Error('Unknown native command')
        } catch {
          await respond(requestId, undefined, false).catch(() => undefined)
        } finally {
          if (admitted) active.delete(requestId)
        }
      }
      await session.send('Runtime.addBinding', { name: BINDING })
      const remove = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name === BINDING && typeof params.payload === 'string') void dispatch(params.payload)
      })
      const source = `(() => {
        const generation=${JSON.stringify(generation)},pending=new Map();let disposed=false;
        let activate;globalThis.__cordisxNativeSubmissionReady=new Promise(resolve=>{activate=resolve});globalThis.__cordisxNativeSubmissionActivate=activate;
        globalThis.__cordisxNativeProviderOwner=Object.freeze({targetId:${
        JSON.stringify(target.id)
      },rendererGeneration:generation});
        globalThis.${RECEIVER}=(owner,message)=>{if(owner!==generation)return;const p=pending.get(message.requestId);if(!p)return;pending.delete(message.requestId);clearTimeout(p.timer);message.ok?p.resolve(message.value):p.reject(new Error('Native submission rejected'))};
        const call=(operation,input)=>new Promise((resolve,reject)=>{if(disposed||pending.size>=16){reject(new Error('Native channel unavailable'));return}const requestId=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Native submission timed out'))},30000);pending.set(requestId,{resolve,reject,timer});try{globalThis.${BINDING}(JSON.stringify({requestId,operation,input}))}catch(error){pending.delete(requestId);clearTimeout(timer);reject(error)}});
        globalThis.__cordisxNativeProviderCommandChannel=Object.freeze({catalogRead:()=>call('catalogRead',{}),selectionRead:input=>call('selectionRead',input),selectionSelect:input=>call('selectionSelect',input),submissionPrepare:input=>call('submissionPrepare',input),submissionConfirm:input=>call('submissionConfirm',input),submissionCancel:input=>call('submissionCancel',input)});
        globalThis.__cordisxNativeSubmissionChannelDispose=()=>{disposed=true;activate(false);for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Native channel disposed'))}pending.clear();delete globalThis.__cordisxNativeProviderOwner;delete globalThis.__cordisxNativeProviderCommandChannel;delete globalThis.${RECEIVER};delete globalThis.__cordisxNativeSubmissionReady;delete globalThis.__cordisxNativeSubmissionActivate;delete globalThis.__cordisxNativeSubmissionChannelDispose};
      })()`
      let identifier: string | undefined
      const dispose = async (): Promise<void> => {
        if (owner.disposed) return
        owner.disposed = true
        documents.delete(target.id)
        remove()
        for (const [id, state] of states) {
          if (state.scope.targetId === target.id && state.scope.rendererGeneration === generation) {
            await controller!.releaseScope(state.scope).catch(() => undefined)
            states.delete(id)
          }
        }
        await Promise.allSettled([
          session.send('Runtime.evaluate', { expression: 'globalThis.__cordisxNativeSubmissionChannelDispose?.()' }),
          session.send('Runtime.removeBinding', { name: BINDING }),
          ...(identifier === undefined
            ? []
            : [session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })]),
        ])
      }
      try {
        const added = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
        if (typeof added.identifier !== 'string') throw new Error('Native channel script registration failed')
        identifier = added.identifier
        await session.send('Runtime.evaluate', { expression: source })
        return { dispose }
      } catch (error) {
        await dispose()
        throw error
      }
    },
  }
}
