import { vi } from 'vitest'
import {
  createNativeSubmissionController,
  type NativeProviderCredentialLease,
  type NativeSubmissionScope,
  type NativeSubmissionSelectionSnapshot,
} from '../../packages/cli/src/launcher/native-submission-controller.js'
import type { PendingNativeProviderChange } from '../../packages/cli/src/renderer/native-provider-submission-policy.js'

export const draftScope: NativeSubmissionScope = {
  targetId: 'target-a',
  rendererGeneration: 'renderer-1',
  navigationGeneration: 3,
}
export const threadScope: NativeSubmissionScope = { ...draftScope, threadId: 'thread-1' }
export const pendingDraft: PendingNativeProviderChange = {
  providerId: 'provider-b',
  model: 'model-b',
  selectionGeneration: 7,
}
export const pendingThread: PendingNativeProviderChange = { ...pendingDraft, threadId: 'thread-1' }
export const draftAction = {
  operationId: 'operation-draft',
  operationGeneration: 11,
  intent: 'ordinary-send' as const,
}
export const threadAction = { ...draftAction, operationId: 'operation-thread', threadId: 'thread-1' }
export const requestId = 'native-request-1'

export function harness(input: {
  scope?: NativeSubmissionScope
  pending?: PendingNativeProviderChange
  now?: () => number
  runtimeValid?: () => boolean
  createdNavigation?: () => number
  prepareConfiguredProvider?: (providerId: string) => Promise<Readonly<Record<string, unknown>>>
  providerSource?: (providerId: string) => 'managed' | 'config' | undefined
  validateSelection?: (selection: { providerId: string; model: string }) => Promise<boolean>
} = {}) {
  const scope = input.scope ?? draftScope
  let snapshot: NativeSubmissionSelectionSnapshot = {
    revision: 4,
    effective: { providerId: 'provider-a', model: 'model-a' },
    ...(input.pending === undefined ? {} : { pending: input.pending }),
  }
  const snapshots = new Map([[JSON.stringify(scope), snapshot]])
  const disposed: string[] = []
  let leaseSequence = 0
  const prepare = vi.fn(async (providerId: string): Promise<NativeProviderCredentialLease> => {
    const id = `${providerId}-${++leaseSequence}`
    return {
      serviceGeneration: `service-${id}`,
      endpoint: { baseUrl: 'http://127.0.0.1:43127/v1', wireApi: 'responses' },
      auth: {
        scheme: 'bearer-command',
        command: '/usr/bin/node',
        args: ['/private/helper.mjs', id],
        cwd: '/private',
        timeoutMs: 5_000,
        refreshIntervalMs: 200,
      },
      dispose: () => disposed.push(id),
    }
  })
  const commitEffective = vi.fn((value: {
    scope: NativeSubmissionScope
    expectedRevision: number
    pendingGeneration: number
    selection: { providerId: string; model: string }
  }) => {
    const key = JSON.stringify(value.scope)
    const current = snapshots.get(key) ?? snapshot
    if (
      current.revision !== value.expectedRevision
      || current.pending?.selectionGeneration !== value.pendingGeneration
    ) return false
    const next = { revision: current.revision + 1, effective: value.selection }
    snapshots.set(key, next)
    if (key === JSON.stringify(scope)) snapshot = next
    return true
  })
  const clearPending = vi.fn((value: {
    scope: NativeSubmissionScope
    expectedRevision: number
    pendingGeneration: number
  }) => {
    const key = JSON.stringify(value.scope)
    const current = snapshots.get(key) ?? snapshot
    if (
      current.revision !== value.expectedRevision
      || current.pending?.selectionGeneration !== value.pendingGeneration
    ) return false
    const next = { revision: current.revision + 1, effective: current.effective }
    snapshots.set(key, next)
    if (key === JSON.stringify(scope)) snapshot = next
    return true
  })
  const switchThread = vi.fn(async () => undefined)
  const runtimeRevalidate = vi.fn(async () => input.runtimeValid?.() ?? true)
  let id = 0
  const controller = createNativeSubmissionController({
    selection: {
      adoptScope: (source, target) => {
        const current = snapshots.get(JSON.stringify(source))
        if (!current) return false
        snapshots.set(JSON.stringify(target), current)
        return true
      },
      snapshot: requested => snapshots.get(JSON.stringify(requested)) ?? snapshot,
      commitEffective,
      clearPending,
    },
    credentials: { prepare },
    runtime: {
      revalidate: runtimeRevalidate,
      resolveCreatedScope: async (draft, threadId) => ({
        ...draft,
        threadId,
        navigationGeneration: input.createdNavigation?.() ?? draft.navigationGeneration,
      }),
    },
    existingThread: { switch: switchThread },
    ...(input.prepareConfiguredProvider === undefined
      ? {}
      : { prepareConfiguredProvider: input.prepareConfiguredProvider }),
    ...(input.providerSource === undefined ? {} : { providerSource: input.providerSource }),
    ...(input.validateSelection === undefined ? {} : { validateSelection: input.validateSelection }),
    operationTtlMs: 100,
    now: input.now,
    createId: () => `opaque-operation-${String(++id).padStart(4, '0')}`,
  })
  return {
    controller,
    disposed,
    prepare,
    commitEffective,
    clearPending,
    switchThread,
    runtimeRevalidate,
    setSnapshot(next: NativeSubmissionSelectionSnapshot, requested = scope) {
      snapshots.set(JSON.stringify(requested), next)
      if (JSON.stringify(requested) === JSON.stringify(scope)) snapshot = next
    },
  }
}
