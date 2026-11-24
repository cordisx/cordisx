import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationJob, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { channelGroupPriorityCurrent } from './channel-group-priority.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'
import { channelTaskCatalog, validateChannelTaskSelection } from './channel-task-selection.js'
import { boundedChannelSelectionValidation } from './channel-model-priority-dispatch.js'

async function bounded<T>(operation: Promise<T>, timeout = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Same-provider selection uses the native idle/selection fence; no business turn is replayed. */
export async function attemptChannelGroupPriority(input: {
  store: ChannelConversationStore
  native?: ChannelNativeSessions | undefined
  claims: Set<string>
  appId?: string | undefined
  profileId: string
  event: ChannelEventRef
  job: ChannelConversationJob
  signal: AbortSignal
}): Promise<boolean> {
  const { store, native, claims, job, event, signal } = input
  if (!native || !input.appId || !job.bindingId || !job.sessionId || job.autoCreate || event.kind !== 'group') {
    return false
  }
  const source = job.sessionId, grant = store.snapshot().logicalContinuations?.idlePriorityGrants?.[job.bindingId]
  if (!grant?.groupScope || grant.source.appId !== input.appId || grant.source.profileId !== input.profileId) {
    return false
  }
  if (!channelGroupPriorityCurrent(store.snapshot(), grant, event)) return false
  if (claims.has(source)) return true
  const captured = store.snapshot(), sequence = captured.inputs[job.recordId]?.sequence
  if (
    sequence === undefined || Object.values(captured.jobs).some(other => {
      const otherSequence = captured.inputs[other.recordId]?.sequence
      return other.id !== job.id && other.sessionId === source && other.state === 'queued'
        && otherSequence !== undefined
        && (otherSequence < sequence || otherSequence === sequence && other.id < job.id)
    })
  ) return true
  claims.add(source)
  let effectReserved = false, originalUnavailable = false, effectAllowed = true
  const ready = (state: ReturnType<ChannelConversationStore['snapshot']>, target = grant.target) =>
    !signal.aborted && channelGroupPriorityCurrent(state, grant, event, target)
    && state.jobs[job.id]?.bindingId === grant.bindingId && state.jobs[job.id]?.sessionId === source
    && state.inputs[job.recordId]?.accepted === true && state.inputs[job.recordId]?.routed === true
    && isDeepStrictEqual(state.inputs[job.recordId]?.input.source.event, event)
    && !Object.values(state.jobs).some(other =>
      other.id !== job.id && other.sessionId === source
      && ['dispatching', 'running', 'replying', 'reconciliation-required'].includes(other.state)
    )
    && (!state.taskSettings[source] || state.taskSettings[source]?.application === 'applied')
  const current = (target = grant.target) => ready(store.snapshot(), target)
  const failed = () =>
    store.mutate(state => {
      const latest = state.jobs[job.id]
      if (latest?.state === 'queued' && ready(state)) {
        latest.state = 'failed'
        latest.code = 'MODEL_PRIORITY_UNAVAILABLE'
        latest.failureNotice ??= 'pending'
      }
    })
  try {
    if (!await bounded(native.idle(source, true)) || !current()) return true
    const selection = await bounded(native.taskSelection(source))
    if (!isDeepStrictEqual(selection, grant.selection)) {
      await channelLogicalTransactionStore(store).mutate(state => {
        if (isDeepStrictEqual(state.logicalContinuations?.idlePriorityGrants?.[grant.bindingId], grant)) {
          removeChannelIdlePriorityGrant(state.logicalContinuations, grant.bindingId)
        }
      })
      return false
    }
    const guard = async (target = grant.target) =>
      current(target)
      && isDeepStrictEqual(await bounded(native.taskSelection(source)), grant.selection)
    const original = await native.priorityEvidence(
      { providerId: selection.providerId!, model: selection.model! },
      signal,
      guard,
    )
    if (original === 'healthy' || original === 'inconclusive') return false
    if (original !== 'unavailable' || !await guard()) return true
    originalUnavailable = true
    let selected: typeof grant.target | undefined
    for (const candidate of [grant.target, ...(grant.fallbackTargets ?? [])]) {
      if (!await guard(candidate)) return true
      try {
        await boundedChannelSelectionValidation(async () => {
          validateChannelTaskSelection(channelTaskCatalog(await native.modelOperation('list', {})), {
            ...selection,
            ...candidate,
          })
          await native.validateTaskConfiguration({ ...selection, ...candidate }, source)
        })
      } catch {
        continue
      }
      const result = await native.priorityEvidence(candidate, signal, () => guard(candidate))
      if (result === 'cancelled' || !await guard(candidate)) return true
      if (result === 'healthy') {
        selected = candidate
        break
      }
    }
    if (!selected) {
      await failed()
      return true
    }
    const target = selected
    effectReserved = await store.mutate(state => {
      const latest = state.jobs[job.id]
      if (!latest || latest.state !== 'queued' || !ready(state, target)) {
        return false
      }
      latest.state = 'reconciliation-required'
      latest.code = 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
      return true
    })
    if (!effectReserved) return true
    const result = await bounded(
      native.applyTaskSelection(source, { ...selection, ...target }, async applied => {
        const latest = store.snapshot().jobs[job.id]
        return effectAllowed && latest?.state === 'reconciliation-required'
          && latest.code === 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
          && current(target)
          && isDeepStrictEqual(await bounded(native.taskSelection(source)), { ...selection, ...applied })
          && effectAllowed && current(target)
      }),
      15_000,
    )
    if (
      result.status !== 'selected' || result.application !== 'applied'
      || !isDeepStrictEqual(await bounded(native.taskSelection(source)), { ...selection, ...target })
      || !current(target)
    ) {
      await store.mutate(state => {
        if (state.jobs[job.id]?.state === 'reconciliation-required') state.jobs[job.id]!.failureNotice ??= 'pending'
      })
      return true
    }
    await channelLogicalTransactionStore(store).mutate(state => {
      const latest = state.jobs[job.id]
      if (
        latest?.state !== 'reconciliation-required' || latest.code !== 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
        || !ready(state, target)
      ) {
        if (latest?.state === 'reconciliation-required') latest.failureNotice ??= 'pending'
        return
      }
      const candidates = [grant.target, ...(grant.fallbackTargets ?? [])]
      const remaining = candidates.slice(candidates.findIndex(row => isDeepStrictEqual(row, target)) + 1)
      if (!remaining.length) removeChannelIdlePriorityGrant(state.logicalContinuations, grant.bindingId)
      else {state.logicalContinuations!.idlePriorityGrants![grant.bindingId] = {
          ...grant,
          selection: { ...selection, ...target },
          target: remaining[0]!,
          fallbackTargets: remaining.slice(1),
        }}
      const settings = state.taskSettings[source]
      if (settings) {
        settings.revision += 1
        settings.settings = { ...selection, ...target }
      }
      latest.state = 'queued'
      delete latest.code
    })
    return true
  } catch {
    if (effectReserved) {
      await store.mutate(state => {
        if (state.jobs[job.id]?.state === 'reconciliation-required') state.jobs[job.id]!.failureNotice ??= 'pending'
      }).catch(() => {})
    } else if (originalUnavailable && !signal.aborted) await failed().catch(() => {})
    return true
  } finally {
    effectAllowed = false
    claims.delete(source)
  }
}
