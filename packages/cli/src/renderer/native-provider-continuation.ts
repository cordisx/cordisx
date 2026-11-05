import type {
  NativeProviderContinuation,
  NativeSubmissionScope,
  NativeSubmitHookResult,
} from './native-provider-selection-client.js'

type AllowedSubmission = Extract<NativeSubmitHookResult, { allow: true }>
interface ContinuationWitness {
  readonly operationToken: string
  readonly continuation: NativeProviderContinuation
  readonly accepted: true
}
export interface NativeContinuationOwner {
  snapshot(): { scope: NativeSubmissionScope; idle: boolean }
  composer(): HTMLElement | null | undefined
  navigateContinuation?(threadId: string): void | Promise<void>
  refreshSelection?(): Promise<void>
  continuationFailed?(): void
}
type Page = typeof globalThis & { __cordisxNativeContinuationComplete?: (value: ContinuationWitness) => void }
const sameScope = (left: NativeSubmissionScope, right: NativeSubmissionScope) =>
  left.targetId === right.targetId && left.rendererGeneration === right.rendererGeneration
  && left.composerId === right.composerId && left.navigationGeneration === right.navigationGeneration
  && left.threadId === right.threadId

/** Tokens are routed back to their initiating composer, never a focused or last-written owner. */
export function createNativeContinuationCompletion() {
  const pending = new Map<
    string,
    { owner: NativeContinuationOwner; scope: NativeSubmissionScope; branch: NativeProviderContinuation }
  >()
  return {
    available(owner: NativeContinuationOwner) {
      return typeof owner.navigateContinuation === 'function'
    },
    admitted(owner: NativeContinuationOwner, result: AllowedSubmission) {
      if (!result.continuation || !result.operationToken) return
      if (pending.size >= 32) pending.delete(pending.keys().next().value!)
      pending.set(result.operationToken, { owner, scope: owner.snapshot().scope, branch: result.continuation })
    },
    release(owner: NativeContinuationOwner) {
      for (const [token, value] of pending) if (value.owner === owner) pending.delete(token)
    },
    async complete(value: ContinuationWitness) {
      if (value?.accepted !== true || typeof value.operationToken !== 'string') return
      const witness = pending.get(value.operationToken)
      if (!witness) return
      pending.delete(value.operationToken)
      const current = () =>
        witness.owner.composer()?.isConnected
        && sameScope(witness.scope, witness.owner.snapshot().scope)
      if (
        value.continuation?.sourceThreadId !== witness.branch.sourceThreadId
        || value.continuation.threadId !== witness.branch.threadId
        || !current()
      ) return
      try {
        if (witness.owner.refreshSelection) await witness.owner.refreshSelection()
        if (current()) await witness.owner.navigateContinuation?.(witness.branch.threadId)
      } catch {
        if (current()) witness.owner.continuationFailed?.()
      }
    },
    install() {
      const page = globalThis as Page
      const previous = page.__cordisxNativeContinuationComplete
      const complete = this.complete.bind(this)
      page.__cordisxNativeContinuationComplete = complete
      return () => {
        pending.clear()
        if (page.__cordisxNativeContinuationComplete === complete) {
          if (previous) page.__cordisxNativeContinuationComplete = previous
          else delete page.__cordisxNativeContinuationComplete
        }
      }
    },
  }
}
