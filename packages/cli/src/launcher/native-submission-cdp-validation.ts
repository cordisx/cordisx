import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'
import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'
import type {
  NativeProviderSelection,
  NormalizedNativeSubmissionAction,
} from '../renderer/native-provider-submission-policy.js'

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
export function scopeOf(value: unknown): NativeSubmissionScope {
  const scope = record(value)
  if (
    !scope || !text(scope.targetId) || !text(scope.rendererGeneration, 256)
    || !Number.isSafeInteger(scope.navigationGeneration) || (scope.navigationGeneration as number) < 0
    || (scope.threadId !== undefined && !text(scope.threadId))
    || (scope.composerId !== undefined && !text(scope.composerId, 256))
  ) throw new Error('Invalid native scope')
  return {
    targetId: scope.targetId,
    rendererGeneration: scope.rendererGeneration,
    navigationGeneration: scope.navigationGeneration as number,
    ...(typeof scope.composerId === 'string' ? { composerId: scope.composerId } : {}),
    ...(typeof scope.threadId === 'string' ? { threadId: scope.threadId } : {}),
  }
}
export function selectionOf(value: unknown): NativeProviderSelection {
  const selection = record(value)
  if (!selection || !text(selection.providerId, 128) || !text(selection.model)) {
    throw new Error('Invalid native selection')
  }
  return { providerId: selection.providerId, model: selection.model }
}
export function actionOf(value: unknown): NormalizedNativeSubmissionAction {
  const action = record(value)
  if (
    !action || !text(action.operationId, 256) || !Number.isSafeInteger(action.operationGeneration)
    || (action.operationGeneration as number) < 1 || (action.threadId !== undefined && !text(action.threadId))
    || (action.reasoningEffort !== undefined && !isModelReasoningEffort(action.reasoningEffort))
    || (action.continuationAvailable !== undefined && typeof action.continuationAvailable !== 'boolean')
    || !['ordinary-send', 'steer', 'queue', 'edit-retry', 'unknown-submission', 'non-submission'].includes(
      String(action.intent),
    )
  ) throw new Error('Invalid native action')
  return action as unknown as NormalizedNativeSubmissionAction
}
