import { describe, expect, it } from 'vitest'
import {
  decideNativeProviderSelection,
  decideNativeProviderSubmission,
  resolveNativeModelEligibility,
  revalidatePreparedNativeProviderChange,
} from '../packages/cli/src/renderer/native-provider-submission-policy.js'

const pending = Object.freeze({
  providerId: 'provider-b',
  model: 'model-b',
  threadId: 'thread-1',
  selectionGeneration: 7,
})
const action = Object.freeze({
  operationId: 'native-submit-1',
  operationGeneration: 11,
  intent: 'ordinary-send' as const,
  threadId: 'thread-1',
})

describe('native provider ordinary-send policy', () => {
  it('keeps compatibility, route availability, and user preference independent', () => {
    expect(resolveNativeModelEligibility({
      wireApi: 'responses',
      protocolCapabilities: { responses: true },
      routeAvailable: true,
      userDisabled: false,
    })).toEqual({ compatibility: 'supported', routeAvailable: true, userDisabled: false, selectable: true })
    expect(resolveNativeModelEligibility({
      wireApi: 'responses',
      exactConfiguredMembership: true,
      routeAvailable: true,
      userDisabled: true,
    })).toEqual({ compatibility: 'supported', routeAvailable: true, userDisabled: true, selectable: false })
    expect(
      resolveNativeModelEligibility({
        wireApi: 'chat-completions',
        protocolCapabilities: { responses: true },
        routeAvailable: true,
        userDisabled: false,
      }).compatibility,
    ).toBe('unsupported')
    expect(
      resolveNativeModelEligibility({
        protocolCapabilities: { responses: true },
        routeAvailable: true,
        userDisabled: false,
      }).compatibility,
    ).toBe('unknown')
    expect(
      resolveNativeModelEligibility({
        wireApi: 'responses',
        protocolCapabilities: { responses: false },
        exactConfiguredMembership: true,
        routeAvailable: true,
        userDisabled: false,
      }).compatibility,
    ).toBe('supported')
  })

  it('keeps cross-provider choice pending and treats a same-provider model as an immediate model choice', () => {
    expect(decideNativeProviderSelection('provider-a', pending)).toEqual({
      kind: 'pending-provider-change',
      pending,
    })
    expect(decideNativeProviderSelection('provider-a', { providerId: 'provider-a', model: 'model-c' })).toEqual({
      kind: 'same-provider-model',
      target: { providerId: 'provider-a', model: 'model-c' },
      clearsPending: true,
    })
  })

  it('passes native behavior through when no provider change is pending', () => {
    for (const intent of ['ordinary-send', 'steer', 'queue', 'edit-retry', 'unknown-submission'] as const) {
      expect(decideNativeProviderSubmission(undefined, { ...action, intent })).toEqual({ kind: 'pass-through' })
    }
  })

  it('prepares only an adapter-normalized ordinary Send operation', () => {
    expect(decideNativeProviderSubmission(pending, action)).toEqual({
      kind: 'prepare-provider-change',
      prepared: { pending, action },
    })
  })

  it('rejects adapter-normalized unsupported submissions', () => {
    for (const intent of ['steer', 'queue', 'edit-retry', 'unknown-submission'] as const) {
      expect(decideNativeProviderSubmission(pending, { ...action, intent })).toEqual({
        kind: 'reject',
        reason: 'unsupported-submission-intent',
      })
    }
  })

  it('passes an adapter-normalized non-submission action through', () => {
    expect(decideNativeProviderSubmission(pending, { ...action, intent: 'non-submission' })).toEqual({
      kind: 'pass-through',
    })
  })

  it('rechecks intent, thread, operation identity, and selection generation after preparation', () => {
    const prepared = { pending, action }
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action,
      pending,
    })).toEqual({ kind: 'dispatch' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action: { ...action, intent: 'steer' },
      pending,
    })).toEqual({ kind: 'reject', reason: 'intent-changed' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action: { ...action, threadId: 'thread-2' },
      pending,
    })).toEqual({ kind: 'reject', reason: 'thread-changed' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action: { ...action, operationId: 'native-submit-2' },
      pending,
    })).toEqual({ kind: 'reject', reason: 'operation-changed' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action: { ...action, operationGeneration: 12 },
      pending,
    })).toEqual({ kind: 'reject', reason: 'operation-changed' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action,
      pending: { ...pending, model: 'model-c' },
    })).toEqual({ kind: 'reject', reason: 'selection-changed' })
    expect(revalidatePreparedNativeProviderChange(prepared, {
      action,
      pending: { ...pending, selectionGeneration: 9 },
    })).toEqual({ kind: 'reject', reason: 'selection-changed' })
  })
})
