import type { NativeSubmissionOrchestratorDescriptor } from './adapter/native-submission-action-normalizer.js'
import type { NativeProviderSelectionClient, NativeSubmissionScope } from './native-provider-selection-client.js'
import { createNativeContinuationCompletion, type NativeContinuationOwner } from './native-provider-continuation.js'

interface ComposerSubmission extends NativeContinuationOwner {
  submit: NativeProviderSelectionClient['submitHook']
  serviceTier(): 'priority' | 'default'
  creationAdmitted?(
    result: Awaited<ReturnType<NativeProviderSelectionClient['submitHook']>>,
    descriptor: NativeSubmissionOrchestratorDescriptor,
  ): void
}

/** Success refresh belongs to the initiating composer and completes before native navigation. */
export function nativeComposerContinuation(
  selection: NativeProviderSelectionClient,
  navigateContinuation?: NativeContinuationOwner['navigateContinuation'],
): Pick<NativeContinuationOwner, 'navigateContinuation' | 'refreshSelection' | 'continuationFailed'> {
  return navigateContinuation === undefined ? {} : {
    navigateContinuation,
    refreshSelection: () => selection.refresh(),
    continuationFailed: () => selection.reportContinuationFailure(),
  }
}

type Hook = NativeProviderSelectionClient['submitHook']
interface SubmissionAuthority {
  snapshot(): { scope: NativeSubmissionScope; idle: boolean } | undefined
  resolve(scope: NativeSubmissionScope): { scope: NativeSubmissionScope; idle: boolean } | undefined
}
type NativePage = typeof globalThis & {
  __cordisxNativeSubmitHook?: Hook
  __cordisxNativeSubmissionAuthority?: SubmissionAuthority
  __cordisxNativeServiceTierOverride?: 'priority' | 'default'
}

/** Renderer-local dispatcher; each composer retains its own authoritative selection and lifetime. */
const owners = new Set<ComposerSubmission>()
const continuations = createNativeContinuationCompletion()
let restore: (() => void) | undefined

function liveOwners(): ComposerSubmission[] {
  return [...owners].filter(owner => owner.composer()?.isConnected)
}

function focusedOwner(): ComposerSubmission | undefined {
  const live = liveOwners()
  if (live.length === 1) return live[0]
  const candidates = live.filter(owner => {
    const composer = owner.composer()
    return composer?.contains(composer.ownerDocument.activeElement)
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

function forDescriptor(descriptor: NativeSubmissionOrchestratorDescriptor): ComposerSubmission | undefined {
  const thread = typeof descriptor.thread === 'string' && descriptor.thread !== ''
    ? descriptor.thread
    : typeof descriptor.followUpThread === 'string' && descriptor.followUpThread !== ''
    ? descriptor.followUpThread
    : undefined
  const candidates = liveOwners().filter(owner => owner.snapshot().scope.threadId === thread)
  // A threadless Send can use focus only among threadless composers. Never borrow a main thread.
  if (candidates.length === 1) return candidates[0]
  const focused = focusedOwner()
  return focused && candidates.includes(focused) ? focused : undefined
}

const submit: Hook = async descriptor => {
  const owner = forDescriptor(descriptor)
  if (!owner) return { allow: false }
  const result = await owner.submit({
    ...descriptor,
    continuationAvailable: descriptor.continuationAvailable === true && continuations.available(owner),
  })
  if (result.allow) {
    continuations.admitted(owner, result)
    owner.creationAdmitted?.(result, descriptor)
  }
  return result.allow && owner.snapshot().scope.composerId !== undefined
    ? { ...result, serviceTier: owner.serviceTier() }
    : result
}

const authority: SubmissionAuthority = {
  snapshot: () => focusedOwner()?.snapshot(),
  resolve(scope) {
    const candidates = liveOwners().filter(owner => {
      const live = owner.snapshot().scope
      // Navigation and draft->thread adoption are checked by the Host against this live result.
      return live.targetId === scope.targetId && live.rendererGeneration === scope.rendererGeneration
        && live.composerId === scope.composerId
    })
    return candidates.length === 1 ? candidates[0]!.snapshot() : undefined
  },
}

export function registerNativeComposerSubmission(owner: ComposerSubmission): () => void {
  const page = globalThis as NativePage
  if (owners.size === 0) {
    const previousHook = page.__cordisxNativeSubmitHook
    const previousAuthority = page.__cordisxNativeSubmissionAuthority
    const previousTier = page.__cordisxNativeServiceTierOverride
    const restoreContinuations = continuations.install()
    page.__cordisxNativeSubmitHook = submit
    page.__cordisxNativeSubmissionAuthority = authority
    restore = () => {
      restoreContinuations()
      if (page.__cordisxNativeSubmitHook === submit) {
        if (previousHook) page.__cordisxNativeSubmitHook = previousHook
        else delete page.__cordisxNativeSubmitHook
      }
      if (page.__cordisxNativeSubmissionAuthority === authority) {
        if (previousAuthority) page.__cordisxNativeSubmissionAuthority = previousAuthority
        else delete page.__cordisxNativeSubmissionAuthority
      }
      delete page.__cordisxNativeServiceTierOverride
      if (previousTier) page.__cordisxNativeServiceTierOverride = previousTier
    }
  }
  owners.add(owner)
  // Multiple composers must not publish one last-writer-wins Fast setting.
  Object.defineProperty(page, '__cordisxNativeServiceTierOverride', {
    configurable: true,
    get: () => owners.size === 1 ? [...owners][0]!.serviceTier() : undefined,
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    continuations.release(owner)
    owners.delete(owner)
    if (owners.size === 0) {
      restore?.()
      restore = undefined
    }
  }
}
