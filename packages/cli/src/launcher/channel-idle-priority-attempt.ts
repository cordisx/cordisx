import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationJob, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { channelIdleGrantCurrent } from './channel-idle-priority-grant.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'
import { channelIdlePriorityOperation } from './channel-idle-priority-status.js'
import { startChannelLogicalContinuation } from './channel-logical-continuation.js'
import { channelTaskCatalog, validateChannelTaskSelection } from './channel-task-selection.js'

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort!: () => void
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('CANCELLED'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(new Error('TIMEOUT')), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Returns true when this pump must not dispatch the original input. */
export async function attemptChannelIdlePriority(input: {
  store: ChannelConversationStore
  native?: ChannelNativeSessions | undefined
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId?: string | undefined
  profileId: string
  event: ChannelEventRef
  job: ChannelConversationJob
  signal: AbortSignal
}): Promise<boolean> {
  const { store, native, job, claims, event, signal, appId, profileId } = input
  if (!appId || !native?.logicalMigrationLease || !job.sessionId || !job.bindingId || job.autoCreate) return false
  const grant = store.snapshot().logicalContinuations?.idlePriorityGrants?.[job.bindingId]
  if (
    !grant || grant.source.appId !== appId || grant.source.profileId !== profileId
    || !channelIdleGrantCurrent(store.snapshot(), grant, event, job.id)
  ) return false
  if (claims.has(job.sessionId) || input.fence.isMigrating(job.sessionId)) return true
  const source = job.sessionId
  claims.add(source)
  let ownsClaim = true
  let originalUnavailable = false
  let migrationInvoked = false
  const failUndispatched = () =>
    store.mutate(state => {
      const current = state.jobs[job.id]
      if (current?.state === 'queued' && channelIdleGrantCurrent(state, grant, event, job.id)) {
        current.state = 'failed'
        current.code = 'MODEL_PRIORITY_UNAVAILABLE'
        current.failureNotice ??= 'pending'
      }
    })
  const markUncertain = () =>
    store.mutate(state => {
      const current = state.jobs[job.id]
      if (current?.state === 'queued') {
        current.state = 'reconciliation-required'
        current.code = 'IDLE_PRIORITY_MIGRATION_UNCERTAIN'
        current.failureNotice ??= 'pending'
      }
    })
  try {
    const current = () => !signal.aborted && channelIdleGrantCurrent(store.snapshot(), grant, event, job.id)
    if (!await bounded(native.idle(source, true), signal) || !current()) return true
    if (!isDeepStrictEqual(await bounded(native.taskSelection(source), signal), grant.selection)) {
      await store.mutate(state => {
        if (isDeepStrictEqual(state.logicalContinuations?.idlePriorityGrants?.[grant.bindingId], grant)) {
          removeChannelIdlePriorityGrant(state.logicalContinuations!, grant.bindingId)
        }
      })
      return false
    }
    const guard = async () =>
      current()
      && isDeepStrictEqual(await bounded(native.taskSelection(source), signal), grant.selection)
    const original = await native.priorityEvidence(
      {
        providerId: grant.selection.providerId!,
        model: grant.selection.model!,
      },
      signal,
      guard,
    )
    if (original === 'healthy' || original === 'inconclusive') return false
    if (original !== 'unavailable' || !await guard()) return true
    originalUnavailable = true
    let selected: typeof grant.target | undefined
    for (const candidate of [grant.target, ...(grant.fallbackTargets ?? [])]) {
      if (!await guard()) return true
      try {
        await bounded(
          (async () => {
            const catalog = channelTaskCatalog(await native.modelOperation('list', {}))
            validateChannelTaskSelection(catalog, { ...grant.selection, ...candidate })
            await native.validateTaskConfiguration({ ...grant.selection, ...candidate }, source)
          })(),
          signal,
        )
      } catch {
        if (!current()) return true
        continue
      }
      const evidence = await native.priorityEvidence(candidate, signal, guard)
      if (evidence === 'cancelled' || !await guard()) return true
      if (evidence === 'healthy') {
        selected = candidate
        break
      }
    }
    if (!selected) {
      if (current()) await failUndispatched()
      return true
    }
    const operationId = channelIdlePriorityOperation(job.id)
    const revision = store.snapshot().logicalContinuations?.revision ?? 0
    claims.delete(source)
    ownsClaim = false
    migrationInvoked = true
    const result = await startChannelLogicalContinuation({
      ...input,
      native,
      appId,
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId,
        logicalConversationId: grant.logicalId,
        source: grant.source,
        expectedRevision: revision,
        target: selected,
        mode: 'linked',
        historyConsent: 'on-demand',
        historyCategories: ['user-text', 'assistant-text'],
        handoffConsent: 'none',
      },
      automatic: {
        selection: grant.selection,
        admitted: state => channelIdleGrantCurrent(state, grant, event, job.id),
        consume: state => {
          const grants = state.logicalContinuations?.idlePriorityGrants
          if (!grants || !isDeepStrictEqual(grants[grant.bindingId], grant)) return false
          removeChannelIdlePriorityGrant(state.logicalContinuations!, grant.bindingId)
          return true
        },
      },
    })
    if (
      result.state === 'unknown'
      || result.state === 'applied' && 'navigationReady' in result && result.navigationReady === false
      || result.state === 'rejected' && result.code === 'SOURCE_FENCE_UNAVAILABLE'
    ) {
      await markUncertain()
    } else if (result.state === 'rejected' && result.code !== 'SOURCE_BUSY') {
      await failUndispatched()
    }
    return true
  } catch {
    if (migrationInvoked) await markUncertain().catch(() => {})
    else if (originalUnavailable && !signal.aborted) await failUndispatched().catch(() => {})
    return true
  } finally {
    if (ownsClaim) claims.delete(source)
  }
}
