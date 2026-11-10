import { isModelReasoningEffort, type ModelReasoningEffort } from '../model-reasoning-capabilities.js'
import type { NativeSubmissionScope } from '../renderer/native-provider-selection-client.js'
import type { CdpSession } from './cdp-session.js'

export interface NativeSourceConfiguration {
  readonly providerId: string
  readonly model: string
  readonly reasoningEffort: ModelReasoningEffort
  readonly serviceTier: 'priority' | null
}

type Candidate = {
  readonly scope: NativeSubmissionScope
  readonly revision: number
  readonly effective?: { readonly providerId: string; readonly model: string }
  readonly pending?: unknown
  readonly pendingProviderIntent?: unknown
}
type Owner = { readonly generation: string; readonly session: CdpSession; readonly disposed: boolean }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const scopeKey = (scope: NativeSubmissionScope) =>
  JSON.stringify([
    scope.targetId,
    scope.rendererGeneration,
    scope.navigationGeneration,
    scope.threadId ?? null,
    scope.composerId ?? null,
  ])

/** Read only a live, bound composer; never promote display cache or native defaults into routing. */
export async function readNativeSourceConfiguration(
  threadId: string,
  states: () => Iterable<Candidate>,
  ownerFor: (targetId: string) => Owner | undefined,
  committedFor: (threadId: string) => Candidate['effective'] = () => undefined,
): Promise<NativeSourceConfiguration | undefined> {
  const candidates = [...states()].filter(state => state.scope.threadId === threadId)
  const versions = candidates.map(state => [state, state.revision, state.effective] as const)
  let result: NativeSourceConfiguration | undefined
  for (const state of candidates) {
    if (!state.effective || state.pending || state.pendingProviderIntent) return undefined
    const { scope, revision, effective } = state
    const owner = ownerFor(scope.targetId)
    if (!owner || owner.disposed || owner.generation !== scope.rendererGeneration || owner.session.isClosed()) continue
    const expression = scope.composerId === undefined
      ? 'globalThis.__cordisxNativeSubmissionAuthority?.snapshot?.()'
      : `globalThis.__cordisxNativeSubmissionAuthority?.resolve?.(${JSON.stringify(scope)})`
    let response
    try {
      response = await owner.session.send('Runtime.evaluate', { expression, returnByValue: true }, 2_000)
    } catch {
      return undefined
    }
    if (
      response.exceptionDetails || owner.disposed || owner.session.isClosed() || ownerFor(scope.targetId) !== owner
      || state.revision !== revision || state.effective !== effective
    ) return undefined
    const value = object(object(response.result)?.value)
    const live = object(value?.scope)
    if (!live || scopeKey(live as unknown as NativeSubmissionScope) !== scopeKey(scope)) continue
    const tuple = object(value?.sourceConfiguration)
    if (
      !tuple || tuple.providerId !== effective.providerId || tuple.model !== effective.model
      || !isModelReasoningEffort(tuple.reasoningEffort)
      || (tuple.serviceTier !== null && tuple.serviceTier !== 'priority')
    ) return undefined
    const found: NativeSourceConfiguration = {
      providerId: effective.providerId,
      model: effective.model,
      reasoningEffort: tuple.reasoningEffort,
      serviceTier: tuple.serviceTier,
    }
    if (result && JSON.stringify(result) !== JSON.stringify(found)) return undefined
    result = found
  }
  const current = [...states()].filter(state => state.scope.threadId === threadId)
  if (
    current.length !== candidates.length
    || versions.some(([state, revision, effective]) =>
      !current.includes(state) || state.revision !== revision || state.effective !== effective
    )
  ) return undefined
  const committed = committedFor(threadId)
  if (result && committed && (result.providerId !== committed.providerId || result.model !== committed.model)) {
    return undefined
  }
  return result
}

/** Reconcile only committed thread identity, preserving pending user intent. */
export function reconcileNativeThreadSelection(
  state: { effective?: { providerId: string; model: string }; revision: number },
  shared: { providerId: string; model: string } | undefined,
): void {
  if (
    shared && state.effective
    && (state.effective.providerId !== shared.providerId || state.effective.model !== shared.model)
  ) {
    state.effective = { ...shared }
    state.revision++
  }
}
