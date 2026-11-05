import type { RemotePreparedProvider } from './remote-terminal-provider-client.js'
import type {
  NativeMarkedRequest,
  NativeProviderCredentialLease,
  NativeSubmissionScope,
} from './native-submission-controller-contracts.js'
import type {
  NativeProviderSelection,
  NormalizedNativeSubmissionAction,
  PendingNativeProviderChange,
} from '../renderer/native-provider-submission-policy.js'

export type SubmissionLease =
  & Pick<NativeProviderCredentialLease, 'serviceGeneration' | 'dispose'>
  & Partial<Pick<RemotePreparedProvider, 'validate' | 'provider'>>

export interface PreparedBase {
  readonly intentGeneration?: number
  readonly scope: NativeSubmissionScope
  readonly scopeKey: string
  readonly action: NormalizedNativeSubmissionAction
  readonly pending: PendingNativeProviderChange
  readonly selectionRevision: number
  readonly expiresAt: number
}

export interface Confirmation extends PreparedBase {
  readonly id: string
}

export interface PreparedOperation extends PreparedBase {
  readonly token: string
  readonly configOverrides: Readonly<Record<string, unknown>>
  readonly serviceGeneration: string
  readonly credential: SubmissionLease
  selectionRevision: number
  expiresAt: number
  selectionState: 'pending' | 'effective'
  state: 'available' | 'reserved' | 'consumed'
  request?: Readonly<{ key: string; method: NativeMarkedRequest['method']; threadId?: string }>
  boundScope?: NativeSubmissionScope
  draftDocumentTimeOrigin?: number
  /** Destination of this one admitted Send; the initiating scope remains the source. */
  continuationThreadId?: string
}

export interface ActiveBinding {
  readonly threadId: string
  readonly selection: NativeProviderSelection
  readonly serviceGeneration: string
  readonly credential: SubmissionLease
}

export interface PreparedThreadResume extends ActiveBinding {
  readonly token: string
}

export function scopeKey(scope: NativeSubmissionScope): string {
  if (
    scope.targetId.length === 0 || scope.targetId.length > 512
    || scope.rendererGeneration.length === 0 || scope.rendererGeneration.length > 256
    || (scope.composerId !== undefined && (scope.composerId.length === 0 || scope.composerId.length > 256
      || /[\0\r\n]/u.test(scope.composerId)))
    || !Number.isSafeInteger(scope.navigationGeneration) || scope.navigationGeneration < 0
    || scope.threadId?.length === 0 || (scope.threadId?.length ?? 0) > 512
  ) throw new Error('native submission scope is invalid')
  return JSON.stringify([
    scope.targetId,
    scope.rendererGeneration,
    scope.navigationGeneration,
    scope.threadId ?? null,
    scope.composerId ?? null,
  ])
}

export const sameScope = (left: NativeSubmissionScope, right: NativeSubmissionScope): boolean =>
  scopeKey(left) === scopeKey(right)

export const validText = (value: string, max: number): boolean =>
  value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)

export function requestKey(requestId: string | number): string {
  if (
    (typeof requestId === 'string' && validText(requestId, 512))
    || (typeof requestId === 'number' && Number.isSafeInteger(requestId))
  ) return JSON.stringify([typeof requestId, requestId])
  throw new Error('native request id is invalid')
}

export function bindingKey(threadId: string): string {
  if (!validText(threadId, 512)) throw new Error('native thread binding is invalid')
  return threadId
}
